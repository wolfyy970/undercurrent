// killall.ts — panic button: kill every Headlong-related process (PLAN-daemon
// SPEC-control-plane §D.4). Faithful port of headlong/tools/headlong-killall
// (162 lines Bash), adapted to the TS port's process shapes (a Node daemon +
// per-wake Node child processes instead of Bash agent loops) — see
// tools/README.md / control.py for the binary name (`headlong-killall`; the
// web control layer shells out to `<repo>/tools/headlong-killall`).
//
// Targets (by exact argv patterns matched against each process's full command
// line — an argv TOKEN match, not a loose substring grep, so an editor, a
// grep, or a shell merely mentioning these paths is never touched):
//   - dispatcher daemons:    …/bin/dispatcherd.mjs        (src/daemon.ts)
//   - thinker step wrappers: …/thinkers/<name>/step        (spawned by the
//     daemon per wake — a Node file that itself execs bin/thinker-step.mjs;
//     see src/assets/thinkers/*/step)
//   - the actual step logic: …/bin/thinker-step.mjs         (nested child of
//     the wrapper above — matched directly too, for robustness, though
//     descendant-tree expansion already sweeps it in)
//   - the `chat` CLI tool: …/bin/chat.mjs (the `sub` pattern is retired along
//     with the `sub` tool — PORT-NOTE (1c: 12ca841) below)
//   - per-identity persistent docker containers named `shellm-<env>-<hash>`
//     (src/sandbox-runtime.ts/sandbox-env.ts — bug #32; the name changed from
//     the old per-step `shellm-<pid>` when containers became reused across
//     wakes instead of one-per-step, but the `^shellm-` filter below, taken
//     straight from upstream, still matches either shape unchanged)
//   - the headlong-web dash (only with --web)
//
// Matched processes are killed with their full descendant trees (fixed-point
// ppid expansion over one `ps` snapshot), TERM first, KILL after a grace
// period. Broker containers (label `shellm.broker=1`) are reported, never
// touched. Self + every ancestor of this process is protected, so running
// killall from inside a thinker step never cuts the branch it's sitting on.
//
// PORT-NOTE — two upstream patterns have no TS-port equivalent and are
// intentionally NOT ported (see PARITY.md): upstream's `bin/traj tail`/
// `tail -n 0 -F …/trajectory.jsonl` reap a long-running Bash `tail -F`
// follower process; this port's daemon feeder (src/feeder.ts) uses
// `fs.watch` IN-PROCESS (no subprocess), and this port's `bin/traj.mjs tail`
// is a synchronous one-shot (prints N lines and exits) — there is no
// orphaned follower process of either kind to reap.
//
// STREAM CONTRACT (byte-for-byte against the Bash — verified against the
// actual source, not assumed): only `usage()`'s help/error text and the
// protected-ancestor warning go to STDERR. Every other line — the "No
// matching processes found." / "Would kill N…" / "Killing N…" report, the
// per-pid `ps` listing, "Force-killing N survivor(s)", the docker
// would-remove/removing/broker-note sections, and the final "(dry run —
// nothing was killed)" — goes to STDOUT (tools/headlong-killall has no
// `>&2` on any of those lines).

import { spawnSync } from "node:child_process";
import { pidAlive } from "./runstate.ts";

export interface KillallIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface KillallOptions extends Partial<KillallIO> {
  dryRun?: boolean;
  web?: boolean;
  /**
   * Injectable process-table source, defaulting to a real system-wide `ps`
   * snapshot. TESTS MUST OVERRIDE THIS: killall is deliberately system-wide
   * (a panic button has to see every matching process on the machine, not
   * just ones this call spawned), so exercising the real default against a
   * shared dev machine risks matching and killing an unrelated live
   * process — e.g. another agent's own dispatcherd under test. Pass a
   * snapshot restricted to known-owned decoy pids instead (see
   * test/killall.test.ts).
   */
  psSnapshot?: () => ProcEntry[];
  /**
   * Injectable docker-container source, defaulting to a real `docker ps`
   * scan. TESTS MUST OVERRIDE THIS: killall's docker cleanup is deliberately
   * system-wide (name=^shellm- / label=shellm.broker=1 span every container
   * on the host, not just ones this call spawned), so the real default
   * against a shared dev machine picks up unrelated live `shellm-*`
   * containers (e.g. another agent's sandbox under test) and pollutes the
   * scoped-to-empty-pids report. Pass a fixture listing instead (see
   * test/killall.test.ts).
   */
  dockerListing?: () => DockerListing;
}

