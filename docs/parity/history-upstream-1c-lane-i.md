# Upstream sync 1c, lane I (historical)

> **Historical.** Web control plane + viewer.

## Upstream sync 1c, lane I (7d29f9e → 5458fee, web control plane + viewer)

Lane I carries `web/server/src/{chat,chat-links,control,safety,router,
trajectory}.ts` and `web/viewer/app/**`. Upstream commits assigned to this
lane: f68c1d8 (web part), c647609 (web part), 6c324d1 (web part — see item 4
below). Also closes a triage miss: f68c1d8's Slack-side
`chat_getPermalink`/`source_url` addition to `slack/src/headlong_slack/
inbound.py`, which UPSTREAM-TRIAGE-2.md's lane table left unassigned (lane
G's own PARITY.md section explicitly called it out as deferred/out of
scope, tagging 7 `parity/slack/run-parity.mjs` scenarios
`knownDivergence`).

### 1. f68c1d8 web part — mind-log Slack message links

Port of `chat.py`/`chat_links.py`/`control.py`/`safety.py`/`server.py`/
`trajectory.py`'s `source_url` plumbing:

- **New `web/server/src/chat-links.ts`** (port of the new `chat_links.py`):
  `resolveSourceUrl(message, known)` — a reply inherits the Slack permalink
  of the message it answers, by `reply_to` step_id, recording each
  message's resolved URL into `known` as it goes so the chain can run
  arbitrarily deep. Byte-identical logic to upstream: own `source_url` wins
  when present; otherwise inherit from `known[reply_to]`; a step with
  neither resolves to `null`.
