// chatGuards.test.ts — the 2e39a3f chat send guards, `chat sent`, `chat index-reset --offline`, and
// the index lock / trim / rebuild paths. Oracle: the real Bash `chat` (parity/chat, group sync-e-*);
// here the contract is pinned deterministically against on-disk trajectories.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChat, SLACK_NAME_RE, type ChatIO } from "../src/chat.js";
import { isSlackName } from "../src/slack/naming.js";
import { indexUpdate, indexLockAbandoned } from "../src/messageIndex.js";

const TID = "12345678-1111-2222-3333-444455556666";
const HEAD = `{"type":"trajectory","step_id":"${TID}","ts":"2026-01-01T00:00:00.000Z"}`;

let TMP: string;
let trajDir: string;
const rootFile = () => path.join(trajDir, "12345678-root", "trajectory.jsonl");
const idxFile = () => path.join(path.dirname(rootFile()), "messages.jsonl");

function seed(lines: string[]): void {
  fs.mkdirSync(path.dirname(rootFile()), { recursive: true });
  fs.writeFileSync(rootFile(), [HEAD, ...lines].join("\n") + "\n");
}
function run(argv: string[], env: Record<string, string> = {}, stdin = ""): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: ChatIO = {
    cwd: TMP,
    env: { TRAJ_DIR: trajDir, TRAJ_ID: TID, ...env },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    readStdin: () => stdin,
    isStdinTTY: stdin === "",
    hasCommand: () => false,
    execInherit: () => 127,
  };
  return { rc: runChat(argv, io), out, err };
}
const msg = (id: string, from: string, to: string, content: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", content, from, to, source: "chat", step_id: id, ts, ...extra });
const nowIso = (agoSec = 0) => new Date(Date.now() - agoSec * 1000).toISOString();

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chat-guards-"));
  trajDir = path.join(TMP, "traj");
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("Slack target grammar (_check_target)", () => {
  const good = [
    "slack-U0BFD9NDVE3",
    "slack-W0ABC123",
    "slack-C0BMVH6LM4K",
    "slack-G0BMVH6LM4K",
    "slack-D0BMVH6LM4K",
    "slack-U0614H65RN3-D0BNW58GP5W",
    "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149",
  ];
  const bad = ["slack-u0614h65rn3", "slack-bob", "slack-", "slack-C0BMVH6LM4K-", "slack-U1-C2-abc", "slack-U1-C2-1.2-3"];
  it("accepts the forms the bridge decodes and refuses the rest", () => {
    for (const n of good) expect(SLACK_NAME_RE.test(n), n).toBe(true);
    for (const n of bad) expect(SLACK_NAME_RE.test(n), n).toBe(false);
  });
  it("agrees with the bridge's own name codec on every two-or-three part name", () => {
    for (const n of [...good, ...bad]) {
      // bare-ID forms (slack-C…) are chat-only conveniences: the bridge decodes user-channel names
      if (/^slack-[A-Za-z0-9]+-[A-Za-z0-9]+(-[0-9.]+)?$/.test(n)) expect(isSlackName(n), n).toBe(SLACK_NAME_RE.test(n));
    }
  });
  it("send / reply / send-file / react refuse a malformed slack- target; other transports pass", () => {
    seed([msg("in1", "bob", "alice", "hi", nowIso(5))]);
    expect(run(["send", "--from", "alice", "--to", "slack-bob", "x"]).rc).toBe(1);
    expect(run(["send", "--from", "alice", "--to", "slack-bob", "x"]).err).toContain("not a Slack address the bridge understands");
    expect(run(["send", "--from", "alice", "--to", "telegram-1-1", "x"]).rc).toBe(0);
    expect(run(["send", "--from", "alice", "--to", "slack-C0BMVH6LM4K", "x"]).rc).toBe(0);
  });
});

describe("structured action object refusal (_refuse_json_body)", () => {
  beforeEach(() => seed([]));
  const refused = ['{"action":"no_reply","message":""}', '```json\n{\n  "action": "send"\n}\n```', '  {\n"x":1,\n"action" : 2}'];
  const passed = ["hello", '{"a":1}', 'the {"action": "x"} key', 'prose first\n{"action": "x"}'];
  it("refuses an action object, with or without fences", () => {
    for (const m of refused) {
      const r = run(["send", "--from", "alice", "--to", "bob", m]);
      expect(r.rc, m).toBe(1);
      expect(r.err).toContain("structured action object");
    }
  });
  it("lets ordinary text and non-action JSON through", () => {
    for (const m of passed) expect(run(["send", "--from", "alice", "--to", "bob", m]).rc, m).toBe(0);
  });
  it("--force overrides", () => {
    expect(run(["send", "--force", "--from", "alice", "--to", "bob", '{"action":"x"}']).rc).toBe(0);
  });
  it("an inbound message (from someone other than IDENTITY_NAME) is not screened", () => {
    expect(run(["send", "--from", "bob", "--to", "alice", '{"action":"x"}'], { IDENTITY_NAME: "alice" }).rc).toBe(0);
  });
});

describe("repeat and key refusal", () => {
  it("refuses the same text to the same target inside 24h, allows it with --force or another target", () => {
    seed([msg("s1", "alice", "bob", "weekly papers", nowIso(60))]);
    // the index is built by the first call
    const r = run(["send", "--from", "alice", "--to", "bob", "weekly papers"]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("this exact message already went to 'bob'");
    expect(run(["send", "--from", "alice", "--to", "carol", "weekly papers"]).rc).toBe(0);
    expect(run(["send", "--force", "--from", "alice", "--to", "bob", "weekly papers"]).rc).toBe(0);
  });
  it("does not refuse a repeat older than the window", () => {
    seed([msg("s1", "alice", "bob", "old", nowIso(3 * 86400))]);
    expect(run(["send", "--from", "alice", "--to", "bob", "old"]).rc).toBe(0);
  });
  it("CHAT_REPEAT_WINDOW narrows the window", () => {
    seed([msg("s1", "alice", "bob", "recent", nowIso(7200))]);
    expect(run(["send", "--from", "alice", "--to", "bob", "recent"], { CHAT_REPEAT_WINDOW: "1h" }).rc).toBe(0);
  });
  it("an empty CHAT_REPEAT_WINDOW means the default window", () => {
    seed([msg("s1", "alice", "bob", "recent", nowIso(7200))]);
    expect(run(["send", "--from", "alice", "--to", "bob", "recent"], { CHAT_REPEAT_WINDOW: "" }).rc).toBe(1);
  });
  it("--key refuses a second send for the same duty however the text is reworded", () => {
    seed([msg("s1", "alice", "bob", "papers v1", nowIso(100000), { key: "wk1" })]);
    const ID = { IDENTITY_NAME: "alice" };
    const r = run(["send", "--from", "alice", "--to", "bob", "papers reworded", "--key", "wk1"], ID);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("'wk1' was already sent at");
    expect(run(["send", "--from", "alice", "--to", "bob", "papers reworded", "--key", "wk2"], ID).rc).toBe(0);
    expect(run(["send", "--force", "--from", "alice", "--to", "bob", "again", "--key", "wk1"], ID).rc).toBe(0);
  });
  it("--key is written on the message record", () => {
    seed([]);
    expect(run(["send", "--from", "alice", "--to", "bob", "hello", "--key", "k9"]).rc).toBe(0);
    const last = fs.readFileSync(rootFile(), "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last).key).toBe("k9");
  });
});

describe("chat sent", () => {
  const dlv = (id: string, trig: string, status: string) =>
    JSON.stringify({ step_id: id, type: "delivery", trigger_step: trig, status, transport: "slack", ts: nowIso(1) });
  const ID = { IDENTITY_NAME: "alice" };
  it("lists the identity's own sends, newest first, with delivery state", () => {
    seed([
      msg("s1", "alice", "bob", "plain", nowIso(50)),
      msg("s2", "alice", "slack-U0BFD9NDVE3", "to slack", nowIso(40)),
      msg("s3", "alice", "slack-U0BFD9NDVE3", "unconfirmed", nowIso(30)),
      msg("s4", "bob", "alice", "inbound", nowIso(20)),
      dlv("d1", "s2", "delivered"),
    ]);
    const r = run(["sent", "--json"], ID);
    expect(r.rc).toBe(0);
    const rows = JSON.parse(r.out) as Array<Record<string, unknown>>;
    expect(rows.map((x) => x.step_id)).toEqual(["s3", "s2", "s1"]);
    expect(rows.find((x) => x.step_id === "s2")!.state).toBe("delivered");
    expect(rows.find((x) => x.step_id === "s3")!.state).toBe("pending"); // slack target, no notice yet
    expect(rows.find((x) => x.step_id === "s1")!.state).toBe("unconfirmed"); // transport that never confirms
  });
  it("a later failed delivery marks the send failed and a failed key can be resent", () => {
    seed([msg("s1", "alice", "slack-U0BFD9NDVE3", "will fail", nowIso(50), { key: "fail1" }), dlv("d1", "s1", "failed")]);
    const rows = JSON.parse(run(["sent", "--json"], ID).out) as Array<Record<string, unknown>>;
    expect(rows[0]!.state).toBe("failed");
    expect(run(["send", "--from", "alice", "--to", "bob", "retry", "--key", "fail1"], ID).rc).toBe(0);
  });
  it("-n and --since restrict the list; bad arguments die", () => {
    seed([msg("s1", "alice", "bob", "a", nowIso(100000)), msg("s2", "alice", "bob", "b", nowIso(50)), msg("s3", "alice", "bob", "c", nowIso(40))]);
    expect((JSON.parse(run(["sent", "--json", "-n", "1"], ID).out) as unknown[]).length).toBe(1);
    expect((JSON.parse(run(["sent", "--json", "--since", "1h"], ID).out) as unknown[]).length).toBe(2);
    expect(run(["sent", "-n", "x"]).rc).toBe(1);
    expect(run(["sent", "--bogus"]).rc).toBe(1);
  });
});

describe("index lock, trim, rebuild", () => {
  it("builds an index on first use, silently (a missing index is not a rebuild)", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    let err = "";
    indexUpdate(rootFile(), idxFile(), (s) => (err += s));
    expect(fs.existsSync(idxFile())).toBe(true);
    expect(fs.existsSync(`${idxFile()}.deliveries.jsonl`) || fs.existsSync(path.join(path.dirname(idxFile()), "deliveries.jsonl"))).toBe(true);
    expect(fs.existsSync(`${idxFile()}.lock`)).toBe(false);
    expect(err).toBe("");
  });
  it("takes over a lock whose recorded holder is gone", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    const lock = `${idxFile()}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    // The owner record carries this host's pid namespace (`readlink /proc/self/ns/pid` on Linux, "-" on macOS); a
    // record from another namespace is never judged, so a hard-coded "-" only exercised the takeover on macOS.
    let ns = "-";
    try { ns = fs.readlinkSync("/proc/self/ns/pid") || "-"; } catch { /* macOS: no /proc */ }
    fs.writeFileSync(path.join(lock, "owner"), `999999 ${ns} Mon_Jan__1_00:00:00_2001\n`);
    let err = "";
    indexUpdate(rootFile(), idxFile(), (s) => (err += s));
    expect(err).toContain("took over the message index lock");
    expect(fs.existsSync(lock)).toBe(false);
  });
  it("an ownerless lock is judged by age: fresh stays, older than the 60s grace is abandoned", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    const lock = `${idxFile()}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    expect(indexLockAbandoned(lock)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    expect(indexLockAbandoned(lock)).toBe(true);
    // and a symlinked lock is never judged
    fs.rmdirSync(lock);
    fs.symlinkSync(TMP, lock);
    expect(indexLockAbandoned(lock)).toBe(false);
  });
  it("a caller that cannot get the lock leaves the index as it is", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    const lock = `${idxFile()}.lock`;
    fs.mkdirSync(lock, { recursive: true }); // ownerless, fresh: someone else's
    indexUpdate(rootFile(), idxFile());
    expect(fs.existsSync(idxFile())).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });
  it("a trailing partial row left by an interrupted update is cut back to the recorded size", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    indexUpdate(rootFile(), idxFile());
    const before = fs.statSync(idxFile()).size;
    fs.appendFileSync(idxFile(), '{"step_id":"half');
    let err = "";
    indexUpdate(rootFile(), idxFile(), (s) => (err += s));
    expect(err).toContain("dropping 16 bytes an interrupted index update left in messages.jsonl");
    expect(fs.statSync(idxFile()).size).toBe(before);
  });
  it("an index file shorter than recorded forces a rebuild", () => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    indexUpdate(rootFile(), idxFile());
    fs.truncateSync(idxFile(), 0);
    let err = "";
    indexUpdate(rootFile(), idxFile(), (s) => (err += s));
    expect(err).toContain("shorter than the last update recorded");
    expect(fs.statSync(idxFile()).size).toBeGreaterThan(0);
  });
});

