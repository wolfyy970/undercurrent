#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `recap` subsystem.
//
// Runs the REAL Bash tool (headlong/bin/recap) and the TS port
// (headlong-ts/bin/recap.mjs) on identical inputs in isolated scratch
// trajectory directories, then diffs stdout + stderr + exit code + on-disk
// cache state (recap/ + rollups/) byte-for-byte. One scenario per
// subcommand/flag/error path harvested from the Bash source; a few
// scenarios run TWO sequential invocations against the same sandbox to
// exercise incremental refresh / resume / locking.
//
// `llm` is each side's REAL client on one replay server of recorded real DeepSeek replies (see below), so recap
// output (titles, arcs, block summaries) is comparable byte-for-byte whenever both tools send the same requests.
//
// Nondeterminism (wall-clock `created`/`generated_at`/`updated` timestamps)
// is normalized SYMMETRICALLY on both sides before comparison. Absolute
// paths are scrubbed to <HEADLONG_ROOT>/<SANDBOX> — each side runs in its
// OWN scratch sandbox, so its own sandbox root is replaced with a shared
// placeholder before comparing; nothing else is touched.
//
// Repeatable: `node parity/recap/run-parity.mjs`. Writes results.json +
// report.md beside this file. Exit 0 iff every scenario reaches PARITY or is
// a documented deviation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Scrubbed to a placeholder for release; set PARITY_BASH_RECAP=/abs/path to reproduce.
const BASH_RECAP = process.env.PARITY_BASH_RECAP || "<HEADLONG_ROOT>/bin/recap";
const TS_RECAP = path.join(REPO, "bin", "recap.mjs");

// --- the real `llm` on each side, on ONE replay server of recorded real DeepSeek replies -------------------------
// Upstream's recap runs upstream's real bin/llm; the port's runs the port's bin/llm. Both reach the same replay server
// (parity/support/replayModel.mjs) through LLM_API_URL. The replies are recorded real ones, labelled in the report:
// ONE short real reply per call kind (map = window summary, reduce = arc, rollup = first-person block), stored in
// recordings/shared.json and served in CYCLE to every call of that kind in every scenario, the same bytes to both
// sides. The non-JSON reply cases are a separate parser layer (run-parser-parity.mjs: upstream's `_llm_json` cut
// from bin/recap by markers and hash, on literal strings, no model); a failing `llm` is an HTTP 500 transport fixture.
import { startReplay, REPLAY_MODEL } from "../support/replayModel.mjs";
const UPSTREAM_ROOT = process.env.PARITY_UPSTREAM_ROOT || path.resolve(path.dirname(BASH_RECAP), "..");
const LLMBIN = { bash: fs.mkdtempSync(path.join(os.tmpdir(), "recap-parity-upbin-")), ts: fs.mkdtempSync(path.join(os.tmpdir(), "recap-parity-portbin-")) };
fs.symlinkSync(path.join(UPSTREAM_ROOT, "bin", "llm"), path.join(LLMBIN.bash, "llm"));
fs.symlinkSync(path.join(REPO, "bin", "llm"), path.join(LLMBIN.ts, "llm"));
const channelOf = (body) => {
  const sys = (body.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (sys.includes("one window of an AI agent")) return "map";
  if (sys.includes("numbered episode summaries")) return "reduce";
  if (sys.includes("FIRST PERSON")) return "rollup";
  return "other";
};
// Transport fixture (not model output): every call of the scenario answers HTTP 500, so `llm` exits non-zero.
const HTTP_500 = { status: 500, content_type: "application/json", body: '{"error":{"message":"replay fixture: HTTP 500 (transport failure, not model output)"}}' };
const replay = await startReplay({
  suite: "recap",
  dir: path.join(HERE, "recordings"),
  channelOf,
  forwardModel: REPLAY_MODEL,
  cycle: true,
  recordingOf: () => "shared",
  fixtures: { "llm-nonzero-exit-treated-as-empty-reply": { map: { "*": HTTP_500 }, reduce: { "*": HTTP_500 }, rollup: { "*": HTTP_500 } } },
});

// --- normalization -------------------------------------------------------------
function normalizeCommon(s) {
  if (s == null) return s;
  return s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<TS>");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace THIS side's own sandbox absolute path with a shared placeholder. */
function scrubSandbox(s, sandboxAbs) {
  if (s == null) return s;
  return s.split(sandboxAbs).join("<SANDBOX>");
}

// The two `llm` clients' own warnings about the replay URL/provider override are dropped on both sides (they name the
// replay server, not recap; the same "llm network guards" handling as parity/responder).
const dropLlmWarnings = (s) => s.split("\n").filter((l) => !/^llm: warning: LLM_(PROVIDER|API_URL)=/.test(l) && !/^llm: warning: LLM_API_URL overrides/.test(l)).join("\n");
function normalize(s, sandboxAbs) {
  return normalizeCommon(scrubSandbox(dropLlmWarnings(s), sandboxAbs));
}

// --- on-disk state serialization (recap/ + rollups/ under the run dir) --------
function walk(dir, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === ".lock") continue; // directory lock: existence/timing only, not content
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else acc.push({ rel, content: fs.readFileSync(full, "utf8") });
  }
}
function serializeState(runDirAbs) {
  const acc = [];
  for (const sub of ["recap", "rollups"]) walk(path.join(runDirAbs, sub), sub, acc);
  if (acc.length === 0) return "<no cache>";
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

// --- scratch sandbox: TRAJ_DIR root containing one run dir --------------------
const TRAJ_ID = "aaaaaaaa-run";

function makeSandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "recap-parity-sb-"));
  return sb;
}

