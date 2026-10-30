# traj fuzz finding #5

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `search`
- scenario (JSON, strings capped at 2000 chars): `{"group":"search","steps":[{"type":"observation","step_id":"o0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"bar memo foo674 task7 memo test-name bravo528 alpha baz"},{"type":"reasoning","step_id":"r1-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:01.000Z","content":"bravo bar870 bravo"},{"type":"thought","step_id":"t2-0000-4000-8000-000000000002","ts":"2026-01-01T00:00:02.000Z","content":"foo706"},{"type":"thought","step_id":"t3-0000-4000-8000-000000000003","ts":"2026-01-01T00:00:03.000Z","content":"bar716 baz514 qux test-name801 baz750 bar alpha baz"},{"type":"error","step_id":"e4-0000-4000-8000-000000000004","ts":"2026-01-01T00:00:04.000Z","content":"bar qux944"},{"type":"thought","step_id":"t5-0000-4000-8000-000000000005","ts":"2026-01-01T00:00:05.000Z","content":"note bravo test-name baz489 bar"},{"type":"reasoning","step_id":"r6-0000-4000-8000-000000000006","ts":"2026-01-01T00:00:06.000Z","content":"foo alpha bravo test-name371 note z9 foo278 note qux43 baz"},{"type":"reasoning","step_id":"r7-0000-4000-8000-000000000007","ts":"2026-01-01T00:00:07.000Z","content":"alpha foo my_thing6 test-name alpha task note note baz"},{"type":"reasoning","step_id":"r8-0000-4000-8000-000000000008","ts":"2026-01-01T00:00:08.000Z","content":"note foo430 test-name note qux bar task"},{"type":"observation","step_id":"o9-0000-4000-8000-000000000009","ts":"2026-01-01T00:00:09.000Z","content":"note a1 my_thing foo bravo x339 z9 z9265"}],"withFork":true,"malformed":true,"argv":["search","qux335"]}`
- argv/trigger: `["search","qux335"]`
- reproduce: `PARITY_BASH_TRAJ=<abs path to real traj> node parity/fuzz/run-fuzz.mjs --tool traj --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | yes |
| state | | | yes |

## bash output

```
{
  "stdout": "",
  "stderr": "jq: parse error: Invalid numeric literal at line 1, column 16\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-child [755]\nFILE <HEX>-root/<HEX>-child/trajectory.jsonl [644] [61B sha=c0efb4f2e9a3865b] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"child0\\\",\\\"content\\\":\\\"child step\\\"}\\\\n\"\nFILE <HEX>-root/trajectory.jsonl [644] [1465B sha=a94f116cece7766d] \"{\\\"type\\\":\\\"observation\\\",\\\"step_id\\\":\\\"o0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"bar memo foo…(+1345B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "traj: error: search: <ROOT>/traj/<HEX>-root/trajectory.jsonl: invalid JSON in row\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-child [755]\nFILE <HEX>-root/<HEX>-child/trajectory.jsonl [644] [61B sha=c0efb4f2e9a3865b] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"child0\\\",\\\"content\\\":\\\"child step\\\"}\\\\n\"\nFILE <HEX>-root/trajectory.jsonl [644] [1465B sha=a94f116cece7766d] \"{\\\"type\\\":\\\"observation\\\",\\\"step_id\\\":\\\"o0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"bar memo foo…(+1345B)\""
}
```

## Shrink

- oracle calls: 4
- minimal argv: `["search","qux335"]`
- original argv: `["search","qux335","-E"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
