# Undercurrent guide

The reference material that used to live in the README: requirements, installing onto a machine, local models, the
web control plane, the bridges, the Rust TUI, tests and parity, known gaps and the repository layout. Start with the
[README](../README.md); the command and file contracts are in [CLI.md](CLI.md) and [FORMATS.md](FORMATS.md), and
what is verified against upstream is in [PARITY.md](../PARITY.md).

## Requirements

- **Node 22.18+** (required). The engine and the web data layer run `.ts` directly through Node's built-in type stripping, on by default since 22.18.0; Node 20 fails with `ERR_UNKNOWN_FILE_EXTENSION`. `.nvmrc` pins 22.
- **pnpm** for the root workspace (`web/` and `web/server/` use npm).
- Optional: **Bun 1.4.4+**. Every launcher in `bin/` and the shipped thinker step files run `$HEADLONG_TS_RUNTIME`, else `bun` when it is on PATH, else `node`. The port never installs Bun.
- Optional: **Docker**, the default sandbox for the model's shell commands whenever a daemon answers `docker info`; Docker-backed tests skip when there is none. `SHELLM_SANDBOX=local` runs commands on the host instead.
- An API key for an LLM provider (Anthropic, OpenAI, Gemini, OpenRouter, OpenCode/Zen) or any OpenAI-compatible endpoint, to run a real identity. The tests need none.

## Install (a real machine, not just this checkout)

Faithful ports of upstream's `install.sh`/`status.sh`/`uninstall.sh`/
`tools/headlong-init` — zero Bash, same flags and env knobs, `PARITY.md`'s
init/install/status/uninstall rows have the differential proof.

```bash
# from a checkout
node install.mjs --init          # installs bin/'s 16 CLIs onto PATH, then bootstraps a first identity

# one-liner (no checkout needed) — clones to ~/.headlong/app, symlinks, bootstraps
curl -fsSL https://raw.githubusercontent.com/wolfyy970/undercurrent/main/install.mjs | node -

node status.mjs                  # read-only: what's installed, what's running
node uninstall.mjs               # reverses install.mjs (identities backed up by default)
```

`headlong-init` walks the Docker sandbox consent gate (`--dry-run` to
rehearse it; `HEADLONG_UNSANDBOXED=1` to accept an unsandboxed agent),
resolves an LLM provider (a pasted cloud API key, or `HEADLONG_PROVIDER=local`
for an OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, ...), interviews
you for the identity's name/personality/focus, then starts the monolith +
responder thinkers and the web dash. Every `HEADLONG_*` knob upstream
documents still works — see `bin/headlong-init.mjs --help` or `src/init.ts`'s
file header.

**Known deviations from upstream's installer** (see `PARITY.md`'s Gaps for
the full detail): this port bundles skill/thinker templates directly into
each identity, so `install.mjs` never creates a global `~/.skills/core-skills`
or `~/.headlong-thinkers`; `persona` (the per-identity `ada`/`ada stop`
command wrapper) is not shipped yet — use `node bin/chat.mjs`,
`node bin/thinkers.mjs stop <name>`, etc. directly.

## Local models

Undercurrent can use any server that speaks the OpenAI chat completions API —
llama.cpp, Ollama, vLLM, LM Studio — same as upstream, same env knobs. No API
key is needed unless you configured the server to require one.

Check the connection directly with `bin/llm`:

```bash
LLM_PROVIDER=openai-compatible \
LLM_API_URL=http://127.0.0.1:11434/v1/chat/completions \
node bin/llm.mjs -m qwen3:8b "hello"
```

To configure an existing identity without re-running the installer, add the
provider, server address, and model to that identity's `.env` (or the
process environment):

```bash
LLM_PROVIDER='openai-compatible'
SHELLM_API_URL='http://127.0.0.1:11434/v1/chat/completions'
SHELLM_MODEL='qwen3:8b'
```

