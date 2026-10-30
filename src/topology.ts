// topology.ts — the TWO-THINKER topology over ONE stream (SPEC §4.4).
//
// Assembles the shipped 2-thinker config: the RESPONDER (subscribes to inbound
// `message`, fast single-pass reply, NO_REPLY silence) and the MONOLITH (the
// whole mind; subscribes to observation/action/merge/monolith-wake with
// trigger_self:false). Both append to ONE ObservableTrajectory — the single
// append-only stream — and each projects its own context from it (the monolith's
// shellm reads the whole log via buildContext; the responder filters to message
// turns). The reactive coupling falls out of the subscriptions: an inbound
// message → responder reply + observation → the observation reactively wakes the
// monolith (§3.3), which deliberates but does not reply.
//
// A THIRD thinker, RETRIEVAL (passive no-LLM memory recall; subscribes to
// thought/message/observation, trigger_self:false), is OPT-IN via `retrieval`
// in the config — upstream bundles it into every identity with a `disabled`
// marker, so the shipped default stays the two-thinker topology above. When
// enabled it appends an external-source `observation` onto the same stream,
// which reactively wakes the monolith (`wake:"reactive/observation:retrieval"`).
// Bus caveat: this in-process bus only carries in-process appends, so the
// monolith's own shim-written thoughts/observations do not reach retrieval
// here (see the fidelity note in dispatcher.ts); injected/seed steps and the
// responder's observations do.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Trajectory } from "./trajectory.ts";
import type { LlmClient } from "./llm.ts";
import type { Sandbox } from "./sandbox.ts";
import { runMonolithWake, type IdentityConfig } from "./monolith.ts";
import { runResponder } from "./responder.ts";
import { runRetrievalStep, RETRIEVAL_SUBSCRIPTION, THINKER_NAME as RETRIEVAL_NAME } from "./retrieval.ts";
import { readMemoryFiles } from "./mem.ts";
import type { ShellmConstants } from "./shellm.ts";
import {
  Dispatcher,
  ObservableTrajectory,
  type TriggerStep,
  type DispatchEvent,
} from "./dispatcher.ts";

// Shipped subscriptions (thinkers/*/subscriptions.jsonl, SPEC §3.2). Watchdog 0
// (off) for both — the monolith's liveness is the wake_at re-arm, not a watchdog.
const MONOLITH_SUB = {
  types: ["observation", "action", "merge", "monolith-wake"],
  triggerSelf: false,
  watchdogSecs: 0,
};
const RESPONDER_SUB = { types: ["message"], triggerSelf: false, watchdogSecs: 0 };

/** Opt-in config for the retrieval thinker (absent = upstream's `disabled` marker). */
export interface RetrievalConfig {
  /** IDENTITY_DIR — state lives at <identityDir>/retrieval/{index.tsv,seen}. */
  identityDir: string;
  /** MEM_DIR — the memories the word index is built over. */
  memDir: string;
  /** Knobs: RETRIEVAL_INDEX, RETRIEVAL_MIN_HITS, RETRIEVAL_SEEN, RETRIEVAL_SEMANTIC. */
  env?: Record<string, string>;
  /** `mem search` seam for RETRIEVAL_SEMANTIC=1; absent → no suffix (as without GNU timeout). */
  memSearch?: (query: string) => string;
  stderr?: (s: string) => void;
}

export interface TwoThinkerConfig {
  /** The underlying root trajectory (wrapped in an ObservableTrajectory here). */
  trajectory: Trajectory;
  identity: IdentityConfig; // drives the monolith wake; .name/.identityText/.skillsText feed the responder
  monolithLlm: LlmClient;
  responderLlm: LlmClient;
  sandbox: Sandbox;
  now?: () => number;
  monolithConstants?: Partial<ShellmConstants>;
  claimTtlMs?: number;
  /** Enable the third (retrieval) thinker. Default off, like upstream. */
  retrieval?: RetrievalConfig;
}

export interface TwoThinkerSystem {
  dispatcher: Dispatcher;
  trajectory: ObservableTrajectory;
  /** Append an inbound chat message onto the shared stream (fires the responder). */
  inject(msg: { from: string; to: string; content: string }): string;
  /** Settle all reactive/queued cascades (does not fire scheduled wakes). */
  settle(maxRounds?: number): Promise<void>;
  /** Housekeeping tick at `nowEpoch` (seconds): fire pending + due wake_at. */
  tick(nowEpoch: number): void;
  /** Fire a boot manual-trigger for a thinker (thinkers trigger; §3.8). */
  boot(name: string): void;
  log: DispatchEvent[];
}

