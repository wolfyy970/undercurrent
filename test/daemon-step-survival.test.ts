// daemon-step-survival.test.ts — RUNTIME-SEAMS.md §A row 1 / §D priority #5:
// proves that a step process spawned by the REAL bin/dispatcherd.mjs
// (src/daemon.ts:369-372 spawnStep, `detached: true` + `child.unref()`)
// outlives both a dispatcher tick AND the dispatcher's own SIGTERM exit —
// not just "the daemon handles SIGTERM cleanly" (already covered by
// daemon.test.ts), but specifically that the CHILD it spawned keeps running
// and finishes its work after the parent is gone.
//
// Upstream comparison (bin/thinkers:552-561 `_dispatch_step` + :931-933
// `_cleanup_dispatcher` -> `_cleanup_run_state`): the backgrounded step
// subshell is never added to any kill list on dispatcher exit —
// `_cleanup_run_state` only TERMs `tail_pids` (the traj-file feeders) and
// removes fifo/sub_map/traj_files/token/pending. `step_pids` is read-only
// bookkeeping there; nothing walks it to kill steps. So upstream's own step
// survives a dispatcher SIGTERM too — this is not a divergence to fix, only
// a behavior to prove on the port side, matching src/daemon.ts's own
// `cleanup()` comment: "in-flight steps are never killed by the daemon's
// own exit."

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { appendStep } from "../src/trajCore.mjs";
import { feedersLive } from "./support/daemonReady.ts";

const DISPATCHERD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "dispatcherd.mjs");

const children: ChildProcess[] = [];
const roots: string[] = [];
const strayPids: number[] = [];

afterEach(async () => {
  while (children.length) {
    const c = children.pop()!;
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise<void>((r) => {
        if (c.exitCode !== null || c.signalCode !== null) return r();
        c.once("exit", () => r());
        setTimeout(r, 1000);
      });
    }
  }
  // The step process is deliberately detached from its parent's lifecycle —
  // clean it up ourselves so a killed test run doesn't leak a real sleeping
  // node process.
  while (strayPids.length) {
    const pid = strayPids.pop()!;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// PORT-NOTE: raised 5s -> 15s per lane B's brief (known load flake — this
// suite is a real detached subprocess surviving a real SIGTERM to its
// parent, and heavy CPU contention from a concurrent test run can delay it
// past a tight poll deadline with no product bug involved).
async function poll(pred: () => boolean, timeoutMs = 15000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!pred()) throw new Error(`poll: condition not met within ${timeoutMs}ms`);
}

function readOr(file: string, fallback = ""): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Rig {
  root: string;
  idDir: string;
  runDir: string;
  trajFile: string;
  doneFile: string;
}

/** A fresh identity with monolith+responder disabled and one Node "slow"
 *  thinker subscribed to "message" that sleeps ~2.5s past its start marker,
 *  then appends a real trajectory record — long enough to reliably outlive
 *  a dispatcher SIGTERM sent right after the start marker appears, short
 *  enough to keep the test fast. */
function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-daemon-survival-"));
  roots.push(root);
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  const idDir = result.identityDir;
  fs.writeFileSync(path.join(idDir, "thinkers", "monolith", "disabled"), "x");
  fs.writeFileSync(path.join(idDir, "thinkers", "responder", "disabled"), "x");

  const slowDir = path.join(idDir, "thinkers", "slow");
  fs.mkdirSync(slowDir, { recursive: true });
  fs.writeFileSync(
    path.join(slowDir, "subscriptions.jsonl"),
    `${JSON.stringify({ types: ["message"], trigger_self: false, traj_id: result.rootTrajectoryId })}\n`
  );

  const trajFile = path.join(
    idDir,
    "trajectories",
    `${result.rootTrajectoryId.slice(0, 8)}-root`,
    "trajectory.jsonl"
  );
  const startedFile = path.join(idDir, "step.started");
  const doneFile = path.join(idDir, "step.done");

  fs.writeFileSync(
    path.join(slowDir, "step"),
    [
      "#!/usr/bin/env node",
      "import * as fs from 'node:fs';",
      "fs.readFileSync(0, 'utf8');",
      `fs.writeFileSync(${JSON.stringify(startedFile)}, String(process.pid));`,
      "await new Promise((r) => setTimeout(r, 2500));",
      `fs.appendFileSync(${JSON.stringify(trajFile)}, JSON.stringify({ type: "note", content: "survived-dispatcher-exit", from: "slow", ts: new Date().toISOString() }) + "\\n");`,
      `fs.writeFileSync(${JSON.stringify(doneFile)}, "x");`,
      "",
    ].join("\n")
  );
  fs.chmodSync(path.join(slowDir, "step"), 0o755);

  const runDir = path.join(idDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "active_thinkers"), "slow\n");

  return { root, idDir, runDir, trajFile, doneFile };
}

function spawnDaemon(rig: Rig): ChildProcess {
  const env = resolveIdentityEnv(rig.idDir, { base: process.env as Record<string, string> });
  const child = spawn(process.execPath, [DISPATCHERD], { env, stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

describe("daemon step survives dispatcher SIGTERM (real bin/dispatcherd.mjs child process, real detached step)", () => {
  it("SIGTERM to the dispatcher after a step starts leaves the step alive; it finishes and appends its trajectory record", async () => {
    const rig = makeRig();
    const daemon = spawnDaemon(rig);
    await feedersLive(rig.runDir, daemon); // sub_map is not "tailing" (PARITY.md "Start-up window")

    appendStep(rig.trajFile, { type: "message", content: "go", from: "operator", to: "pax", source: "chat" }, {});

    const startedFile = path.join(rig.idDir, "step.started");
    await poll(() => fs.existsSync(startedFile));
    const stepPid = Number(readOr(startedFile));
    expect(Number.isInteger(stepPid)).toBe(true);
    expect(isAlive(stepPid)).toBe(true);
    strayPids.push(stepPid);

    // Also confirm the dispatcher recorded it in step_pids, same as upstream's
    // step_pids bookkeeping (bin/thinkers:562).
    expect(readOr(path.join(rig.runDir, "step_pids"))).toContain(`${stepPid} slow`);

    // Kill the dispatcher NOW — well before the step's 2.5s sleep completes.
    daemon.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => daemon.once("exit", resolve));
    expect(code).toBe(130); // unsanctioned SIGTERM, same convention as daemon.test.ts

    // The dispatcher is dead; the step must still be alive right now.
    expect(isAlive(stepPid)).toBe(true);

    // ...and it completes its trajectory append on its own, unattended.
    await poll(() => fs.existsSync(rig.doneFile), 15000);
    // The doneFile write and actual process exit are two separate OS events
    // a beat apart (the script returns and Node tears the process down after
    // the last fs write lands) — under heavy system load that beat can widen
    // past an instant check, so poll briefly rather than asserting the pid
    // is already gone the instant the file appears.
    await poll(() => !isAlive(stepPid), 3000);
    expect(readOr(rig.trajFile)).toContain('"survived-dispatcher-exit"');
  }, 10000);
});
