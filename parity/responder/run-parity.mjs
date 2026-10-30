#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the responder (upstream sync
// 2e39a3f: thinkers/responder/step, reply.schema.json).
//
// Three layers, all against the REAL upstream Bash:
//   1. redaction: `_redact_card` and `_redact_keys` are extracted from the
//      upstream step file and run in bash (real sed) on a corpus; the TS port's
//      redactCard / redactKeys must produce the same bytes. No model.
//   2. parser: upstream's reply-handling section, cut from the step file at run
//      time by stable markers (byte length + sha256 checked, exit 3 otherwise),
//      vs the port's interpretReply, on literal reply strings. No model.
//   3. the whole step: upstream's `thinkers/responder/step` (real bin/chat,
//      bin/traj and bin/llm) and src/responder.ts's runResponder (production
//      LlmCliClient), both on ONE replay server over LLM_API_URL: recorded real
//      DeepSeek replies (recordings/), or HTTP fixtures for transport cases.
//      Compared: the steps appended (key ORDER included), every llm call's
//      limits/schema/messages/system prompt, the wire requests, and the
//      progress lines.
//
// Repeatable: PARITY_UPSTREAM_ROOT=/abs/path/to/headlong node parity/responder/run-parity.mjs
// Re-record: UC_RECORD=1 [UC_RECORD_ONLY=responder/<scenario>] DEEPSEEK_API_KEY=… (same command).
// Writes results.json + report.md beside this file. Exit 0 iff every scenario is
// PARITY or a classified deviation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.PARITY_UPSTREAM_ROOT || "<HEADLONG_ROOT>";
const STEP = path.join(UPSTREAM, "thinkers/responder/step");
if (!fs.existsSync(STEP)) {
  console.error(`PARITY_UPSTREAM_ROOT does not contain thinkers/responder/step: ${UPSTREAM}`);
  process.exit(2);
}
const { redactCard, redactKeys } = await import("../../src/responderRedact.ts");
const { runResponder } = await import("../../src/responder.ts");
const { openTrajectory, rootTrajFile } = await import("../../src/trajectory.ts");

const results = [];
const record = (layer, name, status, detail = "") => results.push({ layer, name, status, detail });

