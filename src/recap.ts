// recap.ts — trajectory recap CLI (bin/recap). Faithful port of headlong/bin/recap.
//
// Map-reduce over a mind log: filter noise steps, chunk the rest into windows,
// LLM-summarize each window into an "episode", reduce episodes into themes +
// arc; plus the `--context` tiered-rollup staircase. Everything is cached under
// <traj-dir>/recap/ and <traj-dir>/rollups/ and refreshed incrementally.
//
// Two things are held exact, because other processes read them:
//   1. the ON-DISK CACHE — recap/episodes.jsonl (one compact JSON object per
//      line), recap/themes.json (pretty), recap/.lock (a directory),
//      rollups/rendered.tsv + rendered.meta.json, rollups/meta.json,
//      rollups/tK/<start12>-<end12>.json (compact + newline). The web dash reads
//      themes.json/episodes.jsonl and probes recap/.lock; the monolith folds the
//      staircase into its prompt.
//   2. the CLI CONTRACT — flags, stdout/stderr split, exit codes, the exact
//      `llm -m M -t N -s SYSTEM` argv + stdin, the fence-stripping 2-attempt
//      JSON wrapper, and the lock/refresh/tail rules.
//
// The Bash tool is jq + awk + sed glue, so the port carries small jq-semantics
// helpers (`//` skips null AND false; string interpolation of null is "null";
// `join` renders non-strings as JSON; a type error aborts the program). Where a
// jq abort would crash the Bash under `set -e` (exit 5, jq's own stderr text),
// the port dies `recap: error: <where>: <reason>` with exit 1 — PORT-NOTE below
// and a PARITY.md row each. Nothing is stubbed.
//
// Reuses the pure pieces of src/rollups.ts whose semantics match the Bash
// exactly (block math, staircase selection, budget→R, epoch minutes, prompt
// text). It does NOT reuse rollups.ts's renderStepText / renderSteps /
// buildRollups / recapContext, which differ from the Bash on: jq truthiness of
// empty-string `source`/`wake` (jq: truthy; TS: falsy), `//` on `false`-valued
// fields, @tsv escaping of backslashes in the rendered text (the Bash TSV and
// everything downstream — LLM input, raw tail — carries `\\`), the jq
// input_line_number quirk for an unterminated last line, block files written
// without a trailing newline, and a corrupt rollups/meta.json (Bash: start 0;
// rollups.ts: "no meta" → start n). See PARITY.md "recap vs rollups.ts".

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROLLUP_SYSTEM,
  ROLLUP_PROMPT_VERSION,
  RENDER_VERSION,
  epochMin,
  powFanout,
  blockPath,
  buildPlan,
  planStaircase,
  resolveSegments,
  resolveR,
  LIFE_HEADER,
  rawTailHeader,
} from "./rollups.ts";

export const RECAP_VERSION = "0.1.0";

/** KEEP_TYPES exactly as the Bash string (it is stored verbatim in rendered.meta.json). */
export const KEEP_TYPES_JSON =
  '["thought","action","observation","message","feedback","final","shellm-run","merge"]';
const KEEP_SET: ReadonlySet<string> = new Set(JSON.parse(KEEP_TYPES_JSON) as string[]);

/** ROLLUP_MAX_TOKENS: output cap for one rollup call; thinking tokens count against it (at 1024 Sonnet 5 was cut off mid-JSON on 42 of 166 rollups, 2026-10-12). */
const ROLLUP_MAX_TOKENS = 4096;

const MIN_GAP_WINDOW = 10; // never gap-cut a window smaller than this
const MIN_TAIL = 15; // don't summarize a trailing partial window smaller than this
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const LOCK_STALE_MS = 30 * 60 * 1000; // find -mmin +30

// PORT-NOTE (1c: f6f854c) — "v3: outcomes, not temperament": asks for
// outcomes/decisions/open-threads and forbids temperament words (see
// ROLLUP_SYSTEM in rollups.ts for the sibling first-person prompt).
export const WINDOW_SYSTEM =
  'You summarize one window of an AI agent\'s mind log. Lines look like "[step-id] type(source): content". Reply with ONLY a JSON object, no markdown fences:\n' +
  '{"title": "short episode title (<=8 words)",\n' +
  ' "summary": "2-4 sentences on outcomes: what the agent did, decided, learned, and left open, naming people, artifacts, and threads. Events, not character: no words for its habits or temperament (not disciplined, restrained, patient, waiting mode); if it idled, say once what it was waiting for",\n' +
  ' "themes": ["1-4 short kebab-case topics"],\n' +
  ' "notable_steps": [{"step": "8-char id from the window", "note": "why it matters (<=15 words)"}]}\n' +
  "Pick 3-6 notable steps. Use only step ids that literally appear in the window.";

export const REDUCE_SYSTEM =
  "You are given numbered episode summaries covering an AI agent's life log in chronological order. Reply with ONLY a JSON object, no markdown fences:\n" +
  '{"arc": "1-2 paragraphs narrating the overall arc: what this agent has been up to, how its focus evolved, where it stands now",\n' +
  ' "themes": [{"name": "short theme name",\n' +
  '             "description": "2-3 sentences on this thread of activity",\n' +
  '             "episodes": [episode numbers where it shows up],\n' +
  '             "key_steps": [{"step": "8-char id taken from the episodes\' notable steps", "note": "<=15 words"}]}]}\n' +
  "Give 3-8 themes, most prominent first. Use only step ids that appear in the input.";

export const USAGE = `recap — Summarize a trajectory into themes + episodes with step references

Usage:
  recap [ID] [options]              ID: traj UUID/hex prefix (default: $TRAJ_ID)

Options:
  --traj_dir DIR      Trajectories root (default: $TRAJ_DIR)
  --window N          Max filtered steps per episode window (default: 100)
  --gap-minutes N     Prefer window cuts at time gaps >= N minutes (default: 30;
                      0 disables gap-aware cutting)
  --context           Print a budget-bounded "staircase": tiered rollups
                      (coarse→fine) covering the whole trajectory, then the
                      recent steps verbatim. Builds rollups lazily but only
                      GOING FORWARD from first use (safe on a long log).
  --backfill          One-time: also summarize all pre-existing history, so the
                      staircase covers the whole past. Run manually/offline —
                      the first build on a long log is the expensive one.
  --budget N|auto     Token budget for --context (auto = fraction of model window)
  --raw-tail N        Verbatim recent steps to show under --context (default: auto)
  --fanout N          F: children per tier for --context rollups (default: 10)
  --cached            Print the existing recap; never call the LLM
  --rebuild           Drop the cache and re-summarize everything
  --json              Emit {"themes":..., "episodes":[...]} JSON
  --model MODEL       LLM for both stages (default: $RECAP_MODEL, $SHELLM_MODEL)
  --map-model MODEL   LLM for window summaries only ($RECAP_MAP_MODEL)
  --reduce-model MODEL  LLM for the theme reduction only ($RECAP_REDUCE_MODEL)
  -q, --quiet         No progress chatter on stderr
  -h, --help          Show this help

Windows close at the first of: a time gap of --gap-minutes (so episodes align
with the agent's natural sessions), --window steps, or ~60KB of text
($RECAP_MAX_WINDOW_BYTES).

Default behavior refreshes the cache incrementally (only new steps get
summarized), then prints. Cache lives in <traj-dir>/recap/.

Inside an identity shell, plain \`recap\` summarizes the identity's mind log.
Step references print as [8-char ids] that resolve in the web dash mind log.
`;

// ---------------------------------------------------------------------------
// Injectable IO — the shim wires process.*; tests inject a clock and an `llm`.
// ---------------------------------------------------------------------------

export interface LlmResult {
  /** Exit status of `llm` (non-zero ⇒ the reply is discarded, as `|| raw=""`). */
  status: number;
  /** Captured stdout of `llm`. */
  stdout: string;
  /**
   * Captured stderr of `llm` (sync 2e39a3f, c32d5b0): `_llm_json` captures it to
   * a file, copies it to its own stderr, and looks for `refused:` in it. When a
   * caller leaves this undefined its stderr was inherited and nothing can be
   * refused (the pre-2e39a3f shape).
   */
  stderr?: string;
}

export interface RecapIO {
  /** Working directory relative `--traj_dir`/ID paths resolve against. */
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Clock — the shim passes `() => new Date()`. */
  now(): Date;
  /** Spawn `llm` on PATH: `printf '%s' "$user" | llm -m M -t N -s SYSTEM`. */
  runLlm(args: string[], stdinText: string): LlmResult;
}

