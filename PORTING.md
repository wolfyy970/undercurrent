# How this port was built

Headlong-TS was reconstructed from [laude-institute/headlong](https://github.com/laude-institute/headlong) (Bash, ~9k lines) **behavior-first** — the goal was to reproduce what the original *does*, not to transliterate its shell line by line. The method throughout was **differential testing against the real thing**.

The port was originally reconstructed against upstream `ed2dac6`, then
resynced lane by lane (installer, conversation memory, llm+shellm, web-ui —
see `PARITY.md`'s "Upstream sync 1b") to `7d29f9e`, and again lane by lane
(shellm/llm/context core, thinker engine core, Slack/Telegram bridges, web
control plane + viewer, and more — see `PARITY.md`'s "Upstream sync 1c") to
upstream's later `5458fee`, and then to `2e39a3f` ("Upstream sync 2e39a3f" in `PARITY.md`), which is the pin as of this writing. `PARITY.md`'s
"Scope and known gaps" header states the current pin.

## Oracle-first, differential

For every subsystem we captured the original's actual output and diffed the port against it, rather than trusting a reading of the source:

- **Golden traces (the key correction).** Early on the port was written from *studying* the Bash. That was not enough — the trait the original is built around (self-scheduled wakes and the reactive monolith/responder coupling) only shows up at runtime. So we **actually ran the original Headlong agent** (a real model over OpenRouter) and captured its trajectories to `golden/`. The engine tests replay those real traces through the port by serving replies derived from their recorded model responses over local HTTP to a real client and assert on **structure** — step types, ordering, `source`, `run_id` grouping, causal `trigger_step`, the `prompt`-vs-`message` distinction — never on nondeterministic model prose, stdout text, timestamps, or UUIDs.
- **Per-subsystem parity harnesses** (`parity/mem`, `parity/skills`, `parity/sandbox`, `parity/rollups`, `parity/ui`). Each runs the **real Bash tool** (or the original Python viewer backend) and the TypeScript port over the same inputs and diffs the results. The captured runs and reports are committed alongside each harness.
- **The oracle was proven able to fail.** We injected the original TS port's real defect — emitting the standing context as a chat `message` instead of a `prompt` step — and confirmed the characterization tests went red, then restored. An oracle that never fails proves nothing.

## Tester ≠ translator

The work was split across sub-agents **by subsystem**, and within each subsystem the agent that wrote the port was **not** the agent that verified it. Keeping translation and testing in separate hands stops a port from grading its own homework — the verifier reproduces the claim independently against the Bash oracle.

## Deliberate, documented deviations

A faithful port is not a bug-for-bug photocopy. Where the original's behavior is an artifact of Bash itself rather than intended semantics, the port deviates **on purpose**, and every case is recorded in `PARITY.md`. The two families:

- **Bash error text that embeds absolute paths and line numbers.** On a flag-misuse path, Bash's `${2:?msg}` prints `"<script>: line N: 2: <msg>"` to stderr — text that hard-codes the script's absolute path and a line number, is irreproducible from TypeScript, and is brittle to pin. The port instead emits a uniform `mem: error: <msg>` / `skills: error: <msg>`. Stdout and on-disk state are identical; only stderr wording differs, on a path no caller inspects.
- **`set -e` crash-quirks the source clearly meant to fall through.** A few Bash paths abort under `set -e`/`pipefail` before reaching fallback code the surrounding logic was plainly written to reach (e.g. listing a name-less skill by basename, or printing `"Cancelled."` on empty stdin). The port reaches the intended fallback and exits 0; on-disk state matches. We do not degrade the port to reproduce a crash of a path the source intended to complete.

There are also **adapted** boundaries where an exact reproduction is out of scope: the sandbox runs the model's block in a restricted local subprocess by default (a drop-in `DockerSandbox` is included). The trajectory event bus was in-process rather than a `tail -F` on the file; the real daemon (`src/daemon.ts`) now closes that gap — its `TrajFeeder` tails the trajectory file directly, so it sees every append regardless of which process wrote it. The in-process bus survives only as `src/topology.ts`'s deterministic test harness, by design. Both are called out in `SPEC.md` and `PARITY.md`, and the `env` metadata the original records is preserved either way.

## How to verify a claim

Every parity or coverage claim in this repo's docs traces to a command you can run yourself:

- `DOCKER_CONTEXT=colima pnpm vitest run` — the full unit + characterization suite (deterministic, no network; Docker-backed cases skip cleanly without a daemon).
- `node parity/<module>/run-parity.mjs` — per-tool differential harnesses (traj, mem, skills, recap, llm, killall, retrieval, chat, context, daemon, ui, rollups, sandbox, init, identity) that run the real Bash tool and the TS port over the same inputs and diff stdout/stderr/exit/on-disk state. Each honors `PARITY_BASH_<TOOL>` (e.g. `PARITY_BASH_TRAJ`, `PARITY_BASH_LLM`) to point at a real checked-out Bash `bin/<tool>`; without it, the harness looks for the tool on `PATH` or skips. (sub/put/glob/view/focus harnesses retired along with their tools — 1c: 12ca841.)
- `node parity/upstream-tests/run.mjs [--daemon] [--installer]` — replays the original Headlong repo's own Bash test suites against the port; `--daemon` additionally attempts the daemon-lane suites (thinkers start/stop/drain, wake_at) against a real spawned `src/daemon.ts`; `--installer` attempts the installer-lane suites (`test_sandbox_gate.sh`, `smoke_install.sh`, `test_uninstall.sh`) against the real `install.mjs`/`headlong-init.mjs`/`uninstall.mjs`.
- `node parity/init/run-parity.mjs` — differential harness for `bin/headlong-init.mjs` vs the real Bash `tools/headlong-init` (sandbox-gate matrix, dead-endpoint case; 3 local-provider scenarios skip in a sandbox where subprocess `curl` can't reach loopback).
- `node parity/identity/run-export-parity.mjs` — differential harness for `identity export` vs the real Bash `tools/identity export` (also `run-parity.mjs` for `identity list` and `run-import-parity.mjs` for `identities/import`).
- `node parity/telegram/run-parity.mjs` / `node parity/slack/run-parity.mjs` — differential harnesses that run the real Python bridge (`uv run`, unmodified upstream `telegram/`/`slack/` project) and the TS port side by side against a fake Telegram/Slack Bot API + a fake `headlong-web` `/chat` endpoint.
- `node parity/push/run-interop-proof.mjs` — real cross-language interop proof for web push (VAPID/RFC 8291) against the actual `py_vapid`/`pywebpush`/`http_ece` Python libraries in a scratch venv, both directions.
- `pnpm live-proof` — a real-model, real-daemon proof (needs `OPENROUTER_API_KEY`, costs a few cents): creates an identity, starts thinkers, sends a chat message, and hard-asserts on at least one real `shell-output` trajectory row with `exit:0` — the one thing a replay-client test can't fake. Not part of `pnpm test`, not run in CI.

## What this does and doesn't buy you

An **adversarial review pass** follows this work — the differential suite is the floor, not the ceiling, and it is aimed squarely at deterministic behavior.

We make no guarantees. But the differential testing described here — real captured traces plus per-subsystem parity against the original Bash tools — supports faithful reproduction of Headlong's **deterministic** behavior. Nondeterministic model output is, by nature, out of scope; the port fixes the harness around the model, not the model.