function writeTrajLines(sb, lines) {
  const runDir = path.join(sb, TRAJ_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function appendTrajLines(sb, lines) {
  const runDir = path.join(sb, TRAJ_ID);
  fs.appendFileSync(path.join(runDir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// A small deterministic trajectory: kept types only, ascending timestamps.
function fixtureSteps(n, opts = {}) {
  const off = opts.offset ?? 0;
  return Array.from({ length: n }, (_, i) => ({
    type: "thought",
    step_id: `s${String(off + i).padStart(7, "0")}`,
    ts: `2026-01-01T00:${String((off + i) % 60).padStart(2, "0")}:00Z`,
    content: `step number ${off + i}`,
  }));
}

function runInvocation(kind, argv, env, sb, scenarioName) {
  const fullEnv = { ...process.env };
  for (const k of [
    "TRAJ_DIR",
    "TRAJ_ID",
    "RECAP_MODEL",
    "SHELLM_MODEL",
    "RECAP_MAP_MODEL",
    "RECAP_REDUCE_MODEL",
    "RECAP_MAX_WINDOW_BYTES",
    "ROLLUP_FANOUT",
    "MONOLITH_CONTEXT_BUDGET",
    "ROLLUP_RAW_TAIL",
    "MODEL_CONTEXT_WINDOW",
    "THINK_MODEL",
    "RECAP_CONTEXT_BUDGET_MAX",
    "LLM_PROVIDER",
    "LLM_API_URL",
    "LLM_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
  ]) {
    delete fullEnv[k];
  }
  fullEnv.LC_ALL = "C";
  fullEnv.TZ = "UTC";
  fullEnv.PATH = `${LLMBIN[kind]}:${fullEnv.PATH}`;
  fullEnv.LLM_PROVIDER = "openai-compatible";
  fullEnv.LLM_API_URL = replay.url(scenarioName, kind);
  fullEnv.LLM_API_KEY = "replay-not-a-key";
  fullEnv.LLM_RETRY_BACKOFF = "0";
  fullEnv.TRAJ_DIR = sb;
  Object.assign(fullEnv, env || {});

  const bin = kind === "bash" ? BASH_RECAP : "node";
  const args = kind === "bash" ? argv : [TS_RECAP, ...argv];
  // Async: the replay server lives in this process.
  return new Promise((resolve) => {
    const ch = spawn(bin, args, { cwd: sb, env: fullEnv });
    let stdout = "", stderr = "";
    ch.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    ch.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const t = setTimeout(() => ch.kill("SIGTERM"), 30000);
    ch.on("close", (status, signal) => {
      clearTimeout(t);
      resolve({ stdout, stderr, status, signal });
    });
  });
}

async function runTool(kind, scenario) {
  const sb = makeSandbox();
  if (scenario.trajLines) writeTrajLines(sb, scenario.trajLines);
  if (scenario.setup) scenario.setup(sb, TRAJ_ID);

  const invocations = [];
  for (const step of scenario.invocations) {
    if (step.appendLines) appendTrajLines(sb, step.appendLines);
    if (step.setup) step.setup(sb, TRAJ_ID);
    invocations.push(await runInvocation(kind, step.argv, step.env, sb, scenario.name));
  }
  const runDirAbs = path.join(sb, TRAJ_ID);
  const state = serializeState(runDirAbs);
  const out = { invocations, state, sb };
  return out;
}

// --- scenario definitions -------------------------------------------------------
const scenarios = [
  // ---- global ----
  { group: "global", name: "version", invocations: [{ argv: ["--version"] }] },
  { group: "global", name: "help", invocations: [{ argv: ["--help"] }] },
  { group: "global", name: "help-short", invocations: [{ argv: ["-h"] }] },
  { group: "global", name: "unknown-option", invocations: [{ argv: ["--bogus"] }] },
  { group: "global", name: "two-positional-ids", invocations: [{ argv: ["one", "two"] }] },
  {
    group: "global",
    name: "missing-flag-value",
    note: "probes bash ${2:?} error text vs the port's PORT-NOTE clean message",
    invocations: [{ argv: ["--traj_dir"] }],
  },
  {
    group: "global",
    name: "empty-flag-value",
    note: "${2:?} fires on an empty value too",
    invocations: [{ argv: ["--window", ""] }],
  },

  // ---- validation ----
  { group: "validate", name: "window-too-small", invocations: [{ argv: ["--window", "5"] }] },
  { group: "validate", name: "window-non-numeric", invocations: [{ argv: ["--window", "abc"] }] },
  {
    group: "validate",
    name: "no-traj-dir",
    invocations: [{ argv: ["abc"], env: { TRAJ_DIR: "" } }],
  },
  {
    group: "validate",
    name: "traj-dir-not-a-directory",
    invocations: [{ argv: ["abc"], env: { TRAJ_DIR: "/does/not/exist/xyz" } }],
  },
  { group: "validate", name: "no-traj-id", trajLines: fixtureSteps(1), invocations: [{ argv: [] }] },
  {
    group: "validate",
    name: "no-trajectory-matching",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: ["zzzzzzzz"] }],
  },
  {
    group: "validate",
    name: "fanout-too-small",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: [TRAJ_ID, "--cached", "--fanout", "1"] }],
  },
  {
    group: "validate",
    name: "budget-invalid-under-context",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: [TRAJ_ID, "--context", "--budget", "0"] }],
  },
  {
    group: "validate",
    name: "raw-tail-invalid-under-context",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: [TRAJ_ID, "--context", "--raw-tail", "nope"] }],
  },
  {
    group: "validate",
    name: "budget-ignored-without-context",
    note: "malformed --budget never validated when --context is absent",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: [TRAJ_ID, "--budget", "garbage", "--cached"] }],
  },

  // ---- refresh / map-reduce ----
  {
    group: "refresh",
    name: "basic-recap-text",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10"] }],
  },
  {
    group: "refresh",
    name: "basic-recap-json",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10", "--json"] }],
  },
  {
    group: "refresh",
    name: "cached-with-no-prior-recap-dies",
    trajLines: fixtureSteps(1),
    invocations: [{ argv: [TRAJ_ID, "--cached"] }],
  },
  {
    group: "refresh",
    name: "quiet-suppresses-progress",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10", "-q"] }],
  },
  {
    group: "refresh",
    name: "map-model-and-reduce-model-flags",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10", "--map-model", "map-x", "--reduce-model", "reduce-y"] }],
  },
  // badjson-retries-then-dies moved to the parser layer (run-parser-parity.mjs): a non-JSON reply is model text, and
  // the rule is no hand-written model text over the wire.
  {
    group: "refresh",
    name: "llm-nonzero-exit-treated-as-empty-reply",
    trajLines: fixtureSteps(3),
    note: "transport fixture: every model call answers HTTP 500, so `llm` exits non-zero",
    invocations: [{ argv: [TRAJ_ID, "--window", "10"] }],
  },
  {
    group: "refresh",
    name: "cached-after-generate",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10"] }, { argv: [TRAJ_ID, "--cached"] }],
  },
  {
    group: "refresh",
    name: "no-new-steps-second-run",
    trajLines: fixtureSteps(10),
    invocations: [{ argv: [TRAJ_ID, "--window", "10"] }, { argv: [TRAJ_ID, "--window", "10"] }],
  },
  {
    group: "refresh",
    name: "incremental-resume-appends-episode",
    trajLines: fixtureSteps(10),
    invocations: [
      { argv: [TRAJ_ID, "--window", "10"] },
      { argv: [TRAJ_ID, "--window", "10"], appendLines: fixtureSteps(12, { offset: 10 }) },
    ],
  },
  {
    group: "refresh",
    name: "trailing-partial-resummarized-on-growth",
    trajLines: fixtureSteps(5),
    invocations: [
      { argv: [TRAJ_ID] },
      { argv: [TRAJ_ID], appendLines: fixtureSteps(10, { offset: 5 }) },
    ],
  },
  {
    group: "refresh",
    name: "rebuild-drops-cache",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--window", "10"] }, { argv: [TRAJ_ID, "--window", "10", "--rebuild"] }],
  },
  {
    group: "refresh",
    name: "lock-in-progress-dies",
    trajLines: fixtureSteps(1),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap", ".lock"), { recursive: true });
    },
    invocations: [{ argv: [TRAJ_ID] }],
  },
  {
    group: "refresh",
    name: "stale-lock-reclaimed",
    trajLines: fixtureSteps(1),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const old = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(lock, old, old);
    },
    invocations: [{ argv: [TRAJ_ID] }],
  },

  // ---- --context / rollups ----
  {
    group: "context",
    name: "context-no-rollups-yet-raw-tail-only",
    trajLines: fixtureSteps(3),
    invocations: [{ argv: [TRAJ_ID, "--context", "--raw-tail", "3"] }],
  },
  {
    group: "context",
    name: "context-cached-never-seals",
    trajLines: fixtureSteps(10),
    invocations: [{ argv: [TRAJ_ID, "--context", "--cached", "--backfill", "--fanout", "5"] }],
  },
  {
    group: "context",
    name: "context-backfill-seals-tier1",
    trajLines: fixtureSteps(10),
    invocations: [{ argv: [TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"] }],
  },
  {
    group: "context",
    name: "context-two-tier-staircase",
    trajLines: fixtureSteps(20),
    invocations: [{ argv: [TRAJ_ID, "--context", "--backfill", "--fanout", "2", "--raw-tail", "2"] }],
  },
  {
    group: "context",
    name: "context-default-start-index-snaps-to-fanout",
    trajLines: fixtureSteps(23),
    invocations: [{ argv: [TRAJ_ID, "--context", "--fanout", "10", "--raw-tail", "3"] }],
  },
  {
    group: "context",
    name: "context-rebuild-reseals",
    trajLines: fixtureSteps(10),
    invocations: [
      { argv: [TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"] },
      { argv: [TRAJ_ID, "--context", "--rebuild", "--fanout", "10", "--raw-tail", "0"] },
    ],
  },
  {
    group: "context",
    name: "context-incremental-render-append",
    trajLines: fixtureSteps(5),
    invocations: [
      { argv: [TRAJ_ID, "--context", "--raw-tail", "5"] },
      { argv: [TRAJ_ID, "--context", "--raw-tail", "8"], appendLines: fixtureSteps(3, { offset: 5 }) },
    ],
  },
  {
    group: "context",
    name: "context-lock-in-progress-dies",
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "rollups", ".lock"), { recursive: true });
    },
    invocations: [{ argv: [TRAJ_ID, "--context"] }],
  },
];

// --- execute --------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  let bash, ts;
  try {
    bash = await runTool("bash", sc);
    ts = await runTool("ts", sc);
  } catch (e) {
    results.push({ group: sc.group, name: sc.name, note: sc.note, pass: false, error: String(e) });
    continue;
  }

  const nInv = Math.max(bash.invocations.length, ts.invocations.length);
  const invCmp = [];
  let allInvOk = true;
  for (let i = 0; i < nInv; i++) {
    const b = bash.invocations[i] ?? { stdout: "<missing>", stderr: "<missing>", status: null };
    const t = ts.invocations[i] ?? { stdout: "<missing>", stderr: "<missing>", status: null };
    const bOut = normalize(b.stdout, bash.sb);
    const tOut = normalize(t.stdout, ts.sb);
    const bErr = normalize(b.stderr, bash.sb);
    const tErr = normalize(t.stderr, ts.sb);
    const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: b.status === t.status };
    if (!cmp.stdout || !cmp.stderr || !cmp.status) allInvOk = false;
    invCmp.push({ cmp, bash: { ...b, stdoutN: bOut, stderrN: bErr }, ts: { ...t, stdoutN: tOut, stderrN: tErr } });
  }
  const bState = normalize(bash.state, bash.sb);
  const tState = normalize(ts.state, ts.sb);
  const stateMatch = bState === tState;

  fs.rmSync(bash.sb, { recursive: true, force: true });
  fs.rmSync(ts.sb, { recursive: true, force: true });

  const pass = allInvOk && stateMatch;
  results.push({
    group: sc.group,
    name: sc.name,
    note: sc.note,
    invocations: sc.invocations.map((i) => i.argv),
    pass,
    invCmp,
    state: { match: stateMatch, bash: bState, ts: tState },
  });
}

