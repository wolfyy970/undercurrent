# PARITY — Headlong Bash → TypeScript (reference port)

Release: Undercurrent v0.1.3 (documentation organization), upstream pin `2e39a3f`. Whole-suite numbers live in `docs/GUIDE.md` ("Tests and parity") and `CHANGELOG.md`.

This file is the **concise status map**. Detailed evidence, deviation rows, gap inventory, and porting history live under [`docs/parity/`](docs/parity/). This split reorganizes existing claims for GitHub rendering; it does **not** invent new parity results or claim live Slack/Telegram bridges were tested.

**Pinned upstream base: `2e39a3f`.** Historical sync notes: [upstream-sync-2e39a3f.md](docs/parity/upstream-sync-2e39a3f.md).

If not listed under [Deviations](docs/parity/deviations.md) or [Gaps](docs/parity/gaps.md), it is expected to behave like the source.

## Reading map

| Doc | What it holds |
| --- | --- |
| [modules.md](docs/parity/modules.md) | Per-module parity status and proof notes |
| [deviations.md](docs/parity/deviations.md) | Deliberate, reviewed deviations |
| [gaps.md](docs/parity/gaps.md) | Gaps / stub inventory |
| [behavioral-round.md](docs/parity/behavioral-round.md) | Historical real-model comparison |
| [upstream-sync-2e39a3f.md](docs/parity/upstream-sync-2e39a3f.md) | Historical sync to pin `2e39a3f` |
| [retired-tools.md](docs/parity/retired-tools.md) | Retired focus/glob/put/sub/view |
| [cutover-and-bugfixes.md](docs/parity/cutover-and-bugfixes.md) | Historical cutover + bug ledger |
| [port-extensions.md](docs/parity/port-extensions.md) | Embedder extensions |
| [replay-seam-and-k1-k3.md](docs/parity/replay-seam-and-k1-k3.md) | Replay seam / K1–K3 |
| [public-api.md](docs/parity/public-api.md) | Public `src/api.ts` note |
| [fixture-place-name.md](docs/parity/fixture-place-name.md) | Golden fixture place-name change |
| [upstream-oracle-recordings.md](docs/parity/upstream-oracle-recordings.md) | Oracle recordings round |
| `history-upstream-*.md` | Older sync lanes (1b / 1c) — historical |

## Scope and known gaps

Verified against `git ls-files` / `git grep` on this checkout at `main` `65d94d1`, not against old numbers. This section is the honest top-level map; the [module details](docs/parity/modules.md) and [Gaps](docs/parity/gaps.md) carry the detail and proof pointers.

**Ported** (Bash engine, tools, thinkers, web control plane, TUI kept native):

- The dispatcher/thinkers engine, the CLI tools (`traj`, `chat`, `mem`, `skills`, `recap`, `llm`, `identity`, `thinkers`, `headlong-killall`, `context`) — see [Parity by module](docs/parity/modules.md) for per-tool parity level and differential proof. `sub`, `put`, `view`, `glob`, `focus` were retired 1c (12ca841, upstream drops all five) — see [Retired tools](docs/parity/retired-tools.md); their historical rows are kept, not deleted.
- The web control plane
(`web/server/src/{control,safety,envfile,thinker-sync,usage,exportJobs,push,webpushCrypto,selfUpdate}.ts`,
`router.ts` mutations) — every web route is now real; `POST /api/update` (self-update) closes
the last gap: `POST /api/identities`, `.../chat`, `.../thinkers/start|stop`,
`.../thinkers/:name/step|enable|disable`, `POST /api/killall`, `PUT`/`DELETE .../env`,
`.../thinker-sync` GET+POST, `.../recap/refresh`, `.../usage/refresh`, `POST
/api/llm-health/probe`, `POST /api/identities/import`, `POST /api/push/subscriptions`, `POST
/api/push/unsubscribe` are real and mutate identity state (or, for probe, make one real LLM
call), gated by `_requireControls`. `GET /api/identities/:id/export`, `GET /api/export`, the
export-jobs family (`POST .../export-jobs`, `GET .../export-jobs`, `GET`/`DELETE
/api/export-jobs/:job_id`, `GET .../download`), and `GET /api/push/key` are real too, and —
matching upstream — NOT gated by `_requireControls`. See the "web control plane" and "web push" module rows in [modules.md](docs/parity/modules.md).
- `tui/` (Rust `headlong-tui`) — kept **native**, vendored **verbatim and unmodified**, not reimplemented in TypeScript, per this port's Rust-stays-native rule. Proof: `tui/PARITY-RECEIPT.md` (headless run against a live identity written entirely by this port's engine).
- The **installer scripts**: `tools/headlong-init` → `src/init.ts` + `bin/headlong-init.mjs`,
`install.sh` → `install.mjs` (+ `src/install-lib.ts`), `status.sh` → `status.mjs` (+
`src/status-lib.ts`), `uninstall.sh` → `uninstall.mjs` (+ `src/uninstall-lib.ts`) — see the
init/install/status/uninstall module rows in [modules.md](docs/parity/modules.md). Two ARCHITECTURAL differences from upstream (not stubs — see [Gaps](docs/parity/gaps.md)): this port's `identity new` bundles skills/thinker templates directly, so
`install.mjs` never creates `~/.skills/core-skills` or `~/.headlong-thinkers`; and `persona`
(the per-identity command wrapper) is not shipped at all.

