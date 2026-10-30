// tools/retrieval.mjs — fuzz adapter for the retrieval thinker step
// (thinkers/retrieval/step vs bin/retrieval-step.mjs). Not a flag-driven CLI:
// a single JSON trigger step on stdin, identity env vars, RETRIEVAL_* knobs.
// Sandbox/env shape mirrors parity/retrieval/run-parity.mjs's makeIdentity/
// baseEnv (a `mem` stub for the semantic-suffix path + `timeout` no-op).

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize } from "./common.mjs";
import { makeIdentity, rmSandbox, makeFakebin, writeTimeoutShim, serializeTree } from "../lib/sandbox.mjs";
import { namedBytes, randomBytesFixture, randomSentence, randomWord } from "../lib/gen.mjs";
import { isRetrievalAwkVFamily, isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "retrieval";
export const bashEnv = "PARITY_BASH_RETRIEVAL";
export const bashRel = "thinkers/retrieval/step";
export const tsRel = "retrieval-step.mjs";

const TRAJ_ID = "cafe0000-0000-0000-0000-00000000beef";
const TRIGGER_TYPES = ["message", "manual", "action", "observation"];

function memFile(dir, i, summary, body, id) {
  fs.writeFileSync(path.join(dir, `mem${i}.md`), `---\nid: ${id}\nsummary: ${summary}\ntype: fact\n---\n${body}\n`);
}

export function generate(rng) {
  const nMem = rng.int(0, 6);
  const memories = [];
  for (let i = 0; i < nMem; i++) {
    const id = i.toString(16).padStart(8, "0");
    const useAwkV = rng.bool(0.15);
    const summary = useAwkV ? `line1\\nline2 with\\ttab` : randomSentence(rng, 2, 8);
    memories.push({ id, summary, body: rng.bool(0.85) ? randomSentence(rng, 3, 15) : namedBytes(randomBytesFixture(rng)).toString("utf8") });
  }

  const triggerType = rng.pick(TRIGGER_TYPES);
  const contentChoice = rng.pickWeighted([["sentence", 6], ["hostile", 2], ["number", 1], ["null", 1], ["object", 1]]);
  let content;
  if (contentChoice === "sentence") content = randomSentence(rng, 1, 12);
  else if (contentChoice === "hostile") content = namedBytes(randomBytesFixture(rng)).toString("utf8");
  else if (contentChoice === "number") content = rng.int(0, 9999);
  else if (contentChoice === "null") content = null;
  else content = { nested: randomWord(rng), n: rng.int(0, 9) };

  const trigger = { type: triggerType, step_id: rng.bool(0.9) ? "trig-1" : rng.int(1, 999), content };
  if (rng.bool(0.15)) trigger.trigger_step = "prior-step";

  const env = {};
  if (rng.bool(0.2)) env.RETRIEVAL_MIN_HITS = rng.pick(["0", "1", "2", "1.5", "abc"]);
  if (rng.bool(0.2)) env.RETRIEVAL_SEEN = rng.pick(["0", "1", "5", "-1"]);
  if (rng.bool(0.1)) env.SHELLM_RUN_STEP_ID = "run-" + randomWord(rng);

  return { group: "retrieval", trigger, memories, env };
}

export function execute(scenario, ctx) {
  const fakebin = makeFakebin("retrieval");
  writeTimeoutShim(fakebin);
  fs.writeFileSync(
    path.join(fakebin, "mem"),
    `#!/usr/bin/env bash\n[[ "\${1:-}" == "search" ]] || exit 1\nprintf 'MEM-STUB search: %s\\nsecond line\\nthird line\\nfourth line is never shown\\n' "$2"\n`,
  );
  fs.chmodSync(path.join(fakebin, "mem"), 0o755);

  const upstreamBin = path.join(path.resolve(path.dirname(ctx.bashPath), "../.."), "bin");
  const sbBash = makeIdentity(TRAJ_ID);
  const sbTs = makeIdentity(TRAJ_ID);
  for (const sb of [sbBash, sbTs]) {
    let i = 0;
    for (const m of scenario.memories) memFile(sb.memDir, i++, m.summary, m.body, m.id);
  }

  const runOne = (kind, sb) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("RETRIEVAL_") || k === "SHELLM_RUN_STEP_ID" || k === "IDENTITY_DIR" || k === "MEM_DIR" || k === "TRAJ_DIR" || k === "TRAJ_ID") delete env[k];
    }
    Object.assign(env, {
      LC_ALL: "C",
      PATH: `${fakebin}:${upstreamBin}:${env.PATH}`,
      HOME: sb.home,
      IDENTITY_DIR: sb.id,
      IDENTITY_NAME: "testid",
      MEM_DIR: sb.memDir,
      TRAJ_DIR: sb.trajDir,
      TRAJ_ID,
      SKILLS_DIR: sb.skillsDir,
      SKILLS_KERNEL_DIR: sb.kernelDir,
    });
    Object.assign(env, scenario.env);
    const input = Buffer.from(JSON.stringify(scenario.trigger), "utf8");
    return kind === "bash"
      ? runBash(ctx.bashPath, [], { cwd: sb.root, env, input })
      : runTs(ctx.REPO, tsRel, [], { cwd: sb.root, env, input });
  };
  const bash = runOne("bash", sbBash);
  const ts = runOne("ts", sbTs);
  const bState = { traj: readOr(sbBash.traj), index: readOr(path.join(sbBash.id, "retrieval", "index.tsv")), seen: readOr(path.join(sbBash.id, "retrieval", "seen")) };
  const tState = { traj: readOr(sbTs.traj), index: readOr(path.join(sbTs.id, "retrieval", "index.tsv")), seen: readOr(path.join(sbTs.id, "retrieval", "seen")) };
  rmSandbox({ root: sbBash.root });
  rmSandbox({ root: sbTs.root });
  try {
    fs.rmSync(fakebin, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { bash, ts, roots: { bash: sbBash.roots, ts: sbTs.roots }, state: { bash: bState, ts: tState } };
}

function readOr(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "<absent>";
  }
}

