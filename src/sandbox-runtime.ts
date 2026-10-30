// sandbox-runtime.ts — selectSandbox: pick Docker vs Local for one wake, and
// the env forwarded into it (PLAN-daemon §7, DIRECTOR CORRECTIONS 4 & 5).
//
// `auto` (the daemon's default) picks Docker when a daemon answers `docker
// info`, else falls back to Local — mirroring bin/shellm's `should_use_docker`
// gate, minus the upstream shell-broker indirection (bin/shellm-docker): we
// talk to `docker` directly.
//
// Container lifecycle (bug #32): a PERSISTENT container per identity/env
// name, reused across wakes when running and image-matching, created only on
// the first wake or after a stored container goes stale — matching
// thinkers/_lib/common.sh:372's `--env "${SHELLM_THINKER_ENV:-$IDENTITY_NAME}"`
// on every wake and bin/shellm's env_resolve/env_register/env_metadata_matches
// (see sandbox-env.ts for the ported subset and what's N/A). Torn down only
// via the `tempDocker`/SHELLM_TEMP_DOCKER opt-in (bin/shellm:2362-2364's
// `--temp-docker`) or an external sweep (headlong-killall, a future
// `identity delete` — see sandbox-env.ts `destroyIdentityContainers`).
//
// PORT-NOTE: upstream mounts SHELLM_WORKDIRS_DIR and IDENTITY_DIR as two
// separate binds because a workdir can, in principle, live outside the
// identity tree. In this port every step's workdir is always created under
// <identityDir>/.shellm/workdirs (src/identity-env.ts), so one rw bind of
// identityDir covers both — documented in PARITY.md. It also means a REUSED
// container already has every later step's workdir visible without a new
// mount: a bind mount of a directory stays live for files created under it
// after the mount, exactly like upstream's own "Mount the runs dir ... so
// containers can be reused across runs without needing new bind mounts"
// (bin/shellm:942-944).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalSandbox, type Sandbox } from "./sandbox.ts";
import { DockerSandbox, DOCKER_CONTAINER_PATH } from "./sandbox-docker.ts";
import { urlIsLoopback, urlHostSwap } from "./net-url.ts";
import {
  envDirFor,
  readEnvMetadata,
  writeEnvMetadata,
  removeEnvMetadata,
  envMetadataMatches,
  envMetadataMismatchMessage,
  varMountsMatch,
  varMountsMismatchMessage,
  containerNameFor,
  containerHasUnusableToolMounts,
  staleToolMountsMessage,
  containerCanReachPath,
  workdirNotMountedMessage,
} from "./sandbox-env.ts";
import { computeVarMounts, pathCovered } from "./skill-env.ts";
import type { EnvSpec } from "./types.ts";

/**
 * Behavioral parity (IDENTITY_DIR): the variables the dispatcher EXPORTS to every thinker step
 * (bin/thinkers:387-389: IDENTITY_DIR IDENTITY_NAME MEM_DIR SKILLS_DIR SKILLS_KERNEL_DIR TRAJ_DIR TRAJ_ID THINKERS_DIR
 * SHELLM_HOME THINK_MODEL THINK_CONTEXT_TAIL THINKERS_MAX_CONCURRENT NO_SELF_TRIGGER). Upstream's LOCAL wake runs the
 * model's code with `bash -e -c` inside shellm (bin/shellm:1629) and so inherits all of them; a real run saw
 * `$IDENTITY_DIR` empty 82 times because this port's exec env is a whitelist. Docker is different upstream too: the
 * container only gets the `--var` list (bin/shellm:1651-1664), so this is applied to LOCAL sandboxes only.
 * A name that is unset stays unset (bash only exports what is set).
 */
