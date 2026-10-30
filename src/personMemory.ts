// personMemory.ts — person/thread keys and the `type: person` memory lookup
// shared by chat.ts (history --with/--thread, part 1+2) and responder.ts
// (person notes, part 4). Ports bin/chat's `_PERSON_KEY_JQ`, `_person_key`,
// `_thread_key`, and `_person_aliases`, plus thinkers/responder/step's
// `_person_notes_file` / `_notes_body` (design/conversation_memory.md).
//
// PORT-NOTE (1c: 130796a) — this file also carries the two other
// "goal/memory presentation" functions the wake prompt needs (`get_goals`,
// `_related_memories`, `_mem_age`, thinkers/_lib/common.sh): they are memory-
// store readers with no closer home in this port's layout (monolith.ts owns
// wake ASSEMBLY, not memory-file parsing; mem.ts, which owns the BM25
// prefilter these build on, is lane C's file — see its own PORT-NOTE at
// `mem.ts`:28-35 flagging this exact consumption point as lane B's scope).
// `mem.ts`'s exported `extractPrefilterTerms`/`scorePrefilterCandidates` are
// reused as-is (mem.ts itself is untouched).

import {
  frontmatterBlock,
  frontmatterField,
  readMemoryFiles,
  parseMemory,
  extractPrefilterTerms,
  scorePrefilterCandidates,
} from "./mem.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// The chat `from` name is a ROUTING name: a bridge packs everything it needs
// to deliver the reply into it, so one human is many names (a Slack user is a
// new name in every channel thread). The person key is what stays stable:
//   slack-U07AB-C09XYZ-1722400000.123456  ->  slack:U07AB
//   slack-U07AB-D09XYZ                    ->  slack:U07AB
//   telegram-8525624593-8525624593        ->  telegram:8525624593
//   pwa-andy                              ->  pwa:andy
//   Andy                                  ->  Andy
const SLACK_PERSON_RE = /^slack-[A-Za-z0-9]+-[A-Za-z0-9]+(-[0-9.]+)?$/;
const TELEGRAM_RE = /^telegram-[0-9]+-[0-9]+$/;
const PWA_RE = /^pwa-./;
// The thread key is the other axis: which conversation a message sits in,
// whoever sent it. Only Slack channel threads have one (channel + thread ts).
const SLACK_THREAD_RE = /^slack-[A-Za-z0-9]+-[A-Za-z0-9]+-[0-9.]+$/;

// PORT-EXTENSION (team rooms; not in upstream, which has no team transport): a group-room bridge packs the room
// into the routing name the way the Slack bridge packs channel and thread (`slack-<user>-<channel>-<thread_ts>`):
//   room~<room>~<sender>   a post in a room, from <sender>   -> person key <sender>, thread key room:<room>
//   room~<room>            the room itself (a mind's own post) -> thread key room:<room>
// `~` keeps room and sender ids that contain `-` unambiguous. The person key is the plain sender, so one person's
// direct chat and their room posts are one history, as slack:<user> is for a Slack DM and channel thread.
const TEAM_ROOM_RE = /^room~([^~\s]+)(?:~([^~\s]+))?$/;

export function personKey(name: string): string {
  const room = TEAM_ROOM_RE.exec(name);
  if (room) return room[2] ?? name;
  if (SLACK_PERSON_RE.test(name)) return "slack:" + name.split("-")[1];
  if (TELEGRAM_RE.test(name)) return "telegram:" + name.split("-")[1];
  if (PWA_RE.test(name)) return "pwa:" + name.slice(4);
  return name;
}

export function threadKey(name: string): string {
  const room = TEAM_ROOM_RE.exec(name);
  if (room) return "room:" + room[1];
  if (SLACK_THREAD_RE.test(name)) return "slack-thread:" + name.split("-").slice(2).join("-");
  return "";
}

