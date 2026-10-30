// headlong-skills.ts — the skills PACKAGE MANAGER: search, install, remove,
// check, init, promote, kernel, and remotes (faithful port of headlong
// tools/headlong-skills).
//
// PORT-NOTE (1c: 8c3f410): upstream split bin/skills on 2026-09-04 — the
// mind's own `skills` (src/skills.ts) keeps list/show/prompt/list-json (what
// a wake needs to read and render skills) and forwards every other
// subcommand here. `tools/headlong-skills` "sources" bin/skills for its
// shared config/helpers/read-actions; this port achieves the same one-source-
// of-truth property by IMPORTING those exports from skills.ts instead of
// re-implementing them. See PARITY.md's skills-split row and
// tests/test_skills_split.sh (ported as test/headlong-skills.test.ts +
// test/skills-forwarding.test.ts).
//
// Every function below is UNCHANGED behavior from the pre-split monolith
// (headlong-ts's own history) except where a PORT-NOTE says otherwise — the
// split moved code, it did not change what these actions do.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  type Ctx,
  type SkillsConfig,
  type Colors,
  SKILLS_VERSION,
  resolveConfig,
  colors,
  fileField,
  readFileSafe,
  commandExists,
  currentOs,
  isEmptyMeta,
  extractShelllmMeta,
  grepMatch,
  padB,
  truncDesc,
  allSkillDirs,
  skillSubdirs,
  findSkill,
  info,
  dimLine,
  warn,
  die,
  SkillsError,
  req,
  fail,
  buildSkillsPrompt,
  actionList,
  actionListJson,
  actionShow,
} from "./skills.ts";

export type { Ctx };

// ---------------------------------------------------------------------------
// Remotes (tools/headlong-skills:51-173 — moved verbatim from bin/skills)
// ---------------------------------------------------------------------------

function remoteCacheRoot(ctx: Ctx): string {
  return path.join(ctx.env.HOME ?? "", ".skills-remotes");
}

function parseRemotes(cfg: SkillsConfig): string[] {
  return cfg.remotes
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");
}

function isGitRemote(remote: string): boolean {
  return /^(https:\/\/|http:\/\/|git:\/\/|ssh:\/\/|git@)/.test(remote);
}

