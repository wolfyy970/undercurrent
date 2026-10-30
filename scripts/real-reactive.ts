// real-reactive.ts — MANUAL script: drive the REACTIVE PATH (inbound message →
// responder reply/silence → responder observation → reactive monolith wake)
// against the real OpenRouter model. NOT part of the test suite (the tests replay
// recorded responses deterministically).
//
// Usage:
//   pnpm build                          # emit dist/
//   node dist/scripts/real-reactive.js  # one reactive turn (spends ~a few cents)
//   MSG="thanks, that's all" node dist/scripts/real-reactive.js   # try a bare ack → NO_REPLY
//
// The OpenRouter key is read from $OPENROUTER_API_KEY at runtime and is NEVER
// written to any file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrajectory } from "../src/trajectory.ts";
import { createTwoThinkerSystem } from "../src/topology.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import { OpenRouterClient } from "../src/llm.ts";
import type { IdentityConfig } from "../src/monolith.ts";
import type { EnvSpec, Step } from "../src/types.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-reactive-"));
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const env: EnvSpec = { name: "pax", type: "local" };
  const identity: IdentityConfig = {
    name: "pax",
    identityText:
      "I am pax, a persistent virtual person. My mind is a log I append to. " +
      "I live on this machine as plain files.",
    skillsText:
      "## My skills system\nEngine tools on PATH: mem, traj, skills, context, chat. " +
      "Use `traj append` to write steps.",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: path.resolve(process.cwd(), "bin"),
    stateDir,
    model: or.model,
    env,
  };

  const traj = createTrajectory(trajDir);
  traj.append({ type: "thought", content: "I'm here.", source: "seed" });

  const mkClient = () =>
    new OpenRouterClient({ apiKey: or.apiKey, baseUrl: or.baseUrl, model: or.model, effort: "high" });

  const system = createTwoThinkerSystem({
    trajectory: traj,
    identity,
    monolithLlm: mkClient(),
    responderLlm: mkClient(),
    sandbox: new LocalSandbox(),
    monolithConstants: { maxIterations: Number(process.env["MAX_ITERS"] ?? 6) },
  });

  const content = process.env["MSG"] ?? "Whats the weather today in Springfield?";
  console.log(`Driving the reactive path on ${or.model}\n  inbound: "${content}"\n`);
  const msgId = system.inject({ from: "operator", to: "pax", content });
  await system.settle();

  const all = system.trajectory.read();
  const t = (s: Step) => String((s as { type?: string }).type ?? "");
  const short = (s: Step) => {
    const r = s as Record<string, unknown>;
    const c = String(r["content"] ?? r["wake"] ?? r["cmd"] ?? "").replace(/\s+/g, " ").slice(0, 70);
    const tag =
      r["source"] !== undefined ? `[${r["source"]}]` : r["from"] !== undefined ? `[${r["from"]}→${r["to"]}]` : "";
    return `${t(s).padEnd(13)} ${tag} ${c}`;
  };

  console.log("resulting single stream:");
  for (const s of all) console.log("  " + short(s));

  const replied = all.some((s) => t(s) === "message" && (s as { from?: string }).from === "pax");
  const noReply = all.some(
    (s) => t(s) === "observation" && (s as { decision?: string }).decision === "no-reply"
  );
  const reactiveWake = all.some(
    (s) => t(s) === "shellm-run" && (s as { wake?: string }).wake === "reactive/observation:responder"
  );
  console.log("\nsummary:", {
    inboundMsg: msgId.slice(0, 8),
    responderReplied: replied,
    responderChoseSilence: noReply,
    monolithReactivelyWoke: reactiveWake,
  });
  console.log(`\ntrajectory written to: ${traj.trajFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
