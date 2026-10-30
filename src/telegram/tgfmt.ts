// tgfmt.ts — text conversion between the agent's markdown and Telegram.
// Faithful port of headlong_telegram.tgfmt (Python).
//
// Outbound targets Telegram's HTML parse mode (MarkdownV2's escaping rules
// are a minefield). Deliberately minimal — common markdown the agent emits,
// nothing close to full CommonMark.

export const MAX_MESSAGE_CHARS = 3900; // Telegram hard limit is 4096; leave headroom
export const MAX_INBOUND_CHARS = 4000; // cap what one message can inject into the mind log

// Python's ````.*?```|`[^`\n]*`` compiled with re.DOTALL: `.` inside the
// fenced-block alternative must match newlines too. `[\s\S]` is the JS
// equivalent that needs no extra flag.
const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** `html.escape(text, quote=False)`: only &, <, > — not quotes. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertProse(text: string): string {
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^(\s*)[*+]\s+/gm, "$1- ");
  return text;
}

function convertCode(span: string): string {
  if (span.startsWith("```")) {
    let body = span.slice(3, -3);
    const nl = body.indexOf("\n");
    body = nl >= 0 ? body.slice(nl + 1) : body; // drop language tag
    return `<pre>${escapeHtml(body)}</pre>`;
  }
  return `<code>${escapeHtml(span.slice(1, -1))}</code>`;
}

/** Convert agent markdown to Telegram HTML, code spans preserved. */
export function toHtml(text: string): string {
  const parts = text.split(CODE_SPLIT_RE);
  return parts.map((p) => (p.startsWith("`") ? convertCode(p) : convertProse(p))).join("");
}

/** Drop a leading 'chat reply <name>' the model echoed into its reply.
 *  Same bridge-side guard as the Slack bridge: a leak never reaches the
 *  phone even if an agent-typed reply slips through. */
export function stripLeakedCommand(text: string): string {
  return text.replace(/^\s*chat reply [A-Za-z0-9._-]+\s*/, "");
}

/** Normalize a Telegram message body for the mind log. */
export function cleanInbound(text: string): string {
  text = text.trim();
  if (text.length > MAX_INBOUND_CHARS) {
    text = text.slice(0, MAX_INBOUND_CHARS) + " …(truncated by bridge)";
  }
  return text;
}

export interface TelegramUser {
  id?: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
  [key: string]: unknown;
}

/** One-line display label for a Telegram user object.
 *
 * The parts are attacker-controlled strings headed for the admin's approval
 * prompt and the mind-log header — collapse whitespace and cap the length so
 * a hostile display name can't spread across lines. */
export function senderLabel(user: TelegramUser): string {
  const first = user.first_name ?? "";
  const last = user.last_name ?? "";
  let name = [first, last].filter((p) => p).join(" ");
  if (user.username) {
    name = name ? `${name} (@${user.username})` : `@${user.username}`;
  }
  name = name.replace(/\s+/g, " ").trim();
  const truncated = name.slice(0, 64);
  if (truncated) return truncated;
  return "id" in user ? String(user.id) : "?";
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
