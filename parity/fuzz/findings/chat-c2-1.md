# chat fuzz triage — campaign #1 closure, root cause 1

- classification: **documented-deviation** (PARITY.md "chat history --since
  bogus" row, bug #47, jq-internal-error allowance)
- confidence: high
- instances: 1 (`chat-2.md`; seed base 1, tool sub-seed 2342144158,
  `--count 150`); group `history`, argv `["history","--with","bob","--since","bogus"]`.

## Reproduce

```
<HEADLONG_ROOT>/bin/chat history --with bob --since bogus   # against a seeded 2-message trajectory
node bin/chat.mjs history --with bob --since bogus
```

## Upstream vs port

- bash: `jq: invalid JSON text passed to --argjson` + jq's own multi-line
  usage banner, exit 2
- port: `chat: error: history: --since bogus: invalid duration`, exit 2

Exit codes match exactly (2 = 2); only jq's own diagnostic wording differs
from the port's clean message.

## Root cause

This is precisely bug #47 (PARITY.md, "chat history --since bogus: matches
jq's exit code, not its exact text"): `cmdHistoryIndexed`'s `--since`
handling was fixed to match bash's exit code (2) for an unparseable
duration, using the port's own clean error text instead of relaying jq's
literal parse-error banner — the same jq-internal-error family already
accepted for bug #48 (traj, see `traj-c2-1.md`). PARITY.md calls this a
"jq-internal-error allowance," but — like the traj case — no coded
predicate for it actually exists in `parity/fuzz/lib/allowances.mjs` (only
categories 1, 5, and 6 are implemented there; see that file's header). So
every fuzz run that draws this exact scenario will keep surfacing it as a
fresh "unclassified" finding even though the underlying behavior has been
correct (and intentionally accepted) since bug #47 landed.

## Recommendation

No src/ change (bug #47 is already fixed and confirmed non-regressed:
exit code matches). Flagging the missing coded allowance (shared with
`traj-c2-1.md`'s bug #48 family) as a harness-fix candidate for a future
lane with its own test — out of this lane's authority to add unilaterally.
