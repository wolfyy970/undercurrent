// sandbox-docker.ts — the FAITHFUL production exec path: run the model's bash
// inside a per-identity Docker container, behind the same `Sandbox` interface
// LocalSandbox implements (src/sandbox.ts).
//
// LocalSandbox (restricted subprocess) stays the daemon-free default for tests.
// DockerSandbox reproduces what real Headlong does in `execute_code`'s docker
// branch (bin/shellm:1304-1330). That branch is the authoritative shape — NOT
// bin/shellm-docker, which is the in-container `docker` broker FACADE the model
// uses to reach a host-side broker, a different concern from execing the block.
//
// The reference (bin/shellm:1309-1330), verbatim in spirit:
//
//     local -a docker_env_flags=() exports=()
//     for ev in "${env_vars[@]}"; do
//         if [[ "$ev" == PATH=* ]]; then continue; fi     # host PATH is dropped
//         exports+=("$ev")                                # value → subshell env
//         docker_env_flags+=(-e "${ev%%=*}")              # bare -e NAME (no value)
//     done
//     docker_env_flags+=(-e "PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin")
//     docker_env_flags+=(-e "HOME=$workspace")
//     (
//         if [[ ${#exports[@]} -gt 0 ]]; then export "${exports[@]}"; fi
//         exec docker exec "${docker_env_flags[@]}" -w "$workspace" \
//             "$_SHELLM_CONTAINER" bash -e -c "$wrapped_code"
//     ) </dev/null 2>&1
//
// Faithful points reproduced here:
//   • per-identity persistent container ($_SHELLM_CONTAINER) — held by ctor.
//   • `docker exec -w <workdir>` sets the container-side cwd (no host cd).
//   • env passing that keeps secrets OFF the command line: every non-PATH var
//     rides as a bare `-e NAME` flag while its VALUE lives only in the child
//     process environment, exactly as the subshell `export`s them. (`ps` /
//     /proc/*/cmdline never see the values — bin/shellm:1296-1303.)
//   • host PATH dropped; container PATH + HOME=<workdir> set explicitly.
//   • `bash -e -c <wrapped_code>` — the block already carries its `set -x`
//     wrapper from the shellm layer (src/shellm.ts buildWrappedCode); we DO
//     NOT wrap again (no double `set -x`).
//   • stdin </dev/null and `2>&1` so stderr merges into stdout in true stream
//     order — we get that merge by execing docker through a `bash -c` whose
//     redirect mirrors the reference subshell, so `output` interleaves exactly
//     like LocalSandbox's `exec 2>&1` trick and the golden shell-output.
//
// INACTIVITY WATCHDOG (bug #33): this used to collapse upstream's two-timer
// watchdog (SHELLM_INACTIVITY_TIMEOUT idle / SHELLM_INACTIVITY_MAX quiet,
// bin/shellm:2618-2690) into a single flat `spawnSync({timeout})` wall clock
// — killing an actively-producing command exactly as readily as a genuinely
// silent one. `exec()` now shares `execWithInactivityWatchdog` (src/
// sandbox.ts) with LocalSandbox: a real `spawn()`, not `spawnSync`, so the
// same idle/max-ceiling algorithm applies here too. This is faithful to WHERE
// upstream's watchdog actually runs: `execute_code … >>output_file 2>&1 &`
// backgrounds the job (local bash OR `docker exec`, same code path) and a
// SIBLING watchdog subshell polls the host-side `output_file` — the poll
// always happens on the HOST, never inside the container, even for the
// docker branch. So spawning `bash -c "exec docker exec …"` here and handing
// it to the same host-side watchdog as LocalSandbox is the correct shape, not
// a simplification.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  execWithInactivityWatchdog,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_QUIET_MS,
  type ExecRequest,
  type ExecResult,
  type Sandbox,
} from "./sandbox.ts";

/** Container PATH the reference sets when it drops the host PATH (bin/shellm:1319). */
export const DOCKER_CONTAINER_PATH =
  "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin";

