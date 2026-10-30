// runstate.ts — the `<identity>/run/` state-file contract (PLAN-daemon §4;
// bin/thinkers). One function per file, exact bytes, atomic writes.
//
// Shim-safe dialect on purpose: node builtins only (type-only sibling imports),
// so the daemon, the CLIs and the web data layer can all load it from source
// without pulling the engine in. Every reader of run/ (web liveness, the TUI
// via `thinkers status`, upstream's own CLIs) keys on these exact bytes:
//
//   dispatcher.pid    "<pid>"                         no trailing newline
//   dispatcher.token  32 hex chars (16 random bytes)  no trailing newline
//   active_thinkers   "<name>\n" per line
//   step_pids         "<pid> <name>\n" per line       SPACE separated (bin/thinkers:520,562)
//   pending/<name>.<type>.<epoch10>.<seq %06d>       compact step JSON, no newline
//   pending/<name>.<type>.coalesced                   compact step JSON, no newline
//   sub_map           "<name>\t<traj_file>\t<types|>\t<true|false>\t<watchdog>\n"
//   traj_files        "<abs path>\n" per unique file
//   <name>.wake_at    "<epoch>"                       no trailing newline
//   fb_injected       "<step_id>\n" per line
//   deliberate_stop   empty; its mtime is the signal
//   last_signal       "SIGTERM\n"
//
// Atomic write = `<file>.tmp` + rename (upstream: step_pids.tmp / mv,
// active_thinkers.tmp / mv). Files upstream writes with a bare `printf >` are
// written the same way here — the bytes are identical and a torn read is one
// failure mode fewer.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { PendingEntry, PendingPushResult, PendingStore, TriggerStep } from "./dispatcher.ts";

export const MAX_FIFO = 16; // bin/thinkers:831 — per thinker+type, drop-oldest

export function runDirOf(identityDir: string): string {
  return path.join(identityDir, "run");
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** Write `data` to `file` via `<file>.tmp` + rename. */
export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {
    /* ignore */
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Non-empty lines of a file (`grep .`); [] when absent. */
function readLines(file: string): string[] {
  const t = readText(file);
  if (t === null) return [];
  return t.split("\n").filter((l) => l.length > 0);
}

/**
 * `kill -0 <pid>`: true when the process exists. EPERM (exists, not ours)
 * counts as ALIVE — exactly like `kill -0`, which fails with EPERM but the
 * shell scripts only ever test the exit status of a pid they own; the web
 * readers (liveness.ts) must agree with this.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * _kill_tree (bin/thinkers:39-46): kill a process and all its descendants,
 * depth-first (children before the parent), from ONE `ps -axo pid=,ppid=`
 * snapshot. Errors (already gone) are ignored, like `kill … || true`.
 */
export function killTree(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
  const children = new Map<number, number[]>();
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const p = Number(m[1]);
    const pp = Number(m[2]);
    const arr = children.get(pp) ?? [];
    arr.push(p);
    children.set(pp, arr);
  }
  const visit = (p: number, depth: number): void => {
    if (depth > 64) return;
    for (const c of children.get(p) ?? []) visit(c, depth + 1);
    try {
      process.kill(p, sig);
    } catch {
      /* already gone */
    }
  };
  visit(pid, 0);
}

// ---------------------------------------------------------------------------
// dispatcher.pid
// ---------------------------------------------------------------------------

export function readPid(runDir: string): number | null {
  const t = readText(path.join(runDir, "dispatcher.pid"));
  if (t === null) return null;
  const n = parseInt(t.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** `printf '%s' "$pid" > dispatcher.pid` — no newline. */
export function writePid(runDir: string, pid: number): void {
  writeAtomic(path.join(runDir, "dispatcher.pid"), String(pid));
}

export function removePid(runDir: string): void {
  rmQuiet(path.join(runDir, "dispatcher.pid"));
}

/** The dispatcher pid when the file names a live process, else null. */
export function livePid(runDir: string): number | null {
  const pid = readPid(runDir);
  return pid !== null && pidAlive(pid) ? pid : null;
}

// ---------------------------------------------------------------------------
// dispatcher.token
// ---------------------------------------------------------------------------

/**
 * 16 bytes of OS randomness, hex-encoded (`od -An -N16 -tx1 /dev/urandom | tr -d ' \n'`, bin/thinkers,
 * sync 2e39a3f). The old `date +%s`.pid.$RANDOM mint collided when two dispatchers started in the same
 * second (pids repeat across forks), so both passed the ownership check and double-dispatched every
 * due wake (the 2026-09-22/23 5x and 2x sends).
 */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function readToken(runDir: string): string | null {
  return readText(path.join(runDir, "dispatcher.token"));
}

/** `printf '%s' "$token" > dispatcher.token` — no newline. */
export function writeToken(runDir: string, token: string): void {
  writeAtomic(path.join(runDir, "dispatcher.token"), token);
}

export function removeToken(runDir: string): void {
  rmQuiet(path.join(runDir, "dispatcher.token"));
}

// ---------------------------------------------------------------------------
// active_thinkers
// ---------------------------------------------------------------------------

export function readActive(runDir: string): string[] {
  return readLines(path.join(runDir, "active_thinkers"));
}

/** `grep -qx "$name" active_thinkers`. */
export function isActive(runDir: string, name: string): boolean {
  return readActive(runDir).includes(name);
}

/** `grep -qx || printf '%s\n' >> active_thinkers` (bin/thinkers:1130-1132). */
export function addActive(runDir: string, name: string): void {
  if (isActive(runDir, name)) return;
  fs.appendFileSync(path.join(runDir, "active_thinkers"), `${name}\n`);
}

/** Rewrite the whole list (start-all: `: > file; printf '%s\n' …`). */
export function writeActive(runDir: string, names: string[]): void {
  writeAtomic(path.join(runDir, "active_thinkers"), names.map((n) => `${n}\n`).join(""));
}

/** `grep -vx "$name" > .tmp; mv .tmp active_thinkers` (bin/thinkers:1336-1339). */
export function removeActive(runDir: string, name: string): void {
  const file = path.join(runDir, "active_thinkers");
  if (!fs.existsSync(file)) return;
  const kept = readLines(file).filter((l) => l !== name);
  writeAtomic(file, kept.map((n) => `${n}\n`).join(""));
}

export function removeActiveFile(runDir: string): void {
  rmQuiet(path.join(runDir, "active_thinkers"));
}

// ---------------------------------------------------------------------------
// step_pids — "<pid> <name>\n" (SPACE separated; F2)
// ---------------------------------------------------------------------------

export interface StepPid {
  pid: number;
  name: string;
}

/** `printf '%s %s\n' "$!" "$name" >> step_pids` (bin/thinkers:562). */
export function appendStepPid(runDir: string, pid: number, name: string): void {
  fs.appendFileSync(path.join(runDir, "step_pids"), `${pid} ${name}\n`);
}

/** `while read -r step_pid _step_name` — first field pid, rest name. */
export function readStepPids(runDir: string): StepPid[] {
  const out: StepPid[] = [];
  for (const line of readLines(path.join(runDir, "step_pids"))) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    const pidStr = sp === -1 ? t : t.slice(0, sp);
    const name = sp === -1 ? "" : t.slice(sp + 1).trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, name });
  }
  return out;
}

