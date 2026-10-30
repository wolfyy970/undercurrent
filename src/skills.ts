// skills.ts — the skills subsystem the mind reads directly (SPEC §5;
// faithful port of headlong bin/skills, post-8c3f410 split).
//
// PORT-NOTE (1c: 8c3f410): upstream split `bin/skills` on 2026-09-04 — this
// core keeps `list`, `show`, `prompt`, `list-json` (what a wake needs to read
// and render skills into its context) and FORWARDS every other subcommand
// (search, install, remove, check, init, promote, kernel, remote — and any
// bare token that isn't one of the four local ones, e.g. a search query) to
// `headlong-skills.ts`'s `cli()`, mirroring `bin/skills`'s `_forward()`. See
// PARITY.md's skills-split row, tests/test_skills_split.sh (ported as
// test/headlong-skills.test.ts + the forwarding cases in test/skills.test.ts),
// and src/headlong-skills.ts for the manager side.
//
// Skills are executables/playbook DIRECTORIES on disk, NOT a native tool API
// (SPEC §5). Each skill is a directory containing a `SKILL.md` in the Agent
// Skills open standard: YAML frontmatter (`name`, `description`, optional
// `metadata.shelllm.requires`) + a markdown body the model reads.
//
// This is BEHAVIOR-ported, not transliterated: native fs + JSON replace the
// Bash awk/grep/jq pipelines. But the on-disk formats another process reads or
// writes are kept byte-compatible — the SKILL.md scaffold, the `.skillsrc`
// remotes file, and every stdout/stderr byte a differential oracle diffs
// against the real `bin/skills`. Headlong QUIRKS are replicated, not fixed:
//   - `%-60b` list padding is measured in BYTES, but `${desc:0:57}` truncation
//     in CHARACTERS (bin/skills:539-557 pre-split; verified against the real tool).
//   - `list-json` assembles `[` + per-object pretty JSON + `,` manually, so the
//     comma lands on its own line as `}\n,{` (bin/skills:602-622 pre-split).
//   - `_extract_shelllm_meta` parses requirement arrays only in inline-JSON
//     (`bins: ["a","b"]`) form, never YAML dash-lists (bin/skills:255-296).
//   - conflict dedup in `list` but NOT in `list-json` (bin/skills:511-524 pre-split).
//
// The engine imports the typed helpers (buildSkillsPrompt, listSkills, …); the
// sandbox execs bin/skills.mjs, which is a thin wrapper over `cli()`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { runtimePath } from "./runtime.ts";

export const SKILLS_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Context / config
// ---------------------------------------------------------------------------

/** Execution context — injectable so the CLI is deterministic & testable. */
export interface Ctx {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** stdout is a TTY (drives color, `-t 1` in the Bash). Default false. */
  isTTY?: boolean;
  /** Standard input, for the interactive `remove`/`init` prompts. */
  stdin?: string;
}

/** Resolved configuration (flags > env vars > .skillsrc > defaults). */
export interface SkillsConfig {
  skillsDir: string; // SKILLS_DIR, default ./.skills
  kernelDir: string; // SKILLS_KERNEL_DIR, default ""
  kernelTokenBudget: number; // SKILLS_KERNEL_TOKEN_BUDGET, default 8000
  remotes: string; // SKILLS_REMOTES, comma-separated
  verbose: boolean;
  skillsrcPath: string; // active .skillsrc (SKILLSRC override or ./.skillsrc)
}

// PORT-NOTE (1c: 8c3f410): only `dir`/`remotes` feed `resolveConfig` — the
// other flags (project/force/showAll/format/showRequires/init*) that used to
// live on one shared Flags object before the split are now local variables
// in each binary's own `cli()` (skills.ts / headlong-skills.ts).
interface Flags {
  dir?: string;
  remotes?: string;
}

/**
 * Resolve config the way the Bash header does (bin/skills:13-34):
 * precedence flags > exported env vars > .skillsrc file > built-in defaults.
 */
export function resolveConfig(ctx: Ctx, flags: Partial<Flags> = {}): SkillsConfig {
  const env = ctx.env;
  const skillsrcPath = env.SKILLSRC || ".skillsrc";

  // Parse the active .skillsrc for SKILLS_* assignments (only what env lacks).
  const rc: Record<string, string> = {};
  const rcAbs = path.resolve(ctx.cwd, skillsrcPath);
  const rcText = readFileSafe(rcAbs);
  if (rcText != null) {
    for (const line of rcText.split("\n")) {
      const m = /^(SKILLS_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) rc[m[1]!] = stripQuotes(m[2]!.trim());
    }
  }
  // Warn if SKILLSRC override is shadowing a cwd .skillsrc (bin/skills:31-34).
  if (env.SKILLSRC && skillsrcPath !== ".skillsrc" && readFileSafe(path.resolve(ctx.cwd, ".skillsrc")) != null) {
    ctx.stderr(`\x1b[33m⚠\x1b[0m Ignoring .skillsrc in current directory (using ${skillsrcPath})\n`);
  }

  const pick = (k: string, def: string): string => env[k] ?? rc[k] ?? def;

  return {
    skillsDir: flags.dir ?? pick("SKILLS_DIR", "./.skills"),
    kernelDir: pick("SKILLS_KERNEL_DIR", ""),
    kernelTokenBudget: Number(pick("SKILLS_KERNEL_TOKEN_BUDGET", "8000")) || 8000,
    remotes: flags.remotes ?? pick("SKILLS_REMOTES", ""),
    // PORT-NOTE: `verbose` is resolved but never read by any action — matches
    // upstream, where `VERBOSE` only gates a `debug()` helper no test or
    // parity scenario exercises. Kept in SkillsConfig for shape stability.
    verbose: false,
    skillsrcPath,
  };
}

