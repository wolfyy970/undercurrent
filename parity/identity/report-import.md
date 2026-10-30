# identity import — differential parity proof

Real Bash tool `headlong/tools/identity import` vs TS port `headlong-ts/bin/identity import`, on archives the REAL Bash `identity export` produced from REAL Bash `identity new`-built fixtures. Diffs exit code, imported-name stdout (as a set), and a structural directory tree (ignoring the pre-existing, PARITY.md-documented `activate`-file and kernel/bundled-skill symlink-vs-copy deviations inherited from `identity new`).

## Result: 6/6 PARITY (100.0%)

| # | scenario | verdict | status(bash/ts) | stdout match | tree diffs |
|---|---|---|---|---|---|
| 1 | single-identity-default-name | PARITY | 0/0 | true | 0 |
| 2 | single-identity-rename | PARITY | 0/0 | true | 0 |
| 3 | multi-identity-all | PARITY | 0/0 | true | 0 |
| 4 | soul-only-live-root-repair | PARITY | 0/0 | true | 0 |
| 5 | conflict-existing-identity | PARITY | 1/1 | true | 0 |
| 6 | not-a-gzip-archive | PARITY | 1/1 | true | 0 |

## Mismatches (detail)

None.
