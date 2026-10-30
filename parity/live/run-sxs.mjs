#!/usr/bin/env node
// parity/live/run-sxs.mjs — automates the manual live side-by-side run
// documented in SIDE-BY-SIDE.md: real upstream Bash Headlong vs. this TS
// port, same persona, same scripted messages, same real model, run
// concurrently, then diffed for STRUCTURAL (not prose) parity. This is the
// thing "port matches the original live" turns into: a repeatable command
// with an exit code, not a one-off manual session.
//
// PROOF-CAMPAIGN.md L3 (long live side-by-side) + L4 (chaos/recovery): a
// scenario script (JSON; see scenario.mjs) can carry more than scripted
// messages — bursts, thinkers stop/start, dispatcher SIGTERM/SIGKILL, an
// in-flight step SIGKILL, docker pause/unpause of the sandbox container,
// model-provider faults (429/500/truncated body/60s stall, via
// fault-proxy.mjs), a quiet (unprompted-outreach) window, and a mid-run
// second identity. Every event is applied to BOTH sides at the same
// wall-clock offset, using each side's OWN CLI. This script builds the
// harness; it never "fixes" a divergence it finds — see lib.mjs's
// chaos-recovery section header for why the comparison output is a table
// for a human to classify, not an automatic verdict.
//
// Zero Bash: every process this script spawns is invoked by its own path
// (relying on the kernel's #!/usr/bin/env bash shebang for the upstream
// side's own scripts — we never spawn a `bash` interpreter ourselves) or via
// `node <script>.mjs` directly. `cp`/`docker` are spawned as plain
// executables (not through a shell). The fault-injecting proxy runs as its
// OWN spawned process (spawnFaultProxy below), NOT in-process — this script
// drives every side command via spawnSync, which blocks its entire event
// loop until each one returns, so an in-process proxy would be unable to
// answer ANY request (including headlong-init's own key-check call) while
// spawnSync is waiting on it: a guaranteed deadlock, and exactly what the
// first three live-run attempts hit before this was fixed. See
// fault-proxy.mjs's header for the full account.
//
// All pure parsing/comparison/scheduling logic lives in parity/live/lib.mjs
// and parity/live/scenario.mjs (tested in test/live-*.test.ts against real
// and synthetic data). This file is the impure half: it only spawns
// processes, reads/writes files, and sleeps.
//
// Usage:
//   PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/live/run-sxs.mjs [--minutes N] [--script FILE] [--identity NAME] [--dry-run]
//
// Env:
//   PARITY_UPSTREAM_ROOT   required. A real upstream (Bash) Headlong checkout.
//   PARITY_LIVE_ROOT       optional. Scratch root for both copies + captured
//                           artifacts + report.md/results.json. MUST live
//                           under $HOME (Colima only shares $HOME into the
//                           VM — SPEC/README). Default: ~/.headlong-parity-live/<timestamp>.
//   An OpenRouter (or other documented provider) API key, already in the
//   process environment. NEVER read from argv or a file, and this script
//   never logs/writes any env var's VALUE anywhere (report.md/results.json
//   carry paths, counts, and step data only). model-fault events require
//   OPENROUTER_API_KEY specifically (the fault proxy only speaks OpenRouter).
//   DOCKER_CONTEXT, HEADLONG_UNSANDBOXED, SHELLM_MODEL, SHELLM_MAX_ITERATIONS,
//   MONOLITH_BACKOFF_HOLD, HEADLONG_IDENTITY_* — all pass through from the
//   parent environment if set; sane SIDE-BY-SIDE.md-matching defaults below.
//
// Exit codes: 0 = ran clean, no structural diffs. 2 = ran clean, structural
// diffs found (listed in report.md; chaos-recovery mismatches also count).
// 1 = a side failed to run (why is on stderr).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  buildSideSummary,
  structuralDiff,
  exitCodeForDiffs,
  renderReport,
  buildChaosSnapshot,
  compareChaosEvent,
} from "./lib.mjs";
import { compileTimeline, impliedMinimumMinutes } from "./scenario.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT_ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// orphan-detection tuning (Step 6) — see its comment below for why polling,
// not a single check right after `stop` returns, is required.
// ---------------------------------------------------------------------------
const THINKERS_DRAIN_TIMEOUT_SEC = Number(process.env.THINKERS_DRAIN_TIMEOUT || 180);
const DRAIN_POLL_INTERVAL_MS = 2000;
const DRAIN_GRACE_MS = 10_000;
const FORCE_POLL_TIMEOUT_MS = 20_000;

