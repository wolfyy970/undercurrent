// llmCliClient.ts — an LlmClient that makes its model calls the way upstream does: through the `llm` tool.
//
// BEHAVIORAL-PARITY ROUND (W1): upstream's shellm loop (bin/shellm:1737-1745 call_llm) and responder
// (thinkers/responder/step:57-66 _reply_llm) never talk to a provider themselves; they run `llm`. So the request on
// the wire is whatever `llm` builds: for the openai-compatible/openrouter family it STREAMS (`stream:true`,
// `stream_options.include_usage`), sends `max_tokens` (the per-model default, 16384 for most), and sends NO
// `reasoning` field (bin/llm only sends one for an explicit `--thinking LEVEL` on gpt-5+/o-series).
// OpenRouterClient (src/llm.ts) instead POSTed non-streaming with `reasoning:{effort}` and no max_tokens. A real-model
// run measured the difference (docs/BEHAVIORAL-PARITY.md).
//
// This client calls the port's own `llm` CLI port (src/llmCli.ts, differentially proven against bin/llm) IN PROCESS
// with the exact argv upstream passes, so the wire shape is upstream's by construction:
//   mode "shellm": llm -m MODEL --effort E --thinking --system-prompt S --messages-file F [-t N] [--stop-after-code-block]
//   mode "plain" : llm [-t N] -m MODEL -M MESSAGES -s S [--json-schema FILE]      (responder replies, notes)
// stdout is the answer; in shellm mode stderr is the `--thinking` side channel (what the empty-response retry feeds
// back) and LLM_USAGE_FILE carries the usage record.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LlmCallError, type ChatMessage, type CompleteOptions, type LlmClient, type LlmResponse, type LlmUsage } from "./llm.ts";
import { runLlm, type LlmIO } from "./llmCli.ts";
import { spawnAdapterProcess } from "./llmAdapterProcess.ts";

export interface LlmCliClientConfig {
  mode: "shellm" | "plain";
  /** Env the `llm` call sees (API keys, LLM_API_URL, SHELLM_API_URL, …). */
  env: Record<string, string | undefined>;
  model: string;
  /** shellm mode: `--effort` (bin/shellm:1737 `--effort "$SHELLM_EFFORT"`). */
  effort?: string;
  /** `-t N` when set (shellm: SHELLM_MAX_TOKENS; plain: per-call CompleteOptions.maxTokens wins). */
  maxTokens?: number;
  /** shellm mode: `--stop-after-code-block` (bin/shellm:1740, SHELLM_STOP_AFTER_CODE_BLOCK=1 default). */
  stopAfterCodeBlock?: boolean;
  /** Test seams: fetch/sleep/etc. override the real IO. */
  io?: Partial<LlmIO>;
}

function realIo(cfg: LlmCliClientConfig, env: Record<string, string | undefined>, out: { stdout: string; stderr: string }): LlmIO {
  return {
    cwd: process.cwd(),
    env,
    stdout: (s) => void (out.stdout += s),
    stderr: (s) => void (out.stderr += s),
    readStdin: () => "",
    stdinIsTTY: false,
    now: () => new Date(),
    fetch: globalThis.fetch,
    fs: fs as unknown as LlmIO["fs"],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnAdapter: spawnAdapterProcess,
    randomToken: () => crypto.randomBytes(6).toString("hex"),
    ...(cfg.io ?? {}),
  };
}

export class LlmCliClient implements LlmClient {
  private readonly cfg: LlmCliClientConfig;
  constructor(cfg: LlmCliClientConfig) {
    this.cfg = cfg;
  }

  async complete(system: string, messages: ChatMessage[], opts: CompleteOptions = {}): Promise<LlmResponse> {
    const cfg = this.cfg;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-llm-"));
    try {
      const usageFile = path.join(tmp, "usage");
      fs.writeFileSync(usageFile, "");
      const env: Record<string, string | undefined> = { ...cfg.env, LLM_USAGE_FILE: usageFile };
      const maxTokens = opts.maxTokens ?? cfg.maxTokens;
      let args: string[];
      if (cfg.mode === "shellm") {
        // The message array rides a file, not argv (bin/shellm:1721-1724).
        const messagesFile = path.join(tmp, "messages.json");
        fs.writeFileSync(messagesFile, JSON.stringify(messages));
        args = [
          "-m", cfg.model, "--effort", cfg.effort || "high", "--thinking", "--system-prompt", system,
          "--messages-file", messagesFile,
          ...(maxTokens ? ["-t", String(maxTokens)] : []),
          ...(cfg.stopAfterCodeBlock !== false ? ["--stop-after-code-block"] : []),
        ];
      } else {
        // thinkers/responder/step:64 `llm -t "$RESPONDER_MAX_TOKENS" "$@"` with `-m M -M convo -s system [--json-schema F]`.
        args = [...(maxTokens ? ["-t", String(maxTokens)] : []), "-m", cfg.model, "-M", JSON.stringify(messages), "-s", system];
        if (opts.jsonSchema !== undefined) {
          const schemaFile = path.join(tmp, "schema.json");
          fs.writeFileSync(schemaFile, JSON.stringify(opts.jsonSchema));
          args.push("--json-schema", schemaFile);
        }
      }
      // _reply_llm: `LLM_USAGE_FILE=… LLM_MAX_TIME="$RESPONDER_MAX_TIME" LLM_RETRIES=0 llm …`
      if (opts.maxTimeMs !== undefined) env["LLM_MAX_TIME"] = String(Math.round(opts.maxTimeMs / 1000));
      if (opts.retries !== undefined) env["LLM_RETRIES"] = String(opts.retries);

      const out = { stdout: "", stderr: "" };
      const rc = await runLlm(args, realIo(cfg, env, out));
      if (rc !== 0) {
        const tail = out.stderr.length > 500 ? out.stderr.slice(-500) : out.stderr;
        throw new LlmCallError(`llm failed (exit ${rc}): ${tail}`, {
          timedOut: /timed out|curl: \(28\)/.test(out.stderr),
          truncated: out.stderr.includes("output truncated at max_tokens"),
          ...(cfg.mode === "plain" && out.stderr !== "" ? { diagnostics: out.stderr } : {}),
        });
      }

      const usage: LlmUsage = {};
      try {
        const rec = JSON.parse(fs.readFileSync(usageFile, "utf8").split("\n")[0] || "null") as Record<string, unknown> | null;
        if (rec && typeof rec === "object") {
          for (const k of ["in_tok", "out_tok", "think_tok", "cache_tok"] as const) if (typeof rec[k] === "number") usage[k] = rec[k] as number;
          if (rec["estimated"] === true) usage.estimated = true;
          if (typeof rec["served_by"] === "string" && rec["served_by"] !== "") usage.served_by = rec["served_by"] as string;
          if (rec["truncated"] === true) usage.truncated = true;
        }
      } catch {
        /* usage is best-effort, as in bin/llm */
      }
      if (out.stderr.includes("output truncated at max_tokens")) usage.truncated = true;
      const reasoning = cfg.mode === "shellm" ? out.stderr : "";
      return { text: out.stdout, ...(reasoning ? { reasoning } : {}), ...(cfg.mode === "plain" && out.stderr !== "" ? { diagnostics: out.stderr } : {}), usage };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
