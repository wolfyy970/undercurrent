# retrieval fuzz finding #4

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"observation","step_id":"trig-1","content":"qux bravo task807 task qux note alpha413 memo260 baz z9 foo303 foo"},"memories":[{"id":"00000000","summary":"line1\\nline2 with\\ttab","body":"x alpha858 bar memo note alpha914 qux578 foo x task750"},{"id":"00000001","summary":"line1\\nline2 with\\ttab","body":"my_thing bravo memo994 alpha95 my_thing x alpha"}],"env":{"RETRIEVAL_MIN_HITS":"abc"}}`
- argv/trigger: `{"type":"observation","step_id":"trig-1","content":"qux bravo task807 task qux note alpha413 memo260 baz z9 foo303 foo"}`
- reproduce: `PARITY_BASH_RETRIEVAL=<abs path to real retrieval> node parity/fuzz/run-fuzz.mjs --tool retrieval --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | **NO** |
| traj | | | **NO** |
| index | | | **NO** |
| seen | | | **NO** |

## bash output

```
{
  "stdout": "",
  "stderr": "<ROOT>/thinkers/retrieval/step: line <N>: abc: unbound variable\n",
  "status": 1,
  "traj": "",
  "index": "alpha\t<HEX>\tline1\nalpha858\t<HEX>\tline1\nalpha914\t<HEX>\tline1\nalpha95\t<HEX>\tline1\nbar\t<HEX>\tline1\nbravo\t<HEX>\tline1\nfoo\t<HEX>\tline1\nline1\t<HEX>\tline1\nline1\t<HEX>\tline1\nline2 with\ttab\nmemo\t<HEX>\tline1\nmemo994\t<HEX>\tline1\nnline2\t<HEX>\tline1\nnline2\t<HEX>\tline1\nnote\t<HEX>\tline1\nqux578\t<HEX>\tline1\nsummary\t<HEX>\tline1\nsummary\t<HEX>\tline1\ntask750\t<HEX>\tline1\nthing\t<HEX>\tline1\nttab\t<HEX>\tline1\nttab\t<HEX>\tline1\n",
  "seen": "<absent>"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "traj": "{\"type\":\"observation\",\"content\":\"I'm reminded of memory <HEX>: line1\\\\nline2 with\\\\ttab (2 shared words; mem show <HEX> for the full note)\",\"source\":\"retrieval\",\"retrieved_mem\":\"<HEX>\",\"trigger_step\":\"trig-1\"}",
  "index": "alpha\t<HEX>\tline1\\nline2 with\\ttab\nalpha858\t<HEX>\tline1\\nline2 with\\ttab\nalpha914\t<HEX>\tline1\\nline2 with\\ttab\nalpha95\t<HEX>\tline1\\nline2 with\\ttab\nbar\t<HEX>\tline1\\nline2 with\\ttab\nbravo\t<HEX>\tline1\\nline2 with\\ttab\nfoo\t<HEX>\tline1\\nline2 with\\ttab\nline1\t<HEX>\tline1\\nline2 with\\ttab\nline1\t<HEX>\tline1\\nline2 with\\ttab\nmemo\t<HEX>\tline1\\nline2 with\\ttab\nmemo994\t<HEX>\tline1\\nline2 with\\ttab\nnline2\t<HEX>\tline1\\nline2 with\\ttab\nnline2\t<HEX>\tline1\\nline2 with\\ttab\nnote\t<HEX>\tline1\\nline2 with\\ttab\nqux578\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\tline1\\nline2 with\\ttab\ntask750\t<HEX>\tline1\\nline2 with\\ttab\nthing\t<HEX>\tline1\\nline2 with\\ttab\nttab\t<HEX>\tline1\\nline2 with\\ttab\nttab\t<HEX>\tline1\\nline2 with\\ttab\n",
  "seen": "<HEX>\n"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status, traj, index, seen] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
