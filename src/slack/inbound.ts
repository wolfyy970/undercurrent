// inbound.ts — Slack events -> mind log.
// Faithful port of headlong_slack.inbound (Python).
//
// Handlers return immediately (Socket Mode envelopes are acked by
// socketmode.ts as soon as the handler returns); an internal queue drains
// asynchronously and POSTs each message to the local headlong web API, which
// appends it to the identity's trajectory via `chat`.
//
// PORT-NOTE: Python drains its queue on a background `threading.Thread`; Node
// has no threads, so `enqueue()` below chains onto a promise tail instead —
// `onEvent()` still returns synchronously without awaiting delivery (the
// "handler must return fast" contract socketmode.ts's envelope-ack relies
// on), and delivery runs concurrently with whatever the caller does next.
// `flush()` is a test/driver-only seam (Python has no equivalent — it is
// this port's async-native way to await "the drain thread has caught up").

import * as naming from "./naming.ts";
import * as slackfmt from "./slackfmt.ts";
import { identityApiId, type Config } from "./config.ts";
import { Deduper, PeerGuard } from "./state.ts";

export const DELIVERY_ATTEMPTS = 3;
export const DELIVERY_ERROR_TEXT =
  "(bridge error: I couldn't reach my mind just now — please try again in a bit)";
// Bound reaction parent-lookups (reactions.get) and first-join backfill
// (conversations.replies) so a hung Slack call cannot stall the delivery
// worker. Fail open rather than wait. PORT-NOTE (1c: ed0b700, f163f93,
// cb974c2, 48a706c, d5cc776).
export const ITEM_LOOKUP_TIMEOUT_MS = 2000;
export const JOIN_BACKFILL_TIMEOUT_MS = 2000;
// Per-line cap so a single huge Slack message cannot dump the mind log.
export const JOIN_BACKFILL_LINE_CHARS = 200;
// Cursor-walk page cap for conversations.replies — the submit timeout is
// the real bound; this just stops a pathological loop.
const JOIN_BACKFILL_MAX_PAGES = 50;

/** Body for a reaction inbound.
 *
 * Routing uses the parent thread so a reply lands in the right Slack
 * thread. When the reacted-to message is a reply inside that thread, keep
 * `itemTs` in the body so the mind log still names the line.
 * PORT-NOTE (1c: f0de3e8). */
export function reactionText(reaction: string, itemTs: string, threadTs: string | null): string {
  let body = `:${reaction}:`;
  if (threadTs && itemTs !== threadTs) body = `${body} (on ${itemTs})`;
  return body;
}

interface ReactionEvent {
  user: string;
  channel: string;
  itemTs: string;
  reaction: string;
  /** true for channel reactions: resolve parent thread_ts; false for DMs. */
  wantThread: boolean;
}

/** Decide whether a reaction_added event should reach the mind log.
 *  PORT-NOTE (1c: e5a2f7c, ed0b700). */
function reactionToInbound(event: Record<string, unknown>, botUserId: string): ReactionEvent | null {
  if (event.bot_id) return null;
  const user = event.user as string | undefined;
  if (!user || user === botUserId) return null;
  const reaction = event.reaction as string | undefined;
  if (!reaction) return null;
  const item = (event.item ?? {}) as Record<string, unknown>;
  if (item.type !== "message") return null;
  const channel = item.channel as string | undefined;
  const itemTs = item.ts as string | undefined;
  if (!channel || !itemTs) return null;
  const isIm = channel.startsWith("D");
  const itemUser = event.item_user as string | undefined;
  // DMs: every reaction is for us. Channels: only reactions on our messages.
  if (!isIm && itemUser !== botUserId) return null;
  return { user, channel, itemTs, reaction, wantThread: !isIm };
}

export interface InboundMessage {
  fromName: string;
  user: string;
  channel: string;
  /** where an error notice would go; null = top level */
  threadTs: string | null;
  /** the ts of the reacted-to/mentioning event itself (backfill's before_ts) */
  messageTs: string;
  text: string;
  /** channel reactions: resolve parent thread_ts in the worker so the
   *  socket-mode handler never blocks on reactions.get. PORT-NOTE (1c: ed0b700). */
  resolveParent?: boolean;
  /** PORT-NOTE (1c: cb974c2, f68c1d8): reactions skip the chat_getPermalink
   *  lookup in `deliver()` — a reaction is not request intent, and the
   *  lookup is best-effort metadata a burst of reactions must not stall
   *  on. */
  isReaction?: boolean;
  /** first @mention in a thread: drain worker prepends capped prior lines.
   *  PORT-NOTE (1c: 48a706c). */
  backfill?: boolean;
  /** Posted by another Headlong persona's bot (config.peerBotUsers).
   *  PORT-NOTE (2e39a3f: peer hearing). */
  isPeer?: boolean;
}

