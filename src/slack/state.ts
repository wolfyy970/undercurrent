// state.ts — small bits of bridge state: event dedupe and the active-thread set.
// Faithful port of headlong_slack.state (Python).

import * as fs from "node:fs";
import * as path from "node:path";

export const ACTIVE_THREAD_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Bounded set of recently seen event keys.
 *
 * A channel mention arrives as both app_mention and message.channels, and
 * Socket Mode redelivers envelopes that are not acked in time.
 *
 * PORT-NOTE: Python's Deduper is thread-safe (a `threading.Lock`) because the
 * Bolt handler thread and the drain thread could both touch it. Node is
 * single-threaded, so no lock is needed; `add()` stays synchronous.
 */
export class Deduper {
  private readonly seen = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
  }

  /** Record key; returns false if it was already seen. */
  add(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

/**
 * Threads the bot participates in, so un-mentioned follow-ups reach it.
 *
 * Persisted as JSON ({"channel:thread_ts": last_touched_epoch}) so a bridge
 * restart does not orphan ongoing conversations. Entries expire after
 * ACTIVE_THREAD_TTL_SECONDS.
 */
export class ActiveThreads {
  private readonly filePath: string;
  private threads: Record<string, number> = {};

  constructor(filePath: string) {
    this.filePath = filePath;
    let isFile = false;
    try {
      isFile = fs.statSync(filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          const n = Number(v);
          if (!Number.isNaN(n)) out[k] = n;
        }
        this.threads = out;
      }
    } catch {
      // Corrupt file -> start empty, matching Python's `except (ValueError,
      // TypeError): pass`.
    }
  }

  private static key(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  touch(channel: string, threadTs: string | null | undefined): void {
    if (!threadTs) return;
    this.prune();
    this.threads[ActiveThreads.key(channel, threadTs)] = Date.now() / 1000;
    this.save();
  }

  isActive(channel: string, threadTs: string | null | undefined): boolean {
    if (!threadTs) return false;
    this.prune();
    return ActiveThreads.key(channel, threadTs) in this.threads;
  }

  private prune(): void {
    const cutoff = Date.now() / 1000 - ACTIVE_THREAD_TTL_SECONDS;
    for (const [k, v] of Object.entries(this.threads)) {
      if (v < cutoff) delete this.threads[k];
    }
  }

  private save(): void {
    const tmp = withTmpSuffix(this.filePath);
    fs.writeFileSync(tmp, JSON.stringify(this.threads));
    fs.renameSync(tmp, this.filePath);
  }
}

/** `Path.with_suffix(".tmp")`: replace the final extension, not append to it
 *  ("active_threads.json" -> "active_threads.tmp", not
 *  "active_threads.json.tmp"). Same helper as telegram's allowlist.ts. */
function withTmpSuffix(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, `${stem}.tmp`);
}

/**
 * Bounds bot-to-bot traffic so two personas cannot talk forever.
 *
 * Two Headlong personas in one thread each answer every message the other
 * posts. Without a bound that is an infinite loop billed to two LLM keys. Two
 * limits, both counted on the messages this bridge forwards from peers:
 *
 * - per thread, at most `maxTurns` peer messages in a row with no person
 *   speaking in the thread; a human message resets the count.
 * - per hour, at most `hourlyCap` peer messages across all threads.
 *
 * In-memory only: a bridge restart resets the counts, and the hourly cap
 * bounds what a restart loop could let through.
 *
 * PORT-NOTE: no lock (Node is single-threaded; Python's threading.Lock guards
 * the Bolt handler threads). `now` is injectable for tests.
 */
export class PeerGuard {
  readonly maxTurns: number;
  readonly hourlyCap: number;
  private readonly runs = new Map<string, number>();
  private recent: number[] = [];
  private readonly blocked = new Set<string>();
  private readonly now: () => number;

  constructor(maxTurns: number, hourlyCap: number, now: () => number = () => Date.now() / 1000) {
    this.maxTurns = maxTurns;
    this.hourlyCap = hourlyCap;
    this.now = now;
  }

  private static key(channel: string, threadTs: string | null | undefined): string {
    return `${channel}:${threadTs || ""}`;
  }

  /** A person posted in this thread: peers may take turns again. */
  humanSpoke(channel: string, threadTs: string | null | undefined): void {
    const key = PeerGuard.key(channel, threadTs);
    this.runs.delete(key);
    this.blocked.delete(key);
  }

  /**
   * Record one forwarded peer message, or refuse it with a reason.
   *
   * The reason is empty when allowed, and empty on a repeat refusal for the
   * same thread so the caller logs each block once.
   */
  allow(channel: string, threadTs: string | null | undefined): [boolean, string] {
    const key = PeerGuard.key(channel, threadTs);
    const now = this.now();
    while (this.recent.length > 0 && this.recent[0]! < now - 3600) this.recent.shift();
    let reason = "";
    if (this.recent.length >= this.hourlyCap) {
      reason = `hourly cap of ${this.hourlyCap} peer messages reached`;
    } else if ((this.runs.get(key) ?? 0) >= this.maxTurns) {
      reason =
        `${this.maxTurns} peer messages in a row without a person; ` +
        "waiting for someone to speak in the thread";
    }
    if (reason) {
      const first = !this.blocked.has(key);
      this.blocked.add(key);
      return [false, first ? reason : ""];
    }
    this.runs.set(key, (this.runs.get(key) ?? 0) + 1);
    this.recent.push(now);
    return [true, ""];
  }
}
