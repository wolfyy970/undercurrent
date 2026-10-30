#!/usr/bin/env bun
// status.mjs — port of status.sh (upstream @ 5458fee). Read-only: prints
// what Headlong-TS has on this machine and what is running, then exits.
//
//   curl -fsSL <url>/status.mjs | node -
//   node status.mjs                 (from a checkout)
//
// No prompts, nothing changed, no network.
//
// PORT-NOTE: piped `node -` has no real file location for a relative
// import (see install.mjs's header PORT-NOTE for why). Unlike install.mjs,
// status.mjs has nothing to bootstrap — its job is only to report on
// whatever is ALREADY on this machine — so instead of importing itself, it
// locates a real headlong-ts checkout the same way status.sh's own APP_DIR
// discovery does ($HEADLONG_HOME/app_dir, then $HEADLONG_HOME/app) and
// imports src/status-lib.ts from THAT absolute path. If none is found, it
// prints the same "not installed" line status.sh prints in that case,
// without needing the module at all.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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

const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
  process.stdout.write(
    "status.sh — what Headlong-TS has on this machine, and what is running.\n\n" +
      "  curl -fsSL <url>/status.mjs | node -\n" +
      "  node status.mjs                 (from a checkout)\n\n" +
      "Read-only: prints and exits. No prompts, nothing changed, no network.\n"
  );
  process.exit(0);
}
if (argv.length > 0) {
  process.stderr.write("status.mjs takes no options (try --help)\n");
  process.exit(1);
}

const env = { ...process.env };
const home = env.HOME ?? os.homedir();
const headlongHome = env.HEADLONG_HOME || path.join(home, ".headlong");
const appDir = findAppDirForImport(headlongHome, process.cwd());

if (!appDir && !fs.existsSync(headlongHome)) {
  process.stdout.write(`\nHeadlong status — ${new Date().toLocaleString()} on ${os.hostname()}\n\n==> Install\n  not installed (no ${headlongHome}, no checkout found)\n`);
  process.exit(0);
}
if (!appDir) {
  process.stderr.write(`status.mjs: error: found ${headlongHome} but no headlong-ts checkout (no bin/identity.mjs) to load status-lib.ts from\n`);
  process.exit(1);
}

const { runStatus, realStatusIO } = await import(pathToFileURL(path.join(appDir, "src", "status-lib.ts")));
const code = runStatus(env, realStatusIO(), process.cwd());
process.exitCode = code;
