# Upstream sync 1c, lane L (historical)

> **Historical.** Context/chat triage misses and later fix notes that landed in this section.

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
| 1 | The system prompt tells the mind to run `shellm` (sub-runs,
`src/assets/shellm-system-prompt.txt:211`) but the port shipped no `bin/shellm`, so every such
call was `command not found`. Upstream's `bin/shellm` IS that command: from a wake shell it
starts a NESTED run (own trajectory with `parent_traj`/`parent_step`, a `fork` step on the
parent, a `merge` step back with the child's final answer, final answer on stdout, exit 0 on
final/no-block else 1). | **FIXED — `bin/shellm` + `bin/shellm.mjs` + `src/shellmCli.ts`.**
Argument parser, usage text, `--print-system-prompt`, new/`--traj`/`--resume`/nested trajectory,
stdin and `-f` context (`$CONTEXT`, `$FILE_CONTEXTn`), `--var`, then the in-process `runShellm`.
`runShellm` now puts `_SHELLM_PARENT_TRAJ_ID=<this traj>` (and blank
`SHELLM_TRIGGER_STEP_ID`/`SHELLM_LAUNCHED_BY`/`SHELLM_RUN_ID_OUT`, plus `SHELLM_SANDBOX=local`
for a local run) in every run's exec env, so a `shellm` the mind runs is nested. `shellm` is now
also on the monolith's synthesized tool list (`src/monolith.ts` `BIN_TOOL_NAMES`), as upstream's
`command -v shellm` finds it. Tests: `test/shellmCli.test.ts` — `--help` byte-identical to
upstream's, `--print-system-prompt` identical to upstream's with machine facts masked,
unknown-option error, plain run (stdin+`-f`), nested run (child traj `parent_traj`, parent gets
`fork`+`merge`). | port `src/shellmCli.ts`, `src/shellm.ts` (baseEnv) ⇄ `bin/shellm:276-390`
(usage), `:2540-2650` (trajectory), `:2672-2700` (context), `:3085-3125` (parent env),
`:3395-3480` (merge), `:3515-3660` (args) |
| 1 | Not ported (documented deviations): `--env`/`--new-env`/`--temp-docker`/`--bin` are accepted and ignored apart from `--env` (named via `SHELLM_ENV`); a nested run's sandbox is `local` when the parent is local, else `selectSandbox`'s auto choice; the merge step for a run that hit the iteration cap/stall is the upstream text without its `from_step_ref` extras. | DEVIATION | port `src/shellmCli.ts` ⇄ `bin/shellm:3395-3480` |
| 2 | Stall error: the port wrote a fixed string with a `source` field. Upstream's step is
`{type:"error", content:"shellm killed this run: the agent stalled — <actual reason> (last
exit=N). <guidance>", run_id, reason}` (no `source`) and prints `<ISO> [shellm] STALL: …
aborting run <id> to stop a spin.` to stderr. A guard set to 0 is OFF upstream (`[[ MAX -gt 0 &&
n -ge MAX ]]`). | **FIXED** to the exact text/fields/stderr line/`>0` guards.
`RunShellmResult.stallReason` carries the reason (used by the nested merge step). Tests:
`test/behavioralParityS3b.test.ts` (repeat-failure and consecutive-failure with
`maxRepeatFailures:0`). | port `src/shellm.ts` stall branch ⇄ `bin/shellm:3447`, `:3453` |
| 3 | Goal deleted by the port's mind at +4.6 min ("guide complete"); upstream's kept its goal.
| Compared goal prompt text, GOAL REVIEW hint (`thinkers/monolith/step:254-260`), menu text,
goals rendering (`thinkers/_lib/common.sh:303-335`: ages, `until`, order, cap 8) and command
semantics (`mem forget`/`mem edit`): identical, EXCEPT one real divergence found by the new
seeded-goal harness: `bodySnippet` kept the trailing newline so goal bullets were separated by
blank lines in the model's prompt (`$(...)` strips trailing newlines; `sed '/./,$!d'` drops only
truly empty lines). **FIXED** (`src/personMemory.ts` `bodySnippet`). The harness
(`parity/behavioral/run-parity.mjs` `seedWorld`) now seeds a goal, an intention and a
todo-with-`until`; the exact task-message checks diverged before the fix and are PARITY after
(43/48 PARITY, 5 documented `focus` DEVIATION, 0 DIVERGE). The deletion itself is **not
explained by any prompt difference** — recorded as a model choice (the formatting divergence is
the only candidate trigger and is now gone). | port `src/personMemory.ts` ⇄
`thinkers/_lib/common.sh:318` |
| 4 | exit-0/FINAL loop: a model that answers without a fenced block, or sets FINAL, ends the run. | **Unchanged on purpose** — identical to upstream (`src/shellm.ts` ~590, ~885-895 ⇄ `bin/shellm:2909`, `:3063-3072`). Operators bound runs with `SHELLM_MAX_ITERATIONS` (config), same as upstream. | — |

