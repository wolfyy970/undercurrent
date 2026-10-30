// state.ts — the persisted getUpdates offset.
// Faithful port of headlong_telegram.state.Offset (Python).

import * as fs from "node:fs";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Strict integer parse: rejects anything `int(str)` in Python would reject
 *  (trailing garbage, empty string, non-digit content) — unlike
 *  `Number.parseInt`, which stops at the first non-digit and still "succeeds". */
function strictParseInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export class Offset {
  private readonly path: string;
  value = 0;

  constructor(path: string) {
    this.path = path;
    if (isFile(path)) {
      const text = fs.readFileSync(path, "utf8").trim();
      const parsed = strictParseInt(text);
      if (parsed !== null) this.value = parsed;
      // else: leave value at 0, matching Python's `except ValueError: pass`.
    }
  }

  advance(value: number): void {
    if (value > this.value) {
      this.value = value;
      fs.writeFileSync(this.path, String(value));
    }
  }
}
