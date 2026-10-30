// messageIndex.ts — the derived message index behind `chat history --with` /
// `--thread` (design/conversation_memory.md, part 1). Ports bin/chat's
// `_index_update` / `_index_apply` (messages.jsonl + a `.offset` file next to
// the trajectory) and the `chat history --with/--thread` jq query.
//
// The index is DERIVED: the trajectory stays the only source of truth, and
// the index rebuilds from a full scan whenever it is missing or the recorded
// trajectory header no longer matches. It maintains itself on read: each call
// appends the message lines found in the bytes the trajectory gained since the
// recorded byte offset. Only COMPLETE lines are consumed — a line still being
// written is left for the next call, so a message is never skipped or torn.
//
// PORT-NOTE (1c: 2fed66c): `deferrals.jsonl` sits beside `messages.jsonl` and
// is built in the SAME pass, sharing the same `.offset` file — every
// responder deferral (`type:"action"`, `source:"responder"`, a non-empty
// `trigger_step`) becomes a `{kind:"request", ...}` line, and every
// observation carrying `resolves` becomes a `{kind:"resolve", ...}` line.
// `chat pending` (queryPending below) reads it so the mind sees every
// unresolved request however old, not just the ones still inside its
// recent-stream window (design/conversation_memory.md, part 5).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { personKey, threadKey } from "./personMemory.ts";

const INDEX_CONTENT_CAP = 8000;
const NEWLINE = 0x0a;

/** `_deferrals_path` — deferrals.jsonl lives beside the message index. */
export function deferralsPath(idxFile: string): string {
  return path.join(path.dirname(idxFile), "deferrals.jsonl");
}

export interface IndexedMessage {
  step_id?: string;
  ts?: string;
  from: string;
  to: string;
  reply_to?: string;
  filename?: string;
  key?: string;
  content: string;
}

/** `_deliveries_path` — deliveries.jsonl: every bridge `delivery` notice, built in the same pass (sync 2e39a3f, 9dc7926). */
export function deliveriesPath(idxFile: string): string {
  return path.join(path.dirname(idxFile), "deliveries.jsonl");
}

// --- jq-flavoured value helpers ------------------------------------------------

/** jq `X // ""`: null/false/absent fall through to the default. */
function jqAltEmpty(v: unknown): unknown {
  return v === undefined || v === null || v === false ? "" : v;
}

/** jq `tostring`: strings as-is, everything else its compact JSON text. */
function jqToString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `if length > $cap then .[0:$cap] + "…[truncated]" else . end` — jq counts codepoints, not UTF-16 units. */
function capContent(s: string): string {
  if (s.length <= INDEX_CONTENT_CAP) return s; // units <= cap implies codepoints <= cap
  const cps = Array.from(s);
  return cps.length > INDEX_CONTENT_CAP ? cps.slice(0, INDEX_CONTENT_CAP).join("") + "…[truncated]" : s;
}

/** `with_entries(select(.value != null))` while keeping the given key order. */
function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** `wc -c < f 2>/dev/null | tr -d ' ' || echo 0`: a missing file yields the EMPTY string (the pipeline's status is tr's). */
function wcOrEmpty(file: string): string {
  try {
    return String(fs.statSync(file).size);
  } catch {
    return "";
  }
}

function readBytesRange(file: string, fromByte: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, fromByte);
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `_traj_header_id`: `head -c 65536 | jq -rn 'first(inputs) | .step_id // .traj_id // ""'`, "-" when
 * empty or unparseable. The FIRST JSON value of the file however many lines it spans (a header
 * rewritten as a pretty-printed object, 2026-09-14); an incomplete first value (cut by the 64 KiB
 * window) makes jq fail, which is "-" too.
 */
function trajHeaderId(trajFile: string): string {
  let text: string;
  try {
    const fd = fs.openSync(trajFile, "r");
    try {
      const buf = Buffer.alloc(65536);
      const got = fs.readSync(fd, buf, 0, 65536, 0);
      text = buf.subarray(0, got).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "-";
  }
  const first = firstJsonValue(text);
  if (first === undefined) return "-";
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    // `null | .step_id` is null (-> ""); any other non-object errors (-> "-" either way).
    return "-";
  }
  const o = first as Record<string, unknown>;
  const pick = [o["step_id"], o["traj_id"]].find((v) => v !== undefined && v !== null && v !== false);
  if (pick === undefined) return "-";
  const s = typeof pick === "string" ? pick : JSON.stringify(pick);
  return s === "" ? "-" : s;
}

