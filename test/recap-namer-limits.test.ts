// recap-namer-limits.test.ts — port of upstream tests/test_rollup_namer_limits.sh
// (2e39a3f, design/rollup_citation_lookup.md). The upstream script observes the
// lookup through a `head` shim, `bash -x` xtrace and READ_LOG — Bash artifacts
// with no port equivalent — so those six checks cannot run against the port
// (parity/upstream-tests/run.mjs records 34/40 for the port, 40/40 for the real
// Bash). This file pins the same bounds on the port by observable behaviour and
// by counting the port's own fs reads.
//
// TEST DATA, not model output: every rollup block in this file ("BASE",
// "unrelated", "citation [target] x…", the malformed/HIDDEN/HUGE candidates)
// is seeded on disk to exercise the lookup bounds. Every call here is
// `--cached`, and the runLlm guard throws if the llm is ever reached.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRecap, type RecapIO } from "../src/recap.js";

// Counts the port's own candidate opens (the Bash script sees them as `head -c
// 32769` calls through a PATH shim).
const reads: string[] = vi.hoisted(() => []);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((p: unknown, ...rest: unknown[]) => {
    if (String(p).includes("/rollups/t")) reads.push(String(p));
    return (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, openSync, default: { ...actual, openSync } };
});

let TMP: string;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "namer-limits-"));
  for (const [name, n] of [["aabb1390-root", 125], ["aabb1391-root", 1000], ["aabb1392-root", 10000]] as const) {
    const d = path.join(TMP, name);
    fs.mkdirSync(path.join(d, "rollups"), { recursive: true });
    fs.writeFileSync(
      path.join(d, "trajectory.jsonl"),
      Array.from({ length: n }, (_, i) =>
        JSON.stringify({ type: "thought", step_id: `s${String(i).padStart(7, "0")}`, ts: "t", content: `raw row ${i}` }),
      ).join("\n") + "\n",
    );
    const r = path.join(d, "rollups");
    fs.writeFileSync(path.join(r, "meta.json"), '{"start_index":0}');
    let size = 10;
    let tier = 1;
    while (size <= n) {
      fs.mkdirSync(path.join(r, `t${tier}`));
      for (let start = 0; start <= n - size; start += size) {
        const ids = start === 0 ? ["target"] : [`id${tier}_${start}`];
        let summary = start === 0 ? "BASE" : "unrelated";
        if (name === "aabb1391-root" && tier === 1) summary = "citation [target] " + "x".repeat(480);
        fs.writeFileSync(
          path.join(r, `t${tier}`, `${String(start).padStart(12, "0")}-${String(start + size).padStart(12, "0")}.json`),
          JSON.stringify({ tier, start, end: start + size, step_ids: ids, summary }),
        );
      }
      size *= 10;
      tier += 1;
    }
  }
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function run(id: string, rawTail = 0, budget = 4000): { out: string; err: string; rc: number } {
  let out = "";
  let err = "";
  const io: RecapIO = {
    cwd: TMP,
    env: { SHELLM_TRAJ_DIR: TMP },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    now: () => new Date("2026-01-02T03:04:05"),
    runLlm: () => {
      throw new Error("--cached must never call the llm");
    },
  };
  const rc = runRecap([id, "--traj_dir", TMP, "--context", "--cached", "--raw-tail", String(rawTail), "--budget", String(budget)], io);
  return { out, err, rc };
}

describe("citation lookup bounds (test_rollup_namer_limits.sh)", () => {
  it("a corrupt displayed block and a corrupt t2 block never abort the assembly", () => {
    const m = path.join(TMP, "aabb1390-root/rollups/t1/000000000100-000000000110.json");
    const w = path.join(TMP, "aabb1390-root/rollups/t2/000000000000-000000000100.json");
    const keepM = fs.readFileSync(m, "utf8");
    const keepW = fs.readFileSync(w, "utf8");
    fs.writeFileSync(m, '{"summary":"bad [target]');
    let r = run("aabb1390", 5);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("raw row 124");
    expect(r.out).toContain("steps 110");
    expect(r.out).toContain("unreadable rollup block");
    fs.writeFileSync(w, '{"summary":');
    r = run("aabb1390", 5);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("raw row 124");
    fs.writeFileSync(m, keepM);
    fs.writeFileSync(w, keepW);
  });

  it("a corrupt or oversized hidden candidate is ignored (hint for oversize), base survives", () => {
    const d = path.join(TMP, "aabb1390-root/rollups/t1/000000000090-000000000100.json");
    const keep = fs.readFileSync(d, "utf8");
    fs.writeFileSync(d, '{"summary":"HIDDEN [target]');
    let r = run("aabb1390", 5);
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain("HIDDEN");
    expect(r.out).toContain("raw row 124");
    fs.writeFileSync(d, JSON.stringify({ summary: "HUGE [target] " + "z".repeat(1_000_000) }));
    r = run("aabb1390", 5);
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain("HUGE");
    expect(r.out).toContain("Citation lookup limited");
    fs.writeFileSync(d, keep);
  });

  it("10x unrelated history still hits the limit hint and finishes", () => {
    const r = run("aabb1392", 0, 4000);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("Citation lookup limited");
  });

  it("a tiny budget cannot balloon citations; whole correction text <=20% and <=4096", () => {
    let r = run("aabb1391", 0, 100);
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(400);
    expect(r.out).toContain("search rollups/t");
    r = run("aabb1391", 0, 4000);
    const extra = Buffer.byteLength(r.out.split("\n").filter((l) => l.startsWith("  [")).map((l) => l + "\n").join(""));
    expect(extra).toBeLessThanOrEqual(3200);
    expect(extra).toBeGreaterThan(0);
    expect(r.out).toContain("Citation lookup limited");
    expect(run("aabb1391", 0, 4000).out).toBe(r.out);
  });

  it("an already oversized base gets no optional stdout text and a stderr hint", () => {
    const r = run("aabb1390", 5, 1);
    expect(r.rc).toBe(0);
    expect(r.out.split("\n").filter((l) => l.startsWith("  [")).length).toBe(0);
    expect(r.err).toContain("search rollups/t");
    expect(r.out).toContain("raw row 124");
  });

  it("probes at most 128 candidate paths and opens each candidate at most once", () => {
    for (const id of ["aabb1391", "aabb1392"]) {
      reads.length = 0;
      const r = run(id, 0, 4000);
      expect(r.rc).toBe(0);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.length).toBeLessThanOrEqual(128);
      expect(new Set(reads).size).toBe(reads.length);
    }
  });
});