/**
 * Parse a frontmatter `aliases:` field — bracket form (`aliases: [a, b]`) or
 * block-list form (`aliases:` then `  - a` / `  - b` lines) — into a trimmed,
 * unquoted list. `[]` when absent.
 */
export function frontmatterAliases(content: string): string[] {
  const lines = frontmatterBlock(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const bracket = /^aliases:\s*\[(.*)\]/.exec(line);
    if (bracket) {
      const inner = bracket[1]!.trim();
      if (inner === "") return [];
      return inner
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s !== "");
    }
    if (/^aliases:\s*$/.test(line)) {
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === "---") break; // closing fence — never a bullet
        const m = /^\s*-\s*(.*)$/.exec(lines[j]!);
        if (!m) break;
        out.push(stripQuotes(m[1]!.trim()));
      }
      return out;
    }
  }
  return [];
}

function stripQuotes(s: string): string {
  const q = /^["'](.*)["']$/.exec(s);
  return q ? q[1]! : s;
}

/**
 * _person_aliases <key> — every key that means the same person: the key
 * itself, plus (if a `type: person` memory's `person_key` matches it, or its
 * `aliases` list contains it) that memory's own `person_key` and full
 * `aliases` list. Silent ("[key]") when MEM_DIR is unset/absent — mirrors
 * `[[ -n "${MEM_DIR:-}" && -d "$MEM_DIR" ]] || return 0`.
 */
export function personAliases(memDir: string | undefined, key: string, cwd = process.cwd()): string[] {
  const out = new Set<string>([key]);
  if (!memDir) return [...out];
  for (const f of readMemoryFiles(memDir, cwd)) {
    const type = frontmatterField(f.content, "type");
    if (type !== "person") continue;
    const fkey = frontmatterField(f.content, "person_key");
    const aliases = frontmatterAliases(f.content);
    if (fkey === key || aliases.includes(key)) {
      if (fkey) out.add(fkey);
      for (const a of aliases) out.add(a);
    }
  }
  return [...out];
}

export interface PersonMemoryFile {
  path: string;
  content: string;
}

/**
 * _person_notes_file <key> — the `type: person` memory whose `person_key`
 * equals <key> or whose `aliases` list contains <key>, or undefined.
 */
export function findPersonMemoryFile(
  memDir: string | undefined,
  key: string,
  cwd = process.cwd()
): PersonMemoryFile | undefined {
  if (!memDir) return undefined;
  const dir = memDir;
  for (const f of readMemoryFiles(memDir, cwd)) {
    const type = frontmatterField(f.content, "type");
    if (type !== "person") continue;
    const fkey = frontmatterField(f.content, "person_key");
    const aliases = frontmatterAliases(f.content);
    if (fkey === key || aliases.includes(key)) {
      return { path: `${dir}/${f.filename}`, content: f.content };
    }
  }
  return undefined;
}

/**
 * _notes_body <file> — the body after the frontmatter fence, with leading
 * blank lines stripped (`sed '/./,$!d'`; trailing blank lines are kept).
 */
export function notesBody(content: string): string {
  const lines = content.split("\n");
  let fences = 0;
  let bodyStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      fences++;
      if (fences === 2) {
        bodyStart = i + 1;
        break;
      }
    }
  }
  const body = fences >= 2 ? lines.slice(bodyStart) : lines;
  let start = 0;
  while (start < body.length && body[start] === "") start++;
  return body.slice(start).join("\n");
}

// ---------------------------------------------------------------------------
// Active goals + related memories (thinkers/_lib/common.sh, 1c: 130796a)
// ---------------------------------------------------------------------------

const GOAL_TYPES = new Set(["goal", "intention", "objective", "todo"]);

