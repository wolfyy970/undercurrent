// usage.ts — per-day usage series for an identity, with an incremental
// cache. Port of headlong/web/src/headlong_web/usage.py (Apache-2.0).
//
// Two append-only sources feed it: the mind log (trajectory.jsonl) for
// messages/runs/reasoning steps, and the usage ledger
// (<identity_dir>/usage/llm.jsonl) for every successful `llm` call. Per day,
// the ledger wins when it has at least as many calls as the stamps; the
// cache tracks byte offsets read so far in each file so a refresh only
// reads what was appended.
//
// PORT-NOTE (execution model): upstream runs refresh() on a background
// Python thread so the POST handler can return 202 immediately while the
// scan (bounded, deterministic, no LLM calls) proceeds. Node has no
// lightweight thread equivalent for synchronous fs/JSON work without
// worker_threads; this port defers the scan with `setImmediate` instead —
// the .lock directory, the 202 response, and the final cache state are
// identical, but the scan runs on the next event-loop turn of the SAME
// process rather than a separate OS thread. See control.ts usageStartRefresh.

import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_VERSION = 2;
const CACHE_DIRNAME = "usage";
const CACHE_FILE = "cache.json";
const LOCK_DIRNAME = ".lock";
const LEDGER_FILE = "llm.jsonl";
// A lock older than this is a crashed refresh, not a running one.
const STALE_LOCK_MS = 15 * 60 * 1000;

const COUNT_KEYS = ["rows", "in_msg", "out_msg", "runs", "reasoning"] as const;
const TOKEN_KEYS = ["calls", "in", "out", "think"] as const;
const TOKEN_FIELDS: [string, "in" | "out" | "think"][] = [
  ["in_tok", "in"],
  ["out_tok", "out"],
  ["think_tok", "think"],
];

const OFFSET_FIX = /([+-][0-9]{2})([0-9]{2})$/;

