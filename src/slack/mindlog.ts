// mindlog.ts — follow an identity's root trajectory file (the mind log).
// Faithful port of headlong_slack.mindlog (Python).
//
// The trajectory is append-only JSONL; the bridge keeps a persisted byte
// offset so restarts neither replay old steps nor miss new ones. Only
// complete (newline-terminated) lines are consumed.
//
// Identical logic to src/telegram/mindlog.ts — upstream's own
// headlong_telegram.mindlog module docstring says it was copied from
// headlong_slack.mindlog and should be kept in sync; this port mirrors that
// relationship (independent files, same behavior), not a shared module.

import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeExit } from "./errors.ts";

export type Step = Record<string, unknown>;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
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

function parseInfoTxt(infoTxtPath: string): Record<string, string> {
  const info: Record<string, string> = {};
  if (!isFile(infoTxtPath)) return info;
  const text = fs.readFileSync(infoTxtPath, "utf8");
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx >= 0) {
      info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return info;
}

/** Locate the mind log, mirroring headlong_web.discovery.find_root_traj_dir. */
export function findTrajectory(identityDir: string): string {
  const info = parseInfoTxt(path.join(identityDir, "info.txt"));
  const trajRoot = path.join(identityDir, "trajectories");
  const rootId = info.root_trajectory ?? "";
  if (rootId) {
    const prefix = rootId.slice(0, 8) + "-";
    let names: string[] = [];
    try {
      names = fs.readdirSync(trajRoot).filter((n) => n.startsWith(prefix));
    } catch {
      names = [];
    }
    names.sort();
    for (const name of names) {
      const candidate = path.join(trajRoot, name, "trajectory.jsonl");
      if (isFile(candidate)) return candidate;
    }
  }
  if (isDir(trajRoot)) {
    const names = fs.readdirSync(trajRoot).sort();
    for (const name of names) {
      const candidate = path.join(trajRoot, name, "trajectory.jsonl");
      if (isFile(candidate)) return candidate;
    }
  }
  throw new BridgeExit(`headlong-slack-bridge: no trajectory.jsonl under ${trajRoot}`);
}

function splitLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

export interface ReadNewResult {
  steps: Step[];
  newOffset: number;
}

/**
 * Read complete JSONL lines appended since offset.
 *
 * Corrupt lines are skipped. If the file shrank (rebuilt/truncated) reading
 * resumes at its END: a bridge that replays a rebuilt log re-sends every old
 * message to real people (upstream 2026-09-09: 130 historical Telegram
 * messages re-sent after an identity switch handed the bridge a stale offset).
 *
 * PORT-NOTE: upstream commit "mindlog: shrink -> EOF, cursor carries the path".
 */
export function readNew(filePath: string, offset: number): ReadNewResult {
  const size = fs.statSync(filePath).size;
  if (size < offset) return { steps: [], newOffset: size };
  if (size === offset) return { steps: [], newOffset: offset };
  const fd = fs.openSync(filePath, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { steps: [], newOffset: offset };
  const complete = buf.subarray(0, lastNewline + 1);
  const steps: Step[] = [];
  for (const lineBuf of splitLines(complete)) {
    if (lineBuf.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(lineBuf.toString("utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        steps.push(parsed as Step);
      }
    } catch {
      continue;
    }
  }
  return { steps, newOffset: offset + lastNewline + 1 };
}

export interface FollowOptions {
  pollIntervalMs?: number;
  shouldStop?: () => boolean;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Python `Path.resolve()` (non-strict): realpath when it exists. */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The cursor file holds "<offset> <trajectory path>". A cursor written for a
 * different trajectory (the bridge was pointed at another identity, or the
 * state dir is shared) is ignored and reading starts at EOF; an old
 * offset-only cursor is honoured only if it does not exceed the file.
 */
export function loadCursor(cursorFile: string, filePath: string): number {
  const size = fs.statSync(filePath).size;
  if (!isFile(cursorFile)) return size;
  let raw: string;
  try {
    raw = fs.readFileSync(cursorFile, "utf8").trim();
  } catch {
    return size;
  }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m || !/^[0-9]+$/.test(m[1]!)) return size;
  const offset = Number(m[1]);
  const rest = m[2];
  if (rest !== undefined && rest !== "" && rest !== resolvePath(filePath)) return size;
  if (offset > size) return size;
  return offset;
}

/** Yield steps appended to the trajectory, starting at EOF (no replay). */
export async function* follow(
  filePath: string,
  cursorFile: string,
  opts: FollowOptions = {},
): AsyncGenerator<Step> {
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const shouldStop = opts.shouldStop ?? (() => false);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let offset = loadCursor(cursorFile, filePath);

  while (!shouldStop()) {
    const { steps, newOffset } = readNew(filePath, offset);
    if (newOffset !== offset) {
      offset = newOffset;
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      fs.writeFileSync(cursorFile, `${offset} ${resolvePath(filePath)}`);
    }
    for (const s of steps) yield s;
    await sleep(pollIntervalMs);
  }
}
