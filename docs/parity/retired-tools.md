# Retired: focus/glob/put/sub/view (historical)

> **Historical.** Tools retired in upstream 1c (`12ca841`). Overview: [`PARITY.md`](../../PARITY.md).

## Retired: focus/glob/put/sub/view (1c: 12ca841)

Upstream `12ca841` ("core: drop view, put, glob, sub, focus; the mind reads
and edits in bash") deletes these five tools outright — not moved to
`tools/`, no replacement binary. Its commit message: over 17 days Audel
called `view` 212 times against 3,067 `sed -n` reads, `sub` 41 times against
about 17,000 python heredoc edits, and `put`/`glob`/`focus` a few hundred
times between them combined; the Docker sandbox never mounted the four file
tools, the monolith prompt already routes goals through `mem`, and Audel's
own scripts call none of the five. Upstream's tool lists in the persona,
shared library (`thinkers/_lib/common.sh`), dispatcher (`bin/thinkers`),
coupling test (`tests/test_thinker_tool_coupling.sh`), installer
(`install.sh`), uninstaller (`uninstall.sh`), status (`status.sh`), and
killall (`tools/headlong-killall`) all drop the five in lockstep.

This port (lane 1c-f, `sync1c/f-tool-cull`) mirrors that decision — DROP, not
superset-and-document — retiring all five from the port as well:

- **Removed**: `bin/{view,put,glob,sub,focus}` (+ their `.mjs` shims),
  `src/{view,put,glob,sub,focus}.ts`, `test/{view,put,glob,sub,focus}.test.ts`,
  `parity/{view,put,glob,sub,focus}/` (differential harnesses + fixtures),
  `parity/fuzz/tools/{view,put,glob,sub,focus}.mjs` (fuzz adapters) and their
  now-unused allowance predicates in `parity/fuzz/lib/allowances.mjs`
  (`isGlobLimitNonIntegerFamily`, `isGlobBracketRangeFamily`,
  `isPutOsFailFamily`) and concurrency lanes in `parity/fuzz/lib/concurrency.mjs`
  (`concurrencyPut`, `concurrencySub`). `parity/fuzz/tools/registry.mjs`'s
  `TOOLS`/`TOOL_NAMES` no longer list them, so `--tool all` still runs clean.
  `parity/fuzz/findings/{view,glob,put}-*.md` campaign findings are left in
  place as history, per this lane's brief — not deleted.
- **Tool-enumeration updates**: `src/install-lib.ts`'s `TOOLS` (installer
  onto-PATH list; `focus`/`glob` were already absent from it before this
  lane — a pre-existing deviation from upstream's `BIN_TOOLS`, not something
  this lane introduced) and `src/killall.ts`'s `PATTERNS` (the `sub.mjs`
  argv-match entry is removed, mirroring upstream's own
  `(shellm|shellm-explore|llm|chat|sub)` → `(shellm|shellm-explore|llm|chat)`
  regex-group edit to `install.sh`/`status.sh`/`uninstall.sh`/
  `tools/headlong-killall`). `src/status-lib.ts`/`src/uninstall-lib.ts` carry
  no tool list of their own — they import `TOOLS`/`PATTERNS` from
  `install-lib.ts`/`status-lib.ts` respectively, so they follow automatically
  (see the new "tool-list-must-match" test below).
- **No sandbox-runtime mount list to update**: unlike upstream's per-tool
  `docker exec ... -v $tool:/usr/local/bin/$tool:ro` mounts, this port's
  `src/sandbox-runtime.ts` bind-mounts the WHOLE port checkout read-only in
  one shot (see "Sandbox bind-mount scope" above) — there is no per-tool
  mount list in this port to prune.
- **Docs**: README.md's CLI-tools line, this file's "Ported" line (above),
  and CLAUDE.md's frozen-surface CLI list + `PARITY_BASH_<TOOL>` env-var
  enumeration drop `sub`/`put`/`view`/`focus` (`glob` was already absent from
  CLAUDE.md/README's lists). `PORTING.md`'s differential-harness list drops
  the same five.
- **Test coverage for the retired tools is gone, by design** (removed tests
  for removed tools): `test/{view,put,glob,sub,focus}.test.ts`, the `put`
  `describe` block in `test/stdin.test.ts`, the `view` scenario in
  `test/stdout-drain.test.ts`, and the `concurrencyPut`/`concurrencySub`
  fuzz lanes. Tests that used `bin/sub.mjs` only as an arbitrary
  argv-pattern decoy (`test/killall.test.ts`, `test/killall-step-tree.test.ts`,
  `web/server/test/controls.test.ts`) were repointed at `bin/chat.mjs` — a
  still-shipped, still-matched pattern — so killall's decoy/sibling/protected-
  ancestor coverage is unchanged, not reduced.
- **`parity/upstream-tests/run.mjs`'s `PORT_TOOLS`** (used to substitute the
  port's `bin/<tool>.mjs` into a scratch copy of the real upstream Bash test
  suites) drops `focus`/`glob`/`put`/`view` — `portEntry()` would otherwise
  throw `port tool missing` for any suite run through this harness now that
  those `bin/*.mjs` files are gone. (`sub` was never in `PORT_TOOLS` to begin
  with — it was already left as real upstream Bash for that harness.)
- **Explicitly out of scope for this lane** (owned by lanes B/E — thinker
  step code, prompts, skills/identity assets — flagged here, not edited):
  - `src/monolith.ts`'s `synthCommand()` — **RESOLVED by bug #63** (see
    "shellm-run `command` field was a fixed template" above): it no longer
    carries any hardcoded `--bin` list at all — the run header's `--bin`
    flags are now derived from the live tool list (`fs.existsSync` per tool
    under `id.binDir`, the TS equivalent of upstream's `command -v` in
    `_build_shellm_flags`, `thinkers/_lib/common.sh`), so a retired tool's
    absence here was never a real gap to begin with once fixed.
  - `src/steprun.ts:32` — `DEFAULT_IDENTITY_TEXT`'s "I am driven by standalone
    commands (think, chat, focus, mem, skills, traj) …" boilerplate (thinker-
    step code, mirrors upstream's `deploy/slack-persona.md` edit in 12ca841).
  - `src/assets/skills/shellm/SKILL.md` (documents `focus`/`view`/`glob`/`sub`/
    `put` as available tools, lines ~21, 54, 74-77), `src/assets/skills/file-tools/SKILL.md`
    (the entire skill teaches `view`/`put`/`sub`/`glob`), and
    `src/assets/shellm-system-prompt.txt:72` ("File tools: view …, sub …, put
    …, glob …") — all skills/identity assets, and upstream itself only
    replaces the system-prompt file-tools line in a LATER commit
    (`f1b8693`, "wake prompt: skills pass"), not in 12ca841 itself.

See also the new "tool-list-must-match" test (`test/tool-coupling.test.ts`),
which mirrors upstream's `tests/test_thinker_tool_coupling.sh` invariant
across this port's installer/uninstaller/status/killall.