function stripVolatile(trajText) {
  return trajText
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      try {
        const o = JSON.parse(l);
        delete o.step_id;
        delete o.ts;
        return JSON.stringify(o);
      } catch {
        return l;
      }
    })
    .join("\n");
}

export function compare(scenario, result) {
  const { bash, ts, roots, state } = result;
  const bOut = normalize(bash.stdout, roots.bash);
  const tOut = normalize(ts.stdout, roots.ts);
  const bErr = normalize(bash.stderr, roots.bash);
  const tErr = normalize(ts.stderr, roots.ts);
  const bTraj = normalize(stripVolatile(state.bash.traj), roots.bash);
  const tTraj = normalize(stripVolatile(state.ts.traj), roots.ts);
  const bIndex = normalize(state.bash.index, roots.bash);
  const tIndex = normalize(state.ts.index, roots.ts);
  const bSeen = normalize(state.bash.seen, roots.bash);
  const tSeen = normalize(state.ts.seen, roots.ts);
  const exitMatch = bash.status === ts.status;
  const stdoutMatch = bOut === tOut;
  const trajMatch = bTraj === tTraj;
  const cmp = { stdout: stdoutMatch, stderr: bErr === tErr, status: exitMatch, traj: trajMatch, index: bIndex === tIndex, seen: bSeen === tSeen };
  const pass = cmp.stdout && cmp.stderr && cmp.status && cmp.traj && cmp.index && cmp.seen;
  let allowed = false;
  let allowReason = null;
  if (!pass) {
    // The awk-v family is PRECISELY a traj/index divergence (bash's awk -v
    // interprets \t/\n in the summary, splitting the index row / truncating
    // the retrieved text; the port keeps the bytes literal) — gating on
    // trajMatch would exclude the exact case this allowance exists for.
    if (scenario.memories.some((m) => isRetrievalAwkVFamily(m.summary)) && exitMatch && stdoutMatch) {
      allowed = true;
      allowReason = "documented deviation: retrieval awk -v backslash-escape family in a memory summary (parity/retrieval 'awk-v' sequence, PARITY.md retrieval row)";
    } else if (isBashLineWordingDeviation({ exitMatch, stdoutMatch, stateMatch: trajMatch, bashStderr: bErr, tsStderr: tErr })) {
      allowed = true;
      allowReason = "documented deviation: bash [[ arithmetic ]] line-wording vs port's silent exit-0 (parity/retrieval 'edges' sequence, PARITY.md retrieval row)";
    }
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: {
      bash: { stdout: bOut, stderr: bErr, status: bash.status, traj: bTraj, index: bIndex, seen: bSeen },
      ts: { stdout: tOut, stderr: tErr, status: ts.status, traj: tTraj, index: tIndex, seen: tSeen },
    },
  };
}
