# view fuzz finding #13 — trailing-space numeric flag value rejected

- classification: **PORT-BUG (high confidence)**
- group: `offset-limit`
- argv: `["f.txt", "--limit", "5 "]` (trailing space in the flag value),
  `f.txt` seeded with 5 short lines
- reproduce:
  ```
  printf 'line 1\nline 2\nline 3\nline 4\nline 5\n' > f.txt
  <HEADLONG_ROOT>/bin/view f.txt --limit "5 "   # prints all 5 lines, exit 0
  node bin/view.mjs f.txt --limit "5 "          # dies, exit 1
  ```

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | 5 numbered lines | (empty) | **NO** |
| stderr | (empty) | `view: end line (0) is before start line (1)` | **NO** |
| status | 0 | 1 | **NO** |

## Root cause

Bash's arithmetic evaluation of `--limit`'s value tolerates a trailing
space in `"5 "` (shell word-splitting/arithmetic coercion treats it as 5).
`src/view.ts`'s `arithInt()` (PORT-NOTE: "a plain optionally-signed decimal
integer, else 0") uses a strict regex `/^[+-]?[0-9]+$/` against the raw
token, which a trailing space fails — falling back to the "Bash unset-word"
0 case. That 0 then propagates into the start/end line computation, and
`endLine=0` ends up before `startLine=1`, dying with the guard message. Bash
and the port likely intend the SAME 0-means-"unset" semantics for a token
that ISN'T a clean integer, but Bash's shell-level coercion is more
permissive about surrounding whitespace than the port's strict regex.

## Duplicates

~19 of view's findings (all shrink to `["{FILE}", "--offset"|"--limit",
<value with a leading/trailing space, e.g. "5 ", " 5", "10x", "abc">]`) are
this family — a non-integer-but-whitespace-adjacent numeric flag value.
Some of these (pure non-numeric strings like `"abc"`) may be intentional
"treat as unset" behavior on both sides; the SPECIFIC divergence is only
where Bash's coercion succeeds (numeric prefix ± whitespace) but the port's
strict regex fails on the same input.
