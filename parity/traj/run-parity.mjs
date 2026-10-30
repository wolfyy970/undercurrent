#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `traj` CLI.
//
// Runs the REAL Bash tool (headlong/bin/traj) and the TS port
// (headlong-ts/bin/traj.mjs) on identical inputs in isolated scratch
// sandboxes, then diffs stdout + stderr + exit code + on-disk effects. One
// scenario per subcommand / flag / error path, harvested from the Bash
// source (bin/traj:26-2186).
//
// Fixture trajectories are seeded with real content from golden/trace-00
// (the boot+convo replay's first steps) re-stamped with FIXED, deterministic
// step_id/ts values so both sides see byte-identical input — this makes most
// read-path scenarios (show/tail/cat/search/list/root/count/exists/path/
// check) directly byte-comparable with no normalization beyond the sandbox
// path prefix. Only the write-generating commands (new/append/fork/merge/
// check --fix) mint their own UUID/timestamp each run; those are normalized
// SYMMETRICALLY on both sides before comparison:
//   <sandbox abs path>                          -> <SANDBOX>
//   a UUID (8-4-4-4-12 hex)                      -> <UUID>
//   an ISO-8601 UTC ms timestamp                 -> <TS>
//   a bare 8-hex-char run (dir-name hex8 prefix) -> <HEX8>
// Everything else (structure, types, field names, ordering, exit codes,
// error text) is compared exactly.
//
// Repeatable: `node parity/traj/run-parity.mjs`. Writes results.json +
// report.md beside this file. Exit 0 iff every scenario reaches PARITY or is
// a classified documented deviation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Path to the real Bash tool. Scrubbed to a placeholder for release; set
// PARITY_BASH_TRAJ=/abs/path/to/headlong/bin/traj to reproduce the run, or
// PARITY_UPSTREAM_ROOT=/abs/path/to/headlong (a full checkout) as a fallback.
const BASH_TRAJ =
  process.env.PARITY_BASH_TRAJ ||
  (process.env.PARITY_UPSTREAM_ROOT ? path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/traj") : "<HEADLONG_ROOT>/bin/traj");
const TS_TRAJ = path.join(REPO, "bin", "traj.mjs");

// --- golden content (golden/trace-00) -----------------------------------------
// Real thought steps from the boot+convo replay, re-stamped with fixed ids.
const GOLDEN_FILE = path.join(REPO, "golden", "trace-00-boot-and-convo.jsonl");
function loadGoldenThoughts(n) {
  const lines = fs.readFileSync(GOLDEN_FILE, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out.length >= n) break;
    const obj = JSON.parse(line);
    if (obj.type === "thought") out.push(obj.content);
  }
  return out;
}
const GOLDEN_THOUGHTS = loadGoldenThoughts(6);

// --- normalization ------------------------------------------------------------
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalize(s, sbBash, sbTs) {
  if (s == null) return s;
  let out = s;
  out = out.split(sbBash).join("<SANDBOX>");
  out = out.split(sbTs).join("<SANDBOX>");
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TS>");
  out = out.replace(/\b[0-9a-f]{8}\b/g, "<HEX8>");
  return out;
}
void escapeRe;

// --- on-disk state serialization ----------------------------------------------
function walk(dir, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.endsWith(".lock")) continue; // transient lock dirs
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else acc.push({ rel, content: fs.readFileSync(full, "utf8") });
  }
}
function serializeState(rootAbs) {
  if (!fs.existsSync(rootAbs)) return "<no traj_dir>";
  const acc = [];
  walk(rootAbs, "", acc);
  if (acc.length === 0) return "<empty traj_dir>";
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

// --- fixture construction ------------------------------------------------------
// A "flat" fixture: <sb>/traj/<hex8>-<slug>/trajectory.jsonl seeded with
// literal, deterministic lines (no generation involved, so both sides get
// byte-identical input).
function line(obj) {
  return JSON.stringify(obj);
}

function rootRecord(id, ts, extra = {}) {
  return line({ type: "trajectory", ...extra, step_id: id, ts });
}

const ROOT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const STEP_IDS = [
  "aaaaaaaa-1111-4000-8000-000000000011",
  "aaaaaaaa-2222-4000-8000-000000000012",
  "aaaaaaaa-3333-4000-8000-000000000013",
  "aaaaaaaa-4444-4000-8000-000000000014",
];

function baseFixtureLines() {
  return [
    rootRecord(ROOT_ID, "2026-08-28T10:00:00.000Z"),
    line({ type: "thought", content: GOLDEN_THOUGHTS[0], step_id: STEP_IDS[0], ts: "2026-08-28T10:00:01.000Z" }),
    line({
      type: "reasoning",
      thought: GOLDEN_THOUGHTS[1],
      cmd: "traj search RLM",
      step_id: STEP_IDS[1],
      ts: "2026-08-28T10:00:02.000Z",
      source: "monolith",
    }),
    line({ type: "shell-output", stdout: GOLDEN_THOUGHTS[2], step_id: STEP_IDS[2], ts: "2026-08-28T10:00:03.000Z" }),
    line({
      type: "observation",
      content: GOLDEN_THOUGHTS[3],
      step_id: STEP_IDS[3],
      ts: "2026-08-28T10:00:04.000Z",
      source: "monolith",
    }),
  ];
}

function forkFixtureLines() {
  return [
    line({ type: "fork", child: CHILD_ID, child_ref: `${CHILD_ID.slice(0, 8)}-child/trajectory.jsonl`, step_id: "cccccccc-0000-4000-8000-000000000099", ts: "2026-08-28T10:00:05.000Z" }),
  ];
}

function childFixtureLines() {
  return [
    rootRecord(CHILD_ID, "2026-08-28T10:00:06.000Z", { parent_traj: ROOT_ID, parent_traj_ref: ".." }),
    line({ type: "thought", content: GOLDEN_THOUGHTS[4], step_id: "bbbbbbbb-1111-4000-8000-000000000021", ts: "2026-08-28T10:00:07.000Z" }),
  ];
}

// --- same-second-burst tree (mirrors tests/test_traj_recursive_tree.sh Part
// B) — a two-level, two-branch tree with hand-picked timestamps designed to
// defeat a whole-second/lexical sort key at once: every step but "wolf"
// lands inside the single second 12:00:10Z (third-millisecond-digit
// precision required to order them), "wolf" sits in 1970 (an 8-digit epoch
// among 13-digit millisecond ones — a lexical key would sort it LAST, not
// first), "bravo"/"charlie" keep the legacy "+hh:mm"/"-hh:mm" spelling (both
// signs, a half-hour offset), and "no-ts" cannot be parsed at all. See
// e4ca135 / PORT-NOTE (1c: e4ca135) on toEpoch() in src/trajCli.ts. ----------
const BURST_ROOT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const BURST_CHILD_ID = "eeeeeeee-1111-4000-8000-000000000002";
const BURST_GRAND_ID = "eeeeeeee-2222-4000-8000-000000000003";
const BURST_SIB_ID = "eeeeeeee-3333-4000-8000-000000000004";
// Chronological order of the `type=thought` steps below (what `cat -r`
// should return): wolf (1970) first, then everything inside 12:00:10Z in
// millisecond order, interleaving both branches and both tree levels.
const BURST_THOUGHT_ORDER = ["wolf", "zulu", "alpha", "yankee", "bravo", "xray", "charlie", "delta", "echo"];

function burstTreeFiles() {
  const t = (content, ts, extra = {}) => line({ type: "thought", content, ts, ...extra });
  const rootLines = [
    rootRecord(BURST_ROOT_ID, "2026-09-02T12:00:00.000Z"),
    t("wolf", "1970-01-02T00:00:00.000Z", { step_id: "f0000001-0000-4000-8000-000000000001" }),
    t("zulu", "2026-09-02T12:00:10.100Z", { step_id: "f0000002-0000-4000-8000-000000000002" }),
    line({
      type: "fork",
      child: BURST_CHILD_ID,
      child_ref: `${BURST_CHILD_ID.slice(0, 8)}-kid/trajectory.jsonl`,
      step_id: "f0000003-0000-4000-8000-000000000003",
      ts: "2026-09-02T12:00:10.150Z",
    }),
    t("yankee", "2026-09-02T12:00:10.300Z", { step_id: "f0000004-0000-4000-8000-000000000004" }),
    t("xray", "2026-09-02T12:00:10.500Z", { step_id: "f0000005-0000-4000-8000-000000000005" }),
    // Both forks out of root share a stamp (12:00:10.150Z) — filtered out of
    // every `type=thought` ordering assertion, as in the upstream test.
    line({
      type: "fork",
      child: BURST_SIB_ID,
      child_ref: `${BURST_SIB_ID.slice(0, 8)}-kid2/trajectory.jsonl`,
      step_id: "f0000006-0000-4000-8000-000000000006",
      ts: "2026-09-02T12:00:10.150Z",
    }),
  ];
  const childLines = [
    rootRecord(BURST_CHILD_ID, "2026-09-02T12:00:10.160Z", { parent_traj: BURST_ROOT_ID, parent_traj_ref: ".." }),
    t("alpha", "2026-09-02T12:00:10.200Z", { step_id: "f0000007-0000-4000-8000-000000000007" }),
    // legacy "+hh:mm" spelling — a half-hour offset, one instant AHEAD of UTC.
    t("bravo", "2026-09-02T17:30:10.400+05:30", { step_id: "f0000008-0000-4000-8000-000000000008" }),
    // legacy "-hh:mm" spelling — one instant BEHIND UTC.
    t("charlie", "2026-09-02T08:00:10.502-04:00", { step_id: "f0000009-0000-4000-8000-000000000009" }),
    line({ type: "oddball", content: "no-ts", ts: "not-a-timestamp", step_id: "f000000a-0000-4000-8000-00000000000a" }),
    line({
      type: "fork",
      child: BURST_GRAND_ID,
      child_ref: `${BURST_GRAND_ID.slice(0, 8)}-grandkid/trajectory.jsonl`,
      step_id: "f000000b-0000-4000-8000-00000000000b",
      ts: "2026-09-02T12:00:10.550Z",
    }),
  ];
  const grandLines = [
    rootRecord(BURST_GRAND_ID, "2026-09-02T12:00:10.560Z", { parent_traj: BURST_CHILD_ID, parent_traj_ref: ".." }),
    t("delta", "2026-09-02T12:00:10.600Z", { step_id: "f000000c-0000-4000-8000-00000000000c" }),
  ];
  const sibLines = [
    rootRecord(BURST_SIB_ID, "2026-09-02T12:00:10.660Z", { parent_traj: BURST_ROOT_ID, parent_traj_ref: ".." }),
    t("echo", "2026-09-02T12:00:10.700Z", { step_id: "f000000d-0000-4000-8000-00000000000d" }),
  ];
  return { rootLines, childLines, grandLines, sibLines };
}

/** Build the same-second-burst tree under <sb>/traj/. */
function makeBurstSandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "traj-parity-burst-sb-"));
  const trajDir = path.join(sb, "traj");
  const rootDir = path.join(trajDir, `${BURST_ROOT_ID.slice(0, 8)}-root`);
  const childDir = path.join(rootDir, `${BURST_CHILD_ID.slice(0, 8)}-kid`);
  const grandDir = path.join(childDir, `${BURST_GRAND_ID.slice(0, 8)}-grandkid`);
  const sibDir = path.join(rootDir, `${BURST_SIB_ID.slice(0, 8)}-kid2`);
  const { rootLines, childLines, grandLines, sibLines } = burstTreeFiles();
  for (const [dir, lines] of [
    [rootDir, rootLines],
    [childDir, childLines],
    [grandDir, grandLines],
    [sibDir, sibLines],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "trajectory.jsonl"), lines.join("\n") + "\n");
  }
  return { sb, trajDir, rootDir };
}

