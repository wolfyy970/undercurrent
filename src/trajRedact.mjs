// trajRedact.mjs — credential redaction at the trajectory write point
// (upstream sync 2e39a3f, 651d49f #191: bin/traj `traj_redact`).
//
// The log is append-only and rewriting it has crashed the dispatcher before, so
// the only safe place to stop a secret is before the line lands. Shape rules cover
// credential formats whatever their origin; value rules cover the tokens this
// machine holds in its environment. The record is walked as DECODED strings (JSON
// escaping must neither hide a configured value nor turn a multiline redaction into
// invalid JSON): every string value, every object KEY, every array element.
//
// Plain ESM JavaScript like trajCore.mjs (the sandboxed `traj` shim imports it
// with no build step). Differentially tested against upstream's real bin/traj
// (parity/traj), which runs jq's Oniguruma regexes where this uses JS RegExp.
//
// PORT-NOTE: jq's `gsub` runs Oniguruma in ONIG_SYNTAX_PERL_NT, where `^`/`$` are
// buffer anchors (`^` = start of string; `$` = end of string OR before a final
// newline, i.e. \Z) and `[[:space:]]` is the Unicode White_Space set. The JS here
// spells both out (SP, `(?=\n?$)`), and uses the `u` flag so an astral character
// is one position, as it is for jq (codepoints).

/** Env vars whose VALUE (>= 8 codepoints) is masked wherever it appears, in this order. */
export const TRAJ_VALUE_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GITHUB_PAT",
  "ANTHROPIC_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY", "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN", "SLACK_USER_TOKEN", "SLACK_TOKEN", "TELEGRAM_BOT_TOKEN",
  "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN", "DATABASE_URL", "REDIS_URL",
];

// Oniguruma [[:space:]] over a UTF-8 string: Unicode White_Space.
const SP = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";

/** Ordered gsub rules (jq program order). Each: [regex (g,u), replacement fn]. */
const RULES = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/gu, () => "<redacted:github-token>"],
  [/github_pat_[A-Za-z0-9_]{20,}/gu, () => "<redacted:github-token>"],
  [/xox[a-z]-[A-Za-z0-9_.-]{10,}/gu, () => "<redacted:slack-token>"],
  [/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_.=-]{20,}/gu, (_m, e) => `${e}<redacted:api-key>`],
  [/hf_[A-Za-z0-9]{20,}/gu, () => "<redacted:hf-token>"],
  [/AIza[A-Za-z0-9_-]{30,}/gu, () => "<redacted:google-key>"],
  [/(AKIA|ASIA)[A-Z0-9]{16}/gu, () => "<redacted:aws-key>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, () => "<redacted:jwt>"],
  [new RegExp(`://[^/@${SP}]+:[^/@${SP}]+@`, "gu"), () => "://<redacted:basic-auth>@"],
  // "p" flag = dot matches newline; `$` = \Z (end, or before a final newline).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=\n?$))/gu, () => "<redacted:private-key>"],
  [new RegExp(`"auth"[${SP}]*:[${SP}]*"[A-Za-z0-9+/=]{16,}"`, "gu"), () => '"auth": "<redacted:docker-auth>"'],
  [/(^|[^A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{8,}/gu, (_m, e) => `${e}<redacted:stripe-key>`],
  [/(^|[^A-Za-z0-9])whsec_[A-Za-z0-9]{8,}/gu, (_m, e) => `${e}<redacted:stripe-hook>`],
  [/(^|[^A-Za-z0-9])npm_[A-Za-z0-9]{20,}/gu, (_m, e) => `${e}<redacted:npm-token>`],
  [/(^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{10,}/gu, (_m, e) => `${e}<redacted:gitlab-token>`],
  [/(^|[^A-Za-z0-9])dckr_pat-[A-Za-z0-9_.-]{10,}/gu, (_m, e) => `${e}<redacted:docker-token>`],
  [/(^|[^A-Za-z0-9])SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, (_m, e) => `${e}<redacted:sendgrid-key>`],
  [/(^|[^A-Za-z0-9])SK[0-9a-f]{32}/gu, (_m, e) => `${e}<redacted:twilio-key>`],
  [/(^|[^A-Za-z0-9])key-[A-Za-z0-9]{20,}/gu, (_m, e) => `${e}<redacted:mailgun-key>`],
  [new RegExp(`((?:aws|AWS)_secret_access_key)[${SP}]*[=:][${SP}]*[^${SP}]+`, "gu"), (_m, name) => `${name}=<redacted:aws-secret>`],
];

const DOCKER_AUTH_VALUE = /^[A-Za-z0-9+/=]{16,}$/u;

/** Values of the configured credential env vars worth masking (>= 8 codepoints). */
export function trajRedactValues(env = process.env) {
  const out = [];
  for (const name of TRAJ_VALUE_VARS) {
    const v = env[name] ?? "";
    if ([...v].length >= 8) out.push(v);
  }
  return out;
}

/** jq `redact_string`: literal VALUE masks first, then the shape rules in order. */
export function redactString(s, values) {
  for (const v of values) s = s.split(v).join("<redacted:value>");
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

/** jq `redact_record`: strings, array elements, and object keys AND values. */
export function redactRecord(x, values) {
  if (typeof x === "string") return redactString(x, values);
  if (Array.isArray(x)) return x.map((e) => redactRecord(e, values));
  if (x !== null && typeof x === "object") {
    const out = {};
    for (const [k0, v0] of Object.entries(x)) {
      const k = redactString(k0, values);
      let v = redactRecord(v0, values);
      if (k === "auth" && typeof v === "string" && DOCKER_AUTH_VALUE.test(v)) v = "<redacted:docker-auth>";
      out[k] = v;
    }
    return out;
  }
  return x;
}
