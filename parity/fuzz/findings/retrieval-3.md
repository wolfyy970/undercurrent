# retrieval fuzz finding #3

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"message","step_id":"trig-1","content":"bar foo197 foo note bravo15"},"memories":[{"id":"00000000","summary":"line1\\nline2 with\\ttab","body":"bar memo my_thing memo memo bravo alpha task"},{"id":"00000001","summary":"bravo613 bar2","body":"x"},{"id":"00000002","summary":"x task memo z9 note a1 bar170 my_thing","body":"bar my_thing test-name foo z9 task baz note x a1"}],"env":{"RETRIEVAL_MIN_HITS":"abc"}}`
- argv/trigger: `{"type":"message","step_id":"trig-1","content":"bar foo197 foo note bravo15"}`
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
  "index": "alpha\t<HEX>\tline1\nbar\t<HEX>\tline1\nbar\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbar170\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbar2\t<HEX>\tbravo613 bar2\nbaz\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbravo\t<HEX>\tline1\nbravo613\t<HEX>\tbravo613 bar2\nfoo\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nline1\t<HEX>\tline1\nline2 with\ttab\nmemo\t<HEX>\tline1\nmemo\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nname\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nnline2\t<HEX>\tline1\nnote\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nsummary\t<HEX>\tline1\nsummary\t<HEX>\tbravo613 bar2\nsummary\t<HEX>\tx task memo z9 note a1 bar170 my_thing\ntask\t<HEX>\tline1\ntask\t<HEX>\tx task memo z9 note a1 bar170 my_thing\ntest\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nthing\t<HEX>\tline1\nthing\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nttab\t<HEX>\tline1\n",
  "seen": "<absent>"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "traj": "{\"type\":\"observation\",\"content\":\"I'm reminded of memory <HEX>: x task memo z9 note a1 bar170 my_thing (3 shared words; mem show <HEX> for the full note)\",\"source\":\"retrieval\",\"retrieved_mem\":\"<HEX>\",\"trigger_step\":\"trig-1\"}",
  "index": "alpha\t<HEX>\tline1\\nline2 with\\ttab\nbar\t<HEX>\tline1\\nline2 with\\ttab\nbar\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbar170\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbar2\t<HEX>\tbravo613 bar2\nbaz\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nbravo\t<HEX>\tline1\\nline2 with\\ttab\nbravo613\t<HEX>\tbravo613 bar2\nfoo\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nline1\t<HEX>\tline1\\nline2 with\\ttab\nmemo\t<HEX>\tline1\\nline2 with\\ttab\nmemo\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nname\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nnline2\t<HEX>\tline1\\nline2 with\\ttab\nnote\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nsummary\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\tbravo613 bar2\nsummary\t<HEX>\tx task memo z9 note a1 bar170 my_thing\ntask\t<HEX>\tline1\\nline2 with\\ttab\ntask\t<HEX>\tx task memo z9 note a1 bar170 my_thing\ntest\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nthing\t<HEX>\tline1\\nline2 with\\ttab\nthing\t<HEX>\tx task memo z9 note a1 bar170 my_thing\nttab\t<HEX>\tline1\\nline2 with\\ttab\n",
  "seen": "<HEX>\n"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status, traj, index, seen] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
