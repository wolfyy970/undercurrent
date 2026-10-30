# traj fuzz finding #2 — `traj search "<pattern with a space>"` crashes bash, port succeeds

- classification: **PORT-BUG candidate (Bash-side crash the port doesn't replicate) — likely the port's behavior is more correct, but it IS a real divergence**
- group: `search`
- argv: `["search", "a1 memo"]` (a search pattern containing a space) against
  a seeded trajectory containing matching content
- reproduce: seed a `<hex8>-root/trajectory.jsonl` with a step whose content
  includes "a1" and "memo", then run `traj search "a1 memo"` on both sides
  with `TRAJ_DIR`/`TRAJ_ID` pointed at it.

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | (empty) | search results (matching lines) | **NO** (implicitly — bash never produces any) |
| stderr | `jq: parse error: Invalid numeric literal at line 1, column 16` | (empty) | **NO** |
| status | 5 | 0 | **NO** |
| state | unchanged | unchanged | yes |

## Root cause

Bash's `traj search <pattern>` builds a `jq` filter/argument using the raw
pattern; a pattern containing a space breaks jq's own argument tokenizing
(the second word gets parsed as if it were a separate, invalid numeric jq
program fragment) — a Bash-side escaping/quoting bug, not an intentional
"multi-word patterns are rejected" contract (nothing in `traj --help`
documents this restriction). The TS port evidently passes the pattern
through as a single string/regex safely and returns real results.

This looks like the port doing the RIGHT thing where Bash has a real
escaping bug — but it's still a byte-level divergence a differential harness
must report, and a human should confirm the intended contract (does
`traj search` support multi-word patterns at all in the design?) rather than
this harness silently treating "the port is probably better" as a pass.

## Related: `traj last --field <name>` (finding traj-1)

`traj-1.md` (argv `["last", "--field", "step_id"]`) shows the SAME
`jq: parse error: Invalid numeric literal at line 1, column 16` message from
Bash against a fixture containing a non-hex `step_id` ("child0") in a
sub-trajectory. Likely the SAME class of Bash-side jq-argument-escaping bug
(a raw string value reaching jq in a numeric-argument position), but not yet
independently minimized to confirm it's the identical code path as `search`
— reported separately pending further isolation.

## Duplicates

4 of traj's `search` findings (out of 300 iterations) are shapes of this
(various multi-word patterns) — one root cause; `traj-1`'s `last --field`
variant is provisionally grouped with it (1 finding) pending confirmation.
