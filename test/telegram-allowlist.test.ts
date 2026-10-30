// telegram-allowlist.test.ts — port of headlong/telegram/tests/test_allowlist.py.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Allowlist } from "../src/telegram/allowlist.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-allowlist-"));
}

describe("telegram allowlist", () => {
  it("approve/revoke round trip", () => {
    const al = new Allowlist(path.join(tmpDir(), "allowlist.json"));
    expect(al.isApproved(7)).toBe(false);
    al.approve(7, "Dana");
    expect(al.isApproved(7)).toBe(true);
    expect(al.revoke(7)).toBe(true);
    expect(al.isApproved(7)).toBe(false);
    expect(al.revoke(7)).toBe(false);
  });

  it("persistence", () => {
    const p = path.join(tmpDir(), "allowlist.json");
    new Allowlist(p).approve(7, "Dana");
    expect(new Allowlist(p).isApproved(7)).toBe(true);
  });

  it("pending notifies once per interval", () => {
    const al = new Allowlist(path.join(tmpDir(), "allowlist.json"));
    expect(al.notePending(9, "Stranger")).toBe(true);
    expect(al.notePending(9, "Stranger")).toBe(false); // rate limited
  });

  it("denied never renotifies", () => {
    const al = new Allowlist(path.join(tmpDir(), "allowlist.json"));
    al.notePending(9, "Stranger");
    al.deny(9);
    expect(al.notePending(9, "Stranger")).toBe(false);
    expect(al.isApproved(9)).toBe(false);
  });

  it("approve clears pending and denied", () => {
    const al = new Allowlist(path.join(tmpDir(), "allowlist.json"));
    al.notePending(9, "Dana Kim");
    al.deny(9);
    al.approve(9);
    expect(al.isApproved(9)).toBe(true);
  });

  it("approve keeps pending label", () => {
    const al = new Allowlist(path.join(tmpDir(), "allowlist.json"));
    al.notePending(9, "Dana Kim");
    al.approve(9);
    expect(al.summary().includes("Dana Kim")).toBe(true);
  });

  it("corrupt file starts empty", () => {
    const p = path.join(tmpDir(), "allowlist.json");
    fs.writeFileSync(p, "not json{");
    const al = new Allowlist(p);
    expect(al.isApproved(1)).toBe(false);
    al.approve(1);
    expect(new Allowlist(p).isApproved(1)).toBe(true);
  });
});
