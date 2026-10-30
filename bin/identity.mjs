#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/identity.mjs — `identity new [--default] [--memories DIR] <name>` and
// `identity list [-a]` (PLAN-daemon §5). No build step: Node strips the .ts
// import on the fly.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  identityNew,
  identityList,
  identityImport,
  ImportError,
  resolveExportDirs,
  buildIdentityExportArchive,
  defaultExportOutName,
  ExportError,
} from "../src/identity.ts";
import { readStdinBytesSync } from "../src/stdin.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

async function die(msg) {
  process.stderr.write(`${msg}\n`);
  await exitAfterDrain(1);
}

const argv = process.argv.slice(2);
const cmd = argv.shift();

if (cmd === "export") {
  const HELP = `Usage: identity export [names...] [--all] [--path DIR] [-o FILE|-] [--soul-only] [--slim]

Package one or more identities into a portable .tgz for \`identity import\`
(same machine or another one). Excludes runtime state (run/, .shellm/),
regenerated files (kernel/, activate), and secrets (.env).

  names          Identities to export (default: the default identity)
  --all          Export every identity under IDENTITY_DIR
  --path DIR     Export the identity directory at DIR (repeatable)
  -o FILE        Output file (default: <name>-<timestamp>.shellm.tgz; - for stdout)
  --soul-only    Skip trajectories/ — memories, thinkers, and skills only
  --slim         Shrink trajectories for sharing: truncate the repeated
                 shellm-run command line and prompt context, redact API keys
`;
  let out;
  let soulOnly = false;
  let slim = false;
  let all = false;
  const names = [];
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      await exitAfterDrain(0);
    } else if (a === "-o" || a === "--output") {
      out = argv[++i];
      if (!out) await die("export: -o requires a file argument");
    } else if (a === "--soul-only") {
      soulOnly = true;
    } else if (a === "--slim") {
      slim = true;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--path") {
      const p = argv[++i];
      if (!p) await die("export: --path requires a directory argument");
      paths.push(p);
    } else if (a.startsWith("-") && a !== "-") {
      await die(`export: unknown option: ${a}`);
    } else {
      names.push(a);
    }
  }

  const identitiesRoot = process.env.IDENTITY_DIR;
  if (!identitiesRoot) await die("identity: IDENTITY_DIR (the identities root) is not set");

  let dirs;
  let buffer;
  try {
    dirs = resolveExportDirs(identitiesRoot, { names, all, paths });
    buffer = buildIdentityExportArchive({ dirs, soulOnly, slim });
  } catch (err) {
    if (err instanceof ExportError) await die(err.message);
    await die(`identity: error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const outPath = out ?? defaultExportOutName(dirs);
  if (outPath === "-") {
    process.stdout.write(buffer);
  } else {
    fs.writeFileSync(outPath, buffer);
    const n = dirs.length;
    process.stderr.write(`Exported ${n} identit${n === 1 ? "y" : "ies"} -> ${outPath}\n`);
  }
  await exitAfterDrain(0);
}

if (cmd === "import") {
  let archive;
  let newName;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") {
      newName = argv[++i];
      if (!newName) await die("import: --name requires a name argument");
    } else if (a.startsWith("-") && a !== "-") {
      await die(`import: unknown option: ${a}`);
    } else if (archive === undefined) {
      archive = a;
    } else {
      await die("Usage: identity import <file|-> [--name NEW]");
    }
  }
  if (!archive) await die("Usage: identity import <file|-> [--name NEW]");

  const identitiesRoot = process.env.IDENTITY_DIR;
  if (!identitiesRoot) await die("identity: IDENTITY_DIR (the identities root) is not set");

  let archivePath = archive;
  let stagingDir;
  if (archive === "-") {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-import-"));
    archivePath = path.join(stagingDir, "stdin.tgz");
    fs.writeFileSync(archivePath, readStdinBytesSync());
  } else if (!fs.existsSync(archive)) {
    await die(`import: no such file: ${archive}`);
  }

  try {
    const result = identityImport({ identitiesRoot, archivePath, name: newName });
    for (const name of result.imported) process.stdout.write(`${name}\n`);
    process.stderr.write(result.stderr);
  } catch (err) {
    if (err instanceof ImportError) await die(err.message);
    await die(`identity: error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  await exitAfterDrain(0);
}

if (cmd === "list") {
  // tools/identity cmd_list: only leading -a/--all are consumed; the first
  // non-flag arg stops parsing and everything after it is silently ignored.
  let showDir = false;
  while (argv.length > 0 && (argv[0] === "-a" || argv[0] === "--all")) {
    showDir = true;
    argv.shift();
  }

  const identitiesRoot = process.env.IDENTITY_DIR;
  if (!identitiesRoot) await die("identity: IDENTITY_DIR (the identities root) is not set");

  const { entries } = identityList(identitiesRoot);
  if (entries.length === 0) {
    process.stderr.write("No identities.\n");
  } else {
    for (const e of entries) {
      const marker = e.isDefault ? "*" : " ";
      const namePadded = e.name.padEnd(20);
      process.stdout.write(showDir ? `${marker} ${namePadded} ${e.created}  ${e.absDir}\n` : `${marker} ${namePadded} ${e.created}\n`);
    }
  }
  await exitAfterDrain(0);
}

// PORT-NOTE (bug #41): upstream tools/identity's main() dispatch treats an
// ABSENT command (bare `identity`, argv=[]) as its own case — `local
// cmd="${1:-}"` then `case "$cmd" in ... "") usage ;; ...` — printing the
// full top-level usage banner to stdout and exiting 0 (tools/identity:1508
// -1543 `usage()`, :1621-1622). It is distinct from an UNKNOWN command
// (which dies with "Unknown command: $cmd", exit 1) and from `new`'s own
// missing-<name> usage error. Before this fix, bare `identity` fell through
// into the `new` handler below and got that command's own usage error
// instead (wrong text, wrong exit code — see
// parity/fuzz/findings/identity-1.md).
// PORT-NOTE (bug #49): upstream tools/identity's main() parses global flags
// (including -h|--help) in a loop BEFORE the `cmd` case switch even runs
// (tools/identity:1550-1573) — `-h|--help` calls the same `usage()` as bare
// `identity` (banner to stdout, exit 0). The port only special-cased an
// ABSENT cmd (bug #41 above); "-h"/"--help" as the first arg fell through
// as an unrecognized `cmd` into the `new` dispatch guard below, printing
// `new`'s one-line usage error to stderr with exit 1 instead.
if (cmd === undefined || cmd === "-h" || cmd === "--help") {
  process.stdout.write(`identity — Identity management

Usage:
  identity new <name> [--default] [--memories DIR]  Create a new identity
  identity list [-a]         List all identities (-a: show directories)
  identity info [name] [-n|-p]  Show identity info (default: default; -n: name, -p: dir)
  identity sync-kernel [name|--all]  Symlink bundled kernel skills into identities
  identity sync-thinkers [name|--all]  Bootstrap new + retire deleted bundled thinkers
  identity default [name]     Show or set the default identity
  identity delete <name>     Delete an identity
  identity export [names...] [--all] [--path DIR] [-o FILE|-] [--soul-only]
                             Package identities into a portable .tgz
  identity import <file|-> [--name NEW]
                             Install identities from an export archive
  identity shell [name]      Start a subshell with identity env vars set
  identity prompt            Assemble and print the system prompt

Options:
  --dir DIR          Override identities directory (default: .identities)
  -v, --verbose      Verbose/debug mode
  -h, --help         Show help
  --version          Show version

Environment:
  IDENTITY_DIR   Override identities directory (default: .identities)

Activation:
  identity shell headlong               # start a subshell with env vars set
  exit                                   # leave the subshell
  source .identities/headlong/activate   # activate in current shell (no subshell)
  deactivate_identity                    # undo (when using source activate)
`);
  await exitAfterDrain(0);
}

if (cmd !== "new") {
  await die(`Usage: identity new [--default] [--memories DIR] <name>`);
}

let setDefault = false;
let memoriesDir;
let name;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--default") {
    setDefault = true;
  } else if (a === "--memories") {
    memoriesDir = argv[++i];
    if (!memoriesDir) await die("--memories requires a directory argument");
  } else if (a.startsWith("-")) {
    await die(`Unknown option: ${a}`);
  } else if (name === undefined) {
    name = a;
  } else {
    await die("Usage: identity new [--default] [--memories DIR] <name>");
  }
}
if (!name) await die("Usage: identity new [--default] [--memories DIR] <name>");

const identitiesRoot = process.env.IDENTITY_DIR;
if (!identitiesRoot) await die("identity: IDENTITY_DIR (the identities root) is not set");

try {
  const result = identityNew({
    identitiesRoot,
    name,
    setDefault,
    ...(memoriesDir ? { memoriesDir } : {}),
  });
  process.stderr.write(`Created identity: ${result.name}\n`);
  if (result.defaultSet) process.stderr.write(`Set as default.\n`);
} catch (err) {
  await die(`identity: error: ${err instanceof Error ? err.message : String(err)}`);
}
