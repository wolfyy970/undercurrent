# traj fuzz finding #6

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `fork`
- scenario (JSON, strings capped at 2000 chars): `{"group":"fork","steps":[],"withFork":false,"malformed":true,"argv":["fork"]}`
- argv/trigger: `["fork"]`
- reproduce: `PARITY_BASH_TRAJ=<abs path to real traj> node parity/fuzz/run-fuzz.mjs --tool traj --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | **NO** |
| status | | | **NO** |
| state | | | **NO** |

## bash output

```
{
  "stdout": "",
  "stderr": "jq: parse error: Invalid numeric literal at line 1, column 16\n",
  "status": 5,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [19B sha=671fa754a7792c6e] \"not-json-at-all{{{\\\\n\""
}
```

## ts output

```
{
  "stdout": "<UUID>\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/<HEX>-unnamed [755]\nFILE <HEX>-root/<HEX>-unnamed/trajectory.jsonl [644] [177B sha=b4956f2e32578faa] \"{\\\"type\\\":\\\"trajectory\\\",\\\"parent_traj\\\":\\\"null\\\",\\\"parent_step\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<HEX>-f9fc-…(+57B)\"\nFILE <HEX>-root/trajectory.jsonl [644] [211B sha=fa47c41ec24136d2] \"not-json-at-all{{{\\\\n{\\\"type\\\":\\\"fork\\\",\\\"child\\\":\\\"<UUID>\\\",\\\"step_id\\\":\\\"<HEX>-866c-4069-ae04-4b3b…(+91B)\""
}
```

## Shrink

- oracle calls: 1
- minimal argv: `["fork"]`
- original argv: `["fork"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout, stderr, status, state] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
