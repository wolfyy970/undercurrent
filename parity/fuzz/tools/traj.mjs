// tools/traj.mjs — fuzz adapter for `traj`. Grammar from `traj --help`'s 14
// subcommands (new/append/fork/merge/show/tail/search/count/last/cat/exists/
// list/root/check). Fixture layout `<sb>/traj/<hex8>-root/trajectory.jsonl`
// mirrors parity/traj/run-parity.mjs's makeSandbox.

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize, normalizeGeneric } from "./common.mjs";
import { rmSandbox, serializeTree } from "../lib/sandbox.mjs";
import { namedBytes, randomBytesFixture, randomSentence } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "traj";
export const bashEnv = "PARITY_BASH_TRAJ";
export const bashRel = "bin/traj";
export const tsRel = "traj.mjs";

const STEP_TYPES = ["message", "action", "observation", "thought", "reasoning", "error"];
const ROOT_HEX = "12345678";
const CHILD_HEX = "87654321";

function randomStep(rng, i) {
  const type = rng.pick(STEP_TYPES);
  const step = { type, step_id: `${type[0]}${i}-0000-4000-8000-00000000000${i % 10}`, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` };
  step.content = rng.bool(0.85) ? randomSentence(rng, 1, 12) : namedBytes(randomBytesFixture(rng)).toString("utf8");
  return step;
}

export function generate(rng) {
  const cmd = rng.pickWeighted([
    ["new", 2], ["append", 3], ["fork", 1], ["merge", 1], ["show", 2], ["tail", 2],
    ["search", 2], ["count", 1], ["last", 2], ["cat", 2], ["exists", 1], ["list", 1], ["root", 1], ["check", 2],
  ]);
  const n = rng.int(0, 12);
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(randomStep(rng, i));
  const withFork = rng.bool(0.25);
  const malformed = rng.bool(0.15);

  let argv = [];
  const idArg = rng.bool(0.2) ? [] : [ROOT_HEX]; // sometimes omit ID, relying on env
  if (cmd === "new") {
    argv = ["new"];
    if (rng.bool(0.5)) argv.push("--slug", rng.bool(0.8) ? randomSentence(rng, 1, 3) : "");
    if (rng.bool(0.3)) argv.push("--field", `k=${randomSentence(rng, 1, 2)}`);
  } else if (cmd === "append") {
    argv = ["append", ...idArg];
    const useStdin = rng.bool(0.6);
    let stdinBody;
    if (useStdin) {
      stdinBody = rng.bool(0.7) ? JSON.stringify({ type: rng.pick(STEP_TYPES), content: randomSentence(rng, 1, 8) }) : rng.bool(0.5) ? "" : "{not json";
    } else {
      argv.push("--field", `type=${rng.pick(STEP_TYPES)}`, "--field", `content=${randomSentence(rng, 1, 6)}`);
    }
    return { group: cmd, steps, withFork, malformed, argv, stdin: stdinBody };
  } else if (cmd === "fork") {
    argv = ["fork", ...idArg];
    if (rng.bool(0.5)) argv.push("--slug", randomSentence(rng, 1, 2));
  } else if (cmd === "merge") {
    argv = ["merge", CHILD_HEX, ...idArg];
    if (rng.bool(0.4)) argv.push("--content", randomSentence(rng, 1, 6));
  } else if (cmd === "show") {
    argv = ["show", rng.bool(0.7) && steps.length ? steps[rng.int(0, steps.length - 1)].step_id : ROOT_HEX];
    if (rng.bool(0.4)) argv.push("--full");
    if (rng.bool(0.3)) argv.push("--field", rng.pick(["content", "type", "bogus_field"]));
  } else if (cmd === "tail") {
    argv = ["tail", ...idArg];
    if (rng.bool(0.5)) argv.push("-n", String(rng.int(-2, 20)));
    if (rng.bool(0.2)) argv.push("--raw");
    if (rng.bool(0.2)) argv.push("--filter", `type=${rng.pick(STEP_TYPES)}`);
  } else if (cmd === "search") {
    argv = ["search", rng.bool(0.8) ? randomSentence(rng, 1, 3) : "", ...idArg];
    if (rng.bool(0.3)) argv.push("-i");
    if (rng.bool(0.3)) argv.push("-C", String(rng.int(0, 3)));
    if (rng.bool(0.2)) argv.push("-E");
  } else if (cmd === "count") {
    argv = ["count", ...idArg];
  } else if (cmd === "last") {
    argv = ["last", ...idArg];
    if (rng.bool(0.4)) argv.push("--field", rng.pick(["content", "type", "step_id", "bogus"]));
  } else if (cmd === "cat") {
    argv = ["cat", ...idArg];
    if (rng.bool(0.3)) argv.push("--raw");
    if (rng.bool(0.3)) argv.push("--filter", `type=${rng.pick(STEP_TYPES)}`);
  } else if (cmd === "exists") {
    argv = ["exists", rng.bool(0.7) ? ROOT_HEX : "deadbeef"];
  } else if (cmd === "list") {
    argv = ["list", ...idArg];
    if (rng.bool(0.4)) argv.push("--children", rng.pick(["1", "all", "-1"]));
    if (rng.bool(0.3)) argv.push("--json");
  } else if (cmd === "root") {
    argv = ["root", ...idArg];
  } else if (cmd === "check") {
    argv = ["check", ...idArg];
    if (rng.bool(0.5)) argv.push("-r");
    if (rng.bool(0.3)) argv.push("--fix");
  }

  return { group: cmd, steps, withFork, malformed, argv };
}

function makeSandbox(scenario) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "traj-fuzz-"));
  const trajDir = path.join(sb, "traj");
  const rootDir = path.join(trajDir, `${ROOT_HEX}-root`);
  fs.mkdirSync(rootDir, { recursive: true });
  const lines = scenario.steps.map((s) => JSON.stringify(s));
  if (scenario.malformed) lines.push("not-json-at-all{{{");
  fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), lines.length ? lines.join("\n") + "\n" : "");
  if (scenario.withFork) {
    const childDir = path.join(rootDir, `${CHILD_HEX}-child`);
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, "trajectory.jsonl"), JSON.stringify({ type: "message", step_id: "child0", content: "child step" }) + "\n");
  }
  return { sb, trajDir };
}

export function execute(scenario, ctx) {
  const sbBash = makeSandbox(scenario);
  const sbTs = makeSandbox(scenario);
  const runOne = (kind, sb) => {
    const env = { ...process.env };
    for (const k of ["TRAJ_DIR", "TRAJ_ID", "SHELLM_RUN_STEP_ID", "CLICOLOR_FORCE"]) delete env[k];
    env.LC_ALL = "C";
    env.TRAJ_DIR = sb.trajDir;
    env.TRAJ_ID = `${ROOT_HEX}-1111-2222-3333-444444444444`;
    const input = Buffer.from(scenario.stdin ?? "", "utf8");
    return kind === "bash" ? runBash(ctx.bashPath, scenario.argv, { cwd: sb.sb, env, input }) : runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sb.sb, env, input });
  };
  const bash = runOne("bash", sbBash);
  const ts = runOne("ts", sbTs);
  const bState = serializeTree(sbBash.trajDir, { normalizeContent: normalizeGeneric });
  const tState = serializeTree(sbTs.trajDir, { normalizeContent: normalizeGeneric });
  rmSandbox({ root: sbBash.sb });
  rmSandbox({ root: sbTs.sb });
  return { bash, ts, roots: { bash: [sbBash.sb], ts: [sbTs.sb] }, state: { bash: bState, ts: tState } };
}

// step_id/ts are freshly random per process for mutating commands (new/append/
// fork/merge) — normalize UUID-shaped ids and ISO timestamps generically
// (tools/common.mjs's normalizeGeneric already does this) before compare.
export function compare(scenario, result) {
  const { bash, ts, roots, state } = result;
  const bOut = normalize(bash.stdout, roots.bash);
  const tOut = normalize(ts.stdout, roots.ts);
  const bErr = normalize(bash.stderr, roots.bash);
  const tErr = normalize(ts.stderr, roots.ts);
  const bState = normalize(state.bash, roots.bash);
  const tState = normalize(state.ts, roots.ts);
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
