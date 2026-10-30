// responder-sync.test.ts — the 2e39a3f responder (thinkers/responder/step):
// stale-trigger guard, bounded reply call, structured reply (schema, salvage,
// text fallback), the DEFER/skills-tag/glued-DEFER handling, the raw-object and
// tool-markup guards, and card redaction of everything the step itself writes.
// Ported from tests/test_responder_card_redaction.sh, test_responder_deferral.sh
// and test_responder_reply_guard.sh. The whole step is also run against the real
// Bash in parity/responder/run-parity.mjs.
//
// Two kinds of test, no model stand-in in either:
// - interpretReply (src/responder.ts): what the step makes of a reply STRING. Plain function tests on those strings.
// - runResponder end to end: recorded real DeepSeek replies (test/fixtures/recordings/responder-sync/) through the
//   production `llm` client; the call options are read off the HTTP request body. Timeouts, provider errors and an
//   empty body are HTTP fixtures (transport, not model output).

import { describe, it, expect } from "vitest";
import { recordedModel, type RecordedModel } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrajectory, type Trajectory } from "../src/trajectory.js";
import { runResponder, supportsSchema, interpretReply, personNotesBody, REPLY_SCHEMA_FILE, type ResponderTrigger } from "../src/responder.js";

const ME = "testid";
const THEM = "andy";
const STRUCT = "deepseek/deepseek-v4-flash-0731";

const obj = (action: string, message: string, request = ""): string => JSON.stringify({ action, message, request });

