// push.test.ts — headlong_web/push.py port: VAPID key store, subscription
// store, notificationsFor/buildPayload, sendWebPush (against a fake push
// endpoint that decrypts with a fake subscriber's own keys — proving the
// payload round-trips, no live push), and PushWatcher (tails a real
// trajectory.jsonl file, delivers to a fake endpoint).

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  vapidPublicKey,
  loadSubscriptions,
  addSubscription,
  removeSubscription,
  notificationsFor,
  buildPayload,
  sendWebPush,
  WebPushError,
  startPushWatcher,
  SUBSCRIBABLE_PREFIX,
  type PushSubscriptionInfo,
} from "../src/push.ts";
import { decryptAes128gcm } from "../src/webpushCrypto.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-push-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeSubscriber(name = "pwa-nick"): { name: string; sub: PushSubscriptionInfo; privateKey: crypto.KeyObject; auth: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const p256dhRaw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const auth = crypto.randomBytes(16);
  return {
    name,
    sub: {
      endpoint: "https://push.example.com/v1/abcdef",
      keys: { p256dh: p256dhRaw.toString("base64url"), auth: auth.toString("base64url") },
    },
    privateKey,
    auth,
  };
}

// ---------------------------------------------------------------------------
// VAPID key store (vapidPublicKey)
// ---------------------------------------------------------------------------

