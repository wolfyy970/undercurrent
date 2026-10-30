// mem.ts — CLI semantic memory store (SPEC §5). Faithful port of headlong/bin/mem.
//
// Behaviour is the blueprint, not the Bash text: the sed/tr/date/od plumbing
// becomes native fs / string / Date / crypto, but two things are held exact:
//   1. the ON-DISK FORMAT — one markdown file per memory, filename
//      `YYYY-MM-DD-HH-MM-SS_<hex8>_<slug>.md`, YAML frontmatter
//      `id, summary, type, created[, updated]` + a blank line + the body.
//      Another process reads these (the `mem search` corpus, and the monolith's
//      goals scraper over `type: goal|intention`), so the bytes must match.
//   2. the CLI CONTRACT — the same subcommands, flags, quirks, stdout/stderr
//      split, and exit codes as the Bash tool, so the sandbox can exec the shim
//      exactly like the original.
//
// Headlong quirks are REPLICATED, not fixed. Called out where non-obvious:
//   - `mem add` MEM_TYPE: without `.memrc`, env `MEM_TYPE` is ignored. WITH a
//     `.memrc`, Bash's `_pre_env` snapshot (taken after `MEM_TYPE="memory"`)
//     re-exports over the sourced rc, so any set env `MEM_TYPE` forces type back
//     to "memory" — discarding its value and clobbering a `.memrc` `MEM_TYPE`.
//   - legacy (id-less) filenames rename to a `_<slug>` double-underscore form.
//   - `mem edit` summary is byte-sliced to 80; `mem add` summary is char-sliced.
//   - list `--before/--after` compare the YYYY-MM-DD prefix lexically.
//
// The one deliberate simplification: `.memrc` is parsed as `[export ]KEY=VALUE`
// lines (env > rc precedence preserved) rather than sourced as arbitrary shell —
// an idiomatic TS port does not spawn bash to evaluate a config file. Simple
// per-repo assignments (MEM_DIR, MEM_TYPE, SHELLM_FAST_MODEL) behave as before.
//
// PORT-NOTE (1c: 766a290, 69fddc6, 130796a): `mem search` is two stages —
// `mem_prefilter` scores every memory locally (BM25 over the query's terms)
// and keeps the best `MEM_SEARCH_TOP`; only those go to the model. The
// scoring runs byte-wise (Buffer, not JS strings/code points), matching
// Bash's `LC_ALL=C awk` (69fddc6): ASCII-only case folding, byte length, byte
// substring counts. `mem prefilter` (130796a) exposes stage 1 with no model
// call — the wake prompt's related-memories section (thinkers/_lib/common.sh,
// lane B) is built on it; this port does not yet consume it (lane B's scope).

import * as fs from "node:fs";
import * as path from "node:path";
import { memRedact, MemRedactError } from "./memRedact.ts";

export const MEM_VERSION = "0.1.0";
const DEFAULT_MEM_DIR = "./.memories";
const DEFAULT_TYPE = "memory";
const DEFAULT_SEARCH_TOP = "40";
const DEFAULT_SEARCH_MAX_TOKENS = "16000";
const DEFAULT_SEARCH_HEARTBEAT_S = "10";

/** `mem search` LLM system prompt — the search-behaviour contract, verbatim. */
const SEARCH_SYSTEM_PROMPT =
  "You are a semantic search engine for memory files. Each memory has a filename " +
  "header (=== filename ===), YAML frontmatter (summary, type), and a body. Return " +
  "ONLY the filenames and summaries of semantically matching memories, one per line. " +
  "If nothing matches, say 'No matches found.'";

// ---------------------------------------------------------------------------
// mem_prefilter (1c: 766a290 introduced the two-stage split and an IDF*log
// score; 69fddc6 ran it under LC_ALL=C; 130796a replaced the score with BM25
// — saturating term frequency (k1=1.2) discounted for files longer than
// average (b=0.75) — because the earlier score ranked the same long files
// first for every query (a long file matches more terms by being long).
// ---------------------------------------------------------------------------

/** Terms of 3+ allowed chars, minus stopwords, from `mem_prefilter`'s pipeline:
 *  `tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_#@.-' '\n' | awk 'length>=3' |
 *  grep -vxE '<stopwords>' | sort -u`. Byte-wise (C locale): only ASCII A-Z
 *  folds to lowercase; every other byte (including UTF-8 continuation bytes
 *  of a multibyte char) is a token separator, same as Bash under LC_ALL=C. */
const PREFILTER_STOPWORDS = new Set([
  "the", "and", "for", "not", "from", "with", "that", "this", "are", "was",
  "what", "when", "how", "about", "into", "has", "have", "had", "its", "but",
  "all", "any", "can", "out", "one", "two", "then", "than", "they", "them",
  "will", "were", "been", "being", "also", "just", "only", "some", "such",
  "there", "their", "which", "while", "would", "could", "should",
]);

function isPrefilterTermByte(b: number): boolean {
  return (
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x5f || // _
    b === 0x23 || // #
    b === 0x40 || // @
    b === 0x2e || // .
    b === 0x2d // -
  );
}

/** Extract the query's search terms, byte-wise, lowest-first, deduped
 *  (`sort -u` under LC_ALL=C, ASCII byte order). */
export function extractPrefilterTerms(query: string): string[] {
  const buf = Buffer.from(query, "utf8");
  const tokens: string[] = [];
  let cur = "";
  for (const raw of buf) {
    const b = raw >= 0x41 && raw <= 0x5a ? raw + 0x20 : raw; // tr A-Z -> a-z
    if (isPrefilterTermByte(b)) {
      cur += String.fromCharCode(b);
    } else if (cur !== "") {
      tokens.push(cur);
      cur = "";
    }
  }
  if (cur !== "") tokens.push(cur);
  const kept = tokens.filter((t) => t.length >= 3 && !PREFILTER_STOPWORDS.has(t));
  return [...new Set(kept)].sort();
}

/** Byte-wise ASCII-lowercase, split into awk-style records (lines, trailing
 *  newline drops the final empty record; a genuinely empty file yields none). */
