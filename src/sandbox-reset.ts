import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { containerNameFor, envDirFor, removeEnvMetadata } from "./sandbox-env.ts";

/** PORT-NOTE: explicit embedder lifecycle operation; ordinary wakes retain upstream behavior (PARITY.md). */
export function resetIdentitySandbox(
  identityDir: string,
  envName: string,
  opts: { env?: NodeJS.ProcessEnv; dockerPath?: string } = {},
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(envName)) throw new Error("Invalid identity sandbox environment name.");
  const root = path.resolve(identityDir);
  const env = opts.env ?? process.env;
  const envsDir = path.join(root, ".shellm", "envs");
  if (env["SHELLM_ENVS_DIR"] && path.resolve(env["SHELLM_ENVS_DIR"]) !== envsDir) throw new Error("Identity sandbox state must remain under its identity directory.");
  const state = envDirFor(root, envName);
  const validateState = (): boolean => {
    for (const dir of [path.join(root, ".shellm"), envsDir, state]) {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Identity sandbox state path changed or is a symbolic link.");
    }
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw new Error("Identity sandbox requires a canonical identity directory.");
    for (const entry of fs.readdirSync(state, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Identity sandbox state files must be regular files.");
    }
    return true;
  };
  if (!validateState()) return;
  const idFile = path.join(state, "container_id");
  const readId = () => fs.readFileSync(idFile, "utf8").trim();
  const id = readId();
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Stored identity sandbox container ID is invalid.");
  const identityStat = fs.statSync(root);
  const stateStat = fs.statSync(state);
  const unchanged = () => {
    if (!validateState()) throw new Error("Identity sandbox state changed during reset.");
    const currentRoot = fs.statSync(root), currentState = fs.statSync(state);
    if (currentRoot.dev !== identityStat.dev || currentRoot.ino !== identityStat.ino || currentState.dev !== stateStat.dev || currentState.ino !== stateStat.ino || readId() !== id) throw new Error("Identity sandbox state changed during reset.");
  };
  const docker = (args: string[]) => spawnSync(opts.dockerPath ?? "docker", args, { env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const inspected = docker(["inspect", "--format", "{{json .}}", id]);
  if (inspected.status === 0) {
    let container: { Id?: string; Name?: string; Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[] };
    try { container = JSON.parse(inspected.stdout); }
    catch { throw new Error("Identity sandbox container ownership could not be verified."); }
    const expectedName = containerNameFor(envName, state);
    const owned = container && /^[a-f0-9]{64}$/.test(container.Id ?? "") && container.Id!.startsWith(id) && container.Name === `/${expectedName}` && Array.isArray(container.Mounts) && container.Mounts.some((mount) => mount.Type === "bind" && mount.RW === true && mount.Source === root && mount.Destination === root);
    if (!owned) throw new Error("Stored container does not belong to this identity sandbox.");
    unchanged();
    const removed = docker(["rm", "-f", container.Id!]);
    if (removed.status !== 0) throw new Error("Identity sandbox container could not be removed; state was preserved.");
  } else {
    const found = docker(["ps", "-a", "-q", "--no-trunc", "--filter", `id=${id}`]);
    if (found.status !== 0 || found.stdout.trim()) throw new Error("Identity sandbox container could not be verified; state was preserved.");
  }
  unchanged();
  removeEnvMetadata(state);
}
