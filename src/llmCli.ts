// llmCli.ts — the `llm` tool the model's bash invokes (and `mem search` shells
// out to). Faithful port of headlong/bin/llm: the OpenAI-family wire path
// (openai, openrouter, opencode-go, openai-compatible), the Anthropic wire
// path (anthropic, opencode/Zen — same protocol), the Gemini wire path, and
// the `--provider adapter` exec seam (design/providers.md).
//
// The CLI CONTRACT is held exact: same flags and parsing quirks, prompt
// resolution, model/provider/endpoint resolution and their stderr texts, the
// per-model max-tokens table, the stdout newline asymmetry (streaming: deltas
// as they arrive, no trailing newline; non-streaming: text + one newline),
// retry semantics (only while nothing has been emitted), truncation warning,
// exit codes, and the on-disk effects (health marker, usage ledger,
// LLM_USAGE_FILE). Behaviour is the blueprint, not the Bash text: curl/jq
// plumbing becomes fetch + JSON.
//
// PORT-NOTEs (deliberate deviations, all on misuse or transport-error paths):
//   - `${2:?msg}` on a missing/empty flag value prints `llm: error: <msg>`
//     (exit 1) instead of bash's `<script>: line N: 2: <msg>` — same as mem.
//   - `-M` that is not valid JSON dies `llm: error: --messages is not valid
//     JSON …` exit 1; Bash surfaces jq's parse error and exits 5. Likewise
//     `-M <non-array>` with `-s` (jq "cannot be added", exit 5) → exit 1.
//   - transport failures on the streaming path say `request failed: <detail>`
//     where Bash relays curl's own text (`curl error: curl: (7) …`); the exit
//     code, retry behaviour, and health-marker kind are identical. The
//     non-streaming path never showed curl's text (`HTTP 000`) — unchanged.
//   - .env files are parsed as `[export ]KEY=VALUE` lines (like the port's
//     .memrc), not sourced as shell; env > file precedence is preserved.
//   - LLM_CONNECT_TIMEOUT (curl --connect-timeout, bin/llm:102,1424-1425):
//     fetch has no connect-phase hook, so a TCP connect to the same
//     host:port runs beside each attempt and the timer is cleared when it
//     connects (or the response arrives). It bounds the TCP connect only,
//     never the wait for the first byte (K1). curl's timer also covers the
//     TLS handshake; this one does not. LLM_SPEED_LIMIT/LLM_SPEED_TIME approximate curl's low-speed
//     abort as "no bytes for LLM_SPEED_TIME seconds".
//   - a non-JSON 2xx body on the non-streaming path dies `llm: error: API
//     error: response body is not JSON (HTTP 200)` exit 1; the Bash crashes
//     inside jq under `set -e` (exit 5, no message). Both: no retry, no marker.
//   - an unparseable SSE `data:` event is skipped silently; the Bash lets
//     jq's parse error through to stderr and likewise extracts nothing.
//   - no temp files at all (Bash used mktemp for payload/auth/usage).
//   - a 2xx JSON whose SHAPE aborts the jq checker/extractor (`{"error":"s"}`,
//     `{"choices":"s"}`, a string `message`) dies `llm: error: API error:
//     response shape/text is not readable (HTTP 200)` exit 1 at the same two
//     points where the Bash exits 5 silently (before the ok marker for the
//     checker; after marker + ledger for the extractor).
//   - `-M` documents jq and JSON.parse read differently (`null` with -s,
//     whitespace-only, two documents, a lone-surrogate escape): the port
//     refuses up front / accepts the surrogate — PARITY.md "-M documents".
//   - NUL bytes in the prompt / system-prompt file are kept; `$(cat)` drops
//     them with a bash warning.
//   - .env: a `KEY = v` line is skipped where the Bash loader crashes and
//     stops loading; CRLF files are tolerated (Bash keeps the `\r`); an
//     unreadable file is skipped silently (Bash prints sed's error); an unset
//     HOME falls back to `/.headlong` instead of a `set -u` crash.
//   - LLM_RETRIES / LLM_RETRY_BACKOFF that are not plain integers (`08`,
//     `1.5`, `abc`) are parsed leniently where the Bash crashes in `$(( ))`.
//   - usage records: a missing prompt_tokens / completion_tokens does NOT shift
//     the remaining values into the wrong field — deliberate fix of a Bash
//     `IFS=$'\t' read` bug (see usageOpenAI in llmProvider.ts).
//   - JSON is re-serialized by JSON.stringify: number literals (`1.0`, `1E+2`,
//     > 2^53) are canonicalized where jq keeps their text; `--raw` prints the
//     body decoded as UTF-8 (invalid bytes → U+FFFD) where `cat` copies bytes.
//   - a body holding several JSON documents parses as non-JSON (jq processes
//     every document): error bodies fall back to the raw text / `HTTP <code>`;
//     a stale multi-document LLM_USAGE_FILE ledgers nothing (`jq | head -1`
//     ledgers the first); an unwritable LLM_USAGE_FILE is silent (bash prints
//     its redirection error).
//   - an API key containing a newline is refused by fetch (`request failed:
//     …`) where curl sends a malformed request; kind `other` both.
//
//   - anthropic/opencode `type:"error"` mid-stream SSE event: the Bash's
//     `die` runs inside the stream-handler subshell — its message reaches
//     real stderr immediately, but the OUTER retry loop only gates on
//     whether anything was already emitted, not on why the subshell died,
//     so a fatal event with nothing emitted yet is still retried (see
//     createAnthropicStreamHandler's doc comment in llmProvider.ts).
//
// Loaded from source by Node's native type stripping (bin/llm.mjs): strip-safe
// TS only (no enums / namespaces / parameter properties; `import type`).

import * as net from "node:net";
import * as path from "node:path";
import { createFenceStopTracker, type FenceStopTracker } from "./extract.ts";
import {
  buildAdapterArgs,
  buildAnthropicPayload,
  buildGeminiPayload,
  buildOpenAIPayload,
  buildOpencodeZenPayload,
  buildOpenRouterProviderBlock,
  checkResponseAnthropic,
  checkResponseGemini,
  checkResponseOpenAI,
  classifyFailureKind,
  createAnthropicStreamHandler,
  createGeminiStreamHandler,
  createOpenAIStreamHandler,
  jqGet,
  detectProvider,
  errorMessageOf,
  extractShapeErrorAnthropic,
  extractShapeErrorGemini,
  extractShapeErrorOpenAI,
  extractTextAnthropic,
  extractTextGemini,
  extractTextOpenAI,
  responseShapeErrorAnthropic,
  responseShapeErrorGemini,
  responseShapeErrorOpenAI,
  getModelMaxTokens,
  hostOf,
  isTruncatedAnthropic,
  isTruncatedGemini,
  isTruncatedOpenAI,
  OPENAI_FAMILY,
  parseJson,
  PayloadError,
  streamErrorMessageOf,
  usageAnthropic,
  usageGemini,
  usageOpenAI,
  type UsageRecord,
} from "./llmProvider.ts";

// ---------------------------------------------------------------------------
// Injectable IO — the shim wires process.*; tests inject a fake server's fetch,
// a fixed clock, an instant sleep, and scratch dirs.
// ---------------------------------------------------------------------------

/** The slice of node:fs the tool touches (health marker, ledger, usage file, prompt files). */
export interface LlmFs {
  statSync(p: string): { isFile(): boolean };
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string, opts?: { mode?: number }): void;
  appendFileSync(p: string, data: string): void;
  mkdirSync(p: string, opts: { recursive: true; mode?: number }): unknown;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  rmSync(p: string, opts: { recursive: true; force: true }): void;
  /** Throws when `p` is not accessible with `mode` (fs.constants.X_OK = 1). */
  accessSync(p: string, mode: number): void;
}

/** A running/finished adapter process (LlmIO.spawnAdapter) — the seam that keeps
 * node:child_process out of this module (see src/llmAdapterProcess.ts for the
 * real implementation bin/llm.mjs wires in; tests may inject a fake one). */
export interface LlmSpawnHandle {
  /** -1 when the platform could not report a pid. */
  pid: number;
  writeStdin(data: string): void;
  endStdin(): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Resolves once the process has exited. */
  wait(): Promise<{ code: number | null; signal: string | null }>;
  /** Signal the whole process group (bash `kill -- -$pid`); a no-op once the process has already exited. */
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
  /**
   * `kill -0 -- -$pid`: true while ANY process remains in the group — not
   * only the leader. A leader that TERM-traps into a quick `exit 0` while an
   * orphaned grandchild ignores TERM (still in the same group) must keep
   * this true, so the deadline's grace-then-KILL loop (which gates on this,
   * not on the leader's own exit) still reaches the survivor.
   */
  groupAlive(): boolean;
}

export interface LlmIO {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Full stdin contents (read only when no prompt/-M and stdin is not a TTY). */
  readStdin(): string;
  stdinIsTTY: boolean;
  now(): Date;
  fetch: typeof globalThis.fetch;
  fs: LlmFs;
  sleep(ms: number): Promise<void>;
  /** `LLM_PROVIDER=adapter`: run `cmd` with `args`, cwd/env as given. */
  spawnAdapter(
    cmd: string,
    args: string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      /** `_LLM_SHARED_PROCESS_GROUP=1` (sync 2e39a3f, 2a63d92): do NOT regroup the adapter — it stays in this
       * process's own group, and the handle's `killGroup` signals THAT group (a caller that owns the group,
       * e.g. `mem search`'s worker, cancels the whole tree). Throws (message = the die text) when the own
       * process group cannot be read or is invalid. */
      sharedGroup?: boolean;
      /** A deadline watcher is armed (LLM_MAX_TIME > 0): only then is the own process group read. */
      deadline?: boolean;
    },
  ): LlmSpawnHandle;
  /** A short random token for private tempfile/dir names (mktemp's XXXXXX suffix). */
  randomToken(): string;
}

