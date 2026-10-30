// wakeLedger.ts — durable receipts for message/action wakes, and the persisted feeder cursor.
//
// PORT DIVERGENCE (lost-wake fix, branch experiment/lost-wakes; docs/LOSTWAKE.md). Upstream's dispatcher
// starts its feeders at end of file and drops `run/pending/` on stop, so a message that is stored in a
// trajectory while the dispatcher is down, or that is queued behind a busy thinker when it stops, never
// wakes anything. The sender still sees "Message sent". Delivered != consumed.
//
// Two small, additive pieces of state under `<identity>/run/`:
//
//   run/ledger/<thinker>.jsonl   append-only receipts, one JSON object per line, single writer (the dispatcher):
//       {"ev":"recv","id":<step_id>,"file":<traj file>,"step":{…the trigger step…}}   stored in the ledger and
//                                                                                    owed to the thinker
//       {"ev":"done","id":<step_id>[,"why":"…"]}                                      CONSUMED: the thinker's step
//                                                                                    for it exited 0 (or the
//                                                                                    trajectory already holds its
//                                                                                    answer, or the thinker is off)
//   run/cursor/<sha1(file)[0:16]>   {"file","ino","offset"} — the byte offset up to which complete lines of that
//                                    trajectory have been fed to the dispatcher AND ledgered.
//
// Ordering invariant that makes the pair crash-safe: a line is ledgered BEFORE the cursor passes it. A crash
// between the two re-feeds that line on the next start; the ledger recognises its id and does not owe it twice.
//
// Only FIFO-class types (message, action — the types upstream itself queues FIFO and never coalesces) are owed;
// every other step type keeps upstream's behaviour (a restart does not replay it).
//
// Shim-safe dialect: node builtins only.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const LEDGER_TYPES = new Set(["message", "action"]);
/** Consumed ids kept per thinker across a compaction: enough to dedupe a replay of the cursor gap. */
const KEEP_DONE = 2000;

export interface LedgerEntry {
  id: string;
  file: string;
  step: Record<string, unknown>;
}

export function ledgerDir(runDir: string): string {
  return path.join(runDir, "ledger");
}
export function cursorDir(runDir: string): string {
  return path.join(runDir, "cursor");
}

function appendLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

export class WakeLedger {
  private readonly dir: string;
  /** thinker -> unconsumed entries in arrival order */
  private readonly owed = new Map<string, Map<string, LedgerEntry>>();
  /** thinker -> every id seen (owed or consumed) within the retained window */
  private readonly seen = new Map<string, Set<string>>();

  constructor(runDir: string) {
    this.dir = ledgerDir(runDir);
  }

  private file(thinker: string): string {
    return path.join(this.dir, `${thinker}.jsonl`);
  }

