// slack-inbound.test.ts — at the 7d29f9e pin, no upstream Python test file
// existed for headlong_slack.inbound; these first cases exercise the port
// directly against the documented behavior in inbound.py: the _on_event
// gate (bot_id/subtype skip, dedupe, DM vs mention vs thread-followup
// routing) and _deliver (header assembly, retry+backoff, the
// delivery-error fallback post).
//
// Upstream sync 1c added slack/tests/test_inbound.py (e5a2f7c..cb974c2,
// f68c1d8): reaction routing/dedupe/lookup-executor-bound cases and
// f68c1d8's chat_getPermalink/source_url cases
// (test_deliver_records_slack_permalink, test_permalink_failure_does_not_
// drop_message) below are ported 1:1 from it (see each describe block's
// PORT-NOTE for the source commit).

import { describe, it, expect, vi } from "vitest";
import { Inbound, SlackNames, DELIVERY_ERROR_TEXT, reactionText } from "../src/slack/inbound.ts";
import type { Config } from "../src/slack/config.ts";

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    serveRoot: "/tmp",
    identity: "audel",
    identityDir: "/tmp/.identities/audel",
    botToken: "x",
    appToken: "x",
    webUrl: "http://web.example",
    stateDir: "/tmp/state",
    threadFollowups: false,
    threadJoinBackfill: 0,
    peerBotUsers: new Set<string>(),
    peerMaxTurns: 4,
    peerHourlyCap: 30,
    ...overrides,
  };
}

function fakeThreads() {
  const active = new Set<string>();
  return {
    touch: vi.fn((channel: string, threadTs: string | null | undefined) => {
      if (threadTs) active.add(`${channel}:${threadTs}`);
    }),
    isActive: (channel: string, threadTs: string | null | undefined) =>
      !!threadTs && active.has(`${channel}:${threadTs}`),
  };
}

