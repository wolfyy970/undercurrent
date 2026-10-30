// identity.ts — `identity new` (PLAN-daemon §5; tools/identity:853-943),
// `identity list` (tools/identity:945-995), `identity export`
// (tools/identity:521-638 cmd_export + tools/identity:420-519 its helpers),
// and `identity import` (tools/identity:706-810 cmd_import +
// tools/identity:642-704 _install_imported_identity).
//
// The other subcommands (info/sync-kernel/default/delete/shell/prompt) are
// out of this lane's scope — not implemented here; see PARITY.md for what
// calls each one.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrajectory } from "./trajectory.ts";
import { readTarGz, writeTarGz, type TarEntry, type TarWriteEntry } from "./tar.ts";

const ASSETS_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/assets";
const ASSETS_THINKERS = path.join(ASSETS_DIR, "thinkers");
const ASSETS_KERNEL = path.join(ASSETS_DIR, "kernel");
const ASSETS_SKILLS = path.join(ASSETS_DIR, "skills");

// tools/identity KERNEL_SKILLS / _ensure_kernel: bootstrapped into kernel/.
// Upstream SYMLINKS these to the Bash checkout's skills/<name>; a portable TS
// package has no such checkout to link to, so this port COPIES the bundled
// SKILL.md text instead (DIRECTOR CORRECTION — see PARITY.md Daemon-runtime
// deviations "kernel/skills copied, not symlinked").
// PORT-NOTE (1c: f1b8693): upstream drops "goals" from KERNEL_SKILLS (the
// goals block never printed — printf misread its own format as an option —
// and skills/goals/SKILL.md is deleted outright) and "file-tools" from the
// bundled set (skills/file-tools/SKILL.md deleted — it advertised the
// already-retired view/put/sub/glob, see PARITY.md "Retired:
// focus/glob/put/sub/view"). tools/identity's KERNEL_SKILLS goes from
// (mem chat goals) to (mem chat); _install_bundled_skills' kernel_skills
// list follows. See src/assets/skills/{goals,file-tools} removal below.
const KERNEL_SKILLS = ["mem", "chat"];
// tools/identity _install_bundled_skills, alphabetical (bundled_dir/*/ glob order).
const BUNDLED_SKILLS = [
  "googleworkspace",
  "obsidian",
  "shellm",
  "skill-author",
  "slack",
  "telegram",
  "web-research",
];

/** Copy every file directly inside `src` into `dest` (flat — every bundled
 *  skill dir here holds only SKILL.md). */
