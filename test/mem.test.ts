// mem.test.ts — unit tests for the `mem` semantic memory store (SPEC §5).
//
// Behaviour, not text: these assert the CLI contract and the on-disk format the
// engine + `mem search` corpus + goals scraper depend on. The port is
// byte-compared against the real Bash tool by the separate tester lane; here we
// pin the behaviour deterministically (injected clock / id / stdin / `llm`).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordedServerProcess } from "./support/recordedServerProcess.ts";
import { recordedText, RECORDINGS_DIR, RECORD_MODEL, type Recording } from "./support/recordedModel.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claimFixedRoot } from "./support/fixedRoot.ts";
import {
  runMem,
  slugify,
  parseFilename,
  frontmatterField,
  frontmatterBlock,
  parseMemory,
  readMemories,
  extractPrefilterTerms,
  scorePrefilterCandidates,
  MEM_VERSION,
  LS_CANNOT_ACCESS_RC,
  type MemIO,
} from "../src/mem.js";

// --- deterministic IO harness -------------------------------------------------

interface Harness {
  io: MemIO;
  out(): string;
  err(): string;
  llmCalls: { args: string[]; stdin: string; heartbeatSeconds: string }[];
}

function makeIO(opts: {
  dir: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  llmExit?: number;
} = { dir: "" }): Harness {
  let out = "";
  let err = "";
  let hexN = 0;
  const llmCalls: { args: string[]; stdin: string; heartbeatSeconds: string }[] = [];
  const io: MemIO = {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? {},
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdin: () => opts.stdin ?? "",
    isTTY: false,
    // Local-time date without offset → deterministic components on any tz.
    now: () => new Date("2026-01-02T03:04:05"),
    randomHex: (bytes) => {
      hexN += 1;
      return hexN.toString(16).padStart(bytes * 2, "0");
    },
    runLlm: (args, stdin, heartbeatSeconds) => {
      llmCalls.push({ args, stdin, heartbeatSeconds });
      return opts.llmExit ?? 0;
    },
  };
  return { io, out: () => out, err: () => err, llmCalls };
}

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const dir = () => path.join(TMP, "memories");

/** Write a raw memory file directly (for list/type/date fixtures). */
function writeMem(name: string, content: string): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), name), content);
}

// --- pure helpers -------------------------------------------------------------

describe("slugify", () => {
  it("lowercases, collapses non-alnum runs, trims edge dashes", () => {
    expect(slugify("Ship the TS port!!  (now)")).toBe("ship-the-ts-port-now");
  });
  it("strips one leading and trailing dash", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("...x...")).toBe("x");
  });
  it("caps at 80 chars", () => {
    expect(slugify("a".repeat(200)).length).toBe(80);
  });
  it("only ASCII A-Z is lowercased; other scripts collapse to dashes", () => {
    expect(slugify("café ÜBER")).toBe("caf-ber");
  });
  it("all-symbol text yields empty slug", () => {
    expect(slugify("!!! ??? ...")).toBe("");
  });
});

describe("parseFilename", () => {
  it("parses the new ts_hex_slug format", () => {
    expect(parseFilename("2026-01-02-03-04-05_deadbeef_some-slug")).toEqual({
      ts: "2026-01-02-03-04-05",
      id: "deadbeef",
      slug: "some-slug",
    });
  });
  it("falls back to legacy (id-less) format", () => {
    expect(parseFilename("2026-01-02-03-04-05_legacy-slug")).toEqual({
      ts: "2026-01-02-03-04-05",
      id: "",
      slug: "legacy-slug",
    });
  });
  it("keeps slug's internal dashes; hex must be 8 chars", () => {
    // 7-char hex is not the new format → legacy split on first underscore.
    expect(parseFilename("2026-01-02-03-04-05_deadbee_x")).toEqual({
      ts: "2026-01-02-03-04-05",
      id: "",
      slug: "deadbee_x",
    });
  });
});

describe("frontmatterField / frontmatterBlock", () => {
  const doc = `---\nid: abc12345\nsummary: hello: world\ntype: goal\n---\n\nbody\n---\nnotes\n`;
  it("extracts fields from the first block only", () => {
    expect(frontmatterField(doc, "type")).toBe("goal");
    expect(frontmatterField(doc, "summary")).toBe("hello: world");
    expect(frontmatterField(doc, "id")).toBe("abc12345");
  });
  it("returns '' for a missing field", () => {
    expect(frontmatterField(doc, "created")).toBe("");
  });
  it("strips one layer of matched quotes", () => {
    expect(frontmatterField(`---\nsummary: "quoted"\n---\n`, "summary")).toBe("quoted");
    expect(frontmatterField(`---\nsummary: 'quoted'\n---\n`, "summary")).toBe("quoted");
  });
  it("frontmatterBlock captures the fenced head block", () => {
    expect(frontmatterBlock(doc)[0]).toBe("---");
    expect(frontmatterBlock(doc)).toContain("type: goal");
  });
});

// --- add ----------------------------------------------------------------------

