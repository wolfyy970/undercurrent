// test/live-sxs-compare.test.ts — pure-function coverage for
// parity/live/lib.mjs, using the two REAL trajectories from the live side-by-side
// run documented in SIDE-BY-SIDE.md (its sxs/{orig,port} artifacts), copied into
// parity/live/fixtures/ with absolute paths scrubbed to `<HEADLONG_ROOT>` etc.
// No subprocess, no Docker, no model call — this only exercises parsing,
// counting, and the STRUCTURAL-DIFF gate against known-real data, and pins
// the exact known divergences the live run found (final 14 vs 0, empty
// per-thinker logs on the port, messages.jsonl index 6 vs 7).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJsonl,
  stepTypeCounts,
  computeCounts,
  collapseTypeSequence,
  buildSideSummary,
  structuralDiff,
  exitCodeForDiffs,
  renderReport,
  parseDispatcherLog,
  wakeCadence,
  countJsonlLines,
  MIN_RUNS,
} from "../parity/live/lib.mjs";
import { filterOrphans, pollUntilQuiet } from "../parity/live/run-sxs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "parity", "live", "fixtures");

function loadSide(side: "orig" | "port") {
  const base = path.join(FIXTURES, side);
  return buildSideSummary({
    trajectoryText: fs.readFileSync(path.join(base, "trajectory.jsonl"), "utf8"),
    dispatcherLogText: fs.readFileSync(path.join(base, "dispatcher.log"), "utf8"),
    messagesIndexText: fs.readFileSync(path.join(base, "messages.jsonl"), "utf8"),
    perThinkerLogBytes: JSON.parse(fs.readFileSync(path.join(base, "log-sizes.json"), "utf8")) as Record<string, number>,
    memoryFiles: [],
    identityName: "sxs",
  });
}

describe("parseJsonl / stepTypeCounts / computeCounts (pure parsing)", () => {
  it("parses the real orig trajectory and matches SIDE-BY-SIDE.md's published counts", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "orig", "trajectory.jsonl"), "utf8");
    const steps = parseJsonl(text);
    const types = stepTypeCounts(steps) as Record<string, number>;
    expect(types["shellm-run"]).toBe(15);
    expect(types["final"]).toBe(14);
    expect(types["reasoning"]).toBe(52);
    expect(types["shell-output"]).toBe(52);
    expect(types["observation"]).toBe(9);
    expect(types["idle"]).toBe(18);
    expect(types["error"]).toBe(1);
    expect(types["message"]).toBe(7);

    const counts = computeCounts(steps, { identityName: "sxs" });
    expect(counts.outboundMessages).toBe(4);
    expect(counts.unpromptedOutreach).toBe(1);
    expect(counts.reactiveWakes).toBe(3);
    expect(counts.spontaneousWakes).toBe(12);
  });

  it("parses the real port trajectory and matches SIDE-BY-SIDE.md's published counts — including the missing `final` step type", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "port", "trajectory.jsonl"), "utf8");
    const steps = parseJsonl(text);
    const types = stepTypeCounts(steps) as Record<string, number>;
    expect(types["shellm-run"]).toBe(14);
    expect(types["final"]).toBeUndefined(); // the port's real bug: never emitted, not even once
    expect(types["reasoning"]).toBe(111);
    expect(types["shell-output"]).toBe(111);
    expect(types["observation"]).toBe(16);
    expect(types["idle"]).toBe(6);
    expect(types["message"]).toBe(7);

    const counts = computeCounts(steps, { identityName: "sxs" });
    expect(counts.finalSteps).toBe(0);
    expect(counts.outboundMessages).toBe(4);
    expect(counts.unpromptedOutreach).toBe(1);
  });

  it("collapseTypeSequence run-length-encodes consecutive same-type steps", () => {
    const steps = [{ type: "a" }, { type: "a" }, { type: "b" }, { type: "a" }];
    expect(collapseTypeSequence(steps)).toEqual([
      { type: "a", count: 2 },
      { type: "b", count: 1 },
      { type: "a", count: 1 },
    ]);
  });
});

