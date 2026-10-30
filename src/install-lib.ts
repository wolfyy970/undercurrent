// install-lib.ts — testable core of install.mjs (faithful port of
// install.sh @ 5458fee). install.mjs (repo root) is the thin CLI wrapper.
//
// PORT-NOTEs (see PARITY.md "install" for the full table):
//   - TOOLS is this port's actual bin/ inventory, not upstream's list:
//     shellm/shellm-docker/shellm-docker-broker/shellm-explore/persona/
//     headlong-web/headlong-tui are not shipped as standalone CLIs by this
//     port (shellm runs in-process; persona and a `headlong-web` shim are
//     gaps — see PARITY.md; the dash is reached via `node web/scripts/
//     dev.mjs` directly and the TUI via `cargo build` in tui/headlong, both
//     documented in README.md).
//   - no `_install_skills`/`_install_thinkers` step: this port has no
//     top-level thinkers/ or skills/ staging directories at all — `identity
//     new` (src/identity.ts) bundles skill/thinker templates straight from
//     src/assets/ into each identity, with no global ~/.skills/core-skills
//     or ~/.headlong-thinkers indirection to install.
//   - the bootstrap clone does NOT run `pnpm install`/`npm install`: the
//     port's bin/ CLIs have zero runtime dependencies (Node's native TS
//     stripping needs no build step and no node_modules — the "Zero deps"
//     ethos already stated in web/scripts/dev.mjs). Only the web viewer
//     (a vendored React app) needs `npm install`, and only when the dash is
//     actually started (src/init.ts's ensureDashDeps prompts for that then).
//     This also makes the bootstrap path testable against a local bare repo
//     with no network and no slow install step.
//   - dependency check: only `git` (for the bootstrap clone) — no `jq`/
//     `curl` (native JSON.parse and fetch replace them).
//   - the "is this a headlong-ts checkout" marker is `bin/identity.mjs`
//     (see src/init.ts's resolveAppDir for the same convention).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isCheckout, commandExists, dockerState } from "./init.ts";
import { urlIsLoopback, urlHostSwap } from "./net-url.ts";

// PORT-NOTE (1c: 12ca841): put/sub/view (and focus/glob, already absent from
// this list) retired — upstream drops all five ("the mind reads and edits in
// bash"; install.sh's BIN_TOOLS follows suit).
/** The bare-name tools this port installs onto PATH (see file header PORT-NOTE). */
export const TOOLS = [
  "chat",
  "context",
  "identity",
  "llm",
  "mem",
  "recap",
  "skills",
  "thinkers",
  "traj",
  "headlong-killall",
  "headlong-slack-bridge",
  "headlong-telegram-bridge",
  "headlong-init",
] as const;

export interface InstallIO {
  stdout(s: string): void;
  stderr(s: string): void;
  writeTty(s: string): void;
  readTtyLine(): Promise<string | undefined>;
  hasTTY(): boolean;
  /** Run an external command to completion, returning its exit status. Used for git/cargo/docker. */
  run(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string> ; stdio?: "inherit" | "ignore" }): number;
  /** Exec a node script in place of this process (bootstrap re-exec, --init handoff, --uninstall delegation). Never returns. */
  execNode(scriptPath: string, args: string[], env: Record<string, string>): never;
}

export class InstallError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

function die(msg: string): never {
  throw new InstallError(msg);
}

function pkgHint(pkg: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return `brew install ${pkg}`;
  return `install ${pkg} with your package manager`;
}

