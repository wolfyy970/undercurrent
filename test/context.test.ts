// context.test.ts — tests for the `context` tool (SPEC §1.4, bin/context), the
// live per-iteration reconstruction of the model's chat history.
//
// Two layers are covered:
//   1. buildContext — the ENGINE-facing projection (responder/monolith call it
//      on the full step array): role assignment, head/tail windowing, gap
//      elision, per-field byte truncation, blob loading, merge.
//   2. runContext  — the standalone CLI TOOL the model shells out to: the Bash
//      contract (stdout/stderr/exit + on-disk read-only-ness), including the
//      byte-exact JSON output, resolution, errors, --max-bytes, AND the U+007F
//      (DEL) escaping regression the differential audit caught (jq escapes it
//      as \u007f; Node's JSON.stringify emits the raw byte). These pin the
//      behaviour WITHOUT needing the Bash oracle.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildContext,
  runContext,
  MONOLITH_CONTEXT_OPTS,
  type ContextOptions,
  type ContextIO,
} from "../src/context.js";

type Row = Record<string, unknown>;
const opts = (o: Partial<ContextOptions> = {}): ContextOptions => ({ ...MONOLITH_CONTEXT_OPTS, ...o });

describe("buildContext — roles, exclusion, gap-elision, merge, rendering", () => {
  it("assigns roles, excludes shellm-run, injects a gap, and merges same-role turns", () => {
    const steps: Row[] = [
      { type: "prompt", step_id: "s1", content: "hello" }, // user
      { type: "reasoning", step_id: "s2", thought: "thinking", cmd: "echo hi" }, // assistant
      { type: "shell-output", step_id: "s3", stdout: "hi" }, // user
      { type: "shellm-run", step_id: "s4", wake: "timer" }, // excluded → does NOT create a gap (see below)
      { type: "final", step_id: "s5", content: "done" }, // assistant
      { type: "weirdtype", step_id: "s6", content: "x" }, // unknown → defaults to user
    ];
    const msgs = buildContext(steps, opts());
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    // reasoning renders thought then a ```bash block for cmd.
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("thinking\n\n```bash\necho hi\n```");
    // PORT-NOTE (1c: 7a35982 bug fix): bin/context's own gap_between subtracts
    // excluded-role rows from the elision count ($skip) — an excluded row
    // between two kept rows is dropped silently, NOT counted as "elided".
    // buildContext previously counted it (a raw index-difference gap with no
    // $skip subtraction), a genuine port bug caught while adding run-scope's
    // own in_run-based $skip (which needed the same subtraction machinery to
    // behave correctly). s4 is excluded and alone between s3 and s5, so the
    // gap is now exactly 0: no elision marker, so s3 stays unmerged.
    expect(msgs[2]).toEqual({ role: "user", content: "hi" });
    expect(msgs[3]).toEqual({ role: "assistant", content: "done" });
    // unknown type defaults to the user role (roleFor fallthrough).
    expect(msgs[4]).toEqual({ role: "user", content: "x" });
  });

  it("keeps only head + tail (plus pins) and counts the elided gaps", () => {
    const steps: Row[] = Array.from({ length: 10 }, (_, i) => ({
      type: "prompt",
      step_id: `s${i}`,
      content: `c${i}`,
    }));
    const msgs = buildContext(steps, opts({ head: 1, tail: 2, pins: ["s5"] }));
    // kept: s0 (head), s5 (pin), s8+s9 (tail). All user → merged into one turn.
    expect(msgs.length).toBe(1);
    const c = msgs[0]!.content;
    expect(c).toContain("c0");
    expect(c).toContain("[4 steps elided]"); // between s0 and the pinned s5
    expect(c).toContain("c5");
    expect(c).toContain("[2 steps elided]"); // between s5 and the tail (s8)
    expect(c).toContain("c8");
    expect(c).toContain("c9");
    expect(c).not.toContain("c3"); // a windowed-out middle step
  });
});

