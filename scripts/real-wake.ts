// real-wake.ts — MANUAL script: run one monolith wake against the real
// OpenRouter model (deepseek/deepseek-v4-flash-0731). NOT part of the test
// suite (the tests replay recorded responses deterministically).
//
// Usage:
//   pnpm build                     # emit dist/
//   node dist/scripts/real-wake.js # one real wake (spends ~a few cents)
//
// The OpenRouter key is read from $OPENROUTER_API_KEY at runtime and is NEVER
// written to any file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrajectory } from "../src/trajectory.ts";
import { runMonolithWake } from "../src/monolith.ts";
import { buildIdentityConfig } from "../src/steprun.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import { OpenRouterClient } from "../src/llm.ts";

function loadOpenRouter(): { apiKey: string; baseUrl: string; model: string } {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("set OPENROUTER_API_KEY to run against the real model");
  return {
    apiKey,
    baseUrl: process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
    model: process.env["SHELLM_MODEL"] ?? "deepseek/deepseek-v4-flash-0731",
  };
}

async function main(): Promise<void> {
  const or = loadOpenRouter();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-real-"));
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const traj = createTrajectory(trajDir);
  traj.append({ type: "thought", content: "I'm here.", source: "seed" });

  // The identity and skills prompts are rendered exactly as every real wake
  // renders them (`buildIdentityConfig`: `identity prompt` + `skills prompt`,
  // thinkers/_lib/common.sh:281-282), from this throwaway identity dir. No
  // hand-written placeholder text.
  const identity = {
    ...buildIdentityConfig({
      env: {
        ...(process.env as Record<string, string>),
        IDENTITY_DIR: root,
        IDENTITY_NAME: "pax",
        TRAJ_DIR: trajDir,
        TRAJ_ID: traj.trajId,
        SHELLM_WORKDIRS_DIR: workdir,
      },
      model: or.model,
    }),
    stateDir,
  };

  const llm = new OpenRouterClient({
    apiKey: or.apiKey,
    baseUrl: or.baseUrl,
    model: or.model,
    effort: "high",
  });

  console.log(`Running one real monolith wake on ${or.model} …`);
  const result = await runMonolithWake({
    trajectory: traj,
    identity,
    llm,
    sandbox: new LocalSandbox(),
    trigger: { triggerType: "manual-trigger", triggerSource: "thinkers-cli" },
    // Cap iterations so a chatty model can't run up spend on a smoke test.
    constants: { maxIterations: Number(process.env["MAX_ITERS"] ?? 8) },
  });

  const wakeSteps = traj.read().filter((s) => (s as { run_id?: string }).run_id === result.runStepId);
  console.log("\nwake result:", {
    wakeReason: result.wakeReason,
    stopReason: result.stopReason,
    iterations: result.iterations,
    didWork: result.didWork,
    nextDelay: result.nextDelay,
  });
  console.log("\nstep sequence:");
  console.log(["shellm-run", ...wakeSteps.map((s) => String((s as { type?: string }).type))].join(" "));
  console.log(`\ntrajectory written to: ${traj.trajFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
