// feeder.ts — tail a trajectory.jsonl from its current end, in-process.
//
// Upstream's dispatcher runs `tail -n 0 -F <traj_file> | while read line …`
// per subscribed trajectory and pipes every new line into a FIFO
// (bin/thinkers:368-379). This is the same feeder without the processes:
//
//   • opens at the CURRENT end of file (`tail -n 0`) — nothing is replayed;
//   • fs.watch for low latency + poll() from the dispatcher's 1s tick as the
//     floor (fs.watch coalesces on macOS and can miss events; the tick cannot);
//   • reads [offset, size) as BYTES, splits on 0x0a, keeps the partial tail
//     until the writer finishes the line (upstream's `_read_buf` stitching);
//   • a file that changed inode or shrank under the feeder (replaced by `mv`, truncated) is NOT
//     replayed: the feeder restarts at the new end of file and reports it (2e39a3f, the swap
//     detector in bin/thinkers `_respawn_dead_feeders`). `tail -F` re-reads from byte 0 there,
//     which streamed a 1.5 GB history through the dispatcher on 2026-09-12;
//   • ENOENT → keep retrying on every poll (`tail -F` follows the NAME). A file that was never seen
//     is read from byte 0 when it first appears; one that comes back under a different inode is a swap.
//
// PORT-NOTE: replaces the `tail -F` + `dispatch.fifo` + `tail_pids` machinery
// (PARITY.md deviation). A step is emitted exactly once, as one complete line.

import * as fs from "node:fs";

export interface TrajFeederOptions {
  /** Called for every complete, non-empty line (without its newline). */
  onLine: (line: string) => void;
  /** Diagnostics sink (a read error, a re-opened watcher); optional. */
  onNote?: (note: string) => void;
  /** The file was replaced or truncated under the feeder; it has already restarted at end of file. */
  onSwap?: (e: { oldIno: number; newIno: number; oldSize: number; newSize: number }) => void;
  /**
   * Called at the end of every poll that advanced the offset, after every complete line it found has been handed
   * to `onLine`. `offset` is the byte position just past the last complete line delivered (the cursor to persist).
   */
  onAdvance?: (pos: { ino: number; offset: number }) => void;
}

const NL = 0x0a;

export class TrajFeeder {
  readonly file: string;
  private readonly onLine: (line: string) => void;
  private readonly onNote: (note: string) => void;
  private readonly onSwap: (e: { oldIno: number; newIno: number; oldSize: number; newSize: number }) => void;
  private readonly onAdvance: (pos: { ino: number; offset: number }) => void;
  private offset = 0;
  /** inode of the file the offset belongs to; null until one has been seen. */
  private ino: number | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private watcher: fs.FSWatcher | null = null;
  private closed = false;
  private polling = false;

  constructor(file: string, opts: TrajFeederOptions) {
    this.file = file;
    this.onLine = opts.onLine;
    this.onNote = opts.onNote ?? (() => {});
    this.onSwap = opts.onSwap ?? (() => {});
    this.onAdvance = opts.onAdvance ?? (() => {});
  }

  /**
   * Position at the current end of file (`tail -n 0`) and start watching. With `from` (a persisted cursor of the
   * SAME inode, not past the end of the file) the feeder resumes there instead, so lines appended while no
   * dispatcher was running are delivered rather than skipped (lost-wake fix; see wakeLedger.ts). A cursor for a
   * different inode, or beyond the end, is a replaced file: the usual end-of-file start applies.
   */
  start(from?: { ino: number; offset: number }): void {
    try {
      const st = fs.statSync(this.file);
      this.offset = from && from.ino === st.ino && from.offset <= st.size ? from.offset : st.size;
      this.ino = st.ino;
    } catch {
      this.offset = 0; // absent: the whole file is new once it appears
    }
    this.watch();
  }

  private watch(): void {
    if (this.closed || this.watcher) return;
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, (event) => {
        if (event === "rename") {
          // The path was replaced/removed — drop this watcher; the next poll
          // re-establishes one against whatever now lives at the path.
          this.unwatch();
        }
        this.poll();
      });
      this.watcher.on("error", () => {
        this.unwatch();
      });
    } catch {
      this.watcher = null; // ENOENT etc. — poll() retries
    }
  }

  private unwatch(): void {
    if (!this.watcher) return;
    try {
      this.watcher.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
  }

  /** Read whatever was appended since the last call and emit complete lines. */
  poll(): void {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      let size: number;
      let ino: number;
      try {
        const st = fs.statSync(this.file);
        size = st.size;
        ino = st.ino;
      } catch {
        // tail -F: file gone. Keep the remembered inode: if the name comes back under a different one
        // that is a swap (restart at its end); a file never seen before is read from 0 when it appears.
        if (this.ino === null) {
          this.offset = 0;
          this.partial = Buffer.alloc(0);
        }
        this.unwatch();
        return;
      }
      if (!this.watcher) this.watch();
      if (this.ino === null) {
        this.ino = ino; // first sight of a file that did not exist at start(): read it from 0
      } else if (ino !== this.ino || size < this.offset) {
        const e = { oldIno: this.ino, newIno: ino, oldSize: this.offset, newSize: size };
        this.ino = ino;
        this.offset = size;
        this.partial = Buffer.alloc(0);
        this.unwatch();
        this.watch();
        this.onNote(`replaced or truncated: ${this.file} (inode ${e.oldIno} -> ${e.newIno}, size ${e.oldSize} -> ${e.newSize})`);
        this.onSwap(e);
        return;
      }
      if (size === this.offset) return;

      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      let fd: number | undefined;
      let n = 0;
      try {
        fd = fs.openSync(this.file, "r");
        n = fs.readSync(fd, buf, 0, len, this.offset);
      } catch (e) {
        this.onNote(`read failed: ${this.file}: ${(e as Error).message}`);
        return;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      if (n <= 0) return;
      this.offset += n;

      let data = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at = 0;
      for (;;) {
        const nl = data.indexOf(NL, at);
        if (nl === -1) break;
        const line = data.subarray(at, nl).toString("utf8");
        at = nl + 1;
        if (line.length > 0) this.onLine(line);
      }
      this.partial = at < data.length ? Buffer.from(data.subarray(at)) : Buffer.alloc(0);
      data = Buffer.alloc(0);
      if (this.ino !== null) this.onAdvance({ ino: this.ino, offset: this.offset - this.partial.length });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Mark everything currently on disk as already delivered, without reading
   * or emitting any of it. For when the OWNER of this feeder (the daemon)
   * itself just appended a complete line to `file` and already delivered it
   * through a more direct path (Dispatcher's own salience-injection re-feed,
   * synchronous — see dispatcher.ts `appendRecord`) — this feeder's regular
   * poll/watch must not also emit it a second time.
   */
  resync(): void {
    try {
      this.offset = fs.statSync(this.file).size;
    } catch {
      /* file vanished between the write and this call — the next poll() handles it */
    }
  }

  /** The byte position just past the last complete line delivered, with the file's inode (null before one was seen). */
  position(): { ino: number; offset: number } | null {
    return this.ino === null ? null : { ino: this.ino, offset: this.offset - this.partial.length };
  }

  close(): void {
    this.closed = true;
    this.unwatch();
  }
}
