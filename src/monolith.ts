// monolith.ts — one monolith wake, end to end (SPEC §4.1-4.2, §3.3-3.5).
//
// This is the slice's top-level path:
//   classify the wake → assemble the standing-context route prompt →
//   run one shellm agentic run → probe what durable work it produced →
//   idle/error fallback if none → compute backoff → arm next wake_at.
//
// The monolith NEVER replies to chat (that is the responder, out of slice).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Trajectory } from "./trajectory.ts";
import type { LlmClient } from "./llm.ts";
import type { Sandbox } from "./sandbox.ts";
import type { EnvSpec, Step } from "./types.ts";
import { runShellm, redactedCmdline, type RunShellmOptions, type RunShellmResult, type ShellmConstants, type WakeIO, REAL_WAKE_IO } from "./shellm.ts";
import { buildSystemPrompt, loadThinkPrompt } from "./prompts.ts";
import { buildShellmSystemPrompt } from "./shellmPrompt.ts";
import { MONOLITH_CONTEXT_OPTS } from "./context.ts";
import { recentStream } from "./recentStream.ts";
import { indexUpdate, deferralsPath, queryPending } from "./messageIndex.ts";
import { relatedMemories, activeGoalsSection } from "./personMemory.ts";
import { runRecap, type RecapIO } from "./recap.ts";
import { promptRedact } from "./promptRedact.ts";
import { outboundSection, scheduleSignals } from "./wakeSections.ts";
import {
  decideBackoff,
  delayForLevel,
  backoffConfigFromEnv,
  type BackoffConfig,
  type BackoffState,
} from "./backoff.ts";

const THINK_CONTEXT_TAIL_DEFAULT = 20; // thinkers/monolith/step:37 `THINK_CONTEXT_TAIL="${THINK_CONTEXT_TAIL:-20}"`
const POST_RUN_SLEEP_MS = 1000; // thinkers/monolith/step:490 `sleep 1`
const SHARE_HINT_EVERY = 12; // MONOLITH_SHARE_HINT_EVERY default
// PORT-NOTE (1c: 2fed66c, 0a36061) — MONOLITH_PENDING_MAX_AGE/_OVERDUE_S/
// _LIST_MAX are hardcoded to their upstream defaults (no env override), same
// convention as THINK_CONTEXT_TAIL/SHARE_HINT_EVERY above.
const PENDING_MAX_AGE_SECONDS = 14 * 86400; // MONOLITH_PENDING_MAX_AGE default "14d"
const PENDING_OVERDUE_SECONDS = 14400; // MONOLITH_PENDING_OVERDUE_S default (0a36061 lowered this from 86400 to 4h)
const PENDING_LIST_MAX = 5; // MONOLITH_PENDING_LIST_MAX default
const RELATED_MEMORIES_N = 3; // MONOLITH_RELATED_MEMORIES default (1c: 130796a)
const GOAL_REVIEW_DAYS = 7; // MONOLITH_GOAL_REVIEW_DAYS default (1c: 130796a)
const WORKSPACE_DIRS_MAX = 12; // WORKSPACE_DIRS default (1c: 62d7da3)
const WORKSPACE_FIND_CAP = 5000; // per-directory file-count cap (1c: 62d7da3)

const VISIBLE_TYPES = new Set(["action", "observation", "merge", "message"]);

export interface IdentityConfig {
  name: string;
  identityText: string; // `identity prompt` output, rendered per wake by steprun.buildIdentityConfig
  skillsText: string; // `skills prompt` output, rendered per wake by steprun.buildIdentityConfig
  goals: string; // get_goals output ("(no goals set)" when none)
  trajDir: string;
  workdir: string;
  binDir: string; // tool-shim dir
  stateDir: string; // run/ dir for wake_at + backoff state
  thinkersDir?: string; // THINKERS_DIR — <thinkersDir>/monolith/prompt.md overrides the bundled template
  model: string;
  effort?: string;
  /** SHELLM_SYSTEM_PROMPT override (bin/shellm:1548-1549 build_system_prompt);
   *  undefined/unset falls back to the bundled SHELLM_SYSTEM_PROMPT text. */
  systemPrompt?: string;
  /** Raw SHELLM_MAX_TOKENS text (bin/shellm:2149 `--arg max_tok "${SHELLM_MAX_TOKENS:-}"`)
   *  for the shellm-run header's max_tokens field — recorded as-is, empty when unset. */
  maxTokens?: string;
  env: EnvSpec; // execution-environment metadata (SPEC §1.1)
  execEnv?: Record<string, string>; // extra env exported into executed code
  /** `collect_skill_vars`-declared vars actually forwarded this wake (name +
   *  resolved value), for selectSandbox's --var directory auto-mount
   *  (bug #35, src/skill-env.ts `computeVarMounts`). A SUBSET of execEnv's
   *  keys — just the ones that came from a skill's SKILL.md `env:` list,
   *  not the built-in MEM_DIR/SKILLS_DIR/CHATRC/forwarded-API-key entries
   *  execEnv also carries (see steprun.ts buildIdentityConfig). */
  skillVarMounts?: Array<{ name: string; value: string }>;
  backoff?: BackoffConfig;
}

export interface WakeTrigger {
  /** "" = boot/start; monolith-wake = scheduled timer; observation/action/merge = reactive. */
  triggerType: string;
  triggerSource?: string;
  triggerStepId?: string;
}

export interface WakeResult {
  runStepId: string;
  wakeMode: "reactive" | "spontaneous";
  wakeReason: string;
  /** runShellm's StopReason, or "threw" when runShellm itself threw (no
   *  subprocess boundary in this port — see the try/catch around its call
   *  below, thinkers/monolith/step:325-331's `shellm ... \|\| run_rc=$?`). */
  stopReason: string;
  iterations: number;
  didVisible: boolean;
  didThought: boolean;
  didWork: boolean;
  backoff: BackoffState;
  nextDelay: number;
  wakeAtEpoch: number | null;
}