**Bridges ported, live leg deferred:**

- The Python **Slack bridge** is now ported (`src/slack/`, `bin/headlong-slack-bridge(.mjs)`) —
see the "slack bridge" module row in [modules.md](docs/parity/modules.md) and `parity/slack/` for the differential proof. The live
leg (a real Slack app connecting Socket Mode to `slack.com`) is NOT exercised anywhere — no
Slack bot/app-level token is available in this environment; the differential harness proves
parity against a fake Slack Web API instead, and `socketmode.ts`'s transport is exercised only
against a fake WebSocket in a unit test (see that module row).
- The Python **Telegram bridge** is now ported (`src/telegram/`, `bin/headlong-telegram-bridge(.mjs)`) — see the "telegram bridge" module row in [modules.md](docs/parity/modules.md) and `parity/telegram/` for the differential proof. The live leg (a real bot token calling the real `api.telegram.org`) is NOT exercised anywhere — no Telegram bot token is available in this environment; the differential harness proves parity against a fake Telegram Bot API instead (see that module row).

**Not ported at all** (confirmed absent from this checkout by `git ls-files`, not required for a reference port — see [Upstream sync 1b](docs/parity/history-upstream-1b.md) → "Not carried, by decision"):

- The **macOS app** (upstream `macos/`) — not vendored, not reimplemented.
- **`deploy/`** (upstream systemd units, Terraform, bootstrap scripts) — not ported; this port ships no deployment tooling.

