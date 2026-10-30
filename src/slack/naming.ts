// naming.ts — encode a Slack conversation into a chat `from` name and back.
// Faithful port of headlong_slack.naming (Python).
//
// The name is the only routing metadata that survives the round trip through
// the mind log (`from` on the inbound message step comes back as `to` on the
// reply step), so it has to carry everything needed to deliver the reply:
//
//     DM:              slack-U07AB12CD-D09XYZ123
//     channel/thread:  slack-U07AB12CD-C09XYZ123-1722400000.123456
//
// Outbound, the mind also writes two short forms when it means "post in that
// channel" or "DM that person" rather than "reply in this conversation":
//
//     bare channel:    slack-C09XYZ123      (top-level post in the channel)
//     bare user:       slack-U07AB12CD      (open the DM, post there)
//
// The first letter of a Slack id says what it is: U and W are users, C public
// channels, G private channels, D DM channels. That is what makes the two-part
// forms unambiguous. See design/outbound_delivery.md.
//
// It must match the web API's CHAT_FROM_RE (^[A-Za-z0-9][A-Za-z0-9._-]*$).
// Slack IDs are alphanumeric and thread timestamps are digits.digits, so `-`
// is a safe separator.

export const PREFIX = "slack";

/**
 * The single source of truth for the grammar (upstream NAME_RE_TEXT).
 * `chat`'s SLACK_NAME_RE (src/chat.ts) must be this exact text — a test
 * asserts it, as upstream's test_chat_carries_the_same_grammar does for
 * bin/chat. Stays in the subset JS, Python `re` and bash ERE all accept.
 */
export const NAME_RE_TEXT = "^slack-([UW][A-Z0-9]+|[CGD][A-Z0-9]+|[A-Za-z0-9]+-[A-Za-z0-9]+(-[0-9.]+)?)$";
export const NAME_RE = new RegExp(NAME_RE_TEXT);

export const ACCEPTED_FORMS =
  "slack-<user>-<channel>-<thread ts> (reply in a channel thread), " +
  "slack-<user>-<channel> (a DM, or a channel top-level), " +
  "slack-C<id> (post top-level in a channel), " +
  "slack-U<id> (DM a person)";

export interface Conversation {
  /** "" for a bare channel name */
  user: string;
  /** "" for a bare user name (the DM is opened at delivery time) */
  channel: string;
  /** null for DMs and top-level posts */
  threadTs: string | null;
}

export function encode(user: string, channel: string, threadTs: string | null = null): string {
  const parts = [PREFIX, user, channel];
  if (threadTs !== null) parts.push(threadTs);
  return parts.join("-");
}

export function decode(name: string): Conversation {
  // PORT-NOTE (2e39a3f): upstream decode() now validates with NAME_RE. Python's
  // `$` also matches before a trailing newline, so "slack-U1-C2\n" decodes
  // upstream; JS `$` does not. Such a name cannot come from a chat `to` line.
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`not a slack conversation name: ${JSON.stringify(name)}`);
  }
  const parts = name.split("-");
  if (parts.length === 2) {
    const ident = parts[1]!;
    if (ident[0] === "U" || ident[0] === "W") return { user: ident, channel: "", threadTs: null };
    return { user: "", channel: ident, threadTs: null };
  }
  return {
    user: parts[1]!,
    channel: parts[2]!,
    threadTs: parts.length === 4 ? parts[3]! : null,
  };
}

export function isSlackName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  try {
    decode(name);
  } catch {
    return false;
  }
  return true;
}

/**
 * True for anything that claims to be a Slack name, valid or not.
 *
 * The bridge uses this to tell "ours, but malformed" (warn and write a failed
 * delivery notice) from "another transport's" (skip silently).
 */
export function looksLikeSlack(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(PREFIX + "-");
}