// Fixed settle delays after a chaos event, before capturing the "after"
// snapshot — generous enough for a dispatcher to die/boot or a container to
// change state, without the precision (or fragility) of a condition-specific
// poll. Chaos harness, not a latency benchmark.
const CHAOS_SETTLE_MS = {
  "thinkers-stop": 5000,
  "thinkers-start": 6000,
  "dispatcher-sigterm": 3000,
  "dispatcher-sigkill": 3000,
  "step-sigkill": 3000,
  "docker-pause": 2000,
  "docker-unpause": 2000,
};

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const opts = { minutes: 15, dryRun: false, scenarioFile: null, identity: "sxs", operator: "jo", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--script" || a === "--messages") opts.scenarioFile = argv[++i];
    else if (a === "--identity") opts.identity = argv[++i];
    else if (a === "--operator") opts.operator = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else {
      process.stderr.write(`run-sxs: unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP_TEXT = `Usage: PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/live/run-sxs.mjs [options]

  --minutes N          Run duration in minutes (default 15)
  --script FILE         JSON scenario file — an array of EVENTS (see
                        parity/live/scenario.mjs's header for the full
                        vocabulary: message, burst, thinkers-stop/start,
                        dispatcher-sigterm/sigkill, step-sigkill,
                        docker-pause/unpause, model-fault, quiet,
                        second-identity). A bare {atMinutes, from, text}
                        entry (no "type") is still a plain message —
                        backward compatible with the original A/B/C
                        protocol. Default: parity/live/scripts/default.json.
                        --messages is accepted as an alias.
  --identity NAME      Identity name to create on both sides (default: sxs)
  --operator NAME       Sender label used for scripted messages (default: jo)
  --dry-run            Prove setup on both sides (checkouts copied, identity
                        created, headlong-init --dry-run's sandbox gate
                        clean) without starting thinkers, sending messages,
                        or spending a cent. Finishes in well under a minute.

Env: PARITY_UPSTREAM_ROOT (required), PARITY_LIVE_ROOT (optional, default
~/.headlong-parity-live/<timestamp>), plus an LLM provider key already in
the process environment for a live (non---dry-run) run. A scenario with any
model-fault event additionally requires OPENROUTER_API_KEY specifically.
`;

// ---------------------------------------------------------------------------
// Default scenario (SIDE-BY-SIDE.md §a's persona, §a/§d's A/B/C protocol)
// ---------------------------------------------------------------------------

const DEFAULT_PERSONA_ENV = {
  HEADLONG_IDENTITY_VIBE: "steady, curious, plainspoken, a careful listener",
  HEADLONG_IDENTITY_FOCUS: "design systems, changelogs, and how design tooling documents its own history",
  HEADLONG_OPERATOR_NAME: "JO",
  HEADLONG_IDENTITY_USER: "JO runs a small design consultancy in the UK",
};

// Falls back to this inline copy if parity/live/scripts/default.json is
// ever missing — the file is the source of truth (also usable directly via
// --script parity/live/scripts/default.json), this is just a safety net.
const DEFAULT_MESSAGES = [
  {
    atMinutes: 0,
    text:
      "Hi, I'm JO. Remember: my favourite colour is teal and I run a small design consultancy in the UK. " +
      "Then, on your own over the next while, research and write me a short note (5 bullets) on what makes " +
      "a good design-system changelog, and save it as a memory.",
  },
  { atMinutes: 3, text: "Quick check — what's my favourite colour?" },
  { atMinutes: 8, text: "Thanks. Anything you've done on your own since we last spoke?" },
];

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`run-sxs: ${msg}\n`);
  process.exit(1);
}

function timestampSlug(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
}

function readFileOrEmpty(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function sizeOrZero(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function readInfoField(identityDir, key) {
  const text = readFileOrEmpty(path.join(identityDir, "info.txt"));
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

/** `<trajDir>/<hex8>-root/trajectory.jsonl` — same convention on both sides (SPEC §2.1, src/trajCore.mjs's rootTrajFile). */
function rootTrajFile(trajDir, trajId) {
  const hex8 = String(trajId).slice(0, 8);
  return path.join(trajDir, `${hex8}-root`, "trajectory.jsonl");
}

async function sleepMs(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(targetMs) {
  await sleepMs(targetMs - Date.now());
}

/** `cp -R -c` (APFS clonefile) falling back to plain `cp -R`. Never spawns a shell. */
function copyTree(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`copyTree: source does not exist: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const clone = spawnSync("cp", ["-R", "-c", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
  if (clone.status !== 0) {
    const plain = spawnSync("cp", ["-R", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
    if (plain.status !== 0) {
      throw new Error(`copyTree: cp failed for ${src} -> ${dest}: ${plain.stderr?.toString() ?? clone.stderr?.toString() ?? ""}`);
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Everything in `procs` except pids in `excludePids` (e.g. the runner's own launcher). Pure — exported for unit testing. */
export function filterOrphans(procs, excludePids) {
  return procs.filter((p) => !excludePids.has(p.pid));
}

/**
 * Poll `listProcesses()` every `intervalMs` until it returns nothing (after
 * `filterOrphans`) or `deadlineMs` elapses. `listProcesses`, `now`, and
 * `sleep` are injectable so this can be unit-tested with a fake process
 * lister and a fake clock — no real processes, no real waiting. Exported for
 * that reason; run-sxs.mjs's own call sites pass real `ps`-backed listers.
 */
export async function pollUntilQuiet({ listProcesses, excludePids, deadlineMs, intervalMs = DRAIN_POLL_INTERVAL_MS, now = Date.now, sleep = sleepMs }) {
  const start = now();
  let remaining = filterOrphans(listProcesses(), excludePids);
  while (remaining.length > 0 && now() - start < deadlineMs) {
    await sleep(intervalMs);
    remaining = filterOrphans(listProcesses(), excludePids);
  }
  return { remaining, elapsedMs: now() - start };
}

// ---------------------------------------------------------------------------
// bash-side identity env (equivalent of `source .identities/<name>/activate`,
// without sourcing anything — see the file's own header for why this port
// never writes/sources an `activate` file; the upstream Bash side DOES ship
// one, but we replicate its exports directly rather than parsing+sourcing
// bash, matching this repo's own resolveIdentityEnv design for the port
// side).
// ---------------------------------------------------------------------------

function loadEnvFileOverride(envFile, into) {
  const text = readFileOrEmpty(envFile);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    into[m[1]] = val; // bash `source` always overrides, unlike fill-missing .env layering
  }
}

function buildBashIdentityEnv(identityDir, base) {
  const env = { ...base };
  const name = readInfoField(identityDir, "name") ?? path.basename(identityDir);
  const rootTraj = readInfoField(identityDir, "root_trajectory") ?? "trajectory.jsonl";
  env.IDENTITY_NAME = name;
  env.IDENTITY_DIR = identityDir;
  env.MEM_DIR = path.join(identityDir, "memories");
  env.SKILLS_DIR = path.join(identityDir, "skills");
  env.SKILLS_KERNEL_DIR = path.join(identityDir, "kernel");
  env.TRAJ_DIR = path.join(identityDir, "trajectories");
  env.TRAJ_ID = rootTraj;
  env.ROOT_TRAJ_ID = rootTraj;
  env.THINKERS_DIR = path.join(identityDir, "thinkers");
  env.SKILLSRC = path.join(identityDir, "skills", ".skillsrc");
  env.SHELLM_TRAJ_DIR = path.join(identityDir, "trajectories");
  env.SHELLM_ENVS_DIR = path.join(identityDir, ".shellm", "envs");
  env.SHELLM_WORKDIRS_DIR = path.join(identityDir, ".shellm", "workdirs");
  env.SHELLM_BROKER_DIR = path.join(identityDir, ".shellm", "docker-broker");
  env.SHELLM_CONF_DIR = path.join(identityDir, ".shellm");
  env.THINK_MODEL = env.SHELLM_MODEL || "claude-opus-4-7";
  env.THINK_TICK_INTERVAL = "0";
  env.THINK_CONTEXT_TAIL = env.THINK_CONTEXT_TAIL || "30";
  env.CHATRC = path.join(identityDir, "chat", ".chatrc");
  if (fs.existsSync(path.join(identityDir, ".env"))) loadEnvFileOverride(path.join(identityDir, ".env"), env);
  return env;
}

/** Dynamic-imports the SCRATCH COPY's own src/identity-env.ts (not this repo's) so PORT_BIN/PORT_HOME resolve to the copy being tested — exactly what `node <copy>/bin/thinkers.mjs` computes internally. */
async function buildPortIdentityEnv(portAppDir, identityDir, base, headlongHome) {
  const mod = await import(pathToFileURL(path.join(portAppDir, "src", "identity-env.ts")).href);
  return mod.resolveIdentityEnv(identityDir, { base, headlongHome });
}

// ---------------------------------------------------------------------------
// per-side process helpers
// ---------------------------------------------------------------------------

function runOrig(appDir, relBin, args, env, opts = {}) {
  return spawnSync(path.join(appDir, relBin), args, { cwd: appDir, env, encoding: "utf8", timeout: opts.timeout });
}

function runPort(appDir, relBin, args, env, opts = {}) {
  return spawnSync(process.execPath, [path.join(appDir, relBin), ...args], { cwd: appDir, env, encoding: "utf8", timeout: opts.timeout });
}

function headlongInit(side, appDir, env, extraArgs) {
  return side === "orig" ? runOrig(appDir, "tools/headlong-init", extraArgs, env) : runPort(appDir, "bin/headlong-init.mjs", extraArgs, env);
}

function identityNewCli(side, appDir, env, name) {
  return side === "orig" ? runOrig(appDir, "tools/identity", ["new", "--default", name], env) : runPort(appDir, "bin/identity.mjs", ["new", "--default", name], env);
}

function thinkersStart(side, appDir, env) {
  return side === "orig" ? runOrig(appDir, "bin/thinkers", ["start"], env, { timeout: 30_000 }) : runPort(appDir, "bin/thinkers.mjs", ["start"], env, { timeout: 30_000 });
}

function thinkersStop(side, appDir, env, force) {
  const args = force ? ["stop", "--force"] : ["stop"];
  return side === "orig" ? runOrig(appDir, "bin/thinkers", args, env, { timeout: 200_000 }) : runPort(appDir, "bin/thinkers.mjs", args, env, { timeout: 200_000 });
}

function chatSend(side, appDir, env, from, to, text) {
  return side === "orig" ? runOrig(appDir, "bin/chat", ["send", "--from", from, "--to", to, text], env) : runPort(appDir, "bin/chat.mjs", ["send", "--from", from, "--to", to, text], env);
}

function chatHistory(side, appDir, env, withName) {
  return side === "orig" ? runOrig(appDir, "bin/chat", ["history", "--with", withName, "--json"], env) : runPort(appDir, "bin/chat.mjs", ["history", "--with", withName, "--json"], env);
}

// ---------------------------------------------------------------------------
// process / container discovery
// ---------------------------------------------------------------------------

function listProcessesUnder(rootPath) {
  const r = spawnSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && l.includes(rootPath))
    .map((l) => {
      const m = /^(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    })
    .filter(Boolean);
}

function listShellmContainers(env) {
  const r = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}"], { encoding: "utf8", env });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l)
    .map((l) => l.split("\t"))
    .filter(([, name]) => (name ?? "").startsWith("shellm-"))
    .map(([id, name]) => ({ id, name }));
}

function dockerInspect(id, format, env) {
  const r = spawnSync("docker", ["inspect", "--format", format, id], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** A container "belongs" to `identityDir` when one of its bind mounts sources it (bin/shellm always mounts `-v "$IDENTITY_DIR:$IDENTITY_DIR"`; src/sandbox-runtime.ts's port mirrors this) — robust even if the container's owning `bin/shellm` process has already exited (the container itself can outlive it). */
function containerBelongsToIdentity(id, identityDir, env) {
  const mounts = dockerInspect(id, "{{range .Mounts}}{{.Source}}\n{{end}}", env);
  return mounts.split("\n").some((m) => m.trim() === identityDir);
}

function containerState(id, env) {
  const s = dockerInspect(id, "{{.State.Status}}", env);
  return s || "unknown";
}

/** Every `shellm-*` container bind-mounting this identity's dir, with live state (`running`/`paused`/`exited`/...). Best-effort — Docker unreachable just means "none". */
function containersForIdentity(identityDir, env) {
  let all = [];
  try {
    all = listShellmContainers(env);
  } catch {
    return [];
  }
  return all.filter((c) => containerBelongsToIdentity(c.id, identityDir, env)).map((c) => ({ ...c, state: containerState(c.id, env) }));
}

function dockerPauseAll(containers, env) {
  for (const c of containers) spawnSync("docker", ["pause", c.id], { encoding: "utf8", env });
}

function dockerUnpauseAll(containers, env) {
  for (const c of containers) spawnSync("docker", ["unpause", c.id], { encoding: "utf8", env });
}

// ---------------------------------------------------------------------------
// fault-proxy control client — spawns parity/live/fault-proxy.mjs as its OWN
// process (never in-process; see that file's header for why: this script
// drives every side command via spawnSync, which blocks its entire event
// loop, so an in-process proxy would deadlock on the very first request —
// exactly what happened on the first three live-run attempts). Talks to it
// over the local-only /__control__/* HTTP routes.
// ---------------------------------------------------------------------------

/** Spawns fault-proxy.mjs, waits for its `FAULT_PROXY_PORT <n>` announcement, and returns a control client. Rejects if the child exits before announcing a port. */
function spawnFaultProxy(log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "fault-proxy.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!settled) {
          const m = /^FAULT_PROXY_PORT (\d+)$/.exec(line);
          if (m) {
            settled = true;
            const port = Number(m[1]);
            resolve({
              url: () => `http://127.0.0.1:${port}/api/v1/chat/completions`,
              async queueFault(faultType, count) {
                const res = await fetch(`http://127.0.0.1:${port}/__control__/fault`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ faultType, count }),
                });
                if (!res.ok) log(`fault-proxy: queueFault(${faultType}, ${count}) failed: HTTP ${res.status}`);
              },
              async getStats() {
                try {
                  const res = await fetch(`http://127.0.0.1:${port}/__control__/stats`);
                  return await res.json();
                } catch (err) {
                  log(`fault-proxy: getStats failed: ${err instanceof Error ? err.message : String(err)}`);
                  return { requestCount: 0, events: [], queueDepth: 0 };
                }
              },
              async close() {
                child.kill("SIGTERM");
                await new Promise((r) => child.once("exit", r));
              },
            });
            continue;
          }
        }
        log(`fault-proxy: ${line}`);
      }
    });
    child.stderr.on("data", (chunk) => log(`fault-proxy: ${chunk.toString("utf8").trimEnd()}`));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!settled) reject(new Error(`fault-proxy.mjs exited (code ${code}) before announcing its port`));
    });
  });
}

