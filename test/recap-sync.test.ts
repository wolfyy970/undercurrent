// recap-sync.test.ts — the 2e39a3f sync of `recap --context` (lane i):
// refusal placeholder, ROLLUP_MAX_SEALS, early stop, the 4096-token rollup cap
// and the bounded citation ("namer") lookup. Seals run the port's real `llm` against a recorded real DeepSeek window
// summary (test/fixtures/recordings/recap-sync/, served from a child process by test/support/recordedServerProcess.ts
// because recap calls `llm` with spawnSync); refusals and failures are labelled HTTP fixtures. The byte-level proof
// against the real Bash tool is parity/recap (adversarial groups: refusal, seal-cap, namers).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordedServerProcess, type RecordedServerProcess } from "./support/recordedServerProcess.ts";
import { recordedText, RECORDINGS_DIR, type Recording } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRecap, namerKeyOf, namerLines, type RecapIO, type LlmResult } from "../src/recap.js";
import { ROLLUP_PROMPT_VERSION, ROLLUP_SYSTEM } from "../src/rollups.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "recap-sync-"));
});
const servers: RecordedServerProcess[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function traj(n: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "thought",
    step_id: `s${String(i + offset).padStart(7, "0")}`,
    ts: `2026-01-01T00:${String((i + offset) % 60).padStart(2, "0")}:00Z`,
    content: `step ${i + offset}`,
  }));
}
function writeTraj(runDir: string, steps: Record<string, unknown>[]): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}
function appendTraj(runDir: string, steps: Record<string, unknown>[]): void {
  fs.appendFileSync(path.join(runDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

interface Call {
  args: string[];
  stdin: string;
}
type Fixture = { status: number; content_type: string; body: string };
/** recap with its llm boundary on the real `llm`, pointed at a recording (call i of the build is request i). */
async function harness(env: Record<string, string>, scenario: string, opts: { cycle?: boolean; httpFixtures?: Record<number, Fixture> } = {}) {
  const srv = await recordedServerProcess("recap-sync", scenario, opts);
  servers.push(srv);
  let out = "";
  let err = "";
  const calls: Call[] = [];
  const io: RecapIO = {
    cwd: TMP,
    env: { TRAJ_DIR: TMP, ...env },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    now: () => new Date("2026-01-02T03:04:05"),
    runLlm: (args, stdin) => {
      calls.push({ args, stdin });
      return srv.runLlm(args, stdin);
    },
  };
  return { io, calls, out: () => out, err: () => err };
}
/** One recorded real seal of a 3-step window, replayed for every seal call: these builds count seals, not content. */
const SEALS = { cycle: true } as const;
const sealReply = (): { summary: string; step_ids: string[] } => {
  const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "recap-sync", "seal-window.json"), "utf8")) as Recording;
  return JSON.parse(recordedText(rec.calls[0]!)) as { summary: string; step_ids: string[] };
};
// HTTP fixtures, not model output: a provider stream that ends on finish_reason content_filter with no content
// (llm reports `refused:`), and a provider outage.
const REFUSAL_STREAM: Fixture = {
  status: 200,
  content_type: "text/event-stream",
  body: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n',
};
function droppedStream(): Fixture {
  const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "recap-sync", "seal-window.json"), "utf8")) as Recording;
  const text = recordedText(rec.calls[0]!);
  const half = JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(0, Math.floor(text.length / 2)) } }] });
  return { status: 200, content_type: "text/event-stream", body: `data: ${half}\n\n` };
}
const OUTAGE: Fixture = { status: 500, content_type: "application/json", body: '{"error":{"message":"provider outage"}}' };

const RUN = "abc123";
const runDir = () => path.join(TMP, RUN);
const block = (tier: number, s: number, e: number) =>
  path.join(runDir(), "rollups", `t${tier}`, `${String(s).padStart(12, "0")}-${String(e).padStart(12, "0")}.json`);