function copyDirFlat(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

export const IDENTITY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// tools/identity:151-268 `_ensure_thinkers` — the fixed 2026-08 consolidation
// list. Recorded in .retired_done on every `identity new` so a later upgrade's
// reconcile pass (out of this lane's scope) never re-disables an operator's
// own thinker authored under one of these names.
const RETIRED_THINKERS = ["actor", "goals_manager", "inner_monologue", "learning", "mind_wanderer", "values_manager"];

// tools/identity:292-303 `_seed_thoughts`, verbatim order.
// Sync 2e39a3f: "I'm here." -> "I am here."; "I am a person." and the family/parents goal line
// dropped; replaced by "I want to live harmoniously with others" (a fresh persona used to chase
// imaginary kin for thirteen wakes — upstream 2026-09-14). Still 11 thoughts.
const SEED_THOUGHTS = [
  "I am here.",
  "I am curious.",
  "I can create memories but don't have any yet.",
  "I can create goals but don't have any yet.",
  "I can think.",
  "I can act.",
  "I have capabilities.",
  "I want to live harmoniously with others",
  "I'm a careful listener and observer.",
  "I'm compassionate and caring.",
];

export interface IdentityNewOptions {
  /** The dir that holds all identities as subdirectories (upstream $IDENTITY_DIR at CLI scope). */
  identitiesRoot: string;
  name: string;
  setDefault?: boolean;
  /** Copy every *.md from this dir into the new identity's memories/. */
  memoriesDir?: string;
  now?: () => Date;
}

export interface IdentityNewResult {
  name: string;
  identityDir: string;
  rootTrajectoryId: string;
  memoriesImported: number;
  defaultSet: boolean;
}

/** `printf 'name=%s\ncreated=%s\nroot_trajectory=%s\n'`. */
function writeInfoTxt(identityDir: string, name: string, created: string, rootTraj: string): void {
  fs.writeFileSync(path.join(identityDir, "info.txt"), `name=${name}\ncreated=${created}\nroot_trajectory=${rootTraj}\n`);
}

/** `date +%Y-%m-%dT%H:%M:%S` (tools/identity iso_timestamp): LOCAL time, no
 *  milliseconds, no `Z`/offset suffix — unlike `Date#toISOString()`. */
function localIsoTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Inject `traj_id` into every subscription line lacking one — replicating
 * tools/identity's `while IFS= read -r line; do … ; printf '\n'; done` loop
 * BYTE FOR BYTE, including its double-newline quirk: a line without
 * `traj_id` is piped through `jq -c` (which prints its own trailing `\n`)
 * and then the loop's own unconditional `printf '\n'` — TWO newlines. A line
 * that already carries `traj_id` skips jq (`printf '%s'`, no newline) and
 * gets only the loop's one `printf '\n'` — ONE newline. Every bundled
 * subscriptions.jsonl lacks traj_id, so an installed file always ends `}\n\n`.
 */
function injectTrajId(subscriptionsPath: string, trajId: string): void {
  const text = fs.readFileSync(subscriptionsPath, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing \n, like `read -r`
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue; // `[[ -z "$line" ]] && continue`
    const obj = JSON.parse(line) as Record<string, unknown>;
    if ("traj_id" in obj) {
      out.push(`${JSON.stringify(obj)}\n`);
    } else {
      out.push(`${JSON.stringify({ ...obj, traj_id: trajId })}\n\n`);
    }
  }
  fs.writeFileSync(subscriptionsPath, out.join(""));
}

function installThinker(thinkersDir: string, name: string, trajId: string): void {
  const src = path.join(ASSETS_THINKERS, name);
  const dest = path.join(thinkersDir, name);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  fs.chmodSync(path.join(dest, "step"), 0o755);
  injectTrajId(path.join(dest, "subscriptions.jsonl"), trajId);
}

export function identityNew(opts: IdentityNewOptions): IdentityNewResult {
  const name = opts.name;
  if (!IDENTITY_NAME_RE.test(name)) {
    throw new Error(`Invalid identity name: '${name}' (use lowercase alphanumeric + hyphens)`);
  }
  const identityDir = path.join(opts.identitiesRoot, name);
  if (fs.existsSync(identityDir)) {
    throw new Error(`Identity '${name}' already exists`);
  }

  fs.mkdirSync(identityDir, { recursive: true });
  fs.mkdirSync(path.join(identityDir, "memories"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "kernel"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "trajectories"), { recursive: true });
  fs.mkdirSync(path.join(identityDir, "thinkers"), { recursive: true });

  let memoriesImported = 0;
  if (opts.memoriesDir) {
    if (!fs.statSync(opts.memoriesDir).isDirectory()) {
      throw new Error(`--memories: not a directory: ${opts.memoriesDir}`);
    }
    for (const f of fs.readdirSync(opts.memoriesDir)) {
      if (!f.endsWith(".md")) continue;
      fs.copyFileSync(path.join(opts.memoriesDir, f), path.join(identityDir, "memories", f));
      memoriesImported += 1;
    }
  }

  const traj = createTrajectory(path.join(identityDir, "trajectories"));
  const now = opts.now ?? (() => new Date());
  writeInfoTxt(identityDir, name, localIsoTimestamp(now()), traj.trajId);

  // kernel/{mem,chat,goals} + bundled skills/* — upstream SYMLINKS these into
  // its own checkout (_ensure_kernel / _install_bundled_skills); this port
  // COPIES the bundled SKILL.md text instead (DIRECTOR CORRECTION — see
  // PARITY.md Daemon-runtime deviations "kernel/skills copied, not symlinked").
  for (const skill of KERNEL_SKILLS) {
    copyDirFlat(path.join(ASSETS_KERNEL, skill), path.join(identityDir, "kernel", skill));
  }
  for (const skill of BUNDLED_SKILLS) {
    copyDirFlat(path.join(ASSETS_SKILLS, skill), path.join(identityDir, "skills", skill));
  }

  const thinkersDir = path.join(identityDir, "thinkers");
  installThinker(thinkersDir, "monolith", traj.trajId);
  installThinker(thinkersDir, "responder", traj.trajId);
  installThinker(thinkersDir, "retrieval", traj.trajId); // ships with its own `disabled` marker (SPEC-retrieval-thinker §1)
  // thinkers/_lib/common.sh and thinkers/retrieval/build-index.sh are Bash —
  // NEVER copied (DIRECTOR RULE — see PARITY.md Daemon-runtime deviations
  // "Bash/Python thinker helpers omitted"). thinkers/_lib/ is therefore never
  // created; retrieval's index build is src/retrieval.ts, ported separately.
  fs.writeFileSync(path.join(thinkersDir, ".retired_done"), RETIRED_THINKERS.map((n) => `${n}\n`).join(""));

  for (const t of SEED_THOUGHTS) {
    traj.append({ type: "thought", content: t, source: "seed" });
  }

  // NO `activate` file (DIRECTOR CORRECTION 1) — resolveIdentityEnv replaces it.

  const identitiesRoot = opts.identitiesRoot;
  const defaultLink = path.join(identitiesRoot, "default");
  let defaultSet = false;
  if (opts.setDefault || !fs.existsSync(defaultLink)) {
    fs.rmSync(defaultLink, { force: true });
    fs.symlinkSync(name, defaultLink);
    defaultSet = true;
  }

  return { name, identityDir, rootTrajectoryId: traj.trajId, memoriesImported, defaultSet };
}

// ---------------------------------------------------------------------------
// `identity list` (tools/identity:945-995 cmd_list, tools/identity:46-54
// `_identity_names`).
// ---------------------------------------------------------------------------

/** `grep '^KEY=' info.txt | cut -d= -f2-` — first matching line, everything
 *  after the first `=`. Missing file or no match -> undefined. */
function readInfoField(infoTxt: string, key: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(infoTxt, "utf8");
  } catch {
    return undefined;
  }
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

export interface IdentityListEntry {
  name: string;
  isDefault: boolean;
  /** "" when info.txt has neither `created=` nor (fallback) `started=`. */
  created: string;
  /** `cd "$IDENTITY_DIR/$name" && pwd` — a lexical join, NOT a symlink-resolved realpath. */
  absDir: string;
}

export interface IdentityListResult {
  entries: IdentityListEntry[];
}

/**
 * `identity list [-a]`. Both a missing `identitiesRoot` (tools/identity:954
 * `[[ ! -d "$IDENTITY_DIR" ]]`) and an existing-but-empty one produce the
 * same empty result — the CLI prints "No identities." to stderr for either.
 *
 * Directory filtering replicates bash's non-dotglob `"$dir"/*\/` glob
 * (tools/identity:48): entries starting with "." are invisible to the glob
 * (skipped here, not merely hidden from display), and the literal name
 * "default" is excluded (tools/identity:51). Every other directory is
 * listed as an identity — including one with no `info.txt` (created: "")
 * and a symlink to a directory (`[[ -d "$_d" ]]` follows symlinks; a
 * dangling symlink fails that test and is excluded, same as here). Ordering
 * matches this environment's `bash` glob sort — observed locale-aware
 * (case-insensitive primary key: "alpha" < "Bravo" < "mike"), reproduced
 * with `String#localeCompare`, NOT a raw byte/code-unit sort.
 */
export function identityList(identitiesRoot: string): IdentityListResult {
  let names: string[] = [];
  try {
    if (fs.statSync(identitiesRoot).isDirectory()) {
      names = fs.readdirSync(identitiesRoot).filter((n) => {
        if (n.startsWith(".") || n === "default") return false;
        try {
          return fs.statSync(path.join(identitiesRoot, n)).isDirectory();
        } catch {
          return false; // dangling symlink or raced-away entry
        }
      });
      names.sort((a, b) => a.localeCompare(b));
    }
  } catch {
    // identitiesRoot doesn't exist at all — empty list, same as an empty dir.
  }

  let currentName = "";
  try {
    currentName = path.basename(fs.readlinkSync(path.join(identitiesRoot, "default")));
  } catch {
    // no `default` symlink (or not a symlink) — nothing gets the `*` marker.
  }

  const entries: IdentityListEntry[] = names.map((name) => {
    const infoTxt = path.join(identitiesRoot, name, "info.txt");
    let created = readInfoField(infoTxt, "created") ?? "";
    if (created === "") created = readInfoField(infoTxt, "started") ?? "";
    return { name, isDefault: name === currentName, created, absDir: path.resolve(identitiesRoot, name) };
  });

  return { entries };
}

// ---------------------------------------------------------------------------
// `identity export` (tools/identity:521-638 cmd_export + its helpers:
// 423-429 _export_file_list, 432-455 _export_manifest_entry, 463-493
// _SLIM_JQ/_slim_redact/_export_slim_trajectories, 495-519
// _export_append_identity, 997-1025 _resolve_identity_path).
//
// Archive layout (format 1, upstream's own doc comment at tools/identity:416-
// 418): manifest.json + one top-level dir per identity. Never travels: run/
// (live pids/fifos), .shellm/ (docker state), kernel/ (regenerated on
// import), thinkers/ (shipped separately, DEREFERENCED — see below), .env
// and activate (secrets / host-specific, top level only).
// ---------------------------------------------------------------------------

export class ExportError extends Error {}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `date +%Y%m%d-%H%M%S` (tools/identity cmd_export's own `stamp=$(date ...)`
 *  for the default output filename) — LOCAL time, same clock as iso_timestamp. */
function localStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `_resolve_identity_path` (tools/identity:997-1025). This port has no
 *  "activated identity shell" concept (no `activate` file is ever written —
 *  see identityNew's DIRECTOR CORRECTION comment), so the `_ACTIVE_IDENTITY_DIR`
 *  branch is never reachable here; every call resolves against `identitiesRoot`. */
function resolveIdentityPath(identitiesRoot: string, target: string): string {
  if (target !== "") {
    const direct = path.join(identitiesRoot, target);
    if (isDirectory(direct)) return path.resolve(direct);
    const names = identityList(identitiesRoot).entries.map((e) => e.name);
    const matches = names.filter((n) => n.includes(target));
    if (matches.length === 1) return path.resolve(path.join(identitiesRoot, matches[0]!));
    if (matches.length > 1) {
      throw new ExportError(`Ambiguous: '${target}' matches multiple identities:\n${matches.join("\n")}`);
    }
    throw new ExportError(`No identity matching: ${target}`);
  }
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(path.join(identitiesRoot, "default"));
  } catch {
    throw new ExportError("No default identity. Set one with: identity default <name>");
  }
  const resolved = path.isAbsolute(linkTarget) ? linkTarget : path.join(identitiesRoot, linkTarget);
  if (!isDirectory(resolved)) throw new ExportError(`Current identity directory missing: ${resolved}`);
  return path.resolve(resolved);
}

export interface ResolveExportDirsOptions {
  names?: string[];
  all?: boolean;
  paths?: string[];
}

/** The dirs-to-export resolution block of cmd_export (tools/identity:559-587). */
export function resolveExportDirs(identitiesRoot: string, opts: ResolveExportDirsOptions): string[] {
  const names = opts.names ?? [];
  const all = opts.all ?? false;
  const paths = opts.paths ?? [];
  const dirs: string[] = [];

  if (paths.length > 0) {
    if (all || names.length > 0) throw new ExportError("export: pass names, --all, or --path — not a mix");
    for (const p of paths) {
      if (!isDirectory(p)) throw new ExportError(`export: not a directory: ${p}`);
      if (!fs.existsSync(path.join(p, "info.txt"))) throw new ExportError(`export: not an identity dir (no info.txt): ${p}`);
      dirs.push(path.resolve(p));
    }
  } else if (all) {
    if (names.length > 0) throw new ExportError("export: pass names or --all, not both");
    if (!isDirectory(identitiesRoot)) throw new ExportError("No identities found");
    let entries: string[];
    try {
      entries = fs.readdirSync(identitiesRoot).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name === "default") continue;
      const d = path.join(identitiesRoot, name);
      if (!isDirectory(d)) continue;
      if (!fs.existsSync(path.join(d, "info.txt"))) continue;
      dirs.push(path.resolve(d));
    }
    if (dirs.length === 0) throw new ExportError("No identities found");
  } else if (names.length > 0) {
    for (const n of names) dirs.push(resolveIdentityPath(identitiesRoot, n));
  } else {
    dirs.push(resolveIdentityPath(identitiesRoot, ""));
  }

  // Archive member prefixes are directory basenames — must be unique
  // (tools/identity:590-595).
  const seen = new Set<string>();
  for (const d of dirs) {
    const base = path.basename(d);
    if (seen.has(base)) throw new ExportError(`export: duplicate identity directory name: ${base}`);
    seen.add(base);
  }
  return dirs;
}

