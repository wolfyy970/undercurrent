// outbound.ts — mind log -> Telegram.
// Faithful port of headlong_telegram.outbound (Python).
//
// Follows the identity's root trajectory and forwards message steps the
// identity addressed to a telegram-* conversation name. The bridge's own
// inbound steps have a telegram-* `from` (not the identity), so they never
// match — no echo loop.
//
// The allowlist gates this direction too: an injected agent that emits a
// step addressed to an unapproved chat gets dropped here, so the bridge
// can't be used as a courier out.
//
// Every send gets a `delivery` step written back to the trajectory (delivered,
// failed with the reason, or skipped), as in the Slack bridge — see
// design/outbound_delivery.md. The step-writing code is a copy of
// src/slack/outbound.ts's, as upstream's headlong_telegram copies
// headlong_slack's (independent projects, step shape kept in sync).
//
// PORT-NOTE: Python runs this as a background `threading.Thread`; Node has
// no threads, so `start()` below just runs the async loop unawaited and
// returns a handle with `.stop()` / `.done` instead of a Thread object. The
// observable behavior (a concurrently running follow-loop that the caller
// can signal to stop) is the same.

import * as fs from "node:fs";
import * as path from "node:path";
import { appendStep as trajAppendStep } from "../trajCore.mjs";
import * as naming from "./naming.ts";
import * as tgfmtNs from "./tgfmt.ts";
import * as mindlogNs from "./mindlog.ts";
import { ApiError, HttpError } from "./api.ts";
import { filePayload, fileSignature } from "./filepayload.ts";
import type { Config } from "./config.ts";

export const DUPLICATE_WINDOW_SECONDS = 300;
export const SOURCE = "telegram-bridge";
export const TRANSPORT = "telegram";
/** Seconds between attempts to reopen the trajectory after an OS error. */
export const RETRY_SECS = 30;

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
    const previous = this.last.get(conversation);
    if (previous && previous[0] === text && t - previous[1] < this.window) {
      return true;
    }
    this.last.set(conversation, [text, t]);
    return false;
  }
}

export interface OutboundBotLike {
  sendMessage(chatId: number, text: string, html?: boolean): Promise<void>;
  // PORT-NOTE (1c: 06f1588): optional, checked via `typeof bot.sendX ===
  // "function"` at the call site — the TS analogue of Python's
  // `hasattr(bot, "send_photo")`/`hasattr(bot, "send_document")` duck-typed
  // capability checks (a minimal test double may omit either).
  sendDocument?(
    chatId: number,
    content: Buffer | string,
    filename: string,
    caption?: string | null,
  ): Promise<unknown>;
  sendPhoto?(
    chatId: number,
    content: Buffer | string,
    filename: string,
    caption?: string | null,
  ): Promise<unknown>;
}

export interface AllowlistLike {
  isApproved(user: number): boolean;
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

/** Where delivery notices go (upstream `outbound.append_step`); see
 *  src/slack/outbound.ts for the in-process-vs-bin/traj PORT-NOTE. */
export type AppendStepFn = (serveRoot: string, trajPath: string, step: Record<string, unknown>) => void | Promise<void>;

export const appendStepViaTraj: AppendStepFn = (_serveRoot, trajPath, step) => {
  try {
    fs.accessSync(trajPath, fs.constants.W_OK);
    fs.accessSync(path.dirname(trajPath), fs.constants.W_OK);
  } catch {
    const e = new Error(`${trajPath} is not writable by this user`);
    e.name = "PermissionError";
    throw e;
  }
  trajAppendStep(trajPath, step);
};

export interface RunOptions {
  shouldStop?: () => boolean;
  log?: (line: string) => void;
  mindlogImpl?: MindlogLike;
  appendStep?: AppendStepFn;
  /** ms between trajectory-reopen attempts after an OS error (default RETRY_SECS*1000). */
  retryMs?: number;
  /** Test seam for the wait between retries (default: real timer, polled
   *  every 100 ms against shouldStop, like Python's `stop_event.wait`). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function excReason(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return `${name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
}

/** Python `OSError` analogue: a Node system error carrying an errno code
 *  (EACCES, ENOENT, EIO, ...). BridgeExit ("no trajectory.jsonl under ...")
 *  is Python's SystemExit, not an OSError, and still propagates. */
function isOSError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}

/**
 * Follow the mind log and deliver outbound messages until stopped.
 *
 * An OS error from the trajectory (permission denied, file gone, disk
 * trouble) does not end the loop: it is logged once and the follow is retried
 * every RETRY_SECS from the persisted cursor. 2026-09-22: the mind set its
 * trajectory directory to 700 and this thread died on the next stat; the
 * process stayed up, inbound kept working, and 19 hours of replies sat in the
 * log until someone noticed. (Upstream docstring.)
 */
export async function run(
  cfg: Config,
  bot: OutboundBotLike,
  allowlist: AllowlistLike,
  opts: RunOptions = {},
): Promise<void> {
  const log = opts.log ?? defaultLog;
  const ml = opts.mindlogImpl ?? mindlogNs;
  const cursor = path.join(cfg.stateDir, "cursor");
  const recent = new RecentPosts();
  const shouldStop = opts.shouldStop ?? (() => false);
  const retryMs = opts.retryMs ?? RETRY_SECS * 1000;
  const sleep =
    opts.sleep ??
    (async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !shouldStop()) {
        await new Promise<void>((r) => setTimeout(r, Math.min(100, Math.max(0, end - Date.now()))));
      }
    });
  let failing: string | null = null;
  const state = { noticesDisabled: false };
  while (!shouldStop()) {
    try {
      const traj = ml.findTrajectory(cfg.identityDir);
      if (failing !== null) {
        log(`trajectory readable again after: ${failing}`);
        failing = null;
      }
      log(`following ${traj}`);
      await deliverLoop(cfg, bot, allowlist, opts, traj, cursor, recent, state);
      return;
    } catch (err) {
      if (!isOSError(err)) throw err;
      const reason = excReason(err);
      if (reason !== failing) {
        log(`cannot read the trajectory (${reason}); retrying every ${RETRY_SECS}s`);
        failing = reason;
      }
      await sleep(retryMs);
    }
  }
}

