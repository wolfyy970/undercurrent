# Upstream sync 1c, lane G (historical)

> **Historical.** Slack bridge.

## Upstream sync 1c, lane G (7d29f9e → 5458fee, Slack bridge)

Lane G carries `src/slack/{inbound,outbound,api,config,filepayload}.ts`, their
tests, and `parity/slack/`. Upstream commits: e5a2f7c, f0de3e8, ed0b700
(slack part), f163f93, cb974c2 (reaction events, merged as PR #88/314e771),
48a706c, d5cc776 (first-@mention thread-join backfill, PR #108/8d73c52),
f6a821a (test-only), 692e16e, c7d240b (`files.upload_v2`, PR #109/b71c83b),
6a98ab5 (slack part; outbound emoji reactions, PR #111/a2a00f9). Builds on
main (lane D's `chat.ts`: `chat react`, `chat send-file`'s `content_b64`,
`--source-url`).

- **e5a2f7c, f0de3e8, ed0b700, f163f93, cb974c2 — inbound `reaction_added`
  events land in the mind log.** `inbound.ts` gained `reactionText`
  (exported), an internal `reactionToInbound` gate, and `Inbound.onEvent`
  now branches on `event.type === "reaction_added"` to a new `onReaction`
  path before falling into the existing message/mention gate
  (`onMessageEvent`, the old `onEvent` body renamed). Channel reactions are
  gated to the bot's own messages (`item_user === botUserId`); DM reactions
  are unconditional. A channel reaction anchors at the item ts as a
  provisional thread; the delivery worker resolves the REAL parent thread
  via `reactions.get` (`conversations.history`/`.replies` don't expose it —
  `.history` only returns parent-channel messages, `.replies` is keyed by
  parent not item), renaming `from_name`/body (`:emoji: (on <item_ts>)`
  when nested) — never the socket-mode handler, which must ack without
  waiting on the Web API. `InboundMessage` gained `messageTs`,
  `resolveParent`, `isReaction`, `backfill` fields.
  **In scope, ported**: the shared "at most one Slack lookup in flight"
  bound (`f163f93`, `d5cc776`'s unification into one `tryLookup` — see
  below) and the `isReaction` marker gate that upstream added so reactions
  skip its permalink lookup (`cb974c2`).
  **Out of scope, not ported**: the permalink lookup itself
  (`chat_getPermalink`/`source_url`, added by `f68c1d8`) — that commit
  touches `slack/src/headlong_slack/inbound.py` but is not assigned to any
  lane's commit list in `UPSTREAM-TRIAGE-2.md`'s lane-G row (nor claimed by
  lane I's row, which lists only `f68c1d8`'s `web/` part). `isReaction` is
  ported anyway (its OTHER purpose — cb974c2's reaction-routing/lookup
  changes — needs it regardless), so when that gap is closed the existing
  `!msg.isReaction` gate point is already in place; see the spawned
  follow-up and `parity/slack/run-parity.mjs`'s `KNOWN_PERMALINK_GAP`.
  `Inbound`'s single shared lookup slot (`tryLookup`, a `lookupBusy`
  boolean) replaces Python's `max_workers=1` `ThreadPoolExecutor` +
  `Future` — Node has no threads, so "at most one call in flight, a
  timed-out call fails open immediately without queuing a second one, and
  the background call keeps running until it settles" needed no thread
  pool, just one flag and `withTimeout`'s promise race. `ITEM_LOOKUP_
  TIMEOUT_MS`/`JOIN_BACKFILL_TIMEOUT_MS` are exported constants (matching
  upstream's module-level `ITEM_LOOKUP_TIMEOUT`/`JOIN_BACKFILL_TIMEOUT`)
  but also exposed as `InboundOptions.itemLookupTimeoutMs`/
  `joinBackfillTimeoutMs` — a TS module constant cannot be monkeypatched
  the way Python's tests do (`monkeypatch.setattr(inbound,
  "ITEM_LOOKUP_TIMEOUT", 0.05)`), so the bound is injectable instead,
  defaulting to the real constants. 24 new tests in
  `test/slack-inbound.test.ts` port every non-permalink case from
  upstream's `test_inbound.py` reaction sections, including the
  timed-out-lookups-share-one-worker regression (gated via the injectable
  timeout rather than a monkeypatched constant).
- **48a706c, d5cc776 — first-@mention-in-a-thread backfill.** `Config`
  gained `threadJoinBackfill` (env `SLACK_THREAD_JOIN_BACKFILL`, default
  20, `0` disables, clamped to 50; `config.ts`'s `joinBackfillLimit`). On a
  first @mention inside an existing thread (not already active, not a
  top-level mention, not a DM, backfill > 0), the delivery worker fetches
  `conversations.replies` and prepends up to N earlier lines, formatted
  `[thread before this mention — N earlier messages]` + `name: text`
  lines (each capped at `JOIN_BACKFILL_LINE_CHARS`=200). `d5cc776`'s
  closest-lines-not-oldest-page fix is ported as `threadLinesBefore`'s
  cursor walk (paginate until exhausted or the page cap, fail open to `[]`
  on incomplete pagination — never prepend a stale oldest slice) sharing
  the SAME one-in-flight lookup slot `reactions.get` uses. Already-active
  threads, top-level mentions, DMs, and `threadJoinBackfill: 0` all skip
  the lookup entirely (no `conversations.replies` call). 16 new tests
  cover capped-prior-lines, closest-lines-via-pagination, already-active/
  top-level/DM skip, lookup-failure-still-delivers, `0`-disables, and the
  timed-out-burst-shares-one-worker regression (again via the injectable
  timeout — see `f6a821a` below).
- **f6a821a — test-only, no source change**: upstream's regression fix
  counts `ThreadPoolExecutor.submit` calls (not `replies_calls` at
  call-start) because the fake only appended to that list once a queued
  call started, so an "always submit" bug could pass until pool shutdown
  cancelled the queue. This port's `tryLookup` has no separate queued
  state at all — a lookup either starts synchronously or is skipped
  (`lookupBusy`) — so counting actual `reactionsGet`/`conversationsReplies`
  invocations in the port's own regression test is equivalent; no
  submit-vs-started distinction needed. No `src/` change.
- **692e16e, c7d240b — outbound file upload via `files.upload_v2`.** New
  `src/slack/filepayload.ts` (no 1:1 upstream Python module before this
  sync — ported fresh from `slack/src/headlong_slack/filepayload.py`):
  `filePayload(step)` detects a `filename`-stamped step (the `file` alias
  is NOT accepted — an ordinary message must stay `chat.postMessage`),
  decodes `content_b64` (strict — a failed decode round-trip is a
  `decodeError`, matching Python's `base64.b64decode(..., validate=True)`)
  or falls back to leak-filtered `content`, reduces the filename to its
  basename, and truncates/leak-filters a `caption` into `initialComment`
  (cap `COMMENT_MAX`=3000). `fileSignature(filename, content)` is
  `filename:sha256(bytes)` for `RecentPosts`-style dedupe.
  `outbound.run` now checks `filePayload(step)` before the plain-text path:
  a decode error or empty content logs and falls straight to `(failed to
  deliver file <name>)`; otherwise it calls the new `WebClient.
  filesUploadV2` and, on success only, records the signature. **c7d240b**:
  dedupe is recorded ONLY after Slack accepts — `RecentPosts.isDuplicate`
  was split into `seen()` (check, no record) and `record()` (explicit
  stamp) so a rejected upload's identical retry is not silently swallowed
  for the dedupe window (this split is itself the behavior upstream's
  commit introduces on the Python `RecentPosts` class). `api.ts`'s
  `filesUploadV2` ports slack_sdk's real 3-call client-side flow — there is
  no single `files.upload_v2` server endpoint — read directly from the
  installed `slack_sdk` source (`web/client.py`, `web/internal_utils.py`,
  `web/base_client.py`), not assumed: (1) `files.getUploadURLExternal`
  (`params=` form: `filename`, `length`) → `{file_id, upload_url}`; (2) a
  RAW `POST <upload_url>` of the bytes — NOT under `slack.com/api/`, no
  `Authorization` header, no JSON envelope
  (`_upload_file_via_v2_url`: bare `Request(method="POST", data=data,
  headers={})`); (3) `files.completeUploadExternal` (`params=` form,
  `files` a JSON-stringified `[{id, title}]`, plus `channel_id`,
  `thread_ts`, `initial_comment`). 20 new tests (`test/slack-filepayload.
  test.ts`'s 12 cases mirror `test_filepayload.py` 1:1; `test/slack-
  outbound.test.ts` gained 8 file-upload cases including the
  dedupe-after-accept retry) + 2 new `test/slack-api.test.ts` cases proving
  the 3-call sequence and its `HttpError` on a failed upload step.
- **6a98ab5 (slack part) — outbound emoji reactions via `chat react`.**
  (`bin/chat`'s `cmd_react`/`chat.ts`'s `cmdReact` already landed with lane
  D — this lane only wires the Slack-side consumer.) `outbound.ts` gained
  `reactionName(step)` (strips leading/trailing colons, validates
  `[A-Za-z0-9_+:-]`, rejects whitespace or >100 chars — same character set
  as `chat.ts`'s own validation, checked independently on the receiving
  end) and `messageTsFromSourceUrl(url)` (decodes a Slack archive
  permalink's `/archives/<channel>/p<digits>` into `<sec>.<usec>`, no host
  check — matches Python's `urlsplit`-based parser, which doesn't check
  the host either). A step with a `reaction` field resolves its target
  timestamp from `source_url` (if `chat react --reply-to` had one — see
  lane D and, once ported, the `f68c1d8` permalink gap above) falling back
  to the conversation's own `thread_ts`; a DM/top-level reaction with
  neither is skipped (logged, not posted as text — nowhere to react to).
  `reactions.add` failures are retried on the next identical step
  (dedupe recorded only on success, same `seen()`/`record()` split as file
  upload); `already_reacted` counts as success (Slack's own answer to "did
  this land," not an error). 11 new outbound tests + 2 `reactionName`/
  `messageTsFromSourceUrl` unit tests port every case from upstream's
  `test_outbound.py` reaction section. `api.ts` gained `reactionsAdd`
  (`params=` form: `channel`, `timestamp`, `name`).
- **Real bug found while proving `conversations.replies` parity**:
  `api.ts`'s `callForm` sent boolean params as `"true"`/`"false"`
  (`String(v)`); slack_sdk's `params=` path converts booleans to `"0"`/
  `"1"` (`internal_utils.convert_bool_to_0_or_1`/`_to_0_or_1_if_bool`,
  every `params=` wrapper method's kwargs pass through it — "Slack APIs
  safely accept 0/1... True/False doesn't work with aiohttp"). No existing
  `params=` method before this lane had a boolean field (`conversations.
  replies`'s `inclusive` is the first), so this was a latent bug with no
  prior differential coverage. Fixed in `callForm`; `callJson` (`chat.
  postMessage`'s `unfurl_links`) is unaffected — that conversion is
  `params=`-only. Found by `parity/slack/run-parity.mjs`'s new
  `first-mention-backfill-prepends-prior-lines` scenario, not assumed.
- **Deferred, unassigned in this sync's lane plan**: `f68c1d8`'s
  `chat_getPermalink`/`source_url` addition to `inbound.ts`'s `deliver()`
  — see the `e5a2f7c` bullet above. `parity/slack/run-parity.mjs` tags 7
  scenarios `KNOWN_PERMALINK_GAP` (every non-reaction on_event delivery,
  plus the new backfill scenario): each is verified, not assumed, to
  diverge in EXACTLY the documented way (one extra `chat.getPermalink`
  call on the Python side, nothing else) before being excluded from the
  pass/fail gate — an unrelated regression on a tagged scenario still
  fails loud (`isOnlyPermalinkDivergence`). A follow-up task is queued to
  close this gap.
- Differential `parity/slack/run-parity.mjs` re-run against
  an upstream checkout (5458fee): **16/16 PARITY (100%) + 7
  known-divergence** (see above) — 8 new scenarios added (4 reaction/
  backfill `on_event`, 3 outbound file-upload/reaction, plus the boolean-
  encoding fix's coverage via the existing backfill scenario);
  `fake-server.mjs` gained `reactions.get`/`conversations.replies`/
  `reactions.add`/`files.getUploadURLExternal`/`files.completeUploadExternal`
  defaults and an `/upload-fake/<id>` route standing in for `files.upload_
  v2`'s pre-signed URL step (outside `/api/`, compared separately via
  `uploadRequestsEqual`); `py_driver.py`'s `on_event` mode now dispatches
  `reaction_added` events to `Inbound._on_reaction` (Bolt registers it
  separately from `_on_event` — the driver was calling the wrong handler
  for every reaction event before this fix) and waits for the drain
  worker's queue to empty (+0.3s grace) before calling `stop()`, which
  otherwise raced the worker's `_lookup_pool.submit()` and reliably lost
  (`RuntimeError: cannot schedule new futures after shutdown` — a bug in
  the test harness itself, not the bridge: production only calls `stop()`
  at real process shutdown).

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima pnpm vitest run` green.
