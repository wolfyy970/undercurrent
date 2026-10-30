// responder-integration.test.ts — end-to-end runResponder scenarios ported
// from upstream's tests/test_responder_metrics.sh, test_responder_deferral.sh,
// test_responder_thread_context.sh, and test_responder_person_notes.sh
// (design/conversation_memory.md, parts 1/2/4/5/6). Drives runResponder
// against a REAL on-disk trajectory (raw-seeded so historical messages can
// carry a controlled `ts`, since trajCore always stamps `append()` with the
// current wall clock). The model is recorded real DeepSeek output
// (test/fixtures/recordings/responder-integration/, test/support/README.md) replayed over LLM_API_URL to the port's
// `llm`; each recorded reply answers the conversation the test seeds. Upstream's own tests use a scripted `llm`.

import { describe, it, expect } from "vitest";
import { recordedModel, recordedText, RECORD_MODEL, type RecordedModel } from "./support/recordedModel.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrajectory, type Trajectory } from "../src/trajectory.js";
import { runResponder, interpretReply, RESPONDER_NOTES_SCRIPT, type ResponderTrigger, type SpawnDetachedOptions } from "../src/responder.js";
// The responder's deferral parse (interpretReply, plain-text mode) as {deferred, request, holding}.
function parseDeferral(text: string): { deferred: boolean; request: string; holding: string } {
  const r = interpretReply(text, { structured: false, triggerContent: "", msgFrom: "" });
  return r.kind === "send" ? { deferred: r.deferred, request: r.deferredRequest, holding: r.text } : { deferred: false, request: "", holding: "" };
}
import type { LlmClient, ChatMessage, LlmResponse } from "../src/llm.js";
import { pendingRequestHint } from "../src/monolith.js";

