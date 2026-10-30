// Parse and normalize shellm/Headlong trajectory JSONL into the wire shape
// the viewer renders (steps + inline run groups).
//
// Faithful TypeScript port of headlong/web/src/headlong_web/trajectory.py
// (Apache-2.0, laude-institute/headlong). The Python original carries an
// append-aware, memory-bounded parse cache for 500MB+ mind logs; this port
// keeps the same NORMALIZATION but parses the whole file per identity (the
// port's mind logs are small — pax's is ~4.7MB / 1200 steps). The normalized
// output is byte-identical to the Python backend for the same input, which is
// what lets the unchanged React components render identically (see parity/ui).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { resolveSourceUrl } from "./chat-links.ts";

export type Raw = Record<string, unknown>;

export interface NormalizedStep {
  step_id: string;
  ts: string;
  type: string;
  source: string | null;
  preview: string;
  raw: Raw | null;
  run_id: string | null;
  source_url?: string | null;
  fork?: { child_traj_id: string; slug: string; resolved: boolean };
  writeback?: { from_traj: string; from_step: string | null };
}

export interface RunGroupDict {
  run_id: string;
  trigger_step_id: string | null;
  launched_by: string | null;
  step_ids: string[];
  started_ts: string;
  ended_ts: string | null;
  status: string; // running | done
  command: string;
  command_truncated: boolean;
  model: string | null;
  tldr: string | null;
  last_touch: number;
}

// Step types written by the shellm loop itself (never carry `source`).
export const MACHINERY_TYPES = new Set([
  "shellm-run",
  "prompt",
  "reasoning",
  "shell-output",
  "feedback",
  "final",
  "run-summary",
]);

// Step types the chat view renders (mirrored by chat.ts).
export const CHAT_MESSAGE_TYPES = new Set(["message", "human-msg", "agent-msg"]);

const _CMD_HEAD = 800;
const _CMD_TAIL = 1200;
const _CHAT_FIELDS = [
  "type",
  "ts",
  "step_id",
  "content",
  "from",
  "to",
  "reply_to",
  "filename",
  "source_url",
] as const;

/** Dashboard copy of a step: drop file bytes. The UI shows `filename` and
 *  the short `content` marker; `content_b64` only inflates the JSON.
 *  PORT-NOTE (1c: c647609): port of trajectory.py's `_wire_raw`. Unlike the
 *  Python cache (which evicts/rehydrates raw records), this port always
 *  keeps the whole parsed file in memory (see the file header), so this is
 *  applied once, permanently, on ingest rather than at each cache read. */
function wireRaw(raw: Raw | null): Raw | null {
  if (raw === null || !("content_b64" in raw)) return raw;
  const stripped = { ...raw };
  delete stripped["content_b64"];
  return stripped;
}

function truncateCommand(command: string): [string, boolean] {
  if (command.length <= _CMD_HEAD + _CMD_TAIL + 200) return [command, false];
  const omitted = command.length - _CMD_HEAD - _CMD_TAIL;
  return [
    command.slice(0, _CMD_HEAD) +
      `\n[… ${omitted} chars truncated …]\n` +
      command.slice(command.length - _CMD_TAIL),
    true,
  ];
}

