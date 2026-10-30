#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the retrieval thinker.
//
// Runs the REAL Bash step (headlong/thinkers/retrieval/step, with the upstream
// bin/ on PATH so it finds the real `traj`) and the TS port
// (headlong-ts/bin/retrieval-step.mjs) over IDENTICAL identity snapshots, driving
// a scripted trigger SEQUENCE through each side (state — index.tsv, seen, the
// trajectory — carries across the steps of a sequence, exactly as in a live
// identity). After every step it diffs: exit code, stdout, stderr, the trajectory
// lines appended by that step (minus step_id/ts, which are fresh per process),
// index.tsv bytes, and the seen file bytes.
//
// Sequences:
//   oracle — the fixtures + steps of tests/test_retrieval_thinker.sh (manual
//            trigger, unrelated, 2-hit, repeat, 1-hit, own-source, message,
//            post-mem-add rebuild, no memories);
//   edges  — the tie-break, C-locale tokenizer, non-string content, run_id
//            auto-link, knobs, semantic suffix (each side's REAL `mem search` →
//            its real `llm` → the replay model server, see below),
//            die paths, and the DOCUMENTED `[[` arithmetic-stderr deviation;
//   awk-v  — its own snapshot (a corrupted index row would pollute every other
//            step's index diff): the DOCUMENTED awk `-v` escape deviation;
//   pax    — the 14 scrubbed pax memories (golden/trace-05-retrieval) replayed
//            with the 4 in-range golden triggers.
//
// Locale pinned LC_ALL=C on both sides (the port implements the C-locale byte
// tokenizer; see PARITY.md for the UTF-8-locale difference, reported below as an
// informational run, not counted).
//
// MODEL LEG (RETRIEVAL_SEMANTIC=1 only): upstream's step runs upstream's real
// bin/mem → bin/llm, the port's step runs the port's bin/mem → bin/llm, both
// pointed by LLM_API_URL at ONE replay server (parity/support/replayModel.mjs)
// serving recorded real DeepSeek replies (parity/retrieval/recordings/<scenario>.json;
// the Bash side records first, the port gets the same bytes) or, for scenarios
// marked `transport`, a labelled HTTP transport fixture (no model text). The
// requests both sides send are diffed too. A recording miss fails the run.
// Re-record: UC_RECORD=1 [UC_RECORD_ONLY=retrieval/<scenario>] with DEEPSEEK_API_KEY
// in the env (never printed or stored). Everything else in this harness is a
// NO-MODEL LAYER: the retrieval step itself makes no model call.
//
// Repeatable: PARITY_BASH_RETRIEVAL=/abs/path/to/headlong/thinkers/retrieval/step
// node parity/retrieval/run-parity.mjs  (the default is a scrubbed placeholder).
// Writes results.json + report.md beside this file. Exit 0 iff every scenario that
// is not a documented deviation reaches PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_STEP = process.env.PARITY_BASH_RETRIEVAL || "<HEADLONG_ROOT>/thinkers/retrieval/step";
const UPSTREAM_ROOT = path.resolve(path.dirname(BASH_STEP), "../..");
const UPSTREAM_BIN = process.env.PARITY_BASH_BIN || path.join(UPSTREAM_ROOT, "bin");
const UPSTREAM_STOPWORDS = path.join(path.dirname(BASH_STEP), "stopwords");
const TS_STEP = path.join(REPO, "bin", "retrieval-step.mjs");
const GOLDEN = path.join(REPO, "golden", "trace-05-retrieval");
const TRAJ_ID = "cafe0000-0000-0000-0000-00000000beef";

if (!fs.existsSync(BASH_STEP)) {
  console.error(`retrieval parity: Bash step not found at ${BASH_STEP} — set PARITY_BASH_RETRIEVAL`);
  process.exit(2);
}

