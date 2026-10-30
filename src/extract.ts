// extract.ts — the one-bash-block contract (SPEC §1.5).
//
// Faithful port of the awk in bin/shellm:
//   extract_reasoning (:279-298) — prose before the first fence.
//   extract_code      (:1417-1535) — the FIRST fenced block only, heredoc-aware,
//     with the "[rest of model response truncated after first code block]"
//     stderr notice prepended when the model emits more than one block.
//
// The behaviour (incl. the truncation notice) is trace-VERIFIED — trace-00 rows
// 20-21 etc. show the exact stderr line inside the executed cmd. Do NOT tidy the
// quirks here; parity depends on them.

import { spawnSync } from "node:child_process";

const OPEN_TAGGED_EOL = /```(?:bash|shell|sh)[ \t]*$/;
const OPEN_LINESTART_ANY = /^```/;
const REASONING_STOP_LINESTART = /^```(?:bash|shell|sh)?(?:[ \t].*)?$/;
const REASONING_STOP_TAGGED_EOL = /```(?:bash|shell|sh)[ \t]*$/;
const BARE_CLOSE = /^```[ \t]*$/;

/** Everything before the first opening code fence becomes the reasoning. */
export function extractReasoning(response: string): string {
  const out: string[] = [];
  for (const line of splitLines(response)) {
    // A bare/shell-tagged line-start fence ends the reasoning, trailing text
    // included. A non-shell fence (```json) does NOT (mid-reasoning example).
    if (REASONING_STOP_LINESTART.test(line)) break;
    const m = line.match(REASONING_STOP_TAGGED_EOL);
    if (m && m.index !== undefined) {
      // ```bash appended to the END of a prose sentence (grok-style): emit the
      // preceding prose, then stop.
      const pre = line.slice(0, m.index).replace(/[ \t]+$/, "");
      if (/\S/.test(pre)) out.push(pre);
      break;
    }
    out.push(line);
  }
  // PORT-NOTE (bug fix): upstream records `reasoning=$(extract_reasoning "$response")` (bin/shellm:3027), and a
  // command substitution drops EVERY trailing newline (only \n; spaces, tabs and leading newlines stay). Without
  // this a reply with a blank line before its fence stored `thought: "…\n"` (or `"\n"` for `""`).
  return out.join("\n").replace(/\n+$/, "");
}

export interface ExtractedCode {
  /** The code to execute (empty only if the whole response is blank). */
  code: string;
  /** True when the model emitted more than one fenced block. */
  truncated: boolean;
}

// PORT-NOTE (1c: d64d420) — the extract_code no-fence notice. A reply with no
// bash block and real content is about to be run as ONE shell command (almost
// always a plain sentence ending the run, or a forgotten fence); the model
// otherwise sees only the raw "command not found" and, on a weaker model,
// repeats the sentence and stalls. Byte-identical to bin/shellm's heredoc
// (single-quoted in bash — the backticks and the FINAL="..." double quotes
// are all literal there too).
const NOFENCE_NOTICE =
  "printf '%s\\n' '[shellm: your reply had no ```bash code block, so your whole message was run as one shell command and most likely failed. Put commands inside a ```bash block. To END the run, set FINAL=\"your handoff sentence\" inside a ```bash block. Do not finish with a bare sentence outside a block.]' >&2";

// ---------------------------------------------------------------------------
// PORT-NOTE (sync 2e39a3f, lane A: 9b7938d, 0d2edf9, 7b528b3, 21a10e7, dcbb9c0)
// Tool-call markup normalization. Qwen- and MiMo-family models sometimes
// answer in their native tool-call markup instead of a ```bash fence
// (`<tool_call><function=bash>…`), which run as-is is a syntax error on the
// first line and wastes the whole turn. upstream's normalize_toolcall_markup
// lifts the code inside the OUTER tags into a fence — only when it parses as
// a complete bash script (`script_parses`) — and tells the model on stderr.
// Ported function-for-function from bin/shellm (script_parses,
// strip_markup_suffix, normalize_toolcall_markup); parity/extract/run-parity.mjs
// runs the real Bash functions against these on a corpus.
// ---------------------------------------------------------------------------

const WS = "[ \\t\\n\r\\f\\v]";
const BLANK = new RegExp(`^${WS}*$`);
const CLOSE_RUN = new RegExp(`(<\\/(tool_call|function|parameter|bash|invoke|function_calls)>${WS}*)+$`);
const CLOSE_RUN_LINE = new RegExp(`^${WS}*(<\\/(tool_call|function|parameter|bash|invoke|function_calls)>${WS}*)+$`);
const PARAM_LINE = new RegExp(`^${WS}*<parameter=[A-Za-z_]+>[^<]*<\\/parameter>${WS}*$`);

