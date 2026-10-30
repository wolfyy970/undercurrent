// trajSync.test.ts — unit tests for the traj lane of the upstream sync to 2e39a3f.
//
// Covers: credential redaction at the write point (651d49f, src/trajRedact.mjs), search's two-pass /
// --tail / prefilter semantics (3732d20, 67c26f0, fceda76, defd719), cycle-guarded readers (d2e62f9),
// the fail-fast lock (983e112), the formatted tail/cat filter (b666593) and the POSIX bracket
// translation. The differential harness (parity/traj) is the oracle against the real Bash `traj`;
// this file pins the same behaviour so a regression shows up without it. Synthetic secrets are
// assembled from pieces so no scanner (or test/scrub.test.ts) sees a real-looking token in source.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTraj, grepContent, type TrajIO } from "../src/trajCli.js";
import { appendStep, readSteps } from "../src/trajCore.mjs";
import { redactString, redactRecord, trajRedactValues, TRAJ_VALUE_VARS } from "../src/trajRedact.mjs";

const j = (...p: string[]) => p.join("");
const ROOT = "aaaaaaaa-0000-4000-8000-000000000001";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "trajsync-test-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function run(argv: string[], env: Record<string, string | undefined> = {}) {
  let out = "";
  let err = "";
  const io: TrajIO = {
    env,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdin: () => "",
    isTTY: false,
    sleepMs: () => {},
    shouldStop: () => true,
  };
  const code = runTraj(argv, io);
  return { code, out, err };
}

function seed(dir: string, rows: (object | string)[], id = ROOT): string {
  const hex = id.slice(0, 8);
  const d = path.join(dir, `${hex}-root`);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, "trajectory.jsonl");
  const head = { type: "trajectory", step_id: id, ts: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(
    file,
    [head, ...rows].map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
  );
  return file;
}

describe("trajRedact — shape rules", () => {
  const cases: [string, string, string][] = [
    ["github", j("gh", "p_", "A".repeat(24)), "<redacted:github-token>"],
    ["github fine-grained", j("github", "_pat_", "B".repeat(24)), "<redacted:github-token>"],
    ["slack", j("xo", "xb-", "1234567890-abc"), "<redacted:slack-token>"],
    ["hf", j("hf", "_", "C".repeat(22)), "<redacted:hf-token>"],
    ["google", j("AI", "za", "D".repeat(32)), "<redacted:google-key>"],
    ["aws id", j("AK", "IA", "E".repeat(16)), "<redacted:aws-key>"],
    ["jwt", j("ey", "J", "a".repeat(12), ".", "b".repeat(12), ".", "c".repeat(12)), "<redacted:jwt>"],
  ];
  for (const [name, secret, mask] of cases) {
    it(`masks a ${name} token`, () => {
      expect(redactString(`x ${secret} y`, [])).toBe(`x ${mask} y`);
    });
  }
  it("keeps the delimiter before boundary-anchored keys (sk-, npm_, key-)", () => {
    expect(redactString(j("k=", "sk", "-", "z".repeat(24)), [])).toBe("k=<redacted:api-key>");
    expect(redactString(j("(", "npm", "_", "q".repeat(22)), [])).toBe("(<redacted:npm-token>");
    expect(redactString(j("a", "key", "-", "m".repeat(22)), [])).toBe(j("a", "key", "-", "m".repeat(22)));
  });
  it("masks URL basic-auth credentials but not the host", () => {
    expect(redactString("https://user:pa55@example.com/p", [])).toBe("https://<redacted:basic-auth>@example.com/p");
  });
  it("masks a private key block, and an unterminated one up to (not including) a final newline (Oniguruma \\Z)", () => {
    const begin = j("-----BEGIN ", "RSA PRIVATE", " KEY-----");
    const end = j("-----END ", "RSA PRIVATE", " KEY-----");
    expect(redactString(`a ${begin}\nMIIB\n${end} b`, [])).toBe("a <redacted:private-key> b");
    expect(redactString(`a ${begin}\nMIIB\n`, [])).toBe("a <redacted:private-key>\n");
  });
  it("re-emits aws secret assignments with the name preserved", () => {
    expect(redactString("aws_secret_access_key = abc/def+ghi", [])).toBe("aws_secret_access_key=<redacted:aws-secret>");
  });
});

