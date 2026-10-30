// test/live-fault-proxy.test.ts — pure-function coverage for
// parity/live/fault-proxy.mjs's fault-selection queue (popFault/pushFault)
// and its response-header sanitizer (forwardHeaders). No HTTP server, no
// network — those are exercised only by the real 12/30-minute runs, per
// PROOF-CAMPAIGN.md's harness-only constraint.

import { describe, it, expect } from "vitest";
import { popFault, pushFault, forwardHeaders, normalizeDoubledChatCompletionsSuffix, STALL_MS, TRUNCATE_BYTE_CAP } from "../parity/live/fault-proxy.mjs";

describe("pushFault / popFault — FIFO fault queue", () => {
  it("an empty queue never faults", () => {
    expect(popFault([])).toEqual({ fault: null, queue: [] });
  });

  it("consumes one unit off the front entry per call, in arrival order", () => {
    let queue = pushFault([], "500", 2);
    let r = popFault(queue);
    expect(r.fault).toBe("500");
    queue = r.queue;
    r = popFault(queue);
    expect(r.fault).toBe("500");
    queue = r.queue;
    r = popFault(queue);
    expect(r.fault).toBeNull(); // exhausted
    expect(r.queue).toEqual([]);
  });

  it("moves to the next queued fault once the front is exhausted, preserving arrival order", () => {
    let queue = pushFault([], "429", 1);
    queue = pushFault(queue, "truncated", 2);
    let r = popFault(queue); // consumes the 429
    expect(r.fault).toBe("429");
    r = popFault(r.queue); // 429 now exhausted -> falls through to truncated
    expect(r.fault).toBe("truncated");
    r = popFault(r.queue);
    expect(r.fault).toBe("truncated");
    r = popFault(r.queue);
    expect(r.fault).toBeNull();
  });

  it("does not mutate its input queue (pure)", () => {
    const queue = pushFault([], "stall", 1);
    const frozen = JSON.parse(JSON.stringify(queue));
    popFault(queue);
    expect(queue).toEqual(frozen);
  });

  it("a second queueFault for the same type while one is pending appends rather than replacing (documented interleaving — see fault-proxy.mjs header)", () => {
    let queue = pushFault([], "500", 1);
    queue = pushFault(queue, "500", 1);
    expect(queue).toEqual([
      { type: "500", remaining: 1 },
      { type: "500", remaining: 1 },
    ]);
  });

  it("STALL_MS is a full minute, matching the documented 60s stall fault", () => {
    expect(STALL_MS).toBe(60_000);
  });
});

describe("forwardHeaders — the truncated-fault path's header sanitizer", () => {
  // Two real-run findings shaped this function's evolution (see
  // fault-proxy.mjs's header for the full account):
  //  1. First finding: buffering the whole response and re-sending it with a
  //     fresh content-length while also relaying upstream's OWN
  //     transfer-encoding: chunked produced a response carrying both headers
  //     — invalid per RFC 7230 §3.3.3, and exactly what made curl (orig) and
  //     fetch (port) both stall/timeout identically.
  //  2. Second finding: buffering ALSO starves a `curl -N`-with-speed-limit
  //     client of live bytes regardless of header correctness (bin/llm sets
  //     --speed-limit 100 --speed-time 60), so the plain pass-through path
  //     was rewritten to stream (pipe upstream's response straight through,
  //     headers untouched — no forwardHeaders call at all, see
  //     createFaultProxy). forwardHeaders now backs ONLY the `truncated`
  //     fault, which deliberately sends fewer bytes than upstream declared
  //     and so can never honestly forward either length-signaling header.
  it("drops both content-length and transfer-encoding — neither can describe a deliberately cut body", () => {
    const headers = forwardHeaders({ "content-length": "999", "transfer-encoding": "chunked", "content-type": "application/json" });
    expect(headers).toEqual({ "content-type": "application/json" });
    expect(headers).not.toHaveProperty("content-length");
    expect(headers).not.toHaveProperty("transfer-encoding");
  });

  it("is a no-op on headers that carry neither (nothing to break)", () => {
    expect(forwardHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json" });
  });

  it("does not mutate its input headers object (pure)", () => {
    const upstream = { "content-length": "5", "transfer-encoding": "chunked" };
    const frozen = { ...upstream };
    forwardHeaders(upstream);
    expect(upstream).toEqual(frozen);
  });
});

describe("normalizeDoubledChatCompletionsSuffix — real-run finding", () => {
  // 4th real-run finding: src/steprun.ts's buildLlmClient treats LLM_API_URL
  // as a BASE url and appends /chat/completions itself (src/llm.ts's
  // OpenRouterClient.complete), while bin/llm and its faithful port
  // src/llmCli.ts both treat the SAME env var as the full endpoint already
  // (matching this proxy's own url(), which IS the full endpoint) — an
  // inconsistency BETWEEN the port's own two LLM_API_URL consumers, not
  // something this harness fixes. Every real port wake in the 4th run's
  // first attempt 404'd with a doubled path until this normalization was
  // added — a real, reported, unfixed port finding (see fault-proxy.mjs's
  // own doc comment on this function, and the campaign report).
  it("collapses a doubled trailing /chat/completions to one", () => {
    expect(normalizeDoubledChatCompletionsSuffix("/api/v1/chat/completions/chat/completions")).toBe("/api/v1/chat/completions");
  });

  it("leaves a normal single-suffix path untouched", () => {
    expect(normalizeDoubledChatCompletionsSuffix("/api/v1/chat/completions")).toBe("/api/v1/chat/completions");
  });

  it("leaves an unrelated path untouched", () => {
    expect(normalizeDoubledChatCompletionsSuffix("/api/v1/models")).toBe("/api/v1/models");
  });

  it("handles null/undefined without throwing", () => {
    expect(normalizeDoubledChatCompletionsSuffix(undefined)).toBeUndefined();
  });
});

describe("TRUNCATE_BYTE_CAP", () => {
  it("is a small, positive byte count — enough to look like real content, clearly incomplete", () => {
    expect(TRUNCATE_BYTE_CAP).toBeGreaterThan(0);
    expect(TRUNCATE_BYTE_CAP).toBeLessThan(2000);
  });
});
