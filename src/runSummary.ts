// src/runSummary.ts — `generate_run_summary` (bin/shellm:2366-2440): after a run on a NEW trajectory writes its
// shellm-run header, a cheap model call summarizes the run's inputs and one `run-summary` step
// {type, tldr, full_summary, run_id, model} is appended to the run's own trajectory (read by `traj list`, the viewer's
// tldr, and context's exclusion list). Started asynchronously at bin/shellm:2830-2840; the run waits for it up to 30 s
// before exiting (:2859-2870). Best-effort throughout: every failure ends as tldr "(summary generation failed)".
import * as fs from "node:fs";
import type { Trajectory } from "./trajectory.ts";
import { LlmCliClient } from "./llmCliClient.ts";

const MAX_CTX = 20000;
const SYSTEM = "You produce concise summaries as JSON. Output only valid JSON. No markdown fences. No preamble.";

/** bin/shellm:2377-2386: SHELLM_SUMMARY_MODEL, then SHELLM_FAST_MODEL, then haiku on Anthropic, else the run's model. */
export function summaryModelFor(env: Record<string, string | undefined>, runModel: string): string {
  const m = env["SHELLM_SUMMARY_MODEL"] || env["SHELLM_FAST_MODEL"] || "";
  if (m) return m;
  return runModel.startsWith("claude-") ? "claude-haiku-4-5-20251001" : runModel;
}

/** The prompt bin/shellm:2388-2433 builds (`$(cat)` strips trailing newlines, as the Bash does for stdin and files). */
export function summaryPrompt(prompt: string, stdin: string | undefined, files: string[]): string {
  let combined = `CLI argument: ${prompt.slice(0, MAX_CTX)}`;
  const stdinContent = (stdin ?? "").replace(/\n+$/, "");
  if (stdinContent) {
    const avail = MAX_CTX - combined.length;
    if (avail > 0) combined += "\n\nstdin:\n" + stdinContent.slice(0, avail);
  }
  for (const f of files) {
    let isFile = false;
    try {
      isFile = fs.statSync(f).isFile();
    } catch {
      /* `[[ -f "$f" ]]` */
    }
    if (!isFile) continue;
    const avail = MAX_CTX - combined.length;
    if (avail <= 0) break;
    const buf = Buffer.alloc(avail);
    const fd = fs.openSync(f, "r");
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, avail, 0); // head -c "$avail"
    } finally {
      fs.closeSync(fd);
    }
    combined += `\n\nFile ${f}:\n` + buf.subarray(0, n).toString("utf8").replace(/\n+$/, "");
  }
  const hint = combined.length > 1000 ? '"<multi-paragraph summary string>"' : "null";
  return `Analyze the context and goal of this shellm run. Respond with ONLY valid JSON (no markdown fences, no preamble) matching this schema:
{
  "tldr": "one-line summary of the context and goal of this shellm run",
  "full_summary": ${hint}
}

Inputs to the run:
${combined}`;
}

/** bin/shellm:2447-2458: strip a fence on the first/last line, drop blank lines, then read .tldr and .full_summary. */
export function parseSummary(text: string): { tldr: string; full: string } {
  if (!text) return { tldr: "", full: "" };
  const lines = text.split("\n");
  if (lines[0] === "```json" || lines[0] === "```") lines[0] = "";
  if (lines.length && lines[lines.length - 1] === "```") lines[lines.length - 1] = "";
  const cleaned = lines.filter((l) => l !== "").join("\n");
  let v: unknown;
  try {
    v = JSON.parse(cleaned);
  } catch {
    return { tldr: "", full: "" };
  }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const raw = (x: unknown): string => (x === undefined || x === null || x === false ? "" : typeof x === "string" ? x : JSON.stringify(x));
  return { tldr: raw(o["tldr"]), full: o["full_summary"] === null || o["full_summary"] === undefined ? "" : raw(o["full_summary"]) };
}

export async function generateRunSummary(opts: {
  trajectory: Trajectory;
  runStepId: string;
  prompt: string;
  stdin: string | undefined;
  files: string[];
  model: string;
  env: Record<string, string | undefined>;
}): Promise<void> {
  let text = "";
  try {
    const llm = new LlmCliClient({ mode: "plain", env: opts.env, model: opts.model, maxTokens: 2048 });
    const r = await llm.complete(SYSTEM, [{ role: "user", content: summaryPrompt(opts.prompt, opts.stdin, opts.files) }]);
    text = r.text.replace(/\n+$/, ""); // `text=$(llm …)`
  } catch {
    /* `2>/dev/null) || true` */
  }
  const { tldr, full } = parseSummary(text);
  try {
    opts.trajectory.append({ type: "run-summary", tldr: tldr || "(summary generation failed)", full_summary: full, run_id: opts.runStepId, model: opts.model });
  } catch {
    /* `|| true` */
  }
}
