# Deviations (deliberate, reviewed)

> Current deliberate deviations. Overview: [`PARITY.md`](../../PARITY.md).

> **Historical note:** some subsections below are lane-era fix ledgers; claims are preserved, not refreshed.

## Deviations (deliberate, reviewed)

See also "Behavioral parity round" below for the deviations kept by that round.


> Table converted to sections for GitHub rendering.

### sandbox

- **Source behavior:** `docker exec` per-identity container

- **Port behavior:** restricted local subprocess behind a `Sandbox` interface

- **Why:**

keeps `pnpm test` daemon-free; SPEC §1.1 permits if env metadata reproduced (it is, in the
shellm-run step). DockerSandbox is a drop-in seam.

- **Scenario:** characterization.test.ts (sandboxed bash runs, output lands)

### Docker sandbox default image (DOC #65)

- **Source behavior:**

`SHELLM_DOCKER_IMAGE="${SHELLM_DOCKER_IMAGE:-ubuntu:latest}"` (bin/shellm:139, `--docker-image`
help text at bin/shellm:291)

- **Port behavior:** `DEFAULT_DOCKER_IMAGE = "node:24-bookworm"` (`src/sandbox-runtime.ts:125`)

- **Why:**

required, not cosmetic: this port's tool shims the sandbox mounts
(`traj`/`mem`/`skills`/`context`/`llm`/`chat`/`recap` under `id.binDir`) are Node/TS, not
upstream's Bash — a bare `ubuntu:latest` has no `node` binary, so every shimmed tool call inside
the container would fail immediately. `node:24-bookworm` is the smallest bump that guarantees
Node ≥22.18 + bash (SPEC §7).

- **Scenario:**

the running mind observes a DIFFERENT sandbox on the port: `node`/`npm`/`corepack` are present
(upstream's are not, unless a skill installs them), and Debian/bookworm's base package set
differs from Ubuntu's (different `apt` package names/versions, different default locale/tzdata,
no `ubuntu-*` metapackages) — anything relying on an Ubuntu-specific tool or package name
behaves differently. Overridable on either side with the SAME env var, `SHELLM_DOCKER_IMAGE`
(`src/sandbox-runtime.ts:161`), so a caller that needs upstream's literal `ubuntu:latest`
(accepting the shim-tool breakage) or a different Node base can set it explicitly.

### trace-04 delivery

- **Source behavior:** monolith acts, result never delivered (a Headlong quirk)

- **Port behavior:** reproduced faithfully, NOT fixed

- **Why:** rule: don't fix the source while porting; the fix is a downstream product decision

- **Scenario:** topology.test.ts trace-04 case

### dispatcher restart: lost wakes (wake ledger, src/wakeLedger.ts)

- **Source behavior:**

upstream Bash loses wakes across a dispatcher restart: feeders start at end of file (`tail -n 0
-F`), `run/pending/` is removed at boot and on stop, and the pending FIFO drops its oldest entry
at 16. Measured in the restart-chaos experiment (`docs/LOSTWAKE.md`, 12 aggressive-plus-gentle
runs, 600 messages, a local HTTP server serving scripted replies): **168/600 (28.0%)** messages
never woke the responder, though every one reached the recipient's trajectory and the sender saw
it sent

- **Port behavior:**

the unfixed port had the same defect (**128/600, 21.3%**, 141 restarts). With the ledger:
**0/600** (136 restarts) plus **0/150** in three `kill -9` stress runs (56 restarts, a restart
every 0.5 to 1.5 s, 1.5 s model calls). Design: the dispatcher alone writes
`run/ledger/<thinker>.jsonl` (append-only; `recv` when a message or action step is routed to a
thinker, before it is dispatched or queued and before the cursor passes it; `done` only when
that thinker's step exits 0) and `run/cursor/<sha1(file)[0:16]>` (`{file, ino, offset}`: the
byte offset up to which complete lines were fed and ledgered). On start it re-queues owed steps,
then the cursor gap, then starts the feeder where that read ended; a step the trajectory already
answers (`trigger_step` equal to it, `source` equal to the thinker) is marked consumed, not
re-run; past 16 pending the owed steps wait in an in-memory overflow queue, not dropped. Only
`message` and `action` steps are replayed; other step types keep upstream's no-replay rule.
Trajectory format, the frozen `run/` files and every existing `dispatcher.log` line are
unchanged; the two new `run/` directories and a few new log lines are additive.
**`THINKERS_WAKE_LEDGER=0` restores upstream behaviour** (tested)

- **Why:**

upstream's behaviour silently drops messages a person or another bot already sent; the port is
meant to be a faithful reproduction, so this is a deliberate, opt-out divergence, not a bug fix
presented as parity. `ThinkerDef.run` now returns `Promise<void | number>` (exit code) so that
consumed means the step succeeded

- **Scenario:**

`test/wake-ledger.test.ts` (18 tests, incl. real `bin/dispatcherd.mjs` kill -9 and the
off-switch); `parity/lostwake/run-lostwake.mjs` and `results/*.json`;
`parity/daemon/run-parity-adversarial.mjs` (frozen run files unaffected)

### traj required-flag value MISSING or EMPTY (--traj_dir, --slug, --field, --child, --step-id, -n, -C, --parents, --children, --filter)

- **Source behavior:** Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""`

- **Port behavior:** clean `traj: error: <cmd>: <msg>`, exit 1 (same stdout=empty + on-disk state unchanged)

- **Why:**

same rationale as mem/skills/recap/llm: Bash's text embeds the script's absolute path + a Bash
line number — irreproducible from TS and brittle to pin; only stderr wording differs on a misuse
path no Headlong caller inspects

- **Scenario:** parity/traj — every `*-missing-value`/`*-dies` scenario that hits a required flag

### traj show/last --field on a jq-abort-family malformed input (invalid JSON in the resolved step)

- **Source behavior:** `set -euo pipefail` + a jq parse failure aborts the whole script with jq's own exit code (5) and jq's own message

- **Port behavior:** dies with its own `<cmd>: <file>: invalid JSON in last step`-style message, exit 1, at the same logical point

- **Why:**

same jq-abort-family rationale as recap/llm: a jq exit code + wording leaking through `set -e`
is not a contract; the port fails at the same point with a uniform message

- **Scenario:** src/trajCli.ts cmdLast (PORT-NOTE)

### traj tail -r/cat -r (--recursive) on a normal (Z-suffixed) trajectory

- **Source behavior:**

bin/traj's `_sorted_tree_steps` `to_epoch` jq filter (bin/traj:776-786) falls into its no-offset
fallback branch for any plain `...Z` timestamp, whose `.dt + "Z"` re-appends a SECOND `"Z"`; on
this system's jq, `fromdateiso8601("...ZZ")` HARD ERRORS (confirmed standalone), and
`2>/dev/null || true` silently swallows it — `-r`/`--recursive` on `tail`/`cat` emit ZERO bytes
on ANY normal trajectory (isoTs() always writes `Z`), not an edge case

- **Port behavior:** correctly interleaves and prints every step from every file in the tree, sorted by timestamp

- **Why:**

an unintended Bash/jq crash artifact, not designed behaviour — same class as the skills `set -e`
crash-smoothing and put's mv-into-directory-accident deviations: don't degrade the port to
reproduce an accidental crash that empties a real, documented feature. The port's `toEpoch()`
strips a duplicate trailing `Z` before parsing

- **Scenario:** parity/traj tail/recursive, cat/recursive (both DEVIATION, not DIVERGE, in results.json)

### traj merge/fork child resolution search directory

- **Source behavior:**

`${TRAJ_DIR:-$traj_dir}` / `${TRAJ_DIR:-$parent_dir}` (bin/traj:1300,1360) reads the ENV var
specifically, not the `--traj_dir` FLAG, falling back to the parent's own resolved directory — a
child created as a sibling (not nested under the parent, and not found via env `$TRAJ_DIR`)
genuinely fails to resolve in real Bash too

- **Port behavior:** reproduced exactly (`io.env.TRAJ_DIR || parentDir`)

- **Why:**

faithful replication, not a port bug — confirmed against real Bash with the identical fixture; a
realistic caller either has `$TRAJ_DIR` set for the whole session or nests the child via `fork`
(which passes the parent's own dir to `cmd_new`, an entirely different path)

- **Scenario:**

test/trajCli.test.ts "merge" describe block comment; parity/traj merge/basic (env TRAJ_DIR set,
as a realistic caller would)

### mem required-flag value MISSING or EMPTY

- **Source behavior:** Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""`

- **Port behavior:** clean `mem: error: <msg>`, exit 1 (same stdout=empty + unchanged state)

- **Why:**

Bash text embeds the script's absolute path + a Bash line number — irreproducible from TS and
brittle to pin; only stderr wording differs on a misuse path no caller inspects. Covers --dir,
add --type, list --type/--before/--after, edit --slug, and their empty-string forms (M1:
`required()` now rejects `""`, was silently accepted).

- **Scenario:**

