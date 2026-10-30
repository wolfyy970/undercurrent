// tools/chat.mjs — fuzz adapter for `chat`. Grammar from `chat --help`:
// send/send-file/reply/history/person-key/thread-key (repl is interactive,
// out of scope for a non-PTY fuzzer). Trajectory layout + env vars mirror
// parity/chat/run-parity.mjs (TRAJ_DIR/TRAJ_ID, IDENTITY_NAME, MEM_DIR,
// CHATRC; real `traj` on PATH beside the bash oracle for the bash side).

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize as normGeneric } from "./common.mjs";
import { rmSandbox, makeFakebin, writeTimeoutShim, serializeTree } from "../lib/sandbox.mjs";
import { namedBytes, randomBytesFixture, randomSentence, randomWord, randomArgvBytesFixture } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "chat";
export const bashEnv = "PARITY_BASH_CHAT";
export const bashRel = "bin/chat";
export const tsRel = "chat.mjs";

const TID = "12345678-1111-2222-3333-444455556666";
const NAMES = ["alice", "bob", "slack-U123-C456-1700000000.000100", "pwa-carol", ""];

export function generate(rng) {
  const cmd = rng.pickWeighted([["send", 3], ["send-file", 2], ["reply", 3], ["history", 3], ["person-key", 1], ["thread-key", 1], ["global", 1]]);
  const nSteps = rng.int(0, 10);
  const identity = rng.bool(0.9) ? "alice" : rng.pick(["", "weird name", "bob"]);
  let argv = [];
  let stdinBuf;
  let files;

  if (cmd === "global") {
    argv = rng.pick([[], ["-h"], ["--help"], ["bogus"]]);
  } else if (cmd === "send") {
    argv = ["send"];
    if (rng.bool(0.5)) argv.push("--from", rng.pick(NAMES));
    if (rng.bool(0.5)) argv.push("--to", rng.pick(NAMES));
    argv.push(rng.bool(0.8) ? randomSentence(rng, 1, 10) : namedBytes(randomArgvBytesFixture(rng)).toString("utf8"));
  } else if (cmd === "send-file") {
    const fname = "payload.txt";
    files = [{ name: fname, content: namedBytes(randomBytesFixture(rng)) }];
    argv = ["send-file"];
    if (rng.bool(0.5)) argv.push("--to", rng.pick(NAMES));
    argv.push(fname);
  } else if (cmd === "reply") {
    argv = ["reply"];
    if (rng.bool(0.4)) argv.push("--reply-to", randomWord(rng));
    if (rng.bool(0.3)) argv.push("--follow-up");
    argv.push(rng.pick(NAMES.filter(Boolean)), rng.bool(0.8) ? randomSentence(rng, 1, 10) : "");
  } else if (cmd === "history") {
    argv = ["history"];
    const shape = rng.pickWeighted([["n", 3], ["with", 2], ["thread", 1]]);
    if (shape === "n") {
      if (rng.bool(0.6)) argv.push(String(rng.int(-2, 50)));
    } else if (shape === "with") {
      argv.push("--with", rng.pick(NAMES.filter(Boolean)));
      if (rng.bool(0.4)) argv.push("--since", rng.pick(["7d", "1d", "bogus"]));
      if (rng.bool(0.4)) argv.push("-n", String(rng.int(-1, 20)));
      if (rng.bool(0.3)) argv.push("--json");
    } else {
      argv.push("--thread", rng.pick(NAMES.filter(Boolean)));
      if (rng.bool(0.3)) argv.push("--json");
    }
  } else if (cmd === "person-key" || cmd === "thread-key") {
    argv = [cmd, rng.pick(NAMES)];
  }

  return {
    group: cmd,
    argv,
    nSteps,
    identity,
    stdin: stdinBuf,
    files,
    trajIdUnset: rng.bool(0.05),
    identityUnset: rng.bool(0.05),
    _seedSeed: rng.int(1, 2 ** 31 - 1),
  };
}

export function execute(scenario, ctx) {
  const fakebin = makeFakebin("chat");
  writeTimeoutShim(fakebin);
  const bashBinDir = path.dirname(ctx.bashPath);
  const seedLines = seedStepsStatic(scenario.nSteps, scenario._seedSeed);
  const sbBash = makeSandboxStatic(seedLines, scenario.files);
  const sbTs = makeSandboxStatic(seedLines, scenario.files);
  const runOne = (kind, sb) => {
    const env = { ...process.env };
    for (const k of ["TRAJ_DIR", "TRAJ_ID", "ROOT_TRAJ_ID", "IDENTITY_NAME", "CHATRC", "SHELLM_RUN_STEP_ID"]) delete env[k];
    env.LC_ALL = "C";
    env.PATH = `${fakebin}:${bashBinDir}:${env.PATH}`;
    env.TRAJ_DIR = path.join(sb.sb, "traj");
    env.TRAJ_ID = scenario.trajIdUnset ? "" : TID;
    env.IDENTITY_NAME = scenario.identityUnset ? "" : scenario.identity;
    const input = Buffer.alloc(0);
    return kind === "bash" ? runBash(ctx.bashPath, scenario.argv, { cwd: sb.sb, env, input }) : runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sb.sb, env, input });
  };
  const bash = runOne("bash", sbBash);
  const ts = runOne("ts", sbTs);
  const bState = fs.existsSync(sbBash.rootFile) ? fs.readFileSync(sbBash.rootFile, "utf8") : "<absent>";
  const tState = fs.existsSync(sbTs.rootFile) ? fs.readFileSync(sbTs.rootFile, "utf8") : "<absent>";
  rmSandbox({ root: sbBash.sb });
  rmSandbox({ root: sbTs.sb });
  try {
    fs.rmSync(fakebin, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { bash, ts, roots: { bash: [sbBash.sb], ts: [sbTs.sb] }, state: { bash: bState, ts: tState } };
}

// seedSteps needs an Rng but execute() only receives the plain scenario; the
// generator stashes a small integer seed so execute() can rebuild IDENTICAL
// lines deterministically without carrying a live Rng instance through
// JSON-serializable scenario objects (shrinking re-generates from the seed).
function seedStepsStatic(n, seed) {
  const lines = [];
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        step_id: `m${i}-0000-4000-8000-00000000000${i % 10}`,
        ts: `2026-01-01T00:0${i % 10}:00.000Z`,
        from: pick(NAMES.filter(Boolean)),
        to: pick(["alice", "bob"]),
        content: `seeded content ${i} ${pick(["foo", "bar", "baz"])}`,
      }),
    );
  }
  return lines;
}
function makeSandboxStatic(seedLines, files) {
  const sb = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "chat-fuzz-"));
  const rootFile = path.join(sb, "traj", `${TID.slice(0, 8)}-root`, "trajectory.jsonl");
  fs.mkdirSync(path.dirname(rootFile), { recursive: true });
  fs.writeFileSync(rootFile, seedLines.length ? seedLines.join("\n") + "\n" : "");
  for (const f of files || []) fs.writeFileSync(path.join(sb, f.name), f.content);
  return { sb, rootFile };
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
