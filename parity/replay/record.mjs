#!/usr/bin/env node
// parity/replay/record.mjs — L2 step 1 (PROOF-CAMPAIGN.md): run ONE real
// upstream (Bash) Headlong session through a RECORDING proxy that relays
// every request to the real provider byte-for-byte (the session is
// unaffected — same latency, same content) while tapping the exchange into
// a replay tape (JSONL, secrets scrubbed: the tape never carries a header
// or env var VALUE, only lane/seq/model/response text/usage — see lib.mjs's
// parseUpstreamResponse). proxy.mjs replays that tape later against BOTH
// engines.
//
// Zero Bash: every process this script spawns is invoked by its own path or
// via `node <script>.mjs` (see parity/live/run-sxs.mjs's header for why).
//
// The recording proxy itself runs as a SEPARATE process
// (recording-proxy.mjs), spawned below — never in-process with this
// script's own orchestration. That in-process shape was the first version
// of this file and it deadlocked every real run: this script drives
// headlong-init via node:child_process's spawnSync, which blocks the
// ENTIRE event loop for the subprocess's whole lifetime (Node is single-
// threaded), so an http.createServer sharing that process cannot accept()
// or emit 'request' while spawnSync blocks it — the OS still completes the
// TCP handshake (ESTABLISHED in lsof/netstat) but the request sits unread
// until curl's own --speed-limit guard trips ("Operation too slow. Less
// than 100 bytes/sec transferred the last 60 seconds"). 100% reproducible;
// see recording-proxy.mjs's header for the isolation that found it.
//
// Usage:
//   export OPENROUTER_API_KEY=...               # real key, THIS shell only
//   PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/replay/record.mjs [--minutes N] [--messages FILE] [--identity NAME]
//
// The key is read from process.env only (OPENROUTER_API_KEY) — never from
// argv or a file, and never written to any file this script creates
// (tape, meta, scratch checkout). Exit codes: 0 = recorded cleanly, 1 = setup
// or a side failure (see stderr).
//
// CLASSIFICATION (2026-10-29): RECORDER OF REAL RESPONSES (see proxy.mjs). record-meta.json carries the provenance:
// source, provider URL, model, start/finish time.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  copyTree,
  headlongInit,
  thinkersStart,
  thinkersStop,
  chatSend,
  readInfoField,
  rootTrajFile,
  readFileOrEmpty,
  listProcessesUnder,
  listShellmContainers,
  killOrphans,
  isAlive,
  sleepUntil,
  timestampSlug,
  buildBashIdentityEnv,
  pollUntilQuiet,
  DEFAULT_SCENARIO,
  DEFAULT_PERSONA_ENV,
  proxyUrlEnv,
} from "./harness.mjs";

function die(msg) {
  process.stderr.write(`record: ${msg}\n`);
  process.exit(1);
}

