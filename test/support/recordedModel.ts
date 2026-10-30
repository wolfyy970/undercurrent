// recordedModel.ts — recorded real model output for tests, served over the real LLM_API_URL path.
//
// A test asks for `recordedModel(suite, scenario)`. It gets an LlmClient that is the engine's production client
// (LlmCliClient: the port's `llm`, streaming, provider openai-compatible, the way an embedding app runs DeepSeek) pointed
// at a local HTTP server.
//
// - Replay (default): the server answers the Nth request with the Nth recorded response from
//   test/fixtures/recordings/<suite>/<scenario>.json, byte for byte. A request past the end, or a missing file, is a
//   MISS: the server answers HTTP 400 "recording miss …" (terminal, never retried) and `verify()` throws.
// - Record (UC_RECORD=1, optionally UC_RECORD_ONLY=<regex on "suite/scenario">): the server forwards each request to
//   the real provider (UC_RECORD_URL, default DeepSeek's chat/completions) with the key from DEEPSEEK_API_KEY added on
//   the way out (never stored, never printed), returns the real response, and saves request + response with model,
//   date and source labels. A recorded call's usage and an upper-bound cost estimate go to the file too.
//
// Nothing here writes model text: every response body in a recording came back from the provider.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LlmCliClient } from "../../src/llmCliClient.ts";
import type { ChatMessage, CompleteOptions, LlmClient, LlmResponse } from "../../src/llm.ts";

export const RECORDINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "recordings");
export const RECORD_MODEL = process.env["UC_RECORD_MODEL"] || "deepseek-flash";
const RECORD_URLS = {
  openai: process.env["UC_RECORD_URL"] || "https://api.deepseek.com/chat/completions",
  anthropic: process.env["UC_RECORD_ANTHROPIC_URL"] || "https://api.deepseek.com/anthropic/v1/messages",
};
// Upper-bound USD per token used for the spend estimate (DeepSeek list prices are lower).
const USD_IN_MISS = 0.3e-6, USD_IN_HIT = 0.03e-6, USD_OUT = 1.3e-6;

export interface RecordedCall {
  request: Record<string, unknown>;
  response: { status: number; content_type: string; body: string };
  usage?: Record<string, unknown>;
  usd_upper_bound?: number;
}
export interface Recording {
  source: string;
  provider_url: string;
  model: string;
  recorded_at: string;
  suite: string;
  scenario: string;
  calls: RecordedCall[];
}

export interface RecordedModel extends LlmClient {
  readonly url: string;
  /** Parsed JSON body of every request the engine sent, in order. */
  readonly requests: Record<string, unknown>[];
  /** The recording being served (or being written, in record mode). */
  readonly recording: Recording;
  readonly misses: string[];
  /** What the client returned to the engine for each call (text, reasoning, usage). */
  readonly responses: LlmResponse[];
  /** Resolves once the replay/record server is listening (`url` is set). */
  readonly ready: Promise<void>;
  /** Throws when any request missed its recording. */
  verify(): void;
  close(): void;
}

export interface RecordedModelOptions {
  mode?: "shellm" | "plain";
  maxTokens?: number;
  effort?: string;
  stopAfterCodeBlock?: boolean;
  /** Wire format: "openai" (production: openai-compatible) or "anthropic" (DeepSeek's Anthropic-format endpoint,
   *  the only wire where a thinking-only answer reaches shellm as an empty reply). */
  wire?: "openai" | "anthropic";
  /** Per-call `-t` (call index → max tokens), overriding `maxTokens`; lets one scenario record a budget-starved
   *  call followed by a normal one. */
  maxTokensByCall?: number[];
  /** HTTP fixtures served for the given call indexes INSTEAD of a recording (transport only: e.g. an empty stream
   *  with no content at all, which no model can be asked to produce). Recorded calls fill the other indexes. */
  httpFixtures?: Record<number, { status: number; content_type: string; body: string; /** hold the response this long (a slow provider) */ delayMs?: number }>;
  /** Extra env for the `llm` call (e.g. LLM_RETRIES). */
  env?: Record<string, string>;
  /** Replay only: serve the recording's calls round-robin (call n gets calls[n % length]) instead of missing past
   *  the end. For tests that count calls and need one real reply per call, not a reply to each call's own input. */
  cycle?: boolean;
  /** Replay only: hold each recorded response this long before answering (a slow provider, for timing tests). */
  delayMs?: number;
  /** Replay only: route each request to the next unserved recorded call with the same key (e.g. "summary" vs "turn"),
   *  instead of by arrival order. For runs whose calls race (shellm's async run summary beside the first turn). */
  route?: (request: Record<string, unknown>) => string;
  /** Record only: a tighter per-scenario call cap than UC_RECORD_MAX_CALLS (the lower of the two applies). */
  recordMaxCalls?: number;
}

function recordingPath(suite: string, scenario: string): string {
  return path.join(RECORDINGS_DIR, suite, `${scenario}.json`);
}

