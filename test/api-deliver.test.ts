// src/api.ts deliverMessage against the real engine: the dispatcher wakes a responder once per delivered message,
// a re-delivery is a no-op, and the origin `_ref` fields stay out of the model's context.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverMessage } from "../src/api.ts";
import * as core from "../src/trajCore.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hl-api-deliver-"));
const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const until = async (cond: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
  return cond();
};
async function realIdentity(name: string) {
  const trajDir = path.join(tmpDir(), "traj");
  fs.mkdirSync(trajDir, { recursive: true });
  const { trajId, trajFile } = core.newTrajectory(trajDir, {}) as { trajId: string; trajFile: string };
  return { core, trajDir, trajId, trajFile, name };
}

describe("api deliverMessage with the real dispatcher", () => {
  it("the REAL TrajFeeder + Dispatcher (with the daemon's rewind guard and wake ledger) wake the responder once on a delivery, and not on a second delivery", async () => {
    const { Dispatcher } = await import("../src/dispatcher.ts");
    const { TrajFeeder } = await import("../src/feeder.ts");
    const { WakeLedger } = await import("../src/wakeLedger.ts");
    const t = await realIdentity("bob");
    const stateDir = path.join(tmpDir(), "run");
    fs.mkdirSync(stateDir, { recursive: true });
    const woken: Record<string, unknown>[] = [];
    const d = new Dispatcher(null, {
      stateDir,
      identityName: "bob",
      ledger: new WakeLedger(stateDir),
      guards: { rewindToleranceSecs: 600, stepGraceSecs: 0, stepQuietSecs: 0, stepPid: () => undefined, kill: () => {}, firstTrajFile: () => t.trajFile },
    });
    d.register({
      name: "responder",
      subscription: { types: ["message"], triggerSelf: false, watchdogSecs: 0 },
      run: async (trigger: Record<string, unknown>) => {
        woken.push(trigger);
      },
    });
    const feeder = new TrajFeeder(t.trajFile, { onLine: (l: string) => d.feed(JSON.parse(l), t.trajFile) });
    feeder.start();
    try {
      const a = deliverMessage(t.trajFile, {from: "ann", to: "bob", content: "hello bob", originStep: "o-1" });
      deliverMessage(t.trajFile, {from: "ann", to: "bob", content: "hello bob", originStep: "o-1" });
      feeder.poll();
      expect(await until(() => woken.length >= 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({ type: "message", from: "ann", to: "bob", source: "chat", content: "hello bob", step_id: a.stepId });
      // A second, different message wakes it again (the guards did not latch).
      deliverMessage(t.trajFile, {from: "ann", to: "bob", content: "again", originStep: "o-2" });
      feeder.poll();
      expect(await until(() => woken.length >= 2)).toBe(true);
      expect(d.log.some((e: { kind: string }) => e.kind === "dispatch")).toBe(true);
    } finally {
      feeder.close();
    }
  });

  it("the same origin message to two recipients on ONE dispatcher process wakes both (fresh step ids)", async () => {
    const { Dispatcher } = await import("../src/dispatcher.ts");
    const { TrajFeeder } = await import("../src/feeder.ts");
    const b = await realIdentity("bob");
    const c = await realIdentity("cat");
    const stateDir = path.join(tmpDir(), "run");
    fs.mkdirSync(stateDir, { recursive: true });
    const woken: string[] = [];
    const d = new Dispatcher(null, {
      stateDir,
      identityName: "bob",
      guards: { rewindToleranceSecs: 600, stepGraceSecs: 0, stepQuietSecs: 0, stepPid: () => undefined, kill: () => {}, firstTrajFile: () => b.trajFile },
    });
    for (const [n, tf] of [["resp-bob", b.trajFile], ["resp-cat", c.trajFile]] as const)
      d.register({ name: n, subscription: { types: ["message"], triggerSelf: false, watchdogSecs: 0, trajFile: tf }, run: async () => void woken.push(n) });
    const feeders = [b, c].map((t) => new TrajFeeder(t.trajFile, { onLine: (l: string) => d.feed(JSON.parse(l), t.trajFile) }));
    feeders.forEach((f) => f.start());
    try {
      deliverMessage(b.trajFile, {from: "ann", to: "bob", content: "all hands", originStep: "o-9" });
      deliverMessage(c.trajFile, {from: "ann", to: "cat", content: "all hands", originStep: "o-9" });
      feeders.forEach((f) => f.poll());
      expect(await until(() => woken.length >= 2)).toBe(true);
      expect(woken.sort()).toEqual(["resp-bob", "resp-cat"]);
    } finally {
      feeders.forEach((f) => f.close());
    }
  });

  it("control: the real dispatcher DROPS the second of two lines that share a step_id (why a delivery gets a fresh id)", async () => {
    const { Dispatcher } = await import("../src/dispatcher.ts");
    const { TrajFeeder } = await import("../src/feeder.ts");
    const b = await realIdentity("bob");
    const c = await realIdentity("cat");
    const stateDir = path.join(tmpDir(), "run");
    fs.mkdirSync(stateDir, { recursive: true });
    const woken: string[] = [];
    const d = new Dispatcher(null, {
      stateDir,
      identityName: "bob",
      guards: { rewindToleranceSecs: 600, stepGraceSecs: 0, stepQuietSecs: 0, stepPid: () => undefined, kill: () => {}, firstTrajFile: () => b.trajFile },
    });
    for (const [n, tf] of [["resp-bob", b.trajFile], ["resp-cat", c.trajFile]] as const)
      d.register({ name: n, subscription: { types: ["message"], triggerSelf: false, watchdogSecs: 0, trajFile: tf }, run: async () => void woken.push(n) });
    const feeders = [b, c].map((t) => new TrajFeeder(t.trajFile, { onLine: (l: string) => d.feed(JSON.parse(l), t.trajFile) }));
    feeders.forEach((f) => f.start());
    try {
      const reused = "99999999-9999-4999-8999-999999999999";
      b.core.appendStep(b.trajFile, { type: "message", content: "x", from: "ann", to: "bob", source: "chat", step_id: reused });
      c.core.appendStep(c.trajFile, { type: "message", content: "x", from: "ann", to: "cat", source: "chat", step_id: reused });
      feeders.forEach((f) => f.poll());
      await until(() => woken.length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(woken).toHaveLength(1);
    } finally {
      feeders.forEach((f) => f.close());
    }
  });

  it("origin fields are hidden from the model's context by the real buildContext, and an unsuffixed field is not", async () => {
    const { buildContext } = await import("../src/context.ts");
    const o = { head: 1, tail: 50, assistantTypes: [], userTypes: ["message"], excludeTypes: [] };
    const t = await realIdentity("bob");
    deliverMessage(t.trajFile, {from: "ann", to: "bob", content: "hello bob", originStep: "o-1", originTraj: "t-ann" });
    const rows = lines(t.trajFile);
    const hidden = buildContext(rows, o).map((m: { content: string }) => m.content).join("\n");
    expect(hidden).toContain("hello bob");
    expect(hidden).not.toContain("o-1");
    expect(hidden).not.toContain("t-ann");
    const leaky = buildContext(rows.map((r) => (r.type === "message" ? { ...r, origin_step: "o-1" } : r)), o).map((m: { content: string }) => m.content).join("\n");
    expect(leaky).toContain("[origin_step]"); // why the field names end in _ref
  });
});
