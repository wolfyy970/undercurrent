// extractToolcall.test.ts — upstream sync 2e39a3f: tool-call markup lifting,
// closing-tag suffix repair, CRLF/provenance handling in extractCode.
//
// Oracle: every case below is lifted from upstream's OWN
// tests/test_extract_code_notice.sh (run by node parity/upstream-tests/run.mjs
// against the real Bash) — expectations are what the Bash's `bash -c "$out"`
// produced there, not what this port emits. parity/extract/run-parity.mjs
// additionally diffs the full output of upstream's real functions (82 cases).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { extractCode, normalizeToolcallMarkup } from "../src/extract.ts";

/** Run extracted code the way the Bash test does: `bash -c "$out"`, script over -c. */
function run(code: string): { out: string; err: string } {
  const r = spawnSync("bash", ["-c", code], { encoding: "utf8" });
  return { out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}
const NOTICE_LIFT = "used tool-call markup";

describe("extractCode — tool-call markup is lifted into a fence (Qwen / MiMo shapes)", () => {
  const lifted: Record<string, string> = {
    canonical: "Let me check.\n<tool_call>\n<function=bash>\necho lifted-canonical\n</function>\n</tool_call>",
    hybrid: "<tool_call>\n<function=bash>\necho lifted-hybrid\n</bash>\n\n</bash>",
    bare: '<tool_call>\necho lifted-bare\nFINAL="done"',
    parameter: "<tool_call>\n<function=bash>\n<parameter=command>\necho lifted-parameter\n</parameter>\n</function>\n</tool_call>",
    inline: "<tool_call><function=bash><parameter=command>echo lifted-inline\necho second</parameter></function></tool_call>",
    cmd_timeout:
      "<tool_call><function=bash><parameter=cmd>echo lifted-cmd_timeout</parameter>\n<parameter=timeout>30</parameter>\n</function></tool_call>",
    prose_prefix:
      "Let me look at the evidence first.<tool_call><function=bash><parameter=command>echo lifted-prose_prefix\n</parameter></function></tool_call>",
    prose_lines:
      "I'll check the `mem add` syntax first.\n\nThat's the plan.<tool_call><function=bash><parameter=command>echo lifted-prose_lines</parameter></function></tool_call>",
    block: "<tool_call>\n<function=bash>\n<parameter=block>echo lifted-block\n</parameter>\n</function>\n</tool_call>",
  };
  for (const [shape, resp] of Object.entries(lifted)) {
    it(`${shape}: lifted, runs, carries the notice`, () => {
      const { out, err } = run(extractCode(resp).code);
      expect(out.startsWith(`lifted-${shape}`)).toBe(true);
      expect(err).toContain(NOTICE_LIFT);
    });
  }

  it("a stray fence glued to the markup is lifted", () => {
    const resp = "```<tool_call><function=bash><parameter=command>echo lifted-glued\n</parameter></function></tool_call>\n```";
    expect(run(extractCode(resp).code).out).toBe("lifted-glued");
  });

  it("a real fence wins over tool-call words in prose", () => {
    const r = extractCode("<tool_call> mentioned in prose\n```bash\necho fence-wins\n```");
    expect(run(r.code).out).toBe("fence-wins");
    expect(r.code).not.toContain(NOTICE_LIFT);
  });
});

describe("extractCode — a fence ending in closing tags is repaired only when it must be", () => {
  for (const [shape, resp] of [
    ["inline_suffix", "Checking.\n```bash\nfor x in a; do\n  echo fenced-$x\ndone</parameter></function></tool_call>\n```"],
    ["tag_lines", "```bash\necho fenced-a\n</parameter>\n</function>\n</tool_call>\n```"],
  ] as const) {
    it(`${shape}: suffix stripped, runs, model told`, () => {
      const { out, err } = run(extractCode(resp).code);
      expect(out).toBe("fenced-a");
      expect(err).toContain(NOTICE_LIFT);
    });
  }

  it("a script valid as written keeps its trailing literal tag (no notice)", () => {
    const code = extractCode("```bash\ncat <<'EOF'\n</tool_call>\nEOF\n```").code;
    expect(run(code).out).toBe("</tool_call>");
    expect(code).not.toContain(NOTICE_LIFT);
  });
});

describe("normalizeToolcallMarkup — ambiguous or incomplete scripts come back unchanged (rc 1)", () => {
  const cases: Record<string, string> = {
    shell_prefix: "x=1; echo done.<tool_call><function=bash><parameter=command>echo DATA\n</parameter></function></tool_call>",
    backslash_prefix: "printf a\\\\b.<tool_call><function=bash><parameter=command>echo DATA\n</parameter></function></tool_call>",
    open_quote: "echo 'intro\n<tool_call>\necho DATA\n</tool_call>'",
    quote: '<tool_call>\nprintf "%s\\n" "unfinished\n</tool_call>',
    heredoc: "<tool_call>\ncat <<EOF\nunfinished\n</tool_call>",
    tag_delimiter: "<tool_call>\ncat <<'</tool_call>'\nliteral body\n</tool_call>\n</tool_call>",
    preamble: "cat <<EOF\n<tool_call>\necho DATA_ONLY\n</tool_call>",
    unknown_tool: '<tool_call>\n<function=python>\nprint("hello")\n</function>\n</tool_call>',
  };
  for (const [shape, resp] of Object.entries(cases)) {
    it(shape, () => {
      const n = normalizeToolcallMarkup(resp);
      expect(n.rc).toBe(1);
      expect(n.text).toBe(resp);
    });
  }
});

describe("extractCode — literal tags stay data; several calls run only the first", () => {
  const scripts: Record<string, string> = {
    heredoc: "cat <<'DATA'\n<tool_call>\n<function=bash>\n<parameter=command>\n<bash>\necho DATA_ONLY\n</bash>\n</parameter>\n</function>\n</tool_call>\nDATA\necho AFTER",
    single: "printf '%s\\n' '<tool_call>\necho DATA_ONLY\n</tool_call>'\necho AFTER",
    double: 'printf \'%s\\n\' "<tool_call>\necho DATA_ONLY\n</tool_call>"\necho AFTER',
  };
  for (const [q, script] of Object.entries(scripts)) {
    const expected = run(script).out;
    it(`unfenced ${q}: literal tags and the trailing command preserved, no notice`, () => {
      const code = extractCode(script).code;
      expect(run(code).out).toBe(expected);
      expect(code).not.toContain(NOTICE_LIFT);
    });
    it(`wrapped ${q}: same output, with the notice`, () => {
      const code = extractCode(`<tool_call>\n<function=bash>\n${script}\n</function>\n</tool_call>`).code;
      expect(run(code).out).toBe(expected);
      expect(code).toContain(NOTICE_LIFT);
    });
  }

  for (const [shape, resp] of [
    ["extra_call", "<tool_call>\necho first\n</tool_call>\n<tool_call>\necho second\n</tool_call>"],
    [
      "mimo_two",
      "Two checks.<tool_call><function=bash><parameter=command>echo first</parameter></function></tool_call>\n<tool_call><function=bash><parameter=command>echo second</parameter></function></tool_call>",
    ],
    [
      "mimo_sameline",
      "<tool_call><function=bash><parameter=command>echo first</parameter></function></tool_call><tool_call><function=bash><parameter=command>echo second</parameter></function></tool_call>",
    ],
  ] as const) {
    it(`${shape}: only the first runs, with both notices`, () => {
      const { out, err } = run(extractCode(resp).code);
      expect(out).toBe("first");
      expect(err).toContain("truncated after first code block");
      expect(err).toContain(NOTICE_LIFT);
    });
  }

  it("a call boundary inside a heredoc is data, not a cut", () => {
    const resp = "<tool_call>\n<function=bash>\ncat <<'DATA'\n</tool_call>\n<tool_call>\nDATA\necho AFTER\n</function>\n</tool_call>";
    expect(run(extractCode(resp).code).out).toBe("</tool_call>\n<tool_call>\nAFTER");
  });

  it("a large fenced literal stays intact (no argv/pipe truncation)", () => {
    const script = "cat <<'DATA'\n<tool_call>\necho DATA_ONLY\n</tool_call>\n" + "# padding 0123456789abcdef\n".repeat(16000) + "DATA\necho AFTER";
    expect(extractCode("```bash\n" + script + "\n```").code).toBe(script);
  });
});
