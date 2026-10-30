#!/usr/bin/env node
// run-parity-adversarial.mjs — INDEPENDENT adversarial differential check of the
// `llm` port (bin/llm.mjs) against the real Bash tool (headlong/bin/llm).
//
// Written by the tester, not the translator. Own fake server (raw byte control:
// status, headers, chunk timing, socket destroy, hang, BOM / invalid UTF-8 /
// NUL bodies), own scenario set harvested branch-by-branch from the Bash source
// with the seams a self-written harness tends to avoid. Both tools run on the
// same inputs in isolated sandboxes against the same server.
//
// Compared (verdict-bearing):
//   stdout   BYTES (never decoded before comparison)
//   stderr   text, normalized symmetrically (timestamps, port, paths, curl's
//            "after N ms")
//   status   exit code + signal
//   state    every file under the sandbox (health marker, ledger, usage file,
//            temp dirs), bytes; timestamps normalized
//   reqSem   the requests the server saw: method, path, content-type,
//            authorization, JSON payload (canonical key order) — the same
//            projection the translator's harness uses
// Compared (informational, reported separately):
//   wire     ALL request headers + the raw body with insignificant JSON
//            whitespace removed (keeps number literals, key order, escapes)
//
// A scenario may name a documented deviation (PARITY.md row). A mismatch is
// DEVIATION only if it is confined to that row's allowed fields (with finer
// masks where the row claims more than the field: transport-text masks only
// the marker `message`; jq-stderr-noise requires stderr equal once `jq:` lines
// are dropped). Everything else is DIVERGE.
//
// Run: node parity/llm/run-parity-adversarial.mjs   (ONLY=<regex> to filter)
//
// CLASSIFICATION (2026-10-29): WIRE / TRANSPORT FIXTURES, not model output. The own fake server here exists for raw
// byte control (status, headers, chunk timing, socket destroy, hang, BOM / invalid UTF-8 / NUL bodies); every reply
// body is a transport fixture for the `llm` tool, never text a model wrote that other logic depends on.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Scrubbed to a placeholder for release; set PARITY_BASH_LLM=/abs/path/to/
// headlong/bin/llm to reproduce the run.
const BASH_LLM = process.env.PARITY_BASH_LLM || "<HEADLONG_ROOT>/bin/llm";
// Never committed: the upstream checkout, this repo, and $HOME are scrubbed
// from every artifact (report + results) so no local absolute path leaks.
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_LLM), "..");
const HOME_DIR = os.homedir();
const scrubPath = (s) => String(s).replaceAll(BASH_LLM, "<BASH_LLM>").replaceAll(HEADLONG_ROOT, "<HEADLONG_ROOT>").replaceAll(REPO, "<REPO>").replaceAll(HOME_DIR, "<HOME>");
// PARITY_TS_LLM points at an alternative port entry (used to validate proposed
// fixes on a scratch copy without touching src/).
const TS_LLM = process.env.PARITY_TS_LLM || path.join(REPO, "bin", "llm.mjs");
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const REPORT_SUFFIX = process.env.PARITY_REPORT_SUFFIX || "";
if (!fs.existsSync(BASH_LLM)) {
  console.error(`adversarial: Bash tool not found at ${BASH_LLM}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake server ------------------------------------------------------------------
async function startServer() {
  let replies = [];
  let n = 0;
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      let json = null;
      try {
        json = JSON.parse(rawBody.toString("utf8"));
      } catch {
        json = null;
      }
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, rawBody, json });
      const reply = replies[Math.min(n, replies.length - 1)] ?? { body: "" };
      n += 1;
      void (async () => {
        if (reply.delayMs) await sleep(reply.delayMs);
        const headers = { ...(reply.headers ?? {}) };
        if (!reply.noContentType && !("Content-Type" in headers)) headers["Content-Type"] = reply.sse ? "text/event-stream" : "application/json";
        res.writeHead(reply.status ?? 200, headers);
        res.flushHeaders();
        for (const c of reply.chunks ?? []) {
          if (c.length) res.write(c);
          if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
        }
        if (reply.body !== undefined && reply.body.length) res.write(reply.body);
        if (reply.hang) return;
        if (reply.destroy) {
          await sleep(30);
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    script(r) {
      replies = r;
      n = 0;
      requests.length = 0;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
const srv = await startServer();
const U = "<URL>";
const PORT_RE = new RegExp(`127\\.0\\.0\\.1:${srv.port}\\b`, "g");

// --- reply fixtures ----------------------------------------------------------------
const sse = (body, extra = {}) => ({ sse: true, body, ...extra });
const js = (body, extra = {}) => ({ body, ...extra });
const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const R = {
  sseOk: sse(d({ choices: [{ delta: { content: "ok" } }] }) + "data: [DONE]\n"),
  http200: js('{"choices":[{"message":{"content":"ok"}}]}'),
  http200Usage: js('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":50,"completion_tokens":4}}'),
  errBodyStream: sse('{"error":{"message":"Provider returned error","code":502}}\n'),
  errBody: js('{"error":{"message":"Provider returned error","code":502}}'),
  finishLength: js('{"choices":[{"message":{"content":"truncated tex"},"finish_reason":"length"}]}'),
  sseFinishLength: sse(d({ choices: [{ delta: { content: "tx" }, finish_reason: null }] }) + d({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n"),
  hang: { sse: true, hang: true },
  hangJson: { hang: true },
};

// --- documented deviations (PARITY.md rows) -----------------------------------------
const ALL = ["stdout", "stderr", "status", "state", "reqSem"];
const DEV = {
  "bash-2q": { fields: ["stderr"], row: "llm required-flag value MISSING or EMPTY" },
  "jq-messages": { fields: ["stderr", "status"], row: "llm `-M` that jq cannot consume" },
  "transport-text": { fields: ["stderr", "state"], maskMarkerMessage: true, row: "llm transport-failure wording (streaming path)" },
  "gap-wire-path": { fields: ALL, row: "Gaps: anthropic / gemini / opencode Zen / adapter wire paths" },
  "jq-crash-nonjson-200": { fields: ["stderr", "status", "state"], dropLeakedRespTmp: true, row: "llm non-JSON 2xx body (non-streaming)" },
  "jq-stderr-noise": { fields: ["stderr"], dropJqLines: true, row: "llm unparseable SSE `data:` event" },
  "dotenv-shell": { fields: ALL, row: "llm `.env` loading (shell constructs not interpreted)" },
  // Rows added after the adversarial run (each cites its own PARITY.md row; fields are
  // exactly the ones that differ in that row's scenarios — never wider).
  "jq-crash-shape-200": { fields: ["stderr", "status", "state"], dropLeakedRespTmp: true, row: "llm 2xx JSON whose shape aborts the jq checker/extractor (non-streaming)" },
  "usage-field-shift": { fields: ["state"], row: "llm usage record with a missing leading/middle token field" },
  "M-jq-vs-json": { fields: ALL, row: "llm `-M` documents that jq and JSON.parse consume differently" },
  "nul-bytes": { fields: ["stderr", "reqSem"], row: "llm NUL bytes in the prompt / system-prompt file" },
  "dotenv-unsourceable": { fields: ALL, row: "llm `.env` the Bash loader cannot source (`KEY = v`, CRLF line endings)" },
  "dotenv-unreadable": { fields: ["stderr"], row: "llm unreadable `.env`" },
  "home-unset": { fields: ["stdout", "stderr", "status", "reqSem"], row: "llm HOME unset with no HEADLONG_HOME / SHELLM_HOME" },
  "url-no-host": { fields: ["stderr", "state"], maskMarkerMessage: true, row: "llm `LLM_API_URL` without a host (`http://`)" },
  "header-newline-key": { fields: ["stderr", "state"], maskMarkerMessage: true, row: "llm API key containing a newline" },
  "multi-doc-error-body": { fields: ["stderr", "state"], maskMarkerMessage: true, row: "llm error body holding several JSON documents" },
  "jq-number-literals": { fields: ["stdout"], row: "llm non-string content re-serialized (jq keeps number literals)" },
  "retry-knobs-non-integer": { fields: ALL, row: "llm non-integer LLM_RETRIES / LLM_RETRY_BACKOFF" },
  "raw-invalid-utf8": { fields: ["stdout"], row: "llm `--raw` body that is not valid UTF-8" },
  "usage-file-unwritable": { fields: ["stderr"], row: "llm unwritable LLM_USAGE_FILE" },
  "usage-file-multi-doc": { fields: ["state"], row: "llm stale multi-document LLM_USAGE_FILE" },
};

// --- tester's classification of every expected/observed divergence ----------------------
// FIXED    = was a real port bug (consumed behaviour differed); fix F<n> is applied in src/
//            and bin/ (PARITY.md "llm parity fixes"); the scenario is now PARITY
// DOC      = covered by a PARITY.md row (harness verdict DEVIATION; the row is printed
//            from the scenario's `dev` tag — the UNDOC rows of the first run were given
//            their own PARITY.md rows and tags, see DEV above)
// WIRE     = only the raw request bytes differ (semantic JSON equal or precision-lossy)
const TRIAGE = {
  "url/scheme-less-url": ["FIXED", "F1", "curl guesses http:// for `host:port/path`; fetch refused it → exit 1, marker other. The port now prefixes http:// on a scheme-less URL."],
  "nostream/embedded-error-trailing-newline": ["FIXED", "F2", "$(…) strips trailing newlines of the jq result; the port kept them → extra blank line on stderr."],
  "nostream/http400-message-trailing-newline": ["FIXED", "F2", "same; the health-marker `message` also differed (\"bad\\n\" vs \"bad\")."],
  "stream/error-body-message-only-newline": ["FIXED", "F2", "a message that is only newlines is empty after $(…) → Bash falls back to the raw body."],
  "nostream/error-is-string-jq-crash": ["FIXED", "F11", "jq path error in check_response → Bash set -e exit 5, NO marker; the port exited 0 + ok marker (silent success). Now dies before the marker; the exit-1-vs-5 remainder is the jq-crash-shape-200 row."],
  "nostream/choices-is-string-jq-crash": ["FIXED", "F11", "same family."],
  "nostream/choice-error-is-string": ["FIXED", "F11", "same family; the port even printed `ok`."],
  "nostream/message-is-string-extract-crash": ["FIXED", "F11", "jq path error in extract_text → Bash exit 5 after ok-marker+ledger; the port exited 0. Now an exit-code-only deviation (1 vs 5), documented as jq-crash-shape-200."],
  "nostream/bom-prefixed-body": ["FIXED", "F3", "jq accepts a leading UTF-8 BOM; JSON.parse does not → the port died where Bash answers."],
  "stream/classifier-newline-in-message": ["FIXED", "F4", "bash ERE `.` matches newline; JS `.` does not → marker kind auth vs other."],
  "stream/classifier-newline-rate": ["FIXED", "F4", "same; rate vs other."],
  "keys/latin1-key": ["FIXED", "F6", "curl sends the key as UTF-8 bytes; undici sent U+00E9 as one Latin-1 byte → different Authorization bytes reached the provider."],
  "keys/cjk-key": ["FIXED", "F6", "fetch threw (ByteString) → exit 1 where Bash sends the UTF-8 bytes and succeeds."],
  "stream/error-body-no-newline-then-destroy": ["FIXED", "F7", "bash `read` delivers an unterminated last line; the port dropped it when the body errored → kind credit became other."],
  "nostream/nbsp-only-body": ["FIXED", "F5", "grep [[:space:]] under LC_ALL=C is ASCII; JS \\s includes NBSP → the port retried as whitespace-only instead of the documented jq-crash path."],
  "argv/t-leading-zeros-warning-text": ["FIXED", "F8", "warning prints $LLM_MAX_TOKENS verbatim (`007`); the port printed the Number."],
  "argv/t-huge-int": ["FIXED", "F8", "same (99999999999999999999 vs 100000000000000000000); the wire body literal still differs (jq preserves it) — see the jq-number-literals row."],
  "dotenv/export-tab": ["FIXED", "F9", "sed's `export[[:space:]]+` accepts a tab; the port only accepted a space."],
  "stream/epipe-reader-closes-early": ["FIXED", "F10", "`llm … | head` — bash printf dies of SIGPIPE (exit 141); the port exited 1."],
  "stream/usage-object-token": ["FIXED", "F12", "jq @tsv aborts on an object cell → Bash records nothing; the port recorded the other fields."],
  "stream/marker-message-del-char": ["FIXED", "F13", "jq escapes U+007F as \\u007f; JSON.stringify left it raw → marker bytes differed (same parsed value)."],
  "argv/M-number-literals": ["WIRE", "-", "jq preserves 1.0 / 1E+2 / 12345678901234567890 in the payload; JS sends 1 / 100 / 12345678901234567000 (precision loss beyond 2^53). Invisible to any harness that re-parses the body in JS. PARITY.md row: llm non-string content re-serialized (jq keeps number literals)."],
};

// --- scenarios -------------------------------------------------------------------------
const COMPAT = { LLM_PROVIDER: "openai-compatible", LLM_API_URL: U, LLM_RETRIES: "0" };
const OA = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const OR = { OPENROUTER_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const OC = { OPENCODE_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" };
const S = (group, name, argv, extra = {}) => ({ group, name, argv, ...extra });
const dev = (id) => ({ dev: id });
const NS = ["--no-stream", "-m", "a/b", "hi"];

const scenarios = [
  // ---- calibration (must be PARITY; proves the rig) ----
  S("calib", "stream-ok", ["-m", "x", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("calib", "nostream-ok", ["--no-stream", "-m", "x", "hi"], { env: COMPAT, replies: [R.http200] }),
  S("calib", "help", ["-h"]),

  // ---- argv seams ----
  S("argv", "thinking-then-flag-bare", ["-m", "gpt-5", "--thinking", "--no-stream", "hi"], { env: OA, replies: [R.http200] }),
  S("argv", "thinking-level-then-M", ["-m", "gpt-5", "--thinking", "medium", "-M", '[{"role":"user","content":"q"}]'], { env: OA, replies: [R.sseOk] }),
  S("argv", "thinking-numeric-level", ["-m", "gpt-5", "--thinking", "5", "hi"], { env: OA, replies: [R.sseOk] }),
  S("argv", "thinking-then-help", ["--thinking", "-h"]),
  S("argv", "thinking-twice", ["-m", "gpt-5", "--thinking", "--thinking", "high", "hi"], { env: OA, replies: [R.sseOk] }),
  S("argv", "positional-swallows-M", ["-m", "x", "hi", "-M", "[]"], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "M-then-positional-then-flag", ["-m", "x", "-M", "[]", "p", "--no-stream"], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "M-ignores-stdin", ["-m", "x", "-M", '[{"role":"user","content":"m"}]'], { env: COMPAT, stdin: "from stdin\n", replies: [R.sseOk] }),
  S("argv", "double-dash", ["--", "hi"]),
  S("argv", "provider-empty", ["--provider", "", "hi"], dev("bash-2q")),
  S("argv", "maxtokens-empty", ["-t", "", "hi"], dev("bash-2q")),
  S("argv", "system-empty", ["-s", "", "hi"], dev("bash-2q")),
  S("argv", "effort-empty", ["--effort", "", "hi"], dev("bash-2q")),
  S("argv", "spf-empty", ["--system-prompt-file", "", "hi"], dev("bash-2q")),
  S("argv", "spf-dev-null", ["-m", "x", "--system-prompt-file", "/dev/null", "hi"], { env: COMPAT }),
  S("argv", "spf-directory", ["-m", "x", "--system-prompt-file", "home", "hi"], { env: COMPAT }),
  S("argv", "spf-crlf", ["-m", "x", "--system-prompt-file", "s.txt", "hi"], { files: { "s.txt": "sys\r\n\r\n" }, env: COMPAT, replies: [R.sseOk] }),
  S("argv", "spf-nul-byte", ["-m", "x", "--system-prompt-file", "s.txt", "hi"], { files: { "s.txt": Buffer.from("a\0b\n") }, env: COMPAT, replies: [R.sseOk], ...dev("nul-bytes") }),
  S("argv", "M-null-with-system", ["-m", "x", "-s", "S", "-M", "null"], { env: COMPAT, replies: [R.sseOk], ...dev("M-jq-vs-json") }),
  S("argv", "M-array-of-numbers-with-system", ["-m", "x", "-s", "S", "-M", "[1,2]"], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "M-whitespace-only", ["-m", "x", "-M", " "], { env: COMPAT, replies: [R.sseOk], ...dev("M-jq-vs-json") }),
  S("argv", "M-two-json-docs", ["-m", "x", "-M", "[1] [2]"], { env: COMPAT, replies: [R.sseOk], ...dev("M-jq-vs-json") }),
  S("argv", "M-lone-surrogate", ["-m", "x", "-M", '[{"role":"user","content":"\\ud800x"}]'], { env: COMPAT, replies: [R.sseOk], ...dev("M-jq-vs-json") }),
  S("argv", "M-number-literals", ["-m", "x", "-M", '[{"role":"user","content":"x","n":1.0,"e":1E+2,"big":12345678901234567890}]'], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "M-empty-array", ["-m", "x", "-M", "[]"], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "M-duplicate-keys", ["-m", "x", "-M", '[{"role":"user","role":"assistant","content":"x"}]'], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "prompt-whitespace-only", ["-m", "x", " "], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "t-leading-zeros-warning-text", ["-m", "x", "-t", "007", "hi"], { env: COMPAT, replies: [R.sseFinishLength] }),
  S("argv", "t-huge-int", ["-m", "x", "-t", "99999999999999999999", "hi"], { env: COMPAT, replies: [R.sseFinishLength] }),
  S("argv", "t-plus-sign", ["-m", "x", "-t", "+5", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("argv", "t-space-padded", ["-m", "x", "-t", " 5", "hi"], { env: COMPAT, replies: [R.sseOk] }),

  // ---- stdin ----
  S("stdin", "crlf", ["-m", "x"], { stdin: "a\r\nb\r\n", env: COMPAT, replies: [R.sseOk] }),
  S("stdin", "trailing-lf-cr-lf", ["-m", "x"], { stdin: "x\n\r\n", env: COMPAT, replies: [R.sseOk] }),
  S("stdin", "spaces-only", ["-m", "x"], { stdin: "   ", env: COMPAT, replies: [R.sseOk] }),
  S("stdin", "nul-bytes", ["-m", "x"], { stdin: Buffer.from("a\0b\0\n"), env: COMPAT, replies: [R.sseOk], ...dev("nul-bytes") }),
  S("stdin", "invalid-utf8", ["-m", "x"], { stdin: Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]), env: COMPAT, replies: [R.sseOk] }),
  S("stdin", "1_5MiB", ["-m", "x"], { stdin: Buffer.alloc(1536 * 1024, "y"), env: COMPAT, replies: [R.sseOk] }),
  S("stdin", "unicode-astral", ["-m", "x"], { stdin: "😀 日本 \u2028 \u007f\n", env: COMPAT, replies: [R.sseOk] }),

  // ---- .env layering ----
  S("dotenv", "space-before-equals-aborts-bash", ["hi"], { files: { ".env": `LLM_MODEL=file-model\nODD = 1\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk], ...dev("dotenv-unsourceable") }),
  S("dotenv", "crlf-file", ["hi"], { files: { ".env": `LLM_MODEL=crlf-model\r\nLLM_PROVIDER=openai-compatible\r\nLLM_API_URL=${U}\r\nLLM_RETRIES=0\r\n` }, replies: [R.sseOk], ...dev("dotenv-unsourceable") }),
  S("dotenv", "export-tab", ["hi"], { files: { ".env": `export\tLLM_MODEL=tab-model\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "export-two-spaces", ["hi"], { files: { ".env": `export  LLM_MODEL=sp-model\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "inline-comment", ["hi"], { files: { ".env": `LLM_MODEL=cm-model # note\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk], ...dev("dotenv-shell") }),
  S("dotenv", "unquoted-space-value", ["hi"], { files: { ".env": `LLM_MODEL=a b\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk], ...dev("dotenv-shell") }),
  S("dotenv", "dollar-expansion", ["hi"], { files: { ".env": `LLM_MODEL=$LLM_PROVIDER-x\nLLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk], ...dev("dotenv-shell") }),
  S("dotenv", "single-quoted-with-hash", ["hi"], { files: { ".env": `LLM_MODEL='q#model'\nLLM_PROVIDER=openai-compatible\nLLM_API_URL="${U}"\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "empty-value-counts-as-set", ["hi"], { files: { ".env": "LLM_MODEL=\n" }, env: { ...COMPAT, SHELLM_MODEL: "shm" }, replies: [R.sseOk] }),
  S("dotenv", "duplicate-key-last-wins", ["hi"], { files: { ".env": `LLM_MODEL=one\nLLM_MODEL=two\n` }, env: COMPAT, replies: [R.sseOk] }),
  S("dotenv", "home-headlong-dotenv-fallback", ["-m", "x", "hi"], { files: { "homedir/.headlong/.env": `LLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, env: { HEADLONG_HOME: null }, replies: [R.sseOk] }),
  S("dotenv", "shellm-home-dotenv", ["-m", "x", "hi"], { files: { "sh/.env": `LLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, env: { HEADLONG_HOME: null, SHELLM_HOME: "sh" }, replies: [R.sseOk] }),
  S("dotenv", "headlong-home-empty-falls-to-shellm-home", ["-m", "x", "hi"], { files: { "sh/.env": `LLM_PROVIDER=openai-compatible\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, env: { HEADLONG_HOME: "", SHELLM_HOME: "sh" }, replies: [R.sseOk] }),
  S("dotenv", "env-empty-key-not-filled", ["hi"], { files: { ".env": "LLM_MODEL=cwd\n", "home/.env": "LLM_MODEL=home\nLLM_API_KEY=home-key\n" }, env: { ...COMPAT, LLM_API_KEY: "" }, replies: [R.sseOk] }),
  S("dotenv", "provider-from-file-warns-mismatch", ["-m", "claude-x", "hi"], { files: { ".env": `LLM_PROVIDER=openai\nOPENAI_API_KEY=k\nLLM_API_URL=${U}\nLLM_RETRIES=0\n` }, replies: [R.sseOk] }),
  S("dotenv", "unreadable-file", ["-m", "x", "hi"], { files: { ".env": { content: "LLM_MODEL=secret\n", mode: 0 } }, env: COMPAT, replies: [R.sseOk], ...dev("dotenv-unreadable") }),
  S("dotenv", "home-unset-no-headlong-home", ["-m", "x", "hi"], { env: { ...COMPAT, HOME: null, HEADLONG_HOME: null }, replies: [R.sseOk], ...dev("home-unset") }),

  // ---- model / provider / warnings / die texts ----
  S("provider", "opencode-go-provider-no-prefix", ["--provider", "opencode-go", "-m", "glm-5", "hi"], { env: OC, replies: [R.sseOk] }),
  S("provider", "opencode-go-double-prefix", ["-m", "opencode-go/opencode-go/x", "hi"], { env: OC, replies: [R.sseOk] }),
  S("provider", "openai-flag-with-opencode-go-name", ["--provider", "openai", "-m", "opencode-go/x", "hi"], { env: OA, replies: [R.sseOk] }),
  S("provider", "env-openrouter-vs-gpt-warns", ["-m", "gpt-4o", "hi"], { env: { LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "env-compat-vs-claude-warns", ["-m", "claude-x", "hi"], { env: COMPAT, replies: [R.sseOk] }),
  S("provider", "env-provider-empty-string", ["-m", "x", "hi"], { env: { LLM_PROVIDER: "", LLM_API_URL: U } }),
  S("provider", "flag-provider-bogus", ["--provider", "bogus", "-m", "x", "hi"], { env: { LLM_API_URL: U } }),
  S("provider", "shellm-model-with-slash-default", ["hi"], { env: { SHELLM_MODEL: "v/m", OPENROUTER_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "key-empty-string-skips-default", ["hi"], { env: { OPENAI_API_KEY: "", OPENROUTER_API_KEY: "k", LLM_API_URL: U, LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("provider", "no-key-openai-after-thinking-note", ["-m", "gpt-4o", "--thinking", "low", "hi"]),
  S("provider", "model-with-newline", ["-m", "a\nb/c", "hi"], { env: OR, replies: [R.sseOk] }),
  S("url", "scheme-less-url", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_URL: "127.0.0.1:<PORT>/v1/chat/completions" }, replies: [R.sseOk] }),
  S("url", "empty-host-warning", ["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: "http://", LLM_RETRIES: "0" }, ...dev("url-no-host") }),
  S("url", "at-in-path", ["-m", "gpt-4o", "hi"], { env: { OPENAI_API_KEY: "k", LLM_API_URL: "http://127.0.0.1:<PORT>/v1/chat/completions@x", LLM_RETRIES: "0" }, replies: [R.sseOk] }),
  S("url", "userinfo-plus-bearer", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: "bear", LLM_API_URL: "http://u:p@127.0.0.1:<PORT>/v1/chat/completions" }, replies: [R.sseOk] }),
  S("url", "userinfo-percent-encoded", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_URL: "http://us%40er:p%3Ass@127.0.0.1:<PORT>/v1/chat/completions" }, replies: [R.sseOk] }),
  S("url", "query-and-fragment-path", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_URL: "http://127.0.0.1:<PORT>/v1/chat/completions?k=v#frag" }, replies: [R.sseOk] }),
  S("keys", "latin1-key", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: "s\u00e9k" }, replies: [R.sseOk] }),
  S("keys", "cjk-key", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: "\u65e5\u672c" }, replies: [R.sseOk] }),
  S("keys", "newline-key", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: "a\nb" }, replies: [R.sseOk], ...dev("header-newline-key") }),
  S("keys", "quote-backslash-key", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: 'se"k\\rit' }, replies: [R.sseOk] }),
  S("keys", "space-padded-key", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_API_KEY: " k " }, replies: [R.sseOk] }),

  // ---- max-tokens table (payload max_tokens / max_completion_tokens) ----
  ...[
    ["claude-opus-4", COMPAT], ["claude-opus-4-1-20250805", COMPAT], ["claude-3-7-sonnet", COMPAT], ["claude-sonnet-4-0", COMPAT], ["claude-haiku-4-0", COMPAT], ["claude-3-haiku", COMPAT],
    ["gpt-4o-2024-08-06", OA], ["gpt-4-turbo-preview", OA], ["gpt-4.1-mini", OA], ["gpt-35-turbo", OA], ["gpt-5-nano", OA], ["GPT-5", OA], ["o1-preview", OA], ["o3", OA], ["o4-mini-high", OA],
    ["chatgpt-4o-latest", OA], ["o0-x", COMPAT], ["gemini-2.0-flash-lite", COMPAT], ["gemini-2.5-pro", COMPAT], ["gemini-1.5-pro", COMPAT], ["anthropic/claude-3-haiku", OR], ["x-ai/grok-4.6", OR],
    ["x-ai/grok-code-fast", OR], ["xai/grok-4", OR], ["a/b/c", OR], ["meta-llama/llama-3", OR], ["qwen3:8b", OA], ["my-alias", OA],
  ].map(([m, env]) => S("maxtok", `t-${m.replace(/[^a-z0-9]+/gi, "-")}`, ["--no-stream", "-m", m, "hi"], { env, replies: [R.http200] })),
  ...["kimi-k2.5", "qwen", "minimax-m2.1", "deepseek-v4", "grok-code-fast", "longcat-flash", "mimo-v2", "hy3", "muse-spark", "ox-alpha-2", "glm", "claude-x", "gpt-4o", "GLM-5"].map((m) =>
    S("maxtok", `og-${m.replace(/[^a-z0-9]+/gi, "-")}`, ["--no-stream", "-m", `opencode-go/${m}`, "hi"], { env: OC, replies: [R.http200] })
  ),
  S("maxtok", "gpt-5-via-provider-flag-opencode-go", ["--no-stream", "--provider", "opencode-go", "-m", "gpt-5", "hi"], { env: OC, replies: [R.http200] }),
  S("maxtok", "env-max-tokens-zero", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TOKENS: "0" }, replies: [R.sseOk] }),
  S("maxtok", "env-max-tokens-negative", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TOKENS: "-5" }, replies: [R.sseOk] }),

  // ---- payload ----
  S("payload", "o3-thinking-nostream", ["--no-stream", "-m", "o3", "--thinking", "high", "hi"], { env: OA, replies: [R.http200] }),
  S("payload", "gpt-6-reasoning-but-max_tokens", ["-m", "gpt-6", "--thinking", "xhigh", "hi"], { env: OA, replies: [R.sseOk] }),
  S("payload", "gpt-5-5-thinking-none", ["-m", "gpt-5.5", "--thinking", "none", "hi"], { env: OA, replies: [R.sseOk] }),
  S("payload", "o0-thinking-ignored", ["-m", "o0-x", "--thinking", "low", "hi"], { env: OA, replies: [R.sseOk] }),
  S("payload", "assume-thinking-true-not-1", ["-m", "gpt-4o", "--thinking", "low", "hi"], { env: { ...OA, LLM_ASSUME_THINKING: "true" }, replies: [R.sseOk] }),
  S("payload", "effort-and-thinking", ["-m", "gpt-5", "--effort", "max", "--thinking", "high", "hi"], { env: OA, replies: [R.sseOk] }),
  S("payload", "system-multiline-unicode-M-roles", ["-m", "x", "-s", "l1\nl2 \u00e9 \"q\" \\", "-M", '[{"role":"assistant","content":"a"},{"role":"tool","content":"t","tool_call_id":"1"}]'], { env: COMPAT, replies: [R.sseOk] }),
  S("payload", "prompt-control-chars", ["-m", "x", "a\tb\u0001c\u007fd"], { env: COMPAT, replies: [R.sseOk] }),

  // ---- streaming ----
  S("stream", "http500-with-sse-body-succeeds", ["-m", "x", "hi"], { env: COMPAT, replies: [{ ...R.sseOk, status: 500 }] }),
  S("stream", "http302-with-sse-body", ["-m", "x", "hi"], { env: COMPAT, replies: [{ ...R.sseOk, status: 302, headers: { Location: "http://127.0.0.1:1/x" } }] }),
  S("stream", "json-content-type-header", ["-m", "x", "hi"], { env: COMPAT, replies: [{ ...R.sseOk, headers: { "Content-Type": "application/json" } }] }),
  S("stream", "no-content-type", ["-m", "x", "hi"], { env: COMPAT, replies: [{ ...R.sseOk, noContentType: true }] }),
  S("stream", "no-trailing-newline-clean-end", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":"end"}}]}')] }),
  S("stream", "error-body-no-newline-then-destroy", ["-m", "x", "hi"], { env: COMPAT, replies: [{ sse: true, chunks: ['{"error":{"message":"Insufficient credits"}}'], destroy: true }] }),
  S("stream", "error-body-newline-then-destroy", ["-m", "x", "hi"], { env: COMPAT, replies: [{ sse: true, chunks: ['{"error":{"message":"Insufficient credits"}}\n'], destroy: true }] }),
  S("stream", "error-body-pretty-multiline", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{\n  "error": {\n    "message": "pretty err"\n  }\n}\n')] }),
  S("stream", "error-body-two-docs", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"one"}}\n{"error":{"message":"two"}}\n')], ...dev("multi-doc-error-body") }),
  S("stream", "error-body-message-number", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":42}}\n')] }),
  S("stream", "error-body-error-is-string", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":"plain string"}\n')] }),
  S("stream", "error-body-message-trailing-newline", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"bad\\n\\n"}}\n')] }),
  S("stream", "error-body-message-only-newline", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"\\n"}}\n')] }),
  S("stream", "http4xx-html-body", ["-m", "x", "hi"], { env: COMPAT, replies: [{ sse: true, status: 403, headers: { "Content-Type": "text/html" }, body: "<html>\n<b>nope</b>\n</html>\n" }] }),
  S("stream", "http5xx-json-error-retried", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_RETRIES: "1" }, replies: [{ ...R.errBodyStream, status: 503 }, R.sseOk] }),
  S("stream", "delta-content-object-literal-1_0", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":{"k":1.0}}}]}\n')], ...dev("jq-number-literals") }),
  S("stream", "delta-content-object", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":{"k":1,"a":[]}}}]}\n')] }),
  S("stream", "delta-content-number-and-bool", ["-m", "x", "hi"], { env: COMPAT, replies: [sse(d({ choices: [{ delta: { content: 5 } }] }) + d({ choices: [{ delta: { content: false } }] }) + d({ choices: [{ delta: { content: true } }] }))] }),
  S("stream", "delta-choices-is-string-jq-path-error", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":"str"}\n' + d({ choices: [{ delta: { content: "ok" } }] })), R.sseOk], ...dev("jq-stderr-noise") }),
  S("stream", "delta-choices-object-numeric-key", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":{"0":{"delta":{"content":"no"}}}}\n' + d({ choices: [{ delta: { content: "ok" } }] }))], ...dev("jq-stderr-noise") }),
  S("stream", "done-with-trailing-space", ["-m", "x", "hi"], { env: COMPAT, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + "data: [DONE] \n")], ...dev("jq-stderr-noise") }),
  S("stream", "data-empty-json", ["-m", "x", "hi"], { env: COMPAT, replies: [sse("data: \n" + d({ choices: [{ delta: { content: "ok" } }] }))] }),
  S("stream", "double-cr", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":"ok"}}]}\r\r\n')] }),
  S("stream", "finish-length-spaced", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":"t"},"finish_reason": "length"}]}\n')] }),
  S("stream", "finish-length-no-content-retries", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_RETRIES: "1" }, replies: [sse('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n')] }),
  S("stream", "finish-reason-null-spaced", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason": null}]}\n')] }),
  S("stream", "usage-missing-prompt-tokens-shift", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } } }))], ...dev("usage-field-shift") }),
  S("stream", "usage-missing-completion-tokens-shift", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { prompt_tokens: 120, completion_tokens_details: { reasoning_tokens: 3 } } }))], ...dev("usage-field-shift") }),
  S("stream", "usage-object-token", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { prompt_tokens: { x: 1 }, completion_tokens: 5 } }))] }),
  S("stream", "usage-string-and-float-tokens", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { prompt_tokens: "12", completion_tokens: 1.5, completion_tokens_details: { reasoning_tokens: -1 } } }))] }),
  S("stream", "usage-two-events-last-wins", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }) + d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }))] }),
  S("stream", "usage-null-spaced", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse('data: {"choices":[{"delta":{"content":"ok"}}],"usage": null}\n')] }),
  S("stream", "usage-is-string", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse('data: {"choices":[{"delta":{"content":"ok"}}],"usage":"str"}\n')], ...dev("jq-stderr-noise") }),
  S("stream", "usage-then-fail-no-ledger", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }))] }),
  S("stream", "unicode-split-across-chunks", ["-m", "x", "hi"], { env: COMPAT, replies: [{ sse: true, chunks: [Buffer.from('data: {"choices":[{"delta":{"content":"caf\u00e9"}}]}\n\n').subarray(0, 40), Buffer.from('data: {"choices":[{"delta":{"content":"caf\u00e9"}}]}\n\n').subarray(40)], chunkDelayMs: 30 }] }),
  S("stream", "max-time-slow-start", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TIME: "1" }, replies: [{ ...R.sseOk, delayMs: 2500 }], ...dev("transport-text") }),
  S("stream", "stall-after-partial-output", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100", LLM_RETRIES: "2" }, replies: [{ sse: true, chunks: [d({ choices: [{ delta: { content: "part" } }] })], hang: true }], ...dev("transport-text") }),
  S("stream", "speed-guard-disabled-by-zero", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "0", LLM_MAX_TIME: "2" }, replies: [{ sse: true, chunks: [": k\n"], hang: true }], ...dev("transport-text") }),
  S("stream", "classifier-newline-in-message", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"invalid\\nkey"}}\n')] }),
  S("stream", "classifier-newline-rate", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"rate\\nlimit"}}\n')] }),
  S("stream", "marker-message-del-char", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"a\\u007fb"}}\n')] }),
  S("stream", "marker-message-unicode", ["-m", "x", "hi"], { env: COMPAT, replies: [sse('{"error":{"message":"caf\u00e9 <&> \\u2028 /"}}\n')] }),
  S("stream", "retries-08-octal", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_RETRIES: "08" }, replies: [R.errBodyStream], ...dev("retry-knobs-non-integer") }),
  S("stream", "backoff-float", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_RETRIES: "1", LLM_RETRY_BACKOFF: "1.5" }, replies: [R.errBodyStream], ...dev("retry-knobs-non-integer") }),
  S("stream", "backoff-word", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_RETRIES: "1", LLM_RETRY_BACKOFF: "abc" }, replies: [R.errBodyStream, R.sseOk], ...dev("retry-knobs-non-integer") }),
  S("stream", "max-time-non-numeric-disabled", ["-m", "x", "hi"], { env: { ...COMPAT, LLM_MAX_TIME: "abc" }, replies: [R.sseOk] }),
  S("stream", "raw-with-usage", ["-m", "x", "--raw", "hi"], { env: { ...COMPAT, LLM_USAGE_FILE: "u.json" }, replies: [sse(d({ choices: [{ delta: { content: "ok" } }] }) + d({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }))] }),
  S("stream", "epipe-reader-closes-early", ["-m", "x", "hi"], { env: COMPAT, replies: [{ sse: true, chunks: Array.from({ length: 40 }, () => d({ choices: [{ delta: { content: "xxxxxxxxxx" } }] })), chunkDelayMs: 10 }], wrap: true }),

  // ---- non-streaming ----
  S("nostream", "error-is-string-jq-crash", NS, { env: OR, replies: [js('{"error":"plain string"}')], ...dev("jq-crash-shape-200") }),
  S("nostream", "choices-is-string-jq-crash", NS, { env: OR, replies: [js('{"choices":"str"}')], ...dev("jq-crash-shape-200") }),
  S("nostream", "message-is-string-extract-crash", NS, { env: OR, replies: [js('{"choices":[{"message":"hi"}]}')], ...dev("jq-crash-shape-200") }),
  S("nostream", "choice-error-is-string", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":"ok"},"error":"str"}]}')], ...dev("jq-crash-shape-200") }),
  S("nostream", "bom-prefixed-body", NS, { env: OR, replies: [js(Buffer.from('\ufeff{"choices":[{"message":{"content":"bom-ok"}}]}'))] }),
  S("nostream", "nbsp-only-body", NS, { env: { ...OR, LLM_RETRIES: "1" }, replies: [js(Buffer.from("\u00a0\u00a0"))], ...dev("jq-crash-nonjson-200") }),
  S("nostream", "raw-invalid-utf8-body", ["--no-stream", "--raw", "-m", "a/b", "hi"], { env: OR, replies: [js(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))], ...dev("raw-invalid-utf8") }),
  S("nostream", "content-array-of-parts", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":[{"type":"text","text":"hi"},{"e":{}}]}}]}')] }),
  S("nostream", "content-array-literal-1_0", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":[{"n":1.0}]}}]}')], ...dev("jq-number-literals") }),
  S("nostream", "content-number-zero", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":0}}]}')] }),
  S("nostream", "content-false", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":false}}]}')] }),
  S("nostream", "content-empty-string", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":""}}]}')] }),
  S("nostream", "content-del-and-unicode", NS, { env: OR, replies: [js('{"choices":[{"message":{"content":"a\\u007fb caf\u00e9 \\u2028"}}]}')] }),
  S("nostream", "embedded-error-trailing-newline", NS, { env: OR, replies: [js('{"error":{"message":"oops\\n"}}')] }),
  S("nostream", "http400-message-trailing-newline", NS, { env: OR, replies: [js('{"error":{"message":"bad\\n"}}', { status: 400 })] }),
  S("nostream", "http400-error-and-message", NS, { env: OR, replies: [js('{"error":{"message":"x"},"message":"y"}', { status: 400 })] }),
  S("nostream", "http400-error-empty-object", NS, { env: OR, replies: [js('{"error":{},"message":"y"}', { status: 400 })] }),
  S("nostream", "http400-error-string", NS, { env: OR, replies: [js('{"error":"s"}', { status: 400 })] }),
  S("nostream", "http400-message-empty-string", NS, { env: OR, replies: [js('{"error":{"message":""}}', { status: 400 })] }),
  S("nostream", "http400-message-false", NS, { env: OR, replies: [js('{"error":{"message":false}}', { status: 400 })] }),
  S("nostream", "http400-message-zero", NS, { env: OR, replies: [js('{"error":{"message":0}}', { status: 400 })] }),
  S("nostream", "http400-message-object", NS, { env: OR, replies: [js('{"error":{"message":{"a":1}}}', { status: 400 })] }),
  S("nostream", "http400-two-docs", NS, { env: OR, replies: [js('{"error":{"message":"one"}}\n{"error":{"message":"two"}}', { status: 400 })], ...dev("multi-doc-error-body") }),
  S("nostream", "http201-ok", NS, { env: OR, replies: [{ ...R.http200, status: 201 }] }),
  S("nostream", "http204-empty", NS, { env: OR, replies: [{ status: 204 }] }),
  S("nostream", "http302-json-body", NS, { env: OR, replies: [{ ...R.http200, status: 302, headers: { Location: "http://127.0.0.1:1/x" } }] }),
  S("nostream", "http408-retried", NS, { env: { ...OR, LLM_RETRIES: "1" }, replies: [js('{"error":{"message":"t"}}', { status: 408 }), R.http200] }),
  S("nostream", "http599-retried-then-fatal", NS, { env: { ...OR, LLM_RETRIES: "1" }, replies: [js("boom", { status: 599 })] }),
  S("nostream", "destroy-mid-body", NS, { env: { ...OR, LLM_RETRIES: "1" }, replies: [{ chunks: ['{"choices":[{"message":{"con'], destroy: true }, R.http200] }),
  S("nostream", "headers-then-hang-speed-guard", NS, { env: { ...OR, LLM_SPEED_TIME: "1", LLM_SPEED_LIMIT: "100" }, replies: [R.hangJson] }),
  S("nostream", "headers-then-hang-max-time", NS, { env: { ...OR, LLM_MAX_TIME: "1" }, replies: [R.hangJson] }),
  S("nostream", "usage-think-tokens", NS, { env: { ...OR, LLM_USAGE_FILE: "u.json" }, replies: [js('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":3}}}')] }),
  S("nostream", "usage-missing-prompt-tokens-shift", NS, { env: { ...OR, LLM_USAGE_FILE: "u.json" }, replies: [js('{"choices":[{"message":{"content":"ok"}}],"usage":{"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}')], ...dev("usage-field-shift") }),
  S("nostream", "usage-is-string-no-record", NS, { env: { ...OR, LLM_USAGE_FILE: "u.json" }, files: { "u.json": '{"in_tok":9}\n' }, replies: [js('{"choices":[{"message":{"content":"ok"}}],"usage":"s"}')] }),
  S("nostream", "usage-file-missing-dir", NS, { env: { ...OR, LLM_USAGE_FILE: "nodir/u.json" }, replies: [R.http200Usage], ...dev("usage-file-unwritable") }),
  S("nostream", "usage-file-stale-empty-object", ["-m", "a/b", "hi"], { env: { ...OR, LLM_USAGE_FILE: "u.json" }, files: { "u.json": "{}\n" }, replies: [R.sseOk] }),
  S("nostream", "usage-file-stale-array", ["-m", "a/b", "hi"], { env: { ...OR, LLM_USAGE_FILE: "u.json" }, files: { "u.json": "[1]\n" }, replies: [R.sseOk] }),
  S("nostream", "usage-file-stale-two-docs", ["-m", "a/b", "hi"], { env: { ...OR, LLM_USAGE_FILE: "u.json" }, files: { "u.json": '{"a":1}\n{"b":2}\n' }, replies: [R.sseOk], ...dev("usage-file-multi-doc") }),
  S("nostream", "usage-file-stale-with-ts-key", ["-m", "a/b", "hi"], { env: { ...OR, LLM_USAGE_FILE: "u.json" }, files: { "u.json": '{"provider":"stale","in_tok":1}\n' }, replies: [R.sseOk] }),
  S("nostream", "ledger-precedence-override-beats-identity", NS, { env: { ...OR, LLM_USAGE_LEDGER: "led.jsonl", IDENTITY_DIR: "ident" }, replies: [R.http200Usage] }),
  S("nostream", "ledger-identity-beats-home", NS, { env: { ...OR, IDENTITY_DIR: "ident" }, replies: [R.http200Usage] }),
  S("nostream", "ledger-identity-name-empty-uses-basename", NS, { env: { ...OR, IDENTITY_DIR: "a/b/", IDENTITY_NAME: "" }, replies: [R.http200Usage] }),
  S("nostream", "ledger-run-id-empty-falls-to-step", NS, { env: { ...OR, LLM_RUN_ID: "", SHELLM_RUN_STEP_ID: "s1" }, replies: [R.http200Usage] }),
  S("nostream", "two-calls-marker-overwritten-ledger-appended", NS, { env: OR, replies: [R.http200Usage], twice: true }),
  S("nostream", "raw-with-http-error-not-printed", ["--no-stream", "--raw", "-m", "a/b", "hi"], { env: OR, replies: [js('{"error":{"message":"e"}}', { status: 400 })] }),
  S("nostream", "raw-embedded-error", ["--no-stream", "--raw", "-m", "a/b", "hi"], { env: OR, replies: [R.errBody] }),

  // ---- health-marker classification matrix ----
  ...[400, 401, 402, 403, 404, 408, 409, 418, 422, 429, 451, 500, 502, 503, 504].map((c) =>
    S("marker", `code-${c}-words-say-credit`, NS, { env: OR, replies: [js('{"error":{"message":"insufficient credits; invalid api key; rate limit"}}', { status: c })] })
  ),
  ...[
    "credit", "billing", "insufficient", "quota", "balance", "payment", "funds", "budget", "invalid api key", "invalid_key", "invalid-xyz-key", "authentication", "unauthorized",
    "api-key", "api_key", "apikey", "forbidden", "permission", "rate limit", "rate_limit", "ratelimit", "too many requests", "too-many-requests", "overloaded", "Rate Limit",
    "QUOTA EXCEEDED", "unauthorized quota", "overloaded forbidden", "nothing here", "cr\u00e9dit", "\u212aey invalid", "",
  ].map((w) => S("marker", `word-${w.replace(/[^a-z0-9]+/gi, "-") || "empty"}`, NS, { env: OR, replies: [js(JSON.stringify({ error: { message: w } }), { status: 400 })] })),
  ...["insufficient funds", "no api key", "overloaded", "meh"].map((w) => S("marker", `stream-word-${w.replace(/[^a-z0-9]+/gi, "-")}`, ["-m", "x", "hi"], { env: COMPAT, replies: [sse(JSON.stringify({ error: { message: w } }) + "\n")] })),
];

// --- sandbox + run --------------------------------------------------------------------
function subst(s, sb) {
  return s.replaceAll(U, srv.url).replaceAll("<PORT>", String(srv.port)).replaceAll("<SB>", sb);
}
function makeSandbox(sc, kind) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "llm-adv-"));
  for (const dir of ["home", "homedir", "tmp"]) fs.mkdirSync(path.join(sb, dir));
  for (const [rel, spec] of Object.entries(sc.files ?? {})) {
    const abs = path.join(sb, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = Buffer.isBuffer(spec) ? spec : typeof spec === "string" ? subst(spec, sb) : Buffer.isBuffer(spec.content) ? spec.content : subst(spec.content, sb);
    fs.writeFileSync(abs, content, typeof spec === "object" && !Buffer.isBuffer(spec) && spec.mode !== undefined ? { mode: spec.mode } : {});
  }
  if (sc.wrap) {
    const tool = kind === "bash" ? `exec ${JSON.stringify(BASH_LLM)} "$@"` : `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(TS_LLM)} "$@"`;
    fs.writeFileSync(path.join(sb, "tool.sh"), `#!/bin/bash\n${tool}\n`, { mode: 0o755 });
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
    else if (rel !== "tool.sh") {
      let content;
      try {
        content = fs.readFileSync(full);
      } catch {
        content = Buffer.from("<unreadable>");
      }
      acc.push({ rel, content });
    }
  }
}
function bytesToText(buf) {
  const s = buf.toString("utf8");
  return Buffer.from(s, "utf8").equals(buf) ? s : `<bytes hex ${buf.toString("hex")}>`;
}
function serializeState(sb) {
  const acc = [];
  walk(sb, "", acc);
  if (acc.length === 0) return "<empty sandbox>";
  return acc.map((f) => `FILE ${f.rel}\n${bytesToText(f.content)}`).join("\n----\n");
}
function runTool(kind, sc, sb) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: path.join(sb, "homedir"), TMPDIR: path.join(sb, "tmp"), HEADLONG_HOME: path.join(sb, "home"), LC_ALL: "C", LLM_RETRY_BACKOFF: "0" };
    for (const [k, v] of Object.entries(sc.env ?? {})) {
      if (v === null) delete env[k];
      else env[k] = subst(v, sb);
    }
    let cmd, argv;
    if (sc.wrap) {
      cmd = "/bin/bash";
      argv = ["-c", 'exec 3>&2; "$0" "$@" 2>&3 | head -c 2 >/dev/null; echo "rc=${PIPESTATUS[0]}"', path.join(sb, "tool.sh"), ...sc.argv];
    } else {
      cmd = kind === "bash" ? BASH_LLM : process.execPath;
      argv = kind === "bash" ? sc.argv : [TS_LLM, ...sc.argv];
    }
    const p = spawn(cmd, argv, { cwd: sb, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    p.stdout.on("data", (b) => out.push(b));
    p.stderr.on("data", (b) => err.push(b));
    p.stdin.on("error", () => {});
    const t = setTimeout(() => p.kill("SIGKILL"), 20000);
    p.on("close", (status, signal) => {
      clearTimeout(t);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), status, signal });
    });
    p.stdin.end(sc.stdin ?? "");
  });
}

