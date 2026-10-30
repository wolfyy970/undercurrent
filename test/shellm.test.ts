// shellm.test.ts — constantsFromEnv unit tests (bin/shellm:55-80 env-knob parity).
//
// constantsFromEnv is the pure `${VAR:-default}` parse upstream does once at
// CLI startup (bin/shellm:63,70-72,88-89). See the PORT-NOTE above it in
// src/shellm.ts for the non-numeric / empty-string semantics this locks down.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  constantsFromEnv,
  DEFAULT_CONSTANTS,
  runShellm,
  filterLlmNoiseLines,
  truncateOutput,
  shellmPrivateVarName,
  redactedCmdline,
  resolveShellmApiUrl,
} from "../src/shellm.ts";
import { createTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import { DockerSandbox } from "../src/sandbox-docker.ts";
import { selectSandbox } from "../src/sandbox-runtime.ts";
import type { LlmClient, LlmResponse, ChatMessage } from "../src/llm.ts";
import { recordedModel, type RecordedModel } from "./support/recordedModel.ts";

describe("constantsFromEnv", () => {
  it("returns DEFAULT_CONSTANTS for an empty env", () => {
    expect(constantsFromEnv({})).toEqual(DEFAULT_CONSTANTS);
  });

  it("SHELLM_MAX_ITERATIONS: numeric string parses to a number", () => {
    expect(constantsFromEnv({ SHELLM_MAX_ITERATIONS: "4" }).maxIterations).toBe(4);
  });

  it("SHELLM_MAX_ITERATIONS: empty string means unlimited (null), same as unset", () => {
    expect(constantsFromEnv({ SHELLM_MAX_ITERATIONS: "" }).maxIterations).toBeNull();
    expect(constantsFromEnv({}).maxIterations).toBeNull();
  });

  it("SHELLM_MAX_ITERATIONS: non-numeric parses to NaN (every comparison then false, matching bash's `-lt` error-to-false)", () => {
    const iters = constantsFromEnv({ SHELLM_MAX_ITERATIONS: "abc" }).maxIterations;
    expect(iters).toBeNaN();
    expect(0 < (iters as number)).toBe(false); // upstream: loop body never runs
  });

  it("SHELLM_MAX_CONSECUTIVE_FAILURES: default 10, overridable, empty string falls back to default", () => {
    expect(constantsFromEnv({}).maxConsecutiveFailures).toBe(10);
    expect(constantsFromEnv({ SHELLM_MAX_CONSECUTIVE_FAILURES: "5" }).maxConsecutiveFailures).toBe(5);
    expect(constantsFromEnv({ SHELLM_MAX_CONSECUTIVE_FAILURES: "" }).maxConsecutiveFailures).toBe(10);
  });

  it("SHELLM_MAX_REPEAT_FAILURES: default 3, overridable", () => {
    expect(constantsFromEnv({}).maxRepeatFailures).toBe(3);
    expect(constantsFromEnv({ SHELLM_MAX_REPEAT_FAILURES: "1" }).maxRepeatFailures).toBe(1);
  });

  it("SHELLM_TRUNCATE: default 2000, overridable", () => {
    expect(constantsFromEnv({}).truncate).toBe(2000);
    expect(constantsFromEnv({ SHELLM_TRUNCATE: "500" }).truncate).toBe(500);
  });

  it("SHELLM_EMPTY_RESPONSE_RETRIES: default 8 when UNSET; empty string (explicitly set) means unlimited (null), unlike every other knob (bin/shellm:2429 `${VAR-8}`, not `${VAR:-8}`)", () => {
    expect(constantsFromEnv({}).emptyResponseRetries).toBe(8);
    expect(constantsFromEnv({ SHELLM_EMPTY_RESPONSE_RETRIES: "" }).emptyResponseRetries).toBeNull();
    expect(constantsFromEnv({ SHELLM_EMPTY_RESPONSE_RETRIES: "3" }).emptyResponseRetries).toBe(3);
    expect(constantsFromEnv({ SHELLM_EMPTY_RESPONSE_RETRIES: "0" }).emptyResponseRetries).toBe(0);
  });

  it("SHELLM_INACTIVITY_MAX: seconds in env, milliseconds out; default 900s = 900_000ms", () => {
    expect(constantsFromEnv({}).inactivityMaxMs).toBe(900_000);
    expect(constantsFromEnv({ SHELLM_INACTIVITY_MAX: "60" }).inactivityMaxMs).toBe(60_000);
  });

  it("SHELLM_INACTIVITY_TIMEOUT: seconds in env, milliseconds out; default 30s = 30_000ms (bug #33)", () => {
    expect(constantsFromEnv({}).inactivityTimeoutMs).toBe(30_000);
    expect(constantsFromEnv({ SHELLM_INACTIVITY_TIMEOUT: "5" }).inactivityTimeoutMs).toBe(5_000);
    expect(constantsFromEnv({ SHELLM_INACTIVITY_TIMEOUT: "" }).inactivityTimeoutMs).toBe(30_000);
  });

  it("ignores unrelated env vars", () => {
    expect(constantsFromEnv({ PATH: "/usr/bin", HOME: "/root" })).toEqual(DEFAULT_CONSTANTS);
  });

  // PORT-NOTE (1c: 2d1c1c3) SHELLM_STOP_AFTER_CODE_BLOCK
  it("SHELLM_STOP_AFTER_CODE_BLOCK defaults to true (on); only the exact string \"1\" turns it on, everything else off", () => {
    expect(constantsFromEnv({}).stopAfterCodeBlock).toBe(true);
    expect(constantsFromEnv({ SHELLM_STOP_AFTER_CODE_BLOCK: "1" }).stopAfterCodeBlock).toBe(true);
    expect(constantsFromEnv({ SHELLM_STOP_AFTER_CODE_BLOCK: "0" }).stopAfterCodeBlock).toBe(false);
    expect(constantsFromEnv({ SHELLM_STOP_AFTER_CODE_BLOCK: "true" }).stopAfterCodeBlock).toBe(false);
    expect(constantsFromEnv({ SHELLM_STOP_AFTER_CODE_BLOCK: "" }).stopAfterCodeBlock).toBe(true); // set-but-empty -> falls to default
  });

  // PORT-NOTE (1c: 7a35982, d43ae81, 0f8b49e) SHELLM_CONTEXT_* knobs
  it("SHELLM_CONTEXT_SCOPE/RUN_TAIL/RUN_TAIL_BLOCK/BLOCK_LIMIT/WHOLE_BLOCKS default and parse", () => {
    expect(constantsFromEnv({})).toMatchObject({
      contextScope: "traj",
      contextRunTail: 400,
      contextRunTailBlock: 50,
      contextBlockLimit: 8192,
      contextWholeBlocks: 1,
    });
    expect(constantsFromEnv({ SHELLM_CONTEXT_SCOPE: "run" }).contextScope).toBe("run");
    expect(constantsFromEnv({ SHELLM_CONTEXT_SCOPE: "bogus" }).contextScope).toBe("traj");
    expect(constantsFromEnv({ SHELLM_CONTEXT_RUN_TAIL: "100" }).contextRunTail).toBe(100);
    expect(constantsFromEnv({ SHELLM_CONTEXT_RUN_TAIL_BLOCK: "20" }).contextRunTailBlock).toBe(20);
    expect(constantsFromEnv({ SHELLM_CONTEXT_BLOCK_LIMIT: "4096" }).contextBlockLimit).toBe(4096);
    expect(constantsFromEnv({ SHELLM_CONTEXT_WHOLE_BLOCKS: "2" }).contextWholeBlocks).toBe(2);
  });
});

// PORT-NOTE (1c: callout (c), a4b5db8's final regex) — case-insensitive,
// unanchored for credential words, anchored at a `_`-boundary (or the
// string's own edges) for endpoint words.
describe("shellmPrivateVarName", () => {
  it("matches credential words anywhere in the name (unanchored)", () => {
    for (const n of ["API_KEY", "MYKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "xKEYx"]) {
      expect(shellmPrivateVarName(n)).toBe(true);
    }
  });
  it("matches endpoint words only at a `_`-boundary or the string's own edges", () => {
    expect(shellmPrivateVarName("LLM_API_URL")).toBe(true);
    expect(shellmPrivateVarName("URL")).toBe(true);
    expect(shellmPrivateVarName("SOME_ENDPOINT")).toBe(true);
    expect(shellmPrivateVarName("DSN")).toBe(true);
    // "URLENCODED" has no `_`/edge boundary around "URL" on the right side.
    expect(shellmPrivateVarName("URLENCODED")).toBe(false);
    expect(shellmPrivateVarName("MYURLENCODED")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(shellmPrivateVarName("api_key")).toBe(true);
    expect(shellmPrivateVarName("shellm_api_url")).toBe(true);
  });
  it("does not match an ordinary variable name", () => {
    expect(shellmPrivateVarName("IDENTITY_NAME")).toBe(false);
    expect(shellmPrivateVarName("TRAJ_ID")).toBe(false);
    expect(shellmPrivateVarName("SHELLM_MODEL")).toBe(false);
  });
});

describe("redactedCmdline (bin/shellm _redacted_cmdline)", () => {
  it("prefixes 'shellm' and space-joins every arg with NO shell-quoting", () => {
    expect(redactedCmdline(["-m", "gpt-5", "hello world"])).toBe("shellm -m gpt-5 hello world");
  });
  it("redacts the VALUE (not the name) of a --var NAME=VALUE whose NAME is private", () => {
    expect(redactedCmdline(["--var", "OPENROUTER_API_KEY=sk-abc123"])).toBe("shellm --var OPENROUTER_API_KEY=<redacted>");
    expect(redactedCmdline(["--var", "LLM_API_URL=http://example.com"])).toBe("shellm --var LLM_API_URL=<redacted>");
  });
  it("leaves a non-private --var NAME=VALUE untouched", () => {
    expect(redactedCmdline(["--var", "IDENTITY_NAME=ada"])).toBe("shellm --var IDENTITY_NAME=ada");
  });
  it("never touches a bare --var NAME (no '=') — the value was never on argv to begin with", () => {
    expect(redactedCmdline(["--var", "OPENROUTER_API_KEY"])).toBe("shellm --var OPENROUTER_API_KEY");
  });
  it("only redacts immediately after --var, not any other flag", () => {
    expect(redactedCmdline(["--model", "OPENROUTER_API_KEY=x"])).toBe("shellm --model OPENROUTER_API_KEY=x");
  });
});

describe("resolveShellmApiUrl (bin/shellm, a4b5db8 endpoint-alias precedence)", () => {
  it("a process-level SHELLM_API_URL beats a .env-loaded LLM_API_URL", () => {
    expect(
      resolveShellmApiUrl({ processShellmApiUrl: "http://process-shellm", loadedShellmApiUrl: "http://process-shellm", loadedLlmApiUrl: "http://file-llm" })
    ).toBe("http://process-shellm");
  });
  it("a process-level LLM_API_URL beats a .env-loaded SHELLM_API_URL (the file value is discarded, not merged)", () => {
    expect(
      resolveShellmApiUrl({ processLlmApiUrl: "http://process-llm", loadedShellmApiUrl: "http://file-shellm-clobber", loadedLlmApiUrl: "http://process-llm" })
    ).toBe("http://process-llm");
  });
  it("SHELLM_API_URL alias wins over LLM_API_URL when BOTH were set at the process level", () => {
    expect(resolveShellmApiUrl({ processShellmApiUrl: "http://s", processLlmApiUrl: "http://l" })).toBe("http://s");
  });
  it("a process-level var set to EMPTY still counts as \"set\" (bash's ${VAR+x}) and wins over a file value", () => {
    expect(resolveShellmApiUrl({ processShellmApiUrl: "", loadedShellmApiUrl: "http://file" })).toBe("");
  });
  it("neither set at the process level: falls back to the post-file-load SHELLM_API_URL, then LLM_API_URL, then empty", () => {
    expect(resolveShellmApiUrl({ loadedShellmApiUrl: "http://file-shellm" })).toBe("http://file-shellm");
    expect(resolveShellmApiUrl({ loadedLlmApiUrl: "http://file-llm" })).toBe("http://file-llm");
    expect(resolveShellmApiUrl({})).toBe("");
  });
});

describe("filterLlmNoiseLines (bin/shellm:2438)", () => {
  it("strips 'llm: warning:'/'llm: note:' lines, keeps everything else", () => {
    const input = "real reasoning\nllm: warning: output truncated at max_tokens=100\nmore reasoning\nllm: note: fyi\n";
    expect(filterLlmNoiseLines(input)).toBe("real reasoning\nmore reasoning"); // $(…) drops trailing newlines
  });
  it("a line merely containing the phrase mid-line is not stripped (anchored to line start)", () => {
    expect(filterLlmNoiseLines("see llm: warning: in the middle")).toBe("see llm: warning: in the middle");
  });
});

describe("truncateOutput (bin/shellm:302-314)", () => {
  it("short input: unchanged plus one trailing newline (bash `echo`)", () => {
    expect(truncateOutput("short", 2000)).toBe("short\n");
  });
  it("long input: halves + a truncation marker, byte(char)-shaped", () => {
    const input = "a".repeat(10) + "b".repeat(10);
    const out = truncateOutput(input, 10);
    expect(out).toBe("a".repeat(5) + "\n[... truncated 10 chars ...]\n" + "b".repeat(5) + "\n");
  });
});

// Recorded real replies for every runShellm test below (test/fixtures/recordings/shellm/, DeepSeek, openai-compatible
// wire, the production `llm` path). The test's PROMPT asks the model for the block the scenario needs; what comes back
// is the model's own answer, replayed byte for byte. Assertions check behavior (what ran, what was recorded, how the
// run ended), plus that the replay really carried the block the scenario is about.
const ASK = (body: string): string => `Reply with exactly the following and nothing else:\n\n${body}`;
const firstBlock = (t: string): string | null => /```bash\n([\s\S]*?)\n```/.exec(t)?.[1] ?? null;
const rec = (scenario: string, o: Parameters<typeof recordedModel>[2] = {}): RecordedModel => recordedModel("shellm", scenario, o);
async function withRec<T>(m: RecordedModel, f: (m: RecordedModel) => Promise<T>): Promise<T> {
  try {
    const r = await f(m);
    m.verify();
    return r;
  } finally {
    m.close();
  }
}
const FINAL_DONE_PROMPT = ASK('```bash\nFINAL="done"\n```');

describe("runShellm: empty-response retry (bin/shellm:2423-2477, upstream 8ba520b/136f32b)", () => {
  function baseOpts(llm: LlmClient, extra: Partial<Parameters<typeof runShellm>[0]> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-retry-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-retry-wd-"));
    const traj = createTrajectory(root);
    return {
      trajectory: traj,
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: "",
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {}, // instant — no real wall-clock delay in tests
      ...extra,
    };
  }

  // Recorded real replies (test/fixtures/recordings/shellm-empty-retry/, DeepSeek's Anthropic-format endpoint, where a
  // thinking-only answer reaches shellm as empty text + reasoning). A tiny `-t` starves the answer so the model's
  // real thinking is all that comes back; the next call has room to answer.
  const TASK =
    'Before you write anything, reason carefully: is 2147483647 prime? Then reply with exactly one bash block that sets FINAL="done" and nothing else.';
  const STARVED = 24;
  const ROOM = 2000;
  // Transport fixture, not model output: a well-formed Anthropic stream whose only content is a thinking block holding a
  // bare newline (no text, no thinking words). llm counts it as emitted (rc 0, nothing on stdout), so shellm sees the
  // silent answer its own branch handles; a block with no characters at all is retried inside llm and never gets here.
  const EMPTY_STREAM = {
    status: 200,
    content_type: "text/event-stream",
    body:
      'event: message_start\ndata: {"type":"message_start","message":{"id":"fx","type":"message","role":"assistant","model":"deepseek-flash","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  };
  // bin/shellm:2438 `grep -Ev '^llm: (warning|note): '`
  const fedBack = (reasoning: string | undefined): string => (reasoning ?? "").split("\n").filter((l) => !/^llm: (warning|note): /.test(l)).join("\n");
  const msgsOf = (m: RecordedModel, i: number) => (m.requests[i]!["messages"] as ChatMessage[]);

  it("empty text with reasoning is not a failure: retries once, feeding the reasoning back as assistant content", async () => {
    const m = recordedModel("shellm-empty-retry", "reasoning-then-final", { wire: "anthropic", maxTokensByCall: [STARVED, ROOM] });
    try {
      const opts = baseOpts(m, { prompt: TASK });
      const result = await runShellm(opts);
      m.verify();
      expect(m.responses[0]!.text).toBe(""); // the recorded first answer really is thinking only
      expect(fedBack(m.responses[0]!.reasoning).trim()).not.toBe("");
      expect(result.stopReason).toBe("final");
      expect(result.iterations).toBe(1); // the retry sub-loop does not advance the outer iteration count
      expect(m.requests).toHaveLength(2);
      const retryMsgs = msgsOf(m, 1);
      expect(retryMsgs.at(-2)!.role).toBe("assistant");
      expect(retryMsgs.at(-2)!.content.trim()).toBe(fedBack(m.responses[0]!.reasoning).trim());
      expect(retryMsgs.at(-1)!.role).toBe("user");
      expect(retryMsgs.at(-1)!.content).toContain("Continue from where you left off");
    } finally {
      m.close();
    }
  });

  it("empty text with no reasoning (silent) retries without feeding anything back", async () => {
    const m = recordedModel("shellm-empty-retry", "silent-then-final", { wire: "anthropic", maxTokens: ROOM, httpFixtures: { 0: EMPTY_STREAM } });
    try {
      const opts = baseOpts(m, { prompt: TASK });
      const result = await runShellm(opts);
      m.verify();
      expect(result.stopReason).toBe("final");
      expect(m.requests).toHaveLength(2);
      expect(msgsOf(m, 1)).toEqual(msgsOf(m, 0)); // no assistant/user pair appended
    } finally {
      m.close();
    }
  });

  it("llm's own warning/note lines are filtered out of the fed-back reasoning", async () => {
    const m = recordedModel("shellm-empty-retry", "reasoning-then-final", { wire: "anthropic", maxTokensByCall: [STARVED, ROOM] });
    try {
      await runShellm(baseOpts(m, { prompt: TASK }));
      m.verify();
      // the real call's stderr carries llm's own warning lines (the endpoint override, the truncation warning) …
      expect(m.responses[0]!.reasoning).toMatch(/^llm: warning: /m);
      // … none of them is fed back to the model, and the model's own thinking is
      const fed = msgsOf(m, 1).at(-2)!.content;
      expect(fed).not.toMatch(/^llm: (warning|note): /m);
      expect(fed.trim().length).toBeGreaterThan(0);
    } finally {
      m.close();
    }
  });

  it("visible text is unaffected — no retry when the first response is non-empty", async () => {
    const m = recordedModel("shellm-empty-retry", "final-first", { wire: "anthropic", maxTokens: ROOM });
    try {
      const result = await runShellm(baseOpts(m, { prompt: TASK }));
      m.verify();
      expect(m.responses[0]!.text).not.toBe("");
      expect(result.stopReason).toBe("final");
      expect(m.requests).toHaveLength(1);
    } finally {
      m.close();
    }
  });

  it("a real llm exit failure (thrown) still fails the call — not caught/retried as empty", async () => {
    // Transport fixture: the provider answers 400; llm exits non-zero and shellm must not treat it as an empty reply.
    const m = recordedModel("shellm-empty-retry", "transport-400", {
      wire: "anthropic",
      httpFixtures: { 0: { status: 400, content_type: "application/json", body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}' } },
    });
    try {
      const opts = baseOpts(m, { prompt: TASK });
      await expect(runShellm(opts)).rejects.toThrow(/llm failed \(exit [1-9]/);
      expect(m.requests.length).toBeGreaterThanOrEqual(1);
      expect((opts.trajectory.read() as Record<string, unknown>[]).some((s) => s["reason"] === "empty-response")).toBe(false);
    } finally {
      m.close();
    }
  });

  it("retries are capped (default 8, overridable) — exhausting them ends the wake with an error step, not a crash", async () => {
    const m = recordedModel("shellm-empty-retry", "three-starved", { wire: "anthropic", maxTokens: STARVED });
    try {
      const opts = baseOpts(m, { prompt: TASK, constants: { emptyResponseRetries: 2 } });
      const result = await runShellm(opts);
      m.verify();
      expect(m.responses.map((r) => r.text)).toEqual(["", "", ""]);
      expect(result.stopReason).toBe("empty-response");
      expect(m.requests).toHaveLength(3); // initial + 2 retries, cap reached
      const steps = opts.trajectory.read() as Record<string, unknown>[];
      const err = steps.find((s) => s["type"] === "error");
      expect(err).toBeDefined();
      expect(String(err!["content"])).toMatch(/^Empty response from test-model after 2 retries: \S/);
      // the detail is the LAST attempt's real reasoning
      expect(String(err!["content"])).toContain(fedBack(m.responses[2]!.reasoning).trim().split("\n")[0]!.slice(0, 20));
      expect(err!["reason"]).toBe("empty-response");
      expect(err!["source"]).toBe("shellm");
    } finally {
      m.close();
    }
  });

  it("exhausting the cap with no model reasoning: the detail is only llm's own stderr (upstream dies with raw $thinking)", async () => {
    const m = recordedModel("shellm-empty-retry", "transport-two-silent", { wire: "anthropic", httpFixtures: { 0: EMPTY_STREAM, 1: EMPTY_STREAM } });
    try {
      const opts = baseOpts(m, { prompt: TASK, constants: { emptyResponseRetries: 1 } });
      const result = await runShellm(opts);
      expect(result.stopReason).toBe("empty-response");
      const steps = opts.trajectory.read() as Record<string, unknown>[];
      const err = steps.find((s) => s["type"] === "error");
      // upstream's die uses the unfiltered `$thinking`, so llm's own endpoint-override warning is the whole detail;
      // the newline-only thinking block contributes nothing (command substitution strips it).
      expect(String(err!["content"])).toMatch(/^Empty response from test-model after 1 retries: llm: warning: LLM_API_URL overrides the default anthropic endpoint \(requests go to 127\.0\.0\.1:\d+\)$/);
    } finally {
      m.close();
    }
  });

  it("SHELLM_EMPTY_RESPONSE_RETRIES explicitly empty (null constant) means unlimited — outlasts the default cap of 8", async () => {
    // 9 transport-empty streams (more than the default cap), then the recorded real answer.
    const fx: Record<number, typeof EMPTY_STREAM> = {};
    for (let i = 0; i < 9; i++) fx[i] = EMPTY_STREAM;
    const m = recordedModel("shellm-empty-retry", "final-first", { wire: "anthropic", maxTokens: ROOM, httpFixtures: fx });
    try {
      const opts = baseOpts(m, { prompt: TASK, constants: { emptyResponseRetries: null } });
      const result = await runShellm(opts);
      m.verify();
      expect(result.stopReason).toBe("final");
      expect(m.requests).toHaveLength(10);
    } finally {
      m.close();
    }
  });
});

// PORT-NOTE (1c: 7a35982, d43ae81, 0f8b49e) — SHELLM_CONTEXT_SCOPE=run wires
// buildContext's new --run/--full-types/--tail-block/--block-limit knobs
// through runShellm's own context-rebuild call (bin/shellm's `context
// "${_ctx_args[@]}"` equivalent).
describe("runShellm: context scope (SHELLM_CONTEXT_SCOPE)", () => {
  function baseOpts(llm: LlmClient, extra: Partial<Parameters<typeof runShellm>[0]> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-ctxscope-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-ctxscope-wd-"));
    const traj = createTrajectory(root);
    return {
      trajectory: traj,
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: "this run's own wake prompt",
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {},
      ...extra,
    };
  }

  it("default (traj scope): an earlier run's steps still reach the model's context", async () => {
    await withRec(rec("ctx-traj-scope"), async (m) => {
      const opts = baseOpts(m, { prompt: FINAL_DONE_PROMPT });
      // Simulate an EARLIER, separate shellm run already recorded in this trajectory.
      opts.trajectory.append({ type: "prompt", content: "an earlier run's prompt, long since past" });
      expect((await runShellm(opts)).stopReason).toBe("final");
      expect(JSON.stringify(m.requests[0]!["messages"])).toContain("an earlier run's prompt");
    });
  });

  it("SHELLM_CONTEXT_SCOPE=run: only THIS run's own steps reach the model; earlier runs are invisible", async () => {
    await withRec(rec("ctx-run-scope"), async (m) => {
      const opts = baseOpts(m, { prompt: FINAL_DONE_PROMPT + "\n\n(this run's own wake prompt)", constants: { contextScope: "run" } });
      opts.trajectory.append({ type: "prompt", content: "an earlier run's prompt, long since past" });
      expect((await runShellm(opts)).stopReason).toBe("final");
      const seen = JSON.stringify(m.requests[0]!["messages"]);
      expect(seen).not.toContain("an earlier run's prompt");
      expect(seen).toContain("this run's own wake prompt"); // the pinned prompt step
    });
  });

  it("SHELLM_CONTEXT_SCOPE=run: the prompt is pinned whole even under a byte-tiny window (--full-types prompt)", async () => {
    const longPrompt = FINAL_DONE_PROMPT + "\n\n(padding: " + "P".repeat(5000) + ")";
    await withRec(rec("ctx-run-scope-pinned"), async (m) => {
      const opts = baseOpts(m, {
        prompt: longPrompt,
        // A run-scope tail of 0 would normally drop everything but the pin.
        constants: { contextScope: "run", contextRunTail: 0, contextRunTailBlock: 1 },
      });
      await runShellm(opts);
      expect(JSON.stringify(m.requests[0]!["messages"])).toContain("P".repeat(5000));
    });
  });
});

// ---------------------------------------------------------------------------
// bug #33: the inactivity watchdog's idle-vs-max KILLED distinction, driven
// through the real runShellm loop (real LocalSandbox, real subprocess timing
// — not mocked). bin/shellm:2716-2721 prints a different KILLED line for
// kill_reason "idle" vs "nested" (ported as "max"); shellm.ts now picks the
// message and the recorded shell-output `feedback` from `exec.killReason`
// instead of always describing the single flat ceiling this port used to
// have.
describe("runShellm: inactivity watchdog KILLED distinction (bug #33)", () => {
  function watchdogOpts(
    llm: LlmClient,
    stderrLines: string[],
    extra: Partial<Parameters<typeof runShellm>[0]["constants"]> = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-watchdog-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-watchdog-wd-"));
    const traj = createTrajectory(root);
    return {
      trajectory: traj,
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: "",
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {},
      io: { stdout: () => {}, stderr: (s: string) => stderrLines.push(s) },
      constants: { maxIterations: 1, ...extra },
    };
  }

  it(
    "a genuinely silent block is KILLED at the idle mark — 'inactivity timeout' line, feedback names the idle limit",
    async () => {
      const m = rec("watchdog-idle");
      const stderrLines: string[] = [];
      const opts = { ...watchdogOpts(m, stderrLines, { inactivityTimeoutMs: 1000, inactivityMaxMs: 60_000 }), prompt: ASK("```bash\nsleep 5\n```") };
      const t0 = Date.now();
      const result = await withRec(m, () => runShellm(opts));
      const elapsedMs = Date.now() - t0;
      expect(firstBlock(m.responses[0]!.text)).toBe("sleep 5");

      expect(result.stopReason).toBe("max-iter"); // the loop ends after its one allowed iteration
      expect(stderrLines.some((l) => l.includes("KILLED — inactivity timeout (1s)"))).toBe(true);
      expect(stderrLines.some((l) => l.includes("sub-run silent"))).toBe(false);
      // Killed near the 1s idle mark, not the 5s sleep completing naturally.
      expect(elapsedMs).toBeLessThan(4000);

      const steps = opts.trajectory.read() as Record<string, unknown>[];
      const shellOut = steps.find((s) => s["type"] === "shell-output");
      expect(shellOut).toBeDefined();
      expect(shellOut!["timed_out"]).toBe(true);
      expect(shellOut!["feedback"]).toBe("[killed: no output for 1s]");
    },
    8_000,
  );

  it(
    "a block silent on real output but touching the activity beacon is KILLED at the MAX ceiling — 'sub-run silent' line, feedback names the ceiling",
    async () => {
      // No real stdout at all — only repeated writes to $SHELLM_ACTIVITY_FILE
      // (the env var runShellm itself forwards, bin/shellm:2579's contract),
      // exactly like a nested-run beacon would. Content changes every tick
      // (a counter, not a clock) so the reset is deterministic, not dependent
      // on `date` granularity. `set +x` FIRST: buildWrappedCode always wraps
      // the block in `set -x`, whose own xtrace lines are real output — left
      // on, every traced command would itself keep resetting BOTH clocks,
      // making a genuinely-output-silent-but-beacon-active block impossible
      // to construct. Turning tracing off reproduces the scenario upstream's
      // watchdog actually distinguishes: a block whose only sign of life is
      // the beacon.
      const BEACON = 'set +x\nfor i in $(seq 1 100); do printf \'%s\' "$i" > "$SHELLM_ACTIVITY_FILE"; sleep 0.1; done';
      const m = rec("watchdog-beacon");
      const stderrLines: string[] = [];
      const opts = { ...watchdogOpts(m, stderrLines, { inactivityTimeoutMs: 1500, inactivityMaxMs: 4000 }), prompt: ASK("```bash\n" + BEACON + "\n```") };
      const t0 = Date.now();
      const result = await withRec(m, () => runShellm(opts));
      const elapsedMs = Date.now() - t0;
      expect(firstBlock(m.responses[0]!.text)).toBe(BEACON);

      expect(result.stopReason).toBe("max-iter");
      expect(stderrLines.some((l) => l.includes("KILLED — sub-run silent for 4s"))).toBe(true);
      expect(stderrLines.some((l) => l.includes("inactivity timeout ("))).toBe(false);
      // The loop runs ~10s (100 x 0.1s), so it is always still running at the 4s ceiling. With 40 x 0.1s it ended at
      // ~4.06s on Linux (cheap fork/sleep) and raced the ceiling; macOS's slower fork hid the race.
      // Killed at the ~4s ceiling, well past the 1.5s idle mark — the beacon
      // suppressed the idle kill; only the ceiling fired.
      expect(elapsedMs).toBeGreaterThanOrEqual(4000);
      expect(elapsedMs).toBeLessThan(7000);

      const steps = opts.trajectory.read() as Record<string, unknown>[];
      const shellOut = steps.find((s) => s["type"] === "shell-output");
      expect(shellOut).toBeDefined();
      expect(shellOut!["timed_out"]).toBe(true);
      expect(shellOut!["feedback"]).toBe("[killed: sub-run silent for 4s]");
    },
    12_000,
  );
});

// ---------------------------------------------------------------------------
// BUG #27: FINAL/FINAL_FILE capture, LocalSandbox vs DockerSandbox
// (bin/shellm:2515-2521, 2792-2797). The model's bash block runs INSIDE the
// container under DockerSandbox — the host tmpdir `rundir` used for LocalSandbox
// is never mounted there, so a naive host-tmp finalPath silently loses every
// FINAL/FINAL_FILE write and the run burns the whole SHELLM_MAX_ITERATIONS cap
// instead of stopping. src/shellm.ts picks finalPath from opts.header.env.type
// ("docker" → $workdir/.shellm_final, the bind-mounted path; else $rundir/final).
describe("runShellm: FINAL capture path selection (BUG #27)", () => {
  it("LocalSandbox: unchanged — finalPath stays in the host rundir, never under workdir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-final-local-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-final-local-wd-"));
    const traj = createTrajectory(root);
    const m = rec("final-done");
    const opts = {
      trajectory: traj,
      llm: m,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: FINAL_DONE_PROMPT,
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
    };
    const result = await withRec(m, () => runShellm(opts));
    expect(result.stopReason).toBe("final");
    expect(result.iterations).toBe(1);
    expect(result.response).toBe("done");
    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const final = steps.find((s) => s["type"] === "final");
    expect(final?.["content"]).toBe("done");
    // The docker-mode marker file must never appear in the workdir for a local run.
    expect(fs.existsSync(path.join(workdir, ".shellm_final"))).toBe(false);
  });

  const FINAL_FILE_PROMPT = ASK('```bash\necho -n "from file" > out.txt\nFINAL_FILE=out.txt\n```');
  it("LocalSandbox: FINAL_FILE=... is read from the workdir file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-final-local-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-final-local-wd-"));
    const m = rec("final-file");
    const opts = {
      trajectory: createTrajectory(root), llm: m, sandbox: new LocalSandbox(), systemPrompt: "system", prompt: FINAL_FILE_PROMPT,
      workdir, binDir: "/nonexistent/bin", execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
    };
    const result = await withRec(m, () => runShellm(opts));
    expect(result.stopReason).toBe("final");
    expect(result.response).toBe("from file");
  });

  const DOCKER_DAEMON_UP = DockerSandbox.isDaemonAvailable();

  function dockerRunOpts(llm: LlmClient) {
    // Mirror production layout (sandbox-runtime.ts PORT-NOTE): every step's
    // workdir lives under <identityDir>/.shellm/workdirs/<pid>, and
    // identityDir itself always lives under the real IDENTITY_DIR tree, which
    // in production is under $HOME (src/install-lib.ts default ~/.headlong).
    // Docker Desktop bind-mounts os.tmpdir() fine, but colima only maps host
    // UID/GID correctly for paths under $HOME (its other host mounts present
    // as root-owned, so a --user <uid>:<gid> container can't write into
    // them) — using a scratch dir under os.homedir() is both faithful to
    // production and portable across Docker backends.
    const scratchRoot = fs.mkdtempSync(path.join(os.homedir(), ".headlong-shellm-final-test-"));
    const identityDir = path.join(scratchRoot, "identity");
    const workdir = path.join(identityDir, ".shellm", "workdirs", `${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workdir, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-final-docker-traj-"));
    const traj = createTrajectory(root);
    const { sandbox, env, cleanup: dockerCleanup } = selectSandbox({
      identityName: "final-capture-test",
      identityDir,
      workdir,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
      tempDocker: true, // one-off test container, not the identity's persistent env
    });
    const cleanup = (): void => {
      dockerCleanup();
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    };
    const opts = {
      trajectory: traj,
      llm,
      sandbox,
      systemPrompt: "system",
      prompt: "",
      workdir,
      binDir: "/usr/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env, resumed: false },
    };
    return { opts, cleanup };
  }

  describe.skipIf(!DOCKER_DAEMON_UP)("DockerSandbox (real daemon; skips cleanly with no docker)", () => {
    it('FINAL="..." is captured through the container (env.type "docker" round trip)', async () => {
      // Replays the same recorded answer as the LocalSandbox test (same request shape: system "system", same prompt).
      const m = rec("final-done");
      const { opts, cleanup } = dockerRunOpts(m);
      opts.prompt = FINAL_DONE_PROMPT;
      try {
        const result = await withRec(m, () => runShellm(opts));
        expect(result.stopReason).toBe("final");
        expect(result.iterations).toBe(1);
        expect(result.response).toBe("done");
        const steps = opts.trajectory.read() as Record<string, unknown>[];
        const final = steps.find((s) => s["type"] === "final");
        expect(final?.["content"]).toBe("done");
        expect(final?.["type"]).toBe("final");
      } finally {
        cleanup();
      }
    }, 60_000);

    it("FINAL_FILE=... is captured through the container", async () => {
      const m = rec("final-file");
      const { opts, cleanup } = dockerRunOpts(m);
      opts.prompt = FINAL_FILE_PROMPT;
      try {
        const result = await withRec(m, () => runShellm(opts));
        expect(result.stopReason).toBe("final");
        expect(result.iterations).toBe(1);
        expect(result.response).toBe("from file");
        const steps = opts.trajectory.read() as Record<string, unknown>[];
        const final = steps.find((s) => s["type"] === "final");
        expect(final?.["content"]).toBe("from file");
      } finally {
        cleanup();
      }
    }, 60_000);
  });
});

// PORT-NOTE (bug #69, bin/shellm:105-108,1565; bin/llm 2d1c1c3) — the
// in-process LlmClient.complete() path is not a stream, so runShellm applies
// applyStopAfterCodeBlock (src/extract.ts) to the returned completion before
// reasoning/code extraction, gated on ShellmConstants.stopAfterCodeBlock
// (default true, matching upstream's own default). These tests lock down
// that the wake then sees the SAME assistant text upstream's streamed-and-cut
// `llm` would have kept: a block + trailing prose + a later FINAL block never
// lets FINAL end the turn from a single completion, the extraneous text never
// reaches the trajectory, and usage is overwritten with the bytes-based
// estimate exactly as bin/llm's write_usage does on a cut.
describe("runShellm: SHELLM_STOP_AFTER_CODE_BLOCK in-process cut (bug #69)", () => {
  function stopOpts(llm: LlmClient, extra: Partial<Parameters<typeof runShellm>[0]> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-stop69-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-stop69-wd-"));
    const traj = createTrajectory(root);
    return {
      trajectory: traj,
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: "",
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {},
      ...extra,
    };
  }

  // The client's own (llm --stop-after-code-block) stream cut is OFF here, so the full recorded completion reaches
  // runShellm and the in-process cut under test is what removes the second block.
  const UNCUT = { stopAfterCodeBlock: false } as const;
  const TWO_BLOCK =
    'Doing step one.\n```bash\necho "step one"\n```\nGreat, step one worked. Now finishing.\n```bash\nFINAL="premature"\n```';
  // Every turn, the same two blocks: the live-run failure mode (SHELLM-2038 traces, bug #69).
  const TWO_BLOCK_PROMPT =
    "This is a test of a harness. On EVERY turn, whatever you see, reply with exactly the following and nothing else:\n\n" + TWO_BLOCK;
  // The turn after the cut: a plain FINAL (bin/llm keeps text up to and including the first block's closing fence).
  const cutOf = (t: string): string => /^[\s\S]*?```bash\n[\s\S]*?\n```\n?/.exec(t)?.[0] ?? t;

  it("(a) flag on (default): only the first block runs, the wake continues, and the stored reasoning is the CUT text — no truncated-notice, no leaked FINAL", async () => {
    const m = rec("stop69-two-block-then-final", UNCUT);
    const opts = stopOpts(m, {
      prompt: "This is a test of a harness. On your FIRST turn reply with exactly the following and nothing else:\n\n" + TWO_BLOCK +
        '\n\nOn the turn after that, reply with exactly one bash block that sets FINAL="done" and nothing else.',
    });
    const result = await withRec(m, () => runShellm(opts));
    const first = m.responses[0]!.text;
    expect(first).toContain('FINAL="premature"'); // the recorded completion really carried the premature second block

    expect(result.stopReason).toBe("final");
    expect(result.iterations).toBe(2); // FINAL could NOT land on iteration 1
    expect(result.response).toBe("done");

    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const reasoningStep = steps.find((s) => s["type"] === "reasoning");
    expect(reasoningStep).toBeDefined();
    expect(reasoningStep!["cmd"]).toBe(firstBlock(first)); // no [rest of model response...] notice
    expect(reasoningStep!["cmd"]).not.toContain("FINAL");

    // usage: bin/llm write_usage overwrite on a cut — out_tok from bytes, estimated:true, in_tok/think_tok dropped.
    expect(reasoningStep!["estimated"]).toBe(true);
    expect(reasoningStep!["in_tok"]).toBeUndefined();
    expect(reasoningStep!["out_tok"]).toBe(Math.floor((Buffer.byteLength(cutOf(first), "utf8") + 3) / 4));

    // The second block's command must never actually have run.
    const shellOut = steps.find((s) => s["type"] === "shell-output");
    expect(shellOut!["stdout"]).toContain("step one");
    expect(shellOut!["stdout"]).not.toContain("premature");
  }, 60_000); // record mode makes real calls; replay is fast

  it("(b) flag off: old behavior — full text kept, extractCode's own multi-block notice fires, usage is not estimated", async () => {
    // Same recorded answers as (a): the request shape is identical, only the engine's handling differs.
    const m = rec("stop69-two-block-then-final", UNCUT);
    const opts = stopOpts(m, {
      prompt: "This is a test of a harness. On your FIRST turn reply with exactly the following and nothing else:\n\n" + TWO_BLOCK +
        '\n\nOn the turn after that, reply with exactly one bash block that sets FINAL="done" and nothing else.',
      constants: { stopAfterCodeBlock: false },
    });
    const result = await withRec(m, () => runShellm(opts));

    expect(result.stopReason).toBe("final");
    expect(result.iterations).toBe(2); // extractCode still only ever runs the FIRST block

    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const reasoningStep = steps.find((s) => s["type"] === "reasoning");
    expect(reasoningStep!["cmd"]).toBe(
      'echo "[rest of model response truncated after first code block]" >&2\n' + firstBlock(m.responses[0]!.text)
    );
    expect(reasoningStep!["estimated"]).toBeUndefined();
  }, 60_000); // record mode makes real calls; replay is fast

  it("(c) a heredoc containing a fence-looking line in the first block is not cut early — the whole heredoc still executes", async () => {
    const HEREDOC = "```bash\ncat <<'EOF'\n```\nstill inside\nEOF\necho after\n```\nmore prose\n```bash\nFINAL=\"premature\"\n```";
    const m = rec("stop69-heredoc-then-final", UNCUT);
    const opts = stopOpts(m, {
      prompt: "This is a test of a harness. On your FIRST turn reply with exactly the following and nothing else:\n\n" + HEREDOC +
        '\n\nOn the turn after that, reply with exactly one bash block that sets FINAL="done" and nothing else.',
    });
    const result = await withRec(m, () => runShellm(opts));
    expect(m.responses[0]!.text).toContain("still inside");

    expect(result.iterations).toBe(2); // the premature FINAL was still dropped
    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const shellOut = steps.find((s) => s["type"] === "shell-output");
    // The heredoc's own fence-looking line and body executed as real heredoc content, not treated as an early close.
    expect(shellOut!["stdout"]).toContain("```");
    expect(shellOut!["stdout"]).toContain("still inside");
    expect(shellOut!["stdout"]).toContain("after");
  }, 60_000); // record mode makes real calls; replay is fast

  it("(d) no fenced block at all: unaffected by the flag — the no-fence notice path fires exactly as before", async () => {
    const m = rec("stop69-no-fence", UNCUT);
    const opts = stopOpts(m, {
      prompt: "This is a test of a harness. Reply with one short plain-prose sentence saying you are idle. Do not write any code block.",
      constants: { maxIterations: 1 },
    });
    const result = await withRec(m, () => runShellm(opts));
    expect(m.responses[0]!.text).not.toContain("```");

    expect(result.stopReason).toBe("max-iter"); // no-fence text still runs as one command, not a FINAL
    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const reasoningStep = steps.find((s) => s["type"] === "reasoning");
    expect(reasoningStep!["cmd"]).toContain("your reply had no ```bash code block");
    expect(reasoningStep!["estimated"]).toBeUndefined(); // never entered a fence, never "stopped"
  });

  it("(e) integration: a mind stuck writing FINAL a turn too early on every completion still exhausts the same 8-iteration cap upstream hits, with the same progress line", async () => {
    const stderrLines: string[] = [];
    const m = rec("stop69-stuck-8", UNCUT);
    const opts = stopOpts(m, {
      prompt: TWO_BLOCK_PROMPT,
      constants: { maxIterations: 8 },
      io: { stdout: () => {}, stderr: (s: string) => stderrLines.push(s) },
    });
    const result = await withRec(m, () => runShellm(opts));
    // 8 real completions; most carry the premature second block (the recorded model sometimes answers with the first
    // block alone after seeing its own cut turns, which is the point of the cut).
    expect(m.responses).toHaveLength(8);
    const hasSecond = m.responses.map((r) => /```[\s\S]*```[\s\S]*FINAL=/.test(r.text));
    expect(hasSecond.filter(Boolean).length).toBeGreaterThanOrEqual(4);

    expect(result.stopReason).toBe("max-iter");
    expect(result.iterations).toBe(8);
    expect(stderrLines.some((l) => l.includes("Max iterations (8) reached without final answer"))).toBe(true);

    // Every one of the 8 reasoning steps was cut the same way — none ever saw the "premature" FINAL text.
    const steps = opts.trajectory.read() as Record<string, unknown>[];
    const reasoningSteps = steps.filter((s) => s["type"] === "reasoning");
    expect(reasoningSteps).toHaveLength(8);
    reasoningSteps.forEach((s, k) => {
      expect(s["cmd"]).toBe(firstBlock(m.responses[k]!.text));
      expect(s["cmd"]).not.toContain("FINAL");
      // a cut happened exactly when there was text after the first block
      const t = m.responses[k]!.text;
      const cut = cutOf(t).trimEnd().length < t.trimEnd().length;
      expect(s["estimated"] === true).toBe(cut);
    });
  }, 60_000); // record mode makes real calls; replay is fast
});

