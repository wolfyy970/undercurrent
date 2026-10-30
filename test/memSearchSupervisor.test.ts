// memSearchSupervisor.test.ts — `mem search` supervisor/worker (upstream sync 2e39a3f,
// 2a63d92 issue 119 + 30f8bbe): the deadline, group cancellation, and exit codes.
// The shape is oracle-tested by upstream's test_mem_search*.sh (parity/upstream-tests).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { searchSupervisorPlan } from "../src/mem.js";

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/mem.mjs");

describe("searchSupervisorPlan", () => {
  const E = {};
  it("is null unless the command is `search` with a query", () => {
    expect(searchSupervisorPlan(["add", "search"], E, "/")).toBeNull();
    expect(searchSupervisorPlan(["search"], E, "/")).toBeNull();
    expect(searchSupervisorPlan(["--help", "search", "x"], E, "/")).toBeNull();
    expect(searchSupervisorPlan([], E, "/")).toBeNull();
  });
  it("skips the global flags before the command; default deadline is 300s", () => {
    expect(searchSupervisorPlan(["-v", "--dir", "d", "search", "q"], E, "/")).toEqual({ timeoutS: 300 });
  });
  it("normalizes MEM_SEARCH_TIMEOUT_S: digits as given, 0 = none, junk = 300", () => {
    expect(searchSupervisorPlan(["search", "q"], { MEM_SEARCH_TIMEOUT_S: "7" }, "/")).toEqual({ timeoutS: 7 });
    expect(searchSupervisorPlan(["search", "q"], { MEM_SEARCH_TIMEOUT_S: "0" }, "/")).toEqual({ timeoutS: 0 });
    expect(searchSupervisorPlan(["search", "q"], { MEM_SEARCH_TIMEOUT_S: "soon" }, "/")).toEqual({ timeoutS: 300 });
  });
});

describe("mem search (real processes)", () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-sup-"));
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.mkdirSync(path.join(tmp, "mem"));
    fs.mkdirSync(path.join(tmp, "tmp"));
    fs.writeFileSync(path.join(tmp, "mem", "a.md"), "---\nsummary: alpha\ntype: fact\n---\nalpha\n");
    env = {
      ...process.env,
      PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
      MEM_DIR: path.join(tmp, "mem"),
      TMPDIR: path.join(tmp, "tmp"),
      MEM_SEARCH_HEARTBEAT_S: "0",
      PIDS: path.join(tmp, "pids"),
    };
  });
  afterEach(() => {
    for (const p of fs.existsSync(env.PIDS!) ? fs.readFileSync(env.PIDS!, "utf8").split(/\s+/).filter(Boolean) : []) {
      try {
        process.kill(Number(p), "SIGKILL");
      } catch {
        /* gone */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const stub = (body: string) => {
    const f = path.join(tmp, "bin", "llm");
    fs.writeFileSync(f, `#!/usr/bin/env bash\ncat >/dev/null\necho $$ >> "$PIDS"\n${body}\n`, { mode: 0o755 });
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("a wedged, TERM-ignoring model is killed at the deadline: rc 124, one stderr line, no leftovers", () => {
    stub("trap '' TERM INT\nsleep 30 &\nwait");
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [MEM, "search", "alpha"], { env: { ...env, MEM_SEARCH_TIMEOUT_S: "1" }, encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(124);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.stderr).toBe("mem search: no reply from the model within 1s (MEM_SEARCH_TIMEOUT_S); giving up on this query.\n");
    expect(r.stdout).toBe("");
    expect(fs.readdirSync(path.join(tmp, "tmp"))).toEqual([]); // private marker dir removed
    const pid = Number(fs.readFileSync(env.PIDS!, "utf8").split(/\s+/)[0]);
    expect(alive(pid)).toBe(false);
  }, 20000);

  it("a failing model's exit code passes through (no deadline message)", () => {
    stub("exit 42");
    const r = spawnSync(process.execPath, [MEM, "search", "alpha"], { env, encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(42);
    expect(r.stderr).not.toContain("MEM_SEARCH_TIMEOUT_S");
  }, 20000);

  it("public TERM cancels the whole group and exits 143", async () => {
    stub('touch "' + path.join(tmp, "ready") + '"\ntrap \'\' TERM INT\nsleep 30 &\nwait');
    const child = spawn(process.execPath, [MEM, "search", "alpha"], { env, stdio: "ignore" });
    const done = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(tmp, "ready")); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    expect(await done).toBe(143);
    const pid = Number(fs.readFileSync(env.PIDS!, "utf8").split(/\s+/)[0]);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
    expect(fs.readdirSync(path.join(tmp, "tmp"))).toEqual([]);
  }, 20000);
});
