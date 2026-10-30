// memRedact.test.ts — credential redaction at the `mem add` / `mem edit` write
// point (upstream sync 2e39a3f, 494fda1). The byte-exact oracle is
// parity/mem (real bin/mem vs port); these pin the shapes deterministically.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memRedact, MemRedactError } from "../src/memRedact.js";
import { runMem, type MemIO } from "../src/mem.js";

const R = (s: string, env: Record<string, string | undefined> = {}) => memRedact(s, env);

describe("memRedact: credential shapes", () => {
  it("masks GitHub / Slack / HF / Google / AWS / JWT tokens", () => {
    expect(R("t ghp_" + "a".repeat(30))).toBe("t <redacted:github-token>");
    expect(R("github_pat_" + "A1_".repeat(10))).toBe("<redacted:github-token>");
    expect(R("xox" + "b-1234567890-abcdef")).toBe("<redacted:slack-token>");
    expect(R("hf_" + "b".repeat(25))).toBe("<redacted:hf-token>");
    expect(R("AIza" + "c".repeat(35))).toBe("<redacted:google-key>");
    expect(R("AKIA" + "A".repeat(16))).toBe("<redacted:aws-key>");
    const seg = "abcdefghij12";
    expect(R(`eyJ${seg}.${seg}.${seg}`)).toBe("<redacted:jwt>");
  });
  it("keeps the leading boundary char for sk- / stripe / npm / gitlab rules", () => {
    expect(R("key=sk-" + "a".repeat(24))).toBe("key=<redacted:api-key>");
    expect(R("(sk" + "_live_abcdefgh12)")).toBe("(<redacted:stripe-key>)");
    expect(R(" whsec" + "_abcdefgh12")).toBe(" <redacted:stripe-hook>");
    expect(R(" npm_" + "z".repeat(22))).toBe(" <redacted:npm-token>");
    expect(R(" glpat" + "-abcdefghij12")).toBe(" <redacted:gitlab-token>");
  });
  it("does not fire sk- inside a longer word", () => {
    expect(R("task-" + "a".repeat(30))).toBe("task-" + "a".repeat(30));
  });
  it("masks basic-auth URLs and docker auth", () => {
    expect(R("https://user:pw@host/x")).toBe("https://<redacted:basic-auth>@host/x");
    expect(R('"auth" : "' + "QUJD".repeat(5) + '"')).toBe('"auth": "<redacted:docker-auth>"');
  });
  it("masks the aws_secret_access_key value but keeps the key name", () => {
    expect(R("aws_secret_access_key = abc/def+ghi")).toBe("aws_secret_access_key = <redacted:aws-secret>");
  });
  it("is applied per line", () => {
    expect(R("a\nsk-" + "x".repeat(22) + "\nb")).toBe("a\n<redacted:api-key>\nb");
  });
});

describe("memRedact: env VALUE rule", () => {
  it("masks the literal value of a known credential var (>= 8 chars)", () => {
    expect(R("my pw is hunter2hunter2 ok", { LLM_API_KEY: "hunter2hunter2" })).toBe("my pw is <redacted:value> ok");
  });
  it("ignores short values", () => {
    expect(R("abc1234 here", { LLM_API_KEY: "abc1234" })).toBe("abc1234 here");
  });
  it("ignores vars that are not on the list", () => {
    expect(R("zzzzzzzzzz", { SOME_OTHER_VAR: "zzzzzzzzzz" })).toBe("zzzzzzzzzz");
  });
});

describe("memRedact: PEM private keys", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
  it("replaces the whole block with one marker", () => {
    const pem = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nafter`;
    const out = R(pem);
    expect(out).not.toContain(body);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("<redacted:private-key>");
  });
  it("refuses an unterminated block", () => {
    expect(() => R(`-----BEGIN PRIVATE KEY-----\n${body}`)).toThrow(MemRedactError);
    expect(() => R(`-----BEGIN PRIVATE KEY-----\n${body}`)).toThrow(/Incomplete private-key block; memory not written/);
  });
  it("refuses a nested BEGIN", () => {
    const s = `-----BEGIN PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(() => R(s)).toThrow(/Nested private-key block; memory not written/);
  });
});

