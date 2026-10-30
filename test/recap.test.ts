// recap.test.ts — unit tests for the `recap` trajectory summarizer + tiered
// `--context` staircase (port of headlong/bin/recap).
//
// Behaviour, not text: these pin the CLI contract, the on-disk cache shapes
// (recap/episodes.jsonl, recap/themes.json, rollups/*), and the jq/bash/awk
// semantics quirks the port replicates deliberately. Tests that reach the
// model run the port's real `llm` against recorded real DeepSeek replies
// (test/fixtures/recordings/recap/, served from a child process because recap
// calls `llm` with spawnSync); failures are labelled HTTP fixtures, and the
// reply parser is tested directly (parseLlmJson, bodyObj). The port is byte-
// compared against the real Bash tool by the separate parity lane
// (parity/recap/run-parity.mjs); here behaviour is pinned deterministically.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runRecap,
  jqCompact,
  jqPretty,
  bashDigits,
  bashArith,
  BashUnboundVar,
  stampLocal,
  tsvEscape,
  fnmatchToRegex,
  findFirstDir,
  renderStep,
  renderRange,
  rowToTsv,
  windowRanges,
  RECAP_VERSION,
  USAGE,
  WINDOW_SYSTEM,
  REDUCE_SYSTEM,
  KEEP_TYPES_JSON,
  parseLlmJson,
  JsonSeq,
  splitJsonSeq,
  bodyObj,
  type RecapIO,
} from "../src/recap.js";
import { recordedServerProcess, type RecordedServerProcess } from "./support/recordedServerProcess.ts";
import { recordedText, RECORDINGS_DIR, type Recording } from "./support/recordedModel.ts";

// --- deterministic IO harness -------------------------------------------------

interface LlmCall {
  args: string[];
  stdin: string;
}

interface Harness {
  io: RecapIO;
  out(): string;
  err(): string;
  llmCalls: LlmCall[];
}

type Fixture = { status: number; content_type: string; body: string };

/** No model: any llm call fails like an unreachable provider and is counted (tests assert it never happens). */
function makeIO(opts: { cwd?: string; env?: Record<string, string | undefined>; now?: Date; runLlm?: RecapIO["runLlm"] } = {}): Harness {
  let out = "";
  let err = "";
  const llmCalls: LlmCall[] = [];
  const io: RecapIO = {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? {},
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    now: () => opts.now ?? new Date("2026-01-02T03:04:05"),
    runLlm: (args, stdin) => {
      llmCalls.push({ args, stdin });
      return opts.runLlm ? opts.runLlm(args, stdin) : { status: 1, stdout: "", stderr: "llm: error: no model in this test\n" };
    },
  };
  return { io, out: () => out, err: () => err, llmCalls };
}

const servers: RecordedServerProcess[] = [];
/** makeIO with the real `llm` pointed at recording recap/<scenario> (request i of the run is call i). */
async function recIO(
  scenario: string,
  opts: { env?: Record<string, string | undefined>; now?: Date; httpFixtures?: Record<number, Fixture> } = {}
): Promise<Harness> {
  const srv = await recordedServerProcess("recap", scenario, opts.httpFixtures ? { httpFixtures: opts.httpFixtures } : {});
  servers.push(srv);
  return makeIO({ env: { TRAJ_DIR: TMP }, ...opts, runLlm: (args, stdin) => srv.runLlm(args, stdin) });
}
/** Recorded reply i of recap/<scenario>, parsed as recap parses it. */
function reply(scenario: string, i = 0): any {
  const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "recap", `${scenario}.json`), "utf8")) as Recording;
  return parseLlmJson(recordedText(rec.calls[i]!));
}
// HTTP fixture, not model output: recording `scenario`'s first reply streamed halfway, then the connection drops
// (no finish_reason, no [DONE]). llm exits 0 with the half it got, which is not valid JSON.
function droppedStream(scenario: string): Fixture {
  const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "recap", `${scenario}.json`), "utf8")) as Recording;
  const text = recordedText(rec.calls[0]!);
  const half = JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(0, Math.floor(text.length / 2)) } }] });
  return { status: 200, content_type: "text/event-stream", body: `data: ${half}\n\n` };
}

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "recap-test-"));
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeTraj(runDir: string, steps: Record<string, unknown>[]): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

// =============================================================================
// PORT-NOTE (1c: f6f854c) — upstream-next bin/recap:293-297. "v3: outcomes,
// not temperament" reworded _WINDOW_SYSTEM the same way as _ROLLUP_SYSTEM
// (see rollups.test.ts). Byte-exact against the upstream shell string.
// =============================================================================

describe("WINDOW_SYSTEM — f6f854c (v3: outcomes, not temperament)", () => {
  it("is byte-identical to upstream-next bin/recap:293-297", () => {
    expect(WINDOW_SYSTEM).toBe(
      'You summarize one window of an AI agent\'s mind log. Lines look like "[step-id] type(source): content". Reply with ONLY a JSON object, no markdown fences:\n' +
        '{"title": "short episode title (<=8 words)",\n' +
        ' "summary": "2-4 sentences on outcomes: what the agent did, decided, learned, and left open, naming people, artifacts, and threads. Events, not character: no words for its habits or temperament (not disciplined, restrained, patient, waiting mode); if it idled, say once what it was waiting for",\n' +
        ' "themes": ["1-4 short kebab-case topics"],\n' +
        ' "notable_steps": [{"step": "8-char id from the window", "note": "why it matters (<=15 words)"}]}\n' +
        "Pick 3-6 notable steps. Use only step ids that literally appear in the window.",
    );
  });
});

// =============================================================================
// Pure helpers: jq / bash / awk semantics
// =============================================================================

