// telegram-inbound.test.ts — port of headlong/telegram/tests/test_inbound.py.
// The inbound gate: DM-only, admin commands, allowlist, delivery.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbound, HttpStatusError, DELIVERY_ATTEMPTS, DELIVERY_ERROR_TEXT, type BotLike } from "../src/telegram/inbound.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { Bot, type FetchLike } from "../src/telegram/api.ts";
import type { Config } from "../src/telegram/config.ts";

const ADMIN = 100;

class FakeBot implements BotLike {
  sent: Array<[number, string]> = [];
  left: number[] = [];
  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push([chatId, text]);
  }
  async leaveChat(chatId: number): Promise<void> {
    this.left.push(chatId);
  }
  async getUpdates(): Promise<Array<Record<string, unknown>>> {
    return [];
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-inbound-"));
}

function makeBridge(extra: { post?: (url: string, body: unknown) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {}) {
  const tmp = tmpDir();
  const identityDir = path.join(tmp, ".identities", "audel");
  fs.mkdirSync(identityDir, { recursive: true });
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir);
  const cfg: Config = {
    serveRoot: tmp,
    identity: "audel",
    identityDir,
    botToken: "t",
    adminId: ADMIN,
    webUrl: "http://web.test",
    stateDir,
  };
  const bot = new FakeBot();
  const posts: Array<[string, Record<string, unknown>]> = [];
  const post = async (url: string, body: unknown) => {
    posts.push([url, body as Record<string, unknown>]);
  };
  const ib = new Inbound(cfg, bot, new Allowlist(path.join(stateDir, "allowlist.json")), {
    post: extra.post ?? post,
    log: () => {},
    ...(extra.sleep ? { sleep: extra.sleep } : {}),
  });
  return { ib, bot, posts };
}

function dm(userId: number, text: string, name = "Dana") {
  return {
    message: {
      chat: { id: userId, type: "private" },
      from: { id: userId, first_name: name },
      text,
    },
  };
}

/** Like dm() but includes a message_id (as Telegram always does). */
function dmWithMsgId(userId: number, text: string, msgId: number, name = "Dana") {
  return {
    message: {
      message_id: msgId,
      chat: { id: userId, type: "private" },
      from: { id: userId, first_name: name },
      text,
    },
  };
}