export function createTwoThinkerSystem(cfg: TwoThinkerConfig): TwoThinkerSystem {
  const traj = new ObservableTrajectory(cfg.trajectory);
  const now = cfg.now ?? (() => Date.now());

  // arm_wake fidelity gate (monolith.ts): runMonolithWake only writes
  // monolith.wake_at when run/dispatcher.token exists. This in-process harness
  // IS its own dispatcher (no daemon process), so it owns a token for the
  // lifetime of the system — harmless synthetic value, never read as a real
  // ownership token outside this harness.
  fs.mkdirSync(cfg.identity.stateDir, { recursive: true });
  const tokenFile = path.join(cfg.identity.stateDir, "dispatcher.token");
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${Math.floor(now() / 1000)}.0.0`);

  const dispatcher = new Dispatcher(traj, {
    stateDir: cfg.identity.stateDir,
    identityName: cfg.identity.name,
    ...(cfg.claimTtlMs !== undefined ? { claimTtlMs: cfg.claimTtlMs } : {}),
  });

  // MONOLITH — map the trigger step to a wake. A reactive observation carries
  // trigger.type="observation", source="responder", step_id=<obs id> →
  // wake="reactive/observation:responder", trigger_step=<obs id>. A scheduled
  // monolith-wake → wake="spontaneous/timer" with no trigger_step.
  dispatcher.register({
    name: "monolith",
    subscription: MONOLITH_SUB,
    run: async (trigger: TriggerStep) => {
      await runMonolithWake({
        trajectory: traj,
        identity: cfg.identity,
        llm: cfg.monolithLlm,
        sandbox: cfg.sandbox,
        trigger: {
          triggerType: String(trigger.type ?? ""),
          ...(trigger.source !== undefined ? { triggerSource: String(trigger.source) } : {}),
          ...(trigger.step_id !== undefined ? { triggerStepId: String(trigger.step_id) } : {}),
        },
        now,
        ...(cfg.monolithConstants ? { constants: cfg.monolithConstants } : {}),
      });
    },
  });

  // RESPONDER — the trigger step IS the inbound (or re-delivered outbound) message.
  dispatcher.register({
    name: "responder",
    subscription: RESPONDER_SUB,
    run: async (trigger: TriggerStep) => {
      await runResponder({
        trajectory: traj,
        llm: cfg.responderLlm,
        identityName: cfg.identity.name,
        identityText: cfg.identity.identityText,
        skillsText: cfg.identity.skillsText,
        model: cfg.identity.model,
        ...(cfg.identity.execEnv?.["MEM_DIR"] ? { memDir: cfg.identity.execEnv["MEM_DIR"] } : {}),
        trigger: {
          type: String(trigger.type ?? ""),
          ...(trigger.content !== undefined ? { content: String(trigger.content) } : {}),
          ...(trigger.step_id !== undefined ? { step_id: String(trigger.step_id) } : {}),
          ...(trigger.from !== undefined ? { from: String(trigger.from) } : {}),
          ...(trigger.to !== undefined ? { to: String(trigger.to) } : {}),
          ...(trigger.source !== undefined ? { source: String(trigger.source) } : {}),
          ...(trigger.ts !== undefined ? { ts: String(trigger.ts) } : {}),
        },
        now,
        ...(cfg.claimTtlMs !== undefined ? { claimTtlMs: cfg.claimTtlMs } : {}),
      });
    },
  });

  // RETRIEVAL (opt-in) — the trigger step IS the stdin JSON the Bash step reads;
  // the append goes through the observable stream so the bus sees it. Registered
  // last: upstream's dispatcher visits thinker dirs in glob order (monolith,
  // responder, retrieval).
  if (cfg.retrieval) {
    const r = cfg.retrieval;
    const env: Record<string, string> = {
      IDENTITY_DIR: r.identityDir,
      TRAJ_DIR: cfg.identity.trajDir,
      TRAJ_ID: traj.trajId,
      MEM_DIR: r.memDir,
      ...(r.env ?? {}),
    };
    dispatcher.register({
      name: RETRIEVAL_NAME,
      subscription: RETRIEVAL_SUBSCRIPTION,
      run: async (trigger: TriggerStep) => {
        runRetrievalStep(trigger, env, {
          readMemoryFiles,
          appendStep: (record, opts) => traj.append(record, opts),
          ...(r.memSearch ? { memSearch: r.memSearch } : {}),
          stderr: r.stderr ?? ((s) => process.stderr.write(s)),
        });
      },
    });
  }

  return {
    dispatcher,
    trajectory: traj,
    inject: (msg) =>
      dispatcher.inject({ type: "message", content: msg.content, from: msg.from, to: msg.to, source: "chat" }),
    settle: (maxRounds?: number) => dispatcher.settle(maxRounds),
    tick: (nowEpoch: number) => dispatcher.tick(nowEpoch),
    boot: (name: string) => dispatcher.bootTrigger(name),
    log: dispatcher.log,
  };
}
