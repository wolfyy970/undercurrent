// stdin.test.ts — data-loss regression test for the shared stdin reader
// (src/stdin.ts) used by the bin/*.mjs shims.
//
// fs.readFileSync(0) throws EAGAIN part-way through a read when fd 0 is a
// non-blocking pipe fed by a Node parent (e.g. a shim that touches
// `process.stdin` before doing a raw read — bin/chat.mjs, bin/skills.mjs —
// gets its own fd 0 switched to non-blocking by that touch; a shim spawning
// another Node process's stdin via spawnSync's `input` hits the same class of
// bug on the far end, which is exactly what bin/llm.mjs's reference fix
// guards against). The old per-shim `try { readFileSync(0) } catch { return
// "" }` pattern DISCARDS every byte already read when that happens, so a
// large piped payload silently loses its head or vanishes entirely.
//
// These tests spawn the REAL shims (not injected-IO unit harnesses — see
// mem.test.ts / chat.test.ts / put.test.ts for those) with a genuinely piped
// child.stdin fed in small delayed chunks — the delivery pattern that starves
// the pipe buffer and is what makes EAGAIN observable — and assert the stored
// bytes match the input exactly. `test/stdin-old-chat-repro.txt` below (see
// the comment on the "reproduces on the pre-fix reader" test) documents the
// concrete before/after this was verified against.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = (name: string) => path.join(REPO_ROOT, "bin", name);

const MIN_BYTES = 512 * 1024;

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

/** ASCII text payload (base64, no newlines) at least `bytes` long — safe for
 *  the string-mode readers (mem/chat strip trailing newlines; base64 has
 *  none to strip). */
/** Random lowercase hex. Not base64: the trajectory append redacts secret-shaped text (src/trajRedact.mjs), and a
 *  random base64 payload of this size contains an `AIza` + 30-char Google-key shape a few percent of the time, which
 *  then lands as `<redacted:google-key>` and fails the byte-for-byte check. Every redaction pattern needs an uppercase
 *  letter or punctuation, so lowercase hex never matches one. */
