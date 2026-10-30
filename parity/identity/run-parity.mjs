#!/usr/bin/env node
// run-parity.mjs — differential parity proof for `identity list [-a]`.
//
// Runs the REAL Bash tool (headlong/tools/identity) and the TS port
// (bin/identity, a Node executable) on identical `.identities`-shaped
// fixture directories in isolated scratch sandboxes, then diffs
// stdout + stderr + exit code. `identity list` never writes to disk, so
// there is no on-disk state to compare (unlike parity/sub).
//
// Repeatable: `PARITY_BASH_IDENTITY=/abs/path/to/headlong/tools/identity node parity/identity/run-parity.mjs`.
// Writes results.json + report.md beside this file. Exit 0 iff every scenario PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASH_IDENTITY = process.env.PARITY_BASH_IDENTITY || "<HEADLONG_ROOT>/tools/identity";
const TS_IDENTITY = path.join(REPO, "bin", "identity");

const HEADLONG_ROOT = path.resolve(path.dirname(BASH_IDENTITY), "..");
const HOME = os.homedir();
function scrubArtifactPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

// --- fixture construction ---------------------------------------------------

function writeInfo(dir, fields) {
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  fs.writeFileSync(path.join(dir, "info.txt"), body);
}

// Builds one `.identities`-shaped root from a scenario's seed spec. Returns
// {root, work} where `work` IS the identities root (no nesting — argv never
// needs a {WORK} placeholder, only the IDENTITY_DIR env var does).
function makeSandbox(seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-parity-sb-"));
  const work = path.join(root, "ids");
  if (!seed.missingRoot) {
    fs.mkdirSync(work, { recursive: true });
    for (const id of seed.identities || []) {
      writeInfo(path.join(work, id.name), id.info);
    }
    for (const d of seed.dirs || []) fs.mkdirSync(path.join(work, d), { recursive: true });
    for (const d of seed.hiddenDirs || []) fs.mkdirSync(path.join(work, d), { recursive: true });
    for (const f of seed.files || []) fs.writeFileSync(path.join(work, f), "x");
    for (const link of seed.symlinkDirs || []) {
      const targetAbs = path.join(work, link.target);
      fs.mkdirSync(targetAbs, { recursive: true });
      fs.symlinkSync(targetAbs, path.join(work, link.name));
    }
    for (const name of seed.danglingLinks || []) {
      fs.symlinkSync(path.join(work, "___nonexistent___"), path.join(work, name));
    }
    if (seed.defaultTarget !== undefined && seed.defaultTarget !== null) {
      fs.symlinkSync(seed.defaultTarget, path.join(work, "default"));
    }
  }
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* ignore */
  }
  return { root, work, roots: [real, root] };
}

function runTool(kind, scenario, sb) {
  // Deliberately NOT forcing LC_ALL=C: bash's glob sort (which `_identity_names`
  // relies on for ordering) is locale-sensitive, and this harness's job is to
  // match the REAL tool's observed behavior in this environment — which, with
  // no LANG/LC_* set (the default here), sorts case-insensitively-primary
  // ("alpha" < "Bravo" < "mike"), not by raw byte value. Forcing LC_ALL=C would
  // change the oracle's own behavior out from under the comparison.
  const env = { ...process.env, IDENTITY_DIR: sb.work };
  const argv = scenario.argv;
  const fullArgv = kind === "bash" ? argv : [TS_IDENTITY, ...argv];
  const cmd = kind === "bash" ? BASH_IDENTITY : "node";
  const res = spawnSync(cmd, fullArgv, { cwd: sb.root, env, encoding: "buffer", timeout: 15000 });
  return { stdout: res.stdout ?? Buffer.alloc(0), stderr: res.stderr ?? Buffer.alloc(0), status: res.status };
}

function normalize(s, roots) {
  if (s == null) return s;
  let out = s;
  for (const r of [...roots].sort((a, b) => b.length - a.length)) out = out.split(r).join("<ROOT>");
  return out;
}
function bufNorm(buf, roots) {
  return normalize(buf.toString("latin1"), roots);
}

// --- scenarios ---------------------------------------------------------------
// Fixture identities per the porting brief: 0 identities, 1, 3 with different
// info.txt/created dates, a stray non-identity dir, a missing IDENTITY_DIR —
// plus every other quirk found while characterizing the real Bash tool
// (hidden dirs, plain files, symlinked dirs, dangling symlinks, a dangling
// `default`, name ordering, name padding at/over 20 chars, -a/--all, and
// argv edge cases the bash arg loop is known to ignore silently).

