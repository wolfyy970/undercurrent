#!/usr/bin/env bun
// bin/dispatcherd.mjs — the resident dispatcher daemon, one per identity
// (PLAN-daemon §3). Spawned detached by `thinkers start` with IDENTITY_DIR
// (and friends) already in its env; runs until a signal or ownership loss.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { main } from "../src/daemon.ts";

main();
