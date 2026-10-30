// modelHttpFixture.ts — a local OpenAI-compatible HTTP server for tests, and the engine's real HTTP client pointed at it.
//
// There is no fake model in src/: a test that needs model output starts this server with the replies it needs and
// hands the engine a real `OpenRouterClient` whose `url` is the server (the LLM_API_URL path). The request goes over
// real HTTP, the reply is parsed by the same reader production uses (src/llmProvider.ts). This mirrors upstream's own
// tests, which put a curl stub on PATH that serves canned responses (tests/test_llm_retry.sh).
//
// What a reply's text is: see test/support/README.md. Golden-trace tests serve text derived from real upstream runs
// (golden/, deepseek/deepseek-v4-flash-0731, 2026-08-28); most unit tests serve short hand-written fixture replies
// that pin one engine behaviour (a FINAL block, a failing command). Transport tests (HTTP 500, timeouts, malformed
// JSON) are HTTP fixtures, not model output.
import * as http from "node:http";
import { OpenRouterClient, type ChatMessage, type LlmClient, type LlmResponse } from "../../src/llm.js";

/** One fixture reply: model output to serve, or a raw HTTP response (status + body) for transport tests. */
export type FixtureReply = LlmResponse | { status: number; body: string };

export interface FixtureRequest {
  system: string;
  messages: ChatMessage[];
  body: Record<string, unknown>;
}

export interface HttpModel extends LlmClient {
  /** Every request the server received, in order. */
  readonly requests: FixtureRequest[];
  /** Replies not yet served. */
  readonly remaining: number;
  readonly url: string;
  close(): void;
}

function wire(r: LlmResponse): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: r.text };
  if (r.reasoning) message["reasoning"] = r.reasoning;
  const out: Record<string, unknown> = { choices: [{ index: 0, message, finish_reason: r.usage?.truncated ? "length" : "stop" }] };
  const u = r.usage;
  if (u && (u.in_tok !== undefined || u.out_tok !== undefined || u.think_tok !== undefined || u.cache_tok !== undefined)) {
    const usage: Record<string, unknown> = {};
    if (u.in_tok !== undefined) usage["prompt_tokens"] = u.in_tok;
    if (u.out_tok !== undefined) usage["completion_tokens"] = u.out_tok;
    if (u.think_tok !== undefined) usage["completion_tokens_details"] = { reasoning_tokens: u.think_tok };
    if (u.cache_tok !== undefined) usage["prompt_tokens_details"] = { cached_tokens: u.cache_tok };
    out["usage"] = usage;
  }
  if (u?.served_by) out["provider"] = u.served_by;
  return out;
}

/**
 * Start a fixture server that serves `replies` in order (one per request), or computes each reply with a function.
 * The server is unref'd and never keeps a test process alive. Past the last reply it answers HTTP 500 (the client then fails the call, as a provider
 * outage would).
 */
export function httpModel(replies: FixtureReply[] | ((req: FixtureRequest, n: number) => FixtureReply | Promise<FixtureReply>)): HttpModel {
  const queue = Array.isArray(replies) ? [...replies] : null;
  const requests: FixtureRequest[] = [];
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
      const all = (Array.isArray(body["messages"]) ? body["messages"] : []) as ChatMessage[];
      const fr: FixtureRequest = {
        system: all[0]?.role === "system" ? all[0].content : "",
        messages: all[0]?.role === "system" ? all.slice(1) : all,
        body,
      };
      requests.push(fr);
      let reply: FixtureReply | undefined;
      try {
        reply = queue ? queue.shift() : await (replies as (r: FixtureRequest, n: number) => FixtureReply | Promise<FixtureReply>)(fr, requests.length);
      } catch (e) {
        reply = { status: 500, body: JSON.stringify({ error: { message: String((e as Error).message ?? e) } }) };
      }
      if (reply === undefined) {
        reply = { status: 500, body: JSON.stringify({ error: { message: `model HTTP fixture: no reply left (served ${requests.length - 1})` } }) };
      }
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire(reply)));
      }
    });
  });
  server.unref();
  // Bound lazily: the first call waits for the socket, so the fixture can still be built inline in a synchronous spot.
  let urlValue = "";
  const ready: Promise<OpenRouterClient> = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("model HTTP fixture: no port"));
      urlValue = `http://127.0.0.1:${addr.port}/v1/chat/completions`;
      resolve(new OpenRouterClient({ apiKey: "http-fixture-not-a-key", baseUrl: "", url: urlValue, model: "fixture/model", retries: 0, stderr: () => {} }));
    });
  });
  ready.catch(() => {});
  return {
    complete: async (system, messages, opts) => (await ready).complete(system, messages, opts),
    requests,
    get remaining() {
      return queue ? queue.length : 0;
    },
    get url() {
      return urlValue;
    },
    close: () => server.close(),
  };
}
