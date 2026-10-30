// skills-content.test.ts — verify bundled skill content integrity.
//
// Asserts that:
// - All skill packs defined in src/identity.ts are present in src/assets/skills/
// - Each SKILL.md file is non-empty
// - Kernel skills (mem, chat) exist and are non-empty
// - Bundled skills are present and non-empty
//
// PORT-NOTE (1c: f1b8693): "goals" dropped from kernel and
// "file-tools" dropped from bundled — both SKILL.md sources were deleted
// upstream (goals never printed its block; file-tools advertised the
// already-retired view/put/sub/glob). See PARITY.md "Retired:
// focus/glob/put/sub/view" and the f1b8693 identity/skills row.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("skills-content", () => {
  const skillsDir = path.resolve(import.meta.dirname, "../src/assets/skills");

  // These constants match src/identity.ts KERNEL_SKILLS and BUNDLED_SKILLS
  const kernelSkills = ["mem", "chat"];
  const bundledSkills = [
    "googleworkspace",
    "obsidian",
    "shellm",
    "skill-author",
    "slack",
    "telegram",
    "web-research",
  ];
  const allSkills = [...kernelSkills, ...bundledSkills];

  it("should have README.md at skills root", () => {
    const readmePath = path.join(skillsDir, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("should have all kernel skills", () => {
    for (const skill of kernelSkills) {
      const skillPath = path.join(skillsDir, skill, "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("should have all bundled skills", () => {
    for (const skill of bundledSkills) {
      const skillPath = path.join(skillsDir, skill, "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("pack directory listing should match expected set", () => {
    const entries = fs
      .readdirSync(skillsDir)
      .filter(
        (e) =>
          fs.statSync(path.join(skillsDir, e)).isDirectory() &&
          !e.startsWith(".")
      )
      .sort();
    const expected = allSkills.sort();
    expect(entries).toEqual(expected);
  });

  it("should not have unexpected skill packs", () => {
    const entries = new Set(
      fs
        .readdirSync(skillsDir)
        .filter(
          (e) =>
            fs.statSync(path.join(skillsDir, e)).isDirectory() &&
            !e.startsWith(".")
        )
    );
    const expected = new Set(allSkills);
    for (const entry of entries) {
      expect(expected.has(entry)).toBe(true);
    }
  });

  // Sync 2e39a3f (494fda1): the mem skill tells the persona that mem add/edit redact credentials.
  it("mem SKILL.md documents write-point redaction (sync 2e39a3f)", () => {
    const mem = fs.readFileSync(path.join(skillsDir, "mem", "SKILL.md"), "utf-8");
    expect(mem).toContain("`mem add` and `mem edit` redact known credential values and formats");
    expect(mem).toContain("this is not a secret store");
  });

  // Sync 2e39a3f: the chat skill teaches `chat sent` and the repeat refusal.
  it("chat SKILL.md documents chat sent and the repeat refusal (sync 2e39a3f)", () => {
    const chat = fs.readFileSync(path.join(skillsDir, "chat", "SKILL.md"), "utf-8");
    expect(chat).toContain("chat sent [--since 24h] [-n N] [--json]");
    expect(chat).toContain("## Knowing what I already sent");
    expect(chat).toContain("`--force` overrides that when");
    expect(chat).toContain("chat pending");
  });
});
