// thinker-sync.ts — compare an identity's installed thinkers against the
// bundled copies and pull updates in. Port of
// headlong/web/src/headlong_web/thinker_sync.py (Apache-2.0).
//
// "Version" is the last git commit touching the bundled thinker's dir (short
// hash + date); identities don't track versions, so the identity side
// reports drift by file-content comparison: in_sync / outdated /
// not_installed, plus local_only for identity thinkers with no bundled
// counterpart.
//
// Per-identity state is never overwritten: subscriptions.jsonl (carries the
// injected traj_id) and the `disabled` marker survive a pull. A bundled
// `disabled` marker is inherited on first install only; removing it is an
// identity opt-in that later pulls preserve (PORT-NOTE 1c: 6c324d1). File
// writes are atomic (temp + rename).
//
// PORT-NOTE: upstream's bundled_root() defaults to "<repo checkout>/thinkers"
// (the Bash tools' source tree); this port's bundled thinker templates live
// at src/assets/thinkers instead (see src/identity.ts ASSETS_THINKERS) —
// same role, different path, so that is the default here. The
// HEADLONG_WEB_THINKERS_SRC override and the ~/.headlong-thinkers fallback
// are unchanged.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const DEFAULT_BUNDLED_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "assets", "thinkers");

// Names are path segments; allow the leading underscore of _lib but nothing
// resembling traversal.
export const SYNC_NAME_RE = /^[a-z0-9_][a-z0-9_-]*$/;

const PRESERVE = new Set(["subscriptions.jsonl", "disabled"]);
const EXECUTABLE = new Set(["step", "start", "stop"]);

export class NoBundledThinkers extends Error {}

function getenv(name: string): string | undefined {
  if (name in process.env) return process.env[name];
  const legacy = name.replace("HEADLONG_", "SHELLM_");
  if (legacy !== name && legacy in process.env) return process.env[legacy];
  return undefined;
}

/** Where pristine thinkers live: env override, this port's bundled assets,
 *  or the installed templates. */
export function bundledRoot(): string | null {
  const override = getenv("HEADLONG_WEB_THINKERS_SRC");
  const candidates = [
    ...(override ? [override] : []),
    DEFAULT_BUNDLED_ROOT,
    path.join(homedir(), ".headlong-thinkers"),
  ];
  for (const cand of candidates) {
    try {
      if (fs.statSync(cand).isDirectory()) return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}

function digest(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Bundled files a pull would copy (relative), per-identity state excluded. */
function syncFiles(bundledDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full, relPath);
      } else if (st.isFile()) {
        if (PRESERVE.has(name) || name.startsWith(".")) continue;
        out.push(relPath);
      }
    }
  };
  walk(bundledDir, "");
  return out.sort();
}

function changedFiles(bundledDir: string, installedDir: string): string[] {
  const changed: string[] = [];
  for (const rel of syncFiles(bundledDir)) {
    if (digest(path.join(bundledDir, rel)) !== digest(path.join(installedDir, rel))) changed.push(rel);
  }
  return changed;
}

interface VersionCache {
  ts: number;
  byname: Map<string, string | null>;
}
const versionCache: VersionCache = { ts: 0, byname: new Map() };
const VERSION_TTL_MS = 60_000;

