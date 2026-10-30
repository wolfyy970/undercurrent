// tools/mem.mjs — fuzz adapter for `mem`. Grammar from `mem --help`: add/
// search/list/types/show/forget/edit, --dir/--type/--before/--after/-s/-v.
// `mem search` shells to `llm`: each side runs its own real `llm` against ONE replay server (lib/replay.mjs, a child
// process) serving parity/mem/recordings/search-reply.json (a recorded real DeepSeek reply) in cycle, like
// parity/mem/run-parity.mjs. Every other command is a no-model layer. Fixed-id fixtures (byte-stable across both
// sides) let show/forget/edit target real records.

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize, normalizeGeneric } from "./common.mjs";
import { serializeTree, rmSandbox } from "../lib/sandbox.mjs";
import { replayServer, routeEnv, llmDir } from "../lib/replay.mjs";
import { fileURLToPath } from "node:url";

const RECORDINGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mem/recordings");
let n = 0;
import { namedBytes, randomBytesFixture, randomSentence, randomWord, randomArgvBytesFixture } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "mem";
export const bashEnv = "PARITY_BASH_MEM";
export const bashRel = "bin/mem";
export const tsRel = "mem.mjs";

const TYPES = ["todo", "objective", "value", "belief", "fact", "preference", "note", "memory"];
const FIX = {
  first: { name: "2026-01-01-01-00-00_aaaaaaaa_first.md", content: "---\nid: aaaaaaaa\nsummary: first sum\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nfirst body\n" },
  second: { name: "2026-02-02-02-00-00_bbbbbbbb_second.md", content: "---\nid: bbbbbbbb\nsummary: second sum\ntype: note\ncreated: 2026-02-02 02:00:00\n---\n\nsecond body\n" },
  third: { name: "2026-03-03-03-00-00_cccccccc_third.md", content: "---\nid: cccccccc\nsummary: third sum\ntype: goal\ncreated: 2026-03-03 03:00:00\n---\n\nthird body\n" },
  legacy: { name: "2026-04-04-04-00-00_legacy-note.md", content: "---\ntype: fact\ncreated: 2026-04-04 04:00:00\n---\n\nlegacy body\n" },
};

export function generate(rng) {
  const cmd = rng.pickWeighted([
    ["add", 4], ["search", 2], ["list", 3], ["types", 1], ["show", 2], ["forget", 2], ["edit", 2], ["global", 2],
  ]);
  const seedFiles = rng.subset(Object.keys(FIX), 3);
  const env = {};
  if (rng.bool(0.15)) env.MEM_DIR = "./envmem";
  let argv = [];
  let stdin;

  if (cmd === "global") {
    argv = rng.pick([["--version"], ["-h"], ["--help"], [], ["bogus"], ["--dir"], ["--dir", "", "list"]]);
  } else if (cmd === "add") {
    const useStdin = rng.bool(0.3);
    argv = ["add"];
    if (rng.bool(0.5)) argv.push("--type", rng.bool(0.85) ? rng.pick(TYPES) : "");
    if (!useStdin) {
      argv.push(rng.bool(0.7) ? randomSentence(rng, 1, 10) : namedBytes(randomArgvBytesFixture(rng)).toString("latin1"));
    } else {
      stdin = rng.bool(0.8) ? randomSentence(rng, 1, 12) + "\n" : namedBytes(randomBytesFixture(rng)).toString("latin1");
    }
  } else if (cmd === "search") {
    argv = ["search", rng.bool(0.8) ? randomSentence(rng, 1, 6) : namedBytes(randomArgvBytesFixture(rng)).toString("latin1")];
  } else if (cmd === "list") {
    argv = ["list"];
    if (rng.bool(0.5)) argv.push("-s");
    if (rng.bool(0.3)) argv.push("--type", rng.bool(0.8) ? rng.pick(TYPES) : "");
    if (rng.bool(0.25)) argv.push("--before", rng.bool(0.7) ? "2026-02-15" : "");
    if (rng.bool(0.25)) argv.push("--after", rng.bool(0.7) ? "2026-01-15" : "not-a-date");
    if (rng.bool(0.2)) argv.push(String(rng.int(-2, 10)));
  } else if (cmd === "types") {
    argv = ["types"];
  } else if (cmd === "show") {
    argv = ["show", rng.bool(0.7) ? rng.pick(["aaaaaaaa", "bbbbbbbb", "cccccccc"]) : randomWord(rng)];
  } else if (cmd === "forget") {
    argv = ["forget", rng.bool(0.7) ? rng.pick(["aaaaaaaa", "bbbbbbbb", "cccccccc"]) : randomWord(rng)];
  } else if (cmd === "edit") {
    argv = ["edit", rng.bool(0.7) ? rng.pick(["aaaaaaaa", "bbbbbbbb", "cccccccc"]) : randomWord(rng)];
    if (rng.bool(0.4)) argv.push("--slug", rng.bool(0.85) ? randomWord(rng) : "");
    argv.push(rng.bool(0.8) ? randomSentence(rng, 1, 8) : namedBytes(randomArgvBytesFixture(rng)).toString("latin1"));
  }

  return { group: cmd, argv, env, stdin, seedFiles };
}

