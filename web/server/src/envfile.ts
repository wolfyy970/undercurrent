// envfile.ts — read and edit .env files (identity config), redacting secret
// values. Port of headlong/web/src/headlong_web/envfile.py (Apache-2.0).
//
// Full secret values never leave the server: the API returns a short peek
// (prefix…suffix) so keys are recognizable but not recoverable.

import * as fs from "node:fs";

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
// Values of these shapes can be written unquoted; anything else is
// single-quoted so `set -a; . .env` parses it as one word.
export const _BARE_VALUE_RE = /^[A-Za-z0-9_.:/@+=,-]*$/;

export const _LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  raw = raw.trim();
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** KEY/value pairs in file order; later duplicates win (like sourcing). */
export function parseEnvFile(path: string): [string, string][] {
  const entries = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = _LINE_RE.exec(line);
    if (m) entries.set(m[1]!, unquote(m[2]!));
  }
  return [...entries.entries()];
}

export function isSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export interface RedactedEntry {
  key: string;
  value: string;
  secret: boolean;
}

/** Wire form of one entry; secrets get a peek, never the full value. */
export function redactedEntry(key: string, value: string): RedactedEntry {
  if (!isSecret(key)) return { key, value, secret: false };
  let peek: string;
  if (value.length > 12) {
    peek = `${value.slice(0, 6)}…${value.slice(-4)}`;
  } else if (value) {
    peek = "••••••";
  } else {
    peek = "";
  }
  return { key, value: peek, secret: true };
}

export function _quoteValue(value: string): string {
  if (_BARE_VALUE_RE.test(value)) return value;
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Splits a file's raw text into lines the way Python's str.splitlines()
 * does (no trailing empty element for a final newline, but a lone trailing
 * "\r" or other line-break char still ends a line). Good enough here: env
 * files are plain LF/CRLF text. */
function splitlines(text: string): string[] {
  if (text === "") return [];
  const withoutTrailingNl = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNl.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Replace every assignment of key (preserving comments and other lines), or
 * append one. Creates the file if missing. */
export function upsertEnvVar(path: string, key: string, value: string): void {
  const newLine = `${key}=${_quoteValue(value)}`;
  let lines: string[];
  try {
    lines = splitlines(fs.readFileSync(path, "utf-8"));
  } catch {
    lines = [];
  }
  let replaced = false;
  const result: string[] = [];
  for (const line of lines) {
    const m = _LINE_RE.exec(line);
    if (m && m[1] === key && !line.trimStart().startsWith("#")) {
      if (!replaced) {
        result.push(newLine);
        replaced = true;
      }
      // drop duplicate assignments of the same key
      continue;
    }
    result.push(line);
  }
  if (!replaced) result.push(newLine);
  fs.writeFileSync(path, result.map((l) => `${l}\n`).join(""), "utf-8");
}

/** Remove every assignment of key. Returns true if anything was removed. */
export function deleteEnvVar(path: string, key: string): boolean {
  let lines: string[];
  try {
    lines = splitlines(fs.readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
  const result: string[] = [];
  let removed = false;
  for (const line of lines) {
    const m = _LINE_RE.exec(line);
    if (m && m[1] === key && !line.trimStart().startsWith("#")) {
      removed = true;
      continue;
    }
    result.push(line);
  }
  if (removed) fs.writeFileSync(path, result.map((l) => `${l}\n`).join(""), "utf-8");
  return removed;
}
