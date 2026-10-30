// retrieval.test.ts — the retrieval thinker (passive no-LLM memory recall),
// tested against its deterministic Bash oracle.
//
// Four layers, all deterministic (no LLM, no docker):
//   1. pure functions — tokenizer, index rows, scoring, seen ring — including
//      BYTE-equality of the index built from the 14 pax memories against the
//      golden index (golden/trace-05-retrieval, built by the real build-index.sh);
//   2. the 8 scenarios of tests/test_retrieval_thinker.sh, verbatim (same
//      fixtures aaaa1111/bbbb2222/cccc3333, same expectations), driven through
//      the same stdin/env contract the Bash step has;
//   3. the no-op matrix + knobs + the replicated quirks (seen-before-append,
//      stale-index-after-forget, run_id auto-link, semantic suffix seam);
//   4. the golden replay (the in-range pax triggers reproduce the captured
//      observations modulo step_id/ts) and the topology with the third thinker
//      enabled: a resonant thought → retrieval observation → reactive monolith
//      wake `reactive/observation:retrieval` → retrieval's own step self-skipped.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tokenize,
  indexTokenSource,
  indexRowsFor,
  renderIndex,
  countRows,
  buildIndex,
  parseIndex,
  score,
  readSeen,
  nextSeen,
  runRetrievalStep,
  STOPWORDS,
  RETRIEVAL_SUBSCRIPTION,
  THINKER_NAME,
  type RetrievalIO,
  type RetrievalEnv,
} from "../src/retrieval.js";
import { readMemoryFiles } from "../src/mem.js";
import { createTrajectory, resolveTrajFile } from "../src/trajectory.js";
import { appendStep, readSteps } from "../src/trajCore.mjs";
import { createTwoThinkerSystem } from "../src/topology.js";
import { LocalSandbox } from "../src/sandbox.js";
import type { IdentityConfig } from "../src/monolith.js";
import type { Step } from "../src/types.js";
import { httpModel } from "./support/modelHttpFixture.js";
import { recordedModel } from "./support/recordedModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(HERE, "..", "bin");
const GOLDEN = path.join(HERE, "..", "golden", "trace-05-retrieval");

// ---------------------------------------------------------------------------
// Harness: a throwaway identity exactly like tests/test_retrieval_thinker.sh
// ---------------------------------------------------------------------------

const TRAJ_ID = "cafe0000-0000-0000-0000-00000000beef";

interface Ident {
  work: string;
  id: string;
  memDir: string;
  /** `$ID/trajectories/$TRAJ_ID/trajectory.jsonl` — the full-uuid layout the Bash test uses. */
  traj: string;
  env: RetrievalEnv;
  stderr: string[];
  io: RetrievalIO;
  cleanup(): void;
}

function makeIdent(opts: { memSearch?: (q: string) => string } = {}): Ident {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-retr-"));
  const id = path.join(work, "ident");
  const memDir = path.join(id, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(path.join(id, "trajectories", TRAJ_ID), { recursive: true });
  fs.writeFileSync(path.join(id, "info.txt"), `name=testid\ncreated=test\nroot_trajectory=${TRAJ_ID}\n`);
  const traj = path.join(id, "trajectories", TRAJ_ID, "trajectory.jsonl");
  fs.writeFileSync(traj, "");
  const env: RetrievalEnv = {
    IDENTITY_DIR: id,
    IDENTITY_NAME: "testid",
    MEM_DIR: memDir,
    TRAJ_DIR: path.join(id, "trajectories"),
    TRAJ_ID,
    SKILLS_DIR: path.join(id, "skills"),
    SKILLS_KERNEL_DIR: path.join(id, "kernel"),
    HOME: path.join(work, "home"),
  };
  const stderr: string[] = [];
  const io: RetrievalIO = {
    readMemoryFiles,
    appendStep: (record, o) => {
      const file = resolveTrajFile(env["TRAJ_DIR"] ?? "", env["TRAJ_ID"] ?? "");
      if (!file) throw new Error(`traj: error: append: cannot resolve traj_id '${env["TRAJ_ID"]}' in '${env["TRAJ_DIR"]}'`);
      return appendStep(file, record, o);
    },
    ...(opts.memSearch ? { memSearch: opts.memSearch } : {}),
    stderr: (s) => {
      stderr.push(s);
    },
  };
  return { work, id, memDir, traj, env, stderr, io, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** mem_file: `---\nid: %s\nsummary: %s\ntype: fact\n---\n%s\n` */
function memFile(ident: Ident, name: string, mid: string, summary: string, body: string): string {
  const p = path.join(ident.memDir, `${name}.md`);
  fs.writeFileSync(p, `---\nid: ${mid}\nsummary: ${summary}\ntype: fact\n---\n${body}\n`);
  return p;
}
function seedColimaAndPager(ident: Ident): void {
  memFile(
    ident,
    "20260801_aaaa_colima",
    "aaaa1111",
    "docker on this mac is colima",
    "Bind mounts silently fail for paths colima does not mount. Only home and tmp are mounted."
  );
  memFile(
    ident,
    "20260802_bbbb_pager",
    "bbbb2222",
    "short git output vanishes in the pager",
    "The LESS variable lacks -X so paged git output disappears when less exits."
  );
}

/** step: `{"type":"%s","step_id":"s-%s","content":"%s"%s}` — as stdin TEXT, like the Bash test. */
function step(type: string, n: number | string, content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, step_id: `s-${n}`, content, ...extra });
}
function run(ident: Ident, stdin: string | Record<string, unknown>, envExtra: RetrievalEnv = {}) {
  return runRetrievalStep(stdin, { ...ident.env, ...envExtra }, ident.io);
}
function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}
function obsCount(ident: Ident): number {
  return lines(ident.traj).filter((l) => l.includes('"source":"retrieval"')).length;
}
function lastObs(ident: Ident): Record<string, unknown> {
  const l = lines(ident.traj).filter((x) => x.includes('"source":"retrieval"'));
  return JSON.parse(l[l.length - 1]!) as Record<string, unknown>;
}
function indexPath(ident: Ident): string {
  return path.join(ident.id, "retrieval", "index.tsv");
}
function seenPath(ident: Ident): string {
  return path.join(ident.id, "retrieval", "seen");
}
/** Make a file strictly newer than everything written so far (the Bash test's `sleep 1`). */
function bumpMtime(p: string): void {
  const t = new Date(Date.now() + 5_000);
  fs.utimesSync(p, t, t);
}