function makeSandbox(scenario) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "mem-fuzz-"));
  const memdir = path.join(sb, ".memories");
  for (const key of scenario.seedFiles) {
    const abs = path.join(memdir, FIX[key].name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, FIX[key].content);
  }
  return { sb, memdir };
}

export function execute(scenario, ctx) {
  const replay = replayServer("mem", { suite: "mem", dir: RECORDINGS, recording: "search-reply", channels: "main" });
  ctx.llmDirs ??= { bash: llmDir(path.join(path.dirname(ctx.bashPath), "llm")), ts: llmDir(path.join(ctx.REPO, "bin", "llm")) };
  const sc = `fuzz-${++n}`;
  const { sb: sbBash, memdir: memdirBash } = makeSandbox(scenario);
  const { sb: sbTs, memdir: memdirTs } = makeSandbox(scenario);
  const baseEnv = (kind, extra) => {
    const env = routeEnv({ ...process.env }, { llmDir: ctx.llmDirs[kind], url: replay.url(sc, kind) });
    delete env.MEM_DIR;
    delete env.MEM_TYPE;
    delete env.SHELLM_FAST_MODEL;
    env.LC_ALL = "C";
    Object.assign(env, scenario.env || {}, extra);
    return env;
  };
  const input = scenario.stdin ?? "";
  const bash = runBash(ctx.bashPath, scenario.argv, { cwd: sbBash, env: baseEnv("bash", {}), input: Buffer.from(input, "latin1") });
  const ts = runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sbTs, env: baseEnv("ts", {}), input: Buffer.from(input, "latin1") });
  const bState = serializeTree(memdirBash, { normalizeContent: normalizeGeneric });
  const tState = serializeTree(memdirTs, { normalizeContent: normalizeGeneric });
  rmSandbox({ root: sbBash });
  rmSandbox({ root: sbTs });
  if (scenario.group === "search") {
    const misses = replay.takeMisses();
    if (misses.length) throw new Error(`replay miss (fails the scenario): ${misses.join(" | ")}`);
  }
  return { bash, ts, roots: { bash: [sbBash], ts: [sbTs] }, state: { bash: bState, ts: tState } };
}

export function compare(scenario, result) {
  const { bash, ts, roots, state } = result;
  const bOut = normalize(bash.stdout, roots.bash);
  const tOut = normalize(ts.stdout, roots.ts);
  const bErr = normalize(bash.stderr, roots.bash);
  const tErr = normalize(ts.stderr, roots.ts);
  const bState = normalize(state.bash, roots.bash);
  const tState = normalize(state.ts, roots.ts);
  const exitMatch = bash.status === ts.status;
  const stdoutMatch = bOut === tOut;
  const stateMatch = bState === tState;
  const cmp = { stdout: stdoutMatch, stderr: bErr === tErr, status: exitMatch, state: stateMatch };
  const pass = cmp.stdout && cmp.stderr && cmp.status && cmp.state;
  let allowed = false;
  let allowReason = null;
  if (!pass) {
    if (isBashLineWordingDeviation({ exitMatch, stdoutMatch, stateMatch, bashStderr: bErr, tsStderr: tErr })) {
      allowed = true;
      allowReason = "documented deviation: bash ${var:?msg} line-wording vs port's clean error text (PARITY.md mem row, M1 fix note)";
    }
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status, state: bState }, ts: { stdout: tOut, stderr: tErr, status: ts.status, state: tState } },
  };
}