/** Thrown by `die` to unwind to the runRecap boundary with an exit code. */
class RecapExit extends Error {
  readonly code: number;
  readonly dieMsg: string | undefined;
  constructor(code: number, dieMsg?: string) {
    super(dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
  }
}

function die(msg: string): never {
  throw new RecapExit(1, msg);
}

/**
 * A jq type error where the Bash aborts (jq exit 5 + jq's own stderr line,
 * `set -e` ends the script). Thrown by the jq-semantics helpers; caught where
 * the Bash tolerates it (`2>/dev/null || true` / `|| fallback`), otherwise it
 * becomes `recap: error: <where>: <reason>`, exit 1 — a documented deviation.
 */
class JqAbort extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

// ---------------------------------------------------------------------------
// jq semantics helpers
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | RawNumber | Json[] | { [k: string]: Json };

/**
 * A JSON number that carries its original literal text (`"1.0"`,
 * `"99999999999999999999"`), produced only by parseJsonLossless(). jq keeps
 * a parsed number's literal text verbatim through any `--argjson`/`.`
 * pass-through untouched by arithmetic (jq's own decNumber representation);
 * `JSON.parse` + `JSON.stringify` normalize `1.0`→`1` and round any integer
 * past 2^53. Fix, not a deviation, for the one path this matters on: an LLM
 * reply's number literals re-serialized verbatim into episodes.jsonl/
 * themes.json (see llmJson(), readThemesValue()). Every jq-semantics helper
 * below treats a RawNumber as jqType "number".
 */
export class RawNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function jqType(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof RawNumber) return "number";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

function isObj(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/**
 * Extract the literal text of every JSON number token in `text`, in
 * left-to-right occurrence order, skipping over string contents (and their
 * `\"` escapes) so a number-shaped substring inside a string is never
 * mistaken for one. For valid JSON this is exactly the depth-first order a
 * structural walk of JSON.parse(text)'s result encounters its number leaves
 * in (V8 preserves source key order for non-array-index-like object keys).
 */
function extractNumberLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i;
      if (c === "-") i++;
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      if (text[i] === ".") {
        i++;
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
      if (text[i] === "e" || text[i] === "E") {
        i++;
        if (text[i] === "+" || (text[i] as string) === "-") i++;
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
      out.push(text.slice(start, i));
      continue;
    }
    i++;
  }
  return out;
}

function annotateNumbers(value: unknown, tokens: string[], idx: { i: number }): unknown {
  if (typeof value === "number") {
    const tok = tokens[idx.i++];
    return tok !== undefined ? new RawNumber(tok) : value;
  }
  if (Array.isArray(value)) return value.map((x) => annotateNumbers(x, tokens, idx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = annotateNumbers(v, tokens, idx);
    return out;
  }
  return value;
}

/** `JSON.parse`, but every number leaf carries its original literal text
 *  (RawNumber) instead of being rounded to an IEEE-754 double. Structure and
 *  validity (what throws) are identical to JSON.parse — only numbers differ. */
export function parseJsonLossless(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return annotateNumbers(value, extractNumberLiterals(text), { i: 0 });
}

/** jq `a // b`: null and false (and a missing key) fall through to b. */
function jqAlt<T>(v: unknown, d: T): Json | T {
  return v === null || v === undefined || v === false ? d : (v as Json);
}

/** jq truthiness (`if x then`): only null and false are false. */
function jqTruthy(v: unknown): boolean {
  return !(v === null || v === undefined || v === false);
}

/** `.key` on a value: objects index; null → null; anything else aborts. */
function jqIndex(v: unknown, key: string): Json {
  if (v === null || v === undefined) return null;
  if (isObj(v)) return v[key] ?? null;
  throw new JqAbort(`Cannot index ${jqType(v)} with "${key}"`);
}

/** JSON string literal exactly as JSON.stringify renders one, except DEL
 *  (0x7F) is escaped like jq escapes it (JSON.stringify leaves it raw). */
function jsonStringLit(s: string): string {
  return JSON.stringify(s).replace(//g, "\\u007f");
}

/** Recursive serializer used by jqCompact/jqPretty: identical to
 *  `JSON.stringify(v, null, indent)` for every value EXCEPT a RawNumber,
 *  which prints its original literal text verbatim (see RawNumber). `indent
 *  === null` is the compact form. */
function jsonStringify(v: unknown, indent: number | null, depth: number): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof RawNumber) return v.text;
  if (typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return jsonStringLit(v);
  const nl = indent === null ? "" : "\n";
  const pad = indent === null ? "" : " ".repeat(indent * (depth + 1));
  const padEnd = indent === null ? "" : " ".repeat(indent * depth);
  const sep = indent === null ? "," : ",\n";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((x) => jsonStringify(x, indent, depth + 1));
    return `[${nl}${items.map((s) => pad + s).join(sep)}${nl}${padEnd}]`;
  }
  const entries = Object.entries(v as object);
  if (entries.length === 0) return "{}";
  const items = entries.map(([k, val]) => `${jsonStringLit(k)}:${indent === null ? "" : " "}${jsonStringify(val, indent, depth + 1)}`);
  return `{${nl}${items.map((s) => pad + s).join(sep)}${nl}${padEnd}}`;
}

/** Compact JSON as jq -c prints it (DEL escaped as \u007f, like jq; a RawNumber's
 *  literal text is kept verbatim, like jq's own preserved number literals). */
export function jqCompact(v: unknown): string {
  return jsonStringify(v === undefined ? null : v, null, 0);
}

/** Pretty JSON as `jq -n` prints it (2-space indent) — no trailing newline. */
export function jqPretty(v: unknown): string {
  return jsonStringify(v === undefined ? null : v, 2, 0);
}

/** jq `tostring`: strings verbatim, everything else its compact JSON. */
function jqToString(v: unknown): string {
  return typeof v === "string" ? v : jqCompact(v);
}

/** `\(x)` string interpolation — same as tostring. */
const jqInterp = jqToString;

/** What `jq -r` prints for one value: strings raw, others pretty JSON. */
function jqRawPrint(v: unknown): string {
  return typeof v === "string" ? v : jqPretty(v);
}

/** `.[]` — arrays yield elements, objects yield values, else abort. */
function jqIterate(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  if (isObj(v)) return Object.values(v);
  throw new JqAbort(`Cannot iterate over ${jqType(v)}`);
}

/** `.[]?` — like jqIterate but a non-iterable yields nothing. */
function jqIterateOpt(v: unknown): Json[] {
  try {
    return jqIterate(v);
  } catch (e) {
    if (e instanceof JqAbort) return [];
    throw e;
  }
}

/** jq `join($sep)`: null → "", strings verbatim, other scalars/containers as JSON. */
function jqJoin(v: unknown, sep: string): string {
  return jqIterate(v)
    .map((x) => (x === null ? "" : typeof x === "string" ? x : jqCompact(x)))
    .join(sep);
}

/** jq `length`. */
function jqLength(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") throw new JqAbort(`boolean (${v}) has no length`);
  if (v instanceof RawNumber) return Math.abs(Number(v.text));
  if (typeof v === "number") return Math.abs(v);
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  return Object.keys(v as object).length;
}

/** `str + x`: null is the identity, strings concatenate, anything else aborts. */
function jqStrAdd(s: string, x: unknown): string {
  if (x === null || x === undefined) return s;
  if (typeof x === "string") return s + x;
  throw new JqAbort(`string ("${s}") and ${jqType(x)} cannot be added`);
}

/** `to_entries[]` over `.themes`: arrays give numeric keys, objects string keys. */
function jqToEntries(v: unknown): { key: number | string; value: Json }[] {
  if (Array.isArray(v)) return (v as Json[]).map((value, key) => ({ key, value }));
  if (isObj(v)) return Object.entries(v).map(([key, value]) => ({ key, value }));
  throw new JqAbort(`${jqType(v)} has no keys`);
}

function jqFatal(where: string, e: unknown): never {
  const reason = e instanceof Error ? e.message : String(e);
  die(`${where}: ${reason}`);
}

// ---------------------------------------------------------------------------
// bash / awk number semantics
// ---------------------------------------------------------------------------

/**
 * `[[ $s =~ ^[0-9]+$ ]]` plus bash's arithmetic reading of the digits: a
 * leading 0 means octal. "octal-error" = `08`/`09` (bash: "value too great for
 * base", the test fails); null = not all digits.
 */
export function bashDigits(s: string): number | "octal-error" | null {
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.length > 1 && s[0] === "0") {
    if (/[89]/.test(s)) return "octal-error";
    return parseInt(s, 8);
  }
  return Number(s);
}

/** Thrown by bashArith() for a bare-identifier-shaped value: under this
 *  script's `set -euo pipefail`, bash's `(( ))` re-dereferences an
 *  identifier as a VARIABLE NAME, and an unset one is a `nounset` abort —
 *  `<name>: unbound variable`, exit 1, script terminates immediately. Fix,
 *  not a deviation: this used to be swallowed as "unset variable → 0",
 *  which let a misconfigured env value (e.g. RECAP_CONTEXT_BUDGET_MAX=
 *  notanumber) silently compute 0 and produce a plausible-looking wrong
 *  answer where Bash hard-fails. Every current bashArith() call site is
 *  arithmetic on an env-derived value under this script's `set -u`, so each
 *  one re-raises this as its own die() — exact stderr wording differs (Bash
 *  embeds its own script path + line number); see PARITY.md. */
export class BashUnboundVar extends Error {
  readonly varName: string;
  constructor(varName: string) {
    super(`${varName}: unbound variable`);
    this.varName = varName;
  }
}

/** `$(( s ))` of an env value: digits (octal/hex rules); a bare identifier
 *  throws BashUnboundVar (bash's nounset); or a syntax error (null). */
export function bashArith(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return 0;
  const d = bashDigits(s);
  if (d === "octal-error") return null;
  if (d !== null) return d;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new BashUnboundVar(s);
  return null;
}

/** Runs `fn` (which calls bashArith()), converting a BashUnboundVar into the
 *  die() this call site's `set -u` context would hit in real Bash. Reused at
 *  every bashArith() call site. */
function arithOrUnbound<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BashUnboundVar) die(`${e.varName}: unbound variable`);
    throw e;
  }
}

/** awk "looks numeric" (strnum) test: decimal/exponent/hex via strtod, whole string. */
function awkIsNumeric(s: string): boolean {
  return (
    /^[ \t\n]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n]*$/.test(s) ||
    /^[ \t\n]*[+-]?0[xX][0-9a-fA-F]+[ \t\n]*$/.test(s)
  );
}

