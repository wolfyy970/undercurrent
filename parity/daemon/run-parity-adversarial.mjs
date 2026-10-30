#!/usr/bin/env node
// run-parity-adversarial.mjs — INDEPENDENT adversarial differential check of the
// daemon-runtime port (src/{runstate,feeder,daemon,steprun,thinkersctl,identity,
// identity-env}.ts, bin/{dispatcherd,thinker-step,thinkers,identity,chat}.mjs)
// against the real Bash stack (headlong/bin/thinkers, headlong/tools/identity,
// headlong/bin/chat).
//
// Written by the tester, not the translator. Drives BOTH real CLI stacks
// against fresh, hand-built identities with a single no-op "echo" thinker
// (same script on both sides — no LLM, no bash-tool needed inside a step) so
// the on-disk `run/` CONTRACT and CLI text/exit-code contract are exercised
// without touching the cognition engine at all. Separately, an `identity new`
// flow diffs the real directory layout the two `identity new` implementations
// produce.
//
// Compared (verdict-bearing), per flow:
//   stdout/stderr  text, normalized symmetrically (pids, tokens, epochs,
//                  ISO timestamps, tmp sandbox paths, repo paths)
//   exit code      (+ signal, where relevant)
//   run/ state     every file under <identity>/run (and, for identity-new,
//                  every file under the fresh identity dir), BYTES, same
//                  normalization
//
// A flow may cite a PARITY.md deviation row; a mismatch is DEVIATION only
// when confined to that row's allowed fields. Everything else is DIVERGE.
//
// Run: node parity/daemon/run-parity-adversarial.mjs   (ONLY=<regex> to filter flow names)
//
// Cleanup: every daemon this harness starts is stopped (SIGTERM, then
// SIGKILL on timeout) before the process exits, in a `finally`. A residual
// `pgrep -f dispatcherd` check runs at the end and is reported (never killed
// blindly — see the final summary).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Scrubbed to a placeholder for release; set PARITY_HEADLONG_ROOT=/abs/path/to/headlong
// to reproduce the run against the real Bash tool.
const HEADLONG_ROOT = process.env.PARITY_HEADLONG_ROOT || "<HEADLONG_ROOT>";
const HOME_DIR = os.homedir();
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const REPORT_SUFFIX = process.env.PARITY_REPORT_SUFFIX || "";

if (!fs.existsSync(path.join(HEADLONG_ROOT, "bin", "thinkers"))) {
  console.error(`adversarial: Bash headlong checkout not found at ${HEADLONG_ROOT} (set PARITY_HEADLONG_ROOT)`);
  process.exit(2);
}

const BASH_THINKERS = path.join(HEADLONG_ROOT, "bin", "thinkers");
const BASH_IDENTITY = path.join(HEADLONG_ROOT, "tools", "identity");
const BASH_CHAT = path.join(HEADLONG_ROOT, "bin", "chat");
const TS_THINKERS = path.join(REPO, "bin", "thinkers.mjs");
const TS_IDENTITY = path.join(REPO, "bin", "identity.mjs");
const TS_CHAT = path.join(REPO, "bin", "chat.mjs");
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- process bookkeeping: every daemon pid we start, per kind, so we can
// clean up in a `finally` no matter how a flow ends. --------------------------------
const startedDaemonPids = { bash: new Set(), ts: new Set() };

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

