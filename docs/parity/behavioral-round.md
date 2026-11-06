# Behavioral parity round (historical)

> **Historical.** Real-model comparison notes at upstream `2e39a3f`. Overview: [`PARITY.md`](../../PARITY.md).

## Behavioral parity round (real-model comparison, upstream 2e39a3f)

A real-model run of upstream's Bash Headlong and this port, same model (DeepSeek flash through
one capped logging proxy), identity, memory and prompts, found that the port did not behave like
upstream even though every deterministic suite was green (`docs/BEHAVIORAL-PARITY.md`: one
sample per engine, a cold start and one human message). The port spent 1.54M tokens (about
$0.21, 14% prompt-cache hits) where upstream spent 0.84M (about $0.03, 89% hits). Branch
`fix/behavioral-parity`; every fix cites the upstream line it mirrors and every claim below is
re-checked against the source, not the report.

| id | difference found | fix | evidence |
| --- | --- | --- | --- |
| **B5** | `thinkers/monolith/step:485` runs `shellm … --context-scope run`: each wake's first
request is `[system, user]`. The port only RECORDED the flag in the `shellm-run` header; the
loop used `contextScope:"traj"` (`src/shellm.ts` default, env-only at `src/steprun.ts`), so
every earlier wake was replayed as chat turns (2 → 44 messages, 5k → 52k prompt tokens, cache
hits stuck at 1,280). | `runMonolithWake` passes `constants.contextScope = "run"` |
`test/behavioralParity.test.ts` (B5); `parity/behavioral/run-parity.mjs` "second wake's first
request is exactly [system, user]" (upstream Bash and port both 2 messages) |
| **B4** | The port sent 6,025 chars of system prompt; upstream sends ~15.7k: the shellm CLI
reference (`usage_text`, `bin/shellm:276-355`), `## Guidelines` + tmux tail, the scope-dependent
`Output budget` line (`:2231-2246`), Docker `## Execution environment`, `## Current run` and `##
Machine environment` (`:2303-2358`). The bundled asset also predated the 2e39a3f sync (it still
had a sentence upstream removed). | `src/shellmPrompt.ts` assembles the prompt per run from
`src/assets/shellm-system-prompt.txt` (regenerated from upstream's own `shellm
--print-system-prompt`, two placeholders) plus the dynamic sections; `runShellm` takes a builder
so the run dir and scope are known | `test/behavioralParityB4.test.ts`; differential: system
prompt text identical after normalizing only run dir, date, bash version and package-manager
list |
| **B1** | Two routing hints missing: "last few steps are all thoughts — the stream may be circling" and "most recent step is an ACTION that has no observation" (`thinkers/monolith/step:192-203`) | ported, in upstream's order, ahead of the pending-request hint | `test/behavioralParity.test.ts` (B1, B1b); differential "task message structure (anchor lines)" on a seed of six thoughts |
| **B2** | `THINK_CONTEXT_TAIL` was hardcoded 20 in monolith and responder (`step:37,189`; responder `step:22,232`); upstream reads the env, and `identity shell` exports 30 by default (`tools/identity:414,1424`) | both thinkers read the env; `resolveIdentityEnv` defaults it to 30 (after `.env` loading) | `test/behavioralParityB2.test.ts`; differential runs with the env set, both print "last 30" |
| **W1** | Upstream's shellm loop and responder never call a provider: they run `llm`
(`bin/shellm:1737-1745`, `thinkers/responder/step:57-66`), so the wire request is `llm`'s:
`stream:true`, `stream_options.include_usage`, `max_tokens` (per-model default, 16384 for most;
the responder passes `-t`), and NO `reasoning` field. The port's `OpenRouterClient` POSTed
non-streaming with `reasoning:{effort}` and no `max_tokens`. A code comment called that
intentional; there was no deviation row. | `buildLlmClient` returns `LlmCliClient`
(`src/llmCliClient.ts`), which runs the port's own `llm` CLI port (`src/llmCli.ts`, proven
against `bin/llm`) in process with upstream's argv (monolith: `-m --effort --thinking
--system-prompt --messages-file [-t] --stop-after-code-block`; responder: `-t -m -M -s
[--json-schema]`, per-call `LLM_MAX_TIME`/`LLM_RETRIES`). `OpenRouterClient` stays for the
manual scripts only. | `test/behavioralParityW1.test.ts`; differential "request flags identical"
(model, stream, stream_options, max_tokens, no reasoning) on all three calls |
| **B6** | `bin/context:334` renders a non-reasoning step's fields in jq `keys` (sorted) order; the port rendered them in insertion order, so an observation's fields appeared in a different order in the model's context | `renderStep` sorts the keys (`src/context.ts`, `renderKeys(…, true)`) | `test/behavioralParityRound2.test.ts` (failing test first, commit order test→fix) |
| **B7** | `thinkers/_lib/common.sh:281-282` takes `identity prompt` / `skills prompt` through
`$(…)`, which strips trailing newlines; the port kept the file's trailing newline, adding blank
lines to the system/task prompt | `buildIdentityConfig` strips trailing `\n` from both pieces
(`src/steprun.ts`); the same applies to `think_prompt=$(load_prompt …)`
(`thinkers/monolith/step:277`, `src/monolith.ts`), which was the last extra blank line before
`</context>` | `test/behavioralParityRound2.test.ts` (B7); differential "task message EXACT text
identical" (blank lines included), 3/3 wakes |
| **E1** | `thinkers/monolith/step:489-490` ends every run with a literal `sleep 1` before it
probes the trajectory and computes `wake_at` (it exists for `tail -F`, but the second is part of
the cadence: the step stays busy for it and `wake_at` is stamped after it). Only the monolith
step has a literal sleep (`grep -rn sleep thinkers/`: the responder and retrieval steps have
none, so there is nothing to match there) | `runMonolithWake` awaits a real 1000 ms timer at the
same point (`postRunSleep`, injectable) | `test/behavioralParityE1.test.ts` (fake clock: called
once with 1000, after the run's final step, before the idle fallback, and `wake_at` uses the
post-sleep clock) |
| **D5** | `bin/shellm:3332` writes the reasoning/final step as `{type,thought,cmd,run_id,llm_s}
+ $usage`, the WHOLE `write_usage` record (`bin/llm:1017-1037`: in_tok, out_tok, think_tok,
cache_tok, estimated, served_by, truncated). The port copied only
in_tok/out_tok/think_tok/estimated, so `cache_tok`, `served_by` and `truncated` never reached a
step. A reply ending in a fenced block is cut by stop-after-block and records only the ESTIMATED
usage on both engines (`bin/llm:1464`), so the full record is visible on a no-code reply |
`usageFields` passes all seven fields; `LlmCliClient`/`llm.ts` forward `cache_tok` |
`test/behavioralParityD5.test.ts`; differential "FIELD SETS" and "usage VALUES" over 5 model
calls incl. a no-code wake (fails 5 ways on the pre-fix code) |
| **R1** | The responder's WIRE request (not only the argv it hands `llm`, covered by
`parity/responder`) was never compared with upstream's | harness drives upstream's real
`thinkers/responder/step` + `bin/llm` and `bin/thinker-step.mjs responder` against the same
stub, structured (`response_format`) and text scenarios | differential: request body EXACT
(model, stream, stream_options, max_tokens, response_format, every message), same step types and
field sets; 6/6 PARITY. This also closes the report's D4 (extra blank lines in the responder
prompt): the bodies are byte-identical after B7 |
| **E2** (IDENTITY_DIR) | `bin/thinkers:387-389` exports IDENTITY_DIR, IDENTITY_NAME, MEM_DIR,
SKILLS_DIR, SKILLS_KERNEL_DIR, TRAJ_DIR, TRAJ_ID, THINKERS_DIR, SHELLM_HOME, THINK_MODEL,
THINK_CONTEXT_TAIL, THINKERS_MAX_CONCURRENT and NO_SELF_TRIGGER to every step. In local mode the
model's code runs as `bash -e -c` inside shellm (`bin/shellm:1629`) and inherits them; in Docker
only the `--var` list (`thinkers/_lib/common.sh:735-776`) plus PATH/HOME reach the container
(`bin/shellm:1651-1664`). The port's exec env is a whitelist (`src/sandbox.ts:362`, `req.env`)
fed from `buildIdentityConfig` (`src/steprun.ts:163-177`) and `runMonolithWake`
(`src/monolith.ts:361-370`), which never carried IDENTITY_DIR, SKILLS_KERNEL_DIR, THINKERS_DIR,
SHELLM_HOME, THINK_MODEL or THINK_CONTEXT_TAIL: a real run saw `$IDENTITY_DIR` empty 82 times |
`applyLocalInheritedEnv` (`src/sandbox-runtime.ts`) adds the dispatcher-exported names that are
SET in the step env to the exec env of LOCAL sandboxes only, existing exec-env values winning;
Docker is unchanged, as upstream. Unset names stay unset. The responder runs no model-driven
shell (its IDENTITY_DIR uses, `step:639,648`, are the log paths in `src/responder.ts`, which
already take `env["IDENTITY_DIR"]`); retrieval reads IDENTITY_DIR from the step env directly
(`src/retrieval.ts:361`) | `test/steprun.test.ts` "IDENTITY_DIR and the rest ..." (failed before
the fix), `test/sandbox-runtime.test.ts`; differential: the wake-1 command prints 12 variables
and the harness compares each as upstream's real Bash and the port see it (6 diverged before:
IDENTITY_DIR, SKILLS_KERNEL_DIR, THINKERS_DIR, SHELLM_HOME, THINK_MODEL, THINK_CONTEXT_TAIL; 0
after). **Not changed:** upstream's local shell also inherits the rest of the step's environment
(API keys etc.); this port keeps its whitelist on purpose |

**Differential harness.** `node parity/behavioral/run-parity.mjs`
(`PARITY_UPSTREAM_ROOT=<upstream checkout>`; `test/behavioralRequestParity.test.ts` wraps it and
skips without the env) runs upstream's real `thinkers/monolith/step` (with real `bin/shellm`,
`bin/llm`) and `bin/thinker-step.mjs monolith` over the same identity layout, seed trajectory
and env against one recording stub endpoint: wake 1 (a command round, then FINAL) and a second
wake in the same run. Compared per call: system prompt text, message roles/count, request flags,
the task message's anchor lines; plus `shellm-run` header fields and the trajectory step-type
sequence. Round 2 extends it: a third wake whose reply has no code block, the task message
compared EXACTLY (only timestamps/ids, the `Runtime:`/`Workspace:`/`- Now:` lines and an
upstream encoding artifact are masked; the identity text is not masked, each documented in the
script), trajectory step field sets and usage values per model call, and the responder
(structured and text) wire request. Result: **43/48 PARITY, 5 DEVIATION (documented), 0
DIVERGE** (the 5 are the one `focus` token below; 13 of the checks are the wake-shell env
probe). Against 35a8c3c (before round 1): 3/12 PARITY, 9 DIVERGE; with the round-2 source fixes
reverted: 5 DIVERGE (task message x3, field sets, usage values), so it can fail.

**Deviations kept by this round (each with its reason).**

| Where | Source behavior | Port behavior | Why | Scenario |
|---|---|---|---|---|
| shellm system prompt, Docker section | `## Execution environment` names the run's image and
says it has bash, python3, jq, curl and passwordless sudo (`bin/shellm:2303-2308`); `## Docker
access` sections for broker/socket/dind (`:2309-2321`) | same text with the port's image
(`node:24-bookworm`, DOC #65); no Docker-access sections (the port has no docker-access modes) |
the text is upstream's verbatim; whether the port's image has python3/jq/sudo was not checked,
so for a Docker-mode wake the prompt may claim tools the container lacks |
`test/behavioralParityB4.test.ts` (text only; no Docker differential) |
| shellm system prompt, `## Machine environment` | `$BASH_VERSION` of the running shellm; package managers found on shellm's PATH | `bash -c 'printf %s "$BASH_VERSION"'` of the first `bash` on PATH; managers found on the wake's PATH (which carries the port's bin and node dirs) | the port has no bash process of its own; the value is machine-dependent in both | `parity/behavioral/run-parity.mjs` normalizes these two lines |
| model calls run `llm` in process | `shellm`/`responder` fork the `llm` tool | `LlmCliClient`
calls `runLlm` in the same Node process with the same argv; `buildLlmClient`'s credential gate
is "any `*_API_KEY`, `LLM_API_URL` or `SHELLM_API_URL` set" (was "OPENROUTER_API_KEY or
LLM_API_KEY") because provider and key choice are now `llm`'s own | no subprocess boundary in
this port; provider/key selection must be `llm`'s, not a second implementation |
`test/behavioralParityW1.test.ts`, `test/steprun.test.ts` |
| `THINK_CONTEXT_TAIL` identity default | `identity shell` exports `${THINK_CONTEXT_TAIL:-30}`
then sources the identity `.env` with `set -a` (the `.env` wins) | defaulted to 30 after the
`.env` layers load, which fill only missing variables, so an identity `.env` value is kept, a
shell value is kept | the port's `.env` layering is fill-missing throughout (PARITY "identity
env"); the only observable difference is a `.env` value overriding a pre-set shell value |
`test/behavioralParityB2.test.ts` |
| default identity text lists `focus` | `tools/identity:1510` (`_ensure_kernel`'s default
`core_identity_prompt`) says "I am driven by standalone commands (think, chat, focus, mem,
skills, traj)". The command does not exist at the pin: `bin/focus` was deleted by 12ca841
(`bin/` at 2e39a3f has chat context llm mem recap shellm shellm-docker skills thinkers traj),
and 12ca841 only edited the parallel list in `deploy/slack-persona.md`, so the identity text is
stale upstream | `src/steprun.ts` `DEFAULT_IDENTITY_TEXT` reads "(think, chat, mem, skills,
traj)"; the port has no `focus` command either (`src/focus.ts`/`bin/focus.mjs` retired in 1c) |
there is nothing to match: upstream's `focus` neither exists nor works at the pin, so restoring
the bytes would tell every new mind (and every responder/monolith prompt) about a command that
fails with "command not found". Matching the oracle's TEXT is only worth it when the oracle's
behavior backs it. It is one token in one string; everything else in the prompt is compared byte
for byte | `parity/behavioral/run-parity.mjs`: identity text is NOT masked; the 5 exact-text
checks (3 monolith task messages, 2 responder bodies) are reported `DEVIATION` iff dropping that
one token makes them identical, `DIVERGE` otherwise; a further check asserts neither side has a
`focus` command. If upstream restores `focus` (or edits `tools/identity`), the check fails and
this row must go |

**Not verified here (still open).** No real model was run after the fixes (the prompt/cost
effect is expected from the request shapes, not measured). Masked in the exact task-message
comparison, not equal: the `Runtime:` line (each side names its own checkout), the `- Now:`
clock line, and `Workspace:` (D2: `.shellm/workdirs/<traj>-root` vs `<identity>/workdir`, still
unclassified). Documented deviation the comparison reports as `DEVIATION` (not masked): the
retired `focus` command is dropped from the default identity text (see the "default identity
text lists `focus`" row above). Tolerated artifact: upstream's second wake byte-mangles one em
dash in the menu text into U+FFFD (an oracle encoding artifact, not copied; seen only in the
wake after a command wake). Not compared: Docker prompt text; T1 (run dir `/tmp/headlong-run-`
vs `/tmp/shellm-run.`) and S1 (stall error text) from the report.

**Menu choice is inferred, not recorded.** Upstream never records which menu function (act, share, goals, …) a monolith wake chose; the report's `classify()` infers it from the wake's commands. The port does the same and its trajectory carries no "menu function chosen" step: adding one would deviate from upstream.

### Known upstream issue, kept faithful on purpose: editing a person memory drops `person_key`

`mem edit` rebuilds the frontmatter from only `type`, `created`, `id`, `until` (and
`schedule`/`tz`, plus the new `updated:` entry), so editing a person memory silently drops its
`person_key` (and any other custom field), in BOTH engines: upstream `bin/mem:621-624`, port
`src/mem.ts:872`, `:904`, `:911`, `:933`. The responder looks people up by that key
(`thinkers/responder/step:374-392`), so after an edit the person is no longer found by the
lookup until the key is restored. This is upstream's behavior at the pin and the port reproduces
it byte for byte; **we deliberately stay faithful and do not fix it here**. If upstream fixes
it, port the fix with a differential scenario (edit, then responder lookup).

