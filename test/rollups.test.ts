// rollups.test.ts — unit tests for the DETERMINISTIC envelope of tiered-memory
// rollups + staircase context (SPEC §6; bin/recap `--context`).
//
// Parity is on structure only: which step-index ranges seal into which tier
// blocks, block sealing rules + absolute-range file keys, the deterministic
// step_id fallbacks, the enable marker, the raw-tail size, and the staircase
// selection. The block SUMMARY/THEMES/(LLM-chosen) step_ids are
// non-deterministic — the LLM is MOCKED and never asserted on for text.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pad12,
  powFanout,
  blockKey,
  blockPath,
  buildPlan,
  startIndex,
  modelWindow,
  resolveR,
  renderSteps,
  renderStepText,
  epochMin,
  sealTier1,
  sealTierK,
  childInputLines,
  fallbackStepIdsTierK,
  planStaircase,
  resolveSegments,
  renderStaircase,
  renderBlockLine,
  buildRollups,
  recapContext,
  lifeContext,
  ROLLUP_FANOUT_DEFAULT,
  ROLLUP_PROMPT_VERSION,
  ROLLUP_SYSTEM,
  RECAP_CONTEXT_BUDGET_MAX,
  KEEP_TYPES,
  type RollupBlock,
  type RollupBody,
  type RenderedRow,
  type Segment,
} from "../src/rollups.js";

const F = ROLLUP_FANOUT_DEFAULT;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rollups");

// A deterministic mock LLM: echoes the range so we can assert on plumbing, and
// (by default) returns NO step_ids so the deterministic fallback path is used.
function mockSummarize(overrides?: Partial<RollupBody>): (input: string, ctx: { tier: number; start: number; end: number }) => RollupBody {
  return (_input, ctx) => ({
    summary: `SUMMARY t${ctx.tier} [${ctx.start},${ctx.end})`,
    themes: ["mock"],
    step_ids: [],
    ...overrides,
  });
}

