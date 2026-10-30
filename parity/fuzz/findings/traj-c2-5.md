# traj fuzz triage — campaign #2, root cause 5

- classification: **PORT-BUG**
- confidence: high
- instances: 1 (`traj-10.md`; seed base 2, tool sub-seed 2111378778,
  `--count 400`); group `tail`, argv `["tail","-n","-2"]` against a
  1-message trajectory.

## Reproduce

```
printf '{"type":"message","step_id":"m0","ts":"...","content":"x"}\n' > trajectory.jsonl
<HEADLONG_ROOT>/bin/traj tail -n -2 --traj_dir .
node bin/traj.mjs tail -n -2 --traj_dir .
```

## Upstream vs port

- bash: prints the one available line, exit 0 (coreutils `tail -n -2`
  means "last 2 lines," clamped to the 1 line that exists)
- port: prints nothing, exit 0

## Root cause

`tailLastN` (`src/trajCli.ts:1303-1305`, the function bug #51 fixed for
`n === 0`) computes `arr.slice(-n)`:
```ts
function tailLastN<T>(arr: T[], n: number): T[] {
  return n === 0 ? [] : arr.slice(-n);
}
```
`-n` (`-n` parsed via `Number("-2")` = `-2`) here becomes `arr.slice(2)` —
"skip the first 2 items, keep the rest" — not "the last 2 items." Bash/
coreutils treats a `-n -2` (or bare `-n 2`) argument as "last 2 lines"; the
leading `-` on the count is idiomatic and does NOT invert the meaning to
"skip." The port's own bug-#51 comment on this function explicitly
acknowledges "bash's own negative-N-means-positive-N coreutils quirk" but
claims it is "unrelated to this bug" and leaves it exactly as
`.slice(-n)` computes it — that computation is itself wrong for negative
`n`: it should behave as if `n` were `Math.abs(n)`, i.e. `arr.slice(-Math.abs(n))`,
not `arr.slice(-n)` (which flips sign twice back to a POSITIVE forward
offset when `n` was already negative).

This is a sibling bug to bug #51 in the same function, on the opposite
side of zero: bug #51 fixed `n === 0` (was returning everything, should be
empty); this fuzz run found `n < 0` (should behave like `n = |n|` — "last N
lines" — but instead returns everything AFTER the first `|n|` lines,
under-printing or, as here, prints nothing when `|n|` exceeds the file's
own length).

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

Change `tailLastN` to treat a negative `n` the same as its absolute value
(bash's "last N lines regardless of sign" semantics), e.g.:
```ts
function tailLastN<T>(arr: T[], n: number): T[] {
  if (n === 0) return [];
  return arr.slice(-Math.abs(n));
}
```
