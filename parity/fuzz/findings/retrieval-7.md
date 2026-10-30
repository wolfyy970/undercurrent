# retrieval fuzz finding #7

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"observation","step_id":"trig-1","content":2528},"memories":[{"id":"00000000","summary":"a1 bar baz x bravo","body":"/etc/passwd"},{"id":"00000001","summary":"foo x foo foo158 bravo","body":"alpha a1 memo699"},{"id":"00000002","summary":"memo note test-name824 my_thing foo","body":"my_thing note a1"}],"env":{"RETRIEVAL_MIN_HITS":"abc"}}`
- argv/trigger: `{"type":"observation","step_id":"trig-1","content":2528}`
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
  "index": "alpha\t<HEX>\tfoo x foo foo158 bravo\nbar\t<HEX>\ta1 bar baz x bravo\nbaz\t<HEX>\ta1 bar baz x bravo\nbravo\t<HEX>\ta1 bar baz x bravo\nbravo\t<HEX>\tfoo x foo foo158 bravo\netc\t<HEX>\ta1 bar baz x bravo\nfoo\t<HEX>\tfoo x foo foo158 bravo\nfoo\t<HEX>\tmemo note test-name824 my_thing foo\nfoo158\t<HEX>\tfoo x foo foo158 bravo\nmemo\t<HEX>\tmemo note test-name824 my_thing foo\nmemo699\t<HEX>\tfoo x foo foo158 bravo\nname824\t<HEX>\tmemo note test-name824 my_thing foo\nnote\t<HEX>\tmemo note test-name824 my_thing foo\npasswd\t<HEX>\ta1 bar baz x bravo\nsummary\t<HEX>\ta1 bar baz x bravo\nsummary\t<HEX>\tfoo x foo foo158 bravo\nsummary\t<HEX>\tmemo note test-name824 my_thing foo\ntest\t<HEX>\tmemo note test-name824 my_thing foo\nthing\t<HEX>\tmemo note test-name824 my_thing foo\n",
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
  "index": "alpha\t<HEX>\tfoo x foo foo158 bravo\nbar\t<HEX>\ta1 bar baz x bravo\nbaz\t<HEX>\ta1 bar baz x bravo\nbravo\t<HEX>\ta1 bar baz x bravo\nbravo\t<HEX>\tfoo x foo foo158 bravo\netc\t<HEX>\ta1 bar baz x bravo\nfoo\t<HEX>\tfoo x foo foo158 bravo\nfoo\t<HEX>\tmemo note test-name824 my_thing foo\nfoo158\t<HEX>\tfoo x foo foo158 bravo\nmemo\t<HEX>\tmemo note test-name824 my_thing foo\nmemo699\t<HEX>\tfoo x foo foo158 bravo\nname824\t<HEX>\tmemo note test-name824 my_thing foo\nnote\t<HEX>\tmemo note test-name824 my_thing foo\npasswd\t<HEX>\ta1 bar baz x bravo\nsummary\t<HEX>\ta1 bar baz x bravo\nsummary\t<HEX>\tfoo x foo foo158 bravo\nsummary\t<HEX>\tmemo note test-name824 my_thing foo\ntest\t<HEX>\tmemo note test-name824 my_thing foo\nthing\t<HEX>\tmemo note test-name824 my_thing foo\n",
  "seen": "<absent>"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
