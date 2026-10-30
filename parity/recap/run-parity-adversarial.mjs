#!/usr/bin/env node
// run-parity-adversarial.mjs — INDEPENDENT adversarial differential check of
// the `recap` port (bin/recap.mjs + src/recap.ts, reusing src/rollups.ts)
// against the real Bash tool (headlong/bin/recap).
//
// Written by the TESTER, not the translator. Own scenario set harvested
// branch-by-branch from the Bash source, targeting seams a self-written
// harness tends to avoid: flag combinations/misuse, corrupt/partial cache
// state, lock staleness boundaries, adversarial trajectory content (empty,
// malformed, huge, non-ASCII/NUL/CRLF/DEL), --context staircase tier
// boundaries, number-literal/key-order/trailing-newline fidelity in cached
// JSON, every env var the Bash reads, and the exact `llm` argv+stdin bytes
// each side's `llm` sends (captured by the replay server, compared like a request log).
//
// Both sides run their own real `llm` client against ONE replay server of recorded real DeepSeek replies, served in
// cycle; failures are labelled HTTP transport fixtures, and model-text cases live in the parser layer (see below).
//
// Compared (verdict-bearing), RAW BYTES / byte-exact text, never re-parsed
// JSON before diffing (preserves key order, number literals, escaping):
//   stdout, stderr   decoded only if the bytes round-trip as UTF-8 (else
//                    reported as hex), normalized ONLY for timestamps and
//                    sandbox/repo/home paths, symmetrically on both sides
//   status           exit code (+ signal)
//   state            every file under <rundir>/recap/ and <rundir>/rollups/
//                    (`.lock` dirs: existence+mtime bucket only, not
//                    content — mkdir has no content), byte-exact
//   llmCalls         the argv + stdin (base64) the fake `llm` captured, in
//                    call order — the exact wire the Bash sends vs the port
//
// A scenario may cite a documented deviation (PARITY.md row) via `dev`; a
// mismatch is DEVIATION only if confined to that row's allowed fields.
// Everything else is DIVERGE. A scenario where BOTH sides time out is a
// DIVERGE (harness bug), never silently treated as parity.
//
// Run: node parity/recap/run-parity-adversarial.mjs   (ONLY=<regex> to filter)
// Env: PARITY_BASH_RECAP=/abs/path/to/headlong/bin/recap to point at the
//      real Bash tool (required — no default assumed present on this machine).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startReplay, REPLAY_MODEL } from "../support/replayModel.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Scrubbed to a placeholder for release; set PARITY_BASH_RECAP=/abs/path to
// headlong/bin/recap to reproduce the run.
const BASH_RECAP = process.env.PARITY_BASH_RECAP || "<HEADLONG_ROOT>/bin/recap";
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_RECAP), "..");
const HOME_DIR = os.homedir();
const TS_RECAP = process.env.PARITY_TS_RECAP || path.join(REPO, "bin", "recap.mjs");
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

if (!fs.existsSync(BASH_RECAP)) {
  console.error(`adversarial: Bash tool not found at ${BASH_RECAP} — set PARITY_BASH_RECAP=/abs/path/to/headlong/bin/recap`);
  process.exit(2);
}

// --- the real `llm` on each side, on ONE replay server ------------------------------------------------------
// No fake `llm`. Each side runs its own real client (upstream bin/llm, port bin/llm) against one replay server
// (parity/support/replayModel.mjs). Model replies: the recorded real DeepSeek replies in recordings/shared.json (one per
// call kind: map, reduce, rollup), served in CYCLE to every call of that kind, the same bytes to both sides. The
// scenario's old fake-`llm` mode becomes, per call:
//   ok                          the cycled recorded reply
//   nonzero                     HTTP 500 transport fixture (`llm` exits non-zero)
//   empty                       HTTP 200 stream fixture that ends with no content
//   refused                     HTTP 200 stream fixture that ends with finish_reason content_filter
//   huge                        capped-stream fixture: >1 MiB of SSE keep-alive comments, then finish_reason length,
//                               no content (the size reaches the client; no model text is invented)
//   badjson, whitespace-only, fenced, fenced-chatter, null, false, array, string, number, numlit-episodes,
//   notable-steps-string, themes-object, step-ids-numbers, unicode-and-del, refused-exit0
//                               model TEXT, so the scenario leaves this harness: the parser layer
//                               (run-parser-parity.mjs, upstream `_llm_json` cut by markers + hash) compares those
//                               literals with no model, and the report lists every scenario moved there.
const HEADLONG_LLM = path.join(HEADLONG_ROOT, "bin", "llm");
const LLMBIN = { bash: fs.mkdtempSync(path.join(os.tmpdir(), "recap-adv-upbin-")), ts: fs.mkdtempSync(path.join(os.tmpdir(), "recap-adv-portbin-")) };
fs.symlinkSync(HEADLONG_LLM, path.join(LLMBIN.bash, "llm"));
fs.symlinkSync(path.join(REPO, "bin", "llm"), path.join(LLMBIN.ts, "llm"));
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const chunk = (delta, finish) => ({ id: "replay-fixture", object: "chat.completion.chunk", model: REPLAY_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
const SSE_CT = "text/event-stream; charset=utf-8";
const FX = {
  nonzero: { status: 500, content_type: "application/json", body: '{"error":{"message":"replay fixture: HTTP 500 (transport failure, not model output)"}}' },
  empty: { status: 200, content_type: SSE_CT, body: sse([chunk({ role: "assistant", content: "" }, null), chunk({}, "stop")]) },
  refused: { status: 200, content_type: SSE_CT, body: sse([chunk({ role: "assistant", content: "" }, null), chunk({}, "content_filter")]) },
  huge: { status: 200, content_type: SSE_CT, body: ": replay fixture keep-alive\n".repeat(48 * 1024) + sse([chunk({ role: "assistant", content: "" }, null), chunk({}, "length")]) },
};
const PARSER_MODES = new Set(["badjson", "whitespace-only", "fenced", "fenced-chatter", "null", "false", "array", "string", "number", "numlit-episodes", "notable-steps-string", "themes-object", "step-ids-numbers", "unicode-and-del", "refused-exit0"]);
/** The scenario's per-call fixtures from its old LLM_MODE / LLM_AT, or "parser" when any call is model text. */
function planOf(sc) {
  const plan = {};
  for (const step of sc.invocations) {
    const env = step.env ?? {};
    const modes = [];
    if (env.LLM_MODE) modes.push(["*", env.LLM_MODE]);
    if (env.LLM_AT) for (const pair of env.LLM_AT.split(",")) { const [i, m] = pair.split(":"); modes.push([Number(i), m]); }
    for (const [i, m] of modes) {
      if (PARSER_MODES.has(m)) return "parser";
      if (m !== "ok") plan[i] = FX[m];
    }
  }
  return plan;
}
const channelOf = (body) => {
  const sys = (body.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (sys.includes("one window of an AI agent")) return "map";
  if (sys.includes("numbered episode summaries")) return "reduce";
  if (sys.includes("FIRST PERSON")) return "rollup";
  return "other";
};
const callFixtures = {};
const replay = await startReplay({ suite: "recap", dir: path.join(HERE, "recordings"), channelOf, forwardModel: REPLAY_MODEL, cycle: true, recordingOf: () => "shared", callFixtures });
const dropLlmWarnings = (s) => s.split("\n").filter((l) => !/^llm: warning: LLM_(PROVIDER|API_URL)/.test(l)).join("\n");

// --- byte-safe text ----------------------------------------------------------------
function bytesToText(buf) {
  const s = buf.toString("utf8");
  return Buffer.from(s, "utf8").equals(buf) ? s : `<bytes hex ${buf.toString("hex")}>`;
}

function scrubPath(s) {
  return String(s).replaceAll(BASH_RECAP, "<BASH_RECAP>").replaceAll(HEADLONG_ROOT, "<HEADLONG_ROOT>").replaceAll(REPO, "<REPO>").replaceAll(HOME_DIR, "<HOME>");
}

function norm(s, sb) {
  return scrubPath(String(s))
    .replaceAll(sb, "<SB>")
    // `date +%Y-%m-%dT%H:%M:%S` (local, no offset) — created/generated_at/updated.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<TS>");
}

// --- sandbox + trajectory writers --------------------------------------------------
const TRAJ_ID = "aaaaaaaa-run";

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "recap-adv-sb-"));
}

