// monolith.test.ts — the part-5 "PENDING REQUEST" routing hint
// (design/conversation_memory.md, part 5; thinkers/monolith/step's
// `pending_req` jq block), the bundled prompt template's one-line
// "pending request" exception to "never send a chat reply from here", and
// the idle/error fallback's exact step JSON (bug #37: thinkers/monolith/step
// :349-380 — a failed run (rc != 0) must be recorded as a visible `error`
// step carrying `rc`, distinct from a calm `idle`).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  pendingRequestHint,
  runMonolithWake,
  runtimeLine,
  workspaceSection,
  coarseCount,
  lifeContextSection,
  type IdentityConfig,
} from "../src/monolith.js";
import { recentStream } from "../src/recentStream.js";
import { createTrajectory, openTrajectory, type Trajectory } from "../src/trajectory.js";
import { LocalSandbox } from "../src/sandbox.js";
import { type LlmResponse } from "../src/llm.js";
import { runRecap, type RecapIO } from "../src/recap.js";
import type { EnvSpec, Step } from "../src/types.js";
import { recordedEndpoint, recordedModel, recordedText, RECORDINGS_DIR, type Recording, type RecordedModelOptions } from "./support/recordedModel.ts";
import { recordedServerProcess, type RecordedServerProcess } from "./support/recordedServerProcess.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BIN_DIR = path.join(REPO, "bin");

// PORT-NOTE (1c: 2fed66c, 0a36061) — `pendingRequestHint` no longer scans the
// bounded recentContext window; it reads the `chat pending` deferrals index
// over the WHOLE root trajectory (src/messageIndex.ts, already shipped by
// lane D). These scenarios port 2fed66c's own test list ("masking by a newer
// request, burial under 40 later steps, ordering, age, max-age, overdue
// wording, one-at-a-time resolution") plus 0a36061's wording change.
describe("pendingRequestHint", () => {
  function makeTraj(): { traj: Trajectory; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-hint-"));
    const traj = createTrajectory(path.join(root, "trajectories"));
    return { traj, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  function appendRaw(traj: Trajectory, rec: Record<string, unknown>): void {
    fs.appendFileSync(traj.trajFile, JSON.stringify(rec) + "\n");
  }
  const NOW_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
  const agoIso = (secs: number) => new Date(NOW_MS - secs * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const now = () => NOW_MS;

  it("names the exact delivery command for an unresolved responder action", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "check the bridge work status", ts: agoIso(60) });
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).toContain("PENDING REQUEST from andy: check the bridge work status");
      // 2e39a3f: the result goes on stdin as a quoted heredoc, never a double-quoted argument.
      expect(hint).toContain('chat reply --follow-up --reply-to trig-1 andy <<"MSG" (the message on stdin as a quoted heredoc');
      expect(hint).not.toContain('"<result>"');
      expect(hint).toContain("--field resolves=trig-1");
      expect(hint).toContain("pending for 1 min");
    } finally {
      cleanup();
    }
  });

  it("is empty when there is no pending action", () => {
    const { traj, cleanup } = makeTraj();
    try {
      expect(pendingRequestHint(traj.trajFile, now)).toBe("");
      appendRaw(traj, { step_id: "t1", type: "thought", content: "musing", ts: agoIso(10) });
      expect(pendingRequestHint(traj.trajFile, now)).toBe("");
    } finally {
      cleanup();
    }
  });

  it("is cleared once an observation carries resolves=<trigger>", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "check status", ts: agoIso(60) });
      appendRaw(traj, { step_id: "obs-1", type: "observation", resolves: "trig-1", content: "delivered", ts: agoIso(30) });
      expect(pendingRequestHint(traj.trajFile, now)).toBe("");
    } finally {
      cleanup();
    }
  });

  it("shows an older request first, un-masked by a newer one (the 2026-09-02 bug 2fed66c fixed)", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "nick", request: "first, older request", ts: agoIso(600) });
      appendRaw(traj, { step_id: "trig-2", type: "action", source: "responder", trigger_step: "trig-2", person: "braden", request: "second, newer request", ts: agoIso(60) });
      const hint = pendingRequestHint(traj.trajFile, now);
      // both show, oldest first — neither masks the other.
      expect(hint.indexOf("nick: first, older request")).toBeLessThan(hint.indexOf("braden: second, newer request"));
    } finally {
      cleanup();
    }
  });

  it("survives burial under 40 later steps (the deferrals index is not window-bounded)", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "buried request", ts: agoIso(3600) });
      for (let i = 0; i < 40; i++) {
        appendRaw(traj, { step_id: `t${i}`, type: "thought", content: `filler ${i}`, ts: agoIso(3600 - i * 10) });
      }
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).toContain("PENDING REQUEST from andy: buried request");
    } finally {
      cleanup();
    }
  });

  it("shows age in hours and marks OVERDUE past 4 hours (0a36061 lowered the threshold from a day)", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "old one", ts: agoIso(5 * 3600) });
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).toContain("pending for 5 h");
      expect(hint).toContain("OVERDUE: deliver what you have, or that it cannot be done, this wake");
    } finally {
      cleanup();
    }
  });

  it("does not mark OVERDUE under 4 hours", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "recent", ts: agoIso(3600) });
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).toContain("pending for 1 h");
      expect(hint).not.toContain("OVERDUE");
    } finally {
      cleanup();
    }
  });

  it("caps the list at 5 with an oldest-first order and a trailer for the rest", () => {
    const { traj, cleanup } = makeTraj();
    try {
      for (let i = 0; i < 7; i++) {
        appendRaw(traj, {
          step_id: `trig-${i}`,
          type: "action",
          source: "responder",
          trigger_step: `trig-${i}`,
          person: `person${i}`,
          request: `request ${i}`,
          ts: agoIso(700 - i * 10), // trig-0 is oldest
        });
      }
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).toContain("PENDING REQUEST from person0: request 0");
      expect(hint).toContain("PENDING REQUEST from person4: request 4");
      expect(hint).not.toContain("PENDING REQUEST from person5:");
      expect(hint).toContain("- 2 more pending requests: run `chat pending` to see them all.");
    } finally {
      cleanup();
    }
  });

  it("ignores an action from a source other than the responder", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "monolith", trigger_step: "trig-1", person: "andy", request: "x", ts: agoIso(60) });
      expect(pendingRequestHint(traj.trajFile, now)).toBe("");
    } finally {
      cleanup();
    }
  });

  it("resolving one request at a time leaves the rest pending", () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendRaw(traj, { step_id: "trig-1", type: "action", source: "responder", trigger_step: "trig-1", person: "andy", request: "first", ts: agoIso(120) });
      appendRaw(traj, { step_id: "trig-2", type: "action", source: "responder", trigger_step: "trig-2", person: "braden", request: "second", ts: agoIso(60) });
      appendRaw(traj, { step_id: "obs-1", type: "observation", resolves: "trig-1", content: "done", ts: agoIso(30) });
      const hint = pendingRequestHint(traj.trajFile, now);
      expect(hint).not.toContain("andy: first");
      expect(hint).toContain("braden: second");
    } finally {
      cleanup();
    }
  });
});

