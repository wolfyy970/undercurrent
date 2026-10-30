#!/usr/bin/env python3
"""Small CLI shim over py_vapid/http_ece, used only by
run-interop-proof.mjs. NOT a repo dependency — this file is only ever
invoked against a scratch venv (`PARITY_PYTHON=/path/to/scratch/venv/bin/python
node parity/push/run-interop-proof.mjs`) that has `pywebpush`/`py_vapid`
installed; it is never imported by anything else in this port. Subcommands:

  gen-key <out.pem>                          generate + save a VAPID keypair
  pubkey <in.pem>                             print the b64url public key
  sign-jwt <in.pem> <aud> <sub> <exp>         print the VAPID Authorization header
  verify-jwt <pubkey_b64url> <auth_header>    print OK + claims, or FAIL
  gen-subscriber <priv.der> <auth.bin>        generate a fake browser subscriber
  encrypt <p256dh_b64url> <auth_b64url> <plaintext> <out.bin>
  decrypt <priv.der> <auth.bin> <in.bin>
"""
import sys
import base64
import json


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def cmd_gen_key(out_pem):
    from py_vapid import Vapid

    v = Vapid()
    v.generate_keys()
    v.save_key(out_pem)
    print("OK")


def cmd_pubkey(in_pem):
    from py_vapid import Vapid
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    v = Vapid.from_file(in_pem)
    raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    print(b64url(raw))


def cmd_sign_jwt(in_pem, aud, sub, exp):
    from py_vapid import Vapid

    v = Vapid.from_file(in_pem)
    headers = v.sign({"aud": aud, "sub": sub, "exp": int(exp)})
    print(headers["Authorization"])


def cmd_verify_jwt(pubkey_b64url, auth_header):
    from py_vapid.jwt import decode

    # auth_header: "vapid t=<jwt>,k=<pubkey>"
    parts = {}
    for tok in auth_header.split(" ", 1)[1].split(","):
        k, v = tok.split("=", 1)
        parts[k] = v
    try:
        claims = decode(parts["t"], parts["k"])
        assert parts["k"] == pubkey_b64url
        print("OK", json.dumps(claims, sort_keys=True))
    except Exception as exc:  # noqa: BLE001
        print("FAIL", repr(exc))
        sys.exit(1)


def cmd_gen_subscriber(priv_der, auth_bin):
    import os
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption
    from cryptography.hazmat.backends import default_backend

    priv = ec.generate_private_key(ec.SECP256R1(), default_backend())
    pub_raw = priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    with open(priv_der, "wb") as f:
        f.write(priv.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption()))
    auth = os.urandom(16)
    with open(auth_bin, "wb") as f:
        f.write(auth)
    print(f"{b64url(pub_raw)} {b64url(auth)}")


def cmd_encrypt(p256dh_b64url, auth_b64url, plaintext, out_bin):
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
    import http_ece

    p256dh = b64url_decode(p256dh_b64url)
    auth = b64url_decode(auth_b64url)
    server_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    body = http_ece.encrypt(
        plaintext.encode("utf-8"), private_key=server_key, dh=p256dh, auth_secret=auth, version="aes128gcm"
    )
    with open(out_bin, "wb") as f:
        f.write(body)
    print("OK", len(body))


def cmd_decrypt(priv_der, auth_bin, in_bin):
    from cryptography.hazmat.primitives.serialization import load_der_private_key
    import http_ece

    with open(priv_der, "rb") as f:
        priv = load_der_private_key(f.read(), password=None)
    with open(auth_bin, "rb") as f:
        auth = f.read()
    with open(in_bin, "rb") as f:
        body = f.read()
    result = http_ece.decrypt(body, private_key=priv, auth_secret=auth, version="aes128gcm")
    print(result.decode("utf-8"))


COMMANDS = {
    "gen-key": cmd_gen_key,
    "pubkey": cmd_pubkey,
    "sign-jwt": cmd_sign_jwt,
    "verify-jwt": cmd_verify_jwt,
    "gen-subscriber": cmd_gen_subscriber,
    "encrypt": cmd_encrypt,
    "decrypt": cmd_decrypt,
}

if __name__ == "__main__":
    cmd = sys.argv[1]
    COMMANDS[cmd](*sys.argv[2:])
