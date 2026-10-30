// test/live-scenario.test.ts — pure-function coverage for
// parity/live/scenario.mjs's event parsing/validation/scheduling. No
// subprocess, no live run — every case here is plain JSON in, plain data out.

import { describe, it, expect } from "vitest";
import {
  EVENT_TYPES,
  MODEL_FAULT_TYPES,
  normalizeEvent,
  validateEvent,
  parseScenario,
  expandBursts,
  validateNoOverlapWithQuiet,
  compileTimeline,
  impliedMinimumMinutes,
} from "../parity/live/scenario.mjs";

describe("normalizeEvent", () => {
  it("defaults a bare {atMinutes, from, text} (no type) to a message — backward compat with the original A/B/C protocol", () => {
    const ev = normalizeEvent({ atMinutes: 3, from: "jo", text: "hi" }, 0);
    expect(ev.type).toBe("message");
    expect(ev.text).toBe("hi");
  });

  it("rejects a non-object event", () => {
    expect(() => normalizeEvent("nope", 2)).toThrow(/scenario\[2\]/);
  });

  it("rejects an unknown type", () => {
    expect(() => normalizeEvent({ type: "teleport", atMinutes: 1 }, 5)).toThrow(/unknown event type/);
  });

  it("rejects a missing/negative atMinutes", () => {
    expect(() => normalizeEvent({ type: "quiet", minutes: 1 }, 0)).toThrow(/atMinutes/);
    expect(() => normalizeEvent({ type: "quiet", atMinutes: -1, minutes: 1 }, 0)).toThrow(/atMinutes/);
  });

  it("every EVENT_TYPES member is a real, spellable string", () => {
    expect(EVENT_TYPES.size).toBeGreaterThanOrEqual(11);
    for (const t of EVENT_TYPES) expect(typeof t).toBe("string");
  });
});

describe("validateEvent — per-type required fields", () => {
  it("message requires non-empty text", () => {
    expect(() => validateEvent({ type: "message", atMinutes: 0 }, 0)).toThrow(/text/);
    expect(() => validateEvent({ type: "message", atMinutes: 0, text: "" }, 0)).toThrow(/text/);
    expect(validateEvent({ type: "message", atMinutes: 0, text: "hi" }, 0).text).toBe("hi");
  });

  it("burst requires count + overSeconds, and either texts (matching count) or textTemplate", () => {
    expect(() => validateEvent({ type: "burst", atMinutes: 0, overSeconds: 10 }, 0)).toThrow(/count/);
    expect(() => validateEvent({ type: "burst", atMinutes: 0, count: 3 }, 0)).toThrow(/overSeconds/);
    expect(() => validateEvent({ type: "burst", atMinutes: 0, count: 2, overSeconds: 10 }, 0)).toThrow(/texts.*textTemplate|textTemplate/);
    expect(() => validateEvent({ type: "burst", atMinutes: 0, count: 2, overSeconds: 10, texts: ["a"] }, 0)).toThrow(/exactly "count"/);
    expect(validateEvent({ type: "burst", atMinutes: 0, count: 2, overSeconds: 10, textTemplate: "msg {n}" }, 0).textTemplate).toBe("msg {n}");
  });

  it("model-fault requires a known faultType and positive integer count", () => {
    expect(() => validateEvent({ type: "model-fault", atMinutes: 0, count: 3 }, 0)).toThrow(/faultType/);
    expect(() => validateEvent({ type: "model-fault", atMinutes: 0, faultType: "418", count: 3 }, 0)).toThrow(/faultType/);
    expect(() => validateEvent({ type: "model-fault", atMinutes: 0, faultType: "500", count: 0 }, 0)).toThrow(/count/);
    for (const ft of MODEL_FAULT_TYPES) {
      expect(validateEvent({ type: "model-fault", atMinutes: 0, faultType: ft, count: 1 }, 0).faultType).toBe(ft);
    }
  });

  it("quiet requires a positive minutes", () => {
    expect(() => validateEvent({ type: "quiet", atMinutes: 0 }, 0)).toThrow(/minutes/);
    expect(() => validateEvent({ type: "quiet", atMinutes: 0, minutes: 0 }, 0)).toThrow(/minutes/);
  });

  it("second-identity requires an identity-safe slug name", () => {
    expect(() => validateEvent({ type: "second-identity", atMinutes: 0 }, 0)).toThrow(/name/);
    expect(() => validateEvent({ type: "second-identity", atMinutes: 0, name: "Not Safe!" }, 0)).toThrow(/identity-safe/);
    expect(validateEvent({ type: "second-identity", atMinutes: 0, name: "sxs2" }, 0).name).toBe("sxs2");
  });

  it("bare-field events (thinkers-stop/start, dispatcher-sigterm/sigkill, step-sigkill, docker-pause/unpause) need nothing beyond atMinutes", () => {
    for (const type of ["thinkers-stop", "thinkers-start", "dispatcher-sigterm", "dispatcher-sigkill", "step-sigkill", "docker-pause", "docker-unpause"]) {
      expect(validateEvent({ type, atMinutes: 1 }, 0).type).toBe(type);
    }
  });
});

