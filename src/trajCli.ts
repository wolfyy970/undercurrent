// trajCli.ts — full CLI port of headlong/bin/traj (2185 lines of Bash).
//
// Faithful port of every subcommand: new, append, fork, merge, show, tail,
// search, count, last, cat, exists, path, list, root, check. `append`/`last`
// reuse src/trajCore.mjs's PROVEN write path (appendStep/readSteps) unchanged
// — this file adds NO new write semantics, only the read/list/search/format
// machinery bin/traj.mjs never had, plus faithful flag/env resolution
// (`--traj_dir` + $TRAJ_DIR/$TRAJ_ID, matching bash `require_traj_file` /
// `_resolve_traj_id`) that the old stub silently ignored.
//
// Injectable IO — the shim (bin/traj.mjs) wires process.*; tests inject a
// deterministic harness (style of src/mem.ts / src/chat.ts).
//
// Bash artifacts documented (PORT-NOTE) rather than reproduced byte-for-byte,
// same class as the mem/skills/recap/llm modules' documented deviations
// (PARITY.md):
//   - `${2:?msg}` missing/empty required flag values: bash's own diagnostic
//     (embeds the script's absolute path + a line number) is not reproducible
//     from TS; the port dies with a clean `traj: error: <cmd>: <msg>`, exit 1.
//   - `set -euo pipefail` + a jq parse failure on malformed JSON aborts the
//     whole script with jq's own exit code; the port dies with its own
//     message, exit 1, at the same logical point.
//   - grep `-E` (bash ERE) vs JS RegExp: metacharacter flavor differs on a
//     handful of characters (`+ ? { } | ( )` need escaping differently);
//     `.`/`*`/`[…]`/anchors agree. Same class as skills' grep deviation.
//   - the `_sorted_tree_steps` `to_epoch` jq filter is reproduced for sort-key
//     purposes only (used for -r/--recursive interleaving); a truly
//     unparseable timestamp sorts as epoch 0 rather than aborting the whole
//     per-file jq pipeline like real jq would.
//   - PORT-NOTE (1c: e4ca135): to_epoch's sort key is INTEGER MILLISECONDS,
//     not whole seconds — a trajectory writes many steps per second, so a
//     whole-second key ties for most of them. See toEpoch() below.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendStep,
  genStepId,
  isoTs,
  resolveTrajFile,
} from "./trajCore.mjs";
import type { Step } from "./types.ts";

type AnyStep = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Injectable IO
// ---------------------------------------------------------------------------

export interface TrajIO {
  /** Environment: TRAJ_DIR, TRAJ_ID, SHELLM_RUN_STEP_ID, CLICOLOR_FORCE, … */
  env: Record<string, string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Full stdin contents (used by `append` when no --field is given). */
  readStdin(): string;
  /** Colours/format default to on only on a tty (matches `[[ -t 1 ]]`). */
  isTTY: boolean;
  /** Blocking sleep in milliseconds — used by `tail -f`'s poll loop. */
  sleepMs(ms: number): void;
  /** Polled by `tail -f`'s loop; true once the caller wants to stop (SIGINT). */
  shouldStop(): boolean;
}

/** Thrown by `die` to unwind to the runTraj boundary with an exit code. */
class TrajExit extends Error {
  readonly code: number;
  readonly dieMsg: string | undefined;
  constructor(code: number, dieMsg?: string) {
    super(dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
  }
}

/** `die() { printf 'traj: error: %s\n' "$*" >&2; exit 1; }` (bin/traj:17). */
function die(msg: string): never {
  throw new TrajExit(1, msg);
}

// ---------------------------------------------------------------------------
// jq-semantics helpers — `//` (null/false-triggered fallback), `tostring`,
// and raw (no-fallback) field reads, used throughout to match bash's exact
// jq expressions rather than JS `??`/`||`/truthiness.
// ---------------------------------------------------------------------------

function jqTruthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

/** `.a // .b // dflt` — first operand that is not null/false/missing. */
function jqOr(...vals: unknown[]): unknown {
  for (const v of vals) if (jqTruthy(v)) return v;
  return vals.length ? vals[vals.length - 1] : undefined;
}

/** `(EXPR // fallback) | tostring`-ish string coercion for a jq value. */
function jqStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** `.field // empty` read off a (possibly undefined) object, as a string. */
function jqField(obj: unknown, key: string, fallback = ""): string {
  const rec = obj as AnyStep | undefined | null;
  const v = rec == null ? undefined : rec[key];
  return jqTruthy(v) ? jqStr(v) : fallback;
}

/**
 * `jq -r ".${field} // empty"` PRINTED (bin/traj:708, :1460) — when the
 * field is present, jq -r prints its value plus exactly one trailing
 * newline; `empty` (the `// empty` fallback) yields NO value at all, so jq
 * prints ZERO bytes — not a blank line. A bare `jqField(...) + "\n"` at a
 * print site would wrongly emit "\n" for an absent field.
 */
function printJqFieldOrEmpty(io: TrajIO, obj: unknown, key: string): void {
  const rec = obj as AnyStep | undefined | null;
  const v = rec == null ? undefined : rec[key];
  if (jqTruthy(v)) io.stdout(jqStr(v) + "\n");
}

/** `.field | tostring` with NO `// fallback` — jq prints literal "null". */
function jqRawField(obj: unknown, key: string): string {
  const rec = obj as AnyStep | undefined | null;
  const v = rec == null ? undefined : rec[key];
  if (v === undefined || v === null) return "null";
  if (typeof v === "string") return v;
  return jqStr(v);
}

/** jq `tostring` applied to `(.field // null)`, used by filter matching. */
function jqToStringOrNull(v: unknown): string {
  if (v === undefined || v === null || v === false) return "null";
  return jqStr(v);
}

// ---------------------------------------------------------------------------
// Byte / code-point helpers (bash byte_len, head -c, `${#var}`, cut -c).
// ---------------------------------------------------------------------------

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
function byteSlice(s: string, n: number): string {
  return Buffer.from(s, "utf8").subarray(0, Math.max(0, n)).toString("utf8");
}
function cpLen(s: string): number {
  return [...s].length;
}
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, Math.max(0, n)).join("");
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `wc -l < file | tr -d ' '` — counts NEWLINE characters (not JSON rows). */
function wcL(file: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") n++;
  return n;
}

/** Raw first line of a file (`head -1`), "" if missing/empty. */
function readFirstLineRaw(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const nl = raw.indexOf("\n");
  return nl >= 0 ? raw.slice(0, nl) : raw;
}

/** Raw last line of a file (`tail -1`) — the last `\n`-terminated (or
 *  trailing unterminated) line, "" for an empty file. */
function readLastLineRaw(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  if (raw === "") return "";
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines[lines.length - 1]! : "";
}

/** Lines as `tail -n N` / `cat` would see them: keeps a trailing
 *  unterminated final line (unlike a bash `while read` loop — see
 *  bashReadLoopLines below). Drops only the artifact empty tail entry from a
 *  well-formed trailing newline. */
function coreutilsLines(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (raw === "") return [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines as a bash `while IFS= read -r line; do …; done < file` loop would
 *  see them — `read` fails (loop body never runs) on a final line with no
 *  trailing newline, so an unterminated last line is silently DROPPED. Used
 *  by `check` and `search`'s per-row loops. */
function bashReadLoopLines(raw: string): string[] {
  const parts = raw.split("\n");
  parts.pop();
  return parts;
}
function bashReadLoopLinesOfFile(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return bashReadLoopLines(raw);
}

function tryParseLine(line: string): AnyStep | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as AnyStep) : undefined;
  } catch {
    return undefined;
  }
}

