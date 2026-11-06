# Replay seam removal and K1–K3 (historical)

> **Historical.**

## Replay seam removal and K1-K3 (2026-10-29, branch feat/no-replay-seam)

**Replay seam removed.** `HEADLONG_LLM_REPLAY` / `HEADLONG_LLM_REPLAY_<THINKER>` were port inventions (upstream has no
such switch). `src/steprun.ts`'s `buildLlmClient` now always builds the real `llm` client; with no key and no
`LLM_API_URL` it fails ("no API key … or LLM_API_URL set"), and the old variables are ignored (test/steprun.test.ts
"HEADLONG_LLM_REPLAY is ignored"). The suites that used it (steprun, shellmCli, person-notes-lock,
responder-notes, progress-logs, live-loop, plus web/server e2e-live) now answer through `test/llmFakeServer.ts` over
`LLM_API_URL`, the same way upstream's `tests/test_llm_retry.sh` does. The in-process `ReplayClient` was later removed from `src/llm.ts` too (release v0.1.0): the golden-trace
mirrors (characterization, monolith, topology) now serve their replies from `test/support/modelHttpFixture.ts` over HTTP.

**K1 — `LLM_CONNECT_TIMEOUT` bounded the wait for the first byte.** Upstream passes it to curl as
`--connect-timeout` (bin/llm:102,1424-1425), which bounds the TCP/TLS connect only. The port armed a timer until the
response headers arrived, so a slow-to-answer model was cut off. Fix (src/llmCli.ts): no headers timer; the stall
timer runs from the start. Evidence: test/upstreamDiffK123.test.ts K1 (server sends headers after 2.5 s,
`LLM_CONNECT_TIMEOUT=1`): upstream `bin/llm` exits 0 with the body; the port failed before the fix and now matches.
test/llmCli.test.ts's old "aborts before headers arrive" test (which pinned the bug) was replaced.
**K1 review correction (2026-10-29, independent review).** f0435e0 relied on undici's built-in 10 s connect timeout and
left a non-default `LLM_CONNECT_TIMEOUT` unapplied. Measured on the macOS development machine against an unroutable address: upstream
fails at 3 s / 10 s for `LLM_CONNECT_TIMEOUT=3` / `10`; the port under Node failed at 10-11 s for any value, and under
Bun (what `bin/llm.mjs` runs when `bun` is on PATH, as on that machine) after 60 s, ended only by the stall guard —
Bun's fetch has no connect timeout. Fix (src/llmCli.ts `startAttempt`): a plain TCP connect to the request's host:port
runs beside each attempt; `LLM_CONNECT_TIMEOUT` aborts the attempt only if that connect has not completed (the first
response byte also clears it). It still never bounds the wait for the first byte. Remaining deviation: curl's timer also
covers the TLS handshake; this one covers TCP only. Evidence: test/upstreamDiffK123.test.ts "LLM_CONNECT_TIMEOUT=2 still
bounds a connect that never completes" (node and bun; red before this fix: 11 s and 60 s; skipped as inconclusive where
the address is refused at once) and "the header wait is still bounded by the stall guard" (`LLM_SPEED_TIME=1`, headers
after 6 s: both sides fail before the headers). `parity/llm/run-parity.mjs` with `PARITY_BASH_LLM` = upstream
`bin/llm` (macOS, 2026-10-29): **281/281 effective, 259 identical + 22 documented deviations, 0 PORT BUGS**; the former
`connect-timeout-approx` deviation (`stream/connect-timeout-fast-connect-slow-response`) is now byte-identical.
On Linux (clean release export, 2026-10-29) the same run gave 280/281 until the `jq-crash-nonjson-200` deviation
also listed `state`: upstream's `set -e` abort skips its temp-file cleanup, and GNU mktemp puts that file inside the
captured sandbox, so upstream leaves the response body behind as `tmp/tmp.XXXXXXXXXX`. With that documented: **281/281
effective, 0 PORT BUGS** on Linux too. Behavioral parity on Linux: 43 PARITY, 5 DEVIATION, 0 DIVERGE.

**K2 — nested `shellm` ignored `TRAJ_DIR` and did not nest.** Upstream: trajectory dir
`${SHELLM_TRAJ_DIR:-${TRAJ_DIR:-$home/trajectories}}`, a new run is `traj new --slug "${prompt:0:200}"` plus the parent
fields, giving `<parent dir>/<hex8>-<slug>/` with `parent_traj_ref` (bin/shellm:47,2609-2614). The port wrote a flat
`<hex8>-root` under `$HEADLONG_HOME/trajectories`. Fix (src/shellmCli.ts): same dir precedence; a new run goes through the
port's `traj new` (src/trajCli.ts); run name and merge `from_traj_ref` from its output; the merge is appended to the
parent's resolved file.

**K3 — nested runs never wrote their summary.** Upstream starts `generate_run_summary` for every new trajectory and
cleanup waits up to 30 s (bin/shellm:2366-2440). New src/runSummary.ts ports it (model choice, 20000-char prompt cap,
JSON parse with fence strip, `(summary generation failed)` fallback); src/shellmCli.ts starts it at the header and waits
up to 30 s.

Evidence for K2+K3: test/upstreamDiffK123.test.ts runs upstream `bin/shellm` and the port's `shellm` against one
local endpoint with `TRAJ_DIR` set and `_SHELLM_PARENT_TRAJ_ID`: compared the child dir pattern
(`<parent>/<hex8>-write-hello`), the first step's keys, `parent_traj`, `parent_traj_ref`, the `run-summary` step (tldr,
full_summary, run_id, model) and the summary call count. Before the fix upstream passed and the port failed; now both
match (2/2 passing, `PARITY_UPSTREAM_ROOT` set; skipped without it).

**Per-wake prompt rendering (the former "only remaining stub").** `runStep` calls `buildIdentityConfig` on every wake
(src/steprun.ts:261), which renders `identity prompt` and `skills prompt` from the identity dir. The behavioral harness
compares that task message exactly against upstream's real `thinkers/monolith/step`: `parity/behavioral/run-parity.mjs`
re-run on 2026-10-29: **43/48 PARITY, 5 DEVIATION (documented), 0 DIVERGE**. The last static blob, in the manual
`scripts/real-wake.ts`, now uses `buildIdentityConfig`. Closed.

**Suite (box, 2026-10-29):** 2362 passed / 34 skipped / 5 failed; the 5 failures are the same box-only ones as the
unmodified base on the same box (llmCli bug #57, shellm watchdog bug #33, web controls killall dry_run, killall docker
fixture, chatGuards lock takeover).
**Upstream-tests runner (box, 2026-10-29, main lane, `--daemon` not run):** `node parity/upstream-tests/run.mjs` against
upstream 2e39a3f: 80 suites, port result identical to the committed 2026-10-27 report for every suite. Two rows
changed on the control side only (`test_prompt_file.sh` 4/4 → 5/5 on both sides; `test_contrib_opencode.sh` control
TIMEOUT → 267/267, no port CLI). This runner leaves `bin/shellm` as upstream Bash, so K2/K3 are covered by
test/upstreamDiffK123.test.ts, not by it. The committed report.md is left at 2026-10-27 (it includes the daemon lane).