function runDirOf(sb) {
  return path.join(sb, TRAJ_ID);
}

/** lines: array of objects (JSON-stringified + \n each) OR a raw string/Buffer
 *  written verbatim (for malformed/no-trailing-newline/CRLF/binary cases). */
function writeTraj(sb, lines) {
  const rd = runDirOf(sb);
  fs.mkdirSync(rd, { recursive: true });
  const content = Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : lines;
  fs.writeFileSync(path.join(rd, "trajectory.jsonl"), content);
}

function appendTraj(sb, lines) {
  const rd = runDirOf(sb);
  const content = Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : lines;
  fs.appendFileSync(path.join(rd, "trajectory.jsonl"), content);
}

function fixtureSteps(n, opts = {}) {
  const off = opts.offset ?? 0;
  const type = opts.type ?? "thought";
  const gapEveryMin = opts.gapEveryMin; // insert a big ts jump every K steps
  return Array.from({ length: n }, (_, i) => {
    const k = off + i;
    let minute = k % 1440;
    if (gapEveryMin && Math.floor(k / 1) > 0) minute = k * (opts.minuteStep ?? 1);
    const hh = String(Math.floor(minute / 60) % 24).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    return {
      type,
      step_id: `s${String(k).padStart(7, "0")}`,
      ts: `2026-01-01T${hh}:${mm}:00Z`,
      content: opts.content ? opts.content(k) : `step number ${k}`,
    };
  });
}

// --- run one invocation --------------------------------------------------------------
function runInvocation(kind, argv, env, sb, scKey) {
  const fullEnv = { ...process.env };
  for (const k of [
    "TRAJ_DIR", "TRAJ_ID", "RECAP_MODEL", "SHELLM_MODEL", "RECAP_MAP_MODEL", "RECAP_REDUCE_MODEL",
    "RECAP_MAX_WINDOW_BYTES", "ROLLUP_FANOUT", "MONOLITH_CONTEXT_BUDGET", "ROLLUP_RAW_TAIL",
    "MODEL_CONTEXT_WINDOW", "THINK_MODEL", "RECAP_CONTEXT_BUDGET_MAX", "LLM_MODE", "LLM_AT",
    "LLM_STATE_DIR", "LLM_CAPTURE_FILE", "ROLLUP_MAX_SEALS", "LLM_CITE",
    "LLM_PROVIDER", "LLM_API_URL", "LLM_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY",
  ]) delete fullEnv[k];
  fullEnv.LC_ALL = "C";
  fullEnv.TZ = "UTC";
  fullEnv.PATH = `${LLMBIN[kind]}:${fullEnv.PATH}`;
  fullEnv.LLM_PROVIDER = "openai-compatible";
  fullEnv.LLM_API_URL = replay.url(scKey, kind);
  fullEnv.LLM_API_KEY = "replay-not-a-key";
  fullEnv.LLM_RETRY_BACKOFF = "0";
  fullEnv.TRAJ_DIR = sb;
  for (const [k, v] of Object.entries(env ?? {})) {
    if (["LLM_MODE", "LLM_AT", "LLM_STATE_DIR", "LLM_CAPTURE_FILE", "LLM_CITE"].includes(k)) continue; // old fake knobs
    if (v === null) delete fullEnv[k];
    else fullEnv[k] = v;
  }

  const bin = kind === "bash" ? BASH_RECAP : process.execPath;
  const args = kind === "bash" ? argv : [TS_RECAP, ...argv];
  // Async: the replay server lives in this process.
  return new Promise((resolve) => {
    const before = replay.requests(scKey, kind).length;
    const ch = spawn(bin, args, { cwd: sb, env: fullEnv, detached: true }); // own process group: a timeout kills llm too
    const out = [], err = [];
    ch.stdout.on("data", (d) => out.push(d));
    ch.stderr.on("data", (d) => err.push(d));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-ch.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 120000); // real llm clients: the 40-step and 2000-step scenarios make dozens of calls
    ch.on("close", (status, signal) => {
      clearTimeout(t);
      const calls = replay.requests(scKey, kind).slice(before).map((r, k) => ({ idx: before + k + 1, channel: r.channel, body: r.body }));
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.from(dropLlmWarnings(Buffer.concat(err).toString("utf8")), "utf8"), status, signal: timedOut ? null : signal, timedOut, calls });
    });
  });
}

// --- on-disk state serialization -----------------------------------------------------
function lockBucket(mtimeMs, nowMs) {
  // Verified directly (both `command find` and `/usr/bin/find`, invoked as a
  // real subprocess the way the Bash script invokes it): `find -mmin +30` on
  // this platform flips true at age > 1800s exactly — continuous, matching
  // the port's `age_ms > 1_800_000` check. (An EARLIER exploratory test in
  // this session's own interactive shell showed a coarser ~31-minute
  // threshold — that shell has a `find` FUNCTION shim installed by the
  // coding-agent environment, not the real find; it does not apply to a
  // script run as a subprocess and was a dead end, corrected before writing
  // these scenarios.)
  const ageSec = (nowMs - mtimeMs) / 1000;
  if (ageSec < 1750) return "fresh(<30:00)";
  if (ageSec < 1850) return "boundary(~1800s)";
  return "stale(>1850s)";
}

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
    if (e.isDirectory()) {
      if (e.name === ".lock") {
        acc.push({ rel, lockDir: true, mtimeMs: fs.statSync(full).mtimeMs });
        continue;
      }
      walk(full, rel, acc);
    } else {
      acc.push({ rel, content: fs.readFileSync(full) });
    }
  }
}

function serializeState(runDirAbs, nowMs) {
  const acc = [];
  for (const sub of ["recap", "rollups"]) walk(path.join(runDirAbs, sub), sub, acc);
  if (acc.length === 0) return "<no cache>";
  return acc
    .map((f) => (f.lockDir ? `LOCKDIR ${f.rel} age=${lockBucket(f.mtimeMs, nowMs)}` : `FILE ${f.rel}\n${bytesToText(f.content)}`))
    .join("\n----\n");
}

