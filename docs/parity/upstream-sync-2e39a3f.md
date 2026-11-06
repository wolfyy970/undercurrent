# Upstream sync 2e39a3f (historical)

> **Historical.** Sync from `5458fee` → `2e39a3f`. Overview: [`PARITY.md`](../../PARITY.md).

## Upstream sync 2e39a3f (5458fee → 2e39a3f)

Branch `sync/upstream-2e39a3f` (never merged to `main` by this work; local only). Upstream
checkout used as the oracle: `laude-institute/headlong` at
`2e39a3f39fb9acbd0d73f6b0aecc9f83dc14547e`, read-only. Method is the repo's usual one: read the
upstream diff per area, port with a `PORT-NOTE:` on each semantic decision, extend the
differential harness (real Bash/Python vs the port) and run upstream's own Bash suites against
the port. No golden trace or characterization expectation was loosened; the only oracle edits
are the three stale unit expectations listed under "Oracle changes" below. No live-model run was
made (`live-proof`, real-wake untouched).

### Lanes

| lane | what changed upstream → what the port does | evidence |
| --- | --- | --- |
| **a** shellm / llm / context / extract | `extract_code` lifts tool-call markup and repairs
suffixes, CRLF/provenance cut; shellm widened redaction, output-size and wall-clock watchdog
kills, per-run `TMPDIR`; `llm --json-schema`, `served_by`/`truncated` usage fields,
`content_filter` refusal, GLM/MiMo tier; `context` renders reasoning rows from a fixed field
list. `llm` shared-process-group deadline (2a63d92). | `parity/extract` 82/82; `parity/llm`
281/281 effective (258 identical + 23 documented), adversarial 278 scenarios, 0 DIVERGE;
`parity/context` 126/126 byte-exact (+11/11 deviation probes). Upstream suites registered
(portable / no-port-cli / bash-artifact, each with a reason in `parity/upstream-tests/run.mjs`).
|
| **b** mem | write-point credential redaction, flag refusal, blank-summary, schedule/tz, search supervisor/worker group, outer deadline, TERM/INT cancel, private marker dir (2a63d92, 30f8bbe). | `parity/mem` 194/205 (+119 scenarios; the 11 mismatches are stderr-wording classes, all documented in the report). |
| **c** traj | credential redaction at the write point, fail-fast append lock, search two-pass / `--tail` / prefilter, cycle-guarded readers, formatted filter, POSIX brackets. | `parity/traj` 256/256 (+170 scenarios, 5 documented deviations). |
| **d** identity / killall / tui | `identity new` seeds orientation + a light disposition (not a family); killall excludes broker containers inside one `docker ps` snapshot; TUI follower process-group teardown; mem skill doc. | `parity/identity` list 17/17 (needs `LC_ALL=en_US.UTF-8`, see Gaps below), export 7/7, import 6/6; `parity/killall` 7/7; `parity/init` 7/7. |
| **e** chat / message index | owner-file lock with takeover, offset record (inode + sizes), trim/rebuild, deliveries index, `key` field, `sent`/repeat queries, Slack target check, action-object refusal, `--force`/`--key`, `chat sent`, `index-reset --offline`; chat skill text. | `parity/chat` 218/231 (+126 scenarios; all divergences are in the report's documented list: `${2:?}` stderr wording and DEL/NUL stdin). Upstream chat suites: 4 portable pass, 2 are `stat`-shim bash-artifacts. |
| **f** thinkers / dispatcher / monolith | scheduled-wake claim/sent receipts + stale-claim
sweep, die-after-claim fault injection, 16-byte hex ownership token, explicit stop cancels
`wake_at`/claimed/sent, rewind guard, feeder swap detection (restart at EOF), stuck/quiet-step
guards with TERM/KILL, `THINKERS_WAKE_NOTE_MIN_GAP`, legacy fifo cleanup; **salience feedback
injection removed**; wake-prompt credential redaction; monolith request-model tier,
`stderr_tail`/`diagnostic_step`, idle suppression, "Sent in the last 24h" + scheduled-goal
signals, runtime boundary line. | `parity/prompt` 35/35; `parity/daemon` adversarial 88 checks,
84 parity, 4 documented deviations, 0 DIVERGE; upstream daemon suites (trajectory_swap 10/10,
stuck_step 15/15, wake_at 19/19, …) in `--daemon`; unit tests `test/dispatcherReceipts`,
`test/dispatch-mechanics`, `test/monolith*`. |
| **g** Slack / Telegram bridges | peer hearing gate + loop guard, peer persona header, bare channel/user address forms, delivery notices (message_ts, permalink, failed/skipped), bare user DM via `conversations.open`, 409 refusal is final, mindlog shrink resumes at EOF, cursor carries the trajectory path; slack skill. | `parity/slack` 42/42, `parity/telegram` 36/36 against the real Python bridges (fake HTTP APIs; live legs still not exercised). |
| **h** responder | stale-trigger guard, bounded reply call (max tokens/time/retries), structured replies (schema, salvage, text fallback), DEFER/skills-tag handling, card/credential redaction. | `parity/responder` 83/83; upstream suites `test_responder_card_redaction` / `test_responder_reply_guard` registered (no-port-cli: the port's responder is in-process); `test/progress-logs.test.ts` structured-path case. |
| **i** recap / rollups | `ROLLUP_PROMPT_VERSION` 5, citation sentence, `-t 4096`,
`ROLLUP_MAX_SEALS` (default 20, 0 = no cap, `--backfill` uncapped), refusal placeholder block
(`refused:true`, no retry), early stop on bad JSON, bounded citation lookup (≤128 probes, 32 KiB
per candidate, optional-bytes bound, hint line). | `parity/recap` 37/39 (2 pre-existing `${2:?}`
wording mismatches); adversarial 173 scenarios: 151 parity, 22 documented deviations, 0 DIVERGE
(+25 new: refusal, seal-cap, namers); upstream rollup suites 18/18, 10/10, 26/26 and
`namer_limits` 34/40 (control 40/40 — the 6 are Bash-only instrumentation, ported as
`test/recap-namer-limits.test.ts` 6 tests); `test/recap-sync.test.ts` 16 tests. |
| **j** web control plane | linked-identities root is walked (2d0919e), push cursor resets after a trajectory shrink (089da9b), thinker-sync unique temp files (f1a6e96). | `web/server/test/sync-2e39a3f.test.ts` 6 tests; web/server suite green. |
| **k** sandbox execution (found by `parity/sandbox`'s reference-token check) | `docker exec`
now carries the model's code on stdin to an in-container `_supervise_exec`; a watchdog kill
cancels the whole tree inside the container as root; code over 64 KiB runs from a mode-600
script file (Linux 128 KiB per-argv-string cap) (c0fc931, b9bc2a3, db1e8e1). | `parity/sandbox`
shape 9/9, differential 7/7, loopback-rewrite PASS; real-docker tests (300 KB block runs; an
idle kill removes the in-container descendant and the control dir). |

### Deviations (deliberate; each has a `PORT-NOTE:` in code)

- **Rollup non-object model reply** — upstream's `_ctx_build … || note` suppresses `set -e`, so a non-object reply leaves a zero-byte block file and exits 0; the port aborts cleanly with the same message. Harness class `recap-rollup-jqreply-nonobject`.
- **Responder sends in-process** — the reply message step is appended directly rather than
through `chat reply`; the notes writer reuses the reply client; the reply model is
`MONOLITH_REPLY_MODEL → THINK_MODEL → SHELLM_MODEL`; `startMs` covers the whole wake; the step
asset dir ships `reply.schema.json`; new `LlmCallError`/`CompleteOptions` API. No multi-document
JSON replies. POSIX-ERE leftmost-longest vs JS leftmost-first and BSD-sed PEM-range behaviour
differ at the margin (documented in `src/responder.ts`).
- **Docker cancel** — after the in-container cancel the port also signals the docker client (upstream waits for it to exit on its own) so a wedged client cannot hold a step open.
- **`namer_limits` and other Bash-instrument suites** — suites that wrap `date`/`open` in the Bash source cannot observe the port; they are replaced by equivalent unit tests (listed above), not skipped silently.

### Oracle changes (stale expectations, not loosened)

`test/llmRetry.test.ts` (request count 3 → 2: the responder reply call is bounded), `test/monolith.test.ts` (rollup `-t 4096`), `test/progress-logs.test.ts` (`RESPONDER_STRUCTURED=0` for the legacy path + a new structured-path case), `test/steprun.test.ts` fake docker accepts `-i`/`--user`. `parity/daemon` adversarial token normalization now matches the 16-byte hex token.

### Not carried (decision, with reason)

- `macos/`, `deploy/` (systemd, Terraform, bootstrap, `thinkers-sandbox`, silence-alert,
tmp-reaper, `split-bridge-env`, `audel-metrics`), `contrib/` (`opencode`, `skill-compiler`), CI
config and docs: out of scope for the reference port (PORTING.md). Their upstream suites are
registered `no-port-cli` with that reason: `test_deploy_update`, `test_split_bridge_env`,
`test_thinkers_sandbox`, `test_thinkers_silence_alert`, `test_thinkers_tmp_reaper`,
`test_metrics_busy_overlap`, `test_contrib_opencode`, `test_skill_compiler`,
`test_skill_compiler_install`.
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
- Differential harnesses (each against the real upstream Bash/Python at `2e39a3f`): chat
218/231, mem 194/205, traj 256/256, context 126/126, extract 82/82, llm 281/281 effective
(adversarial 278 scenarios, 0 DIVERGE), recap 37/39 and adversarial 173 scenarios (0 DIVERGE),
prompt 35/35, responder 83/83, retrieval 31/31, slack 42/42, telegram 36/36, identity list 17/17
/ export 7/7 / import 6/6, killall 7/7, init 7/7, skill-env 9/9, skills 87/95 byte-identical
(95/95 effective), sandbox shape 9/9 + differential 7/7, daemon adversarial 88 checks (84
parity, 4 documented, 0 DIVERGE).
- Upstream's own Bash suites against the port, default lane (`node parity/upstream-tests/run.mjs`, 80 suites, run 2026-10-27): **portable** 43 suites, 34 exit 0, 835 assertions passed / 110 port-only failures (control 945/945); **bash-artifact** 10 suites, 6 exit 0, 151 passed / 111 failed (112 port-only lines; control 320/320); **no-port-cli** 27 suites, 19 exit 0, 304 passed / 84 failed (control 702/702). Every port-only failure is explained in the report's root-cause column:
  - portable, curl-stub methodology mismatch (the port's `llm` uses `fetch()`, never a `curl` binary): `test_llm_openai_compatible` 9/21, `test_llm_provider_env` 4/10, `test_llm_retry` 21/75, `test_llm_openrouter_routing` 6/20, `test_key_var_resolution` 12/14, `test_llm_json_schema` 2/8 (reads the payload its stub curl was handed). All six were red the same way on `main` before this sync except `test_llm_json_schema` (new; same cause).
  - portable, stub-`jq`/`sed` methodology mismatch: `test_traj_redaction` 64/73 (the last block puts failing `jq`/`sed` stubs on PATH to prove the Bash append writes nothing; the port has no such subprocess; the write-point redaction itself is the 64 passing checks + `parity/traj`).
  - portable, Bash-only instrumentation: `test_rollup_namer_limits` 34/40 — the 6 failures count `open`s/lookups inside the Bash source; ported as `test/recap-namer-limits.test.ts` (6 tests).
  - portable, runner artifact: `test_monolith_wake_sections` 34/35 — the one failure ("runtime line present") is the scratch copy having no `.git`; proven by running pure upstream Bash from a copy without `.git` (same 34/35) and with `git init` (35/35). Not a port gap: that code is upstream's unported `thinkers/monolith/step`; the port's own runtime line is tested in `test/monolith.test.ts`.
  - bash-artifact (suite sources/`sed`-extracts functions from Bash text that a Node trampoline does not contain): `test_mem_frontmatter` 1/6, `test_mem_redaction` 7/113 (the same ~170 cases are covered byte-for-byte by `parity/mem` and `test/memRedact.test.ts`), `test_chat_index_concurrent` (needs a `stat` shim the port never forks; property covered by `parity/chat` index-lock scenarios), plus `test_chat_index_lock` (same gate).
  - no-port-cli, `deploy/` files absent from the scratch tree (not carried): `test_split_bridge_env` 2/19, `test_thinkers_sandbox` 2/23, `test_thinkers_silence_alert` 5/34, `test_thinkers_tmp_reaper` 6/23; upstream's own scripts pass 19/19, 23/23, 34/34, 23/23 as control. Also non-zero with no assertion count (files absent from the scratch tree): `test_deploy_update`, `test_metrics_busy_overlap`, and `test_contrib_opencode` / `test_skill_compiler` (exit 127, `contrib/` not carried).
  - Not a regression: the no-port-cli and bash-artifact classes have no port equivalent of the CLI/Bash text the suite exercises, so a port-side failure only means the artifact is absent; each such suite names the port test or harness that covers the behaviour.
  - Evidence status (2026-10-27): the counts above are recomputed from the regenerated `parity/upstream-tests/results.json` (portable 43 / 34 clean / 835 pass / 110 port-only; bash-artifact 10 / 6 / 151 pass / 111 fail, 112 port-only lines; no-port-cli 27 / 19 / 304 / 84). `test_monolith_wake_sections` is proven by a control experiment (upstream Bash alone, with and without `.git`).
- Independent audit of the portable/bash-artifact failures (2026-10-27): no real behavioral gap
in any failing suite. (1) The six curl-stub suites: with a throwaway fetch-to-curl bridge
(audit-only, not an unmodified-suite pass, not committed), the port passes upstream's own
unmodified curl stubs: `test_llm_retry` 75/75, `test_llm_openai_compatible` 21/21,
`test_llm_provider_env` 10/10, `test_llm_openrouter_routing` 20/20, `test_key_var_resolution`
14/14, `test_llm_json_schema` 8/8. (2) `test_rollup_namer_limits` (6): the failures depend on a
`head` shim, `bash -x` xtrace counts and `bash -x bin/recap` on a Node script;
`test/recap-namer-limits.test.ts` (6) pins the same bounds. (3) `test_mem_frontmatter`: it
`eval`s `frontmatter_field()` out of `bin/mem`'s text; its 6 assertions pass against the port's
`frontmatterField()`. (4) `test_chat_index_concurrent` / `test_chat_index_lock`: they put a
`stat` shim on PATH, and the port reads sizes in-process; the port-side tests pass (`chatGuards`
25, `chat-history-index-concurrent` 1). (5) `test_traj_redaction` (9) and `test_mem_redaction`
(run through the CLI instead of the sed-extracted function: port 169/2 vs Bash 171/0): the only
failures need a sabotaged `jq`/`sed` on PATH. Real Bash fails closed (nothing appended); the
port has no sanitizer subprocess, so it appends the redacted record. The key never leaked
(`files_containing_key=0`). This is a documented deviation (see the row below), not a gap.
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

