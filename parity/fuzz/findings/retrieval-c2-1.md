# retrieval fuzz triage — campaign #2, root cause 1

- classification: **PORT-BUG**
- confidence: high
- instances: 7 (`retrieval-2.md`, `retrieval-3.md`, `retrieval-4.md`
  [campaign #1, pre-bug-#45-fix captures — see "Status of the old findings"
  below]; `retrieval-5.md`, `retrieval-6.md`, `retrieval-7.md`,
  `retrieval-8.md` [campaign #2, seed base 2, tool sub-seed 2945991233,
  `--count 400`]); group `retrieval`, env `RETRIEVAL_MIN_HITS=abc` in every
  case.

## Reproduce

A retrieval trigger whose content shares NO words with any seeded memory
(so the index lookup's best-candidate `mid` is empty), with
`RETRIEVAL_MIN_HITS=abc` set. Minimal shape from `retrieval-5.md`: a
`manual`-type trigger with content that doesn't overlap any seeded memory's
tokenized words, env `{"RETRIEVAL_MIN_HITS":"abc","RETRIEVAL_SEEN":"-1"}`.

## Upstream vs port

- bash: exit 0, empty stderr, index/seen state as expected — the script
  never touches `$RETRIEVAL_MIN_HITS` at all.
- port: exit 1, stderr `retrieval: RETRIEVAL_MIN_HITS: unbound variable`.

## Root cause

`thinkers/retrieval/step:60` uses a short-circuiting `&&` inside a single
`[[ ]]` test:
```bash
[[ -n "${mid:-}" && "${hits:-0}" -ge "${RETRIEVAL_MIN_HITS:-2}" ]] || exit 0
```
When no candidate memory matched (`mid` is empty), `[[ ]]`'s `&&` short-
circuits and the script NEVER evaluates `"${hits:-0}" -ge
"${RETRIEVAL_MIN_HITS:-2}"` — so a bareword `RETRIEVAL_MIN_HITS` value is
never looked up as an arithmetic operand, and the "unbound variable" crash
(bug #45's fix target) simply cannot happen when `mid` is empty. Bash exits
0 cleanly via `|| exit 0`.

Bug #45's fix (`src/retrieval.ts:446-450`) validates `RETRIEVAL_MIN_HITS`
for bareword-ness UNCONDITIONALLY, before ever checking `best`/`best.mid`:
```ts
const minHitsRaw = env["RETRIEVAL_MIN_HITS"];
if (minHitsRaw !== undefined && minHitsRaw !== "" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(minHitsRaw)) {
  io.stderr(`retrieval: RETRIEVAL_MIN_HITS: unbound variable\n`);
  return { code: 1, ... };
}
const minHits = intKnob(minHitsRaw, 2);
if (minHits === undefined) return noop(...);
if (!best || best.mid === "" || best.hits < minHits) return noop(...);
```
The bareword check runs BEFORE the `best.mid === ""` check three lines
down — the exact inverse of bash's short-circuit order. So the port now
crashes even in the case bash's own `&&` short-circuit was specifically
written to skip.

This also has a masking side effect: `retrieval-6.md` and `retrieval-8.md`
additionally show an `index`-field mismatch (a memory summary containing a
literal two-character `\n`/`\t` sequence tokenizes differently — the
ALREADY-documented `isRetrievalAwkVFamily` deviation, PARITY.md retrieval
row). That allowance's guard (`lib/allowances.mjs`) requires `exitMatch &&
stdoutMatch` before it will fire; this bug's spurious exit-1 breaks
`exitMatch`, so the pre-existing, already-accepted `awk-v` deviation can't
be recognized either, and both problems get reported together as one raw
divergence.

## Status of the old findings (`retrieval-2/3/4.md`)

These three predate bug #45's fix and capture the OPPOSITE, already-fixed
scenario (`mid` non-empty, matching trigger, bash crashes with `<script>:
line 60: abc: unbound variable`, port used to exit 0 silently). Re-run
today, that scenario now matches on exit code and is covered by the
existing `isBashLineWordingDeviation` allowance (only the `: line N:`
wording differs) — they are superseded/resolved, not open. They're
included here because their file names were still marked
`UNCLASSIFIED — needs human triage` on disk.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

In `src/retrieval.ts`, reorder the two checks so the bareword-`MIN_HITS`
validation only runs when a candidate exists, mirroring bash's
short-circuit exactly: check `!best || best.mid === ""` (→ `noop`) BEFORE
looking at `RETRIEVAL_MIN_HITS` at all.
