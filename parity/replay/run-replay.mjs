#!/usr/bin/env node
// parity/replay/run-replay.mjs — L2 step 2 (PROOF-CAMPAIGN.md): sets up BOTH
// upstream (Bash) Headlong and the TS port exactly like
// parity/live/run-sxs.mjs (same persona, same scripted messages at the same
// offsets, colima Docker, $HOME scratch roots), but points BOTH sides at a
// REPLAY of a tape recorded by record.mjs instead of a real model — one
// proxy.mjs instance per side, both loaded from the SAME tape file so each
// side independently replays it from position 0 (see proxy.mjs's header for
// why one shared instance would be wrong). Runs `--minutes` (default 10),
// stops both cleanly, aligns the two trajectories step-by-step (lib.mjs's
// alignSteps), diffs run/ files + memories/ + dispatcher logs, classifies
// every divergence, and writes report.md + results.json.
//
// This harness never fixes the port — divergences are reported and
// classified only (PROOF-CAMPAIGN.md's L2 contract).
//
// Usage:
//   PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/replay/run-replay.mjs --tape FILE [--minutes N] [--messages FILE] [--identity NAME] [--wait-quiet PATTERN]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  alignSteps,
  summarizeAlignment,
  classifyAlignment,
  normalizeArtifactText,
  compareNormalizedTexts,
  findEnvironmentLeaks,
} from "./lib.mjs";
import { parseJsonl, parseDispatcherLog } from "../live/lib.mjs";
import {
  copyTree,
  headlongInit,
  thinkersStart,
  thinkersStop,
  chatSend,
  readInfoField,
  rootTrajFile,
  readFileOrEmpty,
  sizeOrZero,
  listProcessesUnder,
  listShellmContainers,
  killOrphans,
  isAlive,
  sleepUntil,
  timestampSlug,
  buildBashIdentityEnv,
  buildPortIdentityEnv,
  pollUntilQuiet,
  waitForQuiet,
  DEFAULT_SCENARIO,
  DEFAULT_PERSONA_ENV,
  proxyUrlEnv,
} from "./harness.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT_ROOT = path.resolve(HERE, "..", "..");
const PROXY_SCRIPT = path.join(HERE, "proxy.mjs");

function die(msg) {
  process.stderr.write(`run-replay: ${msg}\n`);
  process.exit(1);
}