// PORT-NOTE (1c: 3228c8c, 1fdeb97, 7a35982, d43ae81, 0f8b49e)
describe("buildContext — bookkeeping is_meta, --tail-block, --run scope, --full-types, block-limit band", () => {
  it("hides run_id/llm_s/in_tok/out_tok/think_tok/cache_tok/estimated/source_url from the model (3228c8c, 1fdeb97, f68c1d8)", () => {
    const steps: Row[] = [
      {
        type: "reasoning",
        step_id: "r1",
        thought: "t",
        run_id: "run-1",
        llm_s: 2,
        in_tok: 100,
        out_tok: 50,
        think_tok: 10,
        cache_tok: 80,
        estimated: true,
        source_url: "https://example.slack.com/archives/C1/p1",
      },
    ];
    const msgs = buildContext(steps, opts());
    expect(msgs[0]!.content).toBe("t");
    for (const bad of [
      "run_id",
      "run-1",
      "llm_s",
      "in_tok",
      "out_tok",
      "think_tok",
      "cache_tok",
      "100",
      "50",
      "80",
      "source_url",
      "example.slack.com",
    ]) {
      expect(msgs[0]!.content).not.toContain(bad);
    }
  });

  it("--tail-block: the window's start moves only in steps of `block` rows, holding tail..tail+block-1", () => {
    const steps: Row[] = Array.from({ length: 12 }, (_, i) => ({ type: "prompt", step_id: `s${i}`, content: `c${i}` }));
    // N=12, tail=2, block=5: raw start = 10, floor(10/5)*5 = 10 -> window is [10,11] (same as tail=2 here).
    const a = buildContext(steps, opts({ head: 0, tail: 2, tailBlock: 5 }));
    expect(a.map((m) => m.content).join(" ")).toContain("c10");
    expect(a.map((m) => m.content).join(" ")).toContain("c11");
    // One more step appended (N=13): raw start = 11, floor(11/5)*5 = 10 -> window STILL [10,12], not sliding.
    const steps2 = [...steps, { type: "prompt", step_id: "s12", content: "c12" }];
    const b = buildContext(steps2, opts({ head: 0, tail: 2, tailBlock: 5 }));
    const joined = b.map((m) => m.content).join(" ");
    expect(joined).toContain("c10"); // still present — did NOT slide out on the very next row
    expect(joined).toContain("c12");
  });

  it("--full-types: a prompt step is never truncated, whatever the byte limit says", () => {
    const long = "X".repeat(5000);
    const steps: Row[] = [{ type: "prompt", step_id: "p1", content: long }];
    const truncated = buildContext(steps, opts({ head: 1, tail: 0, promptLimit: 100 }));
    expect(truncated[0]!.content.length).toBeLessThan(long.length);
    const whole = buildContext(steps, opts({ head: 1, tail: 0, promptLimit: 100, fullTypes: ["prompt"] }));
    expect(whole[0]!.content).toBe(long);
  });

  it("--run RUN_ID: drops other runs' rows silently, marks a gap inside the run with no count, none before the first kept row", () => {
    const steps: Row[] = [
      { type: "prompt", step_id: "p0", content: "other-run prompt", run_id: "run-A" },
      { type: "reasoning", step_id: "r1", thought: "other run reasoning", run_id: "run-A" },
      { type: "prompt", step_id: "p1", content: "my prompt", run_id: "run-B" },
      { type: "reasoning", step_id: "r2", thought: "mine one", run_id: "run-B" },
      { type: "shellm-run", step_id: "hdr", run_id: "run-B" }, // excluded role, not a gap either
      { type: "reasoning", step_id: "r3", thought: "mine two", run_id: "run-B" },
    ];
    const msgs = buildContext(steps, opts({ head: 0, tail: steps.length, run: "run-B" }));
    const contents = msgs.map((m) => m.content);
    expect(contents.join(" ")).not.toContain("other-run");
    expect(contents.join(" ")).not.toContain("[earlier steps elided]"); // nothing kept BEFORE p1: no marker at all
    expect(contents.join(" ")).toContain("my prompt");
    expect(contents.join(" ")).toContain("mine one");
    expect(contents.join(" ")).toContain("mine two");
    // "mine one" and "mine two" are consecutive within the run (hdr is
    // excluded, not a gap) so they merge into ONE assistant turn with no
    // elision marker between them.
    expect(msgs.some((m) => m.content === "[earlier steps elided]")).toBe(false);
  });

  it("--run RUN_ID: a real gap INSIDE the run (a step outside head/tail window) marks '[earlier steps elided]' with no count", () => {
    const steps: Row[] = Array.from({ length: 10 }, (_, i) => ({
      type: "reasoning",
      step_id: `s${i}`,
      thought: `t${i}`,
      run_id: "run-X",
    }));
    // head=1 tail=2 within the RUN's own rows (all belong to run-X): keeps s0, s8, s9.
    const msgs = buildContext(steps, opts({ head: 1, tail: 2, run: "run-X" }));
    const gapMsg = msgs.find((m) => m.content.includes("elided"));
    expect(gapMsg?.content).toContain("[earlier steps elided]");
    expect(gapMsg?.content).not.toMatch(/\[\d+ steps elided\]/); // no count in run scope
  });

  it("block-limit band: rows in the newest window-block render at blockLimit; older rows keep promptLimit", () => {
    const long = "Y".repeat(500);
    // Different roles (prompt=user, final=assistant) so mergeRoles does not
    // fold the two turns into one before the length assertions below.
    const steps: Row[] = [
      { type: "prompt", step_id: "s0", content: long },
      { type: "final", step_id: "s1", content: long },
    ];
    const msgs = buildContext(steps, opts({ head: 0, tail: 2, promptLimit: 50, blockLimit: 5000, wholeBlocks: 1 }));
    // s0 (index 0, older than the band start N-1=1) is cut at promptLimit=50;
    // s1 (the newest row) renders whole under blockLimit=5000.
    expect(msgs[0]!.content.length).toBeLessThan(long.length);
    expect(msgs[1]!.content).toBe(long);
  });
});

