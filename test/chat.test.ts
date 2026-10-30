// chat.test.ts — unit tests for `chat`, messaging on an activated identity's
// trajectory.
//
// Behaviour, not text: these pin the send/reply CONTRACT (message + reply_to
// steps written to the ROOT trajectory, from!=to guards, the reply
// duplicate-answer guard) and the previously-buggy `history` overflow case.
// The port is byte-compared against the real Bash tool by the separate
// parity harness (parity/chat/run-parity.mjs); here the behaviour is pinned
// deterministically against a real on-disk trajectory file (chat.ts always
// reads/writes it via trajCore, so these tests seed and inspect that file
// directly rather than mocking it).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChat, type ChatIO } from "../src/chat.js";

// --- deterministic IO harness -------------------------------------------------

const TID = "12345678-1111-2222-3333-444455556666";
const HEX8 = TID.slice(0, 8);
const HEAD = `{"type":"trajectory","step_id":"${TID}","ts":"2026-01-01T00:00:00.000Z"}`;
const IN1 = "aaaa0000-0000-0000-0000-000000000001";

function rootFile(trajDir: string): string {
  return path.join(trajDir, `${HEX8}-root`, "trajectory.jsonl");
}

/** Seed the root trajectory file with raw JSONL lines (HEAD first). */
function seedRoot(trajDir: string, lines: string[]): void {
  const rf = rootFile(trajDir);
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, lines.join("\n") + "\n");
}

/** Read the root trajectory back as parsed JSON objects, disk key-order preserved. */
function readRootLines(trajDir: string): Record<string, unknown>[] {
  const rf = rootFile(trajDir);
  if (!fs.existsSync(rf)) return [];
  return fs
    .readFileSync(rf, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface Harness {
  io: ChatIO;
  out(): string;
  err(): string;
}

function makeIO(opts: {
  trajDir: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  isStdinTTY?: boolean;
}): Harness {
  let out = "";
  let err = "";
  const io: ChatIO = {
    cwd: opts.cwd ?? opts.trajDir,
    env: { TRAJ_DIR: opts.trajDir, TRAJ_ID: TID, ...opts.env },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdin: () => opts.stdin ?? "",
    isStdinTTY: opts.isStdinTTY ?? true,
    hasCommand: () => false,
    execInherit: () => 127,
  };
  return { io, out: () => out, err: () => err };
}

let TMP: string;
let trajDir: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-"));
  trajDir = path.join(TMP, "traj");
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- send ----------------------------------------------------------------------

describe("chat send", () => {
  it("writes a message step with content/from/to/source in construction order", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    const rc = runChat(["send", "--from", "alice", "--to", "bob", "hello", "world"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe("Message sent.\n");
    expect(h.out()).toBe("");

    const lines = readRootLines(trajDir);
    expect(lines).toHaveLength(2);
    const step = lines[1]!;
    expect(Object.keys(step)).toEqual(["type", "content", "from", "to", "source", "step_id", "ts"]);
    expect(step).toMatchObject({
      type: "message",
      content: "hello world",
      from: "alice",
      to: "bob",
      source: "chat",
    });
  });

  it("--from defaults from .chatrc default_send_from; --to defaults from IDENTITY_NAME", () => {
    fs.writeFileSync(path.join(TMP, ".chatrc"), "default_send_from=alice\n");
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, cwd: TMP, env: { IDENTITY_NAME: "bob" } });
    const rc = runChat(["send", "hi there"], h.io);
    expect(rc).toBe(0);
    const [, step] = readRootLines(trajDir);
    expect(step).toMatchObject({ from: "alice", to: "bob", content: "hi there" });
  });

  it("reads the message from stdin when no positional args are given", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({
      trajDir,
      env: { IDENTITY_NAME: "bob" },
      stdin: "from stdin\n",
      isStdinTTY: false,
    });
    runChat(["send", "--from", "alice"], h.io);
    const [, step] = readRootLines(trajDir);
    expect(step!.content).toBe("from stdin"); // trailing newline stripped ($(cat))
  });

  it("refuses to send from a name to itself (from === to guard); no append", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["send", "--from", "alice", "--to", "alice", "loop"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("refusing to send a message from 'alice' to itself.");
    expect(readRootLines(trajDir)).toHaveLength(1); // unchanged — only HEAD
  });

  it("appends source_url when given (1c: f68c1d8), after source", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    const rc = runChat(
      ["send", "--from", "alice", "--to", "bob", "--source-url", "https://slack.example/x", "hi"],
      h.io
    );
    expect(rc).toBe(0);
    const [, step] = readRootLines(trajDir);
    expect(Object.keys(step!)).toEqual(["type", "content", "from", "to", "source", "source_url", "step_id", "ts"]);
    expect(step!.source_url).toBe("https://slack.example/x");
  });

  it("omits source_url entirely when not given", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    runChat(["send", "--from", "alice", "--to", "bob", "hi"], h.io);
    const [, step] = readRootLines(trajDir);
    expect(step!).not.toHaveProperty("source_url");
  });
});

