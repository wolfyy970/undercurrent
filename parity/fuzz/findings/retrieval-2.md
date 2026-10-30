# retrieval fuzz finding #2

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `retrieval`
- scenario (JSON, strings capped at 2000 chars): `{"group":"retrieval","trigger":{"type":"action","step_id":"trig-1","content":"note alpha memo memo143 alpha note521 task","trigger_step":"prior-step"},"memories":[{"id":"00000000","summary":"qux871 a1 bravo qux658 memo bar foo","body":"memo950 z9 bravo my_thing baz bravo z9"}],"env":{"RETRIEVAL_MIN_HITS":"abc"}}`
- argv/trigger: `{"type":"action","step_id":"trig-1","content":"note alpha memo memo143 alpha note521 task","trigger_step":"prior-step"}`
- reproduce: `PARITY_BASH_RETRIEVAL=<abs path to real retrieval> node parity/fuzz/run-fuzz.mjs --tool retrieval --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | yes |
| stderr | | | **NO** |
| status | | | **NO** |
| traj | | | **NO** |
| index | | | yes |
| seen | | | **NO** |

## bash output

```
{
  "stdout": "",
  "stderr": "<ROOT>/thinkers/retrieval/step: line <N>: abc: unbound variable\n",
  "status": 1,
  "traj": "",
  "index": "bar\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nbaz\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nbravo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nfoo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nmemo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nmemo950\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nqux658\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nqux871\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nsummary\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nthing\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\n",
  "seen": "<absent>"
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "",
  "status": 0,
  "traj": "{\"type\":\"observation\",\"content\":\"I'm reminded of memory <HEX>: qux871 a1 bravo qux658 memo bar foo (1 shared words; mem show <HEX> for the full note)\",\"source\":\"retrieval\",\"retrieved_mem\":\"<HEX>\",\"trigger_step\":\"trig-1\"}",
  "index": "bar\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nbaz\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nbravo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nfoo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nmemo\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nmemo950\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nqux658\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nqux871\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nsummary\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\nthing\t<HEX>\tqux871 a1 bravo qux658 memo bar foo\n",
  "seen": "<HEX>\n"
}
```

## Author's reasoning toward a classification

This scenario's field(s) [stderr, status, traj, seen] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `retrieval` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/retrieval/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
