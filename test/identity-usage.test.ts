// identity-usage.test.ts — bare `identity` (no subcommand at all) must print
// the full top-level usage banner to stdout and exit 0, matching upstream
// tools/identity's `main()` dispatch: `local cmd="${1:-}"` falls into the
// `"")  usage ;;` case (tools/identity:1621-1622), and `usage()`
// (tools/identity:1508-1543) cats the banner to stdout then `exit 0`.
//
// Expected bytes captured directly from upstream (bug #41 report,
// parity/fuzz/findings/identity-1.md):
//   mkdir -p /tmp/idtest/ids
//   IDENTITY_DIR=/tmp/idtest/ids <HEADLONG_ROOT>/tools/identity
// -> full banner on stdout, empty stderr, exit 0.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("bin/identity.mjs");

const EXPECTED_BANNER = `identity — Identity management

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
`;

describe("identity — bare invocation (no subcommand), bug #41", () => {
  it("prints the full usage banner to stdout and exits 0 (not new's usage error)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-id-bare-"));
    try {
      const idDir = path.join(root, "ids");
      fs.mkdirSync(idDir, { recursive: true });
      let stdout: string;
      let status = 0;
      try {
        stdout = execFileSync(process.execPath, [BIN], {
          env: { ...process.env, IDENTITY_DIR: idDir },
          encoding: "utf8",
        });
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string };
        status = e.status;
        stdout = e.stdout;
        throw new Error(`expected exit 0, got ${status}, stderr=${e.stderr}`);
      }
      expect(stdout).toBe(EXPECTED_BANNER);
      expect(status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
