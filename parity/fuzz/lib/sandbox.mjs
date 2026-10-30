// lib/sandbox.mjs — shared sandbox/identity construction, FAKEBIN stubs, and
// on-disk state hashing, factored out of the existing parity/<tool>/run-parity.mjs
// harnesses (put, sub, glob, retrieval, mem, focus) so the fuzzer builds
// byte-identical scratch state on both sides the same way they do.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// --- artifact scrubbing (mirrors every existing harness's scrubArtifactPaths) --
export function makeScrubber(bashToolAbsPath) {
  const HEADLONG_ROOT = bashToolAbsPath ? path.resolve(path.dirname(bashToolAbsPath), "..") : null;
  const HOME = os.homedir();
  return function scrub(s) {
    if (typeof s !== "string") return s;
    let out = s;
    if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
    if (HOME) out = out.split(HOME).join("<HOME>");
    return out;
  };
}

// --- FAKEBIN: GNU-compatible `chmod --reference`, `mem`
// (no `llm` here: the fuzzer's model is lib/replay.mjs, recorded replies or labelled transport fixtures),
// passthrough to a real bash tool, `timeout` no-op shim. Only the pieces a
// given tool needs are written; call the individual write* functions.
export function makeFakebin(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-fuzz-bin-`));
  return dir;
}

export function writeChmodShim(fakebin) {
  fs.writeFileSync(
    path.join(fakebin, "chmod"),
    `#!/usr/bin/env bash
ref=""; args=()
for a in "$@"; do
  case "$a" in
    --reference=*) ref="\${a#--reference=}";;
    *) args+=("$a");;
  esac
done
if [[ -n "$ref" ]]; then
  if m=$(stat -L -f '%Lp' "$ref" 2>/dev/null); then exec /bin/chmod "$m" "\${args[@]}"; fi
  m=$(stat -L -c '%a' "$ref"); exec /bin/chmod "$m" "\${args[@]}"
fi
exec /bin/chmod "$@"
`,
  );
  fs.chmodSync(path.join(fakebin, "chmod"), 0o755);
}

export function writeTimeoutShim(fakebin) {
  fs.writeFileSync(
    path.join(fakebin, "timeout"),
    `#!/usr/bin/env bash
shift; exec "$@"
`,
  );
  fs.chmodSync(path.join(fakebin, "timeout"), 0o755);
}

export function writeMemPassthrough(fakebin, bashMemPath) {
  fs.writeFileSync(path.join(fakebin, "mem"), `#!/usr/bin/env bash\nexec ${JSON.stringify(bashMemPath)} "$@"\n`);
  fs.chmodSync(path.join(fakebin, "mem"), 0o755);
}

// --- simple root/work sandbox (put/sub/view/glob shape) ------------------------
// Layout: <root>/  (private per side; `..` escapes stay inside it)
//         <root>/work/  (tool cwd)
export function makeRootWorkSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-sb-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* ignore */
  }
  return { root, work, roots: [real, root] };
}

