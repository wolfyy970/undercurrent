// llm.ts — the model call, made INJECTABLE (SPEC §1.2, DoD #2).
//
// The shellm loop depends only on the LlmClient interface. The engine runs `llm` (src/llmCliClient.ts); the manual
// scripts use OpenRouterClient below. There is no replay or fake client in src/: tests serve model output from a
// local HTTP server (test/support/modelHttpFixture.ts) and call it through a real client.

import {
  extractTextOpenAI,
  extractReasoningOpenAI,
  parseJson,
  checkResponseOpenAI,
  responseShapeErrorOpenAI,
  errorMessageOf,
  usageOpenAI,
  isTruncatedOpenAI,
  jqGet,
} from "./llmProvider.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  in_tok?: number;
  out_tok?: number;
  think_tok?: number;
  /** bin/llm write_usage 4th arg (1fdeb97): the part of in_tok served from the provider's prompt cache. */
  cache_tok?: number;
  /**
   * PORT-NOTE (bug #69, bin/llm:990-998 write_usage): set when a
   * stop-after-code-block cut estimated out_tok from bytes kept rather than
   * a real usage event — bin/llm's write_usage REWRITES the whole usage
   * file on that cut, so in_tok/think_tok are dropped, not merged with any
   * value already captured earlier in the stream.
   */
  estimated?: boolean;
  /**
   * PORT-NOTE (sync 2e39a3f, bin/llm write_usage): OpenRouter's upstream host
   * for this call (`.provider`, a string) and the output-hit-max_tokens flag.
   * thinkers/responder/step lifts both onto its decision observation.
   */
  served_by?: string;
  truncated?: true;
}

/**
 * PORT-NOTE (sync 2e39a3f, thinkers/responder/step `_reply_llm`): per-call
 * limits a caller can set the way the responder sets bin/llm's `-t`,
 * LLM_MAX_TIME, LLM_RETRIES and `--json-schema`. Absent = the client's own
 * configuration.
 */
export interface CompleteOptions {
  /** `llm -t N` / max_tokens for this call. */
  maxTokens?: number;
  /** LLM_MAX_TIME seconds per attempt, in ms. A call that outlives it fails with `timedOut`. */
  maxTimeMs?: number;
  /** LLM_RETRIES for this call (0 = one attempt). */
  retries?: number;
  /** `--json-schema`: the parsed JSON Schema; sent as response_format json_schema (strict). */
  jsonSchema?: unknown;
}

/**
 * A failed model call, carrying what the responder reads off bin/llm's
 * stderr: the wall-clock cap was hit (`curl: (28)` / "timed out") and/or the
 * output hit max_tokens ("output truncated at max_tokens"). Plain Error
 * semantics otherwise.
 */
export class LlmCallError extends Error {
  timedOut: boolean;
  truncated: boolean;
  /** What the `llm` call wrote to stderr (plain mode), for callers that pass it on as upstream's `cat "$err" >&2` does. */
  diagnostics?: string;
  constructor(message: string, flags: { timedOut?: boolean; truncated?: boolean; diagnostics?: string } = {}) {
    super(message);
    this.name = "LlmCallError";
    this.timedOut = flags.timedOut === true;
    this.truncated = flags.truncated === true;
    if (flags.diagnostics !== undefined) this.diagnostics = flags.diagnostics;
  }
}

export interface LlmResponse {
  /** The full assistant text (reasoning prose + fenced bash block). */
  text: string;
  /** Plain mode: what the `llm` call wrote to stderr (warnings), for callers that pass it on (responder `_reply_llm`). */
  diagnostics?: string;
  /**
   * The model's chain-of-thought/reasoning, captured on a side channel
   * separate from `text` (bin/shellm's call_llm: `llm --thinking` streams
   * this to stderr while stdout carries only the visible answer). Used
   * ONLY for the empty-response retry's feedback (src/shellm.ts, upstream
   * 8ba520b/136f32b) — never stored as the trajectory's `reasoning` field,
   * which stays `extractReasoning(text)` (the prose before the first code
   * fence of a NON-empty response, an unrelated concept).
   */
  reasoning?: string;
  usage?: LlmUsage;
}

