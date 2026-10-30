// dispatch-mechanics.test.ts — the dispatcher's routing mechanics and the
// responder's idempotency, tested to SOURCE (SPEC §3.6, §4.3 — these are the
// mechanisms the golden traces do not directly exercise: FIFO/coalescing,
// and the three-layer reply idempotency; the salience feedback-injection was removed upstream in 2e39a3f). VERIFIED
// bits (self-trigger skip, observation coalescing) are cross-checked against the
// trace-03 dispatcher log.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrajectory } from "../src/trajectory.js";
import {
  Dispatcher,
  ObservableTrajectory,
  type ThinkerDef,
  type TriggerStep,
} from "../src/dispatcher.js";
import { runResponder, responderAlreadyHandled } from "../src/responder.js";

import { isoTs } from "../src/trajCore.mjs";
import type { Step } from "../src/types.js";
import { httpModel } from "./support/modelHttpFixture.js";
import { recordedModel } from "./support/recordedModel.ts";

const flush = () => new Promise<void>((r) => setImmediate(r));

function tmpTraj(): { traj: ObservableTrajectory; stateDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-disp-"));
  const trajDir = path.join(root, "trajectories");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(stateDir, { recursive: true });
  const traj = new ObservableTrajectory(createTrajectory(trajDir));
  return { traj, stateDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A thinker whose runs block until explicitly released — lets us observe the
 *  busy-queue behaviour deterministically. */
class Gated {
  readonly runs: TriggerStep[] = [];
  private resolvers: (() => void)[] = [];
  def(name: string, types: string[], triggerSelf = false): ThinkerDef {
    return {
      name,
      subscription: { types, triggerSelf, watchdogSecs: 0 },
      run: (t: TriggerStep) => {
        this.runs.push(t);
        return new Promise<void>((r) => this.resolvers.push(r));
      },
    };
  }
  releaseOne(): void {
    const r = this.resolvers.shift();
    if (r) r();
  }
  get busyCount(): number {
    return this.resolvers.length;
  }
}

const typeOf = (s: Step) => String((s as { type?: string }).type ?? "");

describe("dispatch mechanics (SPEC §3.6)", () => {
  it("self-trigger:false skips a thinker's own step (VERIFIED trace-03)", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("mono", ["observation"], false));
      // A step whose source IS the thinker → skipped, never dispatched.
      traj.append({ type: "observation", content: "own note", source: "mono" });
      await flush();
      expect(g.runs.length).toBe(0);
      expect(d.log.some((e) => e.kind === "skip-self" && e.name === "mono")).toBe(true);

      // A step from ANOTHER source → dispatched.
      traj.append({ type: "observation", content: "external", source: "responder" });
      await flush();
      expect(g.runs.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("message steps queue FIFO behind a busy thinker and fire in arrival order", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("resp", ["message"], false));

      traj.append({ type: "message", content: "m1", from: "operator", to: "pax", source: "chat" });
      await flush(); // resp now busy running m1
      traj.append({ type: "message", content: "m2", from: "operator", to: "pax", source: "chat" });
      traj.append({ type: "message", content: "m3", from: "operator", to: "pax", source: "chat" });
      await flush();
      expect(g.runs.map((r) => r.content)).toEqual(["m1"]); // m2/m3 queued, not run
      expect(d.log.filter((e) => e.kind === "pending-queue" && e.name === "resp").length).toBe(2);

      g.releaseOne(); // m1 done → fire-pending m2
      await flush();
      g.releaseOne(); // m2 done → fire-pending m3
      await flush();
      expect(g.runs.map((r) => r.content)).toEqual(["m1", "m2", "m3"]);
    } finally {
      cleanup();
    }
  });

  it("non-FIFO steps (observation) coalesce last-wins behind a busy thinker (VERIFIED trace-03)", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("mono", ["observation"], false));

      traj.append({ type: "observation", content: "o1", source: "responder" });
      await flush(); // mono busy on o1
      traj.append({ type: "observation", content: "o2", source: "responder" });
      traj.append({ type: "observation", content: "o3", source: "responder" });
      await flush();
      expect(g.runs.map((r) => r.content)).toEqual(["o1"]);
      expect(d.log.filter((e) => e.kind === "pending-coalesce" && e.name === "mono").length).toBe(2);

      g.releaseOne(); // o1 done → fire the coalesced last-wins (o3); o2 was superseded
      await flush();
      expect(g.runs.map((r) => r.content)).toEqual(["o1", "o3"]);
    } finally {
      cleanup();
    }
  });

  it("FIFO cap is 16, drop-oldest", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("resp", ["message"], false));

      traj.append({ type: "message", content: "run", from: "operator", to: "pax", source: "chat" });
      await flush(); // busy
      for (let i = 0; i < 17; i++) {
        traj.append({ type: "message", content: `q${i}`, from: "operator", to: "pax", source: "chat" });
      }
      await flush();
      expect(d.log.some((e) => e.kind === "pending-drop" && e.name === "resp")).toBe(true);
      // Drain: exactly 16 queued survive (q1..q16; q0 dropped).
      const drained: string[] = [];
      for (let i = 0; i < 20; i++) {
        g.releaseOne();
        await flush();
      }
      const fired = g.runs.map((r) => String(r.content)).filter((c) => c.startsWith("q"));
      drained.push(...fired);
      expect(fired.length).toBe(16);
      expect(fired[0]).toBe("q1"); // q0 was the dropped oldest
      expect(fired[fired.length - 1]).toBe("q16");
    } finally {
      cleanup();
    }
  });

  // Sync 2e39a3f (47b3aa1): the salience `feedback` injection is gone. A message that queues behind a
  // busy run goes to the pending FIFO and nothing else; the responder answers it, a deferral reaches
  // the mind as an `action`.
  it("an inbound message queued behind a busy subscriber is queued only — no feedback step is appended", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("resp", ["message"], false));
      d.register(g.def("aux", ["message"], false));
      traj.append({ type: "message", content: "first", from: "operator", to: "pax", source: "chat" });
      await flush();
      expect(g.busyCount).toBe(2);
      traj.append({ type: "message", content: "urgent?", from: "operator", to: "pax", source: "chat" });
      await flush();
      expect(traj.read().filter((s) => typeOf(s) === "feedback").length).toBe(0);
      expect(d.log.filter((e) => e.kind === "pending-queue").length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("scheduled wake / run/<name>.wake_at (bin/thinkers:661-681)", () => {
  it("globs stateDir for *.wake_at, not the registered-thinkers map — an orphaned file for an UNREGISTERED name is still removed on tick", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      // Deliberately never registered — as if the thinker dir behind this
      // wake_at was removed after it was armed. Iterating this.thinkers.keys()
      // would never visit this file at all; a real disk glob (bin/thinkers'
      // `for _wf in "$run_dir"/*.wake_at`) always does.
      const wf = path.join(stateDir, "nobody.wake_at");
      fs.writeFileSync(wf, String(Math.floor(Date.now() / 1000) - 5));
      d.tick(Math.floor(Date.now() / 1000));
      expect(fs.existsSync(wf)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("a due wake_at for a registered+active thinker still fires a monolith-wake and consumes the file (glob rewrite didn't break the normal path)", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("napper", ["action"], false));
      const wf = path.join(stateDir, "napper.wake_at");
      fs.writeFileSync(wf, String(Math.floor(Date.now() / 1000) - 1));
      d.tick(Math.floor(Date.now() / 1000));
      await flush();
      expect(g.runs.length).toBe(1);
      expect(g.runs[0]?.type).toBe("monolith-wake");
      expect(g.runs[0]?.source).toBe("monolith-timer");
      expect(fs.existsSync(wf)).toBe(false);
      expect(d.log.some((e) => e.kind === "scheduled-wake" && e.name === "napper")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("garbage content is dropped without firing, same as an unregistered name", async () => {
    const { traj, stateDir, cleanup } = tmpTraj();
    try {
      const g = new Gated();
      const d = new Dispatcher(traj, { stateDir, identityName: "pax" });
      d.register(g.def("napper", ["action"], false));
      const wf = path.join(stateDir, "napper.wake_at");
      fs.writeFileSync(wf, "soon"); // not /^[0-9]+$/
      d.tick(Math.floor(Date.now() / 1000));
      await flush();
      expect(g.runs.length).toBe(0);
      expect(fs.existsSync(wf)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("responder idempotency, three layers (SPEC §4.3, common.sh:185-237)", () => {
  const cutoffFor = (ms: number) => isoTs(new Date(ms - 180_000));

  it("a FRESH reply_claim counts; a STALE one does not (crashed sends must retry)", () => {
    const trig = "trigger-1";
    const nowMs = Date.parse("2026-08-28T16:00:00.000Z");
    const fresh: Step[] = [
      { type: "message", step_id: trig, from: "operator", to: "pax", ts: isoTs(new Date(nowMs - 1000)) } as unknown as Step,
      { type: "reply_claim", step_id: "c1", source: "responder", trigger_step: trig, ts: isoTs(new Date(nowMs - 5_000)) } as unknown as Step,
    ];
    expect(responderAlreadyHandled(fresh, "pax", "operator", trig, cutoffFor(nowMs))).toBe(true);

    const stale: Step[] = [
      { type: "message", step_id: trig, from: "operator", to: "pax", ts: isoTs(new Date(nowMs - 400_000)) } as unknown as Step,
      { type: "reply_claim", step_id: "c1", source: "responder", trigger_step: trig, ts: isoTs(new Date(nowMs - 300_000)) } as unknown as Step,
    ];
    // Claim older than the 180s cutoff → does NOT block → not handled.
    expect(responderAlreadyHandled(stale, "pax", "operator", trig, cutoffFor(nowMs))).toBe(false);
  });

  it("a stamped reply (reply_to==trigger) and a decision observation both count as handled", () => {
    const trig = "trigger-2";
    const replied: Step[] = [
      { type: "message", step_id: trig, from: "operator", to: "pax", ts: isoTs() } as unknown as Step,
      { type: "message", step_id: "r1", from: "pax", to: "operator", reply_to: trig, ts: isoTs() } as unknown as Step,
    ];
    expect(responderAlreadyHandled(replied, "pax", "operator", trig, cutoffFor(Date.now()))).toBe(true);

    const noReply: Step[] = [
      { type: "message", step_id: trig, from: "operator", to: "pax", ts: isoTs() } as unknown as Step,
      { type: "observation", step_id: "o1", source: "responder", trigger_step: trig, decision: "no-reply", ts: isoTs() } as unknown as Step,
    ];
    expect(responderAlreadyHandled(noReply, "pax", "operator", trig, cutoffFor(Date.now()))).toBe(true);
  });

  it("nothing keyed to the trigger → NOT handled", () => {
    const trig = "trigger-3";
    const steps: Step[] = [
      { type: "message", step_id: trig, from: "operator", to: "pax", ts: isoTs() } as unknown as Step,
      { type: "observation", step_id: "o1", source: "monolith", ts: isoTs() } as unknown as Step,
    ];
    expect(responderAlreadyHandled(steps, "pax", "operator", trig, cutoffFor(Date.now()))).toBe(false);
  });

  it("a deliberate NO_REPLY sticks: re-delivering the same message does not re-claim or re-answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-resp-"));
    try {
      const traj = createTrajectory(path.join(root, "trajectories"));
      const msgId = traj.append({ type: "message", content: "thanks", from: "operator", to: "pax", source: "chat" });
      const trigger = { type: "message", content: "thanks", step_id: msgId, from: "operator", to: "pax", source: "chat" };

      // First delivery → NO_REPLY (claim + no-reply observation, no message). The reply is DeepSeek's real answer
      // to a bare "thanks" (test/fixtures/recordings/dispatch-mechanics/thanks-no-reply.json).
      const llm1 = recordedModel("dispatch-mechanics", "thanks-no-reply", { mode: "plain" });
      const r1 = await runResponder({
        trajectory: traj,
        llm: llm1,
        identityName: "pax",
        identityText: "pax",
        skillsText: "",
        trigger,
      });
      llm1.verify();
      expect(llm1.responses[0]!.text.trim()).toBe("NO_REPLY");
      expect(r1.outcome).toBe("no-reply");

      // Re-delivery (orphan double-dispatch) → the no-reply observation makes it
      // stick: skip, WITHOUT composing/answering. The llm must not be called
      // (an HTTP fixture with no replies, not model output, would fail the call if it were).
      const r2 = await runResponder({
        trajectory: traj,
        llm: httpModel([]),
        identityName: "pax",
        identityText: "pax",
        skillsText: "",
        trigger,
      });
      expect(r2.outcome).toBe("already-handled");

      const all = traj.read();
      expect(all.filter((s) => typeOf(s) === "reply_claim").length).toBe(1);
      expect(all.filter((s) => typeOf(s) === "observation").length).toBe(1);
      expect(all.filter((s) => typeOf(s) === "message").length).toBe(1); // just the inbound
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the responder's own outbound reply (to != identity) is a no-op skip, not a self-loop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-resp2-"));
    try {
      const traj = createTrajectory(path.join(root, "trajectories"));
      // Simulate the dispatcher re-delivering our own outbound reply message.
      const r = await runResponder({
        trajectory: traj,
        llm: httpModel([]), // must not be consulted
        identityName: "pax",
        identityText: "pax",
        skillsText: "",
        trigger: { type: "message", content: "our reply", step_id: "x", from: "pax", to: "operator", source: "chat" },
      });
      expect(r.outcome).toBe("skipped");
      expect(traj.read().filter((s) => typeOf(s) !== "trajectory").length).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
