// llmProvider.ts — the OpenAI-family provider layer shared by the `llm` CLI
// (src/llmCli.ts, the port of headlong/bin/llm) and the in-process engine
// client (src/llm.ts OpenRouterClient). Pure functions over parsed JSON; no
// I/O, no process state — every rule here is lifted from bin/llm and kept in
// its Bash shape (glob tables, jq-path semantics) so the two can be diffed.
//
// Loaded from source by Node's native type stripping (bin/llm.mjs → llmCli.ts
// → this file): keep it strip-safe — no enums, namespaces, or parameter
// properties, and `import type` for anything that is only a type.

// ---------------------------------------------------------------------------
// Bash `case` glob matching — the model tables are copied VERBATIM from bin/llm
// as `a|b|c` pattern lists, so keep the matcher faithful to bash globbing:
// `*` any run (newlines included), `?` one char, `[…]` a class, `[!…]` negated.
// ---------------------------------------------------------------------------

export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = pattern.indexOf("]", i + 2);
      if (j < 0) {
        re += "\\[";
        continue;
      }
      let cls = pattern.slice(i + 1, j);
      if (cls.startsWith("!") || cls.startsWith("^")) cls = "^" + cls.slice(1);
      re += "[" + cls.replace(/\\/g, "\\\\") + "]";
      i = j;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re + "$", "s");
}

/** `case "$s" in a|b|c)` — true when any `|`-separated glob matches all of `s`. */
export function caseMatch(s: string, patterns: string): boolean {
  return patterns.split("|").some((p) => globToRegExp(p).test(s));
}

// ---------------------------------------------------------------------------
// Provider detection (bin/llm detect_provider) — order is load-bearing.
// ---------------------------------------------------------------------------

export const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "opencode",
  "opencode-go",
  "openai-compatible",
  "adapter",
] as const;
export type Provider = (typeof KNOWN_PROVIDERS)[number];

/** Providers whose wire format is OpenAI chat/completions (slice 1 of the port). */
export const OPENAI_FAMILY: readonly string[] = ["openai", "openrouter", "opencode-go", "openai-compatible"];

/** Model-name → provider, or null when no pattern classifies the name. */
export function detectProvider(model: string): Provider | null {
  if (caseMatch(model, "claude-*")) return "anthropic";
  if (caseMatch(model, "gpt-*|o1*|o3*|o4*|chatgpt-*")) return "openai";
  if (caseMatch(model, "gemini-*")) return "gemini";
  if (caseMatch(model, "opencode-go/*")) return "opencode-go";
  if (caseMatch(model, "opencode/*")) return "opencode";
  if (caseMatch(model, "*/*")) return "openrouter";
  return null;
}

// ---------------------------------------------------------------------------
// Per-model max output token caps (bin/llm get_model_max_tokens) — VERBATIM.
// ---------------------------------------------------------------------------

/** OpenCode Go catalog tiers (scoped to provider opencode-go). */
export const OPENCODE_GO_MAX_TOKENS: readonly [string, number][] = [
  ["glm-*|kimi-*|qwen*|minimax-*|deepseek-*|grok-*|longcat-*|mimo-*|hy3*|muse-*|ox-alpha-*", 32768],
];
export const OPENCODE_GO_DEFAULT_MAX_TOKENS = 16384;

/** Every other provider: first matching row wins (bash `case` order). */
export const MAX_TOKENS_TABLE: readonly [string, number][] = [
  // Anthropic — Claude 4.x family
  ["claude-opus-4-7*|claude-opus-4-6*|claude-opus-4-5*|claude-opus-4-1*|claude-opus-4-0*", 128000],
  ["claude-sonnet-4-7*|claude-sonnet-4-6*", 128000],
  ["claude-sonnet-4-5*|claude-sonnet-4-0*", 64000],
  ["claude-haiku-4-5*|claude-haiku-4-0*", 64000],
  // Anthropic — Claude 3.x family (legacy)
  ["claude-3-5-sonnet*|claude-3-5-haiku*", 8192],
  ["claude-3-opus*|claude-3-sonnet*|claude-3-haiku*", 4096],
  // OpenAI — reasoning models
  ["o1*|o3*|o4*", 100000],
  // OpenAI — chat models
  ["gpt-5*", 128000],
  ["gpt-4o*", 16384],
  ["gpt-4-turbo*", 4096],
  ["gpt-4*", 8192],
  ["gpt-3.5*", 4096],
  // Google Gemini
  ["gemini-2.0-flash*", 8192],
  ["gemini-*", 65536],
  // OpenRouter (vendor-prefixed)
  ["anthropic/*", 64000],
  ["x-ai/grok-4*|x-ai/grok*", 64000],
  // PORT-NOTE (sync 2e39a3f, 51352f7, 7b528b3): Zhipu GLM 5.x and Xiaomi MiMo
  // are reasoning models whose thinking counts against max_tokens — 16384
  // returned empty answers / cut off mid-thought on live runs.
  ["z-ai/glm-5*", 64000],
  ["xiaomi/mimo*", 64000],
  ["*/*", 16384],
];

export function getModelMaxTokens(model: string, provider: string): number {
  if (provider === "opencode-go") {
    for (const [pat, n] of OPENCODE_GO_MAX_TOKENS) if (caseMatch(model, pat)) return n;
    return OPENCODE_GO_DEFAULT_MAX_TOKENS;
  }
  for (const [pat, n] of MAX_TOKENS_TABLE) if (caseMatch(model, pat)) return n;
  // Unknown model: openai-compatible endpoints and adapters serve arbitrary
  // names the table cannot know; 4096 starves agentic steps there.
  return provider === "openai-compatible" || provider === "adapter" ? 16384 : 4096;
}

