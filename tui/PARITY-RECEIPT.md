# TUI parity receipt

`headlong-tui` (vendored verbatim from upstream `tui/headlong`) was built with
`cargo build --release` on this machine (cargo 1.96.1) and run headlessly in a
Python-driven pty (`pty.fork()` + a `pyte` terminal emulator to render the
screen buffer to text — no `tmux` was available on this machine). The binary
was pointed at an identity directory written **entirely by the TypeScript
port** (`headlong-ts`), via the exact environment
`resolveIdentityEnv()` (`src/identity-env.ts`) produces for that identity —
`IDENTITY_NAME`, `IDENTITY_DIR`, `TRAJ_DIR`, `TRAJ_ID`/`ROOT_TRAJ_ID`,
`THINKERS_DIR`, `SKILLS_DIR`, `MEM_DIR`, and `PATH` with the port's `bin/`
first (so `traj`, `chat`, `thinkers`, `identity`, `skills` all resolve to the
TS port's own CLIs). No files were modified; only read-only commands
(`traj cat`, `traj tail -f`, `thinkers status`, `skills list`) were exercised
against the live identity `quill`, which has its own dispatcher and dev
server already running (left untouched).

Identity directory used: `<IDENTITIES_DIR>/quill`

## What the TUI reads

The Rust binary itself touches **no files directly**. Every piece of state
comes from shelling out to sibling CLIs on `PATH`, using env vars set by
whatever launched it:

| Mode / action | Command run | Env it depends on |
|---|---|---|
| History load (all modes, once at startup) | `bash -c "traj cat $ROOT_TRAJ_ID --filter type=message,human-msg,agent-msg --raw \| tail -n 20"` | `ROOT_TRAJ_ID` (falls back to `TRAJ_ID`) |
| Live follow (all modes, background) | `traj tail -f --filter type=message,human-msg,agent-msg -n 0 --raw [ROOT_TRAJ_ID]` | `ROOT_TRAJ_ID` / `TRAJ_ID` |
| `/chat` send | `chat send [--from NAME] <message>` | `--from` is the `--from` CLI flag to `headlong-tui`, not an env var |
| `/thinkers` (auto-refresh every 2s) | `thinkers status` | relies on `thinkers` resolving via `PATH` to the identity's dispatcher |
| `/traj` (auto-refresh every 2s) | `traj tail -r -n 50` | same trajectory env as above |
| `/identities` | `identity list` | — |
| `/skills` | `skills list` | — |
| any mode, free-text after entering it | `<mode-base> <typed args>` (e.g. `thinkers <args>`, `traj <args>`) | — |
| title bar | `IDENTITY_NAME` env var (defaults to `"agent"` if unset) | `IDENTITY_NAME` |
| `--from` chat sender | CLI flag only | — |

So the on-disk contract is entirely indirect, through the TS port's `bin/traj`,
`bin/chat`, `bin/thinkers`, `bin/identity`, `bin/skills` and whatever files
*those* read (trajectory JSONL under `IDENTITY_DIR/trajectories/<root>/`,
`IDENTITY_DIR/thinkers/*`, `IDENTITY_DIR/skills/*`, etc., per
`src/identity-env.ts`). The TUI never reads `info.txt`, `memories/`, or any
identity file itself.

## Build

```
$ cargo build --release
   Compiling headlong-tui v0.1.0 (…/tui/headlong)
    Finished `release` profile [optimized] target(s) in 10.58s
```

Clean build, no errors, no warnings, using the vendored `Cargo.lock` — no Rust
source was changed.

## Headless proof — `chat` mode (default)

Captured after 8s (history-load phase, `IDENTITY_NAME=quill`,
`ROOT_TRAJ_ID` = quill's root trajectory id):

```
you: Hi quill. Please remember that my favourite colour is teal, then tell me you've saved it.
quill: I've saved it — teal is your favourite colour.
```

This is quill's `message`-type trajectory content, read via `traj cat`
against the TS port's trajectory JSONL — i.e. content the TS engine wrote.

## Headless proof — `thinkers` mode

```
 thinkers
Identity:   quill
Dispatcher: running (PID 30396)
Concurrency: 20 max

Thinkers:
  monolith                       active (1 step(s))  [observation, action, merge, monolith-wake] (0 log lines)
  responder                      idle  [message] (0 log lines)
```

`Dispatcher: running` reflects the live dispatcher process for `quill` that
was already running before this session (left untouched); `thinkers status`
read it through the TS port's `bin/thinkers`.

## Headless proof — `traj` mode

```
 traj
2026/09/02 02:51:40 dbf27ca2/82067dd1 [shell-output] quill → you: I've saved it — teal is your favourite colour.
2026/09/02 02:51:59 dbf27ca2/6c7f49a0 [observation, monolith] Obsidian channel scoped: read skill doc, vault marker/search showed no active vault or unprocessed notes — all channels still quiet; idling.
2026/09/02 02:51:59 dbf27ca2/946d1c5b [reasoning] All quiet channels stay quiet on repeat checks — so this wakeup I'll scope the one channel not yet in …
2026/09/02 02:52:00 dbf27ca2/19d70077 [shellm-run] shellm --model deepseek/deepseek-v4-flash-0731 --traj dbf27ca2-… --env quill …
```

Live trajectory steps — reasoning, shell-output, shellm-run — from quill's
running thinker, streamed through `traj tail -r -n 50` against the TS port's
trajectory store.

## Headless proof — `/skills` command

```
  goals                Goals, todos, and intentions tracking                        [kernel]
    <IDENTITIES_DIR>/quill/kernel/goals
  mem                  Life context and memory system                               [kernel]
    <IDENTITIES_DIR>/quill/kernel/mem
  shellm               Reference for the shellm system …                            [local]
    <IDENTITIES_DIR>/quill/skills/shellm
```

(plus `skill-author`, `slack`, `telegram`, `web-research`, and three skipped
skills with missing requirements — `file-tools`, `googleworkspace`,
`obsidian`). Confirms quill's skills, written by the TS port's identity
scaffolding, render correctly, including the `mem` kernel skill (the closest
thing to a "memories" surface the TUI exposes — see Gaps below).

## Gaps found (port does not fully back this TUI)

1. **`/identities` is broken against the port.** The TUI runs `identity list`.
   The TS port's `bin/identity` (`src/identity.ts`) only implements
   `identity new [--default] [--memories DIR] <name>` — there is no `list`
   subcommand. Running `/identities` in the TUI against this port produces:

   ```
   Usage: identity new [--default] [--memories DIR] <name>
   ```

   instead of a list of identities. This is a genuine port gap, not a TUI
   bug — upstream's `tools/identity` presumably has a `list` verb the port
   never implemented.

2. **No dedicated memories view.** The TUI's modes are `chat`, `thinkers`,
   `traj`, and the `/identities`/`/skills`/`/help` one-shot command mode —
   there is no `/memories` mode in upstream's own `tui/headlong/src/main.rs`.
   Memory content is visible only indirectly: via the `mem` kernel skill
   entry under `/skills`, or by finding memory-touching steps in `/traj`.
   Quill's actual memory file
   (`<IDENTITIES_DIR>/quill/memories/2026-09-02-…-your-favourite-colour-is-teal.md`)
   is never read or shown by the TUI itself — this is upstream TUI behavior,
   not a port gap.

No other command the TUI shells out to (`traj cat`, `traj tail -f`,
`traj tail -r -n 50`, `thinkers status`, `skills list`, `chat send`) showed
any discrepancy — all produced the expected output against the TS port's
CLIs and file layout.

## Gap 1 (`/identities`) closed — `identity list` now ported

`src/identity.ts` / `bin/identity.mjs` now implement `identity list [-a]`
(port/identity-list lane; see PARITY.md). Re-running the exact same proof
as Gap 1 above — `identity list` invoked with the env `resolveIdentityEnv()`
(`src/identity-env.ts`) computes for `<IDENTITIES_DIR>` (a read-only fixture
holding `pax` and `quill`, `pax` set as the `default` symlink) — now
produces a real listing instead of the `new`-only usage error:

```
* pax                  2026-09-01T22:22:09
  quill                2026-09-01T22:44:51
```

(`*` marks `pax` as the default identity; the second column is each
identity's `created=` timestamp from its `info.txt`, byte-for-byte what the
real Bash `tools/identity list` prints for the same fixture — verified by
`parity/identity/run-parity.mjs`, 17/17 scenarios PARITY.) `PATH` resolved
`identity` to this port's own `bin/identity` (via `resolveIdentityEnv`'s
PATH-shadow guard), confirming the TUI's `/identities` mode is unblocked
end to end, not just at the library level.
