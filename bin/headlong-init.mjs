#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/headlong-init.mjs — the `headlong-init` tool (tools/headlong-init
// ported). Thin process wiring around src/init.ts; `bin/headlong-init` is a
// symlink to this file, same convention as bin/identity, bin/llm, ...
//
// Node 22.18+ strips TS types on the fly, so this .mjs imports the .ts
// module with no build step.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { runHeadlongInit, realInitIO } from "../src/init.ts";

const env = { ...process.env };
const code = await runHeadlongInit({ argv: process.argv.slice(2), env, io: realInitIO() });
process.exitCode = code;