describe("chat index-reset --offline", () => {
  beforeEach(() => {
    seed([msg("m1", "bob", "alice", "hi", nowIso(10))]);
    indexUpdate(rootFile(), idxFile());
  });
  it("requires --offline", () => {
    expect(run(["index-reset"]).rc).toBe(1);
    expect(run(["index-reset"]).err).toContain("requires --offline");
  });
  it("removes every derived index file and the lock", () => {
    expect(run(["index-reset", "--offline"]).rc).toBe(0);
    const dir = path.dirname(idxFile());
    for (const f of ["messages.jsonl", "messages.jsonl.offset", "deferrals.jsonl", "deliveries.jsonl", "messages.jsonl.lock"])
      expect(fs.existsSync(path.join(dir, f)), f).toBe(false);
    expect(fs.existsSync(rootFile())).toBe(true);
  });
  it("refuses a symlinked lock and a lock with unknown contents", () => {
    const lock = `${idxFile()}.lock`;
    const other = path.join(TMP, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(other, lock);
    expect(run(["index-reset", "--offline"]).err).toContain("refusing a symlinked lock");
    fs.unlinkSync(lock);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "surprise"), "x");
    expect(run(["index-reset", "--offline"]).err).toContain("lock directory is not empty");
    expect(fs.existsSync(path.join(lock, "surprise"))).toBe(true);
  });
});