/** `jq -R -c 'fromjson? // empty | select(.type == TYPE)' file | head -1`. */
function firstStepOfType(file: string, type: string): AnyStep | undefined {
  for (const line of coreutilsLines(file)) {
    const obj = tryParseLine(line);
    if (obj && obj.type === type) return obj;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// _parse_hex_id (bin/traj:214-231)
// ---------------------------------------------------------------------------

function parseHexId(filePath: string): string {
  let bn = path.basename(filePath);
  if (bn === "trajectory.jsonl") {
    bn = path.basename(path.dirname(filePath));
  } else {
    bn = bn.endsWith(".jsonl") ? bn.slice(0, -".jsonl".length) : bn;
  }
  const m = /^([0-9a-f]{8})-/.exec(bn);
  return m ? m[1]! : bn;
}

// ---------------------------------------------------------------------------
// _get_summary (bin/traj:234-268)
// ---------------------------------------------------------------------------

function getSummary(trajFile: string): string {
  let raw = "";
  const summaryStep = firstStepOfType(trajFile, "run-summary");
  if (summaryStep) raw = jqField(summaryStep, "tldr");
  if (!raw) {
    const promptStep = firstStepOfType(trajFile, "prompt");
    if (promptStep) raw = byteSlice(jqField(promptStep, "content"), 200);
  }
  if (!raw) {
    const first = tryParseLine(readFirstLineRaw(trajFile));
    raw = byteSlice(jqField(first, "command"), 200);
  }
  if (!raw) raw = "(no summary)";
  if (cpLen(raw) > 80) raw = cpSlice(raw, 77) + "...";
  return raw;
}

// ---------------------------------------------------------------------------
// _resolve_parent_file (bin/traj:284-317)
// ---------------------------------------------------------------------------

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function resolveParentFile(trajFile: string, trajDir: string): string | undefined {
  if (!isFile(trajFile)) return undefined;
  const first = tryParseLine(readFirstLineRaw(trajFile));
  const parentId = jqField(first, "parent_traj") || jqField(first, "parent");
  if (!parentId) return undefined;

  const parentRef = jqField(first, "parent_traj_ref") || jqField(first, "parent_ref");
  const myDir = path.dirname(trajFile);
  if (parentRef) {
    const candidate = path.join(myDir, parentRef);
    if (isFile(candidate)) return safeRealpath(candidate);
    const candidateDir = path.join(candidate, "trajectory.jsonl");
    if (isFile(candidateDir)) return safeRealpath(candidateDir);
  }
  return resolveTrajFile(trajDir, parentId);
}

// ---------------------------------------------------------------------------
// _collect_recursive_files (bin/traj:733-757)
// ---------------------------------------------------------------------------

function collectRecursiveFiles(trajFile: string): string[] {
  const out: string[] = [];
  // PORT-NOTE (sync 2e39a3f, d2e62f9 #199): fork records are stored data and may contain
  // cycles (including legacy or hand-edited trajectories). Track only the CURRENT ANCESTRY
  // (realpath'd, like the Bash's `_traj_ancestors`) so a child shared by two fork rows still
  // appears under each fork while recursion always ends. The files are emitted by their
  // realpath. (This port previously de-duplicated globally, dropping the second occurrence.)
  function rec(file: string, ancestors: ReadonlySet<string>): void {
    if (!isFile(file)) return;
    const real = fs.realpathSync(file);
    if (ancestors.has(real)) return;
    const chain = new Set(ancestors).add(real);
    out.push(real);
    const parentDir = path.dirname(real);
    for (const line of coreutilsLines(real)) {
      const obj = tryParseLine(line);
      if (!obj || obj.type !== "fork") continue;
      let childFile: string | undefined;
      const childRef = jqField(obj, "child_ref");
      if (childRef && isFile(path.join(parentDir, childRef))) {
        childFile = path.join(parentDir, childRef);
      } else {
        const childId = jqField(obj, "child");
        if (!childId) continue;
        childFile = resolveTrajFile(path.dirname(parentDir), childId);
      }
      if (childFile && isFile(childFile)) rec(childFile, chain);
    }
  }
  rec(trajFile, new Set());
  return out;
}

// ---------------------------------------------------------------------------
// require_traj_file / _resolve_traj_id (bin/traj:161-210)
// ---------------------------------------------------------------------------

function requireTrajFile(
  io: TrajIO,
  trajDirOpt: string,
  trajIdOpt: string,
  cmdName: string,
): string {
  const dir = trajDirOpt || io.env.TRAJ_DIR || "";
  const id = trajIdOpt || io.env.TRAJ_ID || "";
  if (dir && id) {
    const f = resolveTrajFile(dir, id);
    if (f) return f;
    die(`${cmdName}: cannot resolve traj_id '${id}' in '${dir}'`);
  }
  die(
    `${cmdName}: no trajectory specified. Use --traj_dir DIR <ID>, or set TRAJ_DIR + TRAJ_ID env vars.`,
  );
}

// ---------------------------------------------------------------------------
// Shared append (cmd_append core, bin/traj:405-567) — reuses trajCore's
// PROVEN appendStep for the actual mutation (step_id/ts stamping, run_id
// auto-link, blob spill, locked write). Used directly by `append`, and by
// `fork`/`merge` to append their own synthesized step.
// ---------------------------------------------------------------------------

function doAppend(
  io: TrajIO,
  cmdName: string,
  trajDirOpt: string,
  trajIdOpt: string,
  record: AnyStep,
): string {
  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, cmdName);
  const runStepId = io.env.SHELLM_RUN_STEP_ID ?? "";
  return appendStep(trajFile, record, { runStepId, env: io.env });
}

// ---------------------------------------------------------------------------
// Flag parsing helpers
// ---------------------------------------------------------------------------

/** `"${2:?msg}"` — bash dies (its own diagnostic) on a MISSING or EMPTY
 *  value. The port dies with a clean `<cmd>: <msg>`, exit 1 (documented
 *  deviation — see file header). Returns the consumed index. */
function reqFlagVal(argv: string[], i: number, cmdName: string, msg: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") die(`${cmdName}: ${msg}`);
  return v;
}

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------

interface Colors {
  reset: string;
  dim: string;
  thought: string;
  action: string;
  observation: string;
  human: string;
  agent: string;
  tp: string;
  shell: string;
  meta: string;
}
const NO_COLORS: Colors = {
  reset: "",
  dim: "",
  thought: "",
  action: "",
  observation: "",
  human: "",
  agent: "",
  tp: "",
  shell: "",
  meta: "",
};
function ansiColors(): Colors {
  return {
    reset: "\u001b[0m",
    dim: "\u001b[2m",
    thought: "\u001b[36m",
    action: "\u001b[33m",
    observation: "\u001b[32m",
    human: "\u001b[1;37m",
    agent: "\u001b[35m",
    tp: "\u001b[34m",
    shell: "\u001b[2m",
    meta: "\u001b[2m",
  };
}
function colorFor(c: Colors, entryType: string): string {
  switch (entryType) {
    case "thought":
    case "reasoning":
      return c.thought;
    case "action":
      return c.action;
    case "observation":
      return c.observation;
    case "human-msg":
    case "message":
    case "feedback":
      return c.human;
    case "agent-run":
    case "agent-msg":
    case "final":
      return c.agent;
    case "fork":
    case "merge":
    case "trajectory":
      return c.agent;
    case "shell-output":
      return c.shell;
    case "shellm-run":
    case "run-summary":
    case "prompt":
      return c.meta;
    default:
      return entryType.startsWith("tp:") || entryType === "tp-thought" ? c.tp : "";
  }
}

/** Tree-drawing palette (`_c_tree/_c_id/_c_step/_c_dim/_c_fork/_c_reset`,
 *  bin/traj:19-24) — used by `list`/`root`. */
interface TreeColors {
  tree: string;
  id: string;
  step: string;
  dim: string;
  fork: string;
  reset: string;
}
function treeColors(on: boolean): TreeColors {
  if (!on) return { tree: "", id: "", step: "", dim: "", fork: "", reset: "" };
  return {
    tree: "\u001b[36m",
    id: "\u001b[1;33m",
    step: "\u001b[32m",
    dim: "\u001b[2m",
    fork: "\u001b[35m",
    reset: "\u001b[0m",
  };
}
function colorEnabled(io: TrajIO): boolean {
  return io.isTTY || (io.env.CLICOLOR_FORCE ?? "0") !== "0";
}

// ---------------------------------------------------------------------------
// Filters (--filter field=v1,v2 …, AND'd across flags, OR'd within one)
// ---------------------------------------------------------------------------

interface FilterSpec {
  key: string;
  vals: string[];
}
function parseFilterFlags(filters: string[]): FilterSpec[] {
  return filters.map((f) => {
    const eq = f.indexOf("=");
    const key = eq >= 0 ? f.slice(0, eq) : f;
    const val = eq >= 0 ? f.slice(eq + 1) : "";
    return { key, vals: val.split(",") };
  });
}
function matchesFilters(step: AnyStep, filters: FilterSpec[]): boolean {
  if (filters.length === 0) return true;
  return filters.every((f) => {
    const fv = jqToStringOrNull(step[f.key]);
    return f.vals.some((v) => v === fv);
  });
}

// ---------------------------------------------------------------------------
// to_epoch (bin/traj:776-806, e4ca135) — sort key only, for -r/--recursive
// interleave. Returns INTEGER MILLISECONDS, not seconds: a trajectory writes
// many steps per second, so a whole-second key ties for most of them and the
// -r views need sub-second ordering to be correct.
// ---------------------------------------------------------------------------

function toEpoch(tsRaw: unknown): number {
  const raw = jqStr(jqOr(tsRaw, "0"));

  // Keep the milliseconds: the first 3 digits of the fractional-seconds
  // part, right-padded with zeros (jq: `((capture(...) | .f) // "") + "000"`
  // sliced to 3 chars) — ".5" -> 500ms, ".123456" -> 123ms, no fraction -> 0ms.
  const fracMatch = /\.([0-9]+)/.exec(raw);
  const fracDigits = fracMatch ? fracMatch[1]! : "";
  const ms = Number((fracDigits + "000").slice(0, 3));

  const stripped = raw.replace(/\.[0-9]+/, ""); // fractional seconds removed before offset matching
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-])(\d{2}):?(\d{2})$/.exec(stripped);
  let dt: string, sign: string, oh: string, om: string;
  if (m) {
    dt = m[1]!;
    sign = m[2]!;
    oh = m[3]!;
    om = m[4]!;
  } else {
    // Catch-all: what every stamp traj writes looks like (UTC, ends in "Z"
    // or the RFC-3339 lowercase "z", possibly with trailing whitespace).
    // Strip that before appending "Z" back below — otherwise a real stamp
    // would be handed "...:18ZZ" and fail to parse.
    dt = stripped.replace(/[Zz]\s*$/, "");
    sign = "+";
    oh = "00";
    om = "00";
  }
  const off = Number(oh) * 3600 + Number(om) * 60;
  const localEpochMs = Date.parse(dt + "Z");
  // A stamp that will not parse must not delete its step from the tree — it
  // sorts as epoch (and thus millisecond-epoch) 0, same fallback jq's
  // `try fromdateiso8601 catch 0` gives.
  const localEpochSec = Number.isFinite(localEpochMs) ? Math.floor(localEpochMs / 1000) : 0;
  const epochSec = sign === "-" ? localEpochSec + off : localEpochSec - off;
  return epochSec * 1000 + ms;
}

// ---------------------------------------------------------------------------
// Line preview + formatting (_format_line, bin/traj:844-1023)
// ---------------------------------------------------------------------------

function previewFor(s: AnyStep): string {
  const type = jqStr(jqOr(s.type, ""));
  switch (type) {
    case "reasoning": {
      const base = byteSliceNoop(jqStr(jqOr(s.content, s.thought, ""))).slice(0, 100);
      if (jqTruthy(s.cmd)) {
        const cleaned = jqStr(s.cmd).replace(/\n/g, " ").replace(/\s+/g, " ").slice(0, 120);
        return base + " | " + cleaned;
      }
      return base;
    }
    case "shell-output":
      return jqStr(jqOr(s.stdout, ""));
    case "shellm-run":
      return jqStr(jqOr(s.command, ""));
    case "run-summary":
      return jqStr(jqOr(s.tldr, ""));
    case "final":
      return jqStr(jqOr(s.content, s.thought, ""));
    case "fork":
      return "-> " + jqStr(jqOr(s.child, ""));
    case "trajectory": {
      const parent = jqOr(s.parent_traj, s.parent, null);
      if (jqTruthy(parent)) return "<- parent: " + jqStr(parent);
      const idDir = s.identity_dir;
      return "root" + (jqTruthy(idDir) ? ` (${jqStr(idDir)})` : "");
    }
    case "merge":
      return "<- " + jqStr(jqOr(s.content, s.from_traj, ""));
    default:
      return jqStr(jqOr(s.content, ""));
  }
}
// no-op placeholder kept for symmetry with byte-based helpers elsewhere.
function byteSliceNoop(s: string): string {
  return s;
}

function finalizePreview(preview: string): string {
  let val: string;
  if (preview === "") {
    val = "-";
  } else {
    const parts = preview.split("\n");
    val = parts.length > 1 ? parts[0] + "..." : parts[0]!;
  }
  return val.replace(/\t/g, " ");
}

