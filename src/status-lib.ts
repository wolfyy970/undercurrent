// status-lib.ts — testable core of status.mjs (faithful port of status.sh
// @ 5458fee). Read-only: prints and returns. No prompts, no mutation, no
// network (beyond none — this port needs neither jq nor curl).
//
// PORT-NOTEs (see PARITY.md "status" for the full table):
//   - PATTERNS lists the process shapes THIS PORT actually spawns, not
//     upstream's Bash shapes: `node .../bin/dispatcherd.mjs` (the
//     dispatcher; upstream has no direct equivalent name), `node
//     .../thinkers/<name>/step` (a thinker step — upstream's is a Bash
//     script under the same path, so the shape carries over structurally),
//     and `node .../web/scripts/dev.mjs` (the dash; upstream's is `uv run
//     ... headlong-web`). Upstream's `bin/traj tail` and `tail -F
//     trajectory.jsonl` patterns have NO subprocess counterpart here: the
//     daemon's TrajFeeder (src/daemon.ts) tails the trajectory file
//     in-process via fs.watch — see PORTING.md's "feeder ... in-process
//     replacement" note.
//   - process listing uses `ps -eo pid=,command=` (no `pgrep` dependency).
//   - TOOLS/identity discovery reuse the same `bin/identity.mjs` checkout
//     marker as init.mjs/install.mjs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isCheckout } from "./init.ts";
import { TOOLS } from "./install-lib.ts";

export interface StatusIO {
  stdout(s: string): void;
  now(): Date;
  hostname(): string;
  /** `ps -eo pid=,command=` output, one "PID COMMAND" line per process. Overridable for tests. */
  listProcesses(): string[];
  /** This process's own pid, excluded from process listings (matches bash's `grep -v " $$ "`). */
  selfPid(): number;
}

