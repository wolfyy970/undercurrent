#!/usr/bin/env bun
// bin/context.mjs — the `context` tool the model's bash invokes inside the
// sandbox (SPEC §1.4). Thin process wiring around src/context.ts `runContext`;
// the sandbox execs it exactly like the original Bash `context`.
//
// Node strips the TS types from ../src/context.ts on import (no build step),
// the same "shim runs from source" property bin/mem.mjs and bin/traj.mjs rely
// on. NO Bash: this is the Node executable that replaces the legacy Bash tool.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { runContext } from "../src/context.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

const io = {
  cwd: process.cwd(),
  env: process.env,
  // process.stdout.write accepts a string or a Buffer/Uint8Array, so the
  // --max-bytes byte-truncation path (which hands us raw bytes) works verbatim.
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

await exitAfterDrain(runContext(process.argv.slice(2), io));