parity mem: dir-missing-value, list-type-missing-value, empty-required/*; test/mem.test.ts
"empty-string required flag values (M1)"

### recap required-flag value MISSING or EMPTY

- **Source behavior:** Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""`

- **Port behavior:** clean `recap: error: <msg>`, exit 1 (same stdout=empty + on-disk state unchanged)

- **Why:**

same rationale as mem/skills/llm: Bash's text embeds the script's absolute path + a Bash line
number — irreproducible from TS and brittle to pin; only stderr wording differs on a misuse path
no caller inspects. Covers --traj_dir, --window, --budget, --raw-tail, --fanout, --gap-minutes,
--model, --map-model, --reduce-model, and their empty-string forms.

- **Scenario:** parity/recap global/missing-flag-value, global/empty-flag-value

### recap invalid-octal numeric flag value (--window/--fanout)

- **Source behavior:**

a leading-zero digit string with an 8/9 digit (`019`, `09`) fails Bash's own `[[ "$N" -ge 10 ]]`
numeric-context test; bash prints ITS OWN diagnostic line before the script's die(): `<script>:
line N: [[: 019: value too great for base (error token is "019")` + `recap: error: --window must
be a number >= 10`

- **Port behavior:** `recap: error: --window must be a number >= 10` (die text only)

- **Why:**

same class as the `${2:?}` row — a bash-builtin's own diagnostic leaking to stderr, embedding an
absolute path + line number, unreproducible from TS; exit code, stdout, and on-disk state all
match

- **Scenario:** parity/recap adversarial flags/window-octal-invalid-extra-stderr-line, flags/fanout-octal-invalid-extra-stderr-line

### recap lock reclaim mkdir diagnostic leak (non-empty stale lock dir)

- **Source behavior:**

a stale-aged (>30min) but NON-EMPTY lock dir (filesystem debris, or a second writer's temp file)
makes Bash's `rmdir` fail silently, then the subsequent `mkdir "$LOCK"` ALSO fails (dir still
exists) and PRINTS ITS OWN diagnostic before the script's die(): `mkdir: <path>/.lock: File
exists` + `recap: error: another recap is in progress …`

- **Port behavior:** `recap: error: another recap is in progress …` (die text only)

- **Why:**

same class as the `${2:?}`/octal rows — `mkdir(1)`'s own diagnostic leaking to stderr,
unreproducible from TS; exit code and the die message match

- **Scenario:** parity/recap adversarial lock/concurrent-shape-lock-nonempty-refuses-rmdir

### recap corrupt/missing episodes.jsonl or themes.json (jq-abort family)

- **Source behavior:**

a jq parse/open failure on a corrupt or (for `--cached` print) missing
episodes.jsonl/themes.json aborts under `set -e` with jq's OWN message + jq's OWN exit code — 2
for a file-open failure (`jq: error: Could not open file …/episodes.jsonl: No such file or
directory`), 5 for a parse error (`jq: parse error: Invalid numeric literal at line 1, column
5`)

- **Port behavior:**

`recap: error: episodes.jsonl: Could not open …` / `recap: error: themes.json: parse error: …`
(JSON.parse's own message), exit 1 uniformly

- **Why:**

a jq exit code + wording leaking through `set -e` is not a contract (same rationale as the llm
module's identical-class row); the port fails at the same logical point with its own message.
stdout and on-disk state (where applicable) match

- **Scenario:**

parity/recap adversarial cache/themes-present-episodes-missing-print,
cache/themes-json-corrupt-print-text, cache/episodes-jsonl-last-line-corrupt-resume,
jqabort/corrupt-episodes-last-line

### recap episodes.jsonl missing separator newline after a crash mid-append

- **Source behavior:**

neither Bash's `>>` append nor the port's `fs.appendFileSync()` inserts a newline before
appending to an episodes.jsonl whose last byte isn't already `\n` (a plausible crash-recovery
artifact) — BOTH sides produce the identical malformed `...}{...}` on-disk concatenation.
Downstream, Bash's reduce-time `--argjson` parse of the corrupt joined text fails with jq's own
usage banner (`jq: invalid JSON text passed to --argjson`, exit 2, after 2 llm calls)

- **Port behavior:** the port's resume-parse step fails ONE STEP EARLIER, before the reduce llm call, with JSON.parse's own message, exit 1

- **Why:**

same jq-abort family, but reachable from ordinary crash recovery, not only an adversarial LLM
reply; since the port stops earlier, call count and cached state after that point necessarily
differ too

- **Scenario:** parity/recap adversarial cache/episodes-jsonl-no-trailing-newline-resume

### recap first-ever run with zero renderable steps (unguarded episodes.jsonl open)

- **Source behavior:**

on a first-ever run (no prior cache) whose trajectory renders zero steps (empty file, or every
line filtered), Bash's `_reduce_themes` still runs (themes.json is missing) and does `wc -l <
"$EPISODES"`; `$EPISODES` was never created, so bash's OWN `<` redirection fails and aborts
under `set -e` (`<script>: line 350: …/episodes.jsonl: No such file or directory`) before ever
reaching the script's own "no recap yet" check

- **Port behavior:**

`reduceThemes()` reads the missing file as `""` (0 episodes) with no crash, and `runRecap`
reaches its OWN deliberate `die("no recap yet — run without --cached to generate one")`

- **Why:**

Bash's failure is an accidental artifact of an unguarded file-open in a branch the original
author likely never exercised with zero episodes, not a designed error path — same class as the
skills `set -e` crash-smoothing deviations: don't degrade the port to reproduce an accidental
Bash crash. Exit code coincidentally matches (1); only stderr text differs

- **Scenario:** parity/recap adversarial traj/empty-file-zero-bytes, traj/non-string-source-field-truthy-nonstring

### recap arithmetic on an unset-shell-variable-shaped env value (set -u)

- **Source behavior:**

an env value shaped like a bare shell identifier (e.g. `RECAP_CONTEXT_BUDGET_MAX=notanumber`) is
fed straight into bash arithmetic (`(( budget > cap ))`); bash re-dereferences it AS A VARIABLE
NAME, finds it unset, and this script's `set -u` aborts immediately: `<script>: line 543:
notanumber: unbound variable`, exit 1, no output, no cache written

- **Port behavior:** `recap: error: notanumber: unbound variable`, exit 1, no output, no cache written (F2 below)

- **Why:**

same class as the `${2:?}` row — Bash's diagnostic embeds its own script path + line number,
unreproducible from TS; exit code, stdout, and on-disk state all match

- **Scenario:** parity/recap adversarial context/budget-cap-env-non-numeric-identifier

### recap LLM reply is not a JSON object at the top level (map/reduce/rollup)

- **Source behavior:**

`$body.title`/`.arc`/`.summary` etc. on a non-object top-level reply (array/string/number)
aborts under `set -e` with jq's own exit 5 + message, e.g. `jq: error (at <unknown>): Cannot
index string with string "title"`; the map call also leaves a stray ZERO-BYTE episodes.jsonl
(the `>>` redirect creates/truncates the file before jq fails)

- **Port behavior:**

`recap: error: episode 1: Cannot index string with "title" (model reply is not a JSON object)`,
exit 1; leaves NO episodes.jsonl at all (mkdirSync makes the empty recap/ dir; nothing is
written before the throw)

- **Why:**

a jq exit code + wording leaking through `set -e` is not a contract; the port fails at the same
logical point with a uniform message. The port's own PORT-NOTE (bodyObj()) promised this row

- **Scenario:**

parity/recap adversarial llm/map-string-top-level-reply-then-ok,
llm/map-number-top-level-reply-then-ok, jqabort/map-reply-is-array,
jqabort/reduce-reply-is-array, jqabort/reduce-reply-is-string, jqabort/rollup-reply-is-array

### recap well-formed reply, malformed downstream reduce-time shape

- **Source behavior:**

a well-formed map reply whose `themes`/`key_steps` field has the wrong shape (e.g. an object
instead of an array) succeeds through episode summarization and only aborts DOWNSTREAM, at
reduce/print time, indexing into the constructed themes.json — jq's own exit 5 + message at that
later point, e.g. `jq: error (at themes.json:12): Cannot index number with string "episodes"`

- **Port behavior:**

fails at the analogous later point with its own message, exit 1, e.g. `recap: error:
themes.json: string and number cannot be added`

- **Why:**

same jq-abort family; the two implementations reach the type error via slightly different
downstream paths so the exact field name/message differs, but exit code + stderr diverge the
same way. On-disk state matches (both sides write the same episodes.jsonl/themes.json up to that
point)

- **Scenario:** parity/recap adversarial llm/map-themes-is-object-not-array, llm/map-reply-with-del-and-unicode-title

### recap huge (>1MiB) LLM reply: port completes, Bash hits the OS ARG_MAX

- **Source behavior:**

Bash's `$(printf … | llm …)` has no output-size limit and captures a huge reply fine; the huge
body is then re-passed to jq as a `--argjson` COMMAND-LINE ARGUMENT, which hits the OS's ARG_MAX
and fails to exec: `<script>: line 330/369/568: /usr/bin/jq: Argument list too long`, exit 126,
no further calls, no output

- **Port behavior:**

F1 below gives spawnSync an unbounded maxBuffer, so the reply is captured and processed entirely
in-process (no argv involved) — the run completes normally, exit 0, full stdout/cache state (the
map scenario needs one MORE llm call than Bash ever reaches, for the reduce stage)

- **Why:**

Bash's failure is an OS/jq argv-length artifact, not designed behaviour; reproducing it would
mean simulating the local ARG_MAX and jq's own argv handling — not worth chasing. The port now
at least SEES a huge reply instead of silently discarding it via an unrelated maxBuffer error
(the bug F1 fixes)

- **Scenario:**

parity/recap adversarial llm/map-huge-reply-exceeds-node-maxbuffer,
llm/reduce-huge-reply-exceeds-node-maxbuffer, llm/rollup-huge-reply-exceeds-node-maxbuffer

### llm: keep-alive lines before the first data line cost upstream quadratic time (bash string append)

- **Source behavior:**

`bin/llm`'s stream readers append every line seen before the first `data:` line to `_err_buf`
with `_err_buf="${_err_buf}${line}\n"`, a full copy per line, so the cost grows with the square
of the line count. Measured against a well-formed stream (chunked, terminating chunk, `data:
[DONE]`, keep-alive comment lines, then `finish_reason: length` with no content),
`LLM_RETRIES=0`: 4,000 lines 1.4 s, 16,000 lines 21.6 s; the >1 MiB recap fixture (49,152 lines)
takes minutes per attempt, times 3 attempts

- **Port behavior:**

`src/llmProvider.ts` appends to a JS string (amortised linear) and reads the same stream in well
under a second, warns `output truncated at max_tokens`, retries the empty reply, and recap
carries on

- **Why:**

not a hang and not a malformed fixture: the input is well formed and every byte arrives;
upstream is just slow on it. A real provider sends keep-alive comments before the first token
while it thinks, so the shape is realistic, though rarely this long. The port's linear behaviour
is the sane one and is kept

- **Scenario:**

parity/recap adversarial llm/map-capped-stream-over-1mib, llm/reduce-capped-stream-over-1mib,
llm/rollup-capped-stream-over-1mib (upstream killed at the harness's 120 s per-invocation limit)

### skills required-flag value MISSING or EMPTY

- **Source behavior:** Bash `${2:?msg}` → `<script>: line N: 2: <msg>` on stderr, exit 1 — fires on missing AND empty `""`

- **Port behavior:** clean `skills: error: <msg>`, exit 1 (stdout empty + on-disk state unchanged)

- **Why:**

same rationale as mem: Bash's shell-builtin text embeds an absolute path + line number, brittle
and worse than the port's uniform error form. The prior port threw an UNCAUGHT `SkillsError`
from the flag loop → a Node stack trace; now routed through `fail()`. Covers
--dir/--remotes/--format/--name/--description and their empty-string forms (M1: `req()` now
rejects `""`; `init --description ""` dies without scaffolding).

- **Scenario:** parity skills global/{dir,format}-missing-value, empty-required/*; test/skills.test.ts M1 cases

### skills set-e-crash smoothing

- **Source behavior:**

Bash aborts under `set -e`/`pipefail`: a name-less/desc-less skill trips `name=$(grep '^name:')`
(list → rc 1, no listing); empty/EOF stdin trips `read -r reply` in remove (rc 1, no
"Cancelled."). The basename/cancel fallbacks are dead code in Bash.

- **Port behavior:**

port reaches the fallback the surrounding code was written for: lists the skill with basename
name / empty description (rc 0); prints "Cancelled." (rc 0). On-disk state is identical (skill
listed / kept).

- **Why:**

rule: don't degrade the port to reproduce a `set -e` crash of paths the source clearly intended
to reach. Only stderr + exit differ; stdout(list)/on-disk match. **The name-less-skill case is
BEHAVIORAL, not cosmetic:** `skills list`/`prompt` is a CONSUMED happy-path the monolith reads
into context, so a real name-less skill yields *different context* between source (listing
aborts) and port (extra basename row). Still kept-graceful, but downstream consumers should
know.

- **Scenario:** parity skills list/{name-fallback-basename,description-missing-crash}, remove/empty-stdin-cancel

### put --force onto an existing directory (mv-into-directory accident)

- **Source behavior:**

Bash `mv -f "$tmp" "SOMEDIR"` treats an existing directory target as "move INTO it": lands
`SOMEDIR/put.XXXXXX` with the right bytes, then the script's own `wc -c < "$file"` fails on the
now-directory path — exit 1, with a stray `put.XXXXXX` stranded inside SOMEDIR (the `trap …
EXIT` cleanup had already disarmed after the successful mv).

- **Port behavior:**

`fs.renameSync` does a literal POSIX rename with no "move into an existing directory" fallback;
it throws EISDIR immediately (exit 1) and the catch removes the temp before rethrowing — SOMEDIR
is left exactly as found, empty or not, no stray file.

- **Why:**

unintended Bash accident, not designed behaviour — same class as the skills `set -e`
crash-smoothing deviations above: don't degrade the port to reproduce an accidental mv side
effect. Both sides fail nonzero and write nothing usable; only the port avoids the leaked temp
file.

- **Scenario:**

parity/put osfail/existing-empty-dir-force-mv-into-dir-accident; test/put.test.ts "FILE names an
existing directory with --force (mv-into-directory accident — deviation #3c)"

### mem edit summary byte-truncation on a split multibyte char (S1)

- **Source behavior:** `head -c 80` writes the raw partial bytes (dangling, invalid UTF-8) when byte 80 splits a char

- **Port behavior:** `Buffer.subarray(0,80).toString("utf8")` replaces the split char with U+FFFD (`EF BF BD`)

- **Why:**

on-disk summary bytes differ ONLY when an edited first line > 80 bytes splits a multibyte char
exactly on the 80th byte; the port keeps valid UTF-8 rather than a dangling byte. `mem add`'s
summary is char-sliced (code-point-aware, M2) and unaffected.

- **Scenario:** src/mem.ts summaryBytes

### mem list positional limit N (S3)

- **Source behavior:**

Bash `case [0-9]*` → shell arithmetic + `tail -n`; non-plain-integer forms (`08`/`09` octal,
`3.5`, `1e1`, `3abc`, dates) error, list ALL, and print a Bash arithmetic-error stderr line

- **Port behavior:** port applies the limit for any finite `Number(a)`

- **Why:**

diverges on non-plain-integer positionals: row count and/or the Bash stderr line the port omits.
Plain non-negative integers match. Reachable if the model zero-pads a count or mistypes a date
as the positional.

- **Scenario:** src/mem.ts actionList

### .memrc inline # comment (S4)

- **Source behavior:** `source .memrc` treats an unquoted trailing `#…` as a shell comment

- **Port behavior:** the `KEY=VALUE` regex captures the rest of the line, comment included

- **Why:**

`MEM_TYPE=fact # note` → Bash `type: fact`, port `type: fact # note`. `.memrc` is parsed as
simple `KEY=VALUE` assignments (documented simplification), not sourced as shell — inline
comments and other shell constructs are not interpreted.

- **Scenario:** src/mem.ts parseMemrc

### llm required-flag value MISSING or EMPTY

- **Source behavior:** Bash `${2:?msg}` → `<script>: line N: 2: <msg>`, exit 1

- **Port behavior:** clean `llm: error: <msg>`, exit 1 (no request, no state)

- **Why:** same rationale as mem/skills. Covers -m/-s/--system-prompt-file/-t/-M/--provider/--effort.

- **Scenario:** parity llm args/*-missing-value, *-empty-value

### llm -M that jq cannot consume

- **Source behavior:** invalid JSON → jq parse error, exit 5; non-array with `-s` → jq "cannot be added", exit 5

- **Port behavior:** `llm: error: --messages is not valid JSON` / `… must be a JSON array (cannot prepend the system message)`, exit 1

- **Why:**

a jq exit code leaking through `set -e` is not a contract; every failure exits 1. Valid `-M` is
passed through unvalidated (parity).

- **Scenario:** parity llm args/messages-invalid-json, messages-object-with-system

### llm transport-failure wording (streaming path)

- **Source behavior:**

relays curl's text: `curl error: curl: (7) Failed to connect …` / `(18) transfer closed …` /
`(28) Operation too slow …` on stderr and in the health-marker `message`

- **Port behavior:** `request failed: <node detail>`

- **Why:**

there is no curl; stdout (incl. partial streamed output), exit code, retry count and marker
`kind` are identical. The non-streaming path never carried curl's text (`HTTP 000`) and is at
parity.

- **Scenario:** parity llm stream/conn-refused, midstream-fail-no-retry, stall-no-bytes

### llm non-JSON 2xx body (non-streaming)

- **Source behavior:**

`set -e` crash inside the jq checker: exit 5, silent, no marker, no retry On GNU/Linux the abort
also leaves the response body behind as `$TMPDIR/tmp.XXXXXXXXXX` (`local_resp=$(mktemp)` is not
in `_llm_cleanup`; GNU mktemp honours `$TMPDIR`); the macOS baseline did not show it. The port
writes no temp file

- **Port behavior:** `llm: error: API error: response body is not JSON (HTTP 200)`, exit 1, no marker, no retry

- **Why:** a silent crash is not a designed behaviour; fail at the same point, loudly

- **Scenario:** parity llm nostream/not-json-200

### llm unparseable SSE data: event

- **Source behavior:** per-delta jq prints `jq: parse error …` to stderr, extracts nothing

- **Port behavior:** skipped silently

- **Why:** stdout/exit/state identical; the noise line was never a contract

- **Scenario:** parity llm stream/bad-json-event-skipped

### llm .env loading

- **Source behavior:** `source`d in a subshell (arbitrary shell)

- **Port behavior:** parsed as `[export ]KEY=VALUE` lines, like the port's `.memrc`

- **Why:**

fill-only-missing (set-but-empty counts as set), cwd `.env` then state-home `.env`, cwd `.env`
may set `HEADLONG_HOME` — all at parity; only shell constructs inside the file are not
interpreted

- **Scenario:** parity llm dotenv/*

### llm network guards

- **Source behavior:** curl `--connect-timeout` / `--max-time` / `--speed-limit`+`--speed-time`

- **Port behavior:**

`LLM_MAX_TIME` = AbortController deadline (parity: `HTTP 000` non-streaming);
`LLM_SPEED_LIMIT`/`LLM_SPEED_TIME` ≈ "no bytes for LLM_SPEED_TIME seconds";
`LLM_CONNECT_TIMEOUT` — **now applied** (RESOLVED), approximated as "time until `fetch()`
resolves" (connect + TLS + request-send + time-to-first-byte) rather than curl's narrower
TCP+TLS-only window, since fetch/undici exposes no connect-phase hook without a custom
Dispatcher (the `undici` package as a new dependency, out of scope)

- **Why:**

against a server that connects instantly but answers slowly, the Bash's connect-timeout never
fires (connect itself was fast) while the port's broader timer can abort the call at the same
deadline; identical once headers arrive before the deadline either way

- **Scenario:**

test/llmCli.test.ts "LLM_CONNECT_TIMEOUT" cases (fires before headers, does not fire once
headers arrive, `=0` disables); `parity/llm` stream/connect-timeout-* (2 byte-identical + 1
documented deviation `connect-timeout-approx`)

### llm user:pass@ in LLM_API_URL

- **Source behavior:** curl uses the userinfo as Basic auth unless an explicit Authorization header is sent

- **Port behavior:** userinfo stripped from the URL (fetch refuses it) and reproduced as `Authorization: Basic …` when no Bearer is set

- **Why:** same wire behaviour; the host-only warning is at parity

- **Scenario:** parity llm url/compat-basic-auth-from-url, keyed-warns-host-only-creds

### llm 2xx JSON whose shape aborts the jq checker/extractor (non-streaming)

- **Source behavior:**

`{"error":"str"}`, `{"choices":"str"}`, a choice whose `error` is a string: `set -e` crash
inside `check_response_openai` — exit 5, silent, no marker, no retry.
`{"choices":[{"message":"hi"}]}`: crash inside `extract_text_openai` — exit 5, silent, AFTER the
ok marker and ledger line On GNU/Linux the abort also leaves the response body behind as
`$TMPDIR/tmp.XXXXXXXXXX` (`local_resp=$(mktemp)` is not in `_llm_cleanup`; GNU mktemp honours
`$TMPDIR`); the macOS baseline did not show it. The port writes no temp file

- **Port behavior:**

dies at the same two points: `llm: error: API error: response shape is not readable (HTTP 200)`
(before the marker) / `… response text is not readable (HTTP 200)` (after marker + ledger), exit
1, no retry

- **Why:**

Bash crash artifact. F11 removed the port's silent success (it exited 0 with an ok marker); what
remains is the exit code (1 vs 5) and the loud message, as for the non-JSON 2xx row

- **Scenario:**

parity llm adversarial nostream/error-is-string-jq-crash, choices-is-string-jq-crash,
choice-error-is-string, message-is-string-extract-crash

### llm usage record with a missing leading/middle token field

- **Source behavior:**

`IFS=$'\t' read` collapses EMPTY leading/middle `@tsv` cells and shifts the remaining values
left: usage `{completion_tokens:7, reasoning_tokens:3}` is recorded as `in_tok:7,out_tok:3`;
`{prompt_tokens:120, reasoning_tokens:3}` as `in_tok:120,out_tok:3`

- **Port behavior:** each token lands in its own field: `out_tok:7,think_tok:3` / `in_tok:120,think_tok:3`

- **Why:**

deliberate fix of a source bug: the Bash misattributes tokens (the ledger and the dash then
count them wrong) whenever a provider omits prompt_tokens or completion_tokens; the port records
what the provider said. Complete records are byte-identical

- **Scenario:**

parity llm adversarial stream/usage-missing-prompt-tokens-shift,
stream/usage-missing-completion-tokens-shift, nostream/usage-missing-prompt-tokens-shift

### llm -M documents that jq and JSON.parse consume differently

- **Source behavior:**

`-M null` with `-s`: jq `[sys] + null` is `[sys]` → sent; `-M " "`: jq emits nothing → an EMPTY
body is POSTed and whatever comes back is printed; `-M "[1] [2]"`: jq streams two payload
objects → a two-document body is POSTed; `-M '[…"\ud800x"…]'` (lone surrogate escape): jq parse
error, exit 5

- **Port behavior:**

`-M null` with `-s` dies `--messages must be a JSON array …` exit 1; whitespace-only and
two-document `-M` die `--messages is not valid JSON` exit 1 (no request); the lone-surrogate
text is accepted by JSON.parse and sent

- **Why:**

absurd input: none of these is a messages array. The Bash outcomes are jq stream-parsing
accidents (an empty or two-document request body); the port refuses up front — except the
surrogate, which JSON.parse legitimately accepts

- **Scenario:** parity llm adversarial argv/M-null-with-system, M-whitespace-only, M-two-json-docs, M-lone-surrogate

### llm NUL bytes in the prompt / system-prompt file

- **Source behavior:**

`$(cat)` / `$(cat "$f")` drop every NUL byte and print `warning: command substitution: ignored
null byte in input` on stderr

- **Port behavior:** NUL bytes are kept and reach the API as `\u0000`

- **Why:** absurd input: a NUL cannot live in a shell variable; the port has no such limit and sends the bytes it was given

- **Scenario:** parity llm adversarial argv/spf-nul-byte, stdin/nul-bytes

### llm .env the Bash loader cannot source (KEY = v, CRLF line endings)

- **Source behavior:**

a `KEY = v` line matches the sed key regex but does not source → `!key: unbound variable` +
`warning: could not read .env; ignoring it`, and loading STOPS there (later keys never load →
wrong model/provider → die); a CRLF file keeps the `\r` in every value (`Unknown provider:
openai-compatible\r`, exit 1)

- **Port behavior:** `KEY = v` is skipped (not an assignment) and later keys load; lines are trimmed, so CRLF files work

- **Why:**

Bash crash artifact for `KEY = v`; deliberate tolerance for CRLF (a `.env` saved on Windows is a
real file, and the Bash failure is a confusing `\r` inside an error text)

- **Scenario:** parity llm adversarial dotenv/space-before-equals-aborts-bash, dotenv/crlf-file

### llm unreadable .env

- **Source behavior:** `sed: .env: Permission denied` on stderr, then the file is ignored

- **Port behavior:** ignored silently

- **Why:** Bash artifact: the noise line comes from sed, not the tool; stdout, exit, state and request identical

- **Scenario:** parity llm adversarial dotenv/unreadable-file

### llm HOME unset with no HEADLONG_HOME / SHELLM_HOME

- **Source behavior:** `set -u` crash: `line 35: HOME: unbound variable`, exit 1, no request

- **Port behavior:** the state home is `/.headlong`; the call proceeds (marker/ledger writes there are best-effort)

- **Why:** Bash crash artifact: an unset HOME is an environment fault, not a contract

- **Scenario:** parity llm adversarial dotenv/home-unset-no-headlong-home

### llm LLM_API_URL without a host (http://)

- **Source behavior:** `curl error: curl: (3) URL rejected: No host part in the URL` on stderr and in the marker message, exit 1, kind other

- **Port behavior:** `request failed: Invalid URL`, exit 1, kind other

- **Why:** the transport-text family: there is no curl to quote. The host-only warning (`requests go to `) is at parity

- **Scenario:** parity llm adversarial url/empty-host-warning

### llm API key containing a newline

- **Source behavior:**

curl emits a malformed request → the server answers 400 with no SSE data → `empty response:
stream ended without emitting anything`, exit 1, kind other

- **Port behavior:**

fetch refuses the header value → `request failed: Headers.append: … invalid header value`, exit
1, kind other, no request

- **Why:** absurd input (a key with a newline is never valid); exit code and marker kind identical, only the message differs

- **Scenario:** parity llm adversarial keys/newline-key

### llm error body holding several JSON documents

- **Source behavior:**

jq processes every document in the body: a streamed pre-data body
`{"error":{"message":"one"}}\n{"error":{"message":"two"}}` dies `API error: one\ntwo`; the same
as an HTTP 400 body dies `API error (HTTP 400): one\ntwo` — both into the marker message

- **Port behavior:**

one JSON document is parsed; a multi-document body is not JSON → `API error: <raw body>` / `API
error (HTTP 400)`, marker message `HTTP 400`

- **Why:** absurd input (no provider returns two documents); exit code and marker kind (other) identical

- **Scenario:** parity llm adversarial stream/error-body-two-docs, nostream/http400-two-docs

### llm non-string content re-serialized (jq keeps number literals)

- **Source behavior:**

a non-string `content` (object/array) is printed by `jq -r` pretty-printed WITH the original
number literals (`1.0`, `1E+2`, `12345678901234567890`); the request payload keeps `-M` number
literals verbatim too

- **Port behavior:** `JSON.stringify` canonicalizes numbers: `1`, `100`, `12345678901234567000` (precision loss beyond 2^53)

- **Why:**

absurd input for content (a delta/message content that is not a string); a JS number cannot
carry a literal's text. Semantic JSON is equal below 2^53

- **Scenario:**

parity llm adversarial stream/delta-content-object-literal-1_0,
nostream/content-array-literal-1_0 (stdout); argv/M-number-literals, argv/t-huge-int (raw
request bytes only — parsed requests at parity)

### llm non-integer LLM_RETRIES / LLM_RETRY_BACKOFF

- **Source behavior:**

`LLM_RETRIES=08`: bash arithmetic error (`value too great for base`) then `_max_attempts:
unbound variable` — one request, exit 1, no marker; `LLM_RETRY_BACKOFF=1.5`: `arithmetic syntax
error` at the first retry sleep — exit 1, no marker; `LLM_RETRY_BACKOFF=abc`: `unbound variable`
at the first retry — exit 1, no marker, no answer

- **Port behavior:** `08` → 8 retries (9 attempts); `1.5` → sleeps 1.5 s × attempt; `abc` → sleeps 0 and retries (then succeeds)

- **Why:**

Bash crash artifact: the knobs are documented as integers; the port parses leniently and
completes the retry loop rather than reproducing a `$(( ))` crash

- **Scenario:** parity llm adversarial stream/retries-08-octal, stream/backoff-float, stream/backoff-word

### llm --raw body that is not valid UTF-8

- **Source behavior:** `cat` writes the body bytes verbatim

- **Port behavior:** the body is decoded as UTF-8 for parsing and printed re-encoded: invalid sequences become U+FFFD

- **Why:**

absurd input (a JSON body that is not UTF-8); the parsed path (`extract_text`) is unaffected.
Fixable by keeping the body as bytes for `--raw` if a caller ever needs it

- **Scenario:** parity llm adversarial nostream/raw-invalid-utf8-body

### llm unwritable LLM_USAGE_FILE

- **Source behavior:**

`write_usage`'s redirection fails with a bash line on stderr (`line 801: nodir/u.json: No such
file or directory`); the call succeeds

- **Port behavior:** silent; the call succeeds

- **Why:** Bash artifact: a best-effort write whose noise line is not a contract; stdout, exit and state identical

- **Scenario:** parity llm adversarial nostream/usage-file-missing-dir

### llm stale multi-document LLM_USAGE_FILE

- **Source behavior:**

a pre-existing usage file holding two JSON documents, left untouched by a stream without a usage
chunk, is re-read for the ledger: `jq -c select(…) | head -1` ledgers the FIRST document

- **Port behavior:** the file is not one JSON document → nothing is ledgered

- **Why:** absurd input (the tool never writes more than one document there); the single-document stale re-read quirk is kept

- **Scenario:** parity llm adversarial nostream/usage-file-stale-two-docs

### web viewer Recap / Usage, chat/context

- **Source behavior:** original computes recap/usage; `chat`/`context` are live tools

- **Port behavior:**

recap/usage return `available:false` (no crash); all mutating endpoints 403; `bin/chat` +
`bin/context` are disclosed no-op shims

- **Why:**

out of slice for the read-only wire-model parity: the viewer degrades cleanly. The engine
rebuilds context in-process (src/context.ts); the responder owns replies, so
`bin/chat`/`bin/context` need only harmless output.

- **Scenario:** web/server/src/router.ts recap/usage (available:false), 403 guard; bin/chat, bin/context

### retrieval equal-hit tie-break

- **Source behavior:**

`awk … | sort -rn | head -1`: among memories with the same hit count the winner is the reversed
last-resort byte order of the whole `hits\tmid\tsummary` line — i.e. GNU/BSD `sort` without `-s`
picks the greatest id; under `sort -s` or a collating locale it would be awk's hash order

- **Port behavior:** PINNED rule: highest hits, then greatest id, then greatest summary, all by UTF-8 bytes (`score()` in src/retrieval.ts)

- **Why:**

the Bash rule is an artifact of `sort`'s last-resort comparison; the port makes it deterministic
and identical to what this system's `sort` does (verified)

- **Scenario:** parity/retrieval edges/tie-equal-hits (PARITY); test "PORT-NOTE tie-break"

### retrieval index awk -v s="$summary" escapes

- **Source behavior:**

a backslash sequence in a memory's `summary:` line is interpreted when the index row is written:
`\t` → TAB splits the row's fields, `\n` → newline splits the row; the surfaced summary is then
cut at the interpreted tab

- **Port behavior:** the row carries the summary bytes verbatim

- **Why:**

Bash/awk artifact, not designed behaviour; only a summary containing a backslash sequence
differs (none in pax's corpus)

- **Scenario:** parity/retrieval awk-v/awk-v-backslash-summary (documented deviation, reported not counted)

### retrieval tokenizer locale

- **Source behavior:**

Bash inherits the dispatcher's locale. Under a UTF-8 locale `tr -cs '[:alnum:]'` keeps non-ASCII
letters inside a token and `grep -E '^[a-z0-9]{3,}$'` then drops the whole word ("café" →
nothing); under C it splits on the bytes ("café" → "caf")

- **Port behavior:** the C-locale/byte pipeline the spec describes (`tokenize()`); the harness pins `LC_ALL=C` both sides

- **Why:**

only words with non-ASCII letters adjacent to ASCII differ; pax's corpus has none — the golden
index is byte-identical under both locales. The port is deterministic where the Bash depends on
the launcher's environment

- **Scenario:** parity/retrieval edges/non-ascii-c-locale (PARITY under C) + the informational UTF-8 run in its report.md

### retrieval [[ $hits -ge $RETRIEVAL_MIN_HITS ]] with a non-integer knob

- **Source behavior:**

Bash prints `<script>: line 60: [[: 1.5: arithmetic syntax error …` on stderr (script path +
line number), the test is false → exit 0

- **Port behavior:** exit 0 silently

- **Why:**

same class as the `${2:?}` deviation: Bash text embeds an absolute path + line number on a
misconfiguration path; exit code, stdout, and state match

- **Scenario:** parity/retrieval edges/min-hits-non-integer (documented deviation)

### retrieval Bash-environment artifacts (adapted)

- **Source behavior:**

`-nt`/`ls -t` mtime resolution is bash-version dependent (1 s on macOS bash 3.2); `timeout 60
mem search` needs GNU `timeout` (absent on stock macOS → semantic suffix silently "");
`${sem:0:300}` slices bytes under C; `_require_env` loads `.env` fallbacks

- **Port behavior:**

mtimeMs comparison; the shim's native 60 s spawn timeout; 300 code points; `.env` not loaded (it
only feeds semantic mode's model/key); the `mkdir -p` side effect IS replicated

- **Why:**

environment-dependent behaviour made deterministic; all semantic-mode-only except mtime, where
the port is at least as sensitive as any bash

- **Scenario:**

src/retrieval.ts header PORT-NOTEs; parity edges/semantic-suffix (stubbed `timeout`+`mem`:
PARITY), post-mem-add-rebuild


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


> Table converted to sections for GitHub rendering.

### activate

- **Source behavior:** `tools/identity` writes a source-able Bash `activate` script that exports the identity env into an interactive shell

- **Port behavior:**

no `activate` file is ever written; `src/identity-env.ts` `resolveIdentityEnv(identityDir)` is
the single source of truth every CLI/daemon/steprun calls directly

- **Why:**

DIRECTOR CORRECTION: zero Bash artifacts in this lane. A pure function is strictly better for a
port with no interactive shell to source into.

- **Scenario:** identity-new.test.ts asserts `activate` is absent

### thinkers/<name>/step

- **Source behavior:** a Bash exec-shim

- **Port behavior:** a Node file (`#!/usr/bin/env node`) that execs `bin/thinker-step.mjs <name>` via `HEADLONG_TS_HOME`

- **Why:**

DIRECTOR CORRECTION: the upstream CONTRACT is "an executable at thinkers/<name>/step" — its
language is free; Bash inside the sandbox (running the model's own bash action block) is
unaffected and unchanged.

- **Scenario:** identity-new.test.ts asserts the step file's shebang; parity/daemon adversarial `identity-new/node-step-shim`

### kernel/{mem,chat,goals}, skills/<bundled>

- **Source behavior:**

`tools/identity` SYMLINKS these into its own checkout
(`_ensure_kernel`/`_install_bundled_skills`: `kernel/mem -> <checkout>/skills/mem`, etc.)

- **Port behavior:** this port COPIES the bundled `SKILL.md` text (as `src/assets/kernel/*` and `src/assets/skills/*`) into real directories

- **Why:**

DIRECTOR CORRECTION: a portable TS package ships with no sibling Bash checkout to symlink into —
a real, self-contained copy is the only thing that works once installed elsewhere. Every skill
dir upstream ships holds only `SKILL.md` (no scripts), so this is a pure-text copy, not a
functional gap.

- **Scenario:** identity-new.test.ts asserts the SKILL.md content; parity/daemon adversarial `identity-new/kernel-skills-copied`

### thinkers/_lib/common.sh, thinkers/retrieval/build-index.sh

- **Source behavior:** Bash helper sourced by thinker `step` scripts / the retrieval index builder, both copied by `_ensure_thinkers`

- **Port behavior:**

NEVER copied — `thinkers/_lib/` is not created at all; retrieval's index build is
`src/retrieval.ts` + `bin/retrieval-step.mjs`, ported separately (see the retrieval thinker row
in Parity by module)

- **Why:**

DIRECTOR RULE: Bash/Python thinker-helper files are never copied into a TS-authored identity —
every port thinker (monolith/responder/retrieval `step`) is a self-contained Node file with
nothing left to `source`, so `thinkers/_lib/common.sh` has no caller here.

- **Scenario:** identity-new.test.ts asserts both are absent; parity/daemon adversarial `identity-new/bash-omitted`

### dispatcher event bus

- **Source behavior:** `tail -F <traj>` piped into `dispatch.fifo` (a subprocess pipeline per subscribed trajectory)

- **Port behavior:**

`TrajFeeder` — in-process `fs.watch` + tick-driven poll, tail-from-offset with partial-line
stitching. A record the dispatcher ITSELF appends (the salience `feedback` injection) is fed
back through `Dispatcher.feed()` synchronously, right after the write, instead of waiting for
the feeder's own next poll — matching upstream's `tail -F` pipe, which discovers a line appended
to an already-tailed file within the same read-loop pass, not a tick later. The feeder's offset
is resynced past those bytes so it never redelivers them.

- **Why:**

avoids one subprocess-plus-FIFO pair per trajectory; the daemon's 1s tick is the guaranteed
delivery floor for everything else either way (fs.watch is best-effort, documented in
feeder.ts's own header — see feeder.test.ts, which drives watch-or-poll together rather than
asserting on the OS event alone). `run/dispatch.fifo` and `run/tail_pids` are therefore never
created by this daemon.

- **Scenario:**

daemon.test.ts (incl. the byte-diff busy→queued→feedback→re-fire sequence), feeder.test.ts;
parity/daemon adversarial `chat-reactive/dispatcher-log-line-shapes`

### the detached drain reaper

- **Source behavior:**

`_drain_then_finish`/`_drain_all_then_finish` (bin/thinkers:1250-1276) background a `(...)
</dev/null >/dev/null 2>&1 & disown` subshell — a genuinely separate OS process the parent shell
doesn't wait on — so `thinkers stop` returns immediately while draining (and the `stop` script
it now runs, see the daemon-runtime gap fixes above) continues independently

- **Port behavior:**

`drainThenFinish` (thinkersctl.ts) spawns `bin/thinkers-drain.mjs` DETACHED + `unref()`'d, the
same technique `thinkersStart` uses for the dispatcher — a real second OS process, not an
in-process timer

- **Why:**

an EARLIER version of this port ran the wait as an un-awaited in-process `setTimeout` loop; that
let a direct library caller's own Promise resolve right away, but Node's event loop stays alive
for as long as a pending timer exists, so the standalone `bin/thinkers.mjs stop` CLI PROCESS
hung until the drain finished regardless — failing "stop returns immediately" against the real
oracle (`tests/test_thinkers_drain.sh`, which times the CLI invocation, not just the promise). A
real detached child process is required to match upstream's actual "parent exits, child keeps
running independently" semantics in Node.

- **Scenario:** thinkersctl.test.ts "stop scripts" describe block; parity/upstream-tests test_thinkers_drain.sh (11/20 -> 20/20)

### the self-stop guard's cgroup fast path

- **Source behavior:** checks `/proc/self/cgroup` against the dispatcher's cgroup, scoped to a systemd unit name

- **Port behavior:**

not ported — only the ppid-ancestry walk (exact for attached steps on every platform, including
macOS dev machines with no `/proc`)

- **Why:**

the cgroup path is a systemd-only concern; this port ships no systemd units. The ppid walk is
upstream's own fallback for hosts without `/proc` cgroups, and this port relies on it
exclusively.

- **Scenario:** thinkersctl.ts insideOwnDispatcher

### multiple subscriptions.jsonl lines for one thinker

- **Source behavior:** each line is routed independently

- **Port behavior:**

the daemon merges all of a thinker's lines into ONE Subscription (union types, OR trigger_self,
min nonzero watchdog) for routing; run/sub_map still records one row per raw line

- **Why:**

Subscription is singular per ThinkerDef; every bundled thinker ships exactly one line, so this
never fires today. Documented rather than silently wrong if a future thinker ships two.

- **Scenario:** src/daemon.ts parseSubscriptions/byThinker

### Dispatcher.bootTrigger payload — RESOLVED, was a Gap below

- **Source behavior:** upstream's boot-kick pending file carries no content field

- **Port behavior:** bootTrigger now dispatches type+source only — content dropped, matching upstream

- **Why:** fixed as part of this lane's dispatcher.ts refactor; the stale gap row further below is superseded

- **Scenario:** topology.test.ts spontaneous/manual-trigger:thinkers-cli; runstate.test.ts manualTriggerJson

### SHELLM_WORKDIRS_DIR / IDENTITY_DIR docker binds

- **Source behavior:** two separate -v mounts (a workdir can live outside the identity tree)

- **Port behavior:** one -v identityDir:identityDir bind (every step's workdir is created under identityDir/.shellm/workdirs)

- **Why:** steprun.ts always nests the workdir under the identity dir, so a second bind is redundant

- **Scenario:** src/sandbox-runtime.ts startDockerSandbox

### headlong-killall process-argv patterns

- **Source behavior:**

`bash <path>/(bin|tools)/(shellm|shellm-explore|llm|chat|sub)`, `bash <path>/bin/thinkers`,
`bash <path>/thinkers/*/step`, `bash <path>/bin/traj tail`, orphaned `tail -n 0 -F
…/trajectory.jsonl` followers

- **Port behavior:**

`node .../bin/dispatcherd.mjs`, `node .../thinkers/<name>/step`, `node
.../bin/thinker-step.mjs`, `node .../bin/sub.mjs`, `node .../bin/chat.mjs` (+ `--web`'s
`web/server/src/index.ts`) — NO pattern for `traj tail`/an orphaned `tail -F` follower

- **Why:**

the TS daemon runtime has fundamentally different process shapes: no standalone `shellm`
agent-loop process (a thinker step is one self-contained Node process), and the feeder
(`src/feeder.ts`) is an in-process `fs.watch`, not a subprocess `tail -F` — there is nothing of
that shape to reap. `bin/traj.mjs tail` is a synchronous one-shot (prints N lines, exits), not a
follower.

- **Scenario:**

src/killall.ts header PORT-NOTE; parity/killall (structural scenarios exclude the live listing
from comparison for exactly this reason)

### killall.test.ts psSnapshot injection

- **Source behavior:** none — upstream has no way to scope a raw CLI invocation

- **Port behavior:**

`KillallOptions.psSnapshot` — an injectable override, defaulting to the real unrestricted
system-wide scan for production/CLI use

- **Why:**

killall is DELIBERATELY system-wide (a panic button has to see every matching process on the
machine); exercising the real default for a REAL (non-dry-run) kill inside an automated test on
a shared dev machine is genuinely dangerous — an earlier, unscoped version of this test suite
matched and SIGTERM'd a live `dispatcherd.mjs` belonging to another agent's test run in a
sibling worktree before this seam was added (confirmed harmless after the fact, but the wrong
outcome). Every real-kill test scopes `psSnapshot` to its own spawned decoy pids; the one test
exercising the real unrestricted CLI (self/ancestor protection) is pinned to `--dry-run`.
Production/CLI behavior (`bin/headlong-killall.mjs`) is unaffected — it never passes
`psSnapshot`, so it always gets the real scan.

- **Scenario:** test/killall.test.ts (file header explains the incident); parity/killall (dry-run only, same reasoning)


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


> Table converted to sections for GitHub rendering.

### live xtrace/output streaming during a command

- **Source behavior:**

`_stream_new_output` (bin/shellm:1979-2006) polls the running command's output file every 0.2s
and streams new lines to stderr AS THEY APPEAR, while the command is still executing

- **Port behavior:**

`printExecOutputLines` (src/shellm.ts) reproduces the SAME lines, in the SAME order (a
`+`-prefixed xtrace line cyan with `+ ` stripped, else dim with a `│ ` marker, both through
`redactSensitive`), but only once, after `Sandbox.exec()` returns the whole combined output

- **Why:**

this port's `Sandbox.exec()` (src/sandbox.ts, src/sandbox-docker.ts) is a blocking call that
hands back output only once the command has finished — there is no incremental read seam to
poll. Content/order is identical (both sides read the same `set -x`-interleaved stdout+stderr
stream); only the WALL-CLOCK GRANULARITY of when a line hits stderr differs (batched vs
incremental)

- **Scenario:**

test/progress-logs.test.ts (fast fake commands, where this makes no observable difference);
would matter for a real long-running shell command, not exercised here

### Docker container setup/reattach preamble (Setting up Docker container (...), Docker container ready (id), Reattached to Docker container (id), Created env/Using env) — BEHAVIOR RESOLVED (bug #32), text still not emitted

- **Source behavior:**

upstream's `env`/container concept is PERSISTENT across wakes — a `shellm --env NAME` invocation
reuses (`Reattached to...`) or creates (`Docker container ready`) one long-lived container per
env name

- **Port behavior:**

`selectSandbox`/`startDockerSandbox` (src/sandbox-runtime.ts, src/sandbox-env.ts) now DOES reuse
a running, image-matching container across wakes (persistent per identity/env name, only torn
down via `tempDocker`/killall/a future `identity delete`) — the behavioral gap this row used to
describe is closed. What remains genuinely unported: this port's sandbox selection is silent (no
`progress()`-equivalent stdout at all, on either the fresh-create or the reuse path), so there
is still no "Setting up..."/"Reattached to..."/"Created env"/"Using env" TEXT — printing it now
would be accurate (a reuse really is a reuse), just not implemented, since nothing in this
port's steprun path currently emits sandbox-setup progress text to any stream a golden trace or
test observes

- **Why:**

test/sandbox-env.test.ts (real docker): two-wake reuse via a cross-step marker file + a single
`docker ps` match; env.name/docker_image on the SelectSandboxResult reflect the actual reused
env, matching what the (unemitted) upstream text would have said

- **Scenario:** src/sandbox-runtime.ts startDockerSandbox, src/sandbox-env.ts

### run-startup preamble (Using trajectory: ID, Trajectory: ID (dir: ...), Workdir: ...)

- **Source behavior:** printed once by the `shellm` CLI itself at the top of its own invocation, before "Starting shellm loop"

- **Port behavior:**

not printed — this port's `runShellm` is a function call inside an already-running wake process,
not a fresh CLI invocation; the trajectory/workdir are already known to the caller
(`steprun.ts`) before `runShellm` is ever called

- **Why:**

low information value (every field is already on the `shellm-run` header this port DOES write,
and in the daemon path the workdir/trajectory never change wake-to-wake) relative to the
loop-body lines this fix prioritized; not reproduced this pass

- **Scenario:** none — open gap, not exercised by test/progress-logs.test.ts

### KILLED kill-reason ("idle" vs "nested", bin/shellm:2652-2658) — RESOLVED (bug #33, fix/inactivity-watchdog)

- **Source behavior:**

two independent timeouts: a short `SHELLM_INACTIVITY_TIMEOUT` (default 30s, "idle" — no new
output at all) and a longer `SHELLM_INACTIVITY_MAX` (default 900s, "nested" — a silent sub-run's
activity beacon is stale)

- **Port behavior:**

now ported: `execWithInactivityWatchdog` (src/sandbox.ts), shared by
`LocalSandbox`/`DockerSandbox`, tracks `staleMs` (resets on any output byte OR an
activity-beacon touch) and `quietMs` (resets ONLY on real output) separately, matching
upstream's two-timer algorithm exactly. `ShellmConstants.inactivityTimeoutMs` (new;
`SHELLM_INACTIVITY_TIMEOUT`, default 30s) and `.inactivityMaxMs` (`SHELLM_INACTIVITY_MAX`,
default 900s, unchanged name) are both wired through `constantsFromEnv`. `ExecResult.killReason`
is `"idle"` or `"max"` (upstream's "nested" — see below for the label difference);
`src/shellm.ts` prints/records the matching distinct KILLED line and feedback for each (`KILLED
— inactivity timeout (Ns)` vs `KILLED — sub-run silent for Ns`)

- **Why:**

"nested" is renamed "max" here on purpose, not merged: this port has no standalone `shellm` CLI
at all (confirmed — see the `0925168` Gaps row), so the model's exec'd bash can never literally
run a NESTED shellm loop; upstream's own beacon path
(`SHELLM_ACTIVITY_FILE="$rundir/.activity"`, bin/shellm:2579) is unconditional — no docker-mode
rewrite unlike `final_path` a few lines up — so it was never reachable from inside upstream's
OWN Docker branch either, a real pre-existing upstream limitation this port reproduces
faithfully rather than "fixing": the port forwards the same beacon path into `DockerSandbox`'s
exec'd env, but the watchdog's poll always runs HOST-side (matching where upstream's own
watchdog subshell runs, for both branches), so a beacon touch works for `LocalSandbox` and is a
faithful no-op for `DockerSandbox`. The mechanism (not the "nested" label) is what's proven

- **Scenario:**

test/sandbox-watchdog.test.ts (LocalSandbox: chatty-survives-idle / silent-killed-at-idle /
beacon-active-killed-at-max, each also under a real DockerSandbox that skips cleanly with no
daemon); test/shellm.test.ts "runShellm: inactivity watchdog KILLED distinction (bug #33)" (both
KILLED lines + feedback strings, through the real loop); `parity/sandbox/run-parity.mjs`'s new
`idle-kill` scenario (7/7 differential); oracle read directly:
`tests/test_inactivity_beacon.sh`, now classified in `parity/upstream-tests/run.mjs` (5/5,
no-port-cli — see that file for why cases 2/3's nested-beacon scenario specifically has no
port-side analogue)

### chat reply's duplicate-guard OUTCOME (not just its log line)

- **Source behavior:**

`chat reply`'s answered-guard (bin/chat:330-343) returns EXIT 0 on a duplicate (no message sent,
but not an error) — `thinkers/responder/step`'s `if ... chat reply ...; then` branch therefore
still takes the SUCCESS path: `decision:"replied"`, `[reply -> X] <text>` printed, `Reply sent.`
never printed (chat.ts's own `io.stderr` for the duplicate case prints `"chat: step ... already
has a reply from ... — skipping duplicate send."` instead)