/** Rewrite from a list (prune): step_pids.tmp + mv (bin/thinkers:518-522). */
export function writeStepPids(runDir: string, entries: StepPid[]): void {
  writeAtomic(path.join(runDir, "step_pids"), entries.map((e) => `${e.pid} ${e.name}\n`).join(""));
}

/** `: > step_pids` — a new dispatcher starts a fresh ledger (bin/thinkers:433). */
export function truncateStepPids(runDir: string): void {
  writeAtomic(path.join(runDir, "step_pids"), "");
}

export function removeStepPids(runDir: string): void {
  rmQuiet(path.join(runDir, "step_pids"));
}

/** Ledger entries whose pid is alive (every reader filters for live pids itself). */
export function liveStepPids(runDir: string): StepPid[] {
  return readStepPids(runDir).filter((e) => pidAlive(e.pid));
}

// ---------------------------------------------------------------------------
// <name>.wake_at — "<epoch>" no newline
// ---------------------------------------------------------------------------

export type WakeAt = { kind: "absent" } | { kind: "invalid" } | { kind: "due"; epoch: number };

export function readWakeAt(runDir: string, name: string): WakeAt {
  const raw = readText(path.join(runDir, `${name}.wake_at`));
  if (raw === null) return { kind: "absent" };
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t)) return { kind: "invalid" };
  return { kind: "due", epoch: Number(t) };
}

/** `printf '%s' "$(( now + delay ))" > <name>.wake_at` (thinkers/monolith/step:118). */
export function writeWakeAt(runDir: string, name: string, epoch: number): void {
  writeAtomic(path.join(runDir, `${name}.wake_at`), String(epoch));
}

export function removeWakeAt(runDir: string, name: string): void {
  rmQuiet(path.join(runDir, `${name}.wake_at`));
}

/** `rm -f run/*.wake_at` (stop-all). */
export function removeAllWakeAt(runDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return;
  }
  for (const n of names) if (n.endsWith(".wake_at")) rmQuiet(path.join(runDir, n));
}