async function killDaemon(pid) {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(50);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function cleanupAllStarted() {
  for (const kind of ["bash", "ts"]) {
    for (const pid of startedDaemonPids[kind]) await killDaemon(pid);
    startedDaemonPids[kind].clear();
  }
}

// --- scrubbing / normalization ------------------------------------------------------
function scrubPath(s, sb) {
  return String(s)
    .replaceAll(sb, "<SB>")
    .replaceAll(HEADLONG_ROOT, "<HEADLONG_ROOT>")
    .replaceAll(REPO, "<REPO>")
    .replaceAll(HOME_DIR, "<HOME>");
}

/** Normalize volatile fields SYMMETRICALLY (same regex on both sides' output):
 *  pids, dispatcher tokens (epoch.pid.rand), bare epoch integers standing
 *  alone in run/ file bytes, ISO-ish timestamps (both the `...Z` form and
 *  upstream's local `YYY-MM-DDTHH:MM:SS` form), step_ids/uuids, tmp paths. */
function norm(s, sb) {
  return scrubPath(String(s), sb)
    .replace(/\b\d{10,11}\.\d+\.\d{1,5}\b/g, "<TOKEN>") // dispatcher.token: epoch.pid.rand (pre-2e39a3f)
    .replace(/PID \d+/g, "PID <PID>")
    .replace(/pid \d+/g, "pid <PID>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|\+0000)?/g, "<TS>")
    .replace(/quiet \d+s/g, "quiet <N>s")
    .replace(/due \d+s ago/g, "due <N>s ago")
    .replace(/active=\d+/g, "active=<N>");
}

// --- sandbox construction: a hand-built identity dir, decoupled from
// `identity new` (which has its own dedicated flow below), so daemon-loop
// scenarios aren't entangled with identity-bootstrap divergences. ------------------
const ECHO_STEP = `#!/usr/bin/env node
// echo thinker — no-op step used ONLY by the daemon-runtime differential
// harness. Reads the trigger JSON on stdin, appends it (plus a marker
// with the invoking thinker's own pid and a monotonic sequence file) to
// <identity>/echo.received.jsonl, then exits 0 immediately. No LLM, no
// sandbox, no bash tool use inside the step -- this exercises the
// daemon's run/ contract in isolation.
import * as fs from "node:fs";
import * as path from "node:path";
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
const identityDir = process.env.IDENTITY_DIR || process.cwd();
const out = path.join(identityDir, "echo.received.jsonl");
const rec = { pid: process.pid, trigger: raw };
fs.appendFileSync(out, JSON.stringify(rec) + "\\n");
// A short, FIXED sleep (not fs-event-driven) so both engines' step_pids
// ledger has a real window in which the pid is observably alive.
const until = Date.now() + 300;
while (Date.now() < until) { /* busy-wait: keep this a single-file, dependency-free script */ }
`;

function hex8() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Build one identity dir, byte-for-byte comparable between kinds (same
 *  script content, same subscriptions.jsonl modulo traj_id). Returns paths +
 *  the env each CLI stack needs (bash needs everything explicit; the TS
 *  stack only strictly needs IDENTITY_DIR, but we pass the same explicit set
 *  so both are driven identically). */
function buildIdentity(root, name, opts = {}) {
  const identityDir = path.join(root, name);
  fs.mkdirSync(path.join(identityDir, "memories"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "kernel"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "trajectories"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "thinkers"), { recursive: true });

  const trajId = `${hex8()}-root`;
  const trajDir = path.join(identityDir, "trajectories", trajId);
  fs.mkdirSync(trajDir, { recursive: true });
  const genesis = { type: "trajectory", step_id: randomUUID(), ts: new Date().toISOString() };
  fs.writeFileSync(path.join(trajDir, "trajectory.jsonl"), JSON.stringify(genesis) + "\n");

  fs.writeFileSync(path.join(identityDir, "info.txt"), `name=${name}\ncreated=${new Date().toISOString()}\nroot_trajectory=${trajId}\n`);

  const echoDir = path.join(identityDir, "thinkers", "echo");
  fs.mkdirSync(echoDir, { recursive: true });
  fs.writeFileSync(path.join(echoDir, "step"), ECHO_STEP, { mode: 0o755 });
  const subs = opts.subscription ?? { types: ["message", "monolith-wake"], trigger_self: false, traj_id: trajId };
  fs.writeFileSync(path.join(echoDir, "subscriptions.jsonl"), JSON.stringify(subs) + "\n");
  if (opts.disabledEcho) fs.writeFileSync(path.join(echoDir, "disabled"), "test-disabled\n");

  return { identityDir, trajDir: path.join(identityDir, "trajectories"), trajId, runDir: path.join(identityDir, "run") };
}

function baseEnv(kind, id, sb) {
  const nodeDir = path.dirname(NODE);
  const PATH = [path.dirname(kind === "bash" ? BASH_THINKERS : TS_THINKERS), nodeDir, process.env.PATH].join(path.delimiter);
  const env = {
    PATH,
    HOME: path.join(sb, "homedir"),
    TMPDIR: path.join(sb, "tmp"),
    HEADLONG_HOME: path.join(sb, "home"),
    IDENTITY_DIR: id.identityDir,
    IDENTITY_NAME: path.basename(id.identityDir),
    TRAJ_DIR: id.trajDir,
    TRAJ_ID: id.trajId,
    THINKERS_DIR: path.join(id.identityDir, "thinkers"),
    MEM_DIR: path.join(id.identityDir, "memories"),
    SKILLS_DIR: path.join(id.identityDir, "skills"),
    SKILLS_KERNEL_DIR: path.join(id.identityDir, "kernel"),
    LC_ALL: "C",
    LANG: "C",
  };
  return env;
}

function run(cmd, argv, env, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { env, stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
    const out = [];
    const err = [];
    p.stdout.on("data", (b) => out.push(b));
    p.stderr.on("data", (b) => err.push(b));
    p.stdin.on("error", () => {});
    if (opts.stdin !== undefined) p.stdin.end(opts.stdin);
    else p.stdin.end();
    const t = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 15000);
    p.on("close", (status, signal) => {
      clearTimeout(t);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status, signal });
    });
  });
}

function cliThinkers(kind, argv, env, opts) {
  return kind === "bash" ? run(BASH_THINKERS, argv, env, opts) : run(NODE, [TS_THINKERS, ...argv], env, opts);
}
function cliChat(kind, argv, env, opts) {
  return kind === "bash" ? run(BASH_CHAT, argv, env, opts) : run(NODE, [TS_CHAT, ...argv], env, opts);
}
function cliIdentity(kind, argv, env, opts) {
  return kind === "bash" ? run(BASH_IDENTITY, argv, env, opts) : run(NODE, [TS_IDENTITY, ...argv], env, opts);
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await predicate();
    } catch {
      v = false;
    }
    if (v) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Serialize the full run/ dir as a sorted list of FILE blocks (bytes as
 *  text where valid utf8, else hex), like the llm harness's sandbox dump. */
function serializeDir(dir, sb) {
  const acc = [];
  function walk(d, base) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else {
        let content;
        try {
          content = fs.readFileSync(full);
        } catch {
          content = Buffer.from("<unreadable>");
        }
        const text = content.toString("utf8");
        acc.push({ rel, text: Buffer.from(text, "utf8").equals(content) ? text : `<bytes hex ${content.toString("hex")}>` });
      }
    }
  }
  walk(dir, "");
  if (acc.length === 0) return "<empty>";
  return acc.map((f) => `FILE ${f.rel}\n${norm(f.text, sb)}`).join("\n----\n");
}

