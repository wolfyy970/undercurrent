#!/usr/bin/env node
// run-seal-trigger.mjs — DIFFERENTIAL check of WHEN a rollup is made (the trigger), not what it says.
//
// Question (gapcheck, box REPORT.md finding 4): the scripted 300 s wake showed the port making 4
// rollup LLM calls in 16 wakes and upstream 3 in 8 — is the trigger the same logic?
//
// Method: the monolith calls `recap <root> --context --budget … --raw-tail 0 -q` once per wake
// (thinkers/_lib/common.sh:643-651; src/monolith.ts lifeContextSection). A block is sealed only
// when F^k filtered steps complete a block at or after the enable marker, capped at
// ROLLUP_MAX_SEALS per call (bin/recap:660-690 `_ctx_build`; src/recap.ts ctxBuild). So the trigger
// depends on how many filtered steps exist at each wake, never on wake count or time. This harness
// grows ONE trajectory wake by wake (varied increments, tier boundaries, a backlog bigger than the cap,
// cap 0 and a tiny cap, other fanouts) and after each wake compares, between the REAL bin/recap and
// the port's bin/recap.mjs: the number of `llm` calls made, the exact list of block files that
// exist, and the printed staircase. Expectations come from running upstream, never from the port.
//
//   PARITY_BASH_RECAP=/path/to/headlong/bin/recap node parity/recap/run-seal-trigger.mjs
// Exit 0 iff every wake of every scenario is identical.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startReplay, REPLAY_MODEL } from "../support/replayModel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_RECAP =
  process.env.PARITY_BASH_RECAP ||
  (process.env.PARITY_UPSTREAM_ROOT ? path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/recap") : "");
if (!BASH_RECAP || !fs.existsSync(BASH_RECAP)) {
  console.error("seal-trigger parity: set PARITY_BASH_RECAP=/path/to/upstream/bin/recap (or PARITY_UPSTREAM_ROOT)");
  process.exit(2);
}
const TS_RECAP = path.join(REPO, "bin", "recap.mjs");
const TRAJ_ID = "aaaaaaaa-run";

// Model: each side runs its REAL `llm` client (upstream bin/llm, port bin/llm) against ONE replay server
// (parity/support/replayModel.mjs). Every rollup call gets the RECORDED real DeepSeek rollup reply from
// recordings/shared.json, served in CYCLE (the same bytes to both sides, every call); nothing here is written
// model output. The per-wake call count comes from the server's own request log, and each wake's wire
// requests (channel + body) are compared too.
const LLMBIN = { bash: fs.mkdtempSync(path.join(os.tmpdir(), "seal-trigger-upbin-")), port: fs.mkdtempSync(path.join(os.tmpdir(), "seal-trigger-portbin-")) };
fs.symlinkSync(path.join(path.dirname(BASH_RECAP), "llm"), path.join(LLMBIN.bash, "llm"));
fs.symlinkSync(path.join(REPO, "bin", "llm"), path.join(LLMBIN.port, "llm"));
const channelOf = (body) => {
  const sys = (body.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (sys.includes("one window of an AI agent")) return "map";
  if (sys.includes("numbered episode summaries")) return "reduce";
  if (sys.includes("FIRST PERSON")) return "rollup";
  return "other";
};
const replay = await startReplay({ suite: "recap", dir: path.join(HERE, "recordings"), channelOf, forwardModel: REPLAY_MODEL, cycle: true, recordingOf: () => "shared" });
process.on("exit", () => {
  for (const d of Object.values(LLMBIN)) fs.rmSync(d, { recursive: true, force: true });
});
const dropLlmWarnings = (s) => s.split("\n").filter((l) => !/^llm: warning: LLM_(PROVIDER|API_URL)=/.test(l) && !/^llm: warning: LLM_API_URL overrides/.test(l)).join("\n");
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { ...opts, detached: true });
    let stdout = "", stderr = "";
    ch.stdout.on("data", (d) => (stdout += d));
    ch.stderr.on("data", (d) => (stderr += d));
    ch.stdin.end();
    const t = setTimeout(() => { try { process.kill(-ch.pid, "SIGKILL"); } catch {} }, 120000);
    ch.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}

function step(i) {
  return {
    type: "thought",
    step_id: `s${String(i).padStart(7, "0")}`,
    ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    content: `step number ${i}`,
  };
}

function listFiles(dir, base = "") {
  const acc = [];
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === ".lock") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) acc.push(...listFiles(path.join(dir, e.name), rel));
    else acc.push(rel);
  }
  return acc;
}

const scrub = (s, sb) => s.split(sb).join("<SB>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<TS>");

