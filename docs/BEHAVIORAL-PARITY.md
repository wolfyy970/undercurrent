> Evidence document for PARITY.md "Behavioral parity round". Written from a real-model run on a Linux box (n=1 per engine); the line numbers it cites for the port refer to 35a8c3c, before the fixes. Paths and the model key never appear here.

# Behavioral parity: headlong-ts vs upstream Headlong 2e39a3f under a real model

2026-10-27 17:56-18:15 EDT. Model `deepseek-flash` (DeepSeek, https://api.deepseek.com/chat/completions), same capped logging proxy for both engines (`proxy/proxy.mjs`, per-engine cap 1.5M tokens, injects `thinking:{type:disabled}` for both and `stream_options.include_usage` on streaming calls; logged request bodies are the originals the engine sent). Bots never saw the key.

Engines: upstream clone <scratch path> @ 2e39a3f (real Bash + Python, run natively on Linux, no Docker, `SHELLM_SANDBOX=local`; installs fine from a checkout with bash/jq/curl/python3, no apt needed). Port <scratch path> = copy of <scratch path> @ 35a8c3c (synced to 2e39a3f + lost-wake ledger; ledger left ON as shipped). Same identity text (`identities/starter-persona.md`, vibe "curious and practical", focus "small experiments with files in my workspace"), same two value memories, same bundled skills (7 identical dirs), fresh trajectory (10 identical seed thoughts), same env (`THINK_CONTEXT_TAIL=30` as upstream's `activate` sets).

## What was and was not run (read this first)
- **S1 cold start**: 1 run per engine, **2m21s, not the planned 6 min** (17:59:53-18:02:14, then both stopped, in-flight steps killed 18:03). Reason: the port burned 1.15M of its 1.5M tokens in that time (see B5).
- **S2 one human message** (`chat send --to ada ...`, asks to read <scratch path>): 1 run per engine, 18:03:11. Both answered correctly. The port then hit its 1.5M cap during S2's tail (6 requests refused 429).
- **S3 (goal via native path) not run. No repeats (n=1 everywhere).** The port's budget was exhausted; I did not raise the cap. Everything below is one sample per engine, model variance not measured.
- Thinking was disabled for both (cost); "thinking default on" was not tested.
- The fix patches are validated by unit tests only, **not re-run against a real model** (port cap spent).
- Mistake: I first started the dispatchers with bare `thinkers start`, which leaves the monolith idle until the 300s watchdog (same in both engines; `thinkers start monolith responder` is the documented kick, `tools/headlong-init:1331`, `tools/persona:210`). Lost ~1 min; S1 time is measured from the correct kick.

## Spend (from proxy per-call usage; price assumed from run4: hit $0.003 / miss $0.15 / out $0.60 per 1M, off-peak; not an invoice)
| | port (ts) | upstream |
|---|---|---|
| billed calls | 54 (+6 refused at cap) | 80 |
| total tokens | 1,543,541 (cap 1.5M, last call overshoots) | 844,062 |
| prompt tokens cache-hit / miss | 220,800 / 1,303,637 (**14% hit**) | 732,160 / 94,764 (**89% hit**) |
| completion tokens | 19,104 | 17,138 |
| est. cost | **$0.208** | **$0.027** |
| wire | 48 non-stream + 6 stream | 80 stream |
| median call latency | 3.2 s | 2.0 s |
Both engines also produced equal completion volume (19.1k vs 17.1k out tokens), so the 7.8x cost gap is almost all prompt size and cache misses, not model output.

## Verdict table
| # | Difference | Classification | Evidence (port file:line | upstream file:line) |
|---|---|---|---|---|
| B5 | **Monolith wakes replay the whole trajectory as chat turns.** Port: 2 messages on wake 1, then 4,6,...,44 messages, prompt 5.4k -> 52k tokens, cache hits stuck at 1,280 tokens from call 16 on. Upstream: every wake's first request is exactly [system,user] (2 msgs), 7.7k-10.4k tokens, 3,584 cached. Also shapes behavior (port wakes avg 3.5 iterations vs upstream 10.4 over the S1 window; one sample, cause not isolated). | **BUG in the port** (high impact) | port `src/monolith.ts` header builder (orig lines ~1034, 1091) only *records* `--context-scope run` in `shellm-run.command`; the loop uses `contextScope` default `"traj"` (`src/shellm.ts:339`, env-only at `src/steprun.ts:410` `SHELLM_CONTEXT_SCOPE`); `runShellm` call (`monolith.ts` ~L354) passes no override. | `thinkers/monolith/step:485` `shellm --model ... --traj ... --context-scope run`. Observed: `proxy/log/*/NNNN.req.json`, `transcript/prompt-diffs`. |
| B4 | Port's system prompt is the bundled head only: 6,025 chars vs upstream 15,747. Missing: shellm CLI reference (`## ShellLM reference` is an empty heading), `## Guidelines` + tmux tail, `## Current run`, `## Machine environment`. | **BUG in the port** (not in PARITY.md deviation rows; SPEC.md:690-750 describes (B)/(C) as part of the prompt) | `src/assets/shellm-system-prompt.txt:97` (ends there); `src/monolith.ts:284` uses it as-is | `bin/shellm:2258-2330` (`usage_text`, Guidelines, `## Current run`, `## Machine environment`) |
| B1 | Two routing hints missing: "last few steps are all thoughts - the stream may be circling" and "most recent step is an ACTION with no observation". On the cold start, upstream's first prompt carried the circling hint (seed steps are all thoughts), the port's did not. | **BUG in the port** (a code comment calls it a "pre-existing gap"; no PARITY.md row) | `src/monolith.ts:571-575` | `thinkers/monolith/step:192-203` |
| B2 | `THINK_CONTEXT_TAIL` env ignored; window hardcoded 20 (upstream default 20, but `activate` exports 30). Port prompt said "last 20", upstream "last 30". | **BUG in the port** (code comment `monolith.ts:36-37` says constants are hardcoded; not a PARITY deviation row) | `src/monolith.ts:33,163,250` | `thinkers/monolith/step:37,189,335`; `tools/identity` activate |
| W1 | LLM request shape for shellm (monolith) and responder: port sends non-stream, `reasoning:{effort:"high"}`, no `max_tokens` (monolith) / 8192 (responder); upstream goes through `llm --thinking --effort high --stop-after-code-block`: `stream:true`, `max_tokens:16384`/8192, `stream_options.include_usage`, no `reasoning` field. `mem search` (the `llm` CLI path) is identical in both (stream, max_tokens 16000). | **Documented in a code comment as intentional** (`OpenRouterClient`, "Reconciling the two is a separate decision"); PARITY.md:581 mentions `reasoning.effort`; not a deviation row. Effect on behavior not isolated. | `src/llm.ts:171-194` | `bin/shellm:1745-1749`; `bin/llm` (openai-compatible branch) |
| D1 | Runtime line says `headlong 35a8c3c (...)` vs `2e39a3f (...)`; checked-out time differs | expected, port is its own commit | `src/monolith.ts` `runtimeLine` | `thinkers/monolith/step` |
| D2 | Workspace dir in prompt: port `<identity>/.shellm/workdirs/<traj>-root`, upstream `<identity>/workdir` | difference; not checked against PARITY rows (identity layout, PARITY.md:457 mentions `SHELLM_WORKDIRS_DIR`) | `src/monolith.ts:825` | `thinkers/monolith/step:39` |
| D3 | Port's identity has no `activate` file and no `thinkers/_lib`; port adds `run/ledger`, `run/cursor` (wake ledger) | documented deviations (PARITY.md:96 "never writes `activate`"; wake ledger row 35a8c3c) | | |
| D4 | Port prompt has one extra blank line in 3 places (head of context, before Runtime line, before `</context>`); responder system prompt 2 extra blank lines | cosmetic, unclassified | `src/monolith.ts:~240-255` | `thinkers/monolith/step:~320-340` |
| D5 | Port `reasoning` trajectory steps carry `in_tok,out_tok` but not `think_tok`/`estimated` (upstream has them) | minor, probably non-stream usage mapping; unclassified | `src/shellm.ts:~666` | `bin/shellm` reasoning step writer |
| E1 | Wake gap between a wake's `final` and the next `shellm-run`: upstream 2.8-5.3 s (n=6), port 0.6-3.7 s (n=13). Backoff constants identical (BASE 5, FACTOR 2, CAP 300, HOLD 3). | expected implementation timing (per-wake bash overhead); not a logic difference I could show | `src/backoff.ts:8-35` | `thinkers/monolith/step:48-51,610-631` |
| E2 | Upstream hit one `STALL` (during S2) (same failing command 3x, rc=1 -> `error` step). Port had none in S1. Port's 2 `error` steps are 429 cap refusals. | upstream quirk / model nondeterminism | | `bin/shellm` stall guard |
| OK | Trajectory structure: same step types, same uuid step ids, same thinker names (monolith, responder), same fields for prompt/final/thought/observation/message/action/reply_claim/shell-output/shellm-run (except D5). | PARITY | `an_traj.py` | |
| OK | Responder: both sent exactly one holding ack plus one `DEFER:` handoff and exactly one follow-up reply (ack +1.8 s upstream / +1.3 s port; answer +23.1 s upstream / +7.0 s port, upstream's mind was mid-wake). Responder prompt text identical apart from trajectory history and D4. Same DEFER protocol, `action`/`observation resolves` bookkeeping. | PARITY (n=1) | | |
| OK | `mem` files: same frontmatter (`id, summary, type, created`), same filename pattern; `mem search` wire identical. `goal` vs `objective` type is the model's choice (both valid per `mem --help`). | PARITY / nondeterminism | | |

## Inner life (S1): what the monolith chose
The choice is not recorded in any field, so this is a heuristic over each wake's commands (`transcript/S1-*`, classifier in the session, rough): 
- upstream, 9 runs: goals/recall x4, goals x1, act x1, share/reply x2, idle/other x1; its first wake wrote WORKSPACE.md and a memory experiment goal, then ran memory experiments (stored facts, `mem search`, rich-summary recall).
- port, 15 runs: learn x5, goals/recall x3, goals x1, goals+values x1, think x1, act x1, share/reply x2, idle/other x1; it wrote NOTES, built `experiments/traj_summary.sh`, noticed its memories were self-referential, then went outward (machine state, Hacker News API, Wikipedia).
Neither engine ever chose `idle` deliberately. Both spent S1 on goals, recall and act; both show spontaneous self-directed projects, i.e. the loop works on both. Only n=1 each; the port's outward turn may reflect the missing circling hint (B1) or just variance.

## Status of the fixes

Superseded by PARITY.md "Behavioral parity round" (branch `fix/behavioral-parity`): B5, B4 (including the dynamic sections), B1, B2 and W1 are fixed and checked by `parity/behavioral/run-parity.mjs` against the real upstream Bash. The report's original patches were ported, not applied verbatim (B4 became a per-run builder, W1 a `llm`-backed client).

## Remains for a follow-up
1. Re-run S1/S2 with the patched port (needs a fresh 1.5M budget; expect ~8x fewer prompt tokens), compare cache-hit and wake length again.
2. S3 (goal via native path), and 2+ runs per scenario to separate variance.
3. W1: decide whether the port's non-stream + `reasoning` request shape should match `llm --thinking` (stream, max_tokens, stop-after-code-block); measure effect.
4. B4's dynamic sections; D2 workdir path; D5 `think_tok`; E1 gap source.
5. Thinking-enabled run (default for DeepSeek).

## Files
`transcript/`: `S1-u|t`, `S2-u|t` (trajectories, memories, logs), `proxy-log-final/{ts,upstream}/` (every request `NNNN.req.json`, response `NNNN.res.txt`, `calls.jsonl`, `state.json`), `prompt-diffs/`, `proxy.mjs`, `engine.sh`, `seed.sh`, `an_req.py`, `an_traj.py`, test logs. Homes: `idu|idt`, `homeu|homet`.

## Hygiene
Key scan at the end: 3,484 files under <scratch path> (all transcripts, proxy logs, homes, both repos, node_modules) read byte-wise for the full key: 0 hits. Proxy, dispatchers, shellm, vitest: all stopped (`ps` shows none). Citations of `src/monolith.ts` line numbers refer to the unpatched 35a8c3c.

## Round 2 (follow-up real-model comparison)
B6 (observation field order, `bin/context:334`), B7 (identity/skills trailing newline, `common.sh:281-282`), E1 (`sleep 1`, `step:490`) and D5 (usage fields on steps) were fixed and are proven by the differential harness (`parity/behavioral/run-parity.mjs`, 30/35 PARITY, 5 DEVIATION for the stale `focus` token in the default identity text, 0 DIVERGE). The menu function a wake chose is inferred from the wake's commands (the report's `classify()` heuristic); neither engine records it, and the port deliberately does not add it.