/** awk string→number coercion (`$1 + 0`): the longest numeric prefix, else 0. */
function awkToNumber(s: string): number {
  const m =
    /^[ \t\n]*([+-]?0[xX][0-9a-fA-F]+)/.exec(s) ??
    /^[ \t\n]*([+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** awk `num >= v` where v came from `-v v="$STR"`: numeric if v is a strnum,
 *  otherwise a bytewise string comparison against the number's text. */
function awkNumGeVar(num: number, v: string): boolean {
  if (awkIsNumeric(v)) return num >= Number(v);
  return Buffer.compare(Buffer.from(String(num)), Buffer.from(v)) >= 0;
}

/** awk `v > 0` for a `-v` variable (string compare against "0" when not numeric). */
function awkVarGtZero(v: string): boolean {
  if (awkIsNumeric(v)) return Number(v) > 0;
  return Buffer.compare(Buffer.from(v), Buffer.from("0")) > 0;
}

// ---------------------------------------------------------------------------
// Small fs / string helpers
// ---------------------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `[[ -s f ]]`: exists with size > 0. */
function nonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Strip trailing newlines exactly as `$(...)` command substitution does. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/** `wc -l`: the number of newline characters. */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Split into the lines `sed`/`tail`/`head` see: an unterminated last line is a line. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  const parts = content.split("\n");
  if (content.endsWith("\n")) parts.pop();
  return parts;
}

/** `tail -1`: the last line (unterminated-aware); "" for an empty file. */
function lastLine(content: string): string {
  const lines = splitLines(content);
  return lines.length ? lines[lines.length - 1]! : "";
}

/** `cut -fN`: a line without a tab prints whole; a short line prints "". */
function cutField(line: string, n: number): string {
  if (!line.includes("\t")) return line;
  return line.split("\t")[n - 1] ?? "";
}

/** Code-point slice (`.[a:b]` on a jq string, `cut -c`). */
function cpSlice(s: string, start: number, end?: number): string {
  return [...s].slice(start, end).join("");
}

/** `date +%Y-%m-%dT%H:%M:%S` in local time. */
export function stampLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** @tsv field escaping. jq's `@tsv` also escapes an embedded NUL as the
 *  literal two-character text `\0` (confirmed: `jq -r '[.a]|@tsv'` on
 *  `{"a":"x y"}` prints `x\0y`, never a raw NUL byte) — fix, not a
 *  deviation: this port previously passed the raw 0x00 byte straight through
 *  into the `llm` subprocess's stdin. */
export function tsvEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0");
}

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

interface Opts {
  trajDir: string;
  trajIdArg: string;
  window: string;
  gapMinutes: string;
  maxWindowBytes: string;
  mode: "auto" | "cached" | "rebuild";
  output: "text" | "json";
  quiet: boolean;
  mapModel: string;
  reduceModel: string;
  context: boolean;
  backfill: boolean;
  fanout: string;
  ctxBudget: string;
  ctxRawTail: string;
}

interface Ctx {
  io: RecapIO;
  opts: Opts;
  runDir: string;
  jsonl: string;
  cache: string;
  episodes: string;
  themes: string;
  lock: string;
  rollupDir: string;
  rollupLock: string;
  rollupMeta: string;
  renderedTsv: string;
  renderMeta: string;
  /** FANOUT as bash arithmetic reads it. */
  fanout: number;
  /** ROLLUP_MAX_SEALS: blocks one --context call may seal (0 = no cap). */
  maxSeals: number;
  /** `_CTX_SEALED`: blocks sealed so far by this call. */
  sealed: number;
}

function note(ctx: Ctx, msg: string): void {
  if (!ctx.opts.quiet) ctx.io.stderr(`recap: ${msg}\n`);
}

// PORT-NOTE (deliberate deviation): Bash reads a flag's value with `${2:?msg}`,
// whose missing/empty-value error is `<script abs path>: line 103: 2: <msg>` on
// stderr (exit 1). That embeds the script's absolute path + a Bash line number;
// the port prints `recap: error: <msg>` — same exit code, stdout and state.
// Covers --traj_dir, --window, --budget, --raw-tail, --fanout, --gap-minutes,
// --model, --map-model, --reduce-model (and their empty-string forms; `${2:?}`
// fires on empty too). See PARITY.md.
function required(v: string | undefined, msg: string): string {
  if (v === undefined || v === "") die(msg);
  return v;
}

// ---------------------------------------------------------------------------
// Trajectory resolution — `find "$TRAJ_DIR" -maxdepth 4 -type d -name "${prefix}*" | head -1`
// ---------------------------------------------------------------------------

/** fnmatch(3) pattern → RegExp (`*`, `?`, `[...]`, `\` escapes; `*` matches a leading dot). */
export function fnmatchToRegex(pat: string): RegExp {
  let re = "^";
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      let neg = false;
      if (pat[j] === "!" || pat[j] === "^") {
        neg = true;
        j++;
      }
      let body = "";
      if (pat[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pat.length && pat[j] !== "]") {
        const d = pat[j]!;
        body += d === "\\" || d === "]" || d === "^" ? "\\" + d : d;
        j++;
      }
      if (j >= pat.length) re += "\\["; // no closing bracket: literal
      else {
        re += "[" + (neg ? "^" : "") + body + "]";
        i = j;
      }
    } else if (c === "\\" && i + 1 < pat.length) {
      i++;
      re += esc(pat[i]!);
    } else re += esc(c);
  }
  return new RegExp(re + "$", "s");
}

/**
 * The first directory `find ROOT -maxdepth 4 -type d -name PAT` prints. This
 * platform's find walks breadth-first in raw readdir order (root, then every
 * depth-1 dir, then depth-2 in parent order, …); unreadable dirs are skipped
 * (`2>/dev/null`), symlinks are not `-type d`. Returns the absolute path.
 * PORT-NOTE: the tie-break among several prefix matches is find-order
 * dependent (GNU find walks depth-first); only ambiguous prefixes differ.
 */
export function findFirstDir(rootAbs: string, rootNameAsGiven: string, pattern: RegExp, maxDepth = 4): string | null {
  if (pattern.test(rootNameAsGiven)) return rootAbs;
  const queue: { p: string; depth: number }[] = [{ p: rootAbs, depth: 0 }];
  while (queue.length > 0) {
    const { p, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(p);
    } catch {
      continue;
    }
    try {
      let ent: fs.Dirent | null;
      while ((ent = dir.readSync()) !== null) {
        if (!ent.isDirectory()) continue;
        const full = path.join(p, ent.name);
        if (pattern.test(ent.name)) return full;
        queue.push({ p: full, depth: depth + 1 });
      }
    } finally {
      dir.closeSync();
    }
  }
  return null;
}

function resolveTrajDir(io: RecapIO, opts: Opts): string {
  const id = opts.trajIdArg || io.env["TRAJ_ID"] || "";
  if (!opts.trajDir) die("no trajectory: set TRAJ_DIR (+ TRAJ_ID) or pass --traj_dir DIR <ID>");
  const trajAbs = path.resolve(io.cwd, opts.trajDir);
  if (!isDir(trajAbs)) die(`not a directory: ${opts.trajDir}`);
  if (!id) die("no trajectory ID: pass one or set TRAJ_ID");

  // Accept a full dir path, a UUID, or a hex prefix.
  if (isFile(path.resolve(io.cwd, id, "trajectory.jsonl"))) return path.resolve(io.cwd, id);
  const prefix = id.split("-")[0] ?? ""; // ${id%%-*}
  const match = findFirstDir(trajAbs, path.basename(opts.trajDir), fnmatchToRegex(prefix + "*"));
  if (!match || !isFile(path.join(match, "trajectory.jsonl"))) {
    die(`no trajectory matching: ${id} (under ${opts.trajDir})`);
  }
  return match;
}

// ---------------------------------------------------------------------------
// Rendering: trajectory lines -> TSV rows (raw_line, step_id, ts, text, epoch_min)
// ---------------------------------------------------------------------------

export interface TsvRow {
  /** Field 1: raw jsonl line number (jq input_line_number + offset). */
  rawLine: number;
  /** Field 2: @tsv-escaped 8-char step id. */
  stepId: string;
  /** Field 3: @tsv-escaped first 16 chars of ts. */
  ts: string;
  /** Field 4: @tsv-escaped display text (what the LLM and the raw tail see). */
  text: string;
  /** Field 5: UTC epoch minutes, or "". */
  epochMin: string;
}

function squashWs(s: string): string {
  return s.replace(/[\t\n\r]+/g, " ");
}

/**
 * The jq row program (recap:208-242) for one parsed line. null = filtered out.
 * Throws JqAbort where the jq program would (a non-string truthy `source`).
 */
export function renderStep(v: unknown): TsvRow | null {
  if (!isObj(v)) return null; // select(type == "object")
  const type = v["type"];
  if (typeof type !== "string" || !KEEP_SET.has(type)) return null;
  if (v["source"] === "seed") return null;

  const id8 = cpSlice(jqToString(jqAlt(v["step_id"], "?")), 0, 8);
  const ts16 = cpSlice(jqToString(jqAlt(v["ts"], "")), 0, 16);

  let text = "[" + id8 + "] " + type;
  if (jqTruthy(v["source"])) text = jqStrAdd(text + "(", v["source"]) + ")";
  else if (jqTruthy(v["launched_by"])) text += "(" + jqToString(v["launched_by"]) + ")";
  if (jqTruthy(v["from"])) text += " " + jqToString(v["from"]) + "→" + jqToString(jqAlt(v["to"], "?"));
  text += ": ";
  if (type === "shellm-run") {
    // The launcher argv is ~500 chars of identical flags on every wakeup; keep
    // wake + model, plus the cmd tail only for a self-started run.
    if (jqTruthy(v["wake"])) text += "wake " + jqToString(v["wake"]) + ", ";
    text += "model " + jqToString(jqAlt(v["model"], "?"));
    if (jqAlt(v["launched_by"], "") === "" && jqAlt(v["command"], "") !== "") {
      text += ", cmd " + cpSlice(squashWs(jqToString(v["command"])), -200);
    }
  } else {
    const raw = jqAlt(v["content"], jqAlt(v["command"], jqAlt(v["tldr"], "")));
    text += cpSlice(squashWs(jqToString(raw)), 0, 500);
  }

  return {
    rawLine: 0,
    stepId: tsvEscape(id8),
    ts: tsvEscape(ts16),
    text: tsvEscape(text),
    epochMin: epochMin(jqToString(jqAlt(v["ts"], ""))),
  };
}

/**
 * `_render_steps FROM [LIMIT]`: `tail -n +FROM | head -n LIMIT | jq …`. Blank
 * lines carry no value; jq's input_line_number is the count of NEWLINES fed so
 * far, so a value on an unterminated last line reports the previous line's
 * number (replicated). jq aborts at the first unparseable line or row-program
 * type error, keeping the rows before it (`2>/dev/null || true`).
 */
