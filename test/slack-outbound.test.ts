// slack-outbound.test.ts — port of headlong/slack/tests/test_outbound.py
// (outbound filter: only chat speaks for the identity) plus
// test_recent_posts_dedupe from tests/test_slackfmt.py, which imports
// RecentPosts from headlong_slack.outbound.
//
// Upstream sync 1c (692e16e, c7d240b, 6a98ab5) added file-upload
// (test_filepayload.py + the file-upload cases test_outbound.py grew) and
// outbound-reaction cases; both are ported below in their own describe
// blocks, each citing the source commit.

import { describe, it, expect } from "vitest";
import * as outbound from "../src/slack/outbound.ts";
import type { Config } from "../src/slack/config.ts";

function baseCfg(): Config {
  return {
    serveRoot: "/tmp",
    identity: "audel",
    identityDir: "/tmp",
    botToken: "x",
    appToken: "x",
    webUrl: "http://x",
    stateDir: "/tmp",
    threadFollowups: true,
    threadJoinBackfill: 20,
    peerBotUsers: new Set<string>(),
    peerMaxTurns: 4,
    peerHourlyCap: 30,
  };
}

function mindlogOf(steps: Array<Record<string, unknown>>) {
  return {
    findTrajectory: () => "/tmp/t.jsonl",
    follow: () =>
      (async function* () {
        for (const s of steps) yield s;
      })(),
  };
}

