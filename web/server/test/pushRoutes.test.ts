// pushRoutes.test.ts — GET /api/push/key, POST /api/push/subscriptions,
// POST /api/push/unsubscribe (server.py push_key/push_subscribe/
// push_unsubscribe). The crypto/store/watcher itself is unit-tested in
// web/server/test/{webpushCrypto,push}.test.ts — this file is the HTTP
// surface only.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { handleGet, handleMutation, type RouterCtx } from "../src/router.ts";
import { loadSubscriptions } from "../src/push.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-pushroutes-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function ctxFor(root: string, controlsEnabled = true): RouterCtx {
  return { root, controlsEnabled };
}
function fakeSubscription() {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const p256dh = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  const auth = crypto.randomBytes(16).toString("base64url");
  return { endpoint: "https://push.example.com/v1/abc123", keys: { p256dh, auth } };
}

describe("GET /api/push/key", () => {
  it("returns a real VAPID public key (not the empty stub)", () => {
    const root = freshRoot();
    const result = handleGet(ctxFor(root), ["push", "key"], new URLSearchParams());
    const key = (result!.body as { key: string }).key;
    expect(key.length).toBeGreaterThan(0);
    expect(Buffer.from(key, "base64url").length).toBe(65);
  });

  it("available in read-only mode", () => {
    const root = freshRoot();
    const result = handleGet(ctxFor(root, false), ["push", "key"], new URLSearchParams());
    expect(result!.status).toBe(200);
  });

  it("is stable across calls (same key persisted)", () => {
    const root = freshRoot();
    const a = (handleGet(ctxFor(root), ["push", "key"], new URLSearchParams())!.body as { key: string }).key;
    const b = (handleGet(ctxFor(root), ["push", "key"], new URLSearchParams())!.body as { key: string }).key;
    expect(a).toBe(b);
  });
});

describe("POST /api/push/subscriptions", () => {
  it("201-shaped ok:true, persists the subscription", async () => {
    const root = freshRoot();
    const subscription = fakeSubscription();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, name: "pwa-nick", subscriptions: 1 });
    expect(loadSubscriptions(root)).toHaveLength(1);
  });

  it("a second subscription (different endpoint) for the same name increments the count", async () => {
    const root = freshRoot();
    await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription: fakeSubscription() });
    const second = { ...fakeSubscription(), endpoint: "https://push.example.com/v1/def456" };
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription: second });
    expect((result.body as { subscriptions: number }).subscriptions).toBe(2);
  });

  it("name not starting with pwa- -> 422", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "slack-nick", subscription: fakeSubscription() });
    expect(result.status).toBe(422);
    expect(loadSubscriptions(root)).toHaveLength(0);
  });

  it("name failing CHAT_FROM_RE -> 422", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa- has spaces", subscription: fakeSubscription() });
    expect(result.status).toBe(422);
  });

  it("subscription without an https:// endpoint -> 422", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], {
      name: "pwa-nick",
      subscription: { ...fakeSubscription(), endpoint: "http://insecure.example.com" },
    });
    expect(result.status).toBe(422);
  });

  it("missing endpoint entirely -> 422", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription: { keys: fakeSubscription().keys } });
    expect(result.status).toBe(422);
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root, false), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription: fakeSubscription() });
    expect(result.status).toBe(403);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("removes an existing subscription -> {ok:true, removed:true}", async () => {
    const root = freshRoot();
    const subscription = fakeSubscription();
    await handleMutation(ctxFor(root), "POST", ["push", "subscriptions"], { name: "pwa-nick", subscription });
    const result = await handleMutation(ctxFor(root), "POST", ["push", "unsubscribe"], { endpoint: subscription.endpoint });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, removed: true });
    expect(loadSubscriptions(root)).toHaveLength(0);
  });

  it("unknown endpoint -> {ok:true, removed:false}, not an error", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["push", "unsubscribe"], { endpoint: "https://nowhere" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, removed: false });
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root, false), "POST", ["push", "unsubscribe"], { endpoint: "https://nowhere" });
    expect(result.status).toBe(403);
  });
});