export function renderRange(jsonl: string, fromLine: number, limit?: number): TsvRow[] {
  const all = splitLines(jsonl);
  const terminated = jsonl.endsWith("\n");
  const from = Math.max(1, fromLine);
  let lines = all.slice(from - 1);
  let lastIsUnterminated = !terminated && all.length > 0 && lines.length > 0;
  if (limit !== undefined) {
    if (lines.length > limit) {
      lines = lines.slice(0, limit);
      lastIsUnterminated = false;
    }
  }
  const out: TsvRow[] = [];
  let newlines = from - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    if (!(isLast && lastIsUnterminated)) newlines++;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      break; // jq parse error: rows so far survive, the rest is lost
    }
    let row: TsvRow | null;
    try {
      row = renderStep(parsed);
    } catch (e) {
      if (e instanceof JqAbort) break;
      throw e;
    }
    if (row) {
      row.rawLine = newlines;
      out.push(row);
    }
  }
  return out;
}

export function rowToTsv(r: TsvRow): string {
  return `${r.rawLine}\t${r.stepId}\t${r.ts}\t${r.text}\t${r.epochMin}`;
}

// ---------------------------------------------------------------------------
// Window ranges over TSV lines (recap:250-270 awk)
// ---------------------------------------------------------------------------

export interface WindowRange {
  start: number; // 1-based TSV line
  end: number; // inclusive
  reason: "gap" | "size" | "eof";
}

export function windowRanges(
  tsvLines: string[],
  opts: { maxSteps: number; gapMin: string; minGap: number; maxBytes: string }
): WindowRange[] {
  const out: WindowRange[] = [];
  let n = 0;
  let bytes = 0;
  let start = 0;
  let prevTs = "";
  const gapOn = awkVarGtZero(opts.gapMin);
  for (let i = 0; i < tsvLines.length; i++) {
    const nr = i + 1;
    const line = tsvLines[i]!;
    const f5 = cutField(line, 5);
    if (gapOn && n >= opts.minGap && f5 !== "" && prevTs !== "" && awkNumGeVar(awkToNumber(f5) - awkToNumber(prevTs), opts.gapMin)) {
      out.push({ start, end: nr - 1, reason: "gap" });
      n = 0;
      bytes = 0;
    }
    if (n === 0) start = nr;
    n++;
    bytes += Buffer.byteLength(line);
    if (f5 !== "") prevTs = f5;
    if (n >= opts.maxSteps || awkNumGeVar(bytes, opts.maxBytes)) {
      out.push({ start, end: nr, reason: "size" });
      n = 0;
      bytes = 0;
    }
  }
  if (n > 0) out.push({ start, end: tsvLines.length, reason: "eof" });
  return out;
}

// ---------------------------------------------------------------------------
// LLM calls — `_llm_json`: 2 attempts, fence lines stripped, `jq -e .` validation
// ---------------------------------------------------------------------------

/**
 * PORT-NOTE (fix): a reply of SEVERAL JSON values (`{…}\n{…}`). Upstream's `jq -e .` accepts it (the last value
 * decides the exit status), so `_llm_json` returns the whole text; the next `jq --argjson body "$body"` then rejects
 * it with jq's usage banner and exit 2, after its output redirect has already created the target file (an empty
 * episodes.jsonl, themes.json.tmp, or sealed-block file). argjsonSeqAbort reproduces exactly that end state.
 */
export class JsonSeq {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
const JQ_ARGJSON_BANNER =
  "jq: invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n";
function argjsonSeqAbort(ctx: Ctx, redirectTarget: string): never {
  fs.mkdirSync(path.dirname(redirectTarget), { recursive: true });
  fs.appendFileSync(redirectTarget, ""); // the shell opens `>`/`>>` before jq runs
  ctx.io.stderr(JQ_ARGJSON_BANNER);
  throw new RecapExit(2);
}

/** Split a text into top-level JSON value texts (jq's input stream); null = not a clean sequence. */
export function splitJsonSeq(t: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = t.length;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    while (i < n && ws(t[i]!)) i++;
    if (i >= n) break;
    const start = i;
    const c = t[i]!;
    if (c === "{" || c === "[") {
      let depth = 0;
      let inStr = false;
      for (; i < n; i++) {
        const ch = t[i]!;
        if (inStr) {
          if (ch === "\\") i++;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else if (c === '"') {
      for (i++; i < n; i++) {
        if (t[i] === "\\") i++;
        else if (t[i] === '"') {
          i++;
          break;
        }
      }
    } else {
      while (i < n && !ws(t[i]!) && !"{}[]\"".includes(t[i]!)) i++;
      if (i === start) i++;
    }
    out.push(t.slice(start, i));
  }
  return out;
}

function llmJson(ctx: Ctx, model: string, system: string, user: string, maxTokens = "2048"): Json | JsonSeq | undefined {
  const r = llmJsonRc(ctx, model, system, user, maxTokens);
  return r.rc === 0 ? r.value : undefined;
}

/**
 * The parse half of `_llm_json`: drop ``` fence lines, then `jq -e .` the rest.
 * undefined = no valid JSON (a parse error, or null/false, which `jq -e` fails).
 */
export function parseLlmJson(stdout: string): Json | JsonSeq | undefined {
  const raw = stripTrailingNewlines(stdout);
  const cleaned = stripTrailingNewlines(
    raw
      .split("\n")
      .filter((l) => !l.startsWith("```"))
      .join("\n")
  );
  try {
    // parseJsonLossless, not JSON.parse: number literals in the reply
    // (episode/theme fields the port writes straight back into the cache)
    // must survive byte-for-byte, as they do through jq's own decNumber
    // representation — see RawNumber.
    const value = parseJsonLossless(cleaned);
    return value !== null && value !== false ? (value as Json) : undefined; // `jq -e .`: null/false ⇒ exit 1
  } catch {
    // Not ONE value: `jq -e .` still succeeds on a stream of values whose LAST one is truthy.
    const parts = splitJsonSeq(cleaned);
    if (parts.length < 2) return undefined;
    let last: unknown;
    try {
      for (const p of parts) last = parseJsonLossless(p);
    } catch {
      return undefined;
    }
    return last !== null && last !== false ? new JsonSeq(cleaned) : undefined;
  }
}

/**
 * `_llm_json` with its return code: 0 = a valid JSON reply, 1 = no valid JSON
 * after two attempts, 2 = the model REFUSED the input (a content filter, decided
 * by the text, so a retry gets the same answer — c32d5b0).
 */
function llmJsonRc(
  ctx: Ctx,
  model: string,
  system: string,
  user: string,
  maxTokens = "2048"
): { rc: 0; value: Json | JsonSeq } | { rc: 1 | 2; value?: undefined } {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = ctx.io.runLlm(["-m", model, "-t", maxTokens, "-s", system], user);
    if (res.stderr !== undefined) {
      if (res.stderr !== "") ctx.io.stderr(res.stderr); // cat "$errf" >&2
      if (res.stderr.includes("refused:")) return { rc: 2 };
    }
    const value = parseLlmJson(res.status === 0 ? res.stdout : "");
    if (value !== undefined) return { rc: 0, value };
    note(ctx, `model returned invalid JSON (attempt ${attempt}), retrying`);
  }
  return { rc: 1 };
}

/** `$body.title` etc.: the reply must be an object (jq aborts on `.title` of an
 *  array/number/string — PORT-NOTE: exit 1 + clean message instead of jq's 5). */
export function bodyObj(body: Json, where: string): { [k: string]: Json } {
  if (isObj(body)) return body;
  return jqFatal(where, new JqAbort(`Cannot index ${jqType(body)} with "title" (model reply is not a JSON object)`));
}

// ---------------------------------------------------------------------------
// Map: window -> episode; Reduce: episodes -> themes
// ---------------------------------------------------------------------------

function argjsonInt(s: string, where: string): number {
  if (!/^-?[0-9]+$/.test(s)) jqFatal(where, new JqAbort(`Invalid JSON text passed to --argjson: ${s}`));
  return Number(s);
}

function summarizeWindow(ctx: Ctx, rows: string[], idx: number, partial: boolean): void {
  if (rows.length === 0) return;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const firstLine = cutField(first, 1);
  const lastLineNo = cutField(last, 1);
  const firstStep = cutField(first, 2);
  const lastStep = cutField(last, 2);
  const firstTs = cutField(first, 3);
  const lastTs = cutField(last, 3);
  const n = rows.length;
  const windowText = stripTrailingNewlines(rows.map((r) => cutField(r, 4)).join("\n"));

  note(ctx, `summarizing episode ${idx} (${n} steps, ${firstTs} → ${lastTs})`);
  const reply = llmJson(ctx, ctx.opts.mapModel, WINDOW_SYSTEM, windowText);
  if (reply === undefined) die(`episode ${idx}: model did not produce valid JSON`);
  if (reply instanceof JsonSeq) argjsonSeqAbort(ctx, ctx.episodes); // jq … --argjson body … >> "$EPISODES"
  const body = bodyObj(reply, `episode ${idx}`);

  const ep = {
    idx,
    raw_start_line: argjsonInt(firstLine, `episode ${idx}`),
    raw_end_line: argjsonInt(lastLineNo, `episode ${idx}`),
    first_step: firstStep,
    last_step: lastStep,
    first_ts: firstTs,
    last_ts: lastTs,
    n_steps: n,
    partial,
    model: ctx.opts.mapModel,
    created: stampLocal(ctx.io.now()),
    title: jqAlt(body["title"], "untitled"),
    summary: jqAlt(body["summary"], ""),
    themes: jqAlt(body["themes"], []),
    notable_steps: jqAlt(body["notable_steps"], []),
  };
  fs.appendFileSync(ctx.episodes, jqCompact(ep) + "\n");
}

/** Parse every JSON value of a one-per-line file (`jq … FILE`). `stopOnError`
 *  keeps the values before a bad line; otherwise the bad line aborts. */
function parseJsonLines(content: string, where: string, stopOnError: boolean): Json[] {
  const out: Json[] = [];
  for (const line of splitLines(content)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Json);
    } catch (e) {
      if (stopOnError) break;
      jqFatal(where, new JqAbort(`parse error: ${(e as Error).message}`));
    }
  }
  return out;
}