function parseArgv(argv) {
  const opts = { minutes: 10, tape: null, messagesFile: null, identity: "l2replay", operator: "jo", waitQuiet: null, waitQuietMinutes: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--tape") opts.tape = argv[++i];
    else if (a === "--messages") opts.messagesFile = argv[++i];
    else if (a === "--identity") opts.identity = argv[++i];
    else if (a === "--operator") opts.operator = argv[++i];
    else if (a === "--wait-quiet") opts.waitQuiet = argv[++i];
    else if (a === "--wait-quiet-minutes") opts.waitQuietMinutes = Number(argv[++i]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else die(`unknown argument: ${a}`);
  }
  return opts;
}

const HELP_TEXT = `Usage: PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/replay/run-replay.mjs --tape FILE [options]

  --minutes N            Run duration in minutes (default 10)
  --tape FILE             Tape recorded by record.mjs (required)
  --messages FILE         JSON scenario file (default: the same default record.mjs uses)
  --identity NAME         Identity name (default l2replay)
  --wait-quiet PATTERN    pgrep -f PATTERN must report nothing before starting the real run
  --wait-quiet-minutes N  Max minutes to wait for --wait-quiet (default 40)

Env: PARITY_UPSTREAM_ROOT (required), PARITY_REPLAY_ROOT (optional scratch root).
No LLM key is needed — both sides talk to local replay-proxy instances.
`;

function findFreePort() {
  // Deterministic-enough for a local single-run harness: pick from a fixed
  // range and let EADDRINUSE at spawn time be the real check (see startProxy).
  return 20000 + Math.floor(Math.random() * 20000);
}

function startProxy({ tape, port, label, statsOut, missLog }) {
  const child = spawn(process.execPath, [PROXY_SCRIPT, "--tape", tape, "--port", String(port), "--label", label, "--stats-out", statsOut, "--miss-log", missLog], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  child.stdout.on("data", (d) => {
    process.stdout.write(`[proxy:${label}] ${d}`);
    if (String(d).includes("listening on")) ready = true;
  });
  child.stderr.on("data", (d) => process.stderr.write(`[proxy:${label}] ${d}`));
  return { child, waitReady: async () => {
    const start = Date.now();
    while (!ready && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 100));
    if (!ready) throw new Error(`replay-proxy[${label}] did not report ready within 10s`);
  } };
}

function stopProxy(proc) {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// capture (mirrors parity/live/run-sxs.mjs's captureSide, plus run/ file list)
// ---------------------------------------------------------------------------

function listFilesRecursive(dir) {
  const out = [];
  function walk(d, rel) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), relPath);
      else out.push(relPath);
    }
  }
  walk(dir, "");
  return out.sort();
}

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
  const runDir = path.join(identityDir, "run");
  const memoriesDir = path.join(identityDir, "memories");
  return {
    identityName,
    trajectoryText,
    messagesIndexText,
    dispatcherLogText: readFileOrEmpty(path.join(runDir, "logs", "dispatcher.log")),
    perThinkerLogBytes: {
      "monolith.log": sizeOrZero(path.join(runDir, "logs", "monolith.log")),
      "responder.log": sizeOrZero(path.join(runDir, "logs", "responder.log")),
      "responder-notes.log": sizeOrZero(path.join(runDir, "logs", "responder-notes.log")),
    },
    perThinkerLogText: {
      "monolith.log": readFileOrEmpty(path.join(runDir, "logs", "monolith.log")),
      "responder.log": readFileOrEmpty(path.join(runDir, "logs", "responder.log")),
      "responder-notes.log": readFileOrEmpty(path.join(runDir, "logs", "responder-notes.log")),
    },
    memoryFiles: fs.existsSync(memoriesDir) ? fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".md")).sort() : [],
    runFiles: fs.existsSync(runDir) ? listFilesRecursive(runDir) : [],
    runDir,
    memoriesDir,
  };
}

// dispatcher.log's raw TEXT is expected to differ even on a perfect port:
// orig has no fractional-second timestamps and prints `source=` empty for
// an internal step; the port prints milliseconds and `source=-` for the
// same case (documented in parity/live/lib.mjs's parseDispatcherLog header,
// which is why THAT harness diffs parsed events, not raw text). A raw
// per-line diff here would just re-report that known dialect difference as
// a false content-diff on line 1 every single run — skip line content for
// this one file; `artifact-only-one-side` (the file missing entirely) still
// applies, and run-replay.mjs reports parsed dispatcher EVENT COUNTS
// separately (see dispatcherEventCounts in results.json).
const SKIP_CONTENT_DIFF = new Set(["run/logs/dispatcher.log"]);