export function requireDeps(deps: string[], env: Record<string, string>, platform: NodeJS.Platform): void {
  const missing = deps.filter((d) => !commandExists(d, env));
  if (missing.length === 0) return;
  const lines = missing.map((d) => `install.mjs: missing dependency: ${d}   (${pkgHint(d, platform)})`);
  die(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// The whole-agent-in-Docker offer (install.sh's _offer_docker_install /
// _location_offer_available / _docker_forward_args).
// ---------------------------------------------------------------------------

function inContainer(): boolean {
  return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

/** `_location_offer_available`. */
export function locationOfferAvailable(env: Record<string, string>, io: { hasTTY(): boolean }): boolean {
  if (env["HEADLONG_INSTALL_LOCATION_CHOSEN"] === "1") return false;
  if (inContainer()) return false;
  if (!io.hasTTY()) return false;
  return dockerState(env) === "ok";
}

const SECRET_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "LLM_API_KEY", "HEADLONG_LOCAL_API_KEY"];
const INLINE_VARS = [
  "HEADLONG_IDENTITY_NAME",
  "HEADLONG_IDENTITY_VIBE",
  "HEADLONG_IDENTITY_FOCUS",
  "HEADLONG_IDENTITY_USER",
  "HEADLONG_OPERATOR_NAME",
  "HEADLONG_REPO",
  "HEADLONG_BRANCH",
  "HEADLONG_PROVIDER",
  "HEADLONG_LOCAL_MODEL",
];

export interface DockerForward {
  /** `docker run` args, e.g. ["-e", "OPENROUTER_API_KEY", "-e", "HEADLONG_IDENTITY_NAME=ada"]. Never carries a secret's value. */
  args: string[];
  /** Extra vars the spawned `docker` process needs in ITS OWN env so a bare `-e VAR` resolves — never put on the command line. */
  envToSet: Record<string, string>;
}

/**
 * `_docker_forward_args`: what to forward into the container-install's
 * `docker run`. Secrets (provider keys, the local server key, the local
 * server URL — which may embed userinfo/a token) go by NAME ONLY, resolved
 * from the spawned docker process's OWN environment (`envToSet`) — never
 * inlined into `args`, which a `ps` on this machine can read for as long as
 * the docker client runs (same rule tests/test_var_secrets.sh pins for
 * shellm, and thinkers/_lib/common.sh already follows for the same reason).
 * The non-secret interview answers + HEADLONG_REPO/HEADLONG_BRANCH stay
 * inline, matching upstream (bash assigns those two without `export`, so a
 * bare-name `-e` would forward nothing there; the port has no such
 * distinction, but keeps the same shape for parity with tests/
 * test_install_secret_argv.sh, whose fixture also sets them unexported).
 */
export function dockerForwardArgs(env: Record<string, string>): DockerForward {
  const args: string[] = [];
  const envToSet: Record<string, string> = {};
  for (const v of SECRET_VARS) {
    const val = env[v];
    if (!val) continue;
    args.push("-e", v);
    envToSet[v] = val;
  }
  const localUrl = env["HEADLONG_LOCAL_URL"];
  if (localUrl) {
    const rewritten = urlIsLoopback(localUrl) ? urlHostSwap(localUrl, "host.docker.internal") : localUrl;
    args.push("-e", "HEADLONG_LOCAL_URL");
    envToSet["HEADLONG_LOCAL_URL"] = rewritten;
  }
  for (const v of INLINE_VARS) {
    const val = env[v];
    if (val) args.push("-e", `${v}=${val}`);
  }
  return { args, envToSet };
}

export type DockerMenuChoice = "container" | "host" | "unsandboxed-host" | "back";

/** Parse one reply at the 3-way `_offer_docker_install` menu. */
export function parseDockerMenuChoice(reply: string): "container" | "host" | "unsandboxed" | "invalid" {
  const r = reply.trim();
  if (r === "" || r === "1") return "container";
  if (r === "2") return "host";
  if (r === "3") return "unsandboxed";
  return "invalid";
}

// ---------------------------------------------------------------------------
// Tool / TUI install
// ---------------------------------------------------------------------------

export function installTools(appDir: string, prefix: string, symlinks: boolean, io: InstallIO): void {
  io.stdout(symlinks ? `==> Linking tools into ${prefix}\n` : `==> Installing tools into ${prefix}\n`);
  fs.mkdirSync(prefix, { recursive: true });
  for (const tool of TOOLS) {
    const src = path.join(appDir, "bin", tool);
    const dest = path.join(prefix, tool);
    if (symlinks) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* nothing there yet */
      }
      fs.symlinkSync(src, dest);
      io.stdout(`  Linked ${tool} -> ${dest}\n`);
    } else {
      fs.copyFileSync(fs.realpathSync(src), dest);
      fs.chmodSync(dest, 0o755);
      io.stdout(`  Installed ${tool} -> ${dest}\n`);
    }
  }
}