#### Harness flake: card-like random ids in the behavioral task-message check (not a port divergence)

Symptom: ~1 in 5 early runs, the exact task-message check of `parity/behavioral/run-parity.mjs`
showed `run_id=<ID><redacted:` on the port side (wake 2/3). Root cause: the wake prompt is
credential-redacted (port `src/promptRedact.ts:36`; upstream `thinkers/_lib/common.sh:822`,
`prompt_redact`) and both carry the same card shape `(^|[^0-9])[0-9]{4}([
-][0-9]{4}){2,3}([^0-9]|$)`. A random uuid whose segments 2-4 are all digits (measured
1588/200000 = 0.79% per uuid) is read as a card number and printed
`abcdef12-<redacted:card>-aabbccddeeff`. Each engine mints its own random `run_id`/`step_id`, so
one side occasionally carried the marker and the other did not. Both engines produce
byte-identical output for the same id (`test/behavioralParityIdRedaction.test.ts`, differential
against the real `prompt_redact`). Fix is in the harness only: `parity/behavioral/normId.mjs`
`maskIds` absorbs the marker inside an id (`normUser` uses it). No port change; the redaction
itself is faithful.

### Stage 5 findings: `HEADLONG_TS_HOME` in the mind's shell; `thinkers status` in a nested pid namespace (branch `fix/home-env`)

