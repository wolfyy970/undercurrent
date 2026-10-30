# skills fuzz finding #1 — `--dir` colliding with the implicit project `.skills/` is silently un-deduped

- classification: **PORT-BUG (medium-high confidence)**
- group: `list` (also `list-all`, `list-prompt`, `search`)
- argv: `["list", "--dir", "<abs>/work/.skills"]` (or bare `[]`, since `list`
  is the default command) run with cwd `<abs>/work` (so the explicit `--dir`
  and the implicit project-relative `./.skills` resolve to the SAME physical
  directory) and at least one skill installed there.
- reproduce:
  ```
  mkdir -p /tmp/skilltest/work/.skills/foo-skill
  cat > /tmp/skilltest/work/.skills/foo-skill/SKILL.md <<'MD'
  ---
  name: foo-skill
  description: a test skill
  ---
  # foo-skill
  body text
  MD
  cd /tmp/skilltest/work
  <HEADLONG_ROOT>/bin/skills list --dir "$PWD/.skills"   # warns "found in multiple locations"
  node <repo>/bin/skills.mjs list --dir "$PWD/.skills"   # silent, same listing
  ```

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | listing (matching skills) | IDENTICAL listing | yes |
| stderr | `⚠ skill foo-skill found in multiple locations:\n    .skills/foo-skill\n    /tmp/skilltest/work/.skills/foo-skill\n  Using the first one. Remove one copy to resolve.` | (empty) | **NO** |
| status | 0 | 0 | yes |
| state | unchanged | unchanged | yes |

## Root cause

Bash's `skills` scans BOTH the project-relative `./.skills` (implicit,
relative to cwd) AND the `--dir`-specified directory, and when a skill name
resolves to the SAME directory via both paths, it detects the duplicate and
warns (picking "the first one"). The TS port's listing output is correct
here (same skills, same fields) but produces NO warning at all — either it
only scans `--dir` (not also the implicit project path), or it scans both
but doesn't run the same duplicate-detection/warn step. Functionally benign
in THIS exact collision (same physical dir via two names), but the missing
dual-scan-and-dedup logic would matter more if a project `.skills/` and a
`--dir` pointed at TWO DIFFERENT directories that happen to define a skill
with the SAME NAME — Bash would warn and pick one deterministically; the
port's behavior in that case is unverified by this campaign (this fuzzer's
`--dir` always coincides with the project directory by construction, see
`parity/fuzz/tools/skills.mjs`) and should be checked directly by a fix lane.

## Duplicates and scope note

189 of skills' 500-iteration findings are this family (`list`/`list-all`/
`list-prompt` missing the warning; `search` too). The HIGH raw count is a
fuzzer construction artifact, not an organic hit rate:
`parity/fuzz/tools/skills.mjs` always passes `--dir <sandbox>/work/.skills`
while cwd is `<sandbox>/work`, so the collision condition is present in
essentially every scenario with at least one seeded skill — a real caller
would only hit this when `--dir` happens to coincide with (or overlap) the
project directory. Still a real, reproducible gap in the dual-scan/dedup
logic, just not evidence that this fires at a "38% of the time" organic rate.