export interface LlmClient {
  /**
   * @param system the shellm system prompt (the contract).
   * @param messages the multi-turn context rebuilt from the trajectory.
   */
  complete(system: string, messages: ChatMessage[], opts?: CompleteOptions): Promise<LlmResponse>;
}

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string; // e.g. https://openrouter.ai/api/v1 — "/chat/completions" is appended.
  /**
   * PORT-NOTE (bug #39, bin/llm:765/788, src/llmCli.ts:1646): when a caller
   * overrides the endpoint via LLM_API_URL, upstream and this port's own
   * llmCli.ts treat that value as the FULL request URL, not a base one more
   * path is appended to (`url="${LLM_API_URL:-https://openrouter.ai/api/v1/chat/completions}"`).
   * Set `url` to use the value verbatim; `baseUrl` stays the DEFAULT-only
   * base (nothing overrode it) that "/chat/completions" is appended to.
   */
  url?: string;
  model: string; // e.g. deepseek/deepseek-v4-flash-0731
  maxTokens?: number;
  effort?: string;
  /**
   * PORT-NOTE (bug #53, bin/llm:92,1351-1352): LLM_RETRIES ladder for
   * transient API failures on this non-streaming wire path — same
   * conditions/attempt-count/backoff/stderr-line/terminal-error-text as
   * `llm`'s own non-streaming path (src/llmCli.ts runNonStreaming), built
   * from the SAME llmProvider.ts primitives (checkResponseOpenAI,
   * responseShapeErrorOpenAI, errorMessageOf, parseJson) so the two stay in
   * lockstep without duplicating llmCli.ts. Undefined = bin/llm's own
   * default (LLM_RETRIES=2 → 3 attempts total). Callers translate the
   * LLM_RETRIES/LLM_RETRY_BACKOFF env vars into these (steprun.ts
   * buildLlmClient), including bin/llm:1351's non-digit-string → 0 rule.
   */
  retries?: number;
  /** LLM_RETRY_BACKOFF (bin/llm:93): seconds, grows linearly per attempt. Default 1. */
  retryBackoffS?: number;
  /**
   * Retry/terminal-failure stderr sink — defaults to the real process stream
   * (same call REAL_WAKE_IO.stderr makes, src/shellm.ts), so the retry noise
   * lands in a wake's run/logs/<thinker>.log like every other progress line.
   * Tests inject a capturing sink to assert the exact line.
   */
  stderr?: (s: string) => void;
  /** Test seam for the inter-attempt sleep; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Real OpenRouter (OpenAI-compatible) client. Used only by the manual
 * scripts/real-wake.ts — never by the test suite.
 *
 * Shares the OpenAI-family response reader with the `llm` CLI port
 * (src/llmProvider.ts). Its REQUEST shape is deliberately its own and left
 * untouched: it sends `reasoning:{effort}` (no `summary`, no model-family
 * guard) and never `stream`/`stream_options`, whereas bin/llm never sends
 * `--effort` on the OpenAI family and only sends `reasoning` for an explicit
 * `--thinking LEVEL` on gpt-5+/o-series.
 *
 * BEHAVIORAL-PARITY ROUND (W1): the ENGINE no longer uses this client. src/steprun.ts's buildLlmClient returns
 * LlmCliClient (src/llmCliClient.ts), which runs `llm` the way upstream's shellm loop and responder do, so the
 * request is upstream's (stream, max_tokens, no reasoning field). OpenRouterClient remains only for the manual
 * scripts (scripts/real-wake.ts, scripts/real-reactive.ts) and its own retry tests.
 */
export class OpenRouterClient implements LlmClient {
  private readonly cfg: OpenRouterConfig;
  constructor(cfg: OpenRouterConfig) {
    this.cfg = cfg;
  }