// ===========================================================================
// 1. Pure functions
// ===========================================================================

describe("tokenize — the shared word pipeline (tr | tr -cs | grep -E | grep -vxF | sort -u)", () => {
  it("lowercases ASCII, splits on every non-alnum, keeps [a-z0-9]{3,}, drops stopwords, distinct + sorted", () => {
    expect(tokenize("Why does the docker bind mount of this path silently fail on colima?")).toEqual([
      "bind",
      "colima",
      "docker",
      "fail",
      "mount",
      "path",
      "silently",
      "why",
    ]);
    expect(tokenize("zeta alpha zeta ALPHA")).toEqual(["alpha", "zeta"]);
    expect(tokenize("ab abc a1 a12")).toEqual(["a12", "abc"]);
  });
  it("digits are words; apostrophes and punctuation split", () => {
    expect(tokenize("2026-08-28 at 16:41 — 12345")).toEqual(["12345", "2026"]);
    expect(tokenize("Don't panic; it's pax's")).toEqual(["don", "panic", "pax"]);
  });
  it("C-locale bytes: a non-ASCII letter splits the word (PORT-NOTE locale)", () => {
    expect(tokenize("Café résumé naïve Ünder")).toEqual(["caf", "nder", "sum"]);
  });
  it("the 110 stopwords are exactly the shipped list and are all removed", () => {
    expect(STOPWORDS.size).toBe(110);
    for (const w of ["about", "the", "you", "your", "would", "with"]) expect(STOPWORDS.has(w)).toBe(true);
    expect(STOPWORDS.has("why")).toBe(false);
    expect(tokenize([...STOPWORDS].join(" "))).toEqual([]);
  });
});

describe("index rows — build-index.sh per-file semantics", () => {
  const colima =
    "---\nid: aaaa1111\nsummary: docker on this mac is colima\ntype: fact\ncreated: 2026-08-01 10:00:00\n---\n" +
    "Bind mounts silently fail for paths colima does not mount. Only home and tmp are mounted.\n";

  it("tokenizes the body PLUS the summary: line; the rest of the frontmatter is excluded", () => {
    const src = indexTokenSource(colima);
    expect(src.startsWith("summary: docker on this mac is colima\n")).toBe(true);
    expect(src).not.toContain("type: fact");
    expect(src).not.toContain("created:");
    const words = indexRowsFor(colima).map((r) => r.word);
    expect(words).toContain("summary"); // the `summary:` line itself is tokenized (replicated quirk)
    expect(words).toContain("colima");
    expect(words).not.toContain("fact");
    expect(words).not.toContain("created");
    expect(words).not.toContain("2026");
  });
  it("mid = first `id:` line anywhere, summary = first `summary:` line with tabs → spaces; no id → no rows", () => {
    expect(indexRowsFor(colima)[0]).toEqual({ word: "bind", mid: "aaaa1111", summary: "docker on this mac is colima" });
    const tabbed = "---\nid:\tzz\nsummary: a\tb\tc\n---\nbody words here\n";
    expect(indexRowsFor(tabbed)[0]).toEqual({ word: "body", mid: "zz", summary: "a b c" });
    expect(indexRowsFor("---\nsummary: no id\n---\nbody words\n")).toEqual([]);
    expect(indexRowsFor("---\nid:\nsummary: empty id\n---\nbody words\n")).toEqual([]);
    // no leading frontmatter: every line is body, `id:` is still found by sed
    const flat = "id: q1\ntype: fact\nbody words\n";
    expect(indexRowsFor(flat).map((r) => r.word)).toEqual(["body", "fact", "type", "words"]);
    expect(indexRowsFor(flat)[0]!.summary).toBe("");
  });
  it("renderIndex: `sort -u` by bytes, one row per line, trailing newline; empty when no rows", () => {
    const text = renderIndex([colima, "---\nid: bbbb2222\nsummary: pager\n---\nAbc zzz\n"]);
    expect(text.endsWith("\n")).toBe(true);
    const rows = text.split("\n").filter((l) => l !== "");
    expect(rows).toEqual([...rows].sort());
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).toContain("colima\taaaa1111\tdocker on this mac is colima");
    expect(rows).toContain("abc\tbbbb2222\tpager");
    expect(countRows(text)).toBe(rows.length);
    expect(renderIndex([])).toBe("");
    expect(renderIndex(["no id here\n"])).toBe("");
  });
  it("GOLDEN: the index built from the 14 pax memories is byte-equal to the real build-index.sh output", () => {
    const contents = readMemoryFiles(path.join(GOLDEN, "memories")).map((f) => f.content);
    expect(contents.length).toBe(14);
    const golden = fs.readFileSync(path.join(GOLDEN, "index.tsv"));
    const mine = Buffer.from(renderIndex(contents), "utf8");
    expect(mine.equals(golden)).toBe(true);
    expect(countRows(golden.toString("utf8"))).toBe(462); // see golden/trace-05-retrieval/NOTES.md
    // and through the file-writing entry point (build-index.sh's row count contract)
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idx-")), "sub", "index.tsv");
    try {
      expect(buildIndex(path.join(GOLDEN, "memories"), out, readMemoryFiles)).toBe(462);
      expect(fs.readFileSync(out).equals(golden)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(path.dirname(out)), { recursive: true, force: true });
    }
  });
});

