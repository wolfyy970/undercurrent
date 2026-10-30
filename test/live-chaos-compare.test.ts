// test/live-chaos-compare.test.ts — pure-function coverage for
// parity/live/lib.mjs's L4 chaos-recovery snapshot comparison
// (buildChaosSnapshot, parseStepPids, hasWakeGapNote, compareChaosEvent,
// renderChaosSection). Uses synthetic before/after snapshots — no
// subprocess, no ps/docker, no live run.

import { describe, it, expect } from "vitest";
import { parseStepPids, hasWakeGapNote, buildChaosSnapshot, compareChaosEvent, renderChaosSection } from "../parity/live/lib.mjs";

describe("parseStepPids", () => {
  it("parses '<pid> <name>' lines, skipping blanks", () => {
    expect(parseStepPids("123 monolith\n\n456 responder\n")).toEqual([
      { pid: 123, name: "monolith" },
      { pid: 456, name: "responder" },
    ]);
  });

  it("handles empty/undefined input", () => {
    expect(parseStepPids("")).toEqual([]);
    expect(parseStepPids(undefined)).toEqual([]);
  });
});

describe("hasWakeGapNote", () => {
  it("detects the dispatcher-downtime wake-up note by its lead sentence", () => {
    expect(hasWakeGapNote('{"type":"observation","content":"Wake-up note: your dispatcher just started, and the previous step..."}')).toBe(true);
  });
  it("false when absent", () => {
    expect(hasWakeGapNote('{"type":"observation","content":"something else"}')).toBe(false);
    expect(hasWakeGapNote(undefined)).toBe(false);
  });
});

describe("buildChaosSnapshot", () => {
  it("normalizes raw disk/ps/docker facts into a comparable snapshot", () => {
    const snap = buildChaosSnapshot({
      dispatcherPidText: "4242",
      dispatcherAlive: true,
      lastSignalText: "SIGTERM\n",
      stepPidsText: "111 monolith\n222 responder\n",
      pendingNames: ["jo.message.100.1"],
      containers: [{ id: "abc", name: "shellm-111", state: "running" }],
      trajectoryTailText: '{"content":"Wake-up note: your dispatcher just started..."}',
    });
    expect(snap).toEqual({
      dispatcherPid: 4242,
      dispatcherAlive: true,
      lastSignal: "SIGTERM",
      stepPidCount: 2,
      stepPidNames: ["monolith", "responder"],
      pendingCount: 1,
      containerCount: 1,
      containerStates: ["running"],
      wakeGapNotePresent: true,
    });
  });

  it("handles a bare/empty raw snapshot (dispatcher gone, nothing running)", () => {
    const snap = buildChaosSnapshot({ dispatcherPidText: "", dispatcherAlive: false, lastSignalText: "", stepPidsText: "", pendingNames: [], containers: [] });
    expect(snap.dispatcherPid).toBeNull();
    expect(snap.dispatcherAlive).toBe(false);
    expect(snap.lastSignal).toBeNull();
    expect(snap.stepPidCount).toBe(0);
    expect(snap.wakeGapNotePresent).toBe(false);
  });
});

