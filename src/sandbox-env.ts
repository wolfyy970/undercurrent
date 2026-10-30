// sandbox-env.ts — persistent per-identity Docker env lifecycle (bug #32).
//
// Upstream (`bin/shellm`) gives every wake of an identity a PERSISTENT named
// Docker container, reused across wakes for a warm filesystem and installed
// tools: `thinkers/_lib/common.sh:372` passes `--env "${SHELLM_THINKER_ENV:-
// $IDENTITY_NAME}"` on every wake, `env_resolve`/`env_find_running` (bin/
// shellm:1233-1339) reattach to any live container for that env name, and
// only `--temp-docker` (bin/shellm:2362-2364's cleanup trap), `identity
// delete` (`tools/identity:56-65` `_destroy_containers`), or
// `headlong-killall`'s blanket `name=^shellm-` sweep ever tear it down.
// `env_metadata_matches` (upstream commit 0925168) refuses to reattach when
// the stored image disagrees with the one requested, so a run asking for a
// different image never silently lands on the wrong one.
//
// This module is the faithful SUBSET this port's architecture needs. Fields
// `env_metadata_matches` also compares — `docker_broker_transport`/
// `docker_socket`/`privileged` (broker/socket/dind access modes; PARITY.md
// "docker_access ... MISSING") — have no port equivalent to disagree on. The
// Docker IMAGE identity (the 0925168 hazard) and, as of bug #35, `var_mounts`
// (the `--var` directory auto-mount set — SCOPED to skill-declared vars
// only, see skill-env.ts's file header and PARITY.md's "sandbox-env" row for
// why the built-in MEM_DIR/SKILLS_DIR/SKILLS_KERNEL_DIR/TRAJ_DIR paths are
// deliberately excluded from THIS port's var_mounts tracking) are both
// compared.
//
// Metadata lives at SHELLM_ENVS_DIR/<name> — `<identityDir>/.shellm/envs/
// <name>` (tools/identity:375,1381; identity-env.ts already resolves
// SHELLM_ENVS_DIR to this same path), one file per field, matching
// `env_register`'s on-disk shape (bin/shellm:1341-1369) so the layout reads
// the same under a human's `ls` on either side.
//
// PORT-NOTE (bug #55, bin/shellm:1300-1335): `env_metadata_matches` is only
// the FIRST of four upstream pre-loop liveness checks, run in this exact
// order by `env_resolve` (bin/shellm:1304-1339) once a `container_id` file
// exists — a director-verified 30-min chaos run (dispatcher SIGKILL of the
// sandbox + thinkers restart) found this port skipped the last three and
// reattached to a dead container, running the whole model loop with every
// block pre-rejected ("No such container: …") instead of dying up front:
//
//   1. env_metadata_matches (image/var_mounts identity — this file, above).
//   2. docker_container_has_unusable_tool_mounts (bin/shellm:722-731): for
//      each of `llm traj context`, if that path is a DISTINCT mount point
//      inside the container (`mount | grep -F ' on <dest> '`) but is no
//      longer executable there, the env is "stale or unusable" — checked
//      here as `containerHasUnusableToolMounts`, adapted to this port's
//      SINGLE read-only `portHome` bind (no per-tool mounts to enumerate):
//      a tool name from that same upstream list is "this run's tool
//      surface" only when it actually exists on the HOST at `binDir/<tool>`
//      (portHome's ro-bind mirrors the host 1:1, so host absence there means
//      upstream would never have mounted it either); `docker exec test -x`
//      on that path is the live check. Upstream's own `if docker exec …;
//      then` guards this on the exec SUCCEEDING — an unreachable (stopped or
//      removed) container makes the guard false, reporting no unusable
//      mount, not a stale one; ported here as an explicit "is it running"
//      gate first, since `docker exec` fails identically for both upstream
//      and this port either way.
//   3. docker_container_can_reach_path (bin/shellm:1291-1298): the container
//      must have a mount whose destination covers this run's workdir. For a
//      REMOVED container `docker inspect` itself fails, yielding zero
//      destinations — the SAME "not reachable" outcome as a live container
//      whose mounts genuinely don't cover this workdir. Upstream never
//      distinguishes the two cases (both die with the identical message,
//      bin/shellm:1327), so neither does `containerCanReachPath` below.
//   4. docker_attach (bin/shellm:1276-1287): only reached once 2 and 3 pass —
//      i.e. the container DOES exist and its mounts are fine, but it is
//      merely stopped, not removed. THIS is upstream's only SILENT
//      (non-`die`) stale path: `docker_attach` fails the `State.Status ==
//      "running"` test, upstream `docker rm -f`s it, and the caller (bin/
//      shellm:2338) transparently creates a fresh container under the SAME
//      env name — sandbox-runtime.ts's existing `isContainerRunning` +
//      `removeEnvMetadata` branch already matches this. A container gone
//      entirely (test (a) below) never reaches this branch: check 3 above
//      dies first, exactly as upstream's incidental `docker inspect`-fails
//      behavior does.
//
// Every wake passes an explicit env name (thinkers/_lib/common.sh:372's
// `--env "${SHELLM_THINKER_ENV:-$IDENTITY_NAME}"` — see sandbox-runtime.ts's
// header), so this port is always in upstream's `explicit=1` branch: checks
// 1-3 above always `die()`, never upstream's silent `explicit=0` skip.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathCovered } from "./skill-env.ts";

