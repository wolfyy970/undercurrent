#!/usr/bin/env node
// parity/execlines/run-parity.mjs — differential harness for the TEXT bash prints
// when the model's block fails (error messages carry "line N:"), i.e. for how the
// port wraps and launches the model's code vs upstream's bin/shellm.
//
// Oracle = upstream's REAL bin/shellm run end to end (SHELLM_ENV=local) with its REAL bin/llm. The port's runShellm
// (LocalSandbox) runs with its production client (LlmCliClient, the port's `llm`). Both sides reach the model through
// LLM_API_URL on ONE replay server (parity/support/replayModel.mjs) that serves the same recorded real DeepSeek replies
// (parity/execlines/recordings/, labelled with source, date and model) to each. The model is asked to run the
// scenario's block verbatim; a recording whose first block is not that code is reported (MODEL-CHANGED). We diff the
// recorded `shell-output` step (stdout text + exit) of each. Expectations come from
// running upstream, never from the port. Scenarios: unknown command and syntax error
// in multi-line blocks, $LINENO, an unterminated `if` (error at EOF, which also pins the
// wrapper's TRAILING shape), a heredoc before the failure.
//
//   PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/execlines/run-parity.mjs
//   (re-record: UC_RECORD=1 [UC_RECORD_ONLY='execlines/<scenario>'] DEEPSEEK_API_KEY=… …)
//
// Exit 0 when every scenario is byte-identical; 1 on DIVERGE; 2 if upstream is missing.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const UP = process.env.PARITY_UPSTREAM_ROOT;
if (!UP || !fs.existsSync(path.join(UP, "bin/shellm"))) {
  console.error("execlines parity: set PARITY_UPSTREAM_ROOT=/path/to/upstream headlong checkout");
  process.exit(2);
}
const { runShellm } = await import(pathToFileURL(path.join(ROOT, "src/shellm.ts")).href);
const { createTrajectory } = await import(pathToFileURL(path.join(ROOT, "src/trajectory.ts")).href);
const { LocalSandbox } = await import(pathToFileURL(path.join(ROOT, "src/sandbox.ts")).href);
const { LlmCliClient } = await import(pathToFileURL(path.join(ROOT, "src/llmCliClient.ts")).href);
const { startReplay, replyText, REPLAY_MODEL } = await import(pathToFileURL(path.join(ROOT, "parity/support/replayModel.mjs")).href);
// upstream's run-summary call (bin/shellm:2443) is its own channel; the port's runShellm never makes it.
const replay = await startReplay({
  suite: "execlines",
  dir: path.join(HERE, "recordings"),
  channelOf: (b) => (JSON.stringify(b.messages ?? []).includes("You produce concise summaries as JSON") ? "summary" : "main"),
});
const taskFor = (code) =>
  "Run exactly this bash code as your first and only code block, character for character, with nothing added or changed:\n\n" +
  fence(code) +
  "\nAfter it has run, whatever its output, reply with a bash block containing only: FINAL=done";
const firstBlock = (t) => (/```bash\n([\s\S]*?)\n```/.exec(t) ?? [])[1];

const fence = (c) => "```bash\n" + c + "\n```\n";
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execlines-parity-")));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

const SCENARIOS = [
  { name: "unknown-command-line-2", code: "echo one\nno_such_cmd_q arg\necho three" },
  { name: "unknown-command-line-1", code: "no_such_cmd_q arg\necho two" },
  { name: "unknown-command-line-5", code: "echo a\necho b\necho c\necho d\nno_such_cmd_q" },
  { name: "syntax-error-mid-script", code: "echo one\necho two\nif then fi\necho four" },
  { name: "syntax-error-unexpected-token", code: "echo one\nfoo ) bar\necho three" },
  { name: "unterminated-if-eof", code: "echo one\nif true; then\n  echo two" },
  { name: "unterminated-quote-eof", code: "echo one\necho 'two\nthree" },
  { name: "lineno-printed", code: "echo $LINENO\n\necho $LINENO\necho $LINENO" },
  { name: "heredoc-then-unknown", code: "cat <<'X'\nh1\nh2\nX\nno_such_cmd_q" },
  { name: "function-body-error", code: "f() {\n  no_such_cmd_q\n}\necho start\nf" },
  { name: "set-e-false-exit", code: "echo one\nfalse\necho unreachable" },
  { name: "stderr-redirect-error-line", code: "echo a\nls /definitely/not/here_q\necho c" },
];

function trajShellOutputs(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((s) => s.type === "shell-output")
    .map((s) => ({ stdout: String(s.stdout ?? ""), exit: s.exit }));
}

function findTraj(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findTraj(p);
      if (r) return r;
    } else if (e.name.endsWith(".jsonl")) return p;
  }
  return null;
}


