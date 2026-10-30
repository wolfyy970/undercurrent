// export.test.ts — GET /api/identities/:id/export, GET /api/export, the
// export-jobs family (POST/GET/DELETE), route-level (handleGet/handleMutation)
// and real-HTTP-layer (server.ts headers). Expectations read directly from
// server.py's export_identity/export_all_identities/start_export_job/
// list_export_jobs/delete_export_job/export_job_status/export_job_download
// (server.py:770-931) and control.py identity_export/identity_export_all.
// The `identity export` library itself (src/identity.ts) has its own
// differential-parity proof against the real Bash tool at
// parity/identity/run-export-parity.mjs and unit tests at
// test/identity-export.test.ts — this file is about the HTTP surface only.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { handleGet, handleMutation, type RouterCtx } from "../src/router.ts";
import { createApiServer } from "../src/server.ts";
import { readTarGz } from "../../../src/tar.ts";
import { _resetForTests } from "../src/exportJobs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  _resetForTests();
  while (cleanups.length) cleanups.pop()!();
});

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-export-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function ctxFor(root: string, controlsEnabled = true): RouterCtx {
  return { root, controlsEnabled };
}
async function createIdentity(root: string, name: string): Promise<{ id: string; name: string }> {
  const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name });
  expect(result.status).toBe(201);
  const body = result.body as { id: string };
  return { id: body.id, name };
}
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("GET /api/identities/:id/export", () => {
  it("200, gzip bytes decodable as a valid identity archive", async () => {
    const root = freshRoot();
    const { id, name } = await createIdentity(root, "alice");
    const result = handleGet(ctxFor(root), ["identities", id, "export"], new URLSearchParams());
    expect(result!.status).toBe(200);
    const body = result!.body as { __raw_bytes: Buffer; __headers: Record<string, string> };
    expect(body.__headers["Content-Type"]).toBe("application/gzip");
    expect(body.__headers["Content-Disposition"]).toMatch(/attachment; filename="alice-\d{8}-\d{6}\.shellm\.tgz"/);
    const entries = readTarGz(body.__raw_bytes);
    expect(entries.some((e) => e.name === `${name}/info.txt`)).toBe(true);
    expect(entries.some((e) => e.name === "manifest.json")).toBe(true);
  });

  it("soul_only=true excludes trajectories/", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const result = handleGet(ctxFor(root), ["identities", id, "export"], new URLSearchParams("soul_only=true"));
    const body = result!.body as { __raw_bytes: Buffer };
    const entries = readTarGz(body.__raw_bytes);
    expect(entries.some((e) => e.name.startsWith("alice/trajectories"))).toBe(false);
  });

  it("unknown identity -> 404", async () => {
    const root = freshRoot();
    const result = handleGet(ctxFor(root), ["identities", "nobody", "export"], new URLSearchParams());
    expect(result!.status).toBe(404);
  });

  it("available in read-only mode (export is never gated by controls)", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice"); // create with controls on, then read with them off
    const result = handleGet(ctxFor(root, false), ["identities", id, "export"], new URLSearchParams());
    expect(result!.status).toBe(200);
  });
});

describe("GET /api/export (all identities)", () => {
  it("200, archive contains every identity + one manifest", async () => {
    const root = freshRoot();
    await createIdentity(root, "alice");
    await createIdentity(root, "bob");
    const result = handleGet(ctxFor(root), ["export"], new URLSearchParams());
    expect(result!.status).toBe(200);
    const body = result!.body as { __raw_bytes: Buffer; __headers: Record<string, string> };
    expect(body.__headers["Content-Disposition"]).toMatch(/attachment; filename="identities-\d{8}-\d{6}\.shellm\.tgz"/);
    const entries = readTarGz(body.__raw_bytes);
    expect(entries.some((e) => e.name === "alice/info.txt")).toBe(true);
    expect(entries.some((e) => e.name === "bob/info.txt")).toBe(true);
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json")!.data.toString("utf-8"));
    expect(manifest.identities).toHaveLength(2);
  });

  it("zero identities -> 409 (No identities found), not a 500", async () => {
    const root = freshRoot();
    fs.mkdirSync(root, { recursive: true });
    const result = handleGet(ctxFor(root), ["export"], new URLSearchParams());
    expect(result!.status).toBe(409);
    expect((result!.body as { detail: { message: string } }).detail.message).toMatch(/No identities found/);
  });
});

