// parity/live/fault-proxy.mjs — a small OpenAI-compatible pass-through proxy
// that both the orig and port sides point their model calls at (via
// LLM_API_URL — see both sides' `openrouter` provider branch: bin/llm's
// get_url_headers and src/llmCli.ts's mirror of it, which both let
// LLM_API_URL override the default https://openrouter.ai/api/v1/... URL
// while still sending `Authorization: Bearer $OPENROUTER_API_KEY` from the
// CLIENT's own env). It forwards every request to the real OpenRouter
// endpoint UNCHANGED, except: the Authorization header is always replaced
// with a Bearer token built from ITS OWN process.env.OPENROUTER_API_KEY,
// never trusted from the inbound request — "the key from the process env
// only" (DELIVERABLE). The key is never logged, never included in any
// returned event/log line.
//
// Runs as its OWN OS process, spawned by run-sxs.mjs (see the CLI entry
// point at the bottom of this file) — NOT in-process. That was the
// original design and it deadlocked every one of the first three live
// runs: run-sxs.mjs drives every side command via `child_process.spawnSync`,
// which blocks its ENTIRE event loop until each one returns, so an
// in-process proxy can't service ANY request — including the very first
// one, headlong-init's own key check — while spawnSync is waiting on it.
// curl waits on the proxy, the proxy (frozen event loop) never answers,
// curl eventually hits its own low-speed-abort. A separate process has its
// own independent event loop, immune to whatever run-sxs.mjs's process is
// doing. `createFaultProxy` (the exported factory below) is still usable
// in-process for tests/scripts that never call spawnSync alongside it — it
// just isn't safe for run-sxs.mjs's own use. Control (queueFault/stats)
// crosses the process boundary over local-only `/__control__/*` HTTP
// routes on the same server (never forwarded upstream). Both sides are
// pointed at the SAME proxy instance, so a queued fault applies to
// whichever side's request arrives next — model calls from the two sides
// are not synchronized, so "the next K requests" cannot be split evenly
// per side; this is a documented limitation, not a bug (see README.md).
//
// STREAMS the plain pass-through and stall paths — never buffers the whole
// response in memory first. First real 12-minute run finding: bin/llm's
// streaming call uses `curl -sS -N --speed-limit 100 --speed-time 60`
// (`-N` = no output buffering; the speed-limit flags abort a connection
// receiving under 100 bytes/sec for 60s straight — bin/llm:1263,1280). A
// buffer-then-send proxy delivers ZERO bytes to curl until the ENTIRE
// upstream completion finishes, which both real runs tripped over: every
// `llm` call — on BOTH sides, since headlong-init's own key-check is the
// very first call either makes — failed with curl's "Operation too slow"
// (orig) / a 10s connect timeout (port's fetch-based client hit its own
// analogous stall guard). Streaming the response through as bytes arrive
// (https.request's callback fires the moment upstream's HEADERS land, well
// before its body finishes — `openUpstream`/`.pipe(res)` below) fixes this
// by construction: real bytes flow continuously, satisfying curl's
// speed-limit the same way a direct (unproxied) call would.
//
// Fault types (queueFault(faultType, count)):
//   429        synthetic rate-limit error, no upstream call made.
//   500        synthetic server error, no upstream call made.
//   truncated  a REAL upstream response, cut off after TRUNCATE_BYTE_CAP
//              bytes (invalid/incomplete JSON) — tests a client's handling
//              of a malformed/partial completion. Streamed and cut, not
//              buffered-then-sliced, so it doesn't reintroduce the same
//              buffering problem this file's header describes above.
//   stall      holds the response for STALL_MS (60s) before proceeding with
//              a normal forwarded (streamed) call — tests client-side
//              timeout/retry behaviour under a hung provider, without
//              hanging forever.
//
// popFault/pushFault/forwardHeaders are pure (queue/headers in, decision
// out) so the fault-selection and truncated-response header logic are
// unit-testable without starting a real server. Everything else here does
// real I/O (http/https, process.env) and is exercised only by the real
// 12/30-minute runs.
//
// CLASSIFICATION (2026-10-29): LIVE PASS-THROUGH, not a fake. Every reply is the real provider's (OpenRouter),
// streamed through unchanged and never stored; the only things this file authors are TRANSPORT faults (HTTP status
// codes, stalls, drops) queued over /__control__. The resulting real trajectories are vendored, with provenance, in
// parity/live/fixtures/{orig,port}/ (see README.md and SIDE-BY-SIDE.md).