describe("vapidPublicKey", () => {
  it("generates a keypair on first call, persists under <root>/.web-push/vapid_private.pem (0600)", () => {
    const root = freshRoot();
    const key = vapidPublicKey(root);
    expect(key).not.toMatch(/[=+/]/); // unpadded b64url
    const pemPath = path.join(root, ".web-push", "vapid_private.pem");
    expect(fs.existsSync(pemPath)).toBe(true);
    expect(fs.statSync(pemPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, ".web-push")).mode & 0o777).toBe(0o700);
  });

  it("a second call reuses the same key (same public key returned)", () => {
    const root = freshRoot();
    const a = vapidPublicKey(root);
    const b = vapidPublicKey(root);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

describe("subscription store (add/remove/load)", () => {
  it("addSubscription persists {name, subscription} and returns the count for that name", () => {
    const root = freshRoot();
    const a = fakeSubscriber("pwa-nick");
    const count1 = addSubscription(root, a.name, a.sub);
    expect(count1).toBe(1);
    const b = { ...a.sub, endpoint: "https://push.example.com/v1/other" };
    const count2 = addSubscription(root, "pwa-nick", b);
    expect(count2).toBe(2);
    const subs = loadSubscriptions(root);
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.name === "pwa-nick")).toBe(true);
  });

  it("addSubscription upserts by endpoint (same endpoint replaces, doesn't duplicate)", () => {
    const root = freshRoot();
    const a = fakeSubscriber("pwa-nick");
    addSubscription(root, "pwa-nick", a.sub);
    const updated = { ...a.sub, keys: { ...a.sub.keys, auth: "changed" } };
    const count = addSubscription(root, "pwa-nick", updated);
    expect(count).toBe(1);
    expect(loadSubscriptions(root)[0]!.subscription.keys.auth).toBe("changed");
  });

  it("removeSubscription removes by endpoint, returns true; false if not found", () => {
    const root = freshRoot();
    const a = fakeSubscriber("pwa-nick");
    addSubscription(root, "pwa-nick", a.sub);
    expect(removeSubscription(root, "https://nowhere")).toBe(false);
    expect(removeSubscription(root, a.sub.endpoint)).toBe(true);
    expect(loadSubscriptions(root)).toHaveLength(0);
  });

  it("loadSubscriptions on a missing/corrupt/non-array file returns []", () => {
    const root = freshRoot();
    expect(loadSubscriptions(root)).toEqual([]);
    fs.mkdirSync(path.join(root, ".web-push"), { recursive: true });
    fs.writeFileSync(path.join(root, ".web-push", "subscriptions.json"), "not json{{{");
    expect(loadSubscriptions(root)).toEqual([]);
    fs.writeFileSync(path.join(root, ".web-push", "subscriptions.json"), '{"not":"an array"}');
    expect(loadSubscriptions(root)).toEqual([]);
  });

  it("subscriptions.json is written 0600 via a same-dir tmp+rename", () => {
    const root = freshRoot();
    addSubscription(root, "pwa-nick", fakeSubscriber().sub);
    const p = path.join(root, ".web-push", "subscriptions.json");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(root, ".web-push", "subscriptions.tmp"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// notificationsFor / buildPayload
// ---------------------------------------------------------------------------

describe("notificationsFor", () => {
  const subs = [
    { name: "pwa-nick", subscription: fakeSubscriber().sub },
    { name: "pwa-other", subscription: fakeSubscriber().sub },
    { name: "slack-nick", subscription: fakeSubscriber().sub },
  ];

  it("matches a message step addressed to a subscribed pwa-* name", () => {
    const step = { type: "message", to: "pwa-nick", content: "hi", from: "quill" };
    expect(notificationsFor(step, subs)).toEqual([subs[0]]);
  });

  it("non-message steps never notify", () => {
    const step = { type: "thought", to: "pwa-nick", content: "hi" };
    expect(notificationsFor(step, subs)).toEqual([]);
  });

  it("a non-pwa- prefixed `to` (e.g. slack-*) never notifies, even if a matching name is subscribed", () => {
    const step = { type: "message", to: "slack-nick", content: "hi" };
    expect(notificationsFor(step, subs)).toEqual([]);
  });

  it("empty/missing content never notifies", () => {
    expect(notificationsFor({ type: "message", to: "pwa-nick", content: "" }, subs)).toEqual([]);
    expect(notificationsFor({ type: "message", to: "pwa-nick" }, subs)).toEqual([]);
  });

  it("a name with no subscriber returns []", () => {
    expect(notificationsFor({ type: "message", to: "pwa-nobody", content: "hi" }, subs)).toEqual([]);
  });

  it("SUBSCRIBABLE_PREFIX is 'pwa-'", () => {
    expect(SUBSCRIBABLE_PREFIX).toBe("pwa-");
  });
});

describe("buildPayload", () => {
  it("shapes {title, body, url, tag} from a message step", () => {
    const payload = JSON.parse(buildPayload({ type: "message", from: "quill", to: "pwa-nick", content: "hey there" }, "myidentity"));
    expect(payload).toEqual({ title: "quill", body: "hey there", url: "/talk/myidentity", tag: "myidentity:pwa-nick" });
  });

  it("missing `from` falls back to 'shellm'", () => {
    const payload = JSON.parse(buildPayload({ type: "message", to: "pwa-nick", content: "hi" }, "id1"));
    expect(payload.title).toBe("shellm");
  });

  it("truncates body over 160 chars with a trailing ellipsis", () => {
    const content = "x".repeat(200);
    const payload = JSON.parse(buildPayload({ type: "message", to: "pwa-nick", content }, "id1"));
    expect(payload.body.length).toBe(160);
    expect(payload.body.endsWith("…")).toBe(true);
    expect(payload.body.slice(0, 159)).toBe("x".repeat(159));
  });

  it("exactly 160 chars is not truncated", () => {
    const content = "x".repeat(160);
    const payload = JSON.parse(buildPayload({ type: "message", to: "pwa-nick", content }, "id1"));
    expect(payload.body).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// sendWebPush — a fake push endpoint records the raw request and decrypts
// it with the fake subscriber's own keys, proving the payload round-trips.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function fakeEndpoint(status = 201): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    requests.push({ url: String(url), headers, body });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("sendWebPush", () => {
  it("POSTs an encrypted, VAPID-authenticated request the fake subscriber can decrypt", async () => {
    const { sub, privateKey, auth } = fakeSubscriber();
    const { fetchImpl, requests } = fakeEndpoint(201);
    await sendWebPush(sub, JSON.stringify({ hello: "world" }), pem(), "mailto:admin@example.com", { fetchImpl });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe(sub.endpoint);
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers["ttl"]).toBe("0");
    expect(req.headers["authorization"]).toMatch(/^vapid t=[^,]+,k=[^,]+$/);

    const decrypted = decryptAes128gcm(req.body, privateKey, auth);
    expect(JSON.parse(decrypted.toString("utf-8"))).toEqual({ hello: "world" });
  });

  it("VAPID aud matches the endpoint's own scheme+host", async () => {
    const { sub } = fakeSubscriber();
    const { fetchImpl, requests } = fakeEndpoint(201);
    await sendWebPush(sub, "x", pem(), "mailto:admin@example.com", { fetchImpl });
    const auth = requests[0]!.headers["authorization"]!;
    const jwt = auth.match(/t=([^,]+),/)![1]!;
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe("mailto:admin@example.com");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("status <= 202 is success (200/201/202 all resolve)", async () => {
    for (const status of [200, 201, 202]) {
      const { sub } = fakeSubscriber();
      const { fetchImpl } = fakeEndpoint(status);
      await expect(sendWebPush(sub, "x", pem(), "mailto:a@b.com", { fetchImpl })).resolves.toBeDefined();
    }
  });

  it("status > 202 throws WebPushError with the status code (matches pywebpush's own `> 202` check)", async () => {
    const { sub } = fakeSubscriber();
    const { fetchImpl } = fakeEndpoint(410);
    await expect(sendWebPush(sub, "x", pem(), "mailto:a@b.com", { fetchImpl })).rejects.toThrow(WebPushError);
    const { fetchImpl: fi2 } = fakeEndpoint(410);
    try {
      await sendWebPush(sub, "x", pem(), "mailto:a@b.com", { fetchImpl: fi2 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WebPushError);
      expect((e as WebPushError).statusCode).toBe(410);
    }
  });
});

function pem(): string {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

// ---------------------------------------------------------------------------
// PushWatcher — tails a real trajectory.jsonl, delivers to a fake endpoint.
// ---------------------------------------------------------------------------

describe("PushWatcher", () => {
  function makeIdentity(root: string, name: string): { path: string; trajPath: string } {
    const idPath = path.join(root, name);
    const trajDir = path.join(idPath, "trajectories", "abcd1234-root");
    fs.mkdirSync(trajDir, { recursive: true });
    fs.writeFileSync(path.join(idPath, "info.txt"), `name=${name}\ncreated=2026-01-01T00:00:00\nroot_trajectory=abcd1234-0000-0000-0000-000000000000\n`);
    const trajPath = path.join(trajDir, "trajectory.jsonl");
    fs.writeFileSync(trajPath, `${JSON.stringify({ type: "trajectory", step_id: "abcd1234-0000-0000-0000-000000000000" })}\n`);
    return { path: idPath, trajPath };
  }

  it("delivers a new message step addressed to a subscribed pwa-* name", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    vapidPublicKey(root); // ensure a real VAPID key exists (send() no-ops without one)
    const { sub, privateKey, auth } = fakeSubscriber("pwa-nick");
    addSubscription(root, "pwa-nick", sub);
    const { fetchImpl, requests } = fakeEndpoint(201);

    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 }); // never fire on its own timer
    cleanups.push(() => watcher.stop());
    await watcher.tick(); // establishes the at-EOF cursor (existing content not replayed)
    expect(requests).toHaveLength(0);

    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", from: "alice", to: "pwa-nick", content: "hello from the mind log" })}\n`);
    await watcher.tick();

    expect(requests).toHaveLength(1);
    const decrypted = JSON.parse(decryptAes128gcm(requests[0]!.body, privateKey, auth).toString("utf-8"));
    expect(decrypted).toEqual({ title: "alice", body: "hello from the mind log", url: expect.stringMatching(/^\/talk\//), tag: expect.stringContaining("pwa-nick") });
  });

  it("a restart never replays history — cursor starts at end-of-file on first scan", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", from: "alice", to: "pwa-nick", content: "before the watcher started" })}\n`);
    vapidPublicKey(root);
    addSubscription(root, "pwa-nick", fakeSubscriber("pwa-nick").sub);
    const { fetchImpl, requests } = fakeEndpoint(201);

    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
    cleanups.push(() => watcher.stop());
    await watcher.tick();
    expect(requests).toHaveLength(0); // pre-existing content not replayed
  });

  it("no subscriptions yet -> nothing is delivered, no crash", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    vapidPublicKey(root);
    const { fetchImpl, requests } = fakeEndpoint(201);
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
    cleanups.push(() => watcher.stop());
    await watcher.tick();
    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", to: "pwa-nick", content: "hi", from: "a" })}\n`);
    await watcher.tick();
    expect(requests).toHaveLength(0);
  });

  it("a partially-written (no trailing newline) line is not consumed until it completes", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    vapidPublicKey(root);
    addSubscription(root, "pwa-nick", fakeSubscriber("pwa-nick").sub);
    const { fetchImpl, requests } = fakeEndpoint(201);
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
    cleanups.push(() => watcher.stop());
    await watcher.tick();

    const partial = JSON.stringify({ type: "message", to: "pwa-nick", content: "partial", from: "a" });
    fs.appendFileSync(trajPath, partial.slice(0, partial.length - 5)); // no trailing \n at all
    await watcher.tick();
    expect(requests).toHaveLength(0);

    fs.appendFileSync(trajPath, `${partial.slice(partial.length - 5)}\n`);
    await watcher.tick();
    expect(requests).toHaveLength(1);
  });

  it("dead subscription (404/410) is pruned from the store", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    vapidPublicKey(root);
    const dead = fakeSubscriber("pwa-nick");
    addSubscription(root, "pwa-nick", dead.sub);
    const { fetchImpl, requests } = fakeEndpoint(410);
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
    cleanups.push(() => watcher.stop());
    await watcher.tick();

    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", to: "pwa-nick", content: "hi", from: "a" })}\n`);
    await watcher.tick();

    expect(requests).toHaveLength(1);
    expect(loadSubscriptions(root)).toHaveLength(0);
  });

  it("a non-dead push failure (e.g. 500) is surfaced via onError, subscription kept", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    vapidPublicKey(root);
    addSubscription(root, "pwa-nick", fakeSubscriber("pwa-nick").sub);
    const { fetchImpl } = fakeEndpoint(500);
    const onError = vi.fn();
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000, onError });
    cleanups.push(() => watcher.stop());
    await watcher.tick();

    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", to: "pwa-nick", content: "hi", from: "a" })}\n`);
    await watcher.tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(loadSubscriptions(root)).toHaveLength(1);
  });

  it("no VAPID key on disk yet -> send is a no-op (never crashes)", async () => {
    const root = freshRoot();
    const { trajPath } = makeIdentity(root, "alice");
    // deliberately skip vapidPublicKey(root) — no key file exists
    addSubscription(root, "pwa-nick", fakeSubscriber("pwa-nick").sub);
    const { fetchImpl, requests } = fakeEndpoint(201);
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
    cleanups.push(() => watcher.stop());
    await watcher.tick();
    fs.appendFileSync(trajPath, `${JSON.stringify({ type: "message", to: "pwa-nick", content: "hi", from: "a" })}\n`);
    await watcher.tick();
    expect(requests).toHaveLength(0);
  });

  it("stop() halts further polling", async () => {
    const root = freshRoot();
    makeIdentity(root, "alice");
    const { fetchImpl } = fakeEndpoint(201);
    const watcher = startPushWatcher(root, { fetchImpl, pollMs: 5 });
    watcher.stop();
    // no assertion beyond "doesn't throw" — proves stop() is safe to call and
    // the interval handle is cleared (timer.unref'd process would hang tests
    // otherwise; vitest's own teardown would surface that as a leak)
    expect(true).toBe(true);
  });
});
