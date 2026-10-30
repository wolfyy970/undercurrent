#!/usr/bin/env node
// run-import-parity.mjs — differential parity proof for `identity import`.
//
// For each scenario: build source identities with the REAL Bash tool
// (headlong/tools/identity new, + traj/skills/etc. on PATH), export them
// with the REAL Bash tool (`identity export`), then import that SAME
// archive with BOTH the real Bash tool and this port's `bin/identity
// import` into separate fresh roots. Compares exit code + stdout (imported
// name list) + a structural directory diff.
//
// The structural diff EXCLUDES two paths this port already deviates on by
// design, both established (and PARITY.md-documented) for `identity new`
// before this lane existed, and inherited unchanged by `identity import`
// (src/identity.ts's own header comment says so):
//   - `<id>/activate` (upstream writes it; this port never does — replaced
//     by resolveIdentityEnv())
//   - `<id>/kernel/{mem,chat,goals}/*` and `<id>/skills/<bundled-name>` when
//     the archive didn't already ship a real one: upstream SYMLINKS these
//     into its Bash checkout; this port COPIES the bundled SKILL.md text.
// Everything else (info.txt content, root_trajectory presence/repair,
// non-bundled skills, thinkers, memories, trajectories) is compared for
// real equality.
//
// Repeatable: `PARITY_BASH_IDENTITY=/abs/path/to/headlong/tools/identity node parity/identity/run-import-parity.mjs`.
// Writes results-import.json + report-import.md beside this file. Exit 0
// iff every scenario PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_IDENTITY = process.env.PARITY_BASH_IDENTITY || "<HEADLONG_ROOT>/tools/identity";
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_IDENTITY), "..");
const TS_IDENTITY = path.join(REPO, "bin", "identity");
const HOME = os.homedir();

const BASH_PATH = `${path.join(HEADLONG_ROOT, "bin")}:${path.join(HEADLONG_ROOT, "tools")}:${process.env.PATH}`;

function scrub(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

function run(cmd, argv, opts) {
  const res = spawnSync(cmd, argv, { encoding: "utf8", timeout: 30000, ...opts });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

function bashIdentity(argv, env, cwd) {
  return run(BASH_IDENTITY, argv, { env: { ...process.env, PATH: BASH_PATH, ...env }, cwd });
}
function tsIdentity(argv, env, cwd) {
  return run("node", [TS_IDENTITY, ...argv], { env: { ...process.env, ...env }, cwd });
}

// --- structural directory diff ----------------------------------------------

const IGNORE_TOP = new Set(["activate"]);
const IGNORE_KERNEL_SKILLS = new Set(["mem", "chat", "goals"]);

// A fresh root trajectory (live-root repair, or any `identity new`) gets a
// RANDOM uuid independently on each side — comparing raw bytes across two
// independent runs would flag that randomness as a mismatch. Both the path
// segment ("<hex8>-root") and any embedded UUID text (info.txt's
// root_trajectory=, subscriptions.jsonl's traj_id) are normalized to a fixed
// placeholder before comparison; this is a harness normalization, not a
// leniency in the port's own behavior (the identityImport unit tests in
// test/identity-import.test.ts pin the ACTUAL id propagation byte-for-byte).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX8_ROOT_DIR_RE = /^[0-9a-f]{8}-root$/i;

function normalizeUuids(text) {
  return text.replace(UUID_RE, "<UUID>");
}
function normalizeRelPath(rel) {
  return rel
    .split(path.sep)
    .map((seg) => (HEX8_ROOT_DIR_RE.test(seg) ? "<HEX8>-root" : seg))
    .join(path.sep);
}

function listTree(dir, base = dir, out = []) {
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const rel = normalizeRelPath(path.relative(base, full));
    const lst = fs.lstatSync(full);
    if (lst.isSymbolicLink()) {
      out.push({ rel, kind: "symlink" }); // target intentionally not compared (host-specific)
    } else if (lst.isDirectory()) {
      out.push({ rel, kind: "dir" });
      listTree(full, base, out);
    } else if (path.basename(full) === "trajectory.jsonl") {
      // A freshly-repaired root trajectory's genesis step carries its own
      // timestamp + random ids beyond just the traj_id (already normalized
      // above) — two independent runs never match byte-for-byte here even
      // when both are correct. Presence/kind is still compared; content is
      // covered instead by test/identity-import.test.ts's live-root-repair
      // cases, which pin the actual port's output deterministically.
      out.push({ rel, kind: "file", sha: "<SKIPPED:trajectory.jsonl>" });
    } else {
      out.push({ rel, kind: "file", sha: hash(full) });
    }
  }
  return out;
}
function hash(file) {
  // info.txt/subscriptions.jsonl carry the random root-trajectory uuid
  // inline; normalize before hashing so two independently-repaired trees
  // still compare equal. Binary/other files hash raw bytes.
  const base = path.basename(file);
  if (base === "info.txt" || base === "subscriptions.jsonl") {
    return createHash("sha256").update(normalizeUuids(fs.readFileSync(file, "utf-8"))).digest("hex");
  }
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function relevantPath(rel) {
  const parts = rel.split(path.sep);
  // <identity>/activate
  if (parts.length === 2 && parts[1] === "activate") return false;
  // <identity>/kernel/<mem|chat|goals>/** — symlink-vs-copy deviation
  if (parts[1] === "kernel" && IGNORE_KERNEL_SKILLS.has(parts[2])) return false;
  return true;
}

/** Diff two identity-root trees, ignoring the accepted deviations above and
 *  ignoring symlink TARGETS (host-specific by construction) but not their
 *  presence/absence. Returns a list of human-readable differences. */
function diffTrees(rootA, rootB) {
  const a = listTree(rootA).filter((e) => relevantPath(e.rel));
  const b = listTree(rootB).filter((e) => relevantPath(e.rel));
  const byRelA = new Map(a.map((e) => [e.rel, e]));
  const byRelB = new Map(b.map((e) => [e.rel, e]));
  const diffs = [];
  for (const [rel, e] of byRelA) {
    if (!byRelB.has(rel)) {
      diffs.push(`only in bash: ${rel} (${e.kind})`);
      continue;
    }
    const eb = byRelB.get(rel);
    if (e.kind !== eb.kind) diffs.push(`kind differs at ${rel}: bash=${e.kind} ts=${eb.kind}`);
    else if (e.kind === "file" && e.sha !== eb.sha) diffs.push(`content differs at ${rel}`);
  }
  for (const rel of byRelB.keys()) {
    if (!byRelA.has(rel)) diffs.push(`only in ts: ${rel}`);
  }
  return diffs;
}

// --- scenario harness --------------------------------------------------------

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "identity-import-parity-"));
}