export function installTui(appDir: string, prefix: string, env: Record<string, string>, io: InstallIO): void {
  const tuiDir = path.join(appDir, "tui", "headlong");
  if (!fs.existsSync(path.join(tuiDir, "Cargo.toml"))) return;
  if (!commandExists("cargo", env)) {
    io.stderr("Warning: cargo not found, skipping TUI tools\n");
    return;
  }
  io.stdout("==> Building the headlong TUI (cargo, release build)\n");
  const rc = io.run("cargo", ["build", "--release", "--quiet"], { cwd: tuiDir, env, stdio: "ignore" });
  if (rc !== 0) {
    io.stderr("Warning: failed to build headlong (skipping)\n");
    return;
  }
  const built = ["headlong-tui", "headlong"].map((n) => path.join(tuiDir, "target", "release", n)).find((p) => fs.existsSync(p));
  if (!built) return;
  const dest = path.join(prefix, path.basename(built));
  fs.copyFileSync(built, dest);
  fs.chmodSync(dest, 0o755);
  io.stdout(`  Installed ${path.basename(built)} -> ${dest}\n`);
}

// ---------------------------------------------------------------------------
// PATH handling
// ---------------------------------------------------------------------------

function rcFileFor(shell: string, platform: NodeJS.Platform, home: string): string {
  const base = path.basename(shell);
  if (base === "zsh") return path.join(home, ".zshrc");
  if (base === "bash") return platform === "darwin" ? path.join(home, ".bash_profile") : path.join(home, ".bashrc");
  return "";
}

export interface EnsurePathResult {
  pathAdded?: string;
  rcFile?: string;
}

/** `_ensure_path`. Mutates `env["PATH"]`; returns HEADLONG_PATH_ADDED/HEADLONG_RC_FILE equivalents. */
export async function ensurePath(prefix: string, env: Record<string, string>, io: InstallIO, platform: NodeJS.Platform, home: string): Promise<EnsurePathResult> {
  const parts = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  if (parts.includes(prefix)) {
    warnShadowed(prefix, env, io);
    return {};
  }
  env["PATH"] = [prefix, ...parts].join(path.delimiter);
  const line = `export PATH="${prefix}:$PATH"`;
  const rc = rcFileFor(env["SHELL"] ?? "", platform, home);
  const container = inContainer();

  if (rc && container) {
    appendIfMissing(rc, line);
    io.stdout(`==> Added ${prefix} to PATH in ${rc} (container — no prompt).\n`);
    return { pathAdded: prefix, rcFile: rc };
  }
  if (rc && io.hasTTY()) {
    io.stdout("\n");
    io.writeTty(`Add ${prefix} to your PATH in ${rc}? [Y/n] `);
    const reply = (await io.readTtyLine()) ?? "";
    if (!/^[Nn]/.test(reply)) {
      appendIfMissing(rc, line);
      io.stdout(`Added to ${rc} (takes effect in new shells).\n`);
      return { pathAdded: prefix, rcFile: rc };
    }
    io.stdout("\n");
    return { pathAdded: prefix };
  }
  io.stdout(`\nWarning: ${prefix} is not on your PATH.\nAdd this line to your shell rc (~/.zshrc, ~/.bashrc, etc.):\n  ${line}\n`);
  return { pathAdded: prefix };
}

function appendIfMissing(rc: string, line: string): void {
  let text = "";
  try {
    text = fs.readFileSync(rc, "utf8");
  } catch {
    /* file doesn't exist yet */
  }
  if (text.split("\n").includes(line)) return;
  fs.mkdirSync(path.dirname(rc), { recursive: true });
  fs.appendFileSync(rc, `\n${line}\n`);
}

/** `_warn_shadowed`: a same-named binary earlier on PATH silently shadows the tool we just installed. */
function warnShadowed(prefix: string, env: Record<string, string>, io: InstallIO): void {
  const parts = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const shadowed: string[] = [];
  for (const tool of TOOLS) {
    const installed = path.join(prefix, tool);
    if (!fs.existsSync(installed)) continue;
    for (const dir of parts) {
      if (dir === prefix) break; // reached our own dir first: not shadowed
      const candidate = path.join(dir, tool);
      if (fs.existsSync(candidate)) {
        shadowed.push(`${tool} -> ${candidate}`);
        break;
      }
    }
  }
  if (shadowed.length === 0) return;
  io.stdout(
    `\nWarning: ${prefix} is on your PATH but behind a dir with same-named\nbinaries, so these tools are shadowed by other programs:\n${shadowed.map((s) => `  ${s}\n`).join("")}` +
      `Move ${prefix} ahead of the system dirs (e.g. /usr/sbin) in your shell rc:\n  export PATH="${prefix}:$PATH"\n`
  );
}

