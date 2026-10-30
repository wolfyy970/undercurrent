// install-lib.test.ts — unit tests for src/install-lib.ts (install.sh port).
// Mirrors tests/test_install_secret_argv.sh's assertions for dockerForwardArgs
// (the equivalent of upstream's _docker_forward_args). The bootstrap clone
// against a real local bare/plain repo is exercised by parity/install/
// run-parity.mjs and by a smoke test here (no network).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TOOLS,
  dockerForwardArgs,
  parseDockerMenuChoice,
  locationOfferAvailable,
  installTools,
  ensurePath,
  cloneOrUpdate,
  resolveBootstrapPlan,
  recordAppDir,
  runInstall,
  type InstallIO,
} from "../src/install-lib.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function fakeIO(overrides: Partial<InstallIO> = {}): { io: InstallIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: InstallIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    writeTty: (s) => out.push(s),
    readTtyLine: async () => undefined,
    hasTTY: () => false,
    run: () => 0,
    execNode: () => {
      throw new Error("execNode should not be called in this test");
    },
    ...overrides,
  };
  return { io, out, err };
}

describe("dockerForwardArgs (tests/test_install_secret_argv.sh)", () => {
  it("forwards provider keys by NAME only — the value never reaches args", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-ARGVCANARY", OPENCODE_API_KEY: "sk-OPENCODECANARY" };
    const { args, envToSet } = dockerForwardArgs(env);
    expect(args.join(" ")).not.toContain("ARGVCANARY");
    expect(args.join(" ")).toContain("-e OPENROUTER_API_KEY");
    expect(args.join(" ")).toContain("-e OPENCODE_API_KEY");
    expect(envToSet["OPENROUTER_API_KEY"]).toBe("sk-or-ARGVCANARY");
    expect(envToSet["OPENCODE_API_KEY"]).toBe("sk-OPENCODECANARY");
  });

  it("forwards the local server key by name, off argv", () => {
    const { args, envToSet } = dockerForwardArgs({ HEADLONG_LOCAL_API_KEY: "local-ARGVCANARY" });
    expect(args.join(" ")).not.toContain("ARGVCANARY");
    expect(args.join(" ")).toContain("-e HEADLONG_LOCAL_API_KEY");
    expect(envToSet["HEADLONG_LOCAL_API_KEY"]).toBe("local-ARGVCANARY");
  });

  it("rewrites a loopback local URL to host.docker.internal and forwards it by name", () => {
    const { args, envToSet } = dockerForwardArgs({ HEADLONG_LOCAL_URL: "http://127.0.0.1:8090/v1" });
    expect(args.join(" ")).not.toContain("127.0.0.1");
    expect(args.join(" ")).toContain("-e HEADLONG_LOCAL_URL");
    expect(envToSet["HEADLONG_LOCAL_URL"]).toBe("http://host.docker.internal:8090/v1");
  });

  it("forwards interview answers and HEADLONG_REPO/BRANCH inline", () => {
    const { args } = dockerForwardArgs({ HEADLONG_IDENTITY_NAME: "ada", HEADLONG_REPO: "https://example.invalid/fork.git", HEADLONG_BRANCH: "experiment" });
    expect(args).toContain("HEADLONG_IDENTITY_NAME=ada");
    expect(args).toContain("HEADLONG_REPO=https://example.invalid/fork.git");
    expect(args).toContain("HEADLONG_BRANCH=experiment");
  });

  it("forwards nothing when no key or answer is set", () => {
    const { args } = dockerForwardArgs({});
    expect(args).toEqual([]);
  });
});

describe("parseDockerMenuChoice", () => {
  it("empty or '1' is container, '2' is host, '3' is unsandboxed, else invalid", () => {
    expect(parseDockerMenuChoice("")).toBe("container");
    expect(parseDockerMenuChoice("1")).toBe("container");
    expect(parseDockerMenuChoice("2")).toBe("host");
    expect(parseDockerMenuChoice("3")).toBe("unsandboxed");
    expect(parseDockerMenuChoice("bogus")).toBe("invalid");
  });
});