export interface RunMonolithWakeOptions {
  trajectory: Trajectory;
  identity: IdentityConfig;
  llm: LlmClient;
  sandbox: Sandbox;
  trigger: WakeTrigger;
  /**
   * Behavioral-parity round 2 (E1): the delay between the shellm run ending and the wake's probes. Upstream's step
   * does a literal `sleep 1` right there (thinkers/monolith/step:489-490, "tail -F polls once a second; give it one
   * tick to flush the last lines"). The tail -F is a bash artifact, but the second is part of upstream's wake
   * cadence: the step stays busy for it, and wake_at is computed after it. Defaults to a real 1000 ms timer;
   * tests inject a recorder or a no-op.
   */
  postRunSleep?: (ms: number) => Promise<void>;
  /** now() injectable for deterministic wake_at in tests. */
  now?: () => number;
  /** shellm loop constants (e.g. maxIterations to bound a real run's cost). */
  constants?: Partial<ShellmConstants>;
  /** Operator-visible progress IO (thinkers/monolith/step's own `printf ... >&2`
   *  lines, plus the shellm run's); defaults to the real process streams. */
  io?: WakeIO;
  /** PORT-NOTE (1c: 3330189, a4ed181) — host-side env for life-context knobs
   *  (MONOLITH_TIERED_MEMORY, ROLLUP_MODEL, RECAP_MAP_MODEL, SHELLM_FAST_MODEL,
   *  MONOLITH_CONTEXT_BUDGET, ROLLUP_RAW_TAIL); defaults to process.env, same
   *  injectable-default convention as backoffConfigFromEnv(). */
  env?: NodeJS.ProcessEnv;
  /** PORT-NOTE (1c: 3330189, a4ed181) — the `llm` process boundary
   *  `_life_context`'s `recap --context` call would spawn through recap's own
   *  rollup sealing; defaults to the same `spawnSync("llm", …)` shim
   *  bin/recap.mjs uses. Tests inject a stub here instead of hitting a real
   *  model. */
  recapRunLlm?: RecapIO["runLlm"];
  /** PORT-NOTE (2e39a3f, MONOLITH_REQUEST_MODEL): builds the client for the
   *  request tier's model. Upstream passes `--model "$run_model"` to a fresh
   *  shellm process; this port's `llm` is bound to the base model at
   *  construction, so the tier needs a way to make one for another model.
   *  Absent (tests, replay fixtures): the tier still shows on the header and
   *  the wake reason, but the supplied `llm` answers. */
  llmForModel?: (model: string) => LlmClient;
}

