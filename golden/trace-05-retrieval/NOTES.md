# trace-05: the retrieval thinker live (passive recall + reactive monolith wakes)

Captured from real pax (Bash Headlong, DeepSeek/OpenRouter, 2026-08-28), the window in
which pax enabled the bundled-but-disabled `retrieval` thinker on itself and it ran:
root trajectory rows 676-856 (16:32:32Z-16:41:35Z), the dispatcher log's `retrieval`
lines, the thinker's state files, and the 14 memories its word index was built over.
Retrieval is deterministic and has NO LLM, so this trace is a true oracle: the port
replays it (test/retrieval.test.ts "golden/trace-05-retrieval") and the differential
harness (parity/retrieval) runs the real Bash step and the port over these memories.

## Files
- `trajectory-rows-676-856.jsonl` — 181 rows: 5 `observation[retrieval]` steps and the
  4 monolith wakes they caused (`wake:"reactive/observation:retrieval"`, `trigger_step`
  = the observation's step_id), interleaved with the monolith's own spontaneous wakes.
- `dispatcher-log-retrieval-lines.txt` — every line of `run/logs/dispatcher.log` that
  names `retrieval` (67 of 1330): `dispatch -> retrieval`, `step: … source=retrieval`,
  `skip retrieval (self-trigger)`, and the busy semantics (`type=observation, coalesced`
  vs `type=message, queued=1`). The log runs on past row 856 (to 16:53Z).
- `memories/` — the 14 `.md` memories (scrubbed, see below).
- `index.tsv` — the word index (`word\tid\tsummary`, `sort -u`), see "Regenerated".
- `seen` — the seen ring, verbatim: the 5 surfaced ids, oldest first.

## What happened, by row
- 676 observation[retrieval] → 9096b22d, `trigger_step:"probe-…"`, **with a run_id** —
  a PROBE ARTIFACT: the monolith (run 0966d708) drove `thinkers/retrieval/step` by hand
  from inside its own wake (rows 672-675 compose a synthetic step JSON in /tmp and pipe
  it in), so `traj append` auto-linked `SHELLM_RUN_STEP_ID`. The dispatcher still saw
  the observation (log 16:32:32 `pending -> monolith (type=observation, coalesced)`) and
  woke the monolith reactively at 683. Not a dispatcher-fired retrieval; its trigger
  content is not in this window.
- 715 observation[monolith] → 716 observation[retrieval] → 6f5578dc (7 shared words) →
  723 `reactive/observation:retrieval` wake. Log 16:35:22: `dispatch -> retrieval`,
  `step: type=observation source=retrieval`, `skip retrieval (self-trigger)`.
- 771 thought[monolith] → 772 → ada0635d (4) → 776 wake.
- 806 observation[monolith] → 810 → 53308418 (15) → 811 wake (16:39:47).
- 853 observation[monolith] → 856 → d4eaba71 (20) — the window ends there; the wake it
  caused (log 16:41:35) is past row 856.
- Rows 715/771/806/853 are MONOLITH-written steps (via the `traj` shim) — upstream's file
  bus delivers them to retrieval. The port's in-process bus does not see shim appends
  (dispatcher.ts fidelity note), so in the port topology those triggers would not wake
  retrieval; the replay test drives the step with them directly.

## Scrubbing (same rules as the release's PII pass, commit bd538d0)
`<HEADLONG_ROOT>` for the checkout, `<PROJECT>` for the parent project dir, `<HOME>` for
the home dir (and its truncated fragments), the operator's name → `the operator` (also
where it appears as a slug segment in two memory filenames → `-the-operator`), the other
app's codename → `otherbot` (also in two filenames, and its 80-char-truncated fragment at
the end of one summary). JSON rows re-validated after scrubbing. No home-dir, project,
user, codename, email, or key strings remain (grep-proofed by the generator).

## Regenerated: index.tsv
The scrub changes tokens (the codename becomes the token `otherbot`, which sorts
elsewhere; the operator's two-letter name was never a token but its replacement adds the
word `operator`), so the captured index cannot be scrubbed in place and stay a valid
`sort -u` index. The shipped `index.tsv` is the REAL Bash builder's output over the
scrubbed memories: `LC_ALL=C thinkers/retrieval/build-index.sh memories/ index.tsv` →
**462 rows**. The captured original was 460 rows (md5 7d1d8fa57a0bfffb07c1349a070795a0);
the port's builder reproduces THAT file byte-for-byte too (verified out of band against
the unscrubbed identity), and reproduces this one in test/retrieval.test.ts.

## Replay caveat: row 856 (d4eaba71)
Memory d4eaba71 was `mem edit`ed at 16:42, one minute AFTER row 856 — its file (mtime
16:42) and every index row carry the edited summary (`… 16:41 (CORRECTED): the runtime
IS in the …`), while row 856 quotes the pre-edit summary (`… 16:41: headlong/ repo = 11
skills + READM`) with 20 shared words. Over the shipped corpus the same trigger yields
the edited summary with 13 shared words; retrieved_mem, trigger_step, and the seen
ring still match. Rows 716/772/810 replay byte-identically (modulo step_id/ts). Out of
band, against the unscrubbed identity: 3/4 exact, the 4th differing only as above.

## The lesson (load-bearing)
Retrieval is the one thinker that is pure function + files: tokenize → word overlap →
seen ring → append. Its damping is the seen ring (20) plus the ≥2-distinct-words
threshold; its coupling to the mind is only that its observation is an external-source
step, so the monolith's `trigger_self:false` subscription wakes reactively on it. Nothing
here needs an LLM, a sandbox, or Docker — which is why this trace can be an exact oracle.
