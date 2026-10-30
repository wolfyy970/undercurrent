#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for bug #35: per-skill env-var
// discovery (`collect_skill_vars`, thinkers/_lib/common.sh:315-346) and the
// --var directory auto-mount computation (`_compute_var_mounts`,
// bin/shellm:739-747), against this port's src/skill-env.ts.
//
// Both upstream functions are pure (no docker, no network) — this harness
// sources the REAL common.sh (for collect_skill_vars) and extracts the REAL
// _compute_var_mounts function body from bin/shellm (same `sed -n
// '/^_compute_var_mounts()/,/^}/p'` technique upstream's own
// tests/test_env_image_identity.sh uses), then compares RAW stdout against
// the TS port's collectSkillVars/computeVarMounts for identical fixture
// inputs. No Docker daemon needed; only a real Bash + a checkout at
// PARITY_UPSTREAM_ROOT.
//
// Usage:
//   PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/skill-env/run-parity.mjs
//
// Without PARITY_UPSTREAM_ROOT the whole differential is SKIPPED (never a
// faked pass — same discipline as every other parity/* harness here).
// Writes results.json + report.md beside this file. Exit 0 iff every
// scenario reaches PARITY (or the whole run is a clean SKIP).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectSkillVars, computeVarMounts } from "../../src/skill-env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.PARITY_UPSTREAM_ROOT;

