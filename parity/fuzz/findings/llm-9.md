# llm fuzz finding #9

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `closed-port`
- scenario (JSON, strings capped at 2000 chars): `{"group":"closed-port","argv":["--provider","adapter","-M","not json"],"env":{"LLM_RETRIES":"0","OPENAI_API_KEY":"fuzz-test-key","LLM_API_URL":"http://127.0.0.1:9/x","LLM_ADAPTER":"/bin/false"}}`
- argv/trigger: `["--provider","adapter","-M","not json"]`
- reproduce: `PARITY_BASH_LLM=<abs path to real llm> node parity/fuzz/run-fuzz.mjs --tool llm --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | yes |

## bash output

```
{
  "stdout": "",
  "stderr": "llm: error: LLM_ADAPTER is not executable: /bin/false\n",
  "status": 1
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "llm: error: --messages is not valid JSON\n",
  "status": 1
}
```

## Shrink

- oracle calls: 6
- minimal argv: `["--provider","adapter","-M","not json"]`
- original argv: `["--provider","adapter","-M","not json"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `llm` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/llm/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