/** Normalized-content diff of run/ files (by relative path) and memories/ files present on either side. */
function diffArtifactTrees({ origRunDir, portRunDir, origMemDir, portMemDir, origScrub, portScrub }) {
  const diffs = [];
  function diffOne(label, origDir, portDir, origFiles, portFiles) {
    const all = new Set([...origFiles, ...portFiles]);
    for (const rel of [...all].sort()) {
      const inOrig = origFiles.includes(rel);
      const inPort = portFiles.includes(rel);
      if (!inOrig || !inPort) {
        diffs.push({ code: "artifact-only-one-side", path: `${label}/${rel}`, onlyIn: inOrig ? "orig" : "port" });
        continue;
      }
      if (SKIP_CONTENT_DIFF.has(`${label}/${rel}`)) continue;
      const a = normalizeArtifactText(readFileOrEmpty(path.join(origDir, rel)), { scrubPaths: origScrub });
      const b = normalizeArtifactText(readFileOrEmpty(path.join(portDir, rel)), { scrubPaths: portScrub });
      const cmp = compareNormalizedTexts(a, b);
      if (!cmp.equal) {
        diffs.push({ code: "artifact-content-diff", path: `${label}/${rel}`, lineNumber: cmp.lineNumber, orig: cmp.orig, port: cmp.port });
      }
    }
  }
  diffOne("run", origRunDir, portRunDir, listFilesRecursive(origRunDir), listFilesRecursive(portRunDir));
  diffOne("memories", origMemDir, portMemDir, fs.existsSync(origMemDir) ? fs.readdirSync(origMemDir) : [], fs.existsSync(portMemDir) ? fs.readdirSync(portMemDir) : []);
  return diffs;
}

// ---------------------------------------------------------------------------
// PARITY.md-citation lookup — heuristic: a keyword-substring hit in
// PARITY.md is surfaced as a candidate citation for a human to confirm, not
// an authoritative classification. A miss just means "not found", not
// "definitely a port bug" — see classifyDivergence's own doc comment.
// ---------------------------------------------------------------------------

