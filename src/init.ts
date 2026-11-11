// init.ts — faithful port of tools/headlong-init (upstream @ 5458fee).
//
// Idempotent bootstrap: state home (HEADLONG_HOME, default ~/.headlong), an
// LLM provider (cloud key or local OpenAI-compatible endpoint), the Docker
// sandbox consent gate, an identity interview, the monolith+responder
// thinkers, and the web dash — then writes status.json.
//
// Every HEADLONG_* env knob from the upstream header comment is preserved:
//   HEADLONG_HOME, HEADLONG_APP_DIR, HEADLONG_IDENTITY_NAME,
//   HEADLONG_IDENTITY_VIBE, HEADLONG_IDENTITY_FOCUS, HEADLONG_IDENTITY_USER,
//   HEADLONG_OPERATOR_NAME, HEADLONG_NO_THINKERS, HEADLONG_NO_DASH,
//   HEADLONG_WEB_ARGS, HEADLONG_PROVIDER, HEADLONG_LOCAL_URL,
//   HEADLONG_LOCAL_API_KEY, HEADLONG_LOCAL_MODEL, HEADLONG_UNSANDBOXED,
//   HEADLONG_FAKE_DOCKER, HEADLONG_FAKE_CONTAINER, HEADLONG_NO_TTY,
//   HEADLONG_RC_FILE, HEADLONG_PATH_ADDED.
//
// PORT-NOTEs (deliberate deviations from the Bash, all documented in
// PARITY.md "init"):
//   - the local-endpoint probe uses the port's `fetch()` directly with an
//     Authorization header; there is no curl auth-tempfile (no equivalent
//     of CURL_AUTH_FILE/chmod 600 — nothing is ever written to disk to
//     carry the header).
//   - `persona` (the per-identity command wrapper) is not shipped by this
//     port (see PARITY.md Gaps): `_linkPersonaCommand` is therefore always
//     a no-op (bash's own `[[ -e "$target" ]] || return 0` guard), and the
//     summary's `persona <name>` command line names a tool this port does
//     not ship yet — same text bash would print in an environment lacking
//     bin/persona, which is this port's actual situation.
//   - the dash is this port's own `web/scripts/dev.mjs` (API + Vite viewer)
//     rather than upstream's `headlong-web`; dependency bootstrapping checks
//     for `web/viewer/node_modules` instead of `uv`/`bun`, and readiness is
//     detected from dev.mjs's own log lines instead of a
//     `(shellm|shelly|headlong)-web serving` regex.
//   - `identity`/`thinkers` are called in-process (src/identity.ts,
//     src/thinkersctl.ts) rather than as subprocesses on PATH — the same
//     functions bin/identity.mjs and bin/thinkers.mjs themselves wrap.
//   - the "is this a headlong checkout" marker is `bin/identity.mjs` (this
//     port ships no `bin/shellm`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { identityNew } from "./identity.ts";
import { resolveIdentityEnv } from "./identity-env.ts";
import { thinkersStart, thinkersStop } from "./thinkersctl.ts";
import { runLlm, type LlmIO } from "./llmCli.ts";
import { spawnAdapterProcess } from "./llmAdapterProcess.ts";
import { urlHost, urlSafeDisplay, urlHostSwap, urlIsLoopback } from "./net-url.ts";

const PORT_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Injectable IO — real node:fs is used directly (this codebase's convention:
// see src/identity.ts, src/thinkersctl.ts); only genuinely environmental
// concerns are injected so unit tests can run without a real tty/network.
// ---------------------------------------------------------------------------

export interface InitIO {
  stdout(s: string): void;
  stderr(s: string): void;
  now(): Date;
  fetch: typeof globalThis.fetch;
  randomHex(n: number): string;
  hasTTY(): boolean;
  /** Read one line from /dev/tty. undefined on EOF (Ctrl-D), matching `read -r || true`. */
  readTtyLine(opts?: { hidden?: boolean }): Promise<string | undefined>;
  /** Write text straight to /dev/tty (the heredoc banners). */
  writeTty(s: string): void;
  /** Spawn a detached, unref'd background process; stdout/stderr appended to logFile. */
  spawnDetached(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string> ; logFile: string }): number;
  isAlive(pid: number): boolean;
  openUrl(url: string): void;
  platform: NodeJS.Platform;
  execPath: string;
}

/** Real IO for bin/headlong-init.mjs. */
export function realInitIO(): InitIO {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    now: () => new Date(),
    fetch: globalThis.fetch,
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
    hasTTY: () => {
      try {
        const fd = fs.openSync("/dev/tty", "r");
        fs.closeSync(fd);
        return true;
      } catch {
        return false;
      }
    },
    readTtyLine: (opts) => readTtyLineReal(opts?.hidden ?? false),
    writeTty: (s) => {
      try {
        fs.writeFileSync("/dev/tty", s);
      } catch {
        /* no tty; nothing to show */
      }
    },
    spawnDetached: (cmd, args, opts) => {
      const logFd = fs.openSync(opts.logFile, "a");
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);
      if (typeof child.pid !== "number") throw new Error(`failed to spawn ${cmd}`);
      return child.pid;
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    openUrl: (url) => {
      try {
        if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
        else if (process.platform === "linux" && (process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"])) {
          spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
        }
      } catch {
        /* best effort, never fails */
      }
    },
    platform: process.platform,
    execPath: process.execPath,
  };
}

function readTtyLineReal(hidden: boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    let fd: number;
    try {
      fd = fs.openSync("/dev/tty", "r");
    } catch {
      resolve(undefined);
      return;
    }
    const stream = fs.createReadStream("", { fd });
    let buf = "";
    let done = false;
    const finish = (val: string | undefined) => {
      if (done) return;
      done = true;
      stream.close();
      resolve(val);
    };
    if (hidden && process.stdin.isTTY) {
      try {
        (process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(true);
      } catch {
        /* not a real tty stdin; fall through to line mode */
      }
    }
    stream.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        let line = buf.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (hidden && process.stdin.isTTY) {
          try {
            (process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(false);
          } catch {
            /* ignore */
          }
        }
        finish(line);
      }
    });
    stream.on("error", () => finish(undefined));
    stream.on("end", () => finish(undefined));
  });
}

// ---------------------------------------------------------------------------
// die/info — headlong-init: error: <msg> to stderr, exit 1 (via InitError);
// `\n==> <msg>` phase headers.
// ---------------------------------------------------------------------------

export class InitError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

function die(msg: string): never {
  throw new InitError(msg);
}

