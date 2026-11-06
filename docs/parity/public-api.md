# Public interface: src/api.ts (historical)

> **Historical.**

## Public interface: src/api.ts (2026-10-29, branch feat/public-api)

Not an upstream module: upstream's embedding surface is its CLIs and on-disk files. `src/api.ts` is the port's one
supported import (package.json `exports["."]`); everything else under `src/` is internal. It wraps existing code
without changing behavior, and `docs/CLI.md` / `docs/FORMATS.md` document the CLI and file contracts it sits beside.

| Export | Wraps | Note |
|---|---|---|
| `resolveIdentityEnv`, `runDir`, `rootTrajFile`, `appendStep` | `identity-env.ts`, `runstate.ts`, `trajCore.mjs` | unchanged |
| `appendHistory` | `trajCore.withLock` (now exported), `trajRedact`, `wakeLedger` cursor | new composite: message rows with their own `ts`, deduped on `step_id`/`origin_step_ref`, a saved feeder cursor moved past them |
| `deliverMessage`, `findDelivery` | `trajCore.withLock`, `trajRedact` | new composite: one `chat send`-shaped row per (to, origin step), check and write under one lock |
| `writePersonNote`, `readPersonNote`, `notesPrompt`, `RESPONDER_NOTES_MAX` | `responder.ts` (`writePersonNoteFile` factored out of `updatePersonNotesLocked`, byte-identical output; `notesSystemPrompt`, `NOTES_MAX` exported), `personMemory.ts` | |
| `chatHistory`, `wakeCursorOffset`, `memoryId`, `extractCode`, `FORWARDED_ENV_KEYS` | `messageIndex.ts`, `wakeLedger.ts`, `mem.ts parseFilename`, `extract.ts`, `sandbox-runtime.ts` | unchanged |

Tests: `test/api.test.ts` (each export), `test/api-deliver.test.ts` (a delivered message wakes a real Dispatcher/TrajFeeder
once, a re-delivery does not, two recipients both wake, `_ref` fields stay out of `buildContext`).

