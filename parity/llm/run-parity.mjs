#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `llm` tool (slice 1: the
// OpenAI-family wire path).
//
// Runs the REAL Bash tool (headlong/bin/llm) and the TS port (bin/llm.mjs) on
// identical inputs in isolated scratch sandboxes, BOTH pointed at the same
// local fake OpenAI-compatible server (test/llmFakeServer.ts) via LLM_API_URL,
// then diffs stdout + stderr + exit code + on-disk effects (health marker,
// usage ledger, LLM_USAGE_FILE, temp-file cleanup) + the requests the server
// received (method, path, content-type, authorization, JSON payload).
// Scenarios are harvested from the Bash source and tests/test_llm_*.sh.
//
// Nondeterminism is normalized SYMMETRICALLY on both sides before comparison:
//   2026-01-02T03:04:05Z            -> <TS>        (health/ledger timestamps)
//   127.0.0.1:<port>                -> 127.0.0.1:<PORT>
//   the Bash script's absolute path -> <BASH_LLM>
//   each sandbox's absolute path    -> <SB>
// Everything else is compared exactly.
//
// Every mismatch is classified: a scenario may declare a `deviation` (id +
// the fields allowed to differ); a mismatch confined to those fields is a
// DOCUMENTED DEVIATION, anything else is a PORT BUG. Exit 0 iff zero port bugs.
//
// Repeatable: `node parity/llm/run-parity.mjs` (Node ≥ 22.18, which strips TS
// types natively so the fake server is imported from test/). Set
// PARITY_BASH_LLM=/abs/path/to/headlong/bin/llm to point at the Bash tool.
//
// CLASSIFICATION (2026-10-29): WIRE / TRANSPORT FIXTURES, not model output. `llm` is the transport tool itself; the
// server's replies (SSE framing, CRLF, comment lines, thinking deltas, 4xx/5xx bodies, empty and stalled streams) are
// what this harness tests, and their content strings ("ok", "hi") are opaque payload bytes that nothing downstream
// interprets. Real recorded model replies through `llm` are covered by the harnesses on parity/support/replayModel.mjs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeServer, R } from "../../test/llmFakeServer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Scrubbed to a placeholder for release; set PARITY_BASH_LLM=/abs/path/to/
// headlong/bin/llm to reproduce the run.
const BASH_LLM = process.env.PARITY_BASH_LLM || "<HEADLONG_ROOT>/bin/llm";
const TS_LLM = path.join(REPO, "bin", "llm.mjs");
// The upstream checkout, this repo, and $HOME never reach the committed artifacts.
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_LLM), "..");
const HOME_DIR = os.homedir();

if (!fs.existsSync(BASH_LLM)) {
  console.error(`parity: Bash tool not found at ${BASH_LLM} (set PARITY_BASH_LLM)`);
  process.exit(2);
}

// Feature-detect the pointed-at Bash checkout rather than assuming a pin:
// this harness runs against ANY checkout PARITY_BASH_LLM points at — it must
// stay runnable against EITHER an OLD pre-015d081 checkout (e.g. the port's
// original ed2dac6 oracle) or a NEW one (>=015d081, includes the port's
// current 5458fee pin — see PARITY.md) without the OLD run reporting
// spurious PORT BUGS for a flag it was never meant to have. `--help`'s own
// text is the probe (cheap, no state, matches how upstream itself documents
// the flag).
function bashHelpText(bin) {
  try {
    return execFileSync(bin, ["--help"], { encoding: "utf8" });
  } catch {
    return "";
  }
}
const BASH_LLM_HELP = bashHelpText(BASH_LLM);
const BASH_LLM_HAS_OR_ROUTING = BASH_LLM_HELP.includes("--or-only");
if (!BASH_LLM_HAS_OR_ROUTING) {
  console.log(
    `parity: ${BASH_LLM} predates --or-only (OpenRouter routing, upstream 015d081) — the or-routing scenario group is skipped for this run, not counted as PORT BUG or DEVIATION.`
  );
}
const BASH_LLM_HAS_MESSAGES_FILE = BASH_LLM_HELP.includes("--messages-file");
if (!BASH_LLM_HAS_MESSAGES_FILE) {
  console.log(
    `parity: ${BASH_LLM} predates --messages-file (upstream 136f32b) — the messages-file scenarios are skipped for this run, not counted as PORT BUG or DEVIATION.`
  );
}
// Sync 2e39a3f: `--json-schema`, usage `served_by`/`truncated`, content_filter
// refusal, GLM/MiMo token tier. Probed the same way (help text names the flag).
const BASH_LLM_HAS_JSON_SCHEMA = BASH_LLM_HELP.includes("--json-schema");
if (!BASH_LLM_HAS_JSON_SCHEMA) {
  console.log(
    `parity: ${BASH_LLM} predates --json-schema (upstream sync 2e39a3f) — the json-schema / served_by / truncated / content_filter / glm-mimo scenarios are skipped for this run, not counted as PORT BUG or DEVIATION.`
  );
}
const BASH_LLM_HELP_TRACKS_UPSTREAM = BASH_LLM_HAS_OR_ROUTING || BASH_LLM_HAS_MESSAGES_FILE || BASH_LLM_HAS_JSON_SCHEMA;
if (!BASH_LLM_HELP_TRACKS_UPSTREAM) {
  console.log(
    `parity: ${BASH_LLM} help text predates ported flags (--or-only, --messages-file); help text tracks upstream <sha>; older checkout — the usage/help-short, usage/help-long, usage/help-after-flags scenarios are skipped for this run, not counted as PORT BUG or DEVIATION.`
  );
}

const srv = await startFakeServer();
const U = "<URL>"; // substituted with the fake server's URL at run time
const PORT_RE = new RegExp(`127\\.0\\.0\\.1:${srv.port}\\b`, "g");

