# Gaps

> Known gaps and stub inventory. Overview: [`PARITY.md`](../../PARITY.md).

## Gaps (every stub lives here — nothing stubbed silently)

mem, skills, and rollups are now SHIPPED and at parity (see the module table and
differential proofs under `parity/`). The per-wake system-prompt rows below are
RESOLVED (2026-10-29); no stub remains in this table:


> Table converted to sections for GitHub rendering.

### monolith/responder system prompt (identityText, skillsText) — RESOLVED (see "Replay seam removal and K1-K3")

- **Missing / stubbed:**

the engine pre-injects a STATIC `identity prompt` / `skills prompt` blob (src/monolith.ts:43-44,
scripts/real-wake.ts) rather than re-rendering it live each wake

- **Impact:**

the `skills` CLI + its `skills prompt` renderer are at parity and on the sandbox PATH; only the
per-wake re-render into `buildSystemPrompt` is stubbed

- **Target:** wire `skills prompt` (and identity prompt) into buildSystemPrompt

### test fixtures skillsText — RESOLVED

- **Missing / stubbed:** "(stub)" placeholder skill text in tests (now `(no skills installed)`)

- **Impact:** test-only; the real `skills prompt` renderer is exercised by test/skills.test.ts + parity/skills

- **Target:** tracked here

### SHELLM_SYSTEM_PROMPT env override (bin/shellm:198,1548-1549) — RESOLVED

- **Missing / stubbed:**

monolith.ts used to always call `runShellm` with the bundled `SHELLM_SYSTEM_PROMPT` constant
(`src/prompts.ts`); no plumbing read the env var to override it

- **Impact:**

fixed: `steprun.ts`'s `buildIdentityConfig` reads `SHELLM_SYSTEM_PROMPT` (`[[ -n ]]`-gated, same
as the Bash — set-but-empty does not override) into `IdentityConfig.systemPrompt`; `monolith.ts`
uses it + `"\n"` (matching `printf '%s\n'`) in place of the bundled default when set

- **Target:**

test/steprun.test.ts "SHELLM_SYSTEM_PROMPT override" (override with/without its own trailing
newline, unset, set-but-empty)

### shellm-run header's max_tokens field (bin/shellm:2149-2151 --arg max_tok "${SHELLM_MAX_TOKENS:-}") — RESOLVED

- **Missing / stubbed:**

`src/shellm.ts`'s `runShellm` hardcoded `max_tokens: ""` on the recorded header row;
`SHELLM_MAX_TOKENS` IS wired to the real `OpenRouterClient` call (see the shellm env-knob parity
fix above), just not to this recorded field

- **Impact:**

