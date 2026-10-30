// selfUpdate.ts — port of server.py's self-update machinery: `_git_info`,
// `_schedule_restart`, and the `POST /api/update` handler's own body
// (server.py:61-66, 68-84, 219-287). Opt-in (`HEADLONG_WEB_SELF_UPDATE=1`,
// off in read-only mode) — the dash can pull its own repo and restart
// itself; without a supervisor the process just exits (same as upstream).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const execFileAsync = promisify(execFile);

export interface GitInfo {
  git_commit: string | null;
  git_branch: string | null;
}

/** `_git_info()` (server.py:68-84) — sync, matching upstream's own
 *  once-at-startup `subprocess.run` calls (cheap local `rev-parse`s). */
export function gitInfo(repoRoot: string): GitInfo {
  function revParse(...args: string[]): string | null {
    try {
      const out = execFileSync("git", ["-C", repoRoot, "rev-parse", ...args], { timeout: 5000, encoding: "utf-8" });
      const s = out.trim();
      return s || null;
    } catch {
      return null;
    }
  }
  return { git_commit: revParse("--short", "HEAD"), git_branch: revParse("--abbrev-ref", "HEAD") };
}

export class SelfUpdateError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

export interface SelfUpdateResult {
  ok: true;
  updated: boolean;
  commit?: string | null;
  from_commit?: string | null;
  to_commit?: string | null;
  restarting: boolean;
}

export interface SelfUpdateOptions {
  enabled: boolean;
  repoRoot: string;
  /** The built frontend dir — `shutil.rmtree(_STATIC_DIR, ignore_errors=True)`
   *  on an actual update, so the next startup rebuilds it. Omit if this
   *  server instance isn't tracking one (matches server.py: `_STATIC_DIR`
   *  always exists as a path, this is just whether the port has one to clear). */
  staticDir?: string | null;
  /** `_schedule_restart` (server.py:61-66): SIGTERM after `delayMs`, letting
   *  the response flush first. Injectable so tests never actually kill the
   *  test process. */
  scheduleRestart?: (delayMs: number) => void;
}

function defaultScheduleRestart(delayMs: number): void {
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
  }, delayMs).unref();
}

// `update_lock = threading.Lock()` (server.py:222) — one lock per running
// server process, same scope as upstream's per-app-instance lock (this
// port has no multi-instance-per-process concept either).
let locked = false;

/** `self_update()` (server.py:235-287), minus the `_require_controls()`
 *  gate (the router checks that, same as every other mutation route). */
export async function runSelfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
  if (!opts.enabled) {
    throw new SelfUpdateError(403, "Self-update is disabled (set HEADLONG_WEB_SELF_UPDATE=1)");
  }
  if (locked) {
    throw new SelfUpdateError(409, "Update already in progress");
  }
  locked = true;
  let keepLocked = false;
  try {
    const before = gitInfo(opts.repoRoot);

    let stderrText: string;
    try {
      const res = await execFileAsync("git", ["-C", opts.repoRoot, "pull", "--ff-only"], { timeout: 180000 });
      stderrText = res.stderr;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (typeof err.code === "number") {
        // A real (nonzero-exit) git failure — e.g. diverged history under --ff-only.
        const lines = (err.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
        throw new SelfUpdateError(409, {
          message: lines.length > 0 ? lines[lines.length - 1] : "git pull failed",
          stderr: err.stderr ?? "",
        });
      }
      // Spawn failure (git missing, ENOENT) or timeout (`err.killed`) — `except (OSError, subprocess.TimeoutExpired)`.
      throw new SelfUpdateError(500, `git pull failed: ${err.message}`);
    }
    void stderrText;

    const after = gitInfo(opts.repoRoot);
    if (after.git_commit === before.git_commit) {
      return { ok: true, updated: false, commit: after.git_commit, restarting: false };
    }

    if (opts.staticDir) {
      try {
        rmSync(opts.staticDir, { recursive: true, force: true });
      } catch {
        /* ignore_errors=True */
      }
    }
    (opts.scheduleRestart ?? defaultScheduleRestart)(750);
    keepLocked = true; // "On success the lock is held until the process exits — by design."
    return { ok: true, updated: true, from_commit: before.git_commit, to_commit: after.git_commit, restarting: true };
  } finally {
    if (!keepLocked) locked = false;
  }
}

/** Test-only: release a lock left held by a simulated "the process didn't
 *  actually exit" run, or reset state between test files. */
export function _resetSelfUpdateLockForTests(): void {
  locked = false;
}
