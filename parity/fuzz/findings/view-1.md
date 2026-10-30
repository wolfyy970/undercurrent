# view fuzz finding #1 — systemic stdout truncation on large output

- classification: **PORT-BUG (high confidence)**
- group: `binary` (also `hostile`, `context` scenarios, and confirmed independently by `traj` — see "Duplicates" below)
- argv: `["f.txt"]`, `f.txt` seeded with 1,048,576 bytes of `0x42` ('B'), no newlines
- reproduce:
  ```
  node -e "require('fs').writeFileSync('f.txt', Buffer.alloc(1024*1024, 0x42))"
  <HEADLONG_ROOT>/bin/view f.txt | wc -c    # -> 1048584
  node bin/view.mjs f.txt | wc -c            # -> 65536
  ```

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | 1,048,584 bytes | **65,536 bytes (truncated)** | **NO** |
| stderr | (empty) | (empty) | yes |
| status | 0 | 0 | yes |

## Root cause

`bin/view.mjs` (and 9 other `bin/*.mjs` entry points — see below) end with:

```js
process.exit(runView(process.argv.slice(2), io));
```

`io.stdout` is `(s) => process.stdout.write(Buffer.from(s, "latin1"))`. On macOS,
`process.stdout` to a pipe is **asynchronous** with a small OS pipe buffer
(this box: 65,536 bytes). `write()` returns `false` once that buffer fills and
queues the remainder to flush on a future tick — but `process.exit()` right
after tears the process down immediately, **before** the queued remainder is
ever flushed. Any single `stdout(s)` call (or accumulated calls) whose total
exceeds ~64 KiB is silently truncated at the buffer boundary. Confirmed at
exactly 65,536 bytes in this environment; the OS pipe-buffer size is
platform/configuration-dependent, so the exact cutoff will vary, but the bug
mechanism (exit before drain) is deterministic and platform-general
(documented as a known Node.js footgun: process.exit() can truncate stdout
piped through a non-TTY).

**`bin/llm.mjs` already has the fix**, proving the port's authors knew about
and fixed exactly this bug once, but the fix was never propagated to the
other 10 CLI entry points:

```js
// bin/llm.mjs (tail)
// Pipes are asynchronous on macOS: let stdout/stderr drain before exiting so
// a streamed answer is never truncated by process.exit.
await new Promise((r) => process.stdout.write("", () => r()));
await new Promise((r) => process.stderr.write("", () => r()));
process.exit(code);
```

Grepping `bin/*.mjs` for `process.exit(run` / `process.exit(cli` finds the
SAME missing-drain pattern (`process.exit(runX(...))` immediately after a
build-up of `stdout(s)` calls, no drain) in:

`bin/context.mjs`, `bin/chat.mjs`, `bin/focus.mjs`, `bin/glob.mjs`,
`bin/mem.mjs`, `bin/put.mjs`, `bin/recap.mjs`, `bin/sub.mjs`, `bin/traj.mjs`,
`bin/view.mjs` — 10 of the 11 non-llm CLI entry points that write to stdout.
(`bin/headlong-killall.mjs`, `bin/headlong-init.mjs`, and the bridge/thinker
entry points were not checked for the same pattern.)

## Duplicates and independent confirmation

This is the single largest root cause found by the fuzzer: **~65-70 of
view's ~85-90 findings** and **all of context's findings** (a large fraction
of `view`'s 66 and `context`'s 7 raw DIVERGE hits, excluding the ~19
`offset-limit` findings which are a SEPARATE bug — see finding `view-13`)
are this exact bug, triggered whenever a scenario's seeded content/output
happens to exceed the pipe-buffer threshold (the `1mb`/`64kb` named byte
fixtures in `lib/gen.mjs`, or `context`'s random step count accumulating past
the threshold). **`traj`'s own fuzz findings independently confirm the same
pattern** (group `tail`: a large-content trajectory truncates `traj tail`'s
formatted stdout identically), which is strong evidence the remaining 8 files
(`chat`/`focus`/`glob`/`mem`/`put`/`recap`/`sub`) share it too.

## Proposed fix (for the fix lane — NOT applied by this harness)

Apply the exact `bin/llm.mjs` drain-before-exit pattern to the other 10
`bin/*.mjs` files.
