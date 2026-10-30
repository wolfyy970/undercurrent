// allowlist.ts — the user-id allowlist and its pending-approval queue.
// Faithful port of headlong_telegram.allowlist (Python).
//
// Telegram bots are messageable by anyone on Earth, so the allowlist is the
// bridge's whole perimeter: unknown senders never reach the mind log, and
// outbound replies are only delivered to approved users' chats. Managed
// entirely over Telegram by the admin (/approve, /deny, /revoke, /list).
//
// Persisted as one JSON file in the bridge state dir. In production that dir
// is owned by the bridge's own system user — the agent's user must NOT be
// able to write it, or an injected agent could approve an attacker itself.

import * as fs from "node:fs";
import * as path from "node:path";

// Notify the admin about a given unknown sender at most this often, so a
// stranger can't flood the admin's DMs with approval prompts.
const PENDING_NOTIFY_INTERVAL_SECONDS = 24 * 3600;

interface PendingEntry {
  label: string;
  lastNotified: number; // seconds since epoch, matching Python's time.time()
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `time.time()` analogue: seconds since epoch, fractional. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** `Path.with_suffix(".tmp")`: replace the final extension, not append to it
 *  ("allowlist.json" -> "allowlist.tmp", not "allowlist.json.tmp"). */
function withTmpSuffix(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, `${stem}.tmp`);
}

export class Allowlist {
  private readonly filePath: string;
  private approved = new Map<string, string>(); // user id -> display label
  private denied = new Set<string>();
  private pending = new Map<string, PendingEntry>();

  constructor(filePath: string) {
    this.filePath = filePath;
    if (!isFile(filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const approvedObj = (data.approved ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(approvedObj)) this.approved.set(String(k), String(v));
      const deniedArr = (data.denied ?? []) as unknown[];
      for (const u of deniedArr) this.denied.add(String(u));
      const pendingObj = (data.pending ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(pendingObj)) {
        const entry = (v ?? {}) as Record<string, unknown>;
        this.pending.set(String(k), {
          label: String(entry.label ?? ""),
          lastNotified: Number(entry.last_notified ?? 0),
        });
      }
    } catch {
      // Corrupt file -> start empty, matching Python's broad
      // `except (ValueError, TypeError, AttributeError): pass`.
    }
  }

  isApproved(user: number): boolean {
    return this.approved.has(String(user));
  }

  approve(user: number, label = ""): void {
    const key = String(user);
    const finalLabel = label || this.pending.get(key)?.label || key;
    this.approved.set(key, finalLabel);
    this.pending.delete(key);
    this.denied.delete(key);
    this.save();
  }

  /** Silence a pending sender for good: drop with no further prompts. */
  deny(user: number): void {
    const key = String(user);
    this.denied.add(key);
    this.pending.delete(key);
    this.save();
  }

  revoke(user: number): boolean {
    const key = String(user);
    const removed = this.approved.delete(key);
    if (removed) this.save();
    return removed;
  }

  /** Record an unknown sender; true if the admin should be notified now. */
  notePending(user: number, label: string): boolean {
    const key = String(user);
    if (this.approved.has(key) || this.denied.has(key)) return false;
    const now = nowSeconds();
    const entry = this.pending.get(key);
    if (entry && now - entry.lastNotified < PENDING_NOTIFY_INTERVAL_SECONDS) return false;
    this.pending.set(key, { label, lastNotified: now });
    this.save();
    return true;
  }

  summary(): string {
    const lines = [`approved (${this.approved.size}):`];
    for (const uid of [...this.approved.keys()].sort()) {
      lines.push(`  ${uid}  ${this.approved.get(uid)}`);
    }
    if (this.pending.size > 0) {
      lines.push(`pending (${this.pending.size}):`);
      for (const uid of [...this.pending.keys()].sort()) {
        lines.push(`  ${uid}  ${this.pending.get(uid)!.label}`);
      }
    }
    if (this.denied.size > 0) {
      lines.push(`denied: ${[...this.denied].sort().join(", ")}`);
    }
    return lines.join("\n");
  }

  private save(): void {
    const data = {
      approved: Object.fromEntries(this.approved),
      denied: [...this.denied].sort(),
      pending: Object.fromEntries(
        [...this.pending].map(([k, v]) => [k, { label: v.label, last_notified: v.lastNotified }]),
      ),
    };
    const tmp = withTmpSuffix(this.filePath);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
