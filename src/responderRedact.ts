// responderRedact.ts — the responder's own write-point redactions
// (thinkers/responder/step `_redact_card` and `_redact_keys`, sync 2e39a3f,
// card-in-log incident 2026-09-21 and the person-notes credential rules).
//
// Both are line-oriented `sed -E` programs upstream. They are ported as
// ordered per-line rule lists so `^` is a LINE start and a PEM block is a
// line range, exactly as sed sees it.
//
// PORT-NOTE: POSIX ERE is leftmost-longest, JS is leftmost-first. Every rule
// below is a single greedy run of one character class between fixed anchors,
// where the two agree (differentially checked against the real sed in
// test/responderRedact.test.ts). The `I` flag is JS `i`. The PEM rule is
// `/BEGIN/,/END/c\[redacted]`: BSD sed (the macOS oracle) closes the range on
// a LATER line only and prints the replacement at EOF when it never closes;
// GNU sed prints nothing for an unterminated range. This port follows BSD.

/** `_redact_card`'s five rules, in order. */
const CARD_RULES: Array<[RegExp, string]> = [
  [/[0-9]{4}([ -][0-9]{4}){2,3}/g, "[card redacted]"],
  [/(^|[^0-9A-Za-z])[0-9]{13,19}/g, "$1[card redacted]"],
  [
    /(^|[^0-9A-Za-z])(card|pan|credit|debit|amex|visa|mastercard)[^A-Za-z0-9]{0,8}(the |is |was )?[0-9][0-9 -]{11,27}[0-9]/gi,
    "$1$2 [card redacted]",
  ],
  [/(^|[^0-9A-Za-z])(cvv|cvc|cvv2|csc|security code|sec code)[ :.,=-]*(the |is |was )?[0-9]{3,4}/gi, "$1$2 [redacted]"],
  [
    /(^|[^0-9A-Za-z])(exp|expiry|expiration|expires|good (through|thru))[ :.,=-]*(the |is |was )?[0-9]{1,2}\/[0-9]{2,4}/gi,
    "$1$2 [redacted]",
  ],
];

/** Card, cvv/expiry-shaped digits out; dates, times, confirmation numbers, phones, zips stay. */
export function redactCard(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      for (const [re, rep] of CARD_RULES) line = line.replace(re, rep);
      return line;
    })
    .join("\n");
}

/** Credential env vars whose VALUE (>= 8 chars) `_redact_keys` masks, in order. */
export const REDACT_KEY_ENV_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT",
  "ANTHROPIC_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY", "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN", "SLACK_USER_TOKEN", "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN",
  "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN", "DATABASE_URL", "REDIS_URL",
];

const R = "[redacted]";
// Rules before the PEM range (every line sees them).
const KEY_RULES_BEFORE_PEM: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9._-]+/g, R],
  [/(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_.=-]{12,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{12,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(github_pat_[A-Za-z0-9_]{12,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(xox[a-z]-[A-Za-z0-9_.-]{8,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(hf_[A-Za-z0-9]{12,})/g, `$1${R}`],
  [/AIza[A-Za-z0-9_-]{25,}/g, R],
  [/(AKIA|ASIA)[A-Z0-9]{16}/g, R],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
  [/:\/\/[^/@\s]+:[^/@\s]+@/g, `://${R}@`],
];
// Rules after the PEM range (a line the range swallowed never reaches them).
const KEY_RULES_AFTER_PEM: Array<[RegExp, string]> = [
  [/"auth"\s*:\s*"[A-Za-z0-9+/=]{16,}"/g, `"auth": "${R}"`],
  [/(^|[^A-Za-z0-9])((sk|rk)_live_[A-Za-z0-9]{8,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(whsec_[A-Za-z0-9]{8,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(npm_[A-Za-z0-9]{20,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(glpat-[A-Za-z0-9_-]{10,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(dckr_pat-[A-Za-z0-9_.-]{10,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(SK[0-9a-f]{32})/g, `$1${R}`],
  [/(^|[^A-Za-z0-9])(key-[A-Za-z0-9]{20,})/g, `$1${R}`],
  [/((aws|AWS)_secret_access_key)\s*[=:]\s*[^\s]+/g, `$1=${R}`],
];
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * `_redact_keys`: mask the configured credential env VALUES literally
 * (`${s//"$v"/[redacted]}`, values of 8+ chars), then the shapes that arrive as
 * text, then `_redact_card`. Person notes are model output summarising a
 * conversation, and a conversation can contain a pasted credential.
 */
export function redactKeys(input: string, env: Record<string, string | undefined> = process.env): string {
  let s = input;
  for (const n of REDACT_KEY_ENV_VARS) {
    const v = env[n] ?? "";
    if (v !== "" && Buffer.byteLength(v) >= 8) s = s.split(v).join(R);
  }
  const out: string[] = [];
  let inPem = false;
  let swallowed = false;
  for (let line of s.split("\n")) {
    for (const [re, rep] of KEY_RULES_BEFORE_PEM) line = line.replace(re, rep);
    if (inPem) {
      swallowed = true;
      if (PEM_END.test(line)) {
        inPem = false;
        swallowed = false;
        out.push(R);
      }
      continue;
    }
    if (PEM_BEGIN.test(line)) {
      inPem = true; // the end address is only looked for on a LATER line
      swallowed = true;
      continue;
    }
    for (const [re, rep] of KEY_RULES_AFTER_PEM) line = line.replace(re, rep);
    out.push(line);
  }
  if (inPem && swallowed) out.push(R); // BSD sed: an unterminated range prints its `c` text at EOF
  return redactCard(out.join("\n"));
}
