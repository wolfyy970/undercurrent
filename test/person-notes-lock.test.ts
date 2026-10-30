// person-notes-lock.test.ts — bug #36: thinkers/responder/step:343-350
// `_update_person_notes`'s dedup lock, ported to updatePersonNotes.
//
// Upstream: `local lockdir="${MEM_DIR:-/tmp}/.person-notes.lock"` — note this
// is ONE lockdir per MEM_DIR, NOT keyed by person — then
// `mkdir "$lockdir" 2>/dev/null || return 0` (atomic acquire, silent no-op
// on failure, NO staleness check anywhere) and
// `trap "rmdir '$lockdir' 2>/dev/null" EXIT` (release on every exit path).
// Both `_update_person_notes_async`'s SYNC and detached-subshell branches
// call the SAME function, so the lock covers both this port's
// personNotesSync in-process path and its bin/responder-notes.mjs detached
// child identically.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { updatePersonNotes, RESPONDER_NOTES_SCRIPT } from "../src/responder.ts";
import type { LlmClient, LlmResponse, ChatMessage } from "../src/llm.ts";
import { recordedModel, recordedEndpoint, type RecordedModel } from "./support/recordedModel.ts";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "person-notes-lock-"));
  roots.push(d);
  return d;
}

/** A minimal trajectory with one inbound message from "andy" to "pax", new
 *  enough to fall inside updatePersonNotes's 30-day NOTES_SINCE_S window. */
function fixture(dir: string, from = "andy", to = "pax"): { trajFile: string; idxFile: string } {
  const trajFile = path.join(dir, "trajectory.jsonl");
  const idxFile = path.join(dir, "messages.jsonl");
  const now = Date.now();
  const headerTs = new Date(now - 999_999_000).toISOString();
  const msgTs = new Date(now - 60_000).toISOString();
  fs.writeFileSync(
    trajFile,
    JSON.stringify({ step_id: "h1", type: "trajectory", ts: headerTs }) +
      "\n" +
      JSON.stringify({ step_id: "m1", type: "message", from, to, content: `hi, I'm ${from}`, ts: msgTs, source: "chat" }) +
      "\n"
  );
  return { trajFile, idxFile };
}

// The notes writer's real reply to andy's "hi, I'm andy" (test/fixtures/recordings/person-notes-lock/andy-notes.json),
// replayed for every call (`cycle`): these tests count calls and files, not content. `.requests.length` counts calls.
const models: RecordedModel[] = [];
const CountingLlm = () => {
  const m = recordedModel("person-notes-lock", "andy-notes", process.env["UC_RECORD"] === "1" ? {} : { cycle: true });
  models.push(m);
  return m;
};
afterEach(() => {
  while (models.length) models.pop()!.close();
});

function mdFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