function buildDocLookup(parityMdPath) {
  const text = fs.existsSync(parityMdPath) ? fs.readFileSync(parityMdPath, "utf8") : "";
  const lines = text.split("\n");
  return function docLookup(key) {
    const needle = key.split(/[:.]/).pop();
    if (!needle) return null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        return { file: "PARITY.md", line: i + 1, excerpt: lines[i].trim().slice(0, 200) };
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// report rendering
// ---------------------------------------------------------------------------

function renderReplayReport({ meta, summary, alignment, classified, tapeStats, artifactDiffs }) {
  const lines = [];
  lines.push(`# L2 deterministic replay comparison: ${meta.identityName}`, "");
  lines.push(`Run: ${meta.startedAt} — ${meta.minutes} minute(s), tape \`${meta.tape}\` (${meta.tapeEntryCount} entries).`, "");
  lines.push("## Tape-miss counts", "", "| side | lane | misses |", "|---|---|---|");
  for (const side of ["orig", "port"]) {
    const misses = tapeStats[side]?.missesByLane ?? {};
    const keys = Object.keys(misses);
    if (keys.length === 0) lines.push(`| ${side} | (none) | 0 |`);
    for (const lane of keys) lines.push(`| ${side} | ${lane} | ${misses[lane]} |`);
  }
  lines.push("", `Total requests: orig ${tapeStats.orig?.requests ?? "?"}, port ${tapeStats.port?.requests ?? "?"}.`, "");

  lines.push("## Alignment summary", "");
  lines.push(`Aligned steps: ${summary.alignedSteps} / ${summary.total} (exact match: ${summary.matchedExact}, matched with field diffs: ${summary.matchedWithFieldDiffs}, orig-only: ${summary.origOnly}, port-only: ${summary.portOnly}).`, "");
  if (summary.firstDivergenceIndex === -1) {
    lines.push("No divergence — every step aligned exactly.", "");
  } else {
    lines.push(`First divergence at alignment index ${summary.firstDivergenceIndex}:`, "", "```");
    for (const e of summary.firstDivergenceContext) {
      if (e.status === "matched") {
        lines.push(`  matched  ${e.orig.type}/${e.orig.source ?? "-"}  ${e.fieldDiffs.length ? `(${e.fieldDiffs.length} field diff(s))` : "(exact)"}`);
      } else if (e.status === "orig-only") {
        lines.push(`  orig-only  ${e.orig.type}/${e.orig.source ?? "-"}`);
      } else {
        lines.push(`  port-only  ${e.port.type}/${e.port.source ?? "-"}`);
      }
    }
    lines.push("```", "");
  }

  lines.push("## Classified divergences", "");
  const buckets = { "PORT-BUG candidate": [], "documented-deviation": [], "model nondeterminism": [], "timing-order difference": [], environment: [] };
  for (const c of classified) (buckets[c.bucket] ??= []).push(c);
  for (const [bucket, items] of Object.entries(buckets)) {
    lines.push(`### ${bucket} (${items.length})`, "");
    if (items.length === 0) lines.push("(none)", "");
    for (const it of items.slice(0, 50)) {
      lines.push(`- ${it.detail ?? ""}${it.citation ? ` — cf. ${it.citation.file}:${it.citation.line} "${it.citation.excerpt}"` : ""}`);
    }
    if (items.length > 50) lines.push(`- ... and ${items.length - 50} more`);
    lines.push("");
  }

  lines.push("## Artifact diff (run/ files, memories/)", "");
  if (artifactDiffs.length === 0) lines.push("None — normalized content matches on every shared file.", "");
  else {
    for (const d of artifactDiffs.slice(0, 100)) {
      if (d.code === "artifact-only-one-side") lines.push(`- **[only-one-side]** ${d.path} (only in ${d.onlyIn})`);
      else lines.push(`- **[content-diff]** ${d.path}:${d.lineNumber} — orig: ${JSON.stringify(d.orig)} vs port: ${JSON.stringify(d.port)}`);
    }
    if (artifactDiffs.length > 100) lines.push(`- ... and ${artifactDiffs.length - 100} more`);
    lines.push("");
  }

  lines.push("## Bottom line", "");
  const portBugCount = buckets["PORT-BUG candidate"].length;
  lines.push(
    portBugCount === 0
      ? "No PORT-BUG candidates — every divergence classified as documented deviation, model nondeterminism, timing-order, or environment."
      : `${portBugCount} PORT-BUG candidate(s) — see above. This harness reports and classifies only; it never fixes the port.`,
    ""
  );

  return lines.join("\n");
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
  if (!opts.tape) die("--tape is required (a tape recorded by record.mjs)");
  if (!fs.existsSync(opts.tape)) die(`tape file not found: ${opts.tape}`);

  const upstreamRoot = process.env.PARITY_UPSTREAM_ROOT;
  if (!upstreamRoot) die("PARITY_UPSTREAM_ROOT is not set — point it at a real upstream (Bash) Headlong checkout");
  for (const rel of ["tools/headlong-init", "tools/identity", "bin/thinkers", "bin/chat"]) {
    if (!fs.existsSync(path.join(upstreamRoot, rel))) die(`PARITY_UPSTREAM_ROOT does not look like a Headlong checkout — missing ${rel}`);
  }

  if (opts.waitQuiet) {
    process.stdout.write(`run-replay: waiting for "${opts.waitQuiet}" to be quiet (up to ${opts.waitQuietMinutes}min)...\n`);
    const r = await waitForQuiet({ pattern: opts.waitQuiet, deadlineMs: opts.waitQuietMinutes * 60_000, log: (s) => process.stdout.write(s) });
    if (!r.quiet) process.stdout.write(`run-replay: WARNING — proceeding anyway after ${Math.round(r.waitedMs / 1000)}s; still matched: ${r.pids?.join(",")}\n`);
    else process.stdout.write(`run-replay: quiet after ${Math.round(r.waitedMs / 1000)}s.\n`);
  }

  let scenario = DEFAULT_SCENARIO;
  if (opts.messagesFile) scenario = JSON.parse(fs.readFileSync(opts.messagesFile, "utf8"));

  const scratchRoot = process.env.PARITY_REPLAY_ROOT || path.join(os.homedir(), ".headlong-parity-replay", `replay-${timestampSlug()}`);
  fs.mkdirSync(scratchRoot, { recursive: true });
  process.stdout.write(`run-replay: scratch root: ${scratchRoot}\n`);

  const origAppDir = path.join(scratchRoot, "orig", "app");
  const portAppDir = path.join(scratchRoot, "port", "app");
  const origHome = path.join(scratchRoot, "orig", "home");
  const portHome = path.join(scratchRoot, "port", "home");

  process.stdout.write("run-replay: copying checkouts (cp -R -c)...\n");
  copyTree(upstreamRoot, origAppDir);
  copyTree(PORT_ROOT, portAppDir);
  fs.mkdirSync(origHome, { recursive: true });
  fs.mkdirSync(portHome, { recursive: true });

  const origPort = findFreePort();
  const portPort = origPort + 1;
  const origStatsOut = path.join(scratchRoot, "orig-proxy-stats.json");
  const portStatsOut = path.join(scratchRoot, "port-proxy-stats.json");
  const origMissLog = path.join(scratchRoot, "orig-proxy-misses.jsonl");
  const portMissLog = path.join(scratchRoot, "port-proxy-misses.jsonl");

  process.stdout.write(`run-replay: starting replay proxies (orig:${origPort}, port:${portPort})...\n`);
  const origProxy = startProxy({ tape: opts.tape, port: origPort, label: "orig", statsOut: origStatsOut, missLog: origMissLog });
  const portProxy = startProxy({ tape: opts.tape, port: portPort, label: "port", statsOut: portStatsOut, missLog: portMissLog });
  await Promise.all([origProxy.waitReady(), portProxy.waitReady()]);

  const model = process.env.SHELLM_MODEL || "deepseek/deepseek-v4-flash-0731";
  const personaEnv = {
    HEADLONG_IDENTITY_NAME: opts.identity,
    HEADLONG_IDENTITY_VIBE: process.env.HEADLONG_IDENTITY_VIBE || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_VIBE,
    HEADLONG_IDENTITY_FOCUS: process.env.HEADLONG_IDENTITY_FOCUS || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_FOCUS,
    HEADLONG_OPERATOR_NAME: process.env.HEADLONG_OPERATOR_NAME || DEFAULT_PERSONA_ENV.HEADLONG_OPERATOR_NAME,
    HEADLONG_IDENTITY_USER: process.env.HEADLONG_IDENTITY_USER || DEFAULT_PERSONA_ENV.HEADLONG_IDENTITY_USER,
  };
  const modelEnvBase = {
    SHELLM_MODEL: model,
    SHELLM_REQUIRE_DOCKER: process.env.SHELLM_REQUIRE_DOCKER || "1",
    HEADLONG_UNSANDBOXED: process.env.HEADLONG_UNSANDBOXED || "0",
    MONOLITH_BACKOFF_HOLD: process.env.MONOLITH_BACKOFF_HOLD || "1",
    SHELLM_MAX_ITERATIONS: process.env.SHELLM_MAX_ITERATIONS || "8",
    // Fake, deterministic — the replay proxy never forwards anywhere. NOT a
    // real credential; safe to keep here (never written to disk beyond this
    // process's own env passed to a child, never logged).
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "sk-replay-fake-key-not-real",
  };

  function sideBaseEnv(appDir, headlongHome, llmApiUrl) {
    const pathEnv = [path.join(appDir, "bin"), path.join(appDir, "tools"), process.env.PATH || ""].filter(Boolean).join(path.delimiter);
    return {
      ...process.env,
      ...personaEnv,
      ...modelEnvBase,
      ...proxyUrlEnv(llmApiUrl),
      HEADLONG_HOME: headlongHome,
      HEADLONG_APP_DIR: appDir,
      PATH: pathEnv,
    };
  }

  const origBase = sideBaseEnv(origAppDir, origHome, `http://127.0.0.1:${origPort}/v1/chat/completions`);
  const portBase = sideBaseEnv(portAppDir, portHome, `http://127.0.0.1:${portPort}/v1/chat/completions`);

  const identitiesRootOrig = path.join(origAppDir, ".identities");
  const identitiesRootPort = path.join(portAppDir, ".identities");
  const identityDirOrig = path.join(identitiesRootOrig, opts.identity);
  const identityDirPort = path.join(identitiesRootPort, opts.identity);

  process.stdout.write("run-replay: headlong-init on both sides (replayed persona call)...\n");
  const initEnv = (base) => ({ ...base, HEADLONG_NO_TTY: "1", HEADLONG_NO_DASH: "1", HEADLONG_NO_THINKERS: "1" });
  const origInit = headlongInit("orig", origAppDir, initEnv(origBase), []);
  const portInit = headlongInit("port", portAppDir, initEnv(portBase), []);
  const sideFailures = [];
  if (origInit.status !== 0) sideFailures.push(`orig: headlong-init exited ${origInit.status}: ${(origInit.stderr || "").slice(0, 4000)}`);
  if (portInit.status !== 0) sideFailures.push(`port: headlong-init exited ${portInit.status}: ${(portInit.stderr || "").slice(0, 4000)}`);
  if (sideFailures.length > 0) {
    for (const f of sideFailures) process.stderr.write(`run-replay: FAILED — ${f}\n`);
    stopProxy(origProxy.child);
    stopProxy(portProxy.child);
    return 1;
  }
  if (!fs.existsSync(path.join(identityDirOrig, "info.txt")) || !fs.existsSync(path.join(identityDirPort, "info.txt"))) {
    process.stderr.write(`run-replay: FAILED — identity was not created on one or both sides\n`);
    stopProxy(origProxy.child);
    stopProxy(portProxy.child);
    return 1;
  }

  const origEnv = buildBashIdentityEnv(identityDirOrig, origBase);
  const portEnv = await buildPortIdentityEnv(portAppDir, identityDirPort, portBase, portHome);

  let dockerBefore = [];
  try {
    dockerBefore = listShellmContainers(process.env);
  } catch {
    /* not reachable yet */
  }

  process.stdout.write("run-replay: starting thinkers on both sides...\n");
  const origStart = thinkersStart("orig", origAppDir, origEnv);
  const portStart = thinkersStart("port", portAppDir, portEnv);
  if (origStart.status !== 0 || portStart.status !== 0) {
    process.stderr.write(`run-replay: FAILED — thinkers start: orig=${origStart.status} port=${portStart.status}\n`);
    stopProxy(origProxy.child);
    stopProxy(portProxy.child);
    return 1;
  }
  const origLauncherPids = new Set([origStart.pid].filter((p) => p != null));
  const portLauncherPids = new Set([portStart.pid].filter((p) => p != null));

  const startTime = Date.now();
  for (const msg of scenario) {
    await sleepUntil(startTime + msg.atMinutes * 60_000);
    const from = msg.from || opts.operator;
    process.stdout.write(`run-replay: T+${msg.atMinutes}min — sending message (from=${from})...\n`);
    const origSend = chatSend("orig", origAppDir, origEnv, from, opts.identity, msg.text);
    const portSend = chatSend("port", portAppDir, portEnv, from, opts.identity, msg.text);
    if (origSend.status !== 0) process.stderr.write(`run-replay: orig chat send failed: ${origSend.stderr}\n`);
    if (portSend.status !== 0) process.stderr.write(`run-replay: port chat send failed: ${portSend.stderr}\n`);
  }

  await sleepUntil(startTime + opts.minutes * 60_000);

  process.stdout.write("run-replay: stopping both sides (drain)...\n");
  thinkersStop("orig", origAppDir, origEnv, false);
  thinkersStop("port", portAppDir, portEnv, false);
  const drainDeadlineMs = Number(process.env.THINKERS_DRAIN_TIMEOUT || 180) * 1000 + 10_000;
  const [origDrain, portDrain] = await Promise.all([
    pollUntilQuiet({ listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)), excludePids: origLauncherPids, deadlineMs: drainDeadlineMs }),
    pollUntilQuiet({ listProcesses: () => listProcessesUnder(portAppDir).filter((p) => isAlive(p.pid)), excludePids: portLauncherPids, deadlineMs: drainDeadlineMs }),
  ]);
  let origOrphansFinal = [];
  let portOrphansFinal = [];
  if (origDrain.remaining.length > 0 || portDrain.remaining.length > 0) {
    process.stdout.write("run-replay: lingering process(es) — forcing stop...\n");
    killOrphans(origDrain.remaining);
    killOrphans(portDrain.remaining);
    thinkersStop("orig", origAppDir, origEnv, true);
    thinkersStop("port", portAppDir, portEnv, true);
    const [origForce, portForce] = await Promise.all([
      pollUntilQuiet({ listProcesses: () => listProcessesUnder(origAppDir).filter((p) => isAlive(p.pid)), excludePids: origLauncherPids, deadlineMs: 20_000 }),
      pollUntilQuiet({ listProcesses: () => listProcessesUnder(portAppDir).filter((p) => isAlive(p.pid)), excludePids: portLauncherPids, deadlineMs: 20_000 }),
    ]);
    origOrphansFinal = origForce.remaining;
    portOrphansFinal = portForce.remaining;
    killOrphans(origOrphansFinal);
    killOrphans(portOrphansFinal);
  }

  let leakedContainers = [];
  try {
    const dockerAfter = listShellmContainers(process.env);
    const beforeIds = new Set(dockerBefore.map((c) => c.id));
    for (const c of dockerAfter.filter((c) => !beforeIds.has(c.id))) {
      const rm = spawnSync("docker", ["rm", "-f", c.id], { encoding: "utf8", env: process.env });
      if (rm.status !== 0) leakedContainers.push(`${c.name} (${c.id})`);
    }
  } catch {
    /* best effort */
  }

  // Stop proxies (SIGTERM -> they write stats to --stats-out and exit).
  stopProxy(origProxy.child);
  stopProxy(portProxy.child);
  await new Promise((r) => setTimeout(r, 500));

  const readJsonOrNull = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const tapeStats = { orig: readJsonOrNull(origStatsOut), port: readJsonOrNull(portStatsOut) };

  const origCapture = captureSide(identityDirOrig, opts.identity);
  const portCapture = captureSide(identityDirPort, opts.identity);

  // ---------------------------------------------------------------------
  // LOUD FAILURE GATE — a side's llm/shellm call bypassed the proxy and
  // hit a real provider directly (see lib.mjs's findEnvironmentLeaks doc
  // comment for exactly how this happened once already). A comparison
  // built on top of that is worse than no comparison: it silently reports
  // "divergences" that are actually just one side never having been
  // exercised at all. Check BEFORE spending any time on alignment.
  // ---------------------------------------------------------------------
  const envLeaks = [];
  for (const [side, capture] of [["orig", origCapture], ["port", portCapture]]) {
    for (const [file, text] of Object.entries(capture.perThinkerLogText ?? {})) {
      for (const leak of findEnvironmentLeaks(text)) envLeaks.push({ side, file, ...leak });
    }
  }
  if (envLeaks.length > 0) {
    process.stderr.write(`
run-replay: FAILED — ${envLeaks.length} sign(s) of a side bypassing the proxy and hitting a real provider directly:
`);
    for (const l of envLeaks) process.stderr.write(`  [${l.side}/${l.file}:${l.lineNumber}] ${l.reason}${l.host ? ` (${l.host})` : ""}: ${l.line}
`);
    process.stderr.write(`run-replay: refusing to render a comparison report on top of this — fix the env (both LLM_API_URL and SHELLM_API_URL must point at the proxy) and re-run.
`);
    fs.writeFileSync(path.join(scratchRoot, "env-leaks.json"), JSON.stringify(envLeaks, null, 2));
    return 1;
  }

  const origSteps = parseJsonl(origCapture.trajectoryText);
  const portSteps = parseJsonl(portCapture.trajectoryText);

  const alignment = alignSteps(origSteps, portSteps, {
    origScrubPaths: [origAppDir, origHome],
    portScrubPaths: [portAppDir, portHome],
  });
  const summary = summarizeAlignment(alignment);

  const docLookup = buildDocLookup(path.join(PORT_ROOT, "PARITY.md"));
  const classified = classifyAlignment(alignment, { docLookup });
  // Orphan processes/leaked containers are environment findings, not
  // trajectory-step divergences — added to the same classified list so the
  // report's bucket distribution covers all four PROOF-CAMPAIGN.md classes.
  if (origOrphansFinal.length > 0) classified.push({ index: -1, bucket: "environment", detail: `orig: ${origOrphansFinal.length} orphaned process(es) after stop` });
  if (portOrphansFinal.length > 0) classified.push({ index: -1, bucket: "environment", detail: `port: ${portOrphansFinal.length} orphaned process(es) after stop` });
  if (leakedContainers.length > 0) classified.push({ index: -1, bucket: "environment", detail: `${leakedContainers.length} leaked container(s): ${leakedContainers.join(", ")}` });
  for (const m of tapeStats.orig?.misses ?? []) classified.push({ index: -1, bucket: "environment", detail: `orig tape-miss: lane=${m.lane} index=${m.index}` });
  for (const m of tapeStats.port?.misses ?? []) classified.push({ index: -1, bucket: "environment", detail: `port tape-miss: lane=${m.lane} index=${m.index}` });

  const artifactDiffs = diffArtifactTrees({
    origRunDir: path.join(identityDirOrig, "run"),
    portRunDir: path.join(identityDirPort, "run"),
    origMemDir: origCapture.memoriesDir,
    portMemDir: portCapture.memoriesDir,
    origScrub: [origAppDir, origHome],
    portScrub: [portAppDir, portHome],
  });

  // dispatcher.log alignment (parsed via parity/live/lib.mjs, informational
  // — the trajectory alignment above is the authoritative structural
  // comparison; dispatcher-log event *counts* are reported for context.
  const origDispatcherEvents = parseDispatcherLog(origCapture.dispatcherLogText);
  const portDispatcherEvents = parseDispatcherLog(portCapture.dispatcherLogText);

  const meta = {
    identityName: opts.identity,
    minutes: opts.minutes,
    tape: opts.tape,
    tapeEntryCount: fs.readFileSync(opts.tape, "utf8").split("\n").filter((l) => l.trim()).length,
    model,
    startedAt: new Date(startTime).toISOString(),
    scratchRoot,
  };

  const report = renderReplayReport({ meta, summary, alignment, classified, tapeStats, artifactDiffs });
  fs.writeFileSync(path.join(scratchRoot, "report.md"), report);
  fs.writeFileSync(
    path.join(scratchRoot, "results.json"),
    JSON.stringify(
      {
        meta,
        summary,
        classified,
        tapeStats,
        artifactDiffs,
        orphanProcesses: { orig: origOrphansFinal.map((p) => `${p.pid}: ${p.command}`), port: portOrphansFinal.map((p) => `${p.pid}: ${p.command}`) },
        orphanContainers: leakedContainers,
        dispatcherEventCounts: { orig: origDispatcherEvents.length, port: portDispatcherEvents.length },
      },
      null,
      2
    )
  );

  process.stdout.write(`\nrun-replay: report written: ${path.join(scratchRoot, "report.md")}\n`);
  process.stdout.write(`run-replay: results written: ${path.join(scratchRoot, "results.json")}\n`);
  process.stdout.write(`run-replay: aligned ${summary.alignedSteps}/${summary.total} steps; ${classified.filter((c) => c.bucket === "PORT-BUG candidate").length} PORT-BUG candidate(s).\n`);
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
      process.stderr.write(`run-replay: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
