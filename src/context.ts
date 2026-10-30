// context.ts — rebuild the model's chat history from the trajectory each
// iteration (SPEC §1.4; bin/context). The shellm loop calls this with:
//   --assistant-types reasoning,final
//   --user-types prompt,shell-output,feedback
//   --exclude-types shellm-run,run-summary
//   (unrecognized types default to "user")   (bin/shellm:2265-2268)
//
// The history is REGENERATED from the log every turn, never accumulated in
// memory — so within a wake the model sees its own `reasoning` (with the bash)
// as assistant turns and `shell-output` as user turns.
//
// NOTE (source-vs-SPEC): SPEC §1.4 prose says the model's own
// observation/thought/idle steps are "excluded from its own live context", but
// the actual `context` invocation only excludes shellm-run/run-summary and
// defaults every other type to the USER role — so those steps DO enter context
// as user messages. We follow the source (the trace-grounded authority), not
// the prose. This only affects the real-LLM path; replay ignores the messages.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "./llm.ts";

export interface ContextOptions {
  assistantTypes: string[];
  userTypes: string[];
  excludeTypes: string[];
  head?: number; // default 1
  tail?: number; // default 50
  /** PORT-NOTE (1c: d43ae81) --tail-block: the tail window's start moves only
   *  in steps of this many rows, so the window holds tail..tail+block-1 rows
   *  and the rendered prefix (hence the provider's cached prompt prefix)
   *  changes once per `block` appended rows instead of on every call.
   *  Default 1 (old behaviour: the window slides every call). */
  tailBlock?: number;
  pins?: string[];
  promptLimit?: number; // per-field truncation, default 2048
  /** PORT-NOTE (1c: 0f8b49e) --block-limit: rows in the newest `wholeBlocks`
   *  window-blocks render at this limit instead of promptLimit (a band that
   *  follows the same grid as `tailBlock`, so a row's limit changes exactly
   *  once, on the call where the window start would move anyway). Default:
   *  same as promptLimit (no band). */
  blockLimit?: number;
  /** PORT-NOTE (1c: 0f8b49e) --whole-blocks: how many newest window-blocks
   *  get blockLimit (with tailBlock 1: the newest `wholeBlocks` rows).
   *  Default 1. */
  wholeBlocks?: number;
  /** PORT-NOTE (1c: 7a35982) --full-types: step types exempt from the field
   *  limit entirely (e.g. "prompt" — instructions arrive whole or not at
   *  all; a cut prompt leaves the model a stub pointing at its own
   *  instructions on disk). Overrides blockLimit/promptLimit both. */
  fullTypes?: string[];
  /** PORT-NOTE (1c: 7a35982) --run RUN_ID: keep only steps whose run_id is
   *  RUN_ID (pins always stay); other runs' rows are dropped WITHOUT
   *  counting toward an elision marker (a gap inside the run renders as
   *  "[earlier steps elided]" with no count; the gap before the first kept
   *  row in the run is never marked at all — everything earlier is another
   *  run's by definition). "" (default): no run filtering (traj scope). */
  run?: string;
  trajFile?: string; // for blob loading of truncated stdout/stderr
}

// PORT-NOTE (1c: 3228c8c, 1fdeb97): bookkeeping fields bin/llm and bin/shellm
// stamp on steps (token counts, latency, run id) are hidden from the model —
// upstream's 3228c8c fix for a real Audel incident: rendered as "[in_tok]\n…"
// after its own code block, the model learned the shape and echoed it back,
// then invented another thought and block, looping until the stream timed
// out. 1fdeb97 adds cache_tok (cached input tokens) to the same hidden set.
// PORT-NOTE (1c: f68c1d8): f68c1d8 adds source_url (the Slack permalink a
// mind-log row was created from) to the same hidden bookkeeping set — it is
// metadata for the web UI's link-to-Slack feature, not something the model
// should see or be able to echo back.
const META_EXACT = new Set([
  "step_id",
  "ts",
  "type",
  "fork_parent",
  "run_id",
  "llm_s",
  "in_tok",
  "out_tok",
  "think_tok",
  "cache_tok",
  "estimated",
  // PORT-NOTE (sync 2e39a3f, 815eab2/write_usage): usage-record fields.
  "served_by",
  "truncated",
  "source_url",
]);
function isMeta(k: string): boolean {
  return META_EXACT.has(k) || k.endsWith("_ref") || k.endsWith("_bytes") || k.endsWith("_truncated");
}

/**
 * PORT-NOTE (sync 2e39a3f, 815eab2): a reasoning row is the model's own reply,
 * so it renders from a FIXED field list in a fixed order — the thought (or
 * "content", its older name), then the code block, nothing after the fence.
 * Any other field on the row is bookkeeping whatever its name (is_meta is only
 * a denylist; a field added later rendered after the fence until the model
 * wrote it back as a command). Other types keep the denylist, in jq `keys`
 * (sorted) order when `sorted`. The two fields' bare-value shortcut (`nc==1`)
 * never applies to reasoning: upstream pins nc to 2 there.
 */
function renderKeys(t: string, row2: Record<string, unknown>, sorted: boolean): string[] {
  if (t === "reasoning") return ["thought", "content", "cmd"].filter((k) => Object.prototype.hasOwnProperty.call(row2, k));
  const ks = Object.keys(row2).filter((k) => !isMeta(k));
  return sorted ? ks.sort() : ks;
}

