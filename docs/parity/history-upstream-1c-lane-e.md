# Upstream sync 1c, lane E (historical)

> **Historical.** identity/skills/thinker-sync.

## Upstream sync 1c, lane E: identity/skills/thinker-sync (8c3f410, f1b8693, 6c324d1, 9a62727)

### 1. Skills split (1c: 8c3f410) — `src/skills.ts` slims to list/show/prompt/list-json + forwarding; `src/headlong-skills.ts` is the new manager

Mirrors upstream's `bin/skills` → `bin/skills` (slim) + `tools/headlong-skills`
(manager) split exactly, adapted to this port's flat `bin/` layout (no
separate `tools/` directory — the same adaptation this port already made for
`tools/headlong-killall` → `bin/headlong-killall`):

- `src/skills.ts` keeps `resolveConfig`, `colors`, `frontmatterField`,
  `extractShelllmMeta`, `missingRequirements`, `processSkillBlocks`,
  `allSkillDirs`/`skillDirLabel`/`skillSubdirs`, `findSkill`, `listJson`,
  `renderSkill`, `skillRequires`, `buildSkillsPrompt`, `actionList`,
  `actionListJson`, `actionShow`, and a slimmed `cli()` (list/list-json/show/
  prompt only). Everything else (`actionSearch`/`searchGitHub`,
  `actionInstall`, `actionRemove`, `actionCheck`, `actionInit`/
  `scaffoldSkill`, `actionPromote`/`showKernelBudget`/`tokenEstimate`,
  `actionKernel`, all remotes helpers, `actionRemoteList/Add/Remove`) moved
  UNCHANGED to the new `src/headlong-skills.ts`, which imports the shared
  helpers from `skills.ts` (the TS equivalent of upstream's manager
  `source`-ing the core for its config/helpers).
- New `bin/headlong-skills.mjs` (+ extensionless `bin/headlong-skills`
  symlink, same pattern as `bin/skills`/`bin/skills.mjs`) — thin wrapper over
  `src/headlong-skills.ts`'s `cli()`, identical shape to `bin/skills.mjs`.
