#!/usr/bin/env node
// parity/extract/run-parity.mjs — differential harness for the model-reply
// handling functions that live inside upstream's bin/shellm and have no CLI of
// their own: extract_code (incl. normalize_toolcall_markup / script_parses /
// strip_markup_suffix), extract_reasoning, and redact_sensitive.
//
// The oracle is upstream's REAL Bash: each function is sed-extracted out of
// bin/shellm (same technique upstream's own tests/test_extract_code_notice.sh
// and tests/test_redact_sensitive.sh use), sourced into a bash, and run on the
// same input as the port's src/extract.ts / src/shellm.ts. Expectations come
// from running upstream, never from the port. (Upstream sync 2e39a3f, lane A.)
//
//   PARITY_BASH_SHELLM=/path/to/headlong/bin/shellm node parity/extract/run-parity.mjs
//
// Exit 0 when every case is PARITY or a documented DEVIATION; 1 on DIVERGE.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BASH_SHELLM =
  process.env.PARITY_BASH_SHELLM ||
  (process.env.PARITY_UPSTREAM_ROOT ? path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/shellm") : "");
if (!BASH_SHELLM || !fs.existsSync(BASH_SHELLM)) {
  console.error("extract parity: set PARITY_BASH_SHELLM=/path/to/upstream/bin/shellm (or PARITY_UPSTREAM_ROOT)");
  process.exit(2);
}

const ext = await import(pathToFileURL(path.join(ROOT, "src/extract.ts")).href);
const shl = await import(pathToFileURL(path.join(ROOT, "src/shellm.ts")).href);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "extract-parity-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

function sedFn(fn) {
  const r = spawnSync("sed", ["-n", `/^${fn}() {/,/^}/p`, BASH_SHELLM], { encoding: "utf8" });
  return r.stdout;
}
const FNS = ["script_parses", "strip_markup_suffix", "normalize_toolcall_markup", "extract_code", "extract_reasoning", "redact_sensitive", "truncate_output"];
const fnFile = path.join(work, "functions.sh");
fs.writeFileSync(fnFile, FNS.map(sedFn).join("\n"));

function bash(script, input, env = {}) {
  const r = spawnSync("bash", ["-c", `set -uo pipefail; source "${fnFile}"; ${script}`, "_"], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: work, ...env },
  });
  return { out: r.stdout, rc: r.status, err: r.stderr };
}

const results = [];
function check(name, expected, actual, deviation) {
  const same = expected === actual;
  results.push({ name, status: same ? "PARITY" : deviation ? "DEVIATION" : "DIVERGE", expected, actual, deviation });
}

// $(...) strips trailing newlines; `echo "$code"` adds one back. Normalize both.
const stripNl = (s) => s.replace(/\n+$/, "");