**LLM providers: all ported.** `src/llmCli.ts`'s `<provider> provider wire path not yet ported`
die is now unreachable in practice — every provider `--provider`/`LLM_PROVIDER` documents is
wired: `openai`, `openrouter`, `opencode-go`, `openai-compatible` (`src/llmProvider.ts`
`OPENAI_FAMILY`), plus `anthropic` (`claude-*`), `gemini` (`gemini-*`), `opencode` (Zen,
`opencode/*` — distinct from `opencode-go/*`), and `adapter` (the `LLM_ADAPTER` exec seam). This
is the llm-providers lane (not an Upstream-sync-1b triage lane — a pre-existing gap in the
port's own coverage, closed independently): see [Deviations](docs/parity/deviations.md) → "llm slice 2 parity fixes",
`parity/llm/run-parity.mjs` (33+3 new scenarios, 220/220 effective, 0 port bugs), and
`parity/upstream-tests/run.mjs`'s `test_llm_adapter.sh` (4/20 → 20/20).

**Web routes returning 501: NONE — this list is now empty.** (`web/server/src/router.ts`'s
mutation catch-all at the bottom of `handleMutation` is still real code, reachable only by a
route this port has never heard of at all — there is no longer any KNOWN upstream route that
falls into it.) `POST /api/killall` (router.ts:554-563) is real, wired to `src/killall.ts`,
returning `{ok, dry_run, stdout, stderr}`; `PUT`/`DELETE /api/identities/:id/env`,
`.../thinker-sync` (GET+POST), `.../recap/refresh`, `.../usage/refresh`, `POST
/api/llm-health/probe`, `POST /api/identities/import`, `GET /api/identities/:id/export`, `GET
/api/export`, `POST /api/identities/:id/export-jobs`, `GET .../export-jobs`, `DELETE
/api/export-jobs/:job_id`, `GET /api/export-jobs/:job_id`, `GET
/api/export-jobs/:job_id/download`, `GET /api/push/key`, `POST /api/push/subscriptions`, `POST
/api/push/unsubscribe`, and `POST /api/update` are all real — see those module rows in [modules.md](docs/parity/modules.md).

**In-process bus gap (thoughts → retrieval)**: **resolved for the real daemon** —
`src/daemon.ts`'s `TrajFeeder` tails the trajectory file directly, so it sees every append
(including the monolith's own thoughts/observations) regardless of which process wrote it,
matching upstream's file-tail bus. **Still a gap for `src/topology.ts`**, which stays an
in-process test harness by design and never sees out-of-process appends — this is intentional (a
deterministic test double), not a runtime limitation. See the Gaps table row for the
daemon-vs-topology distinction and daemon.test.ts for the closing proof.

**Sandbox bind-mount scope (whole-repo, not per-tool)**: upstream's `bin/shellm`
(`bin/shellm:866-916`, function around `docker_run_flags`) mounts each sandboxed tool
individually, read-only, at its own path — `-v "$tool_path:/usr/local/bin/$tool:ro"` per tool in
`shellm_tools=(llm traj context shellm-explore headlong skills mem shellm-docker
shellm-docker-broker)`. This port's `src/sandbox-runtime.ts:140-143` instead bind-mounts the
**whole port checkout** (`opts.portHome`, the repo root or `HEADLONG_TS_HOME` — see
`src/steprun.ts:206`) read-only in one shot: `-v "${opts.portHome}:${opts.portHome}:ro"`.
Functionally equivalent (every tool the model's bash can reach is still read-only), but coarser:
the sandboxed process can see the whole port source tree read-only, not just the individual tool
binaries upstream exposes. Not tracked as a Deviation row (no differential harness exercises
directory listing inside the sandbox) — recorded here as a known scope difference.


## Oracle

- Frozen surface: the trajectory JSONL step stream — step `type` sequence, `source`,
  `run_id` grouping, causal `trigger_step`, and per-step semantics (a `prompt` step is
  standing context, NOT a chat `message`; `reasoning` carries bash in `cmd`; responder
  `decision:"no-reply"` observation with zero reply messages). NOT on surface:
  nondeterministic model prose, stdout text, timestamps, step_id UUIDs.
- Oracle = characterization tests replaying real pax golden traces. golden/: trace-00
  (boot+convo, 112), trace-01 (timer wakes, 238), trace-02 (NO_REPLY+reactive, 279),
  trace-04 (weather delivery-gap, 62). Model replies served over local HTTP (test/support/modelHttpFixture.ts) for determinism.
- **Oracle proven to fail: 2026-08-28** — injected the original port's real bug (standing
  context emitted as `message` not `prompt`); characterization test went red (2 failed);
  restored. The oracle catches the regression that matters.
- One-command run: `pnpm test` → **2382 passed / 39 skipped / 0 failed** (v0.1.0, 2026-10-29, clean Linux export and macOS; see `docs/GUIDE.md`). Earlier: 1122 passed / 4 skipped (2026-09-02, routes-c lane). The 4 skips are the
  wire-model UI parity tests (`web/server/test/parity.test.ts`), which need the
  external pax sample identities not shipped in this checkout. The 480 tests that
  predate the retrieval port are untouched; retrieval adds 56 (test/retrieval.test.ts).
  The CLI-rest lane (sub/killall/enable-disable) adds the remaining 54: 29
  (test/sub.test.ts), 15 (test/killall.test.ts), 10 (thinkersctl enable/disable cases).
- golden/trace-05-retrieval: the retrieval thinker live on pax (rows 676-856, the
  dispatcher's retrieval lines, index.tsv, seen, the 14 memories) — a deterministic,
  no-LLM oracle; see its NOTES.md for the probe artifact (row 676) and the post-edit
  caveat (row 856).


## Parity by module

Full evidence: [docs/parity/modules.md](docs/parity/modules.md). Summary:

| Module | Status | Parity |
| --- | --- | --- |
| [trajectory/schema — WRITE PATH ONLY (trajCore.mjs, types)](docs/parity/modules.md) | green | 100% |
| [traj CLI (bin/traj / src/trajCli.ts + bin/traj.mjs)](docs/parity/modules.md) | green | PARITY |
| [shellm inner loop](docs/parity/modules.md) | green | 100% |
| [extract (reasoning/code)](docs/parity/modules.md) | green | 100% |
| [sandbox (LocalSandbox)](docs/parity/modules.md) | green (adapted) | n/a |
| [backoff / wake_at](docs/parity/modules.md) | green | 100% |
| [dispatcher](docs/parity/modules.md) | green | 100% |
| [responder + NO_REPLY](docs/parity/modules.md) | green | 100% |
| [monolith reactive coupling](docs/parity/modules.md) | green | 100% |
| [chat CLI (bin/chat / src/chat.ts + bin/chat.mjs)](docs/parity/modules.md) | green | PARITY |
| [mem / recall / learn](docs/parity/modules.md) | green | PARITY |
| [skills (authoring + invoke)](docs/parity/modules.md) | green | PARITY |
| [skills content (`src/assets/skills/`, vendored)](docs/parity/modules.md) | green | 100% |
| [chat outward delivery](docs/parity/modules.md) | STUB / faithful-gap | n/a |
| [memory tiered rollups](docs/parity/modules.md) | green | PARITY |
| [recap CLI (bin/recap: map-reduce episodes/themes + `--context` staircase)](docs/parity/modules.md) | green | PARITY |
| [retrieval thinker (passive no-LLM recall; third thinker, opt-in)](docs/parity/modules.md) | green | PARITY |
| [llm tool (all wire paths: openai, openrouter, opencode-go, openai-compatible, anthropic...](docs/parity/modules.md) | green | PARITY |
| [daemon (`src/daemon.ts` + `bin/dispatcherd.mjs`)](docs/parity/modules.md) | green | PARITY (adversarial) |
| [runstate (`src/runstate.ts`)](docs/parity/modules.md) | green | 100% |
| [feeder (`src/feeder.ts`)](docs/parity/modules.md) | green | 100% |
| [steprun (`src/steprun.ts` + `bin/thinker-step.mjs`)](docs/parity/modules.md) | green | 100% |
| [identity (`src/identity.ts` + `bin/identity.mjs`)](docs/parity/modules.md) | green | subset |
| [identity list (`src/identity.ts` `identityList` + `bin/identity.mjs list`)](docs/parity/modules.md) | green | PARITY |
| [identity import (`src/identity.ts` `identityImport` + `bin/identity.mjs import` + `src/...](docs/parity/modules.md) | green | PARITY (structural) |
| [identity export (`src/identity.ts` `resolveExportDirs`/`buildIdentityExportArchive`/`de...](docs/parity/modules.md) | green | PARITY (structural) |
| [thinkersctl (`src/thinkersctl.ts` + `bin/thinkers.mjs`)](docs/parity/modules.md) | green | PARITY (adversarial) + enable/disable |
| [sub (`src/sub.ts` + `bin/sub.mjs`)](docs/parity/modules.md) | green | 100% (19/19 differential) |
| [headlong-killall (`src/killall.ts` + `bin/headlong-killall.mjs`)](docs/parity/modules.md) | green | structural PARITY (7/7) + real-reaping proof |
| [sandbox-runtime (`src/sandbox-runtime.ts` + `src/sandbox-env.ts`)](docs/parity/modules.md) | green | 100% |
| [identity-env (`src/identity-env.ts`)](docs/parity/modules.md) | green | 100% |
| [`GET /api/identities/:id/dispatch` (`web/server/src/dispatchLog.ts`)](docs/parity/modules.md) | green | PARITY |
| [web control plane (`web/server/src/{control,safety,envfile,thinker-sync,usage,exportJob...](docs/parity/modules.md) | green | subset (Slice A + B + most of C + export + push) |

## Deviations (deliberate, reviewed)

Full deviation ledger: [docs/parity/deviations.md](docs/parity/deviations.md).

Also see the historical [behavioral parity round](docs/parity/behavioral-round.md).

## Gaps (every stub lives here — nothing stubbed silently)

Full gaps inventory: [docs/parity/gaps.md](docs/parity/gaps.md).

**Bridges honesty (unchanged):** Slack and Telegram bridges are ported and differentially proven against fake APIs; live Socket Mode / live `api.telegram.org` legs remain deferred — no real bot tokens in this environment.

## Open questions for humans
- (closed 2026-10-29) The live `skills prompt` / identity-prompt render was
  already wired per wake (`runStep` → `buildIdentityConfig`); the last static
  blob, in the manual `scripts/real-wake.ts`, now uses the same path.


## Anchor index (titles preserved for old links)

Older docs and comments cite section titles that used to live only in this file. The headings below remain as pointers:

### Parity by module

Detail moved to [`docs/parity/modules.md`](docs/parity/modules.md).

### Deviations (deliberate, reviewed)

Detail moved to [`docs/parity/deviations.md`](docs/parity/deviations.md).

### Gaps (every stub lives here — nothing stubbed silently)

Detail moved to [`docs/parity/gaps.md`](docs/parity/gaps.md).

### Behavioral parity round (real-model comparison, upstream 2e39a3f)

Detail moved to [`docs/parity/behavioral-round.md`](docs/parity/behavioral-round.md).

### Upstream sync 2e39a3f (5458fee → 2e39a3f)

Detail moved to [`docs/parity/upstream-sync-2e39a3f.md`](docs/parity/upstream-sync-2e39a3f.md).

### Upstream sync 1c, lane A (7d29f9e → 5458fee, shellm/llm/context core)

Detail moved to [`docs/parity/history-upstream-1c-lane-a.md`](docs/parity/history-upstream-1c-lane-a.md).

### Upstream sync 1c, lane G (7d29f9e → 5458fee, Slack bridge)

Detail moved to [`docs/parity/history-upstream-1c-lane-g.md`](docs/parity/history-upstream-1c-lane-g.md).

### Upstream sync 1c, lane B (7d29f9e → 5458fee, thinker engine core)

Detail moved to [`docs/parity/history-upstream-1c-lane-b.md`](docs/parity/history-upstream-1c-lane-b.md).

### Upstream sync 1b (ed2dac6 → 7d29f9e)

Detail moved to [`docs/parity/history-upstream-1b.md`](docs/parity/history-upstream-1b.md).

### Cutover

Detail moved to [`docs/parity/cutover-and-bugfixes.md`](docs/parity/cutover-and-bugfixes.md).

### bin/*.mjs stdout truncation on process.exit() before drain — RESOLVED (bug #40)

Detail moved to [`docs/parity/cutover-and-bugfixes.md`](docs/parity/cutover-and-bugfixes.md).

### Retired: focus/glob/put/sub/view (1c: 12ca841)

Detail moved to [`docs/parity/retired-tools.md`](docs/parity/retired-tools.md).

### Upstream sync 1c, lane E: identity/skills/thinker-sync (8c3f410, f1b8693, 6c324d1, 9a62727)

Detail moved to [`docs/parity/history-upstream-1c-lane-e.md`](docs/parity/history-upstream-1c-lane-e.md).

### Upstream sync 1c, lane I (7d29f9e → 5458fee, web control plane + viewer)

Detail moved to [`docs/parity/history-upstream-1c-lane-i.md`](docs/parity/history-upstream-1c-lane-i.md).

### Upstream sync 1c, lane L (context/chat triage misses)

Detail moved to [`docs/parity/history-upstream-1c-lane-l.md`](docs/parity/history-upstream-1c-lane-l.md).

### Port extensions for embedders (2026-10-29)

Detail moved to [`docs/parity/port-extensions.md`](docs/parity/port-extensions.md).

### Replay seam removal and K1-K3 (2026-10-29, branch feat/no-replay-seam)

Detail moved to [`docs/parity/replay-seam-and-k1-k3.md`](docs/parity/replay-seam-and-k1-k3.md).

### Public interface: src/api.ts (2026-10-29, branch feat/public-api)

Detail moved to [`docs/parity/public-api.md`](docs/parity/public-api.md).

### Fixture change for release: place name in the golden traces (2026-10-29)

Detail moved to [`docs/parity/fixture-place-name.md`](docs/parity/fixture-place-name.md).

### Upstream-oracle recordings round (2026-10-29, rec/lane-a + rec/lane-b + rec/lane-c → rec/integrate)

Detail moved to [`docs/parity/upstream-oracle-recordings.md`](docs/parity/upstream-oracle-recordings.md).

### Runtime is Bun (branch `feat/bun-runtime`) — DEVIATION, observable behavior unchanged

Detail moved to [`docs/parity/history-upstream-1c-lane-l.md`](docs/parity/history-upstream-1c-lane-l.md).

### Start-up window: a step appended right after boot is not delivered (upstream behaviour, kept)

Detail moved to [`docs/parity/upstream-sync-2e39a3f.md`](docs/parity/upstream-sync-2e39a3f.md).

### mem search prefilter/heartbeat/until (upstream sync 2, lane C)

Detail moved to [`docs/parity/deviations.md`](docs/parity/deviations.md).

### container-lifecycle fix + deviations (bug #32, this lane)

Detail moved to [`docs/parity/deviations.md`](docs/parity/deviations.md).

### sandbox parity fixes (behavioral, now matching Bash)

Detail moved to [`docs/parity/gaps.md`](docs/parity/gaps.md).

### Wake ledger: lost wakes on dispatcher restart (deliberate deviation, branch `sync/upstream-2e39a3f-lostwake`)

Detail moved to [`docs/parity/upstream-sync-2e39a3f.md`](docs/parity/upstream-sync-2e39a3f.md).