describe("parseDispatcherLog (two dialects, one grammar)", () => {
  it("normalizes orig's no-milliseconds/empty-source lines and port's milliseconds/dash-source lines the same way", () => {
    const orig = parseDispatcherLog("2026-09-02T18:02:31Z [dispatcher] step: type=message source=chat\n2026-09-02T18:03:35Z [dispatcher] step: type=shellm-run source=\n");
    const port = parseDispatcherLog("2026-09-02T18:02:21.555Z [dispatcher] step: type=message source=chat\n2026-09-02T18:02:28.684Z [dispatcher] step: type=shellm-run source=-\n");
    expect(orig).toHaveLength(2);
    expect(port).toHaveLength(2);
    expect(orig[0]).toMatchObject({ kind: "step", type: "message", source: "chat" });
    expect(port[0]).toMatchObject({ kind: "step", type: "message", source: "chat" });
    expect(orig[1]).toMatchObject({ kind: "step", type: "shellm-run", source: null });
    expect(port[1]).toMatchObject({ kind: "step", type: "shellm-run", source: null }); // "-" normalized same as ""
  });

  it("parses dispatch/pending/scheduled-wake/skip/sigterm lines from the real fixtures without any 'other' fallthrough", () => {
    for (const side of ["orig", "port"] as const) {
      const text = fs.readFileSync(path.join(FIXTURES, side, "dispatcher.log"), "utf8");
      const events = parseDispatcherLog(text);
      expect(events.length).toBeGreaterThan(0);
      const unparsed = events.filter((e) => e.kind === "unparsed" || e.kind === "other");
      expect(unparsed, JSON.stringify(unparsed.slice(0, 5))).toEqual([]);
    }
  });

  it("wakeCadence extracts a monotonic timeline of shellm-run starts with gaps", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "orig", "dispatcher.log"), "utf8");
    const timeline = wakeCadence(parseDispatcherLog(text));
    expect(timeline.length).toBe(15); // one per shellm-run (orig has 15)
    expect(timeline[0].gapSec).toBeNull();
    for (let i = 1; i < timeline.length; i++) expect(timeline[i].gapSec).toBeGreaterThanOrEqual(0);
  });
});

describe("countJsonlLines", () => {
  it("counts non-blank lines, matching the real messages.jsonl fixtures", () => {
    expect(countJsonlLines(fs.readFileSync(path.join(FIXTURES, "orig", "messages.jsonl"), "utf8"))).toBe(7);
    expect(countJsonlLines(fs.readFileSync(path.join(FIXTURES, "port", "messages.jsonl"), "utf8"))).toBe(6);
  });
});

describe("structuralDiff — the merge gate, against the two real (scrubbed) trajectories", () => {
  it("finds exactly the known structural diffs from the real live run and none the run didn't have", () => {
    const orig = loadSide("orig");
    const port = loadSide("port");
    // fixtures have orig=15, port=14 shellm-run steps — both >= MIN_RUNS, so
    // every rule below (including the ratio ones) is a hard diff, not inconclusive.
    expect(orig.counts.shellmRuns).toBeGreaterThanOrEqual(MIN_RUNS);
    expect(port.counts.shellmRuns).toBeGreaterThanOrEqual(MIN_RUNS);
    const { diffs, inconclusive } = structuralDiff(orig, port);
    const codes = diffs.map((d) => d.code).sort();

    expect(codes).toEqual(
      ["final-ratio", "message-index-mismatch", "reasoning-per-run", "type-only-one-side", "zero-byte-log", "zero-byte-log"].sort()
    );
    expect(inconclusive).toEqual([]);

    // final: 14 vs 0
    const finalDiff = diffs.find((d) => d.code === "final-ratio")!;
    expect(finalDiff.message).toContain("14/15");
    expect(finalDiff.message).toContain("0/14");

    // empty per-thinker logs on the port side (monolith.log AND responder.log)
    const zeroByteMsgs = diffs.filter((d) => d.code === "zero-byte-log").map((d) => d.message);
    expect(zeroByteMsgs.some((m) => m.includes("monolith.log"))).toBe(true);
    expect(zeroByteMsgs.some((m) => m.includes("responder.log"))).toBe(true);
    expect(zeroByteMsgs.every((m) => m.includes("port 0B"))).toBe(true);

    // messages.jsonl index: 6 vs 7 (port short by the reply to message C)
    const indexDiff = diffs.find((d) => d.code === "message-index-mismatch")!;
    expect(indexDiff.message).toContain("port");
    expect(indexDiff.message).toContain("6 lines");
    expect(indexDiff.message).toContain("7 message steps");

    // exit code 2 = structural diffs found
    expect(exitCodeForDiffs(diffs)).toBe(2);
  });

  it("reports zero diffs (exit 0) when both sides are identical", () => {
    const orig = loadSide("orig");
    const { diffs, inconclusive } = structuralDiff(orig, orig);
    expect(diffs).toEqual([]);
    expect(inconclusive).toEqual([]);
    expect(exitCodeForDiffs(diffs)).toBe(0);
  });

  it("never flags prose/timestamp differences — only step-type-sequence shape", () => {
    // Two summaries with identical shape but totally different message prose/timestamps
    // must produce zero diffs: prose is explicitly out of scope for the gate.
    const orig = loadSide("orig");
    const reworded = JSON.parse(JSON.stringify(orig.steps)) as Array<Record<string, unknown>>;
    for (const s of reworded) {
      if (s.type === "message") s.content = "completely different wording, nothing like the original";
      if (typeof s.ts === "string") s.ts = "2099-01-01T00:00:00.000Z";
    }
    const rewordedSummary = buildSideSummary({
      trajectoryText: reworded.map((s) => JSON.stringify(s)).join("\n"),
      dispatcherLogText: fs.readFileSync(path.join(FIXTURES, "orig", "dispatcher.log"), "utf8"),
      messagesIndexText: fs.readFileSync(path.join(FIXTURES, "orig", "messages.jsonl"), "utf8"),
      perThinkerLogBytes: JSON.parse(fs.readFileSync(path.join(FIXTURES, "orig", "log-sizes.json"), "utf8")) as Record<string, number>,
      identityName: "sxs",
    });
    const { diffs, inconclusive } = structuralDiff(orig, rewordedSummary);
    expect(diffs).toEqual([]);
    expect(inconclusive).toEqual([]);
  });

  it("flags orphaned processes/containers when supplied, and not when empty", () => {
    const orig = loadSide("orig");
    const port = loadSide("port");
    const portWithOrphans = { ...port, orphanProcesses: ["87124"], orphanContainers: ["shellm-93082"] };
    const { diffs } = structuralDiff(orig, portWithOrphans);
    expect(diffs.some((d) => d.code === "orphan-process" && d.message.includes("87124"))).toBe(true);
    expect(diffs.some((d) => d.code === "orphan-container" && d.message.includes("shellm-93082"))).toBe(true);
  });
});

