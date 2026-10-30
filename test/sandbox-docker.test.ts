// sandbox-docker.test.ts — refactor-safety net for DockerSandbox INTERNALS.
//
// Everything here runs WITHOUT a Docker daemon (CI-safe): the pure arg/env/
// mapping functions are exercised directly, and exec() is driven against a
// FAKE `docker` executable that strips the exec wrapper and runs the block —
// mocking the docker child process. The one test that needs a real daemon lives
// in the describe.skipIf block at the bottom and skips cleanly when absent.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  DockerSandbox,
  DOCKER_CONTAINER_PATH,
  REMOTE_SUPERVISE_SCRIPT,
  mapSpawnResult,
} from "../src/sandbox-docker.js";
import { LocalSandbox } from "../src/sandbox.js";
import type { ExecRequest } from "../src/sandbox.js";
import { selectSandbox } from "../src/sandbox-runtime.js";

// ---- a fake `docker` on disk (mocks the docker exec child process) ----------
// It emulates `docker exec [-i|--user U|-e NAME|-e NAME=VAL|-w DIR]... CONTAINER
// bash -c SCRIPT _ CONTROL_DIR` (2e39a3f: the supervisor script reads the code
// block from stdin): consume the exec flags, then `exec` the trailing command.
// Because spawnSync hands our child env to this process, any `-e NAME` the code
// reads is already in the environment — exactly the forwarding contract docker
// implements. All `exec`s share one PID, so a timeout kill hits the block.
const FAKE_DOCKER = `#!/usr/bin/env bash
[ "$1" = exec ] || { echo "fake-docker: expected 'exec', got '$1'" >&2; exit 99; }
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -i) shift ;;
    --user) shift; shift ;;
    -e) shift; shift ;;
    -w) shift; shift ;;
    *) shift; break ;;   # container name; rest is: bash -e -c CODE
  esac
done
exec "$@"
`;

function makeFakeDocker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  const p = path.join(dir, "docker");
  fs.writeFileSync(p, FAKE_DOCKER);
  fs.chmodSync(p, 0o755);
  return p;
}