// --- deviation catalogue --------------------------------------------------------
const DEVIATIONS = {
  "bash-2q": {
    fields: ["stderr"],
    title: "`${2:?msg}` bash-builtin error text on a missing/empty flag value",
    text:
      "The Bash relies on `${2:?message}`, which prints `<script>: line N: 2: <message>` and exits 1. The port prints `llm: error: <message>`, exit 1. Exit code, stdout (empty), on-disk state and requests (none) match; only the stderr phrasing differs, on a misuse path no caller inspects. Same deviation as mem/skills.",
  },
  "jq-messages": {
    fields: ["stderr", "status"],
    title: "`-M` that jq cannot consume",
    text:
      "Invalid JSON, or a non-array with `-s`, makes the Bash die inside jq (`jq: parse error …` / `… cannot be added`, exit 5). The port dies `llm: error: --messages is not valid JSON` / `… must be a JSON array (cannot prepend the system message)`, exit 1. No request, no state on either side.",
  },
  "transport-text": {
    fields: ["stderr", "state"],
    title: "transport-failure wording on the streaming path",
    text:
      "Where the Bash relays curl's own text (`curl error: curl: (7) Failed to connect …`, `(18) transfer closed …`, `(28) Operation too slow …`), the port says `request failed: <node detail>`. stdout (including any partial streamed output), exit code, retry count and the health-marker `kind` are identical; only the message text (stderr + marker `message`) differs. The non-streaming path never carried curl's text (`HTTP 000`) and is at parity.",
  },
  "jq-crash-nonjson-200": {
    // "state": the abort also skips the Bash's temp-file cleanup, so where mktemp lands inside the captured sandbox
    // (GNU mktemp on Linux honors the harness TMPDIR) upstream leaves the response body behind as tmp/tmp.XXXXXXXXXX.
    fields: ["stderr", "status", "state"],
    title: "non-JSON 2xx body on the non-streaming path",
    text:
      "The Bash's `embedded_err=$(check_response_… < body)` fails inside jq on a body that is not JSON, and `set -e` aborts the script: exit 5, nothing on stdout or stderr, no health marker, no retry, and (on Linux) its temp file of the response body left behind. The port fails at the same point, also without a marker or retry, but honestly: `llm: error: API error: response body is not JSON (HTTP 200)`, exit 1.",
  },
  "jq-stderr-noise": {
    fields: ["stderr"],
    title: "jq parse-error noise on an unparseable SSE event",
    text:
      "On a `data:` event that is not JSON the Bash's per-delta jq prints `jq: parse error: …` to stderr and extracts nothing; the port extracts nothing silently. stdout, exit code, retries and state are identical.",
  },
  "connect-timeout-approx": {
    fields: ["stdout", "stderr", "status", "state", "requests"],
    title: "LLM_CONNECT_TIMEOUT bounds a broader window than curl's own connect phase",
    text:
      "curl's `--connect-timeout` bounds ONLY the TCP+TLS handshake; fetch (undici) exposes no connect-phase hook without a custom Dispatcher, which would need the `undici` package as a new dependency this port doesn't take. Approximated instead as \"time until fetch() resolves\" (connect + TLS + request-send + time-to-first-byte). Against a server that accepts the TCP connection instantly but is slow to respond (this scenario: local socket connects immediately, headers delayed), the Bash's connect-timeout never fires (the connect phase itself was fast) and the call succeeds once the slow response eventually arrives; the port's broader timer fires at the same deadline and aborts the call. Once headers DO arrive before the deadline, the two are identical (LLM_MAX_TIME/LLM_SPEED_LIMIT govern the rest either way) — see the non-deviation scenarios.",
  },
  "usage-field-shift": {
    fields: ["state"],
    title: "usage record with a missing leading/middle token field (1c: 1fdeb97 adds a 4th @tsv cell)",
    text:
      "`IFS=$'\\t' read -r _u_in _u_out _u_think _u_cache <<<\"$_u\"` inherits the same pre-existing bash bug already documented for the 3-field row (`usageOpenAI`'s PORT-NOTE): `IFS=$'\\t'` is a single WHITESPACE character (tab), so `read` collapses consecutive/empty delimiters instead of preserving empty fields. cache_tok's new 4th cell means this now also fires whenever the 3rd cell (think_tok) is EMPTY and cache_tok is present: the Bash shifts the cache value into think_tok and reports no cache_tok at all. This hits the shared `read`-based non-streaming path for ALL THREE providers (anthropic|opencode's think_tok cell is ALWAYS the literal \"\" on that path, so it is ALWAYS lost there whenever cache_tok is reported), plus the OpenAI/Gemini STREAMING paths (which use the same `read` pattern) whenever the provider omits reasoning_tokens on a cached call. Anthropic's STREAMING path is immune (a separate code path assigns each field from its own dedicated jq call, no positional `read`). The port keeps every field in its own slot (jq-shaped reads throughout, never a positional `read`), so it always reports both fields correctly.",
  },
};

