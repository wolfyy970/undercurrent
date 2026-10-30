# recap fuzz triage — campaign #2, root cause 1

- classification: **harness-artifact**
- confidence: high
- instances: 3 (`recap-1.md`, `recap-2.md`, `recap-3.md`; seed base 2, tool
  sub-seed 4032813354, `--count 400`); group `recap`, argv `["--context"]`
  against a 0-step (empty) trajectory in every case.

## Reproduce

```
cd <empty identity dir>
RECAP_... <HEADLONG_ROOT>/bin/recap --context
```
(any `--context` invocation whose seeded trajectory has 0 rendered steps.)

## Upstream vs port

- bash stdout: `=== RIGHT NOW — the last 0 steps, verbatim ===` (matches port)
- bash stderr: `head: illegal line count -- 0` — port stderr: `` (empty)
- both exit 0, both on-disk state identical.

## Root cause

`bin/recap`'s `_render_steps` (`bin/recap:182-189`) computes a line `limit`
from the (empty) trajectory's line count and, when a non-empty limit string
is present (here `"0"`), pipes through `head -n "$limit"`:
```bash
tail -n "+$from_line" "$JSONL" \
    | { if [[ -n "$limit" ]]; then head -n "$limit"; else cat; fi; } \
    | jq -r ...
```
`head -n 0` is accepted silently (prints nothing, exit 0) by GNU coreutils
`head` (the production/Linux target), but this machine's `head` is BSD/macOS
`head`, which treats `-n 0` as an error: `head: illegal line count -- 0`.
Verified directly: `head --version` on this host reports the BSD usage
string, not GNU's `--version` banner. The script's overall exit code stays
0 regardless (the `head` failure doesn't propagate through this particular
pipeline in a way `set -e`/`pipefail` traps), so only this one stray stderr
line differs. On the actual GNU/Linux host this tool targets, bash and the
port would already match byte-for-byte here.

This is an artifact of running the Bash oracle on this macOS dev machine,
not a behavioral difference the port needs to replicate.

## Recommendation

No src/ or harness change: the port's silent, GNU-`head`-compatible
behavior is already correct for the tool's real target platform. If this
lane's oracle is ever run in CI on Linux, this finding class will stop
appearing entirely.
