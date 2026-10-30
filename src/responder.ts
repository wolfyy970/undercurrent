// responder.ts — the chat-reply thinker (SPEC §4.3; thinkers/responder/step).
//
// Fires on every inbound `message`. Composes and sends a reply with a SINGLE
// llm call and NO tools / NO shellm loop — lowest possible latency (step:4-11).
// Its reply and its decision observation are steps in the SAME single stream as
// the monolith's, so the responder's observation reactively wakes the monolith
// (§3.3, §4.4). Idempotency and the NO_REPLY silence contract are ported to
// source; the Bash quirks are replicated, not fixed.
//
// Behaviour, not Bash text, is the blueprint: the `jq`/`traj`/`chat` plumbing
// becomes in-process typed appends. The step SCHEMA and field names are exact
// (parity diffs on them): reply_claim{content,source:"responder",trigger_step},
// message{content,from,to,source:"chat",reply_to[,follow_up]},
// action{content,source:"responder",trigger_step,person,request},
// observation{content,source:"responder",decision,trigger_step,context_msgs,
// thread_msgs,context_steps,history_source,model,compose_ms,gap_s[,deferred,
// request]}.
//
// Upstream sync 1b (design/conversation_memory.md; ed2dac6 -> 7d29f9e) carries
// parts 1/2/3/5/6 of the conversation-memory plan into the port:
//   - part 1+2: conversation history comes from the derived message index
//     (`messages.jsonl`, src/messageIndex.ts), grouped by person key across
//     every routing name (src/personMemory.ts), plus the Slack thread's last
//     day added as extra user turns (other people's messages, `threadOnly`).
//     Falls back to the recent-stream window when the index has nothing.
//   - part 3: the inner-life excerpt reads the SAME recent-stream projection
//     the monolith does (src/recentStream.ts) — reasoning dropped, idle/error
//     runs collapsed.
//   - part 5: "DEFER: <work>" on the model's first line sends the rest as a
//     holding reply and appends an `action` step the monolith's pending-
//     request hint (src/monolith.ts) picks up.
//   - part 6: context_msgs/thread_msgs/context_steps/history_source/model/
//     compose_ms/gap_s are stamped on the decision observation.
// Part 4 (per-person notes) is ported too, with one noted deviation: the
// port's LlmClient has no per-call model selection (a real client's model is
// baked into its construction), so the notes writer reuses the SAME llm
// client as the reply rather than a cheaper RESPONDER_NOTES_MODEL — see
// updatePersonNotes. The async path (RESPONDER_PERSON_NOTES_SYNC unset,
// step:397-400's detached subshell) spawns a real detached OS process
// (bin/responder-notes.mjs, spawnPersonNotesWriter) rather than firing an
// in-process promise: a fire-and-forget promise does NOT outlive
// bin/thinker-step.mjs's process.exit(), so it silently never wrote a note —
// a real bug, fixed here.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { Trajectory } from "./trajectory.ts";
import { LlmCallError, type LlmClient, type ChatMessage, type LlmResponse } from "./llm.ts";
import { redactCard, redactKeys } from "./responderRedact.ts";
import { isoTs } from "./trajCore.mjs";
import type { Step } from "./types.ts";
import { recentStream } from "./recentStream.ts";
import { indexUpdate, queryHistory, type IndexedMessage } from "./messageIndex.ts";
import { personKey, threadKey, personAliases, findPersonMemoryFile, notesBody, type PersonMemoryFile } from "./personMemory.ts";
import { slugify } from "./mem.ts";
import { PORT_BIN } from "./identity-env.ts";
import { type WakeIO, REAL_WAKE_IO } from "./shellm.ts";
import { runtimePath } from "./runtime.ts";

/** `bin/responder-notes.mjs` — the detached child the async notes path spawns
 *  (see `spawnPersonNotesWriter` below). */
export const RESPONDER_NOTES_SCRIPT = path.join(PORT_BIN, "responder-notes.mjs");

const THINKER_NAME = "responder";
const CLAIM_TTL_MS = 180_000; // RESPONDER_CLAIM_TTL=180s (step:71)
const THINK_CONTEXT_TAIL_DEFAULT = 20; // thinkers/responder/step:22 `THINK_CONTEXT_TAIL="${THINK_CONTEXT_TAIL:-20}"`
const HISTORY_SINCE_S = 7 * 86400; // RESPONDER_HISTORY_SINCE=7d
const HISTORY_MAX = 20; // RESPONDER_HISTORY_MAX
const THREAD_SINCE_S = 86400; // RESPONDER_THREAD_SINCE=1d
const THREAD_MAX = 20; // RESPONDER_THREAD_MAX
const NOTES_SINCE_S = 30 * 86400; // RESPONDER_NOTES_SINCE=30d
export const NOTES_MAX = 40; // RESPONDER_NOTES_MAX
const DEFAULT_HOLDING_MESSAGE = "Let me look into that and get back to you.";
const MAX_TOKENS = 8192; // RESPONDER_MAX_TOKENS
const MAX_TIME_S = 180; // RESPONDER_MAX_TIME
const MAX_TRIGGER_AGE_S = 900; // RESPONDER_MAX_TRIGGER_AGE
/** The reply.schema.json the structured call sends (thinkers/responder/reply.schema.json). */
export const REPLY_SCHEMA_FILE = new URL("./assets/thinkers/responder/reply.schema.json", import.meta.url);

/** `_supports_schema`: model ids whose provider enforces a JSON Schema. */
export function supportsSchema(model: string): boolean {
  return /^(deepseek\/|x-ai\/|z-ai\/glm-5|moonshotai\/|qwen\/|meta-llama\/|mistralai\/|google\/gemini|openai\/|gpt-4o|gpt-5|o1|o3|o4)/.test(model);
}

export type ResponderOutcome =
  | "skipped" // not a message to us
  | "self-dropped" // we chat-sent to ourselves
  | "already-handled" // idempotency short-circuit
  | "replied"
  | "no-reply"
  | "reply-failed"
  | "stale-trigger"; // replayed history, not a new message (RESPONDER_MAX_TRIGGER_AGE)

export interface ResponderResult {
  outcome: ResponderOutcome;
  claimStepId?: string;
  replyStepId?: string;
  observationStepId?: string;
}

/** The step the dispatcher hands the responder (the triggering `message`). */
export interface ResponderTrigger {
  type: string;
  content?: string;
  step_id?: string;
  from?: string;
  to?: string;
  source?: string;
  ts?: string;
  [k: string]: unknown;
}

export interface RunResponderOptions {
  trajectory: Trajectory;
  llm: LlmClient;
  identityName: string;
  identityText: string; // `identity prompt` output (stubbed for the slice)
  skillsText: string; // `skills prompt` output (stubbed)
  trigger: ResponderTrigger;
  /** now() injectable for a deterministic claim-freshness cutoff and age stamps in tests. */
  now?: () => number;
  claimTtlMs?: number;
  /** The reply model, recorded on the decision observation (part 6). */
  model?: string;
  /** MEM_DIR — `type: person` memories (aliases, notes) live here. */
  memDir?: string;
  /** IDENTITY_DIR — RESPONDER_LOG_PROMPT writes under `<identityDir>/run/logs/`. */
  identityDir?: string;
  historySinceSeconds?: number;
  historyMax?: number;
  threadSinceSeconds?: number;
  threadMax?: number;
  /** RESPONDER_PERSON_NOTES (default true). */
  personNotes?: boolean;
  /** RESPONDER_PERSON_NOTES_SYNC — await the notes writer in-process instead
   *  of spawning it detached (tests want this; production doesn't want the
   *  human to wait on a second LLM call). */
  personNotesSync?: boolean;
  /** RESPONDER_LOG_PROMPT. */
  logPrompt?: boolean;
  /** RESPONDER_MAX_TOKENS (default 8192): output cap for the reply call, reasoning included. */
  maxTokens?: number;
  /** RESPONDER_MAX_TIME seconds (default 180): wall-clock cap for the reply call. */
  maxTimeSeconds?: number;
  /** RESPONDER_MAX_TRIGGER_AGE seconds (default 900; 0 disables): older triggers are replayed history. */
  maxTriggerAgeSeconds?: number;
  /** RESPONDER_STRUCTURED: "1" force, "0" off, anything else = auto (a model whose provider enforces a schema). */
  structured?: string;
  /** The resolved identity env (steprun's resolveIdentityEnv output) — passed
   *  through to the detached notes-writer child (bin/responder-notes.mjs) so
   *  it can independently rebuild an LlmClient (buildLlmClient) with the same
   *  API key / model / replay fixture the reply used. Defaults to process.env. */
  env?: Record<string, string>;
  /** Test seam: overrides the real detached-spawn call for the async notes
   *  path. Mirrors src/init.ts's IO.spawnDetached. */
  spawnDetached?: SpawnDetachedFn;
  /** Operator-visible progress IO (thinkers/responder/step's own
   *  `printf ... >&2` lines); defaults to the real process streams. */
  io?: WakeIO;
}

