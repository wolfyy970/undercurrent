// topology.test.ts — slice 2 proof: the DISPATCHER + TWO-THINKER topology over
// ONE stream, replaying the real golden traces (DoD).
//
// The trait the prior text-only port missed entirely: an inbound message → a
// fast responder reply (or its NO_REPLY silence) → the responder's observation
// reactively wakes the monolith, which deliberates but does not reply. We assert
// on STRUCTURE (step types, sources, ordering, causal wake) and key semantics —
// not nondeterministic text — with the model served by a local HTTP fixture so the
// cascades replay deterministically. Golden references:
//   trace-02 — NO_REPLY on a bare "thanks" + reactive wake (the headline)
//   trace-01 — repeated spontaneous timer wakes with backoff spacing
//   trace-04 — the weather delivery-gap seam (documented faithfully, not fixed)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrajectory } from "../src/trajectory.js";
import { createTwoThinkerSystem, type TwoThinkerSystem } from "../src/topology.js";
import { LocalSandbox } from "../src/sandbox.js";
import { type LlmClient } from "../src/llm.js";
import type { IdentityConfig } from "../src/monolith.js";
import { isolateWake, loadTrace } from "./golden.js";
import type { Step } from "../src/types.js";
import { httpModel } from "./support/modelHttpFixture.js";
import { recordedModel, recordedText, type RecordedModel } from "./support/recordedModel.ts";
import { claimFixedRoot, holdFixedRoot } from "./support/fixedRoot.ts";

const BIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");

// ---- recorded model replies ------------------------------------------------
//
// Every model reply here is recorded real DeepSeek output (test/fixtures/recordings/topology/, test/support/README.md):
// the monolith's wakes on the openai wire, the responder's answers in plain mode. Each test's identity text sets
// the scene the recorded replies answered.

const mono = (scenario: string): RecordedModel => recordedModel("topology", `${scenario}-monolith`);
const resp = (scenario: string): RecordedModel => recordedModel("topology", `${scenario}-responder`, { mode: "plain" });
const QUIET_TEXT =
  'I am pax, a persistent virtual person for the parity test. Test harness note for every wake: there is nothing to do. Do not run any command and do not append any step. Reply with exactly one bash block whose only line is FINAL="idle".';
const WEATHER_TEXT =
  "I am pax, a persistent virtual person for the parity test. My workspace has today's local weather report in ./weather.txt (`cat ./weather.txt` prints it); I have no network access.";

// ---- system harness -------------------------------------------------------

interface Parts {
  identity: IdentityConfig;
  trajDir: string;
  stateDir: string;
  cleanup: () => void;
}

// The recorded replies name the root literally (`cd /tmp/uc-rec-topology/workdir`), so it has to stay fixed. Two
// suites running at once on one machine used to delete each other's trajectory mid-test (trace-01 saw 1 wake of 6).
// The file holds the root's lock for its whole run (test/support/fixedRoot.ts, waiting on a filesystem event).
const ROOT = "/tmp/uc-rec-topology";
let releaseRoot: () => void = () => {};
beforeAll(async () => {
  releaseRoot = await holdFixedRoot(ROOT);
}, 300_000);
afterAll(() => releaseRoot());

