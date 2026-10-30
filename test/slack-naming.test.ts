// slack-naming.test.ts — port of headlong/slack/tests/test_naming.py.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as naming from "../src/slack/naming.ts";

// Mirrors CHAT_FROM_RE in web/server/src/safety.ts — the web API rejects
// from_name values that don't match, so every encoded key must pass.
const CHAT_FROM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

describe("slack naming", () => {
  it("dm round trip", () => {
    const name = naming.encode("U07AB12CD", "D09XYZ123");
    expect(name).toBe("slack-U07AB12CD-D09XYZ123");
    expect(CHAT_FROM_RE.test(name)).toBe(true);
    expect(naming.decode(name)).toEqual({ user: "U07AB12CD", channel: "D09XYZ123", threadTs: null });
  });

  it("thread round trip", () => {
    const name = naming.encode("U07AB12CD", "C09XYZ123", "1722400000.123456");
    expect(name).toBe("slack-U07AB12CD-C09XYZ123-1722400000.123456");
    expect(CHAT_FROM_RE.test(name)).toBe(true);
    expect(naming.decode(name)).toEqual({
      user: "U07AB12CD",
      channel: "C09XYZ123",
      threadTs: "1722400000.123456",
    });
  });

  it("is_slack_name", () => {
    expect(naming.isSlackName("slack-U1-C2-3.4")).toBe(true);
    expect(naming.isSlackName("slack-U1-D2")).toBe(true);
    expect(naming.isSlackName("nick")).toBe(false);
    expect(naming.isSlackName("slack--C2-3.4")).toBe(false);
    expect(naming.isSlackName("slack-")).toBe(false);
    expect(naming.isSlackName("slack-...")).toBe(false);
    expect(naming.isSlackName(null)).toBe(false);
    expect(naming.isSlackName(42)).toBe(false);
  });

  it("decode rejects garbage", () => {
    expect(() => naming.decode("telegram-U1-C2")).toThrow();
    expect(() => naming.decode("slack-U1-C2-3.4-extra")).toThrow();
  });

  it("bare channel and user forms (the mind's `post in that channel` / `DM that person`)", () => {
    expect(naming.decode("slack-C0BMVH6LM4K")).toEqual({ user: "", channel: "C0BMVH6LM4K", threadTs: null });
    expect(naming.decode("slack-G0BMVH6LM4K")).toEqual({ user: "", channel: "G0BMVH6LM4K", threadTs: null });
    expect(naming.decode("slack-D0BMVH6LM4K")).toEqual({ user: "", channel: "D0BMVH6LM4K", threadTs: null });
    expect(naming.decode("slack-U0BFD9NDVE3")).toEqual({ user: "U0BFD9NDVE3", channel: "", threadTs: null });
    expect(naming.decode("slack-W0BFD9NDVE3")).toEqual({ user: "W0BFD9NDVE3", channel: "", threadTs: null });
    // Only real Slack id shapes qualify for the short forms.
    expect(naming.isSlackName("slack-nick")).toBe(false);
    expect(naming.isSlackName("slack-x1")).toBe(false);
    expect(naming.isSlackName("slack-c0bmvh6lm4k")).toBe(false);
  });

  it("looks_like_slack", () => {
    expect(naming.looksLikeSlack("slack-bogus")).toBe(true);
    expect(naming.looksLikeSlack("slack-U1-C2")).toBe(true);
    expect(naming.looksLikeSlack("telegram-1")).toBe(false);
    expect(naming.looksLikeSlack(null)).toBe(false);
  });

  it("chat carries the same grammar (NAME_RE_TEXT == src/chat.ts SLACK_NAME_RE)", () => {
    const chatSrc = fs.readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
    const m = /export const SLACK_NAME_RE = \/(.*)\/;/.exec(chatSrc);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(naming.NAME_RE_TEXT);
    expect(naming.NAME_RE_TEXT).not.toContain("(?:");
  });
});
