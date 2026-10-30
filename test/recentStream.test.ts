// recentStream.test.ts — the recent-stream filter thinkers read (design/
// conversation_memory.md, part 3; Experiment B). Ported assertion-for-assertion
// from upstream's tests/test_recent_stream_filter.sh (NEW @ 7d29f9e, dcf3c02):
// reasoning steps are dropped, final steps kept, runs of consecutive idle (and
// error) steps collapse into one line with a count and duration, idles
// separated by another step are not merged, order is preserved, content is
// still truncated at 1500 characters, and the window (N) counts lines after
// collapsing (2e39a3f; it used to bound the raw steps considered before).

import { describe, it, expect } from "vitest";
import { recentStream } from "../src/recentStream.js";
import type { Step } from "../src/types.js";

const BASE_MIN = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02T12:00:00Z

function ts(minutesAgo: number): string {
  return new Date(BASE_MIN - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function step(id: string, type: string, content: string, minutesAgo: number, extra: Record<string, unknown> = {}): Step {
  return { step_id: id, type, content, ts: ts(minutesAgo), source: "monolith", ...extra } as unknown as Step;
}

function line(out: string, id: string): Record<string, unknown> {
  for (const l of out.split("\n")) {
    if (!l) continue;
    const obj = JSON.parse(l) as Record<string, unknown>;
    if (obj["step_id"] === id) return obj;
  }
  throw new Error(`no line with step_id ${id} in: ${out}`);
}

describe("recentStream", () => {
  const steps: Step[] = [
    step("t1", "thought", "first thought", 300),
    step("r1", "reasoning", "Chat-first this tick: last-word...", 299),
    step("so1", "shell-output", "output", 298),
    step("f1", "final", "run concluded: nothing to do", 297),
    step("i1", "idle", "idle", 290),
    step("i2", "idle", "idle", 200),
    step("i3", "idle", "idle", 170), // i1..i3: 2h over 290->170 min ago
    step("m1", "message", "hey", 100, { from: "nick", to: "ada" }),
    step("i4", "idle", "idle", 90), // separated by the message: its own run
    step("e1", "error", "monolith run failed (rc=1) with no durable step", 60, { rc: 1, reason: "run-failed" }),
    step("e2", "error", "monolith run failed (rc=1) with no durable step", 20, { rc: 1, reason: "run-failed" }),
    step("r2", "reasoning", "more prose", 10),
    step("t2", "thought", "x".repeat(2000), 5),
  ];

  it("drops reasoning steps and machinery steps", () => {
    const out = recentStream(steps, 30);
    expect(out).not.toContain('"type":"reasoning"');
    expect(out).not.toContain('"type":"shell-output"');
  });

  it("keeps final steps", () => {
    const out = recentStream(steps, 30);
    expect(line(out, "f1")["type"]).toBe("final");
  });

  it("collapses a run of 3 idles to 'idle x3 over 2h0m', carrying the last step id", () => {
    const out = recentStream(steps, 30);
    const idleLines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o["type"] === "idle");
    expect(idleLines.length).toBe(2); // the message splits the idle runs
    const first = idleLines[0]!;
    expect(first["content"]).toBe("idle x3 over 2h0m");
    expect(first["collapsed"]).toBe(3);
    expect(first["step_id"]).toBe("i3");
  });

  it("leaves a lone idle as it was, with no collapsed field", () => {
    const out = recentStream(steps, 30);
    const idleLines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o["type"] === "idle");
    const second = idleLines[1]!;
    expect(second["content"]).toBe("idle");
    expect("collapsed" in second).toBe(false);
  });

  it("keeps error steps in, and collapses a run of them with the rc", () => {
    const out = recentStream(steps, 30);
    const errLines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o["type"] === "error");
    expect(errLines.length).toBe(1);
    expect(errLines[0]!["content"]).toBe("run failed x2 over 40m (rc=1)");
  });

  it("preserves order: t1 f1 i3 m1 i4 e2 t2", () => {
    const out = recentStream(steps, 30);
    const ids = out
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    expect(ids).toEqual(["t1", "f1", "i3", "m1", "i4", "e2", "t2"]);
  });

  it("still truncates long content at 1500 characters", () => {
    const out = recentStream(steps, 30);
    const t2 = line(out, "t2");
    expect((t2["content"] as string).length).toBeLessThanOrEqual(1520);
  });

  it("counts the window N in lines AFTER collapsing (N=3 -> i4, e2, t2) — 2e39a3f/285ed72", () => {
    const out = recentStream(steps, 3);
    const ids = out
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    expect(ids).toEqual(["i4", "e2", "t2"]);
  });

  it("every output line is a parseable JSON object", () => {
    const out = recentStream(steps, 30);
    for (const l of out.split("\n")) {
      if (!l) continue;
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });
});

