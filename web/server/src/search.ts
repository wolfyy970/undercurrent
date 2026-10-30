// Mind-log search: case-insensitive substring scan, newest hit first.
// Port of headlong/web/src/headlong_web/search.py (Apache-2.0).
// The whole log is in memory here, so this is the simple single-pass form.

import { MACHINERY_TYPES, type NormalizedStep } from "./trajectory.ts";

const FIELD_CAP = 16 * 1024;
const SNIPPET_RADIUS = 60;
const TEXT_FIELDS = ["content", "thought", "cmd", "tldr", "command", "stdout", "stderr"];

export interface SearchHit {
  index: number;
  step_id: string | null;
  ts: string | null;
  type: string;
  source: string | null;
  run_id: string | null;
  field: string;
  snippet: string;
}

export interface SearchResult {
  q: string;
  scope: string;
  total: number;
  hits: SearchHit[];
}

function snippet(text: string, pos: number, needleLen: number): string {
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, pos + needleLen + SNIPPET_RADIUS);
  const body = text.slice(start, end).split(/\s+/).filter(Boolean).join(" ");
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${body}${suffix}`;
}

export function searchSteps(
  steps: NormalizedStep[],
  q: string,
  scope = "thoughts",
  limit = 50,
): SearchResult {
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  let total = 0;
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const stepType = step.type || "";
    if (scope !== "all" && MACHINERY_TYPES.has(stepType)) continue;
    const raw = step.raw ?? {};
    let matchedField: string | null = null;
    let matchedPos = -1;
    let haystack = "";
    for (const field of TEXT_FIELDS) {
      const value = raw[field];
      if (typeof value !== "string" || !value) continue;
      const capped = value.slice(0, FIELD_CAP);
      const pos = capped.toLowerCase().indexOf(needle);
      if (pos !== -1) {
        matchedField = field;
        matchedPos = pos;
        haystack = capped;
        break;
      }
    }
    if (matchedField === null) {
      const preview = step.preview || "";
      const pos = preview.toLowerCase().indexOf(needle);
      if (pos !== -1) {
        matchedField = "preview";
        matchedPos = pos;
        haystack = preview;
      }
    }
    if (matchedField === null) continue;
    total += 1;
    if (hits.length < limit) {
      hits.push({
        index,
        step_id: step.step_id,
        ts: step.ts,
        type: stepType,
        source: step.source,
        run_id: step.run_id,
        field: matchedField,
        snippet: snippet(haystack, matchedPos, needle.length),
      });
    }
  }
  return { q, scope, total, hits };
}
