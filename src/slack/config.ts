// config.ts — bridge configuration from environment variables.
// Faithful port of headlong_slack.config (Python).
//
// All settings come from the process environment (in production the systemd
// unit loads the box's .env via EnvironmentFile).

import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeExit } from "./errors.ts";

export interface Config {
  serveRoot: string;
  identity: string;
  identityDir: string;
  botToken: string;
  appToken: string;
  webUrl: string;
  stateDir: string;
  threadFollowups: boolean;
  /** How many messages above a first @mention to prepend. 0 disables.
   *  PORT-NOTE (1c: 48a706c). */
  threadJoinBackfill: number;
  /** Peer hearing: bot user ids of other Headlong personas whose Slack posts
   *  may reach this mind. Empty (the default) keeps the old rule that every
   *  bot post is dropped. See design/peer_hearing.md. */
  peerBotUsers: ReadonlySet<string>;
  /** Loop guard: consecutive peer messages forwarded in one thread with no
   *  person speaking in between, and total peer messages per hour. */
  peerMaxTurns: number;
  peerHourlyCap: number;
}

/**
 * SLACK_PEER_BOT_USERS: comma-separated bot user ids (U...) of peers.
 *
 * Anything that is not a Slack user id is ignored, so a stray bot id (B...) or
 * a display name cannot open the gate by accident.
 */
export function peerBotUsers(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.SLACK_PEER_BOT_USERS ?? "";
  const ids = new Set<string>();
  for (const piece of raw.replace(/;/g, ",").split(",")) {
    const part = piece.trim();
    if (part && (part[0] === "U" || part[0] === "W") && /^[\p{L}\p{N}]+$/u.test(part) && part === part.toUpperCase()) {
      ids.add(part);
    }
  }
  return ids;
}

/** Python `_int_env`: unset/empty/unparseable -> default, else clamped to [lo, hi]. */
export function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, lo: number, hi: number): number {
  const raw = env[name] ?? "";
  if (raw === "") return dflt;
  const trimmed = raw.trim();
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return dflt;
  return Math.max(lo, Math.min(hi, Number(trimmed)));
}

/**
 * SLACK_THREAD_JOIN_BACKFILL: prior thread lines on first @mention.
 * Default 20. 0 disables. Clamped to 50 so a long thread cannot dump.
 * PORT-NOTE (1c: 48a706c).
 */
function joinBackfillLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.SLACK_THREAD_JOIN_BACKFILL ?? "";
  if (raw === "") return 20;
  const trimmed = raw.trim();
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return 20;
  const n = Number(trimmed);
  return Math.max(0, Math.min(50, n));
}

/** Identity id for the web API: root-relative path with / -> ~. */
export function identityApiId(cfg: Config): string {
  const rel = path.relative(cfg.serveRoot, cfg.identityDir);
  return rel.split(path.sep).join("~");
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The identity the `default` symlink points at, as `persona` resolves it.
 *
 * The immediate link target, not the end of the chain: an identity dir may
 * itself be a symlink elsewhere, and its name here is the one `identity
 * default` recorded.
 */
function defaultIdentity(serveRoot: string): string {
  for (const base of [".identities", "identities"]) {
    const link = path.join(serveRoot, base, "default");
    if (isSymlink(link)) {
      const target = fs.readlinkSync(link);
      const name = path.basename(target);
      // A dangling default is its own error: passing the name on would
      // surface as "identity not found ... identity new <name>", advice
      // that creates a second identity instead of fixing the link.
      if (!isDir(path.join(serveRoot, base, name))) {
        throw new BridgeExit(
          `headlong-slack-bridge: the default identity link ${link} ` +
            `points at '${name}', which is not an identity under ` +
            `${path.join(serveRoot, base)}. Repoint it with: identity default ${name}`,
        );
      }
      return name;
    }
  }
  throw new BridgeExit(
    `headlong-slack-bridge: no identity given and no default set ` +
      `under ${serveRoot} (looked for .identities/default and ` +
      `identities/default). Set HEADLONG_SLACK_IDENTITY, or point the ` +
      `default at one with: identity default <name>`,
  );
}

function findIdentityDir(serveRoot: string, name: string): string {
  for (const base of [".identities", "identities"]) {
    const candidate = path.join(serveRoot, base, name);
    if (isFile(path.join(candidate, "info.txt"))) return candidate;
  }
  throw new BridgeExit(
    `headlong-slack-bridge: identity '${name}' not found under ${serveRoot} ` +
      `(looked in .identities/ and identities/). Create it with: identity new ${name}`,
  );
}

export function load(serveRoot: string, env: NodeJS.ProcessEnv = process.env): Config {
  // SLACK_CLI_* fallbacks: `slack run` provides tokens under these names
  // when it drives the bridge as the project's start hook.
  const botToken = env.SLACK_BOT_TOKEN || env.SLACK_CLI_XOXB || "";
  const appToken = env.SLACK_APP_TOKEN || env.SLACK_CLI_XAPP || "";
  if (!botToken || !appToken) {
    throw new BridgeExit("headlong-slack-bridge: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
  }
  // HEADLONG_* is canonical; SHELLM_* accepted as a legacy fallback until the
  // deployed boxes migrate their env files.
  const identity = env.HEADLONG_SLACK_IDENTITY || env.SHELLM_SLACK_IDENTITY || defaultIdentity(serveRoot);
  const identityDir = findIdentityDir(serveRoot, identity);
  const stateDir =
    env.HEADLONG_SLACK_STATE_DIR ||
    env.SHELLM_SLACK_STATE_DIR ||
    path.join(identityDir, "run", "slack-bridge");
  fs.mkdirSync(stateDir, { recursive: true });
  const webUrl = (env.HEADLONG_WEB_URL || env.SHELLM_WEB_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const threadFollowupsRaw = env.SLACK_THREAD_FOLLOWUPS || "";
  return {
    serveRoot,
    identity,
    identityDir,
    botToken,
    appToken,
    webUrl,
    stateDir,
    threadFollowups: threadFollowupsRaw !== "" && threadFollowupsRaw !== "0",
    threadJoinBackfill: joinBackfillLimit(env),
    peerBotUsers: peerBotUsers(env),
    peerMaxTurns: intEnv(env, "SLACK_PEER_MAX_TURNS", 4, 0, 50),
    peerHourlyCap: intEnv(env, "SLACK_PEER_HOURLY_CAP", 30, 0, 1000),
  };
}