function parseArgv(argv) {
  const opts = { minutes: 10, messagesFile: null, identity: "l2rec", operator: "jo", recordPort: 8931 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--messages") opts.messagesFile = argv[++i];
    else if (a === "--identity") opts.identity = argv[++i];
    else if (a === "--operator") opts.operator = argv[++i];
    else if (a === "--record-port") opts.recordPort = Number(argv[++i]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else die(`unknown argument: ${a}`);
  }
  return opts;
}

const HELP_TEXT = `Usage: PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/replay/record.mjs [options]

  --minutes N       Recording duration in minutes (default 10)
  --messages FILE   JSON scenario file: [{ "atMinutes": N, "text": "..." }, ...]
  --identity NAME   Identity name (default l2rec)
  --record-port N   Local recording-proxy port (default 8931)

Env: PARITY_UPSTREAM_ROOT (required), PARITY_REPLAY_ROOT (optional scratch
root, default ~/.headlong-parity-replay/<timestamp>), OPENROUTER_API_KEY
(required — real key, process env only), RECORD_UPSTREAM_URL (optional,
default https://openrouter.ai/api/v1/chat/completions).
`;

// ---------------------------------------------------------------------------
// recording proxy: relays byte-for-byte to the real provider, taps the
// exchange into a tape entry once the response completes.
// ---------------------------------------------------------------------------

function startRecordingProxy({ port, upstreamUrl, tapeOutPath, log }) {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "recording-proxy.mjs");
  const child = spawn(process.execPath, [scriptPath, "--port", String(port), "--tape-out", tapeOutPath, "--upstream-url", upstreamUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = { requests: 0, byLane: {} };
  child.stdout.on("data", (d) => {
    const text = String(d);
    log(`[recording-proxy] ${text}`);
    // A single stdout chunk can carry several "taped lane=..." lines at
    // once (fast successive requests) — match ALL of them, not just the
    // first, or the summary undercounts (tape.jsonl itself stays correct;
    // this only feeds record-meta.json's human-readable summary).
    for (const m of text.matchAll(/taped lane=(\S+) seq=(\d+)/g)) {
      summary.requests += 1;
      summary.byLane[m[1]] = (summary.byLane[m[1]] ?? 0) + 1;
    }
  });
  child.stderr.on("data", (d) => log(`[recording-proxy] ${d}`));

  return new Promise((resolve, reject) => {
    let ready = false;
    const onData = (d) => {
      if (String(d).includes("listening on")) {
        ready = true;
        child.stdout.off("data", onData);
        resolve({ child, summary });
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      if (!ready) reject(new Error(`recording-proxy exited before reporting ready (code ${code})`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error("recording-proxy did not report ready within 10s"));
    }, 10_000).unref();
  });
}

function stopRecordingProxy(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(resolve, 3000).unref();
  });
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
  if (!process.env.OPENROUTER_API_KEY) {
    die("OPENROUTER_API_KEY is not set — source your credentials script into THIS shell first (never pass a key on argv/file)");
  }

  let scenario = DEFAULT_SCENARIO;
  if (opts.messagesFile) scenario = JSON.parse(fs.readFileSync(opts.messagesFile, "utf8"));

  const scratchRoot = process.env.PARITY_REPLAY_ROOT || path.join(os.homedir(), ".headlong-parity-replay", `record-${timestampSlug()}`);
  if (!scratchRoot.startsWith(os.homedir())) {
    process.stderr.write(`record: warning: scratch root ${scratchRoot} is not under $HOME — Colima only shares $HOME into its VM\n`);
  }
  fs.mkdirSync(scratchRoot, { recursive: true });
  process.stdout.write(`record: scratch root: ${scratchRoot}\n`);

  const tapeOutPath = process.env.PARITY_REPLAY_TAPE || path.join(scratchRoot, "tape.jsonl");
  // recording-proxy.mjs opens this itself (append mode) — created here only
  // so a pre-existing file is truncated-free and the path definitely exists
  // for run-replay.mjs to point at even if the run fails before any tape.
  if (!fs.existsSync(tapeOutPath)) fs.writeFileSync(tapeOutPath, "");

  const upstreamUrl = process.env.RECORD_UPSTREAM_URL || "https://openrouter.ai/api/v1/chat/completions";
  const { child: recProxyChild, summary } = await startRecordingProxy({
    port: opts.recordPort,
    upstreamUrl,
    tapeOutPath,
    log: (s) => process.stdout.write(s),
  });
  process.stdout.write(`record: recording proxy listening on 127.0.0.1:${opts.recordPort} -> ${upstreamUrl}\n`);

  const origAppDir = path.join(scratchRoot, "app");
  const origHome = path.join(scratchRoot, "home");
  process.stdout.write("record: copying upstream checkout (cp -R -c)...\n");
  copyTree(upstreamRoot, origAppDir);
  fs.mkdirSync(origHome, { recursive: true });

  const model = process.env.SHELLM_MODEL || "deepseek/deepseek-v4-flash-0731";
  const personaEnv = {
    HEADLONG_IDENTITY_NAME: opts.identity,
    HEADLONG_IDENTITY_VIBE: process.env.HEADLONG_IDENTITY_VIBE || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_VIBE,
    HEADLONG_IDENTITY_FOCUS: process.env.HEADLONG_IDENTITY_FOCUS || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_FOCUS,
    HEADLONG_OPERATOR_NAME: process.env.HEADLONG_OPERATOR_NAME || DEFAULT_PERSONA_ENV.HEADLONG_OPERATOR_NAME,
    HEADLONG_IDENTITY_USER: process.env.HEADLONG_IDENTITY_USER || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_USER,
  };
  const modelEnv = {
    SHELLM_MODEL: model,
    SHELLM_REQUIRE_DOCKER: process.env.SHELLM_REQUIRE_DOCKER || "1",
    HEADLONG_UNSANDBOXED: process.env.HEADLONG_UNSANDBOXED || "0",
    MONOLITH_BACKOFF_HOLD: process.env.MONOLITH_BACKOFF_HOLD || "1",
    SHELLM_MAX_ITERATIONS: process.env.SHELLM_MAX_ITERATIONS || "8",
    ...proxyUrlEnv(`http://127.0.0.1:${opts.recordPort}/v1/chat/completions`),
  };
  const pathEnv = [path.join(origAppDir, "bin"), path.join(origAppDir, "tools"), process.env.PATH || ""].filter(Boolean).join(path.delimiter);
  const origBase = { ...process.env, ...personaEnv, ...modelEnv, HEADLONG_HOME: origHome, HEADLONG_APP_DIR: origAppDir, PATH: pathEnv };

  const identitiesRootOrig = path.join(origAppDir, ".identities");
  const identityDirOrig = path.join(identitiesRootOrig, opts.identity);

  process.stdout.write("record: headlong-init (real identity + persona LLM call)...\n");
  const initEnv = { ...origBase, HEADLONG_NO_TTY: "1", HEADLONG_NO_DASH: "1", HEADLONG_NO_THINKERS: "1" };
  const origInit = headlongInit("orig", origAppDir, initEnv, []);
  if (origInit.status !== 0) {
    process.stderr.write(`record: FAILED — headlong-init exited ${origInit.status}: ${(origInit.stderr || "").slice(0, 4000)}\n`);
    await stopRecordingProxy(recProxyChild);
    return 1;
  }
  if (!fs.existsSync(path.join(identityDirOrig, "info.txt"))) {
    process.stderr.write(`record: FAILED — identity was not created (checked ${identityDirOrig})\n`);
    await stopRecordingProxy(recProxyChild);
    return 1;
  }

  const origEnv = buildBashIdentityEnv(identityDirOrig, origBase);

  let dockerBefore = [];
  try {
    dockerBefore = listShellmContainers(process.env);
  } catch {
    /* docker not reachable */
  }

  process.stdout.write("record: starting thinkers...\n");
  const origStart = thinkersStart("orig", origAppDir, origEnv);
  if (origStart.status !== 0) {
    process.stderr.write(`record: FAILED — thinkers start exited ${origStart.status}: ${(origStart.stderr || "").slice(0, 2000)}\n`);
    await stopRecordingProxy(recProxyChild);
    return 1;
  }
  const launcherPids = new Set([origStart.pid].filter((p) => p != null));

  const startTime = Date.now();
  for (const msg of scenario) {
    await sleepUntil(startTime + msg.atMinutes * 60_000);
    const from = msg.from || opts.operator;
    process.stdout.write(`record: T+${msg.atMinutes}min — sending message (from=${from})...\n`);
    const send = chatSend("orig", origAppDir, origEnv, from, opts.identity, msg.text);
    if (send.status !== 0) process.stderr.write(`record: chat send failed: ${send.stderr}\n`);
  }

  await sleepUntil(startTime + opts.minutes * 60_000);

  process.stdout.write("record: stopping (drain)...\n");
  thinkersStop("orig", origAppDir, origEnv, false);
  const drainDeadlineMs = Number(process.env.THINKERS_DRAIN_TIMEOUT || 180) * 1000 + 10_000;
  const drain = await pollUntilQuiet({
    listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)),
    excludePids: launcherPids,
    deadlineMs: drainDeadlineMs,
  });
  let orphansFinal = [];
  if (drain.remaining.length > 0) {
    process.stdout.write("record: lingering process(es) after drain — forcing stop...\n");
    killOrphans(drain.remaining);
    thinkersStop("orig", origAppDir, origEnv, true);
    const force = await pollUntilQuiet({
      listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)),
      excludePids: launcherPids,
      deadlineMs: 20_000,
    });
    orphansFinal = force.remaining;
    killOrphans(orphansFinal);
  }

  let leakedContainers = [];
  try {
    const dockerAfter = listShellmContainers(process.env);
    const beforeIds = new Set(dockerBefore.map((c) => c.id));
    for (const c of dockerAfter.filter((c) => !beforeIds.has(c.id))) {
      const { spawnSync } = await import("node:child_process");
      const rm = spawnSync("docker", ["rm", "-f", c.id], { encoding: "utf8", env: process.env });
      if (rm.status !== 0) leakedContainers.push(`${c.name} (${c.id})`);
    }
  } catch {
    /* best effort */
  }

  const rootId = readInfoField(identityDirOrig, "root_trajectory");
  const trajText = rootId ? readFileOrEmpty(rootTrajFile(path.join(identityDirOrig, "trajectories"), rootId)) : "";
  const trajStepCount = trajText.split("\n").filter((l) => l.trim()).length;

  await stopRecordingProxy(recProxyChild);

  const meta = {
    source: "recorded: real provider responses relayed byte for byte by parity/replay/recording-proxy.mjs",
    provider_url: upstreamUrl,
    identity: opts.identity,
    model,
    minutes: opts.minutes,
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date().toISOString(),
    scratchRoot,
    tapeOutPath,
    tapeRequests: summary.requests,
    tapeByLane: summary.byLane,
    origTrajectoryStepCount: trajStepCount,
    orphanProcesses: orphansFinal.map((p) => `${p.pid}: ${p.command}`),
    orphanContainers: leakedContainers,
  };
  fs.writeFileSync(path.join(scratchRoot, "record-meta.json"), JSON.stringify(meta, null, 2));

  process.stdout.write(`\nrecord: done. tape: ${tapeOutPath} (${summary.requests} requests, lanes ${JSON.stringify(summary.byLane)})\n`);
  process.stdout.write(`record: meta: ${path.join(scratchRoot, "record-meta.json")}\n`);
  if (orphansFinal.length > 0) process.stderr.write(`record: WARNING — ${orphansFinal.length} orphaned process(es) after stop\n`);
  if (leakedContainers.length > 0) process.stderr.write(`record: WARNING — ${leakedContainers.length} leaked container(s)\n`);
  return 0;
}

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
      process.stderr.write(`record: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
