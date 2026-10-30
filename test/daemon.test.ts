// daemon.test.ts — spawns the REAL bin/dispatcherd.mjs as a child process
// against a tmp identity with a minimal Node `echo` thinker (PLAN-daemon §8).
// Every test TERMs its daemon in afterEach and polls rather than sleeps.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { appendStep } from "../src/trajCore.mjs";
import { touchDeliberateStop, writeToken } from "../src/runstate.ts";
import { feedersLive } from "./support/daemonReady.ts";

const DISPATCHERD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "dispatcherd.mjs");

const children: ChildProcess[] = [];
const roots: string[] = [];

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
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function poll(pred: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
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

interface Rig {
  root: string;
  idDir: string;
  runDir: string;
  trajFile: string;
  rootTrajectoryId: string;
}

/** A fresh identity with monolith+responder disabled and one Node `echo`
 *  thinker subscribed to "message" — fast and fully deterministic. */
function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-daemon-test-"));
  roots.push(root);
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  const idDir = result.identityDir;
  fs.writeFileSync(path.join(idDir, "thinkers", "monolith", "disabled"), "x");
  fs.writeFileSync(path.join(idDir, "thinkers", "responder", "disabled"), "x");

  const echoDir = path.join(idDir, "thinkers", "echo");
  fs.mkdirSync(echoDir, { recursive: true });
  fs.writeFileSync(
    path.join(echoDir, "subscriptions.jsonl"),
    `${JSON.stringify({ types: ["message"], trigger_self: false, traj_id: result.rootTrajectoryId })}\n`
  );
  fs.writeFileSync(
    path.join(echoDir, "step"),
    "#!/usr/bin/env node\nimport * as fs from 'node:fs';\nconst raw = fs.readFileSync(0, 'utf8');\nprocess.stderr.write('echo saw: ' + raw + '\\n');\n"
  );
  fs.chmodSync(path.join(echoDir, "step"), 0o755);

  const runDir = path.join(idDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "active_thinkers"), "echo\n");

  const trajFile = path.join(
    idDir,
    "trajectories",
    `${result.rootTrajectoryId.slice(0, 8)}-root`,
    "trajectory.jsonl"
  );
  return { root, idDir, runDir, trajFile, rootTrajectoryId: result.rootTrajectoryId };
}