describe("structuralDiff — STRUCTURAL_STEP_TYPES allowlist for one-sided step types", () => {
  function sideFrom(steps: Array<Record<string, unknown>>) {
    return buildSideSummary({
      trajectoryText: steps.map((s) => JSON.stringify(s)).join("\n"),
      dispatcherLogText: "",
      perThinkerLogBytes: {},
      identityName: "sxs",
    });
  }

  it("does not flag `action` present on only one side — a responder-deferral step is model-choice, not port shape", () => {
    const orig = sideFrom([{ type: "shellm-run" }, { type: "final" }]);
    const port = sideFrom([{ type: "shellm-run" }, { type: "action" }, { type: "final" }]);
    const { diffs } = structuralDiff(orig, port);
    expect(diffs.some((d) => d.code === "type-only-one-side")).toBe(false);
  });

  it("flags a missing `final` type on one side — final is a structural step type, hard even at n=1 (below MIN_RUNS)", () => {
    const orig = sideFrom([{ type: "shellm-run" }, { type: "final" }]);
    const port = sideFrom([{ type: "shellm-run" }]);
    const { diffs, inconclusive } = structuralDiff(orig, port);
    // the type-presence diff is hard at any n...
    expect(diffs.some((d) => d.code === "type-only-one-side" && d.message.includes('"final"') && d.message.includes("never in port"))).toBe(true);
    // ...but this fixture's shellm-run count (1 each, well below MIN_RUNS) also
    // trips final-ratio (100% vs 0%), which at n=1 is separately inconclusive —
    // it does not, itself, need `final` to be one-sided to fire.
    expect(inconclusive.some((d) => d.code === "final-ratio")).toBe(true);
    expect(diffs.some((d) => d.code === "final-ratio")).toBe(false);
  });
});