// ------------------------------------------------------------------ extract_code
const TC = (s) => s;
const CASES = {
  prose: "Idle — nothing to do now.",
  fenced: "Let me look.\n```bash\nls -la\n```",
  final: '```bash\nFINAL="done"\n```',
  blank: "   ",
  eolfence: "do it now.```bash\necho hi\n```",
  canonical: "Let me check.\n<tool_call>\n<function=bash>\necho lifted-canonical\n</function>\n</tool_call>",
  hybrid: "<tool_call>\n<function=bash>\necho lifted-hybrid\n</bash>\n\n</bash>",
  bare: '<tool_call>\necho lifted-bare\nFINAL="done"',
  parameter: "<tool_call>\n<function=bash>\n<parameter=command>\necho lifted-parameter\n</parameter>\n</function>\n</tool_call>",
  inline: "<tool_call><function=bash><parameter=command>echo lifted-inline\necho second</parameter></function></tool_call>",
  cmd_timeout: "<tool_call><function=bash><parameter=cmd>echo lifted-cmd_timeout</parameter>\n<parameter=timeout>30</parameter>\n</function></tool_call>",
  prose_prefix: "Let me look at the evidence first.<tool_call><function=bash><parameter=command>echo lifted-prose_prefix\n</parameter></function></tool_call>",
  prose_lines: "I'll check the `mem add` syntax first.\n\nThat's the plan.<tool_call><function=bash><parameter=command>echo lifted-prose_lines</parameter></function></tool_call>",
  block: "<tool_call>\n<function=bash>\n<parameter=block>echo lifted-block\n</parameter>\n</function>\n</tool_call>",
  glued: "```<tool_call><function=bash><parameter=command>echo lifted-glued\n</parameter></function></tool_call>\n```",
  inline_suffix: "Checking.\n```bash\nfor x in a; do\n  echo fenced-$x\ndone</parameter></function></tool_call>\n```",
  tag_lines: "```bash\necho fenced-a\n</parameter>\n</function>\n</tool_call>\n```",
  valid_literal_tag: "```bash\ncat <<'EOF'\n</tool_call>\nEOF\n```",
  shell_prefix: "x=1; echo done.<tool_call><function=bash><parameter=command>echo DATA\n</parameter></function></tool_call>",
  backslash_prefix: "printf a\\\\b.<tool_call><function=bash><parameter=command>echo DATA\n</parameter></function></tool_call>",
  open_quote: "echo 'intro\n<tool_call>\necho DATA\n</tool_call>'",
  fence_wins: "<tool_call> mentioned in prose\n```bash\necho fence-wins\n```",
  heredoc_wrapped: "<tool_call>\n<function=bash>\ncat <<'DATA'\n<tool_call>\n<function=bash>\n<parameter=command>\n<bash>\necho DATA_ONLY\n</bash>\n</parameter>\n</function>\n</tool_call>\nDATA\necho AFTER\n</function>\n</tool_call>",
  single_quoted: "printf '%s\\n' '<tool_call>\necho DATA_ONLY\n</tool_call>'\necho AFTER",
  double_quoted: 'printf \'%s\\n\' "<tool_call>\necho DATA_ONLY\n</tool_call>"\necho AFTER',
  amb_quote: '<tool_call>\nprintf "%s\\n" "unfinished\n</tool_call>',
  amb_heredoc: "<tool_call>\ncat <<EOF\nunfinished\n</tool_call>",
  amb_delim: "<tool_call>\ncat <<'</tool_call>'\nliteral body\n</tool_call>\n</tool_call>",
  amb_preamble: "cat <<EOF\n<tool_call>\necho DATA_ONLY\n</tool_call>",
  amb_unknown: '<tool_call>\n<function=python>\nprint("hello")\n</function>\n</tool_call>',
  extra_call: "<tool_call>\necho first\n</tool_call>\n<tool_call>\necho second\n</tool_call>",
  mimo_two: "Two checks.<tool_call><function=bash><parameter=command>echo first</parameter></function></tool_call>\n<tool_call><function=bash><parameter=command>echo second</parameter></function></tool_call>",
  mimo_sameline: "<tool_call><function=bash><parameter=command>echo first</parameter></function></tool_call><tool_call><function=bash><parameter=command>echo second</parameter></function></tool_call>",
  call_in_heredoc: "<tool_call>\n<function=bash>\ncat <<'DATA'\n</tool_call>\n<tool_call>\nDATA\necho AFTER\n</function>\n</tool_call>",
  crlf: "```bash\r\necho crlf\r\n```\r\n",
  crlf_two_blocks: "```bash\r\necho a\r\n```\r\n```bash\r\necho b\r\n```\r\n",
  prov_exit: "echo hi\n[exit] 0\n[stdout]\nhi",
  prov_heredoc: "cat <<'EOF'\n[exit] literal\nEOF\necho after",
  prov_served: "echo only\n[served_by] x",
  prov_prose: "Done.\n[exit] 0",
  two_blocks: "a\n```bash\necho 1\n```\nmid\n```bash\necho 2\n```",
  cmd_marker: "[cmd]\necho marked\n[thought] x",
  tagged_json: "```json\n{}\n```",
  unclosed: "```bash\necho no-close",
  empty_fence: "```bash\n```",
  suffix_ok_script: "```bash\necho a</parameter>\n```",
  suffix_broken_both: "```bash\nif then </tool_call>\n```",
  suffix_func_calls: "```bash\necho a\n</function_calls>\n```",
  toolcall_in_prose_then_fence: "I will call <function=bash> now.\n```bash\necho x\n```",
  // A fenceless reply that opens with blank lines (DeepSeek's DSML tool-call answers do): upstream's awk keeps them.
  nofence_leading_blank: "\n\necho leading-blank",
};
// padding case (large body), upstream's pipefail/SIGPIPE regression shape.
CASES.large_wrapped =
  "<tool_call>\n<function=bash>\ncat <<'DATA'\n<tool_call>\necho DATA_ONLY\n</tool_call>\n" +
  Array.from({ length: 4000 }, () => "# padding 0123456789abcdef").join("\n") +
  "\nDATA\necho AFTER\n</function>\n</tool_call>";

