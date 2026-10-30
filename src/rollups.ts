// rollups.ts — tiered-memory rollups + staircase context (SPEC §6; bin/recap
// `--context`, lines 496-790; design/tiered_memory.md).
//
// A logarithmic pyramid of first-person summaries so a single bounded context
// always spans the whole trajectory. Tier k holds one sealed block per F^k
// filtered steps, rolled up from F tier-(k-1) children. Blocks are keyed by
// ABSOLUTE filtered-step-index range, sealed immutable and cached forever under
// <traj-dir>/rollups/tK/<start>-<end>.json; only the frontier (newly-complete
// blocks) is built each run. A `--context` assembly is a STAIRCASE — coarsest
// tier reaching back to step 0 → progressively finer → the last ~R raw steps
// verbatim — always reaching step 0, bounded at ≈ R + F·log_F N lines.
//
// ─────────────────────────────────────────────────────────────────────────────
// PARITY BOUNDARY. Everything in this file is on the DETERMINISTIC ENVELOPE
// except the block SUMMARY / THEMES / (LLM-chosen) STEP_IDS, which are produced
// by an injected `Summarize` (the LLM) and are non-deterministic. The port
// holds parity on: which step-index ranges seal into which tier blocks
// (`buildPlan`), block sealing rules + absolute-range file keys (`blockKey`,
// `sealTier1`/`sealTierK`), the deterministic step_id FALLBACKS, the
// forward-only enable marker (`startIndex`), the raw-tail size (`resolveR`),
// and the staircase selection (`planStaircase` + `resolveSegments`). Summary
// text is NOT held to parity — assert on structure/ranges/tier-membership.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";

// --- Constants (bin/recap:41-54) --------------------------------------------

/** F: children per tier; tier k covers F^k steps (ROLLUP_FANOUT, recap:51). */
export const ROLLUP_FANOUT_DEFAULT = 10;
/**
 * Stamped into sealed blocks for honest determinism (recap:54; v2 = first
 * person; v3 = outcomes, not temperament; v5 = supersession citations).
 * PORT-NOTE (1c: f6f854c) — upstream-next bumped 2→3 alongside the
 * _ROLLUP_SYSTEM reword below ("outcomes not temperament", bin/recap:54).
 * PORT-NOTE (sync 2e39a3f, abb38b5): 3→5 (there is no v4) with the
 * supersession-citation sentence added to _ROLLUP_SYSTEM.
 */
export const ROLLUP_PROMPT_VERSION = 5;
/** Cached-render row-format version (recap:46). */
export const RENDER_VERSION = 1;
/** Absolute ceiling on the auto budget (RECAP_CONTEXT_BUDGET_MAX, recap:542). */
export const RECAP_CONTEXT_BUDGET_MAX = 4000;

/**
 * Step types that carry narrative signal at recap altitude; everything else
 * (idle, reasoning, shell-output, prompt echoes…) is noise (recap:41, and the
 * `keep` field of the real rendered.meta.json).
 */
export const KEEP_TYPES = [
  "thought",
  "action",
  "observation",
  "message",
  "feedback",
  "final",
  "shellm-run",
  "merge",
] as const;

/**
 * The first-person rollup system prompt (recap:505-508). Given to the LLM.
 * PORT-NOTE (1c: f6f854c) — "v3: outcomes, not temperament": asks for
 * outcomes/decisions/open-threads and forbids temperament words so the
 * summaries stop describing the mind as disciplined or restrained and the
 * mind stops reading that as an instruction.
 */
export const ROLLUP_SYSTEM =
  'You are the AI agent whose life log this is. Summarize this one slice of your own history in the FIRST PERSON — say "I", never "the agent". The input is a chronological list of lines: either raw steps "[id] type: content", or child rollup summaries (already first person). Child rollup summaries arrive prefixed by their step-id list, e.g. "[id1,id2] I did X"; when your summary corrects or supersedes a claim stated in an earlier child window supplied in this same input, and the correcting evidence is also present in this input, name that child by quoting its "[id,...]" prefix verbatim in your summary text, e.g. "this corrects [old-ids]: the earlier claim of X is superseded because Y". Cite only prefixes actually supplied here; do not invent or infer a prefix for an unseen window. This names a correction target in the new parent summary; it does not rewrite or link separately sealed siblings that are absent from this input. Reply with ONLY a JSON object, no markdown fences:\n' +
  '{"summary": "2-3 first-person sentences on outcomes: what I did, decided, learned, and left open, naming people, artifacts, and threads. Events, not my character: no words for my habits or temperament (not disciplined, restrained, patient, waiting mode); if I idled, say once what I was waiting for",\n' +
  ' "themes": ["1-4 short kebab-case topics"],\n' +
  ' "step_ids": ["up to 4 of the most important 8-char step ids that literally appear in the input"]}';

