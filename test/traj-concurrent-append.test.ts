// traj-concurrent-append.test.ts — RUNTIME-SEAMS.md §C row "traj lock" /
// §D priority #6: proves the mkdir-based append lock in src/trajCore.mjs
// (`withLock`, faithful to bin/traj:544-559) actually serializes writers
// across REAL OS processes, not just in-process call order.
//
// Spawns 8 real `bin/traj.mjs append` child processes racing on one
// trajectory.jsonl file and asserts every line lands intact (valid JSON,
// exactly 8 lines, one per process). A second describe block repeats the
// exact same race against the REAL upstream `bin/traj append` (Bash) when
// PARITY_UPSTREAM_ROOT is set, so the port's behavior under contention is
// compared against the oracle it was ported from — skipped cleanly (never
// a faked pass) when no upstream checkout is configured, same discipline
// as every parity/* harness in this repo.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TRAJ_MJS = path.join(HERE, "..", "bin", "traj.mjs");
const N = 8;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: "ignore" });
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: -1 }));
  });
}

function makeTrajDir(): { dir: string; id: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traj-race-"));
  const id = "raceid";
  fs.mkdirSync(path.join(dir, id));
  fs.writeFileSync(path.join(dir, id, "trajectory.jsonl"), "");
  return { dir, id, file: path.join(dir, id, "trajectory.jsonl") };
}

/** Every non-empty line parses as JSON, there are exactly N of them, and
 *  the idx field (stringified 0..N-1) covers every writer exactly once —
 *  proves no interleaved/corrupt line and no lost write. */
function assertIntactAndComplete(fileContent: string, n: number): void {
  const lines = fileContent.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(n);
  const idxs = new Set<string>();
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line); // throws on any interleaved/corrupt line
    expect(parsed).toHaveProperty("type", "note");
    expect(parsed).toHaveProperty("idx");
    idxs.add((parsed as { idx: string }).idx);
  }
  expect(idxs).toEqual(new Set(Array.from({ length: n }, (_, i) => String(i))));
}

describe("trajectory.jsonl append lock — 8 real bin/traj.mjs append processes racing on one file", () => {
  it("every line lands intact JSON; all 8 writers land exactly once", async () => {
    const { dir, id, file } = makeTrajDir();
    const env = { ...process.env, TRAJ_DIR: dir, TRAJ_ID: id };

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        run(process.execPath, [TRAJ_MJS, "append", "--field", "type=note", "--field", `idx=${i}`], env)
      )
    );
    for (const r of results) expect(r.code).toBe(0);

    assertIntactAndComplete(fs.readFileSync(file, "utf8"), N);
  }, 20000);
});

describe.skipIf(!process.env["PARITY_UPSTREAM_ROOT"])(
  "same race against the real upstream bin/traj append (Bash oracle, PARITY_UPSTREAM_ROOT)",
  () => {
    const upstreamRoot = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
    const upstreamTraj = path.join(upstreamRoot, "bin", "traj");

    it("upstream also lands every line intact under the identical 8-process race", async () => {
      const { dir, id, file } = makeTrajDir();
      const env = { ...process.env, TRAJ_DIR: dir, TRAJ_ID: id };

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          run("bash", [upstreamTraj, "append", "--field", "type=note", "--field", `idx=${i}`], env)
        )
      );
      for (const r of results) expect(r.code).toBe(0);

      assertIntactAndComplete(fs.readFileSync(file, "utf8"), N);
    }, 20000);
  }
);
