import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Dependency-free source archive fixture, like a git-archive install. */
export function executionArchive(root: string): string {
  const ignored = new Set([".git", ".github", ".pinned-tree", "node_modules", "docs", "golden", "parity", "test", "web", "tui", "scripts", "run", "dist", "coverage"]);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hl-execution-root-")));
  fs.chmodSync(dir, 0o755);
  for (const name of fs.readdirSync(root)) {
    if (!ignored.has(name) && !name.endsWith(".md") && name !== "LICENSE" && name !== "NOTICE") fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true, verbatimSymlinks: true });
  }
  return dir;
}
