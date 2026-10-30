// monolithWake2e39.test.ts — the monolith wake changes of upstream sync 2e39a3f,
// ported from tests/test_monolith_wake_sections.sh, test_monolith_request_model.sh,
// test_monolith_run_capture.sh and test_prompt_redaction.sh (thinkers/monolith/step,
// thinkers/_lib/common.sh). Each drives runMonolithWake end to end with a replay client
// and reads the prompt back from the `prompt` step the run records.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMonolithWake, runtimeLine, type IdentityConfig } from "../src/monolith.js";
import { createTrajectory, type Trajectory } from "../src/trajectory.js";
import { LocalSandbox } from "../src/sandbox.js";
import { type LlmClient, type LlmResponse } from "../src/llm.js";
import { outboundSection, scheduleSignals } from "../src/wakeSections.js";
import type { EnvSpec } from "../src/types.js";
import { httpModel } from "./support/modelHttpFixture.js";
import { recordedModel } from "./support/recordedModel.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(path.resolve(HERE, ".."), "bin");
const LOCAL_ENV: EnvSpec = { name: "t", type: "local" };
// Recorded real replies (test/fixtures/recordings/, DeepSeek, test/support/README.md). Most tests here read the prompt
// the wake renders, not the reply: they replay monolith/quiet-idle, a real wake answered with only FINAL="idle".
const IDLE = () => recordedModel("monolith", "quiet-idle");
const rec = (scenario: string) => recordedModel("monolithWake2e39", scenario);
/** pax's standing chore is a health check that fails: a line on stderr (the diagnostic pointer only names
 *  shell-output steps with output), then exit 7. */
const FAIL_TEXT = "I am pax. I keep one standing chore: every wake I first run my health check, `bash ./healthcheck.sh`, exactly as written, and see what it says.";
const IDLE_THEN_FAIL_TEXT =
  "I am pax. Nothing is worth doing right now, so this wake is idle. My habit: in the same bash block as the idle step, after it, I run my health check `bash ./healthcheck.sh` as the last command, exactly as written.";
const healthcheck = (f: Fixture) =>
  fs.writeFileSync(path.join(f.identity.workdir, "healthcheck.sh"), 'echo "healthcheck: disk probe failed" >&2\nexit 7\n');
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0); // Fri 2026-09-18 12:00Z
const iso = (secOffset: number) => new Date(NOW + secOffset * 1000).toISOString();

