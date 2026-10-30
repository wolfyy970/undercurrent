// outbound.ts — mind log -> Slack.
// Faithful port of headlong_slack.outbound (Python).
//
// Follows the identity's root trajectory and forwards message steps the
// identity addressed to a slack-* conversation name. The bridge's own
// inbound steps have a slack-* `from` (not the identity), so they never
// match — no echo loop.
//
// Every send gets a `delivery` step written back to the trajectory, either
// delivered (with the Slack ts and permalink) or failed (with the reason), so
// the mind can tell "I spoke" from "I tried to". Before this, a malformed
// address was dropped with no trace and the mind re-sent the same papers four
// times believing none had gone out (design/outbound_delivery.md).
//
// PORT-NOTE: Python runs this as a background `threading.Thread`; Node has
// no threads, so `start()` below just runs the async loop unawaited and
// returns a handle with `.stop()` / `.done` instead of a Thread object. Same
// adaptation as src/telegram/outbound.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { appendStep as trajAppendStep } from "../trajCore.mjs";
import * as naming from "./naming.ts";
import * as slackfmt from "./slackfmt.ts";
import * as mindlogNs from "./mindlog.ts";
import { filePayload, fileSignature } from "./filepayload.ts";
import type { Config } from "./config.ts";
import type { ActiveThreadsLike } from "./inbound.ts";

export const DUPLICATE_WINDOW_SECONDS = 300;
export const SOURCE = "slack-bridge";
export const TRANSPORT = "slack";

/**
 * Transport-level dedupe: agents occasionally send the same reply twice
 * (e.g. an agentic run re-executing its chat command). Posting an identical
 * message to the same conversation twice within the window is never right.
 */
export class RecentPosts {
  private readonly window: number;
  private readonly last = new Map<string, [string, number]>();

  constructor(window: number = DUPLICATE_WINDOW_SECONDS) {
    this.window = window;
  }

  isDuplicate(conversation: string, text: string, now?: number): boolean {
    const t = now ?? Date.now() / 1000;
    if (this.seen(conversation, text, t)) return true;
    this.record(conversation, text, t);
    return false;
  }

  /** True if this payload was already recorded in the window. Does not
   *  record. PORT-NOTE (1c: c7d240b): file-upload dedupe must not be
   *  stamped before Slack accepts the upload — split out of isDuplicate so
   *  a caller can check-then-record-on-success instead of check-and-stamp
   *  atomically. */
  seen(conversation: string, text: string, now?: number): boolean {
    const t = now ?? Date.now() / 1000;
    const previous = this.last.get(conversation);
    return Boolean(previous && previous[0] === text && t - previous[1] < this.window);
  }

  record(conversation: string, text: string, now?: number): void {
    const t = now ?? Date.now() / 1000;
    this.last.set(conversation, [text, t]);
  }
}

export interface OutboundClientLike {
  chatPostMessage(
    channel: string,
    text: string,
    opts?: { threadTs?: string | null; unfurlLinks?: boolean },
  ): Promise<unknown>;
  /** Optional (fake clients lack it): permalink for a delivery notice. */
  chatGetPermalink?(channel: string, messageTs: string): Promise<unknown>;
  /** Optional: opens (or looks up) the DM with a user, for bare slack-U… targets. */
  conversationsOpen?(users: string): Promise<unknown>;
  reactionsAdd?(channel: string, timestamp: string, name: string): Promise<void>;
  filesUploadV2?(opts: {
    channel: string;
    filename: string;
    title?: string;
    content: Uint8Array | string;
    threadTs?: string | null;
    initialComment?: string | null;
  }): Promise<unknown>;
}

/** Field from a slack response, a plain object, or nothing (fake clients).
 *  Upstream `_resp_get`. */
export function respGet(resp: unknown, key: string): unknown {
  if (resp === null || resp === undefined) return null;
  if (typeof resp === "object" && !Array.isArray(resp)) {
    const v = (resp as Record<string, unknown>)[key];
    return v === undefined ? null : v;
  }
  return null;
}