// ---------------------------------------------------------------------------
// Colors (respect TTY + NO_COLOR, exactly as bin/skills:120-129)
// ---------------------------------------------------------------------------

export interface Colors {
  bold: string;
  dim: string;
  blue: string;
  cyan: string;
  yellow: string;
  reset: string;
}

export function colors(ctx: Ctx): Colors {
  if (ctx.isTTY && !ctx.env.NO_COLOR) {
    return {
      bold: "\x1b[1m",
      dim: "\x1b[90m",
      blue: "\x1b[1;34m",
      cyan: "\x1b[36m",
      yellow: "\x1b[33m",
      reset: "\x1b[0m",
    };
  }
  return { bold: "", dim: "", blue: "", cyan: "", yellow: "", reset: "" };
}

// ---------------------------------------------------------------------------
// Low-level string / fs helpers
// ---------------------------------------------------------------------------

export function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Strip ONE layer of surrounding matching quotes ("x" or 'x'), like the sed. */
export function stripQuotes(v: string): string {
  const m = /^(["'])(.*)\1$/.exec(v);
  return m ? m[2]! : v;
}

/** printf %-Ns / %-Nb byte-width left-justify: pad in BYTES (bin/skills quirk). */
export function padB(s: string, width: number): string {
  const n = width - Buffer.byteLength(s, "utf8");
  return n > 0 ? s + " ".repeat(n) : s;
}

/** Char-count truncation to 57 + "…" when char length > 60 (${desc:0:57}...). */
export function truncDesc(desc: string): string {
  const chars = [...desc];
  return chars.length > 60 ? chars.slice(0, 57).join("") + "..." : desc;
}

/**
 * First YAML frontmatter block: only if line 1 is exactly `---`; lines up to
 * (exclusive) the next `---` (awk NR==1/^---$/…, bin/skills:147-152,262).
 */
function firstFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return "";
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    out.push(lines[i]!);
  }
  return out.join("\n");
}

/** frontmatter_field: first `field:` line in the frontmatter, unquoted. */
export function frontmatterField(text: string, field: string): string {
  const fm = firstFrontmatter(text);
  if (!fm) return "";
  for (const line of fm.split("\n")) {
    if (line.startsWith(field + ":")) {
      return stripQuotes(line.slice(field.length + 1).replace(/^[ \t]*/, ""));
    }
  }
  return "";
}

export function fileField(skillMd: string, field: string): string {
  const t = readFileSafe(skillMd);
  return t == null ? "" : frontmatterField(t, field);
}

let _osCache: string | null = null;
export function currentOs(): string {
  if (_osCache != null) return _osCache;
  try {
    _osCache = execSync("uname -s", { encoding: "utf8" }).trim().toLowerCase();
  } catch {
    _osCache = process.platform;
  }
  return _osCache;
}

/** `command -v <bin>` on PATH (executable file); handles a slashed path too. */
export function commandExists(name: string, env: Record<string, string | undefined>): boolean {
  return resolveOnPath(name, env) != null;
}

/** Like `commandExists`, but returns the resolved absolute path (or null). */
export function resolveOnPath(name: string, env: Record<string, string | undefined>): string | null {
  if (name.includes("/")) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const d of (env.PATH ?? "").split(":")) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Executable ```bash blocks — Quarto-style directives (bin/skills:45-117)
// ---------------------------------------------------------------------------

/**
 * Process SKILL.md content, executing ```bash blocks that declare
 * `#| eval: true`. Directives: eval/echo/stdout/stderr. Non-eval blocks pass
 * through re-fenced (directive lines stripped). Used by `show` and `prompt`.
 */