function toLowerLines(buf: Buffer): string[] {
  let s = "";
  for (const raw of buf) {
    s += String.fromCharCode(raw >= 0x41 && raw <= 0x5a ? raw + 0x20 : raw);
  }
  const lines = s.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Count of a term's ERE matches in `line` — `gsub(term, "&", line)`'s return
 *  value. The prefilter's term alphabet (`a-z0-9_#@.-`) is ERE-metacharacter
 *  free except `.` (matches any byte), which JS regex treats identically, so
 *  the term string doubles as its own (unescaped) pattern source. */
function countTermMatches(line: string, term: string): number {
  const m = line.match(new RegExp(term, "g"));
  return m ? m.length : 0;
}

interface ScoredFile {
  name: string;
  score: number;
}

/** BM25-score `files` (name + raw content bytes) against `terms`; only
 *  positive scores are returned (`if (s > 0) printf ...`), highest first,
 *  ties in REVERSE of input (glob/insertion) order — `sort -k1,1 -gr` with no
 *  `-s` is not "stable, then negate" on this port's oracle (BSD `sort`); see
 *  the PORT-NOTE at the sort call below. */
export function scorePrefilterCandidates(
  files: { name: string; content: Buffer }[],
  terms: string[],
): ScoredFile[] {
  if (terms.length === 0) return [];
  // awk's FNR==1 rule only fires for a file with >=1 record — a genuinely
  // empty file (0 bytes) is silently absent from files[]/nf, not scored 0.
  const kept = files
    .map((f) => ({ name: f.name, lines: toLowerLines(f.content) }))
    .filter((f) => f.lines.length > 0);
  const nf = kept.length;
  if (nf === 0) return [];

  const len: number[] = new Array(nf).fill(0);
  const cnt: number[][] = kept.map(() => new Array(terms.length).fill(0));
  for (let f = 0; f < nf; f++) {
    for (const line of kept[f]!.lines) {
      len[f] = len[f]! + line.length + 1;
      for (let t = 0; t < terms.length; t++) {
        const c = countTermMatches(line, terms[t]!);
        if (c > 0) cnt[f]![t] = cnt[f]![t]! + c;
      }
    }
  }

  let avg = 1;
  for (let f = 0; f < nf; f++) avg += len[f]!;
  avg = avg / (nf || 1);

  const idf: number[] = new Array(terms.length).fill(0);
  for (let t = 0; t < terms.length; t++) {
    let df = 0;
    for (let f = 0; f < nf; f++) if (cnt[f]![t]! > 0) df++;
    idf[t] = Math.log(1 + (nf - df + 0.5) / (df + 0.5));
  }

  const scored: ScoredFile[] = [];
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let t = 0; t < terms.length; t++) {
      const tf = cnt[f]![t]!;
      if (tf > 0) {
        s += (idf[t]! * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * len[f]!) / avg));
      }
    }
    if (s > 0) scored.push({ name: kept[f]!.name, score: s });
  }
  // PORT-NOTE (bug found verifying 1c: 130796a's `sort -t\t -k1,1 -gr`, no
  // `-s`): BSD `sort`'s `-r` is NOT "stable sort, then negate" — ties come
  // out in the REVERSE of input (glob) order, verified directly:
  // `printf '5.0\ta\n3.0\tb\n5.0\tc\n' | sort -t$'\t' -k1,1 -gr` -> c, a,
  // b (5.0 twice, c before a — reversed — `sort -s` for the same input
  // keeps a before c). Two files scoring identically (same terms, same
  // length) is not rare — e.g. two near-identical todos — so this is a real
  // divergence, not a corner case: reverse first, THEN a stable sort by
  // score keeps that reversed order for ties while still ranking by score.
  scored.reverse();
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** `tail -n N`: last N elements, `[]` for N<=0 (bug #51's fix applies here
 *  too — `arr.slice(-0)` is the WHOLE array in JS, not empty). */
function tailN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.slice(-n);
}

/** `head -n N`: first N elements, `[]` for N<=0. */
function headN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.slice(0, n);
}

// ---------------------------------------------------------------------------
// Injectable IO — the shim wires process.*; tests inject fakes for a
// deterministic clock, random id, stdin, and `llm` subprocess.
// ---------------------------------------------------------------------------

export interface MemIO {
  /** Working directory relative paths (`./.memories`) resolve against. */
  cwd: string;
  /** Environment (MEM_DIR, MEM_TYPE, SHELLM_FAST_MODEL, …). */
  env: Record<string, string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Full stdin contents (used by `add`/`edit` when no text arg is given). */
  readStdin(): string;
  /** Colours are emitted only on a tty (matches `[[ -t 1 ]]`). */
  isTTY: boolean;
  /** Clock — the shim passes `() => new Date()`. */
  now(): Date;
  /** `bytes` random bytes as lowercase hex (id = randomHex(4) → 8 chars). */
  randomHex(bytes: number): string;
  /** Spawn `llm` for `mem search`: corpus on stdin, stdout inherited, returns
   *  exit code. `heartbeatSeconds` is the raw resolved `MEM_SEARCH_HEARTBEAT_S`
   *  value (1c: 69fddc6) — the shim prints "mem search: waiting for the
   *  model...\n" to stderr every that many seconds while `llm` is in flight,
   *  UNLESS the value is exactly the string `"0"` (Bash: `[[ "$hb" != 0 ]]`,
   *  a literal string compare — `"00"` would still heartbeat). shellm kills a
   *  command silent for 30s, and a reasoning model can think that long.
   *
   *  `timeoutSeconds` (sync 2e39a3f, 2a63d92 issue 119, MEM_SEARCH_TIMEOUT_S): a
   *  normalized non-negative integer string — total seconds the search may run;
   *  "0" waits forever. Informational for the in-process IO: the deadline (SIGKILL
   *  of the whole worker group, the one stderr line `mem search: no reply from the
   *  model within <t>s (MEM_SEARCH_TIMEOUT_S); giving up on this query.`, rc 124)
   *  is enforced by the supervisor in bin/mem.mjs — see searchSupervisorPlan. */
  runLlm(args: string[], stdinText: string, heartbeatSeconds: string, timeoutSeconds?: string): number;
}

/** `mem search <query>` is run by bin/mem.mjs as a supervisor around a worker
 *  process group (see its PORT-NOTE). Returns the normalized deadline in seconds
 *  (0 = none) when `argv` is a search with a query, else null. Mirrors the
 *  global-flag loop and the `search` arity check of runMem. */
export function searchSupervisorPlan(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): { timeoutS: number } | null {
  const args = [...argv];
  while (args.length > 0) {
    const a = args[0]!;
    if (a === "-h" || a === "--help" || a === "--version") return null;
    if (a === "-v" || a === "--verbose") args.shift();
    else if (a === "--dir") args.splice(0, 2);
    else break;
  }
  if (args.shift() !== "search" || args.length < 1) return null;
  const cfg = resolveConfig({ env, cwd } as MemIO);
  return { timeoutS: Number(cfg.searchTimeoutS) };
}