describe("slack outbound", () => {
  it("run delivers only chat-sourced messages", async () => {
    // Message steps without source:"chat" (a thinker appending raw message
    // steps to the trajectory) must not reach Slack.
    const steps = [
      // legit reply, stamped by bin/chat
      { type: "message", from: "audel", to: "slack-C1-U1", source: "chat", content: "real reply", step_id: "aaa" },
      // forged: thinker-appended, wrong source
      {
        type: "message",
        from: "audel",
        to: "slack-C1-U1",
        source: "responder",
        content: "forged reply",
        step_id: "bbb",
      },
      // forged: no source at all
      { type: "message", from: "audel", to: "slack-C1-U1", content: "unstamped reply", step_id: "ccc" },
    ];

    const sent: string[] = [];
    const fakeClient = {
      async chatPostMessage(_channel: string, text: string): Promise<void> {
        sent.push(text);
      },
    };
    const fakeThreads = { touch: () => {}, isActive: () => false };

    const cfg: Config = {
      serveRoot: "/tmp",
      identity: "audel",
      identityDir: "/tmp",
      botToken: "x",
      appToken: "x",
      webUrl: "http://x",
      stateDir: "/tmp",
      threadFollowups: true,
      threadJoinBackfill: 20,
      peerBotUsers: new Set<string>(),
      peerMaxTurns: 4,
      peerHourlyCap: 30,
    };
    const mindlogImpl = {
      findTrajectory: () => "/tmp/t.jsonl",
      follow: () => (async function* () {
        for (const s of steps) yield s;
      })(),
    };

    await outbound.run(cfg, fakeClient, fakeThreads, { mindlogImpl, log: () => {}, appendStep: () => {} });

    expect(sent).toEqual(["real reply"]);
  });

  it("recent posts dedupe", () => {
    const recent = new outbound.RecentPosts(300);
    expect(recent.isDuplicate("slack-U1-C2-3.4", "hello", 1000)).toBe(false);
    expect(recent.isDuplicate("slack-U1-C2-3.4", "hello", 1010)).toBe(true);
    expect(recent.isDuplicate("slack-U1-C2-3.4", "different", 1020)).toBe(false);
    expect(recent.isDuplicate("slack-U1-D9", "hello", 1030)).toBe(false);

    const recent2 = new outbound.RecentPosts(300);
    expect(recent2.isDuplicate("slack-U1-C2-3.4", "hello", 1000)).toBe(false);
    expect(recent2.isDuplicate("slack-U1-C2-3.4", "hello", 1400)).toBe(false); // outside window
  });

  // -- supplemental (no upstream case) --------------------------------------

  it("markdown is converted and thread touched before posting", async () => {
    const steps = [
      {
        type: "message",
        from: "audel",
        to: "slack-U1-C1-1700.1",
        source: "chat",
        content: "**hi** friend",
        step_id: "aaa",
      },
    ];
    const posted: Array<{ channel: string; text: string; threadTs: string | null | undefined }> = [];
    const touched: Array<[string, string | null | undefined]> = [];
    const fakeClient = {
      async chatPostMessage(channel: string, text: string, opts?: { threadTs?: string | null }): Promise<void> {
        posted.push({ channel, text, threadTs: opts?.threadTs });
      },
    };
    const fakeThreads = {
      touch: (channel: string, threadTs: string | null | undefined) => touched.push([channel, threadTs]),
      isActive: () => false,
    };
    const cfg: Config = {
      serveRoot: "/tmp",
      identity: "audel",
      identityDir: "/tmp",
      botToken: "x",
      appToken: "x",
      webUrl: "http://x",
      stateDir: "/tmp",
      threadFollowups: true,
      threadJoinBackfill: 20,
      peerBotUsers: new Set<string>(),
      peerMaxTurns: 4,
      peerHourlyCap: 30,
    };
    const mindlogImpl = {
      findTrajectory: () => "/tmp/t.jsonl",
      follow: () => (async function* () {
        for (const s of steps) yield s;
      })(),
    };

    await outbound.run(cfg, fakeClient, fakeThreads, { mindlogImpl, log: () => {}, appendStep: () => {} });

    expect(posted).toEqual([{ channel: "C1", text: "*hi* friend", threadTs: "1700.1" }]);
    expect(touched).toEqual([["C1", "1700.1"]]);
  });

  it("long replies are chunked into multiple posts", async () => {
    const long = "a".repeat(3000) + "\n\n" + "b".repeat(3000);
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-D1", source: "chat", content: long, step_id: "aaa" },
    ];
    const posted: string[] = [];
    const fakeClient = {
      async chatPostMessage(_channel: string, text: string): Promise<void> {
        posted.push(text);
      },
    };
    const cfg: Config = {
      serveRoot: "/tmp",
      identity: "audel",
      identityDir: "/tmp",
      botToken: "x",
      appToken: "x",
      webUrl: "http://x",
      stateDir: "/tmp",
      threadFollowups: true,
      threadJoinBackfill: 20,
      peerBotUsers: new Set<string>(),
      peerMaxTurns: 4,
      peerHourlyCap: 30,
    };
    const mindlogImpl = {
      findTrajectory: () => "/tmp/t.jsonl",
      follow: () => (async function* () {
        for (const s of steps) yield s;
      })(),
    };

    await outbound.run(cfg, fakeClient, { touch: () => {}, isActive: () => false }, { mindlogImpl, log: () => {}, appendStep: () => {} });

    expect(posted).toEqual(["a".repeat(3000), "b".repeat(3000)]);
  });

  it("a chatPostMessage failure breaks the chunk loop without throwing", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-D1", source: "chat", content: "hi\n\nthere", step_id: "aaa" },
    ];
    const fakeClient = {
      async chatPostMessage(): Promise<void> {
        throw new Error("boom");
      },
    };
    const cfg: Config = {
      serveRoot: "/tmp",
      identity: "audel",
      identityDir: "/tmp",
      botToken: "x",
      appToken: "x",
      webUrl: "http://x",
      stateDir: "/tmp",
      threadFollowups: true,
      threadJoinBackfill: 20,
      peerBotUsers: new Set<string>(),
      peerMaxTurns: 4,
      peerHourlyCap: 30,
    };
    const mindlogImpl = {
      findTrajectory: () => "/tmp/t.jsonl",
      follow: () => (async function* () {
        for (const s of steps) yield s;
      })(),
    };

    await expect(
      outbound.run(cfg, fakeClient, { touch: () => {}, isActive: () => false }, { mindlogImpl, log: () => {}, appendStep: () => {} }),
    ).resolves.toBeUndefined();
  });
});