for (const [name, resp] of Object.entries(CASES)) {
  // As upstream's caller records it: `code=$(extract_code "$response")` (bin/shellm:3034), byte for byte.
  const up = bash('c=$(extract_code "$(cat)"); printf %s "$c"', resp);
  const mine = ext.extractCode(resp).code;
  check(`extract_code/${name}`, up.out, mine);
}

// normalize_toolcall_markup rc contract (returns 0 lifted / 2 dropped / 1 unchanged)
for (const name of ["canonical", "bare", "mimo_two", "extra_call", "amb_quote", "amb_heredoc", "amb_delim", "amb_preamble", "amb_unknown", "shell_prefix", "backslash_prefix", "open_quote", "prose_prefix", "glued", "fenced", "call_in_heredoc"]) {
  const resp = CASES[name];
  const up = bash('out=$(normalize_toolcall_markup "$(cat)"); echo "rc=$?"; printf "%s" "$out"', resp);
  const r = ext.normalizeToolcallMarkup(resp);
  check(`normalize/${name}`, stripNl(up.out), stripNl(`rc=${r.rc}\n${r.text}`));
}

// strip_markup_suffix
for (const [name, text] of Object.entries({
  none: "echo a\necho b",
  tags: "echo a\n</parameter>\n</function>\n</tool_call>\n",
  inline: "echo a</parameter></function></tool_call>",
  param: "echo a\n<parameter=timeout>30</parameter>\n</function>",
  blanks: "echo a\n\n\n",
  interior: "echo a\n</tool_call>\necho b",
  all: "</tool_call>\n</function>",
})) {
  const up = bash('strip_markup_suffix <<<"$(cat)"', text + "\n");
  // `<<<"$(cat)"` re-adds a single newline; feed the same shape to the port.
  check(`strip_markup_suffix/${name}`, stripNl(up.out), stripNl(ext.stripMarkupSuffix(stripNl(text))));
}

// ------------------------------------------------------------------ extract_reasoning
for (const [name, resp] of Object.entries({
  plain: "think think\n```bash\nls\n```",
  eol: "pre text ```bash\nls\n```",
  json_then_prose: "see:\n```json\n{}\n```\nmore prose\n```bash\nls\n```",
  nofence: "just prose\nsecond line",
  // A blank line between the prose and the fence (how DeepSeek usually answers): upstream's `reasoning=$(…)` drops
  // every trailing newline, so the thought has none.
  blank_before_fence: "I need to write plain bash.\n\n```bash\nls\n```",
  only_blank_before_fence: "\n```bash\nls\n```",
  leading_blank_lines: "\n\nprose after two blank lines\n\n\n```bash\nls\n```",
  nofence_trailing_newlines: "just prose\n\n\n",
  big_after_fence: "r\n```bash\n" + Array.from({ length: 2000 }, (_, i) => `echo ${i}`).join("\n") + "\n```\ntrailer",
})) {
  // Upstream's caller is `reasoning=$(extract_reasoning "$response")` (bin/shellm:3027), so the value it records is
  // the command substitution, compared byte for byte with the port's return value (no newline stripping here).
  const up = bash('r=$(extract_reasoning "$(cat)"); printf %s "$r"', resp);
  check(`extract_reasoning/${name}`, up.out, ext.extractReasoning(resp));
}