const scenarios = [
  { group: "zero", name: "existing-empty-dir", argv: ["list"], seed: {} },
  { group: "zero", name: "missing-dir", argv: ["list"], seed: { missingRoot: true } },
  { group: "zero", name: "only-dangling-default-symlink", argv: ["list"], seed: { defaultTarget: "ghost" } },

  {
    group: "one",
    name: "no-default-set",
    argv: ["list"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05", root_trajectory: "aaaa" } }] },
  },
  {
    group: "one",
    name: "default-set",
    argv: ["list"],
    seed: {
      identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } }],
      defaultTarget: "alice",
    },
  },
  {
    group: "one",
    name: "default-set-show-dir",
    argv: ["list", "-a"],
    seed: {
      identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } }],
      defaultTarget: "alice",
    },
  },

  {
    group: "three",
    name: "mixed-dates-started-fallback-stray-dir-default",
    argv: ["list"],
    seed: {
      identities: [
        { name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } },
        { name: "bob", info: { name: "bob", created: "2025-12-31T23:59:59" } },
        { name: "carol", info: { name: "carol", started: "2024-06-01T00:00:00" } }, // no `created=`
      ],
      dirs: ["strayvisible"],
      hiddenDirs: [".stray_hidden"],
      defaultTarget: "bob",
    },
  },
  {
    group: "three",
    name: "mixed-dates-started-fallback-stray-dir-default--show-dir",
    argv: ["list", "-a"],
    seed: {
      identities: [
        { name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } },
        { name: "bob", info: { name: "bob", created: "2025-12-31T23:59:59" } },
        { name: "carol", info: { name: "carol", started: "2024-06-01T00:00:00" } },
      ],
      dirs: ["strayvisible"],
      hiddenDirs: [".stray_hidden"],
      defaultTarget: "bob",
    },
  },
  {
    group: "three",
    name: "--all-long-flag-same-as--a",
    argv: ["list", "--all"],
    seed: {
      identities: [
        { name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } },
        { name: "bob", info: { name: "bob", created: "2025-12-31T23:59:59" } },
      ],
      defaultTarget: "bob",
    },
  },

  {
    group: "quirks",
    name: "plain-file-excluded",
    argv: ["list"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-01T00:00:00" } }], files: ["plainfile.txt"] },
  },
  {
    group: "quirks",
    name: "symlink-to-dir-included-lexical-path-not-realpath",
    argv: ["list", "-a"],
    seed: {
      identities: [{ name: "realdir", info: { name: "realdir", created: "2026-02-02T02:02:02" } }],
      symlinkDirs: [{ name: "linkdir", target: "other/target" }],
    },
  },
  {
    group: "quirks",
    name: "dangling-symlink-excluded",
    argv: ["list"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-01T00:00:00" } }], danglingLinks: ["brokenlink"] },
  },
  {
    group: "quirks",
    name: "case-insensitive-primary-ordering",
    argv: ["list"],
    seed: {
      identities: [
        { name: "zeta", info: { name: "zeta", created: "2026-01-01T00:00:00" } },
        { name: "mike", info: { name: "mike", created: "2026-01-01T00:00:00" } },
        { name: "alpha", info: { name: "alpha", created: "2026-01-01T00:00:00" } },
        { name: "Bravo", info: { name: "Bravo", created: "2026-01-01T00:00:00" } },
      ],
    },
  },
  {
    group: "quirks",
    name: "long-name-no-truncation",
    argv: ["list"],
    seed: {
      identities: [
        { name: "this-is-a-very-long-identity-name", info: { name: "this-is-a-very-long-identity-name", created: "2026-03-03T03:03:03" } },
      ],
    },
  },

  {
    group: "argv-edge-cases",
    name: "extra-positional-ignored",
    argv: ["list", "foo", "bar"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } }] },
  },
  {
    group: "argv-edge-cases",
    name: "unknown-flag-stops-parsing-silently",
    argv: ["list", "-x"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } }] },
  },
  {
    group: "argv-edge-cases",
    name: "-a-after-positional-not-reparsed",
    argv: ["list", "foo", "-a"],
    seed: { identities: [{ name: "alice", info: { name: "alice", created: "2026-01-02T03:04:05" } }] },
  },
];

const results = [];
for (const sc of scenarios) {
  const sbBash = makeSandbox(sc.seed);
  const sbTs = makeSandbox(sc.seed);
  const bash = runTool("bash", sc, sbBash);
  const ts = runTool("ts", sc, sbTs);

  const bN = { stdout: bufNorm(bash.stdout, sbBash.roots), stderr: bufNorm(bash.stderr, sbBash.roots), status: bash.status };
  const tN = { stdout: bufNorm(ts.stdout, sbTs.roots), stderr: bufNorm(ts.stderr, sbTs.roots), status: ts.status };
  const cmp = { stdout: bN.stdout === tN.stdout, stderr: bN.stderr === tN.stderr, status: bN.status === tN.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  results.push({ group: sc.group, name: sc.name, argv: sc.argv, pass, cmp, bash: bN, ts: tN });

  fs.rmSync(sbBash.root, { recursive: true, force: true });
  fs.rmSync(sbTs.root, { recursive: true, force: true });
}

for (const r of results) {
  for (const side of [r.bash, r.ts]) {
    side.stdout = scrubArtifactPaths(side.stdout);
    side.stderr = scrubArtifactPaths(side.stderr);
  }
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);

function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}

let md = `# identity list — differential parity proof\n\n`;
md += `Real Bash tool \`headlong/tools/identity list\` vs TS port \`headlong-ts/bin/identity list\`, identical \`.identities\`-shaped fixtures in isolated sandboxes, diffed stdout+stderr+exit code (list is read-only — no on-disk state to compare).\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
md += `| # | group | scenario | argv | verdict | fields differing |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs =
    Object.entries(r.cmp)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(", ") || "-";
  md += `| ${idx++} | ${r.group} | ${r.name} | \`${JSON.stringify(r.argv)}\` | ${r.pass ? "PARITY" : "MISMATCH"} | ${diffs} |\n`;
}
md += `\n## Mismatches (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.group} / ${r.name}\n- argv: \`${JSON.stringify(r.argv)}\`\n- exit: bash=${r.bash.status} ts=${r.ts.status}\n\`\`\`\n`;
  md += block("stdout", r.bash.stdout, r.ts.stdout, r.cmp.stdout) + "\n";
  md += block("stderr", r.bash.stderr, r.ts.stderr, r.cmp.stderr) + "\n```\n\n";
}

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`identity list parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) {
    const diffs = Object.entries(r.cmp)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(",");
    console.log(`  MISMATCH ${r.group}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
  }
}
process.exit(passed === total ? 0 : 1);