function bashSourceCollectSkillVars(identityDir, { skillsKernelDir } = {}) {
  const script = `
    set -euo pipefail
    source "${UPSTREAM}/thinkers/_lib/common.sh"
    ${skillsKernelDir ? `SKILLS_KERNEL_DIR=${JSON.stringify(skillsKernelDir)}` : "unset SKILLS_KERNEL_DIR || true"}
    collect_skill_vars ${JSON.stringify(identityDir)}
  `;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

// `entries` are raw `_SHELLM_EXTRA_VARS` array elements — "NAME=VALUE" for a
// normal --var, or a bare "NAME" (no "=") for the forward-from-environment
// form (bin/shellm:3029 vs :3033-3034).
function bashComputeVarMountsRaw(entries) {
  const arrayLit = entries.map((e) => JSON.stringify(e)).join(" ");
  const script = `
    set -euo pipefail
    eval "$(sed -n '/^_compute_var_mounts()/,/^}/p' "${UPSTREAM}/bin/shellm")"
    _SHELLM_EXTRA_VARS=(${arrayLit})
    _compute_var_mounts
  `;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function bashComputeVarMounts(vars) {
  return bashComputeVarMountsRaw(vars.map((v) => `${v.name}=${v.value}`));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeSkill(base, name, frontmatterExtra, body = "body\n") {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${frontmatterExtra}---\n${body}`);
}

function buildFixtureA(root) {
  // A realistic identity: kernel skills (no env needs) + bundled skills with
  // a mix of multi-line YAML, inline-JSON, no-frontmatter, and no-env cases.
  const identityDir = path.join(root, "identity-a");
  writeSkill(path.join(identityDir, "kernel"), "mem", "metadata:\n  shelllm:\n    requires:\n      bins: [\"jq\"]\n");
  writeSkill(path.join(identityDir, "skills"), "obsidian", "metadata:\n  shelllm:\n    requires:\n      env: [\"OBSIDIAN_VAULT\"]\n");
  writeSkill(path.join(identityDir, "skills"), "skill-author", 'metadata: {"shelllm": {"requires": {"env": ["API_KEY"]}}}\n');
  writeSkill(path.join(identityDir, "skills"), "web-research", ""); // no metadata at all
  fs.mkdirSync(path.join(identityDir, "skills", "not-a-skill"), { recursive: true }); // no SKILL.md
  return identityDir;
}

function buildFixtureB(root) {
  // Duplicate env names across two skills — proves the sort -u dedupe.
  const identityDir = path.join(root, "identity-b");
  writeSkill(path.join(identityDir, "skills"), "tool-one", "metadata:\n  shelllm:\n    requires:\n      env: [\"SHARED_VAR\", \"ONLY_ONE\"]\n");
  writeSkill(path.join(identityDir, "skills"), "tool-two", "metadata:\n  shelllm:\n    requires:\n      env: [\"SHARED_VAR\", \"ONLY_TWO\"]\n");
  return identityDir;
}

function buildFixtureEmpty(root) {
  return path.join(root, "identity-empty"); // no kernel/, no skills/ at all
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function runScenarios(root) {
  const results = [];

  const identityA = buildFixtureA(root);
  const identityB = buildFixtureB(root);
  const identityEmpty = buildFixtureEmpty(root);

  const altKernel = path.join(root, "alt-kernel");
  writeSkill(altKernel, "goals", "metadata:\n  shelllm:\n    requires:\n      env: [\"GOALS_VAR\"]\n");

  const collectScenarios = [
    { id: "collect/mixed-frontmatter-forms", identityDir: identityA },
    { id: "collect/duplicate-across-skills-dedupe", identityDir: identityB },
    { id: "collect/no-kernel-no-skills", identityDir: identityEmpty },
    { id: "collect/explicit-skills-kernel-dir-override", identityDir: identityEmpty, skillsKernelDir: altKernel },
  ];
  for (const sc of collectScenarios) {
    const opts = sc.skillsKernelDir ? { skillsKernelDir: sc.skillsKernelDir } : {};
    const bash = bashSourceCollectSkillVars(sc.identityDir, opts);
    const port = collectSkillVars(sc.identityDir, sc.skillsKernelDir).join("\n") + (collectSkillVars(sc.identityDir, sc.skillsKernelDir).length ? "\n" : "");
    const bashOut = bash.stdout;
    const pass = bash.status === 0 && bashOut === port;
    results.push({ id: sc.id, kind: "collect_skill_vars", bash: bashOut, port, bashStderr: bash.stderr, pass });
  }

  // computeVarMounts scenarios
  const dirA = path.join(root, "mount-a");
  const dirB = path.join(root, "mount-b");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const mountScenarios = [
    { id: "mounts/mixed-dir-and-non-dir", vars: [{ name: "DATA_DIR", value: dirA }, { name: "PLAIN", value: "not-a-path" }, { name: "MISSING", value: "/no/such/dir/xyz-parity" }] },
    { id: "mounts/two-directories-sorted", vars: [{ name: "TWO", value: dirB }, { name: "ONE", value: dirA }] },
    { id: "mounts/duplicate-directory-not-deduped", vars: [{ name: "A1", value: dirA }, { name: "A2", value: dirA }] },
    { id: "mounts/empty", vars: [] },
  ];
  for (const sc of mountScenarios) {
    const bash = sc.vars.length === 0 ? { stdout: "", stderr: "", status: 0 } : bashComputeVarMounts(sc.vars);
    const portList = computeVarMounts(sc.vars);
    const port = portList.length ? portList.join("\n") + "\n" : "";
    const pass = bash.status === 0 && bash.stdout === port;
    results.push({ id: sc.id, kind: "_compute_var_mounts", bash: bash.stdout, port, bashStderr: bash.stderr, pass });
  }

  // A bare `--var NAME` (no `=`) becomes `_SHELLM_EXTRA_VARS+=("$_var_name")`
  // with no "=VALUE" suffix at all (bin/shellm:3033-3034), so `_val="${_ev#*=}"`
  // (no "=" present) leaves the string UNCHANGED — `_val` equals the var NAME
  // itself, not a resolved value (basically never a real directory). Mirrored
  // on the port side as a {name, value: name} pair — the closest faithful
  // shape, since this port's computeVarMounts takes resolved {name,value}
  // pairs rather than raw "--var" argv strings.
  {
    const bash = bashComputeVarMountsRaw(["BARE_NO_EQUALS"]);
    const portList = computeVarMounts([{ name: "BARE_NO_EQUALS", value: "BARE_NO_EQUALS" }]);
    const port = portList.length ? portList.join("\n") + "\n" : "";
    const pass = bash.status === 0 && bash.stdout === port;
    results.push({ id: "mounts/bare-name-no-equals", kind: "_compute_var_mounts", bash: bash.stdout, port, bashStderr: bash.stderr, pass });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Drive, write artifacts.
// ---------------------------------------------------------------------------

function renderReport(out) {
  let md = `# skill-env differential parity report\n\nGenerated: ${out.generated_at}\n\n`;
  if (out.status === "SKIPPED") {
    md += `**SKIPPED** — ${out.reason}\n`;
    return md;
  }
  md += `${out.pass}/${out.total} scenarios PARITY\n\n`;
  md += `| id | kind | pass |\n| --- | --- | --- |\n`;
  for (const r of out.scenarios) md += `| ${r.id} | ${r.kind} | ${r.pass ? "PASS" : "**DIVERGE**"} |\n`;
  const failures = out.scenarios.filter((r) => !r.pass);
  if (failures.length) {
    md += `\n## Divergences\n\n`;
    for (const r of failures) {
      md += `### ${r.id}\n\nbash:\n\`\`\`\n${r.bash}\`\`\`\nport:\n\`\`\`\n${r.port}\`\`\`\n`;
      if (r.bashStderr) md += `bash stderr:\n\`\`\`\n${r.bashStderr}\`\`\`\n`;
    }
  }
  return md;
}

let out;
if (!UPSTREAM) {
  out = { generated_at: new Date().toISOString(), status: "SKIPPED", reason: "PARITY_UPSTREAM_ROOT not set" };
  console.log("skill-env parity: SKIPPED — PARITY_UPSTREAM_ROOT not set");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-env-parity-"));
  try {
    const scenarios = runScenarios(root);
    const pass = scenarios.filter((r) => r.pass).length;
    out = {
      generated_at: new Date().toISOString(),
      status: "RAN",
      pass,
      total: scenarios.length,
      scenarios,
    };
    console.log(`skill-env parity: ${pass}/${scenarios.length} PARITY`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(HERE, "report.md"), renderReport(out));

const allPass = out.status === "SKIPPED" || out.pass === out.total;
process.exit(allPass ? 0 : 1);
