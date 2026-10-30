// control.ts — the web server's mutation layer. Port of
// headlong_web/control.py, but calling the port's library directly instead
// of shelling out to CLIs (task directive: "the server imports the port's
// library directly (no subprocess)"; PLAN-daemon-runtime.md §6). Per-identity
// async mutex mirrors control.py:36-48 (start/stop only — chat_send and
// thinkers_step are NOT locked upstream either).

import * as fs from "node:fs";
import * as path from "node:path";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { identityIdFor, type IdentityInfo } from "./discovery.ts";
import { thinkersStatus } from "./thinkers.ts";
import { resolveIdentityEnv } from "../../../src/identity-env.ts";
import {
  identityNew as libIdentityNew,
  identityImport as libIdentityImport,
  ImportError as LibImportError,
  resolveExportDirs as libResolveExportDirs,
  buildIdentityExportArchive as libBuildIdentityExportArchive,
  ExportError as LibExportError,
} from "../../../src/identity.ts";
import {
  thinkersStart as libThinkersStart,
  thinkersStop as libThinkersStop,
  thinkersStep as libThinkersStep,
  enabledThinkerNames,
} from "../../../src/thinkersctl.ts";
import { runChat, type ChatIO } from "../../../src/chat.ts";
import { killall as libKillall, type KillallOptions } from "../../../src/killall.ts";
import { runLlm } from "../../../src/llmCli.ts";
import { spawnAdapterProcess } from "../../../src/llmAdapterProcess.ts";
import { randomBytes } from "node:crypto";
import { parseEnvFile } from "./envfile.ts";
import * as usage from "./usage.ts";

const PORT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECAP_BIN = path.join(PORT_ROOT, "bin", "recap.mjs");

/** Re-exported so router.ts can `instanceof` against a single error type
 *  (server.py's ImportError -> 422). */
export const ImportError_ = LibImportError;

