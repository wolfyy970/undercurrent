// Discover Headlong identity directories under a serve root.
// Port of headlong/web/src/headlong_web/discovery.py (Apache-2.0).
//
// An identity dir is any directory containing an info.txt with a
// `root_trajectory=` line (e.g. .identities/<name>/).

import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";

const MAX_DEPTH = 6;
// Directory names that ARE the identities root (2d0919e). A symlink with one of
// these names directly under the serve root is followed one level (the box keeps
// its identities outside the checkout and links them back here, layer 0 of
// design/runtime_isolation.md); every other symlink is still a candidate
// identity at most, never a path the walk recurses through.
const IDENTITIES_ROOT_NAMES = new Set([".identities", "identities"]);
const PRUNE_DIRS = new Set([
  "trajectories",
  "workdir",
  "workdirs",
  "blobs",
  "run",
  "node_modules",
  ".git",
  ".shellm",
  ".headlong",
  "memories",
  "skills",
  "kernel",
  "thinkers",
  "static",
  "build",
]);

export interface IdentityInfo {
  id: string; // root-relative path with "/" -> "~"
  name: string;
  path: string; // absolute identity dir
  path_rel: string;
  created: string | null;
  root_trajectory: string | null;
  group: string;
}

function parseInfoTxt(path: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return fields;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return fields;
}

export function identityIdFor(rel: string): string {
  return rel.replaceAll("/", "~");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function scanIdentities(root: string): IdentityInfo[] {
  const found: IdentityInfo[] = [];
  const linkCandidates: string[] = [];

  const addIdentity = (directory: string, fields: Record<string, string>) => {
    let rel = relative(root, directory).split("\\").join("/");
    if (rel === "") rel = ".";
    const group = rel !== "." ? dirname(rel) : ".";
    found.push({
      id: identityIdFor(rel),
      name: fields["name"] ?? basename(directory),
      path: directory,
      path_rel: rel,
      created: fields["created"] ?? null,
      root_trajectory: fields["root_trajectory"] ?? null,
      group,
    });
  };

  const walk = (directory: string, depth: number) => {
    const infoTxt = join(directory, "info.txt");
    if (isFile(infoTxt)) {
      const fields = parseInfoTxt(infoTxt);
      if ("root_trajectory" in fields) {
        addIdentity(directory, fields);
        return; // identity dirs don't nest
      }
    }
    if (depth >= MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(directory, name);
      let linkStat;
      try {
        linkStat = lstatSync(child);
      } catch {
        continue;
      }
      if (linkStat.isSymbolicLink()) {
        if (!isDir(child) || PRUNE_DIRS.has(name)) continue;
        if (depth === 0 && IDENTITIES_ROOT_NAMES.has(name) && !isFile(join(child, "info.txt"))) {
          // The identities root itself, linked out of the checkout. Walk it by
          // its link path so ids and paths keep the familiar `.identities/<name>`
          // shape; children that are links are still only candidates.
          walk(child, depth + 1);
        } else {
          linkCandidates.push(child);
        }
        continue;
      }
      if (!linkStat.isDirectory() || PRUNE_DIRS.has(name)) continue;
      walk(child, depth + 1);
    }
  };

  walk(root, 0);

  const seen = new Set<string>();
  for (const identity of found) {
    try {
      seen.add(realpathSync(identity.path));
    } catch {
      /* ignore */
    }
  }
  for (const link of linkCandidates.sort()) {
    let target: string;
    try {
      target = realpathSync(link);
    } catch {
      continue;
    }
    if (seen.has(target)) continue;
    const fields = parseInfoTxt(join(link, "info.txt"));
    if (!("root_trajectory" in fields)) continue;
    seen.add(target);
    addIdentity(link, fields);
  }
  return found;
}

export function resolveIdentity(root: string, identityId: string): IdentityInfo {
  const identities = scanIdentities(root);
  for (const identity of identities) {
    if (identity.id === identityId) return identity;
  }
  const rel = identityId.replaceAll("~", "/");
  if (!rel.split("/").includes("..")) {
    const candidate = join(root, rel);
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        const target = realpathSync(candidate);
        for (const identity of identities) {
          try {
            if (realpathSync(identity.path) === target) return identity;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  throw new IdentityNotFound(identityId);
}

export class IdentityNotFound extends Error {}

/** Locate the mind log's trajectory dir for an identity. */
export function findRootTrajDir(identity: IdentityInfo): string | null {
  const trajRoot = join(identity.path, "trajectories");
  if (!isDir(trajRoot)) return null;
  const rootId = identity.root_trajectory ?? "";
  let entries: string[] = [];
  try {
    entries = readdirSync(trajRoot).sort();
  } catch {
    return null;
  }
  if (rootId) {
    const prefix = rootId.slice(0, 8) + "-";
    for (const name of entries) {
      if (name.startsWith(prefix) && isFile(join(trajRoot, name, "trajectory.jsonl"))) {
        return join(trajRoot, name);
      }
    }
  }
  for (const name of entries) {
    if (isFile(join(trajRoot, name, "trajectory.jsonl"))) return join(trajRoot, name);
  }
  return null;
}
