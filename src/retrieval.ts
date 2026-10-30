// retrieval.ts — the RETRIEVAL thinker: passive, involuntary memory recall with
// NO LLM. Faithful port of thinkers/retrieval/{step,build-index.sh,stopwords}.
//
// Behaviour is the blueprint, not the Bash text: the sed/awk/tr/sort/grep
// plumbing becomes native string + fs code, but the OBSERVABLE surface is held
// exact — the index.tsv bytes, the seen ring, the verbatim observation content,
// the fields (retrieved_mem, trigger_step), and "every no-op path exits 0
// silently". The memory reader (src/mem.ts readMemoryFiles) and the trajectory
// append (trajCore.appendStep: step_id, ts, run_id iff SHELLM_RUN_STEP_ID) are
// injected through RetrievalIO — the shim and the engine wire the real ones —
// never reimplemented here. This module stays a leaf (type-only sibling
// imports) so bin/retrieval-step.mjs can run it from source like bin/mem.mjs.
//
// Per wake (stdin trigger JSON → `.content`, `.source`, `.step_id`):
//   1. _require_env: IDENTITY_DIR/TRAJ_DIR/TRAJ_ID/MEM_DIR unset → die, exit 1
//      (+ its `mkdir -p MEM_DIR SKILLS_DIR SKILLS_KERNEL_DIR TRAJ_DIR` side effect).
//   2. INDEX = $RETRIEVAL_INDEX or <identity>/retrieval/index.tsv; SEEN beside it.
//   3. Empty stdin, empty content, or source == "retrieval" → exit 0.
//   4. No memories (`ls -t $MEM_DIR/*.md`) → exit 0. Rebuild the index iff it is
//      missing/empty or a memory is NEWER than it; a rebuild failure → exit 0.
//   5. Tokenize the content like the index; no words → exit 0. Score = number of
//      DISTINCT step words each memory's rows cover; best one; below
//      RETRIEVAL_MIN_HITS (2) → exit 0.
//   6. Seen ring: mid already in SEEN → exit 0; else SEEN := last (RETRIEVAL_SEEN-1)
//      lines + mid, written BEFORE the append (seen.tmp + mv).
//   7. Append {type:"observation", content, source:"retrieval", retrieved_mem,
//      trigger_step?}. Exit 0. No stdout on any path.
//
// REPLICATED quirks (SPEC-retrieval-thinker §5):
//   - index tokens = body lines PLUS the `summary:` line itself, so "summary" is a
//     token of every memory; the rest of the frontmatter is excluded; `mid` = the
//     first `id:` line ANYWHERE in the file (sed | head -1), skipped when absent.
//     (Hence not frontmatterField: that strips quotes and is block-scoped.)
//   - rebuild trigger is "newest memory mtime > index mtime" only: a `mem forget`
//     does NOT rebuild, so a deleted memory's stale rows can still surface
//     (stale-index-after-forget). Replicated on purpose; a test pins it.
//   - digits are words ("2026"), apostrophes split ("don't" → "don"), exactly one
//     memory surfaces per wake, seen is updated before the append even if the
//     append then fails.
//
// PORT-NOTE (deliberate, documented in PARITY.md):
//   - TIE-BREAK among equal-hit memories. Bash: `awk … | sort -rn | head -1`, i.e.
//     the last-resort whole-line byte comparison of `hits\tmid\tsummary`, reversed
//     by -r (awk's `for (m in n)` order is otherwise unspecified). The port PINS the
//     rule: highest hits, then greatest id, then greatest summary, all by UTF-8
//     bytes — identical to GNU/BSD `sort -rn` without `-s` (verified on macOS), and
//     deterministic regardless of awk hash order, `sort -s`, or locale collation.
//   - LOCALE. The tokenizer is the C-locale/byte pipeline the spec describes: only
//     A-Z lowercase, every byte outside [A-Za-z0-9] splits, keep [a-z0-9]{3,}. Under
//     a UTF-8 locale Bash keeps "café" as one token and then drops it whole; the port
//     yields "caf". Only words with non-ASCII letters adjacent to ASCII differ.
//   - `awk -v s="$summary"` interprets backslash escapes (a literal `\t` in a
//     summary becomes a tab in the index row). The port keeps the bytes verbatim.
//   - mtime: the port compares mtimeMs; Bash `-nt`/`ls -t` resolution is bash-
//     version dependent (1 s on bash 3.2, sub-second on bash 5).
//   - RETRIEVAL_SEMANTIC=1: the `mem search` seam is injected; the shim runs it with
//     a native 60 s timeout instead of GNU `timeout` (absent on stock macOS, where
//     the Bash silently yields ""); the suffix is cut at 300 code points.
//   - `_require_env`'s `.env` fallbacks are not loaded (they only feed the model/key
//     of semantic mode); its mkdir -p side effect IS replicated.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subscription } from "./dispatcher.ts";