/** The thinkers dispatcher pid recorded at `run/dispatcher.pid` (bin/thinkers._start_dispatcher / runstate.ts writeDispatcherPid), or null. */
function dispatcherPid(identityDir) {
  const t = readFileOrEmpty(path.join(identityDir, "run", "dispatcher.pid")).trim();
  return t ? Number(t) : null;
}

/** The currently in-flight `thinkers/<name>/step` child process under `appDir`, if any (bin/thinkers's step script / src/daemon.ts's spawnStep — same "<thinkers_dir>/<name>/step" convention on both sides). */
function findStepProcess(appDir) {
  return listProcessesUnder(appDir)
    .filter((p) => isAlive(p.pid))
    .find((p) => /\/thinkers\/[^/]+\/step(\s|$)/.test(p.command)) ?? null;
}

// ---------------------------------------------------------------------------
// chaos-event raw-state capture (feeds lib.mjs's buildChaosSnapshot)
// ---------------------------------------------------------------------------

function readPendingNames(identityDir) {
  try {
    return fs.readdirSync(path.join(identityDir, "run", "pending"));
  } catch {
    return [];
  }
}

function readTrajectoryTail(identityDir, n = 6) {
  const rootId = readInfoField(identityDir, "root_trajectory");
  if (!rootId) return "";
  const trajFile = rootTrajFile(path.join(identityDir, "trajectories"), rootId);
  const lines = readFileOrEmpty(trajFile).split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

function captureChaosRaw(identityDir, env) {
  const pid = dispatcherPid(identityDir);
  return {
    dispatcherPidText: pid ? String(pid) : "",
    dispatcherAlive: pid !== null && isAlive(pid),
    lastSignalText: readFileOrEmpty(path.join(identityDir, "run", "last_signal")),
    stepPidsText: readFileOrEmpty(path.join(identityDir, "run", "step_pids")),
    pendingNames: readPendingNames(identityDir),
    containers: containersForIdentity(identityDir, env),
    trajectoryTailText: readTrajectoryTail(identityDir),
  };
}

async function captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv) {
  return {
    orig: buildChaosSnapshot(captureChaosRaw(identityDirOrig, origEnv)),
    port: buildChaosSnapshot(captureChaosRaw(identityDirPort, portEnv)),
  };
}

