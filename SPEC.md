# Headlong — Implementation Spec for a Faithful TypeScript Port

Status: trace-grounded. Every claim cites **source** (`path:line` in the Bash
checkout at `<HEADLONG_ROOT>`) and, where a
running agent demonstrates it, a **golden trace** step in
`<HEADLONG_TS_ROOT>/golden/`. Where source
and trace disagree, **the trace wins** and the discrepancy is noted. Mechanisms
claimed by source but not visible in any captured trace are marked
**[UNVERIFIED]** and enumerated in `TRACE-INVENTORY.md`.

Golden traces (all from one real `pax` run on OpenRouter `deepseek/deepseek-v4-flash-0731`):
- `trace-00-boot-and-convo.jsonl` — 112 steps: boot/seed, first three wakes, one chat exchange. Row numbers below refer to this file unless another trace is named.
- `trace-01-live-snapshot-convo-and-timer-wakes.jsonl` — 238 steps: adds repeated `spontaneous/timer` wakes and a multi-turn conversation.
- `trace-02-no-reply-and-reactive.jsonl` — 279 steps: adds a forced **NO_REPLY** and its reactive monolith wake (captured by driving the live agent with a bare acknowledgment).
- `trace-03-dispatcher-log-excerpt.txt` — dispatcher-internal events (scheduled wake, pending FIFO, coalescing, self-trigger skip) that never appear in the trajectory JSONL.

---

## 0. The one-paragraph mental model

A Headlong identity (`pax`) is **one append-only JSONL log** (the "trajectory" /
"mind"). A long-lived **dispatcher** (`bin/thinkers`) `tail -F`s that file; every
appended step is an event. Two **thinkers** subscribe to step types and are
fired by the dispatcher when a matching step appears: the **monolith** (the whole
deliberating mind) and the **responder** (chat replies only). The monolith's
every wake is a full **shellm** agentic run — an LLM that **acts by writing one
bash block per turn**, which the harness executes; its stdout re-enters as the
next turn. Bash-codegen IS the action layer: skills (`mem`, `traj`, `chat`,
`skills`, `context`, …) are just executables on `PATH`. The wake prompt is
**standing context folded once per run as a `prompt` step**, never a chat
message. Chat messages, thoughts, tool output, and scheduled wakes are all peer
steps in the single stream; "reflection" is private `reasoning`/`observation`
steps a human never sees — only `message` steps reach a person.

This corrects the prior belief set on all five counts (bash-codegen is the
mechanism; prompt is standing context; two thinkers; one stream; skills are real
executables). See `HEADLONG-observed.md` — confirmed here against source+traces.

---

## 1. The shellm inner loop  (`bin/shellm`)

One "wake" of the monolith = one `shellm` invocation = one agentic loop over the
trajectory. shellm is the substrate; the thinkers are launchers on top of it.

### 1.1 Invocation (as the monolith launches it)

Exact command recorded in `trace-00` row 12 (`shellm-run.command`), assembled by
`thinkers/monolith/step:312-318` + `_build_shellm_flags` (`thinkers/_lib/common.sh:320-374`):

```
shellm --model deepseek/deepseek-v4-flash-0731 --traj <ROOT_TRAJ_ID> --env pax \
  --workdir <identity>/workdir \
  --var IDENTITY_NAME=pax --var MEM_DIR=… --var SKILLS_DIR=… --var SKILLS_KERNEL_DIR=… \
  --var TRAJ_DIR=… --var TRAJ_ID=<ROOT_TRAJ_ID> --var SHELLM_MODEL=… --var OPENROUTER_API_KEY \
  --bin mem --bin traj --bin skills --bin context --bin llm --bin shellm \
  --bin chat --bin glob --bin view --bin put --bin sub \
  --prompt-file <identity>/run/monolith_prompt.XXXXXX
```

Key facts for the port:
- `--traj <ROOT_TRAJ_ID>` makes the run **resume/append to the shared root
  trajectory** (not a fresh child). `shellm-run.resumed=true` (row 12). All steps
  the run writes carry `run_id` = this run's header `step_id` (see §2.4).
- The task prompt is passed as a **file** (`--prompt-file`), not argv — Linux
  caps one argv string at 128 KB and a mature wake prompt exceeds it
  (`thinkers/monolith/step:304-310`; `bin/shellm:157-161`).
- `--bin PATH` prepends each tool's dir to the executed code's `PATH`
  (`bin/shellm:1330-1346,2431`). This is how the model reaches `mem/traj/chat/…`.
- `--var NAME=val` or bare `--var NAME` (value read from env, kept out of `ps` and
  the recorded command) are exported into the executed code's env
  (`bin/shellm:2433-2436`; `_build_shellm_flags` sends API keys by bare name).
- `--env pax` selects an execution environment (here a Docker sandbox spec, see
  `shellm-run.env` row 12: `{type:docker, docker_image:ubuntu:latest, docker_access:none,…}`). The port MUST reproduce the env metadata field but MAY run code locally; the Docker machinery (`bin/shellm:445-1138`) is orthogonal to the cognition model.

### 1.2 The two prompt layers

shellm sends the model **two** layers each turn (`call_llm`, `bin/shellm:1359-1366`):

1. **System prompt** — the shellm contract. Default text at `bin/shellm:1551-1648`
   (overridable by `SHELLM_SYSTEM_PROMPT` / `-s` / `--system-prompt-file`). The
   monolith does NOT override it, so the model gets the literal default. The
   load-bearing clause (`bin/shellm:1554`):

   > "IMPORTANT: End your response with exactly ONE ```bash code block. … Only the
   > first code block is executed; all others are silently discarded."

   Plus: the opening fence must be on its own line (`:1556-1564`); reasoning may
   precede the block (`:1566-1573`); completion is signalled with `FINAL=` /
   `FINAL_FILE=` (`:1642-1646`). Full text must be ported **verbatim** (see §1.7).

2. **Task/user prompt** — the wake context, from `--prompt-file`. This is what the
   monolith builds (§4.2) and what is recorded as the `prompt` step
   (`bin/shellm:2186-2194`). In `trace-00` the `prompt` step (row 13,
   `24e0192a`) begins `"<context>\nYou are an unconscious thought process of an AI
   person named pax…"`. **This is standing context recorded once per run, not a
   chat turn** — verifying the observed-notes correction.

