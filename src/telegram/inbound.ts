// inbound.ts — Telegram updates -> mind log.
// Faithful port of headlong_telegram.inbound (Python).
//
// A single long-poll loop over getUpdates. Every update passes through the
// same gate, in order: DM-only (anything else is dropped and group chats are
// left), then admin commands, then the allowlist. Only text from approved
// senders is POSTed to the local headlong web API, which appends it to the
// identity's trajectory.
//
// The getUpdates offset is persisted after each batch, so delivery is
// at-least-once across restarts; the bridge deduplicates by message_id, so
// client retries and replays do not double-post.

import * as path from "node:path";
import * as naming from "./naming.ts";
import * as tgfmt from "./tgfmt.ts";
import { Allowlist } from "./allowlist.ts";
import { ApiError, HttpError } from "./api.ts";
import { identityApiId, type Config } from "./config.ts";
import { Offset } from "./state.ts";

export const DELIVERY_ATTEMPTS = 3;
export const DELIVERY_ERROR_TEXT =
  "(bridge error: I couldn't reach my mind just now — please try again in a bit)";

export const ADMIN_HELP =
  "headlong telegram bridge admin commands:\n" +
  "/approve <id> — let this user talk to the identity\n" +
  "/deny <id> — silence a pending request for good\n" +
  "/revoke <id> — remove an approved user\n" +
  "/list — show approved + pending users\n" +
  "Anything else you type here goes to the identity as a normal message.";

const ADMIN_COMMANDS = new Set(["/approve", "/deny", "/revoke", "/list", "/help", "/start"]);

/** The slice of `Bot` this module needs — a real Bot or a test fake, both
 *  structurally satisfy this. */
export interface BotLike {
  sendMessage(chatId: number, text: string, html?: boolean): Promise<void>;
  leaveChat(chatId: number): Promise<void>;
  getUpdates(offset: number): Promise<Array<Record<string, unknown>>>;
}

/** POSTs the chat body to the web API; must throw on any failure (network or
 *  non-2xx status) — the TS analogue of `response.raise_for_status()`. */
export type PostFn = (url: string, body: unknown) => Promise<void>;

/** A non-2xx answer from the web API — the analogue of httpx.HTTPStatusError,
 *  carrying status and body so a 409 refusal can be told from an outage.
 *  PORT-NOTE (2e39a3f). */
export class HttpStatusError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

async function defaultPost(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new HttpStatusError(res.status, await res.text().catch(() => ""));
}

export interface InboundOptions {
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  post?: PostFn;
  /** Monotonic-ish clock (ms) for the message_id dedup window; defaults to Date.now(). */
  now?: () => number;
}

export class Inbound {
  readonly cfg: Config;
  readonly bot: BotLike;
  readonly allowlist: Allowlist;
  readonly offset: Offset;
  private readonly chatUrl: string;
  // Dedup: Telegram delivers at-least-once; a client retry can produce two
  // updates (different update_ids) for the same message. Drop duplicates by
  // (user, message_id) — message_id alone is only unique within one chat, so
  // two users may share the same id. Keyed as "user:messageId".
  private readonly seenMsgIds = new Map<string, number>();
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly post: PostFn;
  private readonly now: () => number;

  constructor(cfg: Config, bot: BotLike, allowlist: Allowlist, opts: InboundOptions = {}) {
    this.cfg = cfg;
    this.bot = bot;
    this.allowlist = allowlist;
    this.offset = new Offset(path.join(cfg.stateDir, "update_offset"));
    this.chatUrl = `${cfg.webUrl}/api/identities/${identityApiId(cfg)}/chat`;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.post = opts.post ?? defaultPost;
    this.now = opts.now ?? (() => Date.now());
  }

  // -- poll loop -----------------------------------------------------------

  async run(shouldStop: () => boolean = () => false): Promise<void> {
    while (!shouldStop()) {
      let updates: Array<Record<string, unknown>>;
      try {
        updates = await this.bot.getUpdates(this.offset.value);
      } catch (err) {
        // Includes 409: another poller holds this token. Keep retrying (and
        // complaining) — the conflict is worth noticing in logs.
        if (err instanceof ApiError || err instanceof HttpError) {
          this.log(`getUpdates failed; retrying in 5s: ${describeError(err)}`);
          await this.sleep(5000);
          continue;
        }
        throw err;
      }
      for (const update of updates) {
        try {
          await this.handle(update);
        } catch (err) {
          this.log(`failed handling update ${update.update_id}: ${describeError(err)}`);
        }
        this.offset.advance((update.update_id as number) + 1);
      }
    }
  }

  // -- the gate --------------------------------------------------------------

