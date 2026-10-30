#!/usr/bin/env node
// run-parity.mjs — differential parity proof for the telegram bridge port.
//
// Runs the REAL Python bridge (`uv run` against the oracle checkout's
// telegram/ project) and the TS port over IDENTICAL scripted Telegram
// updates / trajectory steps, both talking to one fake Telegram Bot API +
// fake headlong-web `/chat` endpoint (fake-server.mjs), and diffs what each
// produced: the bytes sent to the fake server, on-disk state files
// (allowlist.json, update_offset, cursor), stdout/stderr, and exit code.
// Expectations come from running the real Python — never assumed.
//
// HARNESS DESIGN — read this before extending it:
//
// 1. Module-level, not full-CLI-subprocess. `cli.py`'s `main()` and this
//    port's `runCli` both end by blocking forever on the inbound long-poll
//    loop (`Inbound(...).run()` with no bound) — there is no argv/env knob
//    to make the real production entry point exit after N iterations for
//    either language, so spawning the literal CLI binary as a subprocess and
//    waiting for it to finish is not viable (it would hang). Both drivers
//    (`py_driver.py`, `ts_driver.mjs`) instead construct `Config`/`Bot`/
//    `Allowlist` directly and call `Inbound._handle`/`.handle` (mode
//    "handle"), a bounded `Inbound.run`/`.run` (mode "run-poll", exercising
//    the real getUpdates poll loop + offset persistence), or a bounded
//    `outbound.run` against a REAL seeded trajectory.jsonl (mode
//    "outbound") — the same boundary upstream's OWN test_inbound.py /
//    test_outbound.py already drive directly (`ib._handle(...)`,
//    `outbound.run(cfg, bot, allowlist, stop_event)`).
//
// 2. The Bot API leg needs a relay; the web `/chat` leg does not. `cfg.web_url`
//    is a normal, already-configurable setting in BOTH languages
//    (HEADLONG_WEB_URL / the `Config.webUrl` field) — both drivers just point
//    it straight at the fake server, no interception needed, and the fake
//    server's `/api/identities/*/chat` handler receives and records the real
//    bytes. The Telegram Bot API host IS hardcoded in both languages
//    (`https://api.telegram.org/...`), with no such override. The TS side
//    reaches the fake server via `Bot`'s already-existing `fetchImpl`
//    injection seam (added for unit testing, see api.ts) rewriting the
//    origin only. The Python side — which must not be modified — reaches it
//    exactly the way the oracle's OWN tests/test_api.py and
//    tests/test_inbound.py already do: swap `Bot._client` for an
//    `httpx.Client(transport=httpx.MockTransport(...))`. The difference here
//    is the MockTransport handler RELAYS every request over a real HTTP call
//    to the fake server (see py_driver.py's `make_relay`) instead of
//    answering in-process, so the fake server genuinely receives and records
//    the same request both languages would have sent to api.telegram.org.
//
// 3. Header comparison is scoped to what's meaningful. httpx (Python) and
//    Node's fetch/undici (TS) attach different default headers (User-Agent,
//    Accept, Accept-Encoding, Connection, Host) — an inherent property of
//    using two different HTTP client stacks, not a port bug. Only `method`,
//    `path`, and the `content-type` header are compared; full header sets
//    are recorded in results.json for inspection but not scored.
//
// 4. The live Telegram leg is deferred. No real bot token is available in
//    this environment (see PARITY.md) — this harness never talks to
//    api.telegram.org itself, by design; the fake server stands in for it
//    entirely, scripted per scenario.
//
// Repeatable: `PARITY_PY_TELEGRAM_DIR=/abs/path/to/headlong/telegram node
// run-parity.mjs` (defaults to the placeholder path below, which only
// resolves on the machine this was built on). Writes results.json +
// report.md beside this file. Exit 0 iff every scenario reaches PARITY.

// NO-MODEL LAYER (checked 2026-10-29 against upstream 2e39a3f): neither upstream's
// headlong_telegram nor src/telegram/ makes a model call, so there is no model leg
// to put on parity/support/replayModel.mjs. fake-server.mjs is a labelled HTTP
// transport fixture for the Telegram Bot API and headlong-web `/chat` (never model
// text); py_driver.py's MockTransport only RELAYS to it. The trajectory step
// `content` strings the scenarios seed are bridge-formatting inputs, not model
// replies: the bridge forwards whatever text a step holds.
//
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakeServer } from "./fake-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.PARITY_TS_REPO || path.resolve(HERE, "../..");
const PY_TELEGRAM_DIR = process.env.PARITY_PY_TELEGRAM_DIR || "<HEADLONG_ROOT>/telegram";
const TS_DRIVER = path.join(HERE, "ts_driver.mjs");
const PY_DRIVER = path.join(HERE, "py_driver.py");

