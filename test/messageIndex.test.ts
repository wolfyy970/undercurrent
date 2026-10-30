// messageIndex.test.ts — the derived message index behind `chat history
// --with`/`--thread` (design/conversation_memory.md, parts 1+2). Assertions
// ported from upstream's tests/test_chat_history_index.sh: the index holds
// only message steps; --with groups a person's Slack thread names and DM name
// under one key; --since and -n bound the result; a later append is picked up
// incrementally; a partial last line is not consumed until complete; a
// replaced trajectory (different header) rebuilds the index; --thread returns
// everyone in a Slack thread; --with plus --thread is the de-duplicated union.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexUpdate, queryHistory, queryPending, pendingAgeText, deferralsPath, durationSeconds } from "../src/messageIndex.js";
import { personKey, threadKey } from "../src/personMemory.js";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // fixed "now" for --since math
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

describe("durationSeconds", () => {
  it.each([
    ["7d", 7 * 86400],
    ["36h", 36 * 3600],
    ["90m", 90 * 60],
    ["3600s", 3600],
    ["3600", 3600],
  ])("%s -> %i seconds", (spec, expected) => {
    expect(durationSeconds(spec)).toBe(expected);
  });
});

describe("indexUpdate + queryHistory", () => {
  let dir: string;
  let traj: string;
  let idx: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "midx-"));
    traj = path.join(dir, "trajectory.jsonl");
    idx = path.join(dir, "messages.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ME = "ada";
  const ANDY_T1 = "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149";
  const ANDY_T2 = "slack-U0614H65RN3-C0BMVH6LM4K-1787419141.482799";
  const ANDY_DM = "slack-U0614H65RN3-D0BNW58GP5W";
  const BRADEN = "slack-U095QV3JKA6-C0BMVH6LM4K-1787508187.726149";

  function header(id: string) {
    fs.appendFileSync(traj, JSON.stringify({ step_id: id, type: "trajectory", ts: ago(999_999) }) + "\n");
  }
  function msg(id: string, from: string, to: string, content: string, secsAgo: number) {
    fs.appendFileSync(
      traj,
      JSON.stringify({ step_id: id, type: "message", from, to, content, ts: ago(secsAgo), source: "chat" }) + "\n"
    );
  }
  function noise(id: string) {
    fs.appendFileSync(
      traj,
      JSON.stringify({ step_id: id, type: "reasoning", content: '..."type":"message" mentioned in prose', ts: ago(5) }) +
        "\n"
    );
  }

  it("groups two threads and the DM under one person, in time order, excluding another person in the same thread", () => {
    header("hdr-1");
    msg("a1", ANDY_T1, ME, "how is the bridge work going", 8 * 86400); // older than 7d
    msg("a2", ME, ANDY_T1, "half done", 8 * 86400 - 60);
    noise("n1");
    msg("a3", ANDY_T2, ME, "that svg is not rendering", 7200);
    msg("a4", ME, ANDY_T2, "slack ate it", 7100);
    msg("b1", BRADEN, ME, "middle name of washington?", 3600);
    msg("b2", ME, BRADEN, "he had none", 3500);
    msg("a5", ANDY_DM, ME, "sure!", 60);
    noise("n2");
    indexUpdate(traj, idx);

    const key = personKey(ANDY_T1);
    const out = queryHistory(idx, { me: ME, keys: [key], threadKey: "", sinceSeconds: 0, n: 20, now: () => NOW });
    expect(out.map((m) => m.step_id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);

    const sevenDay = queryHistory(idx, {
      me: ME,
      keys: [personKey(ANDY_DM)],
      threadKey: "",
      sinceSeconds: 7 * 86400,
      n: 20,
      now: () => NOW,
    });
    expect(sevenDay.length).toBe(3); // drops the 8-day-old exchange

    const capped = queryHistory(idx, { me: ME, keys: [key], threadKey: "", sinceSeconds: 0, n: 2, now: () => NOW });
    expect(capped.length).toBe(2);
    expect(capped[capped.length - 1]!.step_id).toBe("a5"); // -n keeps the newest

    // the index holds only the 5 real message steps... plus b1/b2 (7 total),
    // never the noise lines that merely mention "type":"message" in prose.
    const raw = fs.readFileSync(idx, "utf8").trim().split("\n");
    expect(raw.length).toBe(7);
    expect(raw.some((l) => l.includes('"step_id":"n1"'))).toBe(false);
  });

  it("picks up a later append incrementally, without a rebuild", () => {
    header("hdr-1");
    msg("a1", ANDY_DM, ME, "hi", 60);
    indexUpdate(traj, idx);
    const before = fs.readFileSync(idx, "utf8").trim().split("\n").length;

    msg("a2", ANDY_DM, ME, "still there?", 10);
    indexUpdate(traj, idx);
    const after = fs.readFileSync(idx, "utf8").trim().split("\n").length;
    expect(after).toBe(before + 1);

    const out = queryHistory(idx, {
      me: ME,
      keys: [personKey(ANDY_DM)],
      threadKey: "",
      sinceSeconds: 0,
      n: 20,
      now: () => NOW,
    });
    expect(out.length).toBe(2);
  });

  it("leaves a partial last line for the next call, then picks it up once complete", () => {
    header("hdr-1");
    msg("a1", ANDY_DM, ME, "hi", 60);
    indexUpdate(traj, idx);
    // sync 2e39a3f: the record is `<offset> <header> <inode> <size> <idx> <dfr> <dlv>`; the CURSOR is field 1.
    const cursor = () => fs.readFileSync(`${idx}.offset`, "utf8").split(" ")[0];
    const offBefore = cursor();

    // A write in progress: no trailing newline.
    fs.appendFileSync(traj, '{"step_id":"a2","type":"message","from":"' + ANDY_DM + '","to":"' + ME + '","content":"half writ');
    indexUpdate(traj, idx);
    const out1 = queryHistory(idx, { me: ME, keys: [personKey(ANDY_DM)], threadKey: "", sinceSeconds: 0, n: 20 });
    expect(out1.length).toBe(1);
    const offAfter = cursor();
    expect(offAfter).toBe(offBefore); // offset did not advance past the partial line

    fs.appendFileSync(traj, `ten","ts":"${ago(5)}","source":"chat"}\n`);
    indexUpdate(traj, idx);
    const out2 = queryHistory(idx, { me: ME, keys: [personKey(ANDY_DM)], threadKey: "", sinceSeconds: 0, n: 20 });
    expect(out2.length).toBe(2);
  });

  it("rebuilds the index when the trajectory is replaced (a different header)", () => {
    header("hdr-1");
    msg("a1", ANDY_DM, ME, "hi", 60);
    indexUpdate(traj, idx);

    fs.writeFileSync(traj, "");
    header("hdr-2");
    msg("z1", "pwa-andy", ME, "hello from the phone", 30);
    indexUpdate(traj, idx);

    const out = queryHistory(idx, { me: ME, keys: [personKey("pwa-andy")], threadKey: "", sinceSeconds: 0, n: 20 });
    expect(out.map((m) => m.step_id)).toEqual(["z1"]);
    const raw = fs.readFileSync(idx, "utf8").trim().split("\n");
    expect(raw.length).toBe(1);
    const off = fs.readFileSync(`${idx}.offset`, "utf8");
    expect(off.split(" ")[1]).toBe("hdr-2");
  });

  it("--thread returns everyone's messages in that thread, in order; --with plus --thread is the union", () => {
    header("hdr-1");
    msg("a1", ANDY_T1, ME, "andy in thread", 600);
    msg("a2", ME, ANDY_T1, "reply to andy", 590);
    msg("b1", BRADEN, ME, "braden in same thread", 300);
    msg("b2", ME, BRADEN, "reply to braden", 290);
    indexUpdate(traj, idx);

    const tkey = threadKey(ANDY_T1);
    expect(tkey).toBe("slack-thread:C0BMVH6LM4K-1787508187.726149");

    const byThread = queryHistory(idx, { me: ME, keys: [], threadKey: tkey, sinceSeconds: 0, n: 20 });
    expect(byThread.map((m) => m.step_id)).toEqual(["a1", "a2", "b1", "b2"]);

    const union = queryHistory(idx, { me: ME, keys: [personKey(BRADEN)], threadKey: tkey, sinceSeconds: 0, n: 20 });
    expect(union.map((m) => m.step_id)).toEqual(["a1", "a2", "b1", "b2"]);

    // A DM name has no thread key: nothing comes back for --thread alone.
    expect(threadKey(ANDY_DM)).toBe("");
  });
});

