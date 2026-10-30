# identity list — differential parity proof

Real Bash tool `headlong/tools/identity list` vs TS port `headlong-ts/bin/identity list`, identical `.identities`-shaped fixtures in isolated sandboxes, diffed stdout+stderr+exit code (list is read-only — no on-disk state to compare).

## Result: 17/17 PARITY (100.0%)

| # | group | scenario | argv | verdict | fields differing |
|---|---|---|---|---|---|
| 1 | zero | existing-empty-dir | `["list"]` | PARITY | - |
| 2 | zero | missing-dir | `["list"]` | PARITY | - |
| 3 | zero | only-dangling-default-symlink | `["list"]` | PARITY | - |
| 4 | one | no-default-set | `["list"]` | PARITY | - |
| 5 | one | default-set | `["list"]` | PARITY | - |
| 6 | one | default-set-show-dir | `["list","-a"]` | PARITY | - |
| 7 | three | mixed-dates-started-fallback-stray-dir-default | `["list"]` | PARITY | - |
| 8 | three | mixed-dates-started-fallback-stray-dir-default--show-dir | `["list","-a"]` | PARITY | - |
| 9 | three | --all-long-flag-same-as--a | `["list","--all"]` | PARITY | - |
| 10 | quirks | plain-file-excluded | `["list"]` | PARITY | - |
| 11 | quirks | symlink-to-dir-included-lexical-path-not-realpath | `["list","-a"]` | PARITY | - |
| 12 | quirks | dangling-symlink-excluded | `["list"]` | PARITY | - |
| 13 | quirks | case-insensitive-primary-ordering | `["list"]` | PARITY | - |
| 14 | quirks | long-name-no-truncation | `["list"]` | PARITY | - |
| 15 | argv-edge-cases | extra-positional-ignored | `["list","foo","bar"]` | PARITY | - |
| 16 | argv-edge-cases | unknown-flag-stops-parsing-silently | `["list","-x"]` | PARITY | - |
| 17 | argv-edge-cases | -a-after-positional-not-reparsed | `["list","foo","-a"]` | PARITY | - |

## Mismatches (detail)

None.