/** date/time display shared by both `_format_line` branches. */
function timeDisplay(tsRaw: string): string {
  if (/^[0-9]{9,10}$/.test(tsRaw)) {
    const d = new Date(Number(tsRaw) * 1000);
    if (Number.isNaN(d.getTime())) return "----/--/-- --:--:--";
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(
      d.getHours(),
    )}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(tsRaw);
  if (m) return `${m[1]}/${m[2]}/${m[3]} ${m[4]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(tsRaw);
  if (m) return `${m[1]}/${m[2]}/${m[3]} --:--:--`;
  return "----/--/-- --:--:--";
}

/** `_format_line` -a mode (bin/traj:874-937). */
function formatLineAllFields(line: string, filters: FilterSpec[], c: Colors): string | undefined {
  const step = tryParseLine(line);
  if (!step) return undefined;
  if (!matchesFilters(step, filters)) return undefined;

  const ts = jqStr(jqOr(step.ts, step.timestamp, "0"));
  const stepId = jqField(step, "step_id");
  const type = jqField(step, "type");
  const content = jqStr(jqOr(step.content, "")).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  const metaParts: string[] = [];
  for (const [k, v] of Object.entries(step)) {
    if (k === "ts" || k === "timestamp" || k === "_traj_hex" || k === "content" || k === "step_id") continue;
    metaParts.push(`${k}=${jqStr(v).replace(/\n/g, "\\n").replace(/\t/g, "\\t")}`);
  }
  const meta = metaParts.join(" ");

  const td = timeDisplay(ts);
  const color = colorFor(c, type);

  if (meta) {
    return `${c.dim}${td} ${stepId}${c.reset} ${color}[${meta}]${c.reset} ${content}\n`;
  }
  return `${c.dim}${td} ${stepId}${c.reset} ${content}\n`;
}

/** `_format_line` default mode (bin/traj:940-1023). */
function formatLineDefault(line: string, filters: FilterSpec[], c: Colors): string | undefined {
  const step = tryParseLine(line);
  if (!step) return undefined;
  if (!matchesFilters(step, filters)) return undefined;

  // PORT-NOTE: the Bash reads the six jq output lines with `read -r` (IFS-trimmed, content aside),
  // returns on an empty type, and "normalizes placeholders back to empty": a `-` content, source,
  // step_id or _traj_hex prints as empty (so an empty/absent preview — rendered `-` by the jq
  // program — and a literal "-" both print blank).
  const readTrim = (v: string): string => v.replace(/^[ \t]+|[ \t]+$/g, "");
  const entryType = readTrim(jqField(step, "type", "unknown"));
  if (entryType === "") return undefined;
  let content = finalizePreview(previewFor(step));
  if (content === "-") content = "";
  let source = readTrim(jqField(step, "source", "-"));
  if (source === "-") source = "";
  const ts = readTrim(jqStr(jqOr(step.ts, step.timestamp, "0")));
  let stepId = readTrim(jqField(step, "step_id", "-"));
  if (stepId === "-") stepId = "";
  let trajHex = readTrim(jqField(step, "_traj_hex", "-"));
  if (trajHex === "-") trajHex = "";

  const td = timeDisplay(ts);
  const color = colorFor(c, entryType);
  const typeTag = source ? `${entryType}, ${source}` : entryType;
  const shortId = stepId.slice(0, 8);
  const trajTag = trajHex ? `${c.dim}${trajHex}/${c.reset}` : "";

  return `${c.dim}${td}${c.reset} ${trajTag}${c.dim}${shortId}${c.reset} ${color}[${typeTag}]${c.reset} ${content}\n`;
}

function formatLine(
  line: string,
  allFields: boolean,
  filters: FilterSpec[],
  c: Colors,
): string | undefined {
  if (line === "") return undefined;
  return allFields ? formatLineAllFields(line, filters, c) : formatLineDefault(line, filters, c);
}

function rawFilteredLine(line: string, filters: FilterSpec[]): string | undefined {
  const step = tryParseLine(line);
  if (!step) return undefined;
  if (!matchesFilters(step, filters)) return undefined;
  return line + "\n";
}

// ---------------------------------------------------------------------------
// _sorted_tree_steps (bin/traj:759-790) — used by tail/cat -r.
// ---------------------------------------------------------------------------

interface TaggedLine {
  epoch: number;
  line: string;
}
function sortedTreeSteps(allFiles: string[], filters: FilterSpec[]): string[] {
  const tagged: TaggedLine[] = [];
  for (const f of allFiles) {
    if (!isFile(f)) continue;
    const hex = parseHexId(f);
    for (const raw of coreutilsLines(f)) {
      const obj = tryParseLine(raw);
      if (!obj) continue;
      const tagged_obj: AnyStep = { ...obj, _traj_hex: hex };
      if (!matchesFilters(tagged_obj, filters)) continue;
      const epoch = toEpoch(jqOr(tagged_obj.ts, tagged_obj.timestamp, "0"));
      tagged.push({ epoch, line: JSON.stringify(tagged_obj) });
    }
  }
  tagged.sort((a, b) => a.epoch - b.epoch);
  return tagged.map((t) => t.line);
}

// ---------------------------------------------------------------------------
// search — grep -F/-E [-i] [-C N] -n emulation (bin/traj:1190-1251)
// ---------------------------------------------------------------------------

interface GrepOpts {
  ci: boolean;
  contextLines: number;
  regex: boolean;
}
/** POSIX bracket-expression character classes ([:alpha:] …) as JS class fragments (C-locale/ASCII sets). */
const POSIX_CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\v\\f\\r",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
};

/**
 * PORT-NOTE (sync 2e39a3f, tests/test_traj_search.sh "decoded grep" oracle): `-E` patterns reach
 * grep as POSIX EREs; this port runs them as JS RegExp. Bracket expressions are where the two
 * differ most: `[[:alpha:]]`, `[[.c.]]`, `[[=c=]]` are POSIX-only, and inside a POSIX bracket a
 * backslash/`[` is a LITERAL. Translate each bracket expression to the JS class with the same
 * members; everything outside brackets is passed through unchanged (still JS-flavoured — see
 * PARITY.md for the remaining ERE/JS differences). An unterminated `[` is left as-is.
 */
function ereBracketsToJs(pattern: string): string {
  if (!pattern.includes("[")) return pattern;
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < n) {
      out += c + pattern[i + 1];
      i += 2;
      continue;
    }
    if (c !== "[") {
      out += c;
      i++;
      continue;
    }
    // parse a POSIX bracket expression starting at i
    let j = i + 1;
    let neg = false;
    if (pattern[j] === "^") {
      neg = true;
      j++;
    }
    const items: string[] = [];
    let first = true;
    let closed = false;
    while (j < n) {
      const d = pattern[j]!;
      if (d === "]" && !first) {
        closed = true;
        break;
      }
      first = false;
      if (d === "[" && (pattern[j + 1] === ":" || pattern[j + 1] === "." || pattern[j + 1] === "=")) {
        const kind = pattern[j + 1]!;
        const end = pattern.indexOf(kind + "]", j + 2);
        if (end < 0) {
          items.push("\\[");
          j++;
          continue;
        }
        const name = pattern.slice(j + 2, end);
        if (kind === ":") {
          const cls = POSIX_CLASSES[name];
          if (cls === undefined) {
            items.push("\\[");
            j++;
            continue;
          }
          items.push(cls);
        } else {
          items.push(name.replace(/[\\\]\[^-]/g, "\\$&"));
        }
        j = end + 2;
        continue;
      }
      if (d === "-") items.push("-");
      else if (d === "\\" || d === "[" || d === "]" || d === "^") items.push("\\" + d);
      else items.push(d);
      j++;
    }
    if (!closed) {
      out += c;
      i++;
      continue;
    }
    out += "[" + (neg ? "^" : "") + items.join("") + "]";
    i = j + 1;
  }
  return out;
}

function grepMatchLine(line: string, pattern: string, opts: GrepOpts): boolean {
  if (opts.regex) {
    try {
      const re = new RegExp(ereBracketsToJs(pattern), opts.ci ? "i" : "");
      return re.test(line);
    } catch {
      return false;
    }
  }
  return opts.ci ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern);
}

/**
 * `printf '%s\n' "$content" | grep [-i] [-C N] [-E|-F] -n -- pattern`; with `fromFile`, `grep … FILE`
 * (a file's final newline TERMINATES its last line instead of adding an empty one). The Bash only
 * passes `-C` when N > 0, so no `--` group separator is ever printed at N = 0.
 */
function grepContent(content: string, pattern: string, opts: GrepOpts, fromFile = false): string[] {
  const synthetic = fromFile ? content : content + "\n";
  const parts = synthetic.split("\n");
  if (fromFile) {
    if (parts[parts.length - 1] === "") parts.pop();
  } else {
    parts.pop(); // trailing element after the final \n
  }
  const n = parts.length;
  const matchIdx = new Set<number>();
  parts.forEach((l, i) => {
    if (grepMatchLine(l, pattern, opts)) matchIdx.add(i);
  });
  if (matchIdx.size === 0) return [];

  const include = new Array<boolean>(n).fill(false);
  for (const i of matchIdx) {
    for (let j = Math.max(0, i - opts.contextLines); j <= Math.min(n - 1, i + opts.contextLines); j++) {
      include[j] = true;
    }
  }
  const out: string[] = [];
  let lastIncluded = -2;
  for (let i = 0; i < n; i++) {
    if (!include[i]) continue;
    if (opts.contextLines > 0 && i - lastIncluded > 1 && out.length > 0) out.push("--");
    const sep = matchIdx.has(i) ? ":" : "-";
    out.push(`${i + 1}${sep}${parts[i]}`);
    lastIncluded = i;
  }
  return out;
}

// ---------------------------------------------------------------------------
// new  (bin/traj:323-399)
// ---------------------------------------------------------------------------

interface NewResult {
  trajId: string;
  relPath: string;
  trajFile: string;
}

function sanitizeSlug(slug: string): string {
  let s = slug.replace(/[\n\r\t]/g, "-").toLowerCase();
  s = s.replace(/[^a-z0-9._-]/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-/, "").replace(/-$/, "");
  s = byteSlice(s, 60);
  return s || "unnamed";
}

function cmdNewCore(io: TrajIO, trajDirOpt: string, slug: string, fields: [string, string][]): NewResult {
  const trajDir = trajDirOpt || io.env.TRAJ_DIR || "";
  if (!trajDir) die("new: --traj_dir or TRAJ_DIR required");

  const uuid = genStepId();
  const hex8 = uuid.split("-")[0]!;
  const safeSlug = sanitizeSlug(slug);
  const dirName = `${hex8}-${safeSlug}`;

  let parentId = "";
  for (const [k, v] of fields) if (k === "parent_traj") parentId = v;

  let baseDir = trajDir;
  let parentFile: string | undefined;
  if (parentId) {
    parentFile = resolveTrajFile(trajDir, parentId);
    if (parentFile && isFile(parentFile)) baseDir = path.dirname(parentFile);
  }

  const trajDirPath = path.join(baseDir, dirName);
  fs.mkdirSync(trajDirPath, { recursive: true });
  const trajFile = path.join(trajDirPath, "trajectory.jsonl");

  const record: AnyStep = { type: "trajectory" };
  for (const [k, v] of fields) record[k] = v;
  if (parentFile) {
    record.parent_traj_ref = path.relative(trajDirPath, path.dirname(parentFile)) || ".";
  }
  record.step_id = uuid;
  record.ts = isoTs();

  fs.writeFileSync(trajFile, JSON.stringify(record) + "\n");

  const relPath = path.relative(trajDir, trajDirPath);
  return { trajId: uuid, relPath, trajFile };
}

function parseFieldFlagValue(v: string): [string, string] {
  const eq = v.indexOf("=");
  return eq >= 0 ? [v.slice(0, eq), v.slice(eq + 1)] : [v, ""];
}

function cmdNew(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let slug = "unnamed";
  const fields: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "new", "--traj_dir requires DIR");
      i++;
    } else if (a === "--slug") {
      slug = reqFlagVal(argv, i, "new", "--slug requires TEXT");
      i++;
    } else if (a === "--field") {
      const v = reqFlagVal(argv, i, "new", "--field requires key=val");
      i++;
      fields.push(parseFieldFlagValue(v));
    } else if (a.startsWith("-")) {
      die(`new: unknown option: ${a}`);
    } else {
      die(`new: unexpected argument: ${a}`);
    }
  }
  const { trajId, relPath } = cmdNewCore(io, trajDirOpt, slug, fields);
  io.stdout(`${trajId}\n${relPath}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// append (bin/traj:405-567) — thin CLI wrapper over doAppend.
// ---------------------------------------------------------------------------

function cmdAppend(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  const fields: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "append", "--traj_dir requires DIR");
      i++;
    } else if (a === "--field") {
      const v = reqFlagVal(argv, i, "append", "--field requires key=val");
      i++;
      fields.push(parseFieldFlagValue(v));
    } else if (a.startsWith("-")) {
      die(`append: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`append: unexpected argument: ${a}`);
    }
  }

  let record: AnyStep;
  if (fields.length > 0) {
    record = {};
    for (const [k, v] of fields) record[k] = v;
  } else {
    const raw = io.readStdin();
    if (!raw) die("append: empty stdin (use --field to build step without stdin)");
    const parsed = tryParseLine(raw.trim());
    if (!parsed) die("append: invalid JSON on stdin");
    record = parsed;
  }

  const stepType = jqField(record, "type");
  if (!stepType) die("append: step record must have a 'type' field");

  const stepId = doAppend(io, "append", trajDirOpt, trajIdOpt, record);
  io.stdout(`${stepId}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// fork (bin/traj:1257-1324)
// ---------------------------------------------------------------------------

function cmdFork(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let childId = "";
  let slug = "";
  let forkStepId = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "fork", "--traj_dir requires DIR");
      i++;
    } else if (a === "--child") {
      childId = reqFlagVal(argv, i, "fork", "--child requires CHILD_ID");
      i++;
    } else if (a === "--slug") {
      slug = reqFlagVal(argv, i, "fork", "--slug requires TEXT");
      i++;
    } else if (a === "--step-id") {
      forkStepId = reqFlagVal(argv, i, "fork", "--step-id requires UUID");
      i++;
    } else if (a.startsWith("-")) {
      die(`fork: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`fork: unexpected argument: ${a}`);
    }
  }

  if (!forkStepId) forkStepId = genStepId();

  const parentFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "fork");
  const parentDir = path.dirname(parentFile);

  if (!childId) {
    // PORT-NOTE (bugs #60, #61): upstream computes this via `head -1
    // "$parent_file" | jq -r '.step_id'` (bin/traj:1300) with NO JSON
    // validation of its own — under `set -euo pipefail`, that pipeline's
    // own behavior differs by what `head -1` actually produced:
    //   - parent_file is EMPTY (no first line at all): `head -1` writes
    //     ZERO bytes, jq then reads zero JSON documents from empty stdin
    //     and produces ZERO output (exit 0) — the `$(...)` captures "",
    //     and fork proceeds writing `"parent_traj":""`. Verified directly
    //     (parity/fuzz/findings/traj-c2-2.md): forking a trajectory whose
    //     file is empty -> bash's child record has `"parent_traj":""`.
    //     `tryParseLine("")` returns undefined the SAME way a genuinely
    //     malformed line does, so `jqRawField`'s "no field -> jq prints
    //     literal null" mapping (correct when a real JSON object was
    //     parsed) wrongly fired here too, writing the four-character
    //     string "null" instead of "" — this is the bug #60 fix: treat an
    //     EMPTY first line as "" up front, before ever calling jqRawField.
    //   - parent_file's first line is NON-EMPTY but not valid JSON: `head
    //     -1 | jq -r '.step_id'` makes jq itself parse-error and die (exit
    //     5, no stdout), which — being the last command of the pipeline
    //     substituted into a plain assignment under `set -e` — aborts the
    //     WHOLE script before any child dir is created or the parent file
    //     is touched. Verified directly (parity/fuzz/findings/traj-c2-3.md):
    //     a trajectory whose only content is `not-json-at-all{{{` -> bash
    //     exits 5 with jq's parse-error text, no child created, parent file
    //     unchanged. Matched here the same way bug #48 matched it for
    //     `last`/`search`: the EXIT CODE (5) is reproduced, jq's own
    //     parse-error wording is not (PARITY.md's jq-internal-error
    //     allowance) — this is bug #61's fix.
    const firstLineRaw = readFirstLineRaw(parentFile);
    let parentTrajId: string;
    if (firstLineRaw === "") {
      parentTrajId = "";
    } else {
      const parsed = tryParseLine(firstLineRaw);
      if (!parsed) throw new TrajExit(5, `fork: ${parentFile}: invalid JSON in trajectory`);
      parentTrajId = jqRawField(parsed, "step_id");
    }
    const fields: [string, string][] = [
      ["parent_traj", parentTrajId],
      ["parent_step", forkStepId],
    ];
    const { trajId } = cmdNewCore(io, parentDir, slug || "unnamed", fields);
    childId = trajId;
  }

  const searchDir = io.env.TRAJ_DIR || parentDir;
  let childFile = resolveTrajFile(searchDir, childId);
  if (!childFile) childFile = resolveTrajFile(parentDir, childId);
  const childRef = childFile && isFile(childFile) ? path.relative(parentDir, childFile) : "";

  const forkJson: AnyStep = { type: "fork", child: childId, step_id: forkStepId };
  if (childRef) forkJson.child_ref = childRef;

  doAppend(io, "fork", trajDirOpt, trajIdOpt, forkJson);
  io.stdout(`${childId}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// merge (bin/traj:1330-1394)
// ---------------------------------------------------------------------------

function cmdMerge(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let fromTraj = "";
  const fields: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--field") {
      const v = reqFlagVal(argv, i, "merge", "--field requires key=val");
      i++;
      fields.push(parseFieldFlagValue(v));
    } else if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "merge", "--traj_dir requires DIR");
      i++;
    } else if (a.startsWith("-")) {
      die(`merge: unknown option: ${a}`);
    } else if (fromTraj === "") {
      fromTraj = a;
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`merge: unexpected argument: ${a}`);
    }
  }
  if (!fromTraj) die("merge requires <child_traj_id>");

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "merge");
  const trajDir = path.dirname(trajFile);

  const searchDir = io.env.TRAJ_DIR || trajDir;
  const childFile = resolveTrajFile(searchDir, fromTraj);
  if (!childFile) die(`merge: cannot resolve child traj '${fromTraj}'`);
  if (!isFile(childFile)) die(`merge: child file not found for traj '${fromTraj}'`);

  const lastStepId = jqField(tryParseLine(readLastLineRaw(childFile)), "step_id");
  if (!lastStepId) die(`merge: child '${fromTraj}' has no steps`);

  const fromTrajRef = path.relative(trajDir, childFile);

  const mergeJson: AnyStep = { type: "merge", from_traj: fromTraj, from_step: lastStepId };
  if (fromTrajRef) mergeJson.from_traj_ref = fromTrajRef;
  for (const [k, v] of fields) mergeJson[k] = v;

  const stepId = doAppend(io, "merge", trajDirOpt, trajIdOpt, mergeJson);
  io.stdout(`${stepId}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// show (bin/traj:573-725)
// ---------------------------------------------------------------------------

/** `_find_step_in_dir` (bin/traj:575-601). */
function findStepInDir(trajDir: string, stepId: string): { file: string; row: string } | undefined {
  const trajFile = resolveTrajFile(trajDir, stepId);
  if (trajFile && isFile(trajFile)) {
    const row = readFirstLineRaw(trajFile);
    return { file: trajFile, row };
  }
  // Slow path: scan every .jsonl under trajDir (excluding blobs/) for a
  // step_id match (exact or prefix).
  const files: string[] = [];
  (function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (path.basename(full) === "blobs") continue;
        walk(full);
      } else if (e.isFile() && full.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  })(trajDir);

  for (const f of files) {
    for (const line of coreutilsLines(f)) {
      const obj = tryParseLine(line);
      if (!obj) continue;
      const sid = jqField(obj, "step_id");
      if (sid === stepId || sid.startsWith(stepId)) return { file: f, row: line };
    }
  }
  return undefined;
}

function cmdShow(io: TrajIO, argv: string[]): number {
  let targetId = "";
  let full = false;
  let pretty = false;
  let field = "";
  let trajDirOpt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--full") full = true;
    else if (a === "--pretty") pretty = true;
    else if (a === "--field") {
      field = reqFlagVal(argv, i, "show", "--field requires a value");
      i++;
    } else if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "show", "--traj_dir requires DIR");
      i++;
    } else if (a.startsWith("-")) {
      die(`show: unknown option: ${a}`);
    } else if (targetId === "") {
      targetId = a;
    } else {
      die(`show: unexpected argument: ${a}`);
    }
  }
  if (!targetId) die("show requires <id> (trajectory or step UUID)");

  const trajDir = trajDirOpt || io.env.TRAJ_DIR || "";
  if (!trajDir) die("show: --traj_dir or TRAJ_DIR required");

  const result = findStepInDir(trajDir, targetId);
  if (!result) die(`show: id '${targetId}' not found in '${trajDir}'`);
  const { file: trajFile, row } = result;
  if (!row) die(`show: id '${targetId}' not found`);

  let step = tryParseLine(row);
  const rowType = jqField(step, "type");
  const rowStepId = jqField(step, "step_id");
  const firstStep = tryParseLine(readFirstLineRaw(trajFile));
  const firstStepId = jqField(firstStep, "step_id");

  if (rowType === "trajectory" && rowStepId === firstStepId && !field && !full) {
    io.stdout(`File:   ${trajFile}\n`);
    io.stdout(`Steps:  ${wcL(trajFile)}\n`);
    const firstTs = jqField(step, "ts");
    io.stdout(`ID:     ${rowStepId}\n`);
    io.stdout(`Start:  ${firstTs}\n`);
    const lastStep = tryParseLine(readLastLineRaw(trajFile));
    io.stdout(`Last:   ${jqField(lastStep, "ts")}\n`);
    const parent = jqField(step, "parent_traj") || jqField(step, "parent");
    if (!parent) io.stdout(`Root:   yes\n`);
    else io.stdout(`Parent: ${parent}\n`);
    io.stdout(`Summary: ${getSummary(trajFile)}\n`);
    return 0;
  }

  if (full && step) {
    const stdoutRef = jqField(step, "stdout_ref");
    if (stdoutRef) {
      const blobPath = path.join(path.dirname(trajFile), stdoutRef);
      if (isFile(blobPath)) {
        const full_ = fs.readFileSync(blobPath, "utf8");
        step = { ...step, stdout: full_ };
        delete step.stdout_truncated;
      }
    }
    const stderrRef = jqField(step, "stderr_ref");
    if (stderrRef) {
      const blobPath = path.join(path.dirname(trajFile), stderrRef);
      if (isFile(blobPath)) {
        const full_ = fs.readFileSync(blobPath, "utf8");
        step = { ...step, stderr: full_ };
        delete step.stderr_truncated;
      }
    }
  }

  if (field) {
    printJqFieldOrEmpty(io, step, field);
    return 0;
  }

  if (pretty) {
    for (const [k, v] of Object.entries(step ?? {})) {
      if (typeof v === "string") {
        io.stdout(`\u001b[36m${k}\u001b[0m:\n${v}\n\n`);
      } else {
        io.stdout(`\u001b[36m${k}\u001b[0m: ${JSON.stringify(v)}\n\n`);
      }
    }
    return 0;
  }

  io.stdout(JSON.stringify(step, null, 2) + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// tail (bin/traj:1025-1148) / cat (bin/traj:1470-1576)
// ---------------------------------------------------------------------------

interface StreamFormatOpts {
  filters: FilterSpec[];
  format: boolean; // formatted vs raw
  colors: Colors;
}
function setupStreamFormat(io: TrajIO, filters: string[], raw: boolean, forceFormat: boolean, useColorOpt: -1 | 0): StreamFormatOpts {
  const filterSpecs = parseFilterFlags(filters);
  let format: boolean;
  if (raw) format = false;
  else if (forceFormat) format = true;
  else if (!io.isTTY && (io.env.CLICOLOR_FORCE ?? "0") === "0") format = false;
  else format = true;

  let useColor: boolean;
  if (useColorOpt === 0) useColor = false;
  else useColor = format && colorEnabled(io);

  return { filters: filterSpecs, format, colors: useColor ? ansiColors() : NO_COLORS };
}

function cmdTail(io: TrajIO, argv: string[]): number {
  let n = 10;
  let follow = false;
  let raw = false;
  let forceFormat = false;
  let useColorOpt: -1 | 0 = -1;
  let trajDirOpt = "";
  let trajIdOpt = "";
  let recursive = false;
  let allFields = false;
  const filters: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-n") {
      n = Number(reqFlagVal(argv, i, "tail", "-n requires a number"));
      i++;
    } else if (a === "-f") follow = true;
    else if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "tail", "--traj_dir requires DIR");
      i++;
    } else if (a === "--raw") raw = true;
    else if (a === "--format") forceFormat = true;
    else if (a === "--no-color") useColorOpt = 0;
    else if (a === "--filter") {
      filters.push(reqFlagVal(argv, i, "tail", "--filter requires field=value"));
      i++;
    } else if (a === "-a" || a === "--all") allFields = true;
    else if (a === "-r" || a === "--recursive") recursive = true;
    else if (a === "-h" || a === "--help") {
      io.stdout(TAIL_HELP);
      return 0;
    } else if (a.startsWith("-")) {
      die(`tail: unknown option: ${a}`);
    } else if (/^[0-9]+$/.test(a)) {
      n = Number(a);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`tail: unexpected argument: ${a}`);
    }
  }

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "tail");
  const { filters: filterSpecs, format, colors } = setupStreamFormat(io, filters, raw, forceFormat, useColorOpt);

  const emit = (line: string): void => {
    if (format) {
      const out = formatLine(line, allFields, filterSpecs, colors);
      if (out !== undefined) io.stdout(out);
    } else {
      const out = filterSpecs.length ? rawFilteredLine(line, filterSpecs) : line + "\n";
      if (out !== undefined) io.stdout(out);
    }
  };

  if (recursive) {
    if (!isFile(trajFile)) die(`tail: trajectory file not found: ${trajFile}`);
    const allFiles = collectRecursiveFiles(trajFile);
    if (allFiles.length === 0) return 0;
    const sorted = sortedTreeSteps(allFiles, filterSpecs);
    for (const line of tailLastN(sorted, n)) emit(line);
    if (follow) followFiles(io, allFiles, emit);
    return 0;
  }

  if (follow) {
    if (isFile(trajFile) && n > 0) {
      for (const line of tailLastN(coreutilsLines(trajFile), n)) emit(line);
    }
    followFiles(io, [trajFile], emit);
    return 0;
  }

  if (!isFile(trajFile)) die(`tail: trajectory file not found: ${trajFile}`);
  for (const line of tailLastN(coreutilsLines(trajFile), n)) emit(line);
  return 0;
}

