#!/usr/bin/env node
// parity/replay/proxy.mjs — the L2 replay server (PROOF-CAMPAIGN.md). Loads
// a tape recorded by record.mjs and answers every OpenAI-compatible chat-
// completions request with the next tape entry for that request's LANE (see
// lib.mjs's classifyRequest), matched POSITIONALLY: request N in a lane
// gets tape entry N in that lane.
//
// ONE proxy instance replays the tape for ONE side. run-replay.mjs starts
// TWO instances (same --tape, different --port) so orig and port each walk
// the SAME recorded tape from position 0 independently — a single shared
// instance would let whichever side calls first steal the other's entry.
//
// All matching/rendering logic lives in lib.mjs (unit-tested); this file is
// only the impure half: HTTP listen, read the tape file, write stats/miss
// log, handle SIGTERM/SIGINT.
//
// Usage: node parity/replay/proxy.mjs --tape FILE --port N [--stats-out FILE] [--miss-log FILE] [--label NAME]
//
// CLASSIFICATION (2026-10-29): REPLAY OF REAL RECORDED RESPONSES. A tape is written by record.mjs through
// recording-proxy.mjs, which relays each request to the real provider byte for byte and taps the response text and
// usage; nothing here or there authors model text. Provenance: record.mjs's record-meta.json beside the tape (model,
// provider URL, start/finish time, identity). No tape is committed to this repository; a tape lives in the run's
// scratch directory or PARITY_REPLAY_TAPE.

import * as fs from "node:fs";
import * as http from "node:http";
import { parseTapeJsonl, groupTapeByLane, classifyRequest, nextTapeEntry, renderReplyBody, requestWantsStream } from "./lib.mjs";

function parseArgv(argv) {
  const opts = { tape: null, port: null, statsOut: null, missLog: null, label: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tape") opts.tape = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--stats-out") opts.statsOut = argv[++i];
    else if (a === "--miss-log") opts.missLog = argv[++i];
    else if (a === "--label") opts.label = argv[++i];
    else {
      process.stderr.write(`replay-proxy: unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function die(msg) {
  process.stderr.write(`replay-proxy: ${msg}\n`);
  process.exit(1);
}

const opts = parseArgv(process.argv.slice(2));
if (!opts.tape) die("--tape is required");
if (!opts.port) die("--port is required");
if (!fs.existsSync(opts.tape)) die(`tape file not found: ${opts.tape}`);

const tapeEntries = parseTapeJsonl(fs.readFileSync(opts.tape, "utf8"));
const tapeByLane = groupTapeByLane(tapeEntries);
const cursors = new Map();

const stats = {
  label: opts.label,
  tape: opts.tape,
  lanes: Object.fromEntries([...tapeByLane.entries()].map(([lane, arr]) => [lane, arr.length])),
  requests: 0,
  hitsByLane: {},
  missesByLane: {},
  misses: [],
};

const missLogStream = opts.missLog ? fs.createWriteStream(opts.missLog, { flags: "a" }) : null;

const server = http.createServer((req, res) => {
  if (req.url === "/__stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("replay-proxy: only POST is served\n");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }

    stats.requests += 1;
    const lane = classifyRequest(payload);
    const { hit, index, entry } = nextTapeEntry(tapeByLane, cursors, lane);
    if (hit) {
      stats.hitsByLane[lane] = (stats.hitsByLane[lane] ?? 0) + 1;
    } else {
      stats.missesByLane[lane] = (stats.missesByLane[lane] ?? 0) + 1;
      const missRec = { ts: new Date().toISOString(), lane, index, model: payload?.model ?? null };
      stats.misses.push(missRec);
      if (missLogStream) missLogStream.write(`${JSON.stringify(missRec)}\n`);
      process.stderr.write(`replay-proxy[${opts.label}]: MISS lane=${lane} index=${index}\n`);
    }

    const bodyOut = renderReplyBody(payload, hit ? entry : null);
    const stream = requestWantsStream(payload);
    res.writeHead(200, {
      "Content-Type": stream ? "text/event-stream" : "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(bodyOut);
  });
});

function writeStatsAndExit(code) {
  if (opts.statsOut) {
    try {
      fs.writeFileSync(opts.statsOut, JSON.stringify(stats, null, 2));
    } catch (e) {
      process.stderr.write(`replay-proxy: failed to write stats: ${e}\n`);
    }
  }
  if (missLogStream) missLogStream.end();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}

process.on("SIGTERM", () => writeStatsAndExit(0));
process.on("SIGINT", () => writeStatsAndExit(0));

server.listen(opts.port, "127.0.0.1", () => {
  process.stdout.write(
    `replay-proxy[${opts.label}]: listening on 127.0.0.1:${opts.port} tape=${opts.tape} lanes=${JSON.stringify(stats.lanes)}\n`
  );
});