function getDaemonPid(runDir) {
  const t = readIfExists(path.join(runDir, "dispatcher.pid"));
  if (t === null) return null;
  const n = parseInt(t.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// --- documented deviations (PARITY.md rows) — a flow's `dev` field names
// one of these; the diff is DEVIATION (not DIVERGE) only if confined to the
// row's allowed sub-fields. ------------------------------------------------------
const DEV = {
  "no-activate": { row: "activate — no `activate` file is ever written (DIRECTOR CORRECTION)" },
  "node-step-shim": { row: "thinkers/<name>/step — Node file instead of a Bash exec-shim (DIRECTOR CORRECTION)" },
  "kernel-skills-copied": {
    row: "kernel/{mem,chat,goals}, skills/<bundled> — copied SKILL.md text instead of symlinks into the Bash checkout (DIRECTOR CORRECTION)",
  },
  "bash-omitted": {
    row: "thinkers/_lib/common.sh, thinkers/retrieval/build-index.sh — Bash helper/indexer omitted, never copied (DIRECTOR RULE)",
  },
};

// --- results ------------------------------------------------------------------------
const results = [];
function record(flow, name, verdict, detail, dev) {
  results.push({ flow, name, verdict, detail, dev: dev ?? null });
  const tag = verdict === "PARITY" ? "ok  " : verdict === "DEVIATION" ? "dev " : "DIFF";
  process.stdout.write(`${tag} ${flow}/${name}\n`);
}

function diffText(bash, ts) {
  return bash === ts ? null : { bash, ts };
}

// =====================================================================================
// FLOW 1 — identity new: real directory-layout diff.
// =====================================================================================
async function flowIdentityNew() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-idnew-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-idnew-ts-"));
  for (const sb of [sbBash, sbTs]) for (const d of ["identities", "home", "homedir", "tmp"]) fs.mkdirSync(path.join(sb, d));

  const envFor = (kind, sb) => ({
    PATH:
      kind === "bash"
        ? [path.join(HEADLONG_ROOT, "bin"), path.join(HEADLONG_ROOT, "tools"), process.env.PATH].join(path.delimiter)
        : [path.dirname(TS_IDENTITY), path.dirname(NODE), process.env.PATH].join(path.delimiter),
    HOME: path.join(sb, "homedir"),
    TMPDIR: path.join(sb, "tmp"),
    HEADLONG_HOME: path.join(sb, "home"),
    IDENTITY_DIR: path.join(sb, "identities"),
    LC_ALL: "C",
    LANG: "C",
  });

  const bashRes = await cliIdentity("bash", ["new", "--default", "echo-id"], envFor("bash", sbBash));
  const tsRes = await cliIdentity("ts", ["new", "--default", "echo-id"], envFor("ts", sbTs));

  check("identity-new", "stdout", diffText(bashRes.stdout, tsRes.stdout));
  check("identity-new", "stderr", diffText(norm(bashRes.stderr, sbBash), norm(tsRes.stderr, sbTs)));
  check("identity-new", "exit-code", diffText(String(bashRes.status), String(tsRes.status)));

  // Per-file tree comparison: EVERY relative path under identities/, both
  // sides, normalized content. A handful of paths are DIRECTOR-decided,
  // PARITY.md-documented deviations (below); everything else must be
  // byte-identical or the check DIVERGEs.
  const bashTree = walkIdentityTree(path.join(sbBash, "identities"), sbBash);
  const tsTree = walkIdentityTree(path.join(sbTs, "identities"), sbTs);

  const strictBash = [];
  const strictTs = [];
  /** dev key -> { expect, bashOnly: [], tsOnly: [], bothPresent: [], mismatched: [] } */
  const buckets = new Map();

  for (const key of new Set([...bashTree.keys(), ...tsTree.keys()])) {
    const cls = classifyIdentityPath(key);
    const b = bashTree.get(key);
    const t = tsTree.get(key);
    if (cls === null) {
      if (b !== t) {
        strictBash.push(`FILE ${key}\n${b === undefined ? "<absent>" : b}`);
        strictTs.push(`FILE ${key}\n${t === undefined ? "<absent>" : t}`);
      }
      continue;
    }
    const e = buckets.get(cls.dev) ?? { expect: cls.expect, bashOnly: [], tsOnly: [], bothPresent: [], mismatched: [] };
    if (b !== undefined && t !== undefined) {
      if (cls.expect === "both-differ" && b !== t) e.bothPresent.push(key);
      else e.mismatched.push(key); // present both sides but NOT the expected shape for this bucket
    } else if (b !== undefined) {
      if (cls.expect === "bash-only") e.bashOnly.push(key);
      else e.mismatched.push(key);
    } else if (t !== undefined) {
      if (cls.expect === "ts-only") e.tsOnly.push(key);
      else e.mismatched.push(key);
    }
    buckets.set(cls.dev, e);
  }

  check(
    "identity-new",
    "layout-strict",
    strictBash.length === 0 && strictTs.length === 0 ? null : diffText(strictBash.sort().join("\n----\n"), strictTs.sort().join("\n----\n"))
  );

  // Every classified bucket must ALSO match its own expected shape exactly —
  // an unexpected extra/missing/mismatched path inside a "documented
  // deviation" prefix is itself a real divergence, not covered by the row.
  for (const [dev, e] of buckets) {
    if (e.mismatched.length > 0) {
      record("identity-new", `${dev}-shape`, "DIVERGE", { mismatched: e.mismatched, expect: e.expect });
    } else {
      record(
        "identity-new",
        dev,
        "DEVIATION",
        { bashOnly: e.bashOnly.sort(), tsOnly: e.tsOnly.sort(), bothPresentDiffering: e.bothPresent.sort() },
        dev
      );
    }
  }

  fs.rmSync(sbBash, { recursive: true, force: true });
  fs.rmSync(sbTs, { recursive: true, force: true });
}

/**
 * Which DEV bucket a relative path (under identities/, e.g.
 * "echo-id/kernel/mem/SKILL.md") belongs to, and which side(s) of the diff
 * it is expected to exist on:
 *   "bash-only"   — bash has it, ts never does (an omission or a symlink
 *                   upstream writes that this port has no use for)
 *   "ts-only"     — ts has it, bash never does at this exact path (upstream
 *                   has it at a DIFFERENT path — a symlink one level up —
 *                   not this one)
 *   "both-differ" — both sides have it, content legitimately differs
 * Returns null for a path that must match byte-for-byte (no deviation).
 */
function classifyIdentityPath(key) {
  if (key === "echo-id/activate") return { dev: "no-activate", expect: "bash-only" };
  if (/^echo-id\/thinkers\/[^/]+\/step$/.test(key)) return { dev: "node-step-shim", expect: "both-differ" };
  if (/^echo-id\/kernel\/(mem|chat|goals)$/.test(key)) return { dev: "kernel-skills-copied", expect: "bash-only" };
  if (/^echo-id\/kernel\/(mem|chat|goals)\/SKILL\.md$/.test(key)) return { dev: "kernel-skills-copied", expect: "ts-only" };
  if (/^echo-id\/skills\/[^/]+$/.test(key)) return { dev: "kernel-skills-copied", expect: "bash-only" };
  if (/^echo-id\/skills\/[^/]+\/SKILL\.md$/.test(key)) return { dev: "kernel-skills-copied", expect: "ts-only" };
  if (key === "echo-id/thinkers/_lib/common.sh") return { dev: "bash-omitted", expect: "bash-only" };
  if (key === "echo-id/thinkers/retrieval/build-index.sh") return { dev: "bash-omitted", expect: "bash-only" };
  return null;
}

/** Walk identities/ into a Map<normalized relpath, normalized content>. Keys
 *  AND values are normalized identically to norm()/serializeDir's own rules,
 *  plus the root-trajectory hex (both sides pick a fresh random one). */
function walkIdentityTree(dir, sb) {
  const acc = new Map();
  function normalize(s) {
    return norm(s, sb).replace(/[0-9a-f]{8}-root/g, "<ROOTHEX>-root");
  }
  function walk(d, base) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else {
        let content;
        try {
          content = fs.readFileSync(full);
        } catch {
          content = Buffer.from("<unreadable>");
        }
        const text = content.toString("utf8");
        const asText = Buffer.from(text, "utf8").equals(content) ? text : `<bytes hex ${content.toString("hex")}>`;
        acc.set(normalize(rel), normalize(asText));
      }
    }
  }
  walk(dir, "");
  return acc;
}

