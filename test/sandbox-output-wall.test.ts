// sandbox-output-wall.test.ts — upstream sync 2e39a3f: the two extra watchdog
// guards (SHELLM_MAX_OUTPUT_SIZE → killReason "output", SHELLM_MAX_EXEC_TIME →
// "wall") and the head/tail keep-bytes cut of a runaway block.
//
// Oracle: upstream's own tests/test_output_size_watchdog.sh — a continuous
// producer is killed even though it resets both silence timers, a bounded
// producer under the limit (or limit 0) finishes, an endless tiny heartbeat is
// only stopped by the wall clock, and the producer is dead (stops writing)
// before the call returns. Real subprocesses, real timing, scaled down.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSandbox, OUTPUT_KEEP_BYTES } from "../src/sandbox.ts";

const wd = () => fs.mkdtempSync(path.join(os.tmpdir(), "outwall-"));
const env = { PATH: process.env["PATH"] ?? "" };

describe("LocalSandbox — output-size and wall-clock guards", () => {
  it(
    "a runaway producer is killed at maxOutputBytes and has stopped writing on return",
    async () => {
      const dir = wd();
      const r = await new LocalSandbox().exec({
        workdir: dir,
        wrappedCode:
          'echo $$ > producer.pid; end=$((SECONDS+10)); while [ $SECONDS -lt $end ]; do printf "x%.0s" {1..1000}; echo; echo tick >> heartbeat; sleep 0.05; done; echo completed > completed\n',
        env,
        inactivityTimeoutMs: 600_000,
        timeoutMs: 600_000,
        maxOutputBytes: 50_000,
      });
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("output");
      const pid = Number(fs.readFileSync(path.join(dir, "producer.pid"), "utf8"));
      expect(pid).toBeGreaterThan(1);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      const before = fs.readFileSync(path.join(dir, "heartbeat"), "utf8").split("\n").length;
      await new Promise((res) => setTimeout(res, 300));
      expect(fs.readFileSync(path.join(dir, "heartbeat"), "utf8").split("\n").length).toBe(before);
      expect(fs.existsSync(path.join(dir, "completed"))).toBe(false);
    },
    30_000
  );

  for (const limit of [0, 10_485_760]) {
    it(
      `limit ${limit} lets bounded output finish`,
      async () => {
        const dir = wd();
        const r = await new LocalSandbox().exec({
          workdir: dir,
          wrappedCode: 'end=$((SECONDS+2)); while [ $SECONDS -lt $end ]; do printf "x%.0s" {1..1000}; echo; sleep 0.05; done; echo completed > completed\n',
          env,
          inactivityTimeoutMs: 600_000,
          timeoutMs: 600_000,
          maxOutputBytes: limit,
        });
        expect(r.timedOut).toBe(false);
        expect(r.killReason).toBeUndefined();
        expect(fs.existsSync(path.join(dir, "completed"))).toBe(true);
      },
      30_000
    );
  }

  it(
    "an output kill keeps only the two ends, with a dropped-bytes marker",
    async () => {
      const r = await new LocalSandbox().exec({
        workdir: wd(),
        // ~20 MB/s of numbered lines: far past 2 * OUTPUT_KEEP_BYTES at the first poll.
        wrappedCode: "i=0; while :; do echo \"line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; i=$((i+1)); done\n",
        env,
        inactivityTimeoutMs: 600_000,
        timeoutMs: 600_000,
        maxOutputBytes: 1_000_000,
      });
      expect(r.killReason).toBe("output");
      expect(r.output).toMatch(/\n\[\.\.\. \d+ bytes of output dropped \.\.\.\]\n/);
      expect(r.output.startsWith("line-0-")).toBe(true);
      // The kept ends are bounded (head + tail ≤ 2 × keep, plus the marker).
      expect(Buffer.byteLength(r.output)).toBeLessThan(OUTPUT_KEEP_BYTES * 2 + 200);
    },
    30_000
  );

  it(
    "an endless tiny heartbeat is killed only by the wall clock (maxExecMs)",
    async () => {
      const dir = wd();
      const t0 = Date.now();
      const r = await new LocalSandbox().exec({
        workdir: dir,
        wrappedCode: 'echo $$ > producer.pid; while :; do echo "... waiting"; sleep 1; done\n',
        env,
        inactivityTimeoutMs: 600_000,
        timeoutMs: 600_000,
        maxExecMs: 3000,
      });
      expect(r.killReason).toBe("wall");
      expect(r.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(15_000);
      const pid = Number(fs.readFileSync(path.join(dir, "producer.pid"), "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    30_000
  );
});
