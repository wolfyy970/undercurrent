#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/mem.mjs — the `mem` tool the model's bash invokes inside the sandbox
// (SPEC §5). Thin process wiring around src/mem.ts; the sandbox execs it exactly
// like the original Bash `mem`.
//
// Node 24 strips TS types on the fly, so this .mjs imports the .ts module with
// no build step — the same "shim runs from source" property bin/traj.mjs relies
// on (which imports ../src/trajCore.mjs). binDir always points at this source
// bin/ (scripts/real-wake.ts, characterization.test.ts), never at dist/.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { runMem, searchSupervisorPlan } from "../src/mem.ts";
import { readStdinSync } from "../src/stdin.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";
import { runtimePath } from "../src/runtime.ts";

// PORT-NOTE (1c: 69fddc6): Bash's heartbeat backgrounds a `while :; do sleep
// "$hb"; printf …; done` subshell alongside the (foreground, blocking) `llm`
// pipeline, then kills it once `llm` returns. `runLlm` here is synchronous
// (spawnSync) so the SAME technique — a real, independent OS process, not a
// JS timer that would never get a turn while spawnSync blocks the one JS
// thread — reproduces it: a second Node process loops the heartbeat on its
// OWN event loop, writing straight to the inherited stderr fd, while this
// process blocks in spawnSync; killed the moment `llm` exits.
const HEARTBEAT_SCRIPT =
  "const p = process.ppid;" +
  // PORT-NOTE (sync 2e39a3f, 30f8bbe/b7d4e8d): the Bash heartbeat loop dies when
  // the search process does (`kill -0 $search_pid`). Same here: if the parent
  // is gone (public TERM/INT kills it), exit instead of heartbeating forever.
  " setInterval(() => { if (process.ppid !== p) process.exit(0); }, 100);" +
  " setInterval(() => process.stderr.write('mem search: waiting for the model...\\n')," +
  " Number(process.env.MEM_HEARTBEAT_MS))";

// PORT-NOTE (sync 2e39a3f, 2a63d92 + 30f8bbe + 0039e69): the Bash `action_search`
// runs the whole search in a WORKER in its own process group (`set -m`),
// bounds it with a sibling watchdog (`kill -KILL -- -$worker` after
// MEM_SEARCH_TIMEOUT_S, rc 124 + one stderr line) and traps TERM/INT on the
// public PID to kill that group (exit 143/130), so a wedged or TERM-ignoring
// model — and anything it spawned — can never outlive the search and hold the
// caller's pipes open. spawnSync blocks the JS thread, so no timer or signal
// handler could run in the process doing the model call. The port therefore
// does exactly what the Bash does: for `mem search <query>` this file first
// runs as a SUPERVISOR (public PID; owns the deadline, the signal traps and
// the group kill) around a WORKER (this same file, MEM_SEARCH_WORKER=1, a
// process-group leader; the model call and the heartbeat live in its group).
// The shared group is the analogue of upstream's _LLM_SHARED_PROCESS_GROUP=1.
if (process.env.MEM_SEARCH_WORKER !== "1") {
  const plan = searchSupervisorPlan(process.argv.slice(2), process.env, process.cwd());
  if (plan) {
    const worker = spawn(runtimePath(), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, MEM_SEARCH_WORKER: "1" },
    });
    const killGroup = () => {
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    };
    // Like the Bash: a PRIVATE 0700 marker directory (mkdtemp — a predictable name in shared /tmp
    // could follow an attacker's symlink) holds the "deadline fired" mark, removed on every exit.
    let boundDir;
    if (plan.timeoutS > 0) {
      boundDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "mem-search-bound."));
    }
    const removeBound = () => {
      if (boundDir) fs.rmSync(boundDir, { recursive: true, force: true });
    };
    let deadline = false;
    const timer =
      plan.timeoutS > 0
        ? setTimeout(() => {
            deadline = true;
            fs.writeFileSync(path.join(boundDir, "deadline"), "");
            killGroup();
          }, plan.timeoutS * 1000)
        : undefined;
    const cancel = (rc) => () => {
      killGroup();
      removeBound();
      process.exit(rc);
    };
    process.on("SIGTERM", cancel(143));
    process.on("SIGINT", cancel(130));
    worker.on("error", (e) => {
      removeBound();
      process.stderr.write(`mem: error: ${e.message}\n`);
      process.exit(1);
    });
    worker.on("close", (code, sig) => {
      clearTimeout(timer);
      // The leader can exit while group members survive: stopping must not skip them.
      killGroup();
      let rc = typeof code === "number" ? code : 128 + (osConstants.signals[sig] ?? 1);
      removeBound();
      if (deadline && rc !== 0) {
        rc = 124;
        process.stderr.write(
          `mem search: no reply from the model within ${plan.timeoutS}s (MEM_SEARCH_TIMEOUT_S); giving up on this query.\n`
        );
      }
      process.exit(rc);
    });
    await new Promise(() => {}); // the handlers above own the exit
  }
}

const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: readStdinSync,
  isTTY: Boolean(process.stdout.isTTY),
  now: () => new Date(),
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  runLlm: (args, stdinText, heartbeatSeconds, timeoutSeconds = "0") => {
    // Bash: `[[ "$hb" != 0 ]]` — a literal STRING compare, not numeric ("00"
    // would still heartbeat). A non-numeric/non-positive value silently
    // disables the heartbeat here (PORT-NOTE: Bash's `sleep` would instead
    // error every loop iteration; not reproduced — no real caller sets a
    // malformed MEM_SEARCH_HEARTBEAT_S, see PARITY.md).
    let hbChild;
    if (heartbeatSeconds !== "0") {
      const seconds = Number(heartbeatSeconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        hbChild = spawn(runtimePath(), ["-e", HEARTBEAT_SCRIPT], {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, MEM_HEARTBEAT_MS: String(seconds * 1000) },
        });
      }
    }
    // The deadline and group cancellation belong to the supervisor above; this
    // worker just makes the (blocking) model call, in the worker's group.
    const res = spawnSync("llm", args, {
      input: stdinText,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
      // Keep the real llm adapter in our worker group (upstream's private opt-in), so cancelling
      // the search — public TERM/INT, the outer deadline — reaches it.
      env: { ...process.env, _LLM_SHARED_PROCESS_GROUP: "1" },
    });
    if (hbChild) hbChild.kill();
    if (res.error) {
      // Mirror a failed `| llm …` pipeline (e.g. binary not on PATH).
      process.stderr.write(`mem: error: llm: ${res.error.message}\n`);
      return 127;
    }
    return typeof res.status === "number" ? res.status : 1;
  },
};

await exitAfterDrain(runMem(process.argv.slice(2), io));
