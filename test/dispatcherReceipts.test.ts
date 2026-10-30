// dispatcherReceipts.test.ts — scheduled-wake claim/sent receipts and the stale-claim sweep
// (upstream 2e39a3f: bin/thinkers _scheduled_wake_check / _sweep_claims; oracle tests
// tests/test_thinkers_wake_at.sh and tests/test_dispatcher_single_owner.sh run against the port via
// parity/upstream-tests --daemon).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Dispatcher, type ThinkerDef, type TriggerStep } from "../src/dispatcher.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const NOW = 1_800_000_000;

function rig(opts: { claimStaleSecs?: number; dieAfterClaim?: boolean; dieHook?: () => void } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-receipts-"));
  const run = path.join(root, "run");
  fs.mkdirSync(run, { recursive: true });
  const runs: TriggerStep[] = [];
  const lines: string[] = [];
  const d = new Dispatcher(null, { stateDir: run, identityName: "pax", logSink: (l) => lines.push(l), ...opts });
  const def: ThinkerDef = {
    name: "napper",
    subscription: { types: ["action", "monolith-wake"], triggerSelf: false, watchdogSecs: 0 },
    run: async (t) => {
      runs.push(t);
    },
  };
  d.register(def);
  return { run, runs, lines, d, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const age = (p: string, secs: number) => fs.utimesSync(p, NOW - secs, NOW - secs);
const wake = (run: string, t = NOW - 1) => fs.writeFileSync(path.join(run, "napper.wake_at"), String(t));

describe("scheduled wake receipts", () => {
  it("claims then launches once and leaves no receipt or wake file", async () => {
    const r = rig();
    try {
      wake(r.run);
      r.d.tick(NOW);
      await flush();
      expect(r.runs.map((x) => x.type)).toEqual(["monolith-wake"]);
      expect(fs.existsSync(path.join(r.run, "napper.wake_at"))).toBe(false);
      expect(fs.readdirSync(path.join(r.run, "claimed"))).toEqual([]);
      expect(fs.readdirSync(path.join(r.run, "sent"))).toEqual([]);
      r.d.tick(NOW + 1);
      await flush();
      expect(r.runs.length).toBe(1);
    } finally {
      r.done();
    }
  });

  it("fault injection dies between the claim and the launch: nothing dispatches, the claim stays as evidence", async () => {
    let died = 0;
    const r = rig({ dieAfterClaim: true, dieHook: () => void died++ });
    try {
      wake(r.run);
      r.d.tick(NOW);
      await flush();
      expect(died).toBe(1);
      expect(r.runs.length).toBe(0);
      expect(fs.readdirSync(path.join(r.run, "claimed"))).toEqual(["napper"]);
      expect(fs.existsSync(path.join(r.run, "napper.wake_at"))).toBe(false);
    } finally {
      r.done();
    }
  });
});

describe("stale-claim sweep", () => {
  it("a stale claim alone is re-armed into a wake_at and fires exactly one wake", async () => {
    const r = rig({ claimStaleSecs: 30 });
    try {
      fs.mkdirSync(path.join(r.run, "claimed"));
      const c = path.join(r.run, "claimed", "napper");
      fs.writeFileSync(c, String(NOW - 100));
      age(c, 60);
      r.d.tick(NOW); // sweep re-arms; the same tick's wake pass then fires it
      await flush();
      expect(r.runs.length).toBe(1);
      expect(fs.existsSync(c)).toBe(false);
      expect(fs.existsSync(path.join(r.run, "napper.wake_at"))).toBe(false);
      expect(r.lines.some((l) => l.includes("re-armed stale claim napper (age 60s)"))).toBe(true);
    } finally {
      r.done();
    }
  });

  it("a fresh claim is left alone", async () => {
    const r = rig({ claimStaleSecs: 30 });
    try {
      fs.mkdirSync(path.join(r.run, "claimed"));
      const c = path.join(r.run, "claimed", "napper");
      fs.writeFileSync(c, String(NOW - 100));
      age(c, 5);
      r.d.tick(NOW);
      await flush();
      expect(r.runs.length).toBe(0);
      expect(fs.existsSync(c)).toBe(true);
    } finally {
      r.done();
    }
  });

  it("a stale claim is dropped when a live wake_at already holds the name (the scheduled time wins)", async () => {
    const r = rig({ claimStaleSecs: 30 });
    try {
      fs.mkdirSync(path.join(r.run, "claimed"));
      const c = path.join(r.run, "claimed", "napper");
      fs.writeFileSync(c, String(NOW - 100));
      age(c, 60);
      wake(r.run, NOW + 3600); // live, not yet due
      r.d.tick(NOW);
      await flush();
      expect(r.runs.length).toBe(0);
      expect(fs.existsSync(c)).toBe(false);
      expect(fs.readFileSync(path.join(r.run, "napper.wake_at"), "utf8")).toBe(String(NOW + 3600));
      expect(r.lines.some((l) => l.includes(`dropped stale claim napper, kept scheduled wake_at ${NOW + 3600}`))).toBe(true);
    } finally {
      r.done();
    }
  });

  it("a readable claim re-arms over an unreadable wake_at; an unreadable claim is dropped and the wake_at left alone", async () => {
    const r = rig({ claimStaleSecs: 30 });
    try {
      fs.mkdirSync(path.join(r.run, "claimed"));
      const c = path.join(r.run, "claimed", "napper");
      fs.writeFileSync(c, String(NOW + 500));
      age(c, 60);
      fs.writeFileSync(path.join(r.run, "napper.wake_at"), "garbage");
      r.d.watchdogCheck(NOW); // no-op, keeps the API honest
      (r.d as unknown as { sweepClaims(n: number): void }).sweepClaims(NOW);
      expect(fs.readFileSync(path.join(r.run, "napper.wake_at"), "utf8")).toBe(String(NOW + 500));
      expect(fs.existsSync(c)).toBe(false);

      fs.writeFileSync(c, "nope");
      age(c, 60);
      fs.writeFileSync(path.join(r.run, "napper.wake_at"), "garbage");
      (r.d as unknown as { sweepClaims(n: number): void }).sweepClaims(NOW);
      expect(fs.readFileSync(path.join(r.run, "napper.wake_at"), "utf8")).toBe("garbage");
      expect(fs.existsSync(c)).toBe(false);
      expect(r.lines.some((l) => l.includes("unreadable due time"))).toBe(true);
    } finally {
      r.done();
    }
  });

  it("a stale sent receipt is dropped, never re-armed (the send already happened)", async () => {
    const r = rig({ claimStaleSecs: 30 });
    try {
      fs.mkdirSync(path.join(r.run, "sent"));
      const s = path.join(r.run, "sent", "napper");
      fs.writeFileSync(s, String(NOW - 100));
      age(s, 60);
      r.d.tick(NOW);
      await flush();
      expect(r.runs.length).toBe(0);
      expect(fs.existsSync(s)).toBe(false);
      expect(fs.existsSync(path.join(r.run, "napper.wake_at"))).toBe(false);
      expect(r.lines.some((l) => l.includes("dropped stale sent receipt napper (age 60s)"))).toBe(true);
    } finally {
      r.done();
    }
  });
});