- **Forwarding** (`skills.ts`'s `forwardToManager`/`resolveManagerPath`,
  mirroring `bin/skills`'s `_forward()`): a manager-only flag
  (`--project`/`--remotes`/`--force`/`--name`/`--description`) forwards
  IMMEDIATELY, mid-parse, with the full original argv, matching upstream's
  `case … --project|--remotes|--force|--name|--description) _forward "$1" ;;`
  exactly (checked BEFORE the value is read). A positional subcommand not in
  `{list, list-json, show, prompt}` (search, install, remove, check, init,
  promote, kernel, remote, or any other bare token — a search-shorthand
  query) forwards too. Resolution order matches upstream: PATH lookup for a
  literal `headlong-skills` first (`resolveOnPath`, this port's `command -v`
  equivalent), THEN a checkout-relative fallback. **Deviation, documented,
  necessary**: upstream's fallback is `$(dirname BASH_SOURCE)/../tools/
  headlong-skills`; this port's fallback is a literal SIBLING in `../bin/`
  (one directory up from `src/skills.ts`'s own location), since this port has
  no `tools/` directory — `bin/headlong-skills(.mjs)` sits right next to
  `bin/skills.mjs`. The LOOKUP ORDER is unchanged; only the fallback's
  target path differs, and it's the one directly analogous to upstream's own
  `tools/` sibling. Also PORT-NOTE: the forwarded subprocess is spawned via
  `process.execPath` (this port's own node binary) rather than relying on the
  target's own `#!/usr/bin/env node` shebang + `ctx.env.PATH` to resolve
  `node` — upstream's `exec` similarly depends on PATH to resolve `$mgr`'s
  own `#!/usr/bin/env bash` shebang, so a caller with a stripped-down PATH
  would fail identically on both sides for that reason; using
  `process.execPath` only removes an ADDITIONAL, port-specific failure mode
  (this test process's own PATH lacking `node`) without changing any
  observable stdout/stderr/exit-code byte when PATH is intact.
- `bin/skills`'s slim `--help`/usage text and the "No skills installed." hint
  (now `headlong-skills init`, not the pre-split `skills --init` — which was
  never a real flag) are copied byte-for-byte from upstream-next's
  `bin/skills`; `headlong-skills`'s own usage (matching `tools/
  headlong-skills`) is copied byte-for-byte too, including the reworded
  `promote` line ("Move a skill into the kernel …").
- `actionList` (unchanged location, `skills.ts`) drops the "Available (from
  remotes)" footer entirely, matching upstream's post-split `action_list` —
  remotes moved to the manager, and this core `skills` never resolves one.
  The dead `installedSkillNames`/`_installed_skill_names` helper (that
  footer's only caller) is dropped rather than ported, since upstream's own
  sibling in `tools/headlong-skills` is ALSO dead code there (defined, never
  called) — confirmed via `grep -n _installed_skill_names tools/headlong-skills
  bin/skills` against upstream-next (one hit: the definition).
- Tests: `test/skills.test.ts` (core: list/list-json/show/prompt/forwarding +
  sibling-lookup, rewritten from the pre-split monolith test file) and new
  `test/headlong-skills.test.ts` (manager: search/install/remove/check/init/
  promote/kernel/remote — content carried verbatim, behavior unchanged, from
  the pre-split `test/skills.test.ts`). `parity/skills/run-parity.mjs`
  extended with a `bin: "headlong-skills"` scenario selector (manager driven
  as its own entrypoint, not via forwarding) plus 4 new "split" scenarios
  (`manager-list-standalone`, `manager-help-advertises-install`,
  `manager-show-standalone`, `manager-prompt-standalone`) and
  `PARITY_UPSTREAM_ROOT`-based path derivation (`BASH_HEADLONG_SKILLS`/
  `TS_HEADLONG_SKILLS`), matching the convention already used by
  `parity/skill-env/run-parity.mjs` and `parity/sandbox/run-parity.mjs`. Run
  against an upstream checkout (5458fee): **95/95 scenarios effective
  parity (100.0%)** — 87 byte-identical, 8 pre-existing documented
  deviations (stderr-wording-only misuse paths + one `set -e`-crash
  smoothing, all pre-dating this lane), **zero new deviations** from the
  split itself; every install/search/check/init/remove/promote/kernel/remote
  scenario still reaches the manager transparently through the slim core's
  forwarding, proving the contract end-to-end against real upstream-next
  binaries.

### 2. `skills prompt`'s new "## Skills" format (1c: f1b8693, "wake prompt: skills pass")

`buildSkillsPrompt` (`src/skills.ts`) is rewritten to match upstream's
post-f1b8693 `action_prompt` exactly: a fixed two-line contract ("## Skills\n"
+ the "Playbooks I load only when a task calls for one: …" sentence) followed
by one `  - name: description` line per skill — kernel dir first, then the
regular skills dir, DEDUPED by name (first-seen wins), `(no description; run
skills show <name>)` when a skill has no `description:` field, or `  (none
installed)\n` when nothing is installed. Nothing is inlined any more: no CLI
cheatsheet, no full kernel SKILL.md bodies (previously the single biggest
prompt-token cost — upstream's commit message cites ~102K → ~2.5K on a real
identity). `stripFirstFrontmatter`/`promptSummaryField`/`trimTrailingNewlines`
(the old multi-range-sed-quirk reproduction, no longer needed by the new
format) are removed as dead code alongside the old block.

- `frontmatterField` in this port already never throws on a frontmatter-less
  SKILL.md (native fs/string logic, not an `awk|grep|head|sed` pipeline under
  `set -e -o pipefail`) — so the upstream half of f1b8693 that makes
  `frontmatter_field` "never fail" (wrapping it in `{ … } 2>/dev/null ||
  true`) has no port-side equivalent to make; the *observable* fix (a
  frontmatter-less skill is listed by directory name with the default
  "(no description; …)" text, not silently dropped) is what's tested.
- Test: `test/skills.test.ts`'s "cli prompt / buildSkillsPrompt" describe
  block (byte-exact contract text, no-kernel-body-inlined, no-CLI-table,
  under-1K-for-two-skills, frontmatter-less-skill-listed, kernel-wins-dedup).
  Parity: `parity/skills/run-parity.mjs`'s existing `prompt` group (basic,
  no-skills, multi-range-summary-quirk, with-kernel-body) all reached
  byte-identical parity against upstream-next's NEW prompt format with no
  scenario changes needed — confirming the rewrite matches real bytes.

### 3. `src/identity.ts` KERNEL_SKILLS/BUNDLED_SKILLS (1c: f1b8693, skills part)

`KERNEL_SKILLS` drops `"goals"` (`["mem", "chat", "goals"]` →
`["mem", "chat"]`) and `BUNDLED_SKILLS` drops `"file-tools"`, matching
upstream's `tools/identity` edit in the same commit (`skills/goals/SKILL.md`
never printed its block — `printf` misread its own format string as an
option — and `skills/file-tools/SKILL.md` advertised the already-retired
`view`/`put`/`sub`/`glob`, see "Retired: focus/glob/put/sub/view" above).
`src/assets/skills/{goals,file-tools}/SKILL.md` and
`src/assets/kernel/goals/SKILL.md` deleted to match upstream's deletions.
`skills/mem/SKILL.md`'s own f1b8693 trim (memory-dump block removed) is
**out of this lane's scope** (mem is owned by lane C) and NOT ported here —
`src/assets/skills/mem/SKILL.md` / `src/assets/kernel/mem/SKILL.md` are
untouched. Tests updated: `test/skills-content.test.ts`,
`test/identity-new.test.ts`, `test/identity-import.test.ts`.

### 4. `identity export --slim` drops `content_b64` from every step (1c: 9a62727)

`slimJsonLine` (`src/identity.ts`) now unconditionally `delete`s
`content_b64` after the existing shellm-run/prompt truncation, matching
upstream's updated `_SLIM_JQ` (`… | del(.content_b64)`, applied to every step
type, not just shellm-run/prompt) — a `chat send-file` message step's base64
file payload could otherwise carry a credential past the text-only regex/
string redaction. `deploy/scripts/audel-export` (also touched by 9a62727) is
OOS per PARITY.md's existing "identity export is unported" framing for that
script; the library-level `content_b64` drop itself is real behavior this
port's `identity export`/web export route already exercises, so it is PORTed.
Test: `test/identity-export.test.ts`'s new "slim drops content_b64 from
every step" case (message + shellm-run steps, non-slim export keeps it).
Parity: `parity/identity/run-export-parity.mjs`'s new `slim-drops-content-b64`
scenario, run against the upstream checkout's real `tools/identity
export --slim`: **7/7 scenarios PARITY (100.0%)**.

### 5. `web/server/src/thinker-sync.ts` `sync()`: bundled `disabled` marker inherited on first install only (1c: 6c324d1)

Port of `thinker_sync.py`'s `sync()` fresh-install branch: after
`installSubscriptions`, if `bundledDir/disabled` exists, it is
`atomicCopy`'d to `installedDir/disabled` — but ONLY inside the `fresh`
branch (status was `not_installed`). A later pull for an already-installed
thinker never touches `disabled` (already excluded from the code-file copy
loop by the existing `PRESERVE` set), so an operator who deletes the marker
to enable a thinker keeps it enabled across every subsequent pull; the
bundled default is never silently restored. This is the identical semantic
upstream's `sync()` (Python) adds in the same commit, and matches this
port's OWN `identityNew`/`installThinker` (`src/identity.ts`), which already
copies every bundled file — including `disabled` — verbatim on a fresh
`identity new` (no symlink-vs-real-file distinction to begin with, since
this port never symlinks bundled thinker files at all — DIRECTOR
CORRECTION, see "Daemon-runtime deviations" above) — so `identity.ts`
needed NO code change for this commit; only `thinker-sync.ts`'s reconcile-
on-restart path (the one thing `identity new` doesn't cover) did.
Test: `web/server/test/controls-slice-c.test.ts`'s new "PORT-NOTE (1c:
6c324d1): a fresh install inherits the bundled disabled marker once, then a
later pull preserves an operator's removal" — ported directly from
upstream's `web/tests/test_thinker_sync.py::test_fresh_install_keeps_bundled_disabled_default`,
same two-phase assertion (fresh install copies the marker byte-identical;
deleting it and re-syncing does not restore it). No dedicated Bash-vs-TS
differential harness exists for `thinker-sync.ts` (it ports `thinker_sync.py`,
not a Bash tool — there is no `PARITY_BASH_THINKER_SYNC` to diff against), so
this scenario lives in the web-server unit-test suite rather than
`parity/identity`, alongside the existing thinker-sync route tests it sits
next to.

### 6. Retired-tool references (1c: 12ca841, in this lane's files only)

- `src/steprun.ts`'s `DEFAULT_IDENTITY_TEXT` drops `focus` from the "I am
  driven by standalone commands (think, chat, focus, mem, skills, traj) …"
  list — this port already retired `focus` (lane 1c-f). **Known upstream
  inconsistency, not reproduced**: upstream's own `tools/identity` hardcoded
  default text (`_ensure_kernel`'s fallback, tools/identity:1502-1508) still
  literally says "…focus, mem, skills, traj…" at 5458fee — 12ca841 only
  edited the PARALLEL list in `deploy/slack-persona.md` ("chat, mem, traj,
  skills, focus, recap, context, view, put, glob, sub" → "chat, mem, traj,
  skills, recap, context"), and no later commit through 5458fee touches
  `tools/identity`'s own copy. Dropping `focus` here mirrors the PATTERN
  12ca841 established (and this port's own prior retirement decision) rather
  than upstream's own stale bytes for this specific string, since matching
  those bytes verbatim would have this port's freshly-created identities
  describe a command (`focus`) that no longer exists in the port at all.
- `src/assets/skills/file-tools/SKILL.md` — DELETED, matching upstream
  (`skills/file-tools/SKILL.md` deleted by f1b8693, not 12ca841 itself — it
  advertised `view`/`put`/`sub`/`glob`). See item 3 above (same commit, same
  deletion, filed there under KERNEL_SKILLS/BUNDLED_SKILLS since upstream's
  own commit bundles both changes together).
- `src/assets/skills/shellm/SKILL.md` — **NOT touched.** Confirmed via
  `git diff 7d29f9e 5458fee -- skills/shellm/SKILL.md` against both upstream
  pins: EMPTY diff. Upstream's own `skills/shellm/SKILL.md` still documents
  `view`/`glob`/`sub`/`put`/`focus` as available tools at 5458fee (lines
  ~21,54,74-77) — the same kind of stale-doc inconsistency as `tools/
  identity`'s hardcoded text above. Since upstream never rewrote or deleted
  this file in the 7d29f9e..5458fee range, and the port's copy is already
  byte-identical to upstream's 7d29f9e copy, there is nothing to port here —
  changing it would be inventing a fix upstream itself hasn't made.
- Installer skills-list wording: none found. `src/install-lib.ts`'s `TOOLS`
  array (whether `headlong-skills` should be added to the installer's
  onto-PATH symlink list) is explicitly lane F's (1c-f) file per this file's
  own "Retired" section above; not touched here. Not adding it there does
  not break forwarding in this port: `src/sandbox-runtime.ts` bind-mounts the
  WHOLE checkout read-only (see "Sandbox bind-mount scope" above), so
  `bin/headlong-skills(.mjs)` is always present as a literal sibling of
  `bin/skills.mjs` regardless of the installer's PATH-symlink list.

