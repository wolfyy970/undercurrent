// extract.test.ts — direct tests for the one-bash-block contract (SPEC §1.5,
// bin/shellm extract_reasoning / extract_code / truncate_output). Untested
// before (M4): the branchy heredoc / multi-block / no-fence paths only ran
// indirectly on replay responses that always held a single well-formed block,
// so every quirk survived mutation. The file header says "parity depends on
// them" — these guard them.

import { describe, it, expect } from "vitest";
import { extractCode, extractReasoning, truncateOutput, applyStopAfterCodeBlock } from "../src/extract.js";

describe("extractCode — first fenced block, heredoc-aware, multi-block truncation", () => {
  it("returns a single well-formed block verbatim, not truncated", () => {
    const r = extractCode("```bash\necho hi\n```");
    expect(r.code).toBe("echo hi");
    expect(r.truncated).toBe(false);
  });

  it("keeps only the FIRST block and prepends the truncation notice on a second", () => {
    const r = extractCode("```bash\necho one\n```\nprose\n```bash\necho two\n```");
    expect(r.truncated).toBe(true);
    expect(r.code).toBe(
      'echo "[rest of model response truncated after first code block]" >&2\necho one'
    );
    expect(r.code).not.toContain("echo two");
  });

  it("does NOT let a bare ``` inside a heredoc body close the block early", () => {
    const resp = "```bash\ncat <<EOF\n```\nstill inside\nEOF\necho after\n```";
    const r = extractCode(resp);
    // The ``` on the 3rd line is heredoc content, not a closing fence.
    expect(r.code).toBe("cat <<EOF\n```\nstill inside\nEOF\necho after");
    expect(r.truncated).toBe(false);
  });

  it("with no fence at all, strips [cmd]/[thought] marker lines, prepends the no-fence notice, and runs the rest", () => {
    // PORT-NOTE (1c: d64d420): a reply with no bash block and real content is
    // about to be run as ONE shell command; the notice explains that and how
    // to end a run instead, so a weaker model can correct instead of stalling.
    const r = extractCode("[thought]\nI will run it\n[cmd]\necho hi");
    expect(r.code).toBe(
      "printf '%s\\n' '[shellm: your reply had no ```bash code block, so your whole message was run as one shell command and most likely failed. Put commands inside a ```bash block. To END the run, set FINAL=\"your handoff sentence\" inside a ```bash block. Do not finish with a bare sentence outside a block.]' >&2\nI will run it\necho hi"
    );
    expect(r.truncated).toBe(false);
  });

  it("a plain sentence with no fence at all also gets the no-fence notice", () => {
    const r = extractCode("Idle, nothing to do now.");
    expect(r.code.startsWith("printf '%s\\n' '[shellm: your reply had no")).toBe(true);
    expect(r.code.endsWith("Idle, nothing to do now.")).toBe(true);
  });

  it("an empty-but-present fence pair also falls back to the whole response with the no-fence notice", () => {
    // bash's own `[[ -z "$code" ]]` can't distinguish "no fence" from "fence
    // closed with nothing inside" — both fall back to the raw response.
    const r = extractCode("```bash\n```\nFINAL=\"done\"");
    expect(r.code).toContain("printf '%s\\n' '[shellm: your reply had no");
    expect(r.code.endsWith('```bash\n```\nFINAL="done"')).toBe(true);
  });

  it("a blank whole response never gets the no-fence notice (nothing to run)", () => {
    const r = extractCode("");
    expect(r.code).toBe("");
  });

  it("a whole response of only whitespace/markers never gets the no-fence notice (nothing to run)", () => {
    const r = extractCode("[thought]\n[cmd]\n   \n");
    expect(r.code).not.toContain("printf");
  });
});

describe("extractCode — fenceless reply keeps its leading blank lines", () => {
  // Parser comparison on a literal string, no model. Upstream's `code=$(printf '%s\n' "$response" | awk …)`
  // (bin/shellm:2081-2085) drops trailing newlines only; checked against the real function in parity/extract.
  it("keeps leading newlines and drops trailing ones before the no-fence notice is prepended", () => {
    const { code } = extractCode("\n\necho leading-blank\n\n");
    expect(code.endsWith("\n\n\necho leading-blank")).toBe(true);
  });
});