function req(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    workdir: "/work",
    wrappedCode: "set -x\necho hi\nset +x\n__shellm_rc=$?\nexit $__shellm_rc\n",
    env: { PATH: "/host/bin:/usr/bin", TRAJ_ID: "abc123", IDENTITY_NAME: "nova" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe("DockerSandbox.buildDockerExecArgs — matches bin/shellm execute_code", () => {
  const sb = new DockerSandbox({ container: "shellm-nova" });

  it("emits exec, then bare -e NAME for every NON-PATH var (values off the cmdline)", () => {
    const args = sb.buildDockerExecArgs(req());
    // PATH from the caller must NOT appear as an -e flag (host PATH is dropped).
    expect(args).not.toContain("PATH=/host/bin:/usr/bin");
    // Non-PATH vars ride as bare `-e NAME` — no value on the command line.
    // (Exclude bash's own `-c` flag, which also follows a `-e` token.)
    const eNames = args.filter(
      (a, i) => args[i - 1] === "-e" && !a.includes("=") && !a.startsWith("-"),
    );
    expect(eNames).toEqual(["TRAJ_ID", "IDENTITY_NAME"]);
    // No `-e NAME=VALUE` for a secret-bearing var (only PATH/HOME carry values).
    expect(args).not.toContain("TRAJ_ID=abc123");
  });

  it("sets container PATH + HOME=<workdir>, -w <workdir>, container, then bash -e -c <code>", () => {
    const r = req();
    const args = sb.buildDockerExecArgs(r);
    // Trailing shape is exact and ordered: the supervisor script, then $0=_ and
    // the control directory. The code block itself is NOT in argv (2e39a3f).
    expect(args.slice(-5, -2)).toEqual(["bash", "-c", REMOTE_SUPERVISE_SCRIPT]);
    expect(args.slice(-2)[0]).toBe("_");
    expect(args.slice(-2)[1]).toMatch(/^\/tmp\/shellm-exec\./);
    expect(args).not.toContain(r.wrappedCode);
    expect(sb.buildStdin(r)).toBe(r.wrappedCode + "\n");
    expect(args.slice(0, 2)).toEqual(["exec", "-i"]);
    const containerIdx = args.indexOf("shellm-nova");
    expect(args[containerIdx - 2]).toBe("-w");
    expect(args[containerIdx - 1]).toBe("/work");
    expect(args).toContain(`PATH=${DOCKER_CONTAINER_PATH}`);
    expect(args).toContain("HOME=/work");
    // set -x lives in the wrappedCode (shellm layer); DockerSandbox adds none.
    expect(sb.buildStdin(r).match(/set -x/g)?.length ?? 0).toBe(1); // exactly one — no double-wrap
    expect(args.join("\n")).not.toContain("set -x");
    expect(args[0]).toBe("exec");
  });

  it("honors a custom containerPath", () => {
    const custom = new DockerSandbox({ container: "c", containerPath: "/opt/bin:/bin" });
    expect(custom.buildDockerExecArgs(req())).toContain("PATH=/opt/bin:/bin");
  });

  // PORT-BUG regression: req.env carries HOME=<workdir> (src/shellm.ts). The
  // loop over req.env keys used to emit a bare `-e HOME` for it (like any other
  // non-PATH var) IN ADDITION to the explicit `-e HOME=<workdir>` pushed below —
  // a duplicate `-e HOME` / `-e HOME=<workdir>` pair. HOME must be treated like
  // PATH: dropped from the generic loop, set exactly once via the explicit flag.
  it("emits exactly one HOME flag (HOME=<workdir>), never a bare -e HOME", () => {
    const r = req({ env: { PATH: "/host/bin", HOME: "/wd-from-caller", TRAJ_ID: "abc123" } });
    const args = sb.buildDockerExecArgs(r);
    const eFlags = args.filter((a, i) => args[i - 1] === "-e");
    expect(eFlags.filter((a) => a === "HOME" || a.startsWith("HOME="))).toEqual(["HOME=/work"]);
    // Other non-PATH keys still ride as bare `-e NAME`.
    expect(eFlags).toContain("TRAJ_ID");
  });
});

describe("DockerSandbox.buildChildEnv — forwards VALUES via the child environment", () => {
  it("carries every non-PATH value; drops the caller PATH; keeps the base env", () => {
    const sb = new DockerSandbox({
      container: "c",
      baseEnv: { PATH: "/base/bin", DOCKER_HOST: "unix:///x.sock" },
    });
    const env = sb.buildChildEnv(req());
    expect(env["TRAJ_ID"]).toBe("abc123");
    expect(env["IDENTITY_NAME"]).toBe("nova");
    // Caller PATH is meaningless in the container → not forwarded; base PATH
    // (needed to find the docker binary) survives.
    expect(env["PATH"]).toBe("/base/bin");
    expect(env["DOCKER_HOST"]).toBe("unix:///x.sock");
  });

  // PORT-BUG regression: req.env carries HOME=<workdir> (src/shellm.ts sets it
  // for every step). Overlaying that onto the HOST docker process's env — as
  // buildChildEnv used to do for every non-PATH key — points the host `docker`
  // CLI's HOME at the workdir, so it can't find ~/.docker/config.json and falls
  // back to the default socket ("failed to connect to the docker API at
  // unix:///var/run/docker.sock"), even though container creation (which
  // doesn't need config.json) works. The container still needs its own
  // HOME=<workdir>, but that must ride ONLY on the explicit `-e HOME=<workdir>`
  // flag in buildDockerExecArgs — never on the host child env. HOME is host-
  // critical exactly like PATH: skip it here, same as PATH.
  it("keeps the HOST's HOME for the docker CLI — never overlays req.env's workdir HOME", () => {
    const sb = new DockerSandbox({
      container: "c",
      baseEnv: { HOME: "/host", PATH: "/hp" },
    });
    const env = sb.buildChildEnv(req({ env: { HOME: "/wd", FOO: "1", PATH: "/x" } }));
    expect(env["HOME"]).toBe("/host");
    expect(env["FOO"]).toBe("1");
    expect(env["PATH"]).toBe("/hp");
  });
});

describe("mapSpawnResult — exit-code + timeout mapping (pure, no daemon)", () => {
  const base = (over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> => ({
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...over,
  });

  it("passes a numeric non-zero exit straight through", () => {
    expect(mapSpawnResult(base({ status: 7, stdout: "oops\n" }))).toEqual({
      output: "oops\n",
      exit: 7,
      timedOut: false,
    });
  });

  it("merges stdout then stderr into output", () => {
    const r = mapSpawnResult(base({ status: 0, stdout: "a", stderr: "b" }));
    expect(r.output).toBe("ab");
  });

  it("maps a SIGTERM timeout to exit 124 + timedOut", () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const r = mapSpawnResult(base({ status: null, signal: "SIGTERM", error: err, stdout: "partial" }));
    expect(r).toEqual({ output: "partial", exit: 124, timedOut: true });
  });

  it("THROWS on a genuine spawn failure (docker/bash missing) rather than faking a result", () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    expect(() => mapSpawnResult(base({ status: null, signal: null, error: err }))).toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
describe("DockerSandbox.exec — end to end against a fake docker (no daemon)", () => {
  function sandbox(): DockerSandbox {
    return new DockerSandbox({ container: "fake", dockerPath: makeFakeDocker() });
  }

  it("captures stdout, exit 0", async () => {
    const r = await sandbox().exec(req({ wrappedCode: "echo hello\n" }));
    expect(r.output).toBe("hello\n");
    expect(r.exit).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("passes a non-zero exit code through docker exec", async () => {
    const r = await sandbox().exec(req({ wrappedCode: "echo boom; exit 7\n" }));
    expect(r.output).toBe("boom\n");
    expect(r.exit).toBe(7);
  });

  it("merges stderr into stdout in true stream order (2>&1)", async () => {
    const r = await sandbox().exec(req({ wrappedCode: "echo out; echo err >&2; echo out2\n" }));
    expect(r.output).toBe("out\nerr\nout2\n");
  });

  it("forwards a non-PATH env VALUE into the executed block (the -e NAME contract)", async () => {
    const r = await sandbox().exec(
      req({ env: { PATH: "/ignored", TRAJ_ID: "xyz789" }, wrappedCode: 'echo "id=$TRAJ_ID"\n' }),
    );
    expect(r.output).toBe("id=xyz789\n");
  });

  it("survives single quotes in the wrapped code (shq)", async () => {
    const r = await sandbox().exec(req({ wrappedCode: "echo 'a'\\''b'\n" }));
    expect(r.output).toBe("a'b\n");
    expect(r.exit).toBe(0);
  });

  it("maps a wall-clock timeout to exit 124 + timedOut", async () => {
    const r = await sandbox().exec(req({ wrappedCode: "sleep 5\n", timeoutMs: 300 }));
    expect(r.timedOut).toBe(true);
    expect(r.exit).toBe(124);
  });

  it("is a drop-in for LocalSandbox: identical output/exit on the same block", async () => {
    // Stdout-only / exit / env scenarios that hold for BOTH the in-process
    // LocalSandbox and the container path. Mixed stdout+stderr interleave is
    // deliberately excluded: real `docker exec` demultiplexes the two streams,
    // so their merge order is non-deterministic (and real Headlong inherits it)
    // — see the parity report. Uses a real host workdir so LocalSandbox can cd.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-"));
    const scenarios = [
      "echo plain\n",
      "echo x; exit 3\n",
      'v=$TRAJ_ID; echo "$v"\n',
      "printf 'no-newline'\n",
    ];
    const local = new LocalSandbox();
    const docker = sandbox();
    for (const wrappedCode of scenarios) {
      const r = req({ workdir, env: { PATH: process.env["PATH"] ?? "", TRAJ_ID: "abc123" }, wrappedCode });
      const a = await local.exec(r);
      const b = await docker.exec(r);
      expect(b.output).toBe(a.output);
      expect(b.exit).toBe(a.exit);
      expect(b.timedOut).toBe(a.timedOut);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-daemon smoke test: skips cleanly with a reason when Docker is absent.
const DAEMON = DockerSandbox.isDaemonAvailable();
describe("2e39a3f: oversized code and in-container cancellation (b9bc2a3, c0fc931, db1e8e1)", () => {
  const big = (bytes: number) => "echo START\n: '" + "x".repeat(bytes) + "'\necho END\n";

  it("a code block over the 128 KiB argv cap runs through docker (it rides stdin, not argv)", async () => {
    const docker = new DockerSandbox({ container: "fake", dockerPath: makeFakeDocker() });
    const r = await docker.exec(req({ wrappedCode: big(300_000) }));
    expect(r.exit).toBe(0);
    expect(r.output).toBe("START\nEND\n");
  });

  it("a code block over 64 KiB runs from a script file in the supervisor's control dir, then the dir is gone", async () => {
    const docker = new DockerSandbox({ container: "fake", dockerPath: makeFakeDocker() });
    const r = await docker.exec(req({ wrappedCode: big(70_000) + "ls /tmp/shellm-exec.*/shellm-code.* | wc -l | tr -d ' '\n" }));
    expect(r.exit).toBe(0);
    expect(r.output).toBe("START\nEND\n1\n");
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("shellm-exec."))).toEqual([]);
  });

  it("the local sandbox also runs a code block over 128 KiB (script file, mode 600, removed after)", async () => {
    const r = await new LocalSandbox().exec(req({ workdir: os.tmpdir(), env: { PATH: process.env["PATH"] ?? "" }, wrappedCode: big(300_000) }));
    expect(r.exit).toBe(0);
    expect(r.output).toBe("START\nEND\n");
  });

  it("an idle kill cancels through the supervisor: the block's process is gone and the control dir removed", async () => {
    const docker = new DockerSandbox({ container: "fake", dockerPath: makeFakeDocker() });
    const mark = path.join(os.tmpdir(), `cancel-mark-${process.pid}-${Date.now()}`);
    const started = Date.now();
    const r = await docker.exec(
      req({ wrappedCode: `echo $$ > ${mark}\nsleep 30 &\nwait\n`, inactivityTimeoutMs: 400, timeoutMs: 5000 }),
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(mark, "utf8").trim());
    fs.rmSync(mark, { force: true });
    await new Promise((res) => setTimeout(res, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("shellm-exec."))).toEqual([]);
  });
});

describe.skipIf(!DAEMON)("DockerSandbox.exec — REAL docker daemon", () => {
  const IMAGE = "ubuntu:latest";
  let container = "";

  function ensureImage(): boolean {
    if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) return true;
    return spawnSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: 300_000 }).status === 0;
  }

  it("runs the model block inside a real container with matching semantics", async () => {
    if (!ensureImage()) return; // image unpullable offline → nothing to assert
    // Per-identity persistent container, created like bin/shellm:1017 (sleep infinity).
    const run = spawnSync(
      "docker",
      ["run", "-d", "--rm", IMAGE, "sleep", "infinity"],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    container = run.stdout.trim();
    try {
      const sb = new DockerSandbox({ container });
      // Stdout-only: exact match for cwd (-w), forwarded env (-e), exit code.
      const r = await sb.exec(
        req({ workdir: "/tmp", env: { PATH: "/ignored", MARK: "real-42" }, wrappedCode: 'echo "cwd=$(pwd) mark=$MARK"; exit 5\n' }),
      );
      expect(r.output).toBe("cwd=/tmp mark=real-42\n");
      expect(r.exit).toBe(5);
      expect(r.timedOut).toBe(false);

      // Mixed streams: both land in `output` (2>&1), but cross-stream ORDER is
      // non-deterministic under docker's stream demux — assert content as a set,
      // not a sequence. This is the faithful production behavior.
      const m = await sb.exec(req({ workdir: "/tmp", env: { PATH: "/ignored" }, wrappedCode: "echo O; echo E >&2\n" }));
      expect(m.output.split("\n").filter(Boolean).sort()).toEqual(["E", "O"]);
      expect(m.exit).toBe(0);

      // 2e39a3f (c0fc931, b9bc2a3): a code block over 128 KiB runs (stdin, not argv)...
      const bigCode = "echo START\n: '" + "x".repeat(300_000) + "'\necho END\n";
      const b = await sb.exec(req({ workdir: "/tmp", env: { PATH: "/ignored" }, wrappedCode: bigCode }));
      expect(b.output).toBe("START\nEND\n");
      expect(b.exit).toBe(0);

      // ...and a watchdog kill cancels INSIDE the container: the descendant is
      // gone, not left running behind a disconnected client, and the control
      // directory is removed.
      const k = await sb.exec(
        req({
          workdir: "/tmp",
          env: { PATH: "/ignored" },
          wrappedCode: "sleep 300 &\necho $! > /tmp/cancel-pid\nwait\n",
          inactivityTimeoutMs: 800,
          timeoutMs: 20_000,
        }),
      );
      expect(k.timedOut).toBe(true);
      // (a killed orphan under `sleep infinity` as PID 1 stays a zombie; zombie = gone)
      const probe = spawnSync(
        "docker",
        ["exec", container, "bash", "-c", 'pid=$(cat /tmp/cancel-pid); if [ -r /proc/$pid/stat ] && ! grep -q "^[0-9]* ([^)]*) Z" /proc/$pid/stat; then echo alive; else echo gone; fi; ls -d /tmp/shellm-exec.* 2>/dev/null | wc -l'],
        { encoding: "utf8" },
      );
      expect(probe.stdout.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual(["gone", "0"]);
    } finally {
      if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    }
  });
});

// ---------------------------------------------------------------------------
// PORT-BUG round trip: the real production path (selectSandbox → the runtime
// helper that builds a DockerSandbox with baseEnv defaulting to process.env,
// exactly as steprun.ts uses it). Before the fix, `docker exec` under this
// path failed with "failed to connect to the docker API at
// unix:///var/run/docker.sock" because req.env's HOME=<workdir> (set by
// src/shellm.ts for every step) got overlaid onto the HOST docker CLI's env,
// pointing it away from ~/.docker/config.json. This proves the fix end to end
// against a real daemon, not just the pure buildChildEnv/buildDockerExecArgs
// seams above.
describe.skipIf(!DAEMON)("selectSandbox — REAL docker round trip (PORT-BUG)", () => {
  it("execs through the real docker CLI while the container still sees HOME=<workdir>", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-home-rt-"));
    const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-home-identity-"));
    const result = selectSandbox({
      identityName: "port-bug-check",
      identityDir,
      workdir,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
      tempDocker: true, // one-off test container, not the identity's persistent env
    });
    try {
      const r = await result.sandbox.exec(
        req({ workdir, env: { PATH: "/ignored", HOME: workdir }, wrappedCode: "echo ok; echo $HOME\n" }),
      );
      expect(r.exit).toBe(0);
      expect(r.output).toContain("ok");
      expect(r.output).toContain(workdir);
    } finally {
      result.cleanup();
    }
  }, 120_000);
});