Restart the identity's thinkers after changing an existing configuration
(`node bin/thinkers.mjs stop <name>` / `start`).

To let `bin/headlong-init.mjs` write the same settings during setup, pass
`HEADLONG_PROVIDER=local` (interactive prompt, or non-interactively):

```bash
HEADLONG_PROVIDER=local \
HEADLONG_LOCAL_URL=http://127.0.0.1:11434 \
HEADLONG_LOCAL_MODEL=qwen3:8b \
node bin/headlong-init.mjs
```

For a host installation, keep a local server address such as `127.0.0.1` or
`localhost`. This port rewrites the address to `host.docker.internal` only
when the sandboxed step actually runs inside Docker (`src/net-url.ts`, shared
by `init.ts` and `install-lib.ts`) — a full Headlong-in-Docker container uses
that to reach a server on the Docker host. On Linux, the model server must
listen on an address Docker can reach (e.g. llama.cpp `--host 0.0.0.0`,
Ollama `OLLAMA_HOST=0.0.0.0:11434`); use the machine firewall to keep it off
untrusted networks, since `host.docker.internal` gives sandboxed agent code
a route to whatever else is listening on the host.

## Web control plane: quickstart

The one command that runs both the API server and the viewer, with a live
control plane (not just a read-only viewer):

```bash
export OPENROUTER_API_KEY=sk-...                       # required to actually run a thinker
export SHELLM_MODEL=deepseek/deepseek-v4-flash-0731    # vendor/model, OpenRouter naming (this is the default)
export DOCKER_CONTEXT=colima                           # optional — selects a non-default Docker context; Docker is used automatically whenever any daemon answers `docker info`

pnpm install && (cd web && npm install)
node web/scripts/dev.mjs --root /path/to/identities --api-port 8787 --viewer-port 5273
# → viewer at http://localhost:5273, API at http://localhost:8787
```

`--root` is a directory that will contain identity folders; it is created on
first use if you create an identity through the UI. Omit it and the script
falls back to `$HEADLONG_ROOT`, then a sibling `headlong/.identities` checkout,
if either exists.

**Definition of done, verified end to end:** create an identity in the web UI
→ send it a chat message → its dispatcher spontaneously wakes on its own
schedule (no further input) → the wake is written to the trajectory and
persisted memory. The same identity directory, opened by the **Rust TUI**
(`tui/headlong`) instead of the web UI, renders the same chat history, thinker
status, and skills — see `tui/PARITY-RECEIPT.md` for the headless proof
against a live identity written entirely by this port's engine. The
deterministic version of the chat→wake→memory flow (no network, no cost, run
with `SHELLM_SANDBOX=local` for determinism) is `test/live-loop.test.ts` and
`web/server/test/e2e-live.test.ts`; the live, real-model version is
`pnpm live-proof` (see `PORTING.md`). Docker is the default sandbox whenever a
daemon answers `docker info` (`selectSandbox` in `src/sandbox-runtime.ts`),
proven against a real Docker daemon by `test/sandbox-docker.test.ts` — the
deterministic multi-step flow above forces the local sandbox instead, for
reproducibility.

## Web UI

The web control plane (`web/`) is the **original Headlong React viewer**, vendored verbatim (Apache-2.0), wired to a TypeScript data layer and a real control API — not just a read-only renderer. See the quickstart above for the one-command run.

```bash
cd web/server && npm install && npm test   # data-layer + control-route tests

cd web
npm install                                 # installs the viewer too (postinstall)
npm run dev  -- --root /path/to/identities  # Vite + API, hot reload  → http://localhost:5273
npm run build && npm run serve -- --root /path/to/identities --port 8787
```

