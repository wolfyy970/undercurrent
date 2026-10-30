// llmCli.test.ts — unit tests for the `llm` tool port (src/llmCli.ts).
//
// Behaviour, not text: these pin the CLI contract the sandbox and `mem search`
// depend on — argv quirks, prompt resolution, .env layering, model/provider/
// endpoint resolution and their stderr texts, the max-tokens table, the stdout
// newline asymmetry, retry/truncation semantics, exit codes, and the on-disk
// effects (health marker, ledger, LLM_USAGE_FILE). Everything runs against a
// local fake HTTP server (test/llmFakeServer.ts): deterministic, no network.
// Its replies are wire-format fixtures (SSE framing, BOM, finish reasons, usage chunks, delta boundaries for the
// stop-after-code-block cut) around placeholder text such as "ok"/"cut"/"echo hi"; not model output.
// The port is byte-compared against the real Bash tool by parity/llm.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runLlm, parseEnvFile, USAGE, type LlmIO } from "../src/llmCli.js";
import { spawnAdapterProcess } from "../src/llmAdapterProcess.js";
import {
  getModelMaxTokens,
  detectProvider,
  caseMatch,
  hostOf,
  classifyFailureKind,
  checkResponseOpenAI,
  extractTextOpenAI,
  errorMessageOf,
  buildOpenAIPayload,
  responseShapeErrorOpenAI,
  extractShapeErrorOpenAI,
  usageOpenAI,
  streamErrorMessageOf,
  parseJson,
} from "../src/llmProvider.js";
import { startFakeServer, R, type FakeServer, type FakeReply } from "./llmFakeServer.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let srv: FakeServer;
beforeAll(async () => {
  srv = await startFakeServer();
});
afterAll(async () => {
  await srv.close();
});

let TMP: string;
let HOME: string;
let HL: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "llm-test-"));
  HOME = path.join(TMP, "homedir");
  HL = path.join(TMP, "hl");
  fs.mkdirSync(HOME);
  srv.reset();
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

interface RunOpts {
  env?: Record<string, string | undefined>;
  stdin?: string;
  tty?: boolean;
  replies?: FakeReply[];
  /** Omit the default HEADLONG_HOME (to test the HOME fallback). */
  noHome?: boolean;
  /** Adapter deadline tests spawn REAL subprocesses on a real clock; instant sleep would race them. */
  realSleep?: boolean;
}
interface Result {
  code: number;
  out: string;
  err: string;
  /** stdout writes in order (proves streaming granularity). */
  writes: string[];
}

const NOW = new Date("2026-01-02T03:04:05.678Z");

async function run(argv: string[], opts: RunOpts = {}): Promise<Result> {
  if (opts.replies) srv.script(opts.replies);
  const writes: string[] = [];
  let err = "";
  const env: Record<string, string | undefined> = {
    HOME,
    ...(opts.noHome ? {} : { HEADLONG_HOME: HL }),
    LLM_RETRY_BACKOFF: "0",
    ...(opts.env ?? {}),
  };
  const io: LlmIO = {
    cwd: TMP,
    env,
    stdout: (s) => writes.push(s),
    stderr: (s) => {
      err += s;
    },
    readStdin: () => opts.stdin ?? "",
    stdinIsTTY: opts.tty ?? false,
    now: () => NOW,
    fetch: globalThis.fetch,
    fs,
    sleep: opts.realSleep ? (ms) => new Promise((r) => setTimeout(r, ms)) : async () => {},
    spawnAdapter: spawnAdapterProcess,
    randomToken: () => crypto.randomBytes(6).toString("hex"),
  };
  const code = await runLlm(argv, io);
  return { code, out: writes.join(""), err, writes };
}

/** The default streaming happy path against the fake server as openai-compatible. */
const COMPAT = (): Record<string, string> => ({ LLM_PROVIDER: "openai-compatible", LLM_API_URL: srv.url, LLM_RETRIES: "0" });
/** openrouter with a stub key, endpoint rerouted (the URL warning is expected). */
const OR = (): Record<string, string> => ({ OPENROUTER_API_KEY: "test-key", LLM_API_URL: srv.url });
const URL_WARN = (p = "openrouter") =>
  `llm: warning: LLM_API_URL overrides the default ${p} endpoint (requests go to 127.0.0.1:${srv.port})\n`;

const health = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(HL, "run", "llm_health.json"), "utf8"));
const healthRaw = (): string => fs.readFileSync(path.join(HL, "run", "llm_health.json"), "utf8");
const ledgerLines = (p = path.join(HL, "usage", "llm.jsonl")): Record<string, unknown>[] =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const lastReq = () => srv.requests[srv.requests.length - 1]!;
const payload = () => lastReq().json as Record<string, unknown>;

// --- pure helpers -------------------------------------------------------------

describe("bash-glob caseMatch", () => {
  it("handles *, ?, character classes and alternation", () => {
    expect(caseMatch("gpt-5.5", "gpt-[5-9]*|o[1-9]*")).toBe(true);
    expect(caseMatch("o3-mini", "gpt-[5-9]*|o[1-9]*")).toBe(true);
    expect(caseMatch("gpt-4o", "gpt-[5-9]*|o[1-9]*")).toBe(false);
    expect(caseMatch("a/b", "*/*")).toBe(true);
    expect(caseMatch("ab", "*/*")).toBe(false);
    expect(caseMatch("x.y", "x?y")).toBe(true);
    expect(caseMatch("gpt-4.turbo", "gpt-4-turbo*")).toBe(false); // '.' is literal
  });
});

describe("detectProvider", () => {
  it("classifies each family in bash order", () => {
    expect(detectProvider("claude-sonnet-4-5")).toBe("anthropic");
    expect(detectProvider("gpt-4o")).toBe("openai");
    expect(detectProvider("o1")).toBe("openai");
    expect(detectProvider("o3-mini")).toBe("openai");
    expect(detectProvider("o4-mini")).toBe("openai");
    expect(detectProvider("chatgpt-4o-latest")).toBe("openai");
    expect(detectProvider("gemini-2.0-flash")).toBe("gemini");
    expect(detectProvider("opencode-go/glm-5")).toBe("opencode-go");
    expect(detectProvider("opencode/claude-x")).toBe("opencode");
    expect(detectProvider("z-ai/glm-5.2")).toBe("openrouter");
    expect(detectProvider("anthropic/claude-sonnet-4.5")).toBe("openrouter");
    expect(detectProvider("qwen3:8b")).toBeNull();
    expect(detectProvider("my-local-alias")).toBeNull();
  });
});

describe("getModelMaxTokens (bin/llm table, verbatim)", () => {
  const rows: [string, string, number][] = [
    ["claude-opus-4-7-20260101", "anthropic", 128000],
    ["claude-opus-4-0", "anthropic", 128000],
    ["claude-opus-4-8", "anthropic", 4096], // not in the table → provider fallback
    ["claude-sonnet-4-7", "anthropic", 128000],
    ["claude-sonnet-4-6", "anthropic", 128000],
    ["claude-sonnet-4-5-20250929", "anthropic", 64000],
    ["claude-sonnet-4-0", "anthropic", 64000],
    ["claude-haiku-4-5", "anthropic", 64000],
    ["claude-3-5-sonnet-20241022", "anthropic", 8192],
    ["claude-3-5-haiku", "anthropic", 8192],
    ["claude-3-opus", "anthropic", 4096],
    ["claude-3-haiku", "anthropic", 4096],
    ["o1", "openai", 100000],
    ["o3-mini", "openai", 100000],
    ["o4-mini", "openai", 100000],
    ["gpt-5.5", "openai", 128000],
    ["gpt-5", "openai", 128000],
    ["gpt-4o-mini", "openai", 16384],
    ["gpt-4-turbo", "openai", 4096],
    ["gpt-4", "openai", 8192],
    ["gpt-4.1", "openai", 8192],
    ["gpt-3.5-turbo", "openai", 4096],
    ["gemini-2.0-flash", "gemini", 8192],
    ["gemini-3.5-flash", "gemini", 65536],
    ["anthropic/claude-sonnet-4.5", "openrouter", 64000],
    ["x-ai/grok-4", "openrouter", 64000],
    ["x-ai/grok-3", "openrouter", 64000],
    ["openai/gpt-oss-120b", "openrouter", 16384],
    ["qwen/qwen3", "openrouter", 16384],
    ["qwen3:8b", "openai-compatible", 16384],
    ["gpt-5", "openai-compatible", 128000], // known names keep their caps through a proxy
    ["whatever", "adapter", 16384],
    ["my-local-alias", "openai", 4096],
    // opencode-go catalog (provider-scoped)
    ["glm-5", "opencode-go", 32768],
    ["kimi-k2", "opencode-go", 32768],
    ["qwen3-coder", "opencode-go", 32768],
    ["minimax-m2", "opencode-go", 32768],
    ["deepseek-v4-flash", "opencode-go", 32768],
    ["grok-code", "opencode-go", 32768],
    ["longcat-x", "opencode-go", 32768],
    ["mimo-x", "opencode-go", 32768],
    ["hy3-x", "opencode-go", 32768],
    ["muse-x", "opencode-go", 32768],
    ["ox-alpha-1", "opencode-go", 32768],
    ["gpt-5", "opencode-go", 16384], // opencode-go table wins over the generic one
    ["something", "opencode-go", 16384],
  ];
  for (const [model, provider, n] of rows) {
    it(`${provider}: ${model} → ${n}`, () => expect(getModelMaxTokens(model, provider)).toBe(n));
  }
});

describe("hostOf", () => {
  it("strips scheme, path, query, fragment and userinfo", () => {
    expect(hostOf("http://user:hunter2@127.0.0.1:9/v1?token=topsecret")).toBe("127.0.0.1:9");
    expect(hostOf("http://127.0.0.1:9#token=topsecret")).toBe("127.0.0.1:9");
    expect(hostOf("https://api.example.com/v1/chat")).toBe("api.example.com");
    expect(hostOf("localhost:11434/v1")).toBe("localhost:11434");
  });
});

describe("classifyFailureKind", () => {
  it("http code beats words; words are the fallback", () => {
    expect(classifyFailureKind("402", "anything")).toBe("credit");
    expect(classifyFailureKind("401", "x")).toBe("auth");
    expect(classifyFailureKind("403", "x")).toBe("auth");
    expect(classifyFailureKind("429", "You exceeded your current quota")).toBe("rate");
    expect(classifyFailureKind("", "Insufficient credits")).toBe("credit");
    expect(classifyFailureKind("", "Invalid API key")).toBe("auth");
    expect(classifyFailureKind("", "Rate limit exceeded")).toBe("rate");
    expect(classifyFailureKind("", "model overloaded")).toBe("rate");
    expect(classifyFailureKind("400", "bad request")).toBe("other");
    expect(classifyFailureKind("000", "HTTP 000")).toBe("other");
  });
});

describe("jq-faithful readers", () => {
  it("checkResponseOpenAI: first embedded failure, or nothing; a jq path error yields nothing", () => {
    expect(checkResponseOpenAI({ error: { message: "e" } })).toBe("e");
    expect(checkResponseOpenAI({ choices: [{ error: { message: "ce" } }] })).toBe("ce");
    expect(checkResponseOpenAI({ choices: [{ finish_reason: "error" }] })).toBe(
      'finish_reason "error" (provider failed mid-generation)'
    );
    expect(checkResponseOpenAI({ choices: [{ message: { content: "x" } }] })).toBe("");
    // `{error:"a string"}` is NOT a "" success: jq aborts (`Cannot index string
    // with "message"`) and the Bash exits 5 under `set -e`. The reader still
    // yields "" (jq printed nothing), but the shape probe flags the abort and
    // the CLI dies before the ok marker (see "jq shape crashes" below).
    expect(checkResponseOpenAI({ error: "a string" })).toBe("");
    expect(responseShapeErrorOpenAI({ error: "a string" })).toBe(true);
    expect(responseShapeErrorOpenAI({ choices: "str" })).toBe(true);
    expect(responseShapeErrorOpenAI({ choices: [{ message: { content: "ok" }, error: "str" }] })).toBe(true);
    expect(responseShapeErrorOpenAI({ choices: [{ message: { content: "x" } }] })).toBe(false);
    expect(extractShapeErrorOpenAI({ choices: [{ message: "hi" }] })).toBe(true);
    expect(extractShapeErrorOpenAI({ choices: [{ message: {} }] })).toBe(false);
  });
  it("extractTextOpenAI: null on absent content (prints nothing), '' kept", () => {
    expect(extractTextOpenAI({ choices: [{ message: { content: "" } }] })).toBe("");
    expect(extractTextOpenAI({ choices: [{ message: {} }] })).toBeNull();
    expect(extractTextOpenAI({ choices: [] })).toBeNull();
    expect(extractTextOpenAI("nope")).toBeNull();
  });
  it("errorMessageOf: .error.message // .message // empty", () => {
    expect(errorMessageOf({ error: { message: "m" } })).toBe("m");
    expect(errorMessageOf({ message: "top" })).toBe("top");
    expect(errorMessageOf({ error: "s" })).toBe("");
    expect(errorMessageOf(null)).toBe("");
  });
});

