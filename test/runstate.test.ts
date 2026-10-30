// runstate.test.ts — the run/ contract's exact bytes, atomicity, pending
// parse/firing order, and FIFO cap (PLAN-daemon §4, §8).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writePid,
  readPid,
  removePid,
  livePid,
  newToken,
  writeToken,
  readToken,
  writeAtomic,
  addActive,
  readActive,
  writeActive,
  removeActive,
  appendStepPid,
  readStepPids,
  writeStepPids,
  truncateStepPids,
  liveStepPids,
  writeWakeAt,
  readWakeAt,
  removeWakeAt,
  writeSubMap,
  readSubMap,
  writeTrajFiles,
  readTrajFiles,
  touchDeliberateStop,
  deliberateStopAgeS,
  writeLastSignal,
  readLastSignal,
  fbInjectedAdd,
  fbInjectedHas,
  parsePendingName,
  manualTriggerJson,
  pidAlive,
  killTree,
  FilePendingStore,
  MAX_FIFO,
} from "../src/runstate.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmpRunDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-runstate-"));
  roots.push(root);
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

describe("dispatcher.pid — exact bytes, no trailing newline", () => {
  it("round-trips and detects liveness", () => {
    const runDir = tmpRunDir();
    writePid(runDir, process.pid);
    expect(fs.readFileSync(path.join(runDir, "dispatcher.pid"), "utf8")).toBe(String(process.pid));
    expect(readPid(runDir)).toBe(process.pid);
    expect(livePid(runDir)).toBe(process.pid);
    removePid(runDir);
    expect(readPid(runDir)).toBeNull();
  });

  it("a dead pid is not livePid", () => {
    const runDir = tmpRunDir();
    // A pid essentially guaranteed not to exist.
    writePid(runDir, 2 ** 30);
    expect(livePid(runDir)).toBeNull();
  });

  it("writePid is atomic (no .tmp leftover, no partial reads under a stat race)", () => {
    const runDir = tmpRunDir();
    writePid(runDir, 4242);
    expect(fs.existsSync(path.join(runDir, "dispatcher.pid.tmp"))).toBe(false);
  });
});