/** The slice of WebClient this module needs — a real client or a test fake,
 *  both structurally satisfy this. */
export interface SlackClientLike {
  usersInfo(user: string): Promise<Record<string, unknown>>;
  conversationsInfo(channel: string): Promise<Record<string, unknown>>;
  chatPostMessage(
    channel: string,
    text: string,
    opts?: { threadTs?: string | null; unfurlLinks?: boolean },
  ): Promise<unknown>;
  reactionsGet(channel: string, timestamp: string): Promise<Record<string, unknown>>;
  conversationsReplies(params: {
    channel: string;
    ts: string;
    latest?: string;
    inclusive?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  chatGetPermalink(channel: string, messageTs: string): Promise<Record<string, unknown>>;
}

export interface ActiveThreadsLike {
  touch(channel: string, threadTs: string | null | undefined): void;
  isActive(channel: string, threadTs: string | null | undefined): boolean;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Races `p` against a timeout; `p` keeps running in the background on
 *  timeout (there is no way to cancel an in-flight `fetch`-based Slack
 *  call short of aborting it, which Python's `Future.result(timeout=...)`
 *  does not do either — it lets the worker thread keep going). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Cached display names for the '(Slack: Dana Kim in #eng)' header. */
export class SlackNames {
  private readonly client: SlackClientLike;
  private readonly log: (line: string) => void;
  private readonly users = new Map<string, string>();
  private readonly channels = new Map<string, string>();

  constructor(client: SlackClientLike, log: (line: string) => void = () => {}) {
    this.client = client;
    this.log = log;
  }

  async user(userId: string): Promise<string> {
    if (!this.users.has(userId)) {
      let name = userId;
      try {
        const profile = await this.client.usersInfo(userId);
        const inner = (profile.profile ?? {}) as Record<string, unknown>;
        name = (inner.display_name as string) || (profile.real_name as string) || userId;
      } catch (err) {
        this.log(`users_info failed for ${userId}: ${describeError(err)}`);
      }
      this.users.set(userId, name);
    }
    return this.users.get(userId)!;
  }

  async place(channelId: string): Promise<string> {
    if (channelId.startsWith("D")) return "DM";
    if (!this.channels.has(channelId)) {
      let name = channelId;
      try {
        const info = await this.client.conversationsInfo(channelId);
        name = "#" + ((info.name as string) || channelId);
      } catch (err) {
        this.log(`conversations_info failed for ${channelId}: ${describeError(err)}`);
      }
      this.channels.set(channelId, name);
    }
    return this.channels.get(channelId)!;
  }
}

/** POSTs the chat body to the web API; must throw on any failure (network or
 *  non-2xx status) — the TS analogue of `response.raise_for_status()`. */
export type PostFn = (url: string, body: unknown) => Promise<void>;

/** A non-2xx answer from the web API — the analogue of httpx.HTTPStatusError,
 *  carrying the status and body so a 409 refusal can be told from an outage.
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

/** Python `str()` of the JSON values `_refusal_reason` can meet. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  const repr = (x: unknown): string => {
    if (x === null || x === undefined) return "None";
    if (typeof x === "string") return `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    if (typeof x === "boolean") return x ? "True" : "False";
    if (typeof x === "number") return String(x);
    if (Array.isArray(x)) return `[${x.map(repr).join(", ")}]`;
    return `{${Object.entries(x as Record<string, unknown>)
      .map(([k, val]) => `${repr(k)}: ${repr(val)}`)
      .join(", ")}}`;
  };
  return repr(v);
}

/** The one-line reason behind a 409 from the web API, for the log
 *  (upstream `_refusal_reason`). */
export function refusalReason(bodyText: string): string {
  let detail: unknown;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no .get");
    detail = (parsed as Record<string, unknown>)["detail"];
  } catch {
    return bodyText.slice(0, 200);
  }
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    const msg = d["message"];
    const truthy = msg !== undefined && msg !== null && msg !== "" && msg !== 0 && msg !== false;
    return pyStr(truthy ? msg : detail).slice(0, 200);
  }
  return pyStr(detail).slice(0, 200);
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
  /** Test seam standing in for Python's `monkeypatch.setattr(inbound,
   *  "ITEM_LOOKUP_TIMEOUT", ...)` / `"JOIN_BACKFILL_TIMEOUT"` — TS module
   *  constants cannot be monkeypatched, so the bound is injectable here
   *  instead. Defaults match the exported constants (frozen behavior). */
  itemLookupTimeoutMs?: number;
  joinBackfillTimeoutMs?: number;
}

export class Inbound {
  readonly cfg: Config;
  readonly client: SlackClientLike;
  readonly botUserId: string;
  readonly botMention: string;
  readonly threads: ActiveThreadsLike;
  readonly names: SlackNames;
  readonly dedupe = new Deduper();
  readonly peers: PeerGuard;
  private readonly chatUrl: string;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly post: PostFn;
  private readonly itemLookupTimeoutMs: number;
  private readonly joinBackfillTimeoutMs: number;
  private queueTail: Promise<void> = Promise.resolve();
  // At most one Slack lookup (reactions.get / conversations.replies) in
  // flight. PORT-NOTE (1c: f163f93, d5cc776): Python bounds this with a
  // shared `max_workers=1` ThreadPoolExecutor; Node has no threads, so a
  // single busy flag gives the same "timed-out work is not queued behind
  // itself" guarantee (see tryLookup below).
  private lookupBusy = false;

