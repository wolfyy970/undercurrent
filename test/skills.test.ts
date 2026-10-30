// skills.test.ts — unit tests for the skills subsystem's CORE binary
// (src/skills.ts): list/show/prompt/list-json plus forwarding.
//
// PORT-NOTE (1c: 8c3f410): upstream split `bin/skills` on 2026-09-04 — this
// core keeps list/show/prompt/list-json and forwards every other subcommand
// (search, install, remove, check, init, promote, kernel, remote, and any
// other bare token) to `headlong-skills`. Manager-only behavior (those
// actions' own logic, GitHub fallback, remotes, the search-regex quirk, the
// init/stdin quirk) now lives in test/headlong-skills.test.ts, which drives
// src/headlong-skills.ts's `cli()` directly. This file covers: the load-
// bearing quirks a port gets wrong in what's LEFT here (byte-width list
// padding vs char-width truncation, the `}\n,{` list-json assembly,
// requirement parsing, the executable-block directives, the new two-line
// `## Skills` prompt format) plus the forwarding contract itself
// (tests/test_skills_split.sh: forwarding, sibling lookup, help no longer
// advertising install).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cli,
  frontmatterField,
  extractShelllmMeta,
  missingRequirements,
  processSkillBlocks,
  buildSkillsPrompt,
  resolveConfig,
  listJson,
  type Ctx,
} from "../src/skills.js";

// --- test harness ------------------------------------------------------------

const REPO_BIN = path.resolve(import.meta.dirname, "../bin");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
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

/** Run the CLI with a deterministic (non-TTY, NO_COLOR) context. PATH is
 *  omitted by default (env.PATH undefined) so a forwarding call exercises
 *  the checkout-relative sibling fallback, not a PATH lookup — pass `PATH`
 *  in `env` to test the PATH-first branch instead. */
function run(argv: string[], opts: { cwd: string; env?: Record<string, string | undefined>; stdin?: string }): RunResult {
  let out = "";
  let err = "";
  const ctx: Ctx = {
    cwd: opts.cwd,
    env: { NO_COLOR: "1", HOME: opts.cwd, ...(opts.env ?? {}) },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  };
  const code = cli(argv, ctx);
  return { out, err, code };
}

function mkCtx(cwd: string, env: Record<string, string | undefined> = {}): Ctx {
  return {
    cwd,
    env: { NO_COLOR: "1", HOME: cwd, ...env },
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
  };
}

// --- frontmatter + requirements ---------------------------------------------

describe("frontmatterField", () => {
  it("reads name/description and strips one quote layer, first block only", () => {
    const t = `---\nname: "quoted-name"\ndescription: plain desc\n---\n# body\nname: not-this\n`;
    expect(frontmatterField(t, "name")).toBe("quoted-name");
    expect(frontmatterField(t, "description")).toBe("plain desc");
  });
  it("returns '' when line 1 is not the --- delimiter", () => {
    expect(frontmatterField(`# no frontmatter\nname: x\n`, "name")).toBe("");
  });
});

describe("extractShelllmMeta", () => {
  it("parses multi-line YAML requirement arrays (inline-JSON form only)", () => {
    const t = `---\nname: a\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      bins: ["curl", "jq"]\n      env: ["TOKEN"]\n---\n`;
    expect(extractShelllmMeta(t)).toEqual({ requires: { env: ["TOKEN"], bins: ["curl", "jq"], anyBins: [], os: [] } });
  });
  it("parses inline JSON metadata verbatim (returns the .shelllm object)", () => {
    const t = `---\nname: a\ndescription: d\nmetadata: {"shelllm": {"requires": {"anyBins": ["gh","hub"]}}}\n---\n`;
    expect(extractShelllmMeta(t)).toEqual({ requires: { anyBins: ["gh", "hub"] } });
  });
  it("returns {} when no metadata block", () => {
    expect(extractShelllmMeta(`---\nname: a\ndescription: d\n---\n`)).toEqual({});
  });
});

