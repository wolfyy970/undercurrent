// parity/replay/lib.mjs — pure functions for the L2 deterministic replay
// harness (PROOF-CAMPAIGN.md). NOTHING here touches fs/net/process — every
// input is a plain string/object/array so test/replay.test.ts can exercise
// it with two small hand-made tapes/trajectories, no subprocess, no HTTP,
// no real model call. record.mjs/proxy.mjs/run-replay.mjs are the only
// impure halves (spawn/listen/read/write).
//
// ---------------------------------------------------------------------------
// LANE CLASSIFICATION — the replay proxy's matching key
// ---------------------------------------------------------------------------
//
// Both the upstream Bash engine and the TS port make exactly three kinds of
// real (non-tool) LLM call, and each kind's SYSTEM message carries a fixed,
// content-based marker that is IDENTICAL on both sides (verified against
// src/prompts.ts + src/responder.ts on the port, and
// thinkers/monolith/step + thinkers/responder/step on upstream):
//
//   monolith         — system starts with the verbatim shellm contract head
//                       "You are running in shellm, headlong's bash agent
//                       loop:" (src/assets/shellm-system-prompt.txt; upstream
//                       bin/shellm:1552). PORT-NOTE (1c: 37f9340) — this
//                       marker text changed on BOTH sides in the same
//                       upstream commit ("You are shellm, an AI assistant
//                       operating inside a bash shell environment." was the
//                       pre-37f9340 wording); a tape recorded against an
//                       older checkout would need re-recording, not a dual
//                       marker — out of scope for this lane's own fix.
//   responder-reply  — system contains "You are in a live chat conversation
//                       with" (src/responder.ts buildReplySystem; upstream
//                       thinkers/responder/step:294).
//   responder-notes  — system contains "private notes about one person they
//                       talk with" (src/responder.ts notesSystemPrompt;
//                       upstream thinkers/responder/step:329).
//
// This is a MATCHING KEY, not a request-shape comparison: the two engines'
// request bodies otherwise differ (streaming vs not, `reasoning` vs
// `--thinking`, etc — see src/llm.ts's own doc comment on OpenRouterClient)
// by design; L2 does not evaluate that. Any request whose system text hits
// none of the three markers buckets into `other:<hash8>` — a stable but
// unnamed lane (e.g. `mem search`'s corpus-in-a-prompt use of `llm`,
// design/providers.md adapters, or a lane this file's author missed) so
// unrelated "other" call kinds never collide into one sequence. Every lane
// is matched POSITIONALLY: request N in a lane gets tape entry N in that
// lane, regardless of which side is asking — see nextTapeEntry.
//
// KNOWN LIMITATION (report honestly, don't paper over): a system prompt
// that doesn't hit a named marker AND happens to collide on its 8-hex-char
// hash with a different unnamed lane would misattribute — astronomically
// unlikely at this run's request volume (tens, not billions, of calls) and
// not worth a bigger hash for a locally-scoped harness key.

import * as crypto from "node:crypto";

export const LANE_MARKERS = {
  monolith: (sys) => sys.startsWith("You are running in shellm, headlong's bash agent loop:"),
  "responder-reply": (sys) => sys.includes("You are in a live chat conversation with"),
  "responder-notes": (sys) => sys.includes("private notes about one person they talk with"),
};

/** First `role:"system"` message's content out of an OpenAI-shaped chat payload, or "". */
export function extractSystemText(payload) {
  if (!payload || !Array.isArray(payload.messages)) return "";
  const sysMsg = payload.messages.find((m) => m && m.role === "system");
  return typeof sysMsg?.content === "string" ? sysMsg.content : "";
}

