// responder-notes.test.ts — spawns the REAL bin/responder-notes.mjs as a
// child process (exactly the way src/responder.ts's spawnPersonNotesWriter
// does in production, minus `detached`/`unref` so the test can wait on it
// deterministically) against a fixture identity and recorded real DeepSeek notes replies
// (test/fixtures/recordings/responder-notes/, test/support/README.md) served on LLM_API_URL.
//
// This is the proof for the actual bug: an in-process fire-and-forget
// promise for the notes rewrite died with the parent process every time
// (bin/thinker-step.mjs's process.exit()), so no `type: person` memory was
// ever written on a real async wake. This test exercises the FIX in a
// genuinely separate OS process — the only way to prove the notes writer
// survives the parent's exit.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTrajectory, type Trajectory } from "../src/trajectory.js";
import { indexUpdate } from "../src/messageIndex.js";
import { recordedModel, recordedText, RECORD_MODEL, type RecordedModel } from "./support/recordedModel.ts";

const RESPONDER_NOTES_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "responder-notes.mjs"
);

function makeFixture(): { root: string; traj: Trajectory; idxFile: string; memDir: string; identityDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resp-notes-"));
  const traj = createTrajectory(path.join(root, "trajectories"));
  const idxFile = path.join(path.dirname(traj.trajFile), "messages.jsonl");
  const memDir = path.join(root, "memories");
  const identityDir = path.join(root, "identity");
  fs.mkdirSync(memDir, { recursive: true });
  return { root, traj, idxFile, memDir, identityDir };
}

// W1 (behavioral parity round): the notes call is `llm -m … -s … -M …` like upstream (thinkers/responder/step:605),
// which streams; the recordings hold DeepSeek's real streamed answers.
const RECORDING = process.env["UC_RECORD"] === "1";
// Replay keeps the test's own model name (asserted below); record mode must send the provider a model it serves.
const NOTES_MODEL = RECORDING ? RECORD_MODEL : "vendor/test-model";
async function notesModel(scenario: string): Promise<RecordedModel> {
  const m = recordedModel("responder-notes", scenario);
  await m.ready;
  return m;
}
/** The recorded reply's text, as the notes body the writer saves (first non-blank line). */
const firstLine = (m: RecordedModel, i: number) => recordedText(m.recording.calls[i]!).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
/** Every non-blank line of the recorded reply. */
const replyLines = (m: RecordedModel, i: number) => recordedText(m.recording.calls[i]!).split("\n").map((l) => l.trim()).filter(Boolean);