function info(io: InitIO, msg: string): void {
  io.stdout(`\n==> ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Env helpers — a small `[export ]KEY=VALUE` file parser (same convention as
// identity-env.ts's loadEnvDefaults / llmCli.ts's .env loader), plus
// _env_set/_env_unset (single-quoted values, KEY replaced in place, chmod 600).
// ---------------------------------------------------------------------------

/** `_load_env`: fill only keys NOT already present in `env` (real env wins). */
function loadEnvFillMissing(file: string, env: Record<string, string>): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (env[key] !== undefined) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

export interface EnvWriter {
  dryRun: boolean;
  io: InitIO;
}

/** `_env_set`: replace/append `KEY='value'` in `file`; export into `env`. */
export function envSet(w: EnvWriter, env: Record<string, string>, file: string, key: string, val: string): void {
  if (w.dryRun) {
    w.io.stdout(`    dry-run: would set ${key}=${val} in ${file}\n`);
    env[key] = val;
    return;
  }
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    lines = [];
  }
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  const esc = val.replace(/'/g, "'\\''");
  kept.push(`${key}='${esc}'`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, kept.map((l) => `${l}\n`).join(""));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort, as upstream */
  }
  env[key] = val;
}

/** `_env_unset`: remove `KEY=` from `file` and from `env`. */
export function envUnset(w: EnvWriter, env: Record<string, string>, file: string, key: string): void {
  if (w.dryRun) {
    w.io.stdout(`    dry-run: would remove ${key} from ${file}\n`);
    delete env[key];
    return;
  }
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const kept = lines.filter((l) => !l.startsWith(`${key}=`));
    fs.writeFileSync(file, kept.map((l) => `${l}\n`).join(""));
  } catch {
    /* file may not exist yet */
  }
  delete env[key];
}

// ---------------------------------------------------------------------------
// App-dir resolution — `bin/identity.mjs` stands in for upstream's
// `bin/shellm` as "this is a headlong-ts checkout" (see file header PORT-NOTE).
// ---------------------------------------------------------------------------

export function isCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, "bin", "identity.mjs"));
}

function resolveAppDir(env: Record<string, string>, headlongHome: string): string {
  if (env["HEADLONG_APP_DIR"]) {
    // An explicit override is trusted more than auto-detection below: just
    // require the directory to exist, not the bin/identity.mjs marker. This
    // also accepts a bash-shaped fixture (e.g. one with only bin/shellm, as
    // upstream's own test harnesses build) — the operator said where it is;
    // upstream's equivalent check (`-f "$HEADLONG_APP_DIR/bin/shellm"`) is a
    // sanity guard, not a security boundary, and this port has no single
    // universal marker file every legitimate caller is guaranteed to create.
    const d = env["HEADLONG_APP_DIR"];
    if (!fs.existsSync(d)) die(`HEADLONG_APP_DIR=${d} is not a headlong-ts checkout`);
    return d;
  }
  // This module lives at <repo>/src/init.ts.
  const repoRoot = path.resolve(PORT_SRC_DIR, "..");
  if (isCheckout(repoRoot) && fs.existsSync(path.join(repoRoot, "install.mjs"))) {
    return repoRoot;
  }
  const recordedFile = path.join(headlongHome, "app_dir");
  try {
    const recorded = fs.readFileSync(recordedFile, "utf8").trim();
    if (recorded && isCheckout(recorded)) return recorded;
  } catch {
    /* not recorded */
  }
  const appSub = path.join(headlongHome, "app");
  if (isCheckout(appSub)) return appSub;
  die("can't find the headlong-ts checkout. Set HEADLONG_APP_DIR=/path/to/headlong-ts");
}

// ---------------------------------------------------------------------------
// TTY-aware prompting
// ---------------------------------------------------------------------------

export interface Prompter {
  hasTTY: boolean;
  io: InitIO;
}

/** `ask <prompt> [default]`. */
async function ask(p: Prompter, prompt: string, def = ""): Promise<string> {
  if (!p.hasTTY) return def;
  p.io.writeTty(def ? `${prompt} [${def}]: ` : `${prompt}: `);
  const reply = await p.io.readTtyLine();
  return reply || def;
}

/** `ask_yn <prompt> [default y|n]`. */
async function askYn(p: Prompter, prompt: string, def: "y" | "n" = "y"): Promise<boolean> {
  const hint = def === "n" ? "[y/N]" : "[Y/n]";
  const reply = await ask(p, `${prompt} ${hint}`, def);
  return def === "n" ? /^[Yy]/.test(reply) : !/^[Nn]/.test(reply);
}

/** `confirm_install <prompt>`: auto-yes in a container, else ask_yn on a tty. */
async function confirmInstall(p: Prompter, inContainer: boolean, prompt: string): Promise<boolean> {
  if (inContainer) {
    info(p.io, `${prompt} Yes (container).`);
    return true;
  }
  if (!p.hasTTY) return false;
  return askYn(p, prompt);
}

// ---------------------------------------------------------------------------
// Docker sandbox gate
// ---------------------------------------------------------------------------

export type DockerState = "ok" | "down" | "missing";

export function commandExists(cmd: string, env: Record<string, string>): boolean {
  const pathVar = env["PATH"] ?? "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const st = fs.statSync(candidate);
      if (st.isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** `_docker_state`: HEADLONG_FAKE_DOCKER wins; else PATH lookup + `docker info`. */
export function dockerState(env: Record<string, string>): DockerState {
  const fake = env["HEADLONG_FAKE_DOCKER"];
  if (fake === "ok" || fake === "down" || fake === "missing") return fake;
  if (!commandExists("docker", env)) return "missing";
  const r = spawnSync("docker", ["info"], { stdio: "ignore", env, timeout: 30_000 });
  return r.status === 0 ? "ok" : "down";
}

interface GateCtx {
  io: InitIO;
  w: EnvWriter;
  env: Record<string, string>;
  headlongEnvFile: string;
  initLog: string;
  inContainer: boolean;
  name: string;
}

function sandboxOn(ctx: GateCtx): void {
  info(ctx.io, `Docker found. ${ctx.name || "Your agent"}'s shell commands will run sandboxed in Docker.`);
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_REQUIRE_DOCKER", "1");
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "HEADLONG_UNSANDBOXED", "0");
  const image = ctx.env["SHELLM_DOCKER_IMAGE"] || "ubuntu:latest";
  if (!ctx.w.dryRun && commandExists("docker", ctx.env)) {
    const inspect = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", env: ctx.env });
    if (inspect.status !== 0) {
      try {
        ctx.io.spawnDetached("docker", ["pull", image], { env: ctx.env, logFile: ctx.initLog });
      } catch {
        /* best effort, warms the cache only */
      }
    }
  }
}

function sandboxOff(ctx: GateCtx): void {
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "HEADLONG_UNSANDBOXED", "1");
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_REQUIRE_DOCKER", "0");
  ctx.io.stdout(
    `    Continuing without a sandbox. To turn it on later, install Docker, set HEADLONG_UNSANDBOXED=0 in ${ctx.headlongEnvFile}, and re-run headlong-init.\n`
  );
}

async function sandboxGate(ctx: GateCtx, p: Prompter): Promise<void> {
  if (ctx.inContainer) return;

  if (ctx.env["HEADLONG_UNSANDBOXED"] === "1") {
    ctx.io.stderr(
      `Warning: no Docker sandbox (HEADLONG_UNSANDBOXED=1). The agent's shell commands run directly on this machine. Set HEADLONG_UNSANDBOXED=0 in ${ctx.headlongEnvFile} and re-run headlong-init to turn the sandbox on.\n`
    );
    envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "HEADLONG_UNSANDBOXED", "1");
    envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_REQUIRE_DOCKER", "0");
    return;
  }

  const state = dockerState(ctx.env);
  if (state === "ok") {
    sandboxOn(ctx);
    return;
  }

  if (!p.hasTTY) {
    die(
      "no Docker daemon is reachable, so there is no sandbox for the agent's shell commands. Install and start Docker, or set HEADLONG_UNSANDBOXED=1 to accept the agent running directly on this machine."
    );
  }

  if (state === "down") {
    for (;;) {
      p.io.writeTty(
        "\nDocker is installed here, but the daemon is not answering, so there is no\nsandbox. Start Docker (Docker Desktop, colima, or systemctl start docker),\nthen press Enter to check again. `docker info` shows what is wrong.\n\n"
      );
      p.io.writeTty('Press Enter to re-check, or type "yes" to DANGEROUSLY run the agent unsandboxed on this machine: ');
      const reply = await p.io.readTtyLine();
      if (reply === undefined) die("no answer. Start Docker and re-run headlong-init.");
      if (reply === "yes") {
        sandboxOff(ctx);
        return;
      }
      if (dockerState(ctx.env) === "ok") {
        sandboxOn(ctx);
        return;
      }
    }
  }

  p.io.writeTty(
    "\nWARNING: Docker was not found on this machine, so there is no sandbox.\n\n" +
      "EVERY shell command your agent writes will run DIRECTLY ON THIS MACHINE,\nas your user, with access to your files. Headlong agents run continuously\nand unattended.\n\n" +
      "The safe path is to STOP NOW, install Docker (https://docs.docker.com/get-docker/),\nand re-run this installer. With Docker present, the agent's commands run\ninside a container automatically.\n\n"
  );
  p.io.writeTty('Type "yes" to DANGEROUSLY accept an unsandboxed agent on this machine (anything else stops): ');
  const reply = (await p.io.readTtyLine()) ?? "";
  if (reply === "yes") {
    sandboxOff(ctx);
    return;
  }
  die("stopped. Install Docker and re-run, or answer yes to run without a sandbox.");
}