/** First 3 non-leading-blank body lines, joined with "\n" ("" when none). */
function bodySnippet(content: string, filename: string): string {
  const body = parseMemory(content, filename).body;
  const lines = body.split("\n");
  let start = 0;
  // `sed '/./,$!d'` drops only lines with NO character; a whitespace-only line has one and stays.
  while (start < lines.length && lines[start]! === "") start++;
  // thinkers/_lib/common.sh:318 `body=$(awk ... | sed ... | head -3)`: a command substitution strips trailing
  // newlines, and every memory file ends in one, so a bullet never carries its own (the port left a blank line
  // between goals in the model's prompt).
  return lines.slice(start, start + 3).join("\n").replace(/\n+$/, "");
}

/**
 * `_mem_age` (thinkers/_lib/common.sh, 1c: 130796a) — "3h" / "5d" / "3w" from
 * a memory's `created:` frontmatter field, else the file's mtime. "" when
 * neither parses. PORT-NOTE: upstream writes `created:` with a bare, local-
 * time `date +"%Y-%m-%d %H:%M:%S"` (mem.ts's own `stampHuman`, no `-u`) but
 * `_mem_age` re-parses it with `date -u -d "$created"` — a real upstream
 * quirk (the naive string is misread as UTC) replicated here by treating
 * `created` as UTC regardless of the box's actual timezone at write time.
 */
export function memAgeText(created: string, mtimeMs: number | undefined, nowMs: number): string {
  let t: number | undefined;
  if (created) {
    const parsed = Date.parse(`${created.replace(" ", "T")}Z`);
    if (!Number.isNaN(parsed)) t = parsed;
  }
  if (t === undefined) {
    if (mtimeMs === undefined) return "";
    t = mtimeMs;
  }
  let d = Math.floor((nowMs - t) / 1000);
  if (d < 0) d = 0;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 14 * 86400) return `${Math.floor(d / 86400)}d`;
  return `${Math.floor(d / 604800)}w`;
}

export interface ActiveGoalsOptions {
  /** GOALS_MAX default 8. */
  max?: number;
  now?: () => number;
}

/**
 * `get_goals` (thinkers/_lib/common.sh, 1c: 130796a) — every goal-family
 * memory (goal, intention, objective, todo), newest first, with its type and
 * age, capped at `max` plus a count of the rest. A memory with a past
 * `until:` (frontmatter, `mem add --until`) is dropped. "(no goals set)" when
 * none qualify.
 */
export function activeGoalsSection(memDir: string, opts: ActiveGoalsOptions = {}): string {
  const max = opts.max ?? 8;
  const now = opts.now ?? (() => Date.now());
  const nowMs = now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const files = readMemoryFiles(memDir); // ascending filename (= chronological) order
  let goals = "";
  let shown = 0;
  let hidden = 0;
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i]!;
    const ftype = frontmatterField(f.content, "type");
    if (!GOAL_TYPES.has(ftype)) continue;
    const until = frontmatterField(f.content, "until");
    if (until && until < today) continue;
    const body = bodySnippet(f.content, f.filename);
    if (!body) continue;
    if (shown >= max) {
      hidden++;
      continue;
    }
    const created = frontmatterField(f.content, "created");
    let mtimeMs: number | undefined;
    try {
      mtimeMs = fs.statSync(path.join(memDir, f.filename)).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    const age = memAgeText(created, mtimeMs, nowMs);
    let tag = ftype;
    if (age) tag += `, ${age}`;
    if (until) tag += `, until ${until}`;
    goals += `- [${tag}] ${body}\n`;
    shown++;
  }
  if (goals === "") return "(no goals set)";
  if (hidden > 0) goals += `- and ${hidden} more: mem list --type goal (also intention, objective, todo)`;
  return goals;
}

/** Prompt-boilerplate words stripped from the related-memories query before
 *  it reaches the prefilter, or every timer wake matches the same hub notes
 *  ("pick what best serves the mind right now") — `_RELATED_STOPWORDS`
 *  (thinkers/_lib/common.sh, 1c: 130796a), case-insensitive exact match. */
