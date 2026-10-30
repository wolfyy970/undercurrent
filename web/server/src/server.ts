// HTTP server for the Headlong-TS viewer: serves the /api/* data layer over
// an identity serve-root, and (in production) the built React viewer with an
// SPA fallback. In dev, Vite serves the frontend and proxies /api here.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleGet, handleMutation, type RouterCtx } from "./router.ts";
import { gitInfo } from "./selfUpdate.ts";

// The repo this server's own code lives in (…/web/server/src/server.ts) —
// same depth/pattern as control.ts's PORT_ROOT. server.py's `_CODE_REPO`.
const CODE_REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** `headlong_web/env.py getenv`: HEADLONG_* canonical, SHELLM_* fallback
 *  (duplicated locally, matching this port's existing per-file convention). */
function getenv(name: string): string | undefined {
  if (name in process.env) return process.env[name];
  const legacy = name.replace("HEADLONG_", "SHELLM_");
  if (legacy !== name && legacy in process.env) return process.env[legacy];
  return undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerOptions {
  root: string; // identity serve root
  staticDir?: string | null; // built viewer client dir (production)
  readOnly?: boolean; // --read-only / HEADLONG_READ_ONLY=1 (index.ts)
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB (SPEC-control-plane.md §B server.ts body cap)

/** Buffer a request body (JSON only, this lane — raw-stream import is Slice C),
 *  enforcing the 1 MiB cap mid-stream. Empty body -> undefined (no JSON to parse). */
function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (result: { ok: true; body: unknown } | { ok: false; status: number; message: string }) => {
      if (done) return;
      done = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Respond and stop accumulating, but don't destroy the socket here —
        // req and res share it, and destroying it before the 413 response
        // flushes races the client into a raw connection-reset instead of a
        // clean HTTP error (observed as `UND_ERR_SOCKET` under undici/fetch).
        finish({ ok: false, status: 413, message: "Request body exceeds 1 MiB" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw === "") {
        finish({ ok: true, body: undefined });
        return;
      }
      try {
        finish({ ok: true, body: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, message: "Invalid JSON body" });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, message: "Invalid request body" }));
  });
}

/** Read a raw gzip-archive upload to a temp file (server.py import_identities:
 *  raw request.stream(), size cap, magic-byte check). Unlike readJsonBody,
 *  this never JSON-parses the body — it's a .shellm.tgz. */
function readRawArchiveBody(req: IncomingMessage): Promise<
  { ok: true; path: string } | { ok: false; status: number; message: string }
> {
  return new Promise((resolve) => {
    const maxMb = Number(process.env["HEADLONG_WEB_MAX_IMPORT_MB"] ?? process.env["SHELLM_WEB_MAX_IMPORT_MB"] ?? "512");
    const maxBytes = (Number.isFinite(maxMb) ? maxMb : 512) * 1024 * 1024;
    const tmpPath = join(tmpdir(), `headlong-import-${randomBytes(8).toString("hex")}.shellm.tgz`);
    const out = createWriteStream(tmpPath);
    // A destroy() while a write is still in flight can surface its
    // completion as an 'error' event afterward; with no listener that is an
    // unhandled-error crash (ERR_STREAM_DESTROYED). We only ever destroy()
    // deliberately (the 413 path below, which already resolves its own
    // outcome), so any post-destroy error here is expected — swallow it.
    out.on("error", () => {});
    let total = 0;
    let firstChunk: Buffer | null = null;
    let done = false;
    const cleanup = () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* already gone */
      }
    };
    const finish = (result: { ok: true; path: string } | { ok: false; status: number; message: string }) => {
      if (done) return;
      done = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      if (firstChunk === null) firstChunk = chunk;
      total += chunk.length;
      if (total > maxBytes) {
        out.destroy();
        cleanup();
        finish({ ok: false, status: 413, message: `Archive exceeds HEADLONG_WEB_MAX_IMPORT_MB (${Math.floor(maxBytes / (1024 * 1024))} MB)` });
        return;
      }
      out.write(chunk);
    });
    req.on("end", () => {
      if (done) return;
      out.end(() => {
        if (done) return;
        if (firstChunk === null || firstChunk[0] !== 0x1f || firstChunk[1] !== 0x8b) {
          cleanup();
          finish({ ok: false, status: 422, message: "Not a gzip archive (.shellm.tgz expected)" });
          return;
        }
        finish({ ok: true, path: tmpPath });
      });
    });
    req.on("error", () => {
      cleanup();
      finish({ ok: false, status: 400, message: "Invalid request body" });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, staticDir: string, urlPath: string): boolean {
  // Resolve within staticDir; SPA fallback to index.html for unknown routes.
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const candidate = normalize(join(staticDir, rel));
  if (!candidate.startsWith(staticDir)) return false;
  let filePath: string | null = null;
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    filePath = candidate;
  } else {
    // SPA fallback
    const index = join(staticDir, "index.html");
    if (existsSync(index)) filePath = index;
  }
  if (!filePath) return false;
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
  return true;
}

