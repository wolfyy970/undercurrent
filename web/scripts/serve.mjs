// Production serve: build the viewer (if needed) then serve the built SPA
// AND the /api data layer from one origin via the data-layer server.
//
//   node scripts/serve.mjs [--root <identities dir>] [--port 8787]
//
// Run `npm run build` first (or this will error if the client build is
// missing). Build output for a react-router SPA lives at
// viewer/build/client.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = arg("port", process.env.PORT ?? "8787");
const clientDir = resolve(WEB, "viewer", "build", "client");
if (!existsSync(clientDir)) {
  console.error(`[serve] Built viewer not found at ${clientDir}`);
  console.error(`[serve] Run: npm run build`);
  process.exit(1);
}

const candidates = [
  arg("root", process.env.HEADLONG_ROOT),
  resolve(REPO, "..", "headlong", ".identities"),
  resolve(REPO, ".identities"),
].filter(Boolean);
const root = candidates.map((c) => resolve(c)).find((c) => existsSync(c) && statSync(c).isDirectory());
if (!root) {
  console.error("[serve] Could not find an identities serve-root. Pass --root <dir> or set HEADLONG_ROOT.");
  process.exit(1);
}

const server = spawn(
  process.execPath,
  [resolve(WEB, "server/src/index.ts"), "--root", root, "--port", port, "--static", clientDir],
  { stdio: "inherit" },
);
server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill("SIGTERM"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