function makeTraj(): { traj: Trajectory; memDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resp-int-"));
  const trajDir = path.join(root, "trajectories");
  const traj = createTrajectory(trajDir);
  const memDir = path.join(root, "memories");
  return { traj, memDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function appendRaw(traj: Trajectory, rec: Record<string, unknown>): void {
  fs.appendFileSync(traj.trajFile, JSON.stringify(rec) + "\n");
}

const ago = (secs: number) => new Date(Date.now() - secs * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

let seq = 0;
function msg(traj: Trajectory, from: string, to: string, content: string, secsAgo: number): ResponderTrigger {
  const step_id = `m-${++seq}`;
  const ts = ago(secsAgo);
  appendRaw(traj, { step_id, type: "message", from, to, content, ts, source: "chat" });
  return { type: "message", step_id, from, to, content, ts, source: "chat" };
}
function thought(traj: Trajectory, content: string): void {
  appendRaw(traj, { step_id: `t-${++seq}`, type: "thought", content, ts: ago(1), source: "monolith" });
}

/** A recorded real responder conversation (plain mode, as the responder runs). Person-notes recordings add the
 *  notes writer's real call after the reply. */
const Rec = (suite: string, scenario: string): RecordedModel => recordedModel(suite, scenario, { mode: "plain" });
const Recorded = (scenario: string) => Rec("responder-integration", scenario);
/** The model's final visible reply text in a recording (the last call that answered with text). */
const lastReply = (m: RecordedModel, systemMarker?: string): string => {
  const calls = m.recording.calls.filter((c, i) => {
    if (c.response.status !== 200) return false;
    const sys = ((m.recording.calls[i]!.request["messages"] as ChatMessage[]) ?? []).find((x) => x.role === "system")?.content ?? "";
    return systemMarker === undefined ? !String(sys).includes("private notes") : String(sys).includes(systemMarker);
  });
  return recordedText(calls.at(-1)!).trim();
};

function obsFor(traj: Trajectory, triggerStepId: string): Record<string, unknown> | undefined {
  const rows = traj
    .read()
    .filter(
      (s) =>
        (s as Record<string, unknown>)["type"] === "observation" &&
        (s as Record<string, unknown>)["source"] === "responder" &&
        (s as Record<string, unknown>)["trigger_step"] === triggerStepId &&
        (s as Record<string, unknown>)["decision"] !== undefined
    ) as Record<string, unknown>[];
  return rows[rows.length - 1];
}

// --- part 6: context metrics -------------------------------------------------

describe("responder metrics (part 6)", () => {
  it("an active conversation: context_msgs/context_steps/gap_s/compose_ms/model/history_source say what was in the prompt", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      msg(traj, "nick", "testid", "how is the bridge work going", 3600);
      msg(traj, "testid", "nick", "about half done", 3500);
      thought(traj, "musing 1");
      const trig = msg(traj, "nick", "testid", "any update", 0);

      await runResponder({
        trajectory: traj,
        llm: Recorded("any-update"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        trigger: trig,
      });

      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["decision"]).toBe("replied");
      expect(obs["context_msgs"]).toBe(2);
      expect(obs["history_source"]).toBe("index");
      expect(obs["model"]).toBe(RECORD_MODEL);
      expect(typeof obs["compose_ms"]).toBe("number");
      const gap = obs["gap_s"] as number;
      expect(gap).toBeGreaterThanOrEqual(3495);
      expect(gap).toBeLessThanOrEqual(3510);
      const steps = obs["context_steps"] as string[];
      expect(steps).toContain(trig.step_id);
    } finally {
      cleanup();
    }
  });

  it("mind activity (40 thoughts) no longer evicts the conversation — the fix parts 1+2 exist for", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      msg(traj, "nick", "testid", "how is the bridge work going", 3600);
      msg(traj, "testid", "nick", "about half done", 3500);
      for (let i = 0; i < 40; i++) thought(traj, `pad ${i}`);
      const trig = msg(traj, "nick", "testid", "still there?", 5);

      await runResponder({
        trajectory: traj,
        llm: Recorded("still-there"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        trigger: trig,
      });

      const obs = obsFor(traj, trig.step_id!)!;
      // Under the OLD (pre-sync) window-only behaviour, 40 intervening thoughts
      // would push both earlier messages out of a 20-step tail and context_msgs
      // would be 0 — the exact forgetting problem this plan fixes.
      expect(obs["context_msgs"] as number).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it("beyond the 7-day history window: context_msgs 0, gap_s still measured from the raw stream", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      msg(traj, "oldfriend", "testid", "remember me?", 8 * 86400);
      msg(traj, "testid", "oldfriend", "of course", 8 * 86400 - 60);
      const trig = msg(traj, "oldfriend", "testid", "sure!", 0);

      await runResponder({
        trajectory: traj,
        llm: Recorded("sure"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        trigger: trig,
      });

      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["context_msgs"]).toBe(0);
      const gap = obs["gap_s"] as number;
      expect(gap).toBeGreaterThanOrEqual(8 * 86400 - 120);
      expect(gap).toBeLessThanOrEqual(8 * 86400 + 60);
    } finally {
      cleanup();
    }
  });

  it("NO_REPLY still carries the metrics", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      const trig = msg(traj, "nick", "testid", "thanks", 0);
      const llm = Recorded("thanks");
      await runResponder({
        trajectory: traj,
        llm,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        trigger: trig,
      });
      const obs = obsFor(traj, trig.step_id!)!;
      expect(lastReply(llm)).toBe("NO_REPLY"); // the model really chose silence
      expect(obs["decision"]).toBe("no-reply");
      expect(typeof obs["context_msgs"]).toBe("number");
      expect(typeof obs["compose_ms"]).toBe("number");
      expect(obs["model"]).toBe(RECORD_MODEL);
    } finally {
      cleanup();
    }
  });

  it("first contact: no gap_s, context_msgs 0", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      const trig = msg(traj, "stranger", "testid", "hello there", 0);
      await runResponder({
        trajectory: traj,
        llm: Recorded("hello-there"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        trigger: trig,
      });
      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["gap_s"]).toBeUndefined();
      expect(obs["context_msgs"]).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// --- part 5: deferrals -------------------------------------------------------

describe("responder deferral (part 5)", () => {
  it("a DEFER reply sends the holding message, appends an action before it, and marks the observation deferred", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      // Work only the mind can do (the responder has no tools): the recorded real answer defers it.
      const trig = msg(traj, "andy", "testid", "can you check how the telegram bridge work is going and tell me?", 0);
      const llm = Recorded("bridge-status-defer");
      await runResponder({
        trajectory: traj,
        llm,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        personNotes: false,
        trigger: trig,
      });

      const want = parseDeferral(lastReply(llm));
      expect(want.deferred).toBe(true); // the recorded real answer opens with DEFER:
      const [deferLine, holdingLine] = lastReply(llm).split("\n");
      expect(want.request).toBe(deferLine!.replace(/^DEFER:\s*/, ""));
      expect(want.holding).toBe(holdingLine!.trim());
      const steps = traj.read() as unknown as Record<string, unknown>[];
      const sent = steps.filter((s) => s["type"] === "message" && s["from"] === "testid" && s["reply_to"] === trig.step_id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!["content"]).toBe(want.holding);

      const action = steps.filter((s) => s["type"] === "action" && s["source"] === "responder").at(-1)!;
      expect(action["trigger_step"]).toBe(trig.step_id);
      expect(action["person"]).toBe("andy");
      expect(action["request"]).toBe(want.request);
      expect(action["content"]).toContain(`chat reply --follow-up --reply-to ${trig.step_id} andy`);
      expect(action["content"]).toContain(`resolves=${trig.step_id}`);

      // the action is appended BEFORE the holding message
      const actionIdx = steps.indexOf(action);
      const msgIdx = steps.indexOf(sent[0]!);
      expect(actionIdx).toBeLessThan(msgIdx);

      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["decision"]).toBe("replied");
      expect(obs["deferred"]).toBe(true);
      expect(typeof obs["context_msgs"]).toBe("number");

      // the monolith's routing hint now shows the pending request — read
      // from the `chat pending` deferrals index over the whole trajectory
      // (1c: 2fed66c), not the bounded recentContext window.
      const hint = pendingRequestHint(traj.trajFile);
      expect(hint).toContain(`PENDING REQUEST from andy: ${want.request.slice(0, 40)}`);
      expect(hint).toContain(`chat reply --follow-up --reply-to ${trig.step_id} andy`);

      // resolving it clears the hint
      appendRaw(traj, { step_id: "resolve-1", type: "observation", content: "delivered", source: "monolith", resolves: trig.step_id, ts: ago(0) });
      const hint2 = pendingRequestHint(traj.trajFile);
      expect(hint2).toBe("");
    } finally {
      cleanup();
    }
  });

  it("a bare DEFER with nothing under it sends the default holding line (parser, no model)", () => {
    const d = parseDeferral("DEFER: read the latest commit and summarize it");
    expect(d).toEqual({ deferred: true, request: "read the latest commit and summarize it", holding: "Let me look into that and get back to you." });
    expect(parseDeferral("Any time.")).toEqual({ deferred: false, request: "", holding: "Any time." });
  });

  it("a normal reply appends no action and is not marked deferred", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      const trig = msg(traj, "andy", "testid", "thanks! quick one: what time zone do you keep?", 0);
      const llm = Recorded("thanks-and-question");
      await runResponder({
        trajectory: traj,
        llm,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        personNotes: false,
        trigger: trig,
      });
      const steps = traj.read() as unknown as Record<string, unknown>[];
      expect(parseDeferral(lastReply(llm)).deferred).toBe(false); // the recorded real answer is a plain reply
      expect(lastReply(llm)).not.toBe("NO_REPLY");
      expect(steps.filter((s) => s["type"] === "action").length).toBe(0);
      const obs = obsFor(traj, trig.step_id!)!;
      expect("deferred" in obs).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// --- thread context -----------------------------------------------------------

describe("responder thread context", () => {
  const ME = "testid";
  const ANDY = "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149";
  const BRADEN = "slack-U095QV3JKA6-C0BMVH6LM4K-1787508187.726149";
  const BRADEN_DM = "slack-U095QV3JKA6-D0BN1QD7D2N";

  it("Braden's trigger in the shared thread sees Andy's thread messages as user turns", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      msg(traj, ANDY, ME, "can you paste the tweet into the channel?", 600);
      msg(traj, ME, ANDY, "Sure, posting it now.", 590);
      msg(traj, BRADEN, ME, "unrelated: how was the eval run?", 300000);
      const trig = msg(traj, BRADEN, ME, "wait, which tweet?", 0);

      await runResponder({
        trajectory: traj,
        llm: Recorded("which-tweet"),
        identityName: ME,
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        personNotes: false,
        trigger: trig,
      });

      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["context_msgs"]).toBe(3); // Braden's own b0 + Andy's a1 + our r1
      expect(obs["thread_msgs"]).toBe(2); // Andy's message + our reply to him
    } finally {
      cleanup();
    }
  });

  it("a DM trigger from Braden gets his own history but no thread context", async () => {
    const { traj, cleanup } = makeTraj();
    try {
      msg(traj, ANDY, ME, "can you paste the tweet into the channel?", 600);
      msg(traj, ME, ANDY, "Sure, posting it now.", 590);
      msg(traj, BRADEN, ME, "how was the eval run?", 300);
      msg(traj, ME, BRADEN, "still running", 290);
      const trig = msg(traj, BRADEN_DM, ME, "and the eval?", 0);

      await runResponder({
        trajectory: traj,
        llm: Recorded("and-the-eval"),
        identityName: ME,
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        personNotes: false,
        trigger: trig,
      });

      const obs = obsFor(traj, trig.step_id!)!;
      expect(obs["thread_msgs"]).toBe(0);
      expect(obs["context_msgs"] as number).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });
});

