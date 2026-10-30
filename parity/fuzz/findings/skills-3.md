# skills fuzz finding #3

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `list-json`
- scenario (JSON, strings capped at 2000 chars): `{"group":"list-json","argv":["list-json"],"skillNames":["memo-skill-0","qux-skill-1","alpha-skill-2"],"seed":2120709894}`
- argv/trigger: `["list-json"]`
- reproduce: `PARITY_BASH_SKILLS=<abs path to real skills> node parity/fuzz/run-fuzz.mjs --tool skills --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | yes |
| status | | | yes |
| state | | | yes |

## bash output

```
{
  "stdout": "[{\n  \"name\": \"alpha-skill-2\",\n  \"description\": \"task723 note test-name task note note bravo task142 bar z9126\",\n  \"instructions\": \"\\n# alpha-skill-2\\n\\nbravo bar memo663 memo683 note foo foo test-name note66 my_thing foo qux a1 bar my_thing note165 foo145 z9835 qux578\"\n}\n,{\n  \"name\": \"memo-skill-0\",\n  \"description\": \"foo bar task note609 a1508 x a1708\",\n  \"instructions\": \"\\n# memo-skill-0\\n\\nA\\u007fB\"\n}\n,{\n  \"name\": \"qux-skill-1\",\n  \"description\": \"task baz foo950\",\n  \"instructions\": \"\\n# qux-skill-1\\n\\ntest-name bravo170 task370 bravo879 note bar memo memo\"\n}\n,{\n  \"name\": \"alpha-skill-2\",\n  \"description\": \"task723 note test-name task note note bravo task142 bar z9126\",\n  \"instructions\": \"\\n# alpha-skill-2\\n\\nbravo bar memo663 memo683 note foo foo test-name note66 my_thing foo qux a1 bar my_thing note165 foo145 z9835 qux578\"\n}\n,{\n  \"name\": \"memo-skill-0\",\n  \"description\": \"foo bar task note609 a1508 x a1708\",\n  \"instructions\": \"\\n# memo-skill-0\\n\\nA\\u007fB\"\n}\n,{\n  \"name\": \"qux-skill-1\",\n  \"description\": \"task baz foo950\",\n  \"instructions\": \"\\n# qux-skill-1\\n\\ntest-name bravo170 task370 bravo879 note bar memo memo\"\n}\n]\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  alpha-skill-2 [755]\nFILE alpha-skill-2/SKILL.md [644] [238B sha=05e38ef440cbb5cc] \"---\\\\nname: alpha-skill-2\\\\ndescription: task723 note test-name task note note bravo task142 bar z9126\\\\n---\\\\n\\\\n# alpha-skill-2\\\\n…(+118B)\"\nDIR  memo-skill-0 [755]\nFILE memo-skill-0/SKILL.md [644] [96B sha=c4ef0b84074fbefa] \"---\\\\nname: memo-skill-0\\\\ndescription: foo bar task note609 a1508 x a1708\\\\n---\\\\n\\\\n# memo-skill-0\\\\n\\\\nA\\\\x7fB\\\\n\"\nDIR  qux-skill-1 [755]\nFILE qux-skill-1/SKILL.md [644] [126B sha=9fd6b191ac53d637] \"---\\\\nname: qux-skill-1\\\\ndescription: task baz foo950\\\\n---\\\\n\\\\n# qux-skill-1\\\\n\\\\ntest-name bravo170 task370 bravo879 note bar memo…(+6B)\""
}
```

## ts output

```
{
  "stdout": "[{\n  \"name\": \"alpha-skill-2\",\n  \"description\": \"task723 note test-name task note note bravo task142 bar z9126\",\n  \"instructions\": \"\\n# alpha-skill-2\\n\\nbravo bar memo663 memo683 note foo foo test-name note66 my_thing foo qux a1 bar my_thing note165 foo145 z9835 qux578\"\n}\n,{\n  \"name\": \"memo-skill-0\",\n  \"description\": \"foo bar task note609 a1508 x a1708\",\n  \"instructions\": \"\\n# memo-skill-0\\n\\nAB\"\n}\n,{\n  \"name\": \"qux-skill-1\",\n  \"description\": \"task baz foo950\",\n  \"instructions\": \"\\n# qux-skill-1\\n\\ntest-name bravo170 task370 bravo879 note bar memo memo\"\n}\n,{\n  \"name\": \"alpha-skill-2\",\n  \"description\": \"task723 note test-name task note note bravo task142 bar z9126\",\n  \"instructions\": \"\\n# alpha-skill-2\\n\\nbravo bar memo663 memo683 note foo foo test-name note66 my_thing foo qux a1 bar my_thing note165 foo145 z9835 qux578\"\n}\n,{\n  \"name\": \"memo-skill-0\",\n  \"description\": \"foo bar task note609 a1508 x a1708\",\n  \"instructions\": \"\\n# memo-skill-0\\n\\nAB\"\n}\n,{\n  \"name\": \"qux-skill-1\",\n  \"description\": \"task baz foo950\",\n  \"instructions\": \"\\n# qux-skill-1\\n\\ntest-name bravo170 task370 bravo879 note bar memo memo\"\n}\n]\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  alpha-skill-2 [755]\nFILE alpha-skill-2/SKILL.md [644] [238B sha=05e38ef440cbb5cc] \"---\\\\nname: alpha-skill-2\\\\ndescription: task723 note test-name task note note bravo task142 bar z9126\\\\n---\\\\n\\\\n# alpha-skill-2\\\\n…(+118B)\"\nDIR  memo-skill-0 [755]\nFILE memo-skill-0/SKILL.md [644] [96B sha=c4ef0b84074fbefa] \"---\\\\nname: memo-skill-0\\\\ndescription: foo bar task note609 a1508 x a1708\\\\n---\\\\n\\\\n# memo-skill-0\\\\n\\\\nA\\\\x7fB\\\\n\"\nDIR  qux-skill-1 [755]\nFILE qux-skill-1/SKILL.md [644] [126B sha=9fd6b191ac53d637] \"---\\\\nname: qux-skill-1\\\\ndescription: task baz foo950\\\\n---\\\\n\\\\n# qux-skill-1\\\\n\\\\ntest-name bravo170 task370 bravo879 note bar memo…(+6B)\""
}
```

## Shrink

- oracle calls: 1
- minimal argv: `["list-json"]`
- original argv: `["list-json"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `skills` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/skills/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
