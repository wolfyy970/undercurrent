// filepayload.ts — detect file-bearing mind-log steps for Telegram outbound.
// Faithful port of headlong_telegram.filepayload (Python), new in upstream
// PR #84 (06f1588..9a62727, squashed here).
//
// `chat send-file` stamps `filename` on the message step. Binary files
// travel in `content_b64` (standard base64) because JSON cannot hold raw
// bytes; text may sit in `content`. Outbound uploads the decoded bytes via
// sendPhoto/sendDocument rather than stuffing them into sendMessage.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { stripLeakedCommand } from "./tgfmt.ts";

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
export const CAPTION_MAX = 1024; // Telegram media-caption limit

/** Bounded RecentPosts key: basename plus a hash of the decoded bytes. */
export function fileSignature(filename: string, content: Buffer | string): string {
  const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return `${filename}:${createHash("sha256").update(raw).digest("hex")}`;
}

/** File bytes could not be recovered from the step. */
export class DecodeError extends Error {}

// PORT-NOTE (1c: ab13bab, f68ae29): Python's `base64.b64decode(b64,
// validate=True)` raises on any character outside the base64 alphabet or a
// length not a multiple of 4; Node's `Buffer.from(s, "base64")` is lenient
// and silently drops invalid characters instead of throwing, which would
// let a malformed `content_b64` decode "successfully" to the wrong bytes
// (or to nothing) rather than failing loudly as f68ae29 requires. This
// validator reproduces `validate=True`'s strictness before handing off to
// Buffer's decoder.
const STRICT_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function strictBase64Decode(s: string): Buffer {
  if (s.length % 4 !== 0 || !STRICT_B64_RE.test(s)) {
    throw new DecodeError("invalid base64");
  }
  const eq = s.indexOf("=");
  if (eq !== -1 && eq < s.length - 2) {
    throw new DecodeError("invalid base64 padding");
  }
  return Buffer.from(s, "base64");
}

function contentOf(step: Record<string, unknown>): Buffer | string | null {
  if ("content_b64" in step) {
    const b64 = step.content_b64;
    if (typeof b64 !== "string" || b64 === "") throw new DecodeError("empty content_b64");
    const raw = strictBase64Decode(b64);
    if (raw.length === 0) throw new DecodeError("empty content_b64");
    return raw;
  }
  const content = step.content;
  if (content === null || content === undefined || content === "") return null;
  if (typeof content === "string") return stripLeakedCommand(content);
  // JSON can hold objects/arrays/numbers; file_signature and the upload
  // path only accept text or bytes. Anything else is a decode error so
  // outbound can notice-and-continue (21c62ba).
  throw new DecodeError("non-string content");
}

function asPhoto(content: Buffer | string | null): boolean {
  if (!Buffer.isBuffer(content)) return false;
  return (
    content.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ||
    content.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)
  );
}

export interface FilePayload {
  filename: string;
  content: Buffer | string | null;
  caption: string | null;
  asPhoto: boolean;
  decodeError: boolean;
}

/**
 * Return upload kwargs, or null if this step is ordinary text.
 *
 * A file step is one with an explicit `filename` field. The `file` alias
 * is not accepted (2827421): an ordinary message that happens to carry
 * that key must stay a sendMessage. Content is leak-filtered so a stray
 * `chat reply` in a caption cannot re-trigger the agent.
 *
 * If `content_b64` is present but not strict base64 (or decodes to
 * empty), the returned object has `content: null` and `decodeError: true`
 * so outbound can fail loudly instead of falling through to sendMessage.
 */
export function filePayload(step: Record<string, unknown>): FilePayload | null {
  const rawName = step.filename;
  if (typeof rawName !== "string" || rawName.trim() === "") return null;
  const filename = path.basename(rawName);
  if (!filename || filename === "." || filename === "..") return null;

  let content: Buffer | string | null;
  let decodeError = false;
  try {
    content = contentOf(step);
  } catch (err) {
    if (!(err instanceof DecodeError)) throw err;
    content = null;
    decodeError = true;
  }
  if (content === null && !decodeError) return null;

  const rawCaption = step.caption;
  let caption: string | null;
  if (rawCaption === null || rawCaption === undefined || rawCaption === "") {
    caption = null;
  } else {
    const stripped = stripLeakedCommand(String(rawCaption)).slice(0, CAPTION_MAX);
    caption = stripped === "" ? null : stripped;
  }

  return {
    filename,
    content,
    caption,
    asPhoto: asPhoto(content),
    decodeError,
  };
}