describe("trajRedact — values and records", () => {
  it("lists only configured values of >= 8 codepoints", () => {
    expect(TRAJ_VALUE_VARS).toContain("DATABASE_URL");
    expect(trajRedactValues({ GH_TOKEN: "short", OPENAI_API_KEY: "12345678", HOME: "/h/user-long-value" })).toEqual(["12345678"]);
    expect(trajRedactValues({ GH_TOKEN: "ééééééé" })).toEqual([]); // 7 codepoints
    expect(trajRedactValues({ GH_TOKEN: "éééééééé" })).toEqual(["éééééééé"]);
  });
  it("masks a literal configured value before the shape rules run", () => {
    expect(redactString("tok=abcdefgh1 end", ["abcdefgh1"])).toBe("tok=<redacted:value> end");
  });
  it("walks arrays, object values and object KEYS; leaves non-strings alone", () => {
    const v = ["secretvalue1"];
    expect(redactRecord({ a: ["x secretvalue1"], ["k-secretvalue1"]: 3, n: null, t: true }, v)).toEqual({
      a: ["x <redacted:value>"],
      "k-<redacted:value>": 3,
      n: null,
      t: true,
    });
  });
  it("redacts a docker config `auth` value even when only the key identifies it", () => {
    expect(redactRecord({ auth: "QUJDREVGR0hJSktMTU5PUA==" }, [])).toEqual({ auth: "<redacted:docker-auth>" });
    expect(redactRecord({ auth: "short" }, [])).toEqual({ auth: "short" });
  });
});

describe("appendStep redacts at the write point", () => {
  it("masks an env-configured value in the record, before it lands on disk", () => {
    const file = seed(path.join(TMP, "t"), []);
    appendStep(file, { type: "thought", content: "using tokenvalue99 now" }, { env: { GH_TOKEN: "tokenvalue99" } });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("tokenvalue99");
    expect(readSteps(file).at(-1)!.content).toBe("using <redacted:value> now");
  });
});