describe("mem add", () => {
  it("writes byte-exact frontmatter+body and prints the filename", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "add", "--type", "goal", "Ship it"], h.io);
    expect(rc).toBe(0);
    const fname = "2026-01-02-03-04-05_00000001_ship-it";
    expect(h.out()).toBe(`${fname}\n`);
    const content = fs.readFileSync(path.join(dir(), `${fname}.md`), "utf8");
    expect(content).toBe(
      `---\nid: 00000001\nsummary: Ship it\ntype: goal\ncreated: 2026-01-02 03:04:05\n---\n\nShip it\n`,
    );
  });

  it("defaults type to 'memory' and reads stdin when no text arg", () => {
    const h = makeIO({ dir: "", stdin: "from stdin\nsecond\n" });
    runMem(["--dir", dir(), "add"], h.io);
    const file = fs.readdirSync(dir())[0]!;
    const content = fs.readFileSync(path.join(dir(), file), "utf8");
    expect(frontmatterField(content, "type")).toBe("memory");
    // Command-substitution strips trailing newlines from stdin.
    expect(content.endsWith("from stdin\nsecond\n")).toBe(true);
    // Summary is the first line only.
    expect(frontmatterField(content, "summary")).toBe("from stdin");
  });

  it("dies on empty text (no arg, empty stdin)", () => {
    const h = makeIO({ dir: "", stdin: "" });
    const rc = runMem(["--dir", dir(), "add"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: No text provided\n");
  });

  // M2 — `cut -c1-80` counts CODE POINTS; the summary slice must too, or a
  // 4-byte astral char (emoji) truncates at half the intended length.
  it("keeps a first line ≤ 80 code points even when it is all astral chars", () => {
    const h = makeIO({ dir: "" });
    // 40 emoji + "tail" = 44 code points (84 UTF-16 units). A UTF-16 .slice(0,80)
    // would keep only the 40 emoji and silently drop "tail".
    runMem(["--dir", dir(), "add", "😀".repeat(40) + "tail"], h.io);
    const file = fs.readdirSync(dir())[0]!;
    const content = fs.readFileSync(path.join(dir(), file), "utf8");
    expect(frontmatterField(content, "summary")).toBe("😀".repeat(40) + "tail");
  });

  it("caps the summary at 80 CODE POINTS (not 80 UTF-16 units) for astral input", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "add", "😀".repeat(90)], h.io);
    const file = fs.readdirSync(dir())[0]!;
    const summary = frontmatterField(fs.readFileSync(path.join(dir(), file), "utf8"), "summary");
    expect([...summary].length).toBe(80); // UTF-16 .slice(0,80) would give 40
    expect(summary).toBe("😀".repeat(80));
  });

  // --- --until (1c: 130796a) ---------------------------------------------------

  it("--until writes an until: line right after created:", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "add", "--until", "2026-12-31", "renew passport"], h.io);
    const file = fs.readdirSync(dir())[0]!;
    const content = fs.readFileSync(path.join(dir(), file), "utf8");
    expect(content).toBe(
      `---\nid: 00000001\nsummary: renew passport\ntype: memory\n` +
        `created: 2026-01-02 03:04:05\nuntil: 2026-12-31\n---\n\nrenew passport\n`,
    );
  });

  it("no --until: no until: line at all", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "add", "no expiry"], h.io);
    const file = fs.readdirSync(dir())[0]!;
    const content = fs.readFileSync(path.join(dir(), file), "utf8");
    expect(content).not.toContain("until:");
  });

  it("--type and --until combine in either order", () => {
    const h1 = makeIO({ dir: "" });
    runMem(["--dir", dir(), "add", "--until", "2026-06-01", "--type", "todo", "a"], h1.io);
    const f1 = fs.readdirSync(dir())[0]!;
    const c1 = fs.readFileSync(path.join(dir(), f1), "utf8");
    expect(frontmatterField(c1, "type")).toBe("todo");
    expect(frontmatterField(c1, "until")).toBe("2026-06-01");
  });

  it("--until requires the YYYY-MM-DD shape (digits only; no calendar validation)", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "add", "--until", "not-a-date", "x"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: --until takes a date, YYYY-MM-DD\n");
    expect(fs.existsSync(dir())).toBe(false);
  });

  it("--until accepts a shape match even for an impossible calendar date (matches Bash's regex-only check)", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "add", "--until", "2026-13-45", "x"], h.io);
    expect(rc).toBe(0);
    const file = fs.readdirSync(dir())[0]!;
    expect(frontmatterField(fs.readFileSync(path.join(dir(), file), "utf8"), "until")).toBe(
      "2026-13-45",
    );
  });

  it("--until with a missing/empty value dies like ${2:?} (M1 pattern)", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "add", "--until"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: --until requires YYYY-MM-DD\n");
  });
});

// --- M1: empty-string required flag values die like Bash `${2:?}` -------------

