#!/usr/bin/env node
// run-lostwake.mjs — the "lost wake" experiment (an embedder's lost-wake experiment) against the TypeScript port.
//
// Two scratch identities in a scratch HEADLONG_HOME, and ONE local replay server on LLM_API_URL
// (parity/support/replayModel.mjs) serving RECORDED real DeepSeek replies (parity/lostwake/recordings/shared.json), one
// short reply per channel, served in CYCLE to every call of that channel (labelled in each result's `replay` field):
//   structured — the responder's json_schema request: DeepSeek's real HTTP 400 ("response_format type is unavailable"),
//                so the responder falls back to text, exactly as on this provider in production;
//   message    — the text reply to a substantive chat message;
//   thanks     — the text reply to a message containing "thanks" (DeepSeek's real NO_REPLY);
//   notes      — the person-notes writer that follows a sent reply.
// No idle-wake channel: this experiment removes the monolith (and retrieval) thinkers, so no wake call is made; any
// call outside these channels is a recording miss and fails the run. Replay makes no network call and needs no key.
// Re-record: UC_RECORD=1 with DEEPSEEK_API_KEY in the env (never printed or stored); the record guard caps it.
// 50 chat messages per run (alternating direction), random dispatcher restarts (graceful `thinkers stop` or
// `kill -9`) while sending, then a settle window with both dispatchers up. Per message we ask: did it reach the
// recipient's trajectory (in_log), did a reply_claim name it, did an `observation` name it (consumed)?
// LOST = in the trajectory, no claim, no observation after the settle.
//
// Usage: node parity/lostwake/run-lostwake.mjs <none|graceful|kill> <seed> [--label L] [--chaos MIN,MAX] [--settle S] [--port P]
// Env:   LW_ROOT = scratch directory (default ../scratch/lostwake-ts next to the repo's parent)
//
// Nothing here touches any real identity, home, key or network host.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveIdentityEnv } from "../../src/identity-env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const NODE = process.execPath;
const [mode, seedArg, ...rest] = process.argv.slice(2);
if (!["none", "graceful", "kill"].includes(mode) || !seedArg) {
  console.error("usage: run-lostwake.mjs <none|graceful|kill> <seed> [--label L] [--chaos MIN,MAX] [--settle S] [--port P]");
  process.exit(2);
}
const seed = Number(seedArg);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? dflt : rest[i + 1];
};
const label = opt("label", "run");
const [CMIN, CMAX] = opt("chaos", "1,4").split(",").map(Number);
const SETTLE_S = Number(opt("settle", "30"));
const PORT = Number(opt("port", "18765")); // unused since the replay server picks its own port; kept for run-matrix.sh
const N = 50;
const ROOT = process.env.LW_ROOT || path.resolve(REPO, "..", "lostwake-ts");
const tag = `${label}-${mode}${seed}${CMIN === 1 && CMAX === 4 ? "" : CMIN === 10 && CMAX === 18 ? "-gentle" : `-c${String(CMIN).replace(".", "p")}-${String(CMAX).replace(".", "p")}`}`;
const HOME = path.join(ROOT, "homes", tag);
const IDS = path.join(HOME, ".identities");
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(IDS, { recursive: true });
fs.mkdirSync(path.join(HERE, "results"), { recursive: true });

