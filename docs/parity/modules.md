# Parity by module

> Detailed module evidence. Status overview: [`PARITY.md`](../../PARITY.md).

## Parity by module


> Table converted to sections for GitHub rendering.

### trajectory/schema — WRITE PATH ONLY (trajCore.mjs, types)

- **Status:** green

- **Parity:** 100%

- **Notes:**

`appendStep`/`readSteps`/`newTrajectory`: step schema + run_id auto-stamp + blob spill, field
names exact. This row previously read "trajectory/schema (trajCore, types)" with no scope
qualifier, which overclaimed: it covers ONLY trajCore's write primitives, not the `traj` CLI
tool built on top of them — see the next row, which is the actual `bin/traj`/`bin/traj.mjs`
parity status.

### traj CLI (bin/traj / src/trajCli.ts + bin/traj.mjs)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

Full port of all 14 subcommands (new, append, fork, merge, show, tail, search, count, last, cat,
exists, path, list, root, check) over an injectable IO seam, reusing trajCore's proven
appendStep/readSteps unchanged for append/last. 77 unit tests (test/trajCli.test.ts).
Differential `parity/traj/run-parity.mjs` (real Bash `bin/traj` vs the port, fixture
trajectories seeded from golden/trace-00): 82/82 effective (80 byte-identical + 2 documented
deviations, 0 DIVERGE) — see Deviations below. Before this port, only `append`/`last` were
implemented;
`show`/`tail`/`list`/`cat`/`path`/`search`/`new`/`fork`/`merge`/`exists`/`count`/`root`/`check`
were silent no-op stubs (or, for `exists`/`tail`/`cat`, a narrow hand-rolled behavior that
ignored `--traj_dir` and any non-root trajectory) — this was a confirmed real gap:
`parity/upstream-tests` suites `test_responder_idempotency.sh`, `test_monolith_backoff.sh`,
`test_prompt_file.sh`, `test_var_secrets.sh` failed on it (9/13, 5/10, 2/4, 3/7 port-only-fails)
and now pass (13/13, 10/10, 4/4, 8/8) — see traj CLI parity fixes below for the 2 real bugs the
differential harness found and fixed along the way.

### shellm inner loop

- **Status:** green

- **Parity:** 100%

- **Notes:**

