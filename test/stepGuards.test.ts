// stepGuards.test.ts — rewind guard and stuck/quiet-step guard (upstream 2e39a3f). Oracles:
// tests/test_thinkers_trajectory_swap.sh and tests/test_thinkers_stuck_step.sh, run against the port
// by parity/upstream-tests --daemon; these are the deterministic unit versions.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isoEpoch, RewindGuard, StuckGuard } from "../src/stepGuards.js";
import { Dispatcher, type ThinkerDef, type TriggerStep } from "../src/dispatcher.js";

describe("isoEpoch", () => {
  it("parses the traj stamp forms and ignores fraction and zone", () => {
    expect(isoEpoch("2026-01-01T00:00:00Z")).toBe(1767225600);
    expect(isoEpoch("2026-01-01T00:00:00.123Z")).toBe(1767225600);
    expect(isoEpoch("2026-01-01T00:00:00.000+0000")).toBe(1767225600);
    expect(isoEpoch("2024-02-29T12:00:00Z")).toBe(1709208000);
  });
  it("malformed or missing stamps are unknown (null) so the step passes", () => {
    for (const v of ["", "yesterday", "2026-01-01", 5, undefined, null]) expect(isoEpoch(v)).toBeNull();
  });
});

function guardRig(tol = 600) {
  const logs: string[] = [];
  const errors: Array<[string, string, string]> = [];
  const g = new RewindGuard(tol, { log: (t) => logs.push(t), appendError: (f, r, c) => errors.push([f, r, c]) });
  return { g, logs, errors };
}
const at = (epoch: number) => new Date(epoch * 1000).toISOString();
const T = 1_800_000_000;

describe("RewindGuard", () => {
  it("a step older than the clock but newer than the cursor dispatches; older than the cursor by more than the tolerance is skipped", () => {
    const { g, logs, errors } = guardRig();
    g.seed(T - 3 * 86400);
    expect(g.admit({ ts: at(T - 2 * 86400), step_id: "away" }, "/t.jsonl")).toBe(true);
    expect(g.admit({ ts: at(T - 4 * 86400), step_id: "rewound" }, "/t.jsonl")).toBe(false);
    expect(logs[0]).toMatch(/^REWIND: a step stamped 172800s before the newest dispatched step arrived from \/t\.jsonl — /);
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe("trajectory-rewind");
    expect(g.admit({ ts: at(T), step_id: "after" }, "/t.jsonl")).toBe(true);
    expect(logs[1]).toBe("rewind over: skipped 1 replayed step(s)");
  });

  it("logs and files the error once per run, however many steps replay", () => {
    const { g, logs, errors } = guardRig();
    g.seed(T);
    for (let i = 0; i < 5; i++) expect(g.admit({ ts: at(T - 5000 - i), step_id: `h${i}` }, "/t")).toBe(false);
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    g.admit({ ts: at(T + 1), step_id: "live" }, "/t");
    expect(logs[1]).toBe("rewind over: skipped 5 replayed step(s)");
  });

  it("within the tolerance a step passes by time but a step_id already dispatched is skipped", () => {
    const { g, logs } = guardRig();
    g.seed(T);
    expect(g.admit({ ts: at(T - 100), step_id: "a" }, "/t")).toBe(true);
    expect(g.admit({ ts: at(T - 100), step_id: "a" }, "/t")).toBe(false);
    expect(logs[0]).toContain("step a arrived a second time");
  });

  it("tolerance 0 disables the guard; steps with no parseable ts pass", () => {
    const off = guardRig(0);
    off.g.seed(T);
    expect(off.g.admit({ ts: at(T - 99999), step_id: "x" }, "/t")).toBe(true);
    expect(off.g.admit({ ts: at(T - 99999), step_id: "x" }, "/t")).toBe(true);
    const on = guardRig();
    on.g.seed(T);
    expect(on.g.admit({ step_id: "nots" }, "/t")).toBe(true);
  });

  it("the dispatcher's own steps move the cursor and are remembered", () => {
    const { g } = guardRig();
    g.noteInternal("err1", T);
    expect(g.admit({ ts: at(T - 5000), step_id: "old" }, "/t")).toBe(false);
    expect(g.admit({ ts: at(T), step_id: "err1" }, "/t")).toBe(false);
  });
});

function stuckRig(opts: { grace?: number; quiet?: number } = {}) {
  let now = 100;
  const busy = new Set<string>(["runner"]);
  const kills: Array<[number, string]> = [];
  const logs: string[] = [];
  const errors: Array<[string, string, string]> = [];
  const g = new StuckGuard(
    {
      graceSecs: opts.grace ?? 3,
      quietSecs: opts.quiet ?? 0,
      clock: () => now,
      busy: (n) => busy.has(n),
      pidOf: () => 4242,
      kill: (p, s) => kills.push([p, s]),
      firstTrajFile: () => "/first.jsonl",
    },
    { log: (t) => logs.push(t), appendError: (f, r, c) => errors.push([f, r, c]) }
  );
  return { g, busy, kills, logs, errors, advance: (s: number) => (now += s) };
}

