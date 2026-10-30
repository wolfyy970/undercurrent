// golden.ts — load a golden trace and isolate a single monolith wake.
//
// A "wake" = one shellm-run header + every step carrying that run's run_id, in
// file order. Cross-cutting chat steps (responder message/reply_claim/observation,
// which carry NO run_id) are naturally excluded — they belong to the responder
// loop, not the monolith wake (SPEC §2.4).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Step } from "../src/types.js";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");

export function loadTrace(name: string): Step[] {
  const raw = fs.readFileSync(path.join(GOLDEN_DIR, name), "utf8");
  const out: Step[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as Step);
  }
  return out;
}

export interface Wake {
  header: Step & { type: "shellm-run" };
  /** header + all steps with run_id === header.step_id, in file order. */
  steps: Step[];
  stepTypes: string[];
}

/** Return the Nth monolith wake (shellm-run headers in file order, 0-based). */
export function isolateWake(steps: Step[], n = 0): Wake {
  const headers = steps.filter((s) => (s as { type?: string }).type === "shellm-run");
  const header = headers[n] as (Step & { type: "shellm-run" }) | undefined;
  if (!header) throw new Error(`no shellm-run header #${n} in trace`);
  const runId = (header as { step_id: string }).step_id;
  const wakeSteps: Step[] = [header];
  for (const s of steps) {
    if (s === header) continue;
    if ((s as { run_id?: string }).run_id === runId) wakeSteps.push(s);
  }
  return {
    header,
    steps: wakeSteps,
    stepTypes: wakeSteps.map((s) => String((s as { type?: string }).type ?? "")),
  };
}

/**
 * Reconstruct the ordered per-turn structure of a wake for replay:
 * for each reasoning step (a model turn), capture its `thought`, its `cmd`, and
 * the durable step (observation/thought) the turn's bash appended — identified as
 * the narrative step(s) immediately PRECEDING this reasoning within the run
 * (trace-VERIFIED ordering: a turn's bash-written steps land just before that
 * turn's reasoning+shell-output). The final turn is the one whose reasoning is
 * followed by the run's `final` step.
 */
export interface WakeTurn {
  thought: string;
  cmd: string;
  /** durable steps this turn's bash appended, in order (obs/thought). */
  durable: { type: string; content: string; source: string }[];
  /** does this turn terminate the run (a `final` step follows it)? */
  isFinal: boolean;
}

export function wakeTurns(wake: Wake): WakeTurn[] {
  const s = wake.steps;
  const turns: WakeTurn[] = [];
  let pendingDurable: { type: string; content: string; source: string }[] = [];

  for (let i = 0; i < s.length; i++) {
    const step = s[i] as Record<string, unknown>;
    const t = String(step["type"] ?? "");
    if (t === "observation" || t === "thought" || t === "idle") {
      pendingDurable.push({
        type: t,
        content: String(step["content"] ?? ""),
        source: String(step["source"] ?? "monolith"),
      });
    } else if (t === "reasoning") {
      const next = s[i + 1] as Record<string, unknown> | undefined;
      // the terminating turn's reasoning is eventually followed by `final`
      const afterOutput = s[i + 2] as Record<string, unknown> | undefined;
      const isFinal =
        (next && String(next["type"]) === "final") ||
        (afterOutput && String(afterOutput["type"]) === "final") ||
        false;
      turns.push({
        thought: String(step["thought"] ?? ""),
        cmd: String(step["cmd"] ?? ""),
        durable: pendingDurable,
        isFinal: Boolean(isFinal),
      });
      pendingDurable = [];
    }
    // shell-output / prompt / shellm-run / final are structural, skipped here
  }
  return turns;
}