describe("extractReasoning — prose before the first shell fence", () => {
  // Parser comparison on literal strings, no model. Expected values are what upstream's
  // `reasoning=$(extract_reasoning "$response")` (bin/shellm:3027) yields: the command substitution drops every
  // trailing newline and nothing else (checked against the real function in parity/extract/run-parity.mjs).
  it("drops every trailing newline, as upstream's command substitution does", () => {
    expect(extractReasoning("I need to write plain bash.\n\n```bash\nls\n```")).toBe("I need to write plain bash.");
    expect(extractReasoning("\n\n```bash\nls\n```")).toBe("");
    expect(extractReasoning("just prose\n\n\n")).toBe("just prose");
  });
  it("keeps leading newlines and trailing spaces (a command substitution strips only trailing \\n)", () => {
    expect(extractReasoning("\n\nprose\n\n```bash\nls\n```")).toBe("\n\nprose");
    expect(extractReasoning("prose  \n```bash\nls\n```")).toBe("prose  ");
  });
  it("stops at a line-start ```bash fence", () => {
    expect(extractReasoning("thinking here\nmore\n```bash\necho hi\n```")).toBe("thinking here\nmore");
  });

  it("stops at a grok-style ```bash appended to the end of a prose line", () => {
    expect(extractReasoning("Let me run this ```bash")).toBe("Let me run this");
  });

  it("does NOT stop at a non-shell fence like ```json", () => {
    expect(extractReasoning("reasoning\n```json")).toBe("reasoning\n```json");
  });
});

// PORT-NOTE (bug #69, bin/shellm:105-108,1565; bin/llm 2d1c1c3) —
// applyStopAfterCodeBlock is the non-streaming-completion analogue of
// bin/llm's LLM_STOP_AFTER_CODE_BLOCK cut, used by src/shellm.ts's
// runShellm so the in-process LlmClient.complete() path sees the same
// assistant text upstream's streamed-and-cut `llm` would have kept.
describe("applyStopAfterCodeBlock — bug #69 (bin/llm _fs_line/_fs_feed non-streaming port)", () => {
  it("a block + trailing prose + a second FINAL block: cuts right after the first block's closing fence", () => {
    const text =
      'Doing step one.\n```bash\necho "step one"\n```\n' +
      'Great, step one worked. Now finishing.\n```bash\nFINAL="premature"\n```\n';
    const r = applyStopAfterCodeBlock(text);
    expect(r.stopped).toBe(true);
    expect(r.text).toBe('Doing step one.\n```bash\necho "step one"\n```\n');
    expect(r.text).not.toContain("FINAL");
    expect(r.text).not.toContain("Great, step one worked");
    expect(r.bytes).toBe(Buffer.byteLength(r.text, "utf8"));
  });

  it("a single well-formed block with nothing after it: reports stopped, text unchanged", () => {
    const text = "```bash\necho hi\n```\n";
    const r = applyStopAfterCodeBlock(text);
    expect(r.stopped).toBe(true);
    expect(r.text).toBe(text);
  });

  it("a heredoc containing a fence-looking line inside the first block is not cut early", () => {
    const text =
      "```bash\ncat <<'EOF'\n```\nstill inside\nEOF\necho after\n```\n" +
      "trailing prose that must be dropped\n```bash\necho two\n```\n";
    const r = applyStopAfterCodeBlock(text);
    expect(r.stopped).toBe(true);
    // Kept text runs through the REAL closing fence, heredoc body (including
    // its embedded ``` line) intact, second block and trailing prose gone.
    expect(r.text).toBe("```bash\ncat <<'EOF'\n```\nstill inside\nEOF\necho after\n```\n");
    expect(r.text).not.toContain("trailing prose");
    expect(r.text).not.toContain("echo two");
  });

  it("no fenced block at all: never cut (nothing for the no-fence notice path to see removed)", () => {
    const text = "Idle, nothing to do now.";
    const r = applyStopAfterCodeBlock(text);
    expect(r.stopped).toBe(false);
    expect(r.text).toBe(text);
  });

  it("an unterminated block (never closes before EOF): never cut, kept text unchanged", () => {
    const text = "```bash\necho hi\nno closing fence here";
    const r = applyStopAfterCodeBlock(text);
    expect(r.stopped).toBe(false);
    expect(r.text).toBe(text);
  });
});

describe("truncateOutput — head/tail with a middle stub", () => {
  it("returns input unchanged when within the limit", () => {
    expect(truncateOutput("short", 20)).toBe("short");
  });

  it("keeps max/2 head + max/2 tail and reports the skipped count", () => {
    const r = truncateOutput("A".repeat(50), 20); // half=10, skipped=30
    expect(r).toBe("A".repeat(10) + "\n[... truncated 30 chars ...]\n" + "A".repeat(10));
  });
});
