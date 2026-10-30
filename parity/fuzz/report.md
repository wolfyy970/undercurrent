# parity/fuzz — L1 differential fuzz report

Seed base: `2`. Run `node parity/fuzz/run-fuzz.mjs --tool <name> --seed 2 ...` to reproduce any single tool's stream (each tool derives its own sub-seed from the base + its name, printed below).

| tool | generated | identical | allowed (documented) | DIVERGE (findings) | errors | seed | time |
|---|---|---|---|---|---|---|---|
| chat | 400 | 377 | 23 | 0 | 0 | 4083835749 | 39.3s |
| context | 400 | 349 | 49 | 2 | 0 | 642250210 | 44.8s |
| focus | 400 | 400 | 0 | 0 | 0 | 209948125 | 34.4s |
| glob | 400 | 384 | 14 | 2 | 0 | 1972191973 | 101.1s |
| identity | 400 | 370 | 0 | 30 | 0 | 3773167109 | 46.1s |
| killall | 400 | 400 | 0 | 0 | 0 | 2823887230 | 174.0s |
| llm | 400 | 259 | 126 | 15 | 0 | 3753365250 | 70.6s |
| mem | 400 | 368 | 32 | 0 | 0 | 1322544184 | 443.1s |
| recap | 400 | 390 | 7 | 3 | 0 | 4032813354 | 342.0s |
| retrieval | 400 | 252 | 144 | 4 | 0 | 2945991233 | 76.4s |
| skills | 400 | 399 | 0 | 1 | 0 | 3003359985 | 53.8s |
| traj | 400 | 384 | 8 | 8 | 0 | 2111378778 | 40.4s |

## Concurrency lane

| tool | n | bash invariant | ts invariant | match |
|---|---|---|---|---|

## Findings

- [context] `parity/fuzz/findings/context-1.md` — group `context`, fields: stderr,status
- [context] `parity/fuzz/findings/context-2.md` — group `context`, fields: stderr,status
- [glob] `parity/fuzz/findings/glob-1.md` — group `limit`, fields: stderr
- [glob] `parity/fuzz/findings/glob-2.md` — group `none`, fields: stderr
- [identity] `parity/fuzz/findings/identity-2.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-3.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-4.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-5.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-6.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-7.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-8.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-9.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-10.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-11.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-12.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-13.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-14.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-15.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-16.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-17.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-18.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-19.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-20.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-21.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-22.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-23.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-24.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-25.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-26.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-27.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-28.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-29.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-30.md` — group `list`, fields: stdout,stderr,status
- [identity] `parity/fuzz/findings/identity-31.md` — group `list`, fields: stdout,stderr,status
- [llm] `parity/fuzz/findings/llm-4.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-5.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-6.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-7.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-8.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-9.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-10.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-11.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-12.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-13.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-14.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-15.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-16.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-17.md` — group `closed-port`, fields: stderr
- [llm] `parity/fuzz/findings/llm-18.md` — group `closed-port`, fields: stderr
- [recap] `parity/fuzz/findings/recap-1.md` — group `recap`, fields: stderr
- [recap] `parity/fuzz/findings/recap-2.md` — group `recap`, fields: stderr
- [recap] `parity/fuzz/findings/recap-3.md` — group `recap`, fields: stderr
- [retrieval] `parity/fuzz/findings/retrieval-5.md` — group `retrieval`, fields: stderr,status
- [retrieval] `parity/fuzz/findings/retrieval-6.md` — group `retrieval`, fields: stderr,status,index
- [retrieval] `parity/fuzz/findings/retrieval-7.md` — group `retrieval`, fields: stderr,status
- [retrieval] `parity/fuzz/findings/retrieval-8.md` — group `retrieval`, fields: stderr,status,index
- [skills] `parity/fuzz/findings/skills-2.md` — group `list-json`, fields: stdout
- [traj] `parity/fuzz/findings/traj-3.md` — group `show`, fields: stdout,stderr,status
- [traj] `parity/fuzz/findings/traj-4.md` — group `fork`, fields: state
- [traj] `parity/fuzz/findings/traj-5.md` — group `search`, fields: stderr
- [traj] `parity/fuzz/findings/traj-6.md` — group `fork`, fields: stdout,stderr,status,state
- [traj] `parity/fuzz/findings/traj-7.md` — group `search`, fields: stderr
- [traj] `parity/fuzz/findings/traj-8.md` — group `last`, fields: stderr
- [traj] `parity/fuzz/findings/traj-9.md` — group `search`, fields: stderr
- [traj] `parity/fuzz/findings/traj-10.md` — group `tail`, fields: stdout

