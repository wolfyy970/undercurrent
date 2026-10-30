// fake-server.mjs — a fake Telegram Bot API + fake headlong-web `/chat`
// endpoint, for the telegram differential parity harness.
//
// Serves two URL shapes on one local HTTP listener:
//   POST /bot<token>/<method>          — Telegram Bot API (getMe, getUpdates,
//                                        sendMessage, leaveChat, …)
//   POST /api/identities/*/chat        — the headlong-web chat endpoint the
//                                        bridge's inbound delivery POSTs to
//                                        (real HEADLONG_WEB_URL support in
//                                        both languages — no interception
//                                        needed for this leg, see run-parity's
//                                        header comment for why the Bot API
//                                        leg alone needs a relay).
//
// Every request (both shapes) is recorded verbatim: method, path, headers,
// raw body bytes. Bot API responses are scripted per Telegram method via a
// FIFO queue (queue() / reset()); an empty queue falls back to a reasonable
// default (ok:true with an empty/typed result). `/chat` responses are
// scripted the same way under the pseudo-method "webChat".

import * as http from "node:http";

export function createFakeServer() {
  /** @type {Array<{method:string, path:string, headers:Record<string,string>, body:string}>} */
  let requests = [];
  /** @type {Record<string, unknown[]>} */
  let queues = {};

  const defaults = {
    getMe: { ok: true, result: { id: 111, is_bot: true, first_name: "TestBot", username: "test_bot" } },
    getUpdates: { ok: true, result: [] },
    sendMessage: { ok: true, result: {} },
    leaveChat: { ok: true, result: true },
    webChat: { status: 200, body: { ok: true } },
  };

  function nextScripted(key) {
    const q = queues[key];
    if (q && q.length > 0) return q.shift();
    return defaults[key] ?? { ok: true, result: {} };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyText = bodyBuf.toString("utf8");
      let pathname;
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        pathname = req.url ?? "";
      }
      // PORT-NOTE (1c: 06f1588): `body` (utf8) stays for JSON request
      // comparison, unchanged. `bodyBase64` is new — a multipart/form-data
      // body (sendDocument/sendPhoto) can carry raw binary file bytes that
      // utf8-decoding would corrupt (invalid byte sequences become U+FFFD),
      // so run-parity.mjs's multipart comparison decodes from this instead.
      requests.push({
        method: req.method ?? "",
        path: pathname,
        headers: { ...req.headers },
        body: bodyText,
        bodyBase64: bodyBuf.toString("base64"),
      });

      const botMatch = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(pathname);
      if (botMatch) {
        const apiMethod = botMatch[2];
        const scripted = nextScripted(apiMethod);
        if (typeof scripted.raw === "string") {
          res.writeHead(scripted.status ?? 200, { "content-type": scripted.contentType ?? "text/html" });
          res.end(scripted.raw);
          return;
        }
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scripted));
        return;
      }
      if (pathname.startsWith("/api/identities/") && pathname.endsWith("/chat")) {
        const scripted = nextScripted("webChat");
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scripted.body ?? { ok: true }));
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