/** Real `docker ps` scan, scoped by the same two filters upstream uses. */
export interface DockerListing {
  /** Container ids matching `name=^shellm-` (for `docker rm -f`). */
  shellmIds: string[];
  /** Pre-formatted "  {{.Names}} ({{.Status}})" lines for `name=^shellm-` containers. */
  shellmLines: string[];
  /** Pre-formatted "  {{.Names}} ({{.Status}})" lines for `label=shellm.broker=1` containers. */
  brokerLines: string[];
}

export interface KilledProc {
  pid: number;
  command: string;
}

export interface KillallResult {
  ok: true;
  killed: KilledProc[];
  dryRun: boolean;
}

/** Thrown by usageDie to unwind with an exit code (mirrors similar *Exit classes elsewhere in this port, e.g. src/chat.ts's ChatExit, src/mem.ts's MemExit). */
class KillallExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const USAGE =
  `Usage: headlong-killall [-n|--dry-run] [--web]\n` +
  `\n` +
  `  -n, --dry-run   List what would be killed, kill nothing\n` +
  `  --web           Also kill the headlong-web dash\n` +
  `  -h, --help      Show this help\n`;

// ---------------------------------------------------------------------------
// Argv patterns — token-boundary matches against each process's full command
// line. `\S*` before the anchor path lets the interpreter (`node`, a shebang-
// resolved absolute node path, …) and any directory prefix vary; `(\s|$)`
// after it ensures the match ends at an argv boundary, not mid-path.
// ---------------------------------------------------------------------------

interface Pattern {
  label: string;
  re: RegExp;
}

// PORT-NOTE (1c: 12ca841): the "sub.mjs" pattern is retired along with the
// `sub` tool — upstream's own PATTERNS regex group drops `sub` from
// `(shellm|shellm-explore|llm|chat|sub)` to `(shellm|shellm-explore|llm|chat)`
// (install.sh/status.sh/uninstall.sh/tools/headlong-killall all follow suit).
const PATTERNS: Pattern[] = [
  { label: "dispatcherd", re: /(^|\s)\S*\/bin\/dispatcherd\.mjs(\s|$)/ },
  { label: "thinker-step-wrapper", re: /(^|\s)\S*\/thinkers\/[^/\s]+\/step(\s|$)/ },
  { label: "thinker-step.mjs", re: /(^|\s)\S*\/bin\/thinker-step\.mjs(\s|$)/ },
  { label: "chat.mjs", re: /(^|\s)\S*\/bin\/chat\.mjs(\s|$)/ },
];

/** `--web`: also the headlong-web dash (a Node server, PLAN-daemon web/server). */
const WEB_PATTERN: Pattern = { label: "headlong-web", re: /(^|\s)\S*\/web\/server\/src\/index\.ts(\s|$)/ };

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------