// --- send-file — content_b64 (1c: e286745, c647609, f68ae29) --------------------

describe("chat send-file", () => {
  it("text file: keeps readable content in `content` AND stamps content_b64", () => {
    seedRoot(trajDir, [HEAD]);
    fs.writeFileSync(path.join(TMP, "note.txt"), "hello file body\nsecond line\n");
    const h = makeIO({ trajDir, cwd: TMP });
    const rc = runChat(["send-file", "--from", "alice", "--to", "bob", "note.txt"], h.io);
    expect(rc).toBe(0);
    const [, step] = readRootLines(trajDir);
    expect(Object.keys(step!)).toEqual([
      "type",
      "content",
      "filename",
      "content_b64",
      "from",
      "to",
      "source",
      "step_id",
      "ts",
    ]);
    expect(step!.content).toBe("hello file body\nsecond line"); // trailing \n stripped
    expect(step!.filename).toBe("note.txt");
    expect(step!.content_b64).toBe(Buffer.from("hello file body\nsecond line\n", "utf8").toString("base64"));
  });

  it("binary file (NUL byte): content becomes a [file: name] marker, content_b64 still present", () => {
    seedRoot(trajDir, [HEAD]);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    fs.writeFileSync(path.join(TMP, "blob.bin"), bytes);
    const h = makeIO({ trajDir, cwd: TMP });
    runChat(["send-file", "--from", "alice", "--to", "bob", "blob.bin"], h.io);
    const [, step] = readRootLines(trajDir);
    expect(step!.content).toBe("[file: blob.bin]");
    expect(step!.content_b64).toBe(bytes.toString("base64"));
  });

  it("binary file (invalid UTF-8, no NUL byte): still a [file: name] marker", () => {
    seedRoot(trajDir, [HEAD]);
    const bytes = Buffer.from([0x41, 0x80, 0x42, 0x0a]); // lone continuation byte, no NUL
    fs.writeFileSync(path.join(TMP, "invalid.bin"), bytes);
    const h = makeIO({ trajDir, cwd: TMP });
    runChat(["send-file", "--from", "alice", "--to", "bob", "invalid.bin"], h.io);
    const [, step] = readRootLines(trajDir);
    expect(step!.content).toBe("[file: invalid.bin]");
  });

  it("dies on an empty file, before from/to resolution (1c: f68ae29)", () => {
    seedRoot(trajDir, [HEAD]);
    fs.writeFileSync(path.join(TMP, "empty.txt"), "");
    const h = makeIO({ trajDir, cwd: TMP });
    const rc = runChat(["send-file", "empty.txt"], h.io); // no --to, no IDENTITY_NAME
    expect(rc).toBe(1);
    expect(h.err()).toContain("empty file: empty.txt");
    expect(readRootLines(trajDir)).toHaveLength(1);
  });

  it("dies when the file exceeds CHAT_SEND_FILE_MAX_BYTES (1c: f68ae29)", () => {
    seedRoot(trajDir, [HEAD]);
    fs.writeFileSync(path.join(TMP, "big.txt"), "0123456789");
    const h = makeIO({ trajDir, cwd: TMP, env: { CHAT_SEND_FILE_MAX_BYTES: "5" } });
    const rc = runChat(["send-file", "--from", "alice", "--to", "bob", "big.txt"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("file too large: big.txt (10 bytes; max 5)");
  });

  it("dies when CHAT_SEND_FILE_MAX_BYTES is not an integer", () => {
    seedRoot(trajDir, [HEAD]);
    fs.writeFileSync(path.join(TMP, "note.txt"), "hi\n");
    const h = makeIO({ trajDir, cwd: TMP, env: { CHAT_SEND_FILE_MAX_BYTES: "abc" } });
    const rc = runChat(["send-file", "--from", "alice", "--to", "bob", "note.txt"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("CHAT_SEND_FILE_MAX_BYTES must be an integer");
  });
});

// --- react (1c: 6a98ab5, 1d5670a) ------------------------------------------------

describe("chat react", () => {
  it("appends a message step: content ':emoji:', reaction field, in construction order", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["react", "bob", "thumbsup"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe("Reaction sent: :thumbsup:\n");
    const [, step] = readRootLines(trajDir);
    expect(Object.keys(step!)).toEqual(["type", "content", "reaction", "from", "to", "source", "step_id", "ts"]);
    expect(step).toMatchObject({
      type: "message",
      content: ":thumbsup:",
      reaction: "thumbsup",
      from: "alice",
      to: "bob",
      source: "chat",
    });
  });

  it("strips one leading and one trailing colon", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    runChat(["react", "bob", ":thumbsup:"], h.io);
    const [, step] = readRootLines(trajDir);
    expect(step!.reaction).toBe("thumbsup");
  });

  it("rejects an emoji name outside [-a-z0-9_+:]{1,64} (1c: 1d5670a)", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["react", "bob", "has space"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("invalid Slack emoji name: has space");
    expect(readRootLines(trajDir)).toHaveLength(1);
  });

  it("a lone colon strips to empty, still rejected (regex requires >=1 char)", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["react", "bob", ":"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("invalid Slack emoji name: ");
  });

  it("accepts flags interspersed BEFORE and AFTER the positional <to_name>", () => {
    seedRoot(trajDir, inboundSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["react", "bob", "--reply-to", IN1, "eyes"], h.io);
    expect(rc).toBe(0);
    const [, , step] = readRootLines(trajDir);
    expect(step!.reply_to).toBe(IN1);
  });

  it("auto-populates source_url from the reacted-to step when not given explicitly", () => {
    seedRoot(trajDir, [
      HEAD,
      `{"type":"message","content":"look","from":"bob","to":"alice","source":"chat","source_url":"https://slack.example/p1","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
    ]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    runChat(["react", "--reply-to", IN1, "bob", "eyes"], h.io);
    const [, , step] = readRootLines(trajDir);
    expect(step!.source_url).toBe("https://slack.example/p1");
  });

  it("an explicit --source-url wins over the auto lookup", () => {
    seedRoot(trajDir, [
      HEAD,
      `{"type":"message","content":"look","from":"bob","to":"alice","source":"chat","source_url":"https://slack.example/p1","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
    ]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    runChat(["react", "--reply-to", IN1, "--source-url", "https://override.example/x", "bob", "eyes"], h.io);
    const [, , step] = readRootLines(trajDir);
    expect(step!.source_url).toBe("https://override.example/x");
  });

  it("dies on missing <to_name>, missing <emoji>, or trailing extra arguments", () => {
    seedRoot(trajDir, [HEAD]);
    const h1 = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    expect(runChat(["react"], h1.io)).toBe(1);
    const h2 = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    expect(runChat(["react", "bob"], h2.io)).toBe(1);
    const h3 = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc3 = runChat(["react", "bob", "thumbsup", "extra"], h3.io);
    expect(rc3).toBe(1);
    expect(h3.err()).toContain("unexpected extra arguments");
  });
});

// --- reply -----------------------------------------------------------------------

const inboundSeed = [
  HEAD,
  `{"type":"message","content":"you there?","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
];
const answeredSeed = [
  ...inboundSeed,
  `{"type":"message","content":"yes","from":"alice","to":"bob","source":"chat","reply_to":"${IN1}","step_id":"bbbb0000-0000-0000-0000-000000000009","ts":"2026-01-01T00:02:00.000Z"}`,
];

describe("chat reply", () => {
  it("infers reply_to from the latest unanswered inbound and stamps the reply step", () => {
    seedRoot(trajDir, inboundSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["reply", "bob", "thanks!"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe("Reply sent.\n");

    const lines = readRootLines(trajDir);
    expect(lines).toHaveLength(3);
    const step = lines[2]!;
    expect(Object.keys(step)).toEqual([
      "type",
      "content",
      "from",
      "to",
      "source",
      "reply_to",
      "step_id",
      "ts",
    ]);
    expect(step).toMatchObject({
      type: "message",
      content: "thanks!",
      from: "alice",
      to: "bob",
      source: "chat",
      reply_to: IN1,
    });
  });

  it("sends unstamped (no reply_to field) when every inbound is already answered", () => {
    seedRoot(trajDir, answeredSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["reply", "bob", "more"], h.io);
    expect(rc).toBe(0);
    const lines = readRootLines(trajDir);
    expect(lines).toHaveLength(4);
    const step = lines[3]!;
    expect(step.reply_to).toBeUndefined();
    expect(Object.keys(step)).toEqual(["type", "content", "from", "to", "source", "step_id", "ts"]);
  });

  it("reads the reply message from stdin when no positional message is given", () => {
    seedRoot(trajDir, inboundSeed);
    const h = makeIO({
      trajDir,
      env: { IDENTITY_NAME: "alice" },
      stdin: "reply via stdin\n",
      isStdinTTY: false,
    });
    runChat(["reply", "bob"], h.io);
    const [, , step] = readRootLines(trajDir);
    expect(step!.content).toBe("reply via stdin");
    expect(step!.reply_to).toBe(IN1);
  });

  it("duplicate guard: an explicit --reply-to already answered by us skips the send (rc 0, no append)", () => {
    seedRoot(trajDir, answeredSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["reply", "--reply-to", IN1, "bob", "dup"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe(
      `chat: step ${IN1} already has a reply from alice — skipping duplicate send.\n`,
    );
    expect(readRootLines(trajDir)).toHaveLength(3); // unchanged
  });

  it("an explicit --reply-to not yet answered stamps and sends normally", () => {
    seedRoot(trajDir, inboundSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["reply", "--reply-to", IN1, "bob", "answer"], h.io);
    expect(rc).toBe(0);
    const [, , step] = readRootLines(trajDir);
    expect(step!.reply_to).toBe(IN1);
  });

  it("refuses to reply to yourself (to === IDENTITY_NAME guard); no append", () => {
    seedRoot(trajDir, inboundSeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["reply", "alice", "hi me"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("refusing to reply to yourself ('alice').");
    expect(readRootLines(trajDir)).toHaveLength(2); // unchanged — HEAD + inbound
  });

  it("--reply-to accepts an arbitrary non-UUID string unvalidated (stamped verbatim — reply_to is opaque, never resolved as a traj id)", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "hold" } });
    const rc = runChat(["reply", "--reply-to", "not-a-uuid", "you", "x"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe("Reply sent.\n");
    const [, step] = readRootLines(trajDir);
    expect(step!.reply_to).toBe("not-a-uuid");
  });
});

// --- reply: TRAJ_ID resolution (BUG #68, bin/traj:204-205 require_traj_file) ----
//
// Upstream's `_chat_append` (bin/chat:36-38) shells out to the real `traj
// append <id>` binary UNGUARDED — when `${ROOT_TRAJ_ID:-$TRAJ_ID}` doesn't
// resolve to an EXISTING trajectory, `traj`'s own `require_traj_file` dies
// with `traj: error: append: cannot resolve traj_id '<id>' in '<dir>'` (rc 1,
// no stdout, nothing written) and that death propagates straight out of
// `chat` — verified live against the real Bash oracle (a hand-built `hold`
// identity via `tools/identity new hold`, `TRAJ_ID` overridden to a
// nonexistent id / a bare non-UUID directory name after `chat reply
// --reply-to not-a-uuid you x`): rc 1, that exact stderr, no new directory
// under trajectories/. Before the fix, this port's `appendStep` reused the
// (read-side-only-appropriate) `rootFile()` helper, whose `resolveTrajFile()
// ?? rootTrajFile()` fallback silently manufactured a BRAND-NEW
// `<hex8>-root/trajectory.jsonl` for the bogus id and reported "Reply
// sent." at exit 0 instead of refusing — proven live the same way (two
// stray `<hex8>-root` directories appeared under trajectories/, one per
// bogus TRAJ_ID).
describe("chat reply — TRAJ_ID resolution (BUG #68, bin/traj:204-205 require_traj_file)", () => {
  it("refuses (does not create a new trajectory) when TRAJ_ID is a nonexistent id", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "hold", TRAJ_ID: "nonexistent-1234" } });
    const rc = runChat(["reply", "--reply-to", "not-a-uuid", "you", "x"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe(`traj: error: append: cannot resolve traj_id 'nonexistent-1234' in '${trajDir}'\n`);
    expect(h.out()).toBe("");
    // No new <hex8>-root sprang up — only the seeded root trajectory dir exists.
    expect(fs.readdirSync(trajDir)).toEqual([`${HEX8}-root`]);
    expect(readRootLines(trajDir)).toHaveLength(1); // unchanged — HEAD only
  });

  it("refuses identically when TRAJ_ID is a bare (non-UUID) directory-shaped name", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "hold", TRAJ_ID: "baredirname" } });
    const rc = runChat(["reply", "--reply-to", "not-a-uuid", "you", "x"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe(`traj: error: append: cannot resolve traj_id 'baredirname' in '${trajDir}'\n`);
    expect(h.out()).toBe("");
    expect(fs.readdirSync(trajDir)).toEqual([`${HEX8}-root`]);
    expect(readRootLines(trajDir)).toHaveLength(1);
  });

  it("still sends normally when TRAJ_ID (or ROOT_TRAJ_ID) is the correct root id", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "hold" } }); // TID is the correct id (makeIO default)
    const rc = runChat(["reply", "--reply-to", "not-a-uuid", "you", "x"], h.io);
    expect(rc).toBe(0);
    expect(h.err()).toBe("Reply sent.\n");
    expect(readRootLines(trajDir)).toHaveLength(2);
  });
});