describe("empty-string required flag values die like Bash ${2:?} (M1)", () => {
  it("mem add --type '' dies before writing (rc 1, no memdir created)", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "add", "--type", "", "hello world"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: --type requires a value\n");
    expect(fs.existsSync(dir())).toBe(false);
  });

  it("mem list --type '' dies (rc 1, no listing)", () => {
    writeMem("2026-01-01-01-00-00_aaaaaaaa_a.md", `---\nid: aaaaaaaa\ntype: note\n---\n\na\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "list", "--type", ""], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("mem: error: --type requires a value\n");
  });

  it("mem --dir '' dies (rc 1)", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", "", "list"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: --dir requires a path\n");
  });

  it("mem edit --slug '' dies and leaves the file untouched (rc 1)", () => {
    const original = `---\nid: aaaaaaaa\nsummary: first sum\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nold body\n`;
    writeMem("2026-01-01-01-00-00_aaaaaaaa_first.md", original);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "edit", "aaaaaaaa", "--slug", "", "new body"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: --slug requires TEXT\n");
    expect(fs.readdirSync(dir())).toEqual(["2026-01-01-01-00-00_aaaaaaaa_first.md"]);
    expect(fs.readFileSync(path.join(dir(), "2026-01-01-01-00-00_aaaaaaaa_first.md"), "utf8")).toBe(original);
  });
});

// --- list ---------------------------------------------------------------------

describe("mem list", () => {
  beforeEach(() => {
    writeMem(
      "2026-01-01-01-00-00_aaaaaaaa_first.md",
      `---\nid: aaaaaaaa\nsummary: first sum\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nfirst\n`,
    );
    writeMem(
      "2026-02-02-02-00-00_bbbbbbbb_second.md",
      `---\nid: bbbbbbbb\nsummary: second sum\ntype: note\ncreated: 2026-02-02 02:00:00\n---\n\nsecond\n`,
    );
  });

  it("verbose default: id, ts, [type], summary, path per memory", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list"], h.io);
    expect(h.out()).toBe(
      `aaaaaaaa  2026-01-01 01:00  [goal]\n` +
        `    first sum\n` +
        `    ${dir()}/2026-01-01-01-00-00_aaaaaaaa_first.md\n` +
        `bbbbbbbb  2026-02-02 02:00  [note]\n` +
        `    second sum\n` +
        `    ${dir()}/2026-02-02-02-00-00_bbbbbbbb_second.md\n`,
    );
  });

  it("short (-s): one aligned line per memory", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s"], h.io);
    expect(h.out()).toBe(
      `2026-01-01 01:00  aaaaaaaa  [goal]       first sum\n` +
        `2026-02-02 02:00  bbbbbbbb  [note]       second sum\n`,
    );
  });

  it("--type filters", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s", "--type", "note"], h.io);
    expect(h.out()).toBe(`2026-02-02 02:00  bbbbbbbb  [note]       second sum\n`);
  });

  it("--before / --after compare the date prefix inclusively", () => {
    const before = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s", "--before", "2026-01-31"], before.io);
    expect(before.out()).toContain("aaaaaaaa");
    expect(before.out()).not.toContain("bbbbbbbb");

    const after = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s", "--after", "2026-02-02"], after.io);
    expect(after.out()).toContain("bbbbbbbb");
    expect(after.out()).not.toContain("aaaaaaaa");
  });

  it("bare N limit keeps the last N (tail)", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s", "1"], h.io);
    expect(h.out()).toBe(`2026-02-02 02:00  bbbbbbbb  [note]       second sum\n`);
  });

  it("empty store prints 'No memories stored.' to stderr, rc 0", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", path.join(TMP, "none"), "list"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("No memories stored.\n");
  });

  it("falls back to slug when a short-view summary is absent", () => {
    writeMem("2026-03-03-03-00-00_cccccccc_slug-fallback.md", `---\ntype: fact\n---\n\nx\n`);
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "list", "-s", "--type", "fact"], h.io);
    expect(h.out()).toBe(`2026-03-03 03:00  cccccccc  [fact]       slug-fallback\n`);
  });
});

// --- types --------------------------------------------------------------------

describe("mem types", () => {
  it("counts by type, most-frequent first", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: goal\n---\n\na\n`);
    writeMem("2026-01-01-01-00-01_a2222222_b.md", `---\ntype: goal\n---\n\nb\n`);
    writeMem("2026-01-01-01-00-02_a3333333_c.md", `---\ntype: note\n---\n\nc\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "types"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe(`   2  goal\n   1  note\n`);
  });

  // QUIRK: the status is whatever `ls` returns for a path it cannot access on this platform
  // (GNU 2, BSD/macOS 1); upstream's set -o pipefail passes it through. Checked against the real `ls`.
  const lsRc = spawnSync("ls", [path.join(os.tmpdir(), "mem-types-definitely-not-here", "*.md")], { stdio: "ignore" }).status;
  it("QUIRK: missing store exits with ls's cannot-access status, no output", () => {
    expect(LS_CANNOT_ACCESS_RC).toBe(lsRc);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", path.join(TMP, "none"), "types"], h.io);
    expect(rc).toBe(lsRc);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("");
  });
  it("QUIRK: existing but empty store exits the same way", () => {
    fs.mkdirSync(path.join(TMP, "emptystore"), { recursive: true });
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", path.join(TMP, "emptystore"), "types"], h.io);
    expect(rc).toBe(lsRc);
    expect(h.out()).toBe("");
  });

  // bug #44: bash's `sort | uniq -c | sort -rn` pipeline (bin/mem's
  // action_types) has `sort -rn` compare whole lines: numeric prefix first
  // (the count), then — for a TIE — the reverse-`-r`-applied REST OF THE
  // LINE (the type name) as a plain string compare, i.e. DESCENDING
  // alphabetical for equal counts (verified directly: `printf '1 goal\n1
  // note\n1 apple\n' | sort -rn` -> note, goal, apple — reverse-alpha, not
  // insertion order). The port sorted ties ASCENDING. Captured directly
  // against upstream (parity/fuzz/findings/mem-1.md): a store with one
  // `type: goal` and one `type: note` memory -> `mem types` prints
  // "   1  note\n   1  goal\n" (note first), not goal-first.
  it("bug #44: ties (equal counts) sort by type DESCENDING, matching bash's sort -rn tie-break", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: goal\n---\n\na\n`);
    writeMem("2026-01-01-01-00-01_a2222222_b.md", `---\ntype: note\n---\n\nb\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "types"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe(`   1  note\n   1  goal\n`);
  });
});

// --- show / forget ------------------------------------------------------------

describe("mem show / forget", () => {
  beforeEach(() => {
    writeMem(
      "2026-01-01-01-00-00_abcd1234_note.md",
      `---\nid: abcd1234\nsummary: s\ntype: note\ncreated: 2026-01-01 01:00:00\n---\n\nbody text\n`,
    );
  });

  it("show prints the full file by hex prefix", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "show", "abcd"], h.io);
    expect(h.out()).toContain("body text");
    expect(h.out()).toContain("id: abcd1234");
  });

  it("forget deletes and reports on stderr", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "forget", "abcd1234"], h.io);
    expect(rc).toBe(0);
    expect(fs.readdirSync(dir())).toHaveLength(0);
    expect(h.err()).toBe("Forgotten: 2026-01-01-01-00-00_abcd1234_note\n");
  });

  it("show dies on an unknown id", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "show", "ffffffff"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe(
      "mem: error: Memory not found: ffffffff (use hex ID prefix from 'mem list')\n",
    );
  });

  it("dies 'Ambiguous' when a prefix matches multiple", () => {
    writeMem("2026-01-01-01-00-00_abcd9999_two.md", `---\nid: abcd9999\ntype: note\n---\n\ntwo\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "show", "abcd"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: Ambiguous: 'abcd' matches multiple memories\n");
  });
});

// --- edit ---------------------------------------------------------------------

describe("mem edit", () => {
  beforeEach(() => {
    writeMem(
      "2026-01-01-01-00-00_11112222_orig-slug.md",
      `---\nid: 11112222\nsummary: original\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\noriginal body\n`,
    );
  });

  it("rewrites body, adds an 'updated' field, and renames the slug", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "edit", "11112222", "new body here"], h.io);
    expect(rc).toBe(0);
    const newName = "2026-01-01-01-00-00_11112222_new-body-here.md";
    expect(fs.existsSync(path.join(dir(), newName))).toBe(true);
    const content = fs.readFileSync(path.join(dir(), newName), "utf8");
    expect(content).toBe(
      `---\nid: 11112222\nsummary: new body here\ntype: goal\n` +
        `created: 2026-01-01 01:00:00\nupdated: 2026-01-02 03:04:05\n---\n\nnew body here\n`,
    );
    expect(h.err()).toBe("Updated: 2026-01-01-01-00-00_11112222_new-body-here\n");
  });

  it("converts a single 'updated' into a YAML list on the second edit", () => {
    const h1 = makeIO({ dir: "" });
    runMem(["--dir", dir(), "edit", "11112222", "second"], h1.io);
    const h2 = makeIO({ dir: "" });
    runMem(["--dir", dir(), "edit", "11112222", "third"], h2.io);
    const name = "2026-01-01-01-00-00_11112222_third.md";
    const content = fs.readFileSync(path.join(dir(), name), "utf8");
    expect(content).toContain(
      `updated:\n  - 2026-01-02 03:04:05\n  - 2026-01-02 03:04:05\n`,
    );
  });

  it("--slug overrides the derived slug", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "edit", "11112222", "--slug", "My Custom Slug", "text body"], h.io);
    expect(fs.existsSync(path.join(dir(), "2026-01-01-01-00-00_11112222_my-custom-slug.md"))).toBe(
      true,
    );
  });

  // --- until: rides through an edit (1c: 51a8585) ------------------------------

  it("preserves an existing until: line, placed right after created:, before updated:", () => {
    writeMem(
      "2026-01-01-01-00-00_efbef190_passport.md",
      `---\nid: efbef190\nsummary: renew passport\ntype: memory\n` +
        `created: 2026-01-01 01:00:00\nuntil: 2026-12-31\n---\n\nrenew passport\n`,
    );
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "edit", "efbef190", "renew passport abroad"], h.io);
    expect(rc).toBe(0);
    const newName = "2026-01-01-01-00-00_efbef190_renew-passport-abroad.md";
    const content = fs.readFileSync(path.join(dir(), newName), "utf8");
    expect(content).toBe(
      `---\nid: efbef190\nsummary: renew passport abroad\ntype: memory\n` +
        `created: 2026-01-01 01:00:00\nuntil: 2026-12-31\n` +
        `updated: 2026-01-02 03:04:05\n---\n\nrenew passport abroad\n`,
    );
  });

  it("no until: on the original — none is added", () => {
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "edit", "11112222", "new body here"], h.io);
    const content = fs.readFileSync(
      path.join(dir(), "2026-01-01-01-00-00_11112222_new-body-here.md"),
      "utf8",
    );
    expect(content).not.toContain("until:");
  });
});

// --- search -------------------------------------------------------------------

describe("mem search", () => {
  it("builds the corpus and invokes llm with the fast model, -t, and system prompt", () => {
    writeMem(
      "2026-01-01-01-00-00_dddddddd_note.md",
      `---\nid: dddddddd\nsummary: about cats\ntype: note\n---\n\ncats are great\n`,
    );
    const h = makeIO({ dir: "", env: { SHELLM_FAST_MODEL: "fast-1" } });
    const rc = runMem(["--dir", dir(), "search", "feline", "friends"], h.io);
    expect(rc).toBe(0);
    expect(h.llmCalls).toHaveLength(1);
    const call = h.llmCalls[0]!;
    // 766a290: `-t MEM_SEARCH_MAX_TOKENS` always rides along, before `-s`.
    expect(call.args).toEqual(["-m", "fast-1", "-t", "16000", "-s", call.args[5]]);
    expect(call.args[5]).toContain("semantic search engine for memory files");
    expect(call.stdin.startsWith("Search these memories for: feline friends\n\n")).toBe(true);
    // No term overlap ("feline"/"friends" vs "cats"/"great") -> falls back to
    // the newest files (766a290), which is this one lone file.
    expect(call.stdin).toContain("=== 2026-01-01-01-00-00_dddddddd_note.md ===");
    expect(call.stdin).toContain("cats are great");
  });

  it("omits -m when no fast model is configured, keeping -t before -s", () => {
    writeMem("2026-01-01-01-00-00_eeeeeeee_x.md", `---\ntype: note\n---\n\nx\n`);
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "search", "q"], h.io);
    expect(h.llmCalls[0]!.args.slice(0, 3)).toEqual(["-t", "16000", "-s"]);
  });

  it("fixed (766a290): empty store prints 'No memories stored.' to stderr, rc 0, no llm call", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", path.join(TMP, "none"), "search", "q"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("No memories stored.\n");
    expect(h.llmCalls).toHaveLength(0);
  });

  it("stage 1 (766a290, 130796a BM25): the prefilter keeps only term-matching files, best first", () => {
    writeMem(
      "2026-01-01-01-00-00_aaaaaaaa_dogs.md",
      `---\ntype: note\n---\n\ndogs are loyal pets, dogs love walks, dogs bark\n`,
    );
    writeMem(
      "2026-02-02-02-00-00_bbbbbbbb_other.md",
      `---\ntype: note\n---\n\nquantum entanglement and orbital mechanics\n`,
    );
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "search", "dogs"], h.io);
    const stdin = h.llmCalls[0]!.stdin;
    expect(stdin).toContain("dogs.md");
    expect(stdin).not.toContain("other.md");
  });

  it("MEM_SEARCH_TOP / MEM_SEARCH_MAX_TOKENS env override the defaults", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha term\n`);
    const h = makeIO({ dir: "", env: { MEM_SEARCH_MAX_TOKENS: "500" } });
    runMem(["--dir", dir(), "search", "alpha"], h.io);
    expect(h.llmCalls[0]!.args).toContain("500");
  });

  // --- heartbeat (1c: 69fddc6) — MEM_SEARCH_HEARTBEAT_S threading only; the
  // actual concurrent stderr output is a shim-level (bin/mem.mjs) concern,
  // covered by the real-subprocess test below.
  it("passes the resolved MEM_SEARCH_HEARTBEAT_S (default 10) to runLlm", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha term\n`);
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "search", "alpha"], h.io);
    expect(h.llmCalls[0]!.heartbeatSeconds).toBe("10");
  });

  it("MEM_SEARCH_HEARTBEAT_S env overrides the default", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha term\n`);
    const h = makeIO({ dir: "", env: { MEM_SEARCH_HEARTBEAT_S: "0" } });
    runMem(["--dir", dir(), "search", "alpha"], h.io);
    expect(h.llmCalls[0]!.heartbeatSeconds).toBe("0");
  });
});