interface Fixture {
  identity: IdentityConfig;
  traj: Trajectory;
  memDir: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  // A fixed root (literal /tmp on Linux and macOS): the wake prompt names these paths and a recorded reply may use them.
  const root = "/tmp/uc-rec-monolith-2e39";
  claimFixedRoot(root);
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  const memDir = path.join(root, "memories");
  for (const d of [workdir, stateDir, memDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "tok");
  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax.",
    skillsText: "(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: BIN_DIR,
    stateDir,
    model: "base-model",
    env: LOCAL_ENV,
    execEnv: { MEM_DIR: memDir },
  };
  const traj = createTrajectory(trajDir);
  return { identity, traj, memDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const append = (traj: Trajectory, rec: Record<string, unknown>) =>
  fs.appendFileSync(traj.trajFile, JSON.stringify(rec) + "\n");

async function wake(f: Fixture, over: Partial<Parameters<typeof runMonolithWake>[0]> = {}) {
  const quiet = { stdout: () => {}, stderr: () => {} };
  const errs: string[] = [];
  const result = await runMonolithWake({
    trajectory: f.traj,
    identity: f.identity,
    llm: IDLE(),
    sandbox: new LocalSandbox(),
    trigger: { triggerType: "monolith-wake" },
    now: () => NOW,
    env: { MONOLITH_TIERED_MEMORY: "0" },
    io: { ...quiet, stderr: (s: string) => void errs.push(s) },
    ...over,
  });
  const steps = f.traj.read() as Array<Record<string, unknown>>;
  const prompt = String((steps.find((s) => s["type"] === "prompt") as { content?: string } | undefined)?.content ?? "");
  return { result, steps, prompt, stderr: errs.join("") };
}

const pendingAction = (traj: Trajectory) =>
  append(traj, { step_id: "req-1", type: "action", source: "responder", trigger_step: "req-1", person: "andy", request: "check the thing", ts: iso(-120) });

describe("model tier (MONOLITH_REQUEST_MODEL, test_monolith_request_model.sh)", () => {
  it("unset: every wake runs on the base model, tier think", async () => {
    const f = fixture();
    try {
      const { steps, stderr } = await wake(f, { trigger: { triggerType: "observation", triggerSource: "responder" } });
      expect(stderr).toContain("model base-model (think tier)");
      const hdr = steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>;
      expect(hdr["model"]).toBe("base-model");
      expect(String(hdr["wake"])).not.toContain("/request");
    } finally {
      f.cleanup();
    }
  });

  it("set: a reactive wake runs on the request model and the wake reason says so", async () => {
    const f = fixture();
    try {
      const asked: string[] = [];
      const { steps, stderr } = await wake(f, {
        trigger: { triggerType: "observation", triggerSource: "responder" },
        env: { MONOLITH_TIERED_MEMORY: "0", MONOLITH_REQUEST_MODEL: "big-model" },
        llmForModel: (m) => {
          asked.push(m);
          return IDLE();
        },
      });
      expect(asked).toEqual(["big-model"]);
      expect(stderr).toContain("model big-model (request tier)");
      const hdr = steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>;
      expect(hdr["model"]).toBe("big-model");
      expect(hdr["wake"]).toBe("reactive/observation:responder/request");
      expect(String(hdr["command"])).toContain("--model big-model");
    } finally {
      f.cleanup();
    }
  });

  it("set: a spontaneous timer wake stays on the base model...", async () => {
    const f = fixture();
    try {
      const { stderr, steps } = await wake(f, { env: { MONOLITH_TIERED_MEMORY: "0", MONOLITH_REQUEST_MODEL: "big-model" } });
      expect(stderr).toContain("model base-model (think tier)");
      expect((steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>)["wake"]).toBe("spontaneous/timer");
    } finally {
      f.cleanup();
    }
  });

  it("...unless a PENDING REQUEST is open", async () => {
    const f = fixture();
    try {
      pendingAction(f.traj);
      const { stderr, steps } = await wake(f, {
        env: { MONOLITH_TIERED_MEMORY: "0", MONOLITH_REQUEST_MODEL: "big-model" },
        llmForModel: () => IDLE(),
      });
      expect(stderr).toContain("model big-model (request tier)");
      expect((steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>)["wake"]).toBe("spontaneous/timer/request");
    } finally {
      f.cleanup();
    }
  });
});

describe("failed-run capture (test_monolith_run_capture.sh, c5dbce4)", () => {
  it("the error step carries the run's last stderr lines and a diagnostic_step", async () => {
    const f = fixture();
    try {
      f.identity.identityText = FAIL_TEXT;
      healthcheck(f);
      const llm = rec("fail-healthcheck");
      const { steps } = await wake(f, { llm, constants: { maxRepeatFailures: 1 } });
      llm.verify();
      const err = steps.filter((s) => s["reason"] === "run-failed").pop()!;
      expect(err["rc"]).toBe(1);
      expect(String(err["stderr_tail"])).toContain("STALL");
      expect(String(err["content"])).toBe(`monolith run failed (rc=1) with no durable step: ${err["stderr_tail"]}`);
      // the failing command's shell-output step is what the error step points at
      const failing = steps.filter((s) => s["type"] === "shell-output" && s["exit"] === 7);
      expect(failing.length).toBeGreaterThan(0);
      expect(err["diagnostic_step"]).toBe(failing[failing.length - 1]!["step_id"]);
    } finally {
      f.cleanup();
    }
  });

  it("a thrown run says why: the exception text is the stderr tail", async () => {
    const f = fixture();
    try {
      // Transport fixture, not model output: the provider answers HTTP 502.
      const boom = httpModel([{ status: 502, body: "upstream unavailable" }]);
      const { steps } = await wake(f, { llm: boom });
      const err = steps.filter((s) => s["reason"] === "run-failed").pop()!;
      expect(String(err["stderr_tail"])).toContain("API error (HTTP 502)");
      expect(String(err["content"])).toContain("API error (HTTP 502)");
    } finally {
      f.cleanup();
    }
  });

  it("a run that wrote its own idle step suppresses the fallback marker", async () => {
    const f = fixture();
    try {
      f.identity.identityText = "I am pax. Nothing is worth doing right now; an honest idle wake is the right call.";
      const llm = rec("writes-own-idle");
      const { steps, stderr } = await wake(f, { llm });
      llm.verify();
      const idles = steps.filter((s) => s["type"] === "idle");
      expect(idles).toHaveLength(1);
      const hdr = steps.find((s) => s["type"] === "shellm-run")!;
      expect(idles[0]!["run_id"]).toBe(hdr["step_id"]); // the model's own idle, tagged with this run
      expect(stderr).toContain("run appended its own idle step — fallback marker suppressed");
    } finally {
      f.cleanup();
    }
  });

  it("another run's idle cannot suppress this run's fallback (5f)", async () => {
    const f = fixture();
    try {
      // Another run's idle is already on the stream; this run (a real FINAL-only reply) writes nothing durable.
      append(f.traj, { step_id: "foreign-idle", type: "idle", content: "idle", source: "monolith", run_id: "other-run", ts: iso(-60) });
      const llm = IDLE();
      const { steps, stderr } = await wake(f, { llm });
      llm.verify();
      const idles = steps.filter((s) => s["type"] === "idle");
      expect(idles).toHaveLength(2);
      expect(idles.filter((s) => s["run_id"] !== "other-run")).toHaveLength(1);
      expect(stderr).toContain("run produced no durable step (rc=0) — marking idle");
    } finally {
      f.cleanup();
    }
  });

  it("an idle followed by a failure still records the error and no extra idle (5i)", async () => {
    const f = fixture();
    try {
      f.identity.identityText = IDLE_THEN_FAIL_TEXT;
      healthcheck(f);
      const llm = rec("idle-then-fail");
      const { steps } = await wake(f, { llm, constants: { maxRepeatFailures: 1 } });
      llm.verify();
      const hdr = steps.find((s) => s["type"] === "shellm-run")!;
      expect(steps.filter((s) => s["type"] === "idle" && s["run_id"] === hdr["step_id"])).toHaveLength(1); // the run's own idle
      expect(steps.filter((s) => s["type"] === "shell-output" && s["exit"] === 7)).toHaveLength(1);
      expect(steps.filter((s) => s["type"] === "error" && s["reason"] === "run-failed")).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
});

describe("wake prompt sections (test_monolith_wake_sections.sh)", () => {
  it("lists the sent ledger, the clock line and a DUE scheduled goal", async () => {
    const f = fixture();
    try {
      append(f.traj, { step_id: "m1", type: "message", from: "pax", to: "slack-C0BMVH6LM4K", content: "papers for today", source: "chat", ts: iso(-60) });
      append(f.traj, { step_id: "d1", type: "delivery", source: "slack-bridge", transport: "slack", trigger_step: "m1", status: "delivered", channel: "C0BMVH6LM4K", ts: iso(-59) });
      append(f.traj, { step_id: "m2", type: "message", from: "pax", to: "slack-nick", content: "lost note", source: "chat", ts: iso(-50) });
      append(f.traj, { step_id: "d2", type: "delivery", source: "slack-bridge", transport: "slack", trigger_step: "m2", status: "failed", reason: "unknown slack address form", ts: iso(-49) });
      fs.writeFileSync(
        path.join(f.memDir, "2026-09-01-00-00-00_5ced0001_digest.md"),
        "---\nid: 5ced0001\nsummary: Daily digest for the team\ntype: goal\ncreated: 2026-09-01 00:00:00\nschedule: 00:00\n---\n\nDaily digest for the team\n",
      );
      const { prompt } = await wake(f, { env: { MONOLITH_TIERED_MEMORY: "0", SCHEDULE_GRACE_MIN: "1440" } });
      expect(prompt).toContain("\nSent in the last 24h");
      expect(prompt).toContain('to slack-C0BMVH6LM4K: delivered "papers for today"');
      expect(prompt).toContain('to slack-nick: FAILED, never arrived (unknown slack address form) "lost note"');
      expect(prompt).toMatch(/^- Now: Friday 2026-09-18 12:00 UTC \(2026-09-18 12:00Z\)\.$/m);
      expect(prompt).toContain('- DUE NOW: "Daily digest for the team", the 00:00 UTC window of 2026-09-18.');
      expect(prompt).toContain("--key 5ced0001/2026-09-18-0000 <<\"MSG\"");
      // sent ledger sits after the recent stream and before the routing signals
      expect(prompt.indexOf("Recent stream")).toBeLessThan(prompt.indexOf("Sent in the last 24h"));
      expect(prompt.indexOf("Sent in the last 24h")).toBeLessThan(prompt.indexOf("Routing signals:"));
      // the clock/schedule lines lead the routing signals
      const sig = prompt.slice(prompt.indexOf("Routing signals:"));
      expect(sig.startsWith("Routing signals:\n- Now: ")).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("a window that was already sent with its key is done, not due", () => {
    const f = fixture();
    try {
      fs.writeFileSync(
        path.join(f.memDir, "g.md"),
        "---\nid: 5ced0001\nsummary: Digest\ntype: goal\nschedule: 00:00 18:00\n---\n\nx\n",
      );
      append(f.traj, { step_id: "m1", type: "message", from: "pax", to: "slack-x", content: "digest", key: "5ced0001/2026-09-18-0000", source: "chat", ts: iso(-3600) });
      const out = scheduleSignals(f.memDir, f.traj.trajFile, "pax", { SCHEDULE_GRACE_MIN: "1440" }, () => NOW);
      expect(out).toContain('- Scheduled "Digest": the 00:00 window was sent at 11:00Z; next window 18:00 UTC, in 6h0m. Nothing to send for this goal before then.');
    } finally {
      f.cleanup();
    }
  });

  it("an expired goal (until: in the past) is skipped; only the Now line remains", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.memDir, "g.md"), "---\nid: a\nsummary: S\nschedule: 09:00\nuntil: 2026-09-01\n---\nx\n");
      const out = scheduleSignals(f.memDir, f.traj.trajFile, "pax", {}, () => NOW);
      expect(out.split("\n")).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  it("no outbound section when nothing was sent", () => {
    const f = fixture();
    try {
      expect(outboundSection(f.traj.trajFile, "pax", {}, () => NOW)).toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("caps the list at OUTBOUND_MAX and says how many more", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 4; i++) {
        append(f.traj, { step_id: `m${i}`, type: "message", from: "pax", to: "andy", content: `msg ${i}`, source: "chat", ts: iso(-100 + i) });
      }
      const out = outboundSection(f.traj.trajFile, "pax", { OUTBOUND_MAX: "2" }, () => NOW);
      expect(out.split("\n")).toHaveLength(4); // header, 2 lines, "and 2 more"
      expect(out).toContain("- and 2 more: `chat sent --since 24h`");
      expect(out).toContain("sent (this transport does not confirm delivery)");
    } finally {
      f.cleanup();
    }
  });

  it("runtime line says the checkout is read-only when bin/ is not writable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtline-"));
    try {
      const run = (a: string[]) => fs.mkdirSync(path.join(root, ...a), { recursive: true });
      run(["bin"]);
      const sh = (c: string) => require("node:child_process").execSync(c, { cwd: root, stdio: "ignore" });
      sh("git init -q && git config user.email t@e.x && git config user.name t && git commit -q --allow-empty -m init");
      fs.chmodSync(path.join(root, "bin"), 0o555);
      const line = runtimeLine(path.join(root, "bin"), undefined, () => NOW, { IDENTITY_DIR: "/id/dir" });
      if (process.getuid && process.getuid() === 0) return; // root can always write
      expect(line).toContain(`The checkout at ${root} is read-only inside a wake:`);
      expect(line).toContain("Your identity directory (/id/dir) is yours to write.");
      fs.chmodSync(path.join(root, "bin"), 0o755);
      expect(runtimeLine(path.join(root, "bin"), undefined, () => NOW, {})).not.toContain("read-only");
    } finally {
      fs.chmodSync(path.join(root, "bin"), 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prompt redaction at the wake boundary (test_prompt_redaction.sh)", () => {
  it("a credential pasted into the log never reaches the model's prompt", async () => {
    const f = fixture();
    try {
      const token = "ghp_" + "Q".repeat(30);
      append(f.traj, { step_id: "t1", type: "thought", content: `I pasted ${token} by mistake`, source: "monolith", ts: iso(-30) });
      const { prompt } = await wake(f);
      expect(prompt).not.toContain(token);
      expect(prompt).toContain("<redacted:github-token>");
    } finally {
      f.cleanup();
    }
  });
});