export function createApiServer(opts: ServerOptions) {
  // Resolved once at startup — matches server.py's own comment: "the code
  // can't change under a running server (both update paths restart the
  // service after pulling)".
  const startupGitInfo = gitInfo(CODE_REPO);
  const selfUpdateEnabled = getenv("HEADLONG_WEB_SELF_UPDATE") === "1" && !opts.readOnly;
  const ctx: RouterCtx = {
    root: opts.root,
    controlsEnabled: !opts.readOnly,
    selfUpdateEnabled,
    repoRoot: CODE_REPO,
    staticDir: opts.staticDir ?? null,
    gitInfo: startupGitInfo,
  };
  const staticDir = opts.staticDir ? normalize(opts.staticDir) : null;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      const segments = pathname
        .slice(5)
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));

      // POST /api/identities/import: raw gzip-archive upload, not JSON.
      if (method === "POST" && segments.length === 2 && segments[0] === "identities" && segments[1] === "import") {
        // _require_controls() runs BEFORE server.py touches request.stream()
        // at all (server.py import_identities) — check here too, so a
        // read-only server 403s without ever buffering the upload to disk.
        if (!ctx.controlsEnabled) {
          req.resume(); // drain so the client's write doesn't hang on backpressure
          sendJson(res, 403, { detail: "Server is read-only" });
          return;
        }
        readRawArchiveBody(req)
          .then((parsed) => {
            if (!parsed.ok) {
              sendJson(res, parsed.status, { detail: parsed.message });
              return;
            }
            const name = url.searchParams.get("name");
            return handleMutation(ctx, method, segments, { __archivePath: parsed.path, name }).then((result) => {
              try {
                unlinkSync(parsed.path);
              } catch {
                /* already gone */
              }
              sendJson(res, result.status, result.body);
            });
          })
          .catch((e) => {
            sendJson(res, 500, { detail: `Internal error: ${(e as Error).message}` });
          });
        return;
      }

      if (method !== "GET") {
        readJsonBody(req)
          .then((parsed) => {
            if (!parsed.ok) {
              sendJson(res, parsed.status, { detail: parsed.message });
              return;
            }
            return handleMutation(ctx, method, segments, parsed.body).then((result) => {
              sendJson(res, result.status, result.body);
            });
          })
          .catch((e) => {
            sendJson(res, 500, { detail: `Internal error: ${(e as Error).message}` });
          });
        return;
      }

      try {
        const result = handleGet(ctx, segments, url.searchParams);
        if (result === null) {
          sendJson(res, 404, { detail: "Not found" });
          return;
        }
        // Special-case blob text responses (raw body + headers).
        const body = result.body as { __raw_text?: string; __raw_bytes?: Buffer; __headers?: Record<string, string> };
        if (body && typeof body === "object" && "__raw_text" in body) {
          res.writeHead(result.status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            ...(body.__headers ?? {}),
          });
          res.end(body.__raw_text ?? "");
          return;
        }
        // Special-case binary responses (export archives — a .shellm.tgz).
        if (body && typeof body === "object" && "__raw_bytes" in body) {
          res.writeHead(result.status, {
            "Access-Control-Allow-Origin": "*",
            ...(body.__headers ?? {}),
          });
          res.end(body.__raw_bytes);
          return;
        }
        sendJson(res, result.status, result.body);
      } catch (e) {
        sendJson(res, 500, { detail: `Internal error: ${(e as Error).message}` });
      }
      return;
    }

    // Static (production build) or 404.
    if (staticDir && serveStatic(res, staticDir, req.url ?? "/")) return;
    sendJson(res, 404, { detail: "Not found" });
  });
}