/** Upstream `_exc_reason`: "<ExceptionName>: <slack error code or message>". */
export function excReason(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const response = (err as { response?: unknown } | null)?.response;
  const code = respGet(response, "error");
  const text = `${name}: ${code ? String(code) : err instanceof Error ? err.message : String(err)}`;
  return text.slice(0, 200);
}

// --- delivery notices -------------------------------------------------------

/** Writes one step into the root trajectory. The default appends in-process
 *  through trajCore's locked `appendStep` — the same primitive `bin/traj
 *  append` uses — after upstream's writability guard. Tests/parity replace it
 *  through `RunOptions.appendStep` (upstream: `outbound.append_step`).
 *
 *  PORT-NOTE (2e39a3f): upstream shells out to `bin/traj append` with a
 *  10 s timeout; the port has no subprocess to a Bash binary, so the call is
 *  in-process. The guard stays: the Telegram bridge runs as a user with
 *  read-only access to the trajectory, and a missing guard hung the first
 *  notices for the full timeout upstream (2026-09-09). */
export type AppendStepFn = (serveRoot: string, trajPath: string, step: Record<string, unknown>) => void | Promise<void>;

export const appendStepViaTraj: AppendStepFn = (_serveRoot, trajPath, step) => {
  try {
    fs.accessSync(trajPath, fs.constants.W_OK);
    fs.accessSync(path.dirname(trajPath), fs.constants.W_OK);
  } catch {
    const e = new Error(`${trajPath} is not writable by this user`);
    (e as Error & { code?: string }).code = "EACCES";
    e.name = "PermissionError";
    throw e;
  }
  trajAppendStep(trajPath, step);
};

function isPermissionError(err: unknown): boolean {
  return err instanceof Error && err.name === "PermissionError";
}

/** A permalink, or null — never throws. */
async function permalinkFor(client: OutboundClientLike, channel: string, ts: string | null): Promise<string | null> {
  if (!ts || !client.chatGetPermalink) return null;
  let resp: unknown;
  try {
    resp = await client.chatGetPermalink(channel, ts);
  } catch {
    return null;
  }
  const link = respGet(resp, "permalink");
  return link ? String(link) : null;
}

/** Resolve a bare user id to its DM channel with conversations.open, once. */
export class DmChannels {
  private readonly cache = new Map<string, string>();

  async resolve(client: OutboundClientLike, user: string): Promise<string> {
    const hit = this.cache.get(user);
    if (hit !== undefined) return hit;
    if (!client.conversationsOpen) throw new Error("client cannot open DMs (conversations_open missing)");
    const resp = await client.conversationsOpen(user);
    const channel = respGet(resp, "channel");
    const id = channel !== null ? respGet(channel, "id") : null;
    if (!id) throw new Error(`conversations.open returned no channel for ${user}`);
    this.cache.set(user, String(id));
    return String(id);
  }
}

/** Slack emoji name from a chat-react step, or null if this is not one.
 *  PORT-NOTE (1c: 6a98ab5). */
export function reactionName(step: Record<string, unknown>): string | null {
  const raw = step.reaction;
  if (typeof raw !== "string") return null;
  let name = raw.trim();
  while (name.startsWith(":")) name = name.slice(1);
  while (name.endsWith(":")) name = name.slice(0, -1);
  if (!name || /\s/.test(name)) return null;
  if (![...name].every((c) => /[A-Za-z0-9_+:-]/.test(c))) return null;
  if (name.length > 100) return null;
  return name;
}

/** Decode a Slack archive permalink /archives/<channel>/p<ts-without-dot>.
 *  PORT-NOTE (1c: 6a98ab5). */
export function messageTsFromSourceUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[parts.length - 3] !== "archives") return null;
  const last = parts[parts.length - 1]!;
  if (!last.startsWith("p") || !/^[0-9]+$/.test(last.slice(1)) || last.length < 8) return null;
  const digits = last.slice(1);
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

