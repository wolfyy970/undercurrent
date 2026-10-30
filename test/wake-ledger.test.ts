// wake-ledger.test.ts — the lost-wake fix (wakeLedger.ts + feeder cursor + dispatcher replay).
// Delivered != consumed: a message that is stored in a trajectory must wake its thinker even if the
// dispatcher was down, restarted, or killed between storing and waking.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { WakeLedger, readCursor, writeCursor, answeredIds } from "../src/wakeLedger.ts";
import { TrajFeeder } from "../src/feeder.ts";
import { Dispatcher, type ThinkerDef, type TriggerStep } from "../src/dispatcher.ts";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { appendStep } from "../src/trajCore.mjs";
import { feedersLive } from "./support/daemonReady.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  while (children.length) {
    const c = children.pop()!;
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise<void>((r) => {
        c.once("exit", () => r());
        setTimeout(r, 1000);
      });
    }
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-wl-"));
  roots.push(d);
  return d;
}
const msg = (id: string, content = id): TriggerStep => ({ type: "message", source: "chat", from: "x", to: "me", content, step_id: id });

/** A thinker whose runs block until released; `exit` is what each run resolves with. */
function gated(name: string) {
  const runs: TriggerStep[] = [];
  const res: ((v: void | number) => void)[] = [];
  const def: ThinkerDef = {
    name,
    subscription: { types: ["message"], triggerSelf: false, watchdogSecs: 0 },
    run: (t) => {
      runs.push(t);
      return new Promise((r) => res.push(r));
    },
  };
  return { def, runs, release: (v?: void | number) => res.shift()?.(v as never), pendingRuns: () => res.length };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 15));