describe("structuralDiff — MIN_RUNS gating for ratio rules and one-sided idle/error", () => {
  /** N shellm-runs, `finals` of them followed by a `final` step, `reasoningPerRun` reasoning steps per run, plus `idle`/`error` one-sided step counts appended at the end. */
  function runsSteps({ shellmRuns, finals = 0, reasoningPerRun = 0, idle = 0, error = 0 }: { shellmRuns: number; finals?: number; reasoningPerRun?: number; idle?: number; error?: number }) {
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < shellmRuns; i++) {
      steps.push({ type: "shellm-run", step_id: `run-${i}` });
      for (let r = 0; r < reasoningPerRun; r++) steps.push({ type: "reasoning" });
      if (i < finals) steps.push({ type: "final" });
    }
    for (let i = 0; i < idle; i++) steps.push({ type: "idle" });
    for (let i = 0; i < error; i++) steps.push({ type: "error" });
    return steps;
  }
  function sideFromSteps(steps: Array<Record<string, unknown>>) {
    return buildSideSummary({ trajectoryText: steps.map((s) => JSON.stringify(s)).join("\n"), dispatcherLogText: "", perThinkerLogBytes: {}, identityName: "sxs" });
  }

  it("below MIN_RUNS on both sides: opposite-signed final-ratio/reasoning-per-run and one-sided idle/error are inconclusive, not FAILUREs — exit 0", () => {
    expect(MIN_RUNS).toBe(8);
    // `final` present (at least once) on both sides so only the RATIO differs
    // — a one-sided `final` type would itself be a hard diff (see the
    // dedicated "flags a missing final type" test above) and would pollute
    // this test's isolation of the ratio rules from the type-presence rule.
    const orig = sideFromSteps(runsSteps({ shellmRuns: 5, finals: 5, reasoningPerRun: 1, idle: 1, error: 0 })); // 100% final ratio, rpr=1
    const port = sideFromSteps(runsSteps({ shellmRuns: 4, finals: 1, reasoningPerRun: 5, idle: 0, error: 1 })); // 25% final ratio, rpr=5
    expect(orig.counts.shellmRuns).toBeLessThan(MIN_RUNS);
    expect(port.counts.shellmRuns).toBeLessThan(MIN_RUNS);

    const { diffs, inconclusive } = structuralDiff(orig, port);
    expect(diffs).toEqual([]);
    expect(exitCodeForDiffs(diffs)).toBe(0);

    const codes = inconclusive.map((d) => d.code).sort();
    expect(codes).toEqual(["final-ratio", "reasoning-per-run", "type-only-one-side", "type-only-one-side"].sort());
    expect(inconclusive.every((d) => d.message.includes("inconclusive"))).toBe(true);
    expect(inconclusive.some((d) => d.code === "type-only-one-side" && d.message.includes('"idle"'))).toBe(true);
    expect(inconclusive.some((d) => d.code === "type-only-one-side" && d.message.includes('"error"'))).toBe(true);
  });

  it("the same shapes with both sides >= MIN_RUNS: final-ratio, reasoning-per-run, and one-sided idle/error are hard FAILUREs — exit 2", () => {
    const orig = sideFromSteps(runsSteps({ shellmRuns: 9, finals: 9, reasoningPerRun: 1, idle: 1, error: 0 })); // 100% final ratio, rpr=1
    const port = sideFromSteps(runsSteps({ shellmRuns: 8, finals: 1, reasoningPerRun: 5, idle: 0, error: 1 })); // ~12.5% final ratio, rpr=5
    expect(orig.counts.shellmRuns).toBeGreaterThanOrEqual(MIN_RUNS);
    expect(port.counts.shellmRuns).toBeGreaterThanOrEqual(MIN_RUNS);

    const { diffs, inconclusive } = structuralDiff(orig, port);
    expect(inconclusive).toEqual([]);
    const codes = diffs.map((d) => d.code).sort();
    expect(codes).toEqual(["final-ratio", "reasoning-per-run", "type-only-one-side", "type-only-one-side"].sort());
    expect(exitCodeForDiffs(diffs)).toBe(2);
  });

  it("only one side below MIN_RUNS is still enough to soften the ratio rules and idle/error", () => {
    const orig = sideFromSteps(runsSteps({ shellmRuns: 10, finals: 10, reasoningPerRun: 1 })); // >= MIN_RUNS
    const port = sideFromSteps(runsSteps({ shellmRuns: 3, finals: 0, reasoningPerRun: 6 })); // < MIN_RUNS
    const { diffs, inconclusive } = structuralDiff(orig, port);
    expect(diffs.some((d) => d.code === "final-ratio" || d.code === "reasoning-per-run")).toBe(false);
    expect(inconclusive.some((d) => d.code === "final-ratio")).toBe(true);
    expect(inconclusive.some((d) => d.code === "reasoning-per-run")).toBe(true);
  });

  it("hard signals never soften at small n: a one-sided structural type other than idle/error, a zero-byte log, and an orphan all still fail below MIN_RUNS", () => {
    const origSteps = runsSteps({ shellmRuns: 2, finals: 2, reasoningPerRun: 1 });
    origSteps.push({ type: "message", from: "sxs", to: "jo" });
    const portSteps = runsSteps({ shellmRuns: 2, finals: 2, reasoningPerRun: 1 }); // no `message` step at all — one-sided, not idle/error
    const orig = { ...sideFromSteps(origSteps), perThinkerLogBytes: { "monolith.log": 500 } };
    const port = { ...sideFromSteps(portSteps), perThinkerLogBytes: { "monolith.log": 0 }, orphanProcesses: ["12345"] };
    expect(orig.counts.shellmRuns).toBeLessThan(MIN_RUNS);
    expect(port.counts.shellmRuns).toBeLessThan(MIN_RUNS);

    const { diffs, inconclusive } = structuralDiff(orig, port);
    expect(diffs.some((d) => d.code === "type-only-one-side" && d.message.includes('"message"'))).toBe(true);
    expect(diffs.some((d) => d.code === "zero-byte-log")).toBe(true);
    expect(diffs.some((d) => d.code === "orphan-process" && d.message.includes("12345"))).toBe(true);
    expect(inconclusive.some((d) => d.code === "type-only-one-side" || d.code === "zero-byte-log" || d.code === "orphan-process")).toBe(false);
    expect(exitCodeForDiffs(diffs)).toBe(2);
  });
});