describe("score — distinct shared words per memory, best one, pinned tie-break", () => {
  const rows = parseIndex(
    [
      "colima\taaaa1111\tdocker on this mac is colima",
      "docker\taaaa1111\tdocker on this mac is colima",
      "mount\taaaa1111\tdocker on this mac is colima",
      "docker\tbbbb2222\tpager",
      "output\tbbbb2222\tpager",
      "pager\tbbbb2222\tpager",
    ].join("\n") + "\n"
  );
  it("counts DISTINCT step words present in a memory's rows and picks the max", () => {
    expect(score(["colima", "docker", "mount"], rows)).toEqual({ hits: 3, mid: "aaaa1111", summary: "docker on this mac is colima" });
    expect(score(["output", "pager"], rows)).toEqual({ hits: 2, mid: "bbbb2222", summary: "pager" });
    expect(score(["nothing"], rows)).toBeUndefined();
    expect(score([], rows)).toBeUndefined();
  });
  it("PORT-NOTE tie-break: equal hits → greatest id (byte order), as `sort -rn | head -1` does", () => {
    expect(score(["docker"], rows)!.mid).toBe("bbbb2222");
    const rev = parseIndex("docker\tbbbb2222\tp\ndocker\taaaa1111\tq\n");
    expect(score(["docker"], rev)!.mid).toBe("bbbb2222"); // independent of row order
    // higher hits always win regardless of id
    expect(score(["colima", "docker"], rows)!.mid).toBe("aaaa1111");
  });
  it("parseIndex tolerates short rows (awk $2/$3 empty) and blank lines", () => {
    expect(parseIndex("w\n\nw2\tm\n")).toEqual([
      { word: "w", mid: "", summary: "" },
      { word: "w2", mid: "m", summary: "" },
    ]);
  });
});

