// live-loop.test.ts — the lane's deterministic acceptance oracle, NO network
// (PLAN-daemon §8 "Live multi-wake proof", the vitest form): `identity new`,
// `thinkers start monolith responder` against recorded real DeepSeek replies served on LLM_API_URL
// (test/fixtures/recordings/live-loop/, test/support/README.md),
// an out-of-process `chat send`, then: a responder reply with reply_to; a
// reactive monolith wake (wake:"reactive/observation:responder"); >=2
// spontaneous/timer wakes with a growing backoff level
// (MONOLITH_BACKOFF_HOLD=1); the run/ contract byte-exact at each stage;
// `thinkers stop` end state; a restart resuming the persisted backoff level.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { thinkersStart, thinkersStop } from "../src/thinkersctl.ts";
import { pidAlive } from "../src/runstate.ts";
import { rootTrajFile } from "../src/trajCore.mjs";
import { closeRecordedThinkers, IDLE_IDENTITY, liveLoopEnv } from "./support/recordedThinkers.ts";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin");

const roots: string[] = [];
afterEach(async () => {
  try {
    await stopAll();
  } finally {
    closeRecordedThinkers();
  }
});

async function stopAll(): Promise<void> {
  while (roots.length) {
    const root = roots.pop()!;
    try {
      const idDir = path.join(root, "pax");
      const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
      await thinkersStop(env, [], { force: true });
    } catch {
      /* nothing to stop */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function poll<T>(fn: () => T | undefined, timeoutMs: number, stepMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readSteps(trajFile: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(trajFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("live-loop (recorded replies, no network)", () => {
  it(
    "identity new -> thinkers start -> chat send -> reply+reactive wake -> backoff climbs -> stop -> restart resumes backoff",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-live-loop-"));
      roots.push(root);

      // ---- fixtures --------------------------------------------------------
      // Monolith: one recorded idle reply, replayed per wake; tests backoff, not content. (Recorded with a one-call
      // guard from an identity steered to idle, then served with `cycle` to every monolith wake.) The responder's and
      // the notes writer's replies are their own recordings for this chat message (one call each).
      const llmEnv = await liveLoopEnv();

      // ---- identity new ------------------------------------------------
      const result = identityNew({ identitiesRoot: root, name: "pax" });
      const idDir = result.identityDir;
      fs.writeFileSync(path.join(idDir, "core_identity_prompt.md"), IDLE_IDENTITY);
      const runDir = path.join(idDir, "run");
      const trajFile = rootTrajFile(path.join(idDir, "trajectories"), result.rootTrajectoryId);

      const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
      env["SHELLM_SANDBOX"] = "local";
      Object.assign(env, llmEnv);
      env["MONOLITH_BACKOFF_HOLD"] = "1"; // dwell exactly one tick per level — fast, deterministic climb

      // ---- thinkers start monolith responder ----------------------------
      const startResult = await thinkersStart(env, ["monolith", "responder"]);
      expect(startResult.ok).toBe(true);
      expect(pidAlive(startResult.dispatcherPid)).toBe(true);

      // run/ contract right after boot.
      expect(fs.readFileSync(path.join(runDir, "dispatcher.pid"), "utf8")).toBe(String(startResult.dispatcherPid));
      expect(fs.readFileSync(path.join(runDir, "dispatcher.token"), "utf8")).toMatch(/^[0-9a-f]{32}$/);
      expect(fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8").trim().split("\n").sort()).toEqual([
        "monolith",
        "responder",
      ]);
      const subMap = fs.readFileSync(path.join(runDir, "sub_map"), "utf8");
      expect(subMap).toContain("monolith\t");
      expect(subMap).toContain("responder\t");

      // The boot kick fires the monolith once even with no reactive trigger —
      // wait for its wake_at to be armed (arm_wake ran with a live token).
      await poll(() => (fs.existsSync(path.join(runDir, "monolith.wake_at")) ? true : undefined), 15_000);

      // ---- out-of-process chat send --------------------------------------
      const send = spawnSync(process.execPath, [path.join(BIN, "chat.mjs"), "send", "--from", "operator", "--to", "pax", "Please remember teal is my favourite colour."], {
        env,
        encoding: "utf8",
      });
      expect(send.status).toBe(0);

      // ---- responder reply with reply_to ---------------------------------
      const replyMsgId = await poll(() => {
        const steps = readSteps(trajFile);
        const msg = steps.find((s) => s["type"] === "message" && s["from"] === "pax") as
          | { reply_to?: string }
          | undefined;
        return msg?.reply_to;
      }, 15_000);
      expect(typeof replyMsgId).toBe("string");

      // ---- reactive monolith wake, triggered by the responder's observation ----
      const reactiveWake = await poll(() => {
        const steps = readSteps(trajFile);
        return steps.find(
          (s) => s["type"] === "shellm-run" && s["wake"] === "reactive/observation:responder"
        ) as Record<string, unknown> | undefined;
      }, 15_000);
      expect(reactiveWake["launched_by"]).toBe("monolith");

      // PORT-BUG guard: an exec-path breakage (e.g. DockerSandbox forwarding
      // req.env's HOME=<workdir> onto the HOST docker process, breaking every
      // `docker exec`) still lets the model reply and still appends a
      // reactive wake — only command execution fails. Require at least one
      // successful shell-output row so this class of breakage can never pass
      // the lane's acceptance oracle again.
      const successfulExec = readSteps(trajFile).find((s) => s["type"] === "shell-output" && s["exit"] === 0);
      expect(successfulExec).toBeDefined();

      // ---- >=2 further spontaneous/timer wakes with growing backoff -------
      // HOLD=1 steps the level on every empty spontaneous wake: boot -> L1
      // (delay 5s), timer -> L2 (10s), timer -> L3 (20s). Poll the persisted
      // backoff state directly (byte contract: level/ticks_at_level/
      // wakes_since_share_hint, tmp+rename, trailing newline).
      const level2Wait = await poll(() => {
        try {
          const raw = fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8");
          expect(raw.endsWith("\n")).toBe(true);
          const j = JSON.parse(raw) as { level: number };
          return j.level >= 2 ? j.level : undefined;
        } catch {
          return undefined;
        }
      }, 25_000);
      expect(level2Wait).toBeGreaterThanOrEqual(2);

      const timerWakes = readSteps(trajFile).filter((s) => s["wake"] === "spontaneous/timer");
      expect(timerWakes.length).toBeGreaterThanOrEqual(2);
      // No monolith-wake step was ever appended to the trajectory — it is a
      // synthetic dispatch payload only (PLAN-daemon §3).
      expect(readSteps(trajFile).some((s) => s["type"] === "monolith-wake")).toBe(false);

      const dispatcherLog = fs.readFileSync(path.join(runDir, "logs", "dispatcher.log"), "utf8");
      expect(dispatcherLog).toMatch(/\[dispatcher] {3}scheduled wake -> monolith/);

      // ---- thinkers stop --------------------------------------------------
      const stopResult = await thinkersStop(env, [], { force: true });
      expect(stopResult.ok).toBe(true);
      expect(fs.existsSync(path.join(runDir, "dispatcher.pid"))).toBe(false);
      expect(fs.existsSync(path.join(runDir, "dispatcher.token"))).toBe(false);
      expect(fs.existsSync(path.join(runDir, "active_thinkers"))).toBe(false);
      // Backoff state persists across a stop — it is the mind's own memory of
      // its pacing, not dispatcher-session state.
      const persistedLevel = JSON.parse(fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8")) as {
        level: number;
      };
      expect(persistedLevel.level).toBeGreaterThanOrEqual(2);

      // ---- restart resumes the persisted backoff level ---------------------
      const restart = await thinkersStart(env, ["monolith", "responder"]);
      expect(pidAlive(restart.dispatcherPid)).toBe(true);
      // Give the boot kick one wake to run, then confirm the level did not
      // reset to 0 — it continued climbing (or held) from where it left off.
      await poll(() => {
        try {
          const raw = fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8");
          const j = JSON.parse(raw) as { level: number };
          return j.level >= persistedLevel.level ? true : undefined;
        } catch {
          return undefined;
        }
      }, 15_000);
      const afterRestart = JSON.parse(fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8")) as {
        level: number;
      };
      expect(afterRestart.level).toBeGreaterThanOrEqual(persistedLevel.level);

      await thinkersStop(env, [], { force: true });
    },
    60_000
  );
});
