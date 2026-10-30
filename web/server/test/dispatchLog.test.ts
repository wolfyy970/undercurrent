// dispatchLog.test.ts — dispatcher.log parsing (headlong_web/logs.py port).
// Expectations are derived by reading logs.py's DISPATCH_STEP_RE /
// DISPATCH_FIRE_RE / _tail_lines / parse_dispatch_log directly (no python run
// available in this sandbox — see the task notes for what was checked).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchLog, tailLines, type DispatchEvent } from "../src/dispatchLog.ts";
import { handleGet, type RouterCtx } from "../src/router.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hl-dispatch-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeLog(identityDir: string, content: string): void {
  const logsDir = join(identityDir, "run", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "dispatcher.log"), content);
}

describe("parseDispatchLog — event shapes (real daemon.ts log line formats)", () => {
  it("missing dispatcher.log -> []", () => {
    const dir = tmpDir();
    expect(parseDispatchLog(dir)).toEqual([]);
  });

  it("a step: line -> kind 'step' with type + source", () => {
    const dir = tmpDir();
    writeLog(dir, "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat\n");
    expect(parseDispatchLog(dir)).toEqual([
      { kind: "step", type: "message", source: "chat", raw: "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat" },
    ]);
  });

  it("a 'dispatch -> ' line -> kind 'dispatch' with thinker + active", () => {
    const dir = tmpDir();
    writeLog(dir, "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder (active=1)\n");
    expect(parseDispatchLog(dir)).toEqual([
      { kind: "dispatch", thinker: "responder", active: 1, raw: "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder (active=1)" },
    ]);
  });

  it("a 'dispatch -> ' line with no (active=N) suffix -> active: null (regex's optional group)", () => {
    // Synthetic: daemon.ts always includes (active=N), but DISPATCH_FIRE_RE's
    // active group is optional in the source regex, so this must still
    // parse, with active null (not "0" or missing the event entirely).
    const dir = tmpDir();
    writeLog(dir, "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder\n");
    expect(parseDispatchLog(dir)).toEqual([
      { kind: "dispatch", thinker: "responder", active: null, raw: "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder" },
    ]);
  });

  it("'pending -> ' and 'fire pending -> ' lines are 'other' — DISPATCH_FIRE_RE requires the literal token 'dispatch' right after '[dispatcher]', which neither line has", () => {
    const dir = tmpDir();
    const l1 = "2026-09-02T02:24:25.743Z [dispatcher]   pending -> monolith (type=observation, coalesced)";
    const l2 = "2026-09-02T02:24:25.744Z [dispatcher]   fire pending -> responder (type=message, active=1)";
    writeLog(dir, l1 + "\n" + l2 + "\n");
    expect(parseDispatchLog(dir)).toEqual<DispatchEvent[]>([
      { kind: "other", raw: l1 },
      { kind: "other", raw: l2 },
    ]);
  });

  it("a 'skip' line is 'other'", () => {
    const dir = tmpDir();
    const l = "2026-09-02T02:24:25.745Z [dispatcher]   skip responder (self-trigger)";
    writeLog(dir, l + "\n");
    expect(parseDispatchLog(dir)).toEqual([{ kind: "other", raw: l }]);
  });

  it("blank lines are skipped entirely (no event emitted)", () => {
    const dir = tmpDir();
    const l1 = "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat";
    const l2 = "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder (active=0)";
    writeLog(dir, `${l1}\n\n   \n${l2}\n\n`);
    expect(parseDispatchLog(dir)).toEqual([
      { kind: "step", type: "message", source: "chat", raw: l1 },
      { kind: "dispatch", thinker: "responder", active: 0, raw: l2 },
    ]);
  });

  it("a full boot->queue->fire sequence (real daemon.ts shapes) parses as step/dispatch/other/other in order", () => {
    const dir = tmpDir();
    const lines = [
      "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat",
      "2026-09-02T02:24:25.742Z [dispatcher]   dispatch -> responder (active=1)",
      "2026-09-02T02:24:25.743Z [dispatcher]   pending -> monolith (type=observation, coalesced)",
      "2026-09-02T02:24:26.001Z [dispatcher] step: type=feedback source=dispatcher",
      "2026-09-02T02:24:26.002Z [dispatcher]   fire pending -> responder (type=message, active=1)",
    ];
    writeLog(dir, lines.join("\n") + "\n");
    expect(parseDispatchLog(dir).map((e) => e.kind)).toEqual(["step", "dispatch", "other", "step", "other"]);
    expect(parseDispatchLog(dir).map((e) => e.raw)).toEqual(lines);
  });

  it("more than max_events lines -> only the last max_events, newest last", () => {
    const dir = tmpDir();
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`2026-09-02T02:24:${String(25 + i).padStart(2, "0")}.000Z [dispatcher] step: type=m${i} source=chat`);
    }
    writeLog(dir, lines.join("\n") + "\n");
    const events = parseDispatchLog(dir, 4);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual(["m6", "m7", "m8", "m9"]);
  });
});

