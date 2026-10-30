# mem fuzz finding #1 — `mem types` lists type counts in a different order

- classification: **PORT-BUG (high confidence, low severity)**
- group: `types`
- argv: `["types"]` against a seeded memory store with a "goal" and a "note" memory
- reproduce: seed `.memories/` with one `type: goal` and one `type: note`
  memory (see `parity/fuzz/tools/mem.mjs`'s `FIX.first`/`FIX.second`), run
  `mem types` on both sides.

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | `   1  note\n   1  goal\n` | `   1  goal\n   1  note\n` | **NO** |
| stderr | (empty) | (empty) | yes |
| status | 0 | 0 | yes |
| state | unchanged | unchanged | yes |

## Root cause

Bash's `mem types` lists distinct types in some non-alphabetical order
(likely file/mtime/insertion order from its `ls`/`awk` pipeline — here
"note" before "goal", the reverse of alphabetical). The TS port sorts types
alphabetically ("goal" before "note"). Counts and content are otherwise
identical — purely an ORDERING divergence.

## Duplicates

6 of mem's findings are this exact scenario — deterministic given any 2+
distinct types in the seeded store, one root cause.
