#!/usr/bin/env bun
// uninstall.mjs — port of uninstall.sh (upstream @ 5458fee), the reverse of
// install.mjs.
//
//   curl -fsSL <url>/uninstall.mjs | node -
//   node uninstall.mjs [options]            (from a checkout)
//   node install.mjs --uninstall            (same thing)
//
// See uninstall.mjs --help for options.
//
// PORT-NOTE: same real-checkout-discovery + absolute dynamic import as
// status.mjs (see its header PORT-NOTE) — `curl uninstall.mjs | node -`
// works from any cwd, not only from inside a checkout.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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

function findAppDirForImport(headlongHome, cwd) {
  const self = resolveSelfDir(process.argv[1] ?? "-");
  if (self && isCheckout(self)) return self;
  let recorded = "";
  try {
    recorded = fs.readFileSync(path.join(headlongHome, "app_dir"), "utf8").trim();
  } catch {
    /* not recorded */
  }
  if (recorded && isCheckout(recorded)) return recorded;
  const appSub = path.join(headlongHome, "app");
  if (isCheckout(appSub)) return appSub;
  if (isCheckout(cwd)) return cwd;
  return undefined;
}

const env = { ...process.env };
const home = env.HOME ?? os.homedir();
const headlongHome = env.HEADLONG_HOME || path.join(home, ".headlong");
const appDir = findAppDirForImport(headlongHome, process.cwd());

if (!appDir) {
  // uninstall.sh still works with no checkout at all (PREFIX-only cleanup) —
  // matches uninstall-lib.ts's own findAppDir/appIsOurs handling of an
  // undefined appDir. A minimal self-contained fallback keeps that property
  // for the piped-with-nothing-cloned-anywhere case.
  const prefix = env.PREFIX || path.join(home, ".local", "bin");
  process.stdout.write(`Nothing to do: no Headlong-TS install found (looked in ${headlongHome}, ${prefix}).\n`);
  process.exit(0);
}

const { runUninstall } = await import(pathToFileURL(path.join(appDir, "src", "uninstall-lib.ts")));

/** @type {import("./src/uninstall-lib.ts").UninstallIO} */
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
  listProcesses: () => {
    const r = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    return (r.stdout || "").split("\n").filter((l) => l.trim());
  },
  selfPid: () => process.pid,
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

const code = await runUninstall({
  argv: process.argv.slice(2),
  env,
  io,
  home,
  cwd: process.cwd(),
  now: () => new Date(),
});
process.exitCode = code;