function notableList(v: unknown, where: string): string {
  try {
    return jqIterateOpt(v)
      .map((s) => `[${jqInterp(jqIndex(s, "step"))}] ${jqInterp(jqIndex(s, "note"))}`)
      .join("; ");
  } catch (e) {
    if (e instanceof JqAbort) jqFatal(where, e);
    throw e;
  }
}

function reduceThemes(ctx: Ctx): void {
  const content = readOrEmpty(ctx.episodes);
  const nEpisodes = countNewlines(content); // wc -l
  if (!(nEpisodes > 0)) return;

  const where = "episodes.jsonl";
  const blocks: string[] = [];
  for (const ep of parseJsonLines(content, where, false)) {
    try {
      blocks.push(
        `EPISODE ${jqInterp(jqIndex(ep, "idx"))} [${jqInterp(jqIndex(ep, "first_ts"))} → ${jqInterp(jqIndex(ep, "last_ts"))}] ${jqInterp(jqIndex(ep, "title"))}\n` +
          `  ${jqInterp(jqIndex(ep, "summary"))}\n` +
          `  themes: ${jqJoin(jqIndex(ep, "themes"), ", ")}\n` +
          `  notable: ` +
          notableList(jqIndex(ep, "notable_steps"), where)
      );
    } catch (e) {
      if (e instanceof JqAbort) jqFatal(where, e);
      throw e;
    }
  }
  const episodeText = stripTrailingNewlines(blocks.join("\n"));

  note(ctx, `reducing ${nEpisodes} episodes into themes`);
  const reply = llmJson(ctx, ctx.opts.reduceModel, REDUCE_SYSTEM, episodeText, "8192");
  if (reply === undefined) die("theme reduction: model did not produce valid JSON");
  const seq = reply instanceof JsonSeq;
  const body = reply instanceof JsonSeq ? {} : bodyObj(reply, "theme reduction");

  const last = lastLine(content);
  let lastEnd: Json = null;
  if (last.trim() !== "") {
    let obj: unknown;
    try {
      obj = JSON.parse(last);
    } catch (e) {
      jqFatal(where, new JqAbort(`parse error: ${(e as Error).message}`));
    }
    try {
      lastEnd = jqIndex(obj, "raw_end_line");
    } catch (e) {
      if (e instanceof JqAbort) jqFatal(where, e);
      throw e;
    }
  }
  const totalLines = countNewlines(readOrEmpty(ctx.jsonl));
  if (seq) argjsonSeqAbort(ctx, ctx.themes + ".tmp"); // jq -n --argjson body … > "$THEMES.tmp"
  const themes = {
    generated_at: stampLocal(ctx.io.now()),
    model: ctx.opts.reduceModel,
    episodes: nEpisodes,
    raw_end_line: lastEnd,
    total_lines: totalLines,
    arc: jqAlt(body["arc"], ""),
    themes: jqAlt(body["themes"], []),
  };
  fs.writeFileSync(ctx.themes + ".tmp", jqPretty(themes) + "\n");
  fs.renameSync(ctx.themes + ".tmp", ctx.themes);
}

// ---------------------------------------------------------------------------
// Locks (a directory; stale after 30 min)
// ---------------------------------------------------------------------------

function acquireLock(ctx: Ctx, lock: string, msg: string): void {
  if (isDir(lock)) {
    let stale = false;
    try {
      stale = ctx.io.now().getTime() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      /* vanished */
    }
    if (stale) {
      try {
        fs.rmdirSync(lock);
      } catch {
        /* non-empty or gone: mkdir below decides */
      }
    }
  }
  try {
    fs.mkdirSync(lock);
  } catch {
    die(msg);
  }
}