function fakeClient(
  overrides: Partial<{
    usersInfo: unknown;
    conversationsInfo: unknown;
    chatPostMessage: unknown;
    reactionsGet: unknown;
    conversationsReplies: unknown;
    chatGetPermalink: unknown;
  }> = {},
) {
  return {
    usersInfo: vi.fn(async (user: string) => ({ real_name: `Real ${user}`, profile: {} })),
    conversationsInfo: vi.fn(async (channel: string) => ({ name: `chan-${channel}` })),
    chatPostMessage: vi.fn(async () => {}),
    reactionsGet: vi.fn(async () => ({ message: {} })),
    conversationsReplies: vi.fn(async () => ({ messages: [] })),
    chatGetPermalink: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("slack inbound: SlackNames", () => {
  it("caches user display name, preferring profile.display_name over real_name", async () => {
    const client = fakeClient({
      usersInfo: vi.fn(async () => ({ real_name: "Real Name", profile: { display_name: "Handle" } })),
    });
    const names = new SlackNames(client as never);
    expect(await names.user("U1")).toBe("Handle");
    expect(await names.user("U1")).toBe("Handle");
    expect(client.usersInfo).toHaveBeenCalledTimes(1);
  });

  it("falls back to real_name, then the raw id, and swallows errors", async () => {
    const client1 = fakeClient({ usersInfo: vi.fn(async () => ({ real_name: "Real Name", profile: {} })) });
    const names1 = new SlackNames(client1 as never);
    expect(await names1.user("U1")).toBe("Real Name");

    const client2 = fakeClient({
      usersInfo: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const names2 = new SlackNames(client2 as never, () => {});
    expect(await names2.user("U1")).toBe("U1");
  });

  it("place: 'D'-prefixed channel ids are always DM, never looked up", async () => {
    const client = fakeClient();
    const names = new SlackNames(client as never);
    expect(await names.place("D123")).toBe("DM");
    expect(client.conversationsInfo).not.toHaveBeenCalled();
  });

  it("place: other channels are looked up and prefixed with #", async () => {
    const client = fakeClient({ conversationsInfo: vi.fn(async () => ({ name: "eng" })) });
    const names = new SlackNames(client as never);
    expect(await names.place("C1")).toBe("#eng");
    expect(await names.place("C1")).toBe("#eng");
    expect(client.conversationsInfo).toHaveBeenCalledTimes(1);
  });
});

describe("slack inbound: Inbound.onEvent gate", () => {
  it("skips events with bot_id or a subtype", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hi", bot_id: "B1", channel_type: "im" });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.2", text: "hi", subtype: "message_changed", channel_type: "im" });
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("skips events from the bot itself or with no user/channel/ts", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "message", user: "UBOT", channel: "D1", ts: "1.1", channel_type: "im" });
    ib.onEvent({ type: "message", channel: "D1", ts: "1.1", channel_type: "im" });
    ib.onEvent({ type: "message", user: "U1", ts: "1.1", channel_type: "im" });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", channel_type: "im" });
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("dedupes the same channel:ts", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    const event = { type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hi", channel_type: "im" };
    ib.onEvent(event);
    ib.onEvent(event);
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("DM: delivers top-level (thread_ts null), from_name has no thread suffix", async () => {
    const client = fakeClient();
    let body: unknown;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello", channel_type: "im" });
    await ib.flush();
    expect((body as { from_name: string }).from_name).toBe("slack-U1-D1");
  });

  it("channel message with no mention and thread_followups off is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg({ threadFollowups: false }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent({ type: "message", user: "U1", channel: "C1", ts: "1.1", text: "no mention here" });
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("app_mention anchors a new thread at the mention ts and touches it", async () => {
    const client = fakeClient();
    let body: unknown;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b;
    });
    const threads = fakeThreads();
    const ib = new Inbound(makeCfg(), client as never, "UBOT", threads, { post, log: () => {} });
    ib.onEvent({ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@UBOT> hi" });
    await ib.flush();
    expect((body as { from_name: string }).from_name).toBe("slack-U1-C1-1.1");
    expect(threads.touch).toHaveBeenCalledWith("C1", "1.1");
  });

  it("a mention inside an existing thread anchors at thread_ts, not the mention ts", async () => {
    const client = fakeClient();
    let body: unknown;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "app_mention", user: "U1", channel: "C1", ts: "1.5", thread_ts: "1.1", text: "<@UBOT> hi" });
    await ib.flush();
    expect((body as { from_name: string }).from_name).toBe("slack-U1-C1-1.1");
  });

  it("thread_followups: an un-mentioned reply in an active thread is delivered", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const threads = fakeThreads();
    threads.touch("C1", "1.1"); // pre-seed the active thread
    const ib = new Inbound(makeCfg({ threadFollowups: true }), client as never, "UBOT", threads, {
      post,
      log: () => {},
    });
    ib.onEvent({ type: "message", user: "U1", channel: "C1", ts: "1.9", thread_ts: "1.1", text: "follow-up" });
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("thread_followups: a reply in a thread the bot never joined is still dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg({ threadFollowups: true }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent({ type: "message", user: "U1", channel: "C1", ts: "1.9", thread_ts: "1.1", text: "follow-up" });
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("delivers empty-after-cleaning text as a no-op (bare bot mention)", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@UBOT>" });
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("retries the chat POST up to 3 times, then posts the delivery-error text to slack", async () => {
    const posted: Array<{ channel: string; text: string }> = [];
    const client = fakeClient({
      chatPostMessage: vi.fn(async (channel: string, text: string) => {
        posted.push({ channel, text });
      }),
    });
    let attempts = 0;
    const post = vi.fn(async () => {
      attempts += 1;
      throw new Error("network down");
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
      sleep: async () => {}, // no real delay in tests
    });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello", channel_type: "im" });
    await ib.flush();
    expect(attempts).toBe(3);
    expect(posted).toEqual([{ channel: "D1", text: DELIVERY_ERROR_TEXT }]);
  });

  it("a successful attempt after a retry does not fall back to the error text", async () => {
    let calls = 0;
    const post = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error("flaky");
    });
    const client = fakeClient();
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
      sleep: async () => {},
    });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello", channel_type: "im" });
    await ib.flush();
    expect(calls).toBe(2);
    expect(client.chatPostMessage).not.toHaveBeenCalled();
  });
});

// -- chat_getPermalink / source_url (1c: f68c1d8) ----------------------------
// Ported 1:1 from slack/tests/test_inbound.py::test_deliver_records_slack_permalink
// and ::test_permalink_failure_does_not_drop_message.

describe("slack inbound: chat_getPermalink / source_url (1c: f68c1d8)", () => {
  it("deliver records the Slack permalink as source_url", async () => {
    const permalink = "https://laudesters.slack.com/archives/C123/p1788451200123456";
    const chatGetPermalink = vi.fn(async (channel: string, messageTs: string) => {
      expect(channel).toBe("D1");
      expect(messageTs).toBe("1.1");
      return { permalink };
    });
    const client = fakeClient({ chatGetPermalink });
    let body: { from_name: string; source_url?: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "can you check this?", channel_type: "im" });
    await ib.flush();
    expect(chatGetPermalink).toHaveBeenCalledTimes(1);
    expect(body?.source_url).toBe(permalink);
    expect(body?.from_name).toBe("slack-U1-D1");
  });

  it("a chat_getPermalink failure does not drop the message (source_url just stays unset)", async () => {
    const chatGetPermalink = vi.fn(async () => {
      throw new Error("Slack is unavailable");
    });
    const client = fakeClient({ chatGetPermalink });
    const posted: unknown[] = [];
    const post = vi.fn(async (_url: string, b: unknown) => {
      posted.push(b);
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent({ type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello", channel_type: "im" });
    await ib.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty("source_url");
  });

  it("a reaction delivery skips the chat_getPermalink lookup entirely", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent());
    await ib.flush();
    expect(client.chatGetPermalink).not.toHaveBeenCalled();
  });
});

// -- reactions (1c: e5a2f7c, f0de3e8, ed0b700, f163f93, cb974c2) -------------

function reactionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: "U_NICK",
    reaction: "thumbsup",
    item_user: "UBOT",
    item: { type: "message", channel: "C_CHAN", ts: "111.222" },
    event_ts: "999.000",
    ...overrides,
  };
}

describe("slack inbound: reactionText (1c: f0de3e8)", () => {
  it("same item is just the bare emoji", () => {
    expect(reactionText("thumbsup", "111.222", "111.222")).toBe(":thumbsup:");
    expect(reactionText("+1", "111.222", null)).toBe(":+1:");
  });

  it("a nested item keeps the line", () => {
    expect(reactionText("thumbsup", "111.333", "111.222")).toBe(":thumbsup: (on 111.333)");
  });
});

describe("slack inbound: reaction_added routing gate (1c: e5a2f7c, ed0b700)", () => {
  it("a channel reaction on our own message is delivered anchored at the item ts", async () => {
    const client = fakeClient();
    let body: { from_name: string; content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent());
    await ib.flush();
    expect(body?.from_name).toBe("slack-U_NICK-C_CHAN-111.222");
    expect(body?.content).toContain(":thumbsup:");
  });

  it("a channel reaction on someone else's message is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ item_user: "U_OTHER" }));
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("a DM reaction on anyone is delivered top-level", async () => {
    const client = fakeClient();
    let body: { from_name: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ item: { type: "message", channel: "D_DM", ts: "111.222" }, item_user: "U_OTHER" }));
    await ib.flush();
    expect(body?.from_name).toBe("slack-U_NICK-D_DM");
  });

  it("the bot reacting to itself is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ user: "UBOT" }));
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("a reaction on a non-message item is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ item: { type: "file", channel: "C_CHAN", ts: "111.222" } }));
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("an event with no reaction name is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    const event = reactionEvent();
    delete event.reaction;
    ib.onEvent(event);
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("a bot_id-carrying reaction event is dropped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ bot_id: "B123" }));
    await ib.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("a +1 reaction name is preserved", async () => {
    const client = fakeClient();
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ reaction: "+1" }));
    await ib.flush();
    expect(body?.content).toContain(":+1:");
  });

  it("a duplicate reaction envelope (redelivery) is deduped", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    const event = reactionEvent();
    ib.onEvent(event);
    ib.onEvent(event);
    await ib.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(client.reactionsGet).toHaveBeenCalledTimes(1);
  });

  it("does not touch/resurrect an active thread for a reaction", async () => {
    const client = fakeClient();
    const post = vi.fn(async () => {});
    const threads = fakeThreads();
    const ib = new Inbound(makeCfg(), client as never, "UBOT", threads, { post, log: () => {} });
    ib.onEvent(reactionEvent());
    await ib.flush();
    expect(threads.touch).not.toHaveBeenCalled();
  });
});