- **Port behavior:**

`runResponder` (src/responder.ts) checks `hasStampedReply` BEFORE attempting to append the
`message` step; when true, it falls straight to the `reply-failed` branch
(`decision:"reply-failed"`, `"  reply failed — appending failure observation"`) — `Reply sent.`
and `[reply -> X]` are never printed for this case

- **Why:**

a REAL, pre-existing behavioral difference this fix's log-line audit surfaced, not merely a
missing print: the port never calls `chat reply` at all (it appends the `message` step directly
— see the doc comment on that branch in src/responder.ts), so it has no equivalent of `chat
reply`'s own EXIT-0-on-duplicate semantics to reproduce. Fixing the OUTCOME (not just the log
text) is out of this lane's scope (observability only)

- **Scenario:**

none — open gap; the port's `decision:"reply-failed"` for a genuine duplicate is arguably more
honest than upstream's `decision:"replied"` with nothing actually sent, but it is still a
documented divergence from the oracle

### banner (banner(), bin/shellm:180-201)

- **Source behavior:** ASCII-art banner, gated by `QUIET`/`SHELLM_NO_BANNER`

- **Port behavior:** never printed

- **Why:**

NOT a gap: `thinkers/monolith/step` itself sets `SHELLM_NO_BANNER=1` on every invocation (and
monolith is the only shellm-agentic-loop caller in this port), so upstream's own real sessions
never show it either — confirmed absent from the `sxs/orig` evidence log

