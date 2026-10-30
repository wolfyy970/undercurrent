# retrieval fuzz finding #5

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"manual","step_id":"trig-1","content":"  has  spaces  "},"memories":[{"id":"00000000","summary":"alpha a1 note265 foo310","body":"z9 foo x qux z9 memo qux alpha a162 qux task700 test-name x"},{"id":"00000001","summary":"alpha test-name my_thing x my_thing","body":"a1930 alpha memo qux note baz bar baz306"}],"env":{"RETRIEVAL_MIN_HITS":"abc","RETRIEVAL_SEEN":"-1"}}`
- argv/trigger: `{"type":"manual","step_id":"trig-1","content":"  has  spaces  "}`
- reproduce: `PARITY_BASH_RETRIEVAL=<abs path to real retrieval> node parity/fuzz/run-fuzz.mjs --tool retrieval --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | **NO** |
| traj | | | yes |
| index | | | yes |
| seen | | | yes |

## bash output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "traj": "",
  "index": "a162\t<HEX>\talpha a1 note265 foo310\na1930\t<HEX>\talpha test-name my_thing x my_thing\nalpha\t<HEX>\talpha a1 note265 foo310\nalpha\t<HEX>\talpha test-name my_thing x my_thing\nbar\t<HEX>\talpha test-name my_thing x my_thing\nbaz\t<HEX>\talpha test-name my_thing x my_thing\nbaz306\t<HEX>\talpha test-name my_thing x my_thing\nfoo\t<HEX>\talpha a1 note265 foo310\nfoo310\t<HEX>\talpha a1 note265 foo310\nmemo\t<HEX>\talpha a1 note265 foo310\nmemo\t<HEX>\talpha test-name my_thing x my_thing\nname\t<HEX>\talpha a1 note265 foo310\nname\t<HEX>\talpha test-name my_thing x my_thing\nnote\t<HEX>\talpha test-name my_thing x my_thing\nnote265\t<HEX>\talpha a1 note265 foo310\nqux\t<HEX>\talpha a1 note265 foo310\nqux\t<HEX>\talpha test-name my_thing x my_thing\nsummary\t<HEX>\talpha a1 note265 foo310\nsummary\t<HEX>\talpha test-name my_thing x my_thing\ntask700\t<HEX>\talpha a1 note265 foo310\ntest\t<HEX>\talpha a1 note265 foo310\ntest\t<HEX>\talpha test-name my_thing x my_thing\nthing\t<HEX>\talpha test-name my_thing x my_thing\n",
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
  "index": "a162\t<HEX>\talpha a1 note265 foo310\na1930\t<HEX>\talpha test-name my_thing x my_thing\nalpha\t<HEX>\talpha a1 note265 foo310\nalpha\t<HEX>\talpha test-name my_thing x my_thing\nbar\t<HEX>\talpha test-name my_thing x my_thing\nbaz\t<HEX>\talpha test-name my_thing x my_thing\nbaz306\t<HEX>\talpha test-name my_thing x my_thing\nfoo\t<HEX>\talpha a1 note265 foo310\nfoo310\t<HEX>\talpha a1 note265 foo310\nmemo\t<HEX>\talpha a1 note265 foo310\nmemo\t<HEX>\talpha test-name my_thing x my_thing\nname\t<HEX>\talpha a1 note265 foo310\nname\t<HEX>\talpha test-name my_thing x my_thing\nnote\t<HEX>\talpha test-name my_thing x my_thing\nnote265\t<HEX>\talpha a1 note265 foo310\nqux\t<HEX>\talpha a1 note265 foo310\nqux\t<HEX>\talpha test-name my_thing x my_thing\nsummary\t<HEX>\talpha a1 note265 foo310\nsummary\t<HEX>\talpha test-name my_thing x my_thing\ntask700\t<HEX>\talpha a1 note265 foo310\ntest\t<HEX>\talpha a1 note265 foo310\ntest\t<HEX>\talpha test-name my_thing x my_thing\nthing\t<HEX>\talpha test-name my_thing x my_thing\n",
  "seen": "<absent>"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