// --- llm call log --------------------------------------------------------------------
function readCalls(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// The wire request each side's `llm` sent the replay server, in call order (model, max_tokens, messages, …).
function callsToText(calls) {
  return calls.map((c) => `#${c.idx} ${c.channel} ${JSON.stringify(c.body)}`).join("\n---\n");
}

// --- scenario runner -------------------------------------------------------------------
async function runTool(kind, sc) {
  const sb = makeSandbox();
  const scKey = `${sc.group}--${sc.name}`;
  if (sc.trajLines !== undefined) writeTraj(sb, sc.trajLines);
  if (sc.setup) sc.setup(sb, TRAJ_ID);

  const invocations = [];
  const allCalls = [];
  for (const step of sc.invocations) {
    if (step.appendLines !== undefined) appendTraj(sb, step.appendLines);
    if (step.setup) step.setup(sb, TRAJ_ID);
    const r = await runInvocation(kind, step.argv, step.env ?? {}, sb, scKey);
    invocations.push(r);
  }
  const nowMs = Date.now();
  const state = serializeState(runDirOf(sb), nowMs);
  fs.rmSync(sb, { recursive: true, force: true });
  return { sb, invocations, state };
}

// --- documented deviations (PARITY.md rows) -----------------------------------------
// Added after the fix pass below (F1-F4): every remaining DIVERGE this
// harness found is either fixed (now PARITY) or cited here against its own
// PARITY.md row, per-scenario, with the EXACT set of fields that row is
// allowed to cover — no blanket allowances.
const DEV = {
  "bash-2q": { fields: ["stderr"], row: "recap required-flag value MISSING or EMPTY" },
  "recap-octal-leak": { fields: ["stderr"], row: "recap invalid-octal numeric flag value (--window/--fanout)" },
  "recap-lock-mkdir-leak": { fields: ["stderr"], row: "recap lock reclaim mkdir diagnostic leak (non-empty stale lock dir)" },
  "recap-jqfile-basic": { fields: ["stderr", "status"], row: "recap corrupt/missing episodes.jsonl or themes.json (jq-abort family)" },
  "recap-jqfile-notrailingnl": { fields: ["stderr", "status", "state", "calls"], row: "recap episodes.jsonl missing separator newline after a crash mid-append" },
  "recap-emptytraj-crash": { fields: ["stderr"], row: "recap first-ever run with zero renderable steps (unguarded episodes.jsonl open)" },
  "recap-unbound-arith": { fields: ["stderr"], row: "recap arithmetic on an unset-shell-variable-shaped env value (set -u)" },
  "recap-jqreply-nonobject": { fields: ["stderr", "status", "state"], row: "recap LLM reply is not a JSON object at the top level (map/reduce/rollup)" },
  // 2e39a3f: _ctx_build now runs as `_ctx_build ... || note ...`, which turns
  // `set -e` OFF for the whole seal path. A non-object rollup reply therefore
  // does not abort: jq's `$body.refused` error goes to stderr, the `> "$file"`
  // redirect leaves a ZERO-BYTE block file, the build carries on and exits 0.
  "recap-rollup-jqreply-nonobject": { fields: ["stdout", "stderr", "status", "state"], row: "recap rollup reply is not a JSON object (set -e suppressed inside _ctx_build, 2e39a3f)" },
  "recap-jqreply-downstream": { fields: ["stderr", "status"], row: "recap well-formed reply, malformed downstream reduce-time shape" },
  // The capped-stream fixture (>1 MiB of SSE keep-alive comments before the first data line, then finish_reason
  // length, no content): upstream bin/llm appends every pre-data line to `_err_buf` with bash string concatenation,
  // quadratic in the line count (4k lines 1.4 s, 16k 21.6 s, 49k minutes, x3 attempts), so the 120 s per-invocation
  // limit kills it; the port's client is linear and finishes. The port is the sane side.
  "recap-capped-stream-quadratic": { fields: ["stdout", "stderr", "status", "state", "calls"], row: "llm: keep-alive lines before the first data line cost upstream quadratic time (bash string append)" },
  "recap-huge-reply-argmax-calls": { fields: ["stdout", "stderr", "status", "state", "calls"], row: "recap huge (>1MiB) LLM reply: port completes, Bash hits the OS ARG_MAX" },
  "recap-huge-reply-argmax": { fields: ["stdout", "stderr", "status", "state"], row: "recap huge (>1MiB) LLM reply: port completes, Bash hits the OS ARG_MAX" },
};

// --- tester's classification of every non-parity finding ----------------------------
// BUG   = a real port behavioral bug (consumed behaviour differs); minimal fix
//         described, NOT applied (src/*.ts is off-limits for this task)
// UNDOC = a real, reproducible divergence that is neither a BUG nor covered by a
//         PARITY.md row — the port's own PORT-NOTE comments predict it but no
//         PARITY.md row was ever added, and the translator's own 39-scenario
//         harness never exercises the path (its fake `llm` never returns
//         anything but a well-formed object of the expected shape)
// NORM  = an artifact of THIS harness's normalization, not a real divergence
// All 24 findings from the pre-fix run are now resolved: F1-F4 above fixed
// the 4 real bugs, and every remaining DIVERGE got its own PARITY.md row
// (cited per-scenario via `dev:` + DEV{} above). Kept empty, not deleted, so
// a NEW divergence this harness finds later still gets caught as UNTRIAGED
// (see the report generation below) rather than silently passing through.
const TRIAGE = {};

// --- helper: LLM_AT scenario builder --------------------------------------------------
const CITE = { LLM_CITE: "[s0000027,s0000029] [none,none]" };
const S = (group, name, invocations, extra = {}) => ({ group, name, invocations, ...extra });
const inv = (argv, env, extra) => ({ argv, env, ...(extra ?? {}) });

// ============================================================================
// SCENARIOS
// ============================================================================
const scenarios = [
  // ---- calibration (must be PARITY; proves the rig) ----
  S("calib", "version", [inv(["--version"])]),
  S("calib", "help", [inv(["--help"])]),
  S("calib", "basic-recap-text", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: fixtureSteps(3) }),

  // ---- flags: combinations & misuse ----
  S("flags", "double-dash-alone", [inv(["--"])]),
  S("flags", "unknown-flag-with-value", [inv(["--bogus", "x"])]),
  S("flags", "two-positional-ids", [inv(["one", "two"])]),
  S("flags", "id-then-unknown-flag", [inv([TRAJ_ID, "--frobnicate"])], { trajLines: fixtureSteps(1) }),
  S("flags", "window-duplicate-last-wins", [inv([TRAJ_ID, "--window", "20", "--window", "50", "--cached"])], { trajLines: fixtureSteps(1) }),
  S("flags", "model-then-map-model-overrides-map-only", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0", "--model", "both-x", "--map-model", "map-only-y"])], { trajLines: fixtureSteps(3) }),
  S("flags", "map-model-then-model-overrides-both", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0", "--map-model", "map-only-y", "--model", "both-x"])], { trajLines: fixtureSteps(3) }),
  S("flags", "window-octal-invalid-extra-stderr-line", [inv(["--window", "019"])], { dev: "recap-octal-leak" }),
  S("flags", "window-octal-valid-boundary-012-is-10", [inv([TRAJ_ID, "--window", "012", "--cached"])], { trajLines: fixtureSteps(1) }),
  S("flags", "window-leading-zero-0020-decimal-in-awk", [inv([TRAJ_ID, "--window", "0020", "--gap-minutes", "0"])], { trajLines: fixtureSteps(25) }),
  S("flags", "fanout-octal-invalid-extra-stderr-line", [inv([TRAJ_ID, "--context", "--fanout", "09", "--cached", "--raw-tail", "1"])], { trajLines: fixtureSteps(1), dev: "recap-octal-leak" }),
  S("flags", "budget-ignored-without-context-garbage", [inv([TRAJ_ID, "--budget", "not-a-number", "--cached"])], { trajLines: fixtureSteps(1) }),
  S("flags", "raw-tail-ignored-without-context", [inv([TRAJ_ID, "--raw-tail", "not-a-number", "--cached"])], { trajLines: fixtureSteps(1) }),
  S("flags", "context-and-cached-and-rebuild-all-set", [inv([TRAJ_ID, "--context", "--cached", "--rebuild", "--fanout", "5", "--raw-tail", "2"])], { trajLines: fixtureSteps(20) }),
  S("flags", "backfill-implies-context-without-explicit-flag", [inv([TRAJ_ID, "--backfill", "--fanout", "5", "--raw-tail", "0"])], { trajLines: fixtureSteps(10) }),
  S("flags", "gap-minutes-zero-disables-gap-cut", [inv([TRAJ_ID, "--window", "5", "--gap-minutes", "0"])], { trajLines: fixtureSteps(12, { minuteStep: 120 }) }),
  S("flags", "negative-window", [inv([TRAJ_ID, "--window", "-5"])], { trajLines: fixtureSteps(1) }),
  S("flags", "fanout-negative", [inv([TRAJ_ID, "--context", "--fanout", "-2", "--cached"])], { trajLines: fixtureSteps(1) }),
  S("flags", "hex-window-not-numeric", [inv([TRAJ_ID, "--window", "0x10"])], { trajLines: fixtureSteps(1) }),
  S("flags", "quiet-suppresses-note-but-not-die", [inv([TRAJ_ID, "-q", "--cached"])], { trajLines: fixtureSteps(1) }),

  // ---- lock: staleness boundary around the 1800s (30min) threshold ----
  S("lock", "boundary-30to31min-refresh-lock", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const t = new Date(Date.now() - (30 * 60 + 30) * 1000); // 1830s — just past the 1800s threshold
      fs.utimesSync(lock, t, t);
    },
  }),
  S("lock", "boundary-30to31min-context-lock", [inv([TRAJ_ID, "--context", "--raw-tail", "2"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "rollups", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const t = new Date(Date.now() - (30 * 60 + 45) * 1000);
      fs.utimesSync(lock, t, t);
    },
  }),
  S("lock", "just-under-30min-both-refuse", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const t = new Date(Date.now() - 29 * 60 * 1000);
      fs.utimesSync(lock, t, t);
    },
  }),
  S("lock", "well-over-31min-both-reclaim", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const t = new Date(Date.now() - 35 * 60 * 1000);
      fs.utimesSync(lock, t, t);
    },
  }),

  // ---- empty / missing / corrupt cache files ----
  S("cache", "empty-cache-dir-present", [inv([TRAJ_ID, "--cached"])], {
    trajLines: fixtureSteps(1),
    setup: (sb) => fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true }),
  }),
  S("cache", "empty-episodes-file", [inv([TRAJ_ID, "--cached"])], {
    trajLines: fixtureSteps(1),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), "");
    },
  }),
  S("cache", "themes-present-episodes-missing-print", [inv([TRAJ_ID, "--cached"])], {
    trajLines: fixtureSteps(1),
    dev: "recap-jqfile-basic",
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "themes.json"), JSON.stringify({ generated_at: "2026-01-01T00:00:00", model: "m", episodes: 1, raw_end_line: 1, total_lines: 1, arc: "a", themes: [] }, null, 2) + "\n");
    },
  }),
  S("cache", "themes-json-corrupt-print-text", [inv([TRAJ_ID, "--cached"])], {
    trajLines: fixtureSteps(1),
    dev: "recap-jqfile-basic",
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "themes.json"), "{not valid json");
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), JSON.stringify({ idx: 1, raw_start_line: 1, raw_end_line: 1, first_step: "a", last_step: "a", first_ts: "t", last_ts: "t", n_steps: 1, partial: false, model: "m", created: "c", title: "t", summary: "s", themes: [], notable_steps: [] }) + "\n");
    },
  }),
  S("cache", "episodes-jsonl-last-line-corrupt-resume", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(20),
    dev: "recap-jqfile-basic",
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), '{"idx":1,"raw_start_line":1,"raw_end_line":5,"first_step":"a","last_step":"e","first_ts":"t1","last_ts":"t2","n_steps":5,"partial":false,"model":"m","created":"c","title":"t","summary":"s","themes":[],"notable_steps":[]}\n{this is not valid json\n');
    },
  }),
  S("jqabort", "corrupt-episodes-last-line", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    dev: "recap-jqfile-basic",
    trajLines: fixtureSteps(20),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), '{"idx":1,"raw_start_line":1,"raw_end_line":5,"first_step":"a","last_step":"e","first_ts":"t1","last_ts":"t2","n_steps":5,"partial":true,"model":"m","created":"c","title":"t","summary":"s","themes":[],"notable_steps":[]}\nnot valid json at all\n');
    },
  }),
  S("cache", "episodes-jsonl-partial-flag-not-boolean", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(20),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), '{"idx":1,"raw_start_line":1,"raw_end_line":5,"first_step":"a","last_step":"e","first_ts":"t1","last_ts":"t2","n_steps":5,"partial":"true","model":"m","created":"c","title":"t","summary":"s","themes":[],"notable_steps":[]}\n');
    },
  }),
  S("cache", "episodes-jsonl-no-trailing-newline-resume", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(20),
    dev: "recap-jqfile-notrailingnl",
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "recap"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "recap", "episodes.jsonl"), '{"idx":1,"raw_start_line":1,"raw_end_line":5,"first_step":"a","last_step":"e","first_ts":"t1","last_ts":"t2","n_steps":5,"partial":false,"model":"m","created":"c","title":"t","summary":"s","themes":[],"notable_steps":[]}'); // no trailing \n
    },
  }),
  S("cache", "rollups-meta-json-corrupt-start-index", [inv([TRAJ_ID, "--context", "--raw-tail", "2"])], {
    trajLines: fixtureSteps(10),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "rollups"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "meta.json"), "not json");
    },
  }),
  S("cache", "rollups-meta-start-index-negative", [inv([TRAJ_ID, "--context", "--raw-tail", "2"])], {
    trajLines: fixtureSteps(10),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "rollups"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "meta.json"), JSON.stringify({ start_index: -5, updated: "x" }));
    },
  }),
  S("cache", "rendered-tsv-shrunk-log-forces-full-rerender", [inv([TRAJ_ID, "--context", "--raw-tail", "2"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "rollups"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "rendered.meta.json"), JSON.stringify({ version: 1, keep: '["thought","action","observation","message","feedback","final","shellm-run","merge"]', raw_lines: 999, updated: "x" }));
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "rendered.tsv"), "1\tzz\tzz\tstale\t\n");
    },
  }),
  S("cache", "rendered-tsv-crash-above-highwater-truncated", [inv([TRAJ_ID, "--context", "--raw-tail", "5"])], {
    trajLines: fixtureSteps(5),
    setup: (sb) => {
      fs.mkdirSync(path.join(sb, TRAJ_ID, "rollups"), { recursive: true });
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "rendered.meta.json"), JSON.stringify({ version: 1, keep: '["thought","action","observation","message","feedback","final","shellm-run","merge"]', raw_lines: 2, updated: "x" }));
      fs.writeFileSync(path.join(sb, TRAJ_ID, "rollups", "rendered.tsv"), "1\ts0000000\t2026-01-01T00:00\t[s0000000] thought: step number 0\t720\n2\ts0000001\t2026-01-01T00:01\t[s0000001] thought: step number 1\t721\n3\ts0000002\t2026-01-01T00:02\t[s0000002] thought: step number 2\t722\n4\ts0000003\t2026-01-01T00:03\t[s0000003] thought: step number 3\t723\n"); // rows 3,4 above the recorded high-water mark (2) — a simulated crash between append and meta write
    },
  }),

  // ---- lock content-adjacent: stale reclaim + concurrent-shape ----
  S("lock", "stale-lock-reclaimed-40min", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(3),
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      const t = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(lock, t, t);
    },
  }),
  S("lock", "concurrent-shape-lock-nonempty-refuses-rmdir", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    // A lock dir that is stale-aged but NOT empty (simulating a second writer's
    // temp file inside it): Bash's `rmdir` fails silently (`|| true`) and then
    // `mkdir "$LOCK"` ALSO fails (dir already exists) -> die. Same on the port
    // (rmdirSync throws on non-empty, mkdirSync then throws EEXIST -> die).
    trajLines: fixtureSteps(3),
    dev: "recap-lock-mkdir-leak",
    setup: (sb) => {
      const lock = path.join(sb, TRAJ_ID, "recap", ".lock");
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, "somebody-else.tmp"), "x");
      const t = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(lock, t, t);
    },
  }),

  // ---- trajectories: empty / one-line / malformed / huge ----
  S("traj", "empty-file-zero-bytes", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: "", dev: "recap-emptytraj-crash" }),
  S("traj", "one-line-no-trailing-newline", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: JSON.stringify(fixtureSteps(1)[0]) }),
  S("traj", "only-whitespace-lines", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: "\n   \n\t\n" + JSON.stringify(fixtureSteps(1)[0]) + "\n" }),
  S("traj", "malformed-line-mid-file-stops-render", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [fixtureSteps(1)[0], fixtureSteps(1, { offset: 1 })[0]].map((l) => JSON.stringify(l)).join("\n") + "\n{not valid json\n" + JSON.stringify(fixtureSteps(1, { offset: 2 })[0]) + "\n",
  }),
  S("traj", "line-is-json-array-not-object", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: JSON.stringify(fixtureSteps(1)[0]) + "\n[1,2,3]\n" + JSON.stringify(fixtureSteps(1, { offset: 1 })[0]) + "\n",
  }),
  S("traj", "line-is-json-scalar", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: JSON.stringify(fixtureSteps(1)[0]) + "\n42\n" + JSON.stringify(fixtureSteps(1, { offset: 1 })[0]) + "\n",
  }),
  S("traj", "non-string-source-field-truthy-nonstring", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "s0000000", ts: "2026-01-01T00:00:00Z", content: "c", source: 5 }],
    dev: "recap-emptytraj-crash",
  }),
  S("traj", "empty-string-source-jq-truthy", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "s0000000", ts: "2026-01-01T00:00:00Z", content: "c", source: "" }],
  }),
  S("traj", "false-source-jq-falsy", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "s0000000", ts: "2026-01-01T00:00:00Z", content: "c", source: false }],
  }),
  S("traj", "step-types-reducer-ignores-interspersed", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [
      { type: "idle", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "noise" },
      { type: "thought", step_id: "sB", ts: "2026-01-01T00:01:00Z", content: "kept 1" },
      { type: "reasoning", step_id: "sC", ts: "2026-01-01T00:02:00Z", content: "noise 2" },
      { type: "shell-output", step_id: "sD", ts: "2026-01-01T00:03:00Z", content: "noise 3" },
      { type: "action", step_id: "sE", ts: "2026-01-01T00:04:00Z", content: "kept 2" },
      { type: "seed", step_id: "sF", ts: "2026-01-01T00:05:00Z", content: "seed-excluded-even-though-type-kept", source: "seed" },
    ],
  }),
  S("traj", "shellm-run-launched-by-empty-shows-cmd-tail", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "shellm-run", step_id: "sA", ts: "2026-01-01T00:00:00Z", wake: "cron", model: "m1", launched_by: "", command: "x".repeat(300) + "TAIL_MARKER" }],
  }),
  S("traj", "shellm-run-launched-by-set-no-cmd-tail", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "shellm-run", step_id: "sA", ts: "2026-01-01T00:00:00Z", wake: "cron", model: "m1", launched_by: "parent", command: "x".repeat(300) + "SHOULD_NOT_APPEAR" }],
  }),
  S("traj", "content-500char-truncation-boundary", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a".repeat(499) + "X" + "Y".repeat(50) }],
  }),
  S("traj", "step-id-longer-than-8-truncated", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "0123456789ABCDEF", ts: "2026-01-01T00:00:00Z", content: "c" }],
  }),
  S("traj", "missing-step-id-question-mark-fallback", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", ts: "2026-01-01T00:00:00Z", content: "c" }],
  }),
  S("traj", "non-ascii-cjk-emoji-content", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "こんにちは 😀 café naïve — em—dash" }],
  }),
  S("traj", "del-and-control-chars-content", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "before\u007fafter\u0001bell\u0007end" }],
  }),
  S("traj", "nul-byte-content-escaped", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a\u0000b\u0000c" }],
  }),
  S("traj", "crlf-inside-content-field", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "line1\r\nline2\r\nline3" }],
  }),
  S("traj", "crlf-line-endings-in-file", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(3).map((l) => JSON.stringify(l)).join("\r\n") + "\r\n",
  }),
  S("traj", "tab-in-content-tsv-safety", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "col1\tcol2\tcol3" }],
  }),
  S("traj", "very-long-trajectory-2000-steps", [inv([TRAJ_ID, "--window", "50", "--gap-minutes", "0"])], { trajLines: fixtureSteps(2000) }),
  S("traj", "content-astral-plane-emoji-truncation", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], {
    trajLines: [{ type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "😀".repeat(300) }],
  }),

  // ---- gap-minutes windowing boundaries ----
  S("windowing", "gap-exactly-at-threshold-cuts", [inv([TRAJ_ID, "--window", "50", "--gap-minutes", "30"])], {
    trajLines: [
      { type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a" },
      ...Array.from({ length: 9 }, (_, i) => ({ type: "thought", step_id: `sB${i}`, ts: `2026-01-01T00:0${i + 1}:00Z`, content: `b${i}` })),
      { type: "thought", step_id: "sC", ts: "2026-01-01T00:40:00Z", content: "after exactly 30min gap from 00:10" },
    ],
  }),
  S("windowing", "gap-one-minute-under-threshold-no-cut", [inv([TRAJ_ID, "--window", "50", "--gap-minutes", "30"])], {
    trajLines: [
      { type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a" },
      ...Array.from({ length: 9 }, (_, i) => ({ type: "thought", step_id: `sB${i}`, ts: `2026-01-01T00:0${i + 1}:00Z`, content: `b${i}` })),
      { type: "thought", step_id: "sC", ts: "2026-01-01T00:39:00Z", content: "29min gap, no cut" },
    ],
  }),
  S("windowing", "gap-cut-below-min-gap-window-suppressed", [inv([TRAJ_ID, "--window", "50", "--gap-minutes", "5"])], {
    // MIN_GAP_WINDOW=10: a gap after only 3 steps must NOT cut.
    trajLines: [
      { type: "thought", step_id: "sA", ts: "2026-01-01T00:00:00Z", content: "a" },
      { type: "thought", step_id: "sB", ts: "2026-01-01T00:01:00Z", content: "b" },
      { type: "thought", step_id: "sC", ts: "2026-01-01T00:02:00Z", content: "c" },
      { type: "thought", step_id: "sD", ts: "2026-01-01T01:00:00Z", content: "big gap but window only has 3 steps" },
    ],
  }),
  S("windowing", "unparseable-ts-no-gap-cut", [inv([TRAJ_ID, "--window", "50", "--gap-minutes", "1"])], {
    trajLines: Array.from({ length: 12 }, (_, i) => ({ type: "thought", step_id: `s${i}`, ts: i === 6 ? "not-a-timestamp" : `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`, content: `x${i}` })),
  }),
  S("windowing", "max-window-bytes-cuts-mid-window", [inv([TRAJ_ID, "--window", "1000", "--gap-minutes", "0"])], {
    trajLines: fixtureSteps(20, { content: (k) => "z".repeat(490) + k }),
    env: { RECAP_MAX_WINDOW_BYTES: "3000" },
  }),
  S("windowing", "tiny-tail-deferred-to-next-refresh", [inv([TRAJ_ID, "--window", "20", "--gap-minutes", "0"], { RECAP_MAX_WINDOW_BYTES: "1000000" }), inv([TRAJ_ID, "--window", "20", "--gap-minutes", "0"], { RECAP_MAX_WINDOW_BYTES: "1000000" }, )], {
    trajLines: fixtureSteps(20),
    // second invocation appends only a 5-step tail (< MIN_TAIL=15) after episodes already exist -> deferred
  }),

  // ---- --context staircase boundaries: exactly at / below / above each tier ----
  S("context", "exactly-fanout-boundary-10", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(10) }),
  S("context", "one-below-fanout-boundary-9", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(9) }),
  S("context", "one-above-fanout-boundary-11", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(11) }),
  S("context", "exactly-fanout-squared-100", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(100) }),
  S("context", "one-below-fanout-squared-99", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(99) }),
  S("context", "one-above-fanout-squared-101", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"])], { trajLines: fixtureSteps(101) }),
  S("context", "small-fanout-3-multi-tier-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"])], { trajLines: fixtureSteps(30) }),
  S("context", "fanout-2-deep-tiering-32-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "2", "--raw-tail", "1"])], { trajLines: fixtureSteps(32) }),
  S("context", "start-index-snap-boundary-23-fanout-10", [inv([TRAJ_ID, "--context", "--fanout", "10", "--raw-tail", "3"])], { trajLines: fixtureSteps(23) }),
  S("context", "start-index-snap-boundary-exactly-20", [inv([TRAJ_ID, "--context", "--fanout", "10", "--raw-tail", "3"])], { trajLines: fixtureSteps(20) }),
  S("context", "raw-tail-zero", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "5", "--raw-tail", "0"])], { trajLines: fixtureSteps(10) }),
  S("context", "raw-tail-exceeds-n", [inv([TRAJ_ID, "--context", "--raw-tail", "1000"])], { trajLines: fixtureSteps(5) }),
  S("context", "budget-explicit-small", [inv([TRAJ_ID, "--context", "--budget", "500"])], { trajLines: fixtureSteps(10) }),
  S("context", "budget-auto-model-context-window-override", [inv([TRAJ_ID, "--context"], { MODEL_CONTEXT_WINDOW: "1000" })], { trajLines: fixtureSteps(10) }),
  S("context", "budget-auto-think-model-gpt41", [inv([TRAJ_ID, "--context"], { THINK_MODEL: "gpt-4.1-mini" })], { trajLines: fixtureSteps(10) }),
  S("context", "budget-auto-think-model-unknown-128k", [inv([TRAJ_ID, "--context"], { THINK_MODEL: "some-other-model" })], { trajLines: fixtureSteps(10) }),
  S("context", "budget-cap-env-non-numeric-identifier", [inv([TRAJ_ID, "--context"], { RECAP_CONTEXT_BUDGET_MAX: "notanumber" })], { trajLines: fixtureSteps(10), dev: "recap-unbound-arith" }),
  S("context", "budget-cap-env-zero", [inv([TRAJ_ID, "--context"], { RECAP_CONTEXT_BUDGET_MAX: "0" })], { trajLines: fixtureSteps(10) }),
  S("context", "rollup-fanout-env-vs-flag-precedence", [inv([TRAJ_ID, "--context", "--fanout", "4", "--raw-tail", "0", "--backfill"], { ROLLUP_FANOUT: "10" })], { trajLines: fixtureSteps(12) }),
  S("context", "incremental-append-crosses-tier-boundary", [
    inv([TRAJ_ID, "--context", "--backfill", "--fanout", "5", "--raw-tail", "0"]),
    inv([TRAJ_ID, "--context", "--fanout", "5", "--raw-tail", "0"], undefined, { appendLines: fixtureSteps(5, { offset: 10 }) }),
  ], { trajLines: fixtureSteps(10) }),
  S("context", "rebuild-drops-tK-and-reseals", [
    inv([TRAJ_ID, "--context", "--backfill", "--fanout", "5", "--raw-tail", "0"]),
    inv([TRAJ_ID, "--context", "--rebuild", "--fanout", "5", "--raw-tail", "0"]),
  ], { trajLines: fixtureSteps(10) }),
  S("context", "cached-mode-never-builds-blocks", [inv([TRAJ_ID, "--context", "--cached", "--backfill", "--fanout", "5", "--raw-tail", "0"])], { trajLines: fixtureSteps(10) }),

  // ---- llm seams: fenced JSON / retry / empty / non-zero exit / huge output ----
  S("llm", "map-reply-fenced-json", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "fenced" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-reply-fenced-with-chatter-before-after", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "fenced-chatter" })], { trajLines: fixtureSteps(3) }),
  S("llm", "reduce-reply-fenced-json", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:fenced" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-badjson-once-then-ok-retry-succeeds", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:badjson,2:ok" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-badjson-twice-dies", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "badjson" })], { trajLines: fixtureSteps(3) }),
  S("llm", "reduce-badjson-once-then-ok", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:badjson,3:ok" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-empty-output-treated-invalid", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "empty" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-whitespace-only-output", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "whitespace-only" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-nonzero-exit-discards-stdout", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "nonzero" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-nonzero-exit-once-then-ok", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:nonzero,2:ok" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-null-top-level-reply", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "null" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-false-top-level-reply", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "false" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-string-top-level-reply-then-ok", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:string,2:ok" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-nonobject" }),
  S("llm", "map-number-top-level-reply-then-ok", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:number,2:ok" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-nonobject" }),
  S("jqabort", "map-reply-is-array", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "array" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-nonobject" }),
  S("jqabort", "reduce-reply-is-array", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:array" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-nonobject" }),
  S("jqabort", "reduce-reply-is-string", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:string" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-nonobject" }),
  S("jqabort", "rollup-reply-is-array", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "array" })], { trajLines: fixtureSteps(3), dev: "recap-rollup-jqreply-nonobject" }),
  S("llm", "rollup-reply-fenced", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "fenced" })], { trajLines: fixtureSteps(3) }),
  S("llm", "rollup-step-ids-are-numbers-not-strings", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "step-ids-numbers" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-notable-steps-is-string-not-array", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "notable-steps-string" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-themes-is-object-not-array", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "themes-object" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-downstream" }),
  S("llm", "map-reply-with-del-and-unicode-title", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "unicode-and-del" })], { trajLines: fixtureSteps(3), dev: "recap-jqreply-downstream" }),
  S("llm", "reduce-numlit-episodes-array", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:numlit-episodes" })], { trajLines: fixtureSteps(3) }),
  S("llm", "map-capped-stream-over-1mib", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:huge" })], { trajLines: fixtureSteps(3), dev: "recap-capped-stream-quadratic" }),
  S("llm", "reduce-capped-stream-over-1mib", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_AT: "1:ok,2:huge" })], { trajLines: fixtureSteps(3), dev: "recap-capped-stream-quadratic" }),
  S("llm", "rollup-capped-stream-over-1mib", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_AT: "1:huge" })], { trajLines: fixtureSteps(3), dev: "recap-capped-stream-quadratic" }),
  // ---- 2e39a3f lane (i): refusal placeholder, seal cap, namers ----
  S("refusal", "single-block-refused", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "refused" })], { trajLines: fixtureSteps(3) }),
  S("refusal", "refused-line-with-exit-0-still-refusal", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "refused-exit0" })], { trajLines: fixtureSteps(3) }),
  S("refusal", "second-t1-block-refused-build-continues", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_AT: "2:refused" })], { trajLines: fixtureSteps(9) }),
  S("refusal", "tier2-block-refused", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_AT: "4:refused" })], { trajLines: fixtureSteps(9) }),
  S("refusal", "all-blocks-refused", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_MODE: "refused" })], { trajLines: fixtureSteps(9) }),
  S("refusal", "refused-then-rerun-skips-existing", [
    inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_AT: "1:refused" }),
    inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"]),
  ], { trajLines: fixtureSteps(6) }),
  S("refusal", "badjson-stops-build-early-still-assembles", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { LLM_AT: "2:badjson,3:badjson" })], { trajLines: fixtureSteps(9) }),
  S("refusal", "map-call-refused-is-not-special", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { LLM_MODE: "refused" })], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "cap-2-of-many", [
    inv([TRAJ_ID, "--context", "--fanout", "3", "--raw-tail", "0"]),
    inv([TRAJ_ID, "--context", "--fanout", "3", "--raw-tail", "0"], { ROLLUP_MAX_SEALS: "2" }, { appendLines: fixtureSteps(18, { offset: 3 }) }),
    inv([TRAJ_ID, "--context", "--fanout", "3", "--raw-tail", "0"], { ROLLUP_MAX_SEALS: "2" }),
  ], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "cap-0-means-no-cap", [
    inv([TRAJ_ID, "--context", "--fanout", "3", "--raw-tail", "0"]),
    inv([TRAJ_ID, "--context", "--fanout", "3", "--raw-tail", "0"], { ROLLUP_MAX_SEALS: "0" }, { appendLines: fixtureSteps(24, { offset: 3 }) }),
  ], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "default-cap-20", [
    inv([TRAJ_ID, "--context", "--fanout", "2", "--raw-tail", "0"]),
    inv([TRAJ_ID, "--context", "--fanout", "2", "--raw-tail", "0"], undefined, { appendLines: fixtureSteps(40, { offset: 2 }) }),
  ], { trajLines: fixtureSteps(2) }),
  S("seal-cap", "backfill-ignores-cap", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0"], { ROLLUP_MAX_SEALS: "1" })], { trajLines: fixtureSteps(12) }),
  S("seal-cap", "cap-non-numeric-dies", [inv([TRAJ_ID, "--context", "--fanout", "3"], { ROLLUP_MAX_SEALS: "lots" })], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "cap-negative-dies", [inv([TRAJ_ID, "--context", "--fanout", "3"], { ROLLUP_MAX_SEALS: "-1" })], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "cap-empty-falls-back-to-20", [inv([TRAJ_ID, "--context", "--fanout", "3"], { ROLLUP_MAX_SEALS: "" })], { trajLines: fixtureSteps(3) }),
  S("seal-cap", "cap-leading-zero", [inv([TRAJ_ID, "--context", "--fanout", "3"], { ROLLUP_MAX_SEALS: "007" })], { trajLines: fixtureSteps(3) }),
  S("namers", "budget-10-no-room-hint-to-stderr", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "10"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-100-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "100"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "no-cite-nothing-to-name", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "1000"])], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-300-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "300"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-600-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "600"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-1000-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "1000"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-2000-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "2000"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-5000-30-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "5000"], CITE)], { trajLines: fixtureSteps(30) }),
  S("namers", "budget-1500-fanout2-40-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "2", "--raw-tail", "1", "--budget", "1500"], CITE)], { trajLines: fixtureSteps(40) }),
  S("namers", "budget-3000-fanout2-40-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "2", "--raw-tail", "1", "--budget", "3000"], CITE)], { trajLines: fixtureSteps(40) }),
  S("namers", "default-budget-fanout2-40-steps", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "2", "--raw-tail", "1"], CITE)], { trajLines: fixtureSteps(40) }),
  S("namers", "refused-placeholder-block-is-namer-candidate", [inv([TRAJ_ID, "--context", "--backfill", "--fanout", "3", "--raw-tail", "0", "--budget", "1500"], { LLM_AT: "2:refused", ...CITE })], { trajLines: fixtureSteps(30) }),
  S("llm", "argv-and-stdin-exact-map-call", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0", "--map-model", "map-M", "--reduce-model", "reduce-R"])], { trajLines: fixtureSteps(3) }),
  S("llm", "argv-max-tokens-8192-on-reduce", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: fixtureSteps(3) }),

  // ---- output formats ----
  S("output", "json-output-key-order-and-numbers", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0", "--json"])], { trajLines: fixtureSteps(3) }),
  S("output", "text-output-multi-episode-multi-theme", [inv([TRAJ_ID, "--window", "5", "--gap-minutes", "0"])], { trajLines: fixtureSteps(15) }),
  S("output", "cached-json-after-generate", [
    inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"]),
    inv([TRAJ_ID, "--cached", "--json"]),
  ], { trajLines: fixtureSteps(3) }),

  // ---- env vars: set / unset / empty, every var the Bash reads ----
  S("env", "recap-model-set", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { RECAP_MODEL: "env-model-x" })], { trajLines: fixtureSteps(3) }),
  S("env", "recap-model-empty-falls-through-to-shellm", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { RECAP_MODEL: "", SHELLM_MODEL: "shellm-y" })], { trajLines: fixtureSteps(3) }),
  S("env", "shellm-model-only", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { SHELLM_MODEL: "shellm-only" })], { trajLines: fixtureSteps(3) }),
  S("env", "no-model-env-uses-default", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"])], { trajLines: fixtureSteps(3) }),
  S("env", "recap-map-model-and-reduce-model-both-set", [inv([TRAJ_ID, "--window", "10", "--gap-minutes", "0"], { RECAP_MAP_MODEL: "mm", RECAP_REDUCE_MODEL: "rm" })], { trajLines: fixtureSteps(3) }),
  S("env", "recap-max-window-bytes-empty-falls-back", [inv([TRAJ_ID, "--window", "1000", "--gap-minutes", "0"], { RECAP_MAX_WINDOW_BYTES: "" })], { trajLines: fixtureSteps(20) }),
  S("env", "recap-max-window-bytes-tiny", [inv([TRAJ_ID, "--window", "1000", "--gap-minutes", "0"], { RECAP_MAX_WINDOW_BYTES: "50" })], { trajLines: fixtureSteps(10) }),
  S("env", "rollup-fanout-set", [inv([TRAJ_ID, "--context", "--backfill", "--raw-tail", "0"], { ROLLUP_FANOUT: "4" })], { trajLines: fixtureSteps(16) }),
  S("env", "rollup-fanout-empty-falls-back-to-10", [inv([TRAJ_ID, "--context", "--backfill", "--raw-tail", "0"], { ROLLUP_FANOUT: "" })], { trajLines: fixtureSteps(10) }),
  S("env", "monolith-context-budget-set", [inv([TRAJ_ID, "--context"], { MONOLITH_CONTEXT_BUDGET: "800" })], { trajLines: fixtureSteps(10) }),
  S("env", "monolith-context-budget-empty-falls-to-auto", [inv([TRAJ_ID, "--context"], { MONOLITH_CONTEXT_BUDGET: "" })], { trajLines: fixtureSteps(10) }),
  S("env", "rollup-raw-tail-env-set", [inv([TRAJ_ID, "--context", "--backfill"], { ROLLUP_RAW_TAIL: "4" })], { trajLines: fixtureSteps(10) }),
  S("env", "model-context-window-env-set", [inv([TRAJ_ID, "--context"], { MODEL_CONTEXT_WINDOW: "50000" })], { trajLines: fixtureSteps(10) }),
  S("env", "think-model-and-shellm-model-both-set-think-wins", [inv([TRAJ_ID, "--context"], { THINK_MODEL: "gpt-o3", SHELLM_MODEL: "claude-x" })], { trajLines: fixtureSteps(10) }),
  S("env", "recap-context-budget-max-set-small", [inv([TRAJ_ID, "--context"], { RECAP_CONTEXT_BUDGET_MAX: "100" })], { trajLines: fixtureSteps(10) }),
  S("env", "traj-id-env-used-when-no-positional", [inv([], { TRAJ_ID: TRAJ_ID })], { trajLines: fixtureSteps(1) }),
  S("env", "traj-id-arg-overrides-env", [inv(["zzzzzzzz-nomatch"], { TRAJ_ID: TRAJ_ID })], { trajLines: fixtureSteps(1) }),

  // ---- trajectory resolution: hex prefix, full path, ambiguity ----
  S("resolve", "hex-prefix-match", [inv(["aaaaaaaa"])], { trajLines: fixtureSteps(1) }),
  S("resolve", "uuid-with-dashes-prefix-before-first-dash", [inv(["aaaaaaaa-doesnotexist"])], { trajLines: fixtureSteps(1) }),
  S("resolve", "no-match-dies", [inv(["zzzzzzzz"])], { trajLines: fixtureSteps(1) }),
  S("resolve", "traj-dir-itself-is-the-run-dir", [inv(["."], { TRAJ_DIR: null })], {
    trajLines: fixtureSteps(1),
    setup: () => {},
  }),
];