// --- The sealed block schema (recap:568-574, 598-604) -----------------------

/** One sealed, immutable rollup block. Keyed on disk by [start,end). */
export interface RollupBlock {
  tier: number;
  /** Absolute filtered-step index, inclusive. */
  start: number;
  /** Absolute filtered-step index, exclusive. */
  end: number;
  /** end - start (= F^tier for a complete block). */
  n: number;
  /** LLM-generated (NON-DETERMINISTIC). */
  summary: string;
  /** LLM-generated (NON-DETERMINISTIC). */
  themes: string[];
  /** LLM-chosen ids with a deterministic fallback (see seal*). */
  step_ids: string[];
  model: string;
  prompt_version: number;
  created: string;
}

/** The LLM's contribution to a block (the ONLY non-deterministic part). */
export interface RollupBody {
  summary: string;
  themes: string[];
  step_ids: string[];
}

/**
 * Injected summarizer (the LLM). Kept out of the deterministic core so unit
 * tests mock it. `input` is the assembled child/step text; the tier/start/end
 * are passed through for logging/mocks only.
 */
export type Summarize = (input: string, ctx: { tier: number; start: number; end: number }) => RollupBody;

// --- Pure helpers: fanout math + block keys ---------------------------------

/** 12-digit zero-pad, matching `printf '%012d'` (recap:512). */
export function pad12(n: number): string {
  return String(n).padStart(12, "0");
}

/** F^exp by repeated multiplication (recap:510 `_ctx_pow`). */
export function powFanout(base: number, exp: number): number {
  let r = 1;
  for (let i = 0; i < exp; i++) r *= base;
  return r;
}

/** Relative block key `tK/<start>-<end>.json` (recap:512 `_ctx_blockfile`). */
export function blockKey(tier: number, start: number, end: number): string {
  return `t${tier}/${pad12(start)}-${pad12(end)}.json`;
}

/** Absolute block path under a rollup dir. */
export function blockPath(rollupDir: string, tier: number, start: number, end: number): string {
  return path.join(rollupDir, blockKey(tier, start, end));
}

// --- The tiering / fanout layout (recap:629-641 `_ctx_build`) ---------------

/** One block to seal, in bottom-up build order. */
export interface SealTask {
  tier: number;
  s: number;
  e: number;
}

/**
 * The set + order of complete blocks to seal for a trajectory of `n` filtered
 * steps, forward-only from `start`. Tier 1 blocks span F steps, tier 2 span
 * F^2, etc. A tier's block b spans [b·blk, (b+1)·blk) and is emitted only when
 * F full children exist (i.e. blk ≤ n and (b+1)·blk ≤ n) and its start is at or
 * after the enable marker. Mirrors `_ctx_build` exactly (bottom-up, tier
 * ascending, blocks ascending). Blocks older than `start` are left for a
 * one-time `--backfill`.
 */
export function buildPlan(n: number, start: number, fanout: number = ROLLUP_FANOUT_DEFAULT): SealTask[] {
  const tasks: SealTask[] = [];
  let tier = 1;
  let blk = fanout;
  while (blk <= n) {
    const nblocks = Math.floor(n / blk);
    for (let b = 0; b < nblocks; b++) {
      const s = b * blk;
      const e = (b + 1) * blk;
      if (s < start) continue;
      tasks.push({ tier, s, e });
    }
    tier += 1;
    blk *= fanout;
  }
  return tasks;
}

// --- Forward-only enable marker (recap:611-624 `_ctx_start_index`) -----------

/**
 * The filtered-step index from which blocks are auto-built. First enable
 * records "now" (= n) so tiered memory works GOING FORWARD without a
 * synchronous build of pre-existing history; `--backfill` resets to 0. The
 * marker is always snapped DOWN to a FANOUT boundary, otherwise the block
 * straddling it would be unbuildable forever (a permanent coverage hole).
 */
