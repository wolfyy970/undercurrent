#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/recap.mjs — the `recap` tool (trajectory summarizer + --context
// staircase). Thin process wiring around src/recap.ts; invoked exactly like
// the original Bash `recap`. `bin/recap` is a symlink to this file (as
// bin/mem and bin/llm are), so `recap …` resolves on PATH with no Bash
// anywhere.
//
// Node 24 strips TS types on the fly, so this .mjs imports the .ts module
// with no build step — the same "shim runs from source" property bin/mem.mjs
// and bin/llm.mjs rely on.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { spawnSync } from "node:child_process";
import { runRecap } from "../src/recap.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  now: () => new Date(),
  // `_llm_json`: printf '%s' "$user" | llm -m M -t N -s SYSTEM 2>"$errf" —
  // stdout is captured (command substitution) and so is stderr (2e39a3f,
  // c32d5b0): recap copies it to its own stderr and looks for `refused:` in it.
  runLlm: (args, stdinText) => {
    const res = spawnSync("llm", args, {
      input: stdinText,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      // PORT-NOTE (fix, not a deviation): Node's spawnSync default maxBuffer is
      // 1 MiB. Real Bash's `$(printf … | llm …)` has no such limit and
      // captures a huge reply fine on attempt 1 (it later dies re-passing the
      // body to jq as a --argjson *argv* — an OS ARG_MAX crash, exit 126 — a
      // separate, undocumented deviation; see PARITY.md). Without this, a
      // >1MiB reply made spawnSync fail with ENOBUFS, which runLlm's
      // res.error branch mistook for "llm missing from PATH" and returned a
      // discardable empty reply — llmJson() then silently retried and could
      // succeed on a smaller follow-up reply, masking the huge one entirely
      // (exit 0) where Bash hard-fails (exit 126). No limit here lets the
      // port at least SEE the reply it was given.
      maxBuffer: Infinity,
    });
    if (res.error) {
      // Mirror a failed `| llm …` pipeline (e.g. binary not on PATH): the
      // command substitution captures nothing, `|| raw=""` swallows it.
      process.stderr.write(`recap: error: llm: ${res.error.message}\n`);
      return { status: 127, stdout: "" };
    }
    return {
      status: typeof res.status === "number" ? res.status : 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  },
};

await exitAfterDrain(runRecap(process.argv.slice(2), io));