// --- comparison ----------------------------------------------------------------------
function norm(s, sb) {
  return String(s)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(PORT_RE, "127.0.0.1:<PORT>")
    .replaceAll(BASH_LLM, "<BASH_LLM>")
    .replaceAll(TS_LLM, "<TS_LLM>")
    .replaceAll(sb, "<SB>")
    .replaceAll(HEADLONG_ROOT, "<HEADLONG_ROOT>")
    .replaceAll(REPO, "<REPO>")
    .replaceAll(HOME_DIR, "<HOME>")
    .replace(/after \d+ ms/g, "after <N> ms");
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
/** Drop JSON whitespace outside strings; keeps number literals, key order, escapes. */
function minifyJson(s) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") out += c;
  }
  return out;
}
function snapshot(sb) {
  const sem = srv.requests.map((r) => ({ method: r.method, url: r.url, contentType: r.headers["content-type"] ?? null, authorization: r.headers["authorization"] ?? null, json: canon(r.json) }));
  const wire = srv.requests.map((r) => {
    const h = { ...r.headers };
    delete h["host"]; // port only
    return { headers: Object.fromEntries(Object.keys(h).sort().map((k) => [k, h[k]])), body: minifyJson(bytesToText(r.rawBody)) };
  });
  return { sem: norm(JSON.stringify(sem, null, 1), sb), wire: norm(JSON.stringify(wire, null, 1), sb) };
}
// Upstream's non-streaming path keeps the body in `local_resp=$(mktemp)` ($TMPDIR/tmp.XXXXXXXXXX), which
// _llm_cleanup does not remove; when a jq checker aborts the script under `set -e` the file stays behind.
// The port writes no temp file. A state difference is covered only when dropping exactly that leaked file
// from the Bash side makes the two states identical.
function dropLeakedRespTmp(state) {
  if (state === "<empty sandbox>") return state;
  const kept = state.split("\n----\n").filter((e) => !/^FILE tmp\/tmp\.[A-Za-z0-9]{10}\n/.test(e));
  return kept.length === 0 ? "<empty sandbox>" : kept.join("\n----\n");
}
function maskMarkerMessage(state) {
  return state.replace(/"message": ".*"/g, '"message": "<MASKED>"');
}
function dropJq(stderr) {
  return stderr
    .split("\n")
    .filter((l) => !l.startsWith("jq: "))
    .join("\n");
}