describe("seen ring — `tail -n (RETRIEVAL_SEEN-1)` + mid", () => {
  it("keeps the last N-1 then appends; N=1 keeps only the new id; N=0 → tail -n -1 keeps one", () => {
    const many = Array.from({ length: 25 }, (_, i) => `m${i}`);
    expect(nextSeen(many, "new", 20)).toEqual([...many.slice(-19), "new"]);
    expect(nextSeen(["a", "b"], "c", 20)).toEqual(["a", "b", "c"]);
    expect(nextSeen(["a", "b"], "c", 1)).toEqual(["c"]);
    expect(nextSeen(["a", "b"], "c", 2)).toEqual(["b", "c"]);
    expect(nextSeen(["a", "b", "c"], "d", 0)).toEqual(["c", "d"]);
    expect(nextSeen([], "x", 20)).toEqual(["x"]);
  });
  it("readSeen: absent → []; trailing newline does not add an empty id", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-seen-"));
    try {
      expect(readSeen(path.join(d, "nope"))).toEqual([]);
      fs.writeFileSync(path.join(d, "seen"), "a\nb\n");
      expect(readSeen(path.join(d, "seen"))).toEqual(["a", "b"]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 2. The Bash oracle: tests/test_retrieval_thinker.sh, all 8 scenarios verbatim
// ===========================================================================

describe("tests/test_retrieval_thinker.sh — the 8 scenarios, same fixtures, same expectations", () => {
  it("ships disabled + step is executable: default topology has no retrieval thinker; the shim is executable", () => {
    // `bundled thinker has disabled marker` ⇢ retrieval is opt-in (off unless cfg.retrieval)
    expect(RETRIEVAL_SUBSCRIPTION).toEqual({ types: ["thought", "message", "observation"], triggerSelf: false, watchdogSecs: 0 });
    // `step is executable`
    expect(() => fs.accessSync(path.join(BIN_DIR, "retrieval-step.mjs"), fs.constants.X_OK)).not.toThrow();
  });

  it("runs the whole sequence: no resonance, resonance, repeat, one word, own source, second memory, rebuild, no memories", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);

      // --- no resonance: nothing appended ---
      expect(run(ident, step("thought", 1, "Thinking about the weather and lunch plans today.")).code).toBe(0);
      expect(obsCount(ident)).toBe(0); // unrelated thought: no observation
      expect(fs.statSync(indexPath(ident)).size).toBeGreaterThan(0); // index was built
      expect(fs.readFileSync(indexPath(ident), "utf8")).toContain("colima\taaaa1111\tdocker on this mac is colima"); // rows have word/id/summary

      // --- resonance: the colima memory surfaces ---
      expect(run(ident, step("thought", 2, "Why does the docker bind mount of this path silently fail on colima?")).code).toBe(0);
      expect(obsCount(ident)).toBe(1); // matching thought: one observation
      let last = lastObs(ident);
      expect(last["retrieved_mem"]).toBe("aaaa1111"); // observation names the memory id
      expect(String(last["content"])).toMatch(/reminded of memory aaaa1111/);
      expect(last["trigger_step"]).toBe("s-2");
      const tail = JSON.parse(lines(ident.traj).at(-1)!) as Record<string, unknown>;
      expect(tail["step_id"]).toBeTruthy(); // observation is a real traj step
      expect(tail["type"]).toBe("observation");

      // --- recently surfaced memory is not repeated ---
      run(ident, step("thought", 3, "Still fighting colima docker mounts that fail silently."));
      expect(obsCount(ident)).toBe(1); // same memory not resurfaced

      // --- a single shared word is not enough (RETRIEVAL_MIN_HITS default 2) ---
      run(ident, step("thought", 4, "I should read the output carefully."));
      expect(obsCount(ident)).toBe(1); // one shared word: no observation

      // --- its own observations never trigger it ---
      run(ident, step("observation", 5, "I'm reminded of memory bbbb2222: short git output vanishes in the pager", { source: "retrieval" }));
      expect(obsCount(ident)).toBe(1); // own observation ignored

      // --- a different memory surfaces, and the index rebuilds for new memories ---
      run(ident, step("message", 6, "my git log output vanishes as soon as the pager exits"));
      expect(lastObs(ident)["retrieved_mem"]).toBe("bbbb2222"); // second memory surfaces
      const snap = memFile(
        ident,
        "20260803_cccc_snap",
        "cccc3333",
        "snap aws cli redirect writes empty files",
        "On the box the snap aws cli writes zero bytes when stdout is redirected to a file; pipe through cat."
      );
      bumpMtime(snap); // sleep 1: the new memory must be newer than the index
      run(ident, step("thought", 7, "the snap aws cli wrote an empty file again after the redirect"));
      expect(lastObs(ident)["retrieved_mem"]).toBe("cccc3333"); // index rebuilt: new memory surfaces
      expect(obsCount(ident)).toBe(3); // three observations total

      // --- build-index.sh standalone ---
      const idx = path.join(ident.work, "idx.tsv");
      const rows = buildIndex(ident.memDir, idx, readMemoryFiles);
      const idxText = fs.readFileSync(idx, "utf8");
      expect(rows).toBe(countRows(idxText)); // build-index prints row count
      expect(idxText.split("\n").map((l) => l.split("\t")[0])).not.toContain("the"); // build-index skips stopwords

      // --- no memories: quiet no-op ---
      for (const f of fs.readdirSync(ident.memDir)) if (f.endsWith(".md")) fs.rmSync(path.join(ident.memDir, f));
      const r = run(ident, step("thought", 8, "colima docker mount"));
      expect(r.code).toBe(0);
      expect(obsCount(ident)).toBe(3); // no memories: exits 0, no append
      expect(ident.stderr).toEqual([]);

      // the seen ring recorded the three surfacings, oldest first
      expect(fs.readFileSync(seenPath(ident), "utf8")).toBe("aaaa1111\nbbbb2222\ncccc3333\n");
    } finally {
      ident.cleanup();
    }
  });
});

// ===========================================================================
// 3. No-op matrix, die paths, knobs, replicated quirks
// ===========================================================================

describe("no-op matrix — every path exits 0 silently with no append and no seen write", () => {
  const cases: [string, string | Record<string, unknown>][] = [
    ["empty stdin", ""],
    ["newline-only stdin", "\n\n"],
    ["whitespace stdin (jq fails)", "   "],
    ["invalid JSON", "{not json"],
    ["JSON null", "null"],
    ["JSON number", "42"],
    ["JSON array", '[{"content":"colima docker"}]'],
    ["no content field", '{"type":"thought","step_id":"s-1"}'],
    ["content null", '{"type":"thought","content":null}'],
    ["content false", '{"type":"thought","content":false}'],
    ["content empty string", '{"type":"thought","content":""}'],
    ["content only newlines", '{"type":"thought","content":"\\n\\n"}'],
    ["own source", '{"type":"observation","content":"colima docker mount","source":"retrieval"}'],
    ["all stopwords / short words", '{"type":"thought","content":"the and you of it"}'],
    ["one shared word", step("thought", 1, "docker is neat")],
    ["upstream boot manual-trigger (no content)", '{"type":"manual-trigger","source":"thinkers-cli","ts":"2026-08-28T16:00:00Z"}'],
    ["RETRIEVAL_MIN_HITS non-integer → arithmetic error → test false", { type: "thought", content: "colima docker mount", step_id: "s-9" }],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      const ident = makeIdent();
      try {
        seedColimaAndPager(ident);
        const extra: RetrievalEnv = name.startsWith("RETRIEVAL_MIN_HITS") ? { RETRIEVAL_MIN_HITS: "1.5" } : {};
        const r = run(ident, input, extra);
        expect(r.code).toBe(0);
        expect(r.observation).toBeUndefined();
        expect(obsCount(ident)).toBe(0);
        expect(fs.existsSync(seenPath(ident))).toBe(false);
        expect(ident.stderr).toEqual([]);
      } finally {
        ident.cleanup();
      }
    });
  }

  it("no memories: MEM_DIR is created by _require_env's mkdir -p, then exit 0", () => {
    const ident = makeIdent();
    try {
      fs.rmSync(ident.memDir, { recursive: true });
      const r = run(ident, step("thought", 1, "colima docker mount"));
      expect(r.code).toBe(0);
      expect(r.reason).toBe("no memories");
      expect(fs.statSync(ident.memDir).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(ident.id, "skills")).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(ident.id, "kernel")).isDirectory()).toBe(true);
      expect(fs.existsSync(indexPath(ident))).toBe(false);
    } finally {
      ident.cleanup();
    }
  });

  it("recently surfaced (seen contains the id) → exit 0, seen untouched", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      fs.mkdirSync(path.join(ident.id, "retrieval"), { recursive: true });
      fs.writeFileSync(seenPath(ident), "zzzz9999\naaaa1111\n");
      const r = run(ident, step("thought", 1, "colima docker mount"));
      expect(r.code).toBe(0);
      expect(r.reason).toBe("recently surfaced");
      expect(obsCount(ident)).toBe(0);
      expect(fs.readFileSync(seenPath(ident), "utf8")).toBe("zzzz9999\naaaa1111\n");
    } finally {
      ident.cleanup();
    }
  });

  it("index rebuild failure (RETRIEVAL_INDEX under a regular file) → exit 0, nothing written", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const blocker = path.join(ident.work, "blocker");
      fs.writeFileSync(blocker, "x");
      const r = run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_INDEX: `${blocker}/index.tsv` });
      expect(r.code).toBe(0);
      expect(r.reason).toBe("index rebuild failed");
      expect(obsCount(ident)).toBe(0);
      expect(ident.stderr).toEqual([]);
    } finally {
      ident.cleanup();
    }
  });
});

