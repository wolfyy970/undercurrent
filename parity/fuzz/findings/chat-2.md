# chat fuzz finding #2

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `history`
- scenario (JSON, strings capped at 2000 chars): `{"group":"history","argv":["history","--with","bob","--since","bogus"],"nSteps":2,"identity":"alice","trajIdUnset":false,"identityUnset":false,"_seedSeed":408958372}`
- argv/trigger: `["history","--with","bob","--since","bogus"]`
- reproduce: `PARITY_BASH_CHAT=<abs path to real chat> node parity/fuzz/run-fuzz.mjs --tool chat --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

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
  "stderr": "jq: invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n",
  "status": 2,
  "state": "{\"type\":\"message\",\"step_id\":\"m0-0000-4000-8000-000000000000\",\"ts\":\"<ISO>\",\"from\":\"pwa-carol\",\"to\":\"bob\",\"content\":\"seeded content 0 baz\"}\n{\"type\":\"message\",\"step_id\":\"m1-0000-4000-8000-000000000001\",\"ts\":\"<ISO>\",\"from\":\"alice\",\"to\":\"alice\",\"content\":\"seeded content 1 bar\"}\n"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "chat: error: history: --since bogus: invalid duration\n",
  "status": 2,
  "state": "{\"type\":\"message\",\"step_id\":\"m0-0000-4000-8000-000000000000\",\"ts\":\"<ISO>\",\"from\":\"pwa-carol\",\"to\":\"bob\",\"content\":\"seeded content 0 baz\"}\n{\"type\":\"message\",\"step_id\":\"m1-0000-4000-8000-000000000001\",\"ts\":\"<ISO>\",\"from\":\"alice\",\"to\":\"alice\",\"content\":\"seeded content 1 bar\"}\n"
}
```

## Shrink

- oracle calls: 10
- minimal argv: `["history","--with","bob","--since","bogus"]`
- original argv: `["history","--with","bob","--since","bogus"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `chat` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/chat/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
