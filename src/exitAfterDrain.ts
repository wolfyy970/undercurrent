// src/exitAfterDrain.ts — shared "drain stdout/stderr, then exit" helper for
// the bin/*.mjs shims (chat, context, identity, mem, recap, retrieval-step,
// skills, thinker-step, traj).
//
// PORT-NOTE (bug #40): on macOS (and any platform where stdout/stderr is a
// pipe, not a TTY), process.stdout/stderr writes are ASYNCHRONOUS with a
// small OS pipe buffer (65,536 bytes observed). write() returns false once
// that buffer fills and queues the remainder to flush on a future tick — but
// a bare `process.exit(code)` right after tears the process down
// immediately, before the queued remainder is ever flushed, silently
// truncating any output past the buffer boundary (e.g. `mem` on a file over
// ~64 KiB piped to another process). `bin/llm.mjs` already carried the fix
// for exactly this; this helper generalizes that pattern so every entry
// point gets it. Exit codes are unchanged — this only delays the exit until
// both streams have drained.
//
// PORT-NOTE (1c: bug #52): ANY write to stdout/stderr — not just the trailing
// drain probe below — can hit EPIPE when the stream is a pipe whose reader
// has already closed its read end. That is an entirely ordinary shape, e.g.
// `chat history --with X | grep -q pattern`, where `grep -q` stops reading
// as soon as it has a match. A stream with no registered "error" listener
// treats a failed write as an UNHANDLED error event and crashes the process
// (uncaught exception, non-zero exit, a stack trace on stderr) even though
// every byte of real content was already delivered and read. Found via
// parity/upstream-tests: upstream's tests/test_chat_history_index.sh "text
// output renders the messages" (`chat history --with X | grep -q 'sure!'`
// under `set -o pipefail`) failed ~20-40% of the time — a genuine content
// match followed by this crash flips the pipeline's exit status non-zero.
//
// Installed as a MODULE-LEVEL side effect (not inside exitAfterDrain the
// function) so it is in place before a single byte is written: every
// bin/*.mjs entry point does `import { exitAfterDrain } from
// "../src/exitAfterDrain.ts"` before calling the tool's own run* function
// (ES module imports are evaluated before the rest of the importing
// module's body runs), so this guard is live for every write the tool
// makes, not just exitAfterDrain's own trailing probe. Only EPIPE is
// swallowed; any other stream error still throws, matching the pre-existing
// (non-EPIPE) crash behavior.
import "./stdioSync.ts"; // under Bun, writes reach the fd before process.exit (see that file)

function ignoreEpipe(stream: NodeJS.WritableStream): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

export async function exitAfterDrain(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
  process.exit(code);
}
