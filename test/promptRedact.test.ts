// Wake-prompt redaction (upstream sync 2e39a3f, common.sh prompt_redact). The
// byte-level oracle is parity/prompt/run-parity.mjs (real jq program); these
// pin the behaviours the monolith relies on without needing the upstream tree.
import { describe, expect, it } from "vitest";
import { promptRedact } from "../src/promptRedact.ts";

const GH = "ghp_" + "A".repeat(24);

describe("promptRedact", () => {
  it("leaves a clean prompt byte for byte", () => {
    const p = "Recent stream:\n{\"type\":\"thought\",  \"content\":\"x\"}\n\nRouting signals:\n- none";
    expect(promptRedact(p, {})).toBe(p);
  });
  it("masks a token in plain text and inside a JSON line", () => {
    expect(promptRedact(`a ${GH} b`, {})).toBe("a <redacted:github-token> b");
    const out = promptRedact(JSON.stringify({ content: `x ${GH}` }), {});
    expect(JSON.parse(out)).toEqual({ content: "x <redacted:github-token>" });
  });
  it("masks the value of a configured credential env var, but not a short one", () => {
    const env = { GITHUB_TOKEN: "env-held-secret-123", OPENAI_API_KEY: "short" };
    expect(promptRedact("t env-held-secret-123 short", env)).toBe("t <redacted:value> short");
  });
  it("masks card numbers in the three shapes", () => {
    expect(promptRedact("4111 1111 1111 1111", {})).toBe("<redacted:card>");
    expect(promptRedact("n 4111111111111111.", {})).toBe("n <redacted:card>.");
    // the spaced-groups rule runs before the labelled one, so "is " stays (as upstream)
    expect(promptRedact("my visa is 4242 4242 4242 4242", {})).toBe("my visa is <redacted:card>");
    expect(promptRedact("card: 4242-4242-4242-4242", {})).toBe("card: <redacted:card>");
    expect(promptRedact("visa 4242424242424242424", {})).toBe("visa <redacted:card>");
  });
  it("an unterminated private key never eats the sections that follow it", () => {
    const out = promptRedact("-----BEGIN PRIVATE KEY-----\nAAAA\n\nRouting signals:\n- keep", {});
    expect(out).toBe("<redacted:private-key>\n\nRouting signals:\n- keep");
  });
});