results.push({ group: "replay", name: "every model call had a recording or a fixture (no misses)", pass: replay.misses.length === 0, error: replay.misses.join("\n") || undefined, invCmp: [], state: { match: true } });
for (const d of Object.values(LLMBIN)) fs.rmSync(d, { recursive: true, force: true });
await replay.close();

// --- report -----------------------------------------------------------------
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = total ? ((passed / total) * 100).toFixed(1) : "0.0";

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# recap — differential parity proof\n\n`;
md += `Generated by \`parity/recap/run-parity.mjs\`. Real Bash tool \`headlong/bin/recap\` vs TS port \`headlong-ts/bin/recap.mjs\`, identical trajectory fixtures, diffed stdout+stderr+exit code+on-disk cache state (recap/ + rollups/, \`.lock\` directories excluded — existence/timing only).\n\n`;
md += `- Node: \`node parity/recap/run-parity.mjs\` (Node 24). Locale pinned \`LC_ALL=C\`, \`TZ=UTC\`.\n`;
md += `- \`llm\`: each side's real client (upstream \`bin/llm\`, port \`bin/llm\`) on ONE replay server (\`parity/support/replayModel.mjs\`). Replies are RECORDED real DeepSeek replies (\`recordings/shared.json\`, ${Object.entries(replay.recording("shared").channels).map(([k, v]) => `${k}: ${v.length}`).join(", ")} call(s), recorded ${replay.recording("shared").recorded_at}, model ${replay.recording("shared").model}) served in CYCLE: every map, reduce and rollup call gets that kind's recorded reply (${replay.cycled.length} cycled serves this run), the same bytes to both sides. \`llm-nonzero-exit-treated-as-empty-reply\` uses an HTTP 500 transport fixture. Non-JSON replies are covered by the parser layer (\`run-parser-parity.mjs\`). Replay misses this run: ${replay.misses.length}.\n`;
md += `- Normalized symmetrically: \`<TS>\` for a local \`YYYY-MM-DDTHH:MM:SS\` timestamp; each side's own scratch sandbox absolute path scrubbed to \`<SANDBOX>\`. Everything else compared exactly.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;

const byGroup = {};
for (const r of results) (byGroup[r.group] ??= []).push(r);
md += `| # | group | scenario | verdict |\n|---|---|---|---|\n`;
let idx = 1;
for (const r of results) md += `| ${idx++} | ${r.group} | ${r.name} | ${r.pass ? "PARITY" : "MISMATCH"} |\n`;