export function startIndex(opts: {
  n: number;
  backfill?: boolean;
  /** From an existing rollups/meta.json; null/undefined = no meta yet. */
  metaStartIndex?: number | null;
  fanout?: number;
}): number {
  const fanout = opts.fanout ?? ROLLUP_FANOUT_DEFAULT;
  if (opts.backfill) return 0;
  let s: number;
  if (opts.metaStartIndex != null && Number.isInteger(opts.metaStartIndex) && opts.metaStartIndex >= 0) {
    s = opts.metaStartIndex;
  } else if (opts.metaStartIndex != null) {
    // Malformed marker → 0, matching the bash `|| s=0` guard (recap:615-616).
    s = 0;
  } else {
    s = opts.n;
  }
  return Math.floor(s / fanout) * fanout;
}

// --- Budget → raw-tail size R (recap:514-551) -------------------------------

/** Resolve the inference model's context window in tokens (recap:515-524). */
export function modelWindow(model: string | undefined, override?: string): number {
  const m = override ?? "auto";
  if (m !== "auto") {
    const parsed = Number(m);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const name = model ?? "";
  if (/claude|opus|sonnet|haiku/.test(name)) return 200000;
  if (/gpt-4\.1|o1|o3|o4/.test(name)) return 1000000;
  if (name === "") return 200000;
  return 128000;
}

/**
 * Raw-tail size R: verbatim recent steps under the staircase (recap:530-551).
 * `rawTail` overrides directly; otherwise derived from `budget` (auto = min(0.6
 * · window, cap)), taking ~40% of budget at ~125 tokens/step, floored at 20 and
 * capped at n. All integer arithmetic, matching bash `$(( ))`.
 */
export function resolveR(opts: {
  n: number;
  rawTail?: number | "auto";
  budget?: number | "auto";
  window: number;
  budgetCap?: number;
}): number {
  const { n, window } = opts;
  const rawTail = opts.rawTail ?? "auto";
  if (rawTail !== "auto") return rawTail;
  const budgetIn = opts.budget ?? "auto";
  const cap = opts.budgetCap ?? RECAP_CONTEXT_BUDGET_MAX;
  let budget: number;
  if (budgetIn === "auto") {
    budget = Math.floor((window * 6) / 10);
    if (budget > cap) budget = cap;
  } else {
    budget = budgetIn;
  }
  let r = Math.floor(Math.floor((budget * 4) / 10) / 125);
  if (r < 20) r = 20;
  if (r > n) r = n;
  return r;
}

// --- Step rendering: raw steps → filtered TSV-equivalent rows ----------------
// (recap:182-244 `_render_steps`). Deterministic filter + display text. Epoch
// minutes are computed for parity of the row shape but are NOT used by the
// rollup pyramid (rollups seal on fixed F-blocks, never on time gaps).

export interface RenderedRow {
  /** 1-based raw jsonl line the step came from. */
  rawLine: number;
  /** 8-char step id. */
  stepId: string;
  /** First 16 chars of the ts. */
  ts: string;
  /** The display text (the `cut -f4` column: what the LLM/raw-tail sees). */
  text: string;
  /** UTC epoch-minutes, or "" when the ts doesn't parse. */
  epochMin: string;
}

const KEEP_SET: ReadonlySet<string> = new Set(KEEP_TYPES);

/** Collapse tabs/newlines/CRs to single spaces, matching `gsub("[\t\n\r]+"; " ")`. */
function squashWs(s: string): string {
  return s.replace(/[\t\n\r]+/g, " ");
}

/** UTC epoch-minutes from an ISO-ish ts (recap:191-207). "" when unparseable. */
export function epochMin(ts: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{4})?/.exec(ts);
  if (!m) return "";
  const y0 = Number(m[1]);
  const mo0 = Number(m[2]);
  const d0 = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const tz = m[8];
  const y = mo0 <= 2 ? y0 - 1 : y0;
  const mm = mo0 <= 2 ? mo0 + 12 : mo0;
  const days =
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) +
    Math.floor((153 * (mm + 1)) / 5) +
    d0;
  let val = days * 1440 + h * 60 + mi;
  if (tz != null && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    val -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  }
  return String(val);
}