describe("die paths — _require_env (exit 1 + the exact message), and the after-seen failures", () => {
  for (const k of ["IDENTITY_DIR", "TRAJ_DIR", "TRAJ_ID", "MEM_DIR"]) {
    it(`${k} unset → exit 1, 'thinker: error: ${k} not set. Run: identity shell <name>'`, () => {
      const ident = makeIdent();
      try {
        seedColimaAndPager(ident);
        const r = run(ident, step("thought", 1, "colima docker mount"), { [k]: undefined });
        expect(r.code).toBe(1);
        expect(ident.stderr).toEqual([`thinker: error: ${k} not set. Run: identity shell <name>\n`]);
        expect(obsCount(ident)).toBe(0);
        expect(fs.existsSync(indexPath(ident))).toBe(false);
      } finally {
        ident.cleanup();
      }
    });
  }
  it("empty-string env counts as unset (Bash [[ -n ]])", () => {
    const ident = makeIdent();
    try {
      const r = run(ident, step("thought", 1, "x"), { MEM_DIR: "" });
      expect(r.code).toBe(1);
      expect(ident.stderr[0]).toContain("MEM_DIR not set");
    } finally {
      ident.cleanup();
    }
  });
  it("seen is written BEFORE the append: a failing `traj append` still leaves the id in seen (exit 1)", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const io: RetrievalIO = {
        ...ident.io,
        appendStep: () => {
          throw new Error("traj: error: append: cannot resolve traj_id 'x' in 'y'");
        },
      };
      const r = runRetrievalStep(step("thought", 1, "colima docker mount"), ident.env, io);
      expect(r.code).toBe(1);
      expect(r.reason).toBe("traj append failed");
      expect(fs.readFileSync(seenPath(ident), "utf8")).toBe("aaaa1111\n");
      expect(ident.stderr).toEqual(["traj: error: append: cannot resolve traj_id 'x' in 'y'\n"]);
      expect(obsCount(ident)).toBe(0);
    } finally {
      ident.cleanup();
    }
  });
  it("RETRIEVAL_SEEN non-integer → arithmetic error after the seen check → exit 1, no append", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const r = run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_SEEN: "1.5" });
      expect(r.code).toBe(1);
      expect(ident.stderr[0]).toContain("RETRIEVAL_SEEN");
      expect(obsCount(ident)).toBe(0);
      expect(fs.existsSync(seenPath(ident))).toBe(false);
    } finally {
      ident.cleanup();
    }
  });

  // bug #45: a BAREWORD RETRIEVAL_MIN_HITS ("abc") is a DIFFERENT bash
  // failure than the non-identifier "1.5" case above. `${RETRIEVAL_MIN_HITS
  // :-2}` only substitutes the default when the var is unset/empty; a SET
  // bareword reaches `[[ ... -ge "abc" ]]`'s arithmetic operand as-is,
  // where bash looks it up as a VARIABLE NAME — an uncaught "unbound
  // variable" error (unlike "1.5"'s syntax error, which `[[ ]]` catches
  // and treats as a false test) that kills the script before any seen/traj
  // write. Captured directly against upstream
  // (parity/fuzz/findings/retrieval-1.md): a sandbox built the same way as
  // parity/retrieval/run-parity.mjs's `baseEnv`/`makeSandbox`, one memory
  // matching the trigger's words, RETRIEVAL_MIN_HITS=abc, RETRIEVAL_SEEN=1
  // ->
  //   status: 1
  //   stderr: "<bash-step-path>: line 60: abc: unbound variable\n"
  //   stdout: ""
  //   trajectory: unchanged (no observation appended)
  //   seen file: does not exist (never written)
  // Exit code (1) and state (no writes) must match exactly; the stderr
  // TEXT embeds bash's own script path + internal line number, which is
  // the same "isBashLineWordingDeviation" wording-only allowance already
  // reused for every tool that shells this idiom — not a fresh allowance.
  it("RETRIEVAL_MIN_HITS as a bareword → unbound-variable crash → exit 1, no writes at all", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const r = run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_MIN_HITS: "abc" });
      expect(r.code).toBe(1);
      expect(ident.stderr[0]).toContain("RETRIEVAL_MIN_HITS");
      expect(obsCount(ident)).toBe(0);
      expect(fs.existsSync(seenPath(ident))).toBe(false);
    } finally {
      ident.cleanup();
    }
  });

  // bug #58: the bareword crash above only fires because a candidate
  // memory MATCHED (best.mid non-empty) — bash's test is a single `[[ -n
  // "${mid:-}" && "${hits:-0}" -ge "${RETRIEVAL_MIN_HITS:-2}" ]]`, and `&&`
  // inside `[[ ]]` short-circuits: when NO candidate matched (mid empty),
  // the RETRIEVAL_MIN_HITS side is never evaluated at all, so a bareword
  // value can never crash that run — bash falls through to `|| exit 0`
  // cleanly. Captured directly against upstream
  // (parity/fuzz/findings/retrieval-c2-1.md / retrieval-5.md): a trigger
  // sharing no words with any seeded memory, RETRIEVAL_MIN_HITS=abc ->
  // bash exit 0, empty stderr. The port used to validate the bareword
  // UNCONDITIONALLY, before ever checking whether a candidate existed, so
  // it crashed even in this no-candidate case bash's own short-circuit was
  // written to skip.
  it("RETRIEVAL_MIN_HITS as a bareword is never evaluated when no candidate memory matched → exit 0, no crash", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const r = run(ident, step("manual", 1, "  has  spaces  "), { RETRIEVAL_MIN_HITS: "abc" });
      expect(r.code).toBe(0);
      expect(ident.stderr).toEqual([]);
      expect(obsCount(ident)).toBe(0);
    } finally {
      ident.cleanup();
    }
  });
});

