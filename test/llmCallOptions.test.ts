// llmCallOptions.test.ts — the per-call limits thinkers/responder/step sets on
// bin/llm (sync 2e39a3f `_reply_llm`): `-t` max_tokens, LLM_MAX_TIME,
// LLM_RETRIES=0, `--json-schema`, and the usage facts it reads back
// (served_by, truncated). OpenRouterClient.complete(system, messages, opts).

import { describe, it, expect } from "vitest";
import { OpenRouterClient, LlmCallError, type LlmClient } from "../src/llm.js";
import { startFakeServer } from "./llmFakeServer.js";
import { httpModel } from "./support/modelHttpFixture.js";
import { recordedModel, recordedText } from "./support/recordedModel.ts";

const noSleep = async (): Promise<void> => {};
// Wire-format fixtures (not model output): okBody builds a provider's non-streamed JSON envelope around placeholder
// text ("hello", "partial", "thinking...") so these cases can pin the client's request body, provider/usage fields
// and finish_reason handling; no assertion depends on the wording.
const okBody = (extra: Record<string, unknown> = {}, message: Record<string, unknown> = { content: "hello" }, finish = "stop"): string =>
  JSON.stringify({
    choices: [{ message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
    ...extra,
  });

function client(url: string, stderr: (s: string) => void = () => {}, extra: Record<string, unknown> = {}): OpenRouterClient {
  return new OpenRouterClient({ apiKey: "k", baseUrl: "http://unused.invalid", url, model: "deepseek/x", sleep: noSleep, stderr, ...extra });
}

describe("OpenRouterClient per-call options", () => {
  it("maxTokens overrides the configured cap; jsonSchema becomes a strict json_schema response_format", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ body: okBody() }]);
      const schema = { type: "object", properties: { a: { type: "string" } } };
      await client(srv.url, undefined, { maxTokens: 100 }).complete("s", [{ role: "user", content: "hi" }], { maxTokens: 8192, jsonSchema: schema });
      const body = srv.requests[0]!.json as Record<string, unknown>;
      expect(body["max_tokens"]).toBe(8192);
      expect(body["response_format"]).toEqual({ type: "json_schema", json_schema: { name: "response", strict: true, schema } });
    } finally {
      await srv.close();
    }
  });

  it("without options the request is unchanged (configured max_tokens, no response_format)", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ body: okBody() }]);
      await client(srv.url, undefined, { maxTokens: 100 }).complete("s", [{ role: "user", content: "hi" }]);
      const body = srv.requests[0]!.json as Record<string, unknown>;
      expect(body["max_tokens"]).toBe(100);
      expect("response_format" in body).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("retries:0 makes one attempt even though the client default would retry", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ status: 500, body: "{}" }]);
      const lines: string[] = [];
      const p = client(srv.url, (s) => lines.push(s)).complete("s", [{ role: "user", content: "hi" }], { retries: 0 });
      await expect(p).rejects.toThrow(/API error \(HTTP 500\)/);
      expect(srv.requests.length).toBe(1);
      expect(lines.join("")).not.toMatch(/transient/);
    } finally {
      await srv.close();
    }
  });

  it("a call that outlives maxTimeMs fails with LlmCallError.timedOut", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ hang: true }]);
      const err = await client(srv.url).complete("s", [{ role: "user", content: "hi" }], { maxTimeMs: 150, retries: 0 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmCallError);
      expect((err as LlmCallError).timedOut).toBe(true);
      expect((err as LlmCallError).truncated).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("served_by (OpenRouter's upstream host) and think_tok ride the usage record", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ body: okBody({ provider: "DeepInfra" }) }]);
      const r = await client(srv.url).complete("s", [{ role: "user", content: "hi" }]);
      expect(r.usage).toMatchObject({ in_tok: 10, out_tok: 5, think_tok: 2, served_by: "DeepInfra" });
      expect(r.usage?.truncated).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("finish_reason=length with text: the response is returned, usage.truncated is set, the warning is written", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ body: okBody({}, { content: "partial" }, "length") }]);
      const lines: string[] = [];
      const r = await client(srv.url, (s) => lines.push(s)).complete("s", [{ role: "user", content: "hi" }], { maxTokens: 64 });
      expect(r.text).toBe("partial");
      expect(r.usage?.truncated).toBe(true);
      expect(lines.join("")).toContain("output truncated at max_tokens=64");
    } finally {
      await srv.close();
    }
  });

  it("finish_reason=length with nothing visible: LlmCallError.truncated", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([{ body: okBody({}, { content: "", reasoning: "thinking..." }, "length") }]);
      const err = await client(srv.url).complete("s", [{ role: "user", content: "hi" }], { retries: 0 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmCallError);
      expect((err as LlmCallError).truncated).toBe(true);
      expect((err as LlmCallError).timedOut).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

describe("model HTTP fixture", () => {
  it("serves its reply whatever per-call options the caller passes", async () => {
    // The reply is the recorded real DeepSeek text of monolith/quiet-idle (test/support/README.md).
    const rec = recordedModel("monolith", "quiet-idle");
    const text = recordedText(rec.recording.calls[0]!);
    rec.close();
    expect(text).toContain('FINAL="idle"');
    const c: LlmClient = httpModel([{ text }]);
    expect((await c.complete("s", [], { maxTokens: 1, maxTimeMs: 5000, retries: 0, jsonSchema: {} })).text).toBe(text);
  });
});