// --- heartbeat, real subprocess (1c: 69fddc6) ---------------------------------
// bin/mem.mjs spawns a real background Node process to print the heartbeat
// while the real `llm` is blocked in spawnSync — a JS timer would never get a
// turn on the single blocked thread, so this exercises the actual mechanism,
// not just the src/mem.ts threading above. `llm` answers from a recorded real
// DeepSeek search reply (test/fixtures/recordings/mem/search-hello.json),
// served from a child process that holds it back (delayMs) like a slow
// provider. Real clock; asserts "at least one line", not an exact count.
describe("mem search heartbeat (real subprocess)", () => {
  const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");
  async function slowSearch(heartbeat: string, delayMs: number) {
    const { spawnSync } = await import("node:child_process");
    const memDir = "/tmp/uc-rec-mem-hb/memories"; // fixed: the path is not in the prompt, but keep it stable anyway
    claimFixedRoot(path.dirname(memDir));
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "2026-01-01-01-00-00_aaaaaaaa_a.md"), `---\nid: aaaaaaaa\ntype: note\n---\n\nhello world\n`);
    const srv = await recordedServerProcess("mem", "search-hello", process.env["UC_RECORD"] === "1" ? {} : { delayMs });
    try {
      const res = spawnSync(process.execPath, [path.join(BIN, "mem.mjs"), "--dir", memDir, "search", "hello"], {
        env: { ...process.env, ...srv.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, SHELLM_FAST_MODEL: RECORD_MODEL, MEM_SEARCH_HEARTBEAT_S: heartbeat },
        encoding: "utf8",
        timeout: 15000,
      });
      return res;
    } finally {
      await srv.close();
      fs.rmSync(path.dirname(memDir), { recursive: true, force: true });
    }
  }
  const recorded = () => {
    const rec = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, "mem", "search-hello.json"), "utf8")) as Recording;
    return recordedText(rec.calls[0]!);
  };
  it("prints 'waiting for the model' at least once while a slow llm runs", async () => {
    const res = await slowSearch("1", 2200);
    expect(res.stderr).toContain("mem search: waiting for the model...");
    expect(res.stdout.trim()).toBe(recorded().trim()); // the real reply reaches the user whole
  }, 15000);

  it("MEM_SEARCH_HEARTBEAT_S=0 disables it even over a slow llm", async () => {
    const res = await slowSearch("0", 1200);
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe(recorded().trim());
  }, 15000);
});

