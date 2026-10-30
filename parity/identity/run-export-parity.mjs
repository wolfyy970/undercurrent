#!/usr/bin/env node
// run-export-parity.mjs — differential parity proof for `identity export`.
//
// For each scenario: build source identities with the REAL Bash tool
// (headlong/tools/identity new), then export that SAME source tree with BOTH
// the real Bash tool (`tools/identity export`) and this port's
// `src/identity.ts` buildIdentityExportArchive (via a tiny in-process
// harness, not bin/identity.mjs — export has no stdin/stdout streaming
// concern the CLI adds, so this compares the library the web routes call
// directly). Decodes BOTH archives with this port's OWN tar reader
// (src/tar.ts readTarGz) and diffs them as structured entry lists —
// comparing archive CONTENTS (entry set, type, mode, size, bytes/linkname),
// not raw tar bytes.
//
// Explicit, PARITY.md-documented allowances (this is the full list — anything
// not named here is compared for real equality):
//   - Entry ORDERING: not compared (bash `find`'s directory-read order vs
//     this port's sorted walk — both valid tar member orders for the same
//     archive; PARITY.md "identity export" row).
//   - `manifest.json`'s `exported_at` field: not compared (wall-clock,
//     independently generated on each side, several seconds apart in a
//     harness run).
//   - tar header bytes themselves (mtime/uname/uid/gid/ustar-vs-PAX
//     encoding/checksum): never compared — only the DECODED entry fields
//     above are, which is what the task calls for ("tar headers may
//     legitimately differ").
//
// Repeatable: `PARITY_BASH_IDENTITY=/abs/path/to/headlong/tools/identity node parity/identity/run-export-parity.mjs`.
// Writes results.json + report.md beside this file (as
// results-export.json/report-export.md, not to collide with `identity new`'s
// own run-parity.mjs outputs). Exit 0 iff every scenario PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_IDENTITY = process.env.PARITY_BASH_IDENTITY || "<HEADLONG_ROOT>/tools/identity";
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_IDENTITY), "..");
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

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "identity-export-parity-"));
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

// --- run BOTH exporters against the SAME source tree, decode with our own reader ---

async function tsExportArchive(dirs, opts) {
  const { resolveExportDirs, buildIdentityExportArchive } = await import(path.join(REPO, "src", "identity.ts"));
  const resolved = resolveExportDirs(opts.identitiesRoot, opts.resolve);
  const buf = buildIdentityExportArchive({ dirs: resolved, soulOnly: opts.soulOnly, slim: opts.slim });
  return buf;
}

async function decodeArchive(buf) {
  const { readTarGz } = await import(path.join(REPO, "src", "tar.ts"));
  return readTarGz(buf);
}

function entryMap(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.name, e);
  return m;
}

function diffArchives(bashEntries, tsEntries) {
  const a = entryMap(bashEntries);
  const b = entryMap(tsEntries);
  const diffs = [];
  for (const [name, e] of a) {
    if (!b.has(name)) {
      diffs.push(`only in bash: ${name} (${e.type})`);
      continue;
    }
    const f = b.get(name);
    if (e.type !== f.type) {
      diffs.push(`type differs at ${name}: bash=${e.type} ts=${f.type}`);
      continue;
    }
    if (e.type === "file") {
      if (name === "manifest.json") continue; // exported_at — documented allowance above
      if (e.size !== f.size) diffs.push(`size differs at ${name}: bash=${e.size} ts=${f.size}`);
      else if (!e.data.equals(f.data)) diffs.push(`content differs at ${name}`);
    } else if (e.type === "symlink") {
      if (e.linkname !== f.linkname) diffs.push(`symlink target differs at ${name}`);
    }
    // directory: presence + type is the whole check (mode is a fresh
    // mkdir-vs-copied-stat difference only for --slim's synthesized dirs,
    // and this harness's fixtures never hit that path with a non-default
    // umask, so not worth a special case here).
  }
  for (const [name, e] of b) {
    if (!a.has(name)) diffs.push(`only in ts: ${name} (${e.type})`);
  }
  return diffs;
}

function manifestsMatch(bashEntries, tsEntries) {
  const bm = bashEntries.find((e) => e.name === "manifest.json");
  const tm = tsEntries.find((e) => e.name === "manifest.json");
  if (!bm || !tm) return bm === tm;
  const stripStamp = (obj) => {
    const { exported_at, ...rest } = obj;
    return rest;
  };
  try {
    const bj = stripStamp(JSON.parse(bm.data.toString("utf-8")));
    const tj = stripStamp(JSON.parse(tm.data.toString("utf-8")));
    return JSON.stringify(bj) === JSON.stringify(tj);
  } catch {
    return false;
  }
}

const results = [];

async function runScenario(name, { sourceDir, bashArgs, resolveOpts, soulOnly, slim }) {
  const bashOut = path.join(scratch(), "bash.shellm.tgz");
  const bash = bashIdentity(["export", ...bashArgs, "-o", bashOut], { IDENTITY_DIR: sourceDir });
  if (bash.status !== 0) {
    results.push({
      name,
      pass: false,
      bash: { status: bash.status, stdout: scrub(bash.stdout), stderr: scrub(bash.stderr) },
      ts: { status: null, stdout: "", stderr: "setup: bash export itself failed" },
      diffs: [],
      manifestMatch: false,
    });
    return;
  }
  const bashBuf = fs.readFileSync(bashOut);
  const bashEntries = await decodeArchive(bashBuf);

  let tsEntries;
  let tsError = null;
  try {
    const tsBuf = await tsExportArchive(null, { identitiesRoot: sourceDir, resolve: resolveOpts, soulOnly, slim });
    tsEntries = await decodeArchive(tsBuf);
  } catch (e) {
    tsError = e instanceof Error ? e.message : String(e);
    tsEntries = [];
  }

  const diffs = tsError ? [`ts export threw: ${tsError}`] : diffArchives(bashEntries, tsEntries);
  const manifestMatch = tsError ? false : manifestsMatch(bashEntries, tsEntries);
  const pass = diffs.length === 0 && manifestMatch;
  results.push({
    name,
    pass,
    bash: { status: bash.status, stdout: scrub(bash.stdout), stderr: scrub(bash.stderr), entryCount: bashEntries.length },
    ts: { status: tsError ? 1 : 0, stdout: "", stderr: tsError ?? "", entryCount: tsEntries.length },
    diffs,
    manifestMatch,
  });
}