export function processSkillBlocks(content: string): string {
  const lines = content.split("\n");
  // Preserve a trailing-newline-less final line the way `read` does.
  const hadTrailingNL = content.endsWith("\n");
  if (hadTrailingNL) lines.pop();

  const out: string[] = [];
  let state: "passthrough" | "fence" = "passthrough";
  let code: string[] = [];
  let evalDir = false,
    echoDir = false,
    stdoutDir = true,
    stderrDir = true;

  for (const line of lines) {
    if (state === "passthrough") {
      if (/^```bash[ \t]*$/.test(line) || line === "```bash") {
        state = "fence";
        code = [];
        evalDir = false;
        echoDir = false;
        stdoutDir = true;
        stderrDir = true;
      } else {
        out.push(line);
      }
      continue;
    }
    // state === "fence"
    const dm = /^#\| ([a-zA-Z]+):[ \t]*(.*)$/.exec(line);
    if (dm) {
      const key = dm[1]!;
      const value = dm[2]!.replace(/[ \t]+$/, "");
      // The Bash stores the value then compares `== "true"`, so any non-"true"
      // value (incl. "false") disables the directive (bin/skills:69-74,76-98).
      if (key === "eval") evalDir = value === "true";
      else if (key === "echo") echoDir = value === "true";
      else if (key === "stdout") stdoutDir = value === "true";
      else if (key === "stderr") stderrDir = value === "true";
      continue;
    }
    if (line === "```") {
      if (evalDir) {
        if (echoDir) {
          out.push("```bash");
          for (const c of code) out.push(c);
          out.push("```");
        }
        const script = code.map((c) => c + "\n").join("");
        const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
        const so = r.stdout ?? "";
        const se = r.stderr ?? "";
        if (stdoutDir && so.length > 0) out.push(...so.replace(/\n$/, "").split("\n"));
        if (stderrDir && se.length > 0) out.push(...se.replace(/\n$/, "").split("\n"));
      } else {
        out.push("```bash");
        for (const c of code) out.push(c);
        out.push("```");
      }
      state = "passthrough";
      continue;
    }
    code.push(line);
  }
  // Unterminated fence: dropped (matches the Bash — code_lines never flushed).
  let joined = out.join("\n");
  if (out.length > 0) joined += "\n";
  return joined;
}

// ---------------------------------------------------------------------------
// Requirements (metadata.shelllm) parsing & checking (bin/skills:251-353)
// ---------------------------------------------------------------------------

export interface Requirements {
  env?: string[];
  bins?: string[];
  anyBins?: string[];
  os?: string[];
}
export interface SkillMeta {
  requires?: Requirements;
  [k: string]: unknown;
}

