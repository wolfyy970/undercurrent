// trajCore.mjs — the append-only trajectory primitives.
//
// Plain ESM JavaScript on purpose: this exact module is imported BOTH by the
// TypeScript engine (via trajCore.d.ts) AND by the sandboxed `traj` shim that
// the model's bash invokes (bin/traj.mjs). One implementation, no drift, no
// build step required for the shim to run inside the sandbox.
//
// Faithful to bin/traj `cmd_append` (:405-561) and the schema in SPEC §2:
//   - step_id = lowercase UUID (gen_step_id, bin/traj:119-133)
//   - ts      = ISO-8601 UTC ms  (_iso_ts, bin/traj:137-142)
//   - run_id auto-stamped from $SHELLM_RUN_STEP_ID for steps written inside a
//     wake, EXCEPT shellm-run / trajectory  (bin/traj:459-462; SPEC §2.4)
//   - stdout/stderr over STDOUT_INLINE_LIMIT spill to blobs/  (bin/traj:474-534)
//   - one compact JSON line per step, appended under an mkdir-based lock
//     (bin/traj:546-559)
//
// Key ORDER matters for byte-parity with the golden traces (verified against
// trace-00): domain fields (in construction order) → run_id → step_id → ts →
// blob-spill fields. JS object insertion order reproduces this if we mutate in
// that sequence, which is what the Bash does.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactRecord, trajRedactValues } from "./trajRedact.mjs";

// bin/traj:15 — SHELLM_STDOUT_INLINE_LIMIT default 4096.
export const STDOUT_INLINE_LIMIT = Number(process.env.SHELLM_STDOUT_INLINE_LIMIT ?? 4096);

/** Lowercase UUID step id (gen_step_id). */
export function genStepId() {
  return randomUUID();
}

