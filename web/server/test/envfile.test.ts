// envfile.test.ts — unit tests for envfile.ts, the port of
// headlong_web/envfile.py. Expectations derived by reading envfile.py
// directly (parse_env_file/upsert_env_var/delete_env_var/redacted_entry).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnvFile, upsertEnvVar, deleteEnvVar, redactedEntry, isSecret, ENV_KEY_RE, _quoteValue } from "../src/envfile.ts";

const dirs: string[] = [];
function scratchFile(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envfile-test-"));
  dirs.push(dir);
  const file = path.join(dir, ".env");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("returns [] for a missing file", () => {
    expect(parseEnvFile("/nonexistent/.env")).toEqual([]);
  });

  it("parses KEY=value, ignoring comments and blank lines", () => {
    const f = scratchFile("# comment\nFOO=bar\n\nBAZ=qux\n");
    expect(parseEnvFile(f)).toEqual([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
  });

  it("strips a leading 'export '", () => {
    const f = scratchFile("export FOO=bar\n");
    expect(parseEnvFile(f)).toEqual([["FOO", "bar"]]);
  });

  it("unquotes single and double quoted values", () => {
    const f = scratchFile(`A="double"\nB='single'\nC=bare\n`);
    expect(parseEnvFile(f)).toEqual([
      ["A", "double"],
      ["B", "single"],
      ["C", "bare"],
    ]);
  });

  it("later duplicates win (like sourcing), but file ORDER is first-seen", () => {
    const f = scratchFile("FOO=1\nBAR=2\nFOO=3\n");
    expect(parseEnvFile(f)).toEqual([
      ["FOO", "3"],
      ["BAR", "2"],
    ]);
  });

  it("a single-line file with no trailing newline still parses", () => {
    const f = scratchFile("FOO=bar");
    expect(parseEnvFile(f)).toEqual([["FOO", "bar"]]);
  });
});

describe("isSecret / redactedEntry", () => {
  it("matches KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL case-insensitively", () => {
    for (const k of ["API_KEY", "MY_TOKEN", "secret_value", "DB_PASSWORD", "AWS_CREDENTIAL"]) {
      expect(isSecret(k)).toBe(true);
    }
    expect(isSecret("FOO")).toBe(false);
  });

  it("non-secret: value passes through unchanged", () => {
    expect(redactedEntry("FOO", "bar")).toEqual({ key: "FOO", value: "bar", secret: false });
  });

  it("secret >12 chars: prefix(6)…suffix(4) peek", () => {
    const v = "sk-1234567890abcdef";
    expect(redactedEntry("API_KEY", v)).toEqual({ key: "API_KEY", value: `${v.slice(0, 6)}…${v.slice(-4)}`, secret: true });
  });

  it("secret <=12 chars, non-empty: dot peek", () => {
    expect(redactedEntry("API_KEY", "short")).toEqual({ key: "API_KEY", value: "••••••", secret: true });
  });

  it("secret, empty value: empty peek", () => {
    expect(redactedEntry("API_KEY", "")).toEqual({ key: "API_KEY", value: "", secret: true });
  });
});

describe("_quoteValue", () => {
  it("bare-shape values pass through unquoted", () => {
    expect(_quoteValue("abc123_.:/@+=,-")).toBe("abc123_.:/@+=,-");
  });
  it("anything else is single-quoted, with embedded quotes escaped", () => {
    expect(_quoteValue("hello world")).toBe("'hello world'");
    expect(_quoteValue("it's")).toBe("'it'\\''s'");
  });
});

describe("upsertEnvVar", () => {
  it("creates a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envfile-test-"));
    dirs.push(dir);
    const f = path.join(dir, ".env");
    upsertEnvVar(f, "FOO", "bar");
    expect(fs.readFileSync(f, "utf-8")).toBe("FOO=bar\n");
  });

  it("appends a new key, preserving existing lines/comments", () => {
    const f = scratchFile("# hello\nFOO=1\n");
    upsertEnvVar(f, "BAR", "2");
    expect(fs.readFileSync(f, "utf-8")).toBe("# hello\nFOO=1\nBAR=2\n");
  });

  it("replaces an existing assignment in place", () => {
    const f = scratchFile("FOO=1\nBAR=2\n");
    upsertEnvVar(f, "FOO", "99");
    expect(fs.readFileSync(f, "utf-8")).toBe("FOO=99\nBAR=2\n");
  });

  it("collapses duplicate assignments of the same key into the first slot", () => {
    const f = scratchFile("FOO=1\nBAR=2\nFOO=3\n");
    upsertEnvVar(f, "FOO", "99");
    expect(fs.readFileSync(f, "utf-8")).toBe("FOO=99\nBAR=2\n");
  });

  it("a value needing quotes is single-quoted on write", () => {
    const f = scratchFile("");
    upsertEnvVar(f, "FOO", "hello world");
    expect(fs.readFileSync(f, "utf-8")).toBe("FOO='hello world'\n");
  });

  it("does not touch a same-named key inside a comment", () => {
    const f = scratchFile("# FOO=old\nFOO=1\n");
    upsertEnvVar(f, "FOO", "2");
    expect(fs.readFileSync(f, "utf-8")).toBe("# FOO=old\nFOO=2\n");
  });
});

describe("deleteEnvVar", () => {
  it("returns false and does nothing for a missing file", () => {
    expect(deleteEnvVar("/nonexistent/.env", "FOO")).toBe(false);
  });

  it("returns false when the key isn't present", () => {
    const f = scratchFile("BAR=2\n");
    expect(deleteEnvVar(f, "FOO")).toBe(false);
    expect(fs.readFileSync(f, "utf-8")).toBe("BAR=2\n");
  });

  it("removes every assignment of the key, keeps everything else", () => {
    const f = scratchFile("FOO=1\nBAR=2\nFOO=3\n# FOO=comment\n");
    expect(deleteEnvVar(f, "FOO")).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("BAR=2\n# FOO=comment\n");
  });
});

describe("ENV_KEY_RE", () => {
  it("accepts letters/digits/underscore, must not start with a digit", () => {
    expect(ENV_KEY_RE.test("FOO")).toBe(true);
    expect(ENV_KEY_RE.test("_FOO2")).toBe(true);
    expect(ENV_KEY_RE.test("2FOO")).toBe(false);
    expect(ENV_KEY_RE.test("FOO-BAR")).toBe(false);
  });
});
