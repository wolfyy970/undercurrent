// Chat view over the mind log: message steps + reply outcomes.
// Port of headlong/web/src/headlong_web/chat.py (Apache-2.0).

import { CHAT_MESSAGE_TYPES } from "./trajectory.ts";
import { resolveSourceUrl } from "./chat-links.ts";

type Raw = Record<string, unknown>;

export interface ChatMessage {
  ts: string | null;
  step_id: string | null;
  from: string;
  to: string;
  content: string;
  reply_to: string | null;
  filename: string | null;
  source_url: string | null;
}

export interface ChatView {
  messages: ChatMessage[];
  outcomes: Record<string, string>;
}

/** `steps` is the normalizer's compact chat index (message steps plus
 * trigger-stamped observations). Returns the last `tail` messages plus a
 * map of sent-step-id -> outcome ("replied" | "no-reply" | "failed"). */
export function chatView(
  steps: Raw[],
  identityName: string,
  tail = 200,
  withName: string | null = null,
): ChatView {
  const messages: ChatMessage[] = [];
  const outcomes: Record<string, string> = {};
  // PORT-NOTE (1c: f68c1d8): source_url resolution mirrors resolve_source_url
  // in chat_links.py — a reply inherits the Slack permalink of the message
  // it answers. This map is scoped to one chatView() call, same as upstream.
  const sourceUrls: Record<string, string> = {};
  for (const raw of steps) {
    const stepType = raw["type"];
    if (stepType === "observation") {
      const trigger = raw["trigger_step"] as string | undefined;
      if (trigger) {
        if (raw["decision"] === "no-reply") outcomes[trigger] = "no-reply";
        else if (String(raw["content"] ?? "").startsWith("reply failed"))
          outcomes[trigger] = "failed";
      }
      continue;
    }
    if (typeof stepType !== "string" || !CHAT_MESSAGE_TYPES.has(stepType)) continue;
    const content = raw["content"];
    if (!content) continue;
    let fromName: string;
    let toName: string;
    if (stepType === "message") {
      fromName = (raw["from"] as string) || "unknown";
      toName = (raw["to"] as string) || "";
    } else if (stepType === "human-msg") {
      fromName = (raw["from"] as string) || "you";
      toName = identityName;
    } else {
      fromName = identityName;
      toName = (raw["to"] as string) || "";
    }
    const replyTo = (raw["reply_to"] as string | undefined) ?? null;
    if (replyTo) outcomes[replyTo] = "replied";
    const sourceUrl = resolveSourceUrl(raw, sourceUrls);
    if (withName !== null && withName !== fromName && withName !== toName) continue;
    messages.push({
      ts: (raw["ts"] as string | undefined) ?? null,
      step_id: (raw["step_id"] as string | undefined) ?? null,
      from: fromName,
      to: toName,
      content: content as string,
      reply_to: replyTo,
      filename: (raw["filename"] as string | undefined) ?? null,
      source_url: sourceUrl,
    });
  }
  return { messages: messages.slice(-tail), outcomes };
}
