// identity-list.test.ts — `identity list [-a]` (tools/identity:945-995
// cmd_list, tools/identity:46-54 `_identity_names`). Behavior pinned by a
// real-Bash characterization run first — see parity/identity/run-parity.mjs
// and parity/identity/report.md for the differential proof this unit suite
// mirrors.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { identityList } from "../src/identity.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idlist-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeInfo(dir: string, fields: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  fs.writeFileSync(path.join(dir, "info.txt"), body);
}

describe("identity list", () => {
  it("0 identities: existing empty dir -> empty entries", () => {
    const root = tmpRoot();
    expect(identityList(root).entries).toEqual([]);
  });

  it("0 identities: missing dir -> empty entries (same outcome as empty dir)", () => {
    const root = tmpRoot();
    const missing = path.join(root, "nope");
    expect(identityList(missing).entries).toEqual([]);
  });

  it("0 identities: only a dangling `default` symlink -> still empty (default excluded by name)", () => {
    const root = tmpRoot();
    fs.symlinkSync("ghost", path.join(root, "default"));
    expect(identityList(root).entries).toEqual([]);
  });

  it("1 identity: created field, no default set -> isDefault false", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-02T03:04:05", root_trajectory: "abcd" });
    const { entries } = identityList(root);
    expect(entries).toEqual([
      { name: "alice", isDefault: false, created: "2026-01-02T03:04:05", absDir: path.resolve(root, "alice") },
    ]);
  });

  it("1 identity, default symlink set -> isDefault true", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-02T03:04:05" });
    fs.symlinkSync("alice", path.join(root, "default"));
    const { entries } = identityList(root);
    expect(entries[0]!.isDefault).toBe(true);
  });

  it("3 identities with different dates, one default, alphabetical (localeCompare) order", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-02T03:04:05" });
    writeInfo(path.join(root, "bob"), { name: "bob", created: "2025-12-31T23:59:59" });
    // carol's info.txt has no `created=` — falls back to `started=`.
    writeInfo(path.join(root, "carol"), { name: "carol", started: "2024-06-01T00:00:00" });
    fs.symlinkSync("bob", path.join(root, "default"));

    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alice", "bob", "carol"]);
    expect(entries.map((e) => e.isDefault)).toEqual([false, true, false]);
    expect(entries.map((e) => e.created)).toEqual(["2026-01-02T03:04:05", "2025-12-31T23:59:59", "2024-06-01T00:00:00"]);
  });

  it("localeCompare ordering matches observed bash glob sort (case-insensitive primary key)", () => {
    const root = tmpRoot();
    for (const n of ["zeta", "mike", "alpha", "Bravo"]) {
      writeInfo(path.join(root, n), { name: n, created: "2026-01-01T00:00:00" });
    }
    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alpha", "Bravo", "mike", "zeta"]);
  });

  it("a stray non-identity directory (no info.txt) is still listed, with created \"\"", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-01T00:00:00" });
    fs.mkdirSync(path.join(root, "strayvisible"));
    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alice", "strayvisible"]);
    expect(entries.find((e) => e.name === "strayvisible")!.created).toBe("");
  });

  it("hidden (dot-prefixed) directories are invisible, matching bash's non-dotglob", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-01T00:00:00" });
    fs.mkdirSync(path.join(root, ".stray_hidden"));
    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alice"]);
  });

  it("a plain file (not a directory) inside identitiesRoot is excluded", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-01T00:00:00" });
    fs.writeFileSync(path.join(root, "plainfile.txt"), "x");
    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alice"]);
  });

  it("a symlink to a directory is included, and absDir is the lexical join, not the resolved target", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "other", "target"), { recursive: true });
    fs.symlinkSync(path.join(root, "other", "target"), path.join(root, "linkdir"));
    const { entries } = identityList(root);
    const link = entries.find((e) => e.name === "linkdir")!;
    expect(link).toBeDefined();
    expect(link.absDir).toBe(path.resolve(root, "linkdir"));
    expect(link.absDir).not.toContain("target");
  });

  it("a dangling symlink entry is excluded (fails the directory test)", () => {
    const root = tmpRoot();
    writeInfo(path.join(root, "alice"), { name: "alice", created: "2026-01-01T00:00:00" });
    fs.symlinkSync("nonexistent", path.join(root, "brokenlink"));
    const { entries } = identityList(root);
    expect(entries.map((e) => e.name)).toEqual(["alice"]);
  });

  it("a name >= 20 chars is included whole (no truncation) — padding is a CLI-format concern", () => {
    const root = tmpRoot();
    const longName = "this-is-a-very-long-identity-name";
    writeInfo(path.join(root, longName), { name: longName, created: "2026-03-03T03:03:03" });
    const { entries } = identityList(root);
    expect(entries[0]!.name).toBe(longName);
  });
});