import * as http from "node:http";
import * as https from "node:https";

export const STALL_MS = 60_000;
export const TRUNCATE_BYTE_CAP = 300; // bytes of a real completion to relay before cutting it off

/**
 * Pure: given a FIFO queue of `{type, remaining}` fault entries, return the
 * fault type to apply to the NEXT request (or null for none) plus the queue
 * as it should be afterward (exhausted entries at the front are dropped).
 * Does not mutate its input.
 */
export function popFault(queue) {
  const q = queue.slice();
  while (q.length > 0 && q[0].remaining <= 0) q.shift();
  if (q.length === 0) return { fault: null, queue: q };
  const [head, ...rest] = q;
  const fault = head.type;
  const nextHead = { ...head, remaining: head.remaining - 1 };
  return { fault, queue: nextHead.remaining > 0 ? [nextHead, ...rest] : rest };
}

/** Merge a newly-queued fault onto an existing queue (append — FIFO order of arrival). */
export function pushFault(queue, faultType, count) {
  return [...queue, { type: faultType, remaining: count }];
}

/**
 * Pure: collapse a DOUBLED trailing `/chat/completions/chat/completions`
 * down to one. First 12-minute-run finding: this proxy's `LLM_API_URL` is
 * the FULL endpoint (matching bin/llm's/src/llmCli.ts's own documented
 * `openrouter` semantics — the value it defaults to, `.../chat/completions`,
 * IS a complete URL, never a base one client code appends to). Both sides'
 * `bin/llm`/`bin/llm.mjs` CLI honor that. But the port's OWN live-wake
 * engine (`src/steprun.ts`'s `buildLlmClient` -> `src/llm.ts`'s
 * `OpenRouterClient.complete()`) treats the SAME env var as a BASE URL and
 * appends `/chat/completions` itself — a real inconsistency BETWEEN the
 * port's own two LLM_API_URL consumers (llmCli.ts matches upstream/bin/llm;
 * OpenRouterClient does not), reported as a finding, not something this
 * harness fixes (PROOF-CAMPAIGN.md: "harness lanes never fix the port").
 * Normalizing here is a harness-side accommodation so BOTH of the port's
 * consumers can be routed through one proxy in one run, producing a real
 * two-sided chaos-recovery comparison instead of the port going silent for
 * the whole run — every normalization is logged (see call site) as direct,
 * countable evidence of the port-side bug's real impact.
 */
export function normalizeDoubledChatCompletionsSuffix(url) {
  const SUFFIX = "/chat/completions";
  if (url && url.endsWith(SUFFIX + SUFFIX)) return url.slice(0, url.length - SUFFIX.length);
  return url;
}

/**
 * Pure: headers for the `truncated` fault's response — every OTHER path
 * (plain pass-through, `stall`) relays `upstreamRes.headers` completely
 * unmodified (it's piping the literal upstream body those headers
 * describe, so nothing needs fixing). `truncated` is the one case that
 * sends FEWER bytes than upstream declared, so both of upstream's own
 * length-signaling headers (`content-length`, a fixed byte count that
 * would now be a lie, and `transfer-encoding`, whose chunked framing this
 * proxy isn't reproducing) are dropped, letting Node's http server pick
 * its own framing for the truncated body it's told to send via repeated
 * `res.write()` + an early `res.end()`.
 */
