# traj fuzz finding #13

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `fork`
- scenario (JSON, strings capped at 2000 chars): `{"group":"fork","steps":[],"withFork":false,"malformed":false,"argv":["fork"]}`
- argv/trigger: `["fork"]`
- reproduce: `PARITY_BASH_TRAJ=<abs path to real traj> node parity/fuzz/run-fuzz.mjs --tool traj --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | yes |
| status | | | yes |
| state | | | **NO** |

## bash output

```
{
  "stdout": "<UUID>\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-unnamed [755]\nFILE <HEX>-root/<HEX>-unnamed/trajectory.jsonl [644] [173B sha=767b9fc3438a8e18] \"{\\\"type\\\":\\\"trajectory\\\",\\\"parent_traj\\\":\\\"\\\",\\\"parent_step\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<HEX>-8232-4a37…(+53B)\"\nFILE <HEX>-root/trajectory.jsonl [644] [192B sha=5d67404dca737507] \"{\\\"type\\\":\\\"fork\\\",\\\"child\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<UUID>\\\",\\\"child_re…(+72B)\""
}
```

## ts output

```
{
  "stdout": "<UUID>\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-unnamed [755]\nFILE <HEX>-root/<HEX>-unnamed/trajectory.jsonl [644] [177B sha=b4956f2e32578faa] \"{\\\"type\\\":\\\"trajectory\\\",\\\"parent_traj\\\":\\\"null\\\",\\\"parent_step\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<HEX>-4384-…(+57B)\"\nFILE <HEX>-root/trajectory.jsonl [644] [192B sha=5d67404dca737507] \"{\\\"type\\\":\\\"fork\\\",\\\"child\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<UUID>\\\",\\\"child_re…(+72B)\""
}
```

## Shrink

- oracle calls: 5
- minimal argv: `["fork"]`
- original argv: `["fork","12345678","--slug","test-name106"]`

## Author's reasoning toward a classification

This scenario's field(s) [state] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
