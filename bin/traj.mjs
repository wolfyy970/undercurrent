#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/traj.mjs — the `traj` tool the model's bash invokes inside the sandbox.
//
// Thin process wiring around src/trajCli.ts, which reuses src/trajCore.mjs's
// PROVEN write path (appendStep/readSteps: run_id auto-stamping from
// $SHELLM_RUN_STEP_ID, step_id/ts, blob spill — SPEC §2.4) for `append`/
// `last`, and implements the full read/list/search/format CLI (`new`,
// `fork`, `merge`, `show`, `tail`, `search`, `count`, `cat`, `exists`,
// `path`, `list`, `root`, `check`) faithfully against headlong/bin/traj.
//
// Node 24 strips TS types on the fly, so this .mjs imports the .ts module
// with no build step — the same "shim runs from source" property bin/mem.mjs
// relies on. binDir always points at this source bin/, never dist/.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { runTraj } from "../src/trajCli.ts";
import { readStdinSync } from "../src/stdin.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

let stopFollowing = false;
process.on("SIGINT", () => {
  stopFollowing = true;
});
process.on("SIGTERM", () => {
  stopFollowing = true;
});

const io = {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: readStdinSync,
  isTTY: Boolean(process.stdout.isTTY),
  sleepMs: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  shouldStop: () => stopFollowing,
};

await exitAfterDrain(runTraj(process.argv.slice(2), io));
