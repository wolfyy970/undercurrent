// CLI entry: start the Headlong-TS viewer/control API server over an
// identity serve-root.
//
//   node src/index.ts --root <dir> [--port 8787] [--static <clientDir>] [--read-only]
//
// --root defaults to $HEADLONG_ROOT or the nearest `.identities` dir. The
// serve-root is the directory that CONTAINS identity dirs (each an
// info.txt with root_trajectory=), e.g. headlong/.identities.
//
// --read-only (or HEADLONG_READ_ONLY=1) disables every mutating /api/*
// route (403 "Server is read-only") — the pre-Slice-A behavior, opt-in now.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createApiServer } from "./server.ts";
import { startPushWatcher } from "./push.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const root = resolve(args["root"] ?? process.env.HEADLONG_ROOT ?? ".identities");
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`[headlong-ts web] serve root not found: ${root}`);
  console.error(`Pass --root <dir> pointing at a directory of identity folders (e.g. headlong/.identities).`);
  process.exit(1);
}

const port = Number(args["port"] ?? process.env.PORT ?? 8787);
const staticDir = args["static"] ? resolve(args["static"]) : null;
const readOnly = args["read-only"] === "true" || process.env.HEADLONG_READ_ONLY === "1";

const server = createApiServer({ root, staticDir, readOnly });
server.listen(port, () => {
  console.log(`[headlong-ts web] API serving identities from: ${root}`);
  console.log(`[headlong-ts web] listening on http://localhost:${port}`);
  if (staticDir) console.log(`[headlong-ts web] serving built viewer from: ${staticDir}`);
  if (readOnly) console.log(`[headlong-ts web] read-only mode: controls disabled`);
});

// cli.py _run_production: `if not read_only: PushWatcher(root).start()`.
if (!readOnly) startPushWatcher(root);
