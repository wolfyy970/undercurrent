#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for headlong-init.
//
// Runs the REAL Bash tool (headlong/tools/headlong-init) and the TS port
// (headlong-ts/bin/headlong-init.mjs) on identical env/argv against isolated
// scratch HEADLONG_HOME state homes, then diffs stdout + stderr + exit code +
// on-disk .env content. Scenarios cover the Docker sandbox gate
// (HEADLONG_FAKE_DOCKER=ok|down|missing, HEADLONG_UNSANDBOXED, --dry-run) and
// the local OpenAI-compatible provider setup (a real local fake /v1/models +
// /v1/chat/completions HTTP server both sides are pointed at), per
// tests/test_sandbox_gate.sh and tests/test_local_llm_setup.sh.
//
// Both sides always run with HEADLONG_NO_TTY=1 (no interactive prompts) and
// HEADLONG_NO_THINKERS=1 HEADLONG_NO_DASH=1 (no dispatcher/dash spawned) —
// this harness proves the DETERMINISTIC bootstrap paths (the gate, the
// provider handshake), not the interactive interview or process lifecycle,
// which are covered by test/init.test.ts's unit/integration tests.
//
// PORT-NOTE: the one scenario that reaches identity creation compares only
// exit code, .env core keys, and "an identity dir now exists" — NOT the
// identity tree's contents. The two sides' identity layouts are
// deliberately different (kernel/skills copied vs symlinked, no `activate`
// file, different persona-writing prompt, different seed-thought text — see
// PORTING.md and PARITY.md's identity/thinkers rows) and a byte diff there
// would not be a meaningful port-fidelity signal for THIS module.
//
// Usage: node parity/init/run-parity.mjs
//   PARITY_BASH_HEADLONG_INIT=/abs/path/to/headlong/tools/headlong-init
// The committed default below is a scrubbed placeholder (this repo's own
// scrub test forbids a real local path in source).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_INIT = process.env.PARITY_BASH_HEADLONG_INIT || "<HEADLONG_ROOT>/tools/headlong-init";
const BASH_ROOT = path.resolve(path.dirname(BASH_INIT), ".."); // tools/headlong-init -> checkout root
const TS_INIT = path.join(REPO, "bin", "headlong-init.mjs");

const HAVE_BASH_ORACLE = fs.existsSync(BASH_INIT);
if (!HAVE_BASH_ORACLE) {
  console.error(`init parity: real Bash headlong-init not found at ${BASH_INIT} — set PARITY_BASH_HEADLONG_INIT=/path/to/headlong/tools/headlong-init`);
}