  constructor(
    cfg: Config,
    client: SlackClientLike,
    botUserId: string,
    threads: ActiveThreadsLike,
    opts: InboundOptions = {},
  ) {
    this.cfg = cfg;
    this.client = client;
    this.botUserId = botUserId;
    this.botMention = `<@${botUserId}>`;
    this.threads = threads;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.names = new SlackNames(client, this.log);
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.post = opts.post ?? defaultPost;
    this.itemLookupTimeoutMs = opts.itemLookupTimeoutMs ?? ITEM_LOOKUP_TIMEOUT_MS;
    this.joinBackfillTimeoutMs = opts.joinBackfillTimeoutMs ?? JOIN_BACKFILL_TIMEOUT_MS;
    this.peers = new PeerGuard(cfg.peerMaxTurns, cfg.peerHourlyCap);
    this.chatUrl = `${cfg.webUrl}/api/identities/${identityApiId(cfg)}/chat`;
  }

  // -- event intake (must return fast) --------------------------------------

  onEvent(event: Record<string, unknown>): void {
    if (event.type === "reaction_added") {
      this.onReaction(event);
      return;
    }
    this.onMessageEvent(event);
  }

  private onMessageEvent(event: Record<string, unknown>): void {
    const user = event.user as string | undefined;
    // Bot posts are dropped, except from a listed peer persona. Peers then
    // pass the same mention / active-thread gate as people, plus the loop
    // guard below. Legacy bot_message posts carry no user id and never
    // qualify. PORT-NOTE (2e39a3f: peer hearing, design/peer_hearing.md).
    const isPeer = Boolean(event.bot_id) && Boolean(user) && this.cfg.peerBotUsers.has(user as string);
    if ((event.bot_id && !isPeer) || event.subtype) return;
    const text = (event.text as string | undefined) || "";
    if (!user || user === this.botUserId) return;
    const channel = event.channel as string | undefined;
    const ts = event.ts as string | undefined;
    if (!channel || !ts) return;
    if (!this.dedupe.add(`${channel}:${ts}`)) return;

    let fromName: string;
    let threadTs: string | null;
    let firstJoin = false;
    if (event.channel_type === "im") {
      // DMs: everything is for us; replies go top-level.
      fromName = naming.encode(user, channel);
      threadTs = null;
    } else {
      if (!isPeer) {
        // Any person speaking in a thread lets the peers take turns again,
        // whether or not this message is for us.
        this.peers.humanSpoke(channel, (event.thread_ts as string | undefined) || ts);
      }
      const mentioned = event.type === "app_mention" || text.includes(this.botMention);
      if (mentioned) {
        // Anchor the conversation at the existing thread, or start one at
        // the mention itself.
        threadTs = (event.thread_ts as string | undefined) || ts;
      } else if (this.cfg.threadFollowups && this.threads.isActive(channel, event.thread_ts as string | undefined)) {
        threadTs = event.thread_ts as string;
      } else {
        return;
      }
      if (isPeer) {
        const [ok, reason] = this.peers.allow(channel, threadTs);
        if (!ok) {
          if (reason) this.log(`peer ${user} in ${channel}/${threadTs} not forwarded: ${reason}`);
          return;
        }
      }
      fromName = naming.encode(user, channel, threadTs);
      // First @mention in an existing thread: fetch prior lines on the
      // drain worker. Already-active threads have been fed followups; a
      // top-level mention has no thread above it. PORT-NOTE (1c: 48a706c).
      firstJoin = Boolean(
        mentioned &&
          event.thread_ts &&
          !this.threads.isActive(channel, threadTs) &&
          this.cfg.threadJoinBackfill > 0,
      );
      this.threads.touch(channel, threadTs);
    }

    this.enqueue({ fromName, user, channel, threadTs, messageTs: ts, text, backfill: firstJoin, isPeer });
  }

