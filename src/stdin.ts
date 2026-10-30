// src/stdin.ts — shared synchronous "read all of fd 0" helper for the
// bin/*.mjs shims (mem, chat, skills, traj).
//
// Deliberately NOT fs.readFileSync(0): a pipe handed down by a Node parent
// (mem.mjs's spawnSync into `llm`, the parity harness, or any piped
// `node bin/foo.mjs < input`) can be non-blocking, and readFileSync then
// throws EAGAIN part-way through — discarding the bytes it had already read.
// A piped mem/chat payload is easily hundreds of KB, so the read would
// silently lose its head (a real run lost exactly 106,496 bytes of a 300 KB
// prompt). This loop keeps every byte and waits out EAGAIN instead of giving
// up on it. Mirrors the fix already shipped in bin/llm.mjs's readStdinSync.
//
// Every other error (closed stdin, EOF, EBADF, a TTY with nothing buffered,
// …) ends the read exactly the way a caught fs.readFileSync(0) always did in
// each shim: return whatever was read so far (empty, if nothing was read
// yet) instead of throwing. Callers therefore need no try/catch of their own.

import * as fs from "node:fs";

const EAGAIN_WAIT_MS = 5;

/** Read all of fd 0 (stdin) synchronously as raw bytes. Returns an empty
 *  Buffer on a closed/tty stdin or any other read error. */
export function readStdinBytesSync(): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EAGAIN_WAIT_MS);
        continue;
      }
      // EOF/EBADF/ENXIO/a TTY with no data/… — same as a caught
      // fs.readFileSync(0) in the shims this helper replaces.
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/** Read all of fd 0 (stdin) synchronously, decoded as utf8. Returns "" on a
 *  closed/tty stdin or any other read error. */
export function readStdinSync(): string {
  return readStdinBytesSync().toString("utf8");
}
