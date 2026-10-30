# web push crypto — real Python interop proof

web/server/src/webpushCrypto.ts (node:crypto, zero deps) vs the REAL `py_vapid`/`pywebpush`/`http_ece` libraries headlong_web/push.py actually uses, run in a scratch venv (never installed into this repo). Six checks, both directions, on PEM key format, VAPID ES256 JWT signing, and RFC 8291 aes128gcm content encryption.

## Result: 6/6 PASS

| # | check | verdict | detail |
|---|---|---|---|
| 1 | PEM: python-generated key loads in node, identical pubkey | PASS | py=BND4v2VOZk-au4xk... node=BND4v2VOZk-au4xk... |
| 2 | PEM: node-generated key loads in python, identical pubkey | PASS | py=BNhzn869vDei9J2M... node=BNhzn869vDei9J2M... |
| 3 | VAPID JWT: node-signed token verifies with py_vapid.jwt.decode | PASS | OK {"aud": "https://push.example.com", "exp": 9999999999, "sub": "mailto:admin@example.com"} |
| 4 | VAPID JWT: python-signed (py_vapid) token verifies in node | PASS | verified=true claims={"aud":"https://push.example.com","exp":9999999999,"sub":"mailto:admin@example.com"} |
| 5 | aes128gcm: node-encrypted payload decrypts with http_ece.decrypt | PASS | decrypted="hello from node — interop proof 1" |
| 6 | aes128gcm: http_ece-encrypted payload decrypts in node | PASS | decrypted="hello from python — interop proof 2" |