describe("renderStep — field truncation, blob loading, field labels", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-test-"));
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("byte-truncates an oversized field with a head/tail marker citing the step", () => {
    const steps: Row[] = [{ type: "prompt", step_id: "big1", content: "A".repeat(100) }];
    const msgs = buildContext(steps, opts({ promptLimit: 20 }));
    const c = msgs[0]!.content;
    expect(c).toContain("[... truncated: 100 bytes total. read with: traj show big1 --full]");
    expect(c.length).toBeLessThan(100);
  });

  it("loads a *_ref blob from disk to reconstitute truncated stdout", () => {
    const trajFile = path.join(TMP, "trajectory.jsonl");
    fs.writeFileSync(trajFile, "");
    fs.mkdirSync(path.join(TMP, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "blobs", "big.stdout"), "FULL BLOB BODY");
    const steps: Row[] = [
      {
        type: "shell-output",
        step_id: "o1",
        stdout: "TRUNC",
        stdout_ref: "blobs/big.stdout",
        stdout_truncated: true,
      },
    ];
    const msgs = buildContext(steps, opts({ trajFile }));
    expect(msgs[0]!.content).toContain("FULL BLOB BODY");
    expect(msgs[0]!.content).not.toContain("TRUNC");
  });

  it("labels non-cmd/thought fields with [key] when a step has multiple fields", () => {
    const steps: Row[] = [{ type: "shell-output", step_id: "o2", stdout: "out here", exit: "0" }];
    const msgs = buildContext(steps, opts());
    expect(msgs[0]!.content).toContain("[stdout]\nout here");
    expect(msgs[0]!.content).toContain("[exit]\n0");
  });
});

// ============================================================================
// runContext — the standalone CLI tool (byte-exact port of headlong/bin/context)
// ============================================================================

const DEL = String.fromCharCode(0x7f); // U+007F, the audited escaping divergence
const UUID = (h: string) => `${h}-1111-2222-3333-444444444444`;
const T = (h: string) => ({ type: "trajectory", step_id: h });

interface CtxHarness {
  io: ContextIO;
  out(): string;
  outBytes(): Buffer;
  err(): string;
}

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-cli-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Deterministic IO harness. stdout is captured as raw BYTES so the --max-bytes
 *  hard-truncation path (Uint8Array) and the 0x7f escaping are byte-checkable. */
