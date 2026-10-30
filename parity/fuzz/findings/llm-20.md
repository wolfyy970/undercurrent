# llm fuzz finding #20

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `closed-port`
- scenario (JSON, strings capped at 2000 chars): `{"group":"closed-port","argv":["5 ","--no-stream"],"env":{"LLM_RETRIES":"0","OPENAI_API_KEY":"fuzz-test-key","LLM_API_URL":"http://127.0.0.1:9/x"}}`
- argv/trigger: `["5 ","--no-stream"]`
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
  "stderr": "llm: warning: LLM_API_URL overrides the default openai endpoint (requests go to 127.0.0.1:9)\nllm: error: curl error: curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server\n",
  "status": 1
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "llm: warning: LLM_API_URL overrides the default openai endpoint (requests go to 127.0.0.1:9)\nllm: error: request failed: bad port\n",
  "status": 1
}
```

## Shrink

- oracle calls: 6
- minimal argv: `["5 ","--no-stream"]`
- original argv: `["--provider","openai","x","-t","5 ","--no-stream"]`

## Author's reasoning toward a classification

This scenario's field(s) [stderr] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `llm` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/llm/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