// PORT-NOTE (bug #51): `arr.slice(-n)` is used to take "the last n items",
// mirroring coreutils `tail -n N`. But when N is exactly 0, JS's `-0 === 0`
// collapses `arr.slice(-0)` to `arr.slice(0)` — the WHOLE array — instead of
// an empty one; `tail -n 0 <file>` (real coreutils, what bin/traj:1141
// shells out to) prints nothing. Verified directly: a 3-line fixture,
// `tail -n 0 <file>` -> empty stdout, exit 0 (upstream); pre-fix port
// printed all 3 lines for `traj tail -n 0`. `tailLastN` special-cases
// n === 0 to `[]`.
// PORT-NOTE (bug #62): coreutils' own `tail -n N` treats a LEADING `-` on
// the count as idiomatic, not sign-inverting — `tail -n -2` and `tail -n 2`
// both mean "the last 2 lines," clamped to however many lines exist. This
// port parses `-n`'s value with a plain `Number(...)`, so `-n -2` arrives
// here as the JS number -2; `.slice(-n)` then computes `.slice(2)` — "skip
// the first 2, keep the rest" — the opposite of "last 2." Verified directly
// against upstream (parity/fuzz/findings/traj-c2-5.md): `traj tail -n -2`
// against a 1-line trajectory -> bash prints the one line (exit 0); the
// port printed nothing. Fixed by treating N's sign as irrelevant — always
// slice by its absolute value, matching bash/coreutils' "last |N| lines
// regardless of sign" semantics.
function tailLastN<T>(arr: T[], n: number): T[] {
  if (n === 0) return [];
  return arr.slice(-Math.abs(n));
}

