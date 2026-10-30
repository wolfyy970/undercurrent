// Port of headlong/web/tests/test_chat_links.py (Apache-2.0), 1:1.
import { describe, it, expect } from "vitest";
import { resolveSourceUrl } from "../src/chat-links.ts";

describe("resolveSourceUrl", () => {
  it("records a message's own source_url and lets a reply inherit it", () => {
    const known: Record<string, string> = {};
    const sourceUrl = "https://laudesters.slack.com/archives/C1/p1788451200123456";

    expect(resolveSourceUrl({ step_id: "m1", source_url: sourceUrl }, known)).toBe(sourceUrl);
    expect(resolveSourceUrl({ step_id: "m2", reply_to: "m1" }, known)).toBe(sourceUrl);
    expect(known).toEqual({ m1: sourceUrl, m2: sourceUrl });
  });

  it("a message's own source_url takes precedence over the replied message's", () => {
    const oldUrl = "https://old.slack.com/archives/C1/p1";
    const newUrl = "https://new.slack.com/archives/C1/p2";
    const known: Record<string, string> = { m1: oldUrl };

    expect(resolveSourceUrl({ step_id: "m2", reply_to: "m1", source_url: newUrl }, known)).toBe(newUrl);
    expect(known["m2"]).toBe(newUrl);
  });

  it("a message with no source_url and nothing to inherit stays null", () => {
    expect(resolveSourceUrl({ step_id: "m1" }, {})).toBeNull();
  });
});