/** Thrown by `die` to unwind to the runMem boundary with an exit code. */
class MemExit extends Error {
  readonly code: number;
  /** When set, printed to stderr as `mem: error: <msg>`. */
  readonly dieMsg: string | undefined;
  constructor(code: number, dieMsg?: string) {
    super(dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests and engine-side reuse)
// ---------------------------------------------------------------------------

/**
 * slugify — lowercase, collapse each run of non-`[a-z0-9]` to a single `-`,
 * strip one leading and one trailing `-`, cap at 80 chars.
 * Mirrors `tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-80`.
 * Only ASCII A-Z is lowercased (as `tr` does) — everything else collapses to `-`.
 */
export function slugify(text: string): string {
  const s = text
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  // `cut -c1-80` counts code points; slice by code point (the collapse above
  // already yields ASCII, but keep this code-point-safe like summaryChars).
  return [...s].slice(0, 80).join("");
}

export interface ParsedName {
  ts: string;
  id: string;
  slug: string;
}

/**
 * Parse a memory basename (no `.md`) into timestamp / hex id / slug.
 * New format: `YYYY-MM-DD-HH-MM-SS_<hex8>_<slug>`. Legacy (no hex id):
 * `ts = base up to first '_'`, `slug = base after first '_'` (id empty).
 */
export function parseFilename(base: string): ParsedName {
  const m = /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})_([0-9a-f]{8})_(.+)$/.exec(base);
  if (m) return { ts: m[1]!, id: m[2]!, slug: m[3]! };
  const us = base.indexOf("_");
  if (us < 0) return { ts: base, id: "", slug: base }; // ${base%%_*}=base, ${base#*_}=base
  return { ts: base.slice(0, us), id: "", slug: base.slice(us + 1) };
}

/**
 * The lines of the first YAML frontmatter block, inclusive of the `---` fences.
 * Mirrors `sed -n '/^---$/,/^---$/p'` (including its re-trigger on a stray `---`
 * in the body; callers grep the first match so only the head block matters).
 */
export function frontmatterBlock(content: string): string[] {
  const out: string[] = [];
  let inRange = false;
  for (const line of content.split("\n")) {
    if (!inRange) {
      if (line === "---") {
        inRange = true;
        out.push(line);
      }
    } else {
      out.push(line);
      if (line === "---") inRange = false;
    }
  }
  return out;
}

/**
 * Extract a frontmatter field value: first `^field:` line, whitespace-trimmed,
 * with one layer of surrounding matched quotes removed. `""` when absent.
 */
export function frontmatterField(content: string, field: string): string {
  const prefix = field + ":";
  for (const line of frontmatterBlock(content)) {
    if (line.startsWith(prefix)) {
      let v = line.slice(prefix.length).replace(/^[ \t]*/, "");
      const q = /^["'](.*)["']$/.exec(v);
      if (q) v = q[1]!;
      return v;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Structured reader — the clean interface the monolith goals/recall paths use
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  /** Filename with `.md`. */
  filename: string;
  ts: string;
  id: string;
  slug: string;
  summary: string;
  /** Raw frontmatter type ("" when absent — list/consumers default to "memory"). */
  type: string;
  created: string;
  /** Raw `updated:` value ("" or the list-header empty string). */
  updated: string;
  /** Body: everything after the first frontmatter block. */
  body: string;
}

/** Parse one memory file's contents into a record. */
export function parseMemory(content: string, filename: string): MemoryRecord {
  const base = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const pf = parseFilename(base);
  // Body = lines after the first frontmatter block.
  const lines = content.split("\n");
  let fences = 0;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      fences++;
      if (fences === 2) {
        bodyStart = i + 1;
        break;
      }
    }
  }
  const body = fences >= 2 ? lines.slice(bodyStart).join("\n") : content;
  return {
    filename,
    ts: pf.ts,
    id: pf.id,
    slug: pf.slug,
    summary: frontmatterField(content, "summary"),
    type: frontmatterField(content, "type"),
    created: frontmatterField(content, "created"),
    updated: frontmatterField(content, "updated"),
    body,
  };
}

export interface MemoryFile {
  /** Filename with `.md`. */
  filename: string;
  /** Raw file contents. */
  content: string;
}

/**
 * The `"$MEM_DIR"/*.md` loop every Bash reader starts from (get_goals,
 * build-index.sh): regular `.md` files, dotfiles skipped, glob (byte) order,
 * with their raw contents. `[]` when the directory is absent. Readers that
 * need sed-exact field extraction (the retrieval index) work on `content`.
 */
export function readMemoryFiles(memDir: string, cwd = process.cwd()): MemoryFile[] {
  const dir = path.isAbsolute(memDir) ? memDir : path.resolve(cwd, memDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryFile[] = [];
  for (const f of names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort()) {
    const p = path.join(dir, f);
    let regular = false;
    try {
      regular = fs.statSync(p).isFile(); // `[[ -f "$f" ]] || continue`
    } catch {
      continue;
    }
    if (!regular) continue;
    out.push({ filename: f, content: fs.readFileSync(p, "utf8") });
  }
  return out;
}

/**
 * Read and parse every memory in a directory, sorted by filename (glob order).
 * Engine-side helper for the monolith's goals/recall functions — reads the same
 * on-disk format `mem` writes. Returns `[]` when the directory is absent.
 */
export function readMemories(memDir: string, cwd = process.cwd()): MemoryRecord[] {
  return readMemoryFiles(memDir, cwd).map((f) => parseMemory(f.content, f.filename));
}

// ---------------------------------------------------------------------------
// Date / id formatting
// ---------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");

/** `date +%Y-%m-%d-%H-%M-%S` in local time. */
function stampTs(d: Date): string {
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-` +
    `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
  );
}

/** `date +"%Y-%m-%d %H:%M:%S"` in local time. */
function stampHuman(d: Date): string {
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Runtime context (resolved config + IO), threaded through the actions
// ---------------------------------------------------------------------------

interface Ctx {
  io: MemIO;
  memDir: string;
  memType: string;
  fastModel: string;
  /** `MEM_SEARCH_TOP` — candidates the prefilter keeps (raw string; `head -n`/
   *  `tail -n` semantics on a non-numeric value are a documented deviation,
   *  see PARITY.md). */
  searchTop: string;
  /** `MEM_SEARCH_MAX_TOKENS` — `llm -t` output cap for the search call. */
  searchMaxTokens: string;
  /** `MEM_SEARCH_HEARTBEAT_S` — raw string; `"0"` disables (see `MemIO.runLlm`). */
  searchHeartbeatS: string;
  /** `MEM_SEARCH_TIMEOUT_S`, normalized: digits only, junk → "300". */
  searchTimeoutS: string;
  verbose: boolean;
  colors: { id: string; type: string; dim: string; reset: string };
}

function die(msg: string): never {
  throw new MemExit(1, msg);
}

function debug(ctx: Ctx, msg: string): void {
  if (ctx.verbose) ctx.io.stderr(`[mem debug] ${msg}\n`);
}

/** Resolve a memory-relative path against cwd for fs, keeping the raw string
 *  (`$MEM_DIR/name`) for display — matching Bash, which uses one string for
 *  both and lets the shell resolve it against the cwd. */
function fsResolve(ctx: Ctx, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.io.cwd, p);
}

/** Display/return path `$MEM_DIR/<name>` (raw concat, not path.join — preserves
 *  a leading `./`, exactly as the Bash glob `"$MEM_DIR"/*.md` does). */
function memPath(ctx: Ctx, name: string): string {
  return `${ctx.memDir}/${name}`;
}

/** Sorted `.md` files under MEM_DIR as display paths (`$MEM_DIR/<name>`). */
function listMdPaths(ctx: Ctx): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(fsResolve(ctx, ctx.memDir));
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".md") && !f.startsWith(".")) // glob `*` skips dotfiles
    .sort()
    .map((f) => memPath(ctx, f));
}

