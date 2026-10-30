// feeder.test.ts — TrajFeeder: tail from EOF, complete-lines-only,
// partial-line stitching, truncation/replacement (no replay), ENOENT retry (PLAN-daemon §2, §8).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TrajFeeder } from "../src/feeder.ts";

const roots: string[] = [];
const feeders: TrajFeeder[] = [];
afterEach(() => {
  while (feeders.length) feeders.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmpFile(name = "trajectory.jsonl"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-feeder-"));
  roots.push(root);
  return path.join(root, name);
}

/**
 * Wait for `count` lines. `f`, when given, has `.poll()` called on every
 * iteration — the feeder's own header says fs.watch "coalesces on macOS and
 * can miss events; the tick cannot", so delivery is guaranteed by fs.watch OR
 * the daemon's 1s tick poll, not by fs.watch alone. Passing `f` here mirrors
 * that real guarantee instead of testing OS watch-event flakiness directly.
 */
async function pollLines(lines: string[], count: number, f?: TrajFeeder, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (lines.length >= count) return;
    f?.poll();
    await new Promise((r) => setTimeout(r, 10));
  }
  if (lines.length < count) throw new Error(`only got ${lines.length}/${count} lines: ${JSON.stringify(lines)}`);
}

describe("TrajFeeder", () => {
  it("opens at the CURRENT end of file — pre-existing content is never replayed", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start();
    fs.appendFileSync(file, '{"a":3}\n');
    await pollLines(lines, 1, f);
    expect(lines).toEqual(['{"a":3}']); // NOT the two pre-existing lines
  });

  it("emits only complete lines, stitching a partial tail across two writes", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start();

    fs.appendFileSync(file, '{"a":"hel');
    f.poll();
    expect(lines).toEqual([]); // no newline yet — must not emit a partial line

    fs.appendFileSync(file, 'lo"}\n{"b":2}\n');
    f.poll();
    expect(lines).toEqual(['{"a":"hello"}', '{"b":2}']);
  });

  it("a truncated file (size < offset) restarts at its END and reports a swap — history is never replayed (2e39a3f)", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "x".repeat(100) + "\n");
    const lines: string[] = [];
    const swaps: Array<{ oldSize: number; newSize: number }> = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l), onSwap: (e) => swaps.push(e) });
    feeders.push(f);
    f.start(); // offset = 101

    fs.writeFileSync(file, '{"fresh":true}\n'); // shorter than 101 — a truncation
    f.poll();
    expect(lines).toEqual([]); // tail -F would replay this; the swap detector does not
    expect(swaps).toEqual([{ oldIno: expect.any(Number), newIno: expect.any(Number), oldSize: 101, newSize: 15 }]);
    fs.appendFileSync(file, '{"live":1}\n');
    f.poll();
    expect(lines).toEqual(['{"live":1}']);
  });

  it("a file replaced by rename (new inode) is followed from its end, whatever its size (the 2026-09-12 grep -v > tmp && mv)", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"h":1}\n{"h":2}\n');
    const lines: string[] = [];
    let swapped = 0;
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l), onSwap: () => void swapped++ });
    feeders.push(f);
    f.start();
    fs.writeFileSync(`${file}.clean`, '{"h":1}\n{"h":2}\n{"h":3}\n{"h":4}\n'); // LONGER than the old file
    fs.renameSync(`${file}.clean`, file);
    f.poll();
    expect(swapped).toBe(1);
    expect(lines).toEqual([]);
    fs.appendFileSync(file, '{"live":1}\n');
    f.poll();
    expect(lines).toEqual(['{"live":1}']);
    f.poll();
    expect(swapped).toBe(1);
  });

  it("ENOENT (file not yet created) is retried on every poll, then picked up once it appears", async () => {
    const file = tmpFile("not-yet.jsonl");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start(); // absent — offset defaults to 0
    f.poll();
    expect(lines).toEqual([]);

    fs.writeFileSync(file, '{"born":1}\n');
    f.poll();
    expect(lines).toEqual(['{"born":1}']);
  });

  it("empty lines are never emitted", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start();
    fs.appendFileSync(file, '\n\n{"x":1}\n\n');
    f.poll();
    expect(lines).toEqual(['{"x":1}']);
  });

  it("a new line is eventually delivered via fs.watch and/or the tick poll", async () => {
    // The feeder's header is explicit that fs.watch alone is not the
    // contract (it "coalesces on macOS and can miss events; the tick
    // cannot") — delivery is guaranteed by watch-or-poll together, which is
    // what pollLines(..., f) exercises (mirroring the daemon's 1s tick).
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start();
    fs.appendFileSync(file, '{"watched":true}\n');
    await pollLines(lines, 1, f);
    expect(lines).toEqual(['{"watched":true}']);
  });

  it("close() stops further delivery", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    f.start();
    f.close();
    fs.appendFileSync(file, '{"after-close":1}\n');
    f.poll(); // must be a no-op post-close
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual([]);
  });

  it("multiple lines appended in one write are all delivered in order", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => lines.push(l) });
    feeders.push(f);
    f.start();
    fs.appendFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    f.poll();
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });
});
