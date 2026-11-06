# Upstream-oracle recordings round (historical)

> **Historical.**

## Upstream-oracle recordings round (2026-10-29, rec/lane-a + rec/lane-b + rec/lane-c → rec/integrate)

Every test and parity harness that needs a model now gets real recorded DeepSeek replies (labelled with source, date
and model) over the real `LLM_API_URL`. For harnesses, upstream and the port are served from one replay server. HTTP
transport cases are labelled fixtures, and parser-on-literal cases are no-model parser layers. Those layers cut
upstream's code at run time by markers, pinned by byte length and sha256. Provenance: `test/support/README.md`.

**Port fixes found this round**
- responder: the reply call's `llm` stderr reaches the step's stderr, as `_reply_llm`'s `cat "$err" >&2` does (63d8a16).
- shellm: the recorded thought drops only trailing newlines, and a fenceless reply's cmd keeps its leading blank lines,
  like upstream's command substitutions (21f6632).
- recap: a reply holding several JSON values ends the way upstream's does (argjson abort, exit 2), not with the last
  value (260960d).
- bin/* under Bun: stdout/stderr bytes were lost at `process.exit` (a 1.8 KB `llm` reply cut mid-text under load,
  65,295 of 200 KB to a slow reader). Every tool now writes synchronously under Bun (031f79b, 9c31207;
  `test/bun-stdio-flush.test.ts`).

**Documented deviation added**
- recap capped >1 MiB stream: upstream `bin/llm` appends each pre-data SSE line to `_err_buf` (quadratic), so a
  well-formed stream of 49,152 keep-alive lines takes minutes per attempt; the port reads it linearly (d7e2d9f, row above).

**Harness bugs fixed**
- parity/retrieval: four scenarios surfaced nothing on either side (upstream greps the whole seen file), so they passed
  vacuously. Each now writes a fresh unseen memory first (d0d67c9).
- parity/init: its in-process endpoint could never answer while both sides ran under spawnSync, so the 3
  local-provider scenarios were skipped on every run. The endpoint is now a child process; 7/7 + 3 skipped became
  10/10 (b1476b5).

**Numbers on rec/integrate (replay only, no recordings, $0)**

| Harness | Result |
|---|---|
| full suite | 2416/2439 and 2421/2444 passed (23 skipped), 2 runs |
| llm | 281/281 (259 identical + 22 documented) |
| llm adversarial | 235 PARITY, 38 DEVIATION, 5 DIVERGE: upstream's `jq` crash leaves a `tmp.*` file in the sandbox (`state`); committed baseline had 43 DEVIATION, 0 DIVERGE; port side unchanged |
| responder | 83/85 (the 2 PEM redaction divergences) |
| behavioral | 75/81, 6 DEVIATION, 0 DIVERGE |
| extract | 87/87 |
| execlines | 12/12 |
| retrieval | 32/32 (2 documented-deviation scenarios) |
| recap main / parser / seal-trigger | 37/39 (2 documented `${2:?}` messages) / 18/18 / 7/7 |
| recap adversarial | 136 PARITY, 14 DEVIATION, 0 DIVERGE |
| mem | 191/205 (as committed) |
| init | 10/10 |
| fuzz recap / mem (100 each, seed 1) | 97 + 3 allowed / 89 + 9 allowed + 2 findings: `mem types` with an absent `MEM_DIR` exits 2 upstream, 1 in the port (fixed afterwards in 536c64d: the port now returns `ls`'s own cannot-access status, 2 with GNU ls, 1 with BSD/macOS ls) |
| slack / telegram | 42/42 / 36/36 |