describe("memRedact: payment cards", () => {
  it("masks Luhn-valid Visa/Mastercard/Amex in plain, spaced and hyphenated layouts", () => {
    expect(R("card 4111111111111111 x")).toContain("<redacted:card>");
    expect(R("card 4111 1111 1111 1111 x")).toContain("<redacted:card>");
    expect(R("card 4111-1111-1111-1111 x")).toContain("<redacted:card>");
    expect(R("5555555555554444")).toContain("<redacted:card>");
    expect(R("378282246310005")).toContain("<redacted:card>");
    expect(R("4111111111111111")).not.toContain("4111");
  });
  it("leaves Luhn-invalid digit runs and unknown issuers alone", () => {
    expect(R("4111111111111112")).toBe("4111111111111112");
    expect(R("1234567890123456")).toBe("1234567890123456");
  });
});

// --- through the CLI -----------------------------------------------------------

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mem-redact-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
const D = () => path.join(TMP, "m");

function cli(args: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  let out = "";
  let err = "";
  let n = 0;
  const io: MemIO = {
    cwd: TMP,
    env: opts.env ?? {},
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    readStdin: () => opts.stdin ?? "",
    isTTY: false,
    now: () => new Date("2026-01-02T03:04:05"),
    randomHex: (b) => (++n).toString(16).padStart(b * 2, "0"),
    runLlm: () => 0,
  };
  const rc = runMem(["--dir", D(), ...args], io);
  return { rc, out, err };
}
const files = () => (fs.existsSync(D()) ? fs.readdirSync(D()) : []);
const read = (f: string) => fs.readFileSync(path.join(D(), f), "utf8");

describe("mem add / edit apply redaction", () => {
  const tok = "ghp_" + "q".repeat(30);
  it("add redacts the body before it is written", () => {
    const r = cli(["add", `remember ${tok} please`]);
    expect(r.rc).toBe(0);
    const f = files()[0]!;
    expect(read(f)).not.toContain(tok);
    expect(read(f)).toContain("<redacted:github-token>");
  });
  it("add redacts a token in the slug-source summary too", () => {
    cli(["add", tok]);
    expect(files()[0]).not.toContain("qqqq");
  });
  it("add refuses (rc 1, nothing written) on an incomplete PEM block", () => {
    const r = cli(["add"], { stdin: "-----BEGIN PRIVATE KEY-----\nabc" });
    expect(r.rc).toBe(1);
    expect(r.err).toContain("Incomplete private-key block; memory not written");
    expect(files()).toEqual([]);
  });
  it("edit redacts the replacement body", () => {
    cli(["add", "first note"]);
    const f = files()[0]!;
    const id = f.split("_")[1]!;
    const r = cli(["edit", id, `now ${tok}`]);
    expect(r.rc).toBe(0);
    const all = files().map(read).join("\n");
    expect(all).not.toContain(tok);
  });
});

describe("mem add / edit flag handling (upstream sync 2e39a3f)", () => {
  it("add refuses an unknown dash-option instead of storing it as the body", () => {
    const r = cli(["add", "--bogus", "text"]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("add: unknown option '--bogus'");
    expect(files()).toEqual([]);
  });
  it("edit refuses an unknown dash-option", () => {
    cli(["add", "first"]);
    const id = files()[0]!.split("_")[1]!;
    const r = cli(["edit", id, "--bogus", "x"]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("edit: unknown option '--bogus'");
  });
  it("whitespace-only argv body falls through to stdin", () => {
    const r = cli(["add", "   "], { stdin: "from stdin\n" });
    expect(r.rc).toBe(0);
    expect(read(files()[0]!)).toContain("from stdin");
  });
  it("summary is the first non-blank line, capped at 80 characters", () => {
    cli(["add"], { stdin: "\n\n  \nreal first line\nsecond\n" });
    expect(read(files()[0]!)).toContain("summary: real first line");
  });
  it("--schedule/--tz are stored after the frontmatter fields", () => {
    const r = cli(["add", "--type", "goal", "--schedule", "09:00", "--tz", "America/New_York", "wake me"]);
    expect(r.rc).toBe(0);
    const t = read(files()[0]!);
    expect(t).toMatch(/^schedule: 09:00$/m);
    expect(t).toMatch(/^tz: America\/New_York$/m);
  });
});
