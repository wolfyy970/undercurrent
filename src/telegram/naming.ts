// naming.ts — encode a Telegram conversation into a chat `from` name and back.
// Faithful port of headlong_telegram.naming (Python).
//
// The name is the only routing metadata that survives the round trip through
// the mind log (`from` on the inbound message step comes back as `to` on the
// reply step), so it has to carry everything needed to deliver the reply:
//
//     DM: telegram-5551234-5551234   (user id, chat id)
//
// It must match the web API's CHAT_FROM_RE (^[A-Za-z0-9][A-Za-z0-9._-]*$).
// The bridge is DM-only, where both ids are positive integers; group chat
// ids are negative and their leading minus would break the `-` separator,
// so encode() refuses them outright.

export const PREFIX = "telegram";

export interface Conversation {
  user: number;
  chat: number;
}

export function encode(user: number, chat: number): string {
  if (user <= 0 || chat <= 0) {
    throw new Error(`not a DM conversation: user=${user} chat=${chat}`);
  }
  return `${PREFIX}-${user}-${chat}`;
}

/** All-ASCII-digit test matching Python's `str.isdigit()` for the plain
 *  numeric strings this module ever sees (no leading sign, non-empty). */
function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

export function decode(name: string): Conversation {
  const parts = name.split("-");
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts.slice(1).every(isDigits)) {
    throw new Error(`not a telegram conversation name: ${JSON.stringify(name)}`);
  }
  return { user: Number(parts[1]), chat: Number(parts[2]) };
}

export function isTelegramName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  try {
    decode(name);
  } catch {
    return false;
  }
  return true;
}