/** Parse the first complete JSON value from a text holding concatenated values; undefined if none/incomplete/invalid. */
function firstJsonValue(text: string): unknown {
  let i = 0;
  while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  if (i >= text.length) return undefined;
  const start = i;
  const c = text[i]!;
  if (c === "{" || c === "[") {
    let depth = 0;
    let inStr = false;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined; // incomplete
  }
  // a scalar: runs to the next delimiter
  let j = i;
  if (c === '"') {
    j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) return undefined;
    j++;
  } else {
    while (j < text.length && !" \t\r\n{}[],:\"".includes(text[j]!)) j++;
  }
  try {
    return JSON.parse(text.slice(start, j));
  } catch {
    return undefined;
  }
}

function fileIno(file: string): string {
  try {
    return String(fs.statSync(file).ino);
  } catch {
    return "";
  }
}

function fileMtimeSeconds(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

// --- the index lock (sync 2e39a3f, 2422d1b) --------------------------------------
//
// PORT-NOTE: the lock is the directory <index>.lock; the holder records "pid pid-namespace
// start-time" in <lock>/owner, exactly as the Bash does, so a Bash `chat` and this port can
// judge each other's locks. The holder's pid here is the node process's (the Bash's is `$$`).
// A holder killed with SIGKILL leaves its lock; the next caller takes it over when the recorded
// process is gone (start time guards pid reuse; a holder in another pid namespace is never
// judged; an owner-less lock is taken over only after INDEX_LOCK_GRACE seconds).

const INDEX_LOCK_GRACE = 60;

/** `_proc_start`: `LC_ALL=C TZ=UTC ps -o lstart= -p PID | tr -s ' ' '_' | sed 's/^_//;s/_$//'`. */
function procStart(pid: number): string {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (r.error || r.status !== 0) return "";
  return (r.stdout ?? "").split("\n")[0]!.replace(/ +/g, "_").replace(/^_/, "").replace(/_$/, "");
}

let myProcStart: string | undefined;
function ownProcStart(): string {
  // constant for the life of the process; one `ps` instead of one per lock operation
  if (myProcStart === undefined) myProcStart = procStart(process.pid);
  return myProcStart;
}

/** `_pid_ns`: `readlink /proc/self/ns/pid`, "-" where there is none (macOS). */
function pidNs(): string {
  try {
    return fs.readlinkSync("/proc/self/ns/pid") || "-";
  } catch {
    return "-";
  }
}

function indexLockClaim(lock: string): void {
  try {
    const tmp = path.join(lock, `owner.${process.pid}`);
    fs.writeFileSync(tmp, `${process.pid} ${pidNs()} ${ownProcStart()}\n`);
    fs.renameSync(tmp, path.join(lock, "owner"));
  } catch {
    /* `|| true` */
  }
}

/** `_index_lock_abandoned`: true = the holder is gone and the lock can be taken over. */
export function indexLockAbandoned(lock: string): boolean {
  try {
    const st = fs.lstatSync(lock);
    if (!st.isDirectory()) return false; // also false for a symlink (lstat)
  } catch {
    return false;
  }
  const mine = ownProcStart();
  if (mine === "") return false; // cannot see even this process: judge nobody
  let opid = "";
  let ons = "";
  let ostart = "";
  try {
    const line = fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0] ?? "";
    // `read -r opid ons ostart`: whitespace-split; the last variable keeps the remainder
    const m = /^[ \t]*(\S*)[ \t]*(\S*)[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m) {
      opid = m[1]!;
      ons = m[2]!;
      ostart = m[3]!;
    }
  } catch {
    /* no owner record */
  }
  if (!/^[0-9]+$/.test(opid)) {
    return Math.floor(Date.now() / 1000) - fileMtimeSeconds(lock) >= INDEX_LOCK_GRACE;
  }
  if (ons !== pidNs()) return false;
  return procStart(Number(opid)) !== ostart;
}