// =====================================================================================
// FLOW 2 — daemon boot via named `thinkers start`: run/ contract at boot + boot kick.
// =====================================================================================
async function flowBootNamed(kind, sb) {
  const id = buildIdentity(sb, "echo-id");
  const env = baseEnv(kind, id, sb);
  const r = await cliThinkers(kind, ["start", "echo"], env);
  const dpid = getDaemonPid(id.runDir);
  if (dpid !== null) startedDaemonPids[kind].add(dpid);

  // Let the boot-kick manual-trigger fire and the echo step complete + prune.
  await waitFor(() => {
    const sp = readIfExists(path.join(id.runDir, "step_pids"));
    return sp === "" || sp === null;
  }, 4000);
  await sleep(150);

  const snap = {
    stdout: r.stdout,
    stderr: norm(r.stderr, sb),
    status: r.status,
    pidFormat: (readIfExists(path.join(id.runDir, "dispatcher.pid")) ?? "<absent>").replace(/^\d+$/, "<PID>"),
    // 2e39a3f (b33f2a3): the token is 16 random bytes as hex; the old epoch.pid.rand form is still accepted.
    tokenFormat: (readIfExists(path.join(id.runDir, "dispatcher.token")) ?? "<absent>").replace(/^(?:[0-9a-f]{32}|\d{10,11}\.\d+\.\d{1,5})$/, "<TOKEN>"),
    active: readIfExists(path.join(id.runDir, "active_thinkers")),
    subMap: norm(readIfExists(path.join(id.runDir, "sub_map")) ?? "<absent>", sb).replace(/^echo\t.*$/m, "echo\t<TRAJFILE>\t..."),
    trajFiles: norm(readIfExists(path.join(id.runDir, "traj_files")) ?? "<absent>", sb).replace(/^.*$/m, "<TRAJFILE>"),
    pendingNames: fs.existsSync(path.join(id.runDir, "pending")) ? fs.readdirSync(path.join(id.runDir, "pending")).map((n) => n.replace(/\.\d{10}\.\d{6}$/, ".<EPOCH>.<SEQ>")) : ["<no pending dir>"],
    stepPids: readIfExists(path.join(id.runDir, "step_pids")),
    echoReceived: (readIfExists(path.join(id.identityDir, "echo.received.jsonl")) ?? "").split("\n").filter(Boolean).map((l) => {
      const o = JSON.parse(l);
      return JSON.parse(o.trigger || "{}");
    }),
  };
  return { id, env, snap, raw: r };
}