describe("buildOpenAIPayload", () => {
  it("system message first, tokens field by model, stream_options only when streaming", () => {
    const a = buildOpenAIPayload({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], system: "S", stream: true, maxTokens: 5, thinkingLevel: "", assumeThinking: false });
    expect(a.payload).toEqual({
      model: "gpt-4o",
      messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
      stream: true,
      max_tokens: 5,
      stream_options: { include_usage: true },
    });
    const b = buildOpenAIPayload({ model: "gpt-5", messages: [], system: "", stream: false, maxTokens: 7, thinkingLevel: "high", assumeThinking: false });
    expect(b.payload).toEqual({ model: "gpt-5", messages: [], stream: false, max_completion_tokens: 7, reasoning: { effort: "high", summary: "auto" } });
    expect(b.notes).toEqual([]);
    const c = buildOpenAIPayload({ model: "gpt-4o", messages: [], system: "", stream: false, maxTokens: 7, thinkingLevel: "low", assumeThinking: false });
    expect(c.payload).not.toHaveProperty("reasoning");
    expect(c.notes).toEqual(["llm: --thinking ignored: gpt-4o not in the known-reasoning model list (LLM_ASSUME_THINKING=1 to send anyway)"]);
    const d = buildOpenAIPayload({ model: "gpt-4o", messages: [], system: "", stream: false, maxTokens: 7, thinkingLevel: "low", assumeThinking: true });
    expect(d.payload["reasoning"]).toEqual({ effort: "low", summary: "auto" });
  });
});

describe("parseEnvFile", () => {
  it("parses [export ]KEY=VALUE, strips one quote layer, later wins, ignores comments/junk", () => {
    const m = parseEnvFile('# c\nexport A=1\n  B="two"\nC=\'three\'\nnot a line\nE = spaced\nA=override\nD=x=y\n');
    expect([...m]).toEqual([
      ["A", "override"],
      ["B", "two"],
      ["C", "three"],
      ["D", "x=y"],
    ]);
  });
});

// --- adversarial-run fixes (parity/llm/report-adversarial.md, F1–F13) ---------
// Each reproduces a divergence the independent verifier found against the real
// Bash; the expectation is the Bash's behaviour. F10 (EPIPE → exit 141) lives in
// bin/llm.mjs and is covered by the adversarial stream/epipe-reader-closes-early.

describe("adversarial-run fixes (F1–F13)", () => {
  it("F1: a scheme-less LLM_API_URL gets http:// like curl", async () => {
    const r = await run(["-m", "x", "hi"], { env: { ...COMPAT(), LLM_API_URL: srv.url.replace(/^http:\/\//, "") }, replies: [R.sseOk] });
    expect(r).toMatchObject({ code: 0, out: "ok", err: "" });
    expect(srv.requests.length).toBe(1);
  });
  it("F2: trailing newlines of a jq-derived message are stripped ($(…)); a newline-only message falls back to the raw body", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [{ body: '{"error":{"message":"oops\\n"}}' }] });
    expect(r).toMatchObject({ code: 1, out: "", err: URL_WARN() + "llm: error: API error: oops\n" });
    srv.reset();
    const r2 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [{ status: 400, body: '{"error":{"message":"bad\\n"}}' }] });
    expect(r2).toMatchObject({ code: 1, out: "", err: URL_WARN() + "llm: error: API error (HTTP 400): bad\n" });
    expect(health()["message"]).toBe("bad");
    expect(streamErrorMessageOf('{"error":{"message":"\\n"}}')).toBe("");
    srv.reset();
    const r3 = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [{ sse: true, body: '{"error":{"message":"\\n"}}\n' }] });
    expect(r3).toMatchObject({ code: 1, out: "", err: 'llm: error: API error: {"error":{"message":"\\n"}}\n' });
  });
  it("F3: a UTF-8 BOM before the JSON body is tolerated (jq accepts it)", async () => {
    const r = await run(["-m", "x", "--no-stream", "hi"], { env: COMPAT(), replies: [{ body: '\ufeff{"choices":[{"message":{"content":"bom-ok"}}]}' }] });
    expect(r).toMatchObject({ code: 0, out: "bom-ok\n", err: "" });
    expect(parseJson("\ufeff[1]")).toEqual({ ok: true, value: [1] });
  });
  it("F4: the marker classifier's `.` spans newlines like bash ERE", () => {
    expect(classifyFailureKind("", "invalid\nkey")).toBe("auth");
    expect(classifyFailureKind("", "rate\nlimit")).toBe("rate");
  });
  it("F5: only ASCII whitespace makes a whitespace-only body (grep [[:space:]] under LC_ALL=C); NBSP is a non-JSON body", async () => {
    const r = await run(["-m", "x", "--no-stream", "hi"], { env: { ...COMPAT(), LLM_RETRIES: "1" }, replies: [{ body: "\u00a0\u00a0" }] });
    expect(r).toMatchObject({ code: 1, out: "", err: "llm: error: API error: response body is not JSON (HTTP 200)\n" });
    expect(srv.requests.length).toBe(1);
  });
  it("F6: a non-ASCII API key reaches the wire as UTF-8 bytes (curl), not Latin-1 or a fetch ByteString error", async () => {
    const r = await run(["-m", "x", "hi"], { env: { ...COMPAT(), LLM_API_KEY: "s\u00e9k\u65e5" }, replies: [R.sseOk] });
    expect(r).toMatchObject({ code: 0, out: "ok", err: "" });
    // node hands header bytes over as latin1; re-encoding recovers the UTF-8 text curl sends.
    expect(Buffer.from(srv.requests[0]!.headers["authorization"]!, "latin1").toString("utf8")).toBe("Bearer s\u00e9k\u65e5");
  });
  it("F7: an unterminated last line is delivered even when the body then errors (bash `read` sees it)", async () => {
    const r = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [{ sse: true, chunks: ['{"error":{"message":"Insufficient credits"}}'], destroy: true }] });
    expect(r).toMatchObject({ code: 1, out: "", err: "llm: error: API error: Insufficient credits\n" });
    expect(health()).toMatchObject({ ok: false, kind: "credit", message: "API error: Insufficient credits" });
  });
  it("F8: the truncation warning prints the -t / LLM_MAX_TOKENS text verbatim", async () => {
    const r = await run(["-m", "x", "-t", "007", "hi"], { env: COMPAT(), replies: [R.sseFinishLength] });
    expect(r.err).toBe("llm: warning: output truncated at max_tokens=007 (reasoning tokens count against it) — raise with -t\n");
    expect(srv.requests[0]!.json).toMatchObject({ max_tokens: 7 });
  });
  it("F9: `export<tab>KEY=` is accepted (sed export[[:space:]]+)", () => {
    expect([...parseEnvFile("export\tA=1\nexport  B=2\nexport\u000bC=3\n")]).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
    ]);
  });
  it("F11: a 2xx JSON whose shape aborts the jq checker dies BEFORE the ok marker; an extractor abort dies after marker + ledger", async () => {
    const r = await run(["-m", "x", "--no-stream", "hi"], { env: { ...COMPAT(), LLM_RETRIES: "2" }, replies: [{ body: '{"error":"plain string"}' }] });
    expect(r).toMatchObject({ code: 1, out: "", err: "llm: error: API error: response shape is not readable (HTTP 200)\n" });
    expect(srv.requests.length).toBe(1); // no retry
    expect(fs.existsSync(path.join(HL, "run", "llm_health.json"))).toBe(false);
    srv.reset();
    const r2 = await run(["-m", "x", "--no-stream", "hi"], { env: COMPAT(), replies: [{ body: '{"choices":[{"message":"hi"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}' }] });
    expect(r2).toMatchObject({ code: 1, out: "", err: "llm: error: API error: response text is not readable (HTTP 200)\n" });
    expect(health()["ok"]).toBe(true);
    expect(ledgerLines()).toHaveLength(1);
  });
  it("F12: a usage token that is an object/array voids the whole record (jq @tsv aborts)", () => {
    expect(usageOpenAI({ usage: { prompt_tokens: { x: 1 }, completion_tokens: 5 } })).toEqual({ ok: false, rec: {} });
    expect(usageOpenAI({ usage: { prompt_tokens: 1, completion_tokens: [5] } })).toEqual({ ok: false, rec: {} });
    expect(usageOpenAI({ usage: { prompt_tokens: 1, completion_tokens: "5" } })).toEqual({ ok: true, rec: { in_tok: 1, out_tok: 5 } });
  });
  it("F13: U+007F is escaped as \\u007f in every JSON the tool writes (as jq prints it)", async () => {
    await run(["-m", "x", "hi"], { env: COMPAT(), replies: [{ sse: true, body: '{"error":{"message":"a\\u007fb"}}\n' }] });
    expect(healthRaw()).toContain('"message": "API error: a\\u007fb"');
    expect(health()["message"]).toBe("API error: a\u007fb");
  });
});

// --- argv parsing -------------------------------------------------------------