describe("compareChaosEvent", () => {
  const event = { type: "dispatcher-sigterm", atMinutes: 12 };

  it("matches when both sides transition the same way (dispatcher died, signal recorded identically)", () => {
    const before = buildChaosSnapshot({ dispatcherPidText: "100", dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const origAfter = buildChaosSnapshot({ dispatcherPidText: "100", dispatcherAlive: false, lastSignalText: "SIGTERM\n", stepPidsText: "", pendingNames: [], containers: [] });
    const portAfter = buildChaosSnapshot({ dispatcherPidText: "200", dispatcherAlive: false, lastSignalText: "SIGTERM\n", stepPidsText: "", pendingNames: [], containers: [] });
    const row = compareChaosEvent(event, before, origAfter, before, portAfter);
    expect(row.event).toBe("dispatcher-sigterm");
    expect(row.atMinutes).toBe(12);
    const dispatcherAliveField = row.fields.find((f) => f.name === "dispatcherAlive")!;
    expect(dispatcherAliveField.match).toBe(true);
    const lastSignalField = row.fields.find((f) => f.name === "lastSignal")!;
    expect(lastSignalField.match).toBe(true);
    expect(row.fields.every((f) => f.match)).toBe(true);
  });

  it("flags a mismatch when only one side's dispatcher comes back up", () => {
    const before = buildChaosSnapshot({ dispatcherPidText: "100", dispatcherAlive: false, stepPidsText: "", pendingNames: [], containers: [] });
    const origAfter = buildChaosSnapshot({ dispatcherPidText: "101", dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const portAfter = buildChaosSnapshot({ dispatcherPidText: "", dispatcherAlive: false, stepPidsText: "", pendingNames: [], containers: [] });
    const row = compareChaosEvent({ type: "thinkers-start", atMinutes: 13 }, before, origAfter, before, portAfter);
    const f = row.fields.find((x) => x.name === "dispatcherAlive")!;
    expect(f.match).toBe(false);
    expect(f.orig).toBe(true);
    expect(f.port).toBe(false);
  });

  it("compares count-like fields by the SIGN of their delta, not absolute value — different absolute step counts with the same direction still match", () => {
    const origBefore = buildChaosSnapshot({ stepPidsText: "1 a\n2 b\n3 c\n", pendingNames: [], containers: [] });
    const origAfter = buildChaosSnapshot({ stepPidsText: "1 a\n", pendingNames: [], containers: [] }); // 3 -> 1, dropped
    const portBefore = buildChaosSnapshot({ stepPidsText: "9 x\n", pendingNames: [], containers: [] });
    const portAfter = buildChaosSnapshot({ stepPidsText: "", pendingNames: [], containers: [] }); // 1 -> 0, dropped
    const row = compareChaosEvent({ type: "step-sigkill", atMinutes: 15 }, origBefore, origAfter, portBefore, portAfter);
    const f = row.fields.find((x) => x.name === "stepPidCount (delta)")!;
    expect(f.match).toBe(true); // both decreased, despite different absolute counts
    expect(f.orig).toContain("3->1");
    expect(f.port).toContain("1->0");
  });

  it("flags a delta mismatch when one side's step count drops and the other's doesn't (orphan not pruned on one side)", () => {
    const before = buildChaosSnapshot({ stepPidsText: "1 a\n", pendingNames: [], containers: [] });
    const origAfter = buildChaosSnapshot({ stepPidsText: "", pendingNames: [], containers: [] }); // pruned
    const portAfter = buildChaosSnapshot({ stepPidsText: "1 a\n", pendingNames: [], containers: [] }); // still there — not pruned
    const row = compareChaosEvent({ type: "step-sigkill", atMinutes: 20 }, before, origAfter, before, portAfter);
    const f = row.fields.find((x) => x.name === "stepPidCount (delta)")!;
    expect(f.match).toBe(false);
  });
});

describe("renderChaosSection", () => {
  it("empty rows render nothing", () => {
    expect(renderChaosSection([])).toBe("");
  });

  it("renders a per-event table with a match column and a bottom-line summary", () => {
    const before = buildChaosSnapshot({ dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const origAfter = buildChaosSnapshot({ dispatcherAlive: false, stepPidsText: "", pendingNames: [], containers: [] });
    const portAfter = buildChaosSnapshot({ dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const row = compareChaosEvent({ type: "dispatcher-sigkill", atMinutes: 20 }, before, origAfter, before, portAfter);
    const md = renderChaosSection([row]);
    expect(md).toContain("## Chaos recovery (L4)");
    expect(md).toContain("T+20min — dispatcher-sigkill");
    expect(md).toContain("dispatcherAlive");
    expect(md).toContain("**no**"); // the mismatched field is called out
    expect(md).toMatch(/\d+ field\(s\) did not match/);
  });

  it("reports a clean bottom line when every field matches", () => {
    const before = buildChaosSnapshot({ dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const after = buildChaosSnapshot({ dispatcherAlive: true, stepPidsText: "", pendingNames: [], containers: [] });
    const row = compareChaosEvent({ type: "docker-pause", atMinutes: 5 }, before, after, before, after);
    const md = renderChaosSection([row]);
    expect(md).toContain("All chaos-event fields matched between sides.");
  });
});
