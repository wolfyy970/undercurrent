// types.ts — the trajectory STEP SCHEMA (SPEC §2.2).
//
// Field names are kept EXACTLY as the Bash writes them (run_id, step_id, ts,
// type, source, content, cmd, thought, stdout, stderr, exit, …) because the
// parity tests diff on them. This is the one place the port must NOT "improve"
// the shape.

/** Every step carries a UUID step_id and an ISO-8601 UTC ms timestamp. */
export interface BaseStep {
  type: string;
  step_id: string;
  ts: string;
}

/** Docker execution-environment metadata recorded on the shellm-run header. */
export interface EnvSpec {
  name: string;
  type: "docker" | "local";
  docker_image?: string;
  docker_image_digest?: string;
  docker_access?: string;
  docker_broker_transport?: string;
  docker_socket?: string;
  privileged?: boolean;
  var_mounts?: unknown[];
}

/** type:"trajectory" — first step; its step_id IS the trajectory id (§2.1). */
export interface TrajectoryStep extends BaseStep {
  type: "trajectory";
  parent_traj?: string;
  parent_traj_ref?: string;
  slug?: string;
}

/** type:"thought" — seed thoughts at boot, or a monolith `think` step. */
export interface ThoughtStep extends BaseStep {
  type: "thought";
  content: string;
  source: string;
  run_id?: string;
  trigger_step?: string;
}

/** type:"shellm-run" — the wake header. run_id of the wake == this step_id. */
export interface ShellmRunStep extends BaseStep {
  type: "shellm-run";
  command: string;
  workdir: string;
  model: string;
  effort: string;
  max_iterations: string;
  max_tokens: string;
  inactivity_timeout: string;
  context_files: string[];
  env: EnvSpec;
  resumed: boolean;
  trigger_step?: string;
  launched_by?: string;
  wake?: string;
}

/** type:"prompt" — the wake's standing context, folded once (§1.2, §7 #2). */
export interface PromptStep extends BaseStep {
  type: "prompt";
  content: string;
  run_id: string;
}

/** type:"reasoning" — model prose (thought) + the bash it emitted (cmd). */
export interface ReasoningStep extends BaseStep {
  type: "reasoning";
  thought: string;
  cmd: string;
  run_id: string;
  llm_s: number;
  in_tok?: number;
  out_tok?: number;
  think_tok?: number;
}

/** type:"shell-output" — captured result of executing a reasoning step's cmd. */
export interface ShellOutputStep extends BaseStep {
  type: "shell-output";
  stdout: string;
  stderr: string;
  exit: number;
  run_id: string;
  exec_s: number;
  stdout_ref?: string;
  stdout_bytes?: number;
  stdout_truncated?: boolean;
  stderr_ref?: string;
  stderr_bytes?: number;
  stderr_truncated?: boolean;
  timed_out?: boolean;
  feedback?: string;
}

/** type:"final" — run terminator. NO-BLOCK variant also carries thought+usage. */
export interface FinalStep extends BaseStep {
  type: "final";
  content: string;
  run_id: string;
  thought?: string;
  llm_s?: number;
  in_tok?: number;
  out_tok?: number;
  think_tok?: number;
}

/** type:"observation" — durable note written by monolith/responder bash. */
export interface ObservationStep extends BaseStep {
  type: "observation";
  content: string;
  source: string;
  decision?: string;
  trigger_step?: string;
  run_id?: string;
}

/** type:"reply_claim" — responder audit-trail step (thinkers/responder/step:95-101). */
export interface ReplyClaimStep extends BaseStep {
  type: "reply_claim";
  content: string;
  source: "responder";
  trigger_step?: string;
}

/** type:"feedback" — shellm timeout notice, or dispatcher salience-injection
 *  (bin/thinkers:863-868). Matches NO subscription, so it never re-dispatches. */
export interface FeedbackStep extends BaseStep {
  type: "feedback";
  content: string;
  source: string;
  trigger_step?: string;
}

/** type:"idle" — honest idle, or a watchdog synthetic. */
export interface IdleStep extends BaseStep {
  type: "idle";
  content: string;
  source: string;
  synthetic?: string;
  trigger_step?: string;
  run_id?: string;
}

/** type:"message" — chat in/out on the root stream (source:"chat"). */
export interface MessageStep extends BaseStep {
  type: "message";
  content: string;
  from: string;
  to: string;
  source: string;
  reply_to?: string;
}

/** type:"error" — monolith run-failed marker, or a shellm stall. */
export interface ErrorStep extends BaseStep {
  type: "error";
  content: string;
  source: string;
  reason: string;
  rc?: number;
  run_id?: string;
  trigger_step?: string;
}

/** type:"monolith-wake" — dispatcher scheduled wake (source:"monolith-timer"). */
export interface MonolithWakeStep extends BaseStep {
  type: "monolith-wake";
  content: string;
  source: string;
}

export type Step =
  | TrajectoryStep
  | ThoughtStep
  | ShellmRunStep
  | PromptStep
  | ReasoningStep
  | ShellOutputStep
  | FinalStep
  | ObservationStep
  | ReplyClaimStep
  | FeedbackStep
  | IdleStep
  | MessageStep
  | ErrorStep
  | MonolithWakeStep
  | (BaseStep & Record<string, unknown>);

/** The step types that end a shellm run's loop. */
export const TERMINAL_TYPES = new Set(["final"]);
