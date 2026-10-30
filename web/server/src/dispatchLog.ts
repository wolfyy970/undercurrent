// Parse an identity's dispatcher.log into structured events for the
// Thinkers "dispatch" debug view. Port of headlong_web/logs.py's
// DISPATCH_STEP_RE / DISPATCH_FIRE_RE / _tail_lines / parse_dispatch_log
// (Apache-2.0).

import { openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { join } from "node:path";

// `\[dispatcher\]\s+step:\s+type=(?P<type>\S+)(?:\s+source=(?P<source>\S+))?`
const DISPATCH_STEP_RE = /\[dispatcher\]\s+step:\s+type=(?<type>\S+)(?:\s+source=(?<source>\S+))?/;
// `\[dispatcher\]\s+dispatch\s+->\s+(?P<thinker>\S+)(?:\s+\(active=(?P<active>\d+)\))?`
// NOTE (faithful to upstream): this only matches the literal "dispatch ->"
// text — daemon.ts's "fire pending -> …" and "pending -> …" sub-events do
// NOT match (no "dispatch" token before "->") and fall through to "other",
// same as they would against the real Bash-shaped log upstream was written
// against.
const DISPATCH_FIRE_RE = /\[dispatcher\]\s+dispatch\s+->\s+(?<thinker>\S+)(?:\s+\(active=(?<active>\d+)\))?/;

export interface DispatchEvent {
  kind: "step" | "dispatch" | "other";
  type?: string;
  source?: string | null;
  thinker?: string;
  active?: number | null;
  raw: string;
}

function isBlankByte(b: number): boolean {
  // ASCII whitespace Python's bytes.strip() removes, minus \n (already the
  // split delimiter): space, tab, CR, FF, VT.
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0c || b === 0x0b;
}

function bufIsBlank(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (!isBlankByte(buf[i])) return false;
  }
  return true;
}

function splitOnNewline(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(buf.subarray(start));
  return out;
}

/**
 * The newest maxLines non-blank lines, read backward from the end.
 *
 * dispatcher.log is never rotated and the endpoint above this is polled every
 * couple of seconds, so the whole-file read this replaces would cost real
 * time and memory on a huge log to return the same maxEvents events. Port of
 * headlong_web/logs.py's `_tail_lines`: counts lines rather than bytes,
 * because the caller's cap is in events.
 *
 * maxBytes is the hard ceiling on the read: a log whose tail never reaches
 * maxLines non-blank lines (a few enormous lines, say) must not be scanned
 * end to end at poll cadence. Past it, whatever whole lines are in hand are
 * the answer.
 *
 * The stop condition counts complete lines only, kept as a running count per
 * chunk: the fragment before the accumulated data's first newline is judged
 * once more of the file arrives (or the loop reaches the file's start), never
 * counted early — an early count would be dropped by the partial-line trim
 * below and could return fewer lines than the file holds.
 *
 * chunkBytes/maxBytes are exposed (matching the Python signature) so tests
 * can force multi-chunk backward reads deterministically without needing a
 * multi-megabyte fixture.
 */
export function tailLines(
  logPath: string,
  maxLines: number,
  chunkBytes = 1 << 16,
  maxBytes = 8 << 20,
): string[] {
  if (maxLines <= 0) return [];
  const fd = openSync(logPath, "r");
  let text: string;
  let pos: number;
  try {
    const total = fstatSync(fd).size;
    const parts: Buffer[] = []; // chunks as read, i.e. reversed file order
    pos = total;
    let count = 0;
    let totalRead = 0;
    let fragNonblank = false; // the pending fragment: the data's first line so far
    let atEofChunk = true;
    while (pos > 0) {
      const step = Math.min(chunkBytes, pos);
      pos -= step;
      const buf = Buffer.alloc(step);
      readSync(fd, buf, 0, step, pos);
      parts.push(buf);
      totalRead += step;
      const segs = splitOnNewline(buf);
      if (atEofChunk) {
        // The chunk holding the file's end: everything after its first
        // newline is complete lines (the file's own last line included,
        // trailing newline or not).
        let c = 0;
        for (let i = 1; i < segs.length; i++) if (!bufIsBlank(segs[i])) c++;
        count += c;
        fragNonblank = !bufIsBlank(segs[0]);
        atEofChunk = false;
      } else if (segs.length === 1) {
        // No newline: the chunk only extends the pending fragment.
        fragNonblank = fragNonblank || !bufIsBlank(segs[0]);
      } else {
        // The last segment completes the pending fragment; the middle
        // segments are whole lines of their own.
        const last = segs[segs.length - 1];
        if (fragNonblank || !bufIsBlank(last)) count += 1;
        let c = 0;
        for (let i = 1; i < segs.length - 1; i++) if (!bufIsBlank(segs[i])) c++;
        count += c;
        fragNonblank = !bufIsBlank(segs[0]);
      }
      if (count >= maxLines || totalRead >= maxBytes) break;
    }
    parts.reverse();
    text = Buffer.concat(parts).toString("utf-8");
  } finally {
    closeSync(fd);
  }
  let lines = text.split("\n");
  if (pos > 0 && lines.length > 0) {
    lines = lines.slice(1); // drop the (likely partial) first line
  }
  const nonBlank = lines.filter((l) => l.trim() !== "");
  return nonBlank.slice(-maxLines);
}

/**
 * Parse dispatcher.log into structured events (newest last).
 *
 * Only the tail is read: maxEvents bounds the work, not just the answer.
 */
export function parseDispatchLog(identityDir: string, maxEvents = 2000): DispatchEvent[] {
  const logPath = join(identityDir, "run", "logs", "dispatcher.log");
  let isFile = false;
  try {
    isFile = statSync(logPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return [];

  const events: DispatchEvent[] = [];
  for (const line of tailLines(logPath, maxEvents)) {
    const stripped = line.trim();
    if (!stripped) continue;
    const stepMatch = DISPATCH_STEP_RE.exec(stripped);
    if (stepMatch) {
      events.push({
        kind: "step",
        type: stepMatch.groups!.type,
        source: stepMatch.groups!.source ?? null,
        raw: stripped,
      });
      continue;
    }
    const fireMatch = DISPATCH_FIRE_RE.exec(stripped);
    if (fireMatch) {
      const active = fireMatch.groups!.active;
      events.push({
        kind: "dispatch",
        thinker: fireMatch.groups!.thinker,
        active: active !== undefined ? Number(active) : null,
        raw: stripped,
      });
      continue;
    }
    events.push({ kind: "other", raw: stripped });
  }
  return events.slice(-maxEvents);
}
