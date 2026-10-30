// webpushCrypto.ts — VAPID (RFC 8292, ES256 JWT) and Web Push content
// encryption (RFC 8291 "aes128gcm", built on the RFC 8188 record format),
// using node:crypto ONLY (no dependency — matches this port's zero-new-deps
// rule). Upstream (headlong_web/push.py) uses py_vapid (VAPID keys/JWT) and
// pywebpush/http_ece (content encryption); both are ported here from their
// actual source (verified by reading py_vapid/__init__.py, py_vapid/jwt.py,
// http_ece/__init__.py in a scratch venv — never vendored, never a repo dep).
//
// Interop with py_vapid/pywebpush is PROVEN, not assumed — see
// parity/push/interop-proof.md for a real Python venv round-trip: a
// py_vapid-generated PEM loads here and produces the IDENTICAL b64url public
// key; a JWT signed here verifies with py_vapid's own verifier and vice
// versa; a payload encrypted here decrypts with http_ece.decrypt and vice
// versa.
//
// PEM key format: PKCS8, unencrypted (`openssl ecparam -genkey` + PKCS8
// wrap) — exactly what py_vapid's `Vapid.save_key()` writes
// (`serialization.PrivateFormat.PKCS8`) and what `Vapid.from_file()` reads
// back (its `from_pem` strips the PEM armor and DER-decodes the body, which
// PKCS8 already is). node:crypto's `createPrivateKey`/`generateKeyPairSync`
// speak PKCS8 PEM natively for EC keys — no manual ASN.1 needed there.
//
// The one piece of ASN.1 this file DOES hand-roll: wrapping a raw
// uncompressed P-256 point (0x04 || X || Y, 65 bytes — the wire format both
// VAPID public keys and Web Push subscription `p256dh` keys use) into a
// minimal SPKI DER structure, because node:crypto has no "import a raw EC
// point" API — only PEM/DER-wrapped keys.

import * as crypto from "node:crypto";

const P256_RAW_POINT_LEN = 65; // 0x04 + 32-byte X + 32-byte Y
const AUTH_SECRET_LEN = 16;
const RECORD_SIZE = 4096; // rs — matches pywebpush's default; our payloads (<=160 chars) are always one record

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A fresh VAPID keypair's private key, PKCS8 PEM (py_vapid `generate_keys` + `private_pem`). */
export function generateVapidPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Load a PKCS8 PEM private key (py_vapid `Vapid.from_file`/`from_pem`). */
export function loadVapidPrivateKey(pem: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

function rawPoint(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

/** DER SPKI wrapper for a raw uncompressed P-256 point — see file header. */
function publicKeyFromRawPoint(rawPub: Buffer): crypto.KeyObject {
  if (rawPub.length !== P256_RAW_POINT_LEN || rawPub[0] !== 0x04) {
    throw new Error("expected a 65-byte uncompressed P-256 point (0x04 || X || Y)");
  }
  // SEQUENCE { SEQUENCE { OID id-ecPublicKey, OID prime256v1 }, BIT STRING rawPub }
  const oidEcPublicKey = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const oidPrime256v1 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const algId = tlv(0x30, Buffer.concat([oidEcPublicKey, oidPrime256v1]));
  const bitString = tlv(0x03, Buffer.concat([Buffer.from([0x00]), rawPub]));
  return crypto.createPublicKey({ key: tlv(0x30, Buffer.concat([algId, bitString])), format: "der", type: "spki" });
}
function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(value.length), value]);
}
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** b64url-encoded uncompressed point — `vapid_public_key()`'s return shape
 *  and the VAPID `k=` param. */
export function vapidPublicKeyB64Url(privateKey: crypto.KeyObject): string {
  return rawPoint(crypto.createPublicKey(privateKey)).toString("base64url");
}

// ---------------------------------------------------------------------------
// VAPID JWT (RFC 8292) — py_vapid/jwt.py `sign()`, Vapid02.sign()
// ---------------------------------------------------------------------------

export interface VapidClaims {
  sub: string;
  aud: string;
  exp: number;
}

/** ES256 JWT: header `{"typ":"JWT","alg":"ES256"}`, claims JSON with SORTED
 *  keys and compact separators (py_vapid's own comment: "chrome seems to
 *  require the claims to be sorted"), signature is raw r||s (64 bytes, NOT
 *  DER) — `dsaEncoding: "ieee-p1363"` gets this directly from node:crypto. */