describe("StuckGuard", () => {
  it("a step still alive after its run's final plus the grace is TERMed once, then KILLed 15s later; one error step", () => {
    const r = stuckRig();
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    r.g.noteStep("final", "run-1", "/t.jsonl");
    r.advance(2);
    r.g.check();
    expect(r.kills).toEqual([]);
    r.advance(2);
    r.g.check();
    expect(r.kills).toEqual([[4242, "SIGTERM"]]);
    expect(r.logs[0]).toBe("STUCK: runner step (pid 4242) is still running 4s after its run run-1 wrote its final — sending TERM. Still alive in its process group: none");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]![0]).toBe("/t.jsonl");
    expect(r.errors[0]![1]).toBe("step-stuck");
    r.advance(10);
    r.g.check();
    expect(r.kills).toHaveLength(1);
    r.advance(5);
    r.g.check();
    expect(r.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(r.errors).toHaveLength(1);
    r.advance(100);
    r.g.check();
    expect(r.kills).toHaveLength(2); // record dropped
  });

  it("a step with no final, or whose final belongs to a run it did not launch, is left alone", () => {
    const r = stuckRig();
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    r.g.noteStep("final", "someone-elses-run", "/t.jsonl");
    r.advance(60);
    r.g.check();
    expect(r.kills).toEqual([]);
  });

  it("grace 0 and quiet 0 disable the guard", () => {
    const r = stuckRig({ grace: 0, quiet: 0 });
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    r.g.noteStep("final", "run-1", "/t.jsonl");
    r.advance(10000);
    r.g.check();
    expect(r.kills).toEqual([]);
  });

  it("the quiet clock ends a step that writes nothing; every step of its run restarts it", () => {
    const r = stuckRig({ grace: 0, quiet: 4 });
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    for (let i = 0; i < 4; i++) {
      r.advance(2);
      r.g.noteStep("reasoning", "run-1", "/t.jsonl");
      r.g.check();
    }
    expect(r.kills).toEqual([]);
    r.advance(4);
    r.g.check();
    expect(r.kills).toEqual([[4242, "SIGTERM"]]);
    expect(r.logs[0]).toContain("has put nothing on the trajectory for 4s");
    expect(r.errors[0]![0]).toBe("/first.jsonl");
    expect(r.errors[0]![1]).toBe("step-quiet");
  });

  it("a final swaps the quiet clock for the grace clock, which later steps never restart", () => {
    const r = stuckRig({ grace: 5, quiet: 1000 });
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    r.g.noteStep("final", "run-1", "/t.jsonl");
    r.advance(3);
    r.g.noteStep("observation", "run-1", "/t.jsonl");
    r.advance(3);
    r.g.check();
    expect(r.kills).toEqual([[4242, "SIGTERM"]]);
  });

  it("a thinker that is not busy is never attributed or ended; a step that exits on its own is forgotten", () => {
    const r = stuckRig();
    r.g.noteRun("run-9", "ghost"); // not busy
    r.g.noteDispatch("runner");
    r.g.noteRun("run-1", "runner");
    r.g.noteStep("final", "run-1", "/t.jsonl");
    r.busy.delete("runner");
    r.advance(60);
    r.g.check();
    expect(r.kills).toEqual([]);
  });
});

describe("Dispatcher wiring", () => {
  it("the rewind guard screens fed steps, shellm-run/final steps drive the stuck guard, and the dispatcher's own error steps are not screened", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-guards-"));
    try {
      const run = path.join(root, "run");
      fs.mkdirSync(run);
      const runs: TriggerStep[] = [];
      const appended: Array<Record<string, unknown>> = [];
      const kills: Array<[number, string]> = [];
      let now = 0;
      const d = new Dispatcher(null, {
        stateDir: run,
        identityName: "pax",
        appendTo: (_f, rec) => {
          appended.push(rec);
          return `id-${appended.length}`;
        },
        guards: {
          rewindToleranceSecs: 600,
          stepGraceSecs: 3,
          stepQuietSecs: 0,
          stepPid: () => 77,
          kill: (p, s) => kills.push([p, s]),
          firstTrajFile: () => "/t.jsonl",
          clock: () => now,
        },
      });
      let release: () => void = () => {};
      const def: ThinkerDef = {
        name: "runner",
        subscription: { types: ["action"], triggerSelf: false, watchdogSecs: 0 },
        run: (t) => {
          runs.push(t);
          return new Promise<void>((r) => (release = r));
        },
      };
      d.register(def);
      const T = Math.floor(Date.now() / 1000);
      d.seedRewindCursor(T);
      d.feed({ type: "action", step_id: "a1", ts: new Date(T * 1000).toISOString() }, "/t.jsonl");
      await new Promise((r) => setImmediate(r));
      expect(runs).toHaveLength(1);
      // a replayed step: skipped, one rewind error filed, not dispatched
      d.feed({ type: "action", step_id: "old", ts: new Date((T - 9999) * 1000).toISOString() }, "/t.jsonl");
      expect(appended.filter((r) => r["reason"] === "trajectory-rewind")).toHaveLength(1);
      // the run launches and finishes; the step lingers past the grace
      d.feed({ type: "shellm-run", step_id: "run-1", launched_by: "runner", ts: new Date(T * 1000).toISOString() }, "/t.jsonl");
      d.feed({ type: "final", step_id: "f1", run_id: "run-1", ts: new Date(T * 1000).toISOString() }, "/t.jsonl");
      now = 4;
      d.tick(T);
      expect(kills).toEqual([[77, "SIGTERM"]]);
      expect(appended.filter((r) => r["reason"] === "step-stuck")).toHaveLength(1);
      release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
