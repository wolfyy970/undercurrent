// tools/llm.mjs — fuzz adapter for `llm`. NETWORK-SAFE BY CONSTRUCTION: every
// scenario either strips all provider API keys (both sides must die on the
// same "no API key" usage path before any network attempt) or points
// LLM_API_URL at a closed local port (127.0.0.1:9, "connection refused" —
// the same deterministic no-network trick parity/llm/run-parity.mjs uses),
// with LLM_RETRIES=0 so a divergence run finishes fast. No scenario is ever
// given a real provider URL.
//
// CLASSIFICATION (2026-10-29): TRANSPORT ONLY, no model text. Scenarios are closed-port or no-key runs: no server
// answers at all.

import { runBash, runTs, normalize } from "./common.mjs";
import { randomSentence, integerish, namedBytes, randomBytesFixture, randomArgvBytesFixture } from "../lib/gen.mjs";
import { isLlmTransportTextFamily, isLlmInvalidMessagesJsonFamily, isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "llm";
export const bashEnv = "PARITY_BASH_LLM";
export const bashRel = "bin/llm";
export const tsRel = "llm.mjs";

const PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "opencode", "opencode-go", "openai-compatible", "adapter", "bogus-provider"];
const KEY_ENVS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "openai-compatible": "LLM_API_KEY",
};
const CLOSED_URL = "http://127.0.0.1:9/x";

export function generate(rng) {
  const argv = [];
  const env = { LLM_RETRIES: "0" };
  const noKeys = rng.bool(0.35);

  if (rng.bool(0.1)) return { group: "help", argv: [rng.pick(["-h", "--help"])], env: {} };

  if (rng.bool(0.5)) argv.push("-m", rng.pick(["claude-sonnet-4-5", "gpt-5", "gemini-2.0-flash", "z-ai/glm-5.2", "my-local-alias", ""]));
  if (!noKeys) {
    const provider = rng.pick(PROVIDERS);
    if (rng.bool(0.6)) argv.push("--provider", provider);
    const keyEnv = KEY_ENVS[provider];
    if (keyEnv) env[keyEnv] = "fuzz-test-key";
    else env.OPENAI_API_KEY = "fuzz-test-key"; // adapter/bogus still needs SOME key set to pass the first gate
    env.LLM_API_URL = CLOSED_URL;
    if (provider === "adapter") env.LLM_ADAPTER = "/bin/false";
  }

  const bodyChoice = rng.pickWeighted([["prompt", 5], ["messages", 2], ["stdin", 2], ["none", 1]]);
  let stdin;
  if (bodyChoice === "prompt") argv.push(rng.bool(0.85) ? randomSentence(rng, 1, 10) : namedBytes(randomArgvBytesFixture(rng)).toString("utf8"));
  else if (bodyChoice === "messages") argv.push("-M", rng.pick(['[{"role":"user","content":"hi"}]', "not json", "[]", "{}"]));
  else if (bodyChoice === "stdin") stdin = rng.bool(0.85) ? randomSentence(rng, 1, 10) : namedBytes(randomBytesFixture(rng)).toString("utf8");

  if (rng.bool(0.2)) argv.push("-t", integerish(rng));
  if (rng.bool(0.2)) argv.push("-s", randomSentence(rng, 1, 6));
  if (rng.bool(0.2)) argv.push("--no-stream");
  if (rng.bool(0.15)) argv.push("--thinking", rng.pick(["", "low", "medium", "high", "xhigh", "bogus"]));
  if (rng.bool(0.15)) argv.push("--effort", rng.pick(["low", "medium", "high", "xhigh", "max", "bogus"]));
  if (rng.bool(0.1)) argv.push("--raw");
  if (rng.bool(0.05)) argv.push("--bogus-flag");

  return { group: noKeys ? "no-keys" : "closed-port", argv, env, stdin };
}

export function execute(scenario, ctx) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/API_KEY$|_API_URL$|^LLM_/.test(k)) delete env[k];
  }
  env.LC_ALL = "C";
  Object.assign(env, scenario.env);
  const input = scenario.stdin != null ? Buffer.from(scenario.stdin, "utf8") : Buffer.alloc(0);
  const bash = runBash(ctx.bashPath, scenario.argv, { env, input, timeout: 12000 });
  const ts = runTs(ctx.REPO, tsRel, scenario.argv, { env, input, timeout: 12000 });
  return { bash, ts, roots: { bash: [], ts: [] } };
}

export function compare(scenario, result) {
  const { bash, ts } = result;
  const bOut = normalize(bash.stdout, []);
  const tOut = normalize(ts.stdout, []);
  const bErr = normalize(bash.stderr, []);
  const tErr = normalize(ts.stderr, []);
  const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bash.status === ts.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  let allowed = false;
  let allowReason = null;
  if (!pass && cmp.stdout) {
    if (cmp.status && isLlmTransportTextFamily({ argv: scenario.argv, bashStderr: bErr, tsStderr: tErr })) {
      allowed = true;
      allowReason = "documented deviation: llm transport-failure wording on the streaming path — curl text vs fetch/undici text (parity/llm 'transport-text' deviation catalogue entry, PARITY.md llm row)";
    } else if (isLlmInvalidMessagesJsonFamily({ argv: scenario.argv, bashStderr: bErr, tsStderr: tErr })) {
      allowed = true;
      allowReason = "documented deviation: llm invalid -M/--messages JSON — bash dies inside jq (exit 5), port dies with its own message (exit 1) (parity/llm 'invalid-messages-json' deviation catalogue entry, PARITY.md llm row)";
    } else if (cmp.status && isBashLineWordingDeviation({ exitMatch: cmp.status, stdoutMatch: cmp.stdout, stateMatch: undefined, bashStderr: bErr, tsStderr: tErr })) {
      allowed = true;
      allowReason = "documented deviation: bash internal ${var:?}/[[ ]] line-wording vs port's clean error text (shared cross-tool pattern, PARITY.md mem row M1 fix + retrieval row)";
    }
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status }, ts: { stdout: tOut, stderr: tErr, status: ts.status } },
  };
}