describe("argv parsing", () => {
  it("-h/--help prints usage to stdout, exit 0", async () => {
    for (const f of ["-h", "--help"]) {
      const r = await run([f]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(USAGE);
      expect(r.out.startsWith("Usage:\n  llm [options] prompt...")).toBe(true);
      expect(r.out).toContain("Keys: `opencode auth login`");
      expect(r.err).toBe("");
    }
  });
  it("unknown option dies with the hint", async () => {
    const r = await run(["--bogus", "hi"]);
    expect(r).toMatchObject({ code: 1, out: "", err: "llm: error: Unknown option: --bogus (try llm --help)\n" });
    expect((await run(["-", "hi"])).err).toBe("llm: error: Unknown option: - (try llm --help)\n");
  });
  it("value-requiring flags die on a missing OR empty value (`${2:?}`)", async () => {
    const cases: [string[], string][] = [
      [["-m"], "--model requires a value"],
      [["--model", ""], "--model requires a value"],
      [["-s"], "--system-prompt requires a value"],
      [["--system-prompt-file"], "--system-prompt-file requires a path"],
      [["-t"], "--max-tokens requires a value"],
      [["-M", ""], "--messages requires a value"],
      [["--provider"], "--provider requires a value"],
      [["--effort"], "--effort requires a value"],
    ];
    for (const [argv, msg] of cases) {
      const r = await run(argv);
      expect(r, argv.join(" ")).toMatchObject({ code: 1, out: "", err: `llm: error: ${msg}\n` });
    }
  });
  it("--system-prompt-file: missing dies; present is read with trailing newlines stripped", async () => {
    const r = await run(["--system-prompt-file", "nope.txt", "hi"]);
    expect(r).toMatchObject({ code: 1, err: "llm: error: System prompt file not found: nope.txt\n" });
    fs.writeFileSync(path.join(TMP, "sys.txt"), "be terse\n\n\n");
    const r2 = await run(["-m", "x", "--system-prompt-file", "sys.txt", "hi"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r2.code).toBe(0);
    expect((payload()["messages"] as unknown[])[0]).toEqual({ role: "system", content: "be terse" });
  });
  it("--messages-file (upstream 136f32b): missing dies; present is read with trailing newlines stripped, same as -M", async () => {
    const r = await run(["--messages-file", "nope.json"]);
    expect(r).toMatchObject({ code: 1, err: "llm: error: Messages file not found: nope.json\n" });
    fs.writeFileSync(path.join(TMP, "msgs.json"), '[{"role":"user","content":"hi"}]\n\n\n');
    const r2 = await run(["-m", "x", "--messages-file", "msgs.json"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r2.code).toBe(0);
    expect(payload()["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });
  it("first non-dash arg starts the prompt: ALL remaining argv joined by spaces, later flags included", async () => {
    const r = await run(["-m", "x", "hello", "world", "-m", "other", "--no-stream"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["model"]).toBe("x");
    expect(payload()["stream"]).toBe(true); // --no-stream was part of the prompt
    expect(payload()["messages"]).toEqual([{ role: "user", content: "hello world -m other --no-stream" }]);
  });
  it("an empty first positional still starts the prompt (joined with a leading space)", async () => {
    const r = await run(["-m", "x", "", "foo"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["messages"]).toEqual([{ role: "user", content: " foo" }]);
  });
  it("--thinking is greedy: swallows the next argv unless it starts with '-' or is empty", async () => {
    await run(["-m", "gpt-5", "--thinking", "high", "hi"], { env: { ...COMPAT(), LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" }, replies: [R.sseOk] });
    expect(payload()["reasoning"]).toEqual({ effort: "high", summary: "auto" });
    expect(payload()["messages"]).toEqual([{ role: "user", content: "hi" }]);
    srv.reset();
    await run(["-m", "gpt-5", "--thinking", "-t", "9", "hi"], { env: { ...COMPAT(), LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" }, replies: [R.sseOk] });
    expect(payload()).not.toHaveProperty("reasoning"); // bare --thinking: silent no-op on this family
    expect(payload()["max_completion_tokens"]).toBe(9);
    srv.reset();
    // Greedy even when the "level" is really the prompt: prompt is gone → dies.
    const r = await run(["-m", "gpt-5", "--thinking", "hi"], { env: { ...COMPAT(), LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" } });
    expect(r).toMatchObject({ code: 1, err: "llm: error: No prompt or messages provided\n" });
  });
  it("--effort is accepted and ignored on the OpenAI family; --raw and --stream are accepted", async () => {
    const r = await run(["-m", "x", "--effort", "max", "--stream", "--raw", "hi"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("ok"); // streaming: --raw ignored
    expect(payload()).not.toHaveProperty("reasoning");
    expect(payload()).not.toHaveProperty("effort");
  });
});

// --- prompt resolution --------------------------------------------------------

describe("prompt resolution", () => {
  it("no positional and no -M: stdin (not a TTY) with trailing newlines stripped", async () => {
    const r = await run(["-m", "x"], { env: COMPAT(), stdin: "from stdin\nline2\n\n\n", replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["messages"]).toEqual([{ role: "user", content: "from stdin\nline2" }]);
  });
  it("neither positional, -M, nor stdin → error", async () => {
    expect(await run(["-m", "x"], { env: COMPAT(), stdin: "" })).toMatchObject({ code: 1, out: "", err: "llm: error: No prompt or messages provided\n" });
    expect(await run(["-m", "x"], { env: COMPAT(), stdin: "\n\n" })).toMatchObject({ code: 1, err: "llm: error: No prompt or messages provided\n" });
    expect(await run(["-m", "x"], { env: COMPAT(), stdin: "ignored on a tty", tty: true })).toMatchObject({ code: 1, err: "llm: error: No prompt or messages provided\n" });
  });
  it("-M passes the messages JSON through verbatim; a positional prompt is silently dropped", async () => {
    const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c", extra: 1 }];
    const r = await run(["-m", "x", "-M", JSON.stringify(msgs), "dropped", "prompt"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["messages"]).toEqual(msgs);
  });
  it("-M is not validated structurally; invalid JSON dies (PORT-NOTE: exit 1, Bash exits 5 via jq)", async () => {
    await run(["-m", "x", "-M", '{"not":"an array"}'], { env: COMPAT(), replies: [R.sseOk] });
    expect(payload()["messages"]).toEqual({ not: "an array" });
    const r = await run(["-m", "x", "-M", "notjson"], { env: COMPAT() });
    expect(r).toMatchObject({ code: 1, err: "llm: error: --messages is not valid JSON\n" });
    const r2 = await run(["-m", "x", "-s", "S", "-M", '{"a":1}'], { env: COMPAT() });
    expect(r2).toMatchObject({ code: 1, err: "llm: error: --messages must be a JSON array (cannot prepend the system message)\n" });
  });
});

// --- .env layering ------------------------------------------------------------

describe(".env layering", () => {
  it("cwd .env fills missing vars; the state home's .env fills what is still missing; real env wins", async () => {
    fs.mkdirSync(HL, { recursive: true });
    fs.writeFileSync(path.join(TMP, ".env"), 'LLM_PROVIDER=openai-compatible\nexport LLM_API_URL="' + srv.url + '"\nLLM_MODEL=cwd-model\n');
    fs.writeFileSync(path.join(HL, ".env"), "LLM_MODEL=home-model\nLLM_API_KEY=home-key\nLLM_RETRIES=0\n");
    const r = await run(["hi"], { env: { LLM_API_KEY: "env-key" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["model"]).toBe("cwd-model"); // cwd beats home
    expect(lastReq().headers["authorization"]).toBe("Bearer env-key"); // env beats both files
  });
  it("a set-but-empty env var counts as set (not filled from .env)", async () => {
    fs.writeFileSync(path.join(TMP, ".env"), "LLM_MODEL=from-file\n");
    const r = await run(["hi"], { env: { ...COMPAT(), LLM_MODEL: "" } });
    // LLM_MODEL stays "" → no model → provider openai-compatible has no key → die on no model
    expect(r.code).toBe(1);
    expect(r.err).toContain("No model specified and no API key found");
  });
  it("cwd .env may set HEADLONG_HOME, which decides where the second .env and the marker live", async () => {
    const alt = path.join(TMP, "alt-home");
    fs.mkdirSync(alt);
    fs.writeFileSync(path.join(TMP, ".env"), `HEADLONG_HOME=${alt}\n`);
    fs.writeFileSync(path.join(alt, ".env"), `LLM_PROVIDER=openai-compatible\nLLM_API_URL=${srv.url}\nLLM_RETRIES=0\n`);
    const r = await run(["-m", "x", "hi"], { noHome: true, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(alt, "run", "llm_health.json"))).toBe(true);
  });
  it("without HEADLONG_HOME/SHELLM_HOME the state home is $HOME/.headlong", async () => {
    const r = await run(["-m", "x", "hi"], { noHome: true, env: COMPAT(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(HOME, ".headlong", "run", "llm_health.json"))).toBe(true);
    srv.reset();
    const sh = path.join(TMP, "shellm-home");
    const r2 = await run(["-m", "x", "hi"], { noHome: true, env: { ...COMPAT(), SHELLM_HOME: sh }, replies: [R.sseOk] });
    expect(r2.code).toBe(0);
    expect(fs.existsSync(path.join(sh, "run", "llm_health.json"))).toBe(true);
  });
});

// --- model / provider / endpoint resolution ------------------------------------

describe("model resolution", () => {
  it("dies with the exact text when nothing picks a model", async () => {
    const r = await run(["hi"]);
    expect(r).toMatchObject({
      code: 1,
      err: "llm: error: No model specified and no API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENCODE_API_KEY, or pass -m MODEL.\n",
    });
  });
  it("-m > LLM_MODEL > SHELLM_MODEL > key-based default", async () => {
    await run(["-m", "flag", "hi"], { env: { ...COMPAT(), LLM_MODEL: "envm", SHELLM_MODEL: "shm" }, replies: [R.sseOk] });
    expect(payload()["model"]).toBe("flag");
    srv.reset();
    await run(["hi"], { env: { ...COMPAT(), LLM_MODEL: "envm", SHELLM_MODEL: "shm" } });
    expect(payload()["model"]).toBe("envm");
    srv.reset();
    await run(["hi"], { env: { ...COMPAT(), SHELLM_MODEL: "shm" } });
    expect(payload()["model"]).toBe("shm");
  });
  it("key-based defaults, in precedence order (SHELLM_FAST_MODEL is not read)", async () => {
    const r = await run(["hi"], { env: { OPENROUTER_API_KEY: "k", SHELLM_FAST_MODEL: "ignored", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["model"]).toBe("anthropic/claude-sonnet-4.5");
    expect(payload()["max_tokens"]).toBe(64000);
    // Precedence: ANTHROPIC_API_KEY beats OPENAI_API_KEY; GEMINI_API_KEY beats
    // OPENROUTER_API_KEY. The health marker (written on every call, success or
    // failure) proves which model was picked without needing a matching reply
    // shape from the fake server.
    srv.reset();
    await run(["hi"], { env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" } });
    expect(health()["model"]).toBe("claude-sonnet-4-5-20250929");
    srv.reset();
    await run(["hi"], { env: { GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" } });
    expect(health()["model"]).toBe("gemini-3.5-flash");
    srv.reset();
    await run(["hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(payload()["model"]).toBe("gpt-5.5");
    expect(payload()["max_completion_tokens"]).toBe(128000);
    srv.reset();
    await run(["hi"], { env: { OPENCODE_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(payload()["model"]).toBe("deepseek-v4-flash"); // opencode-go/ prefix stripped
    expect(payload()["max_tokens"]).toBe(32768);
  });
});

describe("provider resolution", () => {
  it("unclassifiable name without a provider dies", async () => {
    const r = await run(["-m", "my-local-alias", "hi"], { env: { OPENAI_API_KEY: "k" } });
    expect(r).toMatchObject({ code: 1, err: "llm: error: Cannot detect provider for model 'my-local-alias'. Use --provider.\n" });
  });
  it("LLM_PROVIDER reaches an unclassifiable name silently; a contradicted classifiable name warns", async () => {
    const r = await run(["-m", "my-local-alias", "hi"], { env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.err).toBe(URL_WARN("openai"));
    const r2 = await run(["-m", "claude-sonnet-4-5", "hi"], { env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r2.code).toBe(0);
    expect(r2.err).toBe(
      "llm: warning: LLM_PROVIDER=openai overrides detected provider 'anthropic' for model 'claude-sonnet-4-5'\n" + URL_WARN("openai")
    );
    expect(lastReq().headers["authorization"]).toBe("Bearer k");
  });
  it("--provider beats LLM_PROVIDER and silences the mismatch warning", async () => {
    const r = await run(["-m", "claude-sonnet-4-5", "--provider", "openai-compatible", "hi"], { env: { LLM_PROVIDER: "openai", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
  it("a typo'd provider dies naming the problem — after the warnings the Bash also prints", async () => {
    const r = await run(["-m", "gpt-4o", "-t", "abc", "hi"], { env: { LLM_PROVIDER: "openai-compatibel", LLM_API_URL: "http://u:p@127.0.0.1:9/x?t=1", OPENROUTER_API_KEY: "k" } });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "llm: warning: LLM_PROVIDER=openai-compatibel overrides detected provider 'openai' for model 'gpt-4o'\n" +
        "llm: warning: LLM_API_URL overrides the default openai-compatibel endpoint (requests go to 127.0.0.1:9)\n" +
        "llm: warning: ignoring non-numeric LLM_MAX_TOKENS='abc'\n" +
        "llm: error: Unknown provider: openai-compatibel (see --provider in --help for the list)\n"
    );
  });
  it("prefix strip: opencode-go/ and opencode/ are removed before the payload/table", async () => {
    const r = await run(["-m", "opencode-go/glm-5", "hi"], { env: { OPENCODE_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.err).toBe(URL_WARN("opencode-go"));
    expect(payload()["model"]).toBe("glm-5");
    expect(payload()["max_tokens"]).toBe(32768);
    expect(health()["model"]).toBe("glm-5");
  });
});

describe("OpenRouter provider routing (--or-*/LLM_OR_*, upstream 015d081/cf9e0ab)", () => {
  const M = ["-m", "openai/gpt-4o-mini"]; // classifies as openrouter (*/*)
  const ORR = (): Record<string, string> => ({ OPENROUTER_API_KEY: "test-key", OPENAI_API_KEY: "test-key", LLM_API_URL: srv.url, LLM_RETRIES: "0" });

  it("unpinned callers are unchanged: no provider block", async () => {
    const r = await run([...M, "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["provider"]).toBeUndefined();
  });

  it("--or-only pins provider.only, leaves allow_fallbacks alone", async () => {
    const r = await run([...M, "--or-only", "openai", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["provider"]).toEqual({ only: ["openai"] });
  });

  it("the slug list is downcased, trimmed and de-blanked", async () => {
    const r = await run([...M, "--or-only", " OpenAI , Azure ,, ", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect((payload()["provider"] as Record<string, unknown>)["only"]).toEqual(["openai", "azure"]);
  });

  it("a pin that normalises away is refused", async () => {
    const r = await run([...M, "--or-only", " , ,", "hi"], { env: ORR() });
    expect(r.code).toBe(1);
    expect(r.err).toBe(URL_WARN("openrouter") + "llm: error: --or-only/LLM_OR_ONLY had no provider slugs left after normalization\n");
  });

  it("--or-data-collection deny is passed through; an unknown value is refused", async () => {
    const r = await run([...M, "--or-data-collection", "deny", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect((payload()["provider"] as Record<string, unknown>)["data_collection"]).toBe("deny");

    const r2 = await run([...M, "--or-data-collection", "nope", "hi"], { env: ORR() });
    expect(r2.code).toBe(1);
    expect(r2.err).toBe(URL_WARN("openrouter") + "llm: error: --or-data-collection/LLM_OR_DATA_COLLECTION must be allow or deny (got 'nope')\n");
  });

  it("--or-zdr requests zero-data-retention endpoints", async () => {
    const r = await run([...M, "--or-zdr", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect((payload()["provider"] as Record<string, unknown>)["zdr"]).toBe(true);
  });

  it.each(["true", "yes", "on", "1", "TRUE", "On"])("LLM_OR_ZDR=%s is honoured as true", async (v) => {
    const r = await run([...M, "hi"], { env: { ...ORR(), LLM_OR_ZDR: v }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect((payload()["provider"] as Record<string, unknown>)["zdr"]).toBe(true);
  });

  it.each(["false", "no", "0", "FALSE", ""])("LLM_OR_ZDR=%s is honoured as off (no provider block)", async (v) => {
    const r = await run([...M, "hi"], { env: { ...ORR(), LLM_OR_ZDR: v }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["provider"]).toBeUndefined();
  });

  it("an unparseable LLM_OR_ZDR is refused, not read as false", async () => {
    const r = await run([...M, "hi"], { env: { ...ORR(), LLM_OR_ZDR: "maybe" } });
    expect(r.code).toBe(1);
    expect(r.err).toBe(URL_WARN("openrouter") + "llm: error: --or-zdr/LLM_OR_ZDR must be 1/true/yes/on or 0/false/no/empty (got 'maybe')\n");
  });

  it("all three knobs compose into one provider block", async () => {
    const r = await run([...M, "--or-only", "openai", "--or-data-collection", "deny", "--or-zdr", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(payload()["provider"]).toEqual({ only: ["openai"], data_collection: "deny", zdr: true });
  });

  it("an environment-supplied constraint is announced on stderr; a CLI-typed one is not", async () => {
    const r = await run([...M, "hi"], { env: { ...ORR(), LLM_OR_ONLY: "azure" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect((payload()["provider"] as Record<string, unknown>)["only"]).toEqual(["azure"]);
    expect(r.err).toBe(URL_WARN("openrouter") + "llm: routing: openrouter only=azure\n");

    const r2 = await run([...M, "--or-only", "azure", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r2.code).toBe(0);
    expect(r2.err).toBe(URL_WARN("openrouter"));
  });

  it("an explicitly named openrouter provider takes the knobs the same as inferred", async () => {
    const r = await run([...M, "--provider", "openrouter", "--or-only", "openai", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect((payload()["provider"] as Record<string, unknown>)["only"]).toEqual(["openai"]);
  });

  it("an --or-* flag on another provider warns, adds no provider block, and does not fail the call", async () => {
    const r = await run([...M, "--provider", "openai", "-m", "gpt-4o-mini", "--or-zdr", "hi"], { env: ORR(), replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.err).toContain("llm: warning: --or-*/LLM_OR_* are OpenRouter-only and ignored for provider 'openai'\n");
    expect(payload()["provider"]).toBeUndefined();
  });
});

describe("endpoints and keys", () => {
  it("missing key dies with the exact text per keyed provider (no request, no marker)", async () => {
    const cases: [string, string][] = [
      ["gpt-4o", "OPENAI_API_KEY"],
      ["a/b", "OPENROUTER_API_KEY"],
      ["opencode-go/x", "OPENCODE_API_KEY"],
      ["claude-x", "ANTHROPIC_API_KEY"],
      ["gemini-x", "GEMINI_API_KEY"],
      ["opencode/x", "OPENCODE_API_KEY"],
    ];
    for (const [m, k] of cases) {
      const r = await run(["-m", m, "hi"]);
      expect(r, m).toMatchObject({ code: 1, out: "", err: `llm: error: ${k} is not set\n` });
    }
    expect(srv.requests.length).toBe(0);
    expect(fs.existsSync(path.join(HL, "run"))).toBe(false);
  });
  it("keyed providers send Authorization: Bearer <key> and Content-Type json; LLM_API_URL reroutes with a host-only warning", async () => {
    const r = await run(["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "sekrit", LLM_API_URL: `http://user:hunter2@127.0.0.1:${srv.port}/v1/chat/completions?token=topsecret`, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r.code).toBe(0);
    expect(r.err).toBe(URL_WARN("openai"));
    expect(r.err).not.toContain("hunter2");
    expect(r.err).not.toContain("topsecret");
    expect(lastReq().headers["authorization"]).toBe("Bearer sekrit");
    expect(lastReq().headers["content-type"]).toBe("application/json");
    expect(lastReq().url).toBe("/v1/chat/completions?token=topsecret");
  });
  it("openai-compatible: keyless, no Authorization header; LLM_API_KEY adds Bearer; URL required; SHELLM_API_URL fallback; exempt from the warning", async () => {
    const r = await run(["-m", "qwen3:8b", "hi"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r).toMatchObject({ code: 0, out: "ok", err: "" });
    expect(lastReq().headers["authorization"]).toBeUndefined();
    expect(payload()["max_tokens"]).toBe(16384);
    srv.reset();
    await run(["-m", "qwen3:8b", "-t", "512", "hi"], { env: { ...COMPAT(), LLM_API_KEY: "sekrit" }, replies: [R.sseOk] });
    expect(lastReq().headers["authorization"]).toBe("Bearer sekrit");
    expect(payload()["max_tokens"]).toBe(512);
    const r3 = await run(["-m", "qwen3:8b", "hi"], { env: { LLM_PROVIDER: "openai-compatible" } });
    expect(r3).toMatchObject({
      code: 1,
      err: "llm: error: LLM_API_URL is not set (openai-compatible has no default endpoint; e.g. http://localhost:11434/v1/chat/completions for Ollama)\n",
    });
    srv.reset();
    const r4 = await run(["-m", "qwen3:8b", "hi"], { env: { LLM_PROVIDER: "openai-compatible", SHELLM_API_URL: srv.url, LLM_RETRIES: "0" }, replies: [R.sseOk] });
    expect(r4).toMatchObject({ code: 0, out: "ok", err: "" });
    expect(srv.requests.length).toBe(1);
  });
  it("adapter pre-flight: missing/non-executable LLM_ADAPTER dies loudly before any exec", async () => {
    const a = await run(["-m", "x", "hi"], { env: { LLM_PROVIDER: "adapter" } });
    expect(a).toMatchObject({ code: 1, err: "llm: error: LLM_ADAPTER is not set (LLM_PROVIDER=adapter runs the executable at that path; see design/providers.md)\n" });
    const b = await run(["-m", "x", "hi"], { env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "nope" } });
    expect(b).toMatchObject({ code: 1, err: "llm: error: LLM_ADAPTER is not executable: nope\n" });
  });
  it("bug #57: adapter pre-flight runs BEFORE the -M JSON gate, matching bash's dispatch order", async () => {
    // Bash (bin/llm:1242-1243) checks LLM_ADAPTER first and never JSON-
    // validates -M for the adapter path at all; a bad adapter must win even
    // when -M is also malformed, not "--messages is not valid JSON".
    // A file that exists but has no execute bit, on every OS. (This used "/bin/false", which is only
    // "not executable" on macOS because macOS has no /bin/false; on Linux it is a real executable.)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adapter-"));
    const adapter = path.join(dir, "not-executable");
    fs.writeFileSync(adapter, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    try {
      const r = await run(["-m", "x", "-M", "not json"], { env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter } });
      expect(r).toMatchObject({ code: 1, err: `llm: error: LLM_ADAPTER is not executable: ${adapter}\n` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("max tokens", () => {
  it("LLM_MAX_TOKENS is -t; non-numeric warns (same text) and falls back to the table", async () => {
    await run(["-m", "x", "hi"], { env: { ...COMPAT(), LLM_MAX_TOKENS: "77" }, replies: [R.sseOk] });
    expect(payload()["max_tokens"]).toBe(77);
    srv.reset();
    const r = await run(["-m", "x", "-t", "lots", "hi"], { env: COMPAT(), replies: [R.sseOk] });
    expect(r.err).toBe("llm: warning: ignoring non-numeric LLM_MAX_TOKENS='lots'\n");
    expect(payload()["max_tokens"]).toBe(16384);
  });
  it("gpt-5* and o-series use max_completion_tokens", async () => {
    for (const m of ["gpt-5", "o1", "o3-mini", "o4-mini"]) {
      srv.reset();
      await run(["-m", m, "hi"], { env: COMPAT(), replies: [R.sseOk] });
      expect(payload(), m).toHaveProperty("max_completion_tokens");
      expect(payload(), m).not.toHaveProperty("max_tokens");
    }
  });
});

// --- streaming ------------------------------------------------------------------

describe("streaming path", () => {
  it("emits deltas as they arrive, newline-only deltas kept, CR stripped, no trailing newline; --no-stream adds ONE newline", async () => {
    const r = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [R.sseNewlines] });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.writes).toEqual(["```bash", "\n", "echo hi\n```"]);
    expect(r.out).toBe("```bash\necho hi\n```");
    expect(payload()["stream"]).toBe(true);
    expect(payload()["stream_options"]).toEqual({ include_usage: true });
    srv.reset();
    const r2 = await run(["-m", "x", "--no-stream", "hi"], { env: COMPAT(), replies: [R.http200Multiline] });
    expect(r2).toMatchObject({ code: 0, out: "line1\nline2\n\n", err: "" });
    expect(payload()["stream"]).toBe(false);
    expect(payload()).not.toHaveProperty("stream_options");
  });
  it("truncation: text delivered, exit 0, warning names the cap", async () => {
    const r = await run(["-m", "x", "-t", "12", "hi"], { env: COMPAT(), replies: [R.sseFinishLength] });
    expect(r).toMatchObject({ code: 0, out: "truncated tex", err: "llm: warning: output truncated at max_tokens=12 (reasoning tokens count against it) — raise with -t\n" });
    expect(health()["ok"]).toBe(true);
  });
  it("usage chunk → LLM_USAGE_FILE and a ledger line with ts/provider/model", async () => {
    const uf = path.join(TMP, "usage.json");
    const r = await run(["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf }, replies: [R.sseOkUsage] });
    expect(r).toMatchObject({ code: 0, out: "ok" });
    expect(fs.readFileSync(uf, "utf8")).toBe('{"in_tok":120,"out_tok":7,"think_tok":3}\n');
    expect(ledgerLines()).toEqual([{ ts: "2026-01-02T03:04:05Z", provider: "openrouter", model: "openai/gpt-oss-120b", in_tok: 120, out_tok: 7, think_tok: 3 }]);
  });
  it("cache_tok (1c: 1fdeb97): prompt_tokens_details.cached_tokens lands in LLM_USAGE_FILE and the ledger, streamed and non-streamed", async () => {
    const uf = path.join(TMP, "usage.json");
    const r = await run(["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf }, replies: [R.sseOkUsageCache] });
    expect(r).toMatchObject({ code: 0, out: "ok" });
    expect(fs.readFileSync(uf, "utf8")).toBe('{"in_tok":120,"out_tok":7,"think_tok":3,"cache_tok":80}\n');
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 120, out_tok: 7, think_tok: 3, cache_tok: 80 });
    srv.reset();
    const uf2 = path.join(TMP, "usage2.json");
    const r2 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf2 }, replies: [R.http200UsageCache] });
    expect(r2.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(uf2, "utf8"))).toEqual({ in_tok: 50, out_tok: 4, cache_tok: 30 });
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 50, out_tok: 4, cache_tok: 30 });
  });
  it("no usage chunk → no ledger line, usage file untouched; failures append nothing", async () => {
    const uf = path.join(TMP, "usage.json");
    await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf }, replies: [R.sseOk] });
    expect(fs.existsSync(uf)).toBe(false);
    expect(ledgerLines()).toEqual([]);
    await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.errBodyStream] });
    expect(ledgerLines()).toEqual([]);
  });
  it("error body with no data event is retried (transient line), then succeeds; three calls", async () => {
    const r = await run(["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.errBodyStream, R.errBodyStream, R.sseOk] });
    expect(r).toMatchObject({ code: 0, out: "ok" });
    expect(r.err).toBe(
      URL_WARN() +
        "llm: transient API failure (attempt 1/3): API error: Provider returned error — retrying\n" +
        "llm: transient API failure (attempt 2/3): API error: Provider returned error — retrying\n"
    );
    expect(srv.requests.length).toBe(3);
    expect(health()).toEqual({ ok: true, ts: "2026-01-02T03:04:05Z", provider: "openrouter", model: "openai/gpt-oss-120b" });
  });
  it("persistent error body: exhausts retries, original message, marker kind from words, http_code null", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.errBodyStream] });
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(r.err.endsWith("llm: error: API error: Provider returned error\n")).toBe(true);
    expect(srv.requests.length).toBe(3);
    expect(health()).toMatchObject({ ok: false, kind: "other", http_code: null, message: "API error: Provider returned error" });
    expect(healthRaw()).toBe(
      '{\n  "ok": false,\n  "ts": "2026-01-02T03:04:05Z",\n  "provider": "openrouter",\n  "model": "a/b",\n  "kind": "other",\n  "http_code": null,\n  "message": "API error: Provider returned error"\n}\n'
    );
    srv.reset();
    const r2 = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.errBodyCreditStream] });
    expect(r2.code).toBe(1);
    expect(health()).toMatchObject({ ok: false, kind: "credit", http_code: null });
  });
  it("LLM_RETRIES=0 (and non-numeric) is single-shot", async () => {
    await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.errBodyStream] });
    expect(srv.requests.length).toBe(1);
    srv.reset();
    await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "lots" }, replies: [R.errBodyStream] });
    expect(srv.requests.length).toBe(1);
  });
  it("a 4xx with a JSON body IS retried on the streaming path (curl -sS ignores status)", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.http400Stream, R.sseOk] });
    expect(r).toMatchObject({ code: 0, out: "ok" });
    expect(r.err).toContain("(attempt 1/2): API error: bad request — retrying");
  });
  it("whitespace-only body is an API error carrying the raw lines (trailing newlines stripped); empty body is 'empty response'", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.wsBodyStream] });
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(r.err).toBe(URL_WARN() + "llm: transient API failure (attempt 1/2): API error:    \n\n   — retrying\n" + "llm: error: API error:    \n\n  \n");
    srv.reset();
    const r2 = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.emptyBodyStream] });
    expect(r2).toMatchObject({ code: 1, out: "" });
    expect(r2.err).toBe(
      URL_WARN() +
        "llm: transient API failure (attempt 1/2): empty response: stream ended without emitting anything — retrying\n" +
        "llm: error: empty response: stream ended without emitting anything\n"
    );
    expect(srv.requests.length).toBe(2);
    srv.reset();
    const r3 = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.wsBodyStream, R.sseOk] });
    expect(r3).toMatchObject({ code: 0, out: "ok" });
  });
  it("mid-stream failure after output: partial stdout delivered, exit 1, NO retry, marker other", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.sseMidstreamFail] });
    expect(r).toMatchObject({ code: 1, out: "partial" });
    expect(r.err).toMatch(/^llm: warning: .*\nllm: error: request failed: .+\n$/s);
    expect(srv.requests.length).toBe(1);
    expect(health()).toMatchObject({ ok: false, kind: "other", http_code: null });
    expect(String(health()["message"]).startsWith("request failed: ")).toBe(true);
  });
  it("connection refused: retried while nothing emitted, then 'request failed'", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { OPENROUTER_API_KEY: "k", LLM_API_URL: "http://127.0.0.1:9/x", LLM_RETRIES: "1" } });
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(r.err).toMatch(/transient API failure \(attempt 1\/2\): .+ — retrying\nllm: error: request failed: .+\n$/s);
  });
  it("stall guard: no bytes for LLM_SPEED_TIME seconds aborts the attempt; a buffered pre-data line still wins as the API error (bash precedence)", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100" }, replies: [R.hang] });
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(r.err).toContain("llm: error: request failed: no data for 1s (LLM_SPEED_LIMIT=100 B/s over LLM_SPEED_TIME=1s)\n");
    srv.reset();
    const r2 = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100" }, replies: [R.hangKeepalive] });
    expect(r2).toMatchObject({ code: 1, out: "" });
    expect(r2.err).toContain("llm: error: API error: : keepalive\n");
  }, 10000);
  it("LLM_CONNECT_TIMEOUT does not bound the wait for headers (K1: bin/llm:1424-1425 bounds only the connect)", async () => {
    // The server connects at once and sends its headers after 2.5s. curl --connect-timeout 1 waits for them (the header
    // stall is --speed-time's job); this port used to abort here. Upstream's own behavior is pinned by the
    // differential in test/upstreamDiffK123.test.ts.
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "1" }, replies: [{ ...R.sseOk, delayMs: 2500 }] });
    expect(r).toMatchObject({ code: 0, out: "ok" });
    expect(r.err).not.toContain("connect timeout");
  }, 10000);
  it("LLM_CONNECT_TIMEOUT does not fire once headers have arrived (only bounds the connect phase)", async () => {
    // Headers arrive immediately (no delayMs); LLM_CONNECT_TIMEOUT=1 must not
    // then abort the (slower, streamed) body — only LLM_MAX_TIME/LLM_SPEED_*
    // govern once the connect phase is over.
    const r = await run(["-m", "a/b", "hi"], {
      env: { ...OR(), LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "1" },
      replies: [{ sse: true, chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'], chunkDelayMs: 1500, body: "data: [DONE]\n" }],
    });
    expect(r).toMatchObject({ code: 0, out: "ok" });
  }, 10000);
  it("LLM_CONNECT_TIMEOUT=0 disables the guard", async () => {
    const r = await run(["-m", "a/b", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "0", LLM_MAX_TIME: "1" }, replies: [R.slow] });
    // LLM_MAX_TIME still applies (generic HTTP 000 / request-failed path via the
    // shared AbortController), but the message must NOT be the connect-timeout one.
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("LLM_CONNECT_TIMEOUT");
  }, 10000);
});

// PORT-NOTE (1c: 2d1c1c3) — LLM_STOP_AFTER_CODE_BLOCK / --stop-after-code-block.
// Characterized against the real Bash bin/llm (a temp fake-server harness,
// bash -x): the WHOLE delta chunk containing the closing fence line is
// printed to stdout first (bin/llm's `_emit_text` always `printf`s before
// checking the fence tracker), and only chunks arriving AFTER that point are
// suppressed — the cut is line-buffered, not byte-instant. Usage is then
// estimated from bytes fed to the tracker: `Math.floor((bytes + 3) / 4)`,
// REPLACING any usage already on record (write_usage overwrites the whole
// file). shellm.ts's own LlmClient abstraction never shells out to this CLI
// (see PARITY.md "llm CLI stop-after-code-block"), so this flag/env only has
// an effect on this standalone tool and mem search's own `llm` subprocess
// call — not on the daemon-driven wake loop, which calls LlmClient.complete()
// in-process instead.
describe("LLM_STOP_AFTER_CODE_BLOCK / --stop-after-code-block", () => {
  it("off by default: every delta after the block is still read", async () => {
    const r = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [R.sseCodeBlockThenMore] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("```bash\necho hi\n```\nMORE");
    expect(r.err).toBe("");
  });
  it("--stop-after-code-block: the block-closing chunk still prints in full; nothing after it does; usage is estimated", async () => {
    const uf = path.join(TMP, "usage.json");
    const r = await run(["-m", "x", "--stop-after-code-block", "hi"], { env: { ...COMPAT(), LLM_USAGE_FILE: uf }, replies: [R.sseCodeBlockThenMore] });
    expect(r.code).toBe(0);
    // "MORE" is part of the SAME chunk that supplies the newline completing
    // the "```" line, so it is emitted too — the cut happens on the NEXT read.
    expect(r.out).toBe("```bash\necho hi\n```\nMORE");
    expect(r.err).toBe("llm: stopped reading after the first code block closed (LLM_STOP_AFTER_CODE_BLOCK)\n");
    expect(srv.requests.length).toBe(1); // one clean attempt, no retry
    // bytes fed: "```bash\n"(8) + "echo hi\n```"(11) + "\nMORE"(5) = 24 -> (24+3)/4 = 6 (floor)
    expect(JSON.parse(fs.readFileSync(uf, "utf8"))).toEqual({ out_tok: 6, estimated: true });
    expect(ledgerLines().at(-1)).toMatchObject({ out_tok: 6, estimated: true });
    expect(health()).toMatchObject({ ok: true });
  });
  it("LLM_STOP_AFTER_CODE_BLOCK=1 has the same effect as the flag; any other value leaves it off", async () => {
    const r = await run(["-m", "x", "hi"], { env: { ...COMPAT(), LLM_STOP_AFTER_CODE_BLOCK: "1" }, replies: [R.sseCodeBlockThenMore] });
    expect(r.err).toContain("stopped reading after the first code block closed");
    srv.reset();
    const r2 = await run(["-m", "x", "hi"], { env: { ...COMPAT(), LLM_STOP_AFTER_CODE_BLOCK: "true" }, replies: [R.sseCodeBlockThenMore] });
    expect(r2.out).toBe("```bash\necho hi\n```\nMORE");
    expect(r2.err).toBe("");
  });
  it("heredoc-aware: a bare ``` inside an open heredoc does not close the block early", async () => {
    const r = await run(["-m", "x", "--stop-after-code-block", "hi"], { env: COMPAT(), replies: [R.sseCodeBlockHeredoc] });
    expect(r.code).toBe(0);
    // The real close is the SECOND ``` (after "EOF" pops the heredoc), but its
    // trailing newline (making it a "complete line") only arrives at the
    // START of the NEXT chunk ("\nMORE") — so that whole chunk still prints
    // (bin/llm's _emit_text always prints first) before the cut takes effect.
    expect(r.out).toBe('```bash\ncat <<EOF\n```\nstill inside\nEOF\n```\nMORE');
    expect(r.err).toContain("stopped reading after the first code block closed");
  });
  it("Anthropic: only the visible text delta feeds the fence tracker — a fenced+closed block inside THINKING never triggers a cut", async () => {
    // If thinking text wrongly fed the tracker, the closed ```bash block in
    // the thinking delta below would trigger a stop (and the notice) before
    // the text block is even reached. It must not: the fence tracker only
    // ever inspects the model's visible answer.
    const r = await run(["--thinking", "-m", "claude-sonnet-4-5", "--stop-after-code-block", "hi"], {
      env: ANTH(),
      replies: [
        {
          sse: true,
          body:
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"```bash\\necho x\\n```\\n"}}\n\n' +
            'data: {"type":"content_block_stop","index":0}\n\n' +
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"just prose, no fence at all"}}\n\n' +
            'data: {"type":"content_block_stop","index":1}\n\n' +
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("just prose, no fence at all");
    // stderr carries only the raw thinking text — no stop notice, since the
    // fenced+closed block lived in thinking, which never feeds the tracker.
    expect(dropUrlWarn(r.err, "anthropic")).toBe("```bash\necho x\n```\n");
  });
});

// --- non-streaming ----------------------------------------------------------------

describe("non-streaming path", () => {
  it("text + one newline; --raw prints the raw body; missing content prints nothing at all", async () => {
    const r = await run(["-m", "x", "--no-stream", "hi"], { env: COMPAT(), replies: [R.http200] });
    expect(r).toMatchObject({ code: 0, out: "ok\n", err: "" });
    srv.reset();
    const r2 = await run(["-m", "x", "--no-stream", "--raw", "hi"], { env: COMPAT(), replies: [R.http200] });
    expect(r2).toMatchObject({ code: 0, out: '{"choices":[{"message":{"content":"ok"}}]}', err: "" });
    srv.reset();
    const r3 = await run(["-m", "x", "--no-stream", "hi"], { env: COMPAT(), replies: [R.http200NoContent] });
    expect(r3).toMatchObject({ code: 0, out: "", err: "" });
    srv.reset();
    // A non-JSON 2xx body: the Bash crashes in jq (exit 5, silent); the port fails loudly — no retry, no marker.
    const r4 = await run(["-m", "x", "--no-stream", "hi"], { env: { ...COMPAT(), LLM_RETRIES: "2" }, replies: [R.http200NotJson] });
    expect(r4).toMatchObject({ code: 1, out: "", err: "llm: error: API error: response body is not JSON (HTTP 200)\n" });
    expect(srv.requests.length).toBe(1);
    expect(health()["ok"]).toBe(true); // the previous success's marker still stands
  });
  it("an unparseable SSE event is skipped; `data:` without a space is not a data line", async () => {
    const r = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [R.sseBadJsonEvent] });
    expect(r).toMatchObject({ code: 0, out: "ok", err: "" });
    srv.reset();
    const r2 = await run(["-m", "x", "hi"], { env: COMPAT(), replies: [R.sseNoSpace] });
    expect(r2).toMatchObject({ code: 1, out: "", err: "llm: error: empty response: stream ended without emitting anything\n" });
  });
  it("5xx retried to success; 400 not retried and its message surfaces; marker http_code 400 kind other", async () => {
    const r = await run(["-m", "openai/gpt-oss-120b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.http500, R.http200] });
    expect(r).toMatchObject({ code: 0, out: "ok\n" });
    expect(r.err).toBe(URL_WARN() + "llm: transient API failure (attempt 1/3): HTTP 500 — retrying\n");
    expect(srv.requests.length).toBe(2);
    srv.reset();
    const r2 = await run(["-m", "openai/gpt-oss-120b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.http400] });
    expect(r2).toMatchObject({ code: 1, out: "", err: URL_WARN() + "llm: error: API error (HTTP 400): bad request\n" });
    expect(srv.requests.length).toBe(1);
    expect(health()).toEqual({ ok: false, ts: "2026-01-02T03:04:05Z", provider: "openrouter", model: "openai/gpt-oss-120b", kind: "other", http_code: 400, message: "bad request" });
  });
  it("marker kinds: 402 credit, 401 auth, 403 auth (.message fallback), 429+quota rate (code beats words), non-JSON 500 → 'HTTP 500'", async () => {
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http402] });
    expect(health()).toMatchObject({ ok: false, kind: "credit", http_code: 402 });
    expect(String(health()["message"])).toContain("credit");
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http401] });
    expect(health()).toMatchObject({ kind: "auth", http_code: 401 });
    const r3 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http403TopMessage] });
    expect(r3.err).toContain("llm: error: API error (HTTP 403): forbidden by policy\n");
    expect(health()).toMatchObject({ kind: "auth", http_code: 403, message: "forbidden by policy" });
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http429Quota] });
    expect(health()).toMatchObject({ kind: "rate", http_code: 429 });
    const r5 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http500Html] });
    expect(r5.err).toContain("llm: error: API error (HTTP 500)\n");
    expect(health()).toMatchObject({ kind: "other", http_code: 500, message: "HTTP 500" });
  });
  it("connection refused: HTTP 000 transient, then 'API error (HTTP 000)' with http_code 0", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { OPENROUTER_API_KEY: "k", LLM_API_URL: "http://127.0.0.1:9/x", LLM_RETRIES: "1" } });
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(r.err).toBe(
      "llm: warning: LLM_API_URL overrides the default openrouter endpoint (requests go to 127.0.0.1:9)\n" +
        "llm: transient API failure (attempt 1/2): HTTP 000 — retrying\n" +
        "llm: error: API error (HTTP 000)\n"
    );
    expect(health()).toMatchObject({ ok: false, kind: "other", http_code: 0, message: "HTTP 000" });
  });
  it("embedded failures in a 200 are retried, then fatal without a marker update; partial text never printed", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.errBody, R.http200] });
    expect(r).toMatchObject({ code: 0, out: "ok\n" });
    expect(srv.requests.length).toBe(2);
    srv.reset();
    const r2 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.finishError] });
    expect(r2).toMatchObject({ code: 1, out: "" });
    expect(r2.err).toBe(
      URL_WARN() +
        'llm: transient API failure (attempt 1/2): finish_reason "error" (provider failed mid-generation) — retrying\n' +
        'llm: error: API error: finish_reason "error" (provider failed mid-generation)\n'
    );
    expect(health()["ok"]).toBe(true); // the previous success's marker still stands: no note on this path
    srv.reset();
    const r3 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.choiceError] });
    expect(r3.err).toContain("llm: error: API error: choice failed\n");
  });
  it("whitespace-only / empty 200 bodies are 'whitespace-only response body' — retried, fatal when persistent", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.wsBody, R.http200] });
    expect(r).toMatchObject({ code: 0, out: "ok\n" });
    expect(srv.requests.length).toBe(2);
    srv.reset();
    const r2 = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "1" }, replies: [R.emptyBody] });
    expect(r2).toMatchObject({ code: 1, out: "" });
    expect(r2.err).toContain("llm: error: API error: whitespace-only response body\n");
    expect(srv.requests.length).toBe(2);
  });
  it("truncation: text delivered, exit 0, not retried, warning", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "2" }, replies: [R.finishLength] });
    expect(r).toMatchObject({ code: 0, out: "truncated tex\n" });
    expect(r.err).toBe(URL_WARN() + "llm: warning: output truncated at max_tokens=16384 (reasoning tokens count against it) — raise with -t\n");
    expect(srv.requests.length).toBe(1);
  });
  it("usage: caller file, IDENTITY_DIR ledger + identity, LLM_RUN_ID/SHELLM_RUN_STEP_ID, /dev/null ledger, {} when the provider reports none", async () => {
    const uf = path.join(TMP, "usage.json");
    const ident = path.join(TMP, "ident");
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf, IDENTITY_DIR: ident, IDENTITY_NAME: "ada" }, replies: [R.http200Usage] });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(uf, "utf8")).toBe('{"in_tok":50,"out_tok":4}\n');
    expect(ledgerLines(path.join(ident, "usage", "llm.jsonl"))).toEqual([{ ts: "2026-01-02T03:04:05Z", provider: "openrouter", model: "a/b", in_tok: 50, out_tok: 4, identity: "ada" }]);
    expect(ledgerLines()).toEqual([]); // home ledger untouched
    // identity from basename(IDENTITY_DIR); run_id from LLM_RUN_ID, else SHELLM_RUN_STEP_ID
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", IDENTITY_DIR: ident + "/", LLM_RUN_ID: "run-77", SHELLM_RUN_STEP_ID: "step-1" }, replies: [R.http200Usage] });
    expect(ledgerLines(path.join(ident, "usage", "llm.jsonl"))[1]).toMatchObject({ identity: "ident", run_id: "run-77" });
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", SHELLM_RUN_STEP_ID: "step-1" }, replies: [R.http200Usage] });
    expect(ledgerLines()).toEqual([{ ts: "2026-01-02T03:04:05Z", provider: "openrouter", model: "a/b", in_tok: 50, out_tok: 4, run_id: "step-1" }]);
    // LLM_USAGE_LEDGER overrides (and /dev/null disables)
    const alt = path.join(TMP, "alt.jsonl");
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_LEDGER: alt }, replies: [R.http200Usage] });
    expect(ledgerLines(alt).length).toBe(1);
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_LEDGER: "/dev/null" }, replies: [R.http200Usage] });
    expect(ledgerLines().length).toBe(1);
    // No usage reported: the caller file gets {} and the ledger nothing.
    const uf2 = path.join(TMP, "usage2.json");
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_USAGE_FILE: uf2 }, replies: [R.http200] });
    expect(fs.readFileSync(uf2, "utf8")).toBe("{}\n");
    expect(ledgerLines().length).toBe(1);
    // A failure appends nothing.
    await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0" }, replies: [R.http400] });
    expect(ledgerLines().length).toBe(1);
  });
  it("LLM_MAX_TIME caps one attempt (HTTP 000 on the non-streaming path)", async () => {
    const r = await run(["-m", "a/b", "--no-stream", "hi"], { env: { ...OR(), LLM_RETRIES: "0", LLM_MAX_TIME: "1" }, replies: [R.slow] });
    expect(r).toMatchObject({ code: 1, out: "", err: URL_WARN() + "llm: error: API error (HTTP 000)\n" });
  }, 10000);
});

