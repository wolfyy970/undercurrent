// behavioralParity.test.ts — failing tests for port gaps found by the real-model behavioral parity
// experiment (docs/BEHAVIORAL-PARITY.md, 2026-10-27, upstream 2e39a3f vs this port, DeepSeek flash).
// Each test cites the upstream line it mirrors. They FAIL on the port as shipped (35a8c3c) and pass
// with the behavioral-parity fixes.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMonolithWake, type IdentityConfig } from "../src/monolith.js";
import { createTrajectory } from "../src/trajectory.js";
import { LocalSandbox } from "../src/sandbox.js";
import type { EnvSpec } from "../src/types.js";
import { recordedModel } from "./support/recordedModel.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(path.resolve(HERE, ".."), "bin");
const LOCAL_ENV: EnvSpec = { name: "t", type: "local" };
// A real quiet wake's idle answer (monolith/quiet-idle, reused: these tests assert the prompt, not the reply).
const idle = () => recordedModel("monolith", "quiet-idle", { cycle: true });

function setup(nThoughts: number, env: Record<string, string> = {}, fixedRoot?: string) {
  // A fixed root when a recorded block may name prompt-visible paths.
  const root = fixedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "behav-par-"));
  if (fixedRoot) claimFixedRoot(fixedRoot);
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");
  const identity: IdentityConfig = {
    name: "pax", identityText: "I am pax.", skillsText: "(no skills installed)", goals: "(no goals set)",
    trajDir, workdir, binDir: BIN_DIR, stateDir, model: "test-model", env: LOCAL_ENV,
  };
  const traj = createTrajectory(trajDir);
  for (let i = 0; i < nThoughts; i++)
    fs.appendFileSync(traj.trajFile, JSON.stringify({ step_id: `s${String(i).padStart(3, "0")}`, type: "thought", content: `t${i}`, source: "seed", ts: new Date(Date.UTC(2026, 9, 27, 0, 0, i)).toISOString() }) + "\n");
  return { identity, traj, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function firstPrompt(s: ReturnType<typeof setup>): Promise<string> {
  const llm = idle();
  await runMonolithWake({ trajectory: s.traj, identity: s.identity, llm, sandbox: new LocalSandbox(), trigger: { triggerType: "monolith-wake" }, env: s.env });
  llm.close();
  const p = (s.traj.read() as Array<Record<string, unknown>>).find((x) => x["type"] === "prompt") as { content?: string } | undefined;
  return String(p?.content ?? "");
}

describe("behavioral parity gaps vs upstream 2e39a3f", () => {
  it("B1: 'all thoughts — the stream may be circling' routing hint (thinkers/monolith/step:199-203)", async () => {
    const s = setup(10);
    try {
      const prompt = await firstPrompt(s);
      expect(prompt).toContain("The last few steps are all thoughts — the stream may be circling; consider acting, recalling, or advancing decisively.");
    } finally { s.cleanup(); }
  });

  it("B1b: 'most recent step is an ACTION that has no observation yet' hint (step:194-198)", async () => {
    const s = setup(3);
    try {
      fs.appendFileSync(s.traj.trajFile, JSON.stringify({ step_id: "act1", type: "action", content: "do the thing", ts: new Date(Date.UTC(2026, 9, 27, 1)).toISOString() }) + "\n");
      const prompt = await firstPrompt(s);
      expect(prompt).toContain("The most recent step is an ACTION that has no observation yet — it may need carrying out (act).");
    } finally { s.cleanup(); }
  });

  it("B2: THINK_CONTEXT_TAIL env sets the recent-stream window (step:37 `${THINK_CONTEXT_TAIL:-20}`)", async () => {
    const s = setup(40, { THINK_CONTEXT_TAIL: "30" });
    try {
      const prompt = await firstPrompt(s);
      expect(prompt).toContain("Recent stream (last 30 durable steps;");
    } finally { s.cleanup(); }
  });


  it("B5: monolith runs with --context-scope run — a second wake's first LLM call carries only the prompt, not the earlier wake's turns (thinkers/monolith/step:485)", async () => {
    const s = setup(3, {}, "/tmp/uc-rec-behav-b5");
    // The wake's chore is in the identity text, so the real model's first wake runs a command, then idles.
    s.identity.identityText = "I am pax. My one chore this wake: run `echo hello-from-wake-1` once, then idle.";
    try {
      const wake = async (llm: import("../src/llm.js").LlmClient) =>
        runMonolithWake({ trajectory: s.traj, identity: s.identity, llm, sandbox: new LocalSandbox(), trigger: { triggerType: "monolith-wake" }, env: s.env });
      // wake 1: two iterations (an echo, then FINAL) so the trajectory holds reasoning/shell-output turns
      const first = recordedModel("behavioralParity", "echo-then-idle");
      await wake(first);
      first.close();
      // wake 1 left a turn on the trajectory (the real model ran the echo and finished in one block).
      const steps = s.traj.read() as Array<Record<string, unknown>>;
      expect(steps.some((x) => x["type"] === "shell-output" && String(x["content"] ?? x["output"] ?? "").includes("hello-from-wake-1") || (x["type"] === "shell-output" && JSON.stringify(x).includes("hello-from-wake-1")))).toBe(true);
      s.identity.identityText = "I am pax.";
      const second = idle();
      await wake(second);
      second.close();
      // upstream (real run, 2e39a3f): every wake's first request is [system, user] — one message after the system prompt.
      const msgs = second.requests[0]!["messages"] as Array<{ role: string }>;
      expect(msgs.filter((m) => m.role !== "system")).toHaveLength(1);
    } finally { s.cleanup(); }
  });
});