export async function runMonolithWake(opts: RunMonolithWakeOptions): Promise<WakeResult> {
  const { trajectory: traj, identity: id, trigger } = opts;
  const now = opts.now ?? (() => Date.now());
  const backoffCfg = id.backoff ?? backoffConfigFromEnv();
  const io = opts.io ?? REAL_WAKE_IO;

  // --- classify the wake (thinkers/monolith/step:140-162). ---
  const wakeMode = classifyWakeMode(trigger, id.name);
  let wakeReason = wakeReasonString(wakeMode, trigger);

  // --- backoff state load (step:83-92). ---
  let state = loadBackoffState(id.stateDir);
  if (SHARE_HINT_EVERY > 0 && wakeMode === "spontaneous") {
    state.wakesSinceShareHint += 1;
  }

  // --- probe: last visible / thought step id BEFORE the run (step:280-296). ---
  const beforeVisible = lastIdOfTypes(traj.read(), VISIBLE_TYPES);
  const beforeThought = lastIdOfTypes(traj.read(), new Set(["thought"]));
  // thinkers/monolith/step:358 recovery probe: the run header's step_id, so a
  // thrown runShellm (below) can still recover its run_id the way upstream's
  // `cat "$run_id_file"` does — SHELLM_RUN_ID_OUT is written right after
  // shellm appends its own header (bin/shellm:2296-2301), which runShellm
  // mirrors as its very first action (src/shellm.ts:245).
  const beforeRunHeader = lastIdOfTypes(traj.read(), new Set(["shellm-run"]));

  // --- assemble the route prompt (standing context, §4.2). ---
  const systemPrompt = buildSystemPrompt(id.name, id.identityText, id.skillsText);
  // Behavioral-parity fix (B2): upstream honours the THINK_CONTEXT_TAIL env knob (step:37; the identity
  // `activate` script exports 30 by default), so the recent-stream window comes from env, not a constant.
  const tailEnv = Number((opts.env ?? process.env)["THINK_CONTEXT_TAIL"]);
  const THINK_CONTEXT_TAIL = Number.isInteger(tailEnv) && tailEnv > 0 ? tailEnv : THINK_CONTEXT_TAIL_DEFAULT;
  const recentContext = recentStream(traj.read(), THINK_CONTEXT_TAIL);
  const nowSec = Math.floor(now() / 1000);
  // PORT-NOTE (1c: 2fed66c): the PENDING REQUEST hint now reads the
  // `chat pending` deferrals index over the WHOLE root trajectory instead of
  // the 20-step recentContext window — see pendingRequestHint's own note.
  const memDir = id.execEnv?.["MEM_DIR"] ?? path.join(id.workdir, "..", "memories");
  const { hints: rawHints, pending: pendingReq } = buildRoutingHints(state, wakeMode, traj.trajFile, nowSec, now, recentContext);
  // 130796a: the related-memories query is the wake's own material — the
  // real hints BEFORE the "no special signals" placeholder, plus the last
  // three kept stream steps' content (truncated).
  const last3Content = recentContext
    .split("\n")
    .filter(Boolean)
    .slice(-3)
    .map((l) => {
      try {
        return String((JSON.parse(l) as Record<string, unknown>)["content"] ?? "");
      } catch {
        return "";
      }
    })
    .map((c) => c.replaceAll("\n", " ").slice(0, 600))
    .join(" ");
  const relatedQuery = `${rawHints} ${last3Content}`;
  const placeholderHints = rawHints === "" ? "- (no special signals — pick what best serves the mind right now)" : rawHints;
  // 2e39a3f: the clock and scheduled-goal windows go first, AFTER the placeholder
  // test and the related-memories query — present on every wake, not the wake's
  // topic (design/scheduled_goals.md). A section that fails is left out.
  const lifeEnv = opts.env ?? process.env;
  const sched = wakeSection("schedule", io, () => scheduleSignals(memDir, traj.trajFile, id.name, lifeEnv, now));
  const hints = sched !== "" ? `${sched}\n${placeholderHints}` : placeholderHints;

  // 130796a: active goals now come from the goal LIFECYCLE reader (goal,
  // intention, objective, todo; newest first; `until:` expiry; capped with a
  // count) instead of the static string steprun.ts's IdentityConfig.goals
  // captured once at wake-config build time — see personMemory.ts's
  // `activeGoalsSection` (this lane's file; steprun.ts's own `getGoals` is
  // superseded here, not removed, since nothing else in this port reads
  // IdentityConfig.goals).
  const goalsText = activeGoalsSection(memDir, { now });
  // thinkers/monolith/step:277 `think_prompt=$(load_prompt ...)`: a bash command substitution strips trailing
  // newlines, and the template ends in one, so the step interpolates it with none (behavioral parity round 2,
  // residual blank line before </context>).
  const thinkPrompt = loadThinkPrompt(id.name, goalsText, id.thinkersDir).replace(/\n+$/, "");
  // PORT-NOTE (1c: 3330189, a4ed181) — see lifeContextSection() below.
  const lifeSection = lifeContextSection(
    traj.trajId,
    id.trajDir,
    lifeEnv,
    opts.recapRunLlm ?? defaultRecapRunLlm,
    () => new Date(now())
  );

  // 62d7da3/b1cf15e: runtime line + workspace map — stable across wakes (a
  // cached prompt prefix), so the mind stops re-orienting (pwd/ls/find) and
  // re-verifying its own runtime (grepping/checksumming bin/ and thinkers/)
  // every wake.
  const runtime = runtimeLine(id.binDir, id.thinkersDir, now, lifeEnv);
  const workspace = workspaceSection(id.workdir);
  // 2e39a3f: what this identity sent in the last day, with each message's
  // delivery state, so "did I already send this" is answered by the prompt and
  // not by memory (design/outbound_delivery.md, part 5). After the recent
  // stream, so the cached prefix does not change when a send lands.
  const outbound = wakeSection("outbound", io, () => outboundSection(traj.trajFile, id.name, lifeEnv, now));

  // 130796a: related memories matched to this wake, skipping names shown
  // last wake (state.relatedPrev, persisted below) and anything under a day
  // old (already in the recent stream).
  const relatedRaw = relatedMemories(memDir, relatedQuery, state.relatedPrev, { n: RELATED_MEMORIES_N, now });
  const relatedShownNames = relatedRaw
    ? relatedRaw
        .split("\n")
        .filter(Boolean)
        .map((l) => /^- (\S+) \[/.exec(l)?.[1] ?? "")
        .filter(Boolean)
    : [];
  state.relatedPrev = relatedShownNames;
  const relatedSection = relatedRaw
    ? "Related memories (matched to this wake from your memory store; `mem show <name>` prints one whole; if one is wrong or stale, fix it with `mem edit` or `mem forget`):\n" +
      relatedRaw +
      "\n"
    : "";

  const routePrompt =
    "<context>\n" +
    systemPrompt +
    "\n\n" +
    (runtime ? `${runtime}\n\n` : "") +
    (workspace ? `${workspace}\n\n` : "") +
    lifeSection +
    `Recent stream (last ${THINK_CONTEXT_TAIL} durable steps; \`traj tail -n 200\` shows more, verbatim):\n` +
    recentContext +
    "\n\n" +
    (outbound ? `${outbound}\n\n` : "") +
    relatedSection +
    "Routing signals:\n" +
    hints +
    "\n\n" +
    thinkPrompt +
    "\n</context>\n\nChoose ONE function for this wakeup and carry it out now.";

  // 2e39a3f model tier. MONOLITH_REQUEST_MODEL, when set, runs the wakes that
  // serve a person: a REACTIVE wake (something happened outside the head, usually
  // the responder's observation about an inbound message) or any wake with an
  // open PENDING REQUEST. Every other wake (the spontaneous timer ticks, 700 to
  // 900 of ~1,000 a day) stays on the base model, so a frontier model pays only
  // for the minutes a person is waiting. The wake reason carries the tier so the
  // run row in the mind log says which model answered.
  const requestModel = lifeEnv["MONOLITH_REQUEST_MODEL"] ?? "";
  let runModel = id.model;
  let modelTier = "think";
  if (requestModel !== "" && (wakeMode === "reactive" || pendingReq !== "")) {
    runModel = requestModel;
    modelTier = "request";
    wakeReason += "/request";
  }
  const runLlm = modelTier === "request" && opts.llmForModel ? opts.llmForModel(runModel) : opts.llm;

  const command = synthCommand({ ...id, model: runModel }, trajFileId(traj), lifeEnv);

  // bin/shellm:2137-2145 build_system_prompt: `[[ -n "${SHELLM_SYSTEM_PROMPT:-}" ]]`
  // -> `printf '%s\n' "$SHELLM_SYSTEM_PROMPT"` (always exactly one trailing
  // newline appended, regardless of whether the value already has one) in
  // place of the default text. The default text is assembled per run (it
  // names the run dir and the context scope): src/shellmPrompt.ts.
  const effectiveSystemPrompt: RunShellmOptions["systemPrompt"] =
    id.systemPrompt !== undefined
      ? id.systemPrompt + "\n"
      : (ctx) =>
          buildShellmSystemPrompt({
            contextScope: ctx.constants.contextScope,
            contextBlockLimit: ctx.constants.contextBlockLimit,
            contextWholeBlocks: ctx.constants.contextWholeBlocks,
            contextRunTailBlock: ctx.constants.contextRunTailBlock,
            stdoutPromptLimit: MONOLITH_CONTEXT_OPTS.promptLimit ?? 2048,
            rundir: ctx.rundir,
            ...(ctx.docker ? { docker: { image: ctx.dockerImage } } : {}),
            env: lifeEnv as Record<string, string | undefined>,
          });

  // thinkers/monolith/step:307 — printed right before the shellm run starts.
  io.stderr(`  routing (${trigger.triggerType || "none"} / ${wakeMode})...\n`);
  io.stderr(`  model ${runModel} (${modelTier} tier)\n`);

  // --- one shellm agentic run over the function menu (§4.1). ---
  // thinkers/monolith/step:325-331 `run_response=$(... shellm ...) ||
  // run_rc=$?`: shellm is a SEPARATE subprocess there, so ANY way it dies —
  // not just the three stop conditions runShellm itself returns cleanly —
  // is captured by the outer step, which then keeps going (records the
  // fallback below, still computes backoff, still arms the next wake). This
  // port has no subprocess boundary — runShellm runs in-process — so without
  // this try/catch a thrown exception here (an LLM/sandbox failure runShellm
  // doesn't catch internally) would propagate straight out of
  // runMonolithWake: no fallback step recorded, no backoff, no re-arm. Catch
  // it here, at the exact point upstream's `|| run_rc=$?` sits, to keep the
  // wake alive the way upstream's outer script always does.
  // 2e39a3f: shellm's stderr is copied so a run that dies with no durable step can
  // say why in its error step (19 "run failed (rc=1)" steps on 2026-09-07/08
  // carried no reason at all). Upstream sends both of shellm's streams to FILES; the
  // port runs shellm in-process, so the analogue is a tee on the run's own io.
  let runErrText = "";
  const runIo: WakeIO = {
    ...io,
    stderr: (t: string) => {
      runErrText = (runErrText + t).slice(-8192);
      io.stderr(t);
    },
  };
  let run: RunShellmResult | undefined;
  let runErrored: boolean;
  try {
    run = await runShellm({
      trajectory: traj,
      llm: runLlm,
      sandbox: opts.sandbox,
      systemPrompt: effectiveSystemPrompt,
      // 2e39a3f: scrub credentials out of the prompt before it reaches a model —
      // the sections above quote the mind log verbatim, and a pasted token is
      // re-quoted into every future prompt covering its window (promptRedact.ts).
      prompt: promptRedact(routePrompt, lifeEnv),
      workdir: id.workdir,
      binDir: id.binDir,
      io: runIo,
      execEnv: {
        IDENTITY_NAME: id.name,
        TRAJ_DIR: id.trajDir,
        TRAJ_ID: traj.trajId,
        MEM_DIR: id.execEnv?.["MEM_DIR"] ?? path.join(id.workdir, "..", "memories"),
        SKILLS_DIR: id.execEnv?.["SKILLS_DIR"] ?? path.join(id.workdir, "..", "skills"),
        SHELLM_MODEL: id.model,
        SHELLM_TRUNCATE: "2000",
        ...(id.execEnv ?? {}),
      },
      header: {
        command,
        model: runModel,
        effort: id.effort ?? "high",
        maxTokens: id.maxTokens ?? "",
        env: id.env,
        resumed: true, // monolith runs resume/append the shared root traj (§1.1)
        wake: wakeReason,
        launchedBy: "monolith",
        ...(trigger.triggerStepId ? { triggerStep: trigger.triggerStepId } : {}),
      },
      // Behavioral-parity fix (B5): thinkers/monolith/step:485 runs `shellm ... --context-scope run`, so each wake's
      // first request is [system, user]. The port only RECORDED that flag in the header; the loop defaulted to
      // contextScope "traj" (steprun.ts:410), replaying every earlier wake as chat turns (real run: 42 messages,
      // 50k prompt tokens, 14% cache hits vs upstream 2 messages, 8-10k tokens, 89% hits).
      constants: { ...(opts.constants ?? {}), contextScope: "run" },
    });
    runErrored = run.stopReason === "stall" || run.stopReason === "max-iter" || run.stopReason === "empty-response";
  } catch (e) {
    // bin/shellm's die() prints "shellm: error: <why>" on stderr; the thrown
    // exception is this port's analogue, so say it the same way (it also feeds
    // the error step's stderr_tail below).
    runIo.stderr(`shellm: error: ${e instanceof Error ? e.message : String(e)}\n`);
    run = undefined;
    runErrored = true;
  }

  // thinkers/monolith/step:489-490 `sleep 1` after the run (see RunMonolithWakeOptions.postRunSleep).
  await (opts.postRunSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(POST_RUN_SLEEP_MS);

  // thinkers/monolith/step:358 `idle_run_id=$(cat "$run_id_file") ||
  // idle_run_id=""` — recovered the same way here: a normal run always has a
  // runStepId (the header is appended before anything that can fail); a
  // thrown run only has one if a NEW shellm-run step landed since this wake
  // started (beforeRunHeader), otherwise it dies before ever writing one.
  const runIdForFallback = run
    ? run.runStepId
    : (() => {
        const afterRunHeader = lastIdOfTypes(traj.read(), new Set(["shellm-run"]));
        return afterRunHeader !== beforeRunHeader ? afterRunHeader : "";
      })();

  // --- probe AFTER the run (step:320-338). ---
  const afterVisible = lastIdOfTypes(traj.read(), VISIBLE_TYPES);
  const afterThought = lastIdOfTypes(traj.read(), new Set(["thought"]));
  const didVisible = afterVisible !== beforeVisible;
  const didThought = afterThought !== beforeThought;
  const didWork = didVisible || didThought;

  // --- idle/error fallback when the wake produced no durable step (step:339-367). ---
  if (!didWork) {
    if (runErrored) {
      // thinkers/monolith/step:360,366 `run_rc` — every failure path that
      // reaches here is a shellm `return 1` (run_loop's stall/max-iter,
      // bin/shellm:2846,2887) or `die()` (bin/shellm:114 `exit 1` —
      // empty-response, and every other internal failure; a thrown exception
      // here is this port's analogue, since it has no subprocess boundary to
      // surface a different code). Upstream's own observed rc=141 (SIGPIPE,
      // design/monolith_run_health.md Issue B — a `producer | head` race
      // under `pipefail`) and rc=126 (ARG_MAX on an inline argv prompt) are
      // bash/OS artifacts this port's architecture cannot hit: exec output is
      // read in one pass after the command finishes (no racing
      // `tail|head` — see printExecOutputLines), and the prompt is always
      // written via a temp file, never argv (shellm.ts / monolith.ts's own
      // `prompt` handling) — not modeled because they cannot occur here, not
      // because they were overlooked.
      const rc = 1;
      // A failed run needs an error marker even if it already wrote an idle.
      io.stderr(`  run FAILED (rc=${rc}) — recording error\n`);
      // 2e39a3f: the last three non-blank stderr lines (300 chars each), so the
      // error step says why (`run_err_tail`), and a pointer at the run's failing
      // command (`diagnostic_step`) so a stranger can rerun the diagnostic.
      const detail = runErrText
        .split("\n")
        .filter((l) => !/^[ \t\r\f\v]*$/.test(l))
        .slice(-3)
        .map((l) => Array.from(l).slice(0, 300).join(""))
        .join(" ")
        .replace(/ $/, "");
      const diagnosticStep = runIdForFallback ? lastDiagnosticId(traj.read(), runIdForFallback) : "";
      traj.append({
        type: "error",
        content: `monolith run failed (rc=${rc}) with no durable step${detail === "" ? "" : `: ${detail}`}`,
        source: "monolith",
        reason: "run-failed",
        rc,
        ...(detail === "" ? {} : { stderr_tail: detail }),
        ...(trigger.triggerStepId ? { trigger_step: trigger.triggerStepId } : {}),
        ...(runIdForFallback ? { run_id: runIdForFallback } : {}),
        ...(diagnosticStep ? { diagnostic_step: diagnosticStep } : {}),
      });
    } else if (runHasIdle(traj.read(), runIdForFallback)) {
      // 2e39a3f (c5dbce4): only an idle linked to THIS run suppresses its fallback.
      io.stderr(`  run appended its own idle step — fallback marker suppressed\n`);
    } else {
      io.stderr(`  run produced no durable step (rc=0) — marking idle; timer keeps the loop alive\n`);
      traj.append({
        type: "idle",
        content: "idle",
        source: "monolith",
        ...(trigger.triggerStepId ? { trigger_step: trigger.triggerStepId } : {}),
        run_id: run!.runStepId,
      });
    }
  }

  // --- backoff decision (step:371-408). ---
  const decision = decideBackoff(
    state,
    { wakeMode, didVisible, didThought, runErrored },
    backoffCfg
  );
  // decideBackoff only knows about the BackoffState fields; carry the 1c:
  // 130796a additions (relatedPrev/goalReviewAt) through unchanged.
  state = { ...decision.state, relatedPrev: state.relatedPrev, goalReviewAt: state.goalReviewAt };
  // thinkers/monolith/step:417-418 — only the "empty spontaneous wake" branch
  // of the backoff decision (decideBackoff's `else`) ever prints this, and
  // only when the wake's sole durable output was a thought.
  if (!(wakeMode === "reactive" || didVisible) && !runErrored && didThought) {
    io.stderr(
      `  thought-only wake — dwell ${state.ticksAtLevel}/${backoffCfg.hold} at level ${state.level} (next in ${decision.nextDelay}s)\n`
    );
  }
  saveBackoffState(id.stateDir, state);

  // --- arm the next wake (wake_at epoch; §3.3, step:120-126). ---
  // arm_wake fidelity (thinkers/monolith/step:115): only write monolith.wake_at
  // when run/dispatcher.token exists — a standalone `thinkers step` with no
  // daemon running to consume the file must not arm a wake nobody will fire.
  let wakeAtEpoch: number | null = null;
  const armed = fs.existsSync(path.join(id.stateDir, "dispatcher.token"));
  if (armed) {
    if (decision.nextDelay > 0) {
      wakeAtEpoch = Math.floor(now() / 1000) + decision.nextDelay;
    } else {
      // level 0 → wake again immediately; write now so the dispatcher fires next tick.
      wakeAtEpoch = Math.floor(now() / 1000);
    }
    fs.mkdirSync(id.stateDir, { recursive: true });
    writeAtomicFile(path.join(id.stateDir, "monolith.wake_at"), String(wakeAtEpoch));
  }

  // thinkers/monolith/step:423-425 — the run's first response line, to
  // STDOUT (not stderr; merged into the same log file either way). A thrown
  // run has no response to show, same as upstream printing nothing once
  // `shellm` itself has already died.
  if (run && run.response !== "") {
    io.stdout(`  [monolith] ${run.response.split("\n")[0] ?? ""}\n`);
  }

  return {
    runStepId: runIdForFallback,
    wakeMode,
    wakeReason,
    stopReason: run ? run.stopReason : "threw",
    iterations: run ? run.iterations : 0,
    didVisible,
    didThought,
    didWork,
    backoff: state,
    nextDelay: decision.nextDelay,
    wakeAtEpoch,
  };
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** `_last_diagnostic_id`: the last FAILING shell-output step_id (exit != 0) of a run; else the
 *  last non-empty one (an inference-layer death leaves no failed command); "" when the run
 *  never ran a shell. (thinkers/monolith/step, design/monolith_run_health.md B2.) */
function lastDiagnosticId(steps: Step[], runId: string): string {
  const rows = steps
    .map((s) => s as Record<string, unknown>)
    .filter((s) => {
      if (s["type"] !== "shell-output" || s["run_id"] !== runId) return false;
      const nonEmpty = (v: unknown) => v !== undefined && v !== null && String(v).length > 0;
      return (nonEmpty(s["stdout"]) || nonEmpty(s["stderr"])) && s["step_id"] !== undefined && s["step_id"] !== null;
    });
  const failed = rows.filter((s) => s["exit"] !== undefined && s["exit"] !== null && s["exit"] !== 0);
  const pick = failed.length > 0 ? failed[failed.length - 1] : rows[rows.length - 1];
  return pick ? String(pick["step_id"]) : "";
}

/** `_run_has_idle`: an idle step linked to this run (empty run id never matches). */
function runHasIdle(steps: Step[], runId: string): boolean {
  if (runId === "") return false;
  return steps.some((s) => {
    const r = s as Record<string, unknown>;
    return r["type"] === "idle" && r["run_id"] === runId;
  });
}

/** `_prompt_section`: a section whose builder fails is left out of this wakeup, loudly on stderr.
 *  PORT-NOTE (2e39a3f): upstream also appends a rate-limited `error` step; not ported, the same
 *  documented gap as the identity/skills sections (PARITY.md, f1b8693). */
function wakeSection(label: string, io: WakeIO, build: () => string): string {
  try {
    return build();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    io.stderr(`monolith: error: wake prompt section "${label}" failed: ${why}; the section is left out of this wakeup\n`);
    return "";
  }
}

function classifyWakeMode(t: WakeTrigger, identityName: string): "reactive" | "spontaneous" {
  switch (t.triggerType) {
    case "observation":
    case "action":
    case "merge":
      // Our own steps are pre-filtered by the dispatcher; defensive check.
      return t.triggerSource === identityName ? "spontaneous" : "reactive";
    case "monolith-wake":
      return "spontaneous";
    default:
      // idle / manual-trigger / "" (start) / watchdog / unknown.
      return "spontaneous";
  }
}

function wakeReasonString(mode: "reactive" | "spontaneous", t: WakeTrigger): string {
  if (t.triggerType === "monolith-wake") return `${mode}/timer`;
  if (t.triggerType === "") return `${mode}/start`;
  return `${mode}/${t.triggerType}${t.triggerSource ? `:${t.triggerSource}` : ""}`;
}

function lastIdOfTypes(steps: Step[], types: Set<string>): string {
  let id = "";
  for (const s of steps) {
    if (types.has(String((s as { type?: string }).type ?? ""))) {
      id = String((s as { step_id?: string }).step_id ?? "");
    }
  }
  return id;
}

export { recentStream };

/**
 * Cheap deterministic routing nudges (step:172-263). Order matches upstream:
 * [action-with-no-observation (step:194-198) and circling (step:199-203) hints:
 * ported in the behavioral-parity fix B1], pending requests (part 5, 1c: 2fed66c/0a36061), the
 * share nudge, then the goal-review nudge (1c: 130796a); the "no special
 * signals" fallback applies once, only when nothing else fired.
 */
function buildRoutingHints(
  state: MonolithState,
  wakeMode: string,
  trajFile: string,
  nowSec: number,
  now?: () => number,
  recentContext = ""
): { hints: string; pending: string } {
  let hints = "";
  // step:194-203: the two recent-stream shape hints come first, in this order.
  const lines = recentContext.split("\n").filter((l) => l.length > 0);
  const typeOf = (l: string): string | undefined => {
    try {
      return (JSON.parse(l) as { type?: string }).type;
    } catch {
      return undefined;
    }
  };
  if (lines.length > 0 && typeOf(lines[lines.length - 1]!) === "action") {
    hints += "- The most recent step is an ACTION that has no observation yet — it may need carrying out (act).\n";
  }
  const lastThree = lines.slice(-3).map(typeOf);
  if (lastThree.length > 0 && lastThree.every((t) => t === "thought")) {
    hints += "- The last few steps are all thoughts — the stream may be circling; consider acting, recalling, or advancing decisively.\n";
  }
  const pending = pendingRequestHint(trajFile, now);
  hints += pending;
  if (SHARE_HINT_EVERY > 0 && wakeMode === "spontaneous" && state.wakesSinceShareHint >= SHARE_HINT_EVERY) {
    state.wakesSinceShareHint = 0;
    hints +=
      "- It has been a while since you shared anything outward. If recent work or thinking produced something a specific person would genuinely care about, consider **share**. If nothing qualifies, ignore this.\n";
  }
  hints += goalReviewHint(state, nowSec);
  // NOTE: the "no special signals" fallback is applied by the CALLER, not
  // here — 130796a's related-memories query needs the raw (pre-fallback)
  // hints text, matching bash's own `related_query="$hints ..."` line, which
  // runs BEFORE `[[ -z "$hints" ]] && hints="- (no special signals ...)"`.
  return { hints, pending };
}

/**
 * PENDING REQUEST hint (design/conversation_memory.md, part 5; 1c: 2fed66c,
 * 0a36061). Upstream's original version scanned the 20-step recent-stream
 * window and showed only the newest unresolved responder deferral — on
 * 2026-09-02 an older request was masked by a newer one, then scrolled out of
 * the window and was never delivered. 2fed66c replaced the scan with the
 * `chat pending` deferrals index (src/messageIndex.ts's `deferralsPath` /
 * `queryPending`, this port's already-shipped equivalent — see PARITY.md),
 * which covers the WHOLE trajectory: every open request is listed, oldest
 * first, with its age, capped at PENDING_LIST_MAX plus a count of the rest.
 * 0a36061 (a day later) found the hint itself was too easy to ignore — two
 * timer wakes in a row read it and filed research notes instead, under the
 * "timer wakeups are for inner life" rule — so the wording was strengthened
 * to a strong preference with a stated escape hatch, and OVERDUE dropped from
 * a day to 4 hours.
 */
export function pendingRequestHint(trajFile: string, now?: () => number): string {
  const idxFile = path.join(path.dirname(trajFile), "messages.jsonl");
  try {
    indexUpdate(trajFile, idxFile);
  } catch {
    /* best-effort, matches bash's `_index_update ... || true` */
  }
  const dfrFile = deferralsPath(idxFile);
  let pending;
  try {
    pending = queryPending(dfrFile, { maxAgeSeconds: PENDING_MAX_AGE_SECONDS, ...(now ? { now } : {}) });
  } catch {
    return "";
  }
  if (pending.length === 0) return "";
  let hints = "";
  const shown = pending.slice(0, PENDING_LIST_MAX);
  for (const p of shown) {
    const person = p.person ?? "someone";
    const personOrPlaceholder = p.person ?? "<their-name>";
    const overdue =
      p.age_s > PENDING_OVERDUE_SECONDS
        ? ", OVERDUE: deliver what you have, or that it cannot be done, this wake"
        : "";
    hints +=
      `- PENDING REQUEST from ${person}: ${p.request} (pending for ${pendingAgeTextMonolith(p.age_s)}${overdue}). ` +
      `The responder already told them you would get back to them, so they are waiting. Strongly prefer doing this work now (act), timer wake or not, over inner-life work; ` +
      `then deliver the result with: chat reply --follow-up --reply-to ${p.trigger_step} ${personOrPlaceholder} <<"MSG" (the message on stdin as a quoted heredoc, written as described under How to write a message to a person; never a double-quoted argument, backticks in it vanish) ` +
      `— and append an observation with --field resolves=${p.trigger_step} so this request stops showing here. If you have a good reason not to this wake, append a thought saying why and what would unblock it.\n`;
  }
  if (pending.length > PENDING_LIST_MAX) {
    hints += `- ${pending.length - PENDING_LIST_MAX} more pending requests: run \`chat pending\` to see them all.\n`;
  }
  return hints;
}

/** The monolith's own inline `age_text` (thinkers/monolith/step, 1c: 2fed66c)
 *  — "N min" / "N h" / "N d", distinct from `chat pending`'s own `Nm`/`Nh`/`Nd`
 *  (src/messageIndex.ts's `pendingAgeText`, a different CLI-facing format). */
function pendingAgeTextMonolith(ageSeconds: number): string {
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)} min`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)} h`;
  return `${Math.floor(ageSeconds / 86400)} d`;
}

/**
 * GOAL REVIEW nudge (thinkers/_lib/common.sh + monolith/step, 1c: 130796a):
 * once every GOAL_REVIEW_DAYS, ask for the goals function with the
 * housekeeping spelled out. Mutates `state.goalReviewAt` when it fires (the
 * caller persists it) — matches bash's `goal_review_at="$_now_s"` before
 * appending the hint text.
 */
function goalReviewHint(state: MonolithState, nowSec: number): string {
  if (GOAL_REVIEW_DAYS <= 0) return "";
  if (nowSec - state.goalReviewAt < GOAL_REVIEW_DAYS * 86400) return "";
  state.goalReviewAt = nowSec;
  return (
    "- GOAL REVIEW (about once a week): read your active goals below and tidy them this wake (goals). " +
    "Retire what is done or stale with `mem forget`, merge duplicates with `mem edit`, and give open todos a date with " +
    "`mem add --type todo --until YYYY-MM-DD` so they expire on their own.\n"
  );
}

/**
 * Runtime line (thinkers/_lib/common.sh `_runtime_line`, 1c: 62d7da3): names
 * the commit the mind's own tools run under, so a fact verified about the
 * runtime can be keyed to a version instead of re-checked every wake (Audel
 * spent ~half its reasoning steps on 2026-09-04 re-grepping bin/shellm and
 * md5summing its own thinkers). `binDir`'s parent is this port's checkout
 * root (the equivalent of upstream's `command -v shellm`-derived app root).
 * "" when the root is not a git checkout (a `git` failure, not thrown).
 */
export function runtimeLine(
  binDir: string,
  thinkersDir: string | undefined,
  now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = path.dirname(binDir);
  const sha = gitOutput(root, ["rev-parse", "--short", "HEAD"]);
  if (!sha) return "";
  const subject = (gitOutput(root, ["log", "-1", "--format=%s"]) ?? "").slice(0, 60);
  const headT = mtimeUtc(path.join(root, ".git", "HEAD"));
  let syncT = "";
  if (thinkersDir) {
    let newest = -Infinity;
    try {
      for (const f of walkFiles(thinkersDir)) {
        const st = fs.statSync(f);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch {
      /* no thinkers dir */
    }
    if (Number.isFinite(newest)) syncT = epochUtc(newest / 1000);
  }
  const checkedOut = headT ? `, checked out ${headT}` : "";
  const synced = syncT ? `; your thinkers synced ${syncT}` : "";
  void now;
  // 2e39a3f boundary sentence, only when it is true from where this wake runs: under
  // the thinkers sandbox (deploy/thinkers-sandbox.sh) the checkout is a read-only
  // mount and the identity directory is the writable island. Said every wake so the
  // mind never has to rediscover it from an EROFS error. `[[ ! -w "$root/bin" ]]`.
  let boundary = "";
  let writable = true;
  try {
    fs.accessSync(path.join(root, "bin"), fs.constants.W_OK);
  } catch {
    writable = false;
  }
  if (!writable) {
    const idDir = env["IDENTITY_DIR"];
    boundary =
      ` The checkout at ${root} is read-only inside a wake: bin, thinkers, tools, deploy and .env cannot be edited in place, and no identity can be created beside yours; runtime changes go through your own clone and a pull request. Your identity directory${idDir ? ` (${idDir})` : ""} is yours to write.`;
  }
  // No trailing newline: like bash's `$(...)` command substitution, callers
  // that splice this into a larger template add their own separators.
  return `Runtime: headlong ${sha} (${subject})${checkedOut}${synced}. A fact about your own runtime that you verified under this commit holds until this line changes.${boundary}`;
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.status !== 0) return undefined;
    const out = (r.stdout ?? "").trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function mtimeUtc(file: string): string {
  try {
    return epochUtc(fs.statSync(file).mtimeMs / 1000);
  } catch {
    return "";
  }
}

/** "YYYY-MM-DD HH:MMZ" from a UNIX epoch (seconds), UTC. */
function epochUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`;
}

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}

/** _coarse_count (thinkers/_lib/common.sh, 1c: 62d7da3): rounds to 2
 *  significant figures from 100 up, so the workspace section (in the cached
 *  prompt prefix) does not change on every wake that adds one file. `cap`
 *  ("N+") caps a per-directory `find` count that was itself head-limited. */
export function coarseCount(n: number, cap?: number): string {
  if (cap !== undefined && n >= cap) return `${cap}+`;
  if (n < 100) return String(n);
  const digits = String(n).length;
  const scale = Math.pow(10, digits - 2);
  const rounded = Math.floor((n + scale / 2) / scale) * scale;
  return `about ${rounded}`;
}

/**
 * Workspace section (thinkers/_lib/common.sh `_workspace_section`, 1c:
 * 62d7da3): the working directory every wake starts in, its top-level
 * directories with (coarse, recursive) file counts — best first, capped at
 * WORKSPACE_DIRS_MAX with a remainder line — how many loose files sit at the
 * top, and the head of WORKSPACE.md if the mind keeps one. Replaces the
 * pwd/ls/find opening that took 12% of Audel's reasoning steps. "" when
 * `workdir` does not exist.
 */
export function workspaceSection(workdir: string): string {
  let topDirs: string[];
  try {
    topDirs = fs
      .readdirSync(workdir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "__pycache__")
      .map((e) => e.name)
      .sort();
  } catch {
    return "";
  }
  const dirLines = topDirs.map((d) => ({ name: d, count: countFilesCapped(path.join(workdir, d), WORKSPACE_FIND_CAP) }));
  // Best (highest count) first; ties keep the alphabetical order already
  // established above (a stable sort — the exact BSD/GNU `sort` tie order
  // upstream's own non-`-s` `sort -k1,1nr` produces is not pinned by any
  // test here, unlike the PORT-NOTE'd `mem prefilter` tie-break).
  dirLines.sort((a, b) => b.count - a.count);
  let loose = 0;
  try {
    loose = fs
      .readdirSync(workdir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith(".")).length;
  } catch {
    /* unreachable — readdirSync above already succeeded */
  }
  let out = `Workspace: ${workdir} (every wake starts here; paths below are relative to it)\n`;
  const shown = dirLines.slice(0, WORKSPACE_DIRS_MAX);
  for (const d of shown) {
    out += `- ${d.name}/ ${coarseCount(d.count, WORKSPACE_FIND_CAP)} files\n`;
  }
  if (dirLines.length > WORKSPACE_DIRS_MAX) {
    out += `- and ${dirLines.length - WORKSPACE_DIRS_MAX} more directories\n`;
  }
  out += `- ${coarseCount(loose)} loose files at the top level`;
  const wsFile = path.join(workdir, "WORKSPACE.md");
  try {
    const lines = fs.readFileSync(wsFile, "utf8").split("\n").slice(0, 8);
    out += "\nWORKSPACE.md (yours to keep current; first lines):\n";
    out += lines.map((l) => l.slice(0, 160)).join("\n");
  } catch {
    out += "\nNo WORKSPACE.md yet: write one (what lives where, what is in progress) and it is shown here.";
  }
  // No trailing newline: like bash's `$(...)` command substitution, callers
  // that splice this into a larger template add their own separators.
  return out;
}

/** Recursive file count under `dir`, stopping once `cap` is reached (matches
 *  `find "$d" -type f | head -n "$cap" | wc -l`, which stops readING at the
 *  cap but not the count itself past it — this returns exactly `cap` in that
 *  case, which `coarseCount(n, cap)` then renders as `"<cap>+"`). */
function countFilesCapped(dir: string, cap: number): number {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0 && n < cap) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (n >= cap) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Life context — `_life_context` (thinkers/_lib/common.sh:531-548) called
// from thinkers/monolith/step:281-291's `life_section` gate.
// PORT-NOTE (1c: 3330189, a4ed181): closes the "young agent" gap this port's
// `lifeSection` carried since before this sync (PARITY.md, "3330189, a4ed181
// — rollup model precedence / no verbatim raw tail by default").
// ---------------------------------------------------------------------------

/** `_export_provider_keys`/bin/recap.mjs's own `runLlm`: spawn `llm` on PATH
 *  exactly as the real `recap` CLI shim does, so a live wake's rollup sealing
 *  hits the same model plumbing a subprocess `recap` would. Tests inject a
 *  stub via RunMonolithWakeOptions.recapRunLlm instead (recap.test.ts's own
 *  seam), never spawning a real process. */
function defaultRecapRunLlm(args: string[], stdinText: string): { status: number; stdout: string; stderr?: string } {
  // stderr is captured and handed back: recap copies it through and looks for
  // `refused:` in it (2e39a3f, c32d5b0).
  const res = spawnSync("llm", args, {
    input: stdinText,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  if (res.error) return { status: 127, stdout: "" };
  return { status: typeof res.status === "number" ? res.status : 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * `_life_context()` (common.sh:531-548) + its call site's gate and wrapping
 * (thinkers/monolith/step:281-291), ported as one function: resolve the
 * rollup map-model precedence, run `recap <rootTrajId> --context --budget …
 * --raw-tail … [--map-model …] -q` IN-PROCESS via src/recap.ts's own
 * `runRecap` (this port's `--context` staircase, not a subprocess — see
 * RunMonolithWakeOptions.recapRunLlm above), and fold the result into the
 * exact wrapper text `thinkers/monolith/step:288-291` builds around it.
 * Degrades to "" on any error/non-zero exit, same as `_life_context`'s own
 * `2>/dev/null || true` and the outer `_lc=$(_life_context) || _lc=""`.
 *
 * PORT-NOTE (1c: 3330189, a4ed181): `command -v recap` is moot here — this
 * port calls recap.ts's `runRecap` in-process rather than shelling out to a
 * `recap` binary on PATH, so "recap not installed" cannot occur; the
 * analogous failure this still degrades on is `runRecap` erroring/exiting
 * non-zero (a bad trajectory dir, a budget/raw-tail parse failure, a thrown
 * exception), which the try/catch below and the exit-code check both cover.
 */
export function lifeContextSection(
  rootTrajId: string,
  trajDir: string,
  env: NodeJS.ProcessEnv,
  runLlm: RecapIO["runLlm"],
  now: () => Date
): string {
  // thinkers/monolith/step:287 `[[ "${MONOLITH_TIERED_MEMORY:-1}" == "1" ]]`.
  if ((env["MONOLITH_TIERED_MEMORY"] ?? "1") !== "1") return "";

  // common.sh:538-539 `m="${ROLLUP_MODEL:-${RECAP_MAP_MODEL:-${SHELLM_FAST_MODEL:-}}}"`
  // (3330189: RECAP_MAP_MODEL beats SHELLM_FAST_MODEL) — `mm=(--map-model "$m")`
  // only when `$m` is non-empty; otherwise no flag, and recap's own
  // `RECAP_MAP_MODEL || defaultModel` default resolution applies.
  const mapModel = env["ROLLUP_MODEL"] || env["RECAP_MAP_MODEL"] || env["SHELLM_FAST_MODEL"] || "";
  const argv = [
    rootTrajId,
    "--context",
    "--budget",
    env["MONOLITH_CONTEXT_BUDGET"] || "auto",
    // a4ed181: no verbatim raw tail by default — the monolith renders its
    // own recent stream, so `recap`'s auto raw tail (>= 20 rows) only
    // repeated it. ROLLUP_RAW_TAIL still overrides.
    "--raw-tail",
    env["ROLLUP_RAW_TAIL"] || "0",
    ...(mapModel ? ["--map-model", mapModel] : []),
    "-q",
  ];

  let out = "";
  const io: RecapIO = {
    cwd: trajDir,
    env: { ...env, TRAJ_DIR: trajDir },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {}, // -q + `2>/dev/null`: recap's own notes are discarded.
    now,
    runLlm,
  };
  let lc: string;
  try {
    lc = runRecap(argv, io) === 0 ? out : "";
  } catch {
    lc = "";
  }
  // bash `_lc=$(_life_context)`: command substitution strips ALL trailing
  // newlines, not just one.
  lc = lc.replace(/\n+$/, "");
  if (lc === "") return "";
  // thinkers/monolith/step:288-291's heredoc, verbatim (header line, the
  // staircase text, then exactly one blank line).
  return (
    "Your life so far (tiered summary, oldest→newest). A record of what happened, not a rule for what comes next: past stretches of waiting, restraint, or one line of research do not bind this wakeup.\n" +
    lc +
    "\n\n"
  );
}

/** BackoffState plus the two fields 130796a (thinkers/_lib/common.sh) added
 *  to the SAME state file: `related_prev` (the related-memory names shown
 *  last wake, so an open thread does not repeat them) and `goal_review_at`
 *  (epoch seconds of the last GOAL REVIEW hint, for the weekly cadence). */
interface MonolithState extends BackoffState {
  relatedPrev: string[];
  goalReviewAt: number;
}

function loadBackoffState(stateDir: string): MonolithState {
  try {
    const raw = fs.readFileSync(path.join(stateDir, "monolith_backoff_state.json"), "utf8");
    const j = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const relatedPrev = Array.isArray(j["related_prev"]) ? (j["related_prev"] as unknown[]).map(String) : [];
    return {
      level: intOr(j["level"], 0),
      ticksAtLevel: intOr(j["ticks_at_level"], 0),
      wakesSinceShareHint: intOr(j["wakes_since_share_hint"], 0),
      relatedPrev,
      goalReviewAt: intOr(j["goal_review_at"], 0),
    };
  } catch {
    return { level: 0, ticksAtLevel: 0, wakesSinceShareHint: 0, relatedPrev: [], goalReviewAt: 0 };
  }
}

function saveBackoffState(stateDir: string, s: MonolithState): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const out = {
    level: s.level,
    ticks_at_level: s.ticksAtLevel,
    wakes_since_share_hint: s.wakesSinceShareHint,
    goal_review_at: s.goalReviewAt,
    related_prev: s.relatedPrev,
  };
  // Atomic tmp+rename, trailing newline (PLAN-daemon §2/§4 monolith_backoff_state.json).
  writeAtomicFile(path.join(stateDir, "monolith_backoff_state.json"), `${JSON.stringify(out)}\n`);
}

/** `<file>.tmp` + rename; writes exactly the bytes given (caller controls trailing newline). */
function writeAtomicFile(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function intOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : d;
}

function trajFileId(traj: Trajectory): string {
  return traj.trajId;
}

// PORT-NOTE (bug #63, bin/shellm:3035-3051 `_redacted_cmdline`/`main`,
// thinkers/monolith/step:274-279,403-406, thinkers/_lib/common.sh:590-700
// `_export_provider_keys`/`_export_skill_vars`/`_build_shellm_flags`): the
// REAL argv the monolith caller hands `shellm`, as `_redacted_cmdline`
// records it on the shellm-run trajectory row. Field/flag ORDER matters for
// byte parity: `--model … --traj … --context-scope run` (main's own argv,
// thinkers/monolith/step:401-404) then `_build_shellm_flags`'s own order
// (`--env`, `--workdir`, then `--var` in construction order, then `--bin`
// per live tool), then `--prompt-file`.
const PROVIDER_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "LLM_API_KEY",
] as const;

// thinkers/_lib/common.sh:684-686's fixed tool list. `bin/shellm` (src/shellmCli.ts, stage 3b #1) is now
// shipped, so `shellm` resolves in `id.binDir` and is listed, as upstream's `command -v shellm` does.
const BIN_TOOL_NAMES = ["mem", "traj", "skills", "context", "llm", "shellm", "chat", "recap"] as const;

/** `_abs_path` (thinkers/_lib/common.sh:614-617): `cd DIR && pwd`. Bash's
 *  `cd`/`pwd` are LOGICAL by default (no `-P`) — they do NOT dereference
 *  symlink path components (verified: `cd /a/symlink && pwd` prints
 *  `/a/symlink`, not its target) — so this normalizes `.`/`..`/relative-to-
 *  cwd the way `path.resolve` does, WITHOUT `fs.realpathSync`'s physical
 *  symlink resolution, which would over-resolve (e.g. macOS's
 *  `/var` → `/private/var`) relative to what bash actually records. Only
 *  applied when DIR exists (mirrors `cd`'s own failure mode); the raw string
 *  otherwise, verbatim. */
function absPath(dir: string): string {
  try {
    fs.statSync(dir);
    return path.resolve(dir);
  } catch {
    return dir;
  }
}

/** The real shellm invocation argv (thinkers/monolith/step:274-279,401-406),
 *  passed through `redactedCmdline` exactly the way `main()`'s
 *  `_redacted_cmdline "$@"` records it on the shellm-run trajectory row.
 *  `hostEnv` stands in for the wake's own process environment — the ONE
 *  ambient value this needs beyond IdentityConfig is SKILLS_KERNEL_DIR
 *  (identity-env.ts sets it; RunMonolithWakeOptions.env already threads the
 *  same ambient env into lifeContextSection above for the same reason). */
function synthCommand(id: IdentityConfig, trajId: string, hostEnv: NodeJS.ProcessEnv): string {
  const execEnv = id.execEnv ?? {};
  const memDir = execEnv["MEM_DIR"] || path.join(id.workdir, "..", "memories");
  const skillsDir = execEnv["SKILLS_DIR"] || path.join(id.workdir, "..", "skills");
  const kernelDir = hostEnv["SKILLS_KERNEL_DIR"] ?? "";
  const chatrc = execEnv["CHATRC"] ?? "";

  const argv: string[] = [
    "--model",
    id.model,
    "--traj",
    trajId,
    "--context-scope",
    "run",
    "--env",
    id.env.name,
    "--workdir",
    id.workdir,
    "--var",
    `IDENTITY_NAME=${id.name}`,
    "--var",
    `MEM_DIR=${absPath(memDir)}`,
    "--var",
    `SKILLS_DIR=${absPath(skillsDir)}`,
    "--var",
    `SKILLS_KERNEL_DIR=${absPath(kernelDir)}`,
    "--var",
    `TRAJ_DIR=${absPath(id.trajDir)}`,
    "--var",
    `TRAJ_ID=${trajId}`,
    "--var",
    `CHATRC=${chatrc}`,
  ];
  // Propagate model + provider routing to nested shellm calls (common.sh:648-657).
  if (execEnv["SHELLM_MODEL"]) argv.push("--var", `SHELLM_MODEL=${execEnv["SHELLM_MODEL"]}`);
  if (execEnv["LLM_PROVIDER"]) argv.push("--var", `LLM_PROVIDER=${execEnv["LLM_PROVIDER"]}`);
  // Provider keys go by bare NAME (common.sh:658-663) — the value stays off
  // argv entirely, so redactedCmdline never even has to mask these.
  for (const key of PROVIDER_KEY_NAMES) {
    if (execEnv[key]) argv.push("--var", key);
  }
  // Skill-declared vars, same bare-NAME form (common.sh:665-677), already in
  // sorted order (src/skill-env.ts's collectSkillVars, matching `sort -u`).
  for (const v of id.skillVarMounts ?? []) {
    argv.push("--var", v.name);
  }
  for (const tool of BIN_TOOL_NAMES) {
    const toolPath = path.join(id.binDir, tool);
    if (fs.existsSync(toolPath)) argv.push("--bin", toolPath);
  }
  argv.push("--prompt-file", "<monolith_prompt>");
  return redactedCmdline(argv);
}

export { delayForLevel };