// The "traj-dir-itself-is-the-run-dir" scenario needs TRAJ_DIR to point AT the
// run dir itself (not its parent); patch it structurally after definition so
// makeSandbox/writeTraj (which assume TRAJ_DIR/TRAJ_ID/trajectory.jsonl) still
// work — we special-case its env at run time below instead of here.
scenarios.pop();
scenarios.push(
  S("resolve", "traj-dir-itself-is-the-run-dir", [{ argv: [], env: {}, __trajDirIsRunDir: true }], { trajLines: fixtureSteps(1) })
);

// --- execute --------------------------------------------------------------------------
const results = [];
const movedToParser = [];
for (const sc of scenarios) {
  if (ONLY && !ONLY.test(`${sc.group}/${sc.name}`)) continue;
  const plan = planOf(sc);
  if (plan === "parser") {
    movedToParser.push(`${sc.group}/${sc.name}`);
    continue;
  }
  callFixtures[`${sc.group}--${sc.name}`] = plan;
  const out = {};
  for (const kind of ["bash", "ts"]) {
    // Special-case: TRAJ_DIR == the run dir itself (a full dir path, not root+ID).
    const scRun = sc.invocations.some((i) => i.__trajDirIsRunDir)
      ? { ...sc, invocations: sc.invocations.map((i) => ({ argv: i.argv, env: i.env })) }
      : sc;
    let runner = () => runTool(kind, scRun);
    if (sc.invocations.some((i) => i.__trajDirIsRunDir)) {
      const sb0 = makeSandbox();
      writeTraj(sb0, sc.trajLines ?? []);
      const rd = runDirOf(sb0);
      const env = { TRAJ_DIR: rd };
      const r = await runInvocation(kind, [], env, rd, `${sc.group}--${sc.name}`);
      const nowMs = Date.now();
      const state = serializeState(rd, nowMs);
      const calls = r.calls;
      fs.rmSync(sb0, { recursive: true, force: true });
      out[kind] = { invocations: [{ ...r, calls }], state, sb: sb0 };
      continue;
    }
    out[kind] = await runTool(kind, sc);
  }
  const b = out.bash;
  const t = out.ts;

  const nInv = Math.max(b.invocations.length, t.invocations.length);
  const invCmp = [];
  let stdoutOk = true, stderrOk = true, statusOk = true, callsOk = true;
  for (let i = 0; i < nInv; i++) {
    const bi = b.invocations[i] ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, calls: [] };
    const ti = t.invocations[i] ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, calls: [] };
    const bOut = norm(bytesToText(bi.stdout), b.sb);
    const tOut = norm(bytesToText(ti.stdout), t.sb);
    const bErr = norm(bytesToText(bi.stderr), b.sb);
    const tErr = norm(bytesToText(ti.stderr), t.sb);
    const bStatus = `${bi.status}${bi.signal ? "/" + bi.signal : ""}${bi.timedOut ? "/TIMEOUT" : ""}`;
    const tStatus = `${ti.status}${ti.signal ? "/" + ti.signal : ""}${ti.timedOut ? "/TIMEOUT" : ""}`;
    const bCalls = norm(callsToText(bi.calls ?? []), b.sb);
    const tCalls = norm(callsToText(ti.calls ?? []), t.sb);
    const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bStatus === tStatus, calls: bCalls === tCalls };
    if (!cmp.stdout) stdoutOk = false;
    if (!cmp.stderr) stderrOk = false;
    if (!cmp.status) statusOk = false;
    if (!cmp.calls) callsOk = false;
    // Both-sides-timeout is never silently PARITY.
    if (bi.timedOut && ti.timedOut) { stdoutOk = stderrOk = statusOk = false; }
    invCmp.push({ cmp, bash: { stdoutN: bOut, stderrN: bErr, status: bStatus, callsN: bCalls }, ts: { stdoutN: tOut, stderrN: tErr, status: tStatus, callsN: tCalls } });
  }
  const bState = norm(b.state, b.sb);
  const tState = norm(t.state, t.sb);
  const stateOk = bState === tState;

  const cmp = { stdout: stdoutOk, stderr: stderrOk, status: statusOk, state: stateOk, calls: callsOk };
  const differing = Object.keys(cmp).filter((f) => !cmp[f]);
  let verdict = "PARITY";
  if (differing.length > 0) {
    const dv = sc.dev !== undefined && sc.dev !== null ? DEV[sc.dev] : null;
    verdict = dv && differing.every((f) => dv.fields.includes(f)) ? "DEVIATION" : "DIVERGE";
  }

  results.push({
    group: sc.group,
    name: sc.name,
    invocations: sc.invocations.map((i) => i.argv),
    dev: sc.dev ?? null,
    verdict,
    differing,
    invCmp,
    state: { match: stateOk, bash: bState, ts: tState },
  });
  const tag = verdict === "PARITY" ? "ok  " : verdict === "DEVIATION" ? "dev " : "DIFF";
  process.stdout.write(`${tag} ${sc.group}/${sc.name}${differing.length ? `  [${differing.join(",")}]` : ""}\n`);
}

