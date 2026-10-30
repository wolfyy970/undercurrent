// chat-history-index.test.ts — CLI-level tests for `chat history --with`,
// `--thread`, `chat person-key`, `chat thread-key`, and `chat reply
// --follow-up` (design/conversation_memory.md, parts 1+2+5; upstream sync 1b,
// 84aa37e/67229dc/0c51de8). test/messageIndex.test.ts and
// test/personMemory.test.ts cover the underlying engine directly; this file
// pins the CLI wiring: flag parsing, env gating (MEM_DIR), --json vs. text
// rendering, and the index file created next to the trajectory.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChat, type ChatIO } from "../src/chat.js";

const TID = "12345678-1111-2222-3333-444455556666";
const HEX8 = TID.slice(0, 8);
const HEAD = `{"type":"trajectory","step_id":"${TID}","ts":"2026-01-01T00:00:00.000Z"}`;

function rootDir(trajDir: string): string {
  return path.join(trajDir, `${HEX8}-root`);
}
function rootFile(trajDir: string): string {
  return path.join(rootDir(trajDir), "trajectory.jsonl");
}
function seedRoot(trajDir: string, lines: string[]): void {
  const rf = rootFile(trajDir);
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, lines.join("\n") + "\n");
}

interface Harness {
  io: ChatIO;
  out(): string;
  err(): string;
}
function makeIO(opts: {
  trajDir: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
}): Harness {
  let out = "";
  let err = "";
  const io: ChatIO = {
    cwd: opts.trajDir,
    env: { TRAJ_DIR: opts.trajDir, TRAJ_ID: TID, ...opts.env },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdin: () => opts.stdin ?? "",
    isStdinTTY: true,
    hasCommand: () => false,
    execInherit: () => 127,
  };
  return { io, out: () => out, err: () => err };
}

let TMP: string;
let trajDir: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chat-hist-"));
  trajDir = path.join(TMP, "traj");
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ME = "ada";
const ANDY_T1 = "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149";
const ANDY_DM = "slack-U0614H65RN3-D0BNW58GP5W";
const BRADEN = "slack-U095QV3JKA6-C0BMVH6LM4K-1787508187.726149";

