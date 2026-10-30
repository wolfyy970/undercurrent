// llmRetry.test.ts — bug #53: OpenRouterClient.complete() (src/llm.ts), the
// in-process LLM call monolith/responder wakes make (src/steprun.ts
// buildLlmClient), had NO retry ladder — one transient failure (an empty or
// error-carrying response) surfaced immediately as an empty LlmResponse.text,
// which upstream's `bin/llm` would have retried (LLM_RETRIES, default 2 → 3
// attempts total; bin/llm:92,1351-1352,1424-1475 non-streaming path). This
// pins the SAME ladder — conditions, attempt count, backoff, stderr line, and
// terminal error text — on the port's non-streaming wire path, built from the
// SAME src/llmProvider.ts primitives src/llmCli.ts's runNonStreaming already
// uses (test/llmCli.test.ts pins the CLI side of the identical ladder).
// Replies: HTTP and wire-format fixtures from test/llmFakeServer.ts (`R.*`: 429/500s, whitespace or empty bodies,
// reasoning-only bodies, a placeholder "ok" success). They pin the retry ladder, not any model's wording; not model output.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenRouterClient } from "../src/llm.js";
import { startFakeServer, R } from "./llmFakeServer.js";
import { createTrajectory, type Trajectory } from "../src/trajectory.js";
import { runResponder, type ResponderTrigger } from "../src/responder.js";

const noSleep = async (): Promise<void> => {};

function client(url: string, opts: { retries?: number; stderr?: (s: string) => void } = {}): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "test-key",
    baseUrl: "http://unused.invalid",
    url,
    model: "openai/gpt-oss-120b",
    sleep: noSleep,
    ...opts,
  });
}

describe("OpenRouterClient.complete() retry ladder (bug #53, bin/llm:92,1351-1352,1424-1475)", () => {
  it("(a) whitespace-only 200 (nothing emitted) then a good one: one retry, success, exact stderr line", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.wsBody, R.http200]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      const resp = await c.complete("sys", [{ role: "user", content: "hi" }]);
      expect(resp.text).toBe("ok");
      expect(srv.requests.length).toBe(2);
      expect(lines).toEqual(["llm: transient API failure (attempt 1/3): whitespace-only response body — retrying\n"]);
    } finally {
      await srv.close();
    }
  });

  it("(b) 429 then 200: one retry, success", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http429Quota, R.http200]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      const resp = await c.complete("sys", [{ role: "user", content: "hi" }]);
      expect(resp.text).toBe("ok");
      expect(srv.requests.length).toBe(2);
      expect(lines).toEqual(["llm: transient API failure (attempt 1/3): HTTP 429 — retrying\n"]);
    } finally {
      await srv.close();
    }
  });

  it("(c) 500 x3 (default LLM_RETRIES=2, 3 attempts): terminal error with the exact upstream text", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http500, R.http500, R.http500]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      await expect(c.complete("sys", [{ role: "user", content: "hi" }])).rejects.toThrow("API error (HTTP 500): upstream exploded");
      expect(srv.requests.length).toBe(3);
      expect(lines).toEqual([
        "llm: transient API failure (attempt 1/3): HTTP 500 — retrying\n",
        "llm: transient API failure (attempt 2/3): HTTP 500 — retrying\n",
        "llm: error: API error (HTTP 500): upstream exploded\n",
      ]);
    } finally {
      await srv.close();
    }
  });

  it("(d) LLM_RETRIES=0 (retries:0): a single failed attempt is never retried", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http500, R.http200]); // a second reply is available but must never be reached
      const lines: string[] = [];
      const c = client(srv.url, { retries: 0, stderr: (s) => lines.push(s) });
      await expect(c.complete("sys", [{ role: "user", content: "hi" }])).rejects.toThrow("API error (HTTP 500): upstream exploded");
      expect(srv.requests.length).toBe(1);
      expect(lines).toEqual(["llm: error: API error (HTTP 500): upstream exploded\n"]);
    } finally {
      await srv.close();
    }
  });
});