// -- outbound file upload (1c: 692e16e, c7d240b) -----------------------------

describe("slack outbound: file upload via files.upload_v2 (1c: 692e16e)", () => {
  it("a text file uploads via files.upload_v2, not chat.postMessage", async () => {
    const body = Buffer.from("hello file\n");
    const steps = [
      {
        type: "message",
        from: "audel",
        to: "slack-U1-C1",
        source: "chat",
        filename: "note.txt",
        content: "hello file",
        content_b64: body.toString("base64"),
        step_id: "fff",
      },
    ];
    const sent: string[] = [];
    const uploads: Array<Record<string, unknown>> = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2(opts: Record<string, unknown>) {
        uploads.push(opts);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual([]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe("note.txt");
    expect(Buffer.from(uploads[0]?.content as Uint8Array)).toEqual(body);
    expect(uploads[0]?.channel).toBe("C1");
    expect(uploads[0]?.threadTs).toBeFalsy();
  });

  it("PNG bytes upload in-thread", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x65, 0x73, 0x74]);
    const steps = [
      {
        type: "message",
        from: "audel",
        to: "slack-U1-C09XYZ-1722400000.123456",
        source: "chat",
        filename: "fig.png",
        content: "[file: fig.png]",
        content_b64: png.toString("base64"),
        step_id: "png",
      },
    ];
    const sent: string[] = [];
    const uploads: Array<Record<string, unknown>> = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2(opts: Record<string, unknown>) {
        uploads.push(opts);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual([]);
    expect(Buffer.from(uploads[0]?.content as Uint8Array)).toEqual(png);
    expect(uploads[0]?.channel).toBe("C09XYZ");
    expect(uploads[0]?.threadTs).toBe("1722400000.123456");
  });

  it("a files.upload_v2 failure falls back to a notice", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content: "hi", step_id: "fail" },
    ];
    const sent: string[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2() {
        throw new Error("upload rejected");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });

  it("an undecodable file falls back to a notice without uploading", async () => {
    const steps = [
      {
        type: "message",
        from: "audel",
        to: "slack-U1-C1",
        source: "chat",
        filename: "note.txt",
        content: "[file: note.txt]",
        content_b64: "@@@bad@@@",
        step_id: "bad",
      },
    ];
    const sent: string[] = [];
    const uploads: unknown[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2(opts: unknown) {
        uploads.push(opts);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(uploads).toEqual([]);
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });

  it("identical file steps are suppressed by RecentPosts", async () => {
    const raw = Buffer.from("same-bytes");
    const other = Buffer.from("other-bytes");
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content_b64: raw.toString("base64"), step_id: "a" },
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content_b64: raw.toString("base64"), step_id: "b" },
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content_b64: other.toString("base64"), step_id: "c" },
    ];
    const uploads: Buffer[] = [];
    const client = {
      async chatPostMessage() {
        throw new Error("no text fallback expected");
      },
      async filesUploadV2(opts: { content: string | Uint8Array }) {
        uploads.push(Buffer.from(opts.content as Uint8Array));
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(uploads).toEqual([raw, other]);
  });

  it("an invalid file step does not stop later replies", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "bad.bin", content: { x: "y" }, step_id: "bad" },
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", content: "later reply", step_id: "ok" },
    ];
    const sent: string[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2() {
        throw new Error("should not upload");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["(failed to deliver file bad.bin)", "later reply"]);
  });

  it("a client with no filesUploadV2 posts a notice", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content: "hi", step_id: "n" },
    ];
    const sent: string[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });

  it("dedupe is recorded only after Slack accepts: a rejected upload retries (1c: c7d240b)", async () => {
    const raw = Buffer.from("same-bytes");
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content_b64: raw.toString("base64"), step_id: "a" },
      { type: "message", from: "audel", to: "slack-U1-C1", source: "chat", filename: "note.txt", content_b64: raw.toString("base64"), step_id: "b" },
    ];
    const sent: string[] = [];
    const uploads: Buffer[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async filesUploadV2(opts: { content: string | Uint8Array }) {
        uploads.push(Buffer.from(opts.content as Uint8Array));
        if (uploads.length === 1) throw new Error("upload rejected");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(uploads).toEqual([raw, raw]);
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });
});