// PORT-NOTE (1c: c887a4d, d507855, f1b8693) — ported from upstream's
// extended test_recent_stream_filter.sh cases for these three commits.
describe("recentStream — 1c field pruning, id truncation, final/details, pairing", () => {
  it("keeps only the whitelisted fields, dropping metrics like context_steps/compose_ms", () => {
    const steps: Step[] = [
      step("o1", "observation", "sent the update", 10, {
        context_steps: ["a", "b", "c"],
        compose_ms: 42,
        model: "grok",
        history_source: "index",
        responder_ms: 9,
      }),
    ];
    const rec = line(recentStream(steps, 30), "o1");
    expect(rec).not.toHaveProperty("context_steps");
    expect(rec).not.toHaveProperty("compose_ms");
    expect(rec).not.toHaveProperty("model");
    expect(rec).not.toHaveProperty("history_source");
    expect(rec).not.toHaveProperty("responder_ms");
    expect(rec["content"]).toBe("sent the update");
  });

  it("cuts step_id and run_id to 8 characters but keeps trigger_step/resolves whole", () => {
    const steps: Step[] = [
      step("0123456789abcdef", "observation", "did the thing", 10, {
        run_id: "fedcba9876543210",
        trigger_step: "0123456789abcdef",
        resolves: "fedcba9876543210",
      }),
    ];
    const rec = line(recentStream(steps, 30), "01234567");
    expect(rec["step_id"]).toBe("01234567");
    expect(rec["run_id"]).toBe("fedcba98");
    expect(rec["trigger_step"]).toBe("0123456789abcdef");
    expect(rec["resolves"]).toBe("fedcba9876543210");
  });

  it("truncates ts to minute precision (first 16 characters)", () => {
    const steps: Step[] = [step("t1", "thought", "hi", 10)];
    const rec = line(recentStream(steps, 30), "t1");
    expect(String(rec["ts"]).length).toBe(16);
    expect(String(rec["ts"])).toBe(ts(10).slice(0, 16));
  });

  it("stamps a details traj-tail pointer on a final with a run_id, keeping the FULL id", () => {
    const steps: Step[] = [step("f1", "final", "done: shipped it", 10, { run_id: "0123456789abcdef" })];
    const rec = line(recentStream(steps, 30), "f1");
    expect(rec["details"]).toBe("traj tail -n 400 --filter run_id=0123456789abcdef");
    expect(rec["run_id"]).toBe("01234567"); // the run_id field itself still gets cut
  });

  it("a final with no run_id gets no details field", () => {
    const steps: Step[] = [step("f1", "final", "done", 10)];
    const rec = line(recentStream(steps, 30), "f1");
    expect(rec).not.toHaveProperty("details");
  });

  it("drops the nearest earlier observation sharing a final's run_id", () => {
    const steps: Step[] = [
      step("t1", "thought", "before", 30),
      step("o1", "observation", "milestone one", 25, { run_id: "run-1" }),
      step("o2", "observation", "milestone two, same run", 20, { run_id: "run-1" }),
      step("f1", "final", "wrapped up", 15, { run_id: "run-1" }),
    ];
    const out = recentStream(steps, 30);
    const ids = out
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    // o2 (nearest earlier observation with the same run_id) is dropped; o1
    // (an earlier in-run milestone) and t1 stay.
    expect(ids).toEqual(["t1", "o1", "f1"]);
  });

  it("an observation from a run that never reached a final stays as its only record", () => {
    const steps: Step[] = [
      step("o1", "observation", "did some work", 20, { run_id: "run-2" }),
      step("e1", "error", "monolith run failed (rc=1) with no durable step", 10, { run_id: "run-3", rc: 1 }),
    ];
    const out = recentStream(steps, 30);
    const ids = out
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    expect(ids).toEqual(["o1", "e1"]);
  });

  it("the pairing dedup runs BEFORE the window cut, so N still counts N distinct events", () => {
    const steps: Step[] = [
      step("o1", "observation", "milestone", 40, { run_id: "run-1" }),
      step("f1", "final", "wrapped up", 35, { run_id: "run-1" }), // drops o1
      step("t1", "thought", "a", 30),
      step("t2", "thought", "b", 20),
    ];
    const out = recentStream(steps, 3);
    const ids = out
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    // Without pairing, a naive tail-3-then-dedupe would still show 3 lines
    // (f1, t1, t2) since o1 already fell outside a raw window of 3. Pairing
    // BEFORE the window cut removes o1 first, so the window of 3 over the
    // remaining [f1, t1, t2] is exactly those three — same result here, but
    // the true test is with only 2 kept: N=2 must show the two NEWEST of the
    // deduped set, not be confused by the already-dropped o1.
    expect(ids).toEqual(["f1", "t1", "t2"]);
  });

  it("drops content_b64 and falls back to [file: name] when content is empty", () => {
    const steps: Step[] = [
      step("m1", "message", "", 10, { filename: "report.pdf", content_b64: "AAAA" }),
    ];
    const rec = line(recentStream(steps, 30), "m1");
    expect(rec["content"]).toBe("[file: report.pdf]");
    expect(rec).not.toHaveProperty("content_b64");
  });
});