// ---------------------------------------------------------------------------
// artifact capture
// ---------------------------------------------------------------------------

function captureSide(identityDir, identityName) {
  const rootId = readInfoField(identityDir, "root_trajectory");
  let trajectoryText = "";
  let messagesIndexText;
  if (rootId) {
    const trajFile = rootTrajFile(path.join(identityDir, "trajectories"), rootId);
    trajectoryText = readFileOrEmpty(trajFile);
    const messagesFile = path.join(path.dirname(trajFile), "messages.jsonl");
    if (fs.existsSync(messagesFile)) messagesIndexText = readFileOrEmpty(messagesFile);
  }
  const logsDir = path.join(identityDir, "run", "logs");
  const memoriesDir = path.join(identityDir, "memories");
  return {
    trajectoryText,
    dispatcherLogText: readFileOrEmpty(path.join(logsDir, "dispatcher.log")),
    messagesIndexText,
    perThinkerLogBytes: {
      "monolith.log": sizeOrZero(path.join(logsDir, "monolith.log")),
      "responder.log": sizeOrZero(path.join(logsDir, "responder.log")),
      "responder-notes.log": sizeOrZero(path.join(logsDir, "responder-notes.log")),
    },
    memoryFiles: fs.existsSync(memoriesDir) ? fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".md")).sort() : [],
    identityName,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) die("--minutes must be a positive number");

  const upstreamRoot = process.env.PARITY_UPSTREAM_ROOT;
  if (!upstreamRoot) die("PARITY_UPSTREAM_ROOT is not set — point it at a real upstream (Bash) Headlong checkout");
  for (const rel of ["tools/headlong-init", "tools/identity", "bin/thinkers", "bin/chat"]) {
    if (!fs.existsSync(path.join(upstreamRoot, rel))) die(`PARITY_UPSTREAM_ROOT does not look like a Headlong checkout — missing ${rel}`);
  }

  const model = process.env.SHELLM_MODEL || "deepseek/deepseek-v4-flash-0731";
  const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"];
  const hasKey = KEY_VARS.some((v) => Boolean(process.env[v]));
  if (!opts.dryRun && !hasKey) {
    die(`no LLM key found in the environment (checked ${KEY_VARS.join(", ")}) — a live run needs one. Use --dry-run to prove setup without a model call.`);
  }

  const defaultScenarioFile = path.join(HERE, "scripts", "default.json");
  let scenarioRaw = fs.existsSync(defaultScenarioFile) ? JSON.parse(fs.readFileSync(defaultScenarioFile, "utf8")) : DEFAULT_MESSAGES;
  if (opts.scenarioFile) {
    scenarioRaw = JSON.parse(fs.readFileSync(opts.scenarioFile, "utf8"));
  }
  const timeline = compileTimeline(scenarioRaw);
  const impliedMinutes = impliedMinimumMinutes(timeline);
  if (!opts.dryRun && impliedMinutes > opts.minutes) {
    process.stderr.write(`run-sxs: warning: scenario schedules events up to T+${impliedMinutes}min but --minutes is ${opts.minutes} — later events will never fire.\n`);
  }
  const hasModelFault = timeline.some((e) => e.type === "model-fault");
  if (hasModelFault && !opts.dryRun && !process.env.OPENROUTER_API_KEY) {
    die("scenario includes model-fault event(s) but OPENROUTER_API_KEY is not set — fault-proxy.mjs only speaks OpenRouter");
  }

  const scratchRoot = process.env.PARITY_LIVE_ROOT || path.join(os.homedir(), ".headlong-parity-live", timestampSlug());
  if (!scratchRoot.startsWith(os.homedir())) {
    process.stderr.write(`run-sxs: warning: PARITY_LIVE_ROOT (${scratchRoot}) is not under $HOME — Colima only shares $HOME into its VM — the Docker sandbox may not see this root.\n`);
  }
  fs.mkdirSync(scratchRoot, { recursive: true });
  process.stdout.write(`run-sxs: scratch root: ${scratchRoot}\n`);

  const origAppDir = path.join(scratchRoot, "orig", "app");
  const portAppDir = path.join(scratchRoot, "port", "app");
  const origHome = path.join(scratchRoot, "orig", "home");
  const portHome = path.join(scratchRoot, "port", "home");

  process.stdout.write("run-sxs: copying checkouts (cp -R -c)...\n");
  copyTree(upstreamRoot, origAppDir);
  copyTree(PORT_ROOT, portAppDir);

  const personaEnv = {
    HEADLONG_IDENTITY_NAME: opts.identity,
    HEADLONG_IDENTITY_VIBE: process.env.HEADLONG_IDENTITY_VIBE || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_VIBE,
    HEADLONG_IDENTITY_FOCUS: process.env.HEADLONG_IDENTITY_FOCUS || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_FOCUS,
    HEADLONG_OPERATOR_NAME: process.env.HEADLONG_OPERATOR_NAME || DEFAULT_PERSONA_ENV.HEADLONG_OPERATOR_NAME,
    HEADLONG_IDENTITY_USER: process.env.HEADLONG_IDENTITY_USER || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_USER,
  };

  // -----------------------------------------------------------------------
  // Fault-injecting proxy — its OWN process (see fault-proxy.mjs's header:
  // in-process would deadlock against this script's spawnSync-based side
  // commands). Started before either side so modelEnv.LLM_API_URL is set
  // from the first `headlong-init`/thinkers-start call onward — see
  // fault-proxy.mjs's header for the OpenRouter LLM_API_URL-override
  // mechanism this relies on (bin/llm's `openrouter` branch, mirrored
  // exactly by src/llmCli.ts).
  // -----------------------------------------------------------------------
  let faultProxy = null;
  if (!opts.dryRun && process.env.OPENROUTER_API_KEY) {
    faultProxy = await spawnFaultProxy((l) => process.stdout.write(`run-sxs: ${l}\n`));
    process.stdout.write(`run-sxs: fault-proxy listening at ${faultProxy.url()}\n`);
  }

  const modelEnv = {
    SHELLM_MODEL: model,
    SHELLM_REQUIRE_DOCKER: process.env.SHELLM_REQUIRE_DOCKER || "1",
    HEADLONG_UNSANDBOXED: process.env.HEADLONG_UNSANDBOXED || "0",
    MONOLITH_BACKOFF_HOLD: process.env.MONOLITH_BACKOFF_HOLD || "1",
    SHELLM_MAX_ITERATIONS: process.env.SHELLM_MAX_ITERATIONS || "8",
    ...(faultProxy ? { LLM_API_URL: faultProxy.url() } : {}),
  };
  // DOCKER_CONTEXT passes through as-is (undefined if unset — spread below drops undefined keys).

  function sideBaseEnv(appDir, headlongHome) {
    const path_ = [path.join(appDir, "bin"), path.join(appDir, "tools"), process.env.PATH || ""].filter(Boolean).join(path.delimiter);
    return {
      ...process.env,
      ...personaEnv,
      ...modelEnv,
      HEADLONG_HOME: headlongHome,
      HEADLONG_APP_DIR: appDir,
      PATH: path_,
    };
  }

  const origBase = sideBaseEnv(origAppDir, origHome);
  const portBase = sideBaseEnv(portAppDir, portHome);
  fs.mkdirSync(origHome, { recursive: true });
  fs.mkdirSync(portHome, { recursive: true });

  const sideFailures = [];

  // -------------------------------------------------------------------------
  // Step 2: identity creation
  // -------------------------------------------------------------------------
  const identitiesRootOrig = path.join(origAppDir, ".identities");
  const identitiesRootPort = path.join(portAppDir, ".identities");
  const identityDirOrig = path.join(identitiesRootOrig, opts.identity);
  const identityDirPort = path.join(identitiesRootPort, opts.identity);

  if (opts.dryRun) {
    // headlong-init --dry-run: real smoke test of the sandbox-consent gate on
    // both sides, zero network/model cost (it returns before ensureApiKey /
    // createIdentity even run — see src/init.ts's runHeadlongInitInner).
    process.stdout.write("run-sxs: [dry-run] headlong-init --dry-run (sandbox gate) on both sides...\n");
    const origGate = headlongInit("orig", origAppDir, { ...origBase, HEADLONG_NO_TTY: "1" }, ["--dry-run"]);
    const portGate = headlongInit("port", portAppDir, { ...portBase, HEADLONG_NO_TTY: "1" }, ["--dry-run"]);
    if (origGate.status !== 0) sideFailures.push(`orig: headlong-init --dry-run exited ${origGate.status}: ${(origGate.stderr || "").slice(0, 2000)}`);
    if (portGate.status !== 0) sideFailures.push(`port: headlong-init --dry-run exited ${portGate.status}: ${(portGate.stderr || "").slice(0, 2000)}`);

    // identity new: materializes the real identity scaffold (memories/,
    // skills/, kernel/, trajectories/ with seed thoughts, thinkers/) at zero
    // cost, so dry-run can still prove the two sides' identity shape matches
    // structurally — headlong-init's OWN --dry-run flag deliberately does
    // not create an identity at all (see src/init.ts), so it alone can't
    // prove this.
    process.stdout.write("run-sxs: [dry-run] identity new (scaffold only, no LLM persona rewrite)...\n");
    const origNew = identityNewCli("orig", origAppDir, { ...origBase, IDENTITY_DIR: identitiesRootOrig }, opts.identity);
    const portNew = identityNewCli("port", portAppDir, { ...portBase, IDENTITY_DIR: identitiesRootPort }, opts.identity);
    if (origNew.status !== 0) sideFailures.push(`orig: identity new exited ${origNew.status}: ${(origNew.stderr || "").slice(0, 2000)}`);
    if (portNew.status !== 0) sideFailures.push(`port: identity new exited ${portNew.status}: ${(portNew.stderr || "").slice(0, 2000)}`);
  } else {
    process.stdout.write("run-sxs: headlong-init (real identity + persona LLM call) on both sides...\n");
    const initEnv = (base) => ({ ...base, HEADLONG_NO_TTY: "1", HEADLONG_NO_DASH: "1", HEADLONG_NO_THINKERS: "1" });
    const origInit = headlongInit("orig", origAppDir, initEnv(origBase), []);
    const portInit = headlongInit("port", portAppDir, initEnv(portBase), []);
    if (origInit.status !== 0) sideFailures.push(`orig: headlong-init exited ${origInit.status}: ${(origInit.stderr || "").slice(0, 4000)}`);
    if (portInit.status !== 0) sideFailures.push(`port: headlong-init exited ${portInit.status}: ${(portInit.stderr || "").slice(0, 4000)}`);
  }

  if (sideFailures.length > 0) {
    for (const f of sideFailures) process.stderr.write(`run-sxs: FAILED — ${f}\n`);
    process.stderr.write(`run-sxs: scratch root preserved for inspection: ${scratchRoot}\n`);
    if (faultProxy) await faultProxy.close();
    return 1;
  }

  if (!fs.existsSync(path.join(identityDirOrig, "info.txt")) || !fs.existsSync(path.join(identityDirPort, "info.txt"))) {
    process.stderr.write(`run-sxs: FAILED — identity was not created on one or both sides (checked ${identityDirOrig}, ${identityDirPort})\n`);
    if (faultProxy) await faultProxy.close();
    return 1;
  }

  const origEnv = buildBashIdentityEnv(identityDirOrig, origBase);
  const portEnv = await buildPortIdentityEnv(portAppDir, identityDirPort, portBase, portHome);

  let dockerBefore = [];
  try {
    dockerBefore = listShellmContainers(process.env);
  } catch {
    /* docker not reachable — fine for --dry-run, live run needs it */
  }

  let origOrphanProcesses = [];
  let portOrphanProcesses = [];
  let containersForReport = [];
  let origDrainSeconds = null;
  let portDrainSeconds = null;
  const chaosRows = [];
  const secondIdentities = []; // {side, appDir, identityDir, env, launcherPid}[]

  if (!opts.dryRun) {
    // -----------------------------------------------------------------------
    // Step 3: start thinkers, distinct state homes (already distinct via
    // HEADLONG_HOME/HEADLONG_APP_DIR/IDENTITY_DIR above), DOCKER_CONTEXT
    // passed through via origBase/portBase's `...process.env` spread.
    // -----------------------------------------------------------------------
    process.stdout.write("run-sxs: starting thinkers on both sides...\n");
    const origStart = thinkersStart("orig", origAppDir, origEnv);
    const portStart = thinkersStart("port", portAppDir, portEnv);
    if (origStart.status !== 0) sideFailures.push(`orig: thinkers start exited ${origStart.status}: ${(origStart.stderr || "").slice(0, 2000)}`);
    if (portStart.status !== 0) sideFailures.push(`port: thinkers start exited ${portStart.status}: ${(portStart.stderr || "").slice(0, 2000)}`);
    if (sideFailures.length > 0) {
      for (const f of sideFailures) process.stderr.write(`run-sxs: FAILED — ${f}\n`);
      if (faultProxy) await faultProxy.close();
      return 1;
    }
    // Every launcher pid ever recorded from a `thinkers start` invocation
    // (this initial one, or a mid-scenario thinkers-start event) — excluded
    // from orphan detection below. They're ours, not leaks; a stale one from
    // an earlier restart is harmless to keep excluding once it's dead.
    const origLauncherPids = new Set([origStart.pid].filter((p) => p != null));
    const portLauncherPids = new Set([portStart.pid].filter((p) => p != null));

    // ---------------------------------------------------------------------
    // Step 4: the compiled event timeline — messages, bursts, and chaos
    // events — applied to BOTH sides at the same wall-clock offset.
    // ---------------------------------------------------------------------
    const startTime = Date.now();
    for (const ev of timeline) {
      await sleepUntil(startTime + ev.atMinutes * 60_000);
      await applyEvent(ev);
    }

    async function applyEvent(ev) {
      switch (ev.type) {
        case "message": {
          const from = ev.from || opts.operator;
          const to = ev.to || opts.identity;
          process.stdout.write(`run-sxs: T+${ev.atMinutes.toFixed(2)}min — message (from=${from}${ev.burstId !== undefined ? `, burst ${ev.burstIndex}/${ev.burstCount}` : ""})...\n`);
          const origSend = chatSend("orig", origAppDir, origEnv, from, to, ev.text);
          const portSend = chatSend("port", portAppDir, portEnv, from, to, ev.text);
          if (origSend.status !== 0) process.stderr.write(`run-sxs: orig chat send failed: ${origSend.stderr}\n`);
          if (portSend.status !== 0) process.stderr.write(`run-sxs: port chat send failed: ${portSend.stderr}\n`);
          break;
        }
        case "thinkers-stop": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — thinkers-stop (force=${Boolean(ev.force)})...\n`);
          const before = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          thinkersStop("orig", origAppDir, origEnv, Boolean(ev.force));
          thinkersStop("port", portAppDir, portEnv, Boolean(ev.force));
          await sleepMs(CHAOS_SETTLE_MS["thinkers-stop"]);
          const after = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          chaosRows.push(compareChaosEvent(ev, before.orig, after.orig, before.port, after.port));
          break;
        }
        case "thinkers-start": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — thinkers-start...\n`);
          const before = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          const origRestart = thinkersStart("orig", origAppDir, origEnv);
          const portRestart = thinkersStart("port", portAppDir, portEnv);
          if (origRestart.pid != null) origLauncherPids.add(origRestart.pid);
          if (portRestart.pid != null) portLauncherPids.add(portRestart.pid);
          await sleepMs(CHAOS_SETTLE_MS["thinkers-start"]);
          const after = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          chaosRows.push(compareChaosEvent(ev, before.orig, after.orig, before.port, after.port));
          break;
        }
        case "dispatcher-sigterm":
        case "dispatcher-sigkill": {
          const sig = ev.type === "dispatcher-sigterm" ? "SIGTERM" : "SIGKILL";
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — ${ev.type} (dispatcher ${sig})...\n`);
          const before = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          for (const [dir] of [[identityDirOrig], [identityDirPort]]) {
            const pid = dispatcherPid(dir);
            if (pid && isAlive(pid)) {
              try {
                process.kill(pid, sig);
              } catch {
                /* already gone */
              }
            } else {
              process.stdout.write(`run-sxs: ${dir === identityDirOrig ? "orig" : "port"}: no live dispatcher to signal at T+${ev.atMinutes}min\n`);
            }
          }
          await sleepMs(CHAOS_SETTLE_MS[ev.type]);
          const after = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          chaosRows.push(compareChaosEvent(ev, before.orig, after.orig, before.port, after.port));
          break;
        }
        case "step-sigkill": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — step-sigkill...\n`);
          const before = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          const origStep = findStepProcess(origAppDir);
          const portStep = findStepProcess(portAppDir);
          if (origStep) {
            try {
              process.kill(origStep.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          } else process.stdout.write("run-sxs: orig: no in-flight step to kill\n");
          if (portStep) {
            try {
              process.kill(portStep.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          } else process.stdout.write("run-sxs: port: no in-flight step to kill\n");
          await sleepMs(CHAOS_SETTLE_MS["step-sigkill"]);
          const after = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          chaosRows.push(compareChaosEvent(ev, before.orig, after.orig, before.port, after.port));
          break;
        }
        case "docker-pause":
        case "docker-unpause": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — ${ev.type}...\n`);
          const before = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          const origContainers = containersForIdentity(identityDirOrig, origEnv);
          const portContainers = containersForIdentity(identityDirPort, portEnv);
          const act = ev.type === "docker-pause" ? dockerPauseAll : dockerUnpauseAll;
          act(origContainers, origEnv);
          act(portContainers, portEnv);
          if (origContainers.length === 0) process.stdout.write("run-sxs: orig: no sandbox container to pause/unpause yet\n");
          if (portContainers.length === 0) process.stdout.write("run-sxs: port: no sandbox container to pause/unpause yet\n");
          await sleepMs(CHAOS_SETTLE_MS[ev.type]);
          const after = await captureChaosPair(identityDirOrig, origEnv, identityDirPort, portEnv);
          chaosRows.push(compareChaosEvent(ev, before.orig, after.orig, before.port, after.port));
          break;
        }
        case "model-fault": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — model-fault ${ev.faultType} x${ev.count}...\n`);
          if (faultProxy) await faultProxy.queueFault(ev.faultType, ev.count);
          else process.stderr.write("run-sxs: model-fault event fired but no fault proxy is running (OPENROUTER_API_KEY missing?) — skipped\n");
          break;
        }
        case "quiet": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — quiet window begins (${ev.minutes} min, no scripted events — watching for unprompted outreach)\n`);
          break; // the timeline itself has nothing else scheduled inside this window (scenario.mjs validated that)
        }
        case "second-identity": {
          process.stdout.write(`run-sxs: T+${ev.atMinutes}min — second-identity "${ev.name}"...\n`);
          const origResult = await createSecondIdentity(ev.name, "orig", origAppDir, origBase, identitiesRootOrig);
          const portResult = await createSecondIdentity(ev.name, "port", portAppDir, portBase, identitiesRootPort);
          if (origResult.ok) {
            secondIdentities.push({ side: "orig", appDir: origAppDir, identityDir: origResult.identityDir, env: origResult.env, launcherPid: origResult.launcherPid });
            if (origResult.launcherPid != null) origLauncherPids.add(origResult.launcherPid);
          } else process.stderr.write(`run-sxs: orig: second-identity "${ev.name}" failed: ${origResult.error}\n`);
          if (portResult.ok) {
            secondIdentities.push({ side: "port", appDir: portAppDir, identityDir: portResult.identityDir, env: portResult.env, launcherPid: portResult.launcherPid });
            if (portResult.launcherPid != null) portLauncherPids.add(portResult.launcherPid);
          } else process.stderr.write(`run-sxs: port: second-identity "${ev.name}" failed: ${portResult.error}\n`);
          break;
        }
        default:
          process.stderr.write(`run-sxs: unhandled event type ${ev.type} — skipped\n`);
      }
    }

    async function createSecondIdentity(name, side, appDir, base, identitiesRoot) {
      const identEnv0 = { ...base, HEADLONG_IDENTITY_NAME: name, HEADLONG_NO_TTY: "1", HEADLONG_NO_DASH: "1", HEADLONG_NO_THINKERS: "1" };
      const initRes = headlongInit(side, appDir, identEnv0, []);
      if (initRes.status !== 0) return { ok: false, error: (initRes.stderr || "").slice(0, 2000) };
      const identityDir = path.join(identitiesRoot, name);
      if (!fs.existsSync(path.join(identityDir, "info.txt"))) return { ok: false, error: "identity not created" };
      const env = side === "orig" ? buildBashIdentityEnv(identityDir, base) : await buildPortIdentityEnv(appDir, identityDir, base, base.HEADLONG_HOME);
      const startRes = thinkersStart(side, appDir, env);
      if (startRes.status !== 0) return { ok: false, error: (startRes.stderr || "").slice(0, 2000) };
      return { ok: true, identityDir, env, launcherPid: startRes.pid };
    }

    // -----------------------------------------------------------------------
    // Step 5: run for --minutes total (wall clock from start, not from the
    // last event).
    // -----------------------------------------------------------------------
    await sleepUntil(startTime + opts.minutes * 60_000);

    // -----------------------------------------------------------------------
    // Step 6: stop both cleanly — drain, then force, then verify.
    //
    // `thinkers stop` (no --force) returns once it has told the thinkers to
    // drain in-flight steps; the draining itself (up to THINKERS_DRAIN_TIMEOUT,
        // default 180s) happens AFTER the command returns, in the thinker
    // processes themselves, on both the upstream and port sides. Checking
    // for orphans immediately after `stop` returns therefore catches
    // still-exiting processes mid-drain and misreports them as leaks — so:
    // poll (not check-once) until quiet or the drain deadline (+10s grace)
    // passes, THEN force, THEN poll again (up to 20s) before declaring
    // anything a true orphan. Every launcher pid recorded above (initial
    // start, any mid-scenario thinkers-start, any second-identity start) is
    // excluded throughout. Any second identity is stopped here too — orphan
    // detection scans by appDir prefix, not by identity, so a still-running
    // second identity would otherwise be misreported as a leak.
    // -----------------------------------------------------------------------
    process.stdout.write("run-sxs: stopping both sides (drain)...\n");
    thinkersStop("orig", origAppDir, origEnv, false);
    thinkersStop("port", portAppDir, portEnv, false);
    for (const id of secondIdentities) thinkersStop(id.side, id.appDir, id.env, false);

    const drainDeadlineMs = THINKERS_DRAIN_TIMEOUT_SEC * 1000 + DRAIN_GRACE_MS;
    process.stdout.write(`run-sxs: polling for drain (up to ${Math.round(drainDeadlineMs / 1000)}s)...\n`);
    const [origDrain, portDrain] = await Promise.all([
      pollUntilQuiet({
        listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)),
        excludePids: origLauncherPids,
        deadlineMs: drainDeadlineMs,
      }),
      pollUntilQuiet({
        listProcesses: () => listProcessesUnder(portAppDir).filter((p) => isAlive(p.pid)),
        excludePids: portLauncherPids,
        deadlineMs: drainDeadlineMs,
      }),
    ]);
    origDrainSeconds = Math.round(origDrain.elapsedMs / 1000);
    portDrainSeconds = Math.round(portDrain.elapsedMs / 1000);

    let origOrphansFinal = [];
    let portOrphansFinal = [];
    if (origDrain.remaining.length > 0 || portDrain.remaining.length > 0) {
      process.stdout.write("run-sxs: lingering process(es) after drain — forcing stop...\n");
      killOrphans(origDrain.remaining);
      killOrphans(portDrain.remaining);
      thinkersStop("orig", origAppDir, origEnv, true);
      thinkersStop("port", portAppDir, portEnv, true);
      // final verification, after force: anything still alive is a true orphan.
      const [origForce, portForce] = await Promise.all([
        pollUntilQuiet({
          listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)),
          excludePids: origLauncherPids,
          deadlineMs: FORCE_POLL_TIMEOUT_MS,
        }),
        pollUntilQuiet({
          listProcesses: () => listProcessesUnder(portAppDir).filter((p) => isAlive(p.pid)),
          excludePids: portLauncherPids,
          deadlineMs: FORCE_POLL_TIMEOUT_MS,
        }),
      ]);
      origOrphansFinal = origForce.remaining;
      portOrphansFinal = portForce.remaining;
      killOrphans(origOrphansFinal);
      killOrphans(portOrphansFinal);
    }

    let dockerAfter = [];
    try {
      dockerAfter = listShellmContainers(process.env);
    } catch {
      /* best effort */
    }
    const beforeIds = new Set(dockerBefore.map((c) => c.id));
    const newContainers = dockerAfter.filter((c) => !beforeIds.has(c.id));
    const leakedContainers = [];
    for (const c of newContainers) {
      const rm = spawnSync("docker", ["rm", "-f", c.id], { encoding: "utf8", env: process.env });
      if (rm.status !== 0) leakedContainers.push(`${c.name} (${c.id})`);
    }

    origOrphanProcesses = origOrphansFinal.map((p) => `${p.pid}: ${p.command}`);
    portOrphanProcesses = portOrphansFinal.map((p) => `${p.pid}: ${p.command}`);
    containersForReport = leakedContainers;
  }

  let faultProxyStats = { requestCount: 0, events: [], queueDepth: 0 };
  if (faultProxy) {
    faultProxyStats = await faultProxy.getStats();
    process.stdout.write(`run-sxs: fault-proxy served ${faultProxyStats.events.length} request(s), ${faultProxyStats.events.filter((e) => e.faulted).length} faulted\n`);
    await faultProxy.close();
  }

  // ---------------------------------------------------------------------------
  // Step 7: capture + Step 8: compare/report
  // ---------------------------------------------------------------------------
  const timelineMessages = timeline.filter((e) => e.type === "message");
  const origOperator = timelineMessages[0]?.from || opts.operator;
  if (!opts.dryRun) {
    const origHist = chatHistory("orig", origAppDir, origEnv, origOperator);
    const portHist = chatHistory("port", portAppDir, portEnv, origOperator);
    fs.writeFileSync(path.join(scratchRoot, "orig-chat-history.json"), origHist.stdout || "");
    fs.writeFileSync(path.join(scratchRoot, "port-chat-history.json"), portHist.stdout || "");
  }

  const origCapture = captureSide(identityDirOrig, opts.identity);
  const portCapture = captureSide(identityDirPort, opts.identity);
  const origSummary = { ...buildSideSummary({ ...origCapture, identityName: opts.identity }), orphanProcesses: origOrphanProcesses, orphanContainers: containersForReport, drainSeconds: origDrainSeconds };
  const portSummary = { ...buildSideSummary({ ...portCapture, identityName: opts.identity }), orphanProcesses: portOrphanProcesses, orphanContainers: [], drainSeconds: portDrainSeconds };

  const { diffs, inconclusive } = structuralDiff(origSummary, portSummary);
  const chaosMismatchCount = chaosRows.reduce((n, r) => n + r.fields.filter((f) => !f.match).length, 0);
  const meta = {
    identityName: opts.identity,
    minutes: opts.dryRun ? 0 : opts.minutes,
    model,
    startedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    scratchRoot,
    chaosEventCount: chaosRows.length,
    faultProxyRequests: faultProxyStats.events.length,
  };

  const report = renderReport({ orig: origSummary, port: portSummary, diffs, inconclusive, meta, chaosRows });
  fs.writeFileSync(path.join(scratchRoot, "report.md"), report);
  fs.writeFileSync(
    path.join(scratchRoot, "results.json"),
    JSON.stringify(
      {
        meta,
        diffs,
        inconclusive,
        chaosRows,
        orig: { counts: origSummary.counts, collapsed: origSummary.collapsed, replies: origSummary.replies, wakeTimeline: origSummary.wakeTimeline, memoryFiles: origSummary.memoryFiles, messageIndexCount: origSummary.messageIndexCount, trajectoryMessageCount: origSummary.trajectoryMessageCount, perThinkerLogBytes: origSummary.perThinkerLogBytes, orphanProcesses: origSummary.orphanProcesses, orphanContainers: origSummary.orphanContainers, drainSeconds: origSummary.drainSeconds },
        port: { counts: portSummary.counts, collapsed: portSummary.collapsed, replies: portSummary.replies, wakeTimeline: portSummary.wakeTimeline, memoryFiles: portSummary.memoryFiles, messageIndexCount: portSummary.messageIndexCount, trajectoryMessageCount: portSummary.trajectoryMessageCount, perThinkerLogBytes: portSummary.perThinkerLogBytes, orphanProcesses: portSummary.orphanProcesses, orphanContainers: portSummary.orphanContainers, drainSeconds: portSummary.drainSeconds },
      },
      null,
      2
    )
  );

  process.stdout.write(`\nrun-sxs: report written: ${path.join(scratchRoot, "report.md")}\n`);
  process.stdout.write(`run-sxs: results written: ${path.join(scratchRoot, "results.json")}\n`);
  if (chaosRows.length > 0) {
    process.stdout.write(`run-sxs: chaos recovery: ${chaosRows.length} event(s), ${chaosMismatchCount} field mismatch(es) — see report.md's Chaos recovery section.\n`);
  }
  if (diffs.length === 0 && chaosMismatchCount === 0) {
    if (inconclusive.length > 0) {
      process.stdout.write(`run-sxs: PASS (inconclusive: ${inconclusive.map((d) => d.code).join(", ")}) — no structural diffs, but ${inconclusive.length} small-sample rule(s) could not reach a verdict (see report.md). Re-run with more minutes if this matters.\n`);
    } else {
      process.stdout.write("run-sxs: PASS — no structural diffs.\n");
    }
    return 0;
  }
  process.stdout.write(`run-sxs: FAIL — ${diffs.length} structural diff(s)${chaosMismatchCount > 0 ? ` + ${chaosMismatchCount} chaos-recovery mismatch(es)` : ""}:\n`);
  for (const d of diffs) process.stdout.write(`  - [${d.code}] ${d.message}\n`);
  return diffs.length > 0 ? exitCodeForDiffs(diffs) : 2;
}

/** SIGTERM everything in `procs`. Best-effort — a pid that's already gone is ignored. */
function killOrphans(procs) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// Only run main() when this file is the process entry point — not when a
// test imports it to exercise the pure helpers above (filterOrphans,
// pollUntilQuiet) with no upstream checkout, no LLM key, no Docker.
const isEntryPoint = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`run-sxs: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