/** The `cut -f4` display text for one step (recap:214-240). */
export function renderStepText(row: Record<string, unknown>): string {
  const id8 = String(row["step_id"] ?? "?").slice(0, 8);
  const type = String(row["type"] ?? "");
  const source = row["source"];
  const launchedBy = row["launched_by"];
  const from = row["from"];
  let head = "[" + id8 + "] " + type;
  if (source) head += "(" + String(source) + ")";
  else if (launchedBy) head += "(" + String(launchedBy) + ")";
  if (from) head += " " + String(from) + "→" + String(row["to"] ?? "?");
  head += ": ";

  let payload: string;
  if (type === "shellm-run") {
    // The ~500-char launcher argv is identical every wake and says nothing the
    // model can act on; keep only wake/model, plus the cmd tail for a
    // self-started run (recap:223-235).
    payload = "";
    if (row["wake"]) payload += "wake " + String(row["wake"]) + ", ";
    payload += "model " + String(row["model"] ?? "?");
    const lb = String(launchedBy ?? "");
    const cmd = String(row["command"] ?? "");
    // `cut -c` counts code points; slice by code point so astral chars (emoji,
    // supplementary-plane CJK) don't truncate at half length.
    if (lb === "" && cmd !== "") payload += ", cmd " + [...squashWs(cmd)].slice(-200).join("");
  } else {
    const raw = row["content"] ?? row["command"] ?? row["tldr"] ?? "";
    payload = [...squashWs(String(raw))].slice(0, 500).join("");
  }
  return head + payload;
}

/**
 * Filter raw steps to signal rows and render each (recap:182-244). Keeps only
 * KEEP_TYPES and drops `source == "seed"`. The 0-based index of a row in the
 * returned array IS its filtered-step index (block math uses [s,e) over it).
 */
export function renderSteps(steps: Record<string, unknown>[]): RenderedRow[] {
  const out: RenderedRow[] = [];
  steps.forEach((row, i) => {
    const type = String(row["type"] ?? "");
    if (!KEEP_SET.has(type)) return;
    if (row["source"] === "seed") return;
    const ts = String(row["ts"] ?? "");
    out.push({
      rawLine: i + 1,
      stepId: String(row["step_id"] ?? "?").slice(0, 8),
      ts: ts.slice(0, 16),
      text: renderStepText(row),
      epochMin: epochMin(ts),
    });
  });
  return out;
}

// --- Sealing (recap:553-605). The LLM is injected; fallbacks are deterministic.

interface SealCommon {
  summarize: Summarize;
  model: string;
  created: string;
  promptVersion?: number;
}

/**
 * Seal one tier-1 block over filtered rows [start,end). The block's `n` and
 * key are deterministic; `summary`/`themes` come from the LLM; `step_ids` use
 * the LLM's choice, falling back to [firstId, lastId] when it returns none
 * (recap:554-575).
 */
export function sealTier1(
  opts: SealCommon & { start: number; end: number; rows: RenderedRow[] }
): RollupBlock {
  const { start, end, rows } = opts;
  const text = rows.map((r) => r.text).join("\n");
  const fid = rows.length > 0 ? rows[0]!.stepId : "";
  const lid = rows.length > 0 ? rows[rows.length - 1]!.stepId : "";
  const body = opts.summarize(text, { tier: 1, start, end });
  const stepIds = body.step_ids.length === 0 ? [fid, lid] : body.step_ids;
  return {
    tier: 1,
    start,
    end,
    n: end - start,
    summary: body.summary ?? "",
    themes: body.themes ?? [],
    step_ids: stepIds,
    model: opts.model,
    prompt_version: opts.promptVersion ?? ROLLUP_PROMPT_VERSION,
    created: opts.created,
  };
}

/** The child-summary input lines fed to the LLM for a tier-k seal (recap:587). */
export function childInputLines(children: RollupBlock[]): string {
  // Each child renders as `[id,id,…] summary`, one per line, trailing newline
  // per child (bash `lines+="…"$'\n'`).
  return children.map((c) => `[${c.step_ids.join(",")}] ${c.summary}`).join("\n") + (children.length ? "\n" : "");
}

/** The deterministic step_id fallback for a tier-k block: first 4 non-empty
 *  child.step_ids[0] (recap:588,596,603). */
export function fallbackStepIdsTierK(children: RollupBlock[]): string[] {
  const out: string[] = [];
  for (const c of children) {
    const first = c.step_ids[0];
    if (first != null && first !== "") {
      out.push(first);
      if (out.length >= 4) break;
    }
  }
  return out;
}

