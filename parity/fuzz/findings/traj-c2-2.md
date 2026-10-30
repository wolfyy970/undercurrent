# traj fuzz triage — campaign #2, root cause 2

- classification: **PORT-BUG**
- confidence: high
- instances: 2 (`traj-4.md`, `traj-13.md`; seed base 2 sub-seed
  2111378778 `--count 400` and seed base 1 sub-seed 534514473
  `--count 150`); group `fork`, argv `["fork"]` against a well-formed
  trajectory with no parent (forking from the root).

## Reproduce

```
cd <root trajectory dir>
<HEADLONG_ROOT>/bin/traj fork
node bin/traj.mjs fork
# then diff the new child's own trajectory.jsonl "trajectory" record
```

## Upstream vs port

Both sides succeed (exit 0, same stdout `<UUID>\n`, same stderr, same
overall directory listing) — only the new child's own `type":"trajectory"`
record's `parent_traj` field differs:
- bash: `"parent_traj":""`  (empty string — this fork has no parent trajectory)
- port: `"parent_traj":"null"`  (the literal four-character string "null")

## Root cause

When forking from the root (no parent trajectory id), bash writes an empty
string for `parent_traj` — there is simply nothing to put there. The port's
fork implementation appears to compute this field via naive string
coercion of a JS `null`/`undefined` value (`` `${parentTraj}` `` or
`String(parentTraj)`, both of which produce the four-character string
`"null"` rather than `""`) instead of substituting an empty string when
there is no parent.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

In the `fork` implementation (`src/trajCli.ts`), when there is no parent
trajectory, write `parent_traj: ""` explicitly rather than string-coercing
a nullish value — e.g. `parentTraj ?? ""` at the point the trajectory
record is serialized, not a template-literal/`String()` coercion.