// ---------------------------------------------------------------------------
// sub_map / traj_files
// ---------------------------------------------------------------------------

export interface SubMapLine {
  name: string;
  trajFile: string;
  types: string[]; // joined by "|" on disk; empty = all
  triggerSelf: boolean;
  watchdog: number;
}

/** `THINKER\tTRAJ_FILE\tTYPES|…\tTRIGGER_SELF\tWATCHDOG\n` per subscription. */
export function writeSubMap(runDir: string, lines: SubMapLine[]): void {
  writeAtomic(
    path.join(runDir, "sub_map"),
    lines
      .map((l) => `${l.name}\t${l.trajFile}\t${l.types.join("|")}\t${l.triggerSelf ? "true" : "false"}\t${l.watchdog}\n`)
      .join("")
  );
}

export function readSubMap(runDir: string): SubMapLine[] {
  const out: SubMapLine[] = [];
  for (const line of readLines(path.join(runDir, "sub_map"))) {
    const [name, trajFile, types, self, wd] = line.split("\t");
    if (!name) continue;
    out.push({
      name,
      trajFile: trajFile ?? "",
      types: types ? types.split("|") : [],
      triggerSelf: self === "true",
      watchdog: /^[0-9]+$/.test(wd ?? "") ? Number(wd) : 0,
    });
  }
  return out;
}

export function removeSubMap(runDir: string): void {
  rmQuiet(path.join(runDir, "sub_map"));
}

/** `printf '%s\n' "$traj_files"` — one absolute path per line. */
export function writeTrajFiles(runDir: string, files: string[]): void {
  writeAtomic(path.join(runDir, "traj_files"), files.map((f) => `${f}\n`).join(""));
}

export function readTrajFiles(runDir: string): string[] {
  return readLines(path.join(runDir, "traj_files"));
}

export function removeTrajFiles(runDir: string): void {
  rmQuiet(path.join(runDir, "traj_files"));
}

// ---------------------------------------------------------------------------
// deliberate_stop / last_signal / fb_injected
// ---------------------------------------------------------------------------

/** `touch run/deliberate_stop` right before `kill -TERM` (bin/thinkers:994). */
export function touchDeliberateStop(runDir: string): void {
  const f = path.join(runDir, "deliberate_stop");
  const now = new Date();
  try {
    fs.utimesSync(f, now, now);
  } catch {
    fs.writeFileSync(f, "");
  }
}

/** Age of the marker in whole seconds (stat %Y granularity), null when absent. */
export function deliberateStopAgeS(runDir: string, nowMs = Date.now()): number | null {
  try {
    const st = fs.statSync(path.join(runDir, "deliberate_stop"));
    return Math.floor(nowMs / 1000) - Math.floor(st.mtimeMs / 1000);
  } catch {
    return null;
  }
}

export function removeDeliberateStop(runDir: string): void {
  rmQuiet(path.join(runDir, "deliberate_stop"));
}

/** `printf 'SIG%s\n' "$sig" > run/last_signal` (bin/thinkers:965). */
export function writeLastSignal(runDir: string, sig: string): void {
  const name = sig.startsWith("SIG") ? sig : `SIG${sig}`;
  writeAtomic(path.join(runDir, "last_signal"), `${name}\n`);
}

export function readLastSignal(runDir: string): string | null {
  return readText(path.join(runDir, "last_signal"));
}

export function removeLastSignal(runDir: string): void {
  rmQuiet(path.join(runDir, "last_signal"));
}

/** `grep -qxF "$id" run/fb_injected`. */
export function fbInjectedHas(runDir: string, id: string): boolean {
  return readLines(path.join(runDir, "fb_injected")).includes(id);
}

/** `printf '%s\n' "$id" >> run/fb_injected`. */
export function fbInjectedAdd(runDir: string, id: string): void {
  fs.appendFileSync(path.join(runDir, "fb_injected"), `${id}\n`);
}

export function removeFbInjected(runDir: string): void {
  rmQuiet(path.join(runDir, "fb_injected"));
}

// ---------------------------------------------------------------------------
// pending/ — the on-disk pending queue (bin/thinkers:604-642, 824-882)
// ---------------------------------------------------------------------------

/**
 * Parse a pending file name FROM THE LEFT (`${base%%.*}` / `${base#*.}` then
 * `%%.*`): `<name>.<type>.<rest>`. Thinker names and step types must not
 * contain dots (upstream contract). Undefined when there is no second segment.
 */