  async handle(update: Record<string, unknown>): Promise<void> {
    const message = update.message as Record<string, unknown> | undefined;
    if (!message) return;
    const chat = (message.chat ?? {}) as Record<string, unknown>;
    const sender = (message.from ?? {}) as Record<string, unknown>;
    const userId = sender.id as number | undefined;

    if (chat.type !== "private") {
      // DM-only pilot: never sit in a group, where the allowlist can't gate
      // who is in the room.
      const chatId = chat.id as number | undefined;
      this.log(`dropping non-DM message in chat ${chatId}; leaving`);
      if (chatId !== undefined && chatId !== null) {
        try {
          await this.bot.leaveChat(chatId);
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
        }
      }
      return;
    }
    if (!userId || sender.is_bot) return;
    const text = (message.text as string | undefined) || "";
    if (!text) return; // text-only pilot: media, stickers, etc. are dropped

    // Dedup: drop if we have already seen this (user, message_id). Telegram
    // retries can produce two updates with different update_ids for the same
    // message.
    const now = this.now();
    const msgId = message.message_id;
    if (msgId !== undefined && msgId !== null) {
      const dedupKey = `${userId}:${msgId}`;
      if (this.seenMsgIds.has(dedupKey)) {
        this.log(`dropping duplicate message_id ${msgId} from user ${userId}`);
        return;
      }
      this.seenMsgIds.set(dedupKey, now);
      const cutoff = now - 300_000;
      for (const [k, v] of this.seenMsgIds) {
        if (v <= cutoff) this.seenMsgIds.delete(k);
      }
    }

    if (userId === this.cfg.adminId && (await this.adminCommand(text))) return;
    if (!this.allowlist.isApproved(userId)) {
      await this.pending(userId, sender);
      return;
    }
    if (text.trim() === "/start") {
      await this.bot.sendMessage(chat.id as number, "Connected — just type.");
      return;
    }
    await this.deliver(userId, chat.id as number, sender, text);
  }

  // -- admin commands (intercepted; never reach the mind log) --------------

  private async adminCommand(text: string): Promise<boolean> {
    const parts = text.trim().split(/\s+/).filter((p) => p.length > 0);
    const command = parts.length > 0 ? parts[0]!.toLowerCase() : "";
    if (!ADMIN_COMMANDS.has(command)) return false;
    let reply = ADMIN_HELP;
    if (command === "/approve" || command === "/deny" || command === "/revoke") {
      if (parts.length !== 2 || !/^[0-9]+$/.test(parts[1]!)) {
        reply = `usage: ${command} <numeric user id>`;
      } else {
        const target = Number(parts[1]);
        if (command === "/approve") {
          this.allowlist.approve(target);
          reply = `approved ${target}`;
          try {
            // DM chat id == user id; fails harmlessly until the user has
            // started the bot.
            await this.bot.sendMessage(target, "You're approved — say hi and I'll pass it on.");
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
          }
        } else if (command === "/deny") {
          this.allowlist.deny(target);
          reply = `denied ${target} (silenced for good)`;
        } else {
          reply = this.allowlist.revoke(target) ? `revoked ${target}` : `${target} wasn't approved`;
        }
      }
    } else if (command === "/list") {
      reply = this.allowlist.summary();
    }
    await this.bot.sendMessage(this.cfg.adminId, reply);
    return true;
  }

  // -- unknown senders -------------------------------------------------------

  private async pending(userId: number, sender: Record<string, unknown>): Promise<void> {
    // Silent to the sender: replying would confirm a live bot to whoever is
    // probing it. The admin gets one prompt per sender per day.
    const label = tgfmt.senderLabel(sender);
    if (this.allowlist.notePending(userId, label)) {
      await this.bot.sendMessage(
        this.cfg.adminId,
        `${label} (id ${userId}) wants to talk — /approve ${userId} or /deny ${userId}`,
      );
    }
  }

  // -- delivery ----------------------------------------------------------------

  private async deliver(
    userId: number,
    chatId: number,
    sender: Record<string, unknown>,
    text: string,
  ): Promise<void> {
    const content = tgfmt.cleanInbound(text);
    if (!content) return;
    const fromName = naming.encode(userId, chatId);
    // The reply-to name is spelled out because agent-typed replies (the
    // agentic path, unlike the mechanical fast-reply) must use the full
    // routing key, not the human display name.
    const header = `(Telegram: ${tgfmt.senderLabel(sender)} — reply with: chat reply ${fromName})`;
    const body = { content: `${header} ${content}`, from_name: fromName };
    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
      try {
        await this.post(this.chatUrl, body);
        return;
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 409) {
          // The mind's tool refused the message on purpose (a duplicate or a
          // bad target); it will refuse it again, and "couldn't reach my
          // mind" would be untrue.
          this.log(`chat POST refused for ${fromName}: ${err.bodyText.slice(0, 200)}`);
          return;
        }
        this.log(
          `chat POST failed (attempt ${attempt}/${DELIVERY_ATTEMPTS}): ${describeError(err)}`,
        );
        if (attempt < DELIVERY_ATTEMPTS) await this.sleep(2000 * attempt);
      }
    }
    try {
      await this.bot.sendMessage(chatId, DELIVERY_ERROR_TEXT);
    } catch (err) {
      this.log(`failed posting delivery error to telegram: ${describeError(err)}`);
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