// ---------------------------------------------------------------------------
// OpenAI-family payload (bin/llm build_payload_openai)
// ---------------------------------------------------------------------------

/** GPT-5 and o-series require max_completion_tokens instead of max_tokens. */
export function usesMaxCompletionTokens(model: string): boolean {
  return caseMatch(model, "o1*|o3*|o4*|gpt-5*");
}

/** supports_openai_reasoning: reasoning.effort is only accepted by these families. */
export function supportsOpenAIReasoning(model: string, assumeThinking: boolean): boolean {
  if (assumeThinking) return true;
  return caseMatch(model, "gpt-[5-9]*|o[1-9]*");
}

export interface OpenAIPayloadOptions {
  model: string;
  /** The messages array (`-M` parsed, or `[{role:"user",content:prompt}]`). */
  messages: unknown;
  /** System prompt text; "" = none. */
  system: string;
  stream: boolean;
  maxTokens: number;
  /** `--thinking LEVEL`; "" when no explicit level was given (bare --thinking is a no-op here). */
  thinkingLevel: string;
  /** LLM_ASSUME_THINKING=1 bypasses the model-family guard. */
  assumeThinking: boolean;
  /** PORT-NOTE (sync 2e39a3f): `--json-schema FILE`'s parsed JSON Schema, or
   *  undefined. Wrapped as `response_format: {type:"json_schema",
   *  json_schema:{name:"response", strict:true, schema}}`, appended LAST. */
  jsonSchema?: unknown;
}

export interface BuiltPayload {
  payload: Record<string, unknown>;
  /** stderr lines (no trailing newline) the builder emits, e.g. the `--thinking ignored` note. */
  notes: string[];
}

/** Thrown when the system message cannot be prepended (jq `[…] + .` type error in Bash). */
export class PayloadError extends Error {}

export function buildOpenAIPayload(o: OpenAIPayloadOptions): BuiltPayload {
  const notes: string[] = [];
  let msgs: unknown = o.messages;
  if (o.system !== "") {
    if (!Array.isArray(o.messages)) {
      throw new PayloadError("--messages must be a JSON array (cannot prepend the system message)");
    }
    msgs = [{ role: "system", content: o.system }, ...o.messages];
  }
  const tokensField = usesMaxCompletionTokens(o.model) ? "max_completion_tokens" : "max_tokens";
  // Key order mirrors the jq filter: model, messages, stream, <tokens>, stream_options, reasoning.
  const payload: Record<string, unknown> = { model: o.model, messages: msgs, stream: o.stream };
  payload[tokensField] = o.maxTokens;
  if (o.stream) payload["stream_options"] = { include_usage: true };
  if (o.thinkingLevel !== "") {
    if (supportsOpenAIReasoning(o.model, o.assumeThinking)) {
      payload["reasoning"] = { effort: o.thinkingLevel, summary: "auto" };
    } else {
      notes.push(
        `llm: --thinking ignored: ${o.model} not in the known-reasoning model list (LLM_ASSUME_THINKING=1 to send anyway)`
      );
    }
  }
  if (o.jsonSchema !== undefined) {
    payload["response_format"] = { type: "json_schema", json_schema: { name: "response", strict: true, schema: o.jsonSchema } };
  }
  return { payload, notes };
}

// ---------------------------------------------------------------------------
// OpenRouter provider-routing block (bin/llm build_payload_openrouter,
// upstream 015d081). Normalisation (case-fold + validate) happens at the
// call site (llmCli.ts, matching where bin/llm normalises the env/flag
// values once rather than at each use) — this is purely the payload shape.
// ---------------------------------------------------------------------------

export interface OpenRouterRouting {
  /** Already-normalised comma-separated provider slugs, or "" for none. */
  only: string;
  /** "allow" | "deny" | "" for none. */
  dataCollection: string;
  zdr: boolean;
}

/** `null` when no routing knob is set — callers must send the OpenAI-family
 *  payload unchanged (byte-identical to before 015d081, no extra jq pass). */
export function buildOpenRouterProviderBlock(o: OpenRouterRouting): Record<string, unknown> | null {
  if (o.only === "" && o.dataCollection === "" && !o.zdr) return null;
  const p: Record<string, unknown> = {};
  if (o.only !== "") p["only"] = o.only.split(",");
  if (o.dataCollection !== "") p["data_collection"] = o.dataCollection;
  if (o.zdr) p["zdr"] = true;
  return p;
}

// ---------------------------------------------------------------------------
// jq-faithful accessors. The Bash tool reads responses with jq filters like
// `.choices[0].message.content // empty`; two jq rules matter for parity:
//   - `null.x` / `null[0]` are null, but indexing a string/number/array with a
//     key (or an object with a number) is an ERROR that aborts the whole
//     filter → the Bash sees empty output (`2>/dev/null`, `|| true`).
//   - `a // b` falls through on null AND false only ("" and 0 are kept).
// ---------------------------------------------------------------------------

export interface JqGet {
  err: boolean;
  value: unknown;
}

export function jqGet(v: unknown, keys: readonly (string | number)[]): JqGet {
  let cur: unknown = v;
  for (const k of keys) {
    if (cur === null || cur === undefined) {
      cur = null;
      continue;
    }
    if (typeof k === "number") {
      if (!Array.isArray(cur)) return { err: true, value: null };
      cur = cur[k] ?? null;
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return { err: true, value: null };
      cur = (cur as Record<string, unknown>)[k] ?? null;
    }
  }
  return { err: false, value: cur };
}

/** jq `//`: null and false are "absent". */
export function jqAbsent(v: unknown): boolean {
  return v === null || v === undefined || v === false;
}

