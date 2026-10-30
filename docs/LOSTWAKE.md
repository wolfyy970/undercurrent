# LOSTWAKE: lost wakes in the TypeScript port, and the fix

Date: 2026-10-27. Branch `experiment/lost-wakes` of a scratch clone of `headlong-ts` at `sync/upstream-2e39a3f` (`34c65c0`). Nothing pushed; the sync worker's checkout was not touched. This is experiment 2 of `docs/design/04-experiments.md` (in `headlong-bots`) rerun against the port, then a fix and the same experiment again.

**No paid model call and no secret in a run.** The model is one local replay server on 127.0.0.1 (`parity/support/replayModel.mjs`) serving recorded real DeepSeek replies (`parity/lostwake/recordings/shared.json`): one short reply per call kind (DeepSeek's real 400 to the responder's structured request, a reply to a substantive message, the `NO_REPLY` to a "thanks" message, a person-notes update), served in cycle to every call of that kind. The tables below were measured with the earlier scripted server (`scripted_llm_server.py`, now deleted); re-runs with the recordings (`after-none2`, `after-kill21`) give the same counts. Everything runs in a scratch `HEADLONG_HOME`.

## Result

| | Runs with restarts | Messages | Restarts | Never woken | Rate | Duplicate replies |
|---|---|---|---|---|---|---|
| Upstream Bash (doc 04) | 12 | 600 | not logged per run (10 to 13 per aggressive run) | **168** | 28.0% | not measured |
| TS port, before the fix | 12 | 600 | 141 | **128** | 21.3% | 0 |
| TS port, with the fix | 12 | 600 | 136 | **0** | 0.0% | 0 |
| TS port, with the fix, stress (kill -9 every 0.5 to 1.5 s, model takes 1.5 s per call) | 3 | 150 | 56 | **0** | 0.0% | 0 |

With no restarts, 0 of 50 lost before and after. Per run: `parity/lostwake/results/{base,fixed,stress}-*.json`; the aggregation is `node parity/lostwake/summarize.mjs <label>`.

The port **has the same defect as upstream.** Every one of the 650 messages reached the recipient's trajectory and the sender saw "Message sent" 650 of 650 times, but 128 of 600 never woke the responder. The TS rate (21.3%) is lower than Bash's (28.0%). I would not read anything into that: the harness is a port of the Bash one, not the same code; the restart counts differ (13 to 23 per aggressive TS run, 10 to 13 for Bash); four TS runs ran in parallel on a loaded machine; and the Bash kill -9 losses were partly unexplained. Both are far from zero.

### Matrix (same modes and seeds as doc 04: 13 runs)

Columns: restarts, sent, consumed (an `observation` names the message), **never woken**, sent while the pid file said down, of those never woken, never woken while the pid file said up, duplicate replies, receipts done.

Before the fix:

| base-graceful11 | graceful 1-4s | 15 | 50 | 37 | **13** | 6 | 5 | 8 | 0 | 0 |
| base-graceful12 | graceful 1-4s | 14 | 50 | 37 | **13** | 8 | 7 | 6 | 0 | 0 |
| base-graceful13 | graceful 1-4s | 14 | 50 | 33 | **17** | 9 | 9 | 8 | 0 | 0 |
| base-graceful14 | graceful 1-4s | 13 | 50 | 37 | **13** | 8 | 7 | 6 | 0 | 0 |
| base-graceful31-gentle | graceful 10-18s | 5 | 50 | 46 | **4** | 2 | 2 | 2 | 0 | 0 |
| base-graceful32-gentle | graceful 10-18s | 5 | 50 | 46 | **4** | 1 | 1 | 3 | 0 | 0 |
| base-graceful33-gentle | graceful 10-18s | 5 | 50 | 45 | **5** | 4 | 3 | 2 | 0 | 0 |
| base-kill21 | kill 1-4s | 19 | 50 | 34 | **16** | 12 | 10 | 6 | 0 | 0 |
| base-kill22 | kill 1-4s | 23 | 50 | 34 | **16** | 12 | 12 | 4 | 0 | 0 |
| base-kill23 | kill 1-4s | 19 | 50 | 33 | **17** | 14 | 13 | 4 | 0 | 0 |
| base-kill41-gentle | kill 10-18s | 5 | 50 | 44 | **6** | 3 | 3 | 3 | 0 | 0 |
| base-kill42-gentle | kill 10-18s | 4 | 50 | 46 | **4** | 3 | 3 | 1 | 0 | 0 |
| base-none2 | none 1-4s | 0 | 50 | 50 | **0** | 0 | 0 | 0 | 0 | 0 |

