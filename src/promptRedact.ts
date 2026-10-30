// promptRedact.ts — credential redaction at the wake-prompt boundary
// (upstream sync 2e39a3f: thinkers/_lib/common.sh `prompt_redact`, monolith/step).
//
// The recent stream, the outbound ledger and the routing signals quote the mind
// log verbatim, so one pasted token would be re-quoted into every later prompt
// covering its window. The write-point redaction (src/trajRedact.mjs) never
// rewrites what the log already holds; this is the second layer that stops it at
// the prompt, for good.
//
// PORT-NOTE: upstream runs one jq program (Oniguruma, ONIG_SYNTAX_PERL_NT). This
// is the same program in JS, with the same differences trajRedact.mjs documents:
// `^` is the buffer start, `$` is the end or before a final newline, and
// `[[:space:]]` is Unicode White_Space (spelled out below). Differences from
// trajRedact.mjs's rules, both taken straight from upstream: three payment-card
// shapes sit after the sk- rule, and private keys are handled in two whole-text
// passes (plus a per-field pass for JSON lines) instead of one range rule, so an
// unterminated block can never swallow the prompt sections that follow it.
// PORT-NOTE: only JSON lines whose redaction CHANGED something are re-serialised
// (upstream's `$clean == $record` test); an untouched line is returned byte for
// byte. JSON.stringify and jq's `tojson` agree on everything except U+007F
// (jq escapes it), which the differential in parity/prompt records.

import { trajRedactValues } from "./trajRedact.mjs";

const SP = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const EDGE = "(^|[^A-Za-z0-9])";

type Rule = [RegExp, (...m: string[]) => string];

const SHAPE_RULES: Rule[] = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/gu, () => "<redacted:github-token>"],
  [/github_pat_[A-Za-z0-9_]{20,}/gu, () => "<redacted:github-token>"],
  [/xox[a-z]-[A-Za-z0-9_.-]{10,}/gu, () => "<redacted:slack-token>"],
  [new RegExp(`${EDGE}sk-[A-Za-z0-9_.=-]{20,}`, "gu"), (_m, e) => `${e}<redacted:api-key>`],
  // Card shapes: spaced/dashed groups, bare 15-16 digits, and a label followed by digits.
  [/(^|[^0-9])[0-9]{4}(?:[ -][0-9]{4}){2,3}([^0-9]|$)/gu, (_m, e, end) => `${e}<redacted:card>${end}`],
  [/(^|[^0-9A-Za-z])[0-9]{15,16}([^0-9]|$)/gu, (_m, e, end) => `${e}<redacted:card>${end}`],
  [
    /(^|[^0-9A-Za-z])(card|pan|credit|debit|amex|visa|mastercard)[^A-Za-z0-9]{0,8}(?:the |is |was )?[0-9][0-9 -]{11,27}[0-9]/giu,
    (_m, e, label) => `${e}${label} <redacted:card>`,
  ],
  [/hf_[A-Za-z0-9]{20,}/gu, () => "<redacted:hf-token>"],
  [/AIza[A-Za-z0-9_-]{30,}/gu, () => "<redacted:google-key>"],
  [/(AKIA|ASIA)[A-Z0-9]{16}/gu, () => "<redacted:aws-key>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, () => "<redacted:jwt>"],
  [new RegExp(`://[^/@${SP}]+:[^/@${SP}]+@`, "gu"), () => "://<redacted:basic-auth>@"],
  [new RegExp(`"auth"[${SP}]*:[${SP}]*"[A-Za-z0-9+/=]{16,}"`, "gu"), () => '"auth": "<redacted:docker-auth>"'],
  [new RegExp(`${EDGE}(?:sk|rk)_live_[A-Za-z0-9]{8,}`, "gu"), (_m, e) => `${e}<redacted:stripe-key>`],
  [new RegExp(`${EDGE}whsec_[A-Za-z0-9]{8,}`, "gu"), (_m, e) => `${e}<redacted:stripe-hook>`],
  [new RegExp(`${EDGE}npm_[A-Za-z0-9]{20,}`, "gu"), (_m, e) => `${e}<redacted:npm-token>`],
  [new RegExp(`${EDGE}glpat-[A-Za-z0-9_-]{10,}`, "gu"), (_m, e) => `${e}<redacted:gitlab-token>`],
  [new RegExp(`${EDGE}dckr_pat-[A-Za-z0-9_.-]{10,}`, "gu"), (_m, e) => `${e}<redacted:docker-token>`],
  [new RegExp(`${EDGE}SG\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, "gu"), (_m, e) => `${e}<redacted:sendgrid-key>`],
  [new RegExp(`${EDGE}SK[0-9a-f]{32}`, "gu"), (_m, e) => `${e}<redacted:twilio-key>`],
  [new RegExp(`${EDGE}key-[A-Za-z0-9]{20,}`, "gu"), (_m, e) => `${e}<redacted:mailgun-key>`],
  [
    new RegExp(`((?:aws|AWS)_secret_access_key)[${SP}]*[=:][${SP}]*[^${SP}]+`, "gu"),
    (_m, name) => `${name}=<redacted:aws-secret>`,
  ],
];

// A decoded field is a safe boundary for an incomplete block: the range runs to
// the END marker or the end of the string (`$` = \Z).
const FIELD_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=\n?$))/gu;
// Whole-text passes: a complete block (never spanning another BEGIN), then an
// unterminated one consumes only base64-looking body lines.
const TEXT_PEM_COMPLETE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const TEXT_PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\r\n]*(?:\r?\n[A-Za-z0-9+/=]+(?=\r?\n|$))*/gu;
const DOCKER_AUTH_VALUE = /^[A-Za-z0-9+/=]{16,}$/u;

function redactString(s: string, values: string[]): string {
  for (const v of values) s = s.split(v).join("<redacted:value>");
  for (const [re, rep] of SHAPE_RULES) s = s.replace(re, rep as (...a: string[]) => string);
  return s;
}

function redactRecord(x: unknown, values: string[]): unknown {
  if (typeof x === "string") return redactString(x.replace(FIELD_PEM, "<redacted:private-key>"), values);
  if (Array.isArray(x)) return x.map((e) => redactRecord(e, values));
  if (x !== null && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k0, v0] of Object.entries(x as Record<string, unknown>)) {
      const k = redactString(k0, values);
      let v = redactRecord(v0, values);
      if (k === "auth" && typeof v === "string" && DOCKER_AUTH_VALUE.test(v)) v = "<redacted:docker-auth>";
      out[k] = v;
    }
    return out;
  }
  return x;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Scrub credentials out of a wake prompt (jq `prompt_redact`). */
export function promptRedact(prompt: string, env: Record<string, string | undefined> = process.env): string {
  const values = trajRedactValues(env);
  const lines = prompt.split("\n").map((line) => {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return line;
    }
    if (rec === null || typeof rec !== "object") return line;
    const clean = redactRecord(rec, values);
    return sameJson(clean, rec) ? line : JSON.stringify(clean);
  });
  let out = lines.join("\n");
  out = out.replace(TEXT_PEM_COMPLETE, "<redacted:private-key>");
  out = out.replace(TEXT_PEM_OPEN, "<redacted:private-key>");
  return redactString(out, values);
}
