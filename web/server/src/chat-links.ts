// Resolve source links shared by the chat and mind log views.
// Port of headlong/web/src/headlong_web/chat_links.py (Apache-2.0).
//
// PORT-NOTE (1c: f68c1d8): a reply carries no Slack permalink of its own —
// only the inbound message it answers does. resolveSourceUrl lets both
// chatView (chat.ts) and the trajectory normalizer (trajectory.ts) inherit
// the ORIGINAL message's permalink onto every reply in the chain, keyed by
// step_id so the lookup works however far back the reply_to chain runs.

type Raw = Record<string, unknown>;

/** Return a message's own source URL, or (if it has none) the URL recorded
 *  for the message it replies to. Records this message's resolved URL under
 *  its own step_id in `known` so a later reply to THIS message inherits it
 *  too. */
export function resolveSourceUrl(message: Raw, known: Record<string, string>): string | null {
  let sourceUrl = message["source_url"];
  const replyTo = message["reply_to"];
  if ((typeof sourceUrl !== "string" || sourceUrl === "") && typeof replyTo === "string") {
    sourceUrl = known[replyTo];
  }
  if (typeof sourceUrl !== "string" || sourceUrl === "") return null;
  const stepId = message["step_id"];
  if (typeof stepId === "string" && stepId !== "") known[stepId] = sourceUrl;
  return sourceUrl;
}
