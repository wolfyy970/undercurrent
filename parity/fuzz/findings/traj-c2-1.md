# traj fuzz triage — campaign #2, root cause 1

- classification: **documented-deviation** (PARITY.md "traj last --field /
  search: jq-internal crash on a malformed row" row, bug #48,
  jq-internal-error allowance)
- confidence: high
- instances: 8 (`traj-1.md` [campaign #1, pre-fix capture — see "Status of
  the old finding" below]; `traj-5.md`, `traj-7.md`, `traj-8.md`,
  `traj-9.md`, `traj-11.md`, `traj-12.md`, `traj-14.md` [campaign #2, seed
  base 2 sub-seed 2111378778 `--count 400` and seed base 1 sub-seed
  534514473 `--count 150`]); groups `last` and `search`, all against a
  trajectory containing (or consisting solely of) the fixed malformed line
  `not-json-at-all{{{`.

## Reproduce

```
printf 'not-json-at-all{{{\n' > trajectory.jsonl
<HEADLONG_ROOT>/bin/traj last --field step_id --traj_dir .
node bin/traj.mjs last --field step_id --traj_dir .
# and similarly: traj search <pattern>
```

## Upstream vs port

- bash: `jq: parse error: Invalid numeric literal at line 1, column 16`,
  exit 5
- port: `traj: error: last: <path>: invalid JSON in last step` (or the
  equivalent `search` message), exit 5

Exit codes match exactly (5 = 5) in every one of the 7 campaign-#2
instances; only jq's own parse-error text vs the port's clean message
differs.

## Root cause

Exactly bug #48 (PARITY.md): upstream pipes a raw trajectory line into
`jq -r` with no JSON validation first, both in `cmd_last --field`
(`bin/traj:708`) and in `cmd_search`'s per-row loop (`bin/traj:~1216`); a
malformed line makes jq itself die (exit 5) with wording specific to the
exact garbage bytes and the jq build/version. The port's fix
(`cmdLast`/`cmdSearch` in `src/trajCli.ts`) now throws the SAME exit code
(5) with its own clean message instead of relaying jq's text — matching
PARITY.md's own classification: "the EXIT CODE is matched exactly, but
jq's own parse/runtime-error text is NOT reproduced ... This is an
ALLOWANCE, not a claim of byte-for-byte stderr parity." No coded predicate
for this family exists in `parity/fuzz/lib/allowances.mjs` (only
categories 1, 5, and 6 are implemented — see that file's header), so every
fuzz run that draws a malformed-row `last`/`search` scenario resurfaces
this as a fresh "unclassified" finding even though the exit-code behavior
has been correct since bug #48 landed. (Shared root cause with
`chat-c2-1.md`'s bug #47 family.)

## Status of the old finding (`traj-1.md`)

`traj-1.md` predates bug #48's fix and captures the PRE-fix state: bash
exit 5, port exit 1 (the exit-code mismatch bug #48 fixed). Re-run today,
this exact scenario now matches on exit code (see `traj-8.md`/`traj-11.md`,
the SAME `last --field` scenario, both showing exit 5 = 5) — `traj-1.md` is
superseded/resolved, not open. Included here because it was still marked
`UNCLASSIFIED` on disk.

## Recommendation

No src/ change (bug #48 confirmed non-regressed: exit codes match in every
instance). Flagging the missing coded allowance as a harness-fix candidate
for a future lane with its own test — out of this lane's authority to add
unilaterally.