export function rmSandbox(sb) {
  try {
    fs.rmSync(sb.root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// --- read-only / missing-dir helpers (used by "environment" fuzz axis) --------
export function makeReadOnlyDir(parent, name = "ro") {
  const p = path.join(parent, name);
  fs.mkdirSync(p, { recursive: true });
  fs.chmodSync(p, 0o555);
  return p;
}
export function restoreWritable(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    /* ignore */
  }
}
export function missingDirPath(parent, name = "does-not-exist") {
  return path.join(parent, name);
}

// --- full scratch identity (traj/chat/mem/focus/recap/skills/retrieval shape) --
// Mirrors parity/retrieval/run-parity.mjs's makeIdentity(): a `.identities/testid`
// tree with info.txt, an empty root trajectory, memories/, skills/, kernel/, and
// a private HOME so nothing escapes into the real user's dotfiles.
export function makeIdentity(trajId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-id-"));
  const id = path.join(root, "ids", "testid");
  fs.mkdirSync(path.join(id, "memories"), { recursive: true });
  fs.mkdirSync(path.join(id, "trajectories", trajId), { recursive: true });
  fs.mkdirSync(path.join(id, "skills"), { recursive: true });
  fs.mkdirSync(path.join(id, "kernel"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(id, "info.txt"), `name=testid\ncreated=2026-01-01T00:00:00\nroot_trajectory=${trajId}\n`);
  fs.writeFileSync(path.join(id, "trajectories", trajId, "trajectory.jsonl"), "");
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* ignore */
  }
  return {
    root,
    id,
    memDir: path.join(id, "memories"),
    trajDir: path.join(id, "trajectories"),
    traj: path.join(id, "trajectories", trajId, "trajectory.jsonl"),
    skillsDir: path.join(id, "skills"),
    kernelDir: path.join(id, "kernel"),
    home: path.join(root, "home"),
    identitiesDir: path.join(root, "ids"),
    roots: [real, root],
  };
}

// --- on-disk state serialization (path + type + mode + sha256; content only
// previewed to keep results.json bounded for 1MB fixtures) ---------------------
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function preview(buf, n = 120) {
  const slice = buf.subarray(0, n);
  let out = "";
  for (const b of slice) {
    if (b === 0x0a) out += "\\n";
    else if (b === 0x09) out += "\\t";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += "\\x" + b.toString(16).padStart(2, "0");
  }
  if (buf.length > n) out += `…(+${buf.length - n}B)`;
  return out;
}
export function walkTree(dir, base, acc, opts = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort by NORMALIZED name when the caller supplies a normalizer: directory
  // names containing a fresh random UUID/hex-id per process (traj `new`/
  // `fork`'s `<hex8>-unnamed`/`<hex8>-root`) would otherwise sort into a
  // different relative order on each side purely because the random bytes
  // differ, producing a spurious "state" divergence from listing ORDER alone
  // even when every entry's (normalized) content is identical. Falls back to
  // raw-name sort (still symmetric, still meaningful) with no normalizer.
  const sortKey = (name) => (opts.normalizeContent ? opts.normalizeContent(name) : name);
  for (const e of entries.sort((a, b) => (sortKey(a.name) < sortKey(b.name) ? -1 : 1))) {
    if (base === "" && opts.skipTop && opts.skipTop.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    let lst;
    try {
      lst = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      let target = "?";
      try {
        target = fs.readlinkSync(full);
      } catch {
        /* ignore */
      }
      acc.push(`LINK ${rel} -> ${target}`);
    } else if (lst.isDirectory()) {
      acc.push(`DIR  ${rel} [${(lst.mode & 0o777).toString(8).padStart(3, "0")}]`);
      walkTree(full, rel, acc, opts);
    } else {
      const buf = fs.readFileSync(full);
      // Hash NORMALIZED content when the caller supplies a normalizer: several
      // tools (traj/chat/mem/skills) write files containing a freshly random
      // UUID/step_id/hex-id/timestamp PER PROCESS — hashing the raw bytes
      // makes every such file's sha differ between the bash and ts sandboxes
      // even when the content is semantically identical post-normalization,
      // producing a false "state" divergence. Falls back to raw bytes (still
      // symmetric, still meaningful) when no normalizer is given.
      const hashInput = opts.normalizeContent ? Buffer.from(opts.normalizeContent(buf.toString("utf8")), "utf8") : buf;
      acc.push(
        `FILE ${rel} [${(lst.mode & 0o777).toString(8).padStart(3, "0")}] [${buf.length}B sha=${sha256(hashInput).slice(0, 16)}] ${JSON.stringify(preview(buf))}`,
      );
    }
  }
}
export function serializeTree(rootDir, opts = {}) {
  if (!fs.existsSync(rootDir)) return "<absent>";
  const acc = [];
  walkTree(rootDir, "", acc, opts);
  if (acc.length === 0) return "<empty>";
  return acc.join("\n");
}
export function hashTree(rootDir, opts = {}) {
  return sha256(Buffer.from(serializeTree(rootDir, opts), "utf8")).slice(0, 32);
}

// --- generic tool invocation ----------------------------------------------------
export function runTool(cmd, argv, opts) {
  const res = spawnSync(cmd, argv, { encoding: "buffer", timeout: 20000, ...opts });
  return {
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ?? Buffer.alloc(0),
    status: res.status,
    signal: res.signal,
    timedOut: !!res.error && res.error.code === "ETIMEDOUT",
  };
}

export function bufNorm(buf, roots) {
  let s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf ?? "");
  for (const r of [...(roots || [])].sort((a, b) => b.length - a.length)) {
    if (r) s = s.split(r).join("<ROOT>");
  }
  return s;
}
