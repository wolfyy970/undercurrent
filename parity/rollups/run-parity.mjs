#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the tiered-memory `rollups`
// subsystem, on the DETERMINISTIC ENVELOPE ONLY.
//
// Ground truth is pax's real root trajectory and the rollups it actually
// sealed:
//   traj: headlong/.identities/pax/trajectories/55fd5932-root/trajectory.jsonl
//   seal: …/55fd5932-root/rollups/{t1,t2,meta.json,rendered.tsv,rendered.meta.json}
//
// Three independent proofs, all on structure/ranges/tier-membership/selection —
// NEVER on the LLM-generated summary/themes prose (non-deterministic):
//
//   A. RENDER DIFFERENTIAL. Feed the real trajectory through the TS
//      `renderSteps` filter and compare, row-for-row, against the reference
//      `rendered.tsv` the Bash `_render_steps` produced. The rendered.meta
//      records a 1188-line high-water mark → 252 filtered rows; we render the
//      same 1188 lines and diff every TSV field (raw_line, step_id, ts, text,
//      epoch_min) byte-for-byte. This is what fixes the filtered-step INDEX
//      space that all block math lives in.
//
//   B. BLOCK-PLAN DIFFERENTIAL. From the DERIVED filtered count (not a
//      hard-coded 250), run the TS `buildPlan` and confirm the set of tier
//      block ranges it would seal equals the set actually on disk (25 t1 blocks
//      of F=10 raw steps + 2 t2 blocks of 10 t1 each). Then check every sealed
//      block's own sealing invariants: absolute-range file key, tier, n=F^tier,
//      contiguous tiling, F-aligned enable marker. Also shows the set is stable
//      when one more raw row (the full 1200-line log → 253 rows) is included.
//
//   C. STAIRCASE DIFFERENTIAL (Bash vs TS). Over a sweep of raw-tail sizes R,
//      run the REAL `recap --context --cached` (Bash `_ctx_assemble`, no LLM)
//      and the TS `recapContext({mode:"cached"})` against the SAME scratch copy
//      of the trajectory + sealed blocks, then diff the STRUCTURE of each
//      staircase: which tier/range blocks are selected, in what order, the cited
//      step ids, the raw-tail step count (n − cut0, snapped to an F boundary),
//      and the exact sequence of raw-tail step ids. Summary PROSE is excluded
//      from the parity criterion (it happens to match only because both sides
//      read the identical frozen block files; that byte-equality is recorded as
//      supporting evidence, not the pass condition). The TS summarizer is a
//      THROWING stub — cached mode must never invoke the LLM.
//
// Node 24 strips types natively, so the TS source imports directly — no build
// step, no new deps. Repeatable: `node parity/rollups/run-parity.mjs`. Writes
// results.json + report.md beside this file. Exit 0 iff every proof passes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderSteps,
  buildPlan,
  blockKey,
  pad12,
  powFanout,
  recapContext,
  ROLLUP_FANOUT_DEFAULT,
  ROLLUP_PROMPT_VERSION,
} from "../../src/rollups.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = ROLLUP_FANOUT_DEFAULT;
// Scrubbed to a placeholder for release; set PARITY_HEADLONG_ROOT=/abs/path/to/
// headlong to reproduce the run (needs pax's real trajectory + bin/recap).
const HL = process.env.PARITY_HEADLONG_ROOT || "<HEADLONG_ROOT>";
const RECAP = path.join(HL, "bin", "recap");
const TRAJ_ID = "55fd5932-root";
const REAL_TRAJ_DIR = path.join(HL, ".identities/pax/trajectories", TRAJ_ID);
const REAL_JSONL = path.join(REAL_TRAJ_DIR, "trajectory.jsonl");
const REAL_ROLLUPS = path.join(REAL_TRAJ_DIR, "rollups");
const REAL_RENDERED_TSV = path.join(REAL_ROLLUPS, "rendered.tsv");
const REAL_RENDER_META = path.join(REAL_ROLLUPS, "rendered.meta.json");

// ── helpers ──────────────────────────────────────────────────────────────────
const parseJsonl = (text) => {
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
};
const rowToTsv = (r) => [r.rawLine, r.stepId, r.ts, r.text, r.epochMin].join("\t");