export function signVapidJwt(claims: VapidClaims, privateKey: crypto.KeyObject): string {
  const headerB64 = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(claims).sort()) sorted[k] = (claims as unknown as Record<string, unknown>)[k];
  const claimsB64 = Buffer.from(JSON.stringify(sorted)).toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${sig.toString("base64url")}`;
}

/** `Vapid02.sign()`'s Authorization header value only (RFC 8292 scheme —
 *  the schema py_vapid's `Vapid = Vapid02` alias makes the default, and the
 *  one pywebpush's `webpush()` always produces): `vapid t=<jwt>,k=<pubkey>`. */
export function vapidAuthorizationHeader(claims: VapidClaims, privateKey: crypto.KeyObject): string {
  return `vapid t=${signVapidJwt(claims, privateKey)},k=${vapidPublicKeyB64Url(privateKey)}`;
}

// ---------------------------------------------------------------------------
// Content encryption — RFC 8291 "aes128gcm" over RFC 8188's record format.
// Ported from http_ece's `derive_key`/`encrypt`/`decrypt` (aes128gcm branch
// only — the older "aesgcm"/"aesgcm128" drafts pywebpush also supports are
// dead per its own module docstring ("DO NOT USE") and never reached by
// push.py, which always calls `webpush()` with the RFC8188-standard default).
// ---------------------------------------------------------------------------

function deriveKeyNonce(ecdhSecret: Buffer, authSecret: Buffer, context: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  const prk = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, context, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  return { cek, nonce };
}

/** RFC 8291 §3.2's info string: `"WebPush: info" || 0x00 || ua_public || as_public`. */
function webPushContext(receiverPubRaw: Buffer, senderPubRaw: Buffer): Buffer {
  return Buffer.concat([Buffer.from("WebPush: info\0"), receiverPubRaw, senderPubRaw]);
}

/** Encrypt `plaintext` for one Web Push subscriber. `receiverPubRaw` is the
 *  subscription's `keys.p256dh` (65-byte raw point, already base64url-
 *  decoded by the caller); `authSecret` is `keys.auth` (16 bytes). Always a
 *  SINGLE record (our payloads are far under the 4096-byte record size) —
 *  matches `http_ece.encrypt`'s one-record-per-call shape for short content.
 *  `saltOverride` exists ONLY for deterministic tests; production always
 *  uses a fresh random salt. */
export function encryptAes128gcm(plaintext: Buffer, receiverPubRaw: Buffer, authSecret: Buffer, saltOverride?: Buffer): Buffer {
  if (authSecret.length !== AUTH_SECRET_LEN) throw new Error("auth secret must be 16 bytes");
  const salt = saltOverride ?? crypto.randomBytes(16);
  const { privateKey: asPriv, publicKey: asPub } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const asPubRaw = rawPoint(asPub);
  const ecdhSecret = crypto.diffieHellman({ privateKey: asPriv, publicKey: publicKeyFromRawPoint(receiverPubRaw) });
  const { cek, nonce } = deriveKeyNonce(ecdhSecret, authSecret, webPushContext(receiverPubRaw, asPubRaw), salt);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header (RFC 8188 §2.1): salt(16) || rs(4, BE) || idlen(1) || keyid.
  // RFC 8291's convention: keyid IS the sender's own ephemeral raw public
  // point (not empty) — the receiver uses it directly as the peer `dh` value.
  const header = Buffer.alloc(21 + asPubRaw.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPubRaw.length, 20);
  asPubRaw.copy(header, 21);
  return Buffer.concat([header, record]);
}

/** Inverse of `encryptAes128gcm` — this port never receives a push (it only
 *  sends), so this exists purely to prove round-trips in tests (a fake
 *  subscriber decrypting what this port sent) — never called at runtime. */
export function decryptAes128gcm(body: Buffer, receiverPrivateKey: crypto.KeyObject, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const keyid = body.subarray(21, 21 + idlen); // sender's ephemeral raw public point
  const ciphertext = body.subarray(21 + idlen);

  const ecdhSecret = crypto.diffieHellman({ privateKey: receiverPrivateKey, publicKey: publicKeyFromRawPoint(keyid) });
  const receiverPubRaw = rawPoint(crypto.createPublicKey(receiverPrivateKey));
  const { cek, nonce } = deriveKeyNonce(ecdhSecret, authSecret, webPushContext(receiverPubRaw, keyid), salt);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
  const delimiter = padded[padded.length - 1];
  if (delimiter !== 0x02) throw new Error(`unexpected record delimiter (single-record decrypt expects 0x02, got ${delimiter})`);
  return padded.subarray(0, padded.length - 1);
}