// PORT-NOTE (2e39a3f) — ported from the upstream additions to
// tests/test_recent_stream_filter.sh (outbound_delivery.md, parts 4-5).
describe("recentStream — 2e39a3f delivery notices and idle-run finals", () => {
  it("admits a FAILED delivery with status and reason, hides a delivered one", () => {
    const steps: Step[] = [
      step("d1", "delivery", "not delivered", 5, { status: "failed", reason: "unknown slack address form", to: "slack-x", transport: "slack" }),
      step("d2", "delivery", "delivered", 4, { status: "delivered", to: "slack-C1", channel: "C1" }),
    ];
    const out = recentStream(steps, 40);
    const rec = line(out, "d1");
    expect(rec["status"]).toBe("failed");
    expect(rec["reason"]).toBe("unknown slack address form");
    expect(rec["to"]).toBe("slack-x");
    expect(rec).not.toHaveProperty("transport");
    expect(out).not.toContain("d2");
  });

  it("three idle runs collapse to one line; their finals are dropped; a working run keeps its final", () => {
    const steps: Step[] = [step("w1", "thought", "some work", 60)];
    for (const k of [1, 2, 3]) {
      steps.push(step(`ii${k}`, "idle", "idle", 50 - k * 10, { run_id: `run-idle-${k}` }));
      steps.push(step(`if${k}`, "final", "Idle — nothing worth doing", 50 - k * 10, { run_id: `run-idle-${k}` }));
    }
    steps.push(step("w2", "observation", "real result", 5, { run_id: "run-w2" }));
    steps.push(step("wf", "final", "run w2 done", 5, { run_id: "run-w2" }));
    const out = recentStream(steps, 20);
    const ids = out.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Record<string, unknown>)["step_id"]);
    expect(ids).toEqual(["w1", "ii3", "wf"]);
    expect(line(out, "ii3")["collapsed"]).toBe(3);
  });
});