// Canonicalize a staircase text (Bash OR TS) into its DETERMINISTIC structure.
// Summary prose is intentionally discarded — only tier/range/ids/tail survive.
function structOf(text) {
  const lines = text.split("\n");
  const hasLife = lines.some((l) => l.startsWith("=== YOUR LIFE SO FAR"));
  const segments = [];
  let tailCount = null;
  const tailIds = [];
  let inTail = false;
  for (const line of lines) {
    const th = /^=== RIGHT NOW — the last (\d+) steps, verbatim ===$/.exec(line);
    if (th) {
      tailCount = Number(th[1]);
      inTail = true;
      continue;
    }
    if (!inTail) {
      // Block line: [tK · steps S–E] <summary>   (id id …)
      const head = /^\[t(\d+) · steps (\d+)–(\d+)\]/.exec(line);
      if (head) {
        const idm = /\(([^()]*)\)\s*$/.exec(line);
        const ids = idm ? idm[1].split(/\s+/).filter(Boolean) : [];
        segments.push({ tier: Number(head[1]), s: Number(head[2]), e: Number(head[3]), ids });
      }
    } else if (line !== "") {
      // Raw-tail row: [id8] type…  — capture the leading step id only.
      const idm = /^\[([0-9a-f?]{1,8})\]/.exec(line);
      tailIds.push(idm ? idm[1] : "<?>");
    }
  }
  return { hasLife, segments, tailCount, tailIds };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── scratch: a truncated copy at the reference render high-water mark ─────────
// The reference rendered.meta records raw_lines=1188 (→ 252 filtered rows), the
// exact state that sealed the on-disk blocks. Truncating the scratch trajectory
// to those 1188 lines keeps the Bash cached render frozen at n=252, so both
// sides assemble over the identical filtered-index space the blocks cover.
const HIGH_WATER = JSON.parse(fs.readFileSync(REAL_RENDER_META, "utf8")).raw_lines;
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rollups-parity-"));
const scratchTrajParent = scratchRoot;
const scratchRunDir = path.join(scratchRoot, TRAJ_ID);
const scratchRollups = path.join(scratchRunDir, "rollups");
fs.mkdirSync(scratchRunDir, { recursive: true });
{
  const allLines = fs.readFileSync(REAL_JSONL, "utf8").split("\n");
  while (allLines.length && allLines[allLines.length - 1] === "") allLines.pop();
  fs.writeFileSync(path.join(scratchRunDir, "trajectory.jsonl"), allLines.slice(0, HIGH_WATER).join("\n") + "\n");
  fs.cpSync(REAL_ROLLUPS, scratchRollups, { recursive: true });
  fs.rmSync(path.join(scratchRollups, ".lock"), { recursive: true, force: true });
}

const results = { generated_at: new Date().toISOString(), node: process.version, traj: TRAJ_ID, high_water_lines: HIGH_WATER, proofs: {} };
const fail = (msg) => {
  console.error("PARITY FAILURE:", msg);
};

// ── PROOF A — render differential ─────────────────────────────────────────────
function proofRender() {
  const steps = parseJsonl(fs.readFileSync(path.join(scratchRunDir, "trajectory.jsonl"), "utf8"));
  const tsRows = renderSteps(steps);
  const refRows = fs.readFileSync(REAL_RENDERED_TSV, "utf8").split("\n").filter((l) => l !== "");
  const n = Math.max(tsRows.length, refRows.length);
  const mismatches = [];
  for (let i = 0; i < n; i++) {
    const a = tsRows[i] ? rowToTsv(tsRows[i]) : "<none>";
    const b = refRows[i] ?? "<none>";
    if (a !== b) mismatches.push({ row: i, ts: a.slice(0, 160), ref: b.slice(0, 160) });
  }
  const pass = mismatches.length === 0 && tsRows.length === refRows.length;
  results.proofs.A_render = {
    pass,
    ts_rows: tsRows.length,
    ref_rows: refRows.length,
    field_mismatches: mismatches.length,
    sample_mismatches: mismatches.slice(0, 5),
    derived_filtered_count: tsRows.length,
  };
  if (!pass) fail(`render: ${mismatches.length} row mismatch(es), ts=${tsRows.length} ref=${refRows.length}`);
  return tsRows.length;
}

// ── PROOF B — block-plan differential ─────────────────────────────────────────
function readDiskBlocks(tier) {
  const d = path.join(REAL_ROLLUPS, `t${tier}`);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(d, name), "utf8")) }));
}

