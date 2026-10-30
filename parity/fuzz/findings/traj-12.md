# traj fuzz finding #12

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `search`
- scenario (JSON, strings capped at 2000 chars): `{"group":"search","steps":[{"type":"observation","step_id":"o0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"memo note memo334 foo alpha test-name692 my_thing5"},{"type":"thought","step_id":"t1-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:01.000Z","content":"test-name a1444 my_thing foo memo bar100 task task alpha442"},{"type":"action","step_id":"a2-0000-4000-8000-000000000002","ts":"2026-01-01T00:00:02.000Z","content":"a1878 alpha528 foo331 memo task alpha baz test-name597 baz"},{"type":"observation","step_id":"o3-0000-4000-8000-000000000003","ts":"2026-01-01T00:00:03.000Z","content":"my_thing my_thing my_thing z9 bravo805 alpha task165 x212 bar z9 a1 foo"},{"type":"reasoning","step_id":"r4-0000-4000-8000-000000000004","ts":"2026-01-01T00:00:04.000Z","content":"qux baz z9 bar bravo80 test-name test-name qux159 alpha593 memo597 qux"}],"withFork":false,"malformed":true,"argv":["search","a1 memo"]}`
- argv/trigger: `["search","a1 memo"]`
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
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [871B sha=ce1d20d948f50162] \"{\\\"type\\\":\\\"observation\\\",\\\"step_id\\\":\\\"o0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"memo note me…(+751B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "traj: error: search: <ROOT>/traj/<HEX>-root/trajectory.jsonl: invalid JSON in row\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [871B sha=ce1d20d948f50162] \"{\\\"type\\\":\\\"observation\\\",\\\"step_id\\\":\\\"o0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"memo note me…(+751B)\""
}
```

## Shrink

- oracle calls: 4
- minimal argv: `["search","a1 memo"]`
- original argv: `["search","a1 memo","12345678"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