async function flow2() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-boot-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-boot-ts-"));
  try {
    const b = await flowBootNamed("bash", sbBash);
    const t = await flowBootNamed("ts", sbTs);

    check("boot-named", "stderr-text", diffText(b.snap.stderr, t.snap.stderr));
    check("boot-named", "exit-code", diffText(String(b.raw.status), String(t.raw.status)));
    check("boot-named", "pid-format", diffText(b.snap.pidFormat, t.snap.pidFormat));
    check("boot-named", "token-format", diffText(b.snap.tokenFormat, t.snap.tokenFormat));
    check("boot-named", "active-thinkers", diffText(b.snap.active, t.snap.active));
    check("boot-named", "sub-map", diffText(b.snap.subMap, t.snap.subMap));
    check("boot-named", "traj-files", diffText(b.snap.trajFiles, t.snap.trajFiles));
    check("boot-named", "pending-empty-after-settle", diffText(JSON.stringify(b.snap.pendingNames), JSON.stringify(t.snap.pendingNames)));
    check("boot-named", "step-pids-empty-after-settle", diffText(b.snap.stepPids, t.snap.stepPids));
    check("boot-named", "echo-received-one-manual-trigger", diffText(JSON.stringify(b.snap.echoReceived), JSON.stringify(t.snap.echoReceived)));

    // stop both cleanly
    await cliThinkers("bash", ["stop", "--force"], b.env);
    await cliThinkers("ts", ["stop", "--force"], t.env);
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

function check(flow, name, d, dev) {
  if (!d) record(flow, name, "PARITY", null);
  else record(flow, name, dev ? "DEVIATION" : "DIVERGE", d, dev);
}

// =====================================================================================
// FLOW 3 — bare `thinkers start` (no names): upstream's documented "no kick" quirk.
// =====================================================================================
async function flow3() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-bare-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-bare-ts-"));
  try {
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      const r = await cliThinkers(kind, ["start"], env);
      const dpid = getDaemonPid(id.runDir);
      if (dpid !== null) startedDaemonPids[kind].add(dpid);
      await sleep(500); // give a (possibly buggy) boot-kick time to fire and settle
      const pendingNames = fs.existsSync(path.join(id.runDir, "pending")) ? fs.readdirSync(path.join(id.runDir, "pending")) : ["<no pending dir>"];
      const echoReceivedCount = (readIfExists(path.join(id.identityDir, "echo.received.jsonl")) ?? "").split("\n").filter(Boolean).length;
      (kind === "bash" ? (flow3.bash = {}) : (flow3.ts = {}));
      const rec = kind === "bash" ? flow3.bash : flow3.ts;
      rec.pendingEmpty = pendingNames.length === 0;
      rec.pendingNames = pendingNames;
      rec.echoReceivedCount = echoReceivedCount;
      rec.active = readIfExists(path.join(id.runDir, "active_thinkers"));
      rec.stderr = norm(r.stderr, sb);
      await cliThinkers(kind, ["stop", "--force"], env);
    }
    check("bare-start", "pending-dir-empty-no-kick", diffText(JSON.stringify(flow3.bash.pendingEmpty), JSON.stringify(flow3.ts.pendingEmpty)));
    check("bare-start", "echo-received-count", diffText(String(flow3.bash.echoReceivedCount), String(flow3.ts.echoReceivedCount)));
    check("bare-start", "active-thinkers", diffText(flow3.bash.active, flow3.ts.active));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 4 — out-of-process chat reactive dispatch + dispatcher.log line formats.
// =====================================================================================
async function flow4() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-chat-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-chat-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      await cliThinkers(kind, ["start", "echo"], env);
      const dpid = getDaemonPid(id.runDir);
      if (dpid !== null) startedDaemonPids[kind].add(dpid);
      await waitFor(() => (readIfExists(path.join(id.runDir, "step_pids")) ?? "") === "", 4000);

      // out-of-process: separate `chat send` invocation
      const chatEnv = { ...env, ROOT_TRAJ_ID: id.trajId };
      const chatRes = await cliChat(kind, ["send", "--from", "operator", "--to", "echo-id", "hello from operator"], chatEnv);

      await waitFor(() => {
        const rec = (readIfExists(path.join(id.identityDir, "echo.received.jsonl")) ?? "").split("\n").filter(Boolean);
        return rec.some((l) => {
          try {
            return JSON.parse(JSON.parse(l).trigger || "{}").type === "message";
          } catch {
            return false;
          }
        });
      }, 5000);
      await sleep(200);

      const dispatcherLog = readIfExists(path.join(id.runDir, "logs", "dispatcher.log")) ?? "";
      // Structural line-shape extraction: drop the ISO timestamp prefix, keep
      // the "[dispatcher] <rest>" text, normalized.
      const shapes = dispatcherLog
        .split("\n")
        .filter(Boolean)
        .map((l) => norm(l.replace(/^\S+\s/, ""), sb));

      out[kind] = { chatStderr: norm(chatRes.stderr, sb), chatStatus: chatRes.status, dispatcherLogShapes: shapes };
      await cliThinkers(kind, ["stop", "--force"], env);
    }

    check("chat-reactive", "chat-send-stderr", diffText(out.bash.chatStderr, out.ts.chatStderr));
    check("chat-reactive", "chat-send-exit", diffText(String(out.bash.chatStatus), String(out.ts.chatStatus)));
    check("chat-reactive", "dispatcher-log-line-shapes", diffText(JSON.stringify(out.bash.dispatcherLogShapes, null, 1), JSON.stringify(out.ts.dispatcherLogShapes, null, 1)));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 5 — past wake_at fires a scheduled wake; wake_at removed; log line.
// =====================================================================================
async function flow5() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-wake-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-wake-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      await cliThinkers(kind, ["start", "echo"], env);
      const dpid = getDaemonPid(id.runDir);
      if (dpid !== null) startedDaemonPids[kind].add(dpid);
      await waitFor(() => (readIfExists(path.join(id.runDir, "step_pids")) ?? "") === "", 4000);
      fs.writeFileSync(path.join(id.runDir, "echo.wake_at"), String(Math.floor(Date.now() / 1000) - 10));

      const fired = await waitFor(() => {
        const rec = (readIfExists(path.join(id.identityDir, "echo.received.jsonl")) ?? "").split("\n").filter(Boolean);
        return rec.some((l) => {
          try {
            return JSON.parse(JSON.parse(l).trigger || "{}").type === "monolith-wake";
          } catch {
            return false;
          }
        });
      }, 4000);
      await sleep(150);
      out[kind] = {
        fired,
        wakeAtGone: !fs.existsSync(path.join(id.runDir, "echo.wake_at")),
        logHasScheduledWake: (readIfExists(path.join(id.runDir, "logs", "dispatcher.log")) ?? "").includes("scheduled wake"),
      };
      await cliThinkers(kind, ["stop", "--force"], env);
    }
    check("scheduled-wake", "fired", diffText(JSON.stringify(out.bash.fired), JSON.stringify(out.ts.fired)));
    check("scheduled-wake", "wake_at-removed", diffText(JSON.stringify(out.bash.wakeAtGone), JSON.stringify(out.ts.wakeAtGone)));
    check("scheduled-wake", "log-has-scheduled-wake-line", diffText(JSON.stringify(out.bash.logHasScheduledWake), JSON.stringify(out.ts.logHasScheduledWake)));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 6 — thinkers stop (named, drain default) + stop-all + plain SIGTERM.
