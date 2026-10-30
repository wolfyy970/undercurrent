#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/llm.mjs — the `llm` tool the model's bash invokes inside the sandbox
// (and `mem search` pipes its corpus into). Thin process wiring around
// src/llmCli.ts; the sandbox execs it exactly like the original Bash `llm`.
// `bin/llm` is a symlink to this file (as bin/mem is), so `llm …` resolves on
// PATH with no Bash anywhere.
//
// Node 22.18+ strips TS types on the fly, so this .mjs imports the .ts module
// with no build step — the same "shim runs from source" property bin/mem.mjs
// relies on.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { runLlm } from "../src/llmCli.ts";
import { readStdinSync } from "../src/stdin.ts";
import { spawnAdapterProcess } from "../src/llmAdapterProcess.ts";

// A reader that closes the pipe early (`llm … | head -1`) must not produce a
// Node stack trace; bash's printf would simply have died on SIGPIPE.
process.stdout.on("error", (e) => {
  if (e && e.code === "EPIPE") process.exit(141);
});

const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: readStdinSync,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  now: () => new Date(),
  fetch: globalThis.fetch,
  fs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  spawnAdapter: spawnAdapterProcess,
  randomToken: () => crypto.randomBytes(6).toString("hex"),
};

const code = await runLlm(process.argv.slice(2), io);
process.exitCode = code;
// Pipes are asynchronous on macOS: let stdout/stderr drain before exiting so
// a streamed answer is never truncated by process.exit.
await new Promise((r) => process.stdout.write("", () => r()));
await new Promise((r) => process.stderr.write("", () => r()));
process.exit(code); // under Bun, src/stdioSync.ts has already put every byte in the pipe