export interface EnvMetadata {
  containerId: string;
  image: string;
  imageDigest?: string;
  /** `_compute_var_mounts`'s stored `var_mounts` file (bin/shellm:1364-1365),
   *  one absolute directory path per line — SCOPED here to skill-declared
   *  `--var` directories only (bug #35; see this file's header). Always
   *  present (possibly `[]`), matching upstream's `env_register_local`'s
   *  `: > "$ws_dir/var_mounts"` (empty-but-present) for the local case and
   *  `_compute_var_mounts > "$ws_dir/var_mounts"` for the docker case. */
  varMounts: string[];
}

/** SHELLM_ENVS_DIR/<name> (tools/identity:375: `<identityDir>/.shellm/envs`). */
export function envDirFor(identityDir: string, envName: string, envsDir?: string): string {
  return path.join(envsDir ?? path.join(identityDir, ".shellm", "envs"), envName);
}

function readFileTrim(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** `_compute_var_mounts > file`'s read-back — one path per line, trailing
 *  blank lines dropped (matches the Bash comparison's `%%$'\n'` trim). */
function readVarMountsFile(p: string): string[] {
  const raw = readFileTrim(p);
  if (raw === undefined || raw === "") return [];
  return raw.split("\n");
}

/** docker_metadata_value(name, key)'s file-per-field read, for a docker env. */
export function readEnvMetadata(envDir: string): EnvMetadata | undefined {
  const containerId = readFileTrim(path.join(envDir, "container_id"));
  const type = readFileTrim(path.join(envDir, "type"));
  if (!containerId || type !== "docker") return undefined;
  const image = readFileTrim(path.join(envDir, "image")) ?? "";
  const imageDigest = readFileTrim(path.join(envDir, "image_digest"));
  const varMounts = readVarMountsFile(path.join(envDir, "var_mounts"));
  return { containerId, image, ...(imageDigest ? { imageDigest } : {}), varMounts };
}

/** env_register's docker branch (bin/shellm:1341-1369), the fields this port
 *  tracks (image identity — the 0925168 hazard — plus var_mounts, bug #35 —
 *  plus bookkeeping). */
export function writeEnvMetadata(
  envDir: string,
  meta: { containerId: string; image: string; imageDigest?: string; varMounts: string[] }
): void {
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, "container_id"), meta.containerId);
  fs.writeFileSync(path.join(envDir, "type"), "docker\n");
  fs.writeFileSync(path.join(envDir, "created"), `${new Date().toISOString()}\n`);
  fs.writeFileSync(path.join(envDir, "docker_access"), "none\n");
  fs.writeFileSync(path.join(envDir, "image"), `${meta.image}\n`);
  if (meta.imageDigest) fs.writeFileSync(path.join(envDir, "image_digest"), `${meta.imageDigest}\n`);
  // _compute_var_mounts > "$ws_dir/var_mounts" (bin/shellm:1364-1365) — one
  // path per line, an empty file when there are none (bare `printf` of a
  // zero-element list writes nothing, same as an empty write here).
  fs.writeFileSync(path.join(envDir, "var_mounts"), meta.varMounts.length ? meta.varMounts.join("\n") + "\n" : "");
}