fixed: `IdentityConfig.maxTokens` (raw `SHELLM_MAX_TOKENS` text, empty when unset — same as the
Bash's `${…:-}`) threads from `steprun.ts` through `monolith.ts`'s header into
`RunShellmOptions.header.maxTokens`, replacing the hardcoded `""`

- **Target:** test/steprun.test.ts "shellm-run header's max_tokens" (set and unset)

### retrieval on the in-process bus (src/topology.ts) — RESOLVED for the daemon path

- **Missing / stubbed:**

the monolith's own thoughts/observations are written by the `traj` shim in a subprocess; the
in-process ObservableTrajectory never sees them (dispatcher.ts fidelity note), so they cannot
wake retrieval in the port topology. Upstream's file bus delivers them — 4 of the 5 pax
retrieval wakes (rows 715→716, 771→772, 806→810, 853→856) were monolith-written triggers

- **Impact:**

STILL a gap for `src/topology.ts`'s in-process harness (unchanged, by design — see "topology.ts
stays the in-process test harness" in the daemon module row). NO LONGER a gap for the real
daemon: `src/daemon.ts`'s `TrajFeeder` reads the trajectory FILE, so it sees every append
regardless of which process (in-process code or the `traj` shim) wrote it — the daemon's
file-tail bus closes this exactly as this row predicted

- **Target:** daemon.test.ts (out-of-process appends are fed and dispatched); no topology.ts change needed or made

### dispatcher boot kick payload vs retrieval — RESOLVED

- **Missing / stubbed:**

`Dispatcher.bootTrigger` used to hand thinkers `{type:"manual-trigger", content:"manual
trigger", source}`; upstream's pending file is `{type:"manual-trigger", source:"thinkers-cli",
ts}` — NO content

- **Impact:**

fixed in this lane's dispatcher.ts refactor: `bootTrigger` now sends `{type:"manual-trigger",
source}` with no `content` field, matching upstream exactly (see the "Daemon-runtime deviations"
table above)

- **Target:** topology.test.ts "spontaneous/manual-trigger:thinkers-cli"; runstate.test.ts `manualTriggerJson` (no content)

### llm anthropic / gemini / opencode-Zen / adapter wire paths — RESOLVED

- **Missing / stubbed:** used to detect + check keys, then die `... provider wire path not yet ported`

- **Impact:**

fixed: all four wire paths ported (payload build, headers/auth, response parsing, streaming, and
the adapter exec seam) — see the "llm tool" module row and "llm slice 2 parity fixes" above

- **Target:**

`parity/llm/run-parity.mjs` 217/217 (0 port bugs); `tests/test_llm_adapter.sh` via
`parity/upstream-tests/run.mjs` 20/20

### bin/mem.mjs stdin read — RESOLVED

- **Missing / stubbed:**

`fs.readFileSync(0)` used to return "" on EAGAIN (a non-blocking pipe from a Node parent) — `mem
add`/`mem edit` via piped stdin could lose their text; now fixed: `bin/mem.mjs` imports the
shared `readStdinSync` from `src/stdin.ts` (a `readSync` loop that waits out EAGAIN instead of
discarding partial reads), the same helper `bin/llm.mjs` uses

- **Impact:** resolved — piped stdin for `mem add`/`mem edit` no longer loses text on EAGAIN

- **Target:**

test/stdin.test.ts ("mem add — piped stdin over 512 KiB, delivered in delayed chunks", incl. an
aggressive small-chunk EAGAIN-triggering feed)

### POST /api/update — RESOLVED (routes-d lane)

- **Missing / stubbed:** §B route 15 (`git pull --ff-only` + scheduled restart, literal HTTP 202 even on a no-op)

- **Impact:**

`web/server/src/selfUpdate.ts` `runSelfUpdate` — real `git pull --ff-only` against the port's
own checkout, `_requireControls` then `HEADLONG_WEB_SELF_UPDATE=1`-gated (403 either way), a
process-wide lock (409 on a concurrent call),
`config.self_update_enabled`/`git_commit`/`git_branch` now reflect the real,
once-at-startup-resolved values (no longer hardcoded)

- **Target:**

none — closed; test/selfUpdate.test.ts (18 cases against real scratch git repos — fast-forward,
diverged/`--ff-only` failure, concurrency, up-to-date no-op)

### POST /api/identities/:id/export-jobs, GET .../export-jobs, DELETE /api/export-jobs/:job_id, GET /api/export-jobs/:job_id, GET /api/export-jobs/:job_id/download, GET /api/identities/:id/export, GET /api/export — RESOLVED (routes-d lane)

- **Missing / stubbed:** §B routes 16/17 (in-process job registry, NOT controls-gated upstream) + `identity export` itself

- **Impact:**

all seven routes are now real, correctly bypassing `_requireControls` (the very gap this row
used to warn about) — see the "web control plane" and "identity export" module rows,
`web/server/src/exportJobs.ts`, and `parity/identity/run-export-parity.mjs` (6/6 PARITY)

- **Target:** none — closed

### GET /api/push/key, POST /api/push/subscriptions, POST /api/push/unsubscribe — RESOLVED (routes-d lane)

- **Missing / stubbed:** §B route 18/19 (web-push `addSubscription`/`removeSubscription`, RFC 8291/8292 crypto via `py_vapid`/`pywebpush`)

- **Impact:**

all three routes are real; the underlying VAPID/aes128gcm crypto
(`web/server/src/webpushCrypto.ts`) and the mind-log-tailing `PushWatcher` (`push.ts`) are also
ported, cross-language interop-proven against the real Python libraries — see the "web push"
module row and `parity/push/report.md` (6/6 PASS)

- **Target:** none — closed

### identity list (bin/identity / src/identity.ts) — RESOLVED (port/identity-list lane)

- **Missing / stubbed:**

`identity list [-a]` is now ported (`src/identity.ts` `identityList`, `bin/identity.mjs`) — see
the "identity list" row in the module table and `parity/identity/` (17/17 byte-identical
differential)

- **Impact:**

the Rust `tui/`'s `/identities` mode used to run `identity list` and get `Usage: identity new
[--default] [--memories DIR] <name>` instead of a listing; it now returns a real listing,
re-verified end to end via `resolveIdentityEnv()` + the port's own `bin/identity` — see
`tui/PARITY-RECEIPT.md`'s "Gap 1 (`/identities`) closed" heading

- **Target:** none — closed

### slack bridge live Socket Mode leg (src/slack/socketmode.ts, src/slack/cli.ts)

- **Missing / stubbed:**

no real Slack bot/app-level token is available in this environment, so this port has never made
a real `apps.connections.open` call or held a real WebSocket connection to `slack.com` —
`socketmode.ts` was implemented from Slack's public protocol description, not verified against
live traffic or against `slack_bolt`'s own reconnect/ping timing (unpublished as a stable
contract)

- **Impact:**

`headlong-slack-bridge` cannot be assumed to run correctly end to end against a real workspace
until this leg is exercised with a real app; every OTHER piece
(config/naming/mindlog/state/slackfmt/inbound's event-gate+delivery/outbound/the Web API wire
format) IS proven via parity/slack's 15/15 differential run against the real `headlong_slack`

- **Target:**

test/slack-socketmode.test.ts (fake WebSocket only); parity/slack/report.md's header notes the
deferral; whoever gets a real Slack app token should smoke-test `bin/headlong-slack-bridge.mjs`
against a live workspace before relying on it in production

### env image identity (upstream 0925168, env_metadata_matches/_resume_docker_image, bin/shellm) — RESOLVED (bug #32), correcting an earlier N/A verdict

- **Missing / stubbed:**

upstream's `bin/shellm` reuses any RUNNING named env (`SHELLM_ENVS_DIR`, `env_find_running`)
whose metadata matches a requested `--docker-image`, across separate `shellm` CLI invocations,
and 0925168 fixes a real hazard there: a second run asking for a different image silently
reattached to the first run's container. **Correction:** the earlier N/A verdict here reasoned
this port "has no such mechanism to have the bug in" because `selectSandbox` created exactly one
container per step and always tore it down — but that per-step-only lifecycle WAS itself the
port bug (#32: no reuse across wakes at all, closer to the original hazard's opposite failure
mode than to having nothing to disagree on). Now ported: `src/sandbox-env.ts` gives each
identity/env name a persistent container reused across wakes, with metadata at
`<identityDir>/.shellm/envs/<name>/` (this port's `SHELLM_ENVS_DIR`, matching
`tools/identity:375,1381` exactly — the same directory upstream's own env registry would use for
the same identity), and `envMetadataMatches`/`envMetadataMismatchMessage` port the
image-identity subset of `env_metadata_matches`/`env_metadata_mismatch_message`
(bin/shellm:749-798,811-846): a stored env whose recorded image disagrees with the one requested
throws upstream's exact `die()` text rather than silently reattaching. (No `--docker-image`
explicit-vs-default distinction, `env_find_running`-by-scan, or standalone `shellm` CLI exist in
this port — env resolution is always by identity name, matching every real thinker wake, which
upstream itself treats as the "explicit" `--env` case, i.e. always `die()` on mismatch, never a
silent skip.) `docker_image`/`docker_image_digest` continue to land on the trajectory's
`shellm-run` header (`env: EnvSpec`), now reflecting the ACTUALLY reused/created container on
every wake

- **Impact:**

`test/sandbox-env.test.ts` (real docker, skips cleanly without a daemon): "image mismatch
refuses reuse with upstream's exact message (0925168)" asserts the literal upstream `die()`
string byte-for-byte; "two consecutive wakes reuse the same container" proves the reuse side;
bug #55's "(a) recorded container id no longer exists" proves a fully-removed container now dies
(not silently recreated) with upstream's exact message. `tests/test_env_image_identity.sh` (real
bash, 12/12 pass against NEW upstream, unchanged from before) still documents the behavior being
matched; not run differentially (still no standalone `shellm` CLI to diff against) — matched by
direct message-string comparison instead

- **Target:** 

### persona (per-identity command wrapper: ada, ada stop, ada "hello")

- **Missing / stubbed:** not shipped by this port at all — no `bin/persona`, no TS equivalent

- **Impact:**

`install.mjs` never creates an identity-name command link (`_link_persona_command` in
`src/init.ts` is therefore always a no-op, matching upstream's own `[[ -e "$target" ]] || return
0` guard when persona is absent — which is this port's actual, permanent situation);
`headlong-init`'s summary, and `status.mjs`'s command rows, print `persona <name>` command lines
the same way upstream would print them in that same situation — technically accurate to the
upstream TEXT, not to a tool this port ships. Use `node bin/chat.mjs`, `node bin/thinkers.mjs
stop`, etc. directly for now.

- **Target:**

none yet — `install-lib.ts`'s/`init.ts`'s file-header PORT-NOTEs;
`parity/upstream-tests/report.md`'s smoke_install.sh detail row for `persona`'s own `--help`
check (skipped: no persona binary to check)

### global ~/.skills/core-skills / ~/.headlong-thinkers staging (install.sh's _install_skills/_install_thinkers)

- **Missing / stubbed:** `install.mjs` has no equivalent step at all — see `src/install-lib.ts`'s file-header PORT-NOTE

- **Impact:**

this port's `identity new` (`src/identity.ts`) bundles skill/thinker templates straight from
`src/assets/` into each identity at creation time, with no global staging directory in between —
so after `node install.mjs`, `~/.skills/core-skills` and `~/.headlong-thinkers` simply do not
exist (upstream always populates both). Observable difference, not a behavior bug in anything
this port DOES do; surfaced honestly by `parity/upstream-tests/run.mjs --installer`'s
`smoke_install.sh` run ("core skills installed" + 4x "thinker template copied: <name>" port-only
failures, root-caused in `parity/upstream-tests/report.md`'s Installer lane detail).

- **Target:** `parity/upstream-tests/report.md` (Installer lane, smoke_install.sh)

### SHELLM_DOCKER_ACCESS broker/socket/dind modes (bin/shellm:88,527-529,918-1149)

- **Missing / stubbed:**

upstream validates the env var against `none|broker|socket|dind` (`case` at bin/shellm:527-529,
`die "Invalid --docker-access: $SHELLM_DOCKER_ACCESS ..."` on anything else) and, for the three
non-`none` values, sets up broker-process forwarding, a bind-mounted `/var/run/docker.sock`, or
a privileged `dind` container respectively. The port reads `SHELLM_DOCKER_ACCESS` NOWHERE —
confirmed, zero references anywhere in `src/`, `test/`, or `bin/` — so the env var has NO effect
at all: no validation (an invalid value that upstream would `die()` on is silently accepted), no
broker/socket/dind behavior (a value upstream WOULD implement is silently ignored).
`sandbox-runtime.ts`/`sandbox-env.ts` unconditionally record `docker_access: "none"` in the
run's own env-spec metadata regardless of what, if anything, the caller set.

- **Impact:**

a skill that shells out to `docker` from inside the sandbox, or that relies on
`SHELLM_DOCKER_ACCESS=socket`/`dind` for nested Docker access, silently gets a `none`-mode
container instead of failing loudly or getting the requested access — worth knowing before
relying on any docker-in-docker workflow in the port

- **Target:**

none — declared scope-cut (parity/RUNTIME-SEAMS.md §B "docker container creation" row, §D item
7); no test asserts the silent-ignore behavior since there is no behavior to assert beyond the
hardcoded `"none"` already covered by sandbox-runtime/sandbox-env tests

### whole-agent-in-Docker menu, real execution (install-lib.ts's offerDockerInstall)

- **Missing / stubbed:**

the interactive 3-way menu (fully in a container / on this machine sandboxed / on this machine
unsandboxed) and the real `docker run ... buildpack-deps:curl bash -c 'curl ... | node -'`
invocation are ported and type-checked, but — like upstream's own test suite, which pins only
the pure `_docker_forward_args` secret-forwarding helper — never exercised end to end by an
automated test (it starts a real, long-running Docker container and re-enters the whole
installer inside it). `dockerForwardArgs`/`locationOfferAvailable`/`parseDockerMenuChoice` (the
decision logic) ARE unit-tested (`test/install-lib.test.ts`, mirrors
`tests/test_install_secret_argv.sh`/`test_installer_prompt_defaults.sh`).

- **Impact:**

anyone relying on `install.mjs`'s "1) Fully inside a Docker container" choice should smoke-test
it by hand once against a real Docker daemon before depending on it

- **Target:** test/install-lib.test.ts (decision logic only)


### daemon-runtime gap fixes (this lane, now matching Bash)

Both found by running upstream's own suites through `parity/upstream-tests/run.mjs --daemon`; each was a real divergence confirmed by reading the port source against `bin/thinkers`, then fixed and re-verified against the same oracle (both suites now report `parity`; see `parity/upstream-tests/report.md`'s summary table).

- **`Dispatcher.scheduledWakeCheck` pruned orphaned `*.wake_at` files by the
  registered-thinkers map, not by disk** (`src/dispatcher.ts`) — it iterated
  `this.thinkers.keys()` (populated from real `thinkers/<name>/` directories
  at boot) instead of globbing `run/*.wake_at` the way upstream's
  `_scheduled_wake_check` does (`bin/thinkers:664`, `for _wf in
  "$run_dir"/*.wake_at`). A `<name>.wake_at` file for a name with no
  corresponding `thinkers/<name>/` directory at all was structurally never
  visited, so it was never removed (upstream removes it on the very next
  tick via `grep -qx "$_wname" active_thinkers` failing, `bin/thinkers:667`).
  Fixed: `scheduledWakeCheck` now `fs.readdirSync`s `stateDir` and filters
  for `*.wake_at` entries, deriving the name from the filename — same source
  of truth as upstream's glob. `isActiveName`'s existing false-for-unregistered
  path (mirroring the `grep` failing) still prunes the file. Found by
  `tests/test_thinkers_wake_at.sh` Test 5 (`test_bad_files_dropped`, the
  `nobody.wake_at` case): port 13/14 -> 14/14. Unit tests:
  test/dispatch-mechanics.test.ts "scheduled wake / run/<name>.wake_at"
  (orphaned-name pruning, normal registered-thinker firing unaffected,
  garbage-content pruning).
- **`thinkersStop`/`drainThenFinish` never ran a thinker's own
  `<thinker_dir>/stop` script** (`src/thinkersctl.ts`) — upstream `bin/thinkers`
  runs it in FOUR places: the drain reaper after in-flight steps exit
  (`bin/thinkers:1259`, inside `_drain_then_finish`), the stop-all drain
  reaper (`:1273`, inside `_drain_all_then_finish`), the named
  force/no-in-flight synchronous branch (`:1356-1357`), and the stop-all
  synchronous fallback loop (`:1423,1425`) — all four were absent from the
  port. Fixed: a new `runStopScript` helper execs `<thinker_dir>/stop`
  (failure-open, matching `|| true`) at all four sites, with `cwd` pinned to
  `IDENTITY_DIR` (upstream leaves cwd unspecified — see the function's
  PORT-NOTE) and the full identity `env`. The two drain sites additionally
  needed a second fix to actually return control to the caller immediately:
  an un-awaited in-process `setTimeout` loop lets a library caller's own
  Promise resolve right away, but Node's event loop — and therefore the
  standalone `bin/thinkers.mjs stop` CLI PROCESS — stays alive for as long
  as a pending timer exists, so the CLI hung until the whole drain finished
  regardless (silently failing "stop returns immediately" against the real
  oracle, which times the CLI invocation, not just the promise). `bin/thinkers-drain.mjs`
  is now spawned detached + `unref()`'d (same technique `thinkersStart`
  already uses for the dispatcher) to do the wait-then-TERM-then-KILL-then-stop-script
  work as a genuinely separate OS process, mirroring upstream's own `(...)
  </dev/null >/dev/null 2>&1 & disown` background subshell. Found by
  `tests/test_thinkers_drain.sh`: port 11/20 -> 20/20. Unit tests:
  test/thinkersctl.test.ts "stop scripts (bin/thinkers:1259,1273,1356,1423 …)"
  (no-in-flight sync run, `--force` sync run, drain defers until the step
  exits then the detached reaper runs it, stop-all drain runs every enabled
  thinker's script — not just the one that was in flight).
- **`requireEnv` never checked `THINKERS_DIR` actually exists, AND (found
  characterizing the sealed holdout for this same bug) skipped straight past
  upstream's EARLIER required-variable checks (BUG #67, bin/thinkers:138-155
  `_require_env`)** (`src/thinkersctl.ts`, `bin/thinkers.mjs`) — upstream's
  `_require_env` runs, in this exact order, before `status`/`start`/`stop`/
  `list`/`step`/`logs` do anything else: (1) `[[ -n "$IDENTITY_DIR" ]] || die
  "IDENTITY_DIR not set. Run: identity shell <name>"`, (2) the same check for
  `TRAJ_DIR`, (3) the same check for `TRAJ_ID` — none of these three have ANY
  fallback, ever, regardless of whether `IDENTITY_DIR` points at a real
  directory (verified against the oracle: `env -i PATH="$PATH"
  IDENTITY_DIR=<a real, existing identity dir> bash bin/thinkers status`
  still says `TRAJ_DIR not set...` — only `identity shell <name>`'s
  `activate` script, a wholly separate process, ever sets these two) — (4)
  `IDENTITY_NAME` defaults to `grep '^name=' $IDENTITY_DIR/info.txt` else
  `basename $IDENTITY_DIR` if unset, (5) `THINKERS_DIR` defaults to
  `$IDENTITY_DIR/thinkers` if unset, (6) `[[ -d "$THINKERS_DIR" ]] || die
  "Thinkers directory not found: $THINKERS_DIR"`, (7) `MEM_DIR`/`SKILLS_DIR`/
  `SKILLS_KERNEL_DIR`/`SHELLM_HOME` each default to `$IDENTITY_DIR/<sub>` if
  unset (never a die). The port's `requireEnv` originally only checked the
  four vars were non-empty STRINGS (no existence check at all — step 6
  above) — first fixed by checking `THINKERS_DIR` with `fs.statSync`. That
  fix was verified against two scenarios, `missingThinkersDir` (a real
  identity with `thinkers/` removed) and `missingIdentityDir` (EVERY var,
  including `TRAJ_DIR`/`TRAJ_ID`, explicitly set to paths under a
  nonexistent identity dir) — both of which, on the real Bash side, ALSO
  land on step 6 (`_require_env` never sees `TRAJ_DIR`/`TRAJ_ID` as unset
  when they're explicitly provided), so they never actually exercised steps
  1-3's ordering. The sealed-holdout shape — `IDENTITY_DIR` set (to a
  nonexistent path) and NOTHING else identity-related — does: on the real
  Bash side it dies at step 2 (`TRAJ_DIR not set...`), but the port's
  `bin/thinkers.mjs` unconditionally called the port's activate-equivalent
  `resolveIdentityEnv()` whenever `IDENTITY_DIR` was merely present in
  `process.env` (a "helpfulness" with no upstream analogue — upstream's
  bin/thinkers never resolves anything itself outside `_require_env`, that
  is `identity shell <name>`'s job, done once, in a different process,
  before bin/thinkers ever runs), which synthesized `TRAJ_DIR`/`TRAJ_ID`
  from `IDENTITY_DIR` regardless of whether the caller ever set them —
  masking exactly the "activate never ran" case steps 1-3 exist to catch,
  and falling through to step 6's `Thinkers directory not found: <dir>`
  instead. A SECOND bug was found alongside this one, also invisible to
  every pre-existing test because none of them called through the actual
  `bin/thinkers.mjs` CLI entry point (all called `thinkersStatus`/etc.
  directly): the three step 1-3 checks baked `thinkers: error: ` into their
  own thrown message, and `bin/thinkers.mjs`'s top-level catch added a
  SECOND copy on top of that — `thinkers: error: thinkers: error: IDENTITY_DIR
  not set...` at the CLI level even though the bare message text looked
  correct at the library level. Fixed: `requireEnv` now reproduces steps 1-7
  above verbatim, in order, with no prefix baked into any of them (the
  `bin/thinkers.mjs` catch adds that single prefix once, matching upstream's
  `die()` byte-for-byte); `bin/thinkers.mjs` no longer pre-resolves anything
  from `IDENTITY_DIR` — it passes `process.env` straight through, exactly
  like upstream's own bin/thinkers (callers that need the port's
  activate-equivalent env — this port has no separate `identity shell` —
  build it themselves via `resolveIdentityEnv` before calling into
  `thinkersctl.ts`: `web/server/src/control.ts`, the `parity/{live,replay}`
  harnesses, and this file's own tests already did). Verified identical
  stdout ("")/stderr/exit code against the real Bash oracle for
  `status`/`start`/`stop`/`list`, across: `IDENTITY_DIR` itself missing (all
  vars explicit), `THINKERS_DIR` only missing (all vars explicit), AND the
  sealed-holdout shape (`IDENTITY_DIR` set, nothing else) at both the
  library level (hand-built `Partial<ThinkersEnv>` objects) and the real CLI
  level (`node bin/thinkers.mjs status` with an exact, non-merged env).
  Unit tests: test/thinkersctl.test.ts "missing THINKERS_DIR (BUG #67,
  bin/thinkers:151 …)" (the original 3 cases) plus "requireEnv
  startup-validation order (BUG #67, bin/thinkers:138-155 `_require_env`) —
  matrix" (9 new cases: each of IDENTITY_DIR/TRAJ_DIR/TRAJ_ID missing alone,
  IDENTITY_DIR-only against both a nonexistent and a real-but-unactivated
  dir, THINKERS_DIR missing both explicitly and IDENTITY_DIR-derived, the
  sealed holdout through the real CLI for all four subcommands, the
  double-prefix regression check, and a fully-activated real identity
  through the CLI as a sanity control). Also extended
  `parity/daemon/run-parity-adversarial.mjs`'s "misuse" flow with a third
  `identityDirOnly_*` scenario (12 checks: status/start/stop/list ×
  stdout/stderr/exit) alongside the pre-existing `missingThinkersDir_*`/
  `missingIdentityDir_*` ones, run against the real Bash oracle
  (`PARITY_HEADLONG_ROOT=<headlong checkout> node
  parity/daemon/run-parity-adversarial.mjs`) — all 12 PARITY.

### `identity` subcommand inventory (port/identity-list lane)

Every subcommand `tools/identity` offers (from its own `usage()`, tools/identity:1509-1543), and
what — if anything — in this port calls it. Only `list` had an actual caller with no port
support, so only `list` was ported in this lane; per the lane's instructions, a subcommand gets
its own Gaps row only when something in the port calls it and it isn't ported. That is true for
none of the remaining nine below (each checked by grepping this whole checkout, `tui/`, `web/`,
`src/`, `bin/`, `scripts/` for `identity <subcommand>` call sites —
comments/doc-strings/error-message text pointing a human at a Bash command, e.g. "Run: identity
shell <name>", are not calls and are noted as such, not counted as "needed by").


> Table converted to sections for GitHub rendering.

### new

- **Status:** ported (pre-existing, `src/identity.ts` `identityNew`)

- **Needed by:** `web/server/src/control.ts` `identityNew` (calls the library function directly, not the CLI); `bin/identity new` itself

### list

- **Status:** **ported (this lane)**, `src/identity.ts` `identityList` + `bin/identity.mjs list`

- **Needed by:** Rust TUI's `/identities` mode — `run_cmd("identity", &["list"])`, `tui/headlong/src/main.rs:759`

### info

- **Status:** not ported

- **Needed by:** no caller found anywhere in this port

### sync-kernel

- **Status:** not ported

- **Needed by:** no caller found

### sync-thinkers

- **Status:** not ported (this CLI subcommand specifically)

- **Needed by:**

no caller found in the port's own code. (`parity/upstream-tests/run.mjs`'s daemon lane runs
upstream's OWN Bash test `test_identity_sync_thinkers.sh` against a scratch copy substituting
`bin/identity.mjs` for `tools/identity` — that upstream TEST calls `identity sync-thinkers` and
fails, a pre-existing documented gap, not a new caller inside this port.) **Not the same thing
as `POST /api/identities/:id/thinker-sync`**, which is now real (routes-c lane) — that web
route's oracle is `headlong_web/thinker_sync.py`'s `sync()`, called DIRECTLY by `server.py`'s
route handler, never through `tools/identity sync-thinkers` at all; this port's
`web/server/src/thinker-sync.ts` ports that Python module, not this CLI subcommand. See the "web
control plane" module row.

### default

- **Status:** not ported

- **Needed by:** no caller found

### delete

- **Status:** not ported

- **Needed by:** no caller found

### export

- **Status:** not ported

- **Needed by:**

no caller found (`web/viewer/app/routes/home.tsx:166` and `config.tsx:281` mention "`identity
export`" only in help/doc TEXT shown to a human, never invoked)

### import

- **Status:** **ported (routes-c lane)**, `src/identity.ts` `identityImport` + `bin/identity.mjs import`

- **Needed by:**

`web/server/src/control.ts` `identityImport` (calls the library function directly, not the CLI)
for `POST /api/identities/import`; `bin/identity import` itself. See the "web control plane"
module row and the "Web control-plane deviations" table's `identity import` rows for what
differs from `_install_imported_identity`. Differential:
`parity/identity/run-import-parity.mjs`, 6/6 PARITY vs the real Bash `tools/identity
export`+`import`.

### shell

- **Status:** not ported

- **Needed by:**

no caller — `resolveIdentityEnv()` (`src/identity-env.ts`) supplies the same env vars as a pure
function for every port code path that needs them (DIRECTOR CORRECTION 1); the many "Run:
identity shell <name>" strings (`src/focus.ts`, `src/chat.ts`, `src/steprun.ts`,
`src/retrieval.ts`, `src/thinkersctl.ts`) are human-facing error-message text, not calls

### prompt

- **Status:** not ported

- **Needed by:**

no caller — the port assembles its system prompt a different way (`src/prompts.ts`,
`src/steprun.ts`); "`identity prompt`'s core-identity block" comments there describe what
upstream text was ported into the constant, not a shell-out


### `mem search` mid-wake: what the sandbox env must carry

The shellm loop (`src/shellm.ts`) execs the model's bash with `{...execEnv, PATH: <binDir>:<nodeDir>:<system PATH>, SHELLM_RUN_STEP_ID, SHELLM_WORKDIR, HOME: <workdir>}`, where `execEnv` (src/monolith.ts) is `IDENTITY_NAME, TRAJ_DIR, TRAJ_ID, MEM_DIR, SKILLS_DIR, SHELLM_MODEL, SHELLM_TRUNCATE` + the identity's own `execEnv`. DockerSandbox forwards exactly that set as bare `-e NAME` flags. For `mem search` → `llm` to work:

- already forwarded: `PATH` (resolves `llm` and `node`), `SHELLM_MODEL` (the default model when `SHELLM_FAST_MODEL` is unset — `mem` passes the latter as `-m`), `IDENTITY_NAME` (ledger identity stamp), `SHELLM_RUN_STEP_ID` (ledger `run_id`), `HOME=<workdir>` (so the state home defaults to `<workdir>/.headlong`: health marker at `<workdir>/.headlong/run/llm_health.json`, ledger at `<workdir>/.headlong/usage/llm.jsonl`).
- must be added to the identity's `execEnv` (nothing forwards it today): the provider key — `OPENROUTER_API_KEY` for the default `vendor/model` names (or `OPENAI_API_KEY` / `OPENCODE_API_KEY`), or `LLM_PROVIDER=openai-compatible` + `LLM_API_URL` (or `SHELLM_API_URL`) [+ `LLM_API_KEY`] for a local endpoint. Alternatively a `.env` in the workdir or in `<workdir>/.headlong/.env` supplies them through the tool's own `.env` layering with no env forwarding at all.
- optional: `SHELLM_FAST_MODEL`, `HEADLONG_HOME`/`SHELLM_HOME` (to relocate marker + ledger), `IDENTITY_DIR` (ledger → `$IDENTITY_DIR/usage/llm.jsonl`), `LLM_USAGE_LEDGER`, `LLM_RETRIES`/`LLM_RETRY_BACKOFF`/`LLM_MAX_TIME`/`LLM_SPEED_*`, `LLM_MAX_TOKENS`.

### sandbox parity fixes (behavioral, now matching Bash)

- **host HOME leaked into the docker CLI's own env (PORT-BUG, found in a live run)** —
  FIXED in `src/sandbox-docker.ts` `DockerSandbox.buildChildEnv`/`buildDockerExecArgs`.
  `req.env` always carries `HOME=<workdir>` (`src/shellm.ts`, mirroring
  `bin/shellm:1309-1328`'s `docker_env_flags+=(-e "HOME=$workspace")`), and
  `buildChildEnv` was overlaying every non-`PATH` `req.env` key — including that
  workdir `HOME` — onto the env of the HOST `docker` process itself (the process
  that runs `docker exec`, not the container). With `HOME` pointed at the workdir,
  the host docker CLI can't find `~/.docker/config.json`, silently falls back to
  the default socket, and every `docker exec` fails
  (`failed to connect to the docker API at unix:///var/run/docker.sock`) even
  though `docker run`/container creation — which doesn't read that config —
  still succeeds. `buildDockerExecArgs` had a matching second bug: its bare
  `-e NAME` loop also emitted a bare `-e HOME` for the same key, duplicating the
  explicit `-e HOME=<workdir>` it already pushes for the container. Fix: `HOME`
  is now treated exactly like `PATH` in both methods — dropped from the generic
  per-key loop, host `HOME` never overlaid, and the container still gets exactly
  one `-e HOME=<workdir>` (upstream's `bin/shellm:1309-1328` never puts `HOME` in
  `env_vars` either — grep confirms the only `HOME=` sites in `bin/shellm` are the
  two explicit `-e HOME=$workspace` docker flags, lines 869 and 1320). LocalSandbox
  is untouched: it never inherits `process.env` at all (`env: req.env` is the
  entire child env), so its `HOME=<workdir>` behavior is unaffected. Regression
  tests: `test/sandbox-docker.test.ts` (`buildChildEnv` host-HOME case,
  `buildDockerExecArgs` single-HOME-flag case, and a real-docker-daemon round
  trip through `selectSandbox`); `scripts/live-proof.ts` and
  `test/live-loop.test.ts` now also require at least one `shell-output` row with
  `exit:0` in the trajectory, so a broken exec path can never pass either
  acceptance oracle silently again.

- **PORT-NOTE (bug #70, director-verified live run, bin/shellm:216-221
`_shellm_container_api_url`) — a Docker sandbox's `LLM_API_URL`/`SHELLM_API_URL` stayed
loopback, never rewritten at run time.** `mem search` inside the sandbox got `connect
ECONNREFUSED 127.0.0.1:<port>` ×5: a loopback URL names THIS HOST from inside the container, not
the sandbox. Upstream rewrites it to `host.docker.internal` for the container's exec env
(bin/shellm:2659-2662/2679-2680/2712) and adds `--add-host host.docker.internal:host-gateway` to
the container it starts (bin/shellm:1026-1034), gated on the SAME loopback predicate so the two
can never disagree; this port did both ONLY at install time (`src/init.ts`'s
`localContainerUrl`, `src/install-lib.ts`'s `dockerForwardArgs`), never at run time in
`src/sandbox-runtime.ts`/`src/steprun.ts`. FIXED: `src/sandbox-runtime.ts` gains
`containerApiUrl` (wraps the shared `net-url.ts` `urlIsLoopback`/`urlHostSwap`
`init.ts`/`install-lib.ts` already use) and `applyDockerApiUrlRewrite` (rewrites only
`SHELLM_API_URL`/`LLM_API_URL`, only when `envType==="docker"`); `src/steprun.ts`'s `runStep`
calls it once, right after `selectSandbox` resolves the env type — the host-side
`buildLlmClient` call is untouched, keeping the original loopback URL (matching "the main shellm
process keeps the host URL", bin/shellm:2657-2658). `startDockerSandbox`'s fresh `docker run`
gains `--add-host host.docker.internal:host-gateway` under the identical predicate
(`needsHostGateway`). Scope note: this port has no wired equivalent of upstream's
process-vs-file endpoint-alias canonicalization (`resolveShellmApiUrl` in `src/shellm.ts`
remains unwired, per the "callout (c)" entry elsewhere in this file), so the two env vars are
rewritten independently rather than from one canonical value — identical to upstream whenever
they already agree, which is the common case. Tests: `test/sandbox-runtime.test.ts` (rewrite
matrix incl. IPv6 `::1`, userinfo/port/path preservation, non-loopback passthrough;
`applyDockerApiUrlRewrite` local-vs-docker; `--add-host` present/absent via a fake `docker`),
`test/sandbox-runtime-docker.test.ts` (REAL docker: unrewritten URL refused from inside the
container, curl exit 7; rewritten URL reaches a real host-loopback listener through
`--add-host`), `test/steprun.test.ts`'s new Docker-mode `runStep` wiring test (fake `docker` on
PATH, no daemon). `parity/sandbox/run-parity.mjs`'s new `loopback-rewrite` scenario.

- **flat wall-clock timeout instead of an inactivity watchdog (bug #33, RUNTIME-SEAMS.md §B priority item 2)** —
  FIXED in `src/sandbox.ts` (`execWithInactivityWatchdog`, shared by
  `LocalSandbox` and `DockerSandbox`). Before: both sandboxes ran
  `spawnSync({timeout: inactivityMaxMs})` — a single 900s wall clock that
  fires whether or not the command is actively producing output, the exact
  opposite of `bin/shellm:2618-2690`'s design (kill on genuine SILENCE only:
  a short idle timer that resets on any output byte, plus a longer hard
  ceiling that resets only on real output). Fix: `exec()` is now `async`
  (`Sandbox.exec(): Promise<ExecResult>`, a real `spawn()` not `spawnSync`),
  and tracks the same two independent timers upstream does — see the `KILLED`
  kill-reason deviation row above (now RESOLVED) for the full mechanism, the
  "nested"→"max" label note, and the DockerSandbox-beacon-unreachability
  finding (a faithful reproduction of an upstream limitation, not a new gap).
  A second, independent bug surfaced while proving this against a real silent
  `sleep N`: killing only the direct child (bash, or docker-exec'd-into-bash)
  left an orphaned foreground grandchild (`sleep` itself) holding the stdout
  PIPE open, so Node's `'close'` event — and the resolved `ExecResult` —
  waited for the grandchild's OWN natural exit regardless of the watchdog
  kill. Fixed the same way `src/llmAdapterProcess.ts`'s `killGroup` already
  does: `spawn(..., {detached: true})` (a new POSIX process group) and
  signal `-child.pid` instead of `child.pid`, so the whole group dies
  together. `Sandbox.exec` going async has no ripple beyond the two direct
  callers: `src/shellm.ts`'s single call site (`await`ed) and each test/
  harness call site (`test/sandbox-docker.test.ts`,
  `parity/sandbox/run-parity.mjs`); `mapSpawnResult` (src/sandbox-docker.ts)
  is no longer called from `exec()` but stays exported and directly
  unit-tested (documented dead-in-production, not removed). Oracle-can-fail
  proof: disabling the reset-on-real-output branch turned the "prints every
  400ms, should survive a 2s idle timeout" scenario red (killed at ~2s
  instead of running to completion) on both sandboxes; reverted, confirmed
  green again. Constants: `SHELLM_INACTIVITY_TIMEOUT` (new,
  `ShellmConstants.inactivityTimeoutMs`, default 30s) alongside the existing
  `SHELLM_INACTIVITY_MAX` (`inactivityMaxMs`, default 900s unchanged), both
  through `constantsFromEnv`. Tests: test/sandbox-watchdog.test.ts,
  test/shellm.test.ts's bug #33 describe block, `parity/sandbox/run-parity.mjs`
  (7/7, new `idle-kill` scenario), `parity/upstream-tests/run.mjs`'s newly
  classified `test_inactivity_beacon.sh` (5/5, oracle-only — see that file).

