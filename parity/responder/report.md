# Responder parity (2e39a3f)

83/85 PARITY — PARITY: 83, DIVERGE: 2

| layer | scenario | status |
|---|---|---|
| redact-card | card-spaced | PARITY |
| redact-card | card-dashed | PARITY |
| redact-card | card-bare-16 | PARITY |
| redact-card | card-bare-15 | PARITY |
| redact-card | card-glued | PARITY |
| redact-card | card-keyword-amex | PARITY |
| redact-card | card-keyword-the | PARITY |
| redact-card | cvv-forms | PARITY |
| redact-card | expiry-forms | PARITY |
| redact-card | benign | PARITY |
| redact-card | multiline | PARITY |
| redact-card | boundary-start | PARITY |
| redact-card | unicode | PARITY |
| redact-card | empty | PARITY |
| redact-card | only-newlines | PARITY |
| redact-keys | every-shape | PARITY |
| redact-keys | sk-needs-edge | PARITY |
| redact-keys | env-value | PARITY |
| redact-keys | basic-auth-url | PARITY |
| redact-keys | docker-auth | PARITY |
| redact-keys | aws-secret | PARITY |
| redact-keys | pem-complete | PARITY |
| redact-keys | pem-two | PARITY |
| redact-keys | pem-open | DIVERGE |
| redact-keys | pem-one-line | DIVERGE |
| redact-keys | pem-swallows-later-rules | PARITY |
| redact-keys | card-too | PARITY |
| redact-keys | plain | PARITY |
| redact-keys | trailing-newlines | PARITY |
| parser | text-no-reply | PARITY |
| parser | text-no-reply-leading-blank | PARITY |
| parser | text-defer | PARITY |
| parser | text-defer-after-holding | PARITY |
| parser | text-defer-glued-before | PARITY |
| parser | text-defer-twice-glued | PARITY |
| parser | text-defer-bare | PARITY |
| parser | text-defer-mentioned-in-prose | PARITY |
| parser | text-defer-leading-blank | PARITY |
| parser | text-skills-tag | PARITY |
| parser | text-skills-tag-in-prose | PARITY |
| parser | text-leaked-chat-reply | PARITY |
| parser | text-raw-json-object | PARITY |
| parser | text-tool-markup | PARITY |
| parser | text-card-in-reply | PARITY |
| parser | text-card-in-defer | PARITY |
| parser | text-whitespace-only | PARITY |
| parser | text-defer-then-raw-object | PARITY |
| parser | text-defer-then-markup | PARITY |
| parser | structured-reply | PARITY |
| parser | structured-reply-fenced | PARITY |
| parser | structured-no-reply | PARITY |
| parser | structured-defer | PARITY |
| parser | structured-defer-card | PARITY |
| parser | structured-action-uppercase | PARITY |
| parser | structured-unknown-action | PARITY |
| parser | structured-plain-text | PARITY |
| parser | structured-plain-text-defer | PARITY |
| parser | structured-salvage-close-brace | PARITY |
| parser | structured-salvage-noreply-in-string | PARITY |
| parser | structured-cut-in-message | PARITY |
| parser | structured-broken-json | PARITY |
| parser | structured-raw-action-in-message | PARITY |
| parser | structured-empty-message | PARITY |
| step | text-reply | PARITY |
| step | text-with-history | PARITY |
| step | text-card-trigger | PARITY |
| step | text-card-noreply-excerpt | PARITY |
| step | structured-schema-model | PARITY |
| step | structured-gemini-model | PARITY |
| step | structured-forced-on-text-model | PARITY |
| step | structured-forced-off | PARITY |
| step | stale-trigger | PARITY |
| step | stale-trigger-disabled | PARITY |
| step | stale-trigger-custom-age | PARITY |
| step | stale-trigger-nonnumeric | PARITY |
| step | self-message | PARITY |
| step | structured-fallback-to-text | PARITY |
| step | transport-timeout | PARITY |
| step | transport-limits-env | PARITY |
| step | transport-truncated | PARITY |
| step | transport-empty | PARITY |
| step | transport-http500 | PARITY |
| step | transport-structured-fallback-also-fails | PARITY |
| step | transport-structured-timeout-no-retry | PARITY |
| step | transport-structured-truncated-no-retry | PARITY |

## redact-keys / pem-open — DIVERGE
```
bash="before\n" ts="before\n[redacted]"
```

## redact-keys / pem-one-line — DIVERGE
```
bash="" ts="[redacted]"
```

