// behavioralParityW1.test.ts — W1 of the behavioral parity round: monolith and responder model calls go through `llm`
// like upstream's (bin/shellm:1737-1745 call_llm, thinkers/responder/step:57-66 _reply_llm), so the wire request is
// `llm`'s: streaming, max_tokens, no `reasoning` field. The byte-level comparison against the real bin/llm is
// parity/behavioral/run-parity.mjs.
import { describe, it, expect } from "vitest";
import { buildLlmClient } from "../src/steprun.ts";
import { startFakeServer } from "./llmFakeServer.ts";
import { recordedModel, recordedText } from "./support/recordedModel.ts";

// The endpoint answers with the recorded real stream of steprun/plain-hello (test/support/README.md); this server is
// used because it records each request's body, which is what W1 checks.
const rec = recordedModel("steprun", "plain-hello");
const RECORDED = rec.recording.calls[0]!;
rec.close();
const SSE = RECORDED.response.body;
const RECORDED_OUT_TOK = (RECORDED.usage as { completion_tokens?: number } | undefined)?.completion_tokens;

describe("W1: request shape", () => {
  it("monolith (shellm) call: stream, max_tokens, include_usage, NO reasoning field; messages [system, …turns]", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ sse: true, body: SSE }]);
      const client = buildLlmClient({ OPENROUTER_API_KEY: "k", LLM_API_URL: srv.url, SHELLM_MODEL: "vendor/model" }, "monolith");
      const r = await client.complete("SYS", [{ role: "user", content: "task" }]);
      expect(r.text).toBe(recordedText(RECORDED));
      expect(RECORDED_OUT_TOK).toBeGreaterThan(0);
      expect(r.usage?.out_tok).toBe(RECORDED_OUT_TOK);
      const body = srv.requests[0]!.json as Record<string, unknown>;
      expect(body["stream"]).toBe(true);
      expect(body["stream_options"]).toEqual({ include_usage: true });
      expect(body["max_tokens"]).toBe(16384);
      expect("reasoning" in body).toBe(false);
      expect(body["messages"]).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "task" }]);
    } finally {
      await srv.close();
    }
  });

  it("responder call: -t from RESPONDER_MAX_TOKENS (per call), LLM_RETRIES=0, no reasoning, json_schema when given", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ sse: true, body: SSE }]);
      const client = buildLlmClient({ OPENROUTER_API_KEY: "k", LLM_API_URL: srv.url, SHELLM_MODEL: "vendor/model" }, "responder");
      await client.complete("SYS", [{ role: "user", content: "hi" }], { maxTokens: 8192, retries: 0, maxTimeMs: 60_000, jsonSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false } });
      const body = srv.requests[0]!.json as Record<string, unknown>;
      expect(body["stream"]).toBe(true);
      expect(body["max_tokens"]).toBe(8192);
      expect("reasoning" in body).toBe(false);
      expect(body["response_format"]).toBeTruthy();
    } finally {
      await srv.close();
    }
  });
});