describe("updatePersonNotes lock (bug #36)", () => {
  it("two near-simultaneous calls for the same person: the second is a no-op", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    const llm = CountingLlm();
    const now = () => Date.now();

    // Two calls issued back-to-back, neither awaited before the other
    // starts: JS runs each async function synchronously up to its first
    // `await`, so the first call's `mkdirSync(lockDir)` (synchronous, before
    // any await) always wins before the second call's own attempt runs.
    const p1 = updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now });
    const p2 = updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now });
    await Promise.all([p1, p2]);

    expect(llm.requests.length).toBe(1);
    expect(mdFiles(memDir).length).toBe(1);
  });

  it("the lock is a SINGLE lockdir per MEM_DIR, not per person key (matches the Bash literally — no $key in the lockdir path)", async () => {
    const dir = tmp();
    const memDir = path.join(dir, "memories");
    const llm = CountingLlm();
    const now = () => Date.now();

    const andyFixture = fixture(dir, "andy", "pax");
    const beaDir = path.join(dir, "bea-idx");
    fs.mkdirSync(beaDir, { recursive: true });
    const beaFixture = fixture(beaDir, "bea", "pax");

    // Two DIFFERENT people's notes updates, issued together — the second
    // still no-ops, because upstream's lockdir has no person key in it.
    const p1 = updatePersonNotes({ trajFile: andyFixture.trajFile, idxFile: andyFixture.idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now });
    const p2 = updatePersonNotes({ trajFile: beaFixture.trajFile, idxFile: beaFixture.idxFile, llm, memDir, identityName: "pax", personKey: "bea", msgFrom: "bea", now });
    await Promise.all([p1, p2]);

    expect(llm.requests.length).toBe(1);
    expect(mdFiles(memDir).length).toBe(1);
  });

  it("a stale lockdir (left behind by a crashed writer) is NEVER broken — matches upstream's mkdir-or-return-0 with no steal/expiry logic", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    const lockDir = path.join(memDir, ".person-notes.lock");
    fs.mkdirSync(lockDir); // simulate a prior crash that never released the lock
    const llm = CountingLlm();

    await updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now: () => Date.now() });

    expect(llm.requests.length).toBe(0);
    expect(mdFiles(memDir).length).toBe(0);
    // The lock itself is left exactly as found — not removed, not "fixed".
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("the lock is released on success, so a SUBSEQUENT (non-overlapping) call proceeds normally", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    const llm = CountingLlm();
    const now = () => Date.now();

    await updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now });
    expect(fs.existsSync(path.join(memDir, ".person-notes.lock"))).toBe(false);

    await updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now });
    expect(llm.requests.length).toBe(2);
  });

  it("the lock is released even when an error is thrown inside the locked region (trap-equivalent, not just the happy path)", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    const llm = CountingLlm();
    const throwingNow = (): number => {
      throw new Error("boom");
    };

    await expect(
      updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now: throwingNow })
    ).rejects.toThrow("boom");

    expect(fs.existsSync(path.join(memDir, ".person-notes.lock"))).toBe(false);

    // A subsequent, working call proceeds normally — the lock was not left behind.
    await updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now: () => Date.now() });
    expect(llm.requests.length).toBe(1);
    expect(mdFiles(memDir).length).toBe(1);
  });

  it("a missing/unwritable MEM_DIR base (mkdir -p fails) no-ops before ever touching the lock, matching `mkdir -p ... || return 0`", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    // memDir's PARENT is a plain FILE, so `mkdir -p` on memDir must fail.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory\n");
    const memDir = path.join(blocker, "memories");
    const llm = CountingLlm();

    await updatePersonNotes({ trajFile, idxFile, llm, memDir, identityName: "pax", personKey: "andy", msgFrom: "andy", now: () => Date.now() });
    expect(llm.requests.length).toBe(0);
  });

  it("real subprocess concurrency: two bin/responder-notes.mjs children for the SAME person write exactly ONE notes file, the other no-ops", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    fs.mkdirSync(memDir, { recursive: true });

    const { model: server, env: llmEnv } = await recordedEndpoint("person-notes-lock", "andy-notes", { cycle: true });
    models.push(server);
    const env = { ...process.env, ...llmEnv } as NodeJS.ProcessEnv;

    const runChild = (): Promise<number> =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [RESPONDER_NOTES_SCRIPT, trajFile, idxFile, memDir, "pax", "andy", "andy"],
          { env, stdio: "ignore" }
        );
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

    const [c1, c2] = await Promise.all([runChild(), runChild()]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);

    // Deterministic regardless of which child won the race: if the lock
    // works, exactly one child's LLM call/write happened; if it were
    // broken, both would write SEPARATE files (each mints its own random
    // hex id when there's no existing notes file), so file COUNT alone
    // proves mutual exclusion without depending on timing.
    expect(mdFiles(memDir).length).toBe(1);
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("real subprocess concurrency: a pre-existing stale lockdir makes BOTH children no-op (no auto-recovery)", async () => {
    const dir = tmp();
    const { trajFile, idxFile } = fixture(dir);
    const memDir = path.join(dir, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(path.join(memDir, ".person-notes.lock"));

    const { model: server, env: llmEnv } = await recordedEndpoint("person-notes-lock", "andy-notes", { cycle: true });
    models.push(server);
    const env = { ...process.env, ...llmEnv } as NodeJS.ProcessEnv;

    const runChild = (): Promise<number> =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [RESPONDER_NOTES_SCRIPT, trajFile, idxFile, memDir, "pax", "andy", "andy"],
          { env, stdio: "ignore" }
        );
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

    const [c1, c2] = await Promise.all([runChild(), runChild()]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    expect(mdFiles(memDir).length).toBe(0);
    expect(server.requests).toHaveLength(0);
  }, 20_000);
});
