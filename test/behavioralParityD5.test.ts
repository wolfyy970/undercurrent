// behavioralParityD5.test.ts — D5 of behavioral parity round 2: bin/shellm:3332 builds the reasoning step as
// `{type,thought,cmd,run_id,llm_s} + $usage`, with $usage the WHOLE record bin/llm wrote (write_usage: in_tok, out_tok,
// think_tok, cache_tok, estimated, served_by, truncated). The port copied only in_tok/out_tok/think_tok/estimated.
// The differential proof against the real bin/shellm is parity/behavioral/run-parity.mjs ("FIELD SETS" check).
import { describe, it, expect } from "vitest";
import { recordedModel } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runShellm, usageFields } from "../src/shellm.ts";
import { createTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

describe("D5: usageFields copies the whole usage record (no model)", () => {
  it("in_tok, out_tok, think_tok, cache_tok, served_by and truncated; estimated only when true; empty served_by dropped", () => {
    expect(usageFields({ in_tok: 100, out_tok: 10, think_tok: 3, cache_tok: 64, served_by: "StubHost", truncated: true })).toEqual({
      in_tok: 100, out_tok: 10, think_tok: 3, cache_tok: 64, served_by: "StubHost", truncated: true,
    });
    expect(usageFields({ out_tok: 2, estimated: false, truncated: false, served_by: "" })).toEqual({ out_tok: 2 });
    expect(usageFields({ out_tok: 2, estimated: true })).toEqual({ out_tok: 2, estimated: true });
    expect(usageFields(undefined)).toEqual({});
  });
});

describe("D5: reasoning steps carry the whole usage record (recorded real run)", () => {
  // The prompt asks for a plain sentence first (no code, so the provider's whole usage record is kept), then a block.
  it("both the no-code reply and the block reply carry every usage field the provider reported", async () => {
    const root = "/tmp/uc-rec-behav-d5";
    claimFixedRoot(root);
    const workdir = path.join(root, "wd");
    fs.mkdirSync(workdir, { recursive: true });
    const llm = recordedModel("behavioralParity", "d5-usage");
    try {
      const traj = createTrajectory(path.join(root, "t"));
      await runShellm({
        trajectory: traj,
        llm,
        sandbox: new LocalSandbox(),
        systemPrompt: "You run bash for the user. A reply's ```bash block is executed; set FINAL=\"...\" in a block to finish.",
        prompt: "First reply with one plain sentence and no code block at all. In your next reply, run `echo hi` in a bash block. Then finish with FINAL=\"x\".",
        workdir,
        binDir: "/nonexistent/bin",
        execEnv: {},
        header: { command: "shellm", model: "m", effort: "high", maxTokens: "", env: { name: "t", type: "local" as const }, resumed: false },
        constants: { maxIterations: 6 },
        sleep: async () => {},
      });
      const steps = traj.read() as Array<Record<string, unknown>>;
      const reasoning = steps.filter((s) => s["type"] === "reasoning");
      // One reasoning step per model call, in order (the real run: a plain sentence, then a block that finishes).
      expect(reasoning).toHaveLength(llm.responses.length);
      expect(llm.responses.some((r) => !r.text.includes("```"))).toBe(true);
      llm.responses.forEach((r, i) => {
        const want = usageFields(r.usage as never);
        expect(Object.keys(want)).toEqual(expect.arrayContaining(["in_tok", "out_tok"]));
        for (const [k, v] of Object.entries(want)) expect(reasoning[i]![k], `call ${i} ${k}`).toEqual(v);
      });
    } finally {
      llm.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
