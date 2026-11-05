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
| `run/` (anything else) | Run state, wake ledger and read cursors. | never; use `getIdentityActivity` / `appendHistory` / `wakeCursorOffset` |
| `trajectories/<id>-root/trajectory.jsonl` | The identity's stream (below). | read; write via `appendStep`, `appendHistory`, `deliverMessage` |
| `messages.jsonl` | Message index, rebuilt from the trajectory. | never write |
| `.shellm/` | Engine sandbox state, including recorded container metadata. | never read or write; use `resetIdentitySandbox` in `src/api.ts` after draining the identity |
| `team/`, `.embedder/` | Reserved for the embedding application; the engine never reads or writes them. | free |

## Identity activity

`getIdentityActivity(identityDir)` in `src/api.ts` returns `{ active, thinkers }`: `active` is true only when the
engine can verify at least one executing thinker step, and `thinkers` contains its unique sorted names, including
`responder` when it is working. Enabled membership, queued wakes, scheduled timers and recent trajectory writes do
not count as execution. This read-only snapshot exposes no process IDs, commands, tokens or run-state paths.

Missing or dead dispatchers, stale or unrelated process IDs, zombies, and unavailable process inspection return idle.
Verification uses the engine's dispatcher CLI and the identity's `thinkers/<name>/step` processes; custom launchers
that do not preserve those commands are unverified. Activity can change immediately after observation; this is not a
synchronization or drain primitive. Embedders must not read private `run/` files to infer activity.

### Retained execution archives

An embedder may need to preserve a source-engine root already mounted into a live sandbox. Load this release's
`src/api.ts` and call `verifyExecutionRoot(retainedRoot)`. It returns an opaque, frozen, process-local certificate
or `null`. Certification requires the canonical retained directory to have the same complete `bin/` and `src/`
inventories, file bytes, read/execute/special permission bits and contained symlink targets as this trusted release. Root-level
configuration, manifests and lockfiles also match exactly; only the `package.json` release-version string may differ.
Only write permission bits may differ for read-only installations. Added, missing, changed, escaping or substituted execution inputs fail
closed. Retained `node_modules` and runtime dependency declarations are unsupported and refused.

Only `src/api.ts` and `src/activity.ts` are excluded from source comparison: the execution graph imports neither.
The import-graph contract test requires literal relative imports confined to `bin/` and `src/`, or builtin `node:`
modules, and rejects dynamic module loaders. Documentation, development fixtures/tooling, web/TUI applications and
installer behavior are outside this source-engine CLI certificate, as are external runtimes, environment values,
identity data and container contents. Keep both source roots trusted and immutable; this certificate is an equality
check, not authentication of a release or a lock against a local owner changing files.

Pass the certificate as `resolveIdentityEnv(identityDir, { base?, executionRoot: certificate })` to select the
retained engine's `HEADLONG_TS_HOME` and `bin/` entry in `PATH`; all other identity environment values keep the normal
resolver's behavior. This revalidates the certificate and throws if it is forged or no longer equivalent. Pass it as
`getIdentityActivity(identityDir, { executionRoot: certificate })` to inspect that root's dispatcher through the current
public API; failed revalidation returns idle. Call `verifyExecutionRoot` again immediately before launching a retained
CLI or mounting that root. A certificate cannot be serialized or reused across module/process instances. These APIs
do not modify engine execution, identity state, mounts or containers.

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
