// slack-slackfmt.test.ts — port of headlong/slack/tests/test_slackfmt.py.
// (test_recent_posts_dedupe from the same upstream file is ported in
// slack-outbound.test.ts, next to the RecentPosts class it exercises — same
// split telegram's port used for tgfmt vs outbound.)

import { describe, it, expect } from "vitest";
import { chunk, cleanInbound, stripLeakedCommand, toMrkdwn } from "../src/slack/slackfmt.ts";

describe("slack slackfmt", () => {
  it("strip_leaked_command", () => {
    const leaked = "chat reply slack-U0BNK8YBF7A-C0BMUKCR44C-1785790643.112419 Right where Max left them";
    expect(stripLeakedCommand(leaked)).toBe("Right where Max left them");
    expect(stripLeakedCommand("no leak here")).toBe("no leak here");
    expect(stripLeakedCommand("mid-text chat reply foo stays")).toBe("mid-text chat reply foo stays");
  });

  it("bold and links", () => {
    expect(toMrkdwn("**hi** [docs](https://x.io/a)")).toBe("*hi* <https://x.io/a|docs>");
  });

  it("headings and bullets", () => {
    expect(toMrkdwn("# Title\n* one\n+ two\n- three")).toBe("*Title*\n- one\n- two\n- three");
  });

  it("code untouched", () => {
    const text = "use **x**\n```\n**not bold** [a](b)\n```\nand `**inline**`";
    const out = toMrkdwn(text);
    expect(out).toContain("*x*");
    expect(out).toContain("**not bold** [a](b)");
    expect(out).toContain("`**inline**`");
  });

  it("clean_inbound strips bot mention", () => {
    expect(cleanInbound("<@U0BOT> hello", "U0BOT")).toBe("hello");
  });

  it("clean_inbound entities and links", () => {
    expect(cleanInbound("a &lt;b&gt; &amp; c")).toBe("a <b> & c");
    expect(cleanInbound("<https://x.io|the site>")).toBe("the site (https://x.io)");
    expect(cleanInbound("<https://x.io>")).toBe("https://x.io");
    expect(cleanInbound("ask <@U0OTHER>")).toBe("ask U0OTHER");
  });

  it("chunk short passthrough", () => {
    expect(chunk("hello")).toEqual(["hello"]);
  });

  it("chunk prefers paragraphs", () => {
    const text = "a".repeat(3000) + "\n\n" + "b".repeat(3000);
    const parts = chunk(text, 3900);
    expect(parts).toEqual(["a".repeat(3000), "b".repeat(3000)]);
  });

  it("chunk hard split when no boundary", () => {
    const text = "x".repeat(9000);
    const parts = chunk(text, 3900);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => p.length <= 3900)).toBe(true);
  });
});