After the fix:

| fixed-graceful11 | graceful 1-4s | 11 | 50 | 50 | **0** | 9 | 0 | 0 | 0 | 50 |
| fixed-graceful12 | graceful 1-4s | 14 | 50 | 50 | **0** | 11 | 0 | 0 | 0 | 50 |
| fixed-graceful13 | graceful 1-4s | 14 | 50 | 50 | **0** | 10 | 0 | 0 | 0 | 50 |
| fixed-graceful14 | graceful 1-4s | 15 | 50 | 50 | **0** | 11 | 0 | 0 | 0 | 50 |
| fixed-graceful31-gentle | graceful 10-18s | 5 | 50 | 50 | **0** | 3 | 0 | 0 | 0 | 50 |
| fixed-graceful32-gentle | graceful 10-18s | 7 | 50 | 50 | **0** | 2 | 0 | 0 | 0 | 50 |
| fixed-graceful33-gentle | graceful 10-18s | 6 | 50 | 50 | **0** | 6 | 0 | 0 | 0 | 50 |
| fixed-kill21 | kill 1-4s | 17 | 50 | 50 | **0** | 15 | 0 | 0 | 0 | 50 |
| fixed-kill22 | kill 1-4s | 18 | 50 | 50 | **0** | 12 | 0 | 0 | 0 | 50 |
| fixed-kill23 | kill 1-4s | 19 | 50 | 50 | **0** | 14 | 0 | 0 | 0 | 50 |
| fixed-kill41-gentle | kill 10-18s | 7 | 50 | 50 | **0** | 5 | 0 | 0 | 0 | 50 |
| fixed-kill42-gentle | kill 10-18s | 3 | 50 | 50 | **0** | 2 | 0 | 0 | 0 | 50 |
| fixed-none2 | none 1-4s | 0 | 50 | 50 | **0** | 0 | 0 | 0 | 0 | 50 |

Aggregated by condition (runs, messages, restarts, never woken, rate, duplicate replies):

Before:

| graceful, aggressive | 4 | 200 | 56 | 56 | 28.0% | 0 |
| graceful, gentle | 3 | 150 | 15 | 13 | 8.7% | 0 |
| kill, aggressive | 3 | 150 | 61 | 49 | 32.7% | 0 |
| kill, gentle | 2 | 100 | 9 | 10 | 10.0% | 0 |
| no restarts | 1 | 50 | 0 | 0 | 0.0% | 0 |

After:

| graceful, aggressive | 4 | 200 | 54 | 0 | 0.0% | 0 |
| graceful, gentle | 3 | 150 | 18 | 0 | 0.0% | 0 |
| kill, aggressive | 3 | 150 | 54 | 0 | 0.0% | 0 |
| kill, gentle | 2 | 100 | 10 | 0 | 0.0% | 0 |
| no restarts | 1 | 50 | 0 | 0 | 0.0% | 0 |

Stress, after:

| stress-kill51-c0p5-1p5 | kill 0.5-1.5s | 21 | 50 | 50 | **0** | 15 | 0 | 0 | 0 | 50 |
| stress-kill52-c0p5-1p5 | kill 0.5-1.5s | 18 | 50 | 50 | **0** | 8 | 0 | 0 | 0 | 50 |
| stress-kill53-c0p5-1p5 | kill 0.5-1.5s | 17 | 50 | 50 | **0** | 17 | 0 | 0 | 0 | 50 |

## Why messages were lost in the port [I]

