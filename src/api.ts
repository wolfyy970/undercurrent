// The public programmatic interface of this package: the ONLY module an embedding application should import.
// Everything else under src/ is internal and may change in any release. Each function here wraps the engine's
// own internals without changing their behavior; see docs/FORMATS.md for the on-disk contracts and docs/CLI.md
// for the command-line contract. Provider-neutral: nothing here knows about any particular model vendor.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIdentityEnv as resolveIdentityEnvInternal } from "./identity-env.ts";
import { appendStep as appendStepInternal, rootTrajFile as rootTrajFileInternal, withLock } from "./trajCore.mjs";
import { redactRecord, trajRedactValues } from "./trajRedact.mjs";
import { readCursor, writeCursor } from "./wakeLedger.ts";
import { runDirOf } from "./runstate.ts";
import { NOTES_MAX, notesSystemPrompt, writePersonNoteFile } from "./responder.ts";
import { findPersonMemoryFile, notesBody } from "./personMemory.ts";
import { parseFilename } from "./mem.ts";
import { redactKeys } from "./responderRedact.ts";
import { FORWARDED_ENV_KEYS as FORWARDED_ENV_KEYS_INTERNAL } from "./sandbox-runtime.ts";
import { extractCode as extractCodeInternal, type ExtractedCode } from "./extract.ts";
import { indexUpdate, queryHistory, type IndexedMessage } from "./messageIndex.ts";
import { resetIdentitySandbox as resetIdentitySandboxInternal } from "./sandbox-reset.ts";
import { certifiedExecutionEnv, getIdentityActivity as getIdentityActivityInternal, verifyExecutionRoot as verifyExecutionRootInternal, type IdentityActivity, type IdentityActivityOptions, type VerifiedExecutionRoot } from "./activity.ts";

/** Semver of this interface. Breaking changes bump the minor while 0.x. */
export const API_VERSION = "0.1.0";

// ---------------------------------------------------------------------------------------------------------------
// Identities and environment
// ---------------------------------------------------------------------------------------------------------------

/**
 * The environment `identity activate` would export for `identityDir` (IDENTITY_NAME, IDENTITY_DIR, TRAJ_DIR, TRAJ_ID,
 * MEM_DIR, ...), layered over `base` (default: process.env) and the identity's `.env`.
 */
export function resolveIdentityEnv(identityDir: string, opts: { base?: Record<string, string | undefined>; executionRoot?: VerifiedExecutionRoot } = {}): Record<string, string> {
  const env = resolveIdentityEnvInternal(identityDir, opts.base ? { base: opts.base } : {});
  return opts.executionRoot === undefined ? env : certifiedExecutionEnv(env, opts.executionRoot);
}

/** Environment variable names the engine forwards into a wake's shell. An embedder that must keep a credential away from a mind strips these. */
export const FORWARDED_ENV_KEYS: readonly string[] = FORWARDED_ENV_KEYS_INTERNAL;

/** The identity's run-state directory (dispatcher.pid, active_thinkers, wake cursors). */
export function runDir(identityDir: string): string {
  return runDirOf(identityDir);
}

/**
 * Read-only snapshot of verified executing thinker steps (including responder work).
 * Enabled thinkers, pending wakes and recent trajectory writes do not imply activity.
 * Missing/dead dispatchers, stale PIDs or unavailable process inspection return idle.
 * This is conservative observation, not a synchronization or drain primitive.
 */
export function getIdentityActivity(identityDir: string, opts: IdentityActivityOptions = {}): IdentityActivity {
  return getIdentityActivityInternal(identityDir, opts);
}
export type { IdentityActivity, IdentityActivityOptions, VerifiedExecutionRoot };

/** A process-local, revalidated certificate that a retained archive executes the same source CLI code as this release. */
export function verifyExecutionRoot(candidateRoot: string): VerifiedExecutionRoot | null {
  return verifyExecutionRootInternal(candidateRoot);
}

/**
 * Remove this identity's recorded Docker sandbox and its engine-owned metadata. Drain its dispatcher and steps first,
 * and prevent concurrent state changes. Recorded state requires a canonical identity path; uncertain ownership/removal throws.
 * With no recorded sandbox this is a no-op, not discovery of containers whose metadata was lost.
 */
