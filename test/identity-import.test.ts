// identity-import.test.ts — `identity import` (tools/identity:706-810
// cmd_import + 642-704 _install_imported_identity), unit-level: synthetic
// archives built with src/tar.ts's writer (round-trip verified against real
// macOS bsdtar output — see src/tar.ts's own header comment). The
// differential harness against the REAL Bash tool's own export/import lives
// at parity/identity/run-import-parity.mjs.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { identityImport, identityNew, ImportError, IDENTITY_NAME_RE } from "../src/identity.ts";
import { writeTarGz, type TarWriteEntry } from "../src/tar.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idimport-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function tmpArchive(entries: TarWriteEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idimport-arc-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "archive.shellm.tgz");
  fs.writeFileSync(p, writeTarGz(entries));
  return p;
}

/** Build a minimal, valid single-identity archive: info.txt + one root
 *  trajectory (so live-root repair is NOT triggered unless a test wants it). */
function basicIdentityEntries(dir: string, opts: { name?: string; rootTraj?: string; extra?: TarWriteEntry[] } = {}): TarWriteEntry[] {
  const rootTraj = opts.rootTraj ?? "11112222-3333-4444-5555-666677778888";
  const infoLines = [`name=${opts.name ?? dir}`, "created=2026-01-01T00:00:00", `root_trajectory=${rootTraj}`];
  const entries: TarWriteEntry[] = [
    { name: `${dir}/`, type: "directory" },
    { name: `${dir}/info.txt`, type: "file", data: Buffer.from(infoLines.join("\n") + "\n") },
  ];
  if (opts.rootTraj !== "") {
    entries.push(
      { name: `${dir}/trajectories/`, type: "directory" },
      { name: `${dir}/trajectories/${rootTraj.slice(0, 8)}-root/`, type: "directory" },
      {
        name: `${dir}/trajectories/${rootTraj.slice(0, 8)}-root/trajectory.jsonl`,
        type: "file",
        data: Buffer.from(`{"type":"trajectory","traj_id":"${rootTraj}"}\n`),
      }
    );
  }
  entries.push(...(opts.extra ?? []));
  return entries;
}

describe("identity import — basic single-identity archive", () => {
  it("installs under the source dir's basename by default, sets default symlink", () => {
    const root = tmpRoot();
    const archive = tmpArchive(basicIdentityEntries("alice"));
    const result = identityImport({ identitiesRoot: root, archivePath: archive });
    expect(result.imported).toEqual(["alice"]);
    expect(result.stderr).toBe("Imported 1 identity: alice\n");
    expect(fs.statSync(path.join(root, "alice")).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(root, "default"))).toBe("alice");
    const info = fs.readFileSync(path.join(root, "alice", "info.txt"), "utf-8");
    expect(info).toContain("name=alice\n");
    expect(info).toContain("root_trajectory=11112222-3333-4444-5555-666677778888\n");
  });

  it("--name renames a single-identity archive", () => {
    const root = tmpRoot();
    const archive = tmpArchive(basicIdentityEntries("alice"));
    const result = identityImport({ identitiesRoot: root, archivePath: archive, name: "bob" });
    expect(result.imported).toEqual(["bob"]);
    expect(fs.existsSync(path.join(root, "alice"))).toBe(false);
    expect(fs.statSync(path.join(root, "bob")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "bob", "info.txt"), "utf-8")).toContain("name=bob\n");
  });

  it("manifest.json's dir->name mapping wins over info.txt's own name= when no --name given", () => {
    const root = tmpRoot();
    const manifest = JSON.stringify({ format: 1, identities: [{ dir: "alice", name: "renamed-by-manifest" }] });
    const entries = [
      { name: "manifest.json", type: "file" as const, data: Buffer.from(manifest) },
      ...basicIdentityEntries("alice", { name: "alice" }),
    ];
    const archive = tmpArchive(entries);
    const result = identityImport({ identitiesRoot: root, archivePath: archive });
    expect(result.imported).toEqual(["renamed-by-manifest"]);
  });

  it("creates memories/skills/kernel/trajectories/thinkers even for a bare-bones archive, and regenerates kernel + missing bundled skills", () => {
    const root = tmpRoot();
    const archive = tmpArchive(basicIdentityEntries("alice"));
    identityImport({ identitiesRoot: root, archivePath: archive });
    const dest = path.join(root, "alice");
    for (const d of ["memories", "skills", "kernel", "trajectories", "thinkers"]) {
      expect(fs.statSync(path.join(dest, d)).isDirectory()).toBe(true);
    }
    for (const skill of ["mem", "chat"]) {
      expect(fs.statSync(path.join(dest, "kernel", skill, "SKILL.md")).isFile()).toBe(true);
    }
    expect(fs.statSync(path.join(dest, "skills", "shellm", "SKILL.md")).isFile()).toBe(true);
  });
});