Every web route Headlong upstream documents is real and mutates identity/
dispatcher state: `POST /api/identities` (create), `.../chat` (send),
`.../thinkers/start|stop`, `.../thinkers/:name/step|enable|disable`,
`POST /api/killall`, `PUT`/`DELETE .../env`, `.../thinker-sync`,
`.../recap/refresh`, `.../usage/refresh`, `POST /api/llm-health/probe`,
`POST /api/identities/import`, `POST /api/update` (self-update),
`.../export`/export-jobs, and `POST /api/push/subscriptions` — pass
`--read-only`/`HEADLONG_READ_ONLY=1` to the server to disable all of them
(403). Most read views work (mind log, timeline, chat, memories, thinkers,
health, search, fork tree); **Recap** and **Usage** views still render their
empty state (`GET` is a stub even though the matching `refresh` route is
real) — see `PARITY.md` and `web/README.md` for the full route
table.

## Bridges (Slack, Telegram)

Zero-Python, zero-new-deps ports of upstream's `headlong/slack` and
`headlong/telegram`. Each bridge is one process that watches an identity's
trajectory and relays chat both ways.

```bash
# Slack: needs a Socket Mode app (SLACK_BOT_TOKEN xoxb-..., SLACK_APP_TOKEN xapp-...)
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
node bin/headlong-slack-bridge.mjs /path/to/identities   # HEADLONG_SLACK_IDENTITY picks the identity

# Telegram: needs a bot token from @BotFather and your numeric Telegram user id as admin
TELEGRAM_BOT_TOKEN=... TELEGRAM_ADMIN_ID=... \
node bin/headlong-telegram-bridge.mjs /path/to/identities
```

**Known gap:** the live network leg of each (a real Slack Socket Mode
connection to `slack.com`, a real long-poll against `api.telegram.org`) is
not exercised in this environment — no bot tokens available here. The
differential harnesses (`parity/slack/`, `parity/telegram/`) prove parity
against a fake Slack/Telegram Bot API instead; see `PARITY.md`.

## Rust TUI

`tui/` is upstream's `headlong-tui`, a terminal chat/monitor client, vendored
**verbatim and unmodified** — this port's rule is Bash/Python → TypeScript,
**Rust stays native**. It never touches identity files directly; it shells
out to this port's `traj`, `chat`, `thinkers`, `identity`, and `skills` CLIs
on `PATH` (see `tui/PARITY-RECEIPT.md` for the exact commands and env vars
each mode depends on).

```bash
cd tui/headlong && cargo build --release   # needs cargo; binary at target/release/headlong-tui

# point it at an identity written by this port's engine:
IDENTITY_NAME=<name> \
IDENTITY_DIR=/path/to/.identities/<name> \
ROOT_TRAJ_ID=<the identity's root trajectory id, from info.txt> \
PATH="$(pwd)/../../bin:$PATH" \
./target/release/headlong-tui
```

In practice, run it through this port's `resolveIdentityEnv()`
(`src/identity-env.ts`) rather than setting those by hand — it derives every
var (and puts `bin/` first on `PATH`) from an identity directory alone.
`tui/PARITY-RECEIPT.md` records a headless run against a live identity,
including `/identities`, which lists real identities via the ported
`identity list` subcommand (`bin/identity`, verified 17/17 byte-identical
against the real Bash `tools/identity list` — see `parity/identity/`).

## Docker on macOS: where the identities root must live

With Colima (default `mounts: []`) only your home directory is shared into the
VM. An identities root outside `$HOME` (for example under `/private/tmp`) is
bind-mounted as an empty VM-local directory, and every write from inside the
sandbox fails with `EACCES`. Keep the state home under `$HOME` (the default
`~/.headlong`) or add the path to Colima's mounts. OrbStack and Docker Desktop
share all paths by default.

## Tests and parity

```bash
pnpm install
pnpm test        # replay/characterization + unit tests — deterministic, no network
pnpm typecheck   # tsc --strict, clean
pnpm build       # optional: emit dist/
```

