// config.ts — bridge configuration from environment variables.
// Faithful port of headlong_telegram.config (Python).
//
// All settings come from the process environment. In production the systemd
// unit loads a root-owned env file — deliberately NOT the shared root .env,
// so the bot token never enters the agent's environment. See telegram/README.md
// (upstream) / this port's PARITY.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeExit } from "./errors.ts";

export interface Config {
  serveRoot: string;
  identity: string;
  identityDir: string;
  botToken: string;
  adminId: number;
  webUrl: string;
  stateDir: string;
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
          `headlong-telegram-bridge: the default identity link ${link} ` +
            `points at '${name}', which is not an identity under ` +
            `${path.join(serveRoot, base)}. Repoint it with: identity default ${name}`,
        );
      }
      return name;
    }
  }
  throw new BridgeExit(
    `headlong-telegram-bridge: no identity given and no default set ` +
      `under ${serveRoot} (looked for .identities/default and ` +
      `identities/default). Set HEADLONG_TELEGRAM_IDENTITY, or point the ` +
      `default at one with: identity default <name>`,
  );
}

function findIdentityDir(serveRoot: string, name: string): string {
  for (const base of [".identities", "identities"]) {
    const candidate = path.join(serveRoot, base, name);
    if (isFile(path.join(candidate, "info.txt"))) return candidate;
  }
  throw new BridgeExit(
    `headlong-telegram-bridge: identity '${name}' not found under ${serveRoot} ` +
      `(looked in .identities/ and identities/). Create it with: identity new ${name}`,
  );
}

/** `str.isdigit()` for the plain non-empty numeric strings this reads. */
function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

export function load(serveRoot: string, env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken) throw new BridgeExit("headlong-telegram-bridge: TELEGRAM_BOT_TOKEN is required");
  const adminRaw = env.TELEGRAM_ADMIN_ID || "";
  if (!isDigits(adminRaw)) {
    throw new BridgeExit(
      "headlong-telegram-bridge: TELEGRAM_ADMIN_ID is required (your numeric " +
        "Telegram user id — message the bot once and check the bridge log)",
    );
  }
  // HEADLONG_* is canonical; SHELLM_* accepted as a legacy fallback until the
  // deployed boxes migrate their env files.
  const identity =
    env.HEADLONG_TELEGRAM_IDENTITY || env.SHELLM_TELEGRAM_IDENTITY || defaultIdentity(serveRoot);
  const identityDir = findIdentityDir(serveRoot, identity);
  const stateDir =
    env.HEADLONG_TELEGRAM_STATE_DIR ||
    env.SHELLM_TELEGRAM_STATE_DIR ||
    path.join(identityDir, "run", "telegram-bridge");
  fs.mkdirSync(stateDir, { recursive: true });
  const webUrl = (env.HEADLONG_WEB_URL || env.SHELLM_WEB_URL || "http://127.0.0.1:8080").replace(
    /\/+$/,
    "",
  );
  return {
    serveRoot,
    identity,
    identityDir,
    botToken,
    adminId: Number(adminRaw),
    webUrl,
    stateDir,
  };
}
