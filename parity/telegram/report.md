# telegram bridge — differential parity proof

Real Python `headlong_telegram` (`uv run` against the oracle checkout) vs this port's `src/telegram/`, driven identically against a fake Telegram Bot API + fake headlong-web `/chat` endpoint (`fake-server.mjs`). See this file's header comment for the harness design (module-level driving, the Bot-API relay, header-comparison scope) and PARITY.md for the live-Telegram-leg deferral.

- `PARITY_PY_TELEGRAM_DIR=/abs/path/to/headlong/telegram node run-parity.mjs`
- Pass = same exit status, same (method+path+content-type+semantic-JSON-body) request sequence to both the Bot API and `/chat` endpoints, same on-disk `allowlist.json` (pending timestamps normalized), `update_offset`, `cursor`.

## Result: 36/36 PARITY (100.0%)

| # | group | scenario | verdict | differing |
|---|---|---|---|---|
| 1 | handle | admin-approve-flow-end-to-end | PARITY | - |
| 2 | handle | stranger-silent-admin-prompted-once | PARITY | - |
| 3 | handle | group-message-dropped-and-left | PARITY | - |
| 4 | handle | admin-list-deny-revoke | PARITY | - |
| 5 | handle | media-and-bots-dropped | PARITY | - |
| 6 | handle | duplicate-message-id-dropped | PARITY | - |
| 7 | handle | start-command | PARITY | - |
| 8 | handle | admin-approve-bad-target-usage-error | PARITY | - |
| 9 | handle | unicode-and-hostile-name-delivery | PARITY | - |
| 10 | run-poll | poll-loop-basic-offset-advance | PARITY | - |
| 11 | outbound | chat-sourced-reply-delivered | PARITY | - |
| 12 | outbound | non-chat-source-dropped | PARITY | - |
| 13 | outbound | unapproved-recipient-dropped | PARITY | - |
| 14 | outbound | long-reply-chunked | PARITY | - |
| 15 | outbound | html-send-fails-falls-back-to-plain | PARITY | - |
| 16 | outbound | file-step-sent-as-document | PARITY | - |
| 17 | outbound | png-sent-as-photo | PARITY | - |
| 18 | outbound | jpeg-sent-as-photo | PARITY | - |
| 19 | outbound | photo-send-failure-retries-as-document | PARITY | - |
| 20 | outbound | file-send-failure-falls-back-to-notice | PARITY | - |
| 21 | outbound | undecodable-content-b64-falls-back-to-notice | PARITY | - |
| 22 | outbound | identical-file-steps-deduped | PARITY | - |
| 23 | outbound | group-chat-destination-dropped | PARITY | - |
| 24 | outbound | slack-reaction-step-not-posted | PARITY | - |
| 25 | handle | web-409-refusal-is-final-no-retry-no-error-post | PARITY | - |
| 26 | handle | web-503-still-retries-three-times-then-posts-error | PARITY | - |
| 27 | outbound | delivered-notice-names-step-and-chat | PARITY | - |
| 28 | outbound | malformed-telegram-address-failed-notice | PARITY | - |
| 29 | outbound | other-transports-silently-skipped | PARITY | - |
| 30 | outbound | duplicate-is-skipped-notice | PARITY | - |
| 31 | outbound | send-failure-html-and-plain-is-failed-notice | PARITY | - |
| 32 | outbound | partly-sent-failure-notice | PARITY | - |
| 33 | outbound | file-sent-delivered-notice-carries-filename | PARITY | - |
| 34 | outbound | file-failure-notice-carries-reason-and-filename | PARITY | - |
| 35 | outbound | cursor-of-another-trajectory-starts-at-eof | PARITY | - |
| 36 | outbound | cursor-beyond-the-file-starts-at-eof | PARITY | - |

## Divergences (detail)

None.