- **Scenario:** n/a


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


> Table converted to sections for GitHub rendering.

### control-plane mutation dispatch

- **Source behavior:**

`headlong_web/control.py` builds `identity_env` and `subprocess.run`s the Bash CLIs (`thinkers`,
`chat`, `tools/identity`) with `start_new_session=True`

- **Port behavior:**

`web/server/src/control.ts` imports `src/{identity,identity-env,thinkersctl,chat}.ts` and calls
them as plain functions — no subprocess, no shell

- **Why:**

task directive + PLAN-daemon-runtime.md §6: F1 already made the engine source-runnable from
`.ts`, so the reason upstream shells out (Bash CLIs are the only thing that runs) doesn't apply
to this port. The daemon itself is still spawned as a REAL detached OS process (`thinkersStart`
→ `spawn(process.execPath, [dispatcherd.mjs], {detached:true}).unref()`) — that half of the
process-topology split (§A) is unchanged; only the web-server-to-CLI hop is now an in-process
function call.

- **Scenario:** web/server/test/controls.test.ts (dispatcher.pid alive after start / gone after stop, over the HTTP route)

### POST /api/identities response id

- **Source behavior:** literal `.identities~<name>` (upstream's repo-root + `.identities/` nesting)

- **Port behavior:**

`discovery.identityIdFor(relative(root, identityDir))` — for this port's flat serve-root
(identity dirs live directly under `--root`, no `.identities/` nesting — see index.ts), that's
just `<name>`

- **Why:**

the literal upstream string encodes upstream's OWN directory layout; this port's
`RouterCtx.root` already IS the identities root (`index.ts`'s own doc comment), so computing the
id via the port's own discovery scheme is the faithful choice — a copy-pasted upstream string
would not resolve via `GET /api/identities/:id/...` on this port

- **Scenario:** controls.test.ts "create identity -> 201, and GET discovery finds it" (asserts `scanIdentities` returns the SAME id)

### POST .../thinkers/:name/step

- **Source behavior:** `control.py`'s `thinkers_step` is a detached `subprocess.Popen` (true fire-and-forget, separate process)

- **Port behavior:**

`control.thinkersStep` calls the library's own `thinkersStep` (which runs the step SYNCHRONOUSLY
to completion — see the thinkersctl module row) but does NOT `await` it — the promise floats,
caught, ignored; the route returns 202 immediately

- **Why:**

preserves the observable contract ("returns immediately, the step runs in the background")
without a second OS process, matching this lane's "library calls, not subprocess" choice above

- **Scenario:**

controls.test.ts "thinkers/:name/step -> 202 immediately (fire-and-forget)" (asserts response
lands in <2s regardless of step duration)

### thinkers/:name/enable/disable orchestration

- **Source behavior:** lives in `server.py` itself (touches/unlinks the marker directly, calls `control.thinkers_stop`)

- **Port behavior:**

lives in `web/server/src/control.ts` (`thinkersEnable`/`thinkersDisable`) instead of
`router.ts`, since the task scoped control.ts to own "thinkersStep/enable/disable calling the
library"

- **Why:**

thinkersctl.ts has no enable/disable of its own (only start/stop/step/list/logs/status) — this
is web-only orchestration either way; keeping it in control.ts (not router.ts) matches this
port's existing route/data-layer split (router.ts stays route-shape only)

- **Scenario:** controls.test.ts "thinkers/:name/disable then /enable round-trips the marker"

### POST .../recap/refresh

- **Source behavior:** `subprocess.Popen(_wrap("recap", "-q", …), start_new_session=True)` — a real detached Bash-wrapped CLI process

- **Port behavior:**

`control.recapRefresh` `spawn(process.execPath, [bin/recap.mjs], {detached:true,
stdio:"ignore"}).unref()` — same detached-Node-child pattern `thinkersStart` already uses for
the dispatcher, just a different target script; still a real second OS process, not an
in-process call

- **Why:**

`recap`'s own map-reduce can run for minutes and makes real LLM calls (`bin/recap.mjs`'s
`runLlm` seam is itself a `spawnSync("llm", …)`) — running it in-process would block the web
server's event loop for that whole time