function collapse(text: string, limit = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function firstStr(raw: Raw, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** One-line preview per step type (ports bin/traj's formatter). */
export function stepPreview(raw: Raw): string {
  const stepType = (raw["type"] as string) ?? "";
  if (stepType === "reasoning") {
    const thought = collapse(firstStr(raw, "thought", "content"), 100);
    const cmd = collapse(firstStr(raw, "cmd"), 120);
    return thought && cmd ? `${thought} | ${cmd}` : thought || cmd;
  }
  if (stepType === "shell-output") {
    const exitCode = raw["exit"];
    const head = collapse(firstStr(raw, "stdout") || firstStr(raw, "stderr"), 120);
    return exitCode !== undefined && exitCode !== null ? `exit ${exitCode} · ${head}` : head;
  }
  if (stepType === "shellm-run") return collapse(firstStr(raw, "command"), 160);
  if (stepType === "run-summary") return collapse(firstStr(raw, "tldr"), 160);
  if (stepType === "final") {
    const content = collapse(firstStr(raw, "content", "thought"), 100);
    const cmd = collapse(firstStr(raw, "cmd"), 120);
    return content && cmd ? `${content} | ${cmd}` : content || cmd;
  }
  if (stepType === "fork") return `-> ${firstStr(raw, "child_ref", "child")}`;
  if (stepType === "merge") {
    const content = collapse(firstStr(raw, "content"), 140);
    return content ? `<- ${content}` : `<- ${firstStr(raw, "from_traj")}`;
  }
  if (stepType === "trajectory") {
    const parent = firstStr(raw, "parent_traj");
    return parent ? `<- parent: ${parent.slice(0, 8)}` : "root";
  }
  if (stepType === "message") {
    const sender = firstStr(raw, "from");
    const content = collapse(firstStr(raw, "content"), 140);
    return sender ? `${sender}: ${content}` : content;
  }
  return collapse(firstStr(raw, "content", "thought"), 160);
}

function actionSuffix(command: string): string | null {
  const idx = command.lastIndexOf("ACTION:");
  if (idx === -1) return null;
  return collapse(command.slice(idx + "ACTION:".length));
}

class RunGroup {
  run_id: string;
  trigger_step_id: string | null = null;
  launched_by: string | null = null;
  step_ids: string[] = [];
  started_ts = "";
  ended_ts: string | null = null;
  status = "running";
  command = "";
  command_truncated = false;
  model: string | null = null;
  tldr: string | null = null;
  last_touch = 0;

  constructor(run_id: string) {
    this.run_id = run_id;
  }

  toDict(): RunGroupDict {
    return {
      run_id: this.run_id,
      trigger_step_id: this.trigger_step_id,
      launched_by: this.launched_by,
      step_ids: this.step_ids,
      started_ts: this.started_ts,
      ended_ts: this.ended_ts,
      status: this.status,
      command: this.command,
      command_truncated: this.command_truncated,
      model: this.model,
      tldr: this.tldr,
      last_touch: this.last_touch,
    };
  }
}

/** Stateful step normalizer: feed raw steps in order, read results after. */
export class Normalizer {
  steps: NormalizedStep[] = [];
  chatIndex: Raw[] = [];
  runs: RunGroup[] = [];
  fullCommands = new Map<string, string>(); // run_id -> untruncated command
  private runsById = new Map<string, RunGroup>();
  private unmatchedActions: NormalizedStep[] = [];
  private seenStepIds = new Set<string>();
  // PORT-NOTE (1c: f68c1d8): persists for the Normalizer's whole lifetime
  // (unlike chat.ts's per-call map) so a reply arbitrarily far downstream of
  // the original inbound message still inherits its Slack permalink.
  private messageSourceUrls: Record<string, string> = {};
  private trajDir: string;

  constructor(trajDir: string) {
    this.trajDir = trajDir;
  }

  ingest(raw: Raw): void {
    const stepType = (raw["type"] as string) ?? "";
    const source = (raw["source"] as string | undefined) ?? null;
    const stepId = (raw["step_id"] as string) ?? "";
    const ts = (raw["ts"] as string) ?? "";

    const normalized: NormalizedStep = {
      step_id: stepId,
      ts,
      type: stepType,
      source,
      preview: stepPreview(raw),
      raw: wireRaw(raw),
      run_id: null,
    };

    // Fork / write-back links
    if (stepType === "fork" && raw["child"]) {
      const childRef = (raw["child_ref"] as string) ?? "";
      let slug = childRef ? childRef.split("/")[0] : String(raw["child"]).slice(0, 8);
      let resolved =
        Boolean(childRef) && existsSync(join(this.trajDir, childRef));
      if (!resolved) {
        const hex8 = String(raw["child"]).slice(0, 8);
        let matches: string[] = [];
        try {
          matches = globSync(`${hex8}-*/trajectory.jsonl`, { cwd: this.trajDir });
        } catch {
          matches = [];
        }
        if (matches.length) {
          slug = matches[0].split("/")[0];
          resolved = true;
        }
      }
      normalized.fork = {
        child_traj_id: raw["child"] as string,
        slug,
        resolved,
      };
    }
    if (raw["from_traj"]) {
      normalized.writeback = {
        from_traj: raw["from_traj"] as string,
        from_step: (raw["from_step"] as string | undefined) ?? null,
      };
    }

    // Inline-run grouping (machinery steps carry no source)
    if (source === null && MACHINERY_TYPES.has(stepType)) {
      if (stepType === "shellm-run") {
        const fullCommand = (raw["command"] as string) ?? "";
        const [command, truncated] = truncateCommand(fullCommand);
        const run = new RunGroup(stepId);
        run.started_ts = ts;
        run.command = command;
        run.command_truncated = truncated;
        run.model = (raw["model"] as string | undefined) ?? null;
        run.launched_by = (raw["launched_by"] as string | undefined) ?? null;
        this.fullCommands.set(stepId, fullCommand);

        const trigger = raw["trigger_step"] as string | undefined;
        if (trigger) {
          if (this.seenStepIds.has(trigger)) {
            run.trigger_step_id = trigger;
            this.unmatchedActions = this.unmatchedActions.filter(
              (a) => a.step_id !== trigger,
            );
          }
        } else {
          const suffix = actionSuffix(fullCommand);
          if (suffix) {
            for (let i = this.unmatchedActions.length - 1; i >= 0; i--) {
              const action = this.unmatchedActions[i];
              const actionText = collapse(String(action.raw?.["content"] ?? ""));
              if (
                actionText &&
                (actionText.startsWith(suffix.slice(0, 200)) ||
                  suffix.startsWith(actionText.slice(0, 200)))
              ) {
                run.trigger_step_id = action.step_id;
                this.unmatchedActions.splice(i, 1);
                break;
              }
            }
          }
        }
        this.runs.push(run);
        this.runsById.set(run.run_id, run);
        run.step_ids.push(stepId);
        run.last_touch = this.steps.length;
        normalized.run_id = run.run_id;
      } else {
        const run = this.runsById.get((raw["run_id"] as string) || "");
        if (run !== undefined) {
          run.step_ids.push(stepId);
          run.last_touch = this.steps.length;
          normalized.run_id = run.run_id;
          if (stepType === "run-summary") {
            run.tldr = (raw["tldr"] as string | undefined) || run.tldr;
          } else if (stepType === "final") {
            run.status = "done";
            run.ended_ts = ts;
          }
        }
      }
    } else if (stepType === "action") {
      this.unmatchedActions.push(normalized);
    }

    // A reply points back to the inbound message it answers. Resolve its
    // source link once here so every viewer gets the same exact Slack
    // permalink, even after the raw record has had content_b64 stripped.
    // PORT-NOTE (1c: f68c1d8).
    if (CHAT_MESSAGE_TYPES.has(stepType)) {
      normalized.source_url = resolveSourceUrl(raw, this.messageSourceUrls);
    }

    // Chat index
    if (CHAT_MESSAGE_TYPES.has(stepType) && raw["content"]) {
      const entry: Raw = {};
      for (const k of _CHAT_FIELDS) if (k in raw) entry[k] = raw[k];
      this.chatIndex.push(entry);
    } else if (stepType === "observation" && raw["trigger_step"]) {
      this.chatIndex.push({
        type: "observation",
        trigger_step: raw["trigger_step"],
        decision: raw["decision"],
        content: String(raw["content"] ?? "").slice(0, 100),
      });
    }

    if (stepId) this.seenStepIds.add(stepId);
    this.steps.push(normalized);
  }

  runsDict(): RunGroupDict[] {
    return this.runs.map((r) => r.toDict());
  }

  trajId(): string {
    return this.steps.length ? this.steps[0].step_id : "";
  }
}

function* iterJsonl(text: string): Generator<Raw> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record && typeof record === "object" && !Array.isArray(record)) {
      yield record as Raw;
    }
  }
}

