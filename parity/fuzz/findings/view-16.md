# view fuzz finding #16

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `offset-limit`
- scenario (JSON, strings capped at 2000 chars): `{"group":"offset-limit","argv":["{FILE}","--limit","5 "],"seed":{"name":"f.txt","content":"<Buffer 640 bytes>"}}`
- argv/trigger: `["{FILE}","--limit","5 "]`
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
  "stdout": "     1\tline 1 xx\n     2\tline 2 xx\n     3\tline 3 xxxxx\n     4\tline 4 xxxx\n     5\tline 5 x\n",
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
- minimal argv: `["{FILE}","--limit","5 "]`
- original argv: `["{FILE}","--offset","0","--limit","5 "]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout, stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `view` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/view/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