export interface SpawnDetachedOptions {
  env: Record<string, string>;
  logFile: string;
}

export type SpawnDetachedFn = (cmd: string, args: string[], opts: SpawnDetachedOptions) => number;

/**
 * Spawn `cmd` DETACHED + unref'd, stdout/stderr appended to `opts.logFile`
 * (created if missing), stdin ignored — the same technique
 * thinkersctl.ts's `drainThenFinish` and init.ts's `spawnDetached` use so the
 * PARENT process (here: the responder's wake, about to `process.exit()`
 * — bin/thinker-step.mjs) never waits on the child and the child survives
 * the parent's exit.
 */
function defaultSpawnDetached(cmd: string, args: string[], opts: SpawnDetachedOptions): number {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const logFd = fs.openSync(opts.logFile, "a");
  const child = spawn(cmd, args, {
    env: opts.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  if (typeof child.pid !== "number") throw new Error(`responder: failed to spawn ${cmd}`);
  return child.pid;
}

/**
 * step:398-400's log path exactly: `<identityDir>/run/logs/responder-notes.log`
 * (`${IDENTITY_DIR:-.}` when identityDir is absent — matches the Bash's
 * unset-var default). Argv carries only non-secret identifiers (file paths,
 * names); the LLM config (API key, model, replay fixture) reaches the child
 * ONLY via the inherited environment (opts.env, default process.env) —
 * never argv, so it never shows up in a process listing.
 */
function spawnPersonNotesWriter(
  opts: RunResponderOptions,
  args: { trajFile: string; idxFile: string; memDir: string | undefined; identityName: string; personKey: string; msgFrom: string }
): void {
  const identityDir = opts.identityDir || ".";
  const logFile = path.join(identityDir, "run", "logs", "responder-notes.log");
  const env = opts.env ?? (process.env as Record<string, string>);
  const scriptArgs = [args.trajFile, args.idxFile, args.memDir ?? "", args.identityName, args.personKey, args.msgFrom];
  const spawnFn = opts.spawnDetached ?? defaultSpawnDetached;
  try {
    spawnFn(runtimePath(), [RESPONDER_NOTES_SCRIPT, ...scriptArgs], { env, logFile });
  } catch {
    /* best-effort — a failed spawn must never fail the reply that already sent */
  }
}

export async function runResponder(opts: RunResponderOptions): Promise<ResponderResult> {
  const { trajectory: traj, trigger } = opts;
  const now = opts.now ?? (() => Date.now());
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const me = opts.identityName;
  const model = opts.model ?? "claude-opus-4-7";
  const io = opts.io ?? REAL_WAKE_IO;

  const startMs = now(); // t_start_ms: compose_ms covers the whole wake, the llm call included
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const maxTokens = opts.maxTokens ?? positiveInt(env["RESPONDER_MAX_TOKENS"], MAX_TOKENS);
  const maxTimeS = opts.maxTimeSeconds ?? positiveInt(env["RESPONDER_MAX_TIME"], MAX_TIME_S);

  const triggerType = String(trigger.type ?? "");
  const triggerContent = trigger.content === undefined ? "" : String(trigger.content);
  const triggerStepId = trigger.step_id === undefined ? "" : String(trigger.step_id);
  const msgTo = trigger.to === undefined ? "" : String(trigger.to);
  const msgFrom = trigger.from === undefined ? "human" : String(trigger.from);

  // step:32 — only handle message steps.
  if (triggerType !== "message") return { outcome: "skipped" };
  // step:38 — only reply to messages addressed to this identity.
  if (msgTo !== me) return { outcome: "skipped" };

  // One redacted excerpt for every observation that quotes the message (step
  // trigger_excerpt): redacted BEFORE the 200 cut so digits straddling it are
  // still caught. The message step itself is the record and keeps its content.
  const triggerExcerpt = clip(redactCard(triggerContent), 200);

  // Stale-trigger guard (sync 2e39a3f): a message step is dispatched within a
  // second of being appended, so a trigger stamped long ago is history
  // re-fed by the dispatcher (2026-09-12: a rewritten trajectory replayed
  // month-old Slack threads for 22 hours). Deliberately no observation step:
  // one would wake the monolith per stale message, the flood this prevents.
  const maxAge = opts.maxTriggerAgeSeconds ?? triggerAgeEnv(env["RESPONDER_MAX_TRIGGER_AGE"]);
  if (maxAge > 0) {
    const trigEpoch = triggerEpoch(trigger.ts);
    if (trigEpoch !== undefined) {
      const age = Math.floor(now() / 1000) - trigEpoch;
      if (age > maxAge) {
        io.stderr(
          `  stale trigger: message ${triggerStepId} from ${msgFrom} is ${age}s old (RESPONDER_MAX_TRIGGER_AGE=${maxAge}) — replayed history, not a new message; not replying\n`
        );
        return { outcome: "stale-trigger" };
      }
    }
  }

  // step:52-56 — self-message guard: replying would create a self-chat loop.
  if (msgFrom === me) {
    io.stderr("  self-message — dropping with observation\n");
    const obsId = appendObservation(
      traj,
      `self-message dropped: you chat-sent a message to yourself and it will not be replied to (replying would loop). To message someone else use: chat reply <their-name> <message>. To keep a note for later, write it as a thought step instead. Your message was: ${triggerExcerpt}`,
      triggerStepId,
      undefined,
      {}
    );
    return { outcome: "self-dropped", observationStepId: obsId };
  }

  if (triggerContent === "") return { outcome: "skipped" };

  // step:60-86 — idempotency, three layers keyed on the trigger step.
  if (triggerStepId) {
    const cutoff = isoTs(new Date(now() - claimTtlMs));
    if (responderAlreadyHandled(traj.read(), me, msgFrom, triggerStepId, cutoff)) {
      io.stderr(`  already handled step ${triggerStepId} (reply/decision/live claim) — skipping\n`);
      return { outcome: "already-handled" };
    }
  }

  // step:88-101 — claim: an audit-trail step.
  io.stderr(`  claiming reply to ${msgFrom}...\n`);
  const claimStepId = traj.append({
    type: "reply_claim",
    content: `handling reply to ${msgFrom}`,
    source: THINKER_NAME,
    ...(triggerStepId ? { trigger_step: triggerStepId } : {}),
  });

  // ---------------------------------------------------------------------
  // Compose the reply — a SINGLE llm call.
  // ---------------------------------------------------------------------
  const systemPrompt = buildResponderSystem(me, opts.identityText, opts.skillsText);
  const steps = traj.read();
  // Behavioral-parity fix (B2): the window honours THINK_CONTEXT_TAIL (responder/step:22,232), like the monolith.
  const tailEnv = Number((opts.env ?? process.env)["THINK_CONTEXT_TAIL"]);
  const THINK_CONTEXT_TAIL = Number.isInteger(tailEnv) && tailEnv > 0 ? tailEnv : THINK_CONTEXT_TAIL_DEFAULT;
  const recentContext = recentStream(steps, THINK_CONTEXT_TAIL);

  const historySince = opts.historySinceSeconds ?? HISTORY_SINCE_S;
  const historyMax = opts.historyMax ?? HISTORY_MAX;
  const threadSince = opts.threadSinceSeconds ?? THREAD_SINCE_S;
  const threadMax = opts.threadMax ?? THREAD_MAX;

  const idxFile = path.join(path.dirname(traj.trajFile), "messages.jsonl");
  indexUpdate(traj.trajFile, idxFile);

  const senderKey = personKey(msgFrom);
  const senderAliases = personAliases(opts.memDir, senderKey);
  let historyJson: IndexedMessage[] = queryHistory(idxFile, {
    me,
    keys: senderAliases,
    threadKey: "",
    sinceSeconds: historySince,
    n: historyMax,
    now,
  });

  const tKey = threadKey(msgFrom);
  const threadJson: IndexedMessage[] =
    tKey !== ""
      ? queryHistory(idxFile, { me, keys: [], threadKey: tKey, sinceSeconds: threadSince, n: threadMax, now })
      : [];

  let historySource: "index" | "window" = "index";
  if (historyJson.length === 0) {
    // Nothing indexed for this person (or the index is unreadable): fall back
    // to the messages in the recent-stream window, as before parts 1+2.
    historySource = "window";
    historyJson = messagesFromContext(recentContext, me, msgFrom);
  }

  const convoSel = buildConvoSel(historyJson, threadJson, {
    me,
    triggerContent,
    triggerStepId,
    nowMs: now(),
  });
  const convo: ChatMessage[] = convoSel.map((c) => ({ role: c.role, content: c.content }));
  const nowUtc = isoTs(new Date(now())).replace(/\.\d{3}Z$/, "Z");

  const inner = innerLifeFromContext(recentContext);

  const personKeyForMe = senderKey;
  const personNotesEnabled = opts.personNotes ?? true;
  let personNotesBlock = "";
  if (personNotesEnabled) {
    const pnf = findPersonMemoryFile(opts.memDir, personKeyForMe);
    if (pnf) {
      const body = notesBody(pnf.content).split("\n").slice(0, 20).join("\n").trim();
      if (body !== "") {
        personNotesBlock =
          `What you know about ${msgFrom} (your own notes; keep them in mind, do not\n` +
          `recite them, and do not treat one past incident as a rule):\n${body}\n\n`;
      }
    }
  }

  // RESPONDER_STRUCTURED: 1, 0, or auto (default) on a model whose provider
  // enforces a JSON Schema. A missing schema file turns it off.
  let replySchema: unknown;
  try {
    replySchema = JSON.parse(fs.readFileSync(REPLY_SCHEMA_FILE, "utf8"));
  } catch {
    replySchema = undefined;
  }
  const structuredMode = opts.structured ?? (env["RESPONDER_STRUCTURED"] || "auto");
  let structured = structuredMode === "1" ? true : structuredMode === "0" ? false : supportsSchema(model);
  if (replySchema === undefined) structured = false;

  let replySystem = buildReplySystem(systemPrompt, msgFrom, historySince, personNotesBlock, inner.text, nowUtc, structured);

  if (opts.logPrompt && opts.identityDir) {
    logPrompt(opts.identityDir, triggerStepId, replySystem, convo);
  }

  io.stderr(`  replying to ${msgFrom}...\n`);

  // ---- the reply call (step:SHAPE + _reply_llm) ----------------------------
  // PORT-NOTE (bug #53, bin/llm:1424-1475): OpenRouterClient.complete() carries
  // bin/llm's own LLM_RETRIES ladder. The responder turns it OFF for its own
  // call (`LLM_RETRIES=0`, sync 2e39a3f: a second three-minute attempt is not a
  // chat reply) and bounds the call on its own with RESPONDER_MAX_TOKENS and
  // RESPONDER_MAX_TIME. A terminal throw is "the provider never gave back an
  // answer" and takes the empty-reply path; LlmCallError says whether the cap
  // was the wall clock (`timedOut`) or the token budget (`truncated`).
  const meta: LlmMeta = { llm_ms: 0, llm_calls: 0 };
  const callLlm = async (system: string, schema: unknown | undefined): Promise<{ ok: boolean; text: string }> => {
    const t0 = now();
    let ok = true;
    let text = "";
    let timedOut = false;
    let truncated = false;
    let usage: LlmResponse["usage"];
    try {
      const resp = await opts.llm.complete(system, convo, {
        maxTokens,
        maxTimeMs: maxTimeS * 1000,
        retries: 0,
        ...(schema !== undefined ? { jsonSchema: schema } : {}),
      });
      text = stripTrailingNewlines(resp.text); // `reply=$(...)`
      usage = resp.usage;
      // _reply_llm `cat "$err" >&2`: the llm call's own warnings land in the step's stderr, success or not.
      if (resp.diagnostics) io.stderr(resp.diagnostics);
    } catch (e) {
      ok = false;
      if (e instanceof LlmCallError) {
        timedOut = e.timedOut;
        truncated = e.truncated;
        if (e.diagnostics) io.stderr(e.diagnostics);
      }
    }
    if (usage?.truncated === true) truncated = true;
    meta.llm_ms = (meta.llm_ms ?? 0) + Math.max(0, now() - t0);
    meta.llm_calls = (meta.llm_calls ?? 0) + 1;
    if (usage?.out_tok !== undefined) meta.out_tok = usage.out_tok;
    if (usage?.think_tok !== undefined) meta.think_tok = usage.think_tok;
    if (usage?.served_by !== undefined) meta.served_by = usage.served_by;
    if (truncated) meta.truncated = true;
    if (timedOut) meta.timed_out = true;
    return { ok, text };
  };

  let reply = "";
  let parse = "text";
  if (structured) {
    parse = "structured";
    const r = await callLlm(replySystem, replySchema);
    reply = r.text;
    if (!r.ok) {
      if (meta.timed_out === true || meta.truncated === true) {
        // The budget is spent (the wall clock, or the whole token cap on
        // nothing visible); a second attempt would only double the wait.
        io.stderr(
          `  structured reply call spent its budget (timed out: ${meta.timed_out === true ? 1 : 0}, truncated: ${meta.truncated === true ? 1 : 0}) — not retrying\n`
        );
        reply = "";
      } else {
        // The provider refused the schema (or the call failed fast): once more
        // as plain text so a model without structured output answers.
        io.stderr("  structured reply call failed — retrying as plain text\n");
        structured = false;
        parse = "text";
        replySystem = buildReplySystem(systemPrompt, msgFrom, historySince, personNotesBlock, inner.text, nowUtc, false);
        reply = (await callLlm(replySystem, undefined)).text;
        meta.fallback = true;
      }
    }
  } else {
    reply = (await callLlm(replySystem, undefined)).text;
  }

  const metricsBase = {
    context_msgs: convoSel.filter((c) => c.step_id !== triggerStepId).length,
    thread_msgs: convoSel.filter((c) => c.step_id !== triggerStepId && c.threadOnly).length,
    context_steps: [...convoSel.map((c) => c.step_id), ...inner.stepIds].filter((s) => s !== ""),
    history_source: historySource,
    model,
  };
  const triggerTs = trigger.ts === undefined ? "" : String(trigger.ts);
  const gapS = computeGapSeconds(steps, me, msgFrom, triggerStepId, triggerTs);
  // _finish_metrics: metrics + the call record + compose_ms + gap_s + parse.
  const finishMetrics = (): Record<string, unknown> => ({
    ...metricsBase,
    ...meta,
    compose_ms: Math.max(0, now() - startMs),
    ...(gapS !== undefined ? { gap_s: gapS } : {}),
    ...(parse !== "" ? { parse } : {}),
  });
  const failMetrics = (kind: string): Record<string, unknown> => ({ ...finishMetrics(), failure: kind });
  const failed = (text: string, kind: string): ResponderResult => {
    const obsId = appendObservation(traj, text, triggerStepId, "reply-failed", failMetrics(kind));
    return { outcome: "reply-failed", claimStepId, observationStepId: obsId };
  };

  // Nothing came back and the call itself was the reason: say which.
  if (reply.replace(/[ \t\n\v\f\r]/g, "") === "") {
    if (meta.timed_out === true) {
      io.stderr("  reply call timed out — appending failure observation\n");
      return failed(
        `reply failed: the model took longer than ${maxTimeS}s to answer ${msgFrom}, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`,
        "timeout"
      );
    }
    if (meta.truncated === true) {
      io.stderr(`  reply hit the ${maxTokens} token cap with nothing usable — appending failure observation\n`);
      return failed(
        `reply failed: the model spent its whole ${maxTokens} token budget answering ${msgFrom} and produced nothing usable, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`,
        "truncated"
      );
    }
  }

  const interp = interpretReply(reply, { structured, triggerContent, msgFrom }, (l) => io.stderr(l));
  if (interp.parse !== undefined) parse = interp.parse;
  if (interp.kind === "fail") {
    return failed(
      interp.failure === "markup"
        ? `reply failed: the model answered ${msgFrom} with tool-call markup instead of a message, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`
        : interp.broken
          ? `reply failed: the model's reply to ${msgFrom} was a broken JSON object, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`
          : `reply failed: the model's reply to ${msgFrom} was a raw JSON object, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`,
      interp.failure
    );
  }
  if (interp.kind === "no-reply") {
    const obsId = appendObservation(
      traj,
      `Chose not to reply to ${msgFrom} — their message needed no reply (already answered, or a bare acknowledgment). Their message was: ${triggerExcerpt}`,
      triggerStepId,
      "no-reply",
      finishMetrics()
    );
    return { outcome: "no-reply", claimStepId, observationStepId: obsId };
  }
  reply = interp.text;
  const deferredRequest = interp.deferredRequest;
  if (interp.deferred) {
    traj.append({
      type: "action",
      content:
        `Pending request from ${msgFrom}: ${deferredRequest}. The responder told them I would get back to them. ` +
        `Do the work, then deliver with: chat reply --follow-up --reply-to ${triggerStepId} ${msgFrom} "<result>" ` +
        `and append an observation with --field resolves=${triggerStepId}`,
      source: THINKER_NAME,
      person: msgFrom,
      request: deferredRequest,
      ...(triggerStepId ? { trigger_step: triggerStepId } : {}),
    });
  }
  if (interp.rawObjectAfterDefer) {
    return failed(
      `reply failed: the model's reply to ${msgFrom} was a raw JSON object, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`,
      "parse"
    );
  }
  if (interp.markupAfterDefer) {
    return failed(
      `reply failed: the model answered ${msgFrom} with tool-call markup instead of a message, so nothing was sent. Reply to them yourself. Their message was: ${triggerExcerpt}`,
      "markup"
    );
  }

  // step:163-169 — send the reply and record decision="replied".
  // PORT-NOTE (sync 2e39a3f, `chat reply --force` on a deferral): the port
  // appends the `message` step directly and so never meets chat reply's
  // CHAT_REPLY_REPEAT_WINDOW refusal; the per-inbound answered guard
  // (hasStampedReply) is the one guard both sides keep, and it still stops a
  // second holding line on the same inbound.
  if (reply !== "" && !hasStampedReply(traj.read(), me, triggerStepId)) {
    const replyStepId = traj.append({
      type: "message",
      content: reply,
      from: me,
      to: msgFrom,
      source: "chat",
      ...(triggerStepId ? { reply_to: triggerStepId } : {}),
    });
    // bin/chat:193 `chat reply`'s own "Reply sent." (the port sends the
    // reply by appending the `message` step directly rather than shelling
    // out to `chat reply` — see runResponder's doc comment on this branch).
    io.stderr("Reply sent.\n");
    const extra: Record<string, unknown> = { ...finishMetrics(), structured, parse };
    if (deferredRequest !== "") {
      extra["deferred"] = true;
      extra["request"] = deferredRequest;
    }
    const obsId = appendObservation(
      traj,
      deferredRequest !== ""
        ? `Replied to ${msgFrom} with a holding message and handed the mind a pending request: ${clip(deferredRequest, 200)}`
        : `Replied to ${msgFrom}: ${clip(reply, 200)}`,
      triggerStepId,
      "replied",
      extra
    );
    // thinkers/responder/step:465 — first line of the SENT reply.
    io.stdout(`  [reply -> ${msgFrom}] ${reply.split("\n")[0] ?? ""}\n`);
    if (personNotesEnabled) {
      if (opts.personNotesSync) {
        // RESPONDER_PERSON_NOTES_SYNC=1 (step:395-396): run it inline, in
        // this process, awaited — tests want this; a real interactive wake
        // does not want the human waiting on a second LLM call for it.
        await updatePersonNotes({
          trajFile: traj.trajFile,
          idxFile,
          llm: opts.llm,
          memDir: opts.memDir,
          identityName: me,
          personKey: personKeyForMe,
          msgFrom,
          now,
          ...(opts.env ? { env: opts.env } : {}),
        });
      } else {
        // step:397-400: upstream backgrounds `_update_person_notes` in a
        // DETACHED subshell (`( ... ) >>notes.log 2>&1 </dev/null &`) that
        // outlives the responder step. An in-process fire-and-forget promise
        // does NOT reproduce that: bin/thinker-step.mjs calls process.exit()
        // the instant runResponder resolves, killing the in-flight notes LLM
        // call every time (proven live — no `type: person` memory ever
        // appeared and responder-notes.log was never created). Spawning a
        // real detached child process is the faithful port of "outlives the
        // parent" — mirrors thinkersctl.ts's drainThenFinish.
        spawnPersonNotesWriter(opts, {
          trajFile: traj.trajFile,
          idxFile,
          memDir: opts.memDir,
          identityName: me,
          personKey: personKeyForMe,
          msgFrom,
        });
      }
    }
    return { outcome: "replied", claimStepId, replyStepId, observationStepId: obsId };
  }

  // step:171-173 — reply failed (empty model output, or the duplicate guard fired).
  io.stderr("  reply failed — appending failure observation\n");
  return failed(
    `reply failed: could not send a reply to ${msgFrom} (empty model output or chat error — see responder log). Their message was: ${triggerExcerpt}`,
    reply === "" ? "empty" : "send"
  );
}

// --------------------------------------------------------------------------
// reply-shape helpers (sync 2e39a3f)
// --------------------------------------------------------------------------

/** `${VAR:-default}` for a count: unset, empty, or not all digits (or 0) falls back to the default. */
function positiveInt(raw: string | undefined, dflt: number): number {
  return raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : dflt;
}

/** RESPONDER_MAX_TRIGGER_AGE: `${:-900}`; a non-numeric value disables the guard (`=~ ^[0-9]+$` fails); 0 disables. */
function triggerAgeEnv(raw: string | undefined): number {
  const v = raw === undefined || raw === "" ? String(MAX_TRIGGER_AGE_S) : raw;
  return /^[0-9]+$/.test(v) ? Number(v) : 0;
}

/**
 * The trigger's `ts` as epoch seconds: jq's `sub("\\.[0-9]+"; "") | sub("\\+0000$"; "Z") |
 * fromdateiso8601?`. Anything that is not then a plain `…Z` second stamp is
 * undefined (the guard fails open).
 */
function triggerEpoch(ts: unknown): number | undefined {
  if (typeof ts !== "string" || ts === "") return undefined;
  const t = ts.replace(/\.[0-9]+/, "").replace(/\+0000$/, "Z");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(t)) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** The record `_reply_llm` accumulates: key order is jq's `+` order. */
interface LlmMeta {
  llm_ms?: number;
  llm_calls?: number;
  out_tok?: number;
  think_tok?: number;
  served_by?: string;
  truncated?: true;
  timed_out?: true;
  fallback?: true;
}

/** `$(...)`: command substitution drops trailing newlines. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/** `sed -E '/[^[:space:]]/,$!d'` — delete the lines before the first one with a non-space character. */
function dropLeadingBlankLines(s: string): string {
  const lines = s.split("\n");
  const i = lines.findIndex((l) => /[^ \t\n\v\f\r]/.test(l));
  return i < 0 ? "" : lines.slice(i).join("\n");
}

/** `sed '/./,$!d'` — delete the leading EMPTY lines (a whitespace-only line has a character). */
function dropLeadingEmptyLines(s: string): string {
  const lines = s.split("\n");
  const i = lines.findIndex((l) => l !== "");
  return i < 0 ? "" : lines.slice(i).join("\n");
}

/** The awk that splits a DEFER: glued to a non-space character onto its own line. */
function splitGluedDefer(s: string): string {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    const i = line.indexOf("DEFER:");
    if (i > 0 && !/[ \t\n\v\f\r]/.test(line[i - 1]!)) {
      out.push(line.slice(0, i));
      out.push(line.slice(i));
    } else out.push(line);
  }
  return out.join("\n");
}

/** `awk '!/[^[:space:]]/ || !seen[$0]++'` then the trailing-empty-line sed. */
function dedupeLines(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of s.split("\n")) {
    if (!/[^ \t\n\v\f\r]/.test(line)) out.push(line);
    else if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** `_is_skills_command_tag`: the WHOLE reply is one `<skills show NAME>` tag. */
function isSkillsCommandTag(s: string): boolean {
  return /^[ \t\n\v\f\r]*<skills[ \t\n\v\f\r]+show[ \t\n\v\f\r]+[A-Za-z0-9._/-]+>[ \t\n\v\f\r]*$/.test(s);
}

/** jq `ascii_downcase`. */
function asciiDowncase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** `jq -r '.f // ""'`: null/false/absent are "", strings pass, anything else prints as compact JSON. */
function jqText(v: unknown): string {
  if (v === undefined || v === null || v === false) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

type ReplyObject = Record<string, unknown>;

function asActionObject(text: string): ReplyObject | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as ReplyObject)["action"] === "string") {
    return v as ReplyObject;
  }
  return undefined;
}

