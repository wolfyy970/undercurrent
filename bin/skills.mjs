#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/skills.mjs — the `skills` tool the model's bash invokes inside the sandbox
// (SPEC §5). Thin wrapper over src/skills.ts `cli()`: it wires process argv,
// env, cwd, stdio, and TTY/NO_COLOR detection, then exits with the returned code.
//
// Node 24 strips the TypeScript types from ../src/skills.ts at import time, so
// this runs with no build step — exactly like bin/traj.mjs importing the plain
// trajCore.mjs. One source of truth (src/skills.ts) drives both the engine and
// this shim, so the CLI and the engine-facing API can never drift.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { cli } from "../src/skills.ts";
import { readStdinSync } from "../src/stdin.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

// Read piped stdin (for `init`/`remove` prompts) only when it isn't a TTY.
let stdin;
if (!process.stdin.isTTY) {
  stdin = readStdinSync();
}

const ctx = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: !!process.stdout.isTTY,
  ...(stdin !== undefined ? { stdin } : {}),
};

await exitAfterDrain(cli(process.argv.slice(2), ctx));
