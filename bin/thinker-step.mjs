#!/usr/bin/env bun
// bin/thinker-step.mjs <thinker-name> — one wake (PLAN-daemon §3 item 4).
// Exec'd by <identity>/thinkers/<name>/step (installed by `identity new`),
// itself spawned by the daemon (src/daemon.ts) — or run directly by
// `thinkers step <name>` when no daemon is running. Reads the trigger JSON on
// stdin; the daemon supplies a fully resolveIdentityEnv'd process env.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { main } from "../src/steprun.ts";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

const code = await main(process.argv.slice(2));
await exitAfterDrain(code);
