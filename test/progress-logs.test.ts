// progress-logs.test.ts — the thinker-log observability gap (bin/shellm's
// `progress`/`progress_dim` stderr lines, plus thinkers/monolith/step and
// thinkers/responder/step's own `printf ... >&2` lines): before this file's
// fix, src/monolith.ts / src/responder.ts / src/shellm.ts wrote NOTHING to
// stderr/stdout during a wake, so run/logs/<name>.log stayed 0 bytes for a
// whole session (upstream: thousands of lines) and `thinkers status` always
// reported "0 log lines" for a live thinker.
//
// Two unit tests (recorded real DeepSeek replies on LLM_API_URL, exact stderr/stdout lines, trajId normalized)
// pin one monolith run and one responder run's shapes against a real
// upstream log capture (a side-by-side run's sxs/orig/.../run/logs/*.log)
// and the bin/shellm / thinkers/*/step source read alongside it. A third,
// daemon-level test spawns the REAL bin/dispatcherd.mjs (as daemon.test.ts
// does) and asserts run/logs/monolith.log ends up non-empty after a step —
// the actual bug this file exists to close.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { runStep } from "../src/steprun.ts";
import { appendStep } from "../src/trajCore.mjs";
import { recordedEndpoint, recordedText, type RecordedModel } from "./support/recordedModel.ts";

const models: RecordedModel[] = [];
/** Env pointing `llm` at a recording. Replay keeps the identity's own model name (it is in the asserted lines); record
 *  mode sends the recorded model. steprun/quiet-idle is reused: the same quiet first wake of a fresh identity. */
async function endpoint(suite: string, scenario: string): Promise<Record<string, string>> {
  const { model, env } = await recordedEndpoint(suite, scenario);
  models.push(model);
  if (process.env["UC_RECORD"] !== "1") delete env["SHELLM_MODEL"];
  return env;
}

const roots: string[] = [];

/** The daemon-level suite below spawns real (detached) grandchild processes
 *  it does not track pids for; a stray one can still be writing a file the
 *  instant this fires, which turns a plain rmSync into a flaky ENOTEMPTY.
 *  Retry with a short backoff instead of failing the whole suite on a race
 *  that has nothing to do with what this file is testing. */
function rmRootWithRetry(dir: string, attemptsLeft = 20): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (attemptsLeft <= 0) throw e;
    const start = Date.now();
    while (Date.now() - start < 50) {
      /* brief busy-wait — afterEach hooks in this suite are synchronous */
    }
    rmRootWithRetry(dir, attemptsLeft - 1);
  }
}

afterEach(async () => {
  while (models.length) models.pop()!.close();
  while (roots.length) rmRootWithRetry(roots.pop()!);
});

function makeIdentity(): { root: string; idDir: string; rootTrajectoryId: string; env: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-progresslog-"));
  roots.push(root);
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  const env = resolveIdentityEnv(result.identityDir, { base: process.env as Record<string, string> });
  env["SHELLM_SANDBOX"] = "local"; // never touch real docker in this suite
  return { root, idDir: result.identityDir, rootTrajectoryId: result.rootTrajectoryId, env };
}


/** Captures every process.stdout/stderr.write call made during `fn()`,
 *  tagged by stream, in call order — the same merge order run/logs/<name>.log
 *  gets from `2>&1` (bin/thinkers) / a shared logFd (src/daemon.ts spawnStep). */
async function captureIo(fn: () => Promise<void>): Promise<Array<{ stream: "stdout" | "stderr"; text: string }>> {
  const calls: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    calls.push({ stream: "stdout", text: String(chunk) });
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    calls.push({ stream: "stderr", text: String(chunk) });
    return true;
  });
  try {
    await fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return calls;
}

/** trajId is a random UUID — normalize it so the assertion is stable. */
function normalizeTrajId(lines: string[]): string[] {
  return lines.map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<TRAJ_ID>"));
}