function makeCtxIO(env: Record<string, string | undefined> = {}): CtxHarness {
  const chunks: Buffer[] = [];
  let err = "";
  const io: ContextIO = {
    cwd: TMP,
    env,
    stdout: (s) => chunks.push(typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)),
    stderr: (s) => {
      err += s;
    },
  };
  return { io, out: () => Buffer.concat(chunks).toString("utf8"), outBytes: () => Buffer.concat(chunks), err: () => err };
}

/** Write a `<hex>-root/trajectory.jsonl` fixture under TMP/trajdir. A step that
 *  is a string beginning "RAW:" is written verbatim (malformed / hand-crafted). */
function writeTraj(
  hex: string,
  steps: unknown[],
  o: { noFinalNL?: boolean; blobs?: Record<string, string> } = {},
): void {
  const rootDir = path.join(TMP, "trajdir", `${hex}-root`);
  fs.mkdirSync(rootDir, { recursive: true });
  const body =
    steps
      .map((s) => (typeof s === "string" && s.startsWith("RAW:") ? s.slice(4) : JSON.stringify(s)))
      .join("\n") + (o.noFinalNL ? "" : "\n");
  fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), body);
  if (o.blobs) {
    const bdir = path.join(rootDir, "blobs");
    fs.mkdirSync(bdir, { recursive: true });
    for (const [name, content] of Object.entries(o.blobs)) fs.writeFileSync(path.join(bdir, name), content);
  }
}

/** env pointing $TRAJ_DIR/$TRAJ_ID at a `<hex>-root` fixture (the resolve path). */
const rootEnv = (hex: string) => ({ TRAJ_DIR: "./trajdir", TRAJ_ID: UUID(hex) });

