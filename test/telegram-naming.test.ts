// telegram-naming.test.ts — port of headlong/telegram/tests/test_naming.py.

import { describe, it, expect } from "vitest";
import * as naming from "../src/telegram/naming.ts";

// Mirrors CHAT_FROM_RE in web/server/src/safety.ts — the web API rejects
// from_name values that don't match, so every encoded key must pass.
const CHAT_FROM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

describe("telegram naming", () => {
  it("dm round trip", () => {
    const name = naming.encode(5551234, 5551234);
    expect(name).toBe("telegram-5551234-5551234");
    expect(CHAT_FROM_RE.test(name)).toBe(true);
    expect(naming.decode(name)).toEqual({ user: 5551234, chat: 5551234 });
  });

  it("encode rejects group chats", () => {
    // Group chat ids are negative; the leading minus would break both the
    // separator and CHAT_FROM_RE.
    expect(() => naming.encode(5551234, -1001234567890)).toThrow();
    expect(() => naming.encode(0, 5551234)).toThrow();
  });

  it("is_telegram_name", () => {
    expect(naming.isTelegramName("telegram-1-2")).toBe(true);
    expect(naming.isTelegramName("nick")).toBe(false);
    expect(naming.isTelegramName("telegram-1")).toBe(false);
    expect(naming.isTelegramName("telegram-1-2-3")).toBe(false);
    expect(naming.isTelegramName("telegram--1--2")).toBe(false);
    expect(naming.isTelegramName("slack-U1-D2")).toBe(false);
    expect(naming.isTelegramName(null)).toBe(false);
    expect(naming.isTelegramName(42)).toBe(false);
  });

  it("decode rejects garbage", () => {
    expect(() => naming.decode("slack-U1-C2")).toThrow();
    expect(() => naming.decode("telegram-abc-def")).toThrow();
  });
});
