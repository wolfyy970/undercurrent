# PARITY — Headlong Bash → TypeScript (reference port)

Release: Undercurrent v0.1.0 (2026-10-29), upstream pin `2e39a3f`; whole-suite numbers in `docs/GUIDE.md` "Tests and parity" and CHANGELOG.md. The "Updated" notes below are the history.

Updated: 2026-09-02 — Phase 1a (every web route real) and Upstream sync 1b (installer, conversation memory, llm+shellm, web-ui lanes — see "Upstream sync 1b" below) are both complete; bug #32 (persistent per-identity Docker container reuse, see "container-lifecycle fix + deviations" below) and bug #37 (monolith run-failed fallback's missing `rc` field + uncaught thrown-error gap, see "monolith reactive coupling" above) have landed since. Source of truth for what is ported, verified, and known to differ. Whole-repo suite (`DOCKER_CONTEXT=colima pnpm vitest run`): **1650 tests pass, 4 skipped** across 84 test files (83 passed, 1 skipped).

**Pinned upstream base: 2e39a3f (was 5458fee, before that 7d29f9e) — see "Upstream sync 2e39a3f" below.** Updated 2026-10-27.

If not listed under Deviations or Gaps, it is expected to behave like the source.

## Scope and known gaps

Verified against `git ls-files` / `git grep` on this checkout at `main` `65d94d1`, not against old numbers. This section is the honest top-level map; the module table and Gaps section below carry the detail and proof pointers.

**Ported** (Bash engine, tools, thinkers, web control plane, TUI kept native):

- The dispatcher/thinkers engine, the CLI tools (`traj`, `chat`, `mem`, `skills`, `recap`, `llm`, `identity`, `thinkers`, `headlong-killall`, `context`) — see the module table below for per-tool parity level and differential proof. `sub`, `put`, `view`, `glob`, `focus` were retired 1c (12ca841, upstream drops all five) — see "Retired: focus/glob/put/sub/view (1c: 12ca841)" below; their historical rows are kept, not deleted.
- The web control plane (`web/server/src/{control,safety,envfile,thinker-sync,usage,exportJobs,push,webpushCrypto,selfUpdate}.ts`, `router.ts` mutations) — every web route is now real; `POST /api/update` (self-update) closes the last gap: `POST /api/identities`, `.../chat`, `.../thinkers/start|stop`, `.../thinkers/:name/step|enable|disable`, `POST /api/killall`, `PUT`/`DELETE .../env`, `.../thinker-sync` GET+POST, `.../recap/refresh`, `.../usage/refresh`, `POST /api/llm-health/probe`, `POST /api/identities/import`, `POST /api/push/subscriptions`, `POST /api/push/unsubscribe` are real and mutate identity state (or, for probe, make one real LLM call), gated by `_requireControls`. `GET /api/identities/:id/export`, `GET /api/export`, the export-jobs family (`POST .../export-jobs`, `GET .../export-jobs`, `GET`/`DELETE /api/export-jobs/:job_id`, `GET .../download`), and `GET /api/push/key` are real too, and — matching upstream — NOT gated by `_requireControls`. See the "web control plane" and "web push" module rows below.
- `tui/` (Rust `headlong-tui`) — kept **native**, vendored **verbatim and unmodified**, not reimplemented in TypeScript, per this port's Rust-stays-native rule. Proof: `tui/PARITY-RECEIPT.md` (headless run against a live identity written entirely by this port's engine).
- The **installer scripts**: `tools/headlong-init` → `src/init.ts` + `bin/headlong-init.mjs`, `install.sh` → `install.mjs` (+ `src/install-lib.ts`), `status.sh` → `status.mjs` (+ `src/status-lib.ts`), `uninstall.sh` → `uninstall.mjs` (+ `src/uninstall-lib.ts`) — see the init/install/status/uninstall module rows below. Two ARCHITECTURAL differences from upstream (not stubs — see Gaps): this port's `identity new` bundles skills/thinker templates directly, so `install.mjs` never creates `~/.skills/core-skills` or `~/.headlong-thinkers`; and `persona` (the per-identity command wrapper) is not shipped at all.

**Bridges ported, live leg deferred:**

- The Python **Slack bridge** is now ported (`src/slack/`, `bin/headlong-slack-bridge(.mjs)`) — see the "slack bridge" module row below and `parity/slack/` for the differential proof. The live leg (a real Slack app connecting Socket Mode to `slack.com`) is NOT exercised anywhere — no Slack bot/app-level token is available in this environment; the differential harness proves parity against a fake Slack Web API instead, and `socketmode.ts`'s transport is exercised only against a fake WebSocket in a unit test (see that module row).
- The Python **Telegram bridge** is now ported (`src/telegram/`, `bin/headlong-telegram-bridge(.mjs)`) — see the "telegram bridge" module row below and `parity/telegram/` for the differential proof. The live leg (a real bot token calling the real `api.telegram.org`) is NOT exercised anywhere — no Telegram bot token is available in this environment; the differential harness proves parity against a fake Telegram Bot API instead (see that module row).

**Not ported at all** (confirmed absent from this checkout by `git ls-files`, not required for a reference port — see "Upstream sync 1b" → "Not carried, by decision" below):

- The **macOS app** (upstream `macos/`) — not vendored, not reimplemented.
- **`deploy/`** (upstream systemd units, Terraform, bootstrap scripts) — not ported; this port ships no deployment tooling.

**LLM providers: all ported.** `src/llmCli.ts`'s `<provider> provider wire path not yet ported` die is now unreachable in practice — every provider `--provider`/`LLM_PROVIDER` documents is wired: `openai`, `openrouter`, `opencode-go`, `openai-compatible` (`src/llmProvider.ts` `OPENAI_FAMILY`), plus `anthropic` (`claude-*`), `gemini` (`gemini-*`), `opencode` (Zen, `opencode/*` — distinct from `opencode-go/*`), and `adapter` (the `LLM_ADAPTER` exec seam). This is the llm-providers lane (not an Upstream-sync-1b triage lane — a pre-existing gap in the port's own coverage, closed independently): see "Deviations" → "llm slice 2 parity fixes" below, `parity/llm/run-parity.mjs` (33+3 new scenarios, 220/220 effective, 0 port bugs), and `parity/upstream-tests/run.mjs`'s `test_llm_adapter.sh` (4/20 → 20/20).

**Web routes returning 501: NONE — this list is now empty.** (`web/server/src/router.ts`'s mutation catch-all at the bottom of `handleMutation` is still real code, reachable only by a route this port has never heard of at all — there is no longer any KNOWN upstream route that falls into it.) `POST /api/killall` (router.ts:554-563) is real, wired to `src/killall.ts`, returning `{ok, dry_run, stdout, stderr}`; `PUT`/`DELETE /api/identities/:id/env`, `.../thinker-sync` (GET+POST), `.../recap/refresh`, `.../usage/refresh`, `POST /api/llm-health/probe`, `POST /api/identities/import`, `GET /api/identities/:id/export`, `GET /api/export`, `POST /api/identities/:id/export-jobs`, `GET .../export-jobs`, `DELETE /api/export-jobs/:job_id`, `GET /api/export-jobs/:job_id`, `GET /api/export-jobs/:job_id/download`, `GET /api/push/key`, `POST /api/push/subscriptions`, `POST /api/push/unsubscribe`, and `POST /api/update` are all real — see the "web control plane", "identity export", and "web push" module rows, and the "self-update" row.

**In-process bus gap (thoughts → retrieval)**: **resolved for the real daemon** — `src/daemon.ts`'s `TrajFeeder` tails the trajectory file directly, so it sees every append (including the monolith's own thoughts/observations) regardless of which process wrote it, matching upstream's file-tail bus. **Still a gap for `src/topology.ts`**, which stays an in-process test harness by design and never sees out-of-process appends — this is intentional (a deterministic test double), not a runtime limitation. See the Gaps table row for the daemon-vs-topology distinction and daemon.test.ts for the closing proof.

**Sandbox bind-mount scope (whole-repo, not per-tool)**: upstream's `bin/shellm` (`bin/shellm:866-916`, function around `docker_run_flags`) mounts each sandboxed tool individually, read-only, at its own path — `-v "$tool_path:/usr/local/bin/$tool:ro"` per tool in `shellm_tools=(llm traj context shellm-explore headlong skills mem shellm-docker shellm-docker-broker)`. This port's `src/sandbox-runtime.ts:140-143` instead bind-mounts the **whole port checkout** (`opts.portHome`, the repo root or `HEADLONG_TS_HOME` — see `src/steprun.ts:206`) read-only in one shot: `-v "${opts.portHome}:${opts.portHome}:ro"`. Functionally equivalent (every tool the model's bash can reach is still read-only), but coarser: the sandboxed process can see the whole port source tree read-only, not just the individual tool binaries upstream exposes. Not tracked as a Deviation row (no differential harness exercises directory listing inside the sandbox) — recorded here as a known scope difference.

## Oracle

- Frozen surface: the trajectory JSONL step stream — step `type` sequence, `source`,
  `run_id` grouping, causal `trigger_step`, and per-step semantics (a `prompt` step is
  standing context, NOT a chat `message`; `reasoning` carries bash in `cmd`; responder
  `decision:"no-reply"` observation with zero reply messages). NOT on surface:
  nondeterministic model prose, stdout text, timestamps, step_id UUIDs.
- Oracle = characterization tests replaying real pax golden traces. golden/: trace-00
  (boot+convo, 112), trace-01 (timer wakes, 238), trace-02 (NO_REPLY+reactive, 279),
  trace-04 (weather delivery-gap, 62). Model replies served over local HTTP (test/support/modelHttpFixture.ts) for determinism.
- **Oracle proven to fail: 2026-08-28** — injected the original port's real bug (standing
  context emitted as `message` not `prompt`); characterization test went red (2 failed);
  restored. The oracle catches the regression that matters.
- One-command run: `pnpm test` → **2382 passed / 39 skipped / 0 failed** (v0.1.0, 2026-10-29, clean Linux export and macOS; see `docs/GUIDE.md`). Earlier: 1122 passed / 4 skipped (2026-09-02, routes-c lane). The 4 skips are the
  wire-model UI parity tests (`web/server/test/parity.test.ts`), which need the
  external pax sample identities not shipped in this checkout. The 480 tests that
  predate the retrieval port are untouched; retrieval adds 56 (test/retrieval.test.ts).
  The CLI-rest lane (sub/killall/enable-disable) adds the remaining 54: 29
  (test/sub.test.ts), 15 (test/killall.test.ts), 10 (thinkersctl enable/disable cases).
- golden/trace-05-retrieval: the retrieval thinker live on pax (rows 676-856, the
  dispatcher's retrieval lines, index.tsv, seen, the 14 memories) — a deterministic,
  no-LLM oracle; see its NOTES.md for the probe artifact (row 676) and the post-edit
  caveat (row 856).

## Parity by module

| Module | Status | Parity | Notes |
|---|---|---|---|
| trajectory/schema — WRITE PATH ONLY (trajCore.mjs, types) | green | 100% | `appendStep`/`readSteps`/`newTrajectory`: step schema + run_id auto-stamp + blob spill, field names exact. This row previously read "trajectory/schema (trajCore, types)" with no scope qualifier, which overclaimed: it covers ONLY trajCore's write primitives, not the `traj` CLI tool built on top of them — see the next row, which is the actual `bin/traj`/`bin/traj.mjs` parity status. |
| traj CLI (bin/traj / src/trajCli.ts + bin/traj.mjs) | green | PARITY | Full port of all 14 subcommands (new, append, fork, merge, show, tail, search, count, last, cat, exists, path, list, root, check) over an injectable IO seam, reusing trajCore's proven appendStep/readSteps unchanged for append/last. 77 unit tests (test/trajCli.test.ts). Differential `parity/traj/run-parity.mjs` (real Bash `bin/traj` vs the port, fixture trajectories seeded from golden/trace-00): 82/82 effective (80 byte-identical + 2 documented deviations, 0 DIVERGE) — see Deviations below. Before this port, only `append`/`last` were implemented; `show`/`tail`/`list`/`cat`/`path`/`search`/`new`/`fork`/`merge`/`exists`/`count`/`root`/`check` were silent no-op stubs (or, for `exists`/`tail`/`cat`, a narrow hand-rolled behavior that ignored `--traj_dir` and any non-root trajectory) — this was a confirmed real gap: `parity/upstream-tests` suites `test_responder_idempotency.sh`, `test_monolith_backoff.sh`, `test_prompt_file.sh`, `test_var_secrets.sh` failed on it (9/13, 5/10, 2/4, 3/7 port-only-fails) and now pass (13/13, 10/10, 4/4, 8/8) — see traj CLI parity fixes below for the 2 real bugs the differential harness found and fixed along the way. |
| shellm inner loop | green | 100% | prompt-as-step, one-bash-block extract, set -x wrap, FINAL capture. The "FINAL capture" claim was proven only under `LocalSandbox` (host tmpdir `finalPath`) — under `DockerSandbox` the model's bash runs INSIDE the container, where that host path was never mounted, so FINAL/FINAL_FILE writes silently vanished (0/14 runs recorded a `final` step vs 14/15 upstream; every docker-mode run burned the full `SHELLM_MAX_ITERATIONS` cap instead of stopping). Fixed: `src/shellm.ts`'s `finalPath` now routes to `$workdir/.shellm_final` (bind-mounted into the container, matching `bin/shellm:2515-2521`'s docker-mode branch) whenever `opts.header.env.type === "docker"`, LocalSandbox's `$rundir/final` path unchanged. Now proven under both sandboxes: `test/shellm.test.ts` "runShellm: FINAL capture path selection (BUG #27)" — a LocalSandbox regression plus two real-Docker-daemon tests (`FINAL="..."` and `FINAL_FILE=...`), the latter skip cleanly with no docker daemon. bug #33 (inactivity watchdog, idle vs max KILLED distinction): FIXED — see the "sandbox parity fixes" bullet and the `KILLED` kill-reason Deviations row (both marked RESOLVED) below; `ShellmConstants` gained `inactivityTimeoutMs` (`SHELLM_INACTIVITY_TIMEOUT`) alongside `inactivityMaxMs`. |
| extract (reasoning/code) | green | 100% | heredoc-aware first block + truncation-notice quirk |
| sandbox (LocalSandbox) | green (adapted) | n/a | restricted subprocess, not Docker — DEVIATION below. `exec()` is now `async` and runs a real inactivity watchdog (bug #33, FIXED — see "sandbox parity fixes" below), not a flat `spawnSync` timeout |
| backoff / wake_at | green | 100% | ladder [0,0,5,5,5,10] matched to trace-01 |
| dispatcher | green | 100% | subscription match, trigger_self skip, FIFO+coalesce, salience feedback |
| responder + NO_REPLY | green | 100% | silence on bare ack, 3-layer idempotency; trace-02 reproduced. Upstream sync 1b (design/conversation_memory.md): conversation history now comes from the derived message index (chat.ts's messageIndex.ts) grouped by person key across routing names, unioned with a Slack thread's last day, falling back to the recent-stream window when the index has nothing; DEFER:-line deferrals append an action step the monolith routes on; context_msgs/thread_msgs/context_steps/history_source/model/compose_ms/gap_s are stamped on every decision observation; per-person notes (a type:person memory) are written after a reply and read into the next prompt (one noted deviation: reuses the reply's LlmClient, no per-call model selection — see responder.ts's updatePersonNotes header); the async notes path (RESPONDER_PERSON_NOTES_SYNC unset) spawns a real detached child process (bin/responder-notes.mjs) rather than an in-process promise — a real bug fix, see the 0c51de8 row below for the live proof. 30 new unit tests (responder.test.ts) + 16 (responder-integration.test.ts) + 3 (responder-notes.test.ts, real subprocess against a fake LLM server) + 2 (steprun.test.ts); differential parity/upstream-tests/run.mjs: test_responder_metrics.sh 17/17, test_responder_deferral.sh 14/14, test_responder_person_notes.sh 12/12, test_responder_thread_context.sh 7/7 (all no-port-cli — thinkers/responder/step itself isn't a port CLI — but all exercise chat.mjs/traj.mjs on PATH, a real differential for those). See "Upstream sync 1b" section below. **Bug #36 fix:** `updatePersonNotes` now ports `_update_person_notes`'s dedup lock (thinkers/responder/step:343-350) — `mkdir "${MEM_DIR:-/tmp}/.person-notes.lock" 2>/dev/null \|\| return 0`, ONE lockdir per MEM_DIR (there is no `$key`/person in the Bash path — it serializes ALL person-notes writes for one identity, not just the same person's), with NO staleness/steal logic anywhere in the source: a lock left behind by a crashed writer blocks every future notes update for that identity until removed by hand, ported faithfully (never auto-broken). Released on every exit path via try/finally, matching the Bash's `trap "rmdir '$lockdir' 2>/dev/null" EXIT`. Lives inside the shared `updatePersonNotes` function both the `personNotesSync` in-process path and the detached `bin/responder-notes.mjs` child call, so both are covered identically — exactly where the RUNTIME-SEAMS.md §D item 8 audit flagged it (a distinct construct from bug #26's detached-subshell-outlives-parent issue, not yet closed when #26 landed). 8 new tests (`test/person-notes-lock.test.ts`): two near-simultaneous calls (second no-ops); the lock is per-MEM_DIR not per-person (two different people's updates still serialize against each other); a pre-existing stale lockdir is never auto-recovered (llm never called, notes file never written, lock left untouched); release on success and on a thrown error (a subsequent call then proceeds normally); the `mkdir -p` precondition failure short-circuits before ever touching the lock; two REAL `bin/responder-notes.mjs` child processes racing on the same person write exactly one notes file (file-count assertion, timing-independent — a broken lock would produce two separately-hex-named files); two real children racing against a pre-existing stale lock both no-op. |
| monolith reactive coupling | green | 100% | observation → reactive wake, level reset. Upstream sync 1b: the recent-stream projection both this and the responder read now drops reasoning steps and collapses consecutive idle/error runs (src/recentStream.ts, replacing the old inline recentStream); a part-5 "PENDING REQUEST" routing hint (pendingRequestHint, exported) surfaces an unresolved responder deferral with the exact chat reply --follow-up delivery command; thinkers/monolith/prompt.md's one-line pending-request exception is byte-identical in both bundled copies (src/assets/monolith-prompt.md, src/assets/thinkers/monolith/prompt.md). bug #37 (FIXED): the "no durable step" fallback's `error` step (thinkers/monolith/step:361-369) was missing `rc` entirely and hardcoded `content` to "…failed with no durable step" (no `(rc=N)`) — silently breaking `recentStream`'s own rc-suffix collapse logic (thinkers/_lib/common.sh's `_RECENT_STREAM_COLLAPSE_JQ`, already ported and tested against synthetic input, but never fed a real `rc` in production). Every failure path that reaches the fallback maps to upstream's own `rc=1` (run_loop's `return 1` for stall/max-iter, `die()`'s `exit 1` for empty-response) — see src/monolith.ts's inline citations; upstream's own observed rc=141 (SIGPIPE, design/monolith_run_health.md Issue B) and rc=126 (ARG_MAX) are bash/OS artifacts this port's architecture cannot hit (no racing `tail\|head` read, prompt always via temp file) and are not modeled. Also fixed: `runShellm` is called in-process (no subprocess boundary), so a thrown exception (LLM/sandbox failure runShellm doesn't catch) used to escape `runMonolithWake` entirely — no fallback step, no backoff, no re-armed wake, unlike upstream's `shellm ... \|\| run_rc=$?`, which always keeps the outer step alive. Now caught at that exact point, recorded as the same rc=1 error (with `run_id` recovered from the run header if one was appended before the throw), and the wake completes normally (`stopReason:"threw"`). Verified the "durable step" type sets match exactly (VISIBLE_TYPES action/observation/merge/message + thought, both sides) — not a second bug. test/monolith.test.ts (13, was 6): idle path has no `rc`/`reason` fields; stall/max-iter/empty-response error steps carry `rc:1` and the exact upstream content string; `trigger_step` passthrough; the thrown-exception path; an end-to-end recentStream collapse proving the field monolith writes is the field recentStream reads. test/recentStream.test.ts (9). |
| chat CLI (bin/chat / src/chat.ts + bin/chat.mjs) | green | PARITY | send/send-file/reply/history/repl fully ported (see file header for the `${2:?}`-wording and repl-exec-wording documented deviations). Upstream sync 1b adds `chat history --with <name> [--since D] [-n N] [--json]` (the derived messages.jsonl index, src/messageIndex.ts), `chat history --thread <name>` (src/personMemory.ts's threadKey), `chat person-key`/`chat thread-key`, and `chat reply --follow-up` (bypasses the duplicate-answer guard, stamps follow_up:true — the transport half of the responder's part-5 deferral). Also ports a real upstream behavior tightening: `chat history`'s count is now validated `^[0-9]+$` on EVERY path (the legacy `history [N]` positional included), so a `tail`-style `+N`/`-N` spec now dies before reaching the old overflow check. 38 new unit tests (messageIndex.test.ts, personMemory.test.ts, chat-history-index.test.ts). Differential parity/chat/run-parity.mjs: 70/77 (90.9%) vs real NEW bin/chat — 21 new convo-memory scenarios all at PARITY, the remaining 7 DIVERGEs are the pre-existing documented `${2:?}`/DEL-stdin/repl-exec-wording deviations (unchanged). parity/upstream-tests/run.mjs's test_chat_history_index.sh (a NEW upstream suite that drives bin/chat directly): 29/29. Two real port bugs found and fixed along the way (person-key/thread-key's missing second trailing newline; history --with's text-mode output missing jq's implicit JSON-string quoting) plus one broader trajectory-resolution bug (rootFile() only tried the `<hex8>-root` convention, not the full `<dir>/<id>/trajectory.jsonl`/exact-path forms `traj append`/`traj path` also accept) — see "Upstream sync 1b" section below for detail. **PORT-BUG #68** (found later, characterizing a suspected reply-to/TRAJ_ID gap): `appendStep`'s write path reused that same lenient `rootFile()` fallback, so an unresolvable `TRAJ_ID` silently auto-created a brand-new trajectory instead of refusing like real `traj append`'s `require_traj_file` (`traj: error: append: cannot resolve traj_id '<id>' in '<dir>'`, rc 1) — fixed by giving `appendStep` its own strict resolution + upstream's exact death text; `rootFile()` keeps the lenient fallback for reads only. See the "Real bugs found and fixed" list below for detail. The `messages.jsonl` index is deliberately lazy on both sides: `_index_update`/`indexUpdate` runs only inside `cmd_history`/`cmdHistoryIndexed` (`bin/chat:385`, `src/chat.ts:591`) — CHECK #29 confirmed the port's responder wake matches upstream's `chat history --with` call at wake start (`thinkers/responder/step:149` ↔ `src/responder.ts:253`), but upstream also re-indexes a SECOND time inside `_update_person_notes` (`thinkers/responder/step:350`, its own fresh `chat history --with` call, run AFTER `chat reply` has appended the wake's reply) while the port's `updatePersonNotes` was reading the wake-start snapshot straight through — one fewer index-update call site, so the notes prompt always missed the reply that triggered it (the "messages.jsonl lagged one message behind the trajectory" symptom). Fixed: `updatePersonNotes` (`src/responder.ts`) now re-indexes unconditionally at its start, covering both the sync path and the async `bin/responder-notes.mjs` path — `test/responder-notes.test.ts` "re-indexes before reading history" proves it fails pre-fix and passes post-fix. |
| mem / recall / learn | green | PARITY | 82 unit tests; differential 76/86 vs real Bash (upstream-next @ 5458fee) — all 10 mismatches are the one documented `${2:?}`-class stderr-wording deviation (exit code + stdout + on-disk state match). learn/recall are surfaced as `mem add`/`mem search` (monolith-prompt.md). **Upstream sync 2 (lane C):** `mem search` is now two-stage — `mem_prefilter` scores every memory locally with BM25 (byte-wise, `LC_ALL=C` semantics) and keeps the best `MEM_SEARCH_TOP` (40) for the model, with a `-t MEM_SEARCH_MAX_TOKENS` (16000) output cap and a "waiting for the model" heartbeat on stderr every `MEM_SEARCH_HEARTBEAT_S` (10; `"0"` disables) while `llm` runs; an empty store now prints "No memories stored." and exits 0 (was a silent rc 1 — Bash's own `set -e`+pipefail dead-code branch, now guarded upstream); `mem prefilter <query> [--top N]` exposes stage 1 with no model call; `mem add --until YYYY-MM-DD` dates a todo (shape-only validation) and the field now survives a `mem edit`. See "mem search prefilter/heartbeat/until (upstream sync 2, lane C)" below for the full behavior list, the BM25 tie-break bug found and fixed, and documented deviations. |
| skills (authoring + invoke) | green | PARITY | 52 unit tests; differential oracle 91/91 effective (81 byte-identical + 10 documented deviations; 0 port bugs); fixes + deviations below |
| **skills content** (`src/assets/skills/`, vendored) | green | 100% | 12 bundled packs (README.md + 11 SKILL.md files: kernel/{mem,chat,goals} + bundled/{file-tools,googleworkspace,obsidian,shellm,skill-author,slack,telegram,web-research}) copied byte-identical from upstream headlong/skills/ at ed2dac6. Validated via test/skills-content.test.ts (pack directory listing, per-pack SKILL.md file presence and non-empty). Identity bootstrap (src/identity.ts) provisions these into new identities; build script (package.json) copies src/assets/ to dist/ for runtime. |
| chat outward delivery | STUB / faithful-gap | n/a | trace-04 stranding reproduced on purpose; see Deviations |
| memory tiered rollups | green | PARITY | 55 unit tests; differential 19/19 vs real Bash `recap`/seal on pax's 1200-step trajectory (render 252/252 rows byte-exact, block-plan set, staircase selection) |
| recap CLI (bin/recap: map-reduce episodes/themes + `--context` staircase) | green | PARITY | src/recap.ts + bin/recap.mjs. 102 unit tests (llm seam injected): jq/bash/awk-semantics helpers (renderStep, windowRanges, bashDigits/bashArith octal + `set -u` unbound-variable rules, fnmatchToRegex/findFirstDir trajectory resolution, parseJsonLossless/RawNumber literal preservation), refresh() map-reduce caching (episode/theme on-disk shapes, incremental resume, the trailing-partial-episode-always-resummarized quirk, lock/stale-lock handling), text/json output, `--context` rollups (block sealing, staircase assembly, `--backfill`/`--rebuild`, incremental rendered.tsv append). Differential `parity/recap/run-parity.mjs` (real Bash `bin/recap` vs the port, a deterministic fake `llm` stubbed identically on PATH for both sides so map/reduce/rollup reply text is diffable byte-for-byte, not just structure): re-run against upstream-next @ 5458fee during sync 1c (lane J), now 37/39 byte-identical (stdout+stderr+exit+on-disk cache state) — the 2 remaining mismatches are the pre-existing documented `${2:?}` deviation below (global/missing-flag-value, global/empty-flag-value). The other 3 (`context-backfill-seals-tier1`, `context-two-tier-staircase`, `context-rebuild-reseals`) were the drift flagged during lane J's sync: upstream's `f6f854c` ("outcomes not temperament") bumped `bin/recap`'s `ROLLUP_PROMPT_VERSION` 2→3 and reworded both rollup-summary system prompts (`_WINDOW_SYSTEM`/`_ROLLUP_SYSTEM`, "events, not character/temperament"). Lane K (sync 1c) ports this: `src/rollups.ts` `ROLLUP_PROMPT_VERSION = 3` + `ROLLUP_SYSTEM`, `src/recap.ts` `WINDOW_SYSTEM`, byte-identical to upstream-next's `bin/recap:54,293-297,505-508` (test/rollups.test.ts, test/recap.test.ts — `PORT-NOTE (1c: f6f854c)`); the frozen real-fixture parity test (pax 55fd5932-root, sealed under the historical v2 prompt) now asserts the literal `2`, not the live constant, since sealed blocks are cached forever and never re-stamped. Re-run against upstream-next's `bin/recap` confirms all three now PARITY. INDEPENDENT ADVERSARIAL differential (`parity/recap/run-parity-adversarial.mjs`, tester's own 145-scenario harness — flag misuse, corrupt/partial cache state, lock staleness boundaries, adversarial trajectory content, `--context` tier boundaries, every env var, and the exact `llm` argv+stdin bytes each side sends): 123 byte-identical + 22 documented deviations, 0 DIVERGE — after 4 real port bugs it found were fixed (F1–F4, "recap parity fixes" below) and every remaining divergence got its own PARITY.md row. Reuses src/rollups.ts's pure block/staircase math (buildPlan, resolveR, epochMin, planStaircase, resolveSegments) where semantics match exactly; does NOT reuse rollups.ts's renderStepText/renderSteps/buildRollups/recapContext, which differ from the Bash on jq truthiness of empty-string `source`/`wake` (jq: truthy — recap.ts matches; rollups.ts's plain JS truthiness does not), `//` on a `false`-valued field, `@tsv` backslash escaping, the jq `input_line_number` quirk on an unterminated last line, and a corrupt `rollups/meta.json` fallback (Bash/recap.ts: start 0; rollups.ts: "no meta" → start n) — see src/recap.ts's file header for the full list. |
| retrieval thinker (passive no-LLM recall; third thinker, opt-in) | green | PARITY | src/retrieval.ts + bin/retrieval-step.mjs. 56 unit tests: the 8-scenario Bash oracle (tests/test_retrieval_thinker.sh) ported verbatim, index.tsv byte-equal to the real build-index.sh over the 14 pax memories, no-op matrix, replicated quirks, golden replay, topology with the third thinker (`reactive/observation:retrieval` wake). Differential parity/retrieval: 31/31 over 3 sequences vs the real Bash step + 2 documented-deviation scenarios; the upstream Bash suite drives bin/retrieval-step.mjs 17/17. Registered in src/topology.ts behind `retrieval` config, default off (upstream ships the thinker with a `disabled` marker) — the two-thinker tests are byte-identical. |
| llm tool (all wire paths: openai, openrouter, opencode-go, openai-compatible, anthropic, gemini, opencode/Zen, adapter) | green | PARITY | 148 unit tests (fake HTTP server + real Node adapter-fixture subprocesses, no network); differential `parity/llm/run-parity.mjs` 220/220 effective vs real Bash `bin/llm` (203 byte-identical + 17 documented deviations, 0 port bugs) over stdout+stderr+exit+health marker+ledger+usage file+temp cleanup+received requests — covers request wire body, headers, auth, model rewrites, max_tokens, thinking/effort, streaming/non-streaming responses + truncation, error/retry (including the anthropic `type:"error"` mid-stream fatal-event quirk), and the adapter stdin/stdout/argv/deadline contract per provider (see "llm slice 2 parity fixes" below for the 3 real port bugs it found and fixed). Independent ADVERSARIAL differential (`parity/llm/run-parity-adversarial.mjs`, OpenAI-family only, raw-byte fake server, stdout bytes + stderr + exit/signal + sandbox bytes + requests) 278 scenarios: 235 byte-identical + 43 documented deviations, 0 DIVERGE — after 13 real port bugs it found were fixed (F1–F13, "llm parity fixes" below) and every remaining divergence got its own row. Unblocks `mem search` (`bin/llm` is a symlink to `bin/llm.mjs`; no Bash). Also verified against upstream's OWN `tests/test_llm_adapter.sh` via `parity/upstream-tests/run.mjs`: 20/20 (was 4/20) — see "llm slice 2 parity fixes". No open Gaps remain for the llm tool. |
| **daemon** (`src/daemon.ts` + `bin/dispatcherd.mjs`) | green | PARITY (adversarial) | resident per-identity loop: boot (pid/token/sub_map/traj_files/empty pending), tick (token guard → firePending → watchdogCheck → scheduledWakeCheck → prune step_pids → feeder poll), detached step-per-wake, signal handling (deliberate_stop → exit 0; else last_signal + exit 130). `dispatcher.log` text lines are verified BYTE-FOR-BYTE against the real Bash by the independent adversarial harness (`parity/daemon/run-parity-adversarial.mjs`, `report-adversarial.md`) — 3-space sub-event indent, `fire pending -> name (type=T, active=N)`/`watchdog -> …`/`skip … (self-trigger\|self error)`/`pending … superseded (last-wins)`/`pending -> name (type=T, queued=N)` lines, no invented `boot:` line. A record the dispatcher itself appends (the salience `feedback` injection) is delivered through `Dispatcher.feed()` SYNCHRONOUSLY (not on the next tick) so its log line lands in causal order — see Deviations "dispatcher event bus". Never imports the engine. 7 tests (daemon.test.ts, incl. a byte-diff of a scripted busy→queued→feedback→re-fire sequence against real-Bash-shaped text) against a real spawned child + covered end to end by live-loop.test.ts. |
| **runstate** (`src/runstate.ts`) | green | 100% | the whole `run/` byte contract, one function per file, tmp+rename atomicity; `step_pids` SPACE-separated (F2); `FilePendingStore` (message/action/rest firing order, FIFO cap 16 drop-oldest, coalesce last-wins); `pidAlive` (EPERM=alive); `killTree` (one `ps` snapshot, depth-first). 30 unit tests, every writer's exact bytes pinned. |
| **feeder** (`src/feeder.ts`) | green | 100% | in-process replacement for `tail -F \| dispatch.fifo`: opens at current EOF, fs.watch + tick-poll, complete-lines-only with partial-line stitching, truncation restarts at offset 0, ENOENT retried each poll. 8 unit tests. |
| **steprun** (`src/steprun.ts` + `bin/thinker-step.mjs`) | green | 100% | one wake end to end: IdentityConfig assembly (core_identity_prompt.md override, buildSkillsPrompt, a `get_goals` port), a PLAIN FileTrajectory (never ObservableTrajectory), selectSandbox, the real `llm` client (`LlmCliClient`) only, with no replay switch; tests point `LLM_API_URL` at a local endpoint (`test/llmFakeServer.ts` via `test/llmScripted.ts`), as upstream's `tests/test_llm_retry.sh` does, argv[0] dispatch to monolith/responder/retrieval. 12 unit tests + exercised live by live-loop.test.ts. |
| **identity** (`src/identity.ts` + `bin/identity.mjs`) | green | subset | `identity new` only (`import` is Slice C, SPEC-control-plane, out of this lane): full layout, `info.txt` (`created=` is upstream's LOCAL no-ms/no-`Z` `iso_timestamp`, not `Date#toISOString()`), root trajectory + 11 seed thoughts verbatim, monolith+responder installed enabled, retrieval installed with its `disabled` marker + `prompt.md`/`stopwords` (byte-identical text assets), `subscriptions.jsonl` reproducing the Bash injection loop's double-newline quirk, `.retired_done` seeded, traj_id injection, default symlink. `kernel/{mem,chat,goals}` and the 8 bundled `skills/*` are provisioned with copied `SKILL.md` text (see Deviations "kernel/skills copied, not symlinked"); `thinkers/_lib/common.sh` and `thinkers/retrieval/build-index.sh` (Bash) are never copied (see Deviations "Bash thinker helpers omitted"). NO `activate` file (see Deviations). Verified against the real Bash `tools/identity` by the adversarial harness's `identity-new` flow: `stdout`/`stderr`/`exit-code`/a per-file tree diff all PARITY, the four DIRECTOR-decided path classes above each their own DEVIATION row. 5 unit tests (identity-new.test.ts). |
| **identity list** (`src/identity.ts` `identityList` + `bin/identity.mjs list`) | green | PARITY | Adds `identity list [-a]` to the `identity` module described in the row above (that row predates this addition and still reads "`identity new` only" — this row is the update; port/identity-list lane). Full port of `cmd_list`/`_identity_names` (tools/identity:945-995, :46-54): marker (`*` for the `default` symlink target)/name/created/absDir columns; `-a`/`--all` show-dir mode; `created=` with a `started=` fallback when `created` is empty or absent; hidden (dot-prefixed) directories invisible (bash's non-dotglob `*/`  glob); the literal `default` entry excluded by name; a non-identity directory (no `info.txt`) still listed with `created` `""`; a directory symlink included, with `absDir` the lexical `cd`+`pwd` join (NOT a symlink-resolved realpath, matching upstream); a dangling symlink excluded (fails `[[ -d ]]`); a dangling `default` symlink itself produces no marker match and no crash; argv edge cases replicated exactly — extra positionals and a `-a` arriving after the first positional are both silently ignored, matching bash's arg loop breaking on the first non-flag. Ordering matches this environment's observed `bash` glob sort — locale-aware (case-insensitive primary key: "alpha" < "Bravo" < "mike"), reproduced with `String#localeCompare`, NOT a raw byte/code-unit sort; this is inherently environment-dependent (neither `tools/identity` nor the Docker sandbox pins a locale for it — see the code comment in `identityList`). 13 unit tests (test/identity-list.test.ts). Differential `parity/identity/run-parity.mjs` (real Bash `tools/identity list` vs the port, `.identities`-shaped fixtures — 0/1/3 identities, `created`/`started` fallback, a stray non-identity dir, hidden dirs, a plain file, a symlinked dir, a dangling symlink, a dangling `default`, mixed-case ordering, a >=20-char name, argv edge cases): 17/17 byte-identical (stdout+stderr+exit), 0 DIVERGE — see `parity/identity/report.md`. Closes the TUI's `/identities` gap: `tui/PARITY-RECEIPT.md`'s "Gap 1 (`/identities`) closed" heading has a live run of `bin/identity list` against a real fixture using the exact env `resolveIdentityEnv()` computes. |
| **identity import** (`src/identity.ts` `identityImport` + `bin/identity.mjs import` + `src/tar.ts`) | green | PARITY (structural) | Adds `identity import <file\|-> [--name NEW]` to the `identity` module (routes-c lane; the two rows above predate this addition and still read "`identity new`/`list` only"). Full port of `cmd_import`/`_install_imported_identity` (tools/identity:706-810, 642-704): unsafe-path refusal (`^/\|^\.\.(/\|$)\|/\.\.(/\|$)` against raw archive member names, checked before anything is written), `manifest.json` `format` field checked (>1 refused as "newer than this tool understands"), target-name resolution (`--name` for a single-identity archive, else `manifest.json`'s `identities[].dir->name` map, else `info.txt`'s own `name=`, else the source dir's basename) validated against the shared `IDENTITY_NAME_RE`, duplicate-target and existing-name conflicts refused before any writes, `run/`/`.shellm/`/`kernel/`/`.env`/`activate` stripped even if the archive carries them, live root-trajectory repair (a soul-only archive, or one whose `root_trajectory=` trajectory file is missing, gets a fresh `createTrajectory` + `subscriptions.jsonl` re-pointed at the new id — literal substring replace, matching the Bash `sed`), dangling-symlink drop (`fs.existsSync` follows the link; a target that doesn't resolve ON THIS HOST is removed, one that does is kept as-is), kernel skills always regenerated / non-kernel bundled skills installed only if not already present (see Deviations table for the two accepted differences: `activate` never written, kernel/skills copied not symlinked — both inherited from `identityNew`, not new to this row). `src/tar.ts`: a minimal, dependency-free (node:zlib for gzip) ustar/PAX/GNU-longname tar READER (+ a small ustar WRITER for test fixtures only — this port never writes archives at runtime, `identity export` is unported) — verified against real macOS bsdtar output for both short and long/PAX-header paths. 20 unit tests (test/identity-import.test.ts, synthetic archives built with the writer): single/multi-identity, rename, manifest name-mapping, every validation/conflict path, secrets/runtime-state stripping, live-root repair + subscriptions re-pointing, dangling-vs-resolving symlinks. Differential `parity/identity/run-import-parity.mjs` (real Bash `tools/identity export`+`import` vs the port, fixtures built with the real `identity new`): 6/6 PARITY (exit code + imported-name stdout-as-a-set + a structural directory-tree diff — content-hashed, ignoring the two accepted `activate`/kernel-symlink deviations, and normalizing the two sides' independently-random root-trajectory UUIDs before comparing, since two correct runs never share one) — see `parity/identity/report-import.md`. |
| **identity export** (`src/identity.ts` `resolveExportDirs`/`buildIdentityExportArchive`/`defaultExportOutName` + `bin/identity.mjs export` + `src/tar.ts` writer) | green | PARITY (structural) | Adds `identity export [names...] [--all] [--path DIR] [-o FILE\|-] [--soul-only] [--slim]` to the `identity` module (routes-d lane). Full port of `cmd_export` + its helpers (tools/identity:521-638, 423-519, 997-1025 `_resolve_identity_path`): dir resolution (bare name exact-then-fuzzy-substring match, `--all` glob-excluding `default`, `--path`, bare-invocation `default`-symlink resolution), duplicate-basename refusal, the `run/`/`.shellm/`/`kernel/`/`thinkers/`/`.env`/`activate` prune list (thinkers/ handled separately, see below), `--soul-only` (drops `trajectories/` entirely), `--slim` (`_SLIM_JQ`'s cut-at-N-chars-with-truncation-marker for `shellm-run.command`/300 and `prompt.content`/600, `_slim_redact`'s 6 API-key regexes, ported to JS string ops — verified byte-identical against the real `jq`/`sed` pipeline), `manifest.json` (`format`/`exported_at`/`soul_only`/`slim`/per-identity `dir`/`name`/`created`/`root_trajectory`/`memories`(recursive `*.md` count)/`traj_steps`(`wc -l` on the live, unslimmed trajectory file)), thinkers/ shipped DEREFERENCED (`cp -RL` equivalent — a `--symlinks`-installed thinker's files travel as real files/dirs; a dangling symlink is dropped, see Deviations), skills/ symlinks (NOT thinkers) preserved AS symlinks (bash's plain `find`, no `-L`). `src/tar.ts`'s writer extended with PAX "path"/"linkpath" extended headers for any name/linkname over the ustar 100-byte field (real trajectory paths can exceed it) — round-trips through this port's own reader and verified against real macOS bsdtar (`tar -tvzf`). 26 unit tests (test/identity-export.test.ts: dir resolution incl. every error path, prune list, manifest fields, soul-only, slim truncation+redaction on both a long and a short/un-truncated key, thinkers deref incl. a dangling-symlink case, skills symlinks preserved, `--all`, real file-mode passthrough) + 5 tar-writer tests (test/tar-writer.test.ts: short/long names, long linkname, unicode, adjacent-entry corruption check). Differential `parity/identity/run-export-parity.mjs` (real Bash `tools/identity export` vs this port's `buildIdentityExportArchive` — the SAME library the web routes call — against the SAME REAL-Bash-`identity new`-built source tree; both archives decoded with this port's own tar reader and diffed as structured entry lists: entry set/type/mode/size/bytes/linkname, NOT raw tar bytes): 6/6 PARITY (name/`--path`/`--soul-only`/`--slim`-with-truncation-and-redaction/`--all`/bare-invocation-default-identity) — see `parity/identity/report-export.md`. Documented allowances (see that harness's own header comment): entry ORDERING not compared (bash `find`'s readdir order vs this port's sorted walk — both valid), and `manifest.json`'s `exported_at` field not compared (independently generated wall-clock timestamps, several seconds apart in a harness run). |
| **thinkersctl** (`src/thinkersctl.ts` + `bin/thinkers.mjs`) | green | PARITY (adversarial) + enable/disable | `start`/`stop`/`status`/`step`/`list`/`logs`, verified against the real Bash `bin/thinkers` by the adversarial harness (2 DIVERGE, both cross-run environmental noise unrelated to this port — `stop-all-default/stderr-text` and `misuse/stop-not-running-stderr` differ only in upstream's `_warn_stray_tails` machine-wide `pgrep -f 'tail -n 0 -F'` picking up a `tail` feeder left running by an UNRELATED concurrent parity-live run sharing this machine, confirmed via `pgrep -fl 'tail -n 0 -F'`/`dispatcherd` resolving to a different sandbox's PIDs; every other check, including all 12 new `identityDirOnly_*` ones below, is PARITY). `start`: boot-wait, wake-gap note (failure-open); ONLY the named branch boot-kicks (writes a manual-trigger pending file) — bare `start` (no names) never does, matching upstream's own quirk (bin/thinkers:1163-1221). `step`: runs the thinker's `step` SYNCHRONOUSLY inline (not a pending file) — `Running <name>/step ...` to stderr, the step's stdout+stderr merged and tee'd to both this process's stdout and `run/logs/<name>.log`, exit code propagated; only checks the thinker dir exists and `step` is executable (no disabled/subscriptions.jsonl gate, unlike `start`). `status`: rewritten line-by-line against bin/thinkers:1435-1537 — blank line, `Concurrency: N max` only while running, 30-col name padding, `[types]` bracket, log-line/pending-queue suffixes, disabled thinkers never listed. `stop`: ppid-ancestry self-stop guard, drain-or-force, stop-all cleanup, and (fixed in this lane — see "daemon-runtime gap fixes" below) runs a stopped thinker's own `<thinker_dir>/stop` script at all four sites bin/thinkers does (`:1259`, `:1273`, `:1356-1357`, `:1423,1425`), the drain sites via a detached `bin/thinkers-drain.mjs` child so the CLI still returns immediately. Disabled-thinker error text names the real marker path (`Thinker 'X' is disabled (remove <dir>/disabled to enable)`). `enable`/`disable` (SPEC-control-plane §D.2, D.4 — Slice B) now SHIPPED: `thinkersEnable` unlinks `<tdir>/disabled`, reports `needsRestart` = dispatcher running; `thinkersDisable` stops the thinker first unless it is already stopped or already disabled (`stoppedFirst`), then touches the marker (create-if-missing, preserves existing content — matches upstream `touch` semantics, not overwrite). Upstream `bin/thinkers` has NO enable/disable subcommand at all (verified by reading the source — only a manual `touch`/`rm` convention on the marker, already covered by `checkThinkerNames`/`enabledThinkerNames`), so these two commands have no Bash CLI to differentially test against; built directly from SPEC-control-plane.md §D.2/§D.4's own text plus the existing marker semantics. `requireEnv` (shared by all six commands) now reproduces upstream's FULL `_require_env` (bin/thinkers:138-155 — BUG #67, fixed completely, see "daemon-runtime gap fixes" below), not just its `THINKERS_DIR`-exists tail: IDENTITY_DIR/TRAJ_DIR/TRAJ_ID required-and-already-set checks, in that exact order, THEN the IDENTITY_NAME/THINKERS_DIR fallback defaults, THEN `[[ -d "$THINKERS_DIR" ]] || die "Thinkers directory not found: $THINKERS_DIR"`, THEN the remaining never-dies MEM_DIR/SKILLS_DIR/SKILLS_KERNEL_DIR/SHELLM_HOME fallbacks. `bin/thinkers.mjs` no longer pre-resolves the environment itself (it used to call the port's activate-equivalent `resolveIdentityEnv` whenever `IDENTITY_DIR` was merely present, which synthesized `TRAJ_DIR`/`TRAJ_ID` even when the caller never set them, masking exactly the case the ordered checks exist to catch) — it now passes `process.env` straight through, exactly like upstream's own bin/thinkers. 41 unit tests total (13 pre-existing + 10 enable/disable cases + 4 stop-script cases + 3 original BUG #67 refusal cases + 9 new `requireEnv` order-matrix cases — each required var missing alone, the `IDENTITY_DIR`-only sealed-holdout shape at both the library and real-CLI level (also catching a `thinkers: error: ` double-prefix bug in the three not-set checks, invisible to any test that didn't go through the actual `bin/thinkers.mjs` entry point), a real-existing-but-unactivated `IDENTITY_DIR`, and a fully-activated real identity through the CLI) + spot-verified end to end via the real `bin/thinkers.mjs` CLI + a third `parity/daemon/run-parity-adversarial.mjs` "misuse" scenario (`identityDirOnly_*`, 12 checks, all PARITY) added alongside the pre-existing `missingThinkersDir_*`/`missingIdentityDir_*` ones specifically for this sealed-holdout shape. |
| **sub** (`src/sub.ts` + `bin/sub.mjs`) | green | 100% (19/19 differential) | Exact-string (literal, not regex) substitution in a file: `sub FILE OLD NEW`, `--old-file`/`--new-file`, `--replace-all`, atomic temp+rename write. Byte-level (Buffer), not string-level: OLD/NEW/FILE content are matched and spliced as raw bytes, matching awk's `index()`/`substr()`. Two distinct trailing-newline rules reproduced exactly: `$(cat F)` for `--old-file`/`--new-file` strips ALL trailing newline bytes; the FILE's own content reconstruction (mirroring awk's line-record join) drops AT MOST ONE. The replace-to-empty quirk is kept: if the result is empty, a trailing newline is NOT re-added even when the original had one (bash's own `[[ -s "$tmp" ]]` guard). Mode preservation via `fs.chmodSync` (portable; matches Headlong's real Linux-Docker runtime, where bash's GNU-only `chmod --reference` succeeds — see the parity harness header for the macOS-dev-machine artifact this sidesteps). **PORT-NOTE, corrects two upstream docs:** COMPLETENESS-AUDIT.md and REMEDIATION-LEDGER.md#15 both describe `bin/sub` as "spawns a sub-trajectory / sub-agent" — reading the actual 169-line source shows no such thing; it is purely a file-editing string-substitution CLI with zero model/LLM/trajectory involvement. No LLM seam wired (steprun's model client), because the source needs none. 29 unit tests + differential parity/sub 19/19 byte-identical (stdout+stderr+exit+target-file mode+content) vs the real Bash `bin/sub`. |
| **headlong-killall** (`src/killall.ts` + `bin/headlong-killall.mjs`) | green | structural PARITY (7/7) + real-reaping proof | Panic-button process reaper, named `headlong-killall` (not `killall`) to match how the web control layer invokes it (`headlong/web/src/headlong_web/control.py`: `TOOLS_DIR / "headlong-killall"`) and SPEC-control-plane.md §D.4. Argv patterns adapted for the TS daemon runtime's actual process shapes — `node .../bin/dispatcherd.mjs`, `node .../thinkers/<name>/step` (the Node wrapper the daemon spawns per wake) and its nested `node .../bin/thinker-step.mjs` child, `node .../bin/sub.mjs`, `node .../bin/chat.mjs`, `--web`'s `web/server/src/index.ts` — in place of upstream's `bash <path>/(shellm\|llm\|chat\|sub)` etc. patterns, which have no TS-port equivalent (there is no separate long-running `shellm` agent-loop process in this port; a thinker step embeds the whole wake in one Node process). Same technique as upstream throughout: one `ps` snapshot, fixed-point descendant-tree expansion, self+ancestor protection (with the same warning line, reworded for "thinker step" instead of "shellm"), TERM then a 3s grace period then KILL, `docker rm -f shellm-<pid>` sandbox cleanup, `shellm.broker=1` containers reported and never touched. STREAM CONTRACT verified against the actual Bash source (not assumed): only `usage()` and the protected-ancestor warning go to stderr; every report line — including "(dry run — nothing was killed)" — goes to stdout (`tools/headlong-killall` has no `>&2` on any of those lines). `--help`/usage text is byte-identical to the real tool (spot-checked). 15 unit tests spawn REAL decoy processes and reap them for real, but scope `psSnapshot` (an injectable seam) to each test's own spawned pids rather than the real unrestricted system scan — see the Deviations row below for why. Differential `parity/killall` 7/7: `exact` scenarios (help/usage-error text) byte-diffed; `structural` scenarios (`--dry-run` only) check exit code + the trailing dry-run marker + stream routing, with the live process listing intentionally excluded from comparison (the two tools' process universes are disjoint by construction, and even the bash side alone is nondeterministic on a shared dev machine). |
| **sandbox-runtime** (`src/sandbox-runtime.ts` + `src/sandbox-env.ts`) | green | 100% | `selectSandbox`: `auto`→Docker when a daemon answers `docker info` (respecting `SHELLM_ALLOW_NESTED_DOCKER`), else Local; identityDir+portHome bind-mounted, binDir on the CONTAINER PATH; `forwardedEnv()` — the API-key/provider vars upstream forwards into a step's exec env. **Bug #32 fix:** a PERSISTENT container per identity/env name (`shellm-<env>-<hash>`, `node:24-bookworm` default image), reused across wakes when running and image-matching (`sandbox-env.ts` `readEnvMetadata`/`envMetadataMatches`, metadata at `<identityDir>/.shellm/envs/<name>/` = `SHELLM_ENVS_DIR`, matching `tools/identity:375,1381`) — matching `thinkers/_lib/common.sh:372`'s `--env "${SHELLM_THINKER_ENV:-$IDENTITY_NAME}"` on every wake and `bin/shellm`'s `env_resolve`/`env_register`. An image mismatch against a stored env throws upstream's exact `die()` message (0925168's `env_metadata_mismatch_message`, image branch). **Bug #55 fix:** the three remaining upstream pre-loop liveness checks (`docker_container_has_unusable_tool_mounts`, `docker_container_can_reach_path`, the container-exists check, bin/shellm:1320-1335, always upstream's `explicit=1` branch since every wake names a concrete env) are now ported too — a stored env whose container is fully removed, or whose real mounts don't cover this run's workdir, or whose tool shim went non-executable, throws upstream's exact `die()` text (`containerCanReachPath`/`workdirNotMountedMessage`, `containerHasUnusableToolMounts`/`staleToolMountsMessage` in `sandbox-env.ts`) BEFORE any model call, instead of silently reattaching to a dead container and running the whole loop against it. Only a container that is merely STOPPED (present, mounts fine, not running) still gets upstream's own SILENT recreate. `cleanup()` is a no-op by default (persists) and only tears down when `tempDocker`/`SHELLM_TEMP_DOCKER=1` is set (`--temp-docker` equivalent, bin/shellm:2362-2364). `destroyIdentityContainers` (`sandbox-env.ts`) ports `_destroy_containers` (tools/identity:56-65) for a future `identity delete`. Exercised by the DockerSandbox test suite (pre-existing) + steprun/live-loop tests forcing `SHELLM_SANDBOX=local` + `test/sandbox-env.test.ts` (real docker, skips cleanly without a daemon): two-wake reuse via a cross-step marker file + a single `docker ps` match, image-mismatch refusal (exact message asserted), `--temp-docker` teardown, stale-metadata recreation, and `killall`'s real (non-fixture) `docker rm -f` removing the container. **Deliberately not wired into `thinkers stop`** — see the Deviations table below. `DockerSandbox.exec` (`src/sandbox-docker.ts`) is unchanged here — the bug #33 inactivity-watchdog fix lives in `src/sandbox.ts`'s shared `execWithInactivityWatchdog`, which both `LocalSandbox` and `DockerSandbox` now call; see the "sandbox parity fixes" section below. **Bug #35 fix (RUNTIME-SEAMS.md §D item 4):** per-skill env-var discovery + `--var` directory auto-mount, ported into a new `src/skill-env.ts` (`collectSkillVars` = `collect_skill_vars`, thinkers/_lib/common.sh:315-346; `computeVarMounts` = `_compute_var_mounts`, bin/shellm:739-747; `pathCovered` = `_path_covered`, bin/shellm:893-900). `steprun.ts`'s `buildIdentityConfig` scans every installed skill's SKILL.md frontmatter for a declared `env:` list and forwards each one that is set+non-empty in the environment into the wake's `execEnv`, matching `_build_shellm_flags`'s trailing `--var $vname=$vval` loop (common.sh:405-411) — both local AND Docker sandboxes see it, same as every other forwarded var here. `startDockerSandbox` additionally bind-mounts (read-write, same absolute path) any such directory-valued var not already covered by the identityDir/portHome mounts, matching `bin/shellm:1013-1024`'s mount-building loop, and tracks the computed set in env metadata (`sandbox-env.ts`'s `EnvMetadata.varMounts`) — a change since container creation refuses reattach with upstream's exact `env_metadata_mismatch_message` var_mounts-branch text (`varMountsMatch`/`varMountsMismatchMessage`), the same explicit-always-`die()` pattern bug #32's image-identity check already established. **Deliberate scope decision, documented (not invented):** this port's `var_mounts` tracking is scoped to skill-declared vars only — upstream's own `_compute_var_mounts` also includes the built-in `MEM_DIR`/`SKILLS_DIR`/`SKILLS_KERNEL_DIR`/`TRAJ_DIR`/`CHATRC` paths (they're always directories too), but those are already provably covered by the identityDir rw mount by construction and never change across wakes for one identity, so including them in the reattach-comparison set would add real complexity for zero behavioral difference. A real byte-parity differential (`parity/skill-env/run-parity.mjs`, sourcing the actual `thinkers/_lib/common.sh`/`bin/shellm` functions) caught one real divergence before it shipped: `collectSkillVars` must NOT accept the inline-JSON `metadata: {"shelllm": ...}` frontmatter form the way `bin/skills`'s own `_extract_shelllm_meta` does — `collect_skill_vars` itself only ever matches an INDENTED `env:` line, so it silently forwards nothing for a skill using only that form; `collectSkillVars` now has its own narrow extraction matching `collect_skill_vars` exactly rather than delegating to `skills.ts`'s (deliberately looser) `extractShelllmMeta`. 16 unit tests (`test/skill-env.test.ts`), 2 new `steprun.test.ts` scenarios (a skill-declared var reaches the exec env when set; not forwarded when unset), 2 new real-Docker `test/sandbox-env.test.ts` scenarios (a `--var DATA_DIR=<dir>` directory is readable inside the container at the same path; a var_mounts change refuses reattach with the exact message and never touches the running container), differential `parity/skill-env/run-parity.mjs` 9/9 PARITY against the real Bash functions. **Bug #70 fix (director-verified live run — `mem search` inside the sandbox got `connect ECONNREFUSED 127.0.0.1:<port>` ×5):** upstream rewrites a loopback `SHELLM_API_URL`/`LLM_API_URL` to `host.docker.internal` for a Docker sandbox's exec env (`_shellm_container_api_url`, bin/shellm:216-221, applied at bin/shellm:2659-2662/2679-2680/2712) and adds `--add-host host.docker.internal:host-gateway` to the container it starts, gated on the same loopback predicate (bin/shellm:1026-1034) — this port did both ONLY at install time (`src/init.ts`'s `localContainerUrl`, `src/install-lib.ts`'s `dockerForwardArgs`), never at run time, so a step's sandboxed `llm`/`mem search` kept the host-only loopback URL and failed to connect. Fixed in `src/sandbox-runtime.ts`: `containerApiUrl` (reusing the shared `net-url.ts` `urlIsLoopback`/`urlHostSwap` helpers `init.ts`/`install-lib.ts` already use) rewrites a loopback URL for the container; `applyDockerApiUrlRewrite` is the single exported call `src/steprun.ts`'s `runStep` makes, right after `selectSandbox` resolves `envType`, to rewrite ONLY `SHELLM_API_URL`/`LLM_API_URL` on the step's `execEnv` and ONLY when running in Docker (a local step, and the host-side `buildLlmClient` call, both keep the original URL — matching "the main shellm process keeps the host URL", bin/shellm:2657-2658); `startDockerSandbox`'s fresh `docker run` gains `--add-host host.docker.internal:host-gateway` under the identical predicate (`needsHostGateway`), so the alias and the rewrite can never disagree, matching upstream's own comment to that effect. **Scope note:** this port has no wired equivalent of upstream's process-vs-file endpoint-alias canonicalization (`resolveShellmApiUrl` in `src/shellm.ts` remains unwired — see the "callout (c)" entry above), so `SHELLM_API_URL`/`LLM_API_URL` are rewritten independently rather than from one canonical value; identical to upstream whenever the two already agree (the common case). Tests: `test/sandbox-runtime.test.ts` (rewrite matrix — 127.0.0.1/127.x/localhost/0.0.0.0/IPv6 `::1`/userinfo/port/path preservation/non-loopback passthrough; `applyDockerApiUrlRewrite` local-vs-docker; `--add-host` present/absent via a fake `docker` on 4 SHELLM_API_URL/LLM_API_URL combinations), `test/sandbox-runtime-docker.test.ts` (REAL docker daemon: a host-loopback HTTP listener is unreachable from inside the container using the unrewritten URL — curl's own connect-refused, exit 7 — and reachable via the rewritten `host.docker.internal` URL through the `--add-host` alias), `test/steprun.test.ts` "a Docker-mode wake sees LLM_API_URL rewritten to host.docker.internal in its sandboxed exec env" (full `runStep` wiring against a fake `docker` on PATH, no daemon). `parity/sandbox/run-parity.mjs`'s new `loopback-rewrite` scenario (see that file). |
| **identity-env** (`src/identity-env.ts`) | green | 100% | `resolveIdentityEnv`: the `activate` exports as a pure function (never writes `activate`, see Deviations) + `.env` layering (identity → `~/.headlong/.env` → `~/.shellm/.env`, fill-missing) + the PATH-shadow guard (our bin/ + node dir first). Exercised transitively by every daemon/CLI test. |
| `GET /api/identities/:id/dispatch` (`web/server/src/dispatchLog.ts`) | green | PARITY | Port of `headlong_web/logs.py` `parse_dispatch_log`/`_tail_lines`/`DISPATCH_STEP_RE`/`DISPATCH_FIRE_RE`: byte-equal event objects (same keys/order), tail-only backward-chunked read (max_events=2000), partial-first-line drop on a mid-file stop. Was previously a silent stub always returning `[]` (Thinkers page showed "No dispatcher.log found." even with a real log on disk). Faithfully reproduces DISPATCH_FIRE_RE's narrow match (only literal `dispatch -> `; `pending -> `/`fire pending -> ` fall to `kind:"other"`), verified against real upstream Python via `uv run`. 16 tests: `web/server/test/dispatchLog.test.ts`. |
| **web control plane** (`web/server/src/{control,safety,envfile,thinker-sync,usage,exportJobs,push,webpushCrypto}.ts` + `router.ts` mutations) | green | subset (Slice A + B + most of C + export + push) | Turns the read-only viewer into a live console: `POST /api/identities` (201), `POST .../chat` (200, empty/from_name 422), `POST .../thinkers/start\|stop` (200, "no thinkers" 409, `_checkedThinkerNames` 422/404/409, empty `names`→expand to all enabled so the boot-kick fires for each), `POST .../thinkers/:name/step` (202, fire-and-forget), `POST .../thinkers/:name/enable\|disable` (200, stop-first/needs_restart semantics), `POST /api/killall` (200 `{ok,dry_run,stdout,stderr}`, matching `control.py`'s `killall`/`KillallBody`/the viewer's `KillallResult`; never passes `--web`), `_requireControls` 403 BEFORE identity 404, library errors → 409 `{message,stderr,exit_code}`. `config.controls_enabled` flipped to the server's actual `--read-only`/`HEADLONG_READ_ONLY=1` state. server.ts buffers/validates the JSON body (1 MiB cap → 413, malformed JSON → 400) ahead of routing. Calls `src/{identity,identity-env,thinkersctl,chat,killall,llmCli,tar}.ts` DIRECTLY — no subprocess for in-process calls, and where a real second OS process IS needed (recap, the daemon) it's a detached `spawn(process.execPath, [<port .mjs>], {detached:true}).unref()`, never Bash (see Deviations "web control plane: library calls, not subprocess CLIs"). **Slice C, now real:** `GET`/`PUT`/`DELETE .../env` (envfile.ts: parse/upsert/delete + secret-peek redaction, `overridden` flag against the root `.env`), `GET`/`POST .../thinker-sync` (thinker-sync.ts: bundled-vs-installed diff + pull, subscriptions.jsonl/disabled preserved), `POST .../recap/refresh` (202, spawns `bin/recap.mjs` detached, 409 on an existing `recap/.lock`), `POST .../usage/refresh` (usage.ts: incremental mind-log+ledger offset cache, 202, 409 while running — GET `.../usage` stays the pre-existing "not computed" stub, unchanged, matching GET `.../recap`'s own precedent), `POST /api/llm-health/probe` (calls `runLlm` in-process, `{ok,latency_ms,model,provider}` or `{ok:false,error}`), `POST /api/identities/import` (server.ts raw-stream body: size cap + gzip magic bytes, `src/tar.ts`'s hand-rolled ustar/PAX reader, `identity.ts`'s `identityImport` — unsafe-path refusal, manifest.json format check, name resolution/conflicts, secrets/runtime-state stripped, live root-trajectory repair, dangling-symlink drop, kernel/bundled-skills regeneration; differential-proven against the real Bash `tools/identity export`+`import`, 6/6 PARITY, `parity/identity/run-import-parity.mjs`). `control.killall` accepts injectable `psSnapshot`/`dockerListing` overrides (threaded through `RouterCtx`, test-only) reusing `src/killall.ts`'s own seams, so route tests never touch a real process or container. **Routes-d lane, now real:** `GET /api/identities/:id/export` / `GET /api/export` (`control.ts` `buildIdentityExportBuffer`/`buildIdentityExportAllBuffer` call `src/identity.ts` directly — no `tar`/`gzip` subprocess, the archive is built as an in-memory `Buffer` and sent as the raw response body via a new `__raw_bytes` server.ts convention, `Content-Type: application/gzip` + `Content-Disposition: attachment; filename=...`; see the "identity export" module row for the exporter itself) and the export-jobs family (`web/server/src/exportJobs.ts`: in-process job Map mirroring server.py's `export_jobs` dict — `POST .../export-jobs` 202 (`setImmediate`-deferred build, matching upstream's detached thread so the response reflects `status:"running"`), `GET .../export-jobs` list, `GET`/`DELETE /api/export-jobs/:job_id`, `GET .../download` (409 while running); `EXPORT_JOBS_KEPT=5` eviction; a job holds the built `Buffer` directly instead of an on-disk tmp file — no `tar.unlink` cleanup needed, functionally identical bytes/headers/lifecycle from the HTTP client's side, see PARITY.md "identity export" row and the Deviations table). **NONE of the export routes are gated by `_requireControls`** (matching upstream's own comment: "Export stays available in read-only mode... it doubles as the backup path") — this port's `handleGet` has no controls concept at all (GETs are inherently non-mutating here) and the two export-jobs mutation routes explicitly skip the `ctx.controlsEnabled` check every other mutation route has. **Routes-d lane, also now real:** `GET /api/push/key` (a real VAPID public key, no longer the empty-string stub), `POST /api/push/subscriptions` (422 on a non-`pwa-`-prefixed or `CHAT_FROM_RE`-failing name, 422 on a non-`https://` endpoint, upsert-by-endpoint, returns the per-name subscription count), `POST /api/push/unsubscribe` (`{ok:true, removed}` — `removed:false` for an unknown endpoint is NOT an error, matching upstream) — both mutation routes ARE gated by `_requireControls` (unlike export). See the "web push" module row for the crypto/store/watcher itself. 151 tests: `web/server/test/controls.test.ts` (21) + `web/server/test/controls-slice-c.test.ts` (20: env/thinker-sync/recap/usage/llm-probe route-level) + `web/server/test/envfile.test.ts` (23 unit) + `web/server/test/import.test.ts` (8: control layer + real HTTP raw-stream layer) + `test/identity-import.test.ts` (20 unit, synthetic archives) + `web/server/test/export.test.ts` (16: direct export GET, all-identities GET, export-jobs full lifecycle incl. 409s/404s/eviction/read-only-mode, real HTTP headers) + `web/server/test/pushRoutes.test.ts` (13: key/subscribe/unsubscribe route-level) + `web/server/test/e2e-live.test.ts` (1, full HTTP create→start→chat→reply+reactive-wake→2 spontaneous wakes→stop against a real spawned daemon, deterministic LLM replay, no network). `/api/update` is still NOT implemented — see Gaps. |

| **web push** (`web/server/src/{push,webpushCrypto}.ts`) | green | PARITY (crypto, interop-proven) + faithful (watcher) | Port of `headlong_web/push.py`'s VAPID key store, name-scoped subscription store, and `PushWatcher`. `webpushCrypto.ts` reimplements what upstream gets from `py_vapid` (VAPID ES256 JWT, RFC 8292) and `pywebpush`/`http_ece` (RFC 8291 "aes128gcm" content encryption over the RFC 8188 record format) using `node:crypto` ONLY — no new dependency. Read from the actual `py_vapid`/`http_ece` source (a scratch venv, never installed into this repo) rather than assumed: PEM key format is PKCS8 (node:crypto speaks it natively for EC keys); JWT signature is raw r\|\|s (`dsaEncoding: "ieee-p1363"`), not DER; claims are JSON-serialized with SORTED keys and compact separators (py_vapid's own comment: "chrome seems to require the claims to be sorted"); the aes128gcm record's `keyid` field carries the SENDER's own ephemeral raw public point (RFC 8291's own convention, not empty as bare RFC 8188 would allow); node:crypto has no "import a raw EC point" API, so a minimal SPKI DER wrapper is hand-rolled for both the VAPID public key and a subscription's `p256dh`. **Real cross-language interop proof** (`parity/push/run-interop-proof.mjs`, driving a scratch Python venv via `PARITY_PYTHON`, never a repo dependency): 6/6 PASS — a py_vapid-generated PEM loads here with an identical b64url pubkey (and the reverse); a JWT signed here verifies with `py_vapid.jwt.decode` (and the reverse, verified here via `node:crypto`); an aes128gcm payload encrypted here decrypts with the real `http_ece.decrypt` against a Python-generated fake subscriber's own keys (and the reverse) — see `parity/push/report.md`. `push.ts` itself: `vapidPublicKey` (generate-on-first-use under `<root>/.web-push/vapid_private.pem`, mode 0600, dir mode 0700), the subscription store (upsert-by-endpoint JSON file, same-dir tmp+rename, `Path.with_suffix` quirk replicated — `subscriptions.tmp`, not `subscriptions.json.tmp`), `notificationsFor`/`buildPayload` (160-char truncation with `…`, `pwa-`-prefix + non-empty-content gate), `sendWebPush` (ttl=0, aud auto-computed from the endpoint's own scheme+host, 12h exp, `status > 202` failure check — matching pywebpush's own slightly-unusual threshold exactly), and `PushWatcher`/`startPushWatcher` (byte-offset trajectory-file tailing, complete-lines-only, dead-subscription pruning on 404/410, `setInterval` standing in for upstream's `threading.Thread` — wired into `index.ts` exactly where `cli.py`'s `_run_production` starts it: `if (!readOnly) startPushWatcher(root)`). 45 unit tests (`web/server/test/webpushCrypto.test.ts` 16, `web/server/test/push.test.ts` 29: store I/O, notificationsFor/buildPayload including the Python-`None`-in-an-f-string `tag` quirk, sendWebPush against a fake endpoint that decrypts the request with a fake subscriber's own keys — proving the payload round-trips, no live push — and PushWatcher end-to-end against a real trajectory.jsonl file). See Deviations for the `setInterval`-vs-thread and in-memory-vs-py_vapid-file-lock notes. |
| **self-update** (`web/server/src/selfUpdate.ts` + `router.ts` `POST /api/update`) | green | PARITY | Port of server.py's `self_update` route (`server.py:235-287`) plus its two small helpers `_git_info` (`68-84`) and `_schedule_restart` (`61-66`): resolved once at server startup (`server.ts createApiServer`, matching upstream's own "the code can't change under a running server" comment) rather than per-request. `POST /api/update`: `_requireControls` 403 first, then `HEADLONG_WEB_SELF_UPDATE=1`(`getenv`, HEADLONG_*/SHELLM_* fallback)-and-`!readOnly` gate (403 "Self-update is disabled..." otherwise), a process-wide non-reentrant lock (409 "Update already in progress" on a concurrent call — held forever on a successful update, "by design", since the process is about to restart), a real `git -C <repoRoot> pull --ff-only` (180s timeout; a genuine nonzero exit — e.g. `--ff-only` refusing diverged history — maps to 409 `{message: <last stderr line>, stderr}`; a true spawn failure or timeout maps to 500 `git pull failed: ...`), commit-before-vs-after comparison (`updated:false` on a no-op pull), `rmSync` on the built-frontend dir on a real update (`ignore_errors=True` equivalent — best-effort), and a `scheduleRestart` call (SIGTERM after 750ms, unref'd, injectable for tests) instead of upstream's own `threading.Timer`. `GET /api/config`'s `self_update_enabled`/`git_commit`/`git_branch` fields (previously hardcoded `false`/`null`/`null`) now reflect the real startup-resolved values. 18 tests (test/selfUpdate.test.ts) against REAL scratch git repos (a bare "origin" + working clones, never this checkout) — real fast-forward pulls, a real `--ff-only` divergence failure, concurrent-call locking, up-to-date no-ops, both route-level and library-level. |
| **tui** (`tui/headlong`, Rust, `headlong-tui`) | kept native | verified | Per this port's Rust-stays-native rule, upstream's `tui/` is vendored VERBATIM and UNMODIFIED (not reimplemented in TypeScript) — `cargo build --release` succeeds unmodified (cargo 1.96.1). It touches no identity files itself; every mode shells out to this port's `bin/traj`/`bin/chat`/`bin/thinkers`/`bin/identity`/`bin/skills` on `PATH`, using the env `resolveIdentityEnv()` derives. Verified headlessly (pty + `pyte` terminal emulation, no `tmux` on this machine) against a live identity (`quill`) written entirely by this port's engine, with its own dispatcher running: `chat` mode rendered quill's real `message` steps via `traj cat`, `thinkers` mode rendered live dispatcher/thinker status via `thinkers status`, `traj` mode streamed live reasoning/shell-output steps via `traj tail -r -n 50`, and `/skills` rendered quill's real skills via `skills list`. See `tui/PARITY-RECEIPT.md` for the full transcript and the one confirmed gap below. |
| **telegram bridge** (`src/telegram/*.ts` + `bin/headlong-telegram-bridge(.mjs)`) | green | PARITY | Full port of `headlong/telegram` (Python, `headlong_telegram`): `config` (env + `.identities`/`default`-symlink identity resolution), `naming` (`telegram-<user>-<chat>` chat-`from` encoding), `tgfmt` (markdown→Telegram-HTML, code-span preservation, sender-label sanitization, paragraph/line/hard chunking at 3900 chars), `allowlist` (approved/denied/pending JSON persistence, 24h pending-renotify window), `api` (`Bot`, every call→`result` or throws), `mindlog` (byte-offset trajectory follow, copied from the Slack bridge upstream too — kept in sync per its own docstring), `inbound` (DM-only gate, admin commands, dedup, delivery+retry), `outbound` (trajectory→Telegram, `source:"chat"` gate, allowlist gate both directions, HTML→plain fallback), and `cli` (argv/env parity with `cli.py` + the Bash launcher's local-dev `.env` loading — the launcher's checkout-root-discovery/`uv run --project` exec has no analogue in this single-repo port, not replicated). Zero Bash, zero Python, zero new runtime deps (Node's built-in `fetch`/`AbortSignal.timeout` stand in for httpx). Every upstream test in `telegram/tests` (40 cases: naming 4, tgfmt 8, allowlist 7, api 4, config 5, outbound 2, inbound 10) ported to vitest with the same cases and assertions; +22 supplemental cases for `mindlog`/`state`/`cli`, which have no upstream test files (`test/telegram-*.test.ts`). Differential `parity/telegram/run-parity.mjs`: real Python (`uv run` against the oracle's `telegram/` project, unmodified) vs the port, driven identically against one fake Telegram Bot API + fake `headlong-web` `/chat` endpoint (`fake-server.mjs`) — 15/15 scenarios PARITY (100%), 0 port bugs found, covering the admin approve/deny/revoke/list flow, stranger pending + one-prompt-per-day, group-chat drop+leave, media/bot drop, message_id dedup, `/start`, malformed admin usage, a multibyte+hostile-name delivery (proved byte-identical outbound JSON, not assumed), the real getUpdates poll loop + offset persistence, and 5 outbound scenarios (chat-sourced delivery, non-chat-source drop, unapproved-recipient drop, long-reply chunking, HTML-send-failure→plain-text fallback) driven against a REAL seeded `trajectory.jsonl` via the real `mindlog` module on both sides. See that harness's own header comment for its design (module-level driving of `Inbound`/`outbound.run` rather than the long-poll CLI binary itself, since neither language's real entry point has a bounded-exit knob; the Bot-API relay technique — the Python side reaches the fake server the same way the oracle's OWN `tests/test_api.py`/`tests/test_inbound.py` already do, by swapping `Bot._client` for an `httpx.MockTransport`, with the handler relaying over a real HTTP call instead of answering in-process). **The live leg is deferred**: no real Telegram bot token is available in this environment, so this harness (and this port) has never made a real call to `api.telegram.org` — see Deviations below for the adaptations this lane made. **Upstream sync 1c, lane H** (7d29f9e → 5458fee, PR #84 `06f1588..9a62727` squashed plus `44fe2f4`): send chat files as documents/photos (`filepayload.ts`, new — `filePayload`/`fileSignature`, PNG/JPEG magic-byte detection, the `file` alias rejected, caption/text leak-filtering via `stripLeakedCommand`, capped at 1024 chars), `api.ts` gains `sendDocument`/`sendPhoto` (multipart/form-data over `fetch`'s `FormData`/`Blob`, Node has no `httpx`-style `files=` kwarg), `outbound.ts` gains the file-payload branch (photo-then-document retry on `ApiError`, a `(failed to deliver file <name>)` notice when both the primary send AND the retry fail, `RecentPosts` dedupe keyed by `fileSignature` for files instead of raw text), a Slack-only `reaction` step is dropped before reaching Telegram, and a non-DM (`conv.user !== conv.chat`) destination is dropped. Non-string `content` (a legacy file step with object/array content) is treated as a decode error instead of throwing (21c62ba). `cli.py`'s bot-token log redaction (44fe2f4) has a narrower TS surface — see `logging.ts` and the Deviations table. 15 new unit tests (`test/telegram-filepayload.test.ts`), 4 new (`test/telegram-logging.test.ts`), 12 new `test/telegram-outbound.test.ts` cases, 3 new `test/telegram-api.test.ts` multipart-wire-format cases — 95 telegram unit tests total across 12 files. `parity/telegram/run-parity.mjs` extended with 9 new "outbound" scenarios (document/photo/JPEG sends, photo-failure-retries-as-document, file-send-failure-falls-back-to-notice, undecodable-content_b64-falls-back-to-notice, identical-file-steps-deduped, group-chat-destination-dropped, slack-reaction-step-not-posted) plus a multipart-aware body comparator (`parseMultipart` in run-parity.mjs, `bodyBase64` in fake-server.mjs — httpx and Node's fetch/undici each generate their own multipart boundary string, so raw-text body comparison would never match even for semantically identical requests; parsed fields/filenames/bytes are compared instead) — re-run against upstream-next (`5458fee`) at 24/24 PARITY (was 15/15; all 15 pre-existing scenarios unchanged and still green). |
| **slack bridge** (`src/slack/*.ts` + `bin/headlong-slack-bridge(.mjs)`) | green | PARITY (module-level; live Socket Mode leg deferred) | Full port of `headlong/slack` (Python, `headlong_slack`): `config` (env + `.identities`/`default`-symlink identity resolution, `SLACK_CLI_XOXB`/`XAPP` fallbacks, `SLACK_THREAD_FOLLOWUPS`), `naming` (`slack-<user>-<channel>[-<thread_ts>]` chat-`from` encoding), `slackfmt` (markdown→Slack mrkdwn, code-span preservation, entity/link cleanup, paragraph/line/hard chunking at 3900 chars), `mindlog` (byte-offset trajectory follow — identical logic to `src/telegram/mindlog.ts`, mirroring upstream's own "copied from headlong_slack.mindlog, keep in sync" relationship between the two Python packages), `state` (`Deduper` bounded event-id set, `ActiveThreads` persisted-with-TTL thread-followup set), `inbound` (`SlackNames` display-name/place cache, the `_on_event` gate — bot_id/subtype skip, DM vs. mention vs. thread-followup routing, dedupe — and delivery+retry+Slack-error-fallback), `outbound` (trajectory→Slack, `source:"chat"` gate, markdown conversion, `RecentPosts` dedupe, per-chunk-failure-breaks-the-loop — no HTML/plain fallback branch here, unlike telegram, because Slack's `chat.postMessage` `text` field has no separate parse-mode failure mode to fall back from), and `cli` (argv/env parity with `cli.py` + the Bash launcher's local-dev `.env` loading, same pattern as telegram's `cli.ts`). `headlong_slack` itself has NO `api.py`/Socket-Mode module of its own — it is a pure client of the `slack_bolt`/`slack_sdk` pip dependency — so this port adds two from-scratch, dependency-free modules with no direct upstream file to port 1:1: `api.ts` (a `WebClient` over `fetch`, wire format read directly from the installed `slack_sdk` source — see parity/slack/run-parity.mjs's header for the JSON-vs-form-encoding split it found) and `socketmode.ts` (a Socket Mode transport over the native `WebSocket`, implemented from Slack's public protocol description, not from `slack_bolt`'s source). Zero Bash, zero Python, zero new runtime deps. Every upstream test in `slack/tests` (25 cases: naming 4, config 5, mindlog 5, slackfmt 9, outbound 2 — the run-filters-by-`source` case plus `test_recent_posts_dedupe`, moved here from `test_slackfmt.py` to sit next to the `RecentPosts` class it exercises, matching where telegram's port put its own analogous case) ported to vitest with the same cases and assertions, plus 50 supplemental cases (4 more config cases, 3 more outbound cases, and the whole of `inbound`/`state`/`api`/`socketmode`/`cli`, which have no upstream test files at all) — `test/slack-*.test.ts`, 75 total. Differential `parity/slack/run-parity.mjs`: real Python (`uv run` against the oracle's `slack/` project, unmodified) vs the port, driven identically against one fake Slack Web API + fake `headlong-web` `/chat` endpoint (`fake-server.mjs`) — 15/15 scenarios PARITY (100%), 0 port bugs found, on the first real run, covering DM/mention/thread-followup routing, dedupe, bot_id/subtype drop, delivery-retry-then-Slack-error-fallback, an unsanitized hostile-display-name delivery (Python has no name sanitization in the header-assembly path either — reproduced faithfully, not fixed), and 5 outbound scenarios (chat-sourced delivery, non-chat-source drop, chunking, a `chat.postMessage`-failure breaking the chunk loop, `RecentPosts` dedupe). See that harness's own header comment for its design (module-level driving of `Inbound._on_event`/`.onEvent` and `outbound.run` rather than the Socket-Mode-blocking CLI binary itself; no relay was needed for the Slack Web API leg — unlike telegram's Bot-API relay — because `slack_sdk.WebClient` takes a `base_url` constructor argument, found by reading its source directly). **The live Socket Mode leg is deferred**: no real Slack bot/app-level token is available in this environment, so this harness (and this port) has never made a real `apps.connections.open` call or held a real WebSocket connection to `slack.com` — `socketmode.ts`'s transport logic is exercised only against a fake `WebSocket` in `test/slack-socketmode.test.ts` — see Deviations below for the adaptations this lane made. |
| **init** (`src/init.ts` + `bin/headlong-init.mjs`) | green | PARITY (deterministic paths) | Full port of `tools/headlong-init`'s bootstrap flow: the Docker sandbox consent gate (`HEADLONG_FAKE_DOCKER=ok\|down\|missing`, `HEADLONG_UNSANDBOXED` persistence + sticky-choice, `--dry-run`, in-container auto-bypass), cloud API-key resolution (`_have_key`/`_key_var_for`/`_default_model_for`/prefix-based `_reconcile_key_vars`, hidden-input `_prompt_key` with the OpenAI-vs-OpenCode disambiguation, 3-attempt revalidation-vs-first-run distinction), the local OpenAI-compatible endpoint flow (`_local_base_url`/`_local_chat_url`/URL-safe-display/host-swap helpers now shared with install.mjs in `src/net-url.ts`, `/v1/models` probing, model-id shell-metacharacter validation, `host.docker.internal` rewriting for both host and full-container installs, local-to-cloud switch staging + `_commit_local_wipe` only after a real validate), the identity interview + LLM-authored persona (starter template asset added at `src/assets/identities/starter-persona.md`) with placeholder-substitution fallback, first-memories, `thinkers start monolith responder` (in-process `thinkersStart`, not a subprocess — same function `bin/thinkers.mjs` itself wraps), the dash, and `status.json`. 28 unit/integration tests (`test/init.test.ts`) covering every scenario in `tests/test_sandbox_gate.sh` and `tests/test_local_llm_setup.sh` with a real local HTTP server reached via `fetch()`. Differential `parity/init/run-parity.mjs` (real Bash `tools/headlong-init` vs the port, both under `HEADLONG_NO_TTY=1 HEADLONG_NO_THINKERS=1 HEADLONG_NO_DASH=1`): 7/7 executable scenarios PARITY, 0 PORT-BUG (sandbox-gate matrix + a dead-endpoint scenario); 3 scenarios needing the fake local-provider server are SKIPPED — this sandbox's subprocess `curl` cannot reach even a loopback HTTP server (confirmed separately: this same script's own `fetch()` reaches the identical port fine), and the real Bash's local-provider path shells out to curl, so those 3 scenarios cannot execute here — the SAME code path is exercised end-to-end (real server, real fetch) by `test/init.test.ts`'s own local-provider tests. Also run via `parity/upstream-tests/run.mjs --installer`: `tests/test_sandbox_gate.sh` 26/26 full parity against the port (see the Installer lane section of `parity/upstream-tests/report.md`). Deviations (all documented at the call site in `src/init.ts`'s file header and PARITY-noted below): no curl auth-tempfile (fetch takes a Bearer header directly); `persona` is not shipped by this port, so `_link_persona_command` is a no-op and the summary's `persona <name>` command names a tool this port doesn't ship yet (see Gaps); the dash is `node web/scripts/dev.mjs` (API + Vite viewer) rather than upstream's `headlong-web`, with its own dependency-bootstrap and readiness-detection text; `identity`/`thinkers` are called in-process rather than as PATH subprocesses. |
| **install** (`install.mjs` + `src/install-lib.ts`) | green | PARITY (checkout mode + local-repo bootstrap) | Full port of `install.sh`: checkout mode (`node install.mjs [options]`) and the one-liner bootstrap (`curl -fsSL <url>/install.mjs \| node - [options]`, clone to `$HEADLONG_HOME/app` then re-exec `--symlinks --init`), `--symlinks`/copy install of this port's 16 `bin/` CLIs (not upstream's list — see Deviations), a Rust TUI build when `cargo` is present, `app_dir` recording, PATH detection/rc-file offer/shadow-warning (`_ensure_path`/`_warn_shadowed`), and the whole-agent-in-Docker menu (`_offer_docker_install`/`_location_offer_available`) including `_docker_forward_args`'s secret-argv hygiene — provider/local-server keys and the (possibly `host.docker.internal`-rewritten) local server URL are forwarded to `docker run` by bare NAME, resolved from the spawned docker process's OWN environment, never inlined into its argv, matching `tests/test_install_secret_argv.sh`'s pinned rule. 16 unit tests (`test/install-lib.test.ts`), including a real `git clone --branch` against a local repo (no network) proving the bootstrap plan end to end, plus a manually-verified real piped run (`cat install.mjs \| node - --no-init`) against a local clone at a non-default branch, matching `smoke_install.sh`'s one-liner-mode shape. `install.mjs` itself is deliberately import-free until a real checkout is confirmed on disk (see its file header) — `node -` (piped stdin) has no real file location for a relative import, so the bootstrap phase duplicates a minimal inline `git clone` rather than importing `src/install-lib.ts` (which IS reachable, and is what the re-exec'd checkout-mode run uses for everything else). Also run via `parity/upstream-tests/run.mjs --installer` against `smoke_install.sh`/`test_uninstall.sh` — see Gaps for the resulting real, documented deviations (no global skills/thinkers staging) and the two scratch-technique artifacts (bash-source-array-literal checks, no-`.git`-in-scratch clone failures) that are not port bugs. |
| **status** (`status.mjs` + `src/status-lib.ts`) | green | PARITY | Full port of `status.sh`'s read-only report: checkout/commit/dirty-count, state-home `.env` key names + `SHELLM_MODEL`, tool count in `PREFIX`, PATH detection, per-identity mind status (`run/dispatcher.pid` liveness) with the default marked, dash status + URL, matching processes on the machine, and the commands available from this shell. No prompts, no mutation, no network. 5 unit tests (`test/status-lib.test.ts`). `status.mjs` resolves a real checkout on disk (self dir, then `$HEADLONG_HOME/app_dir`, then `$HEADLONG_HOME/app`) and dynamically imports `src/status-lib.ts` from that ABSOLUTE path, so the piped one-liner works from any cwd, not only from inside a checkout — same technique `uninstall.mjs` uses. `PATTERNS`/`DASH_PATTERN` (in `src/status-lib.ts`, reused by `uninstall-lib.ts`) reflect this port's actual process shapes (`node .../bin/dispatcherd.mjs`, `node .../thinkers/<name>/step`, `node .../web/scripts/dev.mjs`) rather than upstream's — there is no `traj tail`/`tail -F` subprocess to match at all (the daemon's `TrajFeeder` tails in-process, see the daemon module row). |
| **uninstall** (`uninstall.mjs` + `src/uninstall-lib.ts`) | green | PARITY | Full port of `uninstall.sh`, the reverse of install.mjs: discovers what's installed, stops matching processes (SIGTERM then a 2s grace period then SIGKILL, reusing status-lib's process patterns), lists what will be removed, confirms, removes the state home / tool links (including persona-pointing symlinks) / the PATH line, and backs up (or `--delete-identities`) the identity tree — with a checkout NOT under `$HEADLONG_HOME` (a user's own clone) and its `.identities` left untouched, matching upstream's `_app_is_ours` rule exactly. `--yes`/`--keep-identities`/`--delete-identities`/`--dry-run`/`--no-stop`/`--prefix`/`--help` all ported; a no-tty run with no `--yes` refuses (matching upstream's `die`). 12 unit tests (`test/uninstall-lib.test.ts`) mirroring every numbered scenario in `tests/test_uninstall.sh` (dry-run listing, the real removal + idempotent "nothing to do" re-run, `--delete-identities`, a user-owned checkout left alone, no-tty refusal, `--help`). Same real-checkout-discovery + absolute dynamic import as `status.mjs`; with no checkout found anywhere it still does a self-contained PREFIX-only "nothing to do" check inline (`uninstall.mjs`'s own header). Also run via `parity/upstream-tests/run.mjs --installer` against the real `tests/test_uninstall.sh`: mostly parity, 2 port-only failures both root-caused as scratch-technique/bash-artifact limitations already precedented for `test_status.sh` (`--daemon` lane), not port bugs — see `parity/upstream-tests/report.md`'s Installer lane section. |

## Deviations (deliberate, reviewed)

See also "Behavioral parity round" below for the deviations kept by that round.

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| sandbox | `docker exec` per-identity container | restricted local subprocess behind a `Sandbox` interface | keeps `pnpm test` daemon-free; SPEC §1.1 permits if env metadata reproduced (it is, in the shellm-run step). DockerSandbox is a drop-in seam. | characterization.test.ts (sandboxed bash runs, output lands) |
| Docker sandbox default image (DOC #65) | `SHELLM_DOCKER_IMAGE="${SHELLM_DOCKER_IMAGE:-ubuntu:latest}"` (bin/shellm:139, `--docker-image` help text at bin/shellm:291) | `DEFAULT_DOCKER_IMAGE = "node:24-bookworm"` (`src/sandbox-runtime.ts:125`) | required, not cosmetic: this port's tool shims the sandbox mounts (`traj`/`mem`/`skills`/`context`/`llm`/`chat`/`recap` under `id.binDir`) are Node/TS, not upstream's Bash — a bare `ubuntu:latest` has no `node` binary, so every shimmed tool call inside the container would fail immediately. `node:24-bookworm` is the smallest bump that guarantees Node ≥22.18 + bash (SPEC §7). | the running mind observes a DIFFERENT sandbox on the port: `node`/`npm`/`corepack` are present (upstream's are not, unless a skill installs them), and Debian/bookworm's base package set differs from Ubuntu's (different `apt` package names/versions, different default locale/tzdata, no `ubuntu-*` metapackages) — anything relying on an Ubuntu-specific tool or package name behaves differently. Overridable on either side with the SAME env var, `SHELLM_DOCKER_IMAGE` (`src/sandbox-runtime.ts:161`), so a caller that needs upstream's literal `ubuntu:latest` (accepting the shim-tool breakage) or a different Node base can set it explicitly. | `src/sandbox-runtime.ts`'s own `DEFAULT_DOCKER_IMAGE` constant; no test asserts the literal image tag beyond the existing DockerSandbox suite's image-mismatch/reattach coverage (bug #32, see the module table above) |
| trace-04 delivery | monolith acts, result never delivered (a Headlong quirk) | reproduced faithfully, NOT fixed | rule: don't fix the source while porting; the fix is a downstream product decision | topology.test.ts trace-04 case |
| dispatcher restart: lost wakes (wake ledger, `src/wakeLedger.ts`) | upstream Bash loses wakes across a dispatcher restart: feeders start at end of file (`tail -n 0 -F`), `run/pending/` is removed at boot and on stop, and the pending FIFO drops its oldest entry at 16. Measured in the restart-chaos experiment (`docs/LOSTWAKE.md`, 12 aggressive-plus-gentle runs, 600 messages, a local HTTP server serving scripted replies): **168/600 (28.0%)** messages never woke the responder, though every one reached the recipient's trajectory and the sender saw it sent | the unfixed port had the same defect (**128/600, 21.3%**, 141 restarts). With the ledger: **0/600** (136 restarts) plus **0/150** in three `kill -9` stress runs (56 restarts, a restart every 0.5 to 1.5 s, 1.5 s model calls). Design: the dispatcher alone writes `run/ledger/<thinker>.jsonl` (append-only; `recv` when a message or action step is routed to a thinker, before it is dispatched or queued and before the cursor passes it; `done` only when that thinker's step exits 0) and `run/cursor/<sha1(file)[0:16]>` (`{file, ino, offset}`: the byte offset up to which complete lines were fed and ledgered). On start it re-queues owed steps, then the cursor gap, then starts the feeder where that read ended; a step the trajectory already answers (`trigger_step` equal to it, `source` equal to the thinker) is marked consumed, not re-run; past 16 pending the owed steps wait in an in-memory overflow queue, not dropped. Only `message` and `action` steps are replayed; other step types keep upstream's no-replay rule. Trajectory format, the frozen `run/` files and every existing `dispatcher.log` line are unchanged; the two new `run/` directories and a few new log lines are additive. **`THINKERS_WAKE_LEDGER=0` restores upstream behaviour** (tested) | upstream's behaviour silently drops messages a person or another bot already sent; the port is meant to be a faithful reproduction, so this is a deliberate, opt-out divergence, not a bug fix presented as parity. `ThinkerDef.run` now returns `Promise<void \| number>` (exit code) so that consumed means the step succeeded | `test/wake-ledger.test.ts` (18 tests, incl. real `bin/dispatcherd.mjs` kill -9 and the off-switch); `parity/lostwake/run-lostwake.mjs` and `results/*.json`; `parity/daemon/run-parity-adversarial.mjs` (frozen run files unaffected) |
| traj required-flag value MISSING or EMPTY (`--traj_dir`, `--slug`, `--field`, `--child`, `--step-id`, `-n`, `-C`, `--parents`, `--children`, `--filter`) | Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""` | clean `traj: error: <cmd>: <msg>`, exit 1 (same stdout=empty + on-disk state unchanged) | same rationale as mem/skills/recap/llm: Bash's text embeds the script's absolute path + a Bash line number — irreproducible from TS and brittle to pin; only stderr wording differs on a misuse path no Headlong caller inspects | parity/traj — every `*-missing-value`/`*-dies` scenario that hits a required flag |
| traj `show`/`last` `--field` on a jq-abort-family malformed input (invalid JSON in the resolved step) | `set -euo pipefail` + a jq parse failure aborts the whole script with jq's own exit code (5) and jq's own message | dies with its own `<cmd>: <file>: invalid JSON in last step`-style message, exit 1, at the same logical point | same jq-abort-family rationale as recap/llm: a jq exit code + wording leaking through `set -e` is not a contract; the port fails at the same point with a uniform message | src/trajCli.ts cmdLast (PORT-NOTE) |
| traj `tail -r`/`cat -r` (`--recursive`) on a normal (Z-suffixed) trajectory | bin/traj's `_sorted_tree_steps` `to_epoch` jq filter (bin/traj:776-786) falls into its no-offset fallback branch for any plain `...Z` timestamp, whose `.dt + "Z"` re-appends a SECOND `"Z"`; on this system's jq, `fromdateiso8601("...ZZ")` HARD ERRORS (confirmed standalone), and `2>/dev/null \|\| true` silently swallows it — `-r`/`--recursive` on `tail`/`cat` emit ZERO bytes on ANY normal trajectory (isoTs() always writes `Z`), not an edge case | correctly interleaves and prints every step from every file in the tree, sorted by timestamp | an unintended Bash/jq crash artifact, not designed behaviour — same class as the skills `set -e` crash-smoothing and put's mv-into-directory-accident deviations: don't degrade the port to reproduce an accidental crash that empties a real, documented feature. The port's `toEpoch()` strips a duplicate trailing `Z` before parsing | parity/traj tail/recursive, cat/recursive (both DEVIATION, not DIVERGE, in results.json) |
| traj `merge`/`fork` child resolution search directory | `${TRAJ_DIR:-$traj_dir}` / `${TRAJ_DIR:-$parent_dir}` (bin/traj:1300,1360) reads the ENV var specifically, not the `--traj_dir` FLAG, falling back to the parent's own resolved directory — a child created as a sibling (not nested under the parent, and not found via env `$TRAJ_DIR`) genuinely fails to resolve in real Bash too | reproduced exactly (`io.env.TRAJ_DIR \|\| parentDir`) | faithful replication, not a port bug — confirmed against real Bash with the identical fixture; a realistic caller either has `$TRAJ_DIR` set for the whole session or nests the child via `fork` (which passes the parent's own dir to `cmd_new`, an entirely different path) | test/trajCli.test.ts "merge" describe block comment; parity/traj merge/basic (env TRAJ_DIR set, as a realistic caller would) |
| mem required-flag value MISSING or EMPTY | Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""` | clean `mem: error: <msg>`, exit 1 (same stdout=empty + unchanged state) | Bash text embeds the script's absolute path + a Bash line number — irreproducible from TS and brittle to pin; only stderr wording differs on a misuse path no caller inspects. Covers --dir, add --type, list --type/--before/--after, edit --slug, and their empty-string forms (M1: `required()` now rejects `""`, was silently accepted). | parity mem: dir-missing-value, list-type-missing-value, empty-required/*; test/mem.test.ts "empty-string required flag values (M1)" |
| recap required-flag value MISSING or EMPTY | Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""` | clean `recap: error: <msg>`, exit 1 (same stdout=empty + on-disk state unchanged) | same rationale as mem/skills/llm: Bash's text embeds the script's absolute path + a Bash line number — irreproducible from TS and brittle to pin; only stderr wording differs on a misuse path no caller inspects. Covers --traj_dir, --window, --budget, --raw-tail, --fanout, --gap-minutes, --model, --map-model, --reduce-model, and their empty-string forms. | parity/recap global/missing-flag-value, global/empty-flag-value |
| recap invalid-octal numeric flag value (--window/--fanout) | a leading-zero digit string with an 8/9 digit (`019`, `09`) fails Bash's own `[[ "$N" -ge 10 ]]` numeric-context test; bash prints ITS OWN diagnostic line before the script's die(): `<script>: line N: [[: 019: value too great for base (error token is "019")` + `recap: error: --window must be a number >= 10` | `recap: error: --window must be a number >= 10` (die text only) | same class as the `${2:?}` row — a bash-builtin's own diagnostic leaking to stderr, embedding an absolute path + line number, unreproducible from TS; exit code, stdout, and on-disk state all match | parity/recap adversarial flags/window-octal-invalid-extra-stderr-line, flags/fanout-octal-invalid-extra-stderr-line |
| recap lock reclaim mkdir diagnostic leak (non-empty stale lock dir) | a stale-aged (>30min) but NON-EMPTY lock dir (filesystem debris, or a second writer's temp file) makes Bash's `rmdir` fail silently, then the subsequent `mkdir "$LOCK"` ALSO fails (dir still exists) and PRINTS ITS OWN diagnostic before the script's die(): `mkdir: <path>/.lock: File exists` + `recap: error: another recap is in progress …` | `recap: error: another recap is in progress …` (die text only) | same class as the `${2:?}`/octal rows — `mkdir(1)`'s own diagnostic leaking to stderr, unreproducible from TS; exit code and the die message match | parity/recap adversarial lock/concurrent-shape-lock-nonempty-refuses-rmdir |
| recap corrupt/missing episodes.jsonl or themes.json (jq-abort family) | a jq parse/open failure on a corrupt or (for `--cached` print) missing episodes.jsonl/themes.json aborts under `set -e` with jq's OWN message + jq's OWN exit code — 2 for a file-open failure (`jq: error: Could not open file …/episodes.jsonl: No such file or directory`), 5 for a parse error (`jq: parse error: Invalid numeric literal at line 1, column 5`) | `recap: error: episodes.jsonl: Could not open …` / `recap: error: themes.json: parse error: …` (JSON.parse's own message), exit 1 uniformly | a jq exit code + wording leaking through `set -e` is not a contract (same rationale as the llm module's identical-class row); the port fails at the same logical point with its own message. stdout and on-disk state (where applicable) match | parity/recap adversarial cache/themes-present-episodes-missing-print, cache/themes-json-corrupt-print-text, cache/episodes-jsonl-last-line-corrupt-resume, jqabort/corrupt-episodes-last-line |
| recap episodes.jsonl missing separator newline after a crash mid-append | neither Bash's `>>` append nor the port's `fs.appendFileSync()` inserts a newline before appending to an episodes.jsonl whose last byte isn't already `\n` (a plausible crash-recovery artifact) — BOTH sides produce the identical malformed `...}{...}` on-disk concatenation. Downstream, Bash's reduce-time `--argjson` parse of the corrupt joined text fails with jq's own usage banner (`jq: invalid JSON text passed to --argjson`, exit 2, after 2 llm calls) | the port's resume-parse step fails ONE STEP EARLIER, before the reduce llm call, with JSON.parse's own message, exit 1 | same jq-abort family, but reachable from ordinary crash recovery, not only an adversarial LLM reply; since the port stops earlier, call count and cached state after that point necessarily differ too | parity/recap adversarial cache/episodes-jsonl-no-trailing-newline-resume |
| recap first-ever run with zero renderable steps (unguarded episodes.jsonl open) | on a first-ever run (no prior cache) whose trajectory renders zero steps (empty file, or every line filtered), Bash's `_reduce_themes` still runs (themes.json is missing) and does `wc -l < "$EPISODES"`; `$EPISODES` was never created, so bash's OWN `<` redirection fails and aborts under `set -e` (`<script>: line 350: …/episodes.jsonl: No such file or directory`) before ever reaching the script's own "no recap yet" check | `reduceThemes()` reads the missing file as `""` (0 episodes) with no crash, and `runRecap` reaches its OWN deliberate `die("no recap yet — run without --cached to generate one")` | Bash's failure is an accidental artifact of an unguarded file-open in a branch the original author likely never exercised with zero episodes, not a designed error path — same class as the skills `set -e` crash-smoothing deviations: don't degrade the port to reproduce an accidental Bash crash. Exit code coincidentally matches (1); only stderr text differs | parity/recap adversarial traj/empty-file-zero-bytes, traj/non-string-source-field-truthy-nonstring |
| recap arithmetic on an unset-shell-variable-shaped env value (`set -u`) | an env value shaped like a bare shell identifier (e.g. `RECAP_CONTEXT_BUDGET_MAX=notanumber`) is fed straight into bash arithmetic (`(( budget > cap ))`); bash re-dereferences it AS A VARIABLE NAME, finds it unset, and this script's `set -u` aborts immediately: `<script>: line 543: notanumber: unbound variable`, exit 1, no output, no cache written | `recap: error: notanumber: unbound variable`, exit 1, no output, no cache written (F2 below) | same class as the `${2:?}` row — Bash's diagnostic embeds its own script path + line number, unreproducible from TS; exit code, stdout, and on-disk state all match | parity/recap adversarial context/budget-cap-env-non-numeric-identifier |
| recap LLM reply is not a JSON object at the top level (map/reduce/rollup) | `$body.title`/`.arc`/`.summary` etc. on a non-object top-level reply (array/string/number) aborts under `set -e` with jq's own exit 5 + message, e.g. `jq: error (at <unknown>): Cannot index string with string "title"`; the map call also leaves a stray ZERO-BYTE episodes.jsonl (the `>>` redirect creates/truncates the file before jq fails) | `recap: error: episode 1: Cannot index string with "title" (model reply is not a JSON object)`, exit 1; leaves NO episodes.jsonl at all (mkdirSync makes the empty recap/ dir; nothing is written before the throw) | a jq exit code + wording leaking through `set -e` is not a contract; the port fails at the same logical point with a uniform message. The port's own PORT-NOTE (bodyObj()) promised this row | parity/recap adversarial llm/map-string-top-level-reply-then-ok, llm/map-number-top-level-reply-then-ok, jqabort/map-reply-is-array, jqabort/reduce-reply-is-array, jqabort/reduce-reply-is-string, jqabort/rollup-reply-is-array |
| recap well-formed reply, malformed downstream reduce-time shape | a well-formed map reply whose `themes`/`key_steps` field has the wrong shape (e.g. an object instead of an array) succeeds through episode summarization and only aborts DOWNSTREAM, at reduce/print time, indexing into the constructed themes.json — jq's own exit 5 + message at that later point, e.g. `jq: error (at themes.json:12): Cannot index number with string "episodes"` | fails at the analogous later point with its own message, exit 1, e.g. `recap: error: themes.json: string and number cannot be added` | same jq-abort family; the two implementations reach the type error via slightly different downstream paths so the exact field name/message differs, but exit code + stderr diverge the same way. On-disk state matches (both sides write the same episodes.jsonl/themes.json up to that point) | parity/recap adversarial llm/map-themes-is-object-not-array, llm/map-reply-with-del-and-unicode-title |
| recap huge (>1MiB) LLM reply: port completes, Bash hits the OS ARG_MAX | Bash's `$(printf … \| llm …)` has no output-size limit and captures a huge reply fine; the huge body is then re-passed to jq as a `--argjson` COMMAND-LINE ARGUMENT, which hits the OS's ARG_MAX and fails to exec: `<script>: line 330/369/568: /usr/bin/jq: Argument list too long`, exit 126, no further calls, no output | F1 below gives spawnSync an unbounded maxBuffer, so the reply is captured and processed entirely in-process (no argv involved) — the run completes normally, exit 0, full stdout/cache state (the map scenario needs one MORE llm call than Bash ever reaches, for the reduce stage) | Bash's failure is an OS/jq argv-length artifact, not designed behaviour; reproducing it would mean simulating the local ARG_MAX and jq's own argv handling — not worth chasing. The port now at least SEES a huge reply instead of silently discarding it via an unrelated maxBuffer error (the bug F1 fixes) | parity/recap adversarial llm/map-huge-reply-exceeds-node-maxbuffer, llm/reduce-huge-reply-exceeds-node-maxbuffer, llm/rollup-huge-reply-exceeds-node-maxbuffer |
| llm: keep-alive lines before the first data line cost upstream quadratic time (bash string append) | `bin/llm`'s stream readers append every line seen before the first `data:` line to `_err_buf` with `_err_buf="${_err_buf}${line}\n"`, a full copy per line, so the cost grows with the square of the line count. Measured against a well-formed stream (chunked, terminating chunk, `data: [DONE]`, keep-alive comment lines, then `finish_reason: length` with no content), `LLM_RETRIES=0`: 4,000 lines 1.4 s, 16,000 lines 21.6 s; the >1 MiB recap fixture (49,152 lines) takes minutes per attempt, times 3 attempts | `src/llmProvider.ts` appends to a JS string (amortised linear) and reads the same stream in well under a second, warns `output truncated at max_tokens`, retries the empty reply, and recap carries on | not a hang and not a malformed fixture: the input is well formed and every byte arrives; upstream is just slow on it. A real provider sends keep-alive comments before the first token while it thinks, so the shape is realistic, though rarely this long. The port's linear behaviour is the sane one and is kept | parity/recap adversarial llm/map-capped-stream-over-1mib, llm/reduce-capped-stream-over-1mib, llm/rollup-capped-stream-over-1mib (upstream killed at the harness's 120 s per-invocation limit) |
| skills required-flag value MISSING or EMPTY | Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""` | clean `skills: error: <msg>`, exit 1 (stdout empty + on-disk state unchanged) | same rationale as mem: Bash's shell-builtin text embeds an absolute path + line number, brittle and worse than the port's uniform error form. The prior port threw an UNCAUGHT `SkillsError` from the flag loop → a Node stack trace; now routed through `fail()`. Covers --dir/--remotes/--format/--name/--description and their empty-string forms (M1: `req()` now rejects `""`; `init --description ""` dies without scaffolding). | parity skills global/{dir,format}-missing-value, empty-required/*; test/skills.test.ts M1 cases |
| skills set-e-crash smoothing | Bash aborts under `set -e`/`pipefail`: a name-less/desc-less skill trips `name=$(grep '^name:')` (list → rc 1, no listing); empty/EOF stdin trips `read -r reply` in remove (rc 1, no "Cancelled."). The basename/cancel fallbacks are dead code in Bash. | port reaches the fallback the surrounding code was written for: lists the skill with basename name / empty description (rc 0); prints "Cancelled." (rc 0). On-disk state is identical (skill listed / kept). | rule: don't degrade the port to reproduce a `set -e` crash of paths the source clearly intended to reach. Only stderr + exit differ; stdout(list)/on-disk match. **The name-less-skill case is BEHAVIORAL, not cosmetic:** `skills list`/`prompt` is a CONSUMED happy-path the monolith reads into context, so a real name-less skill yields *different context* between source (listing aborts) and port (extra basename row). Still kept-graceful, but downstream consumers should know. | parity skills list/{name-fallback-basename,description-missing-crash}, remove/empty-stdin-cancel |
| put `--force` onto an existing directory (mv-into-directory accident) | Bash `mv -f "$tmp" "SOMEDIR"` treats an existing directory target as "move INTO it": lands `SOMEDIR/put.XXXXXX` with the right bytes, then the script's own `wc -c < "$file"` fails on the now-directory path — exit 1, with a stray `put.XXXXXX` stranded inside SOMEDIR (the `trap … EXIT` cleanup had already disarmed after the successful mv). | `fs.renameSync` does a literal POSIX rename with no "move into an existing directory" fallback; it throws EISDIR immediately (exit 1) and the catch removes the temp before rethrowing — SOMEDIR is left exactly as found, empty or not, no stray file. | unintended Bash accident, not designed behaviour — same class as the skills `set -e` crash-smoothing deviations above: don't degrade the port to reproduce an accidental mv side effect. Both sides fail nonzero and write nothing usable; only the port avoids the leaked temp file. | parity/put osfail/existing-empty-dir-force-mv-into-dir-accident; test/put.test.ts "FILE names an existing directory with --force (mv-into-directory accident — deviation #3c)" |
| mem edit summary byte-truncation on a split multibyte char (S1) | `head -c 80` writes the raw partial bytes (dangling, invalid UTF-8) when byte 80 splits a char | `Buffer.subarray(0,80).toString("utf8")` replaces the split char with U+FFFD (`EF BF BD`) | on-disk summary bytes differ ONLY when an edited first line > 80 bytes splits a multibyte char exactly on the 80th byte; the port keeps valid UTF-8 rather than a dangling byte. `mem add`'s summary is char-sliced (code-point-aware, M2) and unaffected. | src/mem.ts summaryBytes |
| mem list positional limit N (S3) | Bash `case [0-9]*` → shell arithmetic + `tail -n`; non-plain-integer forms (`08`/`09` octal, `3.5`, `1e1`, `3abc`, dates) error, list ALL, and print a Bash arithmetic-error stderr line | port applies the limit for any finite `Number(a)` | diverges on non-plain-integer positionals: row count and/or the Bash stderr line the port omits. Plain non-negative integers match. Reachable if the model zero-pads a count or mistypes a date as the positional. | src/mem.ts actionList |
| .memrc inline `# comment` (S4) | `source .memrc` treats an unquoted trailing `#…` as a shell comment | the `KEY=VALUE` regex captures the rest of the line, comment included | `MEM_TYPE=fact # note` → Bash `type: fact`, port `type: fact # note`. `.memrc` is parsed as simple `KEY=VALUE` assignments (documented simplification), not sourced as shell — inline comments and other shell constructs are not interpreted. | src/mem.ts parseMemrc |
| llm required-flag value MISSING or EMPTY | Bash `${2:?msg}` → `<script>: line N: 2: <msg>`, exit 1 | clean `llm: error: <msg>`, exit 1 (no request, no state) | same rationale as mem/skills. Covers -m/-s/--system-prompt-file/-t/-M/--provider/--effort. | parity llm args/*-missing-value, *-empty-value |
| llm `-M` that jq cannot consume | invalid JSON → jq parse error, exit 5; non-array with `-s` → jq "cannot be added", exit 5 | `llm: error: --messages is not valid JSON` / `… must be a JSON array (cannot prepend the system message)`, exit 1 | a jq exit code leaking through `set -e` is not a contract; every failure exits 1. Valid `-M` is passed through unvalidated (parity). | parity llm args/messages-invalid-json, messages-object-with-system |
| llm transport-failure wording (streaming path) | relays curl's text: `curl error: curl: (7) Failed to connect …` / `(18) transfer closed …` / `(28) Operation too slow …` on stderr and in the health-marker `message` | `request failed: <node detail>` | there is no curl; stdout (incl. partial streamed output), exit code, retry count and marker `kind` are identical. The non-streaming path never carried curl's text (`HTTP 000`) and is at parity. | parity llm stream/conn-refused, midstream-fail-no-retry, stall-no-bytes |
| llm non-JSON 2xx body (non-streaming) | `set -e` crash inside the jq checker: exit 5, silent, no marker, no retry On GNU/Linux the abort also leaves the response body behind as `$TMPDIR/tmp.XXXXXXXXXX` (`local_resp=$(mktemp)` is not in `_llm_cleanup`; GNU mktemp honours `$TMPDIR`); the macOS baseline did not show it. The port writes no temp file | `llm: error: API error: response body is not JSON (HTTP 200)`, exit 1, no marker, no retry | a silent crash is not a designed behaviour; fail at the same point, loudly | parity llm nostream/not-json-200 |
| llm unparseable SSE `data:` event | per-delta jq prints `jq: parse error …` to stderr, extracts nothing | skipped silently | stdout/exit/state identical; the noise line was never a contract | parity llm stream/bad-json-event-skipped |
| llm `.env` loading | `source`d in a subshell (arbitrary shell) | parsed as `[export ]KEY=VALUE` lines, like the port's `.memrc` | fill-only-missing (set-but-empty counts as set), cwd `.env` then state-home `.env`, cwd `.env` may set `HEADLONG_HOME` — all at parity; only shell constructs inside the file are not interpreted | parity llm dotenv/* |
| llm network guards | curl `--connect-timeout` / `--max-time` / `--speed-limit`+`--speed-time` | `LLM_MAX_TIME` = AbortController deadline (parity: `HTTP 000` non-streaming); `LLM_SPEED_LIMIT`/`LLM_SPEED_TIME` ≈ "no bytes for LLM_SPEED_TIME seconds"; `LLM_CONNECT_TIMEOUT` — **now applied** (RESOLVED), approximated as "time until `fetch()` resolves" (connect + TLS + request-send + time-to-first-byte) rather than curl's narrower TCP+TLS-only window, since fetch/undici exposes no connect-phase hook without a custom Dispatcher (the `undici` package as a new dependency, out of scope) | against a server that connects instantly but answers slowly, the Bash's connect-timeout never fires (connect itself was fast) while the port's broader timer can abort the call at the same deadline; identical once headers arrive before the deadline either way | test/llmCli.test.ts "LLM_CONNECT_TIMEOUT" cases (fires before headers, does not fire once headers arrive, `=0` disables); `parity/llm` stream/connect-timeout-* (2 byte-identical + 1 documented deviation `connect-timeout-approx`) |
| llm `user:pass@` in LLM_API_URL | curl uses the userinfo as Basic auth unless an explicit Authorization header is sent | userinfo stripped from the URL (fetch refuses it) and reproduced as `Authorization: Basic …` when no Bearer is set | same wire behaviour; the host-only warning is at parity | parity llm url/compat-basic-auth-from-url, keyed-warns-host-only-creds |
| llm 2xx JSON whose shape aborts the jq checker/extractor (non-streaming) | `{"error":"str"}`, `{"choices":"str"}`, a choice whose `error` is a string: `set -e` crash inside `check_response_openai` — exit 5, silent, no marker, no retry. `{"choices":[{"message":"hi"}]}`: crash inside `extract_text_openai` — exit 5, silent, AFTER the ok marker and ledger line On GNU/Linux the abort also leaves the response body behind as `$TMPDIR/tmp.XXXXXXXXXX` (`local_resp=$(mktemp)` is not in `_llm_cleanup`; GNU mktemp honours `$TMPDIR`); the macOS baseline did not show it. The port writes no temp file | dies at the same two points: `llm: error: API error: response shape is not readable (HTTP 200)` (before the marker) / `… response text is not readable (HTTP 200)` (after marker + ledger), exit 1, no retry | Bash crash artifact. F11 removed the port's silent success (it exited 0 with an ok marker); what remains is the exit code (1 vs 5) and the loud message, as for the non-JSON 2xx row | parity llm adversarial nostream/error-is-string-jq-crash, choices-is-string-jq-crash, choice-error-is-string, message-is-string-extract-crash |
| llm usage record with a missing leading/middle token field | `IFS=$'\t' read` collapses EMPTY leading/middle `@tsv` cells and shifts the remaining values left: usage `{completion_tokens:7, reasoning_tokens:3}` is recorded as `in_tok:7,out_tok:3`; `{prompt_tokens:120, reasoning_tokens:3}` as `in_tok:120,out_tok:3` | each token lands in its own field: `out_tok:7,think_tok:3` / `in_tok:120,think_tok:3` | deliberate fix of a source bug: the Bash misattributes tokens (the ledger and the dash then count them wrong) whenever a provider omits prompt_tokens or completion_tokens; the port records what the provider said. Complete records are byte-identical | parity llm adversarial stream/usage-missing-prompt-tokens-shift, stream/usage-missing-completion-tokens-shift, nostream/usage-missing-prompt-tokens-shift |
| llm `-M` documents that jq and JSON.parse consume differently | `-M null` with `-s`: jq `[sys] + null` is `[sys]` → sent; `-M " "`: jq emits nothing → an EMPTY body is POSTed and whatever comes back is printed; `-M "[1] [2]"`: jq streams two payload objects → a two-document body is POSTed; `-M '[…"\ud800x"…]'` (lone surrogate escape): jq parse error, exit 5 | `-M null` with `-s` dies `--messages must be a JSON array …` exit 1; whitespace-only and two-document `-M` die `--messages is not valid JSON` exit 1 (no request); the lone-surrogate text is accepted by JSON.parse and sent | absurd input: none of these is a messages array. The Bash outcomes are jq stream-parsing accidents (an empty or two-document request body); the port refuses up front — except the surrogate, which JSON.parse legitimately accepts | parity llm adversarial argv/M-null-with-system, M-whitespace-only, M-two-json-docs, M-lone-surrogate |
| llm NUL bytes in the prompt / system-prompt file | `$(cat)` / `$(cat "$f")` drop every NUL byte and print `warning: command substitution: ignored null byte in input` on stderr | NUL bytes are kept and reach the API as `\u0000` | absurd input: a NUL cannot live in a shell variable; the port has no such limit and sends the bytes it was given | parity llm adversarial argv/spf-nul-byte, stdin/nul-bytes |
| llm `.env` the Bash loader cannot source (`KEY = v`, CRLF line endings) | a `KEY = v` line matches the sed key regex but does not source → `!key: unbound variable` + `warning: could not read .env; ignoring it`, and loading STOPS there (later keys never load → wrong model/provider → die); a CRLF file keeps the `\r` in every value (`Unknown provider: openai-compatible\r`, exit 1) | `KEY = v` is skipped (not an assignment) and later keys load; lines are trimmed, so CRLF files work | Bash crash artifact for `KEY = v`; deliberate tolerance for CRLF (a `.env` saved on Windows is a real file, and the Bash failure is a confusing `\r` inside an error text) | parity llm adversarial dotenv/space-before-equals-aborts-bash, dotenv/crlf-file |
| llm unreadable `.env` | `sed: .env: Permission denied` on stderr, then the file is ignored | ignored silently | Bash artifact: the noise line comes from sed, not the tool; stdout, exit, state and request identical | parity llm adversarial dotenv/unreadable-file |
| llm HOME unset with no HEADLONG_HOME / SHELLM_HOME | `set -u` crash: `line 35: HOME: unbound variable`, exit 1, no request | the state home is `/.headlong`; the call proceeds (marker/ledger writes there are best-effort) | Bash crash artifact: an unset HOME is an environment fault, not a contract | parity llm adversarial dotenv/home-unset-no-headlong-home |
| llm `LLM_API_URL` without a host (`http://`) | `curl error: curl: (3) URL rejected: No host part in the URL` on stderr and in the marker message, exit 1, kind other | `request failed: Invalid URL`, exit 1, kind other | the transport-text family: there is no curl to quote. The host-only warning (`requests go to `) is at parity | parity llm adversarial url/empty-host-warning |
| llm API key containing a newline | curl emits a malformed request → the server answers 400 with no SSE data → `empty response: stream ended without emitting anything`, exit 1, kind other | fetch refuses the header value → `request failed: Headers.append: … invalid header value`, exit 1, kind other, no request | absurd input (a key with a newline is never valid); exit code and marker kind identical, only the message differs | parity llm adversarial keys/newline-key |
| llm error body holding several JSON documents | jq processes every document in the body: a streamed pre-data body `{"error":{"message":"one"}}\n{"error":{"message":"two"}}` dies `API error: one\ntwo`; the same as an HTTP 400 body dies `API error (HTTP 400): one\ntwo` — both into the marker message | one JSON document is parsed; a multi-document body is not JSON → `API error: <raw body>` / `API error (HTTP 400)`, marker message `HTTP 400` | absurd input (no provider returns two documents); exit code and marker kind (other) identical | parity llm adversarial stream/error-body-two-docs, nostream/http400-two-docs |
| llm non-string content re-serialized (jq keeps number literals) | a non-string `content` (object/array) is printed by `jq -r` pretty-printed WITH the original number literals (`1.0`, `1E+2`, `12345678901234567890`); the request payload keeps `-M` number literals verbatim too | `JSON.stringify` canonicalizes numbers: `1`, `100`, `12345678901234567000` (precision loss beyond 2^53) | absurd input for content (a delta/message content that is not a string); a JS number cannot carry a literal's text. Semantic JSON is equal below 2^53 | parity llm adversarial stream/delta-content-object-literal-1_0, nostream/content-array-literal-1_0 (stdout); argv/M-number-literals, argv/t-huge-int (raw request bytes only — parsed requests at parity) |
| llm non-integer LLM_RETRIES / LLM_RETRY_BACKOFF | `LLM_RETRIES=08`: bash arithmetic error (`value too great for base`) then `_max_attempts: unbound variable` — one request, exit 1, no marker; `LLM_RETRY_BACKOFF=1.5`: `arithmetic syntax error` at the first retry sleep — exit 1, no marker; `LLM_RETRY_BACKOFF=abc`: `unbound variable` at the first retry — exit 1, no marker, no answer | `08` → 8 retries (9 attempts); `1.5` → sleeps 1.5 s × attempt; `abc` → sleeps 0 and retries (then succeeds) | Bash crash artifact: the knobs are documented as integers; the port parses leniently and completes the retry loop rather than reproducing a `$(( ))` crash | parity llm adversarial stream/retries-08-octal, stream/backoff-float, stream/backoff-word |
| llm `--raw` body that is not valid UTF-8 | `cat` writes the body bytes verbatim | the body is decoded as UTF-8 for parsing and printed re-encoded: invalid sequences become U+FFFD | absurd input (a JSON body that is not UTF-8); the parsed path (`extract_text`) is unaffected. Fixable by keeping the body as bytes for `--raw` if a caller ever needs it | parity llm adversarial nostream/raw-invalid-utf8-body |
| llm unwritable LLM_USAGE_FILE | `write_usage`'s redirection fails with a bash line on stderr (`line 801: nodir/u.json: No such file or directory`); the call succeeds | silent; the call succeeds | Bash artifact: a best-effort write whose noise line is not a contract; stdout, exit and state identical | parity llm adversarial nostream/usage-file-missing-dir |
| llm stale multi-document LLM_USAGE_FILE | a pre-existing usage file holding two JSON documents, left untouched by a stream without a usage chunk, is re-read for the ledger: `jq -c select(…) \| head -1` ledgers the FIRST document | the file is not one JSON document → nothing is ledgered | absurd input (the tool never writes more than one document there); the single-document stale re-read quirk is kept | parity llm adversarial nostream/usage-file-stale-two-docs |
| web viewer Recap / Usage, chat/context | original computes recap/usage; `chat`/`context` are live tools | recap/usage return `available:false` (no crash); all mutating endpoints 403; `bin/chat` + `bin/context` are disclosed no-op shims | out of slice for the read-only wire-model parity: the viewer degrades cleanly. The engine rebuilds context in-process (src/context.ts); the responder owns replies, so `bin/chat`/`bin/context` need only harmless output. | web/server/src/router.ts recap/usage (available:false), 403 guard; bin/chat, bin/context |
| retrieval equal-hit tie-break | `awk … \| sort -rn \| head -1`: among memories with the same hit count the winner is the reversed last-resort byte order of the whole `hits\tmid\tsummary` line — i.e. GNU/BSD `sort` without `-s` picks the greatest id; under `sort -s` or a collating locale it would be awk's hash order | PINNED rule: highest hits, then greatest id, then greatest summary, all by UTF-8 bytes (`score()` in src/retrieval.ts) | the Bash rule is an artifact of `sort`'s last-resort comparison; the port makes it deterministic and identical to what this system's `sort` does (verified) | parity/retrieval edges/tie-equal-hits (PARITY); test "PORT-NOTE tie-break" |
| retrieval index `awk -v s="$summary"` escapes | a backslash sequence in a memory's `summary:` line is interpreted when the index row is written: `\t` → TAB splits the row's fields, `\n` → newline splits the row; the surfaced summary is then cut at the interpreted tab | the row carries the summary bytes verbatim | Bash/awk artifact, not designed behaviour; only a summary containing a backslash sequence differs (none in pax's corpus) | parity/retrieval awk-v/awk-v-backslash-summary (documented deviation, reported not counted) |
| retrieval tokenizer locale | Bash inherits the dispatcher's locale. Under a UTF-8 locale `tr -cs '[:alnum:]'` keeps non-ASCII letters inside a token and `grep -E '^[a-z0-9]{3,}$'` then drops the whole word ("café" → nothing); under C it splits on the bytes ("café" → "caf") | the C-locale/byte pipeline the spec describes (`tokenize()`); the harness pins `LC_ALL=C` both sides | only words with non-ASCII letters adjacent to ASCII differ; pax's corpus has none — the golden index is byte-identical under both locales. The port is deterministic where the Bash depends on the launcher's environment | parity/retrieval edges/non-ascii-c-locale (PARITY under C) + the informational UTF-8 run in its report.md |
| retrieval `[[ $hits -ge $RETRIEVAL_MIN_HITS ]]` with a non-integer knob | Bash prints `<script>: line 60: [[: 1.5: arithmetic syntax error …` on stderr (script path + line number), the test is false → exit 0 | exit 0 silently | same class as the `${2:?}` deviation: Bash text embeds an absolute path + line number on a misconfiguration path; exit code, stdout, and state match | parity/retrieval edges/min-hits-non-integer (documented deviation) |
| retrieval Bash-environment artifacts (adapted) | `-nt`/`ls -t` mtime resolution is bash-version dependent (1 s on macOS bash 3.2); `timeout 60 mem search` needs GNU `timeout` (absent on stock macOS → semantic suffix silently ""); `${sem:0:300}` slices bytes under C; `_require_env` loads `.env` fallbacks | mtimeMs comparison; the shim's native 60 s spawn timeout; 300 code points; `.env` not loaded (it only feeds semantic mode's model/key); the `mkdir -p` side effect IS replicated | environment-dependent behaviour made deterministic; all semantic-mode-only except mtime, where the port is at least as sensitive as any bash | src/retrieval.ts header PORT-NOTEs; parity edges/semantic-suffix (stubbed `timeout`+`mem`: PARITY), post-mem-add-rebuild |

### mem parity fixes (behavioral, now matching Bash)

- **empty-string required flag values (M1)** — `required()` now rejects `""` as
  well as missing, matching Bash `${2:?}` (dies on null OR empty). Previously
  `mem add --type ""`, `mem list --type ""`, `mem --dir ""`, `mem edit … --slug ""`
  were silently accepted (rc 0, writing/renaming corrupt on-disk state). Now they
  die (rc 1, no side effect); only the stderr wording differs (see Deviations).
  test/mem.test.ts "empty-string required flag values (M1)".
- **astral-plane truncation is code-point-aware (M2)** — `mem add` summary,
  `slugify`, and the rollups render text now slice by code point
  (`[...s].slice(N)`) to match `cut -c1-N`, which counts code points. A UTF-16
  `.slice(N)` truncated 4-byte chars (emoji, supplementary-plane CJK) at half the
  intended length, silently corrupting the on-disk `summary:`. BMP text (`日本語`)
  was already parity; astral now is too. test/mem.test.ts astral cases.
- **`MEM_TYPE` + `.memrc` precedence** — FIXED in `src/mem.ts` `resolveConfig`. Bash
  sets `MEM_TYPE="memory"`, snapshots exported `MEM_*` into `_pre_env`, sources
  `.memrc`, then re-exports the snapshot. So a set env `MEM_TYPE` re-applies as
  `"memory"` (its value discarded) and clobbers any `MEM_TYPE` assigned in
  `.memrc`. The port previously let env `MEM_TYPE` win whenever a `.memrc`
  existed. Now: env `MEM_TYPE` defined → `type: memory`; rc `MEM_TYPE` wins only
  when env `MEM_TYPE` is unset; no `.memrc` → env `MEM_TYPE` ignored (unchanged).
  Covered by test/mem.test.ts `.memrc` MEM_TYPE cases. (parity: memrc-enables-env-type)

### mem search prefilter/heartbeat/until (upstream sync 2, lane C)

Ported from upstream `766a290`, `69fddc6`, `130796a` (bin/mem part), `51a8585`
(headlong 7d29f9e..5458fee). `src/mem.ts` + `bin/mem.mjs`. Differential:
`parity/mem/run-parity.mjs` 76/86 vs real Bash (`PARITY_UPSTREAM_ROOT=<HEADLONG_ROOT>`
— the harness now also accepts this var, matching the other
`parity/*/run-parity.mjs` scripts' convention, in addition to the existing
`PARITY_BASH_MEM`).

- **Two-stage `mem search`** — `mem_prefilter` (`extractPrefilterTerms` +
  `scorePrefilterCandidates` in src/mem.ts) scores every memory locally with
  BM25 (saturating term frequency, k1=1.2; length-normalized, b=0.75) and
  keeps the best `MEM_SEARCH_TOP` (default 40); only those go to the model,
  with an always-present `-t MEM_SEARCH_MAX_TOKENS` (16000) output cap
  before `-s`. No term overlap at all falls back to the newest
  `MEM_SEARCH_TOP` files (`tailN`). `mem prefilter <query> [--top N]`
  exposes stage 1 directly, no model call, and — unlike `mem search` — no
  newest-files fallback on zero matches.
- **Byte-wise / `LC_ALL=C` scoring** — term extraction and per-file scoring
  operate on raw bytes (Buffer), not JS strings/code points: ASCII-only case
  folding, byte length, byte substring counts — matching Bash's
  `LC_ALL=C awk`. A multibyte UTF-8 character's continuation bytes are
  token separators (`café` tokenizes as `caf`, verified against real Bash).
- **`mem types` on an empty or missing store (536c64d)** — silent and
  non-zero, as upstream: the unmatched glob reaches `ls` as a literal path and
  pipefail returns `ls`'s status, which is 2 with GNU ls and 1 with BSD/macOS
  ls. The port used a flat 1, which diverged on Linux; it now follows the
  platform (`LS_CANNOT_ACCESS_RC`, checked against the real `ls` in
  test/mem.test.ts).
- **Fixed: empty-store `mem search` (766a290)** — now prints "No memories
  stored." and exits 0. Previously (and still true for `mem types`) the
  unguarded `count=$(ls *.md \| wc -l)` pipeline died under `set -e`+pipefail
  on an empty store before the message could print; upstream added
  `\|\| count=0` to `action_search` only, not `action_types`.
- **Heartbeat (69fddc6)** — `mem search` prints "mem search: waiting for the
  model..." to stderr every `MEM_SEARCH_HEARTBEAT_S` seconds (10; the
  LITERAL STRING `"0"` disables it — a Bash `[[ "$hb" != 0 ]]` string
  compare, so `"00"` would still heartbeat, not reproduced, see Deviations)
  while `llm` runs. Implementation note: `runLlm` is synchronous
  (`spawnSync`, so `focus.ts`'s `FocusIO.runMem` — a caller outside this
  lane — keeps working unchanged), so a JS timer would never get a turn
  while it blocks; `bin/mem.mjs` instead spawns a second, independent Node
  process that loops the heartbeat on its own event loop straight to the
  inherited stderr fd, mirroring Bash's own backgrounded-subshell technique.
  Covered by a real-subprocess test (test/mem.test.ts "mem search heartbeat
  (real subprocess)"), not just the config-threading unit tests, since the
  mechanism lives in the shim.
- **`mem add --until YYYY-MM-DD` (130796a)** and **`mem edit` preserves it
  (51a8585)** — dates a todo; the wake prompt's active-goals section (lane
  B, thinkers/_lib/common.sh, not yet wired to read it) drops a todo past
  its until date. Validation is shape-only (`^\d{4}-\d{2}-\d{2}$`), matching
  Bash's regex exactly — `2026-13-45` is accepted. `until:` sits right after
  `created:` in the frontmatter, before `updated:`. `mem edit` previously
  rebuilt frontmatter from a fixed field set and silently dropped `until:`
  on the first edit.
- **Bug found and fixed verifying 130796a's `sort -k1,1 -gr`** — BSD `sort`'s
  `-r` (no `-s`) is NOT "stable sort, then negate": equal-scoring files come
  out in the REVERSE of their glob/insertion order (verified directly:
  `printf '5.0\ta\n3.0\tb\n5.0\tc\n' \| sort -t$'\t' -k1,1 -gr` → c, a, b).
  Two memories scoring identically (same matched terms, same length) is not
  rare — e.g. near-duplicate todos. `scorePrefilterCandidates` reverses the
  candidate list before its own stable sort to reproduce this. Caught by the
  `search-top-env-caps-candidates`/`prefilter-top-1` parity scenarios
  (deliberately seeded with a tie), both HARD divergences before the fix.
- **Deviations (same class as the pre-existing `${2:?}` stderr-wording one,
  low severity, no real caller hits them):**
  - `--top`/`MEM_SEARCH_TOP` non-numeric — Bash's `head -n "$top"` fails with
    a BSD-`head`-specific OS error (`head: illegal line count -- X`, rc 1);
    the port dies its own way (`mem: error: Invalid count: X`), same exit
    code. `parseTopCount`, src/mem.ts.
  - `MEM_SEARCH_HEARTBEAT_S` non-numeric/negative — Bash's backgrounded
    `sleep "$hb"` would error every loop iteration and never print; the port
    silently disables the heartbeat instead (`bin/mem.mjs`'s `runLlm`).
  - `mem add --until` / `mem prefilter --top` with a missing or empty value
    — same `${2:?}` wording-only deviation as `--dir`/`--type`/`--slug`.

### skills parity fixes (behavioral, now matching Bash)

- **empty-string required flag values (M1)** — `req()` now rejects `""` as well
  as missing. `skills --dir ""`, `--format ""`, `--remotes ""`, and
  `init … --description ""` now die (rc 1, no scaffold / no side effect) instead
  of scaffolding an empty-`description:` skill; only stderr wording differs.
  test/skills.test.ts M1 cases.
- **search matches as a regex, not a literal** — FIXED in `src/skills.ts`
  `actionSearch` via `grepMatch`. Bash `grep -qi "$query"` treats the query as a
  regex; the port used `String.includes`. `b.r` now matches `bar`. JS RegExp is
  ERE-ish where grep defaults to BRE, so a few metacharacters (`+ ? { } | ( )`)
  still differ (PORT-NOTE in src); `.`, `*`, `[…]`, and anchors agree. An invalid
  regex → no match (grep's `if`-branch is likewise skipped). (parity:
  search/regex-metachar-grep-vs-includes)
- **GitHub fallback star prefix** — FIXED in `searchGitHub`. The star count now
  prints as `★ N`; Bash builds `★ \(.stargazers_count)` in its jq template and
  prints the field whole (bin/skills:695,698). (parity:
  search/github-fallback-stubbed-curl)
- **`init` ignores piped stdin** — FIXED in `actionInit`. Bash reads name/
  description from stdin ONLY when it is a TTY (`[[ -t 0 ]]`, bin/skills:953-964);
  piped/non-TTY stdin is ignored. The port read piped stdin and scaffolded. Now a
  name-less non-interactive `init` dies "Name is required", matching Bash on
  stdout/stderr/exit/on-disk state. The wrapper only sets `ctx.stdin` for non-TTY
  input — exactly the case Bash ignores — so `init` no longer consumes it.
  (parity: init/stdin-name-no-flag)

### recap parity fixes (behavioral, now matching Bash)

Found by the independent adversarial differential run
(`parity/recap/run-parity-adversarial.mjs`, report in
`parity/recap/report-adversarial.md`); each was reproduced against the real
Bash before the fix. F-numbers are the verifier's.

- **F1 huge (>1MiB) LLM reply / maxBuffer** — `bin/recap.mjs`'s `runLlm()`
  called `spawnSync("llm", …)` with no `maxBuffer` (Node default: 1 MiB). A
  >1MiB well-formed reply made spawnSync fail with ENOBUFS; `runLlm`'s
  `res.error` branch mistook that for "llm missing from PATH" and returned a
  discardable empty reply, which `llmJson()` treated as invalid JSON and
  retried — silently succeeding (exit 0) on a smaller follow-up reply and
  discarding the huge one entirely, where real Bash HARD FAILS (`jq: Argument
  list too long`, exit 126, re-serializing the huge body through a
  `--argjson` command-line argument). The dangerous direction: Bash fails
  loudly, the port silently "succeeded" with the wrong content. Now
  `maxBuffer: Infinity` — the port at least sees the huge reply; it still
  won't reproduce Bash's OS-level ARG_MAX crash (see the huge-reply Deviation
  row above — not worth chasing further).
- **F2 `bashArith()` unbound-variable (`set -u`)** — a bare-identifier-shaped
  env value (e.g. `RECAP_CONTEXT_BUDGET_MAX=notanumber`) was treated as
  "unset shell variable → 0" and silently computed a plausible-but-wrong
  answer (a full successful `--context` run) where real Bash's `set -u`
  aborts immediately (`notanumber: unbound variable`, exit 1, no output, no
  cache written). `bashArith()` now throws `BashUnboundVar` for this shape,
  and every call site (the episodes.jsonl idx/raw_end_line resume, `--budget
  auto`'s cap, `MODEL_CONTEXT_WINDOW`) re-raises it as its own die() — exit
  code, stdout, and on-disk state now match; stderr wording remains a
  documented deviation (Bash embeds its own script path + line number, same
  class as `${2:?}`).
- **F3 `tsvEscape()` NUL byte** — an embedded NUL (U+0000) in step content
  reached the `llm` subprocess's stdin as a raw 0x00 byte. jq's own `@tsv`
  filter — which real Bash's `_render_steps` pipes every row through — escapes
  an embedded NUL as the literal two-character text `\0` (confirmed: `jq -r
  '[.a]|@tsv'` on `{"a":"x y"}` prints `x\0y`, never a raw NUL).
  `tsvEscape()` now does the same.
- **F4 LLM reply number-literal preservation** — a reply's number literals
  (`1.0`, a 20-digit integer) were normalized/rounded (`1.0`→`1`, integers
  past 2^53 rounded) when `JSON.parse`+`JSON.stringify` re-serialized the
  reply into episodes.jsonl/themes.json; jq's own decNumber representation
  keeps a parsed number's literal text verbatim through any `--argjson`/`.`
  pass-through untouched by arithmetic, and that literal survives back out
  through `jq -r` on a later read. New `RawNumber`/`parseJsonLossless()` (a
  `JSON.parse` for validity + a linear number-literal-token scan for text,
  synchronized by traversal order — see src/recap.ts) carry the reply's own
  literal text end-to-end: `llmJson()`'s parse → the `episodes.jsonl`/
  `themes.json` write (`jqCompact`/`jqPretty`, now RawNumber-aware) →
  `readThemesValue()`'s later re-read → the printed stdout. Scoped to the
  paths an LLM reply's numbers actually reach; framework-computed numbers
  (`idx`, `raw_start_line`, …) are untouched and print identically either way.

### retrieval parity notes (quirks REPLICATED on purpose)

- **stale index after `mem forget`** — the index is rebuilt only when a memory is
  NEWER than it (or it is missing/empty); deleting a memory changes no remaining
  mtime, so the deleted id's rows stay and can surface ("I'm reminded of memory
  <deleted id>"). Replicated; test "stale-index-after-forget"; parity oracle/no-memories
  leaves the stale index + seen in place exactly as Bash does.
- **the `summary:` line is tokenized with the body** — so `summary` itself is a word
  of every memory (14 `summary\t…` rows in pax's index); the rest of the frontmatter is
  excluded; `mid` is the first `id:` line anywhere in the file (`sed | head -1`), no
  quote stripping — which is why the index does NOT go through `frontmatterField`.
- **seen is written BEFORE the append** — a failing `traj append` still leaves the id
  in the ring (test "seen is written BEFORE the append"); `tail -n (N-1)` semantics
  incl. `RETRIEVAL_SEEN=0` → `tail -n -1` keeps one line.
- **`jq -r '.content // empty'`** — null/false/absent → no-op; numbers/true print;
  objects/arrays print as pretty JSON and tokenize; a numeric `step_id` becomes a
  string `trigger_step`; `trigger_step` omitted when absent.
- **every no-op path exits 0 silently**; only `_require_env` (exact message) and the
  after-seen failures (`traj append`, seen write, non-integer RETRIEVAL_SEEN) exit 1.
- **run_id auto-link** iff `SHELLM_RUN_STEP_ID` is set and non-empty (trajCore.appendStep,
  not reimplemented) — pax row 676 shows it stamped on a probe run from inside a wake.
### llm parity fixes (behavioral, now matching Bash)

Found by the independent adversarial differential run
(`parity/llm/run-parity-adversarial.mjs`, report in
`parity/llm/report-adversarial.md`); each was reproduced against the real
Bash before the fix. F-numbers are the verifier's.

- **F1 scheme-less URL** — `LLM_API_URL=host:port/path` gets `http://`
  prefixed, as curl guesses; fetch refused it (exit 1, marker other).
- **F2 jq-result trailing newlines** — `$(…)` strips trailing newlines from
  every jq-derived message (embedded error, HTTP-error message, streamed error
  body). The port printed an extra blank line and stored `"bad\n"` in the
  marker; a newline-only message now falls back to the raw body.
- **F3 BOM** — `parseJson` tolerates a leading UTF-8 BOM (jq does).
- **F4 classifier `.`** — the marker-kind regexes carry the `s` flag: bash
  ERE `.` matches a newline (`invalid\nkey` → auth, `rate\nlimit` → rate).
- **F5 ASCII whitespace** — the whitespace-only 2xx body test is ASCII-only
  (`grep [[:space:]]` under LC_ALL=C); an NBSP-only body is a non-JSON body,
  not a retry.
- **F6 header bytes** — header values are Latin-1-encoded from their UTF-8
  bytes so a non-ASCII key reaches the wire as the bytes curl sends (undici
  sent one Latin-1 byte for U+00E9 and threw a ByteString error on CJK).
- **F7 unterminated last line** — the SSE line splitter flushes an
  unterminated last line in a `finally`, so an error body with no trailing
  newline followed by a socket close still classifies (kind credit, as bash
  `read … || [[ -n $line ]]`).
- **F8 truncation text** — the truncation warning prints the raw
  `-t`/`LLM_MAX_TOKENS` text (`007`, `99999999999999999999`), as
  `$LLM_MAX_TOKENS` does.
- **F9 `export<tab>`** — `.env` accepts any `[[:space:]]+` run after
  `export`, not only one space.
- **F10 EPIPE** — a reader that closes stdout early makes the tool exit 141,
  as bash's printf dying of SIGPIPE.
- **F11 jq shape crash** — a 2xx JSON whose shape aborts
  `check_response_openai` dies BEFORE the ok marker/ledger; one whose shape
  aborts `extract_text_openai` dies after them. The port used to exit 0 with
  an ok marker (a silent success). The exit-code remainder (1 vs 5) is the
  "2xx JSON whose shape aborts the jq checker/extractor" deviation row.
- **F12 usage object cell** — a usage token that is an object/array voids the
  whole record (`@tsv` aborts), instead of recording the other fields.
- **F13 U+007F** — every JSON the tool writes (marker, usage file, ledger,
  request payload) escapes DEL as `\u007f`, as jq prints it.

### llm slice 2 parity fixes (anthropic / gemini / opencode-Zen / adapter — now matching Bash)

Ports the remaining `bin/llm` wire paths (~lines 290-1290: provider detection
already at parity from slice 1; key/env resolution, the Anthropic/Gemini
payload builders, response parsing, and the `LLM_PROVIDER=adapter` exec seam
from `design/providers.md`). Found by extending `parity/llm/run-parity.mjs`
with 33 new scenarios and running them against the real Bash `bin/llm`, and by
`parity/upstream-tests/run.mjs`'s `tests/test_llm_adapter.sh` (upstream's own
suite, an independent oracle). Each was reproduced against the real Bash
before the fix.

- **F14 adapter stdin formatting** — `bin/llm` builds the constructed-prompt
  `LLM_MESSAGES` via `jq -Rs '[…]'` (default pretty, 2-space indent), then
  `$(…)` strips jq's one trailing newline before `printf '%s' > payload_file`
  — no newline added. The port wrote compact JSON to the adapter's stdin;
  now matches byte-for-byte for the constructed-prompt case (an explicit
  `-M` payload is already re-serialized upstream of this point, so only its
  JSON *shape* survives there — same PORT-NOTE class as the request body).
- **F15 adapter error-message path** — `bin/llm` execs and reports failures
  with `$LLM_ADAPTER` VERBATIM (whatever the caller passed, typically
  relative); the port resolved it to an absolute path first and both spawned
  and reported errors with that. Now execs and reports with the raw text,
  resolving to absolute only for the pre-flight executable check.
- **F16 adapter deadline grace-KILL gated on the wrong liveness check** — the
  Bash's post-TERM grace loop polls `kill -0 -- -$pid` (does the PROCESS
  GROUP still have any member?), not whether the adapter LEADER itself has
  exited. A leader that TERM-traps into a quick `exit 0` while an orphaned
  grandchild ignores TERM (spawned plain, so it shares the leader's process
  group) needs the follow-up SIGKILL to still reach the grandchild — the
  loop's condition is group liveness precisely so it does. The port instead
  gated the grace loop (and the final SIGKILL) on the SAME leader-exit flag
  used for the pre-TERM wait, so once the leader exited on TERM the
  grandchild was never signaled at all. Fixed: `LlmSpawnHandle.groupAlive()`
  (`kill -0 -- -$pid`, ESRCH → false) drives the grace loop; the final
  SIGKILL is unconditional, matching the Bash's own trailing `kill -9`.
  Found by `tests/test_llm_adapter.sh` "the adapter's children die with it"
  (port 19/20, elapsed 30s instead of under 15s) → 20/20. Unit test:
  `llmCli.test.ts` "the deadline reaches an orphaned grandchild too" (a real
  orphaned Node grandchild with SIGTERM ignored, same process group).

### Daemon-runtime deviations (this lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| `activate` | `tools/identity` writes a source-able Bash `activate` script that exports the identity env into an interactive shell | no `activate` file is ever written; `src/identity-env.ts` `resolveIdentityEnv(identityDir)` is the single source of truth every CLI/daemon/steprun calls directly | DIRECTOR CORRECTION: zero Bash artifacts in this lane. A pure function is strictly better for a port with no interactive shell to source into. | identity-new.test.ts asserts `activate` is absent |
| `thinkers/<name>/step` | a Bash exec-shim | a Node file (`#!/usr/bin/env node`) that execs `bin/thinker-step.mjs <name>` via `HEADLONG_TS_HOME` | DIRECTOR CORRECTION: the upstream CONTRACT is "an executable at thinkers/<name>/step" — its language is free; Bash inside the sandbox (running the model's own bash action block) is unaffected and unchanged. | identity-new.test.ts asserts the step file's shebang; parity/daemon adversarial `identity-new/node-step-shim` |
| `kernel/{mem,chat,goals}`, `skills/<bundled>` | `tools/identity` SYMLINKS these into its own checkout (`_ensure_kernel`/`_install_bundled_skills`: `kernel/mem -> <checkout>/skills/mem`, etc.) | this port COPIES the bundled `SKILL.md` text (as `src/assets/kernel/*` and `src/assets/skills/*`) into real directories | DIRECTOR CORRECTION: a portable TS package ships with no sibling Bash checkout to symlink into — a real, self-contained copy is the only thing that works once installed elsewhere. Every skill dir upstream ships holds only `SKILL.md` (no scripts), so this is a pure-text copy, not a functional gap. | identity-new.test.ts asserts the SKILL.md content; parity/daemon adversarial `identity-new/kernel-skills-copied` |
| `thinkers/_lib/common.sh`, `thinkers/retrieval/build-index.sh` | Bash helper sourced by thinker `step` scripts / the retrieval index builder, both copied by `_ensure_thinkers` | NEVER copied — `thinkers/_lib/` is not created at all; retrieval's index build is `src/retrieval.ts` + `bin/retrieval-step.mjs`, ported separately (see the retrieval thinker row in Parity by module) | DIRECTOR RULE: Bash/Python thinker-helper files are never copied into a TS-authored identity — every port thinker (monolith/responder/retrieval `step`) is a self-contained Node file with nothing left to `source`, so `thinkers/_lib/common.sh` has no caller here. | identity-new.test.ts asserts both are absent; parity/daemon adversarial `identity-new/bash-omitted` |
| dispatcher event bus | `tail -F <traj>` piped into `dispatch.fifo` (a subprocess pipeline per subscribed trajectory) | `TrajFeeder` — in-process `fs.watch` + tick-driven poll, tail-from-offset with partial-line stitching. A record the dispatcher ITSELF appends (the salience `feedback` injection) is fed back through `Dispatcher.feed()` synchronously, right after the write, instead of waiting for the feeder's own next poll — matching upstream's `tail -F` pipe, which discovers a line appended to an already-tailed file within the same read-loop pass, not a tick later. The feeder's offset is resynced past those bytes so it never redelivers them. | avoids one subprocess-plus-FIFO pair per trajectory; the daemon's 1s tick is the guaranteed delivery floor for everything else either way (fs.watch is best-effort, documented in feeder.ts's own header — see feeder.test.ts, which drives watch-or-poll together rather than asserting on the OS event alone). `run/dispatch.fifo` and `run/tail_pids` are therefore never created by this daemon. | daemon.test.ts (incl. the byte-diff busy→queued→feedback→re-fire sequence), feeder.test.ts; parity/daemon adversarial `chat-reactive/dispatcher-log-line-shapes` |
| the detached drain reaper | `_drain_then_finish`/`_drain_all_then_finish` (bin/thinkers:1250-1276) background a `(...) </dev/null >/dev/null 2>&1 & disown` subshell — a genuinely separate OS process the parent shell doesn't wait on — so `thinkers stop` returns immediately while draining (and the `stop` script it now runs, see the daemon-runtime gap fixes above) continues independently | `drainThenFinish` (thinkersctl.ts) spawns `bin/thinkers-drain.mjs` DETACHED + `unref()`'d, the same technique `thinkersStart` uses for the dispatcher — a real second OS process, not an in-process timer | an EARLIER version of this port ran the wait as an un-awaited in-process `setTimeout` loop; that let a direct library caller's own Promise resolve right away, but Node's event loop stays alive for as long as a pending timer exists, so the standalone `bin/thinkers.mjs stop` CLI PROCESS hung until the drain finished regardless — failing "stop returns immediately" against the real oracle (`tests/test_thinkers_drain.sh`, which times the CLI invocation, not just the promise). A real detached child process is required to match upstream's actual "parent exits, child keeps running independently" semantics in Node. | thinkersctl.test.ts "stop scripts" describe block; parity/upstream-tests test_thinkers_drain.sh (11/20 -> 20/20) |
| the self-stop guard's cgroup fast path | checks `/proc/self/cgroup` against the dispatcher's cgroup, scoped to a systemd unit name | not ported — only the ppid-ancestry walk (exact for attached steps on every platform, including macOS dev machines with no `/proc`) | the cgroup path is a systemd-only concern; this port ships no systemd units. The ppid walk is upstream's own fallback for hosts without `/proc` cgroups, and this port relies on it exclusively. | thinkersctl.ts insideOwnDispatcher |
| multiple subscriptions.jsonl lines for one thinker | each line is routed independently | the daemon merges all of a thinker's lines into ONE Subscription (union types, OR trigger_self, min nonzero watchdog) for routing; run/sub_map still records one row per raw line | Subscription is singular per ThinkerDef; every bundled thinker ships exactly one line, so this never fires today. Documented rather than silently wrong if a future thinker ships two. | src/daemon.ts parseSubscriptions/byThinker |
| Dispatcher.bootTrigger payload — RESOLVED, was a Gap below | upstream's boot-kick pending file carries no content field | bootTrigger now dispatches type+source only — content dropped, matching upstream | fixed as part of this lane's dispatcher.ts refactor; the stale gap row further below is superseded | topology.test.ts spontaneous/manual-trigger:thinkers-cli; runstate.test.ts manualTriggerJson |
| SHELLM_WORKDIRS_DIR / IDENTITY_DIR docker binds | two separate -v mounts (a workdir can live outside the identity tree) | one -v identityDir:identityDir bind (every step's workdir is created under identityDir/.shellm/workdirs) | steprun.ts always nests the workdir under the identity dir, so a second bind is redundant | src/sandbox-runtime.ts startDockerSandbox |
| headlong-killall process-argv patterns | `bash <path>/(bin\|tools)/(shellm\|shellm-explore\|llm\|chat\|sub)`, `bash <path>/bin/thinkers`, `bash <path>/thinkers/*/step`, `bash <path>/bin/traj tail`, orphaned `tail -n 0 -F …/trajectory.jsonl` followers | `node .../bin/dispatcherd.mjs`, `node .../thinkers/<name>/step`, `node .../bin/thinker-step.mjs`, `node .../bin/sub.mjs`, `node .../bin/chat.mjs` (+ `--web`'s `web/server/src/index.ts`) — NO pattern for `traj tail`/an orphaned `tail -F` follower | the TS daemon runtime has fundamentally different process shapes: no standalone `shellm` agent-loop process (a thinker step is one self-contained Node process), and the feeder (`src/feeder.ts`) is an in-process `fs.watch`, not a subprocess `tail -F` — there is nothing of that shape to reap. `bin/traj.mjs tail` is a synchronous one-shot (prints N lines, exits), not a follower. | src/killall.ts header PORT-NOTE; parity/killall (structural scenarios exclude the live listing from comparison for exactly this reason) |
| killall.test.ts `psSnapshot` injection | none — upstream has no way to scope a raw CLI invocation | `KillallOptions.psSnapshot` — an injectable override, defaulting to the real unrestricted system-wide scan for production/CLI use | killall is DELIBERATELY system-wide (a panic button has to see every matching process on the machine); exercising the real default for a REAL (non-dry-run) kill inside an automated test on a shared dev machine is genuinely dangerous — an earlier, unscoped version of this test suite matched and SIGTERM'd a live `dispatcherd.mjs` belonging to another agent's test run in a sibling worktree before this seam was added (confirmed harmless after the fact, but the wrong outcome). Every real-kill test scopes `psSnapshot` to its own spawned decoy pids; the one test exercising the real unrestricted CLI (self/ancestor protection) is pinned to `--dry-run`. Production/CLI behavior (`bin/headlong-killall.mjs`) is unaffected — it never passes `psSnapshot`, so it always gets the real scan. | test/killall.test.ts (file header explains the incident); parity/killall (dry-run only, same reasoning) |

### thinker-log observability fix + deviations (this lane)

**The gap**: a live side-by-side run (`sxs/orig` real Bash vs `sxs/port` this
port) showed the port's `run/logs/monolith.log` and `run/logs/responder.log`
staying 0 bytes for a whole session — upstream's same session wrote 5404 and
12 lines respectively, so `thinkers status`'s `wc -l` always reported "0 log
lines" for a live thinker. `src/daemon.ts`'s `spawnStep` already redirects a
step child's stdout+stderr into `run/logs/<name>.log` (`_dispatch_step`
parity) — the plumbing was never the problem. The problem: `src/monolith.ts`
/ `src/responder.ts` / `src/shellm.ts` never wrote anything to stderr/stdout
during a wake, where upstream's `bin/shellm` (`progress`/`progress_dim`,
bin/shellm:200-201) and `thinkers/monolith/step` / `thinkers/responder/step`'s
own bare `printf ... >&2` calls do, constantly.

**Fixed**: `src/shellm.ts` gained a `WakeIO` seam (`{stdout, stderr}`,
defaulting to the real `process.std{out,err}.write` — `REAL_WAKE_IO`) and a
`ProgressSink` (`progress`/`progressDim`/`blank`, the exact ANSI shapes of
`progress()`/`progress_dim()`/the bare `echo >&2`), threaded through
`runShellm` (`io` option) and into `src/monolith.ts` (`RunMonolithWakeOptions.io`)
/ `src/responder.ts` (`RunResponderOptions.io`). Every line upstream prints
around one shellm run and one responder reply is now reproduced, in the same
order: shellm's run/iteration/empty-retry/no-block/executing-bash/exit-status/
final-answer/stall/max-iter lines (bin/shellm:2377-2886) and the `die()`
`"shellm: error: ..."` line; monolith's `routing (...)...`, `run FAILED
(rc=1)`/`run produced no durable step (rc=0)`, the thought-only backoff dwell
line, and the `[monolith] <first line>` stdout summary (thinkers/monolith/step:307,
360-371, 417-425); responder's `claiming reply to X...`, `replying to X...`,
`self-message`/`already handled`/`NO_REPLY`/`DEFER`/`reply failed` lines, and
`Reply sent.` + `[reply -> X] <first line>` (thinkers/responder/step:52-472).
Since `WakeIO` defaults to the real process streams, a daemon-spawned step's
log is populated with zero call-site changes at the daemon layer — proven by
test/progress-logs.test.ts's daemon-level test (real `bin/dispatcherd.mjs`,
`run/logs/monolith.log` non-empty after a fired wake). Two unit tests in the
same file pin the exact stderr/stdout sequence for one monolith run and one
responder run (a local fake endpoint over `LLM_API_URL`, trajId normalized) against the real
upstream log evidence (`sxs/orig/.../run/logs/monolith.log`,
`sxs/orig/.../run/logs/responder.log`) and the `bin/shellm` / `thinkers/*/step`
source read alongside it.

Parts that are genuinely not reproducible (or not reproduced) in this pass:

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| live xtrace/output streaming during a command | `_stream_new_output` (bin/shellm:1979-2006) polls the running command's output file every 0.2s and streams new lines to stderr AS THEY APPEAR, while the command is still executing | `printExecOutputLines` (src/shellm.ts) reproduces the SAME lines, in the SAME order (a `+`-prefixed xtrace line cyan with `+ ` stripped, else dim with a `│ ` marker, both through `redactSensitive`), but only once, after `Sandbox.exec()` returns the whole combined output | this port's `Sandbox.exec()` (src/sandbox.ts, src/sandbox-docker.ts) is a blocking call that hands back output only once the command has finished — there is no incremental read seam to poll. Content/order is identical (both sides read the same `set -x`-interleaved stdout+stderr stream); only the WALL-CLOCK GRANULARITY of when a line hits stderr differs (batched vs incremental) | test/progress-logs.test.ts (fast fake commands, where this makes no observable difference); would matter for a real long-running shell command, not exercised here |
| Docker container setup/reattach preamble (`Setting up Docker container (...)`, `Docker container ready (id)`, `Reattached to Docker container (id)`, `Created env`/`Using env`) — **BEHAVIOR RESOLVED (bug #32), text still not emitted** | upstream's `env`/container concept is PERSISTENT across wakes — a `shellm --env NAME` invocation reuses (`Reattached to...`) or creates (`Docker container ready`) one long-lived container per env name | `selectSandbox`/`startDockerSandbox` (src/sandbox-runtime.ts, src/sandbox-env.ts) now DOES reuse a running, image-matching container across wakes (persistent per identity/env name, only torn down via `tempDocker`/killall/a future `identity delete`) — the behavioral gap this row used to describe is closed. What remains genuinely unported: this port's sandbox selection is silent (no `progress()`-equivalent stdout at all, on either the fresh-create or the reuse path), so there is still no "Setting up..."/"Reattached to..."/"Created env"/"Using env" TEXT — printing it now would be accurate (a reuse really is a reuse), just not implemented, since nothing in this port's steprun path currently emits sandbox-setup progress text to any stream a golden trace or test observes | test/sandbox-env.test.ts (real docker): two-wake reuse via a cross-step marker file + a single `docker ps` match; env.name/docker_image on the SelectSandboxResult reflect the actual reused env, matching what the (unemitted) upstream text would have said | src/sandbox-runtime.ts startDockerSandbox, src/sandbox-env.ts |
| run-startup preamble (`Using trajectory: ID`, `Trajectory: ID (dir: ...)`, `Workdir: ...`) | printed once by the `shellm` CLI itself at the top of its own invocation, before "Starting shellm loop" | not printed — this port's `runShellm` is a function call inside an already-running wake process, not a fresh CLI invocation; the trajectory/workdir are already known to the caller (`steprun.ts`) before `runShellm` is ever called | low information value (every field is already on the `shellm-run` header this port DOES write, and in the daemon path the workdir/trajectory never change wake-to-wake) relative to the loop-body lines this fix prioritized; not reproduced this pass | none — open gap, not exercised by test/progress-logs.test.ts |
| `KILLED` kill-reason ("idle" vs "nested", bin/shellm:2652-2658) — **RESOLVED** (bug #33, `fix/inactivity-watchdog`) | two independent timeouts: a short `SHELLM_INACTIVITY_TIMEOUT` (default 30s, "idle" — no new output at all) and a longer `SHELLM_INACTIVITY_MAX` (default 900s, "nested" — a silent sub-run's activity beacon is stale) | now ported: `execWithInactivityWatchdog` (src/sandbox.ts), shared by `LocalSandbox`/`DockerSandbox`, tracks `staleMs` (resets on any output byte OR an activity-beacon touch) and `quietMs` (resets ONLY on real output) separately, matching upstream's two-timer algorithm exactly. `ShellmConstants.inactivityTimeoutMs` (new; `SHELLM_INACTIVITY_TIMEOUT`, default 30s) and `.inactivityMaxMs` (`SHELLM_INACTIVITY_MAX`, default 900s, unchanged name) are both wired through `constantsFromEnv`. `ExecResult.killReason` is `"idle"` or `"max"` (upstream's "nested" — see below for the label difference); `src/shellm.ts` prints/records the matching distinct KILLED line and feedback for each (`KILLED — inactivity timeout (Ns)` vs `KILLED — sub-run silent for Ns`) | "nested" is renamed "max" here on purpose, not merged: this port has no standalone `shellm` CLI at all (confirmed — see the `0925168` Gaps row), so the model's exec'd bash can never literally run a NESTED shellm loop; upstream's own beacon path (`SHELLM_ACTIVITY_FILE="$rundir/.activity"`, bin/shellm:2579) is unconditional — no docker-mode rewrite unlike `final_path` a few lines up — so it was never reachable from inside upstream's OWN Docker branch either, a real pre-existing upstream limitation this port reproduces faithfully rather than "fixing": the port forwards the same beacon path into `DockerSandbox`'s exec'd env, but the watchdog's poll always runs HOST-side (matching where upstream's own watchdog subshell runs, for both branches), so a beacon touch works for `LocalSandbox` and is a faithful no-op for `DockerSandbox`. The mechanism (not the "nested" label) is what's proven | test/sandbox-watchdog.test.ts (LocalSandbox: chatty-survives-idle / silent-killed-at-idle / beacon-active-killed-at-max, each also under a real DockerSandbox that skips cleanly with no daemon); test/shellm.test.ts "runShellm: inactivity watchdog KILLED distinction (bug #33)" (both KILLED lines + feedback strings, through the real loop); `parity/sandbox/run-parity.mjs`'s new `idle-kill` scenario (7/7 differential); oracle read directly: `tests/test_inactivity_beacon.sh`, now classified in `parity/upstream-tests/run.mjs` (5/5, no-port-cli — see that file for why cases 2/3's nested-beacon scenario specifically has no port-side analogue) |
| `chat reply`'s duplicate-guard OUTCOME (not just its log line) | `chat reply`'s answered-guard (bin/chat:330-343) returns EXIT 0 on a duplicate (no message sent, but not an error) — `thinkers/responder/step`'s `if ... chat reply ...; then` branch therefore still takes the SUCCESS path: `decision:"replied"`, `[reply -> X] <text>` printed, `Reply sent.` never printed (chat.ts's own `io.stderr` for the duplicate case prints `"chat: step ... already has a reply from ... — skipping duplicate send."` instead) | `runResponder` (src/responder.ts) checks `hasStampedReply` BEFORE attempting to append the `message` step; when true, it falls straight to the `reply-failed` branch (`decision:"reply-failed"`, `"  reply failed — appending failure observation"`) — `Reply sent.` and `[reply -> X]` are never printed for this case | a REAL, pre-existing behavioral difference this fix's log-line audit surfaced, not merely a missing print: the port never calls `chat reply` at all (it appends the `message` step directly — see the doc comment on that branch in src/responder.ts), so it has no equivalent of `chat reply`'s own EXIT-0-on-duplicate semantics to reproduce. Fixing the OUTCOME (not just the log text) is out of this lane's scope (observability only) | none — open gap; the port's `decision:"reply-failed"` for a genuine duplicate is arguably more honest than upstream's `decision:"replied"` with nothing actually sent, but it is still a documented divergence from the oracle |
| banner (`banner()`, bin/shellm:180-201) | ASCII-art banner, gated by `QUIET`/`SHELLM_NO_BANNER` | never printed | NOT a gap: `thinkers/monolith/step` itself sets `SHELLM_NO_BANNER=1` on every invocation (and monolith is the only shellm-agentic-loop caller in this port), so upstream's own real sessions never show it either — confirmed absent from the `sxs/orig` evidence log | n/a |

### container-lifecycle fix + deviations (bug #32, this lane)

**The bug**: `selectSandbox`/`startDockerSandbox` (src/sandbox-runtime.ts) named
every step's container `shellm-<pid>` and `docker rm -f`'d it in `steprun.ts`'s
`finally`, unconditionally, after every single wake — no reuse, ever. Upstream
gives each identity ONE persistent named container, reused across every wake
of it (`thinkers/_lib/common.sh:372`'s `--env "${SHELLM_THINKER_ENV:-
$IDENTITY_NAME}"`, `bin/shellm`'s `env_resolve`/`env_register`), torn down
only by `--temp-docker`, `identity delete` (`_destroy_containers`), or a
`headlong-killall` sweep — never by the plain act of finishing a wake. This
also meant the earlier "N/A to this port's architecture" verdict on upstream
commit `0925168` (env image identity) was only true because THIS bug made the
hazard unreachable, not because the architecture was actually incompatible
with it — see the Gaps table and "Upstream sync 1b" rows for the correction.

**Fixed**: `src/sandbox-env.ts` (new) ports the SHELLM_ENVS_DIR-equivalent
metadata store (`<identityDir>/.shellm/envs/<name>/`, matching
`tools/identity:375,1381` exactly) and the image-identity subset of
`env_metadata_matches`/`env_metadata_mismatch_message`. `startDockerSandbox`
now checks for a stored, running, image-matching container before creating
one; `cleanup()` defaults to a no-op (persist) and only removes the container
when `tempDocker`/`SHELLM_TEMP_DOCKER=1` is passed (`--temp-docker`
equivalent). See the "sandbox-runtime" module row above for the full
description and the real-docker test evidence.

**Deliberately NOT wired into `thinkers stop`.** The task brief for this fix
named `thinkers stop` as one of the places container teardown should be
wired, alongside `headlong-killall` and identity removal. Checked directly
against upstream: `bin/thinkers` (the dispatcher CLI upstream's `thinkersctl`-
equivalent `stop` command lives in) has ZERO references to `docker` or
`container` anywhere in the file (`grep -n "docker\|container" bin/thinkers`
— no matches). The persistent env container is entirely independent of the
dispatcher's own start/stop lifecycle in real Headlong: stopping and
restarting the thinker dispatcher (a routine operation) does NOT touch the
container, which is exactly the point of it being persistent — reproducing
that same warm filesystem across a `thinkers stop`/`start` cycle is part of
the value this fix is supposed to deliver, not a case for tearing it down.
Wiring container teardown into `thinkersctl.ts`'s `stop` would therefore
contradict upstream (verified above) and defeat this fix's own purpose (a
`thinkers stop && thinkers start` would silently return to the pre-fix
per-restart-fresh-container behavior). Teardown stays wired only where
upstream actually puts it: the `tempDocker` opt-in, `headlong-killall`
(already correct — its `name=^shellm-` filter matches the new container name
unchanged, see killall.ts's updated header comment), and — ready but not yet
wired, since the command itself isn't ported — `destroyIdentityContainers`
for a future `identity delete` (`src/identity.ts`'s file header still lists
`delete` as out of this port's scope; that scope decision predates and is
unrelated to this fix). **Open question for a human**, not resolved
unilaterally: confirm this reading is correct, or say `thinkers stop`
tearing down containers is an intentional PORT hardening choice this port
should make even though upstream doesn't.

### shellm env-knob parity fix (behavioral, now matching Bash)

- **daemon-driven wakes ignored `SHELLM_*` loop-constant env vars** —
  `bin/shellm:55-80` reads `SHELLM_MAX_ITERATIONS` (empty=unlimited),
  `SHELLM_MAX_CONSECUTIVE_FAILURES` (default 10), `SHELLM_MAX_REPEAT_FAILURES`
  (default 3), `SHELLM_TRUNCATE` (default 2000), and `SHELLM_INACTIVITY_MAX`
  (default 900s) once at startup. The port's `ShellmConstants` existed
  (`src/shellm.ts` `DEFAULT_CONSTANTS`), but `src/steprun.ts`'s `runStep` never
  read the env into it, so every daemon-spawned wake ran with the compiled-in
  defaults regardless of the identity's env — e.g. `SHELLM_MAX_ITERATIONS=4` in
  the daemon's environment had no effect and a wake could run 10+ iterations.
  Fixed with a new pure `constantsFromEnv(env)` (`src/shellm.ts`), wired into
  `runStep`'s `monolith` branch. Non-numeric values are left as `NaN` rather
  than special-cased: bash's `[[ N -lt "abc" ]]` prints an error and evaluates
  false, and `N < NaN` is false in JS too, so the existing numeric comparisons
  reproduce the same "stops immediately" behavior with no extra branching.
  Also wired: `SHELLM_EFFORT` (default `"high"`, bin/shellm:80) now reaches
  both the recorded `shellm-run` header's `effort` field (via
  `IdentityConfig.effort`) and the real `OpenRouterClient`'s `reasoning.effort`
  request field (`OpenRouterConfig.effort` already existed, unused before this
  fix); `SHELLM_MAX_TOKENS` now reaches `OpenRouterConfig.maxTokens`
  the same way. Covered by test/shellm.test.ts (`constantsFromEnv` unit tests)
  and test/steprun.test.ts ("SHELLM_MAX_ITERATIONS in the env bounds a wake
  that never emits FINAL").

### traj CLI parity fixes (behavioral, now matching Bash)

Found by the differential run (`parity/traj/run-parity.mjs`); each was
reproduced against the real Bash before the fix.

- **findDirByPrefix self-inclusion** — `src/trajCore.mjs`'s
  `findDirByPrefix` (the helper behind `resolveTrajFile`, i.e.
  `_resolve_traj_id`'s hex-prefix glob step) only checked a directory's
  DESCENDANTS against the prefix, never the directory itself. Real `find
  DIR -type d -name "PREFIX*"` checks DIR itself too (depth 0). This
  mattered for `cmd_fork`'s auto-created child: `cmd_new` resolves the
  parent id starting FROM the parent's own already-resolved directory
  (bin/traj:1291, `--traj_dir "$parent_dir"`), i.e. exactly the
  self-referential case — the port silently failed to find it, so the
  auto-created child's first step was missing `parent_traj_ref` entirely.
  `findDirByPrefix` now checks `path.basename(dir)` against the prefix
  before recursing into its entries, matching `find`'s pre-order,
  self-then-children traversal exactly. A READ-path fix only —
  `appendStep`'s write semantics are untouched. Covered by
  test/trajCli.test.ts "fork > auto-creates a child trajectory…" (asserts
  `parent_traj_ref`) and parity/traj fork/auto-create-child.
- **`show`/`last` `--field` on an absent field** — `jq -r ".field //
  empty"` (bin/traj:708,1460): when the field is null/false/missing, the
  `// empty` fallback yields NO jq value at all, so `-r` prints ZERO
  bytes — not a blank line. The port unconditionally appended a newline
  to the (possibly empty) field string, printing a stray blank line
  where Bash prints nothing. Fixed via `printJqFieldOrEmpty` (prints
  only when the field is present). Covered by test/trajCli.test.ts's
  "absent field" cases for both `show` and `last`; parity/traj
  show/field-extract (was a false MISMATCH — now byte-exact) and
  last/field-absent-empty.

### Web control-plane deviations (this lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| control-plane mutation dispatch | `headlong_web/control.py` builds `identity_env` and `subprocess.run`s the Bash CLIs (`thinkers`, `chat`, `tools/identity`) with `start_new_session=True` | `web/server/src/control.ts` imports `src/{identity,identity-env,thinkersctl,chat}.ts` and calls them as plain functions — no subprocess, no shell | task directive + PLAN-daemon-runtime.md §6: F1 already made the engine source-runnable from `.ts`, so the reason upstream shells out (Bash CLIs are the only thing that runs) doesn't apply to this port. The daemon itself is still spawned as a REAL detached OS process (`thinkersStart` → `spawn(process.execPath, [dispatcherd.mjs], {detached:true}).unref()`) — that half of the process-topology split (§A) is unchanged; only the web-server-to-CLI hop is now an in-process function call. | web/server/test/controls.test.ts (dispatcher.pid alive after start / gone after stop, over the HTTP route) |
| `POST /api/identities` response `id` | literal `.identities~<name>` (upstream's repo-root + `.identities/` nesting) | `discovery.identityIdFor(relative(root, identityDir))` — for this port's flat serve-root (identity dirs live directly under `--root`, no `.identities/` nesting — see index.ts), that's just `<name>` | the literal upstream string encodes upstream's OWN directory layout; this port's `RouterCtx.root` already IS the identities root (`index.ts`'s own doc comment), so computing the id via the port's own discovery scheme is the faithful choice — a copy-pasted upstream string would not resolve via `GET /api/identities/:id/...` on this port | controls.test.ts "create identity -> 201, and GET discovery finds it" (asserts `scanIdentities` returns the SAME id) |
| `POST .../thinkers/:name/step` | `control.py`'s `thinkers_step` is a detached `subprocess.Popen` (true fire-and-forget, separate process) | `control.thinkersStep` calls the library's own `thinkersStep` (which runs the step SYNCHRONOUSLY to completion — see the thinkersctl module row) but does NOT `await` it — the promise floats, caught, ignored; the route returns 202 immediately | preserves the observable contract ("returns immediately, the step runs in the background") without a second OS process, matching this lane's "library calls, not subprocess" choice above | controls.test.ts "thinkers/:name/step -> 202 immediately (fire-and-forget)" (asserts response lands in <2s regardless of step duration) |
| `thinkers/:name/enable`/`disable` orchestration | lives in `server.py` itself (touches/unlinks the marker directly, calls `control.thinkers_stop`) | lives in `web/server/src/control.ts` (`thinkersEnable`/`thinkersDisable`) instead of `router.ts`, since the task scoped control.ts to own "thinkersStep/enable/disable calling the library" | thinkersctl.ts has no enable/disable of its own (only start/stop/step/list/logs/status) — this is web-only orchestration either way; keeping it in control.ts (not router.ts) matches this port's existing route/data-layer split (router.ts stays route-shape only) | controls.test.ts "thinkers/:name/disable then /enable round-trips the marker" |
| `POST .../recap/refresh` | `subprocess.Popen(_wrap("recap", "-q", …), start_new_session=True)` — a real detached Bash-wrapped CLI process | `control.recapRefresh` `spawn(process.execPath, [bin/recap.mjs], {detached:true, stdio:"ignore"}).unref()` — same detached-Node-child pattern `thinkersStart` already uses for the dispatcher, just a different target script; still a real second OS process, not an in-process call | `recap`'s own map-reduce can run for minutes and makes real LLM calls (`bin/recap.mjs`'s `runLlm` seam is itself a `spawnSync("llm", …)`) — running it in-process would block the web server's event loop for that whole time | controls-slice-c.test.ts "recap/refresh ... real spawn proven by the recap/ cache dir", "409 while a refresh is already running" |
| `POST .../usage/refresh` | `usage.start_refresh` runs `usage.refresh` on a background Python `threading.Thread`, guarded by the same `.lock`-directory convention as recap | `usage.ts`'s `startRefresh` defers the (bounded, deterministic, no-network) scan with `setImmediate` on the SAME process instead of a separate thread — Node has no lightweight in-process-thread equivalent for synchronous fs/JSON work | the scan is pure local file/JSON work (mind-log + ledger byte-offset tailing), unlike recap's LLM calls — the `.lock` directory, 202 response, and final cache state are identical; the difference is only which execution context does the (fast) work | controls-slice-c.test.ts "usage/refresh ... 409 ... cache.json written by the deferred refresh" |
| `POST /api/llm-health/probe` | `control.llm_probe` shells to `llm --no-stream --raw -t 60 [-m MODEL] ping` as a subprocess (`run_cli`) | `control.llmProbe` calls `src/llmCli.ts`'s `runLlm` in-process (the SAME function `bin/llm.mjs` wires to argv) with an injected `io` (its `fetch` is `globalThis.fetch`, so tests stub it — no live LLM calls; see `llm` CLI's own module row for `runLlm`'s parity level) | matches this lane's "library calls into src/, no subprocess" convention; `llm`'s wire logic already lives in a plain async function, so there is no CLI-process boundary to preserve here the way there is for `recap`'s minutes-long, LLM-heavy run | controls-slice-c.test.ts "llm-health/probe" success/failure cases (stubbed fetch) |
| `POST /api/identities/import` (raw body) | `server.py`'s route reads `request.stream()` directly (ASGI raw body), enforcing the size cap and gzip magic-byte check inline, then calls `run_in_threadpool(control.identity_import, …)` | `server.ts` special-cases `POST /api/identities/import` BEFORE the shared JSON-body path (`readRawArchiveBody`): same size cap (`HEADLONG_WEB_MAX_IMPORT_MB`, default 512) and gzip magic-byte check, staged to a temp file, then `handleMutation` calls `control.identityImport` synchronously (no threadpool — Node has one thread; the archive read + extract is bounded local fs work) | Node's `http` module has no ASGI-style streaming-body-per-route primitive; special-casing the one raw-body route ahead of the generic JSON-body reader is the smallest change that preserves the same size/magic-byte checks server.py makes before ever calling into `control.py` | web/server/test/import.test.ts (real HTTP layer: 201/422/413/403, the last BEFORE the stream is ever buffered — see the ordering fix below) |
| `POST /api/identities/import` (`_require_controls()` ordering) | `_require_controls()` runs as literally the route function's first line, before `request.stream()` is touched at all | `server.ts` checks `ctx.controlsEnabled` and drains+403s BEFORE calling `readRawArchiveBody` — matches; NOT calling `_require_controls()` only after buffering the whole upload (which was this lane's first draft) would have wasted a full upload's worth of disk I/O and bandwidth on a read-only server for no reason | web/server/test/import.test.ts "read-only mode -> 403, before the raw stream is ever buffered" |
| `identity import` bundled-thinkers root | `thinker_sync.bundled_root()` and `tools/identity`'s own `_bundled_skill_dir`/thinker install default to `<repo checkout>/thinkers` (the Bash tools' own source tree) | `web/server/src/thinker-sync.ts`'s `bundledRoot()` defaults to `src/assets/thinkers` (this port's bundled thinker templates, same ones `identityNew`'s `installThinker` uses) — same role, different path | there is no Bash checkout for this port to point at; `src/assets/thinkers` is this port's actual equivalent "pristine thinkers" source, already used by `identityNew` | controls-slice-c.test.ts "thinker-sync" (in_sync after identityNew, drift+pull round-trip) |
| `identity import` kernel/bundled-skills regeneration | `_install_imported_identity` calls `_ensure_kernel` (always re-`ln -s` the 3 kernel skills into the Bash checkout) and `_install_bundled_skills` (symlink each NON-kernel bundled skill only if the name isn't already present) | `identityImport`'s `installImportedIdentity` mirrors both halves of that policy exactly — kernel skills always regenerated (`copyDirFlat`, unconditional), non-kernel bundled skills installed only when `!fs.existsSync(target)` — but COPIES instead of symlinking, inheriting `identityNew`'s pre-existing "kernel/skills copied, not symlinked" DIRECTOR CORRECTION (a portable package has no Bash checkout to link into) | consistency with the already-accepted `identityNew` deviation, applied to the one new place that also installs bundled skills; getting the "skip if already installed" half right (not just "always copy") matters because an imported identity's OWN customized skill of that name must survive the import, not be silently clobbered by the bundled template | test/identity-import.test.ts "creates memories/skills/... and regenerates kernel + missing bundled skills"; parity/identity/run-import-parity.mjs (structural tree diff, ignoring only the pre-existing symlink-vs-copy paths) |
| `identity import` — `activate` file | `_install_imported_identity` calls `_write_activate_script` | not written — inherits `identityNew`'s existing "no `activate` file (DIRECTOR CORRECTION 1) — `resolveIdentityEnv()` replaces it" | same reasoning as `identityNew`; an imported identity is started the same way a newly-created one is (`resolveIdentityEnv`, not a sourced shell script) | parity/identity/run-import-parity.mjs (the harness's structural diff explicitly ignores `<id>/activate` as a known, pre-existing deviation) |

### Telegram bridge deviations (this lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| `config.load`/`mindlog.findTrajectory` fatal errors | `raise SystemExit("message")` — an uncaught string `SystemExit` prints the message to stderr and exits 1 | `throw new BridgeExit(message)`, caught once at the CLI boundary (`cli.ts`'s `runCli`), printed to stderr verbatim, `return 1` | Node has no `SystemExit`; `BridgeExit` is the direct analogue — same stderr text, same exit code, no other behavior change | test/telegram-config.test.ts (dangling-default-link, no-var-no-default cases assert on the thrown message) |
| `api.Bot._call`'s error contract on a network-level failure | Python's `httpx.HTTPError` (connection refused, DNS failure, a client-side timeout) is a distinct exception family from `ApiError`; `inbound.py`'s poll loop catches `(ApiError, httpx.HTTPError)` | `fetch` throws a plain `Error` for the same failure class; `Bot.call` wraps it as `HttpError` (new class, api.ts), and `Inbound.run` catches `(err instanceof ApiError \|\| err instanceof HttpError)` | Node's `fetch` has no typed transport-error hierarchy the way httpx does; `HttpError` reproduces the SAME two-bucket retry contract (a malformed Telegram reply vs. a transport failure) with a TS-native shape | api.ts / inbound.ts source; exercised indirectly by test/telegram-inbound.test.ts's "poll loop survives a malformed API response" (that case is the OTHER bucket, `ApiError`, but drives the same catch clause) |
| `outbound.start`'s concurrency primitive | a background `threading.Thread` running `outbound.run`, stopped via a shared `threading.Event` | `outbound.start` runs the async `outbound.run` loop un-awaited and returns a handle (`{stop(), done}`); `cli.ts` threads one `shouldStop` closure through both `Inbound.run` and `outbound.start` | Node has no threads; the observable behavior (a concurrently running follow-loop the caller can signal to stop, and that the CLI waits for on the way out) is the same — `stop()` flips the same kind of boolean flag `stop_event.set()` does | outbound.ts source; test/telegram-outbound.test.ts drives `run()` directly (the Python test does the same, calling `outbound.run(...)` rather than `start()`) |
| `allowlist.json`'s `pending.<id>.last_notified` units | Python's `time.time()`: seconds since epoch, sub-second float | `Date.now() / 1000`: also seconds since epoch, float, millisecond-granularity (3 decimal digits vs. Python's finer-grained fractional seconds) | matching UNITS (seconds, not milliseconds) is what keeps the on-disk field format compatible and the `PENDING_NOTIFY_INTERVAL` (24h) comparison correct; sub-second precision is inherently nondeterministic wall-clock noise on both sides and is normalized to `<TS>` by the differential harness, same treatment as timestamps elsewhere in this repo's parity harnesses | test/telegram-allowlist.test.ts "pending notifies once per interval"; parity/telegram/run-parity.mjs's `normalizeAllowlistJson` |
| Bash launcher's checkout-root discovery + `uv run --project telegram` exec (`tools/headlong-telegram-bridge`) | walks up from the launcher script's own location to find a checkout with a `telegram/` subdirectory (falling back to `$HEADLONG_HOME/app_dir`), defaults `ROOT` (the serve root) to THAT checkout root, then `exec uv run --project "$ROOT_DIR/telegram" headlong-telegram-bridge "$serve_root" "$@"` | NOT replicated — `bin/headlong-telegram-bridge.mjs`'s default root is `process.cwd()` (matching `cli.py`'s own argparse default `"."`, the same default this port's other `bin/*` tools use) | that discovery logic encodes upstream's two-directory repo layout (a `telegram/` uv sub-project alongside the Bash engine) — a shape this single-repo TS port does not have and a marker (`telegram/` existing as a directory one level down from `bin/`) that would be actively misleading here. The launcher's OTHER job — loading `.env` files so the token can live in a file instead of the calling shell, "already exported wins" — IS replicated (see cli.ts's `loadEnvFile`), since that part is layout-independent | test/telegram-cli.test.ts ".env" cases; cli.ts's header comment |
| JS `.length` vs. Python `len()` on `tgfmt.cleanInbound`'s 4000-char truncation and `senderLabel`'s 64-char cap | Python `str` is a sequence of Unicode code points; `len()` counts code points | JS `string.length` counts UTF-16 code units — a supplementary-plane character (e.g. an emoji outside the BMP) counts as 2 in JS vs. 1 in Python | inherent JS/Python string-model difference, not specific to this port; only observable at the EXACT truncation/cap boundary with a supplementary-plane character straddling it — the harness's unicode-and-hostile-name-delivery scenario (with an emoji, `🚀`) stayed well clear of both boundaries and reached PARITY, so this is a documented theoretical edge, not an observed divergence | tgfmt.ts source comment; not exercised by a scenario (would need content engineered to land exactly on the 4000th/64th unit under both counting schemes) |
| `filepayload._content`'s `content_b64` strictness (1c: ab13bab, f68ae29) | Python `base64.b64decode(b64, validate=True)` raises `binascii.Error` on any character outside the base64 alphabet or a length not a multiple of 4 | Node's `Buffer.from(s, "base64")` is lenient (silently drops invalid characters) — `filepayload.ts` adds `strictBase64Decode` (alphabet + length + padding-position checks) BEFORE handing off to `Buffer.from`, so a malformed `content_b64` fails the same way Python's `validate=True` does, rather than "succeeding" with the wrong bytes | without this, `f68ae29`'s "fail loudly on bad file bytes" guarantee would be silently defeated by Node's lenient decoder — a malformed upload would decode to truncated-but-non-empty bytes and get delivered instead of triggering the failure notice | test/telegram-filepayload.test.ts "invalid b64 is not a file", "invalid content_b64 is a decode error"; parity/telegram/run-parity.mjs's "undecodable-content-b64-falls-back-to-notice" scenario |
| `outbound.run`'s `hasattr(bot, "send_photo")`/`hasattr(bot, "send_document")` capability checks | Python duck-types via `hasattr` on the `Bot` instance | TS checks `typeof bot.sendPhoto === "function"` / `typeof bot.sendDocument === "function"` — `OutboundBotLike.sendPhoto`/`.sendDocument` are optional interface members precisely so a minimal test double can omit either, mirroring the Python tests' `FakeBot` classes that sometimes leave one method out | same duck-typed "does this object support the optional capability" check, expressed in TS's structural-typing idiom instead of Python's `hasattr` | outbound.ts source; test/telegram-outbound.test.ts's photo/document scenarios (each FakeBot implements only what its scenario needs) |
| `cli.py`'s token-redacting log formatter (1c: 44fe2f4) | httpx logs every Bot API request URL (which embeds the token) at INFO; `RedactingFormatter` is installed on the root logger (covers every module's log calls, including exception text) and httpx/httpcore are raised to WARNING unless `--verbose` | `logging.ts`'s `redact()` is a plain string function (no logging-framework formatter/handler concept in this port); `cli.ts`'s `runCli` threads a `redact`-wrapping sink through `io.stderr`, `Inbound`'s `log` option, and `outbound.start`'s `log` option, so every line this bridge writes to stderr is covered the same way the Python root logger is | Node's `fetch` does not auto-log requests the way httpx does at INFO, and `api.ts`'s `Bot.call` already omits the URL from every `ApiError`/`HttpError` message it builds (see that file's comment) — there is no per-request chatter to silence in the first place, only the same defense-in-depth belt Python wears against a token-shaped substring reaching stderr by some other path | test/telegram-logging.test.ts (`redact` cases); logging.ts / cli.ts source comments — no scenario exercises this through `runCli` itself, since (like upstream's own `cli.py`) nothing in the CLI boundary parameterizes the real `Bot`'s transport for a controlled getMe/getUpdates failure carrying a token-shaped message |

### Slack bridge deviations (this lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| `config.load`/`mindlog.findTrajectory` fatal errors | `raise SystemExit("message")` — an uncaught string `SystemExit` prints the message to stderr and exits 1 | `throw new BridgeExit(message)`, caught once at the CLI boundary (`cli.ts`'s `runCli`), printed to stderr verbatim, `return 1` | same `BridgeExit` idiom as the telegram port (errors.ts, independent files, no shared runtime code) | test/slack-config.test.ts (dangling-default-link, no-var-no-default cases assert on the thrown message) |
| `Inbound`'s worker: `queue.Queue` drained by a background `threading.Thread` (`self._worker`), started in `__init__` | Node has no threads; `onEvent()` still returns synchronously without awaiting delivery (Bolt's handler-must-return-fast contract), but delivery is chained onto a promise tail (`enqueue`/`this.queueTail`) instead of a real concurrent thread | the observable behavior (the handler returns immediately; messages are delivered in the same order they arrived, one at a time) is the same; `flush()` is a test/driver-only seam with no Python equivalent — this port's async-native way to await "the drain thread has caught up" (the differential harness's `py_driver.py` gets the same determinism from the real thread by calling `ib.stop(); ib._worker.join()`, since `queue.Queue` there has no `task_done()`-free `.join()` shortcut) | inbound.ts source; test/slack-inbound.test.ts (every case awaits `ib.flush()`); parity/slack/py_driver.py's `on_event` mode |
| `outbound.start`'s concurrency primitive | a background `threading.Thread` running `outbound.run`, stopped via a shared `threading.Event` | `outbound.start` runs the async `outbound.run` loop un-awaited and returns a handle (`{stop(), done}`) — same adaptation as `src/telegram/outbound.ts` | Node has no threads; the observable behavior (a concurrently running follow-loop the caller can signal to stop, and that the CLI waits for on the way out) is the same | outbound.ts source; test/slack-outbound.test.ts drives `run()` directly (the Python test does the same, calling `outbound.run(cfg, client, threads, stop_event)` rather than `start()`) |
| `api.py` / Socket Mode transport | does not exist as `headlong_slack` source — `App`/`WebClient`/`SocketModeHandler` are all `slack_bolt`/`slack_sdk`, a real pip dependency (pyproject.toml) | `api.ts` (`WebClient` over `fetch`) and `socketmode.ts` (a Socket Mode client over the native `WebSocket`) are from-scratch, dependency-free replacements with no 1:1 Python source to port — written from the installed `slack_sdk` source (wire format: form vs. JSON body per method, `base_url` override seam) and from Slack's public Socket Mode protocol description (envelope ack, `disconnect` reconnect), respectively | the port's "no runtime deps" rule rules out adding `@slack/bolt` or `@slack/web-api`; `slack_sdk`'s own source (not slack_bolt's) is the authoritative wire-format reference, and it was read directly rather than assumed — see parity/slack/run-parity.mjs's header for what that reading found | test/slack-api.test.ts, test/slack-socketmode.test.ts; parity/slack/run-parity.mjs (proves api.ts's wire format against the real slack_sdk, request-by-request) |
| Socket Mode reconnect/ping timing | `slack_bolt.adapter.socket_mode.SocketModeHandler`'s internal reconnect backoff and any ping/keepalive behavior are library internals, not published as a stable contract, and `headlong_slack` never overrides them | `socketmode.ts` reconnects immediately (no backoff) on a server-initiated `disconnect` envelope and has no client-initiated ping | unverifiable without a real Slack app-level token (none available in this environment); implemented from the public Socket Mode protocol description only, not from `slack_bolt`'s source or live traffic — flagged as the least-verified part of this port in its own file-header PORT-NOTE | test/slack-socketmode.test.ts (the `disconnect` case proves the reconnect-happens behavior against a fake WebSocket; the backoff/ping gap itself is untested, by necessity) |
| `outbound`'s per-chunk-failure fallback | Python's `_deliver` (inbound) has a 3-attempt retry+Slack-error-fallback; `outbound.run`'s `chat_postMessage` failure has NO retry or fallback — one failed chunk just `break`s the loop for that reply, logged via `log.exception` | ported exactly as asymmetric: `inbound.ts`'s `deliver` retries 3x with backoff then posts `DELIVERY_ERROR_TEXT`; `outbound.ts`'s per-chunk `catch` just logs and `break`s, no retry, no fallback message (there is nowhere to send one — the far end IS the failure) | faithful port of a real upstream asymmetry, not a bug in either direction — noted here so it isn't mistaken for an inconsistency introduced by the port | test/slack-outbound.test.ts "a chatPostMessage failure breaks the chunk loop without throwing"; parity/slack scenario "chat-post-message-failure-breaks-chunk-loop" |

### `identity export` / export web routes deviations (routes-d lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| `_export_append_identity`'s thinkers `cp -RL` on a dangling symlink | `cp -RL "$dir/thinkers" ...` runs ONCE for the whole subtree; a single dangling symlink inside it can make the ENTIRE `cp` fail, silently swallowed via `\|\| debug "some thinker symlinks did not resolve; dropped"` (only visible with `-v`) — worst case, the WHOLE thinkers/ subtree is missing from the archive, not just the one bad entry | walks the subtree itself; a dangling symlink is dropped ENTRY-BY-ENTRY (that one file/dir is skipped, everything else still travels) | more lenient and more useful — a single stale symlink (e.g. a `--symlinks` install pointing at a moved checkout) no longer takes the whole thinkers/ folder down with it; not reachable by any real fixture in this lane's harness (bash `identity new` in this environment doesn't use `--symlinks`), so this is a reasoned deviation, not an observed divergence | test/identity-export.test.ts "dangling thinkers/ symlink is dropped, not fatal" |
| `_export_slim_trajectories` on a trajectories/ dir with ZERO surviving files (no `.jsonl`/other regular file anywhere under it) | `mkdir -p` is only ever called per-file found by `find -type f`; zero files means the staging `.../trajectories` dir is NEVER created, then the following `tar -rf ... "$base/trajectories"` tries to archive a path that doesn't exist — under this script's `set -euo pipefail`, THE WHOLE EXPORT ABORTS | `slimTrajectoryEntries` returns no entries for that identity (skips the trajectories/ subtree in the archive) rather than throwing | an accidental Bash crash artifact (an unguarded `mkdir -p`/`tar` on a directory-that-might-not-exist), not designed behavior — same class as the `traj tail -r`/`skills` `set -e` crash-smoothing rows above. Not reachable in practice: every identity created by `identity new` (Bash or this port) always has a live root trajectory file, so `--slim` never actually sees zero files | src/identity.ts `slimTrajectoryEntries` doc comment; not exercised by the differential harness (would need a hand-corrupted identity with an emptied trajectories/ dir) |
| export-jobs' on-disk tmp file (`_export_to_tempfile`, `FileResponse(job["path"], ...)`, unlink on delete/eviction) | each export job writes its archive to a REAL tmp file on the OS filesystem, cleaned up on delete/eviction/download-complete (direct routes) or left for the next job/an operator (job routes, until deleted) | `web/server/src/exportJobs.ts` holds the built archive as an in-memory `Buffer` on the job object — no tmp file is ever created; "cleanup" is just dropping the reference (`job.buffer = undefined`) for GC | this port's exporter already builds the whole archive as a `Buffer` in one synchronous call (no `tar`/`gzip` subprocess to stream from) — writing that buffer to a tmp file just to immediately read it back for `FileResponse` would add a class of bugs (leaked tmp files on a crash, disk-full edge cases) for no behavioral benefit; the HTTP-visible contract (status, headers, bytes, job lifecycle, 409-while-running) is identical | web/server/test/export.test.ts (full job lifecycle: create → poll → download → delete) |

### web push deviations (routes-d lane)

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| `PushWatcher`'s concurrency primitive | a `threading.Thread` (daemon) looping `time.sleep(poll_s)` forever, started once by `cli.py`'s production entrypoint | `startPushWatcher` uses `setInterval` (unref'd, so it never keeps the process alive on its own), exposing `stop()`/`tick()` (the latter test-only — runs one iteration synchronously-awaited, bypassing the timer) | Node has no threads; same adaptation this port already made for the Telegram/Slack bridges' `outbound.start` (see those Deviations rows) — the observable behavior (a standing loop that tails files and can be stopped) is the same | web/server/test/push.test.ts's PushWatcher describe block (every case drives `tick()` directly rather than waiting on real timers) |
| `vapid_public_key`'s `threading.Lock()` around generate-on-first-use | guards against two concurrent Python THREADS racing to generate/write the key file | no lock — every fs call in `push.ts`'s `vapidPublicKey` is synchronous, so the check-then-generate-then-write sequence cannot be interleaved by other JS running on the same thread (Node's single-threaded event loop) | not a behavioral difference, just a different (and here, sufficient) mechanism for the same guarantee — two concurrent HTTP requests to `GET /api/push/key` on a fresh root still only ever generate one key, the same as upstream | test/push.test.ts "a second call reuses the same key" |
| VAPID JWT `exp`/`aud` claim computation | `webpush()` (pywebpush) computes `aud` from the subscription endpoint and sets `exp` to `now + 12h` ONLY if the caller-supplied `vapid_claims` dict doesn't already have a still-valid one — `push.py` never supplies `aud`/`exp` itself, so this path always runs | `sendWebPush` always computes `aud`/`exp` itself the same way (push.ts never accepts caller-supplied `aud`/`exp`, since nothing in this port's call chain ever needs to override them) | this port only needs the one call shape `push.py`'s `_send` actually uses (matching the task's "port faithfully what's used" scope) — the more general pywebpush `webpush()` signature (an already-valid caller-supplied `exp`, a pre-built `Vapid` instance, `curl=True`, `aiohttp`, etc.) is not ported, since nothing in this port's call chain needs it | web/server/test/push.test.ts "VAPID aud matches the endpoint's own scheme+host" |

## Gaps (every stub lives here — nothing stubbed silently)

mem, skills, and rollups are now SHIPPED and at parity (see the module table and
differential proofs under `parity/`). The per-wake system-prompt rows below are
RESOLVED (2026-10-29); no stub remains in this table:

| Where | Missing / stubbed | Impact | Target |
|---|---|---|---|
| monolith/responder system prompt (`identityText`, `skillsText`) — **RESOLVED** (see "Replay seam removal and K1-K3") | the engine pre-injects a STATIC `identity prompt` / `skills prompt` blob (src/monolith.ts:43-44, scripts/real-wake.ts) rather than re-rendering it live each wake | the `skills` CLI + its `skills prompt` renderer are at parity and on the sandbox PATH; only the per-wake re-render into `buildSystemPrompt` is stubbed | wire `skills prompt` (and identity prompt) into buildSystemPrompt |
| test fixtures skillsText — **RESOLVED** | "(stub)" placeholder skill text in tests (now `(no skills installed)`) | test-only; the real `skills prompt` renderer is exercised by test/skills.test.ts + parity/skills | tracked here |
| `SHELLM_SYSTEM_PROMPT` env override (bin/shellm:198,1548-1549) — **RESOLVED** | monolith.ts used to always call `runShellm` with the bundled `SHELLM_SYSTEM_PROMPT` constant (`src/prompts.ts`); no plumbing read the env var to override it | fixed: `steprun.ts`'s `buildIdentityConfig` reads `SHELLM_SYSTEM_PROMPT` (`[[ -n ]]`-gated, same as the Bash — set-but-empty does not override) into `IdentityConfig.systemPrompt`; `monolith.ts` uses it + `"\n"` (matching `printf '%s\n'`) in place of the bundled default when set | test/steprun.test.ts "SHELLM_SYSTEM_PROMPT override" (override with/without its own trailing newline, unset, set-but-empty) |
| `shellm-run` header's `max_tokens` field (bin/shellm:2149-2151 `--arg max_tok "${SHELLM_MAX_TOKENS:-}"`) — **RESOLVED** | `src/shellm.ts`'s `runShellm` hardcoded `max_tokens: ""` on the recorded header row; `SHELLM_MAX_TOKENS` IS wired to the real `OpenRouterClient` call (see the shellm env-knob parity fix above), just not to this recorded field | fixed: `IdentityConfig.maxTokens` (raw `SHELLM_MAX_TOKENS` text, empty when unset — same as the Bash's `${…:-}`) threads from `steprun.ts` through `monolith.ts`'s header into `RunShellmOptions.header.maxTokens`, replacing the hardcoded `""` | test/steprun.test.ts "shellm-run header's max_tokens" (set and unset) |
| retrieval on the in-process bus (src/topology.ts) — **RESOLVED for the daemon path** | the monolith's own thoughts/observations are written by the `traj` shim in a subprocess; the in-process ObservableTrajectory never sees them (dispatcher.ts fidelity note), so they cannot wake retrieval in the port topology. Upstream's file bus delivers them — 4 of the 5 pax retrieval wakes (rows 715→716, 771→772, 806→810, 853→856) were monolith-written triggers | STILL a gap for `src/topology.ts`'s in-process harness (unchanged, by design — see "topology.ts stays the in-process test harness" in the daemon module row). NO LONGER a gap for the real daemon: `src/daemon.ts`'s `TrajFeeder` reads the trajectory FILE, so it sees every append regardless of which process (in-process code or the `traj` shim) wrote it — the daemon's file-tail bus closes this exactly as this row predicted | daemon.test.ts (out-of-process appends are fed and dispatched); no topology.ts change needed or made |
| dispatcher boot kick payload vs retrieval — **RESOLVED** | `Dispatcher.bootTrigger` used to hand thinkers `{type:"manual-trigger", content:"manual trigger", source}`; upstream's pending file is `{type:"manual-trigger", source:"thinkers-cli", ts}` — NO content | fixed in this lane's dispatcher.ts refactor: `bootTrigger` now sends `{type:"manual-trigger", source}` with no `content` field, matching upstream exactly (see the "Daemon-runtime deviations" table above) | topology.test.ts "spontaneous/manual-trigger:thinkers-cli"; runstate.test.ts `manualTriggerJson` (no content) |
| `llm` anthropic / gemini / opencode-Zen / adapter wire paths — **RESOLVED** | used to detect + check keys, then die `... provider wire path not yet ported` | fixed: all four wire paths ported (payload build, headers/auth, response parsing, streaming, and the adapter exec seam) — see the "llm tool" module row and "llm slice 2 parity fixes" above | `parity/llm/run-parity.mjs` 217/217 (0 port bugs); `tests/test_llm_adapter.sh` via `parity/upstream-tests/run.mjs` 20/20 |
| `bin/mem.mjs` stdin read — **RESOLVED** | `fs.readFileSync(0)` used to return "" on EAGAIN (a non-blocking pipe from a Node parent) — `mem add`/`mem edit` via piped stdin could lose their text; now fixed: `bin/mem.mjs` imports the shared `readStdinSync` from `src/stdin.ts` (a `readSync` loop that waits out EAGAIN instead of discarding partial reads), the same helper `bin/llm.mjs` uses | resolved — piped stdin for `mem add`/`mem edit` no longer loses text on EAGAIN | test/stdin.test.ts ("mem add — piped stdin over 512 KiB, delivered in delayed chunks", incl. an aggressive small-chunk EAGAIN-triggering feed) |
| `POST /api/update` — **RESOLVED** (routes-d lane) | §B route 15 (`git pull --ff-only` + scheduled restart, literal HTTP 202 even on a no-op) | `web/server/src/selfUpdate.ts` `runSelfUpdate` — real `git pull --ff-only` against the port's own checkout, `_requireControls` then `HEADLONG_WEB_SELF_UPDATE=1`-gated (403 either way), a process-wide lock (409 on a concurrent call), `config.self_update_enabled`/`git_commit`/`git_branch` now reflect the real, once-at-startup-resolved values (no longer hardcoded) | none — closed; test/selfUpdate.test.ts (18 cases against real scratch git repos — fast-forward, diverged/`--ff-only` failure, concurrency, up-to-date no-op) |
| `POST /api/identities/:id/export-jobs`, `GET .../export-jobs`, `DELETE /api/export-jobs/:job_id`, `GET /api/export-jobs/:job_id`, `GET /api/export-jobs/:job_id/download`, `GET /api/identities/:id/export`, `GET /api/export` — **RESOLVED** (routes-d lane) | §B routes 16/17 (in-process job registry, NOT controls-gated upstream) + `identity export` itself | all seven routes are now real, correctly bypassing `_requireControls` (the very gap this row used to warn about) — see the "web control plane" and "identity export" module rows, `web/server/src/exportJobs.ts`, and `parity/identity/run-export-parity.mjs` (6/6 PARITY) | none — closed |
| `GET /api/push/key`, `POST /api/push/subscriptions`, `POST /api/push/unsubscribe` — **RESOLVED** (routes-d lane) | §B route 18/19 (web-push `addSubscription`/`removeSubscription`, RFC 8291/8292 crypto via `py_vapid`/`pywebpush`) | all three routes are real; the underlying VAPID/aes128gcm crypto (`web/server/src/webpushCrypto.ts`) and the mind-log-tailing `PushWatcher` (`push.ts`) are also ported, cross-language interop-proven against the real Python libraries — see the "web push" module row and `parity/push/report.md` (6/6 PASS) | none — closed |
| `identity list` (`bin/identity` / `src/identity.ts`) — **RESOLVED** (port/identity-list lane) | `identity list [-a]` is now ported (`src/identity.ts` `identityList`, `bin/identity.mjs`) — see the "identity list" row in the module table and `parity/identity/` (17/17 byte-identical differential) | the Rust `tui/`'s `/identities` mode used to run `identity list` and get `Usage: identity new [--default] [--memories DIR] <name>` instead of a listing; it now returns a real listing, re-verified end to end via `resolveIdentityEnv()` + the port's own `bin/identity` — see `tui/PARITY-RECEIPT.md`'s "Gap 1 (`/identities`) closed" heading | none — closed |
| slack bridge live Socket Mode leg (`src/slack/socketmode.ts`, `src/slack/cli.ts`) | no real Slack bot/app-level token is available in this environment, so this port has never made a real `apps.connections.open` call or held a real WebSocket connection to `slack.com` — `socketmode.ts` was implemented from Slack's public protocol description, not verified against live traffic or against `slack_bolt`'s own reconnect/ping timing (unpublished as a stable contract) | `headlong-slack-bridge` cannot be assumed to run correctly end to end against a real workspace until this leg is exercised with a real app; every OTHER piece (config/naming/mindlog/state/slackfmt/inbound's event-gate+delivery/outbound/the Web API wire format) IS proven via parity/slack's 15/15 differential run against the real `headlong_slack` | test/slack-socketmode.test.ts (fake WebSocket only); parity/slack/report.md's header notes the deferral; whoever gets a real Slack app token should smoke-test `bin/headlong-slack-bridge.mjs` against a live workspace before relying on it in production |
| env image identity (upstream 0925168, `env_metadata_matches`/`_resume_docker_image`, bin/shellm) — **RESOLVED (bug #32)**, correcting an earlier N/A verdict | upstream's `bin/shellm` reuses any RUNNING named env (`SHELLM_ENVS_DIR`, `env_find_running`) whose metadata matches a requested `--docker-image`, across separate `shellm` CLI invocations, and 0925168 fixes a real hazard there: a second run asking for a different image silently reattached to the first run's container. **Correction:** the earlier N/A verdict here reasoned this port "has no such mechanism to have the bug in" because `selectSandbox` created exactly one container per step and always tore it down — but that per-step-only lifecycle WAS itself the port bug (#32: no reuse across wakes at all, closer to the original hazard's opposite failure mode than to having nothing to disagree on). Now ported: `src/sandbox-env.ts` gives each identity/env name a persistent container reused across wakes, with metadata at `<identityDir>/.shellm/envs/<name>/` (this port's `SHELLM_ENVS_DIR`, matching `tools/identity:375,1381` exactly — the same directory upstream's own env registry would use for the same identity), and `envMetadataMatches`/`envMetadataMismatchMessage` port the image-identity subset of `env_metadata_matches`/`env_metadata_mismatch_message` (bin/shellm:749-798,811-846): a stored env whose recorded image disagrees with the one requested throws upstream's exact `die()` text rather than silently reattaching. (No `--docker-image` explicit-vs-default distinction, `env_find_running`-by-scan, or standalone `shellm` CLI exist in this port — env resolution is always by identity name, matching every real thinker wake, which upstream itself treats as the "explicit" `--env` case, i.e. always `die()` on mismatch, never a silent skip.) `docker_image`/`docker_image_digest` continue to land on the trajectory's `shellm-run` header (`env: EnvSpec`), now reflecting the ACTUALLY reused/created container on every wake | `test/sandbox-env.test.ts` (real docker, skips cleanly without a daemon): "image mismatch refuses reuse with upstream's exact message (0925168)" asserts the literal upstream `die()` string byte-for-byte; "two consecutive wakes reuse the same container" proves the reuse side; bug #55's "(a) recorded container id no longer exists" proves a fully-removed container now dies (not silently recreated) with upstream's exact message. `tests/test_env_image_identity.sh` (real bash, 12/12 pass against NEW upstream, unchanged from before) still documents the behavior being matched; not run differentially (still no standalone `shellm` CLI to diff against) — matched by direct message-string comparison instead |
| `persona` (per-identity command wrapper: `ada`, `ada stop`, `ada "hello"`) | not shipped by this port at all — no `bin/persona`, no TS equivalent | `install.mjs` never creates an identity-name command link (`_link_persona_command` in `src/init.ts` is therefore always a no-op, matching upstream's own `[[ -e "$target" ]] \|\| return 0` guard when persona is absent — which is this port's actual, permanent situation); `headlong-init`'s summary, and `status.mjs`'s command rows, print `persona <name>` command lines the same way upstream would print them in that same situation — technically accurate to the upstream TEXT, not to a tool this port ships. Use `node bin/chat.mjs`, `node bin/thinkers.mjs stop`, etc. directly for now. | none yet — `install-lib.ts`'s/`init.ts`'s file-header PORT-NOTEs; `parity/upstream-tests/report.md`'s smoke_install.sh detail row for `persona`'s own `--help` check (skipped: no persona binary to check) |
| global `~/.skills/core-skills` / `~/.headlong-thinkers` staging (`install.sh`'s `_install_skills`/`_install_thinkers`) | `install.mjs` has no equivalent step at all — see `src/install-lib.ts`'s file-header PORT-NOTE | this port's `identity new` (`src/identity.ts`) bundles skill/thinker templates straight from `src/assets/` into each identity at creation time, with no global staging directory in between — so after `node install.mjs`, `~/.skills/core-skills` and `~/.headlong-thinkers` simply do not exist (upstream always populates both). Observable difference, not a behavior bug in anything this port DOES do; surfaced honestly by `parity/upstream-tests/run.mjs --installer`'s `smoke_install.sh` run ("core skills installed" + 4x "thinker template copied: <name>" port-only failures, root-caused in `parity/upstream-tests/report.md`'s Installer lane detail). | `parity/upstream-tests/report.md` (Installer lane, smoke_install.sh) |
| `SHELLM_DOCKER_ACCESS` broker/socket/dind modes (bin/shellm:88,527-529,918-1149) | upstream validates the env var against `none\|broker\|socket\|dind` (`case` at bin/shellm:527-529, `die "Invalid --docker-access: $SHELLM_DOCKER_ACCESS ..."` on anything else) and, for the three non-`none` values, sets up broker-process forwarding, a bind-mounted `/var/run/docker.sock`, or a privileged `dind` container respectively. The port reads `SHELLM_DOCKER_ACCESS` NOWHERE — confirmed, zero references anywhere in `src/`, `test/`, or `bin/` — so the env var has NO effect at all: no validation (an invalid value that upstream would `die()` on is silently accepted), no broker/socket/dind behavior (a value upstream WOULD implement is silently ignored). `sandbox-runtime.ts`/`sandbox-env.ts` unconditionally record `docker_access: "none"` in the run's own env-spec metadata regardless of what, if anything, the caller set. | a skill that shells out to `docker` from inside the sandbox, or that relies on `SHELLM_DOCKER_ACCESS=socket`/`dind` for nested Docker access, silently gets a `none`-mode container instead of failing loudly or getting the requested access — worth knowing before relying on any docker-in-docker workflow in the port | none — declared scope-cut (parity/RUNTIME-SEAMS.md §B "docker container creation" row, §D item 7); no test asserts the silent-ignore behavior since there is no behavior to assert beyond the hardcoded `"none"` already covered by sandbox-runtime/sandbox-env tests |
| whole-agent-in-Docker menu, real execution (`install-lib.ts`'s `offerDockerInstall`) | the interactive 3-way menu (fully in a container / on this machine sandboxed / on this machine unsandboxed) and the real `docker run ... buildpack-deps:curl bash -c 'curl ... \| node -'` invocation are ported and type-checked, but — like upstream's own test suite, which pins only the pure `_docker_forward_args` secret-forwarding helper — never exercised end to end by an automated test (it starts a real, long-running Docker container and re-enters the whole installer inside it). `dockerForwardArgs`/`locationOfferAvailable`/`parseDockerMenuChoice` (the decision logic) ARE unit-tested (`test/install-lib.test.ts`, mirrors `tests/test_install_secret_argv.sh`/`test_installer_prompt_defaults.sh`). | anyone relying on `install.mjs`'s "1) Fully inside a Docker container" choice should smoke-test it by hand once against a real Docker daemon before depending on it | test/install-lib.test.ts (decision logic only) |

### daemon-runtime gap fixes (this lane, now matching Bash)

Both found by running upstream's own suites through `parity/upstream-tests/run.mjs --daemon`; each was a real divergence confirmed by reading the port source against `bin/thinkers`, then fixed and re-verified against the same oracle (both suites now report `parity`; see `parity/upstream-tests/report.md`'s summary table).

- **`Dispatcher.scheduledWakeCheck` pruned orphaned `*.wake_at` files by the
  registered-thinkers map, not by disk** (`src/dispatcher.ts`) — it iterated
  `this.thinkers.keys()` (populated from real `thinkers/<name>/` directories
  at boot) instead of globbing `run/*.wake_at` the way upstream's
  `_scheduled_wake_check` does (`bin/thinkers:664`, `for _wf in
  "$run_dir"/*.wake_at`). A `<name>.wake_at` file for a name with no
  corresponding `thinkers/<name>/` directory at all was structurally never
  visited, so it was never removed (upstream removes it on the very next
  tick via `grep -qx "$_wname" active_thinkers` failing, `bin/thinkers:667`).
  Fixed: `scheduledWakeCheck` now `fs.readdirSync`s `stateDir` and filters
  for `*.wake_at` entries, deriving the name from the filename — same source
  of truth as upstream's glob. `isActiveName`'s existing false-for-unregistered
  path (mirroring the `grep` failing) still prunes the file. Found by
  `tests/test_thinkers_wake_at.sh` Test 5 (`test_bad_files_dropped`, the
  `nobody.wake_at` case): port 13/14 -> 14/14. Unit tests:
  test/dispatch-mechanics.test.ts "scheduled wake / run/<name>.wake_at"
  (orphaned-name pruning, normal registered-thinker firing unaffected,
  garbage-content pruning).
- **`thinkersStop`/`drainThenFinish` never ran a thinker's own
  `<thinker_dir>/stop` script** (`src/thinkersctl.ts`) — upstream `bin/thinkers`
  runs it in FOUR places: the drain reaper after in-flight steps exit
  (`bin/thinkers:1259`, inside `_drain_then_finish`), the stop-all drain
  reaper (`:1273`, inside `_drain_all_then_finish`), the named
  force/no-in-flight synchronous branch (`:1356-1357`), and the stop-all
  synchronous fallback loop (`:1423,1425`) — all four were absent from the
  port. Fixed: a new `runStopScript` helper execs `<thinker_dir>/stop`
  (failure-open, matching `|| true`) at all four sites, with `cwd` pinned to
  `IDENTITY_DIR` (upstream leaves cwd unspecified — see the function's
  PORT-NOTE) and the full identity `env`. The two drain sites additionally
  needed a second fix to actually return control to the caller immediately:
  an un-awaited in-process `setTimeout` loop lets a library caller's own
  Promise resolve right away, but Node's event loop — and therefore the
  standalone `bin/thinkers.mjs stop` CLI PROCESS — stays alive for as long
  as a pending timer exists, so the CLI hung until the whole drain finished
  regardless (silently failing "stop returns immediately" against the real
  oracle, which times the CLI invocation, not just the promise). `bin/thinkers-drain.mjs`
  is now spawned detached + `unref()`'d (same technique `thinkersStart`
  already uses for the dispatcher) to do the wait-then-TERM-then-KILL-then-stop-script
  work as a genuinely separate OS process, mirroring upstream's own `(...)
  </dev/null >/dev/null 2>&1 & disown` background subshell. Found by
  `tests/test_thinkers_drain.sh`: port 11/20 -> 20/20. Unit tests:
  test/thinkersctl.test.ts "stop scripts (bin/thinkers:1259,1273,1356,1423 …)"
  (no-in-flight sync run, `--force` sync run, drain defers until the step
  exits then the detached reaper runs it, stop-all drain runs every enabled
  thinker's script — not just the one that was in flight).
- **`requireEnv` never checked `THINKERS_DIR` actually exists, AND (found
  characterizing the sealed holdout for this same bug) skipped straight past
  upstream's EARLIER required-variable checks (BUG #67, bin/thinkers:138-155
  `_require_env`)** (`src/thinkersctl.ts`, `bin/thinkers.mjs`) — upstream's
  `_require_env` runs, in this exact order, before `status`/`start`/`stop`/
  `list`/`step`/`logs` do anything else: (1) `[[ -n "$IDENTITY_DIR" ]] || die
  "IDENTITY_DIR not set. Run: identity shell <name>"`, (2) the same check for
  `TRAJ_DIR`, (3) the same check for `TRAJ_ID` — none of these three have ANY
  fallback, ever, regardless of whether `IDENTITY_DIR` points at a real
  directory (verified against the oracle: `env -i PATH="$PATH"
  IDENTITY_DIR=<a real, existing identity dir> bash bin/thinkers status`
  still says `TRAJ_DIR not set...` — only `identity shell <name>`'s
  `activate` script, a wholly separate process, ever sets these two) — (4)
  `IDENTITY_NAME` defaults to `grep '^name=' $IDENTITY_DIR/info.txt` else
  `basename $IDENTITY_DIR` if unset, (5) `THINKERS_DIR` defaults to
  `$IDENTITY_DIR/thinkers` if unset, (6) `[[ -d "$THINKERS_DIR" ]] || die
  "Thinkers directory not found: $THINKERS_DIR"`, (7) `MEM_DIR`/`SKILLS_DIR`/
  `SKILLS_KERNEL_DIR`/`SHELLM_HOME` each default to `$IDENTITY_DIR/<sub>` if
  unset (never a die). The port's `requireEnv` originally only checked the
  four vars were non-empty STRINGS (no existence check at all — step 6
  above) — first fixed by checking `THINKERS_DIR` with `fs.statSync`. That
  fix was verified against two scenarios, `missingThinkersDir` (a real
  identity with `thinkers/` removed) and `missingIdentityDir` (EVERY var,
  including `TRAJ_DIR`/`TRAJ_ID`, explicitly set to paths under a
  nonexistent identity dir) — both of which, on the real Bash side, ALSO
  land on step 6 (`_require_env` never sees `TRAJ_DIR`/`TRAJ_ID` as unset
  when they're explicitly provided), so they never actually exercised steps
  1-3's ordering. The sealed-holdout shape — `IDENTITY_DIR` set (to a
  nonexistent path) and NOTHING else identity-related — does: on the real
  Bash side it dies at step 2 (`TRAJ_DIR not set...`), but the port's
  `bin/thinkers.mjs` unconditionally called the port's activate-equivalent
  `resolveIdentityEnv()` whenever `IDENTITY_DIR` was merely present in
  `process.env` (a "helpfulness" with no upstream analogue — upstream's
  bin/thinkers never resolves anything itself outside `_require_env`, that
  is `identity shell <name>`'s job, done once, in a different process,
  before bin/thinkers ever runs), which synthesized `TRAJ_DIR`/`TRAJ_ID`
  from `IDENTITY_DIR` regardless of whether the caller ever set them —
  masking exactly the "activate never ran" case steps 1-3 exist to catch,
  and falling through to step 6's `Thinkers directory not found: <dir>`
  instead. A SECOND bug was found alongside this one, also invisible to
  every pre-existing test because none of them called through the actual
  `bin/thinkers.mjs` CLI entry point (all called `thinkersStatus`/etc.
  directly): the three step 1-3 checks baked `thinkers: error: ` into their
  own thrown message, and `bin/thinkers.mjs`'s top-level catch added a
  SECOND copy on top of that — `thinkers: error: thinkers: error: IDENTITY_DIR
  not set...` at the CLI level even though the bare message text looked
  correct at the library level. Fixed: `requireEnv` now reproduces steps 1-7
  above verbatim, in order, with no prefix baked into any of them (the
  `bin/thinkers.mjs` catch adds that single prefix once, matching upstream's
  `die()` byte-for-byte); `bin/thinkers.mjs` no longer pre-resolves anything
  from `IDENTITY_DIR` — it passes `process.env` straight through, exactly
  like upstream's own bin/thinkers (callers that need the port's
  activate-equivalent env — this port has no separate `identity shell` —
  build it themselves via `resolveIdentityEnv` before calling into
  `thinkersctl.ts`: `web/server/src/control.ts`, the `parity/{live,replay}`
  harnesses, and this file's own tests already did). Verified identical
  stdout ("")/stderr/exit code against the real Bash oracle for
  `status`/`start`/`stop`/`list`, across: `IDENTITY_DIR` itself missing (all
  vars explicit), `THINKERS_DIR` only missing (all vars explicit), AND the
  sealed-holdout shape (`IDENTITY_DIR` set, nothing else) at both the
  library level (hand-built `Partial<ThinkersEnv>` objects) and the real CLI
  level (`node bin/thinkers.mjs status` with an exact, non-merged env).
  Unit tests: test/thinkersctl.test.ts "missing THINKERS_DIR (BUG #67,
  bin/thinkers:151 …)" (the original 3 cases) plus "requireEnv
  startup-validation order (BUG #67, bin/thinkers:138-155 `_require_env`) —
  matrix" (9 new cases: each of IDENTITY_DIR/TRAJ_DIR/TRAJ_ID missing alone,
  IDENTITY_DIR-only against both a nonexistent and a real-but-unactivated
  dir, THINKERS_DIR missing both explicitly and IDENTITY_DIR-derived, the
  sealed holdout through the real CLI for all four subcommands, the
  double-prefix regression check, and a fully-activated real identity
  through the CLI as a sanity control). Also extended
  `parity/daemon/run-parity-adversarial.mjs`'s "misuse" flow with a third
  `identityDirOnly_*` scenario (12 checks: status/start/stop/list ×
  stdout/stderr/exit) alongside the pre-existing `missingThinkersDir_*`/
  `missingIdentityDir_*` ones, run against the real Bash oracle
  (`PARITY_HEADLONG_ROOT=<headlong checkout> node
  parity/daemon/run-parity-adversarial.mjs`) — all 12 PARITY.

### `identity` subcommand inventory (port/identity-list lane)

Every subcommand `tools/identity` offers (from its own `usage()`, tools/identity:1509-1543), and what — if anything — in this port calls it. Only `list` had an actual caller with no port support, so only `list` was ported in this lane; per the lane's instructions, a subcommand gets its own Gaps row only when something in the port calls it and it isn't ported. That is true for none of the remaining nine below (each checked by grepping this whole checkout, `tui/`, `web/`, `src/`, `bin/`, `scripts/` for `identity <subcommand>` call sites — comments/doc-strings/error-message text pointing a human at a Bash command, e.g. "Run: identity shell <name>", are not calls and are noted as such, not counted as "needed by").

| Subcommand | Status | Needed by |
|---|---|---|
| `new` | ported (pre-existing, `src/identity.ts` `identityNew`) | `web/server/src/control.ts` `identityNew` (calls the library function directly, not the CLI); `bin/identity new` itself |
| `list` | **ported (this lane)**, `src/identity.ts` `identityList` + `bin/identity.mjs list` | Rust TUI's `/identities` mode — `run_cmd("identity", &["list"])`, `tui/headlong/src/main.rs:759` |
| `info` | not ported | no caller found anywhere in this port |
| `sync-kernel` | not ported | no caller found |
| `sync-thinkers` | not ported (this CLI subcommand specifically) | no caller found in the port's own code. (`parity/upstream-tests/run.mjs`'s daemon lane runs upstream's OWN Bash test `test_identity_sync_thinkers.sh` against a scratch copy substituting `bin/identity.mjs` for `tools/identity` — that upstream TEST calls `identity sync-thinkers` and fails, a pre-existing documented gap, not a new caller inside this port.) **Not the same thing as `POST /api/identities/:id/thinker-sync`**, which is now real (routes-c lane) — that web route's oracle is `headlong_web/thinker_sync.py`'s `sync()`, called DIRECTLY by `server.py`'s route handler, never through `tools/identity sync-thinkers` at all; this port's `web/server/src/thinker-sync.ts` ports that Python module, not this CLI subcommand. See the "web control plane" module row. |
| `default` | not ported | no caller found |
| `delete` | not ported | no caller found |
| `export` | not ported | no caller found (`web/viewer/app/routes/home.tsx:166` and `config.tsx:281` mention "`identity export`" only in help/doc TEXT shown to a human, never invoked) |
| `import` | **ported (routes-c lane)**, `src/identity.ts` `identityImport` + `bin/identity.mjs import` | `web/server/src/control.ts` `identityImport` (calls the library function directly, not the CLI) for `POST /api/identities/import`; `bin/identity import` itself. See the "web control plane" module row and the "Web control-plane deviations" table's `identity import` rows for what differs from `_install_imported_identity`. Differential: `parity/identity/run-import-parity.mjs`, 6/6 PARITY vs the real Bash `tools/identity export`+`import`. |
| `shell` | not ported | no caller — `resolveIdentityEnv()` (`src/identity-env.ts`) supplies the same env vars as a pure function for every port code path that needs them (DIRECTOR CORRECTION 1); the many "Run: identity shell <name>" strings (`src/focus.ts`, `src/chat.ts`, `src/steprun.ts`, `src/retrieval.ts`, `src/thinkersctl.ts`) are human-facing error-message text, not calls |
| `prompt` | not ported | no caller — the port assembles its system prompt a different way (`src/prompts.ts`, `src/steprun.ts`); "`identity prompt`'s core-identity block" comments there describe what upstream text was ported into the constant, not a shell-out |

### `mem search` mid-wake: what the sandbox env must carry

The shellm loop (`src/shellm.ts`) execs the model's bash with `{...execEnv, PATH: <binDir>:<nodeDir>:<system PATH>, SHELLM_RUN_STEP_ID, SHELLM_WORKDIR, HOME: <workdir>}`, where `execEnv` (src/monolith.ts) is `IDENTITY_NAME, TRAJ_DIR, TRAJ_ID, MEM_DIR, SKILLS_DIR, SHELLM_MODEL, SHELLM_TRUNCATE` + the identity's own `execEnv`. DockerSandbox forwards exactly that set as bare `-e NAME` flags. For `mem search` → `llm` to work:

- already forwarded: `PATH` (resolves `llm` and `node`), `SHELLM_MODEL` (the default model when `SHELLM_FAST_MODEL` is unset — `mem` passes the latter as `-m`), `IDENTITY_NAME` (ledger identity stamp), `SHELLM_RUN_STEP_ID` (ledger `run_id`), `HOME=<workdir>` (so the state home defaults to `<workdir>/.headlong`: health marker at `<workdir>/.headlong/run/llm_health.json`, ledger at `<workdir>/.headlong/usage/llm.jsonl`).
- must be added to the identity's `execEnv` (nothing forwards it today): the provider key — `OPENROUTER_API_KEY` for the default `vendor/model` names (or `OPENAI_API_KEY` / `OPENCODE_API_KEY`), or `LLM_PROVIDER=openai-compatible` + `LLM_API_URL` (or `SHELLM_API_URL`) [+ `LLM_API_KEY`] for a local endpoint. Alternatively a `.env` in the workdir or in `<workdir>/.headlong/.env` supplies them through the tool's own `.env` layering with no env forwarding at all.
- optional: `SHELLM_FAST_MODEL`, `HEADLONG_HOME`/`SHELLM_HOME` (to relocate marker + ledger), `IDENTITY_DIR` (ledger → `$IDENTITY_DIR/usage/llm.jsonl`), `LLM_USAGE_LEDGER`, `LLM_RETRIES`/`LLM_RETRY_BACKOFF`/`LLM_MAX_TIME`/`LLM_SPEED_*`, `LLM_MAX_TOKENS`.

### sandbox parity fixes (behavioral, now matching Bash)

- **host HOME leaked into the docker CLI's own env (PORT-BUG, found in a live run)** —
  FIXED in `src/sandbox-docker.ts` `DockerSandbox.buildChildEnv`/`buildDockerExecArgs`.
  `req.env` always carries `HOME=<workdir>` (`src/shellm.ts`, mirroring
  `bin/shellm:1309-1328`'s `docker_env_flags+=(-e "HOME=$workspace")`), and
  `buildChildEnv` was overlaying every non-`PATH` `req.env` key — including that
  workdir `HOME` — onto the env of the HOST `docker` process itself (the process
  that runs `docker exec`, not the container). With `HOME` pointed at the workdir,
  the host docker CLI can't find `~/.docker/config.json`, silently falls back to
  the default socket, and every `docker exec` fails
  (`failed to connect to the docker API at unix:///var/run/docker.sock`) even
  though `docker run`/container creation — which doesn't read that config —
  still succeeds. `buildDockerExecArgs` had a matching second bug: its bare
  `-e NAME` loop also emitted a bare `-e HOME` for the same key, duplicating the
  explicit `-e HOME=<workdir>` it already pushes for the container. Fix: `HOME`
  is now treated exactly like `PATH` in both methods — dropped from the generic
  per-key loop, host `HOME` never overlaid, and the container still gets exactly
  one `-e HOME=<workdir>` (upstream's `bin/shellm:1309-1328` never puts `HOME` in
  `env_vars` either — grep confirms the only `HOME=` sites in `bin/shellm` are the
  two explicit `-e HOME=$workspace` docker flags, lines 869 and 1320). LocalSandbox
  is untouched: it never inherits `process.env` at all (`env: req.env` is the
  entire child env), so its `HOME=<workdir>` behavior is unaffected. Regression
  tests: `test/sandbox-docker.test.ts` (`buildChildEnv` host-HOME case,
  `buildDockerExecArgs` single-HOME-flag case, and a real-docker-daemon round
  trip through `selectSandbox`); `scripts/live-proof.ts` and
  `test/live-loop.test.ts` now also require at least one `shell-output` row with
  `exit:0` in the trajectory, so a broken exec path can never pass either
  acceptance oracle silently again.

- **PORT-NOTE (bug #70, director-verified live run, bin/shellm:216-221 `_shellm_container_api_url`) — a Docker sandbox's `LLM_API_URL`/`SHELLM_API_URL` stayed loopback, never rewritten at run time.** `mem search` inside the sandbox got `connect ECONNREFUSED 127.0.0.1:<port>` ×5: a loopback URL names THIS HOST from inside the container, not the sandbox. Upstream rewrites it to `host.docker.internal` for the container's exec env (bin/shellm:2659-2662/2679-2680/2712) and adds `--add-host host.docker.internal:host-gateway` to the container it starts (bin/shellm:1026-1034), gated on the SAME loopback predicate so the two can never disagree; this port did both ONLY at install time (`src/init.ts`'s `localContainerUrl`, `src/install-lib.ts`'s `dockerForwardArgs`), never at run time in `src/sandbox-runtime.ts`/`src/steprun.ts`. FIXED: `src/sandbox-runtime.ts` gains `containerApiUrl` (wraps the shared `net-url.ts` `urlIsLoopback`/`urlHostSwap` `init.ts`/`install-lib.ts` already use) and `applyDockerApiUrlRewrite` (rewrites only `SHELLM_API_URL`/`LLM_API_URL`, only when `envType==="docker"`); `src/steprun.ts`'s `runStep` calls it once, right after `selectSandbox` resolves the env type — the host-side `buildLlmClient` call is untouched, keeping the original loopback URL (matching "the main shellm process keeps the host URL", bin/shellm:2657-2658). `startDockerSandbox`'s fresh `docker run` gains `--add-host host.docker.internal:host-gateway` under the identical predicate (`needsHostGateway`). Scope note: this port has no wired equivalent of upstream's process-vs-file endpoint-alias canonicalization (`resolveShellmApiUrl` in `src/shellm.ts` remains unwired, per the "callout (c)" entry elsewhere in this file), so the two env vars are rewritten independently rather than from one canonical value — identical to upstream whenever they already agree, which is the common case. Tests: `test/sandbox-runtime.test.ts` (rewrite matrix incl. IPv6 `::1`, userinfo/port/path preservation, non-loopback passthrough; `applyDockerApiUrlRewrite` local-vs-docker; `--add-host` present/absent via a fake `docker`), `test/sandbox-runtime-docker.test.ts` (REAL docker: unrewritten URL refused from inside the container, curl exit 7; rewritten URL reaches a real host-loopback listener through `--add-host`), `test/steprun.test.ts`'s new Docker-mode `runStep` wiring test (fake `docker` on PATH, no daemon). `parity/sandbox/run-parity.mjs`'s new `loopback-rewrite` scenario.

- **flat wall-clock timeout instead of an inactivity watchdog (bug #33, RUNTIME-SEAMS.md §B priority item 2)** —
  FIXED in `src/sandbox.ts` (`execWithInactivityWatchdog`, shared by
  `LocalSandbox` and `DockerSandbox`). Before: both sandboxes ran
  `spawnSync({timeout: inactivityMaxMs})` — a single 900s wall clock that
  fires whether or not the command is actively producing output, the exact
  opposite of `bin/shellm:2618-2690`'s design (kill on genuine SILENCE only:
  a short idle timer that resets on any output byte, plus a longer hard
  ceiling that resets only on real output). Fix: `exec()` is now `async`
  (`Sandbox.exec(): Promise<ExecResult>`, a real `spawn()` not `spawnSync`),
  and tracks the same two independent timers upstream does — see the `KILLED`
  kill-reason deviation row above (now RESOLVED) for the full mechanism, the
  "nested"→"max" label note, and the DockerSandbox-beacon-unreachability
  finding (a faithful reproduction of an upstream limitation, not a new gap).
  A second, independent bug surfaced while proving this against a real silent
  `sleep N`: killing only the direct child (bash, or docker-exec'd-into-bash)
  left an orphaned foreground grandchild (`sleep` itself) holding the stdout
  PIPE open, so Node's `'close'` event — and the resolved `ExecResult` —
  waited for the grandchild's OWN natural exit regardless of the watchdog
  kill. Fixed the same way `src/llmAdapterProcess.ts`'s `killGroup` already
  does: `spawn(..., {detached: true})` (a new POSIX process group) and
  signal `-child.pid` instead of `child.pid`, so the whole group dies
  together. `Sandbox.exec` going async has no ripple beyond the two direct
  callers: `src/shellm.ts`'s single call site (`await`ed) and each test/
  harness call site (`test/sandbox-docker.test.ts`,
  `parity/sandbox/run-parity.mjs`); `mapSpawnResult` (src/sandbox-docker.ts)
  is no longer called from `exec()` but stays exported and directly
  unit-tested (documented dead-in-production, not removed). Oracle-can-fail
  proof: disabling the reset-on-real-output branch turned the "prints every
  400ms, should survive a 2s idle timeout" scenario red (killed at ~2s
  instead of running to completion) on both sandboxes; reverted, confirmed
  green again. Constants: `SHELLM_INACTIVITY_TIMEOUT` (new,
  `ShellmConstants.inactivityTimeoutMs`, default 30s) alongside the existing
  `SHELLM_INACTIVITY_MAX` (`inactivityMaxMs`, default 900s unchanged), both
  through `constantsFromEnv`. Tests: test/sandbox-watchdog.test.ts,
  test/shellm.test.ts's bug #33 describe block, `parity/sandbox/run-parity.mjs`
  (7/7, new `idle-kill` scenario), `parity/upstream-tests/run.mjs`'s newly
  classified `test_inactivity_beacon.sh` (5/5, oracle-only — see that file).

## Behavioral parity round (real-model comparison, upstream 2e39a3f)

A real-model run of upstream's Bash Headlong and this port, same model (DeepSeek flash through one capped logging proxy), identity, memory and prompts, found that the port did not behave like upstream even though every deterministic suite was green (`docs/BEHAVIORAL-PARITY.md`: one sample per engine, a cold start and one human message). The port spent 1.54M tokens (about $0.21, 14% prompt-cache hits) where upstream spent 0.84M (about $0.03, 89% hits). Branch `fix/behavioral-parity`; every fix cites the upstream line it mirrors and every claim below is re-checked against the source, not the report.

| id | difference found | fix | evidence |
| --- | --- | --- | --- |
| **B5** | `thinkers/monolith/step:485` runs `shellm … --context-scope run`: each wake's first request is `[system, user]`. The port only RECORDED the flag in the `shellm-run` header; the loop used `contextScope:"traj"` (`src/shellm.ts` default, env-only at `src/steprun.ts`), so every earlier wake was replayed as chat turns (2 → 44 messages, 5k → 52k prompt tokens, cache hits stuck at 1,280). | `runMonolithWake` passes `constants.contextScope = "run"` | `test/behavioralParity.test.ts` (B5); `parity/behavioral/run-parity.mjs` "second wake's first request is exactly [system, user]" (upstream Bash and port both 2 messages) |
| **B4** | The port sent 6,025 chars of system prompt; upstream sends ~15.7k: the shellm CLI reference (`usage_text`, `bin/shellm:276-355`), `## Guidelines` + tmux tail, the scope-dependent `Output budget` line (`:2231-2246`), Docker `## Execution environment`, `## Current run` and `## Machine environment` (`:2303-2358`). The bundled asset also predated the 2e39a3f sync (it still had a sentence upstream removed). | `src/shellmPrompt.ts` assembles the prompt per run from `src/assets/shellm-system-prompt.txt` (regenerated from upstream's own `shellm --print-system-prompt`, two placeholders) plus the dynamic sections; `runShellm` takes a builder so the run dir and scope are known | `test/behavioralParityB4.test.ts`; differential: system prompt text identical after normalizing only run dir, date, bash version and package-manager list |
| **B1** | Two routing hints missing: "last few steps are all thoughts — the stream may be circling" and "most recent step is an ACTION that has no observation" (`thinkers/monolith/step:192-203`) | ported, in upstream's order, ahead of the pending-request hint | `test/behavioralParity.test.ts` (B1, B1b); differential "task message structure (anchor lines)" on a seed of six thoughts |
| **B2** | `THINK_CONTEXT_TAIL` was hardcoded 20 in monolith and responder (`step:37,189`; responder `step:22,232`); upstream reads the env, and `identity shell` exports 30 by default (`tools/identity:414,1424`) | both thinkers read the env; `resolveIdentityEnv` defaults it to 30 (after `.env` loading) | `test/behavioralParityB2.test.ts`; differential runs with the env set, both print "last 30" |
| **W1** | Upstream's shellm loop and responder never call a provider: they run `llm` (`bin/shellm:1737-1745`, `thinkers/responder/step:57-66`), so the wire request is `llm`'s: `stream:true`, `stream_options.include_usage`, `max_tokens` (per-model default, 16384 for most; the responder passes `-t`), and NO `reasoning` field. The port's `OpenRouterClient` POSTed non-streaming with `reasoning:{effort}` and no `max_tokens`. A code comment called that intentional; there was no deviation row. | `buildLlmClient` returns `LlmCliClient` (`src/llmCliClient.ts`), which runs the port's own `llm` CLI port (`src/llmCli.ts`, proven against `bin/llm`) in process with upstream's argv (monolith: `-m --effort --thinking --system-prompt --messages-file [-t] --stop-after-code-block`; responder: `-t -m -M -s [--json-schema]`, per-call `LLM_MAX_TIME`/`LLM_RETRIES`). `OpenRouterClient` stays for the manual scripts only. | `test/behavioralParityW1.test.ts`; differential "request flags identical" (model, stream, stream_options, max_tokens, no reasoning) on all three calls |
| **B6** | `bin/context:334` renders a non-reasoning step's fields in jq `keys` (sorted) order; the port rendered them in insertion order, so an observation's fields appeared in a different order in the model's context | `renderStep` sorts the keys (`src/context.ts`, `renderKeys(…, true)`) | `test/behavioralParityRound2.test.ts` (failing test first, commit order test→fix) |
| **B7** | `thinkers/_lib/common.sh:281-282` takes `identity prompt` / `skills prompt` through `$(…)`, which strips trailing newlines; the port kept the file's trailing newline, adding blank lines to the system/task prompt | `buildIdentityConfig` strips trailing `\n` from both pieces (`src/steprun.ts`); the same applies to `think_prompt=$(load_prompt …)` (`thinkers/monolith/step:277`, `src/monolith.ts`), which was the last extra blank line before `</context>` | `test/behavioralParityRound2.test.ts` (B7); differential "task message EXACT text identical" (blank lines included), 3/3 wakes |
| **E1** | `thinkers/monolith/step:489-490` ends every run with a literal `sleep 1` before it probes the trajectory and computes `wake_at` (it exists for `tail -F`, but the second is part of the cadence: the step stays busy for it and `wake_at` is stamped after it). Only the monolith step has a literal sleep (`grep -rn sleep thinkers/`: the responder and retrieval steps have none, so there is nothing to match there) | `runMonolithWake` awaits a real 1000 ms timer at the same point (`postRunSleep`, injectable) | `test/behavioralParityE1.test.ts` (fake clock: called once with 1000, after the run's final step, before the idle fallback, and `wake_at` uses the post-sleep clock) |
| **D5** | `bin/shellm:3332` writes the reasoning/final step as `{type,thought,cmd,run_id,llm_s} + $usage`, the WHOLE `write_usage` record (`bin/llm:1017-1037`: in_tok, out_tok, think_tok, cache_tok, estimated, served_by, truncated). The port copied only in_tok/out_tok/think_tok/estimated, so `cache_tok`, `served_by` and `truncated` never reached a step. A reply ending in a fenced block is cut by stop-after-block and records only the ESTIMATED usage on both engines (`bin/llm:1464`), so the full record is visible on a no-code reply | `usageFields` passes all seven fields; `LlmCliClient`/`llm.ts` forward `cache_tok` | `test/behavioralParityD5.test.ts`; differential "FIELD SETS" and "usage VALUES" over 5 model calls incl. a no-code wake (fails 5 ways on the pre-fix code) |
| **R1** | The responder's WIRE request (not only the argv it hands `llm`, covered by `parity/responder`) was never compared with upstream's | harness drives upstream's real `thinkers/responder/step` + `bin/llm` and `bin/thinker-step.mjs responder` against the same stub, structured (`response_format`) and text scenarios | differential: request body EXACT (model, stream, stream_options, max_tokens, response_format, every message), same step types and field sets; 6/6 PARITY. This also closes the report's D4 (extra blank lines in the responder prompt): the bodies are byte-identical after B7 |
| **E2** (IDENTITY_DIR) | `bin/thinkers:387-389` exports IDENTITY_DIR, IDENTITY_NAME, MEM_DIR, SKILLS_DIR, SKILLS_KERNEL_DIR, TRAJ_DIR, TRAJ_ID, THINKERS_DIR, SHELLM_HOME, THINK_MODEL, THINK_CONTEXT_TAIL, THINKERS_MAX_CONCURRENT and NO_SELF_TRIGGER to every step. In local mode the model's code runs as `bash -e -c` inside shellm (`bin/shellm:1629`) and inherits them; in Docker only the `--var` list (`thinkers/_lib/common.sh:735-776`) plus PATH/HOME reach the container (`bin/shellm:1651-1664`). The port's exec env is a whitelist (`src/sandbox.ts:362`, `req.env`) fed from `buildIdentityConfig` (`src/steprun.ts:163-177`) and `runMonolithWake` (`src/monolith.ts:361-370`), which never carried IDENTITY_DIR, SKILLS_KERNEL_DIR, THINKERS_DIR, SHELLM_HOME, THINK_MODEL or THINK_CONTEXT_TAIL: a real run saw `$IDENTITY_DIR` empty 82 times | `applyLocalInheritedEnv` (`src/sandbox-runtime.ts`) adds the dispatcher-exported names that are SET in the step env to the exec env of LOCAL sandboxes only, existing exec-env values winning; Docker is unchanged, as upstream. Unset names stay unset. The responder runs no model-driven shell (its IDENTITY_DIR uses, `step:639,648`, are the log paths in `src/responder.ts`, which already take `env["IDENTITY_DIR"]`); retrieval reads IDENTITY_DIR from the step env directly (`src/retrieval.ts:361`) | `test/steprun.test.ts` "IDENTITY_DIR and the rest ..." (failed before the fix), `test/sandbox-runtime.test.ts`; differential: the wake-1 command prints 12 variables and the harness compares each as upstream's real Bash and the port see it (6 diverged before: IDENTITY_DIR, SKILLS_KERNEL_DIR, THINKERS_DIR, SHELLM_HOME, THINK_MODEL, THINK_CONTEXT_TAIL; 0 after). **Not changed:** upstream's local shell also inherits the rest of the step's environment (API keys etc.); this port keeps its whitelist on purpose |

**Differential harness.** `node parity/behavioral/run-parity.mjs` (`PARITY_UPSTREAM_ROOT=<upstream checkout>`; `test/behavioralRequestParity.test.ts` wraps it and skips without the env) runs upstream's real `thinkers/monolith/step` (with real `bin/shellm`, `bin/llm`) and `bin/thinker-step.mjs monolith` over the same identity layout, seed trajectory and env against one recording stub endpoint: wake 1 (a command round, then FINAL) and a second wake in the same run. Compared per call: system prompt text, message roles/count, request flags, the task message's anchor lines; plus `shellm-run` header fields and the trajectory step-type sequence. Round 2 extends it: a third wake whose reply has no code block, the task message compared EXACTLY (only timestamps/ids, the `Runtime:`/`Workspace:`/`- Now:` lines and an upstream encoding artifact are masked; the identity text is not masked, each documented in the script), trajectory step field sets and usage values per model call, and the responder (structured and text) wire request. Result: **43/48 PARITY, 5 DEVIATION (documented), 0 DIVERGE** (the 5 are the one `focus` token below; 13 of the checks are the wake-shell env probe). Against 35a8c3c (before round 1): 3/12 PARITY, 9 DIVERGE; with the round-2 source fixes reverted: 5 DIVERGE (task message x3, field sets, usage values), so it can fail.

**Deviations kept by this round (each with its reason).**

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| shellm system prompt, Docker section | `## Execution environment` names the run's image and says it has bash, python3, jq, curl and passwordless sudo (`bin/shellm:2303-2308`); `## Docker access` sections for broker/socket/dind (`:2309-2321`) | same text with the port's image (`node:24-bookworm`, DOC #65); no Docker-access sections (the port has no docker-access modes) | the text is upstream's verbatim; whether the port's image has python3/jq/sudo was not checked, so for a Docker-mode wake the prompt may claim tools the container lacks | `test/behavioralParityB4.test.ts` (text only; no Docker differential) |
| shellm system prompt, `## Machine environment` | `$BASH_VERSION` of the running shellm; package managers found on shellm's PATH | `bash -c 'printf %s "$BASH_VERSION"'` of the first `bash` on PATH; managers found on the wake's PATH (which carries the port's bin and node dirs) | the port has no bash process of its own; the value is machine-dependent in both | `parity/behavioral/run-parity.mjs` normalizes these two lines |
| model calls run `llm` in process | `shellm`/`responder` fork the `llm` tool | `LlmCliClient` calls `runLlm` in the same Node process with the same argv; `buildLlmClient`'s credential gate is "any `*_API_KEY`, `LLM_API_URL` or `SHELLM_API_URL` set" (was "OPENROUTER_API_KEY or LLM_API_KEY") because provider and key choice are now `llm`'s own | no subprocess boundary in this port; provider/key selection must be `llm`'s, not a second implementation | `test/behavioralParityW1.test.ts`, `test/steprun.test.ts` |
| `THINK_CONTEXT_TAIL` identity default | `identity shell` exports `${THINK_CONTEXT_TAIL:-30}` then sources the identity `.env` with `set -a` (the `.env` wins) | defaulted to 30 after the `.env` layers load, which fill only missing variables, so an identity `.env` value is kept, a shell value is kept | the port's `.env` layering is fill-missing throughout (PARITY "identity env"); the only observable difference is a `.env` value overriding a pre-set shell value | `test/behavioralParityB2.test.ts` |
| default identity text lists `focus` | `tools/identity:1510` (`_ensure_kernel`'s default `core_identity_prompt`) says "I am driven by standalone commands (think, chat, focus, mem, skills, traj)". The command does not exist at the pin: `bin/focus` was deleted by 12ca841 (`bin/` at 2e39a3f has chat context llm mem recap shellm shellm-docker skills thinkers traj), and 12ca841 only edited the parallel list in `deploy/slack-persona.md`, so the identity text is stale upstream | `src/steprun.ts` `DEFAULT_IDENTITY_TEXT` reads "(think, chat, mem, skills, traj)"; the port has no `focus` command either (`src/focus.ts`/`bin/focus.mjs` retired in 1c) | there is nothing to match: upstream's `focus` neither exists nor works at the pin, so restoring the bytes would tell every new mind (and every responder/monolith prompt) about a command that fails with "command not found". Matching the oracle's TEXT is only worth it when the oracle's behavior backs it. It is one token in one string; everything else in the prompt is compared byte for byte | `parity/behavioral/run-parity.mjs`: identity text is NOT masked; the 5 exact-text checks (3 monolith task messages, 2 responder bodies) are reported `DEVIATION` iff dropping that one token makes them identical, `DIVERGE` otherwise; a further check asserts neither side has a `focus` command. If upstream restores `focus` (or edits `tools/identity`), the check fails and this row must go |

**Not verified here (still open).** No real model was run after the fixes (the prompt/cost effect is expected from the request shapes, not measured). Masked in the exact task-message comparison, not equal: the `Runtime:` line (each side names its own checkout), the `- Now:` clock line, and `Workspace:` (D2: `.shellm/workdirs/<traj>-root` vs `<identity>/workdir`, still unclassified). Documented deviation the comparison reports as `DEVIATION` (not masked): the retired `focus` command is dropped from the default identity text (see the "default identity text lists `focus`" row above). Tolerated artifact: upstream's second wake byte-mangles one em dash in the menu text into U+FFFD (an oracle encoding artifact, not copied; seen only in the wake after a command wake). Not compared: Docker prompt text; T1 (run dir `/tmp/headlong-run-` vs `/tmp/shellm-run.`) and S1 (stall error text) from the report.

**Menu choice is inferred, not recorded.** Upstream never records which menu function (act, share, goals, …) a monolith wake chose; the report's `classify()` infers it from the wake's commands. The port does the same and its trajectory carries no "menu function chosen" step: adding one would deviate from upstream.

### Known upstream issue, kept faithful on purpose: editing a person memory drops `person_key`

`mem edit` rebuilds the frontmatter from only `type`, `created`, `id`, `until` (and `schedule`/`tz`, plus the new `updated:` entry), so editing a person memory silently drops its `person_key` (and any other custom field), in BOTH engines: upstream `bin/mem:621-624`, port `src/mem.ts:872`, `:904`, `:911`, `:933`. The responder looks people up by that key (`thinkers/responder/step:374-392`), so after an edit the person is no longer found by the lookup until the key is restored. This is upstream's behavior at the pin and the port reproduces it byte for byte; **we deliberately stay faithful and do not fix it here**. If upstream fixes it, port the fix with a differential scenario (edit, then responder lookup).

## Upstream sync 2e39a3f (5458fee → 2e39a3f)

Branch `sync/upstream-2e39a3f` (never merged to `main` by this work; local only). Upstream checkout used as the oracle: `laude-institute/headlong` at `2e39a3f39fb9acbd0d73f6b0aecc9f83dc14547e`, read-only. Method is the repo's usual one: read the upstream diff per area, port with a `PORT-NOTE:` on each semantic decision, extend the differential harness (real Bash/Python vs the port) and run upstream's own Bash suites against the port. No golden trace or characterization expectation was loosened; the only oracle edits are the three stale unit expectations listed under "Oracle changes" below. No live-model run was made (`live-proof`, real-wake untouched).

### Lanes

| lane | what changed upstream → what the port does | evidence |
| --- | --- | --- |
| **a** shellm / llm / context / extract | `extract_code` lifts tool-call markup and repairs suffixes, CRLF/provenance cut; shellm widened redaction, output-size and wall-clock watchdog kills, per-run `TMPDIR`; `llm --json-schema`, `served_by`/`truncated` usage fields, `content_filter` refusal, GLM/MiMo tier; `context` renders reasoning rows from a fixed field list. `llm` shared-process-group deadline (2a63d92). | `parity/extract` 82/82; `parity/llm` 281/281 effective (258 identical + 23 documented), adversarial 278 scenarios, 0 DIVERGE; `parity/context` 126/126 byte-exact (+11/11 deviation probes). Upstream suites registered (portable / no-port-cli / bash-artifact, each with a reason in `parity/upstream-tests/run.mjs`). |
| **b** mem | write-point credential redaction, flag refusal, blank-summary, schedule/tz, search supervisor/worker group, outer deadline, TERM/INT cancel, private marker dir (2a63d92, 30f8bbe). | `parity/mem` 194/205 (+119 scenarios; the 11 mismatches are stderr-wording classes, all documented in the report). |
| **c** traj | credential redaction at the write point, fail-fast append lock, search two-pass / `--tail` / prefilter, cycle-guarded readers, formatted filter, POSIX brackets. | `parity/traj` 256/256 (+170 scenarios, 5 documented deviations). |
| **d** identity / killall / tui | `identity new` seeds orientation + a light disposition (not a family); killall excludes broker containers inside one `docker ps` snapshot; TUI follower process-group teardown; mem skill doc. | `parity/identity` list 17/17 (needs `LC_ALL=en_US.UTF-8`, see Gaps below), export 7/7, import 6/6; `parity/killall` 7/7; `parity/init` 7/7. |
| **e** chat / message index | owner-file lock with takeover, offset record (inode + sizes), trim/rebuild, deliveries index, `key` field, `sent`/repeat queries, Slack target check, action-object refusal, `--force`/`--key`, `chat sent`, `index-reset --offline`; chat skill text. | `parity/chat` 218/231 (+126 scenarios; all divergences are in the report's documented list: `${2:?}` stderr wording and DEL/NUL stdin). Upstream chat suites: 4 portable pass, 2 are `stat`-shim bash-artifacts. |
| **f** thinkers / dispatcher / monolith | scheduled-wake claim/sent receipts + stale-claim sweep, die-after-claim fault injection, 16-byte hex ownership token, explicit stop cancels `wake_at`/claimed/sent, rewind guard, feeder swap detection (restart at EOF), stuck/quiet-step guards with TERM/KILL, `THINKERS_WAKE_NOTE_MIN_GAP`, legacy fifo cleanup; **salience feedback injection removed**; wake-prompt credential redaction; monolith request-model tier, `stderr_tail`/`diagnostic_step`, idle suppression, "Sent in the last 24h" + scheduled-goal signals, runtime boundary line. | `parity/prompt` 35/35; `parity/daemon` adversarial 88 checks, 84 parity, 4 documented deviations, 0 DIVERGE; upstream daemon suites (trajectory_swap 10/10, stuck_step 15/15, wake_at 19/19, …) in `--daemon`; unit tests `test/dispatcherReceipts`, `test/dispatch-mechanics`, `test/monolith*`. |
| **g** Slack / Telegram bridges | peer hearing gate + loop guard, peer persona header, bare channel/user address forms, delivery notices (message_ts, permalink, failed/skipped), bare user DM via `conversations.open`, 409 refusal is final, mindlog shrink resumes at EOF, cursor carries the trajectory path; slack skill. | `parity/slack` 42/42, `parity/telegram` 36/36 against the real Python bridges (fake HTTP APIs; live legs still not exercised). |
| **h** responder | stale-trigger guard, bounded reply call (max tokens/time/retries), structured replies (schema, salvage, text fallback), DEFER/skills-tag handling, card/credential redaction. | `parity/responder` 83/83; upstream suites `test_responder_card_redaction` / `test_responder_reply_guard` registered (no-port-cli: the port's responder is in-process); `test/progress-logs.test.ts` structured-path case. |
| **i** recap / rollups | `ROLLUP_PROMPT_VERSION` 5, citation sentence, `-t 4096`, `ROLLUP_MAX_SEALS` (default 20, 0 = no cap, `--backfill` uncapped), refusal placeholder block (`refused:true`, no retry), early stop on bad JSON, bounded citation lookup (≤128 probes, 32 KiB per candidate, optional-bytes bound, hint line). | `parity/recap` 37/39 (2 pre-existing `${2:?}` wording mismatches); adversarial 173 scenarios: 151 parity, 22 documented deviations, 0 DIVERGE (+25 new: refusal, seal-cap, namers); upstream rollup suites 18/18, 10/10, 26/26 and `namer_limits` 34/40 (control 40/40 — the 6 are Bash-only instrumentation, ported as `test/recap-namer-limits.test.ts` 6 tests); `test/recap-sync.test.ts` 16 tests. |
| **j** web control plane | linked-identities root is walked (2d0919e), push cursor resets after a trajectory shrink (089da9b), thinker-sync unique temp files (f1a6e96). | `web/server/test/sync-2e39a3f.test.ts` 6 tests; web/server suite green. |
| **k** sandbox execution (found by `parity/sandbox`'s reference-token check) | `docker exec` now carries the model's code on stdin to an in-container `_supervise_exec`; a watchdog kill cancels the whole tree inside the container as root; code over 64 KiB runs from a mode-600 script file (Linux 128 KiB per-argv-string cap) (c0fc931, b9bc2a3, db1e8e1). | `parity/sandbox` shape 9/9, differential 7/7, loopback-rewrite PASS; real-docker tests (300 KB block runs; an idle kill removes the in-container descendant and the control dir). |

### Deviations (deliberate; each has a `PORT-NOTE:` in code)

- **Rollup non-object model reply** — upstream's `_ctx_build … || note` suppresses `set -e`, so a non-object reply leaves a zero-byte block file and exits 0; the port aborts cleanly with the same message. Harness class `recap-rollup-jqreply-nonobject`.
- **Responder sends in-process** — the reply message step is appended directly rather than through `chat reply`; the notes writer reuses the reply client; the reply model is `MONOLITH_REPLY_MODEL → THINK_MODEL → SHELLM_MODEL`; `startMs` covers the whole wake; the step asset dir ships `reply.schema.json`; new `LlmCallError`/`CompleteOptions` API. No multi-document JSON replies. POSIX-ERE leftmost-longest vs JS leftmost-first and BSD-sed PEM-range behaviour differ at the margin (documented in `src/responder.ts`).
- **Docker cancel** — after the in-container cancel the port also signals the docker client (upstream waits for it to exit on its own) so a wedged client cannot hold a step open.
- **`namer_limits` and other Bash-instrument suites** — suites that wrap `date`/`open` in the Bash source cannot observe the port; they are replaced by equivalent unit tests (listed above), not skipped silently.

### Oracle changes (stale expectations, not loosened)

`test/llmRetry.test.ts` (request count 3 → 2: the responder reply call is bounded), `test/monolith.test.ts` (rollup `-t 4096`), `test/progress-logs.test.ts` (`RESPONDER_STRUCTURED=0` for the legacy path + a new structured-path case), `test/steprun.test.ts` fake docker accepts `-i`/`--user`. `parity/daemon` adversarial token normalization now matches the 16-byte hex token.

### Not carried (decision, with reason)

- `macos/`, `deploy/` (systemd, Terraform, bootstrap, `thinkers-sandbox`, silence-alert, tmp-reaper, `split-bridge-env`, `audel-metrics`), `contrib/` (`opencode`, `skill-compiler`), CI config and docs: out of scope for the reference port (PORTING.md). Their upstream suites are registered `no-port-cli` with that reason: `test_deploy_update`, `test_split_bridge_env`, `test_thinkers_sandbox`, `test_thinkers_silence_alert`, `test_thinkers_tmp_reaper`, `test_metrics_busy_overlap`, `test_contrib_opencode`, `test_skill_compiler`, `test_skill_compiler_install`.
- `tools/shellm-explore` changes (the report prompt off argv): the tool is not ported (the suite passes against upstream's own script).
- `test_run_all_identity_env` / `test_run_all_shards`: test upstream's `tests/run-all.sh` runner; the port's runner is `parity/upstream-tests/run.mjs`.
- `test_dispatcher_cleanup`: sed-extracts functions from `bin/thinkers`' Bash text (bash-artifact); covered by `test/dispatch-mechanics.test.ts`, `test/dispatcherReceipts.test.ts`, `test/daemon.test.ts`.
- `test_monolith_wake_sections` 34/35: the one failure ("runtime line") is a runner artifact — the scratch copy has no `.git` (the same limit documented for `test_status.sh`'s clone).

### Environment notes (not port behaviour)

- `parity/identity/run-parity.mjs` (list ordering) must run under a UTF-8 collation locale (`LC_ALL=en_US.UTF-8`); the Bash `sort` otherwise orders in C locale and the case-insensitive-ordering scenario reads as a mismatch. 17/17 under `en_US.UTF-8`.
- macOS `bsdtar` emits AppleDouble `._*` entries; run the identity export/import harnesses with `COPYFILE_DISABLE=1`.
- Harness runs under load can flake (a scheduled-wake and a 10 s step-survival test each failed once while other suites ran, and passed alone); run harnesses and vitest sequentially.
- `colima start` was used for the Docker-backed tests; it switched the Docker CLI context to `colima` on this machine.
- `mem`/`skills` reports are scrubbed of the local checkout path to `<HEADLONG_ROOT>` before committing (scrub test).

### Final numbers

- Type check: `tsc --noEmit` clean for the root project and `web/server`.
- `DOCKER_CONTEXT=colima npx vitest run` (root + `web/server`, includes the scrub test): **2326 passed / 4 skipped, 123 files passed (1 skipped)**. Baseline on `main` (`4483916`, same machine, same command): 1951 passed / 4 skipped, 102 files passed (1 skipped).
- Differential harnesses (each against the real upstream Bash/Python at `2e39a3f`): chat 218/231, mem 194/205, traj 256/256, context 126/126, extract 82/82, llm 281/281 effective (adversarial 278 scenarios, 0 DIVERGE), recap 37/39 and adversarial 173 scenarios (0 DIVERGE), prompt 35/35, responder 83/83, retrieval 31/31, slack 42/42, telegram 36/36, identity list 17/17 / export 7/7 / import 6/6, killall 7/7, init 7/7, skill-env 9/9, skills 87/95 byte-identical (95/95 effective), sandbox shape 9/9 + differential 7/7, daemon adversarial 88 checks (84 parity, 4 documented, 0 DIVERGE).
- Upstream's own Bash suites against the port, default lane (`node parity/upstream-tests/run.mjs`, 80 suites, run 2026-10-27): **portable** 43 suites, 34 exit 0, 835 assertions passed / 110 port-only failures (control 945/945); **bash-artifact** 10 suites, 6 exit 0, 151 passed / 111 failed (112 port-only lines; control 320/320); **no-port-cli** 27 suites, 19 exit 0, 304 passed / 84 failed (control 702/702). Every port-only failure is explained in the report's root-cause column:
  - portable, curl-stub methodology mismatch (the port's `llm` uses `fetch()`, never a `curl` binary): `test_llm_openai_compatible` 9/21, `test_llm_provider_env` 4/10, `test_llm_retry` 21/75, `test_llm_openrouter_routing` 6/20, `test_key_var_resolution` 12/14, `test_llm_json_schema` 2/8 (reads the payload its stub curl was handed). All six were red the same way on `main` before this sync except `test_llm_json_schema` (new; same cause).
  - portable, stub-`jq`/`sed` methodology mismatch: `test_traj_redaction` 64/73 (the last block puts failing `jq`/`sed` stubs on PATH to prove the Bash append writes nothing; the port has no such subprocess; the write-point redaction itself is the 64 passing checks + `parity/traj`).
  - portable, Bash-only instrumentation: `test_rollup_namer_limits` 34/40 — the 6 failures count `open`s/lookups inside the Bash source; ported as `test/recap-namer-limits.test.ts` (6 tests).
  - portable, runner artifact: `test_monolith_wake_sections` 34/35 — the one failure ("runtime line present") is the scratch copy having no `.git`; proven by running pure upstream Bash from a copy without `.git` (same 34/35) and with `git init` (35/35). Not a port gap: that code is upstream's unported `thinkers/monolith/step`; the port's own runtime line is tested in `test/monolith.test.ts`.
  - bash-artifact (suite sources/`sed`-extracts functions from Bash text that a Node trampoline does not contain): `test_mem_frontmatter` 1/6, `test_mem_redaction` 7/113 (the same ~170 cases are covered byte-for-byte by `parity/mem` and `test/memRedact.test.ts`), `test_chat_index_concurrent` (needs a `stat` shim the port never forks; property covered by `parity/chat` index-lock scenarios), plus `test_chat_index_lock` (same gate).
  - no-port-cli, `deploy/` files absent from the scratch tree (not carried): `test_split_bridge_env` 2/19, `test_thinkers_sandbox` 2/23, `test_thinkers_silence_alert` 5/34, `test_thinkers_tmp_reaper` 6/23; upstream's own scripts pass 19/19, 23/23, 34/34, 23/23 as control. Also non-zero with no assertion count (files absent from the scratch tree): `test_deploy_update`, `test_metrics_busy_overlap`, and `test_contrib_opencode` / `test_skill_compiler` (exit 127, `contrib/` not carried).
  - Not a regression: the no-port-cli and bash-artifact classes have no port equivalent of the CLI/Bash text the suite exercises, so a port-side failure only means the artifact is absent; each such suite names the port test or harness that covers the behaviour.
  - Evidence status (2026-10-27): the counts above are recomputed from the regenerated `parity/upstream-tests/results.json` (portable 43 / 34 clean / 835 pass / 110 port-only; bash-artifact 10 / 6 / 151 pass / 111 fail, 112 port-only lines; no-port-cli 27 / 19 / 304 / 84). `test_monolith_wake_sections` is proven by a control experiment (upstream Bash alone, with and without `.git`).
  - Independent audit of the portable/bash-artifact failures (2026-10-27): no real behavioral gap in any failing suite. (1) The six curl-stub suites: with a throwaway fetch-to-curl bridge (audit-only, not an unmodified-suite pass, not committed), the port passes upstream's own unmodified curl stubs: `test_llm_retry` 75/75, `test_llm_openai_compatible` 21/21, `test_llm_provider_env` 10/10, `test_llm_openrouter_routing` 20/20, `test_key_var_resolution` 14/14, `test_llm_json_schema` 8/8. (2) `test_rollup_namer_limits` (6): the failures depend on a `head` shim, `bash -x` xtrace counts and `bash -x bin/recap` on a Node script; `test/recap-namer-limits.test.ts` (6) pins the same bounds. (3) `test_mem_frontmatter`: it `eval`s `frontmatter_field()` out of `bin/mem`'s text; its 6 assertions pass against the port's `frontmatterField()`. (4) `test_chat_index_concurrent` / `test_chat_index_lock`: they put a `stat` shim on PATH, and the port reads sizes in-process; the port-side tests pass (`chatGuards` 25, `chat-history-index-concurrent` 1). (5) `test_traj_redaction` (9) and `test_mem_redaction` (run through the CLI instead of the sed-extracted function: port 169/2 vs Bash 171/0): the only failures need a sabotaged `jq`/`sed` on PATH. Real Bash fails closed (nothing appended); the port has no sanitizer subprocess, so it appends the redacted record. The key never leaked (`files_containing_key=0`). This is a documented deviation (see the row below), not a gap.
  - Deviation: sanitizer-subprocess failure. Bash `traj append`/`mem` redact through `jq`/`sed` subprocesses and write nothing if one fails. The port redacts in-process (`src/trajRedact.mjs`), so that failure mode does not exist; redaction still runs before any blob spill or append. Proof: `test_traj_redaction` 64/64 and `test_mem_redaction` 169 of the non-sabotage assertions pass, key files count 0.
- Daemon and installer lanes (`--daemon`, `--installer`): TBD_UPSTREAM

### Wake ledger: lost wakes on dispatcher restart (deliberate deviation, branch `sync/upstream-2e39a3f-lostwake`)

Not an upstream commit: found by re-running a lost-wake experiment against both upstream Bash and the port. Full write-up, per-run tables and the limits are in `docs/LOSTWAKE.md`; the deviation row is in the Deviations table above ("dispatcher restart: lost wakes").

- Before: upstream Bash 168/600 (28.0%) messages never woke the responder; the port 128/600 (21.3%). After the fix: the port 0/600, and 0/150 in three `kill -9` stress runs. No restarts: 0/50 lost before and after. Duplicate replies: 0 in every run.
- Not covered: a real model (the runs used a local HTTP server serving scripted replies; no paid model call), no Linux run (no `flock` on the test Mac), one trajectory per identity exercised, and a thinker killed between its `reply_claim` and its `observation` can still lose a reply until the claim goes stale (0/150 hit it). A step that fails every time is retried once per dispatcher start, with no attempt counter.
- Off-switch: `THINKERS_WAKE_LEDGER=0` gives upstream's behaviour.

### Start-up window: a step appended right after boot is not delivered (upstream behaviour, kept)

Both sides publish `run/sub_map` and `run/traj_files` before the trajectory feeders are listening, and a feeder with
no cursor starts at end of file. A step appended in that window is never fed to a thinker. Upstream: `bin/thinkers`
writes `sub_map` at :433, `thinkers start` returns when fd 5 closes at :457, and the `tail -n 0 -F` feeders are spawned
in the background at :490/:566. Measured against upstream 2e39a3f (`PARITY_UPSTREAM_ROOT=… parity/daemon/startup-window-probe.sh submap 10`): a
step appended as soon as `sub_map` appears was lost **10 of 10** times, and a second step appended 2 s later was
delivered every time. Upstream's own tests `sleep 2` after `thinkers start`. The port: `bootDaemon` writes `sub_map`
(src/daemon.ts:277), then starts the `TrajFeeder`s (:412-440). With a 1.5 s pause added between them, the old
`daemon.test.ts` append test failed every time. Not changed, because the wake ledger only covers restarts with a cursor.
A first start with no cursor keeps upstream's start-at-end-of-file rule.

The tests now wait for the right condition: `test/support/daemonReady.ts` `feedersLive()` waits for the
dispatcher's first housekeeping tick. That tick's interval is armed only after every feeder has started, and it
rewrites `step_pids` atomically, so a second `step_pids` inode means the feeders are live. Used by `daemon.test.ts`
(the out-of-process append test that failed under load), `daemon-step-survival.test.ts`, and `wake-ledger.test.ts`
("before"). With a 1.5 s pause put before the feeder start, all three files still pass.

### Responder: the reply call's own `llm` stderr now reaches the step's stderr (port fix)

Upstream's `_reply_llm` runs `llm … 2>"$err"` and then `cat "$err" >&2`, so `llm`'s warnings and errors land in the
responder's log (for example, `llm: error: API error: This response_format type is unavailable now`, or a timeout).
The port's `LlmCliClient` collected that stderr and dropped it. The old responder harness never caught this because
its scripted client wrote those lines itself. Running the real clients through `parity/responder` showed it in 10
step scenarios. Fix: `LlmResponse.diagnostics` / `LlmCallError.diagnostics` (plain mode only), written by
`runResponder`'s `callLlm` straight after each call. Test: `test/responder-sync.test.ts` "retries 0".

The timeout line itself still differs (`curl: (28) Operation timed out after N milliseconds` against `request failed:
timed out after Ns (LLM_MAX_TIME)`), which is the documented "llm network guards" deviation. The responder harness
normalises only that line.

### shellm: the recorded `thought` and fenceless `cmd` now trim newlines like upstream's command substitutions (port fix)

Upstream stores `reasoning=$(extract_reasoning "$response")` (`bin/shellm:3027`) and, for a reply with no fence,
`code=$(printf '%s\n' "$response" | awk …)` (`bin/shellm:2081-2085`). A bash command substitution drops every
TRAILING newline and nothing else: leading newlines, trailing spaces and tabs stay. The port joined the prose lines
as they were, so a reply with a blank line before its fence (DeepSeek's usual shape) recorded `thought: "…\n"`, or
`"\n"` where upstream wrote `""`. In the other direction, the fenceless branch stripped leading AND trailing newlines,
so a DSML tool-call reply that opens with `\n\n` lost them in the recorded `cmd` (and in the script that runs).
Both now match: `src/extract.ts` `extractReasoning` ends with `.replace(/\n+$/, "")`, and the fenceless branch drops
only trailing newlines. Found by the recorded behavioral parity run (thought), then by its new value check (cmd, call 6). Pinned by `test/extract.test.ts` (literal-string parser tests, no model; they fail without the fix) and by
`parity/extract/run-parity.mjs`, which now compares upstream's function through the same command substitution its
caller uses, byte for byte (no newline stripping), with 5 new cases. `parity/behavioral` now also compares each
model call's recorded `thought` and `cmd` values.

### bin/*: stdout and stderr are no longer cut at exit under Bun (port fix)

The `bin/*` shims run on Bun when Bun is installed (the maintainer's Mac does). Under Bun, `process.exit()` dropped stdout
bytes Bun had queued but not yet written to the pipe; the `write("", cb)` drain probe, `writableLength` and "drain"
did not see them. A 200 KB answer to a slow reader kept 65,295 bytes, and under CPU load a 1.8 KB `llm` reply was cut
mid-text with exit 0, so recap reported "model returned invalid JSON" and retried where upstream did not (recap
adversarial parity: 5 to 9 `traj/` scenarios diverged per loaded run; 0 with `HEADLONG_TS_RUNTIME=node`, 0 with the
fix). Upstream's tools are Bash and write with `printf`, which blocks until the bytes are in the pipe. `src/stdioSync.ts`,
imported first by every `bin/*.mjs` (and by `src/exitAfterDrain.ts`), makes `process.stdout`/`process.stderr` writes
synchronous `fs.writeSync` calls under Bun (EAGAIN waits for the reader; EPIPE still arrives as the stream's "error"),
so every tool can exit at any point without losing a byte. Node is unchanged. Test: `test/bun-stdio-flush.test.ts`
runs llm, shellm, mem, recap, traj and chat on Bun against a reader that pauses for a second and compares every byte
with the same run on Node; with the fix disabled llm, mem, recap and traj fail (shellm's and chat's cases pass either
way on this box).

### recap: a reply of several JSON values now ends the way upstream's does (port fix)

Upstream's `_llm_json` validates with `jq -e .`, which accepts a STREAM of JSON values when the last one is truthy
(`{"a":1}\n{"b":2}`), and returns the whole text. The next `jq --argjson body "$body"` rejects it: jq's usage
banner (`jq: invalid JSON text passed to --argjson` …), exit 2, after the shell has already opened that jq's output
redirect, so an empty target file is left behind (`recap/episodes.jsonl` for a map reply, `themes.json.tmp` for the
reduce reply, the block file itself for a rollup seal, which upstream then treats as sealed). The port rejected the
reply in the parser, retried, and died with exit 1 and nothing on disk. Checked by running upstream's full
`bin/recap` and the port on that reply (one-off probe, not a test): upstream exit 2 with an empty
`recap/episodes.jsonl`; the port now matches it byte for byte (stdout, stderr, exit, files). `src/recap.ts`:
`parseLlmJson` returns a `JsonSeq` for such a stream (`splitJsonSeq`), and `argjsonSeqAbort` reproduces the end state
at all three call sites. Pinned by `test/recap.test.ts` (literal-string parser tests, no model; they fail without the
fix) and `parity/recap/run-parser-parity.mjs` (`parser/two-values`, upstream `_llm_json` cut by markers and hash).

## Upstream sync 1c, lane A (7d29f9e → 5458fee, shellm/llm/context core)

Upstream `laude-institute/headlong` moved from `7d29f9e` to `5458fee` (85
commits — see `UPSTREAM-TRIAGE-2.md`). This lane carries the `src/shellm.ts`,
`src/llmCli.ts`, `src/llm.ts`, `src/llmProvider.ts`, `src/context.ts` slice;
other lanes (monolith/prompts, chat/traj, mem, identity/skills, bridges, web)
land separately. Files touched: `src/context.ts`, `src/shellm.ts`,
`src/extract.ts`, `src/llmProvider.ts`, `src/llmCli.ts`, their tests, and
`parity/llm/run-parity.mjs` + `parity/context/run-parity.mjs`.

- **3228c8c / 1fdeb97 — bookkeeping fields hidden from the model.** `context.ts`'s
  `isMeta` now also hides `run_id`, `llm_s`, `in_tok`, `out_tok`, `think_tok`,
  `cache_tok`, `estimated` (upstream's Audel incident: a rendered `[in_tok]\n…`
  taught the model to echo its own token counts back, then invent another
  thought and block, looping until the transfer timed out). Shared by both
  `buildContext` (the engine-facing projection `runShellm` calls every
  iteration) and the standalone `context` CLI's `render_step`.
- **1fdeb97 — `cache_tok` in usage records and the ledger, all four providers,
  streamed and non-streamed.** `UsageRecord` gained `cache_tok?: number` and
  `estimated?: true`; `usageOpenAI`/`usageAnthropic`/`usageGemini` (both
  read at the non-streaming JSON and reused by their streaming handlers where
  applicable) now read the provider's cache field (`prompt_tokens_details.
  cached_tokens` OpenAI/OpenRouter, `cache_read_input_tokens` Anthropic,
  `cachedContentTokenCount` Gemini) as a fourth value alongside in/out/think.
  **Real bug found while porting**: upstream's shared non-streaming reader
  (`IFS=$'\t' read -r _u_in _u_out _u_think _u_cache <<<"$_u"`) and the
  OpenAI/Gemini streaming readers inherit the SAME pre-existing bash bug this
  port's `usageOpenAI` already documents (`IFS=$'\t'` is a single WHITESPACE
  character, so `read` collapses an empty middle cell) — whenever think_tok is
  empty (structurally ALWAYS true for anthropic|opencode's non-streaming path)
  and cache_tok is present, bash shifts the cache value into think_tok and
  drops cache_tok entirely. The port keeps every field in its own jq-shaped
  slot (never a positional `read`), so it never has this bug. Documented as
  parity deviation `usage-field-shift` (extended from the pre-existing
  3-field version) in `parity/llm/run-parity.mjs`'s own catalogue (mirroring
  the adversarial harness's identical entry) — `fields: ["state"]`, 3
  scenarios (`nostream/cache-tok-usage-ledger`, `anthropic/cache-tok-nonstream`,
  `gemini/cache-tok-nonstream`).
- **2d1c1c3 — `LLM_STOP_AFTER_CODE_BLOCK` / `--stop-after-code-block`,
  heredoc-aware fence tracker.** New `createFenceStopTracker` (`src/extract.ts`,
  next to `extractCode` — same fence rules: an opening ` ``` ` line-start or a
  tagged ` ```bash/shell/sh` at end-of-line opens; a bare ` ``` ` closes only
  outside an open heredoc) fed incrementally, one text delta at a time, by a
  shared `makeStopGate` wrapper in `llmCli.ts` used by all three streaming
  providers' TEXT sink only (never Anthropic's separate `thinking` sink — the
  Bash's own `stream_anthropic` never routes thinking deltas through
  `_emit_text` either). **Characterized against real upstream-next `bin/llm`**
  (a temp fake-server harness, `bash -x`): the WHOLE delta chunk containing
  the closing fence line is *always* printed first (`_emit_text`'s
  `printf` runs before the fence check), so a chunk boundary landing mid-close
  means everything up to and including that chunk still reaches stdout — the
  cut is line-buffered, not byte-instant. On stop: `writeUsage` is called with
  ONLY `{out_tok: Math.floor((bytes+3)/4), estimated: true}` — REPLACING
  (never merging with) any usage already on record, matching bash's
  whole-file `write_usage` overwrite — then `note(ctx,"ok")` +
  `ledgerAppend`, same as a clean success. `Ctx.stopAfterCodeBlock` reads the
  EXACT string `"1"` (bash `[[ "$X" == 1 ]]`, not a truthy check) or the
  `--stop-after-code-block` flag. `--help`'s Options list is deliberately
  NOT updated (upstream's own `usage()` never documents this flag there
  either — only under `Environment:`).
  **BUG #69 (fixed):** `src/shellm.ts`'s `runShellm` never shells out to this
  CLI — it calls the injected `LlmClient.complete()` in-process
  (`OpenRouterClient`, or in tests the since-removed `ReplayClient`: a single non-streaming fetch/replay,
  never a stream), so the tracker above, wired only into `llmCli.ts`, never
  ran on the daemon-driven wake loop at all: `stopAfterCodeBlock` was read
  into `ShellmConstants` (default `true`) but nothing consulted it. A turn's
  FULL completion was kept, so a model that wrote a real command block, then
  prose, then a second block setting FINAL — the pattern it falls into once
  it can see its own uncut prior turns in context — never got cut the way
  upstream's `llm --stop-after-code-block` would cut it. Director-verified
  live: finals per run 3/13 upstream vs 22/22 port, reasoning steps per run
  7.00 vs 1.86, error steps 9 vs 0. Fixed with a new
  `applyStopAfterCodeBlock` (`src/extract.ts`) — the non-streaming analogue
  of `createFenceStopTracker`: feeds the WHOLE completion through the same
  tracker one LINE at a time (chunk size never changes WHICH line closes the
  block, only how much trailing text would leak through in a real stream's
  closing delta — real deltas are token-sized, far smaller than one line, so
  cutting immediately after the closing line's own newline is the faithful
  non-streaming approximation) and returns the kept prefix plus whether it
  was cut. `runShellm` applies it, gated on `c.stopAfterCodeBlock`, to the
  completion BEFORE `extractReasoning`/`extractCode` ever see it, so: (1) a
  later block genuinely never reaches this turn's trajectory (no
  `extractCode`-native "[rest of model response truncated...]" notice
  either — the second fence never arrives in the text at all), forcing a
  separate turn to set FINAL, same as upstream; (2) on a cut, usage is
  overwritten with `{out_tok: Math.floor((bytes+3)/4), estimated: true}`,
  dropping in_tok/think_tok, matching `write_usage`'s whole-file-overwrite
  semantics used by `llmCli.ts`'s own `finishStopped`. `LlmUsage` gained an
  `estimated?: boolean` field; `usageFields` (`src/shellm.ts`) now carries it
  into the `reasoning`/`final`(no-block) trajectory steps. New
  `test/extract.test.ts` describe block (5 tests: cut-with-trailing-blocks,
  single-block-nothing-after, heredoc-not-cut-early, no-fence-unaffected,
  unterminated-block-unaffected); new `test/shellm.test.ts` describe block
  (5 tests: flag-on cut end-to-end incl. exact `estimated`/`out_tok`, flag-off
  old behavior, heredoc integration through `LocalSandbox`, no-fence path
  unaffected, and an 8-completion integration test hitting the same "Max
  iterations (8) reached without final answer" cap upstream hits with a mind
  stuck writing FINAL a turn too early).
  16 new/extended unit tests (`test/llmCli.test.ts`'s
  `LLM_STOP_AFTER_CODE_BLOCK` describe block + the two `cache_tok` tests per
  provider); 10 new `parity/llm/run-parity.mjs` scenarios, 0 PORT BUGS
  (259/259 effective against upstream-next; re-run against the old 7d29f9e
  pin correctly reports the new scenarios as expected misses — the old tool
  doesn't have these flags/fields at all, not a regression: all pre-existing
  scenarios still match the old pin byte-for-byte).
- **7a35982 — context never cuts a prompt; `--context-scope run` for the
  monolith's own shellm run.** `ContextOptions` gained `fullTypes` (types
  exempt from the field limit entirely — shellm always passes `["prompt"]`:
  a cut prompt used to leave the model a stub pointing at its own
  instructions on disk) and `run` (keep only one run's own steps, pins
  always stay; other runs' rows are dropped WITHOUT counting as an elision
  gap — `[N steps elided]` in traj scope vs. a bare `[earlier steps elided]`
  with no count inside a run, and NO marker at all before the first kept row
  in run scope). **Real pre-existing port bug found and fixed while adding
  the `$skip`-based gap arithmetic run-scope needs**: `buildContext`'s gap
  count used the raw index difference with NO subtraction for excluded-role
  steps in between (unlike the standalone `context` CLI's `gap_between`,
  which always subtracted `$skip`) — an excluded `shellm-run`/`run-summary`
  row sitting between two kept rows was double-counted as "elided" text the
  model actually saw. Fixed to match the CLI's own `skip`-based arithmetic
  exactly (now shared logic, both engine and CLI paths route through the
  same `gapBetween`/`windowStart` shape). `test/context.test.ts`'s original
  "assigns roles, excludes shellm-run…" test encoded the bug; updated with a
  PORT-NOTE explaining the correction (see that file). `runShellm`
  (`src/shellm.ts`) now builds its `context` call with `fullTypes: ["prompt"]`
  always, and — when `SHELLM_CONTEXT_SCOPE=run` — `run: runStepId, head: 0,
  pins: [promptStepId]` (the prompt step's own assigned id, captured at
  append time).
- **d43ae81 — `--tail-block`; run scope reads a wide, block-moving window.**
  `windowStart(N, tail, block)`: the tail window's start rounds down to a
  multiple of `block` (>1), so the rendered prefix changes once per `block`
  appended rows instead of on every call (keeps the provider's prompt cache
  warm). `runShellm`'s run scope passes `SHELLM_CONTEXT_RUN_TAIL` (default
  400) / `SHELLM_CONTEXT_RUN_TAIL_BLOCK` (default 50) as `tail`/`tailBlock`.
- **0f8b49e — newest-block byte band (`--block-limit`/`--whole-blocks`).**
  `rowLimit`/`bandStart`: rows in the newest `wholeBlocks` window-blocks
  render at `blockLimit` instead of `promptLimit` — the band follows the same
  fixed row-index grid as `windowStart`, so a row's limit changes exactly
  once, on the call where the window start would move anyway. `runShellm`
  always passes `SHELLM_CONTEXT_BLOCK_LIMIT` (default 8192) /
  `SHELLM_CONTEXT_WHOLE_BLOCKS` (default 1) in BOTH scopes. The `--max-bytes`
  binary search in the standalone CLI passes ONE limit for both prompt-limit
  and block-limit (matching bash's own `render_at`), so the band collapses
  under budget pressure instead of defeating it.
  **PORT-NOTE (scope decision, not ported):** 0f8b49e's own bin/shellm diff
  also rewrites the bundled `SHELLM_SYSTEM_PROMPT` text (the "Trajectory and
  context" section's output-budget paragraph and the `File tools:` →
  `Editing files:` line) and 37f9340 renames the system prompt's intro line
  and gates the `$CONTEXT`/`$FILE_CONTEXT*` guideline on whether context was
  actually passed. In this port that bundled text is `SHELLM_SYSTEM_PROMPT`
  in `src/prompts.ts` (an asset file `monolith.ts` reads — Lane B's file per
  the lane plan, not one of this lane's five files), and since monolith never
  passes stdin/`-f` context to `runShellm`, 37f9340's conditional reduces to a
  static wording edit for this port's only real caller. NOT touched here to
  avoid a cross-lane file conflict — flagged for lane B (thinker engine core)
  to pick up alongside its other `thinkers/monolith/prompt.md` wording work
  in the same commit range.
  New unit tests: `test/context.test.ts`'s "bookkeeping is_meta, --tail-block,
  --run scope, --full-types, block-limit band" describe block (buildContext,
  8 tests) + "--run, --tail-block, --full-types, --block-limit/--whole-blocks"
  (the standalone CLI, 4 tests); `test/shellm.test.ts`'s "context scope
  (SHELLM_CONTEXT_SCOPE)" describe block (3 integration tests through the
  real `runShellm` loop with a fake `LlmClient`) + `constantsFromEnv`
  additions. Differential `parity/context/run-parity.mjs`: 10 new CORE
  scenarios, **114/114 byte-exact against upstream-next** (0 PORT BUGS); the
  pre-existing 101 CORE scenarios are unaffected (byte-exact against BOTH the
  old 7d29f9e pin and upstream-next).
- **d64d420 (partial — `extract_code`'s no-fence notice only; the
  `thinkers/monolith/prompt.md` FINAL= wording is lane B's).** `extractCode`
  (`src/extract.ts`) now sets `noFence` whenever the fallback "whole response
  as code" branch fires (no fenced block found — including the edge case of
  an empty-but-present fence pair, ` ```bash\n``` `, which bash's own
  `[[ -z "$code" ]]` test can't distinguish from "no fence" either) AND the
  fallback text has real (non-whitespace) content: the byte-identical
  `NOFENCE_NOTICE` line (bash's single-quoted heredoc, backticks and the
  `FINAL="..."` double quotes all literal) is prepended, ahead of the
  (mutually exclusive) truncation notice. 4 new/updated `test/extract.test.ts`
  cases (plain-sentence, empty-fence-pair, blank-response and
  whitespace-only exclusions).
- **callout (c), PR #103 "sensitive-config-forwarding" — new pure functions,
  not yet wired to a caller.** `_shellm_private_var_name`'s FINAL regex
  (a4b5db8: `(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)`
  unanchored, `(^|_)(URL|URI|ENDPOINT|DSN)(_|$)` anchored, case-insensitive)
  → `shellmPrivateVarName`; `_redacted_cmdline` (space-joined, NO shell
  quoting, a `--var NAME=VALUE` redacted to `NAME=<redacted>` only when the
  NAME matches, a bare `--var NAME` untouched) → `redactedCmdline`; the
  endpoint-alias precedence fix (a process-level `SHELLM_API_URL`/
  `LLM_API_URL` — however it got there — must beat either name subsequently
  loaded from a `.env` file, and one alias wins consistently over the other)
  → `resolveShellmApiUrl` (all three, `src/shellm.ts`).
  **Scope note**: callout (c) says this "maps to `src/shellm.ts`, which
  currently has NO equivalent code at all" — true at the time. **`shellmPrivateVarName`/`redactedCmdline` now have a real caller**: bug #63
  (see "shellm-run `command` field was a fixed template" below) wires them
  into `monolith.ts`'s `synthCommand()`, which now builds the actual shellm
  argv (rather than a fixed template with no real secret VALUES on its
  `--var` flags) and redacts it exactly the way `bin/shellm:3035-3051`'s
  `main()` records the shellm-run row. `resolveShellmApiUrl` remains
  unwired — no caller in this port loads a `.env` file or needs the
  process-vs-file endpoint-alias precedence question it answers. Ported as
  byte-faithful, fully unit-tested pure functions (`test/shellm.test.ts`:
  `shellmPrivateVarName` (4 tests), `redactedCmdline` (5 tests),
  `resolveShellmApiUrl` (5 tests)) before this caller existed, so bug #63's
  fix only had to call them, not write new redaction logic. The bare
  `--var NAME` (value from inherited env) argv form this callout also
  mentions already existed in bin/shellm at the `7d29f9e` pin (predates this
  triage range) and has no CLI-argv-parser equivalent in this port at all
  (no standalone `shellm` CLI) — a pre-existing, unrelated gap, not touched
  here.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima pnpm vitest run` green (one known flaky,
timing-sensitive adapter-deadline test under whole-suite CPU load, reproduced
failing then passing in isolation — unrelated to this lane, pre-existing).

## Upstream sync 1c, lane G (7d29f9e → 5458fee, Slack bridge)

Lane G carries `src/slack/{inbound,outbound,api,config,filepayload}.ts`, their
tests, and `parity/slack/`. Upstream commits: e5a2f7c, f0de3e8, ed0b700
(slack part), f163f93, cb974c2 (reaction events, merged as PR #88/314e771),
48a706c, d5cc776 (first-@mention thread-join backfill, PR #108/8d73c52),
f6a821a (test-only), 692e16e, c7d240b (`files.upload_v2`, PR #109/b71c83b),
6a98ab5 (slack part; outbound emoji reactions, PR #111/a2a00f9). Builds on
main (lane D's `chat.ts`: `chat react`, `chat send-file`'s `content_b64`,
`--source-url`).

- **e5a2f7c, f0de3e8, ed0b700, f163f93, cb974c2 — inbound `reaction_added`
  events land in the mind log.** `inbound.ts` gained `reactionText`
  (exported), an internal `reactionToInbound` gate, and `Inbound.onEvent`
  now branches on `event.type === "reaction_added"` to a new `onReaction`
  path before falling into the existing message/mention gate
  (`onMessageEvent`, the old `onEvent` body renamed). Channel reactions are
  gated to the bot's own messages (`item_user === botUserId`); DM reactions
  are unconditional. A channel reaction anchors at the item ts as a
  provisional thread; the delivery worker resolves the REAL parent thread
  via `reactions.get` (`conversations.history`/`.replies` don't expose it —
  `.history` only returns parent-channel messages, `.replies` is keyed by
  parent not item), renaming `from_name`/body (`:emoji: (on <item_ts>)`
  when nested) — never the socket-mode handler, which must ack without
  waiting on the Web API. `InboundMessage` gained `messageTs`,
  `resolveParent`, `isReaction`, `backfill` fields.
  **In scope, ported**: the shared "at most one Slack lookup in flight"
  bound (`f163f93`, `d5cc776`'s unification into one `tryLookup` — see
  below) and the `isReaction` marker gate that upstream added so reactions
  skip its permalink lookup (`cb974c2`).
  **Out of scope, not ported**: the permalink lookup itself
  (`chat_getPermalink`/`source_url`, added by `f68c1d8`) — that commit
  touches `slack/src/headlong_slack/inbound.py` but is not assigned to any
  lane's commit list in `UPSTREAM-TRIAGE-2.md`'s lane-G row (nor claimed by
  lane I's row, which lists only `f68c1d8`'s `web/` part). `isReaction` is
  ported anyway (its OTHER purpose — cb974c2's reaction-routing/lookup
  changes — needs it regardless), so when that gap is closed the existing
  `!msg.isReaction` gate point is already in place; see the spawned
  follow-up and `parity/slack/run-parity.mjs`'s `KNOWN_PERMALINK_GAP`.
  `Inbound`'s single shared lookup slot (`tryLookup`, a `lookupBusy`
  boolean) replaces Python's `max_workers=1` `ThreadPoolExecutor` +
  `Future` — Node has no threads, so "at most one call in flight, a
  timed-out call fails open immediately without queuing a second one, and
  the background call keeps running until it settles" needed no thread
  pool, just one flag and `withTimeout`'s promise race. `ITEM_LOOKUP_
  TIMEOUT_MS`/`JOIN_BACKFILL_TIMEOUT_MS` are exported constants (matching
  upstream's module-level `ITEM_LOOKUP_TIMEOUT`/`JOIN_BACKFILL_TIMEOUT`)
  but also exposed as `InboundOptions.itemLookupTimeoutMs`/
  `joinBackfillTimeoutMs` — a TS module constant cannot be monkeypatched
  the way Python's tests do (`monkeypatch.setattr(inbound,
  "ITEM_LOOKUP_TIMEOUT", 0.05)`), so the bound is injectable instead,
  defaulting to the real constants. 24 new tests in
  `test/slack-inbound.test.ts` port every non-permalink case from
  upstream's `test_inbound.py` reaction sections, including the
  timed-out-lookups-share-one-worker regression (gated via the injectable
  timeout rather than a monkeypatched constant).
- **48a706c, d5cc776 — first-@mention-in-a-thread backfill.** `Config`
  gained `threadJoinBackfill` (env `SLACK_THREAD_JOIN_BACKFILL`, default
  20, `0` disables, clamped to 50; `config.ts`'s `joinBackfillLimit`). On a
  first @mention inside an existing thread (not already active, not a
  top-level mention, not a DM, backfill > 0), the delivery worker fetches
  `conversations.replies` and prepends up to N earlier lines, formatted
  `[thread before this mention — N earlier messages]` + `name: text`
  lines (each capped at `JOIN_BACKFILL_LINE_CHARS`=200). `d5cc776`'s
  closest-lines-not-oldest-page fix is ported as `threadLinesBefore`'s
  cursor walk (paginate until exhausted or the page cap, fail open to `[]`
  on incomplete pagination — never prepend a stale oldest slice) sharing
  the SAME one-in-flight lookup slot `reactions.get` uses. Already-active
  threads, top-level mentions, DMs, and `threadJoinBackfill: 0` all skip
  the lookup entirely (no `conversations.replies` call). 16 new tests
  cover capped-prior-lines, closest-lines-via-pagination, already-active/
  top-level/DM skip, lookup-failure-still-delivers, `0`-disables, and the
  timed-out-burst-shares-one-worker regression (again via the injectable
  timeout — see `f6a821a` below).
- **f6a821a — test-only, no source change**: upstream's regression fix
  counts `ThreadPoolExecutor.submit` calls (not `replies_calls` at
  call-start) because the fake only appended to that list once a queued
  call started, so an "always submit" bug could pass until pool shutdown
  cancelled the queue. This port's `tryLookup` has no separate queued
  state at all — a lookup either starts synchronously or is skipped
  (`lookupBusy`) — so counting actual `reactionsGet`/`conversationsReplies`
  invocations in the port's own regression test is equivalent; no
  submit-vs-started distinction needed. No `src/` change.
- **692e16e, c7d240b — outbound file upload via `files.upload_v2`.** New
  `src/slack/filepayload.ts` (no 1:1 upstream Python module before this
  sync — ported fresh from `slack/src/headlong_slack/filepayload.py`):
  `filePayload(step)` detects a `filename`-stamped step (the `file` alias
  is NOT accepted — an ordinary message must stay `chat.postMessage`),
  decodes `content_b64` (strict — a failed decode round-trip is a
  `decodeError`, matching Python's `base64.b64decode(..., validate=True)`)
  or falls back to leak-filtered `content`, reduces the filename to its
  basename, and truncates/leak-filters a `caption` into `initialComment`
  (cap `COMMENT_MAX`=3000). `fileSignature(filename, content)` is
  `filename:sha256(bytes)` for `RecentPosts`-style dedupe.
  `outbound.run` now checks `filePayload(step)` before the plain-text path:
  a decode error or empty content logs and falls straight to `(failed to
  deliver file <name>)`; otherwise it calls the new `WebClient.
  filesUploadV2` and, on success only, records the signature. **c7d240b**:
  dedupe is recorded ONLY after Slack accepts — `RecentPosts.isDuplicate`
  was split into `seen()` (check, no record) and `record()` (explicit
  stamp) so a rejected upload's identical retry is not silently swallowed
  for the dedupe window (this split is itself the behavior upstream's
  commit introduces on the Python `RecentPosts` class). `api.ts`'s
  `filesUploadV2` ports slack_sdk's real 3-call client-side flow — there is
  no single `files.upload_v2` server endpoint — read directly from the
  installed `slack_sdk` source (`web/client.py`, `web/internal_utils.py`,
  `web/base_client.py`), not assumed: (1) `files.getUploadURLExternal`
  (`params=` form: `filename`, `length`) → `{file_id, upload_url}`; (2) a
  RAW `POST <upload_url>` of the bytes — NOT under `slack.com/api/`, no
  `Authorization` header, no JSON envelope
  (`_upload_file_via_v2_url`: bare `Request(method="POST", data=data,
  headers={})`); (3) `files.completeUploadExternal` (`params=` form,
  `files` a JSON-stringified `[{id, title}]`, plus `channel_id`,
  `thread_ts`, `initial_comment`). 20 new tests (`test/slack-filepayload.
  test.ts`'s 12 cases mirror `test_filepayload.py` 1:1; `test/slack-
  outbound.test.ts` gained 8 file-upload cases including the
  dedupe-after-accept retry) + 2 new `test/slack-api.test.ts` cases proving
  the 3-call sequence and its `HttpError` on a failed upload step.
- **6a98ab5 (slack part) — outbound emoji reactions via `chat react`.**
  (`bin/chat`'s `cmd_react`/`chat.ts`'s `cmdReact` already landed with lane
  D — this lane only wires the Slack-side consumer.) `outbound.ts` gained
  `reactionName(step)` (strips leading/trailing colons, validates
  `[A-Za-z0-9_+:-]`, rejects whitespace or >100 chars — same character set
  as `chat.ts`'s own validation, checked independently on the receiving
  end) and `messageTsFromSourceUrl(url)` (decodes a Slack archive
  permalink's `/archives/<channel>/p<digits>` into `<sec>.<usec>`, no host
  check — matches Python's `urlsplit`-based parser, which doesn't check
  the host either). A step with a `reaction` field resolves its target
  timestamp from `source_url` (if `chat react --reply-to` had one — see
  lane D and, once ported, the `f68c1d8` permalink gap above) falling back
  to the conversation's own `thread_ts`; a DM/top-level reaction with
  neither is skipped (logged, not posted as text — nowhere to react to).
  `reactions.add` failures are retried on the next identical step
  (dedupe recorded only on success, same `seen()`/`record()` split as file
  upload); `already_reacted` counts as success (Slack's own answer to "did
  this land," not an error). 11 new outbound tests + 2 `reactionName`/
  `messageTsFromSourceUrl` unit tests port every case from upstream's
  `test_outbound.py` reaction section. `api.ts` gained `reactionsAdd`
  (`params=` form: `channel`, `timestamp`, `name`).
- **Real bug found while proving `conversations.replies` parity**:
  `api.ts`'s `callForm` sent boolean params as `"true"`/`"false"`
  (`String(v)`); slack_sdk's `params=` path converts booleans to `"0"`/
  `"1"` (`internal_utils.convert_bool_to_0_or_1`/`_to_0_or_1_if_bool`,
  every `params=` wrapper method's kwargs pass through it — "Slack APIs
  safely accept 0/1... True/False doesn't work with aiohttp"). No existing
  `params=` method before this lane had a boolean field (`conversations.
  replies`'s `inclusive` is the first), so this was a latent bug with no
  prior differential coverage. Fixed in `callForm`; `callJson` (`chat.
  postMessage`'s `unfurl_links`) is unaffected — that conversion is
  `params=`-only. Found by `parity/slack/run-parity.mjs`'s new
  `first-mention-backfill-prepends-prior-lines` scenario, not assumed.
- **Deferred, unassigned in this sync's lane plan**: `f68c1d8`'s
  `chat_getPermalink`/`source_url` addition to `inbound.ts`'s `deliver()`
  — see the `e5a2f7c` bullet above. `parity/slack/run-parity.mjs` tags 7
  scenarios `KNOWN_PERMALINK_GAP` (every non-reaction on_event delivery,
  plus the new backfill scenario): each is verified, not assumed, to
  diverge in EXACTLY the documented way (one extra `chat.getPermalink`
  call on the Python side, nothing else) before being excluded from the
  pass/fail gate — an unrelated regression on a tagged scenario still
  fails loud (`isOnlyPermalinkDivergence`). A follow-up task is queued to
  close this gap.
- Differential `parity/slack/run-parity.mjs` re-run against
  an upstream checkout (5458fee): **16/16 PARITY (100%) + 7
  known-divergence** (see above) — 8 new scenarios added (4 reaction/
  backfill `on_event`, 3 outbound file-upload/reaction, plus the boolean-
  encoding fix's coverage via the existing backfill scenario);
  `fake-server.mjs` gained `reactions.get`/`conversations.replies`/
  `reactions.add`/`files.getUploadURLExternal`/`files.completeUploadExternal`
  defaults and an `/upload-fake/<id>` route standing in for `files.upload_
  v2`'s pre-signed URL step (outside `/api/`, compared separately via
  `uploadRequestsEqual`); `py_driver.py`'s `on_event` mode now dispatches
  `reaction_added` events to `Inbound._on_reaction` (Bolt registers it
  separately from `_on_event` — the driver was calling the wrong handler
  for every reaction event before this fix) and waits for the drain
  worker's queue to empty (+0.3s grace) before calling `stop()`, which
  otherwise raced the worker's `_lookup_pool.submit()` and reliably lost
  (`RuntimeError: cannot schedule new futures after shutdown` — a bug in
  the test harness itself, not the bridge: production only calls `stop()`
  at real process shutdown).

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima pnpm vitest run` green.
## Upstream sync 1c, lane B (7d29f9e → 5458fee, thinker engine core)

Carries the `src/monolith.ts`, `src/responder.ts`, `src/retrieval.ts`,
`src/recentStream.ts`, `src/rollups.ts`, `src/prompts.ts`,
`src/personMemory.ts` slice — the monolith wake prompt, the recent-stream
projection, goal/related-memory presentation, and the small responder/
retrieval wording fixes in this commit range. Files touched:
`src/monolith.ts`, `src/recentStream.ts`, `src/personMemory.ts`,
`src/responder.ts`, `src/steprun.ts` (one targeted fix — see below),
`src/assets/shellm-system-prompt.txt`, `src/assets/monolith-prompt.md` +
`src/assets/thinkers/monolith/prompt.md` (the two bundled copies, kept
byte-identical), `src/assets/thinkers/retrieval/{disabled,prompt.md}`,
`test/monolith.test.ts`, `test/recentStream.test.ts`,
`test/personMemory.test.ts`, `test/responder-integration.test.ts`,
`test/identity-new.test.ts` (one fixture-string update), `test/steprun.test.ts`,
`test/daemon-step-survival.test.ts` (poll timeout), `parity/replay/lib.mjs` +
`test/replay.test.ts` (lane-classification marker text kept in sync).

- **2fed66c (thinker part) / 0a36061 — PENDING REQUEST reads the whole
  trajectory, not a 20-step window.** The old `pendingRequestHint` scanned
  the bounded `recentContext` string and showed only the newest unresolved
  responder deferral — upstream's own 2026-09-02 bug: an older request was
  masked by a newer one, then scrolled out of the window and never delivered.
  Rewritten to call `src/messageIndex.ts`'s already-shipped `chat pending`
  machinery (`indexUpdate`, `deferralsPath`, `queryPending` — lane D's
  2fed66c port) directly, in-process, against the root trajectory file:
  every open request is listed, oldest first, with its own inline age format
  (`pendingAgeTextMonolith`, "N min"/"N h"/"N d" — distinct from `chat
  pending`'s own CLI-facing "Nm"/"Nh"/"Nd"), capped at 5 with a "N more…"
  trailer, OVERDUE past 4 hours (0a36061 lowered this from a day the next
  day, after two timer wakes read the day-old hint and filed research notes
  instead under "timer wakeups are for inner life" — the wording was also
  strengthened to a strong preference with a stated escape hatch: "Strongly
  prefer doing this work now (act)... If you have a good reason not to this
  wake, append a thought saying why"). **Signature change**:
  `pendingRequestHint(recentContext: string)` →
  `pendingRequestHint(trajFile: string, now?: () => number)` — every call
  site and test updated (`test/monolith.test.ts`'s whole describe block
  rewritten against a real `Trajectory`, porting 2fed66c's own scenario list:
  masking-fixed, burial under 40 later steps, ordering, age, overdue wording,
  cap+trailer, one-at-a-time resolution; `test/responder-integration.test.ts`
  updated to pass `traj.trajFile`). `thinkers/monolith/prompt.md`'s "pending
  request outranks the menu" paragraph ported into both bundled copies (see
  the full-range prompt.md note below).
- **c887a4d, d507855, f1b8693 (recent-stream part) — `_recent_stream`
  pipeline, ported as one sequence (`src/recentStream.ts`).** c887a4d stamps
  a synthetic `.details` field ("traj tail -n 400 --filter run_id=<FULL id>")
  on a `final` step carrying a run_id — under `--context-scope run` (lane A)
  a run's final is all the next wake sees of that run, so `.details` is the
  escape hatch back to the raw steps. d507855 prunes the rendered record to
  the 18-field allowlist the mind actually uses (responder metrics like
  `context_steps`/`compose_ms`/`model` were 10K of a 17K stream on Audel) and
  cuts `step_id`/`run_id` to 8 characters (`trigger_step`/`resolves` stay
  whole — the mind copies them verbatim; `.details`' run id stays full,
  baked in before the cut). f1b8693 adds the final/observation PAIRING step
  (drop the nearest earlier observation sharing a `final`'s run_id — an
  observation immediately followed by its own run's final is the same report
  written twice), running over the WHOLE filtered stream BEFORE the window
  (N) cut so N still counts N distinct events afterward. Also ported: `del
  .content_b64` and the `content=="" && filename!="" -> "[file: name]"`
  fallback (chat send-file's `content_b64` field, lane D). **2c89d2e is a
  confirmed no-op** for this port ("telegram: drop reasoning from
  recent-stream (match main)" fixes a rebase-conflict artifact on a branch
  that briefly re-added `reasoning` to `KEPT_TYPES`; this port's `KEPT_TYPES`
  never carried it — see the file's own PORT-NOTE). 9 new
  `test/recentStream.test.ts` cases (field pruning, id truncation,
  full/short run_id in `.details` vs the field, ts truncation, final-with-
  and-without-run_id, pairing removes the right observation, pairing survives
  an unresolved run, pairing runs before the window cut, content_b64/filename
  fallback); the 9 pre-existing cases (dcf3c02/upstream-sync-1b) still pass
  unchanged.
- **62d7da3, b1cf15e — Runtime line + Workspace map (`src/monolith.ts`).**
  New `runtimeLine(binDir, thinkersDir, now)`: names the commit the mind's
  own tools run under (`git -C <binDir's parent> rev-parse --short HEAD` /
  `log -1 --format=%s`), when it was checked out (`.git/HEAD`'s mtime), and
  when the identity's `thinkers/` copies were last synced (newest mtime under
  `IDENTITY_DIR/thinkers`) — "" (not thrown) when the root is not a git
  checkout, matching bash's `_runtime_line`'s unconditional `return 0`.
  `binDir`'s parent stands in for upstream's `command -v shellm`-derived app
  root (this port has one fixed checkout, not per-tool PATH resolution).
  New `workspaceSection(workdir)`: the wake's working directory, its
  top-level directories with RECURSIVE file counts (best first, hidden dirs
  and `__pycache__` skipped, capped at 12 with a remainder line), loose
  top-level file count (hidden files excluded), and either `WORKSPACE.md`'s
  first 8 lines (160 chars each) or an invitation to write one — "" when
  `workdir` doesn't exist. New `coarseCount(n, cap?)` (b1cf15e): rounds to 2
  significant figures from 100 up so the section — sitting in the wake
  prompt's cached prefix — doesn't change on every wake that adds one file;
  `cap` renders a head-limited per-directory count as `"<cap>+"`. Both
  sections are spliced into `routePrompt` right after the system prompt, each
  on its own paragraph, present-or-absent (no separator noise when empty) —
  mirrors bash's `${var:+$var\n\n}` splice exactly (both functions return
  their text WITHOUT a trailing newline, like a stripped `$(...)` capture;
  the caller adds "\n\n"). 17 new tests porting
  `tests/test_workspace_runtime.sh` verbatim (runtime line fields, no-sync-
  time/sync-time-from-newest-file, no-git-checkout, missing/empty workdir,
  recursive counts + hidden/loose/pycache rules, `coarseCount`'s 6 fixed
  cases, `WORKSPACE.md` head replacing the invite, directory-list cap).
  `test_monolith_wake_sections.sh`'s runtime/workspace assertions (the
  section headers, `notes/ 2 files`, `No WORKSPACE.md yet`) are covered by
  these same unit tests rather than re-driving the whole wake end to end (no
  stubbed-`shellm`-subprocess equivalent exists in this port's architecture —
  `runShellm` is in-process).
- **130796a — related memories + goal lifecycle + the goal-review nudge.**
  New `src/personMemory.ts` functions (chosen home: memory-store readers with
  no closer fit in this port's layout — `mem.ts` itself, lane C's file,
  already flags this exact consumption point as lane B's scope in its own
  header comment, lines 28-35):
  - `activeGoalsSection(memDir, {max, now})` — every goal-family memory
    (goal, intention, objective, todo), newest-filename-first, tagged with
    its type and age (`memAgeText`) and an `until:` date when present; a
    memory whose `until:` has passed is dropped; capped at `max` (default 8)
    with a "and N more: mem list --type goal (also intention, objective,
    todo)" trailer. Supersedes `src/steprun.ts`'s old `getGoals` (goal|
    intention only, no age/until/cap) as `monolith.ts`'s source for the wake
    prompt's `{{goals}}` substitution — `monolith.ts` now computes goals
    itself from `MEM_DIR` at wake time instead of reading the static
    `IdentityConfig.goals` string `steprun.ts` computed once at config-build
    time. `steprun.ts`'s `getGoals` is left in place, not removed (nothing
    else in this port reads `IdentityConfig.goals`, so it is unused but
    harmless dead computation, not a correctness gap) — kept this way rather
    than edited to avoid a second, larger cross-lane touch to a file no lane
    claims.
  - `relatedMemories(memDir, query, prevNames, {n, freshSeconds, now})` — up
    to `n` (default 3) one-line pointers (name, type, age, first body
    sentence) scored against `query` with `mem.ts`'s ALREADY-EXPORTED BM25
    primitives (`extractPrefilterTerms`, `scorePrefilterCandidates` — `mem.ts`
    itself is untouched by this lane). Two-stage filter matching upstream's
    `tr | grep -vxiE $_RELATED_STOPWORDS | ... | mem prefilter`: strip
    prompt-boilerplate tokens (`RELATED_STOPWORDS`, e.g. "mind", "pending",
    "chat", "reply-to" — or every timer wake matches the same hub notes)
    first, then run the cleaned string through the standard prefilter
    tokenizer/stopwords/BM25. Skips memories under a day old (already in the
    stream) and any name in `prevNames` (what the previous wake showed).
  - `memAgeText(created, mtimeMs, nowMs)` — "3h"/"5d"/"3w" from a memory's
    `created:` frontmatter field, else the file's mtime. **Quirk replicated**:
    upstream writes `created:` with a bare LOCAL-time `date +"%Y-%m-%d
    %H:%M:%S"` (`mem.ts`'s own `stampHuman`, no `-u`) but `_mem_age` re-parses
    it with `date -u -d "$created"` — the naive string is misread as UTC
    regardless of the box's real timezone. Replicated by always treating
    `created` as UTC here too, not "fixed."
  - `monolith.ts`: the GOAL REVIEW nudge (fires once every `GOAL_REVIEW_DAYS`
    = 7, hardcoded — same no-env-override convention as
    `THINK_CONTEXT_TAIL`/`SHARE_HINT_EVERY`) and the related-memories query
    construction (the wake's own routing-hints text BEFORE the "no special
    signals" fallback, plus the last 3 kept stream steps' content, 600 chars
    each) — `buildRoutingHints` (renamed from `routingHints`) now returns the
    RAW hints so the caller can build the query from them before applying the
    fallback, matching bash's own ordering (`related_query="$hints ..."` runs
    before `[[ -z "$hints" ]] && hints="- (no special signals...)"`).
    `relatedPrev`/`goalReviewAt` persist in the SAME `monolith_backoff_state
    .json` file as the backoff fields (`MonolithState extends BackoffState`;
    `decideBackoff`'s own return only knows the backoff fields, so its result
    is merged back with the two lane-B additions on every save).
  - **Metrics (audel-metrics: related-memories section, audel-recall-judge)
    — OOS**, per the triage table ("deploy/scripts/\* OOS").
  - 15 new `test/personMemory.test.ts` cases porting
    `tests/test_related_memories.sh` verbatim (all four goal types shown, an
    expired todo hidden, an open todo's until date, newest-first, age in
    weeks, cap+trailer, no-goals empty store, the GitHub-access note picked
    for a PR request, first-sentence extraction, today's memory skipped,
    at-most-N, a name shown last wake skipped, template-words-alone produces
    nothing, N=0 disables the section) plus 3 direct `memAgeText` cases.
- **3330189, a4ed181 — rollup model precedence / no verbatim raw tail by
  default: RESOLVED (lane J, sync 1c).** `monolith.ts`'s `lifeSection` is no
  longer a hardcoded `""` — `lifeContextSection()` ports `_life_context()`
  (common.sh:531-548) and its call site's gate/wrapper (thinkers/monolith/
  step:281-291) together: `MONOLITH_TIERED_MEMORY` (default `"1"`) gates the
  whole section; the map model resolves as `ROLLUP_MODEL ?? RECAP_MAP_MODEL ??
  SHELLM_FAST_MODEL` (3330189); `--raw-tail` passes `ROLLUP_RAW_TAIL ?? "0"`
  (a4ed181, no verbatim raw tail by default); `--budget` passes
  `MONOLITH_CONTEXT_BUDGET ?? "auto"`; `-q` is always passed. The call runs
  IN-PROCESS via `src/recap.ts`'s own `runRecap()` (this port's byte-exact
  `--context` staircase — see the "recap CLI" parity-table row above for
  why `recap.ts`, not `rollups.ts`'s `recapContext`/`lifeContext`, is the
  reused path) rather than shelling out to a `recap` binary, so
  `command -v recap` has no
  analogue: the "recap not installed" degrade is structurally unreachable
  here (recap.ts is a compiled-in module), and the equivalent failure mode —
  `runRecap` throwing or exiting non-zero — degrades to `""` the same way
  `_life_context`'s own `2>/dev/null || true` and the call site's
  `_lc=$(_life_context) || _lc=""` do. Bash's `$(...)` trailing-newline
  stripping is replicated with `lc.replace(/\n+$/, "")` before the non-empty
  check, verified against the real `_life_context`/common.sh function
  (stubbed `recap` script, no network) — see test/monolith.test.ts's
  "life context" describe block. The `llm` process boundary `recap`'s rollup
  sealing would spawn is `defaultRecapRunLlm` (mirrors bin/recap.mjs's own
  `spawnSync("llm", …)` shim exactly) in production, and
  `RunMonolithWakeOptions.recapRunLlm` in tests (recap.test.ts's existing
  injected-`io.runLlm` seam, reused here — no subprocess, no network in the
  suite).
- **f6f854c, 6a5f6c5, d64d420, 0a36061, 130796a — `thinkers/monolith/
  prompt.md` wording, applied as the FULL cumulative diff.** Rather than
  replaying each commit's incremental prompt.md edit (several touch
  overlapping paragraphs across a 2-day span), both bundled copies
  (`src/assets/monolith-prompt.md` and `src/assets/thinkers/monolith/
  prompt.md`, required byte-identical by `test/monolith.test.ts`) were
  replaced with upstream-next's FINAL `thinkers/monolith/prompt.md` bytes
  directly (verified `diff` clean against an upstream checkout — see
  gate results). Covers: the context paragraph shortened to one sentence
  (6a5f6c5 — the original ban on re-reading was aimed at a truncation-stub
  loop that no longer exists this way); "pending request outranks the menu"
  (0a36061); `act`'s observation now "one line, the fact" with the handoff
  moved to `FINAL=` (f1b8693/d64d420); `goals` mentions `mem edit`/`mem
  forget`/`--until` and the GOAL REVIEW signal (130796a); `idle`'s worked
  example now sets `FINAL=` in the SAME bash block (d64d420 — a plain-
  sentence reply with no bash block is not a finish signal, it runs as a
  failing shell command; the fix on this port's shellm side already landed
  as lane A's `bae6570`/`3885db5`, the `extractCode`/`createFenceStopTracker`
  no-fence-notice machinery — this is only the matching PROMPT TEXT that
  tells the model to do it); the FINAL= paragraph naming the `details`
  command (c887a4d/f1b8693); the closing Rules bullet naming the Runtime/
  Workspace lines as authoritative, replacing the old "never emit thought:/
  action: prefix lines" bullet (62d7da3 — that convention warning is gone
  upstream too). `test/characterization.test.ts`'s golden-trace replay stays
  green (trajectory STEP SHAPES are frozen surface; prompt PROSE is not —
  AGENTS.md "NOT on surface: nondeterministic model prose, stdout text").
- **37f9340 (thinker-prompt part) — shellm system-prompt intro line.**
  Flagged directly by lane A's own PARITY.md note above ("NOT touched here
  to avoid a cross-lane file conflict — flagged for lane B"). `src/assets/
  shellm-system-prompt.txt`'s intro line: "You are shellm, an AI assistant
  operating inside a bash shell environment." → "You are running in shellm,
  headlong's bash agent loop:" (the old line clashed with the wake prompt's
  own "You are not a chat assistant"). The commit's OTHER half — gating the
  `$CONTEXT`/`$FILE_CONTEXT*` guideline on whether context was actually
  passed — is a pre-existing no-op for this port: that guideline line was
  never in this port's bundled text to begin with (confirmed absent before
  this change), and `monolith.ts` never passes stdin/`-f` context to
  `runShellm` anyway, so there is nothing to gate. `parity/replay/lib.mjs`'s
  `LANE_MARKERS.monolith` classifier (matches a request's system-prompt
  prefix to tell a monolith call from a responder call in the L2 replay
  harness) and `test/replay.test.ts`'s `MONOLITH_SYS` fixture both hardcoded
  the OLD intro line as their matching string — both updated to the new
  wording so the harness keeps classifying real monolith calls correctly
  (a tape recorded against an older checkout would need re-recording, not a
  dual marker — noted inline, out of scope here).
- **0f8b49e (thinker-prompt part, already covered by lane A) — "File
  tools:" → "Editing files:".** Already ported (see the `--bin glob…`
  callout below); listed here only because lane A's own note flagged both
  0f8b49e's and 37f9340's system-prompt-text halves for lane B together.
- **b6540e6, ed0b700 (responder part) — NO_REPLY names a bare Slack
  reaction.** `src/responder.ts`'s `buildReplySystem` NO_REPLY hint now
  names "a Slack reaction (a `:emoji:` body, optionally with `(on <ts>)`)"
  as a case needing no reply (a reaction should never get a chat reply).
  Upstream split this into two commits only because the reaction clause's
  backticks and parens ran as unescaped command substitution inside a bash
  double-quoted heredoc (ed0b700 introduced the bug, b6540e6 fixed the
  escaping the same day) — this port's template literal has no such
  shell-quoting hazard, so only the WORDING (not a bug fix) applies here.
- **6c324d1 (retrieval part) — per-identity `disabled` marker wording.**
  `src/assets/thinkers/retrieval/{disabled,prompt.md}` updated to upstream-
  next's bytes verbatim (diff-clean): the marker is now framed as
  per-identity STATE ("this marker is copied as per-identity state; delete
  the identity's copy... and updates will preserve that choice") rather than
  a bundled default an update can silently reset. The actual "inherited on
  first install only, then preserved across updates" LOGIC lives in
  `tools/identity` / `web/src/headlong_web/thinker_sync.py` upstream, and in
  `src/identity.ts` / `web/server/src/thinker-sync.ts` in this port — lanes
  E and I respectively, per PARITY.md's own pre-existing callout (d); NOT
  touched here, text-only change. `test/identity-new.test.ts`'s hardcoded
  expectation of the OLD marker text updated to match (a one-line fixture
  string, the direct and only consequence of the asset change — not a
  broader touch to identity.ts).
- **a7b6b37, c78d283 (thinker part) — provider-key export / bare `--var
  NAME`: already satisfied by pre-existing architecture, one real gap
  closed.** Upstream's bug: a subshell building `_build_shellm_flags`'
  output via process substitution can't `export` back to its parent, so
  skill-declared vars and provider keys silently failed to reach a nested
  `shellm` subprocess unless something else had already exported them.
  **N/A for provider-key forwarding**: this port's `src/sandbox-runtime.ts`
  (`forwardedEnv`/`FORWARDED_ENV_KEYS` — ANTHROPIC/OPENAI/GEMINI/OPENROUTER/
  OPENCODE/LLM_API_KEY, LLM_PROVIDER, SHELLM_MODEL, SHELLM_API_URL,
  LLM_API_URL) already unconditionally forwards every provider key into
  every wake's exec env — predates this sync (commit `5e5b039`), and has no
  subshell/export boundary to begin with (`runShellm` runs in-process). **One
  real gap, closed**: `src/steprun.ts`'s skill-declared-var forwarding loop
  (`buildIdentityConfig`'s `skillVarMounts` construction, bug #35's own
  fix) forwarded WHATEVER a skill's SKILL.md declared, with no exclusion —
  a skill declaring `LLM_API_URL` or `SHELLM_API_URL` as an `env:` var would
  re-forward its own (un-rewritten) value and could clobber shellm's
  Docker-rewritten canonical one. Added the two-name skip c78d283 itself adds
  (`case "$vname" in LLM_API_URL|SHELLM_API_URL) continue ;; esac`). This is
  the one line touched in `src/steprun.ts` for this whole lane — everything
  else in that file (goals, DEFAULT_IDENTITY_TEXT, etc.) is untouched.
  1 new `test/steprun.test.ts` case. `--var NAME` (bare, value resolved from
  inherited env) itself has no analogue to port: this port's `runShellm`
  takes an `execEnv: Record<string,string>` object directly, in-process —
  there is no argv `--var` encoding step for the monolith's own shellm call
  to begin with (confirmed by lane A's own PARITY.md note on this same
  callout).
- **d64d420 (prompt part) — covered above** (the FULL prompt.md replacement
  includes its FINAL= wording); the `extract_code` no-fence-notice half is
  lane A's (`bae6570`/`3885db5`), already landed.
- **f1b8693 (thinker-prompt part) — "skills pass": N/A for this lane's
  files.** The wake prompt's SKILLS SECTION content ("two lines and a list")
  is produced by `bin/skills`'/`src/skills.ts`'s `skills prompt` action
  (lane E's file) — `monolith.ts`'s `buildSystemPrompt` only concatenates
  whatever `skillsText` string it is handed, unchanged by this commit. The
  `_prompt_section` error-handling wrapper (loud stderr + a rate-limited
  `error` trajectory step when `identity prompt`/`skills prompt` fails,
  instead of a silent `|| ""`) is NOT ported: in this port, identity/skills
  text is computed once by `steprun.ts`'s `buildIdentityConfig` BEFORE the
  wake (and before a `Trajectory` handle even exists in that call), not
  lazily inside the wake the way bash's `_build_system_prompt` runs inside
  `thinkers/monolith/step` with `traj append` already in scope — porting the
  loud-failure behavior would mean threading a `Trajectory` into
  `buildIdentityConfig`, a `steprun.ts` architecture change with no natural
  home in this lane's file set. `steprun.ts`'s skills-read `try/catch` today
  silently falls back to `skillsText = ""` on failure — a PRE-EXISTING
  simplification (not introduced by this sync), left as a known gap here
  rather than silently "fixed" without the trajectory-plumbing this lane
  does not own. `_recent_stream`'s pairing behavior (the other half of
  f1b8693) is ported above under c887a4d/d507855/f1b8693.
- **1c055de, f18fe2b (thinker parts) — sensitive-config-forwarding, no
  `thinkers/monolith|responder/step` hunks survive in the final range diff.**
  Both commits' `thinkers/_lib/common.sh`/`thinkers/monolith/step` hunks are
  fully superseded by later commits in the same range (a7b6b37, c78d283,
  d507855, f1b8693 above) — `git diff 7d29f9e origin/main -- thinkers/` shows
  no residual hunk attributable only to these two once the later commits'
  content is accounted for. No separate port action beyond what is already
  covered above.

**Riskiest deviation, stated plainly**: 3330189/a4ed181 (`_life_context`
model precedence and raw-tail default) are NOT wired to anything in this
port, because the feature they modify does not exist here yet. This is a
pre-existing gap (predates this sync) documented, not hidden — the exact
precedence/default this port must use IS specified above for whoever
implements `_life_context`'s recap-in-process call next.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima pnpm vitest run` green, no test skipped
or loosened. `test/daemon-step-survival.test.ts`'s poll timeout raised
5s → 15s per this lane's brief (known load flake under a concurrent test
run, unrelated to any change in this lane).

## Upstream sync 1b (ed2dac6 → 7d29f9e)

Upstream `laude-institute/headlong` moved from `ed2dac6` to `7d29f9e` (53
commits — see `UPSTREAM-TRIAGE.md`). Each lane below carries its slice of
that range into the port; the pin bump to `7d29f9e` (see the header above)
landed once every applicable lane below had landed.

### 1. Installer (triage lane 1: Local Model Server Setup, 9 commits)

A **NEW-TOOL port** — before this lane the port shipped no installer at all.
Upstream's 9 commits (`2fd9b23`, `4679cba`, `f497797`, `70858e1`, `9a0ebdb`,
`e2b83b6`, `0a95b44`, `98950e1`, `24e7ce7`, see `UPSTREAM-TRIAGE.md`) add
first-class local-model-server support (llama.cpp/Ollama/vLLM/LM Studio) to
`tools/headlong-init` and `install.sh`, plus `.env` quoting/injection
hardening and installer prompt fixes. Ported whole: `tools/headlong-init` →
`src/init.ts` + `bin/headlong-init.mjs`, `install.sh` → `install.mjs` (+
`src/install-lib.ts`), `status.sh` → `status.mjs` (+ `src/status-lib.ts`),
`uninstall.sh` → `uninstall.mjs` (+ `src/uninstall-lib.ts`) — zero Bash
remains for any of the four. Full per-flow detail and differential proof is
in the **init** / **install** / **status** / **uninstall** rows of "Parity
by module" above; port commits `dd67c6c`, `b172864`, `96fe18d`, `fbfb988`,
`2a566c5`, `34995fb`, `8aae667`, `9c63b79`.

Proof: `parity/init/run-parity.mjs` 7/7 executable scenarios PARITY vs real
NEW `tools/headlong-init` (0 PORT-BUG; 3 more scenarios that need a local-
provider HTTP server SKIP in this sandbox — subprocess `curl` can't reach
loopback here, confirmed environment-only, since this same script's own
`fetch()` reaches the identical port fine; the same code path is covered by
`test/init.test.ts` via real `fetch()`); `parity/upstream-tests/run.mjs
--installer`'s `test_sandbox_gate.sh` 26/26 against NEW; `smoke_install.sh` /
`test_uninstall.sh` mostly parity, remaining port-only fails root-caused as
scratch-technique/bash-artifact limitations (bash-source-array-literal
checks, no-`.git`-in-scratch clone failures, `/var` vs `/private/var`
realpath) — see `parity/upstream-tests/report.md`'s Installer lane section —
not port bugs, except for the one real, documented gap below. tsc (root +
web) clean; whole-repo suite 1593/4 at merge.

**Two documented architectural gaps** (not stubs, not silent — see the Gaps
table above):
- `install.mjs` never stages a global `~/.skills/core-skills` or
  `~/.headlong-thinkers` — this port's `identity new` (`src/identity.ts`)
  bundles skill/thinker templates directly into each identity at creation
  time instead, so there is no global staging directory to populate.
- `persona` (the per-identity `ada`/`ada stop` command wrapper) is not
  shipped; use `node bin/chat.mjs`, `node bin/thinkers.mjs stop <name>`,
  etc. directly.

### 2. Conversation memory (triage lane 2)

Carries upstream's "conversation memory" feature (Lane 2 of
`UPSTREAM-TRIAGE.md`) into the port — see
`~/.headlong-worktrees/sync-conversation-memory`'s own commits for the
tracked change set; this section documents what each upstream commit changed
and where the port change + proof live. Oracle-first throughout: each row's
"Proof" cites either the new/extended vitest suite or a real differential run
against the NEW upstream checkout.

| SHA | Upstream change | Port change | Proof |
|---|---|---|---|
| f8a7ef0 | design: conversation memory plan for the responder (docs only) | none (docs) | n/a |
| 84aa37e | `bin/chat`: `chat history --with <name> [--since D] [-n N] [--json]`, the derived `messages.jsonl` index (byte-offset resume, full-scan rebuild on header mismatch, partial-line-safe), person keys (`_person_key`/`chat person-key`), `type: person` memory alias merge; `thinkers/responder/step` reads 7 days of indexed history with age stamps; `skills/chat/SKILL.md` doc update (the `--with` block only — NOT the later, out-of-lane Shellm.app formatting section from 931bf50/0ac2823) | `src/messageIndex.ts` (new), `src/personMemory.ts` (new), `src/chat.ts` (`cmdHistoryIndexed`, `cmdPersonKey`), `src/responder.ts` (history-driven `buildConvoSel`/`formatAge`), `src/assets/skills/chat/SKILL.md` | `test/messageIndex.test.ts` (10), `test/personMemory.test.ts` (16), `test/chat-history-index.test.ts` (12), `test/responder-integration.test.ts` (metrics group); differential `parity/upstream-tests/run.mjs` `test_chat_history_index.sh`: 29/29 vs real NEW; `parity/chat/run-parity.mjs` 21 new `convo-memory` scenarios: 21/21 vs real NEW `bin/chat` |
| dcf3c02 | `thinkers/_lib/common.sh` `_recent_stream`: drop `reasoning`, keep `final`, add `error`, collapse consecutive `idle`/`error` runs into one synthetic line each (`"idle x22 over 2h10m"`, `collapsed: N`) | `src/recentStream.ts` (new; replaces the old inline `recentStream` in `monolith.ts`), wired into both `monolith.ts` and `responder.ts` (inner-life excerpt) | `test/recentStream.test.ts` (9, ported assertion-for-assertion from `tests/test_recent_stream_filter.sh`); differential `parity/upstream-tests/run.mjs` `test_recent_stream_filter.sh`: 11/11 (no-port-cli — the Bash function itself, run for the record) |
| 0c51de8 | `bin/chat`: `chat reply --follow-up` (bypasses the duplicate-answer guard, stamps `follow_up:true`); `thinkers/monolith/prompt.md`: one-line "pending request" exception; `thinkers/monolith/step`: PENDING REQUEST routing hint; `thinkers/responder/step`: `DEFER: <work>` parsing (action step + holding reply), per-person notes (part 4) | `src/chat.ts` (`--follow-up`), `src/assets/monolith-prompt.md` + `src/assets/thinkers/monolith/prompt.md` (byte-identical to NEW), `src/monolith.ts` (`pendingRequestHint`, exported), `src/responder.ts` (DEFER handling, `updatePersonNotes` — **PORT-NOTE**: reuses the reply's `LlmClient` instead of a cheaper notes-only model, since the port's `LlmClient` has no per-call model parameter; documented in the function's own header). **REAL PORT BUG, found live and fixed**: `_update_person_notes_async` (step:393-402) runs the notes writer in a DETACHED subshell (`( _update_person_notes … ) >>notes.log 2>&1 </dev/null &`) that outlives the responder step; the port's async path (RESPONDER_PERSON_NOTES_SYNC unset) instead fired `updatePersonNotes` as an in-process fire-and-forget promise — `bin/thinker-step.mjs`'s `process.exit()` (called the instant `runResponder` resolves) killed that promise's in-flight LLM call EVERY time, so no `type: person` memory was EVER written on a real async wake (proven live: two replies with `history_source=index`, `context_msgs=2`, no `type: person` memory ever appeared, `responder-notes.log` never created). Fixed: the async path now spawns a real detached child process, `bin/responder-notes.mjs` (new), the same technique `thinkersctl.ts`'s `drainThenFinish` → `bin/thinkers-drain.mjs` already uses — `src/responder.ts`'s `spawnPersonNotesWriter`/`defaultSpawnDetached` (`spawn(process.execPath, [RESPONDER_NOTES_SCRIPT, trajFile, idxFile, memDir, identityName, personKey, msgFrom], {detached:true, stdio:["ignore",logFd,logFd]}); child.unref()`), log path exactly `<identityDir>/run/logs/responder-notes.log` (`${IDENTITY_DIR:-.}` fallback when absent, matching the Bash unset-var default). The child rebuilds its own `LlmClient` via `steprun.ts`'s `buildLlmClient` from its INHERITED environment only (`opts.env`, defaulting to `process.env`) — never argv — so no API key ever appears in a process listing. A second, independent real bug surfaced fixing this: `steprun.ts`'s old `...(identity.execEnv?.["MEM_DIR"] ? {memDir:…} : {})` silently DROPPED `memDir` from `RunResponderOptions` whenever a caller's env skipped `resolveIdentityEnv` (which is the only thing that guarantees `MEM_DIR`, identity-env.ts:87) — `updatePersonNotes` then bailed silently (`if (!memDir) return`) after already paying for the LLM call. Fixed: `memDir` now defaults to the identity's own memories dir (`path.join(identityDir, "memories")`), matching what `MEM_DIR` always resolves to in production (not upstream's shared `/tmp`, which the port's identity-scoped default is strictly better than). | `test/monolith.test.ts` (6), `test/responder-integration.test.ts` (deferral + person-notes groups, 8 scenarios, + 3 new: spawn-seam asserts the exact detached call/log path and that the notes LLM is never touched in-process when SYNC is off, the `${IDENTITY_DIR:-.}` log-path fallback, a swallowed spawn failure); `test/responder-notes.test.ts` (new, 3 scenarios — spawns the REAL `bin/responder-notes.mjs` against a fake LLM HTTP server: first-write and update-in-place frontmatter byte-for-byte against step:343-392 (id/created/aliases preserved), a no-history no-op); `test/steprun.test.ts` (+2: the `MEM_DIR`-missing fallback, and a full `runStep` → real detached child → `type: person` memory end-to-end); differential `test_responder_deferral.sh`/`test_responder_person_notes.sh`: 14/14, 12/12 (no-port-cli, but both exercise `chat.mjs`/`traj.mjs` on PATH — a real differential for those) |
| 883339f | `thinkers/responder/step`: stamp `context_msgs`, `context_steps`, `gap_s`, `compose_ms`, `model` on every decision observation; `deploy/scripts/audel-metrics` reporting (not ported — deploy tooling, out of scope) | `src/responder.ts` (`computeGapSeconds`, the `withMetrics` stamping) | `test/responder-integration.test.ts` (metrics group, 5 scenarios); differential `test_responder_metrics.sh`: 17/17 |
| 67229dc | `bin/chat`: `chat history --thread <name>`, `chat thread-key`; `thinkers/responder/step`: unions the Slack thread's last day into the prompt as extra user turns (`thread_msgs` metric) | `src/personMemory.ts` (`threadKey`), `src/chat.ts` (`cmdThreadKey`, `--thread`), `src/responder.ts` (`buildConvoSel`'s `threadOnly` union) | `test/responder.test.ts` (buildConvoSel thread-union cases), `test/responder-integration.test.ts` (thread-context group, 2 scenarios); differential `test_responder_thread_context.sh`: 7/7 |
| 7258571 | design: conversation memory plan update (docs only) | none (docs) | n/a |

**Trajectory-contract fields added — flagged loudly, per this lane's method:**
every one of these is a NEW field the responder/monolith now write to the
on-disk trajectory (`observation`/`action`/`message` steps), matching NEW's
exact field names — not an invented extension:
- `observation` (source `responder`, decision `replied`/`no-reply`/
  `reply-failed`): `context_msgs`, `thread_msgs`, `context_steps`,
  `history_source` (`"index"`|`"window"`), `model`, `compose_ms`, `gap_s`
  (absent on first contact), and — only on a deferred reply —
  `deferred: true` + `request`.
- `action` (source `responder`, part 5 deferral): `trigger_step`, `person`,
  `request` (new step SHAPE, not just new fields on an existing type).
- `message` (source `chat`, `chat reply --follow-up`): `follow_up: true`.
- `observation` (source `monolith`, delivering a deferred request):
  `resolves: <trigger_step>` (read by `pendingRequestHint`, not written by
  the port's own code — the monolith's own `act` function would write it
  when the model follows the routing hint's instructions).

None of these are exercised by the golden traces (`golden/trace-00..05`,
recorded before this feature existed), so the characterization-test oracle
does not pin their exact shape — `test/responder-integration.test.ts` is the
oracle for them, cross-checked against the real upstream `thinkers/responder/
step`/`thinkers/monolith/step` via `parity/upstream-tests/run.mjs`'s five new
`no-port-cli` suites (all 5 at 100% against real NEW Bash + this port's
`chat.mjs`/`traj.mjs`).

**Real bugs found and fixed by this sync's own differential process** (not
pre-existing, not upstream's — surfaced because this lane exercises `chat.ts`
harder than any prior lane):
1. `src/chat.ts`'s `rootFile()` only ever resolved the trajectory via the
   `<hex8>-root` convention; real `traj append`/`traj path` (and thus real
   `chat send`/`reply`/`history --with`) also resolve a trajectory named by
   its literal `traj_id` with no `-root` suffix, or an exact path. Fixed by
   trying `resolveTrajFile()` (already implemented, already used by `traj`
   itself) first. See `parity/upstream-tests` `test_chat_history_index.sh`
   going from a hard crash to 29/29, and the five `no-port-cli` responder
   suites from 2/5/1/4 port-only-fails to 0.
2. `chat person-key`/`chat thread-key` print TWO trailing newlines in real
   Bash (`_person_key "$1"; echo` — the helper already ends in one, the bare
   `echo` after it adds a second); the port printed one.
3. `chat history --with`/`--thread` TEXT output (no `--json`) is
   JSON-string-quoted in real Bash (the jq call has no `-r`); the port
   printed raw unquoted text.
Both (2) and (3) found and fixed via `parity/chat/run-parity.mjs`'s 21 new
scenarios; see that harness's `report.md` for the byte-level before/after.

**PORT-BUG #68** (found characterizing a SUSPECT flagged alongside bug #67 —
`chat reply --reply-to` on a TRAJ_ID that doesn't resolve): upstream's
`_chat_append` (bin/chat:36-38) shells out to the real `traj append <id>`
binary UNGUARDED — no `2>/dev/null`, no `|| true`, unlike every READ path
(`traj cat`) `chat` also uses — so when `${ROOT_TRAJ_ID:-$TRAJ_ID}` doesn't
resolve to an EXISTING trajectory, `traj`'s own `require_traj_file` (bin/
traj:204-205) dies with `traj: error: append: cannot resolve traj_id '<id>'
in '<dir>'` (rc 1, no stdout, nothing written), and that death propagates
straight out of `chat reply`/`chat send`. `src/chat.ts`'s `appendStep` used
to reuse the (correctly lenient, READ-appropriate) `rootFile()` helper for
writes too; its `resolveTrajFile() ?? rootTrajFile()` fallback silently
manufactured a brand-new `<hex8>-root/trajectory.jsonl` for the bogus id
(`coreAppend`'s own `mkdir -p`) and reported "Reply sent." at exit 0 instead
of refusing — proven live against the real Bash oracle (`tools/identity new
hold` / `bin/identity.mjs new hold`, both with a real `CHATRC`/`MEM_DIR`/
`TRAJ_DIR` env, `chat reply --reply-to not-a-uuid you x`): a `TRAJ_ID` set to
a nonexistent id, and separately to a bare non-UUID directory-shaped name,
both made the port silently create a NEW `<hex8>-root` trajectory directory
and succeed, while upstream refused byte-identically for both forms
(`traj: error: append: cannot resolve traj_id '<id>' in '<dir>'`, rc 1, zero
new directories). `--reply-to`'s VALUE itself is unaffected by this bug —
upstream never validates it either (it's an opaque stamped field, never
resolved as a traj id; confirmed live: `--reply-to not-a-uuid` sends
normally, `reply_to:"not-a-uuid"` stamped verbatim, on both sides). Fixed:
`appendStep` now resolves `TRAJ_DIR`+`rootId(io)` strictly via
`resolveTrajFile` alone and reproduces `traj`'s exact death text through a
new `dieRaw()` (prints verbatim, no `chat: error:` wrap — this text is a
DIFFERENT subprocess's own die() in the real pipeline); `rootFile()` keeps
its lenient fallback for the READ path only (`history`/`pending`/the
duplicate-answer guard), matching `traj cat`'s own `2>/dev/null` swallow.
`test/chat.test.ts` "chat reply — TRAJ_ID resolution (BUG #68, bin/traj:
204-205 require_traj_file)" (nonexistent id, bare directory-shaped name,
plus a regression case confirming the correct root id still sends normally)
and the `--reply-to`-is-unvalidated characterization case in the "chat
reply" describe block above it.

### 3+5. LLM + shellm (triage lanes 3 and 5)

Lanes 3 and 5 of `UPSTREAM-TRIAGE.md` (LLM Provider Features, Shellm Core &
Docker), carrying the llm + shellm behavior deltas between the OLD-pinned
oracle (`ed2dac6`) and the NEW upstream base (`7d29f9e`) into this port.
Method per commit: add/extend a parity or unit scenario grounded in a real
run of NEW upstream Bash first, confirm it flags the delta against the port
pre-fix, port the delta, re-verify 0 port bugs against NEW and no regression
against OLD.

| SHA | What changed (upstream) | Port change | Proof |
|---|---|---|---|
| `015d081` | `llm`: `--or-only`/`--or-data-collection`/`--or-zdr` flags + matching `LLM_OR_*` env defaults; `build_payload_openrouter` gains a `provider` block (only/data_collection/zdr), normalized once, warn-and-clear on a non-openrouter provider, stderr-announced when the effective routing came from the environment | `src/llmCli.ts` (flag parsing, normalization, warn/clear/announce logic) + `src/llmProvider.ts` `buildOpenRouterProviderBlock` (pure, null no-op when unpinned) | `test/llmCli.test.ts` "OpenRouter provider routing" (17 cases); `--help` byte-identical to real upstream; `parity/llm/run-parity.mjs` `or-routing` group (25 scenarios mirroring `tests/test_llm_openrouter_routing.sh` 1:1) — 25/25 PARITY vs real NEW `bin/llm`, harness-wide 248/248 effective, 0 port bugs; gated on a `--help` feature probe so the group is skipped (not counted as bugs) against the OLD-pinned checkout, which lacks the flags entirely |
| `cf9e0ab` | tightens `tests/test_llm_openrouter_routing.sh`'s own assertions (`==` instead of `!=` on `has("provider")`, trims a trailing space in a `run_llm --` call) — test-only, no `bin/llm` behavior change | none needed (assertion tightening only; the port's behavior already satisfies the tightened form, proven by the same `or-routing` parity group above) | same proof as `015d081` |
| `8ba520b` | `bin/shellm`'s `call_llm`: stopped treating "no stdout + non-empty stderr" as a failure — `llm --thinking` streams reasoning to stderr, and a call that spends its whole budget there returns exit 0 with empty stdout, which is exactly what `run_loop`'s empty-response retry (pre-existing, 2026-04-26) needs; the added guard (2026-06-01) made that retry unreachable | this port's `runShellm` (`src/shellm.ts`) never shells out to `bin/llm` — `LlmClient.complete()` is called in-process — so there was no stderr-guard to remove; the applicable gap was that `runShellm` never retried an empty `resp.text` at ALL, falling straight into the NO-BLOCK/final path with empty content. Fixed by the retry loop added for `136f32b` below (the two upstream commits land as one port change, since the port has no intermediate broken-guard state to reproduce) | `tests/test_shellm_empty_response_retry.sh` run directly against NEW upstream `headlong-upstream-main` (14/14 pass) to ground the design; `test/shellm.test.ts` "runShellm: empty-response retry" (visible text unaffected; a real thrown failure still fails; empty+reasoning retries with feedback; empty+no-reasoning retries silently) |
| `136f32b` | `bin/shellm`/`bin/llm` fast-follows: messages travel via `--messages-file`/file, not argv (128KB `ARG_MAX` risk); fed-back thinking goes through `jq --rawfile`, not `--arg`; `SHELLM_EMPTY_RESPONSE_RETRIES` defaults to 8 (was unlimited), set empty for unlimited; the feedback branch paces retries with the same `sleep 1` as the no-thinking branch; `llm`'s own `"llm: warning: …"/"llm: note: …"` stderr lines are filtered out of the fed-back thinking before it becomes assistant content | `LlmResponse` gains an optional `reasoning` field (OpenRouter's `message.reasoning`, extracted by new `extractReasoningOpenAI` in `src/llmProvider.ts`, wired into `OpenRouterClient.complete`) — used ONLY for retry feedback, never the trajectory's `reasoning` field (still `extractReasoning(text)`). `ShellmConstants.emptyResponseRetries` (default 8; `constantsFromEnv` reproduces the bare `${VAR-8}` — default ONLY when unset, explicitly-empty stays unlimited, unlike every other knob there). `runShellm`'s retry loop: `filterLlmNoiseLines` strips `^llm: (warning\|note): ` lines from the reasoning before feeding it back; a 1s `sleep` (injectable) paces every retry; exhausting the cap appends an `error` step (`truncateOutput`-shaped detail, matching `bin/shellm:302-314` byte-for-byte incl. the trailing-newline/command-substitution-strip quirk) and returns a new `StopReason` `"empty-response"`, treated as errored by `monolith.ts` for backoff purposes, same as `"stall"`/`"max-iter"`. `--messages-file F` also added to `bin/llm` (trailing newlines stripped, same as `--system-prompt-file`) — the port's messages already travel as one in-process JS array with no argv/`ARG_MAX` exposure for `runShellm` itself, but the flag is a real `llm` CLI addition independent of that | `tests/test_shellm_retry_feedback.sh` run directly against NEW upstream (8/8 pass) to ground the design; `test/shellm.test.ts` (constantsFromEnv default/empty/numeric cases, `filterLlmNoiseLines`, `truncateOutput`, the retry loop's feedback/cap/unlimited cases — 22 new cases total); `test/llmCli.test.ts` `--messages-file` case; `parity/llm/run-parity.mjs` 3 new `args/messages-file-*` scenarios, gated the same way as `or-routing` — 248/248 effective vs NEW, 0 port bugs |
| `0925168` | `bin/shellm`: a running named env is only reusable for the Docker image it was built from (`env_metadata_matches` now compares the stored image; a resume inherits the trajectory's image unless the caller explicitly chose one; a running env skipped on an image mismatch says so) | **PORTED (bug #32).** The earlier "N/A to this port's architecture" verdict here was wrong: it was N/A only because `src/sandbox-runtime.ts` didn't yet reuse containers at all (a separate port bug, #32, fixed in the same lane that revisited this row) — once reuse exists, this commit's hazard is real and needed porting. `src/sandbox-env.ts`'s `envMetadataMatches`/`envMetadataMismatchMessage` compare the stored vs. requested Docker image before any reattach and throw upstream's exact `die()` message on a mismatch; metadata lives at `<identityDir>/.shellm/envs/<name>/image` (this port's `SHELLM_ENVS_DIR`, tools/identity:375). Env resolution here is always "explicit" in upstream's own terms (every thinker wake passes a concrete identity name, never the anonymous auto-generated case), so a mismatch always refuses rather than silently skipping — matching `env_resolve`'s `explicit=1` branch, not its `explicit=0` one. No `--docker-image` explicit-vs-default distinction or standalone `shellm` CLI exist, and none are needed for this commit's actual hazard | `test/sandbox-env.test.ts` "image mismatch refuses reuse with upstream's exact message (0925168)" (real docker, skips cleanly without a daemon) asserts the literal message string; `tests/test_env_image_identity.sh` run directly against NEW upstream (12/12 pass, unchanged) documents the behavior being matched — not run differentially (no standalone `shellm` CLI to diff against), matched by direct message-string comparison in the port's own test instead; `parity/upstream-tests/run.mjs` entry (bash-artifact class) unchanged |
| `30561e9` | `thinkers/_lib/common.sh` `_build_shellm_flags`: forwards `CHATRC` (`--var CHATRC=…`) into generated-code Docker runs; adds `focus`/`recap` to the `--bin`-mounted tool list, which had silently disappeared only inside Docker | **CHATRC half: ported.** `src/steprun.ts`'s `buildIdentityConfig` now forwards `env["CHATRC"]` into the wake's `execEnv`, same as `MEM_DIR`/`SKILLS_DIR` — without it a mid-wake `chat send` fell back to `./.chatrc` relative to the step's workdir instead of the identity's own sender config, on BOTH local and Docker sandboxes (this port's exec-env path is unconditional, not Docker-only like upstream's). **Tool-list half: N/A**, already closed by design — this port's sandbox mounts the WHOLE checkout read-only (`src/sandbox-runtime.ts`, see the pre-existing "Sandbox bind-mount scope" note in Scope/known gaps above), so every `bin/` tool including `focus`/`recap` was already reachable before this lane; there is no per-tool `--bin` list to have a gap in | `test/steprun.test.ts` "monolith: CHATRC reaches the sandboxed exec env" — fails on the pre-fix code (`CHATRC=` empty reaches the sandboxed shell) and passes after; `tests/test_thinker_tool_coupling.sh` run directly against NEW upstream (14/14 pass) to confirm the tool-list claim reads correctly, `parity/upstream-tests/run.mjs` entry explains the no-port-cli classification |

Whole-repo suite after this lane: `DOCKER_CONTEXT=colima pnpm vitest run` — **1333 passed / 4 skipped** (was 1259 before this lane), tsc clean. `parity/llm/run-parity.mjs`: 248/248 effective vs real NEW `headlong-upstream-main/bin/llm` (230 identical + 18 documented deviations, 0 port bugs); against the OLD-pinned `headlong/bin/llm` the harness stays runnable (feature-gated new scenarios skip cleanly) and every pre-existing scenario is unaffected, modulo `--help` text now honestly reflecting the two new upstream flag sets (3 expected mismatches there against OLD, resolved now that the pin is `7d29f9e` — not real bugs). `parity/upstream-tests/run.mjs` gains 5 suite entries for this lane (`test_llm_openrouter_routing.sh` portable — 14 port-only-fails, all the same curl-stub TEST-METHODOLOGY MISMATCH already documented for `test_llm_openai_compatible.sh`, classified not a port bug; the 4 shellm suites are bash-artifact/no-port-cli, run against real upstream Bash on both sides for the record, with the port's actual equivalent behavior proven by the vitest suites cited per-commit above).

### 4. Web UI (triage lane 4)

Commits `d5945c0`, `6412f5d`, `f06bb50`, `bc2b640`, `eef1105`, `b50cd84`.
This lane's slice is `web/viewer` (React viewer, vendored verbatim) plus
anything under `web/` its new features needed from the TS server.

| Lane | Commits | What | Result |
| --- | --- | --- | --- |
| web-ui | `d5945c0`, `6412f5d`, `f06bb50`, `bc2b640` | Timeline deeplinks: `?step=`/`?run=` URL params drive the detail modal (open/scroll/pulse), copy-link builds the URL by hand for substeps; `web/viewer/vitest.config.ts` + `timeline-view.test.tsx` added upstream | Ported verbatim into `web/viewer/app/components/timeline-view.tsx`, `timeline-detail.tsx`, `mindlog-search.tsx`, `app.css`. No server.py / API changes in this range — deeplinks are pure client-side `URLSearchParams`, nothing for `web/server` to expose. |
| web-ui | `eef1105`, `b50cd84` | Chat composer: Shift+Enter inserts a newline, Enter sends; new `use-autosize-textarea` hook; `ui/textarea.tsx`; desktop/phone fix (`b50cd84`) | Ported verbatim into `web/viewer/app/routes/chat.tsx`, `talk-chat.tsx`, `app/hooks/use-autosize-textarea.ts`, `app/components/ui/textarea.tsx`, plus upstream's new `chat.test.tsx` / `talk-chat.test.tsx`. |

Residual `diff -r` against NEW (`headlong-upstream-main/web/viewer`) after
the sync: only the two deliberate port edits documented in `web/README.md`'s
Provenance section — `viewer/vite.config.ts` (dev `/api` proxy + build-only
react-dom/server alias guard) and `viewer/package.json` (npm `test` script +
`overrides` block for npm-vs-bun installs; upstream's own dependency/devDependency
additions — `@testing-library/dom`, `@testing-library/react`, `jsdom`,
`vitest`, `test: vitest run` — are all carried over unchanged).

Root `vitest.config.ts` gained `exclude: [...defaultExclude, "web/viewer/**"]`:
the viewer's new tests use its own `~/...` tsconfig-paths alias, resolved by
`web/viewer/vitest.config.ts`'s `vite-tsconfig-paths` plugin, which the root
sweep doesn't have. Viewer tests run via `cd web/viewer && npm test`, not the
root suite; this keeps the root suite's file count/behavior unchanged.

Verified (at merge): `npm run typecheck`, `npm test` (17/17, 3 files —
deeplink, chat-composer, talk-chat-composer), and `npm run build` all pass in
`web/viewer`. `web/server`'s `tsc --noEmit` had one transient unrelated error
at merge time (`control.ts` / `LlmIO.spawnAdapter`/`randomToken`, from
another lane's in-flight work) — hotfixed on `main` directly the same day
(`control.ts` reuses `spawnAdapterProcess` + a crypto token); both root and
`web/server` `tsc --noEmit` are clean as of this pin bump. `web/server`'s own
`vitest run` was 119 passed / 4 skipped at merge (now 211 passed / 4 skipped,
see the whole-repo count in the header above).

### Not carried, by decision

- **macOS app** (triage lane 6: Shellm.app native improvements — `a2200ac`,
  `c0fa0ff`, `fa2e45c`) — Swift/OTHER-LANG, out of this port's Bash/Python →
  TypeScript scope; `macos/` not vendored, not reimplemented. See "Scope and
  known gaps" above.
- **`deploy/`** (triage lane 8: audel-stash enhancements — `230f0f1`,
  `7d29f9e`; the lane's final commit happens to be the exact SHA this port's
  pin now tracks, i.e. the tip of upstream `main` at triage time — it is
  still deploy-tooling content, not ported, and pinning to it is unrelated
  to porting it) — deployment/infrastructure tooling, not required for a
  reference port; not ported. See "Scope and known gaps" above.
- **Docs-only commits** (triage lane 7: README & Skills Docs — README
  polish, local-models documentation, chat-skill Shellm.app formatting) — no
  executable change, so no port action; where a doc change is user-facing
  and applies to this port (upstream's new README "Local models" section),
  it is carried into this port's own README.md/PORTING.md/SPEC.md as part of
  this pin-bump docs pass instead of being tracked as a lane. The two
  conversation-memory design docs upstream also files under this lane
  (`f8a7ef0`, `7258571`) are already accounted for in lane 2's table above
  (docs only, no port change).

## Open questions for humans
- (closed 2026-10-29) The live `skills prompt` / identity-prompt render was
  already wired per wake (`runStep` → `buildIdentityConfig`); the last static
  blob, in the manual `scripts/real-wake.ts`, now uses the same path.

## Cutover
- [x] Core cognition substrate at parity (dispatcher, thinkers, trajectory, wake loop)
- [x] mem / skills / rollups shipped and at parity (differential proofs under `parity/`)
- [x] Live `skills prompt` / identity-prompt rendering into the per-wake system prompt (`runStep` → `buildIdentityConfig` each wake; behavioral parity 43/48, 0 DIVERGE)
- N/A: this is a reference oracle, not a system that replaces the Bash in production.

### steprun LLM_API_URL fix (bug #39, this lane)

**The bug**: `src/steprun.ts`'s `buildLlmClient` passed
`LLM_API_URL ?? SHELLM_API_URL ?? "https://openrouter.ai/api/v1"` as
`OpenRouterConfig.baseUrl`, and `src/llm.ts`'s `OpenRouterClient.complete()`
always appends `/chat/completions` to `baseUrl`. Upstream `bin/llm`
(`get_url_headers`'s openrouter case, `bin/llm:765`:
`url="${LLM_API_URL:-https://openrouter.ai/api/v1/chat/completions}"`) and
this port's own `src/llmCli.ts:1642-1650` both treat `LLM_API_URL` as the
FULL request URL for a keyed provider, never a base one more path is
appended to. A custom endpoint (e.g.
`http://localhost:11434/v1/chat/completions` for Ollama) therefore 404'd on
every daemon wake with a doubled `.../chat/completions/chat/completions`
suffix — first surfaced as a real-run finding by `parity/live/fault-proxy.mjs`'s
`normalizeDoubledChatCompletionsSuffix` (a harness-side accommodation, not a
fix; see its doc comment and `test/live-fault-proxy.test.ts`). The
`SHELLM_API_URL` fallback was also wrong for this provider: upstream reads
`SHELLM_API_URL` only as a fallback for the keyless `openai-compatible`
provider (`bin/llm:783-787`, "keyed providers' URLs stay LLM_API_URL-only");
openrouter is keyed (`OPENROUTER_API_KEY`).

**Fixed**: `OpenRouterConfig` (src/llm.ts) gains an optional `url` field —
the full endpoint, used verbatim when set, matching upstream/`llmCli.ts`
semantics; `baseUrl` remains the default-only base that `/chat/completions`
is appended to when `url` is absent. `buildLlmClient` (src/steprun.ts) now
passes `env["LLM_API_URL"]` as `url` (not `baseUrl`) when set, and no longer
reads `SHELLM_API_URL` for this call.

**Tests**: `test/steprun.test.ts` "steprun: buildLlmClient > LLM_API_URL is
used as the full endpoint, not a base with /chat/completions appended" —
starts a local HTTP server, sets `LLM_API_URL` to its full
`/v1/chat/completions` URL, runs `buildLlmClient`+`OpenRouterClient.complete`,
and asserts the request lands on exactly that path (fails on the pre-fix
code with a doubled suffix, passes after the fix).

### OpenRouterClient.complete() had no LLM_RETRIES ladder — RESOLVED (bug #53)

**The bug**: monolith/responder wakes call the model in-process through
`src/llm.ts`'s `OpenRouterClient.complete()` (`src/steprun.ts`
`buildLlmClient`, used by both `src/steprun.ts`/`src/shellm.ts` for the
monolith and `src/responder.ts` for the responder). It made exactly one HTTP
call and threw on any non-2xx status or embedded 2xx failure, with no retry
at all. Upstream `bin/llm` (`bin/llm:92-93,1351-1352` `_max_attempts =
LLM_RETRIES + 1`, default `LLM_RETRIES=2` → 3 attempts,
`LLM_RETRY_BACKOFF=1` linear backoff) retries a transient failure on both its
streaming (`bin/llm:1365-1423`) and non-streaming (`bin/llm:1424-1475`)
paths: HTTP `000`/`408`/`429`/`5xx`, and a 2xx whose body is whitespace-only
or carries an embedded provider error (`.error.message`,
`.choices[0].error.message`, `finish_reason:"error"` — non-streaming;
"nothing emitted" on the SSE path), printing `llm: transient API failure
(attempt N/M): <reason> — retrying` to stderr each time and, once exhausted,
`llm: error: API error (HTTP <code>)[: <message>]` (or `API error: <embedded
message>`), exit 1. A director-verified replay against upstream (bug #53)
showed the provider returning nothing for the responder's first reply;
upstream retried and got a real reply, while the port's un-retried
`OpenRouterClient.complete()` returned `text:""` immediately, and
`src/responder.ts` appended a "reply failed" observation instead —
trajectories diverge from there. (`src/llm.ts`'s existing "empty-response
retry" in `src/shellm.ts`, bin/shellm:2423-2477, is a DIFFERENT, higher-level
concept — feeding a `--thinking` model's captured reasoning back when it
spent its whole budget there — and is not equivalent to this ladder.)

**Fixed**: `OpenRouterClient.complete()` (`src/llm.ts`) now runs the SAME
ladder as `llm`'s own non-streaming path (`src/llmCli.ts`'s
`runNonStreaming`, the port's non-streaming wire shape) — same conditions,
same attempt count, same linear backoff, same stderr line, same terminal
error text — built from the SAME `src/llmProvider.ts` primitives
`runNonStreaming` uses (`checkResponseOpenAI`, `responseShapeErrorOpenAI`,
`errorMessageOf`, `parseJson`, `usageOpenAI`) rather than duplicating
`llmCli.ts`. `OpenRouterConfig` gains `retries`/`retryBackoffS` (defaults 2/1,
bin/llm's own defaults) plus test seams `stderr`/`sleep` (default: the real
process stream / a real timer — the retry line lands in a wake's
`run/logs/<thinker>.log` the same way `REAL_WAKE_IO.stderr` does).
`src/steprun.ts`'s `buildLlmClient` translates `LLM_RETRIES`/
`LLM_RETRY_BACKOFF` from the resolved identity env into those fields,
reproducing bin/llm:1351's exact validation (`LLM_RETRIES` unset → 2; set to
a non-digit-string → 0, NOT the default). `src/responder.ts`'s single
`opts.llm.complete()` call is now wrapped in a `try/catch`: a terminal throw
(retries exhausted, or a non-retryable status) is treated the same as a
visible-but-empty model response — it already fell to the existing
"reply failed — appending failure observation" branch (step:171-173), so no
new observation text was needed. `src/llmCli.ts` is unchanged (it already
carries this ladder; only the primitives are shared).

**Tests**: `test/llmRetry.test.ts` (new) — `OpenRouterClient.complete()`
against `test/llmFakeServer.ts`: (a) a whitespace-only 200 (nothing
emitted) then a good one — one retry, success, exact stderr line; (b) 429
then 200 — one retry, success; (c) 500×3 (default `LLM_RETRIES=2`) — terminal
error `API error (HTTP 500): upstream exploded`, exact stderr lines,
3 requests; (d) `retries:0` — a single failed attempt is never retried, 1
request. Plus two `runResponder` integration cases: whitespace-then-good →
`decision:"replied"`, no reply-failed observation, 2 requests; 500×3
exhausted → `decision:"reply-failed"` (not a crash), terminal stderr line
captured, 3 requests. Full suite (`DOCKER_CONTEXT=colima npx vitest run`)
green, no test loosened.

### shellm-run `command` field was a fixed template, not the real argv — RESOLVED (bug #63)

**The bug**: the port's recorded `command` field on the `shellm-run` trajectory
step (`src/monolith.ts`'s `synthCommand()`, called from `runMonolithWake`) was
a hardcoded template string. It omitted `--context-scope run` and the
`--var MEM_DIR=…`/`SKILLS_DIR=…`/`SKILLS_KERNEL_DIR=…`/`CHATRC=…` flags
entirely, and its `--bin` list was stale — always listing `mem traj skills
context llm shellm chat recap` regardless of what this port actually ships
(it has no standalone `shellm` CLI at all — `src/shellm.ts`'s `runShellm` is
an in-process function, not a binary — so `--bin shellm` described a tool
that doesn't exist here). Upstream records `_redacted_cmdline "$@"`
(`bin/shellm:3035-3051`) of the REAL argv the monolith caller builds:
`--model … --traj … --context-scope run` (`thinkers/monolith/step:401-404`)
plus `thinkers/_lib/common.sh:590-700`'s `_export_provider_keys`/
`_export_skill_vars`/`_build_shellm_flags` output (`--env`, `--workdir`, then
`--var` in construction order: `IDENTITY_NAME`, `MEM_DIR`, `SKILLS_DIR`,
`SKILLS_KERNEL_DIR`, `TRAJ_DIR`, `TRAJ_ID`, `CHATRC`, then `SHELLM_MODEL`/
`LLM_PROVIDER` when set, then each set provider API key as a bare `--var
NAME` (value never touches argv), then each skill-declared `env:` var the
same bare way, then a `--bin <path>` per tool actually found via `command -v`)
plus `--prompt-file`.

**Fixed**: `synthCommand()` (`src/monolith.ts:943`) now builds that same argv
array from `IdentityConfig` (`execEnv`'s `MEM_DIR`/`SKILLS_DIR`/`CHATRC`/
`SHELLM_MODEL`/`LLM_PROVIDER`/provider-key entries, `skillVarMounts` for the
sorted bare skill vars, `binDir` probed per tool with `fs.existsSync` in place
of `command -v` — naturally dropping `shellm`, which this port never
installs there) and a new `hostEnv` parameter (the same ambient
`RunMonolithWakeOptions.env` `lifeContextSection` already reads, for
`SKILLS_KERNEL_DIR` — the one value `IdentityConfig` doesn't otherwise carry).
A new `absPath()` helper mirrors `_abs_path` (`thinkers/_lib/common.sh:614-
617`, `cd DIR && pwd`) — **logical**, not `fs.realpathSync`: bash's default
`cd`/`pwd` do NOT dereference symlink path components (verified directly:
`cd /a/symlink && pwd` prints `/a/symlink`, not its target — `fs.realpathSync`
would have over-resolved macOS's `/var` → `/private/var` relative to what
bash actually records). The finished argv is passed through
`redactedCmdline`/`shellmPrivateVarName` (`src/shellm.ts`) — giving those two
functions (ported byte-faithfully in the 1c lane-A sync but never wired to a
caller, per the "callout (c)" entry above) their first real caller.

**Tests**: `test/monolith.test.ts` "synthCommand / shellm-run command field
(bug #63)" — a fixture identity (skill declaring an `env:` var, a toolbin
with only the 7 tools this port ships) asserts the recorded `command` matches
byte-for-byte a hand-built expected string, and that no provider-key/skill-
var VALUE or a `--bin …/shellm` entry ever appears. A second, oracle-gated
describe (`PARITY_UPSTREAM_ROOT`) sources the REAL
`thinkers/_lib/common.sh` + extracts `_build_shellm_flags`/
`_redacted_cmdline`/`_shellm_private_var_name` straight from `bin/shellm`
(without executing its unconditional `main "$@"`) against the identical
fixture and asserts the port's `command` is **byte-identical** to the real
Bash output (verified locally against `headlong-upstream-main@5458fee`, both
sides pointed at the same on-disk fixture paths so no path-normalization
step was even needed — only the inherently non-reproducible `--prompt-file`
temp path is held to the port's existing `<monolith_prompt>` placeholder on
both sides).

**Gate**: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green (the
`PARITY_UPSTREAM_ROOT`-gated oracle test skips cleanly when that env var is
unset, same discipline as every other Bash-oracle test in this suite —
`test/traj-concurrent-append.test.ts`, `test/recap-concurrent-lock.test.ts`).

### shellm-run `workdir` leaf was `${process.pid}`, not `$run_name` — RESOLVED (bug #64)

**The bug**: `src/steprun.ts`'s `buildIdentityConfig` (the shared assembly
point every thinker wake calls) computed the workdir as
`<SHELLM_WORKDIRS_DIR>/<process.pid>` — a per-PROCESS token that appears
nowhere in upstream's own workdir-naming scheme and is also recorded
verbatim on the shellm-run step's `workdir` field (`src/monolith.ts`'s
`execEnv`/header construction already threads `id.workdir` straight through).
Upstream's leaf is `$run_name` (`bin/shellm:2176-2178,2208,2232`): for the
"existing/resumed trajectory" path — the ONLY path this port's every wake
takes (`--traj $TRAJ_ID`, never the "new trajectory" branch) —
`run_name=$(basename "$(dirname "$_traj_file")")`, the trajectory's OWN
directory name; the fallback default (absent an explicit `--workdir`
override) is `workdir="$SHELLM_WORKDIRS_DIR/$run_name"`.

**Fixed**: `buildIdentityConfig` (`src/steprun.ts:82-107`) now resolves
`TRAJ_ID` to its trajectory file the SAME way the engine itself does
(`resolveTrajFile`, falling back to `rootTrajFile`'s canonical `<hex8>-root`
shape when the file doesn't exist yet) and takes `path.basename(path.dirname(
…))` as the workdir leaf — this port's `createTrajectory` (`trajCore.mjs`)
always writes the root trajectory at `<TRAJ_DIR>/<hex8>-root/trajectory.jsonl`,
so in practice the leaf is `<hex8>-root`. Only the leaf changed —
`SHELLM_WORKDIRS_DIR` (or its `<identityDir>/.shellm/workdirs` default)
stays the base, matching upstream's own `$SHELLM_WORKDIRS_DIR/$run_name`
split exactly.

**Tests**: `test/steprun.test.ts` "buildIdentityConfig: workdir leaf … (bug
#64)" — asserts the leaf is `<hex8>-root` (not `process.pid`) and that the
directory is actually created on disk, plus a `SHELLM_WORKDIRS_DIR`-base
case. An oracle-gated describe (`PARITY_UPSTREAM_ROOT`) runs the REAL
`bin/traj show` against the same fixture trajectory and asserts
`basename(dirname(File:))` — upstream's own `run_name` derivation,
`bin/shellm:2176-2178` — equals the port's computed leaf (verified locally
against `headlong-upstream-main@5458fee`).

**Gate**: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green (the
`PARITY_UPSTREAM_ROOT`-gated oracle test skips cleanly when that env var is
unset, same discipline as every other Bash-oracle test in this suite).
### OpenRouterClient.complete() didn't retry a clean-but-empty completion — RESOLVED (bug #53b)

**The bug**: bug #53's ladder above ported the transient-HTTP-code and
embedded-JSON-error conditions, but missed a THIRD upstream condition:
`bin/llm`'s streaming path also retries a clean (`rc 0`, no curl error) pass
that emitted nothing at all (`bin/llm:1400-1421`) — `mark_emitted` (bin/llm:167)
fires only on a non-empty `.choices[0].delta.content` chunk for the OpenAI
family (`stream_openai`, bin/llm:1111-1160 never reads a reasoning delta at
all, unlike `stream_anthropic`'s thinking-or-text `mark_emitted`), so a
provider that streams a full chain-of-thought and finishes with an empty
answer counts as "nothing emitted" and gets `_retry_msg="empty response:
stream ended without emitting anything"` (bin/llm:1411), the SAME
`llm: transient API failure (attempt N/M): … — retrying` stderr line and
backoff as the other conditions, and on exhaustion `die "$_retry_msg"`
VERBATIM — no `API error:` prefix, unlike every other terminal message on
this path. A director-verified deterministic replay (tape
`record-20260906-183849`, `parity/replay/run-replay.mjs`) reproduced this
exactly: the responder's first reply got a real 2xx with a full reasoning
trace and an empty answer; upstream retried once and got a real reply
(`Reply sent.`), while the port's un-retried `OpenRouterClient.complete()`
read the embedded-error checks as sound (no `.error`, no `finish_reason:
"error"`) and returned `text:""`, so `src/responder.ts` appended a
"reply failed" observation instead — trajectories diverge from there.

**Fixed**: `OpenRouterClient.complete()` (`src/llm.ts`) now checks, on the
SAME non-streaming wire path bug #53 already covers, whenever a 2xx body
parses as JSON with no embedded failure: if `.choices[0].message.content` is
empty or absent — regardless of any `.choices[0].message.reasoning` riding
alongside it — it's the non-streaming equivalent of "stream ended without
emitting anything" (`extractTextOpenAI`, already used for the successful
return path, is reused for the check). Same attempt counter/`maxAttempts`,
same linear backoff, same `llm: transient API failure (attempt N/M): … —
retrying` stderr line; on exhaustion the thrown message is the literal
`empty response: stream ended without emitting anything`, with NO `API
error:` prefix — matching `die "$_retry_msg"` byte-for-byte, distinct from
this same function's OTHER terminal messages (`API error: …`) one line
above it.

**Tests**: `test/llmRetry.test.ts`'s new "bug #53b" describe block —
(a) sound 200, empty `content`, then a good one: one retry, success, exact
stderr line; (b) `content` missing entirely (vs. present-and-empty): same;
(c) empty ×3 (default `LLM_RETRIES=2`): terminal error text
`empty response: stream ended without emitting anything` with NO `API
error:` prefix, exact stderr lines, 3 requests; (d) `content` empty but
`reasoning` non-empty ("reasoning-only"): still retries — proves reasoning
text never counts as emitted, matching `stream_openai` never reading a
reasoning delta. Plus a `runResponder` integration case: empty-content-then-
good → `decision:"replied"`, no reply-failed observation, 2 requests. Full
suite (`DOCKER_CONTEXT=colima npx vitest run`) green, no test loosened.
**Tape gate**: `parity/replay/run-replay.mjs` replay of tape
`record-20260906-183849` — port `run/logs/responder.log`'s first reply now
shows the same retry line and `Reply sent.` as upstream's; see the replay
report for the full alignment/PORT-BUG-candidate count.

## bin/*.mjs stdout truncation on process.exit() before drain — RESOLVED (bug #40)

| Where | Missing / stubbed | Impact | Target |
|---|---|---|---|
| `bin/chat.mjs`, `bin/context.mjs`, `bin/focus.mjs`, `bin/glob.mjs`, `bin/identity.mjs`, `bin/mem.mjs`, `bin/put.mjs`, `bin/recap.mjs`, `bin/retrieval-step.mjs`, `bin/skills.mjs`, `bin/sub.mjs`, `bin/thinker-step.mjs`, `bin/traj.mjs`, `bin/view.mjs` — **RESOLVED** | Each of these 14 entry points called `process.exit(code)` immediately after producing stdout/stderr, with no drain. On a piped, non-TTY stdout, Node's writes are asynchronous with a small OS pipe buffer (65,536 bytes observed on macOS); `process.exit()` tears the process down before a queued remainder flushes, silently truncating any single tool's output past that boundary (confirmed: `view` on a 266,676-byte file emitted exactly 65,536 bytes piped, full output un-piped). `bin/llm.mjs` already carried the fix (`await new Promise(r => process.stdout.write("", r))` for both streams before `process.exit`); it had never been propagated to the other 14 shims — see `parity/fuzz/findings/view-1.md` for the original finding (10 of the 14 confirmed there; `identity`/`skills`/`retrieval-step`/`thinker-step` share the same `process.exit(run…)` pattern and were fixed in the same lane) | fixed: `src/exitAfterDrain.ts` centralizes `bin/llm.mjs`'s drain-before-exit pattern as `exitAfterDrain(code)`; all 14 entry points now `await exitAfterDrain(...)` instead of a bare `process.exit(...)` (`bin/identity.mjs` additionally made its internal `die()` helper async and awaited at every call site, since it has multiple exit points, one of which — `identity export -o -` — streams a potentially large tar archive to stdout). Exit codes unchanged | test/stdout-drain.test.ts (spawns `view`/`context`/`traj` as real child processes with a piped, non-TTY stdout producing >200 KB of output; fails at exactly 65,536 bytes on the pre-fix code, passes after); `parity/fuzz` re-run for `view` (`--tool view --count 300`) shows no recurrence of the `view-1` truncation finding — the only remaining `view` DIVERGE findings (`view-14`..`view-18`) are the separate, pre-existing `offset-limit` bug (see `view-13.md`), not this one |

### identity bare-invocation usage-banner fix (bug #41, fix-fuzz-small lane)
**The bug**: `bin/identity.mjs` shifted `argv[0]` into `cmd` and dispatched
`if (cmd !== "new") die(...)` as its final fallback, so a bare `identity`
invocation (argv=[], `cmd === undefined`) fell into that fallback and printed
`new`'s OWN missing-`<name>` usage error (wrong text, exit 1). Upstream
`tools/identity`'s `main()` treats an absent command as its own dispatch
case: `local cmd="${1:-}"` then `case "$cmd" in ... "") usage ;; ...`
(tools/identity:1580-1581, :1621-1622) — printing the full top-level usage
banner (`usage()`, tools/identity:1508-1543) to stdout and exiting 0. This
was 84 of identity's 600-iteration fuzz findings (`parity/fuzz/findings/identity-1.md`)
— fully deterministic, one root cause.
**Fixed**: `bin/identity.mjs` now special-cases `cmd === undefined` before
the `new`-fallback check, writing the exact upstream banner to stdout and
exiting 0.
**Tests**: `test/identity-usage.test.ts` — spawns `bin/identity.mjs` with no
argv and asserts stdout equals the banner captured directly from
`IDENTITY_DIR=/tmp/idtest/ids <HEADLONG_ROOT>/tools/identity` (empty argv),
exit 0 (fails on the pre-fix code with exit 1 and the wrong message).

### skills --dir/dedup: absolute --dir vs implicit .skills/ symlink-resolution asymmetry (bug #42, fix-fuzz-small lane)
**The bug**: `src/skills.ts`'s `realOf(cwd, dir)` called `fs.realpathSync`
unconditionally on every candidate skill dir, fully resolving symlinks for
BOTH the implicit relative `.skills` and an explicit absolute `--dir`/
`SKILLS_DIR`. Upstream's `_all_skill_dirs`/`_skill_dir_label`
(`bin/skills:165-188`) compute the same "real" value via
`cd "$d" 2>/dev/null && pwd`, but bash's `cd` runs in its default LOGICAL
mode: an already-absolute `d` is only `.`/`..`/slash-normalized, never
symlink-resolved, while a relative `d` resolves against bash's own $PWD —
itself seeded via a real (symlink-resolving) `getcwd()` at process start.
Under a symlinked tmp/identity root (macOS: `/var` -> `/private/var`) an
absolute `--dir` that names the SAME physical directory as `./.skills`
therefore does NOT dedupe on the bash side, so both get scanned and the
per-skill-name "found in multiple locations" warn
(`bin/skills:512-520`) fires — while the port's uniform realpath collapsed
the directory LIST first, so the warn never ran. 189 of skills' 500-
iteration fuzz findings were this family (`parity/fuzz/findings/skills-1.md`).
**Fixed**: `realOf` now mirrors bash's asymmetry — an absolute `dir` is
validated (must exist and be a directory) and `path.normalize`d but NOT
realpath-resolved; a relative `dir` is still resolved via `fs.realpathSync`
against `cwd`, matching a relative candidate's bash-side physical-$PWD
resolution.
**Tests**: `test/skills.test.ts` "bug #42: --dir coinciding with implicit
./.skills via a symlink is not deduped (matches bash)" — builds a real
directory plus a symlink to it, points `--dir` at the symlinked path while
`cwd` is the physical one, and asserts the exact upstream warn text/byte
shape (captured directly against `bin/skills` under a real symlinked
TMPDIR: `TMPDIR=/var/folders/.../T <HEADLONG_ROOT>/bin/skills list --dir
"$SKILLS_DIR"` with `SKILLS_DIR` pointed at the mkdtemp'd `.skills`, see the
finding for the full repro) — fails on the pre-fix code (empty stderr,
silent dedup), passes after the fix.

### view --limit/--offset trailing/leading-space coercion (bug #43, fix-fuzz-small lane)
**The bug**: `src/view.ts`'s `arithInt()` matched a `--limit`/`--offset`
token against the strict regex `/^[+-]?[0-9]+$/`. Bash's own `$(( ))`
arithmetic evaluator (`bin/view:75`, `end_line=$(( start_line + limit - 1
))`) tokenizes its operand with leading/trailing whitespace stripped first
— `x="5 "; echo $(( x ))` is `5`, not a syntax error — so `--limit "5 "`
succeeds on bash (reads as 5) but the port's un-trimmed regex failed the
check, fell through to the "unset -> 0" fallback, and `endLine=0` died
against `startLine=1` (~19 of view's fuzz findings were this whitespace-
adjacent family; `parity/fuzz/findings/view-13.md`).
**Fixed**: `arithInt()` strips leading/trailing space/tab/newline before
the digit-regex check. A token that ISN'T whitespace-padded digits (`abc`,
`10x`) is intentionally UNCHANGED — that still hits bash's real "unset
variable in arithmetic context reads as 0" rule and both sides already
agree there (see the octal/hex `describe` block in test/view.test.ts,
pinned as a documented, non-bug deviation).
**Tests**: `test/view.test.ts` "a trailing-space --limit value still reads
as the number" and "a leading-space --limit value also still reads as the
number" — the trailing-space case's expected bytes come directly from
`printf 'line 1\n...\nline 5\n' > f.txt; <HEADLONG_ROOT>/bin/view f.txt
--limit "5 "` (all 5 lines, exit 0, empty stderr); both fail on the pre-fix
code (rc 1 / empty stdout), pass after the fix.

### mem types tie-break order (bug #44, fix-fuzz-small lane)
**The bug**: `src/mem.ts`'s `actionTypes` sorted rows by count descending
and, on a tie, by type name ASCENDING. Upstream `action_types`
(`bin/mem:250`) pipes `sort | uniq -c | sort -rn`: the final `sort -rn`
compares each line's leading numeric count first, and for a TIE falls back
to a plain string compare of the rest of the line — with `-r` reversing
THAT comparison too, not just the numeric one (verified directly: `printf
'1 goal\n1 note\n1 apple\n' | sort -rn` -> `note, goal, apple`, reverse-
alphabetical, regardless of input order). 6 of mem's fuzz findings were
this family (`parity/fuzz/findings/mem-1.md`): a store with one `goal` and
one `note` memory printed `goal` before `note`, reverse of bash's `note`-
before-`goal`.
**Fixed**: the tie-break comparator now sorts by type DESCENDING.
**Tests**: `test/mem.test.ts` "bug #44: ties (equal counts) sort by type
DESCENDING, matching bash's sort -rn tie-break" — expected bytes
(`"   1  note\n   1  goal\n"`) captured directly against upstream
`action_types` behavior (see finding); fails on the pre-fix ascending
comparator, passes after the fix. The pre-existing "counts by type,
most-frequent first" test (unequal counts, no tie) is unaffected.

### retrieval RETRIEVAL_MIN_HITS as a bareword: unbound-variable crash, not silent success (bug #45, fix-fuzz-small lane)
**The bug**: `intKnob()` mapped ANY bareword-identifier env value (matching
`/^[A-Za-z_][A-Za-z0-9_]*$/`, e.g. `"abc"`) to `0`, modeling Bash's "unset
variable reads as 0 in arithmetic" rule. That rule is correct for
`RETRIEVAL_SEEN`'s own call site (`$(( ${RETRIEVAL_SEEN:-20} - 1 ))`, a
plain arithmetic substitution under `set -euo pipefail` where the
substitution's OWN failure — not a variable-lookup nounset trap — is what
dies). But `RETRIEVAL_MIN_HITS` is read inside `[[ ... -ge
"${RETRIEVAL_MIN_HITS:-2}" ]]` (`thinkers/retrieval/step:60`):
`${VAR:-2}` only substitutes the default when `VAR` is unset/empty; a SET
bareword value reaches `-ge`'s arithmetic operand as-is, where Bash
arithmetic treats a bareword as a VARIABLE NAME to look up — and
referencing that nonexistent variable is an UNCAUGHT "unbound variable"
error (not the SYNTAX error a non-identifier non-integer like `"1.5"`
produces, which `[[ ]]` catches locally and treats as a false test, exit
0 — the ALREADY-documented deviation above this row). The bareword case
kills the whole script (exit 1) before the seen-ring read/write or
trajectory append. The port's `intKnob("abc", 2)` returning `0` instead
made `best.hits < 0` always false, so retrieval proceeded to a full
successful surface (exit 0, traj + seen both written) — the opposite
outcome. Verified directly against upstream (spawning
`thinkers/retrieval/step` with `RETRIEVAL_MIN_HITS=abc`,
`RETRIEVAL_SEEN=1`, a matching trigger):
`status=1`, `stderr="<script-path>: line 60: abc: unbound variable\n"`,
empty stdout, trajectory unchanged, no seen file written
(`parity/fuzz/findings/retrieval-1.md`).
**Fixed**: the `RETRIEVAL_MIN_HITS` call site (not `intKnob` itself, which
stays correct for `RETRIEVAL_SEEN`) now checks for a bareword value
BEFORE calling `intKnob` and dies immediately (`code: 1`, no further
reads/writes) with its own clean `retrieval: RETRIEVAL_MIN_HITS: unbound
variable` message — matching bash's exit code and empty-stdout/no-writes
state exactly. The stderr TEXT embeds bash's own script path and internal
line number, which is the already-reused `isBashLineWordingDeviation`
allowance (`parity/fuzz/lib/allowances.mjs`, category 1) — no new
allowance was added.
**Tests**: `test/retrieval.test.ts` "RETRIEVAL_MIN_HITS as a bareword ->
unbound-variable crash -> exit 1, no writes at all" — asserts exit 1, a
stderr line naming `RETRIEVAL_MIN_HITS`, zero appended observations, and
no seen file; fails on the pre-fix code (exit 0, an observation appended,
a seen file written), passes after the fix. Expected exit code and
"no writes" state were captured directly against upstream (command in the
test's own comment).

### put --parents + `..` in the target: stray intermediate dir (bug #46, fix-fuzz-small lane)
**The bug**: `src/put.ts`'s `--parents` handling computed `dirFs` via
`path.resolve` (`fsResolve`) and `createTemp` joined onto it via
`path.join` — both COLLAPSE any `..` in the path before any filesystem call
runs. Upstream (`bin/put:43-59`) runs `mkdir -p "$(dirname "$raw_target")"`
and `mktemp "$dir/put.XXXXXX"` on the RAW (un-collapsed) dirname string; the
kernel resolves `..` at each individual `mkdir(2)`/`open(2)` syscall during
`mkdir -p`'s walk, so an intermediate path component that exists only
PRE-`..`-collapse still gets created — and is left behind, empty, since the
file itself lands at the shallower resolved path via `mv -f "$tmp" "$file"`
(also kernel-resolved). Verified directly against upstream: `cd work &&
printf '%s' "hello world..." | <HEADLONG_ROOT>/bin/put 'with space/with`tick
/../x.txt' --parents` -> exit 0, stderr `put: wrote with space/with\`tick
/../x.txt (14 bytes)`, and `with space/with\`tick/` left on disk, empty
(`parity/fuzz/findings/put-1.md`). stdout/stderr/exit already matched; only
this on-disk stray-directory state diverged.
**Fixed**: a new `fsResolveRaw` (plain string concatenation, not
`path.resolve`/`path.join`) is used for `dirFs` — the `--parents`
mkdir-p target and `createTemp`'s directory — so Node's own recursive
`mkdirSync` (confirmed NOT to pre-collapse `..` itself — it walks the raw
path segment by segment, letting the OS resolve `..` per mkdir(2) call,
same as bash) creates the same stray intermediate directory bash does. The
final file's own resolve path (`fileFs`, via the existing `fsResolve`) is
UNCHANGED — the kernel resolves its `..` identically either way, so the
final write location doesn't move.
**Tests**: `test/put.test.ts` "bug #46: --parents + a `..` in the target
leaves the same stray intermediate dir bash does" — expected bytes (stderr,
exit code, the stray `with space/with\`tick` empty dir, the file landing at
`with space/x.txt`) captured directly against upstream (command in the
finding/test comment); fails on the pre-fix code (no stray dir), passes
after the fix.

### chat history --since bogus: matches jq's exit code, not its exact text (bug #47, fix-fuzz-small lane, jq-internal-error allowance)
**The bug**: `cmdHistoryIndexed`'s `--since` handling called `durationSeconds`
directly, which silently falls back to `0` (no cutoff) for ANY string it
can't parse as `<int>[dhms]` or a bare number. Upstream's `_duration_s`
(`bin/chat:350-357`) only evaluates a `d`/`h`/`m`-suffixed spec
arithmetically; an `s`-suffixed or bare spec is passed through VERBATIM,
unvalidated, straight into `jq -cn --argjson since "$since_s" ...`
(`bin/chat:405-406`). `--argjson` requires valid JSON text: `--since bogus`
strips (`${1%s}`) to `"bogu"`, which is not valid JSON, so jq itself dies —
verified directly: `jq -cn --argjson x "bogu" '.'` -> `jq: invalid JSON
text passed to --argjson` plus jq's own multi-line help trailer, exit 2.
4 of chat's fuzz findings were this scenario (`parity/fuzz/findings/chat-1.md`).
**Classification**: jq-internal-error family (like traj-1/traj-2 below) —
per this lane's doctrine, the exit code is matched exactly; jq's own
multi-line trailer text (`Use jq --help for help...`, a manpage URL) is
NOT reproduced, since it is jq-version/build-specific boilerplate, not
data our port computes — an allowance, not a byte-for-byte reproduction.
**Fixed**: `sinceArgCrashesLikeBash()` (src/chat.ts) detects the same class
of unparseable `--since` value `_duration_s`'s verbatim-passthrough path
would hand `--argjson` (an s-suffixed or bare spec whose suffix-stripped
form isn't a valid JSON number) and dies with exit 2 and the port's own
clean `chat: error: history: --since <spec>: invalid duration` message,
matching bash's exit code and empty stdout/unchanged state. Scope note: a
`d`/`h`/`m`-suffixed spec with a non-numeric prefix (e.g. `"bogusd"`) goes
through REAL bash arithmetic instead — a different, not-yet-triaged crash
class — and is intentionally left alone (still falls back to 0), matching
this finding's exact scope, not a broader one.
**Tests**: `test/chat-history-index.test.ts` "bug #47: --since bogus dies
(exit 2) instead of silently ignoring the cutoff" (fails on the pre-fix
code: exit 0, real history printed) and "a valid --since still works
(regression guard)" (exit 0, unaffected). Exit code 2 and the "jq dies on
invalid JSON" mechanism were verified directly against upstream (`jq -cn
--argjson x "bogu" '.'`, see the finding for the full `chat history`
repro).

### traj last --field / search: jq-internal crash on a malformed row — exit code matched, jq's own text not reproduced (bug #48, fix-fuzz-small lane, jq-internal-error allowance)
**The bug (two call sites, one root cause)**: upstream pipes a RAW
trajectory line into `jq -r` with NO JSON validation first, in two places:
- `cmd_last --field` (`bin/traj:708`): `printf '%s' "$last_line" | jq -r
  ".${field} // empty"` on the file's last line, unconditionally.
- `cmd_search`'s per-row loop (`bin/traj:~1216`): `step_id=$(printf '%s'
  "$row" | jq -r '.step_id // empty')`, run for EVERY row of the file,
  unconditionally.

Under this script's `set -euo pipefail`, a malformed (non-JSON) line makes
jq itself die there — a parse/runtime error whose EXACT text depends on the
garbage content — which aborts the WHOLE script immediately with jq's own
exit code (5). Verified directly (this repo's fuzz fixture always appends
the same fixed malformed line, `not-json-at-all{{{`): `printf '%s'
"not-json-at-all{{{" | jq -r '.step_id // empty'` -> `jq: parse error:
Invalid numeric literal at line 1, column 16`, exit 5.
`parity/fuzz/findings/traj-1.md` (`last --field` on a malformed last line)
and `parity/fuzz/findings/traj-2.md` (`search` with the SAME malformed line
present anywhere in the file — traj-2's own "root cause" narrative, that a
SPACE in the search pattern breaks jq's argument tokenizing, was
re-investigated and found to be a misattribution by the finding's
shrinker/author: the shrinker only minimizes `argv`, never the seeded
`malformed:true` fixture flag, so the "pattern with a space" framing is a
red herring — verified directly that a single-word pattern against the SAME
malformed fixture crashes identically, and that matches from rows
processed BEFORE the malformed one are printed to stdout before the crash)
are the SAME underlying bug: a raw-row jq pipe with no upfront JSON
validation.
**Classification**: jq-internal-error family. Per this lane's doctrine, the
EXIT CODE (5) is matched exactly, but jq's own parse/runtime-error text is
NOT reproduced — it is jq-build/version-specific boilerplate that varies
with the exact garbage bytes, not data this port computes; reproducing it
would mean hardcoding a specific jq installation's wording, which is
brittle across environments. This is an ALLOWANCE, not a claim of
byte-for-byte stderr parity.
**Fixed**: `cmdLast` (`src/trajCli.ts`) now throws exit code 5 (was 1) when
the last line fails to parse as JSON and `--field` was given. `cmdSearch`'s
per-row loop now dies with exit code 5 immediately upon reaching a row that
isn't valid JSON (previously silently `continue`d past it, matching
neither bash's crash nor completing the search) — matches from rows
processed before the malformed one are still printed first, matching
bash's partial-stdout-then-crash behavior. Both use the port's own clean
`traj: error: <subcommand>: ...: invalid JSON in ...` stderr message
instead of jq's text.
**Tests**: `test/trajCli.test.ts` "bug #48: last --field on a malformed
last line dies with jq's exit code (5), not 1" and the two `search`
malformed-row tests (match-then-crash, and crash-before-any-match); all
three fail on the pre-fix code (exit 1 for `last`, exit 0 with the
malformed row silently skipped for `search`), pass after the fix. The exit
code (5) and the "partial stdout, then nothing" behavior were verified
directly against upstream (commands in this row and in the findings).

### identity --help / -h: fell through to `new`'s usage error, not the top-level banner (bug #49, fix-fuzz-small-2 lane)
**The bug**: `bin/identity.mjs` only special-cased `cmd === undefined` (bug
#41's fix) before the `new`-fallback check `if (cmd !== "new") die(...)`.
Upstream `tools/identity`'s `main()` parses global flags — including
`-h|--help` — in a loop BEFORE the `cmd` case switch even runs
(tools/identity:1550-1573: `-h|--help) usage ;;`), calling the SAME
`usage()` as bare `identity` (banner to stdout, exit 0,
tools/identity:1508-1543). The port never matched "-h"/"--help" as the
first arg, so both fell through as an unrecognized `cmd` into the `new`
guard, printing `new`'s one-line usage error to stderr with exit 1 instead.
Verified directly:
  d=$(mktemp -d); IDENTITY_DIR="$d/ids" <HEADLONG_ROOT>/tools/identity --help
  IDENTITY_DIR="$d/ids" <HEADLONG_ROOT>/tools/identity -h
-> both: full banner on stdout, empty stderr, exit 0 (upstream). Pre-fix
port: empty stdout, `Usage: identity new [--default] [--memories DIR]
<name>` on stderr, exit 1, for both flags.
**Fixed**: `bin/identity.mjs` now special-cases `cmd === undefined || cmd
=== "-h" || cmd === "--help"` before the `new`-fallback check, writing the
exact upstream banner to stdout and exiting 0.
**Tests**: `test/identity-help.test.ts` — spawns `bin/identity.mjs` with
`--help` and with `-h` and asserts stdout equals the banner captured
directly from upstream (command above), exit 0 (fails on the pre-fix code
with exit 1 and the wrong message for both flags).

### traj tail -n 0: printed the whole file instead of nothing (bug #51, fix-fuzz-small-2 lane)
**The bug**: `cmdTail` (`src/trajCli.ts`) took "the last N lines" via
`coreutilsLines(trajFile).slice(-n)`, mirroring `bin/traj`'s own shell-out to
real coreutils `tail -n "$n"`. When N is exactly 0, JS's `-0 === 0`
collapses `arr.slice(-0)` to `arr.slice(0)` — the WHOLE array — instead of
an empty one, because `-n` with `n = 0` is `-0`, not a negative index. Real
coreutils `tail -n 0 <file>` prints nothing. Verified directly:
  d=$(mktemp -d); TRAJ_DIR="$d/traj" TRAJ_ID=12345678-1111-2222-3333-444444444444 \
    <HEADLONG_ROOT>/bin/traj tail -n 0
-> empty stdout, exit 0 (upstream), against a 3-line fixture. Pre-fix port
printed all 3 lines for the same fixture/argv, exit 0. Same root cause also
affected the `-r/--recursive` tail path's `sorted.slice(-n)`, fixed at the
same time (no separate fuzz finding needed — identical code smell, same
call pattern).
**Fixed**: added a `tailLastN(arr, n)` helper in `src/trajCli.ts` that
special-cases `n === 0` to `[]`, used at both `.slice(-n)` call sites (plain
tail and recursive tail); every other N (including bash/coreutils' own
"negative N means positive N" quirk, unrelated to this bug) still goes
through `.slice(-n)` exactly as before.
**Tests**: `test/trajCli.test.ts` "bug #51: -n 0 prints nothing, not the
whole file (JS slice(-0) quirk)" — fails on the pre-fix code (prints all 5
seeded lines instead of 0).

## Retired: focus/glob/put/sub/view (1c: 12ca841)

Upstream `12ca841` ("core: drop view, put, glob, sub, focus; the mind reads
and edits in bash") deletes these five tools outright — not moved to
`tools/`, no replacement binary. Its commit message: over 17 days Audel
called `view` 212 times against 3,067 `sed -n` reads, `sub` 41 times against
about 17,000 python heredoc edits, and `put`/`glob`/`focus` a few hundred
times between them combined; the Docker sandbox never mounted the four file
tools, the monolith prompt already routes goals through `mem`, and Audel's
own scripts call none of the five. Upstream's tool lists in the persona,
shared library (`thinkers/_lib/common.sh`), dispatcher (`bin/thinkers`),
coupling test (`tests/test_thinker_tool_coupling.sh`), installer
(`install.sh`), uninstaller (`uninstall.sh`), status (`status.sh`), and
killall (`tools/headlong-killall`) all drop the five in lockstep.

This port (lane 1c-f, `sync1c/f-tool-cull`) mirrors that decision — DROP, not
superset-and-document — retiring all five from the port as well:

- **Removed**: `bin/{view,put,glob,sub,focus}` (+ their `.mjs` shims),
  `src/{view,put,glob,sub,focus}.ts`, `test/{view,put,glob,sub,focus}.test.ts`,
  `parity/{view,put,glob,sub,focus}/` (differential harnesses + fixtures),
  `parity/fuzz/tools/{view,put,glob,sub,focus}.mjs` (fuzz adapters) and their
  now-unused allowance predicates in `parity/fuzz/lib/allowances.mjs`
  (`isGlobLimitNonIntegerFamily`, `isGlobBracketRangeFamily`,
  `isPutOsFailFamily`) and concurrency lanes in `parity/fuzz/lib/concurrency.mjs`
  (`concurrencyPut`, `concurrencySub`). `parity/fuzz/tools/registry.mjs`'s
  `TOOLS`/`TOOL_NAMES` no longer list them, so `--tool all` still runs clean.
  `parity/fuzz/findings/{view,glob,put}-*.md` campaign findings are left in
  place as history, per this lane's brief — not deleted.
- **Tool-enumeration updates**: `src/install-lib.ts`'s `TOOLS` (installer
  onto-PATH list; `focus`/`glob` were already absent from it before this
  lane — a pre-existing deviation from upstream's `BIN_TOOLS`, not something
  this lane introduced) and `src/killall.ts`'s `PATTERNS` (the `sub.mjs`
  argv-match entry is removed, mirroring upstream's own
  `(shellm|shellm-explore|llm|chat|sub)` → `(shellm|shellm-explore|llm|chat)`
  regex-group edit to `install.sh`/`status.sh`/`uninstall.sh`/
  `tools/headlong-killall`). `src/status-lib.ts`/`src/uninstall-lib.ts` carry
  no tool list of their own — they import `TOOLS`/`PATTERNS` from
  `install-lib.ts`/`status-lib.ts` respectively, so they follow automatically
  (see the new "tool-list-must-match" test below).
- **No sandbox-runtime mount list to update**: unlike upstream's per-tool
  `docker exec ... -v $tool:/usr/local/bin/$tool:ro` mounts, this port's
  `src/sandbox-runtime.ts` bind-mounts the WHOLE port checkout read-only in
  one shot (see "Sandbox bind-mount scope" above) — there is no per-tool
  mount list in this port to prune.
- **Docs**: README.md's CLI-tools line, this file's "Ported" line (above),
  and CLAUDE.md's frozen-surface CLI list + `PARITY_BASH_<TOOL>` env-var
  enumeration drop `sub`/`put`/`view`/`focus` (`glob` was already absent from
  CLAUDE.md/README's lists). `PORTING.md`'s differential-harness list drops
  the same five.
- **Test coverage for the retired tools is gone, by design** (removed tests
  for removed tools): `test/{view,put,glob,sub,focus}.test.ts`, the `put`
  `describe` block in `test/stdin.test.ts`, the `view` scenario in
  `test/stdout-drain.test.ts`, and the `concurrencyPut`/`concurrencySub`
  fuzz lanes. Tests that used `bin/sub.mjs` only as an arbitrary
  argv-pattern decoy (`test/killall.test.ts`, `test/killall-step-tree.test.ts`,
  `web/server/test/controls.test.ts`) were repointed at `bin/chat.mjs` — a
  still-shipped, still-matched pattern — so killall's decoy/sibling/protected-
  ancestor coverage is unchanged, not reduced.
- **`parity/upstream-tests/run.mjs`'s `PORT_TOOLS`** (used to substitute the
  port's `bin/<tool>.mjs` into a scratch copy of the real upstream Bash test
  suites) drops `focus`/`glob`/`put`/`view` — `portEntry()` would otherwise
  throw `port tool missing` for any suite run through this harness now that
  those `bin/*.mjs` files are gone. (`sub` was never in `PORT_TOOLS` to begin
  with — it was already left as real upstream Bash for that harness.)
- **Explicitly out of scope for this lane** (owned by lanes B/E — thinker
  step code, prompts, skills/identity assets — flagged here, not edited):
  - `src/monolith.ts`'s `synthCommand()` — **RESOLVED by bug #63** (see
    "shellm-run `command` field was a fixed template" above): it no longer
    carries any hardcoded `--bin` list at all — the run header's `--bin`
    flags are now derived from the live tool list (`fs.existsSync` per tool
    under `id.binDir`, the TS equivalent of upstream's `command -v` in
    `_build_shellm_flags`, `thinkers/_lib/common.sh`), so a retired tool's
    absence here was never a real gap to begin with once fixed.
  - `src/steprun.ts:32` — `DEFAULT_IDENTITY_TEXT`'s "I am driven by standalone
    commands (think, chat, focus, mem, skills, traj) …" boilerplate (thinker-
    step code, mirrors upstream's `deploy/slack-persona.md` edit in 12ca841).
  - `src/assets/skills/shellm/SKILL.md` (documents `focus`/`view`/`glob`/`sub`/
    `put` as available tools, lines ~21, 54, 74-77), `src/assets/skills/file-tools/SKILL.md`
    (the entire skill teaches `view`/`put`/`sub`/`glob`), and
    `src/assets/shellm-system-prompt.txt:72` ("File tools: view …, sub …, put
    …, glob …") — all skills/identity assets, and upstream itself only
    replaces the system-prompt file-tools line in a LATER commit
    (`f1b8693`, "wake prompt: skills pass"), not in 12ca841 itself.

See also the new "tool-list-must-match" test (`test/tool-coupling.test.ts`),
which mirrors upstream's `tests/test_thinker_tool_coupling.sh` invariant
across this port's installer/uninstaller/status/killall.

## Upstream sync 1c, lane E: identity/skills/thinker-sync (8c3f410, f1b8693, 6c324d1, 9a62727)

### 1. Skills split (1c: 8c3f410) — `src/skills.ts` slims to list/show/prompt/list-json + forwarding; `src/headlong-skills.ts` is the new manager

Mirrors upstream's `bin/skills` → `bin/skills` (slim) + `tools/headlong-skills`
(manager) split exactly, adapted to this port's flat `bin/` layout (no
separate `tools/` directory — the same adaptation this port already made for
`tools/headlong-killall` → `bin/headlong-killall`):

- `src/skills.ts` keeps `resolveConfig`, `colors`, `frontmatterField`,
  `extractShelllmMeta`, `missingRequirements`, `processSkillBlocks`,
  `allSkillDirs`/`skillDirLabel`/`skillSubdirs`, `findSkill`, `listJson`,
  `renderSkill`, `skillRequires`, `buildSkillsPrompt`, `actionList`,
  `actionListJson`, `actionShow`, and a slimmed `cli()` (list/list-json/show/
  prompt only). Everything else (`actionSearch`/`searchGitHub`,
  `actionInstall`, `actionRemove`, `actionCheck`, `actionInit`/
  `scaffoldSkill`, `actionPromote`/`showKernelBudget`/`tokenEstimate`,
  `actionKernel`, all remotes helpers, `actionRemoteList/Add/Remove`) moved
  UNCHANGED to the new `src/headlong-skills.ts`, which imports the shared
  helpers from `skills.ts` (the TS equivalent of upstream's manager
  `source`-ing the core for its config/helpers).
- New `bin/headlong-skills.mjs` (+ extensionless `bin/headlong-skills`
  symlink, same pattern as `bin/skills`/`bin/skills.mjs`) — thin wrapper over
  `src/headlong-skills.ts`'s `cli()`, identical shape to `bin/skills.mjs`.
- **Forwarding** (`skills.ts`'s `forwardToManager`/`resolveManagerPath`,
  mirroring `bin/skills`'s `_forward()`): a manager-only flag
  (`--project`/`--remotes`/`--force`/`--name`/`--description`) forwards
  IMMEDIATELY, mid-parse, with the full original argv, matching upstream's
  `case … --project|--remotes|--force|--name|--description) _forward "$1" ;;`
  exactly (checked BEFORE the value is read). A positional subcommand not in
  `{list, list-json, show, prompt}` (search, install, remove, check, init,
  promote, kernel, remote, or any other bare token — a search-shorthand
  query) forwards too. Resolution order matches upstream: PATH lookup for a
  literal `headlong-skills` first (`resolveOnPath`, this port's `command -v`
  equivalent), THEN a checkout-relative fallback. **Deviation, documented,
  necessary**: upstream's fallback is `$(dirname BASH_SOURCE)/../tools/
  headlong-skills`; this port's fallback is a literal SIBLING in `../bin/`
  (one directory up from `src/skills.ts`'s own location), since this port has
  no `tools/` directory — `bin/headlong-skills(.mjs)` sits right next to
  `bin/skills.mjs`. The LOOKUP ORDER is unchanged; only the fallback's
  target path differs, and it's the one directly analogous to upstream's own
  `tools/` sibling. Also PORT-NOTE: the forwarded subprocess is spawned via
  `process.execPath` (this port's own node binary) rather than relying on the
  target's own `#!/usr/bin/env node` shebang + `ctx.env.PATH` to resolve
  `node` — upstream's `exec` similarly depends on PATH to resolve `$mgr`'s
  own `#!/usr/bin/env bash` shebang, so a caller with a stripped-down PATH
  would fail identically on both sides for that reason; using
  `process.execPath` only removes an ADDITIONAL, port-specific failure mode
  (this test process's own PATH lacking `node`) without changing any
  observable stdout/stderr/exit-code byte when PATH is intact.
- `bin/skills`'s slim `--help`/usage text and the "No skills installed." hint
  (now `headlong-skills init`, not the pre-split `skills --init` — which was
  never a real flag) are copied byte-for-byte from upstream-next's
  `bin/skills`; `headlong-skills`'s own usage (matching `tools/
  headlong-skills`) is copied byte-for-byte too, including the reworded
  `promote` line ("Move a skill into the kernel …").
- `actionList` (unchanged location, `skills.ts`) drops the "Available (from
  remotes)" footer entirely, matching upstream's post-split `action_list` —
  remotes moved to the manager, and this core `skills` never resolves one.
  The dead `installedSkillNames`/`_installed_skill_names` helper (that
  footer's only caller) is dropped rather than ported, since upstream's own
  sibling in `tools/headlong-skills` is ALSO dead code there (defined, never
  called) — confirmed via `grep -n _installed_skill_names tools/headlong-skills
  bin/skills` against upstream-next (one hit: the definition).
- Tests: `test/skills.test.ts` (core: list/list-json/show/prompt/forwarding +
  sibling-lookup, rewritten from the pre-split monolith test file) and new
  `test/headlong-skills.test.ts` (manager: search/install/remove/check/init/
  promote/kernel/remote — content carried verbatim, behavior unchanged, from
  the pre-split `test/skills.test.ts`). `parity/skills/run-parity.mjs`
  extended with a `bin: "headlong-skills"` scenario selector (manager driven
  as its own entrypoint, not via forwarding) plus 4 new "split" scenarios
  (`manager-list-standalone`, `manager-help-advertises-install`,
  `manager-show-standalone`, `manager-prompt-standalone`) and
  `PARITY_UPSTREAM_ROOT`-based path derivation (`BASH_HEADLONG_SKILLS`/
  `TS_HEADLONG_SKILLS`), matching the convention already used by
  `parity/skill-env/run-parity.mjs` and `parity/sandbox/run-parity.mjs`. Run
  against an upstream checkout (5458fee): **95/95 scenarios effective
  parity (100.0%)** — 87 byte-identical, 8 pre-existing documented
  deviations (stderr-wording-only misuse paths + one `set -e`-crash
  smoothing, all pre-dating this lane), **zero new deviations** from the
  split itself; every install/search/check/init/remove/promote/kernel/remote
  scenario still reaches the manager transparently through the slim core's
  forwarding, proving the contract end-to-end against real upstream-next
  binaries.

### 2. `skills prompt`'s new "## Skills" format (1c: f1b8693, "wake prompt: skills pass")

`buildSkillsPrompt` (`src/skills.ts`) is rewritten to match upstream's
post-f1b8693 `action_prompt` exactly: a fixed two-line contract ("## Skills\n"
+ the "Playbooks I load only when a task calls for one: …" sentence) followed
by one `  - name: description` line per skill — kernel dir first, then the
regular skills dir, DEDUPED by name (first-seen wins), `(no description; run
skills show <name>)` when a skill has no `description:` field, or `  (none
installed)\n` when nothing is installed. Nothing is inlined any more: no CLI
cheatsheet, no full kernel SKILL.md bodies (previously the single biggest
prompt-token cost — upstream's commit message cites ~102K → ~2.5K on a real
identity). `stripFirstFrontmatter`/`promptSummaryField`/`trimTrailingNewlines`
(the old multi-range-sed-quirk reproduction, no longer needed by the new
format) are removed as dead code alongside the old block.

- `frontmatterField` in this port already never throws on a frontmatter-less
  SKILL.md (native fs/string logic, not an `awk|grep|head|sed` pipeline under
  `set -e -o pipefail`) — so the upstream half of f1b8693 that makes
  `frontmatter_field` "never fail" (wrapping it in `{ … } 2>/dev/null ||
  true`) has no port-side equivalent to make; the *observable* fix (a
  frontmatter-less skill is listed by directory name with the default
  "(no description; …)" text, not silently dropped) is what's tested.
- Test: `test/skills.test.ts`'s "cli prompt / buildSkillsPrompt" describe
  block (byte-exact contract text, no-kernel-body-inlined, no-CLI-table,
  under-1K-for-two-skills, frontmatter-less-skill-listed, kernel-wins-dedup).
  Parity: `parity/skills/run-parity.mjs`'s existing `prompt` group (basic,
  no-skills, multi-range-summary-quirk, with-kernel-body) all reached
  byte-identical parity against upstream-next's NEW prompt format with no
  scenario changes needed — confirming the rewrite matches real bytes.

### 3. `src/identity.ts` KERNEL_SKILLS/BUNDLED_SKILLS (1c: f1b8693, skills part)

`KERNEL_SKILLS` drops `"goals"` (`["mem", "chat", "goals"]` →
`["mem", "chat"]`) and `BUNDLED_SKILLS` drops `"file-tools"`, matching
upstream's `tools/identity` edit in the same commit (`skills/goals/SKILL.md`
never printed its block — `printf` misread its own format string as an
option — and `skills/file-tools/SKILL.md` advertised the already-retired
`view`/`put`/`sub`/`glob`, see "Retired: focus/glob/put/sub/view" above).
`src/assets/skills/{goals,file-tools}/SKILL.md` and
`src/assets/kernel/goals/SKILL.md` deleted to match upstream's deletions.
`skills/mem/SKILL.md`'s own f1b8693 trim (memory-dump block removed) is
**out of this lane's scope** (mem is owned by lane C) and NOT ported here —
`src/assets/skills/mem/SKILL.md` / `src/assets/kernel/mem/SKILL.md` are
untouched. Tests updated: `test/skills-content.test.ts`,
`test/identity-new.test.ts`, `test/identity-import.test.ts`.

### 4. `identity export --slim` drops `content_b64` from every step (1c: 9a62727)

`slimJsonLine` (`src/identity.ts`) now unconditionally `delete`s
`content_b64` after the existing shellm-run/prompt truncation, matching
upstream's updated `_SLIM_JQ` (`… | del(.content_b64)`, applied to every step
type, not just shellm-run/prompt) — a `chat send-file` message step's base64
file payload could otherwise carry a credential past the text-only regex/
string redaction. `deploy/scripts/audel-export` (also touched by 9a62727) is
OOS per PARITY.md's existing "identity export is unported" framing for that
script; the library-level `content_b64` drop itself is real behavior this
port's `identity export`/web export route already exercises, so it is PORTed.
Test: `test/identity-export.test.ts`'s new "slim drops content_b64 from
every step" case (message + shellm-run steps, non-slim export keeps it).
Parity: `parity/identity/run-export-parity.mjs`'s new `slim-drops-content-b64`
scenario, run against the upstream checkout's real `tools/identity
export --slim`: **7/7 scenarios PARITY (100.0%)**.

### 5. `web/server/src/thinker-sync.ts` `sync()`: bundled `disabled` marker inherited on first install only (1c: 6c324d1)

Port of `thinker_sync.py`'s `sync()` fresh-install branch: after
`installSubscriptions`, if `bundledDir/disabled` exists, it is
`atomicCopy`'d to `installedDir/disabled` — but ONLY inside the `fresh`
branch (status was `not_installed`). A later pull for an already-installed
thinker never touches `disabled` (already excluded from the code-file copy
loop by the existing `PRESERVE` set), so an operator who deletes the marker
to enable a thinker keeps it enabled across every subsequent pull; the
bundled default is never silently restored. This is the identical semantic
upstream's `sync()` (Python) adds in the same commit, and matches this
port's OWN `identityNew`/`installThinker` (`src/identity.ts`), which already
copies every bundled file — including `disabled` — verbatim on a fresh
`identity new` (no symlink-vs-real-file distinction to begin with, since
this port never symlinks bundled thinker files at all — DIRECTOR
CORRECTION, see "Daemon-runtime deviations" above) — so `identity.ts`
needed NO code change for this commit; only `thinker-sync.ts`'s reconcile-
on-restart path (the one thing `identity new` doesn't cover) did.
Test: `web/server/test/controls-slice-c.test.ts`'s new "PORT-NOTE (1c:
6c324d1): a fresh install inherits the bundled disabled marker once, then a
later pull preserves an operator's removal" — ported directly from
upstream's `web/tests/test_thinker_sync.py::test_fresh_install_keeps_bundled_disabled_default`,
same two-phase assertion (fresh install copies the marker byte-identical;
deleting it and re-syncing does not restore it). No dedicated Bash-vs-TS
differential harness exists for `thinker-sync.ts` (it ports `thinker_sync.py`,
not a Bash tool — there is no `PARITY_BASH_THINKER_SYNC` to diff against), so
this scenario lives in the web-server unit-test suite rather than
`parity/identity`, alongside the existing thinker-sync route tests it sits
next to.

### 6. Retired-tool references (1c: 12ca841, in this lane's files only)

- `src/steprun.ts`'s `DEFAULT_IDENTITY_TEXT` drops `focus` from the "I am
  driven by standalone commands (think, chat, focus, mem, skills, traj) …"
  list — this port already retired `focus` (lane 1c-f). **Known upstream
  inconsistency, not reproduced**: upstream's own `tools/identity` hardcoded
  default text (`_ensure_kernel`'s fallback, tools/identity:1502-1508) still
  literally says "…focus, mem, skills, traj…" at 5458fee — 12ca841 only
  edited the PARALLEL list in `deploy/slack-persona.md` ("chat, mem, traj,
  skills, focus, recap, context, view, put, glob, sub" → "chat, mem, traj,
  skills, recap, context"), and no later commit through 5458fee touches
  `tools/identity`'s own copy. Dropping `focus` here mirrors the PATTERN
  12ca841 established (and this port's own prior retirement decision) rather
  than upstream's own stale bytes for this specific string, since matching
  those bytes verbatim would have this port's freshly-created identities
  describe a command (`focus`) that no longer exists in the port at all.
- `src/assets/skills/file-tools/SKILL.md` — DELETED, matching upstream
  (`skills/file-tools/SKILL.md` deleted by f1b8693, not 12ca841 itself — it
  advertised `view`/`put`/`sub`/`glob`). See item 3 above (same commit, same
  deletion, filed there under KERNEL_SKILLS/BUNDLED_SKILLS since upstream's
  own commit bundles both changes together).
- `src/assets/skills/shellm/SKILL.md` — **NOT touched.** Confirmed via
  `git diff 7d29f9e 5458fee -- skills/shellm/SKILL.md` against both upstream
  pins: EMPTY diff. Upstream's own `skills/shellm/SKILL.md` still documents
  `view`/`glob`/`sub`/`put`/`focus` as available tools at 5458fee (lines
  ~21,54,74-77) — the same kind of stale-doc inconsistency as `tools/
  identity`'s hardcoded text above. Since upstream never rewrote or deleted
  this file in the 7d29f9e..5458fee range, and the port's copy is already
  byte-identical to upstream's 7d29f9e copy, there is nothing to port here —
  changing it would be inventing a fix upstream itself hasn't made.
- Installer skills-list wording: none found. `src/install-lib.ts`'s `TOOLS`
  array (whether `headlong-skills` should be added to the installer's
  onto-PATH symlink list) is explicitly lane F's (1c-f) file per this file's
  own "Retired" section above; not touched here. Not adding it there does
  not break forwarding in this port: `src/sandbox-runtime.ts` bind-mounts the
  WHOLE checkout read-only (see "Sandbox bind-mount scope" above), so
  `bin/headlong-skills(.mjs)` is always present as a literal sibling of
  `bin/skills.mjs` regardless of the installer's PATH-symlink list.

## Upstream sync 1c, lane I (7d29f9e → 5458fee, web control plane + viewer)

Lane I carries `web/server/src/{chat,chat-links,control,safety,router,
trajectory}.ts` and `web/viewer/app/**`. Upstream commits assigned to this
lane: f68c1d8 (web part), c647609 (web part), 6c324d1 (web part — see item 4
below). Also closes a triage miss: f68c1d8's Slack-side
`chat_getPermalink`/`source_url` addition to `slack/src/headlong_slack/
inbound.py`, which UPSTREAM-TRIAGE-2.md's lane table left unassigned (lane
G's own PARITY.md section explicitly called it out as deferred/out of
scope, tagging 7 `parity/slack/run-parity.mjs` scenarios
`knownDivergence`).

### 1. f68c1d8 web part — mind-log Slack message links

Port of `chat.py`/`chat_links.py`/`control.py`/`safety.py`/`server.py`/
`trajectory.py`'s `source_url` plumbing:

- **New `web/server/src/chat-links.ts`** (port of the new `chat_links.py`):
  `resolveSourceUrl(message, known)` — a reply inherits the Slack permalink
  of the message it answers, by `reply_to` step_id, recording each
  message's resolved URL into `known` as it goes so the chain can run
  arbitrarily deep. Byte-identical logic to upstream: own `source_url` wins
  when present; otherwise inherit from `known[reply_to]`; a step with
  neither resolves to `null`.
- **`trajectory.ts`**: `_CHAT_FIELDS` gained `"source_url"`; `NormalizedStep`
  gained an optional `source_url` field; `Normalizer` gained a
  lifetime-scoped `messageSourceUrls` map (mirrors `_Normalizer.
  __init__`'s `self._message_source_urls`) and calls `resolveSourceUrl` for
  every `CHAT_MESSAGE_TYPES` step, storing the result on the normalized
  step — this is what lets `step-card.tsx`/`mindlog2-model.ts` (mind log)
  show the permalink even on a reply that carries no `source_url` of its
  own.
- **`chat.ts`**: `chatView()` gained its OWN `sourceUrls` map, scoped to one
  call (matches `chat_view()`'s local `source_urls: dict` — a fresh
  resolution over the whole chat index every call, independent of
  trajectory.ts's longer-lived one, exactly mirroring upstream's two
  separate call sites for `resolve_source_url`). `ChatMessage` gained
  `source_url`.
- **`safety.ts`**: new `isSlackPermalink(value)` — byte-identical port of
  `is_slack_permalink` (https scheme, `slack.com`/`*.slack.com` host,
  `/archives/` path prefix, 2048-char cap).
- **`control.ts`**: `chatSend()` gained an optional `sourceUrl` parameter;
  appends `--source-url <url>` to the `chat send` argv when present
  (mirrors `control.py`'s `chat_send`).
- **`router.ts`** (port of `server.py`'s two `/chat` routes): `POST
  .../chat` reads an optional `source_url` body field, 422s
  ("Invalid source URL") if present and not `isSlackPermalink`, and passes
  it through to `control.chatSend`. `GET .../chat` needed no route change
  — `chatView()` already returns the resolved field.
- **Viewer** (`web/viewer/app/**`, byte-identical port of the upstream
  React/TS diff — this half of f68c1d8 has no Python side to diff against):
  new `lib/source-links.ts` (`slackSourceUrl`/`slackConversationUrl`);
  `lib/types.ts` gained `ChatMessage.source_url` and `NormalizedStep.
  source_url?`; `lib/mindlog2-model.ts`'s `Ml2Card` gained `source_url`,
  falling back to a `slack-<user>-<channel>[-<ts>]` routing-name-derived
  `app_redirect` link when no real permalink is known; `components/
  step-card.tsx`'s `message` case and `routes/chat.tsx`'s `Bubble` and
  `routes/mindlog2.tsx`'s `StreamCard` each render an "Open in Slack" link
  when a source URL resolves.
- Tests: `web/server/test/chat-links.test.ts` (new, 3 cases, ports
  `test_chat_links.py` 1:1); `views.test.ts` gained a `chatView` case
  (`test_chat_slack_source_url_is_inherited_by_reply`); `normalize.test.ts`
  gained a `source_url` inheritance case (`test_reply_inherits_message_
  source_url`); `controls.test.ts` gained 2 cases (`test_chat_send_passes_
  slack_source_url`, the `source_url` validation half of `test_chat_send_
  validation`). The Python suite's cache-eviction assertions
  (`test_trajectory_cache.py::test_chat_index_survives_eviction`'s
  `raw is None` checks) don't apply — this port never evicts `raw` (see
  `trajectory.ts`'s file header) — so only the `source_url`-carrying half of
  that test was ported, not the eviction half.

### 2. f68c1d8 Slack part (triage miss) — `chat_getPermalink`/`source_url`

Closes the gap lane G's own PARITY.md section flagged as deferred:

- **`src/slack/api.ts`**: new `chatGetPermalink(channel, messageTs)` —
  `params=` (form) call to `chat.getPermalink`, read directly from the
  installed slack_sdk source (`web/client.py`'s `chat_getPermalink`:
  `http_verb="GET"` but still routed through the form/`params=` path like
  `reactions.get`/`conversations.replies`, not `json=`).
  `SlackClientLike` (inbound.ts) gained the matching method signature.
- **`src/slack/inbound.ts`**: `deliver()` now calls `chatGetPermalink`
  after building the chat POST body and before the retry loop, for every
  non-reaction message (`!msg.isReaction` — the SAME gate `cb974c2`
  introduced upstream, which this port already had in place per lane G's
  own note that `isReaction` was "ported anyway" for its other purpose).
  On success, `body.source_url = permalink`. On failure (any thrown
  error — missing scope, timeout, Slack outage), the error is logged and
  swallowed: a permalink is best-effort metadata, its lookup must never
  keep a human message out of the mind log — byte-identical semantics to
  upstream's `except Exception: log.warning(...)`.
- **`parity/slack/run-parity.mjs`**: the 7 `knownDivergence:
  KNOWN_PERMALINK_GAP` tags (dm-message-delivered, app-mention-in-channel-
  anchors-new-thread, mention-inside-existing-thread-anchors-at-thread-ts,
  duplicate-channel-ts-deduped, delivery-retries-then-slack-error-fallback,
  unicode-and-hostile-name-delivery, first-mention-backfill-prepends-
  prior-lines) are REMOVED, not loosened — every one of those scenarios now
  reaches plain PARITY because both languages make the identical
  `chat.getPermalink` call. The permalink-specific `isOnlyPermalinkDivergence`
  exemption function and the `KNOWN_PERMALINK_GAP` constant are deleted (the
  gap they existed to document is closed); the generic `knownDivergence`
  tag mechanism itself is left in place for any future genuine gap.
  `parity/slack/fake-server.mjs` gained a `chat.getPermalink` default
  response (a stable, deterministic permalink) so both drivers' inbound
  deliveries record the identical `source_url` — no driver (`py_driver.py`,
  `ts_driver.mjs`) changes needed, since both already construct their
  `WebClient` pointed at the fake server for every Slack method uniformly.
  Re-run: 23/23 PARITY (100%), 0 known-divergence (was 16/16 PARITY + 7
  known-divergence before this lane).
- Tests: `test/slack-inbound.test.ts` gained a new "chat_getPermalink /
  source_url (1c: f68c1d8)" describe block, 3 cases ported from
  `test_deliver_records_slack_permalink`/`test_permalink_failure_does_not_
  drop_message` plus one confirming the `isReaction` skip gate
  (`fakeClient()`'s default mock returns `{}` so pre-existing reaction
  tests are unaffected by the new unconditional-except-for-reactions call).

### 3. c647609 web part — strip `content_b64` from the dashboard/mind-log wire form

Port of `trajectory.py`'s new `_wire_raw()`:

- **`trajectory.ts`**: new `wireRaw(raw)` — returns `raw` unchanged when it
  has no `content_b64` key, otherwise a shallow copy with `content_b64`
  deleted. Applied where `NormalizedStep.raw` is constructed in `ingest()`
  (`raw: wireRaw(raw)`), matching upstream's `"raw": _wire_raw(raw)` at the
  same point in `_Normalizer.ingest`. **Deviation from upstream's shape,
  not its behavior**: Python applies `_wire_raw` a SECOND time, in
  `TrajectoryCache`'s window-rehydrate path, because that cache evicts and
  later re-reads raw records from disk; this port never evicts (whole file
  kept in memory — see the file's header comment), so there is only ever
  one site that constructs a step's `raw`, and stripping there is
  sufficient — no second call site exists to strip at.
  `filename`/`content` (the fields the UI actually renders) are left
  untouched; only `content_b64` (the base64 file bytes, `chat send-file`'s
  contribution per lane D / c647609's `bin/chat` half) is dropped, since it
  only inflates the wire JSON and is never rendered.
- The viewer needed no change: neither `step-card.tsx`'s `message` case nor
  `routes/chat.tsx`'s `Bubble` ever read `raw.content_b64` (confirmed by
  grep before touching either file) — they already only render `filename`/
  `content`, so stripping the field server-side is invisible to them by
  construction.
- Tests: `normalize.test.ts` gained two cases (`test_file_bytes_stripped_
  from_dashboard_raw` port, plus a no-op case for a step with no
  `content_b64` at all).

### 4. 6c324d1 web part — already fully ported by lane E, nothing left here

Checked `git show 6c324d1 -- web/` line by line: the ENTIRE web/ diff is
`web/src/headlong_web/thinker_sync.py` (+`web/tests/test_thinker_sync.py`)
— the bundled-`disabled`-marker-inherited-once-then-preserved change. That
is exactly what lane E's PARITY.md section item 5 ("`web/server/src/
thinker-sync.ts` `sync()`: bundled `disabled` marker inherited on first
install only") already ported, byte-for-byte, before this lane started. No
other file under `web/` appears in `6c324d1`'s diff. No code change needed
in this lane for this commit.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `npx vitest run` green; `parity/slack/run-parity.mjs` 23/23
PARITY, 0 known-divergence.

## Upstream sync 1c, lane L (context/chat triage misses)

Lane L closes triage misses left over from lanes A and I: `f68c1d8`'s
`bin/context` half (the `context` tool's own `is_meta` hides `source_url`
too, alongside the token/run bookkeeping fields lane A already ported) was
assigned to lane A by `UPSTREAM-TRIAGE-2.md`'s lane table but the diff
(`git -C headlong-upstream-main show f68c1d8 -- bin/context`) was missed —
lane A's own section above documents only `3228c8c`/`1fdeb97`'s fields.

### 1. f68c1d8 `bin/context` part — `source_url` joins the hidden bookkeeping set

`git show f68c1d8 -- bin/context` adds exactly one line to `is_meta`'s
`or ($k == "run_id" or ... or $k == "estimated")` clause: `or $k ==
"source_url"`. `source_url` (the Slack permalink `chat_getPermalink`
stamps on a `message`/`prompt` step, wired to `bin/chat`/the web layer by
this same commit — see lane I's section above) is bookkeeping for the web
UI's "link to Slack" feature, not something the model should see; without
this fix `context bk`'s rendered output leaked a `[source_url]\n<url>` tag
for any step carrying the field, and upstream's own `tests/
test_context.sh` `invariant/bookkeeping-hidden` case (which seeds a
`prompt` step with `source_url` in its `bk` fixture, ~line 227) fails
against the port.

- `src/context.ts`'s `META_EXACT` set gains `"source_url"`, shared by both
  `buildContext` (the engine-facing projection) and the standalone
  `context` CLI's `renderStep` — same mechanism as the `3228c8c`/`1fdeb97`
  fields above, not a separate code path.
- Failing-test-first: `test/context.test.ts`'s existing bookkeeping-hidden
  case extended with a `source_url` field + a `example.slack.com` URL and
  both added to the not-leaked assertion list; red before the fix (content
  rendered `t\n\n[source_url]\nhttps://example.slack.com/...`), green
  after. All 39 `context.test.ts` cases pass.
- `parity/context/run-parity.mjs` gains
  `is-meta-bookkeeping-hidden-source-url` (a `prompt` step carrying
  `source_url`, `--user-types prompt`) alongside the pre-existing
  `is-meta-bookkeeping-hidden` case. Re-run against an upstream checkout
  (5458fee) via `PARITY_BASH_CONTEXT=<upstream-checkout>/bin/context`:
  **115/115 core byte-exact (was 114/114), 11/11 deviation probes as
  documented** — 100%, 0 new port bugs.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green; `test/
scrub.test.ts` clean (no absolute local paths in the new parity scenario).

### 2. bug #52 — `exitAfterDrain`'s trailing flush write crashes on EPIPE

`parity/upstream-tests/run.mjs` (run against an upstream checkout @
5458fee) flagged upstream's `tests/test_chat_history_index.sh` case "text
output renders the messages" as a PORT-ONLY failure. That case is `if chat
history --with "$ANDY_T1" | grep -q 'sure!'; then ok ...; else bad ...; fi`
under the suite's own `set -uo pipefail`.

**Reproduction and root cause** (not a `src/chat.ts` content bug —
byte-for-byte reproduction of the exact upstream fixture showed the port's
`chat history --with` text output is IDENTICAL to real Bash's, always,
including the `sure!` line): the failure is flaky (fails ~20-40% of runs,
confirmed by running the real scratch-harness invocation 30+ times both
before and after the fix) and reproduces deterministically once isolated —
`process.stdout.write("", cb)`, the trailing drain probe
`src/exitAfterDrain.ts` (bug #40) issues after a tool's real output to make
sure the OS pipe buffer has flushed before `process.exit()`, throws an
**unhandled `EPIPE` error** when the reader on the other end of the pipe
(`grep -q`, which stops reading as soon as it has a match — an entirely
ordinary shape) has already closed its read end. Node does not silently
tolerate a failed write on a stream with no registered `"error"` listener:
it emits an unhandled `error` event and crashes the whole process
(uncaught exception, non-zero exit, a stack trace on stderr) even though
every byte of real content was already delivered and read. Confirmed with
a minimal repro (`node` script writing 5 lines + the same trailing
zero-byte write, piped to `grep -q` on the last line, under `set -o
pipefail`): 75/200 runs crashed with `Error: write EPIPE` at the drain
write's call site. Real Bash never exhibits this: its `jq`/`printf` output
for a handful of short lines is one buffered write the kernel accepts
before `grep` is even scheduled, and a `SIGPIPE`'d shell command just
exits 141 with no exception machinery to crash — a difference in the
underlying mechanism's timing window, not a behavioral difference upstream
Bash was ever relying on. This affects every `bin/*.mjs` entry point that
uses `exitAfterDrain` (`chat`, `context`, `identity`, `mem`, `recap`,
`retrieval-step`, `skills`, `thinker-step`, `traj`) whenever its output is
piped into a consumer that stops reading early — a real, previously
undiscovered robustness bug, not scoped to `chat`/`history` at all.

**Classification: PORT-BUG**, fixed at the root (`src/exitAfterDrain.ts`),
not with a per-tool or `src/chat.ts`-local patch, since the bug lives in
the shared drain helper every ported CLI entry point calls through.
`ignoreEpipe()` attaches an `EPIPE`-only-swallowing `"error"` listener to
`process.stdout`/`process.stderr`, installed as a **module-level side
effect** (not inside the `exitAfterDrain` function) so it is live before a
single byte is written — every `bin/*.mjs` shim imports `exitAfterDrain`
before calling the tool's own `run*` function, and ES module imports are
evaluated before the rest of the importing module's body runs, so this
guards every write the tool makes, not just the trailing drain probe. Any
non-EPIPE stream error still throws, matching the pre-existing crash
behavior for a genuine broken-stream condition.

- Failing-test-first: `test/stdout-drain.test.ts` gains a "bug #52" describe
  block — spawns real `bin/context.mjs` (same drain mechanism as `chat`,
  simpler fixture) with a real OS pipe on stdout, then destroys the
  parent's read end immediately (a deterministic stand-in for `grep -q`
  closing early, avoiding the ~20-40% real-world flake rate) and asserts
  exit code 0 with no `EPIPE`/`Unhandled 'error' event` text on stderr.
  Red before the fix (exit 1, `write EPIPE` stack trace); green after. All
  3 `stdout-drain.test.ts` cases pass.
- Direct re-run of the real repro (30 iterations of the actual scratch
  harness technique against `chat history --with`, matching
  `parity/upstream-tests`' own methodology): **0/30 failures after the
  fix** (was flaky, ~20-40% before).
- `parity/chat/run-parity.mjs` re-run against an upstream checkout
  (`PARITY_UPSTREAM_ROOT=<upstream-checkout>`): **96/105 (91.4%),
  same 9 documented deviations, unchanged** — this fix touches a crash
  path `run-parity.mjs`'s own `spawnSync`-based scenarios never exercise
  (no scenario there pipes the port's stdout into an early-closing reader),
  so no regression and no new coverage there; the regression coverage is
  `stdout-drain.test.ts` and the harness re-run above instead.

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green.

### 3. bug #55 — env-reuse liveness: a dead sandbox container ran the whole model loop instead of dying up front

A director-verified 30-min live chaos run (dispatcher SIGKILL of the sandbox
container + thinkers restart) found the port reattaching to a container that
no longer existed and running an entire wake's model loop against it, every
block pre-rejected with docker's own `No such container: …`, instead of
failing before the first model call the way upstream does.

**Root cause**: `env_resolve` (bin/shellm:1304-1339) runs FOUR checks, in
this order, once a stored `container_id` exists — `env_metadata_matches`
(image/var_mounts identity), `docker_container_has_unusable_tool_mounts`
(bin/shellm:722-731), `docker_container_can_reach_path` (bin/shellm:1291-
1298), then `docker_attach`'s own running-state check. `src/sandbox-env.ts`
only ported the first. The port's `startDockerSandbox` (`src/sandbox-
runtime.ts`) went straight from the image/var_mounts check to `DockerSandbox.
isContainerRunning`, and on `false` silently dropped the metadata and created
a fresh container — reasonable-looking, but not what upstream does for the
explicit-env case every thinker wake is in (`--env "${SHELLM_THINKER_ENV:-
$IDENTITY_NAME}"`, thinkers/_lib/common.sh:372): upstream's `explicit=1`
branch `die()`s on checks 1-3, and only reaches its own silent recreate
(`docker_attach` fails the running test, `docker rm -f`, caller recreates
under the same name) for a container that is merely STOPPED, never for one
that's fully gone — for a REMOVED container, `docker_container_can_reach_path`
itself fails first (`docker inspect` errors, zero mount destinations), which
`env_resolve` cannot tell apart from "a live container whose mounts
genuinely don't cover this workdir" — both die with the identical bin/
shellm:1327 text. That incidental-but-load-bearing ordering is what the
port was missing.

**Fixed**: `src/sandbox-env.ts` gains `containerHasUnusableToolMounts`/
`staleToolMountsMessage` and `containerCanReachPath`/
`workdirNotMountedMessage`, porting checks 2 and 3 verbatim (see the file's
"bug #55" header note for the full upstream-order derivation, including why
a dead container is gated behind an explicit `isContainerRunning` check
before the tool-mounts probe rather than relying on `docker exec` failing
open the way upstream's shell does). `startDockerSandbox` now runs both,
`throw`ing upstream's exact `die()` text, between the existing image/
var_mounts checks and the pre-existing `isContainerRunning` reuse-vs-silent-
recreate branch (which now only fires for a genuinely-stopped-but-present
container, matching upstream exactly). The tool-mounts check maps upstream's
three named tools (`llm traj context`) onto this port's real `binDir/{llm,
traj,context}` shim files, gated on the container actually running first
(upstream's own `docker exec` fails identically for "stopped" and "gone",
so treating "not running" as "no unusable mount, check reachability next"
matches upstream's real behavior rather than inventing a distinction it
doesn't make); a tool name absent from the host at this run's `binDir` (e.g.
existing tests' `/usr/bin` stand-in) has nothing to check, matching upstream
never mounting a tool it didn't configure.

**Tests** (`test/sandbox-env.test.ts`, real docker, `DOCKER_CONTEXT=colima`,
skips cleanly without a daemon): (a) a recorded container id that no longer
exists (`docker rm -f`'d out-of-band, the chaos-run trigger) now throws
upstream's exact workdir-mount message, asserted against a fake `LlmClient`
(the same `QueueClient` seam `test/shellm.test.ts` uses) that never receives
a call — proving the failure happens before `runShellm` could reach the
model, replacing the old (now-incorrect) "stale metadata ... dropped and a
fresh container created" expectation for this exact scenario; (b) a live,
running container whose real bind mounts cover a DIFFERENT identity's tree
(two real identities, one env pointed at the other's container) dies with
the identical message; (c) a live container whose `binDir/llm` shim stops
being executable on the host (reflected live through the read-only bind)
dies with upstream's stale-tool-mounts message, before the workdir check
ever runs; (d) the pre-existing "two consecutive wakes reuse the same
container" case proves healthy reuse is unchanged. All four pass against a
real `colima` daemon; the pre-existing image-mismatch, var_mounts-mismatch,
`--temp-docker`, and killall real-docker cases in the same file are
unaffected (9/9 pass).

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green.

### 4. Investigation #56 — `llm: warning: output truncated at max_tokens=1024` firing 84x in the same chaos run (not a port bug)

The same chaos run's monolith log printed `llm: warning: output truncated at
max_tokens=1024 (reasoning tokens count against it) — raise with -t` 84
times; a comparable upstream run printed it 0 times in fewer cycles.

**Where 1024 comes from**: `src/recap.ts`'s `sealTier1`/`sealTierK`
(tiered-rollup sealing) call `llmJson(ctx, ctx.opts.mapModel, ROLLUP_SYSTEM,
text, "1024")` at lines 1415 and 1453 — a byte-exact match for upstream's own
`_llm_json "$MAP_MODEL" "$_ROLLUP_SYSTEM" "$text" 1024` at `bin/recap:566,592`
(and `_llm_json`'s own no-arg default, `${4:-2048}`, matches
`llmJson`'s `maxTokens = "2048"` default too, used for the non-rollup
`WINDOW_SYSTEM` call at line 954). **This is not a port default deviation —
the value is identical on both sides**, so there is nothing to fix here.

**Why 84 vs. 0 anyway**: `lifeContextSection` (`src/monolith.ts:772-825`,
the port's `_life_context`) runs `recap --context` IN-PROCESS on every single
monolith wake (gated only by `MONOLITH_TIERED_MEMORY`, default on), and its
`runLlm` (`defaultRecapRunLlm`, `src/monolith.ts:746-759`) spawns the real
`llm` binary with `stdio: ["pipe", "pipe", "inherit"]` — the child's stderr,
including `llmCli.ts`'s truncation-warning line, is INHERITED straight into
the wake's own stderr, i.e. the monolith log a director reads. Tier-sealing
(`sealTier1`/`sealTierK`) only fires when a wake's rollup building crosses a
new tier-window boundary, so its call FREQUENCY scales with how many wakes
happen, not with anything about the 1024 cap. A 30-minute run driven by
repeated dispatcher SIGKILL + thinkers restart cycles (bug #55's own trigger)
produces far more wake cycles per wall-clock minute than a stable comparison
run, so it crosses far more tier boundaries and fires the identical
`-t 1024` call far more often — a cadence effect of the SAME code path
upstream also runs, not a divergent default and not the model authoring a
`-t 1024` bash command of its own (no evidence of that: `lifeContextSection`
issues this call itself, outside any model-generated block, on every wake
regardless of what the model's own bash did that cycle).

**Verdict**: no fix — the 1024 constant is upstream-faithful (`bin/recap:566,
592` vs. `src/recap.ts:1415,1453`) and the warning's frequency tracks wake
cadence, which bug #55's chaos conditions already explain. No PARITY row
change beyond this note.
### llm --provider adapter: -M JSON gate ran before the LLM_ADAPTER check (bug #57, fix-fuzz-c2 lane)

**The bug**: `bin/llm:1242-1243` checks `LLM_ADAPTER`'s existence/executability
at dispatch time, BEFORE it ever looks at `LLM_MESSAGES` — for `--provider
adapter` bash never JSON-validates `-M` at all (the payload is written to the
adapter's stdin verbatim, `printf '%s' "$LLM_MESSAGES" > "$payload_file"`,
`bin/llm:1265`). `src/llmCli.ts` validated `-M`'s JSON shape unconditionally
at line 1652, before the adapter-executable check further down — so a bad
adapter path with a malformed `-M` died `--messages is not valid JSON`
instead of naming the real problem. Verified directly:
```
OPENAI_API_KEY=k LLM_ADAPTER=/bin/false <HEADLONG_ROOT>/bin/llm --provider adapter -M 'not json'
-> "llm: error: LLM_ADAPTER is not executable: /bin/false", exit 1
```
Pre-fix port: `"llm: error: --messages is not valid JSON"`, exit 1 (same exit
code, wrong reason). Found by `parity/fuzz`'s campaign #2 (fuzz's fixed
`LLM_ADAPTER=/bin/false` fixture never varies to a real executable, so the
port's own -M JSON validation for the adapter path — a stricter-than-bash
safety net, not itself in scope here — never surfaces in this fuzz lane).

**Fixed**: the `LLM_ADAPTER` existence/executability check for `provider ===
"adapter"` now runs BEFORE the `-M` JSON-parse gate, matching bash's dispatch
order exactly. The later adapter block reuses the already-validated path
instead of re-checking it.

**Tests**: `test/llmCli.test.ts` "bug #57: adapter pre-flight runs BEFORE the
-M JSON gate, matching bash's dispatch order" — fails on the pre-fix code
(dies with the `--messages` message instead of the `LLM_ADAPTER` one).

### retrieval RETRIEVAL_MIN_HITS bareword check fired even with no candidate memory (bug #58, fix-fuzz-c2 lane)

**The bug**: bug #45's fix (`src/retrieval.ts`) validates a bareword
`RETRIEVAL_MIN_HITS` UNCONDITIONALLY, before ever checking whether a
candidate memory (`best`/`best.mid`) exists. But upstream's own test
(`thinkers/retrieval/step:60`) is a SINGLE `[[ -n "${mid:-}" && "${hits:-0}"
-ge "${RETRIEVAL_MIN_HITS:-2}" ]] || exit 0` — `&&` inside `[[ ]]`
short-circuits, so when no candidate matched (`mid` empty) the
`RETRIEVAL_MIN_HITS` side is NEVER evaluated and bash falls through to `||
exit 0` cleanly, bareword or not. The port's bareword check ran BEFORE the
`!best || best.mid === ""` gate — the exact inverse of bash's short-circuit
order — so it crashed even in the exact case bash's own `&&` was written to
skip. Verified directly against upstream
(`parity/fuzz/findings/retrieval-c2-1.md`): a trigger sharing no words with
any seeded memory, `RETRIEVAL_MIN_HITS=abc` -> bash exit 0, empty stderr;
pre-fix port exit 1, `retrieval: RETRIEVAL_MIN_HITS: unbound variable`. This
also masked the already-documented `isRetrievalAwkVFamily` deviation in some
instances, since that allowance requires the exit code to already match.

**Fixed**: `src/retrieval.ts` now checks `!best || best.mid === ""` (→
no-op, exit 0) BEFORE looking at `RETRIEVAL_MIN_HITS` at all, mirroring
bash's short-circuit exactly. The bareword-bug-#45 check and the
`RETRIEVAL_MIN_HITS`/`hits` comparison only run once a candidate is known to
exist.

**Tests**: `test/retrieval.test.ts` "RETRIEVAL_MIN_HITS as a bareword is
never evaluated when no candidate memory matched → exit 0, no crash" — fails
on the pre-fix code (exit 1, unbound-variable stderr).

### skills list-json did not escape a raw DEL byte (0x7F) like jq (bug #59, fix-fuzz-c2 lane)

**The bug**: bash's `list-json` is built with `jq`, which escapes a raw DEL
byte (0x7F) in a string as the six-character sequence backslash-u-0-0-7-f;
`src/skills.ts`'s `actionListJson` serialized each skill object with plain
`JSON.stringify(obj, null, 2)`, which passes 0x7F through unescaped (both
are valid JSON — the spec only requires escaping unescaped U+0000-U+001F —
but the bytes differ). Same class of divergence already fixed for `llm`
(this file's "F13 U+007F" row / `llmCli.ts`'s `jqJson` helper) but never
applied to `skills.ts`'s own JSON output path. Verified directly against
upstream (`parity/fuzz/findings/skills-c2-1.md`): a skill whose SKILL.md
body contains a raw 0x7F byte -> bash's `instructions` string reads
the escaped six-character sequence, the pre-fix port's read the raw byte through unescaped.

**Fixed**: `src/skills.ts` gains its own `jqJson` helper (the same one-line
`s.replace(/\x7f/g, "\\u007f")` `llmCli.ts` already uses), applied to
`actionListJson`'s per-object JSON output.

**Tests**: `test/skills.test.ts` "escapes a raw DEL byte (0x7F) in
instructions like jq, not raw-byte-through like JSON.stringify" — fails on
the pre-fix code (the raw byte survives unescaped, the six-character escape sequence is absent).

### traj fork: parent_traj written as the string "null" when forking an empty trajectory (bug #60, fix-fuzz-c2 lane)

**The bug**: bash computes a forked child's `parent_traj` via `head -1
"$parent_file" | jq -r '.step_id'` (`bin/traj:1300`). When `$parent_file` is
EMPTY (no first line at all), `head -1` writes zero bytes and `jq -r`
reading zero JSON documents from empty stdin produces ZERO output (exit 0)
— the `$(...)` captures `""`, so bash writes `"parent_traj":""`. The port's
`jqRawField(tryParseLine(readFirstLineRaw(parentFile)), "step_id")` cannot
tell "no parseable document at all" (empty input) apart from "a real object
parsed, field is absent/null" (jq's genuine `.field | tostring` -> literal
`"null"` case, which `jqRawField` exists to reproduce) — both map to
`undefined` and get the literal string `"null"`. Verified directly against
upstream (`parity/fuzz/findings/traj-c2-2.md`): forking a trajectory whose
file is empty -> bash's child record has `"parent_traj":""`; pre-fix port
wrote `"parent_traj":"null"`.

**Fixed**: `cmdFork` (`src/trajCli.ts`) now reads the parent's raw first
line up front: an EMPTY first line maps directly to `""` (matching jq's
zero-documents-in/zero-output behavior) before `jqRawField` is ever called;
a non-empty, parseable line still goes through `jqRawField` exactly as
before, preserving the genuine "field absent from a real object" ->
literal `"null"` case. (A non-empty, UNPARSEABLE first line is bug #61,
fixed alongside this in the same block.)

**Tests**: `test/trajCli.test.ts` "bug #60: forking a trajectory whose file
is EMPTY writes parent_traj:\"\", not the string \"null\"" — fails on the
pre-fix code (`parent_traj` is the string `"null"`).

### traj fork: silently forked past an unparseable existing trajectory instead of dying like bash's jq crash (bug #61, fix-fuzz-c2 lane, jq-internal-error allowance)

**The bug**: when `$parent_file`'s first line is non-empty but not valid
JSON, bash's `head -1 "$parent_file" | jq -r '.step_id'` (`bin/traj:1300`)
makes jq itself parse-error and die (exit 5, no stdout) — under this
script's `set -euo pipefail`, that aborts the WHOLE `fork` before any child
directory is created or the parent file is touched (same jq-internal-error
family as bug #48's `last`/`search`, PARITY.md's existing allowance for that
row). The port's `cmdFork` had no equivalent validation: it read whatever it
needed from the unparseable line (`tryParseLine` silently returning
`undefined`) and completed the fork anyway — a new child directory created,
a `type:"fork"` record appended on top of already-corrupt data. Verified
directly against upstream (`parity/fuzz/findings/traj-c2-3.md`): a
trajectory whose only content is `not-json-at-all{{{` -> bash exits 5 with
jq's parse-error text, no child created, parent file unchanged; pre-fix port
exited 0, created a child, and appended a fork record.

**Fixed**: `cmdFork` now throws `TrajExit(5, ...)` — the same pattern bug
#48 established for `last`/`search` — when the parent's first line is
non-empty but fails to parse, BEFORE any child is created or the parent file
is touched. Only the EXIT CODE (5) is matched, not jq's own parse-error
wording, per the existing jq-internal-error allowance.

**Tests**: `test/trajCli.test.ts` "bug #61: forking a trajectory whose only
content is malformed JSON dies like bash's jq crash (exit 5), no child
created" — fails on the pre-fix code (exit 0, a child directory created).

### traj tail -n <negative>: slice(-n) inverted the sign instead of taking |n| (bug #62, fix-fuzz-c2 lane)

**The bug**: coreutils' `tail -n N` treats a leading `-` on the count as
idiomatic, not sign-inverting — `tail -n -2` and `tail -n 2` both mean "the
last 2 lines," clamped to however many lines exist (bin/traj shells out to
real coreutils `tail`). `tailLastN` (`src/trajCli.ts`, the function bug #51
fixed for `n === 0`) computed `arr.slice(-n)`; for `n = -2` (`-n -2` parsed
via `Number("-2")`), that becomes `arr.slice(2)` — "skip the first 2 items,
keep the rest" — the opposite of "last 2." The port's own bug-#51 comment on
this function acknowledged "bash's own negative-N-means-positive-N
coreutils quirk" but left it exactly as `.slice(-n)` computed it, which is
itself wrong for negative `n`. Verified directly against upstream
(`parity/fuzz/findings/traj-c2-5.md`): a 1-line trajectory, `tail -n -2` ->
bash prints the one available line, exit 0; pre-fix port printed nothing.

**Fixed**: `tailLastN` now slices by `Math.abs(n)` (`arr.slice(-Math.abs(n))`),
so a negative `n` behaves identically to its positive counterpart — bash's
"last N lines regardless of sign" semantics — while `n === 0` still
special-cases to `[]` (bug #51, unchanged) and every positive `n` computes
exactly as before.

**Tests**: `test/trajCli.test.ts` "bug #62: -n <negative> means the last |n|
lines, not slice(-n)'s sign-flip" — fails on the pre-fix code (prints
nothing instead of the one available line).

Gate: `npx tsc --noEmit -p tsconfig.json` and `-p web/server/tsconfig.json`
clean; full `DOCKER_CONTEXT=colima npx vitest run` green; `test/
scrub.test.ts` clean (no absolute local paths in any new test fixture).

### Stage 3b real-model findings (branch `fix/stage3b-findings`)

Source: a stage-3b real-model run, port vs upstream (pinned `2e39a3f`). Four findings, one decision each.

| # | Finding | Decision | Source (port ⇄ upstream) |
|---|---------|----------|--------------------------|
| 1 | The system prompt tells the mind to run `shellm` (sub-runs, `src/assets/shellm-system-prompt.txt:211`) but the port shipped no `bin/shellm`, so every such call was `command not found`. Upstream's `bin/shellm` IS that command: from a wake shell it starts a NESTED run (own trajectory with `parent_traj`/`parent_step`, a `fork` step on the parent, a `merge` step back with the child's final answer, final answer on stdout, exit 0 on final/no-block else 1). | **FIXED — `bin/shellm` + `bin/shellm.mjs` + `src/shellmCli.ts`.** Argument parser, usage text, `--print-system-prompt`, new/`--traj`/`--resume`/nested trajectory, stdin and `-f` context (`$CONTEXT`, `$FILE_CONTEXTn`), `--var`, then the in-process `runShellm`. `runShellm` now puts `_SHELLM_PARENT_TRAJ_ID=<this traj>` (and blank `SHELLM_TRIGGER_STEP_ID`/`SHELLM_LAUNCHED_BY`/`SHELLM_RUN_ID_OUT`, plus `SHELLM_SANDBOX=local` for a local run) in every run's exec env, so a `shellm` the mind runs is nested. `shellm` is now also on the monolith's synthesized tool list (`src/monolith.ts` `BIN_TOOL_NAMES`), as upstream's `command -v shellm` finds it. Tests: `test/shellmCli.test.ts` — `--help` byte-identical to upstream's, `--print-system-prompt` identical to upstream's with machine facts masked, unknown-option error, plain run (stdin+`-f`), nested run (child traj `parent_traj`, parent gets `fork`+`merge`). | port `src/shellmCli.ts`, `src/shellm.ts` (baseEnv) ⇄ `bin/shellm:276-390` (usage), `:2540-2650` (trajectory), `:2672-2700` (context), `:3085-3125` (parent env), `:3395-3480` (merge), `:3515-3660` (args) |
| 1 | Not ported (documented deviations): `--env`/`--new-env`/`--temp-docker`/`--bin` are accepted and ignored apart from `--env` (named via `SHELLM_ENV`); a nested run's sandbox is `local` when the parent is local, else `selectSandbox`'s auto choice; the merge step for a run that hit the iteration cap/stall is the upstream text without its `from_step_ref` extras. | DEVIATION | port `src/shellmCli.ts` ⇄ `bin/shellm:3395-3480` |
| 2 | Stall error: the port wrote a fixed string with a `source` field. Upstream's step is `{type:"error", content:"shellm killed this run: the agent stalled — <actual reason> (last exit=N). <guidance>", run_id, reason}` (no `source`) and prints `<ISO> [shellm] STALL: … aborting run <id> to stop a spin.` to stderr. A guard set to 0 is OFF upstream (`[[ MAX -gt 0 && n -ge MAX ]]`). | **FIXED** to the exact text/fields/stderr line/`>0` guards. `RunShellmResult.stallReason` carries the reason (used by the nested merge step). Tests: `test/behavioralParityS3b.test.ts` (repeat-failure and consecutive-failure with `maxRepeatFailures:0`). | port `src/shellm.ts` stall branch ⇄ `bin/shellm:3447`, `:3453` |
| 3 | Goal deleted by the port's mind at +4.6 min ("guide complete"); upstream's kept its goal. | Compared goal prompt text, GOAL REVIEW hint (`thinkers/monolith/step:254-260`), menu text, goals rendering (`thinkers/_lib/common.sh:303-335`: ages, `until`, order, cap 8) and command semantics (`mem forget`/`mem edit`): identical, EXCEPT one real divergence found by the new seeded-goal harness: `bodySnippet` kept the trailing newline so goal bullets were separated by blank lines in the model's prompt (`$(...)` strips trailing newlines; `sed '/./,$!d'` drops only truly empty lines). **FIXED** (`src/personMemory.ts` `bodySnippet`). The harness (`parity/behavioral/run-parity.mjs` `seedWorld`) now seeds a goal, an intention and a todo-with-`until`; the exact task-message checks diverged before the fix and are PARITY after (43/48 PARITY, 5 documented `focus` DEVIATION, 0 DIVERGE). The deletion itself is **not explained by any prompt difference** — recorded as a model choice (the formatting divergence is the only candidate trigger and is now gone). | port `src/personMemory.ts` ⇄ `thinkers/_lib/common.sh:318` |
| 4 | exit-0/FINAL loop: a model that answers without a fenced block, or sets FINAL, ends the run. | **Unchanged on purpose** — identical to upstream (`src/shellm.ts` ~590, ~885-895 ⇄ `bin/shellm:2909`, `:3063-3072`). Operators bound runs with `SHELLM_MAX_ITERATIONS` (config), same as upstream. | — |

#### Harness flake: card-like random ids in the behavioral task-message check (not a port divergence)

Symptom: ~1 in 5 early runs, the exact task-message check of `parity/behavioral/run-parity.mjs` showed `run_id=<ID><redacted:` on the port side (wake 2/3). Root cause: the wake prompt is credential-redacted (port `src/promptRedact.ts:36`; upstream `thinkers/_lib/common.sh:822`, `prompt_redact`) and both carry the same card shape `(^|[^0-9])[0-9]{4}([ -][0-9]{4}){2,3}([^0-9]|$)`. A random uuid whose segments 2-4 are all digits (measured 1588/200000 = 0.79% per uuid) is read as a card number and printed `abcdef12-<redacted:card>-aabbccddeeff`. Each engine mints its own random `run_id`/`step_id`, so one side occasionally carried the marker and the other did not. Both engines produce byte-identical output for the same id (`test/behavioralParityIdRedaction.test.ts`, differential against the real `prompt_redact`). Fix is in the harness only: `parity/behavioral/normId.mjs` `maskIds` absorbs the marker inside an id (`normUser` uses it). No port change; the redaction itself is faithful.

### Stage 5 findings: `HEADLONG_TS_HOME` in the mind's shell; `thinkers status` in a nested pid namespace (branch `fix/home-env`)

| Finding | Decision | Source (port ⇄ upstream) |
|---|---|---|
| `thinkers step retrieval` typed in the mind's wake shell died `HEADLONG_TS_HOME not set`: the shipped step files (`src/assets/thinkers/*/step`, lines 8-11) are Node shims that locate `bin/thinker-step.mjs` through that variable, which only the dispatcher's env carries (`src/identity-env.ts:106`). Upstream's Bash steps resolve their own helpers from their realpath (`thinkers/retrieval/step:27-30`, `source $SCRIPT_DIR/../_lib/common.sh`) and run from any shell. | **FIXED, two layers, no new variable exported into the wake env.** (1) `thinkersStep` (`src/thinkersctl.ts`, `thinkers step <name>`, ⇄ `bin/thinkers:1664-1685`) supplies this checkout's path as `HEADLONG_TS_HOME` to the step it spawns when the caller's env has none; an explicit value is left alone. This also repairs identities installed before this change (their step files are COPIES). (2) The shipped step files fall back to the port's `bin/` on `PATH` (every wake shell carries it first; `src/shellm.ts` baseEnv) when the variable is unset, so a step run directly works too. Chosen over exporting the variable via `applyLocalInheritedEnv`: upstream's wake env carries no such variable, and Docker wakes (which get only `--var`s) would still lack it. Tests: `test/thinkersctl.test.ts` (step from an env without the variable; each shipped step run under a clean env with only the port's bin on PATH — red before, green after). | port `src/thinkersctl.ts`, `src/assets/thinkers/*/step` ⇄ `thinkers/retrieval/step:27-30`, `bin/thinkers:1664-1685` |
| `thinkers status` printed `Dispatcher: stopped` for a running dispatcher inside a nested pid namespace. | **No change; harness-only.** Detection is the same on both sides: the `run/dispatcher.pid` file plus `kill -0` (port `thinkersStatus`, `src/thinkersctl.ts` ~758, `pidAlive` `src/runstate.ts:79`; upstream `cmd_status`, `bin/thinkers:1890-1908`) — no `pgrep`. A pid that the namespace cannot see gives ESRCH on both. One known edge: the port's `pidAlive` also counts EPERM (pid owned by another user) as alive, upstream's `kill -0` reports failure there; irrelevant to the stage-5 case and left as is. | port `src/thinkersctl.ts`, `src/runstate.ts` ⇄ `bin/thinkers:1890-1908` |

### Runtime is Bun (branch `feat/bun-runtime`) — DEVIATION, observable behavior unchanged

| Item | Decision | Evidence |
|---|---|---|
| The port ran on Node (`#!/usr/bin/env node`, vitest on Node). The maintainer chose Bun. | **Bun is the runtime; Node is the documented fallback.** `engines.bun >= 1.4.4` (latest stable on 2026-10-28; the macOS machine had 1.3.3, the box 1.4.2, tested with a local 1.4.4 copy), `engines.node >= 22.18.0` kept. No build change: Bun runs the `.mjs` shims and imports their `.ts` modules directly (the existing "shim runs from source" property), `tsc` stays the typecheck and build. | see below |
| Launchers. | Extensionless tool launchers in `bin/` (and the files they link to) and the three shipped `thinkers/*/step` files start with `#!/bin/sh` + `":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun \|\| command -v node)}" "$0" "$@"` (valid sh and valid JS), so they pick `$HEADLONG_TS_RUNTIME`, else bun, else node. This is why a Docker sandbox (image `node:24-bookworm`, no Bun) still runs every tool, on Node. Other `bin/*.mjs`, `install.mjs`, `status.mjs`, `uninstall.mjs` use `#!/usr/bin/env bun`; `node file.mjs` still works. `parity/*` scripts keep the Node shebang and are run with whichever runtime you call. Identities installed before this change keep their old `#!/usr/bin/env node` step copies (they run on Node; `thinkers step` still supplies `HEADLONG_TS_HOME`). | `src/runtime.ts`; `test/identity-new.test.ts` |
| Child processes. | The port's own spawns (`src/thinkersctl.ts` dispatcher + drain, `src/responder.ts` notes script, `src/skills.ts` manager, `bin/mem.mjs` worker + heartbeat) use `runtimePath()` = `$HEADLONG_TS_RUNTIME` or `process.execPath` (the running runtime), so parent and children never mix runtimes. `src/shellm.ts` and `src/identity-env.ts` still put `dirname(process.execPath)` first on the wake PATH. | `src/runtime.ts` |
| Evidence, final (2026-10-28, macOS arm64, Node 22.22.3 vs local Bun 1.4.4). | **Full vitest suite, after all test edits: Node 135 files passed + 1 skipped, 2381 passed / 4 skipped (= baseline). Bun (`bun --bun vitest`): the same 2381 passed / 4 skipped, plus 1 unhandled `EPIPE` error.** `parity/sandbox/run-parity.mjs`: identical on both (shape 9/9, differential 7/7 PARITY, loopback-rewrite and real-daemon proof PASS). `parity/daemon/run-parity-adversarial.mjs` (`PARITY_HEADLONG_ROOT` set): identical on both, 88 checks, 84 parity, 4 documented deviations, 0 DIVERGE (the run exits 1 only because of 3 stale `dispatcherd` processes from an earlier session, see below). `parity/behavioral/run-parity.mjs` (the shellm loop, task message and request differential): 43 PARITY, 5 DEVIATION, 0 DIVERGE on both. `parity/upstream-tests/run.mjs`: Node and Bun output byte-identical. `--help` of ten CLIs byte-identical. Startup, median of 20 (ms) Node 22 / Bun 1.3.3 / Bun 1.4.4: traj 73/36/22, mem 93/24/19, shellm 136/47/31, llm 112/33/29, thinkers 65/24/18, skills 83/34/30. **`test_mem_search` (17/18) and `test_traj_cycle_reads` (exit 127) were an environment change, not the port or the runtime:** both scripts call GNU `timeout`, which is no longer on this Mac's PATH (`which timeout gtimeout` empty). With a scratch stand-in on PATH they pass on c31c97b under Node (18/18, exit 0) and on this branch under Bun (18/18, exit 0), control side too. `test_rollup_namer_limits` 34/40 is the TEST-METHODOLOGY MISMATCH already recorded in the 2026-10-27 report, unchanged. **Bun-only `EPIPE`:** deterministic in isolation, from the `controls: thinkers start/stop` test (`web/server/test/controls.test.ts:235-266`, through `web/server/src/control.ts:183-225` into `src/thinkersctl.ts:300`). The stack is Bun internals only (`internal:fs/streams:358 finalFast`), no frame of ours; every assertion passes; it is the same with the child on Node or on Bun; the library-level `test/thinkersctl.test.ts` has none on Bun. Not fixed, not a behavior difference. | scratch runs, 2026-10-28 |
| Not covered. | `web/server` (its own package; `control.ts:345` spawns `process.execPath`, one vitest `EPIPE` unhandled error appears when the suite runs on Bun, `web/server/test/controls.test.ts`) and `install.mjs`' own `process.execPath` hand-offs are unchanged. Docker wakes run the tools on Node unless the image has Bun. | |

### Gapcheck findings (branch `fix/gapcheck-findings`, from the box differential `gapcheck/REPORT.md`, 2026-10-28)

Source: a $0 scripted differential (same state, same 53-step wake, identical replies) of port `c31c97b` vs upstream `2e39a3f` in the box's bwrap sandbox. It found the model-facing observations byte-identical and the request 205 B smaller on the port (a constant), plus three small things recorded here.

| Item | Decision | Evidence (port ⇄ upstream) |
|---|---|---|
| **1. Bash error text said `line N+1`** (unknown command, syntax error, `$LINENO`). | **Port bug, FIXED.** `LocalSandbox.exec` ran `"exec 2>&1\n" + wrappedCode`: a whole extra leading line, so every line number bash printed (and every `$LINENO` the model's code printed) was +1 against upstream's `bash -e -c "$wrapped_code"` whose first line is `set -x`. Now `exec 2>&1; ` rides on that same first line. Two more differences in the wrapper, found by the new harness, also fixed: upstream's wrapper has a blank line after `set +x` (moves the "unexpected end of file" line), and the final path is written double-quoted (`> "$final_path"`) where the port single-quoted it (an unbalanced `'` in the model's block paired differently with the wrapper's quotes: a different EOF line). `src/sandbox.ts` `LocalSandbox.exec`, `src/shellm.ts` `buildWrappedCode`/`dq` ⇄ `bin/shellm:1631`, `3065-3073`. | New differential `parity/execlines/run-parity.mjs`: real upstream `bin/shellm` end to end (`SHELLM_ENV=local`, scripted `llm`) vs `runShellm`, same bash on both sides (macOS `/bin/bash` 3.2 numbers `-c` lines from 0, so the harness pins one PATH). **Before: 2/12 byte-identical; after: 12/12** (unknown command at line 1/2/5, two syntax errors, unterminated `if`, unterminated quote, `$LINENO`, heredoc then unknown command, function-body error, `set -e` exit, stderr redirect). New unit test `test/execLineNumbers.test.ts` (11 tests, 10 fail on the old code, all pass now; runs the upstream wrapper shape with the same bash as oracle). Docker path unaffected (it has no extra line: the supervisor runs the wrapped code as is). Harness normalises one thing: the port's recorded `shell-output.stdout` keeps a trailing newline that upstream's `$(cat …)` (`bin/shellm:3286`) strips (trajectory text only; the model-facing observation was already byte-identical in the gapcheck). |
| **2. Rollup calls: port 4 in 16 wakes, upstream 3 in 8.** | **Same logic; no change.** A rollup is sealed only when F^k filtered steps complete a block at or after the enable marker, at most `ROLLUP_MAX_SEALS` (20) per `recap --context` call: it depends on how many filtered steps exist when a wake starts, never on wake count or time. Port `src/monolith.ts` `lifeContextSection` → `src/recap.ts` `ctxBuild`/`buildPlan` (`src/rollups.ts`) ⇄ `thinkers/_lib/common.sh:643-651` → `bin/recap` `_ctx_build` (660-690). | The gapcheck's own files: both arms sealed the same blocks (t1 `[280,290)`, `[290,300)`, t2 `[200,300)`) and the port also `[300,310)`, because its rendered (filtered) trajectory reached 313 rows and upstream's 305, i.e. the port ran about 2× the steps (848 vs 424 model calls in 300 s: the engine-speed difference, finding 5 of the report). 313 ≥ 310 > 305. New differential `parity/recap/run-seal-trigger.mjs` grows one trajectory wake by wake (enable mid-history, exact fanout boundaries across tier 2, a 450-step backlog over the 20 cap, cap 0, cap 3 with fanout 4, 40 tiny wakes) and runs the monolith's exact `recap --context --raw-tail 0 -q` per wake against real `bin/recap` and the port: **6/6 scenarios identical on every wake** (per-wake LLM call count, block files, staircase text). |
| **3. Wake-up note omits the systemd sentences.** | **DOCUMENTED DEVIATION, kept.** Upstream's note (`bin/thinkers:1500-1503`) adds `; systemctl status headlong-thinkers@<name>` and a closing `To restart yourself safely …, run: sudo headlong-thinkersctl restart <name> — systemd completes the restart …`. This port ships no `deploy/` and no `headlong-thinkersctl`, so the advice would point the mind at a command that does not exist. Port `src/thinkersctl.ts` `appendWakeGapNote` (PORT-NOTE added) ⇄ `bin/thinkers:1485-1505`. | Cost of matching: +236 B once per dispatcher start (gapcheck finding 3: note 422 B port vs 658 B upstream). Other constant request-size differences from the same finding, all in the first user message: Runtime line +8 B (commit text), Workspace path +19 B (port workdir `$ID/.shellm/workdirs/<root>-root` vs upstream `$ID/workdir`, `src/steprun.ts:106` ⇄ `thinkers/monolith/step:39`); nothing on the port side is larger. |

## Port extensions for embedders (2026-10-29)

One addition with no upstream counterpart. It leaves every upstream input unchanged (all existing differential and unit tests pass
unchanged); it only acts on names upstream never produces.

Not here, by design: DeepSeek's DSML tool-call text. Provider-specific markup stays out of the engine; an embedder that needs it rewrites it to a ```bash fence in its own provider proxy, so `src/extract.ts` stays upstream's `normalize_toolcall_markup` unchanged.

| Extension | Upstream | Port | Why | Evidence |
|---|---|---|---|---|
| **Team-room routing names** `room~<room>~<sender>` and `room~<room>` | A bridge packs place into the routing name: `slack-<user>-<channel>-<thread_ts>` gives person key `slack:<user>` and thread key `slack-thread:<channel>-<ts>` (`bin/chat` `_PERSON_KEY_JQ`/`_person_key`/`_thread_key`, lines 440-460; `thinkers/responder/step` history + thread union) | `src/personMemory.ts` `TEAM_ROOM_RE`: person key = the sender, thread key = `room:<room>`; the responder's existing history + thread union (`src/responder.ts` `queryHistory`, `buildConvoSel`) then shows a room reply every post in that room, other bots' and the mind's own | An embedder delivered room posts from the plain sender id, so a mind answering in a room saw only the asker's lines ("Atlas's activity suggestion isn't in this thread", real DeepSeek run 2026-10-29). `~` because room and bot ids may contain `-` | `test/teamRooms.test.ts` (keys; a room reply's turns include the other bot's post and the mind's own, not another room's, trigger once) |

## Replay seam removal and K1-K3 (2026-10-29, branch feat/no-replay-seam)

**Replay seam removed.** `HEADLONG_LLM_REPLAY` / `HEADLONG_LLM_REPLAY_<THINKER>` were port inventions (upstream has no
such switch). `src/steprun.ts`'s `buildLlmClient` now always builds the real `llm` client; with no key and no
`LLM_API_URL` it fails ("no API key … or LLM_API_URL set"), and the old variables are ignored (test/steprun.test.ts
"HEADLONG_LLM_REPLAY is ignored"). The suites that used it (steprun, shellmCli, person-notes-lock,
responder-notes, progress-logs, live-loop, plus web/server e2e-live) now answer through `test/llmFakeServer.ts` over
`LLM_API_URL`, the same way upstream's `tests/test_llm_retry.sh` does. The in-process `ReplayClient` was later removed from `src/llm.ts` too (release v0.1.0): the golden-trace
mirrors (characterization, monolith, topology) now serve their replies from `test/support/modelHttpFixture.ts` over HTTP.

**K1 — `LLM_CONNECT_TIMEOUT` bounded the wait for the first byte.** Upstream passes it to curl as
`--connect-timeout` (bin/llm:102,1424-1425), which bounds the TCP/TLS connect only. The port armed a timer until the
response headers arrived, so a slow-to-answer model was cut off. Fix (src/llmCli.ts): no headers timer; the stall
timer runs from the start. Evidence: test/upstreamDiffK123.test.ts K1 (server sends headers after 2.5 s,
`LLM_CONNECT_TIMEOUT=1`): upstream `bin/llm` exits 0 with the body; the port failed before the fix and now matches.
test/llmCli.test.ts's old "aborts before headers arrive" test (which pinned the bug) was replaced.
**K1 review correction (2026-10-29, independent review).** f0435e0 relied on undici's built-in 10 s connect timeout and
left a non-default `LLM_CONNECT_TIMEOUT` unapplied. Measured on the macOS development machine against an unroutable address: upstream
fails at 3 s / 10 s for `LLM_CONNECT_TIMEOUT=3` / `10`; the port under Node failed at 10-11 s for any value, and under
Bun (what `bin/llm.mjs` runs when `bun` is on PATH, as on that machine) after 60 s, ended only by the stall guard —
Bun's fetch has no connect timeout. Fix (src/llmCli.ts `startAttempt`): a plain TCP connect to the request's host:port
runs beside each attempt; `LLM_CONNECT_TIMEOUT` aborts the attempt only if that connect has not completed (the first
response byte also clears it). It still never bounds the wait for the first byte. Remaining deviation: curl's timer also
covers the TLS handshake; this one covers TCP only. Evidence: test/upstreamDiffK123.test.ts "LLM_CONNECT_TIMEOUT=2 still
bounds a connect that never completes" (node and bun; red before this fix: 11 s and 60 s; skipped as inconclusive where
the address is refused at once) and "the header wait is still bounded by the stall guard" (`LLM_SPEED_TIME=1`, headers
after 6 s: both sides fail before the headers). `parity/llm/run-parity.mjs` with `PARITY_BASH_LLM` = upstream
`bin/llm` (macOS, 2026-10-29): **281/281 effective, 259 identical + 22 documented deviations, 0 PORT BUGS**; the former
`connect-timeout-approx` deviation (`stream/connect-timeout-fast-connect-slow-response`) is now byte-identical.
On Linux (clean release export, 2026-10-29) the same run gave 280/281 until the `jq-crash-nonjson-200` deviation
also listed `state`: upstream's `set -e` abort skips its temp-file cleanup, and GNU mktemp puts that file inside the
captured sandbox, so upstream leaves the response body behind as `tmp/tmp.XXXXXXXXXX`. With that documented: **281/281
effective, 0 PORT BUGS** on Linux too. Behavioral parity on Linux: 43 PARITY, 5 DEVIATION, 0 DIVERGE.

**K2 — nested `shellm` ignored `TRAJ_DIR` and did not nest.** Upstream: trajectory dir
`${SHELLM_TRAJ_DIR:-${TRAJ_DIR:-$home/trajectories}}`, a new run is `traj new --slug "${prompt:0:200}"` plus the parent
fields, giving `<parent dir>/<hex8>-<slug>/` with `parent_traj_ref` (bin/shellm:47,2609-2614). The port wrote a flat
`<hex8>-root` under `$HEADLONG_HOME/trajectories`. Fix (src/shellmCli.ts): same dir precedence; a new run goes through the
port's `traj new` (src/trajCli.ts); run name and merge `from_traj_ref` from its output; the merge is appended to the
parent's resolved file.

**K3 — nested runs never wrote their summary.** Upstream starts `generate_run_summary` for every new trajectory and
cleanup waits up to 30 s (bin/shellm:2366-2440). New src/runSummary.ts ports it (model choice, 20000-char prompt cap,
JSON parse with fence strip, `(summary generation failed)` fallback); src/shellmCli.ts starts it at the header and waits
up to 30 s.

Evidence for K2+K3: test/upstreamDiffK123.test.ts runs upstream `bin/shellm` and the port's `shellm` against one
local endpoint with `TRAJ_DIR` set and `_SHELLM_PARENT_TRAJ_ID`: compared the child dir pattern
(`<parent>/<hex8>-write-hello`), the first step's keys, `parent_traj`, `parent_traj_ref`, the `run-summary` step (tldr,
full_summary, run_id, model) and the summary call count. Before the fix upstream passed and the port failed; now both
match (2/2 passing, `PARITY_UPSTREAM_ROOT` set; skipped without it).

**Per-wake prompt rendering (the former "only remaining stub").** `runStep` calls `buildIdentityConfig` on every wake
(src/steprun.ts:261), which renders `identity prompt` and `skills prompt` from the identity dir. The behavioral harness
compares that task message exactly against upstream's real `thinkers/monolith/step`: `parity/behavioral/run-parity.mjs`
re-run on 2026-10-29: **43/48 PARITY, 5 DEVIATION (documented), 0 DIVERGE**. The last static blob, in the manual
`scripts/real-wake.ts`, now uses `buildIdentityConfig`. Closed.

**Suite (box, 2026-10-29):** 2362 passed / 34 skipped / 5 failed; the 5 failures are the same box-only ones as the
unmodified base on the same box (llmCli bug #57, shellm watchdog bug #33, web controls killall dry_run, killall docker
fixture, chatGuards lock takeover).
**Upstream-tests runner (box, 2026-10-29, main lane, `--daemon` not run):** `node parity/upstream-tests/run.mjs` against
upstream 2e39a3f: 80 suites, port result identical to the committed 2026-10-27 report for every suite. Two rows
changed on the control side only (`test_prompt_file.sh` 4/4 → 5/5 on both sides; `test_contrib_opencode.sh` control
TIMEOUT → 267/267, no port CLI). This runner leaves `bin/shellm` as upstream Bash, so K2/K3 are covered by
test/upstreamDiffK123.test.ts, not by it. The committed report.md is left at 2026-10-27 (it includes the daemon lane).

## Public interface: src/api.ts (2026-10-29, branch feat/public-api)

Not an upstream module: upstream's embedding surface is its CLIs and on-disk files. `src/api.ts` is the port's one
supported import (package.json `exports["."]`); everything else under `src/` is internal. It wraps existing code
without changing behavior, and `docs/CLI.md` / `docs/FORMATS.md` document the CLI and file contracts it sits beside.

| Export | Wraps | Note |
|---|---|---|
| `resolveIdentityEnv`, `runDir`, `rootTrajFile`, `appendStep` | `identity-env.ts`, `runstate.ts`, `trajCore.mjs` | unchanged |
| `appendHistory` | `trajCore.withLock` (now exported), `trajRedact`, `wakeLedger` cursor | new composite: message rows with their own `ts`, deduped on `step_id`/`origin_step_ref`, a saved feeder cursor moved past them |
| `deliverMessage`, `findDelivery` | `trajCore.withLock`, `trajRedact` | new composite: one `chat send`-shaped row per (to, origin step), check and write under one lock |
| `writePersonNote`, `readPersonNote`, `notesPrompt`, `RESPONDER_NOTES_MAX` | `responder.ts` (`writePersonNoteFile` factored out of `updatePersonNotesLocked`, byte-identical output; `notesSystemPrompt`, `NOTES_MAX` exported), `personMemory.ts` | |
| `chatHistory`, `wakeCursorOffset`, `memoryId`, `extractCode`, `FORWARDED_ENV_KEYS` | `messageIndex.ts`, `wakeLedger.ts`, `mem.ts parseFilename`, `extract.ts`, `sandbox-runtime.ts` | unchanged |

Tests: `test/api.test.ts` (each export), `test/api-deliver.test.ts` (a delivered message wakes a real Dispatcher/TrajFeeder
once, a re-delivery does not, two recipients both wake, `_ref` fields stay out of `buildContext`).

## Fixture change for release: place name in the golden traces (2026-10-29)

The city named in the captured traces (`golden/trace-01`, `-02`, `-04`, `golden/trace-05-retrieval`) and in the data
derived from them (`parity/retrieval/results.json`, `parity/ui/golden/*.json` and `mindlog.json.gz`, `test/fixtures/rollups/t1`,
`test/topology.test.ts`, `scripts/real-reactive.ts`) was replaced with "Springfield" before publication. One memory
file name changed with it, and `golden/trace-05-retrieval/index.tsv` was rebuilt with upstream's own
`thinkers/retrieval/build-index.sh` over the renamed memories (same 462 rows, re-sorted). Nothing else in the traces
changed; every test that reads them passes unchanged.

## Upstream-oracle recordings round (2026-10-29, rec/lane-a + rec/lane-b + rec/lane-c → rec/integrate)

Every test and parity harness that needs a model now gets real recorded DeepSeek replies (labelled with source, date
and model) over the real `LLM_API_URL`. For harnesses, upstream and the port are served from one replay server. HTTP
transport cases are labelled fixtures, and parser-on-literal cases are no-model parser layers. Those layers cut
upstream's code at run time by markers, pinned by byte length and sha256. Provenance: `test/support/README.md`.

**Port fixes found this round**
- responder: the reply call's `llm` stderr reaches the step's stderr, as `_reply_llm`'s `cat "$err" >&2` does (63d8a16).
- shellm: the recorded thought drops only trailing newlines, and a fenceless reply's cmd keeps its leading blank lines,
  like upstream's command substitutions (21f6632).
- recap: a reply holding several JSON values ends the way upstream's does (argjson abort, exit 2), not with the last
  value (260960d).
- bin/* under Bun: stdout/stderr bytes were lost at `process.exit` (a 1.8 KB `llm` reply cut mid-text under load,
  65,295 of 200 KB to a slow reader). Every tool now writes synchronously under Bun (031f79b, 9c31207;
  `test/bun-stdio-flush.test.ts`).

**Documented deviation added**
- recap capped >1 MiB stream: upstream `bin/llm` appends each pre-data SSE line to `_err_buf` (quadratic), so a
  well-formed stream of 49,152 keep-alive lines takes minutes per attempt; the port reads it linearly (d7e2d9f, row above).

**Harness bugs fixed**
- parity/retrieval: four scenarios surfaced nothing on either side (upstream greps the whole seen file), so they passed
  vacuously. Each now writes a fresh unseen memory first (d0d67c9).
- parity/init: its in-process endpoint could never answer while both sides ran under spawnSync, so the 3
  local-provider scenarios were skipped on every run. The endpoint is now a child process; 7/7 + 3 skipped became
  10/10 (b1476b5).

**Numbers on rec/integrate (replay only, no recordings, $0)**

| Harness | Result |
|---|---|
| full suite | 2416/2439 and 2421/2444 passed (23 skipped), 2 runs |
| llm | 281/281 (259 identical + 22 documented) |
| llm adversarial | 235 PARITY, 38 DEVIATION, 5 DIVERGE: upstream's `jq` crash leaves a `tmp.*` file in the sandbox (`state`); committed baseline had 43 DEVIATION, 0 DIVERGE; port side unchanged |
| responder | 83/85 (the 2 PEM redaction divergences) |
| behavioral | 75/81, 6 DEVIATION, 0 DIVERGE |
| extract | 87/87 |
| execlines | 12/12 |
| retrieval | 32/32 (2 documented-deviation scenarios) |
| recap main / parser / seal-trigger | 37/39 (2 documented `${2:?}` messages) / 18/18 / 7/7 |
| recap adversarial | 136 PARITY, 14 DEVIATION, 0 DIVERGE |
| mem | 191/205 (as committed) |
| init | 10/10 |
| fuzz recap / mem (100 each, seed 1) | 97 + 3 allowed / 89 + 9 allowed + 2 findings: `mem types` with an absent `MEM_DIR` exits 2 upstream, 1 in the port (fixed afterwards in 536c64d: the port now returns `ls`'s own cannot-access status, 2 with GNU ls, 1 with BSD/macOS ls) |
| slack / telegram | 42/42 / 36/36 |

