// parity/replay/harness.mjs — impure orchestration helpers shared by
// record.mjs (one real upstream session) and run-replay.mjs (both sides,
// pointed at replay proxies). Adapted from parity/live/run-sxs.mjs's own
// per-side setup (checkout copy, identity creation, thinker start/stop,
// chat send/history, orphan detection) — NOT an edit of that file (harness-
// only scope; run-sxs.mjs is untouched), just the same technique reused for
// a second harness that needs it. Pure helpers (filterOrphans,
// pollUntilQuiet) are imported straight from run-sxs.mjs rather than
// duplicated.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export { filterOrphans, pollUntilQuiet } from "../live/run-sxs.mjs";

export function readFileOrEmpty(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function sizeOrZero(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function readInfoField(identityDir, key) {
  const text = readFileOrEmpty(path.join(identityDir, "info.txt"));
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

/** `<trajDir>/<hex8>-root/trajectory.jsonl` — SPEC §2.1 / src/trajCore.mjs's rootTrajFile, same on both sides. */
export function rootTrajFile(trajDir, trajId) {
  const hex8 = String(trajId).slice(0, 8);
  return path.join(trajDir, `${hex8}-root`, "trajectory.jsonl");
}

/** `cp -R -c` (APFS clonefile) falling back to plain `cp -R`. Never spawns a shell. */
export function copyTree(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`copyTree: source does not exist: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const clone = spawnSync("cp", ["-R", "-c", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
  if (clone.status !== 0) {
    const plain = spawnSync("cp", ["-R", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
    if (plain.status !== 0) {
      throw new Error(
        `copyTree: cp failed for ${src} -> ${dest}: ${plain.stderr?.toString() ?? clone.stderr?.toString() ?? ""}`
      );
    }
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sleepMs(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export async function sleepUntil(targetMs) {
  await sleepMs(targetMs - Date.now());
}

// ---------------------------------------------------------------------------
// identity env (bash side: replicate `source .identities/<name>/activate`
// without sourcing bash — same technique as run-sxs.mjs's
// buildBashIdentityEnv; port side: dynamic-import the scratch copy's own
// src/identity-env.ts, same as run-sxs.mjs's buildPortIdentityEnv).
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
    into[m[1]] = val;
  }
}

export function buildBashIdentityEnv(identityDir, base) {
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

/** Dynamic-imports the SCRATCH COPY's own src/identity-env.ts so PORT_BIN/PORT_HOME resolve to the copy under test. */
export async function buildPortIdentityEnv(portAppDir, identityDir, base, headlongHome) {
  const mod = await import(pathToFileURL(path.join(portAppDir, "src", "identity-env.ts")).href);
  return mod.resolveIdentityEnv(identityDir, { base, headlongHome });
}

// ---------------------------------------------------------------------------
// per-side process helpers
// ---------------------------------------------------------------------------

export function runOrig(appDir, relBin, args, env, opts = {}) {
  return spawnSync(path.join(appDir, relBin), args, { cwd: appDir, env, encoding: "utf8", timeout: opts.timeout });
}

export function runPort(appDir, relBin, args, env, opts = {}) {
  return spawnSync(process.execPath, [path.join(appDir, relBin), ...args], { cwd: appDir, env, encoding: "utf8", timeout: opts.timeout });
}

export function headlongInit(side, appDir, env, extraArgs) {
  return side === "orig" ? runOrig(appDir, "tools/headlong-init", extraArgs, env) : runPort(appDir, "bin/headlong-init.mjs", extraArgs, env);
}

export function identityNewCli(side, appDir, env, name) {
  return side === "orig" ? runOrig(appDir, "tools/identity", ["new", "--default", name], env) : runPort(appDir, "bin/identity.mjs", ["new", "--default", name], env);
}

export function thinkersStart(side, appDir, env) {
  return side === "orig" ? runOrig(appDir, "bin/thinkers", ["start"], env, { timeout: 30_000 }) : runPort(appDir, "bin/thinkers.mjs", ["start"], env, { timeout: 30_000 });
}

export function thinkersStop(side, appDir, env, force) {
  const args = force ? ["stop", "--force"] : ["stop"];
  return side === "orig" ? runOrig(appDir, "bin/thinkers", args, env, { timeout: 200_000 }) : runPort(appDir, "bin/thinkers.mjs", args, env, { timeout: 200_000 });
}

export function chatSend(side, appDir, env, from, to, text) {
  return side === "orig" ? runOrig(appDir, "bin/chat", ["send", "--from", from, "--to", to, text], env) : runPort(appDir, "bin/chat.mjs", ["send", "--from", from, "--to", to, text], env);
}

export function chatHistory(side, appDir, env, withName) {
  return side === "orig" ? runOrig(appDir, "bin/chat", ["history", "--with", withName, "--json"], env) : runPort(appDir, "bin/chat.mjs", ["history", "--with", withName, "--json"], env);
}

// ---------------------------------------------------------------------------
// process / container orphan detection (same technique as run-sxs.mjs)
// ---------------------------------------------------------------------------

export function listProcessesUnder(rootPath) {
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

export function listShellmContainers(env) {
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

export function killOrphans(procs) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Shared default scenario for record.mjs (recording, one side) and
 * run-replay.mjs (comparison, both sides) — kept identical so the replay
 * conversation matches what was actually recorded (SIDE-BY-SIDE.md-style
 * persona; see parity/live/run-sxs.mjs's own DEFAULT_MESSAGES, which this
 * mirrors independently rather than importing, since run-sxs.mjs doesn't
 * export it and this file must not edit that one).
 */
export const DEFAULT_SCENARIO = [
  {
    atMinutes: 0,
    text:
      "Hi, I'm JO. Remember: my favourite colour is teal and I run a small design consultancy in the UK. " +
      "Then, on your own over the next while, research and write me a short note (5 bullets) on what makes " +
      "a good design-system changelog, and save it as a memory.",
  },
  { atMinutes: 3, text: "Quick check — what's my favourite colour?" },
  { atMinutes: 7, text: "Thanks. Anything you've done on your own since we last spoke?" },
];

/**
 * Env vars that point BOTH engines' real LLM calls at a local proxy URL.
 * Setting LLM_API_URL alone is not enough: upstream bin/shellm:73-77
 * unconditionally `unset`s any inherited LLM_API_URL and only re-exports it
 * from SHELLM_API_URL (a deliberate "llm uses per-provider defaults unless
 * shellm was explicitly told otherwise" design) — so a monolith wake (which
 * runs through bin/shellm) silently bypasses a proxy that only set
 * LLM_API_URL, hits the REAL provider with whatever key is in scope, and
 * (with a fake replay key) dies at iteration 1 with an auth error. The
 * responder's `llm` calls (thinkers/responder/step) do NOT go through
 * bin/shellm and were never affected — which is why this only ever showed
 * up as "monolith" doing something different from every other lane, not as
 * an outright failure the harness would have caught on its own. #39
 * changed the PORT's OpenRouterClient (src/steprun.ts buildLlmClient) to
 * read LLM_API_URL only (no more SHELLM_API_URL fallback there) — set BOTH
 * vars on BOTH sides so this can't silently drift out of sync again either
 * way.
 */
export function proxyUrlEnv(url) {
  return { LLM_API_URL: url, SHELLM_API_URL: url };
}

export const DEFAULT_PERSONA_ENV = {
  HEADLONG_IDENTITY_VIBE: "steady, curious, plainspoken, a careful listener",
  HEADLONG_IDENTITY_FOCUS: "design systems, changelogs, and how design tooling documents its own history",
  HEADLONG_OPERATOR_NAME: "JO",
  HEADLONG_IDENTITY_USER: "JO runs a small design consultancy in the UK",
};

export function timestampSlug(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
}

/**
 * Poll `pgrep -f pattern` until it reports nothing or `deadlineMs` elapses.
 * Used to defer real (costed / CPU-heavy) runs until sibling lanes
 * (run-sxs, run-fuzz) currently sharing the machine are quiet — see
 * run-replay.mjs's --wait-quiet.
 */
export async function waitForQuiet({ pattern, deadlineMs, intervalMs = 5000, log = () => {} }) {
  const start = Date.now();
  for (;;) {
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    const pids = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (pids.length === 0) return { quiet: true, waitedMs: Date.now() - start };
    if (Date.now() - start >= deadlineMs) return { quiet: false, waitedMs: Date.now() - start, pids };
    log(`waiting for quiet — pattern "${pattern}" matches pid(s) ${pids.join(",")}\n`);
    await sleepMs(intervalMs);
  }
}