// --- execute -----------------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  if (ONLY && !ONLY.test(`${sc.group}/${sc.name}`)) continue;
  const out = {};
  for (const kind of ["bash", "ts"]) {
    const sb = makeSandbox(sc, kind);
    srv.script(sc.replies ?? [R.sseOk]);
    try {
      let r = await runTool(kind, sc, sb);
      if (sc.twice) {
        const r1 = r;
        r = await runTool(kind, sc, sb);
        r.stdout = Buffer.concat([r1.stdout, Buffer.from("\n<second run>\n"), r.stdout]);
        r.stderr = Buffer.concat([r1.stderr, Buffer.from("\n<second run>\n"), r.stderr]);
      }
      const snap = snapshot(sb);
      out[kind] = {
        stdout: r.stdout,
        stdoutText: norm(bytesToText(r.stdout), sb),
        stderr: norm(bytesToText(r.stderr), sb),
        status: `${r.status}${r.signal ? "/" + r.signal : ""}`,
        state: norm(serializeState(sb), sb),
        reqSem: snap.sem,
        wire: snap.wire,
      };
    } finally {
      fs.rmSync(sb, { recursive: true, force: true });
    }
  }
  const b = out.bash;
  const t = out.ts;
  const cmp = {
    stdout: b.stdout.equals(t.stdout),
    stderr: b.stderr === t.stderr,
    status: b.status === t.status,
    state: b.state === t.state,
    reqSem: b.reqSem === t.reqSem,
  };
  const wireSame = b.wire === t.wire;
  let wireBodySame = true;
  let wireHeaderKeys = [];
  try {
    const wa = JSON.parse(b.wire);
    const wb = JSON.parse(t.wire);
    if (wa.length !== wb.length) wireBodySame = false;
    for (let i = 0; i < Math.min(wa.length, wb.length); i++) {
      if (wa[i].body !== wb[i].body) wireBodySame = false;
      for (const k of new Set([...Object.keys(wa[i].headers), ...Object.keys(wb[i].headers)])) if (wa[i].headers[k] !== wb[i].headers[k] && !wireHeaderKeys.includes(k)) wireHeaderKeys.push(k);
    }
  } catch {
    wireBodySame = wireSame;
  }
  const differing = ALL.filter((f) => !cmp[f]);
  let verdict = "PARITY";
  let covered = false;
  if (differing.length > 0) {
    const dv = sc.dev ? DEV[sc.dev] : null;
    if (dv) {
      covered = differing.every((f) => dv.fields.includes(f));
      if (covered && dv.maskMarkerMessage && !cmp.state) covered = maskMarkerMessage(b.state) === maskMarkerMessage(t.state);
      if (covered && dv.dropLeakedRespTmp && !cmp.state) covered = dropLeakedRespTmp(b.state) === t.state;
      if (covered && dv.dropJqLines && !cmp.stderr) covered = dropJq(b.stderr) === dropJq(t.stderr);
    }
    verdict = covered ? "DEVIATION" : "DIVERGE";
  }
  results.push({
    group: sc.group,
    name: sc.name,
    argv: sc.argv,
    dev: sc.dev ?? null,
    verdict,
    differing,
    wireSame,
    wireBodySame,
    wireHeaderKeys,
    bash: { ...b, stdout: undefined },
    ts: { ...t, stdout: undefined },
  });
  const tag = verdict === "PARITY" ? "ok  " : verdict === "DEVIATION" ? "dev " : "DIFF";
  process.stdout.write(`${tag} ${sc.group}/${sc.name}${differing.length ? `  [${differing.join(",")}]` : ""}${wireSame ? "" : "  (wire differs)"}\n`);
}
await srv.close();