export const DISPATCHER_EXPORTED_ENV_KEYS = [
  "IDENTITY_DIR",
  "IDENTITY_NAME",
  "MEM_DIR",
  "SKILLS_DIR",
  "SKILLS_KERNEL_DIR",
  "TRAJ_DIR",
  "TRAJ_ID",
  "THINKERS_DIR",
  "SHELLM_HOME",
  "THINK_MODEL",
  "THINK_CONTEXT_TAIL",
  "THINKERS_MAX_CONCURRENT",
  "NO_SELF_TRIGGER",
] as const;

/** Adds the dispatcher-exported variables that `from` has and `execEnv` lacks (existing exec-env values win). */
export function applyLocalInheritedEnv(execEnv: Record<string, string> | undefined, from: NodeJS.ProcessEnv, sandboxType: string): void {
  if (!execEnv || sandboxType !== "local") return;
  for (const k of DISPATCHER_EXPORTED_ENV_KEYS) {
    const v = from[k];
    if (v !== undefined && !(k in execEnv)) execEnv[k] = v;
  }
}

/**
 * Env vars upstream forwards into a step's exec environment (bin/shellm:2393-
 * 2409, thinkers/_lib/common.sh:352-356) — DIRECTOR CORRECTION 4. Without
 * these a mid-wake `llm`/`mem search` dies "OPENROUTER_API_KEY is not set".
 * Values travel via env only — never argv, never logged.
 */
export const FORWARDED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "OPENCODE_API_KEY",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "SHELLM_MODEL",
  "SHELLM_API_URL",
  "LLM_API_URL",
] as const;