- **`trajectory.ts`**: `_CHAT_FIELDS` gained `"source_url"`; `NormalizedStep`
  gained an optional `source_url` field; `Normalizer` gained a
  lifetime-scoped `messageSourceUrls` map (mirrors `_Normalizer.
  __init__`'s `self._message_source_urls`) and calls `resolveSourceUrl` for
  every `CHAT_MESSAGE_TYPES` step, storing the result on the normalized
  step — this is what lets `step-card.tsx`/`mindlog2-model.ts` (mind log)
  show the permalink even on a reply that carries no `source_url` of its
  own.
- **`chat.ts`**: `chatView()` gained its OWN `sourceUrls` map, scoped to one
  call (matches `chat_view()`'s local `source_urls: dict` — a fresh
  resolution over the whole chat index every call, independent of
  trajectory.ts's longer-lived one, exactly mirroring upstream's two
  separate call sites for `resolve_source_url`). `ChatMessage` gained
  `source_url`.
- **`safety.ts`**: new `isSlackPermalink(value)` — byte-identical port of
  `is_slack_permalink` (https scheme, `slack.com`/`*.slack.com` host,
  `/archives/` path prefix, 2048-char cap).
- **`control.ts`**: `chatSend()` gained an optional `sourceUrl` parameter;
  appends `--source-url <url>` to the `chat send` argv when present
  (mirrors `control.py`'s `chat_send`).
- **`router.ts`** (port of `server.py`'s two `/chat` routes): `POST
  .../chat` reads an optional `source_url` body field, 422s
  ("Invalid source URL") if present and not `isSlackPermalink`, and passes
  it through to `control.chatSend`. `GET .../chat` needed no route change
  — `chatView()` already returns the resolved field.
- **Viewer** (`web/viewer/app/**`, byte-identical port of the upstream
  React/TS diff — this half of f68c1d8 has no Python side to diff against):
  new `lib/source-links.ts` (`slackSourceUrl`/`slackConversationUrl`);
  `lib/types.ts` gained `ChatMessage.source_url` and `NormalizedStep.
  source_url?`; `lib/mindlog2-model.ts`'s `Ml2Card` gained `source_url`,
  falling back to a `slack-<user>-<channel>[-<ts>]` routing-name-derived
  `app_redirect` link when no real permalink is known; `components/
  step-card.tsx`'s `message` case and `routes/chat.tsx`'s `Bubble` and
  `routes/mindlog2.tsx`'s `StreamCard` each render an "Open in Slack" link
  when a source URL resolves.
- Tests: `web/server/test/chat-links.test.ts` (new, 3 cases, ports
  `test_chat_links.py` 1:1); `views.test.ts` gained a `chatView` case
  (`test_chat_slack_source_url_is_inherited_by_reply`); `normalize.test.ts`
  gained a `source_url` inheritance case (`test_reply_inherits_message_
  source_url`); `controls.test.ts` gained 2 cases (`test_chat_send_passes_
  slack_source_url`, the `source_url` validation half of `test_chat_send_
  validation`). The Python suite's cache-eviction assertions
  (`test_trajectory_cache.py::test_chat_index_survives_eviction`'s
  `raw is None` checks) don't apply — this port never evicts `raw` (see
  `trajectory.ts`'s file header) — so only the `source_url`-carrying half of
  that test was ported, not the eviction half.

### 2. f68c1d8 Slack part (triage miss) — `chat_getPermalink`/`source_url`

Closes the gap lane G's own PARITY.md section flagged as deferred:

- **`src/slack/api.ts`**: new `chatGetPermalink(channel, messageTs)` —
  `params=` (form) call to `chat.getPermalink`, read directly from the
  installed slack_sdk source (`web/client.py`'s `chat_getPermalink`:
  `http_verb="GET"` but still routed through the form/`params=` path like
  `reactions.get`/`conversations.replies`, not `json=`).
  `SlackClientLike` (inbound.ts) gained the matching method signature.
- **`src/slack/inbound.ts`**: `deliver()` now calls `chatGetPermalink`
  after building the chat POST body and before the retry loop, for every
  non-reaction message (`!msg.isReaction` — the SAME gate `cb974c2`
  introduced upstream, which this port already had in place per lane G's
  own note that `isReaction` was "ported anyway" for its other purpose).
  On success, `body.source_url = permalink`. On failure (any thrown
  error — missing scope, timeout, Slack outage), the error is logged and
  swallowed: a permalink is best-effort metadata, its lookup must never
  keep a human message out of the mind log — byte-identical semantics to
  upstream's `except Exception: log.warning(...)`.
- **`parity/slack/run-parity.mjs`**: the 7 `knownDivergence:
  KNOWN_PERMALINK_GAP` tags (dm-message-delivered, app-mention-in-channel-
  anchors-new-thread, mention-inside-existing-thread-anchors-at-thread-ts,
  duplicate-channel-ts-deduped, delivery-retries-then-slack-error-fallback,
  unicode-and-hostile-name-delivery, first-mention-backfill-prepends-
  prior-lines) are REMOVED, not loosened — every one of those scenarios now
  reaches plain PARITY because both languages make the identical
  `chat.getPermalink` call. The permalink-specific `isOnlyPermalinkDivergence`
  exemption function and the `KNOWN_PERMALINK_GAP` constant are deleted (the
  gap they existed to document is closed); the generic `knownDivergence`
  tag mechanism itself is left in place for any future genuine gap.
  `parity/slack/fake-server.mjs` gained a `chat.getPermalink` default
  response (a stable, deterministic permalink) so both drivers' inbound
  deliveries record the identical `source_url` — no driver (`py_driver.py`,
  `ts_driver.mjs`) changes needed, since both already construct their
  `WebClient` pointed at the fake server for every Slack method uniformly.
  Re-run: 23/23 PARITY (100%), 0 known-divergence (was 16/16 PARITY + 7
  known-divergence before this lane).
- Tests: `test/slack-inbound.test.ts` gained a new "chat_getPermalink /
  source_url (1c: f68c1d8)" describe block, 3 cases ported from
  `test_deliver_records_slack_permalink`/`test_permalink_failure_does_not_
  drop_message` plus one confirming the `isReaction` skip gate
  (`fakeClient()`'s default mock returns `{}` so pre-existing reaction
  tests are unaffected by the new unconditional-except-for-reactions call).

### 3. c647609 web part — strip `content_b64` from the dashboard/mind-log wire form

Port of `trajectory.py`'s new `_wire_raw()`:

- **`trajectory.ts`**: new `wireRaw(raw)` — returns `raw` unchanged when it
  has no `content_b64` key, otherwise a shallow copy with `content_b64`
  deleted. Applied where `NormalizedStep.raw` is constructed in `ingest()`
  (`raw: wireRaw(raw)`), matching upstream's `"raw": _wire_raw(raw)` at the
  same point in `_Normalizer.ingest`. **Deviation from upstream's shape,
  not its behavior**: Python applies `_wire_raw` a SECOND time, in
  `TrajectoryCache`'s window-rehydrate path, because that cache evicts and
  later re-reads raw records from disk; this port never evicts (whole file
  kept in memory — see the file's header comment), so there is only ever
  one site that constructs a step's `raw`, and stripping there is
  sufficient — no second call site exists to strip at.
  `filename`/`content` (the fields the UI actually renders) are left
  untouched; only `content_b64` (the base64 file bytes, `chat send-file`'s
  contribution per lane D / c647609's `bin/chat` half) is dropped, since it
  only inflates the wire JSON and is never rendered.
- The viewer needed no change: neither `step-card.tsx`'s `message` case nor
  `routes/chat.tsx`'s `Bubble` ever read `raw.content_b64` (confirmed by
  grep before touching either file) — they already only render `filename`/
  `content`, so stripping the field server-side is invisible to them by
  construction.
- Tests: `normalize.test.ts` gained two cases (`test_file_bytes_stripped_
  from_dashboard_raw` port, plus a no-op case for a step with no
  `content_b64` at all).

### 4. 6c324d1 web part — already fully ported by lane E, nothing left here

Checked `git show 6c324d1 -- web/` line by line: the ENTIRE web/ diff is
`web/src/headlong_web/thinker_sync.py` (+`web/tests/test_thinker_sync.py`)
— the bundled-`disabled`-marker-inherited-once-then-preserved change. That
is exactly what lane E's PARITY.md section item 5 ("`web/server/src/
thinker-sync.ts` `sync()`: bundled `disabled` marker inherited on first
install only") already ported, byte-for-byte, before this lane started. No
other file under `web/` appears in `6c324d1`'s diff. No code change needed
in this lane for this commit.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `npx vitest run` green; `parity/slack/run-parity.mjs` 23/23
PARITY, 0 known-divergence.

