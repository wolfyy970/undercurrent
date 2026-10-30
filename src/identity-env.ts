// identity-env.ts — resolveIdentityEnv: the single source of truth for the
// environment every CLI, the daemon, steprun, and (in the web lane) control.ts
// build on (PLAN-daemon §5, DIRECTOR CORRECTIONS 1).
//
// Upstream's `activate` (tools/identity:359-406) is a Bash script sourced into
// an interactive shell. This port never writes an `activate` file (correction
// 1) — its job is this pure function instead: given an identity dir, return
// the same variables `activate` would have exported, PLUS the `.env` layering
// `_load_env_defaults` does (thinkers/_lib/common.sh:14-26, 51-62) and the
// PATH-shadow guard bin/thinkers calls `_ensure_shellm_bins` (bin/thinkers:
// 1052-1096).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PORT_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT_BIN = path.join(PORT_HOME, "bin");

/**
 * Read `key=value` lines from info.txt (no quoting, first match wins).
 * Exported for reuse by thinkersctl.ts's `requireEnv` (bin/thinkers:143-147's
 * IDENTITY_NAME fallback — the same `grep '^name=' info.txt | cut -d= -f2-`
 * upstream's `activate` and `_require_env` both do).
 */
export function readInfoField(infoTxt: string, key: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(infoTxt, "utf8");
  } catch {
    return undefined;
  }
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

/**
 * `_load_env_defaults` (thinkers/_lib/common.sh:14-26): for every `KEY=` line
 * in `envfile`, export KEY only if it is not ALREADY set in `into`. Malformed
 * files are ignored (upstream warns to stderr and returns 0; we just skip).
 */
function loadEnvDefaults(envfile: string, into: Record<string, string>): void {
  let text: string;
  try {
    text = fs.readFileSync(envfile, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (into[key] !== undefined) continue; // already set — .env layering fills gaps only
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    into[key] = val;
  }
}

export interface ResolveIdentityEnvOptions {
  /** Base env to layer on top of (default process.env — anything already set wins). */
  base?: NodeJS.ProcessEnv;
  /** Override HEADLONG_HOME / ~/.headlong resolution for tests. */
  headlongHome?: string;
  /** Override $HOME resolution for tests. */
  home?: string;
}

/**
 * The `activate` exports (tools/identity:359-382) plus `.env` layering plus
 * PATH-shadow guard, as a plain object — never written to disk, never
 * sourced. Every reader of "the identity's environment" (daemon, thinkersctl,
 * identity, steprun, the web control.ts) calls this ONE function.
 */
export function resolveIdentityEnv(identityDir: string, opts: ResolveIdentityEnvOptions = {}): Record<string, string> {
  const base = opts.base ?? process.env;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;

  const idDir = path.resolve(identityDir);
  const infoTxt = path.join(idDir, "info.txt");
  const name = readInfoField(infoTxt, "name") ?? path.basename(idDir);
  const rootTraj = readInfoField(infoTxt, "root_trajectory") ?? "trajectory.jsonl";

  env["IDENTITY_NAME"] = name;
  env["IDENTITY_DIR"] = idDir;
  env["MEM_DIR"] = path.join(idDir, "memories");
  env["SKILLS_DIR"] = path.join(idDir, "skills");
  env["SKILLS_KERNEL_DIR"] = path.join(idDir, "kernel");
  env["TRAJ_DIR"] = path.join(idDir, "trajectories");
  env["TRAJ_ID"] = rootTraj;
  env["ROOT_TRAJ_ID"] = rootTraj;
  env["THINKERS_DIR"] = path.join(idDir, "thinkers");
  env["SKILLSRC"] = path.join(idDir, "skills", ".skillsrc");
  env["SHELLM_TRAJ_DIR"] = path.join(idDir, "trajectories");
  env["SHELLM_ENVS_DIR"] = path.join(idDir, ".shellm", "envs");
  env["SHELLM_WORKDIRS_DIR"] = path.join(idDir, ".shellm", "workdirs");
  env["SHELLM_BROKER_DIR"] = path.join(idDir, ".shellm", "docker-broker");
  env["SHELLM_CONF_DIR"] = path.join(idDir, ".shellm");
  env["CHATRC"] = path.join(idDir, "chat", ".chatrc");
  env["HEADLONG_TS_HOME"] = PORT_HOME;

  // .env layering (common.sh:51-62), fill-missing, in this priority order:
  // root .env is NOT ours to define (upstream's "root" is the repo checkout
  // running the CLI; here that is the port checkout itself), so we start from
  // the identity's own .env, then the shared framework homes.
  loadEnvDefaults(path.join(idDir, ".env"), env);
  const headlongHome = opts.headlongHome ?? base["HEADLONG_HOME"] ?? path.join(opts.home ?? homeDir(), ".headlong");
  loadEnvDefaults(path.join(headlongHome, ".env"), env);
  loadEnvDefaults(path.join(opts.home ?? homeDir(), ".shellm", ".env"), env);
  // Behavioral-parity fix (B2): `identity shell`/activate exports THINK_CONTEXT_TAIL="${THINK_CONTEXT_TAIL:-30}"
  // (tools/identity:414,1424), so a real upstream mind sees 30 recent steps, not the step scripts' own default of 20.
  if (!env["THINK_CONTEXT_TAIL"]) env["THINK_CONTEXT_TAIL"] = "30";

  // PATH-shadow guard (_ensure_shellm_bins, bin/thinkers:1052-1096): our bin/
  // must resolve first, ahead of any stale system copy (e.g. macOS ships
  // /usr/sbin/chat).
  const nodeDir = path.dirname(process.execPath);
  const existingPath = env["PATH"] ?? "";
  const parts = existingPath ? existingPath.split(path.delimiter) : [];
  const withoutOurs = parts.filter((p) => p !== PORT_BIN && p !== nodeDir);
  env["PATH"] = [PORT_BIN, nodeDir, ...withoutOurs].join(path.delimiter);

  return env;
}

function homeDir(): string {
  return process.env["HOME"] ?? "/root";
}

export { PORT_HOME, PORT_BIN };
