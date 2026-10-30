# Command-line contract

The commands an embedding application may run, and the environment they honor. Stable within 0.x minors; anything not
listed here is internal. Run each as `node bin/<name>.mjs ...` (or `bun`), with the identity's environment from
`resolveIdentityEnv` in `src/api.ts` (or `identity activate`).

| Command | Purpose | Output | Exit |
|---|---|---|---|
| `identity new <name>` | Create an identity directory under `$IDENTITY_DIR` (`info.txt`, `core_identity_prompt.md`, `memories/`, `chat/`, `trajectories/`, `thinkers/`). Names: `[a-z0-9][a-z0-9-]*`. | progress text | 0 ok, non-zero on a bad or taken name |
| `mem add [--type goal\|fact\|...] <text>` | Add a memory. | the new memory file's path, last line | 0 / non-zero |
| `mem edit <id> <text>` | Rewrite a memory in place (same id, type, created). | path | 0 / non-zero |
| `mem forget <id>` | Delete a memory by its 8-hex id. | text | 0 / non-zero |
| `mem search <query>` / `mem list` | Find memories (search may call the model). | text | 0 |
| `chat send --from F --to T [--key K] <text>` | Record an outbound message in the sender's own trajectory. | text | 0 / non-zero |
| `chat sent --json [-n N]` | The identity's sent messages. | JSON array | 0 |
| `chat history --with <key> [--json]` | Conversation with a person. | text or JSON | 0 |
| `thinkers start [<thinker>]` | Start the dispatcher (bare: the enabled set; named: also queue a boot wake for it). | text | 0 / non-zero |
| `thinkers stop [<thinker>] [--force]` | Drain-stop (an in-flight wake finishes) or force-stop. | text | 0 |
| `thinkers enable\|disable <thinker>` | Remove / touch `thinkers/<thinker>/disabled`. | text | 0 |

## Environment

| Variable | Meaning |
|---|---|
| `IDENTITY_DIR` | Directory holding identities (`identity new`) or the active identity (others). |
| `MEM_DIR`, `TRAJ_DIR`, `TRAJ_ID` | Set by `resolveIdentityEnv`; memory directory, trajectory root and id. |
| `SHELLM_SANDBOX` | `local` runs wake commands on the host; `docker`/`auto` use a container. |
| `SHELLM_MODEL`, `LLM_PROVIDER`, `LLM_API_URL`, `LLM_API_KEY` | The model and the OpenAI-compatible endpoint every model call goes to. |
| `LLM_CONNECT_TIMEOUT` | Seconds to establish the connection (default 10); a slow first byte is not a connect failure. |
| `MONOLITH_BACKOFF_BASE`, `MONOLITH_BACKOFF_HOLD` | Idle-wake backoff of the monolith thinker. |

`FORWARDED_ENV_KEYS` in `src/api.ts` lists the variables forwarded into a wake's shell; an embedder that must keep a
credential away from a mind removes them from the environment it passes.
