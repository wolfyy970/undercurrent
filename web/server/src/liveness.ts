// Session liveness + activity classification.
// Ports headlong/web/src/headlong_web/{liveness,activity,thinkers}.py (Apache-2.0),
// keeping the state machine; process/ps probes are best-effort on this host.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IdentityInfo } from "./discovery.ts";
import { findRootTrajDir } from "./discovery.ts";

const RECENT_SECONDS = 30;

export interface Status {
  live: boolean;
  pid_alive: boolean;
  dispatcher_pid: number | null;
  mindlog_mtime: number | null; // epoch seconds
  mindlog_bytes: number | null;
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
    process.kill(pid, 0); // signal 0: existence check, doesn't kill
    return [true, pid];
  } catch {
    return [false, pid];
  }
}

export function identityStatus(identityDir: string, mindlogPath: string | null): Status {
  const [alive, pid] = pidAlive(join(identityDir, "run", "dispatcher.pid"));
  let mtime: number | null = null;
  let size: number | null = null;
  if (mindlogPath) {
    try {
      const st = statSync(mindlogPath);
      mtime = st.mtimeMs / 1000;
      size = st.size;
    } catch {
      /* ignore */
    }
  }
  const recent = mtime !== null && Date.now() / 1000 - mtime < RECENT_SECONDS;
  return {
    live: alive || recent,
    pid_alive: alive,
    dispatcher_pid: pid,
    mindlog_mtime: mtime,
    mindlog_bytes: size,
  };
}

export function isoOrNull(ts: number | null): string | null {
  if (ts === null) return null;
  return new Date(ts * 1000).toISOString();
}

// ---- activity ------------------------------------------------------------

const STALL_FLOOR_S = 300;
const STALL_CADENCE_FACTOR = 4.0;
const CADENCE_WINDOW_STEPS = 60;
const TAIL_BYTES = 512 * 1024;

const TS_FIXUP = /([+-]\d\d)(\d\d)$/;

export function parseTs(ts: string): number | null {
  if (!ts) return null;
  const fixed = ts.replace(TS_FIXUP, "$1:$2");
  const ms = Date.parse(fixed);
  if (Number.isNaN(ms)) return null;
  return ms / 1000;
}

function tailSteps(jsonl: string): Raw[] {
  let text: string;
  try {
    const size = statSync(jsonl).size;
    const buf = readFileSync(jsonl);
    if (size > TAIL_BYTES) {
      let start = size - TAIL_BYTES;
      const nl = buf.indexOf(0x0a, start);
      start = nl === -1 ? start : nl + 1;
      text = buf.subarray(start).toString("utf-8");
    } else {
      text = buf.toString("utf-8");
    }
  } catch {
    return [];
  }
  const steps: Raw[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const step = JSON.parse(t);
      if (step && typeof step === "object") steps.push(step);
    } catch {
      /* skip */
    }
  }
  return steps;
}

type Raw = Record<string, unknown>;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stepCadenceS(steps: Raw[]): number | null {
  const window = steps.slice(-CADENCE_WINDOW_STEPS);
  const times: number[] = [];
  for (const step of window) {
    const ts = parseTs(String(step["ts"] ?? ""));
    if (ts !== null) times.push(ts);
  }
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && d < 3600) gaps.push(d);
  }
  if (gaps.length < 5) return null;
  return median(gaps);
}

function liveStepsByThinker(runDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let lines: string[];
  try {
    lines = readFileSync(join(runDir, "step_pids"), "utf-8").split("\n");
  } catch {
    return counts;
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
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

export type ActivityState = "working" | "stalled" | "idle" | "asleep";

export interface Activity {
  state: ActivityState;
  dispatcher_running: boolean;
  steps_in_flight: number;
  busy_thinkers: string[];
  last_step_ts: string | null;
  last_step_age_s: number | null;
  run_seconds: number | null;
  stall_after_s: number;
  cadence_s: number | null;
  queued_messages: unknown[];
  pending_total: number;
}

export function identityActivity(identity: IdentityInfo): Activity {
  const now = Date.now() / 1000;
  const runDir = join(identity.path, "run");
  const [dispatcherAlive] = pidAlive(join(runDir, "dispatcher.pid"));
  const liveSteps = liveStepsByThinker(runDir);
  const stepsInFlight = Object.values(liveSteps).reduce((a, b) => a + b, 0);

  let lastAppend: number | null = null;
  let cadence: number | null = null;
  const trajDir = findRootTrajDir(identity);
  if (trajDir) {
    const jsonl = join(trajDir, "trajectory.jsonl");
    try {
      lastAppend = statSync(jsonl).mtimeMs / 1000;
    } catch {
      /* ignore */
    }
    cadence = stepCadenceS(tailSteps(jsonl));
  }

  let stallAfter = STALL_FLOOR_S;
  if (cadence !== null) stallAfter = Math.max(stallAfter, STALL_CADENCE_FACTOR * cadence);
  const lastAge = lastAppend !== null ? now - lastAppend : null;

  let state: ActivityState;
  if (!dispatcherAlive) state = "asleep";
  else if (stepsInFlight === 0) state = "idle";
  else if (lastAge !== null && lastAge > stallAfter) state = "stalled";
  else state = "working";

  return {
    state,
    dispatcher_running: dispatcherAlive,
    steps_in_flight: stepsInFlight,
    busy_thinkers: Object.keys(liveSteps).sort(),
    last_step_ts: isoOrNull(lastAppend),
    last_step_age_s: lastAge !== null ? Math.round(lastAge * 10) / 10 : null,
    run_seconds: null, // ps-etime probe omitted; null when nothing in flight anyway
    stall_after_s: Math.round(stallAfter * 10) / 10,
    cadence_s: cadence !== null ? Math.round(cadence * 10) / 10 : null,
    queued_messages: [],
    pending_total: 0,
  };
}