describe("the appended observation — verbatim content, fields, key order, run_id auto-link", () => {
  it("content is exactly `I'm reminded of memory <mid>: <summary> (<hits> shared words; mem show <mid> for the full note)`", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const r = run(ident, step("thought", 2, "Why does the docker bind mount of this path silently fail on colima?"));
      expect(r.observation).toBeDefined();
      // DISTINCT shared words: bind, colima, docker (summary line), fail, mount, silently — not path/why
      expect(r.observation!.hits).toBe(6);
      expect(r.observation!.content).toBe(
        "I'm reminded of memory aaaa1111: docker on this mac is colima (6 shared words; mem show aaaa1111 for the full note)"
      );
      const rec = lastObs(ident);
      expect(Object.keys(rec)).toEqual(["type", "content", "source", "retrieved_mem", "trigger_step", "step_id", "ts"]);
      expect(rec["source"]).toBe(THINKER_NAME);
      expect(rec["step_id"]).toBe(r.observation!.stepId);
      expect(rec["run_id"]).toBeUndefined();
    } finally {
      ident.cleanup();
    }
  });
  it("trigger_step is omitted when the trigger has no step_id; non-string fields print like `jq -r`", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      run(ident, { type: "thought", content: "colima docker mount" });
      expect(Object.keys(lastObs(ident))).toEqual(["type", "content", "source", "retrieved_mem", "step_id", "ts"]);
      // numeric step_id prints as its text; object content is jq's pretty JSON (tokens identical)
      run(ident, { type: "message", content: { note: "git output vanishes in the pager" }, step_id: 7 });
      const rec = lastObs(ident);
      expect(rec["retrieved_mem"]).toBe("bbbb2222");
      expect(rec["trigger_step"]).toBe("7");
    } finally {
      ident.cleanup();
    }
  });
  it("run_id is stamped iff SHELLM_RUN_STEP_ID is set (empty string = unset), before step_id/ts", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      run(ident, step("thought", 1, "colima docker mount"), { SHELLM_RUN_STEP_ID: "run-0966d708" });
      const rec = lastObs(ident);
      expect(rec["run_id"]).toBe("run-0966d708");
      expect(Object.keys(rec)).toEqual(["type", "content", "source", "retrieved_mem", "trigger_step", "run_id", "step_id", "ts"]);
      run(ident, step("message", 2, "git output vanishes in the pager"), { SHELLM_RUN_STEP_ID: "" });
      expect(lastObs(ident)["run_id"]).toBeUndefined();
    } finally {
      ident.cleanup();
    }
  });
});

describe("knobs — RETRIEVAL_MIN_HITS, RETRIEVAL_SEEN, RETRIEVAL_INDEX, RETRIEVAL_SEMANTIC", () => {
  it("RETRIEVAL_MIN_HITS=1 lets a single shared word surface a memory", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      run(ident, step("thought", 1, "docker is neat"), { RETRIEVAL_MIN_HITS: "1" });
      expect(obsCount(ident)).toBe(1);
      expect(lastObs(ident)["retrieved_mem"]).toBe("aaaa1111"); // only the colima memory says "docker"
      expect(String(lastObs(ident)["content"])).toContain("(1 shared words;");
    } finally {
      ident.cleanup();
    }
  });
  it("RETRIEVAL_SEEN=1: the ring holds only the last surfacing, so a memory can return after another one", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const env: RetrievalEnv = { RETRIEVAL_SEEN: "1" };
      run(ident, step("thought", 1, "colima docker mount"), env);
      run(ident, step("thought", 2, "git output vanishes in the pager"), env);
      run(ident, step("thought", 3, "colima docker mount"), env);
      expect(lines(ident.traj).filter((l) => l.includes('"source":"retrieval"')).map((l) => (JSON.parse(l) as { retrieved_mem: string }).retrieved_mem)).toEqual([
        "aaaa1111",
        "bbbb2222",
        "aaaa1111",
      ]);
      expect(fs.readFileSync(seenPath(ident), "utf8")).toBe("aaaa1111\n");
    } finally {
      ident.cleanup();
    }
  });
  it("RETRIEVAL_INDEX relocates index.tsv AND the seen file beside it", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      const alt = path.join(ident.work, "alt", "deep", "words.tsv");
      run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_INDEX: alt });
      expect(fs.statSync(alt).size).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(ident.work, "alt", "deep", "seen"), "utf8")).toBe("aaaa1111\n");
      expect(fs.existsSync(indexPath(ident))).toBe(false);
    } finally {
      ident.cleanup();
    }
  });
  it("RETRIEVAL_SEMANTIC=1 appends ` | mem search: ` + first 3 lines (newlines → spaces), cut at 300 chars", () => {
    const calls: string[] = [];
    let reply = "line one\nline two\nline three\nline four\n";
    const ident = makeIdent({
      memSearch: (q) => {
        calls.push(q);
        return reply;
      },
    });
    try {
      seedColimaAndPager(ident);
      const env: RetrievalEnv = { RETRIEVAL_SEMANTIC: "1", RETRIEVAL_SEEN: "1" };
      let r = run(ident, step("thought", 1, "colima docker mount"), env);
      expect(calls).toEqual(["colima docker mount"]);
      expect(r.observation!.content).toBe(
        "I'm reminded of memory aaaa1111: docker on this mac is colima (3 shared words; mem show aaaa1111 for the full note) | mem search: line one line two line three "
      );
      // 300-char cap (`${sem:0:300}`)
      reply = "x".repeat(350);
      r = run(ident, step("thought", 2, "git output vanishes in the pager"), env);
      expect(r.observation!.content.endsWith(" | mem search: " + "x".repeat(300))).toBe(true);
      // `mem search` failing / empty → no suffix at all
      reply = "";
      r = run(ident, step("thought", 3, "colima docker mount"), env);
      expect(r.observation!.content.endsWith("for the full note)")).toBe(true);
    } finally {
      ident.cleanup();
    }
  });
  it("semantic mode is gated on exactly `1`; without the seam the suffix is silently absent (no GNU timeout)", () => {
    for (const v of [undefined, "0", "", "true", "yes"]) {
      const calls: string[] = [];
      const ident = makeIdent({ memSearch: (q) => (calls.push(q), "hit\n") });
      try {
        seedColimaAndPager(ident);
        const r = run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_SEMANTIC: v });
        expect(calls).toEqual([]);
        expect(r.observation!.content.endsWith("for the full note)")).toBe(true);
      } finally {
        ident.cleanup();
      }
    }
    const ident = makeIdent(); // no memSearch seam at all
    try {
      seedColimaAndPager(ident);
      const r = run(ident, step("thought", 1, "colima docker mount"), { RETRIEVAL_SEMANTIC: "1" });
      expect(r.observation!.content.endsWith("for the full note)")).toBe(true);
    } finally {
      ident.cleanup();
    }
  });
});

