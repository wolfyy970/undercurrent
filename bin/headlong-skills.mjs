#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/headlong-skills.mjs — the skills package manager the operator invokes
// directly, and the target `bin/skills.mjs` forwards to for search/install/
// remove/check/init/promote/kernel/remote (SPEC §5, PORT-NOTE 1c: 8c3f410).
// Thin wrapper over src/headlong-skills.ts `cli()`: it wires process argv,
// env, cwd, stdio, and TTY/NO_COLOR detection, then exits with the returned
// code — the same shape as bin/skills.mjs, since `skills` forwards its whole
// original argv here verbatim.
//
// Node 24 strips the TypeScript types from ../src/headlong-skills.ts at
// import time, so this runs with no build step — exactly like bin/skills.mjs
// importing src/skills.ts.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { cli } from "../src/headlong-skills.ts";
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