// ---------------------------------------------------------------------------
// Model backend: cloud key vs local OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"] as const;
type KeyVar = (typeof KEY_VARS)[number];

function haveKey(env: Record<string, string>): boolean {
  return KEY_VARS.some((v) => Boolean(env[v]));
}

function keyVarFor(key: string): KeyVar | "" {
  if (key.startsWith("sk-ant-")) return "ANTHROPIC_API_KEY";
  if (key.startsWith("sk-or-")) return "OPENROUTER_API_KEY";
  if (key.startsWith("AIza")) return "GEMINI_API_KEY";
  if (key.startsWith("sk-")) return "OPENAI_API_KEY";
  return "";
}

function defaultModelFor(v: string): string {
  switch (v) {
    case "ANTHROPIC_API_KEY":
      return "claude-sonnet-4-5-20250929";
    case "OPENAI_API_KEY":
      return "gpt-5.5";
    case "GEMINI_API_KEY":
      return "gemini-3.5-flash";
    case "OPENROUTER_API_KEY":
      return "anthropic/claude-sonnet-4.5";
    case "OPENCODE_API_KEY":
      return "opencode-go/deepseek-v4-flash";
    default:
      return "";
  }
}

function keyVarUnambiguous(key: string): KeyVar | "" {
  if (key.startsWith("sk-ant-")) return "ANTHROPIC_API_KEY";
  if (key.startsWith("sk-or-")) return "OPENROUTER_API_KEY";
  if (key.startsWith("AIza")) return "GEMINI_API_KEY";
  return "";
}

/** `_reconcile_key_vars`: move a misfiled key to the variable its prefix implies. */
function reconcileKeyVars(
  ctx: GateCtx,
  persist: boolean,
  staged: { var: string; value: string }
): void {
  for (const v of KEY_VARS) {
    const val = ctx.env[v];
    if (!val) continue;
    const want = keyVarUnambiguous(val);
    if (!want || want === v) continue;
    if (ctx.env[want]) {
      if (ctx.env[want] !== val) {
        ctx.io.stderr(`headlong-init: warning: ${v} holds a ${want} key; ${want} is also set, using that one.\n`);
      }
      continue;
    }
    ctx.io.stderr(`headlong-init: warning: ${v} holds a key whose prefix belongs to ${want}; using it as ${want}.\n`);
    if (persist) {
      envSet(ctx.w, ctx.env, ctx.headlongEnvFile, want, val);
    } else {
      ctx.env[want] = val;
      staged.var = want;
      staged.value = val;
    }
    if (ctx.env["SHELLM_MODEL"] === defaultModelFor(v)) {
      if (persist) envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_MODEL", defaultModelFor(want));
      else ctx.env["SHELLM_MODEL"] = defaultModelFor(want);
    }
  }
}

function firstKeyVar(env: Record<string, string>): KeyVar | undefined {
  for (const v of KEY_VARS) {
    const val = env[v];
    if (!val) continue;
    const want = keyVarUnambiguous(val);
    if (!want || want === v) return v;
  }
  for (const v of KEY_VARS) {
    if (env[v]) return v;
  }
  return undefined;
}