describe("bundled monolith prompt template", () => {
  it("carries the part-5 pending-request exception, byte-identical between the two bundled copies", () => {
    const a = fs.readFileSync(path.join(REPO, "src/assets/monolith-prompt.md"), "utf8");
    const b = fs.readFileSync(path.join(REPO, "src/assets/thinkers/monolith/prompt.md"), "utf8");
    expect(a).toBe(b);
    expect(a).toContain("pending request");
    expect(a).toContain("chat reply --follow-up --reply-to");
    expect(a).toContain("--field resolves=<id>");
  });
});

// ---------------------------------------------------------------------------
// runMonolithWake: idle/error fallback exact JSON (bug #37)
// ---------------------------------------------------------------------------

const LOCAL_ENV: EnvSpec = { name: "t", type: "local" };

function makeIdentity(overrides: Partial<IdentityConfig> = {}): {
  identity: IdentityConfig;
  cleanup: () => void;
} {
  // A fixed root: the wake prompt names these paths, so a recorded reply that uses one still finds it on replay.
  const root = "/tmp/uc-rec-monolith-fallback"; // literal /tmp, not os.tmpdir(): the same path on Linux and macOS
  claimFixedRoot(root);
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // arm_wake fidelity (monolith.ts): wake_at is only written when
  // run/dispatcher.token exists.
  fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");
  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax.",
    skillsText: "(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: BIN_DIR,
    stateDir,
    model: "test-model",
    env: LOCAL_ENV,
    ...overrides,
  };
  return { identity, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Recorded real replies (test/fixtures/recordings/monolith/, DeepSeek, test/support/README.md). Each scenario's identity text
// says what the wake is for; the reply is what the model really answered to the engine's real wake prompt.
/** A quiet wake: the model is asked to leave nothing durable and only set FINAL (rc=0, no thought/action/observation). */
const QUIET_GOALS =
  'I am pax. Test harness note for this wake: there is nothing to do. Do not run any command and do not append any step. Reply with exactly one bash block whose only line is FINAL="idle".';
/** A failing wake: pax's standing chore is a health check that fails (exit 7, a line on stderr). With
 *  SHELLM_MAX_REPEAT_FAILURES=1 the first failing block trips the stall guard (bin/shellm:2841-2846 → return 1). */
const FAIL_GOALS =
  "I am pax. I keep one standing chore: every wake I first run my health check, `bash ./healthcheck.sh`, exactly as written, and see what it says.";
function withFailingHealthcheck(identity: IdentityConfig): void {
  fs.writeFileSync(path.join(identity.workdir, "healthcheck.sh"), 'echo "healthcheck: disk probe failed" >&2\nexit 7\n');
}
const rec = (scenario: string, o: RecordedModelOptions = {}) => recordedModel("monolith", scenario, o);

describe("runMonolithWake: idle/error fallback exact step JSON (bug #37)", () => {
  it("rc=0, no durable step: idle step has no rc field", async () => {
    const { identity, cleanup } = makeIdentity({ identityText: QUIET_GOALS });
    try {
      const traj = createTrajectory(identity.trajDir);
      const llm = rec("quiet-idle");
      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake" },
      });
      llm.verify();
      expect(result.stopReason).toBe("final");
      expect(result.didWork).toBe(false);
      const steps = traj.read() as Array<Record<string, unknown>>;
      const last = steps[steps.length - 1]!;
      expect(last["type"]).toBe("idle");
      expect(last["content"]).toBe("idle");
      expect(last["source"]).toBe("monolith");
      expect(last["run_id"]).toBeTruthy();
      expect("rc" in last).toBe(false);
      expect("reason" in last).toBe(false);
    } finally {
      cleanup();
    }
  });

  it.each([
    ["stall", "fail-stall", { maxRepeatFailures: 1 }],
    ["max-iter", "fail-stall", { maxIterations: 1 }],
  ] as const)("rc!=0 (%s): error step carries rc:1 and the upstream content/field shape", async (kind, scenario, constants) => {
    const { identity, cleanup } = makeIdentity({ identityText: FAIL_GOALS });
    withFailingHealthcheck(identity);
    try {
      const traj = createTrajectory(identity.trajDir);
      const llm = rec(scenario);
      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake" },
        constants,
      });
      llm.verify();
      // the recorded commands really failed (exit 7), every one of them
      const outs = (traj.read() as Array<Record<string, unknown>>).filter((s) => s["type"] === "shell-output");
      expect(outs.length).toBe(1);
      expect(outs[0]!["exit"]).toBe(7);
      expect(result.stopReason).toBe(kind);
      expect(result.didWork).toBe(false);
      const steps = traj.read() as Array<Record<string, unknown>>;
      const last = steps[steps.length - 1]!;
      // thinkers/monolith/step:366 jq template, field-for-field.
      expect(last["type"]).toBe("error");
      // 2e39a3f: the content now names the run's last stderr lines when it left any.
      expect(String(last["content"]).startsWith("monolith run failed (rc=1) with no durable step")).toBe(true);
      expect(last["source"]).toBe("monolith");
      expect(last["reason"]).toBe("run-failed");
      expect(last["rc"]).toBe(1);
      expect(last["run_id"]).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("default SHELLM_MAX_REPEAT_FAILURES (3): a chore that keeps failing the same way trips the stall guard on the 3rd identical failure", async () => {
    const { identity, cleanup } = makeIdentity({
      identityText:
        "I am pax. I keep one standing chore: every wake I run my health check, `bash ./healthcheck.sh`, exactly as written. It is known to be flaky, so when it fails I rerun the identical command, unchanged, in the next reply, until it passes. I never inspect, edit or work around it.",
    });
    withFailingHealthcheck(identity);
    try {
      const traj = createTrajectory(identity.trajDir);
      const llm = rec("fail-stall-default");
      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake" },
      });
      llm.verify();
      const steps = traj.read() as Array<Record<string, unknown>>;
      const outs = steps.filter((s) => s["type"] === "shell-output");
      expect(outs).toHaveLength(3); // the guard fires on the 3rd, not before and not after
      expect(outs.every((o) => o["exit"] === 7)).toBe(true);
      expect(result.stopReason).toBe("stall");
      const stall = steps.find((s) => s["type"] === "error" && s["reason"] === "stall")!;
      expect(String(stall["content"])).toContain("submitted the same failing command 3 times in a row");
      expect(steps[steps.length - 1]!["reason"]).toBe("run-failed");
    } finally {
      cleanup();
    }
  });

  // A thinking-only answer reaches shellm as empty text only on DeepSeek's Anthropic-format wire; a 24-token `-t`
  // starves the recorded answer so the model's real thinking is all that comes back.
  it("rc!=0 (empty-response): error step carries rc:1 and the upstream content/field shape", async () => {
    const { identity, cleanup } = makeIdentity({ identityText: QUIET_GOALS });
    try {
      const traj = createTrajectory(identity.trajDir);
      const llm = rec("empty-response-starved", { wire: "anthropic", maxTokens: 24 });
      const result = await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake" },
        constants: { emptyResponseRetries: 0 },
      });
      llm.verify();
      expect(llm.responses.map((r) => r.text)).toEqual([""]);
      expect(result.stopReason).toBe("empty-response");
      expect(result.didWork).toBe(false);
      const steps = traj.read() as Array<Record<string, unknown>>;
      expect(steps.some((s) => s["type"] === "error" && s["source"] === "shellm" && s["reason"] === "empty-response")).toBe(true);
      const last = steps[steps.length - 1]!;
      expect(last["type"]).toBe("error");
      expect(String(last["content"]).startsWith("monolith run failed (rc=1) with no durable step")).toBe(true);
      expect(last["source"]).toBe("monolith");
      expect(last["reason"]).toBe("run-failed");
      expect(last["rc"]).toBe(1);
      expect(last["run_id"]).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("carries trigger_step through to the error step when the wake was triggered by another step", async () => {
    const { identity, cleanup } = makeIdentity({ identityText: FAIL_GOALS });
    withFailingHealthcheck(identity);
    try {
      const traj = createTrajectory(identity.trajDir);
      const llm = rec("fail-stall");
      await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "observation", triggerSource: "responder", triggerStepId: "trig-99" },
        constants: { maxRepeatFailures: 1 },
      });
      llm.verify();
      const steps = traj.read() as Array<Record<string, unknown>>;
      const last = steps[steps.length - 1]!;
      expect(last["type"]).toBe("error");
      expect(last["trigger_step"]).toBe("trig-99");
    } finally {
      cleanup();
    }
  });

  it("a thrown error (no shellm subprocess boundary in this port) is caught, recorded as rc=1, and the wake still completes", async () => {
    const { identity, cleanup } = makeIdentity();
    try {
      const traj = createTrajectory(identity.trajDir);
      // Transport fixture, not model output: the provider answers HTTP 500 and llm (no retries) fails, so the first
      // `llm.complete()` inside runShellm throws — this port's analogue of an uncaught bin/shellm crash
      // (network/API failure, sandbox infra failure, …) that upstream's
      // subprocess boundary (`shellm ... || run_rc=$?`) always survives.
      const llm = rec("transport-outage", {
        env: { LLM_RETRIES: "0" },
        httpFixtures: { 0: { status: 500, content_type: "application/json", body: '{"error":{"message":"provider outage"}}' } },
      });
      let threw = false;
      let result;
      try {
        result = await runMonolithWake({
          trajectory: traj,
          identity,
          llm,
          sandbox: new LocalSandbox(),
          trigger: { triggerType: "monolith-wake" },
        });
      } catch {
        threw = true;
      }
      // The wake itself must not crash — matching upstream, which always
      // reaches the fallback/backoff/arm_wake logic after `|| run_rc=$?`.
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result!.stopReason).toBe("threw");
      // dispatcher.token is present (makeIdentity) → the wake still arms its
      // next timer, proving the crash didn't skip the rest of the function.
      expect(result!.wakeAtEpoch).not.toBeNull();

      const steps = traj.read() as Array<Record<string, unknown>>;
      const runHeader = steps.find((s) => s["type"] === "shellm-run")!;
      const last = steps[steps.length - 1]!;
      expect(last["type"]).toBe("error");
      expect(String(last["content"]).startsWith("monolith run failed (rc=1) with no durable step: ")).toBe(true);
      expect(String(last["stderr_tail"])).toContain("API error: provider outage");
      expect(last["reason"]).toBe("run-failed");
      expect(last["rc"]).toBe(1);
      // Recovered from the run header this wake itself appended (step:358's
      // `cat "$run_id_file"` equivalent), not omitted.
      expect(last["run_id"]).toBe(runHeader["step_id"]);
    } finally {
      cleanup();
    }
  });

  it("two consecutive errored wakes collapse in recentStream with the (rc=1) suffix — proves the field the monolith writes is the field recentStream reads (thinkers/_lib/common.sh's rc-suffix jq)", async () => {
    const { identity, cleanup } = makeIdentity({ identityText: FAIL_GOALS });
    withFailingHealthcheck(identity);
    try {
      const traj = createTrajectory(identity.trajDir);
      // max-iter, not stall: stall makes runShellm itself append its OWN
      // `type:"error", source:"shellm", reason:"stall"` step first (matching
      // bin/shellm's own stall-guard append) BEFORE monolith's fallback —
      // real and correct (PARITY.md's `136f32b` row), but it would make this
      // collapsed run "x4", not "x2". max-iter has no such shellm-level
      // append on either side, so it isolates monolith's own fallback here.
      for (let i = 0; i < 2; i++) {
        const llm = rec("fail-stall");
        await runMonolithWake({
          trajectory: traj,
          identity,
          llm,
          sandbox: new LocalSandbox(),
          trigger: { triggerType: "monolith-wake" },
          constants: { maxIterations: 1 },
        });
        llm.verify();
      }
      const rendered = recentStream(traj.read() as Step[], 50);
      const lines = rendered.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const collapsed = lines.filter((l) => l["type"] === "error");
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]!["content"]).toMatch(/^run failed x2( over \S+)? \(rc=1\)$/);
      expect(collapsed[0]!["collapsed"]).toBe(2);
    } finally {
      cleanup();
    }
  });
});