export interface LoadedTrajectory {
  steps: NormalizedStep[];
  runs: RunGroupDict[];
  traj_id: string;
  step_count: number;
  normalizer: Normalizer;
}

/** Parse + normalize a trajectory dir whole (skipping malformed lines). */
export function loadTrajectory(trajDir: string): LoadedTrajectory {
  const jsonl = join(trajDir, "trajectory.jsonl");
  const normalizer = new Normalizer(trajDir);
  let text = "";
  try {
    text = readFileSync(jsonl, "utf-8");
  } catch {
    text = "";
  }
  for (const raw of iterJsonl(text)) normalizer.ingest(raw);
  return {
    steps: normalizer.steps,
    runs: normalizer.runsDict(),
    traj_id: normalizer.trajId(),
    step_count: normalizer.steps.length,
    normalizer,
  };
}

export interface WindowResult {
  steps: NormalizedStep[];
  runs: RunGroupDict[];
  traj_id: string;
  step_count: number;
  since: number | null;
}

/** Window [since, until) over a loaded trajectory. ?tail=N maps to the last
 * N steps when since is null; the returned `since` echoes the effective
 * window start (mirrors trajectory.py TrajectoryCache.window). */
export function windowTrajectory(
  loaded: LoadedTrajectory,
  opts: { since?: number | null; until?: number | null; tail?: number | null } = {},
): WindowResult {
  const count = loaded.step_count;
  let since = opts.since ?? null;
  const until = opts.until ?? null;
  const tail = opts.tail ?? null;
  if (since === null && tail !== null) since = Math.max(0, count - tail);
  const lo = since === null ? 0 : Math.max(0, Math.min(since, count));
  const hi = until === null ? count : Math.max(lo, Math.min(until, count));
  return {
    steps: loaded.steps.slice(lo, hi),
    runs: loaded.runs,
    traj_id: loaded.traj_id,
    step_count: count,
    since,
  };
}
