# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a breaking change to `src/api.ts`,
`docs/CLI.md` or `docs/FORMATS.md` bumps the minor version.

## [Unreleased]

## [0.1.3] - 2026-11-06

### Changed

- Split `PARITY.md` into a concise overview plus linked detail pages under `docs/parity/` so
  GitHub can render the parity documentation. Claims, gaps, and deliberate deviations are
  preserved; history pages are marked historical. Live Slack/Telegram bridge legs remain deferred.

## [0.1.2] - 2026-11-05

### Added

- Public read-only `getIdentityActivity` API reports verified executing thinker steps, including responder work,
  without exposing private run-state files or counting idle, queued, scheduled or recently finished work as active.
- Public `verifyExecutionRoot` certificate lets embedders retain an execution-equivalent source archive already
  mounted in a live sandbox, while using the current API for environment resolution and activity. It checks exact
  execution inputs/configuration, permits only embedding API/release-version differences, and revalidates before use.

## [0.1.1] - 2026-11-05

### Added

- Public `resetIdentitySandbox` API for embedders changing an identity's sandbox mounts after draining its work.
  The engine verifies container ownership before removal and preserves metadata when Docker or ownership is uncertain.

## [0.1.0] - 2026-10-29

First release under the name Undercurrent (formerly the working name headlong-ts).

### Added

- TypeScript port of upstream Headlong at `2e39a3f` (laude-institute/headlong): the dispatcher, the monolith and
  responder thinkers, `shellm`, the CLI tools (`traj`, `chat`, `mem`, `skills`, `recap`, `llm`, `identity`,
  `thinkers`, `context`, `headlong-killall`, `headlong-init`), the installer (`install.mjs`, `status.mjs`,
  `uninstall.mjs`), the Slack and Telegram bridges and the web control plane. The Rust `tui/` and the React viewer are
  vendored.
- Public interface for embedders: `src/api.ts` (the package's only export), the CLI contract in `docs/CLI.md` and the
  on-disk formats in `docs/FORMATS.md`.
- Contributor tooling: one contribution guide (AI-written pull requests welcome with disclosure, CI gates, an
  evidence-based pull request template, `AGENTS.md`), and a CI secrets gate (gitleaks over the full history, fake test
  keys allowlisted in `.gitleaks.toml`). CI runs with read-only permissions and SHA-pinned actions.
- Port extension: team-room routing names (`room~<room>~<sender>`, `room~<room>`); see `PARITY.md`, "Port extensions
  for embedders".
- Differential parity harnesses against real upstream (`parity/`), with recorded results in `PARITY.md`.
- Project files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, CI,
  Dependabot.

### Fixed

- `LLM_CONNECT_TIMEOUT` bounds only the TCP connect, not the wait for the first byte (K1).
- A nested `shellm` honors `TRAJ_DIR` and nests its records under the parent (K2).
- A nested run writes its `run-summary` step (K3).
- Tests that passed only on macOS now pass on Linux too (pid-namespace lock owner, `headlong-killall` listing seam
  without a docker CLI, a non-executable adapter fixture, a watchdog loop that raced its ceiling).

### Known issues

- Known gaps and deliberate deviations from upstream are listed in `PARITY.md` and `docs/GUIDE.md` ("Known gaps").

[Unreleased]: https://github.com/wolfyy970/undercurrent/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/wolfyy970/undercurrent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wolfyy970/undercurrent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wolfyy970/undercurrent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wolfyy970/undercurrent/releases/tag/v0.1.0
