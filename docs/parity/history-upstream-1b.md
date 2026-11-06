# Upstream sync 1b (historical)

> **Historical.** `ed2dac6` → `7d29f9e`.

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
| 84aa37e | `bin/chat`: `chat history --with <name> [--since D] [-n N] [--json]`, the derived
`messages.jsonl` index (byte-offset resume, full-scan rebuild on header mismatch,
partial-line-safe), person keys (`_person_key`/`chat person-key`), `type: person` memory alias
merge; `thinkers/responder/step` reads 7 days of indexed history with age stamps;
`skills/chat/SKILL.md` doc update (the `--with` block only — NOT the later, out-of-lane
Shellm.app formatting section from 931bf50/0ac2823) | `src/messageIndex.ts` (new),
`src/personMemory.ts` (new), `src/chat.ts` (`cmdHistoryIndexed`, `cmdPersonKey`),
`src/responder.ts` (history-driven `buildConvoSel`/`formatAge`),
`src/assets/skills/chat/SKILL.md` | `test/messageIndex.test.ts` (10),
`test/personMemory.test.ts` (16), `test/chat-history-index.test.ts` (12),
`test/responder-integration.test.ts` (metrics group); differential
`parity/upstream-tests/run.mjs` `test_chat_history_index.sh`: 29/29 vs real NEW;
`parity/chat/run-parity.mjs` 21 new `convo-memory` scenarios: 21/21 vs real NEW `bin/chat` |
| dcf3c02 | `thinkers/_lib/common.sh` `_recent_stream`: drop `reasoning`, keep `final`, add
`error`, collapse consecutive `idle`/`error` runs into one synthetic line each (`"idle x22 over
2h10m"`, `collapsed: N`) | `src/recentStream.ts` (new; replaces the old inline `recentStream` in
`monolith.ts`), wired into both `monolith.ts` and `responder.ts` (inner-life excerpt) |
`test/recentStream.test.ts` (9, ported assertion-for-assertion from
`tests/test_recent_stream_filter.sh`); differential `parity/upstream-tests/run.mjs`
`test_recent_stream_filter.sh`: 11/11 (no-port-cli — the Bash function itself, run for the
record) |
| 0c51de8 | `bin/chat`: `chat reply --follow-up` (bypasses the duplicate-answer guard, stamps
`follow_up:true`); `thinkers/monolith/prompt.md`: one-line "pending request" exception;
`thinkers/monolith/step`: PENDING REQUEST routing hint; `thinkers/responder/step`: `DEFER:
<work>` parsing (action step + holding reply), per-person notes (part 4) | `src/chat.ts`
(`--follow-up`), `src/assets/monolith-prompt.md` + `src/assets/thinkers/monolith/prompt.md`
(byte-identical to NEW), `src/monolith.ts` (`pendingRequestHint`, exported), `src/responder.ts`
(DEFER handling, `updatePersonNotes` — **PORT-NOTE**: reuses the reply's `LlmClient` instead of
a cheaper notes-only model, since the port's `LlmClient` has no per-call model parameter;
documented in the function's own header). **REAL PORT BUG, found live and fixed**:
`_update_person_notes_async` (step:393-402) runs the notes writer in a DETACHED subshell (`(
_update_person_notes … ) >>notes.log 2>&1 </dev/null &`) that outlives the responder step; the
port's async path (RESPONDER_PERSON_NOTES_SYNC unset) instead fired `updatePersonNotes` as an
in-process fire-and-forget promise — `bin/thinker-step.mjs`'s `process.exit()` (called the
instant `runResponder` resolves) killed that promise's in-flight LLM call EVERY time, so no
`type: person` memory was EVER written on a real async wake (proven live: two replies with
`history_source=index`, `context_msgs=2`, no `type: person` memory ever appeared,
`responder-notes.log` never created). Fixed: the async path now spawns a real detached child
process, `bin/responder-notes.mjs` (new), the same technique `thinkersctl.ts`'s
`drainThenFinish` → `bin/thinkers-drain.mjs` already uses — `src/responder.ts`'s
`spawnPersonNotesWriter`/`defaultSpawnDetached` (`spawn(process.execPath,
[RESPONDER_NOTES_SCRIPT, trajFile, idxFile, memDir, identityName, personKey, msgFrom],
{detached:true, stdio:["ignore",logFd,logFd]}); child.unref()`), log path exactly
`<identityDir>/run/logs/responder-notes.log` (`${IDENTITY_DIR:-.}` fallback when absent,
matching the Bash unset-var default). The child rebuilds its own `LlmClient` via `steprun.ts`'s
`buildLlmClient` from its INHERITED environment only (`opts.env`, defaulting to `process.env`) —
never argv — so no API key ever appears in a process listing. A second, independent real bug
surfaced fixing this: `steprun.ts`'s old `...(identity.execEnv?.["MEM_DIR"] ? {memDir:…} : {})`
silently DROPPED `memDir` from `RunResponderOptions` whenever a caller's env skipped
`resolveIdentityEnv` (which is the only thing that guarantees `MEM_DIR`, identity-env.ts:87) —
`updatePersonNotes` then bailed silently (`if (!memDir) return`) after already paying for the
LLM call. Fixed: `memDir` now defaults to the identity's own memories dir
(`path.join(identityDir, "memories")`), matching what `MEM_DIR` always resolves to in production
(not upstream's shared `/tmp`, which the port's identity-scoped default is strictly better
than). | `test/monolith.test.ts` (6), `test/responder-integration.test.ts` (deferral +
person-notes groups, 8 scenarios, + 3 new: spawn-seam asserts the exact detached call/log path
and that the notes LLM is never touched in-process when SYNC is off, the `${IDENTITY_DIR:-.}`
log-path fallback, a swallowed spawn failure); `test/responder-notes.test.ts` (new, 3 scenarios
— spawns the REAL `bin/responder-notes.mjs` against a fake LLM HTTP server: first-write and
update-in-place frontmatter byte-for-byte against step:343-392 (id/created/aliases preserved), a
no-history no-op); `test/steprun.test.ts` (+2: the `MEM_DIR`-missing fallback, and a full
`runStep` → real detached child → `type: person` memory end-to-end); differential
`test_responder_deferral.sh`/`test_responder_person_notes.sh`: 14/14, 12/12 (no-port-cli, but
both exercise `chat.mjs`/`traj.mjs` on PATH — a real differential for those) |
| 883339f | `thinkers/responder/step`: stamp `context_msgs`, `context_steps`, `gap_s`, `compose_ms`, `model` on every decision observation; `deploy/scripts/audel-metrics` reporting (not ported — deploy tooling, out of scope) | `src/responder.ts` (`computeGapSeconds`, the `withMetrics` stamping) | `test/responder-integration.test.ts` (metrics group, 5 scenarios); differential `test_responder_metrics.sh`: 17/17 |
| 67229dc | `bin/chat`: `chat history --thread <name>`, `chat thread-key`;
`thinkers/responder/step`: unions the Slack thread's last day into the prompt as extra user
turns (`thread_msgs` metric) | `src/personMemory.ts` (`threadKey`), `src/chat.ts`
(`cmdThreadKey`, `--thread`), `src/responder.ts` (`buildConvoSel`'s `threadOnly` union) |
`test/responder.test.ts` (buildConvoSel thread-union cases),
`test/responder-integration.test.ts` (thread-context group, 2 scenarios); differential
`test_responder_thread_context.sh`: 7/7 |
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
| `015d081` | `llm`: `--or-only`/`--or-data-collection`/`--or-zdr` flags + matching `LLM_OR_*`
env defaults; `build_payload_openrouter` gains a `provider` block (only/data_collection/zdr),
normalized once, warn-and-clear on a non-openrouter provider, stderr-announced when the
effective routing came from the environment | `src/llmCli.ts` (flag parsing, normalization,
warn/clear/announce logic) + `src/llmProvider.ts` `buildOpenRouterProviderBlock` (pure, null
no-op when unpinned) | `test/llmCli.test.ts` "OpenRouter provider routing" (17 cases); `--help`
byte-identical to real upstream; `parity/llm/run-parity.mjs` `or-routing` group (25 scenarios
mirroring `tests/test_llm_openrouter_routing.sh` 1:1) — 25/25 PARITY vs real NEW `bin/llm`,
harness-wide 248/248 effective, 0 port bugs; gated on a `--help` feature probe so the group is
skipped (not counted as bugs) against the OLD-pinned checkout, which lacks the flags entirely |
| `cf9e0ab` | tightens `tests/test_llm_openrouter_routing.sh`'s own assertions (`==` instead of `!=` on `has("provider")`, trims a trailing space in a `run_llm --` call) — test-only, no `bin/llm` behavior change | none needed (assertion tightening only; the port's behavior already satisfies the tightened form, proven by the same `or-routing` parity group above) | same proof as `015d081` |
| `8ba520b` | `bin/shellm`'s `call_llm`: stopped treating "no stdout + non-empty stderr" as a
failure — `llm --thinking` streams reasoning to stderr, and a call that spends its whole budget
there returns exit 0 with empty stdout, which is exactly what `run_loop`'s empty-response retry
(pre-existing, 2026-04-26) needs; the added guard (2026-06-01) made that retry unreachable |
this port's `runShellm` (`src/shellm.ts`) never shells out to `bin/llm` — `LlmClient.complete()`
is called in-process — so there was no stderr-guard to remove; the applicable gap was that
`runShellm` never retried an empty `resp.text` at ALL, falling straight into the NO-BLOCK/final
path with empty content. Fixed by the retry loop added for `136f32b` below (the two upstream
commits land as one port change, since the port has no intermediate broken-guard state to
reproduce) | `tests/test_shellm_empty_response_retry.sh` run directly against NEW upstream
`headlong-upstream-main` (14/14 pass) to ground the design; `test/shellm.test.ts` "runShellm:
empty-response retry" (visible text unaffected; a real thrown failure still fails;
empty+reasoning retries with feedback; empty+no-reasoning retries silently) |
| `136f32b` | `bin/shellm`/`bin/llm` fast-follows: messages travel via `--messages-file`/file,
not argv (128KB `ARG_MAX` risk); fed-back thinking goes through `jq --rawfile`, not `--arg`;
`SHELLM_EMPTY_RESPONSE_RETRIES` defaults to 8 (was unlimited), set empty for unlimited; the
feedback branch paces retries with the same `sleep 1` as the no-thinking branch; `llm`'s own
`"llm: warning: …"/"llm: note: …"` stderr lines are filtered out of the fed-back thinking before
it becomes assistant content | `LlmResponse` gains an optional `reasoning` field (OpenRouter's
`message.reasoning`, extracted by new `extractReasoningOpenAI` in `src/llmProvider.ts`, wired
into `OpenRouterClient.complete`) — used ONLY for retry feedback, never the trajectory's
`reasoning` field (still `extractReasoning(text)`). `ShellmConstants.emptyResponseRetries`
(default 8; `constantsFromEnv` reproduces the bare `${VAR-8}` — default ONLY when unset,
explicitly-empty stays unlimited, unlike every other knob there). `runShellm`'s retry loop:
`filterLlmNoiseLines` strips `^llm: (warning\|note): ` lines from the reasoning before feeding
it back; a 1s `sleep` (injectable) paces every retry; exhausting the cap appends an `error` step
(`truncateOutput`-shaped detail, matching `bin/shellm:302-314` byte-for-byte incl. the
trailing-newline/command-substitution-strip quirk) and returns a new `StopReason`
`"empty-response"`, treated as errored by `monolith.ts` for backoff purposes, same as
`"stall"`/`"max-iter"`. `--messages-file F` also added to `bin/llm` (trailing newlines stripped,
same as `--system-prompt-file`) — the port's messages already travel as one in-process JS array
with no argv/`ARG_MAX` exposure for `runShellm` itself, but the flag is a real `llm` CLI
addition independent of that | `tests/test_shellm_retry_feedback.sh` run directly against NEW
upstream (8/8 pass) to ground the design; `test/shellm.test.ts` (constantsFromEnv
default/empty/numeric cases, `filterLlmNoiseLines`, `truncateOutput`, the retry loop's
feedback/cap/unlimited cases — 22 new cases total); `test/llmCli.test.ts` `--messages-file`
case; `parity/llm/run-parity.mjs` 3 new `args/messages-file-*` scenarios, gated the same way as
`or-routing` — 248/248 effective vs NEW, 0 port bugs |
| `0925168` | `bin/shellm`: a running named env is only reusable for the Docker image it was
built from (`env_metadata_matches` now compares the stored image; a resume inherits the
trajectory's image unless the caller explicitly chose one; a running env skipped on an image
mismatch says so) | **PORTED (bug #32).** The earlier "N/A to this port's architecture" verdict
here was wrong: it was N/A only because `src/sandbox-runtime.ts` didn't yet reuse containers at
all (a separate port bug, #32, fixed in the same lane that revisited this row) — once reuse
exists, this commit's hazard is real and needed porting. `src/sandbox-env.ts`'s
`envMetadataMatches`/`envMetadataMismatchMessage` compare the stored vs. requested Docker image
before any reattach and throw upstream's exact `die()` message on a mismatch; metadata lives at
`<identityDir>/.shellm/envs/<name>/image` (this port's `SHELLM_ENVS_DIR`, tools/identity:375).
Env resolution here is always "explicit" in upstream's own terms (every thinker wake passes a
concrete identity name, never the anonymous auto-generated case), so a mismatch always refuses
rather than silently skipping — matching `env_resolve`'s `explicit=1` branch, not its
`explicit=0` one. No `--docker-image` explicit-vs-default distinction or standalone `shellm` CLI
exist, and none are needed for this commit's actual hazard | `test/sandbox-env.test.ts` "image
mismatch refuses reuse with upstream's exact message (0925168)" (real docker, skips cleanly
without a daemon) asserts the literal message string; `tests/test_env_image_identity.sh` run
directly against NEW upstream (12/12 pass, unchanged) documents the behavior being matched — not
run differentially (no standalone `shellm` CLI to diff against), matched by direct
message-string comparison in the port's own test instead; `parity/upstream-tests/run.mjs` entry
(bash-artifact class) unchanged |
| `30561e9` | `thinkers/_lib/common.sh` `_build_shellm_flags`: forwards `CHATRC` (`--var
CHATRC=…`) into generated-code Docker runs; adds `focus`/`recap` to the `--bin`-mounted tool
list, which had silently disappeared only inside Docker | **CHATRC half: ported.**
`src/steprun.ts`'s `buildIdentityConfig` now forwards `env["CHATRC"]` into the wake's `execEnv`,
same as `MEM_DIR`/`SKILLS_DIR` — without it a mid-wake `chat send` fell back to `./.chatrc`
relative to the step's workdir instead of the identity's own sender config, on BOTH local and
Docker sandboxes (this port's exec-env path is unconditional, not Docker-only like upstream's).
**Tool-list half: N/A**, already closed by design — this port's sandbox mounts the WHOLE
checkout read-only (`src/sandbox-runtime.ts`, see the pre-existing "Sandbox bind-mount scope"
note in Scope/known gaps above), so every `bin/` tool including `focus`/`recap` was already
reachable before this lane; there is no per-tool `--bin` list to have a gap in |
`test/steprun.test.ts` "monolith: CHATRC reaches the sandboxed exec env" — fails on the pre-fix
code (`CHATRC=` empty reaches the sandboxed shell) and passes after;
`tests/test_thinker_tool_coupling.sh` run directly against NEW upstream (14/14 pass) to confirm
the tool-list claim reads correctly, `parity/upstream-tests/run.mjs` entry explains the
no-port-cli classification |

Whole-repo suite after this lane: `DOCKER_CONTEXT=colima pnpm vitest run` — **1333 passed / 4
skipped** (was 1259 before this lane), tsc clean. `parity/llm/run-parity.mjs`: 248/248 effective
vs real NEW `headlong-upstream-main/bin/llm` (230 identical + 18 documented deviations, 0 port
bugs); against the OLD-pinned `headlong/bin/llm` the harness stays runnable (feature-gated new
scenarios skip cleanly) and every pre-existing scenario is unaffected, modulo `--help` text now
honestly reflecting the two new upstream flag sets (3 expected mismatches there against OLD,
resolved now that the pin is `7d29f9e` — not real bugs). `parity/upstream-tests/run.mjs` gains 5
suite entries for this lane (`test_llm_openrouter_routing.sh` portable — 14 port-only-fails, all
the same curl-stub TEST-METHODOLOGY MISMATCH already documented for
`test_llm_openai_compatible.sh`, classified not a port bug; the 4 shellm suites are
bash-artifact/no-port-cli, run against real upstream Bash on both sides for the record, with the
port's actual equivalent behavior proven by the vitest suites cited per-commit above).

### 4. Web UI (triage lane 4)

Commits `d5945c0`, `6412f5d`, `f06bb50`, `bc2b640`, `eef1105`, `b50cd84`.
This lane's slice is `web/viewer` (React viewer, vendored verbatim) plus
anything under `web/` its new features needed from the TS server.

| Lane | Commits | What | Result |
| --- | --- | --- | --- |
| web-ui | `d5945c0`, `6412f5d`, `f06bb50`, `bc2b640` | Timeline deeplinks: `?step=`/`?run=` URL
params drive the detail modal (open/scroll/pulse), copy-link builds the URL by hand for
substeps; `web/viewer/vitest.config.ts` + `timeline-view.test.tsx` added upstream | Ported
verbatim into `web/viewer/app/components/timeline-view.tsx`, `timeline-detail.tsx`,
`mindlog-search.tsx`, `app.css`. No server.py / API changes in this range — deeplinks are pure
client-side `URLSearchParams`, nothing for `web/server` to expose. |
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