function roleFor(t: string, o: ContextOptions): "assistant" | "user" | "exclude" {
  if (o.excludeTypes.includes(t)) return "exclude";
  if (o.assistantTypes.includes(t)) return "assistant";
  if (o.userTypes.includes(t)) return "user";
  return "user";
}

function truncateField(v: string, limit: number, sid: string): string {
  const vb = Buffer.byteLength(v, "utf8");
  if (vb <= limit) return v;
  if (limit <= 1) return `[... truncated: ${vb} bytes total. read with: traj show ${sid} --full]`;
  const half = Math.max(Math.floor(limit / 2), 1);
  const head = Buffer.from(v, "utf8").subarray(0, half).toString("utf8").replace(/\s+$/, "");
  const tail = Buffer.from(v, "utf8").subarray(-half).toString("utf8").replace(/\s+$/, "");
  return `${head}\n[... truncated: ${vb} bytes total. read with: traj show ${sid} --full]\n${tail}`;
}

function loadBlob(trajFile: string | undefined, ref: string): string | undefined {
  if (!trajFile) return undefined;
  try {
    return fs.readFileSync(path.join(path.dirname(trajFile), ref), "utf8");
  } catch {
    return undefined;
  }
}

/** PORT-NOTE (1c: 0f8b49e) window_start's sibling for the truncation band:
 *  rows at index >= bandStart render whole up to blockLimit; earlier rows
 *  use the plain limit. With tailBlock <= 1 the band is just the newest
 *  `whole` rows (bash: `$N - $W`); with tailBlock > 1 it follows the same
 *  fixed row-index grid as windowStart, so a row's band membership changes
 *  exactly once — the same call on which the window start moves. */
function bandStart(N: number, tailBlock: number, whole: number): number {
  if (tailBlock > 1) return (Math.floor((N - 1) / tailBlock) - (whole - 1)) * tailBlock;
  return N - whole;
}

/** PORT-NOTE (1c: 0f8b49e) row_limit: the effective per-field limit for row
 *  `i` of `N`, before any --full-types override. */
function rowLimit(i: number, N: number, limit: number, blockLimit: number, tailBlock: number, whole: number): number {
  return i >= bandStart(N, tailBlock, whole) ? blockLimit : limit;
}

function renderStep(row: Record<string, unknown>, o: ContextOptions, limitOverride?: number, full?: string[]): string {
  const sid = String(row["step_id"] ?? "");
  const t = String(row["type"] ?? "");
  if (t === "fork") return `[Forked child: ${row["child"] ?? ""}]`;
  if (t === "trajectory") return "";
  if (t === "merge") {
    const b = row["from_branch"] ?? row["from_traj"] ?? "";
    const c = String(row["content"] ?? "");
    return c !== "" ? `[Merged from ${b}: ${c}]` : `[Merged from ${b}]`;
  }
  // PORT-NOTE (1c: 7a35982): a type in --full-types is never truncated,
  // whatever the band/limit says (a jq-side "1e12" stand-in for "no limit").
  const limit = full && full.includes(t) ? Number.MAX_SAFE_INTEGER : (limitOverride ?? o.promptLimit ?? 2048);

  // Load blob content for truncated stdout/stderr, dropping the *_truncated key.
  const row2: Record<string, unknown> = { ...row };
  for (const f of ["stdout", "stderr"]) {
    const ref = row2[`${f}_ref`];
    if (typeof ref === "string" && ref !== "") {
      const full = loadBlob(o.trajFile, ref);
      if (full !== undefined) {
        row2[f] = full.replace(/\s+$/, "");
        delete row2[`${f}_truncated`];
      }
    }
  }

  const cks = renderKeys(t, row2, true);
  const nc = t === "reasoning" ? 2 : cks.length;
  let acc = "";
  for (const k of cks) {
    const raw = row2[k];
    const v0 = (raw === undefined || raw === null ? "" : String(raw)).replace(/\s+$/, "");
    if (v0 === "") continue;
    const v = truncateField(v0, limit, sid);
    if (nc === 1) acc = v;
    else if (k === "cmd") acc += "```bash\n" + v + "\n```\n\n";
    else if (k === "thought" || t === "reasoning") acc += v + "\n\n";
    else acc += "[" + k + "]\n" + v + "\n\n";
  }
  return acc.replace(/\s+$/, "");
}

/** Merge consecutive same-role messages (Anthropic alternation, bin/context:306). */
function mergeRoles(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n---\n" + m.content;
    else out.push({ ...m });
  }
  return out;
}

/** window_start (bin/context, d43ae81): the tail window's start, rounded
 *  down to a multiple of `block` when block > 1 — the window then holds
 *  tail..tail+block-1 rows and calls in between render an identical prefix. */
function windowStart(N: number, tail: number, block: number): number {
  const raw = Math.max(N - tail, 0);
  return block > 1 ? Math.floor(raw / block) * block : raw;
}