describe("identity import — multi-identity archives", () => {
  it("imports every top-level identity dir, in sorted order", () => {
    const root = tmpRoot();
    const entries = [...basicIdentityEntries("alice", { rootTraj: "aaaa1111-0000-0000-0000-000000000000" }), ...basicIdentityEntries("bob", { rootTraj: "bbbb2222-0000-0000-0000-000000000000" })];
    const archive = tmpArchive(entries);
    const result = identityImport({ identitiesRoot: root, archivePath: archive });
    expect(result.imported.sort()).toEqual(["alice", "bob"]);
    expect(result.stderr).toBe("Imported 2 identities: alice bob\n");
  });

  it("--name on a multi-identity archive is refused", () => {
    const root = tmpRoot();
    const entries = [...basicIdentityEntries("alice"), ...basicIdentityEntries("bob")];
    const archive = tmpArchive(entries);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive, name: "carol" })).toThrow(
      /--name only applies to single-identity archives \(found 2\)/
    );
  });

  it("two identities resolving to the same target name -> refused, nothing written", () => {
    const root = tmpRoot();
    const entries = [...basicIdentityEntries("alice", { name: "same" }), ...basicIdentityEntries("bob", { name: "same" })];
    const archive = tmpArchive(entries);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/archive maps two identities to the same name: same/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("identity import — validation and conflicts", () => {
  it("not a gzip archive -> ImportError", () => {
    const root = tmpRoot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idimport-bad-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bad = path.join(dir, "not-an-archive.tgz");
    fs.writeFileSync(bad, "plain text, not gzip");
    expect(() => identityImport({ identitiesRoot: root, archivePath: bad })).toThrow(ImportError);
    expect(() => identityImport({ identitiesRoot: root, archivePath: bad })).toThrow(/not a \.tgz archive/);
  });

  it("a member with an absolute or parent-escaping path is refused before writing anything", () => {
    const root = tmpRoot();
    const archive = tmpArchive([...basicIdentityEntries("alice"), { name: "../escape.txt", type: "file", data: Buffer.from("x") }]);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/unsafe paths/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("manifest format > 1 is refused as too new", () => {
    const root = tmpRoot();
    const manifest = JSON.stringify({ format: 2, identities: [] });
    const archive = tmpArchive([{ name: "manifest.json", type: "file", data: Buffer.from(manifest) }, ...basicIdentityEntries("alice")]);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/archive format 2 is newer than this tool understands/);
  });

  it("a top-level dir with no info.txt is refused: 'not an identity'", () => {
    const root = tmpRoot();
    const archive = tmpArchive([{ name: "junk/", type: "directory" }, { name: "junk/readme.txt", type: "file", data: Buffer.from("x") }]);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/'junk' has no info.txt — not an identity/);
  });

  it("an invalid resolved name is refused (use --name to rename)", () => {
    const root = tmpRoot();
    const archive = tmpArchive(basicIdentityEntries("Alice_Bad", { name: "Alice_Bad" }));
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/invalid identity name: 'Alice_Bad'/);
  });

  it("importing into a name that already exists -> refused, nothing changed", () => {
    const root = tmpRoot();
    identityNew({ identitiesRoot: root, name: "alice" });
    const before = fs.readFileSync(path.join(root, "alice", "info.txt"), "utf-8");
    const archive = tmpArchive(basicIdentityEntries("alice"));
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/identity already exists: alice/);
    expect(fs.readFileSync(path.join(root, "alice", "info.txt"), "utf-8")).toBe(before);
  });

  it("archive with zero identity directories -> refused", () => {
    const root = tmpRoot();
    const archive = tmpArchive([{ name: "manifest.json", type: "file", data: Buffer.from("{}") }]);
    expect(() => identityImport({ identitiesRoot: root, archivePath: archive })).toThrow(/no identity directories in archive/);
  });
});