// ---------------------------------------------------------------------------
// find_memory — resolve a name/hex-prefix/id to a file (display path)
// ---------------------------------------------------------------------------

function findMemory(ctx: Ctx, id: string): string {
  // Hex id (4-8 char prefix): match basenames containing `_<id>`.
  if (/^[0-9a-f]{4,8}$/.test(id)) {
    const matches: string[] = [];
    for (const p of listMdPaths(ctx)) {
      const b = path.basename(p, ".md");
      if (b.includes(`_${id}`)) {
        matches.push(b);
        if (matches.length >= 2) break; // head -2
      }
    }
    if (matches.length === 1) return memPath(ctx, `${matches[0]}.md`);
    if (matches.length > 1) die(`Ambiguous: '${id}' matches multiple memories`);
  }

  // Exact filename match.
  const exact = memPath(ctx, `${id}.md`);
  try {
    if (fs.statSync(fsResolve(ctx, exact)).isFile()) return exact;
  } catch {
    /* not a file */
  }

  die(`Memory not found: ${id} (use hex ID prefix from 'mem list')`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Strip trailing newlines exactly as `$(...)` command substitution does. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/** PORT-NOTE (sync 2e39a3f, df5e449 #157 + 8497e08): the stored summary is the
 *  FIRST NON-BLANK line (`sed '/^[[:space:]]*$/d' | sed -n 1p | cut -c1-80`),
 *  80 CHARS — a body that opens with blank lines used to store a blank summary,
 *  and edit counted BYTES (`head -c 80`) where add counted chars. Both now share
 *  this. (The Bash drains the pipe so a writer can't SIGPIPE; no TS analogue.) */
function summaryOf(text: string): string {
  const first = text.split("\n").find((l) => !/^[ \t\n\v\f\r]*$/.test(l)) ?? "";
  return [...first].slice(0, 80).join("");
}

/** warn_flag_summary (2e39a3f, #160): stdin text may legitimately start with a
 *  dash, so only warn when the stored summary's first word looks like a flag. */
function warnFlagSummary(ctx: Ctx, summary: string): void {
  const word = (summary.replace(/^[ \t\n\v\f\r]+/, "").split(/[ \t\n\v\f\r]/, 1)[0] ?? "");
  if (/^-{1,2}[A-Za-z]/.test(word)) {
    ctx.io.stderr(`mem: warning: the first line looks like a command flag (${word}); storing the text anyway\n`);
  }
}

const hasContent = (t: string): boolean => /[^ \t\n\v\f\r]/.test(t);

/** `text=$(mem_redact "$text") || die "<outer>"` — the inner die's own line comes first. */
function redactOrDie(ctx: Ctx, text: string, outer: string): string {
  try {
    return memRedact(text, ctx.io.env);
  } catch (e) {
    if (e instanceof MemRedactError) {
      ctx.io.stderr(`mem: error: ${e.message}\n`);
      die(outer);
    }
    throw e;
  }
}

/** `mem add [--type TYPE] [--until YYYY-MM-DD] <text>` (1c: 130796a for
 *  `--until`) — `until` dates a todo; the wake prompt (lane B,
 *  thinkers/_lib/common.sh) drops it from the active-goals section past that
 *  date. `""` when not given — no `until:` line is written (matches Bash's
 *  `${MEM_UNTIL:+\nuntil: $MEM_UNTIL}`). */
function actionAdd(ctx: Ctx, args: string[], until: string, schedule = "", tz = ""): void {
  // PORT-NOTE (sync 2e39a3f, 7403b9f): a flag mem add does not know (a
  // `--content` slip, a `-h`) must not become the memory's first word, however
  // many dashes it carries. Text that truly starts with a dash goes on stdin.
  if ((args[0] ?? "").startsWith("-")) {
    die(`add: unknown option '${args[0]}'. mem add takes only --type, --until, --schedule and --tz, then the text:\n` +
      `  mem add [--type TYPE] [--until YYYY-MM-DD] [--schedule "HH:MM ..." [--tz ZONE]] <text>      (or the text on stdin)`);
  }
  let text = args.join(" ");
  // PORT-NOTE (sync 2e39a3f, df5e449): whitespace-only text counts as no text.
  if (!hasContent(text)) {
    text = stripTrailingNewlines(ctx.io.readStdin());
    if (!hasContent(text)) die("No text provided");
  }
  // PORT-NOTE (sync 2e39a3f, 494fda1 #155): credentials are redacted at the write point.
  text = redactOrDie(ctx, text, "Redaction failed; memory not written");

  fs.mkdirSync(fsResolve(ctx, ctx.memDir), { recursive: true });

  const d = ctx.io.now();
  const timestamp = stampTs(d);
  const hex = ctx.io.randomHex(4);
  const slug = slugify(text);
  const filename = `${timestamp}_${hex}_${slug}`;
  const summary = summaryOf(text);
  warnFlagSummary(ctx, summary);
  const created = stampHuman(d);

  const content =
    `---\n` +
    `id: ${hex}\n` +
    `summary: ${summary}\n` +
    `type: ${ctx.memType}\n` +
    `created: ${created}\n` +
    (until !== "" ? `until: ${until}\n` : "") +
    (schedule !== "" ? `schedule: ${schedule}\n` : "") +
    (tz !== "" ? `tz: ${tz}\n` : "") +
    `---\n\n${text}\n`;

  const file = memPath(ctx, `${filename}.md`);
  fs.writeFileSync(fsResolve(ctx, file), content);
  debug(ctx, `Created: ${file}`);
  ctx.io.stdout(`${filename}\n`);
}

/** `head`/`tail -n "$top"` on a non-numeric `MEM_SEARCH_TOP`/`--top` value is
 *  a Bash runtime failure (BSD `head`: "illegal line count -- X", rc 1) — an
 *  OS-utility error string this port does not reproduce byte-for-byte, the
 *  same class of deviation as the `${2:?}` PORT-NOTE further down (exit code
 *  matches; stderr wording doesn't, on a misconfiguration path no Headlong
 *  caller exercises — see PARITY.md). */
function parseTopCount(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) die(`Invalid count: ${raw}`);
  return Number(raw);
}

/** Stage 1 of `mem search` / `mem prefilter` (1c: 766a290, 130796a): score
 *  every memory against the query's terms and keep the best `top`, best
 *  first. `[]` when the query has no terms (all short/stopwords) or none
 *  match any file — callers decide the fallback (766a290: `mem search` falls
 *  back to the newest files; `mem prefilter` — 130796a — does not). */
function memPrefilterCandidates(ctx: Ctx, query: string, top: number, files: string[]): string[] {
  const terms = extractPrefilterTerms(query);
  if (terms.length === 0) return [];
  const withContent = files.map((f) => ({ name: f, content: fs.readFileSync(fsResolve(ctx, f)) }));
  const scored = scorePrefilterCandidates(withContent, terms);
  return headN(
    scored.map((s) => s.name),
    top,
  );
}

/** `mem prefilter <query> [--top N]` (1c: 130796a) — the candidate paths
 *  stage 1 of a search would hand the model, best first, no model call. */
function actionPrefilter(ctx: Ctx, args: string[]): number {
  let topRaw = ctx.searchTop;
  const queryParts: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--top") {
      topRaw = required(args[i + 1], "--top requires N");
      i += 2;
    } else {
      queryParts.push(args[i]!);
      i += 1;
    }
  }
  const query = queryParts.join(" ");
  if (query === "") die("Usage: mem prefilter <query> [--top N]");

  const files = listMdPaths(ctx);
  if (files.length === 0) return 0; // `ls … >/dev/null 2>&1 || return 0`

  const top = parseTopCount(topRaw);
  for (const c of memPrefilterCandidates(ctx, query, top, files)) ctx.io.stdout(`${c}\n`);
  return 0;
}

