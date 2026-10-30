// exportJobs.ts — the export-jobs bookkeeping server.py keeps inline in
// create_app() (server.py:790-926): one job per identity builds at a time,
// the last EXPORT_JOBS_KEPT finished ones stay listed until deleted or
// evicted. In-process Map, matching upstream's in-process dict — a web
// restart forgets it, same as upstream ("the list lives in process memory").
//
// Upstream builds each archive to a real tmp file (`_export_to_tempfile`,
// `FileResponse(job["path"], ...)`) and unlinks it on delete/eviction. This
// port's exporter runs fully in-process (src/identity.ts, no `tar`/`gzip`
// subprocess) and already returns a Buffer — so a "job" here holds that
// Buffer directly instead of a tmp-file path; there is no on-disk file to
// leak or clean up. Functionally identical from the HTTP client's side
// (same bytes, same headers, same job lifecycle) — see PARITY.md.

import { randomBytes } from "node:crypto";

export type ExportJobStatus = "running" | "done" | "failed";

interface ExportJob {
  id: string;
  identityId: string;
  status: ExportJobStatus;
  soulOnly: boolean;
  slim: boolean;
  started: Date;
  seconds?: number;
  size?: number;
  filename: string;
  error?: string;
  buffer?: Buffer;
}

const EXPORT_JOBS_KEPT = 5;
const jobs = new Map<string, ExportJob>();

/** `datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')` — UTC (server.py's
 *  own web-route stamp; NOT the same clock as the CLI's LOCAL-time stamp —
 *  see src/identity.ts's `localStamp`/`localIsoTimestamp` doc comments). */
function utcStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** `re.sub(r"[^A-Za-z0-9._-]", "-", basename) or "identity"` (server.py `_export_download`). */
export function safeExportBasename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe || "identity";
}

/** Direct (non-job) download filename — `_export_download`'s own stamp,
 *  independent of any job. */
export function directExportFilename(basename: string, now: () => Date = () => new Date()): string {
  return `${safeExportBasename(basename)}-${utcStamp(now())}.shellm.tgz`;
}

export function jobsForIdentity(identityId: string): ReturnType<typeof publicJob>[] {
  return [...jobs.values()]
    .filter((j) => j.identityId === identityId)
    .sort((a, b) => b.started.getTime() - a.started.getTime())
    .map(publicJob);
}

function jobsForIdentityRaw(identityId: string): ExportJob[] {
  return [...jobs.values()]
    .filter((j) => j.identityId === identityId)
    .sort((a, b) => b.started.getTime() - a.started.getTime());
}

export function hasRunningJob(identityId: string): boolean {
  return jobsForIdentityRaw(identityId).some((j) => j.status === "running");
}

/** `_drop_export_job` (server.py:821-824). */
function dropJob(job: ExportJob): void {
  job.buffer = undefined; // no on-disk file to unlink — see header comment
}

/** Keep only the newest `EXPORT_JOBS_KEPT - 1` existing jobs for this
 *  identity (a new one is about to be added, landing the total at
 *  EXPORT_JOBS_KEPT) — server.py:869-870. */
function evictOld(identityId: string): void {
  for (const old of jobsForIdentityRaw(identityId).slice(EXPORT_JOBS_KEPT - 1)) {
    dropJob(old);
    jobs.delete(old.id);
  }
}

export interface StartExportJobOptions {
  identityId: string;
  identityName: string;
  soulOnly: boolean;
  slim: boolean;
  /** Builds the archive — deferred (setImmediate) to mirror upstream's
   *  detached `threading.Thread`, so the caller's response reflects
   *  status:"running" the same way server.py's does. */
  build: () => Buffer;
  now?: () => Date;
}

/** `start_export_job` (server.py:859-888). Throws if a job for this identity
 *  is already running (caller maps to 409, matching server.py). */
export function startExportJob(opts: StartExportJobOptions): ReturnType<typeof publicJob> {
  if (hasRunningJob(opts.identityId)) {
    throw new Error("An export is already building");
  }
  evictOld(opts.identityId);

  const now = opts.now ?? (() => new Date());
  const started = now();
  const flavour = `${opts.slim ? "-slim" : ""}${opts.soulOnly ? "-soul" : ""}`;
  const filename = `${safeExportBasename(opts.identityName)}${flavour}-${utcStamp(started)}.shellm.tgz`;
  const job: ExportJob = {
    id: randomBytes(16).toString("hex"),
    identityId: opts.identityId,
    status: "running",
    soulOnly: opts.soulOnly,
    slim: opts.slim,
    started,
    filename,
  };
  jobs.set(job.id, job);

  setImmediate(() => {
    try {
      const buffer = opts.build();
      job.buffer = buffer;
      job.size = buffer.length;
      job.status = "done";
      job.seconds = (Date.now() - started.getTime()) / 1000;
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
      job.seconds = (Date.now() - started.getTime()) / 1000;
    }
  });

  return publicJob(job);
}

export function getJobRaw(jobId: string): ExportJob | undefined {
  return jobs.get(jobId);
}

/** `delete_export_job` (server.py:896-903). Caller checks status/404 first. */
export function deleteJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  dropJob(job);
  jobs.delete(jobId);
}

export function jobBuffer(jobId: string): Buffer | undefined {
  return jobs.get(jobId)?.buffer;
}

/** `_export_job_public` (server.py:803-819). */
export function publicJob(job: ExportJob): {
  job_id: string;
  identity_id: string;
  status: ExportJobStatus;
  soul_only: boolean;
  slim: boolean;
  started_at: string;
  seconds: number;
  size: number | null;
  filename: string;
  error: string | null;
  download_url?: string;
} {
  const elapsed = job.seconds ?? (Date.now() - job.started.getTime()) / 1000;
  const out: ReturnType<typeof publicJob> = {
    job_id: job.id,
    identity_id: job.identityId,
    status: job.status,
    soul_only: job.soulOnly,
    slim: job.slim,
    started_at: job.started.toISOString(),
    seconds: Math.round(elapsed * 10) / 10,
    size: job.size ?? null,
    filename: job.filename,
    error: job.error ?? null,
  };
  if (job.status === "done") out.download_url = `/api/export-jobs/${job.id}/download`;
  return out;
}

/** Test-only: clears all in-process job state between test files/cases. */
export function _resetForTests(): void {
  jobs.clear();
}
