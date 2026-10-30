// chat.ts — send/receive messages on an activated identity's trajectory.
// Faithful port of headlong/bin/chat.
//
// Behaviour is the blueprint, not the Bash text: the jq / grep / cut / traj
// plumbing becomes native fs + trajectory-module calls, but the observable CLI
// CONTRACT is held exact — the same subcommands, flags, quirks, stdout/stderr
// split, and exit codes, plus the ON-DISK STEP SCHEMA another process reads
// (`type:"message"` steps with fields `content, from, to, source[, filename,
// reply_to]` in that construction order; run_id/step_id/ts are added by
// trajCore, exactly as the Bash `traj append` does).
//
// WHAT IS ENGINE-LOCAL (fully ported here):
//   - `chat send`      append a message step (from/to resolution, self-send guard)
//   - `chat send-file` append a message step carrying a file's contents
//   - `chat reply`     append a reply step, with reply_to inference + the
//                      duplicate-answer guard, all read straight off the stream
//   - `chat history`   read+format the last N message steps
//   - usage / dispatch / env-var gating
//
// TRANSPORT-DEPENDENT GAP (NOT silently stubbed — see cmdRepl):
//   - `chat repl` execs an external interactive TUI binary (`headlong-tui`,
//     falling back to `shellm-tui`). The dispatch + exec contract is preserved
//     faithfully, but that TUI binary is NOT part of this port slice, so the
//     command only works where such a binary is already on PATH. Marked below.
//
// Headlong quirks REPLICATED, not fixed (called out where non-obvious):
//   - The env-var gate (TRAJ_DIR/TRAJ_ID) runs for EVERY invocation except the
//     help forms — so even bare `chat` (which otherwise prints usage) and an
//     unknown command die on a missing TRAJ_DIR first.
//   - Appends always target the ROOT trajectory (`${ROOT_TRAJ_ID:-$TRAJ_ID}`),
//     even when called from a forked sub-trajectory.
//   - `send`/`reply`/`send-file` print their confirmation to STDERR; stdout is
//     empty. `history` and usage print to STDOUT.
//   - reply's duplicate guard: if a reply from us already stamps this step, we
//     skip the send and exit 0 (first send wins under concurrent wakes).
//
// PORT-NOTE (deliberate deviation): Bash reads a flag's value with
// `${2:?message}`, whose missing/empty-value error is
// `<script>: line N: 2: <message>` on stderr (exit 1) — text that embeds the
// script's absolute path and a Bash line number, irreproducible from TS and
// brittle to pin. We keep the port's clean `chat: error: <message>` instead;
// exit code (1), stdout (empty), and on-disk state (unchanged) all match. Covers
// the flag-missing/empty-value misuse paths: send/send-file --from|--to,
// reply --reply-to. (Same treatment mem.ts applies to its `${2:?}` paths.)
//
// The SAME "clean message, matching rc/stdout/state, unpinned exact wording"
// treatment is applied to two other Bash-tool error strings that are equally
// irreproducible from TS, but are NOT `${2:?}` cases — call these out
// separately rather than folding them into the above, since they come from a
// different Bash mechanism: `history`'s `tail -n <bad>` illegal-offset error
// (see cmdHistory) and `repl`'s missing-binary `exec` failure (see cmdRepl).

import * as fs from "node:fs";
import * as path from "node:path";
// Import the shared trajectory PRIMITIVES (plain-ESM trajCore.mjs), exactly as
// bin/traj.mjs does — NOT the typed trajectory.ts wrapper. The `chat` shim runs
// from source with no build step, and trajectory.ts uses TS parameter-property
// syntax that Node's strip-only type stripping rejects; trajCore.mjs is JS, so
// it imports cleanly. Same append protocol, same root file, one implementation.
import {
  appendStep as coreAppend,
  readSteps as coreRead,
  rootTrajFile,
  resolveTrajFile,
} from "./trajCore.mjs";
import { isUtf8 } from "node:buffer";
import { personKey, threadKey, personAliases } from "./personMemory.ts";
import {
  indexUpdate,
  indexLockAbandoned,
  queryHistory,
  queryPending,
  querySent,
  sentJson,
  sentText,
  findRepeat,
  findRepeatInTrajectory,
  pendingAgeText,
  deferralsPath,
  deliveriesPath,
  durationSeconds,
} from "./messageIndex.ts";

const DEFAULT_CHATRC = "./.chatrc";

// ---------------------------------------------------------------------------
// Injectable IO — the shim wires process.*; tests inject fakes for a
// deterministic stdin, env, cwd, and `repl` subprocess.
// ---------------------------------------------------------------------------

export interface ChatIO {
  /** Working directory that relative paths (`./.chatrc`, a `send-file` arg) resolve against. */
  cwd: string;
  /** Environment (TRAJ_DIR, TRAJ_ID, ROOT_TRAJ_ID, IDENTITY_NAME, CHATRC, SHELLM_RUN_STEP_ID, …). */
  env: Record<string, string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Full stdin contents — used by `send`/`reply` when no message arg is given. */
  readStdin(): string;
  /** Whether fd 0 is a tty (matches Bash `-t 0`): stdin is only slurped when NOT a tty. */
  isStdinTTY: boolean;
  /** `command -v <name>` — is an external executable on PATH (for `repl`). */
  hasCommand(name: string): boolean;
  /** Run an external binary with inherited stdio, returning its exit code (127 if not found). */
  execInherit(name: string, args: string[]): number;
}

/** Thrown by `die`/`dieRaw` to unwind to the runChat boundary with an exit code. */
class ChatExit extends Error {
  readonly code: number;
  /** When set, printed to stderr as `chat: error: <msg>`. */
  readonly dieMsg: string | undefined;
  /** When set (by `dieRaw`), printed to stderr VERBATIM — no `chat: error:`
   *  wrap — because the real Bash text this reproduces is a DIFFERENT
   *  subprocess's own die() (e.g. `traj`'s `cannot resolve traj_id`, bug #68). */
  readonly rawMsg: string | undefined;
  constructor(code: number, dieMsg?: string, rawMsg?: string) {
    super(rawMsg ?? dieMsg ?? `exit ${code}`);
    this.code = code;
    this.dieMsg = dieMsg;
    this.rawMsg = rawMsg;
  }
}

/** die() — prints `chat: error: <msg>` to stderr and exits 1. */
function die(msg: string): never {
  throw new ChatExit(1, msg);
}

/** dieRaw() — prints `<msg>` to stderr VERBATIM (no `chat: error:` prefix)
 *  and exits 1; see the `rawMsg` field above. */
function dieRaw(msg: string): never {
  throw new ChatExit(1, undefined, msg);
}

/** `${var:?msg}` — a flag value that is missing OR empty dies exactly as the
 *  Bash colon form does (same rc/stdout/state; stderr wording deviates — see
 *  the PORT-NOTE header). */
function required(v: string | undefined, msg: string): string {
  if (v === undefined || v === "") die(msg);
  return v;
}

/** Strip trailing newlines exactly as `$(...)` command substitution does. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

// POSIX [:space:] in the C locale (what the Bash trims): space, tab, newline,
// vertical tab, form feed, carriage return. Deliberately NOT JS `\s` (which is
// wider / Unicode) so trimming matches the tool byte-for-byte.
const WS = " \t\n\r\v\f";
function trimC(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WS.includes(s[start]!)) start++;
  while (end > start && WS.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// .chatrc — one `key=value` lookup, matching the tool's grep|head|cut|trim.
// ---------------------------------------------------------------------------

/** Raw CHATRC string as the Bash `$CHATRC` sees it (used verbatim in messages). */
function chatrcRaw(io: ChatIO): string {
  const v = io.env.CHATRC;
  return v !== undefined && v !== "" ? v : DEFAULT_CHATRC;
}

