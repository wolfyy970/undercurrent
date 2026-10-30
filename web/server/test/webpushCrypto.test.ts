// webpushCrypto.test.ts — VAPID (RFC 8292 ES256 JWT) and Web Push content
// encryption (RFC 8291 aes128gcm), self-contained (no Python dependency —
// see parity/push/run-interop-proof.mjs for the real py_vapid/pywebpush/
// http_ece cross-language proof, which needs PARITY_PYTHON pointed at a
// scratch venv and is not part of the normal `pnpm vitest run` suite).

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import {
  generateVapidPrivateKeyPem,
  loadVapidPrivateKey,
  vapidPublicKeyB64Url,
  signVapidJwt,
  vapidAuthorizationHeader,
  encryptAes128gcm,
  decryptAes128gcm,
} from "../src/webpushCrypto.ts";

describe("VAPID keys", () => {
  it("generates a PKCS8 PEM EC (P-256) private key", () => {
    const pem = generateVapidPrivateKeyPem();
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const key = loadVapidPrivateKey(pem);
    expect(key.asymmetricKeyType).toBe("ec");
    expect((key.asymmetricKeyDetails as { namedCurve?: string }).namedCurve).toBe("prime256v1");
  });

  it("public key is a 65-byte uncompressed point, b64url-encoded (no padding)", () => {
    const key = loadVapidPrivateKey(generateVapidPrivateKeyPem());
    const pub = vapidPublicKeyB64Url(key);
    expect(pub).not.toMatch(/[=+/]/); // base64url, unpadded
    expect(Buffer.from(pub, "base64url").length).toBe(65);
    expect(Buffer.from(pub, "base64url")[0]).toBe(0x04);
  });

  it("round-trips through a PEM file (load(save) === original pubkey)", () => {
    const pem = generateVapidPrivateKeyPem();
    const a = vapidPublicKeyB64Url(loadVapidPrivateKey(pem));
    const b = vapidPublicKeyB64Url(loadVapidPrivateKey(pem));
    expect(a).toBe(b);
  });
});

describe("VAPID JWT (signVapidJwt / vapidAuthorizationHeader)", () => {
  const claims = { sub: "mailto:admin@example.com", aud: "https://push.example.com", exp: 9999999999 };

  it("produces a 3-part JWT with typ/alg header and sorted-key compact claims", () => {
    const key = loadVapidPrivateKey(generateVapidPrivateKeyPem());
    const jwt = signVapidJwt(claims, key);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    // key order in the JSON text itself must be sorted (aud, exp, sub) — Chrome requires it, per py_vapid's own comment
    expect(Buffer.from(c!, "base64url").toString()).toBe('{"aud":"https://push.example.com","exp":9999999999,"sub":"mailto:admin@example.com"}');
    expect(Buffer.from(s!, "base64url").length).toBe(64); // raw r||s, not DER
  });

  it("signature verifies with node:crypto's own ES256 verify (ieee-p1363 encoding)", () => {
    const key = loadVapidPrivateKey(generateVapidPrivateKeyPem());
    const publicKey = crypto.createPublicKey(key);
    const jwt = signVapidJwt(claims, key);
    const [h, c, s] = jwt.split(".");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url")
    );
    expect(ok).toBe(true);
  });

  it("a tampered claim invalidates the signature", () => {
    const key = loadVapidPrivateKey(generateVapidPrivateKeyPem());
    const publicKey = crypto.createPublicKey(key);
    const jwt = signVapidJwt(claims, key);
    const [h, , s] = jwt.split(".");
    const tamperedClaims = Buffer.from(JSON.stringify({ ...claims, sub: "mailto:attacker@evil.com" })).toString("base64url");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${tamperedClaims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url")
    );
    expect(ok).toBe(false);
  });

  it("vapidAuthorizationHeader: `vapid t=<jwt>,k=<pubkey>` (RFC 8292 scheme)", () => {
    const key = loadVapidPrivateKey(generateVapidPrivateKeyPem());
    const header = vapidAuthorizationHeader(claims, key);
    expect(header).toMatch(/^vapid t=[^,]+,k=[^,]+$/);
    const k = header.match(/k=(.+)$/)![1];
    expect(k).toBe(vapidPublicKeyB64Url(key));
  });
});