/** JSON-parse an inline requirement array value; [] on empty/failure. */
function parseArr(v: string | undefined): string[] {
  if (v == null || v === "") return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? (p as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Extract the `metadata.shelllm` requirements from SKILL.md frontmatter.
 * Returns `{}` when none. Inline JSON (`metadata: {"shelllm":{…}}`) returns the
 * `.shelllm` object verbatim; multi-line YAML returns `{requires:{env,bins,
 * anyBins,os}}` built from the inline JSON arrays after each key.
 */
export function extractShelllmMeta(text: string): SkillMeta {
  const fm = firstFrontmatter(text);
  if (!fm) return {};
  if (!/^metadata:/m.test(fm)) return {};

  // Inline JSON on the metadata line.
  const metaLine = fm.split("\n").find((l) => l.startsWith("metadata:"));
  if (metaLine) {
    const inline = metaLine.replace(/^metadata:[ \t]*/, "");
    if (inline) {
      try {
        const obj = JSON.parse(inline);
        if (obj && typeof obj === "object" && "shelllm" in obj) {
          return (obj as { shelllm: SkillMeta }).shelllm;
        }
      } catch {
        /* fall through to multi-line */
      }
    }
  }

  // Multi-line YAML: first indented `env:`/`bins:`/`anyBins:`/`os:` line.
  const grab = (key: string): string | undefined => {
    for (const l of fm.split("\n")) {
      const re = new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`);
      const m = re.exec(l);
      if (m) return m[1]!;
    }
    return undefined;
  };
  const envV = grab("env");
  const binsV = grab("bins");
  const anyV = grab("anyBins");
  const osV = grab("os");
  if (envV == null && binsV == null && anyV == null && osV == null) return {};

  return {
    requires: {
      env: parseArr(envV),
      bins: parseArr(binsV),
      anyBins: parseArr(anyV),
      os: parseArr(osV),
    },
  };
}

export function isEmptyMeta(meta: SkillMeta): boolean {
  return !meta || Object.keys(meta).length === 0;
}

/**
 * Comma-separated summary of unmet requirements ("" when all met).
 * Order: env, bins, anyBins, os (bin/skills:298-353).
 */
export function missingRequirements(meta: SkillMeta, env: Record<string, string | undefined>): string {
  if (isEmptyMeta(meta)) return "";
  const req = meta.requires ?? {};
  const parts: string[] = [];

  for (const v of req.env ?? []) {
    if (!env[v]) parts.push(v);
  }
  for (const b of req.bins ?? []) {
    if (!commandExists(b, env)) parts.push(b);
  }
  const any = req.anyBins ?? [];
  if (any.length > 0 && !any.some((b) => commandExists(b, env))) {
    parts.push(`one of [${any.join(", ")}]`);
  }
  const os = req.os ?? [];
  if (os.length > 0) {
    const cur = currentOs();
    if (!os.includes(cur)) parts.push(`os:${cur}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Skill directory discovery (bin/skills:154-218)
// ---------------------------------------------------------------------------

/**
 * Realpath a dir string relative to cwd; fall back to the literal (Bash cd||).
 *
 * PORT-NOTE (bug #42): upstream's `_all_skill_dirs`/`_skill_dir_label`
 * (bin/skills:165-188) compute this the same way — `real=$(cd "$d" 2>/dev/
 * null && pwd) || real="$d"` — but bash's `cd` runs in its default LOGICAL
 * mode: an ALREADY-ABSOLUTE `d` (an explicit --dir/SKILLS_DIR) is only
 * `.`/`..`/redundant-slash normalized, never symlink-resolved, while a
 * RELATIVE `d` (the implicit ".skills") resolves against the shell's own
 * $PWD — which bash itself seeded via a real (symlink-resolving) getcwd()
 * at process start. So a relative dir ends up realpath'd but an absolute
 * one does not. Fully `fs.realpathSync`-ing BOTH (as this function used to)
 * makes an absolute --dir that is the SAME physical directory as ./.skills
 * (reached through a symlinked prefix, e.g. macOS's /var -> /private/var
 * under a symlinked tmp/identity root) collapse into one candidate before
 * the per-skill-name dedup/warn logic ever runs — silently swallowing the
 * "found in multiple locations" warning bash prints in that case. See
 * PARITY.md's skills --dir/dedup row and parity/fuzz/findings/skills-1.md.
 */
function realOf(cwd: string, dir: string): string {
  if (path.isAbsolute(dir)) {
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return dir;
      return path.normalize(dir);
    } catch {
      return dir;
    }
  }
  try {
    return fs.realpathSync(path.resolve(cwd, dir));
  } catch {
    return dir;
  }
}

/** Deduplicated search dirs: `.skills`, kernel (if set), SKILLS_DIR — by realpath. */
export function allSkillDirs(cfg: SkillsConfig, cwd: string): string[] {
  const candidates = [".skills", ...(cfg.kernelDir ? [cfg.kernelDir] : []), cfg.skillsDir];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of candidates) {
    if (!d) continue;
    const real = realOf(cwd, d);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(d);
  }
  return out;
}

export function skillDirLabel(cfg: SkillsConfig, cwd: string, dir: string): "project" | "kernel" | "local" {
  if (dir === ".skills") return "project";
  if (cfg.kernelDir && realOf(cwd, dir) === realOf(cwd, cfg.kernelDir)) return "kernel";
  return "local";
}

/** Sorted immediate subdirectories of `dir` that contain a SKILL.md. */
export function skillSubdirs(cwd: string, dir: string): string[] {
  const abs = path.resolve(cwd, dir);
  let entries: string[];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    return [];
  }
  entries.sort();
  const out: string[] = [];
  for (const e of entries) {
    if (fs.existsSync(path.join(abs, e, "SKILL.md"))) out.push(e);
  }
  return out;
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string; // the search-dir string (".skills", kernel abs, …)
  label: "project" | "kernel" | "local";
  path: string; // display path: `${dir}/${basename}`
  skillMd: string; // absolute path to SKILL.md
  eligible: boolean;
  missing: string;
}

/** Structured listing across all search dirs (no conflict dedup — see listSkills). */
export function scanSkills(cfg: SkillsConfig, ctx: Ctx): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const dir of allSkillDirs(cfg, ctx.cwd)) {
    const label = skillDirLabel(cfg, ctx.cwd, dir);
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const skillMd = path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md");
      const text = readFileSafe(skillMd) ?? "";
      const name = frontmatterField(text, "name") || base;
      const description = frontmatterField(text, "description");
      const meta = extractShelllmMeta(text);
      const missing = missingRequirements(meta, ctx.env);
      out.push({
        name,
        description,
        dir,
        label,
        path: `${dir}/${base}`,
        skillMd,
        eligible: missing === "",
        missing,
      });
    }
  }
  return out;
}

/**
 * find_skill: project → kernel → local, by directory name then frontmatter
 * `name`. Returns the skill directory path (relative-to-cwd style) or null.
 */
export function findSkill(cfg: SkillsConfig, ctx: Ctx, name: string): string | null {
  for (const dir of allSkillDirs(cfg, ctx.cwd)) {
    const abs = path.resolve(ctx.cwd, dir);
    if (fs.existsSync(path.join(abs, name, "SKILL.md"))) return `${dir}/${name}`;
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const sn = fileField(path.join(abs, base, "SKILL.md"), "name");
      if (sn === name) return `${dir}/${base}`;
    }
  }
  return null;
}

// PORT-NOTE (1c: 8c3f410): remotes (config parsing, git-cache sync, GitHub
// fallback search) moved to headlong-skills.ts with `search`/`install`
// (their only callers) — `skills` (this file) never resolves a remote.
// `installedSkillNames` (the pre-split `list`'s "Available (from remotes)"
// footer helper) is dropped outright: upstream's own new `action_list`
// (bin/skills post-8c3f410) no longer prints that footer, and the sibling
// `_installed_skill_names` in tools/headlong-skills is dead code there too
// (defined, never called) — porting it would be porting dead code.

// ---------------------------------------------------------------------------
// Output helpers (info/dim/warn — all to stderr, bin/skills:131-139)
// ---------------------------------------------------------------------------

