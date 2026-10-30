// headlong-skills.test.ts — unit tests for the skills PACKAGE MANAGER
// (src/headlong-skills.ts): search, install, remove, check, init, promote,
// kernel, remotes — plus list/show/prompt working when the manager is run
// standalone (tests/test_skills_split.sh's "manager list works"/"manager
// help advertises install").
//
// PORT-NOTE (1c: 8c3f410): this content was carried verbatim (behavior
// unchanged) from test/skills.test.ts when bin/skills split into a slim core
// (list/show/prompt/list-json + forwarding) and this manager. Every expected
// value here was captured from the real (pre-split) bin/skills / tools/
// headlong-skills and is re-derived independently in-test, same as before.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cli, type Ctx } from "../src/headlong-skills.js";

// --- test harness ------------------------------------------------------------

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "headlong-skills-test-"));
}

function writeSkill(root: string, dir: string, name: string, body: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), body.startsWith("---") ? body : `---\nname: ${name}\ndescription: ${name}\n---\n${body}`);
}

interface RunResult {
  out: string;
  err: string;
  code: number;
}

function run(argv: string[], opts: { cwd: string; env?: Record<string, string | undefined>; stdin?: string }): RunResult {
  let out = "";
  let err = "";
  const ctx: Ctx = {
    cwd: opts.cwd,
    env: { NO_COLOR: "1", HOME: opts.cwd, ...(opts.env ?? {}) },
    stdout: (s: string) => (out += s),
    stderr: (s: string) => (err += s),
    isTTY: false,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  };
  const code = cli(argv, ctx);
  return { out, err, code };
}

// --- list/show/prompt also work standalone (manager sources the core) -------