// -- outbound reactions via `chat react` (1c: 6a98ab5) -----------------------

describe("slack outbound: reactionName / messageTsFromSourceUrl (1c: 6a98ab5)", () => {
  it("messageTsFromSourceUrl decodes an archive permalink", () => {
    const parse = outbound.messageTsFromSourceUrl;
    expect(parse("https://laudesters.slack.com/archives/C123/p1788451200123456")).toBe("1788451200.123456");
    expect(parse("https://slack.com/archives/C1/p12345678")).toBe("12.345678");
    expect(parse("https://example.com/archives/C123/p1788451200123456")).toBe("1788451200.123456");
    expect(parse("not-a-url")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse("https://slack.com/archives/C123")).toBeNull();
    expect(parse("https://slack.com/files/C123/p1788451200123456")).toBeNull();
  });

  it("reactionName strips colons and validates the character set", () => {
    expect(outbound.reactionName({ reaction: "thumbsup" })).toBe("thumbsup");
    expect(outbound.reactionName({ reaction: ":eyes:" })).toBe("eyes");
    expect(outbound.reactionName({ reaction: "+1" })).toBe("+1");
    expect(outbound.reactionName({ reaction: "thumbsup::skin-tone-2" })).toBe("thumbsup::skin-tone-2");
    expect(outbound.reactionName({ reaction: "not a name" })).toBeNull();
    expect(outbound.reactionName({ reaction: "" })).toBeNull();
    expect(outbound.reactionName({ content: ":eyes:" })).toBeNull();
  });
});