// --- the unblock: `mem search` end-to-end through bin/llm --------------------------

/** Async spawn: the fake server lives in THIS process, so a spawnSync would deadlock the child's request. */
function spawnAsync(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("mem search → bin/llm end-to-end (bin/ on PATH, no Bash)", () => {
  it("bin/llm resolves on PATH and streams the answer; mem search pipes its corpus through it", async () => {
    const memdir = path.join(TMP, ".memories");
    fs.mkdirSync(memdir);
    fs.writeFileSync(path.join(memdir, "2026-01-01-01-00-00_aaaaaaaa_first.md"), "---\nid: aaaaaaaa\nsummary: cats\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nfeline body\n");
    srv.script([R.sseOk]);
    const env = {
      PATH: `${path.join(REPO, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME,
      HEADLONG_HOME: HL,
      LLM_PROVIDER: "openai-compatible",
      LLM_API_URL: srv.url,
      LLM_RETRIES: "0",
      SHELLM_FAST_MODEL: "fast-1",
    };
    const res = await spawnAsync(process.execPath, [path.join(REPO, "bin", "mem.mjs"), "search", "feline", "friends"], { cwd: TMP, env });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("ok");
    expect(srv.requests.length).toBe(1);
    const p = payload();
    expect(p["model"]).toBe("fast-1");
    const msgs = p["messages"] as { role: string; content: string }[];
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content.startsWith("You are a semantic search engine for memory files.")).toBe(true);
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content.startsWith("Search these memories for: feline friends\n\n=== 2026-01-01-01-00-00_aaaaaaaa_first.md ===\n")).toBe(true);
    expect(fs.existsSync(path.join(HL, "run", "llm_health.json"))).toBe(true);
    // Direct `llm` invocation by PATH lookup (symlink + shebang), exit code and stderr propagate.
    srv.reset();
    srv.script([R.http400Stream, R.sseOk]);
    const direct = await spawnAsync("llm", ["-m", "x", "say", "ok"], { cwd: TMP, env: { ...env, LLM_RETRIES: "1" } });
    expect(direct.status).toBe(0);
    expect(direct.stdout).toBe("ok");
    expect(direct.stderr).toBe("llm: transient API failure (attempt 1/2): API error: bad request — retrying\n");
    const bad = await spawnAsync("llm", ["--bogus"], { cwd: TMP, env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe("llm: error: Unknown option: --bogus (try llm --help)\n");
  });
  it("a large piped prompt (a mem search corpus) reaches the request intact", async () => {
    srv.script([R.sseOk]);
    const env = { PATH: `${path.join(REPO, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME, HEADLONG_HOME: HL, ...COMPAT() };
    const big = "corpus line\n".repeat(30000); // ~360 KB, well past the 64 KiB pipe buffer
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn("llm", ["-m", "x"], { cwd: TMP, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      p.on("error", reject);
      p.on("close", (status) => resolve({ status, stdout, stderr }));
      p.stdin.end(big);
    });
    expect(res).toEqual({ status: 0, stdout: "ok", stderr: "" });
    const msgs = payload()["messages"] as { role: string; content: string }[];
    expect(msgs[0]!.content).toBe(big.replace(/\n+$/, ""));
  });
});

// --- anthropic / gemini / opencode(Zen) / adapter --------------------------------

const ANTH = (): Record<string, string> => ({ ANTHROPIC_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" });
const GEM = (): Record<string, string> => ({ GEMINI_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" });
const ZEN = (): Record<string, string> => ({ OPENCODE_API_KEY: "k", LLM_API_URL: srv.url, LLM_RETRIES: "0" });
const MSGS = (): string => JSON.stringify([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
/** ANTH/GEM/ZEN route through LLM_API_URL like the openai-family COMPAT() helper does — which,
 * unlike openai-compatible, is NOT exempt from the reroute warning; strip it here so the rest of
 * each assertion can focus on the behavior under test (the warning itself is covered above). */
const dropUrlWarn = (err: string, provider: string): string => err.replace(URL_WARN(provider), "");

describe("anthropic wire path", () => {
  it("payload key order, system NOT prepended into messages, thinking + effort", async () => {
    const r = await run(["-m", "claude-sonnet-4-5", "-s", "be terse", "--thinking", "--effort", "high", "hi"], {
      env: ANTH(),
      replies: [R.anthropicSseOk],
    });
    expect(r.code).toBe(0);
    const p = payload();
    expect(Object.keys(p)).toEqual(["model", "max_tokens", "system", "messages", "stream", "thinking", "output_config"]);
    expect(p["system"]).toBe("be terse");
    expect(p["messages"]).toEqual([{ role: "user", content: "hi" }]); // NOT prepended (Anthropic system is a top-level field)
    expect(p["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(p["output_config"]).toEqual({ effort: "high" });
    expect(lastReq().headers["x-api-key"]).toBe("k");
    expect(lastReq().headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastReq().headers["content-type"]).toBe("application/json");
    expect(r.out).toBe("ok"); // streaming: deltas verbatim, no trailing newline
  });
  it("streaming: text on stdout with no trailing newline, thinking on stderr, usage (no think_tok)", async () => {
    const r = await run(["-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicSseOk] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("ok");
    expect(dropUrlWarn(r.err, "anthropic")).toBe("");
    expect(ledgerLines().at(-1)).toMatchObject({ provider: "anthropic", in_tok: 11, out_tok: 3 });
    expect(ledgerLines().at(-1)).not.toHaveProperty("think_tok");
  });
  it("cache_tok (1c: 1fdeb97): cache_read_input_tokens on message_start lands in the ledger, streamed and non-streamed", async () => {
    const r = await run(["-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicSseCache] });
    expect(r.code).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 11, out_tok: 3, cache_tok: 9 });
    srv.reset();
    const r2 = await run(["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicJsonCache] });
    expect(r2.code).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 11, out_tok: 3, cache_tok: 9 });
    expect(ledgerLines().at(-1)).not.toHaveProperty("think_tok"); // third @tsv cell stays literal "" on this wire path
  });
  it("streaming: thinking deltas go to stderr, interleaved with the text block", async () => {
    const r = await run(["--thinking", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicSseThinking] });
    expect(r.out).toBe("ok");
    expect(dropUrlWarn(r.err, "anthropic")).toBe("pondering");
  });
  it("effort has NO model-family guard (sent even on an unsupported-thinking model); bare --thinking without effort is guarded", async () => {
    const r = await run(["-m", "claude-3-opus", "--effort", "max", "hi"], { env: ANTH(), replies: [R.anthropicSseOk] });
    expect(payload()["output_config"]).toEqual({ effort: "max" });
    expect(dropUrlWarn(r.err, "anthropic")).toBe("");
    srv.reset();
    const r2 = await run(["--thinking", "-m", "claude-3-opus", "hi"], { env: ANTH(), replies: [R.anthropicSseOk] });
    expect(payload()).not.toHaveProperty("thinking");
    expect(dropUrlWarn(r2.err, "anthropic")).toBe(
      "llm: --thinking ignored: claude-3-opus not in the known-thinking model list (LLM_ASSUME_THINKING=1 to send anyway)\n"
    );
  });
  it("truncation warning on stop_reason=max_tokens (streaming and non-streaming)", async () => {
    const r = await run(["-m", "claude-sonnet-4-5", "-t", "12", "hi"], { env: ANTH(), replies: [R.anthropicSseMaxTokens] });
    expect(dropUrlWarn(r.err, "anthropic")).toBe(
      "llm: warning: output truncated at max_tokens=12 (reasoning tokens count against it) — raise with -t\n"
    );
    srv.reset();
    const r2 = await run(["--no-stream", "-m", "claude-sonnet-4-5", "-t", "12", "hi"], { env: ANTH(), replies: [R.anthropicJsonMaxTokens] });
    expect(dropUrlWarn(r2.err, "anthropic")).toBe(
      "llm: warning: output truncated at max_tokens=12 (reasoning tokens count against it) — raise with -t\n"
    );
  });
  it("non-streaming: extract_text_anthropic, check_response_anthropic (`.type==\"error\"`), usage", async () => {
    const ok = await run(["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicJsonOk] });
    expect(ok.code).toBe(0);
    expect(ok.out).toBe("ok\n");
    expect(dropUrlWarn(ok.err, "anthropic")).toBe("");
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 11, out_tok: 3 });
    srv.reset();
    const bad = await run(["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH(), replies: [R.anthropicJsonError] });
    expect(bad.code).toBe(1);
    expect(dropUrlWarn(bad.err, "anthropic")).toBe("llm: error: API error: bad request\n");
  });
  it("mid-stream `type:\"error\"`: nothing emitted yet is RETRIED (bash quirk: outer loop only gates on the emitted marker), exhausted retries exit 1 with NO health-marker update", async () => {
    expect(fs.existsSync(path.join(HL, "run", "llm_health.json"))).toBe(false);
    const r = await run(["-m", "claude-sonnet-4-5", "hi"], {
      env: { ...ANTH(), LLM_RETRIES: "1" },
      replies: [R.anthropicSseTypeError, R.anthropicSseOk],
    });
    // retried once (nothing had emitted on attempt 1), attempt 2 succeeds
    expect(r.code).toBe(0);
    expect(r.out).toBe("ok");
    expect(r.err).toContain("llm: error: API stream error: Overloaded\n");
    expect(r.err).toContain("llm: transient API failure (attempt 1/2): exit 1 — retrying\n");
    expect(srv.requests.length).toBe(2);
    srv.reset();
    // exhausted: retries=0 -> exit 1 immediately, the die message printed once, no health marker written
    fs.rmSync(path.join(HL, "run"), { recursive: true, force: true });
    const r2 = await run(["-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH(), LLM_RETRIES: "0" }, replies: [R.anthropicSseTypeError] });
    expect(r2.code).toBe(1);
    expect(dropUrlWarn(r2.err, "anthropic")).toBe("llm: error: API stream error: Overloaded\n");
    expect(fs.existsSync(path.join(HL, "run", "llm_health.json"))).toBe(false);
  });
});

describe("gemini wire path", () => {
  it("payload: contents role mapping (assistant->model), systemInstruction, thinkingConfig; --effort is ignored", async () => {
    const r = await run(["-m", "gemini-2.0-flash", "-s", "be terse", "--thinking", "high", "--effort", "max", "-M", MSGS(), "hi"], {
      env: GEM(),
      replies: [R.geminiSseOk],
    });
    expect(r.code).toBe(0);
    const p = payload();
    expect(Object.keys(p)).toEqual(["contents", "systemInstruction", "generationConfig"]);
    expect(p["systemInstruction"]).toEqual({ parts: [{ text: "be terse" }] });
    const contents = p["contents"] as { role: string; parts: { text: string }[] }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(p["generationConfig"]).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "high" } }); // gemini-2.0-flash* is the 8192 special case, not the generic gemini-* 65536
  });
  it("bare --thinking (no level) is a no-op for Gemini, like OpenAI", async () => {
    const r = await run(["--thinking", "-m", "gemini-2.0-flash", "hi"], { env: GEM(), replies: [R.geminiSseOk] });
    expect((payload()["generationConfig"] as Record<string, unknown>)).not.toHaveProperty("thinkingConfig");
    expect(dropUrlWarn(r.err, "gemini")).toBe("");
  });
  it("--thinking LEVEL on an unsupported model warns and omits", async () => {
    const r = await run(["-m", "gemini-1.5-pro", "--thinking", "high", "hi"], { env: GEM(), replies: [R.geminiSseOk] });
    expect(dropUrlWarn(r.err, "gemini")).toBe(
      "llm: --thinking ignored: gemini-1.5-pro not in the known-thinking model list (LLM_ASSUME_THINKING=1 to send anyway)\n"
    );
    expect((payload()["generationConfig"] as Record<string, unknown>)).not.toHaveProperty("thinkingConfig");
  });
  it("streaming: text deltas, finishReason=MAX_TOKENS truncation warning (no null-exclusion guard), usage (all three fields)", async () => {
    const r = await run(["-m", "gemini-2.0-flash", "-t", "5", "hi"], { env: GEM(), replies: [R.geminiSseMaxTokens] });
    expect(r.out).toBe("cut");
    expect(dropUrlWarn(r.err, "gemini")).toBe(
      "llm: warning: output truncated at max_tokens=5 (reasoning tokens count against it) — raise with -t\n"
    );
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 9, out_tok: 30 });
  });
  it("non-streaming: extract/check/truncated/usage", async () => {
    const ok = await run(["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: GEM(), replies: [R.geminiJsonOk] });
    expect(ok.code).toBe(0);
    expect(ok.out).toBe("ok\n");
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 9, out_tok: 2 });
    srv.reset();
    const bad = await run(["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: GEM(), replies: [R.geminiJsonError] });
    expect(bad.code).toBe(1);
    expect(dropUrlWarn(bad.err, "gemini")).toBe("llm: error: API error: API key not valid\n");
  });
  it("cache_tok (1c: 1fdeb97): cachedContentTokenCount lands in the ledger, streamed and non-streamed", async () => {
    const r = await run(["-m", "gemini-2.0-flash", "hi"], { env: GEM(), replies: [R.geminiSseCache] });
    expect(r.code).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 9, out_tok: 2, cache_tok: 6 });
    srv.reset();
    const r2 = await run(["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: GEM(), replies: [R.geminiJsonCache] });
    expect(r2.code).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ in_tok: 9, out_tok: 2, cache_tok: 6 });
  });
});

describe("opencode Zen wire path (opencode/*, Anthropic protocol)", () => {
  it("prefix stripped, thinking/effort force-dropped with a note, otherwise identical to anthropic", async () => {
    const r = await run(["-m", "opencode/claude-x", "--thinking", "--effort", "high", "hi"], { env: ZEN(), replies: [R.anthropicSseOk] });
    expect(r.code).toBe(0);
    const p = payload();
    expect(p["model"]).toBe("claude-x");
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("output_config");
    // LLM_API_URL reroutes opencode too (it is not exempt, unlike openai-compatible/adapter).
    expect(r.err).toBe(URL_WARN("opencode") + "llm: note: OpenCode Zen rejects the thinking/effort betas; dropping them (thinking happens server-side)\n");
    expect(lastReq().headers["x-api-key"]).toBe("k");
    expect(lastReq().headers["anthropic-version"]).toBe("2023-06-01");
  });
  it("no note when neither --thinking nor --effort was given", async () => {
    const r = await run(["-m", "opencode/claude-x", "hi"], { env: ZEN(), replies: [R.anthropicSseOk] });
    expect(r.err).toBe(URL_WARN("opencode"));
  });
  it("check_response/extract_text reuse the anthropic readers verbatim", async () => {
    const r = await run(["--no-stream", "-m", "opencode/claude-x", "hi"], { env: ZEN(), replies: [R.anthropicJsonError] });
    expect(r).toMatchObject({ code: 1, err: URL_WARN("opencode") + "llm: error: API error: bad request\n" });
  });
});

describe("default endpoints (no LLM_API_URL) — verified via a fetch stand-in, no network", () => {
  async function runDefaultUrl(argv: string[], env: Record<string, string>): Promise<{ url: string; init: RequestInit }> {
    let captured: { url: string; init: RequestInit } | null = null;
    const io: LlmIO = {
      cwd: TMP,
      env: { HOME, HEADLONG_HOME: HL, LLM_RETRY_BACKOFF: "0", LLM_RETRIES: "0", ...env },
      stdout: () => {},
      stderr: () => {},
      readStdin: () => "",
      stdinIsTTY: false,
      now: () => NOW,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return new Response('{"error":{"message":"stub"}}', { status: 401 });
      }) as typeof globalThis.fetch,
      fs,
      sleep: async () => {},
      spawnAdapter: spawnAdapterProcess,
      randomToken: () => crypto.randomBytes(6).toString("hex"),
    };
    await runLlm(argv, io);
    if (captured === null) throw new Error("fetch was never called");
    return captured;
  }
  it("anthropic default URL", async () => {
    const { url } = await runDefaultUrl(["-m", "claude-sonnet-4-5", "hi"], { ANTHROPIC_API_KEY: "k" });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });
  it("opencode Zen default URL", async () => {
    const { url } = await runDefaultUrl(["-m", "opencode/x", "hi"], { OPENCODE_API_KEY: "k" });
    expect(url).toBe("https://opencode.ai/zen/v1/messages");
  });
  it("gemini default URL: streaming uses streamGenerateContent?alt=sse, non-streaming uses generateContent", async () => {
    const { url } = await runDefaultUrl(["-m", "gemini-2.0-flash", "hi"], { GEMINI_API_KEY: "k" });
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse");
    const { url: url2 } = await runDefaultUrl(["--no-stream", "-m", "gemini-2.0-flash", "hi"], { GEMINI_API_KEY: "k" });
    expect(url2).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
  });
});

describe("adapter seam (LLM_PROVIDER=adapter; design/providers.md)", () => {
  function writeAdapter(file: string, script: string): void {
    fs.writeFileSync(file, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  }
  // A real subprocess is spawned (`#!/usr/bin/env node` needs PATH to resolve
  // `node`), and its completion is a genuine wall-clock event — the default
  // instant `sleep` would race thousands of deadline-poll ticks ahead of a
  // process that hasn't even started yet, so every adapter test needs both.
  const adapterEnv = (extra: Record<string, string>): Record<string, string> => ({ PATH: process.env["PATH"]!, ...extra });
  const OK_ADAPTER = `
    const fs = require("fs");
    const args = process.argv.slice(2);
    fs.writeFileSync(process.env.ADAPTER_ARGS_FILE, JSON.stringify(args));
    let stdin = "";
    process.stdin.on("data", (d) => (stdin += d));
    process.stdin.on("end", () => {
      fs.writeFileSync(process.env.ADAPTER_STDIN_FILE, stdin);
      const idx = args.indexOf("--system-prompt-file");
      if (idx >= 0) {
        fs.writeFileSync(process.env.ADAPTER_SYS_FILE, fs.readFileSync(args[idx + 1], "utf8"));
        fs.writeFileSync(process.env.ADAPTER_SYS_MODE_FILE, (fs.statSync(args[idx + 1]).mode & 0o777).toString(8));
      }
      if (process.env.ADAPTER_USAGE && process.env.LLM_USAGE_FILE) {
        fs.writeFileSync(process.env.LLM_USAGE_FILE, process.env.ADAPTER_USAGE);
      }
      const rc = Number(process.env.ADAPTER_RC || "0");
      if (rc !== 0) { process.stderr.write("stub adapter failing on purpose\\n"); process.exit(rc); }
      process.stdout.write("adapter says ok");
    });
  `;

  it("runs, stdout passes through, --model/--max-tokens/messages-on-stdin/-s via --system-prompt-file (mode 0600)", async () => {
    const adapter = path.join(TMP, "adapter");
    writeAdapter(adapter, OK_ADAPTER);
    const argsFile = path.join(TMP, "args.json");
    const stdinFile = path.join(TMP, "stdin.json");
    const sysFile = path.join(TMP, "sys.txt");
    const sysModeFile = path.join(TMP, "sys.mode");
    const r = await run(["-m", "qwen3:8b", "-s", "be brief", "-t", "512", "--no-stream", "--effort", "low", "--thinking", "high", "say ok"], {
      env: adapterEnv({
        LLM_PROVIDER: "adapter",
        LLM_ADAPTER: adapter,
        ADAPTER_ARGS_FILE: argsFile,
        ADAPTER_STDIN_FILE: stdinFile,
        ADAPTER_SYS_FILE: sysFile,
        ADAPTER_SYS_MODE_FILE: sysModeFile,
      }),
      realSleep: true,
    });
    expect(r).toMatchObject({ code: 0, out: "adapter says ok", err: "" });
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args.slice(0, -1)).toEqual([
      "--model",
      "qwen3:8b",
      "--max-tokens",
      "512",
      "--effort",
      "low",
      "--thinking",
      "high",
      "--no-stream",
      "--system-prompt-file",
    ]);
    const passedSysFile = args[args.length - 1]!;
    expect(fs.readFileSync(sysFile, "utf8")).toBe("be brief"); // the adapter's own copy, made before llm's cleanup
    expect(fs.readFileSync(sysModeFile, "utf8")).toBe("600");
    expect(fs.existsSync(passedSysFile)).toBe(false); // llm's tempfile is removed after the call, like the Bash's
    const msgs = JSON.parse(fs.readFileSync(stdinFile, "utf8")) as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: "user", content: "say ok" });
  });
  it("unknown model gets the 16384 fallback cap; usage lands in the ledger under provider=adapter", async () => {
    const adapter = path.join(TMP, "adapter");
    writeAdapter(adapter, OK_ADAPTER);
    const argsFile = path.join(TMP, "args.json");
    const stdinFile = path.join(TMP, "stdin.json");
    const r = await run(["-m", "qwen3:8b", "say ok"], {
      env: adapterEnv({
        LLM_PROVIDER: "adapter",
        LLM_ADAPTER: adapter,
        ADAPTER_ARGS_FILE: argsFile,
        ADAPTER_STDIN_FILE: stdinFile,
        ADAPTER_USAGE: '{"in_tok":11,"out_tok":22}',
      }),
      realSleep: true,
    });
    expect(r.code).toBe(0);
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args.slice(0, 4)).toEqual(["--model", "qwen3:8b", "--max-tokens", "16384"]);
    expect(ledgerLines().at(-1)).toMatchObject({ provider: "adapter", model: "qwen3:8b", in_tok: 11, out_tok: 22 });
  });
  it("a nonzero adapter exit fails the call with the code reported and the health marker recorded", async () => {
    const adapter = path.join(TMP, "adapter");
    writeAdapter(adapter, OK_ADAPTER);
    const r = await run(["-m", "x", "say ok"], {
      env: adapterEnv({ LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter, ADAPTER_RC: "3", ADAPTER_ARGS_FILE: path.join(TMP, "a"), ADAPTER_STDIN_FILE: path.join(TMP, "s") }),
      realSleep: true,
    });
    expect(r.code).toBe(1);
    // The adapter's own stderr ("stub adapter failing on purpose") streams through in real time,
    // ahead of llm's own die message — same as the Bash, which never captures the adapter's stderr.
    expect(r.err).toBe("stub adapter failing on purpose\nllm: error: Adapter failed (adapter exited 3): " + adapter + "\n");
    expect(health()).toMatchObject({ ok: false, kind: "other" });
  });
  it("LLM_MAX_TIME deadline: a TERM-trapping adapter that exits 0 anyway is still reported as a deadline failure", async () => {
    const adapter = path.join(TMP, "adapter-trap-term");
    writeAdapter(
      adapter,
      `process.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`
    );
    const r = await run(["-m", "x", "say ok"], {
      env: adapterEnv({ LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter, LLM_MAX_TIME: "1" }),
      realSleep: true,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("LLM_MAX_TIME deadline");
    expect(health()).toMatchObject({ ok: false });
  }, 10000);
  it("the deadline reaches an orphaned grandchild too: a leader that TERM-traps into a quick exit(0) must not leave a TERM-ignoring child alive in the group", async () => {
    // bin/llm's grace loop polls the PROCESS GROUP's liveness (`kill -0 --
    // -$pid`), not the leader's own exit — a leader whose `done` marker is
    // already set (it exited on TERM) must still get the follow-up SIGKILL
    // if a grandchild survives in the same group. Real upstream regression:
    // tests/test_llm_adapter.sh "the adapter's children die with it".
    //
    // Row ~56 of parity/RUNTIME-SEAMS.md: proving this requires more than an
    // exit code and an elapsed-time bound — it requires checking that the
    // grandchild's OWN real OS pid is actually gone, since a leaked
    // TERM-ignoring grandchild is exactly the failure `kill -- -pid`
    // (bin/llm:1197-1204) exists to prevent. The grandchild writes its own
    // pid to a file so the test can `process.kill(pid, 0)` it directly.
    const adapter = path.join(TMP, "adapter-with-child");
    const grandchildPidFile = path.join(TMP, "grandchild.pid");
    writeAdapter(
      adapter,
      [
        'const { spawn } = require("child_process");',
        // No `detached: true` here — the grandchild stays in the SAME
        // process group as this leader, like bash's plain `cmd &`.
        `const gc = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{}); setInterval(()=>{},1000);"], { stdio: "ignore" });`,
        `require("fs").writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid));`,
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n")
    );
    const t0 = Date.now();
    const r = await run(["-m", "x", "say ok"], {
      env: adapterEnv({ LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter, LLM_MAX_TIME: "1" }),
      realSleep: true,
    });
    const elapsedS = (Date.now() - t0) / 1000;
    expect(r.code).toBe(1);
    expect(elapsedS).toBeLessThan(15); // grace period is at most 5s past the 1s deadline

    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8"));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // The group kill has already happened by the time run() resolves; under
    // heavy system load (e.g. the full suite running in parallel) the OS can
    // take a beat to finish reaping a SIGKILLed/reparented process before
    // kill(pid, 0) reports ESRCH, so poll briefly rather than asserting
    // instantaneously — this bounds the property (dead soon after, not
    // instantly) without weakening what's actually being proven.
    const deadline = Date.now() + 3000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false); // ESRCH: whole group, including the grandchild, is dead
  }, 20000);
  it("a fast adapter pays no watcher tick (two calls complete well under a second each)", async () => {
    const adapter = path.join(TMP, "adapter");
    writeAdapter(adapter, OK_ADAPTER);
    const t0 = Date.now();
    await run(["-m", "x", "say ok"], { env: adapterEnv({ LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter, ADAPTER_ARGS_FILE: path.join(TMP, "a1"), ADAPTER_STDIN_FILE: path.join(TMP, "s1") }), realSleep: true });
    await run(["-m", "x", "say ok"], { env: adapterEnv({ LLM_PROVIDER: "adapter", LLM_ADAPTER: adapter, ADAPTER_ARGS_FILE: path.join(TMP, "a2"), ADAPTER_STDIN_FILE: path.join(TMP, "s2") }), realSleep: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