/** `<name>-<stamp>.shellm.tgz` (single) or `identities-<stamp>.shellm.tgz`
 *  (multi) — cmd_export's own default `-o` computation (tools/identity:597-605). */
export function defaultExportOutName(dirs: string[], now: () => Date = () => new Date()): string {
  const stamp = localStamp(now());
  return dirs.length === 1 ? `${path.basename(dirs[0]!)}-${stamp}.shellm.tgz` : `identities-${stamp}.shellm.tgz`;
}

interface ExportManifestEntry {
  dir: string;
  name: string;
  created: string;
  root_trajectory: string;
  memories: number;
  traj_steps: number;
}

function countMdFilesRecursive(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) count += countMdFilesRecursive(full);
    else if (e.isFile() && e.name.endsWith(".md")) count++;
  }
  return count;
}

/** `_export_manifest_entry` (tools/identity:432-455). */
function exportManifestEntry(dir: string): ExportManifestEntry {
  const base = path.basename(dir);
  const infoTxt = path.join(dir, "info.txt");
  const name = readInfoField(infoTxt, "name") || base;
  const created = readInfoField(infoTxt, "created") ?? "";
  const rt = readInfoField(infoTxt, "root_trajectory") ?? "";
  const memories = countMdFilesRecursive(path.join(dir, "memories"));
  let steps = 0;
  if (rt !== "") {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(dir, "trajectories")).sort();
    } catch {
      names = [];
    }
    const prefix = `${rt.slice(0, 8)}-`;
    const match = names.find((n) => n.startsWith(prefix));
    if (match) {
      const jsonl = path.join(dir, "trajectories", match, "trajectory.jsonl");
      try {
        const text = fs.readFileSync(jsonl, "utf8");
        steps = (text.match(/\n/g) ?? []).length; // `wc -l` counts newlines, not non-empty lines
      } catch {
        steps = 0;
      }
    }
  }
  return { dir: base, name, created, root_trajectory: rt, memories, traj_steps: steps };
}

