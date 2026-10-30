// daemonReady.ts — wait until a spawned bin/dispatcherd.mjs is TAILING its trajectories, not just booted.
//
// The daemon publishes sub_map/traj_files before its feeders start, and a feeder that starts with no cursor starts
// at end of file, so a step appended in that window is never delivered. Upstream has the same window (bin/thinkers
// writes sub_map at :433 and spawns `tail -n 0 -F` in the background at :566; its own tests `sleep 2` after start),
// see PARITY.md "Start-up window". sub_map therefore means "booted", not "listening".
//
// The condition used here: the dispatcher's first housekeeping tick. setInterval is armed only after every feeder
// has started, and each tick rewrites step_pids atomically (a fresh inode). Boot writes it once; a second distinct
// inode is a tick's write, so the feeders are live by then.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

export async function feedersLive(runDir: string, child?: ChildProcess, timeoutMs = 25000): Promise<void> {
  const seen = new Set<number>();
  const file = path.join(runDir, "step_pids");
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try {
      seen.add(fs.statSync(file).ino);
    } catch {
      /* not written yet */
    }
    if (seen.size >= 2) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`dispatcherd exited during start-up (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`dispatcherd feeders not live after ${timeoutMs}ms (no housekeeping tick seen)`);
}