function keyHint(k: string | undefined): string {
  if (!k || k.length < 20) return "(empty or short)";
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

async function llmOk(ctx: GateCtx, overrides: Record<string, string> = {}): Promise<boolean> {
  const env = { ...ctx.env, ...overrides };
  const chunks: string[] = [];
  const io: LlmIO = {
    cwd: process.cwd(),
    env,
    stdout: (s) => chunks.push(s),
    stderr: (s) => {
      try {
        fs.appendFileSync(ctx.initLog, s);
      } catch {
        /* best effort */
      }
    },
    readStdin: () => "",
    stdinIsTTY: false,
    now: () => ctx.io.now(),
    fetch: ctx.io.fetch,
    fs,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnAdapter: spawnAdapterProcess,
    randomToken: () => ctx.io.randomHex(6),
  };
  const code = await runLlm(["-t", "256", "Reply with the single word: ok"], io);
  return code === 0;
}

/** `_cloud_llm_ok`: mask a saved local provider so validation cannot reload it. */
function cloudLlmOk(ctx: GateCtx): Promise<boolean> {
  return llmOk(ctx, { LLM_PROVIDER: "", SHELLM_API_URL: "", LLM_API_URL: "", LLM_API_KEY: "" });
}

interface StagedKey {
  var: string;
  value: string;
}

/** `_prompt_key`: hidden-input key prompt, 5-try empty-input tolerance. */
async function promptKey(ctx: GateCtx, p: Prompter, persist: boolean, staged: StagedKey): Promise<boolean> {
  let key = "";
  let tries = 0;
  for (;;) {
    p.io.writeTty("Paste your API key (input hidden; Ctrl-C to quit): ");
    const reply = await p.io.readTtyLine({ hidden: true });
    p.io.writeTty("\n");
    if (reply === undefined) return false;
    key = reply.replace(/\s/g, "");
    if (key) break;
    tries += 1;
    if (tries >= 5) return false;
    p.io.writeTty("  Nothing entered. Paste the key and press Enter, or Ctrl-C to quit.\n");
    p.io.writeTty("  (If you meant to use a local model server instead, re-run and answer 'y'\n");
    p.io.writeTty("   at the 'Use a local model server?' prompt.)\n");
  }
  let v: string;
  if (key.startsWith("sk-") && !key.startsWith("sk-ant-") && !key.startsWith("sk-or-")) {
    const which = await ask(p, "Is that an OpenAI or an OpenCode key? (1) OpenAI (2) OpenCode", "1");
    v = which === "2" ? "OPENCODE_API_KEY" : "OPENAI_API_KEY";
  } else {
    const guess = keyVarFor(key);
    if (guess) {
      v = guess;
    } else {
      const which = await ask(p, "Which provider is that key for? (1) Anthropic (2) OpenAI (3) Gemini (4) OpenRouter (5) OpenCode", "1");
      v = which === "2" ? "OPENAI_API_KEY" : which === "3" ? "GEMINI_API_KEY" : which === "4" ? "OPENROUTER_API_KEY" : which === "5" ? "OPENCODE_API_KEY" : "ANTHROPIC_API_KEY";
    }
  }
  if (persist) {
    envSet(ctx.w, ctx.env, ctx.headlongEnvFile, v, key);
    envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_MODEL", defaultModelFor(v));
  } else {
    ctx.env[v] = key;
    ctx.env["SHELLM_MODEL"] = defaultModelFor(v);
    staged.var = v;
    staged.value = key;
  }
  return true;
}

// --- local (OpenAI-compatible) endpoint -------------------------------------

function localBaseUrl(url: string): string {
  let u = url.replace(/\/$/, "");
  u = u.replace(/\/chat\/completions$/, "");
  if (!/\/v1$/.test(u)) u = `${u}/v1`;
  return u;
}

function localChatUrl(url: string): string {
  return `${localBaseUrl(url)}/chat/completions`;
}

function localProbeUrl(url: string, inContainer: boolean): string {
  if (!inContainer && urlHost(url) === "host.docker.internal") return urlHostSwap(url, "localhost");
  return url;
}

function localContainerUrl(url: string): string {
  return urlIsLoopback(url) ? urlHostSwap(url, "host.docker.internal") : url;
}

interface ModelsResult {
  models: string[];
  err: string;
}

/** `_local_models_get`: GET `<base>/models`, optionally bearer-authed. */
async function localModelsGet(ctx: GateCtx, base: string, key: string): Promise<ModelsResult> {
  const safeUrl = urlSafeDisplay(base);
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  let res: Response;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      res = await ctx.io.fetch(`${base}/models`, { headers, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  } catch {
    return { models: [], err: `could not reach ${safeUrl}` };
  }
  if (!res.ok) {
    return { models: [], err: `${safeUrl}/models returned HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { models: [], err: `${safeUrl} did not return a model list (is it an OpenAI-compatible server?)` };
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return { models: [], err: `${safeUrl} did not return a model list (is it an OpenAI-compatible server?)` };
  }
  const models = data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
  return { models, err: "" };
}

/** `_pick_from_list`: numbered menu; empty keeps default, a number picks, else literal. */
async function pickFromList(p: Prompter, prompt: string, list: string[], def: string): Promise<string> {
  p.io.writeTty(`\n${prompt} — ${list.length} available:\n`);
  list.forEach((m, i) => {
    const tag = def && m === def ? "   (current)" : "";
    p.io.writeTty(`  ${String(i + 1).padStart(3)}) ${m}${tag}\n`);
  });
  for (;;) {
    p.io.writeTty(def ? `${prompt} [number, a name, or Enter for ${def}]: ` : `${prompt} [number or name]: `);
    const raw = (await p.io.readTtyLine()) ?? "";
    const reply = raw.replace(/\s/g, "");
    if (!reply) {
      if (def) return def;
      continue;
    }
    if (/^[0-9]+$/.test(reply)) {
      const idx = Number(reply) - 1;
      if (idx >= 0 && idx < list.length) return list[idx]!;
      p.io.writeTty(`  No such entry (1-${list.length}).\n`);
      continue;
    }
    return reply;
  }
}

const MODEL_ID_RE = /^[A-Za-z0-9._:/@-]+$/;

/** `_prompt_local_url`: loops until non-empty; the bracketed default is redacted, the returned value is not. */
async function promptLocalUrl(p: Prompter, def: string): Promise<string> {
  const prompt = "Server address as your agent will reach it (e.g. http://localhost:1234 or http://192.168.3.23:1234; /v1 is added if missing)";
  for (;;) {
    if (!p.hasTTY) return def;
    p.io.writeTty(def ? `${prompt} [${urlSafeDisplay(def)}]: ` : `${prompt}: `);
    const reply = (await p.io.readTtyLine()) ?? "";
    const url = reply || def;
    if (url) return url;
    def = "";
  }
}

/** `_setup_local_llm`. `hasDefaultIdentity` gates the no-questions-asked revalidation path. */
async function setupLocalLlm(ctx: GateCtx, p: Prompter, hasDefaultIdentity: boolean): Promise<void> {
  let urlEnv = ctx.env["HEADLONG_LOCAL_URL"] || ctx.env["SHELLM_API_URL"] || ctx.env["LLM_API_URL"] || "";
  let keyEnv = ctx.env["HEADLONG_LOCAL_API_KEY"] || "";
  const modelEnv0 = ctx.env["HEADLONG_LOCAL_MODEL"] || "";
  let modelEnv = modelEnv0;

  if (!ctx.env["HEADLONG_LOCAL_URL"] && ctx.env["LLM_PROVIDER"] === "openai-compatible") {
    if (!modelEnv) modelEnv = ctx.env["SHELLM_MODEL"] || "";
    if (!keyEnv) keyEnv = ctx.env["LLM_API_KEY"] || "";
  }

  if (ctx.inContainer) urlEnv = localContainerUrl(urlEnv);

  // Revalidate-without-asking: default identity exists, local provider is
  // already configured, and nothing in this run is trying to change it.
  const revalidating =
    hasDefaultIdentity &&
    Boolean(ctx.env["SHELLM_API_URL"]) &&
    ctx.env["LLM_PROVIDER"] === "openai-compatible" &&
    !ctx.env["HEADLONG_PROVIDER"] &&
    !ctx.env["HEADLONG_LOCAL_URL"] &&
    !ctx.env["HEADLONG_LOCAL_MODEL"] &&
    !ctx.env["HEADLONG_LOCAL_API_KEY"];

  if (revalidating) {
    info(ctx.io, `Checking the LLM connection (model: ${ctx.env["SHELLM_MODEL"]})`);
    const ok = await llmOk(ctx, { LLM_API_URL: localProbeUrl(ctx.env["SHELLM_API_URL"]!, ctx.inContainer) });
    if (ok) ctx.io.stdout(`    OK — ${ctx.env["SHELLM_MODEL"]} answered.\n`);
    else ctx.io.stderr("headlong-init: warning: the existing local model server did not answer; keeping its configuration\n");
    return;
  }

  if (p.hasTTY) {
    p.io.writeTty(
      "\nLocal model server (Ollama, LM Studio, vLLM, llama.cpp, ...). Headlong\ntalks to it through its OpenAI-compatible chat API; no cloud API key is\nneeded, and the agent's completions all stay on this machine or your\nnetwork. The server must already be running — Headlong never installs\none or pulls models.\n\n"
    );
  }

  let base = "";
  let key = keyEnv;
  let models: string[] = [];

  if (!p.hasTTY) {
    if (!urlEnv) die("local provider selected with no URL. Set HEADLONG_LOCAL_URL (e.g. http://localhost:11434)");
    base = localBaseUrl(localProbeUrl(urlEnv, ctx.inContainer));
    const r = await localModelsGet(ctx, base, key);
    if (r.err) {
      if (r.err.startsWith("could not reach")) die(`local endpoint unreachable: ${r.err}. Start the server and re-run headlong-init.`);
      ctx.io.stderr(`headlong-init: warning: could not list models: ${r.err}\n`);
      ctx.io.stderr("headlong-init: continuing with the given URL — set HEADLONG_LOCAL_MODEL if the model name is not already pinned\n");
    }
    models = r.models;
  } else {
    let defUrl = urlEnv || "http://localhost:1234";
    for (;;) {
      urlEnv = await promptLocalUrl(p, defUrl);
      if (ctx.inContainer) urlEnv = localContainerUrl(urlEnv);
      base = localBaseUrl(localProbeUrl(urlEnv, ctx.inContainer));
      if (!key) {
        p.io.writeTty("API key for the server, if it wants one (Enter for none; input hidden): ");
        const reply = (await p.io.readTtyLine({ hidden: true })) ?? "";
        p.io.writeTty("\n");
        key = reply.replace(/\s/g, "");
      }
      const r = await localModelsGet(ctx, base, key);
      if (!r.err) {
        models = r.models;
        break;
      }
      p.io.writeTty(`  Could not list models: ${r.err}\n`);
      if (!r.err.startsWith("could not reach")) {
        p.io.writeTty("  The server answered, so you can type a model name instead.\n");
        break;
      }
      if (!(await askYn(p, "Try a different URL/key?"))) {
        die("local endpoint unreachable. Start the server and re-run headlong-init.");
      }
      defUrl = urlEnv;
      key = "";
    }
  }

  let chosen: string;
  if (models.length > 0) {
    chosen = p.hasTTY ? await pickFromList(p, "Model to run your agent on", models, modelEnv) : modelEnv || models[0]!;
  } else {
    chosen = modelEnv;
    if (!chosen) {
      if (p.hasTTY) {
        chosen = await ask(p, "The server did not expose a model list. Type the model name to use");
        if (!chosen) die("no model given");
      } else {
        die("no model: the server exposed no model list. Set HEADLONG_LOCAL_MODEL.");
      }
    }
  }
  if (!chosen) die("no model selected");
  if (!MODEL_ID_RE.test(chosen)) {
    die(`model id '${chosen}' contains characters headlong will not store (allowed: letters, digits, . _ : / @ -)`);
  }

  let chat = localChatUrl(urlEnv);
  if (ctx.inContainer && urlIsLoopback(chat)) {
    const containerChat = localContainerUrl(chat);
    ctx.io.stdout(`    Container install: the agent reaches the server at ${urlSafeDisplay(containerChat)} (was ${urlSafeDisplay(chat)}).\n`);
    chat = containerChat;
  }

  info(ctx.io, `Checking the LLM connection (model: ${chosen} at ${urlSafeDisplay(base)})`);
  const ok = await llmOk(ctx, {
    LLM_PROVIDER: "openai-compatible",
    SHELLM_MODEL: chosen,
    LLM_API_KEY: key,
    LLM_API_URL: localProbeUrl(chat, ctx.inContainer),
  });
  if (!ok) die(`the endpoint did not answer a chat completion (models list worked, chat did not); nothing was saved. Details: ${ctx.initLog}`);
  ctx.io.stdout(`    OK — ${chosen} answered.\n`);

  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "LLM_PROVIDER", "openai-compatible");
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_API_URL", chat);
  if (key) envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "LLM_API_KEY", key);
  else envUnset(ctx.w, ctx.env, ctx.headlongEnvFile, "LLM_API_KEY");
  envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_MODEL", chosen);

  if (!ctx.inContainer && urlIsLoopback(chat)) {
    ctx.io.stdout("    Note: sandboxed agent code reaches this server through Docker's host\n");
    ctx.io.stdout("    gateway, which can also reach other services bound to this machine's\n");
    ctx.io.stdout("    loopback. See docs/install.md (local model server) for details.\n");
  }
}

/** `_ask_local_or_cloud`: true = local, false = cloud. */
async function askLocalOrCloud(ctx: GateCtx, p: Prompter): Promise<boolean> {
  if (ctx.env["HEADLONG_PROVIDER"] === "local") return true;
  if (ctx.env["HEADLONG_PROVIDER"] === "cloud") return false;
  if ((ctx.env["SHELLM_API_URL"] || ctx.env["LLM_API_URL"]) && ctx.env["LLM_PROVIDER"] === "openai-compatible") return true;
  if (haveKey(ctx.env)) return false;
  if (!p.hasTTY) return false;
  return askYn(p, "Use a local model server (Ollama, LM Studio, vLLM; no API key)?", "n");
}

/** `_commit_local_wipe`. */
function commitLocalWipe(ctx: GateCtx, staged: StagedKey): void {
  const keepModel = ctx.env["SHELLM_MODEL"] || "";
  for (const v of ["LLM_PROVIDER", "SHELLM_API_URL", "LLM_API_URL", "LLM_API_KEY", "SHELLM_MODEL"]) {
    envUnset(ctx.w, ctx.env, ctx.headlongEnvFile, v);
  }
  if (staged.var) envSet(ctx.w, ctx.env, ctx.headlongEnvFile, staged.var, staged.value);
  if (keepModel) envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_MODEL", keepModel);
}

/** `_ensure_api_key`. */
async function ensureApiKey(ctx: GateCtx, p: Prompter, hasDefaultIdentity: boolean): Promise<void> {
  const switchingFromLocal = ctx.env["HEADLONG_PROVIDER"] === "cloud" && ctx.env["LLM_PROVIDER"] === "openai-compatible";
  const staged: StagedKey = { var: "", value: "" };
  reconcileKeyVars(ctx, !switchingFromLocal, staged);

  if (await askLocalOrCloud(ctx, p)) {
    await setupLocalLlm(ctx, p, hasDefaultIdentity);
    return;
  }

  if (switchingFromLocal) {
    for (const v of ["LLM_PROVIDER", "SHELLM_API_URL", "LLM_API_URL", "LLM_API_KEY", "SHELLM_MODEL"]) delete ctx.env[v];
  }

  if (!haveKey(ctx.env) && !p.hasTTY) {
    die("no API key found. Set ANTHROPIC_API_KEY (or OPENAI/GEMINI/OPENROUTER/OPENCODE_API_KEY), or put it in " + ctx.headlongEnvFile);
  }
  if (!haveKey(ctx.env)) {
    p.io.writeTty(
      "\nHeadlong needs an LLM API key (Anthropic, OpenAI, Gemini, OpenRouter, or OpenCode).\nPaste just the key itself; headlong-init figures out the provider from it.\n\n" +
        "  * Use a DEDICATED, SPEND-CAPPED key. The agent you're about to create\n    runs continuously and executes shell commands.\n" +
        "  * Cost: with the default model (Claude Sonnet 4.5) expect roughly $1–2\n    an hour while it runs, about $25–50 a day; more if you talk to it a lot.\n" +
        "  * Pause it any time with `ada stop` (using whatever name you pick); a\n    paused agent spends nothing. Resume with `ada start`.\n" +
        "  * If the key runs out of credit, `ada status` and the dash say so.\n\n"
    );
    if (!(await promptKey(ctx, p, !switchingFromLocal, staged))) die("no key entered (quit)");
  }

  if (!ctx.env["SHELLM_MODEL"]) {
    const model = defaultModelFor(firstKeyVar(ctx.env) ?? "");
    if (switchingFromLocal) ctx.env["SHELLM_MODEL"] = model;
    else envSet(ctx.w, ctx.env, ctx.headlongEnvFile, "SHELLM_MODEL", model);
  }

  const revalidating = !switchingFromLocal && hasDefaultIdentity;

  for (let attempt = 0; attempt < 3; attempt++) {
    info(ctx.io, `Checking the LLM connection (model: ${ctx.env["SHELLM_MODEL"]})`);
    const ok = switchingFromLocal ? await cloudLlmOk(ctx) : await llmOk(ctx);
    if (ok) {
      ctx.io.stdout(`    OK — ${ctx.env["SHELLM_MODEL"]} answered.\n`);
      if (switchingFromLocal) commitLocalWipe(ctx, staged);
      return;
    }
    const v = firstKeyVar(ctx.env);
    ctx.io.stderr(
      `    FAILED — ${v ?? "the key"} (${keyHint(v ? ctx.env[v] : undefined)}) did not get a reply from ${ctx.env["SHELLM_MODEL"]}.\n` +
        `    The key may be mistyped, for another provider, or out of credit.\n` +
        `    Details: ${ctx.initLog}\n`
    );
    if (revalidating) continue;
    if (!p.hasTTY) die("LLM check failed with the configured key");
    ctx.io.stderr("\nPaste a different key to try again, or press Ctrl-C to quit.\n");
    if (!(await promptKey(ctx, p, !switchingFromLocal, staged))) die("no key entered (quit)");
  }
  if (revalidating && !switchingFromLocal) {
    ctx.io.stderr("headlong-init: continuing anyway — this key worked before, so the API may just be having a moment\n");
    return;
  }
  die("could not validate an API key after 3 attempts");
}

// ---------------------------------------------------------------------------
// Identity interview + creation
// ---------------------------------------------------------------------------

const DEFAULT_VIBE = "curious, warm, and plainspoken";
const DEFAULT_FOCUS = "learning how their own mind works, and getting to know the machine and the person they live with";

export interface IdentityAnswers {
  name: string;
  vibe: string;
  focus: string;
  operatorName: string;
  userNote: string;
}

function operatorBlurb(a: IdentityAnswers): string {
  if (a.operatorName && a.userNote) return `${a.operatorName}. ${a.userNote}`;
  if (a.operatorName) return `Their name is ${a.operatorName}.`;
  return a.userNote;
}

async function interview(p: Prompter, a: IdentityAnswers, identityExists: (name: string) => boolean): Promise<void> {
  if (!p.hasTTY) return;
  p.io.writeTty(
    "\nTime to launch your Headlong agent. It starts with a baseline personality;\nanswer as much or as little as you like (Enter keeps the default).\n\n"
  );
  for (;;) {
    const name = await ask(p, "  Their name (lowercase letters, digits, hyphens)", a.name || "ada");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      p.io.writeTty("Names are lowercase alphanumeric + hyphens (e.g. ada, mr-robot).\n");
      a.name = "";
      continue;
    }
    if (name === "persona" || name === "default") {
      p.io.writeTty(`'${name}' is reserved — pick another name.\n`);
      a.name = "";
      continue;
    }
    a.name = name;
    break;
  }
  a.vibe = await ask(p, "  A few words on their personality", a.vibe);
  a.focus = await ask(p, `  What should ${a.name} think about when idle`, a.focus);
  p.io.writeTty(`\nAnd about you, so ${a.name} knows who they are talking to (both optional):\n\n`);
  a.operatorName = await ask(p, "  Your name", a.operatorName);
  a.userNote = await ask(p, `  Anything else ${a.name} should know about you? (what you're up to, how they can help)`, a.userNote);
  p.io.writeTty("\n");
  void identityExists;
}

function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function localTimestamp(d: Date, sep: string): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}${sep}${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

function writeMemory(io: InitIO, memDir: string, mtype: string, summary: string, body: string): void {
  const id = io.randomHex(4);
  const slug = slugify(summary);
  const now = io.now();
  const fname = path.join(memDir, `${localTimestamp(now, "-")}_${id}_${slug}.md`);
  const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(fname, `---\nid: ${id}\nsummary: ${summary}\ntype: ${mtype}\ncreated: ${created}\n---\n\n${body}\n`);
}

/** `_write_persona`: LLM rewrite of the starter template, falling back to placeholder substitution. */
async function writePersona(ctx: GateCtx, identityDir: string, a: IdentityAnswers): Promise<void> {
  const templatePath = path.join(PORT_SRC_DIR, "assets", "identities", "starter-persona.md");
  const template = fs.readFileSync(templatePath, "utf8");
  info(ctx.io, `Writing ${a.name}'s core identity`);

  const system =
    "You write core identity prompts for Headlong virtual people. Output ONLY the final markdown document — no code fences, no commentary. Write in first person. Refer to the person exclusively by the literal placeholder {{identity_name}} (it is substituted at runtime — never write their actual name).";
  const blurb = operatorBlurb(a) || "nothing shared";
  const user = `Rewrite this baseline core identity into a specific one, keeping its structure and every capability reference (chat reply, learn, recall, goals, idle-as-rest) intact:\n\n${template}\n\nThe operator answered a short interview about who this person should be:\n- Name (do NOT write it in the document; use {{identity_name}}): ${a.name}\n- Personality: ${a.vibe}\n- What they think about when idle: ${a.focus}\n- About the operator: ${blurb}\n  (if empty: nothing shared)\n\nWeave the answers in naturally so the personality shows in the writing voice itself, replace the {{...}} placeholders other than {{identity_name}}, and keep it to roughly the template's length.`;

  const chunks: string[] = [];
  const io: LlmIO = {
    cwd: process.cwd(),
    env: ctx.env,
    stdout: (s) => chunks.push(s),
    stderr: (s) => {
      try {
        fs.appendFileSync(ctx.initLog, s);
      } catch {
        /* best effort */
      }
    },
    readStdin: () => "",
    stdinIsTTY: false,
    now: () => ctx.io.now(),
    fetch: ctx.io.fetch,
    fs,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnAdapter: spawnAdapterProcess,
    randomToken: () => ctx.io.randomHex(6),
  };
  let persona = "";
  try {
    const code = await runLlm(["-t", "3000", "-s", system, user], io);
    if (code === 0) persona = chunks.join("");
  } catch {
    persona = "";
  }
  persona = persona
    .split("\n")
    .filter((l) => !l.startsWith("```"))
    .join("\n");

  const outPath = path.join(identityDir, "core_identity_prompt.md");
  if ((persona.match(/\{\{identity_name\}\}/g) ?? []).length >= 1 && persona.split("\n").length >= 8) {
    fs.writeFileSync(outPath, `${persona}\n`);
  } else {
    ctx.io.stderr("headlong-init: LLM persona generation failed; using the starter template\n");
    let fallback = template.replaceAll("{{vibe}}", a.vibe).replaceAll("{{focus}}", a.focus);
    fs.writeFileSync(outPath, fallback);
    const blurb2 = operatorBlurb(a);
    if (blurb2) fs.appendFileSync(outPath, `\nAbout my operator: ${blurb2}\n`);
  }
}

/** `_create_identity`. */
async function createIdentity(ctx: GateCtx, p: Prompter, identityRoot: string, a: IdentityAnswers): Promise<void> {
  if (a.name && fs.existsSync(path.join(identityRoot, a.name))) {
    info(ctx.io, `Identity '${a.name}' already exists — leaving it as is`);
    return;
  }
  await interview(p, a, (name) => fs.existsSync(path.join(identityRoot, name)));
  a.name = a.name || "ada";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(a.name)) die(`invalid identity name: '${a.name}'`);
  if (a.name === "persona" || a.name === "default") die(`'${a.name}' is a reserved name`);
  if (fs.existsSync(path.join(identityRoot, a.name))) {
    info(ctx.io, `Identity '${a.name}' already exists — leaving it as is`);
    return;
  }

  info(ctx.io, `Creating identity '${a.name}'`);
  fs.mkdirSync(identityRoot, { recursive: true });
  const result = identityNew({ identitiesRoot: identityRoot, name: a.name, setDefault: true, now: () => ctx.io.now() });

  await writePersona(ctx, result.identityDir, a);

  const memDir = path.join(result.identityDir, "memories");
  writeMemory(ctx.io, memDir, "value", `I am ${a.vibe}`, `I am ${a.vibe}. This is who I am at baseline — how I think and how I talk.`);
  writeMemory(
    ctx.io,
    memDir,
    "value",
    `When idle I think about ${a.focus}`,
    `When I have nothing pressing, I think about ${a.focus}. Idle time is for thinking, not dormancy.`
  );
  const blurb = operatorBlurb(a);
  if (blurb) {
    writeMemory(
      ctx.io,
      memDir,
      "fact",
      `About my operator${a.operatorName ? `, ${a.operatorName}` : ""}`,
      `My operator told me about themselves when I was created: ${blurb}`
    );
  }

  fs.writeFileSync(
    path.join(result.identityDir, "bootstrap-answers.txt"),
    `name=${a.name}\nvibe=${a.vibe}\nfocus=${a.focus}\noperator_name=${a.operatorName}\nuser_note=${a.userNote}\n`
  );

  const chatDir = path.join(result.identityDir, "chat");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, ".chatrc"), "default_send_from=operator\n");
}

/** `_link_persona_command`: no-op — this port ships no bin/persona (see file header). */
function linkPersonaCommand(ctx: GateCtx, appDir: string): void {
  const target = path.join(appDir, "bin", "persona");
  if (!fs.existsSync(target)) return; // matches upstream's own guard; always true here
  const link = path.join(appDir, "bin", ctx.name);
  if (fs.existsSync(link) || isSymlink(link)) return;
  fs.symlinkSync(target, link);
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Life: thinkers + dash
// ---------------------------------------------------------------------------

async function startThinkers(ctx: GateCtx, appDir: string, identityRoot: string, name: string): Promise<void> {
  if (ctx.env["HEADLONG_NO_THINKERS"] === "1") {
    info(ctx.io, "Skipping thinkers (HEADLONG_NO_THINKERS=1)");
    return;
  }
  info(ctx.io, `Starting ${name}'s mind (monolith + responder thinkers)`);
  const identityDir = path.join(identityRoot, name);
  const idEnv = resolveIdentityEnv(identityDir, { base: ctx.env, headlongHome: path.dirname(ctx.headlongEnvFile) });
  if (!idEnv["IDENTITY_NAME"]) die("headlong-init: activate did not set IDENTITY_NAME");
  try {
    await thinkersStop(idEnv, [], { self: true });
  } catch {
    /* best effort, matches `|| true` */
  }
  await thinkersStart(idEnv, ["monolith", "responder"], { stderr: () => {} });
  void appDir;
}

interface DashResult {
  status: "ok" | "failed" | "skipped";
  url: string;
}

function dashDepsReady(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, "web", "viewer", "node_modules"));
}

