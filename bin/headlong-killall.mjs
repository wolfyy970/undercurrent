#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/headlong-killall.mjs — panic button management CLI. Named to match
// upstream's binary name (headlong/tools/headlong-killall), which is how the
// web control layer invokes it (control.py: TOOLS_DIR / "headlong-killall").
// Thin process wiring around src/killall.ts.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { runKillall } from "../src/killall.ts";

const io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

process.exitCode = await runKillall(process.argv.slice(2), io);