describe("search — --tail, two passes, prefilter", () => {
  const dir = () => path.join(TMP, "t");
  const rows = [
    { type: "thought", step_id: "s1", content: "needle one" },
    { type: "shell-output", step_id: "s2", stdout: "plain\nneedle line\nafter", stdout_ref: "blobs/s2.txt" },
    { type: "thought", step_id: "s3", content: "needle three" },
  ];
  it("validates --tail", () => {
    seed(dir(), rows);
    const r = run(["search", "x", "--tail", "abc", "--traj_dir", dir(), ROOT]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("search: --tail must be a number, got 'abc'");
    expect(run(["search", "x", "--tail", "", "--traj_dir", dir(), ROOT]).code).toBe(1);
    expect(run(["search", "x", "--traj_dir", dir(), ROOT, "--tail"]).err).toContain("--tail requires a number");
  });
  it("--tail N keeps the last N output lines", () => {
    seed(dir(), rows);
    const all = run(["search", "needle", "--traj_dir", dir(), ROOT]).out.trimEnd().split("\n");
    const t = run(["search", "needle", "--tail", "2", "--traj_dir", dir(), ROOT]).out.trimEnd().split("\n");
    expect(t).toEqual(all.slice(-2));
  });
  it("prints no `--` separator at -C 0, and does between disjoint groups at -C 1", () => {
    const lines = "needle\nb\nc\nd\ne\nneedle";
    expect(grepContent(lines, "needle", { ci: false, contextLines: 0, regex: false })).toEqual(["1:needle", "6:needle"]);
    expect(grepContent(lines, "needle", { ci: false, contextLines: 1, regex: false })).toEqual([
      "1:needle",
      "2-b",
      "--",
      "5-e",
      "6:needle",
    ]);
  });
  it("a file's final newline terminates its last line (no phantom empty line)", () => {
    expect(grepContent("a\n\n", "^$", { ci: false, contextLines: 0, regex: true }, true)).toEqual(["2:"]);
    expect(grepContent("a\n", "^$", { ci: false, contextLines: 0, regex: true }, false)).toEqual(["2:"]);
  });
  it("pretty-prints a non-string JSON field the way `jq -r` does", () => {
    seed(dir(), [{ type: "thought", step_id: "s9", content: { a: "12345" } }]);
    const r = run(["search", "12345", "--traj_dir", dir(), ROOT]);
    expect(r.out).toBe('s9:content:2:  "a": "12345"\n');
  });
  it("skips a malformed row that does not contain the pattern; dies (5) when it does", () => {
    seed(dir(), [{ type: "thought", step_id: "s1", content: "needle" }, "garbage {{{"]);
    expect(run(["search", "needle", "--traj_dir", dir(), ROOT]).code).toBe(0);
    expect(run(["search", "garbage", "--traj_dir", dir(), ROOT]).code).toBe(5);
  });
});

describe("POSIX bracket expressions under -E", () => {
  const g = (line: string, pat: string) => grepContent(line, pat, { ci: false, contextLines: 0, regex: true }).length > 0;
  it("[[:alpha:]] / [[:digit:]] / negation", () => {
    expect(g("needle", "[[:alpha:]]eedle")).toBe(true);
    expect(g("1eedle", "[[:alpha:]]eedle")).toBe(false);
    expect(g("a1", "[[:alpha:]][[:digit:]]")).toBe(true);
    expect(g("ab", "[^[:digit:]]b")).toBe(true);
  });
  it("treats backslash and a leading ] as literals inside brackets", () => {
    expect(g("a\\b", "a[\\]b")).toBe(true);
    expect(g("a]b", "a[]]b")).toBe(true);
  });
  it("passes plain ranges and unterminated brackets through", () => {
    expect(g("Needle9", "[A-Z][a-z]+[0-9]")).toBe(true);
  });
});

describe("cycle-guarded readers", () => {
  it("list --children all stops a self-referencing fork and shows the raw ref", () => {
    const dir = path.join(TMP, "t");
    seed(dir, [{ type: "fork", step_id: "f1", child: ROOT, child_ref: "." + "/trajectory.jsonl" }]);
    const r = run(["list", "--traj_dir", dir, ROOT, "--children", "all"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(">>> aaaaaaaa:");
    expect(r.out.trimEnd().split("\n").length).toBeLessThanOrEqual(3); // no infinite descent
  });
  it("search -r terminates on a self-referencing fork", () => {
    const dir = path.join(TMP, "t");
    seed(dir, [
      { type: "thought", step_id: "t1", content: "needle" },
      { type: "fork", step_id: "f1", child: ROOT, child_ref: "." + "/trajectory.jsonl" },
    ]);
    const r = run(["search", "needle", "-r", "--traj_dir", dir, ROOT]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("t1:content:1:needle");
  });
});

describe("lock fail-fast (983e112)", () => {
  const skip = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(skip)("append into a read-only trajectory dir fails with the upstream message, not a hang", () => {
    const file = seed(path.join(TMP, "t"), []);
    const d = path.dirname(file);
    fs.chmodSync(d, 0o555);
    try {
      const t0 = Date.now();
      expect(() => appendStep(file, { type: "thought", content: "x" })).toThrow(/append: cannot create lock .*directory not writable by/);
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      fs.chmodSync(d, 0o755);
    }
  });
  it("steals a stale (> 5s) lock dir", () => {
    const file = seed(path.join(TMP, "t"), []);
    fs.mkdirSync(file + ".lock");
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file + ".lock", old, old);
    appendStep(file, { type: "thought", content: "x" });
    expect(readSteps(file).at(-1)!.content).toBe("x");
  });
});

describe("formatted tail/cat (b666593 + placeholder normalization)", () => {
  const dir = () => path.join(TMP, "t");
  const rows = [
    { type: "thought", step_id: "s1", content: "T1", ts: "2026-01-01T00:00:01.000Z" },
    { type: "action", step_id: "s2", content: "A1", ts: "2026-01-01T00:00:02.000Z" },
    { type: "thought", step_id: "s3", ts: "2026-01-01T00:00:03.000Z" },
  ];
  it("--filter type=… keeps only matching steps in formatted output", () => {
    seed(dir(), rows);
    const r = run(["cat", "--traj_dir", dir(), ROOT, "--format", "--no-color", "--filter", "type=action"]);
    expect(r.out).toBe("2026/01/01 00:00:02 s2 [action] A1\n");
  });
  it("an empty/absent preview prints blank, not the jq `-` placeholder", () => {
    seed(dir(), rows);
    const r = run(["cat", "--traj_dir", dir(), ROOT, "--format", "--no-color", "--filter", "type=thought"]);
    expect(r.out.split("\n")).toContain("2026/01/01 00:00:03 s3 [thought] ");
  });
});
