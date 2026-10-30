// fake-server.mjs — a fake Slack Web API + fake headlong-web `/chat`
// endpoint, for the slack differential parity harness.
//
// Serves two URL shapes on one local HTTP listener:
//   POST /api/<slack.method>           — Slack Web API (auth.test,
//                                        users.info, conversations.info,
//                                        chat.postMessage, chat.getPermalink,
//                                        apps.connections.open, …)
//   POST /api/identities/*/chat        — the headlong-web chat endpoint the
//                                        bridge's inbound delivery POSTs to
//
// The two shapes share the `/api/` prefix but never collide: every real
// Slack Web API method name contains a literal `.` (auth.test,
// chat.postMessage, …; verified against the installed slack_sdk source —
// see run-parity.mjs's header), while the web chat path is nested under
// `/api/identities/<id>/chat`, which never matches a bare method name. So
// routing is: `/api/identities/...(/chat)` -> webChat; anything else under
// `/api/` -> the Slack method named by the rest of the path.
//
// Every request (both shapes) is recorded verbatim: method, path, headers,
// raw body bytes. Slack responses are scripted per method via a FIFO queue
// (queue() / reset()); an empty queue falls back to a reasonable default.
// `/chat` responses are scripted the same way under the pseudo-method
// "webChat".

import * as http from "node:http";

export function createFakeServer() {
  /** @type {Array<{method:string, path:string, headers:Record<string,string>, body:string}>} */
  let requests = [];
  /** @type {Record<string, unknown[]>} */
  let queues = {};

  const defaults = {
    "auth.test": { ok: true, url: "https://example.slack.com/", team: "Test Team", user: "audel", team_id: "T1", user_id: "UBOT", bot_id: "B1" },
    "users.info": { ok: true, user: { id: "U1", real_name: "Dana Kim", profile: { display_name: "dana" } } },
    "conversations.info": { ok: true, channel: { id: "C1", name: "eng" } },
    "chat.postMessage": { ok: true, channel: "C1", ts: "1700000000.000100", message: {} },
    "apps.connections.open": { ok: true, url: "wss://example/link" },
    "reactions.get": { ok: true, message: {} },
    "conversations.replies": { ok: true, messages: [] },
    "reactions.add": { ok: true },
    // conversations.open (2e39a3f: a bare slack-U… target opens the DM first).
    "conversations.open": { ok: true, channel: { id: "D0OPENED" } },
    // chat.getPermalink (1c: f68c1d8) — a stable, deterministic permalink so
    // both languages' inbound deliveries record the identical source_url.
    "chat.getPermalink": { ok: true, channel: "C1", permalink: "https://example.slack.com/archives/C1/p1700000000000100" },
    // files.upload_v2 (1c: 692e16e) is a 3-call client-side flow, not one
    // Slack method — see api.ts's own header comment. getUploadURLExternal
    // hands back an upload_url pointing at THIS fake server's own
    // /upload-fake/<id> route (below), so the raw-bytes step never leaves
    // the harness.
    "files.getUploadURLExternal": { ok: true, file_id: "F1", upload_url: null }, // filled in per-request below
    "files.completeUploadExternal": { ok: true, files: [{ id: "F1", title: "file" }] },
    webChat: { status: 200, body: { ok: true } },
  };

  function nextScripted(key) {
    const q = queues[key];
    if (q && q.length > 0) return q.shift();
    return defaults[key] ?? { ok: true };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let pathname;
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        pathname = req.url ?? "";
      }
      requests.push({ method: req.method ?? "", path: pathname, headers: { ...req.headers }, body: bodyText });

      if (pathname.startsWith("/api/identities/") && pathname.endsWith("/chat")) {
        const scripted = nextScripted("webChat");
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scripted.body ?? { ok: true }));
        return;
      }
      // files.upload_v2's step 2 (1c: 692e16e): a raw POST of file bytes to
      // the pre-signed URL step 1 handed back — NOT under /api/, no Slack
      // envelope. This fake points that URL at itself; just accept it.
      if (pathname.startsWith("/upload-fake/")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("OK");
        return;
      }
      const apiMatch = /^\/api\/(.+)$/.exec(pathname);
      if (apiMatch) {
        const slackMethod = apiMatch[1];
        const scripted = nextScripted(slackMethod);
        if (typeof scripted.raw === "string") {
          res.writeHead(scripted.status ?? 200, { "content-type": scripted.contentType ?? "text/html" });
          res.end(scripted.raw);
          return;
        }
        if (slackMethod === "files.getUploadURLExternal" && scripted.upload_url === null) {
          const fileId = scripted.file_id ?? "F1";
          const host = req.headers.host ?? "127.0.0.1";
          const filled = { ...scripted, upload_url: `http://${host}/upload-fake/${fileId}` };
          res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify(filled));
          return;
        }
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scripted));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    reset() {
      requests = [];
      queues = {};
    },
    /** Push one scripted response onto method `key`'s FIFO queue. */
    queue(key, response) {
      (queues[key] ??= []).push(response);
    },
    /** All requests recorded since the last reset(). */
    get requests() {
      return requests;
    },
  };
}