describe("manager standalone: list/show/prompt (tests/test_skills_split.sh)", () => {
  it("manager list works", () => {
    const root = tmp();
    writeSkill(root, ".skills/greet", "greet", `---\nname: greet\ndescription: Say hello politely\n---\n#g\n`);
    const r = run(["list"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toContain("greet");
  });
  it("manager help advertises install (unlike the slim core's)", () => {
    const r = run(["--help"], { cwd: tmp() });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skills install/);
  });
  it("manager show/prompt/list-json all work directly", () => {
    const root = tmp();
    writeSkill(root, ".skills/x", "x", "hello body\n");
    expect(run(["show", "x"], { cwd: root }).out).toContain("hello body");
    expect(run(["prompt"], { cwd: root }).out).toContain("- x: x\n");
    expect(JSON.parse(run(["list-json"], { cwd: root }).out.replace(/}\n,{/g, "},{"))[0].name).toBe("x");
  });
});

// --- check: exit code reflects unmet requirements ---------------------------

describe("cli check", () => {
  it("returns 0 and 'No requirements declared.' when none", () => {
    const root = tmp();
    writeSkill(root, ".skills/x", "x", "b\n");
    const r = run(["check", "x"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toBe("No requirements declared.\n");
  });
  it("returns 1 and MISS lines when a requirement is unmet", () => {
    const root = tmp();
    writeSkill(root, ".skills/x", "x", `---\nname: x\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["MISSING_ENV_XYZ"]\n---\n`);
    const r = run(["check", "x"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.out).toBe("MISS  env  MISSING_ENV_XYZ\n");
  });
  it("errors on a missing skill and missing args", () => {
    const root = tmp();
    expect(run(["check", "nope"], { cwd: root }).err).toBe("skills: error: Skill not found: nope\n");
    expect(run(["install"], { cwd: root }).err).toBe("skills: error: install requires a source (owner/repo, URL, or path)\n");
  });
});

// --- init: byte-exact scaffold ----------------------------------------------

describe("cli init", () => {
  it("scaffolds SKILL.md + subdirs with the exact template", () => {
    const root = tmp();
    const r = run(["init", "newskill", "--description", "does things"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Created skill scaffold: ./.skills/newskill/\n");
    const md = fs.readFileSync(path.join(root, ".skills/newskill/SKILL.md"), "utf8");
    expect(md).toBe(
      "---\nname: newskill\ndescription: does things\n---\n\n# newskill\n\n## Instructions\n\n<!-- Describe what this skill does and how an LLM should use it. -->\n"
    );
    for (const sub of ["scripts", "references", "assets"]) {
      expect(fs.existsSync(path.join(root, ".skills/newskill", sub))).toBe(true);
    }
  });
  it("refuses to overwrite an existing skill dir", () => {
    const root = tmp();
    writeSkill(root, ".skills/dup", "dup", "b\n");
    const r = run(["init", "dup"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Directory already exists: ./.skills/dup");
  });
});

// --- remotes: .skillsrc byte format -----------------------------------------

describe("cli remote", () => {
  it("add persists a byte-exact .skillsrc, list labels local vs git", () => {
    const root = tmp();
    const add = run(["remote", "add", "/local/one"], { cwd: root });
    expect(add.err).toContain("Added remote: /local/one\n");
    expect(fs.readFileSync(path.join(root, ".skillsrc"), "utf8")).toBe(
      '# .skillsrc — per-repo configuration for `skills`\nSKILLS_REMOTES="/local/one"\n'
    );
    const list = run(["remote"], { cwd: root });
    expect(list.out).toBe("  [local] /local/one\n");
  });
  it("remove drops an entry and rewrites the file; missing errors", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, ".skillsrc"), 'SKILLS_REMOTES="/a, /b"\n');
    const rm = run(["remote", "remove", "/a"], { cwd: root });
    expect(rm.err).toContain("Removed remote: /a\n");
    expect(fs.readFileSync(path.join(root, ".skillsrc"), "utf8")).toBe('SKILLS_REMOTES="/b"\n');
    const miss = run(["remote", "remove", "/nope"], { cwd: root });
    expect(miss.code).toBe(1);
    expect(miss.err).toContain("Remote not found: /nope");
  });
});

// --- install from a local path ----------------------------------------------

describe("cli install (local path)", () => {
  it("copies the skill dir and reports env-var requirements (empty-var quirk)", () => {
    const root = tmp();
    const src = tmp();
    writeSkill(src, "src", "installed", `---\nname: installed\ndescription: an installed one\nmetadata:\n  shelllm:\n    requires:\n      env: ["TOKEN_A"]\n---\n#i\n`);
    const r = run(["install", path.join(src, "src")], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Installed: installed\n");
    expect(fs.existsSync(path.join(root, ".skills/installed/SKILL.md"))).toBe(true);
    // HEADLONG quirk: the example uses an empty var name (bin/skills:806-813 pre-split).
    expect(r.out).toContain('  export ="..."\n');
  });
});

// --- search: local matches use full (untruncated) description ---------------

describe("cli search", () => {
  it("lists installed matches with the full description under 'Installed'", () => {
    const root = tmp();
    writeSkill(root, ".skills/needle", "needle", `---\nname: needle\ndescription: findable thing\n---\n#n\n`);
    const r = run(["needle"], { cwd: root }); // bare query == search
    expect(r.out).toContain("Installed\n");
    expect(r.out).toContain("  " + "needle".padEnd(20) + " findable thing\n");
  });
});

// --- misc: version + errors --------------------------------------------------

describe("cli errors and version", () => {
  it("prints version", () => {
    expect(run(["--version"], { cwd: tmp() }).out).toBe("skills 0.1.0\n");
  });
  it("rejects an unknown option with rc 1", () => {
    const r = run(["--bogus"], { cwd: tmp() });
    expect(r.code).toBe(1);
    expect(r.err).toBe("skills: error: Unknown option: --bogus (try skills --help)\n");
  });
});

// --- parity fixes (each targets one CONFIRMED port bug from parity/skills) ----

describe("parity fix: flag-missing-value misuse (no uncaught crash)", () => {
  const cases: [string, string][] = [
    ["--dir", "--dir requires a path"],
    ["--remotes", "--remotes requires a value"],
    ["--format", "--format requires a value"],
    ["--name", "--name requires a value"],
    ["--description", "--description requires a value"],
  ];
  for (const [flag, msg] of cases) {
    it(`${flag} with no value → clean error, rc 1, no throw`, () => {
      const root = tmp();
      const r = run([flag], { cwd: root });
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toBe(`skills: error: ${msg}\n`);
    });
  }
  it("a flag given its value still parses (regression guard)", () => {
    const root = tmp();
    writeSkill(root, "elsewhere/s", "s", "b\n");
    const r = run(["list", "--dir", path.join(root, "elsewhere")], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toContain("[local]");
  });
});

describe("M1: empty-string flag values die like Bash ${2:?} (not silently accepted)", () => {
  const cases: [string, string][] = [
    ["--dir", "--dir requires a path"],
    ["--remotes", "--remotes requires a value"],
    ["--format", "--format requires a value"],
    ["--name", "--name requires a value"],
    ["--description", "--description requires a value"],
  ];
  for (const [flag, msg] of cases) {
    it(`${flag} "" → clean error, rc 1`, () => {
      const root = tmp();
      const r = run([flag, ""], { cwd: root });
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toBe(`skills: error: ${msg}\n`);
    });
  }

  it("init --name n --description '' dies without scaffolding", () => {
    const root = tmp();
    const r = run(["init", "--name", "n", "--description", ""], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.err).toBe("skills: error: --description requires a value\n");
    expect(fs.existsSync(path.join(root, ".skills/n"))).toBe(false);
  });

  it("init myskill --description '' dies without scaffolding", () => {
    const root = tmp();
    const r = run(["init", "myskill", "--description", ""], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.err).toBe("skills: error: --description requires a value\n");
    expect(fs.existsSync(path.join(root, ".skills/myskill"))).toBe(false);
  });
});

describe("parity fix: search treats the query as a regex (grep -i), not a literal", () => {
  // Bash `grep -qi "$query"`: `b.r` matches `bar`. The port used String.includes.
  // (parity: search/regex-metachar-grep-vs-includes)
  function emptyRemote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "skills-remote-empty-"));
  }
  it("a metacharacter query (b.r) matches bar under Installed", () => {
    const root = tmp();
    writeSkill(root, ".skills/bar", "bar", `---\nname: bar\ndescription: a bar skill\n---\n#b\n`);
    // Non-empty (but skill-less) remote dir keeps the run off the GitHub fallback.
    const r = run(["b.r", "--remotes", emptyRemote()], { cwd: root });
    expect(r.out).toContain("  " + "bar".padEnd(20) + " a bar skill\n");
    expect(r.out).not.toContain("No local matches.");
  });
  it("case-insensitive, like grep -i", () => {
    const root = tmp();
    writeSkill(root, ".skills/bar", "bar", `---\nname: bar\ndescription: a bar skill\n---\n#b\n`);
    const r = run(["B.R", "--remotes", emptyRemote()], { cwd: root });
    expect(r.out).toContain("  " + "bar".padEnd(20) + " a bar skill\n");
  });
  it("a regex that cannot match still yields No local matches", () => {
    const root = tmp();
    writeSkill(root, ".skills/bar", "bar", `---\nname: bar\ndescription: a bar skill\n---\n#b\n`);
    const r = run(["^zzz$", "--remotes", emptyRemote()], { cwd: root });
    expect(r.out).toContain("No local matches.");
  });
});

describe("parity fix: GitHub fallback prints stars as '★ N'", () => {
  // Bash builds `★ \(.stargazers_count)` in its jq template (bin/skills:695,698
  // pre-split). Stub `curl` on PATH so the fallback is exercised with no network.
  // (parity: search/github-fallback-stubbed-curl)
  it("prepends the ★ marker to each repo's star count", () => {
    const bindir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-bin-"));
    const curlPath = path.join(bindir, "curl");
    const json =
      '{"items":[' +
      '{"full_name":"owner/repo-one","description":"a github skill","stargazers_count":42,"html_url":"https://github.com/owner/repo-one"},' +
      '{"full_name":"owner/repo-two","description":null,"stargazers_count":7,"html_url":"https://github.com/owner/repo-two"}' +
      "]}";
    fs.writeFileSync(curlPath, `#!/bin/sh\ncat <<'JSON'\n${json}\nJSON\n`);
    fs.chmodSync(curlPath, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = bindir + path.delimiter + (origPath ?? "");
    try {
      // No remotes configured (and empty cwd) → GitHub fallback path.
      const r = run(["anything"], { cwd: tmp() });
      expect(r.out).toContain("  " + "owner/repo-one".padEnd(30) + " " + "a github skill".padEnd(50) + " ★ 42\n");
      expect(r.out).toContain("★ 7\n");
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("parity fix: init ignores piped (non-TTY) stdin", () => {
  // Bash reads name/desc from stdin only for a TTY (`[[ -t 0 ]]`); piped stdin is
  // ignored, so a name-less non-interactive init dies. (parity: init/stdin-name-no-flag)
  it("does not scaffold from piped stdin — dies 'Name is required'", () => {
    const root = tmp();
    const r = run(["init"], { cwd: root, stdin: "fromstdin\nvia stdin desc\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Name is required");
    expect(fs.existsSync(path.join(root, ".skills/fromstdin"))).toBe(false);
  });
  it("empty piped stdin also dies 'Name is required' (unchanged parity)", () => {
    const root = tmp();
    const r = run(["init"], { cwd: root, stdin: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Name is required");
  });
  it("a name from the positional arg still scaffolds, ignoring stdin content", () => {
    const root = tmp();
    const r = run(["init", "withflag"], { cwd: root, stdin: "ignored-name\nignored-desc\n" });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, ".skills/withflag/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".skills/ignored-name"))).toBe(false);
    const md = fs.readFileSync(path.join(root, ".skills/withflag/SKILL.md"), "utf8");
    expect(md).toContain("name: withflag\n");
    expect(md).toContain("description: \n"); // stdin desc ignored → empty
  });
});
