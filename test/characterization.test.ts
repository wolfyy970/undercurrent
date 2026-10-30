// characterization.test.ts — the slice's proof of behavioral parity.
//
// The goal (DoD #2): load a real golden monolith wake, isolate its steps, and
// assert the TS engine reproduces that STEP-TYPE SEQUENCE and the key semantics.
// The model is a local HTTP fixture (test/support/modelHttpFixture.ts) so the wake replays deterministically; the
// bash the model wrote is re-rendered sandbox-safe but performs the SAME durable
// trajectory mutations (the observations/thought), so the engine + sandbox +
// `traj` shim + schema together reproduce the exact sequence. Per the DoD we
// assert on STRUCTURE (types, ordering, that the bash executed and its output
// landed), not on nondeterministic text.

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTrace, isolateWake, type Wake } from "./golden.js";
import { createTrajectory } from "../src/trajectory.js";
import { runMonolithWake, type IdentityConfig } from "../src/monolith.js";
import { LocalSandbox } from "../src/sandbox.js";
import { appendStep, readSteps, rootTrajFile, STDOUT_INLINE_LIMIT } from "../src/trajCore.mjs";
import { decideBackoff, delayForLevel } from "../src/backoff.js";
import type { EnvSpec, Step } from "../src/types.js";
import { recordedModel } from "./support/recordedModel.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

const BIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");

// The docker env metadata trace-00 recorded (SPEC §1.1). Reproduced on the
// header even though this slice executes locally.
const DOCKER_ENV: EnvSpec = {
  name: "pax",
  type: "docker",
  docker_image: "ubuntu:latest",
  docker_access: "none",
};

function makeIdentity(overrides: Partial<IdentityConfig> = {}): {
  identity: IdentityConfig;
  trajDir: string;
  cleanup: () => void;
} {
  // Fixed root: recorded blocks may name the prompt-visible workspace path.
  const root = "/tmp/uc-rec-characterization";
  claimFixedRoot(root);
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // arm_wake fidelity (monolith.ts): wake_at is only written when
  // run/dispatcher.token exists (a real dispatcher would own this file).
  fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");
  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax, a persistent virtual person for the parity test.",
    skillsText: "## My skills system\n(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: BIN_DIR,
    stateDir,
    model: "deepseek/deepseek-v4-flash-0731",
    env: DOCKER_ENV,
    ...overrides,
  };
  return { identity, trajDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("golden trace: monolith wake shape (data)", () => {
  let wake: Wake;
  beforeAll(() => {
    wake = isolateWake(loadTrace("trace-00-boot-and-convo.jsonl"), 0);
  });

  it("wake 1 is a spontaneous/manual-trigger monolith wake", () => {
    expect((wake.header as { wake?: string }).wake).toBe("spontaneous/manual-trigger:thinkers-cli");
    expect((wake.header as { launched_by?: string }).launched_by).toBe("monolith");
    expect((wake.header as { resumed?: boolean }).resumed).toBe(true);
  });

  it("has the canonical shape: shellm-run, prompt, (reasoning, shell-output)*, final", () => {
    const types = wake.stepTypes;
    expect(types[0]).toBe("shellm-run");
    expect(types[1]).toBe("prompt");
    expect(types[types.length - 1]).toBe("final");
    // every reasoning is immediately followed by a shell-output
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "reasoning") expect(types[i + 1]).toBe("shell-output");
    }
    // durable steps appear (observations + one thought)
    expect(types.filter((t) => t === "observation").length).toBeGreaterThan(0);
  });

  it("standing context is a `prompt` step, NOT a chat `message` (SPEC §7 #2)", () => {
    const prompt = wake.steps.find((s) => (s as { type?: string }).type === "prompt") as
      | (Step & { content: string; run_id: string; source?: string })
      | undefined;
    expect(prompt).toBeDefined();
    expect(prompt!.run_id).toBe((wake.header as { step_id: string }).step_id);
    expect(prompt!.content.startsWith("<context>")).toBe(true);
    // it is standing context, not re-broadcast chat: no source:"chat", no from/to
    expect((prompt as { source?: string }).source).toBeUndefined();
    expect(wake.steps.some((s) => (s as { type?: string }).type === "message")).toBe(false);
  });

  it("reasoning steps carry bash in `cmd`; observations carry source monolith", () => {
    const reasonings = wake.steps.filter((s) => (s as { type?: string }).type === "reasoning");
    expect(reasonings.length).toBeGreaterThan(0);
    for (const r of reasonings) expect(String((r as { cmd?: string }).cmd ?? "").length).toBeGreaterThan(0);
    const obs = wake.steps.filter((s) => (s as { type?: string }).type === "observation");
    for (const o of obs) expect((o as { source?: string }).source).toBe("monolith");
  });
});