export interface DockerSandboxOptions {
  /** The per-identity persistent container id/name ($_SHELLM_CONTAINER). */
  container: string;
  /** `docker` executable; default resolves via PATH. */
  dockerPath?: string;
  /** Container-side PATH override; default DOCKER_CONTAINER_PATH. */
  containerPath?: string;
  /** Ceiling in ms when a request omits timeoutMs (SHELLM_INACTIVITY_MAX = 900s). */
  defaultTimeoutMs?: number;
  /** Idle ceiling in ms when a request omits inactivityTimeoutMs (SHELLM_INACTIVITY_TIMEOUT = 30s). */
  defaultIdleTimeoutMs?: number;
  /** Signal used for the watchdog's first kill attempt; default SIGTERM. */
  killSignal?: NodeJS.Signals;
  /** Base env for the host `docker` process (must let it find the binary); default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Combined stdout+stderr cap; default 64 MiB (matches LocalSandbox). */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/** Placeholder control directory for the pure argv builder; exec() uses a fresh one per call. */
const DEFAULT_CONTROL_DIR = "/tmp/shellm-exec.control";

/**
 * In-container execution supervisor (bin/shellm `_kill_exec_tree` and
 * `_supervise_exec`, c0fc931 + b9bc2a3, sync 2e39a3f). The text is the upstream
 * Bash, run by the CONTAINER's bash: `docker exec` of a bare `bash -e -c code`
 * left the model's process tree running in the container when a watchdog killed
 * the docker client, and the client's argv carried the whole code block (a
 * 128 KiB argv string cap on Linux). Now the code rides stdin, the supervisor
 * publishes its PID in a control directory, and a kill cancels INSIDE the
 * container (STOP, then KILL, every descendant, including commands run through
 * sudo).
 */
export const KILL_EXEC_TREE_SH = `_kill_exec_tree() {
    local pid="$1" children="" child task
    kill -STOP "$pid" 2>/dev/null || return 0
    if [[ -d "/proc/$pid/task" ]]; then
        for task in /proc/"$pid"/task/*/children; do
            children=""
            read -r children < "$task" 2>/dev/null || true
            for child in $children; do _kill_exec_tree "$child"; done
        done
    else
        children=$(ps -axo pid=,ppid= | awk -v parent="$pid" '$2 == parent {print $1}')
        for child in $children; do _kill_exec_tree "$child"; done
    fi
    kill -KILL "$pid" 2>/dev/null || true
}`;

export const SUPERVISE_EXEC_SH = `_supervise_exec() {
    local code="$1" control_dir="\${2:-}" child="" rc=0 code_file=""
    _terminate_exec() {
        trap '' TERM INT HUP
        if [[ -n "$child" ]]; then
            _kill_exec_tree "$child"
            wait "$child" 2>/dev/null || true
        fi
        [[ -z "$code_file" ]] || rm -f "$code_file"
        exit 143
    }
    trap _terminate_exec TERM INT HUP
    if [[ -n "$control_dir" ]]; then
        mkdir -m 700 "$control_dir" || return 1
        printf '%s\\n' "$$" > "$control_dir/pid"
    fi
    local code_bytes
    code_bytes=$(printf '%s' "$code" | wc -c)
    if [[ "$code_bytes" -gt 65536 ]]; then
        code_file=$(mktemp "\${control_dir:-\${TMPDIR:-/tmp}}/shellm-code.XXXXXX") || return 1
        printf '%s' "$code" > "$code_file"
        bash -e "$code_file" </dev/null &
    else
        bash -e -c "$code" </dev/null &
    fi
    child=$!
    wait "$child" || rc=$?
    [[ -z "$code_file" ]] || rm -f "$code_file"
    trap - TERM INT HUP
    return "$rc"
}`;

/**
 * PORT-NOTE (sync 2e39a3f; upstream c0fc931, b9bc2a3, db1e8e1, bin/shellm
 * execute_code/_supervise_exec): the model's code no longer rides `docker exec`
 * argv (Linux caps one argv string at 128 KiB). It goes over `docker exec -i`
 * stdin to this in-container supervisor, which runs it inline (<=64 KiB) or from
 * a mode-600 script in the control dir, and cancels its process tree on request.
 * Deviation: upstream's host subshell lets the docker client exit on its own
 * after the in-container cancel; the port ALSO signals the client afterwards
 * (watchdog killSignal) so a wedged client cannot hold the step open.
 */
/** The remote command: `$(cat)` is the code from stdin, `$1` the control directory. */
export const REMOTE_SUPERVISE_SCRIPT = `${KILL_EXEC_TREE_SH}\n${SUPERVISE_EXEC_SH}\n_supervise_exec "$(cat)" "$1"`;

/** The cancel command run as container root: find the supervisor's PID, kill its tree. */
export const REMOTE_CANCEL_SCRIPT = `${KILL_EXEC_TREE_SH}
for ((i=0; i<100; i++)); do
    if [[ -s "$1/pid" ]]; then
        read -r pid < "$1/pid"
        [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || exit 1
        _kill_exec_tree "$pid"
        exit 0
    fi
    sleep 0.1
done
exit 1`;

/**
 * Docker-backed sandbox. Same `Sandbox` interface as LocalSandbox; swap one for
 * the other at the call site with no other change.
 */
export class DockerSandbox implements Sandbox {
  private readonly container: string;
  private readonly dockerPath: string;
  private readonly containerPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultIdleTimeoutMs: number;
  private readonly killSignal: NodeJS.Signals;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly maxBuffer: number;

