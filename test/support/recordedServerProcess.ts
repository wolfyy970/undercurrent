// recordedServerProcess.ts — a recording served from a child process (test/support/recordedServerChild.ts), plus a
// `runLlm` for recap's llm boundary that runs the port's real `llm` against it with spawnSync, exactly as bin/recap
// does. The child keeps answering while this process is blocked in spawnSync.
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecapIO } from "../../src/recap.ts";
import { RECORD_MODEL, type RecordedModelOptions } from "./recordedModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(HERE, "..", "..", "bin");

export interface RecordedServerProcess {
  url: string;
  /** Env that points `llm` at the recording (LLM_API_URL and the openai-compatible provider). */
  env: Record<string, string>;
  /** recap's llm boundary: the real `llm` (bin/llm) over spawnSync, every argv it was called with in `calls`. */
  runLlm: RecapIO["runLlm"];
  calls: string[][];
  /** Stops the child; rejects when a request missed its recording. */
  close(): Promise<void>;
}

/** `opts`: httpFixtures (transport-only responses by request index), cycle and delayMs (see RecordedModelOptions). */
export async function recordedServerProcess(
  suite: string,
  scenario: string,
  opts: Pick<RecordedModelOptions, "httpFixtures" | "cycle" | "delayMs"> = {}
): Promise<RecordedServerProcess> {
  const child = spawn(process.execPath, [path.join(HERE, "recordedServerChild.ts"), suite, scenario, JSON.stringify(opts)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let err = "";
  child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (c: Buffer) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl).trim());
    });
    child.once("exit", (code) => reject(new Error(`recordedServerChild exited ${code}: ${err}`)));
  });
  const env: Record<string, string> = {
    LLM_PROVIDER: "openai-compatible",
    LLM_API_URL: url,
    LLM_API_KEY: "replay-not-a-key",
    LLM_RETRIES: "0",
    LLM_RETRY_BACKOFF: "0",
  };
  const calls: string[][] = [];
  const runLlm: RecapIO["runLlm"] = (args, stdinText) => {
    calls.push(args);
    // In record mode the provider must be sent a model it serves; the argv recap chose is still what `calls` records.
    const argv = process.env["UC_RECORD"] === "1" ? args.map((a, i) => (args[i - 1] === "-m" ? RECORD_MODEL : a)) : args;
    const res = spawnSync(path.join(BIN_DIR, "llm"), argv, {
      input: stdinText,
      encoding: "utf8",
      maxBuffer: Infinity,
      env: { PATH: `${BIN_DIR}${path.delimiter}${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "", ...env },
    });
    return { status: typeof res.status === "number" ? res.status : 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  return {
    url,
    env,
    runLlm,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(err || `recordedServerChild exit ${code}`))));
        child.stdin!.end();
      }),
  };
}
