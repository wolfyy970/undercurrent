# Upstream sync 1c, lane A (historical)

> **Historical.** `7d29f9e` → `5458fee`, shellm/llm/context core.

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