  /** Land emoji reactions on our messages (and all DM reactions) in the
   *  mind log. Channel reactions on other people's messages are dropped —
   *  same gate as un-mentioned channel traffic. Parent-thread lookup
   *  happens in the delivery worker, not here: the socket-mode handler
   *  must ack without waiting on the Web API. PORT-NOTE (1c: e5a2f7c,
   *  ed0b700). */
  private onReaction(event: Record<string, unknown>): void {
    const parsed = reactionToInbound(event, this.botUserId);
    if (!parsed) return;
    const { user, channel, itemTs, reaction, wantThread } = parsed;
    const eventTs = (event.event_ts as string | undefined) ?? "";
    if (!this.dedupe.add(`reaction:${channel}:${itemTs}:${user}:${reaction}:${eventTs}`)) return;

    let threadTs: string | null;
    let fromName: string;
    if (wantThread) {
      threadTs = itemTs;
      fromName = naming.encode(user, channel, threadTs);
    } else {
      threadTs = null;
      fromName = naming.encode(user, channel);
    }
    // A reaction is not request intent. Do not touch/resurrect an active
    // thread here — that would open the un-mentioned-reply gate.
    this.enqueue({
      fromName,
      user,
      channel,
      threadTs,
      messageTs: itemTs,
      text: `:${reaction}:`,
      resolveParent: wantThread,
      isReaction: true,
    });
  }

  // -- delivery worker -------------------------------------------------------

  private enqueue(msg: InboundMessage): void {
    this.queueTail = this.queueTail.then(
      () => this.deliver(msg),
      () => this.deliver(msg), // a prior delivery's rejection must not sink this one
    );
  }

  /** Test/driver seam: resolves once every currently enqueued delivery has
   *  settled. */
  async flush(): Promise<void> {
    await this.queueTail;
  }

  /** Run `fn` on the shared lookup slot. At most one call in flight: if a
   *  previous call has not settled, return null immediately rather than
   *  queue another stale lookup — the drain thread must be free to take
   *  the next item. Fails open (null) on timeout or a thrown error; `fn`
   *  keeps running in the background either way (see withTimeout).
   *  PORT-NOTE (1c: f163f93, d5cc776). */
  private async tryLookup<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    what: string,
    channel: string,
    ts: string,
  ): Promise<T | null> {
    if (this.lookupBusy) return null;
    this.lookupBusy = true;
    const p = fn().finally(() => {
      this.lookupBusy = false;
    });
    try {
      return await withTimeout(p, timeoutMs);
    } catch (err) {
      this.log(`${what} failed for ${channel} ts=${ts}: ${describeError(err)}`);
      return null;
    }
  }

  /** Parent thread_ts for the reacted-to message, if it is in a thread.
   *
   * conversations.history only returns parent-channel messages, so a
   * reaction on a reply looks up empty there. conversations.replies is
   * keyed by the thread parent, not the item. reactions.get returns the
   * item itself (including thread_ts) for both roots and replies.
   * PORT-NOTE (1c: ed0b700). */
  private async itemThreadTs(channel: string, ts: string): Promise<string | null> {
    const found = await this.lookupItemMessage(channel, ts);
    if (!found) return null;
    return (found.thread_ts as string | undefined) ?? null;
  }

