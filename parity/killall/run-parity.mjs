#!/usr/bin/env node
// run-parity.mjs — differential parity proof for `headlong-killall`.
//
// SAFETY-DRIVEN SCOPE, read this before touching the scenario list: both the
// real Bash tool and the TS port are DELIBERATELY system-wide panic buttons —
// neither offers a way to scope a raw CLI invocation to "only pids I started".
// Running either side for REAL (non-dry-run) against a live, possibly-shared
// dev machine inside an unattended differential harness risks matching and
// killing a process this harness did not spawn (this happened once during
// this port's development — see test/killall.test.ts's header and PARITY.md
// for the incident and the fix applied there). This harness therefore:
//   1. NEVER invokes either binary without --dry-run (read-only, kills nothing).
//   2. Never spawns decoy processes onto the shared machine — real reaping
//      (TERM/KILL, descendant-tree expansion, docker cleanup) is already
//      proven against REAL processes by test/killall.test.ts, which scopes
//      an injectable psSnapshot to pids it spawned itself. That is the right
//      tool for behavioral proof; this harness is the right tool for the
//      deterministic TEXT CONTRACT (flags, usage, error wording, stream
//      routing) that does not depend on what else is running on the box.
//
// CONSEQUENCE for comparability: the live process listing (which pids get
// reported as "Would kill N…") is NOT byte-diffable across the two tools even
// under --dry-run — the two process universes are DISJOINT BY DESIGN (bash
// script argv like `bash …/bin/llm …` vs this port's `node …/bin/dispatcherd.mjs`
// …), and the bash side alone is nondeterministic across two consecutive runs
// on a shared machine (other real headlong processes may be running). Every
// scenario below is therefore either (a) fully deterministic and diffed byte-
// for-byte (help, usage-error paths — no process-table dependency), or (b)
// diffed STRUCTURALLY only (exit code, the trailing "(dry run — nothing was
// killed)" line, and which STREAM carries output) with the live listing body
// intentionally excluded from the comparison and documented as such.
//
// Repeatable: `PARITY_BASH_KILLALL=/abs/path/to/headlong/tools/headlong-killall node parity/killall/run-parity.mjs`.
// Writes results.json + report.md beside this file. Exit 0 iff every scenario PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_KILLALL = process.env.PARITY_BASH_KILLALL || "<HEADLONG_ROOT>/tools/headlong-killall";
const TS_KILLALL = path.join(REPO, "bin", "headlong-killall");

const HEADLONG_ROOT = path.resolve(path.dirname(BASH_KILLALL), "..");
const HOME = os.homedir();
function scrubArtifactPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

function runTool(kind, argv) {
  const cmd = kind === "bash" ? BASH_KILLALL : "node";
  const fullArgv = kind === "bash" ? argv : [TS_KILLALL, ...argv];
  const res = spawnSync(cmd, fullArgv, { encoding: "buffer", timeout: 15000 });
  return { stdout: res.stdout ?? Buffer.alloc(0), stderr: res.stderr ?? Buffer.alloc(0), status: res.status };
}

function norm(s) {
  // utf8, not latin1: killall's output is plain text (no binary payloads to
  // preserve byte-for-byte, unlike put/sub) and carries an em dash (—) that
  // must decode correctly for the literal trailing-marker string compare.
  return scrubArtifactPaths((s ?? "").toString("utf8"));
}

// --- deterministic (no process-table dependency): byte-diffed exactly ------
const exactScenarios = [
  { group: "help", name: "help-short", argv: ["-h"] },
  { group: "help", name: "help-long", argv: ["--help"] },
  { group: "usage-error", name: "unknown-option", argv: ["--bogus"] },
  { group: "usage-error", name: "unknown-option-short", argv: ["-x"] },
];

// --- structural only: real listing intentionally excluded from comparison --
const structuralScenarios = [
  { group: "dry-run", name: "plain-dry-run", argv: ["--dry-run"] },
  { group: "dry-run", name: "short-flag-dry-run", argv: ["-n"] },
  { group: "dry-run", name: "dry-run-with-web", argv: ["--dry-run", "--web"] },
];

const results = [];