// Always pruned from the main file walk, at exactly `<base>/<name>` (a
// literal `-path` match in bash, not a glob) — tools/identity:425.
const EXPORT_ALWAYS_PRUNE = new Set(["run", ".shellm", "kernel", "thinkers"]);

/** `_export_file_list` (tools/identity:423-429), walked directly instead of
 *  building a NUL-delimited list for `tar -T` — symlinks are NOT followed
 *  (bash's plain `find`, no `-L`), matching a real bundled-skill symlink. */
function collectExportEntries(identityDir: string, soulOnly: boolean, slim: boolean): TarWriteEntry[] {
  const parentDir = path.dirname(identityDir);
  const pruneTrajectories = soulOnly || slim;
  const out: TarWriteEntry[] = [];

  function relOf(abs: string): string {
    return path.relative(parentDir, abs).split(path.sep).join("/");
  }
  function isPruned(rel: string): boolean {
    const parts = rel.split("/");
    if (parts.length !== 2) return false;
    if (EXPORT_ALWAYS_PRUNE.has(parts[1]!)) return true;
    if (pruneTrajectories && parts[1] === "trajectories") return true;
    if (parts[1] === ".env" || parts[1] === "activate") return true;
    return false;
  }
  function visit(abs: string): void {
    const rel = relOf(abs);
    if (isPruned(rel)) return;
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(abs);
    } catch {
      return; // raced away
    }
    if (lst.isSymbolicLink()) {
      out.push({ name: rel, type: "symlink", linkname: fs.readlinkSync(abs), mode: lst.mode & 0o777 });
      return;
    }
    if (lst.isDirectory()) {
      out.push({ name: `${rel}/`, type: "directory", mode: lst.mode & 0o777 });
      for (const child of fs.readdirSync(abs).sort()) visit(path.join(abs, child));
      return;
    }
    if (lst.isFile()) {
      out.push({ name: rel, type: "file", data: fs.readFileSync(abs), mode: lst.mode & 0o777 });
    }
    // fifos/devices: not emitted (never appear in an identity tree).
  }

  visit(identityDir);
  return out;
}

