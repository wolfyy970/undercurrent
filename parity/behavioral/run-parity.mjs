#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the assembled monolith MODEL REQUEST (behavioral parity round).
//
// (Also drives upstream's REAL thinkers/responder/step over the same stub, see the "responder" section below.)
// Runs upstream's REAL thinkers/monolith/step (Bash, unmodified, with the real bin/shellm and bin/llm) and the port's
// bin/thinker-step.mjs monolith over the SAME identity layout, the SAME seed trajectory and the SAME env, pointed by
// LLM_API_URL at ONE replay server (parity/support/replayModel.mjs) that RECORDS every chat-completions request and
// answers both sides with the same recorded real DeepSeek replies (parity/behavioral/recordings/, labelled). Three
// wakes run on each side; the seed carries an operator message asking for the env probe command, so wake 1 runs it
// (checked: "wake shell env probe ran on both sides"). Call counts per wake are whatever the real replies lead to, and
// must be the same on both sides. Then compares, per call: the system prompt text, the message count/roles, the request flags (stream, max_tokens,
// reasoning, stream_options, model), and the structure (anchor lines) of the wake's task message; plus the shellm-run
// header fields. Only genuinely variable fields are normalized (run dir path, timestamps, ids, hostnames-as-env).
//
// Repeatable: PARITY_UPSTREAM_ROOT=/abs/path/to/headlong node parity/behavioral/run-parity.mjs
// Re-record: UC_RECORD=1 [UC_RECORD_ONLY='behavioral/<scenario>'] DEEPSEEK_API_KEY=… (same command).
// Writes results.json + report.md beside this file. Exit 0 iff every check is PARITY or a classified deviation.

import { maskIds } from "./normId.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { holdFixedRoot } from "../../test/support/fixedRoot.ts";
import { startReplay, REPLAY_MODEL } from "../support/replayModel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_ROOT = path.resolve(HERE, "../..");
const UPSTREAM = process.env.PARITY_UPSTREAM_ROOT || "";
const STEP = path.join(UPSTREAM, "thinkers/monolith/step");
if (!UPSTREAM || !fs.existsSync(STEP)) {
  console.error(`PARITY_UPSTREAM_ROOT does not contain thinkers/monolith/step: ${UPSTREAM || "(unset)"}`);
  process.exit(2);
}

// The wake shell's environment, as the model's own bash tool sees it (behavioral parity, IDENTITY_DIR). The probe runs inside
// wake 1's command; its stdout is recorded in the trajectory's shell-output step and compared between the two engines.
const PROBE_VARS = ["IDENTITY_DIR", "IDENTITY_NAME", "MEM_DIR", "SKILLS_DIR", "SKILLS_KERNEL_DIR", "TRAJ_DIR", "TRAJ_ID", "THINKERS_DIR", "SHELLM_HOME", "CHATRC", "THINK_MODEL", "THINK_CONTEXT_TAIL"];
const PROBE = `for v in ${PROBE_VARS.join(" ")}; do printf 'ENV %s=%s\\n' "$v" "\${!v-<unset>}"; done\n`;

// ---------------------------------------------------------------------------------------------- replay endpoint
// One server for both sides. Channels: "shellm" (the loop's calls) and "other" (anything else, e.g. a run summary).
// `scenario` names a recording; each side gets its own URL, so call N of a channel is the same reply on both.
const replay = await startReplay({
  suite: "behavioral",
  dir: path.join(HERE, "recordings"),
  forwardModel: REPLAY_MODEL,
  // Record guard for this harness: the monolith recording is 3 wakes of real work, 15 calls, about $0.025 (the
  // replayModel default is 8 calls / $0.008 per recording file).
  maxRecordCalls: 16,
  maxRecordUsd: 0.03,
  channelOf: (b) => (b?.messages?.[0]?.role === "system" && String(b.messages[0].content).startsWith("You are running in shellm") ? "shellm" : "other"),
});
const stub = {
  scenario: "monolith",
  side: "",
  get url() {
    return replay.url(this.scenario, this.side);
  },
  /** Every request seen so far for this scenario+side, in order: { isShellm, json }. */
  calls() {
    return replay.requests(this.scenario, this.side).map((r) => ({ side: this.side, isShellm: r.channel === "shellm", json: r.body }));
  },
};