export function resetIdentitySandbox(identityDir: string, envName: string, opts: { env?: Record<string, string | undefined>; dockerPath?: string } = {}): void {
  resetIdentitySandboxInternal(identityDir, envName, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Trajectories
// ---------------------------------------------------------------------------------------------------------------

/** `<identityDir>/trajectories/<trajId>-root/trajectory.jsonl`, the root trajectory file of an identity. */
export function rootTrajFile(identityDir: string, trajId: string): string {
  return rootTrajFileInternal(path.join(identityDir, "trajectories"), trajId) as string;
}

/** Append one step the way `traj append` does: under the file lock, credentials redacted, step_id and ts assigned. Returns the step_id. */
export function appendStep(trajFile: string, record: Record<string, unknown>): string {
  return appendStepInternal(trajFile, record) as string;
}

/** One chat message to record as history (it keeps its own time). */
export interface HistoryRow {
  from: string;
  to: string;
  content: string;
  /** ISO-8601 UTC time of the message; rows are written oldest first. */
  ts: string;
  /** Idempotency key, written as `origin_step_ref` (a `_ref` field, hidden from the model). */
  key: string;
  /** Other keys that also mean "already present" (matched against step_id and origin_step_ref). */
  alsoKnownAs?: string[];
}

/**
 * Append chat messages that happened elsewhere as `type: message, source: chat` rows, under the trajectory lock and with
 * credentials redacted. A row whose key (or any alsoKnownAs) already appears as a step_id or origin_step_ref is skipped,
 * so repeating a call never duplicates. Rows keep their own `ts`. With `markRead` (default true), if the dispatcher has
 * a saved read position for this file, it is moved past the new rows, so they are history and never new wakes; with no
 * saved position the dispatcher starts at end of file anyway. Returns how many rows were written.
 */
export function appendHistory(identityDir: string, trajFile: string, rows: HistoryRow[], opts: { markRead?: boolean } = {}): number {
  const values = trajRedactValues(process.env);
  let n = 0;
  fs.mkdirSync(path.dirname(trajFile), { recursive: true });
  withLock(trajFile, () => {
    const raw = fs.existsSync(trajFile) ? fs.readFileSync(trajFile, "utf8") : "";
    const have = knownRefs(raw);
    const lines = [...rows]
      .filter((m) => m.content.trim() !== "" && ![m.key, ...(m.alsoKnownAs ?? [])].some((k) => k !== "" && have.has(k)))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((m) => JSON.stringify(redactRecord({ type: "message", content: m.content, from: m.from, to: m.to, source: "chat", origin_step_ref: m.key, step_id: randomUUID(), ts: m.ts }, values)));
    if (lines.length === 0) return;
    fs.appendFileSync(trajFile, (raw === "" || raw.endsWith("\n") ? "" : "\n") + lines.join("\n") + "\n");
    n = lines.length;
  });
  if (n > 0 && opts.markRead !== false) {
    const rd = runDirOf(identityDir);
    if (readCursor(rd, trajFile)) {
      const st = fs.statSync(trajFile);
      writeCursor(rd, { file: trajFile, ino: st.ino, offset: st.size });
    }
  }
  return n;
}

/** The dispatcher's saved read position (byte offset) in `trajFile`, or null when it has none (it then starts at end of file). */
export function wakeCursorOffset(identityDir: string, trajFile: string): number | null {
  return readCursor(runDirOf(identityDir), trajFile)?.offset ?? null;
}

function knownRefs(raw: string): Set<string> {
  const have = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r["step_id"] === "string") have.add(r["step_id"]);
      if (typeof r["origin_step_ref"] === "string") have.add(r["origin_step_ref"]);
    } catch {
      /* a torn line */
    }
  }
  return have;
}

/** A message one identity sent, to place in another identity's trajectory (what `chat send` would have written there). */
export interface Delivery {
  from: string;
  to: string;
  content: string;
  /** step_id of the message in the sender's trajectory: the idempotency key, written as `origin_step_ref`. */
  originStep: string;
  originTraj?: string;
  sourceUrl?: string;
}

/**
 * Deliver a message into a recipient's trajectory as a fresh `message` step (new step_id, ts = now), or return the copy
 * already there for the same (to, originStep). The check and the write happen under one trajectory lock, so concurrent
 * deliveries of the same message leave exactly one line. Credentials are redacted at the write point.
 */