describe("missingRequirements", () => {
  it("orders env, bins, anyBins, os and reports each unmet", () => {
    const meta = { requires: { env: ["NOPE_ENV_XYZ"], bins: ["definitely_missing_bin_xyz"], anyBins: ["also_missing_1", "also_missing_2"], os: ["plan9"] } };
    const s = missingRequirements(meta, {});
    // os part reports the CURRENT os (never "plan9"), so match the prefix + shape.
    expect(s).toMatch(/^NOPE_ENV_XYZ, definitely_missing_bin_xyz, one of \[also_missing_1, also_missing_2\], os:[a-z0-9_]+$/);
  });
  it("is empty when all requirements are met", () => {
    const meta = { requires: { env: ["PRESENT"], bins: [], anyBins: [], os: [] } };
    expect(missingRequirements(meta, { PRESENT: "1" })).toBe("");
  });
});

// --- executable ```bash blocks ----------------------------------------------

describe("processSkillBlocks", () => {
  it("passes non-eval blocks through re-fenced, executes eval blocks", () => {
    const src = "before\n\n```bash\n#| eval: true\necho ran\n```\n\nafter\n";
    expect(processSkillBlocks(src)).toBe("before\n\nran\n\nafter\n");
  });
  it("honors echo:true (emit source) and stdout:false (suppress output)", () => {
    const src = "```bash\n#| eval: true\n#| echo: true\necho shown\n```\n";
    expect(processSkillBlocks(src)).toBe("```bash\necho shown\n```\nshown\n");
    const hidden = "```bash\n#| eval: true\n#| stdout: false\necho nope\n```\n";
    expect(processSkillBlocks(hidden)).toBe("");
  });
  it("leaves a plain (non-directive) bash block untouched but re-fenced", () => {
    const src = "```bash\nls -la\n```\n";
    expect(processSkillBlocks(src)).toBe("```bash\nls -la\n```\n");
  });
});

// --- list: byte-width padding vs char-width truncation ----------------------

describe("cli list", () => {
  it("eligible skills, byte-width padded columns and label", () => {
    const root = tmp();
    writeSkill(root, ".skills/aa", "aa", "short body\n");
    const r = run(["list"], { cwd: root });
    const expected = "  " + "aa".padEnd(20) + " " + "aa".padEnd(60) + " [project]\n    .skills/aa\n";
    expect(r.out).toBe(expected);
    expect(r.code).toBe(0);
  });

  it("truncates a >60-char description to 57 chars + '...' (CHAR count)", () => {
    const root = tmp();
    const desc = "x".repeat(61);
    writeSkill(root, ".skills/bb", "bb", `---\nname: bb\ndescription: ${desc}\n---\n#b\n`);
    const r = run(["list"], { cwd: root });
    expect(r.out).toContain(" " + ("x".repeat(57) + "...") + " [project]\n");
  });

  it("pads the description column in BYTES, not characters (em-dash quirk)", () => {
    const root = tmp();
    const desc = "a—b"; // 3 chars, 5 bytes
    writeSkill(root, ".skills/cc", "cc", `---\nname: cc\ndescription: ${desc}\n---\n#c\n`);
    const r = run(["list"], { cwd: root });
    const padded = desc + " ".repeat(60 - Buffer.byteLength(desc, "utf8"));
    expect(r.out).toContain(" " + padded + " [project]\n");
  });

  it("sends ineligible skills to a Skipped footer with the missing summary", () => {
    const root = tmp();
    writeSkill(root, ".skills/ok", "ok", "b\n");
    writeSkill(root, ".skills/bad", "bad", `---\nname: bad\ndescription: needs\nmetadata:\n  shelllm:\n    requires:\n      env: ["MISSING_ENV_XYZ"]\n---\n#b\n`);
    const r = run(["list"], { cwd: root });
    expect(r.out).toContain("\nSkipped (missing requirements)\n");
    expect(r.out).toContain("(missing: MISSING_ENV_XYZ)");
    // eligible section lists `ok`, ineligible `bad` is NOT in the eligible part
    expect(r.out.indexOf("ok")).toBeLessThan(r.out.indexOf("Skipped"));
  });

  it("--all lists ineligible inline (no footer); --format=prompt is compact", () => {
    const root = tmp();
    writeSkill(root, ".skills/ok", "ok", "b\n");
    writeSkill(root, ".skills/bad", "bad", `---\nname: bad\ndescription: needs\nmetadata:\n  shelllm:\n    requires:\n      env: ["MISSING_ENV_XYZ"]\n---\n#b\n`);
    const all = run(["list", "--all"], { cwd: root });
    expect(all.out).not.toContain("Skipped");
    expect(all.out).toContain("(missing: MISSING_ENV_XYZ)");
    const prompt = run(["list", "--format=prompt"], { cwd: root });
    expect(prompt.out).toBe("- ok: ok\n"); // ineligible bad omitted entirely
  });

  it("reports 'No skills installed.' on stderr for an empty tree, hinting at headlong-skills init", () => {
    const root = tmp();
    const r = run(["list"], { cwd: root });
    expect(r.out).toBe("");
    expect(r.err).toContain("No skills installed.\n");
    // PORT-NOTE (1c: 8c3f410): the hint names the manager binary now, not the
    // pre-split (and never-real) "skills --init".
    expect(r.err).toContain("Run headlong-skills init to create one");
    expect(r.err).not.toContain("skills --init");
  });

  it("no longer prints an 'Available (from remotes)' footer (moved to headlong-skills)", () => {
    const root = tmp();
    writeSkill(root, ".skills/ok", "ok", "b\n");
    const r = run(["list", "--dir", root], { cwd: root, env: { SKILLS_REMOTES: "/some/remote/path" } });
    expect(r.out).not.toContain("Available (from remotes)");
  });
});