prompt-as-step, one-bash-block extract, set -x wrap, FINAL capture. The "FINAL capture" claim
was proven only under `LocalSandbox` (host tmpdir `finalPath`) — under `DockerSandbox` the
model's bash runs INSIDE the container, where that host path was never mounted, so
FINAL/FINAL_FILE writes silently vanished (0/14 runs recorded a `final` step vs 14/15 upstream;
every docker-mode run burned the full `SHELLM_MAX_ITERATIONS` cap instead of stopping). Fixed:
`src/shellm.ts`'s `finalPath` now routes to `$workdir/.shellm_final` (bind-mounted into the
container, matching `bin/shellm:2515-2521`'s docker-mode branch) whenever `opts.header.env.type
=== "docker"`, LocalSandbox's `$rundir/final` path unchanged. Now proven under both sandboxes:
`test/shellm.test.ts` "runShellm: FINAL capture path selection (BUG #27)" — a LocalSandbox
regression plus two real-Docker-daemon tests (`FINAL="..."` and `FINAL_FILE=...`), the latter
skip cleanly with no docker daemon. bug #33 (inactivity watchdog, idle vs max KILLED
distinction): FIXED — see the "sandbox parity fixes" bullet and the `KILLED` kill-reason
Deviations row (both marked RESOLVED) below; `ShellmConstants` gained `inactivityTimeoutMs`
(`SHELLM_INACTIVITY_TIMEOUT`) alongside `inactivityMaxMs`.

### extract (reasoning/code)

- **Status:** green

- **Parity:** 100%

- **Notes:** heredoc-aware first block + truncation-notice quirk

### sandbox (LocalSandbox)

- **Status:** green (adapted)

- **Parity:** n/a

- **Notes:**

restricted subprocess, not Docker — DEVIATION below. `exec()` is now `async` and runs a real
inactivity watchdog (bug #33, FIXED — see "sandbox parity fixes" below), not a flat `spawnSync`
timeout

### backoff / wake_at

- **Status:** green

- **Parity:** 100%

- **Notes:** ladder [0,0,5,5,5,10] matched to trace-01

### dispatcher

- **Status:** green

- **Parity:** 100%

- **Notes:** subscription match, trigger_self skip, FIFO+coalesce, salience feedback

### responder + NO_REPLY

- **Status:** green

- **Parity:** 100%

- **Notes:**

silence on bare ack, 3-layer idempotency; trace-02 reproduced. Upstream sync 1b
(design/conversation_memory.md): conversation history now comes from the derived message index
(chat.ts's messageIndex.ts) grouped by person key across routing names, unioned with a Slack
thread's last day, falling back to the recent-stream window when the index has nothing;
DEFER:-line deferrals append an action step the monolith routes on;
context_msgs/thread_msgs/context_steps/history_source/model/compose_ms/gap_s are stamped on
every decision observation; per-person notes (a type:person memory) are written after a reply
and read into the next prompt (one noted deviation: reuses the reply's LlmClient, no per-call
model selection — see responder.ts's updatePersonNotes header); the async notes path
(RESPONDER_PERSON_NOTES_SYNC unset) spawns a real detached child process
(bin/responder-notes.mjs) rather than an in-process promise — a real bug fix, see the 0c51de8
row below for the live proof. 30 new unit tests (responder.test.ts) + 16
(responder-integration.test.ts) + 3 (responder-notes.test.ts, real subprocess against a fake LLM
server) + 2 (steprun.test.ts); differential parity/upstream-tests/run.mjs:
test_responder_metrics.sh 17/17, test_responder_deferral.sh 14/14,
test_responder_person_notes.sh 12/12, test_responder_thread_context.sh 7/7 (all no-port-cli —
thinkers/responder/step itself isn't a port CLI — but all exercise chat.mjs/traj.mjs on PATH, a
real differential for those). See "Upstream sync 1b" section below. **Bug #36 fix:**
`updatePersonNotes` now ports `_update_person_notes`'s dedup lock
(thinkers/responder/step:343-350) — `mkdir "${MEM_DIR:-/tmp}/.person-notes.lock" 2>/dev/null ||
return 0`, ONE lockdir per MEM_DIR (there is no `$key`/person in the Bash path — it serializes
ALL person-notes writes for one identity, not just the same person's), with NO staleness/steal
logic anywhere in the source: a lock left behind by a crashed writer blocks every future notes
update for that identity until removed by hand, ported faithfully (never auto-broken). Released
on every exit path via try/finally, matching the Bash's `trap "rmdir '$lockdir' 2>/dev/null"
EXIT`. Lives inside the shared `updatePersonNotes` function both the `personNotesSync`
in-process path and the detached `bin/responder-notes.mjs` child call, so both are covered
identically — exactly where the RUNTIME-SEAMS.md §D item 8 audit flagged it (a distinct
construct from bug #26's detached-subshell-outlives-parent issue, not yet closed when #26
landed). 8 new tests (`test/person-notes-lock.test.ts`): two near-simultaneous calls (second
no-ops); the lock is per-MEM_DIR not per-person (two different people's updates still serialize
against each other); a pre-existing stale lockdir is never auto-recovered (llm never called,
notes file never written, lock left untouched); release on success and on a thrown error (a
subsequent call then proceeds normally); the `mkdir -p` precondition failure short-circuits
before ever touching the lock; two REAL `bin/responder-notes.mjs` child processes racing on the
same person write exactly one notes file (file-count assertion, timing-independent — a broken
lock would produce two separately-hex-named files); two real children racing against a
pre-existing stale lock both no-op.

### monolith reactive coupling

- **Status:** green

- **Parity:** 100%

- **Notes:**

observation → reactive wake, level reset. Upstream sync 1b: the recent-stream projection both
this and the responder read now drops reasoning steps and collapses consecutive idle/error runs
(src/recentStream.ts, replacing the old inline recentStream); a part-5 "PENDING REQUEST" routing
hint (pendingRequestHint, exported) surfaces an unresolved responder deferral with the exact
chat reply --follow-up delivery command; thinkers/monolith/prompt.md's one-line pending-request
exception is byte-identical in both bundled copies (src/assets/monolith-prompt.md,
src/assets/thinkers/monolith/prompt.md). bug #37 (FIXED): the "no durable step" fallback's
`error` step (thinkers/monolith/step:361-369) was missing `rc` entirely and hardcoded `content`
to "…failed with no durable step" (no `(rc=N)`) — silently breaking `recentStream`'s own
rc-suffix collapse logic (thinkers/_lib/common.sh's `_RECENT_STREAM_COLLAPSE_JQ`, already ported
and tested against synthetic input, but never fed a real `rc` in production). Every failure path
that reaches the fallback maps to upstream's own `rc=1` (run_loop's `return 1` for
stall/max-iter, `die()`'s `exit 1` for empty-response) — see src/monolith.ts's inline citations;
upstream's own observed rc=141 (SIGPIPE, design/monolith_run_health.md Issue B) and rc=126
(ARG_MAX) are bash/OS artifacts this port's architecture cannot hit (no racing `tail|head` read,
prompt always via temp file) and are not modeled. Also fixed: `runShellm` is called in-process
(no subprocess boundary), so a thrown exception (LLM/sandbox failure runShellm doesn't catch)
used to escape `runMonolithWake` entirely — no fallback step, no backoff, no re-armed wake,
unlike upstream's `shellm ... || run_rc=$?`, which always keeps the outer step alive. Now caught
at that exact point, recorded as the same rc=1 error (with `run_id` recovered from the run
header if one was appended before the throw), and the wake completes normally
(`stopReason:"threw"`). Verified the "durable step" type sets match exactly (VISIBLE_TYPES
action/observation/merge/message + thought, both sides) — not a second bug.
test/monolith.test.ts (13, was 6): idle path has no `rc`/`reason` fields;
stall/max-iter/empty-response error steps carry `rc:1` and the exact upstream content string;
`trigger_step` passthrough; the thrown-exception path; an end-to-end recentStream collapse
proving the field monolith writes is the field recentStream reads. test/recentStream.test.ts
(9).

### chat CLI (bin/chat / src/chat.ts + bin/chat.mjs)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

send/send-file/reply/history/repl fully ported (see file header for the `${2:?}`-wording and
repl-exec-wording documented deviations). Upstream sync 1b adds `chat history --with <name>
[--since D] [-n N] [--json]` (the derived messages.jsonl index, src/messageIndex.ts), `chat
history --thread <name>` (src/personMemory.ts's threadKey), `chat person-key`/`chat thread-key`,
and `chat reply --follow-up` (bypasses the duplicate-answer guard, stamps follow_up:true — the
transport half of the responder's part-5 deferral). Also ports a real upstream behavior
tightening: `chat history`'s count is now validated `^[0-9]+$` on EVERY path (the legacy
`history [N]` positional included), so a `tail`-style `+N`/`-N` spec now dies before reaching
the old overflow check. 38 new unit tests (messageIndex.test.ts, personMemory.test.ts,
chat-history-index.test.ts). Differential parity/chat/run-parity.mjs: 70/77 (90.9%) vs real NEW
bin/chat — 21 new convo-memory scenarios all at PARITY, the remaining 7 DIVERGEs are the
pre-existing documented `${2:?}`/DEL-stdin/repl-exec-wording deviations (unchanged).
parity/upstream-tests/run.mjs's test_chat_history_index.sh (a NEW upstream suite that drives
bin/chat directly): 29/29. Two real port bugs found and fixed along the way
(person-key/thread-key's missing second trailing newline; history --with's text-mode output
missing jq's implicit JSON-string quoting) plus one broader trajectory-resolution bug
(rootFile() only tried the `<hex8>-root` convention, not the full
`<dir>/<id>/trajectory.jsonl`/exact-path forms `traj append`/`traj path` also accept) — see
"Upstream sync 1b" section below for detail. **PORT-BUG #68** (found later, characterizing a
suspected reply-to/TRAJ_ID gap): `appendStep`'s write path reused that same lenient `rootFile()`
fallback, so an unresolvable `TRAJ_ID` silently auto-created a brand-new trajectory instead of
refusing like real `traj append`'s `require_traj_file` (`traj: error: append: cannot resolve
traj_id '<id>' in '<dir>'`, rc 1) — fixed by giving `appendStep` its own strict resolution +
upstream's exact death text; `rootFile()` keeps the lenient fallback for reads only. See the
"Real bugs found and fixed" list below for detail. The `messages.jsonl` index is deliberately
lazy on both sides: `_index_update`/`indexUpdate` runs only inside
`cmd_history`/`cmdHistoryIndexed` (`bin/chat:385`, `src/chat.ts:591`) — CHECK #29 confirmed the
port's responder wake matches upstream's `chat history --with` call at wake start
(`thinkers/responder/step:149` ↔ `src/responder.ts:253`), but upstream also re-indexes a SECOND
time inside `_update_person_notes` (`thinkers/responder/step:350`, its own fresh `chat history
--with` call, run AFTER `chat reply` has appended the wake's reply) while the port's
`updatePersonNotes` was reading the wake-start snapshot straight through — one fewer
index-update call site, so the notes prompt always missed the reply that triggered it (the
"messages.jsonl lagged one message behind the trajectory" symptom). Fixed: `updatePersonNotes`
(`src/responder.ts`) now re-indexes unconditionally at its start, covering both the sync path
and the async `bin/responder-notes.mjs` path — `test/responder-notes.test.ts` "re-indexes before
reading history" proves it fails pre-fix and passes post-fix.

### mem / recall / learn

- **Status:** green

- **Parity:** PARITY

- **Notes:**

82 unit tests; differential 76/86 vs real Bash (upstream-next @ 5458fee) — all 10 mismatches are
the one documented `${2:?}`-class stderr-wording deviation (exit code + stdout + on-disk state
match). learn/recall are surfaced as `mem add`/`mem search` (monolith-prompt.md). **Upstream
sync 2 (lane C):** `mem search` is now two-stage — `mem_prefilter` scores every memory locally
with BM25 (byte-wise, `LC_ALL=C` semantics) and keeps the best `MEM_SEARCH_TOP` (40) for the
model, with a `-t MEM_SEARCH_MAX_TOKENS` (16000) output cap and a "waiting for the model"
heartbeat on stderr every `MEM_SEARCH_HEARTBEAT_S` (10; `"0"` disables) while `llm` runs; an
empty store now prints "No memories stored." and exits 0 (was a silent rc 1 — Bash's own `set
-e`+pipefail dead-code branch, now guarded upstream); `mem prefilter <query> [--top N]` exposes
stage 1 with no model call; `mem add --until YYYY-MM-DD` dates a todo (shape-only validation)
and the field now survives a `mem edit`. See "mem search prefilter/heartbeat/until (upstream
sync 2, lane C)" below for the full behavior list, the BM25 tie-break bug found and fixed, and
documented deviations.

### skills (authoring + invoke)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

52 unit tests; differential oracle 91/91 effective (81 byte-identical + 10 documented
deviations; 0 port bugs); fixes + deviations below

### skills content (src/assets/skills/, vendored)

- **Status:** green

- **Parity:** 100%

- **Notes:**

12 bundled packs (README.md + 11 SKILL.md files: kernel/{mem,chat,goals} +
bundled/{file-tools,googleworkspace,obsidian,shellm,skill-author,slack,telegram,web-research})
copied byte-identical from upstream headlong/skills/ at ed2dac6. Validated via
test/skills-content.test.ts (pack directory listing, per-pack SKILL.md file presence and
non-empty). Identity bootstrap (src/identity.ts) provisions these into new identities; build
script (package.json) copies src/assets/ to dist/ for runtime.

### chat outward delivery

- **Status:** STUB / faithful-gap

- **Parity:** n/a

- **Notes:** trace-04 stranding reproduced on purpose; see Deviations

### memory tiered rollups

- **Status:** green

- **Parity:** PARITY

- **Notes:**

55 unit tests; differential 19/19 vs real Bash `recap`/seal on pax's 1200-step trajectory
(render 252/252 rows byte-exact, block-plan set, staircase selection)

### recap CLI (bin/recap: map-reduce episodes/themes + --context staircase)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

src/recap.ts + bin/recap.mjs. 102 unit tests (llm seam injected): jq/bash/awk-semantics helpers
(renderStep, windowRanges, bashDigits/bashArith octal + `set -u` unbound-variable rules,
fnmatchToRegex/findFirstDir trajectory resolution, parseJsonLossless/RawNumber literal
preservation), refresh() map-reduce caching (episode/theme on-disk shapes, incremental resume,
the trailing-partial-episode-always-resummarized quirk, lock/stale-lock handling), text/json
output, `--context` rollups (block sealing, staircase assembly, `--backfill`/`--rebuild`,
incremental rendered.tsv append). Differential `parity/recap/run-parity.mjs` (real Bash
`bin/recap` vs the port, a deterministic fake `llm` stubbed identically on PATH for both sides
so map/reduce/rollup reply text is diffable byte-for-byte, not just structure): re-run against
upstream-next @ 5458fee during sync 1c (lane J), now 37/39 byte-identical
(stdout+stderr+exit+on-disk cache state) — the 2 remaining mismatches are the pre-existing
documented `${2:?}` deviation below (global/missing-flag-value, global/empty-flag-value). The
other 3 (`context-backfill-seals-tier1`, `context-two-tier-staircase`,
`context-rebuild-reseals`) were the drift flagged during lane J's sync: upstream's `f6f854c`
("outcomes not temperament") bumped `bin/recap`'s `ROLLUP_PROMPT_VERSION` 2→3 and reworded both
rollup-summary system prompts (`_WINDOW_SYSTEM`/`_ROLLUP_SYSTEM`, "events, not
character/temperament"). Lane K (sync 1c) ports this: `src/rollups.ts` `ROLLUP_PROMPT_VERSION =
3` + `ROLLUP_SYSTEM`, `src/recap.ts` `WINDOW_SYSTEM`, byte-identical to upstream-next's
`bin/recap:54,293-297,505-508` (test/rollups.test.ts, test/recap.test.ts — `PORT-NOTE (1c:
f6f854c)`); the frozen real-fixture parity test (pax 55fd5932-root, sealed under the historical
v2 prompt) now asserts the literal `2`, not the live constant, since sealed blocks are cached
forever and never re-stamped. Re-run against upstream-next's `bin/recap` confirms all three now
PARITY. INDEPENDENT ADVERSARIAL differential (`parity/recap/run-parity-adversarial.mjs`,
tester's own 145-scenario harness — flag misuse, corrupt/partial cache state, lock staleness
boundaries, adversarial trajectory content, `--context` tier boundaries, every env var, and the
exact `llm` argv+stdin bytes each side sends): 123 byte-identical + 22 documented deviations, 0
DIVERGE — after 4 real port bugs it found were fixed (F1–F4, "recap parity fixes" below) and
every remaining divergence got its own PARITY.md row. Reuses src/rollups.ts's pure
block/staircase math (buildPlan, resolveR, epochMin, planStaircase, resolveSegments) where
semantics match exactly; does NOT reuse rollups.ts's
renderStepText/renderSteps/buildRollups/recapContext, which differ from the Bash on jq
truthiness of empty-string `source`/`wake` (jq: truthy — recap.ts matches; rollups.ts's plain JS
truthiness does not), `//` on a `false`-valued field, `@tsv` backslash escaping, the jq
`input_line_number` quirk on an unterminated last line, and a corrupt `rollups/meta.json`
fallback (Bash/recap.ts: start 0; rollups.ts: "no meta" → start n) — see src/recap.ts's file
header for the full list.

### retrieval thinker (passive no-LLM recall; third thinker, opt-in)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

src/retrieval.ts + bin/retrieval-step.mjs. 56 unit tests: the 8-scenario Bash oracle
(tests/test_retrieval_thinker.sh) ported verbatim, index.tsv byte-equal to the real
build-index.sh over the 14 pax memories, no-op matrix, replicated quirks, golden replay,
topology with the third thinker (`reactive/observation:retrieval` wake). Differential
parity/retrieval: 31/31 over 3 sequences vs the real Bash step + 2 documented-deviation
scenarios; the upstream Bash suite drives bin/retrieval-step.mjs 17/17. Registered in
src/topology.ts behind `retrieval` config, default off (upstream ships the thinker with a
`disabled` marker) — the two-thinker tests are byte-identical.

### llm tool (all wire paths: openai, openrouter, opencode-go, openai-compatible, anthropic, gemini, opencode/Zen, adapter)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

