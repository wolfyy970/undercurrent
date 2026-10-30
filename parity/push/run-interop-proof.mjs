#!/usr/bin/env node
// run-interop-proof.mjs — real cross-language interop proof for
// web/server/src/webpushCrypto.ts against py_vapid + pywebpush/http_ece,
// the actual libraries headlong_web/push.py uses (py_vapid.Vapid,
// pywebpush.webpush -> http_ece.encrypt).
//
// This port has NO Python dependency at runtime or in its normal test
// suite (zero new deps, TS-only) — this script instead drives a Python
// interpreter from a SCRATCH venv (never the repo, never committed) via
// PARITY_PYTHON, proving the two implementations are byte-for-byte
// interoperable:
//   1. PEM interop: a py_vapid-generated key loads here and derives the
//      IDENTICAL b64url public key; and the reverse (a key generated here
//      loads in py_vapid and derives the identical public key).
//   2. VAPID JWT interop: a JWT signed here verifies with py_vapid's own
//      verifier (py_vapid.jwt.decode); and the reverse (a py_vapid-signed
//      JWT verifies against this port's own ES256 verification).
//   3. RFC 8291 aes128gcm content-encryption interop: a payload encrypted
//      here decrypts with http_ece.decrypt (the library pywebpush uses)
//      against a Python-generated fake subscriber's own keys; and the
//      reverse (http_ece-encrypted content decrypts here).
//
// Setup (once, in a throwaway venv under /private/tmp, per this lane's
// task brief — never installed into or committed to this repo):
//   python3 -m venv /private/tmp/.../pushenv
//   /private/tmp/.../pushenv/bin/pip install pywebpush py_vapid cryptography
//   PARITY_PYTHON=/private/tmp/.../pushenv/bin/python node parity/push/run-interop-proof.mjs
//
// Writes report.md + results.json beside this file. Exit 0 iff every check
// passes AND a working PARITY_PYTHON was actually used (a missing
// PARITY_PYTHON fails loudly instead of silently reporting nothing).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PY = process.env.PARITY_PYTHON || "<SCRATCH_VENV_PYTHON>";
const PY_OPS = path.join(HERE, "py_vapid_ops.py");