const HOME = os.homedir();
function scrubArtifactPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (PY_TELEGRAM_DIR && PY_TELEGRAM_DIR !== "<HEADLONG_ROOT>/telegram") {
    out = out.split(path.dirname(PY_TELEGRAM_DIR)).join("<HEADLONG_ROOT>");
  }
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

const ADMIN = 100;
const USER = 7;

function dm(userId, text, name = "Dana") {
  return {
    message: { chat: { id: userId, type: "private" }, from: { id: userId, first_name: name }, text },
  };
}
function dmWithMsgId(userId, text, msgId, name = "Dana") {
  return {
    message: {
      message_id: msgId,
      chat: { id: userId, type: "private" },
      from: { id: userId, first_name: name },
      text,
    },
  };
}

// --- scenarios ------------------------------------------------------------
// Each scenario builds a JSON spec both drivers consume identically, plus
// an optional `setup(fakeServer)` to script Bot-API responses beyond the
// harness defaults (getUpdates batches, a scripted sendMessage failure, …).
const scenarios = [
  {
    group: "handle",
    name: "admin-approve-flow-end-to-end",
    mode: "handle",
    updates: [dm(USER, "hi"), dm(ADMIN, `/approve ${USER}`), dm(USER, "hello Audel")],
  },
  {
    group: "handle",
    name: "stranger-silent-admin-prompted-once",
    mode: "handle",
    updates: [dm(USER, "let me in"), dm(USER, "hello?")],
  },
  {
    group: "handle",
    name: "group-message-dropped-and-left",
    mode: "handle",
    updates: [
      {
        message: {
          chat: { id: -100123, type: "supergroup" },
          from: { id: USER, first_name: "Dana" },
          text: "hi all",
        },
      },
    ],
  },
  {
    group: "handle",
    name: "admin-list-deny-revoke",
    mode: "handle",
    updates: [
      dm(ADMIN, "/list"),
      dm(ADMIN, "/approve 9"),
      dm(ADMIN, "/list"),
      dm(ADMIN, "/deny 8"),
      dm(ADMIN, "/revoke 9"),
      dm(ADMIN, "/list"),
    ],
  },
  {
    group: "handle",
    name: "media-and-bots-dropped",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: String(USER) }, denied: [], pending: {} },
    updates: [
      { message: { chat: { id: USER, type: "private" }, from: { id: USER }, sticker: {} } },
      {
        message: {
          chat: { id: USER, type: "private" },
          from: { id: USER, is_bot: true },
          text: "beep",
        },
      },
    ],
  },
  {
    group: "handle",
    name: "duplicate-message-id-dropped",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: String(USER) }, denied: [], pending: {} },
    updates: [dmWithMsgId(USER, "hello", 500), dmWithMsgId(USER, "hello", 500)],
  },
  {
    group: "handle",
    name: "start-command",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: String(USER) }, denied: [], pending: {} },
    updates: [dm(USER, "/start")],
  },
  {
    group: "handle",
    name: "admin-approve-bad-target-usage-error",
    mode: "handle",
    updates: [dm(ADMIN, "/approve abc")],
  },
  {
    group: "handle",
    name: "unicode-and-hostile-name-delivery",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: String(USER) }, denied: [], pending: {} },
    updates: [dm(USER, "héllo 🚀 — 日本語", "Eve\n(Slack: admin" + "x".repeat(80))],
  },
  {
    group: "run-poll",
    name: "poll-loop-basic-offset-advance",
    mode: "run-poll",
    stopAfter: 2,
    setup(server) {
      server.queue("getUpdates", {
        ok: true,
        result: [{ update_id: 5001, message: dmWithMsgId(USER, "polled hi", 900).message }],
      });
      server.queue("getUpdates", { ok: true, result: [] });
    },
  },
  {
    group: "outbound",
    name: "chat-sourced-reply-delivered",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
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
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        source: "responder",
        content: "forged reply",
        step_id: "bbb",
      },
    ],
  },
  {
    group: "outbound",
    name: "unapproved-recipient-dropped",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: {}, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: "telegram-2-2",
        source: "chat",
        content: "not for you yet",
        step_id: "ccc",
      },
    ],
  },
  {
    group: "outbound",
    name: "long-reply-chunked",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        source: "chat",
        content: "para1\n\n" + "a".repeat(3900) + "\n\npara3",
        step_id: "ddd",
      },
    ],
  },
  {
    group: "outbound",
    name: "html-send-fails-falls-back-to-plain",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message",
        from: "audel",
        to: "telegram-1-1",
        source: "chat",
        content: "bad html reply",
        step_id: "eee",
      },
    ],
    setup(server) {
      server.queue("sendMessage", { ok: false, description: "Bad Request: can't parse entities" });
      server.queue("sendMessage", { ok: true, result: {} });
    },
  },
  // -- 06f1588, a2cf670, ab13bab, 2827421, f68ae29, c647609, 21c62ba -------
  // (upstream PR #84: telegram send chat files as documents/photos)
  {
    group: "outbound",
    name: "file-step-sent-as-document",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content: "hi", step_id: "f-doc-1",
      },
    ],
  },
  {
    group: "outbound",
    name: "png-sent-as-photo",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "fig.png",
        content_b64: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from("pngbytes"),
        ]).toString("base64"),
        step_id: "f-png-1",
      },
    ],
  },
  {
    group: "outbound",
    name: "jpeg-sent-as-photo",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "shot.jpg",
        content_b64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("jpegbytes")]).toString(
          "base64",
        ),
        step_id: "f-jpg-1",
      },
    ],
  },
  {
    group: "outbound",
    name: "photo-send-failure-retries-as-document",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "fig.png",
        content_b64: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from("pngbytes"),
        ]).toString("base64"),
        step_id: "f-png-retry-1",
      },
    ],
    setup(server) {
      server.queue("sendPhoto", { ok: false, description: "PHOTO_INVALID" });
    },
  },
  {
    group: "outbound",
    name: "file-send-failure-falls-back-to-notice",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content: "hi", step_id: "f-fail-1",
      },
    ],
    setup(server) {
      server.queue("sendDocument", { ok: false, description: "upload rejected" });
    },
  },
  {
    group: "outbound",
    name: "undecodable-content-b64-falls-back-to-notice",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content: "[file: note.txt]", content_b64: "@@@bad@@@",
        step_id: "f-badb64-1",
      },
    ],
  },
  {
    group: "outbound",
    name: "identical-file-steps-deduped",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content_b64: Buffer.from("same-bytes").toString("base64"),
        step_id: "f-dup-1",
      },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content_b64: Buffer.from("same-bytes").toString("base64"),
        step_id: "f-dup-2",
      },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        filename: "note.txt", content_b64: Buffer.from("different-bytes").toString("base64"),
        step_id: "f-dup-3",
      },
    ],
  },
  {
    group: "outbound",
    name: "group-chat-destination-dropped",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-99", source: "chat",
        content: "group hi", step_id: "f-group-1",
      },
    ],
  },
  {
    group: "outbound",
    name: "slack-reaction-step-not-posted",
    mode: "outbound",
    seedCursorOffsetZero: true,
    seedAllowlist: { approved: { "1": "1" }, denied: [], pending: {} },
    seedTrajectorySteps: [
      { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        reaction: "thumbsup", content: ":thumbsup:", step_id: "f-react-1",
      },
      {
        type: "message", from: "audel", to: "telegram-1-1", source: "chat",
        content: "later reply", step_id: "f-react-2",
      },
    ],
  },
];


