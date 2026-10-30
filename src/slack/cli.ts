// cli.ts — run the Slack Socket Mode bridge for a headlong identity.
// Faithful port of headlong_slack.cli (Python `main()`) PLUS the local-dev
// parts of the upstream Bash launcher (tools/headlong-slack-bridge): loading
// `.env` files so the tokens can live in a file instead of the calling
// shell, "whatever is already exported wins". The launcher's checkout-root
// discovery and `uv run --project slack …` exec are upstream-repo-layout-
// specific and have no analogue in this single-repo port; not replicated —
// see PARITY.md. Same shape as src/telegram/cli.ts, which made the same call
// for its own Bash launcher.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BridgeExit } from "./errors.ts";
import * as config from "./config.ts";
import { WebClient } from "./api.ts";
import { Inbound } from "./inbound.ts";
import * as outbound from "./outbound.ts";
import { ActiveThreads } from "./state.ts";
import { SocketModeHandler } from "./socketmode.ts";

const USAGE = `usage: headlong-slack-bridge [-h] [--verbose] [root]

Run the Slack Socket Mode bridge for a shellm identity.

ROOT is the directory the web server serves (contains .identities/);
defaults to the current directory. Configuration comes from the
environment — see config.ts.

positional arguments:
  root        Serve root (contains .identities/) (default: .)

options:
  -h, --help  show this help message and exit
  --verbose   Debug logging
`;

/**
 * `_load_env` (tools/headlong-slack-bridge): fill env vars from a
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
  /** Checked between Socket Mode reconnect attempts and by the outbound
   *  follow loop; defaults to "never stop" (blocks forever), matching
   *  Python's `main()`. */
  shouldStop?: () => boolean;
  /** How often to poll `shouldStop` to unwind the Socket Mode connection
   *  (Node has no blocking-thread-interrupt equivalent to Python's
   *  `stop_event.set()` reaching a thread mid-`handler.start()`). */
  stopPollMs?: number;
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
export async function runCli(argv: string[], io: CliIO, opts: RunCliOptions = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    io.stdout(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    io.stderr(`headlong-slack-bridge: error: ${parsed.error}\n`);
    return 2;
  }

  const env: NodeJS.ProcessEnv = { ...io.env };
  // Local-dev convenience (Bash launcher): load the checkout's .env, then
  // $HEADLONG_HOME/.env (legacy $SHELLM_HOME honored too), so the tokens can
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

  const client = new WebClient(cfg.botToken);
  // No try/catch here, matching Python: `auth = app.client.auth_test()` is
  // unguarded in cli.py — a bad token surfaces as an uncaught exception
  // (traceback, exit 1), not a graceful message.
  const auth = await client.authTest();
  const botUserId = String(auth.user_id ?? "");
  const peers = [...cfg.peerBotUsers].sort().join(",") || "none";
  io.stderr(
    `headlong-slack-bridge: identity=${cfg.identity} bot=${String(auth.user ?? "")} ` +
      `(${botUserId}) web=${cfg.webUrl} peers=${peers} ` +
      `(max ${cfg.peerMaxTurns} in a row, ${cfg.peerHourlyCap}/h)\n`,
  );

  const threads = new ActiveThreads(path.join(cfg.stateDir, "active_threads.json"));
  const shouldStop = opts.shouldStop ?? (() => false);
  const outboundHandle = outbound.start(cfg, client, threads, { shouldStop });
  const inbound = new Inbound(cfg, client, botUserId, threads);

  const appClient = new WebClient(cfg.appToken);
  const socketMode = new SocketModeHandler({
    onEvent: (event) => inbound.onEvent(event),
    openConnection: () => appClient.appsConnectionsOpen(),
  });

  const pollMs = opts.stopPollMs ?? 200;
  const poller = setInterval(() => {
    if (shouldStop()) socketMode.stop();
  }, pollMs);
  try {
    await socketMode.start(); // blocks until stop()
  } finally {
    clearInterval(poller);
    outboundHandle.stop();
    inbound.stop();
  }
  return 0;
}