describe("filterOrphans / pollUntilQuiet (run-sxs.mjs orphan-set exclusion + drain polling)", () => {
  it("filterOrphans excludes the runner's own launcher pid", () => {
    const procs = [
      { pid: 100, command: "bash bin/thinkers start" },
      { pid: 200, command: "node monolith.mjs" },
    ];
    expect(filterOrphans(procs, new Set([100]))).toEqual([{ pid: 200, command: "node monolith.mjs" }]);
  });

  it("polls until the process list goes quiet, excluding the launcher pid throughout, using a fake lister and clock", async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    // Launcher (100) plus a still-draining worker (200), gone by the third check.
    const snapshots = [
      [{ pid: 100, command: "start" }, { pid: 200, command: "worker" }],
      [{ pid: 100, command: "start" }, { pid: 200, command: "worker" }],
      [{ pid: 100, command: "start" }],
    ];
    let call = 0;
    const listProcesses = () => snapshots[Math.min(call++, snapshots.length - 1)];

    const result = await pollUntilQuiet({ listProcesses, excludePids: new Set([100]), deadlineMs: 10_000, intervalMs: 2000, now, sleep });
    expect(result.remaining).toEqual([]);
    expect(result.elapsedMs).toBe(4000); // two 2s polls before it went quiet
  });

  it("gives up at the deadline and reports the true orphan, still excluding the launcher pid", async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const listProcesses = () => [{ pid: 100, command: "start" }, { pid: 999, command: "stuck-worker" }];

    const result = await pollUntilQuiet({ listProcesses, excludePids: new Set([100]), deadlineMs: 5000, intervalMs: 2000, now, sleep });
    expect(result.remaining).toEqual([{ pid: 999, command: "stuck-worker" }]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5000);
  });
});

describe("renderReport (pure markdown rendering)", () => {
  it("renders a report containing the counts table, both sides' reply texts, and the STRUCTURAL-DIFF section", () => {
    const orig = loadSide("orig");
    const port = loadSide("port");
    const { diffs, inconclusive } = structuralDiff(orig, port);
    const md = renderReport({ orig, port, diffs, inconclusive, meta: { identityName: "sxs", minutes: 15, model: "deepseek/deepseek-v4-flash-0731", startedAt: "2026-09-02T18:02:00Z", dryRun: false } });

    expect(md).toContain("## Counts");
    expect(md).toContain("## STRUCTURAL-DIFF");
    expect(md).toContain("final-ratio");
    expect(md).toContain("Teal");
    expect(md).not.toContain("<HEADLONG_ROOT>"); // scrub placeholder never leaks into rendered prose
  });

  it("renders 'None' under STRUCTURAL-DIFF and a PASS bottom line when there are no diffs", () => {
    const orig = loadSide("orig");
    const md = renderReport({ orig, port: orig, diffs: [], inconclusive: [], meta: { identityName: "sxs", minutes: 15, model: "x", startedAt: "t", dryRun: true } });
    expect(md).toContain("None. Port matches original structurally");
    expect(md).toContain("PASS");
  });

  it("renders an INCONCLUSIVE (small sample) section, separate from STRUCTURAL-DIFF, when small-sample entries are present", () => {
    const orig = loadSide("orig");
    const md = renderReport({
      orig,
      port: orig,
      diffs: [],
      inconclusive: [{ code: "final-ratio", message: "final-step ratio differs by >30%: ... — inconclusive: fewer than 8 shellm-run steps on one or both sides" }],
      meta: { identityName: "sxs", minutes: 5, model: "x", startedAt: "t", dryRun: false },
    });
    expect(md).toContain("## INCONCLUSIVE (small sample)");
    expect(md).toContain("final-ratio");
    expect(md).toContain("PASS"); // zero diffs still passes even with an inconclusive entry
    expect(md.indexOf("## STRUCTURAL-DIFF")).toBeLessThan(md.indexOf("## INCONCLUSIVE (small sample)"));
  });
});