describe("WakeLedger", () => {
  it("recv/done round-trips through load(); an owed step survives, a consumed one does not", () => {
    const run = tmp();
    const a = new WakeLedger(run);
    expect(a.recv("responder", "s1", "/t.jsonl", msg("s1"))).toBe(true);
    expect(a.recv("responder", "s2", "/t.jsonl", msg("s2"))).toBe(true);
    expect(a.recv("responder", "s1", "/t.jsonl", msg("s1"))).toBe(false); // not owed twice
    a.done("responder", "s1");
    const b = new WakeLedger(run);
    b.load();
    expect(b.unconsumed("responder").map((e) => e.id)).toEqual(["s2"]);
    expect(b.known("responder", "s1")).toBe(true); // consumed ids are remembered, so a replay does not re-owe them
    expect(b.recv("responder", "s1", "/t.jsonl", msg("s1"))).toBe(false);
  });

  it("a torn last line (kill -9 mid-append) is ignored", () => {
    const run = tmp();
    const a = new WakeLedger(run);
    a.recv("t", "s1", "/f", msg("s1"));
    fs.appendFileSync(path.join(run, "ledger", "t.jsonl"), '{"ev":"recv","id":"s2","fi');
    const b = new WakeLedger(run);
    b.load();
    expect(b.unconsumed("t").map((e) => e.id)).toEqual(["s1"]);
  });

  it("load() compacts: consumed pairs collapse, owed entries are kept verbatim", () => {
    const run = tmp();
    const a = new WakeLedger(run);
    for (let i = 0; i < 20; i++) a.recv("t", `s${i}`, "/f", msg(`s${i}`));
    for (let i = 0; i < 19; i++) a.done("t", `s${i}`);
    const before = fs.readFileSync(path.join(run, "ledger", "t.jsonl"), "utf8").split("\n").filter(Boolean).length;
    new WakeLedger(run).load();
    const after = fs.readFileSync(path.join(run, "ledger", "t.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(before).toBe(39);
    expect(after).toBe(20); // 1 owed recv + 19 done markers (the dedupe window)
  });

  it("cursor round-trip; a corrupt cursor reads as none", () => {
    const run = tmp();
    expect(readCursor(run, "/a/b.jsonl")).toBeNull();
    writeCursor(run, { file: "/a/b.jsonl", ino: 7, offset: 123 });
    expect(readCursor(run, "/a/b.jsonl")).toEqual({ file: "/a/b.jsonl", ino: 7, offset: 123 });
    const f = path.join(run, "cursor", fs.readdirSync(path.join(run, "cursor"))[0]!);
    fs.writeFileSync(f, "{not json");
    expect(readCursor(run, "/a/b.jsonl")).toBeNull();
  });

  it("answeredIds finds a thinker's own answer by trigger_step, and ignores a bare claim", () => {
    const d = tmp();
    const f = path.join(d, "t.jsonl");
    fs.writeFileSync(
      f,
      [
        { type: "message", step_id: "m1" },
        { type: "reply_claim", source: "responder", trigger_step: "m1" },
        { type: "message", step_id: "m2" },
        { type: "observation", source: "responder", trigger_step: "m2", decision: "replied" },
        { type: "observation", source: "monolith", trigger_step: "m1" },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n"
    );
    expect([...answeredIds(f, "responder", new Set(["m1", "m2"]))]).toEqual(["m2"]);
  });
});

describe("TrajFeeder cursor", () => {
  it("start(from) resumes at the cursor and delivers what was appended while nobody was listening", async () => {
    const d = tmp();
    const file = path.join(d, "t.jsonl");
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const ino = fs.statSync(file).ino;
    const off = Buffer.byteLength('{"n":1}\n');
    fs.appendFileSync(file, '{"n":3}\n');
    const got: string[] = [];
    const f = new TrajFeeder(file, { onLine: (l) => got.push(l) });
    f.start({ ino, offset: off });
    f.poll();
    f.close();
    expect(got).toEqual(['{"n":2}', '{"n":3}']);
  });

  it("a cursor for another inode, or past the end, falls back to end of file (a replaced file is not replayed)", () => {
    const d = tmp();
    const file = path.join(d, "t.jsonl");
    fs.writeFileSync(file, '{"n":1}\n');
    const ino = fs.statSync(file).ino;
    for (const from of [{ ino: ino + 1, offset: 0 }, { ino, offset: 9999 }]) {
      const got: string[] = [];
      const f = new TrajFeeder(file, { onLine: (l) => got.push(l) });
      f.start(from);
      f.poll();
      f.close();
      expect(got).toEqual([]);
    }
  });

  it("onAdvance reports the offset just past the last complete line, never into a partial one", () => {
    const d = tmp();
    const file = path.join(d, "t.jsonl");
    fs.writeFileSync(file, "");
    const seen: number[] = [];
    const f = new TrajFeeder(file, { onLine: () => {}, onAdvance: (p) => seen.push(p.offset) });
    f.start();
    fs.appendFileSync(file, '{"a":1}\n{"b"');
    f.poll();
    f.close();
    expect(seen).toEqual([Buffer.byteLength('{"a":1}\n')]);
    expect(f.position()?.offset).toBe(Buffer.byteLength('{"a":1}\n'));
  });
});

describe("Dispatcher + ledger", () => {
  it("a message is owed from the moment it is fed, consumed when its step exits 0", async () => {
    const run = tmp();
    const ledger = new WakeLedger(run);
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger });
    const g = gated("responder");
    d.register(g.def);
    d.feed(msg("m1"), "/t.jsonl");
    await tick();
    expect(g.runs.length).toBe(1);
    expect(ledger.isOwed("responder", "m1")).toBe(true); // stored, running, NOT consumed
    g.release(0);
    await tick();
    expect(ledger.isOwed("responder", "m1")).toBe(false);
  });

  it("a failed step (non-zero exit) leaves the message owed; it is re-run by the next dispatcher", async () => {
    const run = tmp();
    const l1 = new WakeLedger(run);
    const d1 = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l1 });
    const g1 = gated("responder");
    d1.register(g1.def);
    d1.feed(msg("m1"), "/t.jsonl");
    await tick();
    g1.release(1);
    await tick();
    expect(l1.isOwed("responder", "m1")).toBe(true);

    const l2 = new WakeLedger(run);
    l2.load();
    const d2 = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l2 });
    const g2 = gated("responder");
    d2.register(g2.def);
    const r = d2.replayOwed(() => undefined);
    await tick();
    expect(r.requeued).toBe(1);
    expect(g2.runs.map((t) => t.step_id)).toEqual(["m1"]);
    g2.release(0);
    await tick();
    expect(l2.isOwed("responder", "m1")).toBe(false);
  });

  it("messages queued behind a busy thinker survive a stop: they are replayed in order after a restart", async () => {
    const run = tmp();
    const l1 = new WakeLedger(run);
    const d1 = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l1 });
    const g1 = gated("responder");
    d1.register(g1.def);
    for (const id of ["m1", "m2", "m3", "m4"]) d1.feed(msg(id), "/t.jsonl");
    await tick();
    expect(g1.runs.map((t) => t.step_id)).toEqual(["m1"]); // m2..m4 queued in memory/pending, then the process "dies"
    // — upstream rm -rf's run/pending here; the ledger is what remains.
    const l2 = new WakeLedger(run);
    l2.load();
    expect(l2.unconsumed("responder").map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4"]);
    const d2 = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l2 });
    const g2 = gated("responder");
    d2.register(g2.def);
    d2.replayOwed(() => undefined);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      await tick();
      order.push(String(g2.runs[i]?.step_id));
      g2.release(0);
    }
    await tick();
    expect(order).toEqual(["m1", "m2", "m3", "m4"]);
    expect(l2.owedCount()).toBe(0);
  });

  it("an owed step the trajectory already answers is released, not re-run (no double reply)", async () => {
    const run = tmp();
    const file = path.join(run, "t.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "observation", source: "responder", trigger_step: "m1", decision: "replied" }) + "\n");
    const l1 = new WakeLedger(run);
    l1.recv("responder", "m1", file, msg("m1"));
    l1.recv("responder", "m2", file, msg("m2"));
    const l2 = new WakeLedger(run);
    l2.load();
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l2 });
    const g = gated("responder");
    d.register(g.def);
    const r = d.replayOwed(() => undefined);
    await tick();
    expect(r).toEqual({ requeued: 1, answered: 1, released: 0 });
    expect(g.runs.map((t) => t.step_id)).toEqual(["m2"]);
  });

  it("an owed step for a thinker that is now off is released", () => {
    const run = tmp();
    const l1 = new WakeLedger(run);
    l1.recv("responder", "m1", "/f", msg("m1"));
    const l2 = new WakeLedger(run);
    l2.load();
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger: l2, isActive: () => false });
    d.register(gated("responder").def);
    expect(d.replayOwed(() => undefined)).toEqual({ requeued: 0, answered: 0, released: 1 });
    expect(l2.owedCount()).toBe(0);
  });

  it("past the 16-deep pending FIFO nothing is dropped (upstream drops the oldest) and order holds", async () => {
    const run = tmp();
    const ledger = new WakeLedger(run);
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger });
    const g = gated("responder");
    d.register(g.def);
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    for (const id of ids) d.feed(msg(id), "/t.jsonl");
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await tick();
      seen.push(String(g.runs[i]?.step_id));
      g.release(0);
    }
    await tick();
    expect(seen).toEqual(ids);
    expect(ledger.owedCount()).toBe(0);
  });

  it("a replayed (cursor gap) step is ledgered once even if the live feeder also delivers it", async () => {
    const run = tmp();
    const ledger = new WakeLedger(run);
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger });
    const g = gated("responder");
    d.register(g.def);
    d.feed(msg("m1"), "/t.jsonl", { replay: true });
    d.feed(msg("m1"), "/t.jsonl");
    await tick();
    expect(g.runs.length).toBe(1);
  });

  it("only message/action are replayed; other types keep upstream's rule", async () => {
    const run = tmp();
    const ledger = new WakeLedger(run);
    const d = new Dispatcher(null, { stateDir: run, identityName: "me", ledger });
    const run1: TriggerStep[] = [];
    d.register({ name: "m", subscription: { types: [], triggerSelf: false, watchdogSecs: 0 }, run: async (t) => void run1.push(t) });
    d.feed({ type: "observation", source: "responder", step_id: "o1" }, "/t.jsonl", { replay: true });
    await tick();
    expect(run1).toEqual([]);
  });
});

