// uninstall-lib.ts — testable core of uninstall.mjs (faithful port of
// uninstall.sh @ 5458fee). uninstall.mjs (repo root) is the thin CLI wrapper.
//
// PORT-NOTEs (see PARITY.md "uninstall" for the full table):
//   - TOOLS/PATTERNS reused from install-lib.ts/status-lib.ts — this port's
//     actual inventory, not upstream's (see those files' own PORT-NOTEs).
//   - no ~/.skills/core-skills or ~/.headlong-thinkers removal: this port
//     never creates them (identity new bundles those from src/assets
//     directly — see install-lib.ts's header PORT-NOTE), so those checks
//     always find nothing, which is the correct behavior either way (same
//     conditional `if exists` shape as upstream, just never true here).
//   - process discovery/kill reuses status-lib.ts's PATTERNS/DASH_PATTERN
//     (this port's real process shapes) instead of a headlong-killall
//     dry-run/pgrep fallback — this port ships no standalone
//     headlong-killall-equivalent process-matching CLI beyond bin/
//     headlong-killall.mjs, which this module calls directly in-process.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCheckout } from "./init.ts";
import { TOOLS } from "./install-lib.ts";
import { PATTERNS, DASH_PATTERN } from "./status-lib.ts";

export interface UninstallIO {
  stdout(s: string): void;
  stderr(s: string): void;
  writeTty(s: string): void;
  readTtyLine(): Promise<string | undefined>;
  hasTTY(): boolean;
  listProcesses(): string[];
  selfPid(): number;
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
}

