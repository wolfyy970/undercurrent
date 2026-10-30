// tools/recap.mjs — fuzz adapter for `recap`. Grammar from `recap --help`:
// --traj_dir, --window, --gap-minutes, --context/--backfill/--budget/
// --raw-tail/--fanout, --cached/--rebuild, --json, --model family, -q.
// MODEL: each side runs its own real `llm` against ONE replay server (lib/replay.mjs, a child process) serving
// parity/recap/recordings/shared.json: lane A's recorded real DeepSeek replies, one per call kind (map, reduce,
// rollup), in cycle. The fuzz's failure modes are labelled HTTP TRANSPORT fixtures, never model text:
//   transportMode "http500"   — every call answers HTTP 500 (llm retries, then exits non-zero);
//   transportMode "malformed" — every call answers 200 with a body that is not JSON or SSE (a broken transport).
// (A real model reply that is not JSON is lane A's no-model parser layer, parity/recap/run-parser-parity.mjs.)

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize as normGeneric, normalizeGeneric } from "./common.mjs";
import { rmSandbox, serializeTree } from "../lib/sandbox.mjs";
import { replayServer, routeEnv, llmDir } from "../lib/replay.mjs";
import { fileURLToPath } from "node:url";

const HTTP_500 = { status: 500, content_type: "application/json", body: '{"error":{"message":"transport fixture: HTTP 500 (not model output)"}}' };
const MALFORMED = { status: 200, content_type: "application/json", body: "transport fixture: a body that is neither JSON nor SSE" };
const RECORDINGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../recap/recordings");
let n = 0;
import { randomSentence } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "recap";
export const bashEnv = "PARITY_BASH_RECAP";
export const bashRel = "bin/recap";
export const tsRel = "recap.mjs";

const TID = "aaaaaaaa-1111-2222-3333-444455556666";
const STEP_TYPES = ["message", "action", "observation", "thought"];

function seedLines(n, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        type: pick(STEP_TYPES),
        step_id: `[${i}]`.replace(/[[\]]/g, "") + `-0000-4000-8000-00000000000${i % 10}`,
        ts: `2026-01-01T${String(i % 24).padStart(2, "0")}:0${i % 6}:00.000Z`,
        content: `step ${i} content ${pick(["alpha", "beta", "gamma"])}`,
      }),
    );
  }
  return lines;
}

export function generate(rng) {
  const n = rng.int(0, 25);
  const argv = [];
  if (rng.bool(0.15)) argv.push(rng.pick(["-h", "--help"]));
  else {
    if (rng.bool(0.3)) argv.push("--window", String(rng.int(-1, 200)));
    if (rng.bool(0.3)) argv.push("--gap-minutes", String(rng.int(-1, 120)));
    if (rng.bool(0.25)) argv.push("--context");
    if (rng.bool(0.15)) argv.push("--budget", rng.pick(["auto", String(rng.int(0, 5000)), "bogus"]));
    if (rng.bool(0.15)) argv.push("--raw-tail", String(rng.int(-1, 40)));
    if (rng.bool(0.15)) argv.push("--fanout", String(rng.int(0, 20)));
    if (rng.bool(0.3)) argv.push(rng.pick(["--cached", "--rebuild"]));
    if (rng.bool(0.3)) argv.push("--json");
    if (rng.bool(0.2)) argv.push("-q");
    if (rng.bool(0.15)) argv.push("--model", randomSentence(rng, 1, 1));
  }
  return { group: "recap", argv, n, _seed: rng.int(1, 2 ** 31 - 1), transportMode: rng.pickWeighted([["recorded", 6], ["malformed", 1], ["http500", 1]]) };
}

function makeSandbox(scenario) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "recap-fuzz-"));
  const rootFile = path.join(sb, "traj", `${TID.slice(0, 8)}-root`, "trajectory.jsonl");
  fs.mkdirSync(path.dirname(rootFile), { recursive: true });
  const lines = seedLines(scenario.n, scenario._seed);
  fs.writeFileSync(rootFile, lines.length ? lines.join("\n") + "\n" : "");
  return sb;
}

export function execute(scenario, ctx) {
  const replay = replayServer("recap", {
    suite: "recap",
    dir: RECORDINGS,
    recording: "shared",
    channels: "recap",
    transportByPrefix: { "transport-http500-": { "*": HTTP_500 }, "transport-malformed-": { "*": MALFORMED } },
  });
  ctx.llmDirs ??= { bash: llmDir(path.join(path.dirname(ctx.bashPath), "llm")), ts: llmDir(path.join(ctx.REPO, "bin", "llm")) };
  const sc = scenario.transportMode === "recorded" ? `fuzz-${++n}` : `transport-${scenario.transportMode}-${++n}`;
  const sbBash = makeSandbox(scenario);
  const sbTs = makeSandbox(scenario);
  const runOne = (kind, sb) => {
    const env = routeEnv({ ...process.env, LC_ALL: "C" }, { llmDir: ctx.llmDirs[kind], url: replay.url(sc, kind) });
    env.TRAJ_DIR = path.join(sb, "traj");
    env.TRAJ_ID = TID;
    return kind === "bash" ? runBash(ctx.bashPath, scenario.argv, { cwd: sb, env }) : runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sb, env });
  };
  const bash = runOne("bash", sbBash);
  const ts = runOne("ts", sbTs);
  const bState = serializeTree(path.join(sbBash, "traj"), { normalizeContent: normalizeGeneric });
  const tState = serializeTree(path.join(sbTs, "traj"), { normalizeContent: normalizeGeneric });
  rmSandbox({ root: sbBash });
  rmSandbox({ root: sbTs });
  const misses = replay.takeMisses();
  if (misses.length) throw new Error(`replay miss (fails the scenario): ${misses.join(" | ")}`);
  return { bash, ts, roots: { bash: [sbBash], ts: [sbTs] }, state: { bash: bState, ts: tState } };
}

export function compare(scenario, result) {
  const { bash, ts, roots, state } = result;
  const bOut = normGeneric(bash.stdout, roots.bash);
  const tOut = normGeneric(ts.stdout, roots.ts);
  const bErr = normGeneric(bash.stderr, roots.bash);
  const tErr = normGeneric(ts.stderr, roots.ts);
  const bState = normGeneric(state.bash, roots.bash);
  const tState = normGeneric(state.ts, roots.ts);
  const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bash.status === ts.status, state: bState === tState };
  const pass = cmp.stdout && cmp.stderr && cmp.status && cmp.state;
  let allowed = false;
  let allowReason = null;
  if (!pass && isBashLineWordingDeviation({ exitMatch: cmp.status, stdoutMatch: cmp.stdout, stateMatch: cmp.state, bashStderr: bErr, tsStderr: tErr })) {
    allowed = true;
    allowReason = "documented deviation: bash internal ${var:?}/[[ ]] line-wording vs port\'s clean error text (shared cross-tool pattern, PARITY.md mem row M1 fix + retrieval row)";
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status, state: bState }, ts: { stdout: tOut, stderr: tErr, status: ts.status, state: tState } },
  };
}
