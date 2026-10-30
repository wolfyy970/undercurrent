// Path/name safety guards for the control-plane mutation routes.
// Port of headlong/web/src/headlong_web/safety.py (Apache-2.0) — only the
// pieces the Slice A/B routes need; THINKER_NAME_RE/IDENTITY_NAME_RE/
// CHAT_FROM_RE are byte-identical to upstream's patterns.

import { resolve, relative, isAbsolute } from "node:path";

// Underscores allowed: existing thinkers (inner_monologue, ...) use them even
// though `thinkers new` only scaffolds hyphenated names.
export const THINKER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Same rule `identity new` enforces (src/identity.ts IDENTITY_NAME_RE).
export const IDENTITY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const CHAT_FROM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Resolve base/parts and require the result to stay inside base (safety.py contained_path). */
export function containedPath(base: string, ...parts: string[]): string | null {
  const baseResolved = resolve(base);
  const resolved = resolve(baseResolved, ...parts);
  if (resolved === baseResolved) return resolved;
  const rel = relative(baseResolved, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

export function checkedName(name: string, pattern: RegExp): boolean {
  return pattern.test(name);
}

/** Accept only Slack HTTPS archive links as chat source metadata.
 *  PORT-NOTE (1c: f68c1d8): safety.py's is_slack_permalink, byte-identical
 *  gate (scheme/host/path) — this is what `POST .../chat`'s `source_url`
 *  body field is validated against before it reaches `chat send --source-url`. */
export function isSlackPermalink(value: string): boolean {
  if (!value || value.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    (host === "slack.com" || host.endsWith(".slack.com")) &&
    parsed.pathname.startsWith("/archives/")
  );
}