  private async lookupItemMessage(channel: string, ts: string): Promise<Record<string, unknown> | null> {
    const found = await this.tryLookup(
      async () => {
        const resp = await this.client.reactionsGet(channel, ts);
        const msg = (resp.message ?? {}) as Record<string, unknown>;
        return Object.keys(msg).length > 0 ? msg : null;
      },
      this.itemLookupTimeoutMs,
      "reactions.get",
      channel,
      ts,
    );
    return found ?? null;
  }

  /** Prior messages in a thread, closest to before_ts, capped at limit.
   *
   * conversations.replies pages oldest-first, so one `limit`-sized request
   * would return the parent and earliest replies. Cursor-walk to the last
   * page (bounded by JOIN_BACKFILL_TIMEOUT_MS and a page cap); keep
   * ts < before_ts and take the tail. Fail open to [] so the mention still
   * lands. Shares the one-in-flight lookup slot. PORT-NOTE (1c: 48a706c,
   * d5cc776). */
  private async threadLinesBefore(
    channel: string,
    threadTs: string,
    beforeTs: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const fetchSize = Math.min(200, Math.max(limit + 1, 1));
    const msgs = await this.tryLookup(
      async () => {
        const collected: Array<Record<string, unknown>> = [];
        let cursor = "";
        let exhausted = false;
        for (let page = 0; page < JOIN_BACKFILL_MAX_PAGES; page++) {
          const params: {
            channel: string;
            ts: string;
            latest?: string;
            inclusive?: boolean;
            limit?: number;
            cursor?: string;
          } = { channel, ts: threadTs, latest: beforeTs, inclusive: false, limit: fetchSize };
          if (cursor) params.cursor = cursor;
          const resp = await this.client.conversationsReplies(params);
          const batch = (resp.messages ?? []) as Array<Record<string, unknown>>;
          collected.push(...batch);
          const meta = resp.response_metadata as Record<string, unknown> | undefined;
          cursor = (meta?.next_cursor as string | undefined) ?? "";
          if (!cursor || batch.length === 0) {
            exhausted = true;
            break;
          }
        }
        // Incomplete pagination fails open (mention only) rather than
        // prepending the oldest slice.
        return exhausted ? collected : [];
      },
      this.joinBackfillTimeoutMs,
      "conversations.replies",
      channel,
      threadTs,
    );
    if (!msgs || msgs.length === 0) return [];

    const key = (ts: string): number => {
      const n = Number(ts);
      return Number.isNaN(n) ? 0 : n;
    };
    const cutoff = key(beforeTs);
    const out: Array<Record<string, unknown>> = [];
    for (const m of msgs) {
      const ts = (m.ts as string | undefined) ?? "";
      if (!ts || key(ts) >= cutoff) continue;
      if (m.subtype) continue;
      out.push(m);
    }
    out.sort((a, b) => key((a.ts as string | undefined) ?? "") - key((b.ts as string | undefined) ?? ""));
    return out.slice(Math.max(0, out.length - limit));
  }

  private async formatBackfill(messages: Array<Record<string, unknown>>): Promise<string> {
    const lines: string[] = [];
    for (const m of messages) {
      const userId = m.user as string | undefined;
      const name = userId ? await this.names.user(userId) : ((m.username as string | undefined) ?? "unknown");
      let text = slackfmt.cleanInbound((m.text as string | undefined) ?? "", this.botUserId);
      if (!text) continue;
      text = text.split(/\s+/).filter(Boolean).join(" ");
      if (text.length > JOIN_BACKFILL_LINE_CHARS) {
        text = `${text.slice(0, JOIN_BACKFILL_LINE_CHARS - 3)}...`;
      }
      lines.push(`${name}: ${text}`);
    }
    if (lines.length === 0) return "";
    const n = lines.length;
    const noun = n === 1 ? "message" : "messages";
    const header = `[thread before this mention — ${n} earlier ${noun}]`;
    return `${header}\n${lines.join("\n")}`;
  }

