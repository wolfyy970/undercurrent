// daemon.ts — the resident per-identity dispatcher loop (PLAN-daemon §3).
//
// The daemon NEVER imports the engine (monolith/responder/retrieval) — it
// only routes and spawns. Every thinker wake is a detached child process:
// `<identity>/thinkers/<name>/step` (a Node file), stdin = the trigger JSON,
// stdout+stderr appended to run/logs/<name>.log. This keeps a crashing wake
// from ever taking the daemon down, and keeps step_pids honest (the daemon's
// OWN pid is never a thinker's pid, so `thinkers stop --drain` never TERMs
// the daemon by mistake).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { resolveIdentityEnv } from "./identity-env.ts";
import { resolveTrajFile } from "./trajectory.ts";
import { TrajFeeder } from "./feeder.ts";
import {
  runDirOf,
  readPid,
  writePid,
  pidAlive,
  newToken,
  readToken,
  writeToken,
  removeToken,
  isActive,
  appendStepPid,
  writeStepPids,
  liveStepPids,
  truncateStepPids,
  writeSubMap,
  removeSubMap,
  writeTrajFiles,
  removeTrajFiles,
  removeFbInjected,
  removeDeliberateStop,
  deliberateStopAgeS,
  removeLastSignal,
  writeLastSignal,
  rmQuiet,
  killTree,
  FilePendingStore,
  type SubMapLine,
} from "./runstate.ts";
import { Dispatcher, type ThinkerDef, type TriggerStep } from "./dispatcher.ts";
import { isoEpoch } from "./stepGuards.ts";
import { WakeLedger, readCursor, writeCursor } from "./wakeLedger.ts";

const TICK_MS = 1000;
const DELIBERATE_STOP_WINDOW_S = 60;
const DEFAULT_WATCHDOG_SECS = 300; // THINKERS_WATCHDOG_SECS
const DEFAULT_REWIND_TOLERANCE_SECS = 600; // THINKERS_REWIND_TOLERANCE (0 disables)
const DEFAULT_STEP_GRACE_SECS = 300; // THINKERS_STEP_GRACE (0 disables)
const DEFAULT_STEP_QUIET_SECS = 5400; // THINKERS_STEP_QUIET (0 disables); above shellm's one-block limit (3600s)

/** bash `${VAR:-default}` followed by an integer use: empty/unset -> default; anything that is not a plain integer -> default too. */
function envSecs(v: string | undefined, dflt: number): number {
  return v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : dflt;
}

/** The pids of the live steps by thinker name — the stuck-step guard's kill targets. */
const stepPids = new Map<string, number>();

/** `ps -o pid=,etime=,args= -g <pid>` minus the step's own line, 120 columns each, `;`-joined (the STUCK log's "still alive" list). */
function groupSurvivors(pid: number): string {
  try {
    const r = spawnSync("ps", ["-o", "pid=,etime=,args=", "-g", String(pid)], { encoding: "utf8", timeout: 3000 });
    return (r.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim() !== "" && !new RegExp(`^ *${pid} `).test(l))
      .map((l) => l.slice(0, 120))
      .join(";");
  } catch {
    return "";
  }
}

/** Epoch of the last line of a trajectory file (the rewind cursor seed); null when absent/unparseable. */
function lastStepEpoch(file: string): number | null {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/\n+$/, "");
    const last = text.slice(text.lastIndexOf("\n") + 1);
    if (!last) return null;
    const m = /.*"ts":"([^"]*)"/.exec(last);
    return m ? isoEpoch(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// thinker dir enumeration + subscription parsing (bin/thinkers:217-312)
// ---------------------------------------------------------------------------

interface RawSub {
  thinkerName: string;
  trajId: string;
  types: string[];
  triggerSelf: boolean;
  watchdogSecs: number;
}

function listThinkerDirs(thinkersDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(thinkersDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (n.startsWith("_")) continue;
    const dir = path.join(thinkersDir, n);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(dir, "disabled"))) continue;
    if (!fs.existsSync(path.join(dir, "step"))) continue;
    if (!fs.existsSync(path.join(dir, "subscriptions.jsonl"))) continue;
    out.push(n);
  }
  return out;
}