  constructor(opts: DockerSandboxOptions) {
    if (!opts.container) throw new Error("DockerSandbox: `container` is required");
    this.container = opts.container;
    this.dockerPath = opts.dockerPath ?? "docker";
    this.containerPath = opts.containerPath ?? DOCKER_CONTAINER_PATH;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_MAX_QUIET_MS;
    this.defaultIdleTimeoutMs = opts.defaultIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.killSignal = opts.killSignal ?? "SIGTERM";
    this.baseEnv = opts.baseEnv ?? process.env;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  /**
   * The `docker exec …` argv (starting at "exec"), built exactly as the
   * reference does. Pure — no spawn — so unit tests pin the shape without a
   * daemon. The env VALUES are intentionally absent (they travel in the child
   * environment, see buildChildEnv); only bare `-e NAME` flags appear here.
   */
  buildDockerExecArgs(req: ExecRequest, controlDir: string = DEFAULT_CONTROL_DIR): string[] {
    // `-i`: the code block is sent over stdin (see buildStdin), not argv.
    const args: string[] = ["exec", "-i"];
    // Non-PATH/HOME vars → bare `-e NAME`; PATH and HOME from the caller are
    // dropped, the container gets its own explicit values below. PORT-NOTE
    // (PORT-BUG fix, cites bin/shellm:1309-1328): req.env always carries
    // HOME=<workdir> (src/shellm.ts) alongside PATH — without this skip the
    // loop would ALSO emit a bare `-e HOME` here, duplicating the explicit
    // `-e HOME=<workdir>` pushed below. Order preserved from the env record.
    for (const key of Object.keys(req.env)) {
      if (key === "PATH" || key === "HOME") continue;
      args.push("-e", key);
    }
    args.push("-e", `PATH=${this.containerPath}`);
    args.push("-e", `HOME=${req.workdir}`);
    args.push("-w", req.workdir);
    args.push(this.container);
    args.push("bash", "-c", REMOTE_SUPERVISE_SCRIPT, "_", controlDir);
    return args;
  }

  /** What goes to `docker exec -i`'s stdin: the wrapped code (`<<< "$wrapped_code"`). */
  buildStdin(req: ExecRequest): string {
    return req.wrappedCode + "\n";
  }

  /**
   * Environment for the host `docker` process: the base env (so the docker
   * binary resolves) overlaid with the forwarded VALUES for every non-PATH/
   * non-HOME var, mirroring the reference's `export "${exports[@]}"` in the
   * exec subshell. docker then fills each bare `-e NAME` from this
   * environment. PORT-NOTE (PORT-BUG fix, cites bin/shellm:1309-1328): HOME
   * is host-critical exactly like PATH — req.env's HOME=<workdir> (set by
   * src/shellm.ts for every step) must NEVER overlay the HOST docker CLI's
   * own HOME. Overlaying it broke `~/.docker/config.json` lookup (wrong
   * HOME → docker falls back to the default socket and every `docker exec`
   * fails), even though container creation still worked. The container gets
   * its HOME=<workdir> explicitly via buildDockerExecArgs instead.
   */
  buildChildEnv(req: ExecRequest): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseEnv)) {
      if (v !== undefined) env[k] = v;
    }
    for (const [k, v] of Object.entries(req.env)) {
      if (k === "PATH" || k === "HOME") continue; // host-critical; container gets its own
      env[k] = v;
    }
    return env;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const inactivityTimeoutMs = req.inactivityTimeoutMs ?? this.defaultIdleTimeoutMs;
    // /tmp/shellm-exec.<random>: created by the in-container supervisor (mkdir
    // -m 700), removed by the host afterwards, including any large script in it.
    const controlDir = `/tmp/shellm-exec.${randomBytes(4).toString("hex")}`;
    const argv = this.buildDockerExecArgs(req, controlDir);
    const childEnv = this.buildChildEnv(req);
    const docker = (args: string[], timeout: number): void => {
      spawnSync(this.dockerPath, args, { stdio: "ignore", env: childEnv, timeout });
    };

