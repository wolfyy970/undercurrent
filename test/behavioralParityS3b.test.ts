// behavioralParityS3b.test.ts — stage 3b real-model findings. (2) the stall error step: bin/shellm:3447 gives the actual
// reason, the last exit code and the guidance sentence, writes `{type,content,run_id,reason}` (no `source`), prints a
// `<ISO> [shellm] STALL: ...` line on stderr (:3440), and a guard set to 0 is off (`-gt 0 &&`, :3427-3430).
import { describe, it, expect } from "vitest";
import { recordedModel } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runShellm } from "../src/shellm.ts";
import { createTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";

// Recorded real DeepSeek runs (test/fixtures/recordings/behavioralParity/s3b-*): the prompt sets a natural chore whose
// commands fail, and the guards stop the run. Fixed root: the recorded blocks name prompt-visible paths.
async function run(scenario: string, task: string, constants: Record<string, number>) {
  const root = `/tmp/uc-rec-s3b/${scenario}`;
  claimFixedRoot(root);
  const workdir = path.join(root, "wd");
  fs.mkdirSync(workdir, { recursive: true });
  const llm = recordedModel("behavioralParity", scenario);
  try {
    const traj = createTrajectory(root);
    const err: string[] = [];
    const res = await runShellm({
      trajectory: traj,
      llm,
      sandbox: new LocalSandbox(),
      systemPrompt: "You run bash for the user. Each reply is one ```bash block that is executed; set FINAL=\"...\" in a block to finish.",
      prompt: task,
      workdir,
      binDir: "/nonexistent/bin",
      execEnv: {},
      header: { command: "shellm", model: "m", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
      sleep: async () => {},
      io: { stdout: () => {}, stderr: (s: string) => void err.push(s) } as never,
      constants,
    });
    const steps = traj.read() as Array<Record<string, unknown>>;
    return { res, steps, err: err.join(""), trajId: traj.trajId };
  } finally {
    llm.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const GUIDE =
  "Likely the model output could not be turned into a working command (e.g. a malformed code fence). The run was aborted to stop a token-burning spin; investigate the last few reasoning/shell-output steps.";

describe("stage 3b (2): stall error step carries the real reason, like bin/shellm:3447", () => {
  it("repeat failure: names the reason and the last exit code, no `source`, same field set as upstream", async () => {
    const { res, steps, err, trajId } = await run(
      "s3b-repeat",
      "Wait for the readiness flag: run `test -f /tmp/uc-rec-s3b/flag/ready`. The check is flaky, so if it fails, rerun the identical command in your next reply, unchanged. Do not finish until it succeeds.",
      { maxRepeatFailures: 3, maxConsecutiveFailures: 10 }
    );
    expect(res.stopReason).toBe("stall");
    const e = steps.find((s) => s["type"] === "error")!;
    expect(e["content"]).toBe(`shellm killed this run: the agent stalled — submitted the same failing command 3 times in a row (last exit=1). ${GUIDE}`);
    expect(e["reason"]).toBe("stall");
    expect(Object.keys(e).filter((k) => !["step_id", "ts"].includes(k)).sort()).toEqual(["content", "reason", "run_id", "type"]);
    expect(err).toMatch(new RegExp(`\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z \\[shellm\\] STALL: agent submitted the same failing command 3 times in a row \\(last exit=1\\); aborting run ${trajId} to stop a spin\\.\\n`));
  });
  it("consecutive failures: its own reason text; a guard set to 0 is disabled", async () => {
    const { res, steps } = await run(
      "s3b-consecutive",
      "Check three exit codes, one per reply, in this order: run `bash -c 'exit 2'`, then in your next reply `bash -c 'exit 3'`, then in the reply after that `bash -c 'exit 4'`. Only after all three, finish.",
      { maxRepeatFailures: 0, maxConsecutiveFailures: 3 }
    );
    expect(res.stopReason).toBe("stall");
    const e = steps.find((s) => s["type"] === "error")!;
    expect(e["content"]).toBe(`shellm killed this run: the agent stalled — 3 commands in a row failed with no progress (last exit=4). ${GUIDE}`);
  });
});

import { activeGoalsSection } from "../src/personMemory.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

describe("stage 3b (3): the active-goals section renders like get_goals (thinkers/_lib/common.sh:303-335)", () => {
  it("one bullet per line: each body is `$(...)`-stripped of trailing newlines (a file ends in one)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3b-goals-"));
    try {
      const w = (n: string, t: string, body: string) =>
        fs.writeFileSync(path.join(dir, n), `---\ntype: ${t}\ncreated: 2026-10-27 01:00:00\nid: ${n.slice(0, 4)}\n---\n\n${body}`);
      w("aaaa-goal.md", "goal", "Write the guide.\n");
      w("bbbb-goal.md", "intention", "First line.\nSecond line.\n\n");
      const out = activeGoalsSection(dir, { now: () => Date.parse("2026-10-27T05:00:00Z") });
      expect(out).toBe("- [intention, 4h] First line.\nSecond line.\n- [goal, 4h] Write the guide.\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
