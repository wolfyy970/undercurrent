// identity-export.test.ts — `identity export` (tools/identity:521-638
// cmd_export + its helpers: 423-429 _export_file_list, 432-455
// _export_manifest_entry, 463-493 slim/redact, 495-519
// _export_append_identity, 997-1025 _resolve_identity_path), unit-level
// against fixtures built with this port's own `identityNew` (no real
// symlinks — those are exercised separately below and by the differential
// harness at parity/identity/run-export-parity.mjs, which builds fixtures
// with the REAL Bash `identity new` and diffs archive contents against the
// REAL Bash `identity export`).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  identityNew,
  resolveExportDirs,
  buildIdentityExportArchive,
  defaultExportOutName,
  ExportError,
} from "../src/identity.ts";
import { readTarGz, type TarEntry } from "../src/tar.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idexport-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function byName(entries: TarEntry[]): Map<string, TarEntry> {
  return new Map(entries.map((e) => [e.name, e]));
}
function makeIdentity(root: string, name: string, opts: { setDefault?: boolean } = {}) {
  const result = identityNew({ identitiesRoot: root, name, ...(opts.setDefault !== undefined ? { setDefault: opts.setDefault } : {}) });
  return { name, dir: path.join(root, name), rootTrajectoryId: result.rootTrajectoryId };
}

describe("identity export — dir resolution (resolveExportDirs / _resolve_identity_path)", () => {
  it("bare name -> exact dir match", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice");
    const dirs = resolveExportDirs(root, { names: ["alice"] });
    expect(dirs).toEqual([path.join(root, "alice")]);
  });

  it("bare name -> unique substring match (fuzzy)", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice-prod");
    const dirs = resolveExportDirs(root, { names: ["prod"] });
    expect(dirs).toEqual([path.join(root, "alice-prod")]);
  });

  it("ambiguous substring match -> ExportError", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice-prod");
    makeIdentity(root, "bob-prod", { setDefault: false });
    expect(() => resolveExportDirs(root, { names: ["prod"] })).toThrow(/Ambiguous/);
  });

  it("no match -> ExportError", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice");
    expect(() => resolveExportDirs(root, { names: ["nobody"] })).toThrow(/No identity matching: nobody/);
  });

  it("no args -> resolves the `default` symlink", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice", { setDefault: true });
    const dirs = resolveExportDirs(root, {});
    expect(dirs).toEqual([path.join(root, "alice")]);
  });

  it("no args, no default symlink -> ExportError", () => {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
    expect(() => resolveExportDirs(root, {})).toThrow(/No default identity/);
  });

  it("--all expands every identity dir, excluding `default`", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice");
    makeIdentity(root, "bob", { setDefault: false });
    const dirs = resolveExportDirs(root, { all: true });
    expect(dirs.map((d) => path.basename(d)).sort()).toEqual(["alice", "bob"]);
  });

  it("--all with no identities -> ExportError", () => {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
    expect(() => resolveExportDirs(root, { all: true })).toThrow(/No identities found/);
  });

  it("--all + names -> ExportError (pass names or --all, not both)", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice");
    expect(() => resolveExportDirs(root, { all: true, names: ["alice"] })).toThrow(/not both/);
  });

  it("--path -> exact dir, requires info.txt", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    const dirs = resolveExportDirs(root, { paths: [dir] });
    expect(dirs).toEqual([path.resolve(dir)]);
  });

  it("--path to a non-identity dir -> ExportError", () => {
    const root = tmpRoot();
    const notAnIdentity = path.join(root, "junk");
    fs.mkdirSync(notAnIdentity);
    expect(() => resolveExportDirs(root, { paths: [notAnIdentity] })).toThrow(/not an identity dir/);
  });

  it("--path + names -> ExportError (mix)", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    expect(() => resolveExportDirs(root, { paths: [dir], names: ["alice"] })).toThrow(/not a mix/);
  });

  it("duplicate basenames across --path -> ExportError", () => {
    const root = tmpRoot();
    const a = tmpRoot();
    const b = tmpRoot();
    fs.mkdirSync(path.join(a, "alice"));
    fs.writeFileSync(path.join(a, "alice", "info.txt"), "name=alice\n");
    fs.mkdirSync(path.join(b, "alice"));
    fs.writeFileSync(path.join(b, "alice", "info.txt"), "name=alice\n");
    expect(() => resolveExportDirs(root, { paths: [path.join(a, "alice"), path.join(b, "alice")] })).toThrow(
      /duplicate identity directory name/
    );
  });
});