// --- history: previously-buggy overflowing count --------------------------------
//
// Bash's `tail -n <spec>` parses the offset into a native uintmax_t; a digit
// string above UINT64_MAX (2^64-1) can never be represented and `tail` always
// dies with an "illegal offset ... Result too large" error (rc 1, no
// output) — verified against the real headlong/bin/chat tool. Before the
// fix, the TS port's tailSpec() ran `Number(spec)` and happily sliced with a
// huge/Infinity count, silently printing the *entire* history at rc 0
// instead of dying — a real, if low-severity, port bug on pathological
// input. The fix rejects any offset above 2^64-1 the same way a non-numeric
// spec is already rejected.

const historySeed = [
  HEAD,
  `{"type":"human-msg","content":"hi from human","from":"jo","step_id":"cccc0000-0000-0000-0000-000000000003","ts":"2026-01-01T00:01:00.000Z"}`,
  `{"type":"agent-msg","content":"hi from agent","step_id":"dddd0000-0000-0000-0000-000000000004","ts":"2026-01-01T00:02:00.000Z"}`,
  `{"type":"message","content":"hi from bob","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:03:00.000Z"}`,
];
const HISTORY_TEXT = "jo: hi from human\nalice: hi from agent\nbob → alice: hi from bob\n";

describe("chat history — overflowing count (previously-buggy case)", () => {
  it("a count above 2^64-1 is rejected (rc 1, empty stdout) instead of printing everything", () => {
    seedRoot(trajDir, historySeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["history", "999999999999999999999"], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("chat: invalid history count: 999999999999999999999\n");
  });

  it("the +N (start-at-line) form is rejected earlier, by the new digit-only count validation", () => {
    // Upstream sync 1b (84aa37e): `chat history` now validates its count
    // against `^[0-9]+$` for EVERY path (legacy positional included) before
    // ever reaching `tail` — a `+N` spec dies here now, with the new message,
    // rather than reaching the old tail-offset-overflow check below it.
    seedRoot(trajDir, historySeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["history", "+999999999999999999999"], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe(
      "chat: error: history: count must be a number, got '+999999999999999999999'\n"
    );
  });

  it("2^64-1 itself is still accepted — the fix rejects overflow, not merely 'large'", () => {
    seedRoot(trajDir, historySeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["history", "18446744073709551615"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe(HISTORY_TEXT);
  });

  it("an ordinary large count still returns full history (regression guard)", () => {
    seedRoot(trajDir, historySeed);
    const h = makeIO({ trajDir, env: { IDENTITY_NAME: "alice" } });
    const rc = runChat(["history", "1000"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe(HISTORY_TEXT);
  });
});

// --- pending (1c: 2fed66c) -------------------------------------------------------

const TRIGGER = "cccc1111-0000-0000-0000-000000000001";
const pendingUnresolvedSeed = [
  HEAD,
  `{"type":"message","content":"can you check the deploy?","from":"bob","to":"alice","source":"chat","step_id":"${TRIGGER}","ts":"2026-01-01T00:00:00.000Z"}`,
  `{"type":"action","source":"responder","trigger_step":"${TRIGGER}","person":"bob","request":"check the deploy","step_id":"dddd1111-0000-0000-0000-000000000001","ts":"2026-01-01T00:00:05.000Z"}`,
];
const pendingResolvedSeed = [
  ...pendingUnresolvedSeed,
  `{"type":"observation","resolves":"${TRIGGER}","content":"deploy is green","step_id":"eeee1111-0000-0000-0000-000000000001","ts":"2026-01-01T00:05:00.000Z"}`,
];

describe("chat pending", () => {
  it("exits 0 with no output when deferrals.jsonl does not exist yet", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
  });

  it("--json prints [] when deferrals.jsonl does not exist yet", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending", "--json"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("[]\n");
  });

  it("shows an unresolved deferral, oldest first, text mode", () => {
    seedRoot(trajDir, pendingUnresolvedSeed);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toContain("bob: check the deploy (pending ");
    expect(h.out()).toContain(`trigger ${TRIGGER})`);
  });

  it("--json shape: trigger_step, person, request, ts, age_s", () => {
    seedRoot(trajDir, pendingUnresolvedSeed);
    const h = makeIO({ trajDir });
    runChat(["pending", "--json"], h.io);
    const parsed = JSON.parse(h.out()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ trigger_step: TRIGGER, person: "bob", request: "check the deploy" });
    expect(Object.keys(parsed[0]!)).toEqual(["trigger_step", "person", "request", "ts", "age_s"]);
    expect(typeof parsed[0]!.age_s).toBe("number");
  });

  it("an observation carrying resolves=<trigger> closes the deferral", () => {
    seedRoot(trajDir, pendingResolvedSeed);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
  });

  it("--max-age drops requests older than the given duration", () => {
    seedRoot(trajDir, pendingUnresolvedSeed);
    const h = makeIO({ trajDir });
    // the fixture is dated 2026-01-01 — long past relative to the real clock.
    const rc = runChat(["pending", "--max-age", "1s"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
  });

  it("--max-age with an unparseable duration dies like history --since's jq --argjson crash class", () => {
    seedRoot(trajDir, pendingUnresolvedSeed);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending", "--max-age", "bogus"], h.io);
    expect(rc).toBe(2);
  });

  it("dies on an unknown argument", () => {
    seedRoot(trajDir, [HEAD]);
    const h = makeIO({ trajDir });
    const rc = runChat(["pending", "--bogus"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toContain("pending: unknown argument '--bogus'");
  });
});