/** `_index_lock`: true when the caller now holds the lock. */
function indexLock(lock: string, notify: (s: string) => void): boolean {
  try {
    fs.mkdirSync(lock);
    indexLockClaim(lock);
    return true;
  } catch {
    /* held (or the directory is unwritable) */
  }
  if (!indexLockAbandoned(lock)) return false;
  // One caller at a time decides a takeover, and decides it again once it is alone.
  const steal = `${lock}.steal`;
  try {
    fs.mkdirSync(steal);
  } catch {
    if (Math.floor(Date.now() / 1000) - fileMtimeSeconds(steal) >= INDEX_LOCK_GRACE) {
      try {
        fs.rmdirSync(steal);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  let got = false;
  let made = false;
  try {
    fs.mkdirSync(lock);
    made = true;
  } catch {
    /* fall through to the abandoned re-check */
  }
  if (made || indexLockAbandoned(lock)) {
    indexLockClaim(lock);
    got = true;
    notify("chat: took over the message index lock from a process that is gone\n");
  }
  try {
    fs.rmdirSync(steal);
  } catch {
    /* ignore */
  }
  return got;
}

function indexUnlock(lock: string): void {
  let opid = "";
  try {
    opid = (fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0] ?? "").trim().split(/\s+/)[0] ?? "";
  } catch {
    /* no owner */
  }
  if (opid !== "" && opid !== String(process.pid)) return; // taken over: not ours to release
  try {
    fs.rmSync(path.join(lock, "owner"), { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(lock);
  } catch {
    /* ignore */
  }
}

interface OffsetRecord {
  off: number;
  header: string;
  ino: string;
  isz: string;
  dsz: string;
  vsz: string;
}

/** `read -r have_off have_header have_ino _ have_isz have_dsz have_vsz _ < "$off"` */
function readOffsetRecord(offFile: string): OffsetRecord {
  const rec: OffsetRecord = { off: 0, header: "", ino: "", isz: "", dsz: "", vsz: "" };
  let line: string;
  try {
    line = fs.readFileSync(offFile, "utf8").split("\n")[0] ?? "";
  } catch {
    return rec;
  }
  const f = line.split(/[ \t]+/).filter((x) => x !== "");
  const offStr = f[0] ?? "";
  rec.off = /^[0-9]+$/.test(offStr) ? Number(offStr) : 0;
  rec.header = f[1] ?? "";
  rec.ino = f[2] ?? "";
  rec.isz = f[4] ?? "";
  rec.dsz = f[5] ?? "";
  rec.vsz = f[6] ?? "";
  return rec;
}

/** `_index_record`: the offset record, replaced in one rename so a kill never leaves half of it. */
function indexRecord(idx: string, off: string, n: number, header: string, tf: string, size: number): void {
  let sizes = "";
  for (const f of [idx, deferralsPath(idx), deliveriesPath(idx)]) sizes += ` ${wcOrEmpty(f)}`;
  fs.writeFileSync(`${off}.new`, `${n} ${header} ${fileIno(tf)} ${size}${sizes}\n`);
  fs.renameSync(`${off}.new`, off);
}

/**
 * `_index_trim`: cut an index file back to the size recorded at the last completed update (an
 * updater killed part way appended rows its cursor never covered). false = the file is SHORTER
 * than recorded (emptied or replaced), so the caller rebuilds.
 */
function indexTrim(f: string, want: number, notify: (s: string) => void): boolean {
  let have: number;
  try {
    have = fs.statSync(f).size;
  } catch {
    have = 0;
  }
  if (have < want) return false;
  if (have === want) return true;
  notify(`chat: dropping ${have - want} bytes an interrupted index update left in ${path.basename(f)}\n`);
  try {
    fs.truncateSync(f, want);
    return true;
  } catch {
    return false;
  }
}

/**
 * _index_update <trajectory file> <index file> — brings the index up to date with the trajectory.
 * Best-effort: any failure leaves the index as it was (mirrors `_index_update ... || true` at
 * every call site). `notify` receives the Bash's stderr notices (rebuild reason, trim, takeover).
 */
export function indexUpdate(trajFile: string, idxFile: string, notify: (s: string) => void = () => {}): void {
  const lock = `${idxFile}.lock`;
  // Lock before reading the offset or deciding to rebuild; a caller that does not get the lock
  // just uses what is there.
  let held = false;
  try {
    held = indexLock(lock, notify);
  } catch {
    held = false;
  }
  if (!held) return;
  try {
    indexUpdateLocked(trajFile, idxFile, notify);
  } catch {
    /* best-effort — a stale or missing index just costs a rebuild next time */
  } finally {
    indexUnlock(lock);
  }
}

function indexUpdateLocked(tf: string, idx: string, notify: (s: string) => void): void {
  const off = `${idx}.offset`;
  const header = trajHeaderId(tf);
  const have = fs.existsSync(off) ? readOffsetRecord(off) : { off: 0, header: "", ino: "", isz: "", dsz: "", vsz: "" };
  let haveOff = have.off;
  const size = fileSize(tf);
  const ino = fileIno(tf);
  const dfr = deferralsPath(idx);
  const dlv = deliveriesPath(idx);
  let why = "";
  if (!fs.existsSync(idx) || !fs.existsSync(dfr) || !fs.existsSync(dlv)) {
    why = "no index yet";
  } else if (have.header !== header) {
    why = "trajectory header changed";
  } else if (have.ino !== "" && ino !== "" && have.ino !== ino) {
    why = `trajectory file replaced (inode ${have.ino} -> ${ino})`;
  } else if (haveOff > 0 && size < haveOff) {
    why = `trajectory shrank below the index offset (${size} < ${haveOff})`;
  } else if (/^[0-9]+$/.test(have.isz) && /^[0-9]+$/.test(have.dsz) && /^[0-9]+$/.test(have.vsz)) {
    if (!(indexTrim(idx, Number(have.isz), notify) && indexTrim(dfr, Number(have.dsz), notify) && indexTrim(dlv, Number(have.vsz), notify))) {
      why = "an index file is shorter than the last update recorded";
    }
  }
  if (why !== "") {
    if (why !== "no index yet") notify(`chat: rebuilding the message index from the start: ${why}\n`);
    haveOff = 0;
    // Record the restart before emptying anything, so an update killed from here on resumes as a
    // rebuild from byte zero, never as an append at the old offset onto emptied files.
    fs.writeFileSync(`${off}.new`, `0 ${header} ${ino === "" ? "-" : ino} 0 0 0 0\n`);
    fs.renameSync(`${off}.new`, off);
    for (const f of [idx, dfr, dlv]) {
      fs.writeFileSync(`${f}.rebuild`, "");
      fs.renameSync(`${f}.rebuild`, f);
    }
  }
  if (size <= haveOff) {
    // Nothing new. Upgrade an older offset record (no inode, or no index sizes) in passing.
    if ((have.ino === "" && ino !== "") || have.vsz === "") {
      try {
        indexRecord(idx, off, haveOff, header, tf, size);
      } catch {
        /* `2>/dev/null || true` */
      }
    }
    return;
  }
  indexApply(tf, idx, off, header, haveOff, size);
}

/**
 * `_index_apply`: read the new bytes straight from the trajectory as a fixed byte range (never a
 * temp copy: a full rebuild on a 1.6 GB trajectory used to need 1.6 GB free in /tmp), index the
 * complete message lines among them, advance the record.
 */
function indexApply(tf: string, idx: string, off: string, header: string, haveOff: number, size: number): void {
  const newBytes = size - haveOff;
  if (newBytes <= 0) return;
  const buf = readBytesRange(tf, haveOff, newBytes);
  // Length of a trailing line that is still being appended: only the last 4 MiB of the range is
  // probed. No newline in the probe at all means one very long unfinished line.
  const probe = Math.min(newBytes, 4194304);
  let partial = 0;
  if (buf[buf.length - 1] !== NEWLINE) {
    const probeStart = buf.length - probe;
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl < probeStart) {
      if (probe !== newBytes) return; // leave it for the next call; nothing is recorded
      partial = newBytes;
    } else {
      partial = buf.length - (lastNl + 1);
    }
  }
  const len = newBytes - partial;
  if (len > 0) {
    const text = buf.subarray(0, len).toString("utf8");
    const lines = messageLinesFrom(text);
    if (lines.length > 0) fs.appendFileSync(idx, lines.join("\n") + "\n");
    const deferralLines = deferralLinesFrom(text);
    if (deferralLines.length > 0) fs.appendFileSync(deferralsPath(idx), deferralLines.join("\n") + "\n");
    const deliveryLines = deliveryLinesFrom(text);
    if (deliveryLines.length > 0) fs.appendFileSync(deliveriesPath(idx), deliveryLines.join("\n") + "\n");
  }
  indexRecord(idx, off, haveOff + len, header, tf, size);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // fromjson? // empty
  }
}

/** The messages half: `grep -F '"type":"message"' | jq 'select(.type=="message" and (.from // "") != "" and (.to // "") != "") | {step_id, ts, from, to, reply_to, filename, key, content}'`. */
function messageLinesFrom(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (!line.includes('"type":"message"')) continue; // grep -F prefilter
    const rec = parseLine(line);
    if (!rec) continue;
    if (rec["type"] !== "message") continue;
    if (jqAltEmpty(rec["from"]) === "" || jqAltEmpty(rec["to"]) === "") continue;
    const out = dropNulls({
      step_id: rec["step_id"],
      ts: rec["ts"],
      from: rec["from"],
      to: rec["to"],
      reply_to: rec["reply_to"],
      filename: rec["filename"],
      key: rec["key"],
      content: capContent(jqToString(jqAltEmpty(rec["content"]))),
    });
    lines.push(JSON.stringify(out));
  }
  return lines;
}

/** The deliveries half: `grep -F '"type":"delivery"' | jq 'select(.type=="delivery" and (.trigger_step // "") != "") | {step_id, ts, trigger_step, status, transport, reason, permalink, channel, message_ts}'`. */
function deliveryLinesFrom(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (!line.includes('"type":"delivery"')) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    if (rec["type"] !== "delivery" || jqAltEmpty(rec["trigger_step"]) === "") continue;
    out.push(
      JSON.stringify(
        dropNulls({
          step_id: rec["step_id"],
          ts: rec["ts"],
          trigger_step: rec["trigger_step"],
          status: rec["status"],
          transport: rec["transport"],
          reason: rec["reason"],
          permalink: rec["permalink"],
          channel: rec["channel"],
          message_ts: rec["message_ts"],
        }),
      ),
    );
  }
  return out;
}