The whole-repo suite (engine + web/server, `pnpm vitest run`) for release 0.1.0 (2026-10-30): **2,422 passed, 0
failed** on Linux (Node 22, no Docker daemon) and **2,406 passed, 0 failed** on macOS; macOS skips more because some
tests are Linux-only. Other skips are Docker-backed tests when no daemon answers and wire-model UI parity tests
(`web/server/test/parity.test.ts`) that need external sample identities not shipped here. A Docker-backed sandbox test runs
against whatever `docker info` resolves to (`DOCKER_CONTEXT` selects a
non-default context, e.g. `colima` — Docker is used automatically whenever
any daemon answers `docker info`) and skips cleanly if no daemon answers.

The tests are deterministic and need no API key or network. There is no fake model anywhere, in `src/` or in the
tests: a test that needs a model reply is served a **recorded real reply** (each recording names its model and date)
from a local OpenAI-compatible HTTP server, through the engine's real client on the `LLM_API_URL` path. Transport
tests (HTTP errors, timeouts, malformed JSON) use the same kind of server with labelled HTTP fixtures. Every recording
set is listed in [`test/support/README.md`](../test/support/README.md). To drive a **real** model instead, set `OPENROUTER_API_KEY` and run `pnpm real-wake` or `pnpm real-reactive` (manual scripts, a few cents per run; the key is read from the environment and never written to disk).

**Parity against upstream.** The differential harnesses run the real upstream Bash tool and the port over the same
inputs and compare stdout, stderr, exit code and on-disk state. They need an upstream checkout at the pinned commit:

```bash
PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/behavioral/run-parity.mjs
PARITY_BASH_LLM=/path/to/headlong/bin/llm node parity/llm/run-parity.mjs
PARITY_UPSTREAM_ROOT=/path/to/headlong node parity/upstream-tests/run.mjs   # upstream's own Bash test suites
```

Each harness writes `report.md` and `results.json` next to itself; `PARITY.md` has the recorded numbers.

## Known gaps

- The Slack/Telegram bridges are ported (`src/slack/`, `src/telegram/`) but their live network legs (real Socket Mode / real Telegram long-poll, against a real bot token) are not exercised in this environment — no token available. Differential proof runs against fake Slack/Telegram Bot APIs instead.
- The viewer's "Stop all" button uses a plain browser `confirm()` dialog — this matches upstream, not a regression.
- `install.mjs` never stages `~/.skills/core-skills` or `~/.headlong-thinkers` (this port's `identity new` bundles those directly instead); `persona` (the `ada`/`ada stop` per-identity command) is not shipped.
- The web control plane's `GET /api/identities/:id/recap` and `.../usage` views are still stubs (`available:false`); the corresponding `POST .../recap/refresh` / `.../usage/refresh` routes are real.
- Full list, proof pointers, and everything still open: `PARITY.md` → "Scope and known gaps".

## Layout

```
install.mjs     install onto PATH (checkout mode + curl|node one-liner bootstrap)
status.mjs      read-only: what's installed, what's running
uninstall.mjs   reverses install.mjs
src/            the engine (shellm loop, sandbox, dispatcher, thinkers, mem, skills, rollups, init/install/status/uninstall libs, slack/, telegram/)
bin/            the tool shims the sandboxed bash calls (traj, mem, skills, headlong-init, headlong-slack-bridge, headlong-telegram-bridge, …)
scripts/        manual "run against a real model" scripts (real-wake, real-reactive)
test/           engine tests + golden-trace replay harness
golden/         real captured trajectories used as the behavioral oracle (de-identified)
parity/         differential-parity harnesses + captured results vs. the original Bash tools
web/            web control plane (vendored viewer + TS data layer + control API)
tui/            upstream's Rust terminal UI, vendored verbatim (kept native — see PARITY.md)
SPEC.md         trace-grounded specification (cites the upstream Bash line by line)
PARITY.md       concise parity status map (detail under docs/parity/)
docs/parity/    module evidence, deviations, gaps, and historical sync notes
PORTING.md      how this port was built and tested
```