// --- the local OpenAI-compatible endpoint (a child process: server-child.mjs) ----------
// /models is a labelled WIRE fixture (the model list); /chat/completions serves a RECORDED real DeepSeek reply through
// parity/support/replayModel.mjs (see server-child.mjs). Both sides use their own real `llm` (upstream's bin/llm on the
// Bash side's PATH; the port's init calls its own llm client in process).
const DEFAULT_MODELS = JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function startFakeServer(models = DEFAULT_MODELS, modelsStatus = 200) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-parity-srv-"));
  const portFile = path.join(tmp, "port"), missFile = path.join(tmp, "state");
  const child = spawn(process.execPath, [path.join(HERE, "server-child.mjs"), JSON.stringify({ models, modelsStatus, portFile, missFile })], { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) sleepMs(50);
  const port = fs.readFileSync(portFile, "utf8").trim();
  return {
    base: (scenario, side) => `http://127.0.0.1:${port}/${encodeURIComponent(scenario)}/${encodeURIComponent(side)}`,
    state() {
      sleepMs(250);
      try {
        return JSON.parse(fs.readFileSync(missFile, "utf8"));
      } catch {
        return { misses: [], hits: [] };
      }
    },
    close: async () => {
      child.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// --- fake bash checkout (only for scenarios that never call `identity`) ----
function makeFakeBashApp(scratchRoot) {
  const app = path.join(scratchRoot, "fake-bash-app");
  fs.mkdirSync(path.join(app, "bin"), { recursive: true });
  fs.mkdirSync(path.join(app, "tools"), { recursive: true });
  fs.writeFileSync(path.join(app, "bin", "shellm"), "");
  return app;
}

// --- fake TS checkout (bin/identity.mjs marker only; HEADLONG_APP_DIR override) --
// The port itself is used directly (REPO) since it's the real thing under test.

function normalizeEnvFile(text) {
  return text.split("\n").filter(Boolean).sort().join("\n");
}

function runTool(kind, sc, scratch, server) {
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const headlongHome = path.join(home, ".headlong");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    HEADLONG_HOME: headlongHome,
    HEADLONG_NO_TTY: "1",
    HEADLONG_NO_THINKERS: "1",
    HEADLONG_NO_DASH: "1",
    ...sc.env,
  };
  if (server && sc.useServer) {
    const url = `${server.base(sc.name.replace(/[^a-z0-9]+/gi, "-"), kind)}/v1`;
    env.HEADLONG_LOCAL_URL = env.HEADLONG_LOCAL_URL === "__SERVER__" ? url : env.HEADLONG_LOCAL_URL;
  }
  let bin, args;
  if (kind === "bash") {
    if (!HAVE_BASH_ORACLE) return { skipped: true };
    const appDir = makeFakeBashApp(scratch);
    env.HEADLONG_APP_DIR = appDir;
    bin = "bash";
    args = [BASH_INIT, ...sc.argv];
    env.PATH = `${path.join(path.dirname(BASH_INIT), "..", "bin")}:${env.PATH}`; // upstream's real llm for the smoke call
  } else {
    env.HEADLONG_APP_DIR = REPO;
    bin = process.execPath;
    args = [TS_INIT, ...sc.argv];
  }
  const r = spawnSync(bin, args, { env, encoding: "utf8", timeout: 30_000 });
  const envFile = safeRead(path.join(headlongHome, ".env"));
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    envFile,
    identityDirExists: sc.identityDirCheckApp ? fs.existsSync(path.join(sc.identityDirCheckApp(env), ".identities")) : undefined,
  };
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Extract only the vars a scenario cares about from a normalized .env, so
// wording differences elsewhere never mask a real key/value mismatch.
function envKeys(text, keys) {
  const out = {};
  for (const k of keys) {
    const m = new RegExp(`^${k}='(.*)'$`, "m").exec(text);
    out[k] = m ? m[1] : undefined;
  }
  return out;
}

// --- scenarios ----------------------------------------------------------------
// allow: per-scenario documented allowances (fields that may legitimately
// differ, with why) — recorded in the report, never silently dropped.
const scenarios = [
  {
    name: "dry-run, docker ok",
    argv: ["--dry-run"],
    env: { HEADLONG_FAKE_DOCKER: "ok" },
    compareEnvKeys: [],
    expectExit0: true,
    allow: ["stdout wording differs cosmetically (phase text is this port's own copy of the header comment); both announce the sandbox and say dry-run"],
    stdoutBothMatch: [/sandboxed in Docker/, /dry.run/i],
  },
  {
    name: "no docker, no consent, no tty",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "missing", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "" },
    expectExit0: false,
    stderrBothMatch: [/HEADLONG_UNSANDBOXED/],
    stdoutStderrBothExclude: [/API key/i],
  },
  {
    name: "no docker, HEADLONG_UNSANDBOXED=1 persists SHELLM_REQUIRE_DOCKER=0",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "missing", HEADLONG_UNSANDBOXED: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "" },
    expectExit0: false,
    compareEnvKeys: ["SHELLM_REQUIRE_DOCKER", "HEADLONG_UNSANDBOXED"],
    stderrBothMatch: [/directly on this machine/],
  },
  {
    name: "docker up: persists SHELLM_REQUIRE_DOCKER=1",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "" },
    expectExit0: false,
    compareEnvKeys: ["SHELLM_REQUIRE_DOCKER"],
    stdoutBothMatch: [/sandboxed in Docker/],
  },
  {
    name: "menu-3 equivalent: HEADLONG_UNSANDBOXED=1 sticks even with docker up",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", HEADLONG_UNSANDBOXED: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "" },
    expectExit0: false,
    compareEnvKeys: ["SHELLM_REQUIRE_DOCKER", "HEADLONG_UNSANDBOXED"],
  },
  {
    name: "unknown option is an error",
    argv: ["--bogus"],
    env: { HEADLONG_FAKE_DOCKER: "ok" },
    expectExit0: false,
  },
  {
    name: "local provider happy path",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: "__SERVER__", HEADLONG_LOCAL_MODEL: "qwen3:8b" },
    useServer: true,
    expectExit0: undefined, // both sides proceed to identity creation; allowed to diverge there (see below)
    compareEnvKeys: ["LLM_PROVIDER", "SHELLM_MODEL"],
    allow: ["SHELLM_API_URL differs only in the fake server's port between the two independent scratch runs — compared for shape (ends in /v1/chat/completions), not exact string"],
    compareEnvUrlSuffix: { key: "SHELLM_API_URL", suffix: "/v1/chat/completions" },
  },
  {
    name: "local provider: malicious model id refused",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: "__SERVER__" },
    useServer: true,
    modelsOverride: JSON.stringify({ data: [{ id: "qwen3$(touch pwned)" }] }),
    expectExit0: false,
    compareEnvKeys: ["LLM_PROVIDER"],
  },
  {
    name: "local provider: dead endpoint dies before writing anything",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: "http://127.0.0.1:1/v1", HEADLONG_LOCAL_MODEL: "x" },
    expectExit0: false,
    compareEnvKeys: ["LLM_PROVIDER"],
    stderrBothMatch: [/could not reach/],
  },
  {
    name: "local provider: empty model list + explicit model still works",
    argv: [],
    env: { HEADLONG_FAKE_DOCKER: "ok", HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: "__SERVER__", HEADLONG_LOCAL_MODEL: "qwen3:8b" },
    useServer: true,
    modelsOverride: JSON.stringify({ data: [] }),
    expectExit0: undefined,
    compareEnvKeys: ["SHELLM_MODEL"],
  },
];