/** Build <sb>/traj/<ROOT_ID hex8>-root[/<CHILD_ID hex8>-child]/trajectory.jsonl */
function makeSandbox(opts = {}) {
  if (opts.burstTree) return makeBurstSandbox();
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "traj-parity-sb-"));
  const trajDir = path.join(sb, "traj");
  const rootDir = path.join(trajDir, `${ROOT_ID.slice(0, 8)}-root`);
  fs.mkdirSync(rootDir, { recursive: true });

  let rootLines = baseFixtureLines();
  if (opts.withFork) rootLines = rootLines.concat(forkFixtureLines());
  if (opts.malformedLastLine) rootLines = rootLines.concat(["not json at all"]);
  fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), rootLines.join("\n") + "\n");

  if (opts.withFork) {
    const childDir = path.join(rootDir, `${CHILD_ID.slice(0, 8)}-child`);
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, "trajectory.jsonl"), childFixtureLines().join("\n") + "\n");
  }

  if (opts.bigStdout) {
    // A step whose stdout was already spilled to a blob (for `show --full`).
    const blobDir = path.join(rootDir, "blobs");
    fs.mkdirSync(blobDir, { recursive: true });
    const stepId = "dddddddd-0000-4000-8000-000000000042";
    const big = "BLOB-" + "z".repeat(5000);
    fs.writeFileSync(path.join(blobDir, `${stepId}-000000.stdout`), big);
    const inline = big.slice(0, 4096);
    const extraLine = line({
      type: "shell-output",
      stdout: inline,
      stdout_ref: `blobs/${stepId}-000000.stdout`,
      stdout_bytes: Buffer.byteLength(big, "utf8"),
      stdout_truncated: true,
      step_id: stepId,
      ts: "2026-08-28T10:00:08.000Z",
    });
    fs.appendFileSync(path.join(rootDir, "trajectory.jsonl"), extraLine + "\n");
    opts._bigBlobStepId = stepId;
  }

  return { sb, trajDir, rootDir };
}

// Credential env vars traj_redact masks by VALUE (upstream sync 2e39a3f, 651d49f).
const CRED_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT", "ANTHROPIC_API_KEY", "LLM_API_KEY",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY",
  "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN", "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN", "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID",
  "STRIPE_SECRET_KEY", "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN", "DATABASE_URL", "REDIS_URL", "LINEAR_API_KEY",
];

// --- run one tool in a fresh sandbox -------------------------------------------
function runTool(kind, scenario, sb, trajDir) {
  const env = { ...process.env };
  delete env.TRAJ_DIR;
  delete env.TRAJ_ID;
  delete env.SHELLM_RUN_STEP_ID;
  delete env.CLICOLOR_FORCE;
  env.LC_ALL = "C";
  // Hermetic: the credential VALUE rules (traj_redact) read these from the environment.
  for (const v of CRED_VARS) delete env[v];
  delete env.SHELLM_STDOUT_INLINE_LIMIT;
  Object.assign(env, scenario.env ? scenario.env(trajDir) : {});

  const argv = (scenario.argv ? scenario.argv(trajDir) : []).slice();
  const bin = kind === "bash" ? BASH_TRAJ : "node";
  const fullArgv = kind === "bash" ? argv : [TS_TRAJ, ...argv];

  const res = spawnSync(bin, fullArgv, {
    cwd: sb,
    env,
    input: scenario.stdin ?? "",
    encoding: "utf8",
    timeout: 30000,
  });

  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
    signal: res.signal,
  };
}