describe("locationOfferAvailable", () => {
  it("false once already chosen, with no tty, or docker not ok", () => {
    const tty = { hasTTY: () => true };
    const noTty = { hasTTY: () => false };
    expect(locationOfferAvailable({ HEADLONG_INSTALL_LOCATION_CHOSEN: "1", HEADLONG_FAKE_DOCKER: "ok" }, tty)).toBe(false);
    expect(locationOfferAvailable({ HEADLONG_FAKE_DOCKER: "ok" }, noTty)).toBe(false);
    expect(locationOfferAvailable({ HEADLONG_FAKE_DOCKER: "down" }, tty)).toBe(false);
    expect(locationOfferAvailable({ HEADLONG_FAKE_DOCKER: "ok" }, tty)).toBe(true);
  });
});

describe("installTools", () => {
  it("symlinks every tool from bin/ into prefix, resolving to the checkout's own bin/", () => {
    const appDir = tmpDir("install-app-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    for (const t of TOOLS) fs.writeFileSync(path.join(appDir, "bin", t), "#!/usr/bin/env node\n");
    const prefix = tmpDir("install-prefix-");
    const { io } = fakeIO();
    installTools(appDir, prefix, true, io);
    for (const t of TOOLS) {
      const link = path.join(prefix, t);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(appDir, "bin", t)));
    }
  });

  it("copies (not symlinks) when symlinks=false", () => {
    const appDir = tmpDir("install-app2-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    for (const t of TOOLS) fs.writeFileSync(path.join(appDir, "bin", t), "#!/usr/bin/env node\n");
    const prefix = tmpDir("install-prefix2-");
    const { io } = fakeIO();
    installTools(appDir, prefix, false, io);
    for (const t of TOOLS) {
      expect(fs.lstatSync(path.join(prefix, t)).isSymbolicLink()).toBe(false);
      expect(fs.statSync(path.join(prefix, t)).mode & 0o111).toBeTruthy();
    }
  });
});

describe("ensurePath", () => {
  it("no tty, not in container: warns and does not write an rc file", async () => {
    const home = tmpDir("ensurepath-home-");
    const prefix = path.join(home, ".local", "bin");
    const env: Record<string, string> = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    const { io, out } = fakeIO({ hasTTY: () => false });
    const result = await ensurePath(prefix, env, io, "linux", home);
    expect(result.rcFile).toBeUndefined();
    expect(env["PATH"]!.split(path.delimiter)[0]).toBe(prefix);
    expect(out.join("")).toMatch(/not on your PATH/);
  });

  it("already on PATH: returns immediately, no rc write", async () => {
    const home = tmpDir("ensurepath-home2-");
    const prefix = path.join(home, ".local", "bin");
    const env: Record<string, string> = { PATH: `${prefix}:/usr/bin`, SHELL: "/bin/bash" };
    const { io } = fakeIO({ hasTTY: () => false });
    const result = await ensurePath(prefix, env, io, "linux", home);
    expect(result).toEqual({});
  });

  it("tty + yes: appends the PATH line to the rc file exactly once", async () => {
    const home = tmpDir("ensurepath-home3-");
    const prefix = path.join(home, ".local", "bin");
    const env: Record<string, string> = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    const { io } = fakeIO({ hasTTY: () => true, readTtyLine: async () => "" });
    const result = await ensurePath(prefix, env, io, "linux", home);
    expect(result.rcFile).toBe(path.join(home, ".bashrc"));
    const text = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(text).toContain(`export PATH="${prefix}:$PATH"`);
    // idempotent
    const env2: Record<string, string> = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    await ensurePath(prefix, env2, io, "linux", home);
    const text2 = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(text2.split(`export PATH="${prefix}:$PATH"`).length - 1).toBe(1);
  });
});