// ---------------------------------------------------------------------------------------------- one side's world
const TRAJ_ID = "cafe0000-0000-0000-0000-0000000000be";
function seedWorld(root) {
  const id = path.join(root, "ident");
  fs.mkdirSync(path.join(id, "memories"), { recursive: true });
  fs.mkdirSync(path.join(id, "trajectories", `${TRAJ_ID.slice(0, 8)}-root`), { recursive: true });
  fs.mkdirSync(path.join(id, "run"), { recursive: true });
  fs.mkdirSync(path.join(id, "workdir"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(id, "info.txt"), `name=testid\ncreated=test\nroot_trajectory=${TRAJ_ID}\n`);
  fs.writeFileSync(path.join(id, "run", "dispatcher.token"), "test-token\n");
  // Seeded goals (stage 3b #3): a goal, an intention and an expiring todo, so the "active goals" section, its ages and the
  // goal-review hint are compared exactly between the two engines. Frontmatter as `mem add` writes it (bin/mem).
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace("T", " ").slice(0, 19);
  const until = new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10);
  const mem = (name, type, hrs, body, extra = "") => fs.writeFileSync(path.join(id, "memories", name), `---\ntype: ${type}\ncreated: ${ago(hrs)}\nid: ${name.slice(0, 8)}\n${extra}---\n\n${body}\n`);
  mem("aaaa1111-goal.md", "goal", 26, "Write a field guide to this machine's command line tools, one note per tool family.");
  mem("bbbb2222-intention.md", "intention", 5, "Check the notes for stale commands.");
  mem("cccc3333-todo.md", "todo", 80, "Re-read the changelog before the weekend.", `until: ${until}\n`);
  const traj = path.join(id, "trajectories", `${TRAJ_ID.slice(0, 8)}-root`, "trajectory.jsonl"); // SPEC §2.1 layout
  const lines = [];
  for (let i = 0; i < 6; i++)
    lines.push(JSON.stringify({ step_id: `seed${String(i).padStart(3, "0")}-0000-0000-0000-000000000000`, type: "thought", content: `seed thought ${i}`, source: "seed", ts: `2026-10-27T00:00:0${i}Z` }));
  // The operator's request that makes wake 1 run the env probe (the model's real reply is what both sides execute).
  lines.push(JSON.stringify({ step_id: "seedop00-0000-0000-0000-000000000000", type: "message", from: "operator", to: "testid", source: "chat", ts: "2026-10-27T00:00:09Z",
    content: "Please run exactly this bash block, unchanged, in your next code block, then set FINAL=\"idle\":\n```bash\necho hello-from-wake-1\n" + PROBE + "```" }));
  fs.writeFileSync(traj, lines.join("\n") + "\n");
  return { id, traj };
}