// --- scenarios ------------------------------------------------------------------
const OR = { OPENROUTER_API_KEY: "test-key", LLM_API_URL: U }; // keyed, rerouted → URL warning expected
const COMPAT = { LLM_PROVIDER: "openai-compatible", LLM_API_URL: U, LLM_RETRIES: "0" };
const OA = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const OC = { OPENCODE_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const ANTH = { ANTHROPIC_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const GEM = { GEMINI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const ZEN = { OPENCODE_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const S = (group, name, argv, extra = {}) => ({ group, name, argv, ...extra });
const dev = (id) => ({ deviation: id });

// A Node adapter fixture recording its argv/stdin/system-prompt-file to files
// the scenario can diff on both sides (the SAME fixture executes for both the
// real Bash tool and the port — the adapter contract is language-agnostic;
// design/providers.md). Kept as a plain Node script (no bash) per this port's
// zero-Bash rule for anything it contributes, even a throwaway test fixture.
const ADAPTER_FIXTURE = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync("adapter_args.json", JSON.stringify(args));
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync("adapter_stdin.json", stdin);
  const idx = args.indexOf("--system-prompt-file");
  if (idx >= 0) fs.writeFileSync("adapter_sys.txt", fs.readFileSync(args[idx + 1], "utf8"));
  if (process.env.ADAPTER_USAGE && process.env.LLM_USAGE_FILE) fs.writeFileSync(process.env.LLM_USAGE_FILE, process.env.ADAPTER_USAGE);
  const rc = Number(process.env.ADAPTER_RC || "0");
  if (rc !== 0) { process.stderr.write("stub adapter failing on purpose\\n"); process.exit(rc); }
  process.stdout.write("adapter says ok");
});
`;

const MSGS = JSON.stringify([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c", extra: 1 }]);

const scenarios = [
  // ---- usage ----
  ...(BASH_LLM_HELP_TRACKS_UPSTREAM
    ? [
        S("usage", "help-short", ["-h"]),
        S("usage", "help-long", ["--help"]),
        S("usage", "help-after-flags", ["-m", "x", "--no-stream", "--help"]),
      ]
    : []),
  S("usage", "help-inside-prompt", ["-m", "x", "foo", "-h"], { env: COMPAT, replies: [R.sseOk] }),

  // ---- args ----
  S("args", "unknown-option", ["--bogus", "hi"]),
  S("args", "dash-alone", ["-", "hi"]),
  S("args", "model-missing-value", ["-m"], dev("bash-2q")),
  S("args", "model-empty-value", ["-m", ""], dev("bash-2q")),
  S("args", "system-missing-value", ["-s"], dev("bash-2q")),
  S("args", "spf-missing-value", ["--system-prompt-file"], dev("bash-2q")),
  S("args", "maxtokens-missing-value", ["-t"], dev("bash-2q")),
  S("args", "messages-missing-value", ["-M"], dev("bash-2q")),
  S("args", "messages-empty-value", ["-M", ""], dev("bash-2q")),
  ...(BASH_LLM_HAS_JSON_SCHEMA
    ? [
        // ---- sync 2e39a3f: --json-schema ----
        S("jsonschema", "missing-value", ["--json-schema"], dev("bash-2q")),
        S("jsonschema", "file-not-found", ["--json-schema", "nope.json", "-m", "x", "hi"], { env: COMPAT }),
        S("jsonschema", "openai-compat-response-format", ["-m", "x", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}\n\n' },
          env: COMPAT,
          replies: [R.sseOk],
        }),
        S("jsonschema", "openrouter-with-routing-and-thinking", ["-m", "openai/gpt-5", "--thinking", "low", "--or-only", "openai", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": '{"type":"object"}' },
          env: { ...OR, LLM_RETRIES: "0" },
          replies: [R.sseOk],
        }),
        S("jsonschema", "nostream-system", ["--no-stream", "-m", "x", "-s", "be terse", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": '{"type":"object"}' },
          env: COMPAT,
          replies: [R.http200],
        }),
        S("jsonschema", "anthropic-ignored-warns", ["-m", "claude-sonnet-4-5", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": '{"type":"object"}' },
          env: ANTH,
          replies: [R.anthropicSseOk],
        }),
        S("jsonschema", "gemini-ignored-warns", ["-m", "gemini-2.0-flash", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": '{"type":"object"}' },
          env: GEM,
          replies: [R.geminiSseOk],
        }),
        S("jsonschema", "invalid-json-schema-file", ["-m", "x", "--json-schema", "schema.json", "hi"], {
          files: { "schema.json": "{not json" },
          env: COMPAT,
          replies: [R.sseOk],
          deviation: "jq-messages",
        }),
        // ---- sync 2e39a3f: served_by / truncated in the usage record ----
        S("usage2", "stream-served-by", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.sseServedBy] }),
        S("usage2", "stream-served-by-truncated", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.sseServedByLength] }),
        S("usage2", "stream-served-by-not-openrouter", ["-m", "a/b", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "usage.json" }, replies: [R.sseServedBy] }),
        S("usage2", "nostream-served-by", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200ServedBy] }),
        S("usage2", "nostream-served-by-not-openrouter", ["--no-stream", "-m", "a/b", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "usage.json" }, replies: [R.http200ServedBy] }),
        S("usage2", "nostream-provider-object-ignored", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200ProviderObject] }),
        S("usage2", "nostream-truncated-ledger", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200LengthUsage] }),
        S("usage2", "stop-after-code-block-estimate-drops-served-by", ["-m", "a/b", "--stop-after-code-block", "hi"], {
          env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" },
          replies: [R.sseCodeBlockThenMore],
        }),
        // ---- sync 2e39a3f: content_filter refusal is final, never retried ----
        S("refusal", "content-filter-not-retried", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2", LLM_RETRY_BACKOFF: "0" }, replies: [R.sseContentFilter, R.sseOk] }),
        S("refusal", "content-filter-after-text-is-plain-success", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2", LLM_RETRY_BACKOFF: "0" }, replies: [R.sseTextThenContentFilter] }),
        // ---- sync 2e39a3f: GLM / MiMo 64000 token tier on OpenRouter ----
        ...["z-ai/glm-5.1", "z-ai/glm-4.6", "xiaomi/mimo-v2-pro", "xiaomi/other"].map((m) =>
          S("maxtok", `or-${m.replace(/[^a-z0-9]+/gi, "-")}`, ["--no-stream", "-m", m, "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http200] })
        ),
      ]
    : []),
  ...(BASH_LLM_HAS_MESSAGES_FILE
    ? [
        S("args", "messages-file-missing-path", ["--messages-file"], dev("bash-2q")),
        S("args", "messages-file-not-found", ["--messages-file", "nope.json", "hi"]),
        S("args", "messages-file-read-trailing-newlines-stripped", ["-m", "x", "--messages-file", "msgs.json"], {
          files: { "msgs.json": `${MSGS}\n\n\n` },
          env: COMPAT,
          replies: [R.sseOk],
        }),
      ]
    : []),
  S("args", "provider-missing-value", ["--provider"], dev("bash-2q")),
  S("args", "effort-missing-value", ["--effort"], dev("bash-2q")),
  S("args", "spf-not-found", ["--system-prompt-file", "nope.txt", "hi"]),
  S("args", "spf-read-trailing-newlines-stripped", ["-m", "x", "--system-prompt-file", "sys.txt", "hi"], { files: { "sys.txt": "be terse\n\n\n" }, env: COMPAT, replies: [R.sseOk] }),
  S("args", "spf-empty-file-no-system", ["-m", "x", "--system-prompt-file", "empty.txt", "hi"], { files: { "empty.txt": "" }, env: COMPAT, replies: [R.sseOk] }),
  S("args", "prompt-joins-remaining-argv", ["-m", "x", "hello", "world", "-m", "other", "--no-stream"], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "empty-first-positional", ["-m", "x", "", "foo"], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "thinking-greedy-level", ["-m", "gpt-5", "--thinking", "high", "hi"], { env: OA, replies: [R.sseOk] }),
  S("args", "thinking-greedy-stops-at-dash", ["-m", "gpt-5", "--thinking", "-t", "9", "hi"], { env: OA, replies: [R.sseOk] }),
  S("args", "thinking-greedy-empty-not-swallowed", ["-m", "gpt-5", "--thinking", "", "hi"], { env: OA, replies: [R.sseOk] }),
  S("args", "thinking-swallows-prompt", ["-m", "gpt-5", "--thinking", "hi"], { env: OA }),
  S("args", "thinking-level-unsupported-model", ["-m", "gpt-4o", "--thinking", "low", "hi"], { env: OA, replies: [R.sseOk] }),
  S("args", "thinking-level-assume", ["-m", "gpt-4o", "--thinking", "low", "hi"], { env: { ...OA, LLM_ASSUME_THINKING: "1" }, replies: [R.sseOk] }),
  S("args", "thinking-level-o3", ["-m", "o3-mini", "--thinking", "xhigh", "hi"], { env: OA, replies: [R.sseOk] }),
  S("args", "effort-raw-stream-ignored", ["-m", "x", "--effort", "max", "--stream", "--raw", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "messages-verbatim-prompt-dropped", ["-m", "x", "-M", MSGS, "dropped", "prompt"], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "messages-object-no-system", ["-m", "x", "-M", '{"not":"an array"}'], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "messages-with-system", ["-m", "x", "-s", "S", "-M", MSGS], { env: COMPAT, replies: [R.sseOk] }),
  S("args", "messages-invalid-json", ["-m", "x", "-M", "notjson"], { env: COMPAT, ...dev("jq-messages") }),
  S("args", "messages-object-with-system", ["-m", "x", "-s", "S", "-M", '{"a":1}'], { env: COMPAT, ...dev("jq-messages") }),

  // ---- prompt ----
  S("prompt", "stdin-trailing-newlines-stripped", ["-m", "x"], { stdin: "from stdin\nline2\n\n\n", env: COMPAT, replies: [R.sseOk] }),
  S("prompt", "stdin-empty-dies", ["-m", "x"], { stdin: "", env: COMPAT }),
  S("prompt", "stdin-newlines-only-dies", ["-m", "x"], { stdin: "\n\n", env: COMPAT }),
  S("prompt", "no-prompt-dies", [], { stdin: "" }),
  S("prompt", "large-prompt", ["-m", "x"], { stdin: "x".repeat(300000) + "\n", env: COMPAT, replies: [R.sseOk] }),

  // ---- model ----
  S("model", "no-model-no-key", ["hi"]),
  S("model", "default-openrouter", ["hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("model", "default-openai", ["hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("model", "default-opencode-go", ["hi"], { env: OC, replies: [R.sseOk] }),
  S("model", "default-anthropic", ["hi"], { env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.anthropicSseOk] }),
  S("model", "default-gemini", ["hi"], { env: { GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.geminiSseOk] }),
  S("model", "shellm-model", ["hi"], { env: { ...COMPAT, SHELLM_MODEL: "shm", SHELLM_FAST_MODEL: "ignored" }, replies: [R.sseOk] }),
  S("model", "llm-model-env-beats-shellm", ["hi"], { env: { ...COMPAT, LLM_MODEL: "envm", SHELLM_MODEL: "shm" }, replies: [R.sseOk] }),
  S("model", "flag-beats-env", ["-m", "flag", "hi"], { env: { ...COMPAT, LLM_MODEL: "envm" }, replies: [R.sseOk] }),
  S("model", "llm-model-env-empty", ["hi"], { env: { ...COMPAT, LLM_MODEL: "" } }),

  // ---- provider ----
  S("provider", "detect-openrouter", ["-m", "vendor/some-model", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "detect-openai", ["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "detect-o1", ["-m", "o1", "hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "detect-chatgpt", ["-m", "chatgpt-4o-latest", "hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "detect-opencode-go-prefix-stripped", ["-m", "opencode-go/glm-5", "hi"], { env: OC, replies: [R.sseOk] }),
  S("provider", "unclassifiable-dies", ["-m", "my-local-alias", "hi"], { env: { OPENAI_API_KEY: "k" } }),
  S("provider", "env-provider-unclassifiable-quiet", ["-m", "my-local-alias", "hi"], { env: OA, replies: [R.sseOk] }),
  S("provider", "env-provider-mismatch-warns", ["-m", "claude-sonnet-4-5", "hi"], { env: OA, replies: [R.sseOk] }),
  S("provider", "flag-provider-silences", ["-m", "claude-sonnet-4-5", "--provider", "openai-compatible", "hi"], { env: { LLM_PROVIDER: "openai", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "flag-provider-equal-to-env-still-warns", ["-m", "claude-sonnet-4-5", "--provider", "openai", "hi"], { env: OA, replies: [R.sseOk] }),
  S("provider", "typo-provider-ordering", ["-m", "gpt-4o", "-t", "abc", "hi"], { env: { LLM_PROVIDER: "openai-compatibel", LLM_API_URL: "http://u:p@127.0.0.1:9/x?t=1", OPENROUTER_API_KEY: "k" } }),
  S("provider", "typo-provider-flag", ["-m", "qwen3:8b", "--provider", "openai-compatibel", "hi"], { env: { LLM_API_URL: U } }),
  S("provider", "adapter-not-set", ["-m", "x", "hi"], { env: { LLM_PROVIDER: "adapter" } }),
  S("provider", "adapter-not-executable", ["-m", "x", "hi"], { env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "nope" } }),
  S("provider", "adapter-ok", ["-m", "x", "hi"], { files: { ad: { content: '#!/usr/bin/env node\nprocess.stdout.write("adapter-says-hi");\n', mode: 0o755 } }, env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "./ad" } }),
  S("provider", "openai-no-key", ["-m", "gpt-4o", "hi"]),
  S("provider", "openrouter-no-key", ["-m", "a/b", "hi"]),
  S("provider", "opencode-go-no-key", ["-m", "opencode-go/x", "hi"]),
  S("provider", "anthropic-no-key", ["-m", "claude-x", "hi"]),
  S("provider", "gemini-no-key", ["-m", "gemini-x", "hi"]),
  S("provider", "opencode-zen-no-key", ["-m", "opencode/x", "hi"]),
  S("provider", "opencode-zen-ok", ["-m", "opencode/x", "hi"], { env: OC, replies: [R.anthropicSseOk] }),

  // ---- url / endpoints ----
  S("url", "keyed-warns-host-only-creds", ["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "sekrit", LLM_API_URL: "http://user:hunter2@127.0.0.1:<PORT>/v1/chat/completions?token=topsecret", LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("url", "keyed-warns-fragment", ["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "sekrit", LLM_API_URL: "http://127.0.0.1:<PORT>/v1/chat/completions#token=topsecret", LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("url", "compat-basic-auth-from-url", ["-m", "qwen3:8b", "hi"], { env: { LLM_PROVIDER: "openai-compatible", LLM_API_URL: "http://user:hunter2@127.0.0.1:<PORT>/v1/chat/completions", LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("url", "compat-exempt-keyless", ["-m", "qwen3:8b", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("url", "compat-url-required", ["-m", "qwen3:8b", "hi"], { env: { LLM_PROVIDER: "openai-compatible" } }),
  S("url", "compat-shellm-url-fallback", ["-m", "qwen3:8b", "hi"], { env: { LLM_PROVIDER: "openai-compatible", SHELLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("url", "compat-key-bearer-and-t", ["-m", "qwen3:8b", "-t", "512", "hi"], { env: { ...COMPAT, LLM_API_KEY: "sekrit" }, replies: [R.sseOk] }),
  S("url", "compat-known-model-keeps-cap", ["-m", "gpt-5", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("url", "opencode-go-endpoint-warns", ["-m", "opencode-go/kimi-k2", "hi"], { env: OC, replies: [R.sseOk] }),

  // ---- max tokens table ----
  ...[
    "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-haiku-4-5",
    "claude-3-5-sonnet", "claude-3-opus", "o1", "o3-mini", "o4-mini", "gpt-5.5", "gpt-4o-mini", "gpt-4-turbo",
    "gpt-4.1", "gpt-3.5-turbo", "gemini-2.0-flash", "gemini-3.5-flash", "anthropic/claude-sonnet-4.5",
    "x-ai/grok-4", "x-ai/grok-3", "qwen/qwen3", "qwen3:8b",
  ].map((m) => S("maxtok", `table-${m.replace(/[^a-z0-9]+/gi, "-")}`, ["--no-stream", "-m", m, "hi"], { env: COMPAT, replies: [R.http200] })),
  ...["glm-5", "kimi-k2", "qwen3-coder", "minimax-m2", "deepseek-v4-flash", "grok-code", "hy3-x", "ox-alpha-1", "gpt-5", "something"].map((m) =>
    S("maxtok", `opencode-go-${m}`, ["--no-stream", "-m", `opencode-go/${m}`, "hi"], { env: OC, replies: [R.http200] })
  ),
  S("maxtok", "env-non-numeric-warns", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TOKENS: "abc" }, replies: [R.sseOk] }),
  S("maxtok", "env-numeric", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TOKENS: "77" }, replies: [R.sseOk] }),
  S("maxtok", "flag-non-numeric-warns", ["-m", "x", "-t", "lots", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("maxtok", "flag-zero", ["-m", "x", "-t", "0", "hi"], { env: COMPAT, replies: [R.sseOk] }),

  // ---- payload ----
  S("payload", "system-prepended", ["-m", "x", "-s", "be terse", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("payload", "no-stream-no-stream-options", ["-m", "x", "--no-stream", "hi"], { env: COMPAT, replies: [R.http200] }),
  S("payload", "unicode-prompt", ["-m", "x", "café — 日本語 \"quoted\" \\ back"], { env: COMPAT, replies: [R.sseOk] }),

  // ---- streaming ----
  S("stream", "ok", ["-m", "openai/gpt-oss-120b", "say ok"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("stream", "newline-deltas-cr-comment", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseNewlines] }),
  S("stream", "finish-length-warns", ["-m", "a/b", "-t", "12", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.sseFinishLength] }),
  S("stream", "usage-ledger", ["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseOkUsage] }),
  S("stream", "usage-file-identity", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json", IDENTITY_DIR: "ident", IDENTITY_NAME: "ada" }, replies: [R.sseOkUsage] }),
  S("stream", "no-usage-no-ledger", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.sseOk] }),
  S("stream", "usage-file-stale-content-reread", ["-m", "a/b", "hi"], { files: { "usage.json": '{"in_tok":5}\n' }, env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.sseOk] }),
  // ---- 1c: 1fdeb97 cache_tok ----
  S("stream", "cache-tok-usage-ledger", ["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.sseOkUsageCache] }),
  // ---- 1c: 2d1c1c3 LLM_STOP_AFTER_CODE_BLOCK ----
  S("stream", "stop-after-code-block-off-by-default", ["-m", "openai/gpt-oss-120b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseCodeBlockThenMore] }),
  S("stream", "stop-after-code-block-flag-cuts-and-estimates-usage", ["-m", "openai/gpt-oss-120b", "--stop-after-code-block", "hi"], {
    env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" },
    replies: [R.sseCodeBlockThenMore],
  }),
  S("stream", "stop-after-code-block-env-var", ["-m", "openai/gpt-oss-120b", "hi"], {
    env: { ...OR, LLM_RETRIES: "0", LLM_STOP_AFTER_CODE_BLOCK: "1" },
    replies: [R.sseCodeBlockThenMore],
  }),
  S("stream", "stop-after-code-block-env-var-non-1-is-off", ["-m", "openai/gpt-oss-120b", "hi"], {
    env: { ...OR, LLM_RETRIES: "0", LLM_STOP_AFTER_CODE_BLOCK: "true" },
    replies: [R.sseCodeBlockThenMore],
  }),
  S("stream", "stop-after-code-block-heredoc-aware", ["-m", "openai/gpt-oss-120b", "--stop-after-code-block", "hi"], {
    env: { ...OR, LLM_RETRIES: "0" },
    replies: [R.sseCodeBlockHeredoc],
  }),
  S("stream", "err-body-retried-then-ok", ["-m", "openai/gpt-oss-120b", "say ok"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.errBodyStream, R.errBodyStream, R.sseOk] }),
  S("stream", "err-body-persistent", ["-m", "openai/gpt-oss-120b", "say ok"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.errBodyStream] }),
  S("stream", "retries-zero", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.errBodyStream] }),
  S("stream", "retries-non-numeric", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "lots" }, replies: [R.errBodyStream] }),
  S("stream", "http400-json-retried", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.http400Stream, R.sseOk] }),
  S("stream", "ws-body-persistent", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.wsBodyStream] }),
  S("stream", "ws-body-then-ok", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.wsBodyStream, R.sseOk] }),
  S("stream", "empty-body-persistent", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.emptyBodyStream] }),
  S("stream", "empty-body-then-ok", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.emptyBodyStream, R.sseOk] }),
  S("stream", "credit-error-marker", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.errBodyCreditStream] }),
  S("stream", "midstream-fail-no-retry", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.sseMidstreamFail], ...dev("transport-text") }),
  S("stream", "conn-refused", ["-m", "a/b", "hi"], { env: { OPENROUTER_API_KEY: "k", LLM_API_URL: "http://127.0.0.1:9/x", LLM_RETRIES: "1" }, ...dev("transport-text") }),
  S("stream", "stall-no-bytes", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100" }, replies: [R.hang], ...dev("transport-text") }),
  S("stream", "stall-after-keepalive", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100" }, replies: [R.hangKeepalive] }),
  S("stream", "raw-ignored", ["-m", "a/b", "--raw", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("stream", "bad-json-event-skipped", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseBadJsonEvent], ...dev("jq-stderr-noise") }),
  S("stream", "data-without-space-is-not-data", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.sseNoSpace] }),
  S("stream", "connect-timeout-fast-connect-slow-response", ["-m", "a/b", "hi"], {
    env: { ...OR, LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "1" },
    replies: [{ sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n', delayMs: 2500 }],
    ...dev("connect-timeout-approx"),
  }),
  S("stream", "connect-timeout-headers-arrive-in-time", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "5" }, replies: [R.sseOk] }),
  S("stream", "connect-timeout-disabled", ["-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_CONNECT_TIMEOUT: "0" }, replies: [R.sseOk] }),

  // ---- non-streaming ----
  S("nostream", "ok", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http200] }),
  S("nostream", "raw", ["--no-stream", "--raw", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http200] }),
  S("nostream", "multiline", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http200Multiline] }),
  S("nostream", "no-content-prints-nothing", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http200NoContent] }),
  S("nostream", "not-json-200", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.http200NotJson], ...dev("jq-crash-nonjson-200") }),
  S("nostream", "500-then-200", ["--no-stream", "-m", "openai/gpt-oss-120b", "say ok"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.http500, R.http200] }),
  S("nostream", "400-not-retried", ["--no-stream", "-m", "openai/gpt-oss-120b", "say ok"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.http400] }),
  S("nostream", "402-credit", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.http402] }),
  S("nostream", "401-auth", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.http401] }),
  S("nostream", "403-top-message", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http403TopMessage] }),
  S("nostream", "429-quota-rate", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http429Quota] }),
  S("nostream", "500-html", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.http500Html] }),
  S("nostream", "err-body-then-200", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.errBody, R.http200] }),
  S("nostream", "finish-error-retried-fatal", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.finishError] }),
  S("nostream", "choice-error", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0" }, replies: [R.choiceError] }),
  S("nostream", "finish-length-warns", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.finishLength] }),
  S("nostream", "ws-body-then-200", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "2" }, replies: [R.wsBody, R.http200] }),
  S("nostream", "ws-body-persistent", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.wsBody] }),
  S("nostream", "empty-body-persistent", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "1" }, replies: [R.emptyBody] }),
  S("nostream", "usage-file-identity-ledger", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json", IDENTITY_DIR: "ident", IDENTITY_NAME: "ada" }, replies: [R.http200Usage] }),
  S("nostream", "identity-basename-run-id", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", IDENTITY_DIR: "ident/", LLM_RUN_ID: "run-77", SHELLM_RUN_STEP_ID: "step-1" }, replies: [R.http200Usage] }),
  S("nostream", "step-id-run-id", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", SHELLM_RUN_STEP_ID: "step-1" }, replies: [R.http200Usage] }),
  S("nostream", "ledger-override", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_LEDGER: "ledger.jsonl" }, replies: [R.http200Usage] }),
  S("nostream", "ledger-devnull", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_LEDGER: "/dev/null" }, replies: [R.http200Usage] }),
  S("nostream", "no-usage-writes-empty-record", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200] }),
  S("nostream", "usage-file-stale-content-overwritten", ["--no-stream", "-m", "a/b", "hi"], { files: { "usage.json": '{"in_tok":5}\n' }, env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200] }),
  S("nostream", "cache-tok-usage-ledger", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_USAGE_FILE: "usage.json" }, replies: [R.http200UsageCache], ...dev("usage-field-shift") }),
  S("nostream", "conn-refused-http-000", ["--no-stream", "-m", "a/b", "hi"], { env: { OPENROUTER_API_KEY: "k", LLM_API_URL: "http://127.0.0.1:9/x", LLM_RETRIES: "1" } }),
  S("nostream", "max-time-http-000", ["--no-stream", "-m", "a/b", "hi"], { env: { ...OR, LLM_RETRIES: "0", LLM_MAX_TIME: "1" }, replies: [R.slow] }),

  // ---- anthropic (also opencode/Zen, same wire protocol) ----
  S("anthropic", "streaming-ok", ["-m", "claude-sonnet-4-5", "hi"], { env: ANTH, replies: [R.anthropicSseOk] }),
  S("anthropic", "payload-system-thinking-effort", ["-m", "claude-sonnet-4-5", "-s", "be terse", "--thinking", "--effort", "high", "hi"], { env: ANTH, replies: [R.anthropicSseOk] }),
  S("anthropic", "payload-messages-not-prepended", ["-m", "claude-sonnet-4-5", "-s", "S", "-M", MSGS], { env: ANTH, replies: [R.anthropicSseOk] }),
  S("anthropic", "thinking-unsupported-model-note", ["--thinking", "-m", "claude-3-opus", "hi"], { env: ANTH, replies: [R.anthropicSseOk] }),
  S("anthropic", "thinking-assume", ["--thinking", "-m", "claude-3-opus", "hi"], { env: { ...ANTH, LLM_ASSUME_THINKING: "1" }, replies: [R.anthropicSseOk] }),
  S("anthropic", "effort-no-family-guard", ["-m", "claude-3-opus", "--effort", "max", "hi"], { env: ANTH, replies: [R.anthropicSseOk] }),
  S("anthropic", "streaming-thinking-deltas", ["--thinking", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH, replies: [R.anthropicSseThinking] }),
  S("anthropic", "streaming-truncation-warns", ["-m", "claude-sonnet-4-5", "-t", "12", "hi"], { env: { ...ANTH, LLM_RETRIES: "2" }, replies: [R.anthropicSseMaxTokens] }),
  S("anthropic", "streaming-type-error-retried-then-ok", ["-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH, LLM_RETRIES: "1" }, replies: [R.anthropicSseTypeError, R.anthropicSseOk] }),
  S("anthropic", "streaming-type-error-exhausted", ["-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH, LLM_RETRIES: "0" }, replies: [R.anthropicSseTypeError] }),
  S("anthropic", "nonstream-ok", ["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: ANTH, replies: [R.anthropicJsonOk] }),
  S("anthropic", "nonstream-type-error", ["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH, LLM_RETRIES: "1" }, replies: [R.anthropicJsonError] }),
  S("anthropic", "nonstream-truncation-warns", ["--no-stream", "-m", "claude-sonnet-4-5", "-t", "12", "hi"], { env: { ...ANTH, LLM_RETRIES: "2" }, replies: [R.anthropicJsonMaxTokens] }),
  S("anthropic", "cache-tok-streaming", ["-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH, LLM_USAGE_FILE: "usage.json" }, replies: [R.anthropicSseCache] }),
  S("anthropic", "cache-tok-nonstream", ["--no-stream", "-m", "claude-sonnet-4-5", "hi"], { env: { ...ANTH, LLM_USAGE_FILE: "usage.json" }, replies: [R.anthropicJsonCache], ...dev("usage-field-shift") }),
  S("anthropic", "no-key-dies", ["-m", "claude-x", "hi"], {}),
  ...[
    "claude-opus-4-7", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-3-5-sonnet", "claude-3-opus",
  ].map((m) => S("anthropic", `maxtok-${m}`, ["--no-stream", "-m", m, "hi"], { env: ANTH, replies: [R.anthropicJsonOk] })),

  // ---- gemini ----
  S("gemini", "streaming-ok", ["-m", "gemini-2.0-flash", "hi"], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "payload-contents-role-mapping", ["-m", "gemini-2.0-flash", "-s", "be terse", "-M", MSGS], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "thinking-level-supported", ["-m", "gemini-2.0-flash", "--thinking", "high", "hi"], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "thinking-level-unsupported-warns", ["-m", "gemini-1.5-pro", "--thinking", "high", "hi"], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "bare-thinking-no-level-noop", ["--thinking", "-m", "gemini-2.0-flash", "hi"], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "effort-ignored", ["-m", "gemini-2.0-flash", "--effort", "max", "hi"], { env: GEM, replies: [R.geminiSseOk] }),
  S("gemini", "streaming-truncation-warns", ["-m", "gemini-2.0-flash", "-t", "5", "hi"], { env: { ...GEM, LLM_RETRIES: "2" }, replies: [R.geminiSseMaxTokens] }),
  S("gemini", "nonstream-ok", ["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: GEM, replies: [R.geminiJsonOk] }),
  S("gemini", "nonstream-error", ["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: { ...GEM, LLM_RETRIES: "1" }, replies: [R.geminiJsonError] }),
  S("gemini", "nonstream-truncation-warns", ["--no-stream", "-m", "gemini-2.0-flash", "-t", "5", "hi"], { env: { ...GEM, LLM_RETRIES: "2" }, replies: [R.geminiJsonMaxTokens] }),
  S("gemini", "cache-tok-streaming", ["-m", "gemini-2.0-flash", "hi"], { env: { ...GEM, LLM_USAGE_FILE: "usage.json" }, replies: [R.geminiSseCache] }),
  S("gemini", "cache-tok-nonstream", ["--no-stream", "-m", "gemini-2.0-flash", "hi"], { env: { ...GEM, LLM_USAGE_FILE: "usage.json" }, replies: [R.geminiJsonCache], ...dev("usage-field-shift") }),
  S("gemini", "no-key-dies", ["-m", "gemini-x", "hi"], {}),
  ...["gemini-2.0-flash", "gemini-3.5-flash"].map((m) => S("gemini", `maxtok-${m}`, ["--no-stream", "-m", m, "hi"], { env: GEM, replies: [R.geminiJsonOk] })),

  // ---- opencode Zen (opencode/*, Anthropic protocol; opencode-go/* is slice 1) ----
  S("opencode", "prefix-stripped-thinking-effort-dropped-with-note", ["-m", "opencode/claude-x", "--thinking", "--effort", "high", "hi"], { env: ZEN, replies: [R.anthropicSseOk] }),
  S("opencode", "no-note-without-thinking-effort", ["-m", "opencode/claude-x", "hi"], { env: ZEN, replies: [R.anthropicSseOk] }),
  S("opencode", "nonstream-error-reuses-anthropic-reader", ["--no-stream", "-m", "opencode/claude-x", "hi"], { env: { ...ZEN, LLM_RETRIES: "1" }, replies: [R.anthropicJsonError] }),
  S("opencode", "no-key-dies", ["-m", "opencode/x", "hi"], {}),

  // ---- openrouter provider routing (015d081/cf9e0ab) ----
  // Mirrors tests/test_llm_openrouter_routing.sh's own run_llm cases 1:1 —
  // same base model (openai/gpt-4o-mini, which classifies as openrouter by
  // */* detection), same keys, same isolation (a fresh cwd per scenario, no
  // ambient LLM_OR_*/LLM_PROVIDER). "provider" is a reserved key in `S()`'s
  // scenario objects (the argv builder does not use it) so the fake OpenAI
  // key is carried alongside for scenario P below (--provider openai).
  ...(() => {
    if (!BASH_LLM_HAS_OR_ROUTING) return [];
    const ORR = { OPENROUTER_API_KEY: "test-key", OPENAI_API_KEY: "test-key", LLM_API_URL: U, LLM_RETRIES: "0" };
    const M = ["-m", "openai/gpt-4o-mini"];
    return [
      S("or-routing", "no-knobs-no-provider-block", [...M, "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-only-pins", [...M, "--or-only", "openai", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-only-normalized", [...M, "--or-only", " OpenAI , Azure ,, ", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-only-normalizes-away-dies", [...M, "--or-only", " , ,", "hi"], { env: ORR }),
      S("or-routing", "or-data-collection-deny", [...M, "--or-data-collection", "deny", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-data-collection-invalid-dies", [...M, "--or-data-collection", "nope", "hi"], { env: ORR }),
      S("or-routing", "or-zdr-flag", [...M, "--or-zdr", "hi"], { env: ORR, replies: [R.sseOk] }),
      ...["true", "yes", "on", "1", "TRUE", "On"].map((v) =>
        S("or-routing", `or-zdr-env-true-${v}`, [...M, "hi"], { env: { ...ORR, LLM_OR_ZDR: v }, replies: [R.sseOk] })
      ),
      ...["false", "no", "0", "FALSE", "empty"].map((v) =>
        S("or-routing", `or-zdr-env-false-${v}`, [...M, "hi"], { env: { ...ORR, LLM_OR_ZDR: v === "empty" ? "" : v }, replies: [R.sseOk] })
      ),
      S("or-routing", "or-zdr-env-invalid-dies", [...M, "hi"], { env: { ...ORR, LLM_OR_ZDR: "maybe" } }),
      S("or-routing", "or-all-three-compose", [...M, "--or-only", "openai", "--or-data-collection", "deny", "--or-zdr", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-only-env-honored-and-announced", [...M, "hi"], { env: { ...ORR, LLM_OR_ONLY: "azure" }, replies: [R.sseOk] }),
      S("or-routing", "or-only-cli-not-announced", [...M, "--or-only", "azure", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-only-dotenv-supplies-knobs", [...M, "hi"], { files: { ".env": "LLM_OR_ONLY=fromenvfile\n" }, env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-explicit-openrouter-provider-takes-knobs", [...M, "--provider", "openrouter", "--or-only", "openai", "hi"], { env: ORR, replies: [R.sseOk] }),
      S("or-routing", "or-flag-on-other-provider-warns-no-block-no-fail", [...M, "--provider", "openai", "-m", "gpt-4o-mini", "--or-zdr", "hi"], { env: ORR, replies: [R.sseOk] }),
    ];
  })(),

  // ---- adapter ----
  S("adapter", "runs-forwards-flags-usage-ledger", ["-m", "qwen3:8b", "-s", "be brief", "-t", "512", "--no-stream", "--effort", "low", "--thinking", "high", "say ok"], {
    files: { ad: { content: ADAPTER_FIXTURE, mode: 0o755 } },
    env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "./ad", ADAPTER_USAGE: '{"in_tok":11,"out_tok":22}' },
  }),
  S("adapter", "unknown-model-16384-fallback", ["-m", "qwen3:8b", "say ok"], { files: { ad: { content: ADAPTER_FIXTURE, mode: 0o755 } }, env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "./ad" } }),
  S("adapter", "no-system-no-system-prompt-file-arg", ["-m", "x", "say ok"], { files: { ad: { content: ADAPTER_FIXTURE, mode: 0o755 } }, env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "./ad" } }),
  S("adapter", "nonzero-exit-fails-with-code", ["-m", "x", "say ok"], { files: { ad: { content: ADAPTER_FIXTURE, mode: 0o755 } }, env: { LLM_PROVIDER: "adapter", LLM_ADAPTER: "./ad", ADAPTER_RC: "3" } }),

  // ---- .env layering ----
  S("dotenv", "cwd-env-fills", ["hi"], { files: { ".env": `LLM_PROVIDER=openai-compatible\nexport LLM_API_URL="${U}"\nLLM_MODEL=cwd-model\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "home-env-fills-missing", ["hi"], { files: { ".env": "LLM_MODEL=cwd-model\n", "home/.env": `LLM_PROVIDER=openai-compatible\nLLM_API_URL='${U}'\nLLM_MODEL=home-model\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "env-wins-over-files", ["hi"], { files: { ".env": "LLM_MODEL=file-model\nLLM_API_KEY=file-key\n" }, env: { ...COMPAT, LLM_MODEL: "env-model", LLM_API_KEY: "env-key" }, replies: [R.sseOk] }),
  S("dotenv", "set-but-empty-counts-as-set", ["hi"], { files: { ".env": "LLM_MODEL=file-model\n" }, env: { ...COMPAT, LLM_MODEL: "" } }),
  S("dotenv", "cwd-env-sets-headlong-home", ["-m", "x", "hi"], { files: { ".env": "HEADLONG_HOME=alt\n", "alt/.env": `LLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, env: { HEADLONG_HOME: null }, replies: [R.sseOk] }),
  S("dotenv", "home-fallback-when-unset", ["-m", "x", "hi"], { env: { ...COMPAT, HEADLONG_HOME: null }, replies: [R.sseOk] }),
  S("dotenv", "shellm-home", ["-m", "x", "hi"], { env: { ...COMPAT, HEADLONG_HOME: null, SHELLM_HOME: "sh" }, replies: [R.sseOk] }),
];

// --- sandbox + run --------------------------------------------------------------
function subst(s, sb) {
  return s.replaceAll(U, srv.url).replaceAll("<PORT>", String(srv.port)).replaceAll("<SB>", sb);
}

function makeSandbox(sc) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "llm-parity-sb-"));
  for (const d of ["home", "homedir", "tmp"]) fs.mkdirSync(path.join(sb, d));
  for (const [rel, spec] of Object.entries(sc.files ?? {})) {
    const abs = path.join(sb, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = typeof spec === "string" ? spec : spec.content;
    fs.writeFileSync(abs, subst(content, sb), typeof spec === "string" ? {} : { mode: spec.mode });
  }
  return sb;
}