// ---------------------------------------------------------------------------
// Upstream sync 2e39a3f — oracle: upstream's own tests/test_output_size_watchdog.sh
// and tests/test_shellm_run_tmpdir.sh (run against the real Bash by
// parity/upstream-tests/run.mjs). The sandbox-level guard mechanics are in
// test/sandbox-output-wall.test.ts; these cover the shellm loop around them.
describe("constantsFromEnv: SHELLM_MAX_OUTPUT_SIZE / SHELLM_MAX_EXEC_TIME (sync 2e39a3f)", () => {
  it("defaults are 10 MiB and 3600 s (in ms)", () => {
    const c = constantsFromEnv({});
    expect(c.maxOutputBytes).toBe(10_485_760);
    expect(c.maxExecMs).toBe(3_600_000);
  });
  it("overrides: bytes for output, seconds→ms for exec time; 0 keeps the guard off", () => {
    expect(constantsFromEnv({ SHELLM_MAX_OUTPUT_SIZE: "50000" }).maxOutputBytes).toBe(50_000);
    expect(constantsFromEnv({ SHELLM_MAX_OUTPUT_SIZE: "0" }).maxOutputBytes).toBe(0);
    expect(constantsFromEnv({ SHELLM_MAX_EXEC_TIME: "3" }).maxExecMs).toBe(3000);
    expect(constantsFromEnv({ SHELLM_MAX_EXEC_TIME: "0" }).maxExecMs).toBe(0);
  });
});