function releaseLock(lock: string): void {
  try {
    fs.rmdirSync(lock);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Refresh: summarize whatever the cache doesn't cover yet
// ---------------------------------------------------------------------------

function refresh(ctx: Ctx): void {
  fs.mkdirSync(ctx.cache, { recursive: true });
  acquireLock(ctx, ctx.lock, `another recap is in progress (remove ${ctx.lock} if that's wrong)`);
  try {
    let fromLine = 1;
    let nextIdx = 1;
    if (nonEmpty(ctx.episodes)) {
      // Resume after the last complete episode; a trailing partial episode is
      // dropped and re-summarized now that more steps may exist.
      const content = fs.readFileSync(ctx.episodes, "utf8");
      const last = lastLine(content);
      let obj: unknown = undefined;
      if (last.trim() !== "") {
        try {
          obj = JSON.parse(last);
        } catch (e) {
          jqFatal("episodes.jsonl", new JqAbort(`parse error: ${(e as Error).message}`));
        }
      }
      const field = (k: string): string => {
        try {
          const v = jqIndex(obj, k);
          return obj === undefined ? "" : jqRawPrint(v);
        } catch (e) {
          if (e instanceof JqAbort) jqFatal("episodes.jsonl", e);
          throw e;
        }
      };
      const arith = (s: string): number =>
        arithOrUnbound(() => {
          const v = bashArith(s);
          if (v === null) die(`episodes.jsonl: arithmetic syntax error in "${s}"`);
          return v;
        });
      if (field("partial") === "true") {
        const fl = field("raw_start_line");
        fromLine = /^[0-9]+$/.test(fl) ? Number(fl) : Number.NaN; // tail -n +N (decimal); junk → no rows
        nextIdx = arith(field("idx"));
        const lines = splitLines(content);
        lines.pop(); // sed '$d'
        fs.writeFileSync(ctx.episodes, lines.length ? lines.join("\n") + "\n" : "");
      } else {
        fromLine = arith(field("raw_end_line")) + 1;
        nextIdx = arith(field("idx")) + 1;
      }
    }

    const rows = Number.isNaN(fromLine) ? [] : renderRange(readOrEmpty(ctx.jsonl), fromLine);
    const tsv = rows.map(rowToTsv);
    let newEpisodes = 0;
    if (tsv.length === 0) {
      note(ctx, "no new steps since last recap");
    } else {
      const ranges = windowRanges(tsv, {
        maxSteps: Number(ctx.opts.window),
        gapMin: ctx.opts.gapMinutes,
        minGap: MIN_GAP_WINDOW,
        maxBytes: ctx.opts.maxWindowBytes,
      });
      for (const r of ranges) {
        const size = r.end - r.start + 1;
        let partial = false;
        if (r.reason === "eof") {
          // Skip a tiny tail entirely — it'll fold into the next refresh.
          if (size < MIN_TAIL && nonEmpty(ctx.episodes)) {
            note(ctx, `leaving ${size}-step tail for the next refresh`);
            break;
          }
          partial = true;
        }
        summarizeWindow(ctx, tsv.slice(r.start - 1, r.end), nextIdx, partial);
        nextIdx += 1;
        newEpisodes += 1;
      }
    }

    if (newEpisodes > 0 || !nonEmpty(ctx.themes)) reduceThemes(ctx);
  } finally {
    releaseLock(ctx.lock);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function readThemesValue(ctx: Ctx): Json {
  const content = fs.readFileSync(ctx.themes, "utf8");
  if (content.trim() === "") return null; // --slurpfile of whitespace → [] → [0] = null
  try {
    // parseJsonLossless, not JSON.parse: themes.json's LLM-authored
    // `themes[].episodes` numbers must print back with their original
    // literal text (see RawNumber / llmJson()); every OTHER number in this
    // file is framework-written and always round-trips identically either
    // way (its literal text already equals JSON.stringify's own output).
    return parseJsonLossless(content) as Json;
  } catch (e) {
    return jqFatal("themes.json", new JqAbort(`parse error: ${(e as Error).message}`));
  }
}

function printText(ctx: Ctx): void {
  if (!nonEmpty(ctx.themes)) die("no recap yet — run without --cached to generate one");
  const t = readThemesValue(ctx);
  const out = ctx.io.stdout;
  try {
    out(
      `◆ recap — ${jqInterp(jqIndex(t, "episodes"))} episodes over ${jqInterp(jqIndex(t, "total_lines"))} steps · generated ${jqInterp(jqIndex(t, "generated_at"))} · ${jqInterp(jqIndex(t, "model"))}\n\n`
    );
    out(jqRawPrint(jqIndex(t, "arc")) + "\n");
    out("\nTHEMES\n");
    for (const { key, value } of jqToEntries(jqIndex(t, "themes"))) {
      if (typeof key !== "number") throw new JqAbort("string and number cannot be added");
      const steps = jqIterateOpt(jqIndex(value, "key_steps"))
        .map((s) => `[${jqInterp(jqIndex(s, "step"))}] ${jqInterp(jqIndex(s, "note"))}`)
        .join("; ");
      const eps = jqIterate(jqIndex(value, "episodes")).map(jqToString);
      out(
        `${key + 1}. ${jqInterp(jqIndex(value, "name"))} — ${jqInterp(jqIndex(value, "description"))}` +
          `\n     steps: ${steps}  (episodes ${jqJoin(eps, ",")})\n`
      );
    }
  } catch (e) {
    if (e instanceof JqAbort) jqFatal("themes.json", e);
    throw e;
  }
  out("\nEPISODES\n");
  if (!isFile(ctx.episodes)) jqFatal("episodes.jsonl", new JqAbort(`Could not open ${ctx.episodes}`));
  const content = fs.readFileSync(ctx.episodes, "utf8");
  for (const line of splitLines(content)) {
    if (line.trim() === "") continue;
    let ep: unknown;
    try {
      ep = JSON.parse(line);
    } catch (e) {
      jqFatal("episodes.jsonl", new JqAbort(`parse error: ${(e as Error).message}`));
    }
    try {
      out(
        `${jqInterp(jqIndex(ep, "idx"))}. ${jqInterp(jqIndex(ep, "first_ts"))} → ${jqInterp(jqIndex(ep, "last_ts"))}  ${jqInterp(jqIndex(ep, "title"))}${jqTruthy(jqIndex(ep, "partial")) ? " (partial)" : ""}` +
          `\n     ${jqInterp(jqIndex(ep, "summary"))}` +
          `\n     ${notableList(jqIndex(ep, "notable_steps"), "episodes.jsonl")}\n`
      );
    } catch (e) {
      if (e instanceof JqAbort) jqFatal("episodes.jsonl", e);
      throw e;
    }
  }
}

function printJson(ctx: Ctx): void {
  if (!nonEmpty(ctx.themes)) die("no recap yet — run without --cached to generate one");
  const themes = readThemesValue(ctx);
  // `<(jq -c . "$EPISODES")`: a failure inside the process substitution is not
  // fatal — the values before a bad line (or none for a missing file) are used.
  const episodes = parseJsonLines(readOrEmpty(ctx.episodes), "episodes.jsonl", true);
  ctx.io.stdout(jqPretty({ themes, episodes }) + "\n");
}

// ---------------------------------------------------------------------------
// Tiered rollups + staircase context (--context)
// ---------------------------------------------------------------------------

/** rendered.tsv as sed sees it (lines) and as `wc -l` counts it (newlines). */
function readTsv(p: string): { lines: string[]; n: number } {
  const content = readOrEmpty(p);
  return { lines: splitLines(content), n: countNewlines(content) };
}

/** `jq -r '.KEY // empty' FILE || ""`: "" for a missing/invalid file or null/false. */
function metaField(file: string, key: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
  try {
    const v = jqIndex(obj, key);
    return v === null || v === false ? "" : jqRawPrint(v);
  } catch {
    return "";
  }
}

function renderCached(ctx: Ctx): void {
  const jsonl = readOrEmpty(ctx.jsonl);
  const rawLines = countNewlines(jsonl);
  let metaVer = "";
  let metaKeep = "";
  let doneLines = "";
  if (isFile(ctx.renderMeta) && isFile(ctx.renderedTsv)) {
    metaVer = metaField(ctx.renderMeta, "version");
    metaKeep = metaField(ctx.renderMeta, "keep");
    doneLines = metaField(ctx.renderMeta, "raw_lines");
  }
  const done = bashDigits(doneLines);
  if (metaVer !== String(RENDER_VERSION) || metaKeep !== KEEP_TYPES_JSON || typeof done !== "number" || done > rawLines) {
    const rows = renderRange(jsonl, 1, rawLines);
    fs.writeFileSync(ctx.renderedTsv + ".tmp", rows.map((r) => rowToTsv(r) + "\n").join(""));
    fs.renameSync(ctx.renderedTsv + ".tmp", ctx.renderedTsv);
  } else if (done < rawLines) {
    // A crash between a previous append and its meta write leaves rows above
    // the recorded mark; drop them first or they would duplicate.
    const tsv = readOrEmpty(ctx.renderedTsv);
    const lastRow = cutField(lastLine(tsv), 1);
    const lastNo = bashDigits(lastRow);
    if (typeof lastNo === "number" && lastNo > done) {
      const kept = splitLines(tsv).filter((l) => awkToNumber(cutField(l, 1)) <= done);
      fs.writeFileSync(ctx.renderedTsv + ".tmp", kept.map((l) => l + "\n").join(""));
      fs.renameSync(ctx.renderedTsv + ".tmp", ctx.renderedTsv);
    }
    const rows = renderRange(jsonl, done + 1, rawLines - done);
    fs.appendFileSync(ctx.renderedTsv, rows.map((r) => rowToTsv(r) + "\n").join(""));
  }
  fs.writeFileSync(
    ctx.renderMeta,
    jqPretty({ version: RENDER_VERSION, keep: KEEP_TYPES_JSON, raw_lines: rawLines, updated: stampLocal(ctx.io.now()) }) + "\n"
  );
}

/** `_ctx_model_window`: the inference model's context window in tokens (MODEL_CONTEXT_WINDOW is bash arithmetic). */
function ctxModelWindow(ctx: Ctx): number {
  const env = ctx.io.env;
  const mcw = env["MODEL_CONTEXT_WINDOW"] || "auto";
  if (mcw !== "auto") {
    return arithOrUnbound(() => {
      const v = bashArith(mcw);
      if (v === null) die(`MODEL_CONTEXT_WINDOW: arithmetic syntax error in "${mcw}"`);
      return v;
    });
  }
  const name = env["THINK_MODEL"] || env["SHELLM_MODEL"] || "";
  if (/claude|opus|sonnet|haiku/.test(name)) return 200000;
  if (/gpt-4\.1|o1|o3|o4/.test(name)) return 1000000;
  if (name === "") return 200000;
  return 128000;
}

/** `_ctx_resolve_R` (+ `_ctx_model_window` and the auto budget cap), with bash arithmetic on env values. */
function ctxResolveR(ctx: Ctx, n: number): number {
  const env = ctx.io.env;
  if (ctx.opts.ctxRawTail !== "auto") return bashDigits(ctx.opts.ctxRawTail) as number;
  const win = ctxModelWindow(ctx);
  let budget: number | "auto" = "auto";
  let cap = 4000;
  if (ctx.opts.ctxBudget === "auto") {
    // `(( budget > cap )) && budget=$cap`: a syntax-error cap (not an
    // identifier — e.g. "1+") makes the `(( ))` test fail and the cap is
    // simply skipped; a bare-identifier-shaped cap (e.g. "notanumber") is a
    // `set -u` unbound-variable abort instead — see bashArith()/PARITY.md.
    const c = arithOrUnbound(() => bashArith(env["RECAP_CONTEXT_BUDGET_MAX"] || "4000"));
    cap = c === null ? Number.POSITIVE_INFINITY : c;
  } else {
    budget = bashDigits(ctx.opts.ctxBudget) as number;
  }
  return resolveR({ n, rawTail: "auto", budget, window: win, budgetCap: cap });
}

function ctxStartIndex(ctx: Ctx, n: number): number {
  if (ctx.opts.backfill) return 0;
  let s: number;
  if (isFile(ctx.rollupMeta)) {
    const raw = metaField(ctx.rollupMeta, "start_index");
    const v = bashDigits(raw === "" ? "0" : raw);
    if (v === "octal-error") die(`rollups/meta.json: arithmetic error in start_index "${raw}"`);
    s = v ?? 0;
  } else {
    s = n;
  }
  // Snap DOWN to a FANOUT boundary (an unsnapped marker leaves the straddling
  // block unbuildable forever).
  return Math.floor(s / ctx.fanout) * ctx.fanout;
}

function touchLock(ctx: Ctx): void {
  try {
    const now = ctx.io.now();
    fs.utimesSync(ctx.rollupLock, now, now);
  } catch {
    /* best effort */
  }
}

function writeBlock(ctx: Ctx, file: string, tier: number, s: number, e: number, body: { [k: string]: Json }, fallbackIds: Json[]): void {
  let stepIds = jqAlt(body["step_ids"], []);
  try {
    if (jqLength(stepIds) === 0) stepIds = fallbackIds;
  } catch (err) {
    if (err instanceof JqAbort) jqFatal(`rollup t${tier} [${s},${e})`, err);
    throw err;
  }
  const block = {
    tier,
    start: s,
    end: e,
    n: e - s,
    summary: jqAlt(body["summary"], ""),
    themes: jqAlt(body["themes"], []),
    step_ids: stepIds,
    model: ctx.opts.mapModel,
    prompt_version: ROLLUP_PROMPT_VERSION,
    created: stampLocal(ctx.io.now()),
    // `+ (if $body.refused then {refused:true} else {} end)` — the placeholder flag.
    ...(jqTruthy(body["refused"]) ? { refused: true } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jqCompact(block) + "\n");
  ctx.sealed += 1; // _CTX_SEALED
}

/**
 * `_ctx_rollup_body`: the JSON body for one block. When the model refuses the
 * window (a content filter, decided by the text, so it would refuse again on
 * every call) the block is sealed with a placeholder so the build moves past it
 * (Harris's summary sat frozen for 12 days behind one refused block,
 * 2026-10-03). Any other failure leaves the block unsealed and stops this
 * build; the next call tries again. undefined = stop.
 */
function ctxRollupBody(ctx: Ctx, tier: number, s: number, e: number, input: string): Json | JsonSeq | undefined {
  const r = llmJsonRc(ctx, ctx.opts.mapModel, ROLLUP_SYSTEM, input, String(ROLLUP_MAX_TOKENS));
  if (r.rc === 0) return r.value;
  if (r.rc === 2) {
    note(ctx, `rollup t${tier} [${s},${e}): the model refused this window, sealing a placeholder`);
    return { summary: "(Not summarized: the summary model refused this window.)", themes: [], step_ids: [], refused: true };
  }
  note(ctx, `rollup t${tier} [${s},${e}): no valid JSON, stopping the build here`);
  return undefined;
}

/** Seal one tier-1 block; false = the build must stop here (no valid JSON). */
function sealTier1(ctx: Ctx, tsv: string[], s: number, e: number): boolean {
  const file = blockPath(ctx.rollupDir, 1, s, e);
  if (isFile(file)) return true;
  touchLock(ctx); // keepalive: a --backfill legitimately seals for hours
  const rows = tsv.slice(s, e); // sed -n "s+1,ep"
  const text = stripTrailingNewlines(rows.map((r) => cutField(r, 4)).join("\n"));
  const fid = rows.length ? cutField(rows[0]!, 2) : "";
  const lid = rows.length ? cutField(rows[rows.length - 1]!, 2) : "";
  note(ctx, `rollup t1 [${s},${e})`);
  const reply = ctxRollupBody(ctx, 1, s, e, text);
  if (reply === undefined) return false;
  if (reply instanceof JsonSeq) argjsonSeqAbort(ctx, file); // mkdir -p …; jq -n --argjson body … > "$file"
  writeBlock(ctx, file, 1, s, e, bodyObj(reply, `rollup t1 [${s},${e})`), [fid, lid]);
  return true;
}

/** Seal one tier-k block (k>1); false = the build must stop here (no valid JSON). */
function sealTierK(ctx: Ctx, tier: number, s: number, e: number): boolean {
  const file = blockPath(ctx.rollupDir, tier, s, e);
  if (isFile(file)) return true;
  touchLock(ctx);
  const childBlk = powFanout(ctx.fanout, tier - 1);
  const where = `rollup t${tier} [${s},${e})`;
  let lines = "";
  let fallback = "";
  for (let c = s; c < e; c += childBlk) {
    const cf = blockPath(ctx.rollupDir, tier - 1, c, c + childBlk);
    if (!isFile(cf)) die(`${where}: missing child ${cf}`);
    let child: unknown;
    try {
      child = JSON.parse(fs.readFileSync(cf, "utf8"));
    } catch (err) {
      jqFatal(where, new JqAbort(`${cf}: parse error: ${(err as Error).message}`));
    }
    try {
      // "[" + (.step_ids | join(",")) + "] " + .summary — then $(...) strips trailing newlines
      const line = jqStrAdd("[" + jqJoin(jqIndex(child, "step_ids"), ",") + "] ", jqIndex(child, "summary"));
      lines += stripTrailingNewlines(line) + "\n";
      // .step_ids[0] // empty
      const ids = jqIndex(child, "step_ids");
      let first: Json = null;
      if (Array.isArray(ids)) first = ids[0] ?? null;
      else if (ids !== null) throw new JqAbort(`Cannot index ${jqType(ids)} with number`);
      fallback += (first === null || first === false ? "" : jqRawPrint(first)) + "\n";
    } catch (err) {
      if (err instanceof JqAbort) jqFatal(where, err);
      throw err;
    }
  }
  note(ctx, where);
  const reply = ctxRollupBody(ctx, tier, s, e, lines);
  if (reply === undefined) return false;
  if (reply instanceof JsonSeq) argjsonSeqAbort(ctx, file);
  // awk 'NF && ++c <= 4' | jq -R . | jq -sc .
  const fb = fallback
    .split("\n")
    .filter((l) => /[^ \t]/.test(l))
    .slice(0, 4);
  writeBlock(ctx, file, tier, s, e, bodyObj(reply, where), fb);
  return true;
}

/**
 * `_ctx_build`: lazily seal every complete block at or after `start`,
 * bottom-up. One call seals at most ROLLUP_MAX_SEALS blocks (0 = no cap;
 * --backfill has none): the build runs inside a wake, and a backlog of hundreds
 * of blocks would hold that wake for hours. The rest waits for the next call.
 * false = a seal failed and the build stopped early.
 */
function ctxBuild(ctx: Ctx, tsv: string[], n: number, start: number): boolean {
  const max = ctx.opts.backfill ? 0 : ctx.maxSeals;
  for (const task of buildPlan(n, start, ctx.fanout)) {
    if (isFile(blockPath(ctx.rollupDir, task.tier, task.s, task.e))) continue;
    if (max > 0 && ctx.sealed >= max) {
      note(ctx, `sealed ${ctx.sealed} blocks, the cap for one call; the rest waits`);
      return true;
    }
    const ok = task.tier === 1 ? sealTier1(ctx, tsv, task.s, task.e) : sealTierK(ctx, task.tier, task.s, task.e);
    if (!ok) return false;
  }
  return true;
}

/** One staircase line from a sealed block file, or the unreadable fallback. */
function blockLine(ctx: Ctx, tier: number, s: number, e: number): string {
  const file = blockPath(ctx.rollupDir, tier, s, e);
  try {
    const b: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return `[t${jqInterp(jqIndex(b, "tier"))} · steps ${jqInterp(jqIndex(b, "start"))}–${jqInterp(jqIndex(b, "end"))}] ${jqInterp(jqIndex(b, "summary"))}   (${jqJoin(jqIndex(b, "step_ids"), " ")})`;
  } catch {
    return `[t${tier} · steps ${s}–${e}] (unreadable rollup block)`;
  }
}

/**
 * The bounded citation lookup's state (sync 2e39a3f, cef6837/06fb700):
 * `_CTX_NAMER_FILES` / `_CTX_NAMER_TEXT` / `_CTX_NAMER_PARTIAL` / `_CTX_NAMER_LEFT`.
 */
interface Namers {
  files: string[];
  text: string[];
  partial: boolean;
  /** Bytes of optional text still available. */
  left: number;
}

const NAMER_PROBES = 128; // at most 128 deterministic paths per assembly
const NAMER_READ_BYTES = 32768; // 32 KiB per candidate (+1 overflow sentinel)

/**
 * `_ctx_prepare_namers`. Correction lookup is deliberately partial: at most 128
 * deterministic paths, round-robin across tiers, newest first within each tier.
 * No directory walk or per-displayed-window history scan. Read at most 32 KiB
 * (+1 overflow sentinel) per candidate, once per assembly. Old/oversized/
 * unreadable blocks remain discoverable by an explicit search; they must not
 * break the raw context.
 */
function ctxPrepareNamers(ctx: Ctx, n: number, left: number): Namers {
  const nm: Namers = { files: [], text: [], partial: false, left };
  const F = ctx.fanout;
  const sizes: number[] = [];
  let total = 0;
  let blk = F;
  while (blk <= n) {
    sizes.push(blk);
    total += Math.floor(n / blk);
    if (blk > Math.floor(n / F)) break;
    blk *= F;
  }
  if (total > NAMER_PROBES) nm.partial = true;
  let probes = 0;
  for (let round = 0; round < NAMER_PROBES && probes < NAMER_PROBES; round++) {
    for (let tier = 0; tier < sizes.length && probes < NAMER_PROBES; tier++) {
      const size = sizes[tier]!;
      const end = (Math.floor(n / size) - round) * size;
      if (end <= 0) continue;
      probes += 1;
      const f = blockPath(ctx.rollupDir, tier + 1, end - size, end);
      if (!isFile(f)) continue;
      let body: Buffer;
      try {
        // head bounds bytes even if the file grows between stat and read.
        const fd = fs.openSync(f, "r");
        try {
          const buf = Buffer.alloc(NAMER_READ_BYTES + 1);
          const got = fs.readSync(fd, buf, 0, buf.length, 0);
          body = buf.subarray(0, got);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        nm.partial = true;
        continue;
      }
      if (body.length > NAMER_READ_BYTES) {
        nm.partial = true;
        continue;
      }
      // jq -er '.summary | select(type == "string")'
      let summary: string | undefined;
      try {
        const v: unknown = JSON.parse(body.toString("utf8"));
        const sm = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as { [k: string]: unknown })["summary"] : undefined;
        if (typeof sm === "string") summary = sm;
      } catch {
        summary = undefined;
      }
      if (summary === undefined) {
        nm.partial = true;
        continue;
      }
      nm.files.push(f);
      nm.text.push(summary);
    }
    if (probes >= total) break;
  }
  return nm;
}

/**
 * The `[id,...]` prefix a displayed block is cited by, from its JSON text:
 * jq -er '.step_ids | select(array, length > 0, all strings) | "[" + join(",") + "]"'.
 * undefined = no citable ids (or unparseable), so the block gets no namers.
 */
export function namerKeyOf(blockJson: string): string | undefined {
  try {
    const b: unknown = JSON.parse(blockJson);
    const ids = b !== null && typeof b === "object" && !Array.isArray(b) ? (b as { [k: string]: unknown })["step_ids"] : undefined;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) return undefined;
    return "[" + (ids as string[]).join(",") + "]";
  } catch {
    return undefined;
  }
}

/**
 * The namer lines for one displayed block: every OTHER candidate summary that
 * quotes `key`, each whole or not at all, while `nm.left` bytes last (a line
 * that does not fit marks the lookup partial). Mutates nm.left / nm.partial.
 */
export function namerLines(nm: { files: string[]; text: string[]; partial: boolean; left: number }, blockFile: string, key: string): string {
  let out = "";
  for (let i = 0; i < nm.files.length; i++) {
    if (nm.files[i] === blockFile) continue;
    if (!nm.text[i]!.includes(key)) continue;
    // A citation is not proof of supersession: the writer may merely refer to a
    // window. Preserve the evidence, don't label it a proven correction.
    const line = `  [namer of the window above, cites it] ${nm.text[i]}`;
    const bytes = Buffer.byteLength(line + "\n");
    if (bytes <= nm.left) {
      out += line + "\n";
      nm.left -= bytes;
    } else {
      nm.partial = true;
    }
  }
  return out;
}

/**
 * `_ctx_emit_namers`: after a displayed window, any OTHER sealed summary that
 * quotes its exact `[id,...]` prefix, whole or not at all, while the optional
 * byte allowance lasts.
 */
function ctxEmitNamers(nm: Namers, blockFile: string): string {
  let text: string;
  try {
    text = fs.readFileSync(blockFile, "utf8");
  } catch {
    return "";
  }
  const key = namerKeyOf(text);
  return key === undefined ? "" : namerLines(nm, blockFile, key);
}

/** `_ctx_assemble_base`: the staircase (coarse→fine, chronological within a tier), then the raw tail verbatim. */
function ctxAssembleBase(ctx: Ctx, tsv: string[], n: number, r: number, start: number, namers: Namers | undefined): string {
  const plan = planStaircase(n, r, ctx.fanout);
  const exists = (tier: number, s: number, e: number): boolean => isFile(blockPath(ctx.rollupDir, tier, s, e));
  const emitted = resolveSegments(plan.segments, exists, start, ctx.fanout);
  let out = "";
  let any = false;
  for (const seg of emitted) {
    if (!any) out += LIFE_HEADER + "\n";
    any = true;
    out += blockLine(ctx, seg.tier, seg.s, seg.e) + "\n";
    if (namers !== undefined) out += ctxEmitNamers(namers, blockPath(ctx.rollupDir, seg.tier, seg.s, seg.e));
  }
  if (any) out += "\n";
  // PORT-NOTE (1c: 6a5f6c5, bin/recap:688) — `--raw-tail 0` (the LITERAL
  // flag value, not a resolved r that happens to be 0 via budget math) means
  // "no verbatim block at all", not "the unsealed remainder": the monolith
  // renders its own recent stream, so life_context's default call
  // (`--raw-tail "${ROLLUP_RAW_TAIL:-0}"`, a4ed181) omits this whole section
  // every time. `--raw-tail auto` (or any other explicit value) still prints
  // the header even when the resolved count happens to be 0.
  if (ctx.opts.ctxRawTail === "0") return out;
  out += rawTailHeader(n - plan.cut0) + "\n";
  for (let i = plan.cut0; i < n; i++) {
    const line = tsv[i];
    if (line !== undefined) out += cutField(line, 4) + "\n";
  }
  return out;
}

const CITATION_HINT = "  [Citation lookup limited; search rollups/t*/ for exact [id,...] prefix.]";

/**
 * `_ctx_assemble` (sync 2e39a3f). Existing base summaries/raw tail are never
 * sacrificed for optional citations. Measure that base first, then spend only
 * unused budget (4 bytes/token, matching the raw-tail approximation), capped at
 * 20% of the allowance and 4096 bytes. If even the notice will not fit, the base
 * is printed unchanged and the notice goes to stderr.
 */
function ctxAssemble(ctx: Ctx, tsv: string[], n: number, r: number, start: number): void {
  const base = ctxAssembleBase(ctx, tsv, n, r, start, undefined);
  const bytes = Buffer.byteLength(base);
  let budget: number;
  if (ctx.opts.ctxBudget === "auto") {
    budget = Math.trunc((ctxModelWindow(ctx) * 6) / 10);
    // `cap="${RECAP_CONTEXT_BUDGET_MAX:-4000}"; (( budget > cap )) && budget=$cap` — as in ctxResolveR.
    const c = arithOrUnbound(() => bashArith(ctx.io.env["RECAP_CONTEXT_BUDGET_MAX"] || "4000"));
    const cap = c === null ? Number.POSITIVE_INFINITY : c;
    if (budget > cap) budget = cap;
  } else {
    budget = bashDigits(ctx.opts.ctxBudget) as number;
  }
  let allowance = budget * 4 - bytes;
  let cap = Math.trunc((budget * 4) / 5);
  if (cap > 4096) cap = 4096;
  if (allowance > cap) allowance = cap;
  const hintBytes = Buffer.byteLength(CITATION_HINT + "\n");
  if (allowance < hintBytes) {
    // No optional bytes available: preserve base verbatim. stderr keeps the
    // limitation discoverable even when the caller requests a tiny budget.
    ctx.io.stdout(base);
    ctx.io.stderr(CITATION_HINT + "\n");
    return;
  }
  const nm = ctxPrepareNamers(ctx, n, allowance - hintBytes);
  ctx.io.stdout(ctxAssembleBase(ctx, tsv, n, r, start, nm));
  if (nm.partial) ctx.io.stdout(CITATION_HINT + "\n");
}

function ctxRun(ctx: Ctx): void {
  fs.mkdirSync(ctx.rollupDir, { recursive: true });
  acquireLock(ctx, ctx.rollupLock, `another rollup build is in progress (remove ${ctx.rollupLock} if wrong)`);
  try {
    renderCached(ctx);
    const { lines, n } = readTsv(ctx.renderedTsv);
    const r = ctxResolveR(ctx, n);
    const start = ctxStartIndex(ctx, n);
    // Persist the start marker on first enable or on backfill.
    if (!isFile(ctx.rollupMeta) || ctx.opts.backfill) {
      fs.writeFileSync(ctx.rollupMeta, jqPretty({ start_index: start, updated: stampLocal(ctx.io.now()) }) + "\n");
    }
    if (ctx.opts.mode === "rebuild") {
      for (const ent of fs.readdirSync(ctx.rollupDir)) {
        if (ent.startsWith("t")) fs.rmSync(path.join(ctx.rollupDir, ent), { recursive: true, force: true }); // rm -rf t*
      }
    }
    // A failed build still prints the blocks that exist: dying here left the
    // mind with no life summary at all.
    if (ctx.opts.mode !== "cached" && !ctxBuild(ctx, lines, n, start)) {
      note(ctx, "rollup build stopped early; printing the blocks that exist");
    }
    ctxAssemble(ctx, lines, n, r, start);
  } finally {
    try {
      fs.rmSync(ctx.renderedTsv + ".tmp", { force: true });
    } catch {
      /* none */
    }
    releaseLock(ctx.rollupLock);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(io: RecapIO, argv: string[]): Opts | number {
  const env = io.env;
  const defaultModel = env["RECAP_MODEL"] || env["SHELLM_MODEL"] || DEFAULT_MODEL;
  const o: Opts = {
    trajDir: env["TRAJ_DIR"] ?? "",
    trajIdArg: "",
    window: "100",
    gapMinutes: "30",
    maxWindowBytes: env["RECAP_MAX_WINDOW_BYTES"] || "60000",
    mode: "auto",
    output: "text",
    quiet: false,
    mapModel: env["RECAP_MAP_MODEL"] || defaultModel,
    reduceModel: env["RECAP_REDUCE_MODEL"] || defaultModel,
    context: false,
    backfill: false,
    fanout: env["ROLLUP_FANOUT"] || "10",
    ctxBudget: env["MONOLITH_CONTEXT_BUDGET"] || "auto",
    ctxRawTail: env["ROLLUP_RAW_TAIL"] || "auto",
  };
  const args = argv.slice();
  while (args.length > 0) {
    const a = args[0]!;
    switch (a) {
      case "--traj_dir":
        o.trajDir = required(args[1], "--traj_dir requires DIR");
        args.splice(0, 2);
        break;
      case "--window":
        o.window = required(args[1], "--window requires N");
        args.splice(0, 2);
        break;
      case "--context":
        o.context = true;
        args.shift();
        break;
      case "--backfill":
        o.context = true;
        o.backfill = true;
        args.shift();
        break;
      case "--budget":
        o.ctxBudget = required(args[1], "--budget requires N|auto");
        args.splice(0, 2);
        break;
      case "--raw-tail":
        o.ctxRawTail = required(args[1], "--raw-tail requires N");
        args.splice(0, 2);
        break;
      case "--fanout":
        o.fanout = required(args[1], "--fanout requires N");
        args.splice(0, 2);
        break;
      case "--gap-minutes":
        o.gapMinutes = required(args[1], "--gap-minutes requires N");
        args.splice(0, 2);
        break;
      case "--cached":
        o.mode = "cached";
        args.shift();
        break;
      case "--rebuild":
        o.mode = "rebuild";
        args.shift();
        break;
      case "--json":
        o.output = "json";
        args.shift();
        break;
      case "--model":
        o.mapModel = required(args[1], "--model requires MODEL");
        o.reduceModel = o.mapModel;
        args.splice(0, 2);
        break;
      case "--map-model":
        o.mapModel = required(args[1], "--map-model requires MODEL");
        args.splice(0, 2);
        break;
      case "--reduce-model":
        o.reduceModel = required(args[1], "--reduce-model requires MODEL");
        args.splice(0, 2);
        break;
      case "-q":
      case "--quiet":
        o.quiet = true;
        args.shift();
        break;
      case "-h":
      case "--help":
        io.stdout(USAGE);
        return 0;
      case "--version":
        io.stdout(`recap ${RECAP_VERSION}\n`);
        return 0;
      default:
        if (a.startsWith("-")) die(`Unknown option: ${a}`);
        if (o.trajIdArg !== "") die("Usage: recap [ID] [options]");
        o.trajIdArg = a;
        args.shift();
    }
  }
  return o;
}

export function runRecap(argv: string[], io: RecapIO): number {
  try {
    const parsed = parseArgs(io, argv);
    if (typeof parsed === "number") return parsed;
    const opts = parsed;

    const w = bashDigits(opts.window);
    if (typeof w !== "number" || w < 10) die("--window must be a number >= 10");

    const runDir = resolveTrajDir(io, opts);
    const cache = path.join(runDir, "recap");
    const rollupDir = path.join(runDir, "rollups");
    const f = bashDigits(opts.fanout);
    if (typeof f !== "number" || f < 2) die("--fanout must be a number >= 2");
    const msRaw = io.env["ROLLUP_MAX_SEALS"];
    const ms = msRaw === undefined || msRaw === "" ? 20 : /^[0-9]+$/.test(msRaw) ? Number(msRaw) : NaN;
    if (Number.isNaN(ms)) die("ROLLUP_MAX_SEALS must be a number (0 = no cap)");
    if (opts.context) {
      const rt = opts.ctxRawTail;
      if (!(rt === "auto" || typeof bashDigits(rt) === "number")) die("--raw-tail must be a number or auto");
      const b = opts.ctxBudget;
      const bv = bashDigits(b);
      if (!(b === "auto" || (typeof bv === "number" && bv > 0))) die("--budget must be a positive number or auto");
    }

    const ctx: Ctx = {
      io,
      opts,
      runDir,
      jsonl: path.join(runDir, "trajectory.jsonl"),
      cache,
      episodes: path.join(cache, "episodes.jsonl"),
      themes: path.join(cache, "themes.json"),
      lock: path.join(cache, ".lock"),
      rollupDir,
      rollupLock: path.join(rollupDir, ".lock"),
      rollupMeta: path.join(rollupDir, "meta.json"),
      renderedTsv: path.join(rollupDir, "rendered.tsv"),
      renderMeta: path.join(rollupDir, "rendered.meta.json"),
      fanout: f,
      maxSeals: ms,
      sealed: 0,
    };

    if (opts.context) {
      ctxRun(ctx);
      return 0;
    }
    if (opts.mode === "rebuild") {
      fs.rmSync(cache, { recursive: true, force: true });
      refresh(ctx);
    } else if (opts.mode === "auto") {
      refresh(ctx);
    }
    if (opts.output === "json") printJson(ctx);
    else printText(ctx);
    return 0;
  } catch (e) {
    if (e instanceof RecapExit) {
      if (e.dieMsg !== undefined) io.stderr(`recap: error: ${e.dieMsg}\n`);
      return e.code;
    }
    throw e;
  }
}