/** Last git commit touching the bundled dir, as 'shorthash · date'. */
function bundledVersion(root: string, name: string): string | null {
  const now = Date.now();
  if (now - versionCache.ts > VERSION_TTL_MS) {
    versionCache.ts = now;
    versionCache.byname.clear();
  }
  if (versionCache.byname.has(name)) return versionCache.byname.get(name)!;
  let version: string | null = null;
  try {
    const out = execFileSync("git", ["-C", root, "log", "-1", "--format=%h · %cs", "--", name], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (out.trim()) version = out.trim();
  } catch {
    /* not a git checkout, git missing, or no history for this path */
  }
  versionCache.byname.set(name, version);
  return version;
}

export interface ThinkerSyncEntry {
  name: string;
  status: "in_sync" | "outdated" | "not_installed" | "local_only";
  changed_files: string[];
  bundled_version: string | null;
}

export interface ThinkerSyncStatus {
  bundled_root: string | null;
  thinkers: ThinkerSyncEntry[];
  note: string;
}

export function status(identityDir: string): ThinkerSyncStatus {
  const root = bundledRoot();
  const installedRoot = path.join(identityDir, "thinkers");
  const entries: ThinkerSyncEntry[] = [];
  const bundledNames = new Set<string>();

  if (root !== null) {
    for (const name of fs.readdirSync(root).sort()) {
      const bundledDir = path.join(root, name);
      if (!isDir(bundledDir)) continue;
      bundledNames.add(name);
      const installedDir = path.join(installedRoot, name);
      let changed: string[];
      let state: ThinkerSyncEntry["status"];
      if (!isDir(installedDir)) {
        state = "not_installed";
        changed = syncFiles(bundledDir);
      } else {
        changed = changedFiles(bundledDir, installedDir);
        state = changed.length > 0 ? "outdated" : "in_sync";
      }
      entries.push({ name, status: state, changed_files: changed, bundled_version: bundledVersion(root, name) });
    }
  }

  if (isDir(installedRoot)) {
    for (const name of fs.readdirSync(installedRoot).sort()) {
      const installedDir = path.join(installedRoot, name);
      if (isDir(installedDir) && !bundledNames.has(name)) {
        entries.push({ name, status: "local_only", changed_files: [], bundled_version: null });
      }
    }
  }

  return {
    bundled_root: root,
    thinkers: entries,
    note: "Pull replaces code files only; subscriptions.jsonl and the disabled marker stay. Restart thinkers to pick up new code.",
  };
}

export function atomicCopy(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = fs.readFileSync(src);
  // PORT-NOTE (f1a6e96): a unique temp name per copy, like tempfile.mkstemp, so
  // two concurrent syncs never share `.<name>.sync-tmp`; the temp file is always
  // removed, including when the rename fails, and gets an explicit mode.
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.sync-tmp-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    let executable = EXECUTABLE.has(path.basename(dest));
    if (!executable) {
      try {
        fs.accessSync(src, fs.constants.X_OK);
        executable = true;
      } catch {
        /* not executable */
      }
    }
    fs.chmodSync(tmp, executable ? 0o755 : 0o644);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Fresh install only: copy subscriptions.jsonl and inject the identity's
 *  root traj_id, mirroring tools/identity's _ensure_thinkers. */
function installSubscriptions(bundledDir: string, installedDir: string, identityDir: string): void {
  const src = path.join(bundledDir, "subscriptions.jsonl");
  const dest = path.join(installedDir, "subscriptions.jsonl");
  if (fs.existsSync(dest) || !isFile(src)) return;
  let rootTraj: string | null = null;
  try {
    for (const line of fs.readFileSync(path.join(identityDir, "info.txt"), "utf-8").split("\n")) {
      if (line.startsWith("root_trajectory=")) rootTraj = line.slice("root_trajectory=".length).trim();
    }
  } catch {
    /* no info.txt */
  }
  const lines: string[] = [];
  for (const line of fs.readFileSync(src, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const sub = JSON.parse(line) as Record<string, unknown>;
      if (rootTraj && !("traj_id" in sub)) sub["traj_id"] = rootTraj;
      lines.push(JSON.stringify(sub));
    } catch {
      lines.push(line);
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, lines.map((l) => `${l}\n`).join(""));
}

export interface SyncResultEntry {
  name: string;
  action: "installed" | "updated" | "unchanged" | "skipped";
  files: string[];
}

export function sync(identityDir: string, names: string[]): { ok: true; results: SyncResultEntry[] } {
  const root = bundledRoot();
  if (root === null) throw new NoBundledThinkers("No bundled thinkers directory found");
  const current = status(identityDir);
  const byName = new Map(current.thinkers.map((t) => [t.name, t]));
  let names_ = names;
  if (names_.length === 0) {
    names_ = current.thinkers.filter((t) => t.status === "outdated" || t.status === "not_installed").map((t) => t.name);
  }

  const results: SyncResultEntry[] = [];
  for (const name of names_) {
    const entry = byName.get(name);
    if (entry === undefined || entry.status === "local_only") {
      results.push({ name, action: "skipped", files: [] });
      continue;
    }
    const bundledDir = path.join(root, name);
    const installedDir = path.join(identityDir, "thinkers", name);
    const fresh = entry.status === "not_installed";
    const copied: string[] = [];
    for (const rel of syncFiles(bundledDir)) {
      const dest = path.join(installedDir, rel);
      if (digest(path.join(bundledDir, rel)) !== digest(dest)) {
        atomicCopy(path.join(bundledDir, rel), dest);
        copied.push(rel);
      }
    }
    if (fresh) {
      installSubscriptions(bundledDir, installedDir, identityDir);
      // PORT-NOTE (1c: 6c324d1): a bundled `disabled` marker is inherited
      // ONLY on first install (this `fresh` branch, status was
      // "not_installed"). A later pull for an already-installed thinker
      // never touches `disabled` — syncFiles()/PRESERVE already exclude it
      // from the code-file copy loop above — so an operator who deleted the
      // marker to enable a thinker keeps it enabled across every subsequent
      // pull; the bundled default is not silently restored.
      const disabledDefault = path.join(bundledDir, "disabled");
      if (isFile(disabledDefault)) {
        atomicCopy(disabledDefault, path.join(installedDir, "disabled"));
      }
    }
    results.push({ name, action: fresh ? "installed" : copied.length > 0 ? "updated" : "unchanged", files: copied });
  }
  return { ok: true, results };
}
