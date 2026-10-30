# view fuzz finding #15

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `offset-limit`
- scenario (JSON, strings capped at 2000 chars): `{"group":"offset-limit","argv":["{FILE}","--limit","0x10"],"seed":{"name":"f.txt","content":"<Buffer 454 bytes>"}}`
- argv/trigger: `["{FILE}","--limit","0x10"]`
- reproduce: `PARITY_BASH_VIEW=<abs path to real view> node parity/fuzz/run-fuzz.mjs --tool view --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | **NO** |
| status | | | **NO** |

## bash output

```
{
  "stdout": "     1\tline 1 xxxx\n     2\tline 2 x\n     3\tline 3 xxxx\n     4\tline 4 x\n     5\tline 5 xxxxx\n     6\tline 6 xx\n     7\tline 7 xxxx\n     8\tline 8 xxx\n     9\tline 9 x\n    10\tline 10 \n    11\tline 11 xxxxx\n    12\tline 12 xxx\n    13\tline 13 xxx\n    14\tline 14 xx\n    15\tline 15 x\n    16\tline 16 xxxxx\n",
  "stderr": "",
  "status": 0
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "view: end line (0) is before start line (1)\n",
  "status": 1
}
```

## Shrink

- oracle calls: 3
- minimal argv: `["{FILE}","--limit","0x10"]`
- original argv: `["{FILE}","--offset","0","--limit","0x10"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout, stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `view` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/view/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