// ---------------------------------------------------------------------------
// Layer 1 — redaction
// ---------------------------------------------------------------------------
const stepText = fs.readFileSync(STEP, "utf8");
function extractFn(name) {
  const lines = stepText.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${name}() {`));
  let j = i;
  while (lines[j] !== "}") j++;
  return lines.slice(i, j + 1).join("\n");
}
const BASH_FNS = `${extractFn("_redact_card")}\n${extractFn("_redact_keys")}\n`;
function bashRedact(fn, input, env = {}) {
  const r = spawnSync("bash", ["-c", `${BASH_FNS}\nprintf '%s' "$1" | ${fn}`, "x", input], {
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), LC_ALL: "en_US.UTF-8", ...env },
    encoding: "utf8",
  });
  return r.stdout;
}
const a = (c, n) => c.repeat(n);
const SEC = {
  ghp: "ghp_" + a("A", 24), pat: "github_pat_" + a("b", 24), slack: "xoxb-" + a("1", 12), sk: "sk-" + a("q", 24),
  skant: "sk-ant-api03-" + a("z", 20), hf: "hf_" + a("z", 24), aiza: "AIza" + a("k", 32), aws: "AKIA" + a("Z", 16),
  jwt: "eyJ" + a("a", 12) + "." + a("b", 12) + "." + a("c", 12), live: "sk_live_" + a("9", 10), whsec: "whsec_" + a("w", 10),
  npm: "npm_" + a("n", 22), glpat: "glpat-" + a("g", 12), dckr: "dckr_pat-" + a("d", 12),
  sg: "SG." + a("s", 12) + "." + a("t", 12), twilio: "SK" + a("0", 32), mailgun: "key-" + a("m", 22),
};
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc/+=\n-----END RSA PRIVATE KEY-----";
const ENV_TOKEN = "env-held-secret-" + a("x", 10);
const cardCorpus = [
  ["card-spaced", "use 4242 4242 4242 4242 exp 12/28 cvv 411 for Bestia"],
  ["card-dashed", "4111-1111-1111-1111 and 3782-822463-10005"],
  ["card-bare-16", "number 4111111111111111."],
  ["card-bare-15", "n=378282246310005 end"],
  ["card-glued", "a4111111111111111 stays, 41111111111111111111 too long"],
  ["card-keyword-amex", "my amex is 3782 822463 10005 ok; Visa: 4111 1111 1111 1111"],
  ["card-keyword-the", "credit card the 4242 4242 4242 4242 and PAN was 5555555555554444"],
  ["cvv-forms", "CVV 777, cvc: 123, security code is 4567, sec code=999, csc 12"],
  ["expiry-forms", "exp 04/27 expires: 4/2027 Good Thru 11/29 expiry the 01/30, bare 04/27 stays"],
  ["benign", "Bestia Nov 7 2026 6pm party of 2 conf 2110728612 zip 94110 phone 415-555-0100"],
  ["multiline", "line one 4111 1111 1111 1111\ncvv 411\n4111111111111111"],
  ["boundary-start", "4111111111111111 at start\n4111111111111111"],
  ["unicode", "héllo 4111 1111 1111 1111 日本語 cvv 411"],
  ["empty", ""],
  ["only-newlines", "\n\n"],
];
for (const [name, text] of cardCorpus) {
  const want = bashRedact("_redact_card", text);
  const got = redactCard(text);
  // `printf '%s' | sed` ends the last line with a newline; $(...) callers strip it.
  const w = want.replace(/\n+$/, "");
  record("redact-card", name, got.replace(/\n+$/, "") === w ? "PARITY" : "DIVERGE", got === w ? "" : `bash=${JSON.stringify(want)} ts=${JSON.stringify(got)}`);
}
const keyCorpus = [
  ["every-shape", Object.entries(SEC).map(([k, v]) => `${k}: ${v}`).join("\n")],
  ["sk-needs-edge", "xsk-" + a("q", 24) + " and (sk-" + a("q", 24) + ")"],
  ["env-value", `token is ${ENV_TOKEN} ok`],
  ["basic-auth-url", "git clone https://user:hunter2@example.com/x.git"],
  ["docker-auth", '{"auth": "' + a("A", 20) + '"} and "auth" : "' + a("B", 16) + '"'],
  ["aws-secret", "aws_secret_access_key = abcdEFGH1234/+xyz and AWS_SECRET_ACCESS_KEY: foo"],
  ["pem-complete", "before\n" + PEM + "\nafter"],
  ["pem-two", PEM + "\nmid\n" + PEM],
  ["pem-open", "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\nYWJj\ntail line"],
  ["pem-one-line", "x -----BEGIN PRIVATE KEY----- y -----END PRIVATE KEY----- z\nnext"],
  ["pem-swallows-later-rules", PEM + "\nghp_" + a("A", 24)],
  ["card-too", "notes: card 4111 1111 1111 1111 cvv 411 and " + SEC.ghp],
  ["plain", "Andy likes tea. Next call Tuesday at 4pm."],
  ["trailing-newlines", "text\n\n"],
];
for (const [name, text] of keyCorpus) {
  const env = { OPENROUTER_API_KEY: ENV_TOKEN, SLACK_BOT_TOKEN: "short" };
  const want = bashRedact("_redact_keys", text, env);
  const got = redactKeys(text, env);
  const w = want.replace(/\n+$/, "");
  record("redact-keys", name, got.replace(/\n+$/, "") === w ? "PARITY" : "DIVERGE", got.replace(/\n+$/, "") === w ? "" : `bash=${JSON.stringify(want)} ts=${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
// Layer 2 — PARSER comparisons (literal strings, no model)
// ---------------------------------------------------------------------------
// Upstream's reply-handling section (structured-object read and salvage, leading blanks, leaked `chat reply`, NO_REPLY,
// glued/duplicate DEFER, skills tag, the raw-object and tool-markup guards, card redaction) is cut out of the upstream
// step file AT RUN TIME between two stable markers, checked against its expected byte length and sha256, and run as a
// bash function on each literal string. Its I/O seams (`_obs`, `_fail_metrics`, `_finish_metrics`, `traj append`) are
// replaced by recorders; nothing else is touched. The port side is `interpretReply` on the same string. No model.
const { interpretReply } = await import("../../src/responder.ts");
const CUT_START = "# Structured reply: read the object and hand the rest of the step the text\n";
const CUT_END = "reply=$(printf '%s' \"$reply\" | _redact_card)\n";
const CUT_BYTES = 9771;
const CUT_SHA256 = "6e2eeb0c575c5ee68d7249a66a3fe2850b6563f625b92374ee64864d182cf0ba";
function cutSection() {
  const i = stepText.indexOf(CUT_START);
  const j = i < 0 ? -1 : stepText.indexOf(CUT_END, i);
  if (i < 0 || j < 0 || stepText.indexOf(CUT_START, i + 1) >= 0) {
    console.error(`responder parity: reply-section markers not found exactly once in ${STEP} (start=${i}, end=${j})`);
    process.exit(3);
  }
  const cut = stepText.slice(i, j + CUT_END.length);
  const sha = createHash("sha256").update(cut).digest("hex");
  if (Buffer.byteLength(cut) !== CUT_BYTES || sha !== CUT_SHA256) {
    console.error(`responder parity: reply section changed upstream (bytes ${Buffer.byteLength(cut)} != ${CUT_BYTES} or sha256 ${sha} != ${CUT_SHA256}); review it and update CUT_BYTES/CUT_SHA256`);
    process.exit(3);
  }
  return cut;
}
const SECTION = cutSection();
const PARSER_SH = `set -euo pipefail
${extractFn("_redact_card")}
_obs() { printf '%s\\t%s' "$2" "$1" > "$OUT/obs"; }
_fail_metrics() { printf '%s' "$1" > "$OUT/fail"; printf '{}'; }
_finish_metrics() { printf '{}'; }
traj() { cat > "$OUT/action"; }
__reply_section() {
${SECTION}
}
reply=$(cat "$OUT/in")
(
  __reply_section
  printf '%s' "$reply" > "$OUT/reply"
) 2> "$OUT/stderr"
`;
const THEM_P = "andy";
function bashParse(c) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "resp-parse-"));
  try {
    fs.writeFileSync(path.join(out, "in"), c.reply + "\n"); // the step's reply=$(_reply_llm …): llm's output, trailing newlines stripped by $(…)
    spawnSync("bash", ["-c", PARSER_SH], {
      env: {
        PATH: process.env.PATH, LC_ALL: "en_US.UTF-8", OUT: out,
        structured: c.structured ? "1" : "0", _parse: c.structured ? "structured" : "text",
        trigger_content: c.trigger ?? "can you confirm Saturday at 6?", trigger_excerpt: "EXCERPT", msg_from: THEM_P,
        THINKER_NAME: "responder", trigger_step_id: "trig-1",
      },
      encoding: "utf8",
    });
    const rd = (f) => (fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), "utf8") : undefined);
    const action = rd("action") ? JSON.parse(rd("action")) : undefined;
    const obs = rd("obs");
    let outcome = "send";
    if (obs?.startsWith("no-reply\t")) outcome = "no-reply";
    else if (obs?.startsWith("reply-failed\t")) outcome = rd("fail") === "markup" ? "fail:markup" : /broken JSON/.test(obs) ? "fail:broken" : "fail:raw";
    return {
      outcome,
      text: outcome === "send" ? rd("reply") : null,
      deferred: action !== undefined,
      request: action?.request ?? "",
      stderr: (rd("stderr") ?? "").split("\n").filter(Boolean),
    };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