function shortHash(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

/** The lane a request belongs to — see the file header for the three named lanes + the `other:<hash8>` fallback. */
export function classifyRequest(payload) {
  const sys = extractSystemText(payload);
  for (const [lane, test] of Object.entries(LANE_MARKERS)) {
    if (test(sys)) return lane;
  }
  return `other:${shortHash(sys)}`;
}

/** Whether an incoming request wants a streamed (SSE) response — `stream:true` on the JSON body (OpenAI wire convention; the port's OpenRouterClient never sets it, upstream's bin/llm sets it by default). */
export function requestWantsStream(payload) {
  return payload?.stream === true;
}

// ---------------------------------------------------------------------------
// TAPE — JSONL, one entry per recorded (request, response) pair, in the
// order record.mjs observed them. Each entry:
//   { lane, seq, ts, model, requestStream, responseText, reasoningText,
//     finishReason, usage: {promptTokens, completionTokens, reasoningTokens} }
// `seq` is 0-based, per-lane, assigned at recording time (recording order).
// ---------------------------------------------------------------------------

export function parseTapeJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

/** `{lane: [entry, ...]}` sorted by `seq`. Entries missing `seq` keep recording order within their lane. */
export function groupTapeByLane(entries) {
  const byLane = new Map();
  for (const e of entries) {
    if (!byLane.has(e.lane)) byLane.set(e.lane, []);
    byLane.get(e.lane).push(e);
  }
  for (const arr of byLane.values()) arr.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return byLane;
}

/**
 * Advance one side's cursor for `lane` and return the tape entry to serve.
 * `cursors` is a plain `Map<lane, number>` the caller owns and mutates across
 * calls (one Map per replay-proxy instance = one Map per side, since each
 * side gets its OWN proxy process replaying the SAME tape from position 0 —
 * see run-replay.mjs's two-proxy-instances design note). Pure: given the
 * same tapeByLane + cursors + lane, always returns the same result and the
 * same cursor mutation.
 */
export function nextTapeEntry(tapeByLane, cursors, lane) {
  const arr = tapeByLane.get(lane) ?? [];
  const i = cursors.get(lane) ?? 0;
  cursors.set(lane, i + 1);
  if (i >= arr.length) return { hit: false, index: i, laneSize: arr.length, entry: null };
  return { hit: true, index: i, laneSize: arr.length, entry: arr[i] };
}

// ---------------------------------------------------------------------------
// CANNED IDLE-CLASS RESPONSE — served on a tape miss (lane exhausted, or a
// lane never seen during recording). `:` is bash's no-op builtin: valid for
// monolith's shellm-loop contract (executes cleanly, produces no durable
// step -> recorded as an `idle` step, src/monolith.ts:255-263) and harmless
// as a literal chat-reply/notes-body string for the other two lanes (a
// miss there is logged and shows up as an obviously-synthetic reply, never
// silently blended with a real one).
// ---------------------------------------------------------------------------

export const CANNED_IDLE_TEXT = "```bash\n: # replay-proxy: tape miss (idle)\n```";

// ---------------------------------------------------------------------------
// Wire-format rendering — the tape stores provider-agnostic text; the proxy
// renders it into whatever shape the ASKING request wants (JSON vs SSE),
// independent of which shape the tape entry was originally recorded in.
// ---------------------------------------------------------------------------

/** @param {{text: string, reasoningText?: string|null, finishReason?: string|null, usage?: {promptTokens?: number, completionTokens?: number, reasoningTokens?: number}|null}} p */
export function buildOpenAIJsonResponse({ text, reasoningText, finishReason, usage }) {
  const message = { role: "assistant", content: text, ...(reasoningText ? { reasoning: reasoningText } : {}) };
  const body = {
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens ?? 0,
            completion_tokens: usage.completionTokens ?? 0,
            ...(usage.reasoningTokens
              ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
              : {}),
          },
        }
      : {}),
  };
  return body;
}

/** One content-delta chunk (+ optional usage chunk) + `[DONE]` — the minimal shape test/llmFakeServer.ts's `R.sseOk`/`R.sseOkUsage` use, which both engines' SSE parsers already handle. */
/** @param {{text: string, finishReason?: string|null, usage?: {promptTokens?: number, completionTokens?: number, reasoningTokens?: number}|null}} p */
export function buildOpenAISseBody({ text, finishReason, usage }) {
  let out = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
  out += `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || "stop" }] })}\n\n`;
  if (usage) {
    out += `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: usage.promptTokens ?? 0,
        completion_tokens: usage.completionTokens ?? 0,
        ...(usage.reasoningTokens
          ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
          : {}),
      },
    })}\n\n`;
  }
  out += "data: [DONE]\n";
  return out;
}

