#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `mem` subsystem.
//
// Runs the REAL Bash tool (headlong/bin/mem) and the TS port
// (headlong-ts/bin/mem.mjs) on identical inputs in isolated scratch sandboxes,
// then diffs stdout + stderr + exit code + on-disk effects. One scenario per
// subcommand / flag / error path, harvested from the Bash source.
//
// The tool is self-contained (no Headlong identity needed); the only external
// dependency is `llm`, invoked by `mem search`. MODEL LEG: each side runs its OWN
// real `llm` (upstream's bin/llm for upstream's mem, the port's bin/llm for the
// port's), both pointed by LLM_API_URL at ONE replay server
// (parity/support/replayModel.mjs) serving ONE recorded real DeepSeek reply
// (parity/mem/recordings/search-reply.json), served in CYCLE to every search
// scenario (labelled in the report). The search corpus, argv-derived model name
// and max_tokens are diffed through the REQUEST each side sent. The slow-model
// scenarios hold that recorded reply back (a labelled transport delay). A
// recording miss fails the run. Everything else here is a NO-MODEL layer.
// Re-record: UC_RECORD=1 UC_RECORD_ONLY=mem/ with DEEPSEEK_API_KEY in the env.
//
// Nondeterminism (wall-clock timestamp, random 8-hex id, created/updated
// datetimes) is normalized SYMMETRICALLY on both sides before comparison:
//   YYYY-MM-DD-HH-MM-SS  -> <TS>     (filename/header stamp)
//   YYYY-MM-DD HH:MM:SS  -> <DT>     (created/updated)
//   [0-9a-f]{8}          -> <HEX>    (random id)
// Everything else (structure, slug, summary, type, body, path strings, exit
// codes, error text) is compared exactly.
//
// Repeatable: `node parity/mem/run-parity.mjs`. Writes results.json + report.md
// beside this file. Exit 0 iff every scenario reaches PARITY.
//
// Before committing a regenerated report.md/results.json: Bash's own
// `${2:?}` error text embeds BASH_MEM's absolute path verbatim (a
// `dir-missing-value`-class scenario), so a local `PARITY_UPSTREAM_ROOT`/
// `PARITY_BASH_MEM` run WILL leak it into these files — test/scrub.test.ts
// catches this. Replace the real path with `<HEADLONG_ROOT>` before
// committing, matching every prior run's convention.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");                       // headlong-ts
// Path to the real Bash tool. Scrubbed to a placeholder for release; set
// PARITY_BASH_MEM=/abs/path/to/headlong/bin/mem, or PARITY_UPSTREAM_ROOT=/abs/
// path/to/headlong (the whole checkout — matches the other parity/*/run-
// parity.mjs harnesses' convention) to reproduce the run.
const BASH_MEM =
  process.env.PARITY_BASH_MEM ||
  (process.env.PARITY_UPSTREAM_ROOT && path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/mem")) ||
  "<HEADLONG_ROOT>/bin/mem";
const TS_MEM = path.join(REPO, "bin", "mem.mjs");

// Credential env vars mem_redact masks by VALUE (upstream sync 2e39a3f, 494fda1).
const CRED_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT", "ANTHROPIC_API_KEY", "LLM_API_KEY",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY", "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN", "SLACK_USER_TOKEN", "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_SECRET_KEY", "SENDGRID_API_KEY",
  "TWILIO_AUTH_TOKEN", "DATABASE_URL", "REDIS_URL", "LINEAR_API_KEY",
];

// --- the one replay model server (search scenarios) ---------------------------
const { startReplay, REPLAY_MODEL } = await import("../support/replayModel.mjs");
const UPSTREAM_BIN = path.dirname(BASH_MEM);
// TRANSPORT DELAYS (no model text): hold the recorded reply back, like a slow model.
const held = (ms) => ({ main: { "*": { recorded: true, delayMs: ms } } });
const replay = await startReplay({
  suite: "mem",
  dir: path.join(HERE, "recordings"),
  recordingOf: () => "search-reply", // every search scenario shares ONE short recorded reply
  cycle: true,
  forwardModel: REPLAY_MODEL,
  fixtures: {
    "search-heartbeat-fires-while-llm-is-slow": held(2500),
    "search-heartbeat-disabled-string-zero": held(1200),
    "search-times-out-rc124": held(6000),
    "search-timeout-zero-waits": held(1000),
  },
});

// --- normalization ------------------------------------------------------------
function normalize(s) {
  if (s == null) return s;
  return s
    .replace(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<DT>")
    .replace(/[0-9a-f]{8}/g, "<HEX>")
    // 69fddc6 heartbeat: real-clock timing can make the LINE COUNT differ by
    // one between the two sides (process-scheduling jitter around the
    // sleep/kill boundary) without either side being wrong. Collapse a run
    // of heartbeat lines to one marker so the scenario still proves the
    // heartbeat fires (or doesn't) without asserting an exact count.
    .replace(/(?:mem search: waiting for the model\.\.\.\n)+/g, "<HEARTBEAT>\n");
}

// --- on-disk state serialization ---------------------------------------------
function walk(dir, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else acc.push({ rel, content: fs.readFileSync(full, "utf8") });
  }
}
function serializeState(memdirAbs) {
  if (!fs.existsSync(memdirAbs)) return "<no memdir>";
  const acc = [];
  walk(memdirAbs, "", acc);
  if (acc.length === 0) return "<empty memdir>";
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

// --- run one tool in a fresh sandbox -----------------------------------------
function makeSandbox(seed) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "mem-parity-sb-"));
  if (seed.memrc != null) fs.writeFileSync(path.join(sb, ".memrc"), seed.memrc);
  if (seed.files) {
    for (const f of seed.files) {
      const abs = path.join(sb, seed.memdirRel, f.name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
  }
  return sb;
}

async function runTool(kind, scenario, sb) {
  const env = { ...process.env };
  delete env.MEM_DIR;
  delete env.MEM_TYPE;
  delete env.SHELLM_FAST_MODEL;
  delete env.MEM_SEARCH_TOP;
  delete env.MEM_SEARCH_MAX_TOKENS;
  delete env.MEM_SEARCH_HEARTBEAT_S;
  delete env.MEM_SEARCH_TIMEOUT_S;
  for (const n of CRED_VARS) delete env[n]; // hermetic: the redaction value rule reads these
  env.LC_ALL = "C";                                  // pin locale for reproducibility
  // Each side's own real `llm` first on PATH, routed to the replay server.
  env.PATH = `${kind === "bash" ? UPSTREAM_BIN : path.join(REPO, "bin")}:${env.PATH}`;
  Object.assign(env, {
    LLM_PROVIDER: "openai-compatible",
    LLM_API_URL: replay.url(scenario.name, kind === "bash" ? "upstream" : "port"),
    LLM_API_KEY: "replay-not-a-key",
    LLM_RETRY_BACKOFF: "0",
    LLM_MODEL: REPLAY_MODEL,
  });
  Object.assign(env, scenario.env || {});

  const argv = kind === "bash" ? scenario.argv : [TS_MEM, ...scenario.argv];
  const cmd = kind === "bash" ? BASH_MEM : "node";

  // Async: the replay server lives in this process, so a blocking spawnSync would starve it.
  const res = await new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: sb, env });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("error", () => {});
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(scenario.stdin ?? "");
  });

  const memdirAbs = path.resolve(sb, scenario.memdirRel);
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
    signal: res.signal,
    state: serializeState(memdirAbs),
  };
}