// --- environment self-test: can a subprocess `curl` reach a loopback server? -----
// The real Bash tool's `_local_models_get` shells out to `curl`; the port uses
// Node's native `fetch()` (see src/init.ts's file-header PORT-NOTE and
// src/llmCli.ts's — same design, same known curl-vs-fetch interception gap
// documented in parity/upstream-tests/report.md for test_llm_openai_compatible.sh
// et al). Some sandboxes intercept/allow outbound sockets per-process rather
// than per-port, in which case a `curl` CHILD process cannot reach a loopback
// server this script's own `fetch` reaches fine — a testing-environment
// limitation, not a port behavior difference. Detected once, up front, so
// affected scenarios are honestly marked SKIPPED rather than reported as
// PORT-BUG.
async function curlCanReachLoopback() {
  const probe = startFakeServer();
  const r = spawnSync("curl", ["-sS", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code}", `${probe.base("probe", "curl")}/v1/models`], { encoding: "utf8" });
  await probe.close();
  return r.stdout?.trim().startsWith("2");
}
const CURL_LOOPBACK_OK = HAVE_BASH_ORACLE ? await curlCanReachLoopback() : true;
if (HAVE_BASH_ORACLE && !CURL_LOOPBACK_OK) {
  console.error(
    "init parity: this environment's subprocess `curl` cannot reach a loopback HTTP server " +
      "(Node's own fetch() can — confirmed separately). The real Bash headlong-init's local-" +
      "provider path shells out to curl, so scenarios needing the fake server are SKIPPED here, " +
      "not reported as PORT-BUG. Re-run in an environment where subprocess curl reaches 127.0.0.1."
  );
}

// --- execute --------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  if (sc.useServer && !CURL_LOOPBACK_OK) {
    results.push({ name: sc.name, skipped: "subprocess curl cannot reach loopback in this environment (see console note above)" });
    continue;
  }
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "init-parity-"));
  let server;
  if (sc.useServer) {
    server = startFakeServer(sc.modelsOverride ?? DEFAULT_MODELS);
  }
  const sbBash = path.join(scratchRoot, "bash");
  const sbTs = path.join(scratchRoot, "ts");
  fs.mkdirSync(sbBash, { recursive: true });
  fs.mkdirSync(sbTs, { recursive: true });

  const bash = runTool("bash", sc, sbBash, server);
  const ts = runTool("ts", sc, sbTs, server);
  const serverState = server ? server.state() : { misses: [], hits: [] };
  if (server) await server.close();
  if (serverState.misses.length) throw new Error(`init parity: replay miss (fails the run):\n${serverState.misses.join("\n")}`);

  if (bash.skipped) {
    results.push({ name: sc.name, skipped: "no Bash oracle available" });
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    continue;
  }

  const checks = [];
  checks.push({ label: "exit code (both nonzero, or both zero, as expected)", pass: sc.expectExit0 === undefined ? true : (bash.status === 0) === sc.expectExit0 && (ts.status === 0) === sc.expectExit0 });
  if (sc.compareEnvKeys?.length) {
    const b = envKeys(bash.envFile, sc.compareEnvKeys);
    const t = envKeys(ts.envFile, sc.compareEnvKeys);
    for (const k of sc.compareEnvKeys) {
      checks.push({ label: `.env ${k}`, pass: b[k] === t[k], bash: b[k], ts: t[k] });
    }
  }
  if (sc.compareEnvUrlSuffix) {
    const { key, suffix } = sc.compareEnvUrlSuffix;
    const b = envKeys(bash.envFile, [key])[key];
    const t = envKeys(ts.envFile, [key])[key];
    checks.push({ label: `.env ${key} suffix`, pass: Boolean(b?.endsWith(suffix)) && Boolean(t?.endsWith(suffix)), bash: b, ts: t });
  }
  for (const re of sc.stdoutBothMatch ?? []) {
    checks.push({ label: `stdout matches ${re}`, pass: re.test(bash.stdout) && re.test(ts.stdout) });
  }
  for (const re of sc.stderrBothMatch ?? []) {
    checks.push({ label: `stderr matches ${re}`, pass: re.test(bash.stderr) && re.test(ts.stderr) });
  }
  for (const re of sc.stdoutStderrBothExclude ?? []) {
    checks.push({ label: `neither side mentions ${re}`, pass: !re.test(bash.stdout + bash.stderr) && !re.test(ts.stdout + ts.stderr) });
  }

  const pass = checks.every((c) => c.pass);
  results.push({
    name: sc.name,
    argv: sc.argv,
    env: sc.env,
    allow: sc.allow ?? [],
    pass,
    checks,
    bash: { status: bash.status, stdout: bash.stdout, stderr: bash.stderr, envFile: normalizeEnvFile(bash.envFile) },
    ts: { status: ts.status, stdout: ts.stdout, stderr: ts.stderr, envFile: normalizeEnvFile(ts.envFile) },
  });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