let seq = 0;
function appendMsg(traj: Trajectory, from: string, to: string, content: string, secsAgo: number): void {
  const ts = new Date(Date.now() - secsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  fs.appendFileSync(
    traj.trajFile,
    JSON.stringify({ step_id: `m-${++seq}`, type: "message", from, to, content, ts, source: "chat" }) + "\n"
  );
}

/** Spawn the real script, non-detached (so the test can await its exit), the
 *  LLM pointed at the fake server. Returns once the child has exited. */
function runNotesChild(
  args: string[],
  opts: { llmUrl: string; logFile: string }
): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    const logFd = fs.openSync(opts.logFile, "a");
    const restEnv = process.env;
    const child = spawn(process.execPath, [RESPONDER_NOTES_SCRIPT, ...args], {
      env: {
        ...restEnv,
        LLM_API_URL: opts.llmUrl,
        OPENROUTER_API_KEY: "test-key-not-real",
        // `llm` must detect a provider from the model (bin/llm), as upstream does; record mode names the provider.
        SHELLM_MODEL: NOTES_MODEL,
        ...(RECORDING ? { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "replay-not-a-key" } : {}),
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.once("error", (err) => {
      fs.closeSync(logFd);
      reject(err);
    });
    child.once("close", (code) => {
      fs.closeSync(logFd);
      resolve({ code, log: fs.readFileSync(opts.logFile, "utf8") });
    });
  });
}

describe("bin/responder-notes.mjs (real subprocess, part 4 async-path fix)", () => {
  let server: RecordedModel | undefined;
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (server) server.close();
    server = undefined;
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  it("first write: creates a type: person memory in upstream's frontmatter shape, and writes the log", async () => {
    server = await notesModel("first-write");

    const { root, traj, idxFile, memDir, identityDir } = makeFixture();
    fixtureRoot = root;
    appendMsg(traj, "andy", "testid", "hi, I am Andy, keep replies short", 0);
    indexUpdate(traj.trajFile, idxFile);

    const logFile = path.join(identityDir, "run", "logs", "responder-notes.log");
    const baseUrl = server.url.replace(/\/chat\/completions$/, "");
    const { code, log } = await runNotesChild([traj.trajFile, idxFile, memDir, "testid", "andy", "andy"], {
      llmUrl: baseUrl,
      logFile,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(logFile)).toBe(true);
    void log;

    const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(memDir, files[0]!), "utf8");

    // Byte-for-byte against thinkers/responder/step:386-390's first-write shape:
    // ---\nid: <hex>\nsummary: ...\ntype: person\nperson_key: <key>\naliases: []\ncreated: <ts>\n---\n\n<body>\n
    expect(content).toMatch(
      /^---\nid: [0-9a-f]{8}\nsummary: Notes on andy: .+\ntype: person\nperson_key: andy\naliases: \[\]\ncreated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n---\n\n/
    );
    expect(firstLine(server, 0).length).toBeGreaterThan(0);
    expect(content).toContain(firstLine(server, 0));
    expect(content.endsWith("\n")).toBe(true);

    expect(server.requests).toHaveLength(1);
    const reqBody = server.requests[0]! as { model?: string };
    expect(reqBody.model).toBe(NOTES_MODEL);
  });

  it("update: rewrites the same file in place, preserving id/created/aliases (upstream step:370-383)", async () => {
    // Two recorded real notes replies: the first write, then the rewrite after a second message.
    server = await notesModel("update");

    const { root, traj, idxFile, memDir, identityDir } = makeFixture();
    fixtureRoot = root;
    appendMsg(traj, "andy", "testid", "hi, I am Andy", 0);
    indexUpdate(traj.trajFile, idxFile);
    const logFile = path.join(identityDir, "run", "logs", "responder-notes.log");
    const baseUrl = server.url.replace(/\/chat\/completions$/, "");

    await runNotesChild([traj.trajFile, idxFile, memDir, "testid", "andy", "andy"], { llmUrl: baseUrl, logFile });
    const file = path.join(memDir, fs.readdirSync(memDir).filter((f) => f.endsWith(".md"))[0]!);
    const before = fs.readFileSync(file, "utf8");
    // Hand-add an alias, as part 2's merge would have.
    fs.writeFileSync(file, before.replace("aliases: []", "aliases: [pwa:andy]"));
    const idBefore = /^id: (.*)$/m.exec(before)![1];
    const createdBefore = /^created: (.*)$/m.exec(before)![1];

    appendMsg(traj, "andy", "testid", "did you see the new PR?", 0);
    indexUpdate(traj.trajFile, idxFile);

    await runNotesChild([traj.trajFile, idxFile, memDir, "testid", "andy", "andy"], { llmUrl: baseUrl, logFile });

    const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1); // updated in place, no duplicate file
    const after = fs.readFileSync(file, "utf8");
    const idAfter = /^id: (.*)$/m.exec(after)![1];
    const createdAfter = /^created: (.*)$/m.exec(after)![1];
    expect(idAfter).toBe(idBefore);
    expect(createdAfter).toBe(createdBefore);
    expect(after).toContain("aliases: [pwa:andy]");
    // The rewrite is the second recorded reply (it differs from the first: it adds the PR question).
    expect(replyLines(server, 1)).not.toEqual(replyLines(server, 0));
    for (const line of replyLines(server, 1)) expect(after).toContain(line);
    expect(after).not.toBe(before.replace("aliases: []", "aliases: [pwa:andy]"));
    expect(server.requests).toHaveLength(2);
    expect(after).toMatch(/^---\nid: .+\nsummary: .+\ntype: person\nperson_key: andy\naliases: \[pwa:andy\]\ncreated: .+\nupdated: .+\n---\n\n/);
  });

  it("no history for the person: exits 0, writes nothing (best-effort no-op)", async () => {
    server = await notesModel("transport-never-called"); // no recording: any call would be a miss
    const { root, traj, idxFile, memDir, identityDir } = makeFixture();
    fixtureRoot = root;
    indexUpdate(traj.trajFile, idxFile); // no messages at all
    const logFile = path.join(identityDir, "run", "logs", "responder-notes.log");
    const baseUrl = server.url.replace(/\/chat\/completions$/, "");

    const { code } = await runNotesChild([traj.trajFile, idxFile, memDir, "testid", "nobody", "nobody"], {
      llmUrl: baseUrl,
      logFile,
    });
    expect(code).toBe(0);
    expect(fs.readdirSync(memDir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(server.requests).toHaveLength(0); // never even called the LLM
  });

  // CHECK #29 (SIDE-BY-SIDE.md: "messages.jsonl lagged one message behind
  // the trajectory"). Upstream's `_update_person_notes` (thinkers/responder/
  // step:343-392, called from step:466 AFTER `chat reply` has already sent
  // and appended the reply) does its own `chat history --with "$person" ...`
  // (step:350) — a fresh invocation of bin/chat's cmd_history, which
  // unconditionally calls `_index_update` (bin/chat:385) before reading. So
  // by the time upstream's notes LLM call fires, the index — and the notes
  // prompt — include the reply this same wake just sent. This test never
  // calls `indexUpdate` itself between appending the message and running the
  // child: it's proving updatePersonNotes (src/responder.ts) re-indexes on
  // its own, the same way upstream's fresh `chat history` call does.
  it("re-indexes before reading history, so the caller's own just-appended message is not missed (CHECK #29, bin/chat:385 called again inside _update_person_notes)", async () => {
    server = await notesModel("reindex");

    const { root, traj, idxFile, memDir, identityDir } = makeFixture();
    fixtureRoot = root;
    appendMsg(traj, "andy", "testid", "hi, I am Andy", 10);
    indexUpdate(traj.trajFile, idxFile); // index built BEFORE the next message exists

    // The reply this wake just sent — appended straight to the trajectory,
    // exactly like runResponder's `traj.append({type:"message", ...})`
    // (responder.ts:374-375), which happens AFTER the wake-start indexUpdate
    // (responder.ts:252-253) and BEFORE updatePersonNotes/this child runs.
    // Deliberately no `indexUpdate` call here — that's the point being tested.
    appendMsg(traj, "testid", "andy", "did you see the new PR?", 0);

    const logFile = path.join(identityDir, "run", "logs", "responder-notes.log");
    const baseUrl = server.url.replace(/\/chat\/completions$/, "");
    await runNotesChild([traj.trajFile, idxFile, memDir, "testid", "andy", "andy"], { llmUrl: baseUrl, logFile });

    expect(server.requests).toHaveLength(1);
    const reqBody = server.requests[0]! as { messages: { content: string }[] };
    const prompt = reqBody.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("did you see the new PR?");
  });
});