/** Thrown by `die` to unwind to the runLlm boundary. */
class LlmExit extends Error {
  readonly code: number;
  readonly dieMsg: string | undefined;
  constructor(code: number, dieMsg?: string) {
    super(dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
  }
}
function die(msg: string): never {
  throw new LlmExit(1, msg);
}

export const USAGE = `Usage:
  llm [options] prompt...
  echo prompt | llm [options]
  llm [options] -M MESSAGES_JSON

Options:
  -m, --model MODEL        Model to use. Default: picked for whichever API
                           key is set (Anthropic, then OpenAI, Gemini, OpenRouter)
  -s, --system-prompt TEXT System prompt text
  --system-prompt-file F   Read system prompt from file
  -t, --max-tokens N       Max output tokens. Default: model-specific cap
  -M, --messages JSON      Messages array JSON, e.g. [{"role":"user","content":"hi"}]
  --messages-file F        Read messages array JSON from file
  --no-stream              Disable streaming (streaming is on by default)
  --provider NAME          Provider: anthropic, openai, gemini, openrouter,
                           opencode, opencode-go, openai-compatible, or
                           adapter (needs LLM_ADAPTER)
  --or-only SLUGS          Pin routing to these provider slugs
  --or-data-collection X   "allow" or "deny" hosts that may store the prompt
  --or-zdr                 Zero-data-retention endpoints only
                           (the three apply when the effective provider is
                           openrouter, named or inferred from the model)
  --thinking [LEVEL]       Enable thinking (Anthropic: adaptive; Gemini: minimal/low/medium/high)
  --effort LEVEL           Thinking effort/provider output effort
  --json-schema FILE       Ask for one JSON object matching this JSON Schema
                           (response_format json_schema, strict) on OpenAI-style
                           providers; ignored with a warning elsewhere
  --raw                    Print raw non-streaming API response JSON
  -h, --help               Show this help

Models:
  Anthropic:  claude-opus-4-7, claude-sonnet-4-5, claude-haiku-4-5
              claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus
  OpenAI:     gpt-5.5, gpt-5, gpt-4o, o1, o3, o4
  Gemini:     gemini-3.5-flash, gemini-2.0-flash, gemini-*
  OpenRouter: z-ai/glm-5.2, meta-llama/*, ... (any vendor/model name)
  OpenCode:   opencode-go/* (Go subscription, OpenAI wire format)
              opencode/*  (Zen pay-per-token, Anthropic wire format)
  Compatible: any model name, via --provider openai-compatible and
              LLM_API_URL (Ollama, vLLM, LM Studio, proxies; never
              auto-detected)
  Adapter:    any model name, via --provider adapter and LLM_ADAPTER
              (an external executable handles the completion; see
              design/providers.md for the contract)

Thinking & effort:
  These flags control how much reasoning the model does before answering.
  Each provider implements this differently:

  Anthropic (--thinking, --effort):
    --thinking enables extended thinking (chain-of-thought visible on stderr).
    --effort controls output effort independent of thinking:
      low, medium, high (default), xhigh, max
    Both flags can be combined. Without --thinking, the model still reasons
    internally but doesn't expose it.

  Gemini (--thinking LEVEL):
    Gemini models think by default. --thinking sets the depth:
      minimal  Suppress thinking; lowest latency
      low      Light reasoning
      medium   Balanced (default for 3.5 Flash)
      high     Deep reasoning (default for 3.1 Pro)
    --effort is ignored for Gemini.

  OpenAI (--thinking LEVEL):
    GPT-5.5 and o-series models support reasoning. --thinking sets depth:
      none     No reasoning; lowest latency
      low      Light reasoning
      medium   Balanced (default for gpt-5.5)
      high     Deep reasoning
      xhigh    Maximum reasoning depth
    --effort is ignored for OpenAI.

Environment:
  ANTHROPIC_API_KEY        Required for Anthropic models
  OPENAI_API_KEY           Required for OpenAI models
  GEMINI_API_KEY           Required for Gemini models
  OPENROUTER_API_KEY       Required for OpenRouter models
  LLM_OR_ONLY, LLM_OR_DATA_COLLECTION, LLM_OR_ZDR
                           Defaults for the matching --or-* flags. Applied
                           when the effective provider is openrouter; setting
                           one here prints the effective routing on stderr
  OPENCODE_API_KEY         Required for OpenCode models — both plans use it;
                           opencode-go/* bills the Go subscription, opencode/*
                           bills Zen. Keys: \`opencode auth login\`
  LLM_API_URL              Override provider API URL. Required for
                           openai-compatible, which has no default endpoint
  LLM_API_KEY              Optional key for openai-compatible, sent as
                           Authorization: Bearer when set (local servers
                           like Ollama need none)
  LLM_ADAPTER              Path to an adapter executable; required with
                           --provider adapter (contract: design/providers.md)
  LLM_PROVIDER             Provider to use when the model name implies none
                           (same names as --provider); --provider takes
                           precedence, and a value that disagrees with the
                           name warns on stderr
  LLM_MAX_TOKENS           Override the per-model default output cap (same as -t)
  LLM_RETRIES              Retries for transient API failures (default: 2;
                           0 disables). Never retries after partial output.
  LLM_RETRY_BACKOFF        Backoff base seconds between retries (default: 1)
  LLM_CONNECT_TIMEOUT      Seconds to establish the connection (default: 10;
                           0 disables)
  LLM_MAX_TIME             Hard ceiling on one HTTP attempt, seconds
                           (default: 600; 0 disables)
  LLM_SPEED_LIMIT          Abort a transfer slower than this many bytes/s...
  LLM_SPEED_TIME           ...for this many consecutive seconds (defaults:
                           100 bytes/s over 60s; 0 on either disables)
  LLM_STOP_AFTER_CODE_BLOCK
                           1 (or --stop-after-code-block): stop reading the
                           stream once the first fenced code block closes
                           (heredoc-aware, same rules as bin/shellm) and
                           return what was emitted. For callers that run the
                           first block and drop the rest: a model that keeps
                           writing after its command no longer costs tokens
                           or wall time. Usage is then estimated
                           (out_tok from bytes, estimated:true).

Examples:
  llm -m claude-sonnet-4-5-20250929 "explain quicksort"
  echo "summarize this" | llm -m gpt-5
  llm --thinking -m claude-opus-4-7 "solve this carefully"
  llm --raw -m gemini-2.0-flash "return a JSON greeting"
  llm -m z-ai/glm-5.2 "explain quicksort"
  LLM_API_URL=http://localhost:11434/v1/chat/completions \\
    llm --provider openai-compatible -m qwen3:8b "explain quicksort"
`;

// ---------------------------------------------------------------------------
// .env layering (bin/llm _llm_load_env): cwd .env, then the state home's .env;
// each fills only vars NOT already set (set-but-empty counts as set).
// ---------------------------------------------------------------------------

/**
 * Parse `[export ]KEY=VALUE` lines (the same simple form as the port's .memrc);
 * one layer of matching quotes is removed; a later assignment of the same key
 * wins, as sourcing would. Lines that are not plain assignments are skipped.
 *
 * PORT-NOTE: a `KEY = v` line is skipped here; the Bash loader's sed picks the
 * key up, fails to source it, warns `could not read .env` and STOPS loading
 * the rest of the file. `trim()` also drops a CR, so a CRLF file works here
 * where the Bash keeps `\r` in every value. `export` may be followed by any
 * `[[:space:]]+` run (sed), not only one space.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^export[ \t\v\f]+/.test(line)) line = line.replace(/^export[ \t\v\f]+/, "");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
    if (q) v = q[1]!;
    out.set(m[1]!, v);
  }
  return out;
}

function loadEnvFile(io: LlmIO, env: Record<string, string | undefined>, file: string): void {
  let text: string;
  try {
    if (!io.fs.statSync(file).isFile()) return;
    text = io.fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [k, v] of parseEnvFile(text)) {
    if (k in env) continue; // real environment always wins
    env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Opts {
  model: string;
  system: string;
  maxTokens: string;
  messages: string;
  stream: boolean;
  provider: string;
  thinking: boolean;
  thinkingLevel: string;
  effort: string;
  /** --json-schema FILE contents ("" = none) — bin/llm LLM_JSON_SCHEMA. */
  jsonSchema: string;
  raw: boolean;
  /** --stop-after-code-block / LLM_STOP_AFTER_CODE_BLOCK — bash: `[[ "$X" ==
   *  1 ]]`, an EXACT-string check, not truthy ("true"/"0"/etc. leave it off). */
  stopAfterCodeBlock: boolean;
  prompt: string;
  /** --or-only/LLM_OR_ONLY, raw (unnormalized) text; "" = unset. */
  orOnly: string;
  /** --or-data-collection/LLM_OR_DATA_COLLECTION, raw text; "" = unset. */
  orDataCollection: string;
  /** --or-zdr/LLM_OR_ZDR, raw text; "" = unset, flag presence sets "1". */
  orZdr: string;
}

