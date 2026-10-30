// responderRedact.test.ts — thinkers/responder/step `_redact_card` / `_redact_keys`
// (sync 2e39a3f). Byte-for-byte agreement with the real sed is proven by
// parity/responder/run-parity.mjs; these pin the contract.

import { describe, it, expect } from "vitest";
import { redactCard, redactKeys } from "../src/responderRedact.js";

describe("redactCard", () => {
  it("replaces grouped and bare card numbers, cvv and keyword-anchored expiry", () => {
    expect(redactCard("use 4242 4242 4242 4242 exp 12/28 cvv 411 for Bestia")).toBe("use [card redacted] exp [redacted] cvv [redacted] for Bestia");
    expect(redactCard("number 4111111111111111.")).toBe("number [card redacted].");
    expect(redactCard("my amex is 3782 822463 10005 ok")).toBe("my amex [card redacted] ok");
    expect(redactCard("security code is 4567")).toBe("security code [redacted]");
  });
  it("leaves dates, times, party sizes, confirmation numbers, phones and zips alone", () => {
    const benign = "Bestia Nov 7 2026 6pm party of 2 conf 2110728612 zip 94110 phone 415-555-0100 bare 04/27";
    expect(redactCard(benign)).toBe(benign);
  });
  it("a digit run glued to letters is not a card; a 20-digit run is not 13-19", () => {
    expect(redactCard("a4111111111111111 stays")).toBe("a4111111111111111 stays");
  });
  it("works per line (^ is a line start)", () => {
    expect(redactCard("x\n4111111111111111\ncvv 411")).toBe("x\n[card redacted]\ncvv [redacted]");
  });
});

describe("redactKeys", () => {
  const long = (c: string, n: number): string => c.repeat(n);
  it("masks configured credential env values literally (8+ chars), ignores short ones", () => {
    const env = { OPENROUTER_API_KEY: "env-held-secret-xxxx", SLACK_BOT_TOKEN: "short" };
    expect(redactKeys("a env-held-secret-xxxx b short", env)).toBe("a [redacted] b short");
  });
  it("masks token shapes, URL credentials and private-key blocks", () => {
    expect(redactKeys(`k ghp_${long("A", 24)} z`, {})).toBe("k [redacted] z");
    expect(redactKeys(`sk-ant-api03-${long("z", 20)}`, {})).toBe("[redacted]");
    expect(redactKeys("clone https://user:hunter2@example.com/x.git", {})).toBe("clone https://[redacted]@example.com/x.git");
    expect(redactKeys("before\n-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\nafter", {})).toBe("before\n[redacted]\nafter");
  });
  it("an unterminated private-key block swallows the rest and prints one marker (BSD sed)", () => {
    expect(redactKeys("a\n-----BEGIN PRIVATE KEY-----\nxxx\nb", {})).toBe("a\n[redacted]");
  });
  it("runs card redaction last", () => {
    expect(redactKeys("card 4111 1111 1111 1111 and cvv 411", {})).toBe("card [card redacted] and cvv [redacted]");
  });
  it("prose passes through", () => {
    expect(redactKeys("Andy likes tea.", {})).toBe("Andy likes tea.");
  });
});