/**
 * The deferrals half of `_index_apply` (bin/chat: the `head -c ... | grep -F
 * -e '"trigger_step"' -e '"resolves":' | jq ...` pipeline). Scans the SAME
 * complete-lines text the message index just consumed for two shapes:
 *   - a responder deferral: `type:"action"`, `source:"responder"`, non-empty
 *     `trigger_step` -> `{kind:"request", step_id, ts, trigger_step, person,
 *     request}` (request text from `.request // .content`, capped like a
 *     message body).
 *   - a resolution: `type:"observation"` with a non-empty `resolves` ->
 *     `{kind:"resolve", step_id, ts, resolves}`.
 * Fields absent from the source record are omitted (jq's
 * `with_entries(select(.value != null))`), not written as `null`.
 */
function deferralLinesFrom(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (!line.includes('"trigger_step"') && !line.includes('"resolves":')) continue; // cheap prefilter
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // fromjson? // empty
    }
    const triggerStep = rec["trigger_step"];
    if (
      rec["type"] === "action" &&
      rec["source"] === "responder" &&
      typeof triggerStep === "string" &&
      triggerStep !== ""
    ) {
      const rec_: Record<string, unknown> = { kind: "request" };
      const sid = rec["step_id"];
      if (sid !== undefined && sid !== null) rec_["step_id"] = sid;
      const ts = rec["ts"];
      if (ts !== undefined && ts !== null) rec_["ts"] = ts;
      rec_["trigger_step"] = triggerStep;
      const person = rec["person"];
      if (person !== undefined && person !== null) rec_["person"] = person;
      const rawRequest = rec["request"] ?? rec["content"] ?? "";
      let request = rawRequest === undefined || rawRequest === null ? "" : String(rawRequest);
      if (request.length > INDEX_CONTENT_CAP) request = request.slice(0, INDEX_CONTENT_CAP) + "…[truncated]";
      rec_["request"] = request;
      out.push(JSON.stringify(rec_));
      continue;
    }
    const resolves = rec["resolves"];
    if (rec["type"] === "observation" && typeof resolves === "string" && resolves !== "") {
      const rec_: Record<string, unknown> = { kind: "resolve" };
      const sid = rec["step_id"];
      if (sid !== undefined && sid !== null) rec_["step_id"] = sid;
      const ts = rec["ts"];
      if (ts !== undefined && ts !== null) rec_["ts"] = ts;
      rec_["resolves"] = resolves;
      out.push(JSON.stringify(rec_));
    }
  }
  return out;
}