function epoch(ts: string): number | null {
  ts = (ts ?? "").trim();
  if (!ts) return null;
  if (ts.endsWith("Z")) ts = ts.slice(0, -1) + "+00:00";
  ts = ts.replace(OFFSET_FIX, "$1:$2");
  const ms = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T"));
  if (Number.isNaN(ms)) return null;
  return ms / 1000;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function cacheDir(trajDir: string): string {
  return path.join(trajDir, CACHE_DIRNAME);
}
export function cachePath(trajDir: string): string {
  return path.join(cacheDir(trajDir), CACHE_FILE);
}
export function lockPath(trajDir: string): string {
  return path.join(cacheDir(trajDir), LOCK_DIRNAME);
}
/** Where `llm` appends its usage ledger for this identity. */
export function ledgerPath(identityDir: string): string {
  return path.join(identityDir, "usage", LEDGER_FILE);
}

export function isRefreshing(trajDir: string): boolean {
  const lock = lockPath(trajDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(lock);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  const age = Date.now() - st.mtimeMs;
  if (age > STALE_LOCK_MS) {
    fs.rmSync(lock, { recursive: true, force: true });
    return false;
  }
  return true;
}

type TokenBucket = { calls: number; in: number; out: number; think: number; models: Record<string, Record<string, number>> };
type DayBucket = Record<string, number> & { run: TokenBucket; llm: TokenBucket };

function emptyTokens(): TokenBucket {
  return { calls: 0, in: 0, out: 0, think: 0, models: {} };
}
function emptyDay(): DayBucket {
  const day = {} as DayBucket;
  for (const k of COUNT_KEYS) day[k] = 0;
  day.run = emptyTokens();
  day.llm = emptyTokens();
  return day;
}

export interface UsageState {
  version: number;
  identity: string;
  generated: string | null;
  log_offset: number;
  ledger_offset: number;
  rows: number;
  skipped: number;
  ledger_rows: number;
  ledger_skipped: number;
  daily: Record<string, DayBucket>;
  run_model: Record<string, string>;
}

function emptyState(identityName: string): UsageState {
  return {
    version: CACHE_VERSION,
    identity: identityName,
    generated: null,
    log_offset: 0,
    ledger_offset: 0,
    rows: 0,
    skipped: 0,
    ledger_rows: 0,
    ledger_skipped: 0,
    daily: {},
    run_model: {},
  };
}

/** The cached state, or null when there is none (or unreadable / from an
 *  older version, which means: rebuild). */
export function load(trajDir: string): UsageState | null {
  let state: unknown;
  try {
    state = JSON.parse(fs.readFileSync(cachePath(trajDir), "utf-8"));
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  if ((state as UsageState).version !== CACHE_VERSION) return null;
  return state as UsageState;
}

function writeState(trajDir: string, state: UsageState): void {
  const target = cachePath(trajDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.cache-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
}

function parseRow(line: string): [Record<string, unknown>, string] | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const ts = epoch(String(r["ts"] ?? ""));
  if (ts === null) return null;
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  return [r, day];
}

function day_(state: UsageState, dayKey: string): DayBucket {
  let d = state.daily[dayKey];
  if (d === undefined) {
    d = emptyDay();
    state.daily[dayKey] = d;
  }
  return d;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function addTokens(bucket: TokenBucket, row: Record<string, unknown>, model: string): boolean {
  let stamped = false;
  let perModel = bucket.models[model];
  if (perModel === undefined) {
    perModel = { calls: 0, in: 0, out: 0, think: 0 };
    bucket.models[model] = perModel;
  }
  for (const [field, short] of TOKEN_FIELDS) {
    const value = row[field];
    if (isNumber(value)) {
      bucket[short] += Math.trunc(value);
      perModel[short]! += Math.trunc(value);
      stamped = true;
    }
  }
  if (stamped) {
    bucket.calls += 1;
    perModel["calls"]! += 1;
  }
  return stamped;
}

function ingestLog(state: UsageState, line: string, identityName: string): void {
  state.rows += 1;
  const parsed = parseRow(line);
  if (parsed === null) {
    state.skipped += 1;
    return;
  }
  const [step, dayKey] = parsed;
  const day = day_(state, dayKey);
  day["rows"] = (day["rows"] ?? 0) + 1;

  const kind = step["type"] ?? "";
  const rid = step["run_id"] ?? "";
  if (kind === "shellm-run") {
    day["runs"] = (day["runs"] ?? 0) + 1;
    const sid = step["step_id"];
    if (sid) state.run_model[String(sid)] = String(step["model"] ?? "?");
  } else if (kind === "message") {
    const frm = String(step["from"] ?? "");
    const to = String(step["to"] ?? "");
    if (to === identityName && frm && frm !== identityName) day["in_msg"] = (day["in_msg"] ?? 0) + 1;
    else if (frm === identityName && to && to !== identityName) day["out_msg"] = (day["out_msg"] ?? 0) + 1;
  } else if (kind === "reasoning") {
    day["reasoning"] = (day["reasoning"] ?? 0) + 1;
    addTokens(day.run, step, state.run_model[String(rid)] ?? "?");
  }
}

function ingestLedger(state: UsageState, line: string): void {
  state.ledger_rows += 1;
  const parsed = parseRow(line);
  if (parsed === null) {
    state.ledger_skipped += 1;
    return;
  }
  const [rec, dayKey] = parsed;
  if (!addTokens(day_(state, dayKey).llm, rec, String(rec["model"] ?? "?"))) state.ledger_skipped += 1;
}

/** Feed every complete line past `offset` to `ingest`; return the new
 *  offset. A trailing row without its newline is still being written and is
 *  picked up next time. */
function readAppended(filePath: string, offset: number, ingest: (line: string) => void): number {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return offset;
  }
  if (size <= offset) return offset;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf-8");
    let pos = offset;
    let lineStart = 0;
    for (;;) {
      const nl = text.indexOf("\n", lineStart);
      if (nl === -1) break;
      const raw = text.slice(lineStart, nl + 1);
      pos += Buffer.byteLength(raw, "utf-8");
      const line = raw.trim();
      if (line) ingest(line);
      lineStart = nl + 1;
    }
    return pos;
  } finally {
    fs.closeSync(fd);
  }
}

function sizeOf(p: string | null): number {
  if (p === null) return 0;
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Bring the cache up to date with the log (and ledger, when given) and
 *  return the new state. Reads only what was appended since the cached
 *  offsets; a file that shrank (rewritten, rotated) or a cache from another
 *  version triggers a full pass. The caller is responsible for the lock. */
export function refresh(trajDir: string, identityName: string, ledger: string | null = null, rebuild = false): UsageState {
  const log = path.join(trajDir, "trajectory.jsonl");
  let state = rebuild ? null : load(trajDir);
  if (state === null || state.identity !== identityName) state = emptyState(identityName);
  if (sizeOf(log) < (state.log_offset ?? 0) || sizeOf(ledger) < (state.ledger_offset ?? 0)) {
    state = emptyState(identityName);
  }
  state.log_offset = readAppended(log, state.log_offset ?? 0, (line) => ingestLog(state!, line, identityName));
  if (ledger !== null) {
    state.ledger_offset = readAppended(ledger, state.ledger_offset ?? 0, (line) => ingestLedger(state!, line));
  }
  state.generated = nowIso();
  writeState(trajDir, state);
  return state;
}

/** Start refresh() deferred (see PORT-NOTE at top of file) behind the .lock
 *  directory. Returns false (and does nothing) when a refresh is already
 *  running. A refresh that fails leaves the previous cache in place (the new
 *  state is written only at the end). */
export function startRefresh(trajDir: string, identityName: string, ledger: string | null = null, rebuild = false): boolean {
  if (isRefreshing(trajDir)) return false;
  const lock = lockPath(trajDir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    return false;
  }
  setImmediate(() => {
    try {
      refresh(trajDir, identityName, ledger, rebuild);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });
  return true;
}

function pendingBytes(trajDir: string, ledger: string | null, state: UsageState | null): number {
  const s = state ?? ({} as Partial<UsageState>);
  let pending = sizeOf(path.join(trajDir, "trajectory.jsonl")) - (s.log_offset ?? 0);
  pending += sizeOf(ledger) - (s.ledger_offset ?? 0);
  return Math.max(0, pending);
}

function mergeDay(day: DayBucket): [Record<string, unknown>, Record<string, Record<string, number>>] {
  const llmCalls = day.llm.calls;
  const runCalls = day.run.calls;
  const source = llmCalls > 0 && llmCalls >= runCalls ? "ledger" : "mindlog";
  const tokens = source === "ledger" ? day.llm : day.run;
  const out: Record<string, unknown> = {};
  for (const key of COUNT_KEYS) out[key] = day[key] ?? 0;
  for (const key of TOKEN_KEYS) out[key] = tokens[key];
  out["source"] = source;
  return [out, tokens.models];
}

export interface UsageSummary {
  identity: { id: string; name: string };
  refreshing: boolean;
  pending_bytes: number;
  available: boolean;
  generated?: string;
  rows?: number;
  skipped?: number;
  ledger?: { rows: number; skipped: number; since: string | null };
  daily?: [string, Record<string, unknown>][];
  by_model?: Record<string, Record<string, number>>;
  totals?: Record<string, number>;
}

/** The API payload: cached series (if any) plus freshness signals. */
export function summary(trajDir: string, identityId: string, identityName: string, ledger: string | null = null): UsageSummary {
  const state = load(trajDir);
  const base = {
    identity: { id: identityId, name: identityName },
    refreshing: isRefreshing(trajDir),
    pending_bytes: pendingBytes(trajDir, ledger, state),
  };
  if (state === null || !state.generated) return { ...base, available: false };
  const daily = state.daily ?? {};
  const days: [string, Record<string, unknown>][] = [];
  const byModel: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = { in: 0, out: 0, think: 0, calls: 0, in_msg: 0, out_msg: 0, runs: 0 };
  let ledgerSince: string | null = null;
  for (const dayKey of Object.keys(daily).sort()) {
    const [merged, models] = mergeDay(daily[dayKey]!);
    days.push([dayKey, merged]);
    for (const key of Object.keys(totals)) totals[key]! += Number(merged[key] ?? 0);
    for (const [model, counters] of Object.entries(models)) {
      const bucket = (byModel[model] ??= { calls: 0, in: 0, out: 0, think: 0 });
      for (const key of TOKEN_KEYS) bucket[key] += counters[key] ?? 0;
    }
    if (merged["source"] === "ledger" && ledgerSince === null) ledgerSince = dayKey;
  }
  return {
    ...base,
    available: true,
    generated: state.generated,
    rows: state.rows ?? 0,
    skipped: state.skipped ?? 0,
    ledger: { rows: state.ledger_rows ?? 0, skipped: state.ledger_skipped ?? 0, since: ledgerSince },
    daily: days,
    by_model: Object.fromEntries(Object.entries(byModel).filter(([, c]) => c["calls"]! > 0)),
    totals,
  };
}
