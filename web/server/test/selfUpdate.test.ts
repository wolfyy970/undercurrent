// selfUpdate.test.ts — POST /api/update (server.py self_update:235-287,
// `_git_info`:68-84, `_schedule_restart`:61-66). Unit-level against SCRATCH
// git repos built with the real `git` binary (never this checkout, never a
// network remote) — a bare "origin" plus two working clones so a real
// `git pull --ff-only` genuinely fast-forwards or genuinely diverges.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { handleGet, handleMutation, type RouterCtx } from "../src/router.ts";
import { runSelfUpdate, gitInfo, SelfUpdateError, _resetSelfUpdateLockForTests } from "../src/selfUpdate.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  _resetSelfUpdateLockForTests();
  while (cleanups.length) cleanups.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-selfupdate-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A bare "origin" repo plus one working clone (`local`), with an initial
 *  commit. Both `git`-identity-configured so commits work in a sandboxed
 *  CI environment with no global user.name/user.email. */
function initGitFixture(): { base: string; origin: string; local: string } {
  const base = scratchDir();
  const origin = path.join(base, "origin.git");
  const local = path.join(base, "local");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "-q");

  const seed = path.join(base, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "file.txt"), "v1\n");
  git(seed, "add", "file.txt");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  git(base, "clone", "-q", origin, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Test");
  git(local, "checkout", "-q", "main");

  return { base, origin, local };
}

/** Push one more commit to `origin` from a THIRD clone, so `local` (which
 *  never sees it until it pulls) is genuinely behind by a fast-forward. */
function pushNewCommit(fixture: ReturnType<typeof initGitFixture>, filename = "file2.txt"): string {
  const other = path.join(fixture.base, "other");
  git(fixture.base, "clone", "-q", fixture.origin, other);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  git(other, "checkout", "-q", "main"); // the bare repo's own HEAD may not point at "main"
  fs.writeFileSync(path.join(other, filename), "new content\n");
  git(other, "add", filename);
  git(other, "commit", "-q", "-m", `add ${filename}`);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "--short", "HEAD");
}

// ---------------------------------------------------------------------------
// gitInfo
// ---------------------------------------------------------------------------

describe("gitInfo", () => {
  it("reports the real commit/branch of a git repo", () => {
    const fixture = initGitFixture();
    const info = gitInfo(fixture.local);
    expect(info.git_commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.git_branch).toBe("main");
  });

  it("reports nulls outside a git checkout", () => {
    const dir = scratchDir();
    const info = gitInfo(dir);
    expect(info).toEqual({ git_commit: null, git_branch: null });
  });
});

// ---------------------------------------------------------------------------
// runSelfUpdate (library level)
// ---------------------------------------------------------------------------

describe("runSelfUpdate", () => {
  it("disabled -> SelfUpdateError(403)", async () => {
    const fixture = initGitFixture();
    await expect(runSelfUpdate({ enabled: false, repoRoot: fixture.local })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("HEADLONG_WEB_SELF_UPDATE=1"),
    });
  });

  it("up to date -> {ok:true, updated:false, restarting:false}, no restart scheduled", async () => {
    const fixture = initGitFixture();
    const scheduleRestart = vi.fn();
    const result = await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart });
    expect(result).toMatchObject({ ok: true, updated: false, restarting: false });
    expect(result.commit).toBe(gitInfo(fixture.local).git_commit);
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("a real fast-forward pull -> updated:true, restarting:true, schedules a restart, clears staticDir", async () => {
    const fixture = initGitFixture();
    const newCommit = pushNewCommit(fixture);
    const before = gitInfo(fixture.local);
    const staticDir = scratchDir();
    fs.writeFileSync(path.join(staticDir, "index.html"), "old build\n");
    const scheduleRestart = vi.fn();

    const result = await runSelfUpdate({ enabled: true, repoRoot: fixture.local, staticDir, scheduleRestart });

    expect(result).toMatchObject({ ok: true, updated: true, from_commit: before.git_commit, to_commit: newCommit, restarting: true });
    expect(fs.existsSync(path.join(fixture.local, "file2.txt"))).toBe(true); // the pull actually happened
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    expect(scheduleRestart).toHaveBeenCalledWith(750);
    expect(fs.existsSync(staticDir)).toBe(false); // rmtree'd so the next startup rebuilds
  });

  it("staticDir omitted -> no crash, still reports updated:true", async () => {
    const fixture = initGitFixture();
    pushNewCommit(fixture);
    const result = await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    expect(result.updated).toBe(true);
  });

  it("a second concurrent call while the first is still running -> 409 'Update already in progress'", async () => {
    const fixture = initGitFixture();
    // First call: never resolves scheduleRestart-side, but the lock is
    // taken synchronously at call time — start it, then immediately fire
    // the second before awaiting the first.
    const first = runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    const second = runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    await expect(second).rejects.toMatchObject({ status: 409, message: "Update already in progress" });
    await first; // let the first finish cleanly (releases the lock since nothing to update)
  });

  it("a completed, up-to-date run releases the lock — a later call succeeds", async () => {
    const fixture = initGitFixture();
    await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    const second = await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    expect(second.updated).toBe(false);
  });

  it("a real UPDATE run keeps the lock held ('by design' — the process is about to restart)", async () => {
    const fixture = initGitFixture();
    pushNewCommit(fixture);
    const result = await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    expect(result.updated).toBe(true);
    await expect(runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() })).rejects.toMatchObject({ status: 409 });
  });

  it("diverged history (git pull --ff-only fails) -> 409 with the last stderr line", async () => {
    const fixture = initGitFixture();
    // Diverge: origin gets a new commit AND local gets its own local-only commit.
    pushNewCommit(fixture);
    fs.writeFileSync(path.join(fixture.local, "local-only.txt"), "local change\n");
    git(fixture.local, "add", "local-only.txt");
    git(fixture.local, "commit", "-q", "-m", "local divergent commit");

    let caught: unknown;
    try {
      await runSelfUpdate({ enabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SelfUpdateError);
    const e = caught as SelfUpdateError;
    expect(e.status).toBe(409);
    expect((e.detail as { message: string; stderr: string }).message.length).toBeGreaterThan(0);
    expect((e.detail as { message: string; stderr: string }).stderr).toContain("");
  });

  it("a repoRoot that isn't a git repo at all -> 409 (git's own nonzero exit, not a spawn failure)", async () => {
    // `git -C <non-repo> pull` runs fine and exits 128 with its own message
    // ("not a git repository") — Python's subprocess.run sees this as a
    // normal nonzero returncode, matching the 409 branch, NOT the
    // OSError/TimeoutExpired 500 branch (that one needs the git BINARY
    // itself to be unreachable or the call to time out).
    const dir = scratchDir();
    let caught: unknown;
    try {
      await runSelfUpdate({ enabled: true, repoRoot: dir, scheduleRestart: vi.fn() });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SelfUpdateError);
    expect((caught as SelfUpdateError).status).toBe(409);
    expect((caught as SelfUpdateError).detail).toMatchObject({ message: expect.stringContaining("git repository") });
  });
});