// --- list-json: the manual `[` + object + `,` assembly quirk -----------------

describe("cli list-json", () => {
  it("emits pretty objects joined by a bare comma line (}\\n,{ boundary)", () => {
    const root = tmp();
    writeSkill(root, ".skills/one", "one", "body one\n");
    writeSkill(root, ".skills/two", "two", "body two\n");
    const r = run(["list-json"], { cwd: root });
    expect(r.out.startsWith("[{\n")).toBe(true);
    expect(r.out).toContain("}\n,{\n");
    expect(r.out.endsWith("}\n]\n")).toBe(true);
    // and it is valid JSON once the separators are read as one array
    const parsed = JSON.parse(r.out);
    expect(parsed.map((s: { name: string }) => s.name).sort()).toEqual(["one", "two"]);
    expect(parsed[0].instructions).toContain("body");
  });

  // bug #59: bash's list-json is built with jq, which escapes a raw DEL byte
  // (0x7F) in a string; JSON.stringify passes it through unescaped. Verified
  // directly against upstream (parity/fuzz/findings/skills-c2-1.md): a skill
  // whose SKILL.md body contains a raw DEL byte -> bash's `instructions`
  // string is byte-escaped, the port's read the raw byte through.
  it("escapes a raw DEL byte (0x7F) in instructions like jq, not raw-byte-through like JSON.stringify", () => {
    const root = tmp();
    const del = String.fromCharCode(0x7f);
    writeSkill(root, ".skills/x", "x", `A${del}B\n`);
    const r = run(["list-json"], { cwd: root });
    expect(r.out).toContain("A\\u007fB");
    expect(r.out).not.toContain(`A${del}B`);
  });
});

// --- prompt: the new two-line "## Skills" contract (post-f1b8693) -----------

