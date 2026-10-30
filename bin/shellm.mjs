#!/usr/bin/env bun
// bin/shellm.mjs — the `shellm` command the model's bash invokes (the system prompt tells it to use `shellm` for
// nested runs). Thin process wiring around src/shellmCli.ts; upstream's bin/shellm is the same command.
import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runShellmCli } from "../src/shellmCli.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

const io = {
  env: process.env,
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: () => {
    if (process.stdin.isTTY) return undefined;
    try {
      return fs.readFileSync(0, "utf8");
    } catch {
      return undefined;
    }
  },
  binDir: path.dirname(fileURLToPath(import.meta.url)),
};

await exitAfterDrain(await runShellmCli(process.argv.slice(2), io));