// --- classified deviations ------------------------------------------------------
// PORT-NOTE (1c: e4ca135): bin/traj's `_sorted_tree_steps` `to_epoch` jq
// filter used to double-append "Z" onto an already-'Z'-suffixed timestamp in
// its no-offset fallback branch, which made THIS system's jq hard-error on
// the malformed "...ZZ" date and silently produce ZERO bytes from `tail
// -r`/`cat -r` on any normal (Z-timestamped) trajectory — an unintended
// Bash/jq crash artifact, not designed behaviour (see PARITY.md history for
// the prior TO_EPOCH_DEVIATION note). e4ca135 fixed this upstream (strips
// the trailing Z/z before re-appending it, and folds the sort key down to
// integer milliseconds so same-second bursts interleave correctly) —
// reverified directly: `bash tests/test_traj_recursive_tree.sh` against
// upstream-next passes 15/15. The port's toEpoch() now carries the same
// fix, so both `tail -r`/`cat -r` scenarios below are real byte-exact
// PARITY again, no deviation needed.


// --- upstream sync 2e39a3f, lane (c) scenarios ------------------------------------
// Synthetic credentials are assembled here, never written as literals.
const a = (c, n) => c.repeat(n);
const SECRETS = {
  ghp: "ghp_" + a("A", 24),
  ghpat: "github_pat_" + a("b", 24),
  slack: "xoxb-" + "1234567890-abcdef",
  sk: "sk-" + a("c", 24),
  hf: "hf_" + a("d", 24),
  aiza: "AIza" + a("e", 34),
  akia: "AKIA" + a("F", 16),
  asia: "ASIA" + a("G", 16),
  jwt: "eyJ" + a("h", 12) + "." + a("i", 12) + "." + a("j", 12),
  basic: "https://user:pa55w0rd@example.com/x",
  stripe: "sk_live_" + a("k", 12),
  rk: "rk_live_" + a("l", 12),
  whsec: "whsec_" + a("m", 12),
  npm: "npm_" + a("n", 24),
  glpat: "glpat-" + a("o", 14),
  dckr: "dckr_pat-" + a("p", 14),
  sg: "SG." + a("q", 12) + "." + a("r", 12),
  twilio: "SK" + a("a", 32),
  mailgun: "key-" + a("s", 24),
};
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
const rootFile = (ctx) => path.join(ctx.rootDir, "trajectory.jsonl");
const writeRoot = (ctx, lines) => fs.writeFileSync(rootFile(ctx), lines.join("\n") + "\n");
const appendRaw = (ctx, text) => fs.appendFileSync(rootFile(ctx), text);
const writeBlob = (ctx, name, text) => {
  fs.mkdirSync(path.join(ctx.rootDir, "blobs"), { recursive: true });
  fs.writeFileSync(path.join(ctx.rootDir, "blobs", name), text);
};
const hdr = () => rootRecord(ROOT_ID, "2026-01-01T00:00:00.000Z");
const S = (n, extra) => line({ step_id: `s${n}`, ts: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, ...extra });

/** The upstream tests/test_traj_search.sh fixture (s1..s13) plus decoded-field cases. */
function searchFixture(ctx) {
  writeRoot(ctx, [
    hdr(),
    S(1, { type: "reasoning", cmd: 'chat send --to slack-C1 "Dr. Claw paper"' }),
    S(2, { type: "shell-output", stdout: "nothing here" }),
    S(3, { type: "shell-output", stdout: "[blob]", stdout_ref: "blobs/b1.txt" }),
    S(4, { type: "reasoning", cmd: "echo later" }),
    S(5, { type: "shell-output", stderr: "[blob]", stderr_ref: "blobs/b2.txt" }),
    S(6, { type: "shell-output", stdout: "phantom fallback text", stdout_ref: "blobs/gone.txt" }),
    S(7, { type: "shell-output", stdout: "needle at line one", stdout_ref: "blobs/b4.txt" }),
    S(8, { type: "shell-output", stdout: "plain first\nneedle second line", stdout_ref: "blobs/gone3.txt" }),
    S(9, { type: "shell-output", stdout: 'tail says "needle" in quotes', stdout_ref: "blobs/gone4.txt" }),
    S(10, { type: "merge", content: "needle result", from_traj: "kid", from_step: "k1", from_traj_ref: "../kid/trajectory.jsonl" }),
    S(11, { type: "shell-output", stdout: "", stdout_ref: "blobs/b5.txt" }),
    S(12, { type: "shell-output", stdout: "", stdout_ref: "blobs/gone5.txt", stderr: "needle with an empty stdout inline" }),
    S(13, { type: "shell-output", stdout: "needle decoded after empty previews", stdout_ref: "blobs/gone6.txt" }),
    S(20, { type: "reasoning", thought: 'tail says "needle" in quotes' }),
    S(21, { type: "shell-output", stdout: "col1\tcol2 needle" }),
    S(22, { type: "reasoning", thought: 'ab"cd needle' }),
    S(23, { type: "shell-output", stdout: "needle opens\nmiddle needle\nneedle again\nends needle" }),
    S(24, { type: "reasoning", cmd: "echo C:\\path\\to needle" }),
    S(25, { type: "shell-output", stdout: "x\u0001 needle" }),
    S(26, { type: "reasoning", thought: "x\u0001needle\u0001 end" }),
    S(29, { type: "reasoning", thought: 'q"q" tail' }),
    S(30, { type: "reasoning", thought: "caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude42 cafe" }),
    S(31, { type: "reasoning", thought: "Needle UPPER and needle lower" }),
    S(32, { type: "shell-output", stdout: "ctx1\nctx2 needle ctx2\nctx3\nctx4\nctx5 needle\nctx6", stdout_ref: "blobs/b6.txt" }),
  ]);
  writeBlob(ctx, "b1.txt", "RISE paper in a blob\n");
  writeBlob(ctx, "b2.txt", "TRUNCATED tail only\n");
  writeBlob(ctx, "b4.txt", "needle at line one\nneedle also at line two\n");
  writeBlob(ctx, "b5.txt", "needle lives in the blob only\n");
  writeBlob(ctx, "b6.txt", "blob1\nblob2 needle blob2\nblob3\nblob4\nblob5\nblob6 needle\n\n\n");
}

const sx = (name, args, more = {}) => ({
  group: "search-sync",
  name,
  argv: (d) => ["search", ...args, "--traj_dir", d, ROOT_ID],
  setup: searchFixture,
  ...more,
});

