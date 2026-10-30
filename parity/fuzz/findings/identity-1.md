# identity fuzz finding #1 — bare `identity` (no args) misroutes to `new`

- classification: **PORT-BUG (high confidence)**
- group: `list` (mislabeled by the generator — the actual scenario is argv=[])
- argv: `[]`
- reproduce:
  ```
  mkdir -p /tmp/idtest/ids
  IDENTITY_DIR=/tmp/idtest/ids <HEADLONG_ROOT>/tools/identity   # full usage banner, exit 0
  IDENTITY_DIR=/tmp/idtest/ids node bin/identity                # "new"'s usage error, exit 1
  ```

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | full usage banner (`identity — Identity management\n\nUsage:\n  identity new ...`) | (empty) | **NO** |
| stderr | (empty) | `Usage: identity new [--default] [--memories DIR] <name>` | **NO** |
| status | 0 | 1 | **NO** |

## Root cause

Real Bash `identity` with no subcommand at all prints the top-level usage
banner and exits 0 (a `case "$cmd" in ... "") show_usage; exit 0 ;; ... esac`-
style dispatch, or equivalent). The TS port's command dispatcher appears to
default an absent/empty command straight into the `new` subcommand's own
argument handler, which then complains about `new`'s OWN missing required
`<name>` argument — the wrong error, for the wrong command, with the wrong
exit code semantics (0 vs 1).

## Duplicates

84 of identity's 600-iteration findings are this exact scenario (argv=[]) —
it is fully deterministic (no seed-dependent content), so every fuzz
iteration that happened to draw `argv=[]` reproduces it identically. This is
the single highest-count deterministic finding in the whole campaign, but is
ONE bug (a missing top-level "no command" dispatch case), not 84.
