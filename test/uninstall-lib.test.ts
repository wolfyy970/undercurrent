// uninstall-lib.test.ts — unit tests for src/uninstall-lib.ts (uninstall.sh
// port). Scenarios mirror tests/test_uninstall.sh: dry-run listing, the real
// removal (state home, tool links, PATH line, identity backup), --delete-
// identities, and a user-owned checkout being left alone.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runUninstall,
  findAppDir,
  appIsOurs,
  ourPrefixEntries,
  rcFilesWithPathLine,
  type UninstallIO,
} from "../src/uninstall-lib.ts";
import { TOOLS } from "../src/install-lib.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function fakeIO(overrides: Partial<UninstallIO> = {}): { io: UninstallIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: UninstallIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    writeTty: (s) => out.push(s),
    readTtyLine: async () => undefined,
    hasTTY: () => false,
    listProcesses: () => [],
    selfPid: () => 99999,
    kill: () => true,
    ...overrides,
  };
  return { io, out, err };
}

/** A one-liner-shaped install: state home containing the (cloned) checkout, symlinked tools, an identity. */
function makeInstall(): { home: string; headlongHome: string; appDir: string; prefix: string; idRoot: string } {
  const home = tmpDir("uninstall-home-");
  const headlongHome = path.join(home, ".headlong");
  const appDir = path.join(headlongHome, "app");
  fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
  for (const t of TOOLS) fs.writeFileSync(path.join(appDir, "bin", t), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(appDir, "bin", "identity.mjs"), "");
  fs.writeFileSync(path.join(headlongHome, "app_dir"), `${appDir}\n`);
  const prefix = path.join(home, ".local", "bin");
  fs.mkdirSync(prefix, { recursive: true });
  for (const t of TOOLS) fs.symlinkSync(path.join(appDir, "bin", t), path.join(prefix, t));
  const idRoot = path.join(appDir, ".identities");
  fs.mkdirSync(path.join(idRoot, "ada"), { recursive: true });
  fs.writeFileSync(path.join(idRoot, "ada", "info.txt"), "name=ada\n");
  fs.symlinkSync("ada", path.join(idRoot, "default"));
  fs.writeFileSync(path.join(home, ".bashrc"), `export PATH="${prefix}:$PATH"\nalias ll="ls -l"\n`);
  return { home, headlongHome, appDir, prefix, idRoot };
}

describe("discovery helpers", () => {
  it("findAppDir prefers the recorded app_dir file", () => {
    const { headlongHome, appDir } = makeInstall();
    expect(findAppDir(headlongHome, tmpDir("cwd-"))).toBe(appDir);
  });

  it("appIsOurs is true only for a checkout under headlongHome", () => {
    const headlongHome = tmpDir("hh-");
    expect(appIsOurs(path.join(headlongHome, "app"), headlongHome)).toBe(true);
    expect(appIsOurs("/some/users/own/clone", headlongHome)).toBe(false);
    expect(appIsOurs(undefined, headlongHome)).toBe(false);
  });

  it("ourPrefixEntries finds TOOLS names and persona-pointing symlinks", () => {
    const { prefix, appDir } = makeInstall();
    fs.symlinkSync(path.join(prefix, "chat"), path.join(prefix, "persona")); // not a real tool here, just a probe
    const entries = ourPrefixEntries(prefix, appDir);
    for (const t of TOOLS) expect(entries).toContain(path.join(prefix, t));
  });

  it("rcFilesWithPathLine finds the exact PATH line", () => {
    const { home, prefix } = makeInstall();
    expect(rcFilesWithPathLine(home, prefix)).toEqual([path.join(home, ".bashrc")]);
  });
});