function parseArgs(argv: string[], io: LlmIO, env: Record<string, string | undefined>): Opts {
  const o: Opts = {
    model: env["LLM_MODEL"] ?? "",
    system: "",
    maxTokens: env["LLM_MAX_TOKENS"] ?? "",
    messages: "",
    stream: true,
    provider: env["LLM_PROVIDER"] ?? "",
    thinking: false,
    thinkingLevel: "",
    effort: "",
    jsonSchema: "",
    raw: false,
    stopAfterCodeBlock: (env["LLM_STOP_AFTER_CODE_BLOCK"] ?? "") === "1",
    prompt: "",
    orOnly: env["LLM_OR_ONLY"] ?? "",
    orDataCollection: env["LLM_OR_DATA_COLLECTION"] ?? "",
    orZdr: env["LLM_OR_ZDR"] ?? "",
  };
  // Bash `${2:?msg}`: missing OR empty → error (PORT-NOTE: clean message text).
  const val = (i: number, msg: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v === "") die(msg);
    return v;
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help":
        io.stdout(USAGE);
        throw new LlmExit(0);
      case "-m":
      case "--model":
        o.model = val(i, "--model requires a value");
        i += 2;
        break;
      case "-s":
      case "--system-prompt":
        o.system = val(i, "--system-prompt requires a value");
        i += 2;
        break;
      case "--system-prompt-file": {
        const f = val(i, "--system-prompt-file requires a path");
        const abs = path.resolve(io.cwd, f);
        let isFile = false;
        try {
          isFile = io.fs.statSync(abs).isFile();
        } catch {
          /* missing */
        }
        if (!isFile) die(`System prompt file not found: ${f}`);
        // `$(cat "$f")` strips every trailing newline.
        o.system = io.fs.readFileSync(abs, "utf8").replace(/\n+$/, "");
        i += 2;
        break;
      }
      case "-t":
      case "--max-tokens":
        o.maxTokens = val(i, "--max-tokens requires a value");
        i += 2;
        break;
      case "-M":
      case "--messages":
        o.messages = val(i, "--messages requires a value");
        i += 2;
        break;
      case "--messages-file": {
        const f = val(i, "--messages-file requires a path");
        const abs = path.resolve(io.cwd, f);
        let isFile = false;
        try {
          isFile = io.fs.statSync(abs).isFile();
        } catch {
          /* missing */
        }
        if (!isFile) die(`Messages file not found: ${f}`);
        // `$(cat "$f")` strips every trailing newline, same as --system-prompt-file.
        o.messages = io.fs.readFileSync(abs, "utf8").replace(/\n+$/, "");
        i += 2;
        break;
      }
      case "--or-only":
        o.orOnly = val(i, "--or-only requires a value");
        i += 2;
        break;
      case "--or-data-collection":
        o.orDataCollection = val(i, "--or-data-collection requires a value");
        i += 2;
        break;
      case "--or-zdr":
        o.orZdr = "1";
        i += 1;
        break;
      case "--stream":
        o.stream = true;
        i += 1;
        break;
      case "--no-stream":
        o.stream = false;
        i += 1;
        break;
      case "--provider":
        o.provider = val(i, "--provider requires a value");
        i += 2;
        break;
      case "--thinking": {
        o.thinking = true;
        // Greedy: swallows the next argv when it exists, is non-empty, and
        // does not start with '-'.
        const nxt = argv[i + 1];
        if (nxt !== undefined && nxt !== "" && !nxt.startsWith("-")) {
          o.thinkingLevel = nxt;
          i += 1;
        }
        i += 1;
        break;
      }
      case "--effort":
        o.effort = val(i, "--effort requires a value");
        i += 2;
        break;
      case "--json-schema": {
        const jsf = val(i, "--json-schema requires a path");
        let text: string;
        try {
          text = io.fs.readFileSync(path.resolve(io.cwd, jsf), "utf8");
        } catch {
          return die(`Schema file not found: ${jsf}`);
        }
        o.jsonSchema = text.replace(/\n+$/, "");
        i += 2;
        break;
      }
      case "--raw":
        o.raw = true;
        i += 1;
        break;
      case "--stop-after-code-block":
        o.stopAfterCodeBlock = true;
        i += 1;
        break;
      default:
        if (a.startsWith("-")) die(`Unknown option: ${a} (try llm --help)`);
        // First non-dash arg: the prompt is ALL remaining argv joined by
        // single spaces (later flags included); parsing stops.
        o.prompt = argv.slice(i).join(" ");
        i = argv.length;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Numeric env knobs
// ---------------------------------------------------------------------------

const isNum = (s: string): boolean => /^[0-9]+$/.test(s);
/** `^[0-9]+$` and > 0 → the value, else 0 (disabled). */
function positiveKnob(env: Record<string, string | undefined>, key: string, dflt: number): number {
  const v = env[key];
  const s = v === undefined || v === "" ? String(dflt) : v;
  return isNum(s) && Number(s) > 0 ? Number(s) : 0;
}

// ---------------------------------------------------------------------------
// Runtime context shared by the request paths
// ---------------------------------------------------------------------------

interface Ctx {
  io: LlmIO;
  env: Record<string, string | undefined>;
  home: string;
  provider: string;
  model: string;
  maxTokens: number;
  maxTokensText: string;
  usageFile: string | null; // caller-provided LLM_USAGE_FILE (absolute) or null
  usageRec: UsageRecord | null; // the record written so far (private stand-in when usageFile is null)
  /** OpenRouter's upstream host for this call (bin/llm _llm_served_by); "" = unknown. */
  servedBy: string;
  /** The output hit max_tokens (bin/llm _llm_truncated); recorded in the usage record. */
  truncated: boolean;
  ledger: string;
  identity: string;
  runId: string;
  retries: number;
  backoff: number;
  maxTime: number;
  speedLimit: number;
  speedTime: number;
  connectTimeout: number;
  stopAfterCodeBlock: boolean;
}

const jqJson = (s: string): string => s.replace(/\x7f/g, "\\u007f");
function isoNow(io: LlmIO): string {
  return io.now().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** _llm_note: rewrite the health marker atomically; never fails the call. */
function note(ctx: Ctx, status: "ok" | "error", httpCode = "", message = ""): void {
  const runDir = path.join(ctx.home, "run");
  const file = path.join(runDir, "llm_health.json");
  try {
    ctx.io.fs.mkdirSync(runDir, { recursive: true });
  } catch {
    return;
  }
  const rec: Record<string, unknown> = {
    ok: status === "ok",
    ts: isoNow(ctx.io),
    provider: ctx.provider,
    model: ctx.model,
  };
  if (status === "error") {
    rec["kind"] = classifyFailureKind(httpCode, message);
    rec["http_code"] = httpCode === "" ? null : isNum(httpCode) ? Number(httpCode) : httpCode;
    rec["message"] = message;
  }
  const tmp = `${file}.${Math.random().toString(36).slice(2)}`;
  try {
    ctx.io.fs.writeFileSync(tmp, jqJson(JSON.stringify(rec, null, 2)) + "\n");
    ctx.io.fs.renameSync(tmp, file);
  } catch {
    try {
      ctx.io.fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
  }
}

/** write_usage: `{in_tok?, out_tok?, think_tok?}` to LLM_USAGE_FILE (best-effort). */
function writeUsage(ctx: Ctx, base: UsageRecord): void {
  // PORT-NOTE (sync 2e39a3f): served_by / truncated ride every record after
  // `estimated`, from the call-wide flags (write_usage's two trailing jq terms).
  const rec: UsageRecord = { ...base };
  if (ctx.servedBy !== "") rec.served_by = ctx.servedBy;
  if (ctx.truncated) rec.truncated = true;
  ctx.usageRec = rec;
  if (ctx.usageFile === null) return;
  try {
    ctx.io.fs.writeFileSync(ctx.usageFile, jqJson(JSON.stringify(rec)) + "\n");
  } catch {
    /* best-effort */
  }
}

/** _llm_ledger_append: one JSON line per successful call carrying a non-empty usage record. */
function ledgerAppend(ctx: Ctx): void {
  let rec: UsageRecord | null = null;
  if (ctx.usageFile !== null) {
    // Faithful to the Bash: the ledger re-reads the caller's usage file.
    // PORT-NOTE: one JSON document is expected there; the Bash's
    // `jq -c select(…) | head -1` would ledger the FIRST of several.
    try {
      const p = parseJson(ctx.io.fs.readFileSync(ctx.usageFile, "utf8"));
      if (p.ok && p.value !== null && typeof p.value === "object" && !Array.isArray(p.value)) {
        rec = p.value as UsageRecord;
      }
    } catch {
      rec = null;
    }
  } else {
    rec = ctx.usageRec;
  }
  if (rec === null || Object.keys(rec).length === 0) return;
  try {
    ctx.io.fs.mkdirSync(path.dirname(ctx.ledger), { recursive: true });
  } catch {
    return;
  }
  const line: Record<string, unknown> = { ts: isoNow(ctx.io), provider: ctx.provider, model: ctx.model, ...rec };
  if (ctx.identity !== "") line["identity"] = ctx.identity;
  if (ctx.runId !== "") line["run_id"] = ctx.runId;
  try {
    ctx.io.fs.appendFileSync(ctx.ledger, jqJson(JSON.stringify(line)) + "\n");
  } catch {
    /* best-effort */
  }
}

/** `jq --argjson schema "$LLM_JSON_SCHEMA"`: jq aborts on text that is not
 *  JSON (exit 2, nothing sent). PORT-NOTE: same fail-fast, with a plain message
 *  instead of jq's parse diagnostic (a documented jq-internal-error deviation). */
function parseSchema(text: string): unknown {
  const p = parseJson(text);
  if (!p.ok) die("--json-schema file is not valid JSON");
  return p.value;
}

function warnTruncated(ctx: Ctx): void {
  ctx.truncated = true;
  ctx.io.stderr(
    `llm: warning: output truncated at max_tokens=${ctx.maxTokensText} (reasoning tokens count against it) — raise with -t\n`
  );
}

// ---------------------------------------------------------------------------
// Transport: one POST with curl's guards approximated (see PORT-NOTEs above).
// ---------------------------------------------------------------------------

interface Guards {
  maxTime: number; // seconds, 0 = off
  speedLimit: number;
  speedTime: number; // seconds, 0 = off
  connectTimeout: number; // seconds, 0 = off
}

interface Attempt {
  controller: AbortController;
  /** Set before aborting so the catch can name the reason. */
  reason: string | null;
  touch(): void;
  done(): void;
}

function startAttempt(g: Guards, url?: string): Attempt {
  const controller = new AbortController();
  const a: Attempt = {
    controller,
    reason: null,
    touch: () => {},
    done: () => {},
  };
  let maxT: ReturnType<typeof setTimeout> | null = null;
  let stallT: ReturnType<typeof setTimeout> | null = null;
  // PORT-NOTE (K1, fixed 2026-10-29): curl's --connect-timeout (bin/llm:102, 1424-1425) bounds ONLY the connect; a
  // server that connects at once but is slow to send its headers is left to --speed-limit/--speed-time (:108-109,
  // 1428-1430). The port used to time the whole wait for the first byte, which aborted a slow header that upstream
  // waits for. fetch exposes no connect hook (and Bun's fetch, the default runtime when installed, has no connect
  // timeout at all), so a plain TCP connect to the same host:port runs beside the request and clears the timer when it
  // connects; the first response byte clears it too. A refused or unresolvable connect is left to fetch's own error.
  let connectT: ReturnType<typeof setTimeout> | null = null;
  let probe: net.Socket | null = null;
  const endConnectWatch = (): void => {
    if (connectT) clearTimeout(connectT);
    connectT = null;
    probe?.destroy();
    probe = null;
  };
  if (g.connectTimeout > 0 && url) {
    let target: { host: string; port: number } | null = null;
    try {
      const u = new URL(url);
      target = { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
    } catch {
      target = null;
    }
    if (target) {
      connectT = setTimeout(() => {
        a.reason = `connect timeout after ${g.connectTimeout}s (LLM_CONNECT_TIMEOUT)`;
        endConnectWatch();
        controller.abort();
      }, g.connectTimeout * 1000);
      connectT.unref?.();
      probe = net.connect(target);
      probe.once("connect", endConnectWatch);
      probe.on("error", endConnectWatch);
    }
  }
  if (g.maxTime > 0) {
    maxT = setTimeout(() => {
      a.reason = `timed out after ${g.maxTime}s (LLM_MAX_TIME)`;
      controller.abort();
    }, g.maxTime * 1000);
    maxT.unref?.();
  }
  const armStall = (): void => {
    if (stallT) clearTimeout(stallT);
    if (g.speedLimit > 0 && g.speedTime > 0) {
      stallT = setTimeout(() => {
        a.reason = `no data for ${g.speedTime}s (LLM_SPEED_LIMIT=${g.speedLimit} B/s over LLM_SPEED_TIME=${g.speedTime}s)`;
        controller.abort();
      }, g.speedTime * 1000);
      stallT.unref?.();
    }
  };
  a.touch = () => {
    if (connectT || probe) endConnectWatch();
    armStall();
  };
  a.done = () => {
    if (maxT) clearTimeout(maxT);
    if (stallT) clearTimeout(stallT);
    endConnectWatch();
  };
  armStall(); // the stall timer runs from the start, so it also bounds a header stall (curl --speed-time does too)
  return a;
}

function errorDetail(e: unknown, a: Attempt): string {
  if (a.reason !== null) return a.reason;
  const err = e as { message?: unknown; cause?: { message?: unknown } };
  const cause = err?.cause?.message;
  if (typeof cause === "string" && cause !== "") return cause;
  const m = err?.message;
  return typeof m === "string" && m !== "" ? m : String(e);
}

/**
 * Split a byte stream into lines (LF), CR-stripped; a final unterminated line
 * is delivered too. `onLine` may return `true` to stop reading immediately
 * (PORT-NOTE 1c: 2d1c1c3 — LLM_STOP_AFTER_CODE_BLOCK: the caller's sink
 * signalled that the first code block just closed). On that early stop the
 * trailing partial-line flush is skipped — there is nothing more to read, and
 * bin/llm's own `_emit_text` never processes a partial trailing line either
 * (it works one COMPLETE line at a time). Returns whether it stopped early.
 */
async function forEachLine(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => boolean | void,
  onBytes: () => void
): Promise<boolean> {
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let stopped = false;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      onBytes();
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (onLine(line) === true) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
  } finally {
    if (!stopped) {
      buf += dec.decode();
      if (buf !== "") onLine(buf.replace(/\r$/, ""));
    }
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// The request paths
// ---------------------------------------------------------------------------

interface Request {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * PORT-NOTE (1c: 2d1c1c3) — LLM_STOP_AFTER_CODE_BLOCK's `_emit_text`: printed
 * text is ALWAYS emitted first (bash: `printf '%s' "$1"` unconditionally),
 * then — only when the flag is on — fed to the fence tracker; the instant the
 * first block closes, bash's `echo ... >&2` fires and the caller's read loop
 * breaks (curl's resulting broken pipe is a clean finish, not a transport
 * error). Shared by all three providers' streaming text sinks; NEVER wraps
 * Anthropic's separate `thinking` sink — only the model's visible answer can
 * close a fenced block that matters to the one-bash-block contract.
 */
function makeStopGate(
  ctx: Ctx,
  emit: (chunk: string) => void
): { text: (chunk: string) => void; stopped(): boolean; tracker: FenceStopTracker | null } {
  const tracker = ctx.stopAfterCodeBlock ? createFenceStopTracker() : null;
  let stopped = false;
  return {
    text(chunk: string): void {
      emit(chunk);
      if (tracker !== null && !stopped && tracker.feed(chunk)) {
        stopped = true;
        ctx.io.stderr("llm: stopped reading after the first code block closed (LLM_STOP_AFTER_CODE_BLOCK)\n");
      }
    },
    stopped: () => stopped,
    tracker,
  };
}

/** On a stop-after-code-block cut: usage is estimated from bytes emitted
 *  (`(bytes + 3) / 4`, bin/llm's own heuristic) — this REPLACES any usage
 *  already recorded during the stream, matching write_usage's whole-file
 *  overwrite. Always ends the call as a clean success (note ok + ledger). */
function finishStopped(ctx: Ctx, tracker: FenceStopTracker): void {
  // The Bash writes this estimate from the PARENT shell, whose served_by /
  // truncated were never touched (the stream handler ran in a subshell).
  ctx.servedBy = "";
  ctx.truncated = false;
  writeUsage(ctx, { out_tok: Math.floor((tracker.bytes + 3) / 4), estimated: true });
  note(ctx, "ok");
  ledgerAppend(ctx);
}

async function runStreaming(ctx: Ctx, req: Request, guards: Guards): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let emitted = false;
    let transportErr = "";
    let retryMsg = "";
    let refusedMsg = "";
    // Each attempt's handler is a subshell in the Bash: its flags start clean.
    ctx.servedBy = "";
    ctx.truncated = false;
    const gate = makeStopGate(ctx, (chunk) => {
      emitted = true;
      ctx.io.stdout(chunk);
    });
    const handler = createOpenAIStreamHandler({
      text: gate.text,
      truncated: () => warnTruncated(ctx),
      usage: (rec) => writeUsage(ctx, rec),
      servedBy: (name) => {
        if (ctx.servedBy === "") ctx.servedBy = name;
      },
      // PORT-NOTE (sync 2e39a3f): finish_reason "content_filter" with nothing
      // emitted yet is a refusal — recorded as the retry message, and a
      // "refused:" message is never retried (same content, same answer).
      refused: () => {
        if (!emitted) refusedMsg = "refused: the provider content filter blocked this request (finish_reason content_filter)";
      },
    });
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      // curl -sS does not fail on HTTP status: the body lines decide.
      if (resp.body) {
        await forEachLine(
          resp.body,
          (line) => {
            handler.line(line);
            return gate.stopped();
          },
          a.touch
        );
      }
    } catch (e) {
      transportErr = errorDetail(e, a);
    } finally {
      a.done();
    }
    if (gate.stopped()) {
      finishStopped(ctx, gate.tracker!);
      return;
    }
    // _die_if_no_stream_data: no SSE data at all → the buffered lines are an
    // API error body (retryable; a streamed 4xx is retried too).
    if (!handler.sawData && handler.errBuf !== "") {
      const m = streamErrorMessageOf(handler.errBuf);
      retryMsg = (m !== "" ? `API error: ${m}` : `API error: ${handler.errBuf}`).replace(/\n+$/, "");
    }
    if (retryMsg === "" && refusedMsg !== "") retryMsg = refusedMsg;
    if (retryMsg === "" && transportErr === "") {
      if (emitted) {
        note(ctx, "ok");
        ledgerAppend(ctx);
        return;
      }
      retryMsg = "empty response: stream ended without emitting anything";
    }
    if (!emitted && attempt < maxAttempts && !retryMsg.startsWith("refused:")) {
      const why = retryMsg !== "" ? retryMsg : transportErr;
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${why} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }
    if (retryMsg !== "") {
      note(ctx, "error", "", retryMsg);
      die(retryMsg);
    }
    note(ctx, "error", "", `request failed: ${transportErr}`);
    die(`request failed: ${transportErr}`);
  }
}

async function runNonStreaming(ctx: Ctx, req: Request, guards: Guards, raw: boolean): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  let httpCode = "000";
  let body = "";
  for (;;) {
    attempt += 1;
    httpCode = "000";
    body = "";
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      const chunks: Uint8Array[] = [];
      if (resp.body) {
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
          a.touch();
          chunks.push(chunk);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
      httpCode = String(resp.status).padStart(3, "0");
    } catch {
      httpCode = "000"; // curl failed: `|| http_code="000"`
      body = "";
    } finally {
      a.done();
    }

    // Transient: network failure, timeout, rate limit, server error.
    if (/^(000|408|429|5[0-9][0-9])$/.test(httpCode) && attempt < maxAttempts) {
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): HTTP ${httpCode} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }

    // A 2xx can still carry an embedded failure; nothing emitted yet, so retry.
    if (httpCode !== "000" && Number(httpCode) < 400) {
      let embedded: string;
      if (/[^ \t\n\v\f\r]/.test(body)) {
        const p = parseJson(body);
        // PORT-NOTE: on a non-JSON 2xx body the Bash crashes inside the jq
        // checker (`set -e`, exit 5, silent, no marker, no retry). The port
        // fails the same way — immediately, without a marker — but loudly.
        if (!p.ok) die(`API error: response body is not JSON (HTTP ${httpCode})`);
        // F11 / PORT-NOTE: a JSON whose shape makes the jq filter abort
        // (`{"error":"s"}`, `{"choices":"s"}`, …) crashes the Bash checker the
        // same way (exit 5, silent). Die HERE — before the ok marker — not
        // after; the reader's "" is jq's empty output, not a clean bill.
        if (responseShapeErrorOpenAI(p.value)) die(`API error: response shape is not readable (HTTP ${httpCode})`);
        embedded = checkResponseOpenAI(p.value);
      } else {
        embedded = "whitespace-only response body";
      }
      if (embedded !== "") {
        if (attempt < maxAttempts) {
          ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${embedded} — retrying\n`);
          await ctx.io.sleep(ctx.backoff * attempt * 1000);
          continue;
        }
        die(`API error: ${embedded}`); // (no health note here — as the Bash)
      }
    }
    break;
  }

  if (Number(httpCode) >= 400 || httpCode === "000") {
    const p = parseJson(body);
    const msg = p.ok ? errorMessageOf(p.value) : "";
    note(ctx, "error", httpCode, msg !== "" ? msg : `HTTP ${httpCode}`);
    if (msg !== "") die(`API error (HTTP ${httpCode}): ${msg}`);
    die(`API error (HTTP ${httpCode})`);
  }
  note(ctx, "ok");

  const p = parseJson(body);
  if (p.ok && isTruncatedOpenAI(p.value)) warnTruncated(ctx);
  if (p.ok && ctx.provider === "openrouter") {
    const g = jqGet(p.value, ["provider"]);
    ctx.servedBy = !g.err && typeof g.value === "string" ? g.value : "";
  }
  if (p.ok) {
    const u = usageOpenAI(p.value);
    if (u.ok) writeUsage(ctx, u.rec);
  }
  ledgerAppend(ctx);

  if (raw) {
    // PORT-NOTE: `cat` copies the body bytes; this is the body decoded as
    // UTF-8 (invalid sequences → U+FFFD) — differs only on a non-UTF-8 body.
    ctx.io.stdout(body);
  } else if (p.ok) {
    // F11 / PORT-NOTE: `extract_text_openai` is the Bash's last command; a
    // shape jq cannot index (`"message":"hi"`) aborts it AFTER the ok marker
    // and ledger line (set -e, exit 5, silent). Same point, exit 1, loud.
    if (extractShapeErrorOpenAI(p.value)) die(`API error: response text is not readable (HTTP ${httpCode})`);
    const text = extractTextOpenAI(p.value);
    if (text !== null) ctx.io.stdout(text + "\n");
  }
}

// ---------------------------------------------------------------------------
// Anthropic-family transport (anthropic, opencode/Zen — same wire protocol).
// Mirrors runStreaming/runNonStreaming above; see PARITY.md for the
// `type:"error"` fatal-event quirk (createAnthropicStreamHandler's doc comment).
// ---------------------------------------------------------------------------

async function runStreamingAnthropic(ctx: Ctx, req: Request, guards: Guards): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let emitted = false;
    let transportErr = "";
    let retryMsg = "";
    let fatalMsg: string | null = null;
    const gate = makeStopGate(ctx, (chunk) => {
      emitted = true;
      ctx.io.stdout(chunk);
    });
    // Each attempt's handler is a subshell in the Bash: its flags start clean.
    ctx.servedBy = "";
    ctx.truncated = false;
    const handler = createAnthropicStreamHandler({
      text: gate.text,
      // NEVER through the stop gate: the fence tracker only ever inspects the
      // model's visible answer, matching bin/llm (the Bash's thinking-delta
      // line is unconditional `jq -j ... >&2`, with no _emit_text call at all).
      thinking: (chunk) => {
        emitted = true;
        ctx.io.stderr(chunk);
      },
      truncated: () => warnTruncated(ctx),
      usage: (rec) => writeUsage(ctx, rec),
      fatal: (message) => {
        fatalMsg = message;
        ctx.io.stderr(`llm: error: ${message}\n`);
      },
    });
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      if (resp.body) {
        await forEachLine(
          resp.body,
          (line) => {
            handler.line(line);
            return gate.stopped();
          },
          a.touch
        );
      }
    } catch (e) {
      if (!handler.isFatal) transportErr = errorDetail(e, a);
    } finally {
      a.done();
    }
    if (gate.stopped()) {
      finishStopped(ctx, gate.tracker!);
      return;
    }
    if (fatalMsg !== null) {
      // Bash: `die` inside the subshell prints its own message directly (above)
      // and exits 1; the OUTER loop only gates retry on the emitted-marker,
      // not on why the subshell exited — so an error event with nothing
      // emitted yet is retried (replaying the die text once per attempt), and
      // once emitted or exhausted the call ends at exit 1 with NO health note.
      if (!emitted && attempt < maxAttempts) {
        ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): exit 1 — retrying\n`);
        await ctx.io.sleep(ctx.backoff * attempt * 1000);
        continue;
      }
      throw new LlmExit(1);
    }
    if (!handler.sawData && handler.errBuf !== "") {
      const m = streamErrorMessageOf(handler.errBuf);
      retryMsg = (m !== "" ? `API error: ${m}` : `API error: ${handler.errBuf}`).replace(/\n+$/, "");
    }
    if (retryMsg === "" && transportErr === "") {
      if (emitted) {
        note(ctx, "ok");
        ledgerAppend(ctx);
        return;
      }
      retryMsg = "empty response: stream ended without emitting anything";
    }
    if (!emitted && attempt < maxAttempts) {
      const why = retryMsg !== "" ? retryMsg : transportErr;
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${why} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }
    if (retryMsg !== "") {
      note(ctx, "error", "", retryMsg);
      die(retryMsg);
    }
    note(ctx, "error", "", `request failed: ${transportErr}`);
    die(`request failed: ${transportErr}`);
  }
}

async function runNonStreamingAnthropic(ctx: Ctx, req: Request, guards: Guards, raw: boolean): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  let httpCode = "000";
  let body = "";
  for (;;) {
    attempt += 1;
    httpCode = "000";
    body = "";
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      const chunks: Uint8Array[] = [];
      if (resp.body) {
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
          a.touch();
          chunks.push(chunk);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
      httpCode = String(resp.status).padStart(3, "0");
    } catch {
      httpCode = "000";
      body = "";
    } finally {
      a.done();
    }

    if (/^(000|408|429|5[0-9][0-9])$/.test(httpCode) && attempt < maxAttempts) {
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): HTTP ${httpCode} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }

    if (httpCode !== "000" && Number(httpCode) < 400) {
      let embedded: string;
      if (/[^ \t\n\v\f\r]/.test(body)) {
        const p = parseJson(body);
        if (!p.ok) die(`API error: response body is not JSON (HTTP ${httpCode})`);
        if (responseShapeErrorAnthropic(p.value)) die(`API error: response shape is not readable (HTTP ${httpCode})`);
        embedded = checkResponseAnthropic(p.value);
      } else {
        embedded = "whitespace-only response body";
      }
      if (embedded !== "") {
        if (attempt < maxAttempts) {
          ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${embedded} — retrying\n`);
          await ctx.io.sleep(ctx.backoff * attempt * 1000);
          continue;
        }
        die(`API error: ${embedded}`);
      }
    }
    break;
  }

  if (Number(httpCode) >= 400 || httpCode === "000") {
    const p = parseJson(body);
    const msg = p.ok ? errorMessageOf(p.value) : "";
    note(ctx, "error", httpCode, msg !== "" ? msg : `HTTP ${httpCode}`);
    if (msg !== "") die(`API error (HTTP ${httpCode}): ${msg}`);
    die(`API error (HTTP ${httpCode})`);
  }
  note(ctx, "ok");

  const p = parseJson(body);
  if (p.ok && isTruncatedAnthropic(p.value)) warnTruncated(ctx);
  if (p.ok) {
    const u = usageAnthropic(p.value);
    if (u.ok) writeUsage(ctx, u.rec);
  }
  ledgerAppend(ctx);

  if (raw) {
    ctx.io.stdout(body);
  } else if (p.ok) {
    if (extractShapeErrorAnthropic(p.value)) die(`API error: response text is not readable (HTTP ${httpCode})`);
    const text = extractTextAnthropic(p.value);
    if (text !== null) ctx.io.stdout(text + "\n");
  }
}

// ---------------------------------------------------------------------------
// Gemini transport. Mirrors runStreaming/runNonStreaming above.
// ---------------------------------------------------------------------------

async function runStreamingGemini(ctx: Ctx, req: Request, guards: Guards): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let emitted = false;
    let transportErr = "";
    let retryMsg = "";
    const gate = makeStopGate(ctx, (chunk) => {
      emitted = true;
      ctx.io.stdout(chunk);
    });
    // Each attempt's handler is a subshell in the Bash: its flags start clean.
    ctx.servedBy = "";
    ctx.truncated = false;
    const handler = createGeminiStreamHandler({
      text: gate.text,
      truncated: () => warnTruncated(ctx),
      usage: (rec) => writeUsage(ctx, rec),
    });
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      if (resp.body) {
        await forEachLine(
          resp.body,
          (line) => {
            handler.line(line);
            return gate.stopped();
          },
          a.touch
        );
      }
    } catch (e) {
      transportErr = errorDetail(e, a);
    } finally {
      a.done();
    }
    if (gate.stopped()) {
      finishStopped(ctx, gate.tracker!);
      return;
    }
    if (!handler.sawData && handler.errBuf !== "") {
      const m = streamErrorMessageOf(handler.errBuf);
      retryMsg = (m !== "" ? `API error: ${m}` : `API error: ${handler.errBuf}`).replace(/\n+$/, "");
    }
    if (retryMsg === "" && transportErr === "") {
      if (emitted) {
        note(ctx, "ok");
        ledgerAppend(ctx);
        return;
      }
      retryMsg = "empty response: stream ended without emitting anything";
    }
    if (!emitted && attempt < maxAttempts) {
      const why = retryMsg !== "" ? retryMsg : transportErr;
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${why} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }
    if (retryMsg !== "") {
      note(ctx, "error", "", retryMsg);
      die(retryMsg);
    }
    note(ctx, "error", "", `request failed: ${transportErr}`);
    die(`request failed: ${transportErr}`);
  }
}

async function runNonStreamingGemini(ctx: Ctx, req: Request, guards: Guards, raw: boolean): Promise<void> {
  const maxAttempts = ctx.retries + 1;
  let attempt = 0;
  let httpCode = "000";
  let body = "";
  for (;;) {
    attempt += 1;
    httpCode = "000";
    body = "";
    const a = startAttempt(guards, req.url);
    try {
      const resp = await ctx.io.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: a.controller.signal,
      });
      a.touch();
      const chunks: Uint8Array[] = [];
      if (resp.body) {
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
          a.touch();
          chunks.push(chunk);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
      httpCode = String(resp.status).padStart(3, "0");
    } catch {
      httpCode = "000";
      body = "";
    } finally {
      a.done();
    }

    if (/^(000|408|429|5[0-9][0-9])$/.test(httpCode) && attempt < maxAttempts) {
      ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): HTTP ${httpCode} — retrying\n`);
      await ctx.io.sleep(ctx.backoff * attempt * 1000);
      continue;
    }

    if (httpCode !== "000" && Number(httpCode) < 400) {
      let embedded: string;
      if (/[^ \t\n\v\f\r]/.test(body)) {
        const p = parseJson(body);
        if (!p.ok) die(`API error: response body is not JSON (HTTP ${httpCode})`);
        if (responseShapeErrorGemini(p.value)) die(`API error: response shape is not readable (HTTP ${httpCode})`);
        embedded = checkResponseGemini(p.value);
      } else {
        embedded = "whitespace-only response body";
      }
      if (embedded !== "") {
        if (attempt < maxAttempts) {
          ctx.io.stderr(`llm: transient API failure (attempt ${attempt}/${maxAttempts}): ${embedded} — retrying\n`);
          await ctx.io.sleep(ctx.backoff * attempt * 1000);
          continue;
        }
        die(`API error: ${embedded}`);
      }
    }
    break;
  }

  if (Number(httpCode) >= 400 || httpCode === "000") {
    const p = parseJson(body);
    const msg = p.ok ? errorMessageOf(p.value) : "";
    note(ctx, "error", httpCode, msg !== "" ? msg : `HTTP ${httpCode}`);
    if (msg !== "") die(`API error (HTTP ${httpCode}): ${msg}`);
    die(`API error (HTTP ${httpCode})`);
  }
  note(ctx, "ok");

  const p = parseJson(body);
  if (p.ok && isTruncatedGemini(p.value)) warnTruncated(ctx);
  if (p.ok) {
    const u = usageGemini(p.value);
    if (u.ok) writeUsage(ctx, u.rec);
  }
  ledgerAppend(ctx);

  if (raw) {
    ctx.io.stdout(body);
  } else if (p.ok) {
    if (extractShapeErrorGemini(p.value)) die(`API error: response text is not readable (HTTP ${httpCode})`);
    const text = extractTextGemini(p.value);
    if (text !== null) ctx.io.stdout(text + "\n");
  }
}

