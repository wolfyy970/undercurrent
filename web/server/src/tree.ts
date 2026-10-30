// Fork-tree resolution for trajectory directories.
// Port of headlong/web/src/headlong_web/tree.py (Apache-2.0).

import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, basename, dirname } from "node:path";

type Raw = Record<string, unknown>;

function* iterSteps(jsonl: string): Generator<Raw> {
  let text: string;
  try {
    text = readFileSync(jsonl, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === "object" && !Array.isArray(r)) yield r as Raw;
    } catch {
      /* skip */
    }
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstStep(jsonl: string): Raw | null {
  for (const s of iterSteps(jsonl)) return s;
  return null;
}

function childDirs(trajDir: string): Record<string, string> {
  const children: Record<string, string> = {};
  for (const step of iterSteps(join(trajDir, "trajectory.jsonl"))) {
    if (step["type"] !== "fork" || !step["child"]) continue;
    const childId = String(step["child"]);
    const childRef = (step["child_ref"] as string) ?? "";
    let candidate = childRef ? dirname(join(trajDir, childRef)) : null;
    if (!candidate || !isFile(join(candidate, "trajectory.jsonl"))) {
      const prefix = childId.slice(0, 8) + "-";
      candidate = null;
      let entries: string[] = [];
      try {
        entries = readdirSync(trajDir).sort();
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (name.startsWith(prefix) && isFile(join(trajDir, name, "trajectory.jsonl"))) {
          candidate = join(trajDir, name);
          break;
        }
      }
    }
    if (candidate) children[childId] = candidate;
  }
  return children;
}

export function nodeSummary(trajDir: string): Record<string, unknown> {
  let trajId = "";
  let parentStepId: string | null = null;
  let startedTs = "";
  let lastTs = "";
  let stepCount = 0;
  let hasFinal = false;
  let tldr: string | null = null;
  let childCount = 0;
  for (const step of iterSteps(join(trajDir, "trajectory.jsonl"))) {
    stepCount += 1;
    const ts = (step["ts"] as string) ?? "";
    if (stepCount === 1) {
      trajId = (step["step_id"] as string) ?? "";
      parentStepId = (step["parent_step"] as string | undefined) ?? null;
      startedTs = ts;
    }
    if (ts) lastTs = ts;
    const t = step["type"];
    if (t === "final") hasFinal = true;
    else if (t === "run-summary") tldr = (step["tldr"] as string) || tldr;
    else if (t === "fork") childCount += 1;
  }
  return {
    traj_id: trajId,
    slug: basename(trajDir),
    parent_step_id: parentStepId,
    started_ts: startedTs,
    last_ts: lastTs,
    step_count: stepCount,
    has_final: hasFinal,
    tldr,
    child_count: childCount,
  };
}

export function buildTree(trajDir: string, depth = 2): Record<string, unknown> {
  const node = nodeSummary(trajDir);
  if (depth > 0 && (node["child_count"] as number) > 0) {
    const children = Object.values(childDirs(trajDir)).map((c) => buildTree(c, depth - 1));
    children.sort((a, b) => String(a["started_ts"]).localeCompare(String(b["started_ts"])));
    node["children"] = children;
  }
  return node;
}

function rglobFirstMatch(root: string, prefix: string, trajId: string): string | null {
  // Depth-limited recursive search for `${prefix}-*/trajectory.jsonl` whose
  // first step_id === trajId.
  const stack = [root];
  const matches: string[] = [];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isdir = false;
      try {
        isdir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isdir) continue;
      if (name.startsWith(prefix + "-") && isFile(join(full, "trajectory.jsonl"))) {
        matches.push(full);
      }
      stack.push(full);
    }
  }
  matches.sort();
  for (const m of matches) {
    const first = firstStep(join(m, "trajectory.jsonl"));
    if (first && first["step_id"] === trajId) return m;
  }
  return null;
}

export function findTrajDir(rootTrajDir: string, trajId: string): string | null {
  const rootFirst = firstStep(join(rootTrajDir, "trajectory.jsonl"));
  if (rootFirst && rootFirst["step_id"] === trajId) return rootTrajDir;
  return rglobFirstMatch(rootTrajDir, trajId.slice(0, 8), trajId);
}

export function breadcrumb(rootTrajDir: string, trajDir: string): { traj_id: string; slug: string }[] {
  const chain: { traj_id: string; slug: string }[] = [];
  let current: string | null = trajDir;
  let rootResolved: string;
  try {
    rootResolved = realpathSync(rootTrajDir);
  } catch {
    rootResolved = rootTrajDir;
  }
  while (current !== null) {
    const first = firstStep(join(current, "trajectory.jsonl"));
    chain.push({ traj_id: first ? (first["step_id"] as string) ?? "" : "", slug: basename(current) });
    let curResolved: string;
    try {
      curResolved = realpathSync(current);
    } catch {
      curResolved = current;
    }
    if (curResolved === rootResolved) break;
    const parent = dirname(current);
    current = isFile(join(parent, "trajectory.jsonl")) ? parent : null;
  }
  chain.reverse();
  return chain;
}
