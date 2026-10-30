// Read an identity's file-backed memories for the Memories view.
// Port of headlong/web/src/headlong_web/memories.py (Apache-2.0).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

export interface MemoryInfo {
  name: string;
  mtime: number;
  id: string | null;
  summary: string | null;
  type: string;
  created: string | null;
  slug: string;
}

const DATED_NAME_RE =
  /^(?<stamp>\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})(?:_(?<id>[0-9a-f]{8}))?_(?<slug>.+)$/;

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || !line.includes(":")) continue;
    const ci = line.indexOf(":");
    const key = line.slice(0, ci).trim();
    let value = line.slice(ci + 1).trim();
    if (!key || !value) continue;
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function filenameFields(path: string): [string | null, string, string | null] {
  const base = basename(path, extname(path));
  const m = DATED_NAME_RE.exec(base);
  if (!m || !m.groups) return [null, base, null];
  const stamp = m.groups["stamp"];
  let created: string | null = null;
  // stamp is YYYY-MM-DD-HH-MM-SS -> "YYYY-MM-DD HH:MM:SS"
  const sm = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
  if (sm) created = `${sm[1]}-${sm[2]}-${sm[3]} ${sm[4]}:${sm[5]}:${sm[6]}`;
  return [m.groups["id"] ?? null, m.groups["slug"], created];
}

function validIso(value: string): boolean {
  return !Number.isNaN(Date.parse(value.replace("Z", "+00:00")));
}

function memoryInfo(path: string): MemoryInfo {
  const st = statSync(path);
  let fields: Record<string, string> = {};
  try {
    fields = frontmatter(readFileSync(path, "utf-8"));
  } catch {
    fields = {};
  }
  const [filenameId, slug, filenameCreated] = filenameFields(path);
  let created: string | null = fields["created"] ?? null;
  if (created && !validIso(created)) created = null;
  return {
    name: basename(path),
    mtime: st.mtimeMs / 1000,
    id: fields["id"] || filenameId,
    summary: fields["summary"] || null,
    type: fields["type"] || "memory",
    created: created || filenameCreated,
    slug,
  };
}

function sortKey(info: MemoryInfo): number {
  if (info.created) {
    const ms = Date.parse(info.created.replace("Z", "+00:00"));
    if (!Number.isNaN(ms)) return ms / 1000;
  }
  return info.mtime;
}

export function listMemories(identityDir: string): MemoryInfo[] {
  const memDir = join(identityDir, "memories");
  let names: string[];
  try {
    names = readdirSync(memDir);
  } catch {
    return [];
  }
  const result: MemoryInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      result.push(memoryInfo(join(memDir, name)));
    } catch {
      /* file may vanish mid-update */
    }
  }
  result.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return kb - ka;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; // reverse by name
  });
  return result;
}

export function readMemory(identityDir: string, name: string): string | null {
  // name is validated by the router; contain to the memories dir.
  if (name.includes("/") || name.includes("..") || name.includes("\0")) return null;
  const path = join(identityDir, "memories", name);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
