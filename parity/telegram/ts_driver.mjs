#!/usr/bin/env node
// ts_driver.mjs — drives the TS port's Inbound/outbound.run against the fake
// server for one parity scenario. See run-parity.mjs's header for the full
// harness design (why this drives the module-level API rather than spawning
// the long-poll CLI, and how the Bot API leg is reached without touching
// api.telegram.org).
//
// Usage: node ts_driver.mjs <spec.json>
// Reads the scenario spec, does the work, exits 0/1. On-disk state and the
// fake server's recorded requests are read directly by run-parity.mjs
// (same machine, same files) — this driver reports nothing but exit status.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const { Bot } = await import(path.join(REPO, "src/telegram/api.ts"));
const { Allowlist } = await import(path.join(REPO, "src/telegram/allowlist.ts"));
const { Inbound } = await import(path.join(REPO, "src/telegram/inbound.ts"));
const outbound = await import(path.join(REPO, "src/telegram/outbound.ts"));

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

function makeFetchImpl(port) {
  return async (url, init) => {
    const u = new URL(url);
    const rewritten = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
    return fetch(rewritten, init);
  };
}

function seedAllowlistFile(stateDir, seed) {
  if (!seed) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "allowlist.json"), JSON.stringify(seed, null, 2));
}

async function main() {
  const cfg = {
    serveRoot: spec.sandbox,
    identity: spec.cfg.identity,
    identityDir: path.join(spec.sandbox, ".identities", spec.cfg.identity),
    botToken: spec.cfg.botToken,
    adminId: spec.cfg.adminId,
    webUrl: `http://127.0.0.1:${spec.port}`,
    stateDir: path.join(spec.sandbox, "state"),
  };
  fs.mkdirSync(cfg.identityDir, { recursive: true });
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  seedAllowlistFile(cfg.stateDir, spec.seedAllowlist);

  const bot = new Bot(cfg.botToken, { fetchImpl: makeFetchImpl(spec.port) });
  const allowlist = new Allowlist(path.join(cfg.stateDir, "allowlist.json"));
  const noopLog = () => {};

  if (spec.mode === "handle") {
    const ib = new Inbound(cfg, bot, allowlist, { log: noopLog });
    for (const update of spec.updates) {
      await ib.handle(update);
    }
    return;
  }

  if (spec.mode === "run-poll") {
    const ib = new Inbound(cfg, bot, allowlist, { log: noopLog });
    let calls = 0;
    const shouldStop = () => {
      const stop = calls >= spec.stopAfter;
      calls += 1;
      return stop;
    };
    await ib.run(shouldStop);
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
    const sortKeys = (v) =>
      Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
    const appendStep = (_root, _traj, step) => {
      fs.appendFileSync(noticesFile, JSON.stringify(sortKeys(step)) + "\n");
    };
    // outbound.run checks shouldStop once in its retry loop before the follow's
    // first poll (as upstream's does): allow two.
    let calls = 0;
    const shouldStop = () => {
      const stop = calls > 1;
      calls += 1;
      return stop;
    };
    await outbound.run(cfg, bot, allowlist, { shouldStop, log: noopLog, appendStep });
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