function portParse(c) {
  let notes = "";
  // runResponder's callLlm hands interpretReply `stripTrailingNewlines(resp.text)`, the port's `reply=$(...)`.
  const r = interpretReply((c.reply + "\n").replace(/\n+$/, ""), { structured: c.structured, triggerContent: c.trigger ?? "can you confirm Saturday at 6?", msgFrom: THEM_P }, (l) => (notes += l));
  const stderr = notes.split("\n").filter(Boolean);
  if (r.kind === "fail") return { outcome: r.failure === "markup" ? "fail:markup" : r.broken ? "fail:broken" : "fail:raw", text: null, deferred: false, request: "", stderr };
  if (r.kind === "no-reply") return { outcome: "no-reply", text: null, deferred: false, request: "", stderr };
  const late = r.rawObjectAfterDefer ? "fail:raw" : r.markupAfterDefer ? "fail:markup" : undefined;
  return { outcome: late ?? "send", text: late ? null : r.text, deferred: r.deferred, request: r.deferred ? r.deferredRequest : "", stderr };
}
const obj = (action, message, request = "") => JSON.stringify({ action, message, request });
// Literal reply strings: these test the reply PARSER, not a model (most are shapes seen in production, named in the
// upstream comments). Formerly whole-step scenarios fed by a scripted `llm`.
const PARSER_CASES = [
  ["text-no-reply", false, "NO_REPLY"],
  ["text-no-reply-leading-blank", false, "\n\n  NO_REPLY  "],
  ["text-defer", false, "DEFER: book Bestia for 2 on Nov 7\nLet me get that booked."],
  ["text-defer-after-holding", false, "Let me look.\nDEFER: check the repo status"],
  ["text-defer-glued-before", false, "Looking into your wake prompt.DEFER: Investigate the wake prompt"],
  ["text-defer-twice-glued", false, "DEFER: open the PR on headlong mainLet me open that PR for you.\nDEFER: open the PR on headlong main\nLet me open that PR for you."],
  ["text-defer-bare", false, "DEFER:\n"],
  ["text-defer-mentioned-in-prose", false, "I use the raw DEFER: handoff text for that."],
  ["text-defer-leading-blank", false, "\n\nDEFER: do it\nOn it."],
  ["text-skills-tag", false, "<skills show web>", "please look it\nup"],
  ["text-skills-tag-in-prose", false, "Run <skills show web> yourself."],
  ["text-leaked-chat-reply", false, "chat reply andy Hello there"],
  ["text-raw-json-object", false, '{"action":"reply","message":"hi","request":""}'],
  ["text-tool-markup", false, "<function=skills>\n<parameter=a>b</parameter>"],
  ["text-card-in-reply", false, "Got it, booking with 4242 4242 4242 4242 now."],
  ["text-card-in-defer", false, "DEFER: book Bestia with card 4111-1111-1111-1111 exp 04/27 cvv 777 for Nov 7\nLet me get that booked.", "book Bestia with 4111-1111-1111-1111 cvv 777"],
  ["text-whitespace-only", false, "   \n  \n"],
  ["text-defer-then-raw-object", false, 'DEFER: dig in\n{"action":"reply","message":"x"}'],
  ["text-defer-then-markup", false, "DEFER: dig in\n<invoke name=x>"],
  ["structured-reply", true, obj("reply", "Sounds good, see you then.")],
  ["structured-reply-fenced", true, "```json\n" + obj("reply", "Fenced.") + "\n```"],
  ["structured-no-reply", true, obj("no_reply", "")],
  ["structured-defer", true, obj("defer", "Let me check.", "look up the repo\nstatus")],
  ["structured-defer-card", true, obj("defer", "On it.", "book using 4111-1111-1111-1111 exp 04/27"), "book with 4111-1111-1111-1111 cvv 777"],
  ["structured-action-uppercase", true, obj("DEFER", "Working.", "do the thing")],
  ["structured-unknown-action", true, obj("hmm", "Plain message.")],
  ["structured-plain-text", true, "Just plain text, no object."],
  ["structured-plain-text-defer", true, "DEFER: dig in\nOn it."],
  ["structured-salvage-close-brace", true, '{"action":"reply","message":"All good.","request":""\n   \n   '],
  ["structured-salvage-noreply-in-string", true, '{"action":"no_reply","message":"","request":"'],
  ["structured-cut-in-message", true, '{"action":"reply","message":"All go'],
  ["structured-broken-json", true, '{"action": reply}'],
  ["structured-raw-action-in-message", true, obj("reply", '{"action":"reply","message":"x"}')],
  ["structured-empty-message", true, obj("reply", "")],
];
for (const [name, structured, reply, trigger] of PARSER_CASES) {
  const c = { structured, reply, trigger };
  const want = bashParse(c);
  const got = portParse(c);
  record("parser", name, sameJsonP(want, got) ? "PARITY" : "DIVERGE", sameJsonP(want, got) ? "" : `bash=${JSON.stringify(want)}\nts  =${JSON.stringify(got)}`);
}
function sameJsonP(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Layer 3 — the whole step, real model replies
// ---------------------------------------------------------------------------
// Upstream's `thinkers/responder/step` with its REAL bin/llm, and the port's runResponder with its production client
// (LlmCliClient), both pointed by LLM_API_URL at ONE replay server (parity/support/replayModel.mjs) serving the same
// recorded real DeepSeek replies (parity/responder/recordings/) or, for transport cases, the same HTTP fixtures.
// A pass-through shim in front of upstream's llm records its argv/env (the limits the step sets), then execs the real
// bin/llm; a spy around the port's client records its CompleteOptions, then calls it. Neither produces model text.
const { LlmCliClient } = await import("../../src/llmCliClient.ts");
const { startReplay, REPLAY_MODEL } = await import("../support/replayModel.mjs");
const ME = "testid";
const THEM = "andy";
const TRAJ_ID = "cafe0000-0000-0000-0000-0000000000cd";
const isoAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
const sentinel = (t) => String(t).replace(/The current time is \S+/, "The current time is <NOW>");
const STRUCT = "deepseek/deepseek-v4-flash-0731";
const TEXTM = "claude-opus-4-7";
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const FX = {
  slow: { status: 200, content_type: "text/event-stream", body: "data: [DONE]\n\n", delayMs: 4000 },
  http400: { status: 400, content_type: "application/json", body: '{"error":{"message":"response_format is not supported"}}' },
  http500: { status: 500, content_type: "application/json", body: '{"error":{"message":"upstream error"}}' },
  empty: { status: 200, content_type: "text/event-stream", body: sse([{ choices: [{ index: 0, delta: { content: "" } }] }]) },
  capped: { status: 200, content_type: "text/event-stream", body: sse([{ choices: [{ index: 0, delta: { content: "" }, finish_reason: "length" }] }]) },
};
const scenarios = [
  // real replies (recorded)
  { name: "text-reply", model: TEXTM },
  { name: "text-with-history", model: TEXTM, history: [{ from: THEM, to: ME, content: "how is the bridge work going", ago: 3600 }, { from: ME, to: THEM, content: "about half done", ago: 3500 }], trigger: { content: "any update?" } },
  { name: "text-card-trigger", model: TEXTM, trigger: { content: "use 4242 4242 4242 4242 exp 12/28 cvv 411 for Bestia" } },
  { name: "text-card-noreply-excerpt", model: TEXTM, trigger: { content: "card is 378282246310005, amex. no need to answer this one, thanks" } },
  { name: "structured-schema-model", model: STRUCT },
  { name: "structured-gemini-model", model: "google/gemini-3-flash" },
  { name: "structured-forced-on-text-model", model: TEXTM, env: { RESPONDER_STRUCTURED: "1" } },
  { name: "structured-forced-off", model: STRUCT, env: { RESPONDER_STRUCTURED: "0" } },
  { name: "stale-trigger", model: TEXTM, trigger: { agoS: 7200 } },
  { name: "stale-trigger-disabled", model: TEXTM, trigger: { agoS: 7200 }, env: { RESPONDER_MAX_TRIGGER_AGE: "0" } },
  { name: "stale-trigger-custom-age", model: TEXTM, trigger: { agoS: 120 }, env: { RESPONDER_MAX_TRIGGER_AGE: "60" } },
  { name: "stale-trigger-nonnumeric", model: TEXTM, trigger: { agoS: 7200 }, env: { RESPONDER_MAX_TRIGGER_AGE: "soon" } },
  { name: "self-message", model: TEXTM, trigger: { from: ME, content: "note to self 4111 1111 1111 1111" } },
  { name: "structured-fallback-to-text", model: STRUCT, fixtures: { 0: FX.http400 } }, // fixture 400, then a recorded reply
  // transport (HTTP fixtures only, never recorded)
  { name: "transport-timeout", model: TEXTM, env: { RESPONDER_MAX_TIME: "2" }, fixtures: { 0: FX.slow } },
  { name: "transport-limits-env", model: TEXTM, env: { RESPONDER_MAX_TOKENS: "4096", RESPONDER_MAX_TIME: "2" }, fixtures: { 0: FX.slow } },
  { name: "transport-truncated", model: TEXTM, fixtures: { 0: FX.capped } },
  { name: "transport-empty", model: TEXTM, fixtures: { 0: FX.empty } },
  { name: "transport-http500", model: TEXTM, fixtures: { 0: FX.http500 } },
  { name: "transport-structured-fallback-also-fails", model: STRUCT, fixtures: { 0: FX.http400, 1: FX.http500 } },
  { name: "transport-structured-timeout-no-retry", model: STRUCT, env: { RESPONDER_MAX_TIME: "2" }, fixtures: { 0: FX.slow } },
  { name: "transport-structured-truncated-no-retry", model: STRUCT, fixtures: { 0: FX.capped } },
];
const replay = await startReplay({
  suite: "responder",
  dir: path.join(HERE, "recordings"),
  forwardModel: REPLAY_MODEL,
  fixtures: Object.fromEntries(scenarios.filter((s) => s.fixtures).map((s) => [s.name, { main: s.fixtures }])),
});

function seedLines(sc) {
  const lines = [JSON.stringify({ step_id: "hdr", type: "trajectory", ts: isoAgo(86400) })];
  let n = 0;
  for (const h of sc.history ?? []) {
    lines.push(JSON.stringify({ step_id: `h${++n}`, type: "message", from: h.from, to: h.to, content: h.content, ts: isoAgo(h.ago), source: "chat" }));
  }
  const t = sc.trigger ?? {};
  const trig = { step_id: "trig-1", type: "message", from: t.from ?? THEM, to: ME, content: t.content ?? "can you confirm Saturday at 6?", ts: isoAgo(t.agoS ?? 2), source: "chat" };
  lines.push(JSON.stringify(trig));
  return { lines, trig };
}

function makeSandbox(sc, ts = false) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "resp-parity-"));
  const ID = path.join(work, "ident");
  const trajDir = path.join(ID, "trajectories");
  // upstream resolves <TRAJ_DIR>/<id>/trajectory.jsonl; the port's own convention is <hex8>-root.
  const trajFile = ts ? rootTrajFile(trajDir, TRAJ_ID) : path.join(trajDir, TRAJ_ID, "trajectory.jsonl");
  fs.mkdirSync(path.dirname(trajFile), { recursive: true });
  fs.mkdirSync(path.join(ID, "memories"), { recursive: true });
  fs.mkdirSync(path.join(ID, "run"), { recursive: true });
  fs.writeFileSync(path.join(ID, "info.txt"), `name=${ME}\ncreated=test\nroot_trajectory=${TRAJ_ID}\n`);
  fs.writeFileSync(path.join(ID, "run", "dispatcher.token"), "test-token\n");
  const { lines, trig } = seedLines(sc);
  fs.writeFileSync(trajFile, lines.join("\n") + "\n");
  return { work, ID, trajDir, trajFile, trig };
}