/** env_destroy's metadata half (bin/shellm:1387-1399) — container removal is
 *  the caller's own `docker rm -f`, done alongside this, not inside it. */
export function removeEnvMetadata(envDir: string): void {
  fs.rmSync(envDir, { recursive: true, force: true });
}

/** env_metadata_matches's image-identity subset (upstream 0925168,
 *  bin/shellm:791-798): an env with no recorded image (predates image
 *  tracking) still matches anything — only a RECORDED disagreement refuses. */
export function envMetadataMatches(stored: EnvMetadata, requestedImage: string): boolean {
  return !stored.image || stored.image === requestedImage;
}

/** env_metadata_mismatch_message's image branch (bin/shellm:829-834), verbatim
 *  modulo SHELLM_ENVS_DIR's port-specific value. */
export function envMetadataMismatchMessage(
  envName: string,
  storedImage: string,
  requestedImage: string,
  envsDir: string
): string {
  return (
    `Env ${envName} was created from image ${storedImage}, but this run requested ${requestedImage}. ` +
    `Use --new-env, a different --env, or remove ${envsDir}/${envName} so shellm can recreate it from the requested image.`
  );
}

/**
 * `env_metadata_matches`'s var_mounts branch (bin/shellm:793-801, bug #35):
 * a stored env whose recorded `--var` directory set disagrees with what this
 * run would compute refuses reattach — same comparison upstream does
 * (both sides sorted, trailing-newline-trimmed before comparing).
 */
export function varMountsMatch(stored: string[], requested: string[]): boolean {
  return [...stored].sort().join("\n") === [...requested].sort().join("\n");
}

/** `env_metadata_mismatch_message`'s var_mounts branch (bin/shellm:836-844),
 *  verbatim modulo SHELLM_ENVS_DIR's port-specific value. */
export function varMountsMismatchMessage(envName: string, envsDir: string): string {
  return (
    `Env ${envName} has different --var directory mounts than this run requires. ` +
    `Use a different --env or remove ${envsDir}/${envName} so shellm can recreate it with the correct mounts.`
  );
}

/** The three tools upstream mounts individually (bin/shellm:724's `for tool
 *  in llm traj context`) — this port's equivalent files under `binDir`. */
const SHELLM_TOOL_NAMES = ["llm", "traj", "context"] as const;

/**
 * `docker_container_has_unusable_tool_mounts` (bin/shellm:722-731), adapted
 * to this port's single read-only `portHome` bind — see this file's header
 * "bug #55" note for the full derivation. A container that isn't currently
 * running can't be `docker exec`'d into at all (upstream's own guard is false
 * the same way for "stopped" and "gone"), so it reports no unusable mount
 * here — the caller's `containerCanReachPath` check is what actually explains
 * that failure.
 */
