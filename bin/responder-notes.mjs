#!/usr/bin/env bun
// bin/responder-notes.mjs — the detached per-person notes writer for the
// responder's async path (thinkers/responder/step:393-402
// `_update_person_notes_async`, design/conversation_memory.md part 4).
//
// Upstream backgrounds `_update_person_notes` in a DETACHED subshell —
// `( _update_person_notes "$person_key" "$msg_from" ) >>notes.log 2>&1
// </dev/null &` — that OUTLIVES the responder step's own process. This
// script IS that subshell's port: spawned detached + unref'd by
// src/responder.ts's `spawnPersonNotesWriter` (mirrors thinkersctl.ts's
// drainThenFinish -> bin/thinkers-drain.mjs), it keeps running the notes LLM
// call after bin/thinker-step.mjs's `process.exit()` has already ended the
// parent wake — the bug this exists to fix: an in-process fire-and-forget
// promise dies with the process every time, so no `type: person` memory was
// ever written on an async (non-SYNC) wake.
//
// Usage: responder-notes.mjs <trajFile> <idxFile> <memDir> <identityName> <personKey> <msgFrom>
// `memDir` is "" when the caller has none (matches an absent MEM_DIR — the
// notes writer then no-ops, same as the in-process path always did).
//
// LLM config (API key, model, base URL) is read
// ONLY from the inherited process environment (buildLlmClient, src/steprun.ts)
// — never from argv, so no secret ever appears in a process listing.
// Best-effort throughout, matching upstream's own silent redirection to the
// log file and `|| true` on failure: any error here must never surface
// anywhere but responder-notes.log.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { updatePersonNotes } from "../src/responder.ts";
import { buildLlmClient } from "../src/steprun.ts";

async function main(argv) {
  const [trajFile, idxFile, memDirArg, identityName, personKey, msgFrom] = argv;
  if (!trajFile || !idxFile || !identityName || !personKey || msgFrom === undefined) {
    process.stderr.write(
      "Usage: responder-notes.mjs <trajFile> <idxFile> <memDir> <identityName> <personKey> <msgFrom>\n"
    );
    process.exitCode = 1;
    return;
  }
  const memDir = memDirArg || undefined;
  const llm = buildLlmClient(process.env, "responder");
  await updatePersonNotes({
    trajFile,
    idxFile,
    llm,
    memDir,
    identityName,
    personKey,
    msgFrom,
    now: () => Date.now(),
  });
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`responder-notes: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
}