describe("RFC 8291 aes128gcm content encryption (encryptAes128gcm / decryptAes128gcm)", () => {
  function fakeSubscriber() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const p256dh = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    const auth = crypto.randomBytes(16);
    return { privateKey, p256dh, auth };
  }

  it("round-trips plaintext through a fake subscriber's own keys", () => {
    const sub = fakeSubscriber();
    const plaintext = Buffer.from("hello from headlong");
    const body = encryptAes128gcm(plaintext, sub.p256dh, sub.auth);
    const decrypted = decryptAes128gcm(body, sub.privateKey, sub.auth);
    expect(decrypted.toString("utf-8")).toBe("hello from headlong");
  });

  it("body layout: salt(16) || rs(4 BE)=4096 || idlen(1)=65 || ephemeral pubkey(65) || ciphertext+tag", () => {
    const sub = fakeSubscriber();
    const body = encryptAes128gcm(Buffer.from("x"), sub.p256dh, sub.auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body[21]).toBe(0x04); // ephemeral sender pubkey is an uncompressed point
    // header(21) + keyid(65) + ciphertext(1 byte plaintext + 1 delimiter) + tag(16)
    expect(body.length).toBe(21 + 65 + 1 + 1 + 16);
  });

  it("a fresh random salt is used each call (two calls never produce the same body)", () => {
    const sub = fakeSubscriber();
    const a = encryptAes128gcm(Buffer.from("same plaintext"), sub.p256dh, sub.auth);
    const b = encryptAes128gcm(Buffer.from("same plaintext"), sub.p256dh, sub.auth);
    expect(a.equals(b)).toBe(false);
    // but both still decrypt correctly
    expect(decryptAes128gcm(a, sub.privateKey, sub.auth).toString()).toBe("same plaintext");
    expect(decryptAes128gcm(b, sub.privateKey, sub.auth).toString()).toBe("same plaintext");
  });

  it("wrong auth secret fails to decrypt (GCM tag mismatch)", () => {
    const sub = fakeSubscriber();
    const body = encryptAes128gcm(Buffer.from("secret"), sub.p256dh, sub.auth);
    expect(() => decryptAes128gcm(body, sub.privateKey, crypto.randomBytes(16))).toThrow();
  });

  it("wrong receiver private key fails to decrypt", () => {
    const sub = fakeSubscriber();
    const other = fakeSubscriber();
    const body = encryptAes128gcm(Buffer.from("secret"), sub.p256dh, sub.auth);
    expect(() => decryptAes128gcm(body, other.privateKey, sub.auth)).toThrow();
  });

  it("a corrupted ciphertext byte fails GCM tag verification", () => {
    const sub = fakeSubscriber();
    const body = Buffer.from(encryptAes128gcm(Buffer.from("integrity check"), sub.p256dh, sub.auth));
    body[body.length - 1] ^= 0xff; // flip a bit inside the auth tag
    expect(() => decryptAes128gcm(body, sub.privateKey, sub.auth)).toThrow();
  });

  it("rejects an auth secret that isn't 16 bytes", () => {
    const sub = fakeSubscriber();
    expect(() => encryptAes128gcm(Buffer.from("x"), sub.p256dh, Buffer.from("short"))).toThrow(/16 bytes/);
  });

  it("longer content (multi-hundred-byte push payload) still round-trips", () => {
    const sub = fakeSubscriber();
    const plaintext = Buffer.from("x".repeat(500), "utf-8");
    const body = encryptAes128gcm(plaintext, sub.p256dh, sub.auth);
    expect(decryptAes128gcm(body, sub.privateKey, sub.auth).equals(plaintext)).toBe(true);
  });

  it("unicode plaintext (emoji, multibyte) round-trips byte-exact", () => {
    const sub = fakeSubscriber();
    const plaintext = Buffer.from("héllo 🔔 world — 日本語", "utf-8");
    const body = encryptAes128gcm(plaintext, sub.p256dh, sub.auth);
    expect(decryptAes128gcm(body, sub.privateKey, sub.auth).equals(plaintext)).toBe(true);
  });
});