function syncScenarios() {
  const out = [];
  const add = (x) => out.push(x);

  // ---- search: pass order, blobs, fallbacks, --tail ----
  for (const [n, args] of [
    ["literal-cmd", ["Dr. Claw"]],
    ["literal-ci", ["-i", "dr. claw"]],
    ["blob-text", ["RISE paper"]],
    ["tail5-misses-old-row", ["Dr. Claw", "--tail", "5"]],
    ["tail5-recent-row", ["phantom fallback", "--tail", "5"]],
    ["regex-alt", ["-E", "Dr\\. (Claw|Paw)"]],
    ["stderr-blob", ["TRUNCATED"]],
    ["missing-blob-fallback", ["phantom fallback"]],
    ["blob-and-inline-print-once", ["needle"]],
    ["field-cmd-skips-blob-stdout", ["RISE paper", "--field", "cmd"]],
    ["anchored-decoded-stdout", ["-E", "^needle", "--field", "stdout"]],
    ["quoted-literal-stdout", ['"needle"', "--field", "stdout"]],
    ["merge-row-content", ["-E", "^needle", "--field", "content"]],
    ["tail4-decoded-fallback", ["-E", "^needle", "--field", "stdout", "--tail", "4"]],
    ["tail2-bounds-decoded", ["-E", "^needle", "--field", "stdout", "--tail", "2"]],
    ["field-cmd-leaves-decoded-stdout", ["-E", "^needle", "--field", "cmd"]],
    ["empty-inline-existing-blob", ["needle lives in the blob"]],
    ["field-after-empty-preview", ["needle with an empty stdout"]],
    ["quoted-literal-thought", ['"needle" in', "--field", "thought"]],
    ["quoted-literal-thought-ci", ["-i", '"NEEDLE" IN', "--field", "thought"]],
    ["literal-tab", ["col1\tcol2"]],
    ["regex-dot-over-escaped-quote", ["-E", "ab.cd", "--field", "thought"]],
    ["class-with-escapable-member", ["-E", 'ab[uv"]cd', "--field", "thought"]],
    ["dollar-anchor-interior-lines", ["-E", "needle$", "--field", "stdout"]],
    ["literal-backslash", ["C:\\path", "--field", "cmd"]],
    ["control-char", ["x\u0001", "--field", "stdout"]],
    ["word-boundary-beside-control", ["-E", "\\bneedle\\b", "--field", "thought"]],
    ["posix-class-pattern", ["-E", "[[:alpha:]]eedle", "--field", "thought"]],
    ["backreference-over-quote", ["-E", '(q")\\1', "--field", "thought"]],
    ["non-ascii-F-cafe", ["caf\u00e9"]],
    ["non-ascii-F-cjk", ["\u65e5\u672c\u8a9e"]],
    ["non-ascii-F-emoji", ["\ud83d\ude42"]],
    ["non-ascii-E-cjk", ["-E", "\u65e5\u672c\u8a9e"]],
    ["case-ci-all-fields", ["-i", "NEEDLE"]],
    ["case-sensitive-capital", ["Needle"]],
    ["context-over-blob-and-inline", ["-C", "1", "needle", "--field", "stdout"]],
    ["tail-zero-is-all", ["Dr. Claw", "--tail", "0"]],
    ["tail-large", ["Dr. Claw", "--tail", "9999"]],
    ["ref-key-row-ci-pass", ["-i", "RISE"]],
  ]) add(sx(n, args));
  add(sx("tail-non-numeric-dies", ["x", "--tail", "abc"]));
  add(sx("tail-negative-dies", ["x", "--tail", "-3"]));
  add(sx("tail-empty-dies", ["x", "--tail", ""], { deviation: "`${2:?msg}` bash-builtin error text embeds the script's absolute path + a Bash line number; the port prints `traj: error: <msg>`, exit code 1 / stdout / state match" }));
  add({ group: "search-sync", name: "tail-missing-value-dies", argv: (d) => ["search", "x", "--traj_dir", d, ROOT_ID, "--tail"], setup: searchFixture, deviation: "`${2:?msg}` bash-builtin error text embeds the script's absolute path + a Bash line number; the port prints `traj: error: <msg>`, exit code 1 / stdout / state match" });
  add({ group: "search-sync", name: "no-pattern-with-tail-dies", argv: (d) => ["search", "--tail", "3", "--traj_dir", d, ROOT_ID], setup: searchFixture });
  add({ group: "search-sync", name: "usage-lists-tail", argv: () => ["help"] });

  // ---- search: malformed / unterminated rows around the two passes ----
  const mal = (name, args, tailText, extraSetup, deviation) =>
    add({
      group: "search-malformed",
      name,
      deviation,
      argv: (d) => ["search", ...args, "--traj_dir", d, ROOT_ID],
      setup: (ctx) => {
        searchFixture(ctx);
        appendRaw(ctx, tailText);
        extraSetup?.(ctx);
      },
    });
  mal("malformed-row-matching-F-pattern-crashes", ["needle"], "not-json needle {{{\n", undefined, "jq's own internal error wording (`jq: error …` / `jq: parse error …`) is build-specific boilerplate the port cannot compute; exit code (5) and stdout match — same class as parity/fuzz traj-2 (bug #48)");
  mal("malformed-row-nonmatching-F-pattern", ["Dr. Claw"], "not-json at all {{{\n");
  mal("malformed-row-nonmatching-F-pattern-tail", ["phantom fallback", "--tail", "3"], "not-json at all {{{\n");
  mal("malformed-row-with-ref-silently-stops-ref-pass", ["needle"], '{"step_id":"bad_ref", "stdout_ref":\n');
  mal("malformed-ref-row-F-miss", ["RISE paper"], 'garbage "_ref": nothing\n');
  mal("non-object-json-row-matching", ["needle"], '"needle string row"\n', undefined, "jq's own internal error wording (`jq: error …` / `jq: parse error …`) is build-specific boilerplate the port cannot compute; exit code (5) and stdout match — same class as parity/fuzz traj-2 (bug #48)");
  mal("array-row-matching", ["needle"], '["needle"]\n', undefined, "jq's own internal error wording (`jq: error …` / `jq: parse error …`) is build-specific boilerplate the port cannot compute; exit code (5) and stdout match — same class as parity/fuzz traj-2 (bug #48)");
  mal("unterminated-final-row-is-searched", ["unterminated hit"], line({ step_id: "s40", type: "thought", thought: "unterminated hit" }));
  mal("unterminated-final-ref-row", ["lastblob"], line({ step_id: "s41", type: "shell-output", stdout: "lastblob inline", stdout_ref: "blobs/none.txt" }));
  mal("row-without-step-id", ["no id here"], line({ type: "thought", thought: "no id here" }) + "\n");
  mal("ref-row-without-step-id", ["no id ref"], line({ type: "shell-output", stdout: "no id ref", stdout_ref: "blobs/zz" }) + "\n");
  mal("non-string-field-and-ref", ["12345"], line({ step_id: "s42", type: "x", stdout: 12345, stdout_ref: "blobs/none" }) + "\n" + line({ step_id: "s43", type: "x", content: { a: "12345" } }) + "\n");
  mal("empty-blob-file", ["fallback-inline"], line({ step_id: "s44", type: "x", stdout: "fallback-inline", stdout_ref: "blobs/empty.txt" }) + "\n", (ctx) => writeBlob(ctx, "empty.txt", ""));
  mal("trailing-newline-lines-in-inline", ["-E", "^$"], line({ step_id: "s45", type: "x", stdout: "a\n", stdout_ref: "blobs/none" }) + "\n");

  // ---- search -r with the two-pass order across files ----
  add({
    group: "search-sync",
    name: "recursive-two-passes-per-file",
    argv: (d) => ["search", "needle", "-r", "--traj_dir", d, ROOT_ID],
    setup: (ctx) => {
      searchFixture(ctx);
      appendRaw(ctx, forkFixtureLines().join("\n") + "\n");
      const kid = path.join(ctx.rootDir, `${CHILD_ID.slice(0, 8)}-child`);
      fs.mkdirSync(path.join(kid, "blobs"), { recursive: true });
      fs.writeFileSync(path.join(kid, "blobs", "k.txt"), "child blob needle\n");
      fs.writeFileSync(
        path.join(kid, "trajectory.jsonl"),
        [
          rootRecord(CHILD_ID, "2026-08-28T10:00:06.000Z", { parent_traj: ROOT_ID, parent_traj_ref: ".." }),
          line({ step_id: "k1", type: "x", stdout: "k", stdout_ref: "blobs/k.txt" }),
          line({ step_id: "k2", type: "x", content: "child inline needle" }),
        ].join("\n") + "\n",
      );
    },
  });

  // ---- redaction at the write point (append) ----
  const rd = (name, rec, more = {}) =>
    add({
      group: "traj-redact",
      name,
      argv: (d) => ["append", "--traj_dir", d, ROOT_ID],
      stdin: typeof rec === "string" ? rec : JSON.stringify(rec),
      ...more,
    });
  for (const [k, v] of Object.entries(SECRETS)) rd(`shape-${k}`, { type: "thought", content: `before ${v} after` });
  rd("shape-all-in-one-record", { type: "thought", content: Object.values(SECRETS).join(" | ") });
  rd("aws-secret-key-forms", { type: "thought", content: "aws_secret_access_key=abc/def+ghi AWS_SECRET_ACCESS_KEY : zzz999 aws_secret_access_key   =   spaced" });
  rd("docker-auth-config", { type: "thought", content: '{"auths":{"r.io":{"auth":"' + a("Q", 20) + '"}}}' });
  rd("docker-auth-key-in-record", { type: "thought", auth: "QUJD".repeat(5), other: { auth: "short" }, content: "x" });
  rd("docker-auth-key-nonmatching-value", { type: "thought", auth: "has spaces", content: "x" });
  rd("pem-complete", { type: "thought", content: `a\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\nb` });
  rd("pem-unterminated", { type: "thought", content: `a\n-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\nmore body` });
  rd("pem-unterminated-trailing-newline", { type: "thought", content: `a\n-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n` });
  rd("pem-unterminated-two-trailing-newlines", { type: "thought", content: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n\n` });
  rd("pem-two-blocks", { type: "thought", content: `-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\nmid\n-----BEGIN EC PRIVATE KEY-----\ny\n-----END EC PRIVATE KEY-----` });
  rd("pem-then-secret-after", { type: "thought", content: `-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY----- ${SECRETS.ghp}` });
  rd("nested-record-and-arrays", { type: "thought", content: "x", meta: { list: [SECRETS.ghp, { deep: SECRETS.sk }, 5, true, null], n: 1.5 } });
  rd("secret-in-object-key", { type: "thought", [SECRETS.ghp]: "v", content: "x" });
  rd("key-collision-after-redaction", { type: "thought", ["k" + SECRETS.hf]: "one", ["k" + "hf_" + a("z", 24)]: "two", content: "x" });
  rd("non-string-values-untouched", { type: "thought", n: 12, f: false, z: null, arr: [1, 2], content: "x" });
  rd("step-id-with-secret-sanitized-everywhere", { type: "shell-output", step_id: "id-" + SECRETS.ghp, stdout: "x".repeat(40) + SECRETS.sk }, { env: () => ({ SHELLM_STDOUT_INLINE_LIMIT: "16" }) });
  rd("blob-is-redacted", { type: "shell-output", stdout: "y".repeat(30) + SECRETS.ghp + "z".repeat(30), stderr: "e" + SECRETS.slack }, { env: () => ({ SHELLM_STDOUT_INLINE_LIMIT: "20" }) });
  rd("value-rule-github-token", { type: "thought", content: "tok=ghTOKENvalue12345 end" }, { env: () => ({ GITHUB_TOKEN: "ghTOKENvalue12345" }) });
  rd("value-rule-short-ignored", { type: "thought", content: "tok=abc1234 end" }, { env: () => ({ GITHUB_TOKEN: "abc1234" }) });
  rd("value-rule-exact-8", { type: "thought", content: "tok=abcd1234 end" }, { env: () => ({ GITHUB_TOKEN: "abcd1234" }) });
  rd("value-rule-multibyte-8-codepoints", { type: "thought", content: "pw=\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9 end" }, { env: () => ({ LLM_API_KEY: "\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9" }) });
  rd("value-rule-database-url", { type: "thought", content: "db postgres-secret-url-123 ok" }, { env: () => ({ DATABASE_URL: "postgres-secret-url-123" }) });
  rd("value-rule-linear-not-listed", { type: "thought", content: "lin LINEARsecretvalue99 ok" }, { env: () => ({ LINEAR_API_KEY: "LINEARsecretvalue99" }) });
  rd("value-rule-then-shape", { type: "thought", content: `v=${a("v", 12)} g=${SECRETS.ghp}` }, { env: () => ({ HF_TOKEN: a("v", 12) }) });
  rd("value-repeated-and-adjacent", { type: "thought", content: "AAAAAAAAAAAAAAAA" }, { env: () => ({ GH_TOKEN: "AAAAAAAA" }) });
  rd("boundary-sk-after-word-char", { type: "thought", content: "task-" + a("a", 24) + " and ask-" + a("a", 24) + " and (sk-" + a("a", 24) + ")" });
  rd("boundary-start-of-string", { type: "thought", content: "sk-" + a("a", 24) });
  rd("boundary-too-short", { type: "thought", content: "sk-" + a("a", 19) + " ghp_" + a("a", 19) + " hf_" + a("a", 19) });
  rd("basic-auth-variants", { type: "thought", content: "a://u:p@h b://u:@h c://:p@h d://u:p:q@h e://u@h f://u:p/x@h" });
  rd("unicode-whitespace-in-basic-auth", { type: "thought", content: "x://us\u00a0er:pw@h y://u:p\u2003w@h" });
  rd("docker-auth-spacing", { type: "thought", content: '"auth"\u00a0:\u00a0"' + a("Q", 20) + '" and "auth":"short"' });
  rd("astral-characters-kept", { type: "thought", content: "\ud83d\ude42 " + SECRETS.ghp + " \ud83d\ude42" });
  rd("redaction-via-field-flag", "", { argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--field", "type=thought", "--field", "content=via " + SECRETS.ghp] });
  rd("jwt-needs-three-parts", { type: "thought", content: "eyJ" + a("h", 12) + "." + a("i", 12) + " not-a-jwt" });
  rd("npm-and-key-boundaries", { type: "thought", content: "xnpm_" + a("n", 24) + " ykey-" + a("s", 24) + " zglpat-" + a("o", 14) });

  // ---- append lock fails fast on an unwritable directory ----
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    add({
      group: "traj-lock",
      name: "append-readonly-dir-fails-fast",
      argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--field", "type=thought", "--field", "content=x"],
      setup: (ctx) => fs.chmodSync(ctx.rootDir, 0o555),
      teardown: (ctx) => fs.chmodSync(ctx.rootDir, 0o755),
    });
  }
  add({
    group: "traj-lock",
    name: "append-with-stale-lock-dir-is-stolen",
    argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--field", "type=thought", "--field", "content=x"],
    setup: (ctx) => {
      fs.mkdirSync(rootFile(ctx) + ".lock");
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(rootFile(ctx) + ".lock", old, old);
    },
  });

  // ---- fork cycles in recursive reads ----
  const cyc = (name, argvFn, setup) => add({ group: "traj-cycle", name, argv: argvFn, setup });
  const kidDir = (ctx) => path.join(ctx.rootDir, `${CHILD_ID.slice(0, 8)}-child`);
  const forkRow = (id, ts, child, ref) => line({ type: "fork", child, child_ref: ref, step_id: id, ts });
  const selfFork = (ctx) => writeRoot(ctx, [
    rootRecord(ROOT_ID, "2026-01-01T00:00:00.000Z"),
    forkRow("f1", "2026-01-01T00:00:01.000Z", ROOT_ID, "./trajectory.jsonl"),
    line({ type: "thought", content: "self cycle needle", step_id: "t1", ts: "2026-01-01T00:00:02.000Z" }),
  ]);
  const twoNode = (ctx) => {
    writeRoot(ctx, [
      rootRecord(ROOT_ID, "2026-01-01T00:00:00.000Z"),
      forkRow("f1", "2026-01-01T00:00:01.000Z", CHILD_ID, `${CHILD_ID.slice(0, 8)}-child/trajectory.jsonl`),
      line({ type: "thought", content: "root needle", step_id: "t1", ts: "2026-01-01T00:00:02.000Z" }),
    ]);
    fs.mkdirSync(kidDir(ctx), { recursive: true });
    fs.writeFileSync(path.join(kidDir(ctx), "trajectory.jsonl"), [
      rootRecord(CHILD_ID, "2026-01-01T00:00:03.000Z", { parent_traj: ROOT_ID, parent_traj_ref: ".." }),
      forkRow("f2", "2026-01-01T00:00:04.000Z", ROOT_ID, "../trajectory.jsonl"),
      line({ type: "thought", content: "child needle", step_id: "t2", ts: "2026-01-01T00:00:05.000Z" }),
    ].join("\n") + "\n");
  };
  const sharedChild = (ctx) => {
    const ref = `${CHILD_ID.slice(0, 8)}-child/trajectory.jsonl`;
    writeRoot(ctx, [
      rootRecord(ROOT_ID, "2026-01-01T00:00:00.000Z"),
      forkRow("f1", "2026-01-01T00:00:01.000Z", CHILD_ID, ref),
      forkRow("f2", "2026-01-01T00:00:02.000Z", CHILD_ID, ref),
      line({ type: "thought", content: "root needle", step_id: "t1", ts: "2026-01-01T00:00:03.000Z" }),
    ]);
    fs.mkdirSync(kidDir(ctx), { recursive: true });
    fs.writeFileSync(path.join(kidDir(ctx), "trajectory.jsonl"), [
      rootRecord(CHILD_ID, "2026-01-01T00:00:04.000Z", { parent_traj: ROOT_ID, parent_traj_ref: ".." }),
      line({ type: "thought", content: "child needle", step_id: "t2", ts: "2026-01-01T00:00:05.000Z" }),
    ].join("\n") + "\n");
  };
  for (const [tag, setup] of [["self", selfFork], ["two-node", twoNode], ["shared-child", sharedChild]]) {
    cyc(`${tag}-cat-r-raw`, (d) => ["cat", "--traj_dir", d, ROOT_ID, "-r", "--raw"], setup);
    cyc(`${tag}-tail-r-raw`, (d) => ["tail", "--traj_dir", d, ROOT_ID, "-r", "-n", "50", "--raw"], setup);
    cyc(`${tag}-search-r`, (d) => ["search", "needle", "-r", "--traj_dir", d, ROOT_ID], setup);
    cyc(`${tag}-list-children-all`, (d) => ["list", "--traj_dir", d, ROOT_ID, "--children", "all"], setup);
    cyc(`${tag}-list-json`, (d) => ["list", "--traj_dir", d, ROOT_ID, "--json", "--children", "all"], setup);
    cyc(`${tag}-list-steps`, (d) => ["list", "--traj_dir", d, ROOT_ID, "--steps", "--children", "all"], setup);
    cyc(`${tag}-check-r`, (d) => ["check", "--traj_dir", d, ROOT_ID, "-r"], setup);
  }

  // ---- formatted (terminal) mode with --filter / malformed rows ----
  const fmtFixture = (ctx) => writeRoot(ctx, [
    rootRecord(ROOT_ID, "2026-01-01T00:00:00.000Z"),
    S(1, { type: "thought", content: "T1" }),
    S(2, { type: "action", content: "A1" }),
    S(3, { type: "thought", content: "T2" }),
    S(4, { type: "message", content: "M1", source: "nick" }),
  ]);
  const fmtBad = (ctx) => {
    fmtFixture(ctx);
    appendRaw(ctx, "not json {{{\n" + S(5, { type: "thought", content: "after-bad" }) + "\n");
  };
  const fmtEmpty = (ctx) => {
    fmtFixture(ctx);
    appendRaw(ctx, S(6, { type: "thought", content: "" }) + "\n" + S(7, { type: "thought" }) + "\n");
  };
  for (const [tag, setup] of [["plain", fmtFixture], ["malformed-mid", fmtBad], ["empty-content", fmtEmpty]]) {
    for (const flt of [[], ["--filter", "type=thought"], ["--filter", "type=message"], ["--filter", "type=nosuch"], ["--filter", "source=nick"]]) {
      const ft = flt.length ? flt[1].replace(/[=,]/g, "_") : "nofilter";
      add({ group: "traj-format", name: `${tag}-tail-format-${ft}`, argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--format", "--no-color", "-n", "20", ...flt], setup });
      add({ group: "traj-format", name: `${tag}-cat-format-${ft}`, argv: (d) => ["cat", "--traj_dir", d, ROOT_ID, "--format", "--no-color", ...flt], setup });
    }
    add({ group: "traj-format", name: `${tag}-cat-format-all-fields`, argv: (d) => ["cat", "--traj_dir", d, ROOT_ID, "--format", "--no-color", "-a"], setup });
  }
  return out;
}

// --- scenario definitions -------------------------------------------------------
const scenarios = [
  // ---- global ----
  { group: "global", name: "no-args-usage", argv: () => [] },
  { group: "global", name: "help", argv: () => ["help"] },
  { group: "global", name: "dash-h", argv: () => ["-h"] },
  { group: "global", name: "dash-dash-help", argv: () => ["--help"] },
  { group: "global", name: "unknown-command", argv: () => ["bogus"] },
  {
    group: "global",
    name: "usage-shows-env-when-set",
    argv: () => [],
    env: (trajDir) => ({ TRAJ_DIR: trajDir, TRAJ_ID: ROOT_ID }),
  },

  // ---- new ----
  { group: "new", name: "basic", argv: (d) => ["new", "--traj_dir", path.join(d, "fresh1"), "--slug", "hello world"] },
  { group: "new", name: "default-slug", argv: (d) => ["new", "--traj_dir", path.join(d, "fresh2")] },
  {
    group: "new",
    name: "sanitized-slug-unsafe-chars",
    argv: (d) => ["new", "--traj_dir", path.join(d, "fresh3"), "--slug", "A/B  C!!  --nested--"],
  },
  {
    group: "new",
    name: "fields-in-order-last-wins",
    argv: (d) => ["new", "--traj_dir", path.join(d, "fresh4"), "--field", "foo=1", "--field", "bar=2", "--field", "foo=3"],
  },
  { group: "new", name: "missing-traj-dir-dies", argv: () => ["new"] },
  { group: "new", name: "unknown-option-dies", argv: (d) => ["new", "--traj_dir", d, "--bogus"] },
  { group: "new", name: "extra-positional-dies", argv: (d) => ["new", "--traj_dir", d, "extra"] },

  // ---- append (spot checks; the full write-path contract lives in the
  // characterization tests — this just confirms the CLI wiring/flag parsing) ----
  {
    group: "append",
    name: "field-basic",
    argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--field", "type=observation", "--field", "content=hi"],
    withFork: true,
  },
  {
    group: "append",
    name: "stdin-json",
    argv: (d) => ["append", "--traj_dir", d, ROOT_ID],
    stdin: JSON.stringify({ type: "thought", content: "from stdin" }),
    withFork: true,
  },
  { group: "append", name: "empty-stdin-dies", argv: (d) => ["append", "--traj_dir", d, ROOT_ID], stdin: "", withFork: true },
  {
    group: "append",
    name: "invalid-json-stdin-dies",
    argv: (d) => ["append", "--traj_dir", d, ROOT_ID],
    stdin: "not json",
    withFork: true,
  },
  {
    group: "append",
    name: "missing-type-dies",
    argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--field", "content=x"],
    withFork: true,
  },
  { group: "append", name: "unknown-option-dies", argv: (d) => ["append", "--traj_dir", d, ROOT_ID, "--bogus"], withFork: true },

  // ---- fork ----
  { group: "fork", name: "auto-create-child", argv: (d) => ["fork", "--traj_dir", d, ROOT_ID, "--slug", "sub task"] },
  { group: "fork", name: "missing-traj-dies", argv: () => ["fork"] },

  // ---- merge ----
  {
    group: "merge",
    name: "basic",
    argv: (d) => ["merge", CHILD_ID, "--traj_dir", d, ROOT_ID],
    env: (d) => ({ TRAJ_DIR: d }),
    withFork: true,
  },
  {
    group: "merge",
    name: "unresolvable-child-dies",
    argv: (d) => ["merge", "00000000-0000-0000-0000-000000000000", "--traj_dir", d, ROOT_ID],
    withFork: true,
  },
  { group: "merge", name: "no-child-arg-dies", argv: (d) => ["merge", "--traj_dir", d, ROOT_ID], withFork: true },

  // ---- show ----
  { group: "show", name: "trajectory-metadata", argv: (d) => ["show", ROOT_ID, "--traj_dir", d], withFork: true },
  { group: "show", name: "step-json", argv: (d) => ["show", STEP_IDS[0], "--traj_dir", d], withFork: true },
  { group: "show", name: "field-extract", argv: (d) => ["show", STEP_IDS[0], "--traj_dir", d, "--field", "content"], withFork: true },
  { group: "show", name: "pretty", argv: (d) => ["show", STEP_IDS[3], "--traj_dir", d, "--pretty"], withFork: true },
  { group: "show", name: "full-blob", argv: (d) => ["show", "dddddddd-0000-4000-8000-000000000042", "--traj_dir", d, "--full"], bigStdout: true },
  { group: "show", name: "not-found-dies", argv: (d) => ["show", "ffffffff-0000-0000-0000-000000000000", "--traj_dir", d], withFork: true },
  { group: "show", name: "no-id-dies", argv: (d) => ["show", "--traj_dir", d], withFork: true },

  // ---- tail (spawnSync stdout is a pipe, never a tty — both sides default to raw) ----
  { group: "tail", name: "default-n10-raw", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "tail", name: "n-flag", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "-n", "2"], withFork: true },
  { group: "tail", name: "bare-numeric-positional-sets-n", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "2"], withFork: true },
  { group: "tail", name: "raw-explicit", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--raw"], withFork: true },
  { group: "tail", name: "format-forced", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--format"], withFork: true },
  { group: "tail", name: "format-all-fields", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--format", "-a"], withFork: true },
  {
    group: "tail",
    name: "filter-type",
    argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--filter", "type=thought,observation"],
    withFork: true,
  },
  {
    group: "tail",
    name: "recursive",
    argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "-r", "-n", "20"],
    withFork: true,
  },
  { group: "tail", name: "help", argv: () => ["tail", "-h"] },
  { group: "tail", name: "unknown-option-dies", argv: (d) => ["tail", "--traj_dir", d, ROOT_ID, "--bogus"], withFork: true },
  { group: "tail", name: "missing-traj-dies", argv: () => ["tail"] },

  // ---- cat ----
  { group: "cat", name: "raw-all", argv: (d) => ["cat", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "cat", name: "format-forced", argv: (d) => ["cat", "--traj_dir", d, ROOT_ID, "--format"], withFork: true },
  { group: "cat", name: "filter", argv: (d) => ["cat", "--traj_dir", d, ROOT_ID, "--filter", "type=fork"], withFork: true },
  {
    group: "cat",
    name: "recursive",
    argv: (d) => ["cat", "--traj_dir", d, ROOT_ID, "-r"],
    withFork: true,
  },
  { group: "cat", name: "help", argv: () => ["cat", "-h"] },
  {
    group: "cat",
    name: "unresolvable-dies",
    argv: (d) => ["cat", "--traj_dir", d, "ffffffff-0000-0000-0000-000000000000"],
    withFork: true,
  },

  // ---- search ----
  { group: "search", name: "default-fields", argv: (d) => [
      "search", GOLDEN_THOUGHTS[1].split(" ")[0], "--traj_dir", d, ROOT_ID,
    ], withFork: true },
  { group: "search", name: "field-flag", argv: (d) => ["search", "RLM", "--traj_dir", d, ROOT_ID, "--field", "cmd"], withFork: true },
  { group: "search", name: "case-insensitive", argv: (d) => ["search", GOLDEN_THOUGHTS[0].toUpperCase(), "-i", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "search", name: "context-lines", argv: (d) => ["search", GOLDEN_THOUGHTS[0], "-C", "1", "--traj_dir", d, ROOT_ID, "--field", "content"], withFork: true },
  { group: "search", name: "regex", argv: (d) => ["search", "[A-Z][a-z]+", "-E", "--traj_dir", d, ROOT_ID, "--field", "content"], withFork: true },
  { group: "search", name: "recursive", argv: (d) => ["search", GOLDEN_THOUGHTS[4], "-r", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "search", name: "no-pattern-dies", argv: (d) => ["search", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "search", name: "no-match", argv: (d) => ["search", "zzz_no_such_thing_zzz", "--traj_dir", d, ROOT_ID], withFork: true },

  // ---- count ----
  { group: "count", name: "basic", argv: (d) => ["count", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "count", name: "unresolvable-dies", argv: (d) => ["count", "--traj_dir", d, "ffffffff-0000-0000-0000-000000000000"], withFork: true },

  // ---- last ----
  { group: "last", name: "basic", argv: (d) => ["last", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "last", name: "field-extract", argv: (d) => ["last", "--traj_dir", d, ROOT_ID, "--field", "type"], withFork: true },
  { group: "last", name: "field-absent-empty", argv: (d) => ["last", "--traj_dir", d, ROOT_ID, "--field", "nonexistent"], withFork: true },
  { group: "last", name: "file-not-found-dies", argv: () => ["last", "--traj_dir", "/nonexistent-dir-xyz", "ffffffff-0000-0000-0000-000000000000"] },

  // ---- exists ----
  { group: "exists", name: "true", argv: (d) => ["exists", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "exists", name: "false-unresolvable", argv: (d) => ["exists", "--traj_dir", d, "ffffffff-0000-0000-0000-000000000000"], withFork: true },
  { group: "exists", name: "false-no-env-no-flags", argv: () => ["exists"] },
  { group: "exists", name: "unknown-option-dies", argv: (d) => ["exists", "--traj_dir", d, "--bogus"], withFork: true },

  // ---- path ----
  { group: "path", name: "basic", argv: (d) => ["path", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "path", name: "help", argv: () => ["path", "-h"] },
  { group: "path", name: "missing-dies", argv: () => ["path"] },

  // ---- list ----
  { group: "list", name: "plain-default", argv: (d) => ["list", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "list", name: "json", argv: (d) => ["list", "--traj_dir", d, ROOT_ID, "--json"], withFork: true },
  { group: "list", name: "children-all", argv: (d) => ["list", "--traj_dir", d, ROOT_ID, "--children", "all"], withFork: true },
  { group: "list", name: "steps", argv: (d) => ["list", "--traj_dir", d, ROOT_ID, "--steps"], withFork: true },
  { group: "list", name: "from-child-parents-all", argv: (d) => ["list", "--traj_dir", d, CHILD_ID], withFork: true },
  { group: "list", name: "unknown-option-dies", argv: (d) => ["list", "--traj_dir", d, "--bogus"], withFork: true },

  // ---- root ----
  { group: "root", name: "already-root", argv: (d) => ["root", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "root", name: "from-child", argv: (d) => ["root", "--traj_dir", d, CHILD_ID], withFork: true },

  // ---- check ----
  { group: "check", name: "ok", argv: (d) => ["check", "--traj_dir", d, ROOT_ID], withFork: true },
  { group: "check", name: "malformed-reported", argv: (d) => ["check", "--traj_dir", d, ROOT_ID], malformedLastLine: true },
  { group: "check", name: "fix", argv: (d) => ["check", "--traj_dir", d, ROOT_ID, "--fix"], malformedLastLine: true },
  { group: "check", name: "recursive", argv: (d) => ["check", "--traj_dir", d, ROOT_ID, "-r"], withFork: true },
  { group: "check", name: "help", argv: () => ["check", "-h"] },

  // ---- recursive tree ordering (e4ca135) — same-second burst + one legacy
  // "+hh:mm" timestamp, mirroring tests/test_traj_recursive_tree.sh Part B.
  // See BURST_THOUGHT_ORDER above for the expected chronological order this
  // proves (both signs of the legacy offset, sub-second precision, an
  // unparseable stamp that must not vanish, and a 1970 stamp that a lexical
  // key would have sorted last instead of first).
  {
    group: "tail",
    name: "recursive-same-second-burst",
    argv: (d) => ["cat", "--traj_dir", d, BURST_ROOT_ID, "-r", "--raw", "--filter", "type=thought"],
    burstTree: true,
  },
  {
    group: "tail",
    name: "recursive-same-second-burst-n2",
    argv: (d) => ["tail", "--traj_dir", d, BURST_ROOT_ID, "-r", "-n", "2", "--raw", "--filter", "type=thought"],
    burstTree: true,
  },
  {
    group: "tail",
    name: "recursive-same-second-burst-unparseable-kept",
    argv: (d) => ["cat", "--traj_dir", d, BURST_ROOT_ID, "-r", "--raw", "--filter", "type=oddball"],
    burstTree: true,
  },
  {
    group: "tail",
    name: "recursive-same-second-burst-whole-tree",
    argv: (d) => ["cat", "--traj_dir", d, BURST_ROOT_ID, "-r", "--raw"],
    burstTree: true,
  },
  ...syncScenarios(),
];

// --- execute ---------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  const optsBash = { withFork: sc.withFork, malformedLastLine: sc.malformedLastLine, bigStdout: sc.bigStdout, burstTree: sc.burstTree };
  const optsTs = { withFork: sc.withFork, malformedLastLine: sc.malformedLastLine, bigStdout: sc.bigStdout, burstTree: sc.burstTree };
  const ctxBash = makeSandbox(optsBash);
  const ctxTs = makeSandbox(optsTs);
  const { sb: sbBash, trajDir: trajDirBash } = ctxBash;
  const { sb: sbTs, trajDir: trajDirTs } = ctxTs;
  if (sc.setup) {
    sc.setup(ctxBash);
    sc.setup(ctxTs);
  }

  let bash, ts;
  try {
    bash = runTool("bash", sc, sbBash, trajDirBash);
    ts = runTool("ts", sc, sbTs, trajDirTs);
  } finally {
    // state captured before cleanup
  }
  const stateBash = serializeState(sbBash);
  const stateTs = serializeState(sbTs);
  if (sc.teardown) {
    sc.teardown(ctxBash);
    sc.teardown(ctxTs);
  }
  fs.rmSync(sbBash, { recursive: true, force: true });
  fs.rmSync(sbTs, { recursive: true, force: true });

  const norm = (s) => normalize(s, sbBash, sbTs);
  const cmp = {
    stdout: norm(bash.stdout) === norm(ts.stdout),
    stderr: norm(bash.stderr) === norm(ts.stderr),
    status: bash.status === ts.status,
    state: norm(stateBash) === norm(stateTs),
  };
  const byteExact = cmp.stdout && cmp.stderr && cmp.status && cmp.state;
  const pass = byteExact || Boolean(sc.deviation);
  results.push({
    group: sc.group,
    name: sc.name,
    argv: sc.argv ? sc.argv("<TRAJ_DIR>") : [],
    deviation: sc.deviation || null,
    byteExact,
    pass,
    cmp,
    bash: { ...bash, stdoutN: norm(bash.stdout), stderrN: norm(bash.stderr), stateN: norm(stateBash) },
    ts: { ...ts, stdoutN: norm(ts.stdout), stderrN: norm(ts.stderr), stateN: norm(stateTs) },
  });
}

// --- report -------------------------------------------------------------------
const total = results.length;
const byteExactCount = results.filter((r) => r.byteExact).length;
const deviationCount = results.filter((r) => !r.byteExact && r.deviation).length;
const passed = results.filter((r) => r.pass).length; // byte-exact OR classified deviation
const diverged = results.filter((r) => !r.pass);
const rate = ((passed / total) * 100).toFixed(1);

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# traj — differential parity proof\n\n`;
md += `Generated by \`parity/traj/run-parity.mjs\`. Real Bash tool \`headlong/bin/traj\` vs TS port \`headlong-ts/bin/traj.mjs\`, identical inputs, diffed stdout+stderr+exit code+on-disk state.\n\n`;
md += `- Node: \`node parity/traj/run-parity.mjs\` (Node 24). Locale pinned \`LC_ALL=C\`.\n`;
md += `- Fixture trajectories seeded with real content from \`golden/trace-00-boot-and-convo.jsonl\` (the boot+convo thoughts), re-stamped with FIXED deterministic step_id/ts so read-path scenarios are byte-identical with no normalization needed beyond the sandbox path.\n`;
md += `- Normalized symmetrically before compare: \`<SANDBOX>\` (the scratch dir prefix), \`<UUID>\`, \`<TS>\` (ISO timestamp), \`<HEX8>\` (a bare 8-hex-char run) — needed only by the write-generating scenarios (new/append/fork/merge/check --fix), which mint a fresh UUID+timestamp each run. Everything else compared exactly.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%) — ${byteExactCount} byte-identical + ${deviationCount} documented deviation(s), 0 DIVERGE${diverged.length ? ` (${diverged.length} scenario(s) still failing — see below)` : ""}\n\n`;

const byGroup = {};
for (const r of results) (byGroup[r.group] ??= []).push(r);
md += `| # | group | scenario | verdict | fields differing |\n|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
  const verdict = r.byteExact ? "PARITY" : r.deviation ? "DEVIATION" : "DIVERGE";
  md += `| ${idx++} | ${r.group} | ${r.name} | ${verdict} | ${diffs} |\n`;
}
md += `\n## Non-byte-exact scenarios (detail)\n\n`;
const notExact = results.filter((r) => !r.byteExact);
if (notExact.length === 0) md += `None.\n`;
for (const r of notExact) {
  md += `### ${r.group} / ${r.name} — ${r.deviation ? "DEVIATION (documented, not a divergence)" : "DIVERGE"}\n`;
  md += `- argv: \`${JSON.stringify(r.argv)}\`\n`;
  if (r.deviation) md += `- why: ${r.deviation}\n`;
  md += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  md += "```\n";
  md += block("stdout", r.bash.stdoutN, r.ts.stdoutN, r.cmp.stdout) + "\n";
  md += block("stderr", r.bash.stderrN, r.ts.stderrN, r.cmp.stderr) + "\n";
  md += block("state", r.bash.stateN, r.ts.stateN, r.cmp.state) + "\n";
  md += "```\n\n";
}

md += `## Interpretation of divergences\n\n`;
md += `Every non-byte-exact scenario above is a classified, documented deviation (see PARITY.md's traj row and Deviations table): the \`\${2:?}\`-class deviation (bash's own diagnostic on a missing/empty required flag value embeds the script's absolute path + a bash line number, irreproducible from TS and brittle to pin), a jq-abort-family deviation (a \`set -e\` crash inside a jq pipeline exits with jq's own code; the port dies with its own message at the same logical point), or the \`to_epoch\` double-\"Z\" jq crash (tail -r/cat -r) documented above. A true DIVERGE (an unclassified byte mismatch) fails the run.\n\n`;

// Committed artifacts must not carry the machine's user name / home / checkout path
// (test/scrub.test.ts); stderr text such as "directory not writable by <user>" embeds them.
function scrubArtifact(text) {
  let t = text;
  const root = process.env.PARITY_UPSTREAM_ROOT;
  if (root) t = t.split(root).join("<HEADLONG_ROOT>");
  const home = os.homedir();
  if (home && home !== "/") t = t.split(home).join("<HOME>");
  const user = os.userInfo().username;
  if (user && user.length > 2) t = t.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "<USER>");
  return t;
}
fs.writeFileSync(path.join(HERE, "report.md"), scrubArtifact(md));
fs.writeFileSync(
  path.join(HERE, "results.json"),
  scrubArtifact(JSON.stringify({ total, passed, byteExact: byteExactCount, deviations: deviationCount, rate, results }, null, 2)),
);

console.log(`traj parity: ${passed}/${total} (${rate}%) — ${byteExactCount} byte-identical + ${deviationCount} documented deviations, ${diverged.length} DIVERGE`);
for (const r of results) {
  if (!r.byteExact) {
    const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
    const tag = r.deviation ? "DEVIATION" : "DIVERGE ";
    console.log(`  ${tag} ${r.group}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
  }
}
process.exit(diverged.length === 0 ? 0 : 1);
