// Per-identity thinker status for the Thinkers view.
// Port of the read-only parts of headlong/web/src/headlong_web/thinkers.py
// (Apache-2.0). Control (start/stop/step) is disabled in this read-only port.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pidAlive(pidFile: string): [boolean, number | null] {
  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return [false, null];
  }
  if (!Number.isFinite(pid)) return [false, null];
  try {
    process.kill(pid, 0);
    return [true, pid];
  } catch {
    return [false, pid];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isDisabled(thinkerDir: string): boolean {
  return existsSync(join(thinkerDir, "disabled"));
}

function listThinkerDirs(identityDir: string): string[] {
  const root = join(identityDir, "thinkers");
  if (!isDir(root)) return [];
  const result: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith("_")) continue;
    const dir = join(root, name);
    if (!isDir(dir)) continue;
    if (!existsSync(join(dir, "subscriptions.jsonl"))) continue;
    result.push(dir);
  }
  return result;
}

function subscriptionInfo(thinkerDir: string): [string[], boolean] {
  try {
    const first = readFileSync(join(thinkerDir, "subscriptions.jsonl"), "utf-8").split("\n")[0];
    const sub = JSON.parse(first);
    const types = (sub.types && sub.types.length ? sub.types : ["all"]).map(String);
    return [types, Boolean(sub.trigger_self)];
  } catch {
    return [["all"], false];
  }
}

function liveStepsByThinker(runDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of readLines(join(runDir, "step_pids"))) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const name = parts.slice(1).join(" ");
    try {
      process.kill(pid, 0);
      counts[name] = (counts[name] ?? 0) + 1;
    } catch {
      /* not running */
    }
  }
  return counts;
}

function pendingByThinker(runDir: string): Record<string, string[]> {
  const pending: Record<string, string[]> = {};
  const dir = join(runDir, "pending");
  if (!isDir(dir)) return pending;
  for (const name of readdirSync(dir)) {
    const parts = name.split(".");
    if (parts.length < 2) continue;
    (pending[parts[0]] ??= []).push(parts[1]);
  }
  return pending;
}

export function thinkersStatus(identityDir: string) {
  const runDir = join(identityDir, "run");
  const [dispatcherAlive, dispatcherPid] = pidAlive(join(runDir, "dispatcher.pid"));
  const activeSet = new Set(readLines(join(runDir, "active_thinkers")));
  const liveSteps = liveStepsByThinker(runDir);
  const pending = pendingByThinker(runDir);

  const thinkers = listThinkerDirs(identityDir).map((thinkerDir) => {
    const name = thinkerDir.split("/").pop()!;
    const [types, triggerSelf] = subscriptionInfo(thinkerDir);
    const stepsInFlight = liveSteps[name] ?? 0;
    const [daemonAlive, daemonPid] = pidAlive(join(runDir, "thinkers", `${name}.pid`));

    let state: string;
    if (isDisabled(thinkerDir)) state = "disabled";
    else if (daemonAlive) state = "running";
    else if ((!dispatcherAlive || !activeSet.has(name)) && stepsInFlight > 0) state = "draining";
    else if (!dispatcherAlive || !activeSet.has(name)) state = "stopped";
    else if (stepsInFlight > 0) state = "active";
    else state = "idle";

    let logBytes: number | null = null;
    let logMtime: string | null = null;
    try {
      const st = statSync(join(runDir, "logs", `${name}.log`));
      logBytes = st.size;
      logMtime = new Date(st.mtimeMs).toISOString();
    } catch {
      /* no log */
    }

    return {
      name,
      state,
      steps_in_flight: stepsInFlight,
      pid: daemonAlive ? daemonPid : null,
      types,
      trigger_self: triggerSelf,
      pending: pending[name] ?? [],
      log_bytes: logBytes,
      log_mtime: logMtime,
    };
  });

  const enabledCount = thinkers.filter((t) => t.state !== "disabled").length;
  return {
    dispatcher: { running: dispatcherAlive, pid: dispatcherAlive ? dispatcherPid : null },
    active_thinkers: dispatcherAlive ? activeSet.size : 0,
    thinkers_total: enabledCount,
    thinkers_disabled: thinkers.length - enabledCount,
    steps_in_flight: Object.values(liveSteps).reduce((a, b) => a + b, 0),
    pending_total: Object.values(pending).reduce((a, b) => a + b.length, 0),
    thinkers,
  };
}

/** Cheap subset merged into each GET /api/identities item. */
export function thinkersSummary(identityDir: string) {
  const runDir = join(identityDir, "run");
  const [dispatcherAlive, dispatcherPid] = pidAlive(join(runDir, "dispatcher.pid"));
  const thinkerNames = new Set(listThinkerDirs(identityDir).map((d) => d.split("/").pop()!));
  const activeSet = new Set(readLines(join(runDir, "active_thinkers")).filter((n) => thinkerNames.has(n)));
  const liveSteps = liveStepsByThinker(runDir);
  const inFlight = Object.values(liveSteps).reduce((a, b) => a + b, 0);
  return {
    dispatcher: { running: dispatcherAlive, pid: dispatcherAlive ? dispatcherPid : null },
    thinkers_total: thinkerNames.size,
    thinkers_active: dispatcherAlive ? activeSet.size : 0,
    steps_in_flight: dispatcherAlive ? inFlight : 0,
  };
}