/** Maps to `409 {message, stderr, exit_code}` at the router (control.py:180-192). */
export class ControlError extends Error {
  readonly stderr: string;
  readonly exitCode: number;
  constructor(message: string, stderr: string, exitCode: number) {
    super(message);
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function toControlError(e: unknown, stderrBuf: string): ControlError {
  if (e instanceof ControlError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ControlError(message, stderrBuf, 1);
}

// ---------------------------------------------------------------------------
// Per-identity async mutex (control.py:36-48) — serializes start/stop so two
// requests (or a request racing another request) never clobber
// run/active_thinkers' non-atomic rewrite.
// ---------------------------------------------------------------------------

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const locks = new Map<string, Mutex>();
function identityLock(identityId: string): Mutex {
  let m = locks.get(identityId);
  if (!m) {
    m = new Mutex();
    locks.set(identityId, m);
  }
  return m;
}

function envFor(identity: IdentityInfo): Record<string, string> {
  return resolveIdentityEnv(identity.path, { base: process.env as Record<string, string> });
}

export { enabledThinkerNames };

// ---------------------------------------------------------------------------
// identity new (control.py identity_new)
// ---------------------------------------------------------------------------

export interface IdentityNewControlResult {
  ok: true;
  id: string;
  name: string;
  stderr: string;
}

/** `root` here is the web serve-root — the dir that DIRECTLY contains
 *  identity dirs (unlike upstream's repo-root + .identities/ nesting), so the
 *  id this port computes is discovery.identityIdFor's own scheme, not
 *  upstream's literal ".identities~<name>" string. */
export function identityNew(root: string, name: string): IdentityNewControlResult {
  let result: ReturnType<typeof libIdentityNew>;
  try {
    result = libIdentityNew({ identitiesRoot: root, name });
  } catch (e) {
    throw toControlError(e, "");
  }
  const rel = relative(root, result.identityDir).split("\\").join("/");
  const id = identityIdFor(rel);
  let stderrText = `Created identity: ${result.name}\n`;
  if (result.defaultSet) stderrText += `Set as default.\n`;
  return { ok: true, id, name: result.name, stderr: stderrText };
}

// ---------------------------------------------------------------------------
// chat send (control.py chat_send) — NOT locked upstream.
// ---------------------------------------------------------------------------

export interface ChatSendControlResult {
  ok: true;
  from: string;
  to: string;
}

export function chatSend(
  identity: IdentityInfo,
  content: string,
  fromName: string,
  sourceUrl?: string | null,
): ChatSendControlResult {
  const env = envFor(identity);
  const toName = env["IDENTITY_NAME"] ?? identity.name;
  let stderrBuf = "";
  const io: ChatIO = {
    cwd: identity.path,
    env,
    stdout: () => {},
    stderr: (s) => {
      stderrBuf += s;
    },
    readStdin: () => content,
    isStdinTTY: false,
    hasCommand: () => false,
    execInherit: () => 127,
  };
  // PORT-NOTE (1c: f68c1d8): control.py's chat_send appends --source-url
  // when the caller (server.py's ChatSendBody, already validated against
  // safety.is_slack_permalink) passed one.
  const args = ["send", "--from", fromName, "--to", toName];
  if (sourceUrl != null) args.push("--source-url", sourceUrl);
  const code = runChat(args, io);
  if (code !== 0) {
    const lines = stderrBuf.split("\n").filter((l) => l.trim() !== "");
    const message = lines.length > 0 ? lines[lines.length - 1]! : `exit code ${code}`;
    throw new ControlError(message, stderrBuf, code);
  }
  return { ok: true, from: fromName, to: toName };
}

// ---------------------------------------------------------------------------
// thinkers start/stop (control.py thinkers_start/thinkers_stop) — LOCKED.
// ---------------------------------------------------------------------------

export interface ThinkersControlResult {
  ok: true;
  action: string;
  names: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
}

export async function thinkersStart(
  identity: IdentityInfo,
  names: string[],
  noSelfTrigger: boolean
): Promise<ThinkersControlResult> {
  return identityLock(identity.id).run(async () => {
    const env = envFor(identity);
    let stderrBuf = "";
    try {
      const result = await libThinkersStart(env, names, {
        noSelfTrigger,
        stderr: (s) => {
          stderrBuf += s;
        },
      });
      return { ok: true as const, action: "start", names: result.started, exit_code: 0, stdout: "", stderr: stderrBuf };
    } catch (e) {
      throw toControlError(e, stderrBuf);
    }
  });
}

export async function thinkersStop(
  identity: IdentityInfo,
  names: string[],
  force: boolean
): Promise<ThinkersControlResult> {
  return identityLock(identity.id).run(async () => {
    const env = envFor(identity);
    let stderrBuf = "";
    try {
      await libThinkersStop(env, names, {
        force,
        stderr: (s) => {
          stderrBuf += s;
        },
      });
      return { ok: true as const, action: "stop", names, exit_code: 0, stdout: "", stderr: stderrBuf };
    } catch (e) {
      throw toControlError(e, stderrBuf);
    }
  });
}

// ---------------------------------------------------------------------------
// thinkers step (control.py thinkers_step) — fire-and-forget (Popen there;
// an un-awaited library call here), NOT locked, 202 semantics at the router.
// ---------------------------------------------------------------------------

export interface StepControlResult {
  ok: true;
  action: "step";
  names: string[];
}

export function thinkersStep(identity: IdentityInfo, name: string): StepControlResult {
  const env = envFor(identity);
  void libThinkersStep(env, name).catch(() => {
    /* fire-and-forget, matches upstream's detached Popen: caller never sees this */
  });
  return { ok: true, action: "step", names: [name] };
}

// ---------------------------------------------------------------------------
// thinkers enable/disable (server.py thinkers_enable/thinkers_disable —
// upstream keeps this orchestration in the route handler, not control.py;
// ported here instead since it still only calls the library + fs).
// ---------------------------------------------------------------------------

export interface DisableResult {
  ok: true;
  name: string;
  disabled: true;
  stopped_first: boolean;
}

export async function thinkersDisable(identity: IdentityInfo, name: string): Promise<DisableResult> {
  const status = thinkersStatus(identity.path);
  const entry = status.thinkers.find((t) => t.name === name);
  let stoppedFirst = false;
  if (entry && entry.state !== "stopped" && entry.state !== "disabled") {
    await thinkersStop(identity, [name], false);
    stoppedFirst = true;
  }
  const marker = join(identity.path, "thinkers", name, "disabled");
  fs.closeSync(fs.openSync(marker, "a"));
  return { ok: true, name, disabled: true, stopped_first: stoppedFirst };
}

export interface EnableResult {
  ok: true;
  name: string;
  disabled: false;
  needs_restart: boolean;
}

export function thinkersEnable(identity: IdentityInfo, name: string): EnableResult {
  const marker = join(identity.path, "thinkers", name, "disabled");
  try {
    fs.unlinkSync(marker);
  } catch {
    /* already absent */
  }
  const status = thinkersStatus(identity.path);
  return { ok: true, name, disabled: false, needs_restart: status.dispatcher.running };
}

// ---------------------------------------------------------------------------
// killall (control.py killall, control.py:441-447) — panic button. Upstream
// shells out to `headlong-killall [--dry-run]` (never `--web`, from this
// route); this port calls src/killall.ts's library function directly, same
// no-subprocess convention as the rest of this file.
// ---------------------------------------------------------------------------

export interface KillallControlResult {
  ok: true;
  dry_run: boolean;
  stdout: string;
  stderr: string;
}

export async function killall(
  dryRun: boolean,
  overrides: Pick<KillallOptions, "psSnapshot" | "dockerListing"> = {}
): Promise<KillallControlResult> {
  let stdoutBuf = "";
  let stderrBuf = "";
  try {
    await libKillall({
      dryRun,
      stdout: (s) => {
        stdoutBuf += s;
      },
      stderr: (s) => {
        stderrBuf += s;
      },
      ...overrides,
    });
  } catch (e) {
    throw toControlError(e, stderrBuf);
  }
  return { ok: true, dry_run: dryRun, stdout: stdoutBuf, stderr: stderrBuf };
}

// ---------------------------------------------------------------------------
// recap refresh (control.py recap_refresh) — fire-and-forget: recap makes
// one LLM call per window and can run for minutes; its own .lock serializes
// concurrent refreshes. Upstream Popen()s the `recap` CLI detached
// (start_new_session=True); this port spawns bin/recap.mjs the same way
// `thinkersStart` spawns the dispatcher (Node, detached, unref'd) — a
// subprocess of the port's OWN tool, not a Bash shell-out.
// ---------------------------------------------------------------------------

export interface RecapRefreshResult {
  ok: true;
  action: "recap-refresh";
  rebuild: boolean;
}

export function recapRefresh(root: string, identity: IdentityInfo, rebuild: boolean): RecapRefreshResult {
  const env = envFor(identity);
  const args = ["-q", ...(rebuild ? ["--rebuild"] : [])];
  const child = spawn(process.execPath, [RECAP_BIN, ...args], {
    cwd: root,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, action: "recap-refresh", rebuild };
}

// ---------------------------------------------------------------------------
// usage refresh (control.py identity_usage_refresh -> usage.start_refresh) —
// thin re-export of usage.ts's own lock/offset-tracking; see usage.ts's
// PORT-NOTE for the background-thread -> deferred-on-event-loop deviation.
// ---------------------------------------------------------------------------

export function usageLedgerPath(identity: IdentityInfo): string {
  return usage.ledgerPath(identity.path);
}

export function usageStartRefresh(trajDir: string, identityName: string, ledger: string, rebuild: boolean): boolean {
  return usage.startRefresh(trajDir, identityName, ledger, rebuild);
}

// ---------------------------------------------------------------------------
// llm probe (control.py llm_probe) — one tiny real LLM call through the same
// .env the thinkers use. Calls src/llmCli.ts's runLlm in-process (the `llm`
// tool's own library entry point — see bin/llm.mjs), not a subprocess.
// LLM_RETRIES=0 so the raw outcome isn't masked by llm's transient-retry logic.
// ---------------------------------------------------------------------------

export interface LlmProbeResult {
  ok: boolean;
  latency_ms: number;
  model: string | null;
  provider?: string | null;
  error?: string;
}

export async function llmProbe(root: string): Promise<LlmProbeResult> {
  let model = "";
  for (const [key, value] of parseEnvFile(join(root, ".env"))) {
    if (key === "SHELLM_MODEL") model = value;
  }
  model = model || process.env["SHELLM_MODEL"] || "";

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["LLM_RETRIES"] = "0";

  const args = ["--no-stream", "--raw", "-t", "60", ...(model ? ["-m", model] : []), "ping"];

  let stdoutBuf = "";
  let stderrBuf = "";
  const io = {
    cwd: root,
    env,
    stdout: (s: string) => {
      stdoutBuf += s;
    },
    stderr: (s: string) => {
      stderrBuf += s;
    },
    readStdin: () => "",
    stdinIsTTY: false,
    now: () => new Date(),
    fetch: globalThis.fetch,
    fs,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    spawnAdapter: spawnAdapterProcess,
    randomToken: () => randomBytes(6).toString("hex"),
  };

  const start = Date.now();
  let code: number;
  try {
    code = await runLlm(args, io);
  } catch (e) {
    code = 1;
    stderrBuf += e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Date.now() - start;

  if (code !== 0) {
    const lines = stderrBuf.split("\n").filter((l) => l.trim() !== "");
    return {
      ok: false,
      latency_ms: latencyMs,
      model: model || null,
      error: lines.length > 0 ? lines[lines.length - 1]! : `exit ${code}`,
    };
  }
  let provider: string | null = null;
  try {
    const parsed: unknown = JSON.parse(stdoutBuf);
    if (parsed && typeof parsed === "object" && "provider" in parsed) {
      provider = (parsed as Record<string, unknown>)["provider"] as string | null;
    }
  } catch {
    /* --raw body wasn't JSON; provider stays null */
  }
  return { ok: true, latency_ms: latencyMs, model: model || null, provider };
}

// ---------------------------------------------------------------------------
// identity import (control.py identity_import) — port of tools/identity's
// `import` subcommand (src/identity.ts identityImport), called as a library
// function against the staged archive path server.ts wrote to disk.
// ---------------------------------------------------------------------------

export interface IdentityImportResult {
  ok: true;
  imported: { id: string; name: string }[];
  stderr: string;
}

export function identityImport(root: string, archivePath: string, name: string | null): IdentityImportResult {
  const result = libIdentityImport({ identitiesRoot: root, archivePath, name: name ?? undefined });
  const imported = result.imported.map((n) => {
    const rel = relative(root, join(root, n)).split("\\").join("/");
    return { id: identityIdFor(rel), name: n };
  });
  return { ok: true, imported, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// identity export (control.py identity_export/identity_export_all) — this
// port's `src/identity.ts` builds the .tgz entirely in-process (no `tar`/`gzip`
// subprocess, no on-disk tmp file the way upstream's `_export_to_tempfile`
// needs one for a CLI round-trip); router.ts sends the returned Buffer
// directly as the response body. See PARITY.md "identity export" row.
// ---------------------------------------------------------------------------

/** Re-exported so router.ts can `instanceof` against a single error type. */
export const ExportError_ = LibExportError;

function toExportControlError(e: unknown): ControlError {
  if (e instanceof LibExportError) return new ControlError(e.message, "", 1);
  return toControlError(e, "");
}

/** `identity_export` (control.py:397-409): one identity, resolved via
 *  `--path` (never by name/fuzzy-match — the identity is already resolved
 *  by the caller through discovery). */
export function buildIdentityExportBuffer(root: string, identity: IdentityInfo, soulOnly: boolean, slim: boolean): Buffer {
  try {
    const dirs = libResolveExportDirs(root, { paths: [identity.path] });
    return libBuildIdentityExportArchive({ dirs, soulOnly, slim });
  } catch (e) {
    throw toExportControlError(e);
  }
}

/** `identity_export_all` (control.py:412-417): `--all` under the serve root. */
export function buildIdentityExportAllBuffer(root: string, soulOnly: boolean): Buffer {
  try {
    const dirs = libResolveExportDirs(root, { all: true });
    return libBuildIdentityExportArchive({ dirs, soulOnly });
  } catch (e) {
    throw toExportControlError(e);
  }
}