// PORT-NOTE (1c: 62d7da3, b1cf15e) — ported from upstream's
// tests/test_workspace_runtime.sh (thinkers/_lib/common.sh's `_runtime_line`
// / `_workspace_section` / `_coarse_count`). Both run under bash's own
// `set -euo pipefail` upstream, so every edge case must not throw here
// either: no git checkout, no workdir, empty workdir, a WORKSPACE.md present.
describe("runtimeLine / workspaceSection / coarseCount (1c: 62d7da3, b1cf15e)", () => {
  function gitOut(cwd: string, args: string[]): string {
    return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
  }
  function initRepo(root: string): void {
    gitOut(root, ["init", "-q"]);
    gitOut(root, ["config", "user.email", "t@example.com"]);
    gitOut(root, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(root, "a.txt"), "x\n");
    gitOut(root, ["add", "a.txt"]);
    gitOut(root, ["commit", "-q", "-m", "a test commit"]);
  }

  it("runtime line: commit, subject, checkout time", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-repo-"));
    try {
      initRepo(root);
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      const line = runtimeLine(binDir, undefined);
      expect(line).toMatch(/^Runtime: headlong [0-9a-f]{7,} \(.*\), checked out 20\d\d-/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no sync time without an identity thinkers dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-repo-"));
    try {
      initRepo(root);
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      const line = runtimeLine(binDir, path.join(root, "id", "thinkers"));
      expect(line).not.toContain("thinkers synced");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sync time from the newest identity thinker file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-repo-"));
    try {
      initRepo(root);
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      const thinkersDir = path.join(root, "id", "thinkers", "monolith");
      fs.mkdirSync(thinkersDir, { recursive: true });
      fs.writeFileSync(path.join(thinkersDir, "step"), "x\n");
      const line = runtimeLine(binDir, path.join(root, "id", "thinkers"));
      expect(line).toMatch(/your thinkers synced 20\d\d-/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no git checkout: empty line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir);
      expect(runtimeLine(binDir, undefined)).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing workdir: empty string", () => {
    expect(workspaceSection("/nonexistent/path/for/sure")).toBe("");
  });

  it("empty workdir: header, zero loose files, WORKSPACE.md invite", () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    try {
      const out = workspaceSection(wd);
      expect(out).toContain(`Workspace: ${wd}`);
      expect(out).toContain("- 0 loose files");
      expect(out).toContain("No WORKSPACE.md yet");
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("directory counts are recursive, hidden/loose/pycache rules hold", () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    try {
      fs.mkdirSync(path.join(wd, "notes", "deep"), { recursive: true });
      fs.mkdirSync(path.join(wd, "papers"), { recursive: true });
      fs.mkdirSync(path.join(wd, ".git"), { recursive: true });
      fs.mkdirSync(path.join(wd, "__pycache__"), { recursive: true });
      fs.writeFileSync(path.join(wd, "notes", "a.md"), "n\n");
      fs.writeFileSync(path.join(wd, "notes", "deep", "b.md"), "n\n");
      fs.writeFileSync(path.join(wd, "papers", "p.html"), "n\n");
      fs.writeFileSync(path.join(wd, "loose.txt"), "l\n");
      fs.writeFileSync(path.join(wd, ".hidden"), "h\n");
      fs.writeFileSync(path.join(wd, "__pycache__", "x.pyc"), "c\n");
      fs.writeFileSync(path.join(wd, ".git", "HEAD"), "g\n");
      const out = workspaceSection(wd);
      expect(out).toContain("- notes/ 2 files");
      expect(out).toContain("- 1 loose files");
      expect(out).not.toMatch(/__pycache__|\.git\//);
      expect(out.match(/^- .*\/ /gm)?.length).toBe(2); // one line per directory (notes/, papers/)
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("coarseCount rounds to two significant figures from 100 up (cache-stable prefix)", () => {
    expect(coarseCount(7)).toBe("7");
    expect(coarseCount(99)).toBe("99");
    expect(coarseCount(100)).toBe("about 100");
    expect(coarseCount(3459)).toBe("about 3500");
    expect(coarseCount(1808)).toBe("about 1800");
    expect(coarseCount(5000, 5000)).toBe("5000+");
  });

  it("WORKSPACE.md head replaces the invite", () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    try {
      fs.writeFileSync(path.join(wd, "WORKSPACE.md"), "notes/ = research\npapers/ = cached HTML\n");
      const out = workspaceSection(wd);
      expect(out).toContain("notes/ = research");
      expect(out).not.toContain("No WORKSPACE.md");
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("directory list is capped with a remainder line", () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    try {
      for (let i = 1; i <= 15; i++) {
        fs.mkdirSync(path.join(wd, `d${i}`));
        fs.writeFileSync(path.join(wd, `d${i}`, "f"), "x\n");
      }
      // WORKSPACE_DIRS_MAX is hardcoded to 12 in this port (no env override),
      // matching upstream's default (same convention as THINK_CONTEXT_TAIL).
      const out = workspaceSection(wd);
      expect(out.match(/^- .*\/ /gm)?.length).toBe(12);
      expect(out).toContain("- and 3 more directories");
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// life context — `_life_context` (thinkers/_lib/common.sh:531-548) +
// thinkers/monolith/step:281-291's gate/wrapper (1c: 3330189, a4ed181)
// =============================================================================

describe("lifeContextSection", () => {
  const NOW = () => new Date("2026-09-06T00:00:00.000Z");
  const HEADER =
    "Your life so far (tiered summary, oldest→newest). A record of what happened, not a rule for what comes next: past stretches of waiting, restraint, or one line of research do not bind this wakeup.\n";

  function makeTraj(): { traj: Trajectory; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "life-ctx-"));
    const traj = createTrajectory(path.join(root, "trajectories"));
    return { traj, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  function appendN(traj: Trajectory, n: number, offset = 0): void {
    for (let i = 0; i < n; i++) {
      fs.appendFileSync(
        traj.trajFile,
        JSON.stringify({
          step_id: `s${String(offset + i).padStart(7, "0")}`,
          type: "thought",
          content: `step ${offset + i}`,
          ts: new Date(Date.UTC(2026, 8, 1, 0, offset + i)).toISOString(),
        }) + "\n"
      );
    }
  }

  function throwingLlm(): RecapIO["runLlm"] {
    return () => {
      throw new Error("lifeContextSection: unexpected llm call");
    };
  }

  // Sealing a tier calls recap's llm boundary. It runs the port's real `llm` against a recorded real DeepSeek window
  // summary of these "step 0".."step 9" thoughts (test/fixtures/recordings/monolith/recap-seal-steps.json), served
  // from a child process because recap calls `llm` with spawnSync (test/support/recordedServerProcess.ts).
  const servers: RecordedServerProcess[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  async function recordedLlm(): Promise<RecordedServerProcess> {
    const srv = await recordedServerProcess("monolith", "recap-seal-steps");
    servers.push(srv);
    return srv;
  }
  /** The sealed block line recap renders from the recorded summary. */
  function sealedLine(): string {
    const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "monolith", "recap-seal-steps.json"), "utf8")) as Recording;
    const j = JSON.parse(recordedText(rec.calls[0]!)) as { summary: string; step_ids: string[] };
    return `[t1 · steps 0–10] ${j.summary}   (${j.step_ids.join(" ")})\n`;
  }

  it("MONOLITH_TIERED_MEMORY=0 disables the section without calling recap's llm boundary", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendN(traj, 3);
      const out = lifeContextSection(traj.trajId, traj.trajDir, { MONOLITH_TIERED_MEMORY: "0" }, throwingLlm(), NOW);
      expect(out).toBe("");
    } finally {
      cleanup();
    }
  });

  it("MONOLITH_TIERED_MEMORY unset defaults to enabled (\"1\")", async () => {
    // A gate check needs sealed rollups to be observable at all: with
    // nothing sealed, enabled and disabled are indistinguishable (both ""),
    // per a4ed181's own raw-tail-0 suppression — see the "no rollups
    // present" case below. So seal a tier first, the way a real prior wake
    // would, then compare unset vs explicitly disabled on the SAME data.
    const { traj, cleanup } = makeTraj();
    try {
      appendN(traj, 12);
      const seed = await recordedLlm();
      const seedIo: RecapIO = {
        cwd: traj.trajDir,
        env: { TRAJ_DIR: traj.trajDir },
        stdout: () => {},
        stderr: () => {},
        now: NOW,
        runLlm: seed.runLlm,
      };
      const seedCode = runRecap([traj.trajId, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], seedIo);
      expect(seedCode).toBe(0);

      const enabled = lifeContextSection(traj.trajId, traj.trajDir, {}, throwingLlm(), NOW);
      expect(enabled).not.toBe("");
      expect(enabled).toContain("YOUR LIFE SO FAR");

      const disabled = lifeContextSection(traj.trajId, traj.trajDir, { MONOLITH_TIERED_MEMORY: "0" }, throwingLlm(), NOW);
      expect(disabled).toBe("");
    } finally {
      cleanup();
    }
  });

  it("no rollups present (first use, under a fanout window): degrades to empty, same as a bare --raw-tail 0 with nothing sealed yet", async () => {
    // Verified against the REAL bash `bin/recap`: `recap --context --budget
    // auto --raw-tail 0 -q` on a trajectory with no sealed tier prints
    // NOTHING (raw-tail 0 is a literal "no verbatim block at all", not
    // "the unsealed remainder" — see src/recap.ts's PORT-NOTE). So a
    // genuinely young trajectory shows no life section at all until enough
    // steps land to seal a first tier — the pre-existing "young agent:
    // _life_context empty" behavior this lane's call site now reproduces
    // for the right reason instead of a hardcoded "".
    const { traj, cleanup } = makeTraj();
    try {
      appendN(traj, 3);
      const out = lifeContextSection(traj.trajId, traj.trajDir, {}, throwingLlm(), NOW);
      expect(out).toBe("");
    } finally {
      cleanup();
    }
  });

  it("recap failing (invalid budget) degrades to \"\", matching `|| _lc=\"\"`", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendN(traj, 3);
      const out = lifeContextSection(traj.trajId, traj.trajDir, { MONOLITH_CONTEXT_BUDGET: "0" }, throwingLlm(), NOW);
      expect(out).toBe("");
    } finally {
      cleanup();
    }
  });

  it("recap rollups present: a sealed tier-1 block folds in verbatim, no new llm call", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      appendN(traj, 12);
      // Seed rollups the way a real prior wake would: --backfill seals [0,10)
      // once, on-disk, exactly as the production sealing path does.
      const seed = await recordedLlm();
      const seedIo: RecapIO = {
        cwd: traj.trajDir,
        env: { TRAJ_DIR: traj.trajDir },
        stdout: () => {},
        stderr: () => {},
        now: NOW,
        runLlm: seed.runLlm,
      };
      const seedCode = runRecap([traj.trajId, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], seedIo);
      expect(seedCode).toBe(0);
      expect(seed.calls).toHaveLength(1);

      // Real bash `bin/recap --context --raw-tail 0` with a sealed tier
      // present shows ONLY the tier block — the unsealed remainder (steps
      // 10-11) does NOT also appear verbatim, since "--raw-tail 0" is a
      // literal "no verbatim block at all" (verified against real bash;
      // see src/recap.ts's PORT-NOTE and the "raw-tail default" describe
      // block below).
      const out = lifeContextSection(traj.trajId, traj.trajDir, {}, throwingLlm(), NOW);
      expect(out).toBe(
        HEADER +
          "=== YOUR LIFE SO FAR — summarized, oldest first ===\n" +
          sealedLine() + "\n"
      );
      expect(out).not.toContain("RIGHT NOW");
    } finally {
      cleanup();
    }
  });

  describe("rollup map-model precedence (1c: 3330189)", () => {
    // Two consecutive calls: the first (n=0) sets rollups/meta.json's
    // start_index to 0 (the "first use" marker snapped down from n=0); the
    // second, after `fanout` steps have landed, crosses that boundary and
    // seals — the natural (non --backfill) path a live wake takes.
    async function primeAndSeal(env: Record<string, string | undefined>): Promise<{ traj: Trajectory; cleanup: () => void; calls: string[][] }> {
      const { traj, cleanup } = makeTraj();
      // n=0 filtered steps (the trajectory's own initial `type:"trajectory"`
      // record is not a KEEP_TYPES type): still non-empty (the raw-tail
      // header always prints), but this call's only job is to persist
      // rollups/meta.json's start_index at 0 — the "first use" marker
      // snapped down from n=0 — so the SECOND call, after `fanout` steps
      // land, has a marker to build forward from.
      // Real bash: --raw-tail 0 with n=0 filtered steps and nothing sealed
      // prints nothing — verified above ("no rollups present"). The
      // meta.json start_index marker still gets persisted at 0 regardless
      // (confirmed directly against real bash's on-disk rollups/meta.json);
      // this call's output is not itself meaningful.
      const first = lifeContextSection(traj.trajId, traj.trajDir, env, throwingLlm(), NOW);
      expect(first).toBe("");
      appendN(traj, 10);
      const rec = await recordedLlm();
      const out = lifeContextSection(traj.trajId, traj.trajDir, env, rec.runLlm, NOW);
      expect(out).toContain("YOUR LIFE SO FAR");
      return { traj, cleanup, calls: rec.calls };
    }

    it("none set: falls back to recap's own default (RECAP_MODEL/SHELLM_MODEL/DEFAULT_MODEL), not SHELLM_FAST_MODEL", async () => {
      const { cleanup, calls } = await primeAndSeal({ SHELLM_MODEL: "shellm-model-x" });
      try {
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(["-m", "shellm-model-x", "-t", "4096", "-s", expect.any(String)]);
      } finally {
        cleanup();
      }
    });

    it("SHELLM_FAST_MODEL alone: used as --map-model", async () => {
      const { cleanup, calls } = await primeAndSeal({ SHELLM_FAST_MODEL: "fast-model" });
      try {
        expect(calls[0]![1]).toBe("fast-model");
      } finally {
        cleanup();
      }
    });

    it("RECAP_MAP_MODEL alone: used as --map-model", async () => {
      const { cleanup, calls } = await primeAndSeal({ RECAP_MAP_MODEL: "recap-map-model" });
      try {
        expect(calls[0]![1]).toBe("recap-map-model");
      } finally {
        cleanup();
      }
    });

    it("ROLLUP_MODEL alone: used as --map-model", async () => {
      const { cleanup, calls } = await primeAndSeal({ ROLLUP_MODEL: "rollup-model" });
      try {
        expect(calls[0]![1]).toBe("rollup-model");
      } finally {
        cleanup();
      }
    });

    it("RECAP_MAP_MODEL beats SHELLM_FAST_MODEL (3330189's fix)", async () => {
      const { cleanup, calls } = await primeAndSeal({ RECAP_MAP_MODEL: "recap-map-model", SHELLM_FAST_MODEL: "fast-model" });
      try {
        expect(calls[0]![1]).toBe("recap-map-model");
      } finally {
        cleanup();
      }
    });

    it("ROLLUP_MODEL beats both RECAP_MAP_MODEL and SHELLM_FAST_MODEL when all three are set", async () => {
      const { cleanup, calls } = await primeAndSeal({
        ROLLUP_MODEL: "rollup-model",
        RECAP_MAP_MODEL: "recap-map-model",
        SHELLM_FAST_MODEL: "fast-model",
      });
      try {
        expect(calls[0]![1]).toBe("rollup-model");
      } finally {
        cleanup();
      }
    });
  });

  describe("raw-tail default (1c: a4ed181)", () => {
    /** Seal [0,10) via --backfill, then land 3 more steps (n=13, start_index
     *  0 persisted): a fixture where recap's OWN "--raw-tail auto" default
     *  and the monolith's explicit "--raw-tail 0" default disagree, so the
     *  a4ed181 default is pinned against a real difference, not a
     *  fanout-snapping coincidence. */
    async function primeSealed(): Promise<{ traj: Trajectory; cleanup: () => void }> {
      const { traj, cleanup } = makeTraj();
      appendN(traj, 10);
      const seedIo: RecapIO = {
        cwd: traj.trajDir,
        env: { TRAJ_DIR: traj.trajDir },
        stdout: () => {},
        stderr: () => {},
        now: NOW,
        runLlm: (await recordedLlm()).runLlm,
      };
      const code = runRecap([traj.trajId, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], seedIo);
      expect(code).toBe(0);
      appendN(traj, 3, 10);
      return { traj, cleanup };
    }

    it("recap's own --raw-tail auto shows the whole trajectory verbatim (would repeat the monolith's own recent stream)", async () => {
      const { traj, cleanup } = await primeSealed();
      try {
        let out = "";
        const io: RecapIO = {
          cwd: traj.trajDir,
          env: { TRAJ_DIR: traj.trajDir },
          stdout: (s) => {
            out += s;
          },
          stderr: () => {},
          now: NOW,
          runLlm: throwingLlm(),
        };
        // No --raw-tail flag at all: recap's own "auto" default applies.
        const code = runRecap([traj.trajId, "--context"], io);
        expect(code).toBe(0);
        expect(out).toContain("=== RIGHT NOW — the last 13 steps, verbatim ===");
        expect(out).not.toContain("YOUR LIFE SO FAR"); // auto's R swallows the whole [0,13) range
      } finally {
        cleanup();
      }
    });

    it("ROLLUP_RAW_TAIL unset: the monolith explicitly passes --raw-tail 0, so ONLY the sealed block shows — the unsealed remainder does not also appear verbatim", async () => {
      // Verified against real bash: --raw-tail 0 is a literal "no verbatim
      // block at all", not "the unsealed remainder" — the 3 steps landed
      // after sealing (10, 11, 12) are simply not shown here, same as they
      // would not be shown for the 0-unsealed case above.
      const { traj, cleanup } = await primeSealed();
      try {
        const out = lifeContextSection(traj.trajId, traj.trajDir, {}, throwingLlm(), NOW);
        expect(out).toBe(
          HEADER +
            "=== YOUR LIFE SO FAR — summarized, oldest first ===\n" +
            sealedLine() + "\n"
        );
        expect(out).not.toContain("RIGHT NOW");
        expect(out).not.toContain("step 9]"); // the sealed region does not also appear verbatim
      } finally {
        cleanup();
      }
    });

    it("ROLLUP_RAW_TAIL overrides the 0 default (large enough to swallow the sealed block back into raw tail)", async () => {
      const { traj, cleanup } = await primeSealed();
      try {
        const out = lifeContextSection(traj.trajId, traj.trajDir, { ROLLUP_RAW_TAIL: "15" }, throwingLlm(), NOW);
        expect(out).not.toContain("YOUR LIFE SO FAR");
        expect(out).toContain("=== RIGHT NOW — the last 13 steps, verbatim ===");
        expect(out).toContain("[s0000000] thought: step 0");
      } finally {
        cleanup();
      }
    });
  });
});

// -----------------------------------------------------------------------------
// Prompt assembly: the life section lands exactly where
// thinkers/monolith/step:324 puts it — right before "Recent stream".
// -----------------------------------------------------------------------------

describe("runMonolithWake: life section prompt placement (1c: 3330189, a4ed181)", () => {
  it("folds the life section in immediately before 'Recent stream', matching step:324's `${life_section}Recent stream …`", async () => {
    const { identity, cleanup } = makeIdentity({ identityText: QUIET_GOALS });
    try {
      const traj = createTrajectory(identity.trajDir);
      for (let i = 0; i < 10; i++) {
        fs.appendFileSync(
          traj.trajFile,
          JSON.stringify({
            step_id: `p${String(i).padStart(2, "0")}`,
            type: "thought",
            content: `prior ${i}`,
            ts: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
          }) + "\n"
        );
      }
      // Seal [0,10) on disk first, the way a real prior wake's tiered-memory
      // sealing would: a bare, nothing-sealed-yet trajectory's life section
      // is EMPTY by design (--raw-tail 0 with nothing sealed prints nothing
      // — see monolith.test.ts's "no rollups present" case above), so this
      // placement test needs a sealed tier to have a non-empty section to
      // locate in the prompt at all.
      // The seal runs the real `recap` CLI (bin/recap → the port's `llm`) as a child process against a recorded real
      // DeepSeek window summary (test/fixtures/recordings/monolith/recap-seal.json); an async spawn, so the in-process
      // replay server can answer while recap waits on `llm`.
      const { model: recapModel, env: recapEnv } = await recordedEndpoint("monolith", "recap-seal");
      const seed = spawn(path.join(BIN_DIR, "recap"), [traj.trajId, "--context", "--backfill", "--fanout", "10", "--raw-tail", "0"], {
        cwd: identity.trajDir,
        env: { PATH: `${BIN_DIR}${path.delimiter}${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "", TRAJ_DIR: identity.trajDir, ...recapEnv },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let seedErr = "";
      seed.stderr!.on("data", (c: Buffer) => (seedErr += c.toString()));
      const seedCode = await new Promise<number | null>((r) => seed.on("close", r));
      recapModel.close();
      recapModel.verify();
      expect(seedCode, seedErr).toBe(0);
      expect(recapModel.requests.length).toBeGreaterThan(0);

      const llm = rec("quiet-idle");
      await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox: new LocalSandbox(),
        trigger: { triggerType: "monolith-wake" },
        env: {},
        recapRunLlm: () => {
          throw new Error("no NEW rollup sealing expected — [0,10) is already sealed and no fanout boundary is crossed by this wake");
        },
      });
      const steps = traj.read() as Array<Record<string, unknown>>;
      const promptStep = steps.find((s) => s["type"] === "prompt") as { content?: string } | undefined;
      expect(promptStep).toBeDefined();
      const prompt = String(promptStep!.content ?? "");
      const lifeIdx = prompt.indexOf("Your life so far (tiered summary");
      const recentIdx = prompt.indexOf("Recent stream (last");
      expect(lifeIdx).toBeGreaterThan(-1);
      expect(recentIdx).toBeGreaterThan(-1);
      // the recorded real summary is what the life section shows
      const sealed = JSON.parse(recordedText(recapModel.recording.calls[0]!)) as { summary: string };
      expect(prompt.slice(lifeIdx, recentIdx)).toContain(sealed.summary.slice(0, 60));
      expect(lifeIdx).toBeLessThan(recentIdx);
      // Nothing but the life section's own trailing blank line sits between
      // the two, matching `${life_section}Recent stream …` with no
      // interleaving separator on this port's side.
      expect(prompt.slice(0, recentIdx).endsWith("\n\n")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// synthCommand / shellm-run "command" field (bug #63)
// ---------------------------------------------------------------------------
//
// The pre-fix `synthCommand` was a fixed template: no `--context-scope run`,
// no `--var MEM_DIR=…`/`SKILLS_DIR=…`/`SKILLS_KERNEL_DIR=…`/`CHATRC=…`, and a
// stale `--bin` list that always listed `shellm` (this port ships no
// standalone `shellm` CLI at all). The fix builds the REAL argv the monolith
// caller hands `shellm` (thinkers/monolith/step:274-279,401-406,
// thinkers/_lib/common.sh:590-700 `_export_provider_keys`/
// `_export_skill_vars`/`_build_shellm_flags`) and records it through
// `redactedCmdline`/`shellmPrivateVarName` (src/shellm.ts) — the exact
// bin/shellm:3035-3051 `_redacted_cmdline`/`_shellm_private_var_name` port —
// giving those two functions their first real caller.

const CMD_HEX8 = "aaaaaaaa";
const CMD_FIXTURE_TRAJ_ID = `${CMD_HEX8}-bbbb-cccc-dddd-eeeeeeeeeeee`;

function makeCommandFixture(): {
  identity: IdentityConfig;
  identityDir: string;
  hostEnv: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monolith-command-"));
  const identityDir = path.join(root, "id");
  const trajDir = path.join(identityDir, "trajectories");
  const memDir = path.join(identityDir, "memories");
  const skillsDir = path.join(identityDir, "skills");
  const kernelDir = path.join(identityDir, "kernel");
  const chatDir = path.join(identityDir, "chat");
  const toolbin = path.join(root, "toolbin");
  for (const d of [trajDir, memDir, skillsDir, kernelDir, chatDir, toolbin]) fs.mkdirSync(d, { recursive: true });

  // A skill declaring an env: var — exercises the bare `--var NAME` skill-var
  // branch (common.sh:665-677), sorted after the provider-key branch.
  fs.mkdirSync(path.join(skillsDir, "obsidian-test"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "obsidian-test", "SKILL.md"),
    '---\nname: obsidian-test\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["OBSIDIAN_VAULT"]\n---\nbody\n'
  );

  // Only the tools this port actually ships (no `shellm` — see the
  // BIN_TOOL_NAMES note in src/monolith.ts) — this port's own analogue of
  // upstream's `command -v` check.
  for (const t of ["mem", "traj", "skills", "context", "llm", "chat", "recap"]) {
    const p = path.join(toolbin, t);
    fs.writeFileSync(p, "#!/usr/bin/env bash\ntrue\n");
    fs.chmodSync(p, 0o755);
  }

  fs.mkdirSync(path.join(trajDir, `${CMD_HEX8}-root`), { recursive: true });
  fs.writeFileSync(path.join(trajDir, `${CMD_HEX8}-root`, "trajectory.jsonl"), '{"type":"trajectory"}\n');

  const workdir = path.join(identityDir, ".shellm", "workdirs", `${CMD_HEX8}-root`);
  fs.mkdirSync(workdir, { recursive: true });
  const stateDir = path.join(identityDir, "run");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "dispatcher.token"), "1.0.0");

  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax.",
    skillsText: "(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: toolbin,
    stateDir,
    model: "test-model",
    env: { name: "pax", type: "local" },
    execEnv: {
      MEM_DIR: memDir,
      SKILLS_DIR: skillsDir,
      CHATRC: path.join(chatDir, ".chatrc"),
      SHELLM_MODEL: "test-model",
      LLM_PROVIDER: "openai-compatible",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      OBSIDIAN_VAULT: "/tmp/vault",
    },
    skillVarMounts: [{ name: "OBSIDIAN_VAULT", value: "/tmp/vault" }],
  };

  const hostEnv: NodeJS.ProcessEnv = { SKILLS_KERNEL_DIR: kernelDir };
  return { identity, identityDir, hostEnv, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function recordedCommandFor(identity: IdentityConfig, hostEnv: NodeJS.ProcessEnv): Promise<string> {
  const traj = openTrajectory(identity.trajDir, CMD_FIXTURE_TRAJ_ID);
  const llm = rec("quiet-idle");
  await runMonolithWake({
    trajectory: traj,
    identity,
    llm,
    sandbox: new LocalSandbox(),
    trigger: { triggerType: "" },
    env: hostEnv,
  });
  const steps = traj.read() as Array<Record<string, unknown>>;
  const header = steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>;
  return String(header["command"]);
}

describe("synthCommand / shellm-run command field (bug #63)", () => {
  it("records the real shellm argv, not the old fixed template", async () => {
    const { identity, identityDir, hostEnv, cleanup } = makeCommandFixture();
    try {
      const command = await recordedCommandFor(identity, hostEnv);
      const binFlags = ["mem", "traj", "skills", "context", "llm", "chat", "recap"]
        .map((t) => `--bin ${path.join(identity.binDir, t)}`)
        .join(" ");
      const expected =
        `shellm --model test-model --traj ${CMD_FIXTURE_TRAJ_ID} --context-scope run ` +
        `--env pax --workdir ${identity.workdir} ` +
        `--var IDENTITY_NAME=pax ` +
        `--var MEM_DIR=${path.join(identityDir, "memories")} ` +
        `--var SKILLS_DIR=${path.join(identityDir, "skills")} ` +
        `--var SKILLS_KERNEL_DIR=${path.join(identityDir, "kernel")} ` +
        `--var TRAJ_DIR=${identity.trajDir} ` +
        `--var TRAJ_ID=${CMD_FIXTURE_TRAJ_ID} ` +
        `--var CHATRC=${path.join(identityDir, "chat", ".chatrc")} ` +
        `--var SHELLM_MODEL=test-model --var LLM_PROVIDER=openai-compatible ` +
        `--var ANTHROPIC_API_KEY --var OBSIDIAN_VAULT ` +
        `${binFlags} --prompt-file <monolith_prompt>`;
      expect(command).toBe(expected);
      // `shellm` never appears as a --bin value — this port ships no
      // standalone shellm CLI (the stale template used to list it anyway).
      expect(command).not.toContain(`--bin ${path.join(identity.binDir, "shellm")}`);
      // Provider-key/skill-var VALUES never reach argv (bare NAME form only).
      expect(command).not.toContain("test-anthropic-key");
      expect(command).not.toContain("/tmp/vault");
    } finally {
      cleanup();
    }
  });
});

describe.skipIf(!process.env["PARITY_UPSTREAM_ROOT"])(
  "same fixture through the real upstream thinkers/_lib/common.sh + bin/shellm functions (Bash oracle, PARITY_UPSTREAM_ROOT)",
  () => {
    const upstreamRoot = process.env["PARITY_UPSTREAM_ROOT"] ?? "";

    // Sources common.sh, then extracts JUST the two argv-redaction functions
    // from bin/shellm without executing the whole file (it unconditionally
    // calls `main "$@"` at EOF) — real upstream logic, no reimplementation.
    const ORACLE_SCRIPT = `
set -euo pipefail
source "$1/thinkers/_lib/common.sh"
eval "$(sed -n '/^_shellm_private_var_name() {/,/^}/p' "$1/bin/shellm")"
eval "$(sed -n '/^_redacted_cmdline() {/,/^}/p' "$1/bin/shellm")"
_export_provider_keys
_export_skill_vars "$2"
shellm_flags=()
while IFS= read -r _flag; do
    [[ -n "$_flag" ]] && shellm_flags+=("$_flag")
done < <(_build_shellm_flags "$2" "$3")
argv=(--model "$4" --traj "$TRAJ_ID" --context-scope run "\${shellm_flags[@]}" --prompt-file "<monolith_prompt>")
_redacted_cmdline "\${argv[@]}"
`;

    it("byte-identical to the real _build_shellm_flags/_redacted_cmdline output for the same fixture", async () => {
      const { identity, identityDir, hostEnv, cleanup } = makeCommandFixture();
      try {
        const command = await recordedCommandFor(identity, hostEnv);

        const r = spawnSync("bash", ["-c", ORACLE_SCRIPT, "bash", upstreamRoot, identityDir, identity.workdir, "test-model"], {
          encoding: "utf8",
          env: {
            PATH: `${identity.binDir}:/usr/bin:/bin:/usr/local/bin`,
            HOME: os.homedir(),
            IDENTITY_NAME: "pax",
            MEM_DIR: path.join(identityDir, "memories"),
            SKILLS_DIR: path.join(identityDir, "skills"),
            SKILLS_KERNEL_DIR: path.join(identityDir, "kernel"),
            TRAJ_DIR: identity.trajDir,
            TRAJ_ID: CMD_FIXTURE_TRAJ_ID,
            CHATRC: path.join(identityDir, "chat", ".chatrc"),
            SHELLM_MODEL: "test-model",
            LLM_PROVIDER: "openai-compatible",
            ANTHROPIC_API_KEY: "test-anthropic-key",
            OBSIDIAN_VAULT: "/tmp/vault",
          },
        });
        expect(r.status, r.stderr).toBe(0);
        const oracleCommand = r.stdout.trim();
        expect(command).toBe(oracleCommand);
      } finally {
        cleanup();
      }
    });
  }
);
