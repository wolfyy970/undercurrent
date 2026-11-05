# On-disk formats

What an embedding application may read directly, and which writes must go through `src/api.ts`. Paths are relative to
an identity directory.

## Layout

| Path | Contents | Embedder |
|---|---|---|
| `info.txt` | `key: value` lines (`name: ...`). Its presence marks an identity. | read |
| `core_identity_prompt.md` | Identity text every thinker reads. | read; may append its own text |
| `chat/.chatrc` | `default_send_from=<name>` | may write |
| `memories/*.md` | One memory per file (below). | read; write via `mem` or `writePersonNote` |
| `thinkers/<thinker>/disabled` | Empty marker: the thinker is disabled. `thinkers start` (bare) starts only enabled thinkers; a dispatcher that booted with the marker present needs a restart after it is removed. | may touch / remove (same as `thinkers disable\|enable`) |
| `run/dispatcher.pid` | Pid of the running dispatcher; its mtime is the boot time. | read |
| `run/` (anything else) | Run state, wake ledger and read cursors. | never; use `appendHistory` / `wakeCursorOffset` |
| `trajectories/<id>-root/trajectory.jsonl` | The identity's stream (below). | read; write via `appendStep`, `appendHistory`, `deliverMessage` |
| `messages.jsonl` | Message index, rebuilt from the trajectory. | never write |
| `.shellm/` | Engine sandbox state, including recorded container metadata. | never read or write; use `resetIdentitySandbox` in `src/api.ts` after draining the identity |
| `team/`, `.embedder/` | Reserved for the embedding application; the engine never reads or writes them. | free |

## Sandbox lifecycle

`resetIdentitySandbox(identityDir, envName, { env?, dockerPath? })` removes the recorded container only after verifying
its engine-generated name and exact read-write identity bind, then removes its metadata. When recorded state exists the
identity path must be canonical; existing state paths and files must not be symlinks. Stop/drain the identity's dispatcher and steps and prevent
concurrent state changes before calling. Failures preserve metadata and throw; an already-removed container is accepted
only when Docker successfully confirms its absence. With no recorded sandbox it is a no-op: callers revoking folder access
must separately refuse to proceed if unrecorded containers still mount that identity. Explicit `env` supplies the Docker
context and PATH; `dockerPath` defaults to `docker`. No other identity data is changed.

## Trajectory steps

One JSON object per line. Every step has `type`, `step_id` (unique) and `ts` (ISO-8601 UTC). A chat message row is
`{type:"message", content, from, to, source:"chat", [source_url], [origin_step_ref], [origin_traj_ref], step_id, ts}`.
Fields ending in `_ref` are metadata, hidden from the model. Writers take the lock directory `<trajectory.jsonl>.lock`
(created with `mkdir`, stolen after 5 s); an embedder never writes the file without it, which is what the api functions do.

## Memories

File name `YYYY-MM-DD-HH-MM-SS_<hex8>_<slug>.md`; the 8-hex part is the stable id (`memoryId`). Front matter between
`---` fences: `id`, `summary`, `type` (`goal`, `fact`, `person`, ...), and for `type: person` also `person_key` and
`aliases: [a, b]`, then `created`, optional `updated`. The body follows a blank line.

## Routing names

A sender may be a team-room routing name `room~<room>~<sender>` (or `room~<room>`): the person key is the sender and
the thread key is the room, like a Slack channel thread.
