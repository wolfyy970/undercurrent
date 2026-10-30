// push.ts — port of headlong_web/push.py: VAPID keys, a subscription store,
// and a mind-log watcher that pushes chat messages to subscribed browsers.
//
// Keys and subscriptions live under <root>/.web-push (gitignored). Keys are
// generated on first use and die with the box — installed apps simply
// re-subscribe. Subscriptions are name-scoped ("pwa-nick"), not identity
// scoped: any identity messaging that name triggers a push.
//
// Content encryption (RFC 8291 aes128gcm) and VAPID JWT signing (RFC 8292,
// ES256) are in ./webpushCrypto.ts — this file is push.py's own business
// logic (store I/O, subscription upsert, the watcher loop), unchanged in
// shape from upstream.

import * as fs from "node:fs";
import { join } from "node:path";
import { scanIdentities, findRootTrajDir } from "./discovery.ts";
import { loadVapidPrivateKey, generateVapidPrivateKeyPem, vapidPublicKeyB64Url, vapidAuthorizationHeader, encryptAes128gcm } from "./webpushCrypto.ts";

const STORE_DIR = ".web-push";
const VAPID_PEM = "vapid_private.pem";
const SUBSCRIPTIONS = "subscriptions.json";
// Only the phone client's namespace is subscribable; slack-* stays Slack's.
export const SUBSCRIBABLE_PREFIX = "pwa-";
const BODY_LIMIT = 160;

/** `headlong_web/env.py getenv`: HEADLONG_* canonical, SHELLM_* fallback
 *  (duplicated locally, matching this port's existing per-file convention —
 *  see thinker-sync.ts's own copy). */
function getenv(name: string): string | undefined {
  if (name in process.env) return process.env[name];
  const legacy = name.replace("HEADLONG_", "SHELLM_");
  if (legacy !== name && legacy in process.env) return process.env[legacy];
  return undefined;
}

function storeDir(root: string): string {
  const dir = join(root, STORE_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function vapidPemPath(root: string): string {
  return join(storeDir(root), VAPID_PEM);
}

/** b64url application-server key for PushManager.subscribe; generates the
 *  keypair on first call. Synchronous fs calls throughout this module mean
 *  the check-then-write below can't race within one process, matching the
 *  effect of upstream's `threading.Lock()` (which only protects against
 *  concurrent Python threads — this port has none). */
export function vapidPublicKey(root: string): string {
  const pemPath = vapidPemPath(root);
  let pem: string;
  if (fs.existsSync(pemPath)) {
    pem = fs.readFileSync(pemPath, "utf-8");
  } else {
    pem = generateVapidPrivateKeyPem();
    fs.writeFileSync(pemPath, pem);
    fs.chmodSync(pemPath, 0o600);
  }
  return vapidPublicKeyB64Url(loadVapidPrivateKey(pem));
}

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  [k: string]: unknown;
}
export interface StoredSubscription {
  name: string;
  subscription: PushSubscriptionInfo;
}

function subsPath(root: string): string {
  return join(storeDir(root), SUBSCRIPTIONS);
}

export function loadSubscriptions(root: string): StoredSubscription[] {
  const path = subsPath(root);
  if (!fs.existsSync(path)) return [];
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path, "utf-8"));
    return Array.isArray(data) ? (data as StoredSubscription[]) : [];
  } catch {
    return [];
  }
}

/** `_save_subscriptions`: `Path("subscriptions.json").with_suffix(".tmp")`
 *  REPLACES the suffix (-> "subscriptions.tmp", not "subscriptions.json.tmp"). */
function saveSubscriptions(root: string, subs: StoredSubscription[]): void {
  const path = subsPath(root);
  const tmp = join(storeDir(root), "subscriptions.tmp");
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, path);
}

/** Upsert by endpoint; returns the subscription count for the name. */
export function addSubscription(root: string, name: string, subscription: PushSubscriptionInfo): number {
  const endpoint = subscription.endpoint ?? "";
  const subs = loadSubscriptions(root).filter((s) => s.subscription?.endpoint !== endpoint);
  subs.push({ name, subscription });
  saveSubscriptions(root, subs);
  return subs.filter((s) => s.name === name).length;
}

export function removeSubscription(root: string, endpoint: string): boolean {
  const subs = loadSubscriptions(root);
  const kept = subs.filter((s) => s.subscription?.endpoint !== endpoint);
  if (kept.length === subs.length) return false;
  saveSubscriptions(root, kept);
  return true;
}

/** Which subscriptions a mind-log step should push to. */
export function notificationsFor(step: Record<string, unknown>, subs: StoredSubscription[]): StoredSubscription[] {
  if (step["type"] !== "message") return [];
  const toName = typeof step["to"] === "string" ? step["to"] : "";
  if (!toName.startsWith(SUBSCRIBABLE_PREFIX) || !step["content"]) return [];
  return subs.filter((s) => s.name === toName);
}

/** Python `f"...{x}"` on `None` renders the literal text "None" — step["to"]
 *  is always a real string by the time notificationsFor let a step through,
 *  but buildPayload is also directly unit-testable, so reproduce the quirk. */
function pyStr(x: unknown): string {
  return x === null || x === undefined ? "None" : String(x);
}

export function buildPayload(step: Record<string, unknown>, identityId: string): string {
  let content = typeof step["content"] === "string" ? step["content"] : step["content"] ? String(step["content"]) : "";
  if (content.length > BODY_LIMIT) content = `${content.slice(0, BODY_LIMIT - 1)}…`;
  return JSON.stringify({
    title: step["from"] || "shellm",
    body: content,
    url: `/talk/${identityId}`,
    tag: `${identityId}:${pyStr(step["to"])}`,
  });
}