async function ensureDashDeps(ctx: GateCtx, p: Prompter, appDir: string): Promise<boolean> {
  if (dashDepsReady(appDir)) return true;
  const ok = await confirmInstall(p, ctx.inContainer, "The dash needs the web viewer's dependencies installed (npm install). Install them now?");
  if (!ok) {
    ctx.io.stderr("headlong-init: web dependencies not installed — skipping the dash (run `npm install` in web/ and web/viewer, then re-run headlong-init)\n");
    return false;
  }
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], {
    cwd: path.join(appDir, "web", "viewer"),
    stdio: "ignore",
    env: ctx.env,
  });
  if (r.status !== 0) {
    ctx.io.stderr("headlong-init: npm install failed — skipping the dash\n");
    return false;
  }
  return true;
}

async function startDash(ctx: GateCtx, p: Prompter, appDir: string, headlongHome: string): Promise<DashResult> {
  if (ctx.env["HEADLONG_NO_DASH"] === "1") {
    info(ctx.io, "Skipping the dash (HEADLONG_NO_DASH=1)");
    return { status: "skipped", url: "" };
  }
  if (!(await ensureDashDeps(ctx, p, appDir))) return { status: "failed", url: "" };

  const logFile = path.join(headlongHome, "logs", "web.log");
  const pidFile = path.join(headlongHome, "run", "web.pid");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  const existingPid = readPidFile(pidFile);
  if (existingPid !== undefined && ctx.io.isAlive(existingPid)) {
    const url = readDashUrl(logFile);
    info(ctx.io, `Dash already running${url ? ` at ${url}` : ""}`);
    return { status: "ok", url };
  }

  info(ctx.io, "Starting the dash");
  fs.writeFileSync(logFile, "");
  const args = [path.join(appDir, "web", "scripts", "dev.mjs")];
  const extra = ctx.env["HEADLONG_WEB_ARGS"] ? ctx.env["HEADLONG_WEB_ARGS"].split(/\s+/).filter(Boolean) : [];
  const pid = ctx.io.spawnDetached(ctx.io.execPath, [...args, ...extra], { cwd: appDir, env: ctx.env, logFile });
  fs.writeFileSync(pidFile, `${pid}\n`);

  for (let i = 0; i < 300; i++) {
    const text = safeRead(logFile);
    if (/\[dev\] viewer\s*:/.test(text)) {
      return { status: "ok", url: readDashUrl(logFile) };
    }
    if (!ctx.io.isAlive(pid)) {
      ctx.io.stderr(`headlong-init: the dash failed to start — tail of ${logFile}:\n`);
      ctx.io.stderr(text.split("\n").slice(-20).join("\n"));
      return { status: "failed", url: "" };
    }
    await sleep(1000);
  }
  ctx.io.stderr(`headlong-init: the dash didn't come up within 5 minutes; check ${logFile}\n`);
  return { status: "failed", url: "" };
}