/** Render a tape entry (or the canned miss) into the wire body the request asked for. */
export function renderReplyBody(payload, tapeEntryOrNull) {
  const stream = requestWantsStream(payload);
  const src = tapeEntryOrNull ?? {
    responseText: CANNED_IDLE_TEXT,
    reasoningText: null,
    finishReason: "stop",
    usage: null,
  };
  const args = {
    text: src.responseText ?? "",
    reasoningText: src.reasoningText ?? null,
    finishReason: src.finishReason ?? "stop",
    usage: src.usage ?? null,
  };
  return stream ? buildOpenAISseBody(args) : JSON.stringify(buildOpenAIJsonResponse(args));
}

// ---------------------------------------------------------------------------
// RESPONSE PARSING — the inverse of buildOpenAIJsonResponse/buildOpenAISseBody,
// used by record.mjs to turn a REAL provider response (tapped while it's
// relayed byte-for-byte to the real client) into the provider-agnostic shape
// the tape stores. Best-effort: an unparseable body yields nulls rather than
// throwing — a single bad tap must not crash a 10-minute recording.
// ---------------------------------------------------------------------------

/**
 * @typedef {{text: string, reasoningText: string|null, finishReason: string|null, usage: {promptTokens?: number, completionTokens?: number, reasoningTokens?: number}|null}} ParsedResponse
 * @returns {ParsedResponse|null}
 */
export function parseOpenAIJsonResponse(bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const usage = json.usage
    ? {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens,
      }
    : null;
  return {
    text: choice.message?.content ?? "",
    reasoningText: choice.message?.reasoning ?? null,
    finishReason: choice.finish_reason ?? null,
    usage,
  };
}

/** @returns {ParsedResponse} */
export function parseOpenAISseResponse(bodyText) {
  let text = "";
  let reasoningText = "";
  let finishReason = null;
  let usage = null;
  for (const block of bodyText.split("\n\n")) {
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]" || payload === "") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = evt.choices?.[0];
      if (choice?.delta?.content) text += choice.delta.content;
      if (choice?.delta?.reasoning) reasoningText += choice.delta.reasoning;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (evt.usage) {
        usage = {
          promptTokens: evt.usage.prompt_tokens,
          completionTokens: evt.usage.completion_tokens,
          reasoningTokens: evt.usage.completion_tokens_details?.reasoning_tokens,
        };
      }
    }
  }
  return { text, reasoningText: reasoningText || null, finishReason, usage };
}

/** `isSse`: Content-Type of the real response started with `text/event-stream` (record.mjs's own check). @returns {ParsedResponse|null} */
export function parseUpstreamResponse(bodyText, { isSse }) {
  return isSse ? parseOpenAISseResponse(bodyText) : parseOpenAIJsonResponse(bodyText);
}

// ---------------------------------------------------------------------------
// ENVIRONMENT-LEAK DETECTION — a side's llm/shellm call silently bypassing
// the replay/recording proxy and hitting a real provider directly. This is
// exactly how the harness's own "monolith: 0 wakes" bug hid for a whole
// real run: bin/shellm unsets any inherited LLM_API_URL and only re-exports
// it from SHELLM_API_URL (bin/shellm:73-77) — a harness that sets only
// LLM_API_URL silently sends monolith's real calls to the real provider
// with whatever key happens to be in scope, which then dies with an auth
// error on the first real iteration. The run still "completes" (an error
// step is a normal trajectory outcome), the report still renders — nothing
// about that failure mode surfaces on its own. run-replay.mjs must run
// this against every side's monolith.log/responder.log/responder-notes.log
// after capture and treat any hit as a hard run failure, not a divergence
// to classify.
// ---------------------------------------------------------------------------

const AUTH_ERROR_RE =
  /Missing Authentication header|No auth credentials found|401 Unauthorized|invalid[- ]api[- ]key|did not get a reply from|LLM check failed/i;

