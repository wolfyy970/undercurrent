// telegram-outbound.test.ts — port of headlong/telegram/tests/test_outbound.py.

import { describe, it, expect } from "vitest";
import {
  RecentPosts,
  run,
  type MindlogLike,
  type OutboundBotLike,
  type AllowlistLike,
} from "../src/telegram/outbound.ts";
import { ApiError, HttpError } from "../src/telegram/api.ts";
import * as outboundNs from "../src/telegram/outbound.ts";
import type { Config } from "../src/telegram/config.ts";

function cfgFor(): Config {
  return {
    serveRoot: "/tmp",
    identity: "audel",
    identityDir: "/tmp",
    botToken: "x",
    adminId: 1,
    webUrl: "http://x",
    stateDir: "/tmp",
  };
}

function mindlogOf(steps: Array<Record<string, unknown>>): MindlogLike {
  return {
    findTrajectory: () => "/nonexistent/t.jsonl",
    follow: async function* () {
      for (const s of steps) yield s;
    },
  };
}

const approveAll: AllowlistLike = { isApproved: () => true };

describe("telegram outbound", () => {
  it("RecentPosts dedupe window", () => {
    const recent = new RecentPosts(300);
    expect(recent.isDuplicate("telegram-1-1", "hi", 0)).toBe(false);
    expect(recent.isDuplicate("telegram-1-1", "hi", 100)).toBe(true);
    expect(recent.isDuplicate("telegram-1-1", "hi", 500)).toBe(false);
    expect(recent.isDuplicate("telegram-2-2", "hi", 100)).toBe(false);
  });

  it("run delivers only chat-sourced messages", async () => {
    // Only `chat` speaks for the identity: message steps without
    // source:"chat" (a thinker appending raw message steps to the
    // trajectory) must not reach Telegram.
    const steps: Array<Record<string, unknown>> = [
      // legit reply, stamped by chat
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        source: "chat",
        content: "real reply",
        step_id: "aaa",
      },
      // forged: thinker-appended, wrong source
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        source: "responder",
        content: "forged reply",
        step_id: "bbb",
      },
      // forged: no source at all
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        content: "unstamped reply",
        step_id: "ccc",
      },
    ];

    const mindlogImpl: MindlogLike = {
      findTrajectory: () => "/nonexistent/t.jsonl",
      follow: async function* () {
        for (const s of steps) yield s;
      },
    };
    const sent: string[] = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      },
    };
    const allowlist: AllowlistLike = { isApproved: () => true };
    const cfg: Config = {
      serveRoot: "/tmp",
      identity: "audel",
      identityDir: "/tmp",
      botToken: "x",
      adminId: 1,
      webUrl: "http://x",
      stateDir: "/tmp",
    };

    await run(cfg, bot, allowlist, { mindlogImpl, log: () => {}, appendStep: () => {} });

    expect(sent).toEqual(["real reply"]);
  });

  // -- 06f1588, a2cf670, ab13bab, 2827421, f68ae29, c647609, 21c62ba -------

  it("forged source is not posted (06f1588 test_outbound.py addition)", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", content: "real reply", step_id: "aaa" },
      { type: "message", from: "audel", to: "telegram-1-1", source: "responder", content: "forged reply", step_id: "bbb" },
      { type: "message", from: "audel", to: "telegram-1-1", content: "unstamped reply", step_id: "ccc" },
    ];
    const sent: string[] = [];
    const bot: OutboundBotLike = { sendMessage: async (_c, t) => void sent.push(t) };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["real reply"]);
  });

  it("file step uses send_document, not sendMessage", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "note.txt", content: "hi", step_id: "ddd" },
    ];
    const sent: string[] = [];
    const docs: Array<[string, unknown, string | null | undefined]> = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendDocument: async (_c, content, filename, caption) => void docs.push([filename, content, caption]),
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(docs).toEqual([["note.txt", "hi", null]]);
    expect(sent).toEqual([]);
  });

  it("PNG uses send_photo", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
    const steps: Array<Record<string, unknown>> = [
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "fig.png", content_b64: png.toString("base64"), step_id: "fff",
      },
    ];
    const sent: string[] = [];
    const photos: Array<[string, unknown, unknown]> = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendPhoto: async (_c, content, filename, caption) => void photos.push([filename, content, caption]),
      sendDocument: async () => {
        throw new Error("png should use send_photo");
      },
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(photos).toEqual([["fig.png", png, null]]);
    expect(sent).toEqual([]);
  });

  it("send_photo failure retries as send_document", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
    const steps: Array<Record<string, unknown>> = [
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "fig.png", content_b64: png.toString("base64"), step_id: "ggg",
      },
    ];
    const photos: string[] = [];
    const docs: Array<[string, unknown, unknown]> = [];
    const bot: OutboundBotLike = {
      sendMessage: async () => {
        throw new Error("should not send_message");
      },
      sendPhoto: async (_c, _content, filename) => {
        photos.push(filename);
        throw new ApiError("PHOTO_INVALID");
      },
      sendDocument: async (_c, content, filename, caption) => void docs.push([filename, content, caption]),
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(photos).toEqual(["fig.png"]);
    expect(docs).toEqual([["fig.png", png, null]]);
  });

  it("group chat is dropped", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-99", source: "chat", content: "group hi", step_id: "hhh" },
    ];
    const sent: string[] = [];
    const bot: OutboundBotLike = { sendMessage: async (_c, t) => void sent.push(t) };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual([]);
  });

  it("JPEG uses send_photo", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("rest")]);
    const steps: Array<Record<string, unknown>> = [
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "shot.jpg", content_b64: jpeg.toString("base64"), step_id: "jpg1",
      },
    ];
    const sent: string[] = [];
    const photos: Array<[string, unknown, unknown]> = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendPhoto: async (_c, content, filename, caption) => void photos.push([filename, content, caption]),
      sendDocument: async () => {
        throw new Error("jpeg should use send_photo");
      },
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(photos).toEqual([["shot.jpg", jpeg, null]]);
    expect(sent).toEqual([]);
  });

  it("file send failure falls back to a notice", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "note.txt", content: "hi", step_id: "fail1" },
    ];
    const sent: string[] = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendDocument: async () => {
        throw new ApiError("upload rejected");
      },
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });

  it("undecodable file falls back to a notice", async () => {
    const steps: Array<Record<string, unknown>> = [
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content: "[file: note.txt]", content_b64: "@@@bad@@@", step_id: "badb64",
      },
    ];
    const sent: string[] = [];
    const docs: string[] = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendDocument: async (_c, _content, filename) => void docs.push(filename),
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(docs).toEqual([]);
    expect(sent).toEqual(["(failed to deliver file note.txt)"]);
  });

  it("identical file steps are suppressed (dedupe by filename+content hash)", async () => {
    const body = Buffer.from("same-bytes");
    const other = Buffer.from("different-bytes");
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "note.txt", content_b64: body.toString("base64"), step_id: "f1" },
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "note.txt", content_b64: body.toString("base64"), step_id: "f2" },
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "note.txt", content_b64: other.toString("base64"), step_id: "f3" },
    ];
    const sent: string[] = [];
    const docs: Array<[string, unknown, unknown]> = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendDocument: async (_c, content, filename, caption) => void docs.push([filename, content, caption]),
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(docs).toEqual([
      ["note.txt", body, null],
      ["note.txt", other, null],
    ]);
    expect(sent).toEqual([]);
  });

  it("invalid file content does not stop later replies", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", filename: "bad.bin", content: { x: "y" }, step_id: "badobj" },
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", content: "later reply", step_id: "okmsg" },
    ];
    const sent: string[] = [];
    const docs: string[] = [];
    const bot: OutboundBotLike = {
      sendMessage: async (_c, t) => void sent.push(t),
      sendDocument: async (_c, _content, filename) => void docs.push(filename),
    };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(docs).toEqual([]);
    expect(sent).toEqual(["(failed to deliver file bad.bin)", "later reply"]);
  });

  it("a Slack-only reaction step is not posted to Telegram", async () => {
    const steps: Array<Record<string, unknown>> = [
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", reaction: "thumbsup", content: ":thumbsup:", step_id: "r1" },
      { type: "message", from: "audel", to: "telegram-1-1", source: "chat", content: "later reply", step_id: "t1" },
    ];
    const sent: string[] = [];
    const bot: OutboundBotLike = { sendMessage: async (_c, t) => void sent.push(t) };
    await run(cfgFor(), bot, approveAll, { mindlogImpl: mindlogOf(steps), log: () => {}, appendStep: () => {} });
    expect(sent).toEqual(["later reply"]);
  });
});