- **Scenario:**

controls-slice-c.test.ts "recap/refresh ... real spawn proven by the recap/ cache dir", "409
while a refresh is already running"

### POST .../usage/refresh

- **Source behavior:**

`usage.start_refresh` runs `usage.refresh` on a background Python `threading.Thread`, guarded by
the same `.lock`-directory convention as recap

- **Port behavior:**

`usage.ts`'s `startRefresh` defers the (bounded, deterministic, no-network) scan with
`setImmediate` on the SAME process instead of a separate thread — Node has no lightweight
in-process-thread equivalent for synchronous fs/JSON work

- **Why:**

the scan is pure local file/JSON work (mind-log + ledger byte-offset tailing), unlike recap's
LLM calls — the `.lock` directory, 202 response, and final cache state are identical; the
difference is only which execution context does the (fast) work

- **Scenario:** controls-slice-c.test.ts "usage/refresh ... 409 ... cache.json written by the deferred refresh"

### POST /api/llm-health/probe

- **Source behavior:** `control.llm_probe` shells to `llm --no-stream --raw -t 60 [-m MODEL] ping` as a subprocess (`run_cli`)

- **Port behavior:**

`control.llmProbe` calls `src/llmCli.ts`'s `runLlm` in-process (the SAME function `bin/llm.mjs`
wires to argv) with an injected `io` (its `fetch` is `globalThis.fetch`, so tests stub it — no
live LLM calls; see `llm` CLI's own module row for `runLlm`'s parity level)