/** Scenarios named `transport-*` are HTTP-fixture-only: never recorded, every non-fixture request is a miss. */
function recordMode(suite: string, scenario: string): boolean {
  if (process.env["UC_RECORD"] !== "1" || scenario.startsWith("transport-")) return false;
  const only = process.env["UC_RECORD_ONLY"];
  return !only || new RegExp(only).test(`${suite}/${scenario}`);
}

function usageOf(body: string): Record<string, unknown> | undefined {
  let usage: Record<string, unknown> | undefined;
  for (const line of body.split("\n")) {
    const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } };
      for (const u of [j.message?.usage, j.usage]) if (u && typeof u === "object") usage = { ...(usage ?? {}), ...u };
    } catch {
      /* not JSON */
    }
  }
  return usage;
}

function usdUpperBound(u: Record<string, unknown> | undefined): number {
  if (!u) return 0;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const hit = n("prompt_cache_hit_tokens");
  const prompt = n("prompt_tokens") + n("input_tokens");
  const miss = u["prompt_cache_miss_tokens"] !== undefined ? n("prompt_cache_miss_tokens") : prompt - hit;
  return miss * USD_IN_MISS + hit * USD_IN_HIT + (n("completion_tokens") + n("output_tokens")) * USD_OUT;
}

export function recordedModel(suite: string, scenario: string, o: RecordedModelOptions = {}): RecordedModel {
  const file = recordingPath(suite, scenario);
  const wire = o.wire ?? "openai";
  const RECORD_URL = RECORD_URLS[wire];
  const responses: LlmResponse[] = [];
  const recording_ = recordMode(suite, scenario);
  let recording: Recording;
  if (recording_) {
    recording = {
      source: "recorded: real provider response, test/support/recordedModel.ts record mode",
      provider_url: RECORD_URL,
      model: RECORD_MODEL,
      recorded_at: new Date().toISOString(),
      suite,
      scenario,
      calls: [],
    };
  } else if (fs.existsSync(file)) {
    recording = JSON.parse(fs.readFileSync(file, "utf8")) as Recording;
  } else {
    recording = { source: "MISSING", provider_url: "", model: RECORD_MODEL, recorded_at: "", suite, scenario, calls: [] };
  }
  const requests: Record<string, unknown>[] = [];
  const misses: string[] = [];
  const served = new Set<number>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", async () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      const reqIndex = requests.length;
      requests.push(body);
      const fx = o.httpFixtures?.[reqIndex];
      if (fx) {
        if (fx.delayMs) await new Promise((r) => setTimeout(r, fx.delayMs).unref());
        if (res.destroyed) return;
        res.writeHead(fx.status, { "content-type": fx.content_type });
        return res.end(fx.body);
      }
      const n = reqIndex - Object.keys(o.httpFixtures ?? {}).filter((k) => Number(k) < reqIndex).length;
      if (recording_) {
        // Record guard: a scenario stops recording past UC_RECORD_MAX_CALLS calls (default 8) or UC_RECORD_MAX_USD
        // (default 0.008); and nothing records once the ledger's total passes UC_RECORD_LEDGER_CAP_USD (if set).
        const maxCalls = Math.min(Number(process.env["UC_RECORD_MAX_CALLS"] || "8"), o.recordMaxCalls ?? Infinity);
        const maxUsd = Number(process.env["UC_RECORD_MAX_USD"] || "0.008");
        const spent = recording.calls.reduce((t, c) => t + (c.usd_upper_bound ?? 0), 0);
        let ledgerTotal = 0;
        const ledgerCap = process.env["UC_RECORD_LEDGER_CAP_USD"];
        if (ledgerCap && process.env["UC_RECORD_LEDGER"] && fs.existsSync(process.env["UC_RECORD_LEDGER"])) {
          for (const l of fs.readFileSync(process.env["UC_RECORD_LEDGER"], "utf8").split("\n")) {
            try {
              ledgerTotal += (JSON.parse(l) as { usd?: number }).usd ?? 0;
            } catch {
              /* blank */
            }
          }
        }
        if (recording.calls.length >= maxCalls || spent >= maxUsd || (ledgerCap !== undefined && ledgerTotal >= Number(ledgerCap))) {
          misses.push(`record guard: ${suite}/${scenario} stopped at ${recording.calls.length} calls, $${spent.toFixed(4)} (ledger $${ledgerTotal.toFixed(4)})`);
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: misses[misses.length - 1] } }));
        }
        const key = process.env["DEEPSEEK_API_KEY"];
        if (!key) {
          misses.push(`record mode needs DEEPSEEK_API_KEY (${suite}/${scenario} call ${n + 1})`);
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: misses[misses.length - 1] } }));
        }
        try {
          const up = await fetch(RECORD_URL, {
            method: "POST",
            headers:
              wire === "anthropic"
                ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
                : { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: raw,
          });
          const text = await up.text();
          const ct = up.headers.get("content-type") ?? "application/json";
          const usage = usageOf(text);
          const call: RecordedCall = { request: body, response: { status: up.status, content_type: ct, body: text } };
          if (usage) call.usage = usage;
          call.usd_upper_bound = usdUpperBound(usage);
          recording.calls.push(call);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(recording, null, 1) + "\n");
          if (process.env["UC_RECORD_LEDGER"]) {
            fs.appendFileSync(process.env["UC_RECORD_LEDGER"], JSON.stringify({ t: new Date().toISOString(), tag: `uc-rec:${suite}/${scenario}#${n + 1}`, usd: call.usd_upper_bound, usage }) + "\n");
          }
          res.writeHead(up.status, { "content-type": ct });
          return res.end(text);
        } catch (e) {
          misses.push(`record mode: provider call failed for ${suite}/${scenario} call ${n + 1}: ${(e as Error).message}`);
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: misses[misses.length - 1] } }));
        }
      }
      let call: RecordedCall | undefined = o.cycle && recording.calls.length > 0 ? recording.calls[n % recording.calls.length] : recording.calls[n];
      if (o.route) {
        const key = o.route(body);
        const i = recording.calls.findIndex((c, j) => !served.has(j) && o.route!(c.request) === key);
        if (i >= 0) served.add(i);
        call = i >= 0 ? recording.calls[i] : undefined;
      }
      if (!call) {
        const msg = `recording miss: ${path.relative(process.cwd(), file)} has ${recording.calls.length} call(s), request ${n + 1} has none (re-record with UC_RECORD=1)`;
        misses.push(msg);
        process.stderr.write(`recordedModel: ${msg}\n`);
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: msg } }));
      }
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      res.writeHead(call.response.status, { "content-type": call.response.content_type });
      res.end(call.response.body);
    });
  });
  server.unref();
  let urlValue = "";
  const clientFor = (n: number): LlmCliClient => {
    const mt = o.maxTokensByCall?.[n] ?? o.maxTokens;
    return new LlmCliClient({
      mode: o.mode ?? "shellm",
      model: RECORD_MODEL,
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
      ...(mt !== undefined ? { maxTokens: mt } : {}),
      ...(o.stopAfterCodeBlock !== undefined ? { stopAfterCodeBlock: o.stopAfterCodeBlock } : {}),
      env: {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        ...(wire === "anthropic"
          ? { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "replay-not-a-key", LLM_ASSUME_THINKING: "1" }
          : { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "replay-not-a-key" }),
        LLM_API_URL: urlValue,
        LLM_RETRY_BACKOFF: "0",
        ...(o.env ?? {}),
      },
    });
  };
  let callNo = 0;
  const ready: Promise<void> = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("recordedModel: no port"));
      urlValue = `http://127.0.0.1:${addr.port}/v1/chat/completions`;
      resolve();
    });
  });
  ready.catch(() => {});
  return {
    complete: async (system: string, messages: ChatMessage[], opts?: CompleteOptions): Promise<LlmResponse> =>
      {
        await ready;
        const r = await clientFor(callNo++).complete(system, messages, opts);
        responses.push(r);
        return r;
      },
    ready,
    requests,
    responses,
    misses,
    get recording() {
      return recording;
    },
    get url() {
      return urlValue;
    },
    verify() {
      if (misses.length > 0) throw new Error(misses.join("\n"));
    },
    close: () => server.close(),
  };
}