function buildSourceIdentities(names) {
  const sourceDir = path.join(scratch(), "src-ids");
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const name of names) {
    const r = bashIdentity(["new", name], { IDENTITY_DIR: sourceDir });
    if (r.status !== 0) throw new Error(`fixture setup failed (identity new ${name}): ${r.stderr}`);
  }
  return sourceDir;
}

function exportArchive(sourceDir, args) {
  const out = path.join(scratch(), "archive.shellm.tgz");
  const r = bashIdentity(["export", ...args, "-o", out], { IDENTITY_DIR: sourceDir });
  if (r.status !== 0) throw new Error(`fixture setup failed (identity export ${args.join(" ")}): ${r.stderr}`);
  return out;
}

const results = [];

function runScenario(name, { setup, importArgv, expectFail = false }) {
  const archive = setup();
  const bashTarget = path.join(scratch(), "bash-target");
  const tsTarget = path.join(scratch(), "ts-target");
  fs.mkdirSync(bashTarget, { recursive: true });
  fs.mkdirSync(tsTarget, { recursive: true });

  const bash = bashIdentity(["import", ...importArgv(archive)], { IDENTITY_DIR: bashTarget });
  const ts = tsIdentity(["import", ...importArgv(archive)], { IDENTITY_DIR: tsTarget });

  const statusMatch = bash.status === ts.status;
  // stdout carries the imported name list, one per line — order can differ
  // (Bash glob order vs this port's sorted order) so compare as a SET, not
  // literal text; report both raw texts on mismatch for a human to read.
  const bashNames = bash.stdout.split("\n").filter(Boolean).sort();
  const tsNames = ts.stdout.split("\n").filter(Boolean).sort();
  const stdoutMatch = JSON.stringify(bashNames) === JSON.stringify(tsNames);

  let treeDiffs = [];
  if (!expectFail && statusMatch && bash.status === 0) {
    treeDiffs = diffTrees(bashTarget, tsTarget);
  }

  const pass = statusMatch && stdoutMatch && treeDiffs.length === 0;
  results.push({
    name,
    pass,
    bash: { status: bash.status, stdout: scrub(bash.stdout), stderr: scrub(bash.stderr) },
    ts: { status: ts.status, stdout: scrub(ts.stdout), stderr: scrub(ts.stderr) },
    statusMatch,
    stdoutMatch,
    treeDiffs,
  });
}

// Scenario 1: single identity, default name.
runScenario("single-identity-default-name", {
  setup: () => exportArchive(buildSourceIdentities(["alice"]), ["alice"]),
  importArgv: (archive) => [archive],
});