The model's turn-to-turn conversation is rebuilt from the trajectory each
iteration by `context` (§1.4), NOT accumulated in memory.

### 1.3 The main loop  (`bin/shellm:2249-2740`)

```
iteration = 0
while (no max-iterations OR iteration < max):
    iteration++
    messages = context --traj_dir <dir> <traj> \
        --assistant-types reasoning,final \
        --user-types prompt,shell-output,feedback \
        --exclude-types shellm-run,run-summary          # bin/shellm:2265-2268
    response = call_llm(system_prompt, messages)         # :2285  (with empty-retry, :2301)
    reasoning = extract_reasoning(response)              # prose before the fence
    code      = extract_code(response)                   # FIRST fenced block only
    if code == "":
        append {type:final, thought:reasoning, content:response, run_id, llm_s, <usage>}
        return 0                                          # NO-BLOCK STOP  (:2353-2363)
    wrapped = "set -x\n<code>\nset +x\n__rc=$?\n[FINAL/FINAL_FILE capture]\nexit $__rc"  # :2382-2390
    output = execute_code(workdir, wrapped, env…)        # bash -e -c, stdin=/dev/null  (:1304-1352)
    append {type:reasoning, thought:reasoning, cmd:code, run_id, llm_s, in_tok,out_tok,think_tok}  # :2591-2600
    append {type:shell-output, stdout:clean_output, stderr:"", exit, run_id, exec_s}               # :2602-2637
    if final_file exists:
        append {type:final, content:<answer>, run_id}    # FINAL STOP  (:2643-2673)
        return 0
    # spin/stall guard (:2676-2719): see §1.6
append {type:error, reason:stall/…}  or  return 1        # MAX-ITERATIONS STOP (:2722-2739)
```

Trace grounding (`trace-00`, run `da90667f`): `prompt`(13) → `reasoning`(14,
`7b5dc747`) → `shell-output`(15) → model writes an `observation` via bash (16) →
… → `reasoning`(55) sets `FINAL=` → `shell-output`(56, empty) → `final`(57,
`fa00bb7a`). The per-turn shape `prompt→reasoning→shell-output→…→final` is exactly
the loop above.

### 1.4 Context re-entry (`context`, `bin/context`)

Each iteration, the model's chat history is **regenerated from the trajectory**,
not held in memory (`bin/shellm:2265`). `context` maps step types to roles
(`bin/context:43-46,236,329`): `reasoning`+`final` → assistant; `prompt`,
`shell-output`, `feedback` → user; `shellm-run`,`run-summary` excluded;
unrecognized → user. Consecutive same-role messages are merged (API alternation,
`bin/context:306-309`), gaps rendered as `"[N steps elided]"`, `--tail` default
50, `--pin <id>` forces inclusion. **Consequence for the port:** within one wake
the model sees its own `reasoning` (with the bash) as assistant turns and
`shell-output` as user turns; the `observation`/`thought`/`idle` steps it writes
are **excluded from its own live context** — they are for the *persistent* log and
future wakes (via §4.2 / §6), not this turn's conversation.

### 1.5 The one-bash-block contract (extraction)

