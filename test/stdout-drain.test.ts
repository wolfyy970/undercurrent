// stdout-drain.test.ts — regression test for bug #40: bin/*.mjs entry points
// used to call process.exit() before stdout had drained, so a piped, non-TTY
// stdout got silently truncated at the OS pipe-buffer boundary (65,536 bytes
// observed on macOS) whenever a tool's output exceeded it. `bin/llm.mjs`
// already carried the fix (drain both streams with an empty write + callback
// before exiting); parity/fuzz/findings/view-1.md found the same missing
// pattern in every other bin/*.mjs entry point. src/exitAfterDrain.ts now
// centralizes the fix and every entry point uses it.
//
// This spawns the REAL bin/*.mjs shims as child processes with a genuine OS
// pipe on stdout (not spawnSync, not an injected-IO harness — see
// context.test.ts / trajCli.test.ts / view.test.ts for those) so the actual
// async-pipe-vs-process.exit race is exercised, and compares the captured
// bytes against the SAME run* function called in-process (which cannot be
// truncated by a subprocess exiting early) on the identical input — proving
// the piped CLI output is byte-identical to the trusted in-process output,
// not just "big enough".

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runContext, type ContextIO } from "../src/context.js";
import { runTraj, type TrajIO } from "../src/trajCli.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = (name: string) => path.join(REPO_ROOT, "bin", name);

// Comfortably over any plausible OS pipe buffer (64 KiB observed on macOS).
const MIN_BYTES = 200_000;

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Spawn `node <bin> ...args` with a real pipe on stdout/stderr and collect
 *  every byte, resolving only once both streams have fully closed. This is
 *  exactly the shape (`tool | wc -c`, `tool | somewhereelse`) bug #40 broke:
 *  a non-TTY pipe on the other end of stdout. */
function spawnCapture(bin: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): Promise<SpawnResult> {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => outChunks.push(d));
  child.stderr.on("data", (d: Buffer) => errChunks.push(d));

  return new Promise((resolve, reject) => {
    let code: number | null = null;
    let exited = false;
    let closed = false;
    const maybeResolve = () => {
      if (exited && closed) {
        resolve({ code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks) });
      }
    };
    child.on("error", reject);
    child.on("exit", (c) => {
      code = c;
      exited = true;
      maybeResolve();
    });
    child.on("close", () => {
      closed = true;
      maybeResolve();
    });
  });
}

describe("bug #40 — bin/*.mjs entry points drain stdout before process.exit", () => {
  // PORT-NOTE (1c: 12ca841): the `view` scenario that used to open this
  // describe block is removed along with the retired `view` tool
  // (bin/view.mjs, src/view.ts) — the context/traj scenarios below still
  // exercise the same drain-before-exit fix (src/exitAfterDrain.ts).
  it("context: a trajectory with one huge final step, piped, is not truncated", async () => {
    const dir = tmpDir("context-drain-");
    const hex = "aaaaaaaa";
    const uuid = `${hex}-1111-2222-3333-444444444444`;
    const rootDir = path.join(dir, "trajdir", `${hex}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    const bigContent = "y".repeat(300_000);
    const steps = [
      { type: "trajectory", step_id: hex },
      { type: "final", step_id: "g1", content: bigContent },
    ];
    fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const args = ["--head", "2", "--tail", "0", "--assistant-types", "final", "--prompt-limit", "400000"];
    const env = { TRAJ_DIR: "./trajdir", TRAJ_ID: uuid };

    const expectedChunks: Buffer[] = [];
    let expectedErr = "";
    const io: ContextIO = {
      cwd: dir,
      env,
      stdout: (s) => expectedChunks.push(typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)),
      stderr: (s) => (expectedErr += s),
    };
    const expectedCode = runContext(args, io);
    const expected = Buffer.concat(expectedChunks);
    expect(expected.length).toBeGreaterThan(MIN_BYTES);
    expect(expectedErr).toBe("");

    const res = await spawnCapture(BIN("context.mjs"), args, { cwd: dir, env });
    expect(res.code).toBe(expectedCode);
    expect(res.stdout.length).toBe(expected.length);
    expect(res.stdout.equals(expected)).toBe(true);
  });

  it("traj cat --raw: a large trajectory file, piped, is not truncated", async () => {
    const dir = tmpDir("traj-drain-");
    const hex = "bbbbbbbb";
    const uuid = `${hex}-1111-2222-3333-444444444444`;
    const rootDir = path.join(dir, "trajdir", `${hex}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    const bigStep = { type: "shell-output", step_id: "s1", stdout: "z".repeat(300_000) };
    const body = [{ type: "trajectory", step_id: hex }, bigStep].map((s) => JSON.stringify(s)).join("\n") + "\n";
    fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), body);

    // TrajIO has no `cwd` — a relative --traj_dir would resolve against this
    // test process's own cwd, not the fixture dir, so use an absolute path.
    const trajDirAbs = path.join(dir, "trajdir");
    const args = ["cat", "--raw", "--traj_dir", trajDirAbs, uuid];
    const env = { TRAJ_DIR: trajDirAbs, TRAJ_ID: uuid };

    const expectedChunks: Buffer[] = [];
    let expectedErr = "";
    const io: TrajIO = {
      env,
      stdout: (s) => expectedChunks.push(Buffer.from(s, "utf8")),
      stderr: (s) => (expectedErr += s),
      readStdin: () => "",
      isTTY: false,
      sleepMs: () => {},
      shouldStop: () => false,
    };
    const expectedCode = runTraj(args, io);
    const expected = Buffer.concat(expectedChunks);
    expect(expected.length).toBeGreaterThan(MIN_BYTES);
    expect(expectedErr).toBe("");

    const res = await spawnCapture(BIN("traj.mjs"), args, { cwd: dir, env });
    expect(res.code).toBe(expectedCode);
    expect(res.stdout.length).toBe(expected.length);
    expect(res.stdout.equals(expected)).toBe(true);
  });
});