describe("jqCompact / jqPretty", () => {
  it("compact has no spaces, pretty is 2-space indented", () => {
    expect(jqCompact({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(jqPretty({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("escapes DEL (0x7f) like jq", () => {
    expect(jqCompact("xy")).toBe('"x\\u007fy"');
  });
  it("undefined becomes null", () => {
    expect(jqCompact(undefined)).toBe("null");
  });
});

describe("bashDigits", () => {
  it("parses plain decimal digits", () => {
    expect(bashDigits("42")).toBe(42);
    expect(bashDigits("0")).toBe(0);
  });
  it("treats a leading zero as octal", () => {
    expect(bashDigits("010")).toBe(8);
    expect(bashDigits("0777")).toBe(511);
  });
  it("08/09 is an octal error (bash: value too great for base)", () => {
    expect(bashDigits("08")).toBe("octal-error");
    expect(bashDigits("09")).toBe("octal-error");
  });
  it("non-digit strings are null", () => {
    expect(bashDigits("abc")).toBeNull();
    expect(bashDigits("1.5")).toBeNull();
    expect(bashDigits("")).toBeNull();
    expect(bashDigits("-1")).toBeNull();
  });
});

describe("bashArith", () => {
  it("empty string is 0 (unset variable)", () => {
    expect(bashArith("")).toBe(0);
    expect(bashArith("  ")).toBe(0);
  });
  it("digits use bashDigits (octal) rules", () => {
    expect(bashArith("42")).toBe(42);
    expect(bashArith("010")).toBe(8);
  });
  it("08/09 is a syntax error -> null", () => {
    expect(bashArith("08")).toBeNull();
  });
  it("hex literals", () => {
    expect(bashArith("0x1A")).toBe(26);
  });
  it("a bare identifier throws BashUnboundVar (set -u nounset abort, F: bashArith unbound-var)", () => {
    expect(() => bashArith("FOO_BAR")).toThrow(BashUnboundVar);
    expect(() => bashArith("FOO_BAR")).toThrow("FOO_BAR: unbound variable");
  });
  it("garbage is a syntax error -> null", () => {
    expect(bashArith("1 + ")).toBeNull();
    expect(bashArith("!!!")).toBeNull();
  });
});

describe("stampLocal", () => {
  it("formats as date +%Y-%m-%dT%H:%M:%S, zero-padded", () => {
    expect(stampLocal(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05");
    expect(stampLocal(new Date(2026, 10, 30, 23, 59, 9))).toBe("2026-11-30T23:59:09");
  });
});

describe("tsvEscape", () => {
  it("escapes backslash, tab, newline, CR (backslash first)", () => {
    expect(tsvEscape("a\\b\tc\nd\re")).toBe("a\\\\b\\tc\\nd\\re");
  });
  it("leaves plain text untouched", () => {
    expect(tsvEscape("hello world")).toBe("hello world");
  });
});

describe("fnmatchToRegex", () => {
  it("* matches any run including empty", () => {
    expect(fnmatchToRegex("abc*").test("abc")).toBe(true);
    expect(fnmatchToRegex("abc*").test("abcdef")).toBe(true);
    expect(fnmatchToRegex("abc*").test("ab")).toBe(false);
  });
  it("? matches exactly one char", () => {
    expect(fnmatchToRegex("a?c").test("abc")).toBe(true);
    expect(fnmatchToRegex("a?c").test("ac")).toBe(false);
  });
  it("bracket classes", () => {
    expect(fnmatchToRegex("[a-c]x").test("bx")).toBe(true);
    expect(fnmatchToRegex("[a-c]x").test("dx")).toBe(false);
    expect(fnmatchToRegex("[!a]x").test("bx")).toBe(true);
    expect(fnmatchToRegex("[!a]x").test("ax")).toBe(false);
  });
});

describe("findFirstDir", () => {
  it("returns the root itself when its own name matches", () => {
    const root = fs.mkdtempSync(path.join(TMP, "root-"));
    const found = findFirstDir(root, path.basename(root), fnmatchToRegex(path.basename(root) + "*"));
    expect(found).toBe(root);
  });
  it("finds a matching subdirectory breadth-first, skips non-dirs", () => {
    const root = path.join(TMP, "troot");
    fs.mkdirSync(path.join(root, "abc123"), { recursive: true });
    fs.writeFileSync(path.join(root, "abc999"), "not a dir");
    const found = findFirstDir(root, "troot", fnmatchToRegex("abc*"));
    expect(found).toBe(path.join(root, "abc123"));
  });
  it("descends into nested dirs up to maxDepth", () => {
    const root = path.join(TMP, "nroot");
    fs.mkdirSync(path.join(root, "a", "b", "deadbeef-x"), { recursive: true });
    const found = findFirstDir(root, "nroot", fnmatchToRegex("deadbeef*"));
    expect(found).toBe(path.join(root, "a", "b", "deadbeef-x"));
  });
  it("returns null when nothing matches", () => {
    const root = path.join(TMP, "eroot");
    fs.mkdirSync(root);
    expect(findFirstDir(root, "eroot", fnmatchToRegex("zzz*"))).toBeNull();
  });
});

// =============================================================================
// renderStep / renderRange — the jq row program
// =============================================================================

describe("renderStep", () => {
  it("keeps only KEEP_TYPES, drops everything else", () => {
    expect(renderStep({ type: "thought", step_id: "a", ts: "" })).not.toBeNull();
    expect(renderStep({ type: "idle", step_id: "a", ts: "" })).toBeNull();
    expect(renderStep({ type: "reasoning", step_id: "a", ts: "" })).toBeNull();
  });
  it("drops source == seed even for a kept type", () => {
    expect(renderStep({ type: "thought", source: "seed" })).toBeNull();
  });
  it("drops non-objects and typeless values", () => {
    expect(renderStep("hi")).toBeNull();
    expect(renderStep(42)).toBeNull();
    expect(renderStep(null)).toBeNull();
    expect(renderStep([])).toBeNull();
  });
  it("formats id8/ts16/text exactly like the jq program", () => {
    const row = renderStep({
      type: "message",
      step_id: "0123456789abcdef",
      ts: "2026-01-02T03:04:05.678Z",
      source: "agent",
      content: "hello\tworld\nline2",
    })!;
    expect(row.stepId).toBe("01234567");
    expect(row.ts).toBe("2026-01-02T03:04");
    expect(row.text).toBe("[01234567] message(agent): hello world line2");
  });
  it("falls back to launched_by when source is absent/falsy", () => {
    const row = renderStep({ type: "action", step_id: "x", launched_by: "cron" })!;
    expect(row.text).toContain("action(cron):");
  });
  it("prefers source over launched_by when both present", () => {
    const row = renderStep({ type: "action", step_id: "x", source: "agent", launched_by: "cron" })!;
    expect(row.text).toContain("action(agent):");
  });
  it("from/to arrow, missing to falls back to '?'", () => {
    const row = renderStep({ type: "observation", step_id: "x", from: "a" })!;
    expect(row.text).toContain(" a→?: ");
  });
  it("content falls back to command then tldr, empty otherwise", () => {
    expect(renderStep({ type: "final", step_id: "x", command: "run me" })!.text).toContain("run me");
    expect(renderStep({ type: "final", step_id: "x", tldr: "the gist" })!.text).toContain("the gist");
    expect(renderStep({ type: "final", step_id: "x" })!.text.endsWith(": ")).toBe(true);
  });
  it("truncates payload text to 500 codepoints", () => {
    const row = renderStep({ type: "thought", step_id: "x", content: "a".repeat(600) })!;
    expect(row.text.length).toBe("[x] thought: ".length + 500);
  });
  it("shellm-run: wake + model, cmd tail only when launched_by is empty", () => {
    const selfRun = renderStep({
      type: "shellm-run",
      step_id: "x",
      wake: "timer",
      model: "sonnet",
      command: "b".repeat(300),
    })!;
    expect(selfRun.text).toContain("wake timer, model sonnet, cmd ");
    expect(selfRun.text.length).toBeLessThan(250); // cmd tail capped at 200 chars
    const launched = renderStep({
      type: "shellm-run",
      step_id: "x",
      model: "sonnet",
      launched_by: "dispatcher",
      command: "should not appear",
    })!;
    expect(launched.text).not.toContain("should not appear");
    expect(launched.text).toBe("[x] shellm-run(dispatcher): model sonnet");
  });
  it("cmd tail keeps the LAST 200 codepoints (cut -c -200 equivalent)", () => {
    const cmd = "HEAD" + "x".repeat(250) + "TAIL";
    const row = renderStep({ type: "shellm-run", step_id: "x", model: "m", command: cmd })!;
    expect(row.text.endsWith("x".repeat(196) + "TAIL")).toBe(true);
    expect(row.text).not.toContain("HEAD");
  });
  it("jq truthy: empty-string source is still TRUTHY (only null/false are falsy) — renders '()' not launched_by", () => {
    const row = renderStep({ type: "action", step_id: "x", source: "", launched_by: "cron" })!;
    expect(row.text).toContain("action():");
    expect(row.text).not.toContain("cron");
  });
});

describe("renderRange", () => {
  it("parses newline-delimited JSON with a 1-based line offset", () => {
    const jsonl = '{"type":"thought","step_id":"a"}\n{"type":"idle"}\n{"type":"action","step_id":"b"}\n';
    const rows = renderRange(jsonl, 1);
    expect(rows.map((r) => r.rawLine)).toEqual([1, 3]);
  });
  it("respects a from-line offset (tail -n +FROM)", () => {
    const jsonl = '{"type":"thought","step_id":"a"}\n{"type":"action","step_id":"b"}\n';
    const rows = renderRange(jsonl, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepId).toBe("b");
  });
  it("respects a limit (head -n LIMIT)", () => {
    const jsonl = ['{"type":"thought","step_id":"a"}', '{"type":"thought","step_id":"b"}', '{"type":"thought","step_id":"c"}']
      .join("\n") + "\n";
    const rows = renderRange(jsonl, 1, 2);
    expect(rows.map((r) => r.stepId)).toEqual(["a", "b"]);
  });
  it("stops at the first unparseable line, keeping earlier rows (2>/dev/null || true)", () => {
    const jsonl = '{"type":"thought","step_id":"a"}\nnot json\n{"type":"thought","step_id":"c"}\n';
    const rows = renderRange(jsonl, 1);
    expect(rows.map((r) => r.stepId)).toEqual(["a"]);
  });
  it("skips blank lines without affecting the line count", () => {
    const jsonl = '{"type":"thought","step_id":"a"}\n\n{"type":"thought","step_id":"b"}\n';
    const rows = renderRange(jsonl, 1);
    expect(rows.map((r) => r.rawLine)).toEqual([1, 3]);
  });
  it("an unterminated last line is still read (sed/tail semantics)", () => {
    const jsonl = '{"type":"thought","step_id":"a"}';
    const rows = renderRange(jsonl, 1);
    expect(rows.map((r) => r.stepId)).toEqual(["a"]);
  });
});

describe("rowToTsv", () => {
  it("joins the 5 fields with tabs", () => {
    const row = renderStep({ type: "thought", step_id: "abcdefgh", ts: "2026-01-02T03:04:05Z", content: "x" })!;
    expect(rowToTsv(row).split("\t")).toHaveLength(5);
  });
});

// =============================================================================
// windowRanges — the awk window-cutting program
// =============================================================================

describe("windowRanges", () => {
  const opts = { maxSteps: 100, gapMin: "30", minGap: 10, maxBytes: "60000" };

  it("a short trajectory becomes one 'eof' window", () => {
    const lines = ["1\ta\tt\ttext\t100", "2\tb\tt\ttext\t101"];
    expect(windowRanges(lines, opts)).toEqual([{ start: 1, end: 2, reason: "eof" }]);
  });
  it("cuts at maxSteps ('size')", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}\ts\tt\ttext\t${i}`);
    const ranges = windowRanges(lines, { ...opts, maxSteps: 5 });
    expect(ranges).toEqual([
      { start: 1, end: 5, reason: "size" },
      { start: 6, end: 10, reason: "size" },
      { start: 11, end: 12, reason: "eof" },
    ]);
  });
  it("cuts at a time gap only once minGap steps have accumulated", () => {
    // steps 1..10 at t=0..9 (no gap), step 11 at t=100 (gap of 90 >= 30).
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}\ts\tt\ttext\t${i}`);
    lines.push("11\ts\tt\ttext\t100");
    const ranges = windowRanges(lines, { ...opts, minGap: 10 });
    expect(ranges).toEqual([
      { start: 1, end: 10, reason: "gap" },
      { start: 11, end: 11, reason: "eof" },
    ]);
  });
  it("does not gap-cut below minGap even with a huge gap", () => {
    const lines = ["1\ts\tt\ttext\t0", "2\ts\tt\ttext\t9999"];
    const ranges = windowRanges(lines, { ...opts, minGap: 10 });
    expect(ranges).toEqual([{ start: 1, end: 2, reason: "eof" }]);
  });
  it("gapMin '0' disables gap-aware cutting", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `${i + 1}\ts\tt\ttext\t${i === 10 ? 9999 : i}`);
    const ranges = windowRanges(lines, { ...opts, gapMin: "0", minGap: 0 });
    expect(ranges).toEqual([{ start: 1, end: 11, reason: "eof" }]);
  });
  it("cuts on byte budget ('size' via maxBytes)", () => {
    // Each line is 48 bytes; the budget check runs AFTER a line is folded in,
    // so the cut lands on the line that pushes the running total >= budget.
    const lines = ["1\ta\tb\t" + "x".repeat(40) + "\t0", "2\ta\tb\t" + "y".repeat(40) + "\t1"];
    const ranges = windowRanges(lines, { ...opts, maxBytes: "50" });
    expect(ranges).toEqual([{ start: 1, end: 2, reason: "size" }]);
  });
  it("rows with an empty ts (field 5) never trigger a gap and don't update prevTs", () => {
    const lines = ["1\ts\tt\ttext\t", "2\ts\tt\ttext\t", "3\ts\tt\ttext\t9999"];
    const ranges = windowRanges(lines, { ...opts, minGap: 0 });
    // No prevTs was ever set from row 1/2 (empty), so row 3 can't gap-compare against anything.
    expect(ranges).toEqual([{ start: 1, end: 3, reason: "eof" }]);
  });
  it("empty input yields no ranges", () => {
    expect(windowRanges([], opts)).toEqual([]);
  });
});

// =============================================================================
// CLI: global flags, arg validation, error paths
// =============================================================================

describe("runRecap: global flags", () => {
  it("--help prints USAGE to stdout and exits 0", () => {
    const h = makeIO();
    const code = runRecap(["--help"], h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe(USAGE);
  });
  it("-h is the same as --help", () => {
    const h = makeIO();
    expect(runRecap(["-h"], h.io)).toBe(0);
    expect(h.out()).toBe(USAGE);
  });
  it("--version prints 'recap <version>' and exits 0", () => {
    const h = makeIO();
    const code = runRecap(["--version"], h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe(`recap ${RECAP_VERSION}\n`);
  });
  it("an unknown option dies with exit 1", () => {
    const h = makeIO();
    const code = runRecap(["--bogus"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: Unknown option: --bogus\n");
  });
  it("a second positional ID dies (Usage: recap [ID] [options])", () => {
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["one", "two"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("Usage: recap [ID] [options]");
  });
});

describe("runRecap: flag value validation", () => {
  it("--window below 10 dies before touching TRAJ_DIR", () => {
    const h = makeIO();
    const code = runRecap(["--window", "5"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --window must be a number >= 10\n");
  });
  it("--window non-numeric dies", () => {
    const h = makeIO();
    expect(runRecap(["--window", "abc"], h.io)).toBe(1);
  });
  it("a missing flag value dies with the PORT-NOTE message (not bash's ${2:?} text)", () => {
    const h = makeIO();
    const code = runRecap(["--traj_dir"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --traj_dir requires DIR\n");
  });
  it("an empty flag value also dies (${2:?} fires on empty too)", () => {
    const h = makeIO();
    const code = runRecap(["--window", ""], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --window requires N\n");
  });
  it("--fanout below 2 dies (checked after trajectory resolution)", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--fanout", "1", "--cached"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --fanout must be a number >= 2\n");
  });
  it("--budget/--raw-tail are validated only under --context", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    // Bogus --budget with no --context: never validated, --cached with no cache dies on ITS OWN message.
    const code = runRecap(["abc123", "--budget", "not-a-number", "--cached"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("no recap yet");
  });
  it("--budget must be 'auto' or a positive number, under --context", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--context", "--budget", "0"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --budget must be a positive number or auto\n");
  });
  it("--raw-tail must be 'auto' or a number, under --context", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--context", "--raw-tail", "nope"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: --raw-tail must be a number or auto\n");
  });
});

describe("runRecap: trajectory resolution", () => {
  it("dies when TRAJ_DIR is unset", () => {
    const h = makeIO();
    const code = runRecap(["abc"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("no trajectory: set TRAJ_DIR");
  });
  it("dies when --traj_dir is not a directory", () => {
    const h = makeIO({ env: { TRAJ_DIR: path.join(TMP, "nope") } });
    const code = runRecap(["abc"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe(`recap: error: not a directory: ${path.join(TMP, "nope")}\n`);
  });
  it("dies when no trajectory ID is given and TRAJ_ID is unset", () => {
    fs.mkdirSync(TMP, { recursive: true });
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap([], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("no trajectory ID");
  });
  it("accepts a positional ID resolved by hex prefix under TRAJ_DIR", () => {
    writeTraj(path.join(TMP, "deadbeef-run"), []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["deadbeef", "--cached"], h.io);
    expect(code).toBe(1); // no recap cache yet, but resolution succeeded
    expect(h.err()).toContain("no recap yet");
  });
  it("falls back to $TRAJ_ID when no positional ID is given", () => {
    writeTraj(path.join(TMP, "cafef00d-run"), []);
    const h = makeIO({ env: { TRAJ_DIR: TMP, TRAJ_ID: "cafef00d" } });
    const code = runRecap(["--cached"], h.io);
    expect(h.err()).toContain("no recap yet");
    expect(code).toBe(1);
  });
  it("a full directory path (with trajectory.jsonl) is accepted directly", () => {
    const runDir = path.join(TMP, "myrun");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["myrun", "--cached"], h.io);
    expect(h.err()).toContain("no recap yet");
    expect(code).toBe(1);
  });
  it("dies with 'no trajectory matching' when nothing matches the prefix", () => {
    fs.mkdirSync(TMP, { recursive: true });
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["zzzzzzzz"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe(`recap: error: no trajectory matching: zzzzzzzz (under ${TMP})\n`);
  });
});

// =============================================================================
// refresh(): map/reduce cache build, incremental resume, locking
// =============================================================================

describe("runRecap: refresh + cache shapes", () => {
  function traj(n: number, startMin = 0): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      type: "thought",
      step_id: `step${String(i).padStart(4, "0")}`,
      ts: `2026-01-01T00:${String(startMin + i).padStart(2, "0")}:00Z`,
      content: `thought number ${i}`,
    }));
  }

  it("builds episodes.jsonl (one compact JSON object per line) and themes.json (pretty)", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(3));
    const h = await recIO("mr-3");
    const code = runRecap(["abc123", "--window", "10"], h.io);
    expect(code).toBe(0);

    const episodesRaw = fs.readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8");
    const lines = episodesRaw.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    // One compact JSON object per line (no pretty-printing / no trailing spaces).
    expect(lines[0]).not.toContain("\n");
    const ep = JSON.parse(lines[0]!);
    expect(ep).toMatchObject({ idx: 1, n_steps: 3, partial: true, title: reply("mr-3", 0).title });

    const themesRaw = fs.readFileSync(path.join(runDir, "recap", "themes.json"), "utf8");
    expect(themesRaw).toContain("\n"); // pretty-printed
    const themes = JSON.parse(themesRaw);
    expect(themes).toMatchObject({ episodes: 1, arc: reply("mr-3", 1).arc });
  });

  it("sends exactly `llm -m MODEL -t 2048 -s SYSTEM` for the map stage and -t 8192 for reduce", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(2));
    const h = await recIO("mr-2", { env: { TRAJ_DIR: TMP, RECAP_MAP_MODEL: "map-model", RECAP_REDUCE_MODEL: "reduce-model" } });
    runRecap(["abc123"], h.io);
    expect(h.llmCalls[0]!.args).toEqual(["-m", "map-model", "-t", "2048", "-s", WINDOW_SYSTEM]);
    expect(h.llmCalls[1]!.args).toEqual(["-m", "reduce-model", "-t", "8192", "-s", REDUCE_SYSTEM]);
  });

  it("stdin to the map call is the newline-joined window text (cut -f4, trailing newline stripped)", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(2));
    const h = await recIO("mr-2");
    runRecap(["abc123"], h.io);
    expect(h.llmCalls[0]!.stdin).toBe("[step0000] thought: thought number 0\n[step0001] thought: thought number 1");
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h = await recIO("mr-1", { httpFixtures: { 0: droppedStream("mr-1") } });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(0);
    expect(h.llmCalls).toHaveLength(3);
    expect(h.err()).toContain("model returned invalid JSON (attempt 1), retrying");
  });

  it("strips ``` fence lines before parsing (parser, no model)", () => {
    expect(parseLlmJson('```json\n{"title":"t"}\n```\n')).toEqual({ title: "t" });
    expect(jqCompact(parseLlmJson('```\n[1]\n```') as never)).toBe("[1]");
    expect(parseLlmJson("not json")).toBeUndefined();
    expect(parseLlmJson("null")).toBeUndefined(); // jq -e: null/false fail
    expect(parseLlmJson("false")).toBeUndefined();
    expect(parseLlmJson("")).toBeUndefined();
  });

  it("dies after 2 failed attempts", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h = await recIO("transport-dropped", { httpFixtures: { 0: droppedStream("mr-1"), 1: droppedStream("mr-1") } });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("episode 1: model did not produce valid JSON");
    expect(h.llmCalls).toHaveLength(2);
  });

  it("a non-zero llm exit status is treated as an empty reply (`|| raw=\"\"`)", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    // Boundary result built in-process: the recorded real reply on stdout with exit 1 (the real llm exits non-zero
    // only after a failure, so the pairing is constructed). Valid JSON, but status != 0 must discard it.
    const real = JSON.stringify(reply("mr-1", 0));
    const h = makeIO({ env: { TRAJ_DIR: TMP }, runLlm: () => ({ status: 1, stdout: real }) });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("model did not produce valid JSON");
  });

  it("a model reply that is a JSON array (not object) dies with a clean PORT-NOTE message (parser, no model)", () => {
    const value = parseLlmJson("[1,2,3]")!;
    expect(jqCompact(value as never)).toBe("[1,2,3]");
    expect(() => bodyObj(value, "episode 1")).toThrow(/model reply is not a JSON object/);
    expect(bodyObj(parseLlmJson('{"title":"t"}')!, "episode 1")).toEqual({ title: "t" });
  });

  it("no new steps since last recap: refresh is a no-op, still prints the cached recap", async () => {
    const runDir = path.join(TMP, "abc123");
    // Exactly `window` steps: the first (only) window closes via a complete
    // 'size' cut (partial=false), so a re-run has nothing to resume from.
    writeTraj(runDir, traj(10));
    const h1 = await recIO("mr-10");
    runRecap(["abc123", "--window", "10"], h1.io);

    const h2 = makeIO({ env: { TRAJ_DIR: TMP } }); // no model: must not be called
    const code = runRecap(["abc123", "--window", "10"], h2.io);
    expect(code).toBe(0);
    expect(h2.llmCalls).toHaveLength(0);
    expect(h2.err()).toContain("no new steps since last recap");
  });

  it("incremental refresh resumes after the last COMPLETE episode", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(10)); // window=10 -> one complete 'size' cut
    const h1 = await recIO("mr-10");
    runRecap(["abc123", "--window", "10"], h1.io);
    let episodes = fs
      .readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(episodes.map((e) => e.partial)).toEqual([false]);

    // Append 12 more steps: resumes from raw_end_line+1, and windows again on
    // the NEW rows only (10 -> 'size' complete, 2 left over -> dropped as a
    // tiny eof tail since an episode already exists).
    writeTraj(runDir, traj(22));
    const h2 = await recIO("mr-10-resume");
    const code = runRecap(["abc123", "--window", "10"], h2.io);
    expect(code).toBe(0);
    episodes = fs
      .readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(episodes).toHaveLength(2);
    expect(episodes[1]!.n_steps).toBe(10);
    expect(episodes[0]!.title).toBe(reply("mr-10", 0).title); // the complete episode is kept, not resummarized
    expect(episodes[1]!.title).toBe(reply("mr-10-resume", 0).title);
    expect(h2.err()).toContain("leaving 2-step tail for the next refresh");
    // The map call only saw the resumed window's rows (11..20), not the whole trajectory again.
    expect(h2.llmCalls[0]!.stdin.split("\n")).toHaveLength(10);
    expect(h2.llmCalls[0]!.stdin).not.toContain("thought number 0\n");
  });

  it("a trailing partial episode (below MIN_TAIL, no sibling episodes yet) is re-summarized on every refresh until it grows", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(5)); // cold start: eof tail summarized even though 5 < MIN_TAIL(15) (no existing episodes to defer behind)
    const h1 = await recIO("mr-5");
    runRecap(["abc123"], h1.io);
    let episodes = fs.readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(episodes).toEqual([expect.objectContaining({ partial: true, n_steps: 5, title: reply("mr-5", 0).title })]);

    writeTraj(runDir, traj(15)); // grows to 15 total; the sole partial episode is dropped and resummarized whole
    const h2 = await recIO("mr-15");
    const code = runRecap(["abc123"], h2.io);
    expect(code).toBe(0);
    episodes = fs.readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(episodes).toEqual([expect.objectContaining({ partial: true, n_steps: 15, title: reply("mr-15", 0).title, idx: 1 })]);
    expect(h2.llmCalls[0]!.stdin.split("\n")).toHaveLength(15);
  });

  it("a tiny eof tail below MIN_TAIL is left for the next refresh (once a recap already exists)", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(10)); // window=10 -> first window is a complete 'size' cut (0 remaining)
    const h1 = await recIO("mr-10");
    runRecap(["abc123", "--window", "10"], h1.io);

    writeTraj(runDir, traj(15)); // 5 new steps: eof tail of size 5 < MIN_TAIL(15)
    const h2 = makeIO({ env: { TRAJ_DIR: TMP } }); // must not call llm
    const code = runRecap(["abc123", "--window", "10"], h2.io);
    expect(code).toBe(0);
    expect(h2.llmCalls).toHaveLength(0);
    expect(h2.err()).toContain("leaving 5-step tail for the next refresh");
    const episodes = fs.readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8").trimEnd().split("\n");
    expect(episodes).toHaveLength(1); // unchanged
  });

  it("--rebuild drops the cache directory before refreshing", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h1 = await recIO("mr-1");
    runRecap(["abc123"], h1.io);
    // A leftover file in the cache dir must be gone after --rebuild (the dir was dropped, not merged into).
    fs.writeFileSync(path.join(runDir, "recap", "stale.marker"), "x");

    const h2 = await recIO("mr-1");
    const code = runRecap(["abc123", "--rebuild"], h2.io);
    expect(code).toBe(0);
    expect(h2.llmCalls).toHaveLength(2); // map + reduce again
    expect(fs.existsSync(path.join(runDir, "recap", "stale.marker"))).toBe(false);
    const episodes = fs
      .readFileSync(path.join(runDir, "recap", "episodes.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.title).toBe(reply("mr-1", 0).title);
  });

  it("--cached never calls the llm and prints the existing recap verbatim", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h1 = await recIO("mr-1");
    runRecap(["abc123"], h1.io);

    const h2 = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--cached"], h2.io);
    expect(code).toBe(0);
    expect(h2.llmCalls).toHaveLength(0);
    expect(h2.out()).toContain("THEMES");
    expect(h2.out()).toContain("EPISODES");
  });

  it("--cached with no prior recap dies", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, []);
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--cached"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: no recap yet — run without --cached to generate one\n");
  });

  it("a locked cache directory (another recap in progress) dies", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    fs.mkdirSync(path.join(runDir, "recap", ".lock"), { recursive: true });
    const h = makeIO({ env: { TRAJ_DIR: TMP }, now: new Date("2026-01-01T00:00:00") });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("another recap is in progress");
  });

  it("a stale lock (>30 min old) is reclaimed", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const lockDir = path.join(runDir, "recap", ".lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date("2026-01-01T00:00:00");
    fs.utimesSync(lockDir, old, old);
    const h = await recIO("mr-1", { env: { TRAJ_DIR: TMP }, now: new Date("2026-01-01T01:00:00") });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(0);
  });

  it("the lock directory is released after a successful run", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h = await recIO("mr-1");
    runRecap(["abc123"], h.io);
    expect(fs.existsSync(path.join(runDir, "recap", ".lock"))).toBe(false);
  });

  it("the lock directory is released even when the map call dies", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, traj(1));
    const h = await recIO("transport-dropped", { httpFixtures: { 0: droppedStream("mr-1"), 1: droppedStream("mr-1") } });
    const code = runRecap(["abc123"], h.io);
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(runDir, "recap", ".lock"))).toBe(false);
  });
});