/** Parse "7d" / "36h" / "90m" / "3600" (seconds) into seconds. */
export function durationSeconds(spec: string): number {
  const m = /^(-?\d+)([dhms])$/.exec(spec);
  if (!m) {
    const n = Number(spec);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case "d":
      return n * 86400;
    case "h":
      return n * 3600;
    case "m":
      return n * 60;
    default:
      return n; // s
  }
}

export interface HistoryQuery {
  me: string;
  /** Person keys that all mean the same person (empty = --with not given). */
  keys: string[];
  /** Thread key ("" = --thread not given / not a threaded routing name). */
  threadKey: string;
  sinceSeconds: number;
  n: number;
  /** now() injectable for deterministic --since filtering in tests. */
  now?: () => number;
}

/** Read the index file's lines into records, tolerant of corrupt lines. */
function readIndexRecords(idxFile: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = fs.readFileSync(idxFile, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* fromjson? // empty */
    }
  }
  return out;
}

/** `chat history --with/--thread`'s jq query over the index. */
export function queryHistory(idxFile: string, q: HistoryQuery): IndexedMessage[] {
  const records = readIndexRecords(idxFile);

  // unique_by(.step_id): group by step_id, keep the FIRST occurrence per key
  // (jq's group_by is a stable sort, so ties keep original relative order);
  // final order is re-established by the sort_by(ts) below regardless.
  const byStepId = new Map<string, Record<string, unknown>>();
  const noStepId: Array<Record<string, unknown>> = [];
  for (const r of records) {
    const sid = r["step_id"];
    if (sid === undefined || sid === null) {
      noStepId.push(r); // no step_id: never deduplicated against each other
      continue;
    }
    const key = String(sid);
    if (!byStepId.has(key)) byStepId.set(key, r);
  }
  const deduped = [...byStepId.values(), ...noStepId];

  const nowSec = Math.floor((q.now ?? (() => Date.now()))() / 1000);
  const cutoffSec = nowSec - q.sinceSeconds;

  const filtered = deduped.filter((r) => {
    const from = String(r["from"] ?? "");
    const to = String(r["to"] ?? "");
    const withPerson =
      q.keys.length > 0 &&
      ((from === q.me && q.keys.includes(personKey(to))) || (to === q.me && q.keys.includes(personKey(from))));
    const inThread = q.threadKey !== "" && (threadKey(from) === q.threadKey || threadKey(to) === q.threadKey);
    if (!withPerson && !inThread) return false;
    if (q.sinceSeconds === 0) return true;
    const secs = parseTsSeconds(String(r["ts"] ?? ""));
    return secs !== null && secs >= cutoffSec;
  });

  filtered.sort((a, b) => String(a["ts"] ?? "").localeCompare(String(b["ts"] ?? "")));

  // `.[-$n:]` — jq quirk: -0 slices from index 0, i.e. the WHOLE array.
  const limited = q.n <= 0 ? filtered : filtered.length <= q.n ? filtered : filtered.slice(-q.n);

  return limited as unknown as IndexedMessage[];
}

