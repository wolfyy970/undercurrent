import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIdentityActivity } from "../src/activity.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const ps = vi.mocked(spawnSync);
const idle = { active: false, thinkers: [] };
let identityDir: string;
let runDir: string;
const dispatcher = path.resolve(import.meta.dirname, "../bin/dispatcherd.mjs");

beforeEach(() => {
  ps.mockReset();
  identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-activity-"));
  runDir = path.join(identityDir, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, "dispatcher.pid"), "100");
});
afterEach(() => fs.rmSync(identityDir, { recursive: true, force: true }));

function snapshot(stdout: string, status = 0): void {
  ps.mockReturnValue({ stdout, stderr: "", status, signal: null, pid: 1, output: [null, stdout, ""] });
}

describe("conservative activity inspection", () => {
  it("treats a missing identity and missing run records as idle without spawning ps", () => {
    expect(getIdentityActivity(path.join(identityDir, "missing"))).toEqual(idle);
    expect(getIdentityActivity(identityDir)).toEqual(idle);
    expect(ps).not.toHaveBeenCalled();
  });

  it("ignores enabled membership, pending work, wake times and freshly written trajectories", () => {
    fs.writeFileSync(path.join(runDir, "active_thinkers"), "monolith\nresponder\n");
    fs.mkdirSync(path.join(runDir, "pending"));
    fs.writeFileSync(path.join(runDir, "pending", "monolith.message.coalesced"), "{}");
    fs.writeFileSync(path.join(runDir, "monolith.wake_at"), "1");
    fs.mkdirSync(path.join(identityDir, "trajectories"));
    fs.writeFileSync(path.join(identityDir, "trajectories", "trajectory.jsonl"), "{}\n");
    expect(getIdentityActivity(identityDir)).toEqual(idle);
    expect(ps).not.toHaveBeenCalled();
  });

  it("returns only unique sorted verified thinker names, excluding zombie and reused step PIDs", () => {
    fs.writeFileSync(path.join(runDir, "step_pids"), "101 responder\n102 monolith\n103 responder\n104 zombie\n105 unrelated\n106 wrong-parent\n");
    snapshot([
      `100 1 Ss node ${dispatcher}`,
      `101 100 S node ${path.join(identityDir, "thinkers/responder/step")}`,
      `102 100 S node ${path.join(identityDir, "thinkers/monolith/step")}`,
      `103 100 S node ${path.join(identityDir, "thinkers/responder/step")}`,
      `104 100 Z node ${path.join(identityDir, "thinkers/zombie/step")}`,
      "105 100 S node unrelated-command",
      `106 1 S node ${path.join(identityDir, "thinkers/wrong-parent/step")}`,
    ].join("\n"));
    expect(getIdentityActivity(identityDir)).toEqual({ active: true, thinkers: ["monolith", "responder"] });
  });

  it.each(["", "100 1 Z node dead-dispatcher", "100 1 S node unrelated-command"])("requires a live matching dispatcher (%s)", (dispatcherLine) => {
    fs.writeFileSync(path.join(runDir, "step_pids"), "101 monolith\n");
    snapshot(`${dispatcherLine}\n101 100 S node ${path.join(identityDir, "thinkers/monolith/step")}`);
    expect(getIdentityActivity(identityDir)).toEqual(idle);
  });

  it("does not accept partial PID numbers or path traversal from corrupt ledger records", () => {
    fs.writeFileSync(path.join(runDir, "step_pids"), "101junk monolith\n0 monolith\n-1 monolith\n102 ../monolith\n103 ..\n104 responder extra\n");
    expect(getIdentityActivity(identityDir)).toEqual(idle);
    expect(ps).not.toHaveBeenCalled();
  });

  it("fails closed when process inspection fails", () => {
    fs.writeFileSync(path.join(runDir, "step_pids"), "101 monolith\n");
    snapshot("", 1);
    expect(getIdentityActivity(identityDir)).toEqual(idle);
    ps.mockReturnValue({ stdout: "", stderr: "", status: null, signal: null, pid: 0, output: [], error: new Error("ps unavailable") });
    expect(getIdentityActivity(identityDir)).toEqual(idle);
  });
});