// mulberry32: a seeded PRNG so a run's send timing and chaos schedule are reproducible.
let st = seed >>> 0;
const rnd = () => {
  st = (st + 0x6d2b79f5) >>> 0;
  let t = st;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uni = (a, b) => a + (b - a) * rnd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const names = [`a-${tag}`, `b-${tag}`];
const BASE = {
  PATH: [path.join(REPO, "bin"), path.dirname(NODE), "/usr/bin", "/bin"].join(path.delimiter),
  HOME: process.env.HOME || "/tmp",
  HEADLONG_HOME: HOME,
  LLM_PROVIDER: "openai-compatible",
  LLM_API_URL: "", // set below to the replay server
  LLM_API_KEY: "replay-not-a-key",
  THINK_MODEL: "openai/replay",
  SHELLM_MODEL: "openai/replay",
  LLM_MODEL: "openai/replay",
  SHELLM_ENV: "local",
  LC_ALL: "C",
};
function envFor(n) {
  const e = resolveIdentityEnv(path.join(IDS, n), { base: BASE, headlongHome: HOME, home: BASE.HOME });
  return { ...e, ...BASE, PATH: e.PATH ?? BASE.PATH };
}
function run(cmdArgs, env, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(NODE, cmdArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}
const bin = (f) => path.join(REPO, "bin", f);
const thinkers = (n, ...a) => run([bin("thinkers.mjs"), ...a], envFor(n));
const idir = (n) => path.join(IDS, n);
function pidOf(n) {
  try {
    return Number(fs.readFileSync(path.join(idir(n), "run", "dispatcher.pid"), "utf8").trim()) || null;
  } catch {
    return null;
  }
}
function alive(n) {
  const p = pidOf(n);
  if (!p) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- the one replay model server (127.0.0.1; recorded real replies, never the network in replay) ----
const { startReplay, REPLAY_MODEL } = await import("../support/replayModel.mjs");
const lastUser = (body) => {
  const u = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  return u ? (typeof u.content === "string" ? u.content : JSON.stringify(u.content)) : "";
};
const channelOf = (body) => {
  const sys = (body.messages ?? []).find((m) => m.role === "system")?.content ?? "";
  if (/You maintain .*'s private notes/.test(String(sys))) return "notes";
  if (!String(sys).includes("unconscious thought process of an AI person named")) return "other"; // never recorded: a miss
  if (body.response_format) return "structured";
  return /thanks/i.test(lastUser(body)) ? "thanks" : "message";
};
const replay = await startReplay({
  suite: "lostwake",
  dir: path.join(HERE, "recordings"),
  channelOf,
  recordingOf: () => "shared",
  cycle: true,
  forwardModel: REPLAY_MODEL,
  maxRecordCalls: 6,
  maxRecordUsd: 0.004,
});
BASE.LLM_API_URL = replay.url(tag, "port");

// ---- identities: only the responder thinker (the monolith needs shellm; the scripted server only answers the responder) ----
for (const n of names) {
  const r = await run([bin("identity.mjs"), "new", n], { ...BASE, IDENTITY_DIR: IDS });
  if (r.code !== 0) throw new Error(`identity new ${n}: ${r.out}`);
  for (const t of ["monolith", "retrieval"]) fs.rmSync(path.join(idir(n), "thinkers", t), { recursive: true, force: true });
  await thinkers(n, "start");
}
await sleep(2000);

const restarts = [];
let stopFlag = false;
const T0 = Date.now();
const since = () => Math.round((Date.now() - T0) / 10) / 100;
async function chaos() {
  while (!stopFlag) {
    await sleep(uni(CMIN, CMAX) * 1000);
    if (stopFlag) break;
    const n = names[Math.floor(rnd() * 2)];
    const t0 = since();
    if (mode === "kill") {
      const p = pidOf(n);
      if (p) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } else {
      await thinkers(n, "stop");
    }
    const down = uni(0, 3);
    await sleep(down * 1000);
    await thinkers(n, "start");
    restarts.push({ who: n, mode, down_s: Math.round(down * 100) / 100, t: t0, t_started: since() });
  }
}
const chaosP = mode === "none" ? Promise.resolve() : chaos();

const sent = [];
for (let i = 0; i < N; i++) {
  const [sender, recip] = i % 2 === 0 ? names : [names[1], names[0]];
  const body = `lw ${tag} msg ${i}${i % 5 === 4 ? " thanks" : ""}`;
  const up = alive(recip);
  const r = await run([bin("chat.mjs"), "send", "--from", sender, "--to", recip, body], envFor(recip));
  sent.push({ t_send: since(), i, to: recip, body, dispatcher_up_at_send: up, send_ok: r.code === 0 && /Message sent/.test(r.out) });
  await sleep(uni(0.3, 1.2) * 1000);
}
stopFlag = true;
await chaosP;
for (const n of names) if (!alive(n)) await thinkers(n, "start");
await sleep(SETTLE_S * 1000);

function load(n) {
  const dir = path.join(idir(n), "trajectories");
  const f = fs.readdirSync(dir).map((d) => path.join(dir, d, "trajectory.jsonl")).find((p) => fs.existsSync(p));
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const res = { tag, label, mode, seed, N, chaos: [CMIN, CMAX], settle_s: SETTLE_S, restarts, messages: [] };
for (const n of names) {
  const steps = load(n);
  const msgs = new Map(steps.filter((s) => s.type === "message" && s.source === "chat" && s.from !== n).map((s) => [s.content, s]));
  const claims = new Set(steps.filter((s) => s.type === "reply_claim").map((s) => s.trigger_step));
  const obs = new Map();
  for (const s of steps) if (s.type === "observation" && s.trigger_step && !obs.has(s.trigger_step)) obs.set(s.trigger_step, s.decision || "observation");
  // dispatcher-level consumed receipts (only present once the ledger exists): run/ledger/<thinker>.jsonl
  const done = new Set();
  try {
    for (const f of fs.readdirSync(path.join(idir(n), "run", "ledger"))) {
      for (const l of fs.readFileSync(path.join(idir(n), "run", "ledger", f), "utf8").split("\n")) {
        try {
          const o = JSON.parse(l);
          if (o.ev === "done") done.add(o.id);
        } catch {
          /* torn line */
        }
      }
    }
  } catch {
    /* no ledger: baseline */
  }
  for (const m of sent.filter((x) => x.to === n)) {
    const s = msgs.get(m.body);
    const sid = s ? s.step_id : null;
    res.messages.push({ ...m, in_log: Boolean(s), claimed: claims.has(sid), outcome: obs.get(sid) ?? null, receipt_done: done.has(sid) });
  }
}
res.messages.sort((a, b) => a.i - b.i);
const M = res.messages;
const lost = (m) => m.in_log && !m.claimed && m.outcome === null;
res.summary = {
  sent: M.length,
  in_log: M.filter((m) => m.in_log).length,
  consumed: M.filter((m) => m.outcome !== null).length,
  never_woken: M.filter(lost).length,
  claimed_not_finished: M.filter((m) => m.claimed && m.outcome === null).length,
  sent_while_dispatcher_down: M.filter((m) => !m.dispatcher_up_at_send).length,
  never_woken_while_down: M.filter((m) => !m.dispatcher_up_at_send && lost(m)).length,
  never_woken_while_up: M.filter((m) => m.dispatcher_up_at_send && lost(m)).length,
  restarts: restarts.length,
  sender_saw_success: M.filter((m) => m.send_ok).length,
  duplicate_replies: 0,
  receipts_done: M.filter((m) => m.receipt_done).length,
  outcomes: {},
};
for (const m of M) res.summary.outcomes[String(m.outcome)] = (res.summary.outcomes[String(m.outcome)] ?? 0) + 1;
// duplicates: >1 observation for one trigger (the same message answered twice)
for (const n of names) {
  const c = new Map();
  for (const s of load(n)) if (s.type === "observation" && s.trigger_step) c.set(s.trigger_step, (c.get(s.trigger_step) ?? 0) + 1);
  for (const v of c.values()) if (v > 1) res.summary.duplicate_replies += v - 1;
}
const reqs = replay.requests(tag, "port");
res.replay = {
  source: "recorded real DeepSeek replies (parity/lostwake/recordings/shared.json), one per channel, served in cycle",
  calls: reqs.length,
  by_channel: reqs.reduce((a, r) => ((a[r.channel] = (a[r.channel] ?? 0) + 1), a), {}),
  cycled: replay.cycled.length,
  misses: replay.misses,
};
fs.writeFileSync(path.join(HERE, "results", `${tag}.json`), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ tag, ...res.summary }));
for (const n of names) await thinkers(n, "stop");
// belt and braces: nothing of this run may outlive it
for (const n of names) {
  const p = pidOf(n);
  if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
}
await replay.close();
replay.verify(); // a recording miss fails loudly (after the result is written)
process.exit(0);