// --- mem prefilter (1c: 130796a) ----------------------------------------------

describe("mem prefilter", () => {
  it("prints the ranked candidate paths, best first, with no model call", () => {
    writeMem(
      "2026-01-01-01-00-00_aaaaaaaa_dogs.md",
      `---\ntype: note\n---\n\ndogs are loyal pets, dogs love walks, dogs bark\n`,
    );
    writeMem(
      "2026-02-02-02-00-00_bbbbbbbb_other.md",
      `---\ntype: note\n---\n\nquantum entanglement and orbital mechanics\n`,
    );
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "prefilter", "dogs"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe(`${dir()}/2026-01-01-01-00-00_aaaaaaaa_dogs.md\n`);
    expect(h.llmCalls).toHaveLength(0);
  });

  it("--top N caps the candidate count", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha beta gamma\n`);
    writeMem("2026-01-02-01-00-00_a2222222_b.md", `---\ntype: note\n---\n\nalpha beta delta\n`);
    writeMem("2026-01-03-01-00-00_a3333333_c.md", `---\ntype: note\n---\n\nalpha beta epsilon\n`);
    const h = makeIO({ dir: "" });
    runMem(["--dir", dir(), "prefilter", "alpha beta", "--top", "1"], h.io);
    expect(h.out().trim().split("\n")).toHaveLength(1);
  });

  it("prints nothing (rc 0) when no term matches — no fallback (unlike mem search)", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha beta\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "prefilter", "zzznomatch"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
  });

  it("dies with a usage message when no query is given", () => {
    writeMem("2026-01-01-01-00-00_a1111111_a.md", `---\ntype: note\n---\n\nalpha\n`);
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", dir(), "prefilter"], h.io);
    expect(rc).toBe(1);
    expect(h.err()).toBe("mem: error: Usage: mem prefilter <query> [--top N]\n");
  });

  it("rc 0, no output, on a missing/empty store", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir", path.join(TMP, "none"), "prefilter", "alpha"], h.io);
    expect(rc).toBe(0);
    expect(h.out()).toBe("");
  });
});

// --- extractPrefilterTerms / scorePrefilterCandidates (1c: 766a290, 69fddc6, 130796a) -----

describe("extractPrefilterTerms", () => {
  it("lowercases, keeps terms >= 3 allowed bytes, drops stopwords, sorts unique", () => {
    // Verified against real Bash: `@` is in the allowed set, so "@home" stays
    // one token (not split into "home").
    expect(extractPrefilterTerms("The Dogs and the Cats, feline#1 @home v2.0")).toEqual(
      [...new Set(["dogs", "cats", "feline#1", "@home", "v2.0"])].sort(),
    );
  });

  it("byte-wise under C locale: a multibyte UTF-8 char's continuation bytes are separators", () => {
    // "café" in UTF-8 is c-a-f-\xC3\xA9 — the 2-byte é splits into two bytes,
    // neither in [a-z0-9_#@.-], so "café" tokenizes as "caf" (3 allowed bytes)
    // then a lone trailing byte, not as one 4-character word.
    expect(extractPrefilterTerms("café")).toEqual(["caf"]);
  });

  it("returns [] when every word is short or a stopword", () => {
    expect(extractPrefilterTerms("is it the")).toEqual([]);
  });
});

describe("scorePrefilterCandidates", () => {
  it("ranks a file with more term matches, relative to its length, higher", () => {
    const files = [
      { name: "a.md", content: Buffer.from("alpha alpha alpha beta\n") },
      { name: "b.md", content: Buffer.from("alpha\n") },
    ];
    const scored = scorePrefilterCandidates(files, ["alpha"]);
    expect(scored.map((s) => s.name)).toEqual(["a.md", "b.md"]);
  });

  it("[] when no term matches any file", () => {
    const files = [{ name: "a.md", content: Buffer.from("nothing relevant here\n") }];
    expect(scorePrefilterCandidates(files, ["zzz"])).toEqual([]);
  });

  it("a genuinely empty file (0 bytes) is silently excluded, not scored", () => {
    const files = [
      { name: "empty.md", content: Buffer.from("") },
      { name: "a.md", content: Buffer.from("alpha term\n") },
    ];
    expect(scorePrefilterCandidates(files, ["alpha"]).map((s) => s.name)).toEqual(["a.md"]);
  });

  // bug found verifying 130796a's `sort -k1,1 -gr` against real Bash: BSD
  // `sort`'s `-r` (no `-s`) reverses tie order rather than preserving input
  // order — `printf '5.0\ta\n3.0\tb\n5.0\tc\n' | sort -t$'\t' -k1,1 -gr`
  // gives c, a, b (verified directly against the box's own `/usr/bin/sort`).
  it("equal-scoring files come out in REVERSE glob/insertion order (BSD sort -gr quirk)", () => {
    const files = [
      { name: "a.md", content: Buffer.from("alpha beta gamma\n") },
      { name: "b.md", content: Buffer.from("alpha beta delta\n") },
      { name: "c.md", content: Buffer.from("alpha beta gamma\n") },
    ];
    // a and c are byte-identical content (same score); b's last word differs
    // but is the same length, so all three score identically for "alpha beta".
    expect(scorePrefilterCandidates(files, ["alpha", "beta"]).map((s) => s.name)).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);
  });
});

// --- global flags / dispatch --------------------------------------------------

describe("global flags and dispatch", () => {
  it("--version", () => {
    const h = makeIO({ dir: "" });
    expect(runMem(["--version"], h.io)).toBe(0);
    expect(h.out()).toBe(`mem ${MEM_VERSION}\n`);
  });
  it("no args prints usage", () => {
    const h = makeIO({ dir: "" });
    expect(runMem([], h.io)).toBe(0);
    expect(h.out()).toContain("mem — CLI memory store");
  });
  it("unknown command dies", () => {
    const h = makeIO({ dir: "" });
    expect(runMem(["bogus"], h.io)).toBe(1);
    expect(h.err()).toBe("mem: error: Unknown command: bogus (try mem --help)\n");
  });
  it("MEM_DIR env is honored", () => {
    const h = makeIO({ dir: "", env: { MEM_DIR: dir() } });
    runMem(["add", "env dir test"], h.io);
    expect(fs.existsSync(dir())).toBe(true);
    expect(fs.readdirSync(dir())).toHaveLength(1);
  });
});

// --- .memrc -------------------------------------------------------------------

describe(".memrc", () => {
  it("supplies MEM_DIR as a default; env overrides it", () => {
    const rcDir = path.join(TMP, "rcdir");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    fs.writeFileSync(path.join(cwd, ".memrc"), `MEM_DIR=${rcDir}\nMEM_TYPE=belief\n`);
    try {
      // rc provides MEM_DIR + MEM_TYPE (no --dir, no env).
      const h = makeIO({ dir: "", cwd });
      runMem(["add", "from rc"], h.io);
      const file = fs.readdirSync(rcDir)[0]!;
      expect(frontmatterField(fs.readFileSync(path.join(rcDir, file), "utf8"), "type")).toBe(
        "belief",
      );

      // env MEM_DIR beats rc MEM_DIR.
      const envDir = path.join(TMP, "envdir");
      const h2 = makeIO({ dir: "", cwd, env: { MEM_DIR: envDir } });
      runMem(["add", "env wins"], h2.io);
      expect(fs.existsSync(envDir)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // MEM_TYPE precedence mirrors Bash's `_pre_env` reset (regression: the port
  // previously let env MEM_TYPE win whenever a .memrc existed). Bash sets
  // `MEM_TYPE="memory"`, snapshots exported MEM_* into `_pre_env`, sources the
  // .memrc, then re-exports the snapshot — so a set env MEM_TYPE re-applies as
  // "memory", discarding its value and clobbering any .memrc MEM_TYPE.
  it("env MEM_TYPE is reset to 'memory' when a .memrc exists (rc has no MEM_TYPE)", () => {
    const rcDir = path.join(TMP, "rcmem-a");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    fs.writeFileSync(path.join(cwd, ".memrc"), `MEM_DIR=${rcDir}\n`);
    try {
      const h = makeIO({ dir: "", cwd, env: { MEM_TYPE: "fact", MEM_DIR: rcDir } });
      const rc = runMem(["add", "typed"], h.io);
      expect(rc).toBe(0);
      const file = fs.readdirSync(rcDir)[0]!;
      const content = fs.readFileSync(path.join(rcDir, file), "utf8");
      expect(frontmatterField(content, "type")).toBe("memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("env MEM_TYPE reset even clobbers a MEM_TYPE assigned inside .memrc", () => {
    const rcDir = path.join(TMP, "rcmem-b");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    fs.writeFileSync(path.join(cwd, ".memrc"), `MEM_DIR=${rcDir}\nMEM_TYPE=belief\n`);
    try {
      const h = makeIO({ dir: "", cwd, env: { MEM_TYPE: "fact" } });
      runMem(["add", "typed"], h.io);
      const file = fs.readdirSync(rcDir)[0]!;
      const content = fs.readFileSync(path.join(rcDir, file), "utf8");
      // env MEM_TYPE present → re-exported "memory" wins over rc's belief.
      expect(frontmatterField(content, "type")).toBe("memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a .memrc MEM_TYPE still wins when env MEM_TYPE is unset", () => {
    const rcDir = path.join(TMP, "rcmem-c");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    fs.writeFileSync(path.join(cwd, ".memrc"), `MEM_DIR=${rcDir}\nMEM_TYPE=belief\n`);
    try {
      const h = makeIO({ dir: "", cwd, env: {} });
      runMem(["add", "typed"], h.io);
      const file = fs.readdirSync(rcDir)[0]!;
      const content = fs.readFileSync(path.join(rcDir, file), "utf8");
      expect(frontmatterField(content, "type")).toBe("belief");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // No .memrc: the env-MEM_TYPE reset block never runs, and Bash's own
  // `MEM_TYPE="memory"` default stands — a set env MEM_TYPE is ignored. This is
  // the adjacent (unchanged) branch the fix must not disturb. Bash-verified.
  it("env MEM_TYPE is ignored entirely when no .memrc exists (stays 'memory')", () => {
    const rcDir = path.join(TMP, "rcmem-d");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    // Deliberately no .memrc written in cwd.
    try {
      const h = makeIO({ dir: "", cwd, env: { MEM_TYPE: "belief", MEM_DIR: rcDir } });
      runMem(["add", "typed"], h.io);
      const file = fs.readdirSync(rcDir)[0]!;
      const content = fs.readFileSync(path.join(rcDir, file), "utf8");
      expect(frontmatterField(content, "type")).toBe("memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The reset gate is `env["MEM_TYPE"] !== undefined`, NOT truthiness: Bash
  // snapshots the (already-reset) exported MEM_TYPE whenever the var is present
  // in the environment at all, empty string included. A set-but-empty env
  // MEM_TYPE therefore still resets to "memory" and clobbers rc's belief.
  // Guards against a truthiness "simplification" that would leak rc's value.
  // Bash-verified: env MEM_TYPE='' + rc MEM_TYPE=belief → type: memory.
  it("empty-string env MEM_TYPE still resets to 'memory' over rc (not truthiness)", () => {
    const rcDir = path.join(TMP, "rcmem-e");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-rc-"));
    fs.writeFileSync(path.join(cwd, ".memrc"), `MEM_DIR=${rcDir}\nMEM_TYPE=belief\n`);
    try {
      const h = makeIO({ dir: "", cwd, env: { MEM_TYPE: "", MEM_DIR: rcDir } });
      runMem(["add", "typed"], h.io);
      const file = fs.readdirSync(rcDir)[0]!;
      const content = fs.readFileSync(path.join(rcDir, file), "utf8");
      expect(frontmatterField(content, "type")).toBe("memory");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- flag-missing-value misuse (PORT-NOTE deviation) --------------------------
// Bash uses `${2:?message}` here, printing `<script>: line N: 2: <message>` and
// exiting 1. The port keeps a clean `mem: error: <message>`; exit code (1),
// empty stdout, and on-disk state match Bash. Only the stderr wording differs,
// on a misuse path no caller inspects. See PARITY.md.

describe("flag-missing-value misuse", () => {
  it("--dir with no value: exit 1, empty stdout, clean stderr", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["--dir"], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("mem: error: --dir requires a path\n");
  });

  it("list --type with no value: exit 1, empty stdout, clean stderr", () => {
    const h = makeIO({ dir: "" });
    const rc = runMem(["list", "--type"], h.io);
    expect(rc).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("mem: error: --type requires a value\n");
  });
});

// --- structured reader (engine-side interface) --------------------------------

describe("readMemories / parseMemory", () => {
  it("parses memory files into records the goals scraper can consume", () => {
    writeMem(
      "2026-01-01-01-00-00_99998888_goal-one.md",
      `---\nid: 99998888\nsummary: reach orbit\ntype: goal\ncreated: 2026-01-01 01:00:00\n---\n\nreach orbit this quarter\n`,
    );
    const recs = readMemories(dir());
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: "99998888",
      type: "goal",
      summary: "reach orbit",
      slug: "goal-one",
      ts: "2026-01-01-01-00-00",
    });
    expect(recs[0]!.body).toContain("reach orbit this quarter");
  });

  it("parseMemory extracts the body after the frontmatter (incl. the blank separator)", () => {
    const rec = parseMemory(
      `---\nid: aa\ntype: note\n---\n\nline one\nline two\n`,
      "2026-01-01-01-00-00_aaaaaaaa_x.md",
    );
    // Body is everything after the closing fence — the layout is `---\n\n<text>`,
    // so it opens with the blank separator line. Consumers trim as needed.
    expect(rec.body).toBe("\nline one\nline two\n");
  });

  it("returns [] for a missing directory", () => {
    expect(readMemories(path.join(TMP, "does-not-exist"))).toEqual([]);
  });
});