function actionSearch(ctx: Ctx, query: string): number {
  const files = listMdPaths(ctx);
  // PORT-NOTE (1c: 766a290): Bash's unguarded `count=$(ls *.md|…)` pipeline
  // used to fail under `set -e`+pipefail on an empty store, so this branch
  // was dead code (rc 1, no output). 766a290 added `|| count=0`, so the
  // real "No memories stored." branch now runs — reproduced here.
  if (files.length === 0) {
    ctx.io.stderr("No memories stored.\n");
    return 0;
  }

  const top = parseTopCount(ctx.searchTop);
  let candidates = memPrefilterCandidates(ctx, query, top, files);
  // No term overlap at all: the newest files are the best guess (766a290).
  if (candidates.length === 0) candidates = tailN(files, top);

  let memories = "";
  for (const f of candidates) {
    let content: string;
    try {
      content = fs.readFileSync(fsResolve(ctx, f), "utf8"); // `[[ -f "$f" ]] || continue`
    } catch {
      continue;
    }
    memories += `=== ${path.basename(f)} ===\n${stripTrailingNewlines(content)}\n\n`;
  }

  // Stage 2: the model ranks the candidates (766a290). Output cap stays far
  // above what the answer needs — a reasoning model spends output tokens
  // thinking before it answers, and comes back empty when the cap is tight.
  const stdinText = `Search these memories for: ${query}\n\n${memories}`;
  const args = [
    ...(ctx.fastModel ? ["-m", ctx.fastModel] : []),
    "-t",
    ctx.searchMaxTokens,
    "-s",
    SEARCH_SYSTEM_PROMPT,
  ];
  return ctx.io.runLlm(args, stdinText, ctx.searchHeartbeatS, ctx.searchTimeoutS);
}

interface ListOpts {
  limit: number;
  short: boolean;
  filterType: string;
  before: string;
  after: string;
}

function actionList(ctx: Ctx, args: string[]): number {
  const opts: ListOpts = { limit: 0, short: false, filterType: "", before: "", after: "" };
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-s" || a === "--short") {
      opts.short = true;
      i += 1;
    } else if (a === "--type") {
      opts.filterType = required(args[i + 1], "--type requires a value");
      i += 2;
    } else if (a === "--before") {
      opts.before = required(args[i + 1], "--before requires a date (YYYY-MM-DD)");
      i += 2;
    } else if (a === "--after") {
      opts.after = required(args[i + 1], "--after requires a date (YYYY-MM-DD)");
      i += 2;
    } else if (/^[0-9]/.test(a)) {
      const n = Number(a);
      opts.limit = Number.isFinite(n) ? n : 0;
      i += 1;
    } else {
      die(`Unknown list option: ${a}`);
    }
  }

  let files = listMdPaths(ctx);
  if (files.length === 0) {
    ctx.io.stderr("No memories stored.\n");
    return 0;
  }
  if (opts.limit > 0) files = files.slice(-opts.limit); // tail -n limit

  const c = ctx.colors;
  for (const f of files) {
    const content = fs.readFileSync(fsResolve(ctx, f), "utf8");
    const pf = parseFilename(path.basename(f, ".md"));
    const mtype = frontmatterField(content, "type") || DEFAULT_TYPE;

    if (opts.filterType && mtype !== opts.filterType) continue;

    const fileDate = pf.ts.slice(0, 10); // YYYY-MM-DD
    if (opts.before && fileDate > opts.before) continue; // keep on-or-before
    if (opts.after && fileDate < opts.after) continue; // keep on-or-after

    const displayTs = `${pf.ts.slice(0, 10)} ${pf.ts.slice(11, 13)}:${pf.ts.slice(14, 16)}`;

    if (opts.short) {
      const shortId = pf.id || "--------";
      const summary = frontmatterField(content, "summary") || pf.slug;
      ctx.io.stdout(`${displayTs}  ${shortId}  ${`[${mtype}]`.padEnd(12)} ${summary}\n`);
    } else {
      const idDisplay = pf.id
        ? `${c.id}${pf.id}${c.reset}`
        : `${c.dim}--------${c.reset}`;
      ctx.io.stdout(`${idDisplay}  ${displayTs}  ${c.type}[${mtype}]${c.reset}\n`);
      const summary = frontmatterField(content, "summary");
      if (summary) ctx.io.stdout(`    ${summary}\n`);
      ctx.io.stdout(`    ${c.dim}${f}${c.reset}\n`);
    }
  }
  return 0;
}