describe("runContext — CLI contract (stdout/stderr/exit, read-only)", () => {
  it("renders a final step as an assistant message, no trailing newline", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "done" }]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    const rc = runContext(["--head", "2", "--tail", "0", "--assistant-types", "final"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe('[\n  {\n    "role": "assistant",\n    "content": "done"\n  }\n]');
    expect(h.err()).toBe("");
  });

  it("assigns roles by type and merges consecutive same-role turns (\\n---\\n)", () => {
    writeTraj("aaaaaaaa", [
      T("aaaaaaaa"),
      { type: "prompt", step_id: "p1", content: "ask" },
      { type: "reasoning", step_id: "r1", thought: "think", cmd: "ls" },
      { type: "reasoning", step_id: "r2", thought: "more" },
      { type: "final", step_id: "f1", content: "answer" },
    ]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(
      ["--head", "5", "--tail", "0", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
      h.io,
    );
    const msgs = JSON.parse(h.out()) as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]).toEqual({ role: "user", content: "ask" });
    // reasoning(cmd,thought merged), reasoning(thought), final all assistant → one turn.
    // sync 2e39a3f (815eab2): a reasoning row renders thought THEN the fenced cmd (was jq-sorted cmd-first).
    expect(msgs[1]!.content).toBe("think\n\n```bash\nls\n```\n---\nmore\n---\nanswer");
  });

  it("injects [N steps elided] markers for the windowed-out middle", () => {
    writeTraj("bbbbbbbb", [
      T("bbbbbbbb"),
      { type: "prompt", step_id: "s1", content: "one" },
      { type: "reasoning", step_id: "s2", thought: "two" },
      { type: "reasoning", step_id: "s3", thought: "three" },
      { type: "reasoning", step_id: "s4", thought: "four" },
      { type: "final", step_id: "s5", content: "five" },
    ]);
    const h = makeCtxIO(rootEnv("bbbbbbbb"));
    runContext(
      ["--head", "1", "--tail", "2", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
      h.io,
    );
    const msgs = JSON.parse(h.out()) as { role: string; content: string }[];
    // head keeps only the trajectory row (renders "") → first surviving turn is
    // the elision marker, then the tail (four+five merged).
    expect(msgs[0]).toEqual({ role: "user", content: "[3 steps elided]" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "four\n---\nfive" });
  });

  it("pins keep a middle step outside the head/tail window", () => {
    writeTraj("dddddddd", [
      T("dddddddd"),
      { type: "prompt", step_id: "p1", content: "one" },
      { type: "reasoning", step_id: "pinned-step-id", thought: "PINME" },
      { type: "reasoning", step_id: "p3", thought: "three" },
      { type: "reasoning", step_id: "p4", thought: "four" },
      { type: "final", step_id: "p5", content: "five" },
    ]);
    const h = makeCtxIO(rootEnv("dddddddd"));
    runContext(
      ["--head", "1", "--tail", "1", "--pin", "pinned-step-id", "--assistant-types", "reasoning,final"],
      h.io,
    );
    expect(h.out()).toContain("PINME");
  });

  it("pretty-prints an object-valued content field like jq (pp)", () => {
    writeTraj("aaaaaaaa", [
      T("aaaaaaaa"),
      { type: "custom", step_id: "c1", data: { z: 1, a: [1, 2] } },
    ]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "2", "--tail", "0", "--user-types", "custom"], h.io);
    const msgs = JSON.parse(h.out()) as { role: string; content: string }[];
    // jq `pp` walks `to_entries` (= keys_unsorted = INSERTION order), so "z"
    // stays before "a"; only `keys` — used for the top-level field iteration —
    // sorts. 2-space pretty print. Byte-exact with the Bash oracle (jq 1.7.1).
    expect(msgs[0]!.content).toBe('{\n  "z": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
  });

  it("loads a *_ref blob to reconstitute truncated stdout", () => {
    writeTraj(
      "ffffffff",
      [
        T("ffffffff"),
        { type: "shell-output", step_id: "b1", stdout: "inline", stdout_ref: "blobs/big.stdout", stdout_truncated: true },
      ],
      { blobs: { "big.stdout": "FULL BLOB CONTENT\n\n\n" } },
    );
    const h = makeCtxIO(rootEnv("ffffffff"));
    runContext(["--user-types", "shell-output"], h.io);
    const msgs = JSON.parse(h.out()) as { role: string; content: string }[];
    expect(msgs[0]!.content).toBe("FULL BLOB CONTENT"); // blob rtrimmed, inline replaced
    expect(h.out()).not.toContain("inline");
  });

  it("byte-truncates an oversized field, citing the step id", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "A".repeat(100) }]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "2", "--tail", "0", "--prompt-limit", "20", "--assistant-types", "final"], h.io);
    expect(h.out()).toContain("[... truncated: 100 bytes total. read with: traj show g1 --full]");
  });

  it("empty trajectory → [] WITH a trailing newline", () => {
    fs.mkdirSync(path.join(TMP, "trajdir", "56565656-root"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "trajdir", "56565656-root", "trajectory.jsonl"), "");
    const h = makeCtxIO(rootEnv("56565656"));
    const rc = runContext([], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("[]\n");
  });

  it("a lone trajectory row → [] with NO trailing newline (renders to empty)", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa")]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "1", "--tail", "0"], h.io);
    expect(h.out()).toBe("[]");
  });

  it("does not write to disk (read-only): fixture bytes are unchanged", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "done" }]);
    const file = path.join(TMP, "trajdir", "aaaaaaaa-root", "trajectory.jsonl");
    const before = fs.readFileSync(file);
    const dirBefore = fs.readdirSync(path.join(TMP, "trajdir", "aaaaaaaa-root")).sort();
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "2", "--tail", "0", "--assistant-types", "final"], h.io);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(TMP, "trajdir", "aaaaaaaa-root")).sort()).toEqual(dirBefore);
  });
});