## Campaign #1 closure (seed base 1, `--count 150`, every tool still present)

Re-run against the new upstream pin (`5458fee`) to confirm the classes
fixed as bugs #40-#51 do not reproduce. `focus`/`glob`/`put`/`sub`/`view`
are retired (upstream 12ca841) and excluded; `sub` was also excluded from
the campaign #2 remainder per this campaign's scope. Full per-tool table
(this run's own `results.json` snapshot is not kept alongside the seed-2
one above — see `parity/fuzz/findings/*-c2-*.md` for the triaged
divergences it produced):

| tool | generated | identical | allowed (documented) | DIVERGE (findings) | errors | seed | time |
|---|---|---|---|---|---|---|---|
| chat | 150 | 138 | 11 | 1 | 0 | 2342144158 | 20.3s |
| context | 150 | 134 | 16 | 0 | 0 | 1358713611 | 12.3s |
| identity | 150 | 150 | 0 | 0 | 0 | 3994543162 | 10.9s |
| killall | 150 | 150 | 0 | 0 | 0 | 1964435963 | 38.7s |
| llm | 150 | 89 | 57 | 4 | 0 | 2518219431 | 17.9s |
| mem | 150 | 137 | 13 | 0 | 0 | 108229897 | 180.6s |
| recap | 150 | 146 | 4 | 0 | 0 | 2144273935 | 27.4s |
| retrieval | 150 | 102 | 48 | 0 | 0 | 2401176564 | 21.6s |
| skills | 150 | 149 | 0 | 1 | 0 | 4183279298 | 24.3s |
| traj | 150 | 145 | 1 | 4 | 0 | 534514473 | 31.6s |

**Bugs #40-#51 closure result**: bugs #40, #41, #42, #44, #47, #48, #49,
#51 do NOT reproduce at seed 1 (identity 0/150 diverge confirms #41/#49;
mem 0/150 diverge confirms #44; chat's and traj's sole jq-wording
divergences match #47/#48's already-accepted exit-code-matches family, see
`chat-c2-1.md`/`traj-c2-1.md`). #43/#45/#46 belong to retired tools
(view/put) except #45 (retrieval), whose ORIGINAL scenario (a matching
candidate + bareword `RETRIEVAL_MIN_HITS`) also does not reproduce — BUT
this campaign found a related, previously-unseen SIBLING bug in the same
code path (bareword check fires even with no candidate, where bash's own
short-circuit never reaches it) — see `retrieval-c2-1.md`. This is a new
finding adjacent to #45's fix, not a regression of #45 itself.

## Triage index (this session)

Every unclassified divergence from both campaigns, grouped by root cause,
is written under `parity/fuzz/findings/<tool>-c2-N.md`:

- `chat-c2-1.md` — documented-deviation (bug #47 family)
- `llm-c2-1.md` — harness-artifact (CLOSED_URL port 9 on Fetch blocklist)
- `llm-c2-2.md` — PORT-BUG (adapter-path check-order)
- `recap-c2-1.md` — harness-artifact (BSD `head -n 0` on this macOS host)
- `retrieval-c2-1.md` — PORT-BUG (MIN_HITS short-circuit order)
- `skills-c2-1.md` — PORT-BUG (0x7F not escaped in `list-json`)
- `traj-c2-1.md` — documented-deviation (bug #48 family)
- `traj-c2-2.md` — PORT-BUG (fork `parent_traj` "null" vs "")
- `traj-c2-3.md` — PORT-BUG (fork doesn't validate malformed trajectory)
- `traj-c2-4.md` — PORT-BUG (`show` prints "undefined" on malformed row)
- `traj-c2-5.md` — PORT-BUG (`tail -n` negative count mishandled)

`context-c2-1.md` (upstream-crash), `glob-c2-1.md` (harness-artifact), and
`identity-c2-1.md` (PORT-BUG, bug #49's exact gap — now fixed and
confirmed non-reproducing at seed 1) predate this session.