/**
 * Seal one tier-k block (k>1) over [start,end), rolled up from its F tier-(k-1)
 * children. `children` MUST be the F child blocks in ascending order; a missing
 * child is a corrupt state (in a forward-only build every in-range child is
 * already sealed). `step_ids` fall back to the children's first ids (recap:578-605).
 */
export function sealTierK(
  opts: SealCommon & { tier: number; start: number; end: number; fanout: number; children: RollupBlock[] }
): RollupBlock {
  const { tier, start, end, children } = opts;
  const input = childInputLines(children);
  const body = opts.summarize(input, { tier, start, end });
  const stepIds = body.step_ids.length === 0 ? fallbackStepIdsTierK(children) : body.step_ids;
  return {
    tier,
    start,
    end,
    n: end - start,
    summary: body.summary ?? "",
    themes: body.themes ?? [],
    step_ids: stepIds,
    model: opts.model,
    prompt_version: opts.promptVersion ?? ROLLUP_PROMPT_VERSION,
    created: opts.created,
  };
}

// --- Staircase assembly (recap:643-728) -------------------------------------

/** One positional staircase segment (a tier-k slot covering [s,e)). */
export interface Segment {
  tier: number;
  s: number;
  e: number;
}

export interface StaircasePlan {
  /** F-snapped boundary between summarized past [0,cut0) and raw tail [cut0,n). */
  cut0: number;
  /** Coarse→fine segments in EMIT order (highest tier first, ascending within a tier). */
  segments: Segment[];
  /** Raw-tail range [rawTailStart, rawTailEnd) = [cut0, n). */
  rawTailStart: number;
  rawTailEnd: number;
  /** n - cut0 (verbatim recent step count). */
  rawTailCount: number;
}

/**
 * Positional base-F decomposition of [0,cut0) into staircase segments, in emit
 * order (recap:647-690). cut0 = ⌊(n-r)/F⌋·F. The older region is decomposed so
 * each tier contributes at most F-1 blocks and coverage is gapless; emission is
 * coarsest tier first, oldest block first within a tier (chronological, since
 * coarser blocks always cover strictly older regions).
 */
export function planStaircase(
  n: number,
  r: number,
  fanout: number = ROLLUP_FANOUT_DEFAULT
): StaircasePlan {
  let cut0 = Math.floor((n - r) / fanout) * fanout;
  if (cut0 < 0) cut0 = 0;

  // Build segments tier-ascending / start-ascending (recap:651-664).
  const built: Segment[] = [];
  let remaining = cut0;
  let tier = 1;
  while (remaining > 0) {
    const blk = powFanout(fanout, tier);
    const coarser = blk * fanout;
    const chunk = remaining - Math.floor(remaining / coarser) * coarser;
    if (chunk > 0) {
      const a = remaining - chunk;
      for (let x = a; x < remaining; x += blk) built.push({ tier, s: x, e: x + blk });
    }
    remaining = remaining - chunk;
    tier += 1;
    if (blk > cut0) break;
  }

  // Re-order for emission: highest tier first, ascending start within tier
  // (recap:672-686). Walk tiers descending; within a tier keep append order.
  let maxTier = 0;
  for (const seg of built) if (seg.tier > maxTier) maxTier = seg.tier;
  const segments: Segment[] = [];
  for (let t = maxTier; t >= 1; t--) {
    for (const seg of built) if (seg.tier === t) segments.push(seg);
  }

  return { cut0, segments, rawTailStart: cut0, rawTailEnd: n, rawTailCount: n - cut0 };
}

/**
 * Flatten planned segments into the blocks actually emitted, applying the
 * `_ctx_emit_seg` descent (recap:703-728):
 *  - a segment wholly before the enable marker (e ≤ start) is pruned;
 *  - a present block is emitted as-is;
 *  - a MISSING coarse block (tier>1) — expected when it straddles the marker —
 *    descends into its F tier-(k-1) children and emits whatever exists;
 *  - a missing tier-1 block is truly absent history (nothing emitted).
 * `blockExists(tier,s,e)` reports sealed-block presence.
 */