// =============================================================================
// Output: text and JSON
// =============================================================================

describe("runRecap: --json output shape", () => {
  it("emits {themes, episodes} with themes.json parsed and episodes as an array", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, [{ type: "thought", step_id: "aaaaaaaa", ts: "2026-01-01T00:00:00Z", content: "x" }]);
    const h = await recIO("mr-x");
    runRecap(["abc123", "--json"], h.io);
    const parsed = JSON.parse(h.out());
    expect(parsed.themes.arc).toBe(reply("mr-x", 1).arc);
    expect(Array.isArray(parsed.episodes)).toBe(true);
    expect(parsed.episodes[0].title).toBe(reply("mr-x", 0).title);
  });
});

describe("runRecap: text output shape", () => {
  it("renders the header, arc, THEMES, and EPISODES sections", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, [{ type: "thought", step_id: "aaaaaaaa", ts: "2026-01-01T00:00:00Z", content: "x" }]);
    const h = await recIO("mr-x");
    const ep = reply("mr-x", 0);
    const red = reply("mr-x", 1);
    runRecap(["abc123"], h.io);
    const text = h.out();
    expect(text).toMatch(/^◆ recap — 1 episodes over 1 steps/);
    expect(text).toContain(red.arc);
    expect(text).toContain(`THEMES\n1. ${red.themes[0].name} — ${red.themes[0].description}`);
    expect(text).toContain("EPISODES\n1. ");
    expect(text).toContain(`[${ep.notable_steps[0].step}] ${ep.notable_steps[0].note}`); // notable_steps rendering
  });
});

