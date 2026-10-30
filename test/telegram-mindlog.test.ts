// telegram-mindlog.test.ts — no upstream Python test file exists for
// headlong_telegram.mindlog (it has no telegram/tests/test_mindlog.py; the
// module docstring says it was copied from headlong_slack.mindlog). These
// cases exercise the port directly against the documented behavior in the
// Python source (find_trajectory's info.txt/root_trajectory resolution,
// read_new's offset/truncation handling, follow's cursor persistence).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findTrajectory, readNew, follow } from "../src/telegram/mindlog.ts";
import { BridgeExit } from "../src/telegram/errors.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-mindlog-"));
}

describe("telegram mindlog", () => {
  describe("findTrajectory", () => {
    it("resolves via info.txt's root_trajectory prefix", () => {
      const identityDir = tmpDir();
      const trajDir = path.join(identityDir, "trajectories", "abcd1234-root");
      fs.mkdirSync(trajDir, { recursive: true });
      fs.writeFileSync(path.join(trajDir, "trajectory.jsonl"), "{}\n");
      fs.writeFileSync(
        path.join(identityDir, "info.txt"),
        "name=ada\nroot_trajectory=abcd1234-1111-2222-3333-444455556666\n",
      );
      expect(findTrajectory(identityDir)).toBe(path.join(trajDir, "trajectory.jsonl"));
    });

    it("falls back to any trajectory dir when info.txt has no root_trajectory", () => {
      const identityDir = tmpDir();
      const trajDir = path.join(identityDir, "trajectories", "only-one");
      fs.mkdirSync(trajDir, { recursive: true });
      fs.writeFileSync(path.join(trajDir, "trajectory.jsonl"), "{}\n");
      expect(findTrajectory(identityDir)).toBe(path.join(trajDir, "trajectory.jsonl"));
    });

    it("dies when no trajectory.jsonl exists anywhere", () => {
      const identityDir = tmpDir();
      fs.mkdirSync(path.join(identityDir, "trajectories"), { recursive: true });
      expect(() => findTrajectory(identityDir)).toThrow(BridgeExit);
    });
  });

  describe("readNew", () => {
    it("reads only complete lines and returns the byte offset of the last newline", () => {
      const file = path.join(tmpDir(), "t.jsonl");
      fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3'); // trailing line incomplete (no newline)
      const { steps, newOffset } = readNew(file, 0);
      expect(steps).toEqual([{ a: 1 }, { a: 2 }]);
      expect(newOffset).toBe(Buffer.byteLength('{"a":1}\n{"a":2}\n'));
    });

    it("skips corrupt lines", () => {
      const file = path.join(tmpDir(), "t.jsonl");
      fs.writeFileSync(file, '{"a":1}\nnot json\n{"a":2}\n');
      const { steps } = readNew(file, 0);
      expect(steps).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("returns nothing new when offset already equals the file size", () => {
      const file = path.join(tmpDir(), "t.jsonl");
      fs.writeFileSync(file, '{"a":1}\n');
      const size = fs.statSync(file).size;
      const { steps, newOffset } = readNew(file, size);
      expect(steps).toEqual([]);
      expect(newOffset).toBe(size);
    });
  });

  describe("follow", () => {
    it("starts at EOF (no replay) and yields only newly appended steps", async () => {
      const dir = tmpDir();
      const file = path.join(dir, "t.jsonl");
      fs.writeFileSync(file, '{"pre":true}\n'); // must NOT be yielded
      const cursor = path.join(dir, "cursor");

      let ticks = 0;
      const seen: Array<Record<string, unknown>> = [];
      const shouldStop = () => ticks >= 2;
      const sleep = async () => {
        ticks += 1;
        if (ticks === 1) fs.appendFileSync(file, '{"post":true}\n');
      };

      for await (const step of follow(file, cursor, { shouldStop, sleep })) {
        seen.push(step);
      }
      expect(seen).toEqual([{ post: true }]);
      expect(fs.readFileSync(cursor, "utf8")).toBe(`${fs.statSync(file).size} ${fs.realpathSync(file)}`);
    });

    it("resumes from a persisted cursor file", async () => {
      const dir = tmpDir();
      const file = path.join(dir, "t.jsonl");
      fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
      const cursor = path.join(dir, "cursor");
      fs.writeFileSync(cursor, String(Buffer.byteLength('{"a":1}\n')));

      const seen: Array<Record<string, unknown>> = [];
      const shouldStop = () => seen.length >= 1;
      for await (const step of follow(file, cursor, { shouldStop, sleep: async () => {} })) {
        seen.push(step);
        break;
      }
      expect(seen).toEqual([{ b: 2 }]);
    });

    it("falls back to EOF when the cursor file is not a valid integer", async () => {
      const dir = tmpDir();
      const file = path.join(dir, "t.jsonl");
      fs.writeFileSync(file, '{"a":1}\n');
      const cursor = path.join(dir, "cursor");
      fs.writeFileSync(cursor, "not-a-number");

      let ticks = 0;
      const seen: Array<Record<string, unknown>> = [];
      const shouldStop = () => ticks >= 1;
      const sleep = async () => {
        ticks += 1;
      };
      for await (const step of follow(file, cursor, { shouldStop, sleep })) {
        seen.push(step);
      }
      expect(seen).toEqual([]); // pre-existing line not replayed
    });
  });
});

function appendLine(file: string, obj: unknown): void {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

// ---- 2e39a3f: a shrunk file is a different log; cursor names its trajectory.
describe("telegram mindlog — no replay (upstream 2026-09-09)", () => {
  async function nextStep(traj: string, cursor: string, after: () => void): Promise<Record<string, unknown>> {
    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      if (ticks === 1) after();
    };
    const gen = follow(traj, cursor, { shouldStop: () => ticks >= 3, sleep });
    const r = await gen.next();
    await gen.return(undefined);
    return r.value as Record<string, unknown>;
  }

  it("read_new does not replay a rebuilt file", () => {
    const traj = path.join(tmpDir(), "trajectory.jsonl");
    appendLine(traj, { content: "a" });
    appendLine(traj, { content: "b" });
    const { newOffset: off } = readNew(traj, 0);
    fs.writeFileSync(traj, '{"content": "fresh"}\n');
    const r = readNew(traj, off);
    expect(r.steps).toEqual([]);
    expect(r.newOffset).toBe(fs.statSync(traj).size);
    appendLine(traj, { content: "after" });
    expect(readNew(traj, r.newOffset).steps.map((s) => s.content)).toEqual(["after"]);
  });

  it("follow ignores a cursor from another trajectory and rewrites it with its own path", async () => {
    const dir = tmpDir();
    const other = path.join(dir, "other.jsonl");
    fs.writeFileSync(other, "x\n");
    const traj = path.join(dir, "trajectory.jsonl");
    for (let i = 0; i < 50; i++) appendLine(traj, { content: `old ${i}` });
    const cursor = path.join(dir, "cursor");
    fs.writeFileSync(cursor, `2 ${fs.realpathSync(other)}`);
    const step = await nextStep(traj, cursor, () => appendLine(traj, { content: "new" }));
    expect(step.content).toBe("new");
    expect(fs.readFileSync(cursor, "utf8").split(/\s+/)[1]).toBe(fs.realpathSync(traj));
  });

  it("follow honours its own cursor", async () => {
    const dir = tmpDir();
    const traj = path.join(dir, "trajectory.jsonl");
    appendLine(traj, { content: "seen" });
    const off = fs.statSync(traj).size;
    appendLine(traj, { content: "unseen" });
    const cursor = path.join(dir, "cursor");
    fs.writeFileSync(cursor, `${off} ${fs.realpathSync(traj)}`);
    expect((await nextStep(traj, cursor, () => {})).content).toBe("unseen");
  });

  it("follow honours a legacy offset-only cursor (but not one beyond the file)", async () => {
    const dir = tmpDir();
    const traj = path.join(dir, "trajectory.jsonl");
    appendLine(traj, { content: "seen" });
    const off = fs.statSync(traj).size;
    appendLine(traj, { content: "unseen" });
    const cursor = path.join(dir, "cursor");
    fs.writeFileSync(cursor, String(off));
    expect((await nextStep(traj, cursor, () => {})).content).toBe("unseen");
    fs.writeFileSync(cursor, "999999");
    expect((await nextStep(traj, cursor, () => appendLine(traj, { content: "later" }))).content).toBe("later");
  });
});
