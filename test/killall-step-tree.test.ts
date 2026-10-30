// killall-step-tree.test.ts — RUNTIME-SEAMS.md §C row "killall self-protection"
// (§D priority, tools/headlong-killall:58-65 self+ancestor protection): proves
// that running killall from INSIDE a real fake step process tree protects the
// caller's own ancestry while a SIBLING (non-ancestor) `shellm-*`-shaped decoy
// is actually killed — for both dry-run and a REAL kill.
//
// SAFETY (same discipline as test/killall.test.ts's file header, which this
// test follows exactly): killall's self+ancestor walk (`protectedPids` in
// src/killall.ts) always uses a REAL, read-only `ps -o ppid= -p <pid>` query
// on the process that calls it — that part can never be faked, so to prove
// "an ancestor of the CALLER survives", the caller itself must be a real OS
// child of a real fake dispatcher/step tree. But killall's TARGET matching
// (which pids are candidates to kill) is fully injectable via `psSnapshot`,
// and every kill in this file is scoped to just the decoy pids spawned here
// (dispatcher D, step S, sibling SIB) — never the real, unrestricted
// system-wide `ps`/`docker ps` a bare `bin/headlong-killall.mjs` invocation
// would use. This is deliberate: this port's own killall.test.ts documents a
// real past incident from an unrestricted real (non-dry-run) sweep on a
// shared dev box, and this task's own rules say "kill only processes you
// started." So the process that calls `killall()` here is a small generated
// script (not the raw bin/ CLI, which offers no fixture injection) that
// imports src/killall.ts directly with a scoped psSnapshot, while still being
// a genuine child of a genuine dispatcher/step decoy tree — real signals,
// real process tree, real self-protection code path, zero system-wide risk.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pidAlive } from "../src/runstate.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KILLALL_TS = path.join(HERE, "..", "src", "killall.ts");

const dirs: string[] = [];
const rootPidsToReap: number[] = [];

afterEach(() => {
  for (const pid of rootPidsToReap) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rootPidsToReap.length = 0;
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "killall-tree-"));
  dirs.push(d);
  return d;
}

/** Idle decoy matched by killall's `bin/chat.mjs` pattern — the sibling that
 *  is NOT an ancestor of the caller and must actually get killed. */
function spawnSibling(dir: string): number {
  const scriptPath = path.join(dir, "bin", "chat.mjs");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  if (typeof child.pid !== "number") throw new Error("failed to spawn sibling decoy");
  return child.pid;
}

async function poll(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!pred()) throw new Error("poll timeout");
}

interface RunnerResult {
  selfPid: number;
  parentPid: number; // the step decoy's pid
  dryOut: string;
  dryErr: string;
  dryResult: { killed: { pid: number; command: string }[] };
  realOut: string;
  realErr: string;
  realResult: { killed: { pid: number; command: string }[] };
}

