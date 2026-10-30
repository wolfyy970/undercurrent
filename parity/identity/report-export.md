# identity export — differential parity proof

Real Bash tool `headlong/tools/identity export` vs TS port `src/identity.ts` buildIdentityExportArchive (the same library `web/server/src/control.ts` calls for the web routes), both run against the SAME REAL-Bash-`identity new`-built source tree. Archives decoded with this port's own tar reader and diffed as structured entry lists (entry set, type, mode-sensitive fields, bytes/linkname) — not raw tar bytes. See this file's header comment for the exact, small set of documented allowances (ordering, manifest `exported_at`).

## Result: 7/7 PARITY (100.0%)

| # | scenario | verdict | entries(bash/ts) | diffs | manifest match |
|---|---|---|---|---|---|
| 1 | single-identity-by-name | PARITY | 36/36 | 0 | true |
| 2 | single-identity-by-path | PARITY | 36/36 | 0 | true |
| 3 | soul-only | PARITY | 33/33 | 0 | true |
| 4 | slim-truncate-and-redact | PARITY | 36/36 | 0 | true |
| 5 | slim-drops-content-b64 | PARITY | 36/36 | 0 | true |
| 6 | all-identities | PARITY | 69/69 | 0 | true |
| 7 | default-identity-no-args | PARITY | 35/35 | 0 | true |

## Mismatches (detail)

None.
