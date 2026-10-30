// upstreamDiffK123.test.ts — differential tests for three port bugs found in the 2026-10-29 release-readiness review
// (K1-K3), written oracle-first: each runs upstream's real Bash tool and this port's tool against the same local endpoint
// and expects the port to do what upstream does. Skipped without PARITY_UPSTREAM_ROOT (a headlong checkout) and bash>=4+jq+curl.
//   K1  bin/llm:102,1424-1425: LLM_CONNECT_TIMEOUT bounds only the TCP connect (curl --connect-timeout); a server that
//       connects at once but is slow to send headers is NOT aborted by it (header stalls fall to --speed-limit/--speed-time).
//   K2  bin/shellm:47 SHELLM_TRAJ_DIR="${SHELLM_TRAJ_DIR:-${TRAJ_DIR:-…}}", :2609-2611 `traj new --slug … --field
//       parent_traj=… --field parent_step=…`: a nested run honours TRAJ_DIR and its trajectory is nested under the parent's
//       directory with parent_traj_ref.
//   K3  bin/shellm:2366-2440 generate_run_summary, started at :2830-2840 for every run on a NEW trajectory: one
//       `run-summary` step {tldr, full_summary, run_id, model} in the run's own trajectory.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordedModel, recordedText, RECORD_MODEL, type RecordedModel, type RecordedModelOptions } from "./support/recordedModel.ts";
import { parseSummary } from "../src/runSummary.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_BIN = path.resolve(HERE, "../bin");
const UP = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
const bashOk = spawnSync("bash", ["-c", "[[ ${BASH_VERSINFO[0]} -ge 4 ]] && command -v jq curl >/dev/null"]).status === 0;

type Side = { name: "upstream" | "port"; bin: string; path: string };
const sides = (): Side[] => [
  { name: "upstream", bin: path.join(UP, "bin"), path: `${UP}/bin:${UP}/tools:${process.env["PATH"]}` },
  { name: "port", bin: PORT_BIN, path: `${PORT_BIN}:${process.env["PATH"]}` },
];

function run(cmd: string, args: string[], env: Record<string, string>, input = ""): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(input);
  });
}

// Replies: real DeepSeek replies recorded under test/fixtures/recordings/upstreamDiffK123/ (test/support/README.md),
// recorded from the UPSTREAM side's run; the port side replays the very same replies, so both tools see one model.
// Summary and turn calls race in shellm (the run summary starts beside turn 1), so replay routes by call kind.
const isSummary = (body: Record<string, unknown>) => JSON.stringify(body).includes("You produce concise summaries as JSON.");
const byKind = (body: Record<string, unknown>) => (isSummary(body) ? "summary" : "turn");
const models: RecordedModel[] = [];
async function sideModel(s: Side, scenario: string, o: RecordedModelOptions = {}): Promise<RecordedModel> {
  const saved = process.env["UC_RECORD"];
  if (s.name === "port") delete process.env["UC_RECORD"]; // record mode records upstream's run only; the port replays it
  try {
    const m = recordedModel("upstreamDiffK123", scenario, { route: byKind, ...o });
    models.push(m);
    await m.ready;
    return m;
  } finally {
    if (saved !== undefined) process.env["UC_RECORD"] = saved;
  }
}
const replayOnly = (s: Side): Side => ({ ...s, name: "port" }); // for the replay-only cases: never record either side
const TASK = 'Write the word hello to out.txt in the current directory, then finish with FINAL="nested answer: $(cat out.txt)".';

const roots: string[] = [];
afterEach(async () => {
  while (models.length) models.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "k123-"));
  roots.push(d);
  return d;
}