// PORT-NOTE (1c: 7a35982, d43ae81, 0f8b49e) — the standalone CLI's own
// --run/--tail-block/--full-types/--block-limit/--whole-blocks flags.
describe("runContext — --run, --tail-block, --full-types, --block-limit/--whole-blocks", () => {
  it("--run RUN_ID: only that run's steps render; other runs are dropped without an elision count", () => {
    writeTraj("aaaaaaaa", [
      T("aaaaaaaa"),
      { type: "prompt", step_id: "p0", content: "other run", run_id: "run-A" },
      { type: "final", step_id: "f0", content: "mine", run_id: "run-B" },
    ]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    const rc = runContext(["--head", "0", "--tail", "3", "--run", "run-B", "--assistant-types", "final", "--user-types", "prompt"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).not.toContain("other run");
    expect(h.out()).toContain("mine");
    expect(h.out()).not.toContain("elided"); // nothing kept before the first run-B row: no marker
  });

  it("--tail-block: the window's start does not slide until `block` new rows have appended", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({ type: "final", step_id: `s${i}`, content: `c${i}` }));
    writeTraj("bbbbbbbb", [T("bbbbbbbb"), ...steps]);
    const h = makeCtxIO(rootEnv("bbbbbbbb"));
    runContext(["--head", "0", "--tail", "2", "--tail-block", "5", "--assistant-types", "final"], h.io);
    // N (fed items, trajectory row excluded from role assignment but counted
    // in TOTAL_LINES) puts window_start at a multiple of 5 — c9 stays in view
    // even though plain tail=2 alone would have dropped it.
    expect(h.out()).toContain("c9");
    expect(h.out()).toContain("c10");
  });

  it("--full-types prompt: a prompt step's content is never cut by --prompt-limit", () => {
    const long = "Z".repeat(3000);
    writeTraj("cccccccc", [T("cccccccc"), { type: "prompt", step_id: "p1", content: long }]);
    const h = makeCtxIO(rootEnv("cccccccc"));
    runContext(["--head", "2", "--tail", "0", "--user-types", "prompt", "--prompt-limit", "50", "--full-types", "prompt"], h.io);
    expect(h.out()).toContain(long);
  });

  it("--block-limit/--whole-blocks: the newest row renders whole up to --block-limit; older rows keep --prompt-limit", () => {
    const long = "W".repeat(400);
    writeTraj("dddddddd", [
      T("dddddddd"),
      { type: "prompt", step_id: "p1", content: long },
      { type: "final", step_id: "f1", content: long },
    ]);
    const h = makeCtxIO(rootEnv("dddddddd"));
    runContext(
      ["--head", "0", "--tail", "2", "--prompt-limit", "50", "--block-limit", "5000", "--whole-blocks", "1", "--user-types", "prompt", "--assistant-types", "final"],
      h.io,
    );
    const msgs = JSON.parse(h.out()) as { role: string; content: string }[];
    // p1 (older, index 1 of 2 total rows incl. the trajectory row at 0 — the
    // band is the newest ROW) is cut; f1 (the newest row) is whole.
    expect(msgs.find((m) => m.role === "user")!.content.length).toBeLessThan(long.length);
    expect(msgs.find((m) => m.role === "assistant")!.content).toBe(long);
  });
});

// --- U+007F (DEL) escaping — the differential audit's one PORT BUG -------------
// jq's `tojson` escapes U+007F as the 6-char sequence \u007f; Node's
// JSON.stringify emits the raw 0x7f byte. jqJson restores the jq encoding at
// BOTH JSON-emitting sites. The plain-string case is only catchable at the BYTE
// level (both encodings JSON-parse to the same string), so these assert raw
// bytes — no Bash oracle needed.

describe("runContext — U+007F (DEL) escaped like jq (port-bug regression)", () => {
  it("escapes a raw 0x7f in a string field as \\u007f (byte-exact, no raw DEL)", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "del" + DEL + "here" }]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "2", "--tail", "0", "--assistant-types", "final"], h.io);
    // Byte-for-byte with jq (captured from the Bash oracle in the parity report).
    expect(h.out()).toBe('[\n  {\n    "role": "assistant",\n    "content": "del\\u007fhere"\n  }\n]');
    // The raw byte MUST NOT survive (this is what the pre-fix port emitted).
    expect(h.outBytes().includes(0x7f)).toBe(false);
    expect(h.out()).toContain("\\u007f");
  });

  it("escapes 0x7f inside an object field at both pp and array levels", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", data: { s: "x" + DEL + "y" } }]);
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    runContext(["--head", "2", "--tail", "0", "--user-types", "custom"], h.io);
    // pp emits literal \u007f (single backslash); the outer array then escapes
    // that backslash → \\u007f. Byte-for-byte with jq.
    expect(h.out()).toBe(
      '[\n  {\n    "role": "user",\n    "content": "{\\n  \\"s\\": \\"x\\\\u007fy\\"\\n}"\n  }\n]',
    );
    expect(h.outBytes().includes(0x7f)).toBe(false);
  });
});