export const PATTERNS = [/node\s+\S*\/bin\/dispatcherd\.mjs(\s|$)/, /node\s+\S*\/thinkers\/[^/\s]+\/step(\s|$)/];
export const DASH_PATTERN = /node\s+\S*\/web\/scripts\/dev\.mjs(\s|$)/;

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findAppDir(env: Record<string, string>, headlongHome: string, cwd: string): string | undefined {
  const recorded = safeRead(path.join(headlongHome, "app_dir")).trim();
  if (recorded && isCheckout(recorded)) return recorded;
  const appSub = path.join(headlongHome, "app");
  if (isCheckout(appSub)) return appSub;
  if (isCheckout(cwd)) return cwd;
  void env;
  return undefined;
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function readPid(p: string): number | undefined {
  const n = Number(safeRead(p).trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readEnvValue(envText: string, key: string): string | undefined {
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(envText);
  if (!m) return undefined;
  return m[1]!.replace(/^'(.*)'$/, "$1");
}

function cmdFor(prefix: string, name: string): string {
  const link = path.join(prefix, name);
  try {
    if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link).endsWith("/persona")) return name;
  } catch {
    /* not linked */
  }
  return `persona ${name}`;
}

export function realStatusIO(): StatusIO {
  return {
    stdout: (s) => process.stdout.write(s),
    now: () => new Date(),
    hostname: () => {
      try {
        return os.hostname();
      } catch {
        return "";
      }
    },
    listProcesses: () => {
      const r = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
      return (r.stdout || "").split("\n").filter((l) => l.trim());
    },
    selfPid: () => process.pid,
  };
}

export function runStatus(env: Record<string, string>, io: StatusIO, cwd: string): number {
  const headlongHome = env["HEADLONG_HOME"] || path.join(env["HOME"] || "", ".headlong");
  const prefix = env["PREFIX"] || path.join(env["HOME"] || "", ".local", "bin");

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  const head = (s: string) => lines.push(`\n==> ${s}`);

  say();
  say(`Headlong status — ${io.now().toLocaleString()} on ${io.hostname()}`);
  head("Install");
  const appDir = findAppDir(env, headlongHome, cwd);
  if (!appDir && !fs.existsSync(headlongHome)) {
    say(`  not installed (no ${headlongHome}, no checkout found)`);
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  }

  let onPath = true;
  let bin = "";
  if (appDir) {
    const commit = tryGit(appDir, ["rev-parse", "--short", "HEAD"]) || "?";
    const dirty = (tryGit(appDir, ["status", "--short"]) || "").split("\n").filter((l) => l.trim()).length;
    const edits = dirty > 0 ? `, ${dirty} local edit(s)` : "";
    say(`  checkout:   ${appDir}   (commit ${commit}${edits})`);
  } else {
    say("  checkout:   not found");
  }
  if (fs.existsSync(headlongHome)) {
    const envText = safeRead(path.join(headlongHome, ".env"));
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"].filter((k) => new RegExp(`^${k}=`, "m").test(envText));
    const model = readEnvValue(envText, "SHELLM_MODEL");
    say(`  state home: ${headlongHome}   (.env has:${keys.length ? ` ${keys.join(" ")}` : " no API key"}${model ? `; model ${model}` : ""})`);
  } else {
    say(`  state home: ${headlongHome}   (missing)`);
  }
  let n = 0;
  const personaLinks: string[] = [];
  for (const t of TOOLS) {
    try {
      fs.lstatSync(path.join(prefix, t));
      n += 1;
    } catch {
      /* not installed */
    }
  }
  try {
    for (const f of fs.readdirSync(prefix)) {
      const full = path.join(prefix, f);
      try {
        if (fs.lstatSync(full).isSymbolicLink() && fs.readlinkSync(full).endsWith("/persona") && f !== "persona") personaLinks.push(f);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* prefix doesn't exist */
  }
  say(`  tools:      ${n} of ${TOOLS.length} in ${prefix}${personaLinks.length ? `; agent commands:${personaLinks.map((p) => ` ${p}`).join("")}` : ""}`);
  const pathParts = (env["PATH"] ?? "").split(path.delimiter);
  onPath = pathParts.includes(prefix);
  say(`  PATH:       ${onPath ? `${prefix} is on PATH` : `${prefix} is NOT on PATH in this shell`}`);
  if (!onPath) {
    if (fs.existsSync(path.join(prefix, "persona"))) bin = `${prefix}/`;
    else if (appDir && fs.existsSync(path.join(appDir, "bin", "persona"))) bin = `${appDir}/bin/`;
  }

  // --- identities ---------------------------------------------------------
  const identityNames: string[] = [];
  let defaultName = "";
  if (appDir && fs.existsSync(path.join(appDir, ".identities"))) {
    head(`Identities  (${path.join(appDir, ".identities")})`);
    const idRoot = path.join(appDir, ".identities");
    try {
      defaultName = path.basename(fs.readlinkSync(path.join(idRoot, "default")));
    } catch {
      /* no default */
    }
    let found = false;
    for (const name of fs.readdirSync(idRoot).sort()) {
      if (name === "default") continue;
      const d = path.join(idRoot, name);
      if (!fs.statSync(d).isDirectory()) continue;
      found = true;
      identityNames.push(name);
      const pid = readPid(path.join(d, "run", "dispatcher.pid"));
      const mind = alive(pid) ? `mind running (dispatcher pid ${pid})` : "mind stopped";
      const tag = name === defaultName ? " (default)" : "";
      say(`  ${name}${tag}: ${mind}`);
    }
    if (!found) say("  none");
  }

  // --- dash -----------------------------------------------------------------
  head("Dash");
  const wpid = readPid(path.join(headlongHome, "run", "web.pid"));
  if (alive(wpid)) {
    const log = safeRead(path.join(headlongHome, "logs", "web.log"));
    const m = /\[dev\] viewer\s*:\s*(http:\/\/\S+)/.exec(log);
    say(`  running (pid ${wpid})${m ? ` at ${m[1]}` : ""}`);
  } else {
    say("  stopped");
  }

  // --- processes --------------------------------------------------------------
  head("Headlong-TS processes on this machine");
  const procLines = io
    .listProcesses()
    .map((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), cmd: m[2]! } : undefined;
    })
    .filter((r): r is { pid: number; cmd: string } => r !== undefined && r.pid !== io.selfPid())
    .filter((r) => [...PATTERNS, DASH_PATTERN].some((p) => p.test(r.cmd)))
    .sort((a, b) => a.pid - b.pid);
  if (procLines.length) {
    for (const r of procLines) say(`  ${r.pid} ${r.cmd}`.slice(0, 110));
    say();
    say(`  ${procLines.length} process(es).`);
  } else {
    say("  none");
  }

  // --- commands -----------------------------------------------------------
  head("Commands (for this shell)");
  if (!onPath && fs.existsSync(path.join(prefix, "persona"))) {
    say(`  ${prefix} is not on PATH here, so these use full paths. To fix:`);
    say(`    export PATH="${prefix}:$PATH"`);
    say();
  }
  const mainId = identityNames.find((n) => n === defaultName) ?? identityNames[0];
  const others = identityNames.filter((n) => n !== mainId);
  if (mainId) {
    const c = cmdFor(bin || prefix, mainId);
    const row = (label: string, val: string) => say(`  ${label.padEnd(20)} ${val}`);
    row("pause " + mainId + ":", `${c} stop`);
    row("resume " + mainId + ":", `${c} start`);
    row("chat with " + mainId + ":", `${c}      (one-shot: ${c} "hello there")`);
    row("bug report bundle:", `${c} bugreport`);
    if (others.length) row("other identities:", `${bin}persona <name> stop|start|bugreport   for: ${others.join(" ")}`);
  }
  say(`  ${"uninstall:".padEnd(20)} curl -fsSL <url>/uninstall.mjs | node -`);
  say();

  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function tryGit(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}