function proofPlan(nDerived) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const disk1 = readDiskBlocks(1);
  const disk2 = readDiskBlocks(2);
  record("t1 has 25 sealed blocks", disk1.length === 25, `${disk1.length}`);
  record("t2 has 2 sealed blocks", disk2.length === 2, `${disk2.length}`);

  const onDisk = new Set();
  for (const { json } of [...disk1, ...disk2]) onDisk.add(blockKey(json.tier, json.start, json.end));
  const planned = new Set(buildPlan(nDerived, 0, F).map((p) => blockKey(p.tier, p.s, p.e)));
  const missing = [...onDisk].filter((k) => !planned.has(k));
  const extra = [...planned].filter((k) => !onDisk.has(k));
  record(
    `buildPlan(${nDerived},0) block set == on-disk block set`,
    missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}` : `${planned.size} keys identical`
  );

  // Full 1200-line log → 253 rows: same block set (invariant to +1 trailing row).
  const fullRows = renderSteps(parseJsonl(fs.readFileSync(REAL_JSONL, "utf8")));
  const plannedFull = new Set(buildPlan(fullRows.length, 0, F).map((p) => blockKey(p.tier, p.s, p.e)));
  record(
    `block set stable at full log (n=${fullRows.length})`,
    eq([...plannedFull].sort(), [...planned].sort()),
    `full=${plannedFull.size} keys`
  );

  // Per-block sealing invariants.
  let keyOk = true, nOk = true, tierOk = true, pvOk = true, schemaOk = true;
  for (const tier of [1, 2]) {
    for (const { name, json } of tier === 1 ? disk1 : disk2) {
      if (name !== `${pad12(json.start)}-${pad12(json.end)}.json`) keyOk = false;
      if (json.n !== json.end - json.start || json.n !== powFanout(F, tier)) nOk = false;
      if (json.tier !== tier) tierOk = false;
      if (json.prompt_version !== ROLLUP_PROMPT_VERSION) pvOk = false;
      if (typeof json.summary !== "string" || !Array.isArray(json.themes) || !Array.isArray(json.step_ids) || json.step_ids.length === 0) schemaOk = false;
    }
  }
  record("every filename encodes its own absolute [start,end) range", keyOk);
  record("every block n = end − start = F^tier", nOk);
  record("every block's tier field matches its dir", tierOk);
  record("every block stamped prompt_version=2", pvOk);
  record("every block carries the sealed-block schema (non-empty step_ids)", schemaOk);

  // Contiguous tiling.
  const tile = (blocks, upto) => {
    let cur = 0;
    for (const b of blocks.map((x) => x.json).sort((a, b) => a.start - b.start)) {
      if (b.start !== cur) return false;
      cur = b.end;
    }
    return cur === upto;
  };
  record("t1 tiles [0,250) contiguously", tile(disk1, 250));
  record("t2 tiles [0,200) contiguously", tile(disk2, 200));

  const meta = JSON.parse(fs.readFileSync(path.join(REAL_ROLLUPS, "meta.json"), "utf8"));
  record("meta.json start_index is F-aligned", meta.start_index % F === 0, `start_index=${meta.start_index}`);

  const pass = checks.every((c) => c.ok);
  results.proofs.B_plan = { pass, derived_n: nDerived, checks };
  if (!pass) fail("block-plan: " + checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
}

// ── PROOF C — staircase differential (Bash vs TS) ─────────────────────────────
const THROW_SUMMARIZE = () => {
  throw new Error("cached mode must not invoke the LLM");
};

function runBashStaircase(rawTail) {
  const args = [TRAJ_ID, "--context", "--cached", "-q"];
  if (rawTail !== "auto") args.push("--raw-tail", String(rawTail));
  const env = { ...process.env, TRAJ_DIR: scratchTrajParent, THINK_MODEL: "deepseek/deepseek-v4-flash-0731" };
  const res = spawnSync(RECAP, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

function runTsStaircase(rows, rawTail) {
  return recapContext({
    rows,
    rollupDir: scratchRollups,
    summarize: THROW_SUMMARIZE,
    model: "deepseek/deepseek-v4-flash-0731",
    now: () => "T",
    mode: "cached",
    ...(rawTail === "auto" ? { rawTail: "auto", budget: "auto", window: "auto" } : { rawTail }),
  });
}

function proofStaircase(tsRows) {
  const sweep = [
    { rawTail: 50, note: "clean t2 boundary (cut0=200)" },
    { rawTail: 60, note: "staircase t2+9·t1 (cut0=190, tail=62)" },
    { rawTail: 20, note: "mixed t2+t2+3·t1 (cut0=230)" },
    { rawTail: 5, note: "explicit R below auto-floor (cut0=240)" },
    { rawTail: 252, note: "R=n → all-raw, no life section (cut0=0)" },
    { rawTail: "auto", note: "auto budget → R=20 via model window+cap" },
  ];
  const scenarios = [];
  for (const { rawTail, note } of sweep) {
    const bash = runBashStaircase(rawTail);
    const ts = runTsStaircase(tsRows, rawTail);
    const bStruct = structOf(bash.stdout);
    const tStruct = structOf(ts);
    const structPass = eq(bStruct, tStruct);
    const textIdentical = bash.stdout === ts; // supporting evidence only
    const bashOk = bash.status === 0 && bash.stdout.length > 0;
    scenarios.push({
      rawTail,
      note,
      pass: structPass && bashOk,
      bash_exit: bash.status,
      bash_stderr: bash.stderr.slice(0, 300),
      struct: {
        hasLife: tStruct.hasLife,
        segments: tStruct.segments.map((s) => `t${s.tier}[${s.s},${s.e})`),
        segment_ids_match: eq(bStruct.segments, tStruct.segments),
        tailCount: tStruct.tailCount,
        tailCount_match: bStruct.tailCount === tStruct.tailCount,
        tailIds_len: tStruct.tailIds.length,
        tailIds_match: eq(bStruct.tailIds, tStruct.tailIds),
      },
      full_text_identical: textIdentical,
      diff: structPass ? null : { bash: bStruct, ts: tStruct },
    });
    if (!structPass) fail(`staircase rawTail=${rawTail}: structural mismatch`);
    if (!bashOk) fail(`staircase rawTail=${rawTail}: bash exit=${bash.status} stderr=${bash.stderr.slice(0, 200)}`);
  }
  const pass = scenarios.every((s) => s.pass);
  results.proofs.C_staircase = { pass, scenarios };
}

// ── run ───────────────────────────────────────────────────────────────────────
const nDerived = proofRender();
proofPlan(nDerived);
proofStaircase(renderSteps(parseJsonl(fs.readFileSync(path.join(scratchRunDir, "trajectory.jsonl"), "utf8"))));

// pass-rate accounting: one unit per leaf check across all three proofs.
const units = [];
units.push({ proof: "A", name: "render row-for-row identical", ok: results.proofs.A_render.pass });
for (const c of results.proofs.B_plan.checks) units.push({ proof: "B", name: c.name, ok: c.ok });
for (const s of results.proofs.C_staircase.scenarios) units.push({ proof: "C", name: `staircase rawTail=${s.rawTail}`, ok: s.pass });
const passed = units.filter((u) => u.ok).length;
const total = units.length;
results.summary = {
  passed,
  total,
  pass_rate: `${passed}/${total}`,
  pass_pct: Math.round((passed / total) * 1000) / 10,
  all_pass: passed === total,
};

fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");

// ── report.md ─────────────────────────────────────────────────────────────────
const A = results.proofs.A_render;
const B = results.proofs.B_plan;
const C = results.proofs.C_staircase;
const yn = (b) => (b ? "✅" : "❌");
const md = [];
md.push("# Rollups parity — deterministic envelope (TS port vs real Headlong)");
md.push("");
md.push(`_Generated ${results.generated_at} · Node ${results.node} · traj \`${TRAJ_ID}\` · reference high-water ${HIGH_WATER} raw lines → ${nDerived} filtered steps_`);
md.push("");
md.push("Parity is asserted on the DETERMINISTIC ENVELOPE only — which filtered-step ranges seal into which tier blocks, the absolute-range file keys, and the staircase tier/raw-tail SELECTION. The LLM-generated summary / themes prose is excluded (non-deterministic); the block files are read verbatim from disk on both sides.");
md.push("");
md.push(`**Overall: ${results.summary.pass_rate} checks pass (${results.summary.pass_pct}%).**`);
md.push("");
md.push("## A. Render differential — TS `renderSteps` vs Bash `rendered.tsv`");
md.push("");
md.push(`Result: **${A.pass ? "PASS" : "FAIL"}** — ${A.ts_rows}/${A.ref_rows} rows, ${A.field_mismatches} field mismatch(es).`);
md.push("");
md.push("The real trajectory's 1188-line render high-water mark is fed through the TS filter and compared field-by-field (raw_line · step_id · ts · text · epoch_min) against the `rendered.tsv` the Bash `_render_steps` wrote. Byte-for-byte identity here fixes the filtered-step INDEX space that every block range is defined over.");
md.push("");
md.push("## B. Block-plan differential — TS `buildPlan` vs on-disk sealed blocks");
md.push("");
md.push(`Result: **${B.pass ? "PASS" : "FAIL"}** (derived n=${B.derived_n} from the render above, not hard-coded).`);
md.push("");
md.push("| check | ok | detail |");
md.push("| --- | --- | --- |");
for (const c of B.checks) md.push(`| ${c.name} | ${yn(c.ok)} | ${c.detail ?? ""} |`);
md.push("");
md.push("## C. Staircase differential — real `recap --context --cached` (Bash) vs TS `recapContext`");
md.push("");
md.push(`Result: **${C.scenarios.filter((s) => s.pass).length}/${C.scenarios.length} scenarios at structural PARITY.**`);
md.push("");
md.push("Both sides assemble over the SAME scratch copy of the trajectory + sealed blocks. The TS summarizer is a throwing stub, proving cached mode never calls the LLM. Structure compared: selected tier/range blocks (+ order + cited ids), raw-tail step count (n − cut0, F-snapped), and the full raw-tail step-id sequence. `full_text_identical` (summary prose included) is recorded as supporting evidence — it holds because both read the identical frozen block JSON.");
md.push("");
md.push("| rawTail | selection | tail | ids✓ | tailCt✓ | tailIds✓ | text≡ | parity |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const s of C.scenarios) {
  md.push(
    `| ${s.rawTail} | ${s.struct.segments.join(" ") || "(none)"} | ${s.struct.tailCount} | ${yn(s.struct.segment_ids_match)} | ${yn(s.struct.tailCount_match)} | ${yn(s.struct.tailIds_match)} | ${yn(s.full_text_identical)} | ${yn(s.pass)} |`
  );
}
md.push("");
md.push("Notes per scenario:");
for (const s of C.scenarios) md.push(`- \`rawTail=${s.rawTail}\` — ${s.note} → \`${s.struct.segments.join(" ") || "(no life section)"}\` + last ${s.struct.tailCount} verbatim.`);
md.push("");
md.push("## Reproduce");
md.push("");
md.push("```");
md.push(". ~/.nvm/nvm.sh && nvm use 24.19.0");
md.push("node parity/rollups/run-parity.mjs");
md.push("```");
md.push("");
fs.writeFileSync(path.join(HERE, "report.md"), md.join("\n"));

// cleanup scratch
fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\nrollups parity: ${results.summary.pass_rate} checks pass (${results.summary.pass_pct}%)`);
console.log(`  A render:    ${A.pass ? "PASS" : "FAIL"} (${A.ts_rows}/${A.ref_rows} rows, ${A.field_mismatches} mismatches)`);
console.log(`  B plan:      ${B.pass ? "PASS" : "FAIL"} (n=${B.derived_n}, ${B.checks.filter((c) => c.ok).length}/${B.checks.length} checks)`);
console.log(`  C staircase: ${C.scenarios.filter((s) => s.pass).length}/${C.scenarios.length} scenarios`);
process.exit(results.summary.all_pass ? 0 : 1);