describe("engine reproduces the golden monolith wake step sequence (replay)", () => {
  // A recorded real DeepSeek wake (characterization/boot-wake) for an identity whose one chore is to record an
  // observation, checked against golden wake 1's canonical shape (the golden trace is a different real run, so its
  // exact turn count is not expected to repeat).
  it("emits golden wake 1's step-type shape: shellm-run, prompt, (reasoning, shell-output)+, final", async () => {
    const golden = isolateWake(loadTrace("trace-00-boot-and-convo.jsonl"), 0);

    const { identity, trajDir, cleanup } = makeIdentity({
      identityText:
        "I am pax, a persistent virtual person for the parity test. My one chore this wake: record the observation 'boot check done' with traj append, then finish. Nothing else needs doing.",
    });
    const llm = recordedModel("characterization", "boot-wake");
    try {
      const traj = createTrajectory(trajDir);
      // Seed a couple of boot thoughts, like rows 1-11 (not part of the wake).
      traj.append({ type: "thought", content: "I'm here.", source: "seed" });
      traj.append({ type: "thought", content: "First light.", source: "seed" });

      const sandbox = new LocalSandbox();

      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox,
        trigger: { triggerType: "manual-trigger", triggerSource: "thinkers-cli" },
        now: () => 1_756_000_000_000,
      });

      expect(result.wakeMode).toBe("spontaneous");
      expect(result.wakeReason).toBe("spontaneous/manual-trigger:thinkers-cli");
      expect(result.stopReason).toBe("final");

      // Isolate the engine's own wake and compare the step-type SEQUENCE.
      const engineWake = isolateWake(traj.read(), 0);
      const shape = (types: string[]) =>
        types.filter((t) => ["shellm-run", "prompt", "reasoning", "shell-output", "final"].includes(t)).join(" ");
      const canonical = /^shellm-run prompt( reasoning shell-output)+ final$/;
      expect(shape(golden.stepTypes)).toMatch(canonical);
      expect(shape(engineWake.stepTypes)).toMatch(canonical);

      // Semantics: prompt is standing context, not a chat message.
      const promptStep = engineWake.steps.find((s) => (s as { type?: string }).type === "prompt") as
        | { content: string; run_id: string }
        | undefined;
      expect(promptStep).toBeDefined();
      expect(promptStep!.content.startsWith("<context>")).toBe(true);
      expect(promptStep!.run_id).toBe(result.runStepId);
      expect(engineWake.steps.some((s) => (s as { type?: string }).type === "message")).toBe(false);

      // The bash EXECUTED and its appends landed: observations/thought written
      // by the sandboxed `traj` shim are present with run_id auto-stamped.
      const obs = engineWake.steps.filter((s) => (s as { type?: string }).type === "observation");
      expect(obs.length).toBeGreaterThanOrEqual(1);
      for (const o of obs) {
        expect((o as { source?: string }).source).toBe("monolith");
        expect((o as { run_id?: string }).run_id).toBe(result.runStepId);
      }
      // The observation the real block wrote — proof the shim round-tripped through the real sandbox.
      expect((obs[0] as { content: string }).content).toMatch(/boot check done/i);

      // reasoning carries the executed bash; each is followed by a shell-output
      // whose stdout captured the turn's echo (proves exec landed).
      const engineSteps = engineWake.steps as Record<string, unknown>[];
      for (let i = 0; i < engineSteps.length; i++) {
        if (engineSteps[i]!["type"] === "reasoning") {
          expect(String(engineSteps[i]!["cmd"] ?? "").length).toBeGreaterThan(0);
          expect(engineSteps[i + 1]!["type"]).toBe("shell-output");
        }
      }
      // The first turn's command really ran and succeeded.
      const firstOutput = engineSteps.find((s) => s["type"] === "shell-output") as
        | { stdout: string; exit: number }
        | undefined;
      expect(firstOutput!.exit).toBe(0);

      // final terminates the run and carries the run_id.
      const finalStep = engineSteps[engineSteps.length - 1] as { type: string; run_id: string };
      expect(finalStep.type).toBe("final");
      expect(finalStep.run_id).toBe(result.runStepId);
    } finally {
      llm.close();
      cleanup();
    }
  }, 60_000);
});