const {
  generateVapidPrivateKeyPem,
  loadVapidPrivateKey,
  vapidPublicKeyB64Url,
  signVapidJwt,
  encryptAes128gcm,
  decryptAes128gcm,
} = await import(path.join(REPO, "web", "server", "src", "webpushCrypto.ts"));

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "push-interop-"));
}
function py(...args) {
  const res = spawnSync(PY, [PY_OPS, ...args], { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) {
    throw new Error(`python ${args.join(" ")} failed (exit ${res.status}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

if (!fs.existsSync(PY) && PY === "<SCRATCH_VENV_PYTHON>") {
  console.error("PARITY_PYTHON is not set — see this file's header comment for scratch-venv setup.");
  process.exit(1);
}
{
  const probe = spawnSync(PY, ["-c", "import pywebpush, py_vapid, http_ece"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error(`PARITY_PYTHON (${PY}) is missing pywebpush/py_vapid/http_ece: ${probe.stderr}`);
    process.exit(1);
  }
}

const dir = scratch();

// --- 1. PEM interop -----------------------------------------------------

// 1a. Python generates -> Node loads.
{
  const pemPath = path.join(dir, "py.pem");
  py("gen-key", pemPath);
  const pyPub = py("pubkey", pemPath);
  const pem = fs.readFileSync(pemPath, "utf-8");
  const nodePub = vapidPublicKeyB64Url(loadVapidPrivateKey(pem));
  record("PEM: python-generated key loads in node, identical pubkey", pyPub === nodePub, `py=${pyPub.slice(0, 16)}... node=${nodePub.slice(0, 16)}...`);
}

// 1b. Node generates -> Python loads.
{
  const pemPath = path.join(dir, "node.pem");
  const pem = generateVapidPrivateKeyPem();
  fs.writeFileSync(pemPath, pem);
  const nodePub = vapidPublicKeyB64Url(loadVapidPrivateKey(pem));
  const pyPub = py("pubkey", pemPath);
  record("PEM: node-generated key loads in python, identical pubkey", pyPub === nodePub, `py=${pyPub.slice(0, 16)}... node=${nodePub.slice(0, 16)}...`);
}

// --- 2. VAPID JWT interop ------------------------------------------------

const claims = { aud: "https://push.example.com", sub: "mailto:admin@example.com", exp: 9999999999 };

// 2a. Node signs -> Python verifies.
{
  const pemPath = path.join(dir, "jwt1.pem");
  fs.writeFileSync(pemPath, generateVapidPrivateKeyPem());
  const privateKey = loadVapidPrivateKey(fs.readFileSync(pemPath, "utf-8"));
  const jwt = signVapidJwt(claims, privateKey);
  const pub = vapidPublicKeyB64Url(privateKey);
  const authHeader = `vapid t=${jwt},k=${pub}`;
  const out = py("verify-jwt", pub, authHeader);
  const ok = out.startsWith("OK");
  record("VAPID JWT: node-signed token verifies with py_vapid.jwt.decode", ok, out);
}

// 2b. Python signs -> Node verifies (raw ES256 verify, ieee-p1363 sig encoding).
{
  const pemPath = path.join(dir, "jwt2.pem");
  py("gen-key", pemPath);
  const authHeader = py("sign-jwt", pemPath, claims.aud, claims.sub, String(claims.exp));
  const pub = authHeader.match(/k=([^,]+)$/)[1];
  const jwt = authHeader.match(/t=([^,]+),/)[1];
  const [headerB64, claimsB64, sigB64] = jwt.split(".");
  const signingInput = `${headerB64}.${claimsB64}`;
  const sig = Buffer.from(sigB64, "base64url");
  const pubKeyRaw = Buffer.from(pub, "base64url");
  // Reuse this port's own raw-point -> KeyObject path via a private encrypt
  // call's plumbing would be overkill; verify directly with node:crypto's
  // public verify against a JWK built from the raw point.
  const x = pubKeyRaw.subarray(1, 33).toString("base64url");
  const y = pubKeyRaw.subarray(33, 65).toString("base64url");
  const jwk = { kty: "EC", crv: "P-256", x, y };
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verified = crypto.verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
  const decodedClaims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf-8"));
  record(
    "VAPID JWT: python-signed (py_vapid) token verifies in node",
    verified && decodedClaims.sub === claims.sub && decodedClaims.aud === claims.aud,
    `verified=${verified} claims=${JSON.stringify(decodedClaims)}`
  );
}

// --- 3. RFC 8291 aes128gcm content-encryption interop --------------------

// 3a. Node encrypts -> Python (http_ece) decrypts.
{
  const subPriv = path.join(dir, "sub1.der");
  const subAuth = path.join(dir, "sub1.auth");
  const [p256dhB64, authB64] = py("gen-subscriber", subPriv, subAuth).split(" ");
  const plaintext = "hello from node — interop proof 1";
  const body = encryptAes128gcm(Buffer.from(plaintext, "utf-8"), Buffer.from(p256dhB64, "base64url"), Buffer.from(authB64, "base64url"));
  const encPath = path.join(dir, "node-encrypted.bin");
  fs.writeFileSync(encPath, body);
  const decrypted = py("decrypt", subPriv, subAuth, encPath);
  record("aes128gcm: node-encrypted payload decrypts with http_ece.decrypt", decrypted === plaintext, `decrypted=${JSON.stringify(decrypted)}`);
}

// 3b. Python (http_ece) encrypts -> Node decrypts.
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const p256dhRaw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const authSecret = crypto.randomBytes(16);
  const plaintext = "hello from python — interop proof 2";
  const encPath = path.join(dir, "python-encrypted.bin");
  py("encrypt", p256dhRaw.toString("base64url"), authSecret.toString("base64url"), plaintext, encPath);
  const body = fs.readFileSync(encPath);
  const decrypted = decryptAes128gcm(body, privateKey, authSecret).toString("utf-8");
  record("aes128gcm: http_ece-encrypted payload decrypts in node", decrypted === plaintext, `decrypted=${JSON.stringify(decrypted)}`);
}

// --- report ----------------------------------------------------------------

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;

let md = `# web push crypto — real Python interop proof\n\n`;
md += `web/server/src/webpushCrypto.ts (node:crypto, zero deps) vs the REAL \`py_vapid\`/\`pywebpush\`/\`http_ece\` libraries headlong_web/push.py actually uses, run in a scratch venv (never installed into this repo). Six checks, both directions, on PEM key format, VAPID ES256 JWT signing, and RFC 8291 aes128gcm content encryption.\n\n`;
md += `## Result: ${passed}/${total} PASS\n\n`;
md += `| # | check | verdict | detail |\n|---|---|---|---|\n`;
checks.forEach((c, i) => {
  md += `| ${i + 1} | ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${(c.detail ?? "").replace(/\|/g, "\\|")} |\n`;
});

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, checks }, null, 2));

console.log(`\nweb push interop: ${passed}/${total} PASS`);
process.exit(passed === total ? 0 : 1);
