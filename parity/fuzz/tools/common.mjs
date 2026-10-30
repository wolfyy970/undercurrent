// tools/common.mjs — shared plumbing every per-tool adapter uses: resolving
// the real Bash oracle path (env var override, same convention as every
// parity/<tool>/run-parity.mjs), running the TS port via `node`, and generic
// normalization regexes for the nondeterministic surfaces already documented
// by the existing harnesses (timestamps, hex ids, sandbox roots).

import * as path from "node:path";
import { spawnSync } from "node:child_process";

export function resolveBash(envVar, headlongRoot, relPath) {
  return process.env[envVar] || path.join(headlongRoot, relPath);
}

export function runBash(bashPath, argv, opts) {
  return runRaw(bashPath, argv, opts);
}
export function runTs(repo, tsRelPath, argv, opts) {
  return runRaw("node", [path.join(repo, "bin", tsRelPath), ...argv], opts);
}
function runRaw(cmd, argv, opts) {
  // maxBuffer: Node's spawnSync default (1MB) is smaller than this fuzzer's own
  // "1mb"/"64kb" boundary fixtures once a tool echoes/wraps them (e.g. `view`
  // prefixing every line with "     N\t") — a real invocation would never be
  // silently SIGTERM'd + ENOBUFS'd by its own stdout size, so a low maxBuffer
  // is a harness artifact that must not masquerade as a divergence.
  const res = spawnSync(cmd, argv, { encoding: "buffer", timeout: 20000, maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ?? Buffer.alloc(0),
    status: res.status,
    signal: res.signal,
    error: res.error ? String(res.error.code || res.error.message || res.error) : null,
  };
}

// Generic timestamp/id normalizers — union of every existing harness's list.
export function normalizeGeneric(s) {
  if (s == null) return s;
  return s
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<ISO>") // Z optional: recap's own "generated_at" omits it
    .replace(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<DT>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
    // NOTE: NOT `\b...\b` — `\b` is a transition between \w/\W, and an
    // underscore (as in mem/traj's `<ts>_<hex8>_<slug>.md` filenames) is a
    // \w character on both sides of the hex run, so a plain word-boundary
    // regex silently fails to match `_fb29ecc7_` at all. Match a maximal hex
    // run instead (a lookaround excluding more hex digits on either side),
    // which works regardless of what character (or nothing) surrounds it.
    .replace(/(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/g, "<UUID>")
    .replace(/(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/g, "<HEX>")
    .replace(/ line \d+:/g, " line <N>:")
    .replace(/put\.[A-Za-z0-9]{6,}/g, "put.XXXXXX")
    .replace(/sub\.[A-Za-z0-9]{6,}/g, "sub.XXXXXX");
}

// The upstream Bash oracle's own absolute path (bash's `${0}`/`$BASH_SOURCE`
// leaks into its OWN error messages, e.g. `<path>: line N: ...` — a Bash
// runtime detail, not a sandbox path, so it's never in a scenario's `roots`
// array). Scrubbed unconditionally on every normalize() call so no finding
// or report file can leak this machine's absolute checkout path, no matter
// which tool adapter produced it.
const HEADLONG_ROOT_HINT = process.env.HEADLONG_ROOT || null;

export function scrubRoots(s, roots) {
  if (s == null) return s;
  let out = s;
  const all = [...(roots || []), HEADLONG_ROOT_HINT].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const r of all) {
    out = out.split(r).join("<ROOT>");
  }
  return out;
}

export function bufToStr(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf ?? "");
}

// Full normalize pipeline: roots first (so a UUID-looking sandbox dir name
// doesn't get mangled by the generic regexes first), then generic patterns.
export function normalize(buf, roots) {
  return normalizeGeneric(scrubRoots(bufToStr(buf), roots));
}
