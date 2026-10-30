# glob fuzz finding #2

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `none`
- scenario (JSON, strings capped at 2000 chars): `{"group":"none","argv":["[^a].ts","../.."],"seed":{"entries":[{"p":"__pycache__/a1510.js","content":"a1570","mtime":480},{"p":"src/foo.test.ts","content":"memo","mtime":376},{"p":".venv/z9.ts","content":"a1","mtime":416}]},"missingDirTarget":false}`
- argv/trigger: `["[^a].ts","../.."]`
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
  "stderr": "find: ./killall-tree-TYL6IF: No such file or directory\n",
  "status": 0,
  "state": "DIR .venv\nFILE .venv/z9.ts\nDIR __pycache__\nFILE __pycache__/a1510.js\nDIR src\nFILE src/foo.test.ts"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "state": "DIR .venv\nFILE .venv/z9.ts\nDIR __pycache__\nFILE __pycache__/a1510.js\nDIR src\nFILE src/foo.test.ts"
}
```

## Shrink

- oracle calls: 2
- minimal argv: `["[^a].ts","../.."]`
- original argv: `["[^a].ts","../.."]`
- **NOTE: the shrunk/minimal argv did NOT reliably reproduce on re-run** (this tool mints fresh per-invocation randomness — a UUID, a temp-file suffix — so the shrinker's own probing calls diverged but a later verification run came back clean). Falling back to the ORIGINAL, already-confirmed-diverging scenario above; the "minimal argv" is a lead, not a guaranteed reproducer. Re-run several times if it doesn't reproduce immediately.

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `glob` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/glob/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