function parseTsSeconds(ts: string): number | null {
  if (!ts) return null;
  const truncated = ts.slice(0, 19) + "Z";
  const ms = Date.parse(truncated);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// `chat pending` (design/conversation_memory.md, part 5 — bin/chat's
// cmd_pending). Every deferrals.jsonl "request" not yet matched by a
// "resolve" carrying the same trigger_step, oldest first.
// ---------------------------------------------------------------------------

export interface PendingRequest {
  trigger_step: string;
  /** null when the source record had no `person` field (jq: value -> null). */
  person: string | null;
  request: string;
  /** null when the source record had no `ts` field. */
  ts: string | null;
  age_s: number;
}

/** `(.ts // "")[0:19] + "Z" | try fromdateiso8601 catch 0` */
function pendingTsEpoch(ts: string | null): number {
  const truncated = (ts ?? "").slice(0, 19) + "Z";
  const ms = Date.parse(truncated);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export interface PendingQuery {
  /** 0 = no age limit (bash: `$max == 0`). */
  maxAgeSeconds: number;
  /** now() injectable for deterministic age_s in tests. */
  now?: () => number;
}

/** `cmd_pending`'s jq query over deferrals.jsonl. */
export function queryPending(dfrFile: string, q: PendingQuery): PendingRequest[] {
  const records = readIndexRecords(dfrFile);

  const done = new Set<string>();
  for (const r of records) {
    if (r["kind"] !== "resolve") continue;
    const resolves = r["resolves"];
    if (typeof resolves === "string" && resolves !== "") done.add(resolves);
  }

  // map(select(kind=="request" and not resolved)) | unique_by(.trigger_step):
  // unique_by keeps the FIRST occurrence per key once sorted by that key, but
  // the array is re-sorted by .ts right below, so "first occurrence in scan
  // order" (a plain first-write-wins map) reproduces the same final set.
  const firstByTrigger = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    if (r["kind"] !== "request") continue;
    const trig = r["trigger_step"];
    if (typeof trig !== "string" || trig === "" || done.has(trig)) continue;
    if (!firstByTrigger.has(trig)) firstByTrigger.set(trig, r);
  }

  const nowSec = Math.floor((q.now ?? (() => Date.now()))() / 1000);
  const out: PendingRequest[] = [];
  for (const r of firstByTrigger.values()) {
    const ts = r["ts"] !== undefined && r["ts"] !== null ? String(r["ts"]) : null;
    const age_s = Math.floor(nowSec - pendingTsEpoch(ts));
    if (q.maxAgeSeconds !== 0 && age_s > q.maxAgeSeconds) continue;
    out.push({
      trigger_step: String(r["trigger_step"]),
      person: r["person"] !== undefined && r["person"] !== null ? String(r["person"]) : null,
      request: r["request"] !== undefined && r["request"] !== null ? String(r["request"]) : "",
      ts,
      age_s,
    });
  }

  out.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return out;
}

/** `age_text` — bin/chat's cmd_pending helper, floor-divided, no plural. */
export function pendingAgeText(ageSeconds: number): string {
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`;
  return `${Math.floor(ageSeconds / 86400)}d`;
}

/** `_duration_s` re-exported under its Bash name for readability at call sites. */
export { durationSeconds as parseDuration };

// ---------------------------------------------------------------------------
// `chat sent` (sync 2e39a3f, 6b6b342/9dc7926: design/outbound_delivery.md, part 5) — the
// identity's outbound messages, newest first, each joined to what the bridge reported back
// (deliveries.jsonl) by trigger_step. Also the data behind `_refuse_key`.
// ---------------------------------------------------------------------------

/** Transports whose bridge writes delivery notices on a production box: unconfirmed sends there read `pending`. */
export const SENT_CONFIRMING_RE = /^(slack)-/;

export interface SentQuery {
  me: string;
  /** 0 = no age limit. */
  sinceSeconds: number;
  n: number;
  /** now() in ms, injectable for deterministic tests. */
  now?: () => number;
}

/** `def secs: (.ts // "")[0:19] + "Z" | try fromdateiso8601 catch 0` */
function jqSecs(ts: unknown): number {
  const s = (typeof ts === "string" ? ts : ts === undefined || ts === null || ts === false ? "" : jqToString(ts)).slice(0, 19) + "Z";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return 0;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function tsKey(r: Record<string, unknown>): string {
  const v = jqAltEmpty(r["ts"]);
  return typeof v === "string" ? v : jqToString(v);
}

/** The merged rows of `cmd_sent`'s jq program, before text/JSON rendering. */
export function querySent(idxFile: string, q: SentQuery): Array<Record<string, unknown>> {
  const nowSec = (q.now ?? (() => Date.now()))() / 1000;

  // the newest notice per message wins (a replayed step may write two)
  const newest = new Map<string, Record<string, unknown>>();
  for (const r of readIndexRecords(deliveriesPath(idxFile))) {
    if (jqAltEmpty(r["trigger_step"]) === "") continue;
    const k = jqToString(r["trigger_step"]);
    const cur = newest.get(k);
    if (cur === undefined || tsKey(r) >= tsKey(cur)) newest.set(k, r);
  }

  // unique_by(.step_id): the first row of each step_id group; groups ordered by step_id (null first)
  const groups = new Map<string | null, Record<string, unknown>>();
  for (const r of readIndexRecords(idxFile)) {
    const sid = r["step_id"];
    const k = sid === undefined || sid === null ? null : jqToString(sid);
    if (!groups.has(k)) groups.set(k, r);
  }
  const uniq = [...groups.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1))
    .map(([, r]) => r);

  const mine = uniq.filter((m) => m["from"] === q.me && (q.sinceSeconds === 0 || jqSecs(m["ts"]) >= nowSec - q.sinceSeconds));
  // sort_by(.ts // "") | reverse | .[:$n]  (sort is stable)
  const sorted = mine
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (tsKey(a.r) < tsKey(b.r) ? -1 : tsKey(a.r) > tsKey(b.r) ? 1 : a.i - b.i))
    .map((x) => x.r)
    .reverse()
    .slice(0, Math.max(0, q.n));

  return sorted.map((m) => {
    const d = newest.get(jqToString(m["step_id"])) ?? {};
    const status = d["status"];
    const state =
      status !== undefined && status !== null && status !== false
        ? status
        : SENT_CONFIRMING_RE.test(String(m["to"] ?? ""))
          ? "pending"
          : "unconfirmed";
    return dropNulls({
      ...m,
      age_s: Math.floor(nowSec - jqSecs(m["ts"])),
      state,
      reason: d["reason"],
      permalink: d["permalink"],
      transport: d["transport"],
    });
  });
}

/** `--json`: `map({step_id, ts, to, content, state, reason, permalink, transport, age_s, reply_to, filename, key})` (absent -> null). */
export function sentJson(rows: Array<Record<string, unknown>>): string {
  const keys = ["step_id", "ts", "to", "content", "state", "reason", "permalink", "transport", "age_s", "reply_to", "filename", "key"];
  return JSON.stringify(rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]))));
}