async function runSide(kind, sc) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), `seal-trigger-${kind}-`));
  const runDir = path.join(sb, TRAJ_ID);
  fs.mkdirSync(runDir, { recursive: true });
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC", PATH: `${LLMBIN[kind]}:${process.env.PATH}`, TRAJ_DIR: sb };
  for (const k of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "LLM_MODEL", "TRAJ_ID", "RECAP_MODEL", "SHELLM_MODEL", "RECAP_MAP_MODEL", "ROLLUP_FANOUT", "ROLLUP_RAW_TAIL", "ROLLUP_MAX_SEALS", "MONOLITH_CONTEXT_BUDGET"]) delete env[k];
  Object.assign(env, { LLM_PROVIDER: "openai-compatible", LLM_API_URL: replay.url(sc.name, kind), LLM_API_KEY: "replay-not-a-key", LLM_RETRY_BACKOFF: "0" });
  Object.assign(env, sc.env ?? {});
  let n = 0;
  const wakes = [];
  let prevCalls = 0;
  for (const add of sc.growth) {
    const lines = Array.from({ length: add }, (_, i) => JSON.stringify(step(n + i))).join("\n");
    if (add > 0) fs.appendFileSync(path.join(runDir, "trajectory.jsonl"), lines + "\n");
    n += add;
    // exactly the monolith's per-wake call (common.sh:643-651)
    const argv = [TRAJ_ID, "--context", "--budget", "auto", "--raw-tail", "0", "--map-model", "m", "-q"];
    const r = kind === "bash" ? await run(BASH_RECAP, argv, { cwd: sb, env }) : await run("node", [TS_RECAP, ...argv], { cwd: sb, env });
    const reqs = replay.requests(sc.name, kind);
    const total = reqs.length;
    wakes.push({
      steps: n,
      exit: r.status,
      llmCalls: total - prevCalls,
      requests: reqs.slice(prevCalls).map((q) => `${q.channel} ${scrub(JSON.stringify(q.body), sb)}`),
      stderr: scrub(dropLlmWarnings(r.stderr ?? ""), sb),
      blocks: listFiles(path.join(runDir, "rollups")).filter((f) => f.endsWith(".json") && f !== "meta.json"),
      stdout: scrub(r.stdout ?? "", sb),
    });
    prevCalls = total;
  }
  fs.rmSync(sb, { recursive: true, force: true });
  return wakes;
}

const SCENARIOS = [
  { name: "enable-mid-history-then-small-wakes", growth: [37, 3, 7, 1, 12, 30, 9, 0, 0, 25], note: "marker snaps down to a fanout boundary; only new complete blocks seal" },
  { name: "exact-fanout-boundaries-cross-tier-2", growth: [0, ...Array(12).fill(10)], note: "tier-2 seals when 100 steps complete" },
  { name: "backlog-bigger-than-default-cap", growth: [5, 450, 0, 0, 0, 0], note: "ROLLUP_MAX_SEALS=20 default: the rest waits for later wakes" },
  { name: "cap-0-unlimited", growth: [5, 450, 0], env: { ROLLUP_MAX_SEALS: "0" } },
  { name: "cap-3-fanout-4", growth: [3, 60, 0, 0, 0, 0, 0, 0, 0], env: { ROLLUP_MAX_SEALS: "3", ROLLUP_FANOUT: "4" } },
  { name: "many-tiny-wakes", growth: [0, ...Array(40).fill(3)], note: "tier-1 seals only on every ~3rd/4th wake, regardless of wake count" },
];

let bad = 0;
if (process.env.ONLY) SCENARIOS.splice(0, SCENARIOS.length, ...SCENARIOS.filter((sc) => new RegExp(process.env.ONLY).test(sc.name)));
for (const sc of SCENARIOS) {
  const a = await runSide("bash", sc);
  const b = await runSide("port", sc);
  const diffs = [];
  for (let i = 0; i < a.length; i++) {
    const same = JSON.stringify(a[i]) === JSON.stringify(b[i]);
    if (!same) diffs.push(i);
  }
  const callsA = a.map((w) => w.llmCalls);
  const callsB = b.map((w) => w.llmCalls);
  const totalA = callsA.reduce((x, y) => x + y, 0);
  const totalB = callsB.reduce((x, y) => x + y, 0);
  console.log(`${diffs.length ? "DIVERGE" : "PARITY "} ${sc.name}  wakes=${a.length} llm-calls upstream=${totalA} port=${totalB}`);
  if (diffs.length) {
    bad++;
    for (const i of diffs.slice(0, 3)) {
      console.log(`   wake ${i} (n=${a[i].steps}): upstream calls=${a[i].llmCalls} exit=${a[i].exit}, port calls=${b[i].llmCalls} exit=${b[i].exit}`);
    }
  } else {
    console.log(`   per-wake calls: ${callsA.join(",")}`);
  }
}
const nonRollup = SCENARIOS.flatMap((sc) => ["bash", "port"].flatMap((k) => replay.requests(sc.name, k).filter((q) => q.channel !== "rollup").map(() => `${sc.name}/${k}`)));
if (replay.misses.length || nonRollup.length) {
  bad++;
  console.log(`DIVERGE replay: ${replay.misses.length} miss(es), ${nonRollup.length} non-rollup call(s)\n   ${[...replay.misses, ...nonRollup].slice(0, 5).join("\n   ")}`);
} else console.log(`PARITY  replay: every call was a rollup call served from recordings/shared.json (${replay.cycled.length} cycled serves of model ${replay.recording("shared").model}, recorded ${replay.recording("shared").recorded_at}), 0 misses`);
await replay.close();
console.log(`\n${SCENARIOS.length + 1 - bad}/${SCENARIOS.length + 1} checks identical (scenarios on every wake, plus replay)`);
process.exit(bad ? 1 : 0);