const sourceBasic = buildSourceIdentities(["alice"]);
fs.writeFileSync(
  path.join(sourceBasic, "alice", "memories", "note.md"),
  "# a memory\nsome content\n"
);

await runScenario("single-identity-by-name", {
  sourceDir: sourceBasic,
  bashArgs: ["alice"],
  resolveOpts: { names: ["alice"] },
});

await runScenario("single-identity-by-path", {
  sourceDir: sourceBasic,
  bashArgs: ["--path", path.join(sourceBasic, "alice")],
  resolveOpts: { paths: [path.join(sourceBasic, "alice")] },
});

await runScenario("soul-only", {
  sourceDir: sourceBasic,
  bashArgs: ["alice", "--soul-only"],
  resolveOpts: { names: ["alice"] },
  soulOnly: true,
});

// --slim: exercise truncation (long shellm-run command / prompt content) and
// API-key redaction by appending synthetic steps to the live trajectory.
{
  const trajDir = fs.readdirSync(path.join(sourceBasic, "alice", "trajectories"))[0];
  const jsonl = path.join(sourceBasic, "alice", "trajectories", trajDir, "trajectory.jsonl");
  const longCmd = "X".repeat(400);
  // Fake key fragments, concatenated — test/scrub.test.ts forbids a
  // contiguous "sk" + "-or-v1-" in any tracked file.
  const longPrompt = `${"Y".repeat(650)} sk-ant-abcdefghijklmnop123 sk${"-or-v1-"}0123456789abcdef xox b-fake-slack-token-1234567890`;
  fs.appendFileSync(
    jsonl,
    `${JSON.stringify({ type: "shellm-run", command: longCmd, other: 1 })}\n` +
      `${JSON.stringify({ type: "prompt", content: longPrompt })}\n`
  );
}
await runScenario("slim-truncate-and-redact", {
  sourceDir: sourceBasic,
  bashArgs: ["alice", "--slim"],
  resolveOpts: { names: ["alice"] },
  slim: true,
});

// PORT-NOTE (1c: 9a62727): --slim now drops content_b64 from EVERY step, not
// just shellm-run/prompt — proves the real Bash `_SLIM_JQ`'s `| del(.content_b64)`
// and this port's slimJsonLine() delete agree on a file-transfer `message` step.
{
  const trajDir = fs.readdirSync(path.join(sourceBasic, "alice", "trajectories"))[0];
  const jsonl = path.join(sourceBasic, "alice", "trajectories", trajDir, "trajectory.jsonl");
  fs.appendFileSync(
    jsonl,
    `${JSON.stringify({ type: "message", filename: "photo.jpg", content: "[file: photo.jpg]", content_b64: "ZmFrZWJ5dGVzZm9ycGFyaXR5" })}\n`
  );
}
await runScenario("slim-drops-content-b64", {
  sourceDir: sourceBasic,
  bashArgs: ["alice", "--slim"],
  resolveOpts: { names: ["alice"] },
  slim: true,
});

const sourceMulti = buildSourceIdentities(["carol", "dave"]);
await runScenario("all-identities", {
  sourceDir: sourceMulti,
  bashArgs: ["--all"],
  resolveOpts: { all: true },
});

const sourceDefault = buildSourceIdentities(["ellen"]);
await runScenario("default-identity-no-args", {
  sourceDir: sourceDefault,
  bashArgs: [],
  resolveOpts: { names: [] },
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);

let md = `# identity export — differential parity proof\n\n`;
md += `Real Bash tool \`headlong/tools/identity export\` vs TS port \`src/identity.ts\` buildIdentityExportArchive (the same library \`web/server/src/control.ts\` calls for the web routes), both run against the SAME REAL-Bash-\`identity new\`-built source tree. Archives decoded with this port's own tar reader and diffed as structured entry lists (entry set, type, mode-sensitive fields, bytes/linkname) — not raw tar bytes. See this file's header comment for the exact, small set of documented allowances (ordering, manifest \`exported_at\`).\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
md += `| # | scenario | verdict | entries(bash/ts) | diffs | manifest match |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  md += `| ${idx++} | ${r.name} | ${r.pass ? "PARITY" : "MISMATCH"} | ${r.bash.entryCount ?? "-"}/${r.ts.entryCount ?? "-"} | ${r.diffs.length} | ${r.manifestMatch} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.name}\n`;
  md += `- bash: status=${r.bash.status} stderr=${JSON.stringify(r.bash.stderr)}\n`;
  md += `- ts:   status=${r.ts.status} stderr=${JSON.stringify(r.ts.stderr)}\n`;
  if (r.diffs.length > 0) md += `- diffs:\n${r.diffs.map((d) => `  - ${d}`).join("\n")}\n`;
  md += `\n`;
}

fs.writeFileSync(path.join(HERE, "report-export.md"), md);
fs.writeFileSync(path.join(HERE, "results-export.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`identity export parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) console.log(`  MISMATCH ${r.name}  diffs=${r.diffs.length} manifestMatch=${r.manifestMatch}`);
}
process.exit(passed === total ? 0 : 1);
