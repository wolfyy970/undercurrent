# parity/live — live side-by-side runner

Automates the manual run documented in `SIDE-BY-SIDE.md`: real upstream Bash
Headlong vs. this TS port, same persona, same scripted messages, same real
model, run concurrently against a real Docker sandbox, then diffed for
**structural** (contract) parity — not prose. This is what turns "the port
matches the original live" from a one-off manual session into a repeatable
command with an exit code, suitable for a merge gate.

## Quick start

```bash
export PARITY_UPSTREAM_ROOT=/path/to/a/real/upstream/headlong/checkout
# an LLM provider key (OPENROUTER_API_KEY etc.) must already be in your
# environment for a live run — never pass it as a flag or write it to a file

# prove both sides are wired correctly, zero model cost, <1 minute:
node parity/live/run-sxs.mjs --dry-run

# the real thing (defaults: 15 minutes, parity/live/scripts/default.json —
# the A/B/C protocol from SIDE-BY-SIDE.md):
node parity/live/run-sxs.mjs --minutes 15

# L4 chaos/recovery: --script picks any scenario file (see "Scenario events"
# below) — the canonical 30-minute campaign covering every event type:
node parity/live/run-sxs.mjs --minutes 30 --script parity/live/scripts/campaign-30m.json
```

Exit codes: `0` = ran clean, no structural diffs and no chaos-recovery field
mismatches (stdout prints `PASS (inconclusive: ...)` instead of a bare
`PASS` if any small-sample rule couldn't reach a verdict — see `MIN_RUNS`
below; it still doesn't fail the gate). `2` = ran clean, structural diffs
and/or chaos-recovery mismatches found (listed on stdout and in
`report.md`). `1` = a side failed to run at all (why is on stderr) —
comparison never runs.

## What it does

1. Copies `PARITY_UPSTREAM_ROOT` and this checkout into a scratch root under
   `$HOME` (`PARITY_LIVE_ROOT`, default `~/.headlong-parity-live/<timestamp>`
   — Colima only shares `$HOME` into its VM, so the identities root must
   live there, same constraint as the main README).
2. Creates identity `sxs` (or `--identity NAME`) on both sides with the same
   persona env, via each side's `headlong-init`.
3. Starts the monolith + responder thinkers on both sides — distinct
   `HEADLONG_HOME`/`HEADLONG_APP_DIR`/identity dirs so they never collide;
   `DOCKER_CONTEXT` and any other env you already have set pass straight
   through to both.
4. Applies the compiled scenario timeline — scripted messages AND any chaos
   events — to both sides at the same wall-clock offsets (default:
   `parity/live/scripts/default.json`, the A/B/C protocol; `--script FILE`
   for your own — see "Scenario events" below).
5. Runs for `--minutes N` (default 15) wall-clock from start.
6. Stops both sides cleanly: `thinkers stop` (drain), then **polls** every 2s
   for live processes under each side's app dir until none remain or the
   drain deadline (`THINKERS_DRAIN_TIMEOUT`, default 180s, +10s grace)
   passes — only then does it force-stop, then polls again (up to 20s)
   before declaring anything a true orphan. Polling (not a single check
   right after `stop` returns) matters because draining is asynchronous:
   `stop` returns once it's told the thinkers to drain, and the actual
   drain — on both the upstream and port sides — finishes after that, in
   the thinker processes themselves. A single immediate check misreports
   still-exiting processes as leaks. The pid recorded from this run's own
   `thinkers start` invocation is excluded from orphan detection throughout
   — it's the runner's own launcher, not a leak. Any true orphan process or
   `shellm-*` Docker container is cleaned up (SIGTERM / `docker rm -f`) and
   reported as a structural diff; each side's drain duration is recorded
   too.
7. Captures each side's `trajectory.jsonl`, `messages.jsonl`, `memories/`,
   `run/logs/*.log`, and a `chat history --with <operator> --json` transcript
   — all left in place under the scratch root (nothing is deleted).
8. Writes `report.md` and `results.json` in the scratch root: the counts
   table, drain duration per side, a full step-type counts table (including
   non-structural types like `action` — see STRUCTURAL-DIFF rules below),
   the collapsed step-type sequence per side, wake-cadence timelines from
   the dispatcher logs, every scripted message's reply text, memory file
   names, a `STRUCTURAL-DIFF` section, and — when applicable — an
   `INCONCLUSIVE (small sample)` section (see `MIN_RUNS` below).

## `--dry-run`

Real `headlong-init --dry-run` runs on both sides (proves the sandbox-consent
gate wiring), plus a real `identity new --default <name>` on both sides
(proves the identity scaffold — `memories/`, `skills/`, `kernel/`,
`trajectories/` with its seed thoughts, `thinkers/` — is structurally
identical) — all at zero network/model cost, because `headlong-init`'s own
`--dry-run` flag returns *before* it would ever call the LLM (persona
rewrite, connection check), so it alone can't prove identity creation works;
`identity new` fills that gap without paying for it. No thinkers start, no
message is sent. Finishes in a few seconds.

## STRUCTURAL-DIFF rules (the merge gate)

Only shape, never prose or timing — a scripted message's reply *text*
differing between sides is expected model nondeterminism and is reported,
never a diff. A run is flagged if any of:

- final-step ratio (`final` steps / `shellm-run` steps) differs by >30
  percentage points between sides
- reasoning-steps-per-run differs by more than 2x
- a per-thinker log (`monolith.log`/`responder.log`/`responder-notes.log`)
  is zero bytes on one side and non-zero on the other
- `messages.jsonl` line count ≠ trajectory `message`-step count, on either
  side
- any process or `shellm-*` container this run started is still alive after
  the stop sequence completes (see step 6 above for how "still alive" is
  decided — polled through the drain deadline and past `--force`, launcher
  pid excluded, so this only fires for a genuine leak)
- a **structural** trajectory step `type` appears on one side and never on
  the other. Only the types in `STRUCTURAL_STEP_TYPES` (lib.mjs) gate:
  `shellm-run`, `prompt`, `reasoning`, `shell-output`, `final`, `idle`,
  `error`, `reply_claim`, `observation`, `message`, `trajectory`, `thought`.
  Any other type — e.g. `action`, a responder-deferral step the model emits
  only when it chooses to defer — is model-choice, not port shape: it's
  still shown in the report's per-type counts table, but a one-sided
  occurrence never fails the gate.

### `MIN_RUNS` — small-sample rules don't fail the gate

Two rule families above are ratio/presence checks over a handful of
`shellm-run` steps, and two consecutive real 10-minute gate runs on a change
that could not affect run length produced opposite-signed verdicts at a tiny
sample (18 vs 9 runs one time, 4 vs 5 the next) — that's sampling noise, not
a port defect, and it must not fail the gate:

- **final-ratio** and **reasoning-per-run** are a hard FAILURE only when
  **both** sides have `>= MIN_RUNS` (8) `shellm-run` steps. Below that
  (either side under 8), the same computation is emitted as an
  **inconclusive** entry instead — same `{code, message}` shape, its own
  `## INCONCLUSIVE (small sample)` section in `report.md`, never counted
  toward exit `2`.
- one-sided **`idle`** and **`error`** (from the structural-type-presence
  rule above) are also inconclusive when **either** side is under
  `MIN_RUNS` — both step types are legitimately absent from a short run (no
  time to go idle, no error surfaced) without meaning anything structural.
  Every other structural type — `final` included — stays a hard diff at any
  `n`; a genuinely missing `final` or `message` step is never sample-size
  noise.
- Every other rule (zero-byte log, message-index mismatch, orphan
  process/container, and one-sided types other than `idle`/`error`) never
  softens, regardless of run count.

`run-sxs.mjs` still exits `0` when there are inconclusive entries and no
hard diffs, but prints `PASS (inconclusive: <codes>)` instead of a bare
`PASS` so it's visible on stdout, not just in `report.md`. If a ratio
verdict actually matters for a given change, re-run with more runway —
`--minutes 15` (the default) rather than a shorter smoke run — to clear
`MIN_RUNS` on both sides.

## Scenario events (`--script FILE`, `--messages` accepted as an alias)

A scenario file is a JSON array of **events**, each with `atMinutes` (offset
from run start) and a `type`. A bare `{atMinutes, from, text}` entry with no
`type` is still a plain `message` — the original A/B/C protocol shape keeps
working unmodified. Every event is applied to **both sides at the same
offset**, using each side's own CLI (`bin/thinkers` vs. `bin/thinkers.mjs`,
etc.) — see `run-sxs.mjs`'s `applyEvent`. Parsing/validation/scheduling is
`parity/live/scenario.mjs` (pure, unit-tested in `test/live-scenario.test.ts`).

