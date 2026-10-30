// Request router for the read-only Headlong-TS viewer API. Mirrors the
// endpoint surface of headlong/web/src/headlong_web/server.py (Apache-2.0),
// serving the port's on-disk identity/trajectory/memory files. All mutating
// (POST/PUT/DELETE) endpoints are disabled here (controls_enabled=false).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  scanIdentities,
  resolveIdentity,
  findRootTrajDir,
  IdentityNotFound,
  type IdentityInfo,
} from "./discovery.ts";
import { identityStatus, identityActivity, isoOrNull } from "./liveness.ts";
import { getTrajectory } from "./store.ts";
import { windowTrajectory } from "./trajectory.ts";
import { chatView } from "./chat.ts";
import { listMemories, readMemory } from "./memories.ts";
import { parseDispatchLog } from "./dispatchLog.ts";
import { searchSteps } from "./search.ts";
import { thinkersStatus, thinkersSummary } from "./thinkers.ts";
import { buildTree, findTrajDir, breadcrumb, nodeSummary } from "./tree.ts";
import * as control from "./control.ts";
import { IDENTITY_NAME_RE, CHAT_FROM_RE, THINKER_NAME_RE, isSlackPermalink } from "./safety.ts";
import type { ProcEntry, DockerListing } from "../../../src/killall.ts";
import { parseEnvFile, redactedEntry, ENV_KEY_RE, upsertEnvVar, deleteEnvVar } from "./envfile.ts";
import * as thinkerSync from "./thinker-sync.ts";
import * as exportJobs from "./exportJobs.ts";
import * as push from "./push.ts";
import { runSelfUpdate, SelfUpdateError } from "./selfUpdate.ts";

export const VERSION = "0.1.0";

export interface ApiResult {
  status: number;
  body: unknown;
}

function ok(body: unknown): ApiResult {
  return { status: 200, body };
}
function err(status: number, detail: unknown): ApiResult {
  return { status, body: { detail } };
}
/** A binary body (e.g. a .shellm.tgz) — server.ts sends it raw with the given
 *  headers instead of JSON-encoding it (mirrors the `__raw_text` convention
 *  the blob route already uses, for bytes instead of text). */
function rawBytes(status: number, data: Buffer, headers: Record<string, string>): ApiResult {
  return { status, body: { __raw_bytes: data, __headers: headers } };
}
function exportDownloadHeaders(filename: string, size: number): Record<string, string> {
  return {
    "Content-Type": "application/gzip",
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  };
}

const READ_ONLY = err(403, "Server is read-only");

// Exact non-empty line count (used everywhere for step_count).
function countNonEmptyLines(jsonl: string): number {
  try {
    const text = readFileSync(jsonl, "utf-8");
    let n = 0;
    for (const line of text.split("\n")) if (line.trim() !== "") n++;
    return n;
  } catch {
    return 0;
  }
}

export interface RouterCtx {
  root: string;
  /** false in --read-only / HEADLONG_READ_ONLY=1 mode (server.ts). */
  controlsEnabled: boolean;
  /** Test-only fixtures for POST /api/killall (src/killall.ts's injectable
   *  seams) — omitted in production, where control.killall falls through to
   *  the real, system-wide `ps`/`docker` scan. */
  killallPsSnapshot?: () => ProcEntry[];
  killallDockerListing?: () => DockerListing;
  /** `HEADLONG_WEB_SELF_UPDATE=1 and not read_only` (server.py), resolved
   *  once by server.ts. Optional/false-if-omitted — most tests never touch
   *  self-update and construct a bare `{root, controlsEnabled}` ctx. */
  selfUpdateEnabled?: boolean;
  /** The git checkout `POST /api/update` pulls in. */
  repoRoot?: string;
  /** The built frontend dir cleared on a real update (server.py `_STATIC_DIR`). */
  staticDir?: string | null;
  /** Resolved ONCE at server startup (server.py comment: "the code can't
   *  change under a running server"). Omitted -> both fields report null,
   *  same as this router's own pre-existing /api/config default. */
  gitInfo?: { git_commit: string | null; git_branch: string | null };
  /** Test-only: replaces selfUpdate.ts's real SIGTERM-after-750ms. */
  scheduleRestart?: (delayMs: number) => void;
}

function identityOr404(root: string, id: string): IdentityInfo {
  return resolveIdentity(root, id);
}

