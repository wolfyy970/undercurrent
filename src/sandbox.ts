// sandbox.ts — execute model-written bash (SPEC §1.1 env, §1.3 execute_code).
//
// SANDBOX CHOICE: a restricted local subprocess, NOT Docker.
//   Reason (per the rulebook's allowance): real Headlong runs the block in a
//   Docker container (bin/shellm:445-1138) and that is the eventual target for
//   this port. But standing up Docker balloons the slice AND makes `pnpm test`
//   depend on a running daemon + an image pull. SPEC §1.1 explicitly says the
//   port MUST reproduce the `env` metadata field but MAY run code locally; the
//   Docker machinery is orthogonal to the cognition model this slice proves.
//   So we run `bash -e -c` in a subprocess with: a dedicated workdir (cwd),
//   stdin = /dev/null, a whitelisted env, a restricted PATH (the tool-shim dir
//   ahead of the system bins), and an inactivity watchdog (see below). This is
//   NEVER an unsandboxed host exec of arbitrary model bash on the user's PATH
//   — the PATH and cwd are constrained and stdin is closed.
//
// The Docker target remains a drop-in: swap this LocalSandbox for a
// DockerSandbox implementing the same interface (SPEC §1.1 marks env.type).
//
// INACTIVITY WATCHDOG (bug #33): upstream's `execute_code … >>output_file 2>&1
// &` plus a sibling watchdog subshell that polls `output_file`'s byte size
// (bin/shellm:2618-2690) never kills a command that is still producing
// output. It kills on genuine SILENCE: `stale_seconds` (idle, default
// SHELLM_INACTIVITY_TIMEOUT=30s) resets on ANY new output byte OR a touch of
// the activity beacon file; `quiet_seconds` (the hard ceiling, default
// SHELLM_INACTIVITY_MAX=900s) resets ONLY on real output bytes — a beacon
// touch alone never resets it, so a live-but-silent nested run still dies at
// the ceiling. `execWithInactivityWatchdog` below reproduces exactly that
// two-timer algorithm as a real async `spawn()`-driven watchdog (Node gives
// us live `data` events instead of upstream's `wc -c` poll, but the same
// "read the child's growing output, compare to last tick" shape). Shared by
// both LocalSandbox (this file) and DockerSandbox (src/sandbox-docker.ts) so
// the two stay in lockstep — see that file's header for why the poll happens
// on the HOST in both cases (upstream's watchdog subshell is host-side too,
// even for the docker branch, since `execute_code … &` redirects docker
// exec's own stdout+stderr to a host file regardless of sandbox kind).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ExecRequest {
  workdir: string;
  /** The already-wrapped code (set -x … set +x … FINAL capture … exit). */
  wrappedCode: string;
  /** Extra env exported into the executed code (PATH, TRAJ_*, run id, …). */
  env: Record<string, string>;
  /** Hard ceiling in ms (SHELLM_INACTIVITY_MAX analogue, bin/shellm:2656) —
   *  kills once `quietMs` (silence since the last REAL output byte) reaches
   *  this, regardless of activity-beacon touches. Default 900_000. */
  timeoutMs?: number;
  /** Idle ceiling in ms (SHELLM_INACTIVITY_TIMEOUT analogue, bin/shellm:2653)
   *  — kills once `staleMs` (silence since the last output byte OR beacon
   *  touch) reaches this. Default 30_000. */
  inactivityTimeoutMs?: number;
  /** Host path the exec'd code may touch to signal liveness without emitting
   *  real output — upstream's SHELLM_ACTIVITY_FILE / start_activity_beacon
   *  (bin/shellm:389-413, :2579). Resets the IDLE clock only, never the
   *  ceiling — bin/shellm:2648-2651's `stale_seconds=0` on a changed beacon,
   *  with no matching reset of `quiet_seconds`. Optional: if the exec'd code
   *  never forwards/touches this path (or it isn't reachable — see the
   *  DockerSandbox header for why it never is, faithfully), the watchdog
   *  simply never sees a change and behaves exactly as if no beacon exists. */
  activityFile?: string;
  /** PORT-NOTE (sync 2e39a3f, eb40093, 46a4595): SHELLM_MAX_OUTPUT_SIZE — kill a
   *  command whose combined output reaches this many BYTES even while it is
   *  actively producing output (a runaway loop resets both silence timers on
   *  every poll, so they never catch it). 0/undefined disables. */
  maxOutputBytes?: number;
  /** PORT-NOTE (sync 2e39a3f, bfb43f7): SHELLM_MAX_EXEC_TIME — kill a block
   *  that has run this many ms however it behaves (a heartbeat loop around a
   *  wait that never finishes passes every other guard). 0/undefined disables. */
  maxExecMs?: number;
}