describe("slack inbound: reaction parent-thread lookup (1c: ed0b700, f163f93, cb974c2)", () => {
  it("a reaction on a threaded reply rewrites from_name and keeps the line", async () => {
    const client = fakeClient({
      reactionsGet: vi.fn(async () => ({ message: { ts: "111.333", thread_ts: "111.222", text: "hi" } })),
    });
    let body: { from_name: string; content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ item: { type: "message", channel: "C_CHAN", ts: "111.333" } }));
    await ib.flush();
    expect(client.reactionsGet).toHaveBeenCalledWith("C_CHAN", "111.333");
    expect(body?.from_name).toBe("slack-U_NICK-C_CHAN-111.222");
    expect(body?.content).toContain(":thumbsup: (on 111.333)");
  });

  it("an empty reactions.get lookup falls back to the item ts", async () => {
    const client = fakeClient({ reactionsGet: vi.fn(async () => ({ message: {} })) });
    let body: { from_name: string; content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent());
    await ib.flush();
    expect(body?.from_name).toBe("slack-U_NICK-C_CHAN-111.222");
    expect(body?.content).toContain(":thumbsup:");
    expect(body?.content).not.toContain("(on ");
  });

  it("a raising reactions.get falls back without throwing", async () => {
    const client = fakeClient({
      reactionsGet: vi.fn(async () => {
        throw new Error("lookup failed");
      }),
    });
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent());
    await ib.flush();
    expect(body?.content).toContain(":thumbsup:");
  });

  it("a DM reaction skips the reactions.get lookup entirely", async () => {
    const client = fakeClient();
    let body: { from_name: string; content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), { post, log: () => {} });
    ib.onEvent(reactionEvent({ item: { type: "message", channel: "D_DM", ts: "111.222" }, item_user: "U_OTHER" }));
    await ib.flush();
    expect(client.reactionsGet).not.toHaveBeenCalled();
    expect(body?.from_name).toBe("slack-U_NICK-D_DM");
    expect(body?.content).not.toContain("(on ");
  });

  it("timed-out lookups share one worker: a burst of reactions makes only one Slack call", async () => {
    // PORT-NOTE (1c: f163f93, cb974c2): Python monkeypatches the module
    // constant ITEM_LOOKUP_TIMEOUT down to 50ms; this port exposes the
    // same bound as an injectable option (see InboundOptions) since a TS
    // module const cannot be monkeypatched. The fake lookup here takes
    // longer than the timeout, so later reactions in the burst must skip
    // the lookup (busy) rather than each waiting out their own timeout.
    let calls = 0;
    let resolveLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((r) => {
      resolveLookup = r;
    });
    const client = fakeClient({
      reactionsGet: vi.fn(async () => {
        calls += 1;
        await lookupGate;
        return { message: {} };
      }),
    });
    const posted: string[] = [];
    const post = vi.fn(async (_url: string, b: unknown) => {
      posted.push((b as { content: string }).content);
    });
    const ib = new Inbound(makeCfg(), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
      itemLookupTimeoutMs: 20,
    });
    for (let i = 0; i < 8; i++) {
      ib.onEvent(reactionEvent({ event_ts: `999.${String(i).padStart(3, "0")}` }));
    }
    ib.onEvent({ type: "message", user: "U_NICK", channel: "D_DM", ts: "200.000", text: "hello after burst", channel_type: "im" });
    await ib.flush();
    expect(posted).toHaveLength(9);
    expect(posted.at(-1)).toContain("hello after burst");
    expect(calls).toBe(1);
    expect(client.reactionsGet).toHaveBeenCalledTimes(1);
    resolveLookup?.();
  });
});