export function info(ctx: Ctx, cols: Colors, msg: string): void {
  ctx.stderr(`${cols.blue}▶${cols.reset} ${msg}\n`);
}
export function dimLine(ctx: Ctx, cols: Colors, msg: string): void {
  ctx.stderr(`${cols.dim}  ${msg}${cols.reset}\n`);
}
export function warn(ctx: Ctx, cols: Colors, msg: string): void {
  ctx.stderr(`${cols.yellow}⚠${cols.reset} ${msg}\n`);
}

export class SkillsError extends Error {}
export function die(msg: string): never {
  throw new SkillsError(msg);
}

// ---------------------------------------------------------------------------
// Engine-facing structured API
// ---------------------------------------------------------------------------

/** `list-json` data: every skill's name/description/instructions (no dedup). */
export function listJson(cfg: SkillsConfig, ctx: Ctx): { name: string; description: string; instructions: string }[] {
  const out: { name: string; description: string; instructions: string }[] = [];
  for (const dir of allSkillDirs(cfg, ctx.cwd)) {
    const abs = path.resolve(ctx.cwd, dir);
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const md = path.join(abs, base, "SKILL.md");
      const text = readFileSafe(md) ?? "";
      out.push({
        name: frontmatterField(text, "name") || base,
        description: frontmatterField(text, "description"),
        instructions: stripFrontmatterRanges(text),
      });
    }
  }
  return out;
}

/** `sed '/^---$/,/^---$/d'`: drop every `---`…`---` line range (frontmatter+). */
function stripFrontmatterRanges(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inRange = false;
  for (const l of lines) {
    if (l === "---") {
      inRange = !inRange;
      continue; // the delimiter line itself is deleted
    }
    if (!inRange) kept.push(l);
  }
  return kept.join("\n").replace(/\n+$/, ""); // $(...) strips trailing newlines
}

/** Rendered SKILL.md (frontmatter kept, ```bash eval blocks processed). null if absent. */
export function renderSkill(cfg: SkillsConfig, ctx: Ctx, name: string): string | null {
  const dir = findSkill(cfg, ctx, name);
  if (dir == null) return null;
  const text = readFileSafe(path.join(path.resolve(ctx.cwd, dir), "SKILL.md"));
  if (text == null) return null;
  return processSkillBlocks(text);
}

/** Parsed requirements for a skill, or null if the skill is not found. */
export function skillRequires(cfg: SkillsConfig, ctx: Ctx, name: string): SkillMeta | null {
  const dir = findSkill(cfg, ctx, name);
  if (dir == null) return null;
  const text = readFileSafe(path.join(path.resolve(ctx.cwd, dir), "SKILL.md")) ?? "";
  return extractShelllmMeta(text);
}

/**
 * `skills prompt` (bin/skills:471-503, post-f1b8693 "wake prompt: skills
 * pass"): a two-line contract plus one line per skill (kernel dir first,
 * then the regular skills dir), deduped by name, first-seen wins. Nothing is
 * inlined — until 2026-09-04 this pasted every kernel SKILL.md body whole
 * (~8K) plus a 12-row CLI table; a `SKILL.md` with no frontmatter also used
 * to abort the whole Bash script under `set -e` (frontmatter_field never
 * fails now — moot for this port's native `frontmatterField`, which already
 * returns "" rather than throwing). PORT-NOTE (1c: f1b8693).
 */
export function buildSkillsPrompt(cfg: SkillsConfig, ctx: Ctx): string {
  const seen = new Set<string>();
  let list = "";
  for (const dir of [cfg.kernelDir, cfg.skillsDir]) {
    if (!dir || !fs.existsSync(path.resolve(ctx.cwd, dir))) continue;
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const md = path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md");
      const text = readFileSafe(md) ?? "";
      const name = frontmatterField(text, "name") || base;
      if (seen.has(name)) continue;
      seen.add(name);
      const desc = frontmatterField(text, "description") || `(no description; run skills show ${name})`;
      list += `  - ${name}: ${desc}\n`;
    }
  }
  let out = "## Skills\n";
  out +=
    "Playbooks I load only when a task calls for one: `skills show <name>` prints it, `skills` lists them, `skills init <name>` starts a new one and `skills install <owner/repo>` fetches one. Nothing below is in my context until I ask for it.\n";
  out += list || "  (none installed)\n";
  return out;
}

// ---------------------------------------------------------------------------
// CLI actions (each mirrors an action_* in bin/skills)
// ---------------------------------------------------------------------------

