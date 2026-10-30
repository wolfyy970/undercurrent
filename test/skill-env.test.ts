// skill-env.test.ts — bug #35: per-skill env-var discovery (`collectSkillVars`
// / `collect_skill_vars`) and the --var directory auto-mount computation
// (`computeVarMounts` / `_compute_var_mounts`), plus `pathCovered`
// (`_path_covered`). See parity/skill-env/run-parity.mjs for the differential
// proof against the real Bash functions.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectSkillVars, computeVarMounts, pathCovered } from "../src/skill-env.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skill-env-test-"));
  roots.push(d);
  return d;
}

function writeSkill(base: string, name: string, frontmatterExtra: string, body = "body\n"): void {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${frontmatterExtra}---\n${body}`);
}

describe("collectSkillVars", () => {
  it("returns [] when neither kernel nor skills dir exists", () => {
    const root = tmp();
    expect(collectSkillVars(path.join(root, "identity"))).toEqual([]);
  });

  it("collects env: names from skills/ frontmatter (multi-line YAML form)", () => {
    const root = tmp();
    const identityDir = path.join(root, "identity");
    writeSkill(path.join(identityDir, "skills"), "obsidian", "metadata:\n  shelllm:\n    requires:\n      env: [\"OBSIDIAN_VAULT\"]\n");
    expect(collectSkillVars(identityDir)).toEqual(["OBSIDIAN_VAULT"]);
  });

  it("collects from kernel/ too, sorted + deduped across both dirs", () => {
    const root = tmp();
    const identityDir = path.join(root, "identity");
    writeSkill(path.join(identityDir, "kernel"), "mem", "metadata:\n  shelllm:\n    requires:\n      env: [\"ZVAR\", \"AVAR\"]\n");
    writeSkill(path.join(identityDir, "skills"), "obsidian", "metadata:\n  shelllm:\n    requires:\n      env: [\"OBSIDIAN_VAULT\", \"AVAR\"]\n");
    expect(collectSkillVars(identityDir)).toEqual(["AVAR", "OBSIDIAN_VAULT", "ZVAR"]);
  });

  it("honors an explicit skillsKernelDir override, same as SKILLS_KERNEL_DIR", () => {
    const root = tmp();
    const identityDir = path.join(root, "identity");
    const altKernel = path.join(root, "alt-kernel");
    writeSkill(altKernel, "goals", "metadata:\n  shelllm:\n    requires:\n      env: [\"GOALS_VAR\"]\n");
    expect(collectSkillVars(identityDir, altKernel)).toEqual(["GOALS_VAR"]);
  });

  it("skips a skill with no SKILL.md, no frontmatter, or no env: line", () => {
    const root = tmp();
    const identityDir = path.join(root, "identity");
    const skillsDir = path.join(identityDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "no-skillmd"), { recursive: true });
    writeSkill(skillsDir, "no-metadata", "");
    writeSkill(skillsDir, "no-env", "metadata:\n  shelllm:\n    requires:\n      bins: [\"curl\"]\n");
    expect(collectSkillVars(identityDir)).toEqual([]);
  });

  it("the inline-JSON metadata form is NOT recognized (matches upstream's collect_skill_vars exactly, unlike bin/skills' _extract_shelllm_meta)", () => {
    // collect_skill_vars's own env-line awk (common.sh:333-334) only ever
    // matches an INDENTED `env:` line; an inline `metadata: {"shelllm": ...}`
    // line starts at column 0 and never produces one, so upstream itself
    // silently forwards nothing for this form (confirmed differentially,
    // parity/skill-env/run-parity.mjs "collect/mixed-frontmatter-forms").
    const root = tmp();
    const identityDir = path.join(root, "identity");
    const dir = path.join(identityDir, "skills", "api-thing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: api-thing\ndescription: d\nmetadata: {"shelllm": {"requires": {"env": ["API_KEY"]}}}\n---\nbody\n`
    );
    expect(collectSkillVars(identityDir)).toEqual([]);
  });

  it("a non-directory entry in skills/ (a stray file) is ignored, matching the */ glob", () => {
    const root = tmp();
    const identityDir = path.join(root, "identity");
    fs.mkdirSync(path.join(identityDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(identityDir, "skills", "README.md"), "not a skill dir\n");
    expect(collectSkillVars(identityDir)).toEqual([]);
  });
});

describe("computeVarMounts", () => {
  it("returns [] for vars whose value is not an existing directory", () => {
    expect(computeVarMounts([{ name: "IDENTITY_NAME", value: "pax" }, { name: "MISSING", value: "/no/such/dir/xyz" }])).toEqual([]);
  });

  it("returns the absolute path for a directory-valued var", () => {
    const root = tmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    expect(computeVarMounts([{ name: "DATA_DIR", value: dir }])).toEqual([dir]);
  });

  it("sorts but does NOT dedupe (matches plain `sort`, not `sort -u`)", () => {
    const root = tmp();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const out = computeVarMounts([
      { name: "TWO", value: b },
      { name: "ONE", value: a },
      { name: "ONE_AGAIN", value: a },
    ]);
    expect(out).toEqual([a, a, b].sort());
    expect(out.length).toBe(3);
  });

  it("resolves a relative value the same way `cd $val && pwd` would", () => {
    const root = tmp();
    const dir = path.join(root, "rel");
    fs.mkdirSync(dir);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      // Node's process.cwd() reflects the OS's resolved getcwd() (which may
      // differ from `root` by a symlink, e.g. macOS /var -> /private/var) —
      // compare against path.resolve("rel") from THAT same cwd, not `root`
      // itself, so the assertion isn't sensitive to that OS quirk.
      expect(computeVarMounts([{ name: "REL", value: "rel" }])).toEqual([path.resolve("rel")]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("pathCovered", () => {
  it("a path equal to root is covered", () => {
    expect(pathCovered("/a/b", "/a/b")).toBe(true);
  });
  it("a path under root is covered", () => {
    expect(pathCovered("/a/b/c", "/a/b")).toBe(true);
  });
  it("a sibling path is not covered", () => {
    expect(pathCovered("/a/bc", "/a/b")).toBe(false);
  });
  it("root '/' covers everything (the ${root%/} special case)", () => {
    expect(pathCovered("/anything/at/all", "/")).toBe(true);
  });
  it("an unrelated path is not covered", () => {
    expect(pathCovered("/x/y", "/a/b")).toBe(false);
  });
});
