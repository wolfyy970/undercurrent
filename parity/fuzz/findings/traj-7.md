# traj fuzz finding #7

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `search`
- scenario (JSON, strings capped at 2000 chars): `{"group":"search","steps":[{"type":"action","step_id":"a0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"my_thing z9 foo25 qux note foo"},{"type":"action","step_id":"a1-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:01.000Z","content":"task qux note bar"},{"type":"observation","step_id":"o2-0000-4000-8000-000000000002","ts":"2026-01-01T00:00:02.000Z","content":"a1944 alpha z9 memo baz bravo"},{"type":"action","step_id":"a3-0000-4000-8000-000000000003","ts":"2026-01-01T00:00:03.000Z","content":"my_thing my_thing task"}],"withFork":false,"malformed":true,"argv":["search","qux bar978"]}`
- argv/trigger: `["search","qux bar978"]`
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
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [546B sha=a8b212b1110cd852] \"{\\\"type\\\":\\\"action\\\",\\\"step_id\\\":\\\"a0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"my_thing z9 foo25…(+426B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "traj: error: search: <ROOT>/traj/<HEX>-root/trajectory.jsonl: invalid JSON in row\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [546B sha=a8b212b1110cd852] \"{\\\"type\\\":\\\"action\\\",\\\"step_id\\\":\\\"a0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"my_thing z9 foo25…(+426B)\""
}
```

## Shrink

- oracle calls: 4
- minimal argv: `["search","qux bar978"]`
- original argv: `["search","qux bar978","12345678"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