function walk(dir, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else acc.push({ rel, content: fs.readFileSync(full, "utf8") });
  }
}
function serializeState(sb) {
  const acc = [];
  walk(sb, "", acc);
  if (acc.length === 0) return "<empty sandbox>";
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

function runTool(kind, sc, sb) {
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH, // bash/jq/curl/node must resolve; PATH carries no secrets
      HOME: path.join(sb, "homedir"),
      TMPDIR: path.join(sb, "tmp"),
      HEADLONG_HOME: path.join(sb, "home"),
      LC_ALL: "C",
      LLM_RETRY_BACKOFF: "0",
    };
    for (const [k, v] of Object.entries(sc.env ?? {})) {
      if (v === null) delete env[k];
      else env[k] = subst(v, sb);
    }
    const argv = kind === "bash" ? sc.argv : [TS_LLM, ...sc.argv];
    const cmd = kind === "bash" ? BASH_LLM : process.execPath;
    const p = spawn(cmd, argv, { cwd: sb, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    const t = setTimeout(() => p.kill("SIGKILL"), 30000);
    p.on("close", (status, signal) => {
      clearTimeout(t);
      resolve({ stdout, stderr, status, signal, state: serializeState(sb) });
    });
    p.stdin.end(sc.stdin ?? "");
  });
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
function snapshotRequests() {
  return srv.requests.map((r) => ({
    method: r.method,
    url: r.url,
    contentType: r.headers["content-type"] ?? null,
    authorization: r.headers["authorization"] ?? null,
    json: canon(r.json),
  }));
}

function normalize(s, sb) {
  if (s == null) return s;
  return String(s)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(PORT_RE, "127.0.0.1:<PORT>")
    .replaceAll(BASH_LLM, "<BASH_LLM>")
    .replaceAll(TS_LLM, "<TS_LLM>")
    .replaceAll(sb, "<SB>")
    .replaceAll(HEADLONG_ROOT, "<HEADLONG_ROOT>")
    .replaceAll(REPO, "<REPO>")
    .replaceAll(HOME_DIR, "<HOME>")
    // The adapter's private sidecar dir name (bash `mktemp -d …/llm-adapter.XXXXXX`
    // vs the port's io.randomToken()) carries a differently-shaped random suffix;
    // only the recorded --system-prompt-file PATH (inside adapter_args.json) sees it.
    .replace(/llm-adapter\.[A-Za-z0-9]+/g, "llm-adapter.<RANDOM>");
}

// --- execute ------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  const out = {};
  for (const kind of ["bash", "ts"]) {
    const sb = makeSandbox(sc);
    srv.script(sc.replies ?? [R.sseOk]);
    srv.reset();
    try {
      const r = await runTool(kind, sc, sb);
      out[kind] = {
        stdout: normalize(r.stdout, sb),
        stderr: normalize(r.stderr, sb),
        status: r.status,
        signal: r.signal,
        state: normalize(r.state, sb),
        requests: normalize(JSON.stringify(snapshotRequests(), null, 1), sb),
      };
    } finally {
      fs.rmSync(sb, { recursive: true, force: true });
    }
  }
  const fields = ["stdout", "stderr", "status", "state", "requests"];
  const cmp = Object.fromEntries(fields.map((f) => [f, out.bash[f] === out.ts[f]]));
  const differing = fields.filter((f) => !cmp[f]);
  let verdict = "PARITY";
  if (differing.length > 0) {
    const d = sc.deviation ? DEVIATIONS[sc.deviation] : null;
    verdict = d && differing.every((f) => d.fields.includes(f)) ? "DEVIATION" : "PORT BUG";
  }
  results.push({ group: sc.group, name: sc.name, argv: sc.argv, deviation: sc.deviation ?? null, verdict, differing, cmp, bash: out.bash, ts: out.ts });
  process.stdout.write(`${verdict === "PARITY" ? "ok  " : verdict === "DEVIATION" ? "dev " : "BUG "} ${sc.group}/${sc.name}${differing.length ? `  [${differing.join(",")}]` : ""}\n`);
}
await srv.close();