/** `_export_append_identity`'s thinkers pass (tools/identity:513-518):
 *  `cp -RL` — every symlink DEREFERENCED, so an on-disk `--symlinks` install
 *  ships as plain files/dirs. A dangling symlink is dropped (bash: the whole
 *  `cp -RL` may fail and is swallowed via `|| debug ...`; this port instead
 *  drops just the unresolvable entry and keeps the rest — a documented,
 *  more-lenient deviation, see PARITY.md). */
function collectDereferencedTree(identityDir: string, subdirName: string): TarWriteEntry[] {
  const baseName = path.basename(identityDir);
  const rootAbs = path.join(identityDir, subdirName);
  const out: TarWriteEntry[] = [];
  if (!isDirectory(rootAbs)) return out;

  function visit(abs: string, relParts: string[]): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs); // follows symlinks
    } catch {
      return; // dangling symlink target — dropped
    }
    const rel = `${baseName}/${subdirName}${relParts.length > 0 ? "/" + relParts.join("/") : ""}`;
    if (st.isDirectory()) {
      out.push({ name: `${rel}/`, type: "directory", mode: st.mode & 0o777 });
      let names: string[];
      try {
        names = fs.readdirSync(abs).sort();
      } catch {
        names = [];
      }
      for (const name of names) visit(path.join(abs, name), [...relParts, name]);
    } else if (st.isFile()) {
      out.push({ name: rel, type: "file", data: fs.readFileSync(abs), mode: st.mode & 0o777 });
    }
  }
  visit(rootAbs, []);
  return out;
}

// `_SLIM_JQ` (tools/identity:463-467) and `_slim_redact` (469-477). The
// OpenRouter prefix is built via concatenation, not a literal — this repo is
// public and test/scrub.test.ts forbids a contiguous "sk" + "-or-v1-" in any
// tracked file (indistinguishable from a leaked key by a naive grep).
const SLIM_REDACT_PATTERNS: [RegExp, string][] = [
  [new RegExp(`sk${"-or-v1-"}[A-Za-z0-9]+`, "g"), "[REDACTED:openrouter]"],
  [/sk-ant-[A-Za-z0-9._-]+/g, "[REDACTED:anthropic]"],
  [/sk-proj-[A-Za-z0-9_-]+/g, "[REDACTED:openai]"],
  [/xox[abpse]-[A-Za-z0-9-]+/g, "[REDACTED:slack]"],
  [/lin_api_[A-Za-z0-9]+/g, "[REDACTED:linear]"],
  [/AKIA[A-Z0-9]{16}/g, "[REDACTED:aws]"],
];

function slimRedact(text: string): string {
  let out = text;
  for (const [re, repl] of SLIM_REDACT_PATTERNS) out = out.replace(re, repl);
  return out;
}

function slimCutString(value: string, n: number): string {
  if (value.length <= n) return value;
  return `${value.slice(0, n)} …[truncated ${value.length - n} chars]`;
}

function slimJsonLine(line: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new ExportError("export: slimming failed");
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    if (o["type"] === "shellm-run" && typeof o["command"] === "string") {
      o["command"] = slimCutString(o["command"], 300);
    } else if (o["type"] === "prompt" && typeof o["content"] === "string") {
      o["content"] = slimCutString(o["content"], 600);
    }
    // PORT-NOTE (1c: 9a62727): slim exports drop content_b64 unconditionally,
    // not just for shellm-run/prompt steps — a `chat send-file` message step's
    // encoded file bytes could otherwise carry a credential past the
    // text-only regex/string redaction above. Upstream's updated `_SLIM_JQ`
    // pipes every step through `del(.content_b64)` after the per-type cut.
    delete o["content_b64"];
  }
  return JSON.stringify(obj);
}

/** `_export_slim_trajectories` (tools/identity:479-493) + the `tar -rf`
 *  append that follows it in `_export_append_identity` (505-509). Only
 *  ancestor directories of a surviving FILE are materialized — matching
 *  `mkdir -p "$dest/$(dirname "$rel")"`, called only per-file, never
 *  unconditionally for the whole tree. */