describe("bug #52 — exitAfterDrain's post-content flush write crashes on EPIPE", () => {
  // PORT-NOTE (1c: bug #52, found while triaging test_chat_history_index.sh's
  // "text output renders the messages" case against parity/upstream-tests):
  // `exitAfterDrain` (src/exitAfterDrain.ts) issues a trailing ZERO-byte
  // `process.stdout.write("", cb)` after all real output, to make sure the
  // stream has drained before `process.exit()`. When stdout is a pipe whose
  // reader has ALREADY closed its read end — the completely ordinary
  // `chat history --with X | grep -q pattern` shape, where `grep -q` may stop
  // reading as soon as it finds a match — that trailing write can itself hit
  // EPIPE. Node does not silently ignore an EPIPE on a stream with no
  // registered "error" handler: it emits an unhandled 'error' event and
  // crashes the whole process (uncaught exception, non-zero exit, a stack
  // trace on stderr) even though every byte of real content was already
  // delivered and read successfully. Under the caller's `set -o pipefail`
  // (as upstream's own tests/test_chat_history_index.sh uses), that crash's
  // non-zero exit flips an `if tool | grep -q ...; then` check to the ELSE
  // branch even though grep itself matched — a ~20-40% flaky failure in
  // practice (multiple small async writes in the for-loop give the reader
  // many chances to close before the final drain write lands), reproduced
  // deterministically here by destroying the read end immediately instead of
  // racing a real `grep -q`. Affects every bin/*.mjs entry point that uses
  // exitAfterDrain (chat, context, identity, mem, recap, retrieval-step,
  // skills, thinker-step, traj), not just `chat` — fixed once, centrally, in
  // exitAfterDrain itself (an EPIPE-tolerant 'error' listener on both
  // streams), not per-tool.
  it("context: reader closes its end early, port still exits 0 with no EPIPE crash", async () => {
    const dir = tmpDir("epipe-drain-");
    const hex = "cccccccc";
    const uuid = `${hex}-1111-2222-3333-444444444444`;
    const rootDir = path.join(dir, "trajdir", `${hex}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    const steps = [
      { type: "trajectory", step_id: hex },
      { type: "final", step_id: "g1", content: "hello there" },
    ];
    fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const args = ["--head", "2", "--tail", "0", "--assistant-types", "final"];
    const env = { TRAJ_DIR: "./trajdir", TRAJ_ID: uuid };

    const child = spawn(process.execPath, [BIN("context.mjs"), ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    child.stderr.on("data", (d: Buffer) => (stderrBuf += d.toString("utf8")));
    // Simulate `| grep -q pattern` closing its read end as soon as it is
    // satisfied — destroy the parent's readable end immediately, before the
    // child has necessarily finished (or even started) writing.
    child.stdout.destroy();

    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(stderrBuf).not.toContain("EPIPE");
    expect(stderrBuf).not.toContain("Unhandled 'error' event");
  });
});
