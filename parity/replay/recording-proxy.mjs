#!/usr/bin/env node
// parity/replay/recording-proxy.mjs — the impure half of L2 step 1
// (PROOF-CAMPAIGN.md): a standalone HTTP server that relays every request
// to the real provider byte-for-byte while tapping the exchange into a
// replay tape. Runs as its OWN process, spawned by record.mjs — NOT
// in-process with record.mjs's own orchestration.
//
// Why a separate process (this cost real debugging time to find, recorded
// here so it isn't rediscovered): record.mjs drives headlong-init/thinkers
// via node:child_process's spawnSync, which BLOCKS THE ENTIRE EVENT LOOP
// for the subprocess's whole lifetime — Node is single-threaded. An
// http.createServer running in that SAME process cannot call accept() or
// emit 'request' while spawnSync is blocking it, even though the OS kernel
// still completes the TCP handshake (so `lsof`/`netstat` shows the
// connection ESTABLISHED) — the request just sits unread until curl's
// --speed-limit trips ("Operation too slow. Less than 100 bytes/sec").
// 100% reproducible: confirmed by running the identical proxy logic
// in-process (hangs, zero request-received events ever fire) vs as a
// separate process (responds in under a second, every time). run-replay.mjs
// already avoided this by spawning proxy.mjs as child processes — this file
// gives record.mjs the same safe shape.
//
// Usage: node parity/replay/recording-proxy.mjs --port N --tape-out FILE [--upstream-url URL]
// Prints "recording-proxy: listening on ..." once ready (record.mjs's
// readiness check). SIGTERM/SIGINT: stop accepting, flush the tape stream,
// print a one-line summary to stdout, exit 0.

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

import { classifyRequest, parseUpstreamResponse, requestWantsStream } from "./lib.mjs";

function die(msg) {
  process.stderr.write(`recording-proxy: ${msg}\n`);
  process.exit(1);
}

function parseArgv(argv) {
  const opts = { port: null, tapeOut: null, upstreamUrl: "https://openrouter.ai/api/v1/chat/completions" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--tape-out") opts.tapeOut = argv[++i];
    else if (a === "--upstream-url") opts.upstreamUrl = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  return opts;
}

const opts = parseArgv(process.argv.slice(2));
if (!opts.port) die("--port is required");
if (!opts.tapeOut) die("--tape-out is required");

const tapeOutStream = fs.createWriteStream(opts.tapeOut, { flags: "a" });
const laneSeq = new Map();
const summary = { requests: 0, byLane: {}, bytesRelayed: 0 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(chunks);
    let payload = {};
    try {
      payload = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
      /* forwarded regardless; classification below just falls to "other" */
    }
    const lane = classifyRequest(payload);
    const wantsStream = requestWantsStream(payload);

    const target = new URL(opts.upstreamUrl);
    const lib = target.protocol === "https:" ? https : http;
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    forwardHeaders["content-length"] = Buffer.byteLength(bodyBuffer);

    const freq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: forwardHeaders,
      },
      (fres) => {
        res.writeHead(fres.statusCode, fres.headers);
        const collected = [];
        fres.on("data", (chunk) => {
          collected.push(chunk);
          summary.bytesRelayed += chunk.length;
          res.write(chunk);
        });
        fres.on("end", () => {
          res.end();
          const bodyText = Buffer.concat(collected).toString("utf8");
          const contentType = String(fres.headers["content-type"] || "");
          const isSse = contentType.includes("text/event-stream") || wantsStream;
          const parsed = fres.statusCode >= 200 && fres.statusCode < 300 ? parseUpstreamResponse(bodyText, { isSse }) : null;

          summary.requests += 1;
          summary.byLane[lane] = (summary.byLane[lane] ?? 0) + 1;

          if (!parsed) {
            process.stderr.write(`recording-proxy: WARNING non-2xx or unparseable response (status=${fres.statusCode}, lane=${lane}) — not taped\n`);
            return;
          }
          const seq = laneSeq.get(lane) ?? 0;
          laneSeq.set(lane, seq + 1);
          const entry = {
            lane,
            seq,
            ts: new Date().toISOString(),
            model: payload?.model ?? null,
            requestStream: wantsStream,
            responseText: parsed.text,
            reasoningText: parsed.reasoningText,
            finishReason: parsed.finishReason,
            usage: parsed.usage,
          };
          tapeOutStream.write(`${JSON.stringify(entry)}\n`);
          process.stdout.write(`recording-proxy: taped lane=${lane} seq=${seq} chars=${(parsed.text || "").length}\n`);
        });
        fres.on("error", () => res.end());
      }
    );
    freq.on("error", (e) => {
      process.stderr.write(`recording-proxy: upstream request error: ${e.message}\n`);
      try {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`record-proxy: upstream error: ${e.message}`);
      } catch {
        /* response may already be started */
      }
    });
    freq.write(bodyBuffer);
    freq.end();
  });
});

function shutdown(code) {
  process.stdout.write(`recording-proxy: shutting down — ${summary.requests} request(s), lanes ${JSON.stringify(summary.byLane)}\n`);
  tapeOutStream.end(() => {
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

server.listen(opts.port, "127.0.0.1", () => {
  process.stdout.write(`recording-proxy: listening on 127.0.0.1:${opts.port} -> ${opts.upstreamUrl}\n`);
});
