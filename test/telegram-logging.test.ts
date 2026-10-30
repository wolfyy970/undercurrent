// telegram-logging.test.ts — port of headlong/telegram/tests/test_logging.py
// (44fe2f4: the bot token never reaches the log).
//
// PORT-NOTE (1c: 44fe2f4): Python's test suite also covers `RedactingFormatter`
// and `configure_logging` (silencing httpx/httpcore INFO chatter). Node's
// `fetch` has no equivalent auto-logging of request URLs — see logging.ts's
// header comment — so those two cases have no TS analogue; `redact()` itself,
// and its wiring into cli.ts's stderr/log sinks, are what's ported and tested
// here.

import { describe, it, expect } from "vitest";
import { redact } from "../src/telegram/logging.ts";

const TOKEN_URL = "https://api.telegram.org/bot123456789:FAKE-token-for-tests_not-a-real-one/getUpdates";

describe("telegram logging redact", () => {
  it("strips the token from a URL", () => {
    expect(redact(`POST ${TOKEN_URL} 200`)).toBe(
      "POST https://api.telegram.org/bot<redacted>/getUpdates 200",
    );
  });

  it("leaves other text alone", () => {
    expect(redact("robot 12:30 bottle")).toBe("robot 12:30 bottle");
  });

  it("redacts every occurrence, not just the first", () => {
    const text = `${TOKEN_URL} and again ${TOKEN_URL}`;
    const out = redact(text);
    expect(out).not.toContain("FAKE-token-for-tests_not-a-real-one");
    expect(out.split("bot<redacted>/getUpdates").length - 1).toBe(2);
  });

  it("redacts a token embedded in an error message", () => {
    const err = new Error(`Connect failed for url '${TOKEN_URL}'`);
    const out = redact(`poll failed: ${err.message}`);
    expect(out).not.toContain("FAKE-token-for-tests_not-a-real-one");
    expect(out).toContain("poll failed");
    expect(out).toContain("bot<redacted>/getUpdates");
  });
});