export function actionList(ctx: Ctx, cfg: SkillsConfig, cols: Colors, showAll: boolean, format: string): number {
  let found = false;
  const skipped: string[] = [];
  const seen = new Set<string>();
  const seenPaths = new Map<string, string>();

  for (const dir of allSkillDirs(cfg, ctx.cwd)) {
    const label = skillDirLabel(cfg, ctx.cwd, dir);
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const md = path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md");
      const text = readFileSafe(md) ?? "";
      const name = frontmatterField(text, "name") || base;
      let desc = frontmatterField(text, "description");
      const skillPath = `${dir}/${base}`;

      if (seen.has(name)) {
        const prev = seenPaths.get(name) ?? "";
        warn(
          ctx,
          cols,
          `skill ${cols.bold}${name}${cols.reset} found in multiple locations:\n    ${prev}\n    ${skillPath}\n  Using the first one. Remove one copy to resolve.`
        );
        continue;
      }
      seen.add(name);
      seenPaths.set(name, skillPath);

      const missing = missingRequirements(extractShelllmMeta(text), ctx.env);
      const eligible = missing === "";

      if (!eligible && !showAll) {
        if (format !== "prompt") {
          const d = truncDesc(desc);
          skipped.push(
            `  ${cols.bold}${padB(name, 20)}${cols.reset} ${padB(cols.dim + d, 60)} ${cols.cyan}[${label}]${cols.reset} ${cols.yellow}(missing: ${missing})${cols.reset}\n    ${cols.dim}${skillPath}${cols.reset}\n`
          );
        }
        continue;
      }

      found = true;
      if (format === "prompt") {
        ctx.stdout(`- ${name}: ${desc}\n`);
      } else if (!eligible) {
        desc = truncDesc(desc);
        ctx.stdout(
          `  ${cols.bold}${padB(name, 20)}${cols.reset} ${padB(cols.dim + desc, 60)} ${cols.cyan}[${label}]${cols.reset} ${cols.yellow}(missing: ${missing})${cols.reset}\n    ${cols.dim}${skillPath}${cols.reset}\n`
        );
      } else {
        desc = truncDesc(desc);
        ctx.stdout(
          `  ${cols.bold}${padB(name, 20)}${cols.reset} ${padB(cols.dim + desc, 60)} ${cols.cyan}[${label}]${cols.reset}\n    ${cols.dim}${skillPath}${cols.reset}\n`
        );
      }
    }
  }

  if (format !== "prompt") {
    if (!found) {
      ctx.stderr("No skills installed.\n");
      // PORT-NOTE (1c: 8c3f410): the hint now names `headlong-skills init`
      // (the manager binary, post-split) instead of the pre-split `skills
      // --init` (which was never a real flag). The "Available (from
      // remotes)" footer this action used to print here is GONE — remotes
      // moved to headlong-skills entirely, and this core `skills` never
      // resolves one.
      ctx.stderr(`  Run ${cols.bold}headlong-skills init${cols.reset} to create one, or ${cols.bold}skills <query>${cols.reset} to search.\n`);
    }

    if (skipped.length > 0) {
      ctx.stdout(`\n${cols.bold}Skipped (missing requirements)${cols.reset}\n`);
      ctx.stdout(skipped.join(""));
    }
  }
  return 0;
}

// PORT-NOTE (bug #59): bash's `list-json` is built with `jq`, which escapes
// a raw DEL byte (0x7F, aka U+007F) in a string as the six-character sequence
// backslash-u-0-0-7-f; `JSON.stringify` does not (the JSON spec only requires
// escaping unescaped U+0000-U+001F, so a passed-through 0x7F is still valid
// JSON, but the bytes differ from jq's). Same class of divergence already
// fixed for `llm` (PARITY.md's llm-slice-1 "F13 U+007F" row / `llmCli.ts`'s
// `jqJson` helper) but never applied to this tool's own JSON output path.
// Verified directly against upstream (parity/fuzz/findings/skills-c2-1.md):
// a skill whose SKILL.md body contains a raw 0x7F byte -- bash's
// `instructions` string escapes it, the port passed the raw byte through.
const jqJson = (s: string): string => s.replace(/\x7f/g, "\\u007f");

export function actionListJson(ctx: Ctx, cfg: SkillsConfig): number {
  ctx.stdout("[");
  let first = true;
  for (const obj of listJson(cfg, ctx)) {
    if (first) first = false;
    else ctx.stdout(",");
    ctx.stdout(jqJson(JSON.stringify(obj, null, 2)) + "\n");
  }
  ctx.stdout("]\n");
  return 0;
}

/**
 * `grep -qi "$query"` on a single line (bin/skills:640,658). The Bash treats the
 * query as a REGEX, not a literal — so `b.r` matches `bar`. Mirror that with a
 * case-insensitive RegExp rather than String.includes (parity fix:
 * search/regex-metachar-grep-vs-includes). A query that is not a valid JS regex
 * → no match (grep exits non-zero inside the `if`, so its branch is skipped too).
 * PORT-NOTE: JS uses ERE-ish semantics while grep defaults to BRE, so a few
 * metacharacters (`+ ? { } | ( )`) that are literal in BRE are special here; `.`,
 * `*`, `[…]`, and anchors — the metacharacters that matter in practice — agree.
 */
export function grepMatch(haystack: string, query: string): boolean {
  try {
    return new RegExp(query, "i").test(haystack);
  } catch {
    return false;
  }
}

// PORT-NOTE (1c: 8c3f410): actionSearch/searchGitHub moved to
// headlong-skills.ts (`search` is a manager-only subcommand post-split).