describe("identity export — archive contents (buildIdentityExportArchive)", () => {
  it("excludes run/, .shellm/, kernel/, thinkers/ (deref'd separately), .env, activate", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    fs.mkdirSync(path.join(dir, "run"), { recursive: true });
    fs.writeFileSync(path.join(dir, "run", "pid"), "123");
    fs.mkdirSync(path.join(dir, ".shellm", "envs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".shellm", "envs", "x"), "y");
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(dir, "activate"), "# activate script\n");

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const buf = buildIdentityExportArchive({ dirs });
    const entries = byName(readTarGz(buf));

    expect(entries.has("alice/run/")).toBe(false);
    expect(entries.has("alice/run/pid")).toBe(false);
    expect(entries.has("alice/.shellm/")).toBe(false);
    expect(entries.has("alice/.shellm/envs/x")).toBe(false);
    expect(entries.has("alice/kernel/")).toBe(false);
    expect(entries.has("alice/.env")).toBe(false);
    expect(entries.has("alice/activate")).toBe(false);
    // thinkers/ IS in the archive, but via the deref pass, not the main walk —
    // still present as real dirs/files (identityNew installs real files, no symlinks).
    expect(entries.has("alice/thinkers/")).toBe(true);
    expect(entries.has("alice/thinkers/monolith/step")).toBe(true);
    // things that DO travel:
    expect(entries.has("alice/info.txt")).toBe(true);
    expect(entries.has("alice/skills/")).toBe(true);
    expect(entries.has("alice/trajectories/")).toBe(true);
  });

  it("manifest.json carries format/soul_only/slim/per-identity stats", () => {
    const root = tmpRoot();
    const { dir, rootTrajectoryId } = makeIdentity(root, "alice");
    fs.writeFileSync(path.join(dir, "memories", "one.md"), "# one\n");
    fs.writeFileSync(path.join(dir, "memories", "two.md"), "# two\n");
    fs.writeFileSync(path.join(dir, "memories", "not-markdown.txt"), "skip me\n");

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const buf = buildIdentityExportArchive({ dirs, soulOnly: false, slim: true, now: () => new Date("2026-03-04T05:06:07") });
    const entries = byName(readTarGz(buf));
    const manifest = JSON.parse(entries.get("manifest.json")!.data.toString("utf-8"));

    expect(manifest.format).toBe(1);
    expect(manifest.soul_only).toBe(false);
    expect(manifest.slim).toBe(true);
    expect(manifest.exported_at).toBe("2026-03-04T05:06:07");
    expect(manifest.identities).toHaveLength(1);
    expect(manifest.identities[0]).toMatchObject({
      dir: "alice",
      name: "alice",
      root_trajectory: rootTrajectoryId,
      memories: 2,
    });
    expect(manifest.identities[0].traj_steps).toBeGreaterThan(0);
  });

  it("--soul-only drops trajectories/ entirely, keeps memories/skills/thinkers", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    fs.writeFileSync(path.join(dir, "memories", "one.md"), "# one\n");

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs, soulOnly: true })));
    expect(entries.has("alice/trajectories/")).toBe(false);
    expect([...entries.keys()].some((n) => n.startsWith("alice/trajectories/"))).toBe(false);
    expect(entries.has("alice/memories/one.md")).toBe(true);
    expect(entries.has("alice/skills/")).toBe(true);
    expect(entries.has("alice/thinkers/monolith/step")).toBe(true);
  });

  it("--slim truncates long shellm-run/prompt fields and redacts API keys, leaves other steps untouched", () => {
    const root = tmpRoot();
    const { dir, rootTrajectoryId } = makeIdentity(root, "alice");
    const trajDirName = fs.readdirSync(path.join(dir, "trajectories"))[0]!;
    const jsonl = path.join(dir, "trajectories", trajDirName, "trajectory.jsonl");
    const longCommand = "X".repeat(400);
    const longPrompt = `${"Y".repeat(650)} sk-ant-abc123DEF456 tail`;
    fs.appendFileSync(
      jsonl,
      `${JSON.stringify({ type: "shellm-run", command: longCommand, other: 1 })}\n` +
        `${JSON.stringify({ type: "prompt", content: longPrompt })}\n` +
        `${JSON.stringify({ type: "thought", content: "unaffected, not shellm-run/prompt" })}\n`
    );

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs, slim: true })));
    const traj = entries.get(`alice/trajectories/${trajDirName}/trajectory.jsonl`)!;
    const lines = traj.data
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));

    const runStep = lines.find((l) => l.type === "shellm-run");
    expect(runStep.command.length).toBeLessThan(longCommand.length);
    expect(runStep.command).toMatch(/…\[truncated \d+ chars\]$/);
    expect(runStep.other).toBe(1); // untouched fields survive

    const promptStep = lines.find((l) => l.type === "prompt");
    expect(promptStep.content).not.toContain("sk-ant-"); // redacted (or already cut away)

    const thoughtStep = lines.find((l) => l.type === "thought" && l.content === "unaffected, not shellm-run/prompt");
    expect(thoughtStep).toBeDefined();

    // manifest's own traj_steps count is computed from the LIVE (unslimmed)
    // file (tools/identity:443-449 reads $dir/trajectories, not the staged
    // slim copy) — still present and positive.
    void rootTrajectoryId;
  });

  it("PORT-NOTE (1c: 9a62727): slim drops content_b64 from every step, not just shellm-run/prompt", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    const trajDirName = fs.readdirSync(path.join(dir, "trajectories"))[0]!;
    const jsonl = path.join(dir, "trajectories", trajDirName, "trajectory.jsonl");
    fs.appendFileSync(
      jsonl,
      `${JSON.stringify({ type: "message", filename: "photo.jpg", content: "[file: photo.jpg]", content_b64: "ZmFrZWJ5dGVz" })}\n` +
        `${JSON.stringify({ type: "shellm-run", command: "echo hi", content_b64: "c2hvdWxkYmVkcm9wcGVk" })}\n`
    );

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs, slim: true })));
    const traj = entries.get(`alice/trajectories/${trajDirName}/trajectory.jsonl`)!;
    const lines = traj.data
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));

    const messageStep = lines.find((l) => l.type === "message");
    expect(messageStep).toBeDefined();
    expect(messageStep.content_b64).toBeUndefined();
    expect(messageStep.filename).toBe("photo.jpg"); // untouched sibling field survives

    const runStep = lines.find((l) => l.type === "shellm-run");
    expect(runStep.content_b64).toBeUndefined();
    expect(runStep.command).toBe("echo hi");

    // A non-slim export keeps content_b64 untouched.
    const fullEntries = byName(readTarGz(buildIdentityExportArchive({ dirs, slim: false })));
    const fullTraj = fullEntries.get(`alice/trajectories/${trajDirName}/trajectory.jsonl`)!;
    expect(fullTraj.data.toString("utf-8")).toContain("ZmFrZWJ5dGVz");
  });

  it("redacts a short (un-truncated) API key in a shellm-run command", () => {
    // Key built via concatenation, not a literal — test/scrub.test.ts forbids
    // a contiguous "sk" + "-or-v1-" in any tracked file.
    const fakeKey = `sk${"-or-v1-"}abcXYZ789`;
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    const trajDirName = fs.readdirSync(path.join(dir, "trajectories"))[0]!;
    const jsonl = path.join(dir, "trajectories", trajDirName, "trajectory.jsonl");
    fs.appendFileSync(
      jsonl,
      `${JSON.stringify({ type: "shellm-run", command: `curl -H 'Authorization: Bearer ${fakeKey}'` })}\n`
    );
    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs, slim: true })));
    const traj = entries.get(`alice/trajectories/${trajDirName}/trajectory.jsonl`)!;
    expect(traj.data.toString("utf-8")).toContain("[REDACTED:openrouter]");
    expect(traj.data.toString("utf-8")).not.toContain(fakeKey);
  });

  it("thinkers/ symlinks are dereferenced (real files/dirs in the archive, not symlink entries)", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    // Simulate a `--symlinks` install: replace the monolith thinker dir's
    // `step` file with a symlink to an out-of-tree real file.
    const realStep = path.join(root, "real-step-source");
    fs.writeFileSync(realStep, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.rmSync(path.join(dir, "thinkers", "monolith", "step"));
    fs.symlinkSync(realStep, path.join(dir, "thinkers", "monolith", "step"));

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs })));
    const stepEntry = entries.get("alice/thinkers/monolith/step")!;
    expect(stepEntry.type).toBe("file"); // NOT "symlink" — dereferenced
    expect(stepEntry.data.toString("utf-8")).toBe("#!/bin/sh\necho hi\n");
  });

  it("dangling thinkers/ symlink is dropped, not fatal (documented deviation from bash's whole-cp failure)", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    fs.rmSync(path.join(dir, "thinkers", "monolith", "step"));
    fs.symlinkSync(path.join(root, "nowhere"), path.join(dir, "thinkers", "monolith", "step"));

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs })));
    expect(entries.has("alice/thinkers/monolith/step")).toBe(false);
    expect(entries.has("alice/thinkers/monolith/")).toBe(true); // the rest still travels
  });

  it("skills/ symlinks (not thinkers) are preserved AS symlinks, not dereferenced", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    const target = path.join(root, "bundled-skill-source");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "# skill\n");
    fs.rmSync(path.join(dir, "skills", "shellm"), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(dir, "skills", "shellm"));

    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs })));
    const skillEntry = entries.get("alice/skills/shellm")!;
    expect(skillEntry.type).toBe("symlink");
    expect(skillEntry.linkname).toBe(target);
  });

  it("--all exports every identity as a separate top-level dir in ONE archive with ONE manifest", () => {
    const root = tmpRoot();
    makeIdentity(root, "alice");
    makeIdentity(root, "bob", { setDefault: false });
    const dirs = resolveExportDirs(root, { all: true });
    const buf = buildIdentityExportArchive({ dirs });
    const entries = byName(readTarGz(buf));
    expect(entries.has("alice/info.txt")).toBe(true);
    expect(entries.has("bob/info.txt")).toBe(true);
    const manifest = JSON.parse(entries.get("manifest.json")!.data.toString("utf-8"));
    expect(manifest.identities.map((i: { dir: string }) => i.dir).sort()).toEqual(["alice", "bob"]);
  });

  it("real file modes travel (executable thinker step script stays executable)", () => {
    const root = tmpRoot();
    const { dir } = makeIdentity(root, "alice");
    const dirs = resolveExportDirs(root, { names: ["alice"] });
    const entries = byName(readTarGz(buildIdentityExportArchive({ dirs })));
    const stepMode = fs.statSync(path.join(dir, "thinkers", "monolith", "step")).mode & 0o777;
    expect(entries.get("alice/thinkers/monolith/step")!.mode).toBe(stepMode);
    expect(stepMode & 0o100).toBeTruthy(); // owner-executable
  });
});

describe("identity export — defaultExportOutName", () => {
  it("single identity -> <name>-<stamp>.shellm.tgz", () => {
    const name = defaultExportOutName(["/x/alice"], () => new Date("2026-01-02T03:04:05"));
    expect(name).toBe("alice-20260102-030405.shellm.tgz");
  });
  it("multiple identities -> identities-<stamp>.shellm.tgz", () => {
    const name = defaultExportOutName(["/x/alice", "/x/bob"], () => new Date("2026-01-02T03:04:05"));
    expect(name).toBe("identities-20260102-030405.shellm.tgz");
  });
});

describe("identity export — ExportError is a distinguishable class", () => {
  it("instanceof check works for router-layer error mapping", () => {
    const root = tmpRoot();
    try {
      resolveExportDirs(root, { names: ["nobody"] });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExportError);
    }
  });
});