/** ISO-8601 UTC with milliseconds, e.g. 2026-08-28T15:55:12.548Z (_iso_ts). */
export function isoTs(date = new Date()) {
  return date.toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Resolve the trajectory file for a root traj id.
 * Root file lives at <trajDir>/<hex8>-root/trajectory.jsonl (SPEC §2.1;
 * trace-00 root = 55fd5932-root). hex8 = first 8 chars of the UUID.
 */
export function rootTrajFile(trajDir, trajId) {
  const hex8 = String(trajId).slice(0, 8);
  return path.join(trajDir, `${hex8}-root`, "trajectory.jsonl");
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `find DIR -type d -name "PREFIX*" | head -1`: pre-order, readdir order.
 * `find` checks the STARTING directory itself too (depth 0), not just its
 * descendants — matters when `_resolve_traj_id "$parent_dir" "$parent_id"`
 * (bin/traj:1291, cmd_new resolving cmd_fork's own parent) is called with a
 * dir that already IS the target: e.g. resolving "aaaaaaaa-…" starting from
 * ".../aaaaaaaa-root" itself. Confirmed against real `find` (PORT-NOTE, was
 * previously descendants-only and silently failed that self-referential
 * case — a read-path fix, trajCli's fork/new consumers).
 */
function findDirByPrefix(dir, prefix) {
  if (path.basename(dir).startsWith(prefix)) return dir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const found = findDirByPrefix(full, prefix);
    if (found) return found;
  }
  return undefined;
}

/**
 * _resolve_traj_id (bin/traj:161-193) — how the Bash `traj` maps TRAJ_DIR +
 * TRAJ_ID to a file: an exact path, then `<dir>/<id>/trajectory.jsonl`, then
 * the first `<hex8>-*` directory (hex8 = a UUID's first segment) holding a
 * trajectory.jsonl. `undefined` when nothing resolves (traj dies). The engine
 * writes `<hex8>-root` (rootTrajFile); an external `traj`-driven identity may
 * use the full id as the directory name, which this also finds. Plain JS here
 * so the source-run shims (bin/retrieval-step.mjs) can use it directly.
 */
export function resolveTrajFile(trajDir, trajId) {
  const exact = `${trajDir}/${trajId}`;
  if (isFile(exact)) return exact;
  const dirBased = `${trajDir}/${trajId}/trajectory.jsonl`;
  if (isFile(dirBased)) return dirBased;
  const id = String(trajId);
  const hex = /^[^-]*-[^-]*-[^-]*-[^-]*-/.test(id) ? id.slice(0, id.indexOf("-")) : id;
  const match = findDirByPrefix(trajDir, `${hex}-`);
  if (match && isFile(`${match}/trajectory.jsonl`)) return `${match}/trajectory.jsonl`;
  return undefined;
}

/** next_blob_id: %06x of the existing blob count (bin/traj:144-152). */
function nextBlobId(blobDir) {
  let count = 0;
  try {
    count = fs.readdirSync(blobDir).filter((f) => !f.startsWith(".tmp.")).length;
  } catch {
    count = 0;
  }
  return count.toString(16).padStart(6, "0");
}

// mkdir-based lock (atomic on macOS/Docker; steals locks older than 5s).
// bin/traj:546-559. Exported for src/api.ts (appendHistory, deliverMessage).
export function withLock(trajFile, fn) {
  const lockDir = `${trajFile}.lock`;
  const start = Date.now();
  let absent = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      // PORT-NOTE (sync 2e39a3f, 983e112): mkdir failing while NO lock dir exists is
      // not contention — the directory is not writable (or gone). The Bash used to
      // spin here for its whole timeout, per send; it now dies after 5 such
      // failures (a few retries cover the holder's rmdir racing us).
      let isDir = false;
      try {
        isDir = fs.statSync(lockDir).isDirectory();
      } catch {
        /* absent */
      }
      if (!isDir) {
        absent += 1;
        if (absent >= 5) {
          let who = "this user";
          try {
            who = os.userInfo().username || who;
          } catch {
            /* keep default */
          }
          throw new Error(`append: cannot create lock ${lockDir} (directory not writable by ${who})`);
        }
      } else {
        absent = 0;
      }
      // Steal a stale lock (> 5s old), mirroring the Bash behaviour.
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5000) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
            /* another writer won the steal */
          }
          continue;
        }
      } catch {
        /* lock vanished — retry acquire */
      }
      if (Date.now() - start > 10000) {
        // Give up waiting; proceed unlocked rather than hang the wake.
        break;
      }
      // brief spin
      const until = Date.now() + 15;
      while (Date.now() < until) {
        /* busy-wait a few ms */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Append one step to a trajectory file, returning the assigned step_id.
 *
 * @param {string} trajFile absolute path to <root>/trajectory.jsonl
 * @param {Record<string, unknown>} record must include `type`
 * @param {{ runStepId?: string, env?: Record<string, string | undefined> }} [opts] SHELLM_RUN_STEP_ID for auto run_id; env for the credential value rules
 */
export function appendStep(trajFile, record, opts = {}) {
  if (record == null || typeof record !== "object") {
    throw new Error("append: record must be an object");
  }
  const type = record.type;
  if (!type || typeof type !== "string") {
    throw new Error("append: step record must have a 'type' field");
  }

  // Work on a shallow copy so caller key order is preserved (bin/traj builds
  // the record then mutates it in this exact sequence).
  let rec = { ...record };

  // Auto-link steps written inside a shellm run (SPEC §2.4 / bin/traj:459-462).
  const runStepId = opts.runStepId ?? process.env.SHELLM_RUN_STEP_ID ?? "";
  if (runStepId && type !== "shellm-run" && type !== "trajectory") {
    if (rec.run_id == null) rec.run_id = runStepId;
  }

  // step_id (preserve caller-supplied), then ts.
  if (rec.step_id == null || rec.step_id === "") rec.step_id = genStepId();
  rec.ts = isoTs();

  // PORT-NOTE (sync 2e39a3f, 651d49f #191): redact credentials BEFORE anything is
  // persisted (the log is append-only; a secret must not land at all). Applies to
  // the whole record — values AND keys — including the step_id, so blob names,
  // references and the returned id use the sanitized id too. Runs before blob
  // spill, so blobs are written redacted.
  rec = redactRecord(rec, trajRedactValues(opts.env ?? process.env));
  const stepId = String(rec.step_id);

  const dir = path.dirname(trajFile);
  const blobDir = path.join(dir, "blobs");

  // Blob spill for stdout then stderr (bin/traj:474-534).
  for (const field of ["stdout", "stderr"]) {
    const val = rec[field];
    if (typeof val === "string" && byteLen(val) > STDOUT_INLINE_LIMIT) {
      fs.mkdirSync(blobDir, { recursive: true });
      const blobId = nextBlobId(blobDir);
      const blobFile = path.join(blobDir, `${stepId}-${blobId}.${field}`);
      fs.writeFileSync(blobFile, val);
      // Keep first STDOUT_INLINE_LIMIT *bytes* inline (param-expansion in Bash
      // slices bytes; do the same via Buffer).
      const inline = Buffer.from(val, "utf8").subarray(0, STDOUT_INLINE_LIMIT).toString("utf8");
      rec[field] = inline;
      rec[`${field}_ref`] = `blobs/${stepId}-${blobId}.${field}`;
      rec[`${field}_bytes`] = byteLen(val);
      rec[`${field}_truncated`] = true;
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(rec) + "\n";
  withLock(trajFile, () => {
    fs.appendFileSync(trajFile, line);
  });
  return stepId;
}

/** Read and parse every step line in a trajectory file (skips blank lines). */
export function readSteps(trajFile) {
  let raw;
  try {
    raw = fs.readFileSync(trajFile, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // corrupt line — skip (fromjson? // empty in the Bash pipelines)
    }
  }
  return out;
}

/** Create a new root trajectory: write the `type:"trajectory"` first step. */
export function newTrajectory(trajDir, opts = {}) {
  const trajId = opts.trajId ?? genStepId();
  const trajFile = rootTrajFile(trajDir, trajId);
  fs.mkdirSync(path.dirname(trajFile), { recursive: true });
  const rec = { type: "trajectory", ...(opts.fields ?? {}) };
  // The trajectory's ID is the step_id of its first step (SPEC §2.1).
  rec.step_id = trajId;
  appendStep(trajFile, rec);
  return { trajId, trajFile };
}
