// PORT-NOTE (PARITY.md, "Port extensions for embedders"): read-only activity
// inspection is a port API, not a change to upstream's run-state contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runDirOf } from "./runstate.ts";

export interface IdentityActivity {
  active: boolean;
  /** Unique, sorted names of thinkers with a verified executing step. */
  thinkers: string[];
}

const IDLE: IdentityActivity = { active: false, thinkers: [] };
const CURRENT_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EMBEDDING_ONLY = new Set(["src/api.ts", "src/activity.ts"]);
const NON_EXECUTION_ROOT_ENTRIES = new Set([
  ".git", ".github", ".pinned-tree", "node_modules", "docs", "golden", "parity", "test", "web", "tui", "scripts", "run", "dist", "coverage",
]);
declare const executionRootCertificate: unique symbol;
/** Opaque, process-local proof. Revalidated when used; cannot be serialized or forged. */
export interface VerifiedExecutionRoot { readonly [executionRootCertificate]: true }
const executionRoots = new WeakMap<VerifiedExecutionRoot, string>();

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Exact bytes except the release-version string; all execution/dependency settings stay exact. */
function packageBytes(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8");
  const pkg = JSON.parse(text) as Record<string, unknown>;
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    const value = pkg[key];
    if (value !== undefined && (!value || typeof value !== "object" || Object.keys(value).length > 0)) throw new Error("runtime dependencies are not certified");
  }
  const version = /^  "version": "[^"\\\r\n]+",$/gm;
  if (typeof pkg["version"] !== "string" || [...text.matchAll(version)].length !== 1) throw new Error("unsupported package version format");
  return Buffer.from(text.replace(version, '  "version": "<release>",'));
}

/** Fingerprint the source-engine CLI inputs; source imports are guarded by execution-root.test.ts. */
function executionFingerprint(root: string): string {
  const rootStat = fs.lstatSync(root);
  if (fs.realpathSync(root) !== root || !rootStat.isDirectory()) throw new Error("noncanonical execution root");
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["", "dir", rootStat.mode & 0o7555]) + "\n");
  for (const name of ["bin", "src"]) {
    if (!fs.lstatSync(path.join(root, name)).isDirectory()) throw new Error("missing execution directory");
  }
  const visit = (relative: string): void => {
    const file = path.join(root, relative);
    const before = fs.lstatSync(file);
    if (EMBEDDING_ONLY.has(relative)) {
      if (!before.isFile()) throw new Error("nonregular embedding module");
      return;
    }
    // Archive installs remove write bits; all read/execute/special bits must match.
    const mode = before.mode & 0o7555;
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const real = fs.realpathSync(file);
      const inside = path.relative(root, real).split(path.sep).join("/");
      if ((!inside.startsWith("bin/") && !inside.startsWith("src/")) || EMBEDDING_ONLY.has(inside) || !fs.statSync(real).isFile()) throw new Error("escaping execution link");
      hash.update(JSON.stringify([relative, "link", target]) + "\n");
      if (!sameFile(before, fs.lstatSync(file))) throw new Error("changed execution link");
    } else if (before.isDirectory()) {
      hash.update(JSON.stringify([relative, "dir", mode]) + "\n");
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
      if (!sameFile(before, fs.lstatSync(file))) throw new Error("changed execution directory");
    } else if (before.isFile()) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameFile(before, fs.fstatSync(fd))) throw new Error("changed execution file");
        let bytes: Buffer = fs.readFileSync(fd);
        if (relative === "package.json") bytes = packageBytes(bytes);
        hash.update(JSON.stringify([relative, "file", mode, bytes.length]) + "\n");
        hash.update(bytes);
        if (!sameFile(before, fs.fstatSync(fd)) || !sameFile(before, fs.lstatSync(file))) throw new Error("changed execution file");
      } finally { fs.closeSync(fd); }
    } else throw new Error("unsupported execution input");
  };
  for (const name of fs.readdirSync(root).sort()) {
    if (NON_EXECUTION_ROOT_ENTRIES.has(name) || name.endsWith(".md") || name === "LICENSE" || name === "NOTICE") continue;
    visit(name);
  }
  if (fs.realpathSync(root) !== root || !sameFile(rootStat, fs.lstatSync(root))) throw new Error("changed execution root");
  return hash.digest("hex");
}

