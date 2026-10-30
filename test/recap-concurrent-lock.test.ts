// recap-concurrent-lock.test.ts — RUNTIME-SEAMS.md §C row "recap/rollup
// locks" / §D priority (recap refresh lock): proves the mkdir-based
// `.lock` in src/recap.ts (`acquireLock`, faithful to bin/recap:388-397
// `_refresh`) actually blocks a second REAL `bin/recap.mjs` process while a
// first one is mid-refresh, and that the "in progress" message it prints
// is a byte-for-byte match with the real upstream `bin/recap` (both say
// `recap: error: another recap is in progress (remove <lock> if that's
// wrong)`, upstream via `die() { echo "recap: error: $*" >&2; exit 1; }`
// at bin/recap:15/394, the port via RecapExit surfaced as `recap: error:
// ${msg}\n` at src/recap.ts:1687).
//
// A fake `llm` stub on PATH sleeps before replying, so the first process
// holds the lock for a controlled window — long enough for a second
// process, spawned shortly after, to reliably observe it and die with the
// exact upstream message, rather than racing real wall-clock luck.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECAP_MJS = path.join(HERE, "..", "bin", "recap.mjs");

interface Result {
  code: number | null;
  err: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve) => {
    let err = "";
    const child = spawn(cmd, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.once("exit", (code) => resolve({ code, err }));
    child.once("error", () => resolve({ code: -1, err }));
  });
}

/** A stub `llm` on PATH: sleeps `delayMs` then replies with a minimal but
 *  valid episode/theme JSON body, so refresh()/_refresh keeps the lock
 *  held for a controlled, measurable window instead of finishing instantly. */
function writeSlowLlmStub(binDir: string, delayMs: number): void {
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "llm");
  fs.writeFileSync(
    stub,
    [
      "#!/usr/bin/env node",
      `setTimeout(() => {`,
      `  process.stdout.write(JSON.stringify({ title: "t", summary: "s", themes: [], notable_steps: [], arc: "a" }));`,
      `  process.exit(0);`,
      `}, ${delayMs});`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
}

function seedTrajectory(runDir: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  const steps = [
    { type: "thought", step_id: "step0000", ts: "2026-01-01T00:00:00Z", content: "thought number 0" },
    { type: "thought", step_id: "step0001", ts: "2026-01-01T00:01:00Z", content: "thought number 1" },
  ];
  fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

describe("recap refresh lock — a second real bin/recap.mjs process sees 'in progress' while the first is mid-refresh", () => {
  it("first process succeeds; second dies with the exact upstream lock message", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recap-lock-"));
    const trajDir = path.join(tmp, "trajdir");
    const runDir = path.join(trajDir, "abc123");
    seedTrajectory(runDir);
    const binDir = path.join(tmp, "bin");
    writeSlowLlmStub(binDir, 1500);

    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      TRAJ_DIR: trajDir,
      TRAJ_ID: "abc123",
    };

    const firstPromise = run(process.execPath, [RECAP_MJS], env);
    // Give the first process time to acquire the lock (near-instant) and
    // enter its first (sleeping) llm call, well before its 1.5s reply lands.
    await new Promise((r) => setTimeout(r, 400));

    const second = await run(process.execPath, [RECAP_MJS], env);
    const first = await firstPromise;

    expect(first.code).toBe(0);
    expect(second.code).toBe(1);
    const lockPath = path.join(runDir, "recap", ".lock");
    expect(second.err).toBe(`recap: error: another recap is in progress (remove ${lockPath} if that's wrong)\n`);

    // The first process's own refresh actually completed successfully.
    expect(fs.existsSync(path.join(runDir, "recap", "episodes.jsonl"))).toBe(true);
  }, 20000);
});

describe.skipIf(!process.env["PARITY_UPSTREAM_ROOT"])(
  "same race against the real upstream bin/recap (Bash oracle, PARITY_UPSTREAM_ROOT) — byte-match on the message",
  () => {
    const upstreamRoot = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
    const upstreamRecap = path.join(upstreamRoot, "bin", "recap");

    it("upstream's second process dies with the byte-identical 'in progress' message", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recap-lock-upstream-"));
      const trajDir = path.join(tmp, "trajdir");
      const runDir = path.join(trajDir, "abc123");
      seedTrajectory(runDir);
      const binDir = path.join(tmp, "bin");
      writeSlowLlmStub(binDir, 1500);

      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
        TRAJ_DIR: trajDir,
        TRAJ_ID: "abc123",
      };

      const firstPromise = run("bash", [upstreamRecap], env);
      await new Promise((r) => setTimeout(r, 400));
      const second = await run("bash", [upstreamRecap], env);
      const first = await firstPromise;

      expect(first.code).toBe(0);
      expect(second.code).toBe(1);
      const lockPath = path.join(runDir, "recap", ".lock");
      expect(second.err).toBe(`recap: error: another recap is in progress (remove ${lockPath} if that's wrong)\n`);
    }, 20000);
  }
);