// ---------------------------------------------------------------------------
// Sending — port of pywebpush's `webpush()` one-call function, scoped to
// exactly what push.py's own `_send` uses: aes128gcm, ttl=0, a single
// `{sub: ...}` claim (aud/exp always computed here, never passed in).
// ---------------------------------------------------------------------------

export class WebPushError extends Error {
  readonly statusCode: number | null;
  constructor(message: string, statusCode: number | null) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface SendWebPushOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** POSTs an encrypted push to one subscription's endpoint. Throws
 *  `WebPushException` (`WebPushError`, here) when `status > 202` — matching
 *  pywebpush's own (slightly unusual, but faithfully reproduced) check. */
export async function sendWebPush(
  subscription: PushSubscriptionInfo,
  payload: string,
  vapidPrivateKeyPem: string,
  vapidSub: string,
  opts: SendWebPushOptions = {}
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? ((): Date => new Date());
  const privateKey = loadVapidPrivateKey(vapidPrivateKeyPem);
  const endpointUrl = new URL(subscription.endpoint);
  const aud = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const exp = Math.floor(now().getTime() / 1000) + 12 * 60 * 60; // "encryption lives for 12 hours"
  const authorization = vapidAuthorizationHeader({ sub: vapidSub, aud, exp }, privateKey);

  const receiverPubRaw = Buffer.from(subscription.keys.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");
  const body = encryptAes128gcm(Buffer.from(payload, "utf-8"), receiverPubRaw, authSecret);

  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Encoding": "aes128gcm", TTL: "0" },
    body,
  });
  if (res.status > 202) {
    throw new WebPushError(`Push failed: ${res.status} ${res.statusText}`, res.status);
  }
  return res;
}

// ---------------------------------------------------------------------------
// PushWatcher — tails every identity's root mind log and pushes messages
// addressed to subscribed pwa-* names. Byte-offset cursors start at
// end-of-file so a restart never replays history. `setInterval`-driven
// (this port's stand-in for upstream's daemon `threading.Thread`).
// ---------------------------------------------------------------------------

export interface PushWatcherOptions {
  pollMs?: number;
  rescanMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Tick failures are swallowed (matching upstream's `except Exception:
   *  log.exception(...)` — "the watcher must survive"); surfaced here
   *  instead of only to a logger, so tests can assert on them. */
  onError?: (e: unknown) => void;
}
export interface PushWatcherHandle {
  stop(): void;
  /** Test-only: run one tick synchronously-awaited, bypassing the poll timer. */
  tick(): Promise<void>;
}

export function startPushWatcher(root: string, opts: PushWatcherOptions = {}): PushWatcherHandle {
  const pollMs = opts.pollMs ?? 1000;
  const rescanMs = opts.rescanMs ?? 30000;
  const cursors = new Map<string, { identityId: string; offset: number }>();
  let lastScan = 0;

  function rescan(): void {
    lastScan = Date.now();
    for (const identity of scanIdentities(root)) {
      const trajDir = findRootTrajDir(identity);
      if (trajDir === null) continue;
      const traj = join(trajDir, "trajectory.jsonl");
      if (cursors.has(traj)) continue;
      let size: number;
      try {
        size = fs.statSync(traj).size;
      } catch {
        continue;
      }
      cursors.set(traj, { identityId: identity.id, offset: size });
    }
  }

  async function send(targets: StoredSubscription[], payload: string): Promise<void> {
    const pemPath = vapidPemPath(root);
    if (!fs.existsSync(pemPath)) return; // no keys yet means nothing ever subscribed via this box
    const pem = fs.readFileSync(pemPath, "utf-8");
    const vapidSub = getenv("HEADLONG_VAPID_SUB") ?? "mailto:admin@example.com";
    for (const target of targets) {
      try {
        await sendWebPush(target.subscription, payload, pem, vapidSub, { fetchImpl: opts.fetchImpl, now: opts.now });
      } catch (e) {
        if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) {
          removeSubscription(root, target.subscription.endpoint);
        } else {
          opts.onError?.(e);
        }
      }
    }
  }

  async function drain(traj: string): Promise<void> {
    const cur = cursors.get(traj);
    if (!cur) return;
    let size: number;
    try {
      size = fs.statSync(traj).size;
    } catch {
      return;
    }
    if (size < cur.offset) {
      // A rebuilt or truncated trajectory must not leave the cursor beyond EOF
      // forever (089da9b). As on first discovery, skip existing history so the
      // replacement log does not replay old pushes.
      cursors.set(traj, { identityId: cur.identityId, offset: size });
      return;
    }
    if (size === cur.offset) return;
    const fd = fs.openSync(traj, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - cur.offset);
      fs.readSync(fd, chunk, 0, chunk.length, cur.offset);
    } finally {
      fs.closeSync(fd);
    }
    // Only consume complete lines; a partially-written line stays for the next poll.
    const end = chunk.lastIndexOf(0x0a);
    if (end < 0) return;
    cursors.set(traj, { identityId: cur.identityId, offset: cur.offset + end + 1 });
    const subs = loadSubscriptions(root);
    if (subs.length === 0) return;
    const lines = chunk
      .subarray(0, end + 1)
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    for (const line of lines) {
      let step: Record<string, unknown>;
      try {
        step = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const targets = notificationsFor(step, subs);
      if (targets.length > 0) await send(targets, buildPayload(step, cur.identityId));
    }
  }

  async function tick(): Promise<void> {
    if (Date.now() - lastScan > rescanMs) rescan();
    for (const traj of [...cursors.keys()]) await drain(traj);
  }

  rescan();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    tick().catch((e: unknown) => opts.onError?.(e));
  }, pollMs);
  timer.unref?.(); // never keep the process alive on its own

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
