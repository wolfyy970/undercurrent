// thinkersctl.ts — `thinkers start|stop|status|step|list|logs` (PLAN-daemon §5;
// bin/thinkers). The daemon itself lives in daemon.ts; this module is the
// control-plane CLI that starts/stops it and pokes its pending/ queue — it
// never imports the engine either.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  runDirOf,
  readPid,
  writePid,
  removePid,
  pidAlive,
  killTree,
  newToken,
  readToken,
  writeToken,
  readActive,
  addActive,
  writeActive,
  removeActive,
  removeActiveFile,
  readStepPids,
  removeAllWakeAt,
  removeWakeAt,
  touchDeliberateStop,
  writePendingFile,
  manualTriggerJson,
  removeSubMap,
  removeTrajFiles,
  removeToken,
  rmQuiet,
} from "./runstate.ts";
import { resolveTrajFile } from "./trajectory.ts";
import { PORT_HOME, readInfoField } from "./identity-env.ts";
import { appendStep as trajCoreAppendStep } from "./trajCore.mjs";
import { runtimePath } from "./runtime.ts";

const DISPATCHERD = path.join(PORT_HOME, "bin", "dispatcherd.mjs");
const THINKERS_DRAIN = path.join(PORT_HOME, "bin", "thinkers-drain.mjs");
const BOOT_WAIT_MS = 5000;
const DRAIN_TIMEOUT_DEFAULT_S = 180;
const WAKE_NOTE_MIN_GAP_S = 300;

export interface ThinkersEnv {
  IDENTITY_DIR: string;
  IDENTITY_NAME: string;
  TRAJ_DIR: string;
  TRAJ_ID: string;
  THINKERS_DIR: string;
  [k: string]: string;
}

/**
 * `_require_env` (bin/thinkers:138-155), reproduced in upstream's exact
 * order — three required-and-already-set variables, THEN fallback defaults,
 * THEN the one existence check, THEN more fallback defaults that never die:
 *
 *   1. IDENTITY_DIR set?          die "IDENTITY_DIR not set. Run: identity shell <name>"
 *   2. TRAJ_DIR set?              die "TRAJ_DIR not set. Run: identity shell <name>"
 *   3. TRAJ_ID set?               die "TRAJ_ID not set. Run: identity shell <name>"
 *   4. IDENTITY_NAME unset -> `grep '^name=' $IDENTITY_DIR/info.txt` else basename(IDENTITY_DIR)
 *   5. THINKERS_DIR unset -> $IDENTITY_DIR/thinkers
 *   6. THINKERS_DIR a dir?        die "Thinkers directory not found: $THINKERS_DIR"  (BUG #67)
 *   7. MEM_DIR/SKILLS_DIR/SKILLS_KERNEL_DIR/SHELLM_HOME unset -> $IDENTITY_DIR/<sub>
 *
 * bin/thinkers.mjs passes `process.env` straight through with NO resolution
 * step of its own (matching upstream: bin/thinkers never pre-resolves
 * anything outside this function — that is `identity shell <name>`'s /
 * `activate`'s job, done once, in a DIFFERENT process, before bin/thinkers
 * ever runs). A caller that already ran the port's own activate-equivalent
 * (`resolveIdentityEnv`, e.g. web/server's control plane, or this file's own
 * tests) gets every field already filled in, so steps 4/5/7 here are no-ops
 * for it — same as a real upstream shell that already sourced `activate`.
 *
 * No "thinkers: error:" prefix baked into any of these messages — bin/thinkers.mjs's
 * top-level catch adds that single prefix once, matching upstream's die()
 * byte-for-byte. (Bug fixed alongside #67: the three not-set checks used to
 * bake the prefix in themselves, which double-prefixed every one of them once
 * the catch added its own — `thinkers: error: thinkers: error: IDENTITY_DIR
 * not set...` — invisible to the pre-existing tests because they all called
 * thinkersStatus/etc. directly, never through the bin/thinkers.mjs CLI.)
 */