// --- scenario definitions -----------------------------------------------------
// Shared fixtures with FIXED ts/hex so read paths are byte-stable.
const FIX = {
  first: {
    name: "2026-01-01-01-00-00_aaaaaaaa_first.md",
    content:
      "---\nid: aaaaaaaa\nsummary: first sum\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nfirst body\n",
  },
  second: {
    name: "2026-02-02-02-00-00_bbbbbbbb_second.md",
    content:
      "---\nid: bbbbbbbb\nsummary: second sum\ntype: note\ncreated: 2026-02-02 02:00:00\n---\n\nsecond body\n",
  },
  third: {
    name: "2026-03-03-03-00-00_cccccccc_third.md",
    content:
      "---\nid: cccccccc\nsummary: third sum\ntype: goal\ncreated: 2026-03-03 03:00:00\n---\n\nthird body\n",
  },
  legacy: {
    // legacy (no hex id) filename
    name: "2026-04-04-04-00-00_legacy-note.md",
    content: "---\ntype: fact\ncreated: 2026-04-04 04:00:00\n---\n\nlegacy body\n",
  },
  noSummary: {
    name: "2026-05-05-05-00-00_dddddddd_no-summary.md",
    content: "---\nid: dddddddd\ntype: fact\n---\n\nx\n",
  },
  // --- prefilter/BM25 scoring fixtures (1c: 766a290, 69fddc6, 130796a) --------
  dogs: {
    name: "2026-04-10-04-00-00_d0000001_dogs.md",
    content:
      "---\nid: d0000001\ntype: note\ncreated: 2026-04-10 04:00:00\n---\n\n" +
      "dogs are loyal pets, dogs love long walks, dogs bark at strangers\n",
  },
  astro: {
    name: "2026-04-11-04-00-00_d0000002_astro.md",
    content:
      "---\nid: d0000002\ntype: note\ncreated: 2026-04-11 04:00:00\n---\n\n" +
      "quantum entanglement and orbital mechanics research notes\n",
  },
  cafeMultibyte: {
    name: "2026-04-12-04-00-00_d0000003_cafe.md",
    content:
      "---\nid: d0000003\ntype: note\ncreated: 2026-04-12 04:00:00\n---\n\n" +
      "café über señor — 日本語 memo, also mentions dogs and cats\n",
  },
  // --- until: fixtures (1c: 130796a add, 51a8585 edit) ------------------------
  passport: {
    name: "2026-06-15-06-00-00_e0000001_passport.md",
    content:
      "---\nid: e0000001\nsummary: renew passport\ntype: memory\n" +
      "created: 2026-06-15 06:00:00\nuntil: 2026-12-31\n---\n\nrenew passport\n",
  },
  noUntil: {
    name: "2026-06-16-06-00-00_e0000002_no-until.md",
    content:
      "---\nid: e0000002\nsummary: a plain memory\ntype: memory\n" +
      "created: 2026-06-16 06:00:00\n---\n\na plain memory\n",
  },
};

FIX.scheduled = {
  name: "2026-07-01-07-00-00_e0000003_standup.md",
  content:
    "---\nid: e0000003\nsummary: stand up\ntype: todo\ncreated: 2026-07-01 07:00:00\n" +
    "schedule: 09:00 17:00\ntz: America/New_York\n---\n\nstand up\n",
};
FIX.scheduledUntil = {
  name: "2026-07-02-07-00-00_e0000004_all.md",
  content:
    "---\nid: e0000004\nsummary: all\ntype: todo\ncreated: 2026-07-02 07:00:00\n" +
    "until: 2027-01-01\nschedule: 08:30\ntz: UTC\n---\n\nall\n",
};

const D = "./.memories"; // default memdir (cwd-relative)

