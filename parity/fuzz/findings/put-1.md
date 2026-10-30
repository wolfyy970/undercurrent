# put fuzz finding #1 — `--parents` leaves a stray intermediate dir when the target path contains `..`

- classification: **documented-deviation candidate (low severity) — needs a human call, not auto-allowed by this harness since it wasn't previously catalogued**
- group: `parents`
- argv: a target path with a backtick and a `..` segment, combined with
  `--parents` (e.g. `"with space/with` + "`" + `tick/../x.txt"`, `-p`)

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | (empty) | (empty) | yes |
| stderr | `put: wrote <path> (14 bytes)` | IDENTICAL | yes |
| status | 0 | 0 | yes |
| state | `work/with space/`, `work/with space/with<backtick>tick/` (empty, stray), `work/with space/x.txt` | `work/with space/`, `work/with space/x.txt` (no stray dir) | **NO** |

## Root cause

Bash's `--parents` handling runs `mkdir -p "$(dirname "$raw_target")"` on the
RAW target path BEFORE any `..` resolution, so it creates the raw dirname
(including a path segment that only exists pre-`..`-collapse) even though
the target file itself resolves (after `..` collapses) to a shallower path —
leaving an empty, unused directory behind. The TS port apparently
resolves/normalizes the path first, so it only creates the directory the
file actually needs. Both sides write the SAME correct final file content;
only the stray leftover directory differs.

This reads as the port doing the more "correct" thing, but it's a real
on-disk state divergence a differential harness must surface, and — since a
target path containing `..` combined with `--parents` isn't itself a
previously-documented deviation for `put` — this harness reports it
unclassified rather than silently deciding it's fine.

## Duplicates

Only 1 of put's findings — the specific `..`-in-target + `--parents`
combination is a narrow slice of the fuzz space; not independently
reproduced multiple times in this campaign.