describe("runShellm: output / wall kills and the per-run TMPDIR (sync 2e39a3f)", () => {
  function opts(llm: LlmClient, stderrLines: string[], constants: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-sync-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "shellm-sync-wd-"));
    return {
      trajectory: createTrajectory(root),
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "system",
      prompt: "",
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "test-model", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {},
      io: { stdout: () => {}, stderr: (s: string) => stderrLines.push(s) },
      constants: { maxIterations: 1, inactivityTimeoutMs: 600_000, inactivityMaxMs: 600_000, ...constants },
    };
  }

  it(
    "a runaway producer is KILLED at SHELLM_MAX_OUTPUT_SIZE and the feedback names the output-size cause",
    async () => {
      const FLOOD = 'end=$((SECONDS+10)); while [ $SECONDS -lt $end ]; do printf "x%.0s" {1..1000}; echo; sleep 0.05; done';
      const m = rec("output-flood");
      const err: string[] = [];
      const o = { ...opts(m, err, { maxOutputBytes: 50_000 }), prompt: ASK("```bash\n" + FLOOD + "\n```") };
      await withRec(m, () => runShellm(o as Parameters<typeof runShellm>[0]));
      expect(firstBlock(m.responses[0]!.text)).toBe(FLOOD);
      expect(err.some((l) => l.includes("KILLED — output exceeded 50000 bytes"))).toBe(true);
      const shellOut = (o.trajectory.read() as Record<string, unknown>[]).find((s) => s["type"] === "shell-output")!;
      expect(shellOut["timed_out"]).toBe(true);
      expect(String(shellOut["feedback"])).toContain("output grew past");
    },
    30_000
  );

  it(
    "an endless heartbeat is KILLED at SHELLM_MAX_EXEC_TIME and the feedback names the wall-clock cause",
    async () => {
      const BEAT = 'while :; do echo "... waiting"; sleep 1; done';
      const m = rec("wall-heartbeat");
      const err: string[] = [];
      const o = { ...opts(m, err, { maxExecMs: 3000 }), prompt: ASK("```bash\n" + BEAT + "\n```") };
      await withRec(m, () => runShellm(o as Parameters<typeof runShellm>[0]));
      expect(firstBlock(m.responses[0]!.text)).toBe(BEAT);
      const shellOut = (o.trajectory.read() as Record<string, unknown>[]).find((s) => s["type"] === "shell-output")!;
      expect(shellOut["timed_out"]).toBe(true);
      expect(String(shellOut["feedback"])).toContain("the limit for one block");
    },
    30_000
  );

  it("the block's TMPDIR and mktemp land under the run dir and die with the run (local sandbox)", async () => {
    const PROBE = 'echo "$TMPDIR" > tmpdir.txt\nmktemp "${TMPDIR:-/tmp}/probe.XXXXXX" > mk.txt\nFINAL=done';
    const m = rec("run-tmpdir");
    const err: string[] = [];
    const o = { ...opts(m, err, {}), prompt: ASK("```bash\n" + PROBE + "\n```") };
    await withRec(m, () => runShellm(o as Parameters<typeof runShellm>[0]));
    expect(firstBlock(m.responses[0]!.text)).toBe(PROBE);
    const tmpdir = fs.readFileSync(path.join(o.workdir, "tmpdir.txt"), "utf8").trim();
    // (BSD mktemp ignores TMPDIR without a template — upstream's own test notes it — so use one.)
    const made = fs.readFileSync(path.join(o.workdir, "mk.txt"), "utf8").trim().replace(/\/\/+/g, "/");
    const seen = tmpdir.replace(/\/\/+/g, "/");
    expect(seen).toMatch(/headlong-run-[^/]+\/tmp$/);
    expect(made.startsWith(seen + "/")).toBe(true);
    expect(fs.existsSync(tmpdir)).toBe(false);
    expect(fs.existsSync(made)).toBe(false);
  });
});