/** `-f` poll loop (bin/traj:1111-1141): watches file(s) for new lines by
 *  polling size, emitting each new line as it appears. Stops when
 *  io.shouldStop() returns true (mirrors the bash trap on SIGINT/PIPE). */
function followFiles(io: TrajIO, files: string[], emit: (line: string) => void): void {
  const offsets = new Map<string, number>();
  for (const f of files) {
    try {
      offsets.set(f, fs.statSync(f).size);
    } catch {
      offsets.set(f, 0);
    }
  }
  while (!io.shouldStop()) {
    for (const f of files) {
      let size: number;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      const prev = offsets.get(f) ?? 0;
      if (size > prev) {
        const fd = fs.openSync(f, "r");
        try {
          const buf = Buffer.alloc(size - prev);
          fs.readSync(fd, buf, 0, buf.length, prev);
          const chunk = buf.toString("utf8");
          const lines = chunk.split("\n");
          const trailing = lines.pop() ?? ""; // unterminated tail, if any
          for (const line of lines) if (line !== "") emit(line);
          offsets.set(f, size - Buffer.byteLength(trailing, "utf8"));
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    io.sleepMs(100);
  }
}

const TAIL_HELP = `traj tail — Stream trajectory steps

Usage:
  traj tail [ID] [-n N] [-f]        Show recent steps
  traj tail [ID] --filter field=val  Filter steps
  traj tail [ID] -r                  Include sub-trajectory steps

Options:
  [ID]               Trajectory ID (positional)
  -n N               Last N steps (default: 10)
  -f                 Follow new steps as they arrive
  -a, --all          Show all fields per step (not just type + content)
  -r, --recursive    Include steps from all sub-trajectories, interleaved
  --traj_dir DIR     Trajectory directory
  --filter field=val Filter steps (e.g. --filter type=thought,merge).
                     Multiple --filter flags are AND'd.
                     Comma-separated values within a filter are OR'd.
  --raw              Raw JSONL (default when piped)
  --format           Force formatted output (even when piped)
  --no-color         Disable ANSI colors
  -h, --help         Show this help

Environment:
  TRAJ_DIR + TRAJ_ID   Default trajectory
`;

const CAT_HELP = `traj cat — Output all trajectory steps

Usage:
  traj cat [ID]                    Output all steps
  traj cat [ID] --filter field=val Filter steps
  traj cat [ID] -r                 Include sub-trajectory steps

Options:
  [ID]               Trajectory ID (positional)
  -a, --all          Show all fields per step (not just type + content)
  -r, --recursive    Include steps from all sub-trajectories
  --traj_dir DIR     Trajectory directory
  --filter field=val Filter steps (e.g. --filter type=thought,merge).
                     Multiple --filter flags are AND'd.
                     Comma-separated values within a filter are OR'd.
  --raw              Raw JSONL (default when piped)
  --format           Force formatted output (even when piped)
  --no-color         Disable ANSI colors
  -h, --help         Show this help

Environment:
  TRAJ_DIR + TRAJ_ID   Default trajectory
`;

function cmdCat(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let raw = false;
  let forceFormat = false;
  let useColorOpt: -1 | 0 = -1;
  let recursive = false;
  let allFields = false;
  const filters: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "cat", "--traj_dir requires DIR");
      i++;
    } else if (a === "--raw") raw = true;
    else if (a === "--format") forceFormat = true;
    else if (a === "--no-color") useColorOpt = 0;
    else if (a === "--filter") {
      filters.push(reqFlagVal(argv, i, "cat", "--filter requires field=value"));
      i++;
    } else if (a === "-a" || a === "--all") allFields = true;
    else if (a === "-r" || a === "--recursive") recursive = true;
    else if (a === "-h" || a === "--help") {
      io.stdout(CAT_HELP);
      return 0;
    } else if (a.startsWith("-")) {
      die(`cat: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`cat: unexpected argument: ${a}`);
    }
  }

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "cat");
  if (!isFile(trajFile)) return 0;

  const { filters: filterSpecs, format, colors } = setupStreamFormat(io, filters, raw, forceFormat, useColorOpt);

  if (recursive) {
    const allFiles = collectRecursiveFiles(trajFile);
    if (allFiles.length === 0) return 0;
    const sorted = sortedTreeSteps(allFiles, filterSpecs);
    for (const line of sorted) {
      if (format) {
        const out = formatLine(line, allFields, [], colors); // already filtered above
        if (out !== undefined) io.stdout(out);
      } else {
        io.stdout(line + "\n");
      }
    }
    return 0;
  }

  if (!format) {
    if (filterSpecs.length === 0) {
      io.stdout(fs.readFileSync(trajFile, "utf8"));
    } else {
      for (const line of coreutilsLines(trajFile)) {
        const out = rawFilteredLine(line, filterSpecs);
        if (out !== undefined) io.stdout(out);
      }
    }
    return 0;
  }

  for (const line of coreutilsLines(trajFile)) {
    const out = formatLine(line, allFields, filterSpecs, colors);
    if (out !== undefined) io.stdout(out);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// search (bin/traj:1154-1251)
// ---------------------------------------------------------------------------

/** `_jq_image`: the bytes one character takes inside a jq-serialized string. */
function jqImage(c: string): string {
  if (c === "\\") return "\\\\";
  if (c === '"') return '\\"';
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  if (c === "\b") return "\\b";
  if (c === "\f") return "\\f";
  const code = c.codePointAt(0)!;
  if (code < 32 || code === 127) return "\\u" + code.toString(16).padStart(4, "0");
  return c;
}

/**
 * `_traj_prefilter_literal`: the -F pattern translated for the SERIALIZED line (a newline in
 * the pattern splits it into alternatives, each translated on its own). Returns the list of
 * alternatives (grep -F -e semantics: a row is a candidate if it contains ANY of them).
 */
function prefilterLiteralAlternatives(pattern: string): string[] {
  return pattern.split("\n").map((alt) => [...alt].map(jqImage).join(""));
}

/** Row text → the one-line JSON object `jq` would see, or undefined when jq would error. */
function parseRowStrict(row: string): AnyStep | null | undefined {
  try {
    const v = JSON.parse(row);
    return v as AnyStep | null;
  } catch {
    return undefined;
  }
}

/**
 * `jq -r ".${f} // empty"` captured by `$(...)`: a string as-is, a number/bool as its text, an
 * object/array PRETTY-printed (jq -r keeps jq's default 2-space indent), trailing newlines stripped.
 */
function jqRawPretty(obj: AnyStep | null, key: string): string {
  const v = obj == null ? undefined : obj[key];
  if (!jqTruthy(v)) return "";
  const text = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v, null, 2) : jqStr(v);
  return text.replace(/\n+$/, "");
}

/** `... | tail -n N` over a file's lines (an unterminated final line counts). */
function lastLines(file: string, n: number): string[] {
  const lines = coreutilsLines(file);
  return n > 0 ? lines.slice(Math.max(0, lines.length - n)) : lines;
}

function cmdSearch(io: TrajIO, argv: string[]): number {
  let pattern = "";
  let field = "all";
  let ci = false;
  let contextLines = 0;
  let useRegex = false;
  let trajDirOpt = "";
  let trajIdOpt = "";
  let recursive = false;
  let tailRaw = "0";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--field") {
      field = reqFlagVal(argv, i, "search", "--field requires a value");
      i++;
    } else if (a === "--tail") {
      tailRaw = reqFlagVal(argv, i, "search", "--tail requires a number");
      i++;
    } else if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "search", "--traj_dir requires DIR");
      i++;
    } else if (a === "-i") ci = true;
    else if (a === "-C") {
      contextLines = Number(reqFlagVal(argv, i, "search", "-C requires a number"));
      i++;
    } else if (a === "-E") useRegex = true;
    else if (a === "-r" || a === "--recursive") recursive = true;
    else if (a.startsWith("-")) {
      die(`search: unknown option: ${a}`);
    } else if (pattern === "") {
      pattern = a;
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`search: unexpected argument: ${a}`);
    }
  }
  if (!pattern) die("search requires <pattern>");
  if (!/^[0-9]+$/.test(tailRaw)) die(`search: --tail must be a number, got '${tailRaw}'`);
  const tailN = Number(tailRaw);

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "search");
  if (!isFile(trajFile)) die(`search: trajectory file not found: ${trajFile}`);

  const fieldsToSearch = field === "all" ? ["content", "thought", "cmd", "stdout", "stderr"] : [field];
  const searchFiles = recursive ? collectRecursiveFiles(trajFile) : [trajFile];
  const gopts = { ci, contextLines, regex: useRegex };

  const emit = (trajHex: string, stepId: string, f: string, matchLine: string): void => {
    if (recursive) io.stdout(`${trajHex}:${stepId}:${f}:${matchLine}\n`);
    else io.stdout(`${stepId}:${f}:${matchLine}\n`);
  };

  for (const sf of searchFiles) {
    if (!isFile(sf)) continue;
    const trajHex = parseHexId(sf);
    const blobBase = path.dirname(sf);
    const rows = lastLines(sf, tailN); // `tail -n N`, or the whole file

    // PORT-NOTE (sync 2e39a3f, 3732d20/fceda76/67c26f0/defd719/21a10e7/dcbb9c0 + --tail): the
    // Bash now searches each file in TWO passes — (1) a row pass over the rows whose serialized
    // text matches the pattern's prefilter and that carry no `_ref":`, in row order, then (2) a
    // reference pass over every row with a `_ref":` key, in row order — so a blob-backed row's
    // matches come AFTER every inline row's. The JS port reproduces that order and the pass
    // semantics. The grep PREFILTER itself (a perf device: "can only widen the candidate set,
    // the decoded grep stays the judge") is not reproduced for -E (no row is dropped), and for
    // -F only decides which MALFORMED rows crash the row pass — see PARITY.md.
    const alts = useRegex ? null : prefilterLiteralAlternatives(pattern);
    const isCandidate = (row: string): boolean => {
      if (alts === null) return true;
      const hay = ci ? row.toLowerCase() : row;
      return alts.some((a) => hay.includes(ci ? a.toLowerCase() : a));
    };

    // --- row pass ---
    for (const row of rows) {
      if (!isCandidate(row)) continue;
      if (row.includes('_ref":')) continue;
      // jq -r '.step_id // empty' on the RAW row: a malformed candidate row makes jq die
      // (exit 5) under the script's `set -e`, after the earlier matches were printed.
      // PORT-NOTE (bug #48): only the exit code is matched; jq's wording is build-specific.
      const obj = parseRowStrict(row);
      if (obj === undefined || (obj !== null && typeof obj !== "object") || Array.isArray(obj)) {
        throw new TrajExit(5, `search: ${sf}: invalid JSON in row`);
      }
      const stepId = jqField(obj, "step_id");
      if (!stepId) continue;
      for (const f of fieldsToSearch) {
        const content = jqRawPretty(obj, f);
        if (!content) continue;
        for (const m of grepContent(content, pattern, gopts)) emit(trajHex, stepId, f, m);
      }
    }

    // --- reference pass (one jq over the `_ref":` rows; stops at the first row jq cannot read) ---
    const refRows = rows.filter((r) => (ci ? r.toLowerCase() : r).includes('_ref":'));
    for (const row of refRows) {
      const obj = parseRowStrict(row);
      // jq (no -R) aborts the whole stream at a parse error, or on indexing a non-object;
      // `|| true` swallows it, so only the rows BEFORE it are searched.
      if (obj === undefined || (obj !== null && (typeof obj !== "object" || Array.isArray(obj)))) break;
      const stepId = obj === null ? "" : jqField(obj, "step_id");
      for (const f of fieldsToSearch) {
        const rec = obj as AnyStep | null;
        const cRaw = rec === null ? undefined : rec[f];
        const c = !jqTruthy(cRaw) ? "" : typeof cRaw === "string" ? cRaw : jqStr(cRaw);
        const rRaw = rec === null ? undefined : rec[f + "_ref"];
        const r = !jqTruthy(rRaw) ? "" : jqStr(rRaw);
        if (c === "" && r === "") continue;
        if (!stepId) continue;
        let text: string | undefined;
        let fromFile = false;
        if (r && isFile(path.join(blobBase, r))) {
          text = fs.readFileSync(path.join(blobBase, r), "utf8");
          fromFile = true;
        } else if (c !== "") text = c;
        if (text === undefined) continue;
        for (const m of grepContent(text, pattern, gopts, fromFile)) emit(trajHex, stepId, f, m);
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// count / last / exists / path (bin/traj:1400-1657)
// ---------------------------------------------------------------------------

function cmdCount(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "count", "--traj_dir requires DIR");
      i++;
    } else if (a.startsWith("-")) {
      die(`count: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`count: unexpected argument: ${a}`);
    }
  }
  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "count");
  if (!isFile(trajFile)) {
    io.stdout("0\n");
    return 0;
  }
  io.stdout(`${wcL(trajFile)}\n`);
  return 0;
}

function cmdLast(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let field = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "last", "--traj_dir requires DIR");
      i++;
    } else if (a === "--field") {
      field = reqFlagVal(argv, i, "last", "--field requires KEY");
      i++;
    } else if (a.startsWith("-")) {
      die(`last: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`last: unexpected argument: ${a}`);
    }
  }
  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "last");
  if (!isFile(trajFile)) die(`last: trajectory file not found: ${trajFile}`);

  const lastLine = readLastLineRaw(trajFile);
  if (!lastLine) {
    io.stdout("\n");
    return 0;
  }

  if (field) {
    const obj = tryParseLine(lastLine);
    // PORT-NOTE (bug #48): upstream pipes the raw last line straight into
    // `jq -r ".${field} // empty"` (bin/traj:708) with NO JSON validation
    // first. Under this script's `set -euo pipefail`, a malformed last
    // line makes jq itself die (a parse/runtime error — text varies with
    // the garbage content, e.g. "jq: parse error: Invalid numeric literal
    // at line 1, column 16" for this repo's fuzz fixture's fixed
    // "not-json-at-all{{{" line), which aborts the WHOLE script with jq's
    // own exit code (5) — verified directly: `printf '%s'
    // "not-json-at-all{{{" | jq -r '.step_id // empty'` -> that exact
    // message, status 5. jq's exact wording is jq-build/version-specific
    // boilerplate, not data this port computes, so only the EXIT CODE is
    // matched here; see PARITY.md's traj row (jq-internal-error
    // allowance) and parity/fuzz/findings/traj-1.md.
    if (!obj) throw new TrajExit(5, `last: ${trajFile}: invalid JSON in last step`);
    printJqFieldOrEmpty(io, obj, field);
    return 0;
  }
  io.stdout(lastLine + "\n");
  return 0;
}

function cmdExists(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "exists", "--traj_dir requires DIR");
      i++;
    } else if (a.startsWith("-")) {
      die(`exists: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`exists: unexpected argument: ${a}`);
    }
  }
  const dir = trajDirOpt || io.env.TRAJ_DIR || "";
  const id = trajIdOpt || io.env.TRAJ_ID || "";
  if (!dir || !id) return 1;
  const trajFile = resolveTrajFile(dir, id);
  if (!trajFile || !isFile(trajFile)) return 1;
  return wcL(trajFile) > 0 ? 0 : 1;
}

const PATH_HELP = `traj path — Print the resolved trajectory file path

Usage:
  traj path [ID]

Options:
  [ID]               Trajectory ID (positional)
  --traj_dir DIR     Trajectory directory

Environment:
  TRAJ_DIR + TRAJ_ID   Default trajectory
`;

function cmdPath(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "path", "--traj_dir requires DIR");
      i++;
    } else if (a === "-h" || a === "--help") {
      io.stdout(PATH_HELP);
      return 0;
    } else if (a.startsWith("-")) {
      die(`path: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`path: unexpected argument: ${a}`);
    }
  }
  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "path");
  io.stdout(trajFile + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// root (bin/traj:1665-1706)
// ---------------------------------------------------------------------------

function cmdRoot(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "root", "--traj_dir requires DIR");
      i++;
    } else if (a.startsWith("-")) {
      die(`root: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`root: unexpected argument: ${a}`);
    }
  }
  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "root");
  const trajDir = trajDirOpt || io.env.TRAJ_DIR || path.dirname(trajFile);

  let current = trajFile;
  const maxDepth = 50;
  for (let depth = 0; depth < maxDepth; depth++) {
    const parentFile = resolveParentFile(current, trajDir);
    if (!parentFile || !isFile(parentFile)) break;
    current = parentFile;
  }

  let display = path.basename(current);
  if (display === "trajectory.jsonl") display = path.basename(path.dirname(current));
  io.stdout(display + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// list (bin/traj:1712-2061)
// ---------------------------------------------------------------------------

function listCollectChildren(
  trajFile: string,
  trajDir: string,
  maxDepth: number,
  curDepth: number,
  out: { files: string[]; depths: number[]; isSelf: number[] },
  ancestors: ReadonlySet<string> = new Set(),
): void {
  if (!isFile(trajFile)) return;
  // PORT-NOTE (sync 2e39a3f, d2e62f9 #199): ancestry guard against fork cycles (see collectRecursiveFiles).
  const real = fs.realpathSync(trajFile);
  if (curDepth >= maxDepth || ancestors.has(real)) return;
  const chain = new Set(ancestors).add(real);
  const parentDir = path.dirname(real);
  for (const line of coreutilsLines(real)) {
    const obj = tryParseLine(line);
    if (!obj || obj.type !== "fork") continue;
    const childId = jqField(obj, "child");
    if (!childId) continue;
    let childFile: string | undefined;
    const childRefPath = jqField(obj, "child_ref");
    // Raw "$parent_dir/$child_ref" concatenation, NOT path.join: the Bash does not normalize it, so
    // `./x` / `../x` refs surface verbatim in `list` output (hex `.`/`..`, `/./` in --json paths).
    if (childRefPath && isFile(`${parentDir}/${childRefPath}`)) {
      childFile = `${parentDir}/${childRefPath}`;
    } else {
      childFile = resolveTrajFile(trajDir, childId);
    }
    if (childFile && isFile(childFile)) {
      out.files.push(childFile);
      out.depths.push(curDepth + 1);
      out.isSelf.push(0);
      listCollectChildren(childFile, trajDir, maxDepth, curDepth + 1, out, chain);
    }
  }
}

function renderStepsInline(
  io: TrajIO,
  file: string,
  stepPrefix: string,
  trajDir: string,
  maxDepth: number,
  curDepth: number,
  tc: TreeColors,
  ancestors: ReadonlySet<string> = new Set(),
): void {
  if (!isFile(file)) return;
  // PORT-NOTE (sync 2e39a3f, d2e62f9 #199): ancestry guard against fork cycles (see collectRecursiveFiles).
  const real = fs.realpathSync(file);
  if (ancestors.has(real)) return;
  const chain = new Set(ancestors).add(real);
  const lines = coreutilsLines(file);
  const stepTotal = lines.length;
  const parentDir = path.dirname(file);

  lines.forEach((line, idx) => {
    const stepIdx = idx + 1;
    if (stepIdx === 1) return; // skip the trajectory header step
    const obj = tryParseLine(line);
    if (!obj) return;
    const sid = jqField(obj, "step_id").slice(0, 8);
    if (!sid) return;
    const stype = jqField(obj, "type", "?");
    let sref = "";
    if (stype === "fork") sref = jqField(obj, "child");
    else if (stype === "merge") sref = jqField(obj, "from_traj") || jqField(obj, "from_branch");
    let spreview: string;
    if (stype === "reasoning") spreview = cpSlice(jqField(obj, "thought"), 60);
    else if (stype === "shell-output") spreview = cpSlice(jqField(obj, "stdout"), 60);
    else if (stype === "shellm-run") spreview = cpSlice(jqField(obj, "command"), 60);
    else if (stype === "run-summary") spreview = cpSlice(jqField(obj, "tldr"), 60);
    else if (stype === "fork") spreview = "-> " + cpSlice(jqField(obj, "child"), 50);
    else if (stype === "merge") spreview = "<- " + cpSlice(jqField(obj, "content") || jqField(obj, "from_traj"), 50);
    else spreview = cpSlice(jqField(obj, "content"), 60);
    spreview = spreview.replace(/[\n\r\t]/g, " ");

    const stepConnector = stepIdx === stepTotal ? `${tc.tree}└── ${tc.reset}` : `${tc.tree}├── ${tc.reset}`;
    io.stdout(
      `${stepPrefix}${stepConnector}${tc.step}${sid}${tc.reset} ${tc.dim}[${stype}]${tc.reset} ${spreview}\n`,
    );

    if (stype === "fork" && sref && curDepth < maxDepth) {
      const childFile = resolveTrajFile(trajDir, sref);
      if (childFile && isFile(childFile)) {
        const cont = stepIdx === stepTotal ? "    " : `${tc.tree}│${tc.reset}   `;
        const childHex = parseHexId(childFile);
        const childCount = coreutilsLines(childFile).length;
        const childSummary = getSummary(childFile);
        io.stdout(
          `${stepPrefix}${cont}${tc.tree}└── ${tc.reset}${tc.id}${childHex}${tc.reset}: ${childSummary} ${tc.dim}(${childCount} steps)${tc.reset}\n`,
        );
        renderStepsInline(io, childFile, `${stepPrefix}${cont}    `, trajDir, maxDepth, curDepth + 1, tc, chain);
      }
    }
  });
  void parentDir;
}

function printTrajJson(file: string, isSelf: number, depth: number): string {
  const hexId = parseHexId(file);
  const stepCount = coreutilsLines(file).length;
  const summary = getSummary(file);
  const firstStepId = jqField(tryParseLine(readFirstLineRaw(file)), "step_id");
  return JSON.stringify({
    id: firstStepId,
    hex: hexId,
    file,
    summary,
    steps: stepCount,
    depth,
    is_self: isSelf === 1,
  });
}

function cmdList(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let parentsDepth = "";
  let childrenDepth = "all";
  let jsonFormat = false;
  let showSteps = false;
  let childrenExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "list", "--traj_dir requires DIR");
      i++;
    } else if (a === "--parents") {
      parentsDepth = reqFlagVal(argv, i, "list", "--parents requires N or 'all'");
      i++;
    } else if (a === "--children") {
      childrenDepth = reqFlagVal(argv, i, "list", "--children requires N or 'all'");
      childrenExplicit = true;
      i++;
    } else if (a === "--steps") showSteps = true;
    else if (a === "--json") jsonFormat = true;
    else if (a.startsWith("-")) {
      die(`list: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`list: unexpected argument: ${a}`);
    }
  }

  if (!parentsDepth) parentsDepth = trajIdOpt ? "0" : "all";

  let childrenWasDefault = false;
  if (showSteps && !childrenExplicit) {
    childrenDepth = "1";
    childrenWasDefault = true;
  }

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "list");
  const trajDir = trajDirOpt || io.env.TRAJ_DIR || path.dirname(trajFile);

  const maxParents = parentsDepth === "all" ? 999 : Number(parentsDepth);
  const maxChildren = childrenDepth === "all" ? 999 : Number(childrenDepth);

  const files: string[] = [];
  const depths: number[] = [];
  const isSelfArr: number[] = [];

  const parentFiles: string[] = [];
  if (maxParents > 0) {
    let current = trajFile;
    for (let depth = 0; depth < maxParents && depth < 50; depth++) {
      const parentFile = resolveParentFile(current, trajDir);
      if (!parentFile || !isFile(parentFile)) break;
      parentFiles.push(parentFile);
      current = parentFile;
    }
  }
  const parentCount = parentFiles.length;
  for (let i = parentCount - 1; i >= 0; i--) {
    files.push(parentFiles[i]!);
    depths.push(parentCount - 1 - i);
    isSelfArr.push(0);
  }

  const selfDepth = parentCount;
  files.push(trajFile);
  depths.push(selfDepth);
  isSelfArr.push(1);

  if (maxChildren > 0 && !showSteps) {
    listCollectChildren(trajFile, trajDir, maxChildren, selfDepth, {
      files,
      depths,
      isSelf: isSelfArr,
    });
  }

  const count = files.length;

  if (jsonFormat) {
    for (let i = 0; i < count; i++) io.stdout(printTrajJson(files[i]!, isSelfArr[i]!, depths[i]!) + "\n");
    return 0;
  }

  const tc = treeColors(colorEnabled(io));

  const isLast: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = depths[i]!;
    let last = 1;
    for (let j = i + 1; j < count; j++) {
      if (depths[j]! <= d) {
        if (depths[j] === d) last = 0;
        break;
      }
    }
    isLast.push(last);
  }

  const hasMore: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = depths[i]!;
    const file = files[i]!;

    let prefix = "";
    if (d > 0) {
      for (let lvl = 0; lvl < d - 1; lvl++) {
        prefix += (hasMore[lvl] ?? 0) === 1 ? `${tc.tree}│${tc.reset}   ` : "    ";
      }
      prefix += isLast[i] === 1 ? `${tc.tree}└── ${tc.reset}` : `${tc.tree}├── ${tc.reset}`;
    }

    if (d > 0) {
      hasMore[d - 1] = isLast[i] === 1 ? 0 : 1;
    }

    const hexId = parseHexId(file);
    const stepCount = coreutilsLines(file).length;
    const summary = getSummary(file);

    let marker = "";
    let pad = "";
    if (isSelfArr[i] === 1) marker = `${tc.fork}>>> ${tc.reset}`;
    else pad = "    ";

    io.stdout(
      `${marker}${pad}${prefix}${tc.id}${hexId}${tc.reset}: ${summary} ${tc.dim}(${stepCount} steps)${tc.reset}\n`,
    );

    if (showSteps && isFile(file)) {
      let stepBase = "    ";
      if (d > 0) {
        for (let lvl = 0; lvl < d - 1; lvl++) {
          stepBase += (hasMore[lvl] ?? 0) === 1 ? `${tc.tree}│${tc.reset}   ` : "    ";
        }
        stepBase += isLast[i] === 1 ? "    " : `${tc.tree}│${tc.reset}   `;
      }
      renderStepsInline(io, file, stepBase, trajDir, maxChildren, 0, tc);
    }
  }

  if (childrenWasDefault) {
    if (showSteps) {
      const hasForks = coreutilsLines(trajFile).some((l) => tryParseLine(l)?.type === "fork");
      if (hasForks) {
        io.stdout(`${tc.dim}(showing direct children only; use --children all to expand full tree)${tc.reset}\n`);
      }
    } else {
      const childCount = count - selfDepth - 1;
      if (childCount > 0) {
        io.stdout(`${tc.dim}(showing direct children only; use --children all to expand full tree)${tc.reset}\n`);
      }
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// check (bin/traj:2068-2160)
// ---------------------------------------------------------------------------

const CHECK_HELP = `traj check — Validate trajectory JSONL for malformed lines

Usage:
  traj check [ID]         Check a single trajectory file
  traj check [ID] -r      Check all files in the trajectory tree
  traj check [ID] --fix   Remove malformed lines (writes file in place)

Options:
  [ID]               Trajectory ID (positional)
  -r, --recursive    Check all sub-trajectory files too
  --fix              Remove malformed lines from the file(s)
  --traj_dir DIR     Trajectory directory
  -h, --help         Show this help

Environment:
  TRAJ_DIR + TRAJ_ID   Default trajectory
`;

function cmdCheck(io: TrajIO, argv: string[]): number {
  let trajDirOpt = "";
  let trajIdOpt = "";
  let recursive = false;
  let fix = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--traj_dir") {
      trajDirOpt = reqFlagVal(argv, i, "check", "--traj_dir requires DIR");
      i++;
    } else if (a === "-r" || a === "--recursive") recursive = true;
    else if (a === "--fix") fix = true;
    else if (a === "-h" || a === "--help") {
      io.stdout(CHECK_HELP);
      return 0;
    } else if (a.startsWith("-")) {
      die(`check: unknown option: ${a}`);
    } else if (trajIdOpt === "") {
      trajIdOpt = a;
    } else {
      die(`check: unexpected argument: ${a}`);
    }
  }

  const trajFile = requireTrajFile(io, trajDirOpt, trajIdOpt, "check");
  let files = [trajFile];
  if (recursive) {
    const all = collectRecursiveFiles(trajFile);
    if (all.length > 0) files = all;
  }

  let totalBad = 0;
  let totalFiles = 0;
  let totalFixed = 0;

  for (const f of files) {
    if (!isFile(f)) continue;
    totalFiles++;
    let raw: string;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = bashReadLoopLines(raw);
    let bad = 0;
    lines.forEach((line, idx) => {
      // `jq empty` accepts any valid JSON value (not only objects), so a
      // raw JSON.parse — not tryParseLine's object-only check — is the
      // faithful validity test here.
      let ok = true;
      try {
        JSON.parse(line);
      } catch {
        ok = false;
      }
      if (!ok) {
        bad++;
        const preview = line.slice(0, 80);
        io.stdout(`${f}:${idx + 1}: ${preview}\n`);
      }
    });

    if (bad > 0) {
      totalBad += bad;
      if (fix) {
        const kept = lines.filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        });
        fs.writeFileSync(f, kept.map((l) => l + "\n").join(""));
        totalFixed += bad;
        io.stdout(`  fixed: removed ${bad} malformed line(s)\n`);
      }
    }
  }

  if (totalBad === 0) {
    io.stdout(`OK: ${totalFiles} file(s) checked, no malformed lines\n`);
    return 0;
  }
  io.stdout(`${totalBad} malformed line(s) in ${totalFiles} file(s)\n`);
  if (fix) {
    io.stdout(`Fixed: removed ${totalFixed} line(s)\n`);
    return 0;
  }
  io.stdout(`Run with --fix to remove them\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Top-level usage (bin/traj:26-112)
// ---------------------------------------------------------------------------

const USAGE_BODY = `Usage: traj <command> [options]

Trajectory is identified by (in priority order):
  --traj_dir DIR <ID>           Directory + traj ID (UUID or hex prefix).
  $TRAJ_DIR + $TRAJ_ID          Env vars for directory + ID.

Commands:
  All commands accept [ID] as an optional positional argument (trajectory ID,
  UUID, or hex prefix). Falls back to $TRAJ_ID.

  new [--traj_dir DIR] [--slug TEXT] [--field key=val ...]
                            Create a new trajectory. Outputs two lines:
                            line 1 = UUID (traj ID), line 2 = relative dir path.
                            Extra --field values are written into the first step.

  append [ID] [--field key=val ...]
                            Append a step. Reads JSON from stdin, or builds from
                            --field flags (must include --field type=X).
                            Assigns UUID step_id, spills large fields to blobs.

  fork [ID] [--child CHILD_ID] [--slug TEXT]
                            Create a fork point: append a fork step to the
                            current trajectory. Auto-creates child trajectory
                            if --child not provided. Prints child traj ID.

  merge <child_traj_id> [ID] [--content TEXT]
                            Merge a child back: reads the last step of
                            <child>, appends a merge step to the current
                            trajectory. Prints merge step_id.

  show <id> [--full] [--field F]
                            Show a trajectory or step by ID. Searches all
                            .jsonl files in traj_dir. If the ID is a
                            trajectory's first step, shows traj metadata.
                            Otherwise shows the step JSON.

  tail [ID] [-n N] [-f] [--filter F] [-r] [--raw]
                            Show recent steps (formatted by default).
                            --filter field=val  Filter steps by field value.
                            Multiple --filter flags are AND'd, comma values OR'd.
                            -r/--recursive includes sub-trajectory steps.
                            --raw for JSONL output.

  search <pattern> [ID] [--field F] [-i] [-C N] [-E] [-r] [--tail N]
                            Search step fields. Default field: all.
                            -r, --recursive  Search sub-trajectories too.

  count [ID]                Print step count.

  last [ID] [--field KEY]   Print the last step as JSON. --field KEY extracts
                            a single field value.

  cat [ID] [--filter F] [-r] [--raw]
                            Output all steps as JSONL to stdout.
                            --filter field=val  Filter steps by field value.
                            -r/--recursive includes sub-trajectory steps.
                            --raw for JSONL output (default when piped).

  exists [ID]               Exit 0 if trajectory exists and has steps.

  path [ID]                 Print the resolved trajectory file path.

  list [ID] [--parents N|all] [--children N|all] [--steps] [--json]
                            List parents, self, and children as ASCII tree.
                            --steps expands each trajectory to show its steps.
                            Use --json for machine-readable output.


  root [ID]                 Walk up parent links to find root. Print filename.

  check [ID] [-r] [--fix]   Validate JSONL for malformed lines.
                            -r checks sub-trajectories too.
                            --fix removes bad lines in place.


`;

function printUsage(io: TrajIO): void {
  io.stdout(USAGE_BODY);
  if (io.env.TRAJ_DIR) io.stdout(`TRAJ_DIR=${io.env.TRAJ_DIR}\n`);
  if (io.env.TRAJ_ID) io.stdout(`TRAJ_ID=${io.env.TRAJ_ID}\n`);
  io.stdout("\n");
}

// ---------------------------------------------------------------------------
// Dispatch (bin/traj:2162-2186)
// ---------------------------------------------------------------------------

export function runTraj(argv: string[], io: TrajIO): number {
  if (argv.length === 0) {
    printUsage(io);
    return 1;
  }
  const cmd = argv[0]!;
  const rest = argv.slice(1);
  try {
    switch (cmd) {
      case "new":
        return cmdNew(io, rest);
      case "append":
        return cmdAppend(io, rest);
      case "fork":
        return cmdFork(io, rest);
      case "merge":
        return cmdMerge(io, rest);
      case "show":
        return cmdShow(io, rest);
      case "tail":
        return cmdTail(io, rest);
      case "search":
        return cmdSearch(io, rest);
      case "count":
        return cmdCount(io, rest);
      case "last":
        return cmdLast(io, rest);
      case "cat":
        return cmdCat(io, rest);
      case "exists":
        return cmdExists(io, rest);
      case "path":
        return cmdPath(io, rest);
      case "list":
        return cmdList(io, rest);
      case "root":
        return cmdRoot(io, rest);
      case "check":
        return cmdCheck(io, rest);
      case "help":
      case "-h":
      case "--help":
        printUsage(io);
        return 0;
      default:
        die(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof TrajExit) {
      if (e.dieMsg !== undefined) io.stderr(`traj: error: ${e.dieMsg}\n`);
      return e.code;
    }
    const msg = e instanceof Error ? e.message : String(e);
    io.stderr(`traj: error: ${msg}\n`);
    return 1;
  }
}

// exported for tests / other reuse
export {
  parseHexId,
  getSummary,
  resolveParentFile,
  collectRecursiveFiles,
  requireTrajFile,
  toEpoch,
  wcL,
  sanitizeSlug,
  grepContent,
  previewFor,
  finalizePreview,
  timeDisplay,
  matchesFilters,
  parseFilterFlags,
};
export type { Step };