/** The text lines of `chat sent`. */
export function sentText(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => {
    const body = jqToString(jqAltEmpty(r["filename"]) !== "" ? r["filename"] : jqAltEmpty(r["content"])).replace(/\n/g, " ");
    const cps = Array.from(body);
    const shown = cps.length > 80 ? cps.slice(0, 80).join("") + "…" : body;
    const reason = r["reason"];
    const key = r["key"];
    return (
      `${jqToString(jqAltEmpty(r["ts"]) === "" ? "?" : r["ts"])} ${jqToString(r["to"])}  ${jqToString(r["state"])}` +
      (r["state"] === "pending" ? ` ${pendingAgeText(Number(r["age_s"]))}` : "") +
      (reason !== undefined && reason !== null && reason !== false ? ` (${jqToString(reason)})` : "") +
      (key !== undefined && key !== null && key !== false ? ` [${jqToString(key)}]` : "") +
      `  ${shown}`
    );
  });
}

/**
 * `_refuse_repeat`'s first jq: the newest send of EXACTLY this text from `me` to `to` inside the
 * window, as "ts step_id"; "truncated" when the text is longer than the index cap (a prefix match is
 * only a candidate); "" when none.
 */
export function findRepeat(idxFile: string, me: string, to: string, message: string, windowSeconds: number, now: () => number = Date.now): string {
  const nowSec = now() / 1000;
  const want = capContent(message);
  const hits = readIndexRecords(idxFile).filter(
    (r) => r["from"] === me && r["to"] === to && jqAltEmpty(r["content"]) === want && jqSecs(r["ts"]) >= nowSec - windowSeconds,
  );
  if (hits.length === 0) return "";
  if (Array.from(message).length > INDEX_CONTENT_CAP) return "truncated";
  const last = hits.map((r, i) => ({ r, i })).sort((a, b) => (tsKey(a.r) < tsKey(b.r) ? -1 : tsKey(a.r) > tsKey(b.r) ? 1 : a.i - b.i)).pop()!.r;
  return `${jqToString(last["ts"])} ${jqToString(last["step_id"])}`;
}

/** The `truncated` follow-up: scan the TRAJECTORY itself for an exact full-text repeat; "ts step_id" or "". */
export function findRepeatInTrajectory(trajFile: string, me: string, to: string, message: string, windowSeconds: number, now: () => number = Date.now): string {
  const nowSec = now() / 1000;
  let text: string;
  try {
    text = fs.readFileSync(trajFile, "utf8");
  } catch {
    return "";
  }
  const hits: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const r = parseLine(line);
    if (!r) continue;
    if (r["type"] === "message" && r["from"] === me && r["to"] === to && jqAltEmpty(r["content"]) === message && jqSecs(r["ts"]) >= nowSec - windowSeconds) hits.push(r);
  }
  if (hits.length === 0) return "";
  const last = hits.map((r, i) => ({ r, i })).sort((a, b) => (tsKey(a.r) < tsKey(b.r) ? -1 : tsKey(a.r) > tsKey(b.r) ? 1 : a.i - b.i)).pop()!.r;
  return `${jqToString(last["ts"])} ${jqToString(last["step_id"])}`;
}