function runStep(side, w, stub, trigger, thinker = "monolith", extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    IDENTITY_DIR: w.id, IDENTITY_NAME: "testid", MEM_DIR: path.join(w.id, "memories"),
    TRAJ_DIR: path.join(w.id, "trajectories"), TRAJ_ID, HOME: path.join(w.id, "..", "home"),
    SHELLM_MODEL: "vendor/model", OPENROUTER_API_KEY: "parity-dummy-key", LLM_API_URL: stub.url,
    LLM_RETRIES: "0", THINK_CONTEXT_TAIL: "30", MONOLITH_TIERED_MEMORY: "0", SHELLM_SANDBOX: "local",
    SHELLM_NO_BANNER: "1", LC_ALL: "en_US.UTF-8",
    MONOLITH_BACKOFF_BASE: "5", MONOLITH_SHARE_HINT_EVERY: "0",
    THINK_MODEL: "vendor/model", RESPONDER_PERSON_NOTES: "0",
    // what the dispatcher exports to every step (bin/thinkers:387-389, derived from IDENTITY_DIR by bin/thinkers:214-220)
    SKILLS_DIR: path.join(w.id, "skills"), SKILLS_KERNEL_DIR: path.join(w.id, "kernel"), THINKERS_DIR: path.join(w.id, "thinkers"), SHELLM_HOME: path.join(w.id, ".shellm"),
    ...extraEnv,
  };
  let cmd, args;
  if (side === "upstream") {
    env.PATH = `${UPSTREAM}/bin:${UPSTREAM}/tools:${process.env.PATH}`;
    env.SHELLM_TRAJ_DIR = env.TRAJ_DIR;
    env.SHELLM_LAUNCHED_BY = "monolith"; // what the dispatcher exports for a step (bin/thinkers:746); the port sets it itself
    cmd = thinker === "monolith" ? STEP : path.join(UPSTREAM, `thinkers/${thinker}/step`); args = [];
  } else {
    cmd = process.execPath; args = [path.join(PORT_ROOT, "bin/thinker-step.mjs"), thinker];
  }
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, cwd: w.id, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.stdout.on("data", () => {});
    p.stdin.end(JSON.stringify(trigger));
    p.on("close", (code) => resolve({ code, err: err.slice(-1500) }));
  });
}

