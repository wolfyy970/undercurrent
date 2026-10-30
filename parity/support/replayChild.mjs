#!/usr/bin/env node
// parity/support/replayChild.mjs — runs ONE parity/support/replayModel.mjs server in its own process, for a harness
// that drives the code under test with spawnSync (an in-process server would be starved). Same idea as
// test/support/recordedServerChild.ts. Nothing here writes model text: it serves recordings (or the labelled HTTP
// transport fixtures it is given) exactly as replayModel.mjs does.
//
// argv[2] = JSON { suite, dir, recording, channels: "main" | "recap", cycle, transportByPrefix: { <scenario prefix>:
//   { <channel or "*">: fixture } }, portFile, missFile }
// Writes the port to portFile once listening; appends every miss (one per line) to missFile as it happens; exits when
// its parent is gone (checked once a second).
import * as fs from "node:fs";
import { startReplay, REPLAY_MODEL } from "./replayModel.mjs";

const o = JSON.parse(process.argv[2]);
const CHANNELS = {
  main: () => "main",
  // parity/recap/run-parity.mjs's split: one recorded reply per recap call kind.
  recap: (body) => {
    const sys = (body.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    if (sys.includes("one window of an AI agent")) return "map";
    if (sys.includes("numbered episode summaries")) return "reduce";
    if (sys.includes("FIRST PERSON")) return "rollup";
    return "other";
  },
};
// fixtures[scenario] looked up by scenario-name PREFIX, so a harness can name scenarios "transport-500-<n>".
const fixtures = new Proxy(
  {},
  {
    get(_t, scenario) {
      for (const [prefix, byChannel] of Object.entries(o.transportByPrefix ?? {})) {
        if (typeof scenario === "string" && scenario.startsWith(prefix)) {
          const all = byChannel["*"];
          return all ? new Proxy({}, { get: () => ({ "*": all }) }) : Object.fromEntries(Object.entries(byChannel).map(([c, f]) => [c, { "*": f }]));
        }
      }
      return undefined;
    },
  }
);
const replay = await startReplay({
  suite: o.suite,
  dir: o.dir,
  channelOf: CHANNELS[o.channels ?? "main"],
  recordingOf: () => o.recording,
  cycle: o.cycle ?? true,
  forwardModel: REPLAY_MODEL,
  fixtures,
});
const seen = { n: 0 };
setInterval(() => {
  for (; seen.n < replay.misses.length; seen.n++) fs.appendFileSync(o.missFile, replay.misses[seen.n].replace(/\n/g, " ") + "\n");
  try {
    process.kill(process.ppid, 0);
    if (process.ppid === 1) process.exit(0);
  } catch {
    process.exit(0);
  }
}, 200);
const url = replay.url("x", "y");
fs.writeFileSync(o.portFile, new URL(url).port);