function alreadyReacted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("already_reacted");
}

async function addReaction(
  client: OutboundClientLike,
  conv: naming.Conversation,
  name: string,
  timestamp: string,
): Promise<void> {
  try {
    await client.reactionsAdd!(conv.channel, timestamp, name);
  } catch (err) {
    if (alreadyReacted(err)) return;
    throw err;
  }
}

async function postNotice(
  client: OutboundClientLike,
  conv: naming.Conversation,
  text: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await client.chatPostMessage(conv.channel, text, { threadTs: conv.threadTs, unfurlLinks: false });
  } catch (err) {
    log(`delivery-failed notice also failed for ${conv.channel}/${conv.threadTs}: ${describeError(err)}`);
  }
}

async function uploadFile(
  client: OutboundClientLike,
  conv: naming.Conversation,
  filename: string,
  data: Uint8Array | string,
  comment: string | null,
): Promise<unknown> {
  return client.filesUploadV2!({
    channel: conv.channel,
    filename,
    title: filename,
    content: data,
    threadTs: conv.threadTs,
    initialComment: comment,
  });
}

/** The mindlog surface `run` depends on — injectable so tests can replace
 *  `findTrajectory`/`follow` without a real trajectory file, matching the
 *  Python test's monkeypatch of `outbound.mindlog.find_trajectory` /
 *  `outbound.mindlog.follow`. */
export interface MindlogLike {
  findTrajectory(identityDir: string): string;
  follow(
    filePath: string,
    cursorFile: string,
    opts?: { shouldStop?: () => boolean },
  ): AsyncIterable<Record<string, unknown>>;
}