/** The first line's opening ```/```json fence (and the whitespace after it). */
function stripOpeningFence(s: string): string {
  return s.replace(/^[ \t\r\v\f]*```(json)?[ \t\r\v\f]*/, "");
}

/** The reply as one JSON object with a string `action`, fences stripped; undefined otherwise. */
function parseStructuredObject(reply: string): ReplyObject | undefined {
  const t = stripOpeningFence(reply).replace(/[ \t\r\v\f]*```[ \t\r\v\f]*$/, "");
  return asActionObject(t);
}

/**
 * `_salvage_object`: a cut-off object is repaired when the cut fell outside a
 * string (DeepSeek's 2026-09-21 shape: complete up to `"message":""`, then
 * whitespace to the cap): closing braces make it whole. A cut inside a string
 * is repaired only for no_reply, since a reply or holding message cut
 * mid-sentence must not reach the person.
 */
function salvageObject(reply: string): ReplyObject | undefined {
  const t = stripTrailingNewlines(
    stripOpeningFence(reply)
      .split("\n")
      .map((l) => l.replace(/[ \t\r\v\f]+$/, ""))
      .join("\n")
  );
  for (const c of ["}", "}}", '"}', '"}}']) {
    const obj = asActionObject(t + c);
    if (obj === undefined) continue;
    if (c.startsWith('"') && asciiDowncase(String(obj["action"])) !== "no_reply") return undefined;
    return obj;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function appendObservation(
  traj: Trajectory,
  content: string,
  triggerStepId: string,
  decision: string | undefined,
  extra: Record<string, unknown>
): string {
  return traj.append({
    type: "observation",
    content,
    source: THINKER_NAME,
    ...(decision ? { decision } : {}),
    ...(triggerStepId ? { trigger_step: triggerStepId } : {}),
    ...extra,
  });
}

/** _build_system_prompt (common.sh:71-81): persona + skills. */
function buildResponderSystem(name: string, identityText: string, skillsText: string): string {
  let out = `You are an unconscious thought process of an AI person named ${name}.\n`;
  out += `\nAbout ${name}:\n${identityText}`;
  if (skillsText) out += `\n\n${skillsText}`;
  return out;
}

// PORT-NOTE (1c: ed0b700, b6540e6): the NO_REPLY hint below names a bare
// Slack reaction (a `:emoji:` body, optionally `(on <ts>)`) as a case that
// needs no reply, so a reaction never gets a chat reply. Upstream's own
// change was two commits because the first (ed0b700) broke every bash
// responder invocation — the reaction clause's backticks and parens ran as
// unescaped command substitution inside the double-quoted heredoc, fixed by
// b6540e6's backslash-escaping; this port's template literal has no such
// shell-quoting hazard, so only the wording (not an escaping bug) applies.
/**
 * The reply system prompt (step `_compose_reply_system`, sync 2e39a3f): the
 * voice is concrete bans, not adjectives (the 2026-09-16 replay of 57 real
 * prompts cut em dashes, long replies and multi-paragraph replies to 3%, 3%
 * and 0%). The deferral protocol is stated INSIDE the block on purpose: the
 * same block without it halved deferrals. `structured` swaps the three
 * paragraphs that name the output shape (JSON object vs DEFER:/NO_REPLY text).
 */
function buildReplySystem(
  systemPrompt: string,
  from: string,
  historySinceSeconds: number,
  personNotesBlock: string,
  innerContext: string,
  nowUtc: string,
  structured: boolean
): string {
  const since = formatDurationSpec(historySinceSeconds);
  let deferRule: string;
  let deferPara: string;
  let noReplyRule: string;
  let outputPara: string;
  if (structured) {
    deferRule = `answer with action "defer", the work in "request" (one line) and one short
  holding sentence in "message". A holding sentence with action "reply" is a
  promise nobody will keep.`;
    deferPara = `Answer completely from what you already know. If a real answer needs tools,
files, or looking something up, do not guess and do not promise to check
yourself: hand the work to the mind with action "defer" and send a short
holding message such as "Let me look into that and get back to you." The
mind follows up with the result.`;
    noReplyRule = `use action "no_reply" with an empty message.`;
    outputPara = `Output ONLY one JSON object and nothing else (no code fence, no preamble):
{"action": "reply" | "defer" | "no_reply",
 "message": "the reply text to send; empty when no_reply",
 "request": "one line describing the work for the mind; only when defer, else empty"}
The message follows the rules above: no dashes, no markdown, no praise
opener, no closing question. It is delivered automatically: never write
'chat reply' or the recipient's address inside it, and never put commands in it.
Check before you answer: does this need work you cannot do inside this reply?
Then action is "defer", request is the work, message is the holding sentence.`;
  } else {
    deferRule = `write \`DEFER: <the work, one line>\` as the first line and one short holding
  sentence as the second. A holding sentence without the DEFER line is a
  promise nobody will keep.`;
    deferPara = `Answer completely from what you already know. If a real answer needs tools,
files, or looking something up, do not guess and do not promise to check
yourself: put \`DEFER: <the work, one line>\` on the first line, then the short
message to send (e.g. "Let me look into that and get back to you."). The work
is handed to the mind, which follows up with the result.`;
    noReplyRule = `output exactly NO_REPLY on its own line and nothing else.`;
    outputPara = `Output ONLY the reply message text, no preamble, no quotes, no commands.
Delivery is automatic: never write 'chat reply' or the recipient's address.
Check before you answer: does this need work you cannot do inside this reply?
Then the first line is DEFER: and the second is the holding sentence.`;
  }
  return `${systemPrompt}

The current time is ${nowUtc}. You are in a live chat conversation with
${from}. The messages are the real back-and-forth so far, spanning up to
${since}; each of their messages is prefixed with how long ago it was sent,
so mind the gaps (an answer from days ago is not "this morning"). In a group
thread some earlier messages are from other people (the header in each message
names the speaker); they are context, and you are answering ${from}. Reply to
their newest message the way the people in this chat write to each other:
plain sentences, first person, one to three sentences unless they asked for
detail. These rules hold even when you feel you are being helpful:
- No dashes of any kind. Use a period or a comma.
- Do not open by praising or agreeing ("Good question", "Fair", "Got it",
  "Makes sense"). Start with the answer.
- No bold, headers, bullets, or code formatting in chat. If the answer needs
  a list or more than a short paragraph, give the short version and offer to
  put the rest in a thread or a file.
- Do not end with a question unless you need the answer to continue.
- Do not describe your own machinery (wakes, trajectory, responder, bridge,
  thinkers, prompts) unless they asked about it.
- If they ask you to do something, or the answer needs a file, a tool, or a
  lookup, do not answer from guesswork and do not just say you will do it:
  ${deferRule}
- Say what you know, then stop. No filler, no restating their message, no
  sign-off, no "happy to help".
- Everyday words. No "delve", "robust", "leverage", "landscape", "nuance".
  Repeat a word rather than swap in a synonym.
Never repeat or rephrase an earlier reply of yours.
${deferPara}

Not every message needs a reply. If their newest message is already answered
(a reply of yours addressing it is visible above), is a bare acknowledgment
like "thanks" or "ok", is a Slack reaction (a \`:emoji:\` body, optionally with \`(on <ts>)\`), or anything you could say would only repeat you,
${noReplyRule} Staying quiet is
better than a duplicate or a contentless reply.

${personNotesBlock}Your recent inner life (context only, not part of the conversation):
${innerContext}

${outputPara}`;
}

/** Render a since-seconds value back into a short spec ("7d", "36h", ...) for the prompt text. */
function formatDurationSpec(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export interface ConvoTurn {
  role: "user" | "assistant";
  content: string;
  step_id: string;
  /** True when this turn came ONLY from the thread union, not the person's own history. */
  threadOnly: boolean;
}

/** What runResponder makes of the model's reply text (after the empty/timeout checks): the structured-object read and
 *  salvage, the NO_REPLY line, the DEFER protocol (glued/duplicate/skills tag), the raw-object and tool-markup guards,
 *  the leaked `chat reply` prefix, and card redaction. Pure: no I/O but the stderr lines it reports through `note`.
 *  A deferral's action step is written by the caller BEFORE the raw-object/markup guards, as upstream does, so those
 *  two late refusals are reported as flags rather than failures. */
/** What the person-notes call's reply becomes before it is written: credentials/env values/PEM blocks/cards masked
 *  (`_redact_keys`), the first 20 lines, leading and trailing blank lines dropped. Pure. */
export function personNotesBody(text: string, env: Record<string, string | undefined>): string {
  return redactKeys(text, env).split("\n").slice(0, 20).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

export type InterpretedReply =
  | { kind: "fail"; failure: "parse" | "markup"; broken: boolean; parse?: string }
  | { kind: "no-reply"; parse?: string }
  | { kind: "send"; text: string; deferred: boolean; deferredRequest: string; parse?: string; rawObjectAfterDefer: boolean; markupAfterDefer: boolean };
export function interpretReply(
  replyIn: string,
  o: { structured: boolean; triggerContent: string; msgFrom: string },
  note: (line: string) => void = () => {}
): InterpretedReply {
  let reply = replyIn;
  let parse: string | undefined;
  if (o.structured) {
    let obj = parseStructuredObject(reply);
    if (obj === undefined) {
      obj = salvageObject(reply);
      if (obj !== undefined) {
        note("  structured reply was cut off — repaired the object\n");
        parse = "salvaged";
      }
    }
    if (obj !== undefined) {
      const action = asciiDowncase(jqText(obj["action"]));
      const message = jqText(obj["message"]);
      const request = jqText(obj["request"]).replace(/\n/g, " ");
      if (action === "no_reply") reply = "NO_REPLY";
      else if (action === "defer") reply = `DEFER: ${request}\n${message}`;
      else reply = message;
    } else if (reply.split("\n").some((l) => /^[ \t\n\v\f\r]*\{/.test(l))) {
      note("  structured reply did not parse and could not be repaired — not sending\n");
      return { kind: "fail", failure: "parse", broken: true, ...(parse !== undefined ? { parse } : {}) };
    } else {
      note("  structured reply did not parse as an object — treating it as text\n");
      parse = "text";
    }
  }
  const withParse = parse !== undefined ? { parse } : {};

  // Drop leading blank lines first: the NO_REPLY and DEFER protocols key off the first line.
  reply = stripTrailingNewlines(dropLeadingBlankLines(reply));
  // Strip a leaked delivery command if a model echoes one (first line only).
  reply = stripTrailingNewlines(reply.replace(/^[ \t\r\v\f]*chat reply [A-Za-z0-9._-]+[ \t\r\v\f]*/, ""));

  // step:156-161 — NO_REPLY.
  if (firstLineTrimmed(reply) === "NO_REPLY") {
    note("  model declined to reply (NO_REPLY)\n");
    return { kind: "no-reply", ...withParse };
  }

  // Deferral (design/conversation_memory.md, part 5): see the comment this replaced in runResponder's history.
  reply = stripTrailingNewlines(splitGluedDefer(reply));
  let deferredRequest = "";
  let deferred = false;
  if (isSkillsCommandTag(reply)) {
    deferredRequest = o.triggerContent.replace(/[\r\n]/g, " ");
    if (deferredRequest === "") deferredRequest = `Respond to ${o.msgFrom}'s message.`;
    reply = "";
    note("  model returned a skills command tag — deferring to the mind\n");
  }
  const deferLines = reply.split("\n").filter((l) => /^[ \t\n\v\f\r]*DEFER:/.test(l));
  if (deferLines.length > 0 || deferredRequest !== "") {
    deferred = true;
    for (const raw of deferLines) {
      const dl = raw.replace(/^[ \t\n\v\f\r]*DEFER:[ \t\n\v\f\r]*/, "").replace(/[ \t\n\v\f\r]+$/, "");
      if (dl === "") continue;
      if (deferredRequest === "") deferredRequest = dl;
      else if (deferredRequest.startsWith(dl) && dl.length < deferredRequest.length) deferredRequest = dl;
    }
    deferredRequest = stripTrailingNewlines(redactCard(deferredRequest));
    reply = stripTrailingNewlines(
      dropLeadingEmptyLines(
        reply
          .split("\n")
          .filter((l) => !/^[ \t\n\v\f\r]*DEFER:/.test(l))
          .join("\n")
      )
    );
    reply = stripTrailingNewlines(dedupeLines(reply));
    if (reply === "" || isSkillsCommandTag(reply)) reply = DEFAULT_HOLDING_MESSAGE;
    note(`  deferring to the mind: ${deferredRequest}\n`);
  }

  const replyFirstLine = reply.split("\n")[0] ?? "";
  const rawObject = /^[ \t\n\v\f\r]*\{[ \t\n\v\f\r]*"action"/.test(replyFirstLine);
  const markup = !rawObject && /^[ \t\n\v\f\r]*<(function|tool_call|parameter|invoke)[=> ]/.test(replyFirstLine);
  if (rawObject) note("  reply is a raw action object — not sending\n");
  if (markup) note("  model returned tool-call markup instead of a reply — not sending\n");
  if (!deferred && rawObject) return { kind: "fail", failure: "parse", broken: false, ...withParse };
  if (!deferred && markup) return { kind: "fail", failure: "markup", broken: false, ...withParse };

  // What we send back never needs card digits.
  return {
    kind: "send",
    text: stripTrailingNewlines(redactCard(reply)),
    deferred,
    deferredRequest,
    ...withParse,
    rawObjectAfterDefer: rawObject,
    markupAfterDefer: markup,
  };
}

/**
 * The union of person history and thread context, de-duplicated by step id,
 * sorted by time, mapped to chat turns (their messages stamped with age, ours
 * as assistant turns), the trigger excluded then re-appended as the final
 * user turn exactly once, and a leading assistant turn dropped (Anthropic
 * alternation). Ports thinkers/responder/step's `convo_sel` jq pipeline.
 */
export function buildConvoSel(
  personHistory: IndexedMessage[],
  threadHistory: IndexedMessage[],
  opts: { me: string; triggerContent: string; triggerStepId: string; nowMs: number }
): ConvoTurn[] {
  const pids = new Set(personHistory.map((m) => m.step_id).filter((s): s is string => !!s));
  const byId = new Map<string, IndexedMessage>();
  const noId: IndexedMessage[] = [];
  for (const m of [...personHistory, ...threadHistory]) {
    if (m.step_id) {
      if (!byId.has(m.step_id)) byId.set(m.step_id, m);
    } else {
      noId.push(m);
    }
  }
  const merged = [...byId.values(), ...noId];
  merged.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));

  const turns: ConvoTurn[] = [];
  for (const m of merged) {
    const sid = m.step_id ?? "";
    if (sid !== "" && sid === opts.triggerStepId) continue; // excluded — re-added below
    const threadOnly = !pids.has(sid);
    if (m.to === opts.me) {
      turns.push({ role: "user", content: `[${formatAge(m.ts ?? "", opts.nowMs)}] ${m.content}`, step_id: sid, threadOnly });
    } else if (m.from === opts.me) {
      turns.push({ role: "assistant", content: m.content, step_id: sid, threadOnly });
    }
  }
  turns.push({ role: "user", content: opts.triggerContent, step_id: opts.triggerStepId, threadOnly: false });
  if (turns.length > 0 && turns[0]!.role === "assistant") turns.shift();
  return turns;
}

/** `def age` (_age_jq): "just now" / "N min ago" / "N h ago" / "N days ago". */
export function formatAge(ts: string, nowMs: number): string {
  const truncated = (ts || "").slice(0, 19) + "Z";
  const parsedMs = Date.parse(truncated);
  const nowSec = Math.floor(nowMs / 1000);
  const tsSec = Number.isNaN(parsedMs) ? nowSec : Math.floor(parsedMs / 1000);
  const s = nowSec - tsSec;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.floor(s / 60)} min ago`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/** The window-fallback history: message steps between me/them, from the
 *  ALREADY-FILTERED recentStream text (design/conversation_memory.md, part 1
 *  "falls back to the messages in the recent-stream window"). */
export function messagesFromContext(recentContext: string, me: string, them: string): IndexedMessage[] {
  const out: IndexedMessage[] = [];
  for (const line of recentContext.split("\n")) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec["type"] !== "message") continue;
    const from = String(rec["from"] ?? "");
    const to = String(rec["to"] ?? "");
    if (!((from === them && to === me) || (from === me && to === them))) continue;
    out.push({
      ...(rec["step_id"] !== undefined ? { step_id: String(rec["step_id"]) } : {}),
      ...(rec["ts"] !== undefined ? { ts: String(rec["ts"]) } : {}),
      from,
      to,
      content: rec["content"] === undefined || rec["content"] === null ? "" : String(rec["content"]),
    });
  }
  return out;
}

/** Last 8 non-message narrative lines from the (already-filtered) recentStream
 *  text, "[type] content" (part 3: reasoning is already absent upstream). */
export function innerLifeFromContext(recentContext: string): { text: string; stepIds: string[] } {
  const nonMessage: Array<Record<string, unknown>> = [];
  for (const line of recentContext.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec["type"] !== "message") nonMessage.push(rec);
    } catch {
      /* skip */
    }
  }
  const tail = nonMessage.slice(-8);
  const text = tail.map((r) => `[${String(r["type"] ?? "")}] ${r["content"] ?? ""}`).join("\n");
  const stepIds = tail.map((r) => String(r["step_id"] ?? "")).filter((s) => s !== "");
  return { text, stepIds };
}

/**
 * Seconds since the previous message exchanged with this person, read from
 * the FULL step stream (not the filtered/window one — the window is the
 * thing that forgets). Excludes the trigger itself and any reply already
 * stamped to it. `undefined` when there is no earlier exchange (first contact).
 */
export function computeGapSeconds(
  steps: Step[],
  me: string,
  them: string,
  triggerStepId: string,
  triggerTs: string
): number | undefined {
  if (!triggerTs) return undefined;
  let lastTs: string | undefined;
  for (const s of steps) {
    const r = s as Record<string, unknown>;
    if (r["type"] !== "message") continue;
    const sid = String(r["step_id"] ?? "");
    if (triggerStepId !== "" && sid === triggerStepId) continue;
    if (triggerStepId !== "" && String(r["reply_to"] ?? "") === triggerStepId) continue;
    const ts = String(r["ts"] ?? "");
    if (ts === "" || !(ts < triggerTs)) continue;
    const from = r["from"];
    const to = r["to"];
    if (!((from === them && to === me) || (from === me && to === them))) continue;
    lastTs = ts; // last (chronologically latest) match wins
  }
  if (lastTs === undefined) return undefined;
  const a = parseSecondsOrNull(triggerTs);
  const b = parseSecondsOrNull(lastTs);
  if (a === null || b === null) return undefined;
  return a - b;
}

function parseSecondsOrNull(ts: string): number | null {
  const truncated = ts.slice(0, 19) + "Z";
  const ms = Date.parse(truncated);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * _responder_already_handled / _responder_scan (common.sh:185-237). Three
 * layers keyed on the trigger step, plus a later message from us to them:
 *   1. a message from us stamped reply_to == trigger;
 *   2. our own decision observation (replied|no-reply) with trigger_step == trigger;
 *   3. a FRESH reply_claim (ts > cutoff) with trigger_step == trigger;
 *   4. any later message from us to them with reply_to empty or == trigger.
 * A STALE bare claim deliberately does not count.
 */
export function responderAlreadyHandled(
  steps: Step[],
  me: string,
  them: string,
  trigger: string,
  cutoff: string
): boolean {
  let triggerIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    if (String((steps[i] as Record<string, unknown>)["step_id"] ?? "") === trigger) triggerIdx = i;
  }
  for (let i = 0; i < steps.length; i++) {
    const r = steps[i] as Record<string, unknown>;
    const t = String(r["type"] ?? "");
    if (t === "message" && r["from"] === me && String(r["reply_to"] ?? "") === trigger) return true;
    if (
      t === "observation" &&
      String(r["trigger_step"] ?? "") === trigger &&
      (String(r["decision"] ?? "") === "replied" || String(r["decision"] ?? "") === "no-reply")
    ) {
      return true;
    }
    if (
      t === "reply_claim" &&
      String(r["trigger_step"] ?? "") === trigger &&
      cutoff !== "" &&
      String(r["ts"] ?? "") > cutoff
    ) {
      return true;
    }
    // layer 4: a later message from us to them, unstamped or stamped to trigger.
    if (
      triggerIdx >= 0 &&
      i > triggerIdx &&
      t === "message" &&
      r["from"] === me &&
      r["to"] === them &&
      (String(r["reply_to"] ?? "") === "" || String(r["reply_to"] ?? "") === trigger)
    ) {
      return true;
    }
  }
  return false;
}

/** Answered-guard: a reply from us already stamped to this trigger (bin/chat:76-90). */
function hasStampedReply(steps: Step[], me: string, trigger: string): boolean {
  if (!trigger) return false;
  for (const s of steps) {
    const r = s as Record<string, unknown>;
    if (r["type"] === "message" && r["from"] === me && String(r["reply_to"] ?? "") === trigger) {
      return true;
    }
  }
  return false;
}

/** step:156 — the model's FIRST line, whitespace-trimmed (head -n 1 | sed). */
function firstLineTrimmed(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.replace(/^\s+/, "").replace(/\s+$/, "");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function logPrompt(identityDir: string, triggerStepId: string, system: string, convo: ChatMessage[]): void {
  try {
    const dir = path.join(identityDir, "run", "logs", "responder-prompts");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const file = path.join(dir, `${stamp}_${triggerStepId || "notrigger"}.txt`);
    fs.writeFileSync(file, `# system\n${system}\n\n# messages\n${JSON.stringify(convo)}\n`);
  } catch {
    /* best-effort debug aid — never block the reply */
  }
}

// ---------------------------------------------------------------------------
// Person notes (design/conversation_memory.md, part 4).
// ---------------------------------------------------------------------------

export interface UpdatePersonNotesOptions {
  trajFile: string;
  idxFile: string;
  llm: LlmClient;
  memDir: string | undefined;
  identityName: string;
  personKey: string;
  msgFrom: string;
  now: () => number;
  /** The env whose credential values `redactKeys` masks (default process.env). */
  env?: Record<string, string | undefined>;
}

export function notesSystemPrompt(identityName: string, msgFrom: string): string {
  return `You maintain ${identityName}'s private notes about one person they talk with,
${msgFrom}. Rewrite the notes from the previous notes plus the recent
conversation. Include only: who they are (name, role, how they reach
${identityName}), how they prefer to be talked to, ongoing threads and open
commitments with dates, and facts they stated. Rules: facts and stated
preferences only. Never turn one incident into a rule, a stance, or a policy
about the person, and do not record refusals or things ${identityName} declined,
not even in neutral words: leave any declined request out entirely.
No secrets, keys, or credentials. Keep what is still true from the previous
notes and drop what the conversation shows is stale. At most 12 short lines of
plain text, no headers, no bullet syntax. Output only the notes.`;
}

/**
 * After a reply is sent, rewrite this person's notes from the previous notes
 * plus the last 30 days of conversation. Best-effort throughout: any failure
 * (no history, empty model output) leaves the notes file untouched.
 *
 * PORT-NOTE (deviation): upstream runs this on a cheap model
 * (RESPONDER_NOTES_MODEL, falling back to RECAP_MAP_MODEL then the reply
 * model) in a background subshell. The port's LlmClient interface has no
 * per-call model parameter — a client's model is fixed at construction — so
 * this reuses the SAME `llm` client the reply used (in-process, when
 * `personNotesSync`/RESPONDER_PERSON_NOTES_SYNC=1) or the same construction
 * rebuilt via `buildLlmClient` (in the detached child,
 * bin/responder-notes.mjs, otherwise — see `spawnPersonNotesWriter`).
 *
 * This function itself is called from TWO places and must stay agnostic to
 * which: runResponder, in-process, when SYNC=1; and bin/responder-notes.mjs,
 * a genuinely separate OS process, otherwise. That second path exists
 * because an in-process fire-and-forget promise here does NOT survive
 * bin/thinker-step.mjs's `process.exit()` the instant runResponder resolves
 * — the async wake's notes LLM call was silently killed every time before
 * this fix (see `spawnPersonNotesWriter`'s header).
 */
/**
 * `_update_person_notes`'s dedup lock (thinkers/responder/step:343-350, bug
 * #36) — a SINGLE lockdir per MEM_DIR (there is no `$key`/person in the Bash
 * lockdir path: `local lockdir="${MEM_DIR:-/tmp}/.person-notes.lock"`), so
 * this serializes ALL person-notes writes for one identity, not just the
 * same person's. `mkdir "$lockdir" 2>/dev/null || return 0`: atomic
 * acquire-or-silently-give-up, with NO staleness check anywhere in the Bash
 * — a lock left behind by a crashed writer blocks every future notes update
 * for this identity until removed by hand. Ported faithfully: no steal, no
 * expiry, no retry. Released on every exit path (`trap "rmdir '$lockdir'
 * 2>/dev/null" EXIT`) via try/finally here, matching the trap's own
 * `2>/dev/null` (a failed rmdir is swallowed, never surfaced).
 */
export async function updatePersonNotes(opts: UpdatePersonNotesOptions): Promise<void> {
  // step:345 `mkdir -p "${MEM_DIR:-/tmp}" 2>/dev/null || return 0`.
  const memBase = opts.memDir || "/tmp";
  try {
    fs.mkdirSync(memBase, { recursive: true });
  } catch {
    return;
  }
  // step:347 `mkdir "$lockdir" 2>/dev/null || return 0`.
  const lockDir = path.join(memBase, ".person-notes.lock");
  try {
    fs.mkdirSync(lockDir);
  } catch {
    return; // another writer holds the lock (or it's stale — never broken here)
  }
  try {
    await updatePersonNotesLocked(opts);
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* best-effort, matching the Bash trap's `2>/dev/null` */
    }
  }
}

async function updatePersonNotesLocked(opts: UpdatePersonNotesOptions): Promise<void> {
  // CHECK #29 (bin/chat:385 `_index_update` inside cmd_history): upstream's
  // `_update_person_notes` (thinkers/responder/step:350) reads history via a
  // FRESH `chat history --with` invocation — its own `_index_update` call,
  // AFTER the reply this wake just sent (step:457) was already appended to
  // the trajectory. The caller here (runResponder, or bin/responder-notes.mjs
  // for the async path) built `opts.idxFile` at wake START, BEFORE that
  // reply existed; without re-indexing here, the notes prompt would always
  // miss the very message that triggered it — the "messages.jsonl lagged one
  // message behind" symptom. Re-index unconditionally, matching upstream's
  // unconditional `_index_update` call on every `chat history` invocation.
  indexUpdate(opts.trajFile, opts.idxFile);
  const hist = queryHistory(opts.idxFile, {
    me: opts.identityName,
    keys: personAliases(opts.memDir, opts.personKey),
    threadKey: "",
    sinceSeconds: NOTES_SINCE_S,
    n: NOTES_MAX,
    now: opts.now,
  });
  if (hist.length === 0) return;

  const prevFile = findPersonMemoryFile(opts.memDir, opts.personKey);
  const prevBody = prevFile ? notesBody(prevFile.content) : "";

  const system = notesSystemPrompt(opts.identityName, opts.msgFrom);
  const lines = hist
    .map((m) => `${(m.ts ?? "?").slice(0, 16)} ${m.from === opts.identityName ? opts.identityName : "them"}: ${clip(m.content, 600)}`)
    .join("\n");
  const nowIso = new Date(opts.now()).toISOString().slice(0, 16) + "Z";
  const user =
    `Previous notes:\n${prevBody || "(none yet)"}\n\n` +
    `Recent conversation (UTC, oldest first; "them" is ${opts.msgFrom}):\n${lines}\n\n` +
    `Now: ${nowIso}. Output the rewritten notes.`;

  let resp;
  try {
    resp = await opts.llm.complete(system, [{ role: "user", content: user }]);
  } catch {
    return;
  }
  const newBody = personNotesBody(resp.text, opts.env ?? process.env);
  if (newBody === "") return;

  const memDir = opts.memDir;
  if (!memDir) return;
  writePersonNoteFile(memDir, opts.personKey, opts.msgFrom, newBody, opts.now(), prevFile);
}

/**
 * Write one person's notes memory in the responder's own format (the tail of
 * `_update_person_notes`, thinkers/responder/step): rewrite `prevFile` in place
 * (id, created and aliases kept, `updated` set) or create
 * `<stamp>_<hex8>_person-<key>.md`. Shared by updatePersonNotesLocked and
 * src/api.ts writePersonNote. No lock here: callers hold or skip it.
 */
export function writePersonNoteFile(
  memDir: string,
  personKey: string,
  msgFrom: string,
  newBody: string,
  nowMs: number,
  prevFile: PersonMemoryFile | undefined = findPersonMemoryFile(memDir, personKey),
): void {
  fs.mkdirSync(memDir, { recursive: true });

  const summary = `Notes on ${msgFrom}: ${clip(newBody.split("\n")[0] ?? "", 60)}`;
  const nowHuman = humanTimestamp(new Date(nowMs));

  if (prevFile) {
    const fm = frontmatterFields(prevFile.content);
    const aliases = fm.aliases;
    const aliasesLine = `aliases: [${aliases.join(", ")}]`;
    const out =
      `---\n` +
      (fm.id ? `id: ${fm.id}\n` : "") +
      `summary: ${summary}\ntype: person\nperson_key: ${personKey}\n${aliasesLine}\n` +
      `created: ${fm.created || nowHuman}\nupdated: ${nowHuman}\n---\n\n${newBody}\n`;
    fs.writeFileSync(prevFile.path, out);
  } else {
    const hex = crypto.randomBytes(4).toString("hex");
    const slug = slugify(`person-${personKey}`);
    const stamp = fileStamp(new Date(nowMs));
    const out =
      `---\nid: ${hex}\nsummary: ${summary}\ntype: person\nperson_key: ${personKey}\naliases: []\n` +
      `created: ${nowHuman}\n---\n\n${newBody}\n`;
    fs.writeFileSync(path.join(memDir, `${stamp}_${hex}_${slug}.md`), out);
  }
}

function frontmatterFields(content: string): { id: string; created: string; aliases: string[] } {
  const idMatch = /^id:[ \t]*(.*)$/m.exec(content);
  const createdMatch = /^created:[ \t]*(.*)$/m.exec(content);
  const bracket = /^aliases:[ \t]*\[(.*)\]/m.exec(content);
  let aliases: string[] = [];
  if (bracket) {
    const inner = bracket[1]!.trim();
    aliases = inner === "" ? [] : inner.split(",").map((s) => s.trim());
  }
  return { id: idMatch?.[1]?.trim() ?? "", created: createdMatch?.[1]?.trim() ?? "", aliases };
}

function humanTimestamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function fileStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}