export function containerHasUnusableToolMounts(containerId: string, binDir: string, dockerPath = "docker"): boolean {
  const running = spawnSync(dockerPath, ["inspect", "-f", "{{.State.Running}}", containerId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (running.status !== 0 || running.stdout.trim() !== "true") return false;

  for (const tool of SHELLM_TOOL_NAMES) {
    const hostPath = path.join(binDir, tool);
    // portHome's ro-bind mirrors the host 1:1 — a tool name with nothing on
    // the host at this run's binDir was never part of this run's real tool
    // surface (matching upstream only ever checking tools it actually
    // mounted), so there is nothing to check for it.
    if (!fs.existsSync(hostPath)) continue;
    const r = spawnSync(dockerPath, ["exec", "-w", "/", containerId, "test", "-x", hostPath], { stdio: "ignore" });
    if (r.status !== 0) return true;
  }
  return false;
}

/** `env_metadata_mismatch_message`'s tool-mounts branch is upstream's own
 *  message (bin/shellm:1322), verbatim modulo SHELLM_ENVS_DIR's port value —
 *  it isn't produced by `env_metadata_mismatch_message` itself (that helper
 *  only covers the metadata-identity branches above); `env_resolve` inlines
 *  it directly at the `die` call site. */
export function staleToolMountsMessage(envName: string, envsDir: string): string {
  return (
    `Env ${envName} has stale or unusable shellm tool mounts. ` +
    `Use a different --env or remove ${envsDir}/${envName} so shellm can recreate it.`
  );
}

/**
 * `docker_container_can_reach_path` (bin/shellm:1291-1298): true when the
 * container has a mount whose destination covers `wantPath`. For a REMOVED
 * container `docker inspect` itself fails, yielding zero destinations — the
 * same "not reachable" result as a live container whose mounts genuinely
 * don't cover `wantPath`; upstream's `die` message doesn't distinguish the
 * two (bin/shellm:1327), so neither does this.
 */
export function containerCanReachPath(containerId: string, wantPath: string, dockerPath = "docker"): boolean {
  const r = spawnSync(
    dockerPath,
    ["inspect", "-f", '{{range .Mounts}}{{.Destination}}{{"\\n"}}{{end}}', containerId],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  if (r.status !== 0) return false;
  const destinations = (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return destinations.some((dest) => pathCovered(wantPath, dest));
}

/** `env_resolve`'s workdir-mount `die` message (bin/shellm:1327), verbatim
 *  modulo SHELLM_ENVS_DIR's port-specific value. */
export function workdirNotMountedMessage(envName: string, workdir: string, envsDir: string): string {
  return (
    `Env ${envName} was created without a mount for this run's workdir (${workdir}). ` +
    `Use --new-env, a different --env, or remove ${envsDir}/${envName} so shellm can recreate it.`
  );
}

/**
 * Docker container `--name`: must be `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. Upstream's
 * own container name (`shellm-$$`, bin/shellm:947) is an accident of its
 * per-invocation PID and carries no identity meaning — the actual reuse key
 * is the `container_id` file above, read by env NAME, never by container
 * NAME. This port has no equivalent per-invocation `$$` shared by every wake
 * of one identity, so it names the container deterministically from the env
 * name instead, plus a short hash of the env's metadata dir so two distinct
 * identityDirs that happen to share an env name (e.g. two tests both named
 * "nova" under different tmp roots) never collide on one container.
 */
export function containerNameFor(envName: string, envDir: string): string {
  const safe = envName.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^[^a-zA-Z0-9]+/, "");
  const hash = crypto.createHash("sha1").update(envDir).digest("hex").slice(0, 8);
  return `shellm-${safe || "env"}-${hash}`;
}

/**
 * `_destroy_containers` (tools/identity:56-65): `docker rm -f` every env this
 * identity ever registered. Exported for a future `identity delete` port to
 * call (that command itself is out of this port's scope — see identity.ts's
 * file header) and used directly by tests that need a clean slate.
 */
export function destroyIdentityContainers(identityDir: string, dockerPath = "docker"): void {
  const envsDir = path.join(identityDir, ".shellm", "envs");
  let names: string[];
  try {
    names = fs.readdirSync(envsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  for (const name of names) {
    const envDir = path.join(envsDir, name);
    const containerId = readFileTrim(path.join(envDir, "container_id"));
    if (containerId) {
      spawnSync(dockerPath, ["rm", "-f", containerId], { stdio: "ignore" });
    }
  }
}