  private async deliver(msg: InboundMessage): Promise<void> {
    if (msg.backfill && msg.threadTs) {
      const prior = await this.threadLinesBefore(msg.channel, msg.threadTs, msg.messageTs, this.cfg.threadJoinBackfill);
      const block = await this.formatBackfill(prior);
      if (block) {
        msg = { ...msg, text: `${block}\n\n${msg.text}`, backfill: false };
      }
    }
    if (msg.resolveParent && msg.threadTs) {
      const itemTs = msg.threadTs;
      const parent = await this.itemThreadTs(msg.channel, itemTs);
      const threadTs = parent ?? itemTs;
      // Body starts as ":emoji:". Nested replies keep item_ts in the body
      // so the mind log names the line, not just the thread.
      const reaction = msg.text.startsWith(":") && msg.text.endsWith(":") ? msg.text.slice(1, -1) : msg.text;
      const text = reactionText(reaction, itemTs, threadTs);
      if (threadTs !== itemTs || text !== msg.text) {
        msg = {
          fromName: naming.encode(msg.user, msg.channel, threadTs),
          user: msg.user,
          channel: msg.channel,
          threadTs,
          messageTs: msg.messageTs,
          text,
          resolveParent: false,
          isReaction: true,
        };
      }
      // A reaction is not request intent. Do not create or resurrect an
      // active thread — that would open the un-mentioned-reply gate.
    }
    const content = slackfmt.cleanInbound(msg.text, this.botUserId);
    if (!content) return;
    // A peer's bridge error is the other bridge talking, not the other
    // persona. Forwarding it made two minds answer an error string at each
    // other every seven seconds on 2026-09-21.
    if (msg.isPeer && content.includes(DELIVERY_ERROR_TEXT)) {
      this.log(`peer bridge error text from ${msg.fromName} not forwarded`);
      return;
    }
    // The reply-to name is spelled out because agent-typed replies (the
    // agentic path, unlike the mechanical fast-reply) must use the full
    // routing key, not the human display name.
    // A peer is named as what it is: the mind should know it is talking to
    // another persona, not a person, and that the exchange is bounded.
    let who = await this.names.user(msg.user);
    if (msg.isPeer) who = `${who}, a Headlong persona like you, not a person`;
    const header = `(Slack: ${who} in ${await this.names.place(msg.channel)}` +
      ` — reply with: chat reply ${msg.fromName})`;
    const body: { content: string; from_name: string; source_url?: string } = {
      content: `${header} ${content}`,
      from_name: msg.fromName,
    };
    // PORT-NOTE (1c: f68c1d8): link the mind-log message back to its Slack
    // permalink. Reactions skip this — see isReaction's PORT-NOTE. A failed
    // lookup (missing scope, outage) is logged and swallowed: a link is
    // useful metadata, but its lookup must never keep a human message out
    // of the mind log.
    if (!msg.isReaction) {
      try {
        const res = await this.client.chatGetPermalink(msg.channel, msg.messageTs);
        const permalink = res.permalink;
        if (typeof permalink === "string" && permalink) body.source_url = permalink;
      } catch (err) {
        this.log(`chat_getPermalink failed for ${msg.fromName}: ${describeError(err)}`);
      }
    }
    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
      try {
        await this.post(this.chatUrl, body);
        return;
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 409) {
          // The mind's tool refused the message on purpose (a duplicate or a
          // bad target); it will refuse it again, and "couldn't reach my
          // mind" would be untrue. PORT-NOTE (2e39a3f).
          this.log(`chat POST refused for ${msg.fromName}: ${refusalReason(err.bodyText)}`);
          return;
        }
        this.log(`chat POST failed (attempt ${attempt}/${DELIVERY_ATTEMPTS}): ${describeError(err)}`);
        if (attempt < DELIVERY_ATTEMPTS) await this.sleep(2000 * attempt);
      }
    }
    try {
      await this.client.chatPostMessage(msg.channel, DELIVERY_ERROR_TEXT, { threadTs: msg.threadTs });
    } catch (err) {
      this.log(`failed posting delivery error to slack: ${describeError(err)}`);
    }
  }

  /** No persistent worker thread to signal in this port (see PORT-NOTE
   *  above) — kept as a no-op so callers written against the Python shape
   *  (`inbound.stop()`) still have something to call. */
  stop(): void {
    // intentionally empty
  }
}