// ---------------------------------------------------------------------------------------------- normalization
function normSystem(s) {
  return s
    .replace(/(- Transient run directory: )\S+/, "$1<RUNDIR>")
    .replace(/(- Date: )\S+/, "$1<DATE>")
    .replace(/(- Shell: ).*/, "$1<BASH>")
    .replace(/(- Package managers: ).*/, "$1<PKGMGRS>");
}
const ANCHOR = /^(<context>|<\/context>|You are an unconscious thought process|About testid:|Recent stream \(last \d+ durable steps|Routing signals:|Related memories|Choose ONE function|- The last few steps are all thoughts|- The most recent step is an ACTION|- \(no special signals|## |Sent in the last)/;
function anchors(userMsg) {
  return userMsg.split("\n").filter((l) => ANCHOR.test(l)).map((l) => l.replace(/\d{4}-\d\d-\d\dT[\d:]+Z/g, "<TS>"));
}
// Exact comparison of the wake's task message. Masked, and why (each is NOT a request-shape difference):
//  - timestamps / step_id / run_id values: generated per run;
//  - the "- Now:" clock line (the two sides run one after the other);
//  - the "Runtime:" line: names each side's own checkout commit;
//  - the "Workspace:" line: D2, a documented path-layout deviation (PARITY.md, workdir under .shellm/workdirs);
// NOT masked: the default identity text. Upstream's tools/identity:1510 still says "think, chat, focus, mem, ..." although
// bin/focus was deleted in 12ca841; the port drops `focus` (PARITY.md "Retired-tool references"). That ONE token is the
// only tolerated difference and is reported as DEVIATION (see FOCUS_TOKEN below), never masked into a PARITY.
//  - U+FFFD runs: upstream's wake 2 byte-mangles one em dash in the menu text (an oracle encoding artifact, not copied).
function normUser(m) {
  return maskIds(m)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?/g, "<TS>")
    .replace(/^- Now: .*$/m, "- Now: <NOW>")
    .replace(/^Runtime: .*$/m, "Runtime: <RT>")
    .replace(/^Workspace: \S+/m, "Workspace: <WS>")
    .replace(/\uFFFD+/g, "\u2014");
}
const FOCUS_TOKEN = "(think, chat, focus, mem,";
const dropFocus = (m) => m.replace(FOCUS_TOKEN, "(think, chat, mem,");
const exactStatus = (u, p) => (u === p ? "PARITY" : dropFocus(u) === p ? "DEVIATION" : "DIVERGE");
function firstDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n"), d = [];
  for (let k = 0; k < Math.max(x.length, y.length) && d.length < 6; k++) if (x[k] !== y[k]) d.push(`line ${k + 1}: upstream=${JSON.stringify(x[k])?.slice(0, 600)} port=${JSON.stringify(y[k])?.slice(0, 600)}`);
  return `lengths ${a.length} vs ${b.length}; ${d.join("; ")}`;
}
function shape(req) {
  const b = req.json;
  const { messages, ...rest } = b;
  return { flags: rest, roles: messages.map((m) => m.role), counts: messages.length };
}

// ---------------------------------------------------------------------------------------------- main
// A FIXED root, and ONE world path for both sides, run one after the other on a fresh seed: the recorded replies are
// real model commands that name absolute paths (`cd <root>/upstream/ident/workdir`), so both engines must execute them
// in the same place with the same starting state. The name is the root the recording was made under.
const root = path.join(os.tmpdir(), "behav-parity-A7vGkc");
// Machine-wide lock on that fixed root (test/support/fixedRoot.ts, the same lock every fixed test root uses): two runs
// at once would delete each other's world. Held for the whole process, released on exit.
await holdFixedRoot(root);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const out = {};
for (const side of ["upstream", "port"]) {
  const w = seedWorld(path.join(root, "upstream")); // same path on both sides (see root above)
  if (side === "port") {
    // D2 (documented layout deviation): the port runs each step in `<identity>/.shellm/workdirs/<hex8>-root`, upstream in
    // `<identity>/workdir`. The recorded replies were written against upstream's layout (some `cd <identity>/workdir`,
    // some use the default cwd), so on the port side `<identity>/workdir` is a symlink to the port's own workdir: both
    // spellings reach ONE directory, as they do upstream. Without this the port edits files in two places and the replay
    // stops matching the recording (a harness artifact, not a parser or engine difference).
    const portWd = path.join(w.id, ".shellm", "workdirs", `${TRAJ_ID.slice(0, 8)}-root`);
    fs.mkdirSync(portWd, { recursive: true });
    fs.rmSync(path.join(w.id, "workdir"), { recursive: true, force: true });
    fs.symlinkSync(portWd, path.join(w.id, "workdir"));
  }
  stub.scenario = "monolith";
  stub.side = side;
  const wakeStarts = [];
  const rc = [], err = [];
  for (let k = 0; k < 3; k++) {
    wakeStarts.push(stub.calls().filter((r) => r.isShellm).length);
    const r = await runStep(side, w, stub, { type: "monolith-wake", content: "wake", source: "monolith-timer" });
    rc.push(r.code);
    err.push(r.err);
  }
  const mine = stub.calls().filter((r) => r.isShellm);
  const perWake = wakeStarts.map((st, k) => (k + 1 < wakeStarts.length ? wakeStarts[k + 1] : mine.length) - st);
  const steps = fs.readFileSync(w.traj, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const headers = steps.filter((s) => s.type === "shellm-run");
  if (process.env.PARITY_DUMP) mine.forEach((r, i) => fs.writeFileSync(`${process.env.PARITY_DUMP}/${side}-call${i + 1}.json`, JSON.stringify(r.json, null, 1)));
  out[side] = { idRoot: w.id, rc, err, perWake, wakeStarts, calls: mine, headers, steps, stepTypes: steps.map((s) => s.type) };
  fs.renameSync(path.join(root, "upstream"), path.join(root, `done-${side}`)); // the next side starts from a fresh seed
  fs.rmSync(path.join(root, "home"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------- responder (item 6)
// A chat message "from andy" triggers upstream's REAL thinkers/responder/step (real bin/llm, bin/chat, bin/traj) and the
// port's bin/thinker-step.mjs responder over the same seed; the stub records the HTTP request bin/llm / the port's llm
// path sends. Two scenarios: a structured call (response_format json_schema, the default for the deepseek tier,
// forced here with RESPONDER_STRUCTURED=1) and a plain-text call (RESPONDER_STRUCTURED=0).
const RESP = {};
const respScenarios = [
  { name: "structured", env: { RESPONDER_STRUCTURED: "1" } },
  { name: "text", env: { RESPONDER_STRUCTURED: "0" } },
];
for (const sc of respScenarios) {
  RESP[sc.name] = {};
  for (const side of ["upstream", "port"]) {
    const w = seedWorld(path.join(root, `resp-${sc.name}-${side}`));
    const lines = fs.readFileSync(w.traj, "utf8").trimEnd().split("\n");
    const trig = { step_id: "trig00001-0000-0000-0000-000000000000", type: "message", from: "andy", to: "testid", content: "can you confirm Saturday at 6?", source: "chat", ts: new Date(Date.now() - 2000).toISOString() };
    fs.writeFileSync(w.traj, [...lines, JSON.stringify(trig)].join("\n") + "\n");
    stub.scenario = `responder-${sc.name}`;
    stub.side = side;
    const r = await runStep(side, w, stub, trig, "responder", sc.env);
    const calls = stub.calls();
    const steps = fs.readFileSync(w.traj, "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(lines.length + 1);
    RESP[sc.name][side] = { rc: r.code, err: r.err, calls, steps };
  }
}
await replay.close();

// --- checks
const checks = [];
function check(name, ok, detail, classification = "PARITY") {
  checks.push({ name, status: ok ? classification : "DIVERGE", detail: ok ? "" : detail });
}
const U = out.upstream, P = out.port;
check("both sides ran both wakes (exit 0)", U.rc.every((c) => c === 0) && P.rc.every((c) => c === 0), JSON.stringify({ up: U.rc, port: P.rc, upErr: U.err, portErr: P.err }));
check("model calls per wake identical on both sides (same recorded replies)", JSON.stringify(U.perWake) === JSON.stringify(P.perWake) && U.perWake.every((c) => c >= 1), `upstream ${JSON.stringify(U.perWake)}, port ${JSON.stringify(P.perWake)}`);
check("replay: every request had a recording (no misses)", replay.misses.length === 0, replay.misses.join("\n"));
const n = Math.min(U.calls.length, P.calls.length);
const wakeOf = (i) => U.wakeStarts.filter((st) => st <= i).length;
const labels = Array.from({ length: n }, (_, i) => `wake ${wakeOf(i)}, call ${i - U.wakeStarts[wakeOf(i) - 1] + 1}${U.wakeStarts.includes(i) ? " (fresh wake)" : ""}`);
for (let i = 0; i < n; i++) {
  const u = U.calls[i].json, p = P.calls[i].json;
  const su = shape(U.calls[i]), sp = shape(P.calls[i]);
  check(`${labels[i]}: system prompt text identical (normalized)`, normSystem(String(u.messages[0].content)) === normSystem(String(p.messages[0].content)),
    (() => {
      const a = normSystem(String(u.messages[0].content)).split("\n"), b = normSystem(String(p.messages[0].content)).split("\n");
      const d = [];
      for (let k = 0; k < Math.max(a.length, b.length) && d.length < 6; k++) if (a[k] !== b[k]) d.push(`line ${k + 1}: upstream=${JSON.stringify(a[k])} port=${JSON.stringify(b[k])}`);
      return `lengths ${a.join("\n").length} vs ${b.join("\n").length}; ${d.join("; ")}`;
    })());
  check(`${labels[i]}: message roles/count identical`, JSON.stringify(su.roles) === JSON.stringify(sp.roles), `upstream ${JSON.stringify(su.roles)} port ${JSON.stringify(sp.roles)}`);
  check(`${labels[i]}: request flags identical (model, stream, stream_options, max_tokens, no reasoning)`, JSON.stringify(su.flags, Object.keys(su.flags).sort()) === JSON.stringify(sp.flags, Object.keys(sp.flags).sort()), `upstream ${JSON.stringify(su.flags)} port ${JSON.stringify(sp.flags)}`);
  if (U.wakeStarts.includes(i)) {
    const au = anchors(String(u.messages[1].content)), ap = anchors(String(p.messages[1].content));
    const nu = normUser(String(u.messages[1].content)), np = normUser(String(p.messages[1].content));
    check(`${labels[i]}: task message EXACT text identical (timestamps/ids/runtime+workspace lines masked; blank lines included; identity text unmasked)`, dropFocus(nu) === np, firstDiff(nu, np), exactStatus(nu, np));
    check(`${labels[i]}: task message structure (anchor lines) identical`, JSON.stringify(au) === JSON.stringify(ap), `upstream ${JSON.stringify(au)}\nport ${JSON.stringify(ap)}`);
  }
}
const w2 = U.wakeStarts[1];
check("second wake's first request is exactly [system, user] on both (B5)", n > w2 && U.calls[w2].json.messages.length === 2 && P.calls[w2].json.messages.length === 2, `upstream ${U.calls[w2]?.json.messages.length} port ${P.calls[w2]?.json.messages.length}`);
const hf = (h) => ({ model: h.model, effort: h.effort, wake: h.wake, launched_by: h.launched_by, resumed: h.resumed, max_tokens: h.max_tokens, cmd_scope: /--context-scope run/.test(String(h.command)) });
check("shellm-run headers: model/effort/wake/launched_by/resumed/max_tokens and `--context-scope run` match", JSON.stringify(U.headers.map(hf)) === JSON.stringify(P.headers.map(hf)), `upstream ${JSON.stringify(U.headers.map(hf))}\nport ${JSON.stringify(P.headers.map(hf))}`);
check("trajectory step type sequence identical (seed + both wakes)", JSON.stringify(U.stepTypes) === JSON.stringify(P.stepTypes), `upstream ${U.stepTypes.join(",")}\nport ${P.stepTypes.join(",")}`);

// --- responder checks
const normResp = (m) => normUser(m).replace(/The current time is \S+/g, "The current time is <NOW>").replace(/\d{4}-\d\d-\d\d[ T][\d:.]+Z?/g, "<TS>");
for (const sc of respScenarios) {
  const ru = RESP[sc.name].upstream, rp = RESP[sc.name].port;
  check(`responder/${sc.name}: both sides ran (exit 0) and made the same number of model calls`, ru.rc === 0 && rp.rc === 0 && ru.calls.length === rp.calls.length && ru.calls.length >= 1, `rc ${ru.rc}/${rp.rc}, calls ${ru.calls.length}/${rp.calls.length}\nupstream err ${ru.err}\nport err ${rp.err}`);
  for (let i = 0; i < Math.min(ru.calls.length, rp.calls.length); i++) {
    const bu = ru.calls[i].json, bp = rp.calls[i].json;
    const nb = (b) => JSON.parse(normResp(JSON.stringify(b)));
    const ju = JSON.stringify(nb(bu)), jp = JSON.stringify(nb(bp));
    check(`responder/${sc.name}: request body #${i + 1} EXACT (model, max_tokens, stream, response_format/schema, every message incl. identity text; time/ids masked)`, dropFocus(ju) === jp, firstDiff(JSON.stringify(nb(bu), null, 1), JSON.stringify(nb(bp), null, 1)), exactStatus(ju, jp));
  }
  const keyset = (r) => r.steps.map((x) => `${x.type}:${Object.keys(x).filter((k) => !["step_id", "ts"].includes(k)).sort().join(",")}`);
  check(`responder/${sc.name}: appended step types and FIELD SETS identical`, JSON.stringify(keyset(ru)) === JSON.stringify(keyset(rp)), `upstream ${JSON.stringify(keyset(ru))}\nport ${JSON.stringify(keyset(rp))}`);
}

// IDENTITY_DIR et al. in the wake shell (bin/thinkers:387 exports them into every step; local-mode `bash -e -c` inherits them,
// bin/shellm:1629). One check per probed variable so a divergence names the variable.
const envLines = (side) => {
  const so = side.steps.find((x) => x.type === "shell-output" && String(x.stdout ?? "").includes("ENV IDENTITY_DIR="));
  const m = new Map();
  for (const l of String(so?.stdout ?? "").split("\n")) {
    const mm = /^ENV ([A-Z_]+)=(.*)$/.exec(l);
    if (mm) m.set(mm[1], mm[2].split(side.idRoot).join("<IDENTITY_DIR>"));
  }
  return m;
};
const eu = envLines(U), ep = envLines(P);
check("wake shell env probe ran on both sides", eu.size === PROBE_VARS.length && ep.size === PROBE_VARS.length, `upstream saw ${eu.size} vars, port ${ep.size}`);
for (const v of PROBE_VARS) check(`wake shell env: ${v} (path relative to the identity dir) identical`, eu.get(v) === ep.get(v), `upstream ${JSON.stringify(eu.get(v))} port ${JSON.stringify(ep.get(v))}`);

// D5: the step field sets. bin/shellm:3332 `{type,thought,cmd,run_id,llm_s} + $usage` (the whole bin/llm usage record).
const usageSteps = (side) => side.steps.filter((x) => x.type === "reasoning" || (x.type === "final" && "llm_s" in x));
const fieldSets = (side) => usageSteps(side).map((x) => `${x.type}:${Object.keys(x).filter((k) => !["step_id", "ts"].includes(k)).sort().join(",")}`);
check("reasoning/final step FIELD SETS identical (incl. think_tok, cache_tok, served_by) for every model call", JSON.stringify(fieldSets(U)) === JSON.stringify(fieldSets(P)) && fieldSets(U).length === U.calls.length, `upstream ${JSON.stringify(fieldSets(U))}\nport ${JSON.stringify(fieldSets(P))}`);
const usageVals = (side) => usageSteps(side).map((x) => JSON.stringify([x.in_tok, x.out_tok, x.think_tok, x.cache_tok, x.served_by]));
check("reasoning/final usage VALUES identical (in_tok, out_tok, think_tok, cache_tok, served_by)", JSON.stringify(usageVals(U)) === JSON.stringify(usageVals(P)), `upstream ${JSON.stringify(usageVals(U))}\nport ${JSON.stringify(usageVals(P))}`);

// The values parsed out of each recorded reply: `thought` is `reasoning=$(extract_reasoning "$response")`
// (bin/shellm:3027, every trailing newline dropped) and `cmd` the extracted block, per model call.
const parsedVals = (side) => usageSteps(side).map((x) => JSON.stringify([x.type, x.thought ?? null, x.cmd ?? null]));
{
  const u = parsedVals(U), p = parsedVals(P);
  const i = u.findIndex((v, k) => v !== p[k]);
  check("reasoning/final thought and cmd VALUES identical for every model call", u.length === p.length && i === -1, i === -1 ? `lengths ${u.length} vs ${p.length}` : `first difference at call ${i + 1}\nupstream ${u[i]}\nport ${p[i]}`);
}

// The retired command itself: upstream deleted bin/focus (12ca841); neither side may offer it, so the identity text's
// mention of it is stale on upstream and omitted by the port.
check("`focus` command: absent in upstream bin/ and in the port (so the identity text must not advertise it)", !fs.existsSync(path.join(UPSTREAM, "bin/focus")) && !fs.existsSync(path.join(PORT_ROOT, "bin/focus.mjs")), "a focus command exists on one side; the deviation rationale no longer holds");

const diverge = checks.filter((c) => c.status === "DIVERGE");
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ upstreamPin: "2e39a3f", checks }, null, 2) + "\n");
const md = ["# Behavioral parity: assembled monolith request, real upstream Bash vs port", "",
  "Real `thinkers/monolith/step` + `bin/shellm` + `bin/llm` (upstream) vs `bin/thinker-step.mjs monolith` (port), same identity layout, seed trajectory and env, one replay server serving recorded real DeepSeek replies to both (`parity/behavioral/run-parity.mjs`, `recordings/`).", "",
  `Result: ${checks.filter((c) => c.status === "PARITY").length}/${checks.length} PARITY, ${checks.filter((c) => c.status === "DEVIATION").length} DEVIATION (documented), ${diverge.length} DIVERGE`, "",
  "| check | status |", "|---|---|", ...checks.map((c) => `| ${c.name} | ${c.status} |`), "",
  ...diverge.flatMap((c) => [`### DIVERGE: ${c.name}`, "```", c.detail, "```", ""])].join("\n");
fs.writeFileSync(path.join(HERE, "report.md"), md + "\n");
console.log(md);
if (!process.env.BEHAV_KEEP) fs.rmSync(root, { recursive: true, force: true });
process.exit(diverge.length === 0 ? 0 : 1);