  /** Fold every ledger file, then compact it (drops consumed pairs older than the retained window). */
  load(): void {
    this.owed.clear();
    this.seen.clear();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const n of names) {
      const thinker = n.slice(0, -".jsonl".length);
      const owed = new Map<string, LedgerEntry>();
      const seen = new Set<string>();
      const doneOrder: string[] = [];
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.dir, n), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // a torn last line from a kill -9 mid-append: the entry it described was never acknowledged
        }
        const id = typeof o["id"] === "string" ? (o["id"] as string) : "";
        if (!id) continue;
        if (o["ev"] === "recv") {
          if (!seen.has(id)) {
            owed.set(id, { id, file: String(o["file"] ?? ""), step: (o["step"] as Record<string, unknown>) ?? {} });
            seen.add(id);
          }
        } else if (o["ev"] === "done") {
          owed.delete(id);
          seen.add(id);
          doneOrder.push(id);
        }
      }
      this.owed.set(thinker, owed);
      this.seen.set(thinker, seen);
      // compaction: owed entries + the last KEEP_DONE consumed ids
      const keepDone = [...new Set(doneOrder)].slice(-KEEP_DONE);
      const lines: string[] = [];
      for (const e of owed.values()) lines.push(JSON.stringify({ ev: "recv", id: e.id, file: e.file, step: e.step }));
      for (const id of keepDone) lines.push(JSON.stringify({ ev: "done", id }));
      const tmp = `${this.file(thinker)}.tmp`;
      try {
        fs.writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
        fs.renameSync(tmp, this.file(thinker));
      } catch {
        /* compaction is best effort; the uncompacted file is still correct */
      }
      const keep = new Set<string>([...owed.keys(), ...keepDone]);
      this.seen.set(thinker, keep);
    }
  }

  /** Has this thinker already been owed (or already consumed) this step? */
  known(thinker: string, id: string): boolean {
    return this.seen.get(thinker)?.has(id) ?? false;
  }

  /** Is this step owed to the thinker right now (stored, not yet consumed)? */
  isOwed(thinker: string, id: string): boolean {
    return this.owed.get(thinker)?.has(id) ?? false;
  }

  /** Record that `step` is owed to `thinker`. Returns false (and writes nothing) when already known. */
  recv(thinker: string, id: string, file: string, step: Record<string, unknown>): boolean {
    if (this.known(thinker, id)) return false;
    appendLine(this.file(thinker), { ev: "recv", id, file, step });
    let o = this.owed.get(thinker);
    if (!o) this.owed.set(thinker, (o = new Map()));
    o.set(id, { id, file, step });
    let s = this.seen.get(thinker);
    if (!s) this.seen.set(thinker, (s = new Set()));
    s.add(id);
    return true;
  }

  /** The CONSUMED receipt. */
  done(thinker: string, id: string, why?: string): void {
    const o = this.owed.get(thinker);
    if (!o?.has(id)) return;
    appendLine(this.file(thinker), why ? { ev: "done", id, why } : { ev: "done", id });
    o.delete(id);
  }

  /** Steps owed to `thinker`, in arrival order. */
  unconsumed(thinker: string): LedgerEntry[] {
    return [...(this.owed.get(thinker)?.values() ?? [])];
  }

  /** Every thinker with at least one owed step. */
  owedThinkers(): string[] {
    return [...this.owed.entries()].filter(([, m]) => m.size > 0).map(([n]) => n);
  }

  owedCount(): number {
    let n = 0;
    for (const m of this.owed.values()) n += m.size;
    return n;
  }
}

// ---------------------------------------------------------------------------
// the feeder cursor
// ---------------------------------------------------------------------------

export interface FeederCursor {
  file: string;
  ino: number;
  offset: number;
}

function cursorPath(runDir: string, file: string): string {
  return path.join(cursorDir(runDir), createHash("sha1").update(file).digest("hex").slice(0, 16));
}

export function readCursor(runDir: string, file: string): FeederCursor | null {
  try {
    const o = JSON.parse(fs.readFileSync(cursorPath(runDir, file), "utf8")) as Partial<FeederCursor>;
    if (o.file === file && Number.isInteger(o.ino) && Number.isInteger(o.offset) && (o.offset as number) >= 0) {
      return { file, ino: o.ino as number, offset: o.offset as number };
    }
  } catch {
    /* absent or corrupt: treated as no cursor */
  }
  return null;
}

export function writeCursor(runDir: string, c: FeederCursor): void {
  const p = cursorPath(runDir, c.file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, p);
}

/**
 * Evidence that a thinker already answered `id`: a step in the trajectory with `trigger_step == id` whose source is
 * the thinker. Reads at most the last `maxBytes` of the file (an owed step is recent by construction).
 */
export function answeredIds(file: string, thinker: string, ids: Set<string>, maxBytes = 16 * 1024 * 1024): Set<string> {
  const out = new Set<string>();
  if (ids.size === 0) return out;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    for (const line of text.split("\n")) {
      if (!line.includes('"trigger_step"')) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const t = String(o["trigger_step"] ?? "");
        if (o["source"] === thinker && ids.has(t) && o["type"] !== "reply_claim") out.add(t);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* unreadable: no evidence */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return out;
}