describe("telegram inbound", () => {
  it("group message is dropped and left", async () => {
    const { ib, bot, posts } = makeBridge();
    await ib.handle({
      message: {
        chat: { id: -100123, type: "supergroup" },
        from: { id: 7, first_name: "Dana" },
        text: "hi all",
      },
    });
    expect(bot.left).toEqual([-100123]);
    expect(posts).toEqual([]);
  });

  it("stranger is silent but admin prompted once", async () => {
    const { ib, bot, posts } = makeBridge();
    await ib.handle(dm(7, "let me in"));
    await ib.handle(dm(7, "hello?"));
    expect(posts).toEqual([]);
    const adminPrompts = bot.sent.filter(([c]) => c === ADMIN);
    expect(adminPrompts.length).toBe(1);
    expect(adminPrompts[0]![1]).toContain("/approve 7");
    expect(bot.sent.some(([c]) => c === 7)).toBe(false); // never reply to strangers
  });

  it("approve flow end to end", async () => {
    const { ib, bot, posts } = makeBridge();
    await ib.handle(dm(7, "hi"));
    await ib.handle(dm(ADMIN, "/approve 7"));
    await ib.handle(dm(7, "hello Audel"));
    expect(posts.length).toBe(1);
    const [url, body] = posts[0]!;
    expect(url.endsWith("/api/identities/.identities~audel/chat")).toBe(true);
    expect(body.from_name).toBe("telegram-7-7");
    expect(String(body.content)).toContain("hello Audel");
    expect(String(body.content)).toContain("chat reply telegram-7-7");
    expect(bot.sent).toContainEqual([7, "You're approved — say hi and I'll pass it on."]);
  });

  it("admin commands never reach mind log", async () => {
    const { ib, posts } = makeBridge();
    for (const text of ["/list", "/approve 9", "/revoke 9", "/deny 8", "/help"]) {
      await ib.handle(dm(ADMIN, text));
    }
    expect(posts).toEqual([]);
  });

  it("admin plain text goes to identity", async () => {
    const { ib, posts } = makeBridge();
    await ib.handle(dm(ADMIN, `/approve ${ADMIN}`));
    await ib.handle(dm(ADMIN, "morning, Audel"));
    expect(posts.length).toBe(1);
    expect(posts[0]![1].from_name).toBe(`telegram-${ADMIN}-${ADMIN}`);
  });

  it("media and bots are dropped", async () => {
    const { ib, posts } = makeBridge();
    ib.allowlist.approve(7);
    await ib.handle({ message: { chat: { id: 7, type: "private" }, from: { id: 7 }, sticker: {} } });
    await ib.handle({
      message: { chat: { id: 7, type: "private" }, from: { id: 7, is_bot: true }, text: "beep" },
    });
    expect(posts).toEqual([]);
  });

  it("duplicate message_id is dropped", async () => {
    // A client retry that re-delivers the same message_id must not double-post.
    const { ib, posts } = makeBridge();
    ib.allowlist.approve(7);
    await ib.handle(dmWithMsgId(7, "hello", 500));
    await ib.handle(dmWithMsgId(7, "hello", 500));
    expect(posts.length).toBe(1);
    expect(String(posts[0]![1].content).endsWith("hello")).toBe(true);
  });

  it("same msg_id from different users is delivered", async () => {
    // message_id is per-chat; the same id from two users is two messages.
    const { ib, posts } = makeBridge();
    ib.allowlist.approve(7);
    ib.allowlist.approve(8);
    await ib.handle(dmWithMsgId(7, "hi", 600));
    await ib.handle(dmWithMsgId(8, "hey", 600, "Eve"));
    expect(posts.length).toBe(2);
  });

  it("same text new msg_id is delivered", async () => {
    // The same text sent twice as distinct messages is delivered twice.
    const { ib, posts } = makeBridge();
    ib.allowlist.approve(7);
    await ib.handle(dmWithMsgId(7, "ok", 503));
    await ib.handle(dmWithMsgId(7, "ok", 504));
    expect(posts.length).toBe(2);
  });

  it("poll loop survives a malformed API response", async () => {
    // Driven through a real Bot rather than FakeBot: the failure lives in
    // how Bot.call surfaces the error, which a fake bot cannot reproduce.
    const tmp = tmpDir();
    const identityDir = path.join(tmp, ".identities", "audel");
    fs.mkdirSync(identityDir, { recursive: true });
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir);
    const cfg: Config = {
      serveRoot: tmp,
      identity: "audel",
      identityDir,
      botToken: "t",
      adminId: ADMIN,
      webUrl: "http://web.test",
      stateDir,
    };
    const fetchImpl: FetchLike = async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const bot = new Bot("t", { fetchImpl });
    const slept: number[] = [];
    const ib = new Inbound(cfg, bot, new Allowlist(path.join(stateDir, "allowlist.json")), {
      log: () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    let calls = 0;
    const shouldStop = () => {
      calls += 1;
      return calls > 1; // one failing poll, then stop
    };
    await ib.run(shouldStop); // must return, not throw
    expect(slept).toEqual([5000]);
  });
});

// ---- 2e39a3f: a 409 from the web API is the mind refusing on purpose.
describe("telegram inbound: delivery refusals (2e39a3f)", () => {
  it("a 409 is not retried and posts no error", async () => {
    const calls: unknown[] = [];
    const { ib, bot } = makeBridge({
      post: async (_u, b) => {
        calls.push(b);
        throw new HttpStatusError(409, '{"detail":{"message":"refusing"}}');
      },
      sleep: async () => {
        throw new Error("slept");
      },
    });
    ib["allowlist"].approve(7);
    await ib.handle(dm(7, "great"));
    expect(calls).toHaveLength(1);
    expect(bot.sent).toEqual([]);
  });

  it("other failures still retry and post the error text", async () => {
    const calls: unknown[] = [];
    const { ib, bot } = makeBridge({
      post: async (_u, b) => {
        calls.push(b);
        throw new HttpStatusError(503, "");
      },
      sleep: async () => {},
    });
    ib["allowlist"].approve(7);
    await ib.handle(dm(7, "great"));
    expect(calls).toHaveLength(DELIVERY_ATTEMPTS);
    expect(bot.sent).toEqual([[7, DELIVERY_ERROR_TEXT]]);
  });
});