/** Exit status of `ls` for a path it cannot access: GNU coreutils (Linux) 2, BSD/macOS 1. */
export const LS_CANNOT_ACCESS_RC = process.platform === "linux" ? 2 : 1;

function actionTypes(ctx: Ctx): number {
  const files = listMdPaths(ctx);
  // QUIRK: on an empty or missing store the unmatched glob reaches `ls` as a
  // literal path, `ls` fails, and `set -o pipefail` makes that the pipeline's
  // (and the script's) status: silent, no output. The status is `ls`'s own:
  // GNU coreutils exits 2 ("cannot access"), BSD/macOS ls exits 1. Replicated
  // per platform, not fixed. (Was a flat 1, which diverged on Linux.)
  if (files.length === 0) return LS_CANNOT_ACCESS_RC;

  const counts = new Map<string, number>();
  for (const f of files) {
    const t = frontmatterField(fs.readFileSync(fsResolve(ctx, f), "utf8"), "type");
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // `sort | uniq -c | sort -rn`: count desc; ties DESCENDING type order.
  //
  // PORT-NOTE (bug #44): `sort -rn` compares whole lines — the leading
  // numeric count first, then (for a tie) falls back to a plain string
  // compare of the rest of the line, with `-r` reversing THAT comparison
  // too. Verified directly: `printf '1 goal\n1 note\n1 apple\n' | sort -rn`
  // -> note, goal, apple (reverse-alphabetical), regardless of input
  // order — not "insertion order reversed". So ties sort by type
  // DESCENDING, not ascending. See PARITY.md's mem row and
  // parity/fuzz/findings/mem-1.md.
  const rows = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0;
  });
  for (const [type, count] of rows) {
    ctx.io.stdout(`${String(count).padStart(4)}  ${type}\n`);
  }
  return 0;
}

function actionShow(ctx: Ctx, name: string): void {
  const file = findMemory(ctx, name);
  ctx.io.stdout(fs.readFileSync(fsResolve(ctx, file), "utf8"));
}

function actionForget(ctx: Ctx, name: string): void {
  const file = findMemory(ctx, name);
  debug(ctx, `Deleting: ${file}`);
  fs.rmSync(fsResolve(ctx, file));
  ctx.io.stderr(`Forgotten: ${path.basename(file, ".md")}\n`);
}

function actionEdit(ctx: Ctx, name: string, rest: string[]): void {
  let file = findMemory(ctx, name);

  // Leading --slug flag(s) (the Bash loops: last wins).
  let slugArg = "";
  let i = 0;
  while (rest[i] === "--slug") {
    slugArg = required(rest[i + 1], "--slug requires TEXT");
    i += 2;
  }
  const args = rest.slice(i);

  // PORT-NOTE (sync 2e39a3f, aacd505): a flag mem edit does not know must not
  // become the body (`mem edit <id> --apply <body>` silently stored `--apply`).
  if ((args[0] ?? "").startsWith("-")) {
    die(`edit: unknown option '${args[0]}'. mem edit takes only --slug, then the text:\n` +
      `  mem edit <id> [--slug SLUG] <text>      (or the text on stdin)`);
  }

  let text = args.join(" ");
  if (!hasContent(text)) {
    text = stripTrailingNewlines(ctx.io.readStdin());
    if (!hasContent(text)) die("No text provided");
  }
  text = redactOrDie(ctx, text, "Redaction failed; memory not written");
  if (slugArg !== "") slugArg = redactOrDie(ctx, slugArg, "Slug redaction failed; memory not written");

  const now = stampHuman(ctx.io.now());
  const content = fs.readFileSync(fsResolve(ctx, file), "utf8");

  const summary = summaryOf(text);
  warnFlagSummary(ctx, summary);
  const type = frontmatterField(content, "type");
  const created = frontmatterField(content, "created");
  const id = frontmatterField(content, "id");
  // PORT-NOTE (1c: 51a8585): `until:` (mem add --until) rides through an
  // edit — a todo shortlist appended to during the day must still expire
  // that night. Edit used to rebuild frontmatter from a fixed field set and
  // silently dropped it.
  const until = frontmatterField(content, "until");

  // Build the updated: block from existing frontmatter.
  const block = frontmatterBlock(content);
  const existingUpdated = block
    .filter((l) => l.startsWith("updated:"))
    .map((l) => l.slice("updated:".length).replace(/^[ \t]*/, ""))
    .join("\n");
  const existingList = block.filter((l) => l.startsWith("  - ")).join("\n");

  let updatedBlock: string;
  if (existingList !== "") {
    updatedBlock = `updated:\n${existingList}\n  - ${now}`;
  } else if (existingUpdated !== "") {
    updatedBlock = `updated:\n  - ${existingUpdated}\n  - ${now}`;
  } else {
    updatedBlock = `updated: ${now}`;
  }

  const idLine = id !== "" ? `id: ${id}\n` : "";
  let untilLine = until !== "" ? `until: ${until}\n` : "";
  // PORT-NOTE (sync 2e39a3f, design/scheduled_goals.md): `schedule:` and `tz:` ride through an edit like `until:`.
  for (const k of ["schedule", "tz"]) {
    const v = frontmatterField(content, k);
    if (v !== "") untilLine += `${k}: ${v}\n`;
  }
  const rebuilt =
    `---\n` +
    idLine +
    `summary: ${summary}\n` +
    `type: ${type}\n` +
    `created: ${created}\n` +
    untilLine +
    `${updatedBlock}\n` +
    `---\n\n${text}\n`;
  fs.writeFileSync(fsResolve(ctx, file), rebuilt);

  // Auto-update the slug in the filename (always re-slugified).
  const pf = parseFilename(path.basename(file, ".md"));
  const newSlug = slugArg !== "" ? slugify(slugArg) : slugify(text);
  if (newSlug !== "" && newSlug !== pf.slug) {
    const newFile = memPath(ctx, `${pf.ts}_${pf.id}_${newSlug}.md`);
    fs.renameSync(fsResolve(ctx, file), fsResolve(ctx, newFile));
    file = newFile;
  }

  debug(ctx, `Updated: ${file}`);
  ctx.io.stderr(`Updated: ${path.basename(file, ".md")}\n`);
}

