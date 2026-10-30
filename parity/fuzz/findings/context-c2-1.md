# context fuzz triage — campaign #2, root cause 1

- classification: **upstream-crash**
- confidence: high
- instances: 2 (`parity/fuzz/findings/context-1.md`, `context-2.md`; seed
  base 2, tool sub-seed 642250210,
  `node parity/fuzz/run-fuzz.mjs --tool context --seed 2 --count 400`)

## Reproduce

Any `context --max-bytes N` invocation where the assembled JSON messages
array exceeds `N` bytes (both findings hit this via a trajectory containing a
>1MB single-step content field). Minimal argv from finding #1:
`["--max-bytes","4430"]`.

## Upstream vs port

`bin/context` (`tools/context` upstream) has `set -euo pipefail` at the top
(line 2) and, when the built result exceeds the byte budget
(`tools/context:495-497`):

```bash
if [[ "$best_bytes" -gt "$CTX_MAX_BYTES" ]]; then
    printf '%s' "$best_result" | head -c "$CTX_MAX_BYTES"
    printf '[budget exceeded: trajectory too dense]' >&2
else
```

`head -c N` reads only `N` bytes and closes its stdin early. `printf`, still
writing the rest of `$best_result` into the closed pipe, receives SIGPIPE and
exits 141. Under `pipefail`, the pipeline's exit status becomes 141; under
`-e` (errexit), that non-zero pipeline status aborts the script immediately —
the very next line (the `[budget exceeded...]` stderr message) never runs.

Captured bash output: stdout = truncated JSON (correct, `head -c` did write
it), **stderr = "" (the intended message is dead code)**, **status = 141**.

Captured port output: stdout = same truncated JSON, **stderr =
"[budget exceeded: trajectory too dense]\n"**, **status = 0**.

## Root cause

This is a defect in the *upstream Bash script itself*: any time the
assembled context exceeds `--max-bytes`, the script crashes on its own
`head -c` truncation idiom via SIGPIPE before it can emit the diagnostic it
was written to emit, and reports a shell-signal exit code (141) instead of a
clean one. The port does not (and should not) replicate an accidental
SIGPIPE crash — its behavior (truncate, print the diagnostic, exit 0) is
exactly what the upstream code visibly *intends* to do at that call site,
just without the self-inflicted pipe-close race. This is deterministic
upstream behavior (not flaky), so it's not a harness/environment artifact —
it is the real Bash tool crashing on any over-budget trajectory.

No PARITY.md row covers this (checked `parity/context/run-parity.mjs` and
`parity/fuzz/lib/allowances.mjs` — no `--max-bytes`-exceeded allowance
exists), so it is not a pre-existing documented deviation either.

## Recommendation

Leave as-is per this lane's scope (no src/ or harness changes). Worth a
human decision on whether to document this in PARITY.md as an intentional
divergence (the port fixes an upstream self-crash) rather than carry it as
an open finding indefinitely.