describe("cli prompt / buildSkillsPrompt", () => {
  // PORT-NOTE (1c: f1b8693): "wake prompt: skills pass" replaced the old
  // "## My skills system" CLI-cheatsheet + inlined-kernel-bodies block with a
  // two-line contract and a flat, deduped `- name: description` list (kernel
  // dir first, then the regular skills dir). Nothing is inlined any more.
  it("prints the '## Skills' contract and lists an installed skill", () => {
    const root = tmp();
    writeSkill(root, ".skills/foo", "foo", `---\nname: foo\ndescription: a foo skill\n---\n#f\n`);
    const r = run(["prompt"], { cwd: root });
    expect(r.out).toBe(
      "## Skills\n" +
        "Playbooks I load only when a task calls for one: `skills show <name>` prints it, `skills` lists them, `skills init <name>` starts a new one and `skills install <owner/repo>` fetches one. Nothing below is in my context until I ask for it.\n" +
        "  - foo: a foo skill\n"
    );
    // engine-facing API returns the same text
    expect(buildSkillsPrompt(resolveConfig(mkCtx(root)), mkCtx(root))).toBe(r.out);
  });

  it("prints '(none installed)' when nothing is installed", () => {
    const r = run(["prompt"], { cwd: tmp() });
    expect(r.out.endsWith("  (none installed)\n")).toBe(true);
  });

  it("does not inline kernel bodies and has no CLI table (unlike the pre-f1b8693 block)", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "kernel/core"), { recursive: true });
    fs.writeFileSync(path.join(root, "kernel/core/SKILL.md"), "---\nname: core\ndescription: Always loaded\n---\nKernel body here.\n");
    const r = run(["prompt"], { cwd: root, env: { SKILLS_KERNEL_DIR: "kernel" } });
    expect(r.out).toContain("core: Always loaded");
    expect(r.out).not.toContain("Kernel body here");
    expect(r.out).not.toContain("skills remote add");
    expect(Buffer.byteLength(r.out, "utf8")).toBeLessThan(1024);
  });

  it("survives (and lists by directory name) a SKILL.md with no frontmatter", () => {
    // Until 2026-09-04 a frontmatter-less SKILL.md aborted the whole Bash
    // script under `set -e`; this port's native frontmatterField never threw
    // to begin with, but the default-description text is a real behavior
    // change worth pinning (bin/skills:486-491 post-f1b8693).
    const root = tmp();
    fs.mkdirSync(path.join(root, ".skills/bare"), { recursive: true });
    fs.writeFileSync(path.join(root, ".skills/bare/SKILL.md"), "# Bare\nNo frontmatter here.\n");
    const r = run(["prompt"], { cwd: root });
    expect(r.out).toContain("bare: (no description; run skills show bare)");
    const list = run(["list"], { cwd: root });
    expect(list.code).toBe(0);
    expect(list.out).toContain("bare");
  });

  it("dedupes a skill present in both kernel and regular dirs, kernel wins (first-seen)", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "kernel/dup"), { recursive: true });
    fs.writeFileSync(path.join(root, "kernel/dup/SKILL.md"), "---\nname: dup\ndescription: kernel version\n---\n");
    writeSkill(root, ".skills/dup", "dup", `---\nname: dup\ndescription: regular version\n---\n`);
    const r = run(["prompt"], { cwd: root, env: { SKILLS_KERNEL_DIR: "kernel" } });
    expect(r.out).toContain("dup: kernel version");
    expect(r.out).not.toContain("regular version");
    expect((r.out.match(/dup:/g) ?? []).length).toBe(1);
  });
});

// --- show --------------------------------------------------------------------

describe("cli show", () => {
  it("prints the processed SKILL.md; --requires prints parsed requirements", () => {
    const root = tmp();
    writeSkill(root, ".skills/x", "x", "body text\n");
    const r = run(["show", "x"], { cwd: root });
    expect(r.out).toContain("body text");
    const reqs = run(["show", "x", "--requires"], { cwd: root });
    expect(reqs.out).toBe("No requirements declared.\n");
  });
});

// --- misc: version + errors --------------------------------------------------

describe("cli errors, version, and help", () => {
  it("prints version", () => {
    expect(run(["--version"], { cwd: tmp() }).out).toBe("skills 0.1.0\n");
  });
  it("rejects an unknown option with rc 1", () => {
    const r = run(["--bogus"], { cwd: tmp() });
    expect(r.code).toBe(1);
    expect(r.err).toBe("skills: error: Unknown option: --bogus (try skills --help)\n");
  });
  it("errors on a missing skill (show) and missing args", () => {
    const root = tmp();
    expect(run(["show", "nope"], { cwd: root }).err).toBe("skills: error: Skill not found: nope\n");
    expect(run(["show"], { cwd: root }).err).toBe("skills: error: show requires a skill name\n");
  });
  it("--help does not advertise install (tests/test_skills_split.sh)", () => {
    const r = run(["--help"], { cwd: tmp() });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/^ {2}skills install/m);
    expect(r.out).toContain("Installing, searching, checking, init, promote, kernel and remotes are in");
  });
});