// =============================================================================
// --context: tiered rollups + staircase
// =============================================================================

describe("runRecap: --context", () => {
  function trajN(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      type: "thought",
      step_id: `s${String(i).padStart(7, "0")}`,
      ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      content: `step ${i}`,
    }));
  }

  it("with no rollups yet, prints only the raw tail (no LIFE header)", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(3));
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    const code = runRecap(["abc123", "--context", "--raw-tail", "3"], h.io);
    expect(code).toBe(0);
    expect(h.out()).not.toContain("YOUR LIFE SO FAR");
    expect(h.out()).toContain("=== RIGHT NOW — the last 3 steps, verbatim ===");
    expect(h.out()).toContain("[s0000000] thought: step 0");
  });

  it("writes rendered.tsv + rendered.meta.json + rollups/meta.json under the run dir", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(5));
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    runRecap(["abc123", "--context", "--raw-tail", "5"], h.io);
    expect(fs.existsSync(path.join(runDir, "rollups", "rendered.tsv"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "rollups", "rendered.meta.json"), "utf8"));
    expect(meta).toMatchObject({ version: 1, keep: KEEP_TYPES_JSON, raw_lines: 5 });
    const rollupMeta = JSON.parse(fs.readFileSync(path.join(runDir, "rollups", "meta.json"), "utf8"));
    expect(rollupMeta.start_index).toBe(0); // snapped down from n=5 with default fanout 10
  });

  it("seals a tier-1 block once fanout steps exist, with the correct on-disk name + shape", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(10));
    // start_index defaults to n on first enable; force backfill so [0,10) is in-scope.
    const h = await recIO("seal-10");
    const r = reply("seal-10", 0);
    const code = runRecap(["abc123", "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], h.io);
    expect(code).toBe(0);
    const blockPath = path.join(runDir, "rollups", "t1", "000000000000-000000000010.json");
    expect(fs.existsSync(blockPath)).toBe(true);
    const block = JSON.parse(fs.readFileSync(blockPath, "utf8"));
    expect(block).toMatchObject({ tier: 1, start: 0, end: 10, n: 10, summary: r.summary, themes: r.themes, model: expect.any(String) });
    expect(block.step_ids).toEqual(r.step_ids);
    // Compact, single line, no trailing content after the newline.
    expect(fs.readFileSync(blockPath, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("falls back to [first,last] step ids when the reply carries none (the refusal placeholder has none)", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(10));
    // HTTP fixture, not model output: a stream ending on finish_reason content_filter, so llm reports `refused:`.
    const refusal = { status: 200, content_type: "text/event-stream", body: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n' };
    const h = await recIO("transport-refusal", { httpFixtures: { 0: refusal } });
    runRecap(["abc123", "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], h.io);
    const block = JSON.parse(fs.readFileSync(path.join(runDir, "rollups", "t1", "000000000000-000000000010.json"), "utf8"));
    expect(block.step_ids).toEqual(["s0000000", "s0000009"]);
  });

  it("--cached under --context never seals new blocks nor calls the llm", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(10));
    const h = makeIO({ env: { TRAJ_DIR: TMP } }); // no replies queued
    const code = runRecap(["abc123", "--context", "--cached", "--backfill", "--fanout", "10"], h.io);
    expect(code).toBe(0);
    expect(h.llmCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(runDir, "rollups", "t1"))).toBe(false);
  });

  it("assembles a 2-tier staircase, coarsest first, then the raw tail verbatim", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(20)); // fanout=2: t1 blocks of 2, t2 blocks of 4
    const h = await recIO("staircase-20");
    const code = runRecap(["abc123", "--context", "--backfill", "--fanout", "2", "--raw-tail", "2"], h.io);
    expect(code).toBe(0);
    const text = h.out();
    expect(text).toContain("=== YOUR LIFE SO FAR — summarized, oldest first ===");
    expect(text).toContain("=== RIGHT NOW — the last 2 steps, verbatim ===");
    // Coarsest tier lines appear before the raw tail header.
    const lifeIdx = text.indexOf("YOUR LIFE SO FAR");
    const tailIdx = text.indexOf("RIGHT NOW");
    expect(lifeIdx).toBeGreaterThanOrEqual(0);
    expect(lifeIdx).toBeLessThan(tailIdx);
    expect(text).toContain(`[s000000${18}]`.replace("[s000000", "[s00000")); // sanity: last two raw steps present
  });

  it("--backfill resets the enable marker to 0 even on a fresh rollups dir", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(3));
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    runRecap(["abc123", "--context", "--backfill", "--raw-tail", "3"], h.io);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "rollups", "meta.json"), "utf8"));
    expect(meta.start_index).toBe(0);
  });

  it("without --backfill, first enable snaps start_index down to a fanout boundary at n", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(23));
    const h = makeIO({ env: { TRAJ_DIR: TMP } });
    runRecap(["abc123", "--context", "--fanout", "10", "--raw-tail", "3"], h.io);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "rollups", "meta.json"), "utf8"));
    expect(meta.start_index).toBe(20); // floor(23/10)*10
  });

  it("a locked rollups directory dies", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(3));
    fs.mkdirSync(path.join(runDir, "rollups", ".lock"), { recursive: true });
    const h = makeIO({ env: { TRAJ_DIR: TMP }, now: new Date("2026-01-01T00:00:00") });
    const code = runRecap(["abc123", "--context"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain("another rollup build is in progress");
  });

  it("--rebuild under --context removes sealed tier dirs before resealing", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(10));
    const h1 = await recIO("seal-10");
    runRecap(["abc123", "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], h1.io);
    const blockPath = path.join(runDir, "rollups", "t1", "000000000000-000000000010.json");
    fs.writeFileSync(path.join(runDir, "rollups", "t1", "stale.marker"), "x");

    const h2 = await recIO("seal-10");
    const code = runRecap(["abc123", "--context", "--rebuild", "--fanout", "10", "--raw-tail", "0"], h2.io);
    expect(code).toBe(0);
    expect(h2.llmCalls).toHaveLength(1); // resealed, not kept
    expect(fs.existsSync(path.join(runDir, "rollups", "t1", "stale.marker"))).toBe(false);
    const block = JSON.parse(fs.readFileSync(blockPath, "utf8"));
    expect(block.step_ids).toEqual(reply("seal-10", 0).step_ids);
  });

  it("renderCached appends only the new tail on a later call (incremental render)", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, trajN(5));
    const h1 = makeIO({ env: { TRAJ_DIR: TMP } });
    runRecap(["abc123", "--context", "--raw-tail", "5"], h1.io);
    const tsv1 = fs.readFileSync(path.join(runDir, "rollups", "rendered.tsv"), "utf8");
    expect(tsv1.trimEnd().split("\n")).toHaveLength(5);

    writeTraj(runDir, trajN(8));
    const h2 = makeIO({ env: { TRAJ_DIR: TMP } });
    runRecap(["abc123", "--context", "--raw-tail", "8"], h2.io);
    const tsv2 = fs.readFileSync(path.join(runDir, "rollups", "rendered.tsv"), "utf8");
    expect(tsv2.trimEnd().split("\n")).toHaveLength(8);
    // The first 5 rows are byte-identical (append-only, not rebuilt).
    expect(tsv2.startsWith(tsv1.trimEnd())).toBe(true);
  });
});