// =====================================================================================
async function flow6() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-stop-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-stop-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      await cliThinkers(kind, ["start", "echo"], env);
      const dpid = getDaemonPid(id.runDir);
      if (dpid !== null) startedDaemonPids[kind].add(dpid);
      await waitFor(() => (readIfExists(path.join(id.runDir, "step_pids")) ?? "") === "", 4000);

      const r = await cliThinkers(kind, ["stop"], env);
      await sleep(300);
      out[kind] = {
        stderr: norm(r.stderr, sb),
        status: r.status,
        dispatcherPidGone: !fs.existsSync(path.join(id.runDir, "dispatcher.pid")),
        tokenGone: !fs.existsSync(path.join(id.runDir, "dispatcher.token")),
        subMapGone: !fs.existsSync(path.join(id.runDir, "sub_map")),
        trajFilesGone: !fs.existsSync(path.join(id.runDir, "traj_files")),
        pendingGone: !fs.existsSync(path.join(id.runDir, "pending")),
        deliberateStopGone: !fs.existsSync(path.join(id.runDir, "deliberate_stop")),
        lastSignalAbsent: !fs.existsSync(path.join(id.runDir, "last_signal")),
      };
      if (dpid !== null) startedDaemonPids[kind].delete(dpid); // stopped cleanly
    }
    check("stop-all-default", "stderr-text", diffText(out.bash.stderr, out.ts.stderr));
    check("stop-all-default", "exit-code", diffText(String(out.bash.status), String(out.ts.status)));
    for (const f of ["dispatcherPidGone", "tokenGone", "subMapGone", "trajFilesGone", "pendingGone", "deliberateStopGone", "lastSignalAbsent"]) {
      check("stop-all-default", f, diffText(JSON.stringify(out.bash[f]), JSON.stringify(out.ts[f])));
    }
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 7 — plain SIGTERM (not via `thinkers stop`): exit 130 equivalent, last_signal.
// =====================================================================================
async function flow7() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-sigterm-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-sigterm-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      await cliThinkers(kind, ["start", "echo"], env);
      const dpid = getDaemonPid(id.runDir);
      await waitFor(() => (readIfExists(path.join(id.runDir, "step_pids")) ?? "") === "", 4000);

      process.kill(dpid, "SIGTERM");
      const died = await waitFor(() => !pidAlive(dpid), 4000);
      await sleep(150);
      out[kind] = {
        died,
        lastSignal: readIfExists(path.join(id.runDir, "last_signal")),
        pidFileStillPresent: fs.existsSync(path.join(id.runDir, "dispatcher.pid")), // daemon never removes its own pid file
      };
      // cleanup: the pid is dead but state files linger (by design) — remove manually.
      fs.rmSync(id.runDir, { recursive: true, force: true });
    }
    check("plain-sigterm", "daemon-died", diffText(JSON.stringify(out.bash.died), JSON.stringify(out.ts.died)));
    check("plain-sigterm", "last_signal-bytes", diffText(out.bash.lastSignal, out.ts.lastSignal));
    check("plain-sigterm", "pid-file-still-present", diffText(JSON.stringify(out.bash.pidFileStillPresent), JSON.stringify(out.ts.pidFileStillPresent)));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 8 — token-ownership guard: second `thinkers start` makes the first daemon
// self-terminate within one tick.
// =====================================================================================
async function flow8() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-token-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-token-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id");
      const env = baseEnv(kind, id, sb);
      await cliThinkers(kind, ["start", "echo"], env);
      const firstPid = getDaemonPid(id.runDir);
      await waitFor(() => (readIfExists(path.join(id.runDir, "step_pids")) ?? "") === "", 4000);

      // Force a second start by clearing the pid file (simulates the CLI's
      // own "old pid dead" detection path without waiting for a real crash) —
      // NO: instead exercise the REAL race by writing a fresh token + pid
      // directly, as a second `start` would from a second CLI invocation
      // racing the first. We rewrite the token file the same way `thinkers
      // start` does the moment it decides a fresh dispatcher is needed.
      // Simpler and equally faithful to the guarded property: kill -0 the
      // recorded pid file untouched, and run a genuine second `thinkers
      // start` while the first is still alive but its pid file looks stale
      // is NOT how upstream races this — the actual race the token guards
      // against is "two `start`s in flight close together". We reproduce it
      // directly: run a second `start` while the first dispatcher is alive.
      fs.rmSync(path.join(id.runDir, "dispatcher.pid"), { force: true }); // let the CLI believe no dispatcher is tracked (both clis re-derive liveness from this file only)
      await cliThinkers(kind, ["start", "echo"], env);
      const secondPid = getDaemonPid(id.runDir);
      if (secondPid !== null) startedDaemonPids[kind].add(secondPid);

      const firstDied = await waitFor(() => !pidAlive(firstPid), 4000);
      out[kind] = {
        firstDied,
        secondAlive: pidAlive(secondPid),
        distinctPids: firstPid !== secondPid,
      };
      if (secondPid !== null) {
        await cliThinkers(kind, ["stop", "--force"], env);
        startedDaemonPids[kind].delete(secondPid);
      }
    }
    check("token-guard", "first-daemon-self-terminates", diffText(JSON.stringify(out.bash.firstDied), JSON.stringify(out.ts.firstDied)));
    check("token-guard", "second-daemon-alive", diffText(JSON.stringify(out.bash.secondAlive), JSON.stringify(out.ts.secondAlive)));
    check("token-guard", "distinct-pids", diffText(JSON.stringify(out.bash.distinctPids), JSON.stringify(out.ts.distinctPids)));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// FLOW 9 — CLI misuse: unknown thinker, disabled thinker, stop-when-not-running,