export function parsePendingName(base: string): { name: string; type: string; rest: string } | undefined {
  const i = base.indexOf(".");
  if (i <= 0) return undefined;
  const name = base.slice(0, i);
  const after = base.slice(i + 1);
  const j = after.indexOf(".");
  const type = j === -1 ? after : after.slice(0, j);
  const rest = j === -1 ? "" : after.slice(j + 1);
  if (!type) return undefined;
  return { name, type, rest };
}

/** `%06d` */
export function seq6(n: number): string {
  return String(n).padStart(6, "0");
}

/** The upstream manual-trigger `ts`: `date -u +%Y-%m-%dT%H:%M:%S%z` → `…T12:00:00+0000`. */
export function manualTriggerTs(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

/** The boot-kick / `thinkers step` payload (bin/thinkers:1173-1174): NO content. */
export function manualTriggerJson(d = new Date()): string {
  return JSON.stringify({ type: "manual-trigger", source: "thinkers-cli", ts: manualTriggerTs(d) });
}

/**
 * Drop a pending file of the FIFO scheme: `<name>.<type>.<epoch>.<seq %06d>`
 * holding compact JSON (no newline). Used by the daemon's queue and by the
 * CLI's boot kick (`<name>.manual-trigger.<epoch>.<seq>`).
 */
export function writePendingFile(pendingDir: string, name: string, type: string, seq: number, json: string, nowMs = Date.now()): string {
  const file = path.join(pendingDir, `${name}.${type}.${Math.floor(nowMs / 1000)}.${seq6(seq)}`);
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(file, json);
  return file;
}

/**
 * File-backed PendingStore for the daemon. FIFO files
 * `<name>.<type>.<epoch10>.<seq>` (message/action, cap 16 drop-oldest in glob
 * order) and `<name>.<type>.coalesced` (last-wins). Firing order = `_fire_pending`'s
 * glob passes: `*.message.*`, then `*.action.*`, then everything else, each in
 * name order — so a freed slot answers a waiting human before it services a
 * coalesced self-wake. Steps are parsed at take() time; a file that fails to
 * parse is removed and skipped.
 */
export class FilePendingStore implements PendingStore {
  private readonly dir: string;
  private readonly now: () => number;
  private seq = 0;

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = opts.now ?? (() => Date.now());
  }

  get pendingDir(): string {
    return this.dir;
  }

  private names(): string[] {
    try {
      return fs.readdirSync(this.dir).sort();
    } catch {
      return [];
    }
  }

  push(name: string, type: string, step: TriggerStep, kind: "fifo" | "coalesce"): PendingPushResult {
    fs.mkdirSync(this.dir, { recursive: true });
    const json = JSON.stringify(step);
    if (kind === "coalesce") {
      const file = path.join(this.dir, `${name}.${type}.coalesced`);
      const superseded = fs.existsSync(file);
      fs.writeFileSync(file, json);
      return { kind: "coalesce", superseded };
    }
    // `for f in pending/${name}.${type}.*` — count, drop the oldest at cap.
    const prefix = `${name}.${type}.`;
    let existing = this.names().filter((n) => n.startsWith(prefix));
    let dropped = false;
    if (existing.length >= MAX_FIFO) {
      rmQuiet(path.join(this.dir, existing[0]!));
      existing = existing.slice(1);
      dropped = true;
    }
    this.seq += 1;
    writePendingFile(this.dir, name, type, this.seq, json, this.now());
    return { kind: "fifo", queued: existing.length + 1, dropped };
  }

  list(): PendingEntry[] {
    const all = this.names();
    const entry = (base: string): PendingEntry | undefined => {
      const p = parsePendingName(base);
      return p ? { key: base, name: p.name, type: p.type } : undefined;
    };
    const message: PendingEntry[] = [];
    const action: PendingEntry[] = [];
    const rest: PendingEntry[] = [];
    for (const base of all) {
      const e = entry(base);
      if (!e) continue;
      // `*.message.*` / `*.action.*` match the TYPE segment of well-formed names.
      if (e.type === "message") message.push(e);
      else if (e.type === "action") action.push(e);
      else rest.push(e);
    }
    return [...message, ...action, ...rest];
  }

  take(key: string): TriggerStep | undefined {
    const file = path.join(this.dir, key);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    rmQuiet(file);
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as TriggerStep;
    } catch {
      /* malformed — dropped */
    }
    return undefined;
  }

  remove(key: string): void {
    rmQuiet(path.join(this.dir, key));
  }

  clear(name: string): void {
    for (const base of this.names()) if (base.startsWith(`${name}.`)) rmQuiet(path.join(this.dir, base));
  }

  count(name: string): number {
    return this.names().filter((b) => b.startsWith(`${name}.`)).length;
  }

  hasAny(): boolean {
    return this.names().some((b) => parsePendingName(b) !== undefined);
  }
}