// --- report ------------------------------------------------------------------------------
const total = results.length;
const parity = results.filter((r) => r.verdict === "PARITY").length;
const deviations = results.filter((r) => r.verdict === "DEVIATION").length;
const diverge = results.filter((r) => r.verdict === "DIVERGE").length;
const wireDiffs = results.filter((r) => !r.wireSame).length;

const CLIP = 1200;
const clip = (s, n = CLIP) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n)}…(+${String(s).length - n} chars)` : String(s));
function block(label, a, bb, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(clip(a))}\n      ts  : ${JSON.stringify(clip(bb))}`;
}
let md = `# llm — ADVERSARIAL differential check (tester's own harness)\n\n`;
md += `Generated by \`parity/llm/run-parity-adversarial.mjs\`. Real Bash \`headlong/bin/llm\` vs \`bin/llm.mjs\`, identical inputs, one raw-byte fake server, isolated sandboxes. Verdict fields: stdout (bytes), stderr, exit status+signal, sandbox state (bytes), semantic requests. Wire (all headers + whitespace-minified raw body) is reported separately.\n\n`;
md += `Normalized symmetrically: \`<TS>\`, \`127.0.0.1:<PORT>\`, \`<BASH_LLM>\`, \`<SB>\`, curl's \`after <N> ms\`. Locale \`LC_ALL=C\`, \`LLM_RETRY_BACKOFF=0\` unless the scenario overrides it.\n\n`;
md += `## Result: ${total} scenarios — ${parity} PARITY, ${deviations} documented DEVIATION, **${diverge} DIVERGE**; wire differs in ${wireDiffs}\n\n`;
md += `| # | group | scenario | verdict | fields | wire | deviation |\n|---|---|---|---|---|---|---|\n`;
results.forEach((r, i) => {
  md += `| ${i + 1} | ${r.group} | ${r.name} | ${r.verdict} | ${r.differing.join(", ") || "-"} | ${r.wireSame ? "same" : "DIFF"} | ${r.dev ?? "-"} |\n`;
});
md += `\n## Tester's classification of the non-parity rows\n\n`;
md += `| scenario | harness verdict | class | fix | note |\n|---|---|---|---|---|\n`;
const untriaged = [];
for (const r of results.filter((x) => x.verdict !== "PARITY" || !x.wireSame)) {
  const key = `${r.group}/${r.name}`;
  let t = TRIAGE[key];
  if (!t && r.verdict === "DEVIATION") t = ["DOC", "-", `PARITY.md row: ${DEV[r.dev].row}`];
  if (!t && r.verdict === "PARITY") continue; // header-only / jq-formatting wire noise: summarized in the wire section
  if (!t) {
    untriaged.push(key);
    continue;
  }
  md += `| ${key} | ${r.verdict}${r.wireSame ? "" : " (wire differs)"} | ${t[0]} | ${t[1]} | ${t[2].replace(/\|/g, "\\|")} | \n`;
}
if (untriaged.length) md += `\nUNTRIAGED (new since the classification was written): ${untriaged.join(", ")}\n`;
md += `\nFixes F1–F13 were validated on a scratch copy of the port (\`PARITY_TS_LLM\`) and are applied in src/ and bin/ (PARITY.md, "llm parity fixes"); FIXED rows are at PARITY. Every DOC row cites the PARITY.md deviation row its scenario is tagged with.\n`;
md += `\n## Divergences and deviations (detail)\n\n`;
for (const r of results.filter((x) => x.verdict !== "PARITY")) {
  md += `### ${r.verdict}: ${r.group} / ${r.name}\n- argv: \`${JSON.stringify(r.argv)}\`\n${r.dev ? `- declared deviation: ${r.dev} (${DEV[r.dev].row})\n` : ""}- exit: bash=${r.bash.status} ts=${r.ts.status}\n\`\`\`\n`;
  md += block("stdout", r.bash.stdoutText, r.ts.stdoutText, r.bash.stdoutText === r.ts.stdoutText && !r.differing.includes("stdout")) + "\n";
  for (const f of ["stderr", "state", "reqSem"]) md += block(f, r.bash[f], r.ts[f], !r.differing.includes(f)) + "\n";
  md += "```\n\n";
}
md += `## Wire-level differences (informational: headers + raw body)\n\n`;
const hk = new Map();
for (const r of results) for (const k of r.wireHeaderKeys) hk.set(k, (hk.get(k) ?? 0) + 1);
md += `Request headers that differ (scenarios): ${[...hk.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `\`${k}\` ×${n}`).join(", ") || "none"}. curl sends \`User-Agent: curl/…\`, \`Accept: */*\` and (bodies ≥ 1 MiB) \`Expect: 100-continue\`; node adds \`accept-encoding\`, \`accept-language\`, \`connection\`, \`sec-fetch-mode\`, \`user-agent: node\`; \`content-length\` differs because jq pretty-prints the payload and JSON.stringify does not.\n\n`;
md += `Raw BODY differs (after whitespace minification) in: ${results.filter((r) => !r.wireBodySame).map((r) => `${r.group}/${r.name}`).join(", ") || "none"}\n\n`;
for (const r of results.filter((x) => !x.wireBodySame)) {
  let a = r.bash.wire;
  let bb = r.ts.wire;
  try {
    a = JSON.parse(r.bash.wire).map((q) => q.body).join("\n");
    bb = JSON.parse(r.ts.wire).map((q) => q.body).join("\n");
  } catch {
    /* keep raw */
  }
  md += `### ${r.group}/${r.name}\n\`\`\`\n${block("body", a, bb, false)}\n\`\`\`\n\n`;
}
fs.writeFileSync(path.join(HERE, `report-adversarial${REPORT_SUFFIX}.md`), md);
const slim = results.map((r) => ({
  ...r,
  bash: { stdoutText: clip(r.bash.stdoutText, 4000), stderr: clip(r.bash.stderr, 4000), status: r.bash.status, state: clip(r.bash.state, 4000), reqSem: clip(r.bash.reqSem, 4000) },
  ts: { stdoutText: clip(r.ts.stdoutText, 4000), stderr: clip(r.ts.stderr, 4000), status: r.ts.status, state: clip(r.ts.state, 4000), reqSem: clip(r.ts.reqSem, 4000) },
}));
fs.writeFileSync(path.join(HERE, `results-adversarial${REPORT_SUFFIX}.json`), JSON.stringify({ total, parity, deviations, diverge, wireDiffs, tsEntry: scrubPath(TS_LLM), results: slim }, null, 1));
console.log(`\nadversarial: ${total} scenarios — ${parity} parity, ${deviations} documented deviations, ${diverge} DIVERGE, ${wireDiffs} wire-differ`);
process.exit(diverge === 0 ? 0 : 1);