export interface ExecResult {
  /** Combined stdout+stderr (2>&1), exactly as the Bash captures it. */
  output: string;
  exit: number;
  timedOut: boolean;
  /** Set only when timedOut: "idle" (staleMs hit inactivityTimeoutMs with no
   *  output or beacon touch) vs "max" (quietMs hit timeoutMs regardless of
   *  beacon activity) — the port's analogue of upstream's kill_reason
   *  "idle"/"nested" (bin/shellm:2652-2658). "nested" is renamed "max" here
   *  because this port's exec'd code never runs a nested shellm loop (there
   *  is no standalone `shellm` CLI in this port — PARITY.md), so the only way
   *  to reach the ceiling while staying "active" is a bare beacon touch, not
   *  an actual nested run; the mechanism upstream's "nested" label points at
   *  is faithfully reproduced even though the label's literal meaning doesn't
   *  apply to this port's architecture. */
  killReason?: "idle" | "max" | "output" | "wall";
}

export interface Sandbox {
  exec(req: ExecRequest): Promise<ExecResult>;
}

/** SHELLM_INACTIVITY_TIMEOUT default (bin/shellm:94). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** SHELLM_MAX_OUTPUT_SIZE default (bin/shellm, eb40093): 10 MB. */
export const DEFAULT_MAX_OUTPUT_BYTES = 10_485_760;
/** SHELLM_MAX_EXEC_TIME default (bin/shellm, bfb43f7): 3600 s. */
export const DEFAULT_MAX_EXEC_MS = 3_600_000;
/** Bytes kept from each end of an output-size-killed block (OUTPUT_KEEP_BYTES). */
export const OUTPUT_KEEP_BYTES = 131_072;
/** SHELLM_INACTIVITY_MAX default (bin/shellm:95). */
export const DEFAULT_MAX_QUIET_MS = 900_000;

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface WatchedSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  idleTimeoutMs: number;
  maxQuietMs: number;
  activityFile?: string;
  /** See ExecRequest.maxOutputBytes. */
  maxOutputBytes?: number;
  /** See ExecRequest.maxExecMs. */
  maxExecMs?: number;
  /** Poll cadence. Default: scales with the smaller of the two ceilings so
   *  tests using small overrides stay fast, capped at upstream's own `sleep
   *  1` cadence (1000ms) at production-sized defaults — i.e. identical
   *  granularity to upstream when the knobs are left at 30s/900s. */
  pollIntervalMs?: number;
  /** Grace between the TERM and the escalation KILL (bin/shellm:2666-2667's
   *  `sleep 2`). Default 2000ms. */
  killGraceMs?: number;
  killSignal?: NodeJS.Signals;
  maxBuffer?: number;
  /** Text written to the child's stdin, then closed. Default: stdin is /dev/null. */
  stdinText?: string;
  /** Called synchronously right before the watchdog's first kill signal, so a
   *  caller can cancel work the host signal cannot reach (a Docker exec's
   *  in-container process tree, sync 2e39a3f c0fc931). */
  onKill?: () => void;
  /** Called once when the child has exited or failed to spawn (cleanup). */
  onClose?: () => void;
}

/**
 * Spawn `command`, stream its combined stdout+stderr, and enforce the two-
 * timer inactivity watchdog described in the file header. Resolves once the
 * child exits (naturally or via the watchdog); rejects only on a genuine
 * spawn/infra failure (missing binary, output overflow) — never on a normal
 * command failure or a watchdog kill, both of which are ordinary results.
 */
