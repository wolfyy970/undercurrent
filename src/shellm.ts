// shellm.ts — one wake = one shellm agentic run (SPEC §1.3, the main loop).
//
// Behaviour is the blueprint, not the Bash text: the jq/traj plumbing becomes
// typed struct appends, the FIFO/tail machinery is gone, but the LOOP SHAPE and
// the trajectory STEP SCHEMA are exact:
//   shellm-run(header) → prompt → [ (obs/thought written by the turn's bash) →
//   reasoning → shell-output ]* → final
//
// Trace-VERIFIED ordering (trace-00 rows 12-57): a step the model's bash appends
// via the `traj` shim lands in the file DURING execution, i.e. BEFORE this turn's
// reasoning+shell-output (which shellm appends AFTER the block returns). We keep
// that order by running the sandbox first, then appending reasoning+shell-output.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Trajectory } from "./trajectory.ts";
import type { LlmClient, ChatMessage } from "./llm.ts";
import type { Sandbox } from "./sandbox.ts";
import type { EnvSpec } from "./types.ts";
import { extractReasoning, extractCode, applyStopAfterCodeBlock } from "./extract.ts";
import { buildContext, MONOLITH_CONTEXT_OPTS } from "./context.ts";

/**
 * Operator-visible IO for one wake (bin/shellm's `progress`/`progress_dim`,
 * bin/thinkers' `_dispatch_step` capturing a step's stdout+stderr into
 * run/logs/<name>.log). Defaults to the real process streams so a step
 * spawned by the daemon (src/daemon.ts spawnStep pipes stdout+stderr to the
 * log file) gets the log populated for free; tests inject a capturing WakeIO
 * to assert the exact lines instead of touching the real fd.
 */
export interface WakeIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const REAL_WAKE_IO: WakeIO = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
};

const ESC = "\x1b";

/** bin/shellm:200-201 `progress`/`progress_dim` — exact ANSI shapes, always
 *  through WakeIO.stderr (upstream: `[[ "$QUIET" -eq 1 ]] && return; echo -e ... >&2`).
 *  bin/shellm:2391 etc.'s bare `echo >&2` between sections is `blank()`. */
export interface ProgressSink {
  progress: (msg: string) => void;
  progressDim: (msg: string) => void;
  blank: () => void;
}

export function makeProgress(io: WakeIO): ProgressSink {
  return {
    progress: (msg) => io.stderr(`${ESC}[1;34m▶ ${msg}${ESC}[0m\n`),
    progressDim: (msg) => io.stderr(`${ESC}[90m  ${msg}${ESC}[0m\n`),
    blank: () => io.stderr("\n"),
  };
}

/** bin/shellm redact_sensitive — value-based masking of the provider API keys
 *  (any non-empty length), then of the other credential variables the
 *  environment may carry (≥ 8 characters, so a short placeholder in ordinary
 *  prose is left alone), then a shape pass for credentials that arrived as
 *  text and so have no variable to match against.
 *
 *  PORT-NOTE (sync 2e39a3f, 28cb2b2): upstream widened this from "the six API
 *  keys + sk-ant-" to every credential shape it knows. The sk-ant- rule stays
 *  first and keeps its own marker (tests/test_redact_sensitive.sh asserts on
 *  that exact string). parity/extract/run-parity.mjs runs upstream's real
 *  redact_sensitive against this on a corpus. */
const REDACT_KEYS = [
  ["ANTHROPIC_API_KEY", "<redacted-anthropic-key>"],
  ["LLM_API_KEY", "<redacted-api-key>"],
  ["OPENAI_API_KEY", "<redacted-api-key>"],
  ["OPENROUTER_API_KEY", "<redacted-api-key>"],
  ["GEMINI_API_KEY", "<redacted-api-key>"],
  ["OPENCODE_API_KEY", "<redacted-api-key>"],
] as const;

const REDACT_VALUE_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT",
  "GOOGLE_API_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN",
  "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID",
  "STRIPE_SECRET_KEY", "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN",
  "DATABASE_URL", "REDIS_URL",
] as const;

