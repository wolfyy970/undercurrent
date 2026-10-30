// lib/replay.mjs — the fuzzer's model: ONE replay server per tool (parity/support/replayChild.mjs, a child process,
// because the fuzzer runs each side with spawnSync) serving RECORDED real DeepSeek replies in cycle, reused from the
// matching parity harness's recordings, or labelled HTTP TRANSPORT fixtures. No model text is written here.
// Each side runs its own real `llm` (upstream's bin/llm for the Bash tool, the port's bin/llm for the port).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUPPORT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../support");
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const servers = new Map();

/** Start (once per key) a replay child and return { url(scenario, side), takeMisses() }. Synchronous. */
export function replayServer(key, opts) {
  if (servers.has(key)) return servers.get(key);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fuzz-replay-${key}-`));
  const portFile = path.join(tmp, "port"), missFile = path.join(tmp, "misses");
  fs.writeFileSync(missFile, "");
  const child = spawn(process.execPath, [path.join(SUPPORT, "replayChild.mjs"), JSON.stringify({ ...opts, portFile, missFile })], { stdio: ["ignore", "ignore", "inherit"] });
  child.unref();
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) sleepMs(50);
  if (!fs.existsSync(portFile)) throw new Error(`fuzz replay server ${key} did not start`);
  sleepMs(20);
  const port = fs.readFileSync(portFile, "utf8").trim();
  let read = 0;
  const s = {
    url: (scenario, side) => `http://127.0.0.1:${port}/r/${encodeURIComponent(scenario)}/${encodeURIComponent(side)}/v1/chat/completions`,
    /** Misses since the last call (the child flushes every 200 ms). */
    takeMisses() {
      sleepMs(250);
      const all = fs.readFileSync(missFile, "utf8").split("\n").filter(Boolean);
      const out = all.slice(read);
      read = all.length;
      return out;
    },
  };
  servers.set(key, s);
  return s;
}

/** Route env for one side: its own real `llm` first on PATH, pointed at the replay server. */
export function routeEnv(env, { llmDir, url }) {
  for (const k of ["LLM_PROVIDER", "LLM_API_URL", "LLM_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[k];
  return { ...env, PATH: `${llmDir}:${env.PATH}`, LLM_PROVIDER: "openai-compatible", LLM_API_URL: url, LLM_API_KEY: "replay-not-a-key", LLM_RETRY_BACKOFF: "0" };
}

/** A directory holding just a symlink named `llm` to the given real llm. */
export function llmDir(realLlm) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-llmbin-"));
  fs.symlinkSync(realLlm, path.join(d, "llm"));
  return d;
}