/** script_parses (bin/shellm): true when SCRIPT is complete, valid bash.
 *  Never runs model code or startup files. An unclosed heredoc is only a
 *  warning under `bash -n` on some versions, so a diagnostic fails it, and an
 *  unmatched `)` is appended too: if that ALSO parses, the trailer was
 *  swallowed as heredoc data and the script is incomplete. */
export function scriptParses(script: string): boolean {
  const env = { ...process.env, BASH_ENV: "", ENV: "" };
  const run = (input: string) =>
    spawnSync("bash", ["--noprofile", "--norc", "-n"], { input, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  const a = run(script + "\n");
  if (a.status !== 0 || (a.stdout ?? "") + (a.stderr ?? "") !== "") return false;
  const b = run(script + "\n)\n");
  return b.status !== 0;
}

/** strip_markup_suffix (bin/shellm): drop tool-call closing markup from the
 *  END of a script — closing-tag lines, one-line extra parameters
 *  (`<parameter=timeout>30</parameter>`), then the closing tags that end the
 *  last code line. Only the suffix: an interior closing tag is literal data.
 *  Returns the lines joined with "\n" and no trailing newline (the Bash
 *  callers all capture it with `$(…)`). */
export function stripMarkupSuffix(text: string): string {
  const lines = text.split("\n");
  let n = lines.length;
  while (n > 0 && (BLANK.test(lines[n - 1]!) || CLOSE_RUN_LINE.test(lines[n - 1]!) || PARAM_LINE.test(lines[n - 1]!))) n--;
  if (n > 0 && CLOSE_RUN.test(lines[n - 1]!)) {
    lines[n - 1] = lines[n - 1]!.replace(CLOSE_RUN, "");
    while (n > 0 && BLANK.test(lines[n - 1]!)) n--;
  }
  return lines.slice(0, n).join("\n").replace(/\n+$/, "");
}

const OPEN_TAG = /^[ \t\n\r\f\v]*<(tool_call|function=bash|bash)>/;
const STRIP_OPEN = /^[ \t\n\r\f\v]*<(tool_call|function=bash|bash|parameter=(command|cmd|code|commands|script|block))>/;
const shellish = (s: string): boolean => /[<>|$;&=]/.test(s) || s.includes("\\");

function stripOpen(s: string): string {
  for (;;) {
    const m = STRIP_OPEN.exec(s);
    if (!m) return s;
    s = s.slice(m[0].length);
  }
}

export interface NormalizedMarkup {
  /** The (possibly lifted) response; the input unchanged when rc === 1. */
  text: string;
  /** 0 lifted, 2 lifted but later calls were dropped, 1 unchanged — the Bash
   *  function's return code. */
  rc: 0 | 1 | 2;
}

/** normalize_toolcall_markup (bin/shellm). See the section comment above. */
export function normalizeToolcallMarkup(response: string): NormalizedMarkup {
  const unchanged: NormalizedMarkup = { text: response, rc: 1 };
  if (!(response.includes("<tool_call>") || response.includes("<function=") || response.includes("<bash>"))) {
    return unchanged;
  }
  // A stray fence glued to the markup ("```<tool_call>…", closed by a lone
  // ``` line) is markup, not a fence — only when no real fence comes first.
  let markup = response;
  if (markup.includes("```<tool_call>") || markup.includes("```<function=bash>")) {
    const ls = markup.split("\n");
    let seen = false;
    let glued = false;
    const kept: string[] = [];
    for (let l of ls) {
      if (!seen && /^```<(tool_call|function=bash)>/.test(l)) {
        l = l.replace(/^```/, "");
        glued = true;
      }
      if (/^```/.test(l)) seen = true;
      kept.push(l);
    }
    let n = kept.length;
    while (n > 0 && BLANK.test(kept[n - 1]!)) n--;
    if (glued && n > 0 && new RegExp(`^\`\`\`${WS}*$`).test(kept[n - 1]!)) n--;
    markup = kept.slice(0, n).join("\n");
  }
  // A real fence anywhere wins.
  for (const l of markup.split("\n")) {
    if (/^```/.test(l) || new RegExp("```(bash|shell|sh)" + WS + "*$").test(l)) return unchanged;
  }

  // body extraction (the awk in bin/shellm)
  let started = false;
  let body = false;
  let ambiguous = false;
  const out: string[] = [];
  for (let line of markup.split("\n")) {
    if (!started) {
      const m = /<(tool_call|function=bash)>/.exec(line);
      if (m && m.index > 0) {
        const pre = line.slice(0, m.index);
        if (new RegExp(`[.:!?]${WS}*$`).test(pre) && !shellish(pre)) line = line.slice(m.index);
      }
      if (OPEN_TAG.test(line)) {
        started = true;
        const rest = stripOpen(line);
        if (!BLANK.test(rest)) {
          body = true;
          out.push(rest);
        }
      } else if (
        (line.includes("'") || /["`\\<>]/.test(line)) &&
        !(new RegExp(`[.:!?)]${WS}*$`).test(line) && !shellish(line))
      ) {
        ambiguous = true;
      }
      continue;
    }
    if (!body) {
      const rest = stripOpen(line);
      if (BLANK.test(rest)) continue;
      body = true;
      out.push(rest);
      continue;
    }
    out.push(line);
  }
  const bodyText = ambiguous || !started ? "" : out.join("\n").replace(/\n+$/, "");

  // Several calls in one reply: run only the first (rc 2).
  const bl = bodyText.split("\n");
  const l: string[] = [];
  let cut = 0;
  let more = false;
  for (const ln of bl) {
    if (!cut) {
      const m = new RegExp(`<\\/(function|tool_call)>${WS}*<(tool_call|function=bash)>`).exec(ln);
      if (m) {
        l.push(ln.slice(0, m.index));
        cut = l.length;
        more = true;
        continue;
      }
    }
    l.push(ln);
    if (!cut && new RegExp(`<\\/(function|tool_call)>${WS}*$`).test(ln)) {
      cut = l.length;
      continue;
    }
    if (cut && new RegExp(`^${WS}*<(tool_call|function=bash)>`).test(ln)) more = true;
  }
  const first = cut && more ? stripMarkupSuffix(l.slice(0, cut).join("\n")) : stripMarkupSuffix("");
  if (/[^ \t\n\r\f\v]/.test(first) && scriptParses(first)) {
    return { text: "```bash\n" + first + "\n```", rc: 2 };
  }
  const lifted = stripMarkupSuffix(bodyText);
  if (/[^ \t\n\r\f\v]/.test(lifted) && scriptParses(lifted)) {
    return { text: "```bash\n" + lifted + "\n```", rc: 0 };
  }
  return unchanged;
}

// Notices prepended to the executed code (stderr is shown back to the model).
const TOOLCALL_NOTICE =
  "printf '%s\\n' '[shellm: your reply used tool-call markup (angle-bracket function-call tags). This runtime only reads ```bash fences; it lifted your code into one and ran it this time. Next time put the script inside a ```bash block, nothing else: start the reply with a line that is exactly ```bash and end the block with a line that is exactly ```.]' >&2";

/** Extract the FIRST fenced code block (heredoc-aware), per bin/shellm. */
export function extractCode(response: string): ExtractedCode {
  // Qwen/MiMo tool-call markup → lifted into a fence first (sync 2e39a3f).
  let toolcallLifted = false;
  let callsDropped = false;
  const norm = normalizeToolcallMarkup(response);
  if (norm.rc !== 1) {
    response = norm.text;
    toolcallLifted = true;
    callsDropped = norm.rc === 2;
  }

  const lines = splitLines(response);
  const collected: string[] = [];
  let inBlock = false;
  let firstBlockClosed = false;
  let truncated = false;
  const hdStack: string[] = [];

  for (let line of lines) {
    // CRLF input: a trailing \r would survive into the collected code and
    // both break the closing-fence check and hand bash a bad line (2738148).
    line = line.replace(/\r$/, "");
    if (firstBlockClosed && !inBlock) {
      // Another opening fence after the first block closed → signal truncation.
      if (OPEN_TAGGED_EOL.test(line) || OPEN_LINESTART_ANY.test(line)) {
        truncated = true;
        break;
      }
      continue;
    }

    if (!inBlock) {
      if (OPEN_TAGGED_EOL.test(line) || OPEN_LINESTART_ANY.test(line)) {
        inBlock = true;
      }
      // Discard the fence line itself; code begins on the next line.
      continue;
    }

    // Inside the code block.
    if (hdStack.length > 0) {
      const stripped = line.trim();
      if (stripped === hdStack[hdStack.length - 1]) hdStack.pop();
    }
    // A bare ``` closes the fence only when no heredoc is open.
    if (BARE_CLOSE.test(line) && hdStack.length === 0) {
      inBlock = false;
      firstBlockClosed = true;
      continue;
    }
    tryOpenHeredoc(line, hdStack);
    collected.push(line);
  }

  let code = collected.join("\n");

  // MiMo often opens a real ```bash fence and still ends the code with its
  // tool-call closing tags ("done</parameter></function></tool_call>"), a
  // syntax error. Strip that suffix only when it turns a broken script into a
  // valid one (bin/shellm, 7b528b3).
  if (!toolcallLifted && code.includes("</")) {
    const trimmed = stripMarkupSuffix(code);
    if (trimmed !== code.replace(/\n+$/, "") && /[^ \t\n\r\f\v]/.test(trimmed) && !scriptParses(code) && scriptParses(trimmed)) {
      code = trimmed;
      toolcallLifted = true;
    }
  }

  // No fenced blocks at all → use the whole response as code, stripping the
  // older [cmd]/[thought] marker lines (bin/shellm:1528-1530).
  // PORT-NOTE (1c: d64d420): this branch also covers an empty-but-present
  // fence pair (` ```bash\n``` `) — bash's own `[[ -z "$code" ]]` test can't
  // tell "no fence" from "fence closed with nothing inside", so BOTH fall
  // back to the whole response, and both are eligible for the no-fence
  // notice below when that fallback still has real (non-whitespace) content.
  let noFence = false;
  if (code === "") {
    code = splitLines(response)
      .filter((l) => !/^\s*\[cmd\]\s*$/.test(l) && !/^\s*\[thought\]/.test(l))
      .join("\n")
      // PORT-NOTE (bug fix): upstream's `code=$(… | awk …)` drops only TRAILING newlines; leading blank lines stay
      // (bin/shellm:2081-2085). The port used to strip both, so a fenceless DSML reply's recorded `cmd` lost them.
      .replace(/\n+$/, "");
    // PORT-NOTE (sync 2e39a3f, 2738148): harness provenance lines
    // ([served_by]/[exec_s]/[exit]/[stdout]/[stderr]) pasted after a fenceless
    // reply are structure, not code: cut at the first one — but only when the
    // prefix is a complete script (a marker may be literal heredoc/quote data).
    const all = code.split("\n");
    const cutAt = all.findIndex((l) => /^\[(served_by|exec_s|exit|stdout|stderr)\]/.test(l));
    if (cutAt >= 0) {
      const before = all.slice(0, cutAt).join("\n").replace(/\n+$/, "");
      if (before !== code.replace(/\n+$/, "") && scriptParses(before)) code = before;
    }
    noFence = /\S/.test(code);
  }

  // Prepend notices (echoed to stderr, seen next turn) — prepend so they fire
  // even if the code exits early. Order matches bin/shellm's: truncation
  // first, then the tool-call notice, then the no-fence notice outermost.
  if (truncated || callsDropped) {
    code = 'echo "[rest of model response truncated after first code block]" >&2\n' + code;
  }
  if (toolcallLifted) {
    code = TOOLCALL_NOTICE + "\n" + code;
  }
  if (noFence) {
    code = NOFENCE_NOTICE + "\n" + code;
  }

  return { code, truncated: truncated || callsDropped };
}

// try_open_heredoc: inspect a line for <<[-]DELIM and push the delimiter
// (quoted "DELIM", 'DELIM', \DELIM, or bare DELIM). Mirrors bin/shellm:1431-1461.
function tryOpenHeredoc(line: string, hdStack: string[]): void {
  const m = line.match(/<<-?/);
  if (!m || m.index === undefined) return;
  let rest = line.slice(m.index + m[0].length).replace(/^[ \t]*/, "");
  if (rest.startsWith('"')) {
    rest = rest.slice(1);
    const d = rest.match(/^[^"]+/);
    if (d) hdStack.push(d[0]);
  } else if (rest.startsWith("'")) {
    rest = rest.slice(1);
    const d = rest.match(/^[^']+/);
    if (d) hdStack.push(d[0]);
  } else if (rest.startsWith("\\")) {
    rest = rest.slice(1);
    const d = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (d) hdStack.push(d[0]);
  } else {
    const d = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (d) hdStack.push(d[0]);
  }
}

// ---------------------------------------------------------------------------
// PORT-NOTE (1c: 2d1c1c3) — LLM_STOP_AFTER_CODE_BLOCK's incremental fence
// tracker (bin/llm `_fs_line`/`_fs_feed`/`_fs_try_open_heredoc`). Same fence
// rules as extractCode above (an opening ``` line-start or a tagged
// ```bash/```shell/```sh at end-of-line opens; a bare ``` closes only outside
// an open heredoc) but fed the model's TEXT DELTAS incrementally as they
// stream in, rather than the whole response at once — this lets `llm` cut the
// stream (and the caller stop reading) the instant the first code block
// closes, instead of after the whole response has arrived.
// ---------------------------------------------------------------------------

export interface FenceStopTracker {
  /** Feed a just-emitted text delta; returns true once the first code block
   *  has JUST closed (the caller should stop reading further). Once true,
   *  further feed() calls are not made (the caller stops). */
  feed(chunk: string): boolean;
  /** Total bytes (UTF-8) fed so far — bin/llm's `_fs_bytes`, used to
   *  estimate out_tok when the stream was cut before a real usage event
   *  arrived (`(_fs_bytes + 3) / 4`). */
  readonly bytes: number;
}

export function createFenceStopTracker(): FenceStopTracker {
  let buf = "";
  let bytes = 0;
  let inBlock = false;
  const hdStack: string[] = [];

  // _fs_line: one complete line (CR already stripped); true when the first
  // block just closed on this line.
  function feedLine(line: string): boolean {
    if (!inBlock) {
      if (OPEN_TAGGED_EOL.test(line) || OPEN_LINESTART_ANY.test(line)) inBlock = true;
      return false;
    }
    if (hdStack.length > 0) {
      const stripped = line.trim();
      if (stripped === hdStack[hdStack.length - 1]) hdStack.pop();
    }
    if (hdStack.length === 0 && BARE_CLOSE.test(line)) return true;
    tryOpenHeredoc(line, hdStack);
    return false;
  }

  return {
    get bytes() {
      return bytes;
    },
    // _fs_feed: append the chunk, walk any newly-completed lines.
    feed(chunk: string): boolean {
      buf += chunk;
      bytes += Buffer.byteLength(chunk, "utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (feedLine(line)) return true;
      }
      return false;
    },
  };
}

export interface StopAfterCodeBlockResult {
  /** The text upstream's `llm --stop-after-code-block` would have kept: up
   *  through the closing fence line and its trailing newline. Equal to the
   *  input when the first block never closes before the text ends (nothing
   *  to cut, or no fenced block at all). */
  text: string;
  /** True when the first code block actually closed — bin/llm's `_stopped`.
   *  Once true, upstream OVERWRITES the recorded usage with an estimate
   *  from bytes kept (`(_fs_bytes + 3) / 4`) and drops in_tok/think_tok
   *  entirely (write_usage's whole-file rewrite, bin/llm:990-998). */
  stopped: boolean;
  /** UTF-8 bytes of the kept text — bin/llm's `_fs_bytes` at the moment the
   *  block closed (or the full text's byte length when it never did). */
  bytes: number;
}

/**
 * PORT-NOTE (bug #69, bin/shellm:105-108,1565; bin/llm 2d1c1c3) — the
 * in-process path's completion arrives as ONE already-finished string
 * (src/llm.ts's LlmClient.complete() is not a stream), whereas upstream
 * cuts a live SSE stream the instant the first fenced bash block closes
 * (LLM_STOP_AFTER_CODE_BLOCK's `_emit_text`/`_fs_feed`/`_fs_line`). Feeding
 * the full text through createFenceStopTracker() one LINE at a time (rather
 * than the whole string in a single feed() call) reproduces the same cut
 * point: the tracker's fence rules only ever close on a COMPLETE line, so
 * which line closes the block is chunk-size-independent — only how much
 * trailing text leaks through in the same delta as the close depends on
 * real streaming granularity. Real deltas are token-sized, far smaller than
 * one line, so cutting immediately after the closing line's own trailing
 * newline (no extra leaked text) is the faithful non-streaming
 * approximation used here. Used by src/shellm.ts's runShellm, gated on
 * ShellmConstants.stopAfterCodeBlock.
 */
export function applyStopAfterCodeBlock(text: string): StopAfterCodeBlockResult {
  const tracker = createFenceStopTracker();
  const lines = text.split("\n");
  let consumedChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const chunk = isLast ? lines[i]! : lines[i]! + "\n";
    const closed = tracker.feed(chunk);
    consumedChars += chunk.length;
    if (closed) {
      return { text: text.slice(0, consumedChars), stopped: true, bytes: tracker.bytes };
    }
  }
  return { text, stopped: false, bytes: tracker.bytes };
}

/** truncate_output (bin/shellm:237-260) — head/tail with a middle stub. */
export function truncateOutput(input: string, max: number): string {
  if (input.length <= max) return input;
  const half = Math.floor(max / 2);
  const skipped = input.length - max;
  return `${input.slice(0, half)}\n[... truncated ${skipped} chars ...]\n${input.slice(-half)}`;
}

function splitLines(s: string): string[] {
  return s.split("\n");
}
