# skills fuzz triage — campaign #2, root cause 1

- classification: **PORT-BUG**
- confidence: high
- instances: 2 (`skills-2.md`, `skills-3.md`; seed base 2, tool sub-seed
  3003359985, `--count 400`); group `list-json`, in both cases a skill
  whose `SKILL.md` body contains a raw DEL byte (0x7F).

## Reproduce

```
mkdir -p .skills/x/  # SKILL.md body containing a literal 0x7F byte, e.g. "A<DEL>B"
<HEADLONG_ROOT>/bin/skills list-json
node bin/skills.mjs list-json
```

## Upstream vs port

Both sides read the identical on-disk `SKILL.md` (same sha), same skill
list, same exit code (0), same stderr (empty) — only the JSON `instructions`
string's encoding of the 0x7F byte differs:
- bash (`jq`-built): `"...A\u007fB"` (byte-escaped)
- port (`JSON.stringify`): `"...A<raw 0x7F byte>B"` (byte passed through,
  unescaped — confirmed with `od`/`python3 -c` on the raw finding file)

Both are technically valid JSON (the JSON spec only forbids UNESCAPED
U+0000–U+001F; U+007F is not in that range), but the two outputs are
byte-for-byte different, which is what this lane compares.

## Root cause

`src/skills.ts`'s `list-json` builder (~line 764) serializes each skill
object with plain `JSON.stringify(obj, null, 2)`, which does not escape
0x7F. Bash's `list-json` is built with `jq`, which DOES escape 0x7F as
`\u007f`. This is the exact same class of divergence already fixed for
`llm` (PARITY.md's llm-slice-1 "F13 U+007F" row: "every JSON the tool
writes ... escapes DEL as `\u007f`, as jq prints it") — `llmCli.ts` was
given custom DEL-escaping logic to match jq's behavior there, but that fix
was never applied to `skills.ts`'s own JSON output path, so the same gap
persists in a second tool.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

Reuse whatever escaping helper `llmCli.ts` uses for its F13 fix (or extract
it to a shared helper) in `src/skills.ts`'s `list-json` JSON serialization,
so 0x7F (and any other jq-escaped-but-JSON.stringify-passthrough byte) is
escaped identically to bash's `jq`-built output.