// ---------------------------------------------------------------------------
// Bootstrap (curl | node -) — clone to $HEADLONG_HOME/app, then hand off.
// ---------------------------------------------------------------------------

export interface BootstrapPlan {
  repo: string;
  branch: string;
  appDir: string;
}

export function resolveBootstrapPlan(env: Record<string, string>, headlongHome: string): BootstrapPlan {
  return {
    repo: env["HEADLONG_REPO"] || "https://github.com/wolfyy970/undercurrent.git",
    branch: env["HEADLONG_BRANCH"] || "main",
    appDir: path.join(headlongHome, "app"),
  };
}

export function cloneOrUpdate(plan: BootstrapPlan, env: Record<string, string>, io: InstallIO): void {
  if (fs.existsSync(path.join(plan.appDir, ".git"))) {
    io.stdout(`==> Updating existing checkout at ${plan.appDir}\n`);
    const rc = io.run("git", ["-C", plan.appDir, "pull", "--ff-only", "origin", plan.branch], { env, stdio: "ignore" });
    if (rc !== 0) io.stderr(`install.mjs: warning: could not update ${plan.appDir}; installing from what's there\n`);
    return;
  }
  io.stdout(`==> Cloning ${plan.repo} (${plan.branch}) to ${plan.appDir}\n`);
  fs.mkdirSync(path.dirname(plan.appDir), { recursive: true });
  const rc = io.run("git", ["clone", "--branch", plan.branch, plan.repo, plan.appDir], { env, stdio: "inherit" });
  if (rc !== 0) die(`git clone failed (exit ${rc})`);
}

// ---------------------------------------------------------------------------
// app_dir record
// ---------------------------------------------------------------------------

export function recordAppDir(headlongHome: string, appDir: string): void {
  fs.mkdirSync(headlongHome, { recursive: true });
  fs.writeFileSync(path.join(headlongHome, "app_dir"), `${appDir}\n`);
}

// ---------------------------------------------------------------------------
// The whole-agent-in-Docker menu (install.sh's _offer_docker_install). Gated
// by locationOfferAvailable (real tty + real docker + not already chosen +
// not already in a container) — never fires under automated testing, same
// as upstream's own test suite, which pins only the pure secret-forwarding
// helper (dockerForwardArgs above) rather than a real `docker run`.
// ---------------------------------------------------------------------------

export interface OfferDockerResult {
  /** true: the caller should continue with the host install; false: this function already exec'd/exited. */
  continueHostInstall: boolean;
}