describe.skipIf(!UP || !bashOk)("K1: LLM_CONNECT_TIMEOUT bounds the connect only (bin/llm vs the port's llm)", () => {
  it("a server that answers its headers after 2.5 s is not cut off by LLM_CONNECT_TIMEOUT=1", async () => {
    // One recorded real reply (k1-late-reply), held 2.5 s before its headers on replay.
    const got: Record<string, unknown> = {};
    let text = "";
    for (const s of sides()) {
      const m = await sideModel(s, "k1-late-reply", { delayMs: 2500 });
      const home = tmp();
      const env = { PATH: s.path, HOME: home, LLM_PROVIDER: "openai-compatible", LLM_API_URL: m.url, LLM_API_KEY: "replay-not-a-key", LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "1" };
      const r = await run(path.join(s.bin, s.name === "upstream" ? "llm" : "llm.mjs"), ["-m", RECORD_MODEL, "Reply with one short sentence."], env);
      got[s.name] = { status: r.status, stdout: r.stdout, aborted: /timeout|timed out/i.test(r.stderr) };
      text = recordedText(m.recording.calls[0]!);
    }
    expect(text.length).toBeGreaterThan(0);
    expect(got["upstream"]).toEqual({ status: 0, stdout: text, aborted: false });
    expect(got["port"]).toEqual(got["upstream"]);
  }, 30_000);
});