// --- 2e39a3f scenarios: delivery notices, a 409 refusal, cursor naming. ------
// Expectations come from the real Python run, never assumed.
const TRAJ0 = { type: "trajectory", step_id: "12345678-1111-2222-3333-444455556666" };
const APPROVED_1 = { approved: { "1": "1" }, denied: [], pending: {} };
function chatMsg(stepId, to, content = "hello", extra = {}) {
  return { type: "message", from: "audel", to, source: "chat", content, step_id: stepId, ...extra };
}
function outboundScenario(name, steps, extra = {}) {
  return { group: "outbound", name, mode: "outbound", seedCursorOffsetZero: true, seedAllowlist: APPROVED_1, seedTrajectorySteps: [TRAJ0, ...steps], ...extra };
}
scenarios.push(
  {
    group: "handle",
    name: "web-409-refusal-is-final-no-retry-no-error-post",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: "Dana" }, denied: [], pending: {} },
    updates: [dmWithMsgId(USER, "this is a duplicate", 950)],
    setup(server) {
      server.queue("webChat", { status: 409, body: { detail: { message: "refusing to send: this exact message already went" } } });
    },
  },
  {
    group: "handle",
    name: "web-503-still-retries-three-times-then-posts-error",
    mode: "handle",
    seedAllowlist: { approved: { [String(USER)]: "Dana" }, denied: [], pending: {} },
    updates: [dmWithMsgId(USER, "retry me", 951)],
    setup(server) {
      for (let i = 0; i < 3; i++) server.queue("webChat", { status: 503, body: { detail: "down" } });
    },
  },
  outboundScenario("delivered-notice-names-step-and-chat", [chatMsg("m1", "telegram-1-1", "hi")]),
  outboundScenario("malformed-telegram-address-failed-notice", [chatMsg("m1", "telegram-bogus", "x")]),
  outboundScenario("other-transports-silently-skipped", [chatMsg("m1", "slack-U1-C1"), chatMsg("m2", "pwa-andy")]),
  outboundScenario("duplicate-is-skipped-notice", [chatMsg("m1", "telegram-1-1", "x"), chatMsg("m2", "telegram-1-1", "x")]),
  outboundScenario("send-failure-html-and-plain-is-failed-notice", [chatMsg("m1", "telegram-1-1", "doomed")], {
    setup(server) {
      server.queue("sendMessage", { ok: false, description: "Bad Request: chat not found" });
      server.queue("sendMessage", { ok: false, description: "Bad Request: chat not found" });
    },
  }),
  outboundScenario("partly-sent-failure-notice", [chatMsg("m1", "telegram-1-1", "para1\n\n" + "a".repeat(4000) + "\n\npara3")], {
    setup(server) {
      server.queue("sendMessage", { ok: true, result: {} });
      server.queue("sendMessage", { ok: false, description: "Bad Request: second chunk" });
      server.queue("sendMessage", { ok: false, description: "Bad Request: second chunk" });
    },
  }),
  outboundScenario("file-sent-delivered-notice-carries-filename", [
    chatMsg("f1", "telegram-1-1", "", { filename: "note.txt", content_b64: Buffer.from("hi").toString("base64") }),
  ]),
  outboundScenario("file-failure-notice-carries-reason-and-filename", [
    chatMsg("f1", "telegram-1-1", "", { filename: "note.txt", content_b64: Buffer.from("hi").toString("base64") }),
  ], {
    setup(server) {
      server.queue("sendDocument", { ok: false, description: "Request Entity Too Large" });
    },
  }),
  { ...outboundScenario("cursor-of-another-trajectory-starts-at-eof", [chatMsg("m1", "telegram-1-1", "old, must not be re-sent")]), seedCursorOffsetZero: false, seedCursorRaw: "2 <SANDBOX>/some/other/trajectory.jsonl" },
  { ...outboundScenario("cursor-beyond-the-file-starts-at-eof", [chatMsg("m1", "telegram-1-1", "old, must not be re-sent")]), seedCursorOffsetZero: false, seedCursorRaw: "999999" },
);