export function resolveSegments(
  segments: Segment[],
  blockExists: (tier: number, s: number, e: number) => boolean,
  start: number,
  fanout: number = ROLLUP_FANOUT_DEFAULT
): Segment[] {
  const out: Segment[] = [];
  const emit = (tier: number, s: number, e: number): void => {
    if (e <= start) return; // prune pre-marker (recap:711)
    if (blockExists(tier, s, e)) {
      out.push({ tier, s, e });
      return;
    }
    if (tier <= 1) return; // tier-1 miss = absent history (recap:723)
    const blk = powFanout(fanout, tier - 1);
    for (let c = s; c < e; c += blk) emit(tier - 1, c, c + blk);
  };
  for (const seg of segments) emit(seg.tier, seg.s, seg.e);
  return out;
}

// --- Text rendering of the staircase (recap:688-720) ------------------------

export const LIFE_HEADER = "=== YOUR LIFE SO FAR — summarized, oldest first ===";
export function rawTailHeader(count: number): string {
  return `=== RIGHT NOW — the last ${count} steps, verbatim ===`;
}

/** One emitted coarse line: `[tK · steps s–e] summary   (id id …)` (recap:718). */
export function renderBlockLine(b: RollupBlock): string {
  return `[t${b.tier} · steps ${b.start}–${b.end}] ${b.summary}   (${b.step_ids.join(" ")})`;
}

/**
 * Render the full staircase string, matching `_ctx_assemble`'s stdout
 * (recap:672-690, 703-728): the life section (only when a block emits) then a
 * blank line, then the raw-tail header and the verbatim tail rows.
 *
 * `getBlock(tier,s,e)` returns a sealed block or undefined; `rows` is the full
 * rendered row list (raw-tail text is sliced from it).
 */
export function renderStaircase(
  plan: StaircasePlan,
  emitted: Segment[],
  getBlock: (tier: number, s: number, e: number) => RollupBlock | undefined,
  rows: RenderedRow[]
): string {
  const lines: string[] = [];
  let emittedAny = false;
  for (const seg of emitted) {
    const b = getBlock(seg.tier, seg.s, seg.e);
    if (!b) continue;
    if (!emittedAny) {
      lines.push(LIFE_HEADER);
      emittedAny = true;
    }
    lines.push(renderBlockLine(b));
  }
  if (emittedAny) lines.push(""); // trailing blank line before the raw tail
  lines.push(rawTailHeader(plan.rawTailCount));
  for (let i = plan.rawTailStart; i < plan.rawTailEnd; i++) {
    const row = rows[i];
    if (row) lines.push(row.text);
  }
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// FS-backed build + assemble (the wire-in). Reproduces `_ctx_build` and
// `_ctx_assemble` against a real rollups/ dir, with the LLM injected. The
// monolith folds `lifeContext(...)` into its route prompt's `life_section`
// exactly as `_life_context` / common.sh:_life_context does (SPEC §6;
// thinkers/monolith/step:220-232). See monolith.ts:114 for the seam — this
// module stays self-contained so nothing else needs editing to consume it.
// ─────────────────────────────────────────────────────────────────────────────

export interface RollupContextOptions {
  /** The rendered signal rows (0-based index = filtered-step index). */
  rows: RenderedRow[];
  /** Where sealed blocks live: <traj-dir>/rollups. */
  rollupDir: string;
  /** The LLM (injected). */
  summarize: Summarize;
  model: string;
  /** Deterministic clock for `created`/meta (defaults to wall clock). */
  now?: () => string;
  fanout?: number;
  /** Raw-tail size R, or "auto" to derive from budget. */
  rawTail?: number | "auto";
  budget?: number | "auto";
  /** Model context window (tokens) or "auto" from the model name. */
  window?: number | "auto";
  backfill?: boolean;
  /** "auto" build frontier | "cached" no build | "rebuild" drop tK first. */
  mode?: "auto" | "cached" | "rebuild";
}

function nowStamp(): string {
  // `date +%Y-%m-%dT%H:%M:%S` — local time, no offset (recap uses this).
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readMetaStartIndex(rollupDir: string): number | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(rollupDir, "meta.json"), "utf8"));
    const s = meta?.start_index;
    return Number.isInteger(s) ? s : 0;
  } catch {
    return null;
  }
}

function readBlockFile(rollupDir: string, tier: number, s: number, e: number): RollupBlock | undefined {
  try {
    return JSON.parse(fs.readFileSync(blockPath(rollupDir, tier, s, e), "utf8")) as RollupBlock;
  } catch {
    return undefined;
  }
}

