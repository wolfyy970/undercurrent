# traj fuzz finding #3

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `show`
- scenario (JSON, strings capped at 2000 chars): `{"group":"show","steps":[],"withFork":false,"malformed":true,"argv":["show","12345678"]}`
- argv/trigger: `["show","12345678"]`
- reproduce: `PARITY_BASH_TRAJ=<abs path to real traj> node parity/fuzz/run-fuzz.mjs --tool traj --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | **NO** |
| status | | | **NO** |
| state | | | yes |

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
  "stdout": "undefined\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nFILE <HEX>-root/trajectory.jsonl [644] [19B sha=671fa754a7792c6e] \"not-json-at-all{{{\\\\n\""
}
```

## Shrink

- oracle calls: 4
- minimal argv: `["show","12345678"]`
- original argv: `["show","12345678","--full"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout, stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `traj` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/traj/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