async function runUpstream(sc, i) {
  const w = path.join(work, `up-${i}`);
  for (const d of ["home", "wd"]) fs.mkdirSync(path.join(w, d), { recursive: true });
  fs.cpSync(path.join(UP, "bin"), path.join(w, "toolbin"), { recursive: true });
  // Async spawn: the replay server lives in this process and must keep answering while upstream runs.
  const r = await new Promise((resolve) => {
    const c = spawn("bash", [path.join(w, "toolbin/shellm"), "--workdir", path.join(w, "wd"), "--max-iterations", "3", taskFor(sc.code)], {
      cwd: path.join(w, "wd"),
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: `${path.join(w, "toolbin")}:${process.env.PATH}`,
        HOME: path.join(w, "home"),
        HEADLONG_HOME: path.join(w, "home/.headlong"),
        LLM_PROVIDER: "openai-compatible",
        LLM_API_URL: replay.url(sc.name, "upstream"),
        LLM_API_KEY: "replay-not-a-key",
        LLM_RETRY_BACKOFF: "0",
        SHELLM_MODEL: REPLAY_MODEL,
        SHELLM_ENV: "local",
      },
    });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 120_000);
    c.on("close", () => (clearTimeout(t), resolve({ stderr })));
  });
  const tf = findTraj(path.join(w, "home/.headlong/trajectories"));
  if (!tf) throw new Error(`upstream produced no trajectory for ${sc.name}: ${r.stderr}`);
  return trajShellOutputs(tf)[0];
}

async function runPort(sc, i) {
  const root = path.join(work, `port-${i}`);
  const workdir = path.join(root, "wd");
  fs.mkdirSync(workdir, { recursive: true });
  const traj = createTrajectory(path.join(root, "traj"));
  const llm = new LlmCliClient({
    mode: "shellm",
    model: REPLAY_MODEL,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LLM_PROVIDER: "openai-compatible", LLM_API_URL: replay.url(sc.name, "port"), LLM_API_KEY: "replay-not-a-key", LLM_RETRY_BACKOFF: "0" },
  });
  await runShellm({
    trajectory: traj,
    llm,
    sandbox: new LocalSandbox(),
    systemPrompt: "system",
    prompt: taskFor(sc.code),
    workdir,
    binDir: "/nonexistent/bin",
    // Same PATH as the upstream run, so BOTH sides resolve the same `bash` (macOS /bin/bash 3.2 and a
    // newer bash number `-c` lines differently; a harness that let the port fall back to the default
    // system PATH compared two different bashes and hid this very bug).
    execEnv: { PATH: process.env.PATH ?? "" },
    header: { command: "shellm", model: REPLAY_MODEL, effort: "high", maxTokens: "", env: { name: "t", type: "local" }, resumed: false },
    sleep: async () => {},
    io: { stdout() {}, stderr() {} },
  });
  return trajShellOutputs(traj.trajFile)[0];
}

console.log(`bash: ${spawnSync("bash", ["-c", 'printf %s "$BASH_VERSION"'], { encoding: "utf8" }).stdout}`);
let diverge = 0;
const rows = [];
for (const [i, sc] of SCENARIOS.entries()) {
  const up = await runUpstream(sc, i);
  const port = await runPort(sc, i);
  const main = replay.recording(sc.name).channels.main ?? [];
  const block1 = main[0] ? firstBlock(replyText(main[0].response.body)) : undefined;
  if (block1 !== sc.code) console.log(`MODEL-CHANGED ${sc.name}: the recorded first block is ${JSON.stringify(block1)}`);
  if (!up || !port) {
    diverge++;
    rows.push({ scenario: sc.name, same: false, upstream: up ?? null, port: port ?? null });
    console.log(`DIVERGE ${sc.name} (no shell-output: upstream=${!!up} port=${!!port})`);
    continue;
  }
  // Normalisation: (1) each side's own temp dir; (2) trailing newlines of the recorded stdout.
  // Upstream's `output=$(cat "$output_file")` (bin/shellm:3286) strips them, the port's recorded
  // shell-output keeps one (a trajectory-text difference, "stdout text" is off the frozen surface; the
  // model-facing observation is proven byte-identical by the box gapcheck, REPORT.md finding 1).
  // Everything else, including every "line N:" number, must match exactly.
  const norm = (o, dirs) => ({ ...o, stdout: dirs.reduce((s, d) => s.split(d).join("<W>"), o.stdout).replace(/\n+$/, "") });
  const a = norm(up, [path.join(work, `up-${i}`)]);
  const b = norm(port, [path.join(work, `port-${i}`)]);
  const same = a.stdout === b.stdout && a.exit === b.exit;
  if (!same) diverge++;
  rows.push({ scenario: sc.name, same, upstream: a, port: b });
  console.log(`${same ? "PARITY " : "DIVERGE"} ${sc.name}`);
  if (!same) console.log(`   upstream: exit=${a.exit} ${JSON.stringify(a.stdout)}\n   port:     exit=${b.exit} ${JSON.stringify(b.stdout)}`);
}
console.log(`\n${rows.length - diverge}/${rows.length} scenarios byte-identical`);
await replay.close();
if (replay.misses.length) {
  console.log(`replay misses (${replay.misses.length}):\n  ${replay.misses.join("\n  ")}`);
  diverge = diverge || 1;
}
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total: rows.length, diverged: diverge, rows }, null, 2) + "\n");
process.exit(diverge ? 1 : 0);