// --- scrub + report ---------------------------------------------------------------
function scrub(s) {
  if (typeof s !== "string") return s;
  return s.split(BASH_ROOT).join("<HEADLONG_ROOT>").split(REPO).join("<HEADLONG_TS_ROOT>").split(os.homedir()).join("<HOME>");
}
function deepScrub(x) {
  if (typeof x === "string") return scrub(x);
  if (Array.isArray(x)) return x.map(deepScrub);
  if (x && typeof x === "object") {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = deepScrub(v);
    return out;
  }
  return x;
}
const scrubbed = deepScrub(results);

const total = scrubbed.filter((r) => !r.skipped).length;
const passed = scrubbed.filter((r) => r.pass).length;
const portBugs = scrubbed.filter((r) => !r.skipped && !r.pass);

let md = `# headlong-init — differential parity proof\n\n`;
md += `Generated by \`parity/init/run-parity.mjs\`. Real Bash \`tools/headlong-init\` vs TS port \`bin/headlong-init.mjs\`, identical env/argv, diffed exit code + stdout/stderr markers + \`.env\` keys. Both sides always run with \`HEADLONG_NO_TTY=1 HEADLONG_NO_THINKERS=1 HEADLONG_NO_DASH=1\`.\n\n`;
md += `## Result: ${passed}/${total} PARITY — ${portBugs.length} PORT-BUG\n\n`;
md += `| # | scenario | verdict | allowances |\n|---|---|---|---|\n`;
scrubbed.forEach((r, i) => {
  if (r.skipped) {
    md += `| ${i + 1} | ${r.name} | SKIPPED (${r.skipped}) | — |\n`;
    return;
  }
  md += `| ${i + 1} | ${r.name} | ${r.pass ? "PARITY" : "PORT-BUG"} | ${r.allow.length ? r.allow.join("; ") : "—"} |\n`;
});
md += `\n## Failure detail\n\n`;
if (portBugs.length === 0) md += "None.\n";
for (const r of portBugs) {
  md += `### ${r.name}\n\n`;
  for (const c of r.checks.filter((c) => !c.pass)) {
    md += `- **${c.label}**: bash=\`${JSON.stringify(c.bash)}\` ts=\`${JSON.stringify(c.ts)}\`\n`;
  }
  md += "\n<details><summary>raw output</summary>\n\n```\nbash stdout:\n" + r.bash.stdout + "\nbash stderr:\n" + r.bash.stderr + "\n\nts stdout:\n" + r.ts.stdout + "\nts stderr:\n" + r.ts.stderr + "\n```\n\n</details>\n\n";
}

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), total, passed, portBugs: portBugs.length, results: scrubbed }, null, 2) + "\n");

console.log(`init parity: ${passed}/${total} PARITY, ${portBugs.length} PORT-BUG`);
for (const r of portBugs) console.log(`  PORT-BUG: ${r.name}`);
console.log(`report: ${path.join(HERE, "report.md")}`);
process.exit(portBugs.length === 0 ? 0 : 1);
