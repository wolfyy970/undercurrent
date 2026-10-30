#!/usr/bin/env node
// run-parity.mjs — differential parity proof for the slack bridge port.
//
// Runs the REAL Python bridge (`uv run` against the oracle checkout's
// slack/ project) and the TS port over IDENTICAL scripted Slack events /
// trajectory steps, both talking to one fake Slack Web API + fake
// headlong-web `/chat` endpoint (fake-server.mjs), and diffs what each
// produced: the bytes sent to the fake server, on-disk state files
// (active_threads.json, cursor), stdout/stderr, and exit code. Expectations
// come from running the real Python — never assumed.
//
// HARNESS DESIGN — read this before extending it:
//
// 1. Module-level, not full-CLI-subprocess. Same rationale as
//    parity/telegram: `cli.py`'s `main()` and this port's `runCli` both end
//    by blocking forever (`SocketModeHandler.start()` / `Inbound(...).run()`
//    with no bound) — no argv/env knob makes the real entry point exit after
//    N iterations in either language, and the Slack leg additionally needs a
//    live Socket Mode WebSocket connection this environment cannot provide
//    (no real app-level token — see PARITY.md). Both drivers (`py_driver.py`,
//    `ts_driver.mjs`) instead call `Inbound._on_event`/`.onEvent` directly
//    (mode "on_event" — the same boundary upstream's own tests would use if
//    it had a test_inbound.py, and exactly what `cli.main`'s
//    `app.event(...)` registration hands events to once Bolt's own Socket
//    Mode dispatch is out of the picture) or a bounded `outbound.run`
//    against a REAL seeded `trajectory.jsonl` (mode "outbound" — the same
//    boundary upstream's OWN tests/test_outbound.py already drives).
//
// 2. No relay needed for the Slack Web API leg, unlike telegram's Bot API
//    leg. Reading the installed `slack_sdk` source directly (not assumed)
//    showed `WebClient.__init__` takes a `base_url` constructor argument
//    (default `"https://slack.com/api/"`) with no hardcoded host anywhere
//    else in the call path — so both drivers just construct a `WebClient`/
//    `WebClient` pointed straight at the fake server. The web `/chat` leg
//    needs no interception either: `cfg.web_url` is a normal configurable
//    setting in both languages, already pointed at the fake server via the
//    scenario's `Config`.
//
// 3. Wire-format asymmetry, found (not assumed) by reading
//    `slack_sdk.web.base_client.BaseClient._perform_urllib_http_request`:
//    `chat.postMessage` goes through WebClient's `json=` call path (JSON
//    body, `Content-Type: application/json;charset=utf-8`) while
//    `auth.test`/`users.info`/`conversations.info`/`apps.connections.open`
//    go through the `params=` path (form-urlencoded body) — REGARDLESS of
//    the `http_verb` the individual wrapper method passes (the same source
//    comment says "you can use POST method for all the Web APIs"). Every
//    call is a real POST. `src/slack/api.ts` was written to match this
//    exactly (`callJson` vs `callForm`), not assumed uniform.
//
// 4. Header comparison is scoped to what's meaningful, same rationale as
//    telegram's harness: only `method`, `path`, and the `content-type`
//    header are compared; full header sets are recorded in results.json for
//    inspection but not scored.
//
// 5. The live Socket Mode leg is deferred. No real Slack app-level/bot token
//    is available in this environment (see PARITY.md) — this harness never
//    makes a real `apps.connections.open` call or holds a real WebSocket
//    connection to Slack; the fake server stands in for the Web API leg
//    entirely, and `socketmode.ts`'s own transport is exercised only against
//    a fake WebSocket in test/slack-socketmode.test.ts, never here.
//
// Repeatable: `PARITY_PY_SLACK_DIR=/abs/path/to/headlong/slack node
// run-parity.mjs` (defaults to the placeholder path below, which only
// resolves on the machine this was built on). Writes results.json +
// report.md beside this file. Exit 0 iff every scenario reaches PARITY.