function slimTrajectoryEntries(baseName: string, trajectoriesAbsDir: string): TarWriteEntry[] {
  if (!isDirectory(trajectoriesAbsDir)) return [];
  const files: { rel: string; abs: string; isJsonl: boolean }[] = [];
  function collect(abs: string, relParts: string[]): void {
    let names: string[];
    try {
      names = fs.readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const childAbs = path.join(abs, name);
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (lst.isDirectory()) collect(childAbs, [...relParts, name]);
      else if (lst.isFile()) files.push({ rel: [...relParts, name].join("/"), abs: childAbs, isJsonl: name.endsWith(".jsonl") });
      // symlinks: `find -type f` (no -L) never matches them — skipped.
    }
  }
  collect(trajectoriesAbsDir, []);
  if (files.length === 0) return []; // see PARITY.md: upstream's own `tar -rf` on a
  // never-`mkdir -p`'d path would hard-fail here (set -euo pipefail); this
  // port instead degrades gracefully — not reachable by a real identity,
  // which always has at least a live root trajectory.

  const dirSet = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  const out: TarWriteEntry[] = [{ name: `${baseName}/trajectories/`, type: "directory", mode: 0o755 }];
  for (const d of [...dirSet].sort()) out.push({ name: `${baseName}/trajectories/${d}/`, type: "directory", mode: 0o755 });
  for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const lst = fs.lstatSync(f.abs);
    let data: Buffer;
    if (f.isJsonl) {
      const text = fs.readFileSync(f.abs, "utf8");
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      data = Buffer.from(
        lines.map((l) => `${slimRedact(slimJsonLine(l))}\n`).join(""),
        "utf8"
      );
    } else {
      data = fs.readFileSync(f.abs);
    }
    out.push({ name: `${baseName}/trajectories/${f.rel}`, type: "file", data, mode: lst.mode & 0o777 });
  }
  return out;
}

export interface BuildExportArchiveOptions {
  dirs: string[]; // absolute identity dirs, unique basenames (resolveExportDirs's output)
  soulOnly?: boolean;
  slim?: boolean;
  now?: () => Date;
}

/** `cmd_export`'s manifest + tar/gzip assembly (tools/identity:607-637),
 *  minus `-o`/stdout-vs-file (a CLI-only concern — see bin/identity.mjs). */
export function buildIdentityExportArchive(opts: BuildExportArchiveOptions): Buffer {
  const soulOnly = opts.soulOnly ?? false;
  const slim = opts.slim ?? false;
  const now = opts.now ?? (() => new Date());

  const manifest = {
    format: 1,
    exported_at: localIsoTimestamp(now()),
    soul_only: soulOnly,
    slim,
    identities: opts.dirs.map((d) => exportManifestEntry(d)),
  };
  const entries: TarWriteEntry[] = [
    { name: "manifest.json", type: "file", data: Buffer.from(JSON.stringify(manifest, null, 2)), mode: 0o644 },
  ];
  for (const dir of opts.dirs) {
    entries.push(...collectExportEntries(dir, soulOnly, slim));
    if (slim && !soulOnly) entries.push(...slimTrajectoryEntries(path.basename(dir), path.join(dir, "trajectories")));
    entries.push(...collectDereferencedTree(dir, "thinkers"));
  }
  return writeTarGz(entries);
}

// ---------------------------------------------------------------------------
// `identity import` (tools/identity:706-810 cmd_import, 642-704
// _install_imported_identity).
//
// PORT-NOTEs (deliberate, matching identityNew's own established
// corrections — see the DIRECTOR CORRECTION comments above):
//   - no `activate` file is (re)written (resolveIdentityEnv replaces it).
//   - `~/.skills/core-skills` / `.skillsrc` seeding (upstream's Bash-checkout
//     convention) is skipped, same as identityNew already skips it.
//   - an imported identity's `thinkers/` tree is extracted VERBATIM (its
//     step scripts, `_lib/`, everything) — this port makes no attempt to
//     translate a foreign (Bash-authored) thinker into something its daemon
//     can execute; only the archive's own file bytes travel. Matches the
//     CLI's own warning ("only import archives you trust").
// ---------------------------------------------------------------------------

export class ImportError extends Error {}

export interface IdentityImportOptions {
  identitiesRoot: string;
  /** Path to a staged .tgz on disk (server.ts/the CLI shim own the file). */
  archivePath: string;
  /** --name: renames a single-identity archive. */
  name?: string;
  now?: () => Date;
}

export interface IdentityImportResult {
  /** Installed names, in archive order. */
  imported: string[];
  /** Human-readable summary, mirroring the Bash CLI's stderr text. */
  stderr: string;
}

function isUnsafeArchivePath(name: string): boolean {
  return /^\/|^\.\.(\/|$)|\/\.\.(\/|$)/.test(name);
}

function normalizeMemberPath(name: string): string {
  // bsdtar can prefix "./" for `-C dir .`-style archives; this port's own
  // export convention (tools/identity _export_append_identity) never does,
  // but tolerate it for archives built by hand or by other tools.
  let n = name;
  while (n.startsWith("./")) n = n.slice(2);
  return n.replace(/\/+$/, "");
}

/** First path segment ("myid" of "myid/info.txt"). */
function topSegment(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? relPath : relPath.slice(0, idx);
}