describe("parseScenario", () => {
  it("rejects a non-array", () => {
    expect(() => parseScenario({ atMinutes: 0, text: "x" })).toThrow(/JSON array/);
  });

  it("sorts events by atMinutes, stable on ties", () => {
    const events = parseScenario([
      { atMinutes: 5, text: "second" },
      { atMinutes: 1, text: "first" },
      { atMinutes: 5, text: "third" }, // ties with the first entry — must keep input order
    ]);
    expect(events.map((e) => e.text)).toEqual(["first", "second", "third"]);
  });

  it("surfaces the first validation error with its index", () => {
    expect(() => parseScenario([{ atMinutes: 0, text: "ok" }, { type: "quiet", atMinutes: 1 }])).toThrow(/scenario\[1\]/);
  });
});

describe("expandBursts", () => {
  it("expands a burst into `count` messages spread evenly across overSeconds, first at offset 0", () => {
    const out = expandBursts([{ type: "burst", atMinutes: 10, count: 3, overSeconds: 60, from: "jo", textTemplate: "ping #{n}" }]);
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.type === "message")).toBe(true);
    expect(out.map((e) => e.text)).toEqual(["ping #1", "ping #2", "ping #3"]);
    expect(out[0].atMinutes).toBeCloseTo(10, 10);
    expect(out[1].atMinutes).toBeCloseTo(10 + 30 / 60, 10); // 30s in
    expect(out[2].atMinutes).toBeCloseTo(10 + 60 / 60, 10); // 60s in
    expect(out.every((e) => e.burstId === 0)).toBe(true);
    expect(out.map((e) => e.burstIndex)).toEqual([1, 2, 3]);
  });

  it("uses an explicit texts array verbatim when given", () => {
    const out = expandBursts([{ type: "burst", atMinutes: 0, count: 2, overSeconds: 0, texts: ["a", "b"] }]);
    expect(out.map((e) => e.text)).toEqual(["a", "b"]);
    // count=2 but overSeconds=0 -> both at the same instant
    expect(out[0].atMinutes).toBe(out[1].atMinutes);
  });

  it("a count=1 burst fires once at atMinutes, no division by zero", () => {
    const out = expandBursts([{ type: "burst", atMinutes: 4, count: 1, overSeconds: 30, textTemplate: "solo {n}" }]);
    expect(out).toEqual([expect.objectContaining({ atMinutes: 4, text: "solo 1" })]);
  });

  it("passes non-burst events through unchanged", () => {
    const ev = { type: "thinkers-stop", atMinutes: 2 };
    expect(expandBursts([ev])).toEqual([ev]);
  });
});

describe("validateNoOverlapWithQuiet", () => {
  it("throws when a message falls strictly inside a quiet window", () => {
    const events = [
      { type: "quiet", atMinutes: 5, minutes: 10 },
      { type: "message", atMinutes: 8, text: "sneaky" },
    ];
    expect(() => validateNoOverlapWithQuiet(events)).toThrow(/quiet window/);
  });

  it("allows an event exactly AT the quiet window's start or end instant (boundary, not inside)", () => {
    const events = [
      { type: "quiet", atMinutes: 5, minutes: 10 },
      { type: "message", atMinutes: 5, text: "right at the start" },
      { type: "message", atMinutes: 15, text: "right at the end" },
    ];
    expect(() => validateNoOverlapWithQuiet(events)).not.toThrow();
  });

  it("allows non-overlapping events fine", () => {
    const events = [
      { type: "quiet", atMinutes: 5, minutes: 10 },
      { type: "message", atMinutes: 1, text: "before" },
      { type: "message", atMinutes: 16, text: "after" },
    ];
    expect(() => validateNoOverlapWithQuiet(events)).not.toThrow();
  });
});

describe("compileTimeline — the full pipeline", () => {
  it("parses, expands bursts, validates quiet windows, and returns one flat sorted list", () => {
    const raw = [
      { atMinutes: 0, text: "hello" },
      { type: "burst", atMinutes: 2, count: 2, overSeconds: 10, textTemplate: "b{n}" },
      { type: "dispatcher-sigterm", atMinutes: 1 },
      { type: "quiet", atMinutes: 5, minutes: 2 },
    ];
    const timeline = compileTimeline(raw);
    expect(timeline.map((e) => e.type)).toEqual(["message", "dispatcher-sigterm", "message", "message", "quiet"]);
    for (let i = 1; i < timeline.length; i++) expect(timeline[i].atMinutes).toBeGreaterThanOrEqual(timeline[i - 1].atMinutes);
  });

  it("rejects a scenario whose burst spills into a quiet window", () => {
    const raw = [
      { type: "quiet", atMinutes: 0, minutes: 5 },
      { type: "burst", atMinutes: 2, count: 2, overSeconds: 10, textTemplate: "b{n}" },
    ];
    expect(() => compileTimeline(raw)).toThrow(/quiet window/);
  });
});

describe("impliedMinimumMinutes", () => {
  it("is the latest event end time, accounting for a quiet window's own duration", () => {
    expect(impliedMinimumMinutes([{ type: "message", atMinutes: 3 }, { type: "quiet", atMinutes: 5, minutes: 10 }])).toBe(15);
    expect(impliedMinimumMinutes([{ type: "message", atMinutes: 20 }, { type: "quiet", atMinutes: 5, minutes: 10 }])).toBe(20);
    expect(impliedMinimumMinutes([])).toBe(0);
  });
});