function makeParts(): Parts {
  // A fixed root (literal /tmp on Linux and macOS): the wake prompt names these paths and a recorded reply may use them.
  const root = ROOT;
  claimFixedRoot(root);
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax, a persistent virtual person for the parity test.",
    skillsText: "## My skills system\n(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: BIN_DIR,
    stateDir,
    model: "deepseek/deepseek-v4-flash-0731",
    env: { name: "pax", type: "docker", docker_image: "ubuntu:latest", docker_access: "none" },
  };
  return { identity, trajDir, stateDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function buildSystem(
  parts: Parts,
  monolithLlm: LlmClient,
  responderLlm: LlmClient,
  nowRef: { ms: number }
): { system: TwoThinkerSystem; steps: () => Step[] } {
  const traj = createTrajectory(parts.trajDir);
  // A couple of boot seed thoughts, like a freshly-booted mind.
  traj.append({ type: "thought", content: "I'm here.", source: "seed" });
  const system = createTwoThinkerSystem({
    trajectory: traj,
    identity: parts.identity,
    monolithLlm,
    responderLlm,
    sandbox: new LocalSandbox(),
    now: () => nowRef.ms,
    // Keep a reactive wake bounded and cheap; the golden reactive wakes are
    // multi-turn but the topology (not turn count) is what we assert.
    monolithConstants: { maxIterations: 4 },
  });
  return { system, steps: () => system.trajectory.read() };
}

// Helpers over the resulting stream.
const typeOf = (s: Step) => String((s as { type?: string }).type ?? "");
const srcOf = (s: Step) => String((s as { source?: string }).source ?? "");
function wakesOf(steps: Step[]) {
  return steps.filter((s) => typeOf(s) === "shellm-run") as (Step & Record<string, unknown>)[];
}

// ===========================================================================
// trace-02 — the headline: NO_REPLY silence + reactive monolith wake
// ===========================================================================

describe("trace-02: NO_REPLY silence + reactive monolith wake (single stream)", () => {
  it("responder CHOOSES SILENCE on a bare 'thanks' — a no-reply observation, no message step", async () => {
    const parts = makeParts();
    const now = { ms: 1_756_000_000_000 };
    // responder: one NO_REPLY. monolith (woken by the no-reply observation):
    // deliberates once, no reply.
    const m = mono("thanks"), r = resp("thanks");
    const { system, steps } = buildSystem(parts, m, r, now);
    try {
      const msgId = system.inject({
        from: "operator",
        to: "pax",
        content: "thanks, that's all I needed for now",
      });
      await system.settle();

      const all = steps();
      m.verify();
      r.verify();
      expect(recordedText(r.recording.calls.at(-1)!).trim()).toBe("NO_REPLY"); // the model really chose silence

      // The responder claimed, then recorded a no-reply DECISION observation
      // keyed to the trigger — silence is a decision, not an absence.
      const claim = all.find((s) => typeOf(s) === "reply_claim") as Record<string, unknown> | undefined;
      expect(claim).toBeDefined();
      expect(claim!["source"]).toBe("responder");
      expect(claim!["trigger_step"]).toBe(msgId);

      const noReply = all.find(
        (s) => typeOf(s) === "observation" && srcOf(s) === "responder"
      ) as Record<string, unknown> | undefined;
      expect(noReply).toBeDefined();
      expect(noReply!["decision"]).toBe("no-reply");
      expect(noReply!["trigger_step"]).toBe(msgId);

      // THE SILENCE: the responder sent NOTHING. The only message on the stream
      // is the inbound one; there is no reply message from pax.
      const messages = all.filter((s) => typeOf(s) === "message") as Record<string, unknown>[];
      expect(messages.length).toBe(1);
      expect(messages[0]!["from"]).toBe("operator");
      expect(all.some((s) => typeOf(s) === "message" && (s as { from?: string }).from === "pax")).toBe(
        false
      );

      // REACTIVE WAKE: the no-reply observation reactively woke the monolith.
      const wakes = wakesOf(all);
      expect(wakes.length).toBe(1);
      const wake = wakes[0]!;
      expect(wake["wake"]).toBe("reactive/observation:responder");
      expect(wake["trigger_step"]).toBe(noReply!["step_id"]);
      expect(wake["launched_by"]).toBe("monolith");

      // Matches the golden trace-02 reactive-wake shape (the real capture).
      const goldenReactive = wakesOf(loadTrace("trace-02-no-reply-and-reactive.jsonl")).find(
        (w) => w["wake"] === "reactive/observation:responder"
      )!;
      expect(wake["wake"]).toBe(goldenReactive["wake"]);
      expect(wake["launched_by"]).toBe(goldenReactive["launched_by"]);

      // The monolith deliberated (a reasoning/shell-output pair ran) but did NOT
      // reply: no message step belongs to its run.
      const monoWake = isolateWake(all, 0);
      expect(monoWake.stepTypes).toContain("reasoning");
      expect(monoWake.stepTypes).toContain("shell-output");
      expect(monoWake.stepTypes).not.toContain("message");

      // ONE single append-only stream carries BOTH thinkers' steps: the file on
      // disk holds the responder's reply_claim/observation AND the monolith's
      // shellm-run, in one append-only log (no forked/second stream).
      expect(all.some((s) => srcOf(s) === "responder")).toBe(true);
      expect(all.some((s) => typeOf(s) === "shellm-run")).toBe(true);
      const onDiskLines = fs.readFileSync(system.trajectory.trajFile, "utf8").trim().split("\n").length;
      expect(all.length).toBe(onDiskLines);
    } finally {
      parts.cleanup();
    }
  }, 30_000);

  it("a substantive message → responder replies → the replied observation reactively wakes the monolith", async () => {
    const parts = makeParts();
    const now = { ms: 1_756_000_000_000 };
    const m = mono("tools"), r = resp("tools");
    const { system, steps } = buildSystem(parts, m, r, now);
    try {
      const msgId = system.inject({ from: "operator", to: "pax", content: "Hi Again. Do you have any tools?" });
      await system.settle();
      const all = steps();
      m.verify();
      r.verify();

      // Responder: claim → reply message (stamped reply_to = the inbound id) →
      // replied observation. Exactly the trace-02 chat-turn shape.
      const claim = all.find((s) => typeOf(s) === "reply_claim") as Record<string, unknown>;
      expect(claim["trigger_step"]).toBe(msgId);

      const reply = all.find(
        (s) => typeOf(s) === "message" && (s as { from?: string }).from === "pax"
      ) as Record<string, unknown>;
      expect(reply).toBeDefined();
      expect(reply["to"]).toBe("operator");
      expect(reply["source"]).toBe("chat");
      expect(reply["reply_to"]).toBe(msgId);
      expect(String(reply["content"]).trim()).toBe(recordedText(r.recording.calls.at(-1)!).trim());

      const repliedObs = all.find(
        (s) => typeOf(s) === "observation" && srcOf(s) === "responder"
      ) as Record<string, unknown>;
      expect(repliedObs["decision"]).toBe("replied");
      expect(repliedObs["trigger_step"]).toBe(msgId);

      // Ordering: claim precedes reply precedes observation precedes the wake.
      const idx = (pred: (s: Step) => boolean) => all.findIndex(pred);
      const iClaim = idx((s) => typeOf(s) === "reply_claim");
      const iReply = idx((s) => typeOf(s) === "message" && (s as { from?: string }).from === "pax");
      const iObs = idx((s) => typeOf(s) === "observation" && srcOf(s) === "responder");
      const iWake = idx((s) => typeOf(s) === "shellm-run");
      expect(iClaim).toBeLessThan(iReply);
      expect(iReply).toBeLessThan(iObs);
      expect(iObs).toBeLessThan(iWake);

      // Reactive wake triggered by the REPLIED observation.
      const wake = wakesOf(all)[0]!;
      expect(wake["wake"]).toBe("reactive/observation:responder");
      expect(wake["trigger_step"]).toBe(repliedObs["step_id"]);

      // The monolith deliberated but did not itself send a chat message.
      const monoWake = isolateWake(all, 0);
      expect(monoWake.stepTypes).not.toContain("message");
    } finally {
      parts.cleanup();
    }
  }, 30_000);
});

// ===========================================================================
// trace-01 — repeated spontaneous timer wakes with backoff spacing
// ===========================================================================

describe("trace-01: repeated spontaneous timer wakes with backoff spacing", () => {
  it("the dispatcher fires wake_at timer wakes; the armed delays follow the backoff ladder", async () => {
    const parts = makeParts();
    const now = { ms: 1_000_000_000 }; // T0 = 1_000_000 s
    parts.identity.identityText = QUIET_TEXT;
    const m = mono("timer");
    // The responder is never consulted: an HTTP fixture with no replies (not model output) fails any call.
    const { system, steps } = buildSystem(parts, m, httpModel([]), now);
    const wakeAtFile = path.join(parts.stateDir, "monolith.wake_at");
    const readWakeAt = () => Number(fs.readFileSync(wakeAtFile, "utf8").trim());

    try {
      // Boot kick (thinkers trigger) — the first, manual, wake. It idles and
      // arms wake_at; from there the dispatcher owns the clock.
      system.boot("monolith");
      await system.settle();

      const armedDelays: number[] = [];
      armedDelays.push(readWakeAt() - Math.floor(now.ms / 1000)); // after the boot wake

      // Five subsequent timer wakes: advance the clock just past the armed
      // wake_at, tick (fires the due monolith-wake), settle, record the delay.
      for (let k = 0; k < 5; k++) {
        now.ms = (readWakeAt() + 1) * 1000;
        system.tick(Math.floor(now.ms / 1000));
        await system.settle();
        armedDelays.push(readWakeAt() - Math.floor(now.ms / 1000));
      }

      // Backoff ladder (HOLD=3 at level 0, then BASE=5, ×FACTOR 2): the empty
      // spontaneous wakes dwell three times at 0, step to 5, dwell, step to 10.
      m.verify();
      expect(m.requests).toHaveLength(6);
      expect(armedDelays).toEqual([0, 0, 5, 5, 5, 10]);

      // Six wakes total: the first is the manual boot; the other five are
      // dispatcher-fired timer wakes (source monolith-timer → spontaneous/timer).
      const wakes = wakesOf(steps());
      expect(wakes.length).toBe(6);
      expect(wakes[0]!["wake"]).toBe("spontaneous/manual-trigger:thinkers-cli");
      for (const w of wakes.slice(1)) expect(w["wake"]).toBe("spontaneous/timer");

      // The trace-01 golden capture shows the same wake vocabulary.
      const goldenWakes = wakesOf(loadTrace("trace-01-live-snapshot-convo-and-timer-wakes.jsonl"));
      expect(goldenWakes.some((w) => w["wake"] === "spontaneous/timer")).toBe(true);
      expect(
        system.log.filter((e) => e.kind === "scheduled-wake" && e.name === "monolith").length
      ).toBe(5);
    } finally {
      parts.cleanup();
    }
  }, 45_000);
});

// ===========================================================================
// trace-04 — the weather delivery-gap (documented faithfully, NOT fixed)
// ===========================================================================

describe("trace-04: weather delivery-gap — closed by the DEFER handoff (2e39a3f)", () => {
  // The golden trace-04 capture shows the old seam: the responder promised, a monolith wake fetched the weather, and
  // nothing delivered it. On the current prompts the recorded real responder DEFERS instead (an `action` with the
  // request), and the monolith delivers the result itself with `chat reply --follow-up`. This test pins that.
  it("responder defers (holding message + action); a reactive monolith wake reads the weather and delivers it", async () => {
    const parts = makeParts();
    const now = { ms: 1_756_000_000_000 };
    parts.identity.identityText = WEATHER_TEXT;
    fs.writeFileSync(path.join(parts.identity.workdir, "weather.txt"), "Springfield now: 81°F, feels 88°F, Partly Cloudy, humidity 85%\n");
    const m = mono("weather"), r = resp("weather");
    const { system, steps } = buildSystem(parts, m, r, now);
    try {
      const msgId = system.inject({ from: "operator", to: "pax", content: "Whats the weather today in Springfield?" });
      await system.settle();
      const all = steps();
      m.verify();
      r.verify();
      const fromPax = all.filter((s) => typeOf(s) === "message" && (s as { from?: string }).from === "pax") as Record<string, unknown>[];

      // 1) The RESPONDER deferred: its recorded answer is `DEFER: <request>` + a holding message.
      const answer = recordedText(r.recording.calls.at(-1)!);
      expect(answer).toMatch(/^DEFER: /);
      expect(fromPax[0]!["reply_to"]).toBe(msgId);
      expect(answer).toContain(String(fromPax[0]!["content"]).trim());
      const action = all.find((s) => typeOf(s) === "action" && srcOf(s) === "responder") as Record<string, unknown>;
      expect(action).toBeDefined();
      const repliedObs = all.find((s) => typeOf(s) === "observation" && srcOf(s) === "responder") as Record<string, unknown>;
      expect(repliedObs["decision"]).toBe("replied");

      // 2) The action reactively woke the monolith, which read the weather in bash.
      const wakes = wakesOf(all);
      expect(wakes[0]!["wake"]).toBe("reactive/action:responder");
      expect(wakes[0]!["launched_by"]).toBe("monolith");
      const weatherOut = all.find((s) => typeOf(s) === "shell-output" && String((s as Record<string, unknown>)["stdout"]).includes("81°F")) as Record<string, unknown>;
      expect(weatherOut).toBeDefined();
      expect(weatherOut["exit"]).toBe(0);

      // 3) THE GAP IS CLOSED: a monolith run delivered the result as a second message from pax.
      expect(fromPax).toHaveLength(2);
      expect(String(fromPax[1]!["content"])).toContain("81");
      expect(all.findIndex((s) => s === (fromPax[1] as unknown))).toBeGreaterThan(all.findIndex((s) => typeOf(s) === "shellm-run"));

      // The golden trace-04 capture still shows the old seam: a reactive monolith wake with no message step inside.
      const goldenWake = isolateWake(loadTrace("trace-04-weather-delivery-gap.jsonl"), 0);
      expect((goldenWake.header as Record<string, unknown>)["wake"]).toBe("reactive/observation:responder");
      expect(goldenWake.stepTypes).not.toContain("message");
    } finally {
      parts.cleanup();
    }
  }, 30_000);
});