export interface ProcEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** One `ps -axo pid=,ppid=,command=` snapshot (bin/thinkers' own killTree takes the same approach). */
function psSnapshot(): ProcEntry[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const out: ProcEntry[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
  }
  return out;
}

/** Walk this process's ppid chain (bin/tools/headlong-killall:60-66). */
function protectedPids(self: number): Set<number> {
  const protectedSet = new Set<number>([self]);
  let pid = self;
  for (let i = 0; i < 4096; i++) {
    const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const next = parseInt((r.stdout ?? "").trim(), 10);
    if (!Number.isFinite(next) || next <= 0 || next === 1) break;
    protectedSet.add(next);
    pid = next;
  }
  return protectedSet;
}

function psLine(pid: number): string | undefined {
  const r = spawnSync("ps", ["-o", "pid=,command=", "-p", String(pid)], { encoding: "utf8" });
  const line = (r.stdout ?? "").split("\n").find((l) => l.trim() !== "");
  return line ? line : undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hasCommand(name: string): boolean {
  const r = spawnSync("command", ["-v", name], { shell: "/bin/sh" });
  if (r.status === 0) return true;
  // Fallback for shells without a `command` builtin reachable this way.
  const which = spawnSync("which", [name]);
  return which.status === 0;
}

function dockerPsFilterFormatted(filter: string): string[] {
  const r = spawnSync("docker", ["ps", "--filter", filter, "--format", "  {{.Names}} ({{.Status}})"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "").split("\n").filter((l) => l.trim() !== "");
}

/** `docker ps --format` template that drops broker containers (label shellm.broker=1) itself. */
export const NON_BROKER_FORMAT = '{{if ne (.Label "shellm.broker") "1"}}{{.ID}}\\t{{.Names}} ({{.Status}}){{end}}';

/**
 * PORT-NOTE (sync 2e39a3f, tools/headlong-killall): `docker ps` only has POSITIVE label filters, so
 * upstream now excludes brokers inside the --format template and reuses ONE snapshot for both the
 * listing and the removal (the old code ran `docker ps` twice, so a container could appear between
 * the two, and it would `rm -f` brokers whose name starts `shellm-`). Rows are `<id>\t<names (status)>`;
 * broker rows render empty. ids = awk `NF {print $1}` (first whitespace field of each non-blank
 * row); lines = awk `NF {sub(/^[^\t]*\t/, "  "); print}`.
 */
export function parseNonBrokerRows(rows: string): { ids: string[]; lines: string[] } {
  const ids: string[] = [];
  const lines: string[] = [];
  for (const row of rows.split("\n")) {
    if (row.trim() === "") continue; // awk NF == 0
    ids.push(row.trim().split(/\s+/)[0]!);
    lines.push(row.replace(/^[^\t]*\t/, "  "));
  }
  return { ids, lines };
}

/** Real, system-wide docker scan (default `dockerListing` seam — see KillallOptions). */
function dockerListing(): DockerListing {
  const r = spawnSync("docker", ["ps", "--filter", "name=^shellm-", "--format", NON_BROKER_FORMAT], {
    encoding: "utf8",
  });
  // `|| container_rows=""`: a failing docker ps means an empty snapshot.
  const rows = r.status === 0 ? (r.stdout ?? "") : "";
  const { ids, lines } = parseNonBrokerRows(rows);
  return {
    shellmIds: ids,
    shellmLines: lines,
    brokerLines: dockerPsFilterFormatted("label=shellm.broker=1"),
  };
}

// ---------------------------------------------------------------------------
// Argument parsing — faithful to the Bash while/case loop (headlong-killall:32-39).
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  dryRun: boolean;
  web: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], io: KillallIO): ParsedArgs {
  let dryRun = false;
  let web = false;
  for (const a of argv) {
    if (a === "-n" || a === "--dry-run") dryRun = true;
    else if (a === "--web") web = true;
    else if (a === "-h" || a === "--help") {
      io.stderr(USAGE);
      throw new KillallExit(0);
    } else {
      io.stderr(`Unknown option: ${a}\n`);
      io.stderr(USAGE);
      throw new KillallExit(1);
    }
  }
  return { dryRun, web, help: false };
}

// ---------------------------------------------------------------------------
// Core (library-callable): does the scan/report/kill, returns the result.
// Produces the exact human-readable text (matching the real Bash tool) as a
// SIDE EFFECT via the io callbacks — that text, not a JSON blob, is this
// port's byte-for-byte contract (task deliverable #2, "exact output lines").
// A future web control layer that wants a machine-readable shape can call
// this function directly and use the returned KillallResult, rather than
// parsing killall's human stdout as JSON.
// ---------------------------------------------------------------------------

export async function killall(opts: KillallOptions = {}): Promise<KillallResult> {
  const stdout = opts.stdout ?? (() => {});
  const stderr = opts.stderr ?? (() => {});
  const dryRun = opts.dryRun ?? false;
  const web = opts.web ?? false;
  const takeSnapshot = opts.psSnapshot ?? psSnapshot;
  const takeDockerListing = opts.dockerListing ?? dockerListing;

  const self = process.pid;
  const protectedSet = protectedPids(self);
  const patterns = web ? [...PATTERNS, WEB_PATTERN] : PATTERNS;

  const snapshot = takeSnapshot();
  const byPpid = new Map<number, ProcEntry[]>();
  for (const p of snapshot) {
    const arr = byPpid.get(p.ppid) ?? [];
    arr.push(p);
    byPpid.set(p.ppid, arr);
  }

  // Phase 1: direct pattern matches (bin/tools/headlong-killall:73-83).
  const matched = new Set<number>();
  for (const pat of patterns) {
    for (const p of snapshot) {
      if (!pat.re.test(p.command)) continue;
      if (protectedSet.has(p.pid)) {
        stderr(`warning: skipping PID ${p.pid} (ancestor of this process — are you running inside a thinker step?)\n`);
        continue;
      }
      matched.add(p.pid);
    }
  }

  // Phase 2: expand to full descendant trees, fixed point (headlong-killall:85-100).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [ppid, children] of byPpid) {
      if (!matched.has(ppid)) continue;
      for (const c of children) {
        if (matched.has(c.pid) || protectedSet.has(c.pid)) continue;
        matched.add(c.pid);
        changed = true;
      }
    }
  }

  const pids = [...matched];

  // Report (STDOUT — see the header note; upstream has no `>&2` here).
  if (pids.length === 0) {
    stdout("No matching processes found.\n");
  } else {
    stdout(dryRun ? `Would kill ${pids.length} process(es):\n` : `Killing ${pids.length} process(es):\n`);
    for (const pid of pids) {
      const line = psLine(pid);
      if (line) stdout(`  ${line}\n`);
    }
  }

  const killedList: KilledProc[] = pids.map((pid) => {
    const cmd = snapshot.find((p) => p.pid === pid)?.command ?? "";
    return { pid, command: cmd };
  });

  if (!dryRun && pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    let survivors: number[] = [];
    for (let i = 0; i < 6; i++) {
      survivors = pids.filter((p) => pidAlive(p));
      if (survivors.length === 0) break;
      await sleep(500);
    }
    if (survivors.length > 0) {
      stdout(`Force-killing ${survivors.length} survivor(s)\n`);
      for (const pid of survivors) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  // Per-run docker containers (shellm-<pid>); broker containers reported, never touched. An injected listing (the
  // test seam) stands in for the docker CLI, so it is used even on a host without docker installed.
  if (opts.dockerListing || hasCommand("docker")) {
    const listing = takeDockerListing();
    if (listing.shellmIds.length > 0) {
      if (dryRun) {
        stdout("Would remove docker container(s):\n");
        for (const l of listing.shellmLines) stdout(`${l}\n`);
      } else {
        stdout("Removing docker container(s):\n");
        for (const l of listing.shellmLines) stdout(`${l}\n`);
        spawnSync("docker", ["rm", "-f", ...listing.shellmIds]);
      }
    }
    if (listing.brokerLines.length > 0) {
      stdout("Note: broker container(s) left running (persistent; stop via shellm-docker-broker):\n");
      for (const l of listing.brokerLines) stdout(`${l}\n`);
    }
  }

  if (dryRun) stdout("(dry run — nothing was killed)\n");

  return { ok: true, killed: dryRun ? [] : killedList, dryRun };
}

// ---------------------------------------------------------------------------
// CLI entry point — argument parsing + exit code, for bin/killall.mjs.
// ---------------------------------------------------------------------------

export async function runKillall(argv: string[], opts: Partial<KillallIO> = {}): Promise<number> {
  const stdout = opts.stdout ?? (() => {});
  const stderr = opts.stderr ?? (() => {});
  const io: KillallIO = { stdout, stderr };

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, io);
  } catch (e) {
    if (e instanceof KillallExit) return e.code;
    throw e;
  }

  await killall({ dryRun: parsed.dryRun, web: parsed.web, stdout, stderr });
  return 0;
}