for (const d of Object.values(LLMBIN)) fs.rmSync(d, { recursive: true, force: true });
await replay.close();

// --- report ------------------------------------------------------------------------
const total = results.length;
const parity = results.filter((r) => r.verdict === "PARITY").length;
const deviations = results.filter((r) => r.verdict === "DEVIATION").length;
const diverge = results.filter((r) => r.verdict === "DIVERGE").length;

const CLIP = 1500;
const clip = (s, n = CLIP) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n)}…(+${String(s).length - n} chars)` : String(s));
function block(label, a, bb, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(clip(a))}\n      ts  : ${JSON.stringify(clip(bb))}`;
}

let md = `# recap — ADVERSARIAL differential check (tester's own harness)\n\n`;
md += `Generated by \`parity/recap/run-parity-adversarial.mjs\`. Real Bash \`headlong/bin/recap\` vs \`bin/recap.mjs\`, identical trajectory fixtures, each side's real \`llm\` client on ONE replay server (\`parity/support/replayModel.mjs\`). Model replies are RECORDED real DeepSeek replies (\`recordings/shared.json\`, one per call kind, recorded ${replay.recording("shared").recorded_at}, model ${replay.recording("shared").model}) served in CYCLE (${replay.cycled.length} cycled serves this run); failures are labelled HTTP transport fixtures (HTTP 500, an empty stream, a content_filter stream, a >1 MiB capped stream). Replay misses: ${replay.misses.length}. ${movedToParser.length} scenario(s) whose old fake reply was model TEXT moved to the no-model parser layer (\`run-parser-parity.mjs\`): ${movedToParser.join(", ")}. Verdict fields: stdout/stderr (byte-safe decode, normalized only for timestamps/paths), exit status(+signal), on-disk cache state (recap/ + rollups/, byte-exact; \`.lock\` dirs compared by existence + a coarse age bucket, never content), and the exact wire request each side's \`llm\` sent, in call order.\n\n`;
md += `## Result: ${total} scenarios — ${parity} PARITY, ${deviations} documented DEVIATION, **${diverge} DIVERGE**\n\n`;
md += `| # | group | scenario | verdict | fields |\n|---|---|---|---|---|\n`;
results.forEach((r, i) => {
  md += `| ${i + 1} | ${r.group} | ${r.name} | ${r.verdict} | ${r.differing.join(", ") || "-"} |\n`;
});