async function deliverLoop(
  cfg: Config,
  bot: OutboundBotLike,
  allowlist: AllowlistLike,
  opts: RunOptions,
  traj: string,
  cursor: string,
  recent: RecentPosts,
  state: { noticesDisabled: boolean },
): Promise<void> {
  const log = opts.log ?? defaultLog;
  const ml = opts.mindlogImpl ?? mindlogNs;
  const shouldStop = opts.shouldStop ?? (() => false);
  const appendNotice = opts.appendStep ?? appendStepViaTraj;
  // PORT-NOTE: upstream's module-level `_notices_disabled`; per delivery loop
  // here. After a PermissionError a run says so once and stops trying.
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
    const record: Record<string, unknown> = { type: "delivery", source: SOURCE, transport: TRANSPORT, status, to, content };
    if (step.step_id) record.trigger_step = step.step_id;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && v !== "") record[k] = v;
    }
    if (state.noticesDisabled) return;
    try {
      await appendNotice(cfg.serveRoot, traj, record);
    } catch (err) {
      if (err instanceof Error && err.name === "PermissionError") {
        state.noticesDisabled = true;
        log(`delivery notices disabled for this run: ${describeError(err)}`);
      } else {
        log(`could not write delivery notice for step ${String(step.step_id ?? "")}: ${describeError(err)}`);
      }
    }
  };
  for await (const step of ml.follow(traj, cursor, { shouldStop })) {
    if (step.type !== "message" || step.from !== cfg.identity) continue;
    if (step.source !== "chat") {
      // Only `chat` speaks for the identity — it stamps source:"chat" on
      // every outgoing message. Thinkers sometimes append raw message steps
      // directly to the trajectory (thinking out loud, not a reply);
      // delivering those gives the user a second, unstamped voice. Bridges
      // are the mouth; the trajectory is the mind.
      log(`dropping non-chat message step ${step.step_id} (source=${JSON.stringify(step.source ?? null)})`);
      continue;
    }
    const to = step.to;
    if (typeof to !== "string" || !to.startsWith(naming.PREFIX + "-")) continue; // another transport's; its bridge owns it
    if (!naming.isTelegramName(to)) {
      log(`undeliverable address ${JSON.stringify(to)} on step ${String(step.step_id ?? "")}`);
      await notice(step, "failed", { reason: "unknown telegram address form; accepted: telegram-<user id>-<chat id>" });
      continue;
    }
    const conv = naming.decode(to as string);
    if ("reaction" in step) {
      // Slack-only: a chat-react step must not become a Telegram message
      // (6a98ab5's telegram-side half — Telegram has no reaction API here).
      continue;
    }
    if (!allowlist.isApproved(conv.user)) {
      log(`dropping reply to unapproved user ${conv.user}`);
      await notice(step, "failed", { reason: "recipient is not on the Telegram allowlist" });
      continue;
    }
    if (conv.user !== conv.chat) {
      // PORT-NOTE (1c: a2cf670): the bridge is DM-only; a group-chat
      // destination (user != chat) is dropped rather than delivered.
      log(`dropping reply to group chat ${conv.chat}`);
      await notice(step, "failed", { reason: "group chats are not supported; DMs only" });
      continue;
    }

    const payload = filePayload(step);
    if (payload !== null) {
      // PORT-NOTE (1c: 06f1588, a2cf670, ab13bab, 2827421, f68ae29,
      // c647609, 21c62ba): file steps travel in content_b64 and often have
      // empty `content`. Do not require text, and do not fall back to
      // posting bytes as a message.
      const name = payload.filename;
      const data = payload.content;
      const caption = payload.caption;
      let sentFile = false;
      let reason = "";
      if (payload.decodeError || data === null) {
        reason = `undecodable file payload (${name})`;
        log(`undecodable file payload for ${to} (${name})`);
      } else if (recent.isDuplicate(to as string, fileSignature(name, data))) {
        log(`skipping duplicate file post to ${to}`);
        await notice(step, "skipped", { reason: "duplicate of a file sent within 5 minutes", filename: name });
        continue;
      } else {
        try {
          if (payload.asPhoto && typeof bot.sendPhoto === "function") {
            try {
              await bot.sendPhoto(conv.chat, data, name, caption);
              sentFile = true;
            } catch (err) {
              if (!(err instanceof ApiError)) throw err;
              if (typeof bot.sendDocument !== "function") throw err;
              await bot.sendDocument(conv.chat, data, name, caption);
              sentFile = true;
            }
          } else if (typeof bot.sendDocument === "function") {
            await bot.sendDocument(conv.chat, data, name, caption);
            sentFile = true;
          } else {
            reason = "bot cannot send files";
            log(`bot cannot send files for ${to}`);
          }
        } catch (err) {
          if (!(err instanceof ApiError) && !(err instanceof HttpError)) throw err;
          reason = excReason(err);
          log(`file send failed for ${to}: ${describeError(err)}`);
        }
      }
      if (sentFile) {
        await notice(step, "delivered", { chat: String(conv.chat), filename: name });
      } else {
        // Cursor already advanced past this step; tell the user the
        // upload was lost rather than failing silently.
        const lost = `(failed to deliver file ${name})`;
        try {
          await bot.sendMessage(conv.chat, lost);
        } catch (err) {
          if (!(err instanceof ApiError) && !(err instanceof HttpError)) throw err;
          log(`delivery-failed notice also failed for ${to}: ${describeError(err)}`);
        }
        await notice(step, "failed", { reason, filename: name });
      }
      continue;
    }

    const text = tgfmtNs.stripLeakedCommand(String(step.content || "")).trim();
    if (!text) continue;
    if (recent.isDuplicate(to as string, text)) {
      log(`skipping duplicate post to ${to}`);
      await notice(step, "skipped", { reason: "duplicate of a message sent within 5 minutes" });
      continue;
    }
    let failure: string | null = null;
    let sentParts = 0;
    for (const part of tgfmtNs.chunk(text)) {
      try {
        await bot.sendMessage(conv.chat, tgfmtNs.toHtml(part), true);
        sentParts += 1;
      } catch (err) {
        if (err instanceof ApiError) {
          // Bad HTML from an odd reply must not eat the message — fall back
          // to plain text before giving up.
          try {
            await bot.sendMessage(conv.chat, part);
            sentParts += 1;
          } catch (err2) {
            if (!(err2 instanceof ApiError) && !(err2 instanceof HttpError)) throw err2;
            failure = excReason(err2);
            log(`sendMessage failed for ${to}: ${describeError(err2)}`);
            break;
          }
        } else if (err instanceof HttpError) {
          failure = excReason(err);
          log(`sendMessage failed for ${to}: ${describeError(err)}`);
          break;
        } else {
          throw err;
        }
      }
    }
    if (failure === null) {
      await notice(step, "delivered", { chat: String(conv.chat) });
    } else if (sentParts) {
      await notice(step, "failed", { reason: `partly sent, then ${failure}`, chat: String(conv.chat) });
    } else {
      await notice(step, "failed", { reason: failure });
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
  bot: OutboundBotLike,
  allowlist: AllowlistLike,
  opts: RunOptions = {},
): OutboundHandle {
  let stopped = false;
  const outerShouldStop = opts.shouldStop;
  const shouldStop = () => stopped || (outerShouldStop?.() ?? false);
  const log = opts.log ?? defaultLog;
  const done = run(cfg, bot, allowlist, { ...opts, shouldStop }).catch((err: unknown) => {
    log(`telegram-outbound crashed: ${describeError(err)}`);
    throw err;
  });
  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}