export function execWithInactivityWatchdog(opts: WatchedSpawnOptions): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const killGraceMs = opts.killGraceMs ?? 2000;
  const killSignal = opts.killSignal ?? "SIGTERM";
  const pollIntervalMs =
    opts.pollIntervalMs ??
    Math.max(50, Math.min(1000, Math.floor(Math.min(opts.idleTimeoutMs, opts.maxQuietMs) / 10)));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        // A new process group (pgid = child pid) on POSIX, same technique as
        // llmAdapterProcess.ts's killGroup: a foreground grandchild (e.g. the
        // `sleep` inside a killed `sleep 8` script) inherits our stdout PIPE
        // fd — if only the direct child (bash) is signaled, an orphaned
        // grandchild that keeps running holds that pipe open and Node's
        // 'close' event never fires until the grandchild itself exits,
        // silently defeating the whole watchdog. Signaling the group instead
        // reaches it too. Windows has no process-group signal semantics.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (opts.stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* EPIPE: the child exited before reading everything */
      });
      child.stdin.end(opts.stdinText);
    }
    const finish = (): void => {
      try {
        opts.onClose?.();
      } catch {
        /* cleanup is best effort */
      }
    };

    const killTarget = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        /* ESRCH: already gone */
      }
    };

    // PORT-NOTE (sync 2e39a3f): output is kept as raw chunks so the byte-size
    // cap and the head/tail keep-bytes cut of a runaway block (below) work on
    // BYTES, as upstream's `wc -c` / `head -c` / `tail -c` do.
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLenAtLastTick = 0;
    const startedAt = Date.now();
    let staleMs = 0;
    let quietMs = 0;
    let lastBeacon: string | undefined;
    let killReason: "idle" | "max" | "output" | "wall" | undefined;
    let killedByWatchdog = false;
    let overflowed = false;
    let settled = false;
    let escalateTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer): void => {
      if (overflowed) return;
      chunks.push(chunk);
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        overflowed = true;
        clearInterval(tickTimer);
        if (escalateTimer) clearTimeout(escalateTimer);
        killTarget("SIGKILL");
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const tick = (): void => {
      if (outputBytes !== outputLenAtLastTick) {
        outputLenAtLastTick = outputBytes;
        staleMs = 0;
        quietMs = 0;
      } else {
        staleMs += pollIntervalMs;
        quietMs += pollIntervalMs;
      }
      if (opts.activityFile) {
        let beacon: string | undefined;
        try {
          beacon = fs.readFileSync(opts.activityFile, "utf8");
        } catch {
          beacon = undefined; // not written yet, or (Docker mode) unreachable — no-op
        }
        if (beacon !== undefined && beacon !== "" && beacon !== lastBeacon) {
          lastBeacon = beacon;
          staleMs = 0; // beacon resets IDLE only — bin/shellm:2648-2651 never resets quietMs
        }
      }
      // bin/shellm's watchdog order: output size, wall clock, idle, nested.
      if (opts.maxOutputBytes && opts.maxOutputBytes > 0 && outputBytes >= opts.maxOutputBytes) {
        killReason = "output";
      } else if (opts.maxExecMs && opts.maxExecMs > 0 && Date.now() - startedAt >= opts.maxExecMs) {
        killReason = "wall";
      } else if (staleMs >= opts.idleTimeoutMs) {
        killReason = "idle";
      } else if (quietMs >= opts.maxQuietMs) {
        killReason = "max";
      }
      if (killReason && !killedByWatchdog) {
        killedByWatchdog = true;
        clearInterval(tickTimer);
        try {
          opts.onKill?.();
        } catch {
          /* best effort: the host kill below still runs */
        }
        killTarget(killSignal);
        // bin/shellm:2666-2667's `sleep 2` grace before the follow-up `kill
        // -9` — NOT gated on whether the leader already exited: a TERM-
        // trapping/ignoring grandchild can outlive it, so the escalation
        // always fires and reaches the whole group.
        escalateTimer = setTimeout(() => killTarget("SIGKILL"), killGraceMs);
      }
    };
    const tickTimer = setInterval(tick, pollIntervalMs);

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearInterval(tickTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      finish();
      reject(err);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(tickTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      finish();
      if (overflowed) {
        reject(new Error(`execWithInactivityWatchdog: output exceeded maxBuffer (${maxBuffer} bytes)`));
        return;
      }
      const timedOut = killedByWatchdog;
      let output: string;
      const all = Buffer.concat(chunks);
      if (timedOut && killReason === "output" && all.length > OUTPUT_KEEP_BYTES * 2) {
        // A block killed for output size keeps only the two ends of what it
        // wrote (bin/shellm, 46a4595): everything downstream holds the output
        // in one variable. `tail -c N | tail -n +2` drops the partial first line.
        const head = all.subarray(0, OUTPUT_KEEP_BYTES).toString("utf8");
        const tailBuf = all.subarray(all.length - OUTPUT_KEEP_BYTES).toString("utf8");
        const nl = tailBuf.indexOf("\n");
        const tail = nl < 0 ? "" : tailBuf.slice(nl + 1);
        output = `${head}\n[... ${all.length - OUTPUT_KEEP_BYTES * 2} bytes of output dropped ...]\n${tail}`;
      } else {
        output = all.toString("utf8");
      }
      // Timeout kill maps to the port's own exit-124 convention (already
      // established pre-existing behavior, see PARITY.md); a non-watchdog
      // signal death (e.g. the parent process itself got SIGTERM) falls back
      // to 1, matching the prior spawnSync-based mapping exactly.
      const exit = timedOut ? 124 : typeof code === "number" ? code : signal ? 1 : 1;
      resolve({ output, exit, timedOut, ...(timedOut && killReason ? { killReason } : {}) });
    });
  });
}

