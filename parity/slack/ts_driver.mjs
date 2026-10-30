#!/usr/bin/env node
// ts_driver.mjs — drives the TS port's Inbound/outbound.run against the fake
// server for one parity scenario. See run-parity.mjs's header for the full
// harness design (why this drives the module-level API rather than the
// Socket Mode CLI, and how the Slack Web API leg is reached without
// touching slack.com).
//
// Usage: node ts_driver.mjs <spec.json>
// Reads the scenario spec, does the work, exits 0/1. On-disk state and the
// fake server's recorded requests are read directly by run-parity.mjs (same
// machine, same files) — this driver reports nothing but exit status.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const { WebClient } = await import(path.join(REPO, "src/slack/api.ts"));
const { Inbound } = await import(path.join(REPO, "src/slack/inbound.ts"));
const { ActiveThreads } = await import(path.join(REPO, "src/slack/state.ts"));
const outbound = await import(path.join(REPO, "src/slack/outbound.ts"));

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

function makeCfg() {
  const sandbox = spec.sandbox;
  const identityDir = path.join(sandbox, ".identities", spec.cfg.identity);
  const stateDir = path.join(sandbox, "state");
  fs.mkdirSync(identityDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    serveRoot: sandbox,
    identity: spec.cfg.identity,
    identityDir,
    botToken: spec.cfg.botToken,
    appToken: spec.cfg.appToken,
    webUrl: `http://127.0.0.1:${spec.port}`,
    stateDir,
    threadFollowups: spec.cfg.threadFollowups ?? false,
    threadJoinBackfill: spec.cfg.threadJoinBackfill ?? 0,
    peerBotUsers: new Set(spec.cfg.peerBotUsers ?? []),
    peerMaxTurns: spec.cfg.peerMaxTurns ?? 4,
    peerHourlyCap: spec.cfg.peerHourlyCap ?? 30,
  };
}

async function main() {
  const cfg = makeCfg();
  const client = new WebClient(cfg.botToken, { baseUrl: `http://127.0.0.1:${spec.port}/api` });
  const noopLog = () => {};

  if (spec.mode === "on_event") {
    const threads = new ActiveThreads(path.join(cfg.stateDir, "active_threads.json"));
    const ib = new Inbound(cfg, client, spec.cfg.botUserId, threads, { log: noopLog });
    for (const event of spec.events) {
      ib.onEvent(event);
    }
    await ib.flush();
    return;
  }

  if (spec.mode === "outbound") {
    const trajDir = path.join(cfg.identityDir, "trajectories", "12345678-root");
    fs.mkdirSync(trajDir, { recursive: true });
    const trajFile = path.join(trajDir, "trajectory.jsonl");
    const lines = spec.seedTrajectorySteps.map((s) => JSON.stringify(s));
    fs.writeFileSync(trajFile, lines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(cfg.identityDir, "info.txt"),
      `name=${spec.cfg.identity}\nroot_trajectory=12345678-1111-2222-3333-444455556666\n`,
    );
    if (spec.seedCursorOffsetZero) {
      fs.writeFileSync(path.join(cfg.stateDir, "cursor"), "0");
    }
    if (spec.seedCursorRaw != null) {
      fs.writeFileSync(path.join(cfg.stateDir, "cursor"), spec.seedCursorRaw.replace("<SANDBOX>", spec.sandbox));
    }
    // 2e39a3f: delivery notices -> a sink file (see py_driver.py).
    const noticesFile = path.join(spec.sandbox, "notices.jsonl");
    const appendStep = (_root, _traj, step) => {
      fs.appendFileSync(noticesFile, JSON.stringify(sortKeys(step)) + "\n");
    };
    const threads = new ActiveThreads(path.join(cfg.stateDir, "active_threads.json"));
    let calls = 0;
    const shouldStop = () => {
      const stop = calls > 0;
      calls += 1;
      return stop;
    };
    await outbound.run(cfg, client, threads, { shouldStop, log: noopLog, appendStep });
    return;
  }

  throw new Error(`unknown scenario mode: ${spec.mode}`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`ts_driver error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
}