describe("resolveBootstrapPlan / cloneOrUpdate against a local repo (no network)", () => {
  it("clones a local bare repo at the requested branch", () => {
    const srcRoot = tmpDir("bootstrap-src-");
    spawnSync("git", ["init", "-q", "-b", "main", srcRoot]);
    spawnSync("git", ["-C", srcRoot, "config", "user.email", "t@example.com"]);
    spawnSync("git", ["-C", srcRoot, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(srcRoot, "bin"), ""); // placeholder file, just needs a commit
    fs.mkdirSync(path.join(srcRoot, "bin2"));
    fs.writeFileSync(path.join(srcRoot, "README.md"), "hi\n");
    spawnSync("git", ["-C", srcRoot, "add", "."]);
    spawnSync("git", ["-C", srcRoot, "commit", "-q", "-m", "init"]);
    spawnSync("git", ["-C", srcRoot, "checkout", "-q", "-b", "test-branch"]);

    const headlongHome = tmpDir("bootstrap-home-");
    const env: Record<string, string> = { HEADLONG_REPO: srcRoot, HEADLONG_BRANCH: "test-branch" };
    const plan = resolveBootstrapPlan(env, headlongHome);
    expect(plan.appDir).toBe(path.join(headlongHome, "app"));
    const { io } = fakeIO({
      run: (cmd, args, opts) => spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: "ignore" }).status ?? 1,
    });
    cloneOrUpdate(plan, env, io);
    expect(fs.existsSync(path.join(plan.appDir, "README.md"))).toBe(true);
    const branch = spawnSync("git", ["-C", plan.appDir, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
    expect(branch).toBe("test-branch");

    // second call updates in place rather than re-cloning
    cloneOrUpdate(plan, env, io);
    expect(fs.existsSync(path.join(plan.appDir, ".git"))).toBe(true);
  });
});

describe("recordAppDir", () => {
  it("writes app_dir with a trailing newline", () => {
    const home = tmpDir("recordappdir-");
    recordAppDir(path.join(home, ".headlong"), "/some/app");
    expect(fs.readFileSync(path.join(home, ".headlong", "app_dir"), "utf8")).toBe("/some/app\n");
  });
});

describe("runInstall — end to end (checkout mode)", () => {
  it("installs tools, records app_dir, and (no tty) warns about PATH", async () => {
    const appDir = tmpDir("runinstall-app-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    for (const t of TOOLS) fs.writeFileSync(path.join(appDir, "bin", t), "#!/usr/bin/env node\n");
    fs.writeFileSync(path.join(appDir, "bin", "identity.mjs"), "");
    fs.writeFileSync(path.join(appDir, "install.mjs"), "");
    const home = tmpDir("runinstall-home-");
    const prefix = path.join(home, ".local", "bin");
    const env: Record<string, string> = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    const { io, out } = fakeIO({ hasTTY: () => false });
    const code = await runInstall({
      argv: ["--prefix", prefix, "--symlinks"],
      env,
      io,
      selfPath: path.join(appDir, "install.mjs"),
      home,
      platform: "linux",
      installUrl: "https://example.invalid/install.mjs",
    });
    expect(code).toBe(0);
    for (const t of TOOLS) expect(fs.existsSync(path.join(prefix, t))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".headlong", "app_dir"), "utf8").trim()).toBe(fs.realpathSync(appDir));
    expect(out.join("")).toMatch(/not on your PATH/);
  });

  it("--help prints usage and exits 0", async () => {
    const appDir = tmpDir("runinstall-app2-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "bin", "identity.mjs"), "");
    fs.writeFileSync(path.join(appDir, "install.mjs"), "");
    const { io, out } = fakeIO();
    const code = await runInstall({
      argv: ["--help"],
      env: {},
      io,
      selfPath: path.join(appDir, "install.mjs"),
      home: tmpDir("runinstall-home2-"),
      platform: "linux",
      installUrl: "x",
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^Usage: node install\.mjs/);
  });
});