// =============================================================================
// Adversarial-parity regression tests (F1-F4, PARITY.md "recap parity fixes")
// =============================================================================

describe("F1: huge (>1MiB) llm reply is not silently discarded", () => {
  // The bug itself (spawnSync's default 1 MiB maxBuffer -> ENOBUFS -> a
  // masked retry) lives in bin/recap.mjs's process-spawn wiring, outside
  // this injected-io seam (see parity/recap adversarial llm/*-huge-reply-*,
  // which drives the real subprocess and is where F1 is actually proven).
  // This pins the OTHER half: src/recap.ts's own parse/serialize path must
  // not choke on or truncate an arbitrarily large, well-formed reply.
  // Parser, no model: a model never sends 2 MB, so the parse/serialize half is tested directly.
  it("a >1MiB reply parses whole and serializes back whole (parser, no model)", () => {
    const bigSummary = "y".repeat(2_000_000);
    const v = parseLlmJson(JSON.stringify({ title: "huge", summary: bigSummary, themes: [], notable_steps: [] }) + "\n") as { summary: string };
    expect(v.summary).toBe(bigSummary);
    const back = JSON.parse(jqCompact(v as never));
    expect(back.summary.length).toBe(2_000_000);
  });
});

describe("F2: bashArith unbound-variable propagates to a die(), not a silent 0", () => {
  it("RECAP_CONTEXT_BUDGET_MAX=<bare identifier> dies before writing rollups/meta.json", () => {
    const runDir = path.join(TMP, "abc123");
    const traj = Array.from({ length: 10 }, (_, i) => ({
      type: "thought",
      step_id: `s${String(i).padStart(7, "0")}`,
      ts: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      content: `step ${i}`,
    }));
    writeTraj(runDir, traj);
    const h = makeIO({ env: { TRAJ_DIR: TMP, RECAP_CONTEXT_BUDGET_MAX: "notanumber" } });
    const code = runRecap(["abc123", "--context"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: notanumber: unbound variable\n");
    expect(h.out()).toBe("");
    // renderCached() ran (rendered.tsv/rendered.meta.json exist) — the abort
    // happens in ctxResolveR(), BEFORE rollups/meta.json's start-marker write.
    expect(fs.existsSync(path.join(runDir, "rollups", "rendered.tsv"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "rollups", "meta.json"))).toBe(false);
  });

  it("a bare identifier in MODEL_CONTEXT_WINDOW also dies unbound (same call class)", () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, [{ type: "thought", step_id: "s0000000", ts: "2026-01-01T00:00:00Z", content: "c" }]);
    const h = makeIO({ env: { TRAJ_DIR: TMP, MODEL_CONTEXT_WINDOW: "notawindow" } });
    const code = runRecap(["abc123", "--context"], h.io);
    expect(code).toBe(1);
    expect(h.err()).toBe("recap: error: notawindow: unbound variable\n");
  });
});