describe("slack outbound: reaction steps call reactions.add (1c: 6a98ab5)", () => {
  it("a reaction step with a source_url permalink calls reactions.add on its ts", async () => {
    const steps = [
      {
        type: "message",
        from: "audel",
        to: "slack-U1-C1-1722400000.123456",
        source: "chat",
        reaction: "thumbsup",
        content: ":thumbsup:",
        source_url: "https://laudesters.slack.com/archives/C1/p1722400000123456",
        step_id: "r1",
      },
      { type: "message", from: "audel", to: "slack-U1-C1-1722400000.123456", source: "chat", content: "text after", step_id: "t1" },
    ];
    const added: Array<[string, string, string]> = [];
    const sent: string[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async reactionsAdd(channel: string, timestamp: string, name: string) {
        added.push([channel, timestamp, name]);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual([["C1", "1722400000.123456", "thumbsup"]]);
    expect(sent).toEqual(["text after"]);
  });

  it("falls back to the conversation's thread_ts without a permalink", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1722400000.123456", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "r1" },
    ];
    const added: Array<[string, string, string]> = [];
    const client = {
      async chatPostMessage() {
        throw new Error("reaction must not post text");
      },
      async reactionsAdd(channel: string, timestamp: string, name: string) {
        added.push([channel, timestamp, name]);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual([["C1", "1722400000.123456", "eyes"]]);
  });

  it("a DM reaction with no permalink (no thread_ts) is skipped", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-D1", source: "chat", reaction: "thumbsup", content: ":thumbsup:", step_id: "r1" },
      { type: "message", from: "audel", to: "slack-U1-D1", source: "chat", content: "later", step_id: "t1" },
    ];
    const added: unknown[] = [];
    const sent: string[] = [];
    const client = {
      async chatPostMessage(_c: string, text: string) {
        sent.push(text);
      },
      async reactionsAdd(...args: unknown[]) {
        added.push(args);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual([]);
    expect(sent).toEqual(["later"]);
  });

  it("identical reactions are suppressed by RecentPosts, distinct ones are not", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "a" },
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "b" },
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "thumbsup", content: ":thumbsup:", step_id: "c" },
    ];
    const added: string[] = [];
    const client = {
      async chatPostMessage() {
        throw new Error("no text");
      },
      async reactionsAdd(_c: string, _t: string, name: string) {
        added.push(name);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual(["eyes", "thumbsup"]);
  });

  it("a failed reaction is not recorded, so a retry works", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "a" },
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "b" },
    ];
    const added: string[] = [];
    const client = {
      async chatPostMessage() {
        throw new Error("no text");
      },
      async reactionsAdd(_c: string, _t: string, name: string) {
        added.push(name);
        if (added.length === 1) throw new Error("transient");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual(["eyes", "eyes"]);
  });

  it("already_reacted counts as success, so a repeat is suppressed", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "a" },
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "b" },
    ];
    const added: string[] = [];
    const client = {
      async chatPostMessage() {
        throw new Error("no text");
      },
      async reactionsAdd(_c: string, _t: string, name: string) {
        added.push(name);
        throw new Error("already_reacted");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual(["eyes"]);
  });

  it("a forged reaction step (source != chat) is ignored", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "responder", reaction: "eyes", content: ":eyes:", step_id: "forged" },
    ];
    const added: unknown[] = [];
    const client = {
      async chatPostMessage() {
        throw new Error("no text");
      },
      async reactionsAdd(...args: unknown[]) {
        added.push(args);
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(added).toEqual([]);
  });

  it("a client with no reactionsAdd logs and skips (no crash)", async () => {
    const steps = [
      { type: "message", from: "audel", to: "slack-U1-C1-1.1", source: "chat", reaction: "eyes", content: ":eyes:", step_id: "a" },
    ];
    const client = {
      async chatPostMessage() {
        throw new Error("no text");
      },
    };
    const threads = { touch: () => {}, isActive: () => false };
    await expect(
      outbound.run(baseCfg(), client, threads, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} }),
    ).resolves.toBeUndefined();
  });
});

describe("slack outbound: RecentPosts seen/record split (1c: c7d240b)", () => {
  it("seen() checks without recording; record() stamps explicitly", () => {
    const recent = new outbound.RecentPosts(300);
    expect(recent.seen("c1", "hello", 1000)).toBe(false);
    expect(recent.seen("c1", "hello", 1000)).toBe(false); // seen() never records
    recent.record("c1", "hello", 1000);
    expect(recent.seen("c1", "hello", 1005)).toBe(true);
    expect(recent.seen("c1", "hello", 1400)).toBe(false); // outside window
  });
});

// ---- 2e39a3f: delivery notices and the short address forms
// (port of the tail of slack/tests/test_outbound.py; design/outbound_delivery.md)

type Notice = Record<string, unknown>;

async function drive(
  steps: Array<Record<string, unknown>>,
  client: unknown,
  extra: Partial<outbound.RunOptions> = {},
): Promise<{ notices: Notice[]; touched: Array<[string, string | null | undefined]>; logs: string[] }> {
  const notices: Notice[] = [];
  const touched: Array<[string, string | null | undefined]> = [];
  const logs: string[] = [];
  await outbound.run(
    baseCfg(),
    client as outbound.OutboundClientLike,
    { touch: (c: string, t: string | null | undefined) => touched.push([c, t]), isActive: () => false },
    {
      mindlogImpl: mindlogOf(steps),
      log: (l) => logs.push(l),
      appendStep: (_root, _traj, step) => {
        notices.push(step);
      },
      ...extra,
    },
  );
  return { notices, touched, logs };
}