// -- first-@mention thread-join backfill (1c: 48a706c, d5cc776) -------------

function mentionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "app_mention",
    user: "U_NICK",
    text: "<@UBOT> what do you think?",
    channel: "C_CHAN",
    ts: "111.500",
    thread_ts: "111.222",
    ...overrides,
  };
}

function repliesClient(messages: Array<Record<string, unknown>>) {
  return fakeClient({
    usersInfo: vi.fn(async () => ({ real_name: "Nick Jalbert", profile: {} })),
    conversationsReplies: vi.fn(async () => ({ messages })),
  });
}

describe("slack inbound: first-@mention thread-join backfill (1c: 48a706c, d5cc776)", () => {
  it("prepends capped prior lines closest to the mention", async () => {
    const client = repliesClient([
      { ts: "111.222", user: "U_NICK", text: "context one" },
      { ts: "111.300", user: "U_NICK", text: "context two" },
      { ts: "111.400", user: "U_NICK", text: "context three" },
      { ts: "111.500", user: "U_NICK", text: "<@UBOT> what do you think?" },
    ]);
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 2 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent());
    await ib.flush();
    expect(body?.content).toContain("thread before this mention — 2 earlier messages");
    expect(body?.content).not.toContain("context one");
    expect(body?.content).toContain("Nick Jalbert: context two");
    expect(body?.content).toContain("Nick Jalbert: context three");
    expect(body?.content).toContain("what do you think?");
    expect(client.conversationsReplies).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "111.222", latest: "111.500", inclusive: false }),
    );
  });

  it("walks pages to keep the closest lines on a long thread, not the oldest page", async () => {
    const client = repliesClient([
      { ts: "111.222", user: "U_NICK", text: "parent" },
      { ts: "111.301", user: "U_NICK", text: "early one" },
      { ts: "111.302", user: "U_NICK", text: "early two" },
      { ts: "111.303", user: "U_NICK", text: "late one" },
      { ts: "111.304", user: "U_NICK", text: "late two" },
      { ts: "111.500", user: "U_NICK", text: "<@UBOT> catch up?" },
    ]);
    // The fake's default conversationsReplies ignores limit/cursor and
    // returns everything in one page — swap in one that honors them like
    // upstream's _FakeClient does, so the cap really is the closest lines.
    const all = [
      { ts: "111.222", user: "U_NICK", text: "parent" },
      { ts: "111.301", user: "U_NICK", text: "early one" },
      { ts: "111.302", user: "U_NICK", text: "early two" },
      { ts: "111.303", user: "U_NICK", text: "late one" },
      { ts: "111.304", user: "U_NICK", text: "late two" },
    ];
    const calls: Array<{ limit: number | undefined; cursor: string | undefined }> = [];
    client.conversationsReplies = vi.fn(
      async (params: { channel: string; ts: string; latest?: string; limit?: number; cursor?: string }) => {
        calls.push({ limit: params.limit, cursor: params.cursor });
        const start = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? all.length;
        const page = all.slice(start, start + limit);
        const nextStart = start + limit;
        const out: Record<string, unknown> = { messages: page };
        if (nextStart < all.length) out.response_metadata = { next_cursor: String(nextStart) };
        return out;
      },
    );
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 2 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent({ text: "<@UBOT> catch up?", ts: "111.500" }));
    await ib.flush();
    expect(body?.content).toContain("thread before this mention — 2 earlier messages");
    expect(body?.content).not.toContain("early one");
    expect(body?.content).not.toContain("early two");
    expect(body?.content).toContain("Nick Jalbert: late one");
    expect(body?.content).toContain("Nick Jalbert: late two");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.cursor).toBeFalsy();
    expect(calls[0]?.limit).toBe(3);
    expect(calls[1]?.cursor).toBeTruthy();
  });

  it("an already-active thread does not backfill", async () => {
    const client = repliesClient([{ ts: "111.222", user: "U_NICK", text: "old context" }]);
    const threads = fakeThreads();
    threads.touch("C_CHAN", "111.222");
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 20 }), client as never, "UBOT", threads, {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent({ text: "<@UBOT> ping" }));
    await ib.flush();
    expect(body?.content).not.toContain("thread before this mention");
    expect(client.conversationsReplies).not.toHaveBeenCalled();
  });

  it("a top-level mention (no thread_ts) does not backfill", async () => {
    const client = repliesClient([]);
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 20 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent({ thread_ts: undefined }));
    await ib.flush();
    expect(body?.content).not.toContain("thread before this mention");
    expect(client.conversationsReplies).not.toHaveBeenCalled();
  });

  it("conversations.replies failure still delivers the mention", async () => {
    const client = repliesClient([]);
    client.conversationsReplies = vi.fn(async () => {
      throw new Error("replies failed");
    });
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 20 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent({ text: "<@UBOT> still there?" }));
    await ib.flush();
    expect(body?.content).toContain("still there?");
    expect(body?.content).not.toContain("thread before this mention");
  });

  it("threadJoinBackfill: 0 skips the lookup entirely", async () => {
    const client = repliesClient([{ ts: "111.222", user: "U_NICK", text: "old" }]);
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 0 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent(mentionEvent({ text: "<@UBOT> hi" }));
    await ib.flush();
    expect(client.conversationsReplies).not.toHaveBeenCalled();
    expect(body?.content).not.toContain("thread before this mention");
  });

  it("a DM never backfills", async () => {
    const client = repliesClient([]);
    let body: { content: string } | undefined;
    const post = vi.fn(async (_url: string, b: unknown) => {
      body = b as typeof body;
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 20 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
    });
    ib.onEvent({ type: "message", user: "U_NICK", text: "hello", channel: "D_DM", ts: "111.500", channel_type: "im" });
    await ib.flush();
    expect(client.conversationsReplies).not.toHaveBeenCalled();
  });

  it("timed-out backfill lookups share one worker with a burst of first mentions", async () => {
    // PORT-NOTE (1c: d5cc776, f6a821a): Python's regression test counts
    // ThreadPoolExecutor.submit calls (not just started replies_calls) so
    // a queued-but-unstarted lookup still fails it; this port's tryLookup
    // has no separate "queued" state at all — a lookup either starts
    // immediately or is skipped synchronously (lookupBusy) — so counting
    // actual reactionsGet/conversationsReplies invocations is equivalent
    // and does not need the same submit-vs-started distinction.
    let calls = 0;
    let resolveLookup: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveLookup = r;
    });
    const client = repliesClient([]);
    client.conversationsReplies = vi.fn(async () => {
      calls += 1;
      await gate;
      return { messages: [{ ts: "300.000", user: "U_NICK", text: "stale context" }] };
    });
    const posted: string[] = [];
    const post = vi.fn(async (_url: string, b: unknown) => {
      posted.push((b as { content: string }).content);
    });
    const ib = new Inbound(makeCfg({ threadJoinBackfill: 2 }), client as never, "UBOT", fakeThreads(), {
      post,
      log: () => {},
      joinBackfillTimeoutMs: 20,
    });
    for (let i = 0; i < 5; i++) {
      ib.onEvent(
        mentionEvent({ text: `<@UBOT> ping ${i}`, ts: `301.${String(i).padStart(3, "0")}`, thread_ts: `300.${String(i).padStart(3, "0")}` }),
      );
    }
    ib.onEvent({ type: "message", user: "U_NICK", text: "hello after burst", channel: "D_DM", ts: "400.000", channel_type: "im" });
    await ib.flush();
    expect(posted).toHaveLength(6);
    expect(posted.at(-1)).toContain("hello after burst");
    for (const body of posted.slice(0, -1)) {
      expect(body).toContain("ping");
      expect(body).not.toContain("thread before this mention");
      expect(body).not.toContain("stale context");
    }
    expect(calls).toBe(1);
    resolveLookup?.();
  });
});
