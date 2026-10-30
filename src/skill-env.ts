// skill-env.ts — per-skill env-var discovery and --var directory auto-mount
// (RUNTIME-SEAMS.md §B row 3 / §D item 4, bug #35).
//
// Upstream discovers, per installed skill, the env vars it declares needing
// (`collect_skill_vars`, thinkers/_lib/common.sh:315-346), forwards each
// present one into the wake's exec env (`_build_shellm_flags`'s trailing
// `--var $vname=$vval` loop, common.sh:405-411), and — in Docker mode — auto
// bind-mounts any `--var` VALUE that is an existing directory at the SAME
// absolute path inside the container, read-write (`_compute_var_mounts` +
// the mount-building loop, bin/shellm:739-747,1013-1024). This port had
// neither half: `FORWARDED_ENV_KEYS` (sandbox-runtime.ts) is a fixed
// API-key-shaped allowlist, and no `--var`-equivalent directory-mount
// mechanism existed at all.
//
// `collectSkillVars` does NOT reuse skills.ts's `extractShelllmMeta`, even
// though its per-skill `env:` awk line is textually byte-identical to
// `_extract_shelllm_meta`'s (both: `/^[[:space:]]+env:/{sub(/.*env:[[:space:]]*/,
// ""); print; exit}`) — `collect_skill_vars` itself never checks for a
// leading `metadata:` line at all (unlike `_extract_shelllm_meta`, which
// bails to `{}` when `^metadata:` is absent) and NEVER handles the
// inline-JSON `metadata: {"shelllm": ...}` form `_extract_shelllm_meta`
// also supports — it only ever finds an INDENTED `env:` line, anywhere in
// the frontmatter, however it got there. A real byte-parity check against
// the actual Bash function (parity/skill-env/run-parity.mjs) caught this:
// a skill using ONLY the inline-JSON form contributes NOTHING to
// `collect_skill_vars`'s output, while `_extract_shelllm_meta`/
// `extractShelllmMeta` would still find it. Reusing extractShelllmMeta here
// would have been a silent, wrong over-forward. So this module has its own
// narrow frontmatter+env-line extraction, matching `collect_skill_vars`
// exactly, not the (looser) `bin/skills` one.

import * as fs from "node:fs";
import * as path from "node:path";

/** `awk 'NR==1 && /^---$/{f=1; next} f && /^---$/{exit} f{print}'`: only if
 *  line 1 is exactly `---`; lines up to (exclusive) the next `---`. */
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

/**
 * `collect_skill_vars`'s per-skill env-line extraction (common.sh:333-334):
 * the FIRST line in the frontmatter matching an INDENTED `env:` (`^[ \t]+env:`
 * — must NOT start at column 0), with everything up to and including the
 * LAST `env:` on that line stripped (awk's greedy `.*env:[ \t]*` sub).
 * `undefined` when no such line exists.
 */
function firstIndentedEnvValue(frontmatter: string): string | undefined {
  for (const line of frontmatter.split("\n")) {
    if (/^[ \t]+env:/.test(line)) {
      return line.replace(/^.*env:[ \t]*/, "");
    }
  }
  return undefined;
}

/** `jq -r '.[]' 2>/dev/null`: elements of a JSON array; [] on any parse
 *  failure or a non-array (jq emits nothing, silently, on either). */
function jsonArrayElements(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function isDirFollowSymlinks(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `collect_skill_vars` (thinkers/_lib/common.sh:315-346): every `env:` name
 * declared by an installed skill's SKILL.md frontmatter, scanned from
 * `skillsKernelDir` (default `<identityDir>/kernel`) then
 * `<identityDir>/skills`, sorted + de-duplicated (`sort -u`). A skill
 * directory with no `SKILL.md`, or a SKILL.md with no frontmatter, or
 * frontmatter with no `env:` line, contributes nothing — matches the Bash's
 * `[[ -f "${skill_dir}SKILL.md" ]]` / empty-frontmatter / empty-env_val
 * `continue` guards.
 */
export function collectSkillVars(identityDir: string, skillsKernelDir?: string): string[] {
  const dirs = [skillsKernelDir ?? path.join(identityDir, "kernel"), path.join(identityDir, "skills")];
  const names = new Set<string>();
  for (const base of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // `[[ -d "$base" ]] || continue`
    }
    for (const entry of entries) {
      // Bash's `"$base"/*/` glob matches directories AND symlinks-to-directories.
      const entryPath = path.join(base, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirFollowSymlinks(entryPath))) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(entryPath, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const frontmatter = firstFrontmatter(text);
      if (!frontmatter) continue; // `[[ -z "$frontmatter" ]] && continue`
      const envVal = firstIndentedEnvValue(frontmatter);
      if (!envVal) continue; // `[[ -z "$env_val" ]] && continue`
      for (const v of jsonArrayElements(envVal)) {
        if (v) names.add(v);
      }
    }
  }
  return [...names].sort();
}

/**
 * `_compute_var_mounts` (bin/shellm:739-747): for every `{name,value}` pair
 * (upstream's `--var NAME=VALUE`/`_SHELLM_EXTRA_VARS` entries) whose VALUE is
 * an EXISTING directory, its absolute path — `sort`ed, NOT de-duplicated
 * (upstream pipes through plain `sort`, never `sort -u`, here — unlike
 * `collectSkillVars` above, which does dedupe via `sort -u`). A value that
 * isn't a directory (a plain env value, or a directory that doesn't exist)
 * contributes nothing, matching `[[ -d "$_val" ]] || continue`.
 *
 * Resolution matches Bash's `cd "$_val" && pwd` (LOGICAL, not `pwd -P`): only
 * `.`/`..`/relative segments are normalized, symlink components are NOT
 * resolved to their targets — `path.resolve`, not `fs.realpathSync`.
 */
export function computeVarMounts(vars: Array<{ name: string; value: string }>): string[] {
  const out: string[] = [];
  for (const v of vars) {
    if (!isDirFollowSymlinks(v.value)) continue;
    out.push(path.resolve(v.value));
  }
  return out.sort();
}

/**
 * `_path_covered` (bin/shellm:893-900): true when `p` equals `root`, or sits
 * under it. Both sides are normalized (trailing slash on `root` stripped
 * before the `/*` pattern, matching the Bash's `${root%/}` — otherwise a
 * root of "/" would produce a `//*` pattern that covers nothing).
 */
export function pathCovered(p: string, root: string): boolean {
  const np = path.normalize(p).replace(/\/+$/, "") || "/";
  let nr = path.normalize(root).replace(/\/+$/, "");
  if (nr === "") nr = "/";
  if (np === nr) return true;
  const prefix = nr === "/" ? "/" : nr + "/";
  return np.startsWith(prefix);
}