// --- the one replay model server (semantic scenarios) ----------------------------
const { startReplay, REPLAY_MODEL } = await import("../support/replayModel.mjs");
// HTTP TRANSPORT FIXTURES (not model output): a terminal HTTP 400 from the model endpoint, so `mem search` fails
// and the step's `|| sem=""` path drops the suffix.
const TRANSPORT_400 = { status: 400, content_type: "application/json", body: JSON.stringify({ error: { message: "transport fixture: bad request" } }) };
const replay = await startReplay({
  suite: "retrieval",
  dir: path.join(HERE, "recordings"),
  fixtures: { "semantic-transport-http-400": { main: { 0: TRANSPORT_400, 1: TRANSPORT_400, 2: TRANSPORT_400 } } }, // each side: 1 try + llm's 2 default retries
  forwardModel: REPLAY_MODEL,
});
// NO-MODEL platform shim: GNU `timeout` is absent on stock macOS; only installed when the host lacks it.
const SHIMBIN = fs.mkdtempSync(path.join(os.tmpdir(), "retr-parity-bin-"));
if (spawnSync("sh", ["-c", "command -v timeout"]).status !== 0) {
  fs.writeFileSync(path.join(SHIMBIN, "timeout"), `#!/usr/bin/env bash\n# GNU timeout stand-in (absent on stock macOS): drop the duration, exec the command.\nshift; exec "$@"\n`);
  fs.chmodSync(path.join(SHIMBIN, "timeout"), 0o755);
}