export function forwardedEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = from[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/**
 * PORT-NOTE (bug #70, bin/shellm:216-221 `_shellm_container_api_url`,
 * bin/shellm:2659-2662,2679-2680,2712): a loopback SHELLM_API_URL/LLM_API_URL
 * names THIS HOST, not the sandbox — code running in a Docker container needs
 * `host.docker.internal` for the same server. Upstream computes this once
 * from the canonical `SHELLM_API_URL` and assigns the SAME rewritten value to
 * both env-var names; this port has no wired equivalent of upstream's
 * process-vs-file endpoint-alias canonicalization (`resolveShellmApiUrl` in
 * src/shellm.ts remains unwired — see PARITY.md "callout (c)"), so
 * SHELLM_API_URL and LLM_API_URL are rewritten INDEPENDENTLY here, each only
 * if it is itself loopback. When both already agree (the common case) the
 * result is identical to upstream; a caller that deliberately sets them to
 * two different loopback hosts gets each translated on its own terms rather
 * than collapsed onto one.  A non-loopback URL (a real remote endpoint)
 * passes through unchanged, and only the copy built for a DOCKER exec is
 * rewritten — a host-side llm call (buildLlmClient) keeps the original URL
 * from `env` untouched, matching "the main shellm process keeps the host
 * URL" (bin/shellm:2657-2658).
 */
export function containerApiUrl(url: string): string {
  return urlIsLoopback(url) ? urlHostSwap(url, "host.docker.internal") : url;
}

/**
 * bug #70: rewrite ONLY the endpoint-alias keys of a step's exec env, and
 * ONLY when `envType` says this step is running in Docker — a single
 * call-site hunk for steprun.ts's `runStep` (buildLlmClient, called
 * separately on the host-side `env`, is unaffected and keeps the original
 * loopback URL). No-op (including when `execEnv` is undefined) for a local
 * step, matching upstream's "the main shellm process keeps the host URL"
 * (bin/shellm:2657-2658). Mutates `execEnv` in place and returns it.
 */
export function applyDockerApiUrlRewrite(
  execEnv: Record<string, string> | undefined,
  envType: "docker" | "local"
): Record<string, string> | undefined {
  if (!execEnv || envType !== "docker") return execEnv;
  for (const k of ["SHELLM_API_URL", "LLM_API_URL"] as const) {
    const v = execEnv[k];
    if (v) execEnv[k] = containerApiUrl(v);
  }
  return execEnv;
}

/** Does EITHER endpoint-alias env var, as forwarded to a step, name this
 *  host's loopback interface? The predicate a fresh Docker container's
 *  `--add-host host.docker.internal:host-gateway` flag shares with
 *  `containerApiUrl` above (bin/shellm:1026-1034's own comment: "the SAME
 *  predicate ... uses, so the two can never disagree"). */
function needsHostGateway(env: NodeJS.ProcessEnv): boolean {
  return urlIsLoopback(env["SHELLM_API_URL"] ?? "") || urlIsLoopback(env["LLM_API_URL"] ?? "");
}

export type SandboxMode = "auto" | "docker" | "local";

export interface SelectSandboxOptions {
  identityName: string;
  identityDir: string;
  workdir: string;
  /** The step's tool-shim dir (headlong-ts's bin/) — goes on the CONTAINER PATH. */
  binDir: string;
  /** The headlong-ts checkout root (mounted read-only so binDir's shims resolve
   *  their ../src/*.ts imports and Node itself is reachable at the same path). */
  portHome: string;
  mode?: SandboxMode;
  /** Unused by Docker container naming (kept for callers that still pass it;
   *  the container is now named from the env, not a per-invocation pid — see
   *  sandbox-env.ts `containerNameFor`). */
  stepPid?: number;
  dockerImage?: string; // default env SHELLM_DOCKER_IMAGE, else DEFAULT_DOCKER_IMAGE
  dockerPath?: string; // default "docker"
  /** Knob source (SHELLM_SANDBOX, SHELLM_DOCKER_IMAGE, SHELLM_ALLOW_NESTED_DOCKER,
   *  SHELLM_TEMP_DOCKER) and the forwarded-key source; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** The env name (SHELLM_ENVS_DIR/<name>, thinkers/_lib/common.sh:372's
   *  `--env`); default opts.identityName, matching the upstream default
   *  `${SHELLM_THINKER_ENV:-$IDENTITY_NAME}`. */
  envName?: string;
  /** --temp-docker equivalent (bin/shellm:2362-2364): tear the container down
   *  in cleanup() even though it would otherwise persist for reuse. Default
   *  false — matches upstream's default of persisting. Also settable via the
   *  SHELLM_TEMP_DOCKER=1 env knob. */
  tempDocker?: boolean;
  /** bug #35: skill-declared `--var NAME=VALUE` entries (src/steprun.ts's
   *  `buildIdentityConfig` -> IdentityConfig.skillVarMounts) whose directory-
   *  valued ones get bind-mounted rw at the same absolute path in a FRESH
   *  container, and are tracked in env metadata (`var_mounts`) for reattach
   *  validation — matching `_compute_var_mounts`/`env_metadata_matches`'s
   *  var_mounts branch (bin/shellm:739-747,793-801). */
  varMounts?: Array<{ name: string; value: string }>;
}

export interface SelectSandboxResult {
  sandbox: Sandbox;
  env: EnvSpec;
  /** Tear down any container this call started (idempotent, safe to call from
   *  a SIGTERM handler or a `finally`). No-op for LocalSandbox. */
  cleanup: () => void;
}

// The shims are Node — the image must contain Node >=22.18 + bash (§7).
const DEFAULT_DOCKER_IMAGE = "node:24-bookworm";

function insideDockerContainer(): boolean {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/** `selectSandbox` — one call per step wake; daemon-free steprun.ts uses this
 *  instead of hardcoding LocalSandbox. */
export function selectSandbox(opts: SelectSandboxOptions): SelectSandboxResult {
  const env = opts.env ?? process.env;
  const mode: SandboxMode = opts.mode ?? (env["SHELLM_SANDBOX"] as SandboxMode | undefined) ?? "auto";
  const dockerPath = opts.dockerPath ?? "docker";
  const allowNested = env["SHELLM_ALLOW_NESTED_DOCKER"] === "1";

  if (mode === "local") {
    return { sandbox: new LocalSandbox(), env: { name: opts.identityName, type: "local" }, cleanup: () => {} };
  }

  const nestedOk = allowNested || !insideDockerContainer();
  const daemonUp = nestedOk && DockerSandbox.isDaemonAvailable(dockerPath);
  if (mode === "docker" || (mode === "auto" && daemonUp)) {
    if (!daemonUp) {
      throw new Error("selectSandbox: mode=docker but no docker daemon is available");
    }
    return startDockerSandbox(opts, dockerPath);
  }

  return { sandbox: new LocalSandbox(), env: { name: opts.identityName, type: "local" }, cleanup: () => {} };
}

function startDockerSandbox(opts: SelectSandboxOptions, dockerPath: string): SelectSandboxResult {
  const env = opts.env ?? process.env;
  const image = opts.dockerImage ?? env["SHELLM_DOCKER_IMAGE"] ?? DEFAULT_DOCKER_IMAGE;
  const tempDocker = opts.tempDocker ?? env["SHELLM_TEMP_DOCKER"] === "1";
  // thinkers/_lib/common.sh:372 — `--env "${SHELLM_THINKER_ENV:-$IDENTITY_NAME}"`.
  const envName = opts.envName ?? opts.identityName;
  const envsDir = env["SHELLM_ENVS_DIR"] || path.join(opts.identityDir, ".shellm", "envs");
  const envDir = envDirFor(opts.identityDir, envName, envsDir);

  fs.mkdirSync(opts.workdir, { recursive: true });

  // bug #35: the var_mounts this run would compute (_compute_var_mounts),
  // scoped to skill-declared directory vars — see skill-env.ts/PARITY.md.
  const requestedVarMounts = computeVarMounts(opts.varMounts ?? []);

  // env_resolve (bin/shellm:1233-1270): a stored env whose image OR var_mounts
  // disagrees is a hard `die` here (thinker wakes always pass an explicit
  // --env-equivalent name — see the module header) — never a silent
  // skip-and-recreate. A stored env with no live container is stale
  // bookkeeping; drop it and fall through to create fresh, matching
  // env_resolve's own stale-cleanup branch.
  let containerId: string | undefined;
  let reused = false;
  let digest: string | undefined;

  const stored = readEnvMetadata(envDir);
  if (stored) {
    if (!envMetadataMatches(stored, image)) {
      throw new Error(envMetadataMismatchMessage(envName, stored.image, image, envsDir));
    }
    if (!varMountsMatch(stored.varMounts, requestedVarMounts)) {
      throw new Error(varMountsMismatchMessage(envName, envsDir));
    }
    // env_resolve's remaining pre-loop checks, in upstream's exact order
    // (bin/shellm:1320-1335; see sandbox-env.ts's "bug #55" header note) —
    // BEFORE the first model call, so a dead/unusable env never runs a step
    // against a container guaranteed to reject every block.
    if (containerHasUnusableToolMounts(stored.containerId, opts.binDir, dockerPath)) {
      throw new Error(staleToolMountsMessage(envName, envsDir));
    }
    if (!containerCanReachPath(stored.containerId, opts.workdir, dockerPath)) {
      throw new Error(workdirNotMountedMessage(envName, opts.workdir, envsDir));
    }
    if (DockerSandbox.isContainerRunning(stored.containerId, dockerPath)) {
      containerId = stored.containerId;
      digest = stored.imageDigest;
      reused = true;
    } else {
      // Exists, mounts fine, merely stopped (not removed) — upstream's own
      // SILENT stale path (docker_attach fails the running check, `docker rm
      // -f`s it, the caller transparently recreates under the same env name;
      // bin/shellm:1335-1339,2338). A fully-removed container never reaches
      // here: containerCanReachPath above already died for it.
      removeEnvMetadata(envDir);
    }
  }

  if (!reused) {
    // Pull only if not already present locally (bin/shellm:862-905).
    const inspect = spawnSync(dockerPath, ["image", "inspect", image], { stdio: "ignore" });
    if (inspect.status !== 0) {
      const pull = spawnSync(dockerPath, ["pull", image], { stdio: "ignore" });
      if (pull.status !== 0) throw new Error(`selectSandbox: failed to pull docker image ${image}`);
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
    const userArgs = uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : [];

    // bug #70 (bin/shellm:1026-1034): map host.docker.internal onto the
    // Docker host only when a loopback model URL will be translated for the
    // sandbox — same predicate containerApiUrl uses (needsHostGateway
    // above), so the alias and the rewrite can never disagree. Docker
    // Desktop already defines the name; --add-host keeps Linux (colima)
    // equivalent.
    const hostGatewayArgs = needsHostGateway(env) ? ["--add-host", "host.docker.internal:host-gateway"] : [];

    const container = containerNameFor(envName, envDir);
    // A crash between docker-run and env_register (or a leftover from an
    // interrupted test) can leave a same-named container behind with no
    // metadata pointing at it; docker refuses to reuse a name in that state.
    spawnSync(dockerPath, ["rm", "-f", container], { stdio: "ignore" });

    // bug #35: mount directories referenced by --var values (bin/shellm:1013-
    // 1024), read-write, skipping any already covered by the identityDir/
    // portHome mounts below (matching `_path_covered` against `seen_dirs`) —
    // and de-duped/nested-covered against each other in the SAME order
    // upstream's own loop accumulates `seen_dirs`.
    const coveredBy = [opts.identityDir, opts.portHome];
    const varMountArgs: string[] = [];
    for (const dir of requestedVarMounts) {
      if (coveredBy.some((root) => pathCovered(dir, root))) continue;
      varMountArgs.push("-v", `${dir}:${dir}`);
      coveredBy.push(dir);
    }

    const run = spawnSync(
      dockerPath,
      [
        "run",
        "-d",
        "--name",
        container,
        ...userArgs,
        ...hostGatewayArgs,
        "-v",
        `${opts.identityDir}:${opts.identityDir}`,
        "-v",
        `${opts.portHome}:${opts.portHome}:ro`,
        ...varMountArgs,
        "-w",
        opts.workdir,
        "-e",
        `HOME=${opts.workdir}`,
        image,
        "sleep",
        "infinity",
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
    );
    if (run.status !== 0) {
      throw new Error(`selectSandbox: docker run failed for ${container}: ${(run.stderr ?? "").trim()}`);
    }
    containerId = (run.stdout ?? "").trim() || container;

    const insp = spawnSync(dockerPath, ["image", "inspect", "-f", "{{index .RepoDigests 0}}", image], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (insp.status === 0) digest = (insp.stdout ?? "").trim() || undefined;

    writeEnvMetadata(envDir, {
      containerId,
      image,
      ...(digest ? { imageDigest: digest } : {}),
      varMounts: requestedVarMounts,
    });
  }

  const sandbox = new DockerSandbox({
    container: containerId!,
    dockerPath,
    containerPath: `${opts.binDir}:${DOCKER_CONTAINER_PATH}`,
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    // Default: persist for the next wake (bin/shellm:2362-2364's cleanup trap
    // only tears down `if [[ "${_cleanup_temp:-0}" -eq 1 ]]`). --temp-docker
    // (or SHELLM_TEMP_DOCKER=1) tears down unconditionally, whether this call
    // created or reused the container, matching upstream exactly.
    if (tempDocker) {
      spawnSync(dockerPath, ["rm", "-f", containerId!], { stdio: "ignore" });
      removeEnvMetadata(envDir);
    }
  };
  process.once("SIGTERM", cleanup);

  return {
    sandbox,
    env: {
      name: envName,
      type: "docker",
      docker_image: image,
      ...(digest ? { docker_image_digest: digest } : {}),
      docker_access: "none",
    },
    cleanup,
  };
}