/**
 * Read a key from the chatrc file, "" if not found (or file absent).
 * Mirrors `grep "^key=" | head -1 | cut -d= -f2-` then whitespace-trim: the
 * first line starting `key=`, everything after that first `=`, C-locale trimmed.
 */
function chatrcGet(io: ChatIO, key: string): string {
  const raw = chatrcRaw(io);
  const file = path.isAbsolute(raw) ? raw : path.resolve(io.cwd, raw);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8"); // `[[ -f "$CHATRC" ]] || return 0`
  } catch {
    return "";
  }
  const prefix = key + "=";
  let value = "";
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) {
      value = line.slice(prefix.length); // cut -d= -f2- (everything after first '=')
      break; // head -1
    }
  }
  return trimC(value);
}

// ---------------------------------------------------------------------------
// Trajectory access — always the ROOT stream (`${ROOT_TRAJ_ID:-$TRAJ_ID}`).
// ---------------------------------------------------------------------------

function rootId(io: ChatIO): string {
  const r = io.env.ROOT_TRAJ_ID;
  if (r !== undefined && r !== "") return r;
  return io.env.TRAJ_ID ?? "";
}

/**
 * Absolute path of the root trajectory file for this invocation, for READS
 * only (`history`/`pending`/the duplicate-answer guard). Every Bash `chat`
 * command reaches the trajectory through `traj cat`, piped with `2>/dev/null`
 * and no `|| die` (bin/chat:149,563,602) — an unresolvable TRAJ_ID silently
 * yields empty history, never a hard failure. `resolveTrajFile`'s three
 * strategies (exact path, `<dir>/<id>/trajectory.jsonl`, or a `<hex8>-*`
 * directory glob — the SAME helper `chat history --with` uses, see
 * cmdHistoryIndexed) match that read-side leniency: fall back to the
 * canonical `<hex8>-root` path (nonexistent, so a read of it comes back
 * empty) when nothing resolves, rather than throwing.
 */
function rootFile(io: ChatIO): string {
  const dir = io.env.TRAJ_DIR ?? "";
  const id = rootId(io);
  return resolveTrajFile(dir, id) ?? rootTrajFile(dir, id);
}

/**
 * Append one step to the root trajectory (run_id/step_id/ts stamped by
 * trajCore, exactly as `traj append` does). run_id honours
 * SHELLM_RUN_STEP_ID from env.
 *
 * PORT-NOTE (bug #68, bin/traj:204-205 `require_traj_file`): unlike reads,
 * `_chat_append` (bin/chat:36-38) shells out to the real `traj append <id>`
 * binary UNGUARDED (`>/dev/null` redirects only stdout) — when
 * `${ROOT_TRAJ_ID:-$TRAJ_ID}` doesn't resolve to an existing trajectory,
 * `traj`'s own `require_traj_file` dies with `traj: error: append: cannot
 * resolve traj_id '<id>' in '<dir>'` (rc 1, no stdout, nothing written) and
 * that death propagates straight out of `chat` — it NEVER creates a new
 * trajectory on the write path. This port used to reuse the lenient
 * `rootFile()` here, so a stale/typo'd TRAJ_ID silently fell back to
 * `rootTrajFile()`'s canonical `<hex8>-root` path and got a brand-new
 * trajectory auto-created out from under it (coreAppend's own
 * `mkdir -p`) instead of refusing — proven live against the real Bash
 * oracle: a bogus TRAJ_ID (nonexistent id, or a bare non-UUID directory
 * name) made `chat reply` create `<hex8>-root/trajectory.jsonl` and report
 * "Reply sent." at exit 0, while upstream refused identically for both
 * forms. Fixed: resolve strictly here and reproduce `traj`'s exact
 * message — `dieRaw` (not `die`) because this text is `traj`'s own die(),
 * never wrapped in `chat`'s "chat: error:" prefix in the real subprocess
 * pipeline.
 */
function appendStep(io: ChatIO, record: Record<string, unknown>): void {
  const dir = io.env.TRAJ_DIR ?? "";
  const id = rootId(io);
  const resolved = resolveTrajFile(dir, id);
  if (resolved === undefined) {
    dieRaw(`traj: error: append: cannot resolve traj_id '${id}' in '${dir}'`);
  }
  const runStepId = io.env.SHELLM_RUN_STEP_ID;
  coreAppend(resolved, record, runStepId ? { runStepId } : {});
}

/** Read every step of the root trajectory ([] on any failure — the Bash pipes
 *  swallow errors with `2>/dev/null` / `fromjson? // empty`). */