function readDashUrl(logFile: string): string {
  const text = safeRead(logFile);
  const m = /\[dev\] viewer\s*:\s*(http:\/\/\S+)/.exec(text);
  return m ? m[1]! : "";
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function readPidFile(p: string): number | undefined {
  const text = safeRead(p).trim();
  const n = Number(text);
  return text && Number.isFinite(n) ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitDashReady(ctx: GateCtx, url: string): Promise<void> {
  if (!url) return;
  for (let i = 0; i < 60; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      const res = await ctx.io.fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (res.ok || res.status < 500) return;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface RunInitOptions {
  argv: string[];
  env: Record<string, string>;
  io: InitIO;
}

export async function runHeadlongInit(opts: RunInitOptions): Promise<number> {
  const { argv, env, io } = opts;
  try {
    return await runHeadlongInitInner(argv, env, io);
  } catch (err) {
    if (err instanceof InitError) {
      io.stderr(`headlong-init: error: ${err.message}\n`);
      return err.code;
    }
    io.stderr(`headlong-init: error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runHeadlongInitInner(argv: string[], env: Record<string, string>, io: InitIO): Promise<number> {
  let dryRun = false;
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    io.stdout(HELP_TEXT);
    return 0;
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg !== undefined) {
    die(`unknown option: ${arg} (try --help)`);
  }

  const headlongHome = env["HEADLONG_HOME"] || path.join(env["HOME"] || os.homedir(), ".headlong");
  fs.mkdirSync(path.join(headlongHome, "logs"), { recursive: true });
  fs.mkdirSync(path.join(headlongHome, "run"), { recursive: true });
  const initLog = path.join(headlongHome, "logs", "init.log");
  const headlongEnvFile = path.join(headlongHome, ".env");

  const appDir = resolveAppDir(env, headlongHome);
  const binDir = path.join(appDir, "bin");
  env["PATH"] = [binDir, path.join(appDir, "tools"), env["PATH"] ?? ""].filter(Boolean).join(path.delimiter);

  let hasTTY = io.hasTTY();
  if (env["HEADLONG_NO_TTY"] === "1") hasTTY = false;
  const p: Prompter = { hasTTY, io };

  let inContainer = process.env["HEADLONG_ASSUME_HOST"] !== "1" && (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"));
  if (env["HEADLONG_FAKE_CONTAINER"] === "1") inContainer = true;
  if (inContainer && !env["HEADLONG_WEB_ARGS"]) env["HEADLONG_WEB_ARGS"] = "--host 0.0.0.0";

  loadEnvFillMissing(path.join(appDir, ".env"), env);
  loadEnvFillMissing(headlongEnvFile, env);

  const identityRoot = path.join(appDir, ".identities");
  let name = env["HEADLONG_IDENTITY_NAME"] || "";
  if (!name && isSymlink(path.join(identityRoot, "default"))) {
    try {
      name = path.basename(fs.readlinkSync(path.join(identityRoot, "default")));
    } catch {
      /* ignore */
    }
  }

  const gateCtx: GateCtx = {
    io,
    w: { dryRun, io },
    env,
    headlongEnvFile,
    initLog,
    inContainer,
    name,
  };

  await sandboxGate(gateCtx, p);
  if (dryRun) {
    info(io, "Dry run: stopping here. Nothing was written and nothing was started.");
    return 0;
  }

  const hasDefaultIdentity = isSymlink(path.join(identityRoot, "default"));
  await ensureApiKey(gateCtx, p, hasDefaultIdentity);

  const answers: IdentityAnswers = {
    name,
    vibe: env["HEADLONG_IDENTITY_VIBE"] || DEFAULT_VIBE,
    focus: env["HEADLONG_IDENTITY_FOCUS"] || DEFAULT_FOCUS,
    operatorName: env["HEADLONG_OPERATOR_NAME"] || "",
    userNote: env["HEADLONG_IDENTITY_USER"] || "",
  };
  await createIdentity(gateCtx, p, identityRoot, answers);
  gateCtx.name = answers.name;
  linkPersonaCommand(gateCtx, appDir);
  await startThinkers(gateCtx, appDir, identityRoot, answers.name);
  const dash = await startDash(gateCtx, p, appDir, headlongHome);
  if (dash.url) {
    await waitDashReady(gateCtx, dash.url);
    io.openUrl(dash.url);
  }

  writeStatusJson(gateCtx, appDir, identityRoot, answers.name, headlongHome, dash);
  printSummary(gateCtx, appDir, identityRoot, answers.name, headlongHome, dash);
  return 0;
}

function writeStatusJson(
  ctx: GateCtx,
  appDir: string,
  identityRoot: string,
  name: string,
  headlongHome: string,
  dash: DashResult
): void {
  const dispatcherPidFile = path.join(identityRoot, name, "run", "dispatcher.pid");
  const dispatcherPid = readPidFile(dispatcherPidFile);
  const mindOk = dispatcherPid !== undefined && ctx.io.isAlive(dispatcherPid);
  const mindStatus = ctx.env["HEADLONG_NO_THINKERS"] === "1" ? "skipped" : mindOk ? "ok" : "failed";
  const status = {
    identity: name,
    persona_command: `persona ${name}`,
    app_dir: appDir,
    model: ctx.env["SHELLM_MODEL"] || "",
    mind: { status: mindStatus, pid_file: dispatcherPidFile },
    dash: { status: dash.status, url: dash.url ? dash.url.replace("0.0.0.0", "localhost") : null, pid_file: path.join(headlongHome, "run", "web.pid") },
    container: ctx.inContainer,
    logs_dir: path.join(headlongHome, "logs"),
    updated: ctx.io.now().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  try {
    fs.writeFileSync(path.join(headlongHome, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    /* best effort, matches `|| true` */
  }
}

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function printSummary(
  ctx: GateCtx,
  appDir: string,
  identityRoot: string,
  name: string,
  headlongHome: string,
  dash: DashResult
): void {
  const home = ctx.env["HOME"] || os.homedir();
  const row = (label: string, desc: string) => ctx.io.stdout(`  ${tilde(label, home).padEnd(32)} ${desc}\n`);
  const personaCmd = `persona ${name}`;
  const personaPath = `${path.join(appDir, "bin")}/persona ${name}`;

  let dashDisplay = dash.url;
  if (ctx.inContainer && dash.url) dashDisplay = `${dash.url.replace("0.0.0.0", "localhost")} (in the browser on your host)`;

  ctx.io.stdout(`\n────────────────────────────────────────────────────────\n${name} is running.\n────────────────────────────────────────────────────────\n\nWhat was installed\n`);
  row(headlongHome, "state home: .env (your API key), logs/, status.json");
  row(appDir, "the Headlong-TS checkout");
  row(path.join(identityRoot, name), `${name}: persona, memories, trajectory`);
  row(path.join(appDir, "bin"), "the tools");
  ctx.io.stdout(
    `\nCommands\n` +
      `  Watch their mind     ${dashDisplay || `${personaCmd} dash`}\n` +
      `  Chat with them       ${personaCmd}          (or one-shot: ${personaCmd} "hello there")\n` +
      `  Pause / resume       ${personaCmd} stop  /  ${personaCmd} start\n` +
      `  Something broken?    ${personaCmd} bugreport   (bundle to attach to a report)\n` +
      `  Everything else      ${personaCmd} --help\n` +
      `  Not on PATH yet?     ${personaPath}\n` +
      `  Read-only status     node status.mjs   (from the checkout)\n` +
      `  Uninstall            node uninstall.mjs   (from the checkout)\n`
  );
}

const HELP_TEXT = `headlong-init — bootstrap a first identity and start its life.

Idempotent: safe to re-run any time. Creates only what's missing:
  ~/.headlong/.env                   API key + default model
  <app>/.identities/<name>/          the identity (persona, memories, ...)
then starts the monolith thinker and the local web dash, and opens the dash
so you can watch the mind spin.

Interactive prompts read from /dev/tty, so this works under \`curl | node\`.
With no tty everything falls back to defaults / environment:
  HEADLONG_UNSANDBOXED=1   accept an agent whose shell commands run directly
                         on this machine when Docker is not available
  HEADLONG_APP_DIR         path to the headlong-ts checkout (auto-detected)
  HEADLONG_IDENTITY_NAME   identity name (default: ada)
  HEADLONG_IDENTITY_VIBE   personality, a few words
  HEADLONG_IDENTITY_FOCUS  what to think about when idle
  HEADLONG_OPERATOR_NAME   your name (the operator)
  HEADLONG_IDENTITY_USER   a note about you, the operator
  HEADLONG_NO_THINKERS=1   don't start the monolith thinker
  HEADLONG_NO_DASH=1       don't start the web dash
  HEADLONG_WEB_ARGS        extra args for the dash dev server
  HEADLONG_PROVIDER        "cloud" (default: pick a provider from an API
                         key) or "local" (OpenAI-compatible endpoint: ask
                         for a URL + optional key, verify with /v1/models,
                         pick the model from that list)
  HEADLONG_LOCAL_URL       endpoint for the local provider (skips the URL
                         prompt; e.g. http://localhost:11434/v1)
  HEADLONG_LOCAL_API_KEY   bearer token for the local endpoint, when it
                         wants one (LM Studio and router proxies often do)
  HEADLONG_LOCAL_MODEL     model to pin (skips the model-picker prompt)

--dry-run walks the Docker sandbox gate interactively, writes nothing,
starts nothing, and exits. Pair with HEADLONG_FAKE_DOCKER=ok|down|missing
and HEADLONG_NO_TTY=1 to rehearse each path.

Writes status.json in the state home at the end: identity, model, mind/dash
status ("ok" | "failed" | "skipped"), dash URL, pid file paths.
`;