// --- helpers ---------------------------------------------------------------------
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function readOr(p, dflt) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return dflt;
  }
}
function memFile(dir, name, id, summary, body) {
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nid: ${id}\nsummary: ${summary}\ntype: fact\n---\n${body}\n`);
}
// A memory written just before a step (mtime newer than the index → rebuild), so the step has an UNSEEN memory to
// surface. Upstream's seen check greps the whole seen file, so a memory surfaced earlier in the sequence stays
// blocked whatever RETRIEVAL_SEEN says; before this, the steps using it surfaced nothing on either side.
const freshMemory = (name, id, summary, body) => (sb) => {
  sleepMs(1100);
  memFile(sb.memDir, name, id, summary, body);
};
const stepJson = (type, n, content, extra = {}) => JSON.stringify({ type, step_id: `s-${n}`, content, ...extra });

// --- sandboxes -------------------------------------------------------------------
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retr-parity-sb-"));
  const id = path.join(root, "ident");
  fs.mkdirSync(path.join(id, "memories"), { recursive: true });
  fs.mkdirSync(path.join(id, "trajectories", TRAJ_ID), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(id, "info.txt"), `name=testid\ncreated=test\nroot_trajectory=${TRAJ_ID}\n`);
  fs.writeFileSync(path.join(id, "trajectories", TRAJ_ID, "trajectory.jsonl"), "");
  return { root, id, memDir: path.join(id, "memories"), traj: path.join(id, "trajectories", TRAJ_ID, "trajectory.jsonl") };
}
function baseEnv(sb) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("RETRIEVAL_") || k === "SHELLM_RUN_STEP_ID" || k === "IDENTITY_DIR" || k === "MEM_DIR" || k === "TRAJ_DIR" || k === "TRAJ_ID") delete env[k];
  }
  return {
    ...env,
    LC_ALL: "C",
    PATH: `${SHIMBIN}:${UPSTREAM_BIN}:${env.PATH}`,
    HOME: path.join(sb.root, "home"),
    IDENTITY_DIR: sb.id,
    IDENTITY_NAME: "testid",
    MEM_DIR: sb.memDir,
    TRAJ_DIR: path.join(sb.id, "trajectories"),
    TRAJ_ID,
    SKILLS_DIR: path.join(sb.id, "skills"),
    SKILLS_KERNEL_DIR: path.join(sb.id, "kernel"),
  };
}

/** Run one step (bash or ts) in a sandbox; return the observable delta. */
async function runStep(kind, sb, sc) {
  const env = baseEnv(sb);
  if (sc.model) {
    // Each side's own real mem + llm (the port's bin/ first for the port), routed to the replay server.
    const side = kind === "bash" ? "upstream" : "port";
    if (kind === "ts") env.PATH = `${path.join(REPO, "bin")}:${env.PATH}`;
    Object.assign(env, { LLM_PROVIDER: "openai-compatible", LLM_API_URL: replay.url(sc.name, side), LLM_API_KEY: "replay-not-a-key", LLM_RETRY_BACKOFF: "0", SHELLM_FAST_MODEL: REPLAY_MODEL });
  }
  for (const [k, v] of Object.entries(sc.env || {})) {
    if (v === undefined) delete env[k];
    else env[k] = String(v).replace("<SB>", sb.root);
  }
  const before = readOr(sb.traj, "").split("\n").filter((l) => l !== "").length;
  // Async: the replay server lives in this process, so a blocking spawnSync would starve it.
  const res = await new Promise((resolve) => {
    const child = spawn(kind === "bash" ? BASH_STEP : "node", kind === "bash" ? [] : [TS_STEP], { env, cwd: sb.root });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(sc.stdin ?? "");
  });
  const after = readOr(sb.traj, "").split("\n").filter((l) => l !== "");
  const appended = after.slice(before).map((l) => {
    const o = JSON.parse(l);
    delete o.step_id;
    delete o.ts;
    return JSON.stringify(o);
  });
  const indexFile = (sc.env && sc.env.RETRIEVAL_INDEX ? sc.env.RETRIEVAL_INDEX.replace("<SB>", sb.root) : path.join(sb.id, "retrieval", "index.tsv"));
  // No absolute local paths in the committed report: sandbox, repo, upstream, tmp.
  const scrubSb = (s) =>
    s == null
      ? s
      : s.split(sb.root).join("<SB>").split(REPO).join("<REPO>").split(UPSTREAM_ROOT).join("<HEADLONG_ROOT>").split(os.tmpdir()).join("<TMP>");
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: scrubSb(res.stderr ?? ""),
    appended,
    index: readOr(indexFile, "<absent>"),
    seen: readOr(path.join(path.dirname(indexFile), "seen"), "<absent>"),
  };
}

// --- sequences -------------------------------------------------------------------
const seedOracle = (sb) => {
  memFile(sb.memDir, "20260801_aaaa_colima", "aaaa1111", "docker on this mac is colima", "Bind mounts silently fail for paths colima does not mount. Only home and tmp are mounted.");
  memFile(sb.memDir, "20260802_bbbb_pager", "bbbb2222", "short git output vanishes in the pager", "The LESS variable lacks -X so paged git output disappears when less exits.");
};

const sequences = [
  {
    name: "oracle",
    seed: seedOracle,
    steps: [
      { name: "manual-trigger-upstream-payload", stdin: '{"type":"manual-trigger","source":"thinkers-cli","ts":"2026-08-28T16:00:00Z"}', note: "boot kick, no content → no-op; index not even built" },
      { name: "manual-trigger-port-payload", stdin: '{"type":"manual-trigger","content":"manual trigger","source":"thinkers-cli"}', note: "the port dispatcher's boot payload carries content; no memory shares both words" },
      { name: "unrelated-thought", stdin: stepJson("thought", 1, "Thinking about the weather and lunch plans today."), note: "index built, nothing appended" },
      { name: "two-hit-thought", stdin: stepJson("thought", 2, "Why does the docker bind mount of this path silently fail on colima?"), note: "aaaa1111 surfaces, trigger_step s-2" },
      { name: "repeat-blocked-by-seen", stdin: stepJson("thought", 3, "Still fighting colima docker mounts that fail silently.") },
      { name: "one-hit-below-threshold", stdin: stepJson("thought", 4, "I should read the output carefully.") },
      { name: "own-source-ignored", stdin: stepJson("observation", 5, "I'm reminded of memory bbbb2222: short git output vanishes in the pager", { source: "retrieval" }) },
      { name: "message-second-memory", stdin: stepJson("message", 6, "my git log output vanishes as soon as the pager exits"), note: "bbbb2222 via a message trigger" },
      {
        name: "post-mem-add-rebuild",
        before: (sb) => {
          sleepMs(1100); // mtime resolution: the new memory must be newer than the index
          memFile(sb.memDir, "20260803_cccc_snap", "cccc3333", "snap aws cli redirect writes empty files", "On the box the snap aws cli writes zero bytes when stdout is redirected to a file; pipe through cat.");
        },
        stdin: stepJson("thought", 7, "the snap aws cli wrote an empty file again after the redirect"),
        note: "index rebuilt → cccc3333",
      },
      {
        name: "no-memories",
        before: (sb) => {
          for (const f of fs.readdirSync(sb.memDir)) if (f.endsWith(".md")) fs.rmSync(path.join(sb.memDir, f));
        },
        stdin: stepJson("thought", 8, "colima docker mount"),
        note: "exit 0, no append; stale index + seen left in place",
      },
    ],
  },
  {
    name: "edges",
    seed: (sb) => {
      seedOracle(sb);
      memFile(sb.memDir, "20260804_tie1", "aaaa0001", "tie one", "alpha beta shared");
      memFile(sb.memDir, "20260804_tie2", "bbbb0002", "tie two", "alpha beta shared");
      memFile(sb.memDir, "20260805_caf", "cafe0005", "cafe words", "caf sum tokens");
      memFile(sb.memDir, "20260806_num", "1234abcd", "numbers", "12345 67890 digits");
    },
    steps: [
      { name: "tie-equal-hits", stdin: stepJson("thought", 1, "alpha beta gamma"), note: "equal hits (2) on aaaa0001/bbbb0002 → greatest id wins on both sides (PORT-NOTE tie-break)" },
      { name: "non-ascii-c-locale", stdin: stepJson("thought", 2, "Café résumé"), note: "LC_ALL=C: 'caf' + 'sum' → cafe0005 (2 hits); a UTF-8 locale would drop both words — informational run below" },
      { name: "numeric-content", stdin: '{"type":"thought","step_id":"s-3","content":12345}', note: "jq -r prints the number; one word only → no-op" },
      { name: "object-content", stdin: '{"type":"thought","step_id":"s-4","content":{"a":"12345 67890"}}', note: "jq -r pretty JSON; tokens 12345/67890 → 1234abcd" },
      { name: "step-id-number", stdin: '{"type":"message","step_id":42,"content":"git output vanishes in the pager"}', note: "trigger_step \"42\"" },
      { name: "no-step-id", stdin: '{"type":"thought","content":"colima docker mount"}', note: "trigger_step omitted" },
      { name: "run-id-autolink", before: freshMemory("20260810_run", "a1a1a1a1", "rebase conflicts in lockfiles", "Regenerate lockfiles after a rebase conflict instead of merging them by hand."), env: { SHELLM_RUN_STEP_ID: "run-0966d708", RETRIEVAL_SEEN: "1" }, stdin: stepJson("thought", 5, "another rebase conflict in the lockfiles"), note: "run_id stamped before step_id/ts (a fresh memory a1a1a1a1 surfaces)" },
      { name: "min-hits-1", before: freshMemory("20260811_one", "b2b2b2b2", "zstd beats gzip here", "Compression notes."), env: { RETRIEVAL_MIN_HITS: "1", RETRIEVAL_SEEN: "1" }, stdin: stepJson("thought", 6, "zstd is neat"), note: "a single shared word surfaces a fresh memory b2b2b2b2" },
      { name: "index-override", env: { RETRIEVAL_INDEX: "<SB>/alt/deep/words.tsv" }, stdin: stepJson("thought", 7, "colima docker mount"), note: "index + seen beside it under the override path" },
      { name: "semantic-suffix", model: true, before: freshMemory("20260812_k8s", "c3c3c3c3", "pods evicted under node memory pressure", "Kubernetes evicts pods when the node runs low on memory; set requests."), env: { RETRIEVAL_SEMANTIC: "1" }, stdin: stepJson("thought", 8, "why were my kubernetes pods evicted again"), note: "real mem search → real llm → recorded DeepSeek reply: ' | mem search: ' + up to 3 lines" },
      { name: "semantic-transport-http-400", model: true, before: freshMemory("20260813_nginx", "d4d4d4d4", "nginx proxy buffering stalls streams", "Turn off proxy_buffering for server-sent events behind nginx."), env: { RETRIEVAL_SEMANTIC: "1" }, stdin: stepJson("thought", 10, "nginx proxy buffering stalls my event streams"), note: "HTTP transport fixture (400, no model text): mem search fails → no suffix" },
      { name: "semantic-off-not-1", before: freshMemory("20260814_tz", "e5e5e5e5", "cron runs in UTC on the box", "The box cron daemon uses UTC, not local time."), env: { RETRIEVAL_SEMANTIC: "true" }, stdin: stepJson("thought", 9, "cron fired at the wrong time in UTC"), note: "gated on exactly 1" },
      { name: "empty-stdin", stdin: "" },
      { name: "invalid-json", stdin: "{nope" },
      { name: "json-array", stdin: '[{"content":"colima docker mount"}]' },
      { name: "content-null", stdin: '{"type":"thought","content":null}' },
      { name: "env-missing-TRAJ_ID", env: { TRAJ_ID: undefined }, stdin: stepJson("thought", 10, "colima docker mount"), note: "exit 1 + thinker: error: TRAJ_ID not set" },
      { name: "env-missing-MEM_DIR-empty", env: { MEM_DIR: "" }, stdin: stepJson("thought", 11, "colima docker mount") },
      {
        name: "min-hits-non-integer",
        env: { RETRIEVAL_MIN_HITS: "1.5", RETRIEVAL_SEEN: "1" },
        stdin: stepJson("thought", 12, "colima docker mount"),
        documented: "Bash `[[ $hits -ge 1.5 ]]` prints `<script>: line 60: [[: 1.5: arithmetic syntax error …` on stderr (text embeds the script's absolute path + a Bash line number), the test is false → exit 0; the port exits 0 silently. Same class as the `${2:?}` deviation — PARITY.md",
      },
    ],
  },
  {
    name: "awk-v",
    seed: (sb) => {
      seedOracle(sb);
      memFile(sb.memDir, "20260807_bslash", "b5b5b5b5", "path C:\\temp\\new dir", "backslash quirk words");
    },
    steps: [
      {
        name: "awk-v-backslash-summary",
        stdin: stepJson("thought", 1, "backslash quirk"),
        documented: "awk -v escape interpretation: Bash turns the summary's \\t into a TAB (and \\n into a newline) INSIDE the index row — the row splits, and the observation's summary is cut at the interpreted tab (`path C:`); the port keeps the bytes verbatim — PARITY.md",
      },
    ],
  },
  {
    name: "pax",
    seed: (sb) => {
      for (const f of fs.readdirSync(path.join(GOLDEN, "memories"))) {
        if (f.endsWith(".md")) fs.copyFileSync(path.join(GOLDEN, "memories", f), path.join(sb.memDir, f));
      }
      fs.mkdirSync(path.join(sb.id, "retrieval"), { recursive: true });
      fs.writeFileSync(path.join(sb.id, "retrieval", "seen"), "9096b22d\n"); // the probe (row 676) had surfaced it
    },
    steps: (() => {
      const rows = fs
        .readFileSync(path.join(GOLDEN, "trajectory-rows-676-856.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l));
      const byId = new Map(rows.map((r) => [r.step_id, r]));
      return rows
        .filter((r) => r.source === "retrieval" && byId.has(r.trigger_step))
        .map((r, i) => ({ name: `golden-trigger-${i + 1}-${r.retrieved_mem}`, stdin: JSON.stringify(byId.get(r.trigger_step)), note: `pax row → ${r.retrieved_mem}` }));
    })(),
  },
];

// --- execute --------------------------------------------------------------------------
const results = [];
for (const seq of sequences) {
  const sbBash = makeSandbox();
  const sbTs = makeSandbox();
  try {
    seq.seed(sbBash);
    seq.seed(sbTs);
    for (const sc of seq.steps) {
      if (sc.before) {
        sc.before(sbBash);
        sc.before(sbTs);
      }
      const bash = await runStep("bash", sbBash, sc);
      const ts = await runStep("ts", sbTs, sc);
      const cmp = {
        status: bash.status === ts.status,
        stdout: bash.stdout === ts.stdout,
        stderr: bash.stderr === ts.stderr,
        appended: JSON.stringify(bash.appended) === JSON.stringify(ts.appended),
        index: bash.index === ts.index,
        seen: bash.seen === ts.seen,
      };
      if (sc.model) {
        // The model request each side's real mem + llm sent (messages and model), diffed too.
        const reqs = (side) => JSON.stringify(replay.requests(sc.name, side).map((r) => ({ model: r.body.model, messages: r.body.messages })));
        cmp.modelRequest = reqs("upstream") === reqs("port") && replay.requests(sc.name, "port").length > 0;
        bash.modelRequests = JSON.parse(reqs("upstream"));
        ts.modelRequests = JSON.parse(reqs("port"));
      }
      const pass = Object.values(cmp).every(Boolean);
      results.push({ sequence: seq.name, name: sc.name, note: sc.note, documented: sc.documented, pass, cmp, bash, ts });
    }
  } finally {
    fs.rmSync(sbBash.root, { recursive: true, force: true });
    fs.rmSync(sbTs.root, { recursive: true, force: true });
  }
}

// --- informational: the UTF-8-locale tokenizer difference (Bash only) -------------------
let utf8Info = "";
{
  const sb = makeSandbox();
  try {
    memFile(sb.memDir, "20260805_caf", "cafe0005", "cafe words", "caf sum tokens");
    const env = { ...baseEnv(sb), LC_ALL: "en_US.UTF-8" };
    const res = spawnSync(BASH_STEP, [], { env, input: stepJson("thought", 1, "Café résumé"), encoding: "utf8", timeout: 30000 });
    const appended = readOr(sb.traj, "").split("\n").filter((l) => l !== "").length;
    utf8Info = `Bash under LC_ALL=en_US.UTF-8 on "Café résumé": exit ${res.status}, ${appended} observation(s) appended (C locale: 1). ` +
      (appended === 0 ? "Confirms the documented locale difference: a UTF-8 locale keeps 'café'/'résumé' whole and then drops them." : "No difference observed on this system's locale tables.");
  } finally {
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
}

// --- stopwords asset byte-check ----------------------------------------------------------
const stopwordsSame = fs.readFileSync(UPSTREAM_STOPWORDS).equals(fs.readFileSync(path.join(REPO, "src/assets/retrieval/stopwords")));

fs.rmSync(SHIMBIN, { recursive: true, force: true });
await replay.close();

// --- report ----------------------------------------------------------------------------
const counted = results.filter((r) => !r.documented);
const documented = results.filter((r) => r.documented);
const passed = counted.filter((r) => r.pass).length;
const total = counted.length;
const rate = ((passed / total) * 100).toFixed(1);

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# retrieval thinker — differential parity proof\n\n`;
md += `Generated by \`parity/retrieval/run-parity.mjs\`. Real Bash step \`headlong/thinkers/retrieval/step\` (upstream \`bin/\` on PATH for \`traj\`) vs TS port \`headlong-ts/bin/retrieval-step.mjs\`, identical identity snapshots, scripted trigger sequences; after every step diffed exit code + stdout + stderr + appended trajectory lines (minus step_id/ts) + index.tsv bytes + seen bytes.\n\n`;
md += `- Run: \`PARITY_BASH_RETRIEVAL=…/headlong/thinkers/retrieval/step node parity/retrieval/run-parity.mjs\` (Node ≥22.18). Locale pinned \`LC_ALL=C\` both sides.\n`;
md += `- Semantic scenarios: each side's REAL \`mem search\` and \`llm\` against one replay server (\`parity/support/replayModel.mjs\`) serving recorded real DeepSeek replies (\`parity/retrieval/recordings/\`) or a labelled HTTP transport fixture; the model requests are diffed too. Every other scenario is a no-model layer. GNU \`timeout\` is shimmed only on hosts without it.\n`;
md += `- Stopword asset byte-equal to upstream: **${stopwordsSame ? "yes" : "NO"}**.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%) — plus ${documented.length} documented-deviation scenario(s) reported below, not counted\n\n`;
md += `| # | sequence | scenario | verdict | fields differing | note |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
  const verdict = r.documented ? (r.pass ? "PARITY (deviation not hit)" : "DOCUMENTED DEVIATION") : r.pass ? "PARITY" : "MISMATCH";
  md += `| ${idx++} | ${r.sequence} | ${r.name} | ${verdict} | ${diffs} | ${r.note ?? r.documented ?? ""} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = counted.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of [...fails, ...documented.filter((d) => !d.pass)]) {
  md += `### ${r.sequence} / ${r.name}${r.documented ? " (documented deviation)" : ""}\n`;
  if (r.note) md += `- note: ${r.note}\n`;
  if (r.documented) md += `- why: ${r.documented}\n`;
  md += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  md += "```\n";
  md += block("stdout", r.bash.stdout, r.ts.stdout, r.cmp.stdout) + "\n";
  md += block("stderr", r.bash.stderr, r.ts.stderr, r.cmp.stderr) + "\n";
  md += block("appended", r.bash.appended, r.ts.appended, r.cmp.appended) + "\n";
  md += block("index", r.bash.index, r.ts.index, r.cmp.index) + "\n";
  md += block("seen", r.bash.seen, r.ts.seen, r.cmp.seen) + "\n";
  if ("modelRequest" in r.cmp) md += block("modelRequest", r.bash.modelRequests, r.ts.modelRequests, r.cmp.modelRequest) + "\n";
  md += "```\n\n";
}
md += `## Interpretation\n\n`;
md += `- **Tie-break** (\`edges/tie-equal-hits\`): Bash's \`sort -rn | head -1\` breaks equal hits by the reversed last-resort byte order of the whole \`hits\\tmid\\tsummary\` line — on this system's \`sort\` that is "greatest id first", which is the rule the port pins (highest hits, then greatest id, then greatest summary). PARITY here; the PORT-NOTE + PARITY.md row exist because a \`sort -s\` or a collating locale would leave Bash to awk's hash order instead.\n`;
md += `- **Locale**: ${utf8Info}\n`;
md += `- **awk -v escapes** (\`awk-v/awk-v-backslash-summary\`): a backslash sequence in a memory's \`summary:\` line is interpreted by \`awk -v s="$summary"\` when Bash writes the index row (\`\\t\` → TAB splits the row's fields, \`\\n\` → newline splits the row; the surfaced summary is cut at the tab); the port writes the bytes verbatim. Documented deviation (Bash artifact), reported and not counted.\n`;
md += `- **\`[[ -ge ]]\` on a non-integer knob** (\`edges/min-hits-non-integer\`): Bash prints an arithmetic-syntax-error line naming the script's absolute path and line number, then exits 0 (the test is false); the port exits 0 silently. Exit code, stdout, and state match — stderr wording only, the same class as the documented \`\${2:?}\` deviation. Reported and not counted.\n`;
md += `- Everything else — every no-op path's silence and exit 0, the die paths' exit 1 + message, the verbatim observation content and field order, run_id auto-link, index.tsv and seen bytes, the stale index left after \`rm\`, the knobs, the semantic suffix — is byte-identical.\n`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(
  path.join(HERE, "results.json"),
  JSON.stringify({ total, passed, rate, documented: documented.length, stopwordsSame, utf8Info, results }, null, 2)
);

console.log(`retrieval parity: ${passed}/${total} (${rate}%)  documented-deviation scenarios: ${documented.length}  stopwords byte-equal: ${stopwordsSame}`);
for (const r of results) {
  if (!r.pass) {
    const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
    console.log(`  ${r.documented ? "DOCUMENTED" : "MISMATCH"} ${r.sequence}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
  }
}
console.log(`  ${utf8Info}`);
replay.verify(); // a recording miss fails loudly (after the report is written, so it can be inspected)
process.exit(passed === total && stopwordsSame ? 0 : 1);
