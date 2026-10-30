// thinkersctl.test.ts — thinkers start/stop/status/step/list/logs against a
// tmp identity, spawning the real dispatcher (PLAN-daemon §8).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import {
  thinkersStart,
  thinkersStop,
  thinkersStatus,
  thinkersStep,
  thinkersList,
  thinkersLogs,
  thinkersEnable,
  thinkersDisable,
} from "../src/thinkersctl.ts";
import { pidAlive } from "../src/runstate.ts";

const BIN_THINKERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "thinkers.mjs");

/** Run the real CLI entry point (bin/thinkers.mjs) with an EXACT env (no
 * process.env merge — the sealed holdout is defined by what is NOT set) and
 * return its stderr text + exit code, matching what a human/`bash bin/thinkers`
 * caller actually sees (bin/thinkers.mjs's top-level catch adds the single
 * `thinkers: error: ` prefix — this is the level bug #67's double-prefix bug
 * lived at, invisible to any test calling thinkersStatus/etc. directly). */
function cliThinkers(argv: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [BIN_THINKERS, ...argv], { env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()!;
    // Best-effort: stop any dispatcher a test left running before removing the tree.
    try {
      const idDir = path.join(root, fs.readdirSync(root)[0] ?? "");
      const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
      await thinkersStop(env, [], { force: true });
    } catch {
      /* already stopped, or never started */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRig(): { root: string; idDir: string; env: Record<string, string>; rootTrajectoryId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-"));
  roots.push(root);
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  fs.writeFileSync(path.join(result.identityDir, "thinkers", "monolith", "disabled"), "x");
  fs.writeFileSync(path.join(result.identityDir, "thinkers", "responder", "disabled"), "x");
  const echoDir = path.join(result.identityDir, "thinkers", "echo");
  fs.mkdirSync(echoDir, { recursive: true });
  fs.writeFileSync(
    path.join(echoDir, "subscriptions.jsonl"),
    `${JSON.stringify({ types: ["message"], trigger_self: false, traj_id: result.rootTrajectoryId })}\n`
  );
  fs.writeFileSync(
    path.join(echoDir, "step"),
    "#!/usr/bin/env node\nimport * as fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\n"
  );
  fs.chmodSync(path.join(echoDir, "step"), 0o755);
  const env = resolveIdentityEnv(result.identityDir, { base: process.env as Record<string, string> });
  return { root, idDir: result.identityDir, env, rootTrajectoryId: result.rootTrajectoryId };
}

async function poll(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!pred()) throw new Error("poll timeout");
}

describe("thinkersctl", () => {
  it("list reflects enabled/disabled state before anything starts", () => {
    const { env } = makeRig();
    const list = thinkersList(env);
    const byName = Object.fromEntries(list.map((e) => [e.name, e]));
    expect(byName["echo"]!.disabled).toBe(false);
    expect(byName["monolith"]!.disabled).toBe(true);
    expect(byName["echo"]!.active).toBe(false);
  });

  it("start [names] spawns the dispatcher, marks names active, and boot-kicks them", async () => {
    const { env, idDir } = makeRig();
    const r = await thinkersStart(env, ["echo"]);
    expect(r.ok).toBe(true);
    expect(r.started).toEqual(["echo"]);
    expect(pidAlive(r.dispatcherPid)).toBe(true);

    const runDir = path.join(idDir, "run");
    expect(fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8")).toBe("echo\n");
    expect(thinkersStatus(env)).toContain("running (PID");
  });

  it("a second start reuses the live dispatcher instead of spawning a new one", async () => {
    const { env } = makeRig();
    const r1 = await thinkersStart(env, ["echo"]);
    const r2 = await thinkersStart(env, ["echo"]);
    expect(r2.dispatcherPid).toBe(r1.dispatcherPid);
  });

  it("stop <name> deactivates it and stops the dispatcher once nothing remains active", async () => {
    const { env, idDir } = makeRig();
    await thinkersStart(env, ["echo"]);
    const runDir = path.join(idDir, "run");
    await poll(() => fs.existsSync(path.join(runDir, "dispatcher.pid")));
    const dpid = Number(fs.readFileSync(path.join(runDir, "dispatcher.pid"), "utf8"));

    await thinkersStop(env, ["echo"], { force: true });
    expect(fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8")).toBe("");
    await poll(() => !pidAlive(dpid));
    expect(fs.existsSync(path.join(runDir, "dispatcher.pid"))).toBe(false);
  });

  it("an explicit stop cancels unlaunched wakes: the wake file and the claim/sent receipts (2e39a3f)", async () => {
    const { env, idDir } = makeRig();
    const runDir = path.join(idDir, "run");
    fs.mkdirSync(path.join(runDir, "claimed"), { recursive: true });
    fs.mkdirSync(path.join(runDir, "sent"), { recursive: true });
    const plant = () => {
      for (const n of ["echo", "other"]) {
        fs.writeFileSync(path.join(runDir, `${n}.wake_at`), "1");
        fs.writeFileSync(path.join(runDir, "claimed", n), "1");
        fs.writeFileSync(path.join(runDir, "sent", n), "1");
      }
    };
    plant();
    await thinkersStop(env, ["echo"], { force: true });
    expect(fs.existsSync(path.join(runDir, "echo.wake_at"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "claimed", "echo"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "sent", "echo"))).toBe(false);
    // only that thinker's receipts go
    expect(fs.existsSync(path.join(runDir, "other.wake_at"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "claimed", "other"))).toBe(true);
    await thinkersStop(env, [], { force: true });
    expect(fs.readdirSync(path.join(runDir, "claimed"))).toEqual([]);
    expect(fs.readdirSync(path.join(runDir, "sent"))).toEqual([]);
    expect(fs.existsSync(path.join(runDir, "other.wake_at"))).toBe(false);
  });

  it("stop with no names stops everything and cleans run/ back down", async () => {
    const { env, idDir } = makeRig();
    await thinkersStart(env, ["echo"]);
    const runDir = path.join(idDir, "run");
    await poll(() => fs.existsSync(path.join(runDir, "dispatcher.pid")));

    await thinkersStop(env, [], { force: true });
    expect(fs.existsSync(path.join(runDir, "dispatcher.pid"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "dispatcher.token"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "active_thinkers"))).toBe(false);
  });

  it("stop refuses an unknown thinker name", async () => {
    const { env } = makeRig();
    await expect(thinkersStart(env, ["not-a-thinker"])).rejects.toThrow(/not found/);
  });

  describe("stop scripts (bin/thinkers:1259,1273,1356,1423 — a thinker's own <dir>/stop is run on every stop path)", () => {
    function addStopScript(thinkerDir: string, marker: string): void {
      fs.writeFileSync(path.join(thinkerDir, "stop"), `#!/usr/bin/env bash\ntouch "${marker}"\n`);
      fs.chmodSync(path.join(thinkerDir, "stop"), 0o755);
    }

    /** echo's step sleeps `sleepMs` after reading stdin, so it stays "in
     *  flight" (a real pid in run/step_pids) long enough to observe drain
     *  vs. force behavior; its own `stop` script touches a marker file. */
    function makeSlowRig(sleepMs = 2000): ReturnType<typeof makeRig> & { echoDir: string; marker: string } {
      const rig = makeRig();
      const echoDir = path.join(rig.idDir, "thinkers", "echo");
      fs.writeFileSync(
        path.join(echoDir, "step"),
        `#!/usr/bin/env node\nimport * as fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\nawait new Promise((r) => setTimeout(r, ${sleepMs}));\n`
      );
      fs.chmodSync(path.join(echoDir, "step"), 0o755);
      const marker = path.join(rig.idDir, "echo.stop-ran");
      addStopScript(echoDir, marker);
      return { ...rig, echoDir, marker };
    }

    async function waitForInFlight(runDir: string): Promise<void> {
      await poll(() => {
        try {
          return fs.readFileSync(path.join(runDir, "step_pids"), "utf8").trim() !== "";
        } catch {
          return false;
        }
      }, 5000);
    }

    it("nothing in flight: stop <name> runs the stop script inline before returning (bin/thinkers:1356)", async () => {
      const { env, idDir } = makeRig();
      const echoDir = path.join(idDir, "thinkers", "echo");
      const marker = path.join(idDir, "echo.stop-ran");
      addStopScript(echoDir, marker);
      await thinkersStop(env, ["echo"]);
      expect(fs.existsSync(marker)).toBe(true);
    });

    it("--force on an in-flight step kills it and runs the stop script inline, synchronously (bin/thinkers:1356-1357)", async () => {
      const { env, idDir, marker } = makeSlowRig();
      const runDir = path.join(idDir, "run");
      await thinkersStart(env, ["echo"]);
      await waitForInFlight(runDir);
      await thinkersStop(env, ["echo"], { force: true });
      expect(fs.existsSync(marker)).toBe(true);
    }, 10_000);

    it("drain (no --force): the stop script does NOT run until the in-flight step exits, then a detached reaper runs it (bin/thinkers:1259)", async () => {
      const { env, idDir, marker } = makeSlowRig();
      const runDir = path.join(idDir, "run");
      await thinkersStart(env, ["echo"]);
      await waitForInFlight(runDir);

      await thinkersStop(env, ["echo"]); // no --force -> drain
      expect(fs.existsSync(marker)).toBe(false); // step is still draining — not run yet

      await poll(() => fs.existsSync(marker), 6000);
    }, 15_000);

    it("stop-all drain runs the stop script for EVERY enabled thinker, not just the one that was in flight (bin/thinkers:1273)", async () => {
      const { env, idDir, marker } = makeSlowRig();
      const runDir = path.join(idDir, "run");

      // A second thinker with nothing ever in flight, own stop script.
      const idleDir = path.join(idDir, "thinkers", "idle");
      fs.mkdirSync(idleDir, { recursive: true });
      fs.writeFileSync(
        path.join(idleDir, "subscriptions.jsonl"),
        `${JSON.stringify({ types: ["message"], trigger_self: false })}\n`
      );
      fs.writeFileSync(
        path.join(idleDir, "step"),
        "#!/usr/bin/env node\nimport * as fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\n"
      );
      fs.chmodSync(path.join(idleDir, "step"), 0o755);
      const idleMarker = path.join(idDir, "idle.stop-ran");
      addStopScript(idleDir, idleMarker);

      await thinkersStart(env, ["echo", "idle"]); // named branch boot-kicks both
      await waitForInFlight(runDir);

      await thinkersStop(env, []); // stop-all, drain (no --force)
      await poll(() => fs.existsSync(marker) && fs.existsSync(idleMarker), 6000);
    }, 15_000);

    // BUG #30 (SIDE-BY-SIDE.md): a live `thinkers stop --force` (all-thinkers
    // branch, no names) left an orphaned monolith step alive past its 180s
    // drain deadline. bin/thinkers:1401-1414's force branch never drains —
    // it kills the whole process tree (TERM, `sleep 1`, KILL survivors)
    // immediately. This step ignores SIGTERM (an unresponsive step is
    // exactly what a stuck monolith run looks like) and spawns a child of
    // its own, so the assertion also proves killTree's recursion reaches a
    // step's children (the docker-exec/sandbox-exec child in production),
    // not just the top-level step pid.
    it("stop-all --force kills an in-flight step AND its child even when the step ignores SIGTERM (BUG #30, bin/thinkers:1401-1414)", async () => {
      const { env, idDir } = makeRig();
      const echoDir = path.join(idDir, "thinkers", "echo");
      const childPidFile = path.join(idDir, "child.pid");
      fs.writeFileSync(
        path.join(echoDir, "step"),
        [
          "#!/usr/bin/env node",
          "import * as fs from 'node:fs';",
          "import { spawn } from 'node:child_process';",
          "fs.readFileSync(0, 'utf8');",
          "process.on('SIGTERM', () => {});", // an unresponsive step — needs SIGKILL, like the observed orphan
          `const child = spawn('sleep', ['300'], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
          "await new Promise(() => {});", // never exits on its own
        ].join("\n")
      );
      fs.chmodSync(path.join(echoDir, "step"), 0o755);

      const runDir = path.join(idDir, "run");
      await thinkersStart(env, ["echo"]);
      await waitForInFlight(runDir);
      await poll(() => fs.existsSync(childPidFile), 5000);
      const stepPid = Number(fs.readFileSync(path.join(runDir, "step_pids"), "utf8").trim().split(" ")[0]);
      const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
      expect(pidAlive(stepPid)).toBe(true);
      expect(pidAlive(childPid)).toBe(true);

      await thinkersStop(env, [], { force: true }); // stop-all, --force

      // Upstream force branch: TERM immediately, `sleep 1`, then KILL
      // survivors — well under the 180s drain deadline that (per BUG #30)
      // the process should never have been left to hit in the first place.
      await poll(() => !pidAlive(stepPid) && !pidAlive(childPid), 5000);
    }, 15_000);

    // BUG #30, other half: the SIDE-BY-SIDE session's FIRST `thinkers stop`
    // (no --force) correctly reported "draining 1 in-flight step(s) (max
    // 180s)", but the detached reaper's own force-kill-after-deadline never
    // fired — the step (and, per the report, its docker-exec child) outlived
    // the 180s drain window and had to be killed by hand. Same unresponsive
    // step as above, but through the DRAIN path with a short drainTimeoutS
    // so the test proves the reaper's post-deadline TERM/KILL actually runs.
    it("stop-all drain force-kills survivors after the drain deadline, even when the step ignores SIGTERM (BUG #30, bin/thinkers-drain.mjs _wait_or_kill)", async () => {
      const { env, idDir } = makeRig();
      const echoDir = path.join(idDir, "thinkers", "echo");
      const childPidFile = path.join(idDir, "child.pid");
      fs.writeFileSync(
        path.join(echoDir, "step"),
        [
          "#!/usr/bin/env node",
          "import * as fs from 'node:fs';",
          "import { spawn } from 'node:child_process';",
          "fs.readFileSync(0, 'utf8');",
          "process.on('SIGTERM', () => {});",
          `const child = spawn('sleep', ['300'], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
          "await new Promise(() => {});",
        ].join("\n")
      );
      fs.chmodSync(path.join(echoDir, "step"), 0o755);

      const runDir = path.join(idDir, "run");
      await thinkersStart(env, ["echo"]);
      await waitForInFlight(runDir);
      await poll(() => fs.existsSync(childPidFile), 5000);
      const stepPid = Number(fs.readFileSync(path.join(runDir, "step_pids"), "utf8").trim().split(" ")[0]);
      const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());

      await thinkersStop(env, [], { drainTimeoutS: 1 }); // stop-all, drain, 1s deadline

      // Deadline (1s) + TERM + `sleep 1` + KILL, run inside a detached
      // reaper process — give real headroom, but far under 180s.
      await poll(() => !pidAlive(stepPid) && !pidAlive(childPid), 8000);
    }, 15_000);
  });

  it("step <name> runs the step SYNCHRONOUSLY inline — no pending file, exit code propagated, stdout/log tee'd", async () => {
    const { env, idDir } = makeRig();
    let stderrText = "";
    let stdoutText = "";
    const r = await thinkersStep(env, "echo", {
      stdout: (s) => (stdoutText += s),
      stderr: (s) => (stderrText += s),
    });
    expect(r.code).toBe(0);
    expect(stderrText).toBe("Running echo/step ...\n");
    expect(stdoutText).toBe(""); // the rig's echo step prints nothing
    // No pending file — bin/thinkers `cmd_step` never writes one.
    const pendingDir = path.join(idDir, "run", "pending");
    expect(fs.existsSync(pendingDir)).toBe(false);
    // The step's (empty) output is still tee'd into the per-thinker log.
    expect(fs.readFileSync(path.join(idDir, "run", "logs", "echo.log"), "utf8")).toBe("");
  });

  it("step <name> works from a shell that has no HEADLONG_TS_HOME: the port's own checkout path is supplied (upstream's Bash steps need no such variable)", async () => {
    const { env, idDir } = makeRig();
    const bare = { ...env } as Record<string, string | undefined>;
    delete bare["HEADLONG_TS_HOME"];
    fs.writeFileSync(path.join(idDir, "thinkers", "echo", "step"), "#!/usr/bin/env node\nprocess.stdout.write(process.env.HEADLONG_TS_HOME ?? 'UNSET');\n");
    fs.chmodSync(path.join(idDir, "thinkers", "echo", "step"), 0o755);
    let out = "";
    await thinkersStep(bare as never, "echo", { stdout: (s) => (out += s) });
    expect(out).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    // an explicit value (a different checkout) is left alone
    out = "";
    await thinkersStep({ ...bare, HEADLONG_TS_HOME: "/elsewhere" } as never, "echo", { stdout: (s) => (out += s) });
    expect(out).toBe("/elsewhere");
  });

  it.each(["monolith", "responder", "retrieval"])("the shipped %s/step runs from a clean env when the wake PATH carries the port's bin (no HEADLONG_TS_HOME)", (name) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const step = path.resolve(here, "../src/assets/thinkers", name, "step");
    const r = spawnSync(process.execPath, [step], { env: { PATH: `${path.resolve(here, "../bin")}:${process.env["PATH"]}` }, input: "{}", encoding: "utf8" });
    expect(r.stderr).not.toContain("HEADLONG_TS_HOME not set");
  });

  it("step <name> propagates a non-zero step exit code", async () => {
    const { env, idDir } = makeRig();
    fs.writeFileSync(
      path.join(idDir, "thinkers", "echo", "step"),
      "#!/usr/bin/env node\nprocess.stdout.write('boom\\n');\nprocess.exit(7);\n"
    );
    fs.chmodSync(path.join(idDir, "thinkers", "echo", "step"), 0o755);
    let stdoutText = "";
    const r = await thinkersStep(env, "echo", { stdout: (s) => (stdoutText += s) });
    expect(r.code).toBe(7);
    expect(stdoutText).toBe("boom\n");
    expect(fs.readFileSync(path.join(idDir, "run", "logs", "echo.log"), "utf8")).toBe("boom\n");
  });

  it("step <name> rejects an unknown thinker without running anything", async () => {
    const { env } = makeRig();
    await expect(thinkersStep(env, "not-a-thinker")).rejects.toThrow(/not found/);
  });

  it("logs returns the thinker's log file content", async () => {
    const { env, idDir } = makeRig();
    expect(thinkersLogs(env, "echo")).toBe(""); // never ran — no log yet
    fs.mkdirSync(path.join(idDir, "run", "logs"), { recursive: true });
    fs.writeFileSync(path.join(idDir, "run", "logs", "echo.log"), "hello\n");
    expect(thinkersLogs(env, "echo")).toBe("hello\n");
  });

  it("status text matches bin/thinkers:1435-1537 shape — blank line, no Concurrency while stopped, disabled thinkers OMITTED, 30-col name + [types]", () => {
    const { env } = makeRig();
    const text = thinkersStatus(env);
    // monolith/responder are disabled in the rig — never listed (upstream's
    // own `_list_thinker_dirs` filter, shared by `start` and `status`).
    expect(text).not.toContain("monolith");
    expect(text).not.toContain("responder");
    // Byte-captured from the real Bash `bin/thinkers status` against the
    // equivalent identity (echo enabled/types=[message], monolith
    // disabled, dispatcher stopped) — see report-adversarial.md
    // misuse/status-text (PARITY).
    expect(text).toBe("Identity:   pax\nDispatcher: stopped\n\nThinkers:\n  echo                           stopped  [message]\n");
  });

  it("status shows Concurrency once the dispatcher is running", async () => {
    const { env } = makeRig();
    await thinkersStart(env, ["echo"]);
    const text = thinkersStatus(env);
    expect(text).toMatch(/^Identity:   pax\nDispatcher: running \(PID \d+\)\nConcurrency: \d+ max\n\nThinkers:\n/);
    expect(text).toMatch(/^ {2}echo {27}(idle|active \(\d+ step\(s\)\)) {2}\[message\]/m);
  });

  it("bare start (no names) never kicks — pending/ exists but stays empty; ALL enabled thinkers become active", async () => {
    const { env, idDir } = makeRig();
    const r = await thinkersStart(env, []);
    expect(r.ok).toBe(true);
    expect(r.started).toEqual(["echo"]); // only enabled thinker in the rig (monolith/responder disabled)

    const runDir = path.join(idDir, "run");
    await poll(() => fs.existsSync(path.join(runDir, "pending")));
    // bin/thinkers:1163-1181 — ONLY the named branch writes a manual-trigger
    // pending file; bare start's own dispatcher boot (_start_dispatcher)
    // still `mkdir -p`s run/pending, but nothing is ever written into it.
    expect(fs.readdirSync(path.join(runDir, "pending"))).toEqual([]);
    expect(fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8")).toBe("echo\n");
  });

  describe("missing THINKERS_DIR (BUG #67, bin/thinkers:151 `[[ -d \"$THINKERS_DIR\" ]] || die ...`)", () => {
    it("status refuses (does not silently report an empty thinker list) when IDENTITY_DIR itself does not exist", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-missing-"));
      roots.push(root);
      const idDir = path.join(root, "nonexistent");
      const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
      const wantDir = path.join(idDir, "thinkers");
      expect(() => thinkersStatus(env)).toThrow(`Thinkers directory not found: ${wantDir}`);
    });

    it("start/stop/list refuse identically when IDENTITY_DIR does not exist", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-missing-"));
      roots.push(root);
      const idDir = path.join(root, "nonexistent");
      const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
      const wantDir = path.join(idDir, "thinkers");
      const msg = `Thinkers directory not found: ${wantDir}`;
      await expect(thinkersStart(env, [])).rejects.toThrow(msg);
      await expect(thinkersStop(env, [])).rejects.toThrow(msg);
      expect(() => thinkersList(env)).toThrow(msg);
    });

    it("status/start/stop/list refuse identically when only THINKERS_DIR is missing (IDENTITY_DIR exists)", async () => {
      const { env, idDir } = makeRig();
      fs.rmSync(path.join(idDir, "thinkers"), { recursive: true, force: true });
      const msg = `Thinkers directory not found: ${env["THINKERS_DIR"]}`;
      expect(() => thinkersStatus(env)).toThrow(msg);
      await expect(thinkersStart(env, [])).rejects.toThrow(msg);
      await expect(thinkersStop(env, [])).rejects.toThrow(msg);
      expect(() => thinkersList(env)).toThrow(msg);
    });
  });

  describe("requireEnv startup-validation order (BUG #67, bin/thinkers:138-155 `_require_env`) — matrix", () => {
    // Expected bytes captured by actually running the real Bash oracle, e.g.:
    //   env -i PATH="$PATH" bash bin/thinkers status
    //   env -i PATH="$PATH" IDENTITY_DIR=/nonexistent bash bin/thinkers status
    //   env -i PATH="$PATH" IDENTITY_DIR=/nonexistent TRAJ_DIR=/tmp/x bash bin/thinkers status
    //   env -i PATH="$PATH" IDENTITY_DIR=/nonexistent TRAJ_DIR=/tmp/x TRAJ_ID=y bash bin/thinkers status
    // against headlong-upstream-main @ 5458fee — all rc=1, and identical
    // across status/start/stop/list (every subcommand calls `_require_env`
    // first, before anything subcommand-specific: bin/thinkers:1096, 1282,
    // 1436, 1541). No THINKERS_DIR/TRAJ_DIR/etc. are pre-derived here —
    // these env objects are exactly what a caller who bypassed
    // `resolveIdentityEnv` (the port's activate-equivalent) would have,
    // mirroring `IDENTITY_DIR` exported by hand without `identity shell`.

    it("library level: IDENTITY_DIR missing entirely -> 'IDENTITY_DIR not set...'", () => {
      const msg = "IDENTITY_DIR not set. Run: identity shell <name>";
      expect(() => thinkersStatus({})).toThrow(msg);
      expect(() => thinkersList({})).toThrow(msg);
    });

    it("library level: TRAJ_DIR missing alone (IDENTITY_DIR set, real dir) -> 'TRAJ_DIR not set...'", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-matrix-"));
      roots.push(root);
      const msg = "TRAJ_DIR not set. Run: identity shell <name>";
      const env = { IDENTITY_DIR: root, TRAJ_ID: "root" };
      expect(() => thinkersStatus(env)).toThrow(msg);
      expect(() => thinkersList(env)).toThrow(msg);
    });

    it("library level: TRAJ_ID missing alone (IDENTITY_DIR + TRAJ_DIR set) -> 'TRAJ_ID not set...'", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-matrix-"));
      roots.push(root);
      const msg = "TRAJ_ID not set. Run: identity shell <name>";
      const env = { IDENTITY_DIR: root, TRAJ_DIR: path.join(root, "trajectories") };
      expect(() => thinkersStatus(env)).toThrow(msg);
      expect(() => thinkersList(env)).toThrow(msg);
    });

    it("library level: IDENTITY_DIR-only, nonexistent dir (the sealed-holdout shape) -> TRAJ_DIR wins, not THINKERS_DIR", () => {
      // This is the case bug #67's fix-so-far missed: bin/thinkers.mjs used
      // to call resolveIdentityEnv() whenever IDENTITY_DIR was merely
      // present, synthesizing TRAJ_DIR/TRAJ_ID from it — so requireEnv never
      // saw them as unset, and fell through to the THINKERS_DIR existence
      // check instead. Exercised here at the library level with a hand-built
      // Partial<ThinkersEnv> that has nothing but IDENTITY_DIR, matching what
      // the CLI-level test below exercises through the real entry point.
      const msg = "TRAJ_DIR not set. Run: identity shell <name>";
      expect(() => thinkersStatus({ IDENTITY_DIR: "/nonexistent" })).toThrow(msg);
      expect(() => thinkersList({ IDENTITY_DIR: "/nonexistent" })).toThrow(msg);
    });

    it("library level: IDENTITY_DIR-only, a REAL existing dir -> still TRAJ_DIR wins (upstream never derives TRAJ_DIR from IDENTITY_DIR)", () => {
      // Verified against the oracle: `env -i PATH="$PATH" IDENTITY_DIR=<real existing dir> bash bin/thinkers status`
      // also says "TRAJ_DIR not set..." — upstream's _require_env has NO
      // fallback for TRAJ_DIR/TRAJ_ID at all (unlike THINKERS_DIR/MEM_DIR/
      // SKILLS_DIR/SKILLS_KERNEL_DIR/SHELLM_HOME, which DO fall back to
      // $IDENTITY_DIR/<sub> when unset). A real, existing IDENTITY_DIR
      // doesn't change that.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-matrix-"));
      roots.push(root);
      const msg = "TRAJ_DIR not set. Run: identity shell <name>";
      expect(() => thinkersStatus({ IDENTITY_DIR: root })).toThrow(msg);
    });

    it("library level: all four vars set but THINKERS_DIR (explicit or derived) doesn't exist -> 'Thinkers directory not found: ...'", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-thinkersctl-matrix-"));
      roots.push(root);
      const derived = { IDENTITY_DIR: root, TRAJ_DIR: path.join(root, "trajectories"), TRAJ_ID: "root" };
      expect(() => thinkersStatus(derived)).toThrow(`Thinkers directory not found: ${path.join(root, "thinkers")}`);

      const explicit = { ...derived, THINKERS_DIR: path.join(root, "nope") };
      expect(() => thinkersStatus(explicit)).toThrow(`Thinkers directory not found: ${path.join(root, "nope")}`);
    });

    it("CLI level (the sealed holdout, exactly): `IDENTITY_DIR=/nonexistent node bin/thinkers.mjs status`, nothing else set -> stderr 'thinkers: error: TRAJ_DIR not set...', rc 1", () => {
      // Director's byte comparison (bug #67 residual gap): before this fix,
      // the port said `thinkers: error: Thinkers directory not found:
      // /nonexistent/thinkers` here — upstream says `thinkers: error: TRAJ_DIR
      // not set. Run: identity shell <name>`. Verified against the oracle:
      //   env -i PATH="$PATH" IDENTITY_DIR=/nonexistent bash bin/thinkers status
      // -> stderr "thinkers: error: TRAJ_DIR not set. Run: identity shell <name>", rc 1
      const env = { PATH: process.env.PATH ?? "" , IDENTITY_DIR: "/nonexistent" };
      for (const argv of [["status"], ["start"], ["stop"], ["list"]]) {
        const r = cliThinkers(argv, env);
        expect(r.stderr).toBe("thinkers: error: TRAJ_DIR not set. Run: identity shell <name>\n");
        expect(r.stdout).toBe("");
        expect(r.status).toBe(1);
      }
    });

    it("CLI level: nothing set at all -> stderr 'thinkers: error: IDENTITY_DIR not set...', rc 1 (also catches the double-prefix regression)", () => {
      // Verified against the oracle: `env -i PATH="$PATH" bash bin/thinkers status`
      // -> stderr "thinkers: error: IDENTITY_DIR not set. Run: identity shell <name>", rc 1
      // Before this fix, requireEnv's three not-set checks baked
      // "thinkers: error: " into the thrown message THEMSELVES, and
      // bin/thinkers.mjs's top-level catch added a SECOND copy on top —
      // double-prefixed at the CLI level even though the message text alone
      // (checked by the library-level tests above) looked correct.
      const r = cliThinkers(["status"], { PATH: process.env.PATH ?? "" });
      expect(r.stderr).toBe("thinkers: error: IDENTITY_DIR not set. Run: identity shell <name>\n");
      expect(r.stdout).toBe("");
      expect(r.status).toBe(1);
    });

    it("CLI level: a fully-activated real identity (via resolveIdentityEnv) still works end to end through bin/thinkers.mjs", () => {
      const { env } = makeRig();
      const r = cliThinkers(["status"], env as Record<string, string>);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Identity:   pax");
      expect(r.stderr).toBe("");
    });
  });

  describe("enable / disable (SPEC-control-plane §D.2, D.4 — Slice B; no upstream bin/thinkers subcommand to diff against)", () => {
    it("enable unlinks the marker and reports needsRestart=false when the dispatcher isn't running", async () => {
      const { env, idDir } = makeRig();
      const markerFile = path.join(idDir, "thinkers", "monolith", "disabled");
      expect(fs.existsSync(markerFile)).toBe(true);
      const r = thinkersEnable(env, "monolith");
      expect(r).toEqual({ ok: true, name: "monolith", needsRestart: false });
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    it("enable is idempotent on an already-enabled thinker", async () => {
      const { env } = makeRig();
      const r = thinkersEnable(env, "echo"); // echo ships enabled in the rig
      expect(r).toEqual({ ok: true, name: "echo", needsRestart: false });
    });

    it("enable reports needsRestart=true while the dispatcher is running", async () => {
      const { env, idDir } = makeRig();
      await thinkersStart(env, ["echo"]);
      const markerFile = path.join(idDir, "thinkers", "monolith", "disabled");
      const r = thinkersEnable(env, "monolith");
      expect(r.needsRestart).toBe(true);
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    it("enable on an unknown thinker throws", async () => {
      const { env } = makeRig();
      expect(() => thinkersEnable(env, "not-a-thinker")).toThrow(/not found/);
    });

    it("disable on a thinker that was never started touches the marker without stopping anything (stoppedFirst=false)", async () => {
      const { env, idDir } = makeRig();
      const markerFile = path.join(idDir, "thinkers", "echo", "disabled");
      expect(fs.existsSync(markerFile)).toBe(false);
      const r = await thinkersDisable(env, "echo");
      expect(r).toEqual({ ok: true, name: "echo", stoppedFirst: false });
      expect(fs.existsSync(markerFile)).toBe(true);
    });

    it("disable is idempotent on an already-disabled thinker (stoppedFirst=false, no error)", async () => {
      const { env } = makeRig();
      const r = await thinkersDisable(env, "monolith"); // ships disabled in the rig
      expect(r).toEqual({ ok: true, name: "monolith", stoppedFirst: false });
    });

    it("disable on a running/active thinker stops it first (stoppedFirst=true) then marks it", async () => {
      const { env, idDir } = makeRig();
      await thinkersStart(env, ["echo"]);
      const runDir = path.join(idDir, "run");
      await poll(() => fs.readFileSync(path.join(runDir, "active_thinkers"), "utf8").includes("echo"));

      const r = await thinkersDisable(env, "echo", { force: true });
      expect(r).toEqual({ ok: true, name: "echo", stoppedFirst: true });
      expect(fs.existsSync(path.join(idDir, "thinkers", "echo", "disabled"))).toBe(true);
      // thinkersStop([echo], {force:true}) removes it from active_thinkers;
      // it was the only active thinker, so the dispatcher stops too.
      await poll(() => !fs.readFileSync(runDir.concat("/active_thinkers"), "utf8").includes("echo"));
      await poll(() => !fs.existsSync(path.join(runDir, "dispatcher.pid")));
    });

    it("disable preserves an existing marker file's content (touch semantics, not overwrite)", async () => {
      const { env, idDir } = makeRig();
      const markerFile = path.join(idDir, "thinkers", "monolith", "disabled");
      fs.writeFileSync(markerFile, "shipped disabled by default\n");
      await thinkersDisable(env, "monolith");
      expect(fs.readFileSync(markerFile, "utf8")).toBe("shipped disabled by default\n");
    });

    it("disable on an unknown thinker throws", async () => {
      const { env } = makeRig();
      await expect(thinkersDisable(env, "not-a-thinker")).rejects.toThrow(/not found/);
    });

    it("enable then disable round-trips the marker", async () => {
      const { env, idDir } = makeRig();
      const markerFile = path.join(idDir, "thinkers", "monolith", "disabled");
      thinkersEnable(env, "monolith");
      expect(fs.existsSync(markerFile)).toBe(false);
      await thinkersDisable(env, "monolith");
      expect(fs.existsSync(markerFile)).toBe(true);
    });
  });
});
