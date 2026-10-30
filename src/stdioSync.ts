// src/stdioSync.ts — under Bun, process.stdout/stderr writes go straight to the file descriptor (synchronously), so no
// bin/* tool can lose output when it exits. Imported for its side effect, FIRST, by every bin/*.mjs entry point (and by
// src/exitAfterDrain.ts).
//
// PORT-NOTE (fix, found 2026-10-29 by the recap adversarial parity run under CPU load): the bin/* shims run on Bun when
// Bun is installed (`exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}"`). Bun queues a pipe write it
// cannot finish at once and process.exit() drops the queue; the `write("", cb)` drain probe, writableLength and "drain"
// do not see it (writableLength reads 0). A 200 KB write to a slow reader kept 65,295 bytes, and under load a 1.8 KB
// `llm` reply was cut mid-text with exit 0 (recap then reported invalid JSON and retried). Upstream's tools are Bash
// and write with printf, which blocks until the bytes are in the pipe; a synchronous fs.writeSync does the same. Node
// is left alone (its pipe writes are synchronous on Linux, and exitAfterDrain's probe covers macOS).
import * as fs from "node:fs";

type WriteCb = (err?: Error | null) => void;

function writeAllSync(fd: number, buf: Uint8Array): void {
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      // A non-blocking descriptor with a full pipe: wait for the reader, as a blocking write would.
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

function makeSync(stream: NodeJS.WriteStream, fd: number): void {
  const write = (chunk: unknown, encoding?: BufferEncoding | WriteCb, cb?: WriteCb): boolean => {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? "utf8")
        : chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(String(chunk));
    try {
      writeAllSync(fd, buf);
    } catch (e) {
      // EPIPE and friends surface as the stream's "error" event, as an async write's would (bin/llm exits 141 on
      // EPIPE; exitAfterDrain's listener swallows it).
      process.nextTick(() => stream.emit("error", e));
      if (cb) process.nextTick(cb, e as Error);
      return false;
    }
    if (cb) process.nextTick(cb, null);
    return true;
  };
  (stream as unknown as { write: typeof write }).write = write;
}

export const STDIO_SYNC = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
if (STDIO_SYNC) {
  makeSync(process.stdout, 1);
  makeSync(process.stderr, 2);
}