export interface RunOptions {
  shouldStop?: () => boolean;
  log?: (line: string) => void;
  mindlogImpl?: MindlogLike;
  /** Upstream's module-level `append_step` seam: where delivery notices go.
   *  Default: appendStepViaTraj. */
  appendStep?: AppendStepFn;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(
  cfg: Config,
  client: OutboundClientLike,
  threads: ActiveThreadsLike,
  opts: RunOptions = {},
): Promise<void> {
  const log = opts.log ?? defaultLog;
  const ml = opts.mindlogImpl ?? mindlogNs;
  const traj = ml.findTrajectory(cfg.identityDir);
  const cursor = path.join(cfg.stateDir, "cursor");
  const recent = new RecentPosts();
  const dms = new DmChannels();
  const appendNotice = opts.appendStep ?? appendStepViaTraj;
  // Set after the first PermissionError so a bridge that cannot write the log
  // says so once and stops trying, instead of paying a timeout per send.
  // PORT-NOTE: per-run state here, a module global upstream (one run per
  // process in production, so identical).
  let noticesDisabled = false;

  /** Write one delivery step for an outbound message step. status is
   *  delivered, failed, or skipped. trigger_step names the message step the
   *  notice is about, so a later reader (chat sent, the wake prompt) can
   *  resolve a send by matching it. Never throws: a notice that cannot be
   *  written must not stop delivery of the next message. */
  const notice = async (
    step: Record<string, unknown>,
    status: "delivered" | "failed" | "skipped",
    fields: Record<string, unknown> = {},
  ): Promise<void> => {
    const to = String(step.to || "");
    let content: string;
    if (status === "delivered") content = `delivered to ${to}`;
    else if (status === "skipped") content = `not sent to ${to}: ${fields.reason ?? "skipped"}`;
    else content = `not delivered to ${to}: ${fields.reason ?? "unknown error"}`;
    const record: Record<string, unknown> = {
      type: "delivery",
      source: SOURCE,
      transport: TRANSPORT,
      status,
      to,
      content,
    };
    if (step.step_id) record.trigger_step = step.step_id;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && v !== "") record[k] = v;
    }
    if (noticesDisabled) return;
    try {
      await appendNotice(cfg.serveRoot, traj, record);
    } catch (err) {
      if (isPermissionError(err)) {
        noticesDisabled = true;
        log(`delivery notices disabled for this run: ${describeError(err)}`);
      } else {
        log(`could not write delivery notice for step ${String(step.step_id ?? "")}: ${describeError(err)}`);
      }
    }
  };

  const shouldStop = opts.shouldStop ?? (() => false);
  log(`following ${traj}`);
  for await (const step of ml.follow(traj, cursor, { shouldStop })) {
    if (step.type !== "message" || step.from !== cfg.identity) continue;
    if (step.source !== "chat") {
      // Only bin/chat speaks for the identity — it stamps source:"chat" on
      // every outgoing message. Thinkers sometimes append raw message steps
      // directly to the trajectory (thinking out loud, not a reply);
      // delivering those gives the user a second, unstamped voice. Bridges
      // are the mouth; the trajectory is the mind.
      log(`dropping non-chat message step ${step.step_id} (source=${JSON.stringify(step.source ?? null)})`);
      continue;
    }
    const to = step.to;
    if (!naming.looksLikeSlack(to)) continue; // another transport's message; its bridge owns it
    if (!naming.isSlackName(to)) {
      const reason = `unknown slack address form; accepted: ${naming.ACCEPTED_FORMS}`;
      log(`undeliverable address ${JSON.stringify(to)} on step ${String(step.step_id ?? "")}`);
      await notice(step, "failed", { reason });
      continue;
    }
    let conv = naming.decode(to as string);

    // PORT-NOTE (1c: 6a98ab5): `chat react` stamps a chat-sourced message
    // step with a `reaction` field (Slack emoji short name). The bridge
    // calls reactions.add on the permalink's message_ts, falling back to
    // the conversation's thread_ts (a DM/top-level reaction with no
    // permalink has nothing to react to and is skipped).
    if ("reaction" in step) {
      const name = reactionName(step);
      const ts = messageTsFromSourceUrl(step.source_url) ?? conv.threadTs;
      const sig = name && ts ? `react:${name}:${ts}` : null;
      if (!name) {
        log(`invalid reaction on step ${String(step.step_id ?? "")}`);
      } else if (!ts) {
        log(`reaction ${name} for ${to} has no message timestamp`);
      } else if (!conv.channel) {
        log(`reaction ${name} for ${to} needs a channel`);
      } else if (sig !== null && recent.seen(to as string, sig)) {
        log(`skipping duplicate reaction ${name} on ${to}`);
      } else if (!client.reactionsAdd) {
        log(`client cannot add reactions for ${to}`);
      } else {
        try {
          await addReaction(client, conv, name, ts);
          if (sig !== null) recent.record(to as string, sig);
        } catch (err) {
          log(`reactions.add failed for ${to} (${name}): ${describeError(err)}`);
        }
      }
      continue;
    }

    // A bare user id means "DM this person": open (or look up) the DM
    // channel first, so the rest of the path only ever sees a channel.
    if (!conv.channel) {
      try {
        conv = { ...conv, channel: await dms.resolve(client, conv.user) };
      } catch (err) {
        log(`could not open DM with ${conv.user} for ${to}: ${describeError(err)}`);
        await notice(step, "failed", { reason: excReason(err) });
        continue;
      }
    }

    // PORT-NOTE (1c: 692e16e, c7d240b): `chat send-file` stamps `filename`
    // (+ content_b64/content) on the step. File steps travel in
    // content_b64 and often have empty `content`; do not require text, and
    // do not fall back to posting bytes as a chat message. Dedupe is
    // recorded only AFTER files.upload_v2 accepts — a transient Slack
    // rejection must not suppress the retry for the dedupe window.
    const payload = filePayload(step);
    if (payload !== null) {
      const name = payload.filename;
      const data = payload.content;
      const comment = payload.initialComment;
      const sig = data !== null ? fileSignature(name, data) : null;
      let sentFile = false;
      let reason = "";
      if (payload.decodeError || data === null) {
        reason = `undecodable file payload (${name})`;
        log(`undecodable file payload for ${to} (${name})`);
      } else if (sig !== null && recent.seen(to as string, sig)) {
        log(`skipping duplicate file post to ${to}`);
        await notice(step, "skipped", { reason: "duplicate of a file posted within 5 minutes", filename: name });
        continue;
      } else if (!client.filesUploadV2) {
        reason = "client cannot upload files";
        log(`client cannot upload files for ${to}`);
      } else {
        try {
          await uploadFile(client, conv, name, data, comment);
          sentFile = true;
          if (sig !== null) recent.record(to as string, sig);
        } catch (err) {
          reason = excReason(err);
          log(`file upload failed for ${to}: ${describeError(err)}`);
        }
      }
      threads.touch(conv.channel, conv.threadTs);
      if (sentFile) {
        await notice(step, "delivered", { channel: conv.channel, filename: name });
      } else {
        await postNotice(client, conv, `(failed to deliver file ${name})`, log);
        await notice(step, "failed", { reason, filename: name });
      }
      continue;
    }

    const text = slackfmt.toMrkdwn(slackfmt.stripLeakedCommand(String(step.content || ""))).trim();
    if (!text) continue;
    if (recent.isDuplicate(to as string, text)) {
      log(`skipping duplicate post to ${to}`);
      await notice(step, "skipped", { reason: "duplicate of a post within 5 minutes" });
      continue;
    }
    threads.touch(conv.channel, conv.threadTs);
    let firstTs: string | null = null;
    let failure: string | null = null;
    for (const part of slackfmt.chunk(text)) {
      let resp: unknown;
      try {
        resp = await client.chatPostMessage(conv.channel, part, { threadTs: conv.threadTs, unfurlLinks: false });
      } catch (err) {
        failure = excReason(err);
        log(`chat_postMessage failed for ${to}: ${describeError(err)}`);
        break;
      }
      if (firstTs === null) {
        const ts = respGet(resp, "ts");
        firstTs = ts ? String(ts) : null;
      }
    }
    if (conv.threadTs === null && firstTs) {
      // A top-level post starts a thread rooted at its own ts. Register it as
      // active so un-mentioned replies under it are forwarded; the touch
      // above was a no-op for a bare channel address, which is why a reply
      // under one of Audel's posts went unseen for an hour on 2026-09-10.
      threads.touch(conv.channel, firstTs);
    }
    if (failure !== null && firstTs === null) {
      await notice(step, "failed", { reason: failure });
    } else if (failure !== null) {
      // message_ts, not ts: traj append stamps its own ts on every step and
      // would overwrite the Slack timestamp (seen on the first live notice,
      // 2026-09-09).
      await notice(step, "failed", {
        reason: `partly posted, then ${failure}`,
        channel: conv.channel,
        message_ts: firstTs,
        permalink: await permalinkFor(client, conv.channel, firstTs),
      });
    } else {
      await notice(step, "delivered", {
        channel: conv.channel,
        message_ts: firstTs,
        permalink: await permalinkFor(client, conv.channel, firstTs),
      });
    }
  }
}

export interface OutboundHandle {
  /** Signal the loop to stop after its current `follow` poll tick. */
  stop(): void;
  /** Resolves when the loop has stopped (or rejects if it crashed). */
  done: Promise<void>;
}

export function start(
  cfg: Config,
  client: OutboundClientLike,
  threads: ActiveThreadsLike,
  opts: RunOptions = {},
): OutboundHandle {
  let stopped = false;
  const outerShouldStop = opts.shouldStop;
  const shouldStop = () => stopped || (outerShouldStop?.() ?? false);
  const log = opts.log ?? defaultLog;
  const done = run(cfg, client, threads, { ...opts, shouldStop }).catch((err: unknown) => {
    log(`slack-outbound crashed: ${describeError(err)}`);
    throw err;
  });
  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}
