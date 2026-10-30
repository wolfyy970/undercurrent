// lib/concurrency.mjs — the "2-4 concurrent invocations on the same identity"
// fuzz axis. Real concurrency (node:child_process.spawn + Promise.all, not
// spawnSync), one shared sandbox per side, structural invariants only (exact
// interleaving is inherently racy and not meaningfully diffable byte-for-byte
// — what IS diffable is whether the two implementations preserve the SAME
// invariant under contention: no lost writes, no corruption, no crash).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// PORT-NOTE (1c: 12ca841): put/sub retired along with focus/glob/view — the
// concurrency axis for them (concurrencyPut/concurrencySub below) is removed.
export const CONCURRENCY_TOOLS = ["mem", "traj"];

function spawnAsync(cmd, argv, opts) {
  return new Promise((resolve) => {
    const chunks = { out: [], err: [] };
    const child = spawn(cmd, argv, { ...opts });
    if (opts.input != null) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
    child.stdout.on("data", (d) => chunks.out.push(d));
    child.stderr.on("data", (d) => chunks.err.push(d));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: Buffer.concat(chunks.out), stderr: Buffer.concat(chunks.err) }));
    child.on("error", (err) => resolve({ status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err)) }));
  });
}

async function fireN(n, mk) {
  return Promise.all(Array.from({ length: n }, (_, i) => mk(i)));
}

export async function runConcurrencyLane(tool, ctx, rng) {
  const n = rng.int(2, 4);
  if (tool === "mem") return concurrencyMem(ctx, n);
  if (tool === "traj") return concurrencyTraj(ctx, n);
  return { n, bashOk: true, tsOk: true, match: true, detail: { skipped: true } };
}

async function concurrencyMem(ctx, n) {
  // NO-MODEL LAYER: concurrent `mem add` only; no model call, so no `llm` on PATH at all (a stray call would fail).
  const sbBash = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "mem-conc-bash-"));
  const sbTs = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "mem-conc-ts-"));
  const env = { ...process.env, LC_ALL: "C", LLM_API_URL: "http://127.0.0.1:9/never-called", LLM_PROVIDER: "openai-compatible" };
  delete env.MEM_DIR;
  const runSide = async (kind, sb, tsPath) => {
    const results = await fireN(n, (i) =>
      spawnAsync(kind === "bash" ? ctx.bashPath : "node", kind === "bash" ? ["add", `concurrent memory ${i}`] : [tsPath, "add", `concurrent memory ${i}`], { cwd: sb, env, input: Buffer.alloc(0) }),
    );
    const allZero = results.every((r) => r.status === 0);
    let count = 0;
    try {
      count = fs.readdirSync(path.join(sb, ".memories")).filter((f) => f.endsWith(".md")).length;
    } catch {
      count = 0;
    }
    return { allZero, count, countOk: count === n, statuses: results.map((r) => r.status) };
  };
  const bash = await runSide("bash", sbBash, null);
  const ts = await runSide("ts", sbTs, path.join(ctx.REPO, "bin", "mem.mjs"));
  fs.rmSync(sbBash, { recursive: true, force: true });
  fs.rmSync(sbTs, { recursive: true, force: true });
  const bashOk = bash.allZero && bash.countOk;
  const tsOk = ts.allZero && ts.countOk;
  return { n, bashOk, tsOk, match: bashOk === tsOk, detail: { bash, ts } };
}

async function concurrencyTraj(ctx, n) {
  const sbBash = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "traj-conc-bash-"));
  const sbTs = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "traj-conc-ts-"));
  const rootHex = "12121212";
  const trajId = `${rootHex}-1111-2222-3333-444444444444`;
  const env0 = { ...process.env, LC_ALL: "C" };
  for (const k of ["TRAJ_DIR", "TRAJ_ID", "SHELLM_RUN_STEP_ID"]) delete env0[k];
  const runSide = async (kind, sb, tsPath) => {
    const trajDir = path.join(sb, "traj");
    const rootDir = path.join(trajDir, `${rootHex}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), "");
    const env = { ...env0, TRAJ_DIR: trajDir, TRAJ_ID: trajId };
    const results = await fireN(n, (i) =>
      spawnAsync(kind === "bash" ? ctx.bashPath : "node", kind === "bash" ? ["append", "--field", `type=message`, "--field", `content=concurrent-${i}`] : [tsPath, "append", "--field", `type=message`, "--field", `content=concurrent-${i}`], {
        cwd: sb,
        env,
        input: Buffer.alloc(0),
      }),
    );
    const allZero = results.every((r) => r.status === 0);
    let lines = [];
    try {
      lines = fs
        .readFileSync(path.join(rootDir, "trajectory.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l !== "");
    } catch {
      /* ignore */
    }
    const allValidJson = lines.every((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    return { allZero, lineCount: lines.length, lineCountOk: lines.length === n, allValidJson, statuses: results.map((r) => r.status) };
  };
  const bash = await runSide("bash", sbBash, null);
  const ts = await runSide("ts", sbTs, path.join(ctx.REPO, "bin", "traj.mjs"));
  fs.rmSync(sbBash, { recursive: true, force: true });
  fs.rmSync(sbTs, { recursive: true, force: true });
  const bashOk = bash.allZero && bash.lineCountOk && bash.allValidJson;
  const tsOk = ts.allZero && ts.lineCountOk && ts.allValidJson;
  return { n, bashOk, tsOk, match: bashOk === tsOk, detail: { bash, ts } };
}
