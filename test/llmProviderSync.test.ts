// llmProviderSync.test.ts — upstream sync 2e39a3f llm pieces: --json-schema
// payload, GLM/MiMo max-token tier, refusal/served_by hooks of the OpenAI SSE
// handler. Oracle: upstream's own tests/test_llm_json_schema.sh and the
// differential parity/llm/run-parity.mjs scenarios (jsonschema/*, usage2/*,
// refusal/*, maxtok/or-*) run against the real bin/llm.

import { describe, it, expect } from "vitest";
import {
  buildOpenAIPayload,
  buildAnthropicPayload,
  buildGeminiPayload,
  buildOpencodeZenPayload,
  createOpenAIStreamHandler,
  getModelMaxTokens,
} from "../src/llmProvider.ts";

const base = { model: "x", messages: [{ role: "user", content: "hi" }], system: "", stream: true, maxTokens: 10, thinkingLevel: "", assumeThinking: false };

describe("buildOpenAIPayload --json-schema", () => {
  it("absent without a schema", () => {
    expect(buildOpenAIPayload(base).payload).not.toHaveProperty("response_format");
  });
  it("response_format json_schema strict, appended last", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const { payload } = buildOpenAIPayload({ ...base, jsonSchema: schema });
    expect(payload["response_format"]).toEqual({ type: "json_schema", json_schema: { name: "response", strict: true, schema } });
    expect(Object.keys(payload).at(-1)).toBe("response_format");
  });
});

describe("--json-schema is ignored with a note on non-OpenAI providers", () => {
  const a = { model: "claude-sonnet-4-5", messages: [], system: "", stream: false, maxTokens: 1, thinking: false, effort: "", assumeThinking: false, jsonSchemaGiven: true };
  it("anthropic", () => {
    expect(buildAnthropicPayload(a).notes).toEqual(["llm: --json-schema ignored: not supported for provider anthropic (OpenAI-style providers only)"]);
  });
  it("opencode: the Zen note comes first, the schema note after (both name 'anthropic')", () => {
    const n = buildOpencodeZenPayload({ ...a, thinking: true }).notes;
    expect(n[0]).toMatch(/OpenCode Zen rejects/);
    expect(n[1]).toMatch(/--json-schema ignored: not supported for provider anthropic/);
  });
  it("gemini", () => {
    const n = buildGeminiPayload({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], system: "", maxTokens: 1, thinkingLevel: "", assumeThinking: false, jsonSchemaGiven: true }).notes;
    expect(n).toEqual(["llm: --json-schema ignored: not supported for provider gemini"]);
  });
});

describe("getModelMaxTokens: GLM 5.x and MiMo get 64000 on OpenRouter", () => {
  it.each([
    ["z-ai/glm-5.1", 64000],
    ["xiaomi/mimo-v2-pro", 64000],
    ["z-ai/glm-4.6", 16384],
    ["xiaomi/other", 16384],
  ])("%s → %d", (m, n) => {
    expect(getModelMaxTokens(m, "openrouter")).toBe(n);
  });
});

describe("createOpenAIStreamHandler: served_by and refusal hooks", () => {
  it("reports the provider string and a content_filter finish; ignores a non-string provider", () => {
    const seen: string[] = [];
    let refused = 0;
    const h = createOpenAIStreamHandler({
      text: () => {},
      truncated: () => {},
      usage: () => {},
      servedBy: (n) => seen.push(n),
      refused: () => (refused += 1),
    });
    h.line('data: {"provider":{"name":"x"},"choices":[{"delta":{}}]}');
    h.line('data: {"provider":"DeepInfra","choices":[{"delta":{}}]}');
    h.line('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}');
    expect(seen).toEqual(["DeepInfra"]);
    expect(refused).toBe(1);
  });
});