// --- report -------------------------------------------------------------------
const total = results.length;
const parity = results.filter((r) => r.verdict === "PARITY").length;
const deviations = results.filter((r) => r.verdict === "DEVIATION").length;
const bugs = results.filter((r) => r.verdict === "PORT BUG").length;
const effective = parity + deviations;

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# llm — differential parity proof (slice 1: OpenAI-family wire path)\n\n`;
md += `Generated by \`parity/llm/run-parity.mjs\`. Real Bash tool \`headlong/bin/llm\` vs TS port \`headlong-ts/bin/llm.mjs\`, identical inputs, both against the same local fake OpenAI-compatible server (\`test/llmFakeServer.ts\`), diffed on stdout + stderr + exit code + on-disk state (health marker, ledger, usage file, temp-dir cleanup) + the requests the server received (method, path, content-type, authorization, JSON payload).\n\n`;
md += `- Run: \`node parity/llm/run-parity.mjs\` (Node ≥ 22.18; \`PARITY_BASH_LLM\` points at the Bash tool). Locale pinned \`LC_ALL=C\`, \`LLM_RETRY_BACKOFF=0\`, isolated HOME/HEADLONG_HOME/TMPDIR per run, no inherited keys.\n`;
md += `- Normalized symmetrically before compare: \`<TS>\` timestamps, \`127.0.0.1:<PORT>\`, \`<BASH_LLM>\`, \`<SB>\`. All else exact.\n\n`;
md += `## Result: ${effective}/${total} effective parity — ${parity} byte-identical, ${deviations} documented deviations, **${bugs} PORT BUGS**\n\n`;
md += `| # | group | scenario | verdict | fields differing | deviation |\n|---|---|---|---|---|---|\n`;
results.forEach((r, i) => {
  md += `| ${i + 1} | ${r.group} | ${r.name} | ${r.verdict} | ${r.differing.join(", ") || "-"} | ${r.deviation ?? "-"} |\n`;
});