/**
 * Generated code above this many BYTES runs from a mode-600 script file instead
 * of `bash -c <code>` (bin/shellm `_supervise_exec`, db1e8e1): Linux caps one
 * argv string at 128 KiB (MAX_ARG_STRLEN), and a code block just over the cap
 * killed the exec itself (rc=126 "Argument list too long", the step never ran).
 */
export const EXEC_ARGV_CODE_LIMIT_BYTES = 65536;

/** Restricted local-subprocess sandbox (see file header). */
export class LocalSandbox implements Sandbox {
  async exec(req: ExecRequest): Promise<ExecResult> {
    // bin/shellm:1349 — `exec bash -e -c "$wrapped_code"` from a subshell that
    // cd's to the workdir, with stdin </dev/null and the whole block 2>&1.
    // We reproduce the 2>&1 IN-PROCESS with a leading `exec 2>&1` so stderr
    // (incl. `set -x` xtrace and any `echo … >&2` the code does, like the
    // truncation notice) merges into stdout in true stream order — the
    // interleave the golden shell-output preserves.
    // PORT-NOTE (gapcheck, execlines parity): `exec 2>&1; ` rides on the SAME line as the wrapper's first
    // line (`set -x`), never on a line of its own. bash numbers `-c` script lines from 1, so an extra
    // leading line shifted every "line N:" in error text (unknown command, syntax error) and every
    // $LINENO the model's code printed by +1 versus upstream's `bash -e -c "$wrapped_code"`
    // (bin/shellm:1631), whose first line is `set -x` (bin/shellm:3065).
    const code = "exec 2>&1; " + req.wrappedCode;
    let codeFile: string | undefined;
    let args: string[];
    if (Buffer.byteLength(code) > EXEC_ARGV_CODE_LIMIT_BYTES) {
      // PORT-NOTE (sync 2e39a3f, db1e8e1): big code runs from a 0600 script file
      // (mkdtemp makes the directory 0700, the file 0600) — stricter than an
      // argv string any user can read through ps. Removed when the run ends.
      const dir = fs.mkdtempSync(path.join(req.env["TMPDIR"] || os.tmpdir(), "shellm-code."));
      codeFile = path.join(dir, "code.sh");
      fs.writeFileSync(codeFile, code, { mode: 0o600 });
      args = ["-e", codeFile];
    } else {
      args = ["-e", "-c", code];
    }
    try {
      return await execWithInactivityWatchdog({
        command: "bash",
        args,
        cwd: req.workdir,
        env: req.env, // whitelisted by the caller; do NOT inherit process.env
        idleTimeoutMs: req.inactivityTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        maxQuietMs: req.timeoutMs ?? DEFAULT_MAX_QUIET_MS,
        ...(req.maxOutputBytes !== undefined ? { maxOutputBytes: req.maxOutputBytes } : {}),
        ...(req.maxExecMs !== undefined ? { maxExecMs: req.maxExecMs } : {}),
        ...(req.activityFile !== undefined ? { activityFile: req.activityFile } : {}),
      });
    } finally {
      if (codeFile) fs.rmSync(path.dirname(codeFile), { recursive: true, force: true });
    }
  }
}