function spawnDaemon(rig: Rig): ChildProcess {
  const env = resolveIdentityEnv(rig.idDir, { base: process.env as Record<string, string> });
  const child = spawn(process.execPath, [DISPATCHERD], { env, stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

describe("daemon (real bin/dispatcherd.mjs child process)", () => {
  it("boot writes pid/token/sub_map/traj_files and an empty pending/", async () => {
    const rig = makeRig();
    spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "dispatcher.pid")));
    await poll(() => fs.existsSync(path.join(rig.runDir, "dispatcher.token")));
    await poll(() => fs.existsSync(path.join(rig.runDir, "sub_map")));
    await poll(() => fs.existsSync(path.join(rig.runDir, "traj_files")));

    const pid = Number(readOr(path.join(rig.runDir, "dispatcher.pid")));
    expect(Number.isInteger(pid)).toBe(true);
    expect(readOr(path.join(rig.runDir, "dispatcher.token"))).toMatch(/^[0-9a-f]{32}$/);
    expect(readOr(path.join(rig.runDir, "sub_map"))).toContain("echo\t");
    expect(readOr(path.join(rig.runDir, "traj_files")).trim()).toBe(rig.trajFile);
    expect(fs.readdirSync(path.join(rig.runDir, "pending"))).toEqual([]);
    expect(fs.readFileSync(path.join(rig.runDir, "step_pids"), "utf8")).toBe("");
  });

  it("an out-of-process trajectory append is fed, dispatched, and logged; step_pids appears then prunes", async () => {
    const rig = makeRig();
    const child = spawnDaemon(rig);
    // sub_map means booted, not tailing: a step appended before the feeder starts is skipped, as upstream's is
    // (PARITY.md "Start-up window"). Wait for the feeders, then append.
    await feedersLive(rig.runDir, child);

    appendStep(rig.trajFile, { type: "message", content: "hi", from: "operator", to: "pax", source: "chat" }, {});

    await poll(() => readOr(path.join(rig.runDir, "logs", "echo.log")).includes("echo saw"));
    expect(readOr(path.join(rig.runDir, "logs", "echo.log"))).toContain('"type":"message"');

    const dlog = readOr(path.join(rig.runDir, "logs", "dispatcher.log"));
    expect(dlog).toMatch(/\[dispatcher] step: type=message source=chat/);
    expect(dlog).toMatch(/\[dispatcher] {3}dispatch -> echo \(active=0\)/);

    // step_pids gets a line while the step runs, then prunes once it exits.
    // Pruning only happens on the next dispatcher tick (TICK_MS=1000) after
    // the step's own exit — under heavy CPU contention from a parallel
    // suite/live session, several ticks can be delayed before the daemon
    // gets scheduled, so give this a generous deadline (still a poll on the
    // real signal, not a raised global timeout).
    await poll(() => readOr(path.join(rig.runDir, "step_pids")).trim() === "", 15000);
  });

  it("a wake_at in the past fires a scheduled monolith-wake within 2s", async () => {
    const rig = makeRig();
    // Re-enable monolith so it is a registered (but idle) thinker; give it a
    // due wake_at directly (no LLM involved — the dispatcher fires purely on
    // the timer; the spawned step itself will fail fast with no LLM
    // configured, which is fine — this test only asserts the FIRE, not the
    // wake's outcome).
    fs.rmSync(path.join(rig.idDir, "thinkers", "monolith", "disabled"));
    fs.appendFileSync(path.join(rig.runDir, "active_thinkers"), "monolith\n");
    spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "sub_map")));
    fs.writeFileSync(path.join(rig.runDir, "monolith.wake_at"), String(Math.floor(Date.now() / 1000) - 5));

    await poll(() => readOr(path.join(rig.runDir, "logs", "dispatcher.log")).includes("scheduled wake -> monolith"), 3000);
    expect(fs.existsSync(path.join(rig.runDir, "monolith.wake_at"))).toBe(false);
  });

  it("a token overwritten by a newer owner makes the daemon exit 0 within 2s, without touching the new token", async () => {
    const rig = makeRig();
    const child = spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "dispatcher.token")));

    writeToken(rig.runDir, "9999999999.1.1");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("did not exit within 2s")), 2000);
      child.once("exit", (code) => {
        clearTimeout(t);
        expect(code).toBe(0);
        resolve();
      });
    });
    expect(readOr(path.join(rig.runDir, "dispatcher.token"))).toBe("9999999999.1.1");
  });

  it("deliberate_stop + SIGTERM exits 0 with token/pending gone", async () => {
    const rig = makeRig();
    const child = spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "dispatcher.token")));

    touchDeliberateStop(rig.runDir);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(rig.runDir, "dispatcher.token"))).toBe(false);
    expect(fs.existsSync(path.join(rig.runDir, "pending"))).toBe(false);
    expect(fs.existsSync(path.join(rig.runDir, "last_signal"))).toBe(false);
    // dispatcher.pid is the CLI's to remove, not the daemon's.
    expect(fs.existsSync(path.join(rig.runDir, "dispatcher.pid"))).toBe(true);
  });

  it("a plain SIGTERM (no deliberate_stop) exits 130 and writes last_signal", async () => {
    const rig = makeRig();
    const child = spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "dispatcher.token")));

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(130);
    expect(readOr(path.join(rig.runDir, "last_signal")).trim()).toBe("SIGTERM");
    expect(fs.existsSync(path.join(rig.runDir, "dispatcher.token"))).toBe(false);
  });
});