export async function offerDockerInstall(env: Record<string, string>, io: InstallIO, installUrl: string): Promise<OfferDockerResult> {
  io.writeTty(
    "Docker is installed and running. Where should your agent live?\n\n" +
      "  1) Fully inside a Docker container. Nothing is installed on this\n" +
      "     machine, and everything the agent does stays in the container.\n" +
      "  2) On this machine. The tools go to ~/.local/bin, and the agent's\n" +
      "     shell commands still run sandboxed in Docker.\n" +
      "  3) DANGEROUSLY on this machine with NO sandbox (NOT RECOMMENDED).\n\n"
  );
  for (;;) {
    io.writeTty("Choice [1]: ");
    const reply = (await io.readTtyLine()) ?? "";
    const choice = parseDockerMenuChoice(reply);
    if (choice === "host") return { continueHostInstall: true };
    if (choice === "invalid") {
      io.writeTty("Please answer 1, 2, or 3.\n");
      continue;
    }
    if (choice === "unsandboxed") {
      io.writeTty(
        "\nEVERY shell command your agent writes will run DIRECTLY ON THIS MACHINE,\nas your user, with access to your files, with no sandbox. Headlong agents\nrun continuously and unattended. NOT RECOMMENDED.\n\n"
      );
      io.writeTty('Type "yes" to DANGEROUSLY continue without a sandbox (anything else goes back): ');
      const confirm = (await io.readTtyLine()) ?? "";
      if (confirm === "yes") {
        env["HEADLONG_UNSANDBOXED"] = "1";
        return { continueHostInstall: true };
      }
      continue;
    }
    // choice === "container"
    const existing = spawnSync("docker", ["inspect", "--type", "container", "headlong"], { stdio: "ignore", env });
    if (existing.status === 0) {
      io.stdout(
        "\nA container named 'headlong' already exists, so your agent lives there.\nDropping you into it (type exit to leave; the agent keeps running).\nTo update the agent, re-run the installer inside the container:\n  curl -fsSL " +
          installUrl +
          " | node -\n"
      );
      spawnSync("docker", ["start", "headlong"], { stdio: "ignore", env });
      io.run("docker", ["exec", "-it", "headlong", "bash", "-l"], { env, stdio: "inherit" });
      return { continueHostInstall: false };
    }
    const fwd = dockerForwardArgs(env);
    io.stdout(`\n==> Starting your agent in a Docker container named 'headlong'\n    Dash: http://localhost:8080 once it is up. Get back in later with:\n    docker exec -it headlong bash -l\n\n`);
    const dockerEnv = { ...env, ...fwd.envToSet };
    const rc = io.run(
      "docker",
      [
        "run",
        "-it",
        "--name",
        "headlong",
        "--restart",
        "unless-stopped",
        "-p",
        "8080:8080",
        "--add-host",
        "host.docker.internal:host-gateway",
        ...fwd.args,
        "buildpack-deps:curl",
        "bash",
        "-c",
        `curl -fsSL ${installUrl} | node -; exec bash`,
      ],
      { env: dockerEnv, stdio: "inherit" }
    );
    if (rc === 0) {
      io.stdout(
        "\nYou left the container shell; the agent keeps running in the background.\n  docker exec -it headlong bash -l   back into the agent's world\n  docker stop headlong               pause everything\n  docker start headlong              resume\n  docker rm -f headlong              delete the agent and its whole world\n"
      );
      return { continueHostInstall: false };
    }
    io.stderr(`install.mjs: the Docker run failed (exit ${rc}).\n`);
    io.stderr("If the name or port 8080 is taken, remove the half-made container with\n  docker rm -f headlong\n");
    io.stderr("and re-run the installer. Answer 2 to install on this machine instead.\n");
    die(`docker run failed (exit ${rc})`);
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export interface RunInstallOptions {
  argv: string[];
  env: Record<string, string>;
  io: InstallIO;
  /** node's argv[1] — the script path Node was invoked with, "-" (or empty) when piped from stdin. */
  selfPath: string;
  home: string;
  platform: NodeJS.Platform;
  installUrl: string;
}

function resolveSelfDir(selfPath: string): string | undefined {
  if (!selfPath || selfPath === "-") return undefined;
  try {
    const real = fs.realpathSync(selfPath);
    return fs.statSync(real).isFile() ? path.dirname(real) : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedArgs {
  prefix?: string;
  symlinks: boolean;
  runInit: boolean;
  uninstall: boolean;
  rest: string[];
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { symlinks: false, runInit: false, uninstall: false, rest: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--symlinks") out.symlinks = true;
    else if (a === "--prefix") {
      const v = argv[++i];
      if (!v) die("--prefix requires a path");
      out.prefix = v;
    } else if (a === "--init") out.runInit = true;
    else if (a === "--no-init") out.runInit = false;
    else if (a === "--uninstall") {
      out.uninstall = true;
      out.rest = argv.slice(i + 1);
      break;
    } else if (a === "-h" || a === "--help") out.help = true;
    else die(`Unknown option: ${a} (try --help)`);
  }
  return out;
}

const USAGE = `Usage: node install.mjs [options]

Installs Headlong-TS's tools from bin/ to a directory on your PATH, and the
Rust TUI if cargo is available.

Options:
  --prefix DIR   Install directory (default: ~/.local/bin)
  --symlinks     Create symlinks instead of copies (edits take effect without reinstalling)
  --init         After installing, run headlong-init to bootstrap a first
                 identity and start the local dash (the curl|node one-liner
                 does this by default)
  --uninstall    Remove Headlong-TS from this machine (runs uninstall.mjs; see
                 uninstall.mjs --help for its options)
  -h, --help     Show this help

Environment variables:
  PREFIX         Same as --prefix
  SYMLINKS=1     Same as --symlinks
  HEADLONG_HOME  Headlong state directory (default: ~/.headlong)
`;

export async function runInstall(opts: RunInstallOptions): Promise<number> {
  try {
    return await runInstallInner(opts);
  } catch (err) {
    if (err instanceof InstallError) {
      opts.io.stderr(`install.mjs: error: ${err.message}\n`);
      return err.code;
    }
    opts.io.stderr(`install.mjs: error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runInstallInner(opts: RunInstallOptions): Promise<number> {
  const { env, io } = opts;
  const headlongHome = env["HEADLONG_HOME"] || path.join(opts.home, ".headlong");
  const selfDir = resolveSelfDir(opts.selfPath);
  const checkoutMode = selfDir !== undefined && isCheckout(selfDir);

  if (!checkoutMode) {
    // Bootstrap: no checkout next to this script (curl | node -). install.mjs
    // itself never reaches this branch for a REAL piped run — it can't import
    // this module before a checkout exists (see install.mjs's file header
    // PORT-NOTE) and duplicates a minimal inline clone+re-exec instead. This
    // branch stays here, reachable with injected IO, so the bootstrap
    // decision logic (locationOfferAvailable, cloneOrUpdate, the re-exec
    // handoff) has ONE tested implementation rather than two divergent ones.
    requireDeps(["git"], env, opts.platform);
    io.stdout(
      "\nHeadlong-TS installer. At any time, from any shell:\n" +
        "  read-only status:  node status.mjs (from the checkout)\n" +
        "  uninstall:         node uninstall.mjs (from the checkout)\n\n"
    );
    const plan = resolveBootstrapPlan(env, headlongHome);
    if (!fs.existsSync(path.join(plan.appDir, ".identities", "default")) && locationOfferAvailable(env, io)) {
      const result = await offerDockerInstall(env, io, opts.installUrl);
      env["HEADLONG_INSTALL_LOCATION_CHOSEN"] = "1";
      if (!result.continueHostInstall) return 0;
    }
    cloneOrUpdate(plan, env, io);
    io.stdout("\n");
    io.execNode(path.join(plan.appDir, "install.mjs"), ["--symlinks", "--init", ...opts.argv], env);
  }

  const appDir = selfDir!;
  const args = parseArgs(opts.argv);
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (args.uninstall) {
    io.execNode(path.join(appDir, "uninstall.mjs"), args.rest, env);
  }

  const prefix = args.prefix || env["PREFIX"] || path.join(opts.home, ".local", "bin");
  const symlinks = args.symlinks || env["SYMLINKS"] === "1";

  if (
    args.runInit &&
    !fs.existsSync(path.join(headlongHome, "app", ".identities", "default")) &&
    !fs.existsSync(path.join(appDir, ".identities", "default")) &&
    locationOfferAvailable(env, io)
  ) {
    const result = await offerDockerInstall(env, io, opts.installUrl);
    env["HEADLONG_INSTALL_LOCATION_CHOSEN"] = "1";
    if (!result.continueHostInstall) return 0;
  }
  delete env["HEADLONG_INSTALL_LOCATION_CHOSEN"];

  fs.mkdirSync(prefix, { recursive: true });
  installTools(appDir, prefix, symlinks, io);
  recordAppDir(headlongHome, appDir);
  installTui(appDir, prefix, env, io);
  const pathResult = await ensurePath(prefix, env, io, opts.platform, opts.home);
  if (pathResult.pathAdded) env["HEADLONG_PATH_ADDED"] = pathResult.pathAdded;
  if (pathResult.rcFile) env["HEADLONG_RC_FILE"] = pathResult.rcFile;

  if (args.runInit) {
    io.stdout("\n");
    io.execNode(path.join(prefix, "headlong-init"), [], env);
  }
  return 0;
}

export { die, isCheckout };
