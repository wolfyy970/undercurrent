// filepayload.ts — detect file-bearing mind-log steps for Slack outbound.
// Faithful port of headlong_slack.filepayload (Python), added in 692e16e.
//
// `chat send-file` stamps `filename` on the message step. Binary files
// travel in `content_b64` (standard base64) because JSON cannot hold raw
// bytes; text may sit in `content`. Outbound uploads the decoded bytes via
// files.upload_v2 rather than stuffing them into chat.postMessage.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { stripLeakedCommand } from "./slackfmt.ts";

export const COMMENT_MAX = 3000; // Slack files.upload_v2 initial_comment

/** Bounded RecentPosts key: basename plus a hash of the decoded bytes. */
export function fileSignature(filename: string, content: Uint8Array | string): string {
  const raw = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return `${filename}:${createHash("sha256").update(raw).digest("hex")}`;
}

/** File bytes could not be recovered from the step. */
export class DecodeError extends Error {}

function decodeContent(step: Record<string, unknown>): Uint8Array | string | null {
  if ("content_b64" in step) {
    const b64 = step.content_b64;
    if (typeof b64 !== "string" || !b64) throw new DecodeError("empty content_b64");
    let raw: Buffer;
    try {
      raw = Buffer.from(b64, "base64");
      // Node's base64 decoder is lenient; verify a strict round trip so
      // garbage input (Python's base64.b64decode(..., validate=True)) is
      // rejected the same way, not silently truncated.
      if (raw.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
        throw new Error("invalid base64");
      }
    } catch (err) {
      throw new DecodeError(err instanceof Error ? err.message : String(err));
    }
    if (raw.length === 0) throw new DecodeError("empty content_b64");
    return raw;
  }
  const content = step.content;
  if (content === undefined || content === null || content === "") return null;
  if (typeof content === "string") return stripLeakedCommand(content);
  throw new DecodeError("non-string content");
}

export interface FilePayload {
  filename: string;
  content: Uint8Array | string | null;
  initialComment: string | null;
  decodeError: boolean;
}

/**
 * Return upload kwargs, or null if this step is ordinary text.
 *
 * A file step is one with an explicit `filename` field. The `file` alias is
 * not accepted: an ordinary message that happens to carry that key must
 * stay a chat.postMessage. Content is leak-filtered so a stray `chat reply`
 * in a caption cannot re-trigger the agent.
 *
 * If `content_b64` is present but not strict base64 (or decodes to empty),
 * the returned object has `content: null` and `decodeError: true` so
 * outbound can fail loudly instead of falling through to chat.postMessage.
 */
export function filePayload(step: Record<string, unknown>): FilePayload | null {
  const rawName = step.filename;
  if (typeof rawName !== "string" || !rawName.trim()) return null;
  const filename = path.basename(rawName);
  if (!filename || filename === "." || filename === "..") return null;

  let decodeErr = false;
  let content: Uint8Array | string | null;
  try {
    content = decodeContent(step);
  } catch (err) {
    if (!(err instanceof DecodeError)) throw err;
    content = null;
    decodeErr = true;
  }
  if (content === null && !decodeErr) return null;

  const caption = step.caption;
  let initialComment: string | null;
  if (caption === undefined || caption === null || caption === "") {
    initialComment = null;
  } else {
    const stripped = stripLeakedCommand(String(caption)).slice(0, COMMENT_MAX);
    initialComment = stripped || null;
  }

  return { filename, content, initialComment, decodeError: decodeErr };
}