- **Why:**

matches this lane's "library calls into src/, no subprocess" convention; `llm`'s wire logic
already lives in a plain async function, so there is no CLI-process boundary to preserve here
the way there is for `recap`'s minutes-long, LLM-heavy run

- **Scenario:** controls-slice-c.test.ts "llm-health/probe" success/failure cases (stubbed fetch)

### POST /api/identities/import (raw body)

- **Source behavior:**

`server.py`'s route reads `request.stream()` directly (ASGI raw body), enforcing the size cap
and gzip magic-byte check inline, then calls `run_in_threadpool(control.identity_import, …)`

- **Port behavior:**

`server.ts` special-cases `POST /api/identities/import` BEFORE the shared JSON-body path
(`readRawArchiveBody`): same size cap (`HEADLONG_WEB_MAX_IMPORT_MB`, default 512) and gzip
magic-byte check, staged to a temp file, then `handleMutation` calls `control.identityImport`
synchronously (no threadpool — Node has one thread; the archive read + extract is bounded local
fs work)

- **Why:**

Node's `http` module has no ASGI-style streaming-body-per-route primitive; special-casing the
one raw-body route ahead of the generic JSON-body reader is the smallest change that preserves
the same size/magic-byte checks server.py makes before ever calling into `control.py`

- **Scenario:**

