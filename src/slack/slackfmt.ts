// slackfmt.ts — text conversion between the agent's markdown and Slack.
// Faithful port of headlong_slack.slackfmt (Python).
//
// Deliberately minimal — common markdown the agent emits, nothing close to
// full CommonMark. Fenced and inline code are left untouched.

export const MAX_MESSAGE_CHARS = 3900; // Slack hard limit is ~4000; leave headroom

// Python's ````.*?```|`[^`\n]*`` compiled with re.DOTALL: `.` inside the
// fenced-block alternative must match newlines too. `[\s\S]` is the JS
// equivalent that needs no extra flag.
const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/;
const MENTION_RE = /<@[A-Z0-9]+>/g;

function convertProse(text: string): string {
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>"); // [t](u) -> <u|t>
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*"); // **bold** -> *bold*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // heading -> bold
  text = text.replace(/^(\s*)[*+]\s+/gm, "$1- "); // * item -> - item
  return text;
}

/** Convert agent markdown to Slack mrkdwn, skipping code spans. */
export function toMrkdwn(text: string): string {
  const parts = text.split(CODE_SPLIT_RE);
  return parts.map((p) => (p.startsWith("`") ? p : convertProse(p))).join("");
}

/** Drop a leading 'chat reply <name>' the model echoed into its reply.
 *  The mind-log side also strips this; keeping a bridge-side guard means a
 *  leak never reaches Slack even if an agent-typed reply slips through. */
export function stripLeakedCommand(text: string): string {
  return text.replace(/^\s*chat reply [A-Za-z0-9._-]+\s*/, "");
}

/** Normalize a Slack message body for the mind log. */
export function cleanInbound(text: string, botUserId: string | null = null): string {
  if (botUserId) {
    text = text.split(`<@${botUserId}>`).join("");
  }
  text = text.replace(MENTION_RE, (m) => m.slice(2, -1)); // other mentions -> bare id
  text = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)"); // <url|label>
  text = text.replace(/<(https?:\/\/[^>]+)>/g, "$1"); // <url>
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.trim();
}

/** Split long text at paragraph (then line, then hard) boundaries. */
export function chunk(text: string, limit: number = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < Math.floor(limit / 2)) cut = window.lastIndexOf("\n");
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(remaining.slice(0, cut).replace(/\n+$/, ""));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