describe("chat person-key / thread-key", () => {
  // `cmd_person_key() { _person_key "$1"; echo; }` — `_person_key` already
  // prints a trailing newline (jq -Rr), and the bare `echo` after it prints a
  // SECOND one. Confirmed against real upstream bin/chat via
  // parity/chat/run-parity.mjs (PARITY_BASH_CHAT=<NEW>/bin/chat): real output
  // is "<key>\n\n", not "<key>\n". Same for `cmd_thread_key`.

  it("prints the stable person key for a routing name", () => {
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    const rc = runChat(["person-key", ANDY_T1], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("slack:U0614H65RN3\n\n");
  });

  it("prints the thread key for a Slack channel-thread name, empty for a DM", () => {
    const h1 = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    expect(runChat(["thread-key", ANDY_T1], h1.io)).toBe(0);
    expect(h1.out()).toBe("slack-thread:C0BMVH6LM4K-1787508187.726149\n\n");

    const h2 = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    expect(runChat(["thread-key", ANDY_DM], h2.io)).toBe(0);
    expect(h2.out()).toBe("\n\n");
  });
});

describe("chat history --with / --thread", () => {
  function seedConvo() {
    seedRoot(trajDir, [
      HEAD,
      `{"step_id":"a1","type":"message","from":"${ANDY_T1}","to":"${ME}","content":"how is it going","ts":"2026-01-01T00:01:00.000Z","source":"chat"}`,
      `{"step_id":"a2","type":"message","from":"${ME}","to":"${ANDY_T1}","content":"half done","ts":"2026-01-01T00:02:00.000Z","source":"chat"}`,
      `{"step_id":"b1","type":"message","from":"${BRADEN}","to":"${ME}","content":"unrelated","ts":"2026-01-01T00:03:00.000Z","source":"chat"}`,
      `{"step_id":"a3","type":"message","from":"${ANDY_DM}","to":"${ME}","content":"sure!","ts":"2026-01-01T00:04:00.000Z","source":"chat"}`,
    ]);
  }

  it("--with --json groups a person across routing names, excluding another person", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    const rc = runChat(["history", "--with", ANDY_T1, "--json"], h.io);
    expect(rc).toBe(0);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs.map((m) => m.step_id)).toEqual(["a1", "a2", "a3"]);
  });

  it("--with text output renders 'ts from → to: content' lines", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--with", ANDY_T1], h.io);
    expect(h.out()).toContain("sure!");
    expect(h.out()).toContain(`${ANDY_DM} → ${ME}:`);
  });

  it("--with text-mode lines are JSON-string-quoted (the outer jq call has no -r)", () => {
    // Confirmed against real upstream bin/chat: `cmd_history`'s text branch
    // is `jq -cn ... | .[] | "..."`  — no `-r` — so each rendered line comes
    // out as a jq STRING VALUE (quoted, backslash-escaped), not raw text.
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--with", ANDY_T1], h.io);
    const lines = h.out().trim().split("\n");
    for (const line of lines) {
      expect(line.startsWith('"')).toBe(true);
      expect(line.endsWith('"')).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines.some((l) => JSON.parse(l).includes(`${ANDY_DM} → ${ME}: sure!`))).toBe(true);
  });

  it("-n caps the result and a person key works as --with", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--with", "slack:U0614H65RN3", "-n", "1", "--json"], h.io);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.step_id).toBe("a3"); // newest kept
  });

  it("creates the index file next to the trajectory, holding only message steps", () => {
    seedConvo();
    fs.appendFileSync(
      rootFile(trajDir),
      `{"step_id":"noise","type":"reasoning","content":"mentions \\"type\\":\\"message\\" in prose","ts":"2026-01-01T00:05:00.000Z"}\n`
    );
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--with", ANDY_T1, "--json"], h.io);
    const idxFile = path.join(rootDir(trajDir), "messages.jsonl");
    expect(fs.existsSync(idxFile)).toBe(true);
    const lines = fs.readFileSync(idxFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4); // a1,a2,b1,a3 — not the reasoning noise
  });

  it("--thread returns everyone's messages in the Slack thread", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--thread", ANDY_T1, "--json"], h.io);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs.map((m) => m.step_id)).toEqual(["a1", "a2", "b1"]);
  });

  it("--with plus --thread is the de-duplicated union", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--with", BRADEN, "--thread", ANDY_T1, "--json"], h.io);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs.map((m) => m.step_id)).toEqual(["a1", "a2", "b1"]);
  });

  it("--thread on a DM name returns nothing", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    runChat(["history", "--thread", ANDY_DM, "--json"], h.io);
    expect(JSON.parse(h.out())).toEqual([]);
  });

  it("aliases in a MEM_DIR person memory merge channels", () => {
    seedConvo();
    const memDir = path.join(TMP, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, "2026-01-01-00-00-00_abcd1234_andy.md"),
      "---\nid: abcd1234\ntype: person\nperson_key: slack:U0614H65RN3\naliases: [pwa:andy]\nsummary: Andy\n---\n\nnotes\n"
    );
    // A message from a THIRD alias name (pwa:andy) should now merge with the
    // slack thread/DM history under the same person.
    fs.appendFileSync(
      rootFile(trajDir),
      `{"step_id":"a4","type":"message","from":"pwa-andy","to":"${ME}","content":"from the phone","ts":"2026-01-01T00:06:00.000Z","source":"chat"}\n`
    );
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME, MEM_DIR: memDir } });
    runChat(["history", "--with", "pwa-andy", "--json"], h.io);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs.map((m) => m.step_id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  // bug #47: upstream's `_duration_s` (bin/chat:350-357) only evaluates a
  // d/h/m-suffixed --since spec arithmetically; an s-suffixed or bare spec
  // passes through VERBATIM into `jq -cn --argjson since "$since_s" ...`
  // (bin/chat:405-406). "bogus" (ends in "s") strips to "bogu" — not valid
  // JSON — so jq itself dies: exit 2 (verified directly: `jq -cn --argjson
  // x "bogu" '.'` -> "jq: invalid JSON text passed to --argjson", status 2;
  // and against the real `chat` binary — parity/fuzz/findings/chat-1.md —
  // stdout empty, trajectory/state unchanged). The port previously fell
  // back to a 0 cutoff for ANY unparseable --since and printed real
  // history (exit 0) instead of dying.
  it("bug #47: --since bogus dies (exit 2) instead of silently ignoring the cutoff", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    const rc = runChat(["history", "--with", ANDY_T1, "--since", "bogus"], h.io);
    expect(rc).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("--since");
  });

  it("bug #47: a valid --since still works (regression guard)", () => {
    seedConvo();
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: ME } });
    // A huge window so the fixed 2026-01-01 timestamps are always "recent
    // enough", regardless of the actual wall-clock date this test runs on.
    const rc = runChat(["history", "--with", ANDY_T1, "--since", "36500d", "--json"], h.io);
    expect(rc).toBe(0);
    const msgs = JSON.parse(h.out()) as Array<{ step_id: string }>;
    expect(msgs.map((m) => m.step_id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("chat reply --follow-up", () => {
  function seedTrigger() {
    seedRoot(trajDir, [
      HEAD,
      `{"step_id":"trig-1","type":"message","from":"andy","to":"testid","content":"how's it going?","ts":"2026-01-01T00:01:00.000Z","source":"chat"}`,
    ]);
  }

  it("delivers a second reply to an already-answered trigger, bypassing the duplicate guard", () => {
    seedTrigger();
    const h1 = makeIO({ trajDir, env: { IDENTITY_NAME: "testid" } });
    runChat(["reply", "--reply-to", "trig-1", "andy", "Let me look into that."], h1.io);

    // A plain second reply is refused (existing guard).
    const h2 = makeIO({ trajDir, env: { IDENTITY_NAME: "testid" } });
    runChat(["reply", "--reply-to", "trig-1", "andy", "dup"], h2.io);
    expect(h2.err()).toContain("already has a reply");

    // --follow-up delivers anyway.
    const h3 = makeIO({ trajDir, env: { IDENTITY_NAME: "testid" } });
    const rc = runChat(["reply", "--follow-up", "--reply-to", "trig-1", "andy", "Here is the answer."], h3.io);
    expect(rc).toBe(0);

    const lines = fs
      .readFileSync(rootFile(trajDir), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const replies = lines.filter(
      (l) => l["type"] === "message" && l["from"] === "testid" && l["reply_to"] === "trig-1"
    );
    expect(replies).toHaveLength(2); // the holding message + the follow-up
    const followUp = replies.find((r) => r["follow_up"] === true);
    expect(followUp).toBeDefined();
    expect(followUp!["content"]).toBe("Here is the answer.");
  });
});
