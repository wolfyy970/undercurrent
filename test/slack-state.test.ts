// slack-state.test.ts — no upstream Python test file exists for
// headlong_slack.state (slack/tests has no test_state.py). These cases
// exercise the port directly against the documented behavior in state.py:
// Deduper's bounded LRU-ish set, and ActiveThreads' persisted TTL map.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ACTIVE_THREAD_TTL_SECONDS, ActiveThreads, Deduper, PeerGuard } from "../src/slack/state.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sl-state-"));
}

describe("slack state", () => {
  describe("Deduper", () => {
    it("add returns true once per key, then false", () => {
      const d = new Deduper();
      expect(d.add("C1:1.1")).toBe(true);
      expect(d.add("C1:1.1")).toBe(false);
      expect(d.add("C1:1.2")).toBe(true);
    });

    it("evicts the oldest key once past max_size", () => {
      const d = new Deduper(3);
      d.add("a");
      d.add("b");
      d.add("c");
      d.add("d"); // evicts "a"
      expect(d.add("a")).toBe(true); // re-added, was evicted
      expect(d.add("d")).toBe(false); // still present
    });
  });

  describe("ActiveThreads", () => {
    it("touch then isActive round trip, persisted to disk", () => {
      const file = path.join(tmpDir(), "active_threads.json");
      const t = new ActiveThreads(file);
      expect(t.isActive("C1", "1.1")).toBe(false);
      t.touch("C1", "1.1");
      expect(t.isActive("C1", "1.1")).toBe(true);
      expect(fs.existsSync(file)).toBe(true);

      const reloaded = new ActiveThreads(file);
      expect(reloaded.isActive("C1", "1.1")).toBe(true);
    });

    it("touch/isActive with a null or undefined thread_ts is a no-op / false", () => {
      const t = new ActiveThreads(path.join(tmpDir(), "active_threads.json"));
      t.touch("C1", null);
      t.touch("C1", undefined);
      expect(t.isActive("C1", null)).toBe(false);
      expect(t.isActive("C1", undefined)).toBe(false);
    });

    it("expires entries past the TTL", () => {
      const file = path.join(tmpDir(), "active_threads.json");
      const now = 1_700_000_000;
      vi.setSystemTime(now * 1000);
      const t = new ActiveThreads(file);
      t.touch("C1", "1.1");
      expect(t.isActive("C1", "1.1")).toBe(true);

      vi.setSystemTime((now + ACTIVE_THREAD_TTL_SECONDS + 1) * 1000);
      expect(t.isActive("C1", "1.1")).toBe(false);
      vi.useRealTimers();
    });

    it("a corrupt on-disk file starts empty instead of throwing", () => {
      const file = path.join(tmpDir(), "active_threads.json");
      fs.writeFileSync(file, "not json");
      const t = new ActiveThreads(file);
      expect(t.isActive("C1", "1.1")).toBe(false);
    });
  });

  // ---- port of slack/tests/test_peers.py (guard section)
  describe("PeerGuard", () => {
    const CHAN = "C_CHAN";
    const PARENT = "111.222";

    it("allows max_turns then blocks until a person speaks", () => {
      const g = new PeerGuard(2, 100);
      expect(g.allow(CHAN, PARENT)).toEqual([true, ""]);
      expect(g.allow(CHAN, PARENT)).toEqual([true, ""]);
      const [ok, reason] = g.allow(CHAN, PARENT);
      expect(ok).toBe(false);
      expect(reason).toContain("2 peer messages in a row");
      // Repeat refusals are silent so the caller logs once per thread.
      expect(g.allow(CHAN, PARENT)).toEqual([false, ""]);
      // Another thread is unaffected.
      expect(g.allow(CHAN, "222.333")).toEqual([true, ""]);
      g.humanSpoke(CHAN, PARENT);
      expect(g.allow(CHAN, PARENT)[0]).toBe(true);
      // After the reset the next refusal is reported again.
      g.allow(CHAN, PARENT);
      expect(g.allow(CHAN, PARENT)[1]).toContain("in a row");
    });

    it("hourly cap across threads, window slides after an hour", () => {
      let now = 1_000_000;
      const g = new PeerGuard(100, 3, () => now);
      expect(g.allow(CHAN, "1")[0] && g.allow(CHAN, "2")[0] && g.allow(CHAN, "3")[0]).toBe(true);
      const [ok, reason] = g.allow(CHAN, "4");
      expect(ok).toBe(false);
      expect(reason).toContain("hourly cap of 3");
      now += 3601;
      expect(g.allow(CHAN, "4")[0]).toBe(true);
    });

    it("zero turns blocks every peer", () => {
      expect(new PeerGuard(0, 100).allow(CHAN, PARENT)[0]).toBe(false);
    });
  });
});