describe("export-jobs — POST create, GET list/status, GET download, DELETE", () => {
  it("full lifecycle: 202 running -> polls to done -> download matches direct export -> delete -> 404", async () => {
    const root = freshRoot();
    const { id, name } = await createIdentity(root, "alice");

    const created = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
    expect(created.status).toBe(202);
    const createdBody = created.body as { job_id: string; identity_id: string; status: string; download_url?: string };
    expect(createdBody.identity_id).toBe(id);
    expect(["running", "done"]).toContain(createdBody.status); // may already be done if setImmediate ran fast
    const jobId = createdBody.job_id;

    await waitUntil(() => {
      const s = handleGet(ctxFor(root), ["export-jobs", jobId], new URLSearchParams());
      return (s!.body as { status: string }).status === "done";
    });

    const status = handleGet(ctxFor(root), ["export-jobs", jobId], new URLSearchParams());
    const statusBody = status!.body as { status: string; download_url: string; filename: string; size: number };
    expect(statusBody.status).toBe("done");
    expect(statusBody.download_url).toBe(`/api/export-jobs/${jobId}/download`);
    expect(statusBody.filename).toMatch(new RegExp(`^${name}-\\d{8}-\\d{6}\\.shellm\\.tgz$`));
    expect(statusBody.size).toBeGreaterThan(0);

    const listed = handleGet(ctxFor(root), ["identities", id, "export-jobs"], new URLSearchParams());
    expect((listed!.body as unknown[]).length).toBe(1);

    const download = handleGet(ctxFor(root), ["export-jobs", jobId, "download"], new URLSearchParams());
    expect(download!.status).toBe(200);
    const dlBody = download!.body as { __raw_bytes: Buffer };
    const directResult = handleGet(ctxFor(root), ["identities", id, "export"], new URLSearchParams());
    const directBytes = (directResult!.body as { __raw_bytes: Buffer }).__raw_bytes;
    // Both built independently (different exported_at wall-clock) — compare
    // decoded entry sets, not raw bytes.
    const jobNames = readTarGz(dlBody.__raw_bytes)
      .map((e) => e.name)
      .sort();
    const directNames = readTarGz(directBytes)
      .map((e) => e.name)
      .sort();
    expect(jobNames).toEqual(directNames);

    const del = await handleMutation(ctxFor(root), "DELETE", ["export-jobs", jobId], {});
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, job_id: jobId });

    const gone = handleGet(ctxFor(root), ["export-jobs", jobId], new URLSearchParams());
    expect(gone!.status).toBe(404);
  });

  it("a second export-jobs POST while one is running -> 409", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const first = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
    expect(first.status).toBe(202);
    // Race the setImmediate: fire the second POST synchronously after, before
    // the microtask queue drains the first job's build.
    const second = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
    if ((first.body as { status: string }).status === "running") {
      expect(second.status).toBe(409);
    }
  });

  it("download while still running -> 409", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const created = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
    const jobId = (created.body as { job_id: string; status: string }).job_id;
    const isRunning = (created.body as { status: string }).status === "running";
    if (isRunning) {
      const download = handleGet(ctxFor(root), ["export-jobs", jobId, "download"], new URLSearchParams());
      expect(download!.status).toBe(409);
    }
  });

  it("DELETE on a running job -> 409, job survives", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const created = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
    const jobId = (created.body as { job_id: string; status: string }).job_id;
    if ((created.body as { status: string }).status === "running") {
      const del = await handleMutation(ctxFor(root), "DELETE", ["export-jobs", jobId], {});
      expect(del.status).toBe(409);
      const status = handleGet(ctxFor(root), ["export-jobs", jobId], new URLSearchParams());
      expect(status!.status).toBe(200);
    }
  });

  it("unknown job_id -> 404 for status, download, and delete", async () => {
    const root = freshRoot();
    expect(handleGet(ctxFor(root), ["export-jobs", "nope"], new URLSearchParams())!.status).toBe(404);
    expect(handleGet(ctxFor(root), ["export-jobs", "nope", "download"], new URLSearchParams())!.status).toBe(404);
    const del = await handleMutation(ctxFor(root), "DELETE", ["export-jobs", "nope"], {});
    expect(del.status).toBe(404);
  });

  it("unknown identity -> 404 for POST export-jobs and GET list", async () => {
    const root = freshRoot();
    const post = await handleMutation(ctxFor(root), "POST", ["identities", "nobody", "export-jobs"], {});
    expect(post.status).toBe(404);
    const list = handleGet(ctxFor(root), ["identities", "nobody", "export-jobs"], new URLSearchParams());
    expect(list!.status).toBe(404);
  });

  it("export-jobs POST/DELETE work in read-only mode (never gated by controls)", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice"); // create with controls on
    const created = await handleMutation(ctxFor(root, false), "POST", ["identities", id, "export-jobs"], {});
    expect(created.status).toBe(202);
    const jobId = (created.body as { job_id: string }).job_id;
    await waitUntil(() => {
      const s = handleGet(ctxFor(root, false), ["export-jobs", jobId], new URLSearchParams());
      return (s!.body as { status: string }).status !== "running";
    });
    const del = await handleMutation(ctxFor(root, false), "DELETE", ["export-jobs", jobId], {});
    expect(del.status).toBe(200);
  });

  it("soul_only/slim flags are recorded on the job and affect the built archive", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const created = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], { soul_only: true });
    const jobId = (created.body as { job_id: string; soul_only: boolean }).job_id;
    expect((created.body as { soul_only: boolean }).soul_only).toBe(true);
    await waitUntil(() => {
      const s = handleGet(ctxFor(root), ["export-jobs", jobId], new URLSearchParams());
      return (s!.body as { status: string }).status === "done";
    });
    const download = handleGet(ctxFor(root), ["export-jobs", jobId, "download"], new URLSearchParams());
    const entries = readTarGz((download!.body as { __raw_bytes: Buffer }).__raw_bytes);
    expect(entries.some((e) => e.name.startsWith("alice/trajectories"))).toBe(false);
  });

  it("keeps only the newest EXPORT_JOBS_KEPT (5) jobs per identity", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "alice");
    const jobIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      // wait for the previous job to finish so each POST succeeds (not 409)
      if (jobIds.length > 0) {
        const last = jobIds[jobIds.length - 1]!;
        await waitUntil(() => {
          const s = handleGet(ctxFor(root), ["export-jobs", last], new URLSearchParams());
          return (s!.body as { status: string }).status !== "running";
        });
      }
      const created = await handleMutation(ctxFor(root), "POST", ["identities", id, "export-jobs"], {});
      expect(created.status).toBe(202);
      jobIds.push((created.body as { job_id: string }).job_id);
    }
    const last = jobIds[jobIds.length - 1]!;
    await waitUntil(() => {
      const s = handleGet(ctxFor(root), ["export-jobs", last], new URLSearchParams());
      return (s!.body as { status: string }).status !== "running";
    });
    const listed = handleGet(ctxFor(root), ["identities", id, "export-jobs"], new URLSearchParams());
    expect((listed!.body as unknown[]).length).toBe(5);
    // the oldest job is gone
    const oldest = handleGet(ctxFor(root), ["export-jobs", jobIds[0]!], new URLSearchParams());
    expect(oldest!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Real HTTP layer (server.ts) — headers actually reach the client.
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
function getRaw(port: number, path_: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: path_, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/identities/:id/export — real HTTP layer", () => {
  it("Content-Type/Content-Disposition/Content-Length headers, decodable body", async () => {
    const root = freshRoot();
    const server = createApiServer({ root, staticDir: null, readOnly: false });
    const port = await listen(server);
    cleanups.push(() => server.close());
    const create = await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/identities", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ name: "alice" }));
    });
    void create;
    const { status, headers, body } = await getRaw(port, "/api/identities/alice/export");
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("application/gzip");
    expect(headers["content-disposition"]).toMatch(/attachment; filename="alice-/);
    expect(Number(headers["content-length"])).toBe(body.length);
    const entries = readTarGz(body);
    expect(entries.some((e) => e.name === "alice/info.txt")).toBe(true);
  });
});