describe("replicated quirks", () => {
  it("stale-index-after-forget: deleting a memory does not rebuild, so its stale rows still surface", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      run(ident, step("thought", 1, "unrelated words entirely")); // builds the index over both memories
      expect(fs.readFileSync(indexPath(ident), "utf8")).toContain("\tbbbb2222\t");
      fs.rmSync(path.join(ident.memDir, "20260802_bbbb_pager.md")); // `mem forget bbbb2222`
      const r = run(ident, step("thought", 2, "git output vanishes in the pager"));
      expect(r.observation!.mid).toBe("bbbb2222"); // the deleted memory, from the stale index (REPLICATED)
      expect(fs.readFileSync(indexPath(ident), "utf8")).toContain("\tbbbb2222\t");
    } finally {
      ident.cleanup();
    }
  });
  it("only a NEWER memory (mtime > index mtime) triggers a rebuild; an empty index always does", () => {
    const ident = makeIdent();
    try {
      seedColimaAndPager(ident);
      run(ident, step("thought", 1, "zzz yyy"));
      const built = fs.statSync(indexPath(ident)).mtimeMs;
      // an older memory added later (mtime in the past) does not rebuild
      const old = memFile(ident, "20260803_dddd_old", "dddd4444", "ancient", "ancient words here");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(old, past, past);
      run(ident, step("thought", 2, "ancient words"));
      expect(fs.statSync(indexPath(ident)).mtimeMs).toBe(built);
      expect(obsCount(ident)).toBe(0);
      // an empty index rebuilds regardless
      fs.writeFileSync(indexPath(ident), "");
      run(ident, step("thought", 3, "ancient words"));
      expect(fs.statSync(indexPath(ident)).size).toBeGreaterThan(0);
      expect(lastObs(ident)["retrieved_mem"]).toBe("dddd4444");
    } finally {
      ident.cleanup();
    }
  });
});

// ===========================================================================
// 4. Golden replay + topology with the third thinker
// ===========================================================================