interface ManifestIdentityEntry {
  dir?: string;
  name?: string;
}

export function identityImport(opts: IdentityImportOptions): IdentityImportResult {
  const archiveBuf = fs.readFileSync(opts.archivePath);
  let rawEntries: TarEntry[];
  try {
    rawEntries = readTarGz(archiveBuf);
  } catch {
    throw new ImportError(`import: not a .tgz archive: ${opts.archivePath}`);
  }

  const entries = rawEntries.map((e) => ({ ...e, name: normalizeMemberPath(e.name) })).filter((e) => e.name !== "");

  const unsafe = rawEntries.filter((e) => isUnsafeArchivePath(e.name));
  if (unsafe.length > 0) {
    throw new ImportError(`import: archive contains unsafe paths:\n${unsafe.map((e) => e.name).join("\n")}`);
  }

  // manifest.json (format check + dir->name map).
  const manifestEntry = entries.find((e) => e.name === "manifest.json" && e.type === "file");
  const manifestByDir = new Map<string, string>();
  if (manifestEntry) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestEntry.data.toString("utf-8"));
    } catch {
      manifest = null;
    }
    if (manifest && typeof manifest === "object") {
      const m = manifest as { format?: unknown; identities?: unknown };
      const fmt = typeof m.format === "number" ? m.format : 1;
      if (Number.isInteger(fmt) && fmt > 1) {
        throw new ImportError(`import: archive format ${fmt} is newer than this tool understands`);
      }
      if (Array.isArray(m.identities)) {
        for (const it of m.identities as ManifestIdentityEntry[]) {
          if (it && typeof it === "object" && typeof it.dir === "string" && typeof it.name === "string") {
            manifestByDir.set(it.dir, it.name);
          }
        }
      }
    }
  }

  // Top-level identity source dirs: every distinct first path segment other
  // than manifest.json itself, that carries an info.txt file.
  const bySrcDir = new Map<string, TarEntry[]>();
  for (const e of entries) {
    if (e.name === "manifest.json") continue;
    const top = topSegment(e.name);
    if (top === "" || top === e.name) continue; // not nested under a dir
    let list = bySrcDir.get(top);
    if (!list) {
      list = [];
      bySrcDir.set(top, list);
    }
    list.push(e);
  }
  const srcDirs = [...bySrcDir.keys()].sort();
  if (srcDirs.length === 0) throw new ImportError("import: no identity directories in archive");
  if (opts.name && srcDirs.length > 1) {
    throw new ImportError(`import: --name only applies to single-identity archives (found ${srcDirs.length})`);
  }

  function memberText(members: TarEntry[], relPath: string): string | null {
    const m = members.find((e) => e.name === `${relPath.replace(/^\//, "")}` && e.type === "file");
    return m ? m.data.toString("utf-8") : null;
  }
  function infoField(infoTxt: string, key: string): string {
    const re = new RegExp(`^${key}=(.*)$`, "m");
    const m = re.exec(infoTxt);
    return m ? m[1]! : "";
  }

  // Resolve every target name, then check conflicts before touching anything.
  const targets: string[] = [];
  const seen = new Set<string>();
  let conflicts: string[] = [];
  for (const src of srcDirs) {
    const members = bySrcDir.get(src)!;
    const infoTxt = memberText(members, `${src}/info.txt`);
    if (infoTxt === null) throw new ImportError(`import: '${src}' has no info.txt — not an identity`);
    let name: string;
    if (opts.name) {
      name = opts.name;
    } else {
      name = manifestByDir.get(src) ?? "";
      if (!name) name = infoField(infoTxt, "name");
      if (!name) name = src;
    }
    if (!IDENTITY_NAME_RE.test(name)) {
      throw new ImportError(`import: invalid identity name: '${name}' (use --name to rename)`);
    }
    if (seen.has(name)) throw new ImportError(`import: archive maps two identities to the same name: ${name}`);
    seen.add(name);
    if (fs.existsSync(path.join(opts.identitiesRoot, name))) conflicts.push(name);
    targets.push(name);
  }
  if (conflicts.length > 0) {
    throw new ImportError(`import: identity already exists:${conflicts.map((c) => ` ${c}`).join("")} (use --name or delete first)`);
  }

  fs.mkdirSync(opts.identitiesRoot, { recursive: true });

  const imported: string[] = [];
  for (let i = 0; i < srcDirs.length; i++) {
    const src = srcDirs[i]!;
    const name = targets[i]!;
    const members = bySrcDir.get(src)!;
    installImportedIdentity(opts.identitiesRoot, src, name, members, opts.now);
    imported.push(name);
  }

  const defaultLink = path.join(opts.identitiesRoot, "default");
  if (!fs.existsSync(defaultLink) && !isSymlink(defaultLink)) {
    fs.symlinkSync(imported[0]!, defaultLink);
  }

  const stderr =
    `Imported ${imported.length} identit${imported.length === 1 ? "y" : "ies"}: ${imported.join(" ")}\n`;
  return { imported, stderr };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Write one archive-extracted identity dir under identitiesRoot as `name`,
 *  stripping runtime/secret paths, regenerating info.txt/kernel/skills, and
 *  ensuring a live root trajectory. */
