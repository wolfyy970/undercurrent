#!/usr/bin/env bun
// bin/thinkers-drain.mjs — detached drain-then-finish reaper for `thinkers
// stop`'s drain path (mirrors bin/thinkers's `_drain_then_finish` /
// `_drain_all_then_finish`, bin/thinkers:1250-1276 — a `(...) </dev/null
// >/dev/null 2>&1 & disown` background subshell: a genuinely separate OS
// process the parent shell doesn't wait on).
//
// PORT-NOTE: src/thinkersctl.ts's `drainThenFinish` used to do this wait as
// an un-awaited in-process `setTimeout` loop. That is enough to let a
// direct library caller (a test, the long-lived web server) get its
// `Promise` back immediately, but NOT enough to let the standalone
// `thinkers stop` CLI process (bin/thinkers.mjs) exit immediately the way
// bash's backgrounded subshell does: Node's event loop — and therefore the
// whole process — stays alive for as long as a pending `setTimeout` exists,
// so the CLI process would hang until the drain finished, silently
// defeating "stop returns immediately" (confirmed via
// tests/test_thinkers_drain.sh, which times the CLI invocation itself).
// `drainThenFinish` now spawns THIS script detached + unref'd (the same
// technique `thinkersStart` already uses for the dispatcher itself), so the
// parent process — CLI or long-lived server — never waits on it.
//
// Payload: one JSON object read from stdin —
//   { pids: number[], timeoutS: number, stopTargets: {dir:string}[],
//     cwd: string, env: Record<string,string>, runDir?: string }
// Best-effort throughout, matching upstream's `|| true` on the stop script
// and the reaper's own silent redirection to /dev/null.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pidAlive, killTree, rmQuiet } from "../src/runstate.ts";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const { pids, timeoutS, stopTargets, cwd, env, runDir } = JSON.parse(raw);

  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline && pids.some((p) => pidAlive(p))) {
    await sleep(250);
  }
  for (const p of pids) if (pidAlive(p)) killTree(p, "SIGTERM");
  await sleep(1000);
  for (const p of pids) if (pidAlive(p)) killTree(p, "SIGKILL");

  for (const t of stopTargets) {
    const stopFile = path.join(t.dir, "stop");
    try {
      spawnSync(stopFile, [], { cwd, env, stdio: "ignore" });
    } catch {
      /* matches `|| true` */
    }
  }

  if (runDir) rmQuiet(path.join(runDir, "step_pids"));
}

await main();