// --- normalization ----------------------------------------------------------
function normalizeAllowlistJson(text) {
  if (text === null) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text;
  }
  const pending = obj.pending ?? {};
  const normPending = {};
  for (const [k, v] of Object.entries(pending)) {
    normPending[k] = { label: v.label, last_notified: "<TS>" };
  }
  const normalized = { approved: obj.approved ?? {}, denied: obj.denied ?? [], pending: normPending };
  return JSON.stringify(sortKeysDeep(normalized));
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
    return text;
  }
}

// PORT-NOTE (1c: 06f1588): sendDocument/sendPhoto post multipart/form-data.
// httpx (Python) and Node's fetch/undici (TS) each generate their OWN
// boundary string, so comparing multipart bodies as raw text (like
// bodySemantic does for JSON) would never match even when the two bridges
// sent semantically identical requests — a pure harness artifact, not a
// port bug. Parse both sides' multipart body into an ordered list of
// {name, filename, value} and compare THAT instead. Field values compare as
// utf8 text; file parts compare as base64 bytes (exact, since utf8 decoding
// arbitrary PNG/JPEG bytes would corrupt them — see fake-server.mjs's
// `bodyBase64` comment).
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!m) return null;
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`, "utf8");
  const parts = [];
  let cursor = buf.indexOf(boundary);
  if (cursor === -1) return null;
  cursor += boundary.length;
  for (;;) {
    if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) break; // "--" -> final boundary
    let bodyStart = cursor;
    if (buf[bodyStart] === 0x0d && buf[bodyStart + 1] === 0x0a) bodyStart += 2;
    const next = buf.indexOf(boundary, bodyStart);
    if (next === -1) break;
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const raw = buf.subarray(bodyStart, bodyEnd);
    const headerEnd = raw.indexOf("\r\n\r\n");
    const headerText = (headerEnd === -1 ? raw : raw.subarray(0, headerEnd)).toString("utf8");
    const partBody = headerEnd === -1 ? Buffer.alloc(0) : raw.subarray(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      value: filenameMatch ? partBody.toString("base64") : partBody.toString("utf8"),
    });
    cursor = next + boundary.length;
  }
  parts.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return JSON.stringify(parts);
}

function isMultipart(contentType) {
  return (contentType || "").split(";")[0].trim() === "multipart/form-data";
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
    if (isMultipart(ra.headers["content-type"])) {
      const pa = parseMultipart(Buffer.from(ra.bodyBase64, "base64"), ra.headers["content-type"]);
      const pb = parseMultipart(Buffer.from(rb.bodyBase64, "base64"), rb.headers["content-type"]);
      if (pa !== pb) return false;
    } else if (bodySemantic(ra.body) !== bodySemantic(rb.body)) {
      return false;
    }
  }
  return true;
}

// --- driving one language ---------------------------------------------------
function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-parity-sb-"));
}

function writeSpecFile(spec) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "tg-parity-spec-"));
  const file = path.join(p, "spec.json");
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

// child_process.spawnSync BLOCKS this process's event loop until the child
// exits — fatal here, because the fake HTTP server the child needs to talk
// to lives in THIS SAME process. A synchronous spawn would starve the
// server's event loop for the whole child lifetime, so every request the
// child makes back to us would hang until its own client-side timeout. Must
// stay async so the server can keep accepting/answering connections while
// the child runs.
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

async function runOne(kind, sc, server, port) {
  server.reset();
  if (sc.setup) sc.setup(server);
  const sandbox = makeSandbox();
  const spec = {
    port,
    sandbox,
    cfg: { identity: "audel", adminId: ADMIN, botToken: "t:test" },
    mode: sc.mode,
    updates: sc.updates,
    stopAfter: sc.stopAfter,
    seedAllowlist: sc.seedAllowlist ?? null,
    seedTrajectorySteps: sc.seedTrajectorySteps,
    seedCursorOffsetZero: sc.seedCursorOffsetZero ?? false,
    seedCursorRaw: sc.seedCursorRaw ?? null,
  };
  const specFile = writeSpecFile(spec);

  let res;
  if (kind === "py") {
    res = await spawnAsync(
      "uv",
      ["run", "--project", PY_TELEGRAM_DIR, "python3", PY_DRIVER, specFile],
      { timeout: 60000, cwd: HERE },
    );
  } else {
    res = await spawnAsync("node", [TS_DRIVER, specFile], { timeout: 60000, cwd: HERE });
  }

  const stateDir = path.join(sandbox, "state");
  const allowlist = readFileOrNull(path.join(stateDir, "allowlist.json"));
  const updateOffset = readFileOrNull(path.join(stateDir, "update_offset"));
  // 2e39a3f: the cursor is "<offset> <resolved trajectory path>"; the path
  // differs per sandbox, so compare the offset and that it names this run's
  // trajectory.
  const cursorRaw = readFileOrNull(path.join(stateDir, "cursor"));
  const cursor = cursorRaw === null ? null : cursorRaw.split(sandbox).join("<SANDBOX>").split(fs.realpathSync(sandbox)).join("<SANDBOX>").replace(/^(\d+) \S*\/trajectories\/12345678-root\/trajectory\.jsonl$/, "$1 <TRAJ>");
  // The delivery notices the bridge built (via the append_step seam).
  const noticesRaw = readFileOrNull(path.join(sandbox, "notices.jsonl"));
  const notices = noticesRaw === null ? null : JSON.stringify(noticesRaw.split("\n").filter(Boolean).map((l) => sortKeysDeep(JSON.parse(l))));

  const requests = server.requests.map((r) => ({ ...r }));
  const botRequests = requests.filter((r) => r.path.startsWith("/bot"));
  const webRequests = requests.filter((r) => r.path.startsWith("/api/identities/"));

  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(path.dirname(specFile), { recursive: true, force: true });

  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
    allowlist: normalizeAllowlistJson(allowlist),
    updateOffset,
    cursor,
    notices,
    botRequests,
    webRequests,
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
      botRequests: requestsEqual(py.botRequests, ts.botRequests),
      webRequests: requestsEqual(py.webRequests, ts.webRequests),
      allowlist: py.allowlist === ts.allowlist,
      updateOffset: py.updateOffset === ts.updateOffset,
      cursor: py.cursor === ts.cursor,
      notices: py.notices === ts.notices,
    };
    const pass = Object.values(cmp).every(Boolean);
    results.push({ group: sc.group, name: sc.name, pass, cmp, py, ts });
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

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const rate = ((passed / total) * 100).toFixed(1);

  let md = `# telegram bridge — differential parity proof\n\n`;
  md += `Real Python \`headlong_telegram\` (\`uv run\` against the oracle checkout) vs this port's \`src/telegram/\`, driven identically against a fake Telegram Bot API + fake headlong-web \`/chat\` endpoint (\`fake-server.mjs\`). See this file's header comment for the harness design (module-level driving, the Bot-API relay, header-comparison scope) and PARITY.md for the live-Telegram-leg deferral.\n\n`;
  md += `- \`PARITY_PY_TELEGRAM_DIR=/abs/path/to/headlong/telegram node run-parity.mjs\`\n`;
  md += `- Pass = same exit status, same (method+path+content-type+semantic-JSON-body) request sequence to both the Bot API and \`/chat\` endpoints, same on-disk \`allowlist.json\` (pending timestamps normalized), \`update_offset\`, \`cursor\`.\n\n`;
  md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
  md += `| # | group | scenario | verdict | differing |\n|---|---|---|---|---|\n`;
  let idx = 1;
  for (const r of results) {
    const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
    md += `| ${idx++} | ${r.group} | ${r.name} | ${r.pass ? "PARITY" : "DIVERGE"} | ${diffs} |\n`;
  }
  md += `\n## Divergences (detail)\n\n`;
  const fails = results.filter((r) => !r.pass);
  if (fails.length === 0) md += `None.\n`;
  for (const r of fails) {
    md += `### ${r.group} / ${r.name}\n`;
    md += `- exit: py=${r.py.status} ts=${r.ts.status}\n`;
    if (r.py.error) md += `- py spawn error: ${r.py.error}\n`;
    if (r.ts.error) md += `- ts spawn error: ${r.ts.error}\n`;
    md += "```\n";
    md += `py stderr: ${r.py.stderr}\n`;
    md += `ts stderr: ${r.ts.stderr}\n`;
    md += `py botRequests: ${JSON.stringify(r.py.botRequests, null, 2)}\n`;
    md += `ts botRequests: ${JSON.stringify(r.ts.botRequests, null, 2)}\n`;
    md += `py webRequests: ${JSON.stringify(r.py.webRequests, null, 2)}\n`;
    md += `ts webRequests: ${JSON.stringify(r.ts.webRequests, null, 2)}\n`;
    md += `py allowlist: ${r.py.allowlist}\n`;
    md += `ts allowlist: ${r.ts.allowlist}\n`;
    md += `py updateOffset: ${r.py.updateOffset}  ts updateOffset: ${r.ts.updateOffset}\n`;
    md += `py cursor: ${r.py.cursor}  ts cursor: ${r.ts.cursor}\n`;
    md += `py notices: ${r.py.notices}\nts notices: ${r.ts.notices}\n`;
    md += "```\n\n";
  }
  fs.writeFileSync(path.join(HERE, "report.md"), md);
  fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

  console.log(`telegram parity: ${passed}/${total} (${rate}%)`);
  for (const r of results) {
    if (!r.pass) {
      const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
      console.log(`  DIVERGE ${r.group}/${r.name}  [${diffs}]`);
    }
  }
  process.exit(passed === total ? 0 : 1);
}

main();
