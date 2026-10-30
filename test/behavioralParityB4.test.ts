// behavioralParityB4.test.ts — B4 of the behavioral parity round: the shellm system prompt.
// Oracle: bin/shellm build_system_prompt (2137-2359); the full byte-level comparison against the real Bash
// tool is parity/behavioral/run-parity.mjs + test/behavioralRequestParity.test.ts.
import { describe, it, expect } from "vitest";
import { recordedModel } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShellmSystemPrompt, outputBudgetLine, type MachineProbe } from "../src/shellmPrompt.ts";
import { runMonolithWake, type IdentityConfig } from "../src/monolith.ts";
import { createTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import type { LlmClient, ChatMessage } from "../src/llm.ts";
import type { EnvSpec } from "../src/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const probe: MachineProbe = {
  uname: (f) => ({ "-s": "Linux", "-r": "6.1.0", "-m": "aarch64" })[f],
  hostname: () => "box",
  whoami: () => "pax",
  bashVersion: () => "5.2.15(1)-release",
  now: () => new Date("2026-10-27T22:16:08.123Z"),
};
const base = { contextScope: "run" as const, contextBlockLimit: 8192, contextWholeBlocks: 1, contextRunTailBlock: 50, stdoutPromptLimit: 2048, machine: probe, env: { PATH: "/nonexistent" } };

describe("B4: shellm system prompt assembly (bin/shellm:2137-2359)", () => {
  it("carries the CLI reference and the Guidelines (bin/shellm:2258-2330)", () => {
    const p = buildShellmSystemPrompt(base);
    expect(p).toMatch(/## ShellLM reference\nUsage:\n  shellm \[options\] context\.\.\./);
    expect(p).toContain("\n## Guidelines\n- Think step by step. Document your reasoning.");
    expect(p).toContain("tmux may need to be installed first (apt-get install -y tmux).");
    expect(p.length).toBeGreaterThan(15_000);
  });
  it("Output budget line depends on the scope (bin/shellm:2231-2246)", () => {
    expect(outputBudgetLine({ ...base, contextScope: "run" })).toContain("the outputs of your newest 25 or so steps show whole up to 8192 bytes (about 150 lines)");
    expect(outputBudgetLine({ ...base, contextScope: "traj" })).toContain("the output of your newest step shows whole up to 8192 bytes");
    expect(outputBudgetLine({ ...base, contextScope: "traj", contextWholeBlocks: 4 })).toContain("the outputs of your newest 2 steps show");
    expect(outputBudgetLine(base)).toContain("first and last 1024 bytes");
  });
  it("## Current run and ## Machine environment are dynamic and last; no trailing newline", () => {
    const p = buildShellmSystemPrompt({ ...base, rundir: "/tmp/shellm-run.AbC123" });
    expect(p).toContain("\n## Current run\n- Transient run directory: /tmp/shellm-run.AbC123 (for generated code output; available as $SHELLM_RUNDIR)\n- Trajectory and sub-run monitoring use $TRAJ_DIR and $TRAJ_ID.\n\n## Machine environment\n- OS: Linux 6.1.0\n- Arch: aarch64\n- Hostname: box\n- User: pax\n- Shell: 5.2.15(1)-release\n- Date: 2026-10-27T22:16:08Z");
    expect(p.endsWith("- Date: 2026-10-27T22:16:08Z")).toBe(true); // no package managers on PATH -> no line
  });
  it("context info adds the guideline bullet and the variables section (bin/shellm:2269,2338-2343)", () => {
    const p = buildShellmSystemPrompt({ ...base, contextInfo: "- $CONTEXT: stdin data (5 chars)" });
    expect(p).toContain("## Guidelines\n- Always start by inspecting `$CONTEXT`");
    expect(p).toContain("## Context available as environment variables\n");
    expect(buildShellmSystemPrompt(base)).not.toContain("Always start by inspecting");
  });
  it("Docker mode adds the Execution environment section (bin/shellm:2303-2308)", () => {
    const p = buildShellmSystemPrompt({ ...base, docker: { image: "img:1" } });
    expect(p).toContain("## Execution environment\nYour code runs inside a Docker container (img:1) with bash");
  });

  it("a monolith wake's system prompt is the assembled one (names its run dir, run-scope budget)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "behav-b4-"));
    try {
      const stateDir = path.join(root, "run");
      const workdir = path.join(root, "workdir");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(workdir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");
      const identity: IdentityConfig = {
        name: "pax", identityText: "I am pax.", skillsText: "(no skills installed)", goals: "(no goals set)",
        trajDir: path.join(root, "trajectories"), workdir, binDir: path.resolve(HERE, "../bin"), stateDir,
        model: "m", env: { name: "t", type: "local" } as EnvSpec,
      };
      const traj = createTrajectory(identity.trajDir);
      // A real quiet wake's idle answer (monolith/quiet-idle, reused: the test reads the system prompt sent).
      const llm = recordedModel("monolith", "quiet-idle", { cycle: true });
      await runMonolithWake({ trajectory: traj, identity, llm, sandbox: new LocalSandbox(), trigger: { triggerType: "monolith-wake" }, env: {} });
      llm.close();
      const sys = String((llm.requests[0]!["messages"] as Array<{ role: string; content: string }>).find((m) => m.role === "system")!.content);
      expect(sys).toContain("the outputs of your newest 25 or so steps show");
      expect(sys).toMatch(/\n## Current run\n- Transient run directory: \S+ \(for generated code output; available as \$SHELLM_RUNDIR\)/);
      expect(sys).toContain("\n## Machine environment\n- OS: ");
      expect(sys.endsWith("\n")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
