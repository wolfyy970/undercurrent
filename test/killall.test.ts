// killall.test.ts — panic-button CLI (src/killall.ts) against REAL decoy
// processes matched by their argv path shape.
//
// SAFETY: killall is deliberately system-wide by design (a panic button has
// to see every matching process on the machine, not just ones a given call
// spawned) — its default `psSnapshot` runs a real, unrestricted `ps` over
// the whole machine. Running THAT default for real (non-dry-run) inside a
// test on a shared dev box is dangerous: it can match and kill an unrelated
// live process that merely happens to look like a Headlong process (e.g.
// another agent's own dispatcherd under test elsewhere on the same
// machine — this happened once while developing this suite, see PARITY.md/
// the port report). Every "real kill" test below therefore injects
// `psSnapshot` scoped to just the decoy pids this test itself spawned (see
// scopedSnapshot) — real ps queries, real spawn, real kill(), but the
// candidate set killall's pattern-matching ever sees is restricted to
// processes this test started. The one test that exercises the REAL,
// unrestricted CLI (the ancestor-protection test) is pinned to --dry-run
// for exactly this reason.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execSync, execFileSync } from "node:child_process";
import { killall, parseArgs, runKillall, NON_BROKER_FORMAT, parseNonBrokerRows, type ProcEntry, type DockerListing } from "../src/killall.ts";
import { pidAlive } from "../src/runstate.ts";

const dirs: string[] = [];
const livePids: number[] = [];

afterEach(async () => {
  // Safety net only — a passing test already reaped its own decoys.
  for (const pid of livePids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  livePids.length = 0;
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "killall-test-"));
  dirs.push(d);
  return d;
}

async function poll(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!pred()) throw new Error("poll timeout");
}

/** Spawn a harmless idle decoy at <dir>/<relScriptPath> so its `ps` argv
 *  matches killall's pattern for that path shape. Returns its pid. */
function spawnDecoy(dir: string, relScriptPath: string, body = "setInterval(() => {}, 1000);\n"): number {
  const scriptPath = path.join(dir, relScriptPath);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, body);
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  if (typeof child.pid !== "number") throw new Error("failed to spawn decoy");
  livePids.push(child.pid);
  return child.pid;
}

/** A real `ps -axo pid=,ppid=,command=` read (read-only, harmless), FILTERED
 *  down to only `rootPids` and their descendants — see the file header. */
function scopedSnapshot(rootPids: number[]): () => ProcEntry[] {
  return () => {
    const out = execSync("ps -axo pid=,ppid=,command=").toString();
    const full: ProcEntry[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) full.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
    }
    const allowed = new Set(rootPids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of full) {
        if (allowed.has(p.ppid) && !allowed.has(p.pid)) {
          allowed.add(p.pid);
          changed = true;
        }
      }
    }
    return full.filter((p) => allowed.has(p.pid));
  };
}

/** Empty docker listing — every scoped test below injects this so killall's
 *  real, unrestricted `docker ps` scan (name=^shellm- / label=shellm.broker=1,
 *  which span every container on the host) never runs. Without this seam a
 *  real `shellm-*` sandbox container left running elsewhere on the machine
 *  bleeds into these tests' otherwise-hermetic stdout assertions — see
 *  src/killall.ts's `dockerListing` option doc. */
function emptyDockerListing(): DockerListing {
  return { shellmIds: [], shellmLines: [], brokerLines: [] };
}

function makeIo() {
  let stdoutBuf = "";
  let stderrBuf = "";
  return {
    io: {
      stdout: (s: string) => (stdoutBuf += s),
      stderr: (s: string) => (stderrBuf += s),
    },
    out: () => stdoutBuf,
    err: () => stderrBuf,
  };
}

describe("killall — argument parsing", () => {
  it("no flags: dryRun/web both false", () => {
    const { io } = makeIo();
    expect(parseArgs([], io)).toEqual({ dryRun: false, web: false, help: false });
  });

  it("-n / --dry-run set dryRun", () => {
    const { io } = makeIo();
    expect(parseArgs(["-n"], io).dryRun).toBe(true);
    expect(parseArgs(["--dry-run"], io).dryRun).toBe(true);
  });

  it("--web sets web", () => {
    const { io } = makeIo();
    expect(parseArgs(["--web"], io).web).toBe(true);
  });

  it("-h/--help prints usage to STDERR (matching the real Bash usage()) and exits 0", async () => {
    const { io, err, out } = makeIo();
    const code = await runKillall(["-h"], io);
    expect(code).toBe(0);
    expect(out()).toBe("");
    expect(err()).toBe(
      "Usage: headlong-killall [-n|--dry-run] [--web]\n\n" +
        "  -n, --dry-run   List what would be killed, kill nothing\n" +
        "  --web           Also kill the headlong-web dash\n" +
        "  -h, --help      Show this help\n"
    );
  });

  it("unknown option prints 'Unknown option: X' + usage to stderr and exits 1", async () => {
    const { io, err } = makeIo();
    const code = await runKillall(["--bogus"], io);
    expect(code).toBe(1);
    expect(err()).toBe(
      "Unknown option: --bogus\n" +
        "Usage: headlong-killall [-n|--dry-run] [--web]\n\n" +
        "  -n, --dry-run   List what would be killed, kill nothing\n" +
        "  --web           Also kill the headlong-web dash\n" +
        "  -h, --help      Show this help\n"
    );
  });
});

