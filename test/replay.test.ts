// test/replay.test.ts — pure-function coverage for parity/replay/lib.mjs:
// the replay proxy's lane classification + positional tape matching, and
// the trajectory aligner. Two small hand-made tapes/trajectories (inline
// below, not real recordings) exercise both — no subprocess, no HTTP, no
// model call, per PROOF-CAMPAIGN.md L2's "harness only" scope.

import { describe, it, expect } from "vitest";
import {
  classifyRequest,
  extractSystemText,
  requestWantsStream,
  parseTapeJsonl,
  groupTapeByLane,
  nextTapeEntry,
  CANNED_IDLE_TEXT,
  buildOpenAIJsonResponse,
  buildOpenAISseBody,
  renderReplyBody,
  parseOpenAIJsonResponse,
  parseOpenAISseResponse,
  parseUpstreamResponse,
  scrubHeaders,
  normalizeStep,
  normalizeSteps,
  alignSteps,
  summarizeAlignment,
  classifyDivergence,
  diffStepFields,
  normalizeArtifactText,
  compareNormalizedTexts,
  findEnvironmentLeaks,
  KNOWN_PROVIDER_HOSTS,
} from "../parity/replay/lib.mjs";
import { proxyUrlEnv } from "../parity/replay/harness.mjs";

// ---------------------------------------------------------------------------
// lane classification
// ---------------------------------------------------------------------------

// PORT-NOTE (1c: 37f9340) — the shellm system-prompt intro line's wording.
const MONOLITH_SYS =
  "You are running in shellm, headlong's bash agent loop: you solve tasks by generating and executing bash code.";
const RESPONDER_REPLY_SYS =
  "You are an unconscious thought process of an AI person named Ada.\n\nThe current time is 2026-09-02T00:00:00Z. You are in a live chat conversation with jo.";
const RESPONDER_NOTES_SYS = "You maintain Ada's private notes about one person they talk with,\njo. Rewrite the notes...";
const OTHER_SYS = "Summarize this corpus for retrieval.";

function payload(system: string, extra: Record<string, unknown> = {}) {
  return { model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "system", content: system }, { role: "user", content: "hi" }], ...extra };
}

describe("classifyRequest", () => {
  it("classifies monolith by the verbatim shellm system-prompt prefix", () => {
    expect(classifyRequest(payload(MONOLITH_SYS))).toBe("monolith");
  });

  it("classifies responder-reply by the live-chat-conversation marker", () => {
    expect(classifyRequest(payload(RESPONDER_REPLY_SYS))).toBe("responder-reply");
  });

  it("classifies responder-notes by the private-notes marker", () => {
    expect(classifyRequest(payload(RESPONDER_NOTES_SYS))).toBe("responder-notes");
  });

  it("buckets an unrecognized system prompt into a stable other:<hash> lane", () => {
    const lane1 = classifyRequest(payload(OTHER_SYS));
    const lane2 = classifyRequest(payload(OTHER_SYS));
    expect(lane1).toMatch(/^other:[0-9a-f]{8}$/);
    expect(lane1).toBe(lane2); // same content -> same lane, deterministic

    const laneDifferent = classifyRequest(payload("A completely different unnamed prompt kind."));
    expect(laneDifferent).not.toBe(lane1);
  });

  it("handles a payload with no messages/system gracefully", () => {
    expect(extractSystemText({})).toBe("");
    expect(classifyRequest({})).toMatch(/^other:/);
  });
});

