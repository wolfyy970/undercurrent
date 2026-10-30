// UI parity proof (deterministic): render pax's real trajectory
// (55fd5932-root) through the port's TS data layer and diff the produced
// wire model against the golden captured from the ORIGINAL Python viewer
// backend (headlong/web/src/headlong_web) for the exact same file.
//
// The viewer's React components are a PURE function of this wire model
// (steps + runs + chat + activity). So byte-identical wire output ==
// identical rendered DOM for the same trajectory. We assert on structure
// (step types, order, run grouping, previews, sources, run ids, chat
// messages/outcomes, activity state) — everything deterministic from the
// file. We do NOT assert on wall-clock fields (live pip, mtime, cadence
// ages), which depend on when the server runs, not on the trajectory.
//
// Regenerate the golden with: parity/ui/gen_golden.py (runs the Python backend).
// Run this proof with:        node parity/ui/verify.ts

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTrajectory } from "../../web/server/src/trajectory.ts";
import { chatView } from "../../web/server/src/chat.ts";
import { listMemories } from "../../web/server/src/memories.ts";
import { resolveIdentity, findRootTrajDir } from "../../web/server/src/discovery.ts";
import { identityActivity } from "../../web/server/src/liveness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "golden");
const IDENTITIES = join(HERE, "..", "..", "..", "headlong", ".identities");

// ---- canonical JSON compare (order-independent object keys) --------------
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canon((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
function canonStr(value: unknown): string {
  return JSON.stringify(canon(value));
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const s = Math.max(0, i - 40);
  return `at char ${i}:\n  ts : …${a.slice(s, i + 40)}…\n  golden: …${b.slice(s, i + 40)}…`;
}

function eq(name: string, got: unknown, want: unknown): void {
  const g = canonStr(got);
  const w = canonStr(want);
  checks.push({
    name,
    ok: g === w,
    detail: g === w ? "" : firstDiff(g, w),
  });
}

// ---- load pax through the port's data layer ------------------------------
const identity = resolveIdentity(IDENTITIES, "pax");
const trajDir = findRootTrajDir(identity);
if (!trajDir) {
  console.error("FAIL: could not locate pax root trajectory dir");
  process.exit(1);
}
const loaded = loadTrajectory(trajDir);

// ---- mindlog: steps + runs + counts --------------------------------------
const goldenMindlog = JSON.parse(gunzipSync(readFileSync(join(GOLDEN, "mindlog.json.gz"))).toString("utf-8"));
eq("mindlog.traj_id", loaded.traj_id, goldenMindlog.traj_id);
eq("mindlog.step_count", loaded.step_count, goldenMindlog.step_count);
eq("mindlog.steps (all 1200, full structure)", loaded.steps, goldenMindlog.steps);
eq("mindlog.runs (all 70 run groups)", loaded.runs, goldenMindlog.runs);

// Structural sub-assertions (explicit, human-readable in the report)
const stepTypesTs = loaded.steps.map((s) => s.type);
const stepTypesGold = goldenMindlog.steps.map((s: { type: string }) => s.type);
eq("mindlog step-type sequence", stepTypesTs, stepTypesGold);
const runIdSeqTs = loaded.steps.map((s) => s.run_id);
const runIdSeqGold = goldenMindlog.steps.map((s: { run_id: string | null }) => s.run_id);
eq("mindlog run_id membership per step", runIdSeqTs, runIdSeqGold);
const runMembersTs = loaded.runs.map((r) => r.step_ids);
const runMembersGold = goldenMindlog.runs.map((r: { step_ids: string[] }) => r.step_ids);
eq("run grouping (step_ids per run)", runMembersTs, runMembersGold);

// ---- chat ----------------------------------------------------------------
const goldenChat = JSON.parse(readFileSync(join(GOLDEN, "chat.json"), "utf-8"));
const chat = chatView(loaded.normalizer.chatIndex, identity.name, 200, null);
eq("chat.messages", chat.messages, goldenChat.messages);
eq("chat.outcomes", chat.outcomes, goldenChat.outcomes);

// ---- memories (drop mtime: filesystem clock, not deterministic) ----------
const goldenMems = JSON.parse(readFileSync(join(GOLDEN, "memories.json"), "utf-8"));
const mems = listMemories(identity.path).map((m) => {
  const { mtime, ...rest } = m;
  void mtime;
  return rest;
});
eq("memories (structure, minus mtime)", mems, goldenMems);

// ---- activity (state classification; drop wall-clock fields) -------------
const goldenAct = JSON.parse(readFileSync(join(GOLDEN, "activity.json"), "utf-8"));
const act = identityActivity(identity) as unknown as Record<string, unknown>;
for (const k of ["last_step_age_s", "run_seconds", "stall_after_s", "cadence_s", "last_step_ts"]) {
  delete act[k];
}
eq("activity (state, dispatcher_running, steps_in_flight, …)", act, goldenAct);

// ---- report --------------------------------------------------------------
let passed = 0;
console.log("\nHeadlong-TS UI parity proof — pax trajectory 55fd5932-root\n");
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok) console.log(`        ${c.detail.replace(/\n/g, "\n        ")}`);
  if (c.ok) passed++;
}
console.log(`\n  ${passed}/${checks.length} checks passed`);
console.log(`  (pax: ${loaded.step_count} steps, ${loaded.runs.length} runs, ${chat.messages.length} chat messages)\n`);

if (passed !== checks.length) process.exit(1);