class RecordingClient {
  posts: Array<{ channel: string; threadTs: string | null | undefined; text: string }> = [];
  opened: string[] = [];
  failPost: boolean;
  constructor(failPost = false) {
    this.failPost = failPost;
  }
  async chatPostMessage(channel: string, text: string, opts?: { threadTs?: string | null }): Promise<unknown> {
    if (this.failPost) throw new Error("channel_not_found");
    this.posts.push({ channel, threadTs: opts?.threadTs ?? null, text });
    return { ok: true, ts: `1757372480.${String(this.posts.length).padStart(6, "0")}` };
  }
  async conversationsOpen(users: string): Promise<unknown> {
    this.opened.push(users);
    return { ok: true, channel: { id: `D-${users}` } };
  }
  async chatGetPermalink(channel: string, ts: string): Promise<unknown> {
    return { ok: true, permalink: `https://x.slack.com/archives/${channel}/p${ts.replace(".", "")}` };
  }
}

function msg(stepId: string, to: string, content = "hello"): Record<string, unknown> {
  return { type: "message", from: "audel", to, source: "chat", content, step_id: stepId };
}

describe("slack outbound: delivery notices (2e39a3f)", () => {
  it("a bare channel posts top-level and is confirmed", async () => {
    const c = new RecordingClient();
    const { notices } = await drive([msg("m1", "slack-C0BMVH6LM4K", "papers")], c);
    expect(c.posts).toEqual([{ channel: "C0BMVH6LM4K", threadTs: null, text: "papers" }]);
    expect(c.opened).toEqual([]);
    expect(notices).toHaveLength(1);
    const n = notices[0]!;
    expect([n.type, n.source, n.transport, n.status, n.trigger_step, n.to]).toEqual([
      "delivery", "slack-bridge", "slack", "delivered", "m1", "slack-C0BMVH6LM4K",
    ]);
    expect(n.channel).toBe("C0BMVH6LM4K");
    expect(n.message_ts).toBe("1757372480.000001");
    expect(n).not.toHaveProperty("ts"); // traj append owns ts
    expect(String(n.permalink).endsWith("/archives/C0BMVH6LM4K/p1757372480000001")).toBe(true);
    expect(n.content).toBe("delivered to slack-C0BMVH6LM4K");
  });

  it("a bare user opens the DM once", async () => {
    const c = new RecordingClient();
    const { notices } = await drive([msg("m1", "slack-U0BFD9NDVE3", "one"), msg("m2", "slack-U0BFD9NDVE3", "two")], c);
    expect(c.opened).toEqual(["U0BFD9NDVE3"]);
    expect(c.posts.map((p) => p.channel)).toEqual(["D-U0BFD9NDVE3", "D-U0BFD9NDVE3"]);
    expect(notices.map((n) => n.status)).toEqual(["delivered", "delivered"]);
    expect(notices[0]!.channel).toBe("D-U0BFD9NDVE3");
  });

  it("a malformed slack-* address fails loudly (no post, a failed notice, a log line)", async () => {
    const c = new RecordingClient();
    const { notices, logs } = await drive([msg("m1", "slack-...", "x"), msg("m2", "slack-nick", "y")], c);
    expect(c.posts).toEqual([]);
    expect(notices.map((n) => n.status)).toEqual(["failed", "failed"]);
    expect(notices.map((n) => n.trigger_step)).toEqual(["m1", "m2"]);
    expect(String(notices[0]!.reason)).toContain("unknown slack address form");
    expect(String(notices[0]!.reason)).toContain("slack-C<id>");
    expect(String(notices[0]!.content).startsWith("not delivered to slack-...")).toBe(true);
    expect(logs.some((l) => l.includes("undeliverable address"))).toBe(true);
  });

  it("other transports get no notice", async () => {
    const c = new RecordingClient();
    const { notices } = await drive([msg("m1", "telegram-1-1"), msg("m2", "pwa-andy")], c);
    expect(c.posts).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("a Slack API failure is a failed notice", async () => {
    const c = new RecordingClient(true);
    const { notices } = await drive([msg("m1", "slack-U1-C1-1.2")], c);
    expect(notices[0]!.status).toBe("failed");
    expect(String(notices[0]!.reason)).toContain("channel_not_found");
    expect(notices[0]).not.toHaveProperty("message_ts");
  });

  it("a SlackApiError's reason carries the slack error code", async () => {
    const { SlackApiError } = await import("../src/slack/api.ts");
    const c = new RecordingClient();
    c.chatPostMessage = async () => {
      throw new SlackApiError("chat.postMessage: is_archived", { ok: false, error: "is_archived" });
    };
    const { notices } = await drive([msg("m1", "slack-U1-C1-1.2")], c);
    expect(notices[0]!.reason).toBe("SlackApiError: is_archived");
  });

  it("a duplicate within the window is a skipped notice", async () => {
    const c = new RecordingClient();
    const { notices } = await drive([msg("m1", "slack-C1", "same"), msg("m2", "slack-C1", "same")], c);
    expect(c.posts).toHaveLength(1);
    expect(notices.map((n) => n.status)).toEqual(["delivered", "skipped"]);
    expect(String(notices[1]!.reason)).toContain("duplicate");
  });

  it("a DM-open failure is a failed notice", async () => {
    const c = new RecordingClient();
    c.conversationsOpen = async () => {
      throw new Error("user_not_found");
    };
    const { notices } = await drive([msg("m1", "slack-U9")], c);
    expect(c.posts).toEqual([]);
    expect(notices[0]!.status).toBe("failed");
    expect(String(notices[0]!.reason)).toContain("user_not_found");
  });

  it("a file upload writes a delivered notice", async () => {
    const body = Buffer.from("hello file\n");
    const step = {
      type: "message", from: "audel", to: "slack-C1", source: "chat", filename: "note.txt",
      content: "hello file", content_b64: body.toString("base64"), step_id: "f1",
    };
    const c = Object.assign(new RecordingClient(), { filesUploadV2: async () => ({ ok: true }) });
    const { notices } = await drive([step], c);
    expect(notices[0]!.status).toBe("delivered");
    expect(notices[0]!.filename).toBe("note.txt");
    expect(notices[0]!.channel).toBe("C1");
  });

  it("a failed file upload writes a failed notice with the filename", async () => {
    const body = Buffer.from("x");
    const step = {
      type: "message", from: "audel", to: "slack-C1", source: "chat", filename: "n.txt",
      content: "x", content_b64: body.toString("base64"), step_id: "f2",
    };
    const c = Object.assign(new RecordingClient(), {
      filesUploadV2: async () => {
        throw new Error("nope");
      },
    });
    const { notices } = await drive([step], c);
    expect(notices[0]!.status).toBe("failed");
    expect(notices[0]!.filename).toBe("n.txt");
    expect(String(notices[0]!.reason)).toContain("nope");
    expect(c.posts.map((p) => p.text)).toEqual(["(failed to deliver file n.txt)"]);
  });

  it("a client that returns nothing still confirms, without ts or permalink", async () => {
    const bare = { async chatPostMessage(): Promise<unknown> { return null; } };
    const { notices } = await drive([msg("m1", "slack-U1-C1")], bare);
    expect(notices[0]!.status).toBe("delivered");
    expect(notices[0]).not.toHaveProperty("message_ts");
    expect(notices[0]).not.toHaveProperty("permalink");
  });

  it("a partly-posted multi-chunk failure records message_ts and the partial reason", async () => {
    let n = 0;
    const c = new RecordingClient();
    c.chatPostMessage = async (channel: string) => {
      n += 1;
      if (n === 2) throw new Error("rate_limited");
      return { ok: true, ts: "1757372480.000009", channel };
    };
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const { notices } = await drive([msg("m1", "slack-C1", long)], c);
    expect(notices[0]!.status).toBe("failed");
    expect(String(notices[0]!.reason).startsWith("partly posted, then Error: rate_limited")).toBe(true);
    expect(notices[0]!.message_ts).toBe("1757372480.000009");
  });

  it("a reaction addressed to a bare user (no channel) logs and skips", async () => {
    const added: unknown[] = [];
    const c = Object.assign(new RecordingClient(), { reactionsAdd: async (...a: unknown[]) => void added.push(a) });
    const step = { ...msg("r1", "slack-U0BFD9NDVE3"), reaction: "tada", source_url: "https://x.slack.com/archives/C1/p1757372480000001" };
    const { logs } = await drive([step], c);
    expect(added).toEqual([]);
    expect(logs.some((l) => l.includes("needs a channel"))).toBe(true);
  });
});

describe("slack outbound: notice writer (2e39a3f)", () => {
  it("an unwritable trajectory disables notices after one error; delivery is unaffected", async () => {
    const calls: unknown[] = [];
    const c = new RecordingClient();
    const { logs } = await drive([msg("m1", "slack-C1", "a"), msg("m2", "slack-C1", "b")], c, {
      appendStep: (_r, _t, step) => {
        calls.push(step);
        const e = new Error("not writable");
        e.name = "PermissionError";
        throw e;
      },
    });
    expect(c.posts.map((p) => p.text)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1);
    expect(logs.filter((l) => l.includes("delivery notices disabled")).length).toBe(1);
  });

  it("another notice error is logged per step and does not disable", async () => {
    const calls: unknown[] = [];
    const c = new RecordingClient();
    const { logs } = await drive([msg("m1", "slack-C1", "a"), msg("m2", "slack-C1", "b")], c, {
      appendStep: (_r, _t, step) => {
        calls.push(step);
        throw new Error("disk full");
      },
    });
    expect(calls).toHaveLength(2);
    expect(logs.filter((l) => l.includes("could not write delivery notice")).length).toBe(2);
  });

  it("appendStepViaTraj refuses an unwritable log, and otherwise appends a locked step with the trajectory's own ts/step_id stamping", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-notice-"));
    // missing file -> PermissionError, nothing created
    const traj = path.join(dir, "trajectories", "455a2181-root", "trajectory.jsonl");
    expect(() => outbound.appendStepViaTraj(dir, traj, { type: "delivery" })).toThrow(/not writable/);
    fs.mkdirSync(path.dirname(traj), { recursive: true });
    fs.writeFileSync(traj, "");
    outbound.appendStepViaTraj(dir, traj, { type: "delivery", status: "delivered", message_ts: "1.2", ts: "FORGED" });
    const row = JSON.parse(fs.readFileSync(traj, "utf8").trim());
    expect(row.type).toBe("delivery");
    expect(row.message_ts).toBe("1.2");
    expect(row.step_id).toBeTruthy();
    expect(row.ts).not.toBe("FORGED");
  });
});

describe("slack outbound: top-level post registers its own thread (2e39a3f)", () => {
  it("a bare channel post becomes a thread root", async () => {
    const { touched } = await drive([msg("m1", "slack-C0BMVH6LM4K", "papers")], new RecordingClient());
    expect(touched).toContainEqual(["C0BMVH6LM4K", "1757372480.000001"]);
  });

  it("a threaded reply does not register a new root", async () => {
    const { touched } = await drive([msg("m1", "slack-U0BFD9NDVE3-C0BMVH6LM4K-1789018408.414049", "reply")], new RecordingClient());
    expect(touched).toEqual([["C0BMVH6LM4K", "1789018408.414049"]]);
  });

  it("a failed top-level post registers nothing", async () => {
    const { touched } = await drive([msg("m1", "slack-C0BMVH6LM4K", "papers")], new RecordingClient(true));
    expect(touched.filter((t) => t[1] != null)).toEqual([]);
  });
});