// --- engine API: listJson / resolveConfig -----------------------------------

describe("engine API", () => {
  it("resolveConfig applies flags > env > .skillsrc > defaults", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, ".skillsrc"), 'SKILLS_REMOTES="/from/rc"\nSKILLS_DIR=./from-rc\n');
    // rc provides both
    expect(resolveConfig(mkCtx(root)).remotes).toBe("/from/rc");
    expect(resolveConfig(mkCtx(root)).skillsDir).toBe("./from-rc");
    // env beats rc
    expect(resolveConfig(mkCtx(root, { SKILLS_DIR: "./from-env" })).skillsDir).toBe("./from-env");
    // flag beats env
    expect(resolveConfig(mkCtx(root, { SKILLS_DIR: "./from-env" }), { dir: "./from-flag" }).skillsDir).toBe("./from-flag");
  });
  it("listJson returns name/description/instructions with frontmatter stripped", () => {
    const root = tmp();
    writeSkill(root, ".skills/z", "z", `---\nname: z\ndescription: zed\n---\n\n# z heading\nbody\n`);
    const data = listJson(resolveConfig(mkCtx(root)), mkCtx(root));
    expect(data).toEqual([{ name: "z", description: "zed", instructions: "\n# z heading\nbody" }]);
  });
});

// --- parity fixes (each targets one CONFIRMED port bug from parity/skills) ----