describe("identity import — live root-trajectory repair", () => {
  it("a soul-only archive (no trajectories/) gets a fresh root trajectory", () => {
    const root = tmpRoot();
    const archive = tmpArchive(basicIdentityEntries("alice", { rootTraj: "" }));
    identityImport({ identitiesRoot: root, archivePath: archive });
    const info = fs.readFileSync(path.join(root, "alice", "info.txt"), "utf-8");
    const m = /^root_trajectory=(.+)$/m.exec(info);
    expect(m).not.toBeNull();
    const newRt = m![1]!;
    expect(newRt).not.toBe("");
    const trajDir = fs.readdirSync(path.join(root, "alice", "trajectories")).find((d) => d.startsWith(`${newRt.slice(0, 8)}-`));
    expect(trajDir).toBeDefined();
    expect(fs.existsSync(path.join(root, "alice", "trajectories", trajDir!, "trajectory.jsonl"))).toBe(true);
  });

  it("re-points thinker subscriptions.jsonl at the new root traj id when repair fires", () => {
    const root = tmpRoot();
    const oldRt = "99998888-0000-0000-0000-000000000000";
    const subsContent = JSON.stringify({ from: "*", traj_id: oldRt }) + "\n";
    const entries = basicIdentityEntries("alice", {
      rootTraj: oldRt,
      extra: [
        { name: "alice/thinkers/", type: "directory" },
        { name: "alice/thinkers/monolith/", type: "directory" },
        { name: "alice/thinkers/monolith/subscriptions.jsonl", type: "file", data: Buffer.from(subsContent) },
      ],
    });
    // Strip the trajectory file this helper would have added for oldRt, so
    // the "have_traj" check sees nothing and repair fires anyway.
    const withoutTraj = entries.filter((e) => !e.name.includes("trajectories/"));
    const archive = tmpArchive(withoutTraj);
    identityImport({ identitiesRoot: root, archivePath: archive });
    const info = fs.readFileSync(path.join(root, "alice", "info.txt"), "utf-8");
    const newRt = /^root_trajectory=(.+)$/m.exec(info)![1]!;
    expect(newRt).not.toBe(oldRt);
    const subs = fs.readFileSync(path.join(root, "alice", "thinkers", "monolith", "subscriptions.jsonl"), "utf-8");
    expect(subs).toContain(newRt);
    expect(subs).not.toContain(oldRt);
  });
});

describe("identity import — secrets/runtime state stripped, dangling symlinks dropped", () => {
  it("strips run/, .shellm/, kernel/, .env, activate even if the archive carries them", () => {
    const root = tmpRoot();
    const entries = basicIdentityEntries("alice", {
      extra: [
        { name: "alice/.env", type: "file", data: Buffer.from("SECRET=1\n") },
        { name: "alice/activate", type: "file", data: Buffer.from("#!/bin/sh\n") },
        { name: "alice/run/", type: "directory" },
        { name: "alice/run/dispatcher.pid", type: "file", data: Buffer.from("123") },
        { name: "alice/.shellm/", type: "directory" },
        { name: "alice/.shellm/envs/x", type: "file", data: Buffer.from("x") },
        { name: "alice/kernel/", type: "directory" },
        { name: "alice/kernel/stale-marker", type: "file", data: Buffer.from("x") },
      ],
    });
    const archive = tmpArchive(entries);
    identityImport({ identitiesRoot: root, archivePath: archive });
    const dest = path.join(root, "alice");
    expect(fs.existsSync(path.join(dest, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "activate"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "run"))).toBe(false);
    expect(fs.existsSync(path.join(dest, ".shellm"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "kernel", "stale-marker"))).toBe(false); // kernel/ wholly regenerated
  });

  it("drops a symlink whose target doesn't resolve on this host", () => {
    const root = tmpRoot();
    const entries = basicIdentityEntries("alice", {
      extra: [
        { name: "alice/skills/", type: "directory" },
        { name: "alice/skills/custom-remote", type: "symlink", linkname: "/nonexistent/host/path/custom-remote" },
      ],
    });
    const archive = tmpArchive(entries);
    identityImport({ identitiesRoot: root, archivePath: archive });
    expect(fs.existsSync(path.join(root, "alice", "skills", "custom-remote"))).toBe(false);
  });

  it("keeps a symlink whose target DOES resolve on this host", () => {
    const root = tmpRoot();
    const realTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idimport-target-"));
    cleanups.push(() => fs.rmSync(realTargetDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(realTargetDir, "SKILL.md"), "# ok\n");
    const entries = basicIdentityEntries("alice", {
      extra: [
        { name: "alice/skills/", type: "directory" },
        { name: "alice/skills/custom-remote", type: "symlink", linkname: realTargetDir },
      ],
    });
    const archive = tmpArchive(entries);
    identityImport({ identitiesRoot: root, archivePath: archive });
    expect(fs.lstatSync(path.join(root, "alice", "skills", "custom-remote")).isSymbolicLink()).toBe(true);
  });
});

describe("IDENTITY_NAME_RE (shared with identity new)", () => {
  it("is the same pattern import validates resolved names against", () => {
    expect(IDENTITY_NAME_RE.test("alice-2")).toBe(true);
    expect(IDENTITY_NAME_RE.test("Alice")).toBe(false);
  });
});