function randomTextPayload(bytes: number): string {
  return crypto.randomBytes(Math.ceil(bytes / 2) + 8).toString("hex");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node <bin> ...args` with a REAL pipe on stdin and feed `payload` in
 * `chunkBytes`-sized pieces, awaiting `delayMs` between writes. This is the
 * delivery pattern (small chunks, real delay, real OS pipe — not
 * spawnSync's single `input` buffer) that starves the pipe and makes a
 * non-blocking fd 0 return EAGAIN mid-read instead of blocking for more data.
 */
function runWithChunkedStdin(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  payload: string | Buffer;
  chunkBytes: number;
  delayMs: number;
}): Promise<RunResult> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [opts.bin, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  const payload = opts.payload;
  const total = payload.length;
  const feed = (async () => {
    let sent = 0;
    while (sent < total) {
      const end = Math.min(sent + opts.chunkBytes, total);
      const chunk = typeof payload === "string" ? payload.slice(sent, end) : payload.subarray(sent, end);
      const canWriteMore = child.stdin.write(chunk);
      sent = end;
      if (!canWriteMore) await new Promise((r) => child.stdin.once("drain", r));
      if (sent < total) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    child.stdin.end();
  })();

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", async (code) => {
      await feed;
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// mem add
// ---------------------------------------------------------------------------

describe("mem add — piped stdin over 512 KiB, delivered in delayed chunks", () => {
  it("stores the body byte-for-byte, none of it discarded on EAGAIN", async () => {
    const work = tmpDir("stdin-mem-");
    const memDir = path.join(work, ".memories");
    const payload = randomTextPayload(MIN_BYTES + 4096);
    expect(payload.length).toBeGreaterThanOrEqual(MIN_BYTES);

    const res = await runWithChunkedStdin({
      bin: BIN("mem.mjs"),
      args: ["add"],
      cwd: work,
      env: { MEM_DIR: memDir },
      payload,
      chunkBytes: 4096,
      delayMs: 2,
    });

    expect(res.code).toBe(0);
    const filename = res.stdout.trim();
    expect(filename).not.toBe("");

    const content = fs.readFileSync(path.join(memDir, `${filename}.md`), "utf8");
    const sep = content.indexOf("\n\n");
    expect(sep).toBeGreaterThan(0);
    const body = content.slice(sep + 2);
    // actionAdd writes `${text}\n` — the payload has no trailing newline, so
    // the body is the payload plus exactly one appended newline.
    expect(body).toBe(payload + "\n");
  }, 120_000); // waits on the child's exit; the feed's per-chunk timers stretch under load
});

// ---------------------------------------------------------------------------
// chat send
// ---------------------------------------------------------------------------

function seedRootTrajectory(trajDir: string, trajId: string): void {
  const hex8 = trajId.slice(0, 8);
  const file = path.join(trajDir, `${hex8}-root`, "trajectory.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = { type: "trajectory", step_id: trajId, ts: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify(head) + "\n");
}

function readRootSteps(trajDir: string, trajId: string): Record<string, unknown>[] {
  const hex8 = trajId.slice(0, 8);
  const file = path.join(trajDir, `${hex8}-root`, "trajectory.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("chat send — piped stdin over 512 KiB, delivered in delayed chunks", () => {
  it("appends the message content byte-for-byte, none of it discarded on EAGAIN", async () => {
    const work = tmpDir("stdin-chat-");
    const trajDir = path.join(work, "traj");
    const trajId = crypto.randomUUID();
    seedRootTrajectory(trajDir, trajId);
    const payload = randomTextPayload(MIN_BYTES + 4096);
    expect(payload.length).toBeGreaterThanOrEqual(MIN_BYTES);

    const res = await runWithChunkedStdin({
      bin: BIN("chat.mjs"),
      args: ["send", "--from", "alice", "--to", "bob"],
      cwd: work,
      env: { TRAJ_DIR: trajDir, TRAJ_ID: trajId },
      payload,
      chunkBytes: 4096,
      delayMs: 2,
    });

    expect(res.code).toBe(0);
    const steps = readRootSteps(trajDir, trajId);
    const msg = steps.find((s) => s.type === "message");
    expect(msg).toBeDefined();
    expect(msg!.content).toBe(payload);
  }, 120_000); // waits on the child's exit; the feed's per-chunk timers stretch under load

  // This is the pattern (small chunks, short delay) verified against the
  // pre-fix `try { readFileSync(0) } catch { return "" } ` reader: fed this
  // way, the old code threw EAGAIN before finishing the read, swallowed it,
  // got back "", and `chat send` died with "No message provided" — losing
  // the entire message, not just the tail. Smaller/faster chunks than the
  // test above to keep the EAGAIN window tight.
  it("survives an aggressive small-chunk feed (the EAGAIN-triggering pattern)", async () => {
    const work = tmpDir("stdin-chat-aggr-");
    const trajDir = path.join(work, "traj");
    const trajId = crypto.randomUUID();
    seedRootTrajectory(trajDir, trajId);
    const payload = randomTextPayload(MIN_BYTES);

    const res = await runWithChunkedStdin({
      bin: BIN("chat.mjs"),
      args: ["send", "--from", "alice", "--to", "bob"],
      cwd: work,
      env: { TRAJ_DIR: trajDir, TRAJ_ID: trajId },
      payload,
      chunkBytes: 512,
      delayMs: 1,
    });

    expect(res.code).toBe(0);
    const steps = readRootSteps(trajDir, trajId);
    const msg = steps.find((s) => s.type === "message");
    expect(msg).toBeDefined();
    expect(msg!.content).toBe(payload);
  }, 120_000); // waits on the child's exit; 1024 one-ms timers stretch under load
});

// PORT-NOTE (1c: 12ca841): the `put` describe block that used to close this
// file is removed along with the retired `put` tool (bin/put.mjs,
// src/put.ts) — mem/chat above still exercise the same chunked-stdin/EAGAIN
// fix (src/stdin.ts).
