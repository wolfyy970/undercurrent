# slack bridge — differential parity proof

Real Python `headlong_slack` (`uv run` against the oracle checkout) vs this port's `src/slack/`, driven identically against a fake Slack Web API + fake headlong-web `/chat` endpoint (`fake-server.mjs`). See this file's header comment for the harness design (module-level driving, why no relay is needed for the Slack Web API leg, the JSON-vs-form wire-format asymmetry found by reading slack_sdk's source, and header-comparison scope) and PARITY.md for the live-Socket-Mode-leg deferral.

- `PARITY_PY_SLACK_DIR=/abs/path/to/headlong/slack node run-parity.mjs`
- Pass = same exit status, same (method+path+content-type+semantic-body) request sequence to both the Slack Web API and `/chat` endpoints, same on-disk `active_threads.json` (values normalized to "<TS>"), `cursor`.

## Result: 42/42 PARITY (100.0%)

| # | group | scenario | verdict | differing |
|---|---|---|---|---|
| 1 | on_event | dm-message-delivered | PARITY | - |
| 2 | on_event | app-mention-in-channel-anchors-new-thread | PARITY | - |
| 3 | on_event | mention-inside-existing-thread-anchors-at-thread-ts | PARITY | - |
| 4 | on_event | thread-followups-active-reply-delivered | PARITY | - |
| 5 | on_event | thread-followups-off-drops-unmentioned-channel-message | PARITY | - |
| 6 | on_event | bot-id-and-subtype-events-dropped | PARITY | - |
| 7 | on_event | duplicate-channel-ts-deduped | PARITY | - |
| 8 | on_event | bare-mention-cleans-to-empty-no-delivery | PARITY | - |
| 9 | on_event | delivery-retries-then-slack-error-fallback | PARITY | - |
| 10 | on_event | unicode-and-hostile-name-delivery | PARITY | - |
| 11 | on_event | reaction-on-own-message-delivered | PARITY | - |
| 12 | on_event | reaction-on-someone-elses-message-dropped | PARITY | - |
| 13 | on_event | dm-reaction-on-anyone-delivered | PARITY | - |
| 14 | on_event | reaction-on-threaded-reply-rewrites-body | PARITY | - |
| 15 | on_event | first-mention-backfill-prepends-prior-lines | PARITY | - |
| 16 | outbound | chat-sourced-reply-delivered | PARITY | - |
| 17 | outbound | non-chat-source-dropped | PARITY | - |
| 18 | outbound | long-reply-chunked | PARITY | - |
| 19 | outbound | chat-post-message-failure-breaks-chunk-loop | PARITY | - |
| 20 | outbound | duplicate-reply-deduped-by-recentposts | PARITY | - |
| 21 | outbound | file-upload-via-files-upload-v2 | PARITY | - |
| 22 | outbound | file-upload-dedupe-recorded-only-after-slack-accepts | PARITY | - |
| 23 | outbound | reaction-step-calls-reactions-add | PARITY | - |
| 24 | peers | peer-mention-forwarded-with-persona-header | PARITY | - |
| 25 | peers | unlisted-bot-dropped | PARITY | - |
| 26 | peers | no-peers-configured-bot-dropped | PARITY | - |
| 27 | peers | loop-guard-blocks-after-max-turns-person-resets | PARITY | - |
| 28 | peers | peer-bridge-error-text-not-forwarded | PARITY | - |
| 29 | on_event | web-409-refusal-is-final-no-retry-no-error-post | PARITY | - |
| 30 | on_event | web-500-still-retries-three-times | PARITY | - |
| 31 | outbound | bare-channel-top-level-post-registers-thread | PARITY | - |
| 32 | outbound | bare-user-opens-dm-once | PARITY | - |
| 33 | outbound | bare-user-dm-open-failure-notice | PARITY | - |
| 34 | outbound | malformed-slack-address-failed-notice | PARITY | - |
| 35 | outbound | other-transports-silently-skipped | PARITY | - |
| 36 | outbound | post-failure-with-slack-error-code-notice | PARITY | - |
| 37 | outbound | partly-posted-failure-notice-has-message-ts-and-permalink | PARITY | - |
| 38 | outbound | duplicate-top-level-is-skipped-notice | PARITY | - |
| 39 | outbound | file-upload-failure-notice-carries-filename | PARITY | - |
| 40 | outbound | reaction-to-bare-user-needs-a-channel | PARITY | - |
| 41 | outbound | cursor-of-another-trajectory-starts-at-eof | PARITY | - |
| 42 | outbound | cursor-beyond-the-file-starts-at-eof | PARITY | - |

## Divergences (detail)

None.