function remoteCacheDir(ctx: Ctx, remote: string): string {
  let s = remote
    .replace(/^https:\/\//, "")
    .replace(/^http:\/\//, "")
    .replace(/^git:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "");
  s = s.replace(/\//g, "-").replace(/:/g, "-");
  return path.join(remoteCacheRoot(ctx), s);
}

function syncRemoteCache(ctx: Ctx, cols: Colors, remote: string): boolean {
  const cacheDir = remoteCacheDir(ctx, remote);
  if (!fs.existsSync(cacheDir)) {
    ctx.stderr(`${cols.dim}Cloning ${remote}...${cols.reset}\n`);
    const r = spawnSync("git", ["clone", "--depth", "1", "-q", remote, cacheDir], { stdio: "ignore" });
    if (r.status !== 0) {
      warn(ctx, cols, `Failed to clone remote: ${remote}`);
      return false;
    }
  } else {
    ctx.stderr(`${cols.dim}Updating ${remote}...${cols.reset}\n`);
    const r = spawnSync("git", ["-C", cacheDir, "pull", "--ff-only", "-q"], { stdio: "ignore" });
    if (r.status !== 0) {
      warn(ctx, cols, `Failed to update remote: ${remote}`);
      return false;
    }
  }
  return true;
}

function remoteLocalPath(ctx: Ctx, cols: Colors, remote: string): string | null {
  if (isGitRemote(remote)) {
    return syncRemoteCache(ctx, cols, remote) ? remoteCacheDir(ctx, remote) : null;
  }
  if (!fs.existsSync(remote) || !fs.statSync(remote).isDirectory()) {
    warn(ctx, cols, `Remote path not found: ${remote}`);
    return null;
  }
  return remote;
}

interface RemoteSkill {
  name: string;
  desc: string;
  remote: string;
}

function fetchRemoteSkills(ctx: Ctx, cols: Colors, remote: string): RemoteSkill[] {
  const p = remoteLocalPath(ctx, cols, remote);
  if (p == null) return [];
  const out: RemoteSkill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(p).sort();
  } catch {
    return [];
  }
  for (const e of entries) {
    const md = path.join(p, e, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    out.push({ name: fileField(md, "name") || e, desc: fileField(md, "description"), remote });
  }
  return out;
}

function allRemoteSkills(ctx: Ctx, cols: Colors, cfg: SkillsConfig): RemoteSkill[] {
  const out: RemoteSkill[] = [];
  for (const r of parseRemotes(cfg)) out.push(...fetchRemoteSkills(ctx, cols, r));
  return out;
}

// ---------------------------------------------------------------------------
// Scaffold (used by action_init)
// ---------------------------------------------------------------------------

/**
 * `skills init`: scaffold a new skill directory with the byte-exact SKILL.md
 * template + scripts/references/assets subdirs. Returns the skill dir path.
 */
function scaffoldSkill(cfg: SkillsConfig, ctx: Ctx, name: string, desc: string, project: boolean): string {
  const targetDir = project ? ".skills" : cfg.skillsDir;
  const skillDir = `${targetDir}/${name}`;
  const abs = path.resolve(ctx.cwd, skillDir);
  if (fs.existsSync(abs)) die(`Directory already exists: ${skillDir}`);
  for (const sub of ["scripts", "references", "assets"]) {
    fs.mkdirSync(path.join(abs, sub), { recursive: true });
  }
  const template =
    `---\n` +
    `name: ${name}\n` +
    `description: ${desc}\n` +
    `---\n\n` +
    `# ${name}\n\n` +
    `## Instructions\n\n` +
    `<!-- Describe what this skill does and how an LLM should use it. -->\n`;
  fs.writeFileSync(path.join(abs, "SKILL.md"), template);
  return skillDir;
}

// ---------------------------------------------------------------------------
// Manager actions (tools/headlong-skills:180-688)
// ---------------------------------------------------------------------------

function actionSearch(ctx: Ctx, cfg: SkillsConfig, cols: Colors, query: string): number {
  ctx.stdout(`${cols.bold}Installed${cols.reset}\n`);
  let foundLocal = false;
  for (const dir of allSkillDirs(cfg, ctx.cwd)) {
    for (const base of skillSubdirs(ctx.cwd, dir)) {
      const text = readFileSafe(path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md")) ?? "";
      const name = fileField(path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md"), "name") || base;
      const desc = fileField(path.join(path.resolve(ctx.cwd, dir), base, "SKILL.md"), "description");
      void text;
      if (grepMatch(`${name} ${desc}`, query)) {
        foundLocal = true;
        ctx.stdout(`  ${cols.bold}${padB(name, 20)}${cols.reset} ${desc}\n`);
      }
    }
  }
  if (!foundLocal) ctx.stdout(`  ${cols.dim}No local matches.${cols.reset}\n`);
  ctx.stdout("\n");

  ctx.stdout(`${cols.bold}Available${cols.reset}\n`);
  if (cfg.remotes) {
    let remoteFound = false;
    for (const r of allRemoteSkills(ctx, cols, cfg)) {
      if (grepMatch(`${r.name} ${r.desc}`, query)) {
        remoteFound = true;
        ctx.stdout(`  ${cols.bold}${padB(r.name, 20)}${cols.reset} ${padB(r.desc, 50)} ${cols.dim}${r.remote}${cols.reset}\n`);
      }
    }
    if (!remoteFound) ctx.stdout(`  ${cols.dim}No remote matches.${cols.reset}\n`);
  } else {
    searchGitHub(ctx, cols, query);
  }
  return 0;
}

/** GitHub-wide fallback search (curl the search API). Network-dependent. */
function searchGitHub(ctx: Ctx, cols: Colors, query: string): void {
  const encoded = encodeURIComponent(query);
  const apiUrl = `https://api.github.com/search/repositories?q=${encoded}+filename:SKILL.md&per_page=10&sort=stars&order=desc`;
  const r = spawnSync("curl", ["-sS", "--max-time", "10", apiUrl], { encoding: "utf8" });
  if (r.status !== 0 || r.error) {
    ctx.stdout(`  ${cols.dim}GitHub search failed (network error).${cols.reset}\n`);
    return;
  }
  let response: unknown;
  try {
    response = JSON.parse(r.stdout);
  } catch {
    ctx.stdout(`  ${cols.dim}No remote matches.${cols.reset}\n`);
    return;
  }
  const resp = response as {
    message?: string;
    items?: { full_name: string; description: string | null; stargazers_count: number; html_url: string }[];
  };
  if (resp.message) {
    ctx.stdout(`  ${cols.dim}GitHub API: ${resp.message}${cols.reset}\n`);
    return;
  }
  const items = resp.items ?? [];
  if (items.length === 0) {
    ctx.stdout(`  ${cols.dim}No remote matches.${cols.reset}\n`);
    return;
  }
  for (const it of items) {
    let d = it.description ?? "—";
    if ([...d].length > 50) d = [...d].slice(0, 47).join("") + "...";
    // The Bash builds the stars field as `★ <count>` in its jq template and prints
    // it whole (bin/skills:695,698 pre-split); keep the `★ ` prefix (parity fix:
    // search/github-fallback-stubbed-curl).
    ctx.stdout(`  ${cols.bold}${padB(it.full_name, 30)}${cols.reset} ${padB(d, 50)} ${cols.dim}★ ${it.stargazers_count}${cols.reset}\n`);
    dimLine(ctx, cols, `  ${it.html_url}`);
  }
}

function actionCheck(ctx: Ctx, cfg: SkillsConfig, name: string): number {
  const dir = findSkill(cfg, ctx, name);
  if (dir == null) die(`Skill not found: ${name}`);
  const meta = extractShelllmMeta(readFileSafe(path.join(path.resolve(ctx.cwd, dir), "SKILL.md")) ?? "");
  if (isEmptyMeta(meta)) {
    ctx.stdout("No requirements declared.\n");
    return 0;
  }
  const reqs = meta.requires ?? {};
  let allMet = 0;

  for (const v of reqs.env ?? []) {
    if (ctx.env[v]) ctx.stdout(`OK    env  ${v}\n`);
    else {
      ctx.stdout(`MISS  env  ${v}\n`);
      allMet = 1;
    }
  }
  for (const b of reqs.bins ?? []) {
    if (commandExists(b, ctx.env)) ctx.stdout(`OK    bin  ${b}\n`);
    else {
      ctx.stdout(`MISS  bin  ${b}\n`);
      allMet = 1;
    }
  }
  const any = reqs.anyBins ?? [];
  if (any.length > 0) {
    let anyFound = false;
    for (const b of any) {
      if (commandExists(b, ctx.env)) {
        ctx.stdout(`OK    bin  ${b} (any)\n`);
        anyFound = true;
      } else {
        ctx.stdout(`MISS  bin  ${b} (any)\n`);
      }
    }
    if (!anyFound) allMet = 1;
  }
  const os = reqs.os ?? [];
  if (os.length > 0) {
    const cur = currentOs();
    if (os.includes(cur)) ctx.stdout(`OK    os   ${cur}\n`);
    else {
      ctx.stdout(`MISS  os   ${cur} (need: ${os.join(", ")})\n`);
      allMet = 1;
    }
  }
  return allMet;
}

function actionInit(ctx: Ctx, cfg: SkillsConfig, cols: Colors, nameIn: string, descIn: string, project: boolean): number {
  // PORT-NOTE (parity fix — init/stdin-name-no-flag): the real Bash reads
  // name/description interactively ONLY when stdin is a TTY (`[[ -t 0 ]]`);
  // piped/non-TTY stdin is IGNORED, so a name-less non-interactive invocation
  // dies "Name is required". The bin wrapper only ever populates ctx.stdin
  // for NON-TTY (piped) input — precisely the case Bash ignores — so `init`
  // must NOT consume ctx.stdin.
  const name = nameIn;
  const desc = descIn;
  if (!name) die("Name is required");

  const skillDir = scaffoldSkill(cfg, ctx, name, desc, project);
  info(ctx, cols, `Created skill scaffold: ${cols.bold}${skillDir}/${cols.reset}`);
  dimLine(ctx, cols, "SKILL.md");
  dimLine(ctx, cols, "scripts/");
  dimLine(ctx, cols, "references/");
  dimLine(ctx, cols, "assets/");
  return 0;
}

function actionRemove(ctx: Ctx, cfg: SkillsConfig, cols: Colors, name: string, force: boolean): number {
  const dir = findSkill(cfg, ctx, name);
  if (dir == null) die(`Skill not found: ${name}`);
  if (!force) {
    ctx.stderr(`Remove skill '${name}' from ${dir}? [y/N] `);
    const reply = (ctx.stdin ?? "").split("\n")[0] ?? "";
    if (!/^[Yy]$/.test(reply.trim())) {
      ctx.stderr("Cancelled.\n");
      return 0;
    }
  }
  fs.rmSync(path.resolve(ctx.cwd, dir), { recursive: true, force: true });
  info(ctx, cols, `Removed: ${name}`);
  return 0;
}

function actionInstall(ctx: Ctx, cfg: SkillsConfig, cols: Colors, source: string, project: boolean): number {
  const targetDir = project ? ".skills" : cfg.skillsDir;
  const targetAbs = path.resolve(ctx.cwd, targetDir);
  fs.mkdirSync(targetAbs, { recursive: true });

  let skillSrc = "";
  let cloned = false;

  const sourceAbs = path.resolve(ctx.cwd, source);
  if (fs.existsSync(sourceAbs) && fs.statSync(sourceAbs).isDirectory()) {
    if (!fs.existsSync(path.join(sourceAbs, "SKILL.md"))) die(`No SKILL.md found in: ${source}`);
    skillSrc = sourceAbs;
  } else if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(source) || isGitRemote(source)) {
    let repoUrl = source;
    if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(source)) repoUrl = `https://github.com/${source}`;
    skillSrc = fs.mkdtempSync(path.join(ctx.env.TMPDIR ?? "/tmp", "skills-"));
    cloned = true;
    info(ctx, cols, `Cloning ${repoUrl}...`);
    const r = spawnSync("git", ["clone", "--depth", "1", "--quiet", repoUrl, skillSrc], { stdio: "ignore" });
    if (r.status !== 0) {
      fs.rmSync(skillSrc, { recursive: true, force: true });
      die(`Failed to clone: ${repoUrl}`);
    }
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) {
      fs.rmSync(skillSrc, { recursive: true, force: true });
      die(`No SKILL.md found in repository: ${repoUrl}`);
    }
  } else {
    if (!cfg.remotes) die(`Invalid source: ${source} (expected name, owner/repo, URL, or local path)`);
    let foundRemote: string | null = null;
    for (const r of allRemoteSkills(ctx, cols, cfg)) {
      if (r.name === source) {
        foundRemote = r.remote;
        break;
      }
    }
    if (!foundRemote) die(`Skill '${source}' not found in configured remotes`);
    const remotePath = isGitRemote(foundRemote) ? remoteCacheDir(ctx, foundRemote) : foundRemote;
    if (!fs.existsSync(remotePath)) die(`Failed to access remote: ${foundRemote}`);
    let remoteSkillDir = "";
    for (const e of fs.readdirSync(remotePath).sort()) {
      const md = path.join(remotePath, e, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      if ((fileField(md, "name") || e) === source) {
        remoteSkillDir = path.join(remotePath, e);
        break;
      }
    }
    if (!remoteSkillDir) die(`Skill '${source}' not found in remote: ${foundRemote}`);
    skillSrc = remoteSkillDir;
  }

  const md = path.join(skillSrc, "SKILL.md");
  const skillName = fileField(md, "name") || path.basename(source).replace(/\.git$/, "");
  const skillDesc = fileField(md, "description");
  const installDir = path.join(targetAbs, skillName);
  if (fs.existsSync(installDir)) {
    if (cloned) fs.rmSync(skillSrc, { recursive: true, force: true });
    die(`Skill '${skillName}' already installed at: ${targetDir}/${skillName}`);
  }
  if (cloned) fs.renameSync(skillSrc, installDir);
  else fs.cpSync(skillSrc, installDir, { recursive: true });
  fs.rmSync(path.join(installDir, ".git"), { recursive: true, force: true });

  info(ctx, cols, `Installed: ${cols.bold}${skillName}${cols.reset}`);
  if (skillDesc) dimLine(ctx, cols, skillDesc);

  const meta = extractShelllmMeta(readFileSafe(path.join(installDir, "SKILL.md")) ?? "");
  if (!isEmptyMeta(meta)) {
    const reqs = meta.requires ?? {};
    const envs = reqs.env ?? [];
    if (envs.length > 0) {
      ctx.stdout("\nThis skill requires environment variables:\n");
      for (const v of envs) {
        if (ctx.env[v]) ctx.stdout(`  ${v}  ${cols.dim}(set)${cols.reset}\n`);
        else ctx.stdout(`  ${v}  ${cols.yellow}(not set)${cols.reset}\n`);
      }
      // HEADLONG QUIRK (bin/skills:806-813 pre-split): the example lines
      // interpolate `$var` AFTER the `while read var` loop, where it holds ""
      // (the loop's final read hit EOF on jq's trailing newline). So the var
      // name is empty — replicate.
      ctx.stdout("\nSet these in your shell environment, e.g.:\n");
      ctx.stdout(`  export ="..."\n`);
      ctx.stdout("\nOr use your preferred secrets manager:\n");
      ctx.stdout(`  export =$(op read "op://Personal/${skillName}/api_key")\n`);
      ctx.stdout(`  export =$(pass show ${skillName}/api_key)\n`);
    }
    const bins = [...(reqs.bins ?? []), ...(reqs.anyBins ?? [])];
    if (bins.length > 0) {
      ctx.stdout("\nRequired binaries:\n");
      for (const b of bins) {
        if (commandExists(b, ctx.env)) ctx.stdout(`  ${b} ${cols.dim}(installed)${cols.reset}\n`);
        else ctx.stdout(`  ${b} ${cols.yellow}(not found)${cols.reset}\n`);
      }
    }
  }
  return 0;
}

function tokenEstimate(md: string): number {
  try {
    return Math.floor(fs.statSync(md).size / 4);
  } catch {
    return 0;
  }
}

function showKernelBudget(ctx: Ctx, cfg: SkillsConfig, cols: Colors): void {
  if (!cfg.kernelDir || !fs.existsSync(path.resolve(ctx.cwd, cfg.kernelDir))) return;
  let total = 0;
  for (const base of skillSubdirs(ctx.cwd, cfg.kernelDir)) {
    total += tokenEstimate(path.join(path.resolve(ctx.cwd, cfg.kernelDir), base, "SKILL.md"));
  }
  ctx.stdout("\n");
  ctx.stderr(`${cols.dim}Kernel total: ~${total} / ${cfg.kernelTokenBudget} token budget${cols.reset}\n`);
  if (total > cfg.kernelTokenBudget) {
    warn(ctx, cols, `Kernel exceeds token budget by ~${total - cfg.kernelTokenBudget} tokens`);
  }
}

function actionPromote(ctx: Ctx, cfg: SkillsConfig, cols: Colors, name: string): number {
  if (!cfg.kernelDir) die("No kernel directory configured (set SKILLS_KERNEL_DIR)");
  const kernelAbs = path.resolve(ctx.cwd, cfg.kernelDir);
  if (fs.existsSync(path.join(kernelAbs, name, "SKILL.md"))) die(`Skill '${name}' is already in the kernel`);
  for (const base of skillSubdirs(ctx.cwd, cfg.kernelDir)) {
    if (fileField(path.join(kernelAbs, base, "SKILL.md"), "name") === name) {
      die(`Skill '${name}' is already in the kernel (as ${base})`);
    }
  }
  const skillsAbs = path.resolve(ctx.cwd, cfg.skillsDir);
  let skillPath = "";
  if (fs.existsSync(path.join(skillsAbs, name, "SKILL.md"))) {
    skillPath = path.join(skillsAbs, name);
  } else {
    for (const base of skillSubdirs(ctx.cwd, cfg.skillsDir)) {
      if (fileField(path.join(skillsAbs, base, "SKILL.md"), "name") === name) {
        skillPath = path.join(skillsAbs, base);
        break;
      }
    }
  }
  if (!skillPath) die(`Skill '${name}' not found in skills directory`);
  const dirname = path.basename(skillPath);
  fs.renameSync(skillPath, path.join(kernelAbs, dirname));
  info(ctx, cols, `Promoted ${cols.bold}${name}${cols.reset} to kernel`);
  showKernelBudget(ctx, cfg, cols);
  return 0;
}

function actionKernel(ctx: Ctx, cfg: SkillsConfig, cols: Colors): number {
  if (!cfg.kernelDir || !fs.existsSync(path.resolve(ctx.cwd, cfg.kernelDir))) {
    ctx.stderr("No kernel directory configured (set SKILLS_KERNEL_DIR).\n");
    return 0;
  }
  ctx.stderr(`${cols.bold}Kernel skills${cols.reset} ${cols.dim}(loaded on every turn)${cols.reset}\n`);
  let found = false;
  let total = 0;
  const kernelAbs = path.resolve(ctx.cwd, cfg.kernelDir);
  for (const base of skillSubdirs(ctx.cwd, cfg.kernelDir)) {
    found = true;
    const md = path.join(kernelAbs, base, "SKILL.md");
    const name = fileField(md, "name") || base;
    const tokens = tokenEstimate(md);
    total += tokens;
    ctx.stderr(`  ${cols.bold}${padB(name, 20)}${cols.reset} ${cols.dim}~${tokens} tokens${cols.reset}\n`);
  }
  if (!found) {
    ctx.stderr(`  ${cols.dim}(empty)${cols.reset}\n`);
  } else {
    ctx.stderr(`${cols.dim}Total: ~${total} / ${cfg.kernelTokenBudget} token budget${cols.reset}\n`);
    if (total > cfg.kernelTokenBudget) {
      warn(ctx, cols, `Kernel exceeds token budget by ~${total - cfg.kernelTokenBudget} tokens`);
    }
  }
  return 0;
}

function writeRemotesToSkillsrc(ctx: Ctx, cfg: SkillsConfig): void {
  const rcAbs = path.resolve(ctx.cwd, cfg.skillsrcPath);
  const existing = readFileSafe(rcAbs);
  if (existing != null) {
    if (/^SKILLS_REMOTES=/m.test(existing)) {
      const out = existing
        .split("\n")
        .map((l) => (l.startsWith("SKILLS_REMOTES=") ? `SKILLS_REMOTES="${cfg.remotes}"` : l))
        .join("\n");
      fs.writeFileSync(rcAbs, out);
    } else {
      fs.appendFileSync(rcAbs, `SKILLS_REMOTES="${cfg.remotes}"\n`);
    }
  } else {
    fs.writeFileSync(rcAbs, `# .skillsrc — per-repo configuration for \`skills\`\nSKILLS_REMOTES="${cfg.remotes}"\n`);
  }
}

function actionRemoteList(ctx: Ctx, cfg: SkillsConfig, cols: Colors): number {
  const remotes = parseRemotes(cfg);
  if (remotes.length === 0) {
    ctx.stderr("No remotes configured.\n");
    ctx.stderr(`  Run ${cols.bold}skills remote add <url|path>${cols.reset} to add one.\n`);
    return 0;
  }
  for (const r of remotes) {
    if (isGitRemote(r)) ctx.stdout(`  ${cols.cyan}[git]${cols.reset}   ${r}\n`);
    else ctx.stdout(`  ${cols.cyan}[local]${cols.reset} ${r}\n`);
  }
  return 0;
}

function actionRemoteAdd(ctx: Ctx, cfg: SkillsConfig, cols: Colors, newRemote: string): number {
  if (!newRemote) die("remote add requires a URL or path");
  for (const r of parseRemotes(cfg)) {
    if (r === newRemote) {
      warn(ctx, cols, `Remote already configured: ${newRemote}`);
      return 0;
    }
  }
  cfg.remotes = cfg.remotes ? `${cfg.remotes},${newRemote}` : newRemote;
  writeRemotesToSkillsrc(ctx, cfg);
  if (isGitRemote(newRemote)) {
    fs.mkdirSync(remoteCacheRoot(ctx), { recursive: true });
    // HEADLONG QUIRK (bin/skills:1119-1124 pre-split, under `set -e`): a
    // failed clone makes `_sync_remote_cache` return 1 as a bare statement,
    // which aborts the script BEFORE `info "Added remote"`. So on clone
    // failure we return 1 with no info.
    if (!syncRemoteCache(ctx, cols, newRemote)) return 1;
  }
  info(ctx, cols, `Added remote: ${newRemote}`);
  return 0;
}

function actionRemoteRemove(ctx: Ctx, cfg: SkillsConfig, cols: Colors, target: string): number {
  if (!target) die("remote remove requires a URL or path");
  const remotes = parseRemotes(cfg);
  if (!remotes.includes(target)) die(`Remote not found: ${target}`);
  cfg.remotes = remotes.filter((r) => r !== target).join(",");
  writeRemotesToSkillsrc(ctx, cfg);
  info(ctx, cols, `Removed remote: ${target}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Usage text (tools/headlong-skills:726-803, verbatim)
// ---------------------------------------------------------------------------

const USAGE = `headlong-skills — the skills package manager (search, install, check, remotes)

Usage:
  skills                                    List installed skills (eligible only)
  skills list                               List installed skills (eligible only)
  skills list --all                         List all skills, including ineligible
  skills list --format=prompt               List eligible skills in prompt format
  skills search <query>                     Search installed + remote skills
  skills install <name|owner/repo|url|path> Install a skill
  skills remove <name>                      Remove an installed skill
  skills show <name>                        Print a skill's full SKILL.md
  skills show <name> --requires             Show parsed requirements only
  skills check <name>                       Check if a skill's requirements are met
  skills init [name]                        Scaffold a new skill in current dir
  skills list-json                          List skills as JSON (for programmatic use)
  skills promote <name>                     Move a skill into the kernel (the identity's built-in set; listed, never inlined)
  skills kernel                             Show kernel skills with token counts
  skills prompt                             Print skills system prompt (for LLM context)
  skills remote                             List configured remotes
  skills remote add <url|path>              Add a skill remote
  skills remote remove <url|path>           Remove a skill remote

Options:
  -a, --all          List all skills including those with unmet requirements
  --format FORMAT    Output format: default or "prompt" (compact, for system prompts)
  --requires         Show parsed requirements (with skills show)
  --dir DIR          Use DIR as the skills directory (default: ./.skills)
  --remotes REMOTES  Comma-separated list of remote skill sources
  --project          Target project-level .skills/ instead of local
  --force            Skip confirmation prompts
  --name NAME        Skill name (for init)
  --description DESC Skill description (for init)
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

  By default, \`skills list\` only shows skills whose requirements are met.
  Use \`skills check <name>\` to diagnose specific requirements.

Executable blocks:
  Bash code blocks in SKILL.md can be executed at render time using
  Quarto-inspired directives. Add directives as #| comments at the
  top of a \`\`\`bash fenced block:

    \`\`\`bash
    #| eval: true
    echo "runs at render time"
    \`\`\`

  Directives:
    #| eval: true/false     Execute the block (default: false)
    #| echo: true/false     Show source code in output (default: false)
    #| stdout: true/false   Include stdout in output (default: true)
    #| stderr: true/false   Include stderr in output (default: true)

  Blocks without \`#| eval: true\` pass through unchanged (current behavior).
  Evaluated blocks are processed by \`skills show\` and \`skills prompt\`.

Environment:
  SKILLS_DIR              Override skills directory (default: ./.skills)
  SKILLSRC                Override .skillsrc location (default: ./.skillsrc)
  SKILLS_REMOTES          Remote skill sources (comma-separated)
  SKILLS_KERNEL_DIR       Kernel directory (always-loaded skills)
  SKILLS_KERNEL_TOKEN_BUDGET  Token budget for kernel (default: 8000)
  NO_COLOR                Disable color output
`;

// ---------------------------------------------------------------------------
// Argument parsing & dispatch (tools/headlong-skills:809-957)
// ---------------------------------------------------------------------------

const KNOWN_ACTIONS = new Set([
  "list",
  "search",
  "list-json",
  "install",
  "remove",
  "show",
  "check",
  "init",
  "promote",
  "kernel",
  "prompt",
  "remote",
]);

/**
 * Run the headlong-skills CLI. Returns the process exit code. `argv` is the
 * args AFTER the program name (i.e. process.argv.slice(2)) — identical shape
 * to skills.ts `cli()`, since `skills <manager subcommand>` forwards the
 * whole original argv here verbatim.
 */
export function cli(argv: string[], ctx: Ctx): number {
  let dirFlag: string | undefined;
  let remotesFlag: string | undefined;
  let project = false;
  let force = false;
  let initName = "";
  let initDesc = "";
  let showAll = false;
  let format = "";
  let showRequires = false;
  const positional: string[] = [];

  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
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
        case "--project":
          project = true;
          break;
        case "--remotes":
          remotesFlag = req(argv, ++i, "--remotes requires a value");
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
        case "--force":
          force = true;
          break;
        case "--name":
          initName = req(argv, ++i, "--name requires a value");
          break;
        case "--description":
          initDesc = req(argv, ++i, "--description requires a value");
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

  const cfg = resolveConfig(ctx, {
    ...(dirFlag !== undefined ? { dir: dirFlag } : {}),
    ...(remotesFlag !== undefined ? { remotes: remotesFlag } : {}),
  });
  const cols = colors(ctx);

  let action = "";
  if (positional.length > 0 && KNOWN_ACTIONS.has(positional[0]!)) {
    action = positional.shift()!;
  }
  const remaining = positional.join(" ");

  try {
    switch (action) {
      case "list":
        return actionList(ctx, cfg, cols, showAll, format);
      case "list-json":
        return actionListJson(ctx, cfg);
      case "prompt":
        ctx.stdout(buildSkillsPrompt(cfg, ctx));
        return 0;
      case "kernel":
        return actionKernel(ctx, cfg, cols);
      case "remote": {
        const sub = positional[0] ?? "list";
        const arg = positional.slice(1).join(" ");
        if (sub === "list") return actionRemoteList(ctx, cfg, cols);
        if (sub === "add") return actionRemoteAdd(ctx, cfg, cols, arg);
        if (sub === "remove") return actionRemoteRemove(ctx, cfg, cols, arg);
        die(`Unknown remote subcommand: ${sub} (try: list, add, remove)`);
        return 1;
      }
      case "install":
        if (!remaining) die("install requires a source (owner/repo, URL, or path)");
        return actionInstall(ctx, cfg, cols, remaining, project);
      case "remove":
        if (!remaining) die("remove requires a skill name");
        return actionRemove(ctx, cfg, cols, remaining, force);
      case "show":
        if (!remaining) die("show requires a skill name");
        return actionShow(ctx, cfg, cols, remaining, showRequires);
      case "check":
        if (!remaining) die("check requires a skill name");
        return actionCheck(ctx, cfg, remaining);
      case "promote":
        if (!remaining) die("promote requires a skill name");
        return actionPromote(ctx, cfg, cols, remaining);
      case "search":
        if (!remaining) die("search requires a query");
        return actionSearch(ctx, cfg, cols, remaining);
      case "init":
        return actionInit(ctx, cfg, cols, initName || (remaining ? remaining : ""), initDesc, project);
      case "":
        if (remaining) return actionSearch(ctx, cfg, cols, remaining);
        return actionList(ctx, cfg, cols, showAll, format);
      default:
        return actionList(ctx, cfg, cols, showAll, format);
    }
  } catch (e) {
    if (e instanceof SkillsError) return fail(ctx, e.message);
    throw e;
  }
}
