// slack-mindlog.test.ts — port of headlong/slack/tests/test_mindlog.py.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findTrajectory, readNew, follow } from "../src/slack/mindlog.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sl-mindlog-"));
}

function append(file: string, obj: unknown, newline = true): void {
  fs.appendFileSync(file, JSON.stringify(obj) + (newline ? "\n" : ""));
}

describe("slack mindlog", () => {
  it("read_new only complete lines", () => {
    const traj = path.join(tmpDir(), "trajectory.jsonl");
    fs.writeFileSync(traj, "");
    let { steps, newOffset: off } = readNew(traj, 0);
    expect(steps).toEqual([]);
    expect(off).toBe(0);

    append(traj, { type: "message", content: "one" });
    ({ steps, newOffset: off } = readNew(traj, off));
    expect(steps.map((s) => s.content)).toEqual(["one"]);

    // Partial line is not consumed until its newline arrives.
    fs.appendFileSync(traj, '{"type": "message", "content": "tw');
    let off2: number;
    ({ steps, newOffset: off2 } = readNew(traj, off));
    expect(steps).toEqual([]);
    expect(off2).toBe(off);
    fs.appendFileSync(traj, 'o"}\n');
    ({ steps, newOffset: off } = readNew(traj, off));
    expect(steps.map((s) => s.content)).toEqual(["two"]);
  });

  it("read_new skips corrupt lines", () => {
    const traj = path.join(tmpDir(), "trajectory.jsonl");
    fs.writeFileSync(traj, 'not json\n{"type": "message", "content": "ok"}\n');
    const { steps } = readNew(traj, 0);
    expect(steps.map((s) => s.content)).toEqual(["ok"]);
  });

  it("find_trajectory", () => {
    const identity = path.join(tmpDir(), "audel");
    const trajDir = path.join(identity, "trajectories", "deadbeef-mind");
    fs.mkdirSync(trajDir, { recursive: true });
    fs.writeFileSync(path.join(trajDir, "trajectory.jsonl"), "");
    fs.writeFileSync(
      path.join(identity, "info.txt"),
      "name=audel\nroot_trajectory=deadbeef-1234-5678-9abc-def012345678\n",
    );
    expect(findTrajectory(identity)).toBe(path.join(trajDir, "trajectory.jsonl"));
  });

  it("follow creates missing cursor parent", async () => {
    // outbound used to FileNotFoundError if state_dir vanished mid-run.
    // follow() starts at EOF when the cursor file is missing, so the new
    // line has to arrive *after* the generator has taken its initial offset.
    const dir = tmpDir();
    const traj = path.join(dir, "trajectory.jsonl");
    fs.writeFileSync(traj, "");
    const cursor = path.join(dir, "missing-state", "cursor");
    expect(fs.existsSync(path.dirname(cursor))).toBe(false);

    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      if (ticks === 1) append(traj, { content: "hello" });
    };
    const shouldStop = () => ticks >= 2;

    const gen = follow(traj, cursor, { shouldStop, sleep });
    const { value: step } = await gen.next();
    expect((step as Record<string, unknown>).content).toBe("hello");
    expect(fs.statSync(cursor).isFile()).toBe(true);
    expect(fs.statSync(path.dirname(cursor)).isDirectory()).toBe(true);
    await gen.return(undefined);
  });
});

function appendLine(file: string, obj: unknown): void {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

// ---- 2e39a3f: a shrunk file is a different log; cursor names its trajectory.
describe("slack mindlog — no replay (upstream 2026-09-09)", () => {
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