```json
[
  { "atMinutes": 0, "from": "jo", "text": "..." },
  { "type": "burst", "atMinutes": 5, "count": 4, "overSeconds": 30, "textTemplate": "ping #{n}" },
  { "type": "dispatcher-sigterm", "atMinutes": 10 },
  { "type": "thinkers-start", "atMinutes": 10.5 },
  { "type": "model-fault", "atMinutes": 12, "faultType": "500", "count": 3 },
  { "type": "quiet", "atMinutes": 15, "minutes": 5 }
]
```

| type | fields | effect |
|---|---|---|
| `message` | `text`, `from?`, `to?` | one scripted chat message. `from` defaults to `--operator` (default `jo`), `to` to `--identity`. |
| `burst` | `count`, `overSeconds`, `textTemplate?` (`{n}` → 1-based index) or `texts?` (array of exactly `count` strings), `from?`, `to?` | `count` messages spread evenly across `overSeconds`, expanded to concrete `message` events before scheduling (`scenario.mjs`'s `expandBursts`). |
| `thinkers-stop` | `force?` | `thinkers stop` (or `--force`) on both sides. |
| `thinkers-start` | — | `thinkers start` on both sides — the recovery half of a kill/stop event; nothing auto-restarts a dispatcher on its own (see "Dispatcher kill/restart" below). |
| `dispatcher-sigterm` / `dispatcher-sigkill` | — | signals the dispatcher pid (`run/dispatcher.pid`) directly on both sides, if one is alive. |
| `step-sigkill` | — | `SIGKILL`s the in-flight `thinkers/<name>/step` child process on both sides, if one is running at that instant (a no-op, logged as such, if neither side has a step in flight). |
| `docker-pause` / `docker-unpause` | — | pauses/unpauses every `shellm-*` sandbox container bind-mounting the identity's dir, on both sides (see "Container discovery" below). |
| `model-fault` | `faultType` (`429`\|`500`\|`truncated`\|`stall`), `count` | queues `count` faulted responses on the shared fault-injecting proxy — see below. Requires `OPENROUTER_API_KEY`. |
| `quiet` | `minutes` | nothing is scheduled for `minutes` starting here — the unprompted-outreach window. `scenario.mjs` rejects any event landing strictly inside a quiet window (an event exactly at the boundary is fine). |
| `second-identity` | `name` (identity-safe slug) | creates + starts a second identity on both sides, mid-run, alongside the primary — stopped alongside it at teardown. |

### Dispatcher kill/restart — nothing auto-restarts

`dispatcher-sigterm`/`dispatcher-sigkill` only kill; a scenario must pair
one with its own `thinkers-start` to test recovery (both the canonical
scripts do). This matches upstream: there is no supervisor in this harness
(no systemd), so `thinkers start` is what a human/operator runs after a
crash — and it's also what appends the "Wake-up note: your dispatcher just
started... your mind was not running in between" observation, but only when
the gap since the last trajectory step is `>= THINKERS_WAKE_NOTE_MIN_GAP`
(upstream default 300s, env-overridable — bin/thinkers). **The port hardcodes
this at 300s with no env override** (`src/thinkersctl.ts`'s
`WAKE_NOTE_MIN_GAP_S`) — a real, harness-discovered config-surface gap, not
something this harness works around. Because of it, a short scripted
downtime (as in `reduced-12m.json`/`campaign-30m.json`, where the gap between
a kill and its paired `thinkers-start` is well under 5 minutes) is expected
to leave the note absent on BOTH sides — `renderChaosSection`'s
`wakeGapNotePresent` field should read `false`/`false` (match), not a
divergence. Re-run with a kill/restart pair spaced >5 minutes apart to
actually exercise the note.

### Container discovery

A container "belongs" to a side/identity when one of its bind mounts sources
the identity's own directory (`bin/shellm` always runs `-v
"$IDENTITY_DIR:$IDENTITY_DIR"`; `src/sandbox-runtime.ts` mirrors this) —
checked via `docker inspect`, not by matching the owning `bin/shellm`
process's pid against the `shellm-<pid>` container name, because the
container can outlive that process (the point of `docker-pause`/`step-sigkill`
testing is exactly that kind of survival). `docker-pause`/`docker-unpause`
are no-ops (logged, not failures) when a side has no sandbox container yet —
the model hasn't used the shell tool at that point in the run.

## Fault-injecting proxy (`fault-proxy.mjs`)

When `OPENROUTER_API_KEY` is set and the run is live (not `--dry-run`),
`run-sxs.mjs` starts a small OpenAI-compatible pass-through proxy **in the
same Node process** (`createFaultProxy` — just a `node:http` server, no
subprocess) and points both sides' model calls at it via `LLM_API_URL` — the
same override both sides already support for their `openrouter` provider
branch (`bin/llm`'s `get_url_headers`, mirrored exactly by
`src/llmCli.ts`), which still sends `Authorization: Bearer
$OPENROUTER_API_KEY` from the CLIENT's own env. The proxy **replaces** that
header with a Bearer token built from its own `process.env.OPENROUTER_API_KEY`
before forwarding — "the key from the process env only" — and never logs a
header, body, or key value.

Every request is forwarded to the real `openrouter.ai` unchanged UNLESS a
`model-fault` event has queued faults:

- `429` / `500` — a synthetic error JSON body, no upstream call made.
- `truncated` — a REAL upstream call is made, but only the first ~50% of the
  response body bytes are returned (content-length dropped), producing a
  syntactically invalid/incomplete body.
- `stall` — holds the response for 60s before proceeding with a normal
  forwarded call (`STALL_MS` in `fault-proxy.mjs`) — tests client-side
  timeout/retry behaviour under a hung provider without hanging forever.

**Both sides share one proxy instance**, so a queued fault applies to
whichever side's request arrives next — the two sides' model calls are not
synchronized, so "the next K requests" cannot be split evenly per side. This
is a documented limitation: a `model-fault` event's `count` faulted requests
may land 3-0, 2-1, 0-3, etc. between orig/port depending on real call timing.
The fault-selection queue itself (`popFault`/`pushFault`) is pure and
unit-tested in `test/live-fault-proxy.test.ts`; the HTTP mechanics
(forwarding, truncation, stalling) are only exercised by a real run.

## Chaos recovery (L4)

For every `thinkers-stop`/`-start`, `dispatcher-sigterm`/`-sigkill`,
`step-sigkill`, and `docker-pause`/`-unpause` event, `run-sxs.mjs` captures a
BEFORE and AFTER snapshot on both sides (`captureChaosRaw` — dispatcher pid +
liveness, `run/last_signal`, `run/step_pids`, `run/pending/` entry count,
`shellm-*` container states, whether the trajectory tail carries the
dispatcher wake-up-gap note), normalizes it (`lib.mjs`'s `buildChaosSnapshot`),
and compares orig's transition against port's (`compareChaosEvent`) on a
fixed field set:

- **direct fields** (`dispatcherAlive`, `lastSignal`, `wakeGapNotePresent`)
  — compared by equality on the AFTER state: both sides should reach the
  same qualitative outcome (dispatcher back up, correct signal recorded,
  note written or not).
- **delta fields** (`stepPidCount`, `pendingCount`, `containerCount`) —
  compared by the SIGN of their before→after change, not absolute value:
  the absolute count legitimately differs between sides from ordinary model
  timing, independent of the chaos event; whether it went up, down, or
  stayed flat is the recovery-relevant signal.

The result is a `## Chaos recovery (L4)` section in `report.md` — one table
per event, a `match` column per field. **A mismatch is a signal for a human
to classify (PORT-BUG / documented deviation / model nondeterminism /
environment), never an automatic verdict** — this harness reports and
classifies-by-table; it does not decide, and it never edits the port to make
a mismatch go away (PROOF-CAMPAIGN.md's own contract: "harness lanes never
fix the port"). A non-zero chaos-mismatch count still moves `run-sxs.mjs`'s
own exit code to `2`, same as a STRUCTURAL-DIFF, so it isn't silently missed
in CI-style usage — but reading the table is what tells you whether that `2`
means a real port bug or expected chaos-testing noise (e.g. the wake-note
gap explained above).

## Files

- `run-sxs.mjs` — the orchestrator (spawns processes, reads/writes files,
  sleeps; zero comparison logic of its own). Also exports two small
  testable-in-isolation helpers used by its orphan-detection polling:
  `filterOrphans` (excludes the launcher pid) and `pollUntilQuiet` (polls an
  injectable process lister on an injectable clock) — both take their
  dependencies as parameters, so `test/live-sxs-compare.test.ts` exercises
  them with a fake lister and a fake clock, no real processes or waiting.
  The file only runs `main()` when invoked directly (guarded by an
  entry-point check), so importing it for these helpers is side-effect-free.
- `lib.mjs` — every pure function: parsing `trajectory.jsonl`/
  `messages.jsonl`, normalizing the two `dispatcher.log` dialects (orig Bash
  has no milliseconds and prints `source=` empty for an internal step; port
  TS prints milliseconds and `source=-` — same grammar otherwise), counting,
  collapsing step-type sequences, the `STRUCTURAL_STEP_TYPES` allowlist, the
  `MIN_RUNS` small-sample threshold, the `STRUCTURAL-DIFF` gate (returns
  `{diffs, inconclusive}`), `report.md` rendering, and (L4) the
  chaos-snapshot comparison (`buildChaosSnapshot`, `parseStepPids`,
  `hasWakeGapNote`, `compareChaosEvent`, `renderChaosSection`). No
  fs/process/network — this is what `test/live-sxs-compare.test.ts` and
  `test/live-chaos-compare.test.ts` exercise directly.
- `scenario.mjs` — pure event parsing/validation/scheduling: `parseScenario`,
  `expandBursts`, `validateNoOverlapWithQuiet`, `compileTimeline`
  (the pipeline `run-sxs.mjs` calls), `impliedMinimumMinutes`. No
  fs/process/network — `test/live-scenario.test.ts` exercises it directly.
- `fault-proxy.mjs` — the in-process fault-injecting proxy
  (`createFaultProxy`) plus its pure fault-selection queue (`popFault`,
  `pushFault`, tested in `test/live-fault-proxy.test.ts` with no server).
- `scripts/` — named scenario files: `default.json` (the original A/B/C
  protocol, byte-identical to the old inline default), `campaign-30m.json`
  (the canonical 30-minute L3+L4 script — every event type at least once),
  `reduced-12m.json` (a ~12-minute script for a budget-conscious real run:
  one burst, one dispatcher-sigterm + thinkers-start, one step-sigkill, one
  model-fault 500×3, one quiet window).
- `fixtures/{orig,port}/` — the two REAL trajectories, dispatcher logs, and
  `messages.jsonl` from the live run documented in `SIDE-BY-SIDE.md`, with
  absolute local paths scrubbed to `<HEADLONG_ROOT>`/`<HOME>`/`<USER>`
  placeholders, plus a `log-sizes.json` recording each side's real
  per-thinker log byte sizes (the full 320KB `monolith.log` itself isn't
  vendored — only its size, which is all the zero-byte-log rule needs).

## Zero Bash

This script never spawns a `bash` interpreter itself. The upstream side's
own scripts (`tools/headlong-init`, `bin/thinkers`, `bin/chat`, `tools/identity`)
are invoked by their own path — the kernel resolves their `#!/usr/bin/env bash`
shebang, the same way `spawn("./some-script")` always has. `cp`/`docker` are
spawned as plain executables (`cp -R -c` for APFS clonefile copy-on-write,
falling back to plain `-R`), never through a shell. The fault-injecting
proxy (`fault-proxy.mjs`) runs in-process as a plain `node:http` server —
not a spawned subprocess, so there's no control-channel process to secure
or a shell to invoke it through either.