/** Real provider hosts that must NEVER appear in a proxied side's logs — any hit means a call bypassed the proxy. */
export const KNOWN_PROVIDER_HOSTS = [
  "openrouter.ai",
  "api.anthropic.com",
  "api.openai.com",
  "opencode.ai",
  "generativelanguage.googleapis.com",
];

/** `[{lineNumber, reason: "auth-error"|"non-proxy-host", host?, line}]` — empty when the log is clean. Pure text scan, no network/fs. */
export function findEnvironmentLeaks(logText) {
  const leaks = [];
  const lines = (logText ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (AUTH_ERROR_RE.test(line)) leaks.push({ lineNumber: i + 1, reason: "auth-error", line: line.trim() });
    for (const host of KNOWN_PROVIDER_HOSTS) {
      if (line.includes(host)) leaks.push({ lineNumber: i + 1, reason: "non-proxy-host", host, line: line.trim() });
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// SECRET SCRUBBING — record.mjs writes NO header/env VALUE to the tape.
// ---------------------------------------------------------------------------

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|x-goog-api-key|cookie|proxy-authorization)$/i;

/** `{header: "<redacted>"|value}` — used by record.mjs before it writes a request's headers anywhere. */
/** @param {Record<string, string>} [headers] @returns {Record<string, string>} */
export function scrubHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? "<redacted>" : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TRAJECTORY ALIGNMENT — comparing the two sides' trajectory.jsonl files
// step by step once both were driven by the SAME tape. Timestamps and ids
// (step_id, run_id, trigger_step, thinking file paths, trajectory ids) are
// excluded per DELIVERABLE; run_id/trigger_step are instead remapped to a
// per-side RELATIVE run index so causal grouping ("this step belongs to run
// #3, which was triggered by run #2's step") stays comparable even though
// the literal ids never match across two independently-generated runs.
// ---------------------------------------------------------------------------

const ID_LIKE_FIELDS = new Set(["ts", "id", "step_id", "run_id", "trigger_step", "traj_id"]);

/**
 * Fields that hold a REFERENCE to some other step's own id — remapped via
 * `idMap`, same as `run_id`/`trigger_step`. `reply_to` (a `message` step
 * pointing at the message it answers) is the other one that showed up in
 * the first real run this harness did: every `reply_to`/`trigger_step`
 * pointing at a non-`shellm-run` step (a `message`, almost always) was
 * being left as its RAW random UUID, so two otherwise-identical
 * `reply_claim`/`action`/reply `message` steps on the two sides always
 * looked different — and cascaded into spurious "orig-only"/"port-only"
 * alignment entries and false `reply_to`-differs field diffs. Confirmed by
 * hand against the first real replay run: every one of that run's 5
 * "PORT-BUG candidate" entries were this, not a real divergence.
 */
const ID_REF_FIELDS = new Set(["run_id", "trigger_step", "reply_to"]);

/**
 * Build `id -> "<type>#N"` for EVERY step's own id (`step_id`), N counted
 * PER STEP TYPE (the Nth `message`, the Nth `shellm-run`, ...) rather than
 * over-all file position. Per-type, not absolute, on purpose: a run with a
 * volume divergence in one step type (e.g. the port waking `shellm-run`
 * hundreds of times more than orig in the same window — a real thing this
 * harness caught) must not shift the position-derived label of every
 * `message` that comes after it, or a trigger_step/reply_to pointing at
 * "the 2nd message" would resolve to two DIFFERENT labels on the two sides
 * for a reason that has nothing to do with the reference itself.
 */
function stepIndexMap(steps) {
  const map = new Map();
  const counters = new Map();
  for (const s of steps) {
    const t = s.type ?? "";
    const n = (counters.get(t) ?? 0) + 1;
    counters.set(t, n);
    if (typeof s.step_id === "string") map.set(s.step_id, `${t}#${n}`);
  }
  return map;
}

/**
 * One step -> a normalized, order-independent-of-ids plain object: every
 * field kept except the excluded id-like ones, with `run_id`/`trigger_step`/
 * `reply_to` (and the step's own `step_id`) rewritten to a relative
 * `step#N` label via `idMap` — so two causally-equivalent steps (e.g. both
 * sides' `reply_claim` for "the incoming message", both sides' reply
 * `message` answering it) compare equal even though the literal ids/UUIDs
 * never match across two independently-generated runs. A reference that
 * doesn't resolve in `idMap` (points outside this side's own trajectory —
 * rare) is left as a constant placeholder rather than its raw UUID, so it
 * never falsely LOOKS different from the other side's equally-unresolved
 * reference. Field PRESENCE is preserved (a field missing on one side vs
 * present-but-empty on the other is a real diff).
 */
/**
 * Recursively scrub timestamps/hex-ids/absolute scratch-app paths out of
 * every STRING leaf of `value` (same rules as `normalizeArtifactText`,
 * applied to trajectory step FIELD VALUES instead of a whole file's text).
 * A `shellm-run` step's own `command`/`workdir`/`env` legitimately embed
 * each side's own absolute scratch checkout path (`.../orig/app/...` vs
 * `.../port/app/...`) and a per-run trajectory UUID — those must never
 * read as a real divergence just because the two sides' scratch roots
 * differ, the same way an artifact-file diff already accounts for it.
 */
export function scrubValueDeep(value, opts) {
  if (typeof value === "string") return normalizeArtifactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => scrubValueDeep(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValueDeep(v, opts);
    return out;
  }
  return value;
}

export function normalizeStep(step, idMap, scrubOpts) {
  const out = {};
  for (const [k, v] of Object.entries(step)) {
    if (ID_REF_FIELDS.has(k)) {
      // null/undefined (no trigger, no reply-to) stays exactly that — only
      // an actual id string gets remapped-or-placeholdered.
      out[k] = v == null ? v : (idMap.get(v) ?? "<unresolved-ref>");
      continue;
    }
    if (k === "step_id") {
      out[k] = idMap.get(v) ?? v;
      continue;
    }
    if (ID_LIKE_FIELDS.has(k)) continue;
    out[k] = scrubOpts ? scrubValueDeep(v, scrubOpts) : v;
  }
  return out;
}

/**
 * @typedef {Record<string, any>} Step
 * @typedef {{field: string, orig: any, port: any}} FieldDiff
 * @typedef {{status: "matched", orig: Step, port: Step, fieldDiffs: FieldDiff[]} | {status: "orig-only", orig: Step, port?: undefined} | {status: "port-only", port: Step, orig?: undefined}} AlignmentEntry
 */

/** `scrubOpts` (optional): `{scrubPaths}` — this side's own absolute scratch-checkout path prefix(es), scrubbed out of every string field (see scrubValueDeep). @returns {Step[]} */
export function normalizeSteps(steps, scrubOpts) {
  const idMap = stepIndexMap(steps);
  return steps.map((s) => normalizeStep(s, idMap, scrubOpts));
}

/** A short signature used to align two step sequences: type/source/run_id — the shape a divergence in CONTROL FLOW (not prose) would break. */
function stepSignature(ns) {
  return [ns.type ?? "", ns.source ?? "", ns.run_id ?? "", ns.trigger_step ?? ""].join("");
}

/**
 * Field-by-field diff between two normalized steps that share a signature
 * (or are being compared anyway for context). Returns `[{field, orig, port}]`
 * for every field that differs (present-on-one-side counts as a diff too).
 */
/** @returns {FieldDiff[]} */
export function diffStepFields(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    const aHas = Object.prototype.hasOwnProperty.call(a, k);
    const bHas = Object.prototype.hasOwnProperty.call(b, k);
    if (aHas !== bHas || JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push({ field: k, orig: aHas ? av : undefined, port: bHas ? bv : undefined });
    }
  }
  return diffs;
}

/**
 * Myers-style LCS alignment of two normalized step sequences by signature
 * (`stepSignature`), producing an ordered list of:
 *   {status:"matched", orig, port, fieldDiffs}
 *   {status:"orig-only", orig}
 *   {status:"port-only", port}
 * O(n*m) DP — fine at the step counts a 10-minute run produces (tens to a
 * few hundred per side); not meant for huge sequences.
 */
/** @returns {AlignmentEntry[]} */
export function alignSteps(origStepsRaw, portStepsRaw, opts = {}) {
  const orig = normalizeSteps(origStepsRaw, opts.origScrubPaths ? { scrubPaths: opts.origScrubPaths } : null);
  const port = normalizeSteps(portStepsRaw, opts.portScrubPaths ? { scrubPaths: opts.portScrubPaths } : null);
  const n = orig.length;
  const m = port.length;
  const sigA = orig.map(stepSignature);
  const sigB = port.map(stepSignature);

  // dp[i][j] = length of the LCS of sigA[i:] and sigB[j:]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        sigA[i] === sigB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sigA[i] === sigB[j]) {
      out.push({
        status: "matched",
        orig: orig[i],
        port: port[j],
        fieldDiffs: diffStepFields(orig[i], port[j]),
      });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ status: "orig-only", orig: orig[i] });
      i += 1;
    } else {
      out.push({ status: "port-only", port: port[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ status: "orig-only", orig: orig[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ status: "port-only", port: port[j] });
    j += 1;
  }
  return out;
}

/** Summary counters + first divergence (with a few steps of context) over an alignment. */
export function summarizeAlignment(alignment) {
  let matchedExact = 0;
  let matchedWithFieldDiffs = 0;
  let origOnly = 0;
  let portOnly = 0;
  let firstDivergenceIndex = -1;
  for (let idx = 0; idx < alignment.length; idx++) {
    const e = alignment[idx];
    if (e.status === "matched") {
      if (e.fieldDiffs.length === 0) matchedExact += 1;
      else {
        matchedWithFieldDiffs += 1;
        if (firstDivergenceIndex === -1) firstDivergenceIndex = idx;
      }
    } else if (e.status === "orig-only") {
      origOnly += 1;
      if (firstDivergenceIndex === -1) firstDivergenceIndex = idx;
    } else {
      portOnly += 1;
      if (firstDivergenceIndex === -1) firstDivergenceIndex = idx;
    }
  }
  const total = alignment.length;
  const alignedSteps = matchedExact + matchedWithFieldDiffs;
  const contextStart = firstDivergenceIndex === -1 ? -1 : Math.max(0, firstDivergenceIndex - 2);
  const contextEnd = firstDivergenceIndex === -1 ? -1 : Math.min(total, firstDivergenceIndex + 3);
  return {
    total,
    alignedSteps,
    matchedExact,
    matchedWithFieldDiffs,
    origOnly,
    portOnly,
    firstDivergenceIndex,
    firstDivergenceContext:
      firstDivergenceIndex === -1 ? [] : alignment.slice(contextStart, contextEnd),
  };
}

// ---------------------------------------------------------------------------
// ARTIFACT (run/ files, memories/, dispatcher.log) NORMALIZED DIFF —
// timestamps/ids/absolute-scratch-paths scrubbed SYMMETRICALLY on both
// sides (same technique parity/llm/run-parity.mjs's header describes for
// its own nondeterminism normalization), so a diff reflects real content
// divergence, not "the two scratch checkouts live at different paths".
// ---------------------------------------------------------------------------

const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const HEX_ID_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{16,40}\b/g;

/** `scrubPaths`: array of absolute path prefixes to replace with a stable placeholder (e.g. each side's own scratch app dir). */
/** @param {string} text @param {{scrubPaths?: string[]}} [opts] */
export function normalizeArtifactText(text, { scrubPaths = [] } = {}) {
  let out = text.replace(ISO_TS_RE, "<TS>").replace(HEX_ID_RE, "<ID>");
  for (const p of scrubPaths) {
    if (!p) continue;
    out = out.split(p).join("<APP>");
  }
  return out;
}

/** First differing line (1-based) between two normalized texts, or null if equal. Not a full diff — just enough to point a human at the divergence. */
export function compareNormalizedTexts(a, b) {
  if (a === b) return { equal: true };
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return { equal: false, lineNumber: i + 1, orig: la[i] ?? "<EOF>", port: lb[i] ?? "<EOF>" };
    }
  }
  return { equal: true };
}

