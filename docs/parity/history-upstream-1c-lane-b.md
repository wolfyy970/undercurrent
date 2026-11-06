# Upstream sync 1c, lane B (historical)

> **Historical.** Thinker engine core.

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