function equivalentExecutionRoot(candidate: string): boolean {
  // Only dependency-free retained source archives are supported. The trusted
  // checkout can have development tooling installed; the CLI graph never imports it.
  if (fs.lstatSync(path.join(candidate, "node_modules"), { throwIfNoEntry: false })) return false;
  return executionFingerprint(CURRENT_ROOT) === executionFingerprint(candidate);
}

/**
 * Certify a canonical retained source archive against this trusted release's
 * execution inputs. Only embedding-only API modules and release version may differ.
 * This does not certify a runtime, environment, identity, container or web application.
 */
export function verifyExecutionRoot(candidateRoot: string): VerifiedExecutionRoot | null {
  try {
    const root = path.resolve(candidateRoot);
    if (!equivalentExecutionRoot(root)) return null;
    const certificate = Object.freeze({}) as VerifiedExecutionRoot;
    executionRoots.set(certificate, root);
    return certificate;
  } catch { return null; }
}

export interface IdentityActivityOptions { executionRoot?: VerifiedExecutionRoot }

function certifiedRoot(certificate: VerifiedExecutionRoot): string | null {
  if (!certificate || typeof certificate !== "object") return null;
  const root = executionRoots.get(certificate);
  try { return root && equivalentExecutionRoot(root) ? root : null; } catch { return null; }
}

/** Embedding-only environment wrapper; never changes the CLI resolver itself. */
export function certifiedExecutionEnv(env: Record<string, string>, certificate: VerifiedExecutionRoot): Record<string, string> {
  const root = certifiedRoot(certificate);
  if (!root) throw new Error("execution-root certificate is invalid or no longer equivalent");
  const bin = path.join(root, "bin");
  const rest = (env["PATH"] ?? "").split(path.delimiter).filter((entry) => entry !== path.join(CURRENT_ROOT, "bin") && entry !== bin);
  return { ...env, HEADLONG_TS_HOME: root, PATH: [bin, ...rest].join(path.delimiter) };
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

interface LiveProcess {
  parent: number;
  args: string;
}

/** A conservative snapshot: unknown, missing or unverifiable state is idle. */
export function getIdentityActivity(identityDir: string, opts: IdentityActivityOptions = {}): IdentityActivity {
  const idle = (): IdentityActivity => ({ ...IDLE, thinkers: [] });
  const root = opts.executionRoot === undefined ? CURRENT_ROOT : certifiedRoot(opts.executionRoot);
  if (!root) return idle();
  const runDir = runDirOf(identityDir);
  const dispatcherRaw = read(path.join(runDir, "dispatcher.pid")).trim();
  if (!/^[1-9][0-9]*$/.test(dispatcherRaw)) return idle();
  const dispatcherPid = Number(dispatcherRaw);
  if (!Number.isSafeInteger(dispatcherPid)) return idle();

  const entries = read(path.join(runDir, "step_pids")).split("\n").flatMap((line) => {
    const match = /^([1-9][0-9]*) ([^\s/\\]+)$/.exec(line);
    if (!match || match[2] === "." || match[2] === "..") return [];
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) ? [{ pid, name: match[2]! }] : [];
  });
  if (entries.length === 0) return idle();

  // kill(pid, 0) alone accepts reused PIDs and zombies. Verify one bounded
  // process snapshot, including ownership and exact step command, instead.
  const pids = [...new Set([dispatcherPid, ...entries.map((entry) => entry.pid)])];
  const result = spawnSync("ps", ["-ww", "-p", pids.join(","), "-o", "pid=,ppid=,stat=,args="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return idle();
  const live = new Map<number, LiveProcess>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match || /^[ZX]/.test(match[3]!)) continue;
    live.set(Number(match[1]), { parent: Number(match[2]), args: match[4]! });
  }
  if (!live.get(dispatcherPid)?.args.endsWith(` ${path.join(root, "bin/dispatcherd.mjs")}`)) return idle();

  const thinkers = [...new Set(entries.filter(({ pid, name }) => {
    const step = live.get(pid);
    const script = path.resolve(identityDir, "thinkers", name, "step");
    return step?.parent === dispatcherPid && step.args.endsWith(` ${script}`);
  }).map(({ name }) => name))].sort();
  return { active: thinkers.length > 0, thinkers };
}
