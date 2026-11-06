# Port extensions for embedders (historical)

> **Historical.** 2026-10-29 embedder extensions.

## Port extensions for embedders (2026-10-29)

Opt-in additions with no upstream counterpart. Existing upstream inputs retain their behavior; the extensions below apply only when an embedder explicitly uses them.

Not here, by design: DeepSeek's DSML tool-call text. Provider-specific markup stays out of the engine; an embedder that needs it rewrites it to a ```bash fence in its own provider proxy, so `src/extract.ts` stays upstream's `normalize_toolcall_markup` unchanged.

| Extension | Upstream | Port | Why | Evidence |
|---|---|---|---|---|
| **Identity activity snapshot** `getIdentityActivity` | No public programmatic
execution-activity API | A read-only public API verifies live dispatcher and step process
ownership/commands, rejects zombies and stale or unrelated PIDs, and returns only an active
boolean and unique sorted thinker names | Embedders can show actual execution, including
responder work, without reading private run-state files or confusing membership, queues, timers
or recent writes with work in flight. Dispatcher behavior and state-file bytes are unchanged. |
`test/activity.test.ts` (missing/idle/corrupt/dead/stale/unavailable snapshots);
`test/api-activity.test.ts` (real dispatcher, running and finished thinker/responder steps,
unrelated live PIDs and dead-dispatcher orphans); `test/api.test.ts` (public export) |
| **Retained execution-root certificate** `verifyExecutionRoot`, certified `resolveIdentityEnv`
/ `getIdentityActivity` | An embedding API update changes the checkout path even when source CLI
execution is unchanged | A process-local certificate compares full `bin/` + `src/` inventories,
exact bytes, read/execute/special modes, contained symlinks and root config/lockfiles. Only
embedding-only `src/api.ts` / `src/activity.ts` and the package release-version string may
differ; runtime dependencies and retained node_modules refuse certification.
Environment/activity use revalidates the certificate. | An embedder can retain a byte-equivalent
source archive already mounted into a live sandbox while importing only the current pinned
public API. No dispatcher, CLI, sandbox or model-execution behavior changes. The certificate
covers source-engine CLI inputs, not external runtimes, web/TUI apps, identity/container state
or release authentication. | `test/execution-root.test.ts` (equivalence,
input/config/mode/dependency/link rejection, forgery/invalidation, certified env, AST
import-graph boundary); `test/api-activity.test.ts` (current API observes a certified retained
real dispatcher, invalidated cert becomes idle) |
| **Identity sandbox reset** `resetIdentitySandbox` | Container cleanup is coupled to identity
deletion or private sandbox metadata | A public API removes only the drained identity's recorded
container and sandbox metadata, after checking canonical state paths, container ID,
engine-generated name and exact read-write identity bind; uncertain ownership/removal throws |
Embedders can change sandbox mounts without reading or deleting engine-private files or
destroying the identity. Ordinary wake and environment behavior is unchanged. |
`test/sandbox-reset.test.ts` (verified removal, already-removed confirmation, ownership/path
rejection, failure preservation and conditional real Docker case); `test/api.test.ts` (public
export) |
| **Team-room routing names** `room~<room>~<sender>` and `room~<room>` | A bridge packs place
into the routing name: `slack-<user>-<channel>-<thread_ts>` gives person key `slack:<user>` and
thread key `slack-thread:<channel>-<ts>` (`bin/chat`
`_PERSON_KEY_JQ`/`_person_key`/`_thread_key`, lines 440-460; `thinkers/responder/step` history +
thread union) | `src/personMemory.ts` `TEAM_ROOM_RE`: person key = the sender, thread key =
`room:<room>`; the responder's existing history + thread union (`src/responder.ts`
`queryHistory`, `buildConvoSel`) then shows a room reply every post in that room, other bots'
and the mind's own | An embedder delivered room posts from the plain sender id, so a mind
answering in a room saw only the asker's lines ("Atlas's activity suggestion isn't in this
thread", real DeepSeek run 2026-10-29). `~` because room and bot ids may contain `-` |
`test/teamRooms.test.ts` (keys; a room reply's turns include the other bot's post and the mind's
own, not another room's, trigger once) |