export function forwardHeaders(upstreamHeaders) {
  const headers = { ...upstreamHeaders };
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  return headers;
}

function syntheticErrorBody(status) {
  return JSON.stringify({
    error: {
      message: `synthetic fault-proxy ${status} — injected by parity/live/fault-proxy.mjs for chaos testing, not a real provider error`,
      type: "fault_proxy_injected",
      code: status,
    },
  });
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey OPENROUTER_API_KEY — read by the CALLER from
 *   process.env and passed in explicitly (this module never reads
 *   process.env itself, so it stays testable with a fake key).
 * @param {string} [opts.upstreamHost] default openrouter.ai
 * @param {(line: string) => void} [opts.log]
 */
export function createFaultProxy({ apiKey, upstreamHost = "openrouter.ai", log = () => {} }) {
  if (!apiKey) throw new Error("createFaultProxy: apiKey is required");
  let queue = [];
  let requestCount = 0;
  const events = [];

  function queueFault(faultType, count) {
    queue = pushFault(queue, faultType, count);
    log(`fault-proxy: queued ${count}x ${faultType}`);
  }

  function recordEvent(entry) {
    events.push(entry);
    log(`fault-proxy: #${entry.n} ${entry.path} -> ${entry.faulted ? `FAULT(${entry.faultType})` : "forwarded"} status=${entry.status}`);
  }

  const server = http.createServer((req, res) => {
    // Local control routes — never forwarded upstream. These exist so
    // run-sxs.mjs can drive this proxy as a SEPARATE PROCESS (see the CLI
    // entry point below and this file's header for why it can't run
    // in-process): queueFault() and getEvents() below are still exactly
    // what a same-process caller (e.g. this file's own tests, or a script
    // importing createFaultProxy directly) uses; these HTTP routes are the
    // cross-process equivalent, used only by run-sxs.mjs's control client.
    if (req.url === "/__control__/fault" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const { faultType, count } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          queueFault(faultType, count);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }
    if (req.url === "/__control__/stats" && req.method === "GET") {
      const payload = JSON.stringify({ requestCount, events, queueDepth: queue.reduce((s, e) => s + e.remaining, 0) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
      return;
    }

    const n = ++requestCount;
    const startedMs = Date.now();
    const upstreamPath = normalizeDoubledChatCompletionsSuffix(req.url);
    if (upstreamPath !== req.url) log(`fault-proxy: #${n} normalized doubled suffix: ${req.url} -> ${upstreamPath} (see normalizeDoubledChatCompletionsSuffix's doc comment)`);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const { fault, queue: nextQueue } = popFault(queue);
      queue = nextQueue;

      if (fault === "429" || fault === "500") {
        const status = Number(fault);
        const payload = syntheticErrorBody(status);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "retry-after": "1" });
        res.end(payload);
        recordEvent({ n, path: upstreamPath, faulted: true, faultType: fault, status, durationMs: Date.now() - startedMs });
        return;
      }

      if (fault === "stall") {
        await new Promise((r) => setTimeout(r, STALL_MS));
      }

      try {
        const upstreamRes = await openUpstream({ upstreamHost, apiKey, method: req.method, path: upstreamPath, headers: req.headers, body });

        if (fault === "truncated") {
          res.writeHead(upstreamRes.statusCode ?? 502, forwardHeaders(upstreamRes.headers));
          let written = 0;
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            res.end();
            upstreamRes.destroy();
            recordEvent({ n, path: upstreamPath, faulted: true, faultType: "truncated", status: upstreamRes.statusCode, durationMs: Date.now() - startedMs, keptBytes: written });
          };
          upstreamRes.on("data", (chunk) => {
            if (finished) return;
            const remaining = TRUNCATE_BYTE_CAP - written;
            const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            res.write(piece);
            written += piece.length;
            if (written >= TRUNCATE_BYTE_CAP) finish();
          });
          upstreamRes.on("end", finish);
          upstreamRes.on("error", finish);
          return;
        }

        // Plain pass-through (and post-stall forward): relay upstream's
        // status/headers VERBATIM and pipe its body through as bytes
        // arrive — never buffered, so a `curl -N`-style client sees a live
        // trickle exactly like an unproxied call. recordEvent fires as soon
        // as headers land (durationMs is time-to-first-byte, not
        // time-to-last-byte — the whole point of not waiting for that).
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        recordEvent({ n, path: upstreamPath, faulted: fault === "stall", faultType: fault === "stall" ? "stall" : null, status: upstreamRes.statusCode, durationMs: Date.now() - startedMs });
      } catch (err) {
        const payload = JSON.stringify({ error: { message: `fault-proxy: upstream forward failed: ${err instanceof Error ? err.message : String(err)}`, type: "fault_proxy_upstream_error" } });
        res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        recordEvent({ n, path: upstreamPath, faulted: false, faultType: null, status: 502, durationMs: Date.now() - startedMs, error: String(err) });
      }
    });
  });

  return {
    server,
    queueFault,
    getEvents: () => events.slice(),
    getQueueDepth: () => queue.reduce((s, e) => s + e.remaining, 0),
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    url() {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("createFaultProxy: server is not listening");
      return `http://127.0.0.1:${addr.port}/api/v1/chat/completions`;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Open the real upstream request and resolve with the response object
 * itself — as soon as ITS HEADERS arrive, same as any `https.request`
 * callback, well before its body finishes. The caller pipes/reads the body;
 * this function never buffers it. Never logs headers/body (may carry the
 * key or model prose).
 */
function openUpstream({ upstreamHost, apiKey, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const outHeaders = { ...headers };
    delete outHeaders.host;
    delete outHeaders.connection;
    outHeaders.authorization = `Bearer ${apiKey}`;
    outHeaders["content-length"] = Buffer.byteLength(body);

    const req = https.request({ host: upstreamHost, port: 443, method, path, headers: outHeaders }, resolve);
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — run this proxy as its OWN OS process.
//
// This is the ONLY correct way to run it: run-sxs.mjs drives every side
// command (headlong-init, thinkers start/stop, chat send, ...) through
// `child_process.spawnSync`, which BLOCKS run-sxs.mjs's entire Node event
// loop until each one returns. A proxy living in-process there would be
// unable to service ANY request — including the real model call
// headlong-init itself makes to validate the key — while spawnSync is
// blocking, which is a guaranteed deadlock: curl waits on the proxy, the
// proxy (frozen event loop) never answers, curl eventually hits its own
// low-speed-abort. This was a REAL bug in the first three live-run
// attempts (documented in the module header above): every single one
// failed identically, on both sides, at headlong-init's own key check,
// because the proxy was started in-process. Running it as a separate
// process removes the deadlock by construction — its event loop is never
// blocked by anything run-sxs.mjs's own process does.
//
// Prints exactly one `FAULT_PROXY_PORT <port>` line to stdout once
// listening (the parent reads this to discover the port), then every
// subsequent log line is plain text. `queueFault`/stats are reached over
// the `/__control__/*` HTTP routes above — the cross-process equivalent of
// calling `createFaultProxy(...).queueFault()` directly.
//
// Usage: OPENROUTER_API_KEY=... node parity/live/fault-proxy.mjs [--port N]
async function cliMain() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write("fault-proxy: OPENROUTER_API_KEY is not set\n");
    process.exitCode = 1;
    return;
  }
  const argv = process.argv.slice(2);
  let requestedPort = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") requestedPort = Number(argv[++i]);
  }

  const proxy = createFaultProxy({ apiKey, log: (line) => process.stdout.write(`${line}\n`) });
  await new Promise((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const actualPort = proxy.server.address().port;
  process.stdout.write(`FAULT_PROXY_PORT ${actualPort}\n`);

  const shutdown = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isEntryPoint = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  cliMain().catch((err) => {
    process.stderr.write(`fault-proxy: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