function parseSubscriptions(thinkersDir: string, defaultTrajId: string, noSelfTrigger: boolean): RawSub[] {
  const out: RawSub[] = [];
  for (const name of listThinkerDirs(thinkersDir)) {
    const subFile = path.join(thinkersDir, name, "subscriptions.jsonl");
    let text: string;
    try {
      text = fs.readFileSync(subFile, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const types = Array.isArray(obj["types"]) ? (obj["types"] as unknown[]).map(String) : [];
      let triggerSelf = obj["trigger_self"] === true;
      if (noSelfTrigger) triggerSelf = false;
      let watchdogSecs = typeof obj["watchdog_secs"] === "number" ? Math.trunc(obj["watchdog_secs"] as number) : NaN;
      if (!Number.isFinite(watchdogSecs) || watchdogSecs < 0) {
        watchdogSecs = triggerSelf ? DEFAULT_WATCHDOG_SECS : 0;
      }
      const trajId = typeof obj["traj_id"] === "string" && obj["traj_id"] ? (obj["traj_id"] as string) : defaultTrajId;
      out.push({ thinkerName: name, trajId, types, triggerSelf, watchdogSecs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DaemonOptions / boot
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  identityDir: string;
  env?: Record<string, string>;
  noSelfTrigger?: boolean;
  tickMs?: number;
  now?: () => number; // epoch seconds
  log?: (line: string) => void; // defaults to appending run/logs/dispatcher.log
}

export interface DaemonHandle {
  runDir: string;
  dispatcher: Dispatcher;
  stop(): void; // test-facing: clears the interval and closes feeders WITHOUT the cleanup side effects (a real SIGTERM does that)
}

/** Append one ALREADY-FORMATTED line to dispatcher.log (no prefix added here —
 *  Dispatcher's logSink calls this with lines it has already formatted via
 *  its own emitLog; daemon-originated lines are formatted by formatLogLine
 *  below before reaching this). */
function appendLog(runDir: string, line: string): void {
  try {
    fs.appendFileSync(path.join(runDir, "logs", "dispatcher.log"), `${line}\n`);
  } catch {
    /* best effort */
  }
}

function formatLogLine(text: string): string {
  return `${new Date().toISOString()} [dispatcher] ${text}`;
}

/** Boot the daemon and start its tick loop. Returns once boot state is
 *  written (pid/token/sub_map/traj_files/empty pending); the tick interval
 *  keeps the process alive (NOT unref'd) until a signal or ownership loss. */
export function bootDaemon(opts: DaemonOptions): DaemonHandle {
  // Install signal handlers FIRST, before any other boot work (env/subs
  // parsing, dispatcher setup, feeder start-up below can all do real I/O).
  // Node only takes over SIGTERM/SIGINT's disposition once `process.on` is
  // called for it; a signal delivered before that falls through to the
  // kernel's default (ungraceful, un-catchable) terminate action instead of
  // our exit(0)/exit(130) contract. Under normal load the gap between
  // process start and the old registration point (after boot finished) was
  // sub-millisecond and never observed; under heavy CPU contention it can
  // widen enough for a test's "poll for dispatcher.token, then kill" to land
  // the signal inside that window — seen as the child's 'exit' event
  // reporting `code === null` (signal-killed) instead of 130. `onSignal` and
  // `log` below are only referenced here via closure, not called until well
  // after those consts exist, so registering before their declarations is
  // safe (a signal can only actually invoke the callback once this whole
  // synchronous function body has finished running).
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("uncaughtException", (err) => {
    log(`uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    cleanup();
    process.exit(1);
  });

  const env = opts.env ?? resolveIdentityEnv(opts.identityDir);
  const identityDir = env["IDENTITY_DIR"];
  const trajDir = env["TRAJ_DIR"];
  const trajId = env["TRAJ_ID"];
  const thinkersDir = env["THINKERS_DIR"];
  if (!identityDir || !trajDir || !trajId || !thinkersDir) {
    process.stderr.write("dispatcherd: IDENTITY_DIR/TRAJ_DIR/TRAJ_ID/THINKERS_DIR unresolvable\n");
    process.exit(1);
  }

  const runDir = runDirOf(identityDir);
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "thinkers"), { recursive: true });

  const existingPid = readPid(runDir);
  if (existingPid !== null && existingPid !== process.pid && pidAlive(existingPid)) {
    process.stderr.write(`Dispatcher already running (PID ${existingPid}). Use \`thinkers stop\` first.\n`);
    process.exit(1);
  }

  rmQuiet(path.join(runDir, "pending"));
  fs.mkdirSync(path.join(runDir, "pending"), { recursive: true });
  removeFbInjected(runDir);
  removeDeliberateStop(runDir);
  removeLastSignal(runDir);

  const ownToken = env["HEADLONG_DISPATCHER_TOKEN"] ?? newToken();
  writeToken(runDir, ownToken);

  const noSelfTrigger = opts.noSelfTrigger ?? env["NO_SELF_TRIGGER"] === "1";
  const rawSubs = parseSubscriptions(thinkersDir, trajId, noSelfTrigger);
  if (rawSubs.length === 0) {
    process.stderr.write("dispatcherd: No valid subscriptions found\n");
    process.exit(1);
  }

  const subMapRows: SubMapLine[] = [];
  const trajFilesSeen: string[] = [];
  const byThinker = new Map<string, { types: string[]; triggerSelf: boolean; watchdogSecs: number; trajFile: string }>();
  for (const s of rawSubs) {
    const trajFile = resolveTrajFile(trajDir, s.trajId) ?? path.join(trajDir, s.trajId);
    if (!trajFilesSeen.includes(trajFile)) trajFilesSeen.push(trajFile);
    subMapRows.push({ name: s.thinkerName, trajFile, types: s.types, triggerSelf: s.triggerSelf, watchdog: s.watchdogSecs });

    const merged = byThinker.get(s.thinkerName);
    if (!merged) {
      byThinker.set(s.thinkerName, { types: [...s.types], triggerSelf: s.triggerSelf, watchdogSecs: s.watchdogSecs, trajFile });
    } else {
      // PORT-NOTE (PARITY.md): multiple subscription lines for one thinker are
      // merged (union types, OR trigger_self, min nonzero watchdog) rather than
      // routed independently — the shipped thinkers each have exactly one line.
      for (const t of s.types) if (!merged.types.includes(t)) merged.types.push(t);
      merged.triggerSelf = merged.triggerSelf || s.triggerSelf;
      if (s.watchdogSecs > 0) merged.watchdogSecs = merged.watchdogSecs > 0 ? Math.min(merged.watchdogSecs, s.watchdogSecs) : s.watchdogSecs;
    }
  }
  writeSubMap(runDir, subMapRows);
  writeTrajFiles(runDir, trajFilesSeen);

  truncateStepPids(runDir);
  if (readPid(runDir) === null) writePid(runDir, process.pid);

  const pending = new FilePendingStore(path.join(runDir, "pending"));
  // Lost-wake fix: durable receipts for message/action wakes (wakeLedger.ts). Set THINKERS_WAKE_LEDGER=0 for
  // upstream's behaviour (a restart forgets whatever was queued or missed).
  const ledger = env["THINKERS_WAKE_LEDGER"] === "0" ? undefined : new WakeLedger(runDir);
  ledger?.load();
  // `log`: daemon-originated messages — formats the "<ISO> [dispatcher] …"
  // prefix itself. `rawLog`: Dispatcher's logSink — Dispatcher.emitLog
  // already formats that prefix, so this appends verbatim (no double prefix).
  const rawLog = opts.log ?? ((line: string) => appendLog(runDir, line));
  const log = (text: string): void => rawLog(formatLogLine(text));

  // Populated below, AFTER `dispatcher` (their onLine calls dispatcher.feed);
  // referenced by `appendTo` above via closure — by the time appendTo is
  // actually called (well after boot), this array is filled in.
  const feeders: TrajFeeder[] = [];

  const dispatcher = new Dispatcher(null, {
    stateDir: runDir,
    identityName: env["IDENTITY_NAME"] ?? "",
    pending,
    ...(ledger ? { ledger } : {}),
    maxConcurrent: Number(env["THINKERS_MAX_CONCURRENT"] ?? 20),
    // THINKERS_CLAIM_STALE_SECS: bash `${VAR:-30}` (empty means the default); a non-number never matches a
    // `(( age < stale ))` comparison sensibly, so fall back to the default instead of NaN.
    claimStaleSecs: /^[0-9]+$/.test(env["THINKERS_CLAIM_STALE_SECS"] ?? "") ? Number(env["THINKERS_CLAIM_STALE_SECS"]) : 30,
    // THINKERS_TEST_DIE_AFTER_CLAIM: fault injection, "any set value" (`[[ -n ... ]]`)
    dieAfterClaim: (env["THINKERS_TEST_DIE_AFTER_CLAIM"] ?? "") !== "",
    isActive: (name) => isActive(runDir, name),
    appendTo: (trajFile, record) => {
      const id = appendToTrajFile(trajFile, record);
      // Dispatcher.appendRecord() delivers this SAME record synchronously
      // via its own feed() call right after this returns (mirroring the
      // in-process ObservableTrajectory path, and upstream's own tight
      // causality: a step it appends to a trajectory it is ALREADY tailing
      // — the salience `feedback` injection — is discovered by its `tail -F`
      // pipe inside the very same read-loop pass, not on a later tick). The
      // matching feeder must NOT also deliver it via its regular poll/watch
      // once the bytes are on disk — resync it past what we just wrote.
      const f = feeders.find((x) => x.file === trajFile);
      if (f) f.resync();
      return id;
    },
    logSink: rawLog,
    guards: {
      rewindToleranceSecs: envSecs(env["THINKERS_REWIND_TOLERANCE"], DEFAULT_REWIND_TOLERANCE_SECS),
      stepGraceSecs: envSecs(env["THINKERS_STEP_GRACE"], DEFAULT_STEP_GRACE_SECS),
      stepQuietSecs: envSecs(env["THINKERS_STEP_QUIET"], DEFAULT_STEP_QUIET_SECS),
      stepPid: (name) => stepPids.get(name),
      kill: (pid, sig) => killTree(pid, sig),
      firstTrajFile: () => trajFilesSeen[0],
      survivors: groupSurvivors,
    },
  });
  // Rewind cursor: seeded from the last line already in each traj file so the very first replayed step is caught.
  for (const file of trajFilesSeen) dispatcher.seedRewindCursor(lastStepEpoch(file));

  for (const [name, sub] of byThinker) {
    const def: ThinkerDef = {
      name,
      subscription: { types: sub.types, triggerSelf: sub.triggerSelf, watchdogSecs: sub.watchdogSecs, trajFile: sub.trajFile },
      run: (trigger: TriggerStep) => spawnStep(runDir, thinkersDir, identityDir, env, name, trigger),
    };
    dispatcher.register(def);
  }

  // Cursor gap: lines appended while no dispatcher was running. Read [cursor, end of complete lines) now, feed the
  // ledgered types as replays, and start the feeder exactly where that read ended. No cursor yet (first start with
  // the fix) or a replaced file: upstream's start at end of file.
  const startFrom = new Map<string, { ino: number; offset: number }>();
  const writeCursorFor = (file: string, pos: { ino: number; offset: number } | null): void => {
    if (!ledger || !pos) return;
    try {
      writeCursor(runDir, { file, ino: pos.ino, offset: pos.offset });
    } catch {
      /* best effort: a missed cursor write only widens the replay window */
    }
  };
  if (ledger) {
    // Older debts first: steps owed from a previous run go ahead of anything found in the cursor gap.
    const r = dispatcher.replayOwed(() => trajFilesSeen[0]);
    if (r.requeued + r.answered + r.released > 0) {
      log(`wake ledger: ${r.requeued} owed step(s) re-queued, ${r.answered} already answered in the trajectory, ${r.released} released (thinker off)`);
    }
    for (const file of trajFilesSeen) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cur = readCursor(runDir, file);
      if (!cur || cur.ino !== st.ino || cur.offset > st.size) {
        if (cur) log(`cursor for ${file} does not match the file (inode/size changed) — starting at end of file`);
        writeCursorFor(file, { ino: st.ino, offset: st.size });
        continue;
      }
      let end = cur.offset;
      if (st.size > cur.offset) {
        const buf = Buffer.alloc(st.size - cur.offset);
        let fd: number | undefined;
        try {
          fd = fs.openSync(file, "r");
          const n = fs.readSync(fd, buf, 0, buf.length, cur.offset);
          const data = buf.subarray(0, n);
          const lastNl = data.lastIndexOf(0x0a);
          if (lastNl >= 0) {
            end = cur.offset + lastNl + 1;
            for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) {
              if (!line) continue;
              let step: TriggerStep;
              try {
                step = JSON.parse(line) as TriggerStep;
              } catch {
                continue;
              }
              dispatcher.feed(step, file, { replay: true });
            }
          }
        } catch (e) {
          log(`cursor replay read failed: ${file}: ${(e as Error).message}`);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
      startFrom.set(file, { ino: st.ino, offset: end });
      writeCursorFor(file, { ino: st.ino, offset: end });
    }
  }

  for (const file of trajFilesSeen) {
    const f = new TrajFeeder(file, {
      onAdvance: (pos) => writeCursorFor(file, pos),
      // A file replaced or truncated under the feeder: it has restarted at end of file, history is not
      // replayed; say so, and leave one error step for the operator (bin/thinkers `_respawn_dead_feeders`).
      onSwap: (e) => {
        log(
          `TRAJECTORY REPLACED: ${file} changed under its feeder (inode ${e.oldIno} -> ${e.newIno}, size ${e.oldSize} -> ${e.newSize}) — restarting the feeder at end of file; history is not replayed. The trajectory is append-only; whatever rewrote it is a bug.`
        );
        dispatcher.appendOperatorError(
          file,
          "trajectory-replaced",
          `dispatcher: the trajectory file was replaced or truncated under its feeder (inode ${e.oldIno} -> ${e.newIno}, size ${e.oldSize} -> ${e.newSize}). The feeder was restarted at end of file and history was not replayed. The trajectory is append-only: never rewrite, copy over, or truncate trajectory.jsonl.`
        );
      },
      onLine: (line) => {
        let step: TriggerStep;
        try {
          step = JSON.parse(line) as TriggerStep;
        } catch {
          log(`malformed trajectory line skipped: ${file}`);
          return;
        }
        dispatcher.feed(step, file);
      },
    });
    f.start(startFrom.get(file));
    feeders.push(f);
  }

  // No boot line: upstream's own dispatcher loop never logs one (bin/thinkers
  // has no `[dispatcher] boot: …` printf) — dropped to match dispatcher.log
  // byte-for-byte instead of inventing a line upstream doesn't emit.
  let stopped = false;
  const interval = setInterval(() => tick(), opts.tickMs ?? TICK_MS);
  // Deliberately NOT unref'd — the tick is the daemon's keep-alive.

  function tick(): void {
    if (stopped) return;
    const nowS = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
    const currentToken = readToken(runDir);
    if (currentToken === null || currentToken !== ownToken) {
      log(`ownership lost (newer start or stop) — exiting`);
      stop();
      process.exit(0); // WITHOUT cleanup: the newer owner's state must survive
    }
    dispatcher.tick(nowS);
    pruneStepPids();
    for (const f of feeders) {
      f.poll();
      if (ledger) writeCursorFor(f.file, f.position()); // also covers resync() past the dispatcher's own appends
    }
  }

  function pruneStepPids(): void {
    const live = liveStepPids(runDir);
    writeStepPids(runDir, live);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    for (const f of feeders) f.close();
  }

  function cleanup(): void {
    stop();
    removeSubMap(runDir);
    removeTrajFiles(runDir);
    removeToken(runDir);
    rmQuiet(path.join(runDir, "pending"));
    // dispatcher.pid is removed by the CLI, not here; in-flight steps are
    // never killed by the daemon's own exit.
  }

  const onSignal = (sig: NodeJS.Signals): void => {
    const age = deliberateStopAgeS(runDir);
    if (age !== null && age < DELIBERATE_STOP_WINDOW_S) {
      removeDeliberateStop(runDir);
      cleanup();
      process.exit(0);
    } else {
      writeLastSignal(runDir, sig);
      cleanup();
      process.exit(130);
    }
  };
  // Handler *registration* itself happens at the very top of this function
  // (see the `process.on(...)` calls right after `bootDaemon` opens) — before
  // dispatcher.token or any other boot state exists — so a signal delivered
  // the instant a test observes that state can never race Node's own default
  // (ungraceful, un-catchable) SIGTERM/SIGINT disposition. `onSignal` and
  // `log` are only *referenced* there via closure and aren't called until
  // well after this point, once these consts exist.

  return { runDir, dispatcher, stop };
}

// trajCore.mjs is the shim-safe append primitive (node builtins only) — using
// it here for the dispatcher's salience `feedback` injection stays within the
// daemon's "never imports the engine" rule (PLAN-daemon §1): trajCore is the
// same low-level file-append the daemon already depends on transitively via
// steps, not the cognition engine (monolith/responder/retrieval).
import { appendStep as trajCoreAppendStep } from "./trajCore.mjs";

function appendToTrajFile(trajFile: string, record: Record<string, unknown>): string {
  return trajCoreAppendStep(trajFile, record, {});
}

function spawnStep(
  runDir: string,
  thinkersDir: string,
  identityDir: string,
  env: Record<string, string>,
  name: string,
  trigger: TriggerStep
): Promise<number> {
  return new Promise((resolve) => {
    const scriptPath = path.join(thinkersDir, name, "step");
    const logPath = path.join(runDir, "logs", `${name}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(scriptPath, [], {
      cwd: identityDir,
      detached: true,
      env: { ...env, SHELLM_LAUNCHED_BY: name },
      stdio: ["pipe", logFd, logFd],
    });
    child.stdin!.end(JSON.stringify(trigger));
    if (typeof child.pid === "number") {
      appendStepPid(runDir, child.pid, name);
      stepPids.set(name, child.pid);
    }
    child.unref();
    child.once("exit", (code, signal) => {
      if (stepPids.get(name) === child.pid) stepPids.delete(name);
      fs.closeSync(logFd);
      const live = liveStepPids(runDir);
      writeStepPids(runDir, live);
      resolve(code === null ? (signal ? 128 : 1) : code); // the exit code: non-zero leaves a ledgered message owed
    });
    child.once("error", () => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* already closed */
      }
      resolve(1);
    });
  });
}

/** bin/dispatcherd.mjs's whole body. */
export function main(): void {
  process.stderr.write(`dispatcherd: node ${process.version}\n`);
  bootDaemon({ identityDir: process.env["IDENTITY_DIR"] ?? process.cwd() });
}
