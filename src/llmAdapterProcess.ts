// llmAdapterProcess.ts — the real (non-test-double) implementation of
// LlmIO.spawnAdapter for the `llm --provider adapter` exec path
// (design/providers.md, bin/llm's adapter branch). Wraps node:child_process
// with a POSIX process group (spawn `detached: true`) so the deadline
// watcher in llmCli.ts can signal the adapter's WHOLE subtree, not just the
// leader — mirroring bash's `kill -- -$pid` / `kill -9 -- -$pid`, which is
// how the real tool keeps a child that ignores TERM from holding a
// `$(...)` caller's stdout open past LLM_MAX_TIME.
//
// Kept out of llmCli.ts on purpose: that module has no node:child_process
// import anywhere, so it stays strip-safe and fully testable against fake
// IO. bin/llm.mjs wires this real spawner in; tests may use it too (against
// small real Node fixture scripts) or inject a fake LlmSpawnHandle.

import { execFileSync, spawn } from "node:child_process";
import type { LlmSpawnHandle } from "./llmCli.ts";

export function spawnAdapterProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; sharedGroup?: boolean; deadline?: boolean }
): LlmSpawnHandle {
  // PORT-NOTE (sync 2e39a3f, 2a63d92): `_LLM_SHARED_PROCESS_GROUP=1` — the caller (mem search's
  // worker) owns and can kill this process's whole group, so the adapter must NOT escape it into a
  // group of its own. `killGroup` then targets OUR group, read the way bin/llm reads it
  // (`ps -o pgid= -p $$`, must be a number > 1).
  let sharedPgid = -1;
  if (opts.sharedGroup && opts.deadline && process.platform !== "win32") {
    let raw = "";
    try {
      raw = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
    } catch {
      throw new Error("Cannot read adapter process group");
    }
    raw = raw.replace(/\s+/g, "");
    if (!/^[0-9]+$/.test(raw) || Number(raw) <= 1) throw new Error("Invalid adapter process group");
    sharedPgid = Number(raw);
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    // A new process group on POSIX (pgid = child pid) so killGroup can reach
    // everything the adapter spawned, not only the adapter itself. Windows
    // has no process-group signal semantics; killGroup falls back to the pid.
    detached: process.platform !== "win32" && !opts.sharedGroup,
  });
  // A adapter that never reads stdin (or exits before doing so) must not
  // crash the parent with an unhandled EPIPE.
  child.stdin.on("error", () => {
    /* best-effort write */
  });
  return {
    pid: child.pid ?? -1,
    writeStdin: (data) => {
      try {
        child.stdin.write(data);
      } catch {
        /* best-effort */
      }
    },
    endStdin: () => {
      try {
        child.stdin.end();
      } catch {
        /* best-effort */
      }
    },
    onStdout: (cb) => child.stdout.on("data", (d: Buffer) => cb(d.toString("utf8"))),
    onStderr: (cb) => child.stderr.on("data", (d: Buffer) => cb(d.toString("utf8"))),
    wait: () => new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal }))),
    // NOT gated on the LEADER's own exit: a TERM-trapping leader can exit
    // (`trap 'exit 0' TERM`) well before an orphaned grandchild that ignores
    // TERM does — the grace period's follow-up SIGKILL must still reach the
    // group. process.kill throws (ESRCH) harmlessly once truly nothing is
    // left; that's the only "stop trying" signal this needs.
    killGroup: (signal) => {
      if (sharedPgid > 0) {
        try {
          process.kill(-sharedPgid, signal);
        } catch {
          /* ESRCH */
        }
        return;
      }
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        /* ESRCH: already gone */
      }
    },
    groupAlive: () => {
      if (child.pid === undefined) return false;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
        return true;
      } catch {
        return false; // ESRCH: no process left in the group
      }
    },
  };
}
