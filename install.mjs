#!/usr/bin/env bun
// install.mjs — port of install.sh (upstream @ 5458fee). Installs Headlong-TS's
// tools onto PATH.
//
// Two ways in, same as upstream:
//
//   From a checkout:
//     node install.mjs [options]
//
//   One-liner (no checkout needed):
//     curl -fsSL <url>/install.mjs | node - [options]
//
// The one-liner clones the repo to $HEADLONG_HOME/app, then re-execs the
// CLONE's own install.mjs with --symlinks --init.
//
// PORT-NOTE: this bootstrap phase (below, before the checkout-mode branch)
// is deliberately self-contained with NO relative imports. `node -` (piped
// stdin) has no real file on disk, so import.meta.url is a synthetic
// `file://<cwd>/[eval1]` — a relative import of ./src/install-lib.ts would
// resolve against the caller's cwd, not this script's origin, and 404 in
// the exact scenario (an empty directory, nothing cloned yet) this phase
// exists for. Once re-exec'd as `node <clone>/install.mjs`, argv[1] is a
// real file path and the rest of the logic (src/install-lib.ts) loads
// normally. install.sh has the equivalent property for free: bash
// concatenates the whole piped script into one process with no module
// boundary at all.
//
// PORT-NOTE: unlike install.sh's _bootstrap_and_reexec (which offers the
// whole-agent-in-Docker menu BEFORE cloning, to skip a needless clone when
// the operator picks "fully in a container"), this port always clones
// first and offers that menu after re-exec, in checkout mode — one
// possibly-unnecessary git clone in that one path, in exchange for keeping
// the bootstrap phase free of anything beyond a plain `git clone`. See
// PARITY.md "install".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

function isCheckout(dir) {
  return fs.existsSync(path.join(dir, "bin", "identity.mjs"));
}

function resolveSelfDir(selfPath) {
  if (!selfPath || selfPath === "-") return undefined;
  try {
    const real = fs.realpathSync(selfPath);
    return fs.statSync(real).isFile() ? path.dirname(real) : undefined;
  } catch {
    return undefined;
  }
}

const env = { ...process.env };
const home = env.HOME ?? os.homedir();
const headlongHome = env.HEADLONG_HOME || path.join(home, ".headlong");
const selfDir = resolveSelfDir(process.argv[1] ?? "-");

if (!selfDir || !isCheckout(selfDir)) {
  // --- bootstrap: clone, then hand off to the clone's own install.mjs ------
  const gitCheck = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (gitCheck.error || gitCheck.status !== 0) {
    process.stderr.write("install.mjs: error: missing dependency: git\n");
    process.exit(1);
  }
  process.stdout.write(
    "\nHeadlong-TS installer. At any time, from any shell:\n" +
      "  read-only status:  node status.mjs (from the checkout)\n" +
      "  uninstall:         node uninstall.mjs (from the checkout)\n\n"
  );
  const repo = env.HEADLONG_REPO || "https://github.com/wolfyy970/undercurrent.git";
  const branch = env.HEADLONG_BRANCH || "main";
  const appDir = path.join(headlongHome, "app");
  if (fs.existsSync(path.join(appDir, ".git"))) {
    process.stdout.write(`==> Updating existing checkout at ${appDir}\n`);
    const pull = spawnSync("git", ["-C", appDir, "pull", "--ff-only", "origin", branch], { stdio: "ignore", env });
    if (pull.status !== 0) process.stderr.write(`install.mjs: warning: could not update ${appDir}; installing from what's there\n`);
  } else {
    process.stdout.write(`==> Cloning ${repo} (${branch}) to ${appDir}\n`);
    fs.mkdirSync(path.dirname(appDir), { recursive: true });
    const clone = spawnSync("git", ["clone", "--branch", branch, repo, appDir], { stdio: "inherit", env });
    if (clone.status !== 0) {
      process.stderr.write(`install.mjs: error: git clone failed (exit ${clone.status})\n`);
      process.exit(clone.status ?? 1);
    }
  }
  process.stdout.write("\n");
  const handoff = spawnSync(process.execPath, [path.join(appDir, "install.mjs"), "--symlinks", "--init", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  process.exit(handoff.status ?? 1);
}

// --- checkout mode: a real file on disk; safe to import the full logic. ---
const { runInstall } = await import(new URL("./src/install-lib.ts", import.meta.url));

/** @type {import("./src/install-lib.ts").InstallIO} */
const io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  writeTty: (s) => {
    try {
      fs.writeFileSync("/dev/tty", s);
    } catch {
      /* no tty */
    }
  },
  readTtyLine: () =>
    new Promise((resolve) => {
      let fd;
      try {
        fd = fs.openSync("/dev/tty", "r");
      } catch {
        resolve(undefined);
        return;
      }
      const stream = fs.createReadStream("", { fd });
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          let line = buf.slice(0, nl);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          stream.close();
          resolve(line);
        }
      });
      stream.on("error", () => resolve(undefined));
      stream.on("end", () => resolve(undefined));
    }),
  hasTTY: () => {
    try {
      const fd = fs.openSync("/dev/tty", "r");
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  },
  run: (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: opts.stdio ?? "inherit" });
    return r.status ?? 1;
  },
  execNode: (scriptPath, args, execEnv) => {
    const r = spawnSync(process.execPath, [scriptPath, ...args], { stdio: "inherit", env: execEnv });
    process.exit(r.status ?? 1);
  },
};

const code = await runInstall({
  argv: process.argv.slice(2),
  env,
  io,
  selfPath: process.argv[1] ?? "-",
  home,
  platform: process.platform,
  installUrl: env.HEADLONG_INSTALL_URL || "https://raw.githubusercontent.com/wolfyy970/undercurrent/main/install.mjs",
});
process.exitCode = code;
