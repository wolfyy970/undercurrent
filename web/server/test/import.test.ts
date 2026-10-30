// import.test.ts — POST /api/identities/import (server.py import_identities +
// create_identity's sibling route, control.py identity_import).
//
// Two layers: the router/control layer (handleMutation against a
// pre-staged archive path, mirroring what server.ts hands it after reading
// the raw stream) and the real HTTP layer (server.ts's raw-stream body
// handling: size cap via HEADLONG_WEB_MAX_IMPORT_MB, gzip magic-byte check).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { handleMutation, type RouterCtx } from "../src/router.ts";
import { createApiServer } from "../src/server.ts";
import { writeTarGz, type TarWriteEntry } from "../../../src/tar.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-import-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function ctxFor(root: string, controlsEnabled = true): RouterCtx {
  return { root, controlsEnabled };
}

function basicIdentityEntries(dir: string, name = dir): TarWriteEntry[] {
  const rootTraj = "11112222-3333-4444-5555-666677778888";
  const info = [`name=${name}`, "created=2026-01-01T00:00:00", `root_trajectory=${rootTraj}`].join("\n") + "\n";
  return [
    { name: `${dir}/`, type: "directory" },
    { name: `${dir}/info.txt`, type: "file", data: Buffer.from(info) },
    { name: `${dir}/trajectories/`, type: "directory" },
    { name: `${dir}/trajectories/${rootTraj.slice(0, 8)}-root/`, type: "directory" },
    {
      name: `${dir}/trajectories/${rootTraj.slice(0, 8)}-root/trajectory.jsonl`,
      type: "file",
      data: Buffer.from(`{"type":"trajectory","traj_id":"${rootTraj}"}\n`),
    },
  ];
}

function tmpArchiveFile(entries: TarWriteEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-import-arc-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "archive.shellm.tgz");
  fs.writeFileSync(p, writeTarGz(entries));
  return p;
}

describe("POST /api/identities/import — router/control layer", () => {
  it("201 {ok,imported,stderr} for a valid staged archive", async () => {
    const root = freshRoot();
    const archivePath = tmpArchiveFile(basicIdentityEntries("alice"));
    const result = await handleMutation(ctxFor(root), "POST", ["identities", "import"], { __archivePath: archivePath, name: null });
    expect(result.status).toBe(201);
    const body = result.body as { ok: boolean; imported: { id: string; name: string }[]; stderr: string };
    expect(body.ok).toBe(true);
    expect(body.imported).toEqual([{ id: expect.any(String), name: "alice" }]);
    expect(fs.statSync(path.join(root, "alice")).isDirectory()).toBe(true);
  });

  it("invalid --name query -> 422, before reading the archive", async () => {
    const root = freshRoot();
    const archivePath = tmpArchiveFile(basicIdentityEntries("alice"));
    const result = await handleMutation(ctxFor(root), "POST", ["identities", "import"], { __archivePath: archivePath, name: "Not_Valid!" });
    expect(result.status).toBe(422);
  });

  it("a broken/unsafe archive maps to 422 via ImportError, not a 500", async () => {
    const root = freshRoot();
    const archivePath = tmpArchiveFile([{ name: "../escape.txt", type: "file", data: Buffer.from("x") }]);
    const result = await handleMutation(ctxFor(root), "POST", ["identities", "import"], { __archivePath: archivePath, name: null });
    expect(result.status).toBe(422);
    expect((result.body as { detail: string }).detail).toMatch(/unsafe paths/);
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const archivePath = tmpArchiveFile(basicIdentityEntries("alice"));
    const result = await handleMutation(ctxFor(root, false), "POST", ["identities", "import"], { __archivePath: archivePath, name: null });
    expect(result.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Real HTTP layer (server.ts) — raw gzip upload, size cap, magic bytes.
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
function postRaw(port: number, path_: string, body: Buffer): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: path_, method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("POST /api/identities/import — real HTTP layer (server.ts raw stream)", () => {
  it("a real gzip archive over HTTP -> 201, identity lands on disk", async () => {
    const root = freshRoot();
    const server = createApiServer({ root, staticDir: null, readOnly: false });
    const port = await listen(server);
    cleanups.push(() => server.close());
    try {
      const gz = writeTarGz(basicIdentityEntries("bob"));
      const { status, json } = await postRaw(port, "/api/identities/import", gz);
      expect(status).toBe(201);
      expect((json as { ok: boolean }).ok).toBe(true);
      expect(fs.statSync(path.join(root, "bob")).isDirectory()).toBe(true);
    } finally {
      server.close();
    }
  });

  it("a non-gzip body -> 422 'Not a gzip archive'", async () => {
    const root = freshRoot();
    const server = createApiServer({ root, staticDir: null, readOnly: false });
    const port = await listen(server);
    cleanups.push(() => server.close());
    try {
      const { status, json } = await postRaw(port, "/api/identities/import", Buffer.from("plain text, not gzip"));
      expect(status).toBe(422);
      expect((json as { detail: string }).detail).toMatch(/Not a gzip archive/);
    } finally {
      server.close();
    }
  });

  it("a body over HEADLONG_WEB_MAX_IMPORT_MB -> 413", async () => {
    const root = freshRoot();
    const prevEnv = process.env["HEADLONG_WEB_MAX_IMPORT_MB"];
    process.env["HEADLONG_WEB_MAX_IMPORT_MB"] = "1"; // 1 MiB cap for this test
    const server = createApiServer({ root, staticDir: null, readOnly: false });
    const port = await listen(server);
    cleanups.push(() => {
      server.close();
      if (prevEnv === undefined) delete process.env["HEADLONG_WEB_MAX_IMPORT_MB"];
      else process.env["HEADLONG_WEB_MAX_IMPORT_MB"] = prevEnv;
    });
    try {
      // Gzip-magic prefix so a smaller-cap check wouldn't be confused with the
      // magic-byte check; the bulk padding pushes it over the 1 MiB cap.
      const oversized = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(2 * 1024 * 1024, 0x41)]);
      const { status } = await postRaw(port, "/api/identities/import", oversized);
      expect(status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("read-only mode -> 403, before the raw stream is ever buffered (matches server.py's _require_controls-first ordering)", async () => {
    const root = freshRoot();
    const server = createApiServer({ root, staticDir: null, readOnly: true });
    const port = await listen(server);
    cleanups.push(() => server.close());
    try {
      const gz = writeTarGz(basicIdentityEntries("carol"));
      const { status } = await postRaw(port, "/api/identities/import", gz);
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });
});