function readRootSteps(io: ChatIO): Array<Record<string, unknown>> {
  try {
    return coreRead(rootFile(io)) as unknown as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// from/to resolution shared by send + send-file (Bash `_resolve_from_to`).
// ---------------------------------------------------------------------------

function resolveFromTo(io: ChatIO, from: string, to: string): { from: string; to: string } {
  if (from === "") {
    from = chatrcGet(io, "default_send_from");
    if (from === "") {
      const rc = chatrcRaw(io);
      // Note: `$(dirname …)` is literal in the Bash heredoc (escaped `\$`), so
      // it is a copy-paste hint, not something we expand.
      die(
        `No --from specified and no default_send_from in ${rc}.\n` +
          `Create a .chatrc file with:\n` +
          `  mkdir -p $(dirname ${rc}) && echo 'default_send_from=your-name' > ${rc}`
      );
    }
  }
  if (to === "") die("No --to specified and IDENTITY_NAME not set.");
  return { from, to };
}

// ---------------------------------------------------------------------------
// Send-side guards (sync 2e39a3f): Slack target grammar, action-object refusal,
// keyed + exact-repeat refusal. All are `die`s — nothing is written when one fires.
// ---------------------------------------------------------------------------

/**
 * Slack target grammar — a copy of NAME_RE_TEXT in slack/src/headlong_slack/naming.py (upstream's
 * slack/tests/test_naming.py asserts the two are identical, so `chat` cannot accept a name the
 * bridge would silently drop: 23 of 74 sends in one week, 2026-09-09; design/outbound_delivery.md).
 * The port's bridge (src/slack/naming.ts) must agree; test/chatGuards.test.ts pins the equality.
 */
export const SLACK_NAME_RE = /^slack-([UW][A-Z0-9]+|[CGD][A-Z0-9]+|[A-Za-z0-9]+-[A-Za-z0-9]+(-[0-9.]+)?)$/;

/** `_check_target`: a name that claims to be Slack must be one the bridge can deliver; other transports pass. */
function checkTarget(name: string): void {
  if (!name.startsWith("slack-")) return;
  if (SLACK_NAME_RE.test(name)) return;
  die(
    `cannot deliver to '${name}': not a Slack address the bridge understands.\n` +
      `Accepted forms:\n` +
      `  slack-<user>-<channel>-<thread ts>   reply in a channel thread (copy the sender's name verbatim)\n` +
      `  slack-<user>-<channel>               a DM, or a channel top-level\n` +
      `  slack-C<id>                          post top-level in a channel (e.g. slack-C0BMVH6LM4K)\n` +
      `  slack-U<id>                          DM a person (e.g. slack-U0BFD9NDVE3)\n` +
      `Slack ids are uppercase: users start with U, channels with C.`
  );
}

/** `_inbound_from`: a sender other than the identity itself is a person's message being delivered in. */
function inboundFrom(io: ChatIO, from: string): boolean {
  const me = io.env.IDENTITY_NAME ?? "";
  return me !== "" && from !== me;
}

/**
 * `_refuse_json_body`: die if the body is a structured action object rather than words for a person
 * (2026-09-20/21: a responder model returned `{"action":"no_reply","message":""}` padded to its
 * token cap and six of them reached one Slack thread). Fence markers, blank lines, a UTF-8 BOM and
 * CRs are stripped first; the action key is looked for in the first 40 lines. `--force` overrides.
 *
 * PORT-NOTE: the BOM/CR strip is GNU sed (`\xef\xbb\xbf`, `\r`) — the Linux/Docker contract; BSD sed on
 * macOS does not honour those escapes, so a BOM/CR-prefixed object is only refused by the port
 * (the intended behaviour) and not by the real Bash run on macOS (parity/chat does not exercise it).
 */
function refuseJsonBody(message: string): void {
  const WS_CLASS = "[ \\t\\n\\v\\f\\r]";
  const fence = new RegExp(`^${WS_CLASS}*(\`\`\`[A-Za-z]*|~~~[A-Za-z]*)${WS_CLASS}*$`);
  const blank = new RegExp(`^${WS_CLASS}*$`);
  const lines = (message + "\n").split("\n");
  lines.pop(); // printf '%s\n' — a trailing newline is not another line
  const kept: string[] = [];
  lines.forEach((l0, idx) => {
    let l = l0;
    if (idx === 0) l = l.replace(/^\u{FEFF}/u, "");
    l = l.replace(/\r$/, "");
    if (fence.test(l) || blank.test(l)) return;
    kept.push(l);
  });
  if (kept.length === 0) return;
  if (!new RegExp(`^${WS_CLASS}*\\{`).test(kept[0]!)) return;
  const actionKey = /["'\\]action["'\\][ \t\n\v\f\r]*:/;
  if (!kept.slice(0, 40).some((l) => actionKey.test(l))) return;
  die(
    `refusing to send: this message is a structured action object, not words for a person.\n` +
      `A reply body must be plain text. If this really is meant literally, add --force.`
  );
}

/**
 * `_refuse_key`: die if a send with this key already went out and did not fail. A key names the one
 * duty a send fulfils (a scheduled window), so the check holds however the text is reworded and has
 * no time window (2026-09-18: the same papers post went out five times in three hours, reworded each
 * time; design/scheduled_goals.md).
 */
function refuseKey(io: ChatIO, key: string): void {
  let hit = "";
  try {
    const rows = sentRows(io, "", 1000000, () => {});
    const hits = rows.filter((r) => {
      const k = r["key"];
      return k !== undefined && k !== null && k !== false && k === key && r["state"] !== "failed" && r["state"] !== "skipped";
    });
    const last = hits[hits.length - 1];
    if (last) hit = `${jqText(last["ts"])} to ${jqText(last["to"])} (${jqText(last["state"])}, step ${jqText(last["step_id"])})`;
  } catch {
    hit = "";
  }
  if (hit === "") return;
  die(
    `refusing to send: '${key}' was already sent at ${hit}. That duty is done; do not send it again.\n` +
      "`chat sent` shows recent sends. If a second send is deliberate, add --force."
  );
}

function jqText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

/**
 * `_refuse_repeat <from> <to> <message> [window]`: die if this exact message already went to this
 * destination inside CHAT_REPEAT_WINDOW (default 24h; a stamped reply passes CHAT_REPLY_REPEAT_WINDOW,
 * default 10m). The check the mind failed to make on 2026-09-08 (four sends of the same two papers).
 * `--force` overrides (design/outbound_delivery.md, part 6).
 */
function refuseRepeat(io: ChatIO, from: string, to: string, message: string, win = ""): void {
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) return;
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  indexUpdate(tf, idx, io.stderr);
  if (!fs.existsSync(idx)) return;
  const spec = win !== "" ? win : io.env.CHAT_REPEAT_WINDOW || "24h";
  const windowS = durationSeconds(spec);
  if (!Number.isInteger(windowS) || windowS <= 0) return;
  let hit = findRepeat(idx, from, to, message, windowS);
  // A matching truncated prefix is only a candidate, not an exact repeat: consult the full
  // trajectory on this uncommon path only.
  if (hit === "truncated") hit = findRepeatInTrajectory(tf, from, to, message, windowS);
  if (hit === "") return;
  const sp = hit.indexOf(" ");
  die(
    `refusing to send: this exact message already went to '${to}' at ${hit.slice(0, hit.lastIndexOf(" "))} (step ${hit.slice(sp + 1)}).\n` +
      "`chat sent` shows recent sends and whether each was delivered. If the repeat is deliberate, add --force."
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdSend(io: ChatIO, args: string[]): number {
  let message = "";
  let from = "";
  let to = io.env.IDENTITY_NAME ?? "";
  // PORT-NOTE (1c: f68c1d8): source_url records where a bridged message came
  // from (e.g. a Slack permalink) — optional operator metadata, never used
  // for routing or model context. Additive: appended to the record only
  // when non-empty.
  let sourceUrl = "";
  let force = false;
  let key = "";

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--from") {
      from = required(args[i + 1], "--from requires a name");
      i += 2;
    } else if (a === "--to") {
      to = required(args[i + 1], "--to requires a name");
      i += 2;
    } else if (a === "--source-url") {
      sourceUrl = required(args[i + 1], "--source-url requires a URL");
      i += 2;
    } else if (a === "--force") {
      force = true;
      i += 1;
    } else if (a === "--key") {
      key = required(args[i + 1], "--key requires a key");
      i += 2;
    } else {
      message = message === "" ? a : `${message} ${a}`;
      i += 1;
    }
  }

  if (message === "" && !io.isStdinTTY) message = stripTrailingNewlines(io.readStdin());
  if (message === "")
    die("No message provided. Usage: chat send [--from <name>] [--to <name>] <message>");

  const r = resolveFromTo(io, from, to);
  // People can send literal JSON into the identity; only guard our output.
  if (!force && !inboundFrom(io, r.from)) refuseJsonBody(message);
  checkTarget(r.to);

  // A self-addressed message re-triggers the identity's own message
  // subscriptions and can loop it into replying to itself forever.
  if (r.from === r.to)
    die(
      `refusing to send a message from '${r.from}' to itself.\n` +
        `To message someone else: chat reply <their-name> <message>\n` +
        `To keep a note for yourself, append a thought step instead of a message.`
    );

  if (!force && key !== "") refuseKey(io, key);
  // The repeat check guards the identity's OWN sends. A message a person sends in (a bridge
  // delivering "great" for the second time today) is never a repeat to refuse: on 2026-09-21 the
  // check ran on inbound deliveries too, 22 messages came back 409 and never reached the mind.
  if (!force && !inboundFrom(io, r.from)) refuseRepeat(io, r.from, r.to, message);

  const record: Record<string, unknown> = {
    type: "message",
    content: message,
    from: r.from,
    to: r.to,
    source: "chat",
  };
  if (sourceUrl !== "") record.source_url = sourceUrl;
  if (key !== "") record.key = key;
  appendStep(io, record);
  io.stderr("Message sent.\n");
  return 0;
}

function cmdReply(io: ChatIO, args: string[]): number {
  let replyTo = "";
  let followUp = false;
  let force = false;
  let i = 0;
  // Leading --reply-to/--follow-up/--force flags only (loop breaks on the first non-flag).
  while (i < args.length) {
    if (args[i] === "--reply-to") {
      replyTo = required(args[i + 1], "--reply-to requires a step id");
      i += 2;
    } else if (args[i] === "--follow-up") {
      // A deliberate second reply to a message we already answered (part 5):
      // the responder said "let me look into that", the mind did the work,
      // and this delivers the result. Stamps reply_to like any reply but
      // skips the answered guard below, which exists for races, not for
      // follow-ups (design/conversation_memory.md, part 5).
      followUp = true;
      i += 1;
    } else if (args[i] === "--force") {
      force = true;
      i += 1;
    } else {
      break;
    }
  }

  const toName = args[i] ?? "";
  if (toName === "") die("Usage: chat reply [--reply-to <step_id>] <to_name> [message]");
  i += 1;
  checkTarget(toName);

  let message = "";
  while (i < args.length) {
    message = message === "" ? args[i]! : `${message} ${args[i]}`;
    i += 1;
  }
  if (message === "" && !io.isStdinTTY) message = stripTrailingNewlines(io.readStdin());
  if (message === "") die("No message provided. Usage: chat reply <to_name> <message>");
  if (!force) refuseJsonBody(message);

  const from = io.env.IDENTITY_NAME ?? "";
  if (from === "") die("IDENTITY_NAME not set. Run: identity shell <name>");

  if (toName === from)
    die(
      `refusing to reply to yourself ('${from}').\n` +
        `Use the name of the person you mean to reach: chat reply <their-name> <message>`
    );

  const steps = readRootSteps(io);

  // Infer what this reply answers: the latest message FROM the recipient TO us
  // that no stamped reply from us has answered yet. Answers nothing → unstamped.
  if (replyTo === "") replyTo = inferReplyTo(steps, from, toName);

  // A reply that answers nothing (no inbound to stamp) is a proactive send into the conversation and
  // gets the same 24h repeat check as `chat send`. A stamped reply stays exempt from the 24h
  // exact-text check (two people, or one person twice, may deserve the same answer) but not from a
  // short one: concurrent wakes posted the same line to one thread three times in 100 seconds
  // (2026-09-21), each answering a different inbound. CHAT_REPLY_REPEAT_WINDOW (default 10m).
  if (!force) {
    if (replyTo === "") refuseRepeat(io, from, toName, message);
    else refuseRepeat(io, from, toName, message, io.env.CHAT_REPLY_REPEAT_WINDOW || "10m");
  }

  // Answered guard: if a reply from us already stamps this step, skip (first
  // send wins under concurrent wakes). Bounded to the recent log (last 2000).
  // --follow-up skips this guard — it exists for races, not for a deliberate
  // second reply delivering work the first (holding) reply promised.
  if (replyTo !== "" && !followUp) {
    const recent = steps.slice(-2000);
    const dup = recent.some(
      (s) => s.type === "message" && s.from === from && ((s.reply_to as string) ?? "") === replyTo
    );
    if (dup) {
      io.stderr(
        `chat: step ${replyTo} already has a reply from ${from} — skipping duplicate send.\n`
      );
      return 0;
    }
  }

  const record: Record<string, unknown> = {
    type: "message",
    content: message,
    from,
    to: toName,
    source: "chat",
  };
  if (replyTo !== "") record.reply_to = replyTo;
  if (followUp) record.follow_up = true;

  appendStep(io, record);
  io.stderr("Reply sent.\n");
  return 0;
}

/**
 * The step_id of the latest message the recipient sent us that we have not
 * answered. Ports the reply-inference jq:
 *   answered   = reply_to of every message from us that carries one
 *   candidates = messages from them→us with a non-empty step_id not in answered
 *   result     = the last candidate's step_id, else ""
 */
function inferReplyTo(
  steps: Array<Record<string, unknown>>,
  me: string,
  them: string
): string {
  const answered = new Set<string>();
  for (const s of steps) {
    if (s.type === "message" && s.from === me) {
      const rt = (s.reply_to as string) ?? "";
      if (rt !== "") answered.add(rt);
    }
  }
  let result = "";
  for (const s of steps) {
    if (s.type === "message" && s.from === them && s.to === me) {
      const id = (s.step_id as string) ?? "";
      if (id !== "" && !answered.has(id)) result = id; // last wins
    }
  }
  return result;
}

const CHAT_SEND_FILE_MAX_BYTES_DEFAULT = 10485760;

/**
 * `_chat_is_text_file` (bin/chat, c647609): a file keeps its readable body in
 * `content` (what Slack/web chat display) when it has no NUL byte and is
 * valid UTF-8; otherwise it is binary and `content` becomes a short marker.
 *
 * PORT-NOTE (1c: c647609): bash gates the UTF-8 check on `command -v iconv`
 * being on PATH — an environment-availability quirk (a host without iconv
 * treats any NUL-free file as text), not a designed behavior. The port
 * always validates strictly via Node's `buffer.isUtf8` (equivalent to
 * `iconv -f UTF-8 -t UTF-8` round-tripping cleanly), matching the Docker
 * sandbox this port targets, where iconv is always present.
 */
function isTextFile(buf: Buffer): boolean {
  if (buf.includes(0)) return false; // NUL byte -> binary (JSON strings can't hold it)
  return isUtf8(buf);
}

function cmdSendFile(io: ChatIO, args: string[]): number {
  let from = "";
  let to = io.env.IDENTITY_NAME ?? "";
  let filepath = "";

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--from") {
      from = required(args[i + 1], "--from requires a name");
      i += 2;
    } else if (a === "--to") {
      to = required(args[i + 1], "--to requires a name");
      i += 2;
    } else {
      filepath = a; // last positional wins
      i += 1;
    }
  }

  if (filepath === "")
    die("Usage: chat send-file [--from <name>] [--to <name>] <filename>");

  const abs = path.isAbsolute(filepath) ? filepath : path.resolve(io.cwd, filepath);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = undefined;
  }
  if (!stat || !stat.isFile()) die(`File not found: ${filepath}`); // `[[ -f ]]` — before from/to resolution
  checkTarget(to);

  // PORT-NOTE (1c: f68ae29): a size cap (default 10MB, CHAT_SEND_FILE_MAX_BYTES)
  // checked BEFORE from/to resolution, same ordering as the existence check.
  const size = stat.size;
  const maxRaw = io.env.CHAT_SEND_FILE_MAX_BYTES ?? "";
  const maxSpec = maxRaw === "" ? String(CHAT_SEND_FILE_MAX_BYTES_DEFAULT) : maxRaw;
  if (!/^[0-9]+$/.test(maxSpec)) die("CHAT_SEND_FILE_MAX_BYTES must be an integer");
  const maxBytes = Number(maxSpec);
  if (size === 0) die(`empty file: ${filepath}`);
  if (size > maxBytes) die(`file too large: ${filepath} (${size} bytes; max ${maxBytes})`);

  const r = resolveFromTo(io, from, to);

  const filename = path.basename(filepath); // basename of the ORIGINAL arg
  const buf = fs.readFileSync(abs);
  const contentB64 = buf.toString("base64"); // `base64 -w 0` — no line wrapping

  // PORT-NOTE (1c: e286745, c647609): the file-transfer `message` step always
  // carries content_b64 (standard base64) now. Text files ALSO keep their
  // body in `content` (what Slack/web chat display); binary files get a
  // short `[file: name]` marker since JSON `content` cannot hold raw bytes.
  // Field order matches the jq object literal exactly: type, content,
  // filename, content_b64, from, to, source.
  const content = isTextFile(buf)
    ? stripTrailingNewlines(buf.toString("utf8")) // `$content | sub("\n+$";"")`
    : `[file: ${filename}]`;

  // NOTE: cmd_send_file has NO self-send guard (unlike send/reply) — faithful.
  appendStep(io, {
    type: "message",
    content,
    filename,
    content_b64: contentB64,
    from: r.from,
    to: r.to,
    source: "chat",
  });
  io.stderr(`File sent: ${filename}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// chat react — an outbound Slack/Telegram emoji reaction (6a98ab5), stamped
// as a `message` step so history/mind-log readers see it like any other
// message. Arg parsing allows flags BEFORE and AFTER the positional
// <to_name>, mirroring bin/chat's two-pass flag loop around the single
// positional-name slot.
// ---------------------------------------------------------------------------

function cmdReact(io: ChatIO, args: string[]): number {
  let from = io.env.IDENTITY_NAME ?? "";
  let to = "";
  let replyTo = "";
  let sourceUrl = "";
  let i = 0;

  const usageMsg =
    "Usage: chat react [--reply-to <step_id>] [--source-url <url>] <to_name> <emoji>";

  const tryConsumeFlag = (): boolean => {
    const a = args[i];
    if (a === "--from") {
      from = required(args[i + 1], "--from requires a name");
      i += 2;
      return true;
    }
    if (a === "--to") {
      to = required(args[i + 1], "--to requires a name");
      i += 2;
      return true;
    }
    if (a === "--reply-to") {
      replyTo = required(args[i + 1], "--reply-to requires a step id");
      i += 2;
      return true;
    }
    if (a === "--source-url") {
      sourceUrl = required(args[i + 1], "--source-url requires a URL");
      i += 2;
      return true;
    }
    return false;
  };

  while (i < args.length && tryConsumeFlag()) {
    /* leading flags */
  }
  if (to === "" && i < args.length) {
    to = args[i]!;
    i += 1;
  }
  if (to === "") die(usageMsg);
  checkTarget(to);
  while (i < args.length && tryConsumeFlag()) {
    /* flags between <to_name> and <emoji> */
  }

  const rawEmoji = args[i] ?? "";
  if (rawEmoji === "") die(usageMsg);
  i += 1;
  if (i < args.length) die("unexpected extra arguments");

  // Slack reactions.add wants the short name (thumbsup), not :thumbsup: or 👍.
  let emoji = rawEmoji;
  if (emoji.startsWith(":")) emoji = emoji.slice(1);
  if (emoji.endsWith(":")) emoji = emoji.slice(0, -1);
  // PORT-NOTE (1c: 1d5670a): upstream moved the hyphen to the FRONT of this
  // character class (`[-a-z0-9_+:]`) for Bash 3.2, where `[a-z0-9_+\-:]`'s
  // escaped-but-not-first hyphen misparsed on that shell's older regex
  // engine. JS regex has no such quirk — `[a-z0-9_+-:]` (hyphen last) and
  // `[-a-z0-9_+:]` (hyphen first) accept the identical character set either
  // way — but the class is spelled hyphen-first here to match upstream's
  // final byte-for-byte pattern, not because it changes behavior.
  if (!/^[-a-z0-9_+:]{1,64}$/.test(emoji)) die(`invalid Slack emoji name: ${emoji}`);

  const r = resolveFromTo(io, from, to);

  if (sourceUrl === "" && replyTo !== "") {
    sourceUrl = findStepField(io.env.TRAJ_DIR ?? "", replyTo, "source_url");
  }

  const record: Record<string, unknown> = {
    type: "message",
    content: `:${emoji}:`,
    reaction: emoji,
    from: r.from,
    to: r.to,
    source: "chat",
  };
  if (replyTo !== "") record.reply_to = replyTo;
  if (sourceUrl !== "") record.source_url = sourceUrl;
  appendStep(io, record);
  io.stderr(`Reaction sent: :${emoji}:\n`);
  return 0;
}

/**
 * `traj show --traj_dir <dir> <id> --field <field>` — used by cmd_react to
 * auto-populate source_url from the message it is reacting to. Ports
 * `_find_step_in_dir`'s slow path (bin/traj): every `.jsonl` file anywhere
 * under `trajDir` (skipping a `blobs/` subtree), first exact-or-prefix
 * step_id match wins. The fast "id is itself a trajectory id" path is not
 * reproduced — a reply_to is always a step id, never a trajectory id, so
 * that branch is unreachable from cmd_react in practice.
 */
function findStepField(trajDir: string, stepId: string, field: string): string {
  if (trajDir === "" || stepId === "") return "";
  const files: string[] = [];
  collectJsonlFiles(trajDir, files);
  files.sort(); // deterministic; real `find` order is filesystem-dependent, not a contract
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sid = typeof rec["step_id"] === "string" ? (rec["step_id"] as string) : "";
      if (sid === stepId || (sid !== "" && sid.startsWith(stepId))) {
        const v = rec[field];
        return v === undefined || v === null ? "" : String(v);
      }
    }
  }
  return "";
}

function collectJsonlFiles(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "blobs") continue; // `-not -path '*/blobs/*'`
      collectJsonlFiles(path.join(dir, e.name), acc);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      acc.push(path.join(dir, e.name));
    }
  }
}

// `tail`'s offset is parsed into a native uintmax_t (strtoumax); a digit
// string above UINT64_MAX cannot be represented at all and `tail` always
// dies with an "illegal offset ... Result too large" error (confirmed
// against the real tool: 2^64-1 already fails, memory-dependently, and
// 2^64 fails deterministically on every host). Values at or below this
// bound are host-memory-dependent (may allocate fine or not) — out of
// scope; only the deterministic overflow class is ported.
const TAIL_OFFSET_MAX = 18446744073709551615n; // 2^64 - 1

function tailOffsetInRange(digits: string): boolean {
  return BigInt(digits) <= TAIL_OFFSET_MAX;
}

/** `tail -n <spec>` over an array: last N (plain/`-N`), or from line N (`+N`). */
function tailSpec<T>(arr: T[], spec: string): T[] | null {
  const plus = /^\+(\d+)$/.exec(spec);
  if (plus) {
    if (!tailOffsetInRange(plus[1]!)) return null; // offset overflow — Bash `tail` errors
    const g = Number(plus[1]);
    return arr.slice(Math.max(0, g - 1)); // 1-indexed start
  }
  const num = /^-?(\d+)$/.exec(spec);
  if (num) {
    if (!tailOffsetInRange(num[1]!)) return null; // offset overflow — Bash `tail` errors
    const g = Number(num[1]);
    return g === 0 ? [] : arr.slice(-g);
  }
  return null; // non-numeric — Bash `tail` errors
}

function cmdHistory(io: ChatIO, args: string[]): number {
  let nSpec = "20";
  let withArg = "";
  let threadArg = "";
  let sinceArg = "";
  let asJson = false;

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--with") {
      withArg = required(args[i + 1], "--with requires a name or person key");
      i += 2;
    } else if (a === "--thread") {
      threadArg = required(args[i + 1], "--thread requires a routing name or thread key");
      i += 2;
    } else if (a === "--since") {
      sinceArg = required(args[i + 1], "--since requires a duration like 7d");
      i += 2;
    } else if (a === "-n") {
      nSpec = required(args[i + 1], "-n requires a count");
      i += 2;
    } else if (a === "--json") {
      asJson = true;
      i += 1;
    } else {
      nSpec = a; // bare positional: `chat history [N]` (legacy form)
      i += 1;
    }
  }
  // 84aa37e tightened this: EVERY path now requires a plain non-negative
  // integer count — the legacy `history [N]` positional no longer accepts a
  // raw `tail` spec like `+5` (a real upstream behavior change, not a gap).
  if (!/^[0-9]+$/.test(nSpec)) die(`history: count must be a number, got '${nSpec}'`);
  const n = Number(nSpec);

  const identityName =
    io.env.IDENTITY_NAME !== undefined && io.env.IDENTITY_NAME !== ""
      ? io.env.IDENTITY_NAME
      : "agent";

  if (withArg !== "" || threadArg !== "") {
    return cmdHistoryIndexed(io, { withArg, threadArg, sinceArg, n, asJson, identityName });
  }

  const steps = readRootSteps(io);
  // `--filter type=message,human-msg,agent-msg`
  const filtered = steps.filter(
    (s) => s.type === "message" || s.type === "human-msg" || s.type === "agent-msg"
  );

  const tail = tailSpec(filtered, nSpec);
  if (tail === null) {
    // Unreachable now that nSpec is validated to ^[0-9]+$ above — kept as a
    // defensive fallback matching the Bash `tail` error path (see PORT-NOTE).
    io.stderr(`chat: invalid history count: ${nSpec}\n`);
    return 1;
  }

  for (const s of tail) {
    const rawContent = s.content;
    const content =
      typeof rawContent === "string" ? stripTrailingNewlines(rawContent) : ""; // `.content // empty`
    if (content === "") continue; // `[[ -z "$content" ]] && continue`

    switch (s.type) {
      case "message": {
        const rawFrom = s.from;
        const msgFrom = rawFrom === undefined || rawFrom === null ? "unknown" : String(rawFrom);
        const rawTo = s.to;
        const msgTo = rawTo === undefined || rawTo === null ? "" : String(rawTo);
        const toDisplay = msgTo === "" ? "?" : msgTo; // `${msg_to:-?}`
        io.stdout(`${msgFrom} → ${toDisplay}: ${content}\n`);
        break;
      }
      case "human-msg": {
        const rawFrom = s.from;
        const mf =
          rawFrom === undefined || rawFrom === null || rawFrom === ""
            ? "you"
            : String(rawFrom); // `${msg_from:-you}`
        io.stdout(`${mf}: ${content}\n`);
        break;
      }
      case "agent-msg":
        io.stdout(`${identityName}: ${content}\n`);
        break;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Message index (design/conversation_memory.md, part 1) + person/thread keys
// (part 2). `chat history --with <name>`: this person's conversation with us,
// grouped by person key across every routing name they have used (Slack
// thread names, DM name, phone chat), read from the derived `messages.jsonl`
// index next to the trajectory. `chat history --thread <name>`: every message
// in one Slack channel thread, whoever sent it. Both: the de-duplicated union.
// ---------------------------------------------------------------------------

interface HistoryIndexedArgs {
  withArg: string;
  threadArg: string;
  sinceArg: string;
  n: number;
  asJson: boolean;
  identityName: string;
}

/**
 * PORT-NOTE (bug #47): upstream's `--since` value goes through `_duration_s`
 * (bin/chat:350-357), which only evaluates a `d`/`h`/`m`-suffixed spec
 * arithmetically; an `s`-suffixed or bare (no-suffix) spec is passed through
 * VERBATIM, unvalidated (`${1%s}` / plain `printf '%s' "$1"`), straight into
 * `jq -cn --argjson since "$since_s" ...` (bin/chat:405-406). `--argjson`
 * requires its value to be valid JSON text; a spec like "bogus" (ends in
 * "s") strips to "bogu" — not valid JSON — and jq dies: "jq: invalid JSON
 * text passed to --argjson", exit 2 (verified directly: `jq -cn --argjson x
 * "bogu" '.'` -> that exact message, status 2). The port's `durationSeconds`
 * silently fell back to 0 for ANY unparseable spec, so `--since bogus`
 * quietly proceeded with no cutoff instead of dying — see
 * PARITY.md's chat row and parity/fuzz/findings/chat-1.md (jq's own
 * multi-line trailer text is not reproduced — see that PARITY.md row for
 * why; only jq's exit code (2) is matched, with the port's own clean
 * message on stderr).
 *
 * This ONLY covers the s-suffix/no-suffix verbatim-passthrough class (what
 * chat-1 reproduces); a `d`/`h`/`m`-suffixed spec with a non-numeric prefix
 * (e.g. "bogusd") goes through REAL bash arithmetic instead — a different,
 * not-yet-triaged crash class — and is intentionally left alone here
 * (`durationSeconds` still handles it via its existing regex/fallback).
 */
function sinceArgCrashesLikeBash(spec: string): boolean {
  if (/^-?\d+[dhms]$/.test(spec)) return false; // durationSeconds' own numeric path
  if (/[dhm]$/.test(spec)) return false; // real-arithmetic path — different bug class, not this one
  const verbatim = spec.endsWith("s") ? spec.slice(0, -1) : spec; // "${1%s}" / printf "$1"
  return !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(verbatim); // not valid JSON --argjson would accept
}

function cmdHistoryIndexed(io: ChatIO, a: HistoryIndexedArgs): number {
  // `tf=$(traj path "${ROOT_TRAJ_ID:-$TRAJ_ID}") || tf=""` — the SAME flexible
  // resolution `traj` itself uses (exact path, `<dir>/<id>/trajectory.jsonl`,
  // or a `<hex8>-*` directory glob), NOT the narrow `<hex8>-root` convention
  // `rootFile()` assumes for send/reply/legacy history (those always run
  // against an `identity new`-shaped tree; `chat history --with` does not).
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) die("history: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  indexUpdate(tf, idx, io.stderr);
  if (!fs.existsSync(idx)) {
    if (a.asJson) io.stdout("[]\n");
    return 0;
  }

  let keys: string[] = [];
  if (a.withArg !== "") {
    const key = personKey(a.withArg);
    keys = personAliases(io.env.MEM_DIR, key, io.cwd);
  }

  let tkey = "";
  if (a.threadArg !== "") {
    tkey = a.threadArg.startsWith("slack-thread:") ? a.threadArg : threadKey(a.threadArg);
  }

  if (a.sinceArg !== "" && sinceArgCrashesLikeBash(a.sinceArg)) {
    throw new ChatExit(2, `history: --since ${a.sinceArg}: invalid duration`);
  }
  const sinceSeconds = a.sinceArg !== "" ? durationSeconds(a.sinceArg) : 0;

  const messages = queryHistory(idx, {
    me: a.identityName,
    keys,
    threadKey: tkey,
    sinceSeconds,
    n: a.n,
  });

  if (a.asJson) {
    io.stdout(JSON.stringify(messages) + "\n");
    return 0;
  }
  // The text-mode jq call is `jq -cn ... | if $json==1 then . else .[] |
  // "..." end` — no `-r`, so each rendered line is a jq STRING VALUE and gets
  // JSON-encoded (quoted, backslash-escaped) on the way out, not printed raw.
  // JSON.stringify matches jq's string encoding except for the DEL control
  // character (code point 127), which jq backslash-escapes and
  // JSON.stringify leaves literal — the same documented deviation class as
  // context.ts's DEL-escaping note.
  for (const m of messages) {
    const ts = m.ts ?? "?";
    io.stdout(JSON.stringify(`${ts} ${m.from} → ${m.to}: ${m.content}`) + "\n");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// chat pending (design/conversation_memory.md, part 5 — 2fed66c). Every
// responder deferral (DEFER:) that no observation has resolved yet, oldest
// first, read from deferrals.jsonl beside messages.jsonl (built by the same
// indexUpdate pass — see messageIndex.ts).
// ---------------------------------------------------------------------------

function cmdPending(io: ChatIO, args: string[]): number {
  let maxAge = "";
  let asJson = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--max-age") {
      maxAge = required(args[i + 1], "--max-age requires a duration like 14d");
      i += 2;
    } else if (a === "--json") {
      asJson = true;
      i += 1;
    } else {
      die(`pending: unknown argument '${a}'`);
    }
  }

  // `tf=$(traj path "${ROOT_TRAJ_ID:-$TRAJ_ID}") || tf=""` — the same
  // flexible resolution cmdHistoryIndexed uses (rootFile() assumes the
  // narrower `<hex8>-root` convention, which pending does not).
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) die("pending: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  indexUpdate(tf, idx, io.stderr); // best-effort — `_index_update ... || true`
  const dfr = deferralsPath(idx);
  if (!fs.existsSync(dfr)) {
    if (asJson) io.stdout("[]\n");
    return 0;
  }

  // PORT-NOTE (1c: 2fed66c): --max-age goes through the same `_duration_s`
  // helper as `chat history --since` (bug #47's crash class, sinceArgCrashesLikeBash
  // above): a spec with no d/h/m/s suffix (or an s-suffixed spec whose
  // stripped prefix isn't valid JSON) is passed VERBATIM into jq's
  // `--argjson max`, which dies with its own "invalid JSON text" error under
  // `set -euo pipefail` — exit 2. The port matches the exit code with its
  // own clean message; jq's multi-line trailer text is not reproduced.
  if (maxAge !== "" && sinceArgCrashesLikeBash(maxAge)) {
    throw new ChatExit(2, `pending: --max-age ${maxAge}: invalid duration`);
  }
  const maxAgeSeconds = maxAge !== "" ? durationSeconds(maxAge) : 0;

  const pending = queryPending(dfr, { maxAgeSeconds });

  if (asJson) {
    io.stdout(
      JSON.stringify(
        pending.map((p) => ({
          trigger_step: p.trigger_step,
          person: p.person,
          request: p.request,
          ts: p.ts,
          age_s: p.age_s,
        }))
      ) + "\n"
    );
    return 0;
  }

  // `-r` (raw) output: unquoted text lines, unlike `history`'s text mode.
  for (const p of pending) {
    const ts = p.ts ?? "?";
    const person = p.person ?? "someone";
    io.stdout(
      `${ts} ${person}: ${p.request} (pending ${pendingAgeText(p.age_s)}, trigger ${p.trigger_step})\n`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// chat sent (sync 2e39a3f, 6b6b342/9dc7926) — the identity's outbound messages, newest first, each
// with what the bridge reported back: delivered, failed (with the reason), skipped, pending (a
// transport that confirms deliveries has not yet), or unconfirmed (a transport with no delivery
// notices, e.g. the phone chat). The sent folder the mind checks before sending again
// (design/outbound_delivery.md, part 5). Slack confirms; Telegram's bridge can but runs read-only
// against the trajectory on a production box, so its sends read `unconfirmed` (SENT_CONFIRMING_RE).
// ---------------------------------------------------------------------------

function sentRows(io: ChatIO, since: string, n: number, notify: (s: string) => void): Array<Record<string, unknown>> {
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) die("sent: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  indexUpdate(tf, idx, notify);
  if (!fs.existsSync(idx)) return [];
  // `[[ -f "$dlv" ]] || : > "$dlv"`
  const dlv = deliveriesPath(idx);
  if (!fs.existsSync(dlv)) fs.writeFileSync(dlv, "");
  return querySent(idx, {
    me: io.env.IDENTITY_NAME || "agent",
    sinceSeconds: since !== "" ? durationSeconds(since) : 0,
    n,
  });
}

/**
 * `chat sent --since <since> -n <n> --json` as rows, for the wake prompt's own sections
 * (thinkers/_lib/common.sh `_outbound_section`, `_schedule_signals`). The monolith runs in the
 * same process as the trajectory it reads, so it calls this instead of spawning `chat`; the
 * result is exactly what `sentJson` would print. Throws when the trajectory is missing, the
 * way `chat sent` dies (the caller leaves the section out).
 */
export function sentRowsForTrajectory(
  trajFile: string,
  me: string,
  since: string,
  n: number,
  now?: () => number,
): Array<Record<string, unknown>> {
  if (!fs.existsSync(trajFile)) throw new Error("sent: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(trajFile), "messages.jsonl");
  indexUpdate(trajFile, idx);
  if (!fs.existsSync(idx)) return [];
  const dlv = deliveriesPath(idx);
  if (!fs.existsSync(dlv)) fs.writeFileSync(dlv, "");
  return querySent(idx, {
    me: me || "agent",
    sinceSeconds: since !== "" ? durationSeconds(since) : 0,
    n,
    ...(now ? { now } : {}),
  });
}

function cmdSent(io: ChatIO, args: string[]): number {
  let since = "";
  let nSpec = "50";
  let asJson = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--since") {
      since = required(args[i + 1], "--since requires a duration like 24h");
      i += 2;
    } else if (a === "-n") {
      nSpec = required(args[i + 1], "-n requires a count");
      i += 2;
    } else if (a === "--json") {
      asJson = true;
      i += 1;
    } else {
      die(`sent: unknown argument '${a}'`);
    }
  }
  if (!/^[0-9]+$/.test(nSpec)) die(`sent: count must be a number, got '${nSpec}'`);
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) die("sent: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  const rows = sentRows(io, since, Number(nSpec), io.stderr);
  if (!fs.existsSync(idx)) {
    if (asJson) io.stdout("[]\n");
    return 0;
  }
  if (asJson) {
    io.stdout(sentJson(rows) + "\n");
    return 0;
  }
  // `jq -rcn` with `.[] | "…"` — raw text lines
  for (const line of sentText(rows)) io.stdout(line + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// chat index-reset --offline (sync 2e39a3f, 2422d1b). Operator recovery after every chat caller
// has stopped: the index can hold partial writes after SIGKILL, so ALL derived files go, not just
// the lock. Refuses a symlinked lock, a lock with unknown contents, and a still-running holder.
// ---------------------------------------------------------------------------

function cmdIndexReset(io: ChatIO, args: string[]): number {
  if (!(args.length === 1 && args[0] === "--offline"))
    die("index-reset requires --offline: stop all chat callers before resetting the index (see docs/chat-index-recovery.md)");
  const tf = resolveTrajFile(io.env.TRAJ_DIR ?? "", rootId(io));
  if (tf === undefined || !fs.existsSync(tf)) die("index-reset: cannot resolve the root trajectory file");
  const idx = path.join(path.dirname(tf), "messages.jsonl");
  const lock = `${idx}.lock`;
  try {
    if (fs.lstatSync(lock).isSymbolicLink()) die("index-reset: refusing a symlinked lock");
  } catch (e) {
    if (e instanceof ChatExit) throw e;
    /* absent: fine */
  }
  try {
    fs.mkdirSync(lock);
  } catch {
    let isDir = false;
    try {
      isDir = fs.statSync(lock).isDirectory();
    } catch {
      /* not a dir */
    }
    if (!isDir) die("index-reset: cannot create lock");
  }
  // Unknown contents are not ours to remove. Never recursively delete a lock. The owner record is
  // ours; a holder that is still running is not offline.
  let contents: string[];
  try {
    contents = fs.readdirSync(lock);
  } catch {
    die("index-reset: cannot inspect lock directory");
  }
  if (contents.length === 1 && contents[0] === "owner") {
    if (!indexLockAbandoned(lock)) die(`index-reset: the lock holder is still running (see ${lock}/owner)`);
    try {
      fs.rmSync(path.join(lock, "owner"), { force: true });
    } catch {
      die("index-reset: cannot remove the owner record");
    }
    contents = [];
  }
  if (contents.length > 0) die("index-reset: lock directory is not empty");
  let failed = false;
  for (const f of [`${idx}.offset`, idx, deferralsPath(idx), deliveriesPath(idx)]) {
    try {
      // `rm -f` (no -r): a directory in the way is an error, a missing file is not
      if (fs.lstatSync(f).isDirectory()) throw new Error("is a directory");
      fs.unlinkSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
    }
  }
  if (failed) die("index-reset: could not remove derived indexes; lock retained");
  for (const f of [`${idx}.offset.new`, `${idx}.trim`]) fs.rmSync(f, { force: true });
  try {
    fs.rmdirSync(`${lock}.steal`);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(lock);
  } catch {
    die("index-reset: could not remove lock");
  }
  io.stdout("Chat indexes reset. The next history, pending, or sent read will rebuild them.\n");
  return 0;
}

// `cmd_person_key() { _person_key "$1"; echo; }` — `_person_key` itself
// already prints a trailing newline (`jq -Rr`), and the bare `echo` after it
// prints a SECOND one: real output is "<key>\n\n", not "<key>\n". Same for
// `cmd_thread_key`. A real quirk, not a typo — replicated byte-for-byte.
function cmdPersonKey(io: ChatIO, args: string[]): number {
  const name = args[0] ?? "";
  if (name === "") die("Usage: chat person-key <name>");
  io.stdout(personKey(name) + "\n\n");
  return 0;
}

function cmdThreadKey(io: ChatIO, args: string[]): number {
  const name = args[0] ?? "";
  if (name === "") die("Usage: chat thread-key <name>");
  io.stdout(threadKey(name) + "\n\n");
  return 0;
}

// TRANSPORT-DEPENDENT GAP (tracked, not silently stubbed):
// `chat repl` hands off to an external interactive TUI. We faithfully preserve
// the dispatch + exec contract (prefer `headlong-tui`; else exec `shellm-tui`),
// but that TUI binary is NOT shipped in this port slice — so the command only
// works where such a binary is already on PATH; otherwise it exits 127 like the
// Bash `exec shellm-tui` fallback would when the binary is absent.
function cmdRepl(io: ChatIO, args: string[]): number {
  if (io.hasCommand("headlong-tui")) return io.execInherit("headlong-tui", args);
  return io.execInherit("shellm-tui", args);
}

// ---------------------------------------------------------------------------
// Usage — printed verbatim (Bash heredoc is single-quoted: no expansion).
// ---------------------------------------------------------------------------

const USAGE = `chat — Messaging for an activated identity

Usage:
  chat send [--from <name>] [--to <name>] [--source-url <url>] [--key <key>] [--force] <message>
                             Send a message (from defaults to .chatrc
                             default_send_from, to defaults to $IDENTITY_NAME).
                             Refuses a message identical to one sent to the
                             same destination in the last 24h
                             (CHAT_REPEAT_WINDOW) unless --force. Only the
                             identity's own sends are checked; a person's
                             message delivered in is never refused.
                             --key names the one duty this send fulfils;
                             a second send with the same key is refused.
                             A slack-* destination must be a form the bridge
                             delivers: slack-<user>-<channel>[-<ts>],
                             slack-C<id> (channel), or slack-U<id> (DM)
  chat send-file [--from <name>] [--to <name>] <file>
                             Send a file's contents as a message
  chat react [--reply-to <step_id>] [--source-url <url>] <to_name> <emoji>
                             Add a Slack emoji reaction (name, not unicode).
                             Stamps reaction on a chat-sourced message step.
  chat reply [--reply-to <step_id>] [--follow-up] [--force] <to_name> <message>
                             Agent sends a reply (from is $IDENTITY_NAME).
                             Stamps reply_to with the step it answers —
                             inferred (latest unanswered message from
                             <to_name>) unless --reply-to overrides.
                             --follow-up: a deliberate second reply to an
                             already answered message (delivering work the
                             first reply promised); skips the duplicate
                             guard and marks the step follow_up:true.
                             --force: send even if the same text already
                             went to <to_name> in the last 24h (only a
                             reply that answers no specific inbound is
                             checked; answers are exempt).
  chat sent [--since 24h] [-n N] [--json]
                             Outbound messages, newest first, with what the
                             bridge reported back: delivered, failed (with
                             the reason), skipped, pending (no confirmation
                             yet from a bridge that sends them), or
                             unconfirmed (a transport that never does).
                             From deliveries.jsonl beside messages.jsonl
  chat history [N]           Show last N messages (default 20)
  chat history --with <name> [--since 7d] [-n N] [--json]
                             This person's conversation with the identity,
                             grouped by person key across all their routing
                             names, from the messages.jsonl index next to the
                             trajectory (derived, self-maintaining; the
                             trajectory stays the source of truth)
  chat history --thread <name> [--since 1d] [-n N] [--json]
                             Every message in that Slack thread, whoever
                             sent it (combine with --with for the union)
  chat pending [--max-age 14d] [--json]
                             Requests the responder deferred to the mind
                             (DEFER) that no observation has resolved yet,
                             oldest first, from the deferrals.jsonl index
                             beside messages.jsonl. The mind delivers one
                             with \`chat reply --follow-up --reply-to
                             <trigger> <person>\` and closes it with an
                             observation carrying resolves=<trigger>
  chat index-reset --offline
                             Reset derived indexes after stopping ALL chat callers.
                             See docs/chat-index-recovery.md before use.
  chat person-key <name>     Print the stable person key for a routing name
                             (slack-U..-C..-ts -> slack:U..; pwa-x -> pwa:x)
  chat thread-key <name>     Print the thread key (Slack channel threads
                             only; empty for DMs, phone chat, Telegram)
  chat repl                  Interactive chat (shows agent replies inline)

Config file ($CHATRC, default ./.chatrc):
  default_send_from=<name>   Default --from for \`chat send\`

Environment:
  CHATRC          Path to config file (default: ./.chatrc)
  CHAT_REPEAT_WINDOW  How far back \`send\`/\`reply\` look for an identical
                  message to the same destination (default 24h; 0 disables)
  CHAT_REPLY_REPEAT_WINDOW
                  How far back a stamped \`reply\` looks for the same answer
                  to the same person (default 10m; 0 disables)
  TRAJ_DIR        Trajectory directory (set by \`identity shell\`)
  TRAJ_ID         Trajectory ID (set by \`identity shell\`)
  IDENTITY_NAME   Identity name (for reply attribution and --to default)
  IDENTITY_DIR    Identity directory (for repl history)
  MEM_DIR         Memories dir; \`type: person\` memories with \`person_key\`
                  and \`aliases\` merge several keys into one person for
                  history --with
  CHAT_SEND_FILE_MAX_BYTES
                  Max file size for \`chat send-file\` (default 10485760)
`;

function usage(io: ChatIO): number {
  io.stdout(USAGE);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point — env gate, then dispatch. Returns the process exit code.
// ---------------------------------------------------------------------------

export function runChat(argv: string[], io: ChatIO): number {
  const cmd = argv[0] ?? "";
  const rest = argv.slice(1);

  try {
    // Env gate for EVERYTHING except the help forms — so bare `chat` and an
    // unknown command still die on a missing TRAJ_DIR/TRAJ_ID first (quirk).
    if (cmd !== "-h" && cmd !== "--help" && cmd !== "help") {
      if (io.env.TRAJ_DIR === undefined || io.env.TRAJ_DIR === "")
        die("TRAJ_DIR not set. Run: identity shell <name>");
      if (io.env.TRAJ_ID === undefined || io.env.TRAJ_ID === "")
        die("TRAJ_ID not set. Run: identity shell <name>");
    }

    switch (cmd) {
      case "send":
        return cmdSend(io, rest);
      case "send-file":
        return cmdSendFile(io, rest);
      case "react":
        return cmdReact(io, rest);
      case "reply":
        return cmdReply(io, rest);
      case "history":
        return cmdHistory(io, rest);
      case "index-reset":
        return cmdIndexReset(io, rest);
      case "pending":
        return cmdPending(io, rest);
      case "sent":
        return cmdSent(io, rest);
      case "person-key":
        return cmdPersonKey(io, rest);
      case "thread-key":
        return cmdThreadKey(io, rest);
      case "repl":
        return cmdRepl(io, rest);
      case "-h":
      case "--help":
      case "help":
        return usage(io);
      case "":
        return usage(io);
      default:
        die(`Unknown command: ${cmd} (try chat --help)`);
    }
  } catch (e) {
    if (e instanceof ChatExit) {
      if (e.rawMsg !== undefined) io.stderr(`${e.rawMsg}\n`);
      else if (e.dieMsg !== undefined) io.stderr(`chat: error: ${e.dieMsg}\n`);
      return e.code;
    }
    throw e;
  }
}
