#!/usr/bin/env bun
// bin/chat.mjs — the `chat` tool the model's bash invokes inside the sandbox
// (SPEC §5). Thin process wiring around src/chat.ts; the sandbox execs it exactly
// like the original Bash `chat` (send/reply/send-file/history/repl).
//
// Node strips TS types on the fly, so this .mjs imports the .ts module with no
// build step — the same "shim runs from source" property bin/traj.mjs relies on
// (which imports ../src/trajCore.mjs). binDir always points at this source bin/.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runChat } from "../src/chat.ts";
import { readStdinSync } from "../src/stdin.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

/** `command -v <name>` for an external executable: scan PATH for an X_OK file. */
function hasCommand(name) {
  const p = process.env.PATH || "";
  for (const dir of p.split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* not here — keep scanning */
    }
  }
  return false;
}

/** Run an external binary with inherited stdio; return its exit code (127 if not found). */
function execInherit(name, args) {
  const res = spawnSync(name, args, { stdio: "inherit" });
  if (res.error) {
    // Mirror `exec <bin>` failing when the binary is absent (rc 127).
    if (res.error.code === "ENOENT") {
      process.stderr.write(`chat: ${name}: command not found\n`);
      return 127;
    }
    process.stderr.write(`chat: ${name}: ${res.error.message}\n`);
    return 127;
  }
  if (typeof res.status === "number") return res.status;
  return 1;
}

const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: readStdinSync,
  isStdinTTY: Boolean(process.stdin.isTTY),
  hasCommand,
  execInherit,
};

await exitAfterDrain(runChat(process.argv.slice(2), io));