md += `\n## Documented deviations\n\n`;
for (const [id, d] of Object.entries(DEVIATIONS)) {
  const n = results.filter((r) => r.verdict === "DEVIATION" && r.deviation === id).length;
  md += `### ${id} — ${d.title} (${n} scenario${n === 1 ? "" : "s"}; fields allowed to differ: ${d.fields.join(", ")})\n\n${d.text}\n\n`;
}

md += `## Mismatches (detail)\n\n`;
const fails = results.filter((r) => r.verdict !== "PARITY");
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.verdict}: ${r.group} / ${r.name}\n`;
  md += `- argv: \`${JSON.stringify(r.argv)}\`\n`;
  if (r.deviation) md += `- deviation: ${r.deviation}\n`;
  md += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  md += "```\n";
  for (const f of ["stdout", "stderr", "state", "requests"]) md += block(f, r.bash[f], r.ts[f], r.cmp[f]) + "\n";
  md += "```\n\n";
}

md += `## Notably PARITY (quirks replicated, not fixed)\n\n`;
md += `- prompt = ALL remaining argv joined by spaces once the first non-dash arg is seen (later flags included); an empty first positional still starts it.\n`;
md += `- \`--thinking\` greedily swallows the next argv (even the prompt) unless it starts with \`-\` or is empty; bare \`--thinking\` and \`--effort\` are silent no-ops on this family; \`--raw\` is ignored while streaming.\n`;
md += `- \`-M\` wins over a positional prompt (silently dropped); a non-array \`-M\` without \`-s\` is sent verbatim.\n`;
md += `- stdin prompt has ALL trailing newlines stripped; whitespace-only stdin is "No prompt".\n`;
md += `- model/provider/endpoint texts, the mismatch warning (also when \`--provider\` equals the env value), host-only URL warning (credentials/fragment stripped), \`opencode-go/\` prefix strip, typo'd-provider ordering (both warnings + the non-numeric max-tokens warning print before the die).\n`;
md += `- max-tokens table byte-for-byte via the payload (incl. \`claude-opus-4-8\` → 4096 fallback, \`max_completion_tokens\` for gpt-5*/o-series, opencode-go tiers, openai-compatible 16384 default, known names keeping their caps).\n`;
md += `- streaming: newline-only deltas, CRLF, comment lines; a streamed 4xx JSON body IS retried; whitespace-only stream body → \`API error:\` + raw lines with trailing newlines stripped; empty stream → "empty response"; a pre-data buffered line beats the stall abort as the error (\`API error: : keepalive\`); mid-stream failure after output → partial stdout, exit 1, no retry.\n`;
md += `- non-streaming: text + ONE newline; \`--raw\` raw body; missing content prints nothing at all; a non-JSON 200 crashes the Bash inside jq (exit 5, silent, no marker) where the port dies loudly — the documented jq-crash-nonjson-200 deviation, not a success; embedded errors (\`.error\`, choice \`.error\`, \`finish_reason:"error"\`) retried then fatal WITHOUT touching the health marker; whitespace/empty 200 → "whitespace-only response body"; truncation delivered + warned; \`HTTP 000\` on connection refused / LLM_MAX_TIME.\n`;
md += `- on-disk: pretty-printed health marker with kind classification (402/401/403/429 codes beat words; words as fallback; \`http_code\` number|null); compact ledger line with ts/provider/model/usage/identity/run_id (identity = IDENTITY_NAME or basename IDENTITY_DIR; run_id = LLM_RUN_ID or SHELLM_RUN_STEP_ID; \`LLM_USAGE_LEDGER=/dev/null\` disables); \`LLM_USAGE_FILE\` gets \`{}\` on a non-streaming call whose provider reports nothing (no ledger line), is left untouched by a stream without a usage chunk, and is RE-READ for the ledger (a stale pre-existing record gets ledgered — quirk kept); no temp files left behind.\n`;
md += `- .env layering: cwd \`.env\`, then the state home's \`.env\`; fill-only-missing (set-but-empty counts as set); cwd \`.env\` may set \`HEADLONG_HOME\`; \`SHELLM_HOME\` and \`$HOME/.headlong\` fallbacks.\n`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, parity, deviations, bugs, effective, results }, null, 2));

console.log(`\nllm parity: ${effective}/${total} effective (${parity} identical + ${deviations} documented deviations), ${bugs} PORT BUGS`);
process.exit(bugs === 0 ? 0 : 1);
