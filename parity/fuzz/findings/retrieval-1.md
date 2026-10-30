# retrieval fuzz finding #1 — RETRIEVAL_MIN_HITS as a bareword (not decimal) kills bash but not the port

- classification: **PORT-BUG candidate / new deviation family (adjacent to but DISTINCT from the already-documented one)**
- group: `retrieval`
- env: `RETRIEVAL_MIN_HITS=abc` (a bareword, not a decimal like the
  already-documented "1.5" case), trigger = an action/message step whose
  content shares words with a seeded memory
- reproduce: use `parity/fuzz/tools/retrieval.mjs`'s `makeIdentity`/`baseEnv`
  sandbox shape (or `parity/retrieval/run-parity.mjs`'s), set
  `RETRIEVAL_MIN_HITS=abc`, feed a matching trigger step on stdin to both
  `thinkers/retrieval/step` and `bin/retrieval-step.mjs`.

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | (empty) | (empty) | yes |
| stderr | `<script>: line N: abc: unbound variable` | (empty) | **NO** |
| status | 1 | 0 | **NO** |
| traj | no observation appended | observation appended (memory retrieved) | **NO** |
| index | present (index built before the crash) | present, structurally similar | **NO** (byte-level, not semantic) |
| seen | `<absent>` (never written — bash dies before the seen write) | ring updated | **NO** |

## Root cause vs. the ALREADY-documented deviation

PARITY.md's retrieval row documents ONE non-integer-`RETRIEVAL_MIN_HITS`
deviation: a DECIMAL value like `"1.5"` makes Bash's `[[ $hits -ge 1.5 ]]`
throw an **arithmetic syntax error** (caught, test evaluates false, Bash
exits 0 silently with no retrieval); the port also silently no-ops, exit 0 —
documented as a stderr-wording-only deviation (`isBashLineWordingDeviation`
in this harness's `lib/allowances.mjs`), matching exit codes.

A BAREWORD value like `"abc"` hits a DIFFERENT Bash code path: under Bash's
`set -u`, referencing `abc` as if it were a variable name (which is what a
bareword becomes inside `[[ ... -ge abc ]]`'s arithmetic context) is an
**unbound variable** — not a caught arithmetic-syntax error, but an
uncaught fatal error that kills the whole script (`exit 1`), before the
"seen" bookkeeping write happens. The port, in contrast, appears to apply
the SAME "non-integer -> skip the check, proceed" handling to `"abc"` as it
does to `"1.5"` — silently proceeding to a full, successful retrieval
(exit 0, traj/seen both updated).

This is NOT covered by the existing "1.5" deviation (exit codes differ: 1 vs
0, not 0 vs 0) and is reported here as a fresh, distinct finding.

## Duplicates

4 of retrieval's raw findings (out of 300 iterations) are various shapes of
this (RETRIEVAL_MIN_HITS as a bareword, in combination with different
trigger content) — one root cause.
