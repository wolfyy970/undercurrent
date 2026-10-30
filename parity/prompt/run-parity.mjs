#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the wake-prompt redaction
// (upstream sync 2e39a3f: thinkers/_lib/common.sh `prompt_redact`).
//
// Runs the REAL Bash function (sourced from common.sh, jq/Oniguruma) and the TS
// port (src/promptRedact.ts) on one corpus of prompt texts with the same
// credential environment, and compares the output byte for byte.
//
// Repeatable: PARITY_UPSTREAM_ROOT=/abs/path/to/headlong node parity/prompt/run-parity.mjs
// Writes results.json + report.md beside this file. Exit 0 iff every scenario is
// PARITY or a classified deviation.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.PARITY_UPSTREAM_ROOT || "<HEADLONG_ROOT>";
const COMMON = path.join(UPSTREAM, "thinkers/_lib/common.sh");
const { promptRedact } = await import("../../src/promptRedact.ts");

const a = (c, n) => c.repeat(n);
const S = {
  ghp: "ghp_" + a("A", 24),
  pat: "github_pat_" + a("b", 24),
  slack: "xoxb-" + a("1", 12),
  sk: "sk-" + a("q", 24),
  hf: "hf_" + a("z", 24),
  aiza: "AIza" + a("k", 32),
  aws: "AKIA" + a("Z", 16),
  jwt: "eyJ" + a("a", 12) + "." + a("b", 12) + "." + a("c", 12),
  stripe: "sk_live_" + a("9", 10),
  whsec: "whsec_" + a("w", 10),
  npm: "npm_" + a("n", 22),
  glpat: "glpat-" + a("g", 12),
  dckr: "dckr_pat-" + a("d", 12),
  sg: "SG." + a("s", 12) + "." + a("t", 12),
  twilio: "SK" + a("0", 32),
  mailgun: "key-" + a("m", 22),
};
const ENV_TOKEN = "env-held-secret-" + a("x", 10);
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcDEF123+/=\n-----END RSA PRIVATE KEY-----";
const rec = (o) => JSON.stringify(o);

const scenarios = [
  ["plain-text-untouched", "Recent stream\nnothing secret here\n\nRouting signals:\n- (no special signals)"],
  ["empty", ""],
  ["every-shape", Object.entries(S).map(([k, v]) => `${k}: ${v}`).join("\n")],
  ["sk-needs-edge", "xsk-" + a("q", 24) + " and (sk-" + a("q", 24) + ")"],
  ["env-value", `token is ${ENV_TOKEN} ok`],
  ["env-value-in-json-record", rec({ type: "observation", content: `saw ${ENV_TOKEN} here`, step_id: "abc" })],
  ["card-spaced", "pay with 4111 1111 1111 1111 please"],
  ["card-dashed-amex-style", "4111-1111-1111-1111 and 3782-822463-10005"],
  ["card-bare-16", "number 4111111111111111."],
  ["card-bare-15", "n=378282246310005 end"],
  ["card-bare-glued-letters", "a4111111111111111 stays"],
  ["card-label", "my Visa is 4111 1111 1111 1111 now; card: 5555-5555-5555-4444"],
  ["card-label-the", "credit card the 4242 4242 4242 4242"],
  ["card-17-digits-not-card", "id 41111111111111111 stays"],
  ["basic-auth-url", "git clone https://user:hunter2@example.com/x.git"],
  ["docker-auth-text", '{"auth": "' + a("A", 20) + '"} and "auth" : "' + a("B", 16) + '"'],
  ["docker-auth-key-value", rec({ auth: a("Q", 24), other: "x" })],
  ["aws-secret", "aws_secret_access_key = abcdEFGH1234/+xyz and AWS_SECRET_ACCESS_KEY: foo"],
  ["pem-complete-plain", "before\n" + PEM + "\nafter"],
  ["pem-two-blocks", PEM + "\nmid\n" + PEM],
  ["pem-open-plain", "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nYWJjZGVm\n\nRouting signals:\n- keep me"],
  ["pem-open-then-begin", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\ntail"],
  ["pem-inside-json-field", rec({ type: "shell-output", stdout: "x " + PEM + " y" })],
  ["pem-open-inside-json-field", rec({ type: "shell-output", stdout: "x -----BEGIN PRIVATE KEY-----\nAAAA\nBBBB", other: "kept" })],
  ["json-key-redacted", rec({ ["k" + S.hf]: "v", content: "c" })],
  ["json-array-elements", rec([S.ghp, "plain", { content: S.slack }])],
  ["json-untouched-line-verbatim", '{"type":"thought",  "content":"spaces   kept"}'],
  ["json-line-with-escapes", rec({ content: "tab\there \u00e9 \"q\" " + S.ghp })],
  ["json-scalar-line", "42\nnull\ntrue"],
  ["mixed-stream", ["Recent stream:", rec({ type: "thought", content: "has " + S.ghp }), rec({ type: "idle", content: "idle" }), "Routing signals:", "- x " + S.sk].join("\n")],
  ["trailing-newline", "text " + S.ghp + "\n"],
  ["only-newlines", "\n\n\n"],
  ["unicode-around-secret", "héllo wörld ✓ " + S.slack + " 日本語"],
  ["slack-xoxp-long", "xoxp-" + a("1", 8) + "-" + a("2", 8) + "-" + a("3", 8)],
  ["short-env-not-masked", "value shortval stays"],
];

function runBash(input, env) {
  const r = spawnSync("bash", ["-c", 'source "$1"; prompt_redact "$2"', "_", COMMON, input], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, rc: r.status };
}

const credEnv = { GITHUB_TOKEN: ENV_TOKEN, OPENAI_API_KEY: "shortval".slice(0, 7), SLACK_TOKEN: "ab" };
const results = [];
for (const [name, input] of scenarios) {
  const env = { ...credEnv };
  const b = runBash(input, env);
  const t = promptRedact(input, { ...process.env, ...env });
  const ok = b.rc === 0 && b.stdout === t;
  results.push({ name, verdict: ok ? "PARITY" : "DIVERGE", bash: ok ? undefined : b, ts: ok ? undefined : t });
}
const bad = results.filter((r) => r.verdict !== "PARITY");
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(
  path.join(HERE, "report.md"),
  `# prompt_redact differential\n\n${results.length - bad.length}/${results.length} PARITY\n\n` +
    results.map((r) => `- ${r.verdict} ${r.name}`).join("\n") + "\n",
);
console.log(`prompt parity: ${results.length - bad.length}/${results.length} PARITY`);
for (const r of bad) console.log(`DIVERGE ${r.name}\n  bash=${JSON.stringify(r.bash)}\n  ts=${JSON.stringify(r.ts)}`);
process.exit(bad.length ? 1 : 0);