function rootTrajOr404(identity: IdentityInfo): string {
  const dir = findRootTrajDir(identity);
  if (dir === null) throw new NoTraj();
  return dir;
}
class NoTraj extends Error {}

/** Handle a GET request. `segments` are the decoded path parts after /api/.
 * `query` is the parsed query string. Returns an ApiResult or null (no match). */
export function handleGet(
  ctx: RouterCtx,
  segments: string[],
  query: URLSearchParams,
): ApiResult | null {
  const root = ctx.root;
  const p = segments;

  try {
    // /api/health
    if (p.length === 1 && p[0] === "health") return ok({ status: "ok" });

    // /api/config
    if (p.length === 1 && p[0] === "config") {
      return ok({
        root,
        version: VERSION,
        controls_enabled: ctx.controlsEnabled,
        self_update_enabled: ctx.selfUpdateEnabled ?? false,
        default_send_from: null,
        git_commit: ctx.gitInfo?.git_commit ?? null,
        git_branch: ctx.gitInfo?.git_branch ?? null,
      });
    }

    // /api/llm-health -> unknown (navbar chip hides itself)
    if (p.length === 1 && p[0] === "llm-health") {
      return ok({
        status: "unknown",
        failures_15m: 0,
        failures_1h: 0,
        cadence_slow: false,
        checked_at: new Date().toISOString(),
        identities: [],
        last_call: null,
      });
    }

    // /api/openrouter/models -> empty
    if (p.length === 2 && p[0] === "openrouter" && p[1] === "models") {
      return ok({
        source: null,
        has_key: false,
        count: 0,
        models: [],
        error: null,
        fetched_at: new Date().toISOString(),
      });
    }

    // /api/push/key (server.py push_key) — never gated by controls, like
    // export (a viewer needs the VAPID key to even OFFER subscribing).
    if (p.length === 2 && p[0] === "push" && p[1] === "key") {
      return ok({ key: push.vapidPublicKey(root) });
    }

    // GET /api/export?soul_only= — every identity, one archive (server.py
    // export_all_identities). Available in read-only mode, like all export
    // routes (server.py's own comment: "it doubles as the backup path").
    if (p.length === 1 && p[0] === "export") {
      const soulOnly = query.get("soul_only") === "true";
      const buffer = control.buildIdentityExportAllBuffer(root, soulOnly);
      const filename = exportJobs.directExportFilename("identities");
      return rawBytes(200, buffer, exportDownloadHeaders(filename, buffer.length));
    }

    // GET /api/export-jobs/:job_id[/download] (server.py export_job_status /
    // export_job_download) — job_id is global, not identity-scoped.
    if (p[0] === "export-jobs" && p.length === 2) {
      const job = exportJobs.getJobRaw(p[1]!);
      if (!job) return err(404, "No such export job");
      return ok(exportJobs.publicJob(job));
    }
    if (p[0] === "export-jobs" && p.length === 3 && p[2] === "download") {
      const job = exportJobs.getJobRaw(p[1]!);
      if (!job) return err(404, "No such export job");
      if (job.status !== "done") return err(409, `Export is ${job.status}`);
      const buffer = exportJobs.jobBuffer(p[1]!)!;
      return rawBytes(200, buffer, exportDownloadHeaders(job.filename, buffer.length));
    }

    // /api/identities
    if (p.length === 1 && p[0] === "identities") {
      const result = scanIdentities(root).map((identity) => {
        const trajDir = findRootTrajDir(identity);
        const jsonl = trajDir ? join(trajDir, "trajectory.jsonl") : null;
        const status = identityStatus(identity.path, jsonl);
        const summary = thinkersSummary(identity.path);
        return {
          id: identity.id,
          name: identity.name,
          path_rel: identity.path_rel,
          created: identity.created,
          root_trajectory: identity.root_trajectory,
          group: identity.group,
          live: status.live,
          last_activity_ts: isoOrNull(status.mindlog_mtime),
          step_count: jsonl ? countNonEmptyLines(jsonl) : 0,
          ...summary,
        };
      });
      result.sort((a, b) => (b.last_activity_ts ?? "").localeCompare(a.last_activity_ts ?? ""));
      return ok(result);
    }

    // Everything else is /api/identities/:id/...
    if (p[0] !== "identities" || p.length < 3) return null;
    const identity = identityOr404(root, p[1]);
    const rest = p.slice(2);

    // /api/identities/:id/status
    if (rest.length === 1 && rest[0] === "status") {
      const trajDir = findRootTrajDir(identity);
      const jsonl = trajDir ? join(trajDir, "trajectory.jsonl") : null;
      const status = identityStatus(identity.path, jsonl);
      return ok({
        live: status.live,
        pid_alive: status.pid_alive,
        dispatcher_pid: status.dispatcher_pid,
        mindlog_mtime: isoOrNull(status.mindlog_mtime),
        mindlog_bytes: status.mindlog_bytes,
        step_count: jsonl ? countNonEmptyLines(jsonl) : 0,
      });
    }

    // /api/identities/:id/activity
    if (rest.length === 1 && rest[0] === "activity") {
      return ok(identityActivity(identity));
    }

    // /api/identities/:id/health
    if (rest.length === 1 && rest[0] === "health") {
      return ok({
        identity: { id: identity.id, name: identity.name },
        activity: identityActivity(identity),
        responses: null, // reply-pairing stats deferred (see web/README.md)
      });
    }

    // /api/identities/:id/mindlog
    if (rest.length === 1 && rest[0] === "mindlog") {
      const trajDir = rootTrajOr404(identity);
      const loaded = getTrajectory(trajDir);
      const sinceQ = query.get("since");
      const untilQ = query.get("until");
      const tailQ = query.get("tail");
      const win = windowTrajectory(loaded, {
        since: sinceQ !== null ? Number(sinceQ) : null,
        until: untilQ !== null ? Number(untilQ) : null,
        tail: tailQ !== null ? Number(tailQ) : null,
      });
      const jsonl = join(trajDir, "trajectory.jsonl");
      const status = identityStatus(identity.path, jsonl);
      let runs = win.runs;
      const since = win.since;
      if (since !== null) runs = runs.filter((r) => r.last_touch >= since);
      return ok({
        steps: win.steps,
        runs,
        traj_id: win.traj_id,
        step_count: win.step_count,
        since,
        live: status.live,
        dir_rel: relative(identity.path, trajDir).split("\\").join("/"),
        identity: { id: identity.id, name: identity.name },
      });
    }

    // /api/identities/:id/mindlog/search
    if (rest.length === 2 && rest[0] === "mindlog" && rest[1] === "search") {
      const trajDir = rootTrajOr404(identity);
      const q = query.get("q") ?? "";
      if (q.length < 2) return err(422, "q must be at least 2 chars");
      const scope = query.get("scope") === "all" ? "all" : "thoughts";
      const limit = Math.max(1, Math.min(200, Number(query.get("limit") ?? 50)));
      const loaded = getTrajectory(trajDir);
      const result = searchSteps(loaded.steps, q, scope, limit);
      return ok({
        ...result,
        step_count: loaded.step_count,
        identity: { id: identity.id, name: identity.name },
      });
    }

    // /api/identities/:id/step/:stepId
    if (rest.length === 2 && rest[0] === "step") {
      const trajDir = rootTrajOr404(identity);
      const loaded = getTrajectory(trajDir);
      const stepId = rest[1];
      for (let index = loaded.steps.length - 1; index >= 0; index--) {
        if (loaded.steps[index].step_id === stepId) {
          const step = loaded.steps[index];
          const run = loaded.runs.find((r) => r.run_id === step.run_id) ?? null;
          return ok({ step, index, run });
        }
      }
      return err(404, "Step not found");
    }

    // /api/identities/:id/runs/:runId/command
    if (rest.length === 3 && rest[0] === "runs" && rest[2] === "command") {
      const trajDir = rootTrajOr404(identity);
      const loaded = getTrajectory(trajDir);
      const runId = rest[1];
      const command = loaded.normalizer.fullCommands.get(runId);
      if (command === undefined) return err(404, "Run not found");
      return ok({ run_id: runId, command });
    }

    // /api/identities/:id/tree
    if (rest.length === 1 && rest[0] === "tree") {
      const rootTrajDir = rootTrajOr404(identity);
      const node = query.get("node");
      const depth = Math.max(0, Math.min(6, Number(query.get("depth") ?? 2)));
      let target = rootTrajDir;
      if (node) {
        const found = findTrajDir(rootTrajDir, node);
        if (found === null) return err(404, "Trajectory not found");
        target = found;
      }
      return ok(buildTree(target, depth));
    }

    // /api/identities/:id/traj/:trajId
    if (rest.length === 2 && rest[0] === "traj") {
      const rootTrajDir = rootTrajOr404(identity);
      const trajDir = findTrajDir(rootTrajDir, rest[1]);
      if (trajDir === null) return err(404, "Trajectory not found");
      const loaded = getTrajectory(trajDir);
      const win = windowTrajectory(loaded, {});
      const first = loaded.steps[0]?.raw ?? {};
      const parentTraj = first["parent_traj"] as string | undefined;
      const status = identityStatus(identity.path, join(trajDir, "trajectory.jsonl"));
      return ok({
        steps: win.steps,
        runs: win.runs,
        traj_id: win.traj_id,
        step_count: win.step_count,
        since: win.since,
        breadcrumb: breadcrumb(rootTrajDir, trajDir),
        parent: parentTraj
          ? { traj_id: parentTraj, step_id: (first["parent_step"] as string) ?? null }
          : null,
        identity: { id: identity.id, name: identity.name },
        dir_rel: relative(identity.path, trajDir).split("\\").join("/"),
        live: status.live,
      });
    }

    // /api/identities/:id/traj/:trajId/blob/:name
    if (rest.length === 4 && rest[0] === "traj" && rest[2] === "blob") {
      const rootTrajDir = rootTrajOr404(identity);
      const trajDir = findTrajDir(rootTrajDir, rest[1]);
      if (trajDir === null) return err(404, "Trajectory not found");
      const name = rest[3];
      if (name.includes("/") || name.includes("..") || name.includes("\0"))
        return err(400, "Invalid blob name");
      const blobPath = join(trajDir, "blobs", name);
      try {
        const total = statSync(blobPath).size;
        const head = Math.max(1, Math.min(8 * 1024 * 1024, Number(query.get("head") ?? 262144)));
        const buf = readFileSync(blobPath);
        return {
          status: 200,
          body: {
            __raw_text: buf.subarray(0, head).toString("utf-8"),
            __headers: {
              "X-Blob-Bytes": String(total),
              "X-Blob-Truncated": total > head ? "1" : "0",
            },
          },
        };
      } catch {
        return err(404, "Blob not found");
      }
    }

    // /api/identities/:id/logs
    if (rest.length === 1 && rest[0] === "logs") {
      const logsDir = join(identity.path, "run", "logs");
      let entries: string[] = [];
      try {
        entries = readdirSync(logsDir);
      } catch {
        entries = [];
      }
      const out = entries
        .map((name) => {
          try {
            const st = statSync(join(logsDir, name));
            if (!st.isFile()) return null;
            return { name, bytes: st.size, mtime: st.mtimeMs / 1000 };
          } catch {
            return null;
          }
        })
        .filter((x): x is { name: string; bytes: number; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime);
      return ok(out);
    }

    // /api/identities/:id/logs/:name
    if (rest.length === 2 && rest[0] === "logs") {
      const name = rest[1];
      if (name.includes("/") || name.includes("..") || name.includes("\0"))
        return err(400, "Invalid log name");
      const logPath = join(identity.path, "run", "logs", name);
      try {
        const total = statSync(logPath).size;
        const tailBytes = Math.max(1, Math.min(8 * 1024 * 1024, Number(query.get("tail_bytes") ?? 65536)));
        const buf = readFileSync(logPath);
        const start = total > tailBytes ? total - tailBytes : 0;
        return ok({
          name,
          content: buf.subarray(start).toString("utf-8"),
          total_bytes: total,
          truncated: total > tailBytes,
        });
      } catch {
        return err(404, "Log not found");
      }
    }

    // /api/identities/:id/dispatch
    if (rest.length === 1 && rest[0] === "dispatch") {
      return ok(parseDispatchLog(identity.path));
    }

    // /api/identities/:id/memories
    if (rest.length === 1 && rest[0] === "memories") {
      return ok(listMemories(identity.path));
    }

    // /api/identities/:id/memories/:name
    if (rest.length === 2 && rest[0] === "memories") {
      const content = readMemory(identity.path, rest[1]);
      if (content === null) return err(404, "Memory not found");
      return ok({ name: rest[1], content });
    }

    // /api/identities/:id/recap -> not computed by this port
    if (rest.length === 1 && rest[0] === "recap") {
      return ok({
        identity: { id: identity.id, name: identity.name },
        refreshing: false,
        available: false,
      });
    }

    // /api/identities/:id/usage -> not computed by this viewer (deferred)
    if (rest.length === 1 && rest[0] === "usage") {
      return ok({
        identity: { id: identity.id, name: identity.name },
        refreshing: false,
        pending_bytes: 0,
        available: false,
      });
    }

    // /api/identities/:id/thinkers
    if (rest.length === 1 && rest[0] === "thinkers") {
      return ok({
        identity: { id: identity.id, name: identity.name },
        ...thinkersStatus(identity.path),
      });
    }

    // /api/identities/:id/thinker-sync (server.py thinker_sync_status)
    if (rest.length === 1 && rest[0] === "thinker-sync") {
      return ok(thinkerSync.status(identity.path));
    }

    // /api/identities/:id/chat
    if (rest.length === 1 && rest[0] === "chat") {
      const trajDir = rootTrajOr404(identity);
      const loaded = getTrajectory(trajDir);
      const tail = Math.max(1, Math.min(2000, Number(query.get("tail") ?? 200)));
      const withName = query.get("with");
      const status = identityStatus(identity.path, join(trajDir, "trajectory.jsonl"));
      const view = chatView(loaded.normalizer.chatIndex, identity.name, tail, withName);
      return ok({
        identity: { id: identity.id, name: identity.name },
        live: status.live,
        messages: view.messages,
        outcomes: view.outcomes,
      });
    }

    // GET /api/identities/:id/export?soul_only=&slim= (server.py export_identity)
    if (rest.length === 1 && rest[0] === "export") {
      const soulOnly = query.get("soul_only") === "true";
      const slim = query.get("slim") === "true";
      const buffer = control.buildIdentityExportBuffer(root, identity, soulOnly, slim);
      const filename = exportJobs.directExportFilename(identity.name);
      return rawBytes(200, buffer, exportDownloadHeaders(filename, buffer.length));
    }

    // GET /api/identities/:id/export-jobs (server.py list_export_jobs)
    if (rest.length === 1 && rest[0] === "export-jobs") {
      return ok(exportJobs.jobsForIdentity(identity.id));
    }

    // /api/identities/:id/env (server.py identity_env_get)
    if (rest.length === 1 && rest[0] === "env") {
      const own = parseEnvFile(join(identity.path, ".env")).map(([k, v]) => redactedEntry(k, v));
      const ownKeys = new Set(own.map((e) => e.key));
      const inherited = parseEnvFile(join(root, ".env")).map(([k, v]) => ({
        ...redactedEntry(k, v),
        overridden: ownKeys.has(k),
      }));
      return ok({
        identity: { id: identity.id, name: identity.name },
        env: own,
        inherited,
        note: "Changes take effect the next time thinkers are started.",
      });
    }

    return null;
  } catch (e) {
    if (e instanceof IdentityNotFound) return err(404, "Identity not found");
    if (e instanceof NoTraj) return err(404, "No mind log trajectory found");
    if (e instanceof control.ControlError) {
      return err(409, { message: e.message, stderr: e.stderr, exit_code: e.exitCode });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Mutation routes (SPEC-control-plane.md §B, Slice A + shared Slice-B pieces).
// ---------------------------------------------------------------------------

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** `thinkers.list_thinker_dirs(identity.path, include_disabled=True)` — step
 *  + subscriptions.jsonl present, "_"-prefixed dirs excluded, disabled or not. */
function listInstalledThinkerNames(identityPath: string): Set<string> {
  const dir = join(identityPath, "thinkers");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const n of names) {
    if (n.startsWith("_")) continue;
    const tdir = join(dir, n);
    try {
      if (!statSync(tdir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(tdir, "step")) || !existsSync(join(tdir, "subscriptions.jsonl"))) continue;
    out.add(n);
  }
  return out;
}

/** Same, minus anything carrying a `disabled` marker. */
function listEnabledThinkerNames(identityPath: string): Set<string> {
  const dir = join(identityPath, "thinkers");
  const out = new Set<string>();
  for (const n of listInstalledThinkerNames(identityPath)) {
    if (!existsSync(join(dir, n, "disabled"))) out.add(n);
  }
  return out;
}

/** `_checked_thinker_names` (server.py:192-206): 422 bad name, 404 not
 *  installed, 409 installed-but-disabled. Returns null when every name is OK. */
function checkedThinkerNames(identityPath: string, names: string[]): ApiResult | null {
  const installed = listInstalledThinkerNames(identityPath);
  const enabled = listEnabledThinkerNames(identityPath);
  for (const name of names) {
    if (!THINKER_NAME_RE.test(name)) return err(422, `Invalid thinker name: ${name}`);
    if (!installed.has(name)) return err(404, `Thinker not found: ${name}`);
    if (!enabled.has(name)) return err(409, `Thinker '${name}' is disabled — enable it first`);
  }
  return null;
}

/** `_thinker_dir_or_404` (server.py:671-677): 422 bad name, 404 not installed
 *  (disabled thinkers ARE found here — enable/disable operate on them). */
function thinkerDirOr404(identityPath: string, name: string): ApiResult | null {
  if (!THINKER_NAME_RE.test(name)) return err(422, `Invalid thinker name: ${name}`);
  if (!listInstalledThinkerNames(identityPath).has(name)) return err(404, `Thinker not found: ${name}`);
  return null;
}

/** Every mutating (non-GET) request. `body` is the parsed JSON body (server.ts),
 * or `{}`/undefined for a bodyless request. */
export async function handleMutation(
  ctx: RouterCtx,
  method: string,
  segments: string[],
  body: unknown,
): Promise<ApiResult> {
  const root = ctx.root;
  const p = segments;
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  try {
    // POST /api/identities
    if (method === "POST" && p.length === 1 && p[0] === "identities") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      const name = asString(b["name"]);
      if (!IDENTITY_NAME_RE.test(name)) {
        return err(422, "Invalid identity name (use lowercase alphanumeric + hyphens)");
      }
      const result = control.identityNew(root, name);
      return { status: 201, body: result };
    }

    // DELETE /api/export-jobs/:job_id (server.py delete_export_job) — NOT
    // gated by controlsEnabled: export stays available in read-only mode,
    // like every other export route (server.py's own comment on the whole
    // "Import / export" block).
    if (method === "DELETE" && p.length === 2 && p[0] === "export-jobs") {
      const job = exportJobs.getJobRaw(p[1]!);
      if (!job) return err(404, "No such export job");
      if (job.status === "running") return err(409, "Export is still building");
      exportJobs.deleteJob(p[1]!);
      return ok({ ok: true, job_id: p[1] });
    }

    // POST /api/push/subscriptions (server.py push_subscribe)
    if (method === "POST" && p.length === 2 && p[0] === "push" && p[1] === "subscriptions") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      const name = asString(b["name"]);
      const subscription = b["subscription"] && typeof b["subscription"] === "object" ? (b["subscription"] as Record<string, unknown>) : {};
      if (!name.startsWith(push.SUBSCRIBABLE_PREFIX) || !CHAT_FROM_RE.test(name)) {
        return err(422, "Invalid sender name");
      }
      const endpoint = asString(subscription["endpoint"]);
      if (!endpoint.startsWith("https://")) return err(422, "Invalid subscription");
      const count = push.addSubscription(root, name, subscription as unknown as push.PushSubscriptionInfo);
      return ok({ ok: true, name, subscriptions: count });
    }

    // POST /api/push/unsubscribe (server.py push_unsubscribe)
    if (method === "POST" && p.length === 2 && p[0] === "push" && p[1] === "unsubscribe") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      const endpoint = asString(b["endpoint"]);
      const removed = push.removeSubscription(root, endpoint);
      return ok({ ok: true, removed });
    }

    // POST /api/killall (server.py:978-981, control.py killall:441-447).
    if (method === "POST" && p.length === 1 && p[0] === "killall") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      const dryRun = asBool(b["dry_run"]);
      const result = await control.killall(dryRun, {
        psSnapshot: ctx.killallPsSnapshot,
        dockerListing: ctx.killallDockerListing,
      });
      return ok(result);
    }

    if (p[0] === "identities" && p.length >= 3) {
      const rest = p.slice(2);

      // POST /api/identities/:id/chat
      if (method === "POST" && rest.length === 1 && rest[0] === "chat") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const content = asString(b["content"]);
        const fromName = asString(b["from_name"]);
        if (content.trim() === "") return err(422, "Empty message");
        if (!CHAT_FROM_RE.test(fromName)) return err(422, "Invalid sender name");
        // PORT-NOTE (1c: f68c1d8): server.py's ChatSendBody.source_url —
        // optional, but when present must be a real Slack archive permalink.
        const sourceUrl =
          b["source_url"] === undefined || b["source_url"] === null ? null : asString(b["source_url"]);
        if (sourceUrl !== null && !isSlackPermalink(sourceUrl)) return err(422, "Invalid source URL");
        return ok(control.chatSend(identity, content, fromName, sourceUrl));
      }

      // POST /api/identities/:id/thinkers/start
      if (method === "POST" && rest.length === 2 && rest[0] === "thinkers" && rest[1] === "start") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const enabled = control.enabledThinkerNames(join(identity.path, "thinkers"));
        if (enabled.length === 0) return err(409, "Identity has no thinkers");
        const names = asStringArray(b["names"]);
        const nameCheck = checkedThinkerNames(identity.path, names);
        if (nameCheck) return nameCheck;
        const noSelfTrigger = asBool(b["no_self_trigger"]);
        // Expand "start all" to explicit names so the boot-kick fires for
        // each one (SPEC-control-plane.md §B gotcha 3).
        const finalNames = names.length > 0 ? names : enabled;
        return ok(await control.thinkersStart(identity, finalNames, noSelfTrigger));
      }

      // POST /api/identities/:id/thinkers/stop
      if (method === "POST" && rest.length === 2 && rest[0] === "thinkers" && rest[1] === "stop") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const names = asStringArray(b["names"]);
        const nameCheck = checkedThinkerNames(identity.path, names);
        if (nameCheck) return nameCheck;
        const force = asBool(b["force"]);
        return ok(await control.thinkersStop(identity, names, force));
      }

      // POST /api/identities/:id/thinkers/:name/step
      if (method === "POST" && rest.length === 3 && rest[0] === "thinkers" && rest[2] === "step") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const name = rest[1];
        const nameCheck = checkedThinkerNames(identity.path, [name]);
        if (nameCheck) return nameCheck;
        return { status: 202, body: control.thinkersStep(identity, name) };
      }

      // POST /api/identities/:id/thinkers/:name/disable
      if (method === "POST" && rest.length === 3 && rest[0] === "thinkers" && rest[2] === "disable") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const name = rest[1];
        const dirCheck = thinkerDirOr404(identity.path, name);
        if (dirCheck) return dirCheck;
        return ok(await control.thinkersDisable(identity, name));
      }

      // POST /api/identities/:id/thinkers/:name/enable
      if (method === "POST" && rest.length === 3 && rest[0] === "thinkers" && rest[2] === "enable") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const name = rest[1];
        const dirCheck = thinkerDirOr404(identity.path, name);
        if (dirCheck) return dirCheck;
        return ok(control.thinkersEnable(identity, name));
      }

      // PUT /api/identities/:id/env (server.py identity_env_put)
      if (method === "PUT" && rest.length === 1 && rest[0] === "env") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const key = asString(b["key"]);
        const value = asString(b["value"]);
        if (!ENV_KEY_RE.test(key)) {
          return err(422, "Invalid variable name (letters, digits, underscores)");
        }
        if (/[\n\r\x00]/.test(value)) return err(422, "Value must be a single line");
        upsertEnvVar(join(identity.path, ".env"), key, value);
        return ok({ ok: true, ...redactedEntry(key, value) });
      }

      // DELETE /api/identities/:id/env/:key (server.py identity_env_delete)
      if (method === "DELETE" && rest.length === 2 && rest[0] === "env") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const key = rest[1]!;
        if (!ENV_KEY_RE.test(key)) return err(422, "Invalid variable name");
        const removed = deleteEnvVar(join(identity.path, ".env"), key);
        if (!removed) return err(404, "Variable not found");
        return ok({ ok: true, key });
      }

      // POST /api/identities/:id/thinker-sync (server.py thinker_sync_pull)
      if (method === "POST" && rest.length === 1 && rest[0] === "thinker-sync") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const names = asStringArray(b["names"]);
        for (const name of names) {
          if (!thinkerSync.SYNC_NAME_RE.test(name)) return err(422, `Invalid thinker name: ${name}`);
        }
        try {
          return ok(thinkerSync.sync(identity.path, names));
        } catch (e) {
          if (e instanceof thinkerSync.NoBundledThinkers) return err(409, e.message);
          throw e;
        }
      }

      // POST /api/identities/:id/recap/refresh (server.py identity_recap_refresh)
      if (method === "POST" && rest.length === 2 && rest[0] === "recap" && rest[1] === "refresh") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const trajDir = findRootTrajDir(identity);
        if (trajDir === null) return err(404, "No mind log trajectory found");
        if (existsSync(join(trajDir, "recap", ".lock"))) {
          return err(409, "A recap is already running");
        }
        const rebuild = asBool(b["rebuild"]);
        return { status: 202, body: control.recapRefresh(root, identity, rebuild) };
      }

      // POST /api/identities/:id/usage/refresh (server.py identity_usage_refresh)
      if (method === "POST" && rest.length === 2 && rest[0] === "usage" && rest[1] === "refresh") {
        if (!ctx.controlsEnabled) return READ_ONLY;
        const identity = identityOr404(root, p[1]);
        const trajDir = findRootTrajDir(identity);
        if (trajDir === null) return err(404, "No mind log trajectory found");
        const rebuild = asBool(b["rebuild"]);
        const started = control.usageStartRefresh(trajDir, identity.name, control.usageLedgerPath(identity), rebuild);
        if (!started) return err(409, "A usage refresh is already running");
        return { status: 202, body: { ok: true, action: "usage-refresh", rebuild } };
      }

      // POST /api/identities/:id/export-jobs (server.py start_export_job) —
      // NOT gated by controlsEnabled, matching every export route (see the
      // DELETE /api/export-jobs/:job_id comment above).
      if (method === "POST" && rest.length === 1 && rest[0] === "export-jobs") {
        const identity = identityOr404(root, p[1]);
        const soulOnly = asBool(b["soul_only"]);
        const slim = asBool(b["slim"]);
        try {
          const job = exportJobs.startExportJob({
            identityId: identity.id,
            identityName: identity.name,
            soulOnly,
            slim,
            build: () => control.buildIdentityExportBuffer(root, identity, soulOnly, slim),
          });
          return { status: 202, body: job };
        } catch (e) {
          return err(409, e instanceof Error ? e.message : String(e));
        }
      }
    }

    // POST /api/llm-health/probe (server.py llm_probe_endpoint)
    if (method === "POST" && p.length === 2 && p[0] === "llm-health" && p[1] === "probe") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      return ok(await control.llmProbe(root));
    }

    // POST /api/identities/import (server.py import_identities) — the raw
    // gzip stream is read and validated in server.ts (size cap + magic
    // bytes), which hands the staged temp-file path here as `body.__archivePath`.
    if (method === "POST" && p.length === 2 && p[0] === "identities" && p[1] === "import") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      const archivePath = asString(b["__archivePath"]);
      const name = b["name"] === undefined || b["name"] === null ? null : asString(b["name"]);
      if (name !== null && !IDENTITY_NAME_RE.test(name)) {
        return err(422, "Invalid identity name (use lowercase alphanumeric + hyphens)");
      }
      try {
        const result = control.identityImport(root, archivePath, name);
        return { status: 201, body: result };
      } catch (e) {
        if (e instanceof control.ImportError_) return err(422, e.message);
        throw e;
      }
    }

    // POST /api/update (server.py self_update, 202)
    if (method === "POST" && p.length === 1 && p[0] === "update") {
      if (!ctx.controlsEnabled) return READ_ONLY;
      try {
        const result = await runSelfUpdate({
          enabled: ctx.selfUpdateEnabled ?? false,
          repoRoot: ctx.repoRoot ?? root,
          staticDir: ctx.staticDir,
          scheduleRestart: ctx.scheduleRestart,
        });
        return { status: 202, body: result };
      } catch (e) {
        if (e instanceof SelfUpdateError) return err(e.status, e.detail);
        throw e;
      }
    }

    // Everything else mutating: not ported in this lane. Controls still
    // gate first, then an honest 501 instead of a silent stub.
    if (!ctx.controlsEnabled) return READ_ONLY;
    return err(501, `${method} /api/${p.join("/")} is not implemented in this port (see PARITY.md)`);
  } catch (e) {
    if (e instanceof IdentityNotFound) return err(404, "Identity not found");
    if (e instanceof control.ControlError) {
      return err(409, { message: e.message, stderr: e.stderr, exit_code: e.exitCode });
    }
    throw e;
  }
}