describe("runUninstall", () => {
  it("nothing to do when no install is found", async () => {
    const home = tmpDir("nothing-home-");
    const { io, out } = fakeIO();
    const code = await runUninstall({ argv: [], env: { PREFIX: path.join(home, "bin") }, io, home, cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/Nothing to do/);
  });

  it("--dry-run lists everything and changes nothing", async () => {
    const { home, headlongHome, appDir, prefix, idRoot } = makeInstall();
    const { io, out } = fakeIO();
    const code = await runUninstall({ argv: ["--dry-run", "--no-stop"], env: { PREFIX: prefix }, io, home, cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(new RegExp(`${appDir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s+\\(the checkout\\)`));
    expect(text).toMatch(/\(\.env with your API key/);
    expect(text).toMatch(/tool link\(s\)\/copies in/);
    expect(text).toMatch(/^\s{4}ada$/m);
    expect(text).toMatch(/will be moved to .*headlong-identities-backup-/);
    expect(text).toMatch(/Dry run: nothing changed/);
    expect(fs.existsSync(idRoot)).toBe(true);
    expect(fs.existsSync(path.join(prefix, "chat"))).toBe(true);
  });

  it("--yes --no-stop removes everything and backs up identities; a second run says nothing to do", async () => {
    const { home, headlongHome, appDir, prefix, idRoot } = makeInstall();
    const { io, out } = fakeIO();
    const code = await runUninstall({ argv: ["--yes", "--no-stop"], env: { PREFIX: prefix }, io, home, cwd: tmpDir("cwd-"), now: () => new Date("2026-01-02T03:04:05Z") });
    expect(code).toBe(0);
    expect(fs.existsSync(headlongHome)).toBe(false);
    expect(fs.existsSync(path.join(prefix, "chat"))).toBe(false);
    const bashrc = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(bashrc).not.toMatch(/\.local\/bin/);
    expect(bashrc).toMatch(/alias ll=/);
    const backupDirs = fs.readdirSync(home).filter((f) => f.startsWith("headlong-identities-backup-"));
    expect(backupDirs.length).toBe(1);
    expect(fs.existsSync(path.join(home, backupDirs[0]!, "ada", "info.txt"))).toBe(true);
    expect(out.join("")).toMatch(/Headlong-TS is uninstalled/);

    const { io: io2, out: out2 } = fakeIO();
    const code2 = await runUninstall({ argv: ["--yes", "--no-stop"], env: { PREFIX: prefix }, io: io2, home, cwd: tmpDir("cwd2-"), now: () => new Date() });
    expect(code2).toBe(0);
    expect(out2.join("")).toMatch(/Nothing to do/);
  });

  it("--delete-identities leaves no backup", async () => {
    const { home, headlongHome, prefix, idRoot } = makeInstall();
    const { io } = fakeIO();
    const code = await runUninstall({ argv: ["--yes", "--no-stop", "--delete-identities"], env: { PREFIX: prefix }, io, home, cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).toBe(0);
    expect(fs.readdirSync(home).some((f) => f.startsWith("headlong-identities-backup-"))).toBe(false);
    expect(fs.existsSync(headlongHome)).toBe(false);
  });

  it("a user-owned checkout (not under the state home) is left alone", async () => {
    const home = tmpDir("own-home-");
    const clone = tmpDir("own-clone-");
    fs.mkdirSync(path.join(clone, "bin"), { recursive: true });
    fs.writeFileSync(path.join(clone, "bin", "identity.mjs"), "");
    fs.mkdirSync(path.join(clone, ".identities", "bob"), { recursive: true });
    const headlongHome = path.join(home, ".headlong");
    fs.mkdirSync(headlongHome, { recursive: true });
    fs.writeFileSync(path.join(headlongHome, "app_dir"), `${clone}\n`);
    const prefix = path.join(home, ".local", "bin");
    fs.mkdirSync(prefix, { recursive: true });

    const { io, out } = fakeIO();
    const dry = await runUninstall({ argv: ["--dry-run", "--no-stop"], env: { PREFIX: prefix }, io, home, cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(dry).toBe(0);
    expect(out.join("")).toMatch(/your own checkout at .*stay in place/);
    expect(out.join("")).not.toMatch(/Your agent's identities/);

    const { io: io2 } = fakeIO();
    const code = await runUninstall({ argv: ["--yes", "--no-stop"], env: { PREFIX: prefix }, io: io2, home, cwd: tmpDir("cwd2-"), now: () => new Date() });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(clone, "bin", "identity.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(clone, ".identities", "bob"))).toBe(true);
    expect(fs.existsSync(headlongHome)).toBe(false);
  });

  it("no tty and no --yes refuses, changes nothing", async () => {
    const { home, prefix, headlongHome } = makeInstall();
    const { io } = fakeIO({ hasTTY: () => false });
    const code = await runUninstall({ argv: ["--no-stop"], env: { PREFIX: prefix }, io, home, cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).toBe(1);
    expect(fs.existsSync(headlongHome)).toBe(true);
  });

  it("--help prints usage and exits 0", async () => {
    const { io, out } = fakeIO();
    const code = await runUninstall({ argv: ["--help"], env: {}, io, home: tmpDir("help-home-"), cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^Usage: node uninstall\.mjs/);
  });

  it("an unknown option is an error", async () => {
    const { io } = fakeIO();
    const code = await runUninstall({ argv: ["--bogus"], env: {}, io, home: tmpDir("bogus-home-"), cwd: tmpDir("cwd-"), now: () => new Date() });
    expect(code).not.toBe(0);
  });
});
