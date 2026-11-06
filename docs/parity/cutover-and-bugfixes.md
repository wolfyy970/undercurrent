# Cutover and bugfix ledger (historical)

> **Historical.** Cutover notes and resolved bug rows. Overview: [`PARITY.md`](../../PARITY.md).

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
| `bin/chat.mjs`, `bin/context.mjs`, `bin/focus.mjs`, `bin/glob.mjs`, `bin/identity.mjs`,
`bin/mem.mjs`, `bin/put.mjs`, `bin/recap.mjs`, `bin/retrieval-step.mjs`, `bin/skills.mjs`,
`bin/sub.mjs`, `bin/thinker-step.mjs`, `bin/traj.mjs`, `bin/view.mjs` — **RESOLVED** | Each of
these 14 entry points called `process.exit(code)` immediately after producing stdout/stderr,
with no drain. On a piped, non-TTY stdout, Node's writes are asynchronous with a small OS pipe
buffer (65,536 bytes observed on macOS); `process.exit()` tears the process down before a queued
remainder flushes, silently truncating any single tool's output past that boundary (confirmed:
`view` on a 266,676-byte file emitted exactly 65,536 bytes piped, full output un-piped).
`bin/llm.mjs` already carried the fix (`await new Promise(r => process.stdout.write("", r))` for
both streams before `process.exit`); it had never been propagated to the other 14 shims — see
`parity/fuzz/findings/view-1.md` for the original finding (10 of the 14 confirmed there;
`identity`/`skills`/`retrieval-step`/`thinker-step` share the same `process.exit(run…)` pattern
and were fixed in the same lane) | fixed: `src/exitAfterDrain.ts` centralizes `bin/llm.mjs`'s
drain-before-exit pattern as `exitAfterDrain(code)`; all 14 entry points now `await
exitAfterDrain(...)` instead of a bare `process.exit(...)` (`bin/identity.mjs` additionally made
its internal `die()` helper async and awaited at every call site, since it has multiple exit
points, one of which — `identity export -o -` — streams a potentially large tar archive to
stdout). Exit codes unchanged | test/stdout-drain.test.ts (spawns `view`/`context`/`traj` as
real child processes with a piped, non-TTY stdout producing >200 KB of output; fails at exactly
65,536 bytes on the pre-fix code, passes after); `parity/fuzz` re-run for `view` (`--tool view
--count 300`) shows no recurrence of the `view-1` truncation finding — the only remaining `view`
DIVERGE findings (`view-14`..`view-18`) are the separate, pre-existing `offset-limit` bug (see
`view-13.md`), not this one |

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