type ShapeRule = readonly [RegExp, string];
// `(^|[^A-Za-z0-9])` boundaries are per-line in sed; the `m` flag gives `^` the
// same meaning here.
const SHAPES_BEFORE_PEM: readonly ShapeRule[] = [
  [/sk-ant-[A-Za-z0-9._-]+/g, "<redacted-anthropic-key>"],
  [/(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_.=-]{12,})/gm, "$1<redacted:api-key>"],
  [/(^|[^A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{12,})/gm, "$1<redacted:github-token>"],
  [/(^|[^A-Za-z0-9])(github_pat_[A-Za-z0-9_]{12,})/gm, "$1<redacted:github-token>"],
  [/(^|[^A-Za-z0-9])(xox[a-z]-[A-Za-z0-9_.-]{8,})/gm, "$1<redacted:slack-token>"],
  [/(^|[^A-Za-z0-9])(hf_[A-Za-z0-9]{12,})/gm, "$1<redacted:hf-token>"],
  [/AIza[A-Za-z0-9_-]{25,}/g, "<redacted:google-key>"],
  [/(AKIA|ASIA)[A-Z0-9]{16}/g, "<redacted:aws-key>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted:jwt>"],
  [/:\/\/[^/@ \t\n\r\f\v]+:[^/@ \t\n\r\f\v]+@/g, "://<redacted:basic-auth>@"],
];
const SHAPES_AFTER_PEM: readonly ShapeRule[] = [
  [/"auth"[ \t\r\f\v]*:[ \t\r\f\v]*"[A-Za-z0-9+/=]{16,}"/g, '"auth": "<redacted:docker-auth>"'],
  [/(^|[^A-Za-z0-9])((sk|rk)_live_[A-Za-z0-9]{8,})/gm, "$1<redacted:stripe-key>"],
  [/(^|[^A-Za-z0-9])(whsec_[A-Za-z0-9]{8,})/gm, "$1<redacted:stripe-hook>"],
  [/(^|[^A-Za-z0-9])(npm_[A-Za-z0-9]{20,})/gm, "$1<redacted:npm-token>"],
  [/(^|[^A-Za-z0-9])(glpat-[A-Za-z0-9_-]{10,})/gm, "$1<redacted:gitlab-token>"],
  [/(^|[^A-Za-z0-9])(dckr_pat-[A-Za-z0-9_.-]{10,})/gm, "$1<redacted:docker-token>"],
  [/(^|[^A-Za-z0-9])(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gm, "$1<redacted:sendgrid-key>"],
  [/(^|[^A-Za-z0-9])(SK[0-9a-f]{32})/gm, "$1<redacted:twilio-key>"],
  [/(^|[^A-Za-z0-9])(key-[A-Za-z0-9]{20,})/gm, "$1<redacted:mailgun-key>"],
  [/((aws|AWS)_secret_access_key)[ \t\r\f\v]*[=:][ \t\r\f\v]*[^ \t\n\r\f\v]+/g, "$1=<redacted:aws-secret>"],
];

/** sed's `/BEGIN … PRIVATE KEY/,/END … PRIVATE KEY/c\<redacted:private-key>`:
 *  whole LINES, from the first line holding a BEGIN delimiter through the
 *  first later line holding an END delimiter, become one marker line. */
function redactPemRange(text: string): string {
  const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
  const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
  const out: string[] = [];
  let inRange = false;
  for (const line of text.split("\n")) {
    if (inRange) {
      if (end.test(line)) {
        inRange = false;
        out.push("<redacted:private-key>");
      }
      continue;
    }
    if (begin.test(line)) {
      // sed checks the range's END address only on LINES AFTER the one that
      // opened it, so a one-line BEGIN…END block still opens a range.
      inRange = true;
      continue;
    }
    out.push(line);
  }
  // An unterminated block: the marker is still written (fail closed) — the
  // delimiter-bearing lines are never echoed.
  if (inRange) out.push("<redacted:private-key>");
  return out.join("\n");
}

export function redactSensitive(input: string, env: Record<string, string | undefined>): string {
  let out = input;
  for (const [key, mask] of REDACT_KEYS) {
    const v = env[key];
    if (v) out = out.split(v).join(mask);
  }
  for (const key of REDACT_VALUE_VARS) {
    const v = env[key];
    if (v && v.length >= 8) out = out.split(v).join("<redacted:value>");
  }
  for (const [re, rep] of SHAPES_BEFORE_PEM) out = out.replace(re, rep);
  out = redactPemRange(out);
  for (const [re, rep] of SHAPES_AFTER_PEM) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// PORT-NOTE (1c: callout (c), PR #103 "sensitive-config-forwarding") — the
// shellm↔thinker env/argv contract for private configuration. `src/shellm.ts`
// had NO equivalent of any of this before: this is new pure logic ported from
// scratch, not a diff against existing code. It is NOT yet wired into a
// caller in this port: `runShellm` is called as an in-process function
// (monolith.ts), not a standalone CLI that parses argv/loads .env files or
// prints a recorded command line, so there is no real call site for
// `resolveShellmApiUrl`'s .env-precedence question or `redactedCmdline`'s
// synthetic-argv reconstruction today (monolith.ts's own `synthCommand`,
// Lane B territory, is the closest analogue and does not carry secret
// VALUES on its `--var` flags to begin with). Ported and tested exactly per
// upstream so a future caller (a standalone shellm CLI, or a lane-B command-
// line builder) has a byte-faithful function to call rather than inventing
// its own. See PARITY.md.
// ---------------------------------------------------------------------------

/**
 * `_shellm_private_var_name` (bin/shellm, a4b5db8's final regex): true when
 * NAME looks like a credential (KEY/TOKEN/SECRET/PASSWORD/PASSWD/
 * PASSPHRASE/CREDENTIAL[S], unanchored substring) OR an endpoint (URL/URI/
 * ENDPOINT/DSN, anchored at a `_`-boundary or the string's own start/end) —
 * case-insensitive. `--var NAME=VALUE` values whose NAME matches are masked
 * in the recorded shellm command line.
 */
export function shellmPrivateVarName(name: string): boolean {
  const u = name.toUpperCase();
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)/.test(u) || /(^|_)(URL|URI|ENDPOINT|DSN)(_|$)/.test(u);
}

/**
 * `_redacted_cmdline` (bin/shellm): the command line as recorded in the
 * shellm-run trajectory row — `shellm` plus every arg, space-joined with NO
 * shell-quoting (bash: `out+=" $a"`, not `printf '%q'`), except that a
 * `--var NAME=VALUE` arg whose NAME is `shellmPrivateVarName` becomes
 * `NAME=<redacted>`. A bare `--var NAME` (no `=`) is never touched — passing
 * private configuration that way already keeps the VALUE off argv entirely.
 */
export function redactedCmdline(argv: string[]): string {
  let out = "shellm";
  let prev = "";
  for (let a of argv) {
    if (prev === "--var" && a.includes("=")) {
      const n = a.slice(0, a.indexOf("="));
      if (shellmPrivateVarName(n)) a = `${n}=<redacted>`;
    }
    out += ` ${a}`;
    prev = a;
  }
  return out;
}

export interface ShellmApiUrlEnv {
  /** SHELLM_API_URL as it stood on process entry, before any `.env` file was
   *  loaded — `undefined` means UNSET; `""` means set but empty (bash's own
   *  `${SHELLM_API_URL+x}` test counts a set-but-empty var as "set"). */
  processShellmApiUrl?: string;
  processLlmApiUrl?: string;
  /** SHELLM_API_URL / LLM_API_URL after `.env`-file loading has filled in
   *  whichever of the two were UNSET at process entry (bash's
   *  `_shellm_load_env`: a file value only fills a currently-unset var). */
  loadedShellmApiUrl?: string;
  loadedLlmApiUrl?: string;
}

/**
 * Endpoint-alias precedence (bin/shellm, a4b5db8 "preserve endpoint
 * precedence"): SHELLM_API_URL and LLM_API_URL are aliases for the same
 * setting. A process-level value (however it got there — the real
 * environment, or a parent shellm run) must beat EITHER name subsequently
 * loaded from a `.env` file, and the two aliases must be preferred
 * consistently: SHELLM_API_URL first, then LLM_API_URL, whichever was set at
 * the process level — never a file value clobbering a process value under
 * the other name. Only once NEITHER was set at the process level does the
 * classic `${SHELLM_API_URL:-${LLM_API_URL:-}}` fallback (now reading the
 * post-file-load values) apply.
 */
export function resolveShellmApiUrl(env: ShellmApiUrlEnv): string {
  if (env.processShellmApiUrl !== undefined) return env.processShellmApiUrl;
  if (env.processLlmApiUrl !== undefined) return env.processLlmApiUrl;
  return env.loadedShellmApiUrl || env.loadedLlmApiUrl || "";
}

/**
 * bin/shellm:1979-2006 `_stream_new_output` — reproduced as a single post-hoc
 * pass over the finished exec's combined output instead of a live poll during
 * execution (PARITY.md: this port's Sandbox.exec() returns output only once
 * the command has finished, so incremental streaming during a long-running
 * command isn't reproducible; the LINES/ORDER/CONTENT are identical, only the
 * wall-clock granularity of when they hit stderr differs). A `+ `-prefixed
 * xtrace line (from the `set -x` wrapper) renders cyan as the command with
 * its `+ ` stripped; anything else is real command output, rendered dim with
 * a `│ ` marker.
 */
export function printExecOutputLines(io: WakeIO, rawOutput: string, env: Record<string, string | undefined>): void {
  if (rawOutput === "") return;
  const lines = rawOutput.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing `\n` — no bogus empty final line
  for (const line of lines) {
    const redacted = redactSensitive(line, env);
    if (redacted.startsWith("+")) {
      const display = redacted.startsWith("+ ") ? redacted.slice(2) : redacted;
      io.stderr(`${ESC}[36m  $ ${display}${ESC}[0m\n`);
    } else {
      io.stderr(`${ESC}[90m  │ ${redacted}${ESC}[0m\n`);
    }
  }
}

export interface ShellmConstants {
  maxIterations: number | null; // bin/shellm:63 — empty(=null) means unlimited
  maxConsecutiveFailures: number; // default 10
  maxRepeatFailures: number; // default 3
  truncate: number; // default 2000 (in-context, informational for the slice)
  inactivityMaxMs: number; // SHELLM_INACTIVITY_MAX — hard ceiling; default 900_000
  inactivityTimeoutMs: number; // SHELLM_INACTIVITY_TIMEOUT — idle kill; default 30_000
  /** PORT-NOTE (sync 2e39a3f, eb40093) SHELLM_MAX_OUTPUT_SIZE — bytes of output
   *  after which a block is killed even while it is still producing output;
   *  default 10485760 (10 MB), 0 disables. */
  maxOutputBytes: number;
  /** PORT-NOTE (sync 2e39a3f, bfb43f7) SHELLM_MAX_EXEC_TIME — ms a block may
   *  run however it behaves; default 3_600_000 (env is in SECONDS), 0 disables. */
  maxExecMs: number;
  /** Empty-response retries before the wake dies (upstream 136f32b,
   *  bin/shellm:2429 `${SHELLM_EMPTY_RESPONSE_RETRIES-8}` — note the bare
   *  `-`, not `:-`: default 8 ONLY when the var is unset; explicitly set to
   *  "" it stays "" (unlimited, null here), unlike every other knob above. */
  emptyResponseRetries: number | null;
  /** PORT-NOTE (1c: 2d1c1c3) SHELLM_STOP_AFTER_CODE_BLOCK — default true: the
   *  loop runs only the first fenced block of a response and drops the rest,
   *  so `llm --stop-after-code-block` may cut the stream the moment that
   *  block closes; a model that keeps writing after its command (or loops
   *  that way until the transfer times out) then costs nothing past the
   *  block. false reads every response to the end, as before. */
  stopAfterCodeBlock: boolean;
  /** PORT-NOTE (1c: 7a35982) SHELLM_CONTEXT_SCOPE — "traj" (default): the
   *  trajectory's head+tail window, so --resume continues the earlier
   *  conversation. "run": only this run's own steps render (prompt pinned
   *  whole) — for a caller whose prompt already carries the history it
   *  wants (the monolith). */
  contextScope: "traj" | "run";
  /** PORT-NOTE (1c: d43ae81) SHELLM_CONTEXT_RUN_TAIL — run-scope window rows
   *  read back (default 400, ~200 iterations at 2 rows/iteration) so a
   *  normal run never slides the cached prefix. */
  contextRunTail: number;
  /** PORT-NOTE (1c: d43ae81) SHELLM_CONTEXT_RUN_TAIL_BLOCK — rows the
   *  run-scope window's start moves in (default 50), so the cached prefix
   *  survives between moves instead of sliding on every call. */
  contextRunTailBlock: number;
  /** PORT-NOTE (1c: 0f8b49e) SHELLM_CONTEXT_BLOCK_LIMIT — bytes a field may
   *  fill before it is cut, for rows in the newest window-block (default
   *  8192); older rows keep SHELLM_STDOUT_PROMPT_LIMIT (2048, via
   *  context.ts's own default). */
  contextBlockLimit: number;
  /** PORT-NOTE (1c: 0f8b49e) SHELLM_CONTEXT_WHOLE_BLOCKS — how many newest
   *  window-blocks get contextBlockLimit (default 1; in traj scope, the
   *  newest N rows). */
  contextWholeBlocks: number;
}

export const DEFAULT_CONSTANTS: ShellmConstants = {
  maxIterations: null,
  maxConsecutiveFailures: 10,
  maxRepeatFailures: 3,
  truncate: 2000,
  inactivityMaxMs: 900_000,
  inactivityTimeoutMs: 30_000,
  maxOutputBytes: 10_485_760,
  maxExecMs: 3_600_000,
  emptyResponseRetries: 8,
  stopAfterCodeBlock: true,
  contextScope: "traj",
  contextRunTail: 400,
  contextRunTailBlock: 50,
  contextBlockLimit: 8192,
  contextWholeBlocks: 1,
};

// PORT-NOTE (bin/shellm:63,70-72,88-89): every daemon-driven wake used to run
// this loop with DEFAULT_CONSTANTS only — the env knobs upstream reads once at
// CLI startup were never consulted, so e.g. SHELLM_MAX_ITERATIONS=4 in the
// daemon's environment had no effect (a wake could run 10+ iterations).
// constantsFromEnv closes that gap: it is the pure `${VAR:-default}` parse
// upstream does at startup, callable from any entrypoint that builds a
// ShellmConstants for runShellm.
//
// Empty/unset means "use the default" for every knob EXCEPT
// SHELLM_MAX_ITERATIONS, where empty/unset means unlimited (bin/shellm:63,
// 2252 — `[[ -z "$SHELLM_MAX_ITERATIONS" || ... ]]`); that is why maxIterations
// alone maps "" to null instead of a numeric default.
//
// Non-numeric values are NOT special-cased. Upstream's loop guard is
// `[[ "$iteration" -lt "$SHELLM_MAX_ITERATIONS" ]]`: bash's `-lt` on a
// non-numeric string prints "integer expression expected" to stderr and the
// test evaluates false, so the loop body never runs (0 iterations). `Number()`
// on a non-numeric string yields NaN, and `iteration < NaN` (or `>=`, `>`) is
// false for every value of `iteration` in JS too — so leaving the parsed value
// as NaN and letting the existing numeric comparisons in runShellm() do their
// normal thing reproduces upstream's "silently stops early" behaviour without
// any special-casing here. Same reasoning covers maxConsecutiveFailures /
// maxRepeatFailures / truncate / inactivityMaxMs, whose upstream guards are all
// `[[ "$x" -gt 0 && ... ]]`-shaped and go false the same way on NaN.
export function constantsFromEnv(env: Record<string, string | undefined>): ShellmConstants {
  const raw = (name: string): string => env[name] ?? "";

  const withDefault = (name: string, def: number): number => {
    const v = raw(name);
    return v === "" ? def : Number(v);
  };

  const maxIterRaw = raw("SHELLM_MAX_ITERATIONS");
  const inactivityMaxRaw = raw("SHELLM_INACTIVITY_MAX");
  const inactivityTimeoutRaw = raw("SHELLM_INACTIVITY_TIMEOUT");
  // `${VAR-8}`, not `${VAR:-8}`: distinguish UNSET (key absent → "8") from
  // explicitly set to "" (stays "" → unlimited), unlike every knob above.
  const emptyRetriesRaw = env["SHELLM_EMPTY_RESPONSE_RETRIES"];
  const emptyRetriesVal = emptyRetriesRaw === undefined ? "8" : emptyRetriesRaw;

  return {
    maxIterations: maxIterRaw === "" ? null : Number(maxIterRaw),
    maxConsecutiveFailures: withDefault("SHELLM_MAX_CONSECUTIVE_FAILURES", DEFAULT_CONSTANTS.maxConsecutiveFailures),
    maxRepeatFailures: withDefault("SHELLM_MAX_REPEAT_FAILURES", DEFAULT_CONSTANTS.maxRepeatFailures),
    truncate: withDefault("SHELLM_TRUNCATE", DEFAULT_CONSTANTS.truncate),
    inactivityMaxMs:
      inactivityMaxRaw === "" ? DEFAULT_CONSTANTS.inactivityMaxMs : Number(inactivityMaxRaw) * 1000,
    inactivityTimeoutMs:
      inactivityTimeoutRaw === ""
        ? DEFAULT_CONSTANTS.inactivityTimeoutMs
        : Number(inactivityTimeoutRaw) * 1000,
    maxOutputBytes: withDefault("SHELLM_MAX_OUTPUT_SIZE", DEFAULT_CONSTANTS.maxOutputBytes),
    maxExecMs:
      raw("SHELLM_MAX_EXEC_TIME") === ""
        ? DEFAULT_CONSTANTS.maxExecMs
        : Number(raw("SHELLM_MAX_EXEC_TIME")) * 1000,
    emptyResponseRetries: emptyRetriesVal === "" ? null : Number(emptyRetriesVal),
    // Exact string "1" (bash `[[ "$X" == 1 ]]`), not a truthy check: any
    // other value (including "0", "true", "") leaves the feature off.
    stopAfterCodeBlock: (raw("SHELLM_STOP_AFTER_CODE_BLOCK") || "1") === "1",
    // PORT-NOTE: upstream's `case $SHELLM_CONTEXT_SCOPE in traj|run) ;; *)
    // die ...` lives in bin/shellm's CLI arg validation, which this port has
    // no equivalent of (runShellm is called as a function, not a CLI) — an
    // unrecognized value falls back to "traj" here rather than dying.
    contextScope: raw("SHELLM_CONTEXT_SCOPE") === "run" ? "run" : "traj",
    contextRunTail: withDefault("SHELLM_CONTEXT_RUN_TAIL", DEFAULT_CONSTANTS.contextRunTail),
    contextRunTailBlock: withDefault("SHELLM_CONTEXT_RUN_TAIL_BLOCK", DEFAULT_CONSTANTS.contextRunTailBlock),
    contextBlockLimit: withDefault("SHELLM_CONTEXT_BLOCK_LIMIT", DEFAULT_CONSTANTS.contextBlockLimit),
    contextWholeBlocks: withDefault("SHELLM_CONTEXT_WHOLE_BLOCKS", DEFAULT_CONSTANTS.contextWholeBlocks),
  };
}

/** What a system-prompt builder gets (see RunShellmOptions.systemPrompt). */
export interface SystemPromptContext {
  rundir: string;
  constants: ShellmConstants;
  /** The run executes in a Docker sandbox (`_SHELLM_DOCKER_MODE`). */
  docker: boolean;
  dockerImage: string;
}

export interface RunShellmOptions {
  trajectory: Trajectory;
  llm: LlmClient;
  sandbox: Sandbox;
  /** The verbatim shellm system-prompt contract (the system layer). */
  /**
   * The system prompt: a literal string (SHELLM_SYSTEM_PROMPT override / tests), or a builder called once per
   * run, after the run's transient dir exists and the loop constants are resolved. The default prompt needs
   * both: its "Output budget" line depends on the context scope and "## Current run" names the run dir
   * (bin/shellm:2772 `build_system_prompt "$context_info" "$_SHELLM_DOCKER_MODE" "$rundir"`).
   */
  systemPrompt: string | ((ctx: SystemPromptContext) => string);
  /** The wake context (route_prompt) — recorded as the `prompt` step. */
  prompt: string;
  workdir: string;
  /** Directory holding the tool shims (traj/mem/…); prepended to PATH. */
  binDir: string;
  /** Env exported into executed code (TRAJ_DIR, TRAJ_ID, IDENTITY_NAME, …). */
  execEnv: Record<string, string>;
  /** shellm-run header metadata (SPEC §2.2 / §1.1). */
  header: {
    command: string;
    model: string;
    effort: string;
    /** Raw SHELLM_MAX_TOKENS text (bin/shellm:2149), empty when unset — recorded as-is on the header. */
    maxTokens: string;
    env: EnvSpec;
    resumed: boolean;
    wake?: string;
    launchedBy?: string;
    triggerStep?: string;
  };
  constants?: Partial<ShellmConstants>;
  /** Called with the shellm-run header's step_id right after it is written (bin/shellm:2826-2840 starts the async
   *  run-summary there). */
  onHeader?: (runStepId: string) => void;
  /** Delay between empty-response retries (bin/shellm:2445,2456 `sleep 1`).
   *  Injectable so tests don't pay real wall-clock time; defaults to a real
   *  1s sleep, matching upstream. */
  sleep?: (ms: number) => Promise<void>;
  /** Operator-visible progress IO (bin/shellm's `progress`/`progress_dim`
   *  stderr lines); defaults to the real process streams. Tests inject a
   *  capturing WakeIO to assert exact lines. */
  io?: WakeIO;
}

export type StopReason = "final" | "no-block" | "max-iter" | "stall" | "empty-response";

export interface RunShellmResult {
  runStepId: string;
  stopReason: StopReason;
  iterations: number;
  /** The last assistant response text (final answer for FINAL/NO-BLOCK). */
  response: string;
  /** The stall reason text (stopReason "stall"), for the parent-trajectory merge of a nested run (bin/shellm:3453). */
  stallReason?: string;
}

export async function runShellm(opts: RunShellmOptions): Promise<RunShellmResult> {
  const c: ShellmConstants = { ...DEFAULT_CONSTANTS, ...(opts.constants ?? {}) };
  const traj = opts.trajectory;
  const io = opts.io ?? REAL_WAKE_IO;
  const p = makeProgress(io);

  // --- shellm-run header (SPEC §2.2). run_id of the wake == this step_id. ---
  const runStepId = traj.append({
    type: "shellm-run",
    command: opts.header.command,
    workdir: opts.workdir,
    model: opts.header.model,
    effort: opts.header.effort,
    max_iterations: c.maxIterations === null ? "" : String(c.maxIterations),
    max_tokens: opts.header.maxTokens,
    inactivity_timeout: "30",
    context_files: [],
    env: opts.header.env,
    resumed: opts.header.resumed,
    ...(opts.header.triggerStep ? { trigger_step: opts.header.triggerStep } : {}),
    ...(opts.header.launchedBy ? { launched_by: opts.header.launchedBy } : {}),
    ...(opts.header.wake ? { wake: opts.header.wake } : {}),
  });
  opts.onHeader?.(runStepId);

  // --- prompt step: standing context, folded once (SPEC §1.2, §7 #2). ---
  // PORT-NOTE (1c: 7a35982): the assigned step_id is kept so run-scope
  // context (below) can --pin it — a long run's own prompt must stay in view
  // past the tail window, exactly like upstream's `_prompt_step_id`.
  let promptStepId = "";
  if (opts.prompt) {
    promptStepId = traj.append({ type: "prompt", content: opts.prompt, run_id: runStepId });
  }

  const rundir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-run-"));
  const systemPrompt =
    typeof opts.systemPrompt === "function"
      ? opts.systemPrompt({
          rundir,
          constants: c,
          docker: opts.header.env.type === "docker",
          dockerImage: opts.header.env.docker_image ?? "",
        })
      : opts.systemPrompt;
  // bin/shellm:2515-2521 — local mode: $rundir/final (host tmpdir; the sandbox
  // runs the block on the host, so a plain temp file is visible after exec).
  // Docker mode: $workdir/.shellm_final — the code block runs INSIDE the
  // container, where the host tmpdir is never mounted, so a FINAL/FINAL_FILE
  // write to `rundir/final` would vanish. The workdir IS bind-mounted into the
  // container at an identical path (sandbox-runtime.ts startDockerSandbox), so
  // a file written there is visible to the host the moment `docker exec`
  // returns. opts.header.env.type is the port's exact analogue of upstream's
  // `_SHELLM_DOCKER_MODE`: it is set by selectSandbox (sandbox-runtime.ts) from
  // the very sandbox this call is about to exec against.
  const finalPath =
    opts.header.env.type === "docker" ? path.join(opts.workdir, ".shellm_final") : path.join(rundir, "final");

  // bin/shellm:2579 — SHELLM_ACTIVITY_FILE="$rundir/.activity", forwarded into
  // the exec'd env unconditionally (no docker-mode branch upstream, unlike
  // finalPath above). Faithfully NOT bind-mounted for DockerSandbox either —
  // rundir lives outside the two mounts DockerSandbox actually sets up
  // (identityDir, portHome; sandbox-runtime.ts) — so a container-side touch
  // of this path can't reach the host file, exactly like upstream's own
  // limitation. The watchdog poll itself always runs host-side regardless
  // (see sandbox.ts's execWithInactivityWatchdog doc comment), so this path
  // is meaningful for LocalSandbox and inert-but-harmless for DockerSandbox.
  const activityFile = path.join(rundir, ".activity");

  // The tool shims are Node scripts, so the running node's dir must be on PATH
  // for the sandboxed `traj` wrapper to find `node`.
  const nodeDir = path.dirname(process.execPath);
  const systemPath = opts.execEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const baseEnv: Record<string, string> = {
    ...opts.execEnv,
    PATH: `${opts.binDir}:${nodeDir}:${systemPath}`,
    SHELLM_RUN_STEP_ID: runStepId, // auto-links steps the model's bash appends
    SHELLM_WORKDIR: opts.workdir,
    HOME: opts.workdir,
    SHELLM_ACTIVITY_FILE: activityFile,
    // PORT-NOTE (stage 3b #1, bin/shellm:3085-3125): what makes a `shellm` the mind runs from its wake shell a NESTED
    // run. `_SHELLM_PARENT_TRAJ_ID` makes the child write its own trajectory (with parent_traj/parent_step) and a
    // fork/merge pair on this one; the blanks stop the child from inheriting this run's trigger/launcher or clobbering
    // the launcher's run-id report file. SHELLM_SANDBOX=local keeps a child of a local run local.
    _SHELLM_PARENT_TRAJ_ID: traj.trajId,
    SHELLM_TRIGGER_STEP_ID: "",
    SHELLM_LAUNCHED_BY: "",
    SHELLM_RUN_ID_OUT: "",
    ...(opts.header.env.type === "local" ? { SHELLM_SANDBOX: "local" } : {}),
  };
  // PORT-NOTE (sync 2e39a3f, bin/shellm run_loop "$rundir/tmp"): every temp
  // file the run's commands make (mktemp, sort, python) lands under the run
  // dir and dies with it in the `finally` below — a command the watchdog
  // killed never cleans up its own, and runs sharing the real /tmp once filled
  // a box (upstream 2026-09-17). Local sandbox only: a Docker step's own /tmp
  // is already private to its container and the host rundir is not mounted
  // there (same reason finalPath differs above). Upstream exports TMPDIR into
  // the shellm process itself; the port scopes it to the exec env instead
  // (the in-process loop must not retarget the host's own TMPDIR).
  if (opts.header.env.type !== "docker") {
    const runTmp = path.join(rundir, "tmp");
    try {
      fs.mkdirSync(runTmp, { recursive: true });
      baseEnv["TMPDIR"] = runTmp;
    } catch {
      /* best-effort, as upstream's `mkdir -p … &&` guard */
    }
  }

  let iteration = 0;
  let consecFail = 0;
  let repeatFail = 0;
  let prevFailCmd: string | null = null;
  let lastResponse = "";

  // bin/shellm:2377 — printed once, before the loop starts.
  p.progress(
    `Starting shellm loop (model: ${opts.header.model}, max iterations: ${c.maxIterations === null ? "unlimited" : c.maxIterations})`
  );

  try {
    while (c.maxIterations === null || iteration < c.maxIterations) {
      iteration++;
      const iterLabel = c.maxIterations === null ? String(iteration) : `${iteration}/${c.maxIterations}`;

      // bin/shellm:2391-2392 — blank line, then the iteration header.
      p.blank();
      p.progress(`Iteration ${iterLabel} — calling ${opts.header.model}...`);

      // Rebuild the model's chat history from the trajectory each turn (§1.4).
      const steps = traj.read() as Record<string, unknown>[];
      // PORT-NOTE (1c: 7a35982, d43ae81, 0f8b49e): --full-types prompt (a
      // prompt is never truncated — a cut prompt leaves the model a stub
      // pointing at its own instructions on disk) and the newest-block byte
      // band are always on. Run scope additionally drops every step
      // outside this run (pins stay), reading back a wide, block-moving
      // window so a normal run's cached prefix never slides.
      const contextOpts = {
        ...MONOLITH_CONTEXT_OPTS,
        trajFile: traj.trajFile,
        fullTypes: ["prompt"],
        blockLimit: c.contextBlockLimit,
        wholeBlocks: c.contextWholeBlocks,
        ...(c.contextScope === "run"
          ? {
              run: runStepId,
              head: 0,
              tail: c.contextRunTail,
              tailBlock: c.contextRunTailBlock,
              pins: promptStepId ? [promptStepId] : [],
            }
          : {}),
      };
      const messages = buildContext(steps, contextOpts);

      const t0 = Date.now();
      let resp = await opts.llm.complete(systemPrompt, messages);

      // Empty-response retry (bin/shellm:2423-2477, upstream 8ba520b/136f32b):
      // `llm --thinking` streams reasoning to a side channel separate from
      // the visible answer, and a call that spends its whole token budget
      // there returns with NO visible text — not a failure. Feed the
      // captured reasoning back as assistant context and continue; llm_s
      // below spans the whole call including these retries (the user-felt
      // time), matching upstream.
      let emptyRetries = 0;
      const maxEmptyRetries = c.emptyResponseRetries;
      let retryMessages = messages;
      const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      while (resp.text === "") {
        if (maxEmptyRetries !== null && emptyRetries >= maxEmptyRetries) break;
        emptyRetries++;
        // llm's own stderr-shaped lines ("llm: warning: …", "llm: note: …")
        // arrive mixed into the captured reasoning; they are harness noise,
        // not the model's reasoning, and must not become assistant content.
        const feedback = filterLlmNoiseLines(resp.reasoning ?? "");
        // bin/shellm:2443,2456 `${max_empty_retries:+/$max_empty_retries}` —
        // the "/MAX" suffix appears only when the cap is finite (unlimited
        // omits it, same as an unset bash var).
        const retrySuffix = maxEmptyRetries !== null ? `/${maxEmptyRetries}` : "";
        if (feedback !== "") {
          p.progress(`Empty response — feeding thinking back to continue (retry ${emptyRetries}${retrySuffix})...`);
          const pair: ChatMessage[] = [
            { role: "assistant", content: feedback },
            {
              role: "user",
              content:
                "Your previous response ran out of output tokens during the reasoning above before you could emit any visible text. Continue from where you left off and produce the bash code for the next step now.",
            },
          ];
          retryMessages = [...retryMessages, ...pair];
        } else {
          p.progress(`Empty response from API (retry ${emptyRetries}${retrySuffix})...`);
        }
        await sleep(1000);
        resp = await opts.llm.complete(systemPrompt, retryMessages);
      }
      if (resp.text === "") {
        // `thinking=$(cat "$thinking_file")` drops trailing newlines, so a channel of bare newlines is empty.
        const thinking = (resp.reasoning ?? "").replace(/\n+$/, "");
        // `$(truncate_output "$thinking")`: command substitution strips ALL
        // trailing newlines from truncate_output's own `echo`-shaped output.
        const content = thinking
          ? `Empty response from ${opts.header.model} after ${emptyRetries} retries: ${truncateOutput(thinking, c.truncate).replace(/\n+$/, "")}`
          : `Empty response from ${opts.header.model} after ${emptyRetries} retries`;
        // bin/shellm:114 die() — `echo "shellm: error: $*" >&2; exit 1`.
        io.stderr(`shellm: error: ${content}\n`);
        traj.append({ type: "error", content, source: "shellm", reason: "empty-response", run_id: runStepId });
        return { runStepId, stopReason: "empty-response", iterations: iteration, response: lastResponse };
      }

      const llmS = Math.max(0, Math.round((Date.now() - t0) / 1000));

      // PORT-NOTE (bug #69, bin/shellm:105-108,1565; bin/llm 2d1c1c3) —
      // SHELLM_STOP_AFTER_CODE_BLOCK: `llm` cuts its stream the instant the
      // first fenced bash block closes, so a turn NEVER carries a command
      // block AND a later FINAL block — the mind must spend another turn to
      // set FINAL. The in-process LlmClient.complete() path returns the
      // WHOLE completion in one shot; apply the same cut here (before
      // reasoning/code extraction see the text) so the wake's behaviour
      // matches upstream's for the same model output. usage is overwritten
      // with the bytes-based estimate exactly as bin/llm's write_usage does
      // on a cut (in_tok/think_tok dropped, not merged).
      if (c.stopAfterCodeBlock) {
        const stopResult = applyStopAfterCodeBlock(resp.text);
        if (stopResult.stopped) {
          resp = {
            ...resp,
            text: stopResult.text,
            usage: { out_tok: Math.floor((stopResult.bytes + 3) / 4), estimated: true },
          };
        }
      }

      lastResponse = resp.text;

      const reasoning = extractReasoning(resp.text);
      const { code } = extractCode(resp.text);

      // NO-BLOCK stop: no runnable code at all → final carrying the full
      // response as content (bin/shellm:2353-2363). [UNVERIFIED in traces.]
      if (code === "") {
        p.progress("No code block found — returning response as answer");
        traj.append({
          type: "final",
          thought: reasoning,
          content: resp.text,
          run_id: runStepId,
          llm_s: llmS,
          ...usageFields(resp.usage),
        });
        return { runStepId, stopReason: "no-block", iterations: iteration, response: resp.text };
      }

      // bin/shellm:2504-2510 — show the code before running it.
      const codeLines = code.split("\n");
      p.progress(`Executing bash (${codeLines.length} lines):`);
      for (const line of codeLines) p.progressDim(`  ${line}`);

      // Wrap so FINAL/FINAL_FILE are captured after execution (bin/shellm:2382-2390).
      const wrapped = buildWrappedCode(code, finalPath);
      const execT0 = Date.now();
      const exec = await opts.sandbox.exec({
        workdir: opts.workdir,
        wrappedCode: wrapped,
        env: baseEnv,
        timeoutMs: c.inactivityMaxMs,
        inactivityTimeoutMs: c.inactivityTimeoutMs,
        maxOutputBytes: c.maxOutputBytes,
        maxExecMs: c.maxExecMs,
        activityFile,
      });
      const execS = Math.max(0, Math.round((Date.now() - execT0) / 1000));

      // bin/shellm:1979-2006 `_stream_new_output`, reproduced post-hoc (see
      // printExecOutputLines doc comment), then bin/shellm:2716-2729's exit
      // status line — same order as upstream: stream, then exit status.
      printExecOutputLines(io, exec.output, { ...process.env, ...opts.execEnv });
      if (exec.timedOut) {
        // bin/shellm:2716-2721 — distinct KILLED lines for kill_reason "idle"
        // (stale_seconds hit SHELLM_INACTIVITY_TIMEOUT) vs "nested" (a live-
        // but-silent block's quiet_seconds hit SHELLM_INACTIVITY_MAX; ported
        // here as "max" — see the killReason doc comment on ExecResult for
        // why the label differs while the mechanism doesn't).
        if (exec.killReason === "output") {
          // bin/shellm (eb40093): a runaway-output kill has its own line.
          p.progress(`${ESC}[1;31mKILLED — output exceeded ${c.maxOutputBytes} bytes${ESC}[0m`);
        } else if (exec.killReason === "max") {
          p.progress(`${ESC}[1;31mKILLED — sub-run silent for ${Math.round(c.inactivityMaxMs / 1000)}s${ESC}[0m`);
        } else {
          p.progress(
            `${ESC}[1;31mKILLED — inactivity timeout (${Math.round(c.inactivityTimeoutMs / 1000)}s)${ESC}[0m`
          );
        }
      } else if (exec.exit === 0) {
        p.progressDim("Exit 0");
      } else {
        p.progress(`${ESC}[1;31mExit ${exec.exit}${ESC}[0m`);
      }

      // clean_output: strip xtrace lines for storage (bin/shellm:2585).
      const cleanOutput = cleanXtrace(exec.output);

      // Append reasoning (assistant) then shell-output (user) — AFTER exec, so
      // any obs/thought the block wrote via the shim already precede them.
      traj.append({
        type: "reasoning",
        thought: reasoning,
        cmd: code,
        run_id: runStepId,
        llm_s: llmS,
        ...usageFields(resp.usage),
      });

      if (exec.timedOut) {
        // bin/shellm:2749-2761 build_inactivity_feedback: idle vs nested get
        // different wording (this port keeps the shorter one-line shape it
        // already used pre-lane, just now correctly picking the limit that
        // actually fired — see PARITY.md for the full-paragraph prose this
        // still doesn't reproduce).
        const lastOut = truncateOutput(cleanOutput, c.truncate);
        // PORT-NOTE (sync 2e39a3f): the two new kill reasons carry upstream's
        // full build_inactivity_feedback prose (bin/shellm; a runaway producer
        // is not at a prompt, so none of the interactive-input advice
        // applies); the older idle/nested reasons keep this port's one-line
        // shape (see PARITY.md — pre-existing, unchanged).
        const feedback =
          exec.killReason === "wall"
            ? `Execution was KILLED after running for ${Math.round(c.maxExecMs / 1000)} seconds, the limit for one block\n` +
              `(it was still producing output, so something in it was waiting forever or\n` +
              `the work is too big for one block).\n` +
              `\nLast output before the kill:\n${lastOut}\n` +
              `\nCheck what the block was waiting on (a pipe, a fifo, a lock, the network)\n` +
              `and bound it with timeout. Split long work across steps: start it in the\n` +
              `background with output in a file, then check the file in a later step.\n`
            : exec.killReason === "output"
              ? `Execution was KILLED after its output grew past ${c.maxOutputBytes} bytes\n` +
                `(a command producing unbounded output, e.g. an infinite loop).\n` +
                `\nLast output before the kill:\n${lastOut}\n` +
                `\nBound the output: add a limit (head -c, timeout, a loop guard),\n` +
                `fix the loop condition, or redirect bulk output to a file.\n`
              : exec.killReason === "max"
                ? `[killed: sub-run silent for ${Math.round(c.inactivityMaxMs / 1000)}s]`
                : `[killed: no output for ${Math.round(c.inactivityTimeoutMs / 1000)}s]`;
        traj.append({
          type: "shell-output",
          stdout: cleanOutput,
          stderr: "",
          exit: exec.exit,
          timed_out: true,
          feedback,
          run_id: runStepId,
          exec_s: execS,
        });
      } else {
        traj.append({
          type: "shell-output",
          stdout: cleanOutput,
          stderr: "",
          exit: exec.exit,
          run_id: runStepId,
          exec_s: execS,
        });
      }

      // FINAL stop (bin/shellm:2643-2673): the terminating turn's reasoning and
      // shell-output were recorded above like any other iteration.
      if (fs.existsSync(finalPath)) {
        const answer = fs.readFileSync(finalPath, "utf8");
        fs.rmSync(finalPath, { force: true });
        p.blank();
        p.progress("Final answer received");
        traj.append({ type: "final", content: answer, run_id: runStepId });
        p.blank();
        p.progressDim(`Trajectory: ${traj.trajId}`);
        return { runStepId, stopReason: "final", iterations: iteration, response: answer };
      }

      // Spin/stall guard (bin/shellm:2676-2719). [UNVERIFIED in traces.]
      if (exec.exit !== 0) {
        consecFail++;
        if (prevFailCmd === code) repeatFail++;
        else repeatFail = 1;
        prevFailCmd = code;
        // bin/shellm:3427-3430: each guard is `[[ "$MAX" -gt 0 && "$n" -ge "$MAX" ]]`, so 0 switches that guard off.
        const repeatHit = c.maxRepeatFailures > 0 && repeatFail >= c.maxRepeatFailures;
        const consecHit = c.maxConsecutiveFailures > 0 && consecFail >= c.maxConsecutiveFailures;
        if (repeatHit || consecHit) {
          // bin/shellm:2841-2846 — repeat-failure text takes priority over
          // consecutive-failure text when both thresholds are met.
          const stallReason =
            repeatHit
              ? `submitted the same failing command ${repeatFail} times in a row`
              : `${consecFail} commands in a row failed with no progress`;
          p.blank();
          p.progress(`${ESC}[1;31mSTALL: agent ${stallReason} (last exit=${exec.exit}) — aborting run${ESC}[0m`);
          // bin/shellm:3440 — the plain-text line on stderr, beside the coloured progress line above.
          io.stderr(`${new Date().toISOString().replace(/\.\d+Z$/, "Z")} [shellm] STALL: agent ${stallReason} (last exit=${exec.exit}); aborting run ${traj.trajId} to stop a spin.\n`);
          // bin/shellm:3441-3446: `{type:"error", content, run_id, reason:"stall"}` — the mind reads this in its context,
          // so it names the real reason and the exit code (the port used to write one fixed sentence, and a `source`
          // field upstream does not have at this pin).
          traj.append({
            type: "error",
            content: `shellm killed this run: the agent stalled — ${stallReason} (last exit=${exec.exit}). Likely the model output could not be turned into a working command (e.g. a malformed code fence). The run was aborted to stop a token-burning spin; investigate the last few reasoning/shell-output steps.`,
            run_id: runStepId,
            reason: "stall",
          });
          return { runStepId, stopReason: "stall", iterations: iteration, response: lastResponse, stallReason };
        }
      } else {
        consecFail = 0;
        repeatFail = 0;
        prevFailCmd = null;
      }
    }
    p.blank();
    p.progress(`${ESC}[1;31mMax iterations (${c.maxIterations}) reached without final answer${ESC}[0m`);
    return { runStepId, stopReason: "max-iter", iterations: iteration, response: lastResponse };
  } finally {
    fs.rmSync(rundir, { recursive: true, force: true });
  }
}

/** bin/shellm:2382-2390 — set -x wrapper + FINAL/FINAL_FILE capture. */
export function buildWrappedCode(code: string, finalPath: string): string {
  return (
    "set -x\n" +
    code +
    "\nset +x\n" +
    // PORT-NOTE (gapcheck, execlines parity): upstream's wrapper has a BLANK line here
    // (`wrapped_code="set -x\n$code\nset +x"$'\n'"\n__shellm_rc=..."`, bin/shellm:3065-3068). It runs nothing,
    // but it moves the end-of-script line bash reports for an unterminated construct.
    "\n" +
    "__shellm_rc=$?\n" +
    "set +e\n" +
    `[ -n "\${FINAL+x}" ] && printf '%s' "$FINAL" > ${dq(finalPath)}\n` +
    `[ -n "\${FINAL_FILE+x}" ] && cat "$FINAL_FILE" > ${dq(finalPath)}\n` +
    "exit $__shellm_rc\n"
  );
}

/** Strip `+ ` / `++ ` xtrace lines exactly as bin/shellm:2585 does. */
export function cleanXtrace(output: string): string {
  return output
    .split("\n")
    .filter((l) => !/^\+\+ /.test(l) && !/^\+ /.test(l))
    .join("\n");
}

// PORT-NOTE (behavioral parity round 2, D5): bin/shellm:3332 builds the reasoning/final step as
// `{type,thought,cmd,run_id,llm_s} + $usage`, where $usage is the WHOLE usage file bin/llm wrote
// (bin/llm write_usage: in_tok, out_tok, think_tok, cache_tok, estimated, served_by, truncated). So every one of
// those fields lands on the step; the port used to copy only in_tok/out_tok/think_tok/estimated.
export function usageFields(
  u:
    | { in_tok?: number; out_tok?: number; think_tok?: number; cache_tok?: number; estimated?: boolean; served_by?: string; truncated?: boolean }
    | undefined
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  if (u?.in_tok !== undefined) out["in_tok"] = u.in_tok;
  if (u?.out_tok !== undefined) out["out_tok"] = u.out_tok;
  if (u?.think_tok !== undefined) out["think_tok"] = u.think_tok;
  if (u?.cache_tok !== undefined) out["cache_tok"] = u.cache_tok;
  if (u?.served_by !== undefined && u.served_by !== "") out["served_by"] = u.served_by;
  if (u?.truncated === true) out["truncated"] = true;
  // bin/llm write_usage: `estimated` appears only when true, never `false`.
  if (u?.estimated === true) out["estimated"] = true;
  return out;
}

// PORT-NOTE (gapcheck, execlines parity): upstream writes `> "$final_path"` (bin/shellm:3070-3071), DOUBLE
// quotes. The port used single quotes (`shq`); a model block with an unbalanced `'` then paired differently
// with the wrapper's own quotes and bash reported a different "unexpected EOF" line. Same text as upstream
// for any ordinary path; `\ $ " \`` are backslash-escaped so an odd path still names the same file.
function dq(s: string): string {
  return '"' + s.replace(/([\\$"`])/g, "\\$1") + '"';
}

/** bin/shellm:2438 `grep -Ev '^llm: (warning|note): '` — strips llm's own
 *  harness-noise lines out of captured reasoning before it becomes assistant
 *  content in the empty-response retry's feedback. */
export function filterLlmNoiseLines(thinking: string): string {
  // Both captures are command substitutions upstream (`thinking=$(cat "$thinking_file")`,
  // `feedback=$(printf '%s\n' "$thinking" | grep …)`), which drop every trailing newline: a reasoning
  // channel holding only llm's own lines plus blank lines is empty, i.e. the silent branch.
  return thinking
    .replace(/\n+$/, "")
    .split("\n")
    .filter((l) => !/^llm: (warning|note): /.test(l))
    .join("\n")
    .replace(/\n+$/, "");
}

/** bin/shellm:302-314 truncate_output — half from each end, byte-shaped
 *  (upstream `${#input}`/`${input:0:$half}` are Bash CHARACTER counts, which
 *  this JS string indexing matches for BMP text; astral-plane input can
 *  split a surrogate pair, same class as the mem summary deviation). */
export function truncateOutput(input: string, max: number): string {
  if (input.length <= max) return `${input}\n`; // bash `echo "$input"` — one trailing newline
  const half = Math.floor(max / 2);
  const skipped = input.length - max;
  // Each Bash `echo` line ends with its own newline (three `echo` calls).
  return `${input.slice(0, half)}\n[... truncated ${skipped} chars ...]\n${input.slice(-half)}\n`;
}