describe("requestWantsStream", () => {
  it("is true only when stream:true is explicitly set", () => {
    expect(requestWantsStream({ stream: true })).toBe(true);
    expect(requestWantsStream({ stream: false })).toBe(false);
    expect(requestWantsStream({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tape parsing + positional matching (the proxy's core algorithm)
// ---------------------------------------------------------------------------

function makeTape() {
  const lines = [
    { lane: "monolith", seq: 0, responseText: "```bash\necho m0\n```", usage: { promptTokens: 10, completionTokens: 2 } },
    { lane: "monolith", seq: 1, responseText: "```bash\necho m1\n```" },
    { lane: "responder-reply", seq: 0, responseText: "Your favourite colour is teal." },
    { lane: "other:deadbeef", seq: 0, responseText: "persona text" },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("parseTapeJsonl / groupTapeByLane / nextTapeEntry", () => {
  it("parses JSONL and groups by lane, sorted by seq", () => {
    const entries = parseTapeJsonl(makeTape());
    expect(entries).toHaveLength(4);
    const byLane = groupTapeByLane(entries);
    expect([...byLane.keys()].sort()).toEqual(["monolith", "other:deadbeef", "responder-reply"]);
    expect(byLane.get("monolith")!.map((e: any) => e.seq)).toEqual([0, 1]);
  });

  it("skips blank lines", () => {
    expect(parseTapeJsonl("\n\n" + makeTape() + "\n\n")).toHaveLength(4);
  });

  it("serves tape entries positionally per lane, independent of a separate cursor Map per 'side'", () => {
    const byLane = groupTapeByLane(parseTapeJsonl(makeTape()));

    // Two independent cursor Maps model the two proxy instances (one per
    // side) replaying the SAME tape from position 0 — see proxy.mjs's header.
    const origCursors = new Map();
    const portCursors = new Map();

    const origFirst = nextTapeEntry(byLane, origCursors, "monolith");
    const portFirst = nextTapeEntry(byLane, portCursors, "monolith");
    expect(origFirst.hit).toBe(true);
    expect(portFirst.hit).toBe(true);
    // both sides' FIRST monolith call gets the SAME tape entry (seq 0) —
    // this is the whole point of two independent proxy instances.
    expect(origFirst.entry.seq).toBe(0);
    expect(portFirst.entry.seq).toBe(0);

    const origSecond = nextTapeEntry(byLane, origCursors, "monolith");
    expect(origSecond.entry.seq).toBe(1);

    // a lane with only one recorded entry: second request in it is a miss.
    const replyFirst = nextTapeEntry(byLane, origCursors, "responder-reply");
    expect(replyFirst.hit).toBe(true);
    const replySecond = nextTapeEntry(byLane, origCursors, "responder-reply");
    expect(replySecond.hit).toBe(false);
    expect(replySecond.laneSize).toBe(1);
  });

  it("reports a miss for a lane never seen during recording", () => {
    const byLane = groupTapeByLane(parseTapeJsonl(makeTape()));
    const r = nextTapeEntry(byLane, new Map(), "responder-notes");
    expect(r.hit).toBe(false);
    expect(r.laneSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wire-format rendering (+ round trip through the matching parsers)
// ---------------------------------------------------------------------------

describe("renderReplyBody / buildOpenAI*/ parseOpenAI*", () => {
  it("renders a non-streaming JSON body that the JSON parser recovers exactly", () => {
    const entry = { responseText: "hello world", reasoningText: "thinking...", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2, reasoningTokens: 1 } };
    const body = renderReplyBody({ stream: false }, entry);
    const parsed = parseOpenAIJsonResponse(body)!;
    expect(parsed.text).toBe("hello world");
    expect(parsed.reasoningText).toBe("thinking...");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage).toEqual({ promptTokens: 5, completionTokens: 2, reasoningTokens: 1 });
  });

  it("renders an SSE body that the SSE parser recovers exactly", () => {
    const entry = { responseText: "streamed reply", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } };
    const body = renderReplyBody({ stream: true }, entry);
    expect(body).toContain("data: [DONE]");
    const parsed = parseOpenAISseResponse(body);
    expect(parsed.text).toBe("streamed reply");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage).toEqual({ promptTokens: 3, completionTokens: 1, reasoningTokens: undefined });
  });

  it("serves the canned IDLE-class response on a miss (null entry), in whichever wire format was asked for", () => {
    const jsonBody = renderReplyBody({ stream: false }, null);
    expect(JSON.parse(jsonBody).choices[0].message.content).toBe(CANNED_IDLE_TEXT);

    const sseBody = renderReplyBody({ stream: true }, null);
    expect(parseOpenAISseResponse(sseBody).text).toBe(CANNED_IDLE_TEXT);
  });

  it("parseUpstreamResponse dispatches on isSse and never throws on garbage", () => {
    expect(parseUpstreamResponse("not json", { isSse: false })).toBeNull();
    expect(parseUpstreamResponse("data: {not json}\n\ndata: [DONE]\n", { isSse: true })!.text).toBe("");
  });

  it("buildOpenAIJsonResponse omits reasoning/usage fields when absent", () => {
    const body = buildOpenAIJsonResponse({ text: "hi" });
    expect(body.choices[0]?.message?.reasoning).toBeUndefined();
    expect(body.usage).toBeUndefined();
  });
});

describe("scrubHeaders", () => {
  it("redacts sensitive header VALUES, case-insensitively, keeps everything else", () => {
    const out = scrubHeaders({ Authorization: "Bearer sk-real-secret", "X-Api-Key": "abc", "content-type": "application/json" });
    expect(out.Authorization).toBe("<redacted>");
    expect(out["X-Api-Key"]).toBe("<redacted>");
    expect(out["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// trajectory alignment — two small hand-made trajectories
// ---------------------------------------------------------------------------

function origTrajectory() {
  return [
    { type: "shellm-run", ts: "2026-01-01T00:00:00Z", step_id: "aaa11111", source: "monolith" },
    { type: "reasoning", ts: "2026-01-01T00:00:01Z", source: "monolith", run_id: "aaa11111", content: "let me check the weather" },
    { type: "shell-output", ts: "2026-01-01T00:00:02Z", source: "monolith", run_id: "aaa11111", stdout: "sunny", exit: 0 },
    { type: "final", ts: "2026-01-01T00:00:03Z", source: "monolith", run_id: "aaa11111", content: "done" },
    { type: "message", ts: "2026-01-01T00:01:00Z", from: "sxs", to: "jo", content: "hi jo", reply_to: null },
  ];
}

/** port trajectory: same shape, different ids/ts (expected — excluded from
 * comparison), one step whose REASONING PROSE differs only (nondeterminism),
 * and is otherwise identical. */
function portTrajectoryClean() {
  return [
    { type: "shellm-run", ts: "2026-01-01T05:00:00Z", step_id: "zzz99999", source: "monolith" },
    { type: "reasoning", ts: "2026-01-01T05:00:01Z", source: "monolith", run_id: "zzz99999", content: "checking today's weather now" },
    { type: "shell-output", ts: "2026-01-01T05:00:02Z", source: "monolith", run_id: "zzz99999", stdout: "sunny", exit: 0 },
    { type: "final", ts: "2026-01-01T05:00:03Z", source: "monolith", run_id: "zzz99999", content: "done" },
    { type: "message", ts: "2026-01-01T05:01:00Z", from: "sxs", to: "jo", content: "hi jo", reply_to: null },
  ];
}

/** port trajectory missing the `final` step (a plausible PORT-BUG shape) and with a shell-output exit code that differs (a real field diff, not prose). */
function portTrajectoryDivergent() {
  return [
    { type: "shellm-run", ts: "2026-01-01T05:00:00Z", step_id: "zzz99999", source: "monolith" },
    { type: "reasoning", ts: "2026-01-01T05:00:01Z", source: "monolith", run_id: "zzz99999", content: "checking today's weather now" },
    { type: "shell-output", ts: "2026-01-01T05:00:02Z", source: "monolith", run_id: "zzz99999", stdout: "sunny", exit: 1 },
    { type: "message", ts: "2026-01-01T05:01:00Z", from: "sxs", to: "jo", content: "hi jo", reply_to: null },
  ];
}

describe("normalizeStep / normalizeSteps", () => {
  it("strips id-like fields and remaps step_id/run_id to a relative <type>#N label", () => {
    const steps = origTrajectory();
    const [norm] = normalizeSteps(steps);
    expect(norm!.ts).toBeUndefined();
    expect(norm!.step_id).toBe("shellm-run#1");

    const reasoningNorm = normalizeSteps(steps)[1];
    expect(reasoningNorm!.run_id).toBe("shellm-run#1");
    expect(reasoningNorm!.content).toBe("let me check the weather");
  });

  it("remaps trigger_step/reply_to references by per-type position, immune to a volume divergence in an UNRELATED step type", () => {
    // orig has one extra `idle` step (a monolith-noise-shaped divergence)
    // before the message — must not shift the message's own #N label, or
    // a trigger_step/reply_to pointing at "the 1st message" would resolve
    // differently on the two sides for a reason unrelated to the reference.
    const steps = [
      { type: "idle", ts: "t", source: "monolith" },
      { type: "message", ts: "t", step_id: "msg-abc", from: "jo", to: "sxs", source: "chat" },
      { type: "reply_claim", ts: "t", source: "responder", trigger_step: "msg-abc" },
    ];
    const otherSteps = [
      { type: "message", ts: "t2", step_id: "msg-xyz", from: "jo", to: "sxs", source: "chat" },
      { type: "reply_claim", ts: "t2", source: "responder", trigger_step: "msg-xyz" },
    ];
    const normSteps = normalizeSteps(steps);
    const replyClaimA = normSteps.find((s) => s.type === "reply_claim");
    const replyClaimB = normalizeSteps(otherSteps).find((s) => s.type === "reply_claim");
    expect(replyClaimA!.trigger_step).toBe("message#1");
    expect(replyClaimB!.trigger_step).toBe("message#1");
    expect(replyClaimA!.trigger_step).toBe(replyClaimB!.trigger_step);
  });
});

describe("diffStepFields", () => {
  it("flags a field present on only one side as a diff", () => {
    const a = { type: "shell-output", exit: 0 };
    const b = { type: "shell-output", exit: 0, extra: "x" };
    const diffs = diffStepFields(a, b);
    expect(diffs).toContainEqual({ field: "extra", orig: undefined, port: "x" });
  });
});

describe("alignSteps / summarizeAlignment", () => {
  it("aligns two identical-shape trajectories exactly, ids/timestamps ignored", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryClean());
    expect(alignment.every((e) => e.status === "matched")).toBe(true);
    const summary = summarizeAlignment(alignment);
    expect(summary.total).toBe(5);
    expect(summary.origOnly).toBe(0);
    expect(summary.portOnly).toBe(0);
    // the reasoning step's `content` differs (prose) -> matched-with-field-diffs
    expect(summary.matchedWithFieldDiffs).toBe(1);
    expect(summary.matchedExact).toBe(4);
    expect(summary.firstDivergenceIndex).toBe(1);
  });

  it("flags a missing `final` step and a differing `exit` field as real divergences", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryDivergent());
    const summary = summarizeAlignment(alignment);
    expect(summary.origOnly).toBeGreaterThan(0); // the orig-only `final` step
    const finalEntry = alignment.find((e) => e.status === "orig-only" && e.orig.type === "final");
    expect(finalEntry).toBeDefined();
    const shellOutputEntry = alignment.find((e) => e.status === "matched" && e.orig.type === "shell-output") as any;
    expect(shellOutputEntry.fieldDiffs).toContainEqual({ field: "exit", orig: 0, port: 1 });
  });
});

describe("classifyDivergence", () => {
  it("classifies prose-only field diffs as model nondeterminism", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryClean());
    const reasoningEntry = alignment.find((e) => e.status === "matched" && (e as any).fieldDiffs.length > 0)!;
    expect(classifyDivergence(reasoningEntry).bucket).toBe("model nondeterminism");
  });

  it("classifies a missing structural step as a PORT-BUG candidate when no doc citation is found", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryDivergent());
    const finalEntry = alignment.find((e) => e.status === "orig-only")!;
    const result = classifyDivergence(finalEntry, { docLookup: () => null });
    expect(result.bucket).toBe("PORT-BUG candidate");
  });

  it("classifies the same missing step as a documented deviation when docLookup finds a citation", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryDivergent());
    const finalEntry = alignment.find((e) => e.status === "orig-only")!;
    const result = classifyDivergence(finalEntry, { docLookup: (key: string) => (key === "missing:final" ? { file: "PARITY.md", line: 42, excerpt: "final step known gap" } : null) });
    expect(result.bucket).toBe("documented-deviation");
    expect(result.citation!.line).toBe(42);
  });

  it("classifies a non-prose field diff (exit code) as a PORT-BUG candidate absent a citation", () => {
    const alignment = alignSteps(origTrajectory(), portTrajectoryDivergent());
    const shellOutputEntry = alignment.find((e) => e.status === "matched" && e.orig.type === "shell-output")!;
    expect(classifyDivergence(shellOutputEntry, { docLookup: () => null }).bucket).toBe("PORT-BUG candidate");
  });
});

// ---------------------------------------------------------------------------
// artifact (run/ files, memories/) normalized diff
// ---------------------------------------------------------------------------

describe("normalizeArtifactText / compareNormalizedTexts", () => {
  it("scrubs timestamps, hex ids, and given absolute path prefixes symmetrically", () => {
    const a = normalizeArtifactText("2026-01-01T00:00:00Z /home/x/orig/app/run/dispatcher.log id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      scrubPaths: ["/home/x/orig/app"],
    });
    const b = normalizeArtifactText("2026-06-06T06:06:06Z /home/y/port/app/run/dispatcher.log id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
      scrubPaths: ["/home/y/port/app"],
    });
    expect(a).toBe(b);
    expect(compareNormalizedTexts(a, b).equal).toBe(true);
  });

  it("reports the first differing line when content really differs", () => {
    const cmp = compareNormalizedTexts("line1\nline2\nline3", "line1\nDIFFERENT\nline3");
    expect(cmp.equal).toBe(false);
    expect(cmp.lineNumber).toBe(2);
    expect(cmp.orig).toBe("line2");
    expect(cmp.port).toBe("DIFFERENT");
  });
});


// ---------------------------------------------------------------------------
// proxyUrlEnv — bug #39 fallout: setting LLM_API_URL alone is not enough
// (bin/shellm unsets it and only re-exports from SHELLM_API_URL), so the
// harness must set BOTH on both sides.
// ---------------------------------------------------------------------------

describe("proxyUrlEnv", () => {
  it("sets both LLM_API_URL and SHELLM_API_URL to the same proxy URL", () => {
    const env = proxyUrlEnv("http://127.0.0.1:12345/v1/chat/completions");
    expect(env.LLM_API_URL).toBe("http://127.0.0.1:12345/v1/chat/completions");
    expect(env.SHELLM_API_URL).toBe("http://127.0.0.1:12345/v1/chat/completions");
    expect(Object.keys(env).sort()).toEqual(["LLM_API_URL", "SHELLM_API_URL"]);
  });
});

// ---------------------------------------------------------------------------
// findEnvironmentLeaks — a side's llm/shellm call silently bypassing the
// proxy and hitting a real provider directly (exactly how "monolith: 0
// wakes" hid in this harness's own first real run: bin/shellm unset
// LLM_API_URL, the call fell through to the real openrouter.ai default
// with a fake key, and died with an auth error that nothing was watching
// for).
// ---------------------------------------------------------------------------

describe("findEnvironmentLeaks", () => {
  it("flags a real auth-error line", () => {
    const log = 'llm: error: curl: (22) The requested URL returned error: 401\nOPENROUTER_API_KEY did not get a reply from deepseek/deepseek-v4-flash-0731.\n';
    const leaks = findEnvironmentLeaks(log);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.some((l) => l.reason === "auth-error")).toBe(true);
  });

  it("flags the exact upstream 'Missing Authentication header' failure mode", () => {
    const log = '{"error":{"message":"Missing Authentication header"}}\n';
    const leaks = findEnvironmentLeaks(log);
    expect(leaks).toContainEqual(expect.objectContaining({ reason: "auth-error" }));
  });

  it("flags any known real-provider host appearing in the log (a proxied run should only ever mention the local proxy)", () => {
    for (const host of KNOWN_PROVIDER_HOSTS) {
      const log = `llm: warning: LLM_API_URL overrides the default openrouter endpoint (requests go to ${host})\n`;
      const leaks = findEnvironmentLeaks(log);
      expect(leaks.some((l) => l.reason === "non-proxy-host" && l.host === host)).toBe(true);
    }
  });

  it("is clean on a normal proxied run's log (only the local proxy host, no auth errors)", () => {
    const log =
      'llm: warning: LLM_API_URL overrides the default openrouter endpoint (requests go to 127.0.0.1:54321)\n' +
      '  routing (reactive/message / thinking)...\n' +
      '  run FINAL (rc=0)\n';
    expect(findEnvironmentLeaks(log)).toEqual([]);
  });

  it("handles empty/undefined input without throwing", () => {
    expect(findEnvironmentLeaks("")).toEqual([]);
    expect(findEnvironmentLeaks(undefined)).toEqual([]);
  });
});
