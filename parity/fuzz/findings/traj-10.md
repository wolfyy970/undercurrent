# traj fuzz finding #10

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `tail`
- scenario (JSON, strings capped at 2000 chars): `{"group":"tail","steps":[{"type":"message","step_id":"m0-0000-4000-8000-000000000000","ts":"2026-01-01T00:00:00.000Z","content":"qux bar x12 bravo454 memo z9 test-name x a1211 a1 alpha"}],"withFork":false,"malformed":false,"argv":["tail","-n","-2"]}`
- argv/trigger: `["tail","-n","-2"]`
- reproduce: `PARITY_BASH_TRAJ=<abs path to real traj> node parity/fuzz/run-fuzz.mjs --tool traj --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | yes |
| status | | | yes |
| state | | | yes |

## bash output

```
{
  "stdout": "{\"type\":\"message\",\"step_id\":\"m0-0000-4000-8000-000000000000\",\"ts\":\"<ISO>\",\"content\":\"qux bar x12 bravo454 memo z9 test-name x a1211 a1 alpha\"}\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [162B sha=257b6f07fa94e89e] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"m0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"qux bar x12 brav…(+42B)\""
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [162B sha=257b6f07fa94e89e] \"{\\\"type\\\":\\\"message\\\",\\\"step_id\\\":\\\"m0-0000-4000-8000-000000000000\\\",\\\"ts\\\":\\\"<ISO>\\\",\\\"content\\\":\\\"qux bar x12 brav…(+42B)\""
}
```

## Shrink

- oracle calls: 7
- minimal argv: `["tail","-n","-2"]`
- original argv: `["tail","12345678","-n","-2"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