// ---- the real daemon, killed and restarted ----

function makeRig() {
  const root = tmp();
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  const idDir = result.identityDir;
  fs.writeFileSync(path.join(idDir, "thinkers", "monolith", "disabled"), "x");
  fs.writeFileSync(path.join(idDir, "thinkers", "responder", "disabled"), "x");
  const echoDir = path.join(idDir, "thinkers", "echo");
  fs.mkdirSync(echoDir, { recursive: true });
  fs.writeFileSync(path.join(echoDir, "subscriptions.jsonl"), `${JSON.stringify({ types: ["message"], trigger_self: false, traj_id: result.rootTrajectoryId })}\n`);
  fs.writeFileSync(
    path.join(echoDir, "step"),
    "#!/usr/bin/env node\nimport * as fs from 'node:fs';\nconst t = JSON.parse(fs.readFileSync(0, 'utf8'));\nfs.appendFileSync(process.env.IDENTITY_DIR + '/echo.seen', t.content + '\\n');\n"
  );
  fs.chmodSync(path.join(echoDir, "step"), 0o755);
  const runDir = path.join(idDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "active_thinkers"), "echo\n");
  const trajFile = path.join(idDir, "trajectories", `${result.rootTrajectoryId.slice(0, 8)}-root`, "trajectory.jsonl");
  return { idDir, runDir, trajFile };
}
const DISPATCHERD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "dispatcherd.mjs");
function spawnDaemon(rig: ReturnType<typeof makeRig>, extra: Record<string, string> = {}): ChildProcess {
  const env = { ...resolveIdentityEnv(rig.idDir, { base: process.env as Record<string, string> }), ...extra };
  const c = spawn(process.execPath, [DISPATCHERD], { env, stdio: ["ignore", "ignore", "ignore"] });
  children.push(c);
  return c;
}
// Waits on the condition itself. The budget is not a speed limit: under a full parallel suite every echo step is a
// cold node start (seconds each), and the replay runs them one after another, so a fixed 8 s budget was a flake, not a
// check. A daemon that died fails the wait at once with its exit status; the test's own timeout bounds the rest.
async function until(pred: () => boolean, what = "condition", daemon?: ChildProcess, ms = 45000): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (pred()) return;
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`dispatcherd exited (code ${daemon.exitCode}, signal ${daemon.signalCode}) while waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what} (${ms}ms)`);
}
// Daemon START-UP (a fresh node process loading bin/dispatcherd.mjs) is not what these tests measure, and under a
// full parallel suite a cold start alone has taken longer than 8s. Wait for it on its own budget, but only while the
// child is alive: a daemon that died is reported at once with its exit status, never waited out.
async function started(c: ChildProcess, rig: ReturnType<typeof makeRig>, ms = 25000): Promise<void> {
  const t = Date.now();
  const marker = path.join(rig.runDir, "sub_map");
  while (Date.now() - t < ms) {
    if (fs.existsSync(marker)) return;
    if (c.exitCode !== null || c.signalCode !== null) throw new Error(`dispatcherd exited during start-up (code ${c.exitCode}, signal ${c.signalCode})`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`dispatcherd still alive but not started after ${ms}ms`);
}
const seenLines = (rig: ReturnType<typeof makeRig>) => {
  try {
    return fs.readFileSync(path.join(rig.idDir, "echo.seen"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));

describe("daemon: kill -9 and restart (real bin/dispatcherd.mjs)", () => {
  it("messages stored while the dispatcher is down wake the thinker when it comes back; the receipt says consumed", async () => {
    const rig = makeRig();
    const d1 = spawnDaemon(rig);
    await started(d1, rig);
    await feedersLive(rig.runDir, d1); // sub_map is not "tailing" (PARITY.md "Start-up window")
    appendStep(rig.trajFile, { type: "message", content: "before", from: "x", to: "pax", source: "chat" }, {});
    await until(() => seenLines(rig).includes("before"), "echo to see the live message", d1);
    await until(() => (fs.existsSync(path.join(rig.runDir, "ledger", "echo.jsonl")) ? fs.readFileSync(path.join(rig.runDir, "ledger", "echo.jsonl"), "utf8").includes('"ev":"done"') : false), "the ledger's done receipt", d1);

    d1.kill("SIGKILL");
    await exited(d1);
    fs.rmSync(path.join(rig.runDir, "dispatcher.pid"), { force: true });
    appendStep(rig.trajFile, { type: "message", content: "while-down-1", from: "x", to: "pax", source: "chat" }, {});
    appendStep(rig.trajFile, { type: "message", content: "while-down-2", from: "x", to: "pax", source: "chat" }, {});

    // The restarted daemon writes sub_map again; remove the old one so start-up is observed, not assumed.
    fs.rmSync(path.join(rig.runDir, "sub_map"), { force: true });
    const d2 = spawnDaemon(rig);
    await started(d2, rig);
    await until(() => seenLines(rig).length >= 3, "the two stored messages to wake echo", d2);
    expect(seenLines(rig)).toEqual(["before", "while-down-1", "while-down-2"]); // each exactly once, in order
    await until(() => {
      const l = new WakeLedger(rig.runDir);
      l.load();
      return l.owedCount() === 0;
    }, "nothing owed", d2);
  }, 120000);

  it("THINKERS_WAKE_LEDGER=0 restores upstream's behaviour: the same messages are NOT replayed", async () => {
    const rig = makeRig();
    const d1 = spawnDaemon(rig, { THINKERS_WAKE_LEDGER: "0" });
    await started(d1, rig);
    d1.kill("SIGKILL");
    await exited(d1);
    fs.rmSync(path.join(rig.runDir, "dispatcher.pid"), { force: true });
    appendStep(rig.trajFile, { type: "message", content: "lost", from: "x", to: "pax", source: "chat" }, {});
    fs.rmSync(path.join(rig.runDir, "sub_map"), { force: true });
    const d2 = spawnDaemon(rig, { THINKERS_WAKE_LEDGER: "0" });
    await started(d2, rig);
    await feedersLive(rig.runDir, d2);
    // No sleep: a message sent now is delivered live; a replay of "lost" would have run before it (replay comes first
    // at start-up), so once echo has seen "after", "lost" not being there is the answer.
    appendStep(rig.trajFile, { type: "message", content: "after", from: "x", to: "pax", source: "chat" }, {});
    await until(() => seenLines(rig).includes("after"), "echo to see the live message", d2);
    expect(seenLines(rig)).toEqual(["after"]);
    expect(fs.existsSync(path.join(rig.runDir, "ledger"))).toBe(false);
  }, 120000);
});