1. **Nothing replays on start.** `TrajFeeder.start()` opens at the current end of file (`src/feeder.ts`, a deliberate copy of `tail -n 0 -F`). A message stored while no dispatcher runs is behind the feeder forever. 75 of the 82 messages sent while the pid file said "down" were never woken.
2. **Queued wakes are dropped on stop.** `run/pending/` is removed at boot (`daemon.ts`) and on stop (`thinkersctl.ts`). A message queued behind a busy responder is gone with it.
3. **The pending FIFO drops its oldest at 16** (`MAX_PENDING_FIFO`). Not seen at 50 messages per run with fast scripted replies, but the same kind of loss; the fix removes it for message and action steps.
4. 53 messages were lost while the pid file said "up". That fits 2 (queued, then a stop or kill) and the window between a restart and the feeder opening; I did not trace each one. [H]

## The fix

Two small additive pieces under `<identity>/run/`, written only by the dispatcher (`src/wakeLedger.ts`, wired in `src/daemon.ts` and `src/dispatcher.ts`):

| File | Content |
|---|---|
| `run/ledger/<thinker>.jsonl` | Append-only receipts. `{"ev":"recv","id":<step_id>,"file":…,"step":{…}}` means the message is **stored and owed**. `{"ev":"done","id":…}` is the **consumed receipt**. |
| `run/cursor/<sha1(file)[0:16]>` | `{"file","ino","offset"}`: the byte offset up to which complete lines of that trajectory were fed **and ledgered**. |

Rules:

- **Delivered is not consumed.** A message or action step is ledgered (`recv`) the moment the dispatcher routes it to a thinker, before it is dispatched or queued, and before the cursor passes it. `done` is written only when that thinker's step exits 0. A non-zero exit leaves it owed.
- **Cursor.** The feeder reports the offset after each poll (`onAdvance`); the daemon persists it (atomic rename) and rewrites it on every tick. On start the daemon reads `[cursor, last complete line)` of each trajectory, feeds the message and action steps in it as replays, and starts the feeder exactly where that read ended. No cursor, a different inode or an offset past the end means a first start or a replaced file: end of file, as before.
- **Replay on start.** Older debts first: the ledger's owed steps are re-queued, then the cursor gap. An owed step the trajectory already answers (a step with `trigger_step` equal to it and `source` equal to the thinker; a bare `reply_claim` does not count) is marked consumed instead of run again, so a dispatcher killed after the thinker finished does not cause a second reply. A thinker that is now off or gone is released.
- **Crash safety.** recv is written before the cursor moves, so a crash between the two re-feeds a line the ledger already knows, and it is not owed twice. A torn last ledger line is ignored. The ledger is compacted at start (owed entries plus the last 2000 consumed ids for dedupe).
- **No drop at the cap.** Past 16 pending, owed steps wait in an in-memory overflow queue, in order, and move into the FIFO as room appears. They are still in the ledger if the process dies.
- Only `message` and `action` are replayed (the types upstream already queues FIFO). Every other step type keeps upstream's rule that a restart does not replay it.
- `THINKERS_WAKE_LEDGER=0` turns the whole thing off and restores upstream's behaviour (tested).

### Changes to surfaces that parity relies on (the list asked for)

| Surface | Change | Avoidable? |
|---|---|---|
| Trajectory format and steps | **None.** The consumed receipt is a `run/` file, not a trajectory step. | n/a. A team-visible `consumed` step would be a new step shape, which I did not add. |
| Frozen `run/` files (`claimed`, `sent`, `fifo_path`, `dispatcher.lock`, token, pid, `pending/`, `sub_map`, `traj_files`) | **None changed.** Two new entries, `run/ledger/` and `run/cursor/`, are additive. `thinkers stop` does not remove them (stop cancels timed wakes, not messages). | n/a |
| Behaviour vs upstream Bash | **Deliberate divergence:** a restart now replays unconsumed message and action steps (upstream: feeders start at end of file); a full pending FIFO no longer drops the oldest message or action. | Unavoidable: it is the fix. Needs a row in `PARITY.md` and a note in the `headlong-bots` design (doc 02 §5, question 9). |
| `dispatcher.log` | New lines only in the new cases: `pending -> X (… overflow=N; owed, not dropped)`, `wake ledger: …`, `cursor … starting at end of file`, `step for <id> failed …`. Existing lines are byte-identical. | Could be dropped; they are the only operator signal. |
| `ThinkerDef.run` | Return type widened to `Promise<void \| number>` (exit code). `spawnStep` now returns it. In-process thinkers returning `void` are unchanged. | Needed for "consumed means the step succeeded". |
| `TrajFeeder` | `start(from?)`, `onAdvance`, `position()`. Default behaviour unchanged. | n/a |

