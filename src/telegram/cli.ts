// cli.ts — run the Telegram bridge for a headlong identity.
// Faithful port of headlong_telegram.cli (Python `main()`) PLUS the
// local-dev parts of the upstream Bash launcher (tools/headlong-telegram-bridge):
// loading `.env` files so the bot token can live in a file instead of the
// calling shell, "whatever is already exported wins". The launcher's
// checkout-root discovery and `uv run --project telegram …` exec are
// upstream-repo-layout-specific and have no analogue in this single-repo
// port; not replicated — see PARITY.md.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BridgeExit } from "./errors.ts";
import * as config from "./config.ts";
import { Bot } from "./api.ts";
import { Allowlist } from "./allowlist.ts";
import { Inbound } from "./inbound.ts";
import * as outbound from "./outbound.ts";
import { redact } from "./logging.ts";

const USAGE = `usage: headlong-telegram-bridge [-h] [--verbose] [root]

Run the Telegram bridge for a shellm identity.

ROOT is the directory the web server serves (contains .identities/);
defaults to the current directory. Configuration comes from the
environment (TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID, HEADLONG_TELEGRAM_IDENTITY, …).

positional arguments:
  root        Serve root (contains .identities/) (default: .)

options:
  -h, --help  show this help message and exit
  --verbose   Debug logging
`;

/**
 * `_load_env` (tools/headlong-telegram-bridge): fill env vars from a
 * `KEY=value` file, only where not already set in `env` — "whatever is
 * already exported wins", so a root-owned production env file (which never
 * goes through this path) always stays authoritative where it exists.
 */
function loadEnvFile(envfile: string, env: NodeJS.ProcessEnv): void {
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
    if (env[key] !== undefined) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

export interface CliIO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface RunCliOptions {
  /** Checked by both the inbound poll loop and the outbound follow loop;
   *  defaults to "never stop" (blocks forever), matching Python's `main()`. */
  shouldStop?: () => boolean;
}

type ParsedArgs = { help: true } | { error: string } | { root: string; verbose: boolean };

function parseArgs(argv: string[]): ParsedArgs {
  let root = ".";
  let rootSet = false;
  let verbose = false;
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--verbose") {
      verbose = true;
      continue;
    }
    if (!rootSet) {
      root = a;
      rootSet = true;
      continue;
    }
    return { error: `unrecognized arguments: ${a}` };
  }
  return { root, verbose };
}

/** Runs the bridge. Returns the process exit code; only returns at all when
 *  `opts.shouldStop` eventually reports true (tests) or an error path exits
 *  early — the real CLI blocks forever, like the Python `main()`. */
export async function runCli(argv: string[], rawIo: CliIO, opts: RunCliOptions = {}): Promise<number> {
  // PORT-NOTE (1c: 44fe2f4): every stderr write goes through redact() so a
  // bot-token-shaped substring can never reach the bridge's own log output.
  // See logging.ts's header comment for why this port has no httpx-style
  // per-request chatter to silence in the first place.
  const io: CliIO = { ...rawIo, stderr: (s: string) => rawIo.stderr(redact(s)) };
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    io.stdout(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    io.stderr(`headlong-telegram-bridge: error: ${parsed.error}\n`);
    return 2;
  }

  const env: NodeJS.ProcessEnv = { ...io.env };
  // Local-dev convenience (Bash launcher): load the checkout's .env, then
  // $HEADLONG_HOME/.env (legacy $SHELLM_HOME honored too), so the token can
  // live in a file instead of the calling shell. Anything already exported
  // wins. The production systemd unit never goes through this file at all.
  loadEnvFile(path.join(io.cwd, ".env"), env);
  const headlongHome = env.HEADLONG_HOME || env.SHELLM_HOME || path.join(os.homedir(), ".headlong");
  loadEnvFile(path.join(headlongHome, ".env"), env);

  const serveRoot = path.resolve(io.cwd, parsed.root);
  let isDir = false;
  try {
    isDir = fs.statSync(serveRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    io.stderr(`Not a directory: ${serveRoot}\n`);
    return 1;
  }

  let cfg: config.Config;
  try {
    cfg = config.load(serveRoot, env);
  } catch (err) {
    if (err instanceof BridgeExit) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const bot = new Bot(cfg.botToken);
  let me: Record<string, unknown>;
  try {
    me = await bot.getMe();
  } catch (err) {
    io.stderr(`headlong-telegram-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stderr(
    `headlong-telegram-bridge: identity=${cfg.identity} bot=@${String(me.username ?? "")} ` +
      `admin=${cfg.adminId} web=${cfg.webUrl}\n`,
  );

  const allowlist = new Allowlist(path.join(cfg.stateDir, "allowlist.json"));
  if (!allowlist.isApproved(cfg.adminId)) allowlist.approve(cfg.adminId, "admin");

  const shouldStop = opts.shouldStop ?? (() => false);
  // PORT-NOTE (1c: 44fe2f4): a redacting log sink, threaded through both
  // loops — the TS analogue of installing RedactingFormatter on the root
  // logger, which covers every module's log calls, not just cli.ts's own.
  const redactingLog = (line: string) => process.stderr.write(`${redact(line)}\n`);
  const handle = outbound.start(cfg, bot, allowlist, { shouldStop, log: redactingLog });
  try {
    await new Inbound(cfg, bot, allowlist, { log: redactingLog }).run(shouldStop); // blocks
  } finally {
    handle.stop();
  }
  return 0;
}