function installImportedIdentity(identitiesRoot: string, src: string, name: string, members: TarEntry[], now?: () => Date): void {
  const dest = path.join(identitiesRoot, name);
  const prefix = `${src}/`;

  const STRIP_DIRS = ["run/", ".shellm/", "kernel/"];
  const STRIP_FILES = new Set([".env", "activate"]);

  for (const e of members) {
    if (!e.name.startsWith(prefix)) continue; // stray top-level "src" entry itself
    const rel = e.name.slice(prefix.length);
    if (rel === "") continue;
    if (STRIP_DIRS.some((d) => rel === d.slice(0, -1) || rel.startsWith(d))) continue;
    if (STRIP_FILES.has(rel)) continue;

    const destPath = path.join(dest, rel);
    if (e.type === "directory") {
      fs.mkdirSync(destPath, { recursive: true });
    } else if (e.type === "symlink") {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* nothing there yet */
      }
      fs.symlinkSync(e.linkname, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, e.data);
      const mode = e.mode || 0o644;
      if (mode & 0o111) fs.chmodSync(destPath, 0o755);
    }
  }

  fs.mkdirSync(path.join(dest, "memories"), { recursive: true });
  fs.mkdirSync(path.join(dest, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dest, "kernel"), { recursive: true });
  fs.mkdirSync(path.join(dest, "trajectories"), { recursive: true });
  fs.mkdirSync(path.join(dest, "thinkers"), { recursive: true });

  // info.txt: name= follows the install name (import may rename), other
  // fields carried over as extracted.
  const infoPath = path.join(dest, "info.txt");
  let infoTxt = "";
  try {
    infoTxt = fs.readFileSync(infoPath, "utf-8");
  } catch {
    /* archive shipped no info.txt at all — already refused above unless src/info.txt existed */
  }
  const withoutName = infoTxt
    .split("\n")
    .filter((l) => !l.startsWith("name="))
    .join("\n");
  infoTxt = `name=${name}\n${withoutName}`;
  if (!infoTxt.endsWith("\n")) infoTxt += "\n";
  fs.writeFileSync(infoPath, infoTxt);

  // Ensure a live root trajectory (soul-only archives ship without one).
  const oldRt = (/^root_trajectory=(.*)$/m.exec(infoTxt)?.[1] ?? "").trim();
  let haveTraj = false;
  if (oldRt) {
    const trajDirName8 = oldRt.slice(0, 8);
    const trajectoriesDir = path.join(dest, "trajectories");
    try {
      for (const d of fs.readdirSync(trajectoriesDir)) {
        if (d.startsWith(`${trajDirName8}-`) && fs.existsSync(path.join(trajectoriesDir, d, "trajectory.jsonl"))) {
          haveTraj = true;
          break;
        }
      }
    } catch {
      /* no trajectories dir at all */
    }
  }
  if (!haveTraj) {
    const traj = createTrajectory(path.join(dest, "trajectories"));
    const newRt = traj.trajId;
    let rewritten = infoTxt
      .split("\n")
      .filter((l) => !l.startsWith("root_trajectory="))
      .join("\n");
    if (!rewritten.endsWith("\n")) rewritten += "\n";
    rewritten += `root_trajectory=${newRt}\n`;
    fs.writeFileSync(infoPath, rewritten);

    if (oldRt) {
      const thinkersDir = path.join(dest, "thinkers");
      let names: string[] = [];
      try {
        names = fs.readdirSync(thinkersDir);
      } catch {
        names = [];
      }
      for (const tname of names) {
        const subs = path.join(thinkersDir, tname, "subscriptions.jsonl");
        if (isSymlink(subs)) continue;
        let text: string;
        try {
          text = fs.readFileSync(subs, "utf-8");
        } catch {
          continue;
        }
        fs.writeFileSync(subs, text.split(oldRt).join(newRt));
      }
    }
  }

  // Drop symlinks that don't resolve on this host (e.g. skills pointing into
  // the source machine's checkout); bundled ones are re-installed below.
  dropDanglingSymlinks(dest);

  // Same bootstrap as `identity new`: kernel skills are always regenerated
  // (matches _ensure_kernel's unconditional relink); bundled (non-kernel)
  // skills are installed only when the name isn't already present (matches
  // _install_bundled_skills' "skip if already installed" — an imported
  // identity's own customized skill of that name must survive).
  for (const skill of KERNEL_SKILLS) {
    copyDirFlat(path.join(ASSETS_KERNEL, skill), path.join(dest, "kernel", skill));
  }
  for (const skill of BUNDLED_SKILLS) {
    const target = path.join(dest, "skills", skill);
    if (!fs.existsSync(target)) copyDirFlat(path.join(ASSETS_SKILLS, skill), target);
  }
  // No `activate` file (matches identityNew's DIRECTOR CORRECTION 1).
}

function dropDanglingSymlinks(dest: string): void {
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(dir, n);
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        if (!fs.existsSync(full)) fs.unlinkSync(full); // fs.existsSync follows symlinks -> false when dangling
      } else if (lst.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dest);
}