describe.skipIf(!UP || !bashOk)("K2 + K3: a nested shellm run (bin/shellm vs the port's shellm)", () => {
  async function nestedRun(s: Side) {
    const srv = await sideModel(s, "k2k3-nested");
    const root = tmp();
    const trajDir = path.join(root, "trajectories");
    fs.mkdirSync(trajDir, { recursive: true });
    const env: Record<string, string> = {
      PATH: s.path, HOME: root, HEADLONG_HOME: path.join(root, "hh"), TRAJ_DIR: trajDir,
      LLM_PROVIDER: "openai-compatible", LLM_API_URL: srv.url, LLM_API_KEY: "replay-not-a-key", LLM_RETRIES: "0", SHELLM_MODEL: RECORD_MODEL, SHELLM_SANDBOX: "local",
      LC_ALL: "C.UTF-8",
    };
    const parent = await run(path.join(s.bin, s.name === "upstream" ? "traj" : "traj"), ["new", "--traj_dir", trajDir, "--slug", "parent run"], env);
    expect(parent.status, parent.stderr).toBe(0);
    const parentId = parent.stdout.split("\n")[0]!;
    const parentRel = parent.stdout.split("\n")[1]!;
    const r = await run(path.join(s.bin, "shellm"), ["--env", "local", TASK], { ...env, _SHELLM_PARENT_TRAJ_ID: parentId });
    if (process.env["K123_DEBUG"]) console.error(`[${s.name}] rc=${r.status}\nSTDOUT ${r.stdout}\nSTDERR ${r.stderr.slice(-3000)}\nFILES ${spawnSync("find", [root, "-name", "trajectory.jsonl"], { encoding: "utf8" }).stdout}`);
    return { s, r, srv, trajDir, parentId, parentRel };
  }

  function childOf(trajDir: string, parentRel: string): { dir: string; steps: Record<string, unknown>[] } {
    const parentDir = path.join(trajDir, parentRel);
    const kids = fs.readdirSync(parentDir).filter((d) => fs.existsSync(path.join(parentDir, d, "trajectory.jsonl")));
    expect(kids, `no child trajectory nested under ${parentRel}; top level: ${fs.readdirSync(trajDir).join(",")}`).toHaveLength(1);
    const file = path.join(parentDir, kids[0]!, "trajectory.jsonl");
    return { dir: kids[0]!, steps: fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  it("honours TRAJ_DIR, nests the child under the parent's directory with parent_traj/parent_step/parent_traj_ref, and writes one run-summary", async () => {
    const seen: Record<string, unknown> = {};
    for (const s of sides()) {
      const { r, srv, trajDir, parentId, parentRel } = await nestedRun(s);
      expect(r.status, `${s.name}: ${r.stderr.slice(-1500)}`).toBe(0);
      expect(r.stdout).toContain("nested answer: hello");
      const { dir, steps } = childOf(trajDir, parentRel);
      const first = steps[0]!;
      const header = steps.find((x) => x["type"] === "shellm-run")!;
      // The summary is written asynchronously; upstream waits up to 30 s for it before exiting (bin/shellm:2859-2870).
      const summaries = steps.filter((x) => x["type"] === "run-summary");
      seen[s.name] = {
        dirPattern: dir.replace(/^[0-9a-f]{8}-/, "<hex8>-"),
        firstKeys: Object.keys(first).sort(),
        parent_traj: first["parent_traj"] === parentId,
        parent_traj_ref: first["parent_traj_ref"],
        summaries: summaries.map((x) => ({ tldr: x["tldr"], full_summary: x["full_summary"], run_id_is_header: x["run_id"] === header["step_id"], model: x["model"] })),
        summaryCalls: srv.requests.filter(isSummary).length,
      };
    }
    expect(seen["port"]).toEqual(seen["upstream"]);
    expect(seen["upstream"]).toMatchObject({ parent_traj: true, summaryCalls: 1 });
    expect((seen["upstream"] as { summaries: { tldr: string }[] }).summaries[0]!.tldr).not.toBe("");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Independent review (2026-10-29): wider differential cases for K1-K3. Same oracle, same endpoint, more of the contract.

describe.skipIf(!UP || !bashOk)("K1 review: the header wait is still bounded by the stall guard (bin/llm --speed-time)", () => {
  it("headers after 6 s with LLM_SPEED_TIME=1: the port fails the way upstream does", async () => {
    const got: Record<string, unknown> = {};
    for (const s of sides()) {
      // The recorded k1-late-reply, replayed only (never recorded here), held 6 s before its headers.
      const srv = await sideModel(replayOnly(s), "k1-late-reply", { delayMs: 6000 });
      const env = {
        PATH: s.path, HOME: tmp(), LLM_PROVIDER: "openai-compatible", LLM_API_URL: srv.url, LLM_API_KEY: "replay-not-a-key", LLM_RETRIES: "0",
        LLM_SPEED_LIMIT: "100", LLM_SPEED_TIME: "1",
      };
      const r = await run(path.join(s.bin, s.name === "upstream" ? "llm" : "llm.mjs"), ["-m", RECORD_MODEL, "Reply with one short sentence."], env);
      got[s.name] = { failed: r.status !== 0, stdout: r.stdout, beforeHeaders: r.ms < 5000, requests: srv.requests.length };
    }
    expect(got["upstream"]).toMatchObject({ failed: true, stdout: "" });
    expect(got["port"]).toEqual(got["upstream"]);
  }, 30_000);
});

// The fenced-JSON summary reply is model wording no recording can be steered to, so its parsing is tested directly
// (pure parsing; the string below is labelled test data, not a model reply). bin/shellm:2447-2458 strips a fence on the
// first/last line and drops blank lines before jq; parseSummary is the port's copy of that.
describe("K3 review: a fenced summary reply is parsed like bin/shellm:2447-2458 (direct)", () => {
  it("strips the ```json fence and blank lines, keeps the embedded \\n\\n", () => {
    const testData = '```json\n{"tldr": "fenced tldr",\n\n "full_summary": "para one\\n\\npara two"}\n```';
    expect(parseSummary(testData)).toEqual({ tldr: "fenced tldr", full: "para one\n\npara two" });
    expect(parseSummary('{"tldr": "t", "full_summary": null}')).toEqual({ tldr: "t", full: "" });
  });
});

describe.skipIf(!UP || !bashOk)("K2 + K3 review: stdin, -f, summary JSON, parent merge, workdir, top-level TRAJ_DIR, --traj", () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "k123-shared-"));
  const ctxFile = path.join(shared, "notes.txt");
  fs.writeFileSync(ctxFile, "background line for the summary prompt\n".repeat(40) + "\n\n");

  async function go(s: Side, opts: { scenario: string; nested: boolean; args: string[]; stdin?: string; reuse?: { root: string; srv: RecordedModel } }) {
    const srv = opts.reuse?.srv ?? (await sideModel(s, opts.scenario));
    const root = opts.reuse?.root ?? tmp();
    const trajDir = path.join(root, "trajectories");
    fs.mkdirSync(trajDir, { recursive: true });
    const env: Record<string, string> = {
      PATH: s.path, HOME: root, HEADLONG_HOME: path.join(root, "hh"), TRAJ_DIR: trajDir,
      LLM_PROVIDER: "openai-compatible", LLM_API_URL: srv.url, LLM_API_KEY: "replay-not-a-key", LLM_RETRIES: "0", SHELLM_MODEL: RECORD_MODEL, SHELLM_SANDBOX: "local",
      LC_ALL: "C.UTF-8",
    };
    let parentId = "", parentRel = "";
    if (opts.nested) {
      const p = await run(path.join(s.bin, "traj"), ["new", "--traj_dir", trajDir, "--slug", "parent run"], env);
      expect(p.status, p.stderr).toBe(0);
      [parentId = "", parentRel = ""] = p.stdout.split("\n");
    }
    const r = await run(path.join(s.bin, "shellm"), opts.args, opts.nested ? { ...env, _SHELLM_PARENT_TRAJ_ID: parentId } : env, opts.stdin ?? "");
    expect(r.status, `${s.name}: ${r.stderr.slice(-1500)}`).toBe(0);
    return { r, srv, root, trajDir, parentId, parentRel, env };
  }
  const readSteps = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const trajFiles = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("trajectory.jsonl")).map((f) => f.replace(/[0-9a-f]{8}-/g, "<hex8>-")).sort()
      : [];

  it("nested run with stdin and -f: identical summary request, fenced JSON parsed, parent fork+merge, nested workdir", async () => {
    const seen: Record<string, unknown> = {};
    for (const s of sides()) {
      const { r, srv, root, trajDir, parentId, parentRel } = await go(s, { scenario: "k2k3-stdin-file", nested: true, args: ["--env", "local", "-f", ctxFile, TASK], stdin: "piped context line\n\n" });
      expect(r.stdout).toContain("nested answer: hello");
      const parentDir = path.join(trajDir, parentRel);
      const kid = fs.readdirSync(parentDir).find((d) => fs.existsSync(path.join(parentDir, d, "trajectory.jsonl")))!;
      const child = readSteps(path.join(parentDir, kid, "trajectory.jsonl"));
      const parent = readSteps(path.join(parentDir, "trajectory.jsonl"));
      const header = child.find((x) => x["type"] === "shellm-run")!;
      const sum = child.filter((x) => x["type"] === "run-summary");
      const merge = parent.find((x) => x["type"] === "merge") ?? {};
      const fork = parent.find((x) => x["type"] === "fork") ?? {};
      const sumReq = srv.requests.filter(isSummary);
      seen[s.name] = {
        files: trajFiles(trajDir),
        stray: trajFiles(path.join(root, "hh", "trajectories")),
        childTypes: [...new Set(child.map((x) => x["type"]))].sort(),
        parentTypes: parent.map((x) => x["type"]),
        fork: { keys: Object.keys(fork).sort(), child: fork["child"] === child[0]!["step_id"], step: fork["step_id"] === child[0]!["parent_step"] },
        merge: { keys: Object.keys(merge).sort(), content: merge["content"], from_traj: merge["from_traj"] === child[0]!["step_id"], from_traj_ref: merge["from_traj_ref"] === kid },
        summaries: sum.map((x) => ({ keys: Object.keys(x), tldr: x["tldr"], full_summary: x["full_summary"], run_id: x["run_id"] === header["step_id"], model: x["model"] })),
        summaryRequests: sumReq,
        workdir: fs.existsSync(path.join(root, "hh", "workdirs", parentRel, kid, "out.txt")),
        parentId: parent[0]!["step_id"] === parentId,
      };
    }
    expect(seen["port"]).toEqual(seen["upstream"]);
    // The one summary is the recorded real reply, parsed (bin/shellm:2447-2458) into tldr/full_summary.
    const up = seen["upstream"] as { workdir: boolean; summaries: { tldr: string; full_summary: string }[] };
    expect(up.workdir).toBe(true);
    expect(up.summaries).toHaveLength(1);
    expect(up.summaries[0]!.tldr).not.toBe("");
  }, 120_000);

  it("top-level run: TRAJ_DIR is honoured (nothing under HEADLONG_HOME), one summary; a --traj resume writes none", async () => {
    const seen: Record<string, unknown> = {};
    for (const s of sides()) {
      const first = await go(s, { scenario: "k2k3-toplevel", nested: false, args: ["--env", "local", TASK] });
      const top = fs.readdirSync(first.trajDir);
      const id = readSteps(path.join(first.trajDir, top[0]!, "trajectory.jsonl"))[0]!["step_id"] as string;
      const before = first.srv.requests.filter(isSummary).length;
      await go(s, { scenario: "k2k3-toplevel", nested: false, args: ["--env", "local", "--traj", id, 'Finish at once with FINAL="again".'], reuse: { root: first.root, srv: first.srv } });
      const steps = readSteps(path.join(first.trajDir, top[0]!, "trajectory.jsonl"));
      seen[s.name] = {
        files: trajFiles(first.trajDir),
        stray: trajFiles(path.join(first.root, "hh", "trajectories")),
        summariesAfterResume: steps.filter((x) => x["type"] === "run-summary").length,
        headers: steps.filter((x) => x["type"] === "shellm-run").length,
        summaryCalls: [before, first.srv.requests.filter(isSummary).length],
      };
    }
    expect(seen["port"]).toEqual(seen["upstream"]);
    expect(seen["upstream"]).toMatchObject({ stray: [], summariesAfterResume: 1, headers: 2, summaryCalls: [1, 1] });
  }, 120_000);
});

// A connect that never completes (an unroutable address; skipped when this network answers it at once). Upstream's curl
// gives up after LLM_CONNECT_TIMEOUT; the port must too, under node and under bun (bin/llm.mjs prefers bun when installed,
// and Bun's fetch has no connect timeout of its own — measured 2026-10-29: 60 s, ended only by the stall guard).
const BLACKHOLE = process.env["K1_BLACKHOLE_URL"] ?? "http://10.255.255.1:81/v1/chat/completions";
const runtimes = ["node", "bun"].filter((r) => spawnSync("sh", ["-c", `command -v ${r}`]).status === 0);
describe.skipIf(!UP || !bashOk)("K1 review: LLM_CONNECT_TIMEOUT=2 still bounds a connect that never completes", () => {
  it.each(runtimes)("port under %s gives up at ~2 s, like upstream", async (rt) => {
    const rtPath = spawnSync("sh", ["-c", `command -v ${rt}`], { encoding: "utf8" }).stdout.trim();
    const got: Record<string, { failed: boolean; stdout: string; boundedAt2s: boolean }> = {};
    for (const s of sides()) {
      const env: Record<string, string> = {
        PATH: s.path, HOME: tmp(), LLM_PROVIDER: "openai-compatible", LLM_API_URL: BLACKHOLE, LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "2",
        ...(s.name === "port" ? { HEADLONG_TS_RUNTIME: rtPath } : {}),
      };
      const r = await run(path.join(s.bin, s.name === "upstream" ? "llm" : "llm.mjs"), ["-m", "x", "hi"], env);
      got[s.name] = { failed: r.status !== 0, stdout: r.stdout, boundedAt2s: r.ms >= 1900 && r.ms < 4500 };
      if (s.name === "upstream" && !/Timeout was reached/.test(r.stderr)) {
        console.warn(`K1 blackhole inconclusive on this network: ${r.stderr.trim()}`);
        return;
      }
    }
    expect(got["upstream"]).toEqual({ failed: true, stdout: "", boundedAt2s: true });
    expect(got["port"]).toEqual(got["upstream"]);
  }, 90_000);
});