md += `\n## Tester's classification of every non-PARITY finding\n\n`;
md += `| scenario | verdict | class | note |\n|---|---|---|---|\n`;
const untriaged = [];
for (const r of results.filter((x) => x.verdict !== "PARITY")) {
  const key = `${r.group}/${r.name}`;
  const t = TRIAGE[key];
  if (t) {
    md += `| ${key} | ${r.verdict} | ${t[0]} | ${t[1].replace(/\|/g, "\\|")} |\n`;
  } else if (r.verdict === "DEVIATION") {
    md += `| ${key} | ${r.verdict} | DOC | PARITY.md row: ${DEV[results.find((x) => x.group === r.group && x.name === r.name).dev]?.row ?? "(unknown)"} |\n`;
  } else {
    untriaged.push(key);
  }
}
if (untriaged.length) md += `\nUNTRIAGED (new/unexpected — inspect the detail section): ${untriaged.join(", ")}\n`;

md += `\n## Divergences and deviations (detail)\n\n`;
for (const r of results.filter((x) => x.verdict !== "PARITY")) {
  md += `### ${r.verdict}: ${r.group} / ${r.name}\n- invocations: \`${JSON.stringify(r.invocations)}\`\n`;
  r.invCmp.forEach((ic, i) => {
    md += `  -- invocation ${i} --\n  exit: bash=${ic.bash.status} ts=${ic.ts.status}\n\`\`\`\n`;
    md += block("stdout", ic.bash.stdoutN, ic.ts.stdoutN, ic.cmp.stdout) + "\n";
    md += block("stderr", ic.bash.stderrN, ic.ts.stderrN, ic.cmp.stderr) + "\n";
    md += block("llmCalls", ic.bash.callsN, ic.ts.callsN, ic.cmp.calls) + "\n";
    md += "```\n";
  });
  md += "```\n" + block("state", r.state.bash, r.state.ts, r.state.match) + "\n```\n\n";
}

