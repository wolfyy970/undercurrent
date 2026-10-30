import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stepPreview,
  loadTrajectory,
  windowTrajectory,
  MACHINERY_TYPES,
} from "../src/trajectory.ts";

function writeTraj(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hl-traj-"));
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

describe("stepPreview", () => {
  it("reasoning joins thought + cmd with ' | '", () => {
    expect(stepPreview({ type: "reasoning", thought: "look around", cmd: "ls -la" })).toBe("look around | ls -la");
  });
  it("reasoning collapses whitespace and truncates thought to 100 / cmd to 120", () => {
    const thought = "a ".repeat(200); // 400 chars pre-collapse
    const p = stepPreview({ type: "reasoning", thought, cmd: "x" });
    expect(p.startsWith("a a a")).toBe(true);
    expect(p.split(" | ")[0].length).toBe(100);
  });
  it("shell-output prefixes exit code", () => {
    expect(stepPreview({ type: "shell-output", exit: 0, stdout: "done" })).toBe("exit 0 · done");
    expect(stepPreview({ type: "shell-output", stdout: "no exit" })).toBe("no exit");
  });
  it("message prefixes sender", () => {
    expect(stepPreview({ type: "message", from: "jo", content: "hi there" })).toBe("jo: hi there");
  });
  it("trajectory shows root or parent", () => {
    expect(stepPreview({ type: "trajectory" })).toBe("root");
    expect(stepPreview({ type: "trajectory", parent_traj: "abcdef1234" })).toBe("<- parent: abcdef12");
  });
  it("fork and merge arrows", () => {
    expect(stepPreview({ type: "fork", child_ref: "aa-slug/trajectory.jsonl" })).toBe("-> aa-slug/trajectory.jsonl");
    expect(stepPreview({ type: "merge", content: "brought back" })).toBe("<- brought back");
  });
  it("falls back to content/thought for unknown types", () => {
    expect(stepPreview({ type: "thought", content: "idle musing" })).toBe("idle musing");
  });
});

describe("run grouping", () => {
  const dir = writeTraj([
    { type: "trajectory", step_id: "root", ts: "t0" },
    { type: "thought", source: "monolith", step_id: "th1", ts: "t1", content: "let me act" },
    { type: "shellm-run", step_id: "run1", ts: "t2", command: "shellm --model m1 ... ACTION: do a thing", model: "m1", launched_by: "monolith" },
    { type: "prompt", step_id: "p1", ts: "t3", run_id: "run1" },
    { type: "reasoning", step_id: "rs1", ts: "t4", run_id: "run1", thought: "thinking", cmd: "echo hi" },
    { type: "shell-output", step_id: "so1", ts: "t5", run_id: "run1", exit: 0, stdout: "hi" },
    { type: "run-summary", step_id: "sum1", ts: "t6", run_id: "run1", tldr: "did a thing" },
    { type: "final", step_id: "fin1", ts: "t7", run_id: "run1", content: "done" },
    { type: "thought", source: "monolith", step_id: "th2", ts: "t8", content: "after" },
  ]);
  const loaded = loadTrajectory(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates one run group with all machinery steps as members", () => {
    expect(loaded.runs).toHaveLength(1);
    const run = loaded.runs[0];
    expect(run.run_id).toBe("run1");
    expect(run.step_ids).toEqual(["run1", "p1", "rs1", "so1", "sum1", "fin1"]);
  });
  it("marks the run done at its final step and carries tldr + model", () => {
    const run = loaded.runs[0];
    expect(run.status).toBe("done");
    expect(run.ended_ts).toBe("t7");
    expect(run.tldr).toBe("did a thing");
    expect(run.model).toBe("m1");
    expect(run.launched_by).toBe("monolith");
  });
  it("stamps run_id only on machinery members, not on source-carrying steps", () => {
    const byId = Object.fromEntries(loaded.steps.map((s) => [s.step_id, s.run_id]));
    expect(byId["run1"]).toBe("run1");
    expect(byId["rs1"]).toBe("run1");
    expect(byId["th1"]).toBeNull();
    expect(byId["th2"]).toBeNull();
    expect(byId["root"]).toBeNull();
  });
  it("machinery types set is exactly the shellm loop step types", () => {
    expect([...MACHINERY_TYPES].sort()).toEqual(
      ["feedback", "final", "prompt", "reasoning", "run-summary", "shell-output", "shellm-run"],
    );
  });
});

