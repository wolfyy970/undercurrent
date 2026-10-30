# skills fuzz finding #2

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `list-json`
- scenario (JSON, strings capped at 2000 chars): `{"group":"list-json","argv":["list-json"],"skillNames":["task-skill-0","x490-skill-1","bravo-skill-2"],"seed":737682055}`
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
  "stdout": "[{\n  \"name\": \"bravo-skill-2\",\n  \"description\": \"\",\n  \"instructions\": \"\\n# bravo-skill-2\\n\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 memo z9 z9930 memo606 z9897 test-name foo x bar note memo265 memo bravo bravo a1243 x alpha\"\n}\n,{\n  \"name\": \"task-skill-0\",\n  \"description\": \"x bravo memo203 my_thing881 foo task\",\n  \"instructions\": \"\\n# task-skill-0\\n\\n--\"\n}\n,{\n  \"name\": \"x490-skill-1\",\n  \"description\": \"baz833 task memo note qux alpha bar210\",\n  \"instructions\": \"\\n# x490-skill-1\\n\\nA\\u007fB\"\n}\n,{\n  \"name\": \"bravo-skill-2\",\n  \"description\": \"\",\n  \"instructions\": \"\\n# bravo-skill-2\\n\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 memo z9 z9930 memo606 z9897 test-name foo x bar note memo265 memo bravo bravo a1243 x alpha\"\n}\n,{\n  \"name\": \"task-skill-0\",\n  \"description\": \"x bravo memo203 my_thing881 foo task\",\n  \"instructions\": \"\\n# task-skill-0\\n\\n--\"\n}\n,{\n  \"name\": \"x490-skill-1\",\n  \"description\": \"baz833 task memo note qux alpha bar210\",\n  \"instructions\": \"\\n# x490-skill-1\\n\\nA\\u007fB\"\n}\n]\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  bravo-skill-2 [755]\nFILE bravo-skill-2/SKILL.md [644] [212B sha=d1f2d68596a2cb95] \"---\\\\nname: bravo-skill-2\\\\ndescription: \\\\n---\\\\n\\\\n# bravo-skill-2\\\\n\\\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 …(+92B)\"\nDIR  task-skill-0 [755]\nFILE task-skill-0/SKILL.md [644] [97B sha=bf911c8a96a272ad] \"---\\\\nname: task-skill-0\\\\ndescription: x bravo memo203 my_thing881 foo task\\\\n---\\\\n\\\\n# task-skill-0\\\\n\\\\n--\\\\n\"\nDIR  x490-skill-1 [755]\nFILE x490-skill-1/SKILL.md [644] [179B sha=389770277336c865] \"---\\\\nname: x490-skill-1\\\\ndescription: baz833 task memo note qux alpha bar210\\\\nmetadata:\\\\n  shelllm:\\\\n    requires:\\\\n    bins: …(+59B)\""
}
```

## ts output

```
{
  "stdout": "[{\n  \"name\": \"bravo-skill-2\",\n  \"description\": \"\",\n  \"instructions\": \"\\n# bravo-skill-2\\n\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 memo z9 z9930 memo606 z9897 test-name foo x bar note memo265 memo bravo bravo a1243 x alpha\"\n}\n,{\n  \"name\": \"task-skill-0\",\n  \"description\": \"x bravo memo203 my_thing881 foo task\",\n  \"instructions\": \"\\n# task-skill-0\\n\\n--\"\n}\n,{\n  \"name\": \"x490-skill-1\",\n  \"description\": \"baz833 task memo note qux alpha bar210\",\n  \"instructions\": \"\\n# x490-skill-1\\n\\nAB\"\n}\n,{\n  \"name\": \"bravo-skill-2\",\n  \"description\": \"\",\n  \"instructions\": \"\\n# bravo-skill-2\\n\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 memo z9 z9930 memo606 z9897 test-name foo x bar note memo265 memo bravo bravo a1243 x alpha\"\n}\n,{\n  \"name\": \"task-skill-0\",\n  \"description\": \"x bravo memo203 my_thing881 foo task\",\n  \"instructions\": \"\\n# task-skill-0\\n\\n--\"\n}\n,{\n  \"name\": \"x490-skill-1\",\n  \"description\": \"baz833 task memo note qux alpha bar210\",\n  \"instructions\": \"\\n# x490-skill-1\\n\\nAB\"\n}\n]\n",
  "stderr": "",
  "status": 0,
  "state": "DIR  bravo-skill-2 [755]\nFILE bravo-skill-2/SKILL.md [644] [212B sha=d1f2d68596a2cb95] \"---\\\\nname: bravo-skill-2\\\\ndescription: \\\\n---\\\\n\\\\n# bravo-skill-2\\\\n\\\\nbar note150 qux foo374 bar202 z9648 bar a1538 z9604 task140 …(+92B)\"\nDIR  task-skill-0 [755]\nFILE task-skill-0/SKILL.md [644] [97B sha=bf911c8a96a272ad] \"---\\\\nname: task-skill-0\\\\ndescription: x bravo memo203 my_thing881 foo task\\\\n---\\\\n\\\\n# task-skill-0\\\\n\\\\n--\\\\n\"\nDIR  x490-skill-1 [755]\nFILE x490-skill-1/SKILL.md [644] [179B sha=389770277336c865] \"---\\\\nname: x490-skill-1\\\\ndescription: baz833 task memo note qux alpha bar210\\\\nmetadata:\\\\n  shelllm:\\\\n    requires:\\\\n    bins: …(+59B)\""
}
```

## Shrink

- oracle calls: 1
- minimal argv: `["list-json"]`
- original argv: `["list-json"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `skills` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/skills/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