function mkRow(i: number, id: string, text = `row-${i}`): RenderedRow {
  return { rawLine: i + 1, stepId: id, ts: "", text, epochMin: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// PORT-NOTE (1c: f6f854c) — upstream-next bin/recap:54,505-508. "v3: outcomes,
// not temperament" bumped ROLLUP_PROMPT_VERSION 2→3 and reworded _ROLLUP_SYSTEM
// to ask for outcomes/decisions/open-threads and forbid temperament words.
// Byte-exact against the upstream shell single-quoted string (concatenated,
// since Bash embeds literal newlines inside the quotes).
describe("ROLLUP_SYSTEM / ROLLUP_PROMPT_VERSION — f6f854c (v3: outcomes, not temperament), abb38b5 (v5: supersession citations)", () => {
  it("ROLLUP_PROMPT_VERSION is 5 (2e39a3f; there is no v4)", () => {
    expect(ROLLUP_PROMPT_VERSION).toBe(5);
  });

  it("ROLLUP_SYSTEM is byte-identical to upstream-next bin/recap:505-508", () => {
    expect(ROLLUP_SYSTEM).toBe(
      'You are the AI agent whose life log this is. Summarize this one slice of your own history in the FIRST PERSON — say "I", never "the agent". The input is a chronological list of lines: either raw steps "[id] type: content", or child rollup summaries (already first person). Child rollup summaries arrive prefixed by their step-id list, e.g. "[id1,id2] I did X"; when your summary corrects or supersedes a claim stated in an earlier child window supplied in this same input, and the correcting evidence is also present in this input, name that child by quoting its "[id,...]" prefix verbatim in your summary text, e.g. "this corrects [old-ids]: the earlier claim of X is superseded because Y". Cite only prefixes actually supplied here; do not invent or infer a prefix for an unseen window. This names a correction target in the new parent summary; it does not rewrite or link separately sealed siblings that are absent from this input. Reply with ONLY a JSON object, no markdown fences:\n' +
        '{"summary": "2-3 first-person sentences on outcomes: what I did, decided, learned, and left open, naming people, artifacts, and threads. Events, not my character: no words for my habits or temperament (not disciplined, restrained, patient, waiting mode); if I idled, say once what I was waiting for",\n' +
        ' "themes": ["1-4 short kebab-case topics"],\n' +
        ' "step_ids": ["up to 4 of the most important 8-char step ids that literally appear in the input"]}',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("block keys + fanout math", () => {
  it("pads to 12 digits and matches printf %012d", () => {
    expect(pad12(0)).toBe("000000000000");
    expect(pad12(10)).toBe("000000000010");
    expect(pad12(250)).toBe("000000000250");
  });

  it("powFanout is F^exp", () => {
    expect(powFanout(F, 0)).toBe(1);
    expect(powFanout(F, 1)).toBe(10);
    expect(powFanout(F, 2)).toBe(100);
    expect(powFanout(F, 3)).toBe(1000);
  });

  it("blockKey is tK/<start>-<end>.json with 12-digit padding", () => {
    expect(blockKey(1, 0, 10)).toBe("t1/000000000000-000000000010.json");
    expect(blockKey(1, 100, 110)).toBe("t1/000000000100-000000000110.json");
    expect(blockKey(2, 0, 100)).toBe("t2/000000000000-000000000100.json");
  });

  it("blockPath joins under the rollup dir", () => {
    expect(blockPath("/x/rollups", 2, 100, 200)).toBe("/x/rollups/t2/000000000100-000000000200.json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("buildPlan — tiering / fanout layout", () => {
  it("tier 1 spans F, tier 2 spans F^2 (t1=10 raw, t2=10 t1 blocks)", () => {
    const plan = buildPlan(250, 0, F);
    const t1 = plan.filter((p) => p.tier === 1);
    const t2 = plan.filter((p) => p.tier === 2);
    expect(t1).toHaveLength(25);
    expect(t2).toHaveLength(2);
    expect(t1[0]).toEqual({ tier: 1, s: 0, e: 10 });
    expect(t1[24]).toEqual({ tier: 1, s: 240, e: 250 });
    expect(t2[0]).toEqual({ tier: 2, s: 0, e: 100 });
    expect(t2[1]).toEqual({ tier: 2, s: 100, e: 200 });
  });

  it("seals only COMPLETE blocks (F full children); a partial trailing block is not sealed", () => {
    // 105 filtered steps: 10 t1 blocks [0,10)…[90,100) plus [100,110)? no —
    // floor(105/10)=10 blocks up to [90,100); the [100,105) remainder is not a
    // complete block. t2: floor(105/100)=1 block [0,100).
    const plan = buildPlan(105, 0, F);
    const t1 = plan.filter((p) => p.tier === 1);
    const t2 = plan.filter((p) => p.tier === 2);
    expect(t1).toHaveLength(10);
    expect(t1.at(-1)).toEqual({ tier: 1, s: 90, e: 100 });
    expect(t2).toEqual([{ tier: 2, s: 0, e: 100 }]);
  });

  it("no blocks until F steps exist", () => {
    expect(buildPlan(9, 0, F)).toEqual([]);
    expect(buildPlan(10, 0, F)).toEqual([{ tier: 1, s: 0, e: 10 }]);
  });

  it("a third tier appears only at F^3 steps", () => {
    const plan = buildPlan(1000, 0, F);
    expect(plan.filter((p) => p.tier === 3)).toEqual([{ tier: 3, s: 0, e: 1000 }]);
    expect(plan.filter((p) => p.tier === 2)).toHaveLength(10);
    expect(plan.filter((p) => p.tier === 1)).toHaveLength(100);
  });

  it("forward-only: blocks starting before the enable marker are skipped", () => {
    const plan = buildPlan(250, 100, F);
    // t1 blocks with s < 100 are skipped; [100,110)…[240,250) remain (15).
    const t1 = plan.filter((p) => p.tier === 1);
    expect(t1[0]).toEqual({ tier: 1, s: 100, e: 110 });
    expect(t1).toHaveLength(15);
    // t2 [0,100) skipped (s<100); [100,200) kept.
    expect(plan.filter((p) => p.tier === 2)).toEqual([{ tier: 2, s: 100, e: 200 }]);
  });

  it("is emitted bottom-up: all tier-1 before any tier-2", () => {
    const plan = buildPlan(200, 0, F);
    const firstT2 = plan.findIndex((p) => p.tier === 2);
    const lastT1 = plan.map((p) => p.tier).lastIndexOf(1);
    expect(lastT1).toBeLessThan(firstT2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("startIndex — forward-only enable marker", () => {
  it("backfill resets to 0", () => {
    expect(startIndex({ n: 250, backfill: true, metaStartIndex: 137, fanout: F })).toBe(0);
  });

  it("first enable records 'now' (n), snapped down to an F boundary", () => {
    expect(startIndex({ n: 250, metaStartIndex: null, fanout: F })).toBe(250);
    expect(startIndex({ n: 257, metaStartIndex: null, fanout: F })).toBe(250);
  });

  it("existing meta marker is snapped down to an F boundary", () => {
    expect(startIndex({ n: 999, metaStartIndex: 137, fanout: F })).toBe(130);
    expect(startIndex({ n: 999, metaStartIndex: 0, fanout: F })).toBe(0);
    expect(startIndex({ n: 999, metaStartIndex: 200, fanout: F })).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("modelWindow + resolveR — raw-tail budget", () => {
  it("maps model families to context windows", () => {
    expect(modelWindow("claude-sonnet-4-5")).toBe(200000);
    expect(modelWindow("deepseek/deepseek-v4-flash-0731")).toBe(128000);
    expect(modelWindow("gpt-4.1")).toBe(1000000);
    expect(modelWindow("")).toBe(200000);
  });

  it("explicit override wins", () => {
    expect(modelWindow("whatever", "64000")).toBe(64000);
  });

  it("explicit rawTail passes through unchanged", () => {
    expect(resolveR({ n: 500, rawTail: 42, window: 200000 })).toBe(42);
  });

  it("auto budget = min(0.6·window, cap) then 40% at 125 tok/step, floored 20", () => {
    // window 200000 → 0.6·=120000 > cap 4000 → budget 4000 → (4000·0.4)/125 = 12.8 → 12 → floor→ 20 (min).
    expect(resolveR({ n: 5000, rawTail: "auto", budget: "auto", window: 200000 })).toBe(20);
  });

  it("a large explicit budget scales R linearly at 125 tok/step", () => {
    // budget 100000 → (100000·0.4)/125 = 320.
    expect(resolveR({ n: 5000, rawTail: "auto", budget: 100000, window: 200000 })).toBe(320);
  });

  it("R never exceeds n", () => {
    expect(resolveR({ n: 15, rawTail: "auto", budget: 100000, window: 200000 })).toBe(15);
  });

  it("cap constant is 4000", () => {
    expect(RECAP_CONTEXT_BUDGET_MAX).toBe(4000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renderSteps — deterministic filter + display text", () => {
  it("keeps only KEEP_TYPES and drops source==seed; index = filtered position", () => {
    const steps: Record<string, unknown>[] = [
      { type: "trajectory", step_id: "aaaaaaaa", ts: "2026-08-28T10:00" },
      { type: "thought", step_id: "bbbbbbbb", ts: "2026-08-28T10:01", content: "hi", source: "seed" }, // dropped (seed)
      { type: "reasoning", step_id: "cccccccc", ts: "2026-08-28T10:02", thought: "x", cmd: "ls" }, // dropped (not keep)
      { type: "thought", step_id: "dddddddd", ts: "2026-08-28T10:03", content: "kept one" },
      { type: "message", step_id: "eeeeeeee", ts: "2026-08-28T10:04", content: "hello", from: "a", to: "b", source: "chat" },
    ];
    const rows = renderSteps(steps);
    expect(rows.map((r) => r.stepId)).toEqual(["dddddddd", "eeeeeeee"]);
    expect(rows[0]!.rawLine).toBe(4); // 1-based raw line of the kept thought
    expect(rows[0]!.text).toBe("[dddddddd] thought: kept one");
    expect(rows[1]!.text).toBe("[eeeeeeee] message(chat) a→b: hello");
  });

  it("shellm-run text drops the launcher argv, keeps wake+model", () => {
    const t = renderStepText({
      type: "shellm-run",
      step_id: "ffffffff",
      wake: "spontaneous",
      model: "claude",
      launched_by: "dispatcher",
      command: "shellm --very --long --argv " + "x".repeat(400),
    });
    expect(t).toBe("[ffffffff] shellm-run(dispatcher): wake spontaneous, model claude");
  });

  it("KEEP_TYPES matches the real rendered.meta.json keep set", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, "rendered.meta.json"), "utf8"));
    expect(JSON.parse(meta.keep)).toEqual([...KEEP_TYPES]);
  });

  it("epochMin normalizes mixed timezones (no phantom 8h gaps)", () => {
    // Same instant expressed +0000 and +0800 must yield different epoch-minutes
    // by exactly 480 (the tz offset), so gap math is honest.
    const utc = Number(epochMin("2026-08-28T12:00:00+0000"));
    const cn = Number(epochMin("2026-08-28T12:00:00+0800"));
    expect(utc - cn).toBe(480);
    expect(epochMin("not-a-date")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sealTier1 — sealing rules + deterministic fallback", () => {
  const rows = [mkRow(0, "aaaaaaaa"), mkRow(1, "bbbbbbbb"), mkRow(2, "cccccccc")];

  it("stamps tier/start/end/n/model/prompt_version deterministically", () => {
    const b = sealTier1({ start: 0, end: 10, rows, summarize: mockSummarize(), model: "m", created: "2026-01-01T00:00:00" });
    expect(b.tier).toBe(1);
    expect(b.start).toBe(0);
    expect(b.end).toBe(10);
    expect(b.n).toBe(10); // e - s, not row count
    expect(b.model).toBe("m");
    expect(b.prompt_version).toBe(ROLLUP_PROMPT_VERSION);
    expect(b.created).toBe("2026-01-01T00:00:00");
  });

  it("empty LLM step_ids fall back to [firstId, lastId]", () => {
    const b = sealTier1({ start: 0, end: 10, rows, summarize: mockSummarize(), model: "m", created: "t" });
    expect(b.step_ids).toEqual(["aaaaaaaa", "cccccccc"]);
  });

  it("LLM-provided step_ids are used verbatim when present", () => {
    const b = sealTier1({ start: 0, end: 10, rows, summarize: mockSummarize({ step_ids: ["11111111"] }), model: "m", created: "t" });
    expect(b.step_ids).toEqual(["11111111"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sealTierK — child rollup + deterministic fallback", () => {
  const children: RollupBlock[] = Array.from({ length: 10 }, (_, i) => ({
    tier: 1,
    start: i * 10,
    end: (i + 1) * 10,
    n: 10,
    summary: `child ${i}`,
    themes: [],
    step_ids: [`id${i}aaaaa`, `id${i}bbbbb`],
    model: "m",
    prompt_version: 2,
    created: "t",
  }));

  it("feeds child summaries with their cited ids as the LLM input", () => {
    const lines = childInputLines(children.slice(0, 2));
    expect(lines).toBe("[id0aaaaa,id0bbbbb] child 0\n[id1aaaaa,id1bbbbb] child 1\n");
  });

  it("fallback step_ids = first 4 non-empty child.step_ids[0]", () => {
    expect(fallbackStepIdsTierK(children)).toEqual(["id0aaaaa", "id1aaaaa", "id2aaaaa", "id3aaaaa"]);
  });

  it("fallback skips children whose first id is empty", () => {
    const withEmpties: RollupBlock[] = [
      { ...children[0]!, step_ids: [] },
      { ...children[1]!, step_ids: ["good1aaa"] },
      { ...children[2]!, step_ids: [""] },
      { ...children[3]!, step_ids: ["good2aaa"] },
    ];
    expect(fallbackStepIdsTierK(withEmpties)).toEqual(["good1aaa", "good2aaa"]);
  });

  it("seals with tier/start/end/n from position, fallback ids when LLM empty", () => {
    const b = sealTierK({ tier: 2, start: 0, end: 100, fanout: F, children, summarize: mockSummarize(), model: "m", created: "t" });
    expect(b.tier).toBe(2);
    expect(b.start).toBe(0);
    expect(b.end).toBe(100);
    expect(b.n).toBe(100);
    expect(b.step_ids).toEqual(["id0aaaaa", "id1aaaaa", "id2aaaaa", "id3aaaaa"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("planStaircase — coarse→fine positional decomposition", () => {
  it("clean case: cut0 lands on a tier boundary → one coarse tier + raw tail", () => {
    // n=250, r=50 → cut0 = floor(200/10)*10 = 200. 200 decomposes to two t2 blocks.
    const plan = planStaircase(250, 50, F);
    expect(plan.cut0).toBe(200);
    expect(plan.segments).toEqual([
      { tier: 2, s: 0, e: 100 },
      { tier: 2, s: 100, e: 200 },
    ]);
    expect(plan.rawTailStart).toBe(200);
    expect(plan.rawTailEnd).toBe(250);
    expect(plan.rawTailCount).toBe(50);
  });

  it("staircase: coarse (t2) reaching step 0, then finer (t1), then raw tail", () => {
    // n=250, r=60 → cut0 = floor(190/10)*10 = 190. 190 = 1·100 + 9·10.
    const plan = planStaircase(250, 60, F);
    expect(plan.cut0).toBe(190);
    // Emit order: coarsest first (t2 [0,100)), then t1 [100,110)…[180,190).
    expect(plan.segments[0]).toEqual({ tier: 2, s: 0, e: 100 });
    const t1 = plan.segments.filter((s) => s.tier === 1);
    expect(t1).toHaveLength(9);
    expect(t1[0]).toEqual({ tier: 1, s: 100, e: 110 });
    expect(t1.at(-1)).toEqual({ tier: 1, s: 180, e: 190 });
  });

  it("coverage is gapless and ordered oldest→newest across tiers", () => {
    const plan = planStaircase(250, 60, F);
    // Flatten covered ranges in emit-with-chronology order: segments already
    // emit coarse-first, so re-sort by start to check contiguity to cut0.
    const bystart = [...plan.segments].sort((a, b) => a.s - b.s);
    let cursor = 0;
    for (const seg of bystart) {
      expect(seg.s).toBe(cursor);
      cursor = seg.e;
    }
    expect(cursor).toBe(plan.cut0);
    expect(plan.rawTailStart).toBe(plan.cut0);
  });

  it("each tier contributes at most F-1 blocks", () => {
    // A worst case near a big boundary: n huge, cut0 = 999_990.
    const plan = planStaircase(999_990 + 20, 20, F);
    expect(plan.cut0).toBe(999_990);
    const byTier = new Map<number, number>();
    for (const s of plan.segments) byTier.set(s.tier, (byTier.get(s.tier) ?? 0) + 1);
    for (const count of byTier.values()) expect(count).toBeLessThanOrEqual(F - 1);
  });

  it("young agent (cut0=0): no coarse segments, whole log is the raw tail", () => {
    const plan = planStaircase(8, 20, F); // n<r → cut0 = floor(-12/10)*10 clamped to 0
    expect(plan.cut0).toBe(0);
    expect(plan.segments).toEqual([]);
    expect(plan.rawTailStart).toBe(0);
    expect(plan.rawTailCount).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resolveSegments — emit_seg descent over present/missing blocks", () => {
  const allExist = () => true;

  it("passes present blocks through unchanged", () => {
    const segs: Segment[] = [
      { tier: 2, s: 0, e: 100 },
      { tier: 1, s: 100, e: 110 },
    ];
    expect(resolveSegments(segs, allExist, 0, F)).toEqual(segs);
  });

  it("prunes a segment wholly before the enable marker", () => {
    const segs: Segment[] = [{ tier: 2, s: 0, e: 100 }];
    expect(resolveSegments(segs, allExist, 100, F)).toEqual([]);
  });

  it("descends a MISSING coarse block into its F children (straddle case)", () => {
    // t2 [0,100) missing, but its t1 children [50,60)…[90,100) exist (marker=50).
    const exists = (tier: number, s: number, _e: number) => tier === 1 && s >= 50;
    const emitted = resolveSegments([{ tier: 2, s: 0, e: 100 }], exists, 50, F);
    expect(emitted).toEqual([
      { tier: 1, s: 50, e: 60 },
      { tier: 1, s: 60, e: 70 },
      { tier: 1, s: 70, e: 80 },
      { tier: 1, s: 80, e: 90 },
      { tier: 1, s: 90, e: 100 },
    ]);
  });

  it("a missing tier-1 block is truly absent history (emits nothing)", () => {
    expect(resolveSegments([{ tier: 1, s: 0, e: 10 }], () => false, 0, F)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renderStaircase — text output shape", () => {
  const block = (tier: number, s: number, e: number): RollupBlock => ({
    tier,
    start: s,
    end: e,
    n: e - s,
    summary: `sum ${s}-${e}`,
    themes: [],
    step_ids: ["aaaaaaaa", "bbbbbbbb"],
    model: "m",
    prompt_version: 2,
    created: "t",
  });

  it("renders life header + coarse lines + blank line + raw tail header", () => {
    const rows = Array.from({ length: 12 }, (_, i) => mkRow(i, `id${i}`, `TAIL ${i}`));
    const plan = planStaircase(12, 2, F); // cut0=10, one t1 [0,10)
    const emitted: Segment[] = [{ tier: 1, s: 0, e: 10 }];
    const out = renderStaircase(plan, emitted, (t, s, e) => block(t, s, e), rows);
    const lines = out.split("\n");
    expect(lines[0]).toBe("=== YOUR LIFE SO FAR — summarized, oldest first ===");
    expect(lines[1]).toBe("[t1 · steps 0–10] sum 0-10   (aaaaaaaa bbbbbbbb)");
    expect(lines[2]).toBe(""); // blank separator
    expect(lines[3]).toBe("=== RIGHT NOW — the last 2 steps, verbatim ===");
    expect(lines[4]).toBe("TAIL 10");
    expect(lines[5]).toBe("TAIL 11");
  });

  it("no life section when nothing emitted (young agent): raw-tail header first", () => {
    const rows = Array.from({ length: 5 }, (_, i) => mkRow(i, `id${i}`, `T${i}`));
    const plan = planStaircase(5, 20, F);
    const out = renderStaircase(plan, [], () => undefined, rows);
    expect(out.split("\n")[0]).toBe("=== RIGHT NOW — the last 5 steps, verbatim ===");
    expect(out).not.toContain("YOUR LIFE SO FAR");
  });

  it("renderBlockLine uses en-dash range and space-joined ids", () => {
    expect(renderBlockLine(block(2, 0, 100))).toBe("[t2 · steps 0–100] sum 0-100   (aaaaaaaa bbbbbbbb)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("buildRollups + recapContext — fs-backed, LLM mocked", () => {
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rollups-"));
  }
  function makeRows(n: number): RenderedRow[] {
    return Array.from({ length: n }, (_, i) => mkRow(i, `id${String(i).padStart(6, "0")}`, `step ${i}`));
  }

  it("seals the exact tier layout on disk with absolute-range file keys", () => {
    const dir = tmp();
    const rollupDir = path.join(dir, "rollups");
    const rows = makeRows(250);
    buildRollups({ rows, rollupDir, summarize: mockSummarize(), model: "mock", now: () => "T", start: 0 });
    expect(fs.readdirSync(path.join(rollupDir, "t1")).sort()).toContain("000000000000-000000000010.json");
    expect(fs.readdirSync(path.join(rollupDir, "t1"))).toHaveLength(25);
    expect(fs.readdirSync(path.join(rollupDir, "t2")).sort()).toEqual([
      "000000000000-000000000100.json",
      "000000000100-000000000200.json",
    ]);
    const t2 = JSON.parse(fs.readFileSync(path.join(rollupDir, "t2", "000000000000-000000000100.json"), "utf8"));
    expect(t2).toMatchObject({ tier: 2, start: 0, end: 100, n: 100, prompt_version: ROLLUP_PROMPT_VERSION, model: "mock" });
  });

  it("is immutable + incremental: existing blocks are never re-sealed", () => {
    const dir = tmp();
    const rollupDir = path.join(dir, "rollups");
    let calls = 0;
    const counting = (input: string, ctx: { tier: number; start: number; end: number }) => {
      calls += 1;
      return mockSummarize()(input, ctx);
    };
    buildRollups({ rows: makeRows(100), rollupDir, summarize: counting, model: "m", now: () => "T", start: 0 });
    const firstCalls = calls; // 10 t1 + 1 t2 = 11
    expect(firstCalls).toBe(11);
    // Re-run with more steps: only the NEW frontier blocks call the LLM.
    buildRollups({ rows: makeRows(120), rollupDir, summarize: counting, model: "m", now: () => "T", start: 0 });
    expect(calls - firstCalls).toBe(2); // t1 [100,110),[110,120); no new t2 (needs 200)
  });

  it("tier-2 block cites its children's ids via the deterministic fallback", () => {
    const dir = tmp();
    const rollupDir = path.join(dir, "rollups");
    buildRollups({ rows: makeRows(100), rollupDir, summarize: mockSummarize(), model: "m", now: () => "T", start: 0 });
    const t2 = JSON.parse(fs.readFileSync(path.join(rollupDir, "t2", "000000000000-000000000100.json"), "utf8"));
    // Each t1 child fell back to [firstId,lastId]; child c's firstId is id{c*10}.
    expect(t2.step_ids).toEqual(["id000000", "id000010", "id000020", "id000030"]);
  });

  it("recapContext writes meta.json on first enable and returns a raw-tail-only staircase for a young log", () => {
    const dir = tmp();
    const rollupDir = path.join(dir, "rollups");
    const rows = makeRows(8); // < F: nothing seals; forward-only marker = 0 (snapped)
    const out = recapContext({ rows, rollupDir, summarize: mockSummarize(), model: "mock", now: () => "T", rawTail: 20 });
    const meta = JSON.parse(fs.readFileSync(path.join(rollupDir, "meta.json"), "utf8"));
    expect(meta.start_index).toBe(0);
    expect(out).toContain("=== RIGHT NOW — the last 8 steps, verbatim ===");
    expect(out).toContain("step 7");
    expect(out).not.toContain("YOUR LIFE SO FAR");
  });

  it("recapContext assembles a full staircase (coarse→fine→raw) after a backfill build", () => {
    const dir = tmp();
    const rollupDir = path.join(dir, "rollups");
    const rows = makeRows(250);
    const out = recapContext({
      rows,
      rollupDir,
      summarize: mockSummarize(),
      model: "mock",
      now: () => "T",
      rawTail: 60, // cut0=190 → t2[0,100), t1[100,110)…[180,190)
      backfill: true,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("=== YOUR LIFE SO FAR — summarized, oldest first ===");
    expect(lines[1]).toContain("[t2 · steps 0–100]");
    expect(out).toContain("[t1 · steps 100–110]");
    expect(out).toContain("[t1 · steps 180–190]");
    expect(out).toContain("=== RIGHT NOW — the last 60 steps, verbatim ===");
    expect(out).toContain("step 190"); // first raw-tail step
    expect(out).toContain("step 249"); // last
    expect(out).not.toContain("step 189"); // still summarized, not raw
  });

  it("lifeContext degrades to empty string on error", () => {
    // A non-existent parent that cannot be created (file in the path) → throw → "".
    const dir = tmp();
    const notADir = path.join(dir, "afile");
    fs.writeFileSync(notADir, "x");
    const out = lifeContext({ rows: makeRows(10), rollupDir: path.join(notADir, "rollups"), summarize: mockSummarize(), model: "m" });
    expect(out).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARITY ENVELOPE — against the REAL sealed rollup data (pax 55fd5932-root).
// Structure/ranges/tier-membership/schema only; summary text is NOT asserted.
describe("parity: real sealed rollup blocks (deterministic envelope)", () => {
  function realBlocks(tier: number): { name: string; json: RollupBlock }[] {
    const d = path.join(FIXTURES, `t${tier}`);
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(d, name), "utf8")) as RollupBlock }));
  }

  it("real data is 25 t1 blocks (F=10 raw) + 2 t2 blocks (10 t1 each)", () => {
    expect(realBlocks(1)).toHaveLength(25);
    expect(realBlocks(2)).toHaveLength(2);
  });

  it("buildPlan(250, 0, 10) reproduces the on-disk block set exactly", () => {
    const onDisk = new Set<string>();
    for (const tier of [1, 2]) for (const { json } of realBlocks(tier)) onDisk.add(blockKey(json.tier, json.start, json.end));
    const planned = new Set(buildPlan(250, 0, F).map((p) => blockKey(p.tier, p.s, p.e)));
    expect(planned).toEqual(onDisk);
  });

  it("every real block's filename encodes its own [start,end) range (absolute step index)", () => {
    for (const tier of [1, 2]) {
      for (const { name, json } of realBlocks(tier)) {
        expect(name).toBe(`${pad12(json.start)}-${pad12(json.end)}.json`);
        expect(blockPath(FIXTURES, json.tier, json.start, json.end)).toBe(path.join(FIXTURES, `t${tier}`, name));
      }
    }
  });

  it("every real block carries the sealed-block schema with n = end - start = F^tier", () => {
    for (const tier of [1, 2]) {
      for (const { json } of realBlocks(tier)) {
        expect(json.tier).toBe(tier);
        expect(json.n).toBe(json.end - json.start);
        expect(json.n).toBe(powFanout(F, tier));
        // Sealed blocks are cached forever and never re-stamped: this fixture
        // (pax 55fd5932-root) was sealed under prompt_version 2, before f6f854c
        // bumped the CURRENT ROLLUP_PROMPT_VERSION to 3 — the two need not match.
        expect(json.prompt_version).toBe(2);
        expect(typeof json.summary).toBe("string");
        expect(Array.isArray(json.themes)).toBe(true);
        expect(Array.isArray(json.step_ids)).toBe(true);
        expect(json.step_ids.length).toBeGreaterThan(0);
        expect(typeof json.model).toBe("string");
        expect(typeof json.created).toBe("string");
      }
    }
  });

  it("t2 blocks tile [0,200) contiguously; t1 blocks tile [0,250) contiguously", () => {
    const t1 = realBlocks(1).map((b) => b.json).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const b of t1) {
      expect(b.start).toBe(cursor);
      cursor = b.end;
    }
    expect(cursor).toBe(250);

    const t2 = realBlocks(2).map((b) => b.json).sort((a, b) => a.start - b.start);
    cursor = 0;
    for (const b of t2) {
      expect(b.start).toBe(cursor);
      cursor = b.end;
    }
    expect(cursor).toBe(200); // floor(250/100)=2 t2 blocks; [200,300) not yet complete
  });

  it("real meta.json marker is F-aligned (start_index snapped)", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, "meta.json"), "utf8"));
    expect(meta.start_index % F).toBe(0);
  });
});