describe("monolith wake: exact progress lines (bin/shellm + thinkers/monolith/step parity)", () => {
  it("one FINAL='idle' run — the exact stderr/stdout sequence, byte-for-byte where deterministic", async () => {
    const { root, env } = makeIdentity();
    Object.assign(env, await endpoint("steprun", "quiet-idle")); // the real reply: ```bash\nFINAL="idle"\n```

    const calls = await captureIo(async () => {
      const code = await runStep("monolith", { type: "" }, env);
      expect(code).toBe(0);
    });

    const stderrLines = normalizeTrajId(calls.filter((c) => c.stream === "stderr").map((c) => c.text));
    const stdoutLines = calls.filter((c) => c.stream === "stdout").map((c) => c.text);

    expect(stderrLines).toEqual([
      "  routing (none / spontaneous)...\n",
      "  model deepseek/deepseek-v4-flash-0731 (think tier)\n",
      "\x1b[1;34m▶ Starting shellm loop (model: deepseek/deepseek-v4-flash-0731, max iterations: unlimited)\x1b[0m\n",
      "\n",
      "\x1b[1;34m▶ Iteration 1 — calling deepseek/deepseek-v4-flash-0731...\x1b[0m\n",
      "\x1b[1;34m▶ Executing bash (1 lines):\x1b[0m\n",
      '\x1b[90m    FINAL="idle"\x1b[0m\n',
      "\x1b[36m  $ FINAL=idle\x1b[0m\n",
      "\x1b[36m  $ set +x\x1b[0m\n",
      "\x1b[90m  Exit 0\x1b[0m\n",
      "\n",
      "\x1b[1;34m▶ Final answer received\x1b[0m\n",
      "\n",
      "\x1b[90m  Trajectory: <TRAJ_ID>\x1b[0m\n",
      "  run produced no durable step (rc=0) — marking idle; timer keeps the loop alive\n",
    ]);
    expect(stdoutLines).toEqual(["  [monolith] idle\n"]);

    // The observability gap itself: the merged stream (what run/logs/monolith.log
    // actually holds — src/daemon.ts's spawnStep pipes both fds to one file)
    // is non-empty and has the shape `thinkers status`'s `wc -l` counts on.
    const merged = calls.map((c) => c.text).join("");
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.split("\n").length).toBeGreaterThan(1);
  });
});

describe("responder step: exact progress lines (thinkers/responder/step parity)", () => {
  it("one ordinary reply — the exact stderr/stdout sequence", async () => {
    const { idDir, rootTrajectoryId, root, env } = makeIdentity();
    Object.assign(env, await endpoint("progress-logs", "andy-how-are-you"));
    env["RESPONDER_PERSON_NOTES"] = "0"; // no detached child to wait on/clean up in this test
    env["RESPONDER_STRUCTURED"] = "0"; // 2e39a3f: plain-text reply path (structured is `auto` by default)

    const trajFile = path.join(idDir, "trajectories", `${rootTrajectoryId.slice(0, 8)}-root`, "trajectory.jsonl");
    const stepId = appendStep(trajFile, { type: "message", content: "hey how are you", from: "andy", to: "pax", source: "chat" }, {});

    const calls = await captureIo(async () => {
      const code = await runStep(
        "responder",
        { type: "message", step_id: stepId, from: "andy", to: "pax", content: "hey how are you" },
        env
      );
      expect(code).toBe(0);
    });

    const stderrLines = calls.filter((c) => c.stream === "stderr").map((c) => c.text);
    const stdoutLines = calls.filter((c) => c.stream === "stdout").map((c) => c.text);

    // bin/chat:193 "Reply sent." carries no ANSI — thinkers/responder/step's
    // own printf lines don't either (only bin/shellm colors its progress).
    // The test's endpoint is reached by an env provider, so bin/llm's own override note follows the call, carried into
    // the step's stderr exactly as _reply_llm's `cat "$err" >&2` does upstream.
    expect(stderrLines).toEqual(["  claiming reply to andy...\n", "  replying to andy...\n", expect.stringMatching(/^llm: warning: LLM_PROVIDER=\S+ overrides detected provider /), "Reply sent.\n"]);
    const real = recordedText(models[0]!.recording.calls[0]!);
    expect(stdoutLines).toEqual([`  [reply -> andy] ${real}\n`]);
  });

  // DeepSeek answers a json_schema request with HTTP 400 (recorded), so the step retries as plain text.
  it("the same reply with structured replies on (the 2e39a3f default): DeepSeek's real 400 to the schema, then the plain retry", async () => {
    const { idDir, rootTrajectoryId, root, env } = makeIdentity();
    Object.assign(env, await endpoint("progress-logs", "andy-how-are-you-structured"));
    env["RESPONDER_PERSON_NOTES"] = "0";
    env["RESPONDER_STRUCTURED"] = "1";

    const trajFile = path.join(idDir, "trajectories", `${rootTrajectoryId.slice(0, 8)}-root`, "trajectory.jsonl");
    const stepId = appendStep(trajFile, { type: "message", content: "hey how are you", from: "andy", to: "pax", source: "chat" }, {});
    const calls = await captureIo(async () => {
      expect(await runStep("responder", { type: "message", step_id: stepId, from: "andy", to: "pax", content: "hey how are you" }, env)).toBe(0);
    });
    expect(calls.filter((c) => c.stream === "stderr").map((c) => c.text)).toEqual([
      "  claiming reply to andy...\n",
      "  replying to andy...\n",
      expect.stringMatching(/^llm: warning: LLM_PROVIDER=\S+ overrides detected provider /), // see the test above
      "  structured reply call failed — retrying as plain text\n",
      expect.stringMatching(/^llm: warning: LLM_PROVIDER=\S+ overrides detected provider /),
      "Reply sent.\n",
    ]);
  });
});