describe("trigger join", () => {
  it("joins a run to the action step named by trigger_step", () => {
    const dir = writeTraj([
      { type: "action", source: "actor", step_id: "act1", ts: "t1", content: "go" },
      { type: "shellm-run", step_id: "run1", ts: "t2", command: "x", trigger_step: "act1" },
      { type: "final", step_id: "f1", ts: "t3", run_id: "run1" },
    ]);
    const loaded = loadTrajectory(dir);
    expect(loaded.runs[0].trigger_step_id).toBe("act1");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("fork + writeback links", () => {
  it("builds a writeback link from from_traj/from_step", () => {
    const dir = writeTraj([
      { type: "merge", step_id: "m1", ts: "t1", content: "back", from_traj: "childXYZ", from_step: "cs1" },
    ]);
    const loaded = loadTrajectory(dir);
    expect(loaded.steps[0].writeback).toEqual({ from_traj: "childXYZ", from_step: "cs1" });
    rmSync(dir, { recursive: true, force: true });
  });
  it("builds an (unresolved) fork link when the child dir is absent", () => {
    const dir = writeTraj([
      { type: "fork", step_id: "fk1", ts: "t1", child: "deadbeefcafef00d", child_ref: "deadbeef-slug/trajectory.jsonl" },
    ]);
    const loaded = loadTrajectory(dir);
    expect(loaded.steps[0].fork).toEqual({ child_traj_id: "deadbeefcafef00d", slug: "deadbeef-slug", resolved: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("command truncation", () => {
  it("truncates commands longer than head+tail+200 and keeps the full text in fullCommands", () => {
    const long = "H".repeat(900) + "M".repeat(5000) + "T".repeat(1300);
    const dir = writeTraj([{ type: "shellm-run", step_id: "run1", ts: "t1", command: long }]);
    const loaded = loadTrajectory(dir);
    expect(loaded.runs[0].command_truncated).toBe(true);
    expect(loaded.runs[0].command).toContain("chars truncated");
    expect(loaded.runs[0].command.length).toBeLessThan(long.length);
    expect(loaded.normalizer.fullCommands.get("run1")).toBe(long);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("windowTrajectory", () => {
  const dir = writeTraj(
    Array.from({ length: 10 }, (_, i) => ({ type: "thought", source: "s", step_id: `s${i}`, ts: `t${i}`, content: `c${i}` })),
  );
  const loaded = loadTrajectory(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("tail=N returns the last N steps and echoes since=count-N", () => {
    const w = windowTrajectory(loaded, { tail: 3 });
    expect(w.since).toBe(7);
    expect(w.steps.map((s) => s.step_id)).toEqual(["s7", "s8", "s9"]);
    expect(w.step_count).toBe(10);
  });
  it("since=A returns steps[A:] and echoes since=A", () => {
    const w = windowTrajectory(loaded, { since: 8 });
    expect(w.since).toBe(8);
    expect(w.steps.map((s) => s.step_id)).toEqual(["s8", "s9"]);
  });
  it("since=A&until=B returns [A,B)", () => {
    const w = windowTrajectory(loaded, { since: 2, until: 5 });
    expect(w.steps.map((s) => s.step_id)).toEqual(["s2", "s3", "s4"]);
  });
  it("no params returns the whole log with since=null", () => {
    const w = windowTrajectory(loaded, {});
    expect(w.since).toBeNull();
    expect(w.steps).toHaveLength(10);
  });
});

// PORT-NOTE (1c: f68c1d8): ported from test_trajectory.py::test_reply_inherits_message_source_url.
describe("chat message source_url inheritance", () => {
  it("a reply inherits the source_url of the message it answers; unrelated messages get null", () => {
    const sourceUrl = "https://laudesters.slack.com/archives/C1/p1788451200123456";
    const dir = writeTraj([
      { type: "message", step_id: "m1", ts: "t1", source: "chat", content: "please check this", from: "slack-U1-C1", to: "audel", source_url: sourceUrl },
      { type: "message", step_id: "m2", ts: "t2", source: "chat", content: "done", from: "audel", to: "slack-U1-C1", reply_to: "m1" },
      { type: "message", step_id: "m3", ts: "t3", source: "chat", content: "unrelated", from: "audel", to: "pwa-nick" },
    ]);
    const loaded = loadTrajectory(dir);
    const byId = Object.fromEntries(loaded.steps.map((s) => [s.step_id, s]));
    expect(byId["m1"]!.source_url).toBe(sourceUrl);
    expect(byId["m2"]!.source_url).toBe(sourceUrl);
    expect(byId["m3"]!.source_url).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

// PORT-NOTE (1c: c647609): ported from test_trajectory.py::test_file_bytes_stripped_from_dashboard_raw.
describe("wireRaw: content_b64 stripped from the dashboard raw copy", () => {
  it("drops content_b64 but keeps filename/content", () => {
    const dir = writeTraj([
      {
        type: "message",
        step_id: "s1",
        ts: "2026-01-01T00:00:00+0000",
        filename: "note.txt",
        content: "hello file",
        content_b64: "aGVsbG8gZmlsZQo=",
        from: "audel",
        to: "slack-U1-C1",
        source: "chat",
      },
    ]);
    const loaded = loadTrajectory(dir);
    const step = loaded.steps[0]!;
    expect(step.raw!["filename"]).toBe("note.txt");
    expect(step.raw!["content"]).toBe("hello file");
    expect("content_b64" in step.raw!).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a step with no content_b64 untouched", () => {
    const dir = writeTraj([{ type: "thought", step_id: "s1", ts: "t1", content: "idle musing" }]);
    const loaded = loadTrajectory(dir);
    expect(loaded.steps[0]!.raw).toEqual({ type: "thought", step_id: "s1", ts: "t1", content: "idle musing" });
    rmSync(dir, { recursive: true, force: true });
  });
});
