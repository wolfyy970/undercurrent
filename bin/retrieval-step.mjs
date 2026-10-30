#!/usr/bin/env bun
// bin/retrieval-step.mjs — the retrieval thinker's step as a CLI, with exactly
// the Bash step's contract (thinkers/retrieval/step): the trigger step JSON on
// stdin; the identity from the environment (IDENTITY_DIR, TRAJ_DIR, TRAJ_ID,
// MEM_DIR required → exit 1 with `thinker: error: … not set`); knobs
// RETRIEVAL_INDEX / RETRIEVAL_MIN_HITS / RETRIEVAL_SEEN / RETRIEVAL_SEMANTIC;
// run_id auto-link from SHELLM_RUN_STEP_ID. No stdout; every no-op exits 0
// silently. The upstream Bash test suite and parity/retrieval drive this file
// in place of `step`.
//
// Thin process wiring around src/retrieval.ts (Node ≥22.18 strips the types on
// import, like bin/mem.mjs); the memory reader and the trajectory append are
// wired in from src/mem.ts and src/trajCore.mjs, the same way bin/chat.mjs
// wires mem. No bash anywhere.

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runRetrievalStep } from "../src/retrieval.ts";
import { readMemoryFiles } from "../src/mem.ts";
import { appendStep, resolveTrajFile } from "../src/trajCore.mjs";
import { exitAfterDrain } from "../src/exitAfterDrain.ts";

/** Read all of stdin synchronously (fd 0). "" on a closed/tty stdin. */
function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * RETRIEVAL_SEMANTIC=1: `timeout 60 mem search "$content" 2>/dev/null`. A native
 * 60 s timeout stands in for GNU timeout (absent on stock macOS); a non-zero
 * exit, a timeout, or a missing `mem` yields "" exactly like the Bash `|| sem=""`.
 */
function memSearch(query) {
  const res = spawnSync("mem", ["search", query], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return res.status === 0 ? res.stdout ?? "" : "";
}

const env = process.env;
const io = {
  readMemoryFiles,
  // `traj append` against the trajectory TRAJ_DIR/TRAJ_ID resolves to, with
  // bin/traj's own resolution rules (exact path, <id>/trajectory.jsonl, <hex8>-*).
  appendStep: (record, opts) => {
    const dir = env.TRAJ_DIR ?? "";
    const id = env.TRAJ_ID ?? "";
    const file = resolveTrajFile(dir, id);
    if (!file) throw new Error(`traj: error: append: cannot resolve traj_id '${id}' in '${dir}'`);
    return appendStep(file, record, opts);
  },
  memSearch,
  stderr: (s) => process.stderr.write(s),
};

await exitAfterDrain(runRetrievalStep(readStdinSync(), env, io).code);