// ------------------------------------------------------------------ redact_sensitive
// Fake credentials, built from pieces so no provider-shaped literal sits in the source (secret scanners such as
// GitHub push protection flag them). The joined strings are byte-identical to the shapes the redaction checks need.
const k = (...parts) => parts.join("");
const FAKE_GHP = k("ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
const SECRET_ENV = {
  OPENAI_API_KEY: "sk-short",
  GITHUB_TOKEN: FAKE_GHP,
  SLACK_BOT_TOKEN: k("xox", "b-1111-2222-abcdefghij"),
  DATABASE_URL: "postgres://user:pw@host/db",
  REDIS_URL: "short",
  AWS_ACCESS_KEY_ID: k("AKIA", "ABCDEFGHIJKLMNOP"),
};
const REDACT_INPUTS = {
  plain: "nothing secret here",
  env_values: `key sk-short and token ${FAKE_GHP} db postgres://user:pw@host/db short`,
  shapes: [
    "anthropic sk-ant-abc_def-123",
    "openai sk-abcdefghijklmnopqrstuvwx",
    "pre-sk-abcdefghijklmnopqrstuvwx",
    k("gh gh", "p_abcdefghijklmnop12 and github", "_pat_abcdefghijkl_mn"),
    k("slack xox", "b-12345678-abcd"),
    k("hf hf", "_abcdefghijklmnop"),
    k("google AI", "zaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345"),
    k("aws AKIA", "ABCDEFGHIJKLMNOP AS", "IA1234567890ABCDEF"),
    k("jwt eyJhbGciOiJIUzI1NiI", ".eyJzdWIiOiIxMjM0NTY3", ".SflKxwRJSMeKKF2QT4"),
    "url https://user:hunter2@example.com/path",
    '{"auth": "QUJDREVGR0hJSktMTU5PUA=="}',
    k("stripe sk", "_live_abcdefgh12 rk", "_live_abcdefgh12 whsec", "_abcdefgh12"),
    k("npm npm", "_abcdefghijklmnopqrstu glpat", "-abcdefghij12 dckr_pat", "-abcdefghij12"),
    k("sendgrid SG", ".abcdefghij12.abcdefghij12 twilio SK", "0123456789abcdef0123456789abcdef mailgun key", "-abcdefghijklmnopqrstu"),
    k("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG"),
    "AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI",
  ].join("\n"),
  pem: k("before\n-----BEGIN RSA PRIVATE", " KEY-----\nMIIabc\n-----END RSA PRIVATE", " KEY-----\nafter"),
};
for (const [name, text] of Object.entries(REDACT_INPUTS)) {
  const up = bash('redact_sensitive "$(cat)"', text, SECRET_ENV);
  const mine = shl.redactSensitive(text, { ...SECRET_ENV });
  check(`redact_sensitive/${name}`, stripNl(up.out), stripNl(mine));
}

// ------------------------------------------------------------------ report
const bad = results.filter((r) => r.status === "DIVERGE");
const dev = results.filter((r) => r.status === "DEVIATION");
for (const r of results) if (r.status !== "PARITY") {
  console.log(`${r.status} ${r.name}${r.deviation ? " — " + r.deviation : ""}`);
  console.log("  upstream:", JSON.stringify(r.expected).slice(0, 400));
  console.log("  port    :", JSON.stringify(r.actual).slice(0, 400));
}
console.log(`extract parity: ${results.length - bad.length - dev.length} PARITY, ${dev.length} DEVIATION, ${bad.length} DIVERGE of ${results.length}`);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 1) + "\n");
process.exit(bad.length ? 1 : 0);