/** Build the multi-turn messages array for one iteration. */
export function buildContext(steps: Record<string, unknown>[], o: ContextOptions): ChatMessage[] {
  const head = o.head ?? 1;
  const tail = o.tail ?? 50;
  const tailBlock = o.tailBlock ?? 1;
  const blockLimit = o.blockLimit ?? o.promptLimit ?? 2048;
  const wholeBlocks = o.wholeBlocks ?? 1;
  const full = o.fullTypes ?? [];
  const run = o.run ?? "";
  const pins = o.pins ?? [];
  const N = steps.length;
  const start = windowStart(N, tail, tailBlock);

  const items = steps.map((row, i) => ({ i, row, role: roleFor(String(row["type"] ?? ""), o) }));
  const sidOf = (row: Record<string, unknown>): string => String(row["step_id"] ?? "");
  // PORT-NOTE (1c: 7a35982) in_run: a row belongs when its run_id matches, or
  // it is pinned (a pin always stays regardless of scope).
  const inRun = (it: (typeof items)[number]): boolean =>
    run === "" || String(it.row["run_id"] ?? "") === run || pins.includes(sidOf(it.row));
  const kept = items.filter(
    (it) =>
      it.role !== "exclude" &&
      inRun(it) &&
      (it.i < head || it.i >= start || pins.includes(sidOf(it.row)))
  );
  // $skip (bin/context): rows the renderer never sees — excluded role, or
  // (run scope) another run's — subtracted from the elision gap count so a
  // dropped row is never double-counted as "elided".
  const skip = items.filter((it) => it.role === "exclude" || !inRun(it)).map((it) => it.i);
  const gapBetween = (a: number, b: number): number => b - a - 1 - skip.filter((j) => j > a && j < b).length;

  const msgs: ChatMessage[] = [];
  let last = -1;
  let first = true;
  for (const it of kept) {
    const gap = gapBetween(last, it.i);
    if (gap > 0) {
      // marker() (bin/context, 7a35982): traj scope always numbers the gap;
      // run scope never marks the gap before the first kept row (everything
      // earlier is another run's by definition) and marks a gap INSIDE the
      // run with no count (the middle rows were never read to count them).
      if (run === "") msgs.push({ role: "user", content: `[${gap} steps elided]` });
      else if (!first) msgs.push({ role: "user", content: "[earlier steps elided]" });
    }
    const limit = rowLimit(it.i, N, o.promptLimit ?? 2048, blockLimit, tailBlock, wholeBlocks);
    const c = renderStep(it.row, o, limit, full);
    if (c !== "" && it.role !== "exclude") msgs.push({ role: it.role, content: c });
    last = it.i;
    first = false;
  }
  const tailGap = gapBetween(last, N);
  if (tailGap > 0 && run === "") msgs.push({ role: "user", content: `[${tailGap} steps elided]` });

  return mergeRoles(msgs);
}

/** The exact flag set the monolith's shellm run uses (bin/shellm:2265-2268). */
export const MONOLITH_CONTEXT_OPTS: Omit<ContextOptions, "trajFile"> = {
  assistantTypes: ["reasoning", "final"],
  userTypes: ["prompt", "shell-output", "feedback"],
  excludeTypes: ["shellm-run", "run-summary"],
  head: 1,
  tail: 50,
  promptLimit: 2048,
};

// ===========================================================================
// CLI port of headlong/bin/context (Bash).
//
// `buildContext` above is the ENGINE-facing projection (responder/monolith call
// it on the full step array). This section is the standalone `context` TOOL the
// model shells out to inside its bash action block — a faithful port of the Bash
// CLI contract: subcommands/flags, stdout/stderr split, exit codes, the
// head/tail/pin candidate-loading, the `$skip` elision arithmetic, blob
// substitution, jq-pretty JSON output, and the `--max-bytes` budget search.
//
// It does NOT reuse `buildContext` for message assembly because two Bash
// semantics differ from that simpler in-process path and must be held exact
// here (reconciled in favour of the Bash contract):
//   1. ELISION: the Bash tool only reads head+tail+pin lines, so "[N steps
//      elided]" gaps subtract only the *fed* excluded/malformed rows ($skip);
//      middle markers can overcount. `buildContext` sees every row and counts
//      exactly. The tool must reproduce the Bash arithmetic.
//   2. rtrim is NEWLINE-only (`sub("\n+$";"")`) and object/array field values
//      pretty-print like `jq` (`pp`); `buildContext`'s renderStep uses
//      whitespace rtrim + `String()`. Content is almost always string-valued so
//      this rarely shows, but the tool holds the Bash behaviour.
// Per-step helpers that DO match (roleFor, isMeta, loadBlob, mergeRoles) are
// reused from this module directly.
// ===========================================================================

/** IO seam mirroring MemIO; `context` reads no stdin and needs no clock/random.
 *  `stdout` also takes bytes for the `--max-bytes` hard-truncation (`head -c`). */
export interface ContextIO {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(s: string | Uint8Array): void;
  stderr(s: string): void;
}