describe("killall self-protection — real fake step process tree, real sibling kill (dry-run + real)", () => {
  it("caller's own dispatcher+step ancestry survives a real kill; a sibling shellm-* decoy dies", async () => {
    const dir = makeDir();
    const sibPid = spawnSibling(dir);

    const resultFile = path.join(dir, "result.json");
    const runnerPath = path.join(dir, "runner.mjs");
    const stepPath = path.join(dir, "thinkers", "echo", "step");
    const dispatcherPath = path.join(dir, "bin", "dispatcherd.mjs");
    fs.mkdirSync(path.dirname(stepPath), { recursive: true });
    fs.mkdirSync(path.dirname(dispatcherPath), { recursive: true });

    // The runner: a real child of the step decoy, which is a real child of
    // the dispatcher decoy. Calls killall() DIRECTLY (not the bin/ CLI) with
    // a psSnapshot scoped to [dispatcherPid, sibPid] — S and the runner
    // itself get swept in as dispatcherPid's real descendants by the same
    // fixed-point expansion test/killall.test.ts's scopedSnapshot uses.
    fs.writeFileSync(
      runnerPath,
      [
        `import { killall } from ${JSON.stringify(KILLALL_TS)};`,
        `import { execSync } from "node:child_process";`,
        `import * as fs from "node:fs";`,
        `const resultFile = process.argv[2];`,
        `const rootPids = JSON.parse(process.argv[3]);`,
        `function scopedSnapshot(pids) {`,
        `  return () => {`,
        `    const out = execSync("ps -axo pid=,ppid=,command=").toString();`,
        `    const full = [];`,
        `    for (const line of out.split("\\n")) {`,
        `      const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(line);`,
        `      if (m) full.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });`,
        `    }`,
        `    const allowed = new Set(pids);`,
        `    let changed = true;`,
        `    while (changed) {`,
        `      changed = false;`,
        `      for (const p of full) {`,
        `        if (allowed.has(p.ppid) && !allowed.has(p.pid)) { allowed.add(p.pid); changed = true; }`,
        `      }`,
        `    }`,
        `    return full.filter((p) => allowed.has(p.pid));`,
        `  };`,
        `}`,
        `const noDocker = () => ({ shellmIds: [], shellmLines: [], brokerLines: [] });`,
        `let dryOut = "", dryErr = "";`,
        `const dryResult = await killall({ dryRun: true, psSnapshot: scopedSnapshot(rootPids), dockerListing: noDocker, stdout: (s) => { dryOut += s; }, stderr: (s) => { dryErr += s; } });`,
        `let realOut = "", realErr = "";`,
        `const realResult = await killall({ dryRun: false, psSnapshot: scopedSnapshot(rootPids), dockerListing: noDocker, stdout: (s) => { realOut += s; }, stderr: (s) => { realErr += s; } });`,
        `fs.writeFileSync(resultFile, JSON.stringify({ selfPid: process.pid, parentPid: process.ppid, dryOut, dryErr, dryResult, realOut, realErr, realResult }));`,
        "",
      ].join("\n")
    );

    // Step decoy: real child of the dispatcher decoy, spawns the runner as
    // its own child, forwarding the dispatcher's pid (passed to it below)
    // plus the sibling's pid so the runner can build rootPids = [D, SIB].
    fs.writeFileSync(
      stepPath,
      [
        `import { spawn } from "node:child_process";`,
        `const dPid = Number(process.argv[2]);`,
        `const rootPids = JSON.stringify([dPid, ${sibPid}]);`,
        `const c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(runnerPath)}, ${JSON.stringify(resultFile)}, rootPids], { stdio: "ignore" });`,
        `process.on("exit", () => { try { c.kill("SIGKILL"); } catch {} });`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n")
    );

    // Dispatcher decoy: the root of the fake ancestry, spawns the step
    // decoy as its child, passing its own real pid down.
    fs.writeFileSync(
      dispatcherPath,
      [
        `import { spawn } from "node:child_process";`,
        `const c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(stepPath)}, String(process.pid)], { stdio: "ignore" });`,
        `process.on("exit", () => { try { c.kill("SIGKILL"); } catch {} });`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n")
    );

    const dChild = spawn(process.execPath, [dispatcherPath], { detached: true, stdio: "ignore" });
    dChild.unref();
    if (typeof dChild.pid !== "number") throw new Error("failed to spawn dispatcher decoy");
    const dPid = dChild.pid;
    rootPidsToReap.push(dPid, sibPid);

    await poll(() => fs.existsSync(resultFile));
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RunnerResult;
    const sPid = result.parentPid;
    // A signal-killed process's `process.on("exit", …)` cascade-cleanup
    // handler never runs (SIGKILL/SIGTERM with no listener bypasses JS
    // entirely) — reap the step decoy directly too, don't rely on it.
    rootPidsToReap.push(sPid);

    // Dry-run: reports the sibling as a would-kill candidate, warns about
    // (and never lists as a target) both real ancestors, kills nothing.
    expect(result.dryResult.killed).toEqual([]);
    expect(result.dryOut).toContain("Would kill 1 process(es):");
    expect(result.dryOut).toContain(String(sibPid));
    expect(result.dryErr).toContain(`warning: skipping PID ${dPid} (ancestor of this process`);
    expect(result.dryErr).toContain(`warning: skipping PID ${sPid} (ancestor of this process`);

    // Real kill: exactly the sibling dies; both real ancestors are matched
    // by pattern but protected and skipped, same warnings as dry-run.
    expect(result.realResult.killed).toEqual([{ pid: sibPid, command: expect.stringContaining("bin/chat.mjs") }]);
    expect(result.realErr).toContain(`warning: skipping PID ${dPid} (ancestor of this process`);
    expect(result.realErr).toContain(`warning: skipping PID ${sPid} (ancestor of this process`);

    await poll(() => !pidAlive(sibPid));
    expect(pidAlive(dPid)).toBe(true); // dispatcher ancestor survives
    expect(pidAlive(sPid)).toBe(true); // step ancestor survives
  }, 15000);
});