web/server/test/import.test.ts (real HTTP layer: 201/422/413/403, the last BEFORE the stream is
ever buffered — see the ordering fix below)

### POST /api/identities/import (_require_controls() ordering)

- **Source behavior:** `_require_controls()` runs as literally the route function's first line, before `request.stream()` is touched at all

- **Port behavior:**

`server.ts` checks `ctx.controlsEnabled` and drains+403s BEFORE calling `readRawArchiveBody` —
matches; NOT calling `_require_controls()` only after buffering the whole upload (which was this
lane's first draft) would have wasted a full upload's worth of disk I/O and bandwidth on a
read-only server for no reason

- **Why:** web/server/test/import.test.ts "read-only mode -> 403, before the raw stream is ever buffered"

- **Scenario:** 

### identity import bundled-thinkers root

- **Source behavior:**

`thinker_sync.bundled_root()` and `tools/identity`'s own `_bundled_skill_dir`/thinker install
default to `<repo checkout>/thinkers` (the Bash tools' own source tree)

- **Port behavior:**

`web/server/src/thinker-sync.ts`'s `bundledRoot()` defaults to `src/assets/thinkers` (this
port's bundled thinker templates, same ones `identityNew`'s `installThinker` uses) — same role,
different path

- **Why:**

there is no Bash checkout for this port to point at; `src/assets/thinkers` is this port's actual
equivalent "pristine thinkers" source, already used by `identityNew`

- **Scenario:** controls-slice-c.test.ts "thinker-sync" (in_sync after identityNew, drift+pull round-trip)

### identity import kernel/bundled-skills regeneration

- **Source behavior:**

`_install_imported_identity` calls `_ensure_kernel` (always re-`ln -s` the 3 kernel skills into
the Bash checkout) and `_install_bundled_skills` (symlink each NON-kernel bundled skill only if
the name isn't already present)

- **Port behavior:**

`identityImport`'s `installImportedIdentity` mirrors both halves of that policy exactly — kernel
skills always regenerated (`copyDirFlat`, unconditional), non-kernel bundled skills installed
only when `!fs.existsSync(target)` — but COPIES instead of symlinking, inheriting
`identityNew`'s pre-existing "kernel/skills copied, not symlinked" DIRECTOR CORRECTION (a
portable package has no Bash checkout to link into)

- **Why:**

consistency with the already-accepted `identityNew` deviation, applied to the one new place that
also installs bundled skills; getting the "skip if already installed" half right (not just
"always copy") matters because an imported identity's OWN customized skill of that name must
survive the import, not be silently clobbered by the bundled template

- **Scenario:**

test/identity-import.test.ts "creates memories/skills/... and regenerates kernel + missing
bundled skills"; parity/identity/run-import-parity.mjs (structural tree diff, ignoring only the
pre-existing symlink-vs-copy paths)

### identity import — activate file

- **Source behavior:** `_install_imported_identity` calls `_write_activate_script`

- **Port behavior:**

not written — inherits `identityNew`'s existing "no `activate` file (DIRECTOR CORRECTION 1) —
`resolveIdentityEnv()` replaces it"

- **Why:**

same reasoning as `identityNew`; an imported identity is started the same way a newly-created
one is (`resolveIdentityEnv`, not a sourced shell script)

- **Scenario:**

parity/identity/run-import-parity.mjs (the harness's structural diff explicitly ignores
`<id>/activate` as a known, pre-existing deviation)


### Telegram bridge deviations (this lane)


> Table converted to sections for GitHub rendering.

### config.load/mindlog.findTrajectory fatal errors

- **Source behavior:** `raise SystemExit("message")` — an uncaught string `SystemExit` prints the message to stderr and exits 1

- **Port behavior:**