describe("parity fix: flag-missing-value misuse (no uncaught crash)", () => {
  // Bash `${2:?msg}` prints a shell one-liner and exits 1. The port must report
  // through fail() as `skills: error: <msg>` (rc 1, empty stdout) — NOT throw an
  // uncaught SkillsError from the flag loop. Only --dir/--format are validated
  // HERE post-split; --remotes/--name/--description/--force/--project now
  // forward immediately (see "forwarding" describe below and
  // test/headlong-skills.test.ts for their own missing-value checks).
  const cases: [string, string][] = [
    ["--dir", "--dir requires a path"],
    ["--format", "--format requires a value"],
  ];
  for (const [flag, msg] of cases) {
    it(`${flag} with no value → clean error, rc 1, no throw`, () => {
      const root = tmp();
      // If cli() re-threw, this call would throw and fail the test.
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

describe("bug #42: --dir coinciding with implicit ./.skills via a symlink is not deduped (matches bash)", () => {
  // Upstream `_all_skill_dirs`/`_skill_dir_label` (bin/skills:165-188 pre-
  // split, unchanged by 8c3f410) resolve each candidate dir with
  // `real=$(cd "$d" 2>/dev/null && pwd)`: bash's `cd` in its default LOGICAL
  // mode does NOT resolve symlinks in an ALREADY ABSOLUTE argument (only
  // collapses `.`/`..`/redundant slashes), but a RELATIVE argument (the
  // implicit ".skills") resolves against the shell's own $PWD — which bash
  // itself seeded via a real (symlink-resolving) getcwd() at process start.
  // So when the physical cwd is reached through a symlink and an absolute
  // `--dir` is given via that SAME symlinked prefix, bash's two "real"
  // strings differ even though they name the same physical directory:
  // `.skills` resolves symlink-free, `--dir` does not. Both dirs then get
  // scanned, and the SAME skill name is found twice, which fires the
  // per-name "found in multiple locations" warn.
  it("warns 'found in multiple locations' like bash, not silent", () => {
    const base = fs.realpathSync(tmp());
    const realRoot = path.join(base, "real");
    fs.mkdirSync(realRoot, { recursive: true });
    const linkRoot = path.join(base, "link");
    fs.symlinkSync(realRoot, linkRoot, "dir");

    // Physical cwd (what bash's own getcwd()-seeded $PWD would show) — goes
    // through the REAL path, no symlink component.
    const cwd = path.join(realRoot, "work");
    writeSkill(cwd, ".skills/foo-skill", "foo-skill", "b\n");

    // --dir given via the SYMLINKED prefix — same physical directory, but a
    // different (unresolved) string, exactly like an identity/env-provided
    // absolute SKILLS_DIR reached through a symlinked tmp/identity root.
    const dirArg = path.join(linkRoot, "work", ".skills");

    const r = run(["list", "--dir", dirArg], { cwd });
    expect(r.code).toBe(0);
    expect(r.out).toContain("foo-skill");
    expect(r.err).toBe(
      `⚠ skill foo-skill found in multiple locations:\n    .skills/foo-skill\n    ${dirArg}/foo-skill\n  Using the first one. Remove one copy to resolve.\n`
    );
  });
});

describe("M1: empty-string flag values die like Bash ${2:?} (not silently accepted)", () => {
  // Bash `${2:?msg}` fires on null OR empty; the port's req() rejects both.
  // Only --dir/--format are validated locally post-split.
  const cases: [string, string][] = [
    ["--dir", "--dir requires a path"],
    ["--format", "--format requires a value"],
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
});

// --- forwarding: tests/test_skills_split.sh's forwarding + sibling lookup ---

describe("forwarding to headlong-skills (tests/test_skills_split.sh)", () => {
  it("forwards an unknown subcommand (search/install/etc.) via the checkout-relative sibling fallback", () => {
    const root = tmp();
    writeSkill(root, ".skills/greet", "greet", `---\nname: greet\ndescription: Say hello politely\n---\n# Greet\nSay hello.\n`);
    // env.PATH is absent here (see run()'s default) — this exercises the
    // fallback path (a literal sibling of skills.ts's own bin/, since this
    // port has no separate tools/ directory).
    const r = run(["check", "greet"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toBe("No requirements declared.\n");
  });

  it("forwards a bare query (search shorthand) and gets a real search result back", () => {
    const root = tmp();
    writeSkill(root, ".skills/needle", "needle", `---\nname: needle\ndescription: findable thing\n---\n#n\n`);
    const r = run(["needle"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed\n");
    expect(r.out).toContain("needle");
    expect(r.out).toContain("findable thing");
  });

  it("forwards a manager-only flag (--project) mid-parse, with the whole original argv", () => {
    const root = tmp();
    const r = run(["init", "viaflag", "--project"], { cwd: root });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, ".skills/viaflag/SKILL.md"))).toBe(true);
  });

  it("also forwards correctly when headlong-skills is resolved via PATH", () => {
    const root = tmp();
    writeSkill(root, ".skills/greet", "greet", `---\nname: greet\ndescription: Say hello politely\n---\n#g\n`);
    const r = run(["check", "greet"], { cwd: root, env: { PATH: REPO_BIN } });
    expect(r.code).toBe(0);
    expect(r.out).toBe("No requirements declared.\n");
  });

  it("reports a clear error when no manager can be found on PATH or as a sibling", () => {
    const root = tmp();
    // An empty PATH and a cwd with no bin/ sibling to fall back to: point the
    // fallback resolution at a directory with nothing in it by running from
    // a context whose skills.ts module path still resolves to the real
    // repo's bin/ — so to truly simulate "no manager", stub PATH to a real
    // but empty directory AND rely on there being no other resolution. Since
    // this port's fallback is a fixed sibling of skills.ts's own location
    // (always present in this checkout), assert the shape of the error
    // instead when that sibling is temporarily renamed.
    const mgr = path.join(REPO_BIN, "headlong-skills");
    const mgrMjs = path.join(REPO_BIN, "headlong-skills.mjs");
    const backupLink = fs.readlinkSync(mgr);
    fs.rmSync(mgr);
    try {
      const r = run(["search", "anything"], { cwd: root, env: { PATH: "" } });
      expect(r.code).toBe(1);
      expect(r.err).toBe("skills: error: 'search' is handled by headlong-skills (tools/), which is not on PATH\n");
    } finally {
      fs.symlinkSync(backupLink, mgr);
      void mgrMjs;
    }
  });
});