// --- part 4: person notes ------------------------------------------------------

describe("responder person notes (part 4)", () => {
  it("creates a type: person memory after the first reply, in mem's frontmatter format", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      const trig = msg(traj, "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149", "testid", "hi, I am Andy, keep replies short", 0);
      const notesLlm = Recorded("andy-intro-short");
      fs.mkdirSync(memDir, { recursive: true });

      await runResponder({
        trajectory: traj,
        llm: notesLlm,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        personNotesSync: true,
        trigger: trig,
      });

      const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      expect(files).toHaveLength(1);
      const content = fs.readFileSync(path.join(memDir, files[0]!), "utf8");
      expect(content).toMatch(/^---\nid: [0-9a-f]{8}\n/);
      expect(content).toContain("type: person");
      expect(content).toContain("person_key: slack:U0614H65RN3");
      expect(content).toContain("aliases: []");
      // the body is the notes writer's recorded real notes
      expect(content).toContain(lastReply(notesLlm, "private notes").split("\n")[0]!);
    } finally {
      cleanup();
    }
  });

  it("a second reply updates the same file (no duplicate), keeping id/created/aliases and reading the notes into the next prompt", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      fs.mkdirSync(memDir, { recursive: true });
      const ANDY_T1 = "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149";
      const ANDY_DM = "slack-U0614H65RN3-D0BNW58GP5W";
      const trig1 = msg(traj, ANDY_T1, "testid", "hi, I am Andy", 0);
      await runResponder({
        trajectory: traj,
        llm: Recorded("andy-hi"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        personNotesSync: true,
        trigger: trig1,
      });
      const file = path.join(memDir, fs.readdirSync(memDir)[0]!);
      const before = fs.readFileSync(file, "utf8");
      // Add an alias by hand, as Part 2's alias merge would produce.
      fs.writeFileSync(file, before.replace("aliases: []", "aliases: [pwa:andy]"));

      const trig2 = msg(traj, ANDY_DM, "testid", "did you see the new PR?", 0);
      const llm2 = Recorded("andy-new-pr");
      await runResponder({
        trajectory: traj,
        llm: llm2,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        personNotesSync: true,
        trigger: trig2,
      });

      const systems = llm2.requests.map((r) => String(((r["messages"] as ChatMessage[]).find((x) => x.role === "system")?.content) ?? ""));
      expect(systems.some((x) => x.includes("What you know about"))).toBe(true);
      const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      expect(files).toHaveLength(1); // updated in place, no duplicate
      const after = fs.readFileSync(file, "utf8");
      const idBefore = /^id: (.*)$/m.exec(before)![1];
      const idAfter = /^id: (.*)$/m.exec(after)![1];
      expect(idAfter).toBe(idBefore);
      expect(after).toContain("aliases: [pwa:andy]");
      expect(after).toContain(lastReply(llm2, "private notes").split("\n")[0]!);
    } finally {
      cleanup();
    }
  });

  it("RESPONDER_PERSON_NOTES=0 (personNotes:false) disables reading and writing", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      fs.mkdirSync(memDir, { recursive: true });
      const trig = msg(traj, "andy", "testid", "ping", 0);
      await runResponder({
        trajectory: traj,
        llm: Recorded("ping"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        personNotes: false,
        personNotesSync: true,
        trigger: trig,
      });
      expect(fs.readdirSync(memDir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// --- part 4 (real bug fix): the async path must not die with the process ---
//
// bin/thinker-step.mjs calls process.exit() the instant runResponder
// resolves. The old async path fired updatePersonNotes as an in-process
// promise and let it dangle (`.catch(() => {})`) — that promise's pending LLM
// call was killed by process.exit() every single time, so no `type: person`
// memory was EVER written on a real (non-SYNC) wake. The fix spawns a
// detached child (bin/responder-notes.mjs, RESPONDER_NOTES_SCRIPT) that
// outlives the parent, the same technique thinkersctl.ts's drainThenFinish
// uses. This group asserts the SEAM (spawnDetached) sees the right call and
// that runResponder itself never touches the notes LLM call when SYNC isn't
// set — proving it truly does not wait.

describe("responder person notes async path (the process.exit bug fix)", () => {
  it("SYNC unset spawns bin/responder-notes.mjs detached with the exact log path and argv, and returns without calling the notes LLM in-process", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      fs.mkdirSync(memDir, { recursive: true });
      const trig = msg(traj, "andy", "testid", "hi, I am Andy", 0);

      const calls: Array<{ cmd: string; args: string[]; opts: SpawnDetachedOptions }> = [];
      // The same "hi, I am Andy" conversation as the sync notes test: reuse its recording (only the reply calls run).
      const watched = Recorded("andy-hi");

      const identityDir = path.join(path.dirname(traj.trajFile), "..", "identity");
      const result = await runResponder({
        trajectory: traj,
        llm: watched,
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        identityDir,
        // personNotesSync intentionally omitted/false — the async path.
        trigger: trig,
        spawnDetached: (cmd, args, opts) => {
          calls.push({ cmd, args, opts });
          return 424242; // a fake pid — never actually spawned
        },
      });

      expect(result.outcome).toBe("replied");
      // The reply's own LLM call happened, but the notes rewrite never ran
      // in THIS process — it was handed off entirely to the child.
      const notesCalls = watched.requests.filter((r) =>
        String(((r["messages"] as ChatMessage[]).find((x) => x.role === "system")?.content) ?? "").includes("private notes")
      );
      expect(notesCalls).toHaveLength(0);

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.cmd).toBe(process.execPath);
      expect(call.args[0]).toBe(RESPONDER_NOTES_SCRIPT);
      const [, trajFileArg, idxFileArg, memDirArg, identityNameArg, personKeyArg, msgFromArg] = call.args;
      expect(trajFileArg).toBe(traj.trajFile);
      expect(idxFileArg).toBe(path.join(path.dirname(traj.trajFile), "messages.jsonl"));
      expect(memDirArg).toBe(memDir);
      expect(identityNameArg).toBe("testid");
      expect(personKeyArg).toBe("andy");
      expect(msgFromArg).toBe("andy");
      expect(call.opts.logFile).toBe(path.join(identityDir, "run", "logs", "responder-notes.log"));

      // No memory file was written by THIS process (only the never-actually-
      // spawned child would write one).
      expect(fs.readdirSync(memDir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("without identityDir, the log path falls back to ./run/logs/responder-notes.log (matches Bash's ${IDENTITY_DIR:-.})", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      fs.mkdirSync(memDir, { recursive: true });
      const trig = msg(traj, "andy", "testid", "hi, I am Andy", 0);
      let loggedPath = "";
      await runResponder({
        trajectory: traj,
        llm: Recorded("andy-hi"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        trigger: trig,
        spawnDetached: (_cmd, _args, opts) => {
          loggedPath = opts.logFile;
          return 1;
        },
      });
      expect(loggedPath).toBe(path.join(".", "run", "logs", "responder-notes.log"));
    } finally {
      cleanup();
    }
  });

  it("a spawn failure is swallowed — the reply already sent is not affected", async () => {
    const { traj, memDir, cleanup } = makeTraj();
    try {
      fs.mkdirSync(memDir, { recursive: true });
      const trig = msg(traj, "andy", "testid", "hi, I am Andy", 0);
      const result = await runResponder({
        trajectory: traj,
        llm: Recorded("andy-hi"),
        identityName: "testid",
        identityText: "",
        skillsText: "",
        model: RECORD_MODEL,
        memDir,
        trigger: trig,
        spawnDetached: () => {
          throw new Error("spawn EAGAIN");
        },
      });
      expect(result.outcome).toBe("replied");
    } finally {
      cleanup();
    }
  });
});
