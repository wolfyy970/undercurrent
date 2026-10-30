// Dev orchestrator: run the Headlong-TS data-layer API server and the Vite
// viewer together, with Vite proxying /api to the server. Zero deps.
//
//   node scripts/dev.mjs [--root <identities dir>] [--api-port 8787] [--viewer-port 5273]
//
// --root is the directory that CONTAINS identity folders (each an info.txt
// with root_trajectory=). Defaults to $HEADLONG_ROOT, else the bundled
// sample identities in ../headlong/.identities (a sibling checkout), which
// includes the real `pax` identity used by the parity proof.

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

const apiPort = arg("api-port", process.env.API_PORT ?? "8787");
const viewerPort = arg("viewer-port", process.env.VIEWER_PORT ?? "5273");

const candidates = [
  arg("root", process.env.HEADLONG_ROOT),
  resolve(REPO, "..", "headlong", ".identities"), // sibling headlong checkout
  resolve(REPO, ".identities"), // the port's own identities, if any
].filter(Boolean);

const root = candidates.map((c) => resolve(c)).find((c) => existsSync(c) && statSync(c).isDirectory());

if (!root) {
  console.error("[dev] Could not find an identities serve-root.");
  console.error("[dev] Pass --root <dir> (a folder of identity dirs), or set HEADLONG_ROOT.");
  console.error("[dev] Tried:\n  " + candidates.map((c) => resolve(c)).join("\n  "));
  process.exit(1);
}

console.log(`[dev] serve-root : ${root}`);
console.log(`[dev] API        : http://localhost:${apiPort}`);
console.log(`[dev] viewer      : http://localhost:${viewerPort}\n`);

const api = spawn(
  process.execPath,
  [resolve(WEB, "server/src/index.ts"), "--root", root, "--port", apiPort],
  { stdio: "inherit" },
);

const viewer = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "dev"],
  {
    cwd: resolve(WEB, "viewer"),
    stdio: "inherit",
    env: { ...process.env, HEADLONG_API_URL: `http://localhost:${apiPort}`, VIEWER_PORT: viewerPort },
  },
);

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [api, viewer]) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}
api.on("exit", (code) => { console.error(`[dev] API server exited (${code})`); shutdown(code ?? 0); });
viewer.on("exit", (code) => { console.error(`[dev] viewer exited (${code})`); shutdown(code ?? 0); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