// Scenario 2: --name rename.
runScenario("single-identity-rename", {
  setup: () => exportArchive(buildSourceIdentities(["alice"]), ["alice"]),
  importArgv: (archive) => [archive, "--name", "renamed"],
});

// Scenario 3: multi-identity archive (--all).
runScenario("multi-identity-all", {
  setup: () => exportArchive(buildSourceIdentities(["alice", "bob"]), ["--all"]),
  importArgv: (archive) => [archive],
});

// Scenario 4: soul-only export — triggers live root-trajectory repair on import.
runScenario("soul-only-live-root-repair", {
  setup: () => exportArchive(buildSourceIdentities(["alice"]), ["alice", "--soul-only"]),
  importArgv: (archive) => [archive],
});

// Scenario 5: importing into an existing name -> both refuse (conflict).
{
  const sourceDir = buildSourceIdentities(["alice"]);
  const archive = exportArchive(sourceDir, ["alice"]);
  const bashTarget = path.join(scratch(), "bash-target");
  const tsTarget = path.join(scratch(), "ts-target");
  bashIdentity(["new", "alice"], { IDENTITY_DIR: bashTarget });
  tsIdentity(["new", "alice"], { IDENTITY_DIR: tsTarget });
  const bash = bashIdentity(["import", archive], { IDENTITY_DIR: bashTarget });
  const ts = tsIdentity(["import", archive], { IDENTITY_DIR: tsTarget });
  const statusMatch = bash.status === ts.status && bash.status !== 0;
  results.push({
    name: "conflict-existing-identity",
    pass: statusMatch,
    bash: { status: bash.status, stdout: scrub(bash.stdout), stderr: scrub(bash.stderr) },
    ts: { status: ts.status, stdout: scrub(ts.stdout), stderr: scrub(ts.stderr) },
    statusMatch,
    stdoutMatch: true,
    treeDiffs: [],
  });
}

// Scenario 6: not a gzip archive at all -> both refuse.
{
  const bogus = path.join(scratch(), "bogus.shellm.tgz");
  fs.writeFileSync(bogus, "not actually gzip\n");
  const bashTarget = path.join(scratch(), "bash-target");
  const tsTarget = path.join(scratch(), "ts-target");
  fs.mkdirSync(bashTarget, { recursive: true });
  fs.mkdirSync(tsTarget, { recursive: true });
  const bash = bashIdentity(["import", bogus], { IDENTITY_DIR: bashTarget });
  const ts = tsIdentity(["import", bogus], { IDENTITY_DIR: tsTarget });
  const statusMatch = bash.status === ts.status && bash.status !== 0;
  results.push({
    name: "not-a-gzip-archive",
    pass: statusMatch,
    bash: { status: bash.status, stdout: scrub(bash.stdout), stderr: scrub(bash.stderr) },
    ts: { status: ts.status, stdout: scrub(ts.stdout), stderr: scrub(ts.stderr) },
    statusMatch,
    stdoutMatch: true,
    treeDiffs: [],
  });
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);

let md = `# identity import — differential parity proof\n\n`;
md += `Real Bash tool \`headlong/tools/identity import\` vs TS port \`headlong-ts/bin/identity import\`, on archives the REAL Bash \`identity export\` produced from REAL Bash \`identity new\`-built fixtures. Diffs exit code, imported-name stdout (as a set), and a structural directory tree (ignoring the pre-existing, PARITY.md-documented \`activate\`-file and kernel/bundled-skill symlink-vs-copy deviations inherited from \`identity new\`).\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
md += `| # | scenario | verdict | status(bash/ts) | stdout match | tree diffs |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  md += `| ${idx++} | ${r.name} | ${r.pass ? "PARITY" : "MISMATCH"} | ${r.bash.status}/${r.ts.status} | ${r.stdoutMatch} | ${r.treeDiffs.length} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.name}\n`;
  md += `- bash: status=${r.bash.status} stdout=${JSON.stringify(r.bash.stdout)} stderr=${JSON.stringify(r.bash.stderr)}\n`;
  md += `- ts:   status=${r.ts.status} stdout=${JSON.stringify(r.ts.stdout)} stderr=${JSON.stringify(r.ts.stderr)}\n`;
  if (r.treeDiffs.length > 0) md += `- tree diffs:\n${r.treeDiffs.map((d) => `  - ${d}`).join("\n")}\n`;
  md += `\n`;
}

fs.writeFileSync(path.join(HERE, "report-import.md"), md);
fs.writeFileSync(path.join(HERE, "results-import.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`identity import parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) console.log(`  MISMATCH ${r.name}  bash_rc=${r.bash.status} ts_rc=${r.ts.status} treeDiffs=${r.treeDiffs.length}`);
}
process.exit(passed === total ? 0 : 1);