/** The visible text of one recorded response (OpenAI SSE or JSON, or Anthropic SSE). */
export function recordedText(call: RecordedCall): string {
  let txt = "";
  const b = call.response.body;
  if (!b.includes("data:")) {
    try {
      const j = JSON.parse(b) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }
  for (const line of b.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const j = JSON.parse(line.slice(5).trim()) as {
        choices?: { delta?: { content?: string | null } }[];
        type?: string;
        delta?: { text?: string };
      };
      for (const ch of j.choices ?? []) txt += ch.delta?.content ?? "";
      if (j.type === "content_block_delta") txt += j.delta?.text ?? "";
    } catch {
      /* [DONE] or not JSON */
    }
  }
  return txt;
}

/**
 * A recording served as an endpoint for code that makes its own `llm` calls from an env (runStep, a dispatched
 * thinker, a detached child): returns the model plus the env that points every such call at it. SHELLM_MODEL is
 * the recorded model, so record mode sends the provider a model name it serves.
 */
export async function recordedEndpoint(
  suite: string,
  scenario: string,
  o: RecordedModelOptions = {}
): Promise<{ model: RecordedModel; env: Record<string, string> }> {
  const model = recordedModel(suite, scenario, o);
  await model.ready;
  return {
    model,
    env: {
      LLM_PROVIDER: "openai-compatible",
      LLM_API_URL: model.url,
      LLM_API_KEY: "replay-not-a-key",
      LLM_RETRIES: "0",
      LLM_RETRY_BACKOFF: "0",
      SHELLM_MODEL: RECORD_MODEL,
    },
  };
}