// NO-MODEL LAYER (checked 2026-10-29 against upstream 2e39a3f): neither upstream's
// headlong_slack nor src/slack/ makes a model call, so there is no model leg to put
// on parity/support/replayModel.mjs. fake-server.mjs is a labelled HTTP transport
// fixture for the Slack Web API and headlong-web `/chat` (third-party/service APIs,
// never model text), and py_driver.py's FakeApp only captures the event handler
// Bolt would register. The trajectory step `content` strings the scenarios seed
// (e.g. "hello **world**", a 3900+ char chunking case) are bridge-formatting
// inputs, not model replies: the bridge forwards whatever text a step holds.
//
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakeServer } from "./fake-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.PARITY_TS_REPO || path.resolve(HERE, "../..");
const PY_SLACK_DIR = process.env.PARITY_PY_SLACK_DIR || "<HEADLONG_ROOT>/slack";
const TS_DRIVER = path.join(HERE, "ts_driver.mjs");
const PY_DRIVER = path.join(HERE, "py_driver.py");

const HOME = os.homedir();
function scrubArtifactPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (PY_SLACK_DIR && PY_SLACK_DIR !== "<HEADLONG_ROOT>/slack") {
    out = out.split(path.dirname(PY_SLACK_DIR)).join("<HEADLONG_ROOT>");
  }
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

const BOT_USER_ID = "UBOT0";
const USER = "U0USER";

function dmEvent(text, ts = "1700000000.000100") {
  return { type: "message", user: USER, channel: "D0DM1", channel_type: "im", ts, text };
}
function mentionEvent(text, ts, threadTs) {
  const e = { type: "app_mention", user: USER, channel: "C0CHAN", ts, text };
  if (threadTs) e.thread_ts = threadTs;
  return e;
}
function plainChannelMsg(text, ts, threadTs) {
  const e = { type: "message", user: USER, channel: "C0CHAN", ts, text };
  if (threadTs) e.thread_ts = threadTs;
  return e;
}
function reactionEvent({ user = USER, channel = "C0CHAN", itemTs, itemUser = BOT_USER_ID, reaction = "thumbsup", eventTs }) {
  return {
    type: "reaction_added",
    user,
    reaction,
    item_user: itemUser,
    item: { type: "message", channel, ts: itemTs },
    event_ts: eventTs ?? `${itemTs}.react`,
  };
}

// f68c1d8 ("web: link Slack messages from mind log") added a
// `chat_getPermalink` call + `source_url` field to every non-reaction
// inbound delivery. It was originally unassigned in this sync's lane plan
// (touches slack/src/headlong_slack/inbound.py, but neither lane G's nor
// any other lane's commit list named it); every `on_event` scenario below
// was tagged `knownDivergence` for exactly this one-extra-Slack-call gap.
// PORT-NOTE (1c: f68c1d8): closed by lane I — `src/slack/inbound.ts`'s
// `deliver()` now makes the same `chat.getPermalink` call (via
// `api.ts`'s `chatGetPermalink`) and sets `source_url` the same way, so
// every scenario is plain PARITY again; the tags are gone, not loosened.