// ---- 2e39a3f: delivery notices (design/outbound_delivery.md, part 7) and a
// follow loop that survives an unreadable trajectory.
type Notice = Record<string, unknown>;

async function drive(
  steps: Array<Record<string, unknown>>,
  bot: unknown,
  opts: { approve?: boolean; extra?: Partial<outboundNs.RunOptions> } = {},
): Promise<{ notices: Notice[]; logs: string[] }> {
  const notices: Notice[] = [];
  const logs: string[] = [];
  const allow: AllowlistLike = { isApproved: () => opts.approve ?? true };
  await run(cfgFor(), bot as OutboundBotLike, allow, {
    mindlogImpl: mindlogOf(steps),
    log: (l) => logs.push(l),
    appendStep: (_r, _t, step) => {
      notices.push(step);
    },
    ...(opts.extra ?? {}),
  });
  return { notices, logs };
}

function msg(stepId: string, to: string, content = "hello"): Record<string, unknown> {
  return { type: "message", from: "audel", to, source: "chat", content, step_id: stepId };
}

class SendBot {
  sent: string[] = [];
  fail: boolean;
  constructor(fail = false) {
    this.fail = fail;
  }
  async sendMessage(_chat: number, text: string): Promise<void> {
    if (this.fail) throw new ApiError("chat not found");
    this.sent.push(text);
  }
}

