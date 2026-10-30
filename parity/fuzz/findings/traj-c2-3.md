# traj fuzz triage — campaign #2, root cause 3

- classification: **PORT-BUG**
- confidence: high
- instances: 1 (`traj-6.md`; seed base 2, tool sub-seed 2111378778,
  `--count 400`); group `fork`, argv `["fork"]` against a trajectory whose
  ONLY content is the fixed malformed line `not-json-at-all{{{`.

## Reproduce

```
printf 'not-json-at-all{{{\n' > trajectory.jsonl
<HEADLONG_ROOT>/bin/traj fork --traj_dir .
node bin/traj.mjs fork --traj_dir .
```

## Upstream vs port

- bash: `jq: parse error: Invalid numeric literal at line 1, column 16`,
  exit 5, NO new child directory created, root `trajectory.jsonl`
  unchanged (still just the malformed line).
- port: exit 0, stdout `<UUID>\n`, a new child directory IS created, and
  the root `trajectory.jsonl` now has a `type":"fork"` record APPENDED
  after the untouched malformed line.

This is a bigger divergence than the exit-code-only "jq-internal-error"
family in `traj-c2-1.md`: here bash refuses to fork at all (crashes before
doing anything), while the port silently forks successfully from a
trajectory it never validated. (The forked child's `parent_traj` also
shows the separate `"null"`-string bug from `traj-c2-2.md`, since this
scenario is a non-empty-parent-trajectory fork case too — but that's a
secondary symptom here, not the main divergence.)

## Root cause

`fork` in bash needs to read something (likely the current last step, to
record `parent_step`) from the existing trajectory via `jq`, which dies
immediately on the malformed line under `set -euo pipefail` — so a
corrupted trajectory file can never be forked at all upstream. The port's
`fork` implementation does not perform an equivalent
"can every existing line be parsed as JSON" check before proceeding; it
reads whatever it needs (apparently tolerating or skipping the unparseable
line) and completes the fork, appending new state on top of already-corrupt
data instead of refusing.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

`fork` (`src/trajCli.ts`) should validate the existing trajectory file the
same way `cmdLast`/`cmdSearch` now do after bug #48 (die with the port's
own clean "invalid JSON" message, matching bash's exit code) before
performing any part of the fork, rather than proceeding past unparseable
content.
