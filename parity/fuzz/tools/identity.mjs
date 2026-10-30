// tools/identity.mjs — fuzz adapter for `identity list [-a]`. Grammar +
// fixture shape from parity/identity/run-parity.mjs (a `.identities`-shaped
// root: info.txt per identity, stray dirs/files, symlinks, dangling `default`).
// Scoped to `list` (read-only) — `new`/`delete`/`import`/`export` mutate real
// dirs and are covered by the dedicated parity/identity/run-{export,import}-
// parity.mjs harnesses, not fuzzed here to avoid clobbering shared state.

import * as fs from "node:fs";
import * as path from "node:path";
import { runBash, runTs, normalize } from "./common.mjs";
import { rmSandbox } from "../lib/sandbox.mjs";
import { randomWord, hostilePathSegment } from "../lib/gen.mjs";
import { isBashLineWordingDeviation } from "../lib/allowances.mjs";

export const name = "identity";
export const bashEnv = "PARITY_BASH_IDENTITY";
export const bashRel = "tools/identity";
export const tsRel = "identity";

function writeInfo(dir, fields) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "info.txt"), Object.entries(fields).map(([k, v]) => `${k}=${v}\n`).join(""));
}

export function generate(rng) {
  const n = rng.int(0, 5);
  const names = new Set();
  const identities = [];
  for (let i = 0; i < n; i++) {
    let nm = rng.bool(0.85) ? randomWord(rng) + rng.int(0, 9) : hostilePathSegment(rng).replace(/[/.]/g, "_") || "x";
    if (!nm || names.has(nm)) continue;
    names.add(nm);
    const created = `202${rng.int(0, 6)}-0${rng.int(1, 9)}-1${rng.int(0, 9)}T0${rng.int(0, 9)}:0${rng.int(0, 9)}:0${rng.int(0, 9)}`;
    identities.push({ name: nm, info: rng.bool(0.15) ? { name: nm, started: created } : { name: nm, created } });
  }
  const seed = { identities, missingRoot: rng.bool(0.05) };
  if (rng.bool(0.3)) seed.dirs = ["strayvisible"];
  if (rng.bool(0.2)) seed.hiddenDirs = [".stray_hidden"];
  if (rng.bool(0.2)) seed.files = ["plainfile.txt"];
  if (rng.bool(0.15) && identities.length) seed.defaultTarget = rng.pick([...names]);
  else if (rng.bool(0.05)) seed.defaultTarget = "ghost";
  if (rng.bool(0.1)) seed.danglingLinks = ["brokenlink"];

  const argv = rng.pickWeighted([
    [["list"], 5],
    [["list", "-a"], 3],
    [["list", "--all"], 2],
    [["list", "foo", "bar"], 1],
    [["list", "-x"], 1],
    [[], 1],
    [["--help"], 1],
  ]);
  return { group: "list", argv, seed };
}

function makeSandbox(seed) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "id-fuzz-"));
  const work = path.join(root, "ids");
  if (!seed.missingRoot) {
    fs.mkdirSync(work, { recursive: true });
    for (const id of seed.identities || []) writeInfo(path.join(work, id.name), id.info);
    for (const d of seed.dirs || []) fs.mkdirSync(path.join(work, d), { recursive: true });
    for (const d of seed.hiddenDirs || []) fs.mkdirSync(path.join(work, d), { recursive: true });
    for (const f of seed.files || []) fs.writeFileSync(path.join(work, f), "x");
    for (const name of seed.danglingLinks || []) {
      try {
        fs.symlinkSync(path.join(work, "___nonexistent___"), path.join(work, name));
      } catch {
        /* ignore */
      }
    }
    if (seed.defaultTarget) {
      try {
        fs.symlinkSync(seed.defaultTarget, path.join(work, "default"));
      } catch {
        /* ignore */
      }
    }
  }
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* ignore */
  }
  return { root, work, roots: [real, root] };
}

export function execute(scenario, ctx) {
  const sbBash = makeSandbox(scenario.seed);
  const sbTs = makeSandbox(scenario.seed);
  const env = { ...process.env };
  const bash = runBash(ctx.bashPath, scenario.argv, { cwd: sbBash.root, env: { ...env, IDENTITY_DIR: sbBash.work } });
  const ts = runTs(ctx.REPO, tsRel, scenario.argv, { cwd: sbTs.root, env: { ...env, IDENTITY_DIR: sbTs.work } });
  rmSandbox(sbBash);
  rmSandbox(sbTs);
  return { bash, ts, roots: { bash: sbBash.roots, ts: sbTs.roots } };
}

export function compare(scenario, result) {
  const { bash, ts, roots } = result;
  const bOut = normalize(bash.stdout, roots.bash);
  const tOut = normalize(ts.stdout, roots.ts);
  const bErr = normalize(bash.stderr, roots.bash);
  const tErr = normalize(ts.stderr, roots.ts);
  const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bash.status === ts.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  let allowed = false;
  let allowReason = null;
  if (!pass && isBashLineWordingDeviation({ exitMatch: cmp.status, stdoutMatch: cmp.stdout, stateMatch: undefined, bashStderr: bErr, tsStderr: tErr })) {
    allowed = true;
    allowReason = "documented deviation: bash internal ${var:?}/[[ ]] line-wording vs port\'s clean error text (shared cross-tool pattern, PARITY.md mem row M1 fix + retrieval row)";
  }
  return {
    cmp,
    pass,
    allowed,
    allowReason,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status }, ts: { stdout: tOut, stderr: tErr, status: ts.status } },
  };
}
