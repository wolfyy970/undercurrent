// redactSensitive.test.ts — upstream sync 2e39a3f: widened credential masking.
//
// Oracle: cases come from upstream's OWN tests/test_redact_sensitive.sh (run
// by node parity/upstream-tests/run.mjs against the real Bash) and
// parity/extract/run-parity.mjs diffs redact_sensitive's full output against it.
// Token-shaped fixtures are assembled from pieces so no secret scanner trips on
// this file.

import { describe, it, expect } from "vitest";
import { redactSensitive } from "../src/shellm.ts";

const j = (...p: string[]) => p.join("");

describe("redactSensitive — provider key values and the widened shape rules", () => {
  for (const v of ["ANTHROPIC_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"]) {
    it(`${v} value is masked`, () => {
      const secret = `key-${v.length}-424242`;
      const out = redactSensitive(`before ${secret} after`, { [v]: secret });
      expect(out).not.toContain(secret);
      expect(out).toContain("redacted");
    });
  }

  it("sk-ant- pattern is masked without the env var", () => {
    const out = redactSensitive("token sk-ant-abc123XYZ here", {});
    expect(out).toContain("<redacted-anthropic-key>");
    expect(out).not.toContain("sk-ant-abc123XYZ");
  });

  const shapes: Record<string, string> = {
    "github-classic": j("ghp", "_", "A".repeat(36)),
    "github-fine": j("github_pat", "_", "A".repeat(22), "_", "B".repeat(59)),
    "slack-cookie": j("xoxc", "-123456789012-123456789012-abcdef0123456789abcdef0123456789abcdef"),
    "slack-app": j("xoxe", "-1-0000000000-1234567890abcdef-abcdefghijklmnopqrstuv"),
    huggingface: j("hf", "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
    google: j("AIza", "SyAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf"),
    aws: j("AKIA", "IOSFODNN7EXAMPLE"),
    jwt: j("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0In0", ".abcdefghij0123456789"),
    "openai-project": j("sk-proj", "-0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef"),
    "basic-auth-url": j("https://user:", "SuperSecretPass123", "@host.example"),
  };
  for (const [name, secret] of Object.entries(shapes)) {
    it(`${name} shape is masked`, () => {
      const out = redactSensitive(`before ${secret} after`, {});
      expect(out).not.toContain(secret);
      expect(out).toContain("redacted");
    });
  }

  it("a credential env var outside the provider set is masked by its whole value", () => {
    const secret = "twilio-123456789-credential";
    const out = redactSensitive(`before ${secret} after`, { TWILIO_AUTH_TOKEN: secret });
    expect(out).not.toContain(secret);
    expect(out).toContain("redacted");
  });

  it("prose that merely resembles a token is left alone", () => {
    const plain =
      "see https://github.com/headlong42/headlong/pull/8 and http://host.example:8080/api plus xox-shaped mention hf_word and sk- short note 12345";
    expect(redactSensitive(plain, {})).toBe(plain);
  });

  for (const v of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"]) {
    for (const secret of ["localpw", "x*y?[z]"]) {
      it(`${v} short literal value ${JSON.stringify(secret)} is masked literally`, () => {
        expect(redactSensitive(`before ${secret} after xxyaz`, { [v]: secret })).toBe("before <redacted-api-key> after xxyaz");
      });
    }
  }

  describe("PEM private-key blocks (sed range semantics)", () => {
    const begin = (k: string) => j("-----BEGIN ", k, "PRIVATE KEY-----");
    const end = (k: string) => j("-----END ", k, "PRIVATE KEY-----");
    for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
      it(`${kind || "plain "}PEM body is masked and the surrounding lines survive`, () => {
        const text = ["ordinary before", begin(kind), "PRIVATE_BODY_fixture", end(kind), "ordinary after"].join("\n");
        const out = redactSensitive(text, {});
        expect(out).not.toContain("PRIVATE_BODY");
        expect(out).toContain("redacted");
        expect(out).toContain("ordinary before");
        expect(out).toContain("ordinary after");
      });
    }

    it("an unterminated block masks everything after BEGIN", () => {
      const out = redactSensitive(["x", begin(""), "PRIVATE_BODY_a", "PRIVATE_BODY_b"].join("\n"), {});
      expect(out).not.toContain("PRIVATE_BODY");
      expect(out.split("\n")[0]).toBe("x");
    });
  });
});