// PORT-NOTE (deliberate deviation): Bash reads a flag's value with
// `${2:?message}`, whose missing-value error is `<script>: line N: 2: <message>`
// on stderr (exit 1). That text embeds the script's absolute path and a Bash
// line number — irreproducible from TS and brittle to pin. We keep the port's
// clean `mem: error: <message>` instead; exit code (1), stdout (empty), and
// on-disk state all match Bash. Covers the flag-missing-value misuse paths:
// --dir, add --type, list --type|--before|--after, edit --slug. See PARITY.md.
// Bash's colon form `${2:?msg}` fires on null OR empty, so an empty-string flag
// value (`--type ""`) dies exactly as a missing one does (same rc/stdout/state).
function required(v: string | undefined, msg: string): string {
  if (v === undefined || v === "") die(msg);
  return v;
}

// ---------------------------------------------------------------------------
// .memrc + config resolution (flags > env > rc file)
// ---------------------------------------------------------------------------

/** Parse `[export ]KEY=VALUE` lines from a `.memrc`; ignores blanks, comments,
 *  and any line that is not a simple assignment. One layer of matched quotes
 *  is stripped from the value. */
export function parseMemrc(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
    if (q) v = q[1]!;
    out.set(m[1]!, v);
  }
  return out;
}

/** Resolve one of the `MEM_SEARCH_*` inline `${VAR:-default}` reads (1c:
 *  766a290, 69fddc6). Unlike MEM_DIR/MEM_TYPE these are never assigned
 *  earlier in the script, so there is no separate "initial default, then
 *  final override" pass — Bash evaluates `${VAR:-default}` once, at the
 *  point of use, against whatever the `.memrc` `_pre_env` dance (see the
 *  file header) left in the environment. Net effect, verified directly
 *  against Bash: env wins whenever it is SET (even to `""`, which — like
 *  `:-` — falls through to `dflt` rather than to `.memrc`); otherwise a
 *  `.memrc` value applies (also falling through to `dflt` if empty);
 *  otherwise `dflt`. `hasMemrc` gates whether `.memrc` is consulted at all
 *  (matches `[[ -f ".memrc" ]]`). */
function resolveMemSearchVar(
  env: Record<string, string | undefined>,
  rc: Map<string, string> | undefined,
  name: string,
  dflt: string,
): string {
  const envVal = env[name];
  if (envVal !== undefined) return envVal !== "" ? envVal : dflt;
  const rcVal = rc?.get(name);
  if (rcVal !== undefined) return rcVal !== "" ? rcVal : dflt;
  return dflt;
}

/** Resolve MEM_DIR / MEM_TYPE / SHELLM_FAST_MODEL / MEM_SEARCH_TOP /
 *  MEM_SEARCH_MAX_TOKENS honouring the Bash precedence and its
 *  `.memrc`-gated quirks (see file header). */
