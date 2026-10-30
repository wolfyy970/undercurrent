// chat-history-index-concurrent.test.ts — RUNTIME-SEAMS.md §C row "chat
// index lock": proves the mkdir-based lock in src/messageIndex.ts
// (`indexUpdateInner`, faithful to bin/chat:296-320 `_index_update`) actually
// serializes messages.jsonl index updates across REAL concurrent
// `bin/chat.mjs history --with` OS processes, not just in-process.
//
// Deliberately warms the index with a single call FIRST (matching header +
// offset recorded), then appends new trajectory content and races two real
// processes against the SAME increment. This isolates the lock's own
// contract ("one updater at a time; a concurrent reader just uses what is
// there", bin/chat:313) from the unrelated cold-start index-rebuild step
// (`if (!fs.existsSync(idxFile) || haveHeader !== header)`), which runs
// UNLOCKED in both the port and upstream (bin/chat:307-310's `: >
// "$idx.rebuild"; mv -f` is also outside the `mkdir "$lock"` in upstream) —
// a real, shared, narrow lost-update hazard on the very first build that
// exists identically in both, not something this lock is meant to close.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CHAT_MJS = path.join(HERE, "..", "bin", "chat.mjs");

const TID = "aabbccdd-1111-2222-3333-444455556666";
const HEX8 = TID.slice(0, 8);

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHAT_MJS, ...args], { env, stdio: "ignore" });
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: -1 }));
  });
}

function messageLine(from: string, to: string, content: string): string {
  return JSON.stringify({
    type: "message",
    from,
    to,
    content,
    step_id: `${from}-${to}-${content}`,
    ts: "2026-01-01T00:00:00.000Z",
  });
}

describe("messages.jsonl index lock — real concurrent bin/chat.mjs history --with processes", () => {
  it("two racing updaters after a fresh append leave a complete, intact index with no duplicates", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-idx-race-"));
    const rootDir = path.join(tmp, `${HEX8}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    const trajFile = path.join(rootDir, "trajectory.jsonl");
    const idxFile = path.join(rootDir, "messages.jsonl");

    const header = `{"type":"trajectory","step_id":"${TID}","ts":"2026-01-01T00:00:00.000Z"}`;
    const batch1 = [messageLine("alice", "ada", "hello"), messageLine("ada", "alice", "hi there")];
    fs.writeFileSync(trajFile, [header, ...batch1].join("\n") + "\n");

    const env = { ...process.env, TRAJ_DIR: tmp, TRAJ_ID: TID, IDENTITY_NAME: "ada" };

    // Warm the index once, single-shot: establishes idxFile + a matching
    // offFile header, so the unlocked cold-start reset branch never fires
    // again for this trajectory.
    const warm = await run(["history", "--with", "alice"], env);
    expect(warm.code).toBe(0);
    expect(fs.readFileSync(idxFile, "utf8").trim().split("\n")).toHaveLength(2);

    // New activity past the recorded offset — this is the increment the
    // lock must serialize across the two racing processes below.
    const batch2 = [messageLine("bob", "ada", "yo"), messageLine("ada", "bob", "hey bob")];
    fs.appendFileSync(trajFile, batch2.join("\n") + "\n");

    const [r1, r2] = await Promise.all([run(["history", "--with", "bob"], env), run(["history", "--with", "bob"], env)]);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);

    const lines = fs
      .readFileSync(idxFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    // Every line is intact JSON (a corrupted/interleaved write would throw here).
    const parsed = lines.map((l) => JSON.parse(l) as { step_id: string; content: string });
    // Exactly one copy of each of the 4 messages — the lock ensures only ONE
    // of the two racers actually applies batch2 (mkdirSync throws EEXIST for
    // the loser, which returns immediately without writing), so nothing is
    // duplicated and nothing is lost.
    const stepIds = parsed.map((p) => p.step_id).sort();
    expect(stepIds).toEqual(
      [...batch1, ...batch2].map((l) => (JSON.parse(l) as { step_id: string }).step_id).sort()
    );
    expect(new Set(stepIds).size).toBe(4);
  }, 15000);
});