const RELATED_STOPWORDS = new Set([
  "mind", "pick", "best", "serves", "right", "now", "special", "signals",
  "pending", "request", "responder", "already", "told", "would", "back",
  "waiting", "strongly", "prefer", "doing", "work", "timer", "wake", "inner",
  "life", "deliver", "result", "exactly", "chat", "reply", "follow-up",
  "reply-to", "append", "observation", "field", "resolves", "filed", "note",
  "notes", "path", "workdir", "research-portfolio", "next", "evidence",
  "only", "did", "live", "paper", "type", "content", "source", "monolith",
  "final", "step_id", "run_id", "true", "false", "null", "https", "http",
  "com", "github", "slack", "telegram", "nick", "audel",
]);

export interface RelatedMemoriesOptions {
  /** MONOLITH_RELATED_MEMORIES default 3. */
  n?: number;
  /** RELATED_FRESH_S default 86400 (a day). */
  freshSeconds?: number;
  now?: () => number;
}

/**
 * `_related_memories` (thinkers/_lib/common.sh, 1c: 130796a) — up to `n`
 * one-line pointers into the memory store (name, type, age, first body
 * sentence), scored against `query` with the same BM25 keyword stage `mem
 * prefilter` exposes (no model call). Skips memories under a day old (already
 * in the recent stream) and any name in `prevNames` (what the previous wake
 * already showed). "" when nothing scores.
 */
export function relatedMemories(
  memDir: string,
  query: string,
  prevNames: string[],
  opts: RelatedMemoriesOptions = {}
): string {
  const n = opts.n ?? 3;
  if (n <= 0) return "";
  const now = opts.now ?? (() => Date.now());
  const nowMs = now();
  const fresh = opts.freshSeconds ?? 86400;

  // Strip prompt-boilerplate tokens first (RELATED_STOPWORDS), THEN run the
  // cleaned string through mem_prefilter's own tokenizer/stopwords/BM25 —
  // matches upstream's two-stage `tr | grep -vxiE | ... | mem prefilter`.
  const rawTokens = query.toLowerCase().split(/[^a-z0-9_#@.-]+/).filter(Boolean);
  const cleaned = rawTokens.filter((t) => !RELATED_STOPWORDS.has(t)).join(" ");
  if (cleaned.trim() === "") return "";

  const terms = extractPrefilterTerms(cleaned);
  if (terms.length === 0) return "";

  const files = readMemoryFiles(memDir);
  if (files.length === 0) return "";
  const byName = new Map(files.map((f) => [f.filename, f]));
  const scored = scorePrefilterCandidates(
    files.map((f) => ({ name: f.filename, content: Buffer.from(f.content, "utf8") })),
    terms
  );

  let out = "";
  let shown = 0;
  const top = scored.slice(0, n * 4);
  for (const { name: filename } of top) {
    if (shown >= n) break;
    const name = filename.replace(/\.md$/, "");
    if (prevNames.includes(name)) continue;
    const f = byName.get(filename);
    if (!f) continue;
    const created = frontmatterField(f.content, "created");
    let mtimeMs: number | undefined;
    try {
      mtimeMs = fs.statSync(path.join(memDir, filename)).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    const age = memAgeText(created, mtimeMs, nowMs);
    if (age.endsWith("h")) continue; // under a day old — already in the stream
    if (fresh > 86400 && age.endsWith("d")) {
      const days = Number(age.slice(0, -1));
      if (days * 86400 < fresh) continue;
    }
    const ftype = frontmatterField(f.content, "type") || "memory";
    const bodyLines = parseMemory(f.content, filename).body.split("\n");
    let bstart = 0;
    while (bstart < bodyLines.length && bodyLines[bstart]!.trim() === "") bstart++;
    const firstLine = (bodyLines[bstart] ?? "").replace(/^#\s*/, "").slice(0, 140);
    if (!firstLine) continue;
    out += `- ${name} [${ftype}${age ? `, ${age}` : ""}]: ${firstLine}\n`;
    shown++;
  }
  return out;
}