describe("F3: tsvEscape escapes an embedded NUL like jq's @tsv", () => {
  it("tsvEscape renders NUL as the literal two-character text \\0", () => {
    expect(tsvEscape("a b c")).toBe("a\\0b\\0c");
  });

  it("a NUL in step content reaches the llm subprocess stdin as \\0, never a raw NUL byte", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a b c" }]);
    const h = await recIO("mr-nul");
    const code = runRecap(["abc123", "--window", "10"], h.io);
    expect(code).toBe(0);
    expect(h.llmCalls[0]!.stdin).toContain("a\\0b\\0c");
    expect(h.llmCalls[0]!.stdin).not.toContain(" ");
  });
});

describe("F4: LLM reply number literals survive verbatim (RawNumber/parseJsonLossless)", () => {
  // Parser, no model: a real reply's episode numbers are small integers, so the literal-text cases are parser input.
  it("themes[].episodes keeps 1.0 and a 20-digit integer's exact text through parse and pretty-print (parser, no model)", () => {
    const v = parseLlmJson('{"arc":"a","themes":[{"name":"t","description":"d","episodes":[1.0,2,99999999999999999999],"key_steps":[]}]}');
    expect(jqPretty(v as never)).toContain("1.0,\n        2,\n        99999999999999999999");
    expect(jqCompact(v as never)).toContain("[1.0,2,99999999999999999999]");
  });

  it("framework-computed numbers (idx, episodes count) are untouched by lossless parsing", async () => {
    const runDir = path.join(TMP, "abc123");
    writeTraj(runDir, [{ type: "thought", step_id: "s0000000", ts: "2026-01-01T00:00:00Z", content: "c" }]);
    const h = await recIO("mr-c");
    runRecap(["abc123", "--window", "10"], h.io);
    const themes = JSON.parse(fs.readFileSync(path.join(runDir, "recap", "themes.json"), "utf8"));
    expect(themes.episodes).toBe(1);
    expect(themes.raw_end_line).toBe(1);
  });
});