/** Thrown by `die` to unwind to the runContext boundary with an exit code. */
class ContextExit extends Error {
  readonly code: number;
  /** When set, printed to stderr as `context: error: <msg>`. */
  readonly dieMsg: string | undefined;
  constructor(code: number, dieMsg?: string) {
    super(dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
  }
}

/** die() — `printf 'context: error: %s\n' >&2; exit 1` (bin/context:30). */
function ctxDie(msg: string): never {
  throw new ContextExit(1, msg);
}

/**
 * Bash `${2:?message}`: a missing OR empty required flag value dies rc1.
 *
 * PORT-NOTE (deliberate DEVIATION, same as src/mem.ts): Bash's `${2:?msg}`
 * prints `<script>: line N: 2: <msg>` (its absolute path + a Bash line number)
 * and exits 1. That text is irreproducible from TS and brittle to pin, so the
 * port prints `context: error: <msg>` and exits 1. Exit code (1), empty stdout,
 * and unchanged on-disk state all match; only the stderr phrasing differs, on a
 * misuse path no Headlong caller inspects.
 */
function ctxRequired(v: string | undefined, msg: string): string {
  if (v === undefined || v === "") ctxDie(msg);
  return v;
}

const CONTEXT_USAGE = `Usage: context [options]

Reads a trajectory and outputs a JSON messages array to stdout.

Trajectory targeting:
  --traj_dir DIR        Trajectory directory.
  <ID>                  Trajectory ID (UUID or hex prefix, positional).
                        Falls back to $TRAJ_DIR + $TRAJ_ID env vars.

Role assignment:
  --assistant-types LIST  Step types that become {"role":"assistant"}.
  --user-types LIST       Step types that become {"role":"user"}.
  --exclude-types LIST    Step types to drop entirely.
  Unrecognized types (not in any list) default to "user" role.

Step selection:
  --head N              Keep first N steps. Default: 1.
  --tail N              Keep last N steps. Default: 50.
  --tail-block B        Move the tail window's start only in steps of B rows,
                        so it holds N to N+B-1 rows and the rendered prefix
                        changes once per B appended rows instead of on every
                        call (keeps provider prompt caches warm). Default: 1.
  --pin <step_id>       Always include this step. Repeatable.
  --run RUN_ID          Keep only steps whose run_id is RUN_ID (pins always
                        stay). Steps of other runs never render and never
                        count as elided; a gap inside the run renders as
                        "[earlier steps elided]" with no count.

Per-step content:
  --prompt-limit BYTES  Per-step field truncation for large values. Default: 2048.
  --full-types LIST     Step types whose fields are never truncated, e.g.
                        "prompt": instructions arrive whole or not at all (a
                        cut prompt leaves the model a stub pointing at its
                        own instructions on disk).
  --block-limit BYTES   Truncation limit for rows in the newest --tail-block
                        block(s) of the file; older rows use --prompt-limit.
                        A row's block never changes, so a row is rewritten
                        once, when the newest row crosses into the next
                        block, which is also when the window start moves.
                        Default: same as --prompt-limit.
  --whole-blocks W      How many newest blocks render at --block-limit
                        (with --tail-block 1: the newest W rows). Default: 1.

Elision:
  --elision-style S     none|count. Default: count.

Budget:
  --max-bytes BYTES     Cap total output. Default: unset.

Output:
  A JSON array: [{"role":"user","content":"..."},{"role":"assistant","content":"..."},...]
  Consecutive messages with the same role are merged (Anthropic API requires alternation).

Environment:
  TRAJ_DIR + TRAJ_ID    Default trajectory if no flags given.

`;

// --- jq-value helpers (mirror the JQ_PROG in bin/context) --------------------

/** rtrim in bin/context is `sub("\\n+$"; "")` — trailing NEWLINES only. */
function cliRtrim(s: string): string {
  return s.replace(/\n+$/, "");
}

/**
 * jq-faithful JSON serialization. `JSON.stringify` matches jq's escaping for
 * every codepoint EXCEPT U+007F (DEL): jq's `tojson` escapes it as the 6-char
 * sequence backslash-u-0-0-7-f (an exhaustive 0x01..0x2FFFF scan found it the
 * sole divergence), while Node emits the raw 0x7f byte. Post-process to restore
 * the jq encoding so both JSON-emitting sites (final array + `pp`) stay
 * byte-exact with Bash — and so `--max-bytes` counts those 6 bytes as Bash's
 * `wc -c` does. Nested object/array fields escape at each level: jqrEmpty -> pp
 * emits the literal escape, then the outer array re-escapes its backslash.
 */
function jqJson(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(/\x7f/g, "\\u007f");
}

/** `pp` — jq's default 2-space pretty print. Byte-identical to jq's
 *  object/array/scalar formatting for our data once 0x7f is escaped (jqJson). */
function ppValue(v: unknown): string {
  return jqJson(v);
}

/**
 * `jqr_empty` — equivalent of `$(printf row | jq -r '.key // empty')`:
 * null/false -> "", string -> itself, object/array -> jq-pretty, else tostring.
 * (undefined stands in for an absent key / jq null.)
 */
function jqrEmpty(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return ppValue(v); // object or array
  if (typeof v === "boolean") return "true"; // false handled above
  return String(v); // number — jq number fmt matches JS for typical ints/decimals
}

/** Longest prefix of `s` fitting in `n` UTF-8 bytes, never splitting a codepoint
 *  (Bash `btrunc_head`: `.[0:$n] | until(utf8bytelength <= $n; .[0:length-1])`). */
function btruncHead(s: string, n: number): string {
  if (Buffer.byteLength(s, "utf8") <= n) return s;
  const cps = [...s].slice(0, n); // jq `.[0:$n]` — first n codepoints
  let bytes = 0;
  const out: string[] = [];
  for (const cp of cps) {
    const cb = Buffer.byteLength(cp, "utf8");
    if (bytes + cb > n) break;
    bytes += cb;
    out.push(cp);
  }
  return out.join("");
}

/** Longest suffix of `s` fitting in `n` UTF-8 bytes, never splitting a codepoint
 *  (Bash `btrunc_tail`: `.[length-$n:] | until(utf8bytelength <= $n; .[1:])`). */
function btruncTail(s: string, n: number): string {
  if (Buffer.byteLength(s, "utf8") <= n) return s;
  const cps = [...s];
  const window = cps.length > n ? cps.slice(cps.length - n) : cps;
  let bytes = 0;
  const out: string[] = [];
  for (let k = window.length - 1; k >= 0; k--) {
    const cb = Buffer.byteLength(window[k]!, "utf8");
    if (bytes + cb > n) break;
    bytes += cb;
    out.unshift(window[k]!);
  }
  return out.join("");
}

/** Bash `truncate_field` — head/tail halves around a byte-count marker. */
function cliTruncateField(v: string, limit: number, sid: string): string {
  const vb = Buffer.byteLength(v, "utf8");
  if (vb <= limit) return v;
  if (limit <= 1) {
    return `[... truncated: ${vb} bytes total. read with: traj show ${sid} --full]`;
  }
  const half = Math.max(Math.floor(limit / 2), 1);
  const head = cliRtrim(btruncHead(v, half));
  const tail = cliRtrim(btruncTail(v, half));
  return `${head}\n[... truncated: ${vb} bytes total. read with: traj show ${sid} --full]\n${tail}`;
}

/** Bash `render_step` — one step row → its message text (newline-rtrim,
 *  jqr_empty field stringification, blob substitution). */
function cliRenderStep(
  row: Record<string, unknown>,
  opts: { promptLimit: number; trajFile: string; fullTypes?: string[] }
): string {
  const sid = String(row["step_id"] ?? "");
  const t = String(row["type"] ?? "");
  if (t === "fork") return `[Forked child: ${jqrEmpty(row["child"])}]`;
  if (t === "trajectory") return "";
  if (t === "merge") {
    const fb = row["from_branch"];
    // jq `//`: from_branch unless null/false, else from_traj.
    const b = jqrEmpty(fb !== null && fb !== undefined && fb !== false ? fb : row["from_traj"]);
    const c = jqrEmpty(row["content"]);
    return c !== "" ? `[Merged from ${b}: ${c}]` : `[Merged from ${b}]`;
  }
  // PORT-NOTE (1c: 7a35982) --full-types: never truncated, whatever the
  // (already band-adjusted) promptLimit passed in says.
  const limit = opts.fullTypes && opts.fullTypes.includes(t) ? Number.MAX_SAFE_INTEGER : opts.promptLimit;

  // Load blob content for truncated stdout/stderr, dropping the *_truncated key.
  const row2: Record<string, unknown> = { ...row };
  for (const f of ["stdout", "stderr"]) {
    const ref = row2[`${f}_ref`];
    if (typeof ref === "string" && ref !== "") {
      const blob = loadBlob(opts.trajFile, ref);
      if (blob !== undefined) {
        row2[f] = cliRtrim(blob);
        delete row2[`${f}_truncated`];
      }
    }
  }

  // jq `keys` returns object keys SORTED (not insertion order), so content
  // fields render alphabetically — e.g. `cmd` before `thought`. .sort()'s
  // default order matches jq's codepoint sort for the ASCII field names used.
  const cks = renderKeys(t, row2, true);
  const nc = t === "reasoning" ? 2 : cks.length;
  let acc = "";
  for (const k of cks) {
    const v0 = cliRtrim(jqrEmpty(row2[k]));
    if (v0 === "") continue;
    const v = Buffer.byteLength(v0, "utf8") > limit ? cliTruncateField(v0, limit, sid) : v0;
    if (nc === 1) acc = v;
    else if (k === "cmd") acc += "```bash\n" + v + "\n```\n\n";
    else if (k === "thought" || t === "reasoning") acc += v + "\n\n";
    else acc += "[" + k + "]\n" + v + "\n\n";
  }
  return acc;
}

// --- trajectory resolution (mirror _ctx_resolve_traj_id) ---------------------

function ctxIsFile(io: ContextIO, displayPath: string): boolean {
  const abs = path.isAbsolute(displayPath) ? displayPath : path.resolve(io.cwd, displayPath);
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively find the first directory whose basename matches `<hexPrefix>-*`
 * (Bash `find "$dir" -type d -name "<hexPrefix>-*" | head -1`), returning it as
 * a `displayRoot`-relative path so the resolved string mirrors Bash's (relative
 * in, relative out). Pre-order DFS in readdir order approximates `find`'s order.
 *
 * PORT-NOTE: `head -1` among MULTIPLE matches follows `find`'s readdir order,
 * which is filesystem-dependent; the port's DFS order may pick a different
 * winner in that (rare) tie. Real trajectory dirs have a single `<hex8>-root`.
 */
function ctxFindDir(absRoot: string, hexPrefix: string, displayRoot: string): string | null {
  const prefix = hexPrefix + "-";
  const walk = (absDir: string, relDir: string): string | null => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      // find is pre-order: a matching dir is yielded before its subtree.
      if (e.name.startsWith(prefix)) {
        return displayRoot.endsWith("/") ? `${displayRoot}${rel}` : `${displayRoot}/${rel}`;
      }
      const deeper = walk(path.join(absDir, e.name), rel);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(absRoot, "");
}

/** Inline port of traj's `_resolve_traj_id`. Returns the (possibly relative)
 *  resolved trajectory-file path string, or null on failure. */
function ctxResolveTrajId(io: ContextIO, trajDir: string, trajId: string): string | null {
  // 1. Exact path.
  const p1 = `${trajDir}/${trajId}`;
  if (ctxIsFile(io, p1)) return p1;
  // 2. Directory-based: $traj_dir/$traj_id/trajectory.jsonl
  const p2 = `${trajDir}/${trajId}/trajectory.jsonl`;
  if (ctxIsFile(io, p2)) return p2;
  // 3. UUID handling: hex prefix = up to first '-' when id has >= 4 dashes.
  let hexPrefix = trajId;
  if ((trajId.match(/-/g)?.length ?? 0) >= 4) hexPrefix = trajId.split("-")[0]!;
  // 4. Directory glob: find dirs named <hex_prefix>-* holding trajectory.jsonl.
  const absDir = path.isAbsolute(trajDir) ? trajDir : path.resolve(io.cwd, trajDir);
  const match = ctxFindDir(absDir, hexPrefix, trajDir);
  if (match !== null && ctxIsFile(io, `${match}/trajectory.jsonl`)) {
    return `${match}/trajectory.jsonl`;
  }
  return null;
}

// --- candidate loading (mirror the head+pin+tail loader) ---------------------

interface FedRow {
  i: number;
  row: Record<string, unknown> | null;
}

/**
 * Build the fed candidate rows exactly as bin/context does: the WHOLE file when
 * `total <= head + tail`, otherwise only head lines + pin-substring lines
 * (grep -nF, first 50 per pin) + tail lines. Each is tagged with its 0-based
 * line index, deduped, sorted ascending, then parsed. A parsed non-object, or
 * an object with an empty `step_id`, becomes a null row (matches
 * `fromjson? // null` + the step_id guard).
 *
 * PORT-NOTE: a JSONL line that is valid JSON but NOT an object (e.g. a bare
 * `42`) is treated as a null row here; the Bash `.row.step_id` would instead
 * error out and abort. Real trajectory lines are always objects.
 */
function ctxLoadFed(
  lines: string[],
  total: number,
  head: number,
  tail: number,
  pins: string[],
  tailBlock = 1
): FedRow[] {
  // PORT-NOTE (1c: d43ae81): the tail-read window is widened to tail+block-1
  // rows so the loader always covers whatever the sliding window
  // (windowStart) might select, even though this port always reads the whole
  // file anyway — this only affects which rows are "fed" (hence eligible for
  // $skip bookkeeping) vs. entirely un-fed (raw, un-subtracted gap), matching
  // bin/context's own read-restricted candidate set exactly.
  const tailRead = tail + tailBlock - 1;
  const fed: { i: number; raw: string }[] = [];
  if (total <= head + tailRead) {
    for (let i = 0; i < lines.length; i++) fed.push({ i, raw: lines[i]! });
  } else {
    if (head > 0) for (let i = 0; i < head && i < lines.length; i++) fed.push({ i, raw: lines[i]! });
    for (const pin of pins) {
      let hits = 0;
      for (let i = 0; i < lines.length && hits < 50; i++) {
        if (pin !== "" && lines[i]!.includes(pin)) {
          fed.push({ i, raw: lines[i]! });
          hits++;
        }
      }
    }
    if (tailRead > 0) {
      const tailStart = total - tailRead;
      for (let i = Math.max(0, tailStart); i < lines.length; i++) fed.push({ i, raw: lines[i]! });
    }
  }
  // unique_by(.i) — dedup (identical raw for a given index) and sort ascending.
  const byI = new Map<number, string>();
  for (const f of fed) if (!byI.has(f.i)) byI.set(f.i, f.raw);
  return [...byI.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, raw]) => {
      let row: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          row = parsed as Record<string, unknown>;
        }
      } catch {
        row = null;
      }
      if (row !== null && String(row["step_id"] ?? "") === "") row = null;
      return { i, row };
    });
}