export const THINKER_NAME = "retrieval";

/** thinkers/retrieval/subscriptions.jsonl, verbatim: types + trigger_self:false, no watchdog. */
export const RETRIEVAL_SUBSCRIPTION: Subscription = {
  types: ["thought", "message", "observation"],
  triggerSelf: false,
  watchdogSecs: 0,
};

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "retrieval");

/** The 110-word stopword list (assets/retrieval/stopwords, copied verbatim). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  fs
    .readFileSync(path.join(ASSETS, "stopwords"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
);

/** Environment the step reads (process.env in the shim, an explicit record in the engine). */
export type RetrievalEnv = Record<string, string | undefined>;

/** `"$MEM_DIR"/*.md` with raw contents — src/mem.ts readMemoryFiles is the real one. */
export type MemoryFileReader = (memDir: string) => { content: string }[];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `LC_ALL=C sort` order: UTF-8 byte comparison. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The word pipeline shared by the index and the step (step:53-54,
 * build-index.sh:24-25): `tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '\n'
 * | grep -E '^[a-z0-9]{3,}$' | grep -vxF -f stopwords | sort -u`, C locale.
 * Returns the distinct words, byte-sorted.
 */
export function tokenize(text: string): string[] {
  const lowered = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const out = new Set<string>();
  for (const tok of lowered.split(/[^a-z0-9]+/)) {
    if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return [...out].sort(byteCompare);
}

/** `sed -n 's/^KEY:[[:space:]]*//p' FILE | head -1` — first `KEY:` line anywhere. */
function firstFieldLine(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t\\v\\f\\r]*(.*)$`);
  for (const line of content.split("\n")) {
    const m = re.exec(line);
    if (m) return m[1]!;
  }
  return undefined;
}

/**
 * The lines the index tokenizes (build-index.sh:23): body lines plus the
 * `summary:` line; the rest of a leading frontmatter block is skipped.
 * awk 'NR==1 && /^---$/ {f=1; next} f && /^---$/ {f=0; next} !f || /^summary:/'
 */
export function indexTokenSource(content: string): string {
  const out: string[] = [];
  let inFront = false;
  content.split("\n").forEach((line, i) => {
    if (i === 0 && line === "---") {
      inFront = true;
      return;
    }
    if (inFront && line === "---") {
      inFront = false;
      return;
    }
    if (!inFront || line.startsWith("summary:")) out.push(line);
  });
  return out.join("\n");
}

export interface IndexRow {
  word: string;
  mid: string;
  summary: string;
}

/** One memory file → its `word\tmid\tsummary` rows (build-index.sh:17-27). `[]` without an `id:` line. */
export function indexRowsFor(content: string): IndexRow[] {
  const mid = firstFieldLine(content, "id");
  if (mid === undefined || mid === "") return [];
  const summary = (firstFieldLine(content, "summary") ?? "").replace(/\t/g, " ");
  return tokenize(indexTokenSource(content)).map((word) => ({ word, mid, summary }));
}

/** The index.tsv text for a set of memory contents: rows `sort -u`'d (byte order), one per line. */
export function renderIndex(contents: string[]): string {
  const lines = new Set<string>();
  for (const c of contents) {
    for (const r of indexRowsFor(c)) lines.add(`${r.word}\t${r.mid}\t${r.summary}`);
  }
  const sorted = [...lines].sort(byteCompare);
  return sorted.length === 0 ? "" : sorted.join("\n") + "\n";
}

/** `wc -l` of an index text. */
export function countRows(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

/**
 * build-index.sh as a function: write the word index over `memDir/*.md` to
 * `outFile` (mkdir -p its dir) and return the row count the script prints.
 */
export function buildIndex(memDir: string, outFile: string, readFiles: MemoryFileReader): number {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const text = renderIndex(readFiles(memDir).map((f) => f.content));
  fs.writeFileSync(outFile, text);
  return countRows(text);
}

/** Parse index.tsv rows as `awk -F'\t'` sees them ($1 word, $2 mid, $3 summary). */
export function parseIndex(text: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const f = line.split("\t");
    rows.push({ word: f[0] ?? "", mid: f[1] ?? "", summary: f[2] ?? "" });
  }
  return rows;
}