// ---------------------------------------------------------------------------
// Adapter seam (`LLM_PROVIDER=adapter`; design/providers.md). No HTTP request
// at all: the completion is handed to an external executable that carries its
// own dependencies and auth. bin/llm keeps the wall-clock deadline (TERM the
// process GROUP, 5s grace, then KILL), the health marker, and the usage ledger.
// ---------------------------------------------------------------------------

async function runAdapter(ctx: Ctx, adapterPath: string, o: Opts, messages: unknown): Promise<void> {
  const io = ctx.io;
  const tmpRoot = ctx.env["TMPDIR"] || "/tmp";
  // Private 0700 sidecar dir for the system-prompt file (mirrors bin/llm's
  // `mktemp -d` + `umask 077`); removed unconditionally at the end.
  const sidecarDir = path.join(tmpRoot, `llm-adapter.${io.randomToken()}`);
  let systemPromptFile: string | null = null;
  try {
    io.fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort, like the Bash's own tempdir failure would abort loudly — but
       mkdtemp practically never fails; if it does, the write below will and dies. */
  }
  if (o.system !== "") {
    systemPromptFile = path.join(sidecarDir, "system");
    try {
      io.fs.writeFileSync(systemPromptFile, o.system, { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  const args = buildAdapterArgs({
    model: ctx.model,
    maxTokensText: ctx.maxTokensText,
    effort: o.effort,
    thinking: o.thinking,
    thinkingLevel: o.thinkingLevel,
    stream: o.stream,
    systemPromptFile,
  });

  // LLM_USAGE_FILE must be a REAL path the adapter (a separate process) can
  // write to — the in-memory `ctx.usageRec` stand-in the HTTP paths use for a
  // caller-less run does not cross a process boundary.
  const ownUsageFile = ctx.usageFile === null;
  const usageFilePath = ctx.usageFile ?? path.join(sidecarDir, "usage");
  const adapterEnv: Record<string, string | undefined> = { ...ctx.env, LLM_USAGE_FILE: usageFilePath };

  const cleanup = (): void => {
    try {
      io.fs.rmSync(sidecarDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  // PORT-NOTE (sync 2e39a3f, 2a63d92): `mem search` runs llm inside its own cancellable worker process
  // group and sets the private `_LLM_SHARED_PROCESS_GROUP=1` opt-in. Only meaningful (as in bin/llm) with
  // a deadline: the adapter then stays in llm's group instead of leading its own (`set -m` skipped).
  // With NO deadline (LLM_MAX_TIME=0) bin/llm runs the adapter in the foreground of its own group — never regrouped.
  const sharedGroup = ctx.maxTime <= 0 || ctx.env["_LLM_SHARED_PROCESS_GROUP"] === "1";
  let handle: LlmSpawnHandle;
  try {
    handle = io.spawnAdapter(adapterPath, args, { cwd: io.cwd, env: adapterEnv, sharedGroup, deadline: ctx.maxTime > 0 });
  } catch (e) {
    cleanup();
    if (sharedGroup && ctx.maxTime > 0) die(e instanceof Error ? e.message : String(e));
    throw e;
  }
  handle.onStdout((chunk) => io.stdout(chunk));
  handle.onStderr((chunk) => io.stderr(chunk));
  // bash builds LLM_MESSAGES via `jq -Rs '[…]'` (default pretty, 2-space
  // indent) for the constructed-prompt case, then `$(…)` strips its one
  // trailing newline before `printf '%s' > payload_file` — no added newline.
  // Matched exactly here (PORT-NOTE: an explicit `-M` payload keeps the
  // caller's own text verbatim in the Bash; already re-serialized upstream
  // here, so only its JSON *shape* survives — same class as the request-body
  // re-serialization PORT-NOTE at the top of this file).
  handle.writeStdin(jqJson(JSON.stringify(messages, null, 2)));
  handle.endStdin();

  let deadlineFired = false;
  const watcherFinished: Promise<void> =
    ctx.maxTime > 0
      ? (async () => {
          // Poll once per (simulated) second instead of a single long timer,
          // so a fast call never waits out the tick (bin/llm's `while [[ !
          // -e done && t < MAX_TIME ]]; sleep 1`). Ticks are COUNTED, not
          // wall-clock-derived: io.now() may be a frozen test clock while
          // io.sleep() resolves instantly, so elapsed-time math would spin
          // forever there — a tick counter works under either a frozen or a
          // real clock.
          let done = false;
          const stop = handle.wait().then(() => {
            done = true;
          });
          for (let t = 0; !done && t < ctx.maxTime; t++) {
            await Promise.race([io.sleep(1000), stop]);
          }
          if (!done && sharedGroup) {
            // We share the cancellation group, so TERM would kill this very process (the
            // supervisor/watcher) before escalation could run: force the whole group closed at
            // the inner deadline (bin/llm `kill -KILL -- -$_adapter_shared_group; exit 0`).
            deadlineFired = true;
            handle.killGroup("SIGKILL");
          } else if (!done) {
            deadlineFired = true;
            handle.killGroup("SIGTERM");
            // Bash's grace loop (`kill -0 -- -$pid`) polls the PROCESS
            // GROUP's liveness, not the leader's own exit: a leader that
            // TERM-traps into a quick `exit 0` (bin/llm's own `done` file
            // would already say "gone") can leave an orphaned grandchild
            // that ignores TERM still running in the same group — the
            // follow-up SIGKILL below must still reach it. The final KILL
            // is unconditional, like the Bash's trailing `kill -9` (a no-op,
            // ESRCH, once truly nothing remains).
            for (let g = 0; g < 5 && handle.groupAlive(); g++) {
              await io.sleep(1000);
            }
            handle.killGroup("SIGKILL");
          }
        })()
      : Promise.resolve();

  const { code } = await handle.wait();
  await watcherFinished;

  if (deadlineFired) {
    const msg = `adapter killed after ${ctx.maxTime}s (LLM_MAX_TIME deadline)`;
    note(ctx, "error", "", msg);
    cleanup();
    die(`Adapter failed (${msg}): ${adapterPath}`);
  }
  if (code === 0) {
    note(ctx, "ok");
    if (ownUsageFile) {
      // ledgerAppend reads ctx.usageFile when set; point it at the real
      // tempfile the adapter wrote to, then restore (both paths are torn
      // down by `cleanup` either way).
      ctx.usageFile = usageFilePath;
      ledgerAppend(ctx);
      ctx.usageFile = null;
    } else {
      ledgerAppend(ctx);
    }
    cleanup();
    return;
  }
  const msg = `adapter exited ${code ?? "null"}`;
  note(ctx, "error", "", msg);
  cleanup();
  die(`Adapter failed (${msg}): ${adapterPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[], io: LlmIO): Promise<number> {
  const env: Record<string, string | undefined> = { ...io.env };
  loadEnvFile(io, env, path.resolve(io.cwd, ".env"));
  // State home: HEADLONG_HOME, else SHELLM_HOME, else ~/.headlong (after the
  // cwd .env, which may itself set HEADLONG_HOME). PORT-NOTE: an unset HOME
  // yields `/.headlong` here; the Bash dies `HOME: unbound variable` (set -u).
  const home = env["HEADLONG_HOME"] || env["SHELLM_HOME"] || `${env["HOME"] ?? ""}/.headlong`;
  loadEnvFile(io, env, path.join(home, ".env"));

  // LLM_SYSTEM/MESSAGES/STREAM/THINKING/EFFORT/RAW are reset unconditionally;
  // parseArgs seeds only model/max-tokens/provider from the environment.
  const providerEnv = env["LLM_PROVIDER"] ?? "";
  // Whether any --or-*/LLM_OR_* knob arrived from the environment or a .env
  // layer (snapshotted BEFORE flag parsing, like bin/llm's `_llm_or_env`) —
  // decides whether the effective routing gets announced on stderr below.
  const orEnvSnapshot = (env["LLM_OR_ONLY"] ?? "") + (env["LLM_OR_DATA_COLLECTION"] ?? "") + (env["LLM_OR_ZDR"] ?? "");
  const o = parseArgs(argv, io, env);

  if (o.prompt === "" && o.messages === "" && !io.stdinIsTTY) {
    // `$(cat)`: trailing newlines stripped. PORT-NOTE: NUL bytes are kept
    // (bash drops them with `ignored null byte in input`).
    o.prompt = io.readStdin().replace(/\n+$/, "");
  }
  if (o.prompt === "" && o.messages === "") die("No prompt or messages provided");

  // Default model: SHELLM_MODEL, else the first provider with a key.
  let model = o.model;
  if (model === "") {
    if (env["SHELLM_MODEL"]) model = env["SHELLM_MODEL"];
    else if (env["ANTHROPIC_API_KEY"]) model = "claude-sonnet-4-5-20250929";
    else if (env["OPENAI_API_KEY"]) model = "gpt-5.5";
    else if (env["GEMINI_API_KEY"]) model = "gemini-3.5-flash";
    else if (env["OPENROUTER_API_KEY"]) model = "anthropic/claude-sonnet-4.5";
    else if (env["OPENCODE_API_KEY"]) model = "opencode-go/deepseek-v4-flash";
    else
      die(
        "No model specified and no API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENCODE_API_KEY, or pass -m MODEL."
      );
  }

  // Provider: --provider > LLM_PROVIDER > detection (dies on an unclassifiable name).
  let provider = o.provider;
  if (provider === "") {
    const d = detectProvider(model);
    if (d === null) die(`Cannot detect provider for model '${model}'. Use --provider.`);
    provider = d;
  }
  // An environment-supplied provider that disagrees with a classifiable name
  // is honored, but never silently.
  if (providerEnv !== "" && provider === providerEnv) {
    const d = detectProvider(model);
    if (d !== null && d !== provider) {
      io.stderr(`llm: warning: LLM_PROVIDER=${provider} overrides detected provider '${d}' for model '${model}'\n`);
    }
  }
  const apiUrlEnv = env["LLM_API_URL"] ?? "";
  if (apiUrlEnv !== "" && provider !== "openai-compatible" && provider !== "adapter") {
    io.stderr(
      `llm: warning: LLM_API_URL overrides the default ${provider} endpoint (requests go to ${hostOf(apiUrlEnv)})\n`
    );
  }
  // OpenCode routing prefixes hide the real catalog id; strip once, up front.
  if (provider === "opencode" && model.startsWith("opencode/")) model = model.slice("opencode/".length);
  if (provider === "opencode-go" && model.startsWith("opencode-go/")) model = model.slice("opencode-go/".length);

  // The --or-*/LLM_OR_* knobs (015d081) are OpenRouter routing controls and
  // mean nothing to the other providers, which are each a single host
  // already. Clear them out loud rather than silently: a stray LLM_OR_ZDR
  // in a shell profile must not quietly read as a residency guarantee on an
  // Anthropic call, and must not kill it either.
  let orOnly = o.orOnly;
  let orDataCollection = o.orDataCollection;
  let orZdr = false;
  if (provider !== "openrouter") {
    if (o.orOnly !== "" || o.orDataCollection !== "" || o.orZdr !== "") {
      io.stderr(`llm: warning: --or-*/LLM_OR_* are OpenRouter-only and ignored for provider '${provider}'\n`);
    }
    orOnly = "";
    orDataCollection = "";
  } else {
    // Normalise once, here, rather than at each use. A settings file saying
    // LLM_OR_ZDR=true that read as false further down would drop a
    // retention requirement silently, which is the one failure mode these
    // knobs exist to prevent.
    switch (o.orZdr.toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
        orZdr = true;
        break;
      case "0":
      case "false":
      case "no":
      case "":
        orZdr = false;
        break;
      default:
        die(`--or-zdr/LLM_OR_ZDR must be 1/true/yes/on or 0/false/no/empty (got '${o.orZdr}')`);
    }
    if (orDataCollection !== "" && orDataCollection !== "allow" && orDataCollection !== "deny") {
      die(`--or-data-collection/LLM_OR_DATA_COLLECTION must be allow or deny (got '${orDataCollection}')`);
    }
    if (orOnly !== "") {
      // OpenRouter matches slugs exactly, and case, padding and empty
      // elements all come out of real .env files and shell profiles.
      orOnly = orOnly
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/,+/g, ",")
        .replace(/^,/, "")
        .replace(/,$/, "");
      // A pin that normalises away is a typo, and treating it as "no pin"
      // would route anywhere — the opposite of what was asked for.
      if (orOnly === "") die("--or-only/LLM_OR_ONLY had no provider slugs left after normalization");
    }
    if (orEnvSnapshot !== "" && (orOnly !== "" || orDataCollection !== "" || orZdr)) {
      io.stderr(
        `llm: routing: openrouter${orOnly ? ` only=${orOnly}` : ""}${
          orDataCollection ? ` data_collection=${orDataCollection}` : ""
        }${orZdr ? " zdr=true" : ""}\n`
      );
    }
  }

  let maxTokens: number;
  if (isNum(o.maxTokens)) maxTokens = Number(o.maxTokens);
  else {
    if (o.maxTokens !== "") io.stderr(`llm: warning: ignoring non-numeric LLM_MAX_TOKENS='${o.maxTokens}'\n`);
    maxTokens = getModelMaxTokens(model, provider);
  }
  const maxTokensText = isNum(o.maxTokens) ? o.maxTokens : String(maxTokens);

  // PORT-NOTE (bug #57): bash (`bin/llm:1242-1243`) checks LLM_ADAPTER's
  // existence/executability at dispatch time, BEFORE it ever looks at
  // LLM_MESSAGES — for `--provider adapter` it never JSON-validates `-M` at
  // all (the payload is written verbatim). This gate used to run AFTER the
  // `-M` JSON-parse check below, so a bad adapter path with a malformed `-M`
  // died with "--messages is not valid JSON" instead of naming the real
  // problem. Moved ahead of the messages gate so the adapter path fails the
  // same way bash does, in the same order.
  let adapterPath = "";
  if (provider === "adapter") {
    const adapter = env["LLM_ADAPTER"] ?? "";
    if (adapter === "")
      die("LLM_ADAPTER is not set (LLM_PROVIDER=adapter runs the executable at that path; see design/providers.md)");
    let executable = false;
    try {
      io.fs.accessSync(path.resolve(io.cwd, adapter), 1 /* X_OK */);
      executable = io.fs.statSync(path.resolve(io.cwd, adapter)).isFile();
    } catch {
      /* not executable */
    }
    if (!executable) die(`LLM_ADAPTER is not executable: ${adapter}`);
    adapterPath = adapter;
  }

  // Messages: `-M` verbatim (parsed, not validated), else the prompt as one user turn.
  let messages: unknown;
  if (o.messages === "") messages = [{ role: "user", content: o.prompt }];
  else {
    const p = parseJson(o.messages);
    if (!p.ok) die("--messages is not valid JSON"); // PORT-NOTE: Bash relays jq's parse error, exit 5
    messages = p.value;
  }

  // Usage / ledger plumbing.
  const usageFileEnv = env["LLM_USAGE_FILE"] ?? "";
  const identityDir = env["IDENTITY_DIR"] ?? "";
  let ledger = env["LLM_USAGE_LEDGER"] ?? "";
  if (ledger === "") ledger = identityDir !== "" ? path.join(identityDir, "usage", "llm.jsonl") : path.join(home, "usage", "llm.jsonl");
  let identity = env["IDENTITY_NAME"] ?? "";
  if (identity === "" && identityDir !== "") identity = path.basename(identityDir);
  // PORT-NOTE: `^[0-9]+$` gates retries as in the Bash, but `08` is then 8
  // here where bash arithmetic rejects it as octal; a backoff that is not a
  // plain integer (`1.5`, `abc`) parses leniently where the Bash crashes in
  // `sleep $(( … ))` at the first retry. Documented in PARITY.md.
  const retriesEnv = env["LLM_RETRIES"] === undefined || env["LLM_RETRIES"] === "" ? "2" : env["LLM_RETRIES"];
  const backoffEnv = env["LLM_RETRY_BACKOFF"] === undefined || env["LLM_RETRY_BACKOFF"] === "" ? "1" : env["LLM_RETRY_BACKOFF"];
  const backoffN = Number.parseInt(backoffEnv, 10);
  const ctx: Ctx = {
    io,
    env,
    home,
    provider,
    model,
    maxTokens,
    maxTokensText,
    usageFile: usageFileEnv !== "" ? path.resolve(io.cwd, usageFileEnv) : null,
    usageRec: null,
    servedBy: "",
    truncated: false,
    ledger: path.resolve(io.cwd, ledger),
    identity,
    runId: env["LLM_RUN_ID"] || env["SHELLM_RUN_STEP_ID"] || "",
    retries: isNum(retriesEnv) ? Number(retriesEnv) : 0,
    backoff: Number.isFinite(backoffN) ? backoffN : 0,
    maxTime: positiveKnob(env, "LLM_MAX_TIME", 600),
    speedLimit: positiveKnob(env, "LLM_SPEED_LIMIT", 100),
    speedTime: positiveKnob(env, "LLM_SPEED_TIME", 60),
    connectTimeout: positiveKnob(env, "LLM_CONNECT_TIMEOUT", 10),
    stopAfterCodeBlock: o.stopAfterCodeBlock,
  };

  // --- adapter seam: exec (design/providers.md). Pre-flight (LLM_ADAPTER
  // existence/executability, bug #57) already ran above, before the
  // messages gate.
  if (provider === "adapter") {
    // bash execs "$LLM_ADAPTER" verbatim (relative to the shell's cwd) and
    // reports failures with that same raw text, never a resolved absolute
    // path — matched here (the pre-flight check above already resolved it).
    await runAdapter(ctx, adapterPath, o, messages);
    return 0;
  }

  // --- payload (a typo'd provider dies here, naming the problem).
  const assumeThinking = env["LLM_ASSUME_THINKING"] === "1";
  let built;
  try {
    if (provider === "anthropic" || provider === "opencode") {
      const keyVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENCODE_API_KEY";
      if (!env[keyVar]) die(`${keyVar} is not set`);
      const opts = {
        model,
        messages,
        system: o.system,
        stream: o.stream,
        maxTokens,
        thinking: o.thinking,
        effort: o.effort,
        assumeThinking,
        jsonSchemaGiven: o.jsonSchema !== "",
      };
      built = provider === "opencode" ? buildOpencodeZenPayload(opts) : buildAnthropicPayload(opts);
    } else if (provider === "gemini") {
      if (!env["GEMINI_API_KEY"]) die("GEMINI_API_KEY is not set");
      built = buildGeminiPayload({
        model,
        messages,
        system: o.system,
        maxTokens,
        thinkingLevel: o.thinkingLevel,
        assumeThinking,
        jsonSchemaGiven: o.jsonSchema !== "",
      });
    } else {
      if (!OPENAI_FAMILY.includes(provider)) die(`Unknown provider: ${provider} (see --provider in --help for the list)`);
      built = buildOpenAIPayload({
        model,
        messages,
        system: o.system,
        stream: o.stream,
        maxTokens,
        thinkingLevel: o.thinkingLevel,
        assumeThinking,
        ...(o.jsonSchema !== "" ? { jsonSchema: parseSchema(o.jsonSchema) } : {}),
      });
      // OpenRouter's routing block (015d081): unpinned callers pay nothing —
      // no extra pass, byte-identical to before. Never sent for any other
      // OPENAI_FAMILY member (the knobs were already cleared above).
      if (provider === "openrouter") {
        const routingBlock = buildOpenRouterProviderBlock({ only: orOnly, dataCollection: orDataCollection, zdr: orZdr });
        if (routingBlock) built = { payload: { ...built.payload, provider: routingBlock }, notes: built.notes };
      }
    }
  } catch (e) {
    if (e instanceof PayloadError) die(e.message);
    throw e;
  }
  for (const n of built.notes) io.stderr(n + "\n");

  // --- URL and headers (get_url_headers). Keys travel only in the request.
  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "openai") {
    if (!env["OPENAI_API_KEY"]) die("OPENAI_API_KEY is not set");
    url = apiUrlEnv || "https://api.openai.com/v1/chat/completions";
    headers["Authorization"] = `Bearer ${env["OPENAI_API_KEY"]}`;
  } else if (provider === "openrouter") {
    if (!env["OPENROUTER_API_KEY"]) die("OPENROUTER_API_KEY is not set");
    url = apiUrlEnv || "https://openrouter.ai/api/v1/chat/completions";
    headers["Authorization"] = `Bearer ${env["OPENROUTER_API_KEY"]}`;
  } else if (provider === "opencode-go") {
    if (!env["OPENCODE_API_KEY"]) die("OPENCODE_API_KEY is not set");
    url = apiUrlEnv || "https://opencode.ai/zen/go/v1/chat/completions";
    headers["Authorization"] = `Bearer ${env["OPENCODE_API_KEY"]}`;
  } else if (provider === "anthropic") {
    url = apiUrlEnv || "https://api.anthropic.com/v1/messages";
    headers["content-type"] = "application/json";
    delete headers["Content-Type"];
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = env["ANTHROPIC_API_KEY"]!;
  } else if (provider === "opencode") {
    url = apiUrlEnv || "https://opencode.ai/zen/v1/messages";
    headers["content-type"] = "application/json";
    delete headers["Content-Type"];
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = env["OPENCODE_API_KEY"]!;
  } else if (provider === "gemini") {
    const action = o.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    url = apiUrlEnv || `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}`;
    headers["x-goog-api-key"] = env["GEMINI_API_KEY"]!;
  } else {
    // openai-compatible: no default endpoint, key optional.
    url = apiUrlEnv || env["SHELLM_API_URL"] || "";
    if (url === "")
      die(
        "LLM_API_URL is not set (openai-compatible has no default endpoint; e.g. http://localhost:11434/v1/chat/completions for Ollama)"
      );
    if (env["LLM_API_KEY"]) headers["Authorization"] = `Bearer ${env["LLM_API_KEY"]}`;
  }

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = `http://${url}`;
  // curl accepts `user:pass@host` URLs and turns the userinfo into Basic auth
  // (a custom Authorization header wins over it); fetch refuses such URLs, so
  // strip the userinfo and reproduce curl's behaviour.
  try {
    const u = new URL(url);
    if (u.username !== "" || u.password !== "") {
      if (headers["Authorization"] === undefined) {
        const cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
        headers["Authorization"] = `Basic ${Buffer.from(cred, "utf8").toString("base64")}`;
      }
      u.username = "";
      u.password = "";
      url = u.toString();
    }
  } catch {
    /* an unparseable URL fails in fetch, like curl would */
  }

  for (const k of Object.keys(headers)) headers[k] = Buffer.from(headers[k]!, "utf8").toString("latin1");
  const req: Request = { url, headers, body: jqJson(JSON.stringify(built.payload)) };
  const guards: Guards = { maxTime: ctx.maxTime, speedLimit: ctx.speedLimit, speedTime: ctx.speedTime, connectTimeout: ctx.connectTimeout };
  if (provider === "anthropic" || provider === "opencode") {
    if (o.stream) await runStreamingAnthropic(ctx, req, guards);
    else await runNonStreamingAnthropic(ctx, req, guards, o.raw);
  } else if (provider === "gemini") {
    if (o.stream) await runStreamingGemini(ctx, req, guards);
    else await runNonStreamingGemini(ctx, req, guards, o.raw);
  } else {
    if (o.stream) await runStreaming(ctx, req, guards);
    else await runNonStreaming(ctx, req, guards, o.raw);
  }
  return 0;
}

/** Entry point: exit code. Never throws for a contract failure (`llm: error: …`, exit 1). */
export async function runLlm(argv: string[], io: LlmIO): Promise<number> {
  try {
    return await main(argv, io);
  } catch (e) {
    if (e instanceof LlmExit) {
      if (e.dieMsg !== undefined) io.stderr(`llm: error: ${e.dieMsg}\n`);
      return e.code;
    }
    const msg = e instanceof Error ? e.message : String(e);
    io.stderr(`llm: error: ${msg}\n`);
    return 1;
  }
}