md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.group} / ${r.name}\n`;
  if (r.note) md += `- note: ${r.note}\n`;
  if (r.error) {
    md += `- error: ${r.error}\n\n`;
    continue;
  }
  md += `- invocations: \`${JSON.stringify(r.invocations)}\`\n`;
  md += "```\n";
  r.invCmp.forEach((ic, i) => {
    md += `  -- invocation ${i} --\n`;
    md += `  exit: bash=${ic.bash.status} ts=${ic.ts.status}\n`;
    md += block("stdout", ic.bash.stdoutN, ic.ts.stdoutN, ic.cmp.stdout) + "\n";
    md += block("stderr", ic.bash.stderrN, ic.ts.stderrN, ic.cmp.stderr) + "\n";
  });
  md += block("state", r.state.bash, r.state.ts, r.state.match) + "\n";
  md += "```\n\n";
}

md += `## Interpretation of divergences\n\n`;
md += `Deviations are documented in PARITY.md (recap module row). The primary expected divergence class is the \`\${2:?}\` bash-builtin error-text PORT-NOTE (missing/empty required flag values): exit code, stdout, and on-disk state match; only the stderr phrasing differs (bash embeds the script's absolute path + a bash line number, irreproducible and brittle to pin from TS).\n`;

// Write-time-only scrub: the real Bash tool's `${2:?}` error text embeds this
// machine's absolute headlong checkout path (and, transitively, $HOME); strip
// both from the committed artifacts. Never used for the pass/fail comparison
// above (that already normalizes each side's own scratch sandbox path).
const REAL_HEADLONG_ROOT = path.resolve(BASH_RECAP, "..", "..");
const HOME = os.homedir();
function scrubForWrite(s) {
  if (typeof s !== "string") return s;
  let out = s.split(REAL_HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}
function deepScrub(v) {
  if (typeof v === "string") return scrubForWrite(v);
  if (Array.isArray(v)) return v.map(deepScrub);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = deepScrub(val);
    return o;
  }
  return v;
}

fs.writeFileSync(path.join(HERE, "report.md"), scrubForWrite(md));
fs.writeFileSync(
  path.join(HERE, "results.json"),
  JSON.stringify(deepScrub({ total, passed, rate, results }), null, 2),
);

console.log(`recap parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) console.log(`  MISMATCH ${r.group}/${r.name}${r.error ? " ERROR: " + r.error : ""}`);
}
process.exit(passed === total ? 0 : 1);