function resolveConfig(io: MemIO): {
  memDir: string;
  memType: string;
  fastModel: string;
  searchTop: string;
  searchMaxTokens: string;
  searchHeartbeatS: string;
  /** `MEM_SEARCH_TIMEOUT_S`, normalized: digits only, junk → "300". */
  searchTimeoutS: string;
} {
  const env = io.env;
  // MEM_DIR default reads env unconditionally (`${MEM_DIR:-./.memories}`).
  let memDir = env["MEM_DIR"] && env["MEM_DIR"] !== "" ? env["MEM_DIR"] : DEFAULT_MEM_DIR;
  let memType = DEFAULT_TYPE; // Bash `MEM_TYPE="memory"`; env MEM_TYPE never supplies a value (see below)
  let fastModel = env["SHELLM_FAST_MODEL"] ?? "";

  const memrcPath = path.resolve(io.cwd, ".memrc");
  let hasMemrc = false;
  try {
    hasMemrc = fs.statSync(memrcPath).isFile();
  } catch {
    /* no .memrc */
  }

  let rc: Map<string, string> | undefined;
  if (hasMemrc) {
    try {
      rc = parseMemrc(fs.readFileSync(memrcPath, "utf8"));
    } catch {
      rc = new Map();
    }
    // source .memrc: rc assignments apply...
    if (rc.has("MEM_DIR")) memDir = rc.get("MEM_DIR")!;
    if (rc.has("MEM_TYPE")) memType = rc.get("MEM_TYPE")!;
    if (rc.has("SHELLM_FAST_MODEL")) fastModel = rc.get("SHELLM_FAST_MODEL")!; // rc beats env (non-MEM_)
    // ...then Bash's `_pre_env` snapshot of exported MEM_* is re-applied over the
    // top. MEM_DIR re-applies its env VALUE (env beats rc). MEM_TYPE was
    // snapshotted AFTER `MEM_TYPE="memory"` ran, so it re-applies "memory": a set
    // env MEM_TYPE discards its own value and clobbers any rc MEM_TYPE.
    if (env["MEM_DIR"] !== undefined) memDir = env["MEM_DIR"];
    if (env["MEM_TYPE"] !== undefined) memType = DEFAULT_TYPE;
  }

  const searchTop = resolveMemSearchVar(env, rc, "MEM_SEARCH_TOP", DEFAULT_SEARCH_TOP);
  const searchMaxTokens = resolveMemSearchVar(
    env,
    rc,
    "MEM_SEARCH_MAX_TOKENS",
    DEFAULT_SEARCH_MAX_TOKENS,
  );
  const searchHeartbeatS = resolveMemSearchVar(
    env,
    rc,
    "MEM_SEARCH_HEARTBEAT_S",
    DEFAULT_SEARCH_HEARTBEAT_S,
  );

  // PORT-NOTE (sync 2e39a3f, 2a63d92): `t="${MEM_SEARCH_TIMEOUT_S:-300}"; [[ "$t" =~ ^[0-9]+$ ]] || t=300`.
  const rawTimeout = resolveMemSearchVar(env, rc, "MEM_SEARCH_TIMEOUT_S", "300");
  const searchTimeoutS = /^[0-9]+$/.test(rawTimeout) ? rawTimeout : "300";

  return { memDir, memType, fastModel, searchTop, searchMaxTokens, searchHeartbeatS, searchTimeoutS };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// PORT-NOTE (1c: 766a290, 69fddc6, 130796a): usage/environment text updated
// to match upstream-next byte-for-byte (`mem --help`), including its column
// alignment quirks (the `mem prefilter` row is one character wider than the
// others, matching Bash's raw heredoc).
const USAGE = `mem — CLI memory store

Usage:
  mem add [--type TYPE] [--until YYYY-MM-DD] [--schedule "HH:MM ..." [--tz ZONE]] <text>
                                 Add a memory (or pipe text via stdin); --until
                                 dates a todo, and the wake prompt drops it after
  mem prefilter <query> [--top N] The candidate files a search would read, best
                                 first, no model call
  mem search <query>             Semantic search: a local keyword score picks
                                 the top MEM_SEARCH_TOP memories, the model ranks them
  mem list [options] [N]         List memories (last N if given)
  mem types                      List memory types with counts
  mem show <id>                  Show a memory's full contents
  mem forget <id>                Delete a memory by hex ID
  mem edit <id> [--slug SLUG] <text>  Update body (or pipe via stdin)

Storage:
  Add/edit redact known credential values and formats, private-key blocks, and
  common card numbers with valid checksums before saving. Summaries and filenames
  (including --slug) use redacted text. Incomplete private-key blocks fail without
  changing the memory. Detection is best effort; do not use mem as a secret store.
  Pipe sensitive or large bodies via stdin so they do not appear in process argv.

List options:
  -s, --short        Concise one-line-per-memory view
  --type TYPE        Filter by type (e.g. --type fact)
  --before DATE      Show memories on or before DATE (YYYY-MM-DD)
  --after DATE       Show memories on or after DATE (YYYY-MM-DD)

Types:
  todo, objective, value, belief, fact, preference, note (default: memory)

Options:
  --dir DIR          Override memory directory (default: ./.memories)
  -v, --verbose      Verbose/debug mode
  -h, --help         Show help
  --version          Show version

Environment:
  MEM_DIR   Override memory directory (default: ./.memories)
  MEM_SEARCH_TOP         Candidates the keyword prefilter sends the model (40)
  MEM_SEARCH_MAX_TOKENS  Output cap for the search call (16000; a reasoning
                         model thinks against it, so keep it roomy)
  MEM_SEARCH_HEARTBEAT_S Seconds between "waiting" lines on stderr while the
                         model works (10; 0 disables)
  MEM_SEARCH_TIMEOUT_S    Total seconds stage 2 may run before giving up (300;
                         0 waits forever; junk falls back to 300). A timed-out
                         search prints one line to stderr and exits 124.
  SHELLM_FAST_MODEL      Cheap model class for the search call
`;

// ---------------------------------------------------------------------------
// Entry point — parse global flags, dispatch subcommand. Returns exit code.
// ---------------------------------------------------------------------------

export function runMem(argv: string[], io: MemIO): number {
  const cfg = resolveConfig(io);
  const ctx: Ctx = {
    io,
    memDir: cfg.memDir,
    memType: cfg.memType,
    fastModel: cfg.fastModel,
    searchTop: cfg.searchTop,
    searchMaxTokens: cfg.searchMaxTokens,
    searchHeartbeatS: cfg.searchHeartbeatS,
    searchTimeoutS: cfg.searchTimeoutS,
    verbose: false,
    colors: io.isTTY
      ? { id: "\x1b[1;33m", type: "\x1b[36m", dim: "\x1b[2m", reset: "\x1b[0m" }
      : { id: "", type: "", dim: "", reset: "" },
  };

  const args = argv.slice();

  try {
    // Global flags (must precede the subcommand; loop breaks on the first non-flag).
    while (args.length > 0) {
      const a = args[0]!;
      if (a === "-h" || a === "--help") {
        io.stdout(USAGE);
        return 0;
      } else if (a === "--version") {
        io.stdout(`mem ${MEM_VERSION}\n`);
        return 0;
      } else if (a === "-v" || a === "--verbose") {
        ctx.verbose = true;
        args.shift();
      } else if (a === "--dir") {
        ctx.memDir = required(args[1], "--dir requires a path");
        args.splice(0, 2);
      } else {
        break;
      }
    }

    const cmd = args.shift() ?? "";

    switch (cmd) {
      case "add": {
        // Leading --type / --until flags, any order, last wins (130796a).
        let until = "";
        let schedule = "";
        let tz = "";
        while (args[0] === "--type" || args[0] === "--until" || args[0] === "--schedule" || args[0] === "--tz") {
          if (args[0] === "--type") {
            ctx.memType = required(args[1], "--type requires a value");
          } else if (args[0] === "--until") {
            until = required(args[1], "--until requires YYYY-MM-DD");
            if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) die("--until takes a date, YYYY-MM-DD");
          } else if (args[0] === "--schedule") {
            schedule = required(args[1], '--schedule requires local times, e.g. "09:00 17:00"');
            if (!/^([0-2][0-9]:[0-5][0-9] ?)+$/.test(schedule)) die('--schedule takes 24h times, e.g. "09:00 17:00"');
          } else {
            tz = required(args[1], "--tz requires a zone, e.g. America/Los_Angeles");
          }
          args.splice(0, 2);
        }
        actionAdd(ctx, args, until, schedule, tz);
        return 0;
      }
      case "search": {
        if (args.length < 1) die("Usage: mem search <query>");
        return actionSearch(ctx, args.join(" "));
      }
      case "prefilter":
        return actionPrefilter(ctx, args);
      case "list":
        return actionList(ctx, args);
      case "types":
        return actionTypes(ctx);
      case "show": {
        if (args.length < 1) die("Usage: mem show <id>");
        actionShow(ctx, args[0]!);
        return 0;
      }
      case "forget": {
        if (args.length < 1) die("Usage: mem forget <id>");
        actionForget(ctx, args[0]!);
        return 0;
      }
      case "edit": {
        if (args.length < 1) die("Usage: mem edit <id> [--slug SLUG] [text]");
        const name = args.shift()!;
        actionEdit(ctx, name, args);
        return 0;
      }
      case "":
        io.stdout(USAGE);
        return 0;
      default:
        die(`Unknown command: ${cmd} (try mem --help)`);
    }
  } catch (e) {
    if (e instanceof MemExit) {
      if (e.dieMsg !== undefined) io.stderr(`mem: error: ${e.dieMsg}\n`);
      return e.code;
    }
    throw e;
  }
}