// ---------------------------------------------------------------------------
// DIVERGENCE CLASSIFICATION — one bucket per alignment entry that isn't a
// clean match, per PROOF-CAMPAIGN.md's contract (harness reports+classifies,
// never fixes the port). `docLookup(code)` lets the caller (run-replay.mjs)
// supply PARITY.md citations for known documented deviations; anything not
// found there is left for a human/PORT-BUG triage, not auto-decided here.
// ---------------------------------------------------------------------------

const TIMING_ORDER_FIELDS = new Set(["reasoning", "content", "cmd"]); // prose-shaped fields alone never imply a port bug

/**
 * @typedef {{file: string, line: number, excerpt: string}} DocCitation
 * @typedef {(key: string) => DocCitation|null} DocLookup
 * @param {AlignmentEntry} entry
 * @param {{docLookup?: DocLookup}} [opts]
 * @returns {{bucket: string, detail?: string, citation?: DocCitation}}
 */
export function classifyDivergence(entry, opts = {}) {
  const docLookup = opts.docLookup ?? (() => null);
  if (entry.status === "orig-only" || entry.status === "port-only") {
    const side = entry.status === "orig-only" ? "orig" : "port";
    const step = entry.orig ?? entry.port;
    const doc = docLookup(`missing:${step.type}`);
    if (doc) return { bucket: "documented-deviation", citation: doc };
    return { bucket: "PORT-BUG candidate", detail: `step type "${step.type}" present only on ${side}` };
  }
  // matched but with field diffs
  const nonProseFields = entry.fieldDiffs.filter((d) => !TIMING_ORDER_FIELDS.has(d.field));
  if (nonProseFields.length === 0) {
    return { bucket: "model nondeterminism", detail: "only prose/content fields differ" };
  }
  for (const d of nonProseFields) {
    const doc = docLookup(`field:${entry.orig.type}.${d.field}`);
    if (doc) return { bucket: "documented-deviation", citation: doc };
  }
  return {
    bucket: "PORT-BUG candidate",
    detail: `field(s) differ on a "${entry.orig.type}" step: ${nonProseFields.map((d) => d.field).join(", ")}`,
  };
}

