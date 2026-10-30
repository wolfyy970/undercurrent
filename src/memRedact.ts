// memRedact.ts — `mem add` / `mem edit` credential redaction at the write point
// (upstream sync 2e39a3f, 494fda1 #155: bin/mem mem_redact + mem_redact_cards).
//
// A memory body is written whole into a file that lives for months and is
// quoted into wake prompts and search results, so a pasted token must not land
// in it at all. Pipeline, in the Bash's order: (1) PEM private-key blocks,
// (2) literal values of well-known credential env vars, (3) the credential
// shape rules (sed -E, line by line), (4) payment-card numbers (awk, Luhn).
//
// Differentially tested against upstream's real bin/mem (parity/mem).

/** Thrown where the Bash `die`s inside mem_redact (message printed as `mem: error: <msg>`). */
export class MemRedactError extends Error {}

const BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** Env vars whose VALUE (≥ 8 chars) is masked wherever it appears, in this order. */
const VALUE_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT",
  "ANTHROPIC_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY", "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN", "SLACK_USER_TOKEN", "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN",
  "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN", "DATABASE_URL", "REDIS_URL",
  "LINEAR_API_KEY",
];

// sed -E expressions in the Bash's order. `(^|[^A-Za-z0-9])` prefixes keep a
// capture group that is re-emitted; JS needs per-line ^ (no `m` flag: lines are
// split by the caller, exactly as sed sees them).
type Rule = [RegExp, (...m: string[]) => string];
const RULES: Rule[] = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, () => "<redacted:github-token>"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, () => "<redacted:github-token>"],
  [/xox[a-z]-[A-Za-z0-9_.-]{10,}/g, () => "<redacted:slack-token>"],
  [/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_.=-]{20,}/g, (_m, a = "") => `${a}<redacted:api-key>`],
  [/hf_[A-Za-z0-9]{20,}/g, () => "<redacted:hf-token>"],
  [/AIza[A-Za-z0-9_-]{30,}/g, () => "<redacted:google-key>"],
  [/(AKIA|ASIA)[A-Z0-9]{16}/g, () => "<redacted:aws-key>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, () => "<redacted:jwt>"],
  [/:\/\/[^/@ \t\n\v\f\r]+:[^/@ \t\n\v\f\r]+@/g, () => "://<redacted:basic-auth>@"],
  [/"auth"[ \t\n\v\f\r]*:[ \t\n\v\f\r]*"[A-Za-z0-9+/=]{16,}"/g, () => '"auth": "<redacted:docker-auth>"'],
  [/(^|[^A-Za-z0-9])((sk|rk)_live_[A-Za-z0-9]{8,})/g, (_m, a = "") => `${a}<redacted:stripe-key>`],
  [/(^|[^A-Za-z0-9])(whsec_[A-Za-z0-9]{8,})/g, (_m, a = "") => `${a}<redacted:stripe-hook>`],
  [/(^|[^A-Za-z0-9])(npm_[A-Za-z0-9]{20,})/g, (_m, a = "") => `${a}<redacted:npm-token>`],
  [/(^|[^A-Za-z0-9])(glpat-[A-Za-z0-9_-]{10,})/g, (_m, a = "") => `${a}<redacted:gitlab-token>`],
  [/(^|[^A-Za-z0-9])(dckr_pat-[A-Za-z0-9_.-]{10,})/g, (_m, a = "") => `${a}<redacted:docker-token>`],
  [/(^|[^A-Za-z0-9])(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, (_m, a = "") => `${a}<redacted:sendgrid-key>`],
  [/(^|[^A-Za-z0-9])(SK[0-9a-f]{32})/g, (_m, a = "") => `${a}<redacted:twilio-key>`],
  [/(^|[^A-Za-z0-9])(key-[A-Za-z0-9]{20,})/g, (_m, a = "") => `${a}<redacted:mailgun-key>`],
  [/(((aws|AWS)_secret_access_key)[ \t\n\v\f\r]*[=:][ \t\n\v\f\r]*)[^ \t\n\v\f\r]+/g, (_m, a = "") => `${a}<redacted:aws-secret>`],
];

/** `${s//"$v"/<redacted:value>}` — literal replace-all. */
function replaceAllLiteral(s: string, v: string, by: string): string {
  return s.split(v).join(by);
}

// --- payment cards (mem_redact_cards, awk) ---------------------------------
const CARD_CANDIDATE = /[0-9]{4}(?:[ -][0-9]{4}){3}(?:[ -][0-9]{3})?|[0-9]{4}[ -][0-9]{6}[ -][0-9]{5}|[0-9]{13,19}/;

/** Issuer prefix + length, then Luhn. `s` may carry space/hyphen separators. */
function isCard(raw: string): boolean {
  const s = raw.replace(/[ -]/g, "");
  const n = s.length;
  const prefix = Number(s.slice(0, 4)); // awk: substr(s,1,4) + 0
  const ok =
    (/^4/.test(s) && (n === 13 || n === 16 || n === 19)) ||
    (/^3[47]/.test(s) && n === 15) ||
    (n === 16 && (/^5[1-5]/.test(s) || (prefix >= 2221 && prefix <= 2720))) ||
    ((n === 16 || n === 19) && (/^(6011|65|64[4-9])/.test(s) || (prefix >= 3528 && prefix <= 3589)));
  if (!ok) return false;
  let sum = 0;
  let twice = false;
  for (let i = n; i > 0; i--) {
    let d = Number(s[i - 1]);
    if (twice) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    twice = !twice;
  }
  return sum % 10 === 0;
}

function redactCardsLine(line: string): string {
  let rest = line;
  let out = "";
  for (;;) {
    const m = CARD_CANDIDATE.exec(rest);
    if (!m) break;
    const before = rest.slice(0, m.index);
    let candidate = m[0];
    rest = rest.slice(m.index + candidate.length);
    // A following three-digit code (or next card) is not part of a valid
    // 16-digit PAN just because it shares a separator.
    if (candidate.length === 23 && (!isCard(candidate) || /^[0-9]/.test(rest))) {
      rest = candidate.slice(19) + rest; // awk substr(candidate, 20)
      candidate = candidate.slice(0, 19);
    }
    if (!/[A-Za-z0-9_]$/.test(out + before) && !/^[A-Za-z0-9_]/.test(rest) && isCard(candidate)) {
      candidate = "<redacted:card>";
    }
    out += before + candidate;
  }
  return out + rest;
}

/**
 * mem_redact. `env` supplies the credential env var values. Throws
 * MemRedactError for an incomplete / nested private-key block (the Bash `die`s
 * inside the `$(...)`, then the caller dies again with its own message).
 */
export function memRedact(input: string, env: Record<string, string | undefined>): string {
  let rest = input;
  let s = "";
  for (;;) {
    const m = BEGIN_RE.exec(rest);
    if (!m) break;
    const header = m[0];
    const footer = header.replace("BEGIN", "END");
    const at = rest.indexOf(header);
    s += rest.slice(0, at) + "<redacted:private-key>";
    rest = rest.slice(at + header.length);
    const fAt = rest.indexOf(footer);
    if (fAt < 0) throw new MemRedactError("Incomplete private-key block; memory not written");
    if (rest.slice(0, fAt).includes("-----BEGIN ")) throw new MemRedactError("Nested private-key block; memory not written");
    rest = rest.slice(fAt + footer.length);
  }
  s += rest;

  for (const n of VALUE_VARS) {
    const v = env[n];
    if (v && [...v].length >= 8) s = replaceAllLiteral(s, v, "<redacted:value>");
  }

  const lines = s.split("\n").map((line) => {
    for (const [re, rep] of RULES) line = line.replace(re, rep);
    return redactCardsLine(line);
  });
  // `$(...)` in the caller strips trailing newlines (the pipeline ends in awk's `print`).
  return lines.join("\n").replace(/\n+$/, "");
}