// Scrub the real headlong root + $HOME from the committed artifacts.
function scrubForWrite(s) {
  if (typeof s !== "string") return s;
  return scrubPath(s);
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

fs.writeFileSync(path.join(HERE, "report-adversarial.md"), scrubForWrite(md));
fs.writeFileSync(
  path.join(HERE, "results-adversarial.json"),
  JSON.stringify(
    deepScrub({
      total,
      parity,
      deviations,
      diverge,
      results: results.map((r) => ({ ...r, invCmp: r.invCmp.map((ic) => ({ cmp: ic.cmp, bash: { ...ic.bash, stdoutN: clip(ic.bash.stdoutN, 3000), stderrN: clip(ic.bash.stderrN, 3000), callsN: clip(ic.bash.callsN, 3000) }, ts: { ...ic.ts, stdoutN: clip(ic.ts.stdoutN, 3000), stderrN: clip(ic.ts.stderrN, 3000), callsN: clip(ic.ts.callsN, 3000) } })), state: { match: r.state.match, bash: clip(r.state.bash, 3000), ts: clip(r.state.ts, 3000) } })),
    }),
    null,
    2,
  ),
);

console.log(`\nadversarial: ${total} scenarios — ${parity} parity, ${deviations} documented deviations, ${diverge} DIVERGE`);
if (untriaged.length) console.log(`UNTRIAGED: ${untriaged.join(", ")}`);
process.exit(0); // this harness reports; it does not gate CI on its own exit code