// --- deferrals.jsonl / chat pending (1c: 2fed66c) --------------------------------

describe("deferrals index + queryPending", () => {
  let dir: string;
  let traj: string;
  let idx: string;
  let dfr: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "midx-deferrals-"));
    traj = path.join(dir, "trajectory.jsonl");
    idx = path.join(dir, "messages.jsonl");
    dfr = deferralsPath(idx);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function header(id: string) {
    fs.appendFileSync(traj, JSON.stringify({ step_id: id, type: "trajectory", ts: ago(999_999) }) + "\n");
  }
  function deferral(id: string, trigger: string, person: string, request: string, secsAgo: number) {
    fs.appendFileSync(
      traj,
      JSON.stringify({
        step_id: id,
        type: "action",
        source: "responder",
        trigger_step: trigger,
        person,
        request,
        ts: ago(secsAgo),
      }) + "\n"
    );
  }
  function resolve(id: string, resolves: string, secsAgo: number) {
    fs.appendFileSync(
      traj,
      JSON.stringify({ step_id: id, type: "observation", resolves, content: "done", ts: ago(secsAgo) }) + "\n"
    );
  }

  it("deferralsPath sits beside messages.jsonl", () => {
    expect(dfr).toBe(path.join(dir, "deferrals.jsonl"));
  });

  it("indexUpdate builds deferrals.jsonl alongside messages.jsonl", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "check the deploy", 300);
    indexUpdate(traj, idx);
    expect(fs.existsSync(dfr)).toBe(true);
    const lines = fs.readFileSync(dfr, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "request", trigger_step: "trig-1", person: "bob" });
  });

  it("an unresolved request is returned, oldest first", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "check the deploy", 300);
    indexUpdate(traj, idx);
    const out = queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ trigger_step: "trig-1", person: "bob", request: "check the deploy" });
    expect(out[0]!.age_s).toBe(300);
  });

  it("a resolve carrying resolves=<trigger> removes it from pending", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "check the deploy", 300);
    resolve("o1", "trig-1", 60);
    indexUpdate(traj, idx);
    expect(queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW })).toHaveLength(0);
  });

  it("only the trigger actually resolved drops out; an unrelated deferral stays pending", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "check the deploy", 300);
    deferral("d2", "trig-2", "carol", "review the PR", 200);
    resolve("o1", "trig-1", 60);
    indexUpdate(traj, idx);
    const out = queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW });
    expect(out.map((p) => p.trigger_step)).toEqual(["trig-2"]);
  });

  it("--max-age drops requests older than the given seconds", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "check the deploy", 300);
    indexUpdate(traj, idx);
    expect(queryPending(dfr, { maxAgeSeconds: 60, now: () => NOW })).toHaveLength(0);
    expect(queryPending(dfr, { maxAgeSeconds: 3600, now: () => NOW })).toHaveLength(1);
  });

  it("multiple unresolved requests sort oldest-ts first", () => {
    header("hdr-1");
    deferral("d1", "trig-new", "bob", "newer ask", 60);
    deferral("d2", "trig-old", "carol", "older ask", 600);
    indexUpdate(traj, idx);
    const out = queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW });
    expect(out.map((p) => p.trigger_step)).toEqual(["trig-old", "trig-new"]);
  });

  it("rebuilds deferrals.jsonl (not just messages.jsonl) when the trajectory header changes", () => {
    header("hdr-1");
    deferral("d1", "trig-1", "bob", "first identity's ask", 300);
    indexUpdate(traj, idx);
    expect(queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW }).map((p) => p.trigger_step)).toEqual(["trig-1"]);

    fs.writeFileSync(traj, "");
    header("hdr-2");
    deferral("d2", "trig-2", "carol", "second identity's ask", 30);
    indexUpdate(traj, idx);
    const out = queryPending(dfr, { maxAgeSeconds: 0, now: () => NOW });
    expect(out.map((p) => p.trigger_step)).toEqual(["trig-2"]); // trig-1 gone with the rebuild
  });

  it("pendingAgeText buckets minutes/hours/days, floor-divided, no plural", () => {
    expect(pendingAgeText(59)).toBe("0m");
    expect(pendingAgeText(300)).toBe("5m");
    expect(pendingAgeText(3599)).toBe("59m");
    expect(pendingAgeText(3600)).toBe("1h");
    expect(pendingAgeText(86399)).toBe("23h");
    expect(pendingAgeText(86400)).toBe("1d");
    expect(pendingAgeText(3 * 86400 + 100)).toBe("3d");
  });
});