describe("telegram outbound: delivery notices (2e39a3f)", () => {
  it("a delivered notice names the message step", async () => {
    const bot = new SendBot();
    const { notices } = await drive([msg("m1", "telegram-1-1", "hi")], bot);
    expect(bot.sent).toEqual(["hi"]);
    const n = notices[0]!;
    expect([n.type, n.source, n.transport, n.status, n.trigger_step, n.chat]).toEqual([
      "delivery", "telegram-bridge", "telegram", "delivered", "m1", "1",
    ]);
    expect(n.content).toBe("delivered to telegram-1-1");
  });

  it("a send failure is a failed notice", async () => {
    const { notices } = await drive([msg("m1", "telegram-1-1")], new SendBot(true));
    expect(notices[0]!.status).toBe("failed");
    expect(String(notices[0]!.reason)).toContain("chat not found");
  });

  it("a network failure (HttpError) is a failed notice, not a crash", async () => {
    const bot = {
      async sendMessage(): Promise<void> {
        throw new HttpError("connection refused");
      },
    };
    const { notices } = await drive([msg("m1", "telegram-1-1")], bot);
    expect(notices[0]!.status).toBe("failed");
    expect(String(notices[0]!.reason)).toContain("connection refused");
  });

  it("unapproved, group and malformed addresses are failed notices", async () => {
    const bot = new SendBot();
    const a = await drive([msg("m1", "telegram-1-1")], bot, { approve: false });
    const b = await drive([msg("m2", "telegram-1-2"), msg("m3", "telegram-bogus")], bot);
    expect(bot.sent).toEqual([]);
    const all = [...a.notices, ...b.notices];
    expect(all.map((n) => n.trigger_step)).toEqual(["m1", "m2", "m3"]);
    expect(String(all[0]!.reason)).toContain("allowlist");
    expect(String(all[1]!.reason)).toContain("group");
    expect(String(all[2]!.reason)).toContain("unknown telegram address form");
  });

  it("other transports get no notice", async () => {
    const bot = new SendBot();
    const { notices } = await drive([msg("m1", "slack-U1-C1"), msg("m2", "pwa-andy")], bot);
    expect(bot.sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("a duplicate is a skipped notice", async () => {
    const bot = new SendBot();
    const { notices } = await drive([msg("m1", "telegram-1-1", "x"), msg("m2", "telegram-1-1", "x")], bot);
    expect(bot.sent).toEqual(["x"]);
    expect(notices.map((n) => n.status)).toEqual(["delivered", "skipped"]);
  });

  it("a failed file send carries the filename and reason", async () => {
    const step = { ...msg("f1", "telegram-1-1", ""), filename: "a.txt", content_b64: Buffer.from("x").toString("base64") };
    const bot = Object.assign(new SendBot(), {
      sendDocument: async () => {
        throw new ApiError("file too big");
      },
    });
    const { notices } = await drive([step], bot);
    expect(notices[0]!.status).toBe("failed");
    expect(notices[0]!.filename).toBe("a.txt");
    expect(String(notices[0]!.reason)).toContain("file too big");
    expect(bot.sent).toEqual(["(failed to deliver file a.txt)"]);
  });

  it("an unwritable trajectory disables notices after one error", async () => {
    const calls: unknown[] = [];
    const bot = new SendBot();
    const { logs } = await drive([msg("m1", "telegram-1-1", "a"), msg("m2", "telegram-1-1", "b")], bot, {
      extra: {
        appendStep: (_r, _t, step) => {
          calls.push(step);
          const e = new Error("not writable");
          e.name = "PermissionError";
          throw e;
        },
      },
    });
    expect(bot.sent).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1);
    expect(logs.filter((l) => l.includes("delivery notices disabled")).length).toBe(1);
  });
});

describe("telegram outbound: a trajectory that cannot be read (2026-09-22)", () => {
  function eacces(): Error {
    return Object.assign(new Error("EACCES: permission denied, open 't.jsonl'"), { code: "EACCES" });
  }

  it("run survives an unreadable trajectory, retries from the cursor and delivers", async () => {
    const steps = [{ type: "message", from: "audel", to: "telegram-1-1", source: "chat", content: "late but delivered", step_id: "aaa" }];
    const calls = { find: 0, follow: 0 };
    const mindlogImpl: MindlogLike = {
      findTrajectory: () => {
        calls.find += 1;
        if (calls.find < 3) throw eacces();
        return "/nonexistent/t.jsonl";
      },
      follow: async function* () {
        calls.follow += 1;
        if (calls.follow === 1) throw eacces();
        for (const s of steps) yield s;
      },
    };
    const bot = new SendBot();
    const logs: string[] = [];
    await run(cfgFor(), bot as OutboundBotLike, approveAll, { mindlogImpl, log: (l) => logs.push(l), appendStep: () => {}, retryMs: 5, sleep: async () => {} });
    expect(bot.sent).toEqual(["late but delivered"]);
    expect(calls).toEqual({ find: 4, follow: 2 });
    // find fails twice (one log: same reason), recovers; follow fails (a
    // second log, the recovery reset the memo); recovers again.
    expect(logs.filter((l) => l.includes("cannot read the trajectory")).length).toBe(2);
    expect(logs.filter((l) => l.includes("readable again")).length).toBe(2);
  });

  it("the retry loop honours stop, so shutdown never hangs on an unreadable trajectory", async () => {
    let stop = false;
    const mindlogImpl: MindlogLike = {
      findTrajectory: () => {
        stop = true;
        throw eacces();
      },
      follow: async function* () {},
    };
    await run(cfgFor(), {} as OutboundBotLike, approveAll, { mindlogImpl, log: () => {}, shouldStop: () => stop, retryMs: 5 });
  });

  it("a non-OS error (no trajectory.jsonl under ...) still propagates", async () => {
    const mindlogImpl: MindlogLike = {
      findTrajectory: () => {
        throw new Error("headlong-telegram-bridge: no trajectory.jsonl under x");
      },
      follow: async function* () {},
    };
    await expect(run(cfgFor(), {} as OutboundBotLike, approveAll, { mindlogImpl, log: () => {} })).rejects.toThrow(/no trajectory/);
  });
});

describe("telegram outbound: notice writer (2e39a3f)", () => {
  it("appendStepViaTraj refuses an unwritable log, else appends a locked step", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-notice-"));
    const traj = path.join(dir, "trajectories", "455a2181-root", "trajectory.jsonl");
    expect(() => outboundNs.appendStepViaTraj(dir, traj, { type: "delivery" })).toThrow(/not writable/);
    fs.mkdirSync(path.dirname(traj), { recursive: true });
    fs.writeFileSync(traj, "");
    outboundNs.appendStepViaTraj(dir, traj, { type: "delivery", status: "delivered", chat: "1" });
    const row = JSON.parse(fs.readFileSync(traj, "utf8").trim());
    expect([row.type, row.status, row.chat]).toEqual(["delivery", "delivered", "1"]);
    expect(row.step_id).toBeTruthy();
  });
});