// --- bug #53b: bin/llm's streaming path also retries a CLEAN (rc 0) pass
// that emitted nothing (bin/llm:1400-1421, "empty response: stream ended
// without emitting anything") — bug #53's ladder above only ported the
// transient-HTTP-code and embedded-JSON-error conditions, missing this one.
// OpenRouterClient's wire path is non-streaming, so the equivalent is a
// sound 2xx JSON body with no embedded failure whose
// `.choices[0].message.content` is empty/absent — see src/llm.ts's
// `emptyEmission` check. ---
describe("OpenRouterClient.complete() empty-emission retry (bug #53b, bin/llm:1400-1421)", () => {
  it("(a) sound 200 with empty content then a good one: one retry, success, exact stderr line", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http200EmptyContent, R.http200]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      const resp = await c.complete("sys", [{ role: "user", content: "hi" }]);
      expect(resp.text).toBe("ok");
      expect(srv.requests.length).toBe(2);
      expect(lines).toEqual(["llm: transient API failure (attempt 1/3): empty response: stream ended without emitting anything — retrying\n"]);
    } finally {
      await srv.close();
    }
  });

  it("(b) 200 with content missing entirely then a good one: same retry/success", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http200NoContent, R.http200]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      const resp = await c.complete("sys", [{ role: "user", content: "hi" }]);
      expect(resp.text).toBe("ok");
      expect(srv.requests.length).toBe(2);
      expect(lines).toEqual(["llm: transient API failure (attempt 1/3): empty response: stream ended without emitting anything — retrying\n"]);
    } finally {
      await srv.close();
    }
  });

  it("(c) empty content x3 (default LLM_RETRIES=2): terminal error text matches bin/llm's die() VERBATIM (no 'API error:' prefix)", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http200EmptyContent, R.http200EmptyContent, R.http200EmptyContent]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      await expect(c.complete("sys", [{ role: "user", content: "hi" }])).rejects.toThrow("empty response: stream ended without emitting anything");
      expect(srv.requests.length).toBe(3);
      expect(lines).toEqual([
        "llm: transient API failure (attempt 1/3): empty response: stream ended without emitting anything — retrying\n",
        "llm: transient API failure (attempt 2/3): empty response: stream ended without emitting anything — retrying\n",
        "llm: error: empty response: stream ended without emitting anything\n",
      ]);
    } finally {
      await srv.close();
    }
  });

  it("(d) reasoning-only (content empty, reasoning non-empty) then a good one: still retries — bin/llm's OpenAI-family stream handler never reads a reasoning delta, so reasoning never counts as emitted", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([R.http200EmptyContentReasoning, R.http200]);
      const lines: string[] = [];
      const c = client(srv.url, { retries: 2, stderr: (s) => lines.push(s) });
      const resp = await c.complete("sys", [{ role: "user", content: "hi" }]);
      expect(resp.text).toBe("ok");
      expect(srv.requests.length).toBe(2);
      expect(lines).toEqual(["llm: transient API failure (attempt 1/3): empty response: stream ended without emitting anything — retrying\n"]);
    } finally {
      await srv.close();
    }
  });
});

// --- responder-level: the retry ladder is what keeps a transient failure
// from turning into bug #53's "reply failed — appending failure observation". ---

function makeTraj(): { traj: Trajectory; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resp-retry-"));
  const traj = createTrajectory(path.join(root, "trajectories"));
  return { traj, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function trigger(traj: Trajectory, content: string): ResponderTrigger {
  const step_id = traj.append({ type: "message", from: "nick", to: "testid", content, source: "chat" });
  return { type: "message", step_id, from: "nick", to: "testid", content, source: "chat" };
}

function lastDecision(traj: Trajectory, triggerStepId: string): Record<string, unknown> | undefined {
  const rows = traj
    .read()
    .filter(
      (s) =>
        (s as Record<string, unknown>)["type"] === "observation" &&
        (s as Record<string, unknown>)["source"] === "responder" &&
        (s as Record<string, unknown>)["trigger_step"] === triggerStepId
    ) as Record<string, unknown>[];
  return rows[rows.length - 1];
}

describe("runResponder + OpenRouterClient retry ladder (bug #53)", () => {
  it("empty-then-good stream: decision 'replied', no reply-failed observation", async () => {
    const srv = await startFakeServer();
    const { traj, cleanup } = makeTraj();
    try {
      srv.script([R.wsBody, R.http200]);
      const trig = trigger(traj, "any update");
      const result = await runResponder({
        trajectory: traj,
        llm: client(srv.url, { retries: 2, stderr: () => {} }),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: "openai/gpt-oss-120b",
        trigger: trig,
      });
      expect(result.outcome).toBe("replied");
      const obs = lastDecision(traj, trig.step_id!)!;
      expect(obs["decision"]).toBe("replied");
      expect(srv.requests.length).toBe(2);
    } finally {
      cleanup();
      await srv.close();
    }
  });

  it("500 x3 exhausted: falls to the SAME path as an empty model response — decision 'reply-failed', not a crash", async () => {
    const srv = await startFakeServer();
    const { traj, cleanup } = makeTraj();
    try {
      srv.script([R.http500, R.http500, R.http500]);
      const trig = trigger(traj, "any update");
      const errLines: string[] = [];
      const result = await runResponder({
        trajectory: traj,
        llm: client(srv.url, { retries: 2, stderr: (s) => errLines.push(s) }),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: "openai/gpt-oss-120b",
        trigger: trig,
      });
      expect(result.outcome).toBe("reply-failed");
      const obs = lastDecision(traj, trig.step_id!)!;
      expect(obs["decision"]).toBe("reply-failed");
      expect(errLines.at(-1)).toBe("llm: error: API error (HTTP 500): upstream exploded\n");
      // 2e39a3f: the responder's reply call is bounded (retries 0), so the ladder
      // no longer runs; the structured attempt fails and the plain-text fallback
      // is the one more request (parity/responder pins the same sequence).
      expect(srv.requests.length).toBe(2);
    } finally {
      cleanup();
      await srv.close();
    }
  });

  it("bug #53b: empty-content-then-good reply: decision 'replied', no reply-failed observation", async () => {
    const srv = await startFakeServer();
    const { traj, cleanup } = makeTraj();
    try {
      srv.script([R.http200EmptyContentReasoning, R.http200]);
      const trig = trigger(traj, "any update");
      const result = await runResponder({
        trajectory: traj,
        llm: client(srv.url, { retries: 2, stderr: () => {} }),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: "openai/gpt-oss-120b",
        trigger: trig,
      });
      expect(result.outcome).toBe("replied");
      const obs = lastDecision(traj, trig.step_id!)!;
      expect(obs["decision"]).toBe("replied");
      expect(srv.requests.length).toBe(2);
    } finally {
      cleanup();
      await srv.close();
    }
  });
});