describe("daemon: run/logs/<name>.log is populated for a real step (the observability gap)", () => {
  const DISPATCHERD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "dispatcherd.mjs");
  const children: ChildProcess[] = [];

  afterEach(async () => {
    while (children.length) {
      const c = children.pop()!;
      if (c.exitCode === null && c.signalCode === null) {
        c.kill("SIGKILL");
        await new Promise<void>((r) => {
          if (c.exitCode !== null || c.signalCode !== null) return r();
          c.once("exit", () => r());
          setTimeout(r, 1000);
        });
      }
    }
  });

  async function poll(pred: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    if (!pred()) throw new Error(`poll: condition not met within ${timeoutMs}ms`);
  }

  function readOr(file: string, fallback = ""): string {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return fallback;
    }
  }

  it("a real monolith-wake fired by the dispatcher leaves run/logs/monolith.log non-empty, shaped like upstream's", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-daemon-progresslog-"));
    roots.push(root);
    const result = identityNew({ identitiesRoot: root, name: "pax" });
    const idDir = result.identityDir;
    // responder/retrieval disabled — this test only cares about the monolith
    // thinker's own log; monolith is left enabled (identityNew's default).
    fs.writeFileSync(path.join(idDir, "thinkers", "responder", "disabled"), "x");

    const runDir = path.join(idDir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "active_thinkers"), "monolith\n");

    const llmEnv = await endpoint("steprun", "quiet-idle");

    const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
    env["SHELLM_SANDBOX"] = "local";
    Object.assign(env, llmEnv);

    const child = spawn(process.execPath, [DISPATCHERD], { env, stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);

    await poll(() => fs.existsSync(path.join(runDir, "sub_map")));
    // Due wake_at, exactly like daemon.test.ts's scheduled-wake test — fires
    // the monolith step through the SAME spawnStep path production uses.
    fs.writeFileSync(path.join(runDir, "monolith.wake_at"), String(Math.floor(Date.now() / 1000) - 5));

    // The log fills in progressively as the real shellm loop subprocess
    // runs (its stdout/stderr are piped straight to this file); polling on
    // "non-empty" alone only proves the FIRST write landed, not that the
    // lines this test actually asserts on are there yet — a real race, not
    // just a slow one, under heavy CPU contention. Poll on the same content
    // the assertions below check for, with a generous deadline (spawning a
    // real subprocess through docker/local sandbox setup can take a while
    // when the machine is busy).
    const logFile = path.join(runDir, "logs", "monolith.log");
    await poll(() => fs.existsSync(logFile) && readOr(logFile).includes("Iteration 1"), 20000);

    expect(fs.existsSync(logFile)).toBe(true);
    const log = readOr(logFile);
    // Before the fix this was 0 bytes for a whole session (the bug report).
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain("Starting shellm loop");
    expect(log).toContain("Iteration 1");
    // `thinkers status`'s `wc -l < run/logs/<name>.log` — the exact number
    // the daemon reported "0 log lines" for before this fix.
    expect(log.split("\n").filter((l) => l !== "").length).toBeGreaterThan(1);
  });
});
