#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/headlong-telegram-bridge.mjs — Telegram Bot API bridge for a Headlong
// identity. Thin process wiring around src/telegram/cli.ts; named to match
// upstream's binary (headlong/tools/headlong-telegram-bridge / the uv
// project's console-script entry point of the same name).
//
// Node strips TS types on the fly, so this .mjs imports the .ts module with
// no build step — same pattern as bin/chat.mjs / bin/headlong-killall.mjs.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { runCli } from "../src/telegram/cli.ts";

let stopped = false;
const shouldStop = () => stopped;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopped = true;
  });
}

const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

process.exitCode = await runCli(process.argv.slice(2), io, { shouldStop });
