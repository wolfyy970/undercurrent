// tools/context.mjs — fuzz adapter for `context`. Grammar from `context --help`:
// --traj_dir/<ID>, --assistant-types/--user-types/--exclude-types, --head/--tail/
// --pin, --prompt-limit, --elision-style, --max-bytes. Fixture shape (a
// `<hex8>-root` trajectory dir) from parity/context/run-parity.mjs.

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize } from "./common.mjs";
import { rmSandbox } from "../lib/sandbox.mjs";
import { namedBytes, randomBytesFixture, randomSentence } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "context";
export const bashEnv = "PARITY_BASH_CONTEXT";
export const bashRel = "bin/context";
export const tsRel = "context.mjs";

const STEP_TYPES = ["message", "action", "observation", "thought", "reasoning", "prompt", "merge", "fork", "error"];

function randomStep(rng, i) {
  const type = rng.pick(STEP_TYPES);
  const step = { type, step_id: `s${i}` };
  const contentChoice = rng.pickWeighted([["sentence", 6], ["hostile", 2], ["empty", 1], ["number", 1]]);
  if (contentChoice === "sentence") step.content = randomSentence(rng, 1, 15);
  else if (contentChoice === "hostile") step.content = namedBytes(randomBytesFixture(rng)).toString("utf8");
  else if (contentChoice === "empty") step.content = "";
  else step.content = rng.int(0, 1000);
  if (rng.bool(0.2)) step.cmd = "echo " + randomSentence(rng, 1, 5);
  if (rng.bool(0.15)) step.source = rng.pick(["monolith", "responder", "retrieval"]);
  return step;
}

export function generate(rng) {
  const hex8 = "abcd" + String(rng.int(1000, 9999));
  const n = rng.int(0, 30);
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(randomStep(rng, i));
  const noFinalNL = rng.bool(0.1);
  const malformedLine = rng.bool(0.1) ? "not-json{{{" : null;

  const argv = [];
  if (rng.bool(0.3)) argv.push("--head", String(rng.int(-1, 5)));
  if (rng.bool(0.3)) argv.push("--tail", String(rng.int(-1, 60)));
  if (rng.bool(0.2)) argv.push("--pin", `s${rng.int(0, n)}`);
  if (rng.bool(0.2)) argv.push("--prompt-limit", String(rng.int(0, 4096)));
  if (rng.bool(0.15)) argv.push("--elision-style", rng.pick(["none", "count", "bogus"]));
  if (rng.bool(0.15)) argv.push("--max-bytes", String(rng.int(0, 8192)));
  if (rng.bool(0.15)) argv.push("--assistant-types", rng.pick(["message", "action,observation", ""]));
  if (rng.bool(0.15)) argv.push("--user-types", rng.pick(["message", "prompt", ""]));
  if (rng.bool(0.15)) argv.push("--exclude-types", rng.pick(["thought", "reasoning,error", ""]));
  if (rng.bool(0.1)) argv.push(rng.pick(["-h", "--help", "--bogus"]));

  return { group: "context", hex8, steps, noFinalNL, malformedLine, argv };
}

function makeSandbox(scenario) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "ctx-fuzz-"));
  const rootDir = path.join(sb, "trajdir", `${scenario.hex8}-root`);
  fs.mkdirSync(rootDir, { recursive: true });
  const lines = scenario.steps.map((s) => JSON.stringify(s));
  if (scenario.malformedLine) lines.push(scenario.malformedLine);
  fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), lines.join("\n") + (scenario.noFinalNL ? "" : "\n"));
  return sb;
}

export function execute(scenario, ctx) {
  const sbBash = makeSandbox(scenario);
  const sbTs = makeSandbox(scenario);
  const env = { ...process.env, LC_ALL: "C" };
  for (const k of ["CTX_HEAD", "CTX_TAIL", "SHELLM_STDOUT_PROMPT_LIMIT", "CTX_ELISION_STYLE", "TRAJ_DIR", "TRAJ_ID"]) delete env[k];
  const uuid = `${scenario.hex8}-1111-2222-3333-444444444444`;
  Object.assign(env, { TRAJ_DIR: "./trajdir", TRAJ_ID: uuid });
  const bash = runBash(ctx.bashPath, scenario.argv, { cwd: sbBash, env });
  const ts = runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sbTs, env });
  rmSandbox({ root: sbBash });
  rmSandbox({ root: sbTs });
  return { bash, ts, roots: { bash: [sbBash], ts: [sbTs] } };
}

export function compare(scenario, result) {
  const { bash, ts, roots } = result;
  const bOut = normalize(bash.stdout, roots.bash);
  const tOut = normalize(ts.stdout, roots.ts);
  const bErr = normalize(bash.stderr, roots.bash);
  const tErr = normalize(ts.stderr, roots.ts);
  const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bash.status === ts.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  let allowed = false;
  let allowReason = null;
  if (!pass && isBashLineWordingDeviation({ exitMatch: cmp.status, stdoutMatch: cmp.stdout, stateMatch: undefined, bashStderr: bErr, tsStderr: tErr })) {
    allowed = true;
    allowReason = "documented deviation: bash internal ${var:?}/[[ ]] line-wording vs port\'s clean error text (shared cross-tool pattern, PARITY.md mem row M1 fix + retrieval row)";
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status }, ts: { stdout: tOut, stderr: tErr, status: ts.status } },
  };
}