I did not edit `PARITY.md`, `PORTING.md` or `SPEC.md` in this scratch branch; the sync worker owns them.

### Tests

`test/wake-ledger.test.ts`, 18 tests: ledger round trip and dedupe, torn last line, compaction, cursor round trip and corruption, answered-in-trajectory detection, feeder resume from a cursor and fall-back for a replaced file, `onAdvance` never past a partial line, the dispatcher (owed from feed, consumed on exit 0, failed step stays owed and is re-run, queued messages survive a stop and replay in order, answered step is released not re-run, off thinker released, 40 messages through a 16-deep FIFO with none dropped, replay and live feed overlap, non-message types not replayed), and two tests with the real `bin/dispatcherd.mjs`: kill -9, append two messages while down, restart, each seen exactly once in order and the ledger empty; and `THINKERS_WAKE_LEDGER=0` reproducing the loss.

## Regression checks

- Full suite with the fix (`DOCKER_CONTEXT=colima vitest run`): **2338 passed, 2 failed, 8 skipped** (2348 tests, 125 files). The 2 failures (`steprun.test.ts` "Docker-mode wake sees LLM_API_URL rewritten", `progress-logs.test.ts` "exact stderr/stdout sequence") **fail the same way on the unmodified sync base `34c65c0`**, so they are not from this change. Cause not investigated; both are monolith and Docker related. The 18 new tests are among the passes.
- Daemon adversarial differential against real upstream Bash (`parity/daemon/run-parity-adversarial.mjs`, upstream `2e39a3f`): **88 checks, 84 parity, 4 documented deviations, 0 DIVERGE**, with the fix in place. (It sends no message through a dispatcher, so it shows the new `run/` entries do not disturb the frozen files; it does not exercise the replay path.)
- Not run: `parity/upstream-tests/run.mjs`, and the other parity harnesses.

## Limits, and what is not solved

- **Scripted replies only, no real model.** With a real model the responder is slower, queues are longer and kills land mid-step more often. The slow stress runs (scripted replies delayed 1.5 s per call) are a rough stand-in, 3 runs.
- **A step that crashes every time** is retried once per dispatcher start and never in between (no hot loop), and there is no attempt counter, so a poison message would be retried at every restart. A cap with escalation to a human is the Team Bridge's job (doc 02 §6).
- **"Consumed" here means the thinker's step exited 0.** For the responder that matches an `observation` naming the message (all 650 runs agree: receipts done equals consumed). A step that exits 0 without answering would still count as consumed. `reply-failed` counts as consumed, as in doc 02 §5.
- **A thinker killed between its `reply_claim` and its `observation`** (claim live, no answer): the replay runs the responder again and the responder's own idempotence guard (`responderAlreadyHandled`, claim TTL) decides. If the claim is still fresh it skips the message and the ledger marks it consumed, so that rare case can still lose a reply until the claim goes stale. 0 of 150 messages hit it in the slow-stub runs; not proven away. [H]
- **The consumed receipt is not in the trajectory.** The Team Bridge or UI must read `run/ledger/` or we add a `consumed` step later (a new step shape, so a recorded oracle change).
- **No `flock` on this Mac** (same as doc 04): the single-owner lock path was not exercised. Not run on Linux.
- Multiple trajectories per identity: the cursor is per file and the code loops over `traj_files`, but only one trajectory per identity was exercised.
- The ledger scan for "already answered" reads at most the last 16 MB of a trajectory.

## Reproduce

```
cd <clone>; pnpm install --frozen-lockfile
parity/lostwake/run-matrix.sh <label> 4          # the 13-run matrix, 4 at a time; LW_ROOT=<scratch dir>
SCRIPTED_DELAY=1.5 node parity/lostwake/run-lostwake.mjs kill 51 --label stress --chaos 0.5,1.5 --settle 90 --port 18901
node parity/lostwake/summarize.mjs <label>
```

To see the loss again: `THINKERS_WAKE_LEDGER=0` in the harness environment.
