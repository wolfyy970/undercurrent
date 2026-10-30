// tools/skills.mjs — fuzz adapter for `skills`. Grammar from `skills --help`:
// list/search/show/check/init/list-json/kernel/prompt/remote (install/remove/
// remote add with a url|owner/repo can reach the network — excluded; this
// fuzzer only exercises the LOCAL --dir surface, network-free by construction).

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize } from "./common.mjs";
import { rmSandbox, serializeTree } from "../lib/sandbox.mjs";
import { randomWord, randomSentence, namedBytes, randomBytesFixture } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "skills";
export const bashEnv = "PARITY_BASH_SKILLS";
export const bashRel = "bin/skills";
export const tsRel = "skills.mjs";

function skillMd(rng, skillName) {
  const requiresEnv = rng.bool(0.2) ? `\n    env: ["SOME_FUZZ_VAR"]` : "";
  const requiresBins = rng.bool(0.2) ? `\n    bins: ["definitely-not-a-real-bin-xyz"]` : "";
  const hasReq = requiresEnv || requiresBins;
  const front = [
    "---",
    `name: ${skillName}`,
    `description: ${rng.bool(0.9) ? randomSentence(rng, 3, 10) : ""}`,
    hasReq ? "metadata:\n  shelllm:\n    requires:" + requiresEnv + requiresBins : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  const body = rng.bool(0.85) ? randomSentence(rng, 5, 30) : namedBytes(randomBytesFixture(rng)).toString("utf8");
  return `${front}\n\n# ${skillName}\n\n${body}\n`;
}

export function generate(rng) {
  const nSkills = rng.int(0, 4);
  const skillNames = [];
  for (let i = 0; i < nSkills; i++) skillNames.push(randomWord(rng) + "-skill-" + i);
  const cmd = rng.pickWeighted([
    ["list", 4], ["list-all", 2], ["list-prompt", 1], ["search", 2], ["show", 2],
    ["check", 2], ["init", 2], ["list-json", 1], ["kernel", 1], ["prompt", 1],
    ["remote", 1], ["global", 1],
  ]);
  let argv = [];
  if (cmd === "global") argv = rng.pick([[], ["-h"], ["--help"], ["--version"], ["bogus"]]);
  else if (cmd === "list") argv = ["list"];
  else if (cmd === "list-all") argv = ["list", "--all"];
  else if (cmd === "list-prompt") argv = ["list", "--format=prompt"];
  else if (cmd === "search") argv = ["search", rng.bool(0.7) && skillNames.length ? skillNames[0].split("-")[0] : randomWord(rng)];
  else if (cmd === "show") {
    argv = ["show", skillNames.length ? rng.pick(skillNames) : randomWord(rng)];
    if (rng.bool(0.4)) argv.push("--requires");
  } else if (cmd === "check") argv = ["check", skillNames.length ? rng.pick(skillNames) : randomWord(rng)];
  else if (cmd === "init") {
    argv = ["init"];
    if (rng.bool(0.6)) argv.push(rng.bool(0.85) ? randomWord(rng) + "-new" : "");
    if (rng.bool(0.3)) argv.push("--name", randomWord(rng));
    if (rng.bool(0.3)) argv.push("--description", randomSentence(rng, 1, 6));
  } else if (cmd === "list-json") argv = ["list-json"];
  else if (cmd === "kernel") argv = ["kernel"];
  else if (cmd === "prompt") argv = ["prompt"];
  else if (cmd === "remote") argv = rng.bool(0.6) ? ["remote"] : ["remote", "remove", "nonexistent-remote"];

  return { group: cmd, argv, skillNames, seed: rng.int(1, 2 ** 31 - 1) };
}

function makeSandbox(scenario, rng) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "skills-fuzz-"));
  const dir = path.join(sb, "work", ".skills");
  fs.mkdirSync(dir, { recursive: true });
  for (const nm of scenario.skillNames) {
    const skDir = path.join(dir, nm);
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, "SKILL.md"), skillMd(rng, nm));
  }
  return { sb, work: path.join(sb, "work"), dir };
}

// Deterministic mini-Rng mirror (same trick as chat/recap: reconstruct
// identical fixture content on both sides from a stashed integer seed).
function detRng(seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
  return {
    bool: (p = 0.5) => rnd() < p,
    pick: (arr) => arr[Math.floor(rnd() * arr.length)],
    int: (a, b) => a + Math.floor(rnd() * (b - a + 1)),
  };
}

export function execute(scenario, ctx) {
  const rngBash = detRng(scenario.seed);
  const rngTs = detRng(scenario.seed);
  const sbBash = makeSandbox(scenario, rngBash);
  const sbTs = makeSandbox(scenario, rngTs);
  const runOne = (kind, sb) => {
    const env = { ...process.env, LC_ALL: "C" };
    delete env.SKILLS_DIR;
    const argv = [...scenario.argv, "--dir", sb.dir];
    return kind === "bash" ? runBash(ctx.bashPath, argv, { cwd: sb.work, env }) : runTs(ctx.REPO, tsRel, argv, { cwd: sb.work, env });
  };
  const bash = runOne("bash", sbBash);
  const ts = runOne("ts", sbTs);
  const bState = serializeTree(sbBash.dir);
  const tState = serializeTree(sbTs.dir);
  rmSandbox({ root: sbBash.sb });
  rmSandbox({ root: sbTs.sb });
  return { bash, ts, roots: { bash: [sbBash.sb], ts: [sbTs.sb] }, state: { bash: bState, ts: tState } };
}

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