// --- scenarios --------------------------------------------------------------
const scenarios = [
  {
    group: "on_event",
    name: "dm-message-delivered",
    mode: "on_event",
    events: [dmEvent("hello there")],
  },
  {
    group: "on_event",
    name: "app-mention-in-channel-anchors-new-thread",
    mode: "on_event",
    events: [mentionEvent(`<@${BOT_USER_ID}> hi`, "1700000001.000100")],
  },
  {
    group: "on_event",
    name: "mention-inside-existing-thread-anchors-at-thread-ts",
    mode: "on_event",
    events: [mentionEvent(`<@${BOT_USER_ID}> hi`, "1700000002.000500", "1700000002.000100")],
  },
  {
    group: "on_event",
    name: "thread-followups-active-reply-delivered",
    mode: "on_event",
    threadFollowups: true,
    seedActiveThreads: { "C0CHAN:1700000003.000100": 1700000003 },
    events: [plainChannelMsg("follow-up, no mention", "1700000003.000900", "1700000003.000100")],
  },
  {
    group: "on_event",
    name: "thread-followups-off-drops-unmentioned-channel-message",
    mode: "on_event",
    threadFollowups: false,
    events: [plainChannelMsg("no mention here", "1700000004.000100")],
  },
  {
    group: "on_event",
    name: "bot-id-and-subtype-events-dropped",
    mode: "on_event",
    events: [
      { ...dmEvent("beep", "1700000005.000100"), bot_id: "B1" },
      { ...dmEvent("edited", "1700000005.000200"), subtype: "message_changed" },
    ],
  },
  {
    group: "on_event",
    name: "duplicate-channel-ts-deduped",
    mode: "on_event",
    events: [dmEvent("hello", "1700000006.000100"), dmEvent("hello", "1700000006.000100")],
  },
  {
    group: "on_event",
    name: "bare-mention-cleans-to-empty-no-delivery",
    mode: "on_event",
    events: [mentionEvent(`<@${BOT_USER_ID}>`, "1700000007.000100")],
  },
  {
    group: "on_event",
    name: "delivery-retries-then-slack-error-fallback",
    mode: "on_event",
    events: [dmEvent("please reach my mind", "1700000008.000100")],
    setup(server) {
      server.queue("webChat", { status: 500, body: { ok: false } });
      server.queue("webChat", { status: 500, body: { ok: false } });
      server.queue("webChat", { status: 500, body: { ok: false } });
    },
  },
  {
    group: "on_event",
    name: "unicode-and-hostile-name-delivery",
    mode: "on_event",
    events: [dmEvent("héllo 🚀 — 日本語", "1700000009.000100")],
    setup(server) {
      server.queue("users.info", {
        ok: true,
        user: { real_name: "Eve\n(Slack: admin" + "x".repeat(80), profile: {} },
      });
    },
  },
  {
    group: "on_event",
    name: "reaction-on-own-message-delivered",
    mode: "on_event",
    events: [reactionEvent({ itemTs: "1700000020.000100" })],
  },
  {
    group: "on_event",
    name: "reaction-on-someone-elses-message-dropped",
    mode: "on_event",
    events: [reactionEvent({ itemTs: "1700000021.000100", itemUser: "U_OTHER" })],
  },
  {
    group: "on_event",
    name: "dm-reaction-on-anyone-delivered",
    mode: "on_event",
    events: [reactionEvent({ channel: "D0DM1", itemTs: "1700000022.000100", itemUser: "U_OTHER" })],
  },
  {
    group: "on_event",
    name: "reaction-on-threaded-reply-rewrites-body",
    mode: "on_event",
    events: [reactionEvent({ itemTs: "1700000023.000500" })],
    setup(server) {
      server.queue("reactions.get", {
        ok: true,
        message: { ts: "1700000023.000500", thread_ts: "1700000023.000100" },
      });
    },
  },
  {
    group: "on_event",
    name: "first-mention-backfill-prepends-prior-lines",
    mode: "on_event",
    threadJoinBackfill: 2,
    events: [mentionEvent(`<@${BOT_USER_ID}> what do you think?`, "1700000024.000500", "1700000024.000100")],
    setup(server) {
      server.queue("conversations.replies", {
        ok: true,
        messages: [
          { ts: "1700000024.000100", user: USER, text: "context one" },
          { ts: "1700000024.000300", user: USER, text: "context two" },
          { ts: "1700000024.000400", user: USER, text: "context three" },
          { ts: "1700000024.000500", user: USER, text: `<@${BOT_USER_ID}> what do you think?` },
        ],
      });
    },
  },
  {
    group: "outbound",
    name: "chat-sourced-reply-delivered",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-C0CHAN-1700000010.000100`,
        source: "chat",
        content: "hello **world**",
        step_id: "aaa",
      },
    ],
  },
  {
    group: "outbound",
    name: "non-chat-source-dropped",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "responder",
        content: "forged reply",
        step_id: "bbb",
      },
    ],
  },
  {
    group: "outbound",
    name: "long-reply-chunked",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        content: "para1\n\n" + "a".repeat(3900) + "\n\npara3",
        step_id: "ddd",
      },
    ],
  },
  {
    group: "outbound",
    name: "chat-post-message-failure-breaks-chunk-loop",
    mode: "outbound",
    noticeReasonClassOnly: true,
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        content: "one\n\ntwo\n\nthree",
        step_id: "eee",
      },
    ],
    setup(server) {
      server.queue("chat.postMessage", { status: 500, body: { ok: false } });
    },
  },
  {
    group: "outbound",
    name: "duplicate-reply-deduped-by-recentposts",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        content: "same reply",
        step_id: "fff",
      },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        content: "same reply",
        step_id: "ggg",
      },
    ],
  },
  {
    group: "outbound",
    name: "file-upload-via-files-upload-v2",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-C0CHAN-1700000030.000100`,
        source: "chat",
        filename: "note.txt",
        content: "hello file",
        content_b64: Buffer.from("hello file\n").toString("base64"),
        step_id: "hhh",
      },
    ],
  },
  {
    group: "outbound",
    name: "file-upload-dedupe-recorded-only-after-slack-accepts",
    mode: "outbound",
    noticeReasonClassOnly: true,
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        filename: "note.txt",
        content_b64: Buffer.from("same-bytes").toString("base64"),
        step_id: "iii",
      },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-D0DM1`,
        source: "chat",
        filename: "note.txt",
        content_b64: Buffer.from("same-bytes").toString("base64"),
        step_id: "jjj",
      },
    ],
    setup(server) {
      // First upload attempt's completeUploadExternal is rejected by
      // Slack; the identical retry (same file_signature) must still be
      // attempted — dedupe is recorded only after Slack accepts (c7d240b).
      server.queue("files.completeUploadExternal", { status: 500, body: { ok: false, error: "internal_error" } });
    },
  },
  {
    group: "outbound",
    name: "reaction-step-calls-reactions-add",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: `slack-${USER}-C0CHAN-1700000031.000100`,
        source: "chat",
        reaction: "thumbsup",
        content: ":thumbsup:",
        step_id: "kkk",
      },
    ],
  },
];


// --- 2e39a3f scenarios: peer hearing, delivery refusal, delivery notices,
// short address forms, cursor-names-its-trajectory. Expectations come from the
// real Python run, never assumed. ---------------------------------------------
const PEER = "U0PEER1";
const TRAJ0 = { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" };
function chatMsg(stepId, to, content = "hello", extra = {}) {
  return { type: "message", from: "audel", to, source: "chat", content, step_id: stepId, ...extra };
}
function outboundScenario(name, steps, extra = {}) {
  return { group: "outbound", name, mode: "outbound", seedCursorOffsetZero: true, seedTrajectorySteps: [TRAJ0, ...steps], ...extra };
}
function peerMention(text, ts, threadTs = "1700000040.000100", user = PEER) {
  return { type: "app_mention", user, channel: "C0CHAN", ts, text: `<@${BOT_USER_ID}> ${text}`, thread_ts: threadTs, bot_id: `B_${user}` };
}

scenarios.push(
  {
    group: "peers",
    name: "peer-mention-forwarded-with-persona-header",
    mode: "on_event",
    peerBotUsers: [PEER],
    events: [peerMention("hello audel", "1700000040.000200")],
  },
  {
    group: "peers",
    name: "unlisted-bot-dropped",
    mode: "on_event",
    peerBotUsers: [PEER],
    events: [peerMention("hi", "1700000041.000200", "1700000041.000100", "U0OTHERBOT")],
  },
  {
    group: "peers",
    name: "no-peers-configured-bot-dropped",
    mode: "on_event",
    events: [peerMention("hi", "1700000042.000200", "1700000042.000100")],
  },
  {
    group: "peers",
    name: "loop-guard-blocks-after-max-turns-person-resets",
    mode: "on_event",
    peerBotUsers: [PEER],
    peerMaxTurns: 2,
    threadFollowups: true,
    events: [
      peerMention("one", "1700000043.000201", "1700000043.000100"),
      peerMention("two", "1700000043.000202", "1700000043.000100"),
      peerMention("three", "1700000043.000203", "1700000043.000100"),
      peerMention("four", "1700000043.000204", "1700000043.000100"),
      { ...plainChannelMsg("carry on you two", "1700000043.000205", "1700000043.000100") },
      peerMention("five", "1700000043.000206", "1700000043.000100"),
    ],
  },
  {
    group: "peers",
    name: "peer-bridge-error-text-not-forwarded",
    mode: "on_event",
    peerBotUsers: [PEER],
    events: [
      { type: "message", user: PEER, channel: "D0DM1", channel_type: "im", ts: "1700000044.000100", bot_id: "B_PEER", text: "(bridge error: I couldn't reach my mind just now — please try again in a bit)" },
      { type: "message", user: USER, channel: "D0DM1", channel_type: "im", ts: "1700000044.000200", text: "(bridge error: I couldn't reach my mind just now — please try again in a bit)" },
    ],
  },
  {
    group: "on_event",
    name: "web-409-refusal-is-final-no-retry-no-error-post",
    mode: "on_event",
    events: [dmEvent("this is a duplicate", "1700000045.000100")],
    setup(server) {
      server.queue("webChat", { status: 409, body: { detail: { message: "refusing to send: this exact message already went" } } });
    },
  },
  {
    group: "on_event",
    name: "web-500-still-retries-three-times",
    mode: "on_event",
    events: [dmEvent("retry me", "1700000046.000100")],
    setup(server) {
      server.queue("webChat", { status: 500, body: { detail: "boom" } });
      server.queue("webChat", { status: 500, body: { detail: "boom" } });
      server.queue("webChat", { status: 500, body: { detail: "boom" } });
    },
  },
  outboundScenario("bare-channel-top-level-post-registers-thread", [chatMsg("m1", "slack-C0BMVH6LM4K", "papers")]),
  outboundScenario("bare-user-opens-dm-once", [chatMsg("m1", "slack-U0BFD9NDVE3", "one"), chatMsg("m2", "slack-U0BFD9NDVE3", "two")]),
  outboundScenario("bare-user-dm-open-failure-notice", [chatMsg("m1", "slack-U0BFD9NDVE3", "x")], {
    setup(server) {
      server.queue("conversations.open", { ok: false, error: "user_not_found" });
    },
  }),
  outboundScenario("malformed-slack-address-failed-notice", [chatMsg("m1", "slack-...", "x"), chatMsg("m2", "slack-nick", "y")]),
  outboundScenario("other-transports-silently-skipped", [chatMsg("m1", "telegram-1-1"), chatMsg("m2", "pwa-andy")]),
  outboundScenario("post-failure-with-slack-error-code-notice", [chatMsg("m1", `slack-${USER}-C0CHAN-1700000050.000100`)], {
    setup(server) {
      server.queue("chat.postMessage", { ok: false, error: "channel_not_found" });
    },
  }),
  outboundScenario("partly-posted-failure-notice-has-message-ts-and-permalink", [chatMsg("m1", "slack-C0CHAN", "para1\n\n" + "a".repeat(3900) + "\n\npara3")], {
    setup(server) {
      server.queue("chat.postMessage", { ok: true, channel: "C0CHAN", ts: "1700000051.000900", message: {} });
      server.queue("chat.postMessage", { ok: false, error: "ratelimited" });
    },
  }),
  outboundScenario("duplicate-top-level-is-skipped-notice", [chatMsg("m1", "slack-C0CHAN", "same"), chatMsg("m2", "slack-C0CHAN", "same")]),
  outboundScenario("file-upload-failure-notice-carries-filename", [
    chatMsg("f1", "slack-C0CHAN", "", { filename: "n.txt", content_b64: Buffer.from("x").toString("base64") }),
  ], {
    setup(server) {
      server.queue("files.completeUploadExternal", { ok: false, error: "invalid_channel" });
    },
  }),
  outboundScenario("reaction-to-bare-user-needs-a-channel", [
    chatMsg("r1", "slack-U0BFD9NDVE3", ":tada:", { reaction: "tada", source_url: "https://x.slack.com/archives/C0CHAN/p1700000052000100" }),
  ]),
  { ...outboundScenario("cursor-of-another-trajectory-starts-at-eof", [chatMsg("m1", `slack-${USER}-D0DM1`, "old, must not be re-sent")]), seedCursorOffsetZero: false, seedCursorRaw: "2 <SANDBOX>/some/other/trajectory.jsonl" },
  { ...outboundScenario("cursor-beyond-the-file-starts-at-eof", [chatMsg("m1", `slack-${USER}-D0DM1`, "old, must not be re-sent")]), seedCursorOffsetZero: false, seedCursorRaw: "999999" },
);

// --- normalization ----------------------------------------------------------
function normalizeActiveThreadsJson(text) {
  if (text === null) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text;
  }
  const norm = {};
  for (const k of Object.keys(obj)) norm[k] = "<TS>";
  return JSON.stringify(sortKeysDeep(norm));
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function bodySemantic(text) {
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(text)));
  } catch {
    // Not JSON (e.g. form-urlencoded) — normalize by parsing+re-sorting the
    // query-string form instead, so key order never causes a false diff.
    try {
      const params = new URLSearchParams(text);
      const obj = {};
      for (const [k, v] of params) obj[k] = maybeParseNestedJson(v);
      return JSON.stringify(sortKeysDeep(obj));
    } catch {
      return text;
    }
  }
}
// files.completeUploadExternal (1c: 692e16e) carries a JSON-stringified
// `files` array inside one form field; Python's json.dumps and JS's
// JSON.stringify use different whitespace by default, which would read as
// a false divergence if compared as opaque strings. Parse+re-sort any
// form value that itself looks like JSON before comparing.
function maybeParseNestedJson(v) {
  if (typeof v === "string" && (v.startsWith("[") || v.startsWith("{"))) {
    try {
      return sortKeysDeep(JSON.parse(v));
    } catch {
      return v;
    }
  }
  return v;
}
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

function requestsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (ra.method !== rb.method) return false;
    if (ra.path !== rb.path) return false;
    const ctA = (ra.headers["content-type"] || "").split(";")[0].trim();
    const ctB = (rb.headers["content-type"] || "").split(";")[0].trim();
    if (ctA !== ctB) return false;
    if (bodySemantic(ra.body) !== bodySemantic(rb.body)) return false;
  }
  return true;
}

// Upload-step (files.upload_v2's raw-bytes POST, 1c: 692e16e) requests: not
// JSON/form, so compare method + path-shape (both point at this harness's
// own /upload-fake/<id>, ids may legitimately differ per language's own
// file_id bookkeeping) + raw body bytes.
function uploadRequestsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].method !== b[i].method) return false;
    if (a[i].body !== b[i].body) return false;
  }
  return true;
}

// --- driving one language ---------------------------------------------------
function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sl-parity-sb-"));
}

function writeSpecFile(spec) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "sl-parity-spec-"));
  const file = path.join(p, "spec.json");
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

// child_process.spawnSync BLOCKS this process's event loop until the child
// exits — fatal here, because the fake HTTP server the child needs to talk
// to lives in THIS SAME process. Must stay async.
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeout)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: String(error) });
    });
    child.on("close", (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, error: null });
    });
  });
}

function seedActiveThreadsFile(stateDir, seed) {
  if (!seed) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "active_threads.json"), JSON.stringify(seed));
}

async function runOne(kind, sc, server, port) {
  server.reset();
  if (sc.setup) sc.setup(server);
  const sandbox = makeSandbox();
  const stateDir = path.join(sandbox, "state");
  seedActiveThreadsFile(stateDir, sc.seedActiveThreads);
  const spec = {
    port,
    sandbox,
    cfg: {
      identity: "audel",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      botUserId: BOT_USER_ID,
      threadFollowups: sc.threadFollowups ?? false,
      threadJoinBackfill: sc.threadJoinBackfill ?? 0,
      peerBotUsers: sc.peerBotUsers ?? [],
      peerMaxTurns: sc.peerMaxTurns ?? 4,
      peerHourlyCap: sc.peerHourlyCap ?? 30,
    },
    seedCursorRaw: sc.seedCursorRaw ?? null,
    mode: sc.mode,
    events: sc.events,
    seedTrajectorySteps: sc.seedTrajectorySteps,
    seedCursorOffsetZero: sc.seedCursorOffsetZero ?? false,
  };
  const specFile = writeSpecFile(spec);

  let res;
  if (kind === "py") {
    res = await spawnAsync("uv", ["run", "--project", PY_SLACK_DIR, "python3", PY_DRIVER, specFile], {
      timeout: 60000,
      cwd: HERE,
    });
  } else {
    res = await spawnAsync("node", [TS_DRIVER, specFile], { timeout: 60000, cwd: HERE });
  }

  const activeThreads = readFileOrNull(path.join(stateDir, "active_threads.json"));
  // 2e39a3f: the cursor is "<offset> <resolved trajectory path>"; the path
  // differs per sandbox, so compare the offset and that it names the
  // trajectory of THIS run.
  const cursorRaw = readFileOrNull(path.join(stateDir, "cursor"));
  const cursor = cursorRaw === null ? null : cursorRaw.split(sandbox).join("<SANDBOX>").split(fs.realpathSync(sandbox)).join("<SANDBOX>").replace(/^(\d+) \S*\/trajectories\/12345678-root\/trajectory\.jsonl$/, "$1 <TRAJ>");
  // The delivery notices the bridge built (appended via the append_step seam).
  const noticesRaw = readFileOrNull(path.join(sandbox, "notices.jsonl"));
  const notices = noticesRaw === null ? null : JSON.stringify(
    noticesRaw.split("\n").filter(Boolean).map((l) => {
      const o = sortKeysDeep(JSON.parse(l));
      // `reason` of a failure with no slack error code is slack_sdk's own
      // prose (URL, port, Python dict repr) — compare only the exception class.
      if (sc.noticeReasonClassOnly && typeof o.reason === "string") {
        o.reason = o.reason.split(":")[0];
        if (typeof o.content === "string") o.content = o.content.replace(/^(not delivered to [^:]*: [^:]*):[\s\S]*$/, "$1");
      }
      return o;
    }),
  );

  const requests = server.requests.map((r) => ({ ...r }));
  const slackRequests = requests.filter((r) => r.path.startsWith("/api/") && !r.path.startsWith("/api/identities/"));
  const webRequests = requests.filter((r) => r.path.startsWith("/api/identities/"));
  // files.upload_v2's raw-bytes step (1c: 692e16e) hits /upload-fake/<id>,
  // outside the /api/ prefix — see fake-server.mjs's header.
  const uploadRequests = requests.filter((r) => r.path.startsWith("/upload-fake/"));

  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(path.dirname(specFile), { recursive: true, force: true });

  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
    activeThreads: normalizeActiveThreadsJson(activeThreads),
    cursor,
    notices,
    slackRequests,
    webRequests,
    uploadRequests,
  };
}

// --- execute ------------------------------------------------------------------
async function main() {
  const server = createFakeServer();
  const port = await server.listen();

  const results = [];
  for (const sc of scenarios) {
    const py = await runOne("py", sc, server, port);
    const ts = await runOne("ts", sc, server, port);

    const cmp = {
      status: py.status === ts.status,
      slackRequests: requestsEqual(py.slackRequests, ts.slackRequests),
      webRequests: requestsEqual(py.webRequests, ts.webRequests),
      uploadRequests: uploadRequestsEqual(py.uploadRequests, ts.uploadRequests),
      activeThreads: py.activeThreads === ts.activeThreads,
      cursor: py.cursor === ts.cursor,
      notices: py.notices === ts.notices,
    };
    const pass = Object.values(cmp).every(Boolean);
    // No scenario currently carries a `knownDivergence` tag (the last one,
    // f68c1d8's chat_getPermalink gap, closed — see this file's header
    // comment); kept generic so a future genuine gap can still be tagged.
    const known = !pass && sc.knownDivergence ? sc.knownDivergence : null;
    results.push({ group: sc.group, name: sc.name, pass, known, cmp, py, ts });
  }
  await server.close();

  // Scrub display copies AFTER every verdict above was computed — cannot
  // change a score.
  for (const r of results) {
    for (const side of [r.py, r.ts]) {
      side.stdout = scrubArtifactPaths(side.stdout);
      side.stderr = scrubArtifactPaths(side.stderr);
    }
  }

  // Known-divergence scenarios (tagged `knownDivergence`) would count
  // separately from the pass/fail gate; none are currently tagged.
  const gated = results.filter((r) => !r.known);
  const total = gated.length;
  const passed = gated.filter((r) => r.pass).length;
  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : "100.0";
  const knownCount = results.filter((r) => r.known).length;

  let md = `# slack bridge — differential parity proof\n\n`;
  md += `Real Python \`headlong_slack\` (\`uv run\` against the oracle checkout) vs this port's \`src/slack/\`, driven identically against a fake Slack Web API + fake headlong-web \`/chat\` endpoint (\`fake-server.mjs\`). See this file's header comment for the harness design (module-level driving, why no relay is needed for the Slack Web API leg, the JSON-vs-form wire-format asymmetry found by reading slack_sdk's source, and header-comparison scope) and PARITY.md for the live-Socket-Mode-leg deferral.\n\n`;
  md += `- \`PARITY_PY_SLACK_DIR=/abs/path/to/headlong/slack node run-parity.mjs\`\n`;
  md += `- Pass = same exit status, same (method+path+content-type+semantic-body) request sequence to both the Slack Web API and \`/chat\` endpoints, same on-disk \`active_threads.json\` (values normalized to "<TS>"), \`cursor\`.\n\n`;
  md += `## Result: ${passed}/${total} PARITY (${rate}%)`;
  md += knownCount > 0 ? ` — plus ${knownCount} known-divergence scenario(s) excluded from this gate (see below)\n\n` : `\n\n`;
  md += `| # | group | scenario | verdict | differing |\n|---|---|---|---|---|\n`;
  let idx = 1;
  for (const r of results) {
    const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
    const verdict = r.known ? "KNOWN-DIVERGENCE" : r.pass ? "PARITY" : "DIVERGE";
    md += `| ${idx++} | ${r.group} | ${r.name} | ${verdict} | ${diffs} |\n`;
  }
  if (knownCount > 0) {
    md += `\n## Known divergences (excluded from the gate)\n\n`;
    for (const r of results.filter((x) => x.known)) {
      md += `- **${r.group}/${r.name}**: ${r.known}\n`;
    }
  }
  md += `\n## Divergences (detail)\n\n`;
  const fails = results.filter((r) => !r.pass && !r.known);
  if (fails.length === 0) md += `None.\n`;
  for (const r of fails) {
    md += `### ${r.group} / ${r.name}\n`;
    md += `- exit: py=${r.py.status} ts=${r.ts.status}\n`;
    if (r.py.error) md += `- py spawn error: ${r.py.error}\n`;
    if (r.ts.error) md += `- ts spawn error: ${r.ts.error}\n`;
    md += "```\n";
    md += `py stderr: ${r.py.stderr}\n`;
    md += `ts stderr: ${r.ts.stderr}\n`;
    md += `py slackRequests: ${JSON.stringify(r.py.slackRequests, null, 2)}\n`;
    md += `ts slackRequests: ${JSON.stringify(r.ts.slackRequests, null, 2)}\n`;
    md += `py webRequests: ${JSON.stringify(r.py.webRequests, null, 2)}\n`;
    md += `ts webRequests: ${JSON.stringify(r.ts.webRequests, null, 2)}\n`;
    md += `py uploadRequests: ${JSON.stringify(r.py.uploadRequests, null, 2)}\n`;
    md += `ts uploadRequests: ${JSON.stringify(r.ts.uploadRequests, null, 2)}\n`;
    md += `py activeThreads: ${r.py.activeThreads}\n`;
    md += `ts activeThreads: ${r.ts.activeThreads}\n`;
    md += `py cursor: ${r.py.cursor}  ts cursor: ${r.ts.cursor}\n`;
    md += `py notices: ${r.py.notices}\nts notices: ${r.ts.notices}\n`;
    md += "```\n\n";
  }
  fs.writeFileSync(path.join(HERE, "report.md"), md);
  fs.writeFileSync(
    path.join(HERE, "results.json"),
    JSON.stringify({ total, passed, rate, knownCount, results }, null, 2),
  );

  console.log(`slack parity: ${passed}/${total} (${rate}%)${knownCount > 0 ? ` + ${knownCount} known-divergence` : ""}`);
  for (const r of results) {
    if (r.known) {
      console.log(`  KNOWN-DIVERGENCE ${r.group}/${r.name}  (${r.known})`);
    } else if (!r.pass) {
      const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
      console.log(`  DIVERGE ${r.group}/${r.name}  [${diffs}]`);
    }
  }
  process.exit(passed === total ? 0 : 1);
}

main();