export function deliverMessage(trajFile: string, d: Delivery): { stepId: string; written: boolean } {
  if (!fs.existsSync(trajFile)) throw new Error(`deliverMessage: recipient trajectory does not exist: ${trajFile}`);
  const values = trajRedactValues(process.env);
  let out: { stepId: string; written: boolean } = { stepId: "", written: false };
  withLock(trajFile, () => {
    const existing = findDelivery(trajFile, d.to, d.originStep);
    if (existing) {
      out = { stepId: existing, written: false };
      return;
    }
    // Field order is the order `chat send` builds; the origin fields end in `_ref`, which context hides from the model.
    const rec: Record<string, unknown> = { type: "message", content: d.content, from: d.from, to: d.to, source: "chat" };
    if (d.sourceUrl) rec["source_url"] = d.sourceUrl;
    rec["origin_step_ref"] = d.originStep;
    if (d.originTraj) rec["origin_traj_ref"] = d.originTraj;
    rec["step_id"] = randomUUID();
    rec["ts"] = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
    const line = JSON.stringify(redactRecord(rec, values));
    const raw = fs.readFileSync(trajFile, "utf8");
    fs.appendFileSync(trajFile, (raw === "" || raw.endsWith("\n") ? "" : "\n") + line + "\n");
    out = { stepId: String((JSON.parse(line) as Record<string, unknown>)["step_id"]), written: true };
  });
  return out;
}

/** step_id of the message already delivered to `to` for `originStep`, if any. */
export function findDelivery(trajFile: string, to: string, originStep: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(trajFile, "utf8");
  } catch {
    return undefined;
  }
  const needle = `"origin_step_ref":${JSON.stringify(originStep)}`;
  for (const line of raw.split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r["type"] === "message" && r["to"] === to && r["origin_step_ref"] === originStep) return String(r["step_id"]);
    } catch {
      /* a corrupt line is not a copy */
    }
  }
  return undefined;
}

/** Chat history as `chat history --with <keys>` sees it: re-indexes the trajectory into `idxFile`, then queries it (oldest first). */
export function chatHistory(trajFile: string, idxFile: string, q: { me: string; keys: string[]; threadKey?: string; sinceSeconds?: number; n?: number }): IndexedMessage[] {
  indexUpdate(trajFile, idxFile);
  return queryHistory(idxFile, { me: q.me, keys: q.keys, threadKey: q.threadKey ?? "", sinceSeconds: q.sinceSeconds ?? 0, n: q.n ?? 50, now: Date.now });
}
export type { IndexedMessage };

// ---------------------------------------------------------------------------------------------------------------
// Memories and person notes
// ---------------------------------------------------------------------------------------------------------------

/** The stable 8-hex id in a memory file name `<stamp>_<hex8>_<slug>[.md]` (what `mem edit|forget` take), or "" for a legacy name. */
export function memoryId(fileName: string): string {
  return parseFilename(path.basename(fileName).replace(/\.md$/, "")).id;
}

/** The responder's person-notes system prompt for `identityName` writing about `msgFrom`. */
export function notesPrompt(identityName: string, msgFrom: string): string {
  return notesSystemPrompt(identityName, msgFrom);
}

/** How many recent messages the responder's notes call reads. */
export const RESPONDER_NOTES_MAX: number = NOTES_MAX;

/** The body of the `type: person` memory for `personKey` (matched on person_key or aliases), "" if none. */
export function readPersonNote(memDir: string, personKey: string): string {
  const f = findPersonMemoryFile(memDir, personKey);
  return f ? notesBody(f.content).trim() : "";
}

/**
 * Write `personKey`'s notes exactly as the responder does after a reply: the existing note is rewritten in place (id,
 * created and aliases kept), else a new person memory is created. `body` is the whole note; it is redacted, cut to 20
 * lines, and trimmed of blank edges like the responder's own output. An empty body writes nothing.
 */
export function writePersonNote(memDir: string, personKey: string, body: string, opts: { displayName?: string; now?: number } = {}): void {
  const clean = redactKeys(body, process.env).split("\n").slice(0, 20).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  if (clean === "") return;
  writePersonNoteFile(memDir, personKey, opts.displayName ?? personKey, clean, opts.now ?? Date.now());
}

// ---------------------------------------------------------------------------------------------------------------
// Model output
// ---------------------------------------------------------------------------------------------------------------

/** The code block the shellm loop would run from a model reply (the same extractor the loop uses). */
export function extractCode(response: string): ExtractedCode {
  return extractCodeInternal(response);
}
export type { ExtractedCode };