export class UninstallError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}
function die(msg: string): never {
  throw new UninstallError(msg);
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function findAppDir(headlongHome: string, cwd: string): string | undefined {
  const recorded = safeRead(path.join(headlongHome, "app_dir")).trim();
  if (recorded && isCheckout(recorded)) return recorded;
  const appSub = path.join(headlongHome, "app");
  if (isCheckout(appSub)) return appSub;
  if (isCheckout(cwd)) return cwd;
  return undefined;
}

/** The checkout is ours to delete only when install.mjs cloned it INTO the state home (the one-liner). */
export function appIsOurs(appDir: string | undefined, headlongHome: string): boolean {
  return Boolean(appDir) && (appDir === headlongHome || appDir!.startsWith(`${headlongHome}${path.sep}`));
}

export function identityRoot(appDir: string | undefined, headlongHome: string): string | undefined {
  if (!appIsOurs(appDir, headlongHome)) return undefined;
  const root = path.join(appDir!, ".identities");
  return fs.existsSync(root) ? root : undefined;
}

/** Prefix entries that are ours: a TOOLS name, or a symlink into appDir's bin/. */
export function ourPrefixEntries(prefix: string, appDir: string | undefined): string[] {
  if (!fs.existsSync(prefix)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(prefix)) {
    const full = path.join(prefix, name);
    if ((TOOLS as readonly string[]).includes(name)) {
      out.push(full);
      continue;
    }
    try {
      if (fs.lstatSync(full).isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const resolved = path.resolve(prefix, target);
        if (target.endsWith("/persona") || (appDir && resolved.startsWith(path.join(appDir, "bin") + path.sep))) out.push(full);
      }
    } catch {
      /* not accessible */
    }
  }
  return out;
}

const RC_CANDIDATES = [".zshrc", ".bashrc", ".bash_profile", ".profile"];

export function rcFilesWithPathLine(home: string, prefix: string): string[] {
  const line = `export PATH="${prefix}:$PATH"`;
  const out: string[] = [];
  for (const rc of RC_CANDIDATES) {
    const p = path.join(home, rc);
    if (!fs.existsSync(p)) continue;
    if (safeRead(p).split("\n").includes(line)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface ProcRow {
  pid: number;
  cmd: string;
}

export function listMatchingProcesses(io: UninstallIO): ProcRow[] {
  return io
    .listProcesses()
    .map((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), cmd: m[2]! } : undefined;
    })
    .filter((r): r is ProcRow => r !== undefined && r.pid !== io.selfPid())
    .filter((r) => [...PATTERNS, DASH_PATTERN].some((p) => p.test(r.cmd)))
    .sort((a, b) => a.pid - b.pid);
}

export async function killProcesses(rows: ProcRow[], io: UninstallIO): Promise<void> {
  for (const r of rows) io.kill(r.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const r of rows) {
    if (io.kill(r.pid, 0)) io.kill(r.pid, "SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ParsedUninstallArgs {
  yes: boolean;
  identities: "ask" | "keep" | "delete";
  dryRun: boolean;
  stop: boolean;
  prefix?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedUninstallArgs {
  const out: ParsedUninstallArgs = { yes: false, identities: "ask", dryRun: false, stop: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--keep-identities") out.identities = "keep";
    else if (a === "--delete-identities") out.identities = "delete";
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--no-stop") out.stop = false;
    else if (a === "--prefix") {
      const v = argv[++i];
      if (!v) die("--prefix requires a path");
      out.prefix = v;
    } else if (a === "-h" || a === "--help") out.help = true;
    else die(`Unknown option: ${a} (try --help)`);
  }
  if (out.yes && out.identities === "ask") out.identities = "keep";
  return out;
}

export const USAGE = `Usage: node uninstall.mjs [options]

Stops every running Headlong-TS process and removes what install.mjs put on
this machine. Your agent's identities (memories, trajectory) are moved to a
backup folder in your home directory unless you choose to delete them.

Options:
  --yes               Don't ask; stop processes and remove everything
                      (identities are still backed up unless --delete-identities)
  --keep-identities   Back up identities without asking (default when --yes)
  --delete-identities Delete identities too, no backup
  --dry-run           Show what would happen, change nothing
  --no-stop           Don't stop running processes, only remove files
  --prefix DIR        Where the tools were installed (default: ~/.local/bin)
  -h, --help          Show this help

Environment:
  HEADLONG_HOME       State directory (default: ~/.headlong)
  PREFIX              Same as --prefix
`;

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface RunUninstallOptions {
  argv: string[];
  env: Record<string, string>;
  io: UninstallIO;
  home: string;
  cwd: string;
  now(): Date;
}

export async function runUninstall(opts: RunUninstallOptions): Promise<number> {
  try {
    return await runUninstallInner(opts);
  } catch (err) {
    if (err instanceof UninstallError) {
      opts.io.stderr(`uninstall.mjs: error: ${err.message}\n`);
      return err.code;
    }
    opts.io.stderr(`uninstall.mjs: error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runUninstallInner(opts: RunUninstallOptions): Promise<number> {
  const { env, io } = opts;
  const args = parseArgs(opts.argv);
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

  const headlongHome = env["HEADLONG_HOME"] || path.join(opts.home, ".headlong");
  const prefix = args.prefix || env["PREFIX"] || path.join(opts.home, ".local", "bin");
  const appDir = findAppDir(headlongHome, opts.cwd);
  const idRoot = identityRoot(appDir, headlongHome);
  const entries = ourPrefixEntries(prefix, appDir);
  const rcs = rcFilesWithPathLine(opts.home, prefix);
  const procs = args.stop ? listMatchingProcesses(io) : [];

  const found = fs.existsSync(headlongHome) || entries.length > 0 || rcs.length > 0 || procs.length > 0;
  if (!found) {
    io.stdout(`Nothing to do: no Headlong-TS install found (looked in ${headlongHome}, ${prefix}).\n`);
    return 0;
  }

  const say = (s = "") => io.stdout(`${s}\n`);
  const head = (s: string) => io.stdout(`\n==> ${s}\n`);

  say();
  say(args.dryRun ? "Headlong-TS uninstall (dry run)" : "Headlong-TS uninstall");
  head("Running Headlong-TS processes");
  if (!args.stop) {
    say("  (not checked: --no-stop)");
  } else if (procs.length > 0) {
    for (const r of procs.slice(0, 6)) say(`  ${r.pid} ${r.cmd}`.slice(0, 100));
    if (procs.length > 6) say(`  ... and ${procs.length - 6} more`);
    say();
    say("  Full list:  node status.mjs");
  } else {
    say("  none");
  }

  if (procs.length > 0 && !args.dryRun) {
    if (!args.yes && !io.hasTTY()) die("no terminal to confirm on. Re-run with --yes to proceed without prompts (see --help).");
    say();
    if (await askYn(io, args.yes, `Stop these ${procs.length} process(es)?`, "n")) {
      head("Stopping processes");
      await killProcesses(procs, io);
      say("  done");
    } else {
      say();
      say("Leaving them running; nothing changed. Stop them yourself and re-run, or");
      say("pass --no-stop to remove the files anyway.");
      return 1;
    }
  }

  head("Will remove");
  if (appIsOurs(appDir, headlongHome)) {
    say(`  ${appDir}   (the checkout)`);
  } else if (appDir) {
    say(`  (your own checkout at ${appDir}, and the .identities inside it, stay in place)`);
  }
  if (fs.existsSync(headlongHome)) say(`  ${headlongHome}   (.env with your API key, logs, status)`);
  if (entries.length > 0) {
    say(`  ${entries.length} tool link(s)/copies in ${prefix}`);
    say(`    ${entries.map((e) => path.basename(e)).join(" ")}`);
  }
  if (rcs.length > 0) say(`  the PATH line for ${prefix} in: ${rcs.join(" ")}`);

  let backup: string | undefined;
  if (idRoot) {
    head("Your agent's identities (memories, trajectories)");
    say(`  ${idRoot}`);
    for (const name of fs.readdirSync(idRoot).sort()) {
      if (name === "default") continue;
      if (fs.statSync(path.join(idRoot, name)).isDirectory()) say(`    ${name}`);
    }
    if (args.identities === "delete") {
      say("  -> will be DELETED (--delete-identities)");
    } else if (args.identities === "keep") {
      backup = path.join(opts.home, `headlong-identities-backup-${timestamp(opts.now())}`);
      say(`  -> will be moved to ${backup}`);
    } else {
      say();
      if (await askYn(io, args.yes, "  Keep a backup of them in your home directory?", "y")) {
        backup = path.join(opts.home, `headlong-identities-backup-${timestamp(opts.now())}`);
        say(`  -> will be moved to ${backup}`);
      } else {
        say("  -> will be DELETED");
      }
    }
  }
  say();

  if (args.dryRun) {
    say("Dry run: nothing changed.");
    return 0;
  }
  if (!args.yes && !io.hasTTY()) die("no terminal to confirm on. Re-run with --yes to proceed without prompts (see --help).");
  if (!(await askYn(io, args.yes, "Remove everything listed?", "n"))) {
    say("Aborted; files left in place.");
    return 1;
  }

  if (idRoot && backup) {
    head("Backing up identities");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(idRoot, backup);
    say(`  ${backup}`);
  } else if (idRoot && args.identities === "delete") {
    fs.rmSync(idRoot, { recursive: true, force: true });
  }

  head("Removing files");
  for (const e of entries) fs.rmSync(e, { force: true });
  if (entries.length > 0) say(`  ${prefix}: ${entries.length} entries`);
  if (fs.existsSync(headlongHome)) {
    fs.rmSync(headlongHome, { recursive: true, force: true });
    say(`  ${headlongHome}`);
  }
  for (const rc of rcs) {
    const line = `export PATH="${prefix}:$PATH"`;
    const text = safeRead(rc)
      .split("\n")
      .filter((l) => l !== line)
      .join("\n");
    fs.writeFileSync(rc, text);
    say(`  PATH line removed from ${rc}`);
  }
  try {
    fs.rmdirSync(prefix);
  } catch {
    /* not empty, or gone already */
  }

  say();
  say("Headlong-TS is uninstalled.");
  say();
  if (backup) {
    say(`  Identities backed up to:  ${backup}`);
    say(`  Delete the backup later:  rm -rf '${backup}'`);
    say();
  }
  if (rcs.length > 0) say("  PATH changed: open a new terminal.");
  say("  Reinstall any time:  curl -fsSL <url>/install.mjs | node -");
  say();
  return 0;
}

async function askYn(io: UninstallIO, yes: boolean, prompt: string, def: "y" | "n"): Promise<boolean> {
  if (yes) return true;
  if (!io.hasTTY()) return def === "y";
  io.writeTty(def === "y" ? `${prompt} [Y/n] ` : `${prompt} [y/N] `);
  const reply = (await io.readTtyLine()) ?? "";
  const r = reply || def;
  return /^[Yy]/.test(r);
}
