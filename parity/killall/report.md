# headlong-killall — differential parity proof

Real Bash tool `headlong/tools/headlong-killall` vs TS port `headlong-ts/bin/headlong-killall`.

**Scope note (read before reading the table):** both tools are deliberately system-wide panic buttons with no CLI-level scoping, so this harness runs ONLY `--dry-run` invocations (never a real kill) and splits scenarios into two kinds:
- `exact` — fully deterministic (help/usage-error text), byte-diffed stdout+stderr+exit.
- `structural` — the live process-table listing is excluded from comparison on purpose (the two tools' process universes are disjoint by construction — bash script argv vs this port's node argv — and even the bash side alone is nondeterministic across runs on a shared machine); only exit code, the trailing "(dry run — nothing was killed)" marker, and stream routing (stdout vs stderr) are checked. Real reaping of REAL processes (TERM/KILL, descendant-tree expansion, docker cleanup) is proven separately by test/killall.test.ts against processes it spawns itself.

## Result: 7/7 PARITY (100.0%)

| # | kind | group | scenario | verdict | fields differing |
|---|---|---|---|---|---|
| 1 | exact | help | help-short | PARITY | - |
| 2 | exact | help | help-long | PARITY | - |
| 3 | exact | usage-error | unknown-option | PARITY | - |
| 4 | exact | usage-error | unknown-option-short | PARITY | - |
| 5 | structural | dry-run | plain-dry-run | PARITY | - |
| 6 | structural | dry-run | short-flag-dry-run | PARITY | - |
| 7 | structural | dry-run | dry-run-with-web | PARITY | - |

## Mismatches (detail)

None.