- `extract_reasoning` (`bin/shellm:279-298`): everything before the first
  ```` ```bash/```sh/``` ```` fence is the reasoning `thought`.
- `extract_code` (`bin/shellm:1417-1535`): extracts the **first** fenced block
  only; heredoc-aware so nested fences inside heredocs don't close the outer
  block. If additional fenced blocks follow, awk emits a `TRUNCATED` signal
  (`:1468`) and shellm **prepends** to the executed code
  (`:1532-1533`):

  ```
  echo "[rest of model response truncated after first code block]" >&2
  ```

  **Trace-visible** (`trace-00` rows 20-21, 28-29, 33-34, 43-44, 49-50, 65-66,
  109-110): the DeepSeek model repeatedly emitted multiple blocks and this exact
  stderr line appears in the executed `cmd` and resulting `shell-output`. This is
  the concrete enforcement of "one bash block per turn."

### 1.6 Stop conditions (exhaustive)

| Stop | Trigger | Records | Return | Source | Trace |
|------|---------|---------|--------|--------|-------|
| **FINAL** | bash sets `FINAL=` or `FINAL_FILE=` | `final` step w/ `content` | 0 | `:2379-2390,2643-2673` | rows 57, 81, 111 (VERIFIED) |
| **NO-BLOCK** | model response has no fenced block | `final` step w/ `content`=full response, `thought`=reasoning | 0 | `:2353-2363` | [UNVERIFIED] — traces always terminate via `FINAL=` |
| **MAX-ITER** | `iteration >= SHELLM_MAX_ITERATIONS` | (parent `merge` "(max iterations reached)") | 1 | `:2722-2739` | [UNVERIFIED] — default unlimited, never hit |
| **STALL** | `MAX_REPEAT_FAILURES` same failing cmd, or `MAX_CONSECUTIVE_FAILURES` non-zero exits | `error` step `reason:"stall"` | 1 | `:2676-2719` | [UNVERIFIED] |
| **EMPTY-RETRY** | LLM returns empty (tokens spent in thinking) → feed thinking back, retry | — (loops) | — | `:2294-2334` | [UNVERIFIED] |

The monolith treats a non-zero shellm return as a failed wake (§4.4). A FINAL and
NO-BLOCK both produce a `final` step and are the run's last loop step
(`:2640-2642`).

### 1.7 Constants (defaults, all env-overridable) — `bin/shellm:63-89`

| Var | Default | Meaning |
|-----|---------|---------|
| `SHELLM_MAX_ITERATIONS` | *(empty = unlimited)* | loop cap |
| `SHELLM_MAX_CONSECUTIVE_FAILURES` | `10` | non-zero-exit iterations in a row → stall |
| `SHELLM_MAX_REPEAT_FAILURES` | `3` | identical failing cmd repeats → stall |
| `SHELLM_TRUNCATE` | `2000` | in-context output truncation width (`truncate_output`, `:237`) |
| `SHELLM_MAX_TOKENS` | *(empty)* | per-call output cap |
| `SHELLM_EFFORT` | `high` | reasoning effort → `llm --effort` (trace `shellm-run.effort=high`) |
| `SHELLM_INACTIVITY_TIMEOUT` | `30` | kill a step silent this long (unless sub-runs alive) |
| `SHELLM_INACTIVITY_MAX` | `900` | absolute no-output kill |
| `SHELLM_STDOUT_INLINE_LIMIT` | `4096` | (`bin/traj:15`) blob-spill threshold, see §2.3 |

The full default system-prompt text (`bin/shellm:1551-1648`, which itself embeds
`usage_text` at `:147-229`) must be copied verbatim into the port; it is the
contract the model is trained-in-context against. Port note: the default prompt
also documents sub-runs, tmux backgrounding, and the `view/sub/put/glob` file
tools — keep or trim per driver capability, but keep the one-block clause and the
`FINAL=`/`FINAL_FILE=` completion clause exactly.

---

## 2. The trajectory  (`bin/traj`)

### 2.1 Identity & files

- A trajectory's **ID is the UUID `step_id` of its first step** (`type:trajectory`),
  `bin/traj:8`. Root file lives at `<TRAJ_DIR>/<hex8>-root/trajectory.jsonl`
  (`trace-00` root = `55fd5932-root`, first step `55fd5932-3fc0-…` row 0).
  Sub-runs nest under `<hex8>-<slug>/trajectory.jsonl` with `parent_traj` /
  `parent_traj_ref` links (`bin/traj:352-388`).
- Format: **one compact JSON object per line** (JSONL), append-only
  (`bin/traj:536-560`). Blobs (large stdout/stderr) spill to a sibling `blobs/`
  dir.

### 2.2 Step schema (per type, from traces + `bin/traj`/`bin/shellm`)

Every step has `step_id` (lowercase UUID, `gen_step_id` `bin/traj:119-133`) and
`ts` (ISO-8601 **UTC** ms, `"%Y-%m-%dT%H:%M:%S.mmmZ"`, `_iso_ts` `:137-142`).
Additional fields by `type`:

| type | fields (beyond step_id, ts) | written by | trace example |
|------|------------------------------|------------|---------------|
| `trajectory` | *(none; may carry `parent_traj`,`parent_traj_ref`,`slug`)* | `traj new` / `identity` | row 0 `55fd5932` |
| `thought` | `content`, `source` | seed (`tools/identity:290-307`) or monolith bash | rows 1-11 `source:seed` "I'm here."; row 54 `source:monolith` |
| `shellm-run` | `command, workdir, model, effort, max_iterations, max_tokens, inactivity_timeout, context_files[], env{}, resumed` + optional `trigger_step, launched_by, wake` | shellm header (`bin/shellm:2144-2167`) | row 12 `da90667f` |
| `prompt` | `content, run_id` | shellm (`:2186-2194`) | row 13 |
| `reasoning` | `thought, cmd, run_id, llm_s, in_tok, out_tok, think_tok` | shellm (`:2591-2600`) | row 14 |
| `shell-output` | `stdout, stderr, exit, run_id, exec_s` (+ `stdout_ref, stdout_bytes, stdout_truncated` if spilled; + `timed_out, feedback` if killed) | shellm (`:2602-2637`) | row 15; row 70 spilled (`stdout_bytes:62390`) |
| `final` | `content, run_id` (NO-BLOCK also `thought`, `llm_s`, usage) | shellm (`:2643-2673`,`:2356-2360`) | rows 57, 81, 111 |
| `observation` | `content, source` + optional `decision, trigger_step, run_id` | monolith/responder bash | row 16 `source:monolith`; row 46 `source:responder decision:replied trigger_step:470f41d8` |
| `idle` | `content:"idle", source` (+ `synthetic:"watchdog"` if from watchdog; + `trigger_step, run_id`) | monolith (`thinkers/monolith/step:359-366`) / dispatcher | row 76 `source:monolith` |
| `message` | `content, from, to, source:"chat"` + optional `reply_to` | `chat` (`bin/chat:94,176-182`) | row 41 in; row 45 out `reply_to:470f41d8` |
| `reply_claim` | `content, source:"responder", trigger_step` | responder (`thinkers/responder/step:95-101`) | row 42 |
| `error` | `content, source, reason` (+ `rc, run_id, trigger_step`) | monolith (`step:346-356`); shellm stall: `{type,content,run_id,reason}` — NO `source`, content `shellm killed this run: the agent stalled — <reason> (last exit=N). <guidance>` (`bin/shellm:3447`) | (not in trace) |
| `feedback` | `content, source` (+ `trigger_step`) | shellm timeout (`:2632-2633`), dispatcher salience-injection (`bin/thinkers:863-868`; **removed at 2e39a3f**, see §3.6) | (not in trace) |
| `merge` | `content, from_traj` (+ `from_step, from_traj_ref`) | shellm sub-run return (`:2665-2671`) | (not in trace) |
| `monolith-wake` | `content:"wake", source:"monolith-timer"` | dispatcher scheduled wake (`bin/thinkers:678-679`) | (drives runs; excluded from narrative — see §3.6) |
| `manual-trigger` | `source:"thinkers-cli", ts` | `thinkers trigger` (`bin/thinkers:1173-1174`) | drives row-12 run |
| `run-summary` | async summary of a new child traj | `generate_run_summary` (`:2180`) | only for fresh (non-`--traj`) runs |

### 2.3 Blob spilling (`bin/traj:474-534`)

If `stdout`/`stderr` byte length > `STDOUT_INLINE_LIMIT` (4096, `:15`): write full
value to `blobs/<step_id>-<blobid>.stdout`, keep first 4096 bytes inline, add
`stdout_ref` (relative path), `stdout_bytes` (full length), `stdout_truncated:true`.
`blobid` is `%06x` of existing blob count (`next_blob_id`, `:144-152`). **Trace
VERIFIED**: `trace-00` row 70 `e1811315` `stdout_bytes:62390, stdout_truncated:true`.
Retrieve via `traj show <id> --full` / `--field stdout` / `traj search` (documented
to the model, `bin/shellm:1631-1636`).

### 2.4 Append protocol (`cmd_append`, `bin/traj:405-561`)

1. Build record from `--field k=v` flags or JSON on stdin (`:433-446`); `type`
   required (`:448-451`).
2. **Auto-stamp `run_id`** from env `SHELLM_RUN_STEP_ID` if not already present and
   type ∉ {`shellm-run`,`trajectory`} (`:459-462`). shellm exports
   `SHELLM_RUN_STEP_ID=<run header step_id>` into executed code
   (`bin/shellm:2424`), so **every step the model writes inside a wake inherits
   that wake's `run_id`** without the model knowing. This is why `observation`s in
   `trace-00` carry `run_id:da90667f` but the responder's `reply_claim`/reply/
   `observation` (written outside any root-traj shellm run) carry **no** `run_id`.
3. Assign `step_id` (preserve caller-supplied), stamp `ts` (`:464-472`).
4. Blob-spill stdout/stderr (§2.3).
5. Append one compact line under an **`mkdir`-based lock** (`<file>.lock`, atomic
   on macOS/Docker; steals locks older than 5 s), `:546-559`.
6. Print the assigned `step_id` (callers capture it), `:561`.

Other commands the model/thinkers use: `traj new`, `traj append`, `traj fork`
(child traj + `fork` step), `traj merge`, `traj show/last/list/search/cat/tail/
path/exists/root` (`bin/traj:38-116`). `run_id` grouping: a wake's steps are all
those whose `run_id` == the `shellm-run` header `step_id` (three groups in
`trace-00`: `da90667f`=41 steps, `fa8f529f`=23, `52bdff56`=29; the 19
run_id-less steps are boot/seed + responder/chat cross-cutting steps).

---

## 3. Dispatcher + wake scheduling  (`bin/thinkers`)

### 3.1 What the dispatcher is

`thinkers start <names…>` launches a **long-lived background dispatcher**
(`_start_dispatcher`, `bin/thinkers:217-905`; PID in `run/dispatcher.pid`, a
per-start ownership token in `run/dispatcher.token`). It:

1. Builds a **subscription map** from each `thinkers/<name>/subscriptions.jsonl`
   (`:255-314`): rows `name \t traj_file \t types(|-joined) \t trigger_self \t
   watchdog_secs`.
2. Spawns a **feeder** per unique traj file: `tail -n 0 -F <file>` tags each new
   line with the traj path and writes it to a FIFO (`_spawn_feeder`, `:368-379`).
   So **the trajectory file growing is the event bus.**
3. Runs a **main loop** reading the FIFO with a 1 s timeout (`:719-898`); on each
   line it matches subscriptions and dispatches; on the 1 s tick it runs
   housekeeping (`_tick`, `:683-701`).

### 3.2 Subscriptions (shipped)

- **monolith** (`thinkers/monolith/subscriptions.jsonl`):
  `{"types":["observation","action","merge","monolith-wake"],"trigger_self":false}`
- **responder** (`thinkers/responder/subscriptions.jsonl`): `{"types":["message"]}`
  (`trigger_self` defaults false).
- **retrieval** (`thinkers/retrieval/`): shipped **disabled** (`thinkers/retrieval/disabled` marker). Passive memory recall; not part of the 2-thinker core. [Port: optional.]

A step of type T with `source` S fires thinker N iff: T ∈ N's types, the step's
traj matches, N is active, **and** (S ≠ N **or** N's `trigger_self` is true)
(`:774-814`). Own `error`/`log_error` never self-fire even with `trigger_self`
(`:803-808`).

### 3.3 The reactivity / spontaneity split (the core scheduling idea)

The monolith uses **`trigger_self:false`**, so its own `thought/observation/idle`
steps never re-fire it (dispatcher logs `skip monolith (self-trigger)` —
**VERIFIED** `trace-03`). Two things drive it instead:

- **Reactive** — an *external* step it subscribes to. In practice the responder's
  `observation` (source `responder`, type `observation`) fires the monolith.
  **VERIFIED**: `trace-00` row 58 `shellm-run.wake="reactive/observation:responder"`
  triggered by the responder's replied-observation row 46; `trace-02` shows the
  same after the NO-REPLY observation.
- **Spontaneous** — a **scheduled self-wake**. The monolith writes a target epoch
  to `run/monolith.wake_at`; the always-alive dispatcher tick fires a
  `monolith-wake` step (source `monolith-timer`) when due (`_scheduled_wake_check`,
  `:661-681`). **VERIFIED**: `trace-00` row 82 + `trace-01` rows at 16:07–16:11 all
  `wake="spontaneous/timer"`; `trace-03` logs `scheduled wake -> monolith (due Ns ago)`.

> **Source-vs-reality note:** `design/monolith_backoff.md` documents an older
> `setsid` per-step timer process AND (in its revision header) the shipped
> `wake_at` design. The **shipped** implementation is `wake_at` + dispatcher tick
> (`thinkers/monolith/step:105-119`, `bin/thinkers:661-681`); the trace confirms
> `wake_at`. Ignore the `arm_wake`/`setsid` "Timer contract" section of that doc.

### 3.4 The backoff algorithm (real constants)  (`thinkers/monolith/step:42-119, 371-408`)

Config (env-overridable):

| Var | Default | Meaning |
|-----|---------|---------|
| `MONOLITH_BACKOFF_BASE` | `5` | first non-zero delay (level 1), seconds |
| `MONOLITH_BACKOFF_FACTOR` | `2` | multiplier per level |
| `MONOLITH_BACKOFF_CAP` | `300` | slowest steady rate (s) |
| `MONOLITH_BACKOFF_HOLD` | `3` | empty wakes to dwell at a level before descending |
| `MONOLITH_THOUGHT_CAP` | `60` | ceiling for thought-only wakes (gentler than CAP) |
| `MONOLITH_SHARE_HINT_EVERY` | `12` | inject a `share` routing hint every N spontaneous wakes (0=off) |

Delay function (`_delay_for_level`, `:68-78`):
`delay(0)=0`; `delay(n≥1)=min(BASE·FACTOR^(n-1), CAP)` → `5,10,20,40,80,160,300(cap)`.

Per-wake decision (`:371-408`), after running the wake and probing what durable
work it produced (`did_visible` = a new `action/observation/merge/message` step;
`did_thought` = a new `thought`; `did_work` = either):

- **reactive wake, OR did_visible** → engaged: `level=0, ticks=0, next_delay=0`
  (wake again immediately). *(VERIFIED: `trace-*` reactive wakes and busy wakes
  keep `level=0`; live `monolith_backoff_state.json` observed `{"level":0,…}`.)*
- **spontaneous wake that errored (rc≠0), no durable step** → descend one level
  immediately (no HOLD), `ticks=0`, `next_delay=delay(level)` (`:379-388`).
- **empty spontaneous wake** (`idle`/nothing) → `ticks++`; if `ticks≥HOLD` then
  `level++` (unless already at CAP) and `ticks=0`; `next_delay=delay(level)`
  (`:389-399`). If the wake was **thought-only**, clamp `next_delay` to
  `THOUGHT_CAP` (`:400-406`).

State persisted to `run/monolith_backoff_state.json`
(`{level, ticks_at_level, wakes_since_share_hint}`, `:93-103`). Arming is an
**EXIT trap** (`:137-138`) so the loop stays alive even on crash — arming the
next wake, not appending a step, is the liveness mechanism under `trigger_self:false`.

- **[UNVERIFIED] full exponential descent to the cap.** In all captured traces
  the agent kept producing work or receiving messages, so `level` stayed 0 and
  observed inter-wake gaps (~30–80 s) are dominated by run duration, not
  `next_delay`. The *ladder is source-exact*; the *descent to 300 s cap* needs a
  long idle run (see TRACE-INVENTORY).

### 3.5 Wake-reason string (stamped on `shellm-run.wake`)  (`thinkers/monolith/step:299-303`)

```
trigger_type == monolith-wake  → "<wake_mode>/timer"        e.g. spontaneous/timer
trigger_type == ""             → "<wake_mode>/start"
else                           → "<wake_mode>/<trigger_type>:<trigger_source>"
```
where `wake_mode` ∈ {`reactive` (observation/action/merge from another source),
`spontaneous` (monolith-wake / manual / unknown)} (`:142-162`). **All three
trace-00 wakes match exactly**: `spontaneous/manual-trigger:thinkers-cli` (row
12), `reactive/observation:responder` (58), `spontaneous/timer` (82).

### 3.6 Dispatch mechanics (per FIFO line)  (`bin/thinkers:760-897`)

1. `_fire_pending` first (deliver steps queued while a thinker was busy).
2. Parse `type`,`source`; for each subscription row that matches traj+type+active
   and passes the self-trigger check:
   - **If the thinker is busy** (`_thinker_busy`, a live step PID, `:536-546`):
     `message`/`action` steps → **FIFO queue** `run/pending/<name>.<type>.<epoch>.<seq>`
     (capped at 16, drop-oldest, `:824-841`); everything else → **coalesced**
     last-wins `run/pending/<name>.<type>.coalesced` (`:872-878`). **VERIFIED**
     `trace-03`: `pending -> responder (type=message, queued=1)` and
     `pending -> monolith (type=observation, coalesced)`.
   - **Salience injection**: an inbound `message` (to us, not from us) that queues
     behind a busy run ALSO appends a `feedback` step into the running traj so the
     model can answer inline (`:851-869`, deduped via `run/fb_injected`). [UNVERIFIED in trace]
     > **Changed at 2e39a3f (c13438e): salience injection is removed.** The
     > dispatcher no longer appends `feedback` steps for a queued inbound message;
     > the message waits in `pending` like any other. The port follows
     > (`src/dispatcher.ts`; PARITY.md "Upstream sync 2e39a3f", lane f). The same
     > release adds receipts for scheduled wakes (`wake_at` → `claimed` → `sent`,
     > stale claims swept), a 16-byte hex ownership token (an explicit stop cancels
     > wake_at/claimed/sent and yields to a racing start), a rewind guard and
     > feeder-swap detection (restart at EOF, no replay), and stuck/quiet-step guards
     > (TERM then KILL, with an `error` step).
   - **Else** dispatch: wait for a global slot, then run
     `SHELLM_LAUNCHED_BY=<name> <thinker>/step` in background, tracking its PID
     (`_dispatch_step`, `:549-564`).
3. Housekeeping tick (`_tick`, `:683-701`): ownership check → `_fire_pending` →
   `_watchdog_check` → `_scheduled_wake_check` → `_respawn_dead_feeders`.

Concurrency: `THINKERS_MAX_CONCURRENT` default **20** (`:22`; NOTE the CLI help
text at `:1776` says 4 — the code default is 20, a doc bug). Global cap enforced
before each dispatch (`:884-892`).

### 3.7 Watchdog  (`bin/thinkers:566-602`)

A synthetic `idle` (`synthetic:"watchdog"`) is fired for a **watched** thinker
free of running steps, pending work, and dispatches for its window. Window =
explicit `watchdog_secs`, else `THINKERS_WATCHDOG_SECS` (300) **only for
`trigger_self:true`** subscriptions, else 0/off (`:279-292`). **In the shipped
2-thinker config both monolith and responder have watchdog 0 (off)** — the
monolith's liveness is the `wake_at` re-arm, not the watchdog. [UNVERIFIED /
largely dormant in shipped config.]

### 3.8 Manual trigger & boot

`thinkers trigger <names…>` (aka the CLI kick used by `persona start`) writes a
`manual-trigger` pending file per thinker (`:1171-1181`); the dispatcher fires it
next tick. **VERIFIED** `trace-03`: at boot, `fire pending -> monolith
(type=manual-trigger)` and `-> responder (type=manual-trigger)` — both thinkers
kicked once at start; the monolith's kick produced `trace-00` run `da90667f`.

---

## 4. The thinkers — two separate loops

### 4.1 Monolith = the whole mind  (`thinkers/monolith/step`, `thinkers/monolith/prompt.md`)

One wake = one shellm agentic run over a **function menu**; the model picks **ONE**
function and carries it out (`prompt.md:5-9`). Functions (`prompt.md:11-18`):

`act` (do concrete work, then append `observation`), `share` (initiate outward
contact via `chat send`, then `observation`), `think` (one forward `thought`),
`learn` (`mem add` a lesson + `thought`), `recall` (`mem search`, surface as
`thought`s), `goals`, `values`, `idle` (append one `idle`, stop). Replying to chat
is **explicitly NOT the monolith's job** (`prompt.md:20`) — that is the responder.

**"Honest idle"** — choosing `idle` when nothing is worth doing is first-class
(`prompt.md:18`); the step falls back to an `idle`/`error` marker if a wake
produced no durable step (`thinkers/monolith/step:344-368`). **VERIFIED**:
`trace-00` row 76 `idle source:monolith` (the RLM-mystery wake concluded nothing
more to do). Source MUST be the literal `"monolith"` (`prompt.md:24`) — it names
the writing process and drives dispatcher routing.

**Model:** `THINK_MODEL` = `SHELLM_MODEL` fallback (`step:36`), passed via
`--model` so env layers can't shadow it (`:316`).

### 4.2 The monolith wake prompt (`--prompt-file` content)  (`thinkers/monolith/step:173-246`)

```
route_prompt = "<context>
<system_prompt>                       # _build_system_prompt: persona + skills (§5)

