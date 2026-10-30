# Rollups parity — deterministic envelope (TS port vs real Headlong)

_Generated 2026-08-29T16:16:56.589Z · Node v24.19.0 · traj `55fd5932-root` · reference high-water 1188 raw lines → 252 filtered steps_

Parity is asserted on the DETERMINISTIC ENVELOPE only — which filtered-step ranges seal into which tier blocks, the absolute-range file keys, and the staircase tier/raw-tail SELECTION. The LLM-generated summary / themes prose is excluded (non-deterministic); the block files are read verbatim from disk on both sides.

**Overall: 19/19 checks pass (100%).**

## A. Render differential — TS `renderSteps` vs Bash `rendered.tsv`

Result: **PASS** — 252/252 rows, 0 field mismatch(es).

The real trajectory's 1188-line render high-water mark is fed through the TS filter and compared field-by-field (raw_line · step_id · ts · text · epoch_min) against the `rendered.tsv` the Bash `_render_steps` wrote. Byte-for-byte identity here fixes the filtered-step INDEX space that every block range is defined over.

## B. Block-plan differential — TS `buildPlan` vs on-disk sealed blocks

Result: **PASS** (derived n=252 from the render above, not hard-coded).

| check | ok | detail |
| --- | --- | --- |
| t1 has 25 sealed blocks | ✅ | 25 |
| t2 has 2 sealed blocks | ✅ | 2 |
| buildPlan(252,0) block set == on-disk block set | ✅ | 27 keys identical |
| block set stable at full log (n=253) | ✅ | full=27 keys |
| every filename encodes its own absolute [start,end) range | ✅ |  |
| every block n = end − start = F^tier | ✅ |  |
| every block's tier field matches its dir | ✅ |  |
| every block stamped prompt_version=2 | ✅ |  |
| every block carries the sealed-block schema (non-empty step_ids) | ✅ |  |
| t1 tiles [0,250) contiguously | ✅ |  |
| t2 tiles [0,200) contiguously | ✅ |  |
| meta.json start_index is F-aligned | ✅ | start_index=0 |

## C. Staircase differential — real `recap --context --cached` (Bash) vs TS `recapContext`

Result: **6/6 scenarios at structural PARITY.**

Both sides assemble over the SAME scratch copy of the trajectory + sealed blocks. The TS summarizer is a throwing stub, proving cached mode never calls the LLM. Structure compared: selected tier/range blocks (+ order + cited ids), raw-tail step count (n − cut0, F-snapped), and the full raw-tail step-id sequence. `full_text_identical` (summary prose included) is recorded as supporting evidence — it holds because both read the identical frozen block JSON.

| rawTail | selection | tail | ids✓ | tailCt✓ | tailIds✓ | text≡ | parity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | t2[0,100) t2[100,200) | 52 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 60 | t2[0,100) t1[100,110) t1[110,120) t1[120,130) t1[130,140) t1[140,150) t1[150,160) t1[160,170) t1[170,180) t1[180,190) | 62 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 20 | t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230) | 22 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230) t1[230,240) | 12 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 252 | (none) | 252 | ✅ | ✅ | ✅ | ✅ | ✅ |
| auto | t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230) | 22 | ✅ | ✅ | ✅ | ✅ | ✅ |

Notes per scenario:
- `rawTail=50` — clean t2 boundary (cut0=200) → `t2[0,100) t2[100,200)` + last 52 verbatim.
- `rawTail=60` — staircase t2+9·t1 (cut0=190, tail=62) → `t2[0,100) t1[100,110) t1[110,120) t1[120,130) t1[130,140) t1[140,150) t1[150,160) t1[160,170) t1[170,180) t1[180,190)` + last 62 verbatim.
- `rawTail=20` — mixed t2+t2+3·t1 (cut0=230) → `t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230)` + last 22 verbatim.
- `rawTail=5` — explicit R below auto-floor (cut0=240) → `t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230) t1[230,240)` + last 12 verbatim.
- `rawTail=252` — R=n → all-raw, no life section (cut0=0) → `(no life section)` + last 252 verbatim.
- `rawTail=auto` — auto budget → R=20 via model window+cap → `t2[0,100) t2[100,200) t1[200,210) t1[210,220) t1[220,230)` + last 22 verbatim.

## Reproduce

```
. ~/.nvm/nvm.sh && nvm use 24.19.0
node parity/rollups/run-parity.mjs
```
