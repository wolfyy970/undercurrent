# glob fuzz finding #1

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `limit`
- scenario (JSON, strings capped at 2000 chars): `{"group":"limit","argv":[".hidden","../..","--limit","0"],"seed":{"entries":[{"p":"src/alpha.d.ts","content":"a1186","mtime":143},{"p":"__pycache__/qux812.d.ts","content":"note","mtime":142},{"p":"memo649.d.ts","content":"bravo","mtime":148}]},"missingDirTarget":false}`
- argv/trigger: `[".hidden","../..","--limit","0"]`
- reproduce: `PARITY_BASH_GLOB=<abs path to real glob> node parity/fuzz/run-fuzz.mjs --tool glob --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

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
  "stderr": "find: ./headlong-selfupdate-hDxBDZ: No such file or directory\n",
  "status": 0,
  "state": "DIR __pycache__\nFILE __pycache__/qux812.d.ts\nFILE memo649.d.ts\nDIR src\nFILE src/alpha.d.ts"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "state": "DIR __pycache__\nFILE __pycache__/qux812.d.ts\nFILE memo649.d.ts\nDIR src\nFILE src/alpha.d.ts"
}
```

## Shrink

- oracle calls: 6
- minimal argv: `[".hidden","../..","--limit","0"]`
- original argv: `[".hidden","../..","--limit","0"]`
- **NOTE: the shrunk/minimal argv did NOT reliably reproduce on re-run** (this tool mints fresh per-invocation randomness — a UUID, a temp-file suffix — so the shrinker's own probing calls diverged but a later verification run came back clean). Falling back to the ORIGINAL, already-confirmed-diverging scenario above; the "minimal argv" is a lead, not a guaranteed reproducer. Re-run several times if it doesn't reproduce immediately.

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `glob` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/glob/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