<life_section?>                       # tiered "life so far" (§6), empty for young agents
Recent stream (last <TAIL> steps):
<recent_context>                      # _recent_stream: last 20 narrative steps, per common.sh:244-257

Routing signals:
<hints>                               # cheap deterministic nudges (:180-207)

<think_prompt>                        # prompt.md rendered with {{identity_name}},{{goals}}
</context>

Choose ONE function for this wakeup and carry it out now."
```

`_build_system_prompt` (`common.sh:71-81`) = `"You are an unconscious thought
process of an AI person named <name>.\n\nAbout <name>:\n<identity prompt>\n\n<skills
prompt>"`. **This whole block is the `prompt` step** in the trace (row 13 begins
verbatim with it). `THINK_CONTEXT_TAIL` is read from the env (default 20 in the step, `step:37`; `identity shell` exports 30, `tools/identity:414`, and the port's identity env does the same). Note the RLM example line
in `prompt.md:28` is exactly the phantom `trace-00` run `fa8f529f` chased and
resolved (rows 62–81) — strong two-way grounding.

### 4.3 Responder = chat replies only  (`thinkers/responder/step`)

Fires on `message` (source `chat`). **Not** a shellm loop — a single `llm` call +
`chat reply`, for lowest latency (`step:4-11, 150`). Flow:

1. Guard: reply only if `to == IDENTITY_NAME` (`:38`); drop self-messages
   (`from == IDENTITY_NAME`) with an observation (`:52-56`).
2. **Idempotency** (`_responder_already_handled`, `common.sh:185-237`), three
   layers keyed on the trigger step: (a) a stamped reply from us
   (`reply_to==trigger`); (b) our own **decision observation** (`replied` or
   `no-reply`) — makes a deliberate NO_REPLY stick across redelivery; (c) a
   **fresh `reply_claim`** (< `RESPONDER_CLAIM_TTL`=180 s, `:71`) — a stale claim
   deliberately does NOT block (crashed sends must retry).
3. Append `reply_claim` (audit trail, source `responder`, `trigger_step`)
   (`:95-101`). **VERIFIED** `trace-00` row 42 `be1df273`.
4. Compose reply with `llm -m REPLY_MODEL -M <convo> -s <reply_system>`
   (`REPLY_MODEL`=`MONOLITH_REPLY_MODEL`|`THINK_MODEL`, `:23`). `convo` = last 12
   user/assistant message turns (`:112-122`); `reply_system` includes persona +
   recent inner life + the **NO_REPLY contract** (`:128-147`).
5. **NO_REPLY**: if the model's first line is exactly `NO_REPLY`, append
   `observation … decision="no-reply"`, send nothing (`:156-161`). **VERIFIED
   (captured live)** `trace-02`: message "thanks, that's all I needed for now" →
   `reply_claim` → `observation … decision:no-reply` (`1c265ba4`, trigger
   `2de2163c`). This is the honest-silence contract working end-to-end.
6. Else `chat reply --reply-to <trigger> <from>`; on success append
   `observation … decision="replied"` (`:163-169`); on failure
   `decision="reply-failed"` (`:171-173`). **VERIFIED** `trace-00` rows 45–46: out
   `message reply_to:470f41d8`, then `observation decision:replied`.

Backstop: `chat reply` itself has an **answered guard** and `reply_to`
auto-inference so duplicate/concurrent replies are suppressed at transport
(`bin/chat:131-171`).

> **Changed at 2e39a3f (lane h; the flow above is the original capture).** The
> responder now: (0) drops a trigger older than `RESPONDER_MAX_TRIGGER_AGE`
> (default 900 s, 0 disables, a non-numeric value fails open) before doing
> anything; (4) bounds the reply call (`RESPONDER_MAX_TOKENS` 8192,
> `RESPONDER_MAX_TIME` 180 s, no retries) and, for models on the schema list,
> asks for a structured reply (`RESPONDER_STRUCTURED` auto|1|0,
> `reply.schema.json`, salvage of a damaged object, fallback to plain text unless
> the call timed out or was truncated); splits a glued or repeated `DEFER`;
> refuses a raw action object or tool-call markup as a reply; redacts card data
> and credentials in the excerpt, reply, deferral request and person notes; and
> records `llm_ms, llm_calls, out_tok, think_tok, served_by, truncated, timed_out,
> fallback, compose_ms, gap_s, parse` (+ `structured`, `deferred`/`request`) on the
> observation, with failure kinds timeout, truncated, parse, markup, empty, send.
> The reply model is `MONOLITH_REPLY_MODEL`, else `THINK_MODEL`. (Port: the reply
> is appended as the `message` step in-process rather than through `chat reply`;
> see PARITY.md.)

### 4.4 Why the two are separate (and why the port must keep them)

The monolith reasons over the conversation as context and does *follow-up work*
as `act`; the responder owns *immediate replies* and the *silence* decision. The
monolith reactively wakes on the responder's observation (§3.3) — so a chat turn
is: inbound `message` → responder replies (fast, no tools) → responder's
`observation` → monolith wakes to do any real work the message implies. Collapsing
these (as the prior port did) loses the fast-reply/deliberation split, the NO_REPLY
contract, and the single-stream topology.

---

## 5. The skills model  (`bin/skills`, `bin/mem`, `bin/traj`, `bin/context`, `bin/chat`)

Skills are **executables on `PATH`** and **playbook directories**, not a native
tool API. Two kinds:

- **Engine tools** — real binaries injected via `--bin`: `mem traj skills context
  llm shellm chat glob view put sub` (`common.sh:369`; trace-00 row 12). The model
  invokes them from its bash block. `recall/goals/learn` are **monolith router
  functions** (menu options in `prompt.md`) *implemented via* `mem`+`traj`, not
  separate binaries.
- **Skill directories** — `SKILL.md` (Agent-Skills open standard) under two roots
  (`common.sh:45-46`):
  - **kernel** (`<identity>/kernel/`) — always loaded **in full** into the system
    prompt. Shipped kernel = `chat`, `goals`, `mem` (symlinks; `.identities/pax/kernel`).
  - **regular** (`<identity>/skills/`) — listed as `name: description` summary;
    loaded on demand via `skills show <name>`. Shipped: `file-tools,
    googleworkspace, obsidian, shellm, skill-author, slack, telegram, web-research`.

`skills prompt` (`bin/skills:1184-1275`) assembles the "## My skills system" block
(CLI cheatsheet + full kernel bodies + regular-skill summaries) that
`_build_system_prompt` folds into the wake context. **VERIFIED**: the `prompt`
step in `trace-00` row 13 contains "## My skills system … I can install new skills
from GitHub or create my own …"; the monolith's first wake surveyed
`skills/`/`kernel/` (rows 17-40) and noted "next wakeup I could write my first
skill" (row 16). **The agent can author/install skills**: `skills init` (scaffold),
`skills install <name|owner/repo|url|path>`, `skills promote <name>` (→ kernel),
`skills remove` (`bin/skills:1420-1441`). [UNVERIFIED: an actual skill write in a trace.]

`mem` (memory) — one markdown file per memory with YAML frontmatter
`id, summary, type, created` + body (`bin/mem:134-145`); `type` ∈
{fact, goal, intention, note, preference, value, …}. `mem add [--type T] <text>`,
`mem search <q>` (LLM semantic search, `:171`), `mem list [--type T]`,
`mem show <id>`, `mem forget`. **VERIFIED**: `trace-00` sets a goal (`mem` id
`6a448a1a`, rows 51-53) and a note (`d26dbc80` `[note]`, rows 74-78);
`get_goals` (`common.sh:88-111`) scrapes `type:goal/intention` files into the
prompt `{{goals}}`.

`chat` — `chat send --from --to <msg>` (initiate; refuses self-send,
`bin/chat:89`) and `chat reply [--reply-to <id>] <to> <msg>` (reply, stamps
`reply_to`, answered-guard); both append `message`/source `chat` to the **root**
trajectory (`bin/chat:36-49,94,176-182`).

---

## 6. Memory / compaction — tiered rollups  (`design/tiered_memory.md`, `bin/recap`)

**Shipped** (design doc status "COMPLETE"; implemented in `bin/recap --context`
and `common.sh:_life_context:268-275`). On by default (`MONOLITH_TIERED_MEMORY=1`,
`thinkers/monolith/step:226`).

Design (the pyramid): rollups at geometric granularity with **fanout `F`=10**
(`ROLLUP_FANOUT`). Tier k has one first-person recap entry per `F^k` steps, rolled
up from tier k-1; each entry keeps a summary, themes, and **cited step-ids** for
drill-down. A context window is a **staircase** — coarse (whole life) → fine
(tier-1) → last `R` raw steps verbatim — bounded at ≈ `R + F·log_F N` lines,
always reaching step 0. Budget `MONOLITH_CONTEXT_BUDGET=auto` = a fraction
(`MONOLITH_CONTEXT_FRACTION`≈0.6) of the model's context window
(`design/tiered_memory.md:334-357`).

Build: **lazy, on context-assembly**, sealed blocks immutable & cached under
`<traj-dir>/rollups/tK/<start>-<end>.json`, keyed by absolute step-index; each
block stamped with `model`+`prompt_version` (`design:188-243`; `bin/recap:497-611`).
**Forward-only** from a per-trajectory `rollups/meta.json` `start_index` marker
(`bin/recap:609-611`); `recap --backfill` (one-time, offline) covers pre-enable
history. Cost backs off exponentially (≈ one small `llm` call per `F` steps).
`recap --context/--backfill/--fanout/--budget/--raw-tail/--rebuild` (`bin/recap:68-111`).

> **Changed at 2e39a3f (lane i).** `ROLLUP_PROMPT_VERSION` is **5** (there is no
> v4): the rollup prompt asks the writer to quote the `[id,...]` prefix of any
> earlier child window its summary corrects. Rollup calls get `-t 4096` (was 1024).
> A window the summary model **refuses** (`refused:` on `llm`'s stderr) is sealed
> as a placeholder block (`"refused": true`, summary "(Not summarized: the summary
> model refused this window.)") so the build moves past it; any other failure
> stops the build, and the caller still prints the blocks that exist.
> `ROLLUP_MAX_SEALS` (default 20, 0 = no cap, `--backfill` never capped) bounds the
> blocks one call may seal. Assembly adds a bounded **citation lookup**: at most
> 128 probes round-robin over tiers (newest first), 32 KiB read per candidate,
> optional text ≤ min(4·budget − base, 0.8·budget, 4096) bytes; a sealed block
> that quotes a displayed window's `[id,...]` prefix is printed under it as
> `[namer of the window above, cites it] …`, with a hint line (stdout, or stderr
> when nothing fits) when the lookup was partial. (`design/rollup_citation_lookup.md`.)

Relationship to `mem`: complementary — `mem` is curated/semantic (retrieve by
meaning); rollups are automatic/episodic (retrieve by recency/position)
(`design:285-297`).

- **[UNVERIFIED] rollups in practice.** `pax` is a young agent (< ~20 filtered
  steps at capture); `_life_context` returns empty and no `rollups/` tier appears
  in any trace (the `life_section` is absent from the `prompt` steps). The code
  path is wired (`step:220-232`) but the sealing of a tier-1 block and a staircase
  in a real prompt need a long run (≥ ~30 narrative steps) — see TRACE-INVENTORY.
  **Flag: design-doc "COMPLETE" is a claim about code, not about trace evidence.**

---

## 7. What the prior belief set got wrong (corrections)

The prior source-only spec (`PLAN-headlong-persistent-mode.md`) and the port it
produced got the **cognition substrate** wrong on five counts, each now confirmed
against source **and** trace: (1) it missed that **bash-codegen IS the action
layer** — every wake acts by the model writing one bash block the harness runs
(`bin/shellm` loop; `trace-00` reasoning→shell-output pairs), so a tool-less
driver has no action path at all; (2) it treated the **wake prompt as a chat
message re-broadcast every wake**, when it is **standing context** folded once as a
`prompt` step (`bin/shellm:2186`; `trace-00` row 13) — re-broadcasting is what
polluted the port's transcript; (3) it collapsed **two thinkers into one**, missing
the **responder** (fast reply + NO_REPLY silence) as a loop separate from the
**monolith** (deliberation, never replies) (`thinkers/{monolith,responder}/step`;
`trace-02` NO_REPLY, `trace-00` rows 42-46); (4) it modeled memory as a **detached
per-task thread with per-turn sessions**, when Headlong is **one append-only
stream** where messages/thoughts/output/wakes are peers and reflection is private
`reasoning`/`observation` steps (`bin/traj`; whole-trace topology); (5) it
**gestured at skills in the prompt** while only wiring `MEMORY.md`, when skills are
**real executables + authorable SKILL.md dirs** the agent invokes and extends
(`bin/skills`; `trace-00` skills survey). Net: the prior port reproduced the
**scheduler** (backoff/liveness) but not the **mind** (bash-as-action,
prompt-as-context, monolith/responder, single stream).

---

## 8. Verification tally

**VERIFIED (trace-grounded):** shellm loop shape (prompt→reasoning→shell-output→
final); one-bash-block contract incl. the truncation-notice; FINAL stop; trajectory
JSONL schema per step type; run_id grouping (= shellm-run step_id) & auto-stamp;
blob spilling; append protocol; three wake reasons (spontaneous/manual, reactive/
observation, spontaneous/timer); scheduled `wake_at` firing; pending message-FIFO &
observation-coalescing; self-trigger skip; reactive monolith wake on responder
observation; monolith function menu + honest idle; standing-context prompt step;
seed thoughts at boot; responder reply_claim + replied observation; **NO_REPLY**
(captured live); message single-stream in/out with reply_to; skills folded into
system prompt + agent skill survey; `mem` goals/notes.

**UNVERIFIED (source-exact, no trace yet):** NO-BLOCK / MAX-ITER / STALL / empty-
retry shellm stops; full exponential backoff descent to the 300 s cap; watchdog
synthetic idle (dormant in shipped config); salience feedback-injection; sub-runs
(child trajectories + merge); `share` (outbound initiate); tiered-memory rollup
sealing + staircase in a real prompt; an agent authoring a new skill. See
`TRACE-INVENTORY.md` for the specific runs that would close each.

---

## Appendix A — shellm default system prompt (verbatim contract core)

`build_system_prompt` (`bin/shellm:1543-1745`) emits, in order: **(A)** the static
contract head below (`bin/shellm:1552-1647`, heredoc); **(B)** `usage_text` — the
shellm CLI reference (`bin/shellm:147-229`); **(C)** a `## Guidelines` + tmux tail
(`bin/shellm:1651-1688`); then runtime-dynamic sections — `## Execution
environment`/`## Docker access` (only if Docker, `:1691-1710`), `## Current run`
(`:1712-1717`), `## Context available as environment variables` (if context,
`:1719-1725`), and `## Machine environment` (OS/arch/host/date/pkg-managers,
`:1727-1739+`). The monolith does not override this (no `-s`), so the model
receives it as the **system** layer, with the wake context (§4.2) as the **user**
layer. Port **(A)** verbatim (it is the in-context contract the model relies on);
**(B)/(C)** and the dynamic sections are ALL emitted (behavioral parity round, B4:
`src/shellmPrompt.ts`; the static text is regenerated from upstream's own
`shellm --print-system-prompt` at 2e39a3f, which supersedes the (A) listing below
where they differ): the `Output budget` line follows the context scope, `## Current run`
names the run's transient dir, and `## Machine environment` is probed per wake.
The monolith runs with `--context-scope run` (`thinkers/monolith/step:485`) so each wake's
first request is exactly `[system, user]`, and every model call goes through `llm`
(`src/llmCliClient.ts`): streaming, `max_tokens`, no `reasoning` field.
Each wake's run ends with a 1 s delay before the wake probes the trajectory and
arms `wake_at` (`thinkers/monolith/step:490` `sleep 1`; `postRunSleep`). The
identity, skills and think-prompt pieces are interpolated without trailing
newlines (bash `$(…)`, `common.sh:281-282`, `step:277`), and the model's reasoning
and final steps carry the whole usage record (`in_tok`, `out_tok`, `think_tok`,
`cache_tok`, `estimated`, `served_by`, `truncated`; `bin/shellm:3332`). Which
menu function a wake chose is not recorded (upstream does not either).

**(A) verbatim** (`bin/shellm:1552-1647`):

```
You are shellm, an AI assistant operating inside a bash shell environment. You solve tasks by generating and executing bash code.

IMPORTANT: End your response with exactly ONE ```bash code block. Your response is NOT streamed — code blocks are not executed until your entire response is complete. Combine multiple steps into a single script. Only the first code block is executed; all others are silently discarded.

CRITICAL — the opening ```bash fence MUST start on its OWN new line. Put a
newline after your prose, THEN the fence on a line by itself. Never append the
fence to the end of a sentence. If you attach the fence to prose, your prose
can be run as shell commands and fail.
  RIGHT:                          WRONG:
    Let me inspect the state.        Let me inspect the state.```bash
    ```bash                          ls -la
    ls -la                           ```
    ```

## How you work
- Do any reasoning you want before generating your shell code
- When you're ready, end your response with a single ```bash fenced code block — the ```bash opening fence on its own new line, never appended to a sentence
- Your code is executed in a bash subprocess
- You see the stdout/stderr output from execution
- You will be called iteratively until you have the answer, then signal completion
- You have all typical shell tools at your disposal
- You have full access to a local filesystem to use as you see fit
```
…(sub-runs, backgrounding, available-tools, trajectory/context guidance:
`bin/shellm:1575-1641`)…
```
## Signaling completion
When you have the answer, set one of these in your bash code:
- `FINAL="your answer"` — set the final answer as a string
- `FINAL_FILE=path/to/file` — set the final answer from a file
```

The `## Guidelines` tail (`bin/shellm:1653-1662`) additionally instructs: inspect
`$CONTEXT`/`$FILE_CONTEXTn` first; code runs under `set -e` (`|| true` for
allowed failures); all steps share `$SHELLM_WORKDIR`; stdin is `/dev/null` (use
non-interactive flags / tmux for PTY work).