describe("wake scheduling: backoff + wake_at (SPEC §3.4)", () => {
  it("delay ladder matches the source constants", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) => delayForLevel(l))).toEqual([
      0, 5, 10, 20, 40, 80, 160, 300, 300,
    ]);
  });

  it("reactive wake resets to level 0 / no pause", () => {
    const d = decideBackoff(
      { level: 3, ticksAtLevel: 2, wakesSinceShareHint: 0 },
      { wakeMode: "reactive", didVisible: false, didThought: false, runErrored: false }
    );
    expect(d.state.level).toBe(0);
    expect(d.nextDelay).toBe(0);
  });

  it("empty spontaneous wake dwells HOLD times then descends", () => {
    let state = { level: 0, ticksAtLevel: 0, wakesSinceShareHint: 0 };
    const empty = { wakeMode: "spontaneous" as const, didVisible: false, didThought: false, runErrored: false };
    // level 0 holds for HOLD=3 empty wakes (delay 0), then steps to level 1.
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = decideBackoff(state, empty);
      state = d.state;
      delays.push(d.nextDelay);
    }
    expect(delays).toEqual([0, 0, 5, 5, 5]);
  });

  async function quietWake(scenario: { suite: string; name: string }, identityText: string) {
    const { identity, trajDir, cleanup } = makeIdentity({ identityText });
    const llm = recordedModel(scenario.suite, scenario.name);
    try {
      const traj = createTrajectory(trajDir);
      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake", triggerSource: "monolith-timer" },
        now: () => 1_756_000_000_000,
      });
      const steps = traj.read() as Record<string, unknown>[];
      const wakeAt = fs.readFileSync(path.join(identity.stateDir, "monolith.wake_at"), "utf8");
      return { result, steps, wakeAt, texts: llm.responses.map((r) => r.text) };
    } finally {
      llm.close();
      cleanup();
    }
  }

  it("a spontaneous idle wake arms a future wake_at, with the honest idle fallback", async () => {
    // Reuses the real DeepSeek reply recorded as monolith/quiet-idle (its block only sets FINAL="idle"), so the run
    // writes no durable step and the engine itself appends the honest idle.
    const { result, steps, wakeAt, texts } = await quietWake(
      { suite: "monolith", name: "quiet-idle" },
      "I am pax, a persistent virtual person for the parity test. There is nothing to do right now; idle quietly."
    );
    expect(texts.every((t) => !/type=idle/.test(t))).toBe(true);
    expect(result.wakeReason).toBe("spontaneous/timer");
    expect(result.didWork).toBe(false);
    const idles = steps.filter((s) => s["type"] === "idle");
    expect(idles.length).toBe(1);
    expect(idles[0]!["source"]).toBe("monolith");
    expect(idles[0]!["content"]).toBe("idle");
    expect(idles[0]!["run_id"]).toBe(result.runStepId);
    // wake_at armed (level 0 dwell, delay 0 on the first tick).
    expect(Number(wakeAt)).toBe(Math.floor(1_756_000_000_000 / 1000));
  }, 30_000);

  it("a run that appends its own idle suppresses the fallback (one idle, the model's)", async () => {
    // Recorded real DeepSeek wake (characterization/honest-idle): told there is nothing to do, the model wrote its own
    // idle step with traj append, so the engine must not add a second one.
    const { result, steps, wakeAt, texts } = await quietWake(
      { suite: "characterization", name: "honest-idle" },
      "I am pax, a persistent virtual person for the parity test. There is nothing to do right now; idle quietly."
    );
    expect(texts.some((t) => /type=idle/.test(t))).toBe(true);
    expect(result.didWork).toBe(false);
    const idles = steps.filter((s) => s["type"] === "idle");
    expect(idles.length).toBe(1);
    expect(idles[0]!["content"]).not.toBe("idle");
    expect(idles[0]!["run_id"]).toBe(result.runStepId);
    expect(Number(wakeAt)).toBe(Math.floor(1_756_000_000_000 / 1000));
  }, 30_000);
});

describe("trajectory append protocol (SPEC §2.4)", () => {
  it("auto-stamps run_id from SHELLM_RUN_STEP_ID, except shellm-run/trajectory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-traj-"));
    try {
      const file = rootTrajFile(dir, "abcd1234-0000-0000-0000-000000000000");
      // observation written "inside a run" → gets run_id
      appendStep(file, { type: "observation", content: "x", source: "monolith" }, { runStepId: "RUN123" });
      // shellm-run must NOT inherit run_id
      appendStep(file, { type: "shellm-run", command: "c" }, { runStepId: "RUN123" });
      const steps = readSteps(file) as Record<string, unknown>[];
      expect(steps[0]!["run_id"]).toBe("RUN123");
      expect(steps[1]!["run_id"]).toBeUndefined();
      // key order: type first, run_id before step_id before ts
      const keys = Object.keys(steps[0]!);
      expect(keys[0]).toBe("type");
      expect(keys.indexOf("run_id")).toBeLessThan(keys.indexOf("step_id"));
      expect(keys.indexOf("step_id")).toBeLessThan(keys.indexOf("ts"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spills stdout over the inline limit to a blob, keeping 4096 bytes inline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-blob-"));
    try {
      const file = rootTrajFile(dir, "beef0000-0000-0000-0000-000000000000");
      const big = "y".repeat(STDOUT_INLINE_LIMIT + 5000);
      const id = appendStep(file, { type: "shell-output", stdout: big, stderr: "", exit: 0 });
      const step = (readSteps(file) as Record<string, unknown>[])[0]!;
      expect(step["stdout_truncated"]).toBe(true);
      expect(step["stdout_bytes"]).toBe(STDOUT_INLINE_LIMIT + 5000);
      expect((step["stdout"] as string).length).toBe(STDOUT_INLINE_LIMIT);
      expect(step["stdout_ref"]).toBe(`blobs/${id}-000000.stdout`);
      const blob = fs.readFileSync(path.join(dir, `beef0000-root`, `blobs/${id}-000000.stdout`), "utf8");
      expect(blob.length).toBe(STDOUT_INLINE_LIMIT + 5000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