    // Reproduce the reference subshell's `exec docker exec … </dev/null 2>&1`.
    // Running docker THROUGH `bash -c` with the redirect (rather than spawning
    // docker directly) is what merges the container's stderr into its stdout in
    // true emission order — the same interleave LocalSandbox gets from
    // `exec 2>&1`, and the order the golden shell-output preserves. `exec`
    // replaces bash with docker so the watchdog's exit mapping is docker's own.
    const inner =
      "exec " + [this.dockerPath, ...argv].map(shq).join(" ") + " 2>&1";

    return execWithInactivityWatchdog({
      command: "bash",
      args: ["-c", inner],
      env: childEnv,
      idleTimeoutMs: inactivityTimeoutMs,
      maxQuietMs: timeoutMs,
      ...(req.maxOutputBytes !== undefined ? { maxOutputBytes: req.maxOutputBytes } : {}),
      ...(req.maxExecMs !== undefined ? { maxExecMs: req.maxExecMs } : {}),
      ...(req.activityFile !== undefined ? { activityFile: req.activityFile } : {}),
      killSignal: this.killSignal,
      maxBuffer: this.maxBuffer,
      stdinText: this.buildStdin(req),
      // A watchdog kill cancels inside the container first (as root, so sudo'd
      // descendants die too); the host signal to the docker client follows.
      onKill: () => docker(["exec", "--user", "0:0", this.container, "bash", "-c", REMOTE_CANCEL_SCRIPT, "_", controlDir], 15_000),
      onClose: () => docker(["exec", this.container, "rm", "-rf", controlDir], 15_000),
    });
  }

  /** True if a docker daemon answers `docker info`. For skip-with-reason / call-site gating. */
  static isDaemonAvailable(dockerPath = "docker"): boolean {
    try {
      const r = spawnSync(dockerPath, ["info"], { stdio: "ignore", timeout: 30_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /** True if the named container exists and is running (docker inspect .State.Running). */
  static isContainerRunning(container: string, dockerPath = "docker"): boolean {
    try {
      const r = spawnSync(
        dockerPath,
        ["inspect", "-f", "{{.State.Running}}", container],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
      );
      return r.status === 0 && (r.stdout ?? "").trim() === "true";
    } catch {
      return false;
    }
  }
}

/**
 * Map a spawnSync result to the ExecResult contract. Pure — the unit-test seam
 * for timeout detection and exit-code mapping, no daemon needed. Mirrors
 * LocalSandbox's mapping (timeout → SIGTERM → exit 124; stdout+stderr merged),
 * but THROWS on a genuine spawn/infra failure (e.g. docker binary missing,
 * ENOBUFS) instead of silently returning a bogus empty exit-1 result: the real
 * shellm gates on `should_use_docker` (docker info) before ever taking this
 * path, so reaching a broken spawn here is an infrastructure error, not a
 * command result the model should be shown.
 *
 * PORT-NOTE (bug #33): no longer called by `DockerSandbox.exec` (which now
 * runs through `execWithInactivityWatchdog`'s real `spawn`), but kept —
 * exported and directly unit-tested — as the exit-code/timeout mapping this
 * file used before the watchdog rewrite; harmless dead code in production.
 */
export function mapSpawnResult(res: SpawnSyncReturns<string>): ExecResult {
  const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut =
    res.error !== undefined && (res.signal === "SIGTERM" || errCode === "ETIMEDOUT");

  if (res.error !== undefined && !timedOut) {
    // Genuine spawn failure (docker/bash not found, buffer overflow, …).
    throw res.error;
  }

  const output = (res.stdout ?? "") + (res.stderr ?? "");
  // timedOut wins: on a wall-clock kill the `docker` CLI catches SIGTERM and
  // exits 0, so res.status is a number (0) here — unlike LocalSandbox, whose
  // bash is killed by the signal (status null). Both must map to 124, matching
  // LocalSandbox's timeout contract. Otherwise pass the child exit straight
  // through (docker exec returns the container command's own exit code).
  const exit = timedOut ? 124 : typeof res.status === "number" ? res.status : 1;
  return { output, exit, timedOut };
}

/** POSIX single-quote for safe embedding in the `bash -c` string. */
function shq(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