// Pass-through shim: records what the step hands `llm`, then runs upstream's real bin/llm. No output of its own.
const SHIM_LLM = `#!/usr/bin/env bash
n=$(cat "$SHIM_CALLS/n" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$SHIM_CALLS/n"
jq -n --arg t "$LLM_MAX_TIME" --arg r "$LLM_RETRIES" '{max_time:$t, retries:$r}' > "$SHIM_CALLS/env.$n.json"
printf '%s\\0' "$@" > "$SHIM_CALLS/argv.$n"
for a in "$@"; do [[ "$prev" == "--json-schema" ]] && cp "$a" "$SHIM_CALLS/schema.$n"; prev="$a"; done
exec "$UPSTREAM_LLM" "$@"
`;

function readArgv(file) {
  const parts = fs.readFileSync(file, "utf8").split("\0");
  parts.pop();
  const o = { model: undefined, tokens: undefined, messages: undefined, system: undefined, schema: false };
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "-m") o.model = parts[++i];
    else if (parts[i] === "-t") o.tokens = Number(parts[++i]);
    else if (parts[i] === "-M") o.messages = JSON.parse(parts[++i]);
    else if (parts[i] === "-s") o.system = parts[++i];
    else if (parts[i] === "--json-schema") (o.schema = true), i++;
  }
  return o;
}