`throw new BridgeExit(message)`, caught once at the CLI boundary (`cli.ts`'s `runCli`), printed
to stderr verbatim, `return 1`

- **Why:**

Node has no `SystemExit`; `BridgeExit` is the direct analogue — same stderr text, same exit
code, no other behavior change

- **Scenario:** test/telegram-config.test.ts (dangling-default-link, no-var-no-default cases assert on the thrown message)

### api.Bot._call's error contract on a network-level failure

- **Source behavior:**

Python's `httpx.HTTPError` (connection refused, DNS failure, a client-side timeout) is a
distinct exception family from `ApiError`; `inbound.py`'s poll loop catches `(ApiError,
httpx.HTTPError)`

- **Port behavior:**

`fetch` throws a plain `Error` for the same failure class; `Bot.call` wraps it as `HttpError`
(new class, api.ts), and `Inbound.run` catches `(err instanceof ApiError || err instanceof
HttpError)`

- **Why:**

Node's `fetch` has no typed transport-error hierarchy the way httpx does; `HttpError` reproduces
the SAME two-bucket retry contract (a malformed Telegram reply vs. a transport failure) with a
TS-native shape

- **Scenario:**

api.ts / inbound.ts source; exercised indirectly by test/telegram-inbound.test.ts's "poll loop
survives a malformed API response" (that case is the OTHER bucket, `ApiError`, but drives the
same catch clause)

### outbound.start's concurrency primitive

- **Source behavior:** a background `threading.Thread` running `outbound.run`, stopped via a shared `threading.Event`

- **Port behavior:**

`outbound.start` runs the async `outbound.run` loop un-awaited and returns a handle (`{stop(),
done}`); `cli.ts` threads one `shouldStop` closure through both `Inbound.run` and
`outbound.start`

- **Why:**

Node has no threads; the observable behavior (a concurrently running follow-loop the caller can
signal to stop, and that the CLI waits for on the way out) is the same — `stop()` flips the same
kind of boolean flag `stop_event.set()` does

- **Scenario:**

outbound.ts source; test/telegram-outbound.test.ts drives `run()` directly (the Python test does
the same, calling `outbound.run(...)` rather than `start()`)

### allowlist.json's pending.<id>.last_notified units

- **Source behavior:** Python's `time.time()`: seconds since epoch, sub-second float

- **Port behavior:**

`Date.now() / 1000`: also seconds since epoch, float, millisecond-granularity (3 decimal digits
vs. Python's finer-grained fractional seconds)

- **Why:**

matching UNITS (seconds, not milliseconds) is what keeps the on-disk field format compatible and
the `PENDING_NOTIFY_INTERVAL` (24h) comparison correct; sub-second precision is inherently
nondeterministic wall-clock noise on both sides and is normalized to `<TS>` by the differential
harness, same treatment as timestamps elsewhere in this repo's parity harnesses

- **Scenario:**

test/telegram-allowlist.test.ts "pending notifies once per interval";
parity/telegram/run-parity.mjs's `normalizeAllowlistJson`

### Bash launcher's checkout-root discovery + uv run --project telegram exec (tools/headlong-telegram-bridge)

- **Source behavior:**

walks up from the launcher script's own location to find a checkout with a `telegram/`
subdirectory (falling back to `$HEADLONG_HOME/app_dir`), defaults `ROOT` (the serve root) to
THAT checkout root, then `exec uv run --project "$ROOT_DIR/telegram" headlong-telegram-bridge
"$serve_root" "$@"`

- **Port behavior:**

NOT replicated — `bin/headlong-telegram-bridge.mjs`'s default root is `process.cwd()` (matching
`cli.py`'s own argparse default `"."`, the same default this port's other `bin/*` tools use)

- **Why:**

that discovery logic encodes upstream's two-directory repo layout (a `telegram/` uv sub-project
alongside the Bash engine) — a shape this single-repo TS port does not have and a marker
(`telegram/` existing as a directory one level down from `bin/`) that would be actively
misleading here. The launcher's OTHER job — loading `.env` files so the token can live in a file
instead of the calling shell, "already exported wins" — IS replicated (see cli.ts's
`loadEnvFile`), since that part is layout-independent

- **Scenario:** test/telegram-cli.test.ts ".env" cases; cli.ts's header comment

### JS .length vs. Python len() on tgfmt.cleanInbound's 4000-char truncation and senderLabel's 64-char cap

- **Source behavior:** Python `str` is a sequence of Unicode code points; `len()` counts code points

- **Port behavior:**

JS `string.length` counts UTF-16 code units — a supplementary-plane character (e.g. an emoji
outside the BMP) counts as 2 in JS vs. 1 in Python

- **Why:**

inherent JS/Python string-model difference, not specific to this port; only observable at the
EXACT truncation/cap boundary with a supplementary-plane character straddling it — the harness's
unicode-and-hostile-name-delivery scenario (with an emoji, `🚀`) stayed well clear of both
boundaries and reached PARITY, so this is a documented theoretical edge, not an observed
divergence

- **Scenario:**

tgfmt.ts source comment; not exercised by a scenario (would need content engineered to land
exactly on the 4000th/64th unit under both counting schemes)

### filepayload._content's content_b64 strictness (1c: ab13bab, f68ae29)

- **Source behavior:**

Python `base64.b64decode(b64, validate=True)` raises `binascii.Error` on any character outside
the base64 alphabet or a length not a multiple of 4

- **Port behavior:**

Node's `Buffer.from(s, "base64")` is lenient (silently drops invalid characters) —
`filepayload.ts` adds `strictBase64Decode` (alphabet + length + padding-position checks) BEFORE
handing off to `Buffer.from`, so a malformed `content_b64` fails the same way Python's
`validate=True` does, rather than "succeeding" with the wrong bytes

- **Why:**

without this, `f68ae29`'s "fail loudly on bad file bytes" guarantee would be silently defeated
by Node's lenient decoder — a malformed upload would decode to truncated-but-non-empty bytes and
get delivered instead of triggering the failure notice

- **Scenario:**

test/telegram-filepayload.test.ts "invalid b64 is not a file", "invalid content_b64 is a decode
error"; parity/telegram/run-parity.mjs's "undecodable-content-b64-falls-back-to-notice" scenario

### outbound.run's hasattr(bot, "send_photo")/hasattr(bot, "send_document") capability checks

- **Source behavior:** Python duck-types via `hasattr` on the `Bot` instance

- **Port behavior:**

TS checks `typeof bot.sendPhoto === "function"` / `typeof bot.sendDocument === "function"` —
`OutboundBotLike.sendPhoto`/`.sendDocument` are optional interface members precisely so a
minimal test double can omit either, mirroring the Python tests' `FakeBot` classes that
sometimes leave one method out

- **Why:**

same duck-typed "does this object support the optional capability" check, expressed in TS's
structural-typing idiom instead of Python's `hasattr`

- **Scenario:**

outbound.ts source; test/telegram-outbound.test.ts's photo/document scenarios (each FakeBot
implements only what its scenario needs)

### cli.py's token-redacting log formatter (1c: 44fe2f4)

- **Source behavior:**

httpx logs every Bot API request URL (which embeds the token) at INFO; `RedactingFormatter` is
installed on the root logger (covers every module's log calls, including exception text) and
httpx/httpcore are raised to WARNING unless `--verbose`

- **Port behavior:**

`logging.ts`'s `redact()` is a plain string function (no logging-framework formatter/handler
concept in this port); `cli.ts`'s `runCli` threads a `redact`-wrapping sink through `io.stderr`,
`Inbound`'s `log` option, and `outbound.start`'s `log` option, so every line this bridge writes
to stderr is covered the same way the Python root logger is

- **Why:**

Node's `fetch` does not auto-log requests the way httpx does at INFO, and `api.ts`'s `Bot.call`
already omits the URL from every `ApiError`/`HttpError` message it builds (see that file's
comment) — there is no per-request chatter to silence in the first place, only the same
defense-in-depth belt Python wears against a token-shaped substring reaching stderr by some
other path

- **Scenario:**

test/telegram-logging.test.ts (`redact` cases); logging.ts / cli.ts source comments — no
scenario exercises this through `runCli` itself, since (like upstream's own `cli.py`) nothing in
the CLI boundary parameterizes the real `Bot`'s transport for a controlled getMe/getUpdates
failure carrying a token-shaped message


### Slack bridge deviations (this lane)


> Table converted to sections for GitHub rendering.

### config.load/mindlog.findTrajectory fatal errors

- **Source behavior:** `raise SystemExit("message")` — an uncaught string `SystemExit` prints the message to stderr and exits 1

- **Port behavior:**

`throw new BridgeExit(message)`, caught once at the CLI boundary (`cli.ts`'s `runCli`), printed
to stderr verbatim, `return 1`

- **Why:** same `BridgeExit` idiom as the telegram port (errors.ts, independent files, no shared runtime code)

- **Scenario:** test/slack-config.test.ts (dangling-default-link, no-var-no-default cases assert on the thrown message)

### Inbound's worker: queue.Queue drained by a background threading.Thread (self._worker), started in __init__

- **Source behavior:**

Node has no threads; `onEvent()` still returns synchronously without awaiting delivery (Bolt's
handler-must-return-fast contract), but delivery is chained onto a promise tail
(`enqueue`/`this.queueTail`) instead of a real concurrent thread

- **Port behavior:**

the observable behavior (the handler returns immediately; messages are delivered in the same
order they arrived, one at a time) is the same; `flush()` is a test/driver-only seam with no
Python equivalent — this port's async-native way to await "the drain thread has caught up" (the
differential harness's `py_driver.py` gets the same determinism from the real thread by calling
`ib.stop(); ib._worker.join()`, since `queue.Queue` there has no `task_done()`-free `.join()`
shortcut)

- **Why:**

inbound.ts source; test/slack-inbound.test.ts (every case awaits `ib.flush()`);
parity/slack/py_driver.py's `on_event` mode

- **Scenario:** 

### outbound.start's concurrency primitive

- **Source behavior:** a background `threading.Thread` running `outbound.run`, stopped via a shared `threading.Event`

- **Port behavior:**

`outbound.start` runs the async `outbound.run` loop un-awaited and returns a handle (`{stop(),
done}`) — same adaptation as `src/telegram/outbound.ts`

- **Why:**

Node has no threads; the observable behavior (a concurrently running follow-loop the caller can
signal to stop, and that the CLI waits for on the way out) is the same

- **Scenario:**

outbound.ts source; test/slack-outbound.test.ts drives `run()` directly (the Python test does
the same, calling `outbound.run(cfg, client, threads, stop_event)` rather than `start()`)

### api.py / Socket Mode transport

- **Source behavior:**

does not exist as `headlong_slack` source — `App`/`WebClient`/`SocketModeHandler` are all
`slack_bolt`/`slack_sdk`, a real pip dependency (pyproject.toml)

- **Port behavior:**

`api.ts` (`WebClient` over `fetch`) and `socketmode.ts` (a Socket Mode client over the native
`WebSocket`) are from-scratch, dependency-free replacements with no 1:1 Python source to port —
written from the installed `slack_sdk` source (wire format: form vs. JSON body per method,
`base_url` override seam) and from Slack's public Socket Mode protocol description (envelope
ack, `disconnect` reconnect), respectively

- **Why:**

the port's "no runtime deps" rule rules out adding `@slack/bolt` or `@slack/web-api`;
`slack_sdk`'s own source (not slack_bolt's) is the authoritative wire-format reference, and it
was read directly rather than assumed — see parity/slack/run-parity.mjs's header for what that
reading found

- **Scenario:**

test/slack-api.test.ts, test/slack-socketmode.test.ts; parity/slack/run-parity.mjs (proves
api.ts's wire format against the real slack_sdk, request-by-request)

### Socket Mode reconnect/ping timing

- **Source behavior:**

`slack_bolt.adapter.socket_mode.SocketModeHandler`'s internal reconnect backoff and any
ping/keepalive behavior are library internals, not published as a stable contract, and
`headlong_slack` never overrides them

- **Port behavior:**

`socketmode.ts` reconnects immediately (no backoff) on a server-initiated `disconnect` envelope
and has no client-initiated ping

- **Why:**

unverifiable without a real Slack app-level token (none available in this environment);
implemented from the public Socket Mode protocol description only, not from `slack_bolt`'s
source or live traffic — flagged as the least-verified part of this port in its own file-header
PORT-NOTE

- **Scenario:**

test/slack-socketmode.test.ts (the `disconnect` case proves the reconnect-happens behavior
against a fake WebSocket; the backoff/ping gap itself is untested, by necessity)

### outbound's per-chunk-failure fallback

- **Source behavior:**

Python's `_deliver` (inbound) has a 3-attempt retry+Slack-error-fallback; `outbound.run`'s
`chat_postMessage` failure has NO retry or fallback — one failed chunk just `break`s the loop
for that reply, logged via `log.exception`

- **Port behavior:**

ported exactly as asymmetric: `inbound.ts`'s `deliver` retries 3x with backoff then posts
`DELIVERY_ERROR_TEXT`; `outbound.ts`'s per-chunk `catch` just logs and `break`s, no retry, no
fallback message (there is nowhere to send one — the far end IS the failure)

- **Why:**

faithful port of a real upstream asymmetry, not a bug in either direction — noted here so it
isn't mistaken for an inconsistency introduced by the port

- **Scenario:**

test/slack-outbound.test.ts "a chatPostMessage failure breaks the chunk loop without throwing";
parity/slack scenario "chat-post-message-failure-breaks-chunk-loop"


### `identity export` / export web routes deviations (routes-d lane)


> Table converted to sections for GitHub rendering.

### _export_append_identity's thinkers cp -RL on a dangling symlink

- **Source behavior:**

`cp -RL "$dir/thinkers" ...` runs ONCE for the whole subtree; a single dangling symlink inside
it can make the ENTIRE `cp` fail, silently swallowed via `|| debug "some thinker symlinks did
not resolve; dropped"` (only visible with `-v`) — worst case, the WHOLE thinkers/ subtree is
missing from the archive, not just the one bad entry

- **Port behavior:**

walks the subtree itself; a dangling symlink is dropped ENTRY-BY-ENTRY (that one file/dir is
skipped, everything else still travels)

- **Why:**

more lenient and more useful — a single stale symlink (e.g. a `--symlinks` install pointing at a
moved checkout) no longer takes the whole thinkers/ folder down with it; not reachable by any
real fixture in this lane's harness (bash `identity new` in this environment doesn't use
`--symlinks`), so this is a reasoned deviation, not an observed divergence

- **Scenario:** test/identity-export.test.ts "dangling thinkers/ symlink is dropped, not fatal"

### _export_slim_trajectories on a trajectories/ dir with ZERO surviving files (no .jsonl/other regular file anywhere under it)

- **Source behavior:**

`mkdir -p` is only ever called per-file found by `find -type f`; zero files means the staging
`.../trajectories` dir is NEVER created, then the following `tar -rf ... "$base/trajectories"`
tries to archive a path that doesn't exist — under this script's `set -euo pipefail`, THE WHOLE
EXPORT ABORTS

- **Port behavior:**

`slimTrajectoryEntries` returns no entries for that identity (skips the trajectories/ subtree in
the archive) rather than throwing

- **Why:**

an accidental Bash crash artifact (an unguarded `mkdir -p`/`tar` on a
directory-that-might-not-exist), not designed behavior — same class as the `traj tail
-r`/`skills` `set -e` crash-smoothing rows above. Not reachable in practice: every identity
created by `identity new` (Bash or this port) always has a live root trajectory file, so
`--slim` never actually sees zero files

- **Scenario:**

src/identity.ts `slimTrajectoryEntries` doc comment; not exercised by the differential harness
(would need a hand-corrupted identity with an emptied trajectories/ dir)

### export-jobs' on-disk tmp file (_export_to_tempfile, FileResponse(job["path"], ...), unlink on delete/eviction)

- **Source behavior:**

each export job writes its archive to a REAL tmp file on the OS filesystem, cleaned up on
delete/eviction/download-complete (direct routes) or left for the next job/an operator (job
routes, until deleted)

- **Port behavior:**

`web/server/src/exportJobs.ts` holds the built archive as an in-memory `Buffer` on the job
object — no tmp file is ever created; "cleanup" is just dropping the reference (`job.buffer =
undefined`) for GC

- **Why:**

this port's exporter already builds the whole archive as a `Buffer` in one synchronous call (no
`tar`/`gzip` subprocess to stream from) — writing that buffer to a tmp file just to immediately
read it back for `FileResponse` would add a class of bugs (leaked tmp files on a crash,
disk-full edge cases) for no behavioral benefit; the HTTP-visible contract (status, headers,
bytes, job lifecycle, 409-while-running) is identical

- **Scenario:** web/server/test/export.test.ts (full job lifecycle: create → poll → download → delete)


### web push deviations (routes-d lane)


> Table converted to sections for GitHub rendering.

### PushWatcher's concurrency primitive

- **Source behavior:** a `threading.Thread` (daemon) looping `time.sleep(poll_s)` forever, started once by `cli.py`'s production entrypoint

- **Port behavior:**

`startPushWatcher` uses `setInterval` (unref'd, so it never keeps the process alive on its own),
exposing `stop()`/`tick()` (the latter test-only — runs one iteration synchronously-awaited,
bypassing the timer)

- **Why:**

Node has no threads; same adaptation this port already made for the Telegram/Slack bridges'
`outbound.start` (see those Deviations rows) — the observable behavior (a standing loop that
tails files and can be stopped) is the same

- **Scenario:**

web/server/test/push.test.ts's PushWatcher describe block (every case drives `tick()` directly
rather than waiting on real timers)

### vapid_public_key's threading.Lock() around generate-on-first-use

- **Source behavior:** guards against two concurrent Python THREADS racing to generate/write the key file

- **Port behavior:**

no lock — every fs call in `push.ts`'s `vapidPublicKey` is synchronous, so the
check-then-generate-then-write sequence cannot be interleaved by other JS running on the same
thread (Node's single-threaded event loop)

- **Why:**

not a behavioral difference, just a different (and here, sufficient) mechanism for the same
guarantee — two concurrent HTTP requests to `GET /api/push/key` on a fresh root still only ever
generate one key, the same as upstream

- **Scenario:** test/push.test.ts "a second call reuses the same key"

### VAPID JWT exp/aud claim computation

- **Source behavior:**

`webpush()` (pywebpush) computes `aud` from the subscription endpoint and sets `exp` to `now +
12h` ONLY if the caller-supplied `vapid_claims` dict doesn't already have a still-valid one —
`push.py` never supplies `aud`/`exp` itself, so this path always runs

- **Port behavior:**

`sendWebPush` always computes `aud`/`exp` itself the same way (push.ts never accepts
caller-supplied `aud`/`exp`, since nothing in this port's call chain ever needs to override
them)

- **Why:**

this port only needs the one call shape `push.py`'s `_send` actually uses (matching the task's
"port faithfully what's used" scope) — the more general pywebpush `webpush()` signature (an
already-valid caller-supplied `exp`, a pre-built `Vapid` instance, `curl=True`, `aiohttp`, etc.)
is not ported, since nothing in this port's call chain needs it

- **Scenario:** web/server/test/push.test.ts "VAPID aud matches the endpoint's own scheme+host"