// --- CLI entry ---------------------------------------------------------------

function ctxInt(s: string): number {
  return Number(s);
}

/**
 * Port of headlong/bin/context. Reads a trajectory, writes a JSON messages
 * array to `io.stdout`, returns the process exit code.
 */
export function runContext(argv: string[], io: ContextIO): number {
  const env = io.env;
  try {
    // Defaults — env-overridable exactly as the Bash `${VAR:-default}` reads.
    let head = ctxInt(env.CTX_HEAD ?? "1");
    let tail = ctxInt(env.CTX_TAIL ?? "50");
    let tailBlock = ctxInt(env.CTX_TAIL_BLOCK ?? "1");
    let promptLimit = ctxInt(env.SHELLM_STDOUT_PROMPT_LIMIT ?? "2048");
    // PORT-NOTE: CTX_BLOCK_LIMIT/CTX_WHOLE_BLOCKS are plain literal
    // assignments in bash (`CTX_BLOCK_LIMIT=""`, `CTX_WHOLE_BLOCKS=1`), NOT
    // `${VAR:-default}` reads — unlike CTX_HEAD/CTX_TAIL/CTX_TAIL_BLOCK/
    // SHELLM_STDOUT_PROMPT_LIMIT above, these two are NOT env-overridable in
    // bash, only via their own --block-limit/--whole-blocks flags.
    let blockLimitOpt = ""; // "": same as promptLimit (no band)
    let wholeBlocks = 1;
    let maxBytes: number | null = null;
    let elision = "count";
    const pins: string[] = [];
    let assistantTypes = "";
    let userTypes = "";
    let excludeTypes = "";
    let fullTypesStr = "";
    let run = "";
    let trajDirOpt = "";
    let trajIdOpt = "";

    const args = argv.slice();
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--head":
          head = ctxInt(ctxRequired(args[i + 1], "--head requires N"));
          i += 2;
          break;
        case "--tail":
          tail = ctxInt(ctxRequired(args[i + 1], "--tail requires N"));
          i += 2;
          break;
        case "--tail-block":
          tailBlock = ctxInt(ctxRequired(args[i + 1], "--tail-block requires B"));
          i += 2;
          break;
        case "--pin":
          pins.push(ctxRequired(args[i + 1], "--pin requires step_id"));
          i += 2;
          break;
        case "--run":
          run = ctxRequired(args[i + 1], "--run requires RUN_ID");
          i += 2;
          break;
        case "--prompt-limit":
          promptLimit = ctxInt(ctxRequired(args[i + 1], "--prompt-limit requires BYTES"));
          i += 2;
          break;
        case "--full-types":
          fullTypesStr = ctxRequired(args[i + 1], "--full-types requires LIST");
          i += 2;
          break;
        case "--block-limit":
          blockLimitOpt = ctxRequired(args[i + 1], "--block-limit requires BYTES");
          i += 2;
          break;
        case "--whole-blocks":
          wholeBlocks = ctxInt(ctxRequired(args[i + 1], "--whole-blocks requires W"));
          i += 2;
          break;
        case "--elision-style":
          elision = ctxRequired(args[i + 1], "--elision-style requires a value");
          i += 2;
          break;
        case "--max-bytes":
          maxBytes = ctxInt(ctxRequired(args[i + 1], "--max-bytes requires BYTES"));
          i += 2;
          break;
        case "--assistant-types":
          assistantTypes = ctxRequired(args[i + 1], "--assistant-types requires LIST");
          i += 2;
          break;
        case "--user-types":
          userTypes = ctxRequired(args[i + 1], "--user-types requires LIST");
          i += 2;
          break;
        case "--exclude-types":
          excludeTypes = ctxRequired(args[i + 1], "--exclude-types requires LIST");
          i += 2;
          break;
        case "--traj_dir":
          trajDirOpt = ctxRequired(args[i + 1], "--traj_dir requires DIR");
          i += 2;
          break;
        case "-h":
        case "--help":
          io.stdout(CONTEXT_USAGE);
          return 0;
        default:
          if (a.startsWith("-")) ctxDie(`unknown option: ${a}`);
          if (trajIdOpt === "") {
            trajIdOpt = a;
            i += 1;
          } else {
            ctxDie(`unexpected argument: ${a}`);
          }
      }
    }

    // Resolve trajectory file. Priority: --traj_dir + positional ID > env vars.
    // (Both of a pair must be set; a lone positional ID with no --traj_dir falls
    // through to the env branch — a Bash quirk preserved here.)
    let resolved: string | null;
    if (trajDirOpt !== "" && trajIdOpt !== "") {
      resolved = ctxResolveTrajId(io, trajDirOpt, trajIdOpt);
      if (resolved === null) ctxDie(`cannot resolve traj ID '${trajIdOpt}' in '${trajDirOpt}'`);
    } else if ((env.TRAJ_DIR ?? "") !== "" && (env.TRAJ_ID ?? "") !== "") {
      resolved = ctxResolveTrajId(io, env.TRAJ_DIR!, env.TRAJ_ID!);
      if (resolved === null) {
        ctxDie(`cannot resolve TRAJ_ID '${env.TRAJ_ID}' in TRAJ_DIR '${env.TRAJ_DIR}'`);
      }
    } else {
      ctxDie("No trajectory specified. Use --traj_dir DIR <ID>, or set TRAJ_DIR + TRAJ_ID env vars.");
    }
    if (!ctxIsFile(io, resolved!)) ctxDie(`trajectory not found: ${resolved}`);

    // Always exclude shellm-run and run-summary (appended, not overriding).
    excludeTypes = excludeTypes !== "" ? `${excludeTypes},shellm-run,run-summary` : "shellm-run,run-summary";

    const roleOpts: ContextOptions = {
      assistantTypes: assistantTypes === "" ? [] : assistantTypes.split(","),
      userTypes: userTypes === "" ? [] : userTypes.split(","),
      excludeTypes: excludeTypes === "" ? [] : excludeTypes.split(","),
    };

    // Read the file; derive TOTAL_LINES (Bash `wc -l` + the final-unterminated
    // -line correction) and the 0-based line array.
    const absFile = path.isAbsolute(resolved!) ? resolved! : path.resolve(io.cwd, resolved!);
    let raw = "";
    try {
      raw = fs.readFileSync(absFile, "utf8");
    } catch {
      raw = "";
    }
    let lines: string[];
    let total: number;
    if (raw === "") {
      lines = [];
      total = 0;
    } else {
      lines = raw.split("\n");
      if (raw.endsWith("\n")) lines.pop();
      total = lines.length;
    }

    const fullTypes = fullTypesStr === "" ? [] : fullTypesStr.split(",");

    // Fed candidates → items → kept → skip (selection independent of promptLimit).
    const fed = ctxLoadFed(lines, total, head, tail, pins, tailBlock);
    const items = fed
      .filter((f) => f.row !== null)
      .map((f) => ({
        i: f.i,
        row: f.row as Record<string, unknown>,
        role: roleFor(String((f.row as Record<string, unknown>)["type"] ?? ""), roleOpts),
      }));
    const N = items.length; // RENDER_TOTAL — the empty-trajectory zero-check.
    const start = windowStart(total, tail, tailBlock);
    // PORT-NOTE (1c: 7a35982) in_run: a row belongs when its run_id matches
    // RUN_ID, or it is pinned. run === "" (default): every row belongs (traj
    // scope, unchanged).
    const inRun = (it: (typeof items)[number]): boolean =>
      run === "" || String(it.row["run_id"] ?? "") === run || pins.includes(String(it.row["step_id"] ?? ""));
    const kept = items.filter(
      (it) =>
        it.role !== "exclude" &&
        inRun(it) &&
        (it.i < head || it.i >= start || pins.includes(String(it.row["step_id"] ?? "")))
    );
    const skip = [
      ...fed.filter((f) => f.row === null).map((f) => f.i),
      ...items.filter((it) => it.role === "exclude" || !inRun(it)).map((it) => it.i),
    ].sort((a, b) => a - b);
    const gapBetween = (a: number, b: number): number =>
      b - a - 1 - skip.filter((j) => j > a && j < b).length;

    const renderMsgs = (limit: number, blockLimit: number): string => {
      const msgs: ChatMessage[] = [];
      let last = -1;
      let first = true;
      for (const it of kept) {
        const gap = gapBetween(last, it.i);
        if (elision !== "none" && gap > 0) {
          // marker() (bin/context, 7a35982): see buildContext's twin.
          if (run === "") msgs.push({ role: "user", content: `[${gap} steps elided]` });
          else if (!first) msgs.push({ role: "user", content: "[earlier steps elided]" });
        }
        const rl = rowLimit(it.i, total, limit, blockLimit, tailBlock, wholeBlocks);
        const stepOpts = { promptLimit: rl, trajFile: absFile, fullTypes };
        const c = cliRtrim(cliRenderStep(it.row, stepOpts));
        // `kept` already excludes role === "exclude"; narrow for ChatMessage.
        if (c !== "") msgs.push({ role: it.role as "user" | "assistant", content: c });
        last = it.i;
        first = false;
      }
      const tg = gapBetween(last, total);
      if (elision !== "none" && tg > 0 && run === "") msgs.push({ role: "user", content: `[${tg} steps elided]` });
      // jqJson (not plain JSON.stringify): jq escapes U+007F where Node does
      // not; this keeps the final array byte-exact with Bash and makes
      // --max-bytes count the 6-byte escape the way Bash's wc -c does.
      return jqJson(mergeRoles(msgs));
    };

    // Empty trajectory: output empty messages array (with trailing newline).
    if (N === 0) {
      io.stdout("[]\n");
      return 0;
    }

    // render_at (bin/context, 0f8b49e): CTX_BLOCK_LIMIT falls back to
    // CTX_PROMPT_LIMIT when unset — no band at all, matching upstream exactly.
    const blockLimit0 = blockLimitOpt !== "" ? ctxInt(blockLimitOpt) : promptLimit;
    const result = renderMsgs(promptLimit, blockLimit0);

    // No budget: print the array (NO trailing newline — matches `printf '%s'`).
    if (maxBytes === null) {
      io.stdout(result);
      return 0;
    }

    let resultBytes = Buffer.byteLength(result, "utf8");
    if (resultBytes <= maxBytes) {
      io.stdout(result);
      return 0;
    }

    // Binary search the largest prompt_limit whose render fits the byte budget.
    let lo = 0;
    let hi = promptLimit;
    let best = result;
    let bestBytes = resultBytes;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const tryResult = renderMsgs(mid, mid);
      const tryBytes = Buffer.byteLength(tryResult, "utf8");
      if (tryBytes <= maxBytes) {
        best = tryResult;
        bestBytes = tryBytes;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (bestBytes > maxBytes) {
      // Even the tightest render overflows: hard-truncate to the byte budget.
      io.stdout(Buffer.from(best, "utf8").subarray(0, maxBytes));
      io.stderr("[budget exceeded: trajectory too dense]");
    } else {
      io.stdout(best);
    }
    return 0;
  } catch (e) {
    if (e instanceof ContextExit) {
      if (e.dieMsg !== undefined) io.stderr(`context: error: ${e.dieMsg}\n`);
      return e.code;
    }
    throw e;
  }
}