describe("killall — no matches (scoped to an empty root set, regardless of real system state)", () => {
  it("reports 'No matching processes found.' on stdout", async () => {
    const { io, out, err } = makeIo();
    const result = await killall({ dryRun: true, psSnapshot: scopedSnapshot([]), dockerListing: emptyDockerListing, ...io });
    expect(result).toEqual({ ok: true, killed: [], dryRun: true });
    expect(out()).toBe("No matching processes found.\n(dry run — nothing was killed)\n");
    expect(err()).toBe("");
  });
});

describe("killall — docker cleanup output (FIXTURE dockerListing only, never real docker)", () => {
  it("dry-run prints 'Would remove docker container(s):' and the broker note from a fixture listing", async () => {
    const { io, out } = makeIo();
    const fixture: DockerListing = {
      shellmIds: ["deadbeef0001"],
      shellmLines: ["  shellm-99999 (Up 2 minutes)"],
      brokerLines: ["  shellm-docker-broker (Up 3 days)"],
    };
    const result = await killall({
      dryRun: true,
      psSnapshot: scopedSnapshot([]),
      dockerListing: () => fixture,
      ...io,
    });
    expect(result).toEqual({ ok: true, killed: [], dryRun: true });
    expect(out()).toBe(
      "No matching processes found.\n" +
        "Would remove docker container(s):\n" +
        "  shellm-99999 (Up 2 minutes)\n" +
        "Note: broker container(s) left running (persistent; stop via shellm-docker-broker):\n" +
        "  shellm-docker-broker (Up 3 days)\n" +
        "(dry run — nothing was killed)\n"
    );
  });
});

describe("killall — real decoy processes (psSnapshot scoped to this test's own pids — see file header)", () => {
  it("dry-run lists a matching dispatcherd.mjs decoy but does not kill it", async () => {
    const dir = makeDir();
    const pid = spawnDecoy(dir, "bin/dispatcherd.mjs");
    await poll(() => pidAlive(pid));
    const { io, out } = makeIo();
    const result = await killall({ dryRun: true, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...io });
    expect(result.dryRun).toBe(true);
    expect(result.killed).toEqual([]);
    expect(out()).toContain("Would kill 1 process(es):");
    expect(out()).toContain(String(pid));
    expect(out()).toContain("(dry run — nothing was killed)");
    expect(pidAlive(pid)).toBe(true); // untouched
  });

  it("real run TERMinates a matching dispatcherd.mjs decoy", async () => {
    const dir = makeDir();
    const pid = spawnDecoy(dir, "bin/dispatcherd.mjs");
    await poll(() => pidAlive(pid));
    const { io, out } = makeIo();
    const result = await killall({ dryRun: false, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...io });
    expect(out()).toContain("Killing 1 process(es):");
    expect(result.killed).toEqual([{ pid, command: expect.stringContaining("dispatcherd.mjs") }]);
    await poll(() => !pidAlive(pid));
  });

  it("matches a thinker step wrapper (thinkers/<name>/step)", async () => {
    const dir = makeDir();
    const pid = spawnDecoy(dir, "thinkers/echo/step");
    await poll(() => pidAlive(pid));
    const { io } = makeIo();
    await killall({ dryRun: false, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...io });
    await poll(() => !pidAlive(pid));
  });

  it("matches bin/thinker-step.mjs directly", async () => {
    const dir = makeDir();
    const pid = spawnDecoy(dir, "bin/thinker-step.mjs");
    await poll(() => pidAlive(pid));
    const { io } = makeIo();
    await killall({ dryRun: false, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...io });
    await poll(() => !pidAlive(pid));
  });

  it("matches bin/chat.mjs", async () => {
    const dir = makeDir();
    const chatPid = spawnDecoy(dir, "bin/chat.mjs");
    await poll(() => pidAlive(chatPid));
    const { io } = makeIo();
    await killall({ dryRun: false, psSnapshot: scopedSnapshot([chatPid]), dockerListing: emptyDockerListing, ...io });
    await poll(() => !pidAlive(chatPid));
  });

  it("does NOT match an unrelated process even if it lives under a similar-looking directory", async () => {
    const dir = makeDir();
    // A decoy at a path that CONTAINS "dispatcherd.mjs" only as a substring
    // of a differently-named file must never match (token-boundary regex).
    const pid = spawnDecoy(dir, "bin/not-dispatcherd.mjs.txt.mjs");
    await poll(() => pidAlive(pid));
    const { io, out } = makeIo();
    const result = await killall({ dryRun: true, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...io });
    expect(result.killed).toEqual([]);
    expect(out()).toBe("No matching processes found.\n(dry run — nothing was killed)\n");
  });

  it("expands to the full descendant tree: killing the wrapper also kills its nested child", async () => {
    const dir = makeDir();
    // Simulate thinkers/<name>/step spawning bin/thinker-step.mjs as a child
    // and staying alive (blocking) the whole time, like spawnSync stdio:inherit.
    const childScript = path.join(dir, "bin", "thinker-step.mjs");
    fs.mkdirSync(path.dirname(childScript), { recursive: true });
    fs.writeFileSync(childScript, "setInterval(() => {}, 1000);\n");
    const wrapperBody =
      `import { spawn } from "node:child_process";\n` +
      `const c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(childScript)}], { stdio: "ignore" });\n` +
      `process.on("exit", () => { try { c.kill("SIGKILL"); } catch {} });\n` +
      `setInterval(() => {}, 1000);\n`;
    const wrapperPid = spawnDecoy(dir, "thinkers/echo/step", wrapperBody);
    await poll(() => pidAlive(wrapperPid));

    // Find the nested child's pid via a real (read-only) ps.
    let childPid = -1;
    await poll(() => {
      const out = execSync("ps -axo pid=,ppid=,command=").toString();
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m && Number(m[2]) === wrapperPid && m[3]!.includes("thinker-step.mjs")) {
          childPid = Number(m[1]);
          return true;
        }
      }
      return false;
    });
    livePids.push(childPid);
    expect(pidAlive(childPid)).toBe(true);

    const { io } = makeIo();
    await killall({ dryRun: false, psSnapshot: scopedSnapshot([wrapperPid]), dockerListing: emptyDockerListing, ...io });
    await poll(() => !pidAlive(wrapperPid) && !pidAlive(childPid));
  });

  it("--web also matches the headlong-web dash pattern, but only when passed", async () => {
    const dir = makeDir();
    const pid = spawnDecoy(dir, "web/server/src/index.ts");
    await poll(() => pidAlive(pid));
    const { io: ioNoWeb, out: outNoWeb } = makeIo();
    await killall({ dryRun: true, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...ioNoWeb });
    expect(outNoWeb()).toBe("No matching processes found.\n(dry run — nothing was killed)\n");
    expect(pidAlive(pid)).toBe(true);

    const { io: ioWeb } = makeIo();
    await killall({ dryRun: false, web: true, psSnapshot: scopedSnapshot([pid]), dockerListing: emptyDockerListing, ...ioWeb });
    await poll(() => !pidAlive(pid));
  });
});

