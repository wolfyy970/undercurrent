# retrieval fuzz finding #6

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"message","step_id":"trig-1","content":"café vs café","trigger_step":"prior-step"},"memories":[{"id":"00000000","summary":"bravo task note test-name alpha617 x","body":"memo test-name task memo624 a1 a1 alpha qux247 x x z9 test-name bravo676"},{"id":"00000001","summary":"line1\\nline2 with\\ttab","body":"task bar alpha qux alpha z9 bravo306 foo83 x baz qux955 foo foo724"},{"id":"00000002","summary":"line1\\nline2 with\\ttab","body":"  has  spaces  "},{"id":"00000003","summary":"test-name my_thing","body":"my_thing my_thing memo memo baz qux993 my_thing283 bravo89 my_thing"}],"env":{"RETRIEVAL_MIN_HITS":"abc"}}`
- argv/trigger: `{"type":"message","step_id":"trig-1","content":"café vs café","trigger_step":"prior-step"}`
- reproduce: `PARITY_BASH_RETRIEVAL=<abs path to real retrieval> node parity/fuzz/run-fuzz.mjs --tool retrieval --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | **NO** |
| traj | | | yes |
| index | | | **NO** |
| seen | | | yes |

## bash output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "traj": "",
  "index": "alpha\t<HEX>\tbravo task note test-name alpha617 x\nalpha\t<HEX>\tline1\nalpha617\t<HEX>\tbravo task note test-name alpha617 x\nbar\t<HEX>\tline1\nbaz\t<HEX>\tline1\nbaz\t<HEX>\ttest-name my_thing\nbravo\t<HEX>\tbravo task note test-name alpha617 x\nbravo306\t<HEX>\tline1\nbravo676\t<HEX>\tbravo task note test-name alpha617 x\nbravo89\t<HEX>\ttest-name my_thing\nfoo\t<HEX>\tline1\nfoo724\t<HEX>\tline1\nfoo83\t<HEX>\tline1\nline1\t<HEX>\tline1\nline1\t<HEX>\tline1\nline2 with\ttab\nmemo\t<HEX>\tbravo task note test-name alpha617 x\nmemo\t<HEX>\ttest-name my_thing\nmemo624\t<HEX>\tbravo task note test-name alpha617 x\nname\t<HEX>\tbravo task note test-name alpha617 x\nname\t<HEX>\ttest-name my_thing\nnline2\t<HEX>\tline1\nnline2\t<HEX>\tline1\nnote\t<HEX>\tbravo task note test-name alpha617 x\nqux\t<HEX>\tline1\nqux247\t<HEX>\tbravo task note test-name alpha617 x\nqux955\t<HEX>\tline1\nqux993\t<HEX>\ttest-name my_thing\nspaces\t<HEX>\tline1\nsummary\t<HEX>\tbravo task note test-name alpha617 x\nsummary\t<HEX>\tline1\nsummary\t<HEX>\tline1\nsummary\t<HEX>\ttest-name my_thing\ntask\t<HEX>\tbravo task note test-name alpha617 x\ntask\t<HEX>\tline1\ntest\t<HEX>\tbravo task note test-name alpha617 x\ntest\t<HEX>\ttest-name my_thing\nthing\t<HEX>\ttest-name my_thing\nthing283\t<HEX>\ttest-name my_thing\nttab\t<HEX>\tline1\nttab\t<HEX>\tline1\n",
  "seen": "<absent>"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "retrieval: RETRIEVAL_MIN_HITS: unbound variable\n",
  "status": 1,
  "traj": "",
  "index": "alpha\t<HEX>\tbravo task note test-name alpha617 x\nalpha\t<HEX>\tline1\\nline2 with\\ttab\nalpha617\t<HEX>\tbravo task note test-name alpha617 x\nbar\t<HEX>\tline1\\nline2 with\\ttab\nbaz\t<HEX>\tline1\\nline2 with\\ttab\nbaz\t<HEX>\ttest-name my_thing\nbravo\t<HEX>\tbravo task note test-name alpha617 x\nbravo306\t<HEX>\tline1\\nline2 with\\ttab\nbravo676\t<HEX>\tbravo task note test-name alpha617 x\nbravo89\t<HEX>\ttest-name my_thing\nfoo\t<HEX>\tline1\\nline2 with\\ttab\nfoo724\t<HEX>\tline1\\nline2 with\\ttab\nfoo83\t<HEX>\tline1\\nline2 with\\ttab\nline1\t<HEX>\tline1\\nline2 with\\ttab\nline1\t<HEX>\tline1\\nline2 with\\ttab\nmemo\t<HEX>\tbravo task note test-name alpha617 x\nmemo\t<HEX>\ttest-name my_thing\nmemo624\t<HEX>\tbravo task note test-name alpha617 x\nname\t<HEX>\tbravo task note test-name alpha617 x\nname\t<HEX>\ttest-name my_thing\nnline2\t<HEX>\tline1\\nline2 with\\ttab\nnline2\t<HEX>\tline1\\nline2 with\\ttab\nnote\t<HEX>\tbravo task note test-name alpha617 x\nqux\t<HEX>\tline1\\nline2 with\\ttab\nqux247\t<HEX>\tbravo task note test-name alpha617 x\nqux955\t<HEX>\tline1\\nline2 with\\ttab\nqux993\t<HEX>\ttest-name my_thing\nspaces\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\tbravo task note test-name alpha617 x\nsummary\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\tline1\\nline2 with\\ttab\nsummary\t<HEX>\ttest-name my_thing\ntask\t<HEX>\tbravo task note test-name alpha617 x\ntask\t<HEX>\tline1\\nline2 with\\ttab\ntest\t<HEX>\tbravo task note test-name alpha617 x\ntest\t<HEX>\ttest-name my_thing\nthing\t<HEX>\ttest-name my_thing\nthing283\t<HEX>\ttest-name my_thing\nttab\t<HEX>\tline1\\nline2 with\\ttab\nttab\t<HEX>\tline1\\nline2 with\\ttab\n",
  "seen": "<absent>"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status, index] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