describe("golden/trace-05-retrieval — replay of the captured pax retrieval wakes", () => {
  const rows = fs
    .readFileSync(path.join(GOLDEN, "trajectory-rows-676-856.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const byId = new Map(rows.map((r) => [String(r["step_id"]), r]));
  const retrievals = rows.filter((r) => r["source"] === "retrieval");

  it("the capture has 181 rows, 5 retrieval observations, 4 reactive monolith wakes keyed to them", () => {
    expect(rows.length).toBe(181);
    expect(retrievals.length).toBe(5);
    const wakes = rows.filter((r) => r["wake"] === "reactive/observation:retrieval");
    expect(wakes.length).toBe(4);
    for (const w of wakes) {
      const obs = byId.get(String(w["trigger_step"]));
      expect(obs?.["source"]).toBe("retrieval");
    }
    // row 676 is the probe artifact: run_id stamped, synthetic trigger_step (NOTES.md)
    expect(retrievals[0]!["run_id"]).toBeTruthy();
    expect(String(retrievals[0]!["trigger_step"]).startsWith("probe-")).toBe(true);
    for (const r of retrievals.slice(1)) expect(r["run_id"]).toBeUndefined();
  });

  it("replaying the 4 in-range triggers over the memories that existed reproduces the observations (minus step_id/ts) and the seen file", () => {
    const ident = makeIdent();
    try {
      const memNames = fs.readdirSync(path.join(GOLDEN, "memories")).filter((f) => f.endsWith(".md")).sort();
      // the probe (row 676) had already surfaced 9096b22d
      fs.mkdirSync(path.join(ident.id, "retrieval"), { recursive: true });
      fs.writeFileSync(seenPath(ident), "9096b22d\n");
      const produced: Record<string, unknown>[] = [];
      for (const golden of retrievals.slice(1)) {
        const trigger = byId.get(String(golden["trigger_step"]))!;
        expect(trigger).toBeDefined();
        // the corpus at that moment: memories stamped (UTC) at or before the trigger's ts
        const cutoff = String(trigger["ts"]).replace(/[-:T]/g, "").slice(0, 14);
        for (const n of memNames) {
          const stamp = n.slice(0, 19).replace(/-/g, "");
          const dst = path.join(ident.memDir, n);
          if (stamp <= cutoff && !fs.existsSync(dst)) {
            fs.copyFileSync(path.join(GOLDEN, "memories", n), dst);
            bumpMtime(dst); // newer than the previous index → rebuild, as it did live
          }
        }
        const r = run(ident, trigger);
        expect(r.observation).toBeDefined();
        produced.push(lastObs(ident));
      }
      const strip = (o: Record<string, unknown>) => {
        const { step_id: _s, ts: _t, ...rest } = o;
        return rest;
      };
      const golden = retrievals.slice(1);
      // rows 716 / 772 / 810: byte-identical modulo step_id/ts
      expect(produced.slice(0, 3).map(strip)).toEqual(golden.slice(0, 3).map(strip));
      // row 856 (d4eaba71): the memory was `mem edit`ed at 16:42, AFTER this
      // observation — the shipped corpus carries the edited summary/body, so the
      // captured summary text and hit count (20) are unreproducible from it
      // (NOTES.md). Everything but the content string matches; the content is
      // the edited memory's summary with the edited text's hit count.
      const last = produced[3]!;
      const { content: _pc, ...pRest } = strip(last);
      const { content: gc, ...gRest } = strip(golden[3]!);
      expect(pRest).toEqual(gRest);
      expect(String(gc)).toMatch(/^I'm reminded of memory d4eaba71: .* \(20 shared words; mem show d4eaba71 for the full note\)$/);
      const editedSummary = fs
        .readFileSync(path.join(GOLDEN, "index.tsv"), "utf8")
        .split("\n")
        .find((l) => l.includes("\td4eaba71\t"))!
        .split("\t")[2];
      expect(String(last["content"])).toBe(
        `I'm reminded of memory d4eaba71: ${editedSummary} (13 shared words; mem show d4eaba71 for the full note)`
      );
      expect(fs.readFileSync(seenPath(ident), "utf8")).toBe(fs.readFileSync(path.join(GOLDEN, "seen"), "utf8"));
      expect(fs.readFileSync(indexPath(ident)).equals(fs.readFileSync(path.join(GOLDEN, "index.tsv")))).toBe(true);
    } finally {
      ident.cleanup();
    }
  });
});

// ---- topology harness (as in topology.test.ts) ------------------------------

const typeOf = (s: Step) => String((s as { type?: string }).type ?? "");
const srcOf = (s: Step) => String((s as { source?: string }).source ?? "");

function makeTopology(withRetrieval: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-topo3-"));
  const identityDir = path.join(root, "identity");
  const trajDir = path.join(root, "trajectories");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "run");
  const memDir = path.join(identityDir, "memories");
  for (const d of [workdir, stateDir, memDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, "2026-08-01-10-00-00_aaaa1111_docker-on-this-mac-is-colima.md"),
    "---\nid: aaaa1111\nsummary: docker on this mac is colima\ntype: fact\ncreated: 2026-08-01 10:00:00\n---\n\n" +
      "Bind mounts silently fail for paths colima does not mount. Only home and tmp are mounted.\n"
  );
  const identity: IdentityConfig = {
    name: "pax",
    identityText: "I am pax, a persistent virtual person for the parity test.",
    skillsText: "## My skills system\n(no skills installed)",
    goals: "(no goals set)",
    trajDir,
    workdir,
    binDir: BIN_DIR,
    stateDir,
    model: "deepseek/deepseek-v4-flash-0731",
    env: { name: "pax", type: "docker", docker_image: "ubuntu:latest", docker_access: "none" },
  };
  const traj = createTrajectory(trajDir);
  traj.append({ type: "thought", content: "I'm here.", source: "seed" });
  const stderr: string[] = [];
  // Monolith: the real DeepSeek quiet-idle reply recorded as monolith/quiet-idle (test/support/README.md), served to
  // every wake (`cycle`). Responder: an HTTP fixture with no replies (not model output); it is never consulted.
  const monolithLlm = recordedModel("monolith", "quiet-idle", { cycle: true });
  const system = createTwoThinkerSystem({
    trajectory: traj,
    identity,
    monolithLlm,
    responderLlm: httpModel([]),
    sandbox: new LocalSandbox(),
    now: () => 1_756_000_000_000,
    monolithConstants: { maxIterations: 4 },
    ...(withRetrieval ? { retrieval: { identityDir, memDir, stderr: (s: string) => stderr.push(s) } } : {}),
  });
  return { system, identityDir, stderr, steps: () => system.trajectory.read(), cleanup: () => { monolithLlm.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe("topology — the THIRD thinker (opt-in; upstream ships it disabled)", () => {
  it("default config: no retrieval thinker is registered — a resonant thought dispatches nothing", async () => {
    const t = makeTopology(false);
    try {
      t.system.trajectory.append({ type: "thought", content: "Why does the docker bind mount silently fail on colima?", source: "seed" });
      await t.system.settle();
      expect(t.system.log.some((e) => e.name === "retrieval")).toBe(false);
      expect(t.steps().some((s) => srcOf(s) === "retrieval")).toBe(false);
      expect(fs.existsSync(path.join(t.identityDir, "retrieval"))).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it("enabled: thought → retrieval observation → reactive monolith wake `reactive/observation:retrieval` → self-skip", async () => {
    const t = makeTopology(true);
    try {
      const thoughtId = t.system.trajectory.append({
        type: "thought",
        content: "Why does the docker bind mount of this path silently fail on colima?",
        source: "seed",
      });
      await t.system.settle();
      const all = t.steps();

      // retrieval appended its observation onto the ONE stream, keyed to the thought
      const obs = all.find((s) => typeOf(s) === "observation" && srcOf(s) === "retrieval") as Record<string, unknown> | undefined;
      expect(obs).toBeDefined();
      expect(obs!["retrieved_mem"]).toBe("aaaa1111");
      expect(obs!["trigger_step"]).toBe(thoughtId);
      expect(String(obs!["content"])).toMatch(/^I'm reminded of memory aaaa1111: docker on this mac is colima \(6 shared words; mem show aaaa1111 for the full note\)$/);

      // the monolith woke REACTIVELY on it, with the observation as trigger_step
      const wakes = all.filter((s) => typeOf(s) === "shellm-run") as Record<string, unknown>[];
      expect(wakes.length).toBe(1);
      expect(wakes[0]!["wake"]).toBe("reactive/observation:retrieval");
      expect(wakes[0]!["trigger_step"]).toBe(obs!["step_id"]);
      expect(wakes[0]!["launched_by"]).toBe("monolith");
      expect(all.findIndex((s) => s === obs)).toBeLessThan(all.findIndex((s) => typeOf(s) === "shellm-run"));

      // dispatcher log: retrieval was dispatched on the thought; its own observation was self-skipped
      expect(t.system.log.some((e) => e.kind === "dispatch" && e.name === "retrieval" && e.type === "thought")).toBe(true);
      expect(t.system.log.some((e) => e.kind === "skip-self" && e.name === "retrieval" && e.type === "observation")).toBe(true);
      expect(t.system.log.some((e) => e.kind === "dispatch" && e.name === "monolith" && e.source === "retrieval")).toBe(true);
      // the responder never fired (no message on the stream)
      expect(t.system.log.some((e) => e.name === "responder")).toBe(false);
      expect(all.some((s) => typeOf(s) === "reply_claim")).toBe(false);

      // state on disk, under <identity>/retrieval/
      expect(fs.readFileSync(path.join(t.identityDir, "retrieval", "seen"), "utf8")).toBe("aaaa1111\n");
      expect(fs.readFileSync(path.join(t.identityDir, "retrieval", "index.tsv"), "utf8")).toContain("colima\taaaa1111\t");
      expect(t.stderr).toEqual([]);

      // the same resonance again is damped by the seen ring: no second observation, no second wake
      t.system.trajectory.append({ type: "thought", content: "still the docker bind mount on colima", source: "seed" });
      await t.system.settle();
      const again = t.steps();
      expect(again.filter((s) => srcOf(s) === "retrieval").length).toBe(1);
      expect(again.filter((s) => typeOf(s) === "shellm-run").length).toBe(1);
    } finally {
      t.cleanup();
    }
  }, 30_000);
});