// --- resolution & error paths -------------------------------------------------

describe("runContext — resolution and errors", () => {
  it("resolves via --traj_dir + a bare hex prefix (find <hex>-* glob)", () => {
    writeTraj("bcbcbcbc", [T("bcbcbcbc"), { type: "final", step_id: "s1", content: "ok" }]);
    const h = makeCtxIO();
    const rc = runContext(["--traj_dir", "./trajdir", "bcbcbcbc", "--assistant-types", "final"], h.io);
    expect(rc).toBe(0);
    expect(JSON.parse(h.out())).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("resolves via $TRAJ_DIR + $TRAJ_ID from a full UUID", () => {
    writeTraj("bcbcbcbc", [T("bcbcbcbc"), { type: "final", step_id: "s1", content: "envwin" }]);
    const h = makeCtxIO(rootEnv("bcbcbcbc"));
    const rc = runContext(["--assistant-types", "final"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toContain("envwin");
  });

  it("no trajectory specified → rc1, empty stdout, clean stderr", () => {
    const h = makeCtxIO();
    const rc = runContext([], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe(
      "context: error: No trajectory specified. Use --traj_dir DIR <ID>, or set TRAJ_DIR + TRAJ_ID env vars.\n",
    );
  });

  it("unknown option → rc1 with clean stderr", () => {
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    const rc = runContext(["--bogus"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("context: error: unknown option: --bogus\n");
  });

  it("extra positional argument → rc1", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa")]);
    const h = makeCtxIO();
    const rc = runContext(["--traj_dir", "./trajdir", UUID("aaaaaaaa"), "EXTRA"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("context: error: unexpected argument: EXTRA\n");
  });

  it("cannot resolve traj id → rc1 with a diagnostic", () => {
    writeTraj("aaaaaaaa", [T("aaaaaaaa")]);
    const h = makeCtxIO();
    const rc = runContext(["--traj_dir", "./trajdir", UUID("deadbeef")], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("context: error: cannot resolve traj ID 'deadbeef-1111-2222-3333-444444444444' in './trajdir'\n");
  });

  // Bash `${2:?msg}` deviation: a missing/empty required flag value dies rc1.
  // Bash prints `<script>: line N: 2: <msg>`; the port prints the clean
  // `context: error: <msg>` (exit code, empty stdout, and read-only state match;
  // only the stderr wording differs — a documented, caller-invisible deviation).
  it("--head with no value → rc1, empty stdout, clean stderr (${2:?} deviation)", () => {
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    const rc = runContext(["--head"], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("context: error: --head requires N\n");
  });

  it("--assistant-types with an EMPTY value also dies (Bash treats empty as unset)", () => {
    const h = makeCtxIO(rootEnv("aaaaaaaa"));
    const rc = runContext(["--assistant-types", ""], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("context: error: --assistant-types requires LIST\n");
  });

  it("-h / --help prints usage to stdout, rc0", () => {
    const h1 = makeCtxIO();
    expect(runContext(["-h"], h1.io)).toBe(0);
    expect(h1.out()).toContain("Usage: context [options]");

    const h2 = makeCtxIO();
    expect(runContext(["--help"], h2.io)).toBe(0);
    expect(h2.out()).toContain("Usage: context [options]");
  });
});

// --- --max-bytes budget -------------------------------------------------------

describe("runContext — --max-bytes budget", () => {
  it("under budget prints the full array (no trailing newline)", () => {
    writeTraj("34343434", [
      T("34343434"),
      { type: "reasoning", step_id: "x1", thought: "A".repeat(20) },
      { type: "final", step_id: "x2", content: "B".repeat(20) },
    ]);
    const h = makeCtxIO(rootEnv("34343434"));
    const rc = runContext(
      ["--max-bytes", "9999", "--head", "1", "--tail", "3", "--assistant-types", "reasoning,final"],
      h.io,
    );
    expect(rc).toBe(0);
    expect(h.out().endsWith("\n")).toBe(false);
    expect(() => JSON.parse(h.out())).not.toThrow();
  });

  it("binary-searches a smaller prompt-limit to fit the budget", () => {
    writeTraj("34343434", [
      T("34343434"),
      { type: "reasoning", step_id: "x1", thought: "A".repeat(300) },
      { type: "reasoning", step_id: "x2", thought: "B".repeat(300) },
      { type: "final", step_id: "x3", content: "C".repeat(300) },
    ]);
    const h = makeCtxIO(rootEnv("34343434"));
    // Budget 300: the tightest possible render (limit <= 1, marker-only fields)
    // is 260 bytes, so the fit path is reachable and the search lands on limit 9
    // (half 4 → 296 bytes). A budget under 260 (e.g. 220) is unreachable and
    // Bash itself hard-truncates + warns — that path is the next test.
    const rc = runContext(
      ["--max-bytes", "300", "--prompt-limit", "500", "--head", "1", "--tail", "3", "--assistant-types", "reasoning,final"],
      h.io,
    );
    expect(rc).toBe(0);
    expect(h.outBytes().length).toBeLessThanOrEqual(300);
    // fit-path (not hard truncation) → still valid JSON, no stderr warning.
    expect(() => JSON.parse(h.out())).not.toThrow();
    expect(h.err()).toBe("");
    expect(h.out()).toContain("[... truncated:");
    // Byte-exact with the Bash oracle on this fixture.
    expect(h.out()).toBe(
      '[\n  {\n    "role": "assistant",\n    "content": "AAAA\\n[... truncated: 300 bytes total. read with: traj show x1 --full]\\nAAAA\\n---\\nBBBB\\n[... truncated: 300 bytes total. read with: traj show x2 --full]\\nBBBB\\n---\\nCCCC\\n[... truncated: 300 bytes total. read with: traj show x3 --full]\\nCCCC"\n  }\n]',
    );
  });

  it("too-dense render hard-truncates to the byte budget and warns on stderr", () => {
    writeTraj("34343434", [
      T("34343434"),
      { type: "reasoning", step_id: "x1", thought: "A".repeat(300) },
      { type: "final", step_id: "x2", content: "B".repeat(300) },
    ]);
    const h = makeCtxIO(rootEnv("34343434"));
    const rc = runContext(
      ["--max-bytes", "30", "--prompt-limit", "500", "--assistant-types", "reasoning,final"],
      h.io,
    );
    expect(rc).toBe(0);
    expect(h.outBytes().length).toBe(30);
    expect(h.err()).toBe("[budget exceeded: trajectory too dense]");
  });
});

// Upstream sync 2e39a3f (815eab2). Oracle: upstream's own tests/test_context.sh
// reasoning cases and parity/context/run-parity.mjs's reasoning-* scenarios
// (byte-exact against the real bin/context).
describe("buildContext — a reasoning row renders from a fixed field list (815eab2)", () => {
  const render = (row: Row): string => {
    const msgs = buildContext([{ type: "reasoning", step_id: "r1", ...row }], opts({ assistantTypes: ["reasoning"] }));
    return msgs.map((m) => m.content).join("\n---\n");
  };

  it("thought then code block, nothing after the fence", () => {
    expect(render({ thought: "T", cmd: "ls", served_by: "DeepInfra", truncated: true, in_tok: 5, mystery: "zzz" })).toBe("T\n\n```bash\nls\n```");
  });
  it("content is the older name for the thought, rendered bare", () => {
    expect(render({ cmd: "ls", content: "C" })).toBe("C\n\n```bash\nls\n```");
  });
  it("a lone cmd is still fenced (the one-field bare shortcut never applies to reasoning)", () => {
    expect(render({ cmd: "ls" })).toBe("```bash\nls\n```");
  });
  it("a lone thought is bare text", () => {
    expect(render({ thought: "only" })).toBe("only");
  });
  it("served_by / truncated are bookkeeping on any row type", () => {
    const msgs = buildContext([{ type: "custom", step_id: "c1", alpha: "A", served_by: "X", truncated: true }], opts({ userTypes: ["custom"] }));
    expect(msgs[0]!.content).toBe("A");
  });
});
