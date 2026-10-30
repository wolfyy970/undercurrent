// logging.ts — keep the bot token out of anything the bridge writes to
// stderr. Faithful port of the token-redaction half of headlong_telegram.cli
// (Python, 44fe2f4).
//
// PORT-NOTE (1c: 44fe2f4): upstream's problem was httpx logging every Bot
// API request URL (which embeds the token: https://api.telegram.org/bot
// <id>:<secret>/<method>) at INFO, writing the token to journald on every
// poll; the fix installs a RedactingFormatter on the root logger and raises
// httpx/httpcore to WARNING unless --verbose. This port has no equivalent
// leak surface: Node's `fetch` does not log requests on its own, and
// `api.ts`'s `Bot.call` deliberately omits the URL from every ApiError/
// HttpError message it constructs (see that file's comment — "the URL is
// left out because it carries the token"), so there is no per-request
// chatter to silence. `redact()` is kept anyway as the same defense-in-depth
// belt Python wears: every stderr write the CLI makes (cli.ts's `io.stderr`)
// is passed through it, so a token-shaped substring can never reach the
// bridge's own log output even if some future code path's error message
// happened to embed one.

const TOKEN_RE = /bot\d+:[A-Za-z0-9_-]+/g;
const REDACTED = "bot<redacted>";

export function redact(text: string): string {
  return text.replace(TOKEN_RE, REDACTED);
}