export function actionShow(ctx: Ctx, cfg: SkillsConfig, cols: Colors, name: string, showRequires: boolean): number {
  const dir = findSkill(cfg, ctx, name);
  if (dir == null) die(`Skill not found: ${name}`);
  const md = path.join(path.resolve(ctx.cwd, dir), "SKILL.md");
  if (showRequires) {
    const meta = extractShelllmMeta(readFileSafe(md) ?? "");
    if (isEmptyMeta(meta)) ctx.stdout("No requirements declared.\n");
    else ctx.stdout(JSON.stringify(meta, null, 2) + "\n");
  } else {
    ctx.stdout(processSkillBlocks(readFileSafe(md) ?? ""));
  }
  return 0;
}

// PORT-NOTE (1c: 8c3f410): actionCheck/actionInit(+scaffoldSkill)/
// actionRemove/actionInstall/tokenEstimate/showKernelBudget/actionPromote/
// actionKernel/writeRemotesToSkillsrc/actionRemoteList/actionRemoteAdd/
// actionRemoteRemove all moved to headlong-skills.ts (manager-only
// subcommands post-split) — unchanged behavior, see that file.

// ---------------------------------------------------------------------------
// Usage text (bin/skills:1259-1335, verbatim)
// ---------------------------------------------------------------------------

// PORT-NOTE (1c: 8c3f410): slimmed to what `list`/`show`/`prompt`/`list-json`
// need — install/search/remove/check/init/promote/kernel/remote text moved to
// headlong-skills.ts's own USAGE. "core help does not advertise install"
// (tests/test_skills_split.sh) is the load-bearing assertion this shrink
// exists to satisfy.
const USAGE = `skills — list, show, and render the skills the mind can use

Usage:
  skills                                    List installed skills (eligible only)
  skills list [--all] [--format=prompt]     List skills; --all includes unmet requirements
  skills show <name> [--requires]           Print a skill's SKILL.md, or its parsed requirements
  skills list-json                          List skills as JSON
  skills prompt                             Print the skills section of the system prompt

Installing, searching, checking, init, promote, kernel and remotes are in
headlong-skills (tools/). \`skills <one of those>\` forwards to it when it is
on PATH.

Options:
  -a, --all          List all skills including those with unmet requirements
  --format FORMAT    Output format: default or "prompt" (compact, for system prompts)
  --requires         Show parsed requirements (with skills show)
  --dir DIR          Use DIR as the skills directory (default: ./.skills)
  -v, --verbose      Verbose/debug mode
  -h, --help         Show help
  --version          Show version

Requirements:
  Skills can declare requirements in SKILL.md frontmatter under metadata.shelllm:
    requires:
      env: ["VAR1", "VAR2"]       All env vars must be set
      bins: ["curl", "jq"]        All binaries must exist on PATH
      anyBins: ["gh", "hub"]      At least one must exist on PATH
      os: ["darwin", "linux"]     Current OS must be in list
  By default \`skills list\` only shows skills whose requirements are met.

Executable blocks:
  A \`\`\`bash block in SKILL.md that starts with \`#| eval: true\` runs when the
  skill is shown or rendered into the prompt; \`#| echo\`, \`#| stdout\` and
  \`#| stderr\` (true/false) control what of it appears. Blocks without
  \`#| eval: true\` pass through unchanged.

Environment:
  SKILLS_DIR              Override skills directory (default: ./.skills)
  SKILLSRC                Override .skillsrc location (default: ./.skillsrc)
  SKILLS_KERNEL_DIR       Kernel directory (always-loaded skills)
  NO_COLOR                Disable color output
`;

// ---------------------------------------------------------------------------
// Forwarding to headlong-skills (bin/skills:562-570, `_forward`)
// ---------------------------------------------------------------------------

// PORT-NOTE (1c: 8c3f410): upstream's `_forward()` resolves the manager as
// `command -v headlong-skills` (PATH) first, falling back to
// `$(dirname BASH_SOURCE)/../tools/headlong-skills` (a checkout-relative
// path) only when PATH lookup fails. This port has no separate `tools/`
// directory — `headlong-killall` and now `headlong-skills` both live flat in
// `bin/` alongside `skills` (see PARITY.md) — so the fallback here resolves
// to a literal SIBLING file in this module's own `../bin/`, one directory up
// from `src/`. The lookup ORDER (PATH, then the fallback) matches upstream
// exactly; only the fallback's target path differs, to match this port's own
// flat bin/ layout.
function resolveManagerPath(env: Record<string, string | undefined>): string | null {
  const onPath = resolveOnPath("headlong-skills", env);
  if (onPath) return onPath;
  const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "headlong-skills");
  try {
    fs.accessSync(sibling, fs.constants.X_OK);
    return sibling;
  } catch {
    return null;
  }
}

/** Forward the FULL original argv to headlong-skills, exactly as upstream's
 *  `exec "$mgr" "${_ARGV[@]}"` hands off the whole original command line
 *  (not just what's left unparsed) the moment a manager-only flag or
 *  subcommand is seen. `triggeringArg` is upstream's `$1` in the die message. */