function normSteps(steps, trigId) {
  const ids = new Map([[trigId, "TRIG"]]);
  const lab = (v) => {
    if (typeof v !== "string") return v;
    if (!ids.has(v)) ids.set(v, `S${ids.size}`);
    return ids.get(v);
  };
  const out = [];
  for (const s of steps) {
    if (s.type === "trajectory") continue;
    const o = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "ts") continue;
      if (k === "step_id") o[k] = lab(v);
      else if (k === "trigger_step" || k === "reply_to") o[k] = lab(v);
      else if (k === "context_steps") o[k] = v.map(lab);
      else if (k === "compose_ms" || k === "llm_ms" || k === "gap_s") o[k] = "<n>";
      else o[k] = v;
    }
    out.push(o);
  }
  return out;
}
const sameJson = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// Known, documented step-shape differences (PARITY.md "responder (2e39a3f)"):
// real `chat reply` stamps its own bookkeeping fields on the message step the
// port appends directly; the port never meets chat reply's repeat-window.
function stripChatBookkeeping(steps) {
  return steps.map((s) => {
    if (s.type !== "message") return s;
    const { key, delivery, ...rest } = s;
    return rest;
  });
}

// `llm: warning: LLM_PROVIDER=… overrides …` / `LLM_API_URL=… reroutes …` are bin/llm's notes about the replay route
// itself (an env provider and URL), not responder behaviour.
const stripNoise = (lines) =>
  lines
    .filter((l) => l.trim() !== "")
    .filter((l) => !/^traj:|^chat: (index|note)/.test(l))
    .filter((l) => !/^llm: warning: LLM_(PROVIDER|API_URL)=/.test(l))
    // The deadline's wording is llm's own documented deviation (PARITY.md Deviations "llm network guards": curl
    // --max-time vs an AbortController); the responder only keys off "timed out", which both lines carry.
    .map((l) => (/^llm: error: (curl error: curl: \(28\) Operation timed out after \d+ milliseconds.*|request failed: timed out after \d+s \(LLM_MAX_TIME\))$/.test(l) ? "llm: error: <timed out>" : l));