describe("tailLines — backward chunked tail read (headlong_web/logs.py _tail_lines port)", () => {
  it("small file under one chunk: returns the last N non-blank lines in order", () => {
    const dir = tmpDir();
    const p = join(dir, "x.log");
    writeFileSync(p, "a\nb\n\nc\nd\ne\n");
    expect(tailLines(p, 3)).toEqual(["c", "d", "e"]);
    expect(tailLines(p, 100)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("maxLines <= 0 -> []", () => {
    const dir = tmpDir();
    const p = join(dir, "x.log");
    writeFileSync(p, "a\nb\n");
    expect(tailLines(p, 0)).toEqual([]);
  });

  it("partial first line dropped when the tail starts mid-file: forced multi-chunk backward read matches ground truth exactly", () => {
    const dir = tmpDir();
    const p = join(dir, "big.log");
    // Fixed-width lines (15 chars) whose length shares no common factor with
    // the chunk size (13) below, so a backward chunk boundary essentially
    // never lands on a line boundary — the "(likely partial) first line"
    // drop is exercised on real garbled fragments, not just empty strings.
    const n = 500;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(`line-${String(i).padStart(10, "0")}`); // 15 chars
    const content = lines.join("\n") + "\n";
    writeFileSync(p, content);

    for (const maxLines of [1, 2, 5, 17, 200]) {
      const expected = lines.slice(-maxLines);
      const got = tailLines(p, maxLines, 13);
      expect(got).toEqual(expected);
    }
  });

  it("maxBytes ceiling: stops before maxLines is reached if the read would exceed maxBytes", () => {
    const dir = tmpDir();
    const p = join(dir, "big.log");
    const n = 200;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(`line-${String(i).padStart(10, "0")}`); // 15 bytes + \n
    writeFileSync(p, lines.join("\n") + "\n");
    // Ask for far more lines than exist, but cap the read at a small byte
    // budget: the result must be a SUFFIX of the file (whatever fit), never
    // more lines than the byte budget could possibly contain, and never
    // crash trying to read past the file start improperly.
    const got = tailLines(p, 1000, 16, 100);
    expect(got.length).toBeLessThan(n);
    expect(got.length).toBeGreaterThan(0);
    expect(lines.slice(-got.length)).toEqual(got);
  });

  it("missing file throws (caller — parseDispatchLog — checks existence first)", () => {
    const dir = tmpDir();
    expect(() => tailLines(join(dir, "nope.log"), 5)).toThrow();
  });
});

describe("router wiring — GET /api/identities/:id/dispatch", () => {
  function ctxFor(root: string): RouterCtx {
    return { root, controlsEnabled: false };
  }

  it("returns real parsed events, not an empty stub", () => {
    const root = tmpDir();
    const idDir = join(root, "pax");
    mkdirSync(idDir, { recursive: true });
    writeFileSync(join(idDir, "info.txt"), "name=pax\nroot_trajectory=trajectory.jsonl\n");
    writeLog(idDir, "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat\n");

    const res = handleGet(ctxFor(root), ["identities", "pax", "dispatch"], new URLSearchParams());
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual([
      { kind: "step", type: "message", source: "chat", raw: "2026-09-02T02:24:25.741Z [dispatcher] step: type=message source=chat" },
    ]);
  });

  it("no dispatcher.log on disk -> []", () => {
    const root = tmpDir();
    const idDir = join(root, "pax");
    mkdirSync(idDir, { recursive: true });
    writeFileSync(join(idDir, "info.txt"), "name=pax\nroot_trajectory=trajectory.jsonl\n");

    const res = handleGet(ctxFor(root), ["identities", "pax", "dispatch"], new URLSearchParams());
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual([]);
  });
});
