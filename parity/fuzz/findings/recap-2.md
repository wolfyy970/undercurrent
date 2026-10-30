# recap fuzz finding #2

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `recap`
- scenario (JSON, strings capped at 2000 chars): `{"group":"recap","argv":["--context"],"n":0,"_seed":818347773,"stubMode":"badjson"}`
- argv/trigger: `["--context"]`
- reproduce: `PARITY_BASH_RECAP=<abs path to real recap> node parity/fuzz/run-fuzz.mjs --tool recap --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

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
  "stdout": "=== RIGHT NOW â the last 0 steps, verbatim ===\n",
  "stderr": "head: illegal line count -- 0\n",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/rollups [755]\nFILE <HEX>-root/rollups/meta.json [644] [59B sha=68681af488c8a5e8] \"{\\\\n  \\\"start_index\\\": 0,\\\\n  \\\"updated\\\": \\\"<ISO>\\\"\\\\n}\\\\n\"\nFILE <HEX>-root/rollups/rendered.meta.json [644] [187B sha=c8ab5808113566b5] \"{\\\\n  \\\"version\\\": 1,\\\\n  \\\"keep\\\": \\\"[\\\\\\\"thought\\\\\\\",\\\\\\\"action\\\\\\\",\\\\\\\"observation\\\\\\\",\\\\\\\"message\\\\\\\",\\\\\\\"feedback\\\\\\\",\\\\\\\"final\\\\\\\",\\\\\\\"shellm-run\\\\\\\",\\\\…(+67B)\"\nFILE <HEX>-root/rollups/rendered.tsv [644] [0B sha=e3b0c44298fc1c14] \"\"\nFILE <HEX>-root/trajectory.jsonl [644] [0B sha=e3b0c44298fc1c14] \"\""
}
```

## ts output

```
{
  "stdout": "=== RIGHT NOW â the last 0 steps, verbatim ===\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  <HEX>-root [755]\nDIR  <HEX>-root/rollups [755]\nFILE <HEX>-root/rollups/meta.json [644] [59B sha=68681af488c8a5e8] \"{\\\\n  \\\"start_index\\\": 0,\\\\n  \\\"updated\\\": \\\"<ISO>\\\"\\\\n}\\\\n\"\nFILE <HEX>-root/rollups/rendered.meta.json [644] [187B sha=c8ab5808113566b5] \"{\\\\n  \\\"version\\\": 1,\\\\n  \\\"keep\\\": \\\"[\\\\\\\"thought\\\\\\\",\\\\\\\"action\\\\\\\",\\\\\\\"observation\\\\\\\",\\\\\\\"message\\\\\\\",\\\\\\\"feedback\\\\\\\",\\\\\\\"final\\\\\\\",\\\\\\\"shellm-run\\\\\\\",\\\\…(+67B)\"\nFILE <HEX>-root/rollups/rendered.tsv [644] [0B sha=e3b0c44298fc1c14] \"\"\nFILE <HEX>-root/trajectory.jsonl [644] [0B sha=e3b0c44298fc1c14] \"\""
}
```

## Shrink

- oracle calls: 3
- minimal argv: `["--context"]`
- original argv: `["--context","--json"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `recap` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/recap/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