function requireEnv(env: Partial<ThinkersEnv>): ThinkersEnv {
  for (const [k, msg] of [
    ["IDENTITY_DIR", "IDENTITY_DIR not set. Run: identity shell <name>"],
    ["TRAJ_DIR", "TRAJ_DIR not set. Run: identity shell <name>"],
    ["TRAJ_ID", "TRAJ_ID not set. Run: identity shell <name>"],
  ] as const) {
    if (!env[k]) throw new Error(msg);
  }
  const out: Record<string, string> = { ...(env as Record<string, string>) };
  const identityDir = out.IDENTITY_DIR!;

  if (!out.IDENTITY_NAME) {
    out.IDENTITY_NAME = readInfoField(path.join(identityDir, "info.txt"), "name") ?? path.basename(identityDir);
  }

  if (!out.THINKERS_DIR) out.THINKERS_DIR = path.join(identityDir, "thinkers");
  // PORT-NOTE (bug #67, bin/thinkers:151): upstream's `_require_env` dies
  // with `Thinkers directory not found: $THINKERS_DIR` when the (verbatim,
  // or `$IDENTITY_DIR/thinkers`-derived) THINKERS_DIR is not an existing
  // directory — e.g. IDENTITY_DIR pointing at a path that doesn't exist.
  // This port used to skip straight past that check: every reader of a
  // missing THINKERS_DIR (listThinkerDirs/enabledThinkerNames) swallows
  // ENOENT into an empty list, so `status` printed a normal-looking
  // "Thinkers:" with zero entries at exit 0 instead of refusing.
  if (!fs.statSync(out.THINKERS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Thinkers directory not found: ${out.THINKERS_DIR}`);
  }

  if (!out.MEM_DIR) out.MEM_DIR = path.join(identityDir, "memories");
  if (!out.SKILLS_DIR) out.SKILLS_DIR = path.join(identityDir, "skills");
  if (!out.SKILLS_KERNEL_DIR) out.SKILLS_KERNEL_DIR = path.join(identityDir, "kernel");
  if (!out.SHELLM_HOME) out.SHELLM_HOME = path.join(identityDir, ".shellm");

  return out as ThinkersEnv;
}

function listThinkerDirs(thinkersDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(thinkersDir);
  } catch {
    return [];
  }
  return names
    .sort()
    .filter((n) => !n.startsWith("_") && fs.statSync(path.join(thinkersDir, n)).isDirectory());
}

// Exported for reuse by web/server/src/control.ts (thinkers/start's "expand
// empty names to all enabled" — SPEC-control-plane.md §B route 3).
export function enabledThinkerNames(thinkersDir: string): string[] {
  return listThinkerDirs(thinkersDir).filter((n) => {
    const dir = path.join(thinkersDir, n);
    return (
      !fs.existsSync(path.join(dir, "disabled")) &&
      fs.existsSync(path.join(dir, "step")) &&
      fs.existsSync(path.join(dir, "subscriptions.jsonl"))
    );
  });
}

/** cmd_start's per-name validation loop (bin/thinkers:1114-1123) — exact text. */
function checkThinkerNames(env: ThinkersEnv, names: string[]): void {
  for (const name of names) {
    const dir = path.join(env.THINKERS_DIR, name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Thinker not found: ${name}`);
    }
    if (fs.existsSync(path.join(dir, "disabled"))) {
      throw new Error(`Thinker '${name}' is disabled (remove ${dir}/disabled to enable)`);
    }
    if (!fs.existsSync(path.join(dir, "step")) || !fs.existsSync(path.join(dir, "subscriptions.jsonl"))) {
      throw new Error(`Thinker '${name}' missing step or subscriptions.jsonl`);
    }
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a thinker's own `<thinker_dir>/stop` script if present + executable
 * (bin/thinkers:1259 `_drain_then_finish`, :1273 `_drain_all_then_finish`,
 * :1356-1357 cmd_stop's named force/no-in-flight branch, :1423-1425
 * cmd_stop's stop-all final loop). Upstream execs it directly as a program —
 * `"$thinker_dir/stop" || true` — with no interpreter convention (the port's
 * own `thinkers/<name>/step` shim is Node, but a `stop` script is whatever
 * the identity has on disk); failures are swallowed (`|| true`) and never
 * fail `thinkers stop`.
 *
 * PORT-NOTE: upstream leaves cwd unspecified (whatever the `thinkers`
 * process's own cwd happened to be — it never `cd`s); this port pins it to
 * IDENTITY_DIR, the convention already used for every other thinker-owned
 * subprocess (see `thinkersStep`'s `spawn(stepFile, …)` above). `env` is the
 * full identity env passed into this call (the shell equivalent of every
 * `IDENTITY_*`/`THINKERS_*`/etc. var an `activate`d shell would export).
 * `detached` mirrors the two calling shapes upstream itself has: the
 * synchronous cmd_stop branches run un-redirected (inherits whatever stdio
 * `thinkers stop` had); the two detached reapers redirect
 * `</dev/null >/dev/null 2>&1 &` — matched here with `stdio:"ignore"`.
 */
function runStopScript(thinkerDir: string, cwd: string, env: NodeJS.ProcessEnv, detached: boolean): void {
  const stopFile = path.join(thinkerDir, "stop");
  if (!isExecutable(stopFile)) return;
  try {
    spawnSync(stopFile, [], { cwd, env, stdio: detached ? "ignore" : "inherit" });
  } catch {
    /* matches `|| true` */
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface StartOptions {
  noSelfTrigger?: boolean;
  stderr?: (s: string) => void;
}

export interface StartResult {
  ok: true;
  started: string[];
  dispatcherPid: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForBoot(runDir: string, timeoutMs = BOOT_WAIT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(path.join(runDir, "pending")) && fs.existsSync(path.join(runDir, "sub_map"))) return true;
    await sleep(25);
  }
  return false;
}

/** _append_wake_gap_note (bin/thinkers:1027-1046). Failure-open. */
function appendWakeGapNote(env: ThinkersEnv, minGapS?: number): void {
  // PORT-NOTE (2e39a3f sync: test_thinkers_trajectory_swap.sh sets it): bin/thinkers:1489-1490
  // reads THINKERS_WAKE_NOTE_MIN_GAP (default 300; a non-integer or 0 disables the note). The
  // port had the default but never read the variable, so the knob was dead.
  if (minGapS === undefined) {
    const raw = process.env["THINKERS_WAKE_NOTE_MIN_GAP"] ?? String(WAKE_NOTE_MIN_GAP_S);
    if (!/^[0-9]+$/.test(raw)) return;
    minGapS = Number(raw);
  }
  if (minGapS <= 0) return;
  try {
    const trajFile = resolveTrajFile(env.TRAJ_DIR, env.TRAJ_ID);
    if (!trajFile) return;
    const lines = fs.readFileSync(trajFile, "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return;
    const rec = JSON.parse(last) as { ts?: string };
    if (!rec.ts) return;
    const lastEpoch = Math.floor(Date.parse(rec.ts) / 1000);
    if (!Number.isFinite(lastEpoch)) return;
    const gap = Math.floor(Date.now() / 1000) - lastEpoch;
    if (gap < minGapS) return;
    const gapH = Math.floor(gap / 3600);
    const gapM = Math.floor((gap % 3600) / 60);
    const gapStr = gapH > 0 ? `${gapH}h ${gapM}m` : `${gapM}m`;
    // PORT-NOTE (gapcheck, PARITY.md "Gapcheck findings"): DOCUMENTED DEVIATION. Upstream's note (bin/thinkers:1500-1503)
    // also says "; systemctl status headlong-thinkers@<name>" and ends "To restart yourself safely (e.g. to register a new
    // thinker), run: sudo headlong-thinkersctl restart <name> — systemd completes the restart even though your current step
    // dies with the old dispatcher." Both sentences name the systemd deployment (deploy/), which this port does not ship, so the
    // command does not exist here and the advice would send the mind to a dead end. Cost of matching: +236 B once per dispatcher start.
    const content =
      `Wake-up note: your dispatcher just started, and the previous step in this log is about ${gapStr} old — ` +
      `your mind was not running in between. If you did not expect this downtime, investigate it ` +
      `(run/logs/dispatcher.log) before resuming other plans. Reminder: \`thinkers stop\` from inside your own ` +
      `mind kills you mid-step and nothing restarts you.`;
    trajCoreAppendStep(trajFile, { type: "observation", source: "system", content }, {});
  } catch {
    /* failure-open, matches upstream */
  }
}

/** `thinkers start [--no-self-trigger] [names…]` (bin/thinkers:1095-1221). */
export async function thinkersStart(env: Partial<ThinkersEnv>, names: string[], opts: StartOptions = {}): Promise<StartResult> {
  const e = requireEnv(env);
  const stderr = opts.stderr ?? (() => {});
  const runDir = runDirOf(e.IDENTITY_DIR);
  fs.mkdirSync(runDir, { recursive: true });

  if (names.length > 0) {
    checkThinkerNames(e, names);
    for (const n of names) addActive(runDir, n);
  } else {
    writeActive(runDir, enabledThinkerNames(e.THINKERS_DIR));
  }

  const existingPid = readPid(runDir);
  const needDispatcher = existingPid === null || !pidAlive(existingPid);
  let dispatcherPid = existingPid ?? -1;

  if (needDispatcher) {
    stderr("Starting dispatcher...\n");
    // PORT-NOTE (2e39a3f, bin/thinkers:437-442): the Bash dispatcher keeps its FIFO under /tmp
    // now and a start removes a leftover at the old in-identity path. The port has no FIFO at all
    // (the feeder is in-process), but an identity that last ran under the Bash engine can still
    // hold the leftover, and nothing else would ever clean it up, so the same removal is kept.
    try {
      const legacy = path.join(runDir, "dispatch.fifo");
      if (fs.lstatSync(legacy).isFIFO()) fs.unlinkSync(legacy);
    } catch {
      /* none */
    }
    // The token is minted by the CLI before the dispatcher process even exists (bin/thinkers) — it
    // identifies this START, not the dispatcher's pid. 16 random bytes since 2e39a3f.
    const token = newToken();
    writeToken(runDir, token);
    const child = spawn(runtimePath(), [DISPATCHERD], {
      cwd: e.IDENTITY_DIR,
      detached: true,
      stdio: "ignore",
      env: { ...e, HEADLONG_DISPATCHER_TOKEN: token, ...(opts.noSelfTrigger ? { NO_SELF_TRIGGER: "1" } : {}) },
    });
    child.unref();
    if (typeof child.pid !== "number") throw new Error("thinkers start: failed to spawn dispatcher");
    dispatcherPid = child.pid;
    writePid(runDir, dispatcherPid);
    await waitForBoot(runDir);
    stderr(`Dispatcher started (PID ${dispatcherPid})\n`);
    appendWakeGapNote(e);
  }

  // Boot kick: ONLY the named branch queues a manual-trigger (bin/thinkers:1163-1181).
  // Bare `start` (no names) never kicks — the fresh dispatcher's own boot already
  // subscribes everyone; upstream's own quirk, replicated (PLAN-daemon §5).
  fs.mkdirSync(path.join(runDir, "pending"), { recursive: true });
  let seq = 0;
  for (const name of names) {
    seq += 1;
    writePendingFile(path.join(runDir, "pending"), name, "manual-trigger", seq, manualTriggerJson());
    stderr(`Started thinker: ${name} (wake queued)\n`);
  }

  return { ok: true, started: names.length > 0 ? names : readActive(runDir), dispatcherPid };
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export interface StopOptions {
  force?: boolean;
  self?: boolean;
  drainTimeoutS?: number;
  stderr?: (s: string) => void;
}

export interface StopResult {
  ok: true;
  stopped: string[];
}

/** _inside_own_dispatcher's ppid-ancestry walk (bin/thinkers:126-133). The
 *  cgroup fast path is a systemd-only concern (documented Bash artifact,
 *  PARITY.md) — this port relies on the ppid walk alone, which is exact for
 *  attached steps everywhere, including macOS dev machines. */
function insideOwnDispatcher(runDir: string): boolean {
  const dpid = readPid(runDir);
  if (dpid === null || !pidAlive(dpid)) return false;
  let pid = process.pid;
  for (let i = 0; i < 4096 && pid > 1; i++) {
    if (pid === dpid) return true;
    const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const next = parseInt((r.stdout ?? "").trim(), 10);
    if (!Number.isFinite(next)) return false;
    pid = next;
  }
  return false;
}

/**
 * `_stop_dispatcher`. Returns false when a concurrent `start` took ownership while this stop ran (its
 * token is on disk and is not the one this stop snapshotted): the new owner's runtime files are left
 * alone and the caller skips its own post-stop bookkeeping (2e39a3f: `_stop_dispatcher || return 0`).
 */
function stopDispatcher(runDir: string, stderr: (s: string) => void): boolean {
  const tokenSnapshot = readToken(runDir) ?? "";
  const pid = readPid(runDir);
  if (pid !== null) {
    if (pidAlive(pid)) {
      stderr(`Stopping dispatcher (PID ${pid})...\n`);
      touchDeliberateStop(runDir);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && pidAlive(pid)) {
        spawnSync("sleep", ["0.25"]);
      }
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      stderr("Dispatcher stopped.\n");
    } else {
      stderr("Dispatcher not running (cleaned up stale PID).\n");
    }
    // only drop the pid file if it is still the one we stopped (a racing start rewrites it)
    if (readPid(runDir) === pid) removePid(runDir);
  } else {
    stderr("No dispatcher running.\n");
  }
  // `_cleanup_run_state ... token_snapshot`: a successor's files are not ours to remove
  const current = readToken(runDir) ?? "";
  if (current !== "" && current !== tokenSnapshot) return false;
  removeSubMap(runDir);
  removeTrajFiles(runDir);
  removeToken(runDir);
  // PORT-NOTE (2e39a3f, bin/thinkers:1367-1370): the Bash engine's `fifo_path` pointer is removed
  // by stop and whatever it names is only removed when it matches the dispatcher's own /tmp
  // pattern, so a pointer rewritten to a foreign path is never followed. The port never writes
  // the pointer; a leftover from a Bash-engine run is unlinked here WITHOUT following it.
  rmQuiet(path.join(runDir, "fifo_path"));
  rmQuiet(path.join(runDir, "pending"));
  return true;
}

/** Explicit stop cancels unlaunched wakes: the wake file and any claim/sent receipt for the names. */
function cancelWakes(runDir: string, names: string[] | null): void {
  if (names === null) {
    removeAllWakeAt(runDir);
    for (const d of ["claimed", "sent"]) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(path.join(runDir, d));
      } catch {
        /* none */
      }
      for (const n of entries) rmQuiet(path.join(runDir, d, n));
    }
    return;
  }
  for (const n of names) {
    removeWakeAt(runDir, n);
    rmQuiet(path.join(runDir, "claimed", n));
    rmQuiet(path.join(runDir, "sent", n));
  }
}

/** `thinkers stop [names…] [--force] [--self] [--drain-timeout N]` (bin/thinkers:1281-1433). */
export async function thinkersStop(env: Partial<ThinkersEnv>, names: string[], opts: StopOptions = {}): Promise<StopResult> {
  const e = requireEnv(env);
  const runDir = runDirOf(e.IDENTITY_DIR);
  const stderr = opts.stderr ?? (() => {});
  const drainTimeoutS = opts.drainTimeoutS ?? DRAIN_TIMEOUT_DEFAULT_S;

  if (!opts.self && insideOwnDispatcher(runDir)) {
    throw new Error(
      `stop: refusing — this process would die with the ${e.IDENTITY_NAME} dispatcher it is asking to stop. Pass --self to really stop your own mind.`
    );
  }


  if (names.length > 0) {
    for (const name of names) {
      removeActive(runDir, name);
      // Explicit stop cancels unlaunched wakes, including crash claims. Deactivate first so the
      // sweep cannot dispatch the cancelled work.
      cancelWakes(runDir, [name]);
      const thinkerDir = path.join(e.THINKERS_DIR, name);
      const pids = readStepPids(runDir)
        .filter((s) => s.name === name && pidAlive(s.pid))
        .map((s) => s.pid);
      if (pids.length === 0 || opts.force) {
        for (const p of pids) killTree(p, "SIGTERM");
        runStopScript(thinkerDir, e.IDENTITY_DIR, e as unknown as NodeJS.ProcessEnv, false);
        stderr(`Stopped thinker: ${name}\n`);
      } else {
        drainThenFinish(pids, drainTimeoutS, [{ dir: thinkerDir }], e.IDENTITY_DIR, e as unknown as NodeJS.ProcessEnv);
        stderr(`Stopped thinker: ${name} (draining ${pids.length} in-flight step(s), max ${drainTimeoutS}s)\n`);
      }
    }
    const remaining = readActive(runDir);
    if (remaining.length === 0) {
      stderr("No active thinkers remain — stopping dispatcher.\n");
      if (!stopDispatcher(runDir, stderr)) return { ok: true, stopped: names };
    }
    return { ok: true, stopped: names };
  }

  // Stop all.
  if (!stopDispatcher(runDir, stderr)) return { ok: true, stopped: [] };
  // Wait until the dispatcher is gone before cancelling its pending claims.
  cancelWakes(runDir, null);
  const allPids = readStepPids(runDir)
    .filter((s) => pidAlive(s.pid))
    .map((s) => s.pid);
  // bin/thinkers:1265-1276 _drain_all_then_finish / :1417-1428 the stop-all
  // sync loop: BOTH iterate every enabled thinker dir (_list_thinker_dirs),
  // not just the ones that had a live pid — a thinker with no in-flight step
  // still gets its stop script run.
  const allStopTargets = enabledThinkerNames(e.THINKERS_DIR).map((name) => ({
    dir: path.join(e.THINKERS_DIR, name),
  }));

  if (allPids.length > 0 && !opts.force) {
    drainThenFinish(allPids, drainTimeoutS, allStopTargets, e.IDENTITY_DIR, e as unknown as NodeJS.ProcessEnv, runDir);
    removeActiveFile(runDir);
    stderr(`All thinkers deactivated — draining ${allPids.length} in-flight step(s) (max ${drainTimeoutS}s).\n`);
    return { ok: true, stopped: [] };
  }
  for (const p of allPids) killTree(p, "SIGTERM");
  if (allPids.length > 0) {
    stderr(`Killed ${allPids.length} in-flight step process(es).\n`);
    await sleep(1000);
    for (const p of allPids) if (pidAlive(p)) killTree(p, "SIGKILL");
  }
  rmQuiet(path.join(runDir, "step_pids"));
  for (const name of enabledThinkerNames(e.THINKERS_DIR)) {
    const dir = path.join(e.THINKERS_DIR, name);
    if (isExecutable(path.join(dir, "stop"))) {
      stderr(`Stopping thinker: ${name}\n`);
      runStopScript(dir, e.IDENTITY_DIR, e as unknown as NodeJS.ProcessEnv, false);
    }
  }
  removeActiveFile(runDir);
  stderr("All thinkers stopped.\n");
  return { ok: true, stopped: [] };
}

/** `_wait_or_kill` + the detached reaper (`_drain_then_finish` /
 *  `_drain_all_then_finish`, bin/thinkers:1250-1276: a `(...) </dev/null
 *  >/dev/null 2>&1 & disown` background subshell — a genuinely separate OS
 *  process the parent shell doesn't wait on). Spawns `bin/thinkers-drain.mjs`
 *  DETACHED + unref'd (same technique `thinkersStart` uses for the
 *  dispatcher) so this call returns immediately regardless of caller: a
 *  library caller gets its promise back at once, and — critically — the
 *  standalone `thinkers stop` CLI process can actually EXIT immediately too.
 *  An earlier version ran this wait as an un-awaited in-process
 *  `setTimeout` loop; that kept a library caller's own promise resolving
 *  right away, but Node's event loop stays alive for as long as a pending
 *  timer exists, so the bin/thinkers.mjs PROCESS itself would hang until the
 *  drain finished — silently failing "stop returns immediately" against the
 *  real oracle (tests/test_thinkers_drain.sh times the CLI invocation, not
 *  just the promise). See bin/thinkers-drain.mjs's header for the full
 *  PORT-NOTE. */
function drainThenFinish(
  pids: number[],
  timeoutS: number,
  stopTargets: { dir: string }[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  runDir?: string
): void {
  const child = spawn(runtimePath(), [THINKERS_DRAIN], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify({ pids, timeoutS, stopTargets, cwd, env, runDir }));
  child.unref();
}

// ---------------------------------------------------------------------------
// step / list / logs / status
// ---------------------------------------------------------------------------

export interface StepOptions {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface StepResult {
  code: number;
}

/**
 * `thinkers step <name>` (bin/thinkers:1664-1685) — DIRECTOR DECISION:
 * upstream runs the step SYNCHRONOUSLY, inline, regardless of daemon state —
 * no pending file. `Running <name>/step ...` goes straight to stderr; the
 * step's own stdout+stderr are merged (`2>&1`) and tee'd to BOTH this
 * process's stdout and `run/logs/<name>.log`; the exit code is the step's
 * (bash `pipefail` makes the pipeline's status the step's, `tee` succeeding).
 * Only two checks gate it: the thinker dir exists, and its `step` file is
 * executable — NOT the disabled/subscriptions.jsonl checks `start` applies.
 */
export async function thinkersStep(env: Partial<ThinkersEnv>, name: string, opts: StepOptions = {}): Promise<StepResult> {
  const e = requireEnv(env);
  const stdout = opts.stdout ?? (() => {});
  const stderr = opts.stderr ?? (() => {});

  const dir = path.join(e.THINKERS_DIR, name);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Thinker not found: ${name}`);
  }
  const stepFile = path.join(dir, "step");
  if (!isExecutable(stepFile)) {
    throw new Error(`No executable step script in ${dir}`);
  }

  const runDir = runDirOf(e.IDENTITY_DIR);
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  const logFile = path.join(runDir, "logs", `${name}.log`);
  const triggerJson = manualTriggerJson();

  stderr(`Running ${name}/step ...\n`);

  return new Promise((resolve, reject) => {
    let logFd: number;
    try {
      logFd = fs.openSync(logFile, "a");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const child = spawn(stepFile, [], {
      cwd: e.IDENTITY_DIR,
      // Port-only: the shipped step files are Node shims that locate the port through HEADLONG_TS_HOME, which only
      // the dispatcher's env carries. Upstream's Bash steps find their own helpers (`source $SCRIPT_DIR/../_lib/...`,
      // thinkers/retrieval/step:27-30) and run from any shell, so a `thinkers step <name>` typed in the mind's wake
      // shell must work too: supply this checkout's path when the caller's env has none.
      env: { ...(e as unknown as NodeJS.ProcessEnv), ...(e["HEADLONG_TS_HOME" as keyof typeof e] ? {} : { HEADLONG_TS_HOME: PORT_HOME }) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer): void => {
      stdout(chunk.toString("utf8"));
      try {
        fs.writeSync(logFd, chunk);
      } catch {
        /* best effort, matches tee's own failure-open behavior */
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.end(triggerJson);
    child.once("error", (err) => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* already closed */
      }
      reject(err);
    });
    child.once("close", (code, signal) => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* already closed */
      }
      resolve({ code: code ?? (signal ? 128 : 1) });
    });
  });
}

// ---------------------------------------------------------------------------
// enable / disable (SPEC-control-plane.md §D.2, D.4 — Slice B; not part of
// upstream bin/thinkers, which has NO enable/disable subcommand at all: its
// `disabled` marker is a manual `touch`/`rm` convention only, checked by
// `_list_thinker_dirs`/`start` (see checkThinkerNames/enabledThinkerNames
// above). These two commands are new CLI surface for this port, built
// against that same marker semantics and SPEC-control-plane's own text:
//   enable <name>  — unlink <tdir>/disabled; print {ok,name,needsRestart}
//   disable <name> — if running, stop <name> first; touch <tdir>/disabled;
//                    print {ok,name,stoppedFirst}
// The two web-route descriptions (SPEC-control-plane.md lines 45-46) refine
// "running" to "state ∉ {stopped,disabled}" — i.e. skip the stop when the
// thinker is already disabled OR already stopped — which is what
// thinkerIsStopped + the alreadyDisabled check below implement.
// ---------------------------------------------------------------------------

/** True iff `name` has no active_thinkers membership, no live thinkers/<name>.pid,
 *  and no live step_pids entry — i.e. `disable` needs no stop first. */
function thinkerIsStopped(runDir: string, name: string): boolean {
  if (readActive(runDir).includes(name)) return false;
  try {
    const t = fs.readFileSync(path.join(runDir, "thinkers", `${name}.pid`), "utf8").trim();
    const tpid = parseInt(t, 10);
    if (Number.isFinite(tpid) && pidAlive(tpid)) return false;
  } catch {
    /* no thinker-owned pid file */
  }
  if (readStepPids(runDir).some((s) => s.name === name && pidAlive(s.pid))) return false;
  return true;
}

export interface EnableResult {
  ok: true;
  name: string;
  needsRestart: boolean;
}

/** `thinkers enable <name>` — unlink the disabled marker. */
export function thinkersEnable(env: Partial<ThinkersEnv>, name: string): EnableResult {
  const e = requireEnv(env);
  const dir = path.join(e.THINKERS_DIR, name);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Thinker not found: ${name}`);
  }
  rmQuiet(path.join(dir, "disabled"));
  const runDir = runDirOf(e.IDENTITY_DIR);
  const dpid = readPid(runDir);
  const needsRestart = dpid !== null && pidAlive(dpid);
  return { ok: true, name, needsRestart };
}

export interface DisableOptions extends StopOptions {}

export interface DisableResult {
  ok: true;
  name: string;
  stoppedFirst: boolean;
}

/** `thinkers disable <name>` — stop it first if not already stopped/disabled, then touch the marker. */
export async function thinkersDisable(env: Partial<ThinkersEnv>, name: string, opts: DisableOptions = {}): Promise<DisableResult> {
  const e = requireEnv(env);
  const dir = path.join(e.THINKERS_DIR, name);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Thinker not found: ${name}`);
  }
  const runDir = runDirOf(e.IDENTITY_DIR);
  const markerFile = path.join(dir, "disabled");
  const alreadyDisabled = fs.existsSync(markerFile);

  let stoppedFirst = false;
  if (!alreadyDisabled && !thinkerIsStopped(runDir, name)) {
    await thinkersStop(env, [name], opts);
    stoppedFirst = true;
  }

  // `touch`: create if missing, else leave content untouched (only mtime
  // would change, which nothing in this port reads).
  if (!alreadyDisabled) fs.writeFileSync(markerFile, "");

  return { ok: true, name, stoppedFirst };
}

export interface ThinkerListEntry {
  name: string;
  disabled: boolean;
  active: boolean;
}

export function thinkersList(env: Partial<ThinkersEnv>): ThinkerListEntry[] {
  const e = requireEnv(env);
  const runDir = runDirOf(e.IDENTITY_DIR);
  const active = new Set(readActive(runDir));
  return listThinkerDirs(e.THINKERS_DIR).map((name) => ({
    name,
    disabled: fs.existsSync(path.join(e.THINKERS_DIR, name, "disabled")),
    active: active.has(name),
  }));
}

export function thinkersLogs(env: Partial<ThinkersEnv>, name: string): string {
  const e = requireEnv(env);
  const file = path.join(runDirOf(e.IDENTITY_DIR), "logs", `${name}.log`);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** `thinkers status` text — line-by-line against bin/thinkers:1435-1537.
 *  Disabled thinkers are never listed (same `_list_thinker_dirs` filter as
 *  `start`/the dispatcher's own subscription scan): the marker means "not a
 *  thinker right now," not "a thinker in the disabled state." */
export function thinkersStatus(env: Partial<ThinkersEnv>): string {
  const e = requireEnv(env);
  const runDir = runDirOf(e.IDENTITY_DIR);
  const dpid = readPid(runDir);
  const running = dpid !== null && pidAlive(dpid);
  const dispatcherState = running ? `running (PID ${dpid})` : "stopped";

  const lines: string[] = [];
  lines.push(`Identity:   ${e.IDENTITY_NAME}`);
  lines.push(`Dispatcher: ${dispatcherState}`);
  if (dispatcherState !== "stopped") {
    lines.push(`Concurrency: ${e.THINKERS_MAX_CONCURRENT ?? "20"} max`);
  }
  lines.push("");
  lines.push("Thinkers:");

  const active = new Set(readActive(runDir));
  const liveCounts = new Map<string, number>();
  for (const s of readStepPids(runDir)) {
    if (pidAlive(s.pid)) liveCounts.set(s.name, (liveCounts.get(s.name) ?? 0) + 1);
  }

  for (const name of enabledThinkerNames(e.THINKERS_DIR)) {
    let status: string;
    if (dispatcherState === "stopped" || !active.has(name)) {
      status = "stopped";
    } else {
      const n = liveCounts.get(name) ?? 0;
      status = n > 0 ? `active (${n} step(s))` : "idle";
    }

    // A thinker `start` script's own tracked pid overrides the derived status.
    const thinkerPidText = (() => {
      try {
        return fs.readFileSync(path.join(runDir, "thinkers", `${name}.pid`), "utf8").trim();
      } catch {
        return "";
      }
    })();
    const tpid = thinkerPidText ? parseInt(thinkerPidText, 10) : NaN;
    if (Number.isFinite(tpid) && pidAlive(tpid)) status = `running (PID ${tpid})`;

    // Subscription types, first line only.
    let types = "all";
    try {
      const first = fs.readFileSync(path.join(e.THINKERS_DIR, name, "subscriptions.jsonl"), "utf8").split("\n")[0];
      if (first && first.trim()) {
        const obj = JSON.parse(first) as { types?: unknown };
        const t = Array.isArray(obj.types) ? obj.types.map(String) : [];
        types = t.length > 0 ? t.join(", ") : "all";
      }
    } catch {
      types = "all";
    }

    // Log line count.
    let logInfo = "";
    try {
      const content = fs.readFileSync(path.join(runDir, "logs", `${name}.log`), "utf8");
      const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      logInfo = ` (${lineCount} log lines)`;
    } catch {
      /* no log file yet */
    }

    // Pending re-trigger queue, counted per step type (bin/thinkers:1521-1534).
    let pendingInfo = "";
    try {
      const files = fs.readdirSync(path.join(runDir, "pending")).filter((f) => f.startsWith(`${name}.`));
      const counts = new Map<string, number>();
      for (const f of files) {
        const rest = f.slice(name.length + 1);
        const type = rest.split(".")[0] ?? "";
        if (!type) continue;
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      if (counts.size > 0) {
        const parts = [...counts.keys()].sort().map((t) => `${t} x${counts.get(t)}`);
        pendingInfo = ` (pending: ${parts.join(", ")})`;
      }
    } catch {
      /* no pending dir yet */
    }

    lines.push(`  ${name.padEnd(30)} ${status}  [${types}]${logInfo}${pendingInfo}`);
  }
  return `${lines.join("\n")}\n`;
}
