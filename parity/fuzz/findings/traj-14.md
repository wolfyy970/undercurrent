# traj fuzz finding #14

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `search`
- scenario (JSON, strings capped at 2000 chars): `{"group":"search","steps":[{"type":"thought","step_id":"t0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"memo test-name580 task189 my_thing"},{"type":"action","step_id":"a1-0000-4000-8000-000000000001","ts":"2026-01-01T00:00:01.000Z","content":"foo z9552"},{"type":"action","step_id":"a2-0000-4000-8000-000000000002","ts":"2026-01-01T00:00:02.000Z","content":"test-name my_thing note bravo"},{"type":"action","step_id":"a3-0000-4000-8000-000000000003","ts":"2026-01-01T00:00:03.000Z","content":"qux baz294 task qux qux944 alpha note test-name34 bravo alpha264 task my_thing268"},{"type":"action","step_id":"a4-0000-4000-8000-000000000004","ts":"2026-01-01T00:00:04.000Z","content":"z9 bar foo x bar baz note x bar memo memo124"},{"type":"thought","step_id":"t5-0000-4000-8000-000000000005","ts":"2026-01-01T00:00:05.000Z","content":"bravo355 my_thing note553 qux z9105 baz task z9409"},{"type":"observation","step_id":"o6-0000-4000-8000-000000000006","ts":"2026-01-01T00:00:06.000Z","content":"baz435 qux my_thing qux qux task memo bravo memo foo bravo a1719"},{"type":"error","step_id":"e7-0000-4000-8000-000000000007","ts":"2026-01-01T00:00:07.000Z","content":"task task477 alpha test-name84 foo681 memo955 qux task task memo qux355"},{"type":"error","step_id":"e8-0000-4000-8000-000000000008","ts":"2026-01-01T00:00:08.000Z","content":"z9 memo"},{"type":"message","step_id":"m9-0000-4000-8000-000000000009","ts":"2026-01-01T00:00:09.000Z","content":"���(���"},{"type":"observation","step_id":"o10-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:10.000Z","content":"café — 日本語 😀 memo"}],"withFork":false,"malformed":true,"argv":["search","baz545 note572 alpha"]}`
- argv/trigger: `["search","baz545 note572 alpha"]`
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
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [1634B sha=0c6e325c1ca3b90c] \"{\\\"type\\\":\\\"thought\\\",\\\"step_id\\\":\\\"t0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"memo test-name58…(+1514B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "traj: error: search: <ROOT>/traj/<HEX>-root/trajectory.jsonl: invalid JSON in row\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [1634B sha=0c6e325c1ca3b90c] \"{\\\"type\\\":\\\"thought\\\",\\\"step_id\\\":\\\"t0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"memo test-name58…(+1514B)\""
}
```

## Shrink

- oracle calls: 4
- minimal argv: `["search","baz545 note572 alpha"]`
- original argv: `["search","baz545 note572 alpha","12345678"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