/**
 * Seal every complete frontier block at or after `start`, bottom-up, writing
 * one immutable JSON file per block. Existing files are skipped (idempotent;
 * only the frontier calls the LLM). Returns the tasks that were newly sealed.
 * Mirrors `_ctx_build` + `_ctx_seal_tier1`/`_ctx_seal_tierk`.
 */
export function buildRollups(opts: RollupContextOptions & { start: number }): SealTask[] {
  const fanout = opts.fanout ?? ROLLUP_FANOUT_DEFAULT;
  const created = opts.now ? opts.now() : nowStamp();
  const n = opts.rows.length;
  const sealed: SealTask[] = [];
  for (const task of buildPlan(n, opts.start, fanout)) {
    const file = blockPath(opts.rollupDir, task.tier, task.s, task.e);
    if (fs.existsSync(file)) continue; // immutable — never re-seal
    let block: RollupBlock;
    if (task.tier === 1) {
      block = sealTier1({
        start: task.s,
        end: task.e,
        rows: opts.rows.slice(task.s, task.e),
        summarize: opts.summarize,
        model: opts.model,
        created,
      });
    } else {
      const childBlk = powFanout(fanout, task.tier - 1);
      const children: RollupBlock[] = [];
      for (let c = task.s; c < task.e; c += childBlk) {
        const child = readBlockFile(opts.rollupDir, task.tier - 1, c, c + childBlk);
        if (!child) throw new Error(`rollup t${task.tier} [${task.s},${task.e}): missing child t${task.tier - 1} [${c},${c + childBlk})`);
        children.push(child);
      }
      block = sealTierK({
        tier: task.tier,
        start: task.s,
        end: task.e,
        fanout,
        children,
        summarize: opts.summarize,
        model: opts.model,
        created,
      });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(block));
    sealed.push(task);
  }
  return sealed;
}

/**
 * The full `recap --context` run (recap:765-790): resolve R + enable marker,
 * persist meta.json on first enable/backfill, build the frontier (unless
 * cached; rebuild drops tK first), then assemble + return the staircase text.
 */
export function recapContext(opts: RollupContextOptions): string {
  const fanout = opts.fanout ?? ROLLUP_FANOUT_DEFAULT;
  const n = opts.rows.length;
  const window = typeof opts.window === "number" ? opts.window : modelWindow(opts.model);
  const r = resolveR({ n, rawTail: opts.rawTail ?? "auto", budget: opts.budget ?? "auto", window });
  const metaStart = readMetaStartIndex(opts.rollupDir);
  const start = startIndex({ n, backfill: opts.backfill ?? false, metaStartIndex: metaStart, fanout });

  fs.mkdirSync(opts.rollupDir, { recursive: true });
  const metaPath = path.join(opts.rollupDir, "meta.json");
  if (!fs.existsSync(metaPath) || opts.backfill) {
    const stamp = opts.now ? opts.now() : nowStamp();
    fs.writeFileSync(metaPath, JSON.stringify({ start_index: start, updated: stamp }, null, 2) + "\n");
  }

  const mode = opts.mode ?? "auto";
  if (mode === "rebuild") {
    for (const entry of fs.existsSync(opts.rollupDir) ? fs.readdirSync(opts.rollupDir) : []) {
      if (/^t\d+$/.test(entry)) fs.rmSync(path.join(opts.rollupDir, entry), { recursive: true, force: true });
    }
  }
  if (mode !== "cached") buildRollups({ ...opts, start });

  const plan = planStaircase(n, r, fanout);
  const exists = (tier: number, s: number, e: number): boolean => fs.existsSync(blockPath(opts.rollupDir, tier, s, e));
  const emitted = resolveSegments(plan.segments, exists, start, fanout);
  const getBlock = (tier: number, s: number, e: number): RollupBlock | undefined => readBlockFile(opts.rollupDir, tier, s, e);
  return renderStaircase(plan, emitted, getBlock, opts.rows);
}

/**
 * Drop-in for `_life_context` (common.sh:268-275): return the staircase text,
 * degrading to "" on any error so the monolith loop never breaks. Fold the
 * result into the route prompt's `life_section` (monolith.ts:114).
 */
export function lifeContext(opts: RollupContextOptions): string {
  try {
    return recapContext(opts);
  } catch {
    return "";
  }
}
