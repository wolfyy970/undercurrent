// slack-peers.test.ts — port of the inbound sections of
// headlong/slack/tests/test_peers.py and the three 2e39a3f cases added to
// test_inbound.py (409 refusal is final, other failures still retry, a peer's
// bridge error text is not forwarded). Config/guard sections live in
// slack-config.test.ts and slack-state.test.ts.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbound, DELIVERY_ATTEMPTS, DELIVERY_ERROR_TEXT, HttpStatusError, refusalReason } from "../src/slack/inbound.ts";
import { ActiveThreads } from "../src/slack/state.ts";
import type { Config } from "../src/slack/config.ts";

const BOT = "U_BOT";
const PEER = "U_PEER";
const OTHER_BOT = "U_OTHERBOT";
const NICK = "U_NICK";
const CHAN = "C_CHAN";
const PARENT = "111.222";

function makeCfg(over: Partial<Config> = {}): Config {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sl-peers-"));
  return {
    serveRoot: "/tmp",
    identity: "audel",
    identityDir: "/tmp/.identities/audel",
    botToken: "x",
    appToken: "x",
    webUrl: "http://127.0.0.1:9",
    stateDir: state,
    threadFollowups: true,
    threadJoinBackfill: 0,
    peerBotUsers: new Set([PEER]),
    peerMaxTurns: 4,
    peerHourlyCap: 30,
    ...over,
  };
}

function fakeClient() {
  const names: Record<string, string> = { [NICK]: "Nick Jalbert", [PEER]: "harris", [OTHER_BOT]: "otherbot" };
  return {
    usersInfo: vi.fn(async (u: string) => ({ profile: { display_name: names[u] ?? u } })),
    chatGetPermalink: vi.fn(async (channel: string, ts: string) => ({ permalink: `https://slack.test/${channel}/p${ts}` })),
    conversationsInfo: vi.fn(async () => ({ name: "headlong-bot-chatter", is_im: false })),
    chatPostMessage: vi.fn(async () => {}),
    reactionsGet: vi.fn(async () => ({ message: {} })),
    conversationsReplies: vi.fn(async () => ({ messages: [] })),
  };
}

let tsCounter = 200;
function ev(o: { user: string; text: string; bot?: boolean; threadTs?: string | null; mention?: boolean }) {
  tsCounter += 1;
  const mention = o.mention ?? true;
  const event: Record<string, unknown> = {
    type: mention ? "app_mention" : "message",
    user: o.user,
    text: (mention ? `<@${BOT}> ` : "") + o.text,
    channel: CHAN,
    ts: `${tsCounter.toFixed(3)}`,
    channel_type: "channel",
  };
  const threadTs = o.threadTs === undefined ? PARENT : o.threadTs;
  if (threadTs !== null) event.thread_ts = threadTs;
  if (o.bot) event.bot_id = "B_" + o.user;
  return event;
}

function bridge(cfgOver: Partial<Config> = {}) {
  const cfg = makeCfg(cfgOver);
  const threads = new ActiveThreads(path.join(cfg.stateDir, "threads.json"));
  const posted: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const client = fakeClient();
  const post = vi.fn(async (_u: string, b: unknown) => {
    posted.push(b as Record<string, unknown>);
  });
  const ib = new Inbound(cfg, client as never, BOT, threads, { post, log: (l) => logs.push(l), sleep: async () => {} });
  async function send(event: Record<string, unknown>, expectDelivery: boolean) {
    const before = posted.length;
    ib.onEvent(event);
    await ib.flush();
    expect(posted.length - before).toBe(expectDelivery ? 1 : 0);
    return expectDelivery ? posted[posted.length - 1]! : null;
  }
  return { ib, threads, posted, logs, client, send };
}

