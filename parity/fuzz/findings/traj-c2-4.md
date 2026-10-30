# traj fuzz triage — campaign #2, root cause 4

- classification: **PORT-BUG**
- confidence: high
- instances: 1 (`traj-3.md`; seed base 2, tool sub-seed 2111378778,
  `--count 400`); group `show`, argv `["show","12345678"]` against a
  trajectory whose only content is the fixed malformed line
  `not-json-at-all{{{`.

## Reproduce

```
printf 'not-json-at-all{{{\n' > trajectory.jsonl
<HEADLONG_ROOT>/bin/traj show 12345678 --traj_dir .
node bin/traj.mjs show 12345678 --traj_dir .
```

## Upstream vs port

- bash: `jq: parse error: Invalid numeric literal at line 1, column 16`,
  exit 5, empty stdout
- port: exit 0, stdout literally `undefined\n`

This is worse than the accepted "jq-internal-error" family in
`traj-c2-1.md` (exit code matches, only stderr text differs): here the
port doesn't fail at all, and prints the JavaScript string `"undefined"` —
a symptom of a lookup that returned `undefined` being coerced straight to
a string and printed, rather than being treated as "not found"/invalid
input.

## Root cause

`cmd show`'s upstream implementation pipes the target line through `jq`
unconditionally, and the malformed line makes jq crash immediately (same
mechanism as bug #48). The port's `show` handler, presented with the same
unparseable line, must be doing something like `JSON.parse(line)?.someField`
or an array `.find(...)` that resolves to `undefined`, then formatting/
printing that value without checking for `undefined` first — producing the
literal text `undefined` and exiting 0 instead of surfacing a clean
"invalid JSON"/"not found" error the way bug #48's `last`/`search` fix now
does.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

Apply the same fix pattern as bug #48 to `cmdShow` (`src/trajCli.ts`): if
the target line (or any line `show` must parse to find it) fails
`JSON.parse`, die with the port's own clean "invalid JSON" message and a
non-zero exit code (bash's real exit code is 5, matching the jq-crash
family) instead of falling through to print `undefined`.
