// responder.test.ts — direct tests for the responder's prompt-assembly pure
// functions. Upstream sync 1b (design/conversation_memory.md) replaced the
// old raw-step buildConvo/recentInnerLife pipeline (a plain last-12-turns
// window over the full step array) with the index-backed + thread-union
// pipeline (buildConvoSel) and the recent-stream-sourced inner life
// (innerLifeFromContext) — this file now pins THOSE, plus the age-stamp
// formatter (formatAge), the window-fallback message extraction
// (messagesFromContext), and the gap_s computation (computeGapSeconds).

import { describe, it, expect } from "vitest";
import {
  buildConvoSel,
  formatAge,
  innerLifeFromContext,
  messagesFromContext,
  computeGapSeconds,
} from "../src/responder.js";
import type { IndexedMessage } from "../src/messageIndex.js";
import type { Step } from "../src/types.js";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();

function m(step_id: string, from: string, to: string, content: string, secsAgo: number): IndexedMessage {
  return { step_id, from, to, content, ts: ago(secsAgo) };
}

describe("formatAge", () => {
  it("just now under 90s", () => {
    expect(formatAge(ago(30), NOW)).toBe("just now");
  });
  it("minutes under 90 minutes (5400s)", () => {
    expect(formatAge(ago(600), NOW)).toBe("10 min ago");
  });
  it("hours under 48h (172800s)", () => {
    expect(formatAge(ago(3 * 3600), NOW)).toBe("3 h ago");
  });
  it("days at/after 48h", () => {
    expect(formatAge(ago(6 * 86400), NOW)).toBe("6 days ago");
  });
  it("an unparseable timestamp falls back to age 0 ('just now')", () => {
    expect(formatAge("not-a-date", NOW)).toBe("just now");
  });
});

describe("buildConvoSel", () => {
  it("maps them->me to a user turn stamped with age, me->them to assistant, in time order", () => {
    const person = [m("p1", "andy", "pax", "hi", 600), m("p2", "pax", "andy", "hello", 590)];
    const convo = buildConvoSel(person, [], { me: "pax", triggerContent: "how are you", triggerStepId: "t1", nowMs: NOW });
    expect(convo[0]).toEqual({ role: "user", content: "[10 min ago] hi", step_id: "p1", threadOnly: false });
    expect(convo[1]).toEqual({ role: "assistant", content: "hello", step_id: "p2", threadOnly: false });
    expect(convo[2]).toEqual({ role: "user", content: "how are you", step_id: "t1", threadOnly: false });
  });

  it("excludes the trigger from history then appends it exactly once as the final user turn", () => {
    const person = [m("t1", "andy", "pax", "the trigger, already indexed", 5)];
    const convo = buildConvoSel(person, [], { me: "pax", triggerContent: "the trigger, already indexed", triggerStepId: "t1", nowMs: NOW });
    expect(convo).toHaveLength(1);
    expect(convo[0]!.content).toBe("the trigger, already indexed");
  });

  it("drops a leading assistant turn so the convo starts with a user turn", () => {
    const person = [m("p1", "pax", "andy", "unprompted note", 600)];
    const convo = buildConvoSel(person, [], { me: "pax", triggerContent: "their message", triggerStepId: "t1", nowMs: NOW });
    expect(convo[0]!.role).toBe("user");
    expect(convo).toHaveLength(1);
    expect(convo[0]!.content).toBe("their message");
  });

  it("de-duplicates the person/thread union by step id, sorted by time", () => {
    const person = [m("p1", "andy", "pax", "from person history", 600)];
    const thread = [m("p1", "andy", "pax", "same step, from thread history", 600), m("b1", "braden", "pax", "braden in thread", 300)];
    const convo = buildConvoSel(person, thread, { me: "pax", triggerContent: "trig", triggerStepId: "t1", nowMs: NOW });
    const ids = convo.map((c) => c.step_id);
    expect(ids).toEqual(["p1", "b1", "t1"]);
  });

  it("marks a thread-only turn (present only via the thread union) with threadOnly:true", () => {
    const person = [m("p1", "braden", "pax", "braden's own history", 600)];
    const thread = [m("a1", "andy", "pax", "andy, only via the thread", 590), m("p1", "braden", "pax", "braden's own history", 600)];
    const convo = buildConvoSel(person, thread, { me: "pax", triggerContent: "trig", triggerStepId: "t1", nowMs: NOW });
    const andy = convo.find((c) => c.step_id === "a1")!;
    const braden = convo.find((c) => c.step_id === "p1")!;
    expect(andy.threadOnly).toBe(true);
    expect(braden.threadOnly).toBe(false);
  });

  it("maps purely by direction relative to me — filtering by sender is the caller's job (queryHistory/messagesFromContext)", () => {
    // buildConvoSel itself doesn't know who "them" is; it just assigns
    // user/assistant by whether `to`/`from` is `me`. A message neither to
    // nor from `me` is silently dropped (matches the upstream jq's implicit
    // `else empty`).
    const person = [m("p1", "someoneelse", "notme", "irrelevant to both", 600)];
    const convo = buildConvoSel(person, [], { me: "pax", triggerContent: "for me", triggerStepId: "t1", nowMs: NOW });
    expect(convo).toEqual([{ role: "user", content: "for me", step_id: "t1", threadOnly: false }]);
  });
});