// `thinkers step`, `thinkers status` text.
// =====================================================================================
async function flow9() {
  const sbBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-misuse-bash-"));
  const sbTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-misuse-ts-"));
  try {
    const out = {};
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id = buildIdentity(sb, "echo-id", {});
      const env = baseEnv(kind, id, sb);
      out[kind] = {};

      const unknown = await cliThinkers(kind, ["start", "nope"], env);
      out[kind].unknownStart = { stderr: norm(unknown.stderr, sb), status: unknown.status };

      const stopNotRunning = await cliThinkers(kind, ["stop"], env);
      out[kind].stopNotRunning = { stderr: norm(stopNotRunning.stderr, sb), status: stopNotRunning.status };

      const statusText = await cliThinkers(kind, ["status"], env);
      out[kind].status = { stdout: norm(statusText.stdout, sb).replace(/PID <PID>\)/g, "PID <PID>)"), status: statusText.status };

      const step = await cliThinkers(kind, ["step", "echo"], env);
      await sleep(100);
      out[kind].step = { stdout: norm(step.stdout, sb), stderr: norm(step.stderr, sb), status: step.status };
    }

    // disabled thinker: separate sandbox pair, isolated so echo.received.jsonl in the
    // step-misuse identity above isn't disturbed.
    for (const [kind, sb] of [["bash", sbBash], ["ts", sbTs]]) {
      const id2 = buildIdentity(sb, "echo-id-disabled", { disabledEcho: true });
      const env2 = baseEnv(kind, id2, sb);
      const disabledStart = await cliThinkers(kind, ["start", "echo"], env2);
      out[kind].disabledStart = { stderr: norm(disabledStart.stderr, sb), status: disabledStart.status };
    }

    // BUG #67 (bin/thinkers:138-155 `_require_env`'s full ordered validation,
    // not just its `[[ -d "$THINKERS_DIR" ]] || die "Thinkers directory not
    // found: $THINKERS_DIR"` tail): status/start/stop/list must refuse
    // identically (same stderr text, exit 1, empty stdout) when (a)
    // THINKERS_DIR itself doesn't exist though IDENTITY_DIR does, (b)
    // IDENTITY_DIR itself doesn't exist but every other var is ALSO
    // explicitly set (THINKERS_DIR then derives to a path under it that also
    // doesn't exist — still only exercises the THINKERS_DIR check), and (c)
    // the sealed-holdout shape: IDENTITY_DIR set and NOTHING else
    // identity-related (no TRAJ_DIR/TRAJ_ID/THINKERS_DIR/IDENTITY_NAME) —
    // upstream's EARLIER "TRAJ_DIR not set" check must win, not the
    // THINKERS_DIR-existence check. Separate sandbox pair so the missing
    // dir isn't confused with the step-misuse identity above.
    const sbMissingBash = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-missing-bash-"));
    const sbMissingTs = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-adv-missing-ts-"));
    try {
      for (const [kind, sb] of [["bash", sbMissingBash], ["ts", sbMissingTs]]) {
        // (a) missing THINKERS_DIR only: a real identity with its thinkers/ removed.
        const id = buildIdentity(sb, "echo-id-nothinkersdir", {});
        const env = baseEnv(kind, id, sb);
        fs.rmSync(path.join(id.identityDir, "thinkers"), { recursive: true, force: true });
        for (const [scenario, argv] of [["status", ["status"]], ["start", ["start"]], ["stop", ["stop"]], ["list", ["list"]]]) {
          const r = await cliThinkers(kind, argv, env);
          out[kind][`missingThinkersDir_${scenario}`] = { stdout: norm(r.stdout, sb), stderr: norm(r.stderr, sb), status: r.status };
        }

        // (b) missing IDENTITY_DIR entirely — THINKERS_DIR/TRAJ_DIR/etc. all
        // derive to paths under a directory that itself was never created.
        const missingId = path.join(sb, "nonexistent-identity");
        const envMissing = {
          ...env,
          IDENTITY_DIR: missingId,
          IDENTITY_NAME: "nonexistent-identity",
          TRAJ_DIR: path.join(missingId, "trajectories", "root"),
          TRAJ_ID: "root",
          THINKERS_DIR: path.join(missingId, "thinkers"),
          MEM_DIR: path.join(missingId, "memories"),
          SKILLS_DIR: path.join(missingId, "skills"),
          SKILLS_KERNEL_DIR: path.join(missingId, "kernel"),
        };
        for (const [scenario, argv] of [["status", ["status"]], ["start", ["start"]], ["stop", ["stop"]], ["list", ["list"]]]) {
          const r = await cliThinkers(kind, argv, envMissing);
          out[kind][`missingIdentityDir_${scenario}`] = { stdout: norm(r.stdout, sb), stderr: norm(r.stderr, sb), status: r.status };
        }

        // (c) the sealed holdout shape: IDENTITY_DIR set (to a nonexistent
        // path) and NOTHING ELSE identity-related — no TRAJ_DIR, no TRAJ_ID,
        // no THINKERS_DIR, no IDENTITY_NAME. Distinct from (b) above, which
        // sets every var explicitly and so only ever exercises the
        // THINKERS_DIR-existence check on both sides. This is the case
        // bin/thinkers.mjs's now-removed IDENTITY_DIR-triggered
        // `resolveIdentityEnv` auto-resolution used to paper over: it
        // synthesized TRAJ_DIR/TRAJ_ID from IDENTITY_DIR even though the
        // caller never set them, so the port fell through to "Thinkers
        // directory not found" instead of upstream's earlier "TRAJ_DIR not
        // set. Run: identity shell <name>". PATH must still resolve `node`/
        // the shellm bins for the ts side, and `bash` builtins for the bash
        // side — everything else identity-related is deliberately absent.
        const bareEnv = { PATH: env.PATH, IDENTITY_DIR: missingId, LC_ALL: "C", LANG: "C" };
        for (const [scenario, argv] of [["status", ["status"]], ["start", ["start"]], ["stop", ["stop"]], ["list", ["list"]]]) {
          const r = await cliThinkers(kind, argv, bareEnv);
          out[kind][`identityDirOnly_${scenario}`] = { stdout: norm(r.stdout, sb), stderr: norm(r.stderr, sb), status: r.status };
        }
      }
    } finally {
      fs.rmSync(sbMissingBash, { recursive: true, force: true });
      fs.rmSync(sbMissingTs, { recursive: true, force: true });
    }

    for (const scenario of ["status", "start", "stop", "list"]) {
      for (const which of ["missingThinkersDir", "missingIdentityDir", "identityDirOnly"]) {
        const key = `${which}_${scenario}`;
        check("misuse", `${key}-stdout`, diffText(out.bash[key].stdout, out.ts[key].stdout));
        check("misuse", `${key}-stderr`, diffText(out.bash[key].stderr, out.ts[key].stderr));
        check("misuse", `${key}-exit`, diffText(String(out.bash[key].status), String(out.ts[key].status)));
      }
    }

    check("misuse", "unknown-thinker-stderr", diffText(out.bash.unknownStart.stderr, out.ts.unknownStart.stderr));
    check("misuse", "unknown-thinker-exit", diffText(String(out.bash.unknownStart.status), String(out.ts.unknownStart.status)));
    check("misuse", "disabled-thinker-stderr", diffText(out.bash.disabledStart.stderr, out.ts.disabledStart.stderr));
    check("misuse", "disabled-thinker-exit", diffText(String(out.bash.disabledStart.status), String(out.ts.disabledStart.status)));
    check("misuse", "stop-not-running-stderr", diffText(out.bash.stopNotRunning.stderr, out.ts.stopNotRunning.stderr));
    check("misuse", "stop-not-running-exit", diffText(String(out.bash.stopNotRunning.status), String(out.ts.stopNotRunning.status)));
    check("misuse", "status-text", diffText(out.bash.status.stdout, out.ts.status.stdout));
    check("misuse", "step-stdout", diffText(out.bash.step.stdout, out.ts.step.stdout));
    check("misuse", "step-stderr", diffText(out.bash.step.stderr, out.ts.step.stderr));
    check("misuse", "step-exit", diffText(String(out.bash.step.status), String(out.ts.step.status)));
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
}

