# Port spec: Undercurrent (formerly headlong-ts) — Bash → TypeScript

This repository is a **faithful port** of [laude-institute/headlong](https://github.com/laude-institute/headlong) pinned at upstream `2e39a3f` (was `5458fee`; see PARITY.md "Upstream sync 2e39a3f"). The observable behavior of the Bash engine, CLI tools, thinkers, installer, bridges, and web control plane is reproduced exactly; the code is designed for TypeScript. Behavior is frozen; structure is free.

## Frozen surface

- **Trajectory JSONL step stream** — step `type` sequence, `source`, `run_id` grouping, causal `trigger_step`, per-step semantics (a `prompt` is standing context, NOT a chat `message`; `reasoning` carries bash in `cmd`; responder `decision:"no-reply"` observation with zero reply messages)
- **Run state files** — everything under `run/`: `step_pids` (space-separated), `active_thinkers`, `dispatcher.pid`/`dispatcher.token`, `pending/`, `traj_files`, `sub_map`, `<thinker>.wake_at`, `monolith_backoff_state.json`, `logs/` (byte-exact: the Rust TUI and macOS app read them)
- **Memory files** — `memories/*.md` (frontmatter + body, incl. `type: person` notes), rollups, the `messages.jsonl` history index next to the trajectory
- **CLI stdout/stderr/exit codes** — `traj`, `chat`, `mem`, `skills`, `recap`, `llm`, `identity`, `thinkers`, `headlong-killall`, `context`, and installer commands (`headlong-init`, `install.mjs`, `status.mjs`, `uninstall.mjs`) — `sub`/`put`/`view`/`glob`/`focus` retired (PORT-NOTE 1c: 12ca841, see PARITY.md "Retired: focus/glob/put/sub/view")
- **Web API shapes** — all routes under `/api/`; read routes (identity/trajectory/rollups) and mutation routes (create identity, chat, start/stop/step thinkers, killall, env update, export, push subscriptions, self-update)
- Not on surface: nondeterministic model prose, stdout text, timestamps, step UUIDs

## Oracle

- **Characterization tests** replay real golden traces (`golden/`): replies derived from the upstream runs are served by a local HTTP server and read through a real client on the `LLM_API_URL` path (`test/support/modelHttpFixture.ts`); no API key, no network, and no fake model in `src/`. Provenance of every served reply set: `test/support/README.md`
  - `trace-00`: boot + first three wakes + one chat exchange (112 steps)
  - `trace-01`: timer wakes + multi-turn convo (238 steps)
  - `trace-02`: NO_REPLY + reactive monolith wake (279 steps)
  - `trace-04`: weather delivery-gap scenario (62 steps)
  - Golden traces run: `pnpm test` (deterministic, no network)
- **Per-subsystem differential parity harnesses** (`parity/*/run-parity.mjs`) run the real Bash tools and the TS port over the same inputs; compare stdout/stderr/exit/state
  - Environment variables: `PARITY_BASH_<TOOL>` (e.g. `PARITY_BASH_TRAJ`, `PARITY_BASH_MEM`, `PARITY_BASH_HEADLONG_INIT`, `PARITY_BASH_SKILLS`, `PARITY_BASH_LLM`, `PARITY_BASH_CHAT`, `PARITY_BASH_IDENTITY`, `PARITY_BASH_THINKERS`, `PARITY_BASH_KILLALL`, `PARITY_BASH_CONTEXT`, `PARITY_BASH_RECAP`, `PARITY_BASH_RETRIEVAL`, `PARITY_BASH_BIN`), `PARITY_UPSTREAM_ROOT`, `PARITY_PY_TELEGRAM_DIR`, `PARITY_PY_SLACK_DIR`, `PARITY_TS_REPO`, `PARITY_HEADLONG_ROOT`, `PARITY_NO_CHMOD_SHIM` — `PARITY_BASH_SUB`/`PARITY_BASH_VIEW`/`PARITY_BASH_FOCUS`/`PARITY_BASH_PUT`/`PARITY_BASH_GLOB` retired with their tools (1c: 12ca841)
- **Upstream Bash test suites** via `node parity/upstream-tests/run.mjs [--daemon] [--installer]` — replay the original repo's test suites; `--daemon` exercises thinker start/stop/drain and wake scheduling against a live `src/daemon.ts`; `--installer` runs `test_sandbox_gate.sh`, `smoke_install.sh`, `test_uninstall.sh` against real `install.mjs`, `headlong-init.mjs`, `uninstall.mjs`
- **Oracle proven to fail** (2026-08-28) — injected the original port's real bug (standing context emitted as `message` not `prompt`); characterization tests caught it and went red; restored
- **Test suite status** at v0.1.0 (2026-10-29, clean Linux export, Node 22, no Docker): 2382 passed, 39 skipped, 0 failed on Linux (clean export, Node 22, no Docker) and on macOS (see `docs/GUIDE.md`, "Tests and parity").

## Definition of done (merge gate)

1. **Type-check passes** — both root and `web/server`: `pnpm typecheck && cd web/server && npm run typecheck`
2. **Full test suite passes** — `DOCKER_CONTEXT=colima pnpm vitest run` (Docker skips cleanly if no daemon)
3. **Scrub test clean** — `pnpm vitest run test/scrub.test.ts` (no local paths/PII added)
4. **No new dependencies** — `pnpm ls` and `web/server` `npm ls` unchanged
5. **No silent stubs** — grep for `find_stubs.py` or review commits for `unimplemented()` / `throw new Error("TODO")`
6. **Small, focused changes** — one change per branch or pull request, committing only the files it touches; rebase onto `main` before the final run
7. **Differential parity holds for the module you touched** — its `parity/<tool>/run-parity.mjs` re-run against the real upstream tool by the reviewer (not only by the author), expectations taken from running upstream, never from the port; per-scenario/per-field deviations only, each with a PARITY.md row; no scenario removed or loosened

## Known gaps (see PARITY.md → "Scope and known gaps")

- macOS app (`upstream macos/`) — not vendored
- `deploy/` (systemd/Terraform) — not ported
- Live Slack/Telegram legs deferred — differential harnesses prove parity against fake APIs; real bot tokens not available
- Docker is the default sandbox (one container per step, image `node:24-bookworm`); with Colima only `$HOME` is shared into the VM, so the identities root must live under `$HOME` (see `docs/GUIDE.md`)
- In-process bus gap (thoughts → retrieval) — resolved for real daemon (`src/daemon.ts`'s `TrajFeeder` tails the file); test harness `src/topology.ts` stays deterministic by design

## Rules

- Every semantic decision gets a `PORT-NOTE:` comment and a `PARITY.md` row
- No stubs (`unimplemented()`, `throw new Error("TODO")`, `NotImplementedError`) — stop and report if a unit cannot be ported
- Design for TypeScript (async/await, type system, ES modules); do not simulate Bash structure
- `import type` for interfaces (native type-stripping: Bun, or Node 22.18+ as the fallback runtime; see PARITY.md "Runtime is Bun")
- No absolute local paths or PII in code (test/scrub.test.ts catches violations)
- Contributions follow `CONTRIBUTING.md` (small tested changes, parity or a documented deviation, AI-written code disclosed, no secrets)

## Running the suite

Don't run two suites (or a suite alongside a live Docker session) concurrently
on one machine. Several test files spawn REAL subprocesses (`bin/dispatcherd.mjs`,
`bin/llm`, shellm loops) and assert on their exact timing/exit codes; heavy CPU
contention from a second run can starve the daemon before it installs its
signal handlers or delay a scheduled tick past a poll's deadline, flaking tests
that are 100% reliable alone. `fileParallelism: false` already serializes test
FILES within one run — it does not protect against a second `vitest`/docker
process running at the same time.

## How to verify

- `DOCKER_CONTEXT=colima pnpm vitest run` — full suite (deterministic, no network)
- `node parity/<module>/run-parity.mjs` — differential harness (use `PARITY_BASH_<TOOL>` env vars to point at real Bash tools)
- `node parity/upstream-tests/run.mjs [--daemon] [--installer]` — replay upstream's test suites
- `pnpm real-wake` / `pnpm real-reactive` — real-model proofs (needs `OPENROUTER_API_KEY`, costs a few cents)