148 unit tests (fake HTTP server + real Node adapter-fixture subprocesses, no network);
differential `parity/llm/run-parity.mjs` 220/220 effective vs real Bash `bin/llm` (203
byte-identical + 17 documented deviations, 0 port bugs) over stdout+stderr+exit+health
marker+ledger+usage file+temp cleanup+received requests — covers request wire body, headers,
auth, model rewrites, max_tokens, thinking/effort, streaming/non-streaming responses +
truncation, error/retry (including the anthropic `type:"error"` mid-stream fatal-event quirk),
and the adapter stdin/stdout/argv/deadline contract per provider (see "llm slice 2 parity fixes"
below for the 3 real port bugs it found and fixed). Independent ADVERSARIAL differential
(`parity/llm/run-parity-adversarial.mjs`, OpenAI-family only, raw-byte fake server, stdout bytes
+ stderr + exit/signal + sandbox bytes + requests) 278 scenarios: 235 byte-identical + 43
documented deviations, 0 DIVERGE — after 13 real port bugs it found were fixed (F1–F13, "llm
parity fixes" below) and every remaining divergence got its own row. Unblocks `mem search`
(`bin/llm` is a symlink to `bin/llm.mjs`; no Bash). Also verified against upstream's OWN
`tests/test_llm_adapter.sh` via `parity/upstream-tests/run.mjs`: 20/20 (was 4/20) — see "llm
slice 2 parity fixes". No open Gaps remain for the llm tool.

### daemon (src/daemon.ts + bin/dispatcherd.mjs)

- **Status:** green

- **Parity:** PARITY (adversarial)

- **Notes:**

resident per-identity loop: boot (pid/token/sub_map/traj_files/empty pending), tick (token guard
→ firePending → watchdogCheck → scheduledWakeCheck → prune step_pids → feeder poll), detached
step-per-wake, signal handling (deliberate_stop → exit 0; else last_signal + exit 130).
`dispatcher.log` text lines are verified BYTE-FOR-BYTE against the real Bash by the independent
adversarial harness (`parity/daemon/run-parity-adversarial.mjs`, `report-adversarial.md`) —
3-space sub-event indent, `fire pending -> name (type=T, active=N)`/`watchdog -> …`/`skip …
(self-trigger|self error)`/`pending … superseded (last-wins)`/`pending -> name (type=T,
queued=N)` lines, no invented `boot:` line. A record the dispatcher itself appends (the salience
`feedback` injection) is delivered through `Dispatcher.feed()` SYNCHRONOUSLY (not on the next
tick) so its log line lands in causal order — see Deviations "dispatcher event bus". Never
imports the engine. 7 tests (daemon.test.ts, incl. a byte-diff of a scripted
busy→queued→feedback→re-fire sequence against real-Bash-shaped text) against a real spawned
child + covered end to end by live-loop.test.ts.

### runstate (src/runstate.ts)

- **Status:** green

- **Parity:** 100%

- **Notes:**

the whole `run/` byte contract, one function per file, tmp+rename atomicity; `step_pids`
SPACE-separated (F2); `FilePendingStore` (message/action/rest firing order, FIFO cap 16
drop-oldest, coalesce last-wins); `pidAlive` (EPERM=alive); `killTree` (one `ps` snapshot,
depth-first). 30 unit tests, every writer's exact bytes pinned.

### feeder (src/feeder.ts)

- **Status:** green

- **Parity:** 100%

- **Notes:**

in-process replacement for `tail -F | dispatch.fifo`: opens at current EOF, fs.watch +
tick-poll, complete-lines-only with partial-line stitching, truncation restarts at offset 0,
ENOENT retried each poll. 8 unit tests.

### steprun (src/steprun.ts + bin/thinker-step.mjs)

- **Status:** green

- **Parity:** 100%

- **Notes:**

one wake end to end: IdentityConfig assembly (core_identity_prompt.md override,
buildSkillsPrompt, a `get_goals` port), a PLAIN FileTrajectory (never ObservableTrajectory),
selectSandbox, the real `llm` client (`LlmCliClient`) only, with no replay switch; tests point
`LLM_API_URL` at a local endpoint (`test/llmFakeServer.ts` via `test/llmScripted.ts`), as
upstream's `tests/test_llm_retry.sh` does, argv[0] dispatch to monolith/responder/retrieval. 12
unit tests + exercised live by live-loop.test.ts.

### identity (src/identity.ts + bin/identity.mjs)

- **Status:** green

- **Parity:** subset

- **Notes:**

`identity new` only (`import` is Slice C, SPEC-control-plane, out of this lane): full layout,
`info.txt` (`created=` is upstream's LOCAL no-ms/no-`Z` `iso_timestamp`, not
`Date#toISOString()`), root trajectory + 11 seed thoughts verbatim, monolith+responder installed
enabled, retrieval installed with its `disabled` marker + `prompt.md`/`stopwords`
(byte-identical text assets), `subscriptions.jsonl` reproducing the Bash injection loop's
double-newline quirk, `.retired_done` seeded, traj_id injection, default symlink.
`kernel/{mem,chat,goals}` and the 8 bundled `skills/*` are provisioned with copied `SKILL.md`
text (see Deviations "kernel/skills copied, not symlinked"); `thinkers/_lib/common.sh` and
`thinkers/retrieval/build-index.sh` (Bash) are never copied (see Deviations "Bash thinker
helpers omitted"). NO `activate` file (see Deviations). Verified against the real Bash
`tools/identity` by the adversarial harness's `identity-new` flow:
`stdout`/`stderr`/`exit-code`/a per-file tree diff all PARITY, the four DIRECTOR-decided path
classes above each their own DEVIATION row. 5 unit tests (identity-new.test.ts).

### identity list (src/identity.ts identityList + bin/identity.mjs list)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

Adds `identity list [-a]` to the `identity` module described in the row above (that row predates
this addition and still reads "`identity new` only" — this row is the update; port/identity-list
lane). Full port of `cmd_list`/`_identity_names` (tools/identity:945-995, :46-54): marker (`*`
for the `default` symlink target)/name/created/absDir columns; `-a`/`--all` show-dir mode;
`created=` with a `started=` fallback when `created` is empty or absent; hidden (dot-prefixed)
directories invisible (bash's non-dotglob `*/`  glob); the literal `default` entry excluded by
name; a non-identity directory (no `info.txt`) still listed with `created` `""`; a directory
symlink included, with `absDir` the lexical `cd`+`pwd` join (NOT a symlink-resolved realpath,
matching upstream); a dangling symlink excluded (fails `[[ -d ]]`); a dangling `default` symlink
itself produces no marker match and no crash; argv edge cases replicated exactly — extra
positionals and a `-a` arriving after the first positional are both silently ignored, matching
bash's arg loop breaking on the first non-flag. Ordering matches this environment's observed
`bash` glob sort — locale-aware (case-insensitive primary key: "alpha" < "Bravo" < "mike"),
reproduced with `String#localeCompare`, NOT a raw byte/code-unit sort; this is inherently
environment-dependent (neither `tools/identity` nor the Docker sandbox pins a locale for it —
see the code comment in `identityList`). 13 unit tests (test/identity-list.test.ts).
Differential `parity/identity/run-parity.mjs` (real Bash `tools/identity list` vs the port,
`.identities`-shaped fixtures — 0/1/3 identities, `created`/`started` fallback, a stray
non-identity dir, hidden dirs, a plain file, a symlinked dir, a dangling symlink, a dangling
`default`, mixed-case ordering, a >=20-char name, argv edge cases): 17/17 byte-identical
(stdout+stderr+exit), 0 DIVERGE — see `parity/identity/report.md`. Closes the TUI's
`/identities` gap: `tui/PARITY-RECEIPT.md`'s "Gap 1 (`/identities`) closed" heading has a live
run of `bin/identity list` against a real fixture using the exact env `resolveIdentityEnv()`
computes.

### identity import (src/identity.ts identityImport + bin/identity.mjs import + src/tar.ts)

- **Status:** green

- **Parity:** PARITY (structural)

- **Notes:**

Adds `identity import <file|-> [--name NEW]` to the `identity` module (routes-c lane; the two
rows above predate this addition and still read "`identity new`/`list` only"). Full port of
`cmd_import`/`_install_imported_identity` (tools/identity:706-810, 642-704): unsafe-path refusal
(`^/|^\.\.(/|$)|/\.\.(/|$)` against raw archive member names, checked before anything is
written), `manifest.json` `format` field checked (>1 refused as "newer than this tool
understands"), target-name resolution (`--name` for a single-identity archive, else
`manifest.json`'s `identities[].dir->name` map, else `info.txt`'s own `name=`, else the source
dir's basename) validated against the shared `IDENTITY_NAME_RE`, duplicate-target and
existing-name conflicts refused before any writes, `run/`/`.shellm/`/`kernel/`/`.env`/`activate`
stripped even if the archive carries them, live root-trajectory repair (a soul-only archive, or
one whose `root_trajectory=` trajectory file is missing, gets a fresh `createTrajectory` +
`subscriptions.jsonl` re-pointed at the new id — literal substring replace, matching the Bash
`sed`), dangling-symlink drop (`fs.existsSync` follows the link; a target that doesn't resolve
ON THIS HOST is removed, one that does is kept as-is), kernel skills always regenerated /
non-kernel bundled skills installed only if not already present (see Deviations table for the
two accepted differences: `activate` never written, kernel/skills copied not symlinked — both
inherited from `identityNew`, not new to this row). `src/tar.ts`: a minimal, dependency-free
(node:zlib for gzip) ustar/PAX/GNU-longname tar READER (+ a small ustar WRITER for test fixtures
only — this port never writes archives at runtime, `identity export` is unported) — verified
against real macOS bsdtar output for both short and long/PAX-header paths. 20 unit tests
(test/identity-import.test.ts, synthetic archives built with the writer): single/multi-identity,
rename, manifest name-mapping, every validation/conflict path, secrets/runtime-state stripping,
live-root repair + subscriptions re-pointing, dangling-vs-resolving symlinks. Differential
`parity/identity/run-import-parity.mjs` (real Bash `tools/identity export`+`import` vs the port,
fixtures built with the real `identity new`): 6/6 PARITY (exit code + imported-name
stdout-as-a-set + a structural directory-tree diff — content-hashed, ignoring the two accepted
`activate`/kernel-symlink deviations, and normalizing the two sides' independently-random
root-trajectory UUIDs before comparing, since two correct runs never share one) — see
`parity/identity/report-import.md`.

### identity export (src/identity.ts resolveExportDirs/buildIdentityExportArchive/defaultExportOutName + bin/identity.mjs export + src/tar.ts writer)

- **Status:** green

- **Parity:** PARITY (structural)

- **Notes:**

Adds `identity export [names...] [--all] [--path DIR] [-o FILE|-] [--soul-only] [--slim]` to the
`identity` module (routes-d lane). Full port of `cmd_export` + its helpers
(tools/identity:521-638, 423-519, 997-1025 `_resolve_identity_path`): dir resolution (bare name
exact-then-fuzzy-substring match, `--all` glob-excluding `default`, `--path`, bare-invocation
`default`-symlink resolution), duplicate-basename refusal, the
`run/`/`.shellm/`/`kernel/`/`thinkers/`/`.env`/`activate` prune list (thinkers/ handled
separately, see below), `--soul-only` (drops `trajectories/` entirely), `--slim` (`_SLIM_JQ`'s
cut-at-N-chars-with-truncation-marker for `shellm-run.command`/300 and `prompt.content`/600,
`_slim_redact`'s 6 API-key regexes, ported to JS string ops — verified byte-identical against
the real `jq`/`sed` pipeline), `manifest.json`
(`format`/`exported_at`/`soul_only`/`slim`/per-identity
`dir`/`name`/`created`/`root_trajectory`/`memories`(recursive `*.md` count)/`traj_steps`(`wc -l`
on the live, unslimmed trajectory file)), thinkers/ shipped DEREFERENCED (`cp -RL` equivalent —
a `--symlinks`-installed thinker's files travel as real files/dirs; a dangling symlink is
dropped, see Deviations), skills/ symlinks (NOT thinkers) preserved AS symlinks (bash's plain
`find`, no `-L`). `src/tar.ts`'s writer extended with PAX "path"/"linkpath" extended headers for
any name/linkname over the ustar 100-byte field (real trajectory paths can exceed it) —
round-trips through this port's own reader and verified against real macOS bsdtar (`tar -tvzf`).
26 unit tests (test/identity-export.test.ts: dir resolution incl. every error path, prune list,
manifest fields, soul-only, slim truncation+redaction on both a long and a short/un-truncated
key, thinkers deref incl. a dangling-symlink case, skills symlinks preserved, `--all`, real
file-mode passthrough) + 5 tar-writer tests (test/tar-writer.test.ts: short/long names, long
linkname, unicode, adjacent-entry corruption check). Differential
`parity/identity/run-export-parity.mjs` (real Bash `tools/identity export` vs this port's
`buildIdentityExportArchive` — the SAME library the web routes call — against the SAME
REAL-Bash-`identity new`-built source tree; both archives decoded with this port's own tar
reader and diffed as structured entry lists: entry set/type/mode/size/bytes/linkname, NOT raw
tar bytes): 6/6 PARITY
(name/`--path`/`--soul-only`/`--slim`-with-truncation-and-redaction/`--all`/bare-invocation-default-identity)
— see `parity/identity/report-export.md`. Documented allowances (see that harness's own header
comment): entry ORDERING not compared (bash `find`'s readdir order vs this port's sorted walk —
both valid), and `manifest.json`'s `exported_at` field not compared (independently generated
wall-clock timestamps, several seconds apart in a harness run).

### thinkersctl (src/thinkersctl.ts + bin/thinkers.mjs)

- **Status:** green

- **Parity:** PARITY (adversarial) + enable/disable

- **Notes:**

`start`/`stop`/`status`/`step`/`list`/`logs`, verified against the real Bash `bin/thinkers` by
the adversarial harness (2 DIVERGE, both cross-run environmental noise unrelated to this port —
`stop-all-default/stderr-text` and `misuse/stop-not-running-stderr` differ only in upstream's
`_warn_stray_tails` machine-wide `pgrep -f 'tail -n 0 -F'` picking up a `tail` feeder left
running by an UNRELATED concurrent parity-live run sharing this machine, confirmed via `pgrep
-fl 'tail -n 0 -F'`/`dispatcherd` resolving to a different sandbox's PIDs; every other check,
including all 12 new `identityDirOnly_*` ones below, is PARITY). `start`: boot-wait, wake-gap
note (failure-open); ONLY the named branch boot-kicks (writes a manual-trigger pending file) —
bare `start` (no names) never does, matching upstream's own quirk (bin/thinkers:1163-1221).
`step`: runs the thinker's `step` SYNCHRONOUSLY inline (not a pending file) — `Running
<name>/step ...` to stderr, the step's stdout+stderr merged and tee'd to both this process's
stdout and `run/logs/<name>.log`, exit code propagated; only checks the thinker dir exists and
`step` is executable (no disabled/subscriptions.jsonl gate, unlike `start`). `status`: rewritten
line-by-line against bin/thinkers:1435-1537 — blank line, `Concurrency: N max` only while
running, 30-col name padding, `[types]` bracket, log-line/pending-queue suffixes, disabled
thinkers never listed. `stop`: ppid-ancestry self-stop guard, drain-or-force, stop-all cleanup,
and (fixed in this lane — see "daemon-runtime gap fixes" below) runs a stopped thinker's own
`<thinker_dir>/stop` script at all four sites bin/thinkers does (`:1259`, `:1273`, `:1356-1357`,
`:1423,1425`), the drain sites via a detached `bin/thinkers-drain.mjs` child so the CLI still
returns immediately. Disabled-thinker error text names the real marker path (`Thinker 'X' is
disabled (remove <dir>/disabled to enable)`). `enable`/`disable` (SPEC-control-plane §D.2, D.4 —
Slice B) now SHIPPED: `thinkersEnable` unlinks `<tdir>/disabled`, reports `needsRestart` =
dispatcher running; `thinkersDisable` stops the thinker first unless it is already stopped or
already disabled (`stoppedFirst`), then touches the marker (create-if-missing, preserves
existing content — matches upstream `touch` semantics, not overwrite). Upstream `bin/thinkers`
has NO enable/disable subcommand at all (verified by reading the source — only a manual
`touch`/`rm` convention on the marker, already covered by
`checkThinkerNames`/`enabledThinkerNames`), so these two commands have no Bash CLI to
differentially test against; built directly from SPEC-control-plane.md §D.2/§D.4's own text plus
the existing marker semantics. `requireEnv` (shared by all six commands) now reproduces
upstream's FULL `_require_env` (bin/thinkers:138-155 — BUG #67, fixed completely, see
"daemon-runtime gap fixes" below), not just its `THINKERS_DIR`-exists tail:
IDENTITY_DIR/TRAJ_DIR/TRAJ_ID required-and-already-set checks, in that exact order, THEN the
IDENTITY_NAME/THINKERS_DIR fallback defaults, THEN `[[ -d "$THINKERS_DIR" ]]

### sub (src/sub.ts + bin/sub.mjs)

- **Status:** green

- **Parity:** 100% (19/19 differential)

- **Notes:**

Exact-string (literal, not regex) substitution in a file: `sub FILE OLD NEW`,
`--old-file`/`--new-file`, `--replace-all`, atomic temp+rename write. Byte-level (Buffer), not
string-level: OLD/NEW/FILE content are matched and spliced as raw bytes, matching awk's
`index()`/`substr()`. Two distinct trailing-newline rules reproduced exactly: `$(cat F)` for
`--old-file`/`--new-file` strips ALL trailing newline bytes; the FILE's own content
reconstruction (mirroring awk's line-record join) drops AT MOST ONE. The replace-to-empty quirk
is kept: if the result is empty, a trailing newline is NOT re-added even when the original had
one (bash's own `[[ -s "$tmp" ]]` guard). Mode preservation via `fs.chmodSync` (portable;
matches Headlong's real Linux-Docker runtime, where bash's GNU-only `chmod --reference` succeeds
— see the parity harness header for the macOS-dev-machine artifact this sidesteps). **PORT-NOTE,
corrects two upstream docs:** COMPLETENESS-AUDIT.md and REMEDIATION-LEDGER.md#15 both describe
`bin/sub` as "spawns a sub-trajectory / sub-agent" — reading the actual 169-line source shows no
such thing; it is purely a file-editing string-substitution CLI with zero model/LLM/trajectory
involvement. No LLM seam wired (steprun's model client), because the source needs none. 29 unit
tests + differential parity/sub 19/19 byte-identical (stdout+stderr+exit+target-file
mode+content) vs the real Bash `bin/sub`.

### headlong-killall (src/killall.ts + bin/headlong-killall.mjs)

- **Status:** green

- **Parity:** structural PARITY (7/7) + real-reaping proof

- **Notes:**

Panic-button process reaper, named `headlong-killall` (not `killall`) to match how the web
control layer invokes it (`headlong/web/src/headlong_web/control.py`: `TOOLS_DIR /
"headlong-killall"`) and SPEC-control-plane.md §D.4. Argv patterns adapted for the TS daemon
runtime's actual process shapes — `node .../bin/dispatcherd.mjs`, `node
.../thinkers/<name>/step` (the Node wrapper the daemon spawns per wake) and its nested `node
.../bin/thinker-step.mjs` child, `node .../bin/sub.mjs`, `node .../bin/chat.mjs`, `--web`'s
`web/server/src/index.ts` — in place of upstream's `bash <path>/(shellm|llm|chat|sub)` etc.
patterns, which have no TS-port equivalent (there is no separate long-running `shellm`
agent-loop process in this port; a thinker step embeds the whole wake in one Node process). Same
technique as upstream throughout: one `ps` snapshot, fixed-point descendant-tree expansion,
self+ancestor protection (with the same warning line, reworded for "thinker step" instead of
"shellm"), TERM then a 3s grace period then KILL, `docker rm -f shellm-<pid>` sandbox cleanup,
`shellm.broker=1` containers reported and never touched. STREAM CONTRACT verified against the
actual Bash source (not assumed): only `usage()` and the protected-ancestor warning go to
stderr; every report line — including "(dry run — nothing was killed)" — goes to stdout
(`tools/headlong-killall` has no `>&2` on any of those lines). `--help`/usage text is
byte-identical to the real tool (spot-checked). 15 unit tests spawn REAL decoy processes and
reap them for real, but scope `psSnapshot` (an injectable seam) to each test's own spawned pids
rather than the real unrestricted system scan — see the Deviations row below for why.
Differential `parity/killall` 7/7: `exact` scenarios (help/usage-error text) byte-diffed;
`structural` scenarios (`--dry-run` only) check exit code + the trailing dry-run marker + stream
routing, with the live process listing intentionally excluded from comparison (the two tools'
process universes are disjoint by construction, and even the bash side alone is nondeterministic
on a shared dev machine).

### sandbox-runtime (src/sandbox-runtime.ts + src/sandbox-env.ts)

- **Status:** green

- **Parity:** 100%

- **Notes:**

`selectSandbox`: `auto`→Docker when a daemon answers `docker info` (respecting
`SHELLM_ALLOW_NESTED_DOCKER`), else Local; identityDir+portHome bind-mounted, binDir on the
CONTAINER PATH; `forwardedEnv()` — the API-key/provider vars upstream forwards into a step's
exec env. **Bug #32 fix:** a PERSISTENT container per identity/env name (`shellm-<env>-<hash>`,
`node:24-bookworm` default image), reused across wakes when running and image-matching
(`sandbox-env.ts` `readEnvMetadata`/`envMetadataMatches`, metadata at
`<identityDir>/.shellm/envs/<name>/` = `SHELLM_ENVS_DIR`, matching `tools/identity:375,1381`) —
matching `thinkers/_lib/common.sh:372`'s `--env "${SHELLM_THINKER_ENV:-$IDENTITY_NAME}"` on
every wake and `bin/shellm`'s `env_resolve`/`env_register`. An image mismatch against a stored
env throws upstream's exact `die()` message (0925168's `env_metadata_mismatch_message`, image
branch). **Bug #55 fix:** the three remaining upstream pre-loop liveness checks
(`docker_container_has_unusable_tool_mounts`, `docker_container_can_reach_path`, the
container-exists check, bin/shellm:1320-1335, always upstream's `explicit=1` branch since every
wake names a concrete env) are now ported too — a stored env whose container is fully removed,
or whose real mounts don't cover this run's workdir, or whose tool shim went non-executable,
throws upstream's exact `die()` text (`containerCanReachPath`/`workdirNotMountedMessage`,
`containerHasUnusableToolMounts`/`staleToolMountsMessage` in `sandbox-env.ts`) BEFORE any model
call, instead of silently reattaching to a dead container and running the whole loop against it.
Only a container that is merely STOPPED (present, mounts fine, not running) still gets
upstream's own SILENT recreate. `cleanup()` is a no-op by default (persists) and only tears down
when `tempDocker`/`SHELLM_TEMP_DOCKER=1` is set (`--temp-docker` equivalent,
bin/shellm:2362-2364). `destroyIdentityContainers` (`sandbox-env.ts`) ports
`_destroy_containers` (tools/identity:56-65) for a future `identity delete`. Exercised by the
DockerSandbox test suite (pre-existing) + steprun/live-loop tests forcing `SHELLM_SANDBOX=local`
+ `test/sandbox-env.test.ts` (real docker, skips cleanly without a daemon): two-wake reuse via a
cross-step marker file + a single `docker ps` match, image-mismatch refusal (exact message
asserted), `--temp-docker` teardown, stale-metadata recreation, and `killall`'s real
(non-fixture) `docker rm -f` removing the container. **Deliberately not wired into `thinkers
stop`** — see the Deviations table below. `DockerSandbox.exec` (`src/sandbox-docker.ts`) is
unchanged here — the bug #33 inactivity-watchdog fix lives in `src/sandbox.ts`'s shared
`execWithInactivityWatchdog`, which both `LocalSandbox` and `DockerSandbox` now call; see the
"sandbox parity fixes" section below. **Bug #35 fix (RUNTIME-SEAMS.md §D item 4):** per-skill
env-var discovery + `--var` directory auto-mount, ported into a new `src/skill-env.ts`
(`collectSkillVars` = `collect_skill_vars`, thinkers/_lib/common.sh:315-346; `computeVarMounts`
= `_compute_var_mounts`, bin/shellm:739-747; `pathCovered` = `_path_covered`,
bin/shellm:893-900). `steprun.ts`'s `buildIdentityConfig` scans every installed skill's SKILL.md
frontmatter for a declared `env:` list and forwards each one that is set+non-empty in the
environment into the wake's `execEnv`, matching `_build_shellm_flags`'s trailing `--var
$vname=$vval` loop (common.sh:405-411) — both local AND Docker sandboxes see it, same as every
other forwarded var here. `startDockerSandbox` additionally bind-mounts (read-write, same
absolute path) any such directory-valued var not already covered by the identityDir/portHome
mounts, matching `bin/shellm:1013-1024`'s mount-building loop, and tracks the computed set in
env metadata (`sandbox-env.ts`'s `EnvMetadata.varMounts`) — a change since container creation
refuses reattach with upstream's exact `env_metadata_mismatch_message` var_mounts-branch text
(`varMountsMatch`/`varMountsMismatchMessage`), the same explicit-always-`die()` pattern bug
#32's image-identity check already established. **Deliberate scope decision, documented (not
invented):** this port's `var_mounts` tracking is scoped to skill-declared vars only —
upstream's own `_compute_var_mounts` also includes the built-in
`MEM_DIR`/`SKILLS_DIR`/`SKILLS_KERNEL_DIR`/`TRAJ_DIR`/`CHATRC` paths (they're always directories
too), but those are already provably covered by the identityDir rw mount by construction and
never change across wakes for one identity, so including them in the reattach-comparison set
would add real complexity for zero behavioral difference. A real byte-parity differential
(`parity/skill-env/run-parity.mjs`, sourcing the actual `thinkers/_lib/common.sh`/`bin/shellm`
functions) caught one real divergence before it shipped: `collectSkillVars` must NOT accept the
inline-JSON `metadata: {"shelllm": ...}` frontmatter form the way `bin/skills`'s own
`_extract_shelllm_meta` does — `collect_skill_vars` itself only ever matches an INDENTED `env:`
line, so it silently forwards nothing for a skill using only that form; `collectSkillVars` now
has its own narrow extraction matching `collect_skill_vars` exactly rather than delegating to
`skills.ts`'s (deliberately looser) `extractShelllmMeta`. 16 unit tests
(`test/skill-env.test.ts`), 2 new `steprun.test.ts` scenarios (a skill-declared var reaches the
exec env when set; not forwarded when unset), 2 new real-Docker `test/sandbox-env.test.ts`
scenarios (a `--var DATA_DIR=<dir>` directory is readable inside the container at the same path;
a var_mounts change refuses reattach with the exact message and never touches the running
container), differential `parity/skill-env/run-parity.mjs` 9/9 PARITY against the real Bash
functions. **Bug #70 fix (director-verified live run — `mem search` inside the sandbox got
`connect ECONNREFUSED 127.0.0.1:<port>` ×5):** upstream rewrites a loopback
`SHELLM_API_URL`/`LLM_API_URL` to `host.docker.internal` for a Docker sandbox's exec env
(`_shellm_container_api_url`, bin/shellm:216-221, applied at
bin/shellm:2659-2662/2679-2680/2712) and adds `--add-host host.docker.internal:host-gateway` to
the container it starts, gated on the same loopback predicate (bin/shellm:1026-1034) — this port
did both ONLY at install time (`src/init.ts`'s `localContainerUrl`, `src/install-lib.ts`'s
`dockerForwardArgs`), never at run time, so a step's sandboxed `llm`/`mem search` kept the
host-only loopback URL and failed to connect. Fixed in `src/sandbox-runtime.ts`:
`containerApiUrl` (reusing the shared `net-url.ts` `urlIsLoopback`/`urlHostSwap` helpers
`init.ts`/`install-lib.ts` already use) rewrites a loopback URL for the container;
`applyDockerApiUrlRewrite` is the single exported call `src/steprun.ts`'s `runStep` makes, right
after `selectSandbox` resolves `envType`, to rewrite ONLY `SHELLM_API_URL`/`LLM_API_URL` on the
step's `execEnv` and ONLY when running in Docker (a local step, and the host-side
`buildLlmClient` call, both keep the original URL — matching "the main shellm process keeps the
host URL", bin/shellm:2657-2658); `startDockerSandbox`'s fresh `docker run` gains `--add-host
host.docker.internal:host-gateway` under the identical predicate (`needsHostGateway`), so the
alias and the rewrite can never disagree, matching upstream's own comment to that effect.
**Scope note:** this port has no wired equivalent of upstream's process-vs-file endpoint-alias
canonicalization (`resolveShellmApiUrl` in `src/shellm.ts` remains unwired — see the "callout
(c)" entry above), so `SHELLM_API_URL`/`LLM_API_URL` are rewritten independently rather than
from one canonical value; identical to upstream whenever the two already agree (the common
case). Tests: `test/sandbox-runtime.test.ts` (rewrite matrix —
127.0.0.1/127.x/localhost/0.0.0.0/IPv6 `::1`/userinfo/port/path preservation/non-loopback
passthrough; `applyDockerApiUrlRewrite` local-vs-docker; `--add-host` present/absent via a fake
`docker` on 4 SHELLM_API_URL/LLM_API_URL combinations), `test/sandbox-runtime-docker.test.ts`
(REAL docker daemon: a host-loopback HTTP listener is unreachable from inside the container
using the unrewritten URL — curl's own connect-refused, exit 7 — and reachable via the rewritten
`host.docker.internal` URL through the `--add-host` alias), `test/steprun.test.ts` "a
Docker-mode wake sees LLM_API_URL rewritten to host.docker.internal in its sandboxed exec env"
(full `runStep` wiring against a fake `docker` on PATH, no daemon).
`parity/sandbox/run-parity.mjs`'s new `loopback-rewrite` scenario (see that file).

### identity-env (src/identity-env.ts)

- **Status:** green

- **Parity:** 100%

- **Notes:**

`resolveIdentityEnv`: the `activate` exports as a pure function (never writes `activate`, see
Deviations) + `.env` layering (identity → `~/.headlong/.env` → `~/.shellm/.env`, fill-missing) +
the PATH-shadow guard (our bin/ + node dir first). Exercised transitively by every daemon/CLI
test.

### GET /api/identities/:id/dispatch (web/server/src/dispatchLog.ts)

- **Status:** green

- **Parity:** PARITY

- **Notes:**

Port of `headlong_web/logs.py`
`parse_dispatch_log`/`_tail_lines`/`DISPATCH_STEP_RE`/`DISPATCH_FIRE_RE`: byte-equal event
objects (same keys/order), tail-only backward-chunked read (max_events=2000), partial-first-line
drop on a mid-file stop. Was previously a silent stub always returning `[]` (Thinkers page
showed "No dispatcher.log found." even with a real log on disk). Faithfully reproduces
DISPATCH_FIRE_RE's narrow match (only literal `dispatch -> `; `pending -> `/`fire pending -> `
fall to `kind:"other"`), verified against real upstream Python via `uv run`. 16 tests:
`web/server/test/dispatchLog.test.ts`.

### web control plane (web/server/src/{control,safety,envfile,thinker-sync,usage,exportJobs,push,webpushCrypto}.ts + router.ts mutations)

- **Status:** green

- **Parity:** subset (Slice A + B + most of C + export + push)

- **Notes:**

Turns the read-only viewer into a live console: `POST /api/identities` (201), `POST .../chat`
(200, empty/from_name 422), `POST .../thinkers/start|stop` (200, "no thinkers" 409,
`_checkedThinkerNames` 422/404/409, empty `names`→expand to all enabled so the boot-kick fires
for each), `POST .../thinkers/:name/step` (202, fire-and-forget), `POST
.../thinkers/:name/enable|disable` (200, stop-first/needs_restart semantics), `POST
/api/killall` (200 `{ok,dry_run,stdout,stderr}`, matching `control.py`'s
`killall`/`KillallBody`/the viewer's `KillallResult`; never passes `--web`), `_requireControls`
403 BEFORE identity 404, library errors → 409 `{message,stderr,exit_code}`.
`config.controls_enabled` flipped to the server's actual `--read-only`/`HEADLONG_READ_ONLY=1`
state. server.ts buffers/validates the JSON body (1 MiB cap → 413, malformed JSON → 400) ahead
of routing. Calls `src/{identity,identity-env,thinkersctl,chat,killall,llmCli,tar}.ts` DIRECTLY
— no subprocess for in-process calls, and where a real second OS process IS needed (recap, the
daemon) it's a detached `spawn(process.execPath, [<port .mjs>], {detached:true}).unref()`, never
Bash (see Deviations "web control plane: library calls, not subprocess CLIs"). **Slice C, now
real:** `GET`/`PUT`/`DELETE .../env` (envfile.ts: parse/upsert/delete + secret-peek redaction,
`overridden` flag against the root `.env`), `GET`/`POST .../thinker-sync` (thinker-sync.ts:
bundled-vs-installed diff + pull, subscriptions.jsonl/disabled preserved), `POST
.../recap/refresh` (202, spawns `bin/recap.mjs` detached, 409 on an existing `recap/.lock`),
`POST .../usage/refresh` (usage.ts: incremental mind-log+ledger offset cache, 202, 409 while
running — GET `.../usage` stays the pre-existing "not computed" stub, unchanged, matching GET
`.../recap`'s own precedent), `POST /api/llm-health/probe` (calls `runLlm` in-process,
`{ok,latency_ms,model,provider}` or `{ok:false,error}`), `POST /api/identities/import`
(server.ts raw-stream body: size cap + gzip magic bytes, `src/tar.ts`'s hand-rolled ustar/PAX
reader, `identity.ts`'s `identityImport` — unsafe-path refusal, manifest.json format check, name
resolution/conflicts, secrets/runtime-state stripped, live root-trajectory repair,
dangling-symlink drop, kernel/bundled-skills regeneration; differential-proven against the real
Bash `tools/identity export`+`import`, 6/6 PARITY, `parity/identity/run-import-parity.mjs`).
`control.killall` accepts injectable `psSnapshot`/`dockerListing` overrides (threaded through
`RouterCtx`, test-only) reusing `src/killall.ts`'s own seams, so route tests never touch a real
process or container. **Routes-d lane, now real:** `GET /api/identities/:id/export` / `GET
/api/export` (`control.ts` `buildIdentityExportBuffer`/`buildIdentityExportAllBuffer` call
`src/identity.ts` directly — no `tar`/`gzip` subprocess, the archive is built as an in-memory
`Buffer` and sent as the raw response body via a new `__raw_bytes` server.ts convention,
`Content-Type: application/gzip` + `Content-Disposition: attachment; filename=...`; see the
"identity export" module row for the exporter itself) and the export-jobs family
(`web/server/src/exportJobs.ts`: in-process job Map mirroring server.py's `export_jobs` dict —
`POST .../export-jobs` 202 (`setImmediate`-deferred build, matching upstream's detached thread
so the response reflects `status:"running"`), `GET .../export-jobs` list, `GET`/`DELETE
/api/export-jobs/:job_id`, `GET .../download` (409 while running); `EXPORT_JOBS_KEPT=5`
eviction; a job holds the built `Buffer` directly instead of an on-disk tmp file — no
`tar.unlink` cleanup needed, functionally identical bytes/headers/lifecycle from the HTTP
client's side, see PARITY.md "identity export" row and the Deviations table). **NONE of the
export routes are gated by `_requireControls`** (matching upstream's own comment: "Export stays
available in read-only mode... it doubles as the backup path") — this port's `handleGet` has no
controls concept at all (GETs are inherently non-mutating here) and the two export-jobs mutation
routes explicitly skip the `ctx.controlsEnabled` check every other mutation route has.
**Routes-d lane, also now real:** `GET /api/push/key` (a real VAPID public key, no longer the
empty-string stub), `POST /api/push/subscriptions` (422 on a non-`pwa-`-prefixed or
`CHAT_FROM_RE`-failing name, 422 on a non-`https://` endpoint, upsert-by-endpoint, returns the
per-name subscription count), `POST /api/push/unsubscribe` (`{ok:true, removed}` —
`removed:false` for an unknown endpoint is NOT an error, matching upstream) — both mutation
routes ARE gated by `_requireControls` (unlike export). See the "web push" module row for the
crypto/store/watcher itself. 151 tests: `web/server/test/controls.test.ts` (21) +
`web/server/test/controls-slice-c.test.ts` (20: env/thinker-sync/recap/usage/llm-probe
route-level) + `web/server/test/envfile.test.ts` (23 unit) + `web/server/test/import.test.ts`
(8: control layer + real HTTP raw-stream layer) + `test/identity-import.test.ts` (20 unit,
synthetic archives) + `web/server/test/export.test.ts` (16: direct export GET, all-identities
GET, export-jobs full lifecycle incl. 409s/404s/eviction/read-only-mode, real HTTP headers) +
`web/server/test/pushRoutes.test.ts` (13: key/subscribe/unsubscribe route-level) +
`web/server/test/e2e-live.test.ts` (1, full HTTP create→start→chat→reply+reactive-wake→2
spontaneous wakes→stop against a real spawned daemon, deterministic LLM replay, no network).
`/api/update` is still NOT implemented — see Gaps.


| **web push** (`web/server/src/{push,webpushCrypto}.ts`) | green | PARITY (crypto,
interop-proven) + faithful (watcher) | Port of `headlong_web/push.py`'s VAPID key store,
name-scoped subscription store, and `PushWatcher`. `webpushCrypto.ts` reimplements what upstream
gets from `py_vapid` (VAPID ES256 JWT, RFC 8292) and `pywebpush`/`http_ece` (RFC 8291
"aes128gcm" content encryption over the RFC 8188 record format) using `node:crypto` ONLY — no
new dependency. Read from the actual `py_vapid`/`http_ece` source (a scratch venv, never
installed into this repo) rather than assumed: PEM key format is PKCS8 (node:crypto speaks it
natively for EC keys); JWT signature is raw r\|\|s (`dsaEncoding: "ieee-p1363"`), not DER;
claims are JSON-serialized with SORTED keys and compact separators (py_vapid's own comment:
"chrome seems to require the claims to be sorted"); the aes128gcm record's `keyid` field carries
the SENDER's own ephemeral raw public point (RFC 8291's own convention, not empty as bare RFC
8188 would allow); node:crypto has no "import a raw EC point" API, so a minimal SPKI DER wrapper
is hand-rolled for both the VAPID public key and a subscription's `p256dh`. **Real
cross-language interop proof** (`parity/push/run-interop-proof.mjs`, driving a scratch Python
venv via `PARITY_PYTHON`, never a repo dependency): 6/6 PASS — a py_vapid-generated PEM loads
here with an identical b64url pubkey (and the reverse); a JWT signed here verifies with
`py_vapid.jwt.decode` (and the reverse, verified here via `node:crypto`); an aes128gcm payload
encrypted here decrypts with the real `http_ece.decrypt` against a Python-generated fake
subscriber's own keys (and the reverse) — see `parity/push/report.md`. `push.ts` itself:
`vapidPublicKey` (generate-on-first-use under `<root>/.web-push/vapid_private.pem`, mode 0600,
dir mode 0700), the subscription store (upsert-by-endpoint JSON file, same-dir tmp+rename,
`Path.with_suffix` quirk replicated — `subscriptions.tmp`, not `subscriptions.json.tmp`),
`notificationsFor`/`buildPayload` (160-char truncation with `…`, `pwa-`-prefix +
non-empty-content gate), `sendWebPush` (ttl=0, aud auto-computed from the endpoint's own
scheme+host, 12h exp, `status > 202` failure check — matching pywebpush's own slightly-unusual
threshold exactly), and `PushWatcher`/`startPushWatcher` (byte-offset trajectory-file tailing,
complete-lines-only, dead-subscription pruning on 404/410, `setInterval` standing in for
upstream's `threading.Thread` — wired into `index.ts` exactly where `cli.py`'s `_run_production`
starts it: `if (!readOnly) startPushWatcher(root)`). 45 unit tests
(`web/server/test/webpushCrypto.test.ts` 16, `web/server/test/push.test.ts` 29: store I/O,
notificationsFor/buildPayload including the Python-`None`-in-an-f-string `tag` quirk,
sendWebPush against a fake endpoint that decrypts the request with a fake subscriber's own keys
— proving the payload round-trips, no live push — and PushWatcher end-to-end against a real
trajectory.jsonl file). See Deviations for the `setInterval`-vs-thread and
in-memory-vs-py_vapid-file-lock notes. |
| **self-update** (`web/server/src/selfUpdate.ts` + `router.ts` `POST /api/update`) | green |
PARITY | Port of server.py's `self_update` route (`server.py:235-287`) plus its two small
helpers `_git_info` (`68-84`) and `_schedule_restart` (`61-66`): resolved once at server startup
(`server.ts createApiServer`, matching upstream's own "the code can't change under a running
server" comment) rather than per-request. `POST /api/update`: `_requireControls` 403 first, then
`HEADLONG_WEB_SELF_UPDATE=1`(`getenv`, HEADLONG_*/SHELLM_* fallback)-and-`!readOnly` gate (403
"Self-update is disabled..." otherwise), a process-wide non-reentrant lock (409 "Update already
in progress" on a concurrent call — held forever on a successful update, "by design", since the
process is about to restart), a real `git -C <repoRoot> pull --ff-only` (180s timeout; a genuine
nonzero exit — e.g. `--ff-only` refusing diverged history — maps to 409 `{message: <last stderr
line>, stderr}`; a true spawn failure or timeout maps to 500 `git pull failed: ...`),
commit-before-vs-after comparison (`updated:false` on a no-op pull), `rmSync` on the
built-frontend dir on a real update (`ignore_errors=True` equivalent — best-effort), and a
`scheduleRestart` call (SIGTERM after 750ms, unref'd, injectable for tests) instead of
upstream's own `threading.Timer`. `GET /api/config`'s
`self_update_enabled`/`git_commit`/`git_branch` fields (previously hardcoded
`false`/`null`/`null`) now reflect the real startup-resolved values. 18 tests
(test/selfUpdate.test.ts) against REAL scratch git repos (a bare "origin" + working clones,
never this checkout) — real fast-forward pulls, a real `--ff-only` divergence failure,
concurrent-call locking, up-to-date no-ops, both route-level and library-level. |
| **tui** (`tui/headlong`, Rust, `headlong-tui`) | kept native | verified | Per this port's
Rust-stays-native rule, upstream's `tui/` is vendored VERBATIM and UNMODIFIED (not reimplemented
in TypeScript) — `cargo build --release` succeeds unmodified (cargo 1.96.1). It touches no
identity files itself; every mode shells out to this port's
`bin/traj`/`bin/chat`/`bin/thinkers`/`bin/identity`/`bin/skills` on `PATH`, using the env
`resolveIdentityEnv()` derives. Verified headlessly (pty + `pyte` terminal emulation, no `tmux`
on this machine) against a live identity (`quill`) written entirely by this port's engine, with
its own dispatcher running: `chat` mode rendered quill's real `message` steps via `traj cat`,
`thinkers` mode rendered live dispatcher/thinker status via `thinkers status`, `traj` mode
streamed live reasoning/shell-output steps via `traj tail -r -n 50`, and `/skills` rendered
quill's real skills via `skills list`. See `tui/PARITY-RECEIPT.md` for the full transcript and
the one confirmed gap below. |
| **telegram bridge** (`src/telegram/*.ts` + `bin/headlong-telegram-bridge(.mjs)`) | green |
PARITY | Full port of `headlong/telegram` (Python, `headlong_telegram`): `config` (env +
`.identities`/`default`-symlink identity resolution), `naming` (`telegram-<user>-<chat>`
chat-`from` encoding), `tgfmt` (markdown→Telegram-HTML, code-span preservation, sender-label
sanitization, paragraph/line/hard chunking at 3900 chars), `allowlist` (approved/denied/pending
JSON persistence, 24h pending-renotify window), `api` (`Bot`, every call→`result` or throws),
`mindlog` (byte-offset trajectory follow, copied from the Slack bridge upstream too — kept in
sync per its own docstring), `inbound` (DM-only gate, admin commands, dedup, delivery+retry),
`outbound` (trajectory→Telegram, `source:"chat"` gate, allowlist gate both directions,
HTML→plain fallback), and `cli` (argv/env parity with `cli.py` + the Bash launcher's local-dev
`.env` loading — the launcher's checkout-root-discovery/`uv run --project` exec has no analogue
in this single-repo port, not replicated). Zero Bash, zero Python, zero new runtime deps (Node's
built-in `fetch`/`AbortSignal.timeout` stand in for httpx). Every upstream test in
`telegram/tests` (40 cases: naming 4, tgfmt 8, allowlist 7, api 4, config 5, outbound 2, inbound
10) ported to vitest with the same cases and assertions; +22 supplemental cases for
`mindlog`/`state`/`cli`, which have no upstream test files (`test/telegram-*.test.ts`).
Differential `parity/telegram/run-parity.mjs`: real Python (`uv run` against the oracle's
`telegram/` project, unmodified) vs the port, driven identically against one fake Telegram Bot
API + fake `headlong-web` `/chat` endpoint (`fake-server.mjs`) — 15/15 scenarios PARITY (100%),
0 port bugs found, covering the admin approve/deny/revoke/list flow, stranger pending +
one-prompt-per-day, group-chat drop+leave, media/bot drop, message_id dedup, `/start`, malformed
admin usage, a multibyte+hostile-name delivery (proved byte-identical outbound JSON, not
assumed), the real getUpdates poll loop + offset persistence, and 5 outbound scenarios
(chat-sourced delivery, non-chat-source drop, unapproved-recipient drop, long-reply chunking,
HTML-send-failure→plain-text fallback) driven against a REAL seeded `trajectory.jsonl` via the
real `mindlog` module on both sides. See that harness's own header comment for its design
(module-level driving of `Inbound`/`outbound.run` rather than the long-poll CLI binary itself,
since neither language's real entry point has a bounded-exit knob; the Bot-API relay technique —
the Python side reaches the fake server the same way the oracle's OWN
`tests/test_api.py`/`tests/test_inbound.py` already do, by swapping `Bot._client` for an
`httpx.MockTransport`, with the handler relaying over a real HTTP call instead of answering
in-process). **The live leg is deferred**: no real Telegram bot token is available in this
environment, so this harness (and this port) has never made a real call to `api.telegram.org` —
see Deviations below for the adaptations this lane made. **Upstream sync 1c, lane H** (7d29f9e →
5458fee, PR #84 `06f1588..9a62727` squashed plus `44fe2f4`): send chat files as documents/photos
(`filepayload.ts`, new — `filePayload`/`fileSignature`, PNG/JPEG magic-byte detection, the
`file` alias rejected, caption/text leak-filtering via `stripLeakedCommand`, capped at 1024
chars), `api.ts` gains `sendDocument`/`sendPhoto` (multipart/form-data over `fetch`'s
`FormData`/`Blob`, Node has no `httpx`-style `files=` kwarg), `outbound.ts` gains the
file-payload branch (photo-then-document retry on `ApiError`, a `(failed to deliver file
<name>)` notice when both the primary send AND the retry fail, `RecentPosts` dedupe keyed by
`fileSignature` for files instead of raw text), a Slack-only `reaction` step is dropped before
reaching Telegram, and a non-DM (`conv.user !== conv.chat`) destination is dropped. Non-string
`content` (a legacy file step with object/array content) is treated as a decode error instead of
throwing (21c62ba). `cli.py`'s bot-token log redaction (44fe2f4) has a narrower TS surface — see
`logging.ts` and the Deviations table. 15 new unit tests (`test/telegram-filepayload.test.ts`),
4 new (`test/telegram-logging.test.ts`), 12 new `test/telegram-outbound.test.ts` cases, 3 new
`test/telegram-api.test.ts` multipart-wire-format cases — 95 telegram unit tests total across 12
files. `parity/telegram/run-parity.mjs` extended with 9 new "outbound" scenarios
(document/photo/JPEG sends, photo-failure-retries-as-document,
file-send-failure-falls-back-to-notice, undecodable-content_b64-falls-back-to-notice,
identical-file-steps-deduped, group-chat-destination-dropped, slack-reaction-step-not-posted)
plus a multipart-aware body comparator (`parseMultipart` in run-parity.mjs, `bodyBase64` in
fake-server.mjs — httpx and Node's fetch/undici each generate their own multipart boundary
string, so raw-text body comparison would never match even for semantically identical requests;
parsed fields/filenames/bytes are compared instead) — re-run against upstream-next (`5458fee`)
at 24/24 PARITY (was 15/15; all 15 pre-existing scenarios unchanged and still green). |
| **slack bridge** (`src/slack/*.ts` + `bin/headlong-slack-bridge(.mjs)`) | green | PARITY
(module-level; live Socket Mode leg deferred) | Full port of `headlong/slack` (Python,
`headlong_slack`): `config` (env + `.identities`/`default`-symlink identity resolution,
`SLACK_CLI_XOXB`/`XAPP` fallbacks, `SLACK_THREAD_FOLLOWUPS`), `naming`
(`slack-<user>-<channel>[-<thread_ts>]` chat-`from` encoding), `slackfmt` (markdown→Slack
mrkdwn, code-span preservation, entity/link cleanup, paragraph/line/hard chunking at 3900
chars), `mindlog` (byte-offset trajectory follow — identical logic to `src/telegram/mindlog.ts`,
mirroring upstream's own "copied from headlong_slack.mindlog, keep in sync" relationship between
the two Python packages), `state` (`Deduper` bounded event-id set, `ActiveThreads`
persisted-with-TTL thread-followup set), `inbound` (`SlackNames` display-name/place cache, the
`_on_event` gate — bot_id/subtype skip, DM vs. mention vs. thread-followup routing, dedupe — and
delivery+retry+Slack-error-fallback), `outbound` (trajectory→Slack, `source:"chat"` gate,
markdown conversion, `RecentPosts` dedupe, per-chunk-failure-breaks-the-loop — no HTML/plain
fallback branch here, unlike telegram, because Slack's `chat.postMessage` `text` field has no
separate parse-mode failure mode to fall back from), and `cli` (argv/env parity with `cli.py` +
the Bash launcher's local-dev `.env` loading, same pattern as telegram's `cli.ts`).
`headlong_slack` itself has NO `api.py`/Socket-Mode module of its own — it is a pure client of
the `slack_bolt`/`slack_sdk` pip dependency — so this port adds two from-scratch,
dependency-free modules with no direct upstream file to port 1:1: `api.ts` (a `WebClient` over
`fetch`, wire format read directly from the installed `slack_sdk` source — see
parity/slack/run-parity.mjs's header for the JSON-vs-form-encoding split it found) and
`socketmode.ts` (a Socket Mode transport over the native `WebSocket`, implemented from Slack's
public protocol description, not from `slack_bolt`'s source). Zero Bash, zero Python, zero new
runtime deps. Every upstream test in `slack/tests` (25 cases: naming 4, config 5, mindlog 5,
slackfmt 9, outbound 2 — the run-filters-by-`source` case plus `test_recent_posts_dedupe`, moved
here from `test_slackfmt.py` to sit next to the `RecentPosts` class it exercises, matching where
telegram's port put its own analogous case) ported to vitest with the same cases and assertions,
plus 50 supplemental cases (4 more config cases, 3 more outbound cases, and the whole of
`inbound`/`state`/`api`/`socketmode`/`cli`, which have no upstream test files at all) —
`test/slack-*.test.ts`, 75 total. Differential `parity/slack/run-parity.mjs`: real Python (`uv
run` against the oracle's `slack/` project, unmodified) vs the port, driven identically against
one fake Slack Web API + fake `headlong-web` `/chat` endpoint (`fake-server.mjs`) — 15/15
scenarios PARITY (100%), 0 port bugs found, on the first real run, covering
DM/mention/thread-followup routing, dedupe, bot_id/subtype drop,
delivery-retry-then-Slack-error-fallback, an unsanitized hostile-display-name delivery (Python
has no name sanitization in the header-assembly path either — reproduced faithfully, not fixed),
and 5 outbound scenarios (chat-sourced delivery, non-chat-source drop, chunking, a
`chat.postMessage`-failure breaking the chunk loop, `RecentPosts` dedupe). See that harness's
own header comment for its design (module-level driving of `Inbound._on_event`/`.onEvent` and
`outbound.run` rather than the Socket-Mode-blocking CLI binary itself; no relay was needed for
the Slack Web API leg — unlike telegram's Bot-API relay — because `slack_sdk.WebClient` takes a
`base_url` constructor argument, found by reading its source directly). **The live Socket Mode
leg is deferred**: no real Slack bot/app-level token is available in this environment, so this
harness (and this port) has never made a real `apps.connections.open` call or held a real
WebSocket connection to `slack.com` — `socketmode.ts`'s transport logic is exercised only
against a fake `WebSocket` in `test/slack-socketmode.test.ts` — see Deviations below for the
adaptations this lane made. |
| **init** (`src/init.ts` + `bin/headlong-init.mjs`) | green | PARITY (deterministic paths) |
Full port of `tools/headlong-init`'s bootstrap flow: the Docker sandbox consent gate
(`HEADLONG_FAKE_DOCKER=ok\|down\|missing`, `HEADLONG_UNSANDBOXED` persistence + sticky-choice,
`--dry-run`, in-container auto-bypass), cloud API-key resolution
(`_have_key`/`_key_var_for`/`_default_model_for`/prefix-based `_reconcile_key_vars`,
hidden-input `_prompt_key` with the OpenAI-vs-OpenCode disambiguation, 3-attempt
revalidation-vs-first-run distinction), the local OpenAI-compatible endpoint flow
(`_local_base_url`/`_local_chat_url`/URL-safe-display/host-swap helpers now shared with
install.mjs in `src/net-url.ts`, `/v1/models` probing, model-id shell-metacharacter validation,
`host.docker.internal` rewriting for both host and full-container installs, local-to-cloud
switch staging + `_commit_local_wipe` only after a real validate), the identity interview +
LLM-authored persona (starter template asset added at
`src/assets/identities/starter-persona.md`) with placeholder-substitution fallback,
first-memories, `thinkers start monolith responder` (in-process `thinkersStart`, not a
subprocess — same function `bin/thinkers.mjs` itself wraps), the dash, and `status.json`. 28
unit/integration tests (`test/init.test.ts`) covering every scenario in
`tests/test_sandbox_gate.sh` and `tests/test_local_llm_setup.sh` with a real local HTTP server
reached via `fetch()`. Differential `parity/init/run-parity.mjs` (real Bash
`tools/headlong-init` vs the port, both under `HEADLONG_NO_TTY=1 HEADLONG_NO_THINKERS=1
HEADLONG_NO_DASH=1`): 7/7 executable scenarios PARITY, 0 PORT-BUG (sandbox-gate matrix + a
dead-endpoint scenario); 3 scenarios needing the fake local-provider server are SKIPPED — this
sandbox's subprocess `curl` cannot reach even a loopback HTTP server (confirmed separately: this
same script's own `fetch()` reaches the identical port fine), and the real Bash's local-provider
path shells out to curl, so those 3 scenarios cannot execute here — the SAME code path is
exercised end-to-end (real server, real fetch) by `test/init.test.ts`'s own local-provider
tests. Also run via `parity/upstream-tests/run.mjs --installer`: `tests/test_sandbox_gate.sh`
26/26 full parity against the port (see the Installer lane section of
`parity/upstream-tests/report.md`). Deviations (all documented at the call site in
`src/init.ts`'s file header and PARITY-noted below): no curl auth-tempfile (fetch takes a Bearer
header directly); `persona` is not shipped by this port, so `_link_persona_command` is a no-op
and the summary's `persona <name>` command names a tool this port doesn't ship yet (see Gaps);
the dash is `node web/scripts/dev.mjs` (API + Vite viewer) rather than upstream's
`headlong-web`, with its own dependency-bootstrap and readiness-detection text;
`identity`/`thinkers` are called in-process rather than as PATH subprocesses. |
| **install** (`install.mjs` + `src/install-lib.ts`) | green | PARITY (checkout mode +
local-repo bootstrap) | Full port of `install.sh`: checkout mode (`node install.mjs [options]`)
and the one-liner bootstrap (`curl -fsSL <url>/install.mjs \| node - [options]`, clone to
`$HEADLONG_HOME/app` then re-exec `--symlinks --init`), `--symlinks`/copy install of this port's
16 `bin/` CLIs (not upstream's list — see Deviations), a Rust TUI build when `cargo` is present,
`app_dir` recording, PATH detection/rc-file offer/shadow-warning
(`_ensure_path`/`_warn_shadowed`), and the whole-agent-in-Docker menu
(`_offer_docker_install`/`_location_offer_available`) including `_docker_forward_args`'s
secret-argv hygiene — provider/local-server keys and the (possibly
`host.docker.internal`-rewritten) local server URL are forwarded to `docker run` by bare NAME,
resolved from the spawned docker process's OWN environment, never inlined into its argv,
matching `tests/test_install_secret_argv.sh`'s pinned rule. 16 unit tests
(`test/install-lib.test.ts`), including a real `git clone --branch` against a local repo (no
network) proving the bootstrap plan end to end, plus a manually-verified real piped run (`cat
install.mjs \| node - --no-init`) against a local clone at a non-default branch, matching
`smoke_install.sh`'s one-liner-mode shape. `install.mjs` itself is deliberately import-free
until a real checkout is confirmed on disk (see its file header) — `node -` (piped stdin) has no
real file location for a relative import, so the bootstrap phase duplicates a minimal inline
`git clone` rather than importing `src/install-lib.ts` (which IS reachable, and is what the
re-exec'd checkout-mode run uses for everything else). Also run via
`parity/upstream-tests/run.mjs --installer` against `smoke_install.sh`/`test_uninstall.sh` — see
Gaps for the resulting real, documented deviations (no global skills/thinkers staging) and the
two scratch-technique artifacts (bash-source-array-literal checks, no-`.git`-in-scratch clone
failures) that are not port bugs. |
| **status** (`status.mjs` + `src/status-lib.ts`) | green | PARITY | Full port of `status.sh`'s
read-only report: checkout/commit/dirty-count, state-home `.env` key names + `SHELLM_MODEL`,
tool count in `PREFIX`, PATH detection, per-identity mind status (`run/dispatcher.pid` liveness)
with the default marked, dash status + URL, matching processes on the machine, and the commands
available from this shell. No prompts, no mutation, no network. 5 unit tests
(`test/status-lib.test.ts`). `status.mjs` resolves a real checkout on disk (self dir, then
`$HEADLONG_HOME/app_dir`, then `$HEADLONG_HOME/app`) and dynamically imports `src/status-lib.ts`
from that ABSOLUTE path, so the piped one-liner works from any cwd, not only from inside a
checkout — same technique `uninstall.mjs` uses. `PATTERNS`/`DASH_PATTERN` (in
`src/status-lib.ts`, reused by `uninstall-lib.ts`) reflect this port's actual process shapes
(`node .../bin/dispatcherd.mjs`, `node .../thinkers/<name>/step`, `node
.../web/scripts/dev.mjs`) rather than upstream's — there is no `traj tail`/`tail -F` subprocess
to match at all (the daemon's `TrajFeeder` tails in-process, see the daemon module row). |
| **uninstall** (`uninstall.mjs` + `src/uninstall-lib.ts`) | green | PARITY | Full port of
`uninstall.sh`, the reverse of install.mjs: discovers what's installed, stops matching processes
(SIGTERM then a 2s grace period then SIGKILL, reusing status-lib's process patterns), lists what
will be removed, confirms, removes the state home / tool links (including persona-pointing
symlinks) / the PATH line, and backs up (or `--delete-identities`) the identity tree — with a
checkout NOT under `$HEADLONG_HOME` (a user's own clone) and its `.identities` left untouched,
matching upstream's `_app_is_ours` rule exactly.
`--yes`/`--keep-identities`/`--delete-identities`/`--dry-run`/`--no-stop`/`--prefix`/`--help`
all ported; a no-tty run with no `--yes` refuses (matching upstream's `die`). 12 unit tests
(`test/uninstall-lib.test.ts`) mirroring every numbered scenario in `tests/test_uninstall.sh`
(dry-run listing, the real removal + idempotent "nothing to do" re-run, `--delete-identities`, a
user-owned checkout left alone, no-tty refusal, `--help`). Same real-checkout-discovery +
absolute dynamic import as `status.mjs`; with no checkout found anywhere it still does a
self-contained PREFIX-only "nothing to do" check inline (`uninstall.mjs`'s own header). Also run
via `parity/upstream-tests/run.mjs --installer` against the real `tests/test_uninstall.sh`:
mostly parity, 2 port-only failures both root-caused as scratch-technique/bash-artifact
limitations already precedented for `test_status.sh` (`--daemon` lane), not port bugs — see
`parity/upstream-tests/report.md`'s Installer lane section. |