const routeEnv = (sc, side) => ({ LLM_PROVIDER: "openai-compatible", LLM_API_URL: replay.url(sc.name, side), LLM_API_KEY: "replay-not-a-key", LLM_RETRY_BACKOFF: "0" });

async function runBash(sc, sb) {
  const shim = path.join(sb.work, "shim");
  const calls = path.join(sb.work, "calls");
  fs.mkdirSync(shim, { recursive: true });
  fs.mkdirSync(calls, { recursive: true });
  fs.writeFileSync(path.join(shim, "llm"), SHIM_LLM, { mode: 0o755 });
  const env = {
    PATH: `${shim}:${UPSTREAM}/bin:${UPSTREAM}/tools:${process.env.PATH}`,
    HOME: path.join(sb.work, "home"),
    IDENTITY_DIR: sb.ID, IDENTITY_NAME: ME, MEM_DIR: path.join(sb.ID, "memories"), TRAJ_DIR: sb.trajDir, TRAJ_ID,
    THINK_MODEL: sc.model, RESPONDER_PERSON_NOTES: "0", MONOLITH_TIERED_MEMORY: "0",
    SHIM_CALLS: calls, UPSTREAM_LLM: path.join(UPSTREAM, "bin/llm"),
    ...routeEnv(sc, "upstream"),
    ...(sc.env ?? {}),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  // Async: the replay server lives in this process.
  const r = await new Promise((resolve) => {
    const c = spawn("bash", [STEP], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", () => resolve({ stdout, stderr }));
    c.stdin.end(JSON.stringify(sb.trig));
  });
  const steps = fs.readFileSync(sb.trajFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const n = Number(fs.existsSync(path.join(calls, "n")) ? fs.readFileSync(path.join(calls, "n"), "utf8") : 0);
  const llmCalls = [];
  for (let i = 1; i <= n; i++) {
    const argv = readArgv(path.join(calls, `argv.${i}`));
    const e = JSON.parse(fs.readFileSync(path.join(calls, `env.${i}.json`), "utf8"));
    llmCalls.push({
      maxTokens: argv.tokens,
      maxTimeS: Number(e.max_time),
      retries: Number(e.retries),
      model: argv.model,
      schema: fs.existsSync(path.join(calls, `schema.${i}`)) ? JSON.parse(fs.readFileSync(path.join(calls, `schema.${i}`), "utf8")) : undefined,
      messages: argv.messages,
      system: sentinel(argv.system ?? "").replace(/^[\s\S]*?\n\n(?=The current time is)/, ""),
    });
  }
  return { steps, llmCalls, stderr: stripNoise(r.stderr.split("\n")), stdout: stripNoise(r.stdout.split("\n")) };
}

async function runTs(sc, sb) {
  const traj = openTrajectory(sb.trajDir, TRAJ_ID);
  const llmCalls = [];
  const err = [];
  const out = [];
  const real = new LlmCliClient({ mode: "plain", model: sc.model, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...routeEnv(sc, "port") } });
  const llm = {
    async complete(system, messages, o = {}) {
      llmCalls.push({
        maxTokens: o.maxTokens,
        maxTimeS: o.maxTimeMs / 1000,
        retries: o.retries,
        model: sc.model,
        schema: o.jsonSchema,
        messages,
        system: sentinel(system).replace(/^[\s\S]*?\n\n(?=The current time is)/, ""),
      });
      return real.complete(system, messages, o);
    },
  };
  await runResponder({
    trajectory: traj, llm, identityName: ME, identityText: "", skillsText: "", model: sc.model,
    memDir: path.join(sb.ID, "memories"), identityDir: sb.ID, personNotes: false,
    env: { ...(sc.env ?? {}) },
    trigger: sb.trig,
    io: { stderr: (s) => err.push(s), stdout: (s) => out.push(s) },
  });
  const steps = fs.readFileSync(sb.trajFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const split = (arr) => stripNoise(arr.join("").split("\n"));
  return { steps, llmCalls, stderr: split(err), stdout: split(out) };
}

// The wire: what each side actually sent the endpoint (both reach the same server).
const wireOf = (scName, side) =>
  replay.requests(scName, side).map(({ body }) => ({
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    response_format: body.response_format?.type,
    stream: body.stream,
    messages: (body.messages ?? []).map((m) => ({ role: m.role, content: sentinel(m.content).replace(/^[\s\S]*?\n\n(?=The current time is)/, "") })),
  }));

for (const sc of scenarios) {
  const sbB = makeSandbox(sc);
  const sbT = makeSandbox(sc, true);
  try {
    const want = await runBash(sc, sbB);
    const got = await runTs(sc, sbT);
    const seedCount = seedLines(sc).lines.length;
    const wSteps = stripChatBookkeeping(normSteps(want.steps.slice(seedCount), "trig-1"));
    const gSteps = stripChatBookkeeping(normSteps(got.steps.slice(seedCount), "trig-1"));
    const diffs = [];
    if (!sameJson(wSteps, gSteps)) diffs.push(`steps\n  bash=${JSON.stringify(wSteps)}\n  ts  =${JSON.stringify(gSteps)}`);
    if (!sameJson(want.llmCalls, got.llmCalls)) diffs.push(`llm calls\n  bash=${JSON.stringify(want.llmCalls)}\n  ts  =${JSON.stringify(got.llmCalls)}`);
    const ww = wireOf(sc.name, "upstream"), gw = wireOf(sc.name, "port");
    if (!sameJson(ww, gw)) diffs.push(`wire\n  bash=${JSON.stringify(ww)}\n  ts  =${JSON.stringify(gw)}`);
    const wl = want.stderr.filter((l) => l !== "Reply sent.");
    const gl = got.stderr.filter((l) => l !== "Reply sent.");
    if (!sameJson(wl, gl)) diffs.push(`stderr\n  bash=${JSON.stringify(wl)}\n  ts  =${JSON.stringify(gl)}`);
    if (!sameJson(want.stdout, got.stdout)) diffs.push(`stdout\n  bash=${JSON.stringify(want.stdout)}\n  ts  =${JSON.stringify(got.stdout)}`);
    record("step", sc.name, diffs.length === 0 ? "PARITY" : "DIVERGE", diffs.join("\n"));
  } catch (e) {
    record("step", sc.name, "ERROR", String(e?.stack ?? e));
  } finally {
    fs.rmSync(sbB.work, { recursive: true, force: true });
    fs.rmSync(sbT.work, { recursive: true, force: true });
  }
}
await replay.close();
for (const m of replay.misses) record("replay", "miss", "ERROR", m);

// ---------------------------------------------------------------------------
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
const total = results.length;
const parity = tally.PARITY ?? 0;
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ tally, total, results }, null, 2) + "\n");
const md = [
  "# Responder parity (2e39a3f)",
  "",
  `${parity}/${total} PARITY — ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
  "",
  "| layer | scenario | status |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.layer} | ${r.name} | ${r.status} |`),
  "",
  ...results.filter((r) => r.status !== "PARITY").flatMap((r) => [`## ${r.layer} / ${r.name} — ${r.status}`, "```", r.detail, "```", ""]),
].join("\n");
fs.writeFileSync(path.join(HERE, "report.md"), md + "\n");
console.log(`responder parity: ${parity}/${total} PARITY — ${JSON.stringify(tally)}`);
for (const r of results.filter((x) => x.status !== "PARITY")) console.log(`  ${r.status} ${r.layer}/${r.name}\n${r.detail.split("\n").map((l) => "    " + l).join("\n")}`);
process.exit(results.some((r) => r.status === "ERROR" || r.status === "DIVERGE") ? 1 : 0);