| Finding | Decision | Source (port ⇄ upstream) |
|---|---|---|
| `thinkers step retrieval` typed in the mind's wake shell died `HEADLONG_TS_HOME not set`: the
shipped step files (`src/assets/thinkers/*/step`, lines 8-11) are Node shims that locate
`bin/thinker-step.mjs` through that variable, which only the dispatcher's env carries
(`src/identity-env.ts:106`). Upstream's Bash steps resolve their own helpers from their realpath
(`thinkers/retrieval/step:27-30`, `source $SCRIPT_DIR/../_lib/common.sh`) and run from any
shell. | **FIXED, two layers, no new variable exported into the wake env.** (1) `thinkersStep`
(`src/thinkersctl.ts`, `thinkers step <name>`, ⇄ `bin/thinkers:1664-1685`) supplies this
checkout's path as `HEADLONG_TS_HOME` to the step it spawns when the caller's env has none; an
explicit value is left alone. This also repairs identities installed before this change (their
step files are COPIES). (2) The shipped step files fall back to the port's `bin/` on `PATH`
(every wake shell carries it first; `src/shellm.ts` baseEnv) when the variable is unset, so a
step run directly works too. Chosen over exporting the variable via `applyLocalInheritedEnv`:
upstream's wake env carries no such variable, and Docker wakes (which get only `--var`s) would
still lack it. Tests: `test/thinkersctl.test.ts` (step from an env without the variable; each
shipped step run under a clean env with only the port's bin on PATH — red before, green after).
| port `src/thinkersctl.ts`, `src/assets/thinkers/*/step` ⇄ `thinkers/retrieval/step:27-30`,
`bin/thinkers:1664-1685` |
| `thinkers status` printed `Dispatcher: stopped` for a running dispatcher inside a nested pid
namespace. | **No change; harness-only.** Detection is the same on both sides: the
`run/dispatcher.pid` file plus `kill -0` (port `thinkersStatus`, `src/thinkersctl.ts` ~758,
`pidAlive` `src/runstate.ts:79`; upstream `cmd_status`, `bin/thinkers:1890-1908`) — no `pgrep`.
A pid that the namespace cannot see gives ESRCH on both. One known edge: the port's `pidAlive`
also counts EPERM (pid owned by another user) as alive, upstream's `kill -0` reports failure
there; irrelevant to the stage-5 case and left as is. | port `src/thinkersctl.ts`,
`src/runstate.ts` ⇄ `bin/thinkers:1890-1908` |

### Runtime is Bun (branch `feat/bun-runtime`) — DEVIATION, observable behavior unchanged

| Item | Decision | Evidence |
|---|---|---|
| The port ran on Node (`#!/usr/bin/env node`, vitest on Node). The maintainer chose Bun. | **Bun is the runtime; Node is the documented fallback.** `engines.bun >= 1.4.4` (latest stable on 2026-10-28; the macOS machine had 1.3.3, the box 1.4.2, tested with a local 1.4.4 copy), `engines.node >= 22.18.0` kept. No build change: Bun runs the `.mjs` shims and imports their `.ts` modules directly (the existing "shim runs from source" property), `tsc` stays the typecheck and build. | see below |
| Launchers. | Extensionless tool launchers in `bin/` (and the files they link to) and the three
shipped `thinkers/*/step` files start with `#!/bin/sh` + `":" //; exec
"${HEADLONG_TS_RUNTIME:-$(command -v bun \|\| command -v node)}" "$0" "$@"` (valid sh and valid
JS), so they pick `$HEADLONG_TS_RUNTIME`, else bun, else node. This is why a Docker sandbox
(image `node:24-bookworm`, no Bun) still runs every tool, on Node. Other `bin/*.mjs`,
`install.mjs`, `status.mjs`, `uninstall.mjs` use `#!/usr/bin/env bun`; `node file.mjs` still
works. `parity/*` scripts keep the Node shebang and are run with whichever runtime you call.
Identities installed before this change keep their old `#!/usr/bin/env node` step copies (they
run on Node; `thinkers step` still supplies `HEADLONG_TS_HOME`). | `src/runtime.ts`;
`test/identity-new.test.ts` |
| Child processes. | The port's own spawns (`src/thinkersctl.ts` dispatcher + drain, `src/responder.ts` notes script, `src/skills.ts` manager, `bin/mem.mjs` worker + heartbeat) use `runtimePath()` = `$HEADLONG_TS_RUNTIME` or `process.execPath` (the running runtime), so parent and children never mix runtimes. `src/shellm.ts` and `src/identity-env.ts` still put `dirname(process.execPath)` first on the wake PATH. | `src/runtime.ts` |
| Evidence, final (2026-10-28, macOS arm64, Node 22.22.3 vs local Bun 1.4.4). | **Full vitest
suite, after all test edits: Node 135 files passed + 1 skipped, 2381 passed / 4 skipped (=
baseline). Bun (`bun --bun vitest`): the same 2381 passed / 4 skipped, plus 1 unhandled `EPIPE`
error.** `parity/sandbox/run-parity.mjs`: identical on both (shape 9/9, differential 7/7 PARITY,
loopback-rewrite and real-daemon proof PASS). `parity/daemon/run-parity-adversarial.mjs`
(`PARITY_HEADLONG_ROOT` set): identical on both, 88 checks, 84 parity, 4 documented deviations,
0 DIVERGE (the run exits 1 only because of 3 stale `dispatcherd` processes from an earlier
session, see below). `parity/behavioral/run-parity.mjs` (the shellm loop, task message and
request differential): 43 PARITY, 5 DEVIATION, 0 DIVERGE on both.
`parity/upstream-tests/run.mjs`: Node and Bun output byte-identical. `--help` of ten CLIs
byte-identical. Startup, median of 20 (ms) Node 22 / Bun 1.3.3 / Bun 1.4.4: traj 73/36/22, mem
93/24/19, shellm 136/47/31, llm 112/33/29, thinkers 65/24/18, skills 83/34/30.
**`test_mem_search` (17/18) and `test_traj_cycle_reads` (exit 127) were an environment change,
not the port or the runtime:** both scripts call GNU `timeout`, which is no longer on this Mac's
PATH (`which timeout gtimeout` empty). With a scratch stand-in on PATH they pass on c31c97b
under Node (18/18, exit 0) and on this branch under Bun (18/18, exit 0), control side too.
`test_rollup_namer_limits` 34/40 is the TEST-METHODOLOGY MISMATCH already recorded in the
2026-10-27 report, unchanged. **Bun-only `EPIPE`:** deterministic in isolation, from the
`controls: thinkers start/stop` test (`web/server/test/controls.test.ts:235-266`, through
`web/server/src/control.ts:183-225` into `src/thinkersctl.ts:300`). The stack is Bun internals
only (`internal:fs/streams:358 finalFast`), no frame of ours; every assertion passes; it is the
same with the child on Node or on Bun; the library-level `test/thinkersctl.test.ts` has none on
Bun. Not fixed, not a behavior difference. | scratch runs, 2026-10-28 |
| Not covered. | `web/server` (its own package; `control.ts:345` spawns `process.execPath`, one vitest `EPIPE` unhandled error appears when the suite runs on Bun, `web/server/test/controls.test.ts`) and `install.mjs`' own `process.execPath` hand-offs are unchanged. Docker wakes run the tools on Node unless the image has Bun. | |

### Gapcheck findings (branch `fix/gapcheck-findings`, from the box differential `gapcheck/REPORT.md`, 2026-10-28)

Source: a $0 scripted differential (same state, same 53-step wake, identical replies) of port `c31c97b` vs upstream `2e39a3f` in the box's bwrap sandbox. It found the model-facing observations byte-identical and the request 205 B smaller on the port (a constant), plus three small things recorded here.

| Item | Decision | Evidence (port ⇄ upstream) |
|---|---|---|
| **1. Bash error text said `line N+1`** (unknown command, syntax error, `$LINENO`). | **Port
bug, FIXED.** `LocalSandbox.exec` ran `"exec 2>&1\n" + wrappedCode`: a whole extra leading line,
so every line number bash printed (and every `$LINENO` the model's code printed) was +1 against
upstream's `bash -e -c "$wrapped_code"` whose first line is `set -x`. Now `exec 2>&1; ` rides on
that same first line. Two more differences in the wrapper, found by the new harness, also fixed:
upstream's wrapper has a blank line after `set +x` (moves the "unexpected end of file" line),
and the final path is written double-quoted (`> "$final_path"`) where the port single-quoted it
(an unbalanced `'` in the model's block paired differently with the wrapper's quotes: a
different EOF line). `src/sandbox.ts` `LocalSandbox.exec`, `src/shellm.ts`
`buildWrappedCode`/`dq` ⇄ `bin/shellm:1631`, `3065-3073`. | New differential
`parity/execlines/run-parity.mjs`: real upstream `bin/shellm` end to end (`SHELLM_ENV=local`,
scripted `llm`) vs `runShellm`, same bash on both sides (macOS `/bin/bash` 3.2 numbers `-c`
lines from 0, so the harness pins one PATH). **Before: 2/12 byte-identical; after: 12/12**
(unknown command at line 1/2/5, two syntax errors, unterminated `if`, unterminated quote,
`$LINENO`, heredoc then unknown command, function-body error, `set -e` exit, stderr redirect).
New unit test `test/execLineNumbers.test.ts` (11 tests, 10 fail on the old code, all pass now;
runs the upstream wrapper shape with the same bash as oracle). Docker path unaffected (it has no
extra line: the supervisor runs the wrapped code as is). Harness normalises one thing: the
port's recorded `shell-output.stdout` keeps a trailing newline that upstream's `$(cat …)`
(`bin/shellm:3286`) strips (trajectory text only; the model-facing observation was already
byte-identical in the gapcheck). |
| **2. Rollup calls: port 4 in 16 wakes, upstream 3 in 8.** | **Same logic; no change.** A
rollup is sealed only when F^k filtered steps complete a block at or after the enable marker, at
most `ROLLUP_MAX_SEALS` (20) per `recap --context` call: it depends on how many filtered steps
exist when a wake starts, never on wake count or time. Port `src/monolith.ts`
`lifeContextSection` → `src/recap.ts` `ctxBuild`/`buildPlan` (`src/rollups.ts`) ⇄
`thinkers/_lib/common.sh:643-651` → `bin/recap` `_ctx_build` (660-690). | The gapcheck's own
files: both arms sealed the same blocks (t1 `[280,290)`, `[290,300)`, t2 `[200,300)`) and the
port also `[300,310)`, because its rendered (filtered) trajectory reached 313 rows and
upstream's 305, i.e. the port ran about 2× the steps (848 vs 424 model calls in 300 s: the
engine-speed difference, finding 5 of the report). 313 ≥ 310 > 305. New differential
`parity/recap/run-seal-trigger.mjs` grows one trajectory wake by wake (enable mid-history, exact
fanout boundaries across tier 2, a 450-step backlog over the 20 cap, cap 0, cap 3 with fanout 4,
40 tiny wakes) and runs the monolith's exact `recap --context --raw-tail 0 -q` per wake against
real `bin/recap` and the port: **6/6 scenarios identical on every wake** (per-wake LLM call
count, block files, staircase text). |
| **3. Wake-up note omits the systemd sentences.** | **DOCUMENTED DEVIATION, kept.** Upstream's
note (`bin/thinkers:1500-1503`) adds `; systemctl status headlong-thinkers@<name>` and a closing
`To restart yourself safely …, run: sudo headlong-thinkersctl restart <name> — systemd completes
the restart …`. This port ships no `deploy/` and no `headlong-thinkersctl`, so the advice would
point the mind at a command that does not exist. Port `src/thinkersctl.ts` `appendWakeGapNote`
(PORT-NOTE added) ⇄ `bin/thinkers:1485-1505`. | Cost of matching: +236 B once per dispatcher
start (gapcheck finding 3: note 422 B port vs 658 B upstream). Other constant request-size
differences from the same finding, all in the first user message: Runtime line +8 B (commit
text), Workspace path +19 B (port workdir `$ID/.shellm/workdirs/<root>-root` vs upstream
`$ID/workdir`, `src/steprun.ts:106` ⇄ `thinkers/monolith/step:39`); nothing on the port side is
larger. |