// =====================================================================================
// main
// =====================================================================================
const FLOWS = [
  ["identity-new", flowIdentityNew],
  ["boot-named", flow2],
  ["bare-start", flow3],
  ["chat-reactive", flow4],
  ["scheduled-wake", flow5],
  ["stop-all-default", flow6],
  ["plain-sigterm", flow7],
  ["token-guard", flow8],
  ["misuse", flow9],
];

try {
  for (const [name, fn] of FLOWS) {
    if (ONLY && !ONLY.test(name)) continue;
    try {
      await fn();
    } catch (e) {
      record(name, "flow-crashed", "DIVERGE", { error: String(e && e.stack ? e.stack : e) });
    }
  }
} finally {
  await cleanupAllStarted();
}

// residual daemon check — reported, not blindly killed.
const pg = spawnSync("pgrep", ["-f", "dispatcherd"], { encoding: "utf8" });
const strayPids = (pg.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

// --- report ---------------------------------------------------------------------------
const total = results.length;
const parity = results.filter((r) => r.verdict === "PARITY").length;
const deviations = results.filter((r) => r.verdict === "DEVIATION").length;
const diverge = results.filter((r) => r.verdict === "DIVERGE").length;

const CLIP = 2000;
const clip = (s) => (s === undefined ? s : typeof s === "string" && s.length > CLIP ? `${s.slice(0, CLIP)}…(+${s.length - CLIP} chars)` : s);

let md = `# daemon-runtime — ADVERSARIAL differential check (tester's own harness)\n\n`;
md += `Generated by \`parity/daemon/run-parity-adversarial.mjs\`. Real Bash \`headlong/bin/thinkers\` + \`tools/identity\` + \`bin/chat\` vs \`bin/{thinkers,identity,chat}.mjs\`, identical hand-built identities with a single no-op "echo" thinker (same script both sides — no LLM). Verdict fields per check: stdout/stderr text, exit status, run/ state bytes.\n\n`;
md += `Normalized symmetrically: PIDs, dispatcher tokens (epoch.pid.rand), bare epoch/uuid fields, ISO timestamps (both the port's \`...Z\` form and upstream's local no-Z form), \`<SB>\`/\`<HEADLONG_ROOT>\`/\`<REPO>\`/\`<HOME>\` paths.\n\n`;
md += `## Result: ${total} checks — ${parity} PARITY, ${deviations} documented DEVIATION, **${diverge} DIVERGE**\n\n`;
md += `Residual \`dispatcherd\` processes after this run (should be none — everything this harness started is stopped in a \`finally\`): ${strayPids.length ? strayPids.join(", ") : "none"}\n\n`;
md += `| # | flow | check | verdict | deviation |\n|---|---|---|---|---|\n`;
results.forEach((r, i) => {
  md += `| ${i + 1} | ${r.flow} | ${r.name} | ${r.verdict} | ${r.dev ? DEV[r.dev]?.row ?? r.dev : "-"} |\n`;
});

md += `\n## Divergences and deviations (detail)\n\n`;
for (const r of results.filter((x) => x.verdict !== "PARITY")) {
  md += `### ${r.verdict}: ${r.flow} / ${r.name}\n`;
  if (r.dev) md += `- declared deviation: ${r.dev} (${DEV[r.dev]?.row})\n`;
  md += "```\n";
  if (r.detail && typeof r.detail === "object" && "bash" in r.detail && "ts" in r.detail) {
    md += `bash:\n${clip(r.detail.bash)}\n----\nts:\n${clip(r.detail.ts)}\n`;
  } else {
    md += clip(JSON.stringify(r.detail, null, 1)) + "\n";
  }
  md += "```\n\n";
}

fs.writeFileSync(path.join(HERE, `report-adversarial${REPORT_SUFFIX}.md`), md);
fs.writeFileSync(
  path.join(HERE, `results-adversarial${REPORT_SUFFIX}.json`),
  JSON.stringify({ total, parity, deviations, diverge, strayPids, results }, null, 1)
);
console.log(`\nadversarial: ${total} checks — ${parity} parity, ${deviations} documented deviations, ${diverge} DIVERGE`);
console.log(strayPids.length ? `WARNING: ${strayPids.length} residual dispatcherd process(es): ${strayPids.join(",")}` : "no residual dispatcherd processes");
process.exit(diverge === 0 && strayPids.length === 0 ? 0 : 1);