  async complete(system: string, messages: ChatMessage[], opts: CompleteOptions = {}): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [{ role: "system", content: system }, ...messages],
    };
    const maxTokens = opts.maxTokens ?? this.cfg.maxTokens;
    if (maxTokens) body["max_tokens"] = maxTokens;
    if (this.cfg.effort) body["reasoning"] = { effort: this.cfg.effort };
    // bin/llm --json-schema: response_format appended LAST (llmProvider.ts payload builder).
    if (opts.jsonSchema !== undefined) {
      body["response_format"] = { type: "json_schema", json_schema: { name: "response", strict: true, schema: opts.jsonSchema } };
    }

    const url = this.cfg.url ?? `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const stderr = this.cfg.stderr ?? ((s: string) => void process.stderr.write(s));
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retries = opts.retries ?? this.cfg.retries ?? 2;
    const backoffS = this.cfg.retryBackoffS ?? 1;
    const maxAttempts = retries + 1;

    // PORT-NOTE (bug #53, bin/llm:1424-1475 non-streaming path, mirrored via
    // src/llmCli.ts runNonStreaming): same ladder — retry only while nothing
    // has been read back as a successful answer yet (a transient HTTP code,
    // or a 2xx whose body is whitespace-only or carries an embedded
    // provider failure); exhausting it, or any other status, is terminal.
    let attempt = 0;
    let httpCode = "000";
    let bodyText = "";
    let timedOut = false; // the LAST attempt died on LLM_MAX_TIME
    let truncatedSeen = false; // the last readable body said finish_reason=length
    const fail = (msg: string): LlmCallError => new LlmCallError(msg, { timedOut, truncated: truncatedSeen });
    for (;;) {
      attempt += 1;
      httpCode = "000";
      bodyText = "";
      timedOut = false;
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          ...(opts.maxTimeMs ? { signal: AbortSignal.timeout(opts.maxTimeMs) } : {}),
        });
        httpCode = String(resp.status);
        bodyText = await resp.text();
      } catch (e) {
        httpCode = "000"; // fetch failed outright: bin/llm's `|| http_code="000"`.
        bodyText = "";
        // curl exit 28 (--max-time) is what bin/llm reports as "timed out".
        timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      }

      // Transient: network failure, timeout, rate limit, server error.
      if (/^(000|408|429|5[0-9][0-9])$/.test(httpCode) && attempt < maxAttempts) {
        stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): HTTP ${httpCode} — retrying\n`);
        await sleep(backoffS * attempt * 1000);
        continue;
      }

      // A 2xx can still carry an embedded failure; nothing has been read
      // back as an answer yet, so retrying is safe.
      if (httpCode !== "000" && Number(httpCode) < 400) {
        let embedded: string;
        let emptyEmission = false;
        if (/[^ \t\n\v\f\r]/.test(bodyText)) {
          const p = parseJson(bodyText);
          if (!p.ok) {
            const msg = `API error: response body is not JSON (HTTP ${httpCode})`;
            stderr(`llm: error: ${msg}\n`);
            throw fail(msg);
          }
          if (responseShapeErrorOpenAI(p.value)) {
            const msg = `API error: response shape is not readable (HTTP ${httpCode})`;
            stderr(`llm: error: ${msg}\n`);
            throw fail(msg);
          }
          if (isTruncatedOpenAI(p.value)) {
            truncatedSeen = true;
            stderr(
              `llm: warning: output truncated at max_tokens=${maxTokens ?? ""} (reasoning tokens count against it) — raise with -t\n`
            );
          }
          embedded = checkResponseOpenAI(p.value);
          // PORT-NOTE (bug #53b, bin/llm:1400-1421): bin/llm's streaming path
          // retries a clean (rc 0) pass that emitted nothing — for the
          // OpenAI family, stream_openai's mark_emitted fires ONLY on a
          // non-empty `.choices[0].delta.content` chunk (it never reads a
          // reasoning/thinking delta at all), so a reasoning-only stream
          // still counts as nothing emitted and retries just like a fully
          // empty one. This client's wire path is non-streaming, so the
          // same condition translates to: a sound 2xx JSON body, no embedded
          // failure (checked above), yet the final
          // `.choices[0].message.content` is empty/absent — regardless of
          // any reasoning text alongside it.
          if (embedded === "" && (extractTextOpenAI(p.value) ?? "") === "") emptyEmission = true;
        } else {
          embedded = "whitespace-only response body";
        }
        if (embedded !== "") {
          if (attempt < maxAttempts) {
            stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${embedded} — retrying\n`);
            await sleep(backoffS * attempt * 1000);
            continue;
          }
          const msg = `API error: ${embedded}`;
          stderr(`llm: error: ${msg}\n`);
          throw fail(msg);
        }
        if (emptyEmission) {
          // Terminal text matches bin/llm's `die "$_retry_msg"` VERBATIM —
          // unlike the embedded-failure dies above, upstream does not
          // prefix this one with "API error:".
          const msg = "empty response: stream ended without emitting anything";
          if (attempt < maxAttempts) {
            stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${msg} — retrying\n`);
            await sleep(backoffS * attempt * 1000);
            continue;
          }
          stderr(`llm: error: ${msg}\n`);
          throw fail(msg);
        }
      }
      break;
    }

    if (Number(httpCode) >= 400 || httpCode === "000") {
      const p = parseJson(bodyText);
      const errMsg = p.ok ? errorMessageOf(p.value) : "";
      const msg = errMsg !== "" ? `API error (HTTP ${httpCode}): ${errMsg}` : `API error (HTTP ${httpCode})`;
      stderr(`llm: error: ${msg}\n`);
      throw fail(msg);
    }

    const p = parseJson(bodyText);
    const json = p.ok ? p.value : null;
    const text = json !== null ? (extractTextOpenAI(json) ?? "") : "";
    const reasoning = json !== null ? (extractReasoningOpenAI(json) ?? "") : "";
    const usage: LlmUsage = {};
    if (json !== null) {
      const u = usageOpenAI(json);
      if (u.ok) {
        if (u.rec.in_tok !== undefined) usage.in_tok = u.rec.in_tok;
        if (u.rec.out_tok !== undefined) usage.out_tok = u.rec.out_tok;
        if (u.rec.think_tok !== undefined) usage.think_tok = u.rec.think_tok;
        if (u.rec.cache_tok !== undefined) usage.cache_tok = u.rec.cache_tok;
      }
      const sb = jqGet(json, ["provider"]);
      if (!sb.err && typeof sb.value === "string" && sb.value !== "") usage.served_by = sb.value;
      if (truncatedSeen) usage.truncated = true;
    }
    return { text, ...(reasoning ? { reasoning } : {}), usage };
  }
}
