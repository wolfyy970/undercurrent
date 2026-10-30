// telegram-state.test.ts — no upstream Python test file exists for
// headlong_telegram.state (a two-method Offset class with no test_state.py
// upstream); exercised here directly against the documented behavior.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Offset } from "../src/telegram/state.ts";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-")), "update_offset");
}

describe("telegram state Offset", () => {
  it("starts at 0 when no file exists", () => {
    expect(new Offset(tmpFile()).value).toBe(0);
  });

  it("advance persists and only moves forward", () => {
    const p = tmpFile();
    const off = new Offset(p);
    off.advance(5);
    expect(off.value).toBe(5);
    expect(fs.readFileSync(p, "utf8")).toBe("5");
    off.advance(3); // backwards -> ignored
    expect(off.value).toBe(5);
    off.advance(10);
    expect(off.value).toBe(10);
  });

  it("reloads a persisted value", () => {
    const p = tmpFile();
    new Offset(p).advance(42);
    expect(new Offset(p).value).toBe(42);
  });

  it("an unparsable file falls back to 0", () => {
    const p = tmpFile();
    fs.writeFileSync(p, "not-a-number");
    expect(new Offset(p).value).toBe(0);
  });
});