// ---------------------------------------------------------------------------
// Route level (POST /api/update, GET /api/config)
// ---------------------------------------------------------------------------

function ctxFor(root: string, overrides: Partial<RouterCtx> = {}): RouterCtx {
  return { root, controlsEnabled: true, ...overrides };
}

describe("POST /api/update — route level", () => {
  it("read-only mode -> 403, before even checking self-update", async () => {
    const fixture = initGitFixture();
    const result = await handleMutation(ctxFor(fixture.local, { controlsEnabled: false, selfUpdateEnabled: true, repoRoot: fixture.local }), "POST", ["update"], {});
    expect(result.status).toBe(403);
  });

  it("controls enabled but self-update disabled (default) -> 403 'Self-update is disabled'", async () => {
    const fixture = initGitFixture();
    const result = await handleMutation(ctxFor(fixture.local, { repoRoot: fixture.local }), "POST", ["update"], {});
    expect(result.status).toBe(403);
    expect((result.body as { detail: string }).detail).toContain("HEADLONG_WEB_SELF_UPDATE=1");
  });

  it("enabled + up to date -> 202 {ok:true, updated:false}", async () => {
    const fixture = initGitFixture();
    const result = await handleMutation(ctxFor(fixture.local, { selfUpdateEnabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() }), "POST", ["update"], {});
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ ok: true, updated: false, restarting: false });
  });

  it("enabled + a real update available -> 202 {ok:true, updated:true, restarting:true}", async () => {
    const fixture = initGitFixture();
    pushNewCommit(fixture);
    const scheduleRestart = vi.fn();
    const result = await handleMutation(ctxFor(fixture.local, { selfUpdateEnabled: true, repoRoot: fixture.local, scheduleRestart }), "POST", ["update"], {});
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ ok: true, updated: true, restarting: true });
    expect(scheduleRestart).toHaveBeenCalledWith(750);
  });

  it("concurrent update -> the second POST gets 409", async () => {
    const fixture = initGitFixture();
    const ctx = ctxFor(fixture.local, { selfUpdateEnabled: true, repoRoot: fixture.local, scheduleRestart: vi.fn() });
    const first = handleMutation(ctx, "POST", ["update"], {});
    const second = handleMutation(ctx, "POST", ["update"], {});
    const results = await Promise.all([first, second]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409]);
  });
});

describe("GET /api/config — self_update_enabled / git_commit / git_branch", () => {
  it("reflects ctx.selfUpdateEnabled and ctx.gitInfo when set", () => {
    const fixture = initGitFixture();
    const info = gitInfo(fixture.local);
    const result = handleGet(ctxFor(fixture.local, { selfUpdateEnabled: true, gitInfo: info }), ["config"], new URLSearchParams());
    const body = result!.body as { self_update_enabled: boolean; git_commit: string | null; git_branch: string | null };
    expect(body.self_update_enabled).toBe(true);
    expect(body.git_commit).toBe(info.git_commit);
    expect(body.git_branch).toBe("main");
  });

  it("defaults to false/null when omitted (bare {root, controlsEnabled} ctx)", () => {
    const root = scratchDir();
    const result = handleGet({ root, controlsEnabled: true }, ["config"], new URLSearchParams());
    const body = result!.body as { self_update_enabled: boolean; git_commit: string | null; git_branch: string | null };
    expect(body).toMatchObject({ self_update_enabled: false, git_commit: null, git_branch: null });
  });
});