const scenarios = [
  // ---- global / dispatch ----
  { group: "global", name: "version", argv: ["--version"], memdirRel: D },
  { group: "global", name: "help-short", argv: ["-h"], memdirRel: D },
  { group: "global", name: "help-long", argv: ["--help"], memdirRel: D },
  { group: "global", name: "no-args-usage", argv: [], memdirRel: D },
  { group: "global", name: "unknown-command", argv: ["bogus"], memdirRel: D },
  {
    group: "global",
    name: "dir-missing-value",
    argv: ["--dir"],
    memdirRel: D,
    note: "probes bash ${2:?} error vs port's clean message",
  },

  // ---- add ----
  { group: "add", name: "add-basic", argv: ["add", "Hello World test!"], memdirRel: D },
  { group: "add", name: "add-multiword-args", argv: ["add", "buy", "milk", "today"], memdirRel: D },
  { group: "add", name: "add-type-flag", argv: ["add", "--type", "todo", "finish port"], memdirRel: D },
  { group: "add", name: "add-stdin", argv: ["add"], stdin: "from stdin line1\nline2\n", memdirRel: D },
  { group: "add", name: "add-empty-stdin-dies", argv: ["add"], stdin: "", memdirRel: D },
  { group: "add", name: "add-whitespace-only-stdin-dies", argv: ["add"], stdin: "\n\n\n", memdirRel: D },
  { group: "add", name: "add-env-dir", argv: ["add", "env dir mem"], env: { MEM_DIR: "./envmem" }, memdirRel: "./envmem" },
  {
    group: "add",
    name: "add-env-type-ignored-without-memrc",
    argv: ["add", "typed via env"],
    env: { MEM_TYPE: "belief" },
    memdirRel: D,
    note: "MEM_TYPE honored only when .memrc exists — should stay 'memory'",
  },
  { group: "add", name: "add-verbose-debug", argv: ["-v", "add", "verbose add"], memdirRel: D },
  {
    group: "add",
    name: "add-long-first-line-summary",
    argv: ["add", "X".repeat(120) + " tail"],
    memdirRel: D,
    note: "summary sliced to 80 (add: char/cut -c)",
  },
  {
    group: "add",
    name: "add-multibyte",
    argv: ["add", "café ÜBER señor — 日本語 memo"],
    memdirRel: D,
    note: "probes C-locale byte-wise tr/cut vs JS char-wise slug/summary",
  },

  // ---- M1: empty-string required flag values (bash ${2:?} dies on empty) ----
  {
    group: "empty-required",
    name: "add-type-empty-dies",
    argv: ["add", "--type", "", "hello world"],
    memdirRel: D,
    note: "M1: --type '' — bash ${2:?} dies rc1 no file; port now dies rc1 no file (differ only on stderr wording)",
  },
  {
    group: "empty-required",
    name: "list-type-empty-dies",
    argv: ["list", "--type", ""],
    seedFiles: ["first"],
    memdirRel: D,
    note: "M1: list --type '' — both rc1, empty stdout, unchanged state; stderr wording only",
  },
  {
    group: "empty-required",
    name: "list-before-empty-dies",
    argv: ["list", "--before", ""],
    seedFiles: ["first"],
    memdirRel: D,
    note: "M1: list --before '' — both rc1; stderr wording only",
  },
  {
    group: "empty-required",
    name: "dir-empty-dies",
    argv: ["--dir", "", "list"],
    seedFiles: ["first"],
    memdirRel: D,
    note: "M1: --dir '' — both rc1; stderr wording only",
  },
  {
    group: "empty-required",
    name: "edit-slug-empty-dies",
    argv: ["edit", "aaaaaaaa", "--slug", "", "new body"],
    seedFiles: ["first"],
    memdirRel: D,
    note: "M1: edit --slug '' — bash dies rc1 file untouched; port now dies rc1 file untouched (stderr wording only)",
  },

  // ---- list ----
  {
    group: "list",
    name: "list-verbose-default",
    argv: ["list"],
    seedFiles: ["first", "second"],
    memdirRel: D,
  },
  { group: "list", name: "list-short", argv: ["list", "-s"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-type-filter", argv: ["list", "-s", "--type", "note"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-before", argv: ["list", "-s", "--before", "2026-01-31"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-after", argv: ["list", "-s", "--after", "2026-02-02"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-before-inclusive-boundary", argv: ["list", "-s", "--before", "2026-01-01"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-limit-N", argv: ["list", "-s", "1"], seedFiles: ["first", "second", "third"], memdirRel: D },
  { group: "list", name: "list-limit-zero", argv: ["list", "-s", "0"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-limit-larger-than-count", argv: ["list", "-s", "99"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "list", name: "list-legacy-id-dashes", argv: ["list"], seedFiles: ["legacy"], memdirRel: D },
  { group: "list", name: "list-short-summary-fallback-to-slug", argv: ["list", "-s"], seedFiles: ["noSummary"], memdirRel: D },
  { group: "list", name: "list-empty-store", argv: ["list"], memdirRel: "./empty" },
  { group: "list", name: "list-unknown-option", argv: ["list", "--bogus"], seedFiles: ["first"], memdirRel: D },
  { group: "list", name: "list-type-missing-value", argv: ["list", "--type"], seedFiles: ["first"], memdirRel: D, note: "probes bash ${2:?} error vs port" },
  { group: "list", name: "list-dir-flag", argv: ["--dir", "./custom", "list", "-s"], seedFiles: ["first"], memdirRel: "./custom" },

  // ---- types ----
  { group: "types", name: "types-counts", argv: ["types"], seedFiles: ["first", "second", "third"], memdirRel: D },
  { group: "types", name: "types-empty-store", argv: ["types"], memdirRel: "./empty", note: "quirk: empty exits non-zero, no output" },

  // ---- show ----
  { group: "show", name: "show-by-hex-prefix", argv: ["show", "aaaa"], seedFiles: ["first"], memdirRel: D },
  { group: "show", name: "show-by-full-hex", argv: ["show", "aaaaaaaa"], seedFiles: ["first"], memdirRel: D },
  { group: "show", name: "show-by-exact-filename", argv: ["show", "2026-01-01-01-00-00_aaaaaaaa_first"], seedFiles: ["first"], memdirRel: D },
  { group: "show", name: "show-not-found", argv: ["show", "ffffffff"], seedFiles: ["first"], memdirRel: D },
  { group: "show", name: "show-ambiguous", argv: ["show", "aaaa"], seedFiles: ["first", "firstDup"], memdirRel: D },
  { group: "show", name: "show-no-arg", argv: ["show"], seedFiles: ["first"], memdirRel: D },

  // ---- forget ----
  { group: "forget", name: "forget-by-id", argv: ["forget", "aaaaaaaa"], seedFiles: ["first", "second"], memdirRel: D },
  { group: "forget", name: "forget-not-found", argv: ["forget", "ffffffff"], seedFiles: ["first"], memdirRel: D },
  { group: "forget", name: "forget-no-arg", argv: ["forget"], seedFiles: ["first"], memdirRel: D },
  { group: "forget", name: "forget-verbose", argv: ["-v", "forget", "aaaaaaaa"], seedFiles: ["first"], memdirRel: D },

  // ---- edit ----
  { group: "edit", name: "edit-body-rename-slug", argv: ["edit", "aaaaaaaa", "brand new body"], seedFiles: ["first"], memdirRel: D },
  { group: "edit", name: "edit-slug-flag", argv: ["edit", "aaaaaaaa", "--slug", "My Custom Slug", "text body"], seedFiles: ["first"], memdirRel: D },
  { group: "edit", name: "edit-stdin", argv: ["edit", "aaaaaaaa"], stdin: "edited via stdin\n", seedFiles: ["first"], memdirRel: D },
  { group: "edit", name: "edit-no-text-dies", argv: ["edit", "aaaaaaaa"], stdin: "", seedFiles: ["first"], memdirRel: D },
  { group: "edit", name: "edit-not-found", argv: ["edit", "ffffffff", "x"], seedFiles: ["first"], memdirRel: D },
  { group: "edit", name: "edit-no-arg", argv: ["edit"], seedFiles: ["first"], memdirRel: D },
  {
    group: "edit",
    name: "edit-existing-single-updated-to-list",
    argv: ["edit", "eeeeeeee", "second edit"],
    seedFilesRaw: [
      {
        name: "2026-06-06-06-00-00_eeeeeeee_has-updated.md",
        content:
          "---\nid: eeeeeeee\nsummary: s\ntype: goal\ncreated: 2026-06-06 06:00:00\nupdated: 2026-06-06 07:00:00\n---\n\nbody\n",
      },
    ],
    memdirRel: D,
    note: "single updated -> YAML list",
  },
  {
    group: "edit",
    name: "edit-existing-list-updated-append",
    argv: ["edit", "ffffaaaa", "third edit"],
    seedFilesRaw: [
      {
        name: "2026-07-07-07-00-00_ffffaaaa_has-list.md",
        content:
          "---\nid: ffffaaaa\nsummary: s\ntype: goal\ncreated: 2026-07-07 07:00:00\nupdated:\n  - 2026-07-07 08:00:00\n  - 2026-07-07 09:00:00\n---\n\nbody\n",
      },
    ],
    memdirRel: D,
    note: "append to existing updated list",
  },
  {
    group: "edit",
    name: "edit-same-slug-no-rename",
    argv: ["edit", "aaaaaaaa", "first"],
    seedFilesRaw: [
      {
        name: "2026-01-01-01-00-00_aaaaaaaa_first.md",
        content:
          "---\nid: aaaaaaaa\nsummary: first sum\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nold\n",
      },
    ],
    memdirRel: D,
    note: "derived slug equals existing -> filename unchanged",
  },

  // ---- search ----
  {
    group: "search",
    name: "search-with-fast-model",
    argv: ["search", "feline", "friends"],
    env: { SHELLM_FAST_MODEL: "fast-1" },
    seedFiles: ["first", "second"],
    memdirRel: D,
  },
  { group: "search", name: "search-no-fast-model", argv: ["search", "orbit"], seedFiles: ["first"], memdirRel: D },
  {
    group: "search",
    name: "search-empty-store",
    argv: ["search", "q"],
    memdirRel: "./empty",
    note: "FIXED (766a290): empty store now prints 'No memories stored.' and exits 0, not a silent rc-1 (the old count=$(ls|wc-l) pipeline died under set -e+pipefail before Bash added `|| count=0`)",
  },
  { group: "search", name: "search-no-query", argv: ["search"], seedFiles: ["first"], memdirRel: D },

  // ---- search: two-stage BM25 prefilter (1c: 766a290, 69fddc6, 130796a) ----
  {
    group: "search-prefilter",
    name: "search-prefilter-picks-relevant-file",
    argv: ["search", "dogs"],
    seedFiles: ["dogs", "astro"],
    memdirRel: D,
    note: "stage 1 keeps only the term-matching file; astro.md never reaches the corpus",
  },
  {
    group: "search-prefilter",
    name: "search-prefilter-multibyte-c-locale",
    argv: ["search", "dogs"],
    seedFiles: ["dogs", "astro", "cafeMultibyte"],
    memdirRel: D,
    note: "LC_ALL=C byte-wise scoring over a file with multibyte UTF-8 content",
  },
  {
    group: "search-prefilter",
    name: "search-fallback-newest-when-no-overlap",
    argv: ["search", "zzznomatch"],
    seedFiles: ["first", "second", "third"],
    memdirRel: D,
    note: "no term overlap at all -> falls back to the newest MEM_SEARCH_TOP files",
  },
  {
    group: "search-prefilter",
    name: "search-max-tokens-env",
    argv: ["search", "dogs"],
    env: { MEM_SEARCH_MAX_TOKENS: "999" },
    seedFiles: ["dogs"],
    memdirRel: D,
  },
  {
    group: "search-prefilter",
    name: "search-top-env-caps-candidates",
    argv: ["search", "alpha beta"],
    env: { MEM_SEARCH_TOP: "1" },
    seedFilesRaw: [
      { name: "2026-07-01-01-00-00_f0000001_a.md", content: "---\ntype: note\n---\n\nalpha beta gamma\n" },
      { name: "2026-07-02-01-00-00_f0000002_b.md", content: "---\ntype: note\n---\n\nalpha beta delta\n" },
    ],
    memdirRel: D,
  },

  // ---- search: heartbeat (1c: 69fddc6) — real-clock; heartbeat line RUNS are
  // normalized to a single <HEARTBEAT> marker (see normalize()) so a +/-1 line
  // count from process-scheduling jitter around the sleep/kill boundary
  // doesn't fail the scenario; presence/absence still must match exactly.
  {
    group: "search-heartbeat",
    name: "search-heartbeat-fires-while-llm-is-slow",
    argv: ["search", "dogs"],
    env: { MEM_SEARCH_HEARTBEAT_S: "1" },
    seedFiles: ["dogs"],
    memdirRel: D,
  },
  {
    group: "search-heartbeat",
    name: "search-heartbeat-disabled-string-zero",
    argv: ["search", "dogs"],
    env: { MEM_SEARCH_HEARTBEAT_S: "0" },
    seedFiles: ["dogs"],
    memdirRel: D,
  },

  // ---- mem prefilter (1c: 130796a) ----
  {
    group: "prefilter",
    name: "prefilter-basic",
    argv: ["prefilter", "dogs"],
    seedFiles: ["dogs", "astro"],
    memdirRel: D,
  },
  {
    group: "prefilter",
    name: "prefilter-top-1",
    argv: ["prefilter", "alpha beta", "--top", "1"],
    seedFilesRaw: [
      { name: "2026-07-01-01-00-00_f0000001_a.md", content: "---\ntype: note\n---\n\nalpha beta gamma\n" },
      { name: "2026-07-02-01-00-00_f0000002_b.md", content: "---\ntype: note\n---\n\nalpha beta delta\n" },
    ],
    memdirRel: D,
  },
  {
    group: "prefilter",
    name: "prefilter-no-match-no-fallback",
    argv: ["prefilter", "zzznomatch"],
    seedFiles: ["first"],
    memdirRel: D,
    note: "unlike `mem search`, `mem prefilter` does NOT fall back to the newest files",
  },
  {
    group: "prefilter",
    name: "prefilter-no-query-dies",
    argv: ["prefilter"],
    seedFiles: ["first"],
    memdirRel: D,
  },
  { group: "prefilter", name: "prefilter-empty-store", argv: ["prefilter", "q"], memdirRel: "./empty" },
  {
    group: "prefilter",
    name: "prefilter-top-missing-value",
    argv: ["prefilter", "alpha", "--top"],
    seedFiles: ["first"],
    memdirRel: D,
    note: "probes bash ${2:?} error vs port",
  },
  {
    group: "prefilter",
    name: "prefilter-top-non-numeric",
    argv: ["prefilter", "alpha", "--top", "abc"],
    seedFilesRaw: [{ name: "2026-07-01-01-00-00_f0000001_a.md", content: "---\ntype: note\n---\n\nalpha beta\n" }],
    memdirRel: D,
    note: "Bash: `head -n abc` OS error text (BSD: 'illegal line count'); port dies its own way. Same class as ${2:?} — exit code matches, stderr wording doesn't.",
  },

  // ---- add --until (1c: 130796a) ----
  { group: "add-until", name: "add-until-basic", argv: ["add", "--until", "2026-12-31", "renew passport"], memdirRel: D },
  {
    group: "add-until",
    name: "add-until-with-type-either-order",
    argv: ["add", "--until", "2026-06-01", "--type", "todo", "call the vet"],
    memdirRel: D,
  },
  {
    group: "add-until",
    name: "add-until-invalid-shape-dies",
    argv: ["add", "--until", "not-a-date", "x"],
    memdirRel: D,
  },
  {
    group: "add-until",
    name: "add-until-impossible-calendar-date-accepted",
    argv: ["add", "--until", "2026-13-45", "x"],
    memdirRel: D,
    note: "shape-only regex check, not calendar-aware",
  },
  { group: "add-until", name: "add-until-missing-value-dies", argv: ["add", "--until"], memdirRel: D, note: "probes bash ${2:?} error vs port" },

  // ---- edit preserves until: (1c: 51a8585) ----
  {
    group: "edit-until",
    name: "edit-preserves-until",
    argv: ["edit", "e0000001", "renew passport abroad"],
    seedFiles: ["passport"],
    memdirRel: D,
  },
  {
    group: "edit-until",
    name: "edit-no-until-stays-absent",
    argv: ["edit", "e0000002", "an edited plain memory"],
    seedFiles: ["noUntil"],
    memdirRel: D,
  },

  // ---- .memrc ----
  {
    group: "memrc",
    name: "memrc-supplies-dir-and-type",
    argv: ["add", "from rc"],
    memrc: "MEM_DIR=./rcmem\nMEM_TYPE=belief\n",
    memdirRel: "./rcmem",
    note: ".memrc provides MEM_DIR + MEM_TYPE",
  },
  {
    group: "memrc",
    name: "memrc-env-dir-overrides",
    argv: ["add", "env wins"],
    memrc: "MEM_DIR=./rcmem\nMEM_TYPE=belief\n",
    env: { MEM_DIR: "./envwins" },
    memdirRel: "./envwins",
    note: "env MEM_DIR beats rc MEM_DIR (type still belief from rc)",
  },
  {
    group: "memrc",
    name: "memrc-enables-env-type",
    argv: ["add", "typed"],
    memrc: "MEM_DIR=./rcmem\n",
    env: { MEM_TYPE: "fact", MEM_DIR: "./rcmem" },
    memdirRel: "./rcmem",
    note: "with .memrc present, env MEM_TYPE now applies",
  },
  // ======================= upstream sync 2e39a3f, lane (b) =======================
  // ---- unknown flags are refused, not stored as the memory's first word ----
  ...[
    ["add-unknown-long-flag", ["add", "--content", "hello"]],
    ["add-unknown-short-flag", ["add", "-h"]],
    ["add-unknown-flag-after-known", ["add", "--type", "todo", "--bogus", "x"]],
    ["add-lone-dash-word", ["add", "-5 degrees today"]],
  ].map(([name, argv]) => ({ group: "flags2", name, argv, memdirRel: D })),
  { group: "flags2", name: "edit-unknown-flag", argv: ["edit", "aaaaaaaa", "--apply", "new body"], seedFiles: ["first"], memdirRel: D },
  { group: "flags2", name: "edit-slug-then-unknown-flag", argv: ["edit", "aaaaaaaa", "--slug", "foo", "--apply", "x"], seedFiles: ["first"], memdirRel: D },
  { group: "flags2", name: "edit-two-slugs-last-wins", argv: ["edit", "aaaaaaaa", "--slug", "one", "--slug", "two", "body text"], seedFiles: ["first"], memdirRel: D },
  { group: "flags2", name: "add-dash-text-on-stdin-accepted", argv: ["add"], stdin: "-5 degrees today\n", memdirRel: D },
  // ---- blank-leading / whitespace-only bodies ----
  { group: "blank", name: "add-whitespace-arg-reads-stdin", argv: ["add", "   "], stdin: "real text\n", memdirRel: D },
  { group: "blank", name: "add-whitespace-arg-and-stdin-dies", argv: ["add", "  "], stdin: " \n\t\n", memdirRel: D },
  { group: "blank", name: "add-blank-leading-stdin-summary", argv: ["add"], stdin: "\n\n  \nfirst real line\nsecond\n", memdirRel: D },
  { group: "blank", name: "add-blank-leading-arg-summary", argv: ["add", "\n\nfirst real\nsecond"], memdirRel: D },
  { group: "blank", name: "edit-blank-leading-summary", argv: ["edit", "aaaaaaaa", "\n \nreal line\nmore"], seedFiles: ["first"], memdirRel: D },
  // `cut -c` counts characters only in a UTF-8 locale (the harness pins C elsewhere) — this one scenario runs under UTF-8.
  { group: "blank", name: "edit-summary-counts-chars-not-bytes", argv: ["edit", "aaaaaaaa", "é".repeat(100)], seedFiles: ["first"], env: { LC_ALL: "en_US.UTF-8" }, memdirRel: D },
  { group: "blank", name: "add-summary-counts-chars-utf8", argv: ["add", "é".repeat(100)], env: { LC_ALL: "en_US.UTF-8" }, memdirRel: D },
  { group: "blank", name: "add-summary-80-chars", argv: ["add", "x".repeat(120)], memdirRel: D },
  // ---- flag-looking summary warns, still stores ----
  ...[
    ["warn-long-flag", "--foo bar\nbody"],
    ["warn-short-flag", "-x y"],
    ["warn-leading-space-flag", "   -v thing"],
    ["warn-blank-leading-flag", "\n--apply it"],
    ["nowarn-number", "-5 degrees"],
    ["nowarn-lone-dash", "- bullet"],
    ["nowarn-triple-dash", "--- rule"],
    ["warn-flag-glued", "--x=y"],
  ].map(([name, stdin]) => ({ group: "flagwarn", name, argv: ["add"], stdin, memdirRel: D })),
  { group: "flagwarn", name: "warn-on-edit-stdin", argv: ["edit", "aaaaaaaa"], stdin: "--apply thing\n", seedFiles: ["first"], memdirRel: D },
  // ---- add --schedule / --tz, and their survival through edit ----
  { group: "schedule", name: "add-schedule-tz", argv: ["add", "--schedule", "09:00 17:00", "--tz", "America/New_York", "stand up"], memdirRel: D },
  { group: "schedule", name: "add-schedule-only", argv: ["add", "--schedule", "09:00", "check inbox"], memdirRel: D },
  { group: "schedule", name: "add-tz-only", argv: ["add", "--tz", "UTC", "note"], memdirRel: D },
  { group: "schedule", name: "add-schedule-trailing-space", argv: ["add", "--schedule", "09:00 ", "x"], memdirRel: D },
  { group: "schedule", name: "add-schedule-with-until-and-type", argv: ["add", "--until", "2027-01-01", "--schedule", "08:30 12:00", "--type", "todo", "--tz", "Europe/Paris", "mixed"], memdirRel: D },
  { group: "schedule", name: "add-schedule-hour-29-accepted", argv: ["add", "--schedule", "29:59", "loose hour"], memdirRel: D },
  ...[
    ["bad-shape", "9:00"],
    ["bad-minutes", "09:60"],
    ["double-space", "09:00  17:00"],
    ["comma", "09:00,17:00"],
    ["leading-space", " 09:00"],
  ].map(([name, v]) => ({ group: "schedule", name: `add-schedule-${name}-dies`, argv: ["add", "--schedule", v, "x"], memdirRel: D })),
  { group: "schedule", name: "edit-preserves-schedule-and-tz", argv: ["edit", "e0000003", "rewritten standup"], seedFiles: ["scheduled"], memdirRel: D },
  { group: "schedule", name: "edit-preserves-until-schedule-tz-order", argv: ["edit", "e0000004", "all three"], seedFiles: ["scheduledUntil"], memdirRel: D },
  // ---- redaction at the write point (494fda1 #155) ----
  ...(() => {
    const j = (...p) => p.join("");
    const shapes = {
      "github-classic": j("ghp", "_", "A".repeat(30)),
      "github-oauth": j("gho", "_", "b".repeat(25)),
      "github-fine": j("github_pat", "_", "A".repeat(25)),
      "slack": j("xoxb", "-1234567890-abcdefghij"),
      "sk-key": j("sk", "-", "a".repeat(30)),
      "sk-proj": j("sk-proj", "-abc_def.ghi=", "x".repeat(20)),
      "hf": j("hf", "_", "A".repeat(25)),
      "google": j("AIza", "A".repeat(35)),
      "aws-akia": j("AKIA", "A".repeat(16)),
      "aws-asia": j("ASIA", "B".repeat(16)),
      "jwt": j("eyJhbGciOiJI", ".", "eyJzdWIiOiIxMjM0", ".", "abcdefghijklmnop"),
      "basic-auth": j("https://user:", "hunter2pass", "@example.com/x"),
      "docker-auth": j('{"auth": "', "QWxhZGRpbjpvcGVuIHNlc2FtZQ==", '"}'),
      "stripe-live": j("sk_live", "_", "a1b2c3d4e5"),
      "stripe-restricted": j("rk_live", "_", "a1b2c3d4e5"),
      "stripe-hook": j("whsec", "_", "a1b2c3d4e5"),
      "npm": j("npm", "_", "a".repeat(24)),
      "gitlab": j("glpat", "-", "abcdefghij12"),
      "docker-pat": j("dckr_pat", "-", "abcdefghij12"),
      "sendgrid": j("SG", ".", "abcdefghij12", ".", "klmnopqrst34"),
      "twilio": j("SK", "0123456789abcdef0123456789abcdef"),
      "mailgun": j("key", "-", "a".repeat(24)),
      "aws-secret-eq": j("aws_secret_access_key", "=", "wJalrXUtnFEMI/K7MDENG"),
      "aws-secret-colon-spaced": j("AWS_SECRET_ACCESS_KEY", " : ", "wJalrXUtnFEMI"),
    };
    const out = Object.entries(shapes).map(([name, secret]) => ({
      group: "redact", name: `shape-${name}`, argv: ["add"], stdin: `before ${secret} after\nsecond line\n`, memdirRel: D,
    }));
    // boundary behavior of the `(^|[^A-Za-z0-9])` prefixes
    out.push({ group: "redact", name: "sk-prefix-glued-to-alnum-not-masked", argv: ["add"], stdin: j("xsk", "-", "a".repeat(30), "\n"), memdirRel: D });
    out.push({ group: "redact", name: "sk-at-line-start-masked", argv: ["add"], stdin: j("sk", "-", "a".repeat(30), " tail\n"), memdirRel: D });
    out.push({ group: "redact", name: "two-keys-one-line", argv: ["add"], stdin: j("a ", "ghp", "_", "A".repeat(22), " b ", "ghp", "_", "B".repeat(22), " c\n"), memdirRel: D });
    out.push({ group: "redact", name: "short-lookalikes-left-alone", argv: ["add"], stdin: "sk-short ghp_tooshort hf_word AKIA123 eyJ.a.b xox-x\n", memdirRel: D });
    out.push({ group: "redact", name: "redacted-in-argv-text", argv: ["add", j("token ghp", "_", "A".repeat(30), " here")], memdirRel: D });
    out.push({ group: "redact", name: "redacted-summary-and-filename", argv: ["add"], stdin: j("ghp", "_", "A".repeat(30), "\nbody\n"), memdirRel: D });
    out.push({ group: "redact", name: "edit-redacts-body", argv: ["edit", "aaaaaaaa"], stdin: j("new ghp", "_", "A".repeat(30), "\n"), seedFiles: ["first"], memdirRel: D });
    out.push({ group: "redact", name: "edit-redacts-slug", argv: ["edit", "aaaaaaaa", "--slug", j("tok-ghp", "_", "A".repeat(30)), "body"], seedFiles: ["first"], memdirRel: D });
    // env VALUE rule: any length ≥ 8 literal, in list order; < 8 untouched
    out.push({ group: "redact", name: "env-value-masked", argv: ["add"], stdin: "my secret is hunter2-secret ok\n", env: { GITHUB_TOKEN: "hunter2-secret" }, memdirRel: D });
    out.push({ group: "redact", name: "env-value-short-not-masked", argv: ["add"], stdin: "pw abc1234 here\n", env: { GITHUB_TOKEN: "abc1234" }, memdirRel: D });
    out.push({ group: "redact", name: "env-value-8-chars-masked", argv: ["add"], stdin: "pw abc12345 here abc12345\n", env: { LINEAR_API_KEY: "abc12345" }, memdirRel: D });
    out.push({ group: "redact", name: "env-value-glob-chars-literal", argv: ["add"], stdin: "x x*y?[z]+more xxyaz+more\n", env: { DATABASE_URL: "x*y?[z]+more" }, memdirRel: D });
    out.push({ group: "redact", name: "env-two-values", argv: ["add"], stdin: "a firsttoken1 b secondtoken2\n", env: { GH_TOKEN: "firsttoken1", REDIS_URL: "secondtoken2" }, memdirRel: D });
    out.push({ group: "redact", name: "env-value-in-slug-and-summary", argv: ["add"], stdin: "hunter2-secret\n", env: { SLACK_TOKEN: "hunter2-secret" }, memdirRel: D });
    // PEM blocks
    const B = (k) => j("-----BEGIN ", k, "PRIVATE KEY-----");
    const E = (k) => j("-----END ", k, "PRIVATE KEY-----");
    for (const k of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
      out.push({ group: "pem", name: `pem-${k.trim() || "plain"}`, argv: ["add"], stdin: `lead\n${B(k)}\nBODY\nBODY2\n${E(k)}\ntrail\n`, memdirRel: D });
    }
    out.push({ group: "pem", name: "pem-inline-boundary-text-kept", argv: ["add"], stdin: `before ${B("")}\nBODY\n${E("")} after\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-two-blocks", argv: ["add"], stdin: `${B("")}\nA\n${E("")}\nmid\n${B("RSA ")}\nB\n${E("RSA ")}\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-one-line-block", argv: ["add"], stdin: `x ${B("")}BODY${E("")} y\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-incomplete-dies", argv: ["add"], stdin: `${B("")}\nBODY\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-wrong-footer-kind-dies", argv: ["add"], stdin: `${B("RSA ")}\nBODY\n${E("")}\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-nested-dies", argv: ["add"], stdin: `${B("")}\nA\n${B("")}\nB\n${E("")}\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-nested-other-kind-dies", argv: ["add"], stdin: `${B("")}\nA\n${B("EC ")}\nB\n${E("")}\n`, memdirRel: D });
    out.push({ group: "pem", name: "pem-edit-incomplete-leaves-file", argv: ["edit", "aaaaaaaa"], stdin: `${B("")}\nBODY\n`, seedFiles: ["first"], memdirRel: D });
    out.push({ group: "pem", name: "pem-slug-incomplete-dies", argv: ["edit", "aaaaaaaa", "--slug", B(""), "ok body"], seedFiles: ["first"], memdirRel: D });
    // payment cards (issuer prefix + Luhn)
    const cards = {
      "visa16": "4111111111111111", "visa16-spaces": "4111 1111 1111 1111", "visa16-hyphens": "4111-1111-1111-1111",
      "visa13": "4222222222222", "visa19": "4111111111111111110", "amex": "378282246310005", "amex-spaced": "3782 822463 10005",
      "mc": "5555555555554444", "mc-2series": "2223003122003222", "discover": "6011111111111117", "discover-65": "6500000000000002",
      "jcb": "3530111333300000", "luhn-fail": "4111111111111112", "date-like": "2026-10-27 12:34:56", "digits-year-list": "2019 2020 2021 2022",
      "unknown-issuer": "9111111111111111", "visa-with-cvv-23": "4111 1111 1111 1111 123", "visa-then-card": "4111 1111 1111 1111 5555 5555 5555 4444",
      "alnum-before": "x4111111111111111", "alnum-after": "4111111111111111x", "underscore-before": "_4111111111111111",
      "dash-before": "-4111111111111111", "long-digits-20": "41111111111111111111", "two-cards-line": "4111111111111111 and 5555555555554444",
    };
    for (const [name, c] of Object.entries(cards)) {
      out.push({ group: "cards", name: `card-${name}`, argv: ["add"], stdin: `pay with ${c} please\nnext ${c}\n`, memdirRel: D });
    }
    out.push({ group: "cards", name: "card-at-line-edges", argv: ["add"], stdin: "4111111111111111\n5555555555554444", memdirRel: D });
    return out;
  })(),
  // ---- search stage-2 deadline (2a63d92, issue 119) ----
  { group: "timeout", name: "search-times-out-rc124", argv: ["search", "alpha"], seedFiles: ["first", "second"], env: { MEM_SEARCH_TIMEOUT_S: "1", MEM_SEARCH_HEARTBEAT_S: "0" }, memdirRel: D,
    note: "Bash job control prints `bin/mem: line N: <pid> Killed: 9  _search_worker` to stderr when the watchdog SIGKILLs the worker group (embeds the script path + a pid); the port has no such shell notice. rc 124, stdout, the one-line timeout message and state match. Same class as the ${2:?} text deviation." },
  { group: "timeout", name: "search-fast-under-deadline", argv: ["search", "alpha"], seedFiles: ["first", "second"], env: { MEM_SEARCH_TIMEOUT_S: "5" }, memdirRel: D },
  { group: "timeout", name: "search-timeout-zero-waits", argv: ["search", "alpha"], seedFiles: ["first"], env: { MEM_SEARCH_TIMEOUT_S: "0", MEM_SEARCH_HEARTBEAT_S: "0" }, memdirRel: D },
  { group: "timeout", name: "search-timeout-junk-falls-back-to-300", argv: ["search", "alpha"], seedFiles: ["first"], env: { MEM_SEARCH_TIMEOUT_S: "soon" }, memdirRel: D },
];

// firstDup fixture (for ambiguity)
FIX.firstDup = {
  name: "2026-09-09-09-00-00_aaaa9999_dup.md",
  content: "---\nid: aaaa9999\nsummary: dup\ntype: note\n---\n\ndup body\n",
};

// --- execute ------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  const files = [];
  if (sc.seedFiles) for (const key of sc.seedFiles) files.push(FIX[key]);
  if (sc.seedFilesRaw) for (const f of sc.seedFilesRaw) files.push(f);
  const seed = { memrc: sc.memrc, files, memdirRel: sc.memdirRel };

  const sbBash = makeSandbox(seed);
  const sbTs = makeSandbox(seed);
  let bash, ts;
  try {
    bash = await runTool("bash", sc, sbBash);
    ts = await runTool("ts", sc, sbTs);
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }

  const cmp = {
    stdout: normalize(bash.stdout) === normalize(ts.stdout),
    stderr: normalize(bash.stderr) === normalize(ts.stderr),
    status: bash.status === ts.status,
    state: normalize(bash.state) === normalize(ts.state),
  };
  // The model request each side's real llm sent (model, messages = the search corpus, max_tokens), diffed too.
  const reqs = (side) => replay.requests(sc.name, side).map((r) => ({ model: r.body.model, max_tokens: r.body.max_tokens, messages: r.body.messages }));
  const rb = reqs("upstream"), rt = reqs("port");
  if (rb.length || rt.length) {
    cmp.modelRequest = JSON.stringify(rb) === JSON.stringify(rt);
    bash.modelRequests = rb;
    ts.modelRequests = rt;
  }
  const pass = Object.values(cmp).every(Boolean);
  results.push({
    group: sc.group,
    name: sc.name,
    note: sc.note,
    argv: sc.argv,
    pass,
    cmp,
    bash: { ...bash, stdoutN: normalize(bash.stdout), stderrN: normalize(bash.stderr), stateN: normalize(bash.state) },
    ts: { ...ts, stdoutN: normalize(ts.stdout), stderrN: normalize(ts.stderr), stateN: normalize(ts.state) },
  });
}

await replay.close();

// --- report -------------------------------------------------------------------
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return (
    `    ${label}: DIFFER\n` +
    `      bash: ${JSON.stringify(a)}\n` +
    `      ts  : ${JSON.stringify(b)}`
  );
}

let md = `# mem — differential parity proof\n\n`;
md += `Generated by \`parity/mem/run-parity.mjs\`. Real Bash tool \`headlong/bin/mem\` vs TS port \`headlong-ts/bin/mem.mjs\`, identical inputs, diffed stdout+stderr+exit code+on-disk state.\n\n`;
md += `- Node: \`node parity/mem/run-parity.mjs\` (Node 24). Locale pinned \`LC_ALL=C\`.\n`;
md += `- \`search\`: each side's real \`llm\` against one replay server serving ONE recorded real DeepSeek reply (\`parity/mem/recordings/search-reply.json\`) in CYCLE to every search scenario; the model requests (model, max_tokens, messages = the corpus) are diffed. Slow-model scenarios hold that reply back (transport delay fixtures). Everything else is a no-model layer.\n`;
md += `- Normalized symmetrically before compare: \`<TS>\` timestamp, \`<DT>\` created/updated, \`<HEX>\` random id. All else exact.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;

const byGroup = {};
for (const r of results) (byGroup[r.group] ??= []).push(r);
md += `| # | group | scenario | verdict | fields differing |\n|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
  md += `| ${idx++} | ${r.group} | ${r.name} | ${r.pass ? "PARITY" : "MISMATCH"} | ${diffs} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.group} / ${r.name}\n`;
  md += `- argv: \`${JSON.stringify(r.argv)}\`\n`;
  if (r.note) md += `- note: ${r.note}\n`;
  md += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  md += "```\n";
  md += block("stdout", r.bash.stdoutN, r.ts.stdoutN, r.cmp.stdout) + "\n";
  md += block("stderr", r.bash.stderrN, r.ts.stderrN, r.cmp.stderr) + "\n";
  md += block("state", r.bash.stateN, r.ts.stateN, r.cmp.state) + "\n";
  md += "```\n\n";
}

md += `## Interpretation of divergences\n\n`;
md += `Two root causes — the deliberate \`\${2:?}\` stderr-wording deviation — (plus the job-control notice, item 4) across all mismatched scenarios. Nondeterministic fields are normalized, so every other scenario is a byte-exact match of stdout, stderr, exit code, and on-disk bytes.\n\n`;
md += `1. **\`\${2:?msg}\` bash-builtin error text** (\`dir-missing-value\`, \`list-type-missing-value\`, the \`empty-required\` group \`add-type-empty-dies\` / \`list-type-empty-dies\` / \`list-before-empty-dies\` / \`dir-empty-dies\` / \`edit-slug-empty-dies\`, and — upstream sync 2, lane C — \`prefilter-top-missing-value\` and \`add-until-missing-value-dies\`) — on a missing OR empty flag value the real tool relies on bash's \`\${var:?message}\` expansion, which prints \`<script>: line N: 2: <message>\` and exits 1. The port prints its own \`mem: error: <message>\` and exits 1. **Exit code (1), stdout (empty), and on-disk state (unchanged) all match; only the stderr phrasing differs**, on a misuse path no Headlong caller inspects. Deliberate DEVIATION (bash text embeds the script's absolute path + a Bash line number — irreproducible from TS and brittle to pin); PORT-NOTE in src/mem.ts and PARITY.md. Low severity.\n\n`;
md += `   **M1 fix (upstream sync 1b):** the \`empty-required\` scenarios were previously HARD divergences — \`required()\` accepted \`""\`, so an empty flag value silently ran to completion (rc 0, wrote/renamed corrupt state). \`required()\` now rejects \`""\` like bash's \`\${2:?}\`, collapsing those to the same benign stderr-wording-only deviation above (exit + stdout + state now match).\n\n`;
md += `2. **\`MEM_TYPE\` + \`.memrc\` precedence — FIXED (upstream sync 1b; was a confirmed port bug, now PARITY).** The real tool sets \`MEM_TYPE="memory"\` *before* snapshotting \`MEM_*\` env into \`_pre_env\` and re-exporting it after \`source .memrc\`, so a set env \`MEM_TYPE\` always re-applies as \`memory\` — discarding its own value and clobbering any \`MEM_TYPE\` assigned inside \`.memrc\`. Net: **when env \`MEM_TYPE\` is set, the real tool always writes \`type: memory\`**, regardless of \`.memrc\`. Re-verified against real Bash across all branches: env-set → \`memory\` (even over rc); rc \`MEM_TYPE\` wins only when env \`MEM_TYPE\` unset; no \`.memrc\` → env \`MEM_TYPE\` ignored; empty-string env \`MEM_TYPE\` still resets to \`memory\`. Scenario \`memrc-enables-env-type\` matches (\`type: memory\` both sides).\n\n`;
md += `3. **Non-numeric \`--top\`/\`head -n\` OS error text — same class as (1), NOT a port bug** (\`prefilter-top-non-numeric\`): Bash's \`mem_prefilter\` feeds \`--top\`/\`MEM_SEARCH_TOP\` straight into \`head -n "$top"\`; a non-numeric value is a BSD-\`head\`-specific runtime error (\`head: illegal line count -- abc\`, rc 1) this port does not reproduce byte-for-byte. The port dies its own way (\`mem: error: Invalid count: abc\`), same exit code (1), on a misconfiguration path no real caller (thinkers/_lib/common.sh always passes a plain integer or leaves the var unset) exercises. PORT-NOTE in src/mem.ts (\`parseTopCount\`); PARITY.md.\n\n`;
md += `4. **Bash job-control notice on a timed-out search — same class, NOT a port bug** (\`search-times-out-rc124\`, upstream sync 2e39a3f / 2a63d92): when MEM_SEARCH_TIMEOUT_S expires the Bash watchdog SIGKILLs the worker group and the shell itself prints \`bin/mem: line N: <pid> Killed: 9 _search_worker "$@"\` (script path + pid, irreproducible). Exit code 124, stdout, the \`mem search: no reply from the model within Ns (MEM_SEARCH_TIMEOUT_S); giving up on this query.\` line, and on-disk state all match.\n\n`;
md += `**Upstream sync 2e39a3f, lane (b):** 118 new scenarios cover unknown-flag refusal (add/edit), whitespace-only and blank-leading bodies (first non-blank line is the summary, 80 chars), the flag-looking-summary warning, \`--schedule\`/\`--tz\` (and their survival through edit), credential redaction at the write point (24 shape rules, env VALUE rule, PEM blocks incl. incomplete/nested refusals, 25 payment-card layouts incl. Luhn/boundary cases, slug redaction) and the stage-2 deadline. All byte-exact except the documented item 4.\n\n`;
md += `**Upstream sync 2, lane C, fixed FOR PARITY (bug found verifying 130796a's BM25 \`sort -k1,1 -gr\`):** BSD \`sort\`'s \`-r\` (no \`-s\`) is not "stable sort, then negate" — equal-scoring files come out in the REVERSE of their glob/insertion order, verified directly (\`printf '5.0\\ta\\n3.0\\tb\\n5.0\\tc\\n' | sort -t$'\\t' -k1,1 -gr\` → c, a, b). Two memories scoring identically (same matched terms, same length) is not rare — e.g. near-duplicate todos. \`scorePrefilterCandidates\` now reverses the candidate list before its stable sort, reproducing the reversed tie order; \`search-top-env-caps-candidates\` and \`prefilter-top-1\` (both deliberately seeded with a tie) now match.\n\n`;
md += `Notably PARITY (quirks correctly replicated, upstream sync 2 lane C): empty-store \`mem search\` now prints "No memories stored." and exits **0** (766a290 fixed the old dead \`\${2:?}\`-adjacent \`set -e\`+pipefail branch — \`types\` is unchanged, still silent and non-zero (ls's cannot-access status under pipefail: 2 with GNU ls, 1 with BSD/macOS ls; the port follows the platform since 536c64d), since only \`action_search\` got the \`|| count=0\` guard); the two-stage BM25 prefilter (byte-wise/\`LC_ALL=C\` scoring, including over multibyte UTF-8 memory content); the newest-files fallback on zero term overlap; \`mem prefilter\` printing candidates with no model call and no fallback; the heartbeat firing (or not, per \`MEM_SEARCH_HEARTBEAT_S\`) around a slow \`llm\`; \`--until\` on \`add\` (shape-only date validation) and its survival through \`edit\`. Unchanged from upstream sync 1b: \`list\` empty-store prints to stderr and exits 0; legacy id-less filenames render \`--------\`; add-summary/edit-summary slicing; \`updated:\` scalar→list promotion; env-\`MEM_DIR\`-beats-rc; the \`MEM_TYPE\`/\`.memrc\` reset precedence; hex-prefix / exact-filename / ambiguous / not-found resolution; search corpus bytes + argv.\n\n`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`mem parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) {
    const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
    console.log(`  MISMATCH ${r.group}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
  }
}
replay.verify(); // a recording miss fails loudly (after the report is written)
process.exit(passed === total ? 0 : 1);