describe("dispatcher.token", () => {
  it("newToken is 16 random bytes as 32 hex chars, fresh each call (2e39a3f)", () => {
    const toks = new Set(Array.from({ length: 50 }, () => newToken()));
    expect(toks.size).toBe(50);
    for (const t of toks) expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it("round-trips with no trailing newline", () => {
    const runDir = tmpRunDir();
    writeToken(runDir, "111.222.333");
    expect(fs.readFileSync(path.join(runDir, "dispatcher.token"), "utf8")).toBe("111.222.333");
    expect(readToken(runDir)).toBe("111.222.333");
  });
});

describe("active_thinkers — one name per line, dedup add, atomic remove", () => {
  it("addActive dedupes; writeActive rewrites the whole list", () => {
    const runDir = tmpRunDir();
    addActive(runDir, "monolith");
    addActive(runDir, "monolith"); // no dupe
    addActive(runDir, "responder");
    expect(readActive(runDir)).toEqual(["monolith", "responder"]);
    expect(fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8")).toBe("monolith\nresponder\n");

    writeActive(runDir, ["a", "b", "c"]);
    expect(readActive(runDir)).toEqual(["a", "b", "c"]);
  });

  it("removeActive filters via tmp+rename, no .tmp leftover", () => {
    const runDir = tmpRunDir();
    writeActive(runDir, ["a", "b", "c"]);
    removeActive(runDir, "b");
    expect(readActive(runDir)).toEqual(["a", "c"]);
    expect(fs.existsSync(path.join(runDir, "active_thinkers.tmp"))).toBe(false);
  });
});

describe("step_pids — SPACE separated \"<pid> <name>\\n\" (F2)", () => {
  it("appendStepPid writes the exact byte format", () => {
    const runDir = tmpRunDir();
    appendStepPid(runDir, 555, "monolith");
    expect(fs.readFileSync(path.join(runDir, "step_pids"), "utf8")).toBe("555 monolith\n");
  });

  it("readStepPids parses pid (first field) and name (rest)", () => {
    const runDir = tmpRunDir();
    appendStepPid(runDir, 1, "a");
    appendStepPid(runDir, 2, "b");
    expect(readStepPids(runDir)).toEqual([
      { pid: 1, name: "a" },
      { pid: 2, name: "b" },
    ]);
  });

  it("writeStepPids/truncateStepPids are atomic tmp+rename", () => {
    const runDir = tmpRunDir();
    writeStepPids(runDir, [{ pid: 9, name: "x" }]);
    expect(fs.readFileSync(path.join(runDir, "step_pids"), "utf8")).toBe("9 x\n");
    truncateStepPids(runDir);
    expect(fs.readFileSync(path.join(runDir, "step_pids"), "utf8")).toBe("");
    expect(fs.existsSync(path.join(runDir, "step_pids.tmp"))).toBe(false);
  });

  it("liveStepPids filters to alive pids only", () => {
    const runDir = tmpRunDir();
    writeStepPids(runDir, [
      { pid: process.pid, name: "alive" },
      { pid: 2 ** 30, name: "dead" },
    ]);
    expect(liveStepPids(runDir).map((e) => e.name)).toEqual(["alive"]);
  });
});

describe("<name>.wake_at — exact epoch, no newline", () => {
  it("round-trips and reports invalid/absent", () => {
    const runDir = tmpRunDir();
    expect(readWakeAt(runDir, "monolith")).toEqual({ kind: "absent" });
    writeWakeAt(runDir, "monolith", 1_700_000_000);
    expect(fs.readFileSync(path.join(runDir, "monolith.wake_at"), "utf8")).toBe("1700000000");
    expect(readWakeAt(runDir, "monolith")).toEqual({ kind: "due", epoch: 1_700_000_000 });
    fs.writeFileSync(path.join(runDir, "bad.wake_at"), "not-a-number");
    expect(readWakeAt(runDir, "bad")).toEqual({ kind: "invalid" });
    removeWakeAt(runDir, "monolith");
    expect(readWakeAt(runDir, "monolith")).toEqual({ kind: "absent" });
  });
});

describe("sub_map — TAB-separated, pipe-joined types", () => {
  it("round-trips", () => {
    const runDir = tmpRunDir();
    writeSubMap(runDir, [
      { name: "monolith", trajFile: "/x/traj.jsonl", types: ["observation", "action"], triggerSelf: false, watchdog: 0 },
    ]);
    const raw = fs.readFileSync(path.join(runDir, "sub_map"), "utf8");
    expect(raw).toBe("monolith\t/x/traj.jsonl\tobservation|action\tfalse\t0\n");
    expect(readSubMap(runDir)).toEqual([
      { name: "monolith", trajFile: "/x/traj.jsonl", types: ["observation", "action"], triggerSelf: false, watchdog: 0 },
    ]);
  });
});

describe("traj_files — one absolute path per line", () => {
  it("round-trips", () => {
    const runDir = tmpRunDir();
    writeTrajFiles(runDir, ["/a/traj.jsonl", "/b/traj.jsonl"]);
    expect(fs.readFileSync(path.join(runDir, "traj_files"), "utf8")).toBe("/a/traj.jsonl\n/b/traj.jsonl\n");
    expect(readTrajFiles(runDir)).toEqual(["/a/traj.jsonl", "/b/traj.jsonl"]);
  });
});

describe("deliberate_stop / last_signal / fb_injected", () => {
  it("deliberate_stop age is derived from mtime", () => {
    const runDir = tmpRunDir();
    expect(deliberateStopAgeS(runDir)).toBeNull();
    touchDeliberateStop(runDir);
    const age = deliberateStopAgeS(runDir);
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(2);
  });

  it("last_signal is SIG<NAME>\\n", () => {
    const runDir = tmpRunDir();
    writeLastSignal(runDir, "SIGTERM");
    expect(fs.readFileSync(path.join(runDir, "last_signal"), "utf8")).toBe("SIGTERM\n");
    expect(readLastSignal(runDir)).toBe("SIGTERM\n");
  });

  it("fb_injected dedups by step_id line", () => {
    const runDir = tmpRunDir();
    expect(fbInjectedHas(runDir, "s1")).toBe(false);
    fbInjectedAdd(runDir, "s1");
    expect(fbInjectedHas(runDir, "s1")).toBe(true);
    expect(fs.readFileSync(path.join(runDir, "fb_injected"), "utf8")).toBe("s1\n");
  });
});

describe("pending/ naming — parse from the left", () => {
  it("parsePendingName splits <name>.<type>.<rest>", () => {
    expect(parsePendingName("monolith.observation.1700000000.000001")).toEqual({
      name: "monolith",
      type: "observation",
      rest: "1700000000.000001",
    });
    expect(parsePendingName("responder.message.coalesced")).toEqual({
      name: "responder",
      type: "message",
      rest: "coalesced",
    });
    expect(parsePendingName("noext")).toBeUndefined();
  });

  it("manualTriggerJson carries NO content (bootTrigger fidelity)", () => {
    const j = JSON.parse(manualTriggerJson(new Date("2026-08-28T16:00:00Z"))) as Record<string, unknown>;
    expect(j).toEqual({ type: "manual-trigger", source: "thinkers-cli", ts: "2026-08-28T16:00:00+0000" });
  });
});

describe("FilePendingStore", () => {
  it("FIFO cap is 16, drop-oldest, in-order take", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    for (let i = 0; i < 20; i++) {
      store.push("resp", "message", { type: "message", content: `m${i}` }, "fifo");
    }
    expect(store.count("resp")).toBe(MAX_FIFO);
    const order = store.list().map((e) => store.take(e.key)?.["content"]);
    expect(order).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16", "m17", "m18", "m19"]);
  });

  it("coalesce is last-wins and reports superseded", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    const r1 = store.push("monolith", "observation", { type: "observation", content: "o1" }, "coalesce");
    expect(r1).toEqual({ kind: "coalesce", superseded: false });
    const r2 = store.push("monolith", "observation", { type: "observation", content: "o2" }, "coalesce");
    expect(r2).toEqual({ kind: "coalesce", superseded: true });
    expect(store.count("monolith")).toBe(1);
    const entries = store.list();
    expect(entries.length).toBe(1);
    expect(store.take(entries[0]!.key)?.["content"]).toBe("o2");
  });

  it("firing order: message class, then action class, then the rest", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    store.push("a", "observation", { type: "observation" }, "coalesce");
    store.push("b", "action", { type: "action" }, "fifo");
    store.push("c", "message", { type: "message" }, "fifo");
    const order = store.list().map((e) => e.type);
    expect(order).toEqual(["message", "action", "observation"]);
  });

  it("clear(name) drops every entry for that thinker only", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    store.push("a", "message", { type: "message" }, "fifo");
    store.push("b", "message", { type: "message" }, "fifo");
    store.clear("a");
    expect(store.count("a")).toBe(0);
    expect(store.count("b")).toBe(1);
  });

  it("take() on a missing/already-taken key returns undefined; remove() is idempotent", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    expect(store.take("nope")).toBeUndefined();
    store.push("a", "message", { type: "message" }, "fifo");
    const [entry] = store.list();
    store.remove(entry!.key);
    expect(store.take(entry!.key)).toBeUndefined();
    expect(() => store.remove(entry!.key)).not.toThrow();
  });

  it("hasAny() is false when empty, true once something is queued", () => {
    const runDir = tmpRunDir();
    const store = new FilePendingStore(path.join(runDir, "pending"));
    expect(store.hasAny()).toBe(false);
    store.push("a", "message", { type: "message" }, "fifo");
    expect(store.hasAny()).toBe(true);
  });

  it("a malformed pending file is skipped by take(), not thrown", () => {
    const runDir = tmpRunDir();
    const pendingDir = path.join(runDir, "pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, "a.message.1700000000.000001"), "{not json");
    const store = new FilePendingStore(pendingDir);
    const [entry] = store.list();
    expect(store.take(entry!.key)).toBeUndefined();
  });
});

describe("pidAlive / killTree", () => {
  it("pidAlive is true for our own process, false for an implausible pid", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });

  it("killTree on a nonexistent pid is a silent no-op", () => {
    expect(() => killTree(2 ** 30, "SIGTERM")).not.toThrow();
  });

  it("killTree signals a real leaf child process", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(child.pid!)).toBe(true);
    killTree(child.pid!, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(pidAlive(child.pid!)).toBe(false);
  });
});

describe("writeAtomic", () => {
  it("never leaves a .tmp file and writes exact bytes", () => {
    const runDir = tmpRunDir();
    const file = path.join(runDir, "x");
    writeAtomic(file, "exact-bytes-no-newline");
    expect(fs.readFileSync(file, "utf8")).toBe("exact-bytes-no-newline");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
