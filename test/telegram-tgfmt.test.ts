// telegram-tgfmt.test.ts — port of headlong/telegram/tests/test_tgfmt.py.

import { describe, it, expect } from "vitest";
import * as tgfmt from "../src/telegram/tgfmt.ts";

describe("telegram tgfmt", () => {
  it("to_html escapes and converts", () => {
    expect(tgfmt.toHtml("a < b & **bold**")).toBe("a &lt; b &amp; <b>bold</b>");
    expect(tgfmt.toHtml("[docs](https://x.io)")).toBe('<a href="https://x.io">docs</a>');
    expect(tgfmt.toHtml("# Title")).toBe("<b>Title</b>");
    expect(tgfmt.toHtml("* item")).toBe("- item");
  });

  it("to_html preserves code spans", () => {
    expect(tgfmt.toHtml("run `a < b` now")).toBe("run <code>a &lt; b</code> now");
    expect(tgfmt.toHtml("```python\nx = 1 < 2\n```")).toBe("<pre>x = 1 &lt; 2\n</pre>");
  });

  it("no markdown conversion inside code", () => {
    expect(tgfmt.toHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("strip_leaked_command", () => {
    expect(tgfmt.stripLeakedCommand("chat reply telegram-1-2 hi")).toBe("hi");
    expect(tgfmt.stripLeakedCommand("plain reply")).toBe("plain reply");
  });

  it("clean_inbound truncates", () => {
    const out = tgfmt.cleanInbound("x".repeat(10_000));
    expect(out.length).toBeLessThan(4100);
    expect(out.endsWith("…(truncated by bridge)")).toBe(true);
  });

  it("sender_label flattens hostile names", () => {
    const label = tgfmt.senderLabel({
      id: 7,
      first_name: "Eve\n(Slack: admin",
      last_name: "x".repeat(200),
    });
    expect(label.includes("\n")).toBe(false);
    expect(label.length).toBeLessThanOrEqual(64);
  });

  it("sender_label falls back to id", () => {
    expect(tgfmt.senderLabel({ id: 42 })).toBe("42");
    expect(tgfmt.senderLabel({ id: 7, username: "dana" })).toBe("@dana");
  });

  it("chunk splits at paragraphs", () => {
    const text = "para1\n\n" + "a".repeat(3900) + "\n\npara3";
    const parts = tgfmt.chunk(text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });
});