function setup(content = "can you confirm Saturday at 6?", ageS = 2, from = THEM): { traj: Trajectory; trig: ResponderTrigger; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resp-sync-"));
  const traj = createTrajectory(path.join(root, "trajectories"));
  const trig = { step_id: "trig-1", type: "message", from, to: ME, content, ts: new Date(Date.now() - ageS * 1000).toISOString(), source: "chat" } as ResponderTrigger;
  fs.appendFileSync(traj.trajFile, JSON.stringify(trig) + "\n");
  return { traj, trig, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

type Fx = NonNullable<Parameters<typeof recordedModel>[2]>["httpFixtures"];
const SLOW: Fx = { 0: { status: 200, content_type: "text/event-stream", body: "data: [DONE]\n\n", delayMs: 4000 } };
const HTTP500: Fx = { 0: { status: 500, content_type: "application/json", body: '{"error":{"message":"upstream error"}}' } };
// A 200 stream that carries no content at all (llm: "empty response").
const EMPTY: Fx = { 0: { status: 200, content_type: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":""}}]}\n\ndata: [DONE]\n\n' } };

async function run(
  scenario: string,
  o: { model?: string; env?: Record<string, string>; content?: string; ageS?: number; from?: string; fixtures?: Fx } = {}
): Promise<{ m: RecordedModel; body: Record<string, unknown> | undefined; steps: Record<string, unknown>[]; sent: string[]; stderr: string; result: Awaited<ReturnType<typeof runResponder>> }> {
  const { traj, trig, cleanup } = setup(o.content, o.ageS, o.from);
  const m = recordedModel("responder-sync", scenario, { mode: "plain", ...(o.fixtures ? { httpFixtures: o.fixtures } : {}) });
  try {
    let stderr = "";
    const result = await runResponder({
      trajectory: traj,
      llm: m,
      identityName: ME,
      identityText: "",
      skillsText: "",
      model: o.model ?? "claude-opus-4-7",
      trigger: trig,
      personNotes: false,
      env: o.env ?? {},
      io: { stderr: (s) => (stderr += s), stdout: () => {} },
    });
    if (!o.fixtures) m.verify();
    const steps = traj.read().slice(2) as unknown as Record<string, unknown>[]; // header + trigger
    const sent = steps.filter((s) => s["type"] === "message" && s["from"] === ME).map((s) => String(s["content"]));
    return { m, body: m.requests[0], steps, sent, stderr, result };
  } finally {
    m.close();
    cleanup();
  }
}
const sysOf = (body: Record<string, unknown> | undefined): string => String(((body?.["messages"] as { role: string; content: string }[]) ?? [])[0]?.content ?? "");
const T = 60_000; // record mode makes real calls; replay is instant
const obs = (steps: Record<string, unknown>[]): Record<string, unknown> => steps.filter((s) => s["type"] === "observation").at(-1)!;

const TEXT = { structured: false, triggerContent: "can you confirm Saturday at 6?", msgFrom: THEM };
const SCHEMA = { ...TEXT, structured: true };
function interp(reply: string, o = TEXT) {
  let notes = "";
  const r = interpretReply(reply, o, (l) => (notes += l));
  return { r, notes, sent: r.kind === "send" ? r.text : undefined, request: r.kind === "send" ? r.deferredRequest : undefined };
}

describe("supportsSchema (_supports_schema)", () => {
  it("globs the provider families that enforce a schema", () => {
    for (const m of ["deepseek/deepseek-v4", "x-ai/grok", "z-ai/glm-5.1", "moonshotai/kimi", "qwen/q", "meta-llama/l", "mistralai/m", "google/gemini-3", "openai/gpt-5", "gpt-4o-mini", "gpt-5", "o3-mini", "o4"]) {
      expect(supportsSchema(m), m).toBe(true);
    }
    for (const m of ["claude-opus-4-7", "anthropic/claude", "z-ai/glm-4", "google/gemma", "nvidia/nemotron"]) expect(supportsSchema(m), m).toBe(false);
  });
  it("the schema asset ships beside the step and names the three actions", () => {
    const s = JSON.parse(fs.readFileSync(REPLY_SCHEMA_FILE, "utf8")) as { properties: { action: { enum: string[] } }; required: string[] };
    expect(s.properties.action.enum).toEqual(["reply", "defer", "no_reply"]);
    expect(s.required).toEqual(["action", "message", "request"]);
  });
});

describe("stale-trigger guard (RESPONDER_MAX_TRIGGER_AGE)", () => {
  it("a trigger older than 900s is replayed history: no claim, no observation, no llm call", async () => {
    const r = await run("transport-stale", { ageS: 7200, fixtures: {} });
    expect(r.result.outcome).toBe("stale-trigger");
    expect(r.steps).toEqual([]);
    expect(r.m.requests).toHaveLength(0);
    expect(r.stderr).toMatch(/stale trigger: message trig-1 from andy is 7\d{3}s old \(RESPONDER_MAX_TRIGGER_AGE=900\)/);
  });
  it("0 disables; a custom age applies; a non-numeric value fails open", async () => {
    const off = await run("stale-age-disabled", { ageS: 7200, env: { RESPONDER_MAX_TRIGGER_AGE: "0" } });
    expect(off.m.requests).toHaveLength(1);
    expect(off.sent).toHaveLength(1); // the recorded answer (a DEFER line plus a holding sentence) was acted on
    const custom = await run("transport-stale-custom", { ageS: 120, env: { RESPONDER_MAX_TRIGGER_AGE: "60" }, fixtures: {} });
    expect(custom.result.outcome).toBe("stale-trigger");
    expect(custom.m.requests).toHaveLength(0);
    const open = await run("stale-age-fails-open", { ageS: 7200, env: { RESPONDER_MAX_TRIGGER_AGE: "soon" } });
    expect(open.m.requests).toHaveLength(1);
    expect(open.sent).toHaveLength(1);
  }, T);
});

describe("the reply call is bounded on its own", () => {
  it("max tokens 8192 by default, RESPONDER_MAX_TOKENS when set (read off the request body)", async () => {
    const a = await run("bounds-default");
    expect(a.body!["max_tokens"]).toBe(8192);
    expect(a.body!["response_format"]).toBeUndefined();
    const b = await run("bounds-env", { env: { RESPONDER_MAX_TOKENS: "4096", RESPONDER_MAX_TIME: "30" } });
    expect(b.body!["max_tokens"]).toBe(4096);
  }, T);
  it("retries 0: one provider error is final — exactly one request, nothing sent", async () => {
    const r = await run("transport-500", { fixtures: HTTP500 });
    expect(r.m.requests).toHaveLength(1);
    expect(r.sent).toEqual([]);
    expect(obs(r.steps)).toMatchObject({ decision: "reply-failed", llm_calls: 1 });
    // _reply_llm `cat "$err" >&2`: the llm call's own error line reaches the step's stderr (parity responder step layer).
    expect(r.stderr).toMatch(/^llm: error: API error.*upstream error/m);
  });
  it("a timeout (RESPONDER_MAX_TIME): nothing sent, a reply-failed observation says so, failure=timeout, timed_out", async () => {
    const r = await run("transport-slow", { env: { RESPONDER_MAX_TIME: "1" }, fixtures: SLOW });
    expect(r.sent).toEqual([]);
    expect(obs(r.steps)).toMatchObject({ decision: "reply-failed", failure: "timeout", timed_out: true, llm_calls: 1, parse: "text" });
    expect(String(obs(r.steps)["content"])).toContain("took longer than 1s");
  }, 15_000);
  it("the token cap with nothing visible: failure=truncated", async () => {
    // A real answer whose whole budget went to reasoning before any visible text.
    const r = await run("truncated-nothing-visible", { env: { RESPONDER_MAX_TOKENS: "8" } });
    expect(obs(r.steps)).toMatchObject({ decision: "reply-failed", failure: "truncated", truncated: true });
    expect(String(obs(r.steps)["content"])).toContain("whole 8 token budget");
  }, T);
  it("usage facts land on the observation (out_tok, think_tok from the provider's usage); keys in upstream order", async () => {
    const r = await run("usage-facts");
    const usage = r.m.recording.calls[0]!.usage as { completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
    const o = obs(r.steps);
    expect(o).toMatchObject({ out_tok: usage.completion_tokens, llm_calls: 1, structured: false, parse: "text", decision: "replied" });
    if (usage.completion_tokens_details?.reasoning_tokens) expect(o["think_tok"]).toBe(usage.completion_tokens_details.reasoning_tokens);
    const keys = Object.keys(o);
    expect(keys.indexOf("llm_ms")).toBeLessThan(keys.indexOf("out_tok"));
    expect(keys.indexOf("out_tok")).toBeLessThan(keys.indexOf("compose_ms"));
    expect(keys.indexOf("parse")).toBeLessThan(keys.indexOf("structured"));
  }, T);
  it("a plain empty reply is failure=empty", async () => {
    expect(obs((await run("transport-empty", { fixtures: EMPTY })).steps)).toMatchObject({ decision: "reply-failed", failure: "empty" });
  });
});

describe("structured reply", () => {
  it("RESPONDER_STRUCTURED=auto uses the schema on a schema-enforcing model, with the structured prompt", async () => {
    const r = await run("structured-auto", { model: STRUCT });
    expect(r.body!["response_format"]).toMatchObject({ type: "json_schema" });
    expect(sysOf(r.body)).toContain("Output ONLY one JSON object and nothing else");
    expect(sysOf(r.body)).toContain('answer with action "defer"');
    // Recorded 2026-10-29: DeepSeek's chat/completions refuses `json_schema` ("This response_format type is unavailable
    // now", HTTP 400), so the real exchange is the schema call, the refusal, and the plain-text fallback.
    expect(r.m.recording.calls[0]!.response.status).toBe(400);
    expect(r.m.requests[1]!["response_format"]).toBeUndefined();
    expect(obs(r.steps)).toMatchObject({ structured: false, fallback: true, llm_calls: 2 });
  }, T);
  it("a text-protocol model never gets the schema; =1 forces it; =0 turns it off", async () => {
    expect((await run("bounds-default")).body!["response_format"]).toBeUndefined();
    expect((await run("structured-forced", { env: { RESPONDER_STRUCTURED: "1" } })).body!["response_format"]).toMatchObject({ type: "json_schema" });
    const off = await run("structured-off", { model: STRUCT, env: { RESPONDER_STRUCTURED: "0" } });
    expect(off.body!["response_format"]).toBeUndefined();
    expect(sysOf(off.body)).toContain("DEFER: <the work, one line>");
  }, T);
  it("a schema call that fails fast is retried once as plain text, with fallback:true and the text prompt", async () => {
    const fx: Fx = { 0: { status: 400, content_type: "application/json", body: '{"error":{"message":"response_format json_schema is not supported"}}' } };
    // call 1: an HTTP 400 fixture; call 2: a recorded real plain-text answer
    const r = await run("structured-fallback", { model: STRUCT, fixtures: fx });
    r.m.verify();
    expect(r.m.requests).toHaveLength(2);
    expect(r.m.requests[0]!["response_format"]).toBeDefined();
    expect(r.m.requests[1]!["response_format"]).toBeUndefined();
    expect(sysOf(r.m.requests[1])).toContain("DEFER: <the work, one line>");
    expect(r.sent).toHaveLength(1);
    expect(obs(r.steps)).toMatchObject({ structured: false, parse: "text", fallback: true, llm_calls: 2 });
  }, T);
  it("a timeout or token cap on the schema call is not retried", async () => {
    const t = await run("transport-slow-schema", { model: STRUCT, env: { RESPONDER_MAX_TIME: "1" }, fixtures: SLOW });
    expect(t.m.requests).toHaveLength(1);
    expect(obs(t.steps)).toMatchObject({ failure: "timeout" });
    expect(t.stderr).toContain("structured reply call spent its budget (timed out: 1, truncated: 0) — not retrying");
    // Transport fixture: a stream that ends at the token cap with no content (DeepSeek refuses the schema before it
    // could ever run out, so this shape cannot be recorded from it).
    const CAPPED: Fx = { 0: { status: 200, content_type: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n' } };
    const k = await run("transport-capped-schema", { model: STRUCT, fixtures: CAPPED });
    expect(k.m.requests).toHaveLength(1);
    expect(obs(k.steps)).toMatchObject({ failure: "truncated" });
  }, T);
});

describe("interpretReply: structured objects", () => {
  it("reply / no_reply / defer (request newlines flattened) / fenced object / unknown action = message", () => {
    expect(interp(obj("reply", "Sounds good."), SCHEMA).sent).toBe("Sounds good.");
    expect(interp(obj("no_reply", ""), SCHEMA).r.kind).toBe("no-reply");
    const d = interp(obj("DEFER", "Let me check.", "look up the repo\nstatus"), SCHEMA);
    expect(d.sent).toBe("Let me check.");
    expect(d.request).toBe("look up the repo status");
    expect(interp("```json\n" + obj("reply", "Fenced.") + "\n```", SCHEMA).sent).toBe("Fenced.");
    expect(interp(obj("hmm", "Plain message."), SCHEMA).sent).toBe("Plain message.");
  });
  it("plain text under the schema is treated as text (parse=text) and still gets the DEFER parser", () => {
    const r = interp("DEFER: dig in\nOn it.", SCHEMA);
    expect(r.sent).toBe("On it.");
    expect(r.request).toBe("dig in");
    expect(r.r.parse).toBe("text");
    expect(r.notes).toContain("structured reply did not parse as an object — treating it as text");
  });
  it("a cut-off object is repaired when the cut is outside a string; inside a string only for no_reply", () => {
    const ok = interp('{"action":"reply","message":"All good.","request":""\n   \n   ', SCHEMA);
    expect(ok.sent).toBe("All good.");
    expect(ok.r.parse).toBe("salvaged");
    expect(ok.notes).toContain("structured reply was cut off — repaired the object");
    const nr = interp('{"action":"no_reply","message":"","request":"', SCHEMA);
    expect(nr.r).toMatchObject({ kind: "no-reply", parse: "salvaged" });
    const cut = interp('{"action":"reply","message":"All go', SCHEMA);
    expect(cut.r).toMatchObject({ kind: "fail", failure: "parse", broken: true });
  });
});

describe("interpretReply: DEFER handling (test_responder_deferral.sh)", () => {
  it("a leading blank line does not leak the DEFER line to the person", () => {
    const r = interp("\n\nDEFER: do it\nOn it.");
    expect(r.sent).toBe("On it.");
    expect(r.request).toBe("do it");
  });
  it("DEFER after the holding text; DEFER glued in front of prose; the duplicate un-glues to one request", () => {
    const a = interp("Let me look.\nDEFER: check the repo status");
    expect([a.sent, a.request]).toEqual(["Let me look.", "check the repo status"]);
    const g = interp("Looking into your wake prompt.DEFER: Investigate the wake prompt");
    expect([g.sent, g.request]).toEqual(["Looking into your wake prompt.", "Investigate the wake prompt"]);
    const d = interp("DEFER: open the PR on headlong mainLet me open that PR for you.\nDEFER: open the PR on headlong main\nLet me open that PR for you.");
    expect([d.sent, d.request]).toEqual(["Let me open that PR for you.", "open the PR on headlong main"]);
  });
  it("a bare DEFER sends the default holding sentence; DEFER: after a space (prose about the protocol) is not a deferral", () => {
    const bare = interp("DEFER:\n");
    expect(bare.sent).toBe("Let me look into that and get back to you.");
    // Still a deferral with an empty request: upstream writes the pending-request action (parity step/text-defer-bare).
    expect(bare.r.kind === "send" && bare.r.deferred).toBe(true);
    expect(bare.request).toBe("");
    const p = interp("I use the raw DEFER: handoff text for that.");
    expect([p.sent, p.request]).toEqual(["I use the raw DEFER: handoff text for that.", ""]);
    expect(p.r.kind === "send" && p.r.deferred).toBe(false);
  });
  it("a standalone <skills show ...> tag hands the original request to the mind and sends the holding sentence", () => {
    const r = interp("<skills show web>", { ...TEXT, triggerContent: "please look it\nup" });
    expect([r.sent, r.request]).toEqual(["Let me look into that and get back to you.", "please look it up"]);
    expect(r.notes).toContain("model returned a skills command tag — deferring to the mind");
    const prose = interp("Run <skills show web> yourself.");
    expect([prose.sent, prose.request]).toEqual(["Run <skills show web> yourself.", ""]);
  });
});

describe("interpretReply: reply guards (test_responder_reply_guard.sh)", () => {
  it("a raw action object is never sent", () => {
    expect(interp('{"action":"reply","message":"hi","request":""}').r).toMatchObject({ kind: "fail", failure: "parse", broken: false });
  });
  it("tool-call markup is never sent", () => {
    expect(interp("<function=skills>\n<parameter=a>b</parameter>").r).toMatchObject({ kind: "fail", failure: "markup" });
  });
  it("a leaked `chat reply <name>` prefix is stripped from the first line", () => {
    expect(interp("chat reply andy Hello there").sent).toBe("Hello there");
  });
  it("a whitespace-only reply leaves nothing to send", () => {
    expect(interp("   \n  \n").sent).toBe("");
  });
  it("NO_REPLY declines", () => {
    expect(interp("NO_REPLY").r.kind).toBe("no-reply");
  });
});

describe("card redaction of everything the step writes (test_responder_card_redaction.sh)", () => {
  const CARD = "4242 4242 4242 4242";
  it("the sent reply carries no card digits but keeps its text", () => {
    expect(interp(`Got it, booking with ${CARD} now.`).sent).toBe("Got it, booking with [card redacted] now.");
  });
  it("end to end: nothing the step writes carries the card digits (a real reply to a message holding a card)", async () => {
    const r = await run("card-in-message", { content: `use ${CARD} exp 12/28 cvv 411 for Bestia, and tell me the last four digits back` });
    expect(r.sent).toHaveLength(1);
    expect(JSON.stringify(r.steps)).not.toContain("4242 4242");
  }, T);
  it("the deferral request is redacted; the work stays readable", () => {
    const r = interp("DEFER: book Bestia with card 4111-1111-1111-1111 exp 04/27 cvv 777 for Nov 7\nLet me get that booked.");
    expect(r.request).toBe("book Bestia with card [card redacted] exp [redacted] cvv [redacted] for Nov 7");
    expect(r.sent).toBe("Let me get that booked.");
  });
  it("failure exits quote the redacted excerpt too", async () => {
    const r = await run("transport-slow-card", { content: `card ${CARD}`, env: { RESPONDER_MAX_TIME: "1" }, fixtures: SLOW });
    expect(String(obs(r.steps)["content"])).not.toContain("4242");
    expect(String(obs(r.steps)["content"])).toContain("[card redacted]");
  }, 15_000);
  it("dates, times, party size, confirmation numbers and zips pass through", () => {
    const text = "Booked Bestia Nov 7 2026 6pm party of 2 conf 2110728612 zip 94110, reply 2110728612.";
    expect(interp(text).sent).toBe(text);
  });
});

describe("person notes carry no credentials or card digits (_redact_keys | _redact_card)", () => {
  // The redaction is a pure step on the notes text (personNotesBody), tested on literal strings with no model. The
  // recorded run checks the wiring with real replies. DeepSeek will not write such values into notes: asked to keep a
  // card/token/key, or the same values as a "locker code"/"referral code"/"nickname", it declined both times (recorded
  // 2026-10-29), so the recording shows the real model keeping them out and the file matching its notes.
  const TOKEN = "ghp_" + "A".repeat(24);
  const MSG =
    `Please note for later: I prefer short replies and our next call is Tuesday. My gym locker code is 4111 1111 1111 1111, ` +
    `my referral code is ${TOKEN}, and my nickname is env-held-secret-xxxx. Keep those three exactly as written in your notes about me.`;
  it("recorded: the real notes reply is written through personNotesBody and the file carries none of the values", async () => {
    const { traj, trig, cleanup } = setup(MSG);
    const memDir = path.join(path.dirname(traj.trajFile), "..", "..", "memories");
    const m = recordedModel("responder-sync", "person-notes-secrets", { mode: "plain" });
    try {
      await runResponder({
        trajectory: traj, llm: m, identityName: ME, identityText: "", skillsText: "", model: "claude-opus-4-7",
        trigger: trig, memDir, personNotes: true, personNotesSync: true,
        env: { OPENROUTER_API_KEY: "env-held-secret-xxxx" },
        io: { stderr: () => {}, stdout: () => {} },
      });
      m.verify();
      expect(m.requests).toHaveLength(2);
      expect(sysOf(m.requests[1])).toContain("private notes");
      const raw = m.responses[1]!.text;
      expect(raw).not.toMatch(/4111|ghp_|env-held-secret/); // the real model kept them out itself
      const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      expect(files).toHaveLength(1);
      const body = fs.readFileSync(path.join(memDir, files[0]!), "utf8");
      expect(body).toMatch(/Tuesday/);
      expect(body).toContain(personNotesBody(raw, { OPENROUTER_API_KEY: "env-held-secret-xxxx" }));
      expect(body).not.toMatch(/4111|ghp_|env-held-secret/);
    } finally {
      m.close();
      cleanup();
    }
  }, T);
});

describe("personNotesBody (the notes text before it is written; literal strings, no model)", () => {
  it("masks a pasted token, a configured env value, a private key and a card; keeps the rest", () => {
    const notes = [
      "Andy prefers short replies.",
      `Paid with 4111 1111 1111 1111 cvv 411. token ghp_${"A".repeat(24)} env env-held-secret-xxxx`,
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQ",
      "-----END PRIVATE KEY-----",
      "Next call Tuesday.",
    ].join("\n");
    const body = personNotesBody(`\n\n${notes}\n\n`, { OPENROUTER_API_KEY: "env-held-secret-xxxx" });
    expect(body.startsWith("Andy prefers short replies.")).toBe(true);
    expect(body.endsWith("Next call Tuesday.")).toBe(true);
    expect(body).not.toMatch(/4111|cvv 411|ghp_|env-held-secret|BEGIN PRIVATE|MIIEvQ/);
    expect(body).toContain("[card redacted]");
  });
  it("keeps the first 20 lines only", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    expect(personNotesBody(lines.join("\n"), {}).split("\n")).toEqual(lines.slice(0, 20));
  });
});