describe("slack peers: inbound", () => {
  it("a peer mention is forwarded and named as a persona", async () => {
    const b = bridge();
    const body = (await b.send(ev({ user: PEER, text: "hello audel", bot: true }), true))!;
    expect(body.from_name).toBe(`slack-${PEER}-${CHAN}-${PARENT}`);
    expect(String(body.content).startsWith("(Slack: harris, a Headlong persona like you, not a person in #headlong-bot-chatter")).toBe(true);
    expect(String(body.content).endsWith("hello audel")).toBe(true);
    expect(String(body.source_url).startsWith("https://slack.test/")).toBe(true);
    expect(b.threads.isActive(CHAN, PARENT)).toBe(true);
  });

  it("an unlisted bot is still dropped", async () => {
    await bridge().send(ev({ user: OTHER_BOT, text: "hi", bot: true }), false);
  });

  it("no peers configured keeps the old rule", async () => {
    await bridge({ peerBotUsers: new Set() }).send(ev({ user: PEER, text: "hi", bot: true }), false);
  });

  it("a peer without a mention in an inactive thread is dropped", async () => {
    await bridge().send(ev({ user: PEER, text: "just chatting", bot: true, mention: false }), false);
  });

  it("a peer follow-up in an active thread is forwarded", async () => {
    const b = bridge();
    b.threads.touch(CHAN, PARENT);
    await b.send(ev({ user: PEER, text: "following up", bot: true, mention: false }), true);
  });

  it("the loop guard stops a peer after max turns; a person (even unmentioned) resets", async () => {
    const b = bridge({ peerMaxTurns: 2 });
    await b.send(ev({ user: PEER, text: "one", bot: true }), true);
    await b.send(ev({ user: PEER, text: "two", bot: true }), true);
    await b.send(ev({ user: PEER, text: "three", bot: true }), false);
    await b.send(ev({ user: PEER, text: "four", bot: true }), false);
    // logged once per thread, not per refusal
    expect(b.logs.filter((l) => l.includes("not forwarded")).length).toBe(1);
    await b.send(ev({ user: NICK, text: "carry on you two", mention: false }), true); // active thread: forwarded, and it resets
    await b.send(ev({ user: PEER, text: "five", bot: true }), true);
  });

  it("a person in an unrelated thread does not reset", async () => {
    const b = bridge({ peerMaxTurns: 1 });
    await b.send(ev({ user: PEER, text: "one", bot: true }), true);
    await b.send(ev({ user: PEER, text: "two", bot: true }), false);
    await b.send(ev({ user: NICK, text: "elsewhere", threadTs: "555.666" }), true);
    await b.send(ev({ user: PEER, text: "three", bot: true }), false);
  });

  it("person messages are never guarded", async () => {
    const b = bridge({ peerMaxTurns: 0, peerHourlyCap: 0 });
    await b.send(ev({ user: NICK, text: "hi audel" }), true);
    await b.send(ev({ user: NICK, text: "still here" }), true);
  });
});

function dm(user: string, text: string, bot = false): Record<string, unknown> {
  tsCounter += 1;
  const e: Record<string, unknown> = { type: "message", user, channel: "D123", ts: `${tsCounter}.100`, text, channel_type: "im" };
  if (bot) e.bot_id = "B1";
  return e;
}

describe("slack inbound: delivery refusals (2e39a3f)", () => {
  it("a 409 is final: no retry, no 'couldn't reach my mind' post", async () => {
    const cfg = makeCfg();
    const client = fakeClient();
    const logs: string[] = [];
    const body = '{"detail":{"message":"refusing to send: this exact message already went"}}';
    const post = vi.fn(async () => {
      throw new HttpStatusError(409, body);
    });
    const sleep = vi.fn(async () => {
      throw new Error("slept");
    });
    const ib = new Inbound(cfg, client as never, BOT, { touch() {}, isActive: () => false }, { post, log: (l) => logs.push(l), sleep });
    ib.onEvent(dm(NICK, "great"));
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(client.chatPostMessage).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("chat POST refused") && l.includes("this exact message already went"))).toBe(true);
  });

  it("other failures still retry and post the error text once", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const ib = new Inbound(makeCfg(), client as never, BOT, { touch() {}, isActive: () => false }, { post, log: () => {}, sleep: async () => {} });
    ib.onEvent(dm(NICK, "great"));
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(DELIVERY_ATTEMPTS);
    expect(client.chatPostMessage).toHaveBeenCalledTimes(1);
    expect((client.chatPostMessage.mock.calls[0] as unknown[])[1]).toBe(DELIVERY_ERROR_TEXT);
  });

  it("a 500 (HttpStatusError that is not 409) is retried", async () => {
    const post = vi.fn(async () => {
      throw new HttpStatusError(500, "oops");
    });
    const ib = new Inbound(makeCfg(), fakeClient() as never, BOT, { touch() {}, isActive: () => false }, { post, log: () => {}, sleep: async () => {} });
    ib.onEvent(dm(NICK, "x"));
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(DELIVERY_ATTEMPTS);
  });

  it("a peer's bridge error text is not forwarded; a person quoting it is", async () => {
    const posted: unknown[] = [];
    const post = vi.fn(async (_u: string, b: unknown) => {
      posted.push(b);
    });
    const ib = new Inbound(makeCfg({ peerBotUsers: new Set([PEER]) }), fakeClient() as never, BOT, { touch() {}, isActive: () => false }, { post, log: () => {}, sleep: async () => {} });
    ib.onEvent(dm(PEER, DELIVERY_ERROR_TEXT, true));
    await ib.flush();
    expect(posted).toEqual([]);
    ib.onEvent(dm(NICK, DELIVERY_ERROR_TEXT));
    await ib.flush();
    expect(posted.length).toBe(1);
  });

  it("refusalReason mirrors _refusal_reason", () => {
    expect(refusalReason('{"detail":{"message":"nope"}}')).toBe("nope");
    expect(refusalReason('{"detail":"plain"}')).toBe("plain");
    expect(refusalReason('{"detail":{"code":1}}')).toBe("{'code': 1}");
    expect(refusalReason("not json at all")).toBe("not json at all");
    expect(refusalReason("[1,2]")).toBe("[1,2]");
    expect(refusalReason("x".repeat(300)).length).toBe(200);
  });
});