/**
 * Classify every non-clean entry in an alignment (clean = matched with zero
 * field diffs — not a divergence, skipped). Adds a 4th bucket beyond
 * classifyDivergence's three: an orig-only/port-only entry immediately
 * adjacent (either side) to an entry of the OPPOSITE one-sidedness but the
 * SAME step `type` most plausibly reflects the two engines doing the same
 * work in a different order (a scheduling/timing race — e.g. which of two
 * ready wakes ran first) rather than one side missing a capability, so it's
 * "timing-order difference" rather than a PORT-BUG candidate. This is a
 * heuristic, stated as such — a human should still spot-check it, same as
 * classifyDivergence's own docLookup-based "documented-deviation" calls.
 */
/**
 * @param {AlignmentEntry[]} alignment
 * @param {{docLookup?: DocLookup}} [opts]
 * @returns {Array<{index: number, bucket: string, detail?: string, citation?: DocCitation}>}
 */
export function classifyAlignment(alignment, opts = {}) {
  const docLookup = opts.docLookup ?? (() => null);
  const out = [];
  for (let idx = 0; idx < alignment.length; idx++) {
    const entry = alignment[idx];
    if (entry.status === "matched" && entry.fieldDiffs.length === 0) continue; // clean match

    if (entry.status === "orig-only" || entry.status === "port-only") {
      const myType = (entry.orig ?? entry.port).type;
      const otherStatus = entry.status === "orig-only" ? "port-only" : "orig-only";
      const neighbors = [alignment[idx - 1], alignment[idx + 1]].filter(Boolean);
      const timingMatch = neighbors.find((n) => n.status === otherStatus && (n.orig ?? n.port).type === myType);
      if (timingMatch) {
        out.push({
          index: idx,
          bucket: "timing-order difference",
          detail: `step type "${myType}" appears on both sides but not 1:1 at this position (adjacent ${entry.status}/${otherStatus} pair, same type)`,
        });
        continue;
      }
    }
    out.push({ index: idx, ...classifyDivergence(entry, { docLookup }) });
  }
  return out;
}