describe("messagesFromContext (window fallback)", () => {
  it("extracts message-type lines between me and them from the recent-stream text", () => {
    const context = [
      JSON.stringify({ type: "thought", content: "musing" }),
      JSON.stringify({ type: "message", from: "andy", to: "pax", content: "hi", step_id: "m1", ts: ago(60) }),
      JSON.stringify({ type: "message", from: "someoneelse", to: "pax", content: "not them", step_id: "m2" }),
    ].join("\n");
    const out = messagesFromContext(context, "pax", "andy");
    expect(out).toHaveLength(1);
    expect(out[0]!.step_id).toBe("m1");
  });
});

describe("innerLifeFromContext", () => {
  it("renders the last 8 non-message lines as '[type] content'", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ type: "thought", content: `t${i}`, step_id: `s${i}` }));
    lines.splice(5, 0, JSON.stringify({ type: "message", from: "a", to: "b", content: "chat msg" }));
    const { text, stepIds } = innerLifeFromContext(lines.join("\n"));
    const out = text.split("\n");
    expect(out).toHaveLength(8);
    expect(text).not.toContain("chat msg");
    expect(out[out.length - 1]).toBe("[thought] t9");
    expect(out[0]).toBe("[thought] t2");
    expect(stepIds).toEqual(["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("keeps only lines the recent-stream projection already kept (message excluded)", () => {
    const context = [
      JSON.stringify({ type: "observation", content: "obs" }),
      JSON.stringify({ type: "message", from: "a", to: "b", content: "chat" }),
      JSON.stringify({ type: "final", content: "wrap" }),
    ].join("\n");
    expect(innerLifeFromContext(context).text).toBe("[observation] obs\n[final] wrap");
  });
});

describe("computeGapSeconds", () => {
  const msg = (id: string, from: string, to: string, secsAgo: number, extra: Record<string, unknown> = {}): Step =>
    ({ step_id: id, type: "message", from, to, content: "x", ts: ago(secsAgo), ...extra } as unknown as Step);

  it("is the time since the previous message with this person", () => {
    const steps = [msg("m-old", "andy", "pax", 3600), msg("r-old", "pax", "andy", 3500)];
    const gap = computeGapSeconds(steps, "pax", "andy", "trig", ago(0));
    expect(gap).toBeCloseTo(0 + 3500, 0);
  });

  it("is undefined on first contact (no earlier exchange)", () => {
    const steps: Step[] = [];
    expect(computeGapSeconds(steps, "pax", "stranger", "trig", ago(0))).toBeUndefined();
  });

  it("excludes the trigger itself and any reply already stamped to it", () => {
    const steps = [
      msg("m-old", "andy", "pax", 3600),
      msg("trig", "andy", "pax", 0),
      msg("reply-1", "pax", "andy", 0, { reply_to: "trig" }),
    ];
    const gap = computeGapSeconds(steps, "pax", "andy", "trig", ago(0));
    expect(gap).toBeCloseTo(3600, 0);
  });
});
