// Under Bun, no bin/* tool may lose stdout or stderr when it exits (src/stdioSync.ts PORT-NOTE). Bun queued a pipe
// write it could not finish at once and process.exit() dropped the queue: a slow reader got 65,295 bytes of a 200 KB
// answer, and under CPU load a 1.8 KB `llm` reply was cut mid-text with exit 0. Each case runs a real tool on Bun with
// a reader that pauses for a second (so the 64 KiB pipe fills) and compares every byte with the same run on Node.
// Inputs are test data: a wire-format fixture for llm (one SSE delta of placeholder text, not model output), seeded
// trajectory/recap/memory files, and an unknown option that the tool echoes in its error.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const BUN = spawnSync("bun", ["--version"]).status === 0;
const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin");

interface Case {
  tool: string;
  args: string[];
  stdin?: string;
  stream: "stdout" | "stderr";
  env?: Record<string, string>;
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "TRAJ_DIR", "TRAJ_ID", "IDENTITY_DIR", "IDENTITY_NAME"]) delete env[k];
  return { ...env, ...extra };
}

/** Run on `runtime` with a reader that waits 1 s before it starts reading. */
function runSlowReader(runtime: string, c: Case): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    const ch = spawn(runtime, [path.join(BIN, `${c.tool}.mjs`), ...c.args], { env: baseEnv(c.env), stdio: ["pipe", "pipe", "pipe"] });
    ch.stdin.end(c.stdin ?? "");
    const chunks: Buffer[] = [];
    const watched = ch[c.stream];
    const other = c.stream === "stdout" ? ch.stderr : ch.stdout;
    other.resume();
    watched.pause();
    watched.on("data", (d: Buffer) => chunks.push(d));
    setTimeout(() => watched.resume(), 1000);
    ch.on("close", (code) => resolve({ code, out: Buffer.concat(chunks) }));
  });
}

let tmp = "";
let srv: http.Server;
const cases: Record<string, Case> = {};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bun-stdio-"));
  // llm: one SSE delta of 200 KB placeholder text (transport fixture).
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "y".repeat(200_000) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  cases["llm"] = { tool: "llm", args: ["-m", "m", "-s", "sys"], stdin: "hello", stream: "stdout", env: { LLM_PROVIDER: "openai-compatible", LLM_API_URL: `http://127.0.0.1:${port}/v1/chat/completions`, LLM_API_KEY: "fixture-not-a-key", LLM_RETRIES: "0" } };
  // traj, chat: a trajectory of four 60 KB messages.
  const run = path.join(tmp, "traj", "aaaaaaaa-run");
  fs.mkdirSync(path.join(run, "recap"), { recursive: true });
  const msgs = [0, 1, 2, 3].map((i) => JSON.stringify({ type: "message", step_id: `m000000${i}`, ts: `2026-01-01T00:0${i}:00Z`, from: "x", to: "pax", source: "chat", content: "q".repeat(60_000) }));
  fs.writeFileSync(path.join(run, "trajectory.jsonl"), msgs.join("\n") + "\n");
  const trajEnv = { TRAJ_DIR: path.join(tmp, "traj"), TRAJ_ID: "aaaaaaaa-run", IDENTITY_NAME: "pax" };
  cases["traj"] = { tool: "traj", args: ["cat", "aaaaaaaa-run", "--raw"], stream: "stdout", env: trajEnv };
  cases["chat"] = { tool: "chat", args: ["history"], stream: "stdout", env: trajEnv };
  // recap: a cached recap (seeded test data, read under --cached; the llm is never called).
  fs.writeFileSync(path.join(run, "recap", "themes.json"), JSON.stringify({ generated_at: "2026-01-01T00:00:00", model: "m", episodes: 1, raw_end_line: 4, total_lines: 4, arc: "a".repeat(100_000), themes: [] }, null, 2) + "\n");
  fs.writeFileSync(path.join(run, "recap", "episodes.jsonl"), JSON.stringify({ idx: 1, raw_start_line: 1, raw_end_line: 4, first_step: "m0000000", last_step: "m0000003", first_ts: "2026-01-01T00:00:00Z", last_ts: "2026-01-01T00:03:00Z", n_steps: 4, partial: false, model: "m", created: "c", title: "t", summary: "s".repeat(100_000), themes: [], notable_steps: [] }) + "\n");
  cases["recap"] = { tool: "recap", args: ["aaaaaaaa-run", "--cached"], stream: "stdout", env: { TRAJ_DIR: path.join(tmp, "traj") } };
  // mem: one 150 KB memory, shown whole.
  const memDir = path.join(tmp, "mem");
  fs.mkdirSync(memDir);
  fs.writeFileSync(path.join(memDir, "2026-01-01-01-00-00_abcdef12_big.md"), `---\nid: abcdef12\ntype: note\n---\n\n${"m".repeat(150_000)}\n`);
  cases["mem"] = { tool: "mem", args: ["--dir", memDir, "show", "abcdef12"], stream: "stdout" };
  // shellm: its error for an unknown option echoes the option (stderr).
  cases["shellm"] = { tool: "shellm", args: [`--bogus-${"p".repeat(100_000)}`], stream: "stderr" };
});
afterAll(() => {
  srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!BUN)("bin/* on Bun: output survives exit to a slow reader", () => {
  for (const tool of ["llm", "shellm", "mem", "recap", "traj", "chat"]) {
    it(`${tool}: every byte of its ${tool === "shellm" ? "stderr" : "stdout"} arrives, same exit code as on Node`, async () => {
      const c = cases[tool]!;
      const want = await runSlowReader(process.execPath, c);
      expect(want.out.length).toBeGreaterThan(70_000); // more than a pipe holds, or the case proves nothing
      const got = await runSlowReader("bun", c);
      expect(got.code).toBe(want.code);
      expect(got.out.length).toBe(want.out.length);
      expect(got.out.equals(want.out)).toBe(true);
    }, 60_000);
  }
});