export interface Best {
  hits: number;
  mid: string;
  summary: string;
}

/**
 * step:56-58 — per mid, the number of index rows whose word is in the step's
 * word set (= distinct shared words, one row per (word, mid)); the best one.
 * PORT-NOTE tie-break: highest hits, then greatest `mid\tsummary` by bytes —
 * exactly what `sort -rn | head -1` yields on the awk lines (see file header).
 */
export function score(words: string[], rows: IndexRow[]): Best | undefined {
  const w = new Set(words);
  const n = new Map<string, number>();
  const s = new Map<string, string>();
  for (const r of rows) {
    if (!w.has(r.word)) continue;
    n.set(r.mid, (n.get(r.mid) ?? 0) + 1);
    s.set(r.mid, r.summary); // last row wins, as awk's s[$2]=$3
  }
  let best: Best | undefined;
  let bestLine = "";
  for (const [mid, hits] of n) {
    const summary = s.get(mid) ?? "";
    const line = `${hits}\t${mid}\t${summary}`;
    if (!best || hits > best.hits || (hits === best.hits && byteCompare(line, bestLine) > 0)) {
      best = { hits, mid, summary };
      bestLine = line;
    }
  }
  return best;
}

/** The seen ring's lines (oldest first); `[]` when the file is absent. */
export function readSeen(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * step:64 — `{ tail -n $((RETRIEVAL_SEEN - 1)) SEEN; printf '%s\n' mid; }`.
 * `tail -n 0` prints nothing; a NEGATIVE count (`tail -n -k`) is "last k lines",
 * so the kept tail is |ringSize-1| lines.
 */
export function nextSeen(existing: string[], mid: string, ringSize: number): string[] {
  const keep = Math.abs(ringSize - 1);
  const tail = keep === 0 ? [] : existing.slice(-keep);
  return [...tail, mid];
}

/**
 * `jq -r '.FIELD // empty'` as text: null/false/absent → "", strings raw,
 * numbers/true printed, objects/arrays as jq's pretty JSON. Trailing newlines
 * are then stripped as `$(...)` does.
 */
function jqText(v: unknown): string {
  let s: string;
  if (v === undefined || v === null || v === false) s = "";
  else if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else s = JSON.stringify(v, null, 2) ?? "";
  return s.replace(/\n+$/, "");
}

/**
 * A knob read inside Bash arithmetic (`${VAR:-dflt}`): unset/empty → default,
 * a decimal integer → itself, a bare name → 0 (an unset variable lookup),
 * anything else → a syntax error (`undefined`). Non-integer knobs are outside
 * the contract; this only pins what Bash does with them.
 */
function intKnob(v: string | undefined, dflt: number): number | undefined {
  if (v === undefined || v === "") return dflt;
  if (/^[+-]?[0-9]+$/.test(v)) return Number(v);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return 0;
  return undefined;
}

/** `head -3`: everything up to and including the third newline. */
function head3(s: string): string {
  let idx = 0;
  for (let i = 0; i < 3; i++) {
    const j = s.indexOf("\n", idx);
    if (j < 0) return s;
    idx = j + 1;
  }
  return s.slice(0, idx);
}

/** `ls -t "$MEM_DIR"/*.md | head -1` → the newest mtime (ms), or undefined when none. */
function newestMemoryMtime(memDir: string): number | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(memDir);
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  for (const f of names) {
    if (!f.endsWith(".md") || f.startsWith(".")) continue;
    try {
      const ms = fs.statSync(path.join(memDir, f)).mtimeMs;
      if (newest === undefined || ms > newest) newest = ms;
    } catch {
      /* vanished between readdir and stat: ls would have skipped it too */
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export interface RetrievalIO {
  /** `"$MEM_DIR"/*.md` reader — wire src/mem.ts readMemoryFiles. */
  readMemoryFiles: MemoryFileReader;
  /** `traj append`: stamps step_id/ts (+ run_id iff runStepId), returns the step_id. */
  appendStep(record: Record<string, unknown>, opts: { runStepId: string }): string;
  /** `mem search <query>` stdout for RETRIEVAL_SEMANTIC=1; "" on failure. Absent → "". */
  memSearch?: (query: string) => string;
  stderr(s: string): void;
}

export interface RetrievalResult {
  /** The Bash step's exit code: 0 on every no-op path, 1 only on die paths. */
  code: number;
  /** Diagnostic only — which path was taken. Not part of the contract. */
  reason: string;
  observation?: { stepId: string; mid: string; hits: number; content: string };
}

const REQUIRED_ENV = ["IDENTITY_DIR", "TRAJ_DIR", "TRAJ_ID", "MEM_DIR"] as const;

/**
 * Run one retrieval step. `trigger` is the raw stdin text (the shim) or the
 * already-parsed trigger step (the engine); `env` is the process environment
 * or an explicit record. Never throws for the Bash-observable paths.
 */
export function runRetrievalStep(
  trigger: string | Record<string, unknown>,
  env: RetrievalEnv,
  io: RetrievalIO
): RetrievalResult {
  const noop = (reason: string): RetrievalResult => ({ code: 0, reason });

  // _require_env (common.sh:32-63).
  for (const k of REQUIRED_ENV) {
    if (!env[k]) {
      io.stderr(`thinker: error: ${k} not set. Run: identity shell <name>\n`);
      return { code: 1, reason: `${k} not set` };
    }
  }
  const identityDir = env["IDENTITY_DIR"]!;
  const trajDir = env["TRAJ_DIR"]!;
  const memDir = env["MEM_DIR"]!;
  const skillsDir = env["SKILLS_DIR"] || `${identityDir}/skills`;
  const kernelDir = env["SKILLS_KERNEL_DIR"] || `${identityDir}/kernel`;
  try {
    for (const d of [memDir, skillsDir, kernelDir, trajDir]) fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    io.stderr(`mkdir: ${(e as Error).message}\n`);
    return { code: 1, reason: "mkdir failed" };
  }

  const index = env["RETRIEVAL_INDEX"] || `${identityDir}/retrieval/index.tsv`;
  const seenFile = `${path.dirname(index)}/seen`;

  // stdin → trigger fields (step:37-42).
  let obj: unknown;
  if (typeof trigger === "string") {
    const raw = trigger.replace(/\n+$/, "");
    if (raw === "") return noop("empty stdin");
    try {
      obj = JSON.parse(raw);
    } catch {
      return noop("invalid JSON");
    }
  } else {
    obj = trigger;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return noop("trigger is not an object");
  const t = obj as Record<string, unknown>;
  const content = jqText(t["content"]);
  const source = jqText(t["source"]);
  const stepId = jqText(t["step_id"]);
  if (content === "") return noop("empty content");
  if (source === THINKER_NAME) return noop("own source");

  // Memories + index freshness (step:44-49).
  const newest = newestMemoryMtime(memDir);
  if (newest === undefined) return noop("no memories");
  let rebuild = false;
  try {
    const st = fs.statSync(index);
    rebuild = st.size === 0 || newest > st.mtimeMs;
  } catch {
    rebuild = true;
  }
  if (rebuild) {
    try {
      buildIndex(memDir, index, io.readMemoryFiles);
    } catch {
      return noop("index rebuild failed");
    }
  }

  // Words + best memory (step:51-60).
  const words = tokenize(content);
  if (words.length === 0) return noop("no words");
  let indexText = "";
  try {
    indexText = fs.readFileSync(index, "utf8");
  } catch {
    /* awk on a missing index fails → best="" */
  }
  const best = score(words, parseIndex(indexText));
  // PORT-NOTE (bug #45): upstream reads this knob directly into a `[[ ...
  // -ge "${RETRIEVAL_MIN_HITS:-2}" ]]` test (step:60). `${VAR:-2}` only
  // supplies the default when VAR is UNSET/empty; a SET bareword value
  // (e.g. "abc") reaches `-ge`'s arithmetic operand position as-is, where
  // Bash arithmetic treats a bareword as a VARIABLE NAME to look up — and
  // under this script's `set -euo pipefail` (no explicit `-u`, but the
  // interactive nounset-style check on an unresolvable arithmetic operand
  // fires the same way), referencing that nonexistent variable is an
  // UNCAUGHT "unbound variable" error that kills the whole script (exit 1,
  // BEFORE the seen-ring read/write or trajectory append) — unlike a
  // non-identifier non-integer value (e.g. "1.5"), which is a genuine
  // arithmetic SYNTAX error that `[[ ]]` catches locally, treats the test
  // as false, and continues (exit 0; see the `minHits === undefined` noop
  // path below, and PARITY.md's retrieval row for that already-documented
  // deviation). `intKnob` maps a bareword to 0 for RETRIEVAL_SEEN's
  // genuine "unset -> default" call site, so the crash must be detected
  // HERE, at the MIN_HITS-specific call site, before calling it. Verified
  // directly against upstream (parity/fuzz/findings/retrieval-1.md):
  // RETRIEVAL_MIN_HITS=abc against a matching trigger ->
  // "<script>: line 60: abc: unbound variable", exit 1, no traj/seen
  // writes.
  // PORT-NOTE (bug #58): bash's test is a SINGLE `[[ -n "${mid:-}" && "${hits:-0}"
  // -ge "${RETRIEVAL_MIN_HITS:-2}" ]]` — `&&` inside `[[ ]]` short-circuits,
  // so when no candidate matched (`mid` empty) the `-ge`/RETRIEVAL_MIN_HITS
  // side is NEVER evaluated and the bareword crash above cannot happen; bash
  // just falls through to `|| exit 0`. The bareword check used to run
  // UNCONDITIONALLY, before this `!best`/`best.mid === ""` gate — the exact
  // inverse of bash's short-circuit order — so the port crashed even when
  // bash's own `&&` was specifically written to skip the check. Verified
  // directly against upstream (parity/fuzz/findings/retrieval-c2-1.md): a
  // non-matching trigger with RETRIEVAL_MIN_HITS=abc -> bash exit 0, no
  // "unbound variable" text; the check must run AFTER this gate, not before.
  if (!best || best.mid === "") return noop("no candidate memory");
  const minHitsRaw = env["RETRIEVAL_MIN_HITS"];
  if (minHitsRaw !== undefined && minHitsRaw !== "" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(minHitsRaw)) {
    io.stderr(`retrieval: RETRIEVAL_MIN_HITS: unbound variable\n`);
    return { code: 1, reason: "RETRIEVAL_MIN_HITS is a bareword (bash: unbound variable)" };
  }
  const minHits = intKnob(minHitsRaw, 2);
  if (minHits === undefined) return noop("RETRIEVAL_MIN_HITS is not an integer");
  if (best.hits < minHits) return noop("below RETRIEVAL_MIN_HITS");

  // Seen ring, updated BEFORE the append (step:62-65).
  const seen = readSeen(seenFile);
  if (seen.includes(best.mid)) return noop("recently surfaced");
  const ring = intKnob(env["RETRIEVAL_SEEN"], 20);
  if (ring === undefined) {
    io.stderr(`retrieval: RETRIEVAL_SEEN: arithmetic syntax error\n`);
    return { code: 1, reason: "RETRIEVAL_SEEN is not an integer" };
  }
  try {
    const next = nextSeen(seen, best.mid, ring);
    fs.writeFileSync(`${seenFile}.tmp`, next.map((l) => `${l}\n`).join(""));
    fs.renameSync(`${seenFile}.tmp`, seenFile);
  } catch (e) {
    io.stderr(`retrieval: ${(e as Error).message}\n`);
    return { code: 1, reason: "seen write failed" };
  }

  // The observation, verbatim (step:67-71).
  let obs = `I'm reminded of memory ${best.mid}: ${best.summary} (${best.hits} shared words; mem show ${best.mid} for the full note)`;
  if ((env["RETRIEVAL_SEMANTIC"] || "0") === "1") {
    let sem = "";
    if (io.memSearch) {
      try {
        sem = head3(io.memSearch(content)).replace(/\n/g, " ");
      } catch {
        sem = "";
      }
    }
    if (sem !== "") obs += ` | mem search: ${[...sem].slice(0, 300).join("")}`;
  }

  const record: Record<string, unknown> = {
    type: "observation",
    content: obs,
    source: THINKER_NAME,
    retrieved_mem: best.mid,
    ...(stepId !== "" ? { trigger_step: stepId } : {}),
  };
  let id: string;
  try {
    id = io.appendStep(record, { runStepId: env["SHELLM_RUN_STEP_ID"] ?? "" });
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return { code: 1, reason: "traj append failed" };
  }
  return { code: 0, reason: "appended", observation: { stepId: id, mid: best.mid, hits: best.hits, content: obs } };
}
