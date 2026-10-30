// llmFakeServer.ts — a scripted local HTTP server standing in for an
// OpenAI-compatible endpoint. Used by test/llmCli.test.ts (in-process) and by
// parity/llm/run-parity.mjs (both the real Bash `llm` and the port are pointed
// at it via LLM_API_URL). Deterministic, no network.
//
// Reply modes mirror the curl stub in headlong/tests/test_llm_retry.sh: one
// reply per request in order, the last one repeating.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export interface FakeReply {
  /** HTTP status; default 200. */
  status?: number;
  /** Content-Type; default text/event-stream when `sse`, else application/json. */
  contentType?: string;
  /** Marks an SSE reply (only affects the default content type). */
  sse?: boolean;
  /** Body written in one go (after `chunks`, if any). */
  body?: string;
  /** Body pieces written one at a time (each flushed). */
  chunks?: string[];
  /** Delay before the headers are sent. */
  delayMs?: number;
  /** Delay between chunks. */
  chunkDelayMs?: number;
  /** Destroy the socket after writing (mid-stream failure), instead of ending. */
  destroy?: boolean;
  /** Keep the response open forever (stall). */
  hang?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Parsed body, or null when not JSON. */
  json: unknown;
}

export interface FakeServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Install the reply script; request N gets replies[N] (last repeats). */
  script(replies: FakeReply[]): void;
  /** Install a chooser instead: it sees each recorded request (in arrival order) and picks its reply.
   *  For tests where separate processes (monolith, responder, notes writer) share one endpoint. */
  scriptBy(pick: (req: RecordedRequest) => FakeReply): void;
  /** Clear recorded requests and the request counter (keeps the script). */
  reset(): void;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startFakeServer(): Promise<FakeServer> {
  let replies: FakeReply[] = [{ sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' }];
  let n = 0;
  let pick: ((req: RecordedRequest) => FakeReply) | undefined;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on("data", (c: Buffer) => bodyChunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(bodyChunks).toString("utf8");
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const rec: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers, body, json };
      requests.push(rec);
      const reply = pick ? pick(rec) : (replies[Math.min(n, replies.length - 1)] ?? {});
      n += 1;
      void (async () => {
        if (reply.delayMs) await sleep(reply.delayMs);
        res.writeHead(reply.status ?? 200, {
          "Content-Type": reply.contentType ?? (reply.sse ? "text/event-stream" : "application/json"),
          "Cache-Control": "no-cache",
        });
        res.flushHeaders();
        for (const c of reply.chunks ?? []) {
          res.write(c);
          if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
        }
        if (reply.body !== undefined) res.write(reply.body);
        if (reply.hang) return;
        if (reply.destroy) {
          // Give the written bytes a tick to reach the wire, then cut the socket.
          await sleep(20);
          res.socket?.destroy();
          return;
        }
        res.end();
      })();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    port,
    requests,
    script(r) {
      replies = r;
      pick = undefined;
      n = 0;
    },
    scriptBy(p) {
      pick = p;
    },
    reset() {
      requests.length = 0;
      n = 0;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Reply fixtures (named as in tests/test_llm_retry.sh's curl-stub modes). Wire-format and transport fixtures with
// placeholder text ("ok", "echo hi", "MORE"): they pin the `llm` client's framing, retries and cuts, not model output.
// ---------------------------------------------------------------------------

export const R = {
  /** streamed success: one delta then [DONE] */
  sseOk: { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' } as FakeReply,
  /** streamed success carrying the trailing usage chunk */
  sseOkUsage: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}\n\ndata: [DONE]\n',
  } as FakeReply,
  /** streamed success carrying cache_tok (prompt_tokens_details.cached_tokens) */
  sseOkUsageCache: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3},"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n',
  } as FakeReply,
  /** non-streamed success carrying cache_tok */
  http200UsageCache: {
    body: '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":50,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":30}}}',
  } as FakeReply,
  /** streamed: one fenced bash block, then MORE text after it closes (the
   *  model kept writing) — LLM_STOP_AFTER_CODE_BLOCK cuts here; without the
   *  flag every delta (incl. "MORE") is emitted and read to the end. */
  sseCodeBlockThenMore: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"```bash\\n"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"echo hi\\n```"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"\\nMORE"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":9}}\n\ndata: [DONE]\n',
  } as FakeReply,
  /** streamed: the fenced block's closing ``` is heredoc-aware — a bare ```
   *  inside an open heredoc must NOT be mistaken for the close. */
  sseCodeBlockHeredoc: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"```bash\\ncat <<EOF\\n"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"```\\nstill inside\\nEOF\\n```"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"\\nMORE"}}]}\n\n' +
      "data: [DONE]\n",
  } as FakeReply,
  /** streamed: newline-only and CRLF deltas, a comment line, a data line without space */
  sseNewlines: {
    sse: true,
    body:
      ': keepalive\r\n' +
      'data: {"choices":[{"delta":{"content":"```bash"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"\\n"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"echo hi\\n```"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n",
  } as FakeReply,
  /** streamed OpenRouter success: every chunk names the upstream host, then usage */
  sseServedBy: {
    sse: true,
    body:
      'data: {"provider":"DeepInfra","choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"provider":"DeepInfra","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7}}\n\ndata: [DONE]\n',
  } as FakeReply,
  /** streamed OpenRouter output cut at the cap, with usage: truncated + served_by land in the record */
  sseServedByLength: {
    sse: true,
    body:
      'data: {"provider":"Fireworks","choices":[{"delta":{"content":"cut"}}]}\n\n' +
      'data: {"provider":"Fireworks","choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
      'data: {"provider":"Fireworks","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":64000}}\n\ndata: [DONE]\n',
  } as FakeReply,
  /** streamed: the provider content filter ended the stream with no content (a refusal) */
  sseContentFilter: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n' +
      "data: [DONE]\n",
  } as FakeReply,
  /** streamed: text first, THEN a content_filter finish — something was emitted, so not a refusal */
  sseTextThenContentFilter: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n' +
      "data: [DONE]\n",
  } as FakeReply,
  /** non-streamed OpenRouter success naming its host, with usage */
  http200ServedBy: {
    body: '{"provider":"Together","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":50,"completion_tokens":4}}',
  } as FakeReply,
  /** non-streamed: a non-string provider field is ignored */
  http200ProviderObject: {
    body: '{"provider":{"name":"x"},"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":50,"completion_tokens":4}}',
  } as FakeReply,
  /** non-streamed: cut at the cap with usage */
  http200LengthUsage: {
    body: '{"provider":"Together","choices":[{"message":{"content":"cut"},"finish_reason":"length"}],"usage":{"prompt_tokens":50,"completion_tokens":4}}',
  } as FakeReply,
  /** streamed output whose final chunk reports the cap */
  sseFinishLength: {
    sse: true,
    body:
      'data: {"choices":[{"delta":{"content":"truncated te"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
      "data: [DONE]\n",
  } as FakeReply,
  /** streamed: an unparseable event, then a good one */
  sseBadJsonEvent: { sse: true, body: 'data: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' } as FakeReply,
  /** `data:` without the space is not an SSE data line for this tool */
  sseNoSpace: { sse: true, body: 'data:{"choices":[{"delta":{"content":"nope"}}]}\ndata: [DONE]\n' } as FakeReply,
  /** streamed: partial text then the socket dies */
  sseMidstreamFail: { sse: true, chunks: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], destroy: true } as FakeReply,
  /** HTTP 200 with an error JSON body and no SSE data (OpenRouter style) — streaming form */
  errBodyStream: { sse: true, body: '{"error":{"message":"Provider returned error","code":502}}\n' } as FakeReply,
  /** same, non-streaming form */
  errBody: { body: '{"error":{"message":"Provider returned error","code":502}}' } as FakeReply,
  /** streaming: HTTP 200 whose body is a credit error, no SSE data */
  errBodyCreditStream: {
    sse: true,
    body: '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}\n',
  } as FakeReply,
  /** a 4xx with a JSON body on the streaming path (curl -sS does not fail on status) */
  http400Stream: { sse: true, status: 400, body: '{"error":{"message":"bad request"}}\n' } as FakeReply,
  /** HTTP 200 whose body is only whitespace keep-alive padding */
  wsBodyStream: { sse: true, body: "   \n\n  \n" } as FakeReply,
  wsBody: { body: "   \n\n  \n" } as FakeReply,
  /** HTTP 200 with a zero-byte body */
  emptyBodyStream: { sse: true, body: "" } as FakeReply,
  emptyBody: { body: "" } as FakeReply,
  http500: { status: 500, body: '{"error":{"message":"upstream exploded"}}' } as FakeReply,
  http402: {
    status: 402,
    body: '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
  } as FakeReply,
  http401: { status: 401, body: '{"error":{"message":"No auth credentials found","code":401}}' } as FakeReply,
  http429Quota: {
    status: 429,
    body: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":429}}',
  } as FakeReply,
  http400: { status: 400, body: '{"error":{"message":"bad request"}}' } as FakeReply,
  /** 403 whose body uses the top-level `.message` fallback */
  http403TopMessage: { status: 403, body: '{"message":"forbidden by policy"}' } as FakeReply,
  /** 500 whose body is not JSON */
  http500Html: { status: 500, contentType: "text/html", body: "<html>boom</html>" } as FakeReply,
  http200: { body: '{"choices":[{"message":{"content":"ok"}}]}' } as FakeReply,
  http200Usage: {
    body: '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":50,"completion_tokens":4}}',
  } as FakeReply,
  /** non-streaming multi-line answer */
  http200Multiline: { body: '{"choices":[{"message":{"content":"line1\\nline2\\n"}}]}' } as FakeReply,
  /** non-streaming: content missing (jq `// empty` prints nothing, not even a newline) */
  http200NoContent: { body: '{"choices":[{"message":{"role":"assistant"}}]}' } as FakeReply,
  /** non-streaming: HTTP 200, sound JSON, no embedded error, content is the
   *  empty string (bug #53b: nothing emitted, matching bin/llm's streaming
   *  "stream ended without emitting anything") */
  http200EmptyContent: { body: '{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}' } as FakeReply,
  /** non-streaming: HTTP 200, content empty but a full reasoning trace rode
   *  along — bin/llm's OpenAI-family stream handler never reads a reasoning
   *  delta, so this must still count as "nothing emitted" (bug #53b) */
  http200EmptyContentReasoning: {
    body: '{"choices":[{"message":{"content":"","reasoning":"thinking it over at length"},"finish_reason":"stop"}]}',
  } as FakeReply,
  /** non-streaming: 200 whose body is not JSON at all */
  http200NotJson: { contentType: "text/plain", body: "not json at all" } as FakeReply,
  /** HTTP 200, partial text, provider died mid-generation */
  finishError: { body: '{"choices":[{"message":{"content":"partial judgm"},"finish_reason":"error"}]}' } as FakeReply,
  /** HTTP 200, output capped by max_tokens */
  finishLength: { body: '{"choices":[{"message":{"content":"truncated tex"},"finish_reason":"length"}]}' } as FakeReply,
  /** HTTP 200 with a per-choice error */
  choiceError: { body: '{"choices":[{"message":{"content":""},"error":{"message":"choice failed"}}]}' } as FakeReply,
  /** headers only, then nothing ever (stall) */
  hang: { sse: true, hang: true } as FakeReply,
  /** one keepalive comment line, then nothing ever */
  hangKeepalive: { sse: true, chunks: [": keepalive\n"], hang: true } as FakeReply,
  /** slow to start (exceeds a 1s LLM_MAX_TIME) */
  slow: { body: '{"choices":[{"message":{"content":"late"}}]}', delayMs: 2500 } as FakeReply,

  // -- Anthropic wire shapes (anthropic, opencode/Zen) -----------------------
  /** Anthropic SSE: message_start (input_tokens) → content_block text delta → message_delta (stop_reason + output_tokens). */
  anthropicSseOk: {
    sse: true,
    body:
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":11}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
  } as FakeReply,
  /** Anthropic SSE carrying cache_read_input_tokens on message_start. */
  anthropicSseCache: {
    sse: true,
    body:
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":9}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  } as FakeReply,
  /** Anthropic non-streaming carrying cache_read_input_tokens. */
  anthropicJsonCache: {
    body:
      '{"type":"message","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",' +
      '"usage":{"input_tokens":11,"output_tokens":3,"cache_read_input_tokens":9}}',
  } as FakeReply,
  /** Anthropic SSE carrying a thinking block ahead of the text block. */
  anthropicSseThinking: {
    sse: true,
    body:
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'data: {"type":"content_block_stop","index":1}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
  } as FakeReply,
  /** Anthropic SSE whose output was capped. */
  anthropicSseMaxTokens: {
    sse: true,
    body:
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut off"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":12}}\n\n',
  } as FakeReply,
  /** Anthropic SSE: a mid-stream `type:"error"` event with nothing emitted yet. */
  anthropicSseTypeError: {
    sse: true,
    body: 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  } as FakeReply,
  /** Anthropic non-streaming success. */
  anthropicJsonOk: {
    body: '{"type":"message","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":3}}',
  } as FakeReply,
  /** Anthropic non-streaming error body (`.type == "error"`). */
  anthropicJsonError: { body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}' } as FakeReply,
  /** Anthropic non-streaming: truncated output. */
  anthropicJsonMaxTokens: {
    body: '{"type":"message","content":[{"type":"text","text":"cut off"}],"stop_reason":"max_tokens","usage":{"input_tokens":5,"output_tokens":12}}',
  } as FakeReply,

  // -- Gemini wire shapes ------------------------------------------------------
  /** Gemini SSE success with the trailing usageMetadata chunk. */
  geminiSseOk: {
    sse: true,
    body:
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n' +
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"thoughtsTokenCount":0}}\n\n',
  } as FakeReply,
  /** Gemini SSE carrying cachedContentTokenCount. */
  geminiSseCache: {
    sse: true,
    body:
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n' +
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":6}}\n\n',
  } as FakeReply,
  /** Gemini non-streaming carrying cachedContentTokenCount. */
  geminiJsonCache: {
    body:
      '{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],' +
      '"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"cachedContentTokenCount":6}}',
  } as FakeReply,
  /** Gemini SSE: output capped at maxOutputTokens. */
  geminiSseMaxTokens: {
    sse: true,
    body:
      'data: {"candidates":[{"content":{"parts":[{"text":"cut"}]},"finishReason":null}]}\n\n' +
      'data: {"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":30}}\n\n',
  } as FakeReply,
  /** Gemini non-streaming success. */
  geminiJsonOk: {
    body: '{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2}}',
  } as FakeReply,
  /** Gemini non-streaming error body (`.error.message`). */
  geminiJsonError: { body: '{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}' } as FakeReply,
  /** Gemini non-streaming: truncated output. */
  geminiJsonMaxTokens: {
    body: '{"candidates":[{"content":{"parts":[{"text":"cut"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":40}}',
  } as FakeReply,
};