describe("daemon dispatcher.log — byte-diff vs a real Bash capture (PLAN-daemon §8, report-adversarial item 4)", () => {
  // A CONTROLLABLE echo step: writes a "started" marker on entry, then blocks
  // until a "release" marker appears — lets this test force the exact busy
  // window bin/thinkers' real `pending -> … (type=message, queued=1)` +
  // salience `feedback` re-fire sequence needs, deterministically (no race
  // against a fixed sleep). The shapes asserted below were captured against
  // the real Bash `bin/thinkers` by parity/daemon/run-parity-adversarial.mjs
  // (flow "chat-reactive", now PARITY — see report-adversarial.md).
  function makeControllableRig(): Rig & { startedFile: string; releaseFile: string } {
    const rig = makeRig();
    const startedFile = path.join(rig.idDir, "step.started");
    const releaseFile = path.join(rig.idDir, "step.release");
    fs.writeFileSync(
      path.join(rig.idDir, "thinkers", "echo", "step"),
      [
        "#!/usr/bin/env node",
        "import * as fs from 'node:fs';",
        "fs.readFileSync(0, 'utf8');",
        `fs.writeFileSync(${JSON.stringify(startedFile)}, 'x');`,
        `while (!fs.existsSync(${JSON.stringify(releaseFile)})) { /* busy-wait, deliberately synchronous */ }`,
        "",
      ].join("\n")
    );
    fs.chmodSync(path.join(rig.idDir, "thinkers", "echo", "step"), 0o755);
    return { ...rig, startedFile, releaseFile };
  }

  /** dispatcher.log lines with the ISO timestamp prefix dropped and pids/counts
   *  normalized — the same shape the adversarial harness's `norm()` produces. */
  function shapesOf(text: string): string[] {
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\S+\s/, "").replace(/active=\d+/g, "active=<N>"));
  }

  it("boot-kick busy -> reactive message queued -> re-fire (no salience feedback since 2e39a3f): exact line shapes", async () => {
    const rig = makeControllableRig();
    const child = spawnDaemon(rig);
    await poll(() => fs.existsSync(path.join(rig.runDir, "sub_map")));

    // Simulate `thinkers start echo`'s boot kick: a manual-trigger pending file.
    fs.mkdirSync(path.join(rig.runDir, "pending"), { recursive: true });
    fs.writeFileSync(
      path.join(rig.runDir, "pending", `echo.manual-trigger.${Math.floor(Date.now() / 1000)}.000001`),
      JSON.stringify({ type: "manual-trigger", source: "thinkers-cli", ts: new Date().toISOString() })
    );

    // Wait for the dispatcher's first tick to fire it and the step to report in.
    await poll(() => fs.existsSync(rig.startedFile));
    await poll(() => readOr(path.join(rig.runDir, "logs", "dispatcher.log")).includes("fire pending -> echo"));

    // Echo is now busy (blocked on releaseFile) — an inbound chat message
    // must queue, not dispatch (and, since 2e39a3f, append no feedback step).
    appendStep(rig.trajFile, { type: "message", content: "hi", from: "operator", to: "pax", source: "chat" }, {});
    await poll(() => readOr(path.join(rig.runDir, "logs", "dispatcher.log")).includes("pending -> echo (type=message, queued=1)"));

    // Release the first (manual-trigger) step and wait for the queued message to fire.
    fs.writeFileSync(rig.releaseFile, "x");
    await poll(() => readOr(path.join(rig.runDir, "logs", "dispatcher.log")).includes("fire pending -> echo (type=message"));
    // Let the second (message) step run to completion too, so step_pids settles.
    await poll(() => readOr(path.join(rig.runDir, "step_pids")).trim() === "", 4000);

    const shapes = shapesOf(readOr(path.join(rig.runDir, "logs", "dispatcher.log")));
    expect(shapes).toEqual([
      "[dispatcher]   fire pending -> echo (type=manual-trigger, active=<N>)",
      "[dispatcher] step: type=message source=chat",
      "[dispatcher]   pending -> echo (type=message, queued=1)",
      "[dispatcher]   fire pending -> echo (type=message, active=<N>)",
    ]);
  });
});