for (const sc of exactScenarios) {
  const bash = runTool("bash", sc.argv);
  const ts = runTool("ts", sc.argv);
  const b = { stdout: norm(bash.stdout), stderr: norm(bash.stderr), status: bash.status };
  const t = { stdout: norm(ts.stdout), stderr: norm(ts.stderr), status: ts.status };
  const cmp = { stdout: b.stdout === t.stdout, stderr: b.stderr === t.stderr, status: b.status === t.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  results.push({ group: sc.group, name: sc.name, argv: sc.argv, kind: "exact", pass, cmp, bash: b, ts: t });
}

// Structural scenarios run the REAL, unrestricted system-wide scan (see file
// header), so their stdout can legitimately contain OTHER real processes'
// full command lines currently running on this machine — up to and including
// another agent's own live process, with whatever paths/args it was invoked
// with. That content is never part of the pass/fail comparison (see below),
// so it must never be persisted verbatim either: redact every line except
// the small set of FIXED, deterministic contract strings before it reaches
// results.json/report.md.
const FIXED_LINES = new Set([
  "No matching processes found.",
  "(dry run — nothing was killed)",
]);
function redactLiveListing(text) {
  return text
    .split("\n")
    .map((line) => {
      if (FIXED_LINES.has(line)) return line;
      if (/^Would kill \d+ process\(es\):$/.test(line)) return line;
      if (line === "") return line;
      return "<redacted: live process listing line, non-deterministic — see file header>";
    })
    .join("\n");
}

for (const sc of structuralScenarios) {
  const bash = runTool("bash", sc.argv);
  const ts = runTool("ts", sc.argv);
  const bOut = redactLiveListing(norm(bash.stdout));
  const tOut = redactLiveListing(norm(ts.stdout));
  const bErr = norm(bash.stderr);
  const tErr = norm(ts.stderr);
  // Structural checks only — the live "Would kill N…"/listing body is
  // deliberately NOT compared (see file header). What IS a real contract on
  // both sides: exit 0, the trailing dry-run marker line, and that the
  // report goes to stdout while nothing unexpected lands on stderr (no
  // protected-ancestor warning expected here — this harness's own pid tree
  // never matches either tool's patterns).
  const cmp = {
    status: bash.status === 0 && ts.status === 0,
    trailingMarker: bOut.trimEnd().endsWith("(dry run — nothing was killed)") && tOut.trimEnd().endsWith("(dry run — nothing was killed)"),
    stderrEmpty: bErr === "" && tErr === "",
  };
  const pass = cmp.status && cmp.trailingMarker && cmp.stderrEmpty;
  results.push({
    group: sc.group,
    name: sc.name,
    argv: sc.argv,
    kind: "structural",
    pass,
    cmp,
    bash: { stdout: bOut, stderr: bErr, status: bash.status },
    ts: { stdout: tOut, stderr: tErr, status: ts.status },
  });
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# headlong-killall — differential parity proof\n\n`;
md += `Real Bash tool \`headlong/tools/headlong-killall\` vs TS port \`headlong-ts/bin/headlong-killall\`.\n\n`;
md += `**Scope note (read before reading the table):** both tools are deliberately system-wide panic buttons with no CLI-level scoping, so this harness runs ONLY \`--dry-run\` invocations (never a real kill) and splits scenarios into two kinds:\n`;
md += `- \`exact\` — fully deterministic (help/usage-error text), byte-diffed stdout+stderr+exit.\n`;
md += `- \`structural\` — the live process-table listing is excluded from comparison on purpose (the two tools' process universes are disjoint by construction — bash script argv vs this port's node argv — and even the bash side alone is nondeterministic across runs on a shared machine); only exit code, the trailing "(dry run — nothing was killed)" marker, and stream routing (stdout vs stderr) are checked. Real reaping of REAL processes (TERM/KILL, descendant-tree expansion, docker cleanup) is proven separately by test/killall.test.ts against processes it spawns itself.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
md += `| # | kind | group | scenario | verdict | fields differing |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
  md += `| ${idx++} | ${r.kind} | ${r.group} | ${r.name} | ${r.pass ? "PARITY" : "MISMATCH"} | ${diffs} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.group} / ${r.name}\n- argv: \`${JSON.stringify(r.argv)}\`\n- exit: bash=${r.bash.status} ts=${r.ts.status}\n\`\`\`\n`;
  md += block("stdout", r.bash.stdout, r.ts.stdout, r.cmp.stdout ?? (r.bash.stdout === r.ts.stdout)) + "\n";
  md += block("stderr", r.bash.stderr, r.ts.stderr, r.cmp.stderr ?? (r.bash.stderr === r.ts.stderr)) + "\n```\n\n";
}

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`headlong-killall parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) console.log(`  MISMATCH ${r.kind}/${r.group}/${r.name}  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
}
process.exit(passed === total ? 0 : 1);