// Parser comparison on literal strings, no model. Upstream's `_llm_json` validates with `jq -e .`, which accepts a
// STREAM of JSON values when the last one is truthy (checked against the real cut function in
// parity/recap/run-parser-parity.mjs); the next `--argjson body` then aborts (src/recap.ts argjsonSeqAbort).
describe("parseLlmJson: a reply of several JSON values (jq -e . semantics)", () => {
  it("accepts a stream whose last value is truthy, as a JsonSeq carrying the cleaned text", () => {
    const v = parseLlmJson('{"a":1}\n{"b":2}\n');
    expect(v).toBeInstanceOf(JsonSeq);
    expect((v as JsonSeq).text).toBe('{"a":1}\n{"b":2}');
  });
  it("rejects a stream whose last value is null or false, or that has garbage", () => {
    expect(parseLlmJson('{"a":1}\nnull\n')).toBeUndefined();
    expect(parseLlmJson('{"a":1}\nfalse\n')).toBeUndefined();
    expect(parseLlmJson('{"a":1} x\n')).toBeUndefined();
  });
  it("splits values glued on one line the way jq reads them", () => {
    expect(splitJsonSeq('{"a":"}"}[1] 2 "s"')).toEqual(['{"a":"}"}', "[1]", "2", '"s"']);
  });
});