function forwardToManager(argv: string[], ctx: Ctx, triggeringArg: string): number {
  const mgr = resolveManagerPath(ctx.env);
  if (mgr == null) {
    return fail(ctx, `'${triggeringArg}' is handled by headlong-skills (tools/), which is not on PATH`);
  }
  // PORT-NOTE: upstream `exec`s $mgr directly, relying on its own `#!/usr/bin/
  // env bash` shebang plus PATH to find bash. This port's target is always a
  // Node script, so invoke it with THIS process's own node binary
  // (process.execPath) instead of relying on ctx.env.PATH to contain `node`
  // — a caller that legitimately strips PATH down to a minimal set (e.g. the
  // `--project`/`--remotes`/… manager-only-flag forward, or a sandboxed
  // invocation) must not fail to forward purely because `node` itself isn't
  // resolvable. Observable stdout/stderr/exit code are unaffected either way.
  const r = spawnSync(runtimePath(), [mgr, ...argv], {
    cwd: ctx.cwd,
    env: ctx.env as NodeJS.ProcessEnv,
    input: ctx.stdin,
    encoding: "utf8",
  });
  if (r.stdout) ctx.stdout(r.stdout);
  if (r.stderr) ctx.stderr(r.stderr);
  if (r.error) {
    ctx.stderr(`skills: error: failed to run headlong-skills: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// Argument parsing & dispatch (bin/skills:572-613, post-8c3f410)
// ---------------------------------------------------------------------------

// Subcommands the core `skills` still handles itself; everything else
// forwards to headlong-skills (bin/skills:594-598).
const LOCAL_SUBCOMMANDS = new Set(["list", "list-json", "show", "prompt"]);

// Flags that belong to the manager only; hitting one forwards immediately,
// mid-parse, with the WHOLE original argv (bin/skills:587).
const MANAGER_ONLY_FLAGS = new Set(["--project", "--remotes", "--force", "--name", "--description"]);

/**
 * Run the skills CLI. Returns the process exit code. `argv` is the args AFTER
 * the program name (i.e. process.argv.slice(2)).
 */
export function cli(argv: string[], ctx: Ctx): number {
  let dirFlag: string | undefined;
  let showAll = false;
  let format = "";
  let showRequires = false;
  const positional: string[] = [];

  // PORT-NOTE (parity fix — global/{dir,format}-missing-value, carried
  // through the split): this loop runs INSIDE a try so a missing required
  // flag value (req()) is reported through fail() — `skills: error: …
  // requires …`, rc 1, empty stdout — instead of escaping as an uncaught
  // Node stack trace. The real Bash `${2:?msg}` prints its own shell-builtin
  // one-liner and exits 1; we match exit code + stdout + on-disk state and
  // DEVIATE only on the exact stderr wording.
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (MANAGER_ONLY_FLAGS.has(a)) return forwardToManager(argv, ctx, a);
      switch (a) {
        case "-h":
        case "--help":
          ctx.stdout(USAGE);
          return 0;
        case "--version":
          ctx.stdout(`skills ${SKILLS_VERSION}\n`);
          return 0;
        case "-v":
        case "--verbose":
          break; // VERBOSE is a debug-only knob; no behavior gated on it here.
        case "--dir":
          dirFlag = req(argv, ++i, "--dir requires a path");
          break;
        case "-a":
        case "--all":
          showAll = true;
          break;
        case "--format":
          format = req(argv, ++i, "--format requires a value");
          break;
        case "--requires":
          showRequires = true;
          break;
        default:
          if (a.startsWith("--format=")) format = a.slice("--format=".length);
          else if (a.startsWith("-")) return fail(ctx, `Unknown option: ${a} (try skills --help)`);
          else positional.push(a);
      }
    }
  } catch (e) {
    if (e instanceof SkillsError) return fail(ctx, e.message);
    throw e;
  }

  const cfg = resolveConfig(ctx, dirFlag !== undefined ? { dir: dirFlag } : {});
  const cols = colors(ctx);

  // Subcommand dispatch: positional[0] may name a LOCAL subcommand; anything
  // else (search, install, remove, check, init, promote, kernel, remote, or
  // any other bare token — e.g. a search query) forwards whole.
  let action = "";
  if (positional.length > 0) {
    if (LOCAL_SUBCOMMANDS.has(positional[0]!)) {
      action = positional.shift()!;
    } else {
      return forwardToManager(argv, ctx, positional[0]!);
    }
  }
  const remaining = positional.join(" ");

  try {
    switch (action) {
      case "list-json":
        return actionListJson(ctx, cfg);
      case "prompt":
        ctx.stdout(buildSkillsPrompt(cfg, ctx));
        return 0;
      case "show":
        if (!remaining) die("show requires a skill name");
        return actionShow(ctx, cfg, cols, remaining, showRequires);
      case "list":
      case "":
      default:
        return actionList(ctx, cfg, cols, showAll, format);
    }
  } catch (e) {
    if (e instanceof SkillsError) return fail(ctx, e.message);
    throw e;
  }
}

export function req(argv: string[], i: number, msg: string): string {
  const v = argv[i];
  // Bash `${2:?msg}` dies on null OR empty, so an empty-string flag value
  // (`--name ""`) aborts exactly as a missing one does.
  if (v == null || v === "") {
    throw new SkillsError(msg);
  }
  return v;
}

export function fail(ctx: Ctx, msg: string): number {
  ctx.stderr(`skills: error: ${msg}\n`);
  return 1;
}
