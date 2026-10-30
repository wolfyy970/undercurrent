#!/usr/bin/env node
// parity/init/server-child.mjs — the local OpenAI-compatible endpoint both sides of the init harness are pointed at,
// in its OWN process (the harness runs each side with spawnSync, which would block an in-process server: before this
// file the in-process server could never answer, so the harness concluded "curl cannot reach loopback" and skipped
// every scenario that needs it).
//   GET  <base>/models            — WIRE FIXTURE (not model output): the model list a local server (Ollama, LM Studio)
//                                   advertises, from argv; init's model pick and its malicious-id refusal read it.
//   POST <base>/chat/completions  — forwarded to ONE parity/support/replayModel.mjs server serving a RECORDED real
//                                   DeepSeek reply (parity/init/recordings/shared.json), in cycle: init's
//                                   "Reply with the single word: ok" smoke call (channel smoke). A persona call
//                                   (channel persona) has no recording: no scenario reaches it, and one would miss.
// argv[2] = JSON { models, modelsStatus, portFile, missFile }. Base URL: http://127.0.0.1:<port>/<scenario>/<side>/v1.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startReplay, REPLAY_MODEL } from "../support/replayModel.mjs";

const o = JSON.parse(process.argv[2]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const channelOf = (body) => ((body.messages ?? []).some((m) => m.role === "system" && /identity prompts/.test(String(m.content))) ? "persona" : "smoke");
const replay = await startReplay({
  suite: "init",
  dir: path.join(HERE, "recordings"),
  channelOf,
  recordingOf: () => "shared",
  cycle: true,
  forwardModel: REPLAY_MODEL,
});
const hits = [];
const server = http.createServer((req, res) => {
  const m = /^\/([^/]+)\/([^/]+)\/v1\/(models|chat\/completions)$/.exec(req.url ?? "");
  if (m?.[3] === "models") hits.push(`${m[2]} models`);
  if (!m) {
    res.writeHead(404);
    return res.end();
  }
  if (m[3] === "models") {
    res.writeHead(o.modelsStatus ?? 200, { "content-type": "application/json" });
    return res.end(o.models);
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      hits.push(`${m[2]} chat:${channelOf(JSON.parse(raw))}`);
    } catch {
      hits.push(`${m[2]} chat:unparsable`);
    }
    const up = await fetch(replay.url(decodeURIComponent(m[1]), decodeURIComponent(m[2])), { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    res.end(await up.text());
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(o.portFile, String(server.address().port)));
setInterval(() => {
  fs.writeFileSync(o.missFile, JSON.stringify({ misses: replay.misses, hits }));
  try {
    process.kill(process.ppid, 0);
    if (process.ppid === 1) process.exit(0);
  } catch {
    process.exit(0);
  }
}, 100);
