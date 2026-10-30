// behavioralParityE1.test.ts — E1 of behavioral parity round 2: the monolith step ends a run with a literal
// `sleep 1` (thinkers/monolith/step:489-490), before it probes the trajectory and computes wake_at.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMonolithWake, type IdentityConfig } from "../src/monolith.ts";
import { createTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import { recordedModel } from "./support/recordedModel.ts";
import type { EnvSpec } from "../src/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("E1: post-run sleep 1 (thinkers/monolith/step:490)", () => {
  it("sleeps 1000 ms once, after the run's steps are written and before wake_at is computed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "behav-e1-"));
    try {
      const stateDir = path.join(root, "run");
      const workdir = path.join(root, "workdir");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(workdir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");
      const identity: IdentityConfig = {
        name: "pax", identityText: "I am pax.", skillsText: "", goals: "(no goals set)",
        trajDir: path.join(root, "trajectories"), workdir, binDir: path.resolve(HERE, "../bin"), stateDir,
        model: "m", env: { name: "t", type: "local" } as EnvSpec,
      };
      const traj = createTrajectory(identity.trajDir);
      let clock = 1_800_000_000_000; // fake clock, ms
      const sleeps: Array<{ ms: number; typesSeen: string[] }> = [];
      const res = await runMonolithWake({
        trajectory: traj, identity,
        llm: recordedModel("monolith", "quiet-idle", { cycle: true }), // a real quiet wake's idle answer, reused
        sandbox: new LocalSandbox(), trigger: { triggerType: "monolith-wake" }, env: {},
        now: () => clock,
        postRunSleep: async (ms) => {
          sleeps.push({ ms, typesSeen: (traj.read() as Array<{ type?: string }>).map((s) => String(s.type)) });
          clock += ms;
        },
      });
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]!.ms).toBe(1000);
      expect(sleeps[0]!.typesSeen).toContain("final"); // the run is over when the sleep starts
      expect(sleeps[0]!.typesSeen).not.toContain("idle"); // the fallback idle is written after it
      // wake_at is computed from the clock AFTER the sleep (backoff level 1 -> 5 s with the default ladder).
      expect(res.wakeAtEpoch).toBe(Math.floor(clock / 1000) + res.nextDelay);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