const BACKFILL = [RUN, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"];

describe("rollup prompt (2e39a3f)", () => {
  it("sends -t 4096 and the v5 system prompt; blocks record prompt_version 5", async () => {
    writeTraj(runDir(), traj(3));
    const h = await harness({}, "seal-window");
    expect(runRecap(BACKFILL, h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
    const a = h.calls[0]!.args;
    expect(a[a.indexOf("-t") + 1]).toBe("4096");
    expect(a[a.indexOf("-s") + 1]).toBe(ROLLUP_SYSTEM);
    expect(JSON.parse(fs.readFileSync(block(1, 0, 3), "utf8")).prompt_version).toBe(ROLLUP_PROMPT_VERSION);
    expect(ROLLUP_PROMPT_VERSION).toBe(5);
    // The sealed block carries the real reply's summary and its [first,last] step ids.
    const b = JSON.parse(fs.readFileSync(block(1, 0, 3), "utf8"));
    expect(b.summary).toBe(sealReply().summary);
    expect(b.step_ids).toEqual(sealReply().step_ids);
  });
});

describe("refusal placeholder (c32d5b0)", () => {
  it("seals a placeholder on a `refused:` line, once, with the refused flag and stderr passthrough", async () => {
    writeTraj(runDir(), traj(3));
    const h = await harness({}, "transport-refusal", { httpFixtures: { 0: REFUSAL_STREAM } });
    expect(runRecap(BACKFILL, h.io)).toBe(0);
    expect(h.calls).toHaveLength(1); // no retry: the content decides, not luck
    const b = JSON.parse(fs.readFileSync(block(1, 0, 3), "utf8"));
    expect(b.refused).toBe(true);
    expect(b.summary).toBe("(Not summarized: the summary model refused this window.)");
    expect(b.themes).toEqual([]);
    expect(b.step_ids).toEqual(["s0000000", "s0000002"]); // the [first,last] fallback
    expect(h.err()).toContain("refused: the provider content filter blocked this request");
    expect(h.err()).toContain("rollup t1 [0,3): the model refused this window, sealing a placeholder");
    expect(h.out()).toContain("(Not summarized: the summary model refused this window.)");
  });

  it("a refusal whose llm exited 0 is still a refusal; a stderr-less result never is", async () => {
    writeTraj(runDir(), traj(3));
    const h = await harness({}, "seal-window");
    // The real llm never pairs exit 0 with `refused:`, so this boundary result is built in-process: the recorded
    // real reply on stdout plus a refused line on stderr. recap must trust the stderr line over the exit status.
    h.io.runLlm = () => ({ status: 0, stdout: JSON.stringify(sealReply()) + "\n", stderr: "llm: refused: x\n" });
    runRecap(BACKFILL, h.io);
    expect(JSON.parse(fs.readFileSync(block(1, 0, 3), "utf8")).refused).toBe(true);
    fs.rmSync(path.join(runDir(), "rollups"), { recursive: true });
    const h2 = await harness({}, "transport-outage", { httpFixtures: { 0: OUTAGE, 1: OUTAGE } });
    expect(runRecap(BACKFILL, h2.io)).toBe(0);
    expect(fs.existsSync(block(1, 0, 3))).toBe(false); // plain failure: nothing sealed
  });

  it("the build moves past a refused block and a placeholder carries no refused key on healthy blocks", async () => {
    writeTraj(runDir(), traj(9));
    const h = await harness({}, "seal-window", { ...SEALS, httpFixtures: { 1: REFUSAL_STREAM } });
    runRecap(BACKFILL, h.io);
    expect(JSON.parse(fs.readFileSync(block(1, 3, 6), "utf8")).refused).toBe(true);
    expect("refused" in JSON.parse(fs.readFileSync(block(1, 0, 3), "utf8"))).toBe(false);
    expect(fs.existsSync(block(2, 0, 9))).toBe(true);
  });

  it("a non-refusal failure stops the build, still prints the blocks that exist, and a rerun resumes", async () => {
    writeTraj(runDir(), traj(9));
    // Transport fixture: the recorded real reply's stream dropped halfway (no finish_reason, no [DONE]), on both
    // attempts at the second window. llm exits 0 with the half it got, which is not valid JSON.
    const h = await harness({}, "seal-window", { ...SEALS, httpFixtures: { 1: droppedStream(), 2: droppedStream() } });
    expect(runRecap(BACKFILL, h.io)).toBe(0);
    expect(fs.existsSync(block(1, 0, 3))).toBe(true);
    expect(fs.existsSync(block(1, 3, 6))).toBe(false);
    expect(h.err()).toContain("rollup t1 [3,6): no valid JSON, stopping the build here");
    expect(h.err()).toContain("rollup build stopped early; printing the blocks that exist");
    const h2 = await harness({}, "seal-window", SEALS);
    runRecap(BACKFILL, h2.io);
    expect(h2.calls.length).toBeGreaterThan(0);
    expect(fs.existsSync(block(1, 6, 9))).toBe(true);
    expect(fs.existsSync(block(2, 0, 9))).toBe(true);
  });
});

describe("ROLLUP_MAX_SEALS (c32d5b0)", () => {
  async function primed(env: Record<string, string>, extra: number) {
    writeTraj(runDir(), traj(3));
    runRecap([RUN, "--context", "--fanout", "3", "--raw-tail", "0"], (await harness({}, "seal-window", SEALS)).io); // records start_index = 3
    appendTraj(runDir(), traj(extra, 3));
    const h = await harness(env, "seal-window", SEALS);
    expect(runRecap([RUN, "--context", "--fanout", "3", "--raw-tail", "0"], h.io)).toBe(0);
    return h;
  }
  it("stops after N seals and says the rest waits; the next call continues", async () => {
    const h = await primed({ ROLLUP_MAX_SEALS: "2" }, 18);
    expect(h.calls).toHaveLength(2);
    expect(h.err()).toContain("sealed 2 blocks, the cap for one call; the rest waits");
    const h2 = await harness({ ROLLUP_MAX_SEALS: "2" }, "seal-window", SEALS);
    runRecap([RUN, "--context", "--fanout", "3", "--raw-tail", "0"], h2.io);
    expect(h2.calls).toHaveLength(2);
  });
  it("0 means no cap, the default is 20, and --backfill is never capped", async () => {
    expect((await primed({ ROLLUP_MAX_SEALS: "0" }, 24)).calls.length).toBeGreaterThan(8);
  });
  it("default cap is 20", async () => {
    expect((await primed({}, 60)).calls).toHaveLength(20);
  });
  it("backfill ignores the cap", async () => {
    writeTraj(runDir(), traj(12));
    const h = await harness({ ROLLUP_MAX_SEALS: "1" }, "seal-window", SEALS);
    runRecap(BACKFILL, h.io);
    expect(h.calls.length).toBeGreaterThan(1);
  });
  it.each(["lots", "-1", "1.5"])("rejects %s", async (v) => {
    writeTraj(runDir(), traj(3));
    const h = await harness({ ROLLUP_MAX_SEALS: v }, "seal-window", SEALS);
    expect(runRecap([RUN, "--context", "--fanout", "3"], h.io)).toBe(1);
    expect(h.err()).toContain("ROLLUP_MAX_SEALS must be a number (0 = no cap)");
  });
  it("empty falls back to 20", async () => {
    writeTraj(runDir(), traj(3));
    expect(runRecap([RUN, "--context", "--fanout", "3"], (await harness({ ROLLUP_MAX_SEALS: "" }, "seal-window", SEALS)).io)).toBe(0);
  });
});

describe("citation lookup (bounded namers)", () => {
  // Parser and lookup, no model: namerKeyOf (a block's citable [id,...] prefix) and namerLines (which other
  // summaries quote it, within the byte allowance).
  it("namerKeyOf: the [id,...] prefix of a block with string step_ids, else none", () => {
    expect(namerKeyOf('{"step_ids":["s0000027","s0000029"]}')).toBe("[s0000027,s0000029]");
    expect(namerKeyOf('{"step_ids":[]}')).toBeUndefined();
    expect(namerKeyOf('{"step_ids":["a",1]}')).toBeUndefined();
    expect(namerKeyOf('{"summary":"no ids"}')).toBeUndefined();
    expect(namerKeyOf("[1]")).toBeUndefined();
    expect(namerKeyOf("{bad")).toBeUndefined();
  });
  it("namerLines: names the windows that cite the block, never the block itself, whole or not at all", () => {
    const nm = {
      files: ["self.json", "a.json", "b.json", "c.json"],
      text: ["self [k1,k2]", "a corrects [k1,k2].", "b cites [k1] only", "c also [k1,k2]"],
      partial: false,
      left: 1000,
    };
    const out = namerLines(nm, "self.json", "[k1,k2]");
    expect(out).toBe("  [namer of the window above, cites it] a corrects [k1,k2].\n  [namer of the window above, cites it] c also [k1,k2]\n");
    expect(nm.partial).toBe(false);
    expect(nm.left).toBe(1000 - Buffer.byteLength(out));
    // A line that does not fit is dropped whole and marks the lookup partial; a later shorter one may still fit.
    const tight = { files: ["x", "long", "short"], text: ["", "L".repeat(80) + " [k]", "s [k]"], partial: false, left: 50 };
    expect(namerLines(tight, "x", "[k]")).toBe("  [namer of the window above, cites it] s [k]\n");
    expect(tight.partial).toBe(true);
  });

  // Whole call path with no model: `--cached` assembles from blocks seeded on disk. These summaries are TEST DATA
  // (a layout where t2[18,27) cites the displayed t1[27,30)), not model output; --cached never calls the llm.
  // 30 steps, fanout 3: the staircase shows t3[0,27) and t1[27,30).
  // (a layout where all three t2 windows cite the displayed t1[27,30))
  const CITER = (s: number) => `Test data: the t2 window at ${s} that corrects [s0000027,s0000029].`;
  function seed() {
    writeTraj(runDir(), traj(30));
    const put = (tier: number, s: number, e: number, summary: string, ids: string[]) => {
      fs.mkdirSync(path.dirname(block(tier, s, e)), { recursive: true });
      fs.writeFileSync(block(tier, s, e), JSON.stringify({ tier, start: s, end: e, n: e - s, summary, themes: [], step_ids: ids }) + "\n");
    };
    for (let s = 0; s < 30; s += 3) put(1, s, s + 3, `test data t1 ${s}`, [`s${String(s).padStart(7, "0")}`, `s${String(s + 2).padStart(7, "0")}`]);
    for (let s = 0; s < 27; s += 9) put(2, s, s + 9, CITER(s), [`s${String(s).padStart(7, "0")}`]);
    put(3, 0, 27, "test data t3", ["s0000000", "s0000026"]);
  }
  async function build(budget: string) {
    seed();
    const h = await harness({}, "seal-window");
    expect(runRecap([RUN, "--context", "--cached", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", budget], h.io)).toBe(0);
    expect(h.calls).toHaveLength(0);
    return h;
  }
  it("names the windows that cite a displayed block, never the block itself", async () => {
    const h = await build("5000");
    const lines = h.out().split("\n").filter((l) => l.includes("[namer of the window above, cites it]"));
    // newest first within a tier (ctxPrepareNamers probes from the end)
    expect(lines).toEqual([18, 9, 0].map((s) => `  [namer of the window above, cites it] ${CITER(s)}`));
    // It follows the cited block's line, not the citing one.
    const out = h.out();
    expect(out.indexOf(lines[0]!)).toBeGreaterThan(out.indexOf("test data t1 27"));
    expect(h.out()).not.toContain("Citation lookup limited");
  });
  it("a tight budget keeps the base, drops what does not fit and appends the hint", async () => {
    const full = (await build("5000")).out().split("\n").length;
    fs.rmSync(path.join(runDir()), { recursive: true });
    const tight = await build("300");
    const lines = tight.out().split("\n");
    expect(lines.length).toBeLessThan(full);
    expect(lines.filter((l) => l.includes("[namer of the window above")).length).toBeGreaterThan(0);
    expect(tight.out()).toContain("  [Citation lookup limited; search rollups/t*/ for exact [id,...] prefix.]\n");
    expect(tight.out()).toContain("=== YOUR LIFE SO FAR");
  });
  it("with no room at all the hint goes to stderr and stdout is the plain base", async () => {
    const h = await build("10");
    expect(h.out()).not.toContain("namer of the window above");
    expect(h.out()).not.toContain("Citation lookup limited");
    expect(h.err()).toContain("[Citation lookup limited; search rollups/t*/ for exact [id,...] prefix.]");
  });
});
