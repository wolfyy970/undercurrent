# traj fuzz finding #9

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `search`
- scenario (JSON, strings capped at 2000 chars): `{"group":"search","steps":[{"type":"action","step_id":"a0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"task bravo note foo984 z9409 a1719 alpha565 memo my_thing"},{"type":"action","step_id":"a1-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:01.000Z","content":"my_thing memo942 note369 task775 baz memo542 baz253 note2 baz test-name foo"},{"type":"action","step_id":"a2-0000-4000-8000-000000000002","ts":"2026-01-01T00:00:02.000Z","content":"memo task231"},{"type":"observation","step_id":"o3-0000-4000-8000-000000000003","ts":"2026-01-01T00:00:03.000Z","content":"baz qux"},{"type":"observation","step_id":"o4-0000-4000-8000-000000000004","ts":"2026-01-01T00:00:04.000Z","content":"note test-name test-name953 foo151 a1 z9202"},{"type":"observation","step_id":"o5-0000-4000-8000-000000000005","ts":"2026-01-01T00:00:05.000Z","content":"bravo foo bravo z9"},{"type":"action","step_id":"a6-0000-4000-8000-000000000006","ts":"2026-01-01T00:00:06.000Z","content":"z9 test-name task66 baz793 a1 bar task memo qux bar task715 test-name"},{"type":"action","step_id":"a7-0000-4000-8000-000000000007","ts":"2026-01-01T00:00:07.000Z","content":"alpha x"},{"type":"action","step_id":"a8-0000-4000-8000-000000000008","ts":"2026-01-01T00:00:08.000Z","content":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB…[+1046576 chars truncated]"},{"type":"reasoning","step_id":"r9-0000-4000-8000-000000000009","ts":"2026-01-01T00:00:09.000Z","content":"test-name bar314 baz task bravo my_thing831 bravo alpha111 memo"},{"type":"error","step_id":"e10-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:10.000Z","content":"baz674 test-name a1 my_thing a1 a128 note335 a1 bravo"},{"type":"reasoning","step_id":"r11-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:11.000Z","content":"test-name alpha bravo memo bar471 x"}],"withFork":true,"malformed":true,"argv":["search","foo610"]}`
- argv/trigger: `["search","foo610"]`
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
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-child [755]\nFILE <HEX>-root/<HEX>-child/trajectory.jsonl [644] [61B sha=c0efb4f2e9a3865b] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"child0\\\",\\\"content\\\":\\\"child step\\\"}\\\\n\"\nFILE <HEX>-root/trajectory.jsonl [644] [1050328B sha=7fdcce2215cb3cf8] \"{\\\"type\\\":\\\"action\\\",\\\"step_id\\\":\\\"a0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"task bravo note f…(+1050208B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "traj: error: search: <ROOT>/traj/<HEX>-root/trajectory.jsonl: invalid JSON in row\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-child [755]\nFILE <HEX>-root/<HEX>-child/trajectory.jsonl [644] [61B sha=c0efb4f2e9a3865b] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"child0\\\",\\\"content\\\":\\\"child step\\\"}\\\\n\"\nFILE <HEX>-root/trajectory.jsonl [644] [1050328B sha=7fdcce2215cb3cf8] \"{\\\"type\\\":\\\"action\\\",\\\"step_id\\\":\\\"a0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"task bravo note f…(+1050208B)\""
}
```

## Shrink

- oracle calls: 6
- minimal argv: `["search","foo610"]`
- original argv: `["search","foo610","12345678","-C","3"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