describe("killall — real CLI, ancestor protection (dry-run only — see file header)", () => {
  it("protects its own ancestor chain when invoked from inside a matching process", async () => {
    const dir = makeDir();
    const killallMjs = path.resolve("bin/headlong-killall.mjs");
    const wrapperScript = path.join(dir, "bin", "dispatcherd.mjs");
    fs.mkdirSync(path.dirname(wrapperScript), { recursive: true });
    // --dry-run: this exercises the REAL, unrestricted CLI end to end (the
    // point of the test), so it must never actually kill anything.
    fs.writeFileSync(
      wrapperScript,
      `import { spawnSync } from "node:child_process";\n` +
        `const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(killallMjs)}, "--dry-run"], { encoding: "utf8" });\n` +
        `process.stdout.write(r.stdout);\n` +
        `process.stderr.write(r.stderr);\n`
    );
    const wrapperPid = spawn(process.execPath, [wrapperScript], { stdio: "ignore" });
    // We don't strictly need the outer wrapper alive — the assertion is on
    // the ONE-SHOT child invocation's own output, captured synchronously.
    if (typeof wrapperPid.pid === "number") livePids.push(wrapperPid.pid);

    const stdout = execFileSync(process.execPath, [wrapperScript], { encoding: "utf8" });
    // The dry-run child's OWN pid is protected as an ancestor of itself, so
    // no matter what else is alive on the machine, it must warn on stderr
    // about skipping (ancestor) — never crash, and never claim to kill it.
    expect(stdout).not.toContain(" dispatcherd.mjs\n"); // its own pid line never appears in the report
  });
});

// Sync 2e39a3f (tools/headlong-killall): one `docker ps` snapshot with brokers excluded inside the
// --format template. The real CLI path is also checked end-to-end by upstream's
// tests/test_killall_brokers.py run against bin/headlong-killall.mjs (4/4).
describe("killall — non-broker docker snapshot (sync 2e39a3f)", () => {
  it("uses a literal backslash-t in the template, exactly as the Bash passes it", () => {
    expect(NON_BROKER_FORMAT).toBe('{{if ne (.Label "shellm.broker") "1"}}{{.ID}}\\t{{.Names}} ({{.Status}}){{end}}');
  });
  it("splits rows into ids and indented listing lines; blank (broker) rows vanish", () => {
    const rows = "sandbox\tshellm-123 (Up 2 minutes)\n\nnonbroker\tshellm-456 (Up)\n";
    expect(parseNonBrokerRows(rows)).toEqual({
      ids: ["sandbox", "nonbroker"],
      lines: ["  shellm-123 (Up 2 minutes)", "  shellm-456 (Up)"],
    });
  });
  it("an empty snapshot yields nothing", () => {
    expect(parseNonBrokerRows("")).toEqual({ ids: [], lines: [] });
    expect(parseNonBrokerRows("\n\n")).toEqual({ ids: [], lines: [] });
  });
});
