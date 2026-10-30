// tool-coupling.test.ts — "tool-list-must-match" regression test, mirroring
// upstream's tests/test_thinker_tool_coupling.sh invariant for THIS port's
// installer/uninstaller/status/killall tool-list plumbing.
//
// Upstream's coupling test exists because a tool can exist in bin/ and be
// advertised by the stock prompt/README while silently disappearing from one
// of the places that enumerate it (observed with `focus`, upstream commit
// 12ca841's own header comment). Upstream's own fix for 12ca841 ("core: drop
// view, put, glob, sub, focus; the mind reads and edits in bash") is to trim
// the SAME five names out of every list at once: the persona, the shared
// thinker library, the dispatcher, the coupling test itself, install.sh,
// uninstall.sh, status.sh, and tools/headlong-killall — its commit message
// says the process-matching pattern "must match across the last three"
// (install/status/uninstall) and the killall script is their shared source
// of truth.
//
// This port's structure differs (uninstall-lib.ts imports TOOLS directly
// from install-lib.ts and PATTERNS directly from status-lib.ts, rather than
// hand-copying arrays into three separate files — see each file's own
// PORT-NOTE), which already guarantees install/status/uninstall agree by
// construction. What is NOT structurally guaranteed, and what this test
// guards, mirrors the actual regression class upstream's test catches:
//   1. a retired tool's name/argv-pattern silently reappearing in one of
//      these lists (e.g. a future revert or merge conflict resurrecting
//      `sub` in killall.ts's PATTERNS but not install-lib.ts's TOOLS), and
//   2. install-lib.ts's TOOLS drifting from what's actually shipped under
//      bin/ (a tool listed that was never shipped, or shipped but never
//      listed).
//
// PORT-NOTE (1c: 12ca841): written alongside the focus/glob/put/sub/view
// retirement — see PARITY.md "Retired: focus/glob/put/sub/view (1c: 12ca841)".

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/install-lib.ts";
import { PATTERNS as STATUS_PATTERNS } from "../src/status-lib.ts";
import { killall, type ProcEntry, type DockerListing } from "../src/killall.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The five tools upstream 12ca841 drops outright — "the mind reads and
 *  edits in bash" — and this port retires to match (lane 1c-f). */
const RETIRED = ["view", "put", "glob", "sub", "focus"] as const;

function emptyDockerListing(): DockerListing {
  return { shellmIds: [], shellmLines: [], brokerLines: [] };
}

describe("tool-list-must-match (mirrors upstream tests/test_thinker_tool_coupling.sh)", () => {
  it("install-lib's TOOLS (shared by uninstall-lib) never re-lists a retired tool", () => {
    for (const t of RETIRED) {
      expect(TOOLS as readonly string[]).not.toContain(t);
    }
  });

  it("every name in install-lib's TOOLS resolves to a real bin/<name> or bin/<name>.mjs in this checkout", () => {
    for (const t of TOOLS) {
      const bare = path.join(REPO_ROOT, "bin", t);
      const mjs = `${bare}.mjs`;
      const ok = fs.existsSync(bare) || fs.existsSync(mjs);
      expect(ok, `TOOLS entry "${t}" has no bin/${t} or bin/${t}.mjs on disk`).toBe(true);
    }
  });

  it("status-lib's PATTERNS (shared by uninstall-lib) never matches a retired tool's bin/<name>.mjs", () => {
    for (const t of RETIRED) {
      const probe = `node /fake/repo/bin/${t}.mjs`;
      expect(STATUS_PATTERNS.some((re) => re.test(probe)), `status-lib PATTERNS matched retired tool "${t}"`).toBe(false);
    }
  });

  it("killall's PATTERNS never match a retired tool's bin/<name>.mjs, but still match a shipped tool (chat.mjs)", async () => {
    const fakeSnapshot: ProcEntry[] = [
      ...RETIRED.map((t, i) => ({ pid: 900_001 + i, ppid: 1, command: `/fake/repo/bin/${t}.mjs` })),
      { pid: 900_999, ppid: 1, command: "/fake/repo/bin/chat.mjs" },
    ];
    let out = "";
    // dry-run: killall never signals these fabricated pids, only reports how
    // many it WOULD kill (result.killed is always [] in dry-run — see
    // src/killall.ts's `killed: dryRun ? [] : killedList` — and the per-pid
    // detail line is a real `ps -p <pid>` lookup that finds nothing for a
    // fabricated pid, so the match SET is read off the "Would kill N
    // process(es):" count instead: exactly 1 of these 6 candidates —
    // chat.mjs — should ever match).
    await killall({
      dryRun: true,
      psSnapshot: () => fakeSnapshot,
      dockerListing: emptyDockerListing,
      stdout: (s) => (out += s),
    });
    expect(out).toContain("Would kill 1 process(es):");
  });
});