/**
 * What `jq -r` prints for a value (strings raw, scalars as JSON, containers
 * pretty). PORT-NOTE: jq 1.7 keeps number literals as written (`1.0`, `1E+2`,
 * integers beyond 2^53); JSON.stringify canonicalizes them (`1`, `100`,
 * precision-lossy). Only non-string content ever shows the difference.
 */
export function jqRaw(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  return JSON.stringify(v, null, 2);
}

/**
 * Parse a JSON text the way `jq` would consume it; null when it does not parse.
 * A leading UTF-8 BOM is tolerated, as jq tolerates it (F3). PORT-NOTE: ONE
 * document only — jq streams every document in the text (`{…}\n{…}` is two
 * results there, not-JSON here); see the multi-document rows in PARITY.md.
 */
export function parseJson(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch {
    return { ok: false, value: null };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-family response readers (extract_text / check_response /
// check_truncated / usage — bin/llm, non-streaming and per-SSE-event).
// ---------------------------------------------------------------------------

/** `.choices[0].message.content // empty` — null means "print nothing at all". */
export function extractTextOpenAI(json: unknown): string | null {
  const g = jqGet(json, ["choices", 0, "message", "content"]);
  if (g.err || jqAbsent(g.value)) return null;
  return jqRaw(g.value);
}

/** `.choices[0].message.reasoning // empty` — the model's chain-of-thought,
 *  present only when `reasoning` was requested on the payload (upstream:
 *  `llm --thinking`'s captured-to-stderr text; see LlmResponse.reasoning). */
export function extractReasoningOpenAI(json: unknown): string | null {
  const g = jqGet(json, ["choices", 0, "message", "reasoning"]);
  if (g.err || jqAbsent(g.value)) return null;
  return jqRaw(g.value);
}

/**
 * check_response_openai: one line describing an embedded failure inside a 2xx
 * body, or "" when the response is sound. A jq path error anywhere → "" (the
 * Bash checker's output is empty when jq aborts).
 */
export function checkResponseOpenAI(json: unknown): string {
  const a = jqGet(json, ["error", "message"]);
  const b = jqGet(json, ["choices", 0, "error", "message"]);
  const c = jqGet(json, ["choices", 0, "finish_reason"]);
  if (a.err || b.err || c.err) return "";
  const candidates: string[] = [];
  if (!jqAbsent(a.value)) candidates.push(jqRaw(a.value));
  if (!jqAbsent(b.value)) candidates.push(jqRaw(b.value));
  const fr = jqAbsent(c.value) ? "" : c.value;
  if (fr === "error") candidates.push('finish_reason "error" (provider failed mid-generation)');
  return (candidates[0] ?? "").replace(/\n+$/, "");
}

/** True when the jq filter behind check_response_openai would abort (bash: set -e, exit 5). */
export function responseShapeErrorOpenAI(json: unknown): boolean {
  return jqGet(json, ["error", "message"]).err || jqGet(json, ["choices", 0, "error", "message"]).err || jqGet(json, ["choices", 0, "finish_reason"]).err;
}
/** True when the jq filter behind extract_text_openai would abort. */
export function extractShapeErrorOpenAI(json: unknown): boolean {
  return jqGet(json, ["choices", 0, "message", "content"]).err;
}

/** check_truncated_openai: `(.choices[0].finish_reason // "") == "length"`. */
export function isTruncatedOpenAI(json: unknown): boolean {
  const g = jqGet(json, ["choices", 0, "finish_reason"]);
  if (g.err) return false;
  return (jqAbsent(g.value) ? "" : g.value) === "length";
}

/** `.choices[0].finish_reason // empty` as a string ("" when absent/error). */
export function finishReasonOpenAI(json: unknown): string {
  const g = jqGet(json, ["choices", 0, "finish_reason"]);
  if (g.err || jqAbsent(g.value)) return "";
  return jqRaw(g.value);
}

/** Streaming delta text: `.choices[0].delta.content // empty` ("" when absent/error). */
export function deltaTextOpenAI(json: unknown): string {
  const g = jqGet(json, ["choices", 0, "delta", "content"]);
  if (g.err || jqAbsent(g.value)) return "";
  return jqRaw(g.value);
}

export interface UsageRecord {
  in_tok?: number;
  out_tok?: number;
  think_tok?: number;
  /** PORT-NOTE (1c: 1fdeb97): the part of in_tok the provider served from its
   *  prompt cache (OpenAI/OpenRouter prompt_tokens_details.cached_tokens,
   *  Anthropic cache_read_input_tokens, Gemini cachedContentTokenCount) —
   *  billed at the cached rate, so the prefix-cache hit rate is
   *  cache_tok / in_tok. Omitted when the provider reports nothing. */
  cache_tok?: number;
  /** PORT-NOTE (1c: 2d1c1c3): marks a record derived from bytes rather than
   *  the provider's own count (the stream was cut before a usage event
   *  arrived — LLM_STOP_AFTER_CODE_BLOCK). */
  estimated?: true;
  /** PORT-NOTE (sync 2e39a3f, c32d5b0-era write_usage): the upstream host
   *  OpenRouter routed the call to (the `provider` field on its responses;
   *  absent elsewhere). One model id on OpenRouter is two dozen hosts at
   *  different speeds, so a slow or cut-off call is only explainable with the
   *  host on the record. Key order after `estimated`, as write_usage's jq. */
  served_by?: string;
  /** Present (true) only when the output hit max_tokens. */
  truncated?: true;
}

/** write_usage's filter: only values that print as `^[0-9]+$` are recorded. */
export function usageNumber(v: unknown): number | undefined {
  if (jqAbsent(v)) return undefined;
  const s = jqRaw(v);
  return /^[0-9]+$/.test(s) ? Number(s) : undefined;
}

/**
 * Non-streaming usage: `[(.usage.prompt_tokens // ""), (.usage.completion_tokens // ""),
 * (.usage.completion_tokens_details.reasoning_tokens // "")] | @tsv`. `ok:false`
 * when the jq filter would abort (no usage record is written at all).
 *
 * PORT-NOTE (deliberate fix of a source bug): the Bash reads the @tsv row with
 * `IFS=$'\t' read -r in out think`, and `read` collapses EMPTY leading/middle
 * cells — a usage without prompt_tokens shifts completion_tokens into in_tok
 * and reasoning_tokens into out_tok. Each value stays in its own field here.
 * Complete records are byte-identical (PARITY.md "usage record with a missing
 * leading/middle token field").
 */
export function usageOpenAI(json: unknown): { ok: boolean; rec: UsageRecord } {
  const i = jqGet(json, ["usage", "prompt_tokens"]);
  const o = jqGet(json, ["usage", "completion_tokens"]);
  const t = jqGet(json, ["usage", "completion_tokens_details", "reasoning_tokens"]);
  // PORT-NOTE (1c: 1fdeb97): cache_tok, a fourth @tsv cell.
  const ca = jqGet(json, ["usage", "prompt_tokens_details", "cached_tokens"]);
  if (i.err || o.err || t.err || ca.err) return { ok: false, rec: {} };
  // F12: `@tsv` aborts on an object/array cell ("Not valid in a csv row") →
  // the Bash writes no record at all, not the other fields.
  if ([i.value, o.value, t.value, ca.value].some((v) => v !== null && typeof v === "object")) {
    return { ok: false, rec: {} };
  }
  const rec: UsageRecord = {};
  const ni = usageNumber(i.value);
  const no = usageNumber(o.value);
  const nt = usageNumber(t.value);
  const nc = usageNumber(ca.value);
  if (ni !== undefined) rec.in_tok = ni;
  if (no !== undefined) rec.out_tok = no;
  if (nt !== undefined) rec.think_tok = nt;
  if (nc !== undefined) rec.cache_tok = nc;
  return { ok: true, rec };
}

/**
 * Streaming usage chunk (`select(.usage != null) | …`): null when the event
 * carries no usage (or jq would abort), else the record.
 */
export function streamUsageOpenAI(json: unknown): UsageRecord | null {
  const u = jqGet(json, ["usage"]);
  if (u.err || u.value === null) return null;
  const r = usageOpenAI(json);
  return r.ok ? r.rec : null;
}

/** `.error.message // .message // empty` over an HTTP error body ("" when absent/error). */
export function errorMessageOf(json: unknown): string {
  const a = jqGet(json, ["error", "message"]);
  if (a.err) return "";
  if (!jqAbsent(a.value)) return jqRaw(a.value).replace(/\n+$/, "");
  const b = jqGet(json, ["message"]);
  if (b.err || jqAbsent(b.value)) return "";
  return jqRaw(b.value).replace(/\n+$/, "");
}

/** `.error.message // empty` over the buffered non-SSE stream body ("" when absent/unparseable). */
export function streamErrorMessageOf(text: string): string {
  const p = parseJson(text);
  if (!p.ok) return "";
  const g = jqGet(p.value, ["error", "message"]);
  if (g.err || jqAbsent(g.value)) return "";
  return jqRaw(g.value).replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// OpenAI-family SSE stream handler (bin/llm stream_openai). Feed it lines
// (CR already stripped); it emits text deltas / truncation / usage through the
// sink and tracks the pre-data error buffer for _die_if_no_stream_data.
// ---------------------------------------------------------------------------

export interface OpenAIStreamSink {
  /** A non-empty text delta — the caller marks "emitted" and writes it. */
  text(chunk: string): void;
  /** The chunk named its upstream host (OpenRouter's `provider` string). The
   *  caller keeps the first non-empty one. */
  servedBy?(name: string): void;
  /** finish_reason "content_filter": a refusal that ended the stream cleanly
   *  with no content. The caller decides whether anything was emitted. */
  refused?(): void;
  /** finish_reason "length" arrived. */
  truncated(): void;
  /** A usage chunk arrived (overwrites any earlier one). */
  usage(rec: UsageRecord): void;
}

export interface OpenAIStreamHandler {
  line(line: string): void;
  /** True once any `data: ` event was seen. */
  readonly sawData: boolean;
  /** Non-data lines buffered before the first data event (each + "\n"). */
  readonly errBuf: string;
}

export function createOpenAIStreamHandler(sink: OpenAIStreamSink): OpenAIStreamHandler {
  const st = { sawData: false, errBuf: "" };
  return {
    get sawData() {
      return st.sawData;
    },
    get errBuf() {
      return st.errBuf;
    },
    line(line: string): void {
      if (line.startsWith("data: ")) {
        st.sawData = true;
        const json = line.slice("data: ".length);
        if (json === "[DONE]") return;
        const p = parseJson(json);
        if (!p.ok) return; // jq parse-fails on the event: nothing extracted
        const chunk = deltaTextOpenAI(p.value);
        if (chunk !== "") sink.text(chunk);
        // OpenRouter names the upstream host on every chunk; the caller reads it once.
        if (json.includes('"provider"')) {
          const g = jqGet(p.value, ["provider"]);
          if (!g.err && typeof g.value === "string") sink.servedBy?.(g.value);
        }
        // Glob guards from the Bash (keeps jq off the hot per-delta path).
        if (json.includes('"finish_reason"') && !json.includes('"finish_reason":null')) {
          const fr = finishReasonOpenAI(p.value);
          if (fr === "length") sink.truncated();
          if (fr === "content_filter") sink.refused?.();
        }
        if (json.includes('"usage"') && !json.includes('"usage":null')) {
          const u = streamUsageOpenAI(p.value);
          if (u !== null) sink.usage(u);
        }
      } else if (!st.sawData) {
        st.errBuf += line + "\n";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Health-marker failure classification (bin/llm _llm_note)
// ---------------------------------------------------------------------------

export type FailureKind = "credit" | "auth" | "rate" | "other";

/** The HTTP code wins when present; the message words are the fallback. */
export function classifyFailureKind(httpCode: string, message: string): FailureKind {
  if (httpCode === "402") return "credit";
  if (httpCode === "401" || httpCode === "403") return "auth";
  if (httpCode === "429") return "rate";
  const m = message.toLowerCase();
  if (/(credit|billing|insufficient|quota|balance|payment|funds|budget)/s.test(m)) return "credit";
  if (/(invalid.*key|authentication|unauthorized|api.key|forbidden|permission)/s.test(m)) return "auth";
  if (/(rate.limit|too.many.requests|overloaded)/s.test(m)) return "rate";
  return "other";
}

// ---------------------------------------------------------------------------
// Anthropic wire path (bin/llm build_payload_anthropic / get_url_headers /
// extract_text_anthropic / check_response_anthropic / check_truncated_anthropic
// / stream_anthropic). Reused verbatim by opencode (Zen), which speaks the
// same Anthropic protocol — see buildOpencodeZenPayload below.
// ---------------------------------------------------------------------------

/** supports_anthropic_thinking: family globs, not versioned ones (bin/llm). */
export function supportsAnthropicThinking(model: string, assumeThinking: boolean): boolean {
  if (assumeThinking) return true;
  return caseMatch(model, "claude-opus-*|claude-sonnet-*|claude-haiku-*|claude-fable-*|claude-mythos-*");
}

export interface AnthropicPayloadOptions {
  model: string;
  messages: unknown;
  system: string;
  stream: boolean;
  maxTokens: number;
  /** `--thinking` flag (bare or with a level — Anthropic ignores the level; the beta is always "adaptive"). */
  thinking: boolean;
  /** `--effort LEVEL`, sent verbatim to `output_config.effort`; no model-family guard in the Bash. */
  effort: string;
  assumeThinking: boolean;
  /** `--json-schema` was given: OpenAI-style providers only, so it is ignored with a note here. */
  jsonSchemaGiven?: boolean;
}

/** build_payload_anthropic. Key order: model, max_tokens, [system], messages, stream, [thinking], [output_config]. */
export function buildAnthropicPayload(o: AnthropicPayloadOptions): BuiltPayload {
  const notes: string[] = [];
  if (o.jsonSchemaGiven) {
    notes.push("llm: --json-schema ignored: not supported for provider anthropic (OpenAI-style providers only)");
  }
  const payload: Record<string, unknown> = { model: o.model, max_tokens: o.maxTokens };
  if (o.system !== "") payload["system"] = o.system;
  payload["messages"] = o.messages;
  payload["stream"] = o.stream;
  if (o.thinking) {
    if (supportsAnthropicThinking(o.model, o.assumeThinking)) {
      payload["thinking"] = { type: "adaptive", display: "summarized" };
    } else {
      notes.push(
        `llm: --thinking ignored: ${o.model} not in the known-thinking model list (LLM_ASSUME_THINKING=1 to send anyway)`
      );
    }
  }
  if (o.effort !== "") payload["output_config"] = { effort: o.effort };
  return { payload, notes };
}

/**
 * build_payload_opencode: OpenCode Zen speaks the Anthropic protocol, but its
 * gateway rejects the adaptive-thinking beta (and effort rides the same beta
 * family) — both are force-dropped, with a note when either was requested.
 */
export function buildOpencodeZenPayload(o: AnthropicPayloadOptions): BuiltPayload {
  const notes: string[] = [];
  if (o.thinking || o.effort !== "") {
    notes.push("llm: note: OpenCode Zen rejects the thinking/effort betas; dropping them (thinking happens server-side)");
  }
  const built = buildAnthropicPayload({ ...o, thinking: false, effort: "" });
  // built.notes is only the --json-schema note once thinking/effort are cleared (it follows the Zen note, as in the Bash).
  return { payload: built.payload, notes: [...notes, ...built.notes] };
}

/** `.content[]?` iteration target: array items, object values, or (on a scalar) nothing — jq's `?` swallows the iterate-error. */
function anthropicContentItems(json: unknown): unknown[] | null {
  const g = jqGet(json, ["content"]);
  if (g.err) return null;
  const v = g.value;
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>);
  return null; // `.[]` on a scalar errors, caught by the `?`
}

/** True when `select(.type=="text")` would abort on a non-object content item (no `?` there). */
export function extractShapeErrorAnthropic(json: unknown): boolean {
  const items = anthropicContentItems(json);
  if (items === null) return false;
  for (const item of items) {
    if (item === null) continue; // `null.type` is null, not an error
    if (typeof item !== "object" || Array.isArray(item)) return true;
  }
  return false;
}

/** extract_text_anthropic: `.content[]? | select(.type=="text") | .text`, one jq -r line per match, joined. */
export function extractTextAnthropic(json: unknown): string | null {
  const items = anthropicContentItems(json);
  if (items === null) return null;
  const lines: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (obj["type"] === "text") lines.push(jqRaw(obj["text"] ?? null));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** True when `check_response_anthropic`'s `.type`/`.error.message` chain would abort. */
export function responseShapeErrorAnthropic(json: unknown): boolean {
  const t = jqGet(json, ["type"]);
  if (t.err) return true;
  if (t.value !== "error") return false;
  return jqGet(json, ["error", "message"]).err;
}

/** check_response_anthropic: `if .type == "error" then .error.message // "unknown error" else empty end`. */
export function checkResponseAnthropic(json: unknown): string {
  const t = jqGet(json, ["type"]);
  if (t.err || t.value !== "error") return "";
  const m = jqGet(json, ["error", "message"]);
  if (m.err) return "";
  return (jqAbsent(m.value) ? "unknown error" : jqRaw(m.value)).replace(/\n+$/, "");
}

/** check_truncated_anthropic: `.stop_reason == "max_tokens"`. */
export function isTruncatedAnthropic(json: unknown): boolean {
  const g = jqGet(json, ["stop_reason"]);
  if (g.err) return false;
  return (jqAbsent(g.value) ? "" : g.value) === "max_tokens";
}

/**
 * Non-streaming usage (anthropic|opencode): `[(.usage.input_tokens // ""),
 * (.usage.output_tokens // ""), ""] | @tsv` — the third TSV cell is always the
 * literal empty string, so `think_tok` is never recorded on this wire path.
 */
export function usageAnthropic(json: unknown): { ok: boolean; rec: UsageRecord } {
  const i = jqGet(json, ["usage", "input_tokens"]);
  const o = jqGet(json, ["usage", "output_tokens"]);
  // PORT-NOTE (1c: 1fdeb97): cache_tok, a fourth @tsv cell
  // (`.usage.cache_read_input_tokens // ""`); the third cell (think_tok)
  // stays the literal empty string, as before.
  const ca = jqGet(json, ["usage", "cache_read_input_tokens"]);
  if (i.err || o.err || ca.err) return { ok: false, rec: {} };
  if ([i.value, o.value, ca.value].some((v) => v !== null && typeof v === "object")) return { ok: false, rec: {} };
  const rec: UsageRecord = {};
  const ni = usageNumber(i.value);
  const no = usageNumber(o.value);
  const nc = usageNumber(ca.value);
  if (ni !== undefined) rec.in_tok = ni;
  if (no !== undefined) rec.out_tok = no;
  if (nc !== undefined) rec.cache_tok = nc;
  return { ok: true, rec };
}

/** `^[0-9]+$` test against a raw jq -r STRING (not a JSON value) — the shape write_usage itself applies. */
function numFromRawText(s: string): number | undefined {
  return /^[0-9]+$/.test(s) ? Number(s) : undefined;
}

export interface AnthropicStreamSink {
  /** A non-empty text delta — the caller marks "emitted" and writes it to stdout. */
  text(chunk: string): void;
  /** A non-empty thinking delta — the caller marks "emitted" and writes it to stderr. */
  thinking(chunk: string): void;
  truncated(): void;
  usage(rec: UsageRecord): void;
  /**
   * A `type:"error"` SSE event: the Bash calls `die` immediately from inside
   * the stream-handler subshell (its own `llm: error: API stream error: …`
   * line goes straight to the real stderr, not a captured buffer) and the
   * subshell exits 1. The OUTER retry loop only gates on the emitted-marker
   * and exit code — not on WHY the subshell exited — so an error event with
   * nothing emitted yet is still retried (replaying the already-printed die
   * text once per attempt); with something already emitted, or once retries
   * are exhausted, the call ends at exit 1 with NO health-marker update (the
   * same "mid-stream die already printed its message" rule as elsewhere).
   */
  fatal(message: string): void;
}

export interface AnthropicStreamHandler {
  line(line: string): void;
  readonly sawData: boolean;
  readonly errBuf: string;
  /** True once a `type:"error"` event fired `sink.fatal()` — the caller stops feeding lines. */
  readonly isFatal: boolean;
}

export function createAnthropicStreamHandler(sink: AnthropicStreamSink): AnthropicStreamHandler {
  const st = { sawData: false, errBuf: "", block: "" as "" | "thinking" | "text", uIn: "", uCache: "", fatal: false };
  const rawField = (value: unknown, keys: readonly (string | number)[]): string => {
    const g = jqGet(value, keys);
    return g.err || jqAbsent(g.value) ? "" : jqRaw(g.value);
  };
  return {
    get sawData() {
      return st.sawData;
    },
    get errBuf() {
      return st.errBuf;
    },
    get isFatal() {
      return st.fatal;
    },
    line(line: string): void {
      if (st.fatal) return;
      if (line.startsWith("data: ")) {
        st.sawData = true;
        const json = line.slice("data: ".length);
        if (json === "[DONE]") return;
        if (json.includes('"content_block_start"')) {
          if (json.includes('"thinking"')) st.block = "thinking";
          else if (json.includes('"text"')) st.block = "text";
        } else if (json.includes('"content_block_delta"')) {
          const p = parseJson(json);
          if (!p.ok) return;
          if (st.block === "thinking") {
            const v = rawField(p.value, ["delta", "thinking"]);
            if (v !== "") sink.thinking(v);
          } else if (st.block === "text") {
            const v = rawField(p.value, ["delta", "text"]);
            if (v !== "") sink.text(v);
          }
        } else if (json.includes('"content_block_stop"')) {
          st.block = "";
        } else if (json.includes('"message_start"')) {
          const p = parseJson(json);
          if (p.ok) {
            st.uIn = rawField(p.value, ["message", "usage", "input_tokens"]);
            // PORT-NOTE (1c: 1fdeb97): cache_read_input_tokens arrives on the
            // same up-front message_start event as input_tokens.
            st.uCache = rawField(p.value, ["message", "usage", "cache_read_input_tokens"]);
          }
        } else if (json.includes('"message_delta"')) {
          const p = parseJson(json);
          if (p.ok) {
            if (rawField(p.value, ["delta", "stop_reason"]) === "max_tokens") sink.truncated();
            if (json.includes('"output_tokens"')) {
              const uOut = rawField(p.value, ["usage", "output_tokens"]);
              if (uOut !== "") {
                const rec: UsageRecord = {};
                const ni = numFromRawText(st.uIn);
                const no = numFromRawText(uOut);
                const nc = numFromRawText(st.uCache);
                if (ni !== undefined) rec.in_tok = ni;
                if (no !== undefined) rec.out_tok = no;
                if (nc !== undefined) rec.cache_tok = nc;
                sink.usage(rec);
              }
            }
          }
        } else if (json.includes('"type":"error"')) {
          const p = parseJson(json);
          const msg = p.ok ? rawField(p.value, ["error", "message"]) : "";
          st.fatal = true;
          sink.fatal(`API stream error: ${msg !== "" ? msg : "unknown error"}`);
        }
      } else if (!st.sawData) {
        st.errBuf += line + "\n";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini wire path (bin/llm build_payload_gemini / get_url_headers /
// extract_text_gemini / check_response_gemini / check_truncated_gemini /
// stream_gemini).
// ---------------------------------------------------------------------------

/** supports_gemini_thinking. */
export function supportsGeminiThinking(model: string, assumeThinking: boolean): boolean {
  if (assumeThinking) return true;
  return caseMatch(model, "gemini-2.0*|gemini-2.5*|gemini-[3-9]*");
}

export interface GeminiPayloadOptions {
  model: string;
  messages: unknown;
  system: string;
  maxTokens: number;
  /** `--thinking LEVEL` — like OpenAI, driven by an explicit level only (bare `--thinking` is a no-op). */
  thinkingLevel: string;
  assumeThinking: boolean;
  /** `--json-schema` was given: not supported by Gemini, ignored with a note. */
  jsonSchemaGiven?: boolean;
}

/** `.[] | {role:(assistant->model, else verbatim), parts:[{text:.content}]}` — throws like a jq-abort on an unshaped input. */
export function geminiContents(messages: unknown): unknown[] {
  let items: unknown[];
  if (Array.isArray(messages)) items = messages;
  else if (messages !== null && typeof messages === "object") items = Object.values(messages as Record<string, unknown>);
  else throw new PayloadError("messages must be a JSON array or object to build the Gemini request (cannot iterate)");
  return items.map((m) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new PayloadError("each message must be a JSON object to build the Gemini request");
    }
    const obj = m as Record<string, unknown>;
    const role = jqAbsent(obj["role"]) ? null : obj["role"];
    return { role: role === "assistant" ? "model" : role, parts: [{ text: obj["content"] ?? null }] };
  });
}

/** build_payload_gemini. Key order: contents, [systemInstruction], generationConfig. */
export function buildGeminiPayload(o: GeminiPayloadOptions): BuiltPayload {
  const notes: string[] = [];
  if (o.jsonSchemaGiven) notes.push("llm: --json-schema ignored: not supported for provider gemini");
  const contents = geminiContents(o.messages);
  const genConfig: Record<string, unknown> = { maxOutputTokens: o.maxTokens };
  if (o.thinkingLevel !== "") {
    if (supportsGeminiThinking(o.model, o.assumeThinking)) {
      genConfig["thinkingConfig"] = { thinkingLevel: o.thinkingLevel };
    } else {
      notes.push(
        `llm: --thinking ignored: ${o.model} not in the known-thinking model list (LLM_ASSUME_THINKING=1 to send anyway)`
      );
    }
  }
  const payload: Record<string, unknown> = { contents };
  if (o.system !== "") payload["systemInstruction"] = { parts: [{ text: o.system }] };
  payload["generationConfig"] = genConfig;
  return { payload, notes };
}

/** extract_text_gemini: `.candidates[0].content.parts[0].text // empty`. */
export function extractTextGemini(json: unknown): string | null {
  const g = jqGet(json, ["candidates", 0, "content", "parts", 0, "text"]);
  if (g.err || jqAbsent(g.value)) return null;
  return jqRaw(g.value);
}
export function extractShapeErrorGemini(json: unknown): boolean {
  return jqGet(json, ["candidates", 0, "content", "parts", 0, "text"]).err;
}

/** check_response_gemini: `.error.message // empty`. */
export function checkResponseGemini(json: unknown): string {
  const g = jqGet(json, ["error", "message"]);
  if (g.err || jqAbsent(g.value)) return "";
  return jqRaw(g.value).replace(/\n+$/, "");
}
export function responseShapeErrorGemini(json: unknown): boolean {
  return jqGet(json, ["error", "message"]).err;
}

/** check_truncated_gemini: `.candidates[0].finishReason == "MAX_TOKENS"`. */
export function isTruncatedGemini(json: unknown): boolean {
  const g = jqGet(json, ["candidates", 0, "finishReason"]);
  if (g.err) return false;
  return (jqAbsent(g.value) ? "" : g.value) === "MAX_TOKENS";
}

/** Non-streaming usage: promptTokenCount / candidatesTokenCount / thoughtsTokenCount, `@tsv`-style (F12 all-or-nothing on an object/array cell). */
export function usageGemini(json: unknown): { ok: boolean; rec: UsageRecord } {
  const i = jqGet(json, ["usageMetadata", "promptTokenCount"]);
  const o = jqGet(json, ["usageMetadata", "candidatesTokenCount"]);
  const t = jqGet(json, ["usageMetadata", "thoughtsTokenCount"]);
  // PORT-NOTE (1c: 1fdeb97): cache_tok, a fourth @tsv cell.
  const ca = jqGet(json, ["usageMetadata", "cachedContentTokenCount"]);
  if (i.err || o.err || t.err || ca.err) return { ok: false, rec: {} };
  if ([i.value, o.value, t.value, ca.value].some((v) => v !== null && typeof v === "object")) {
    return { ok: false, rec: {} };
  }
  const rec: UsageRecord = {};
  const ni = usageNumber(i.value);
  const no = usageNumber(o.value);
  const nt = usageNumber(t.value);
  const nc = usageNumber(ca.value);
  if (ni !== undefined) rec.in_tok = ni;
  if (no !== undefined) rec.out_tok = no;
  if (nt !== undefined) rec.think_tok = nt;
  if (nc !== undefined) rec.cache_tok = nc;
  return { ok: true, rec };
}

export interface GeminiStreamSink {
  text(chunk: string): void;
  truncated(): void;
  usage(rec: UsageRecord): void;
}
export interface GeminiStreamHandler {
  line(line: string): void;
  readonly sawData: boolean;
  readonly errBuf: string;
}

export function createGeminiStreamHandler(sink: GeminiStreamSink): GeminiStreamHandler {
  const st = { sawData: false, errBuf: "" };
  return {
    get sawData() {
      return st.sawData;
    },
    get errBuf() {
      return st.errBuf;
    },
    line(line: string): void {
      if (line.startsWith("data: ")) {
        st.sawData = true;
        const json = line.slice("data: ".length);
        if (json === "[DONE]") return;
        const p = parseJson(json);
        if (!p.ok) return;
        const g = jqGet(p.value, ["candidates", 0, "content", "parts", 0, "text"]);
        const chunk = g.err || jqAbsent(g.value) ? "" : jqRaw(g.value);
        if (chunk !== "") sink.text(chunk);
        // No null-exclusion glob guard here — bin/llm's stream_gemini checks
        // only for the substring, unlike stream_openai/_anthropic.
        if (json.includes('"finishReason"')) {
          const fr = jqGet(p.value, ["candidates", 0, "finishReason"]);
          if (!fr.err && !jqAbsent(fr.value) && fr.value === "MAX_TOKENS") sink.truncated();
        }
        // No `select(.usageMetadata != null)` guard in the Bash's tsv filter:
        // `@tsv` of three absent (`// ""`) fields is still non-empty text
        // ("\t\t"), so write_usage runs whenever this substring guard passes
        // and the tsv assembly itself doesn't abort (F12) — even to record {}.
        if (json.includes('"usageMetadata"')) {
          const i = jqGet(p.value, ["usageMetadata", "promptTokenCount"]);
          const o = jqGet(p.value, ["usageMetadata", "candidatesTokenCount"]);
          const t = jqGet(p.value, ["usageMetadata", "thoughtsTokenCount"]);
          // PORT-NOTE (1c: 1fdeb97): cache_tok, a fourth @tsv cell.
          const ca = jqGet(p.value, ["usageMetadata", "cachedContentTokenCount"]);
          if (
            !i.err &&
            !o.err &&
            !t.err &&
            !ca.err &&
            ![i.value, o.value, t.value, ca.value].some((v) => v !== null && typeof v === "object")
          ) {
            const rec: UsageRecord = {};
            const ni = usageNumber(i.value);
            const no = usageNumber(o.value);
            const nt = usageNumber(t.value);
            const nc = usageNumber(ca.value);
            if (ni !== undefined) rec.in_tok = ni;
            if (no !== undefined) rec.out_tok = no;
            if (nt !== undefined) rec.think_tok = nt;
            if (nc !== undefined) rec.cache_tok = nc;
            sink.usage(rec);
          }
        }
      } else if (!st.sawData) {
        st.errBuf += line + "\n";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter seam (bin/llm's `LLM_PROVIDER=adapter` invoker; design/providers.md).
// Pure argv-shape helper only — process spawning/deadline lives in llmCli.ts.
// ---------------------------------------------------------------------------

export interface AdapterArgsOptions {
  model: string;
  /** The resolved max-tokens TEXT (raw `-t`/`LLM_MAX_TOKENS` digits when numeric, else the computed default) — an argv token, not JSON, so leading zeros survive verbatim as bash would pass them. */
  maxTokensText: string;
  effort: string;
  thinking: boolean;
  thinkingLevel: string;
  stream: boolean;
  /** Path to the system-prompt tempfile, when a system prompt was given. */
  systemPromptFile: string | null;
}

/** `_adapter_args` construction, in bash's exact order. */
export function buildAdapterArgs(o: AdapterArgsOptions): string[] {
  const args = ["--model", o.model, "--max-tokens", o.maxTokensText];
  if (o.effort !== "") args.push("--effort", o.effort);
  if (o.thinking) {
    args.push("--thinking");
    if (o.thinkingLevel !== "") args.push(o.thinkingLevel);
  }
  if (!o.stream) args.push("--no-stream");
  if (o.systemPromptFile !== null) args.push("--system-prompt-file", o.systemPromptFile);
  return args;
}

/** Host-only view of a URL for the LLM_API_URL warning (bash parameter-expansion steps, verbatim). */
export function hostOf(url: string): string {
  let h = url;
  const i = h.indexOf("://");
  if (i >= 0) h = h.slice(i + 3); // ${url#*://}
  h = h.split("/")[0]!; // ${h%%/*}
  h = h.split("?")[0]!; // ${h%%\?*}
  h = h.split("#")[0]!; // ${h%%#*}
  const at = h.lastIndexOf("@"); // ${h##*@}
  if (at >= 0) h = h.slice(at + 1);
  return h;
}
