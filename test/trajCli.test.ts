// trajCli.test.ts — unit tests for the full `traj` CLI port (src/trajCli.ts).
//
// Pins every subcommand's contract deterministically over a real on-disk
// fixture tree (matches golden/'s directory-based trajectory shape), plus a
// guard that append/last — the PROVEN write path this port must not change
// — keep producing byte-identical output/on-disk effects. The port is byte-
// compared against the real Bash tool by the separate differential harness
// (parity/traj); this file pins behaviour so regressions are caught without
// the Bash oracle.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runTraj,
  parseHexId,
  getSummary,
  toEpoch,
  wcL,
  sanitizeSlug,
  grepContent,
  matchesFilters,
  parseFilterFlags,
  type TrajIO,
} from "../src/trajCli.js";
import { appendStep, readSteps, rootTrajFile } from "../src/trajCore.mjs";

// --- deterministic IO harness -------------------------------------------------

interface Harness {
  io: TrajIO;
  out(): string;
  err(): string;
  outLines(): string[];
}

function makeIO(opts: {
  env?: Record<string, string | undefined>;
  stdin?: string;
  isTTY?: boolean;
}): Harness {
  let out = "";
  let err = "";
  const io: TrajIO = {
    env: opts.env ?? {},
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdin: () => opts.stdin ?? "",
    isTTY: opts.isTTY ?? false,
    sleepMs: () => {},
    shouldStop: () => true, // never actually loops in tests
  };
  return {
    io,
    out: () => out,
    err: () => err,
    outLines: () => out.split("\n").filter((l) => l !== ""),
  };
}

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "trajcli-test-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Resolve a trajectory id to its file path via the CLI's own `path`
 *  subcommand — `new`'s directory name is `<hex8>-<slug>` (NOT the engine's
 *  `<hex8>-root` convention rootTrajFile assumes), so tests that create
 *  trajectories via `new`/`fork` with an arbitrary slug must resolve through
 *  `path`, not rootTrajFile. */
function pathOf(trajDir: string, id: string): string {
  const { io, out } = makeIO({});
  runTraj(["path", "--traj_dir", trajDir, id], io);
  return out().trim();
}

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

/** Seed a root trajectory the way trajCore/the engine does: <trajDir>/<hex8>-root/trajectory.jsonl */
function seedRoot(trajDir: string, id: string, extraFields: Record<string, unknown> = {}): string {
  const file = rootTrajFile(trajDir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "trajectory", step_id: id, ts: "2026-01-01T00:00:00.000Z", ...extraFields }) + "\n");
  return file;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("parseHexId", () => {
  it("extracts hex8 from a trajectory.jsonl's parent dir name", () => {
    expect(parseHexId("/x/abcd1234-root/trajectory.jsonl")).toBe("abcd1234");
  });
  it("extracts hex8 from a flat .jsonl filename", () => {
    expect(parseHexId("/x/abcd1234-slug.jsonl")).toBe("abcd1234");
  });
  it("falls back to the basename when no hex prefix", () => {
    expect(parseHexId("/x/legacy-name.jsonl")).toBe("legacy-name");
  });
});

describe("sanitizeSlug", () => {
  it("lowercases, collapses non-safe chars, strips leading/trailing dashes", () => {
    expect(sanitizeSlug("Hello World!!")).toBe("hello-world");
  });
  it("empty/only-unsafe input falls back to 'unnamed'", () => {
    expect(sanitizeSlug("!!!")).toBe("unnamed");
    expect(sanitizeSlug("")).toBe("unnamed");
  });
  it("truncates to 60 bytes", () => {
    expect(sanitizeSlug("a".repeat(100)).length).toBe(60);
  });
});

describe("toEpoch", () => {
  it("sorts plain UTC 'Z' timestamps chronologically", () => {
    const a = toEpoch("2026-01-01T00:00:00.000Z");
    const b = toEpoch("2026-01-01T00:00:01.000Z");
    expect(b).toBeGreaterThan(a);
  });
  it("applies a +offset by subtracting it (matches jq to_epoch)", () => {
    const utc = toEpoch("2026-01-01T12:00:00Z");
    const plus2 = toEpoch("2026-01-01T14:00:00+02:00");
    expect(plus2).toBe(utc);
  });
  it("applies a -offset by adding it", () => {
    const utc = toEpoch("2026-01-01T12:00:00Z");
    const minus5 = toEpoch("2026-01-01T07:00:00-05:00");
    expect(minus5).toBe(utc);
  });

  // PORT-NOTE (1c: e4ca135): the sort key is INTEGER MILLISECONDS, not whole
  // seconds — a trajectory writes many steps per second, so a whole-second
  // key ties for most of them and the -r views need sub-second ordering.
  describe("millisecond precision (1c: e4ca135)", () => {
    it("returns a value 1000x a plain-seconds epoch (milliseconds, not seconds)", () => {
      expect(toEpoch("2026-01-01T00:00:00.000Z")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    });
    it("orders two steps in the SAME second by their millisecond fraction", () => {
      const a = toEpoch("2026-09-04T14:13:18.100Z");
      const b = toEpoch("2026-09-04T14:13:18.502Z");
      expect(b - a).toBe(402);
    });
    it("keeps only the first 3 fractional digits, truncated not rounded (jq's [0:3] slice)", () => {
      // ".123456" -> "123" -> 123ms, not 124ms.
      expect(toEpoch("2026-01-01T00:00:00.123456Z")).toBe(toEpoch("2026-01-01T00:00:00.123Z"));
    });
    it("a fraction with fewer than 3 digits is right-padded with zeros (.5 -> 500ms)", () => {
      expect(toEpoch("2026-01-01T00:00:00.5Z")).toBe(toEpoch("2026-01-01T00:00:00.500Z"));
    });
    it("no fractional part at all -> 0ms", () => {
      expect(toEpoch("2026-01-01T00:00:00Z")).toBe(toEpoch("2026-01-01T00:00:00.000Z"));
    });
    it("a lowercase 'z' (RFC-3339) is stripped the same as 'Z' before re-appending it", () => {
      expect(toEpoch("2026-01-01T00:00:00.100z")).toBe(toEpoch("2026-01-01T00:00:00.100Z"));
    });
    it("does not double-append 'Z' onto an already-'Z'-suffixed stamp (the bug e4ca135 fixed)", () => {
      // Before the fix, a real UTC stamp (isoTs() always writes one) fell into
      // the catch-all branch, which appended a SECOND "Z" — real jq hard-errors
      // on the malformed result ("...:18ZZ"); a truly buggy TS port would
      // instead silently produce NaN/epoch-0 for every normal timestamp.
      const t = toEpoch("2026-09-04T14:13:18.000Z");
      expect(t).toBe(Date.parse("2026-09-04T14:13:18.000Z"));
      expect(Number.isFinite(t)).toBe(true);
    });
    it("a legacy '+hh:mm' stamp lands at its correct UTC instant, milliseconds included", () => {
      const utc = toEpoch("2026-09-02T12:00:10.400Z");
      const plus530 = toEpoch("2026-09-02T17:30:10.400+05:30");
      expect(plus530).toBe(utc);
    });
    it("a legacy '-hh:mm' stamp lands at its correct UTC instant, milliseconds included", () => {
      const utc = toEpoch("2026-09-02T12:00:10.502Z");
      const minus4 = toEpoch("2026-09-02T08:00:10.502-04:00");
      expect(minus4).toBe(utc);
    });
    it("an unparseable stamp sorts as epoch 0 (in milliseconds), not NaN — it must not vanish", () => {
      expect(toEpoch("not-a-timestamp")).toBe(0);
    });
    it("a very early real date (1970) sorts before everything else numerically, not lexically", () => {
      // A lexical/text sort key would put "1970-..." (8ish significant digits
      // once epoch-converted) AFTER a 13-digit millisecond epoch for 2026 —
      // this is exactly the bug class e4ca135's test fixture (`wolf`) pins.
      const early = toEpoch("1970-01-02T00:00:00.000Z");
      const later = toEpoch("2026-09-02T12:00:10.100Z");
      expect(early).toBeLessThan(later);
    });
  });
});

describe("matchesFilters / parseFilterFlags", () => {
  it("AND across flags, OR within comma values", () => {
    const filters = parseFilterFlags(["type=thought,merge", "source=monolith"]);
    expect(matchesFilters({ type: "thought", source: "monolith" }, filters)).toBe(true);
    expect(matchesFilters({ type: "action", source: "monolith" }, filters)).toBe(false);
    expect(matchesFilters({ type: "merge", source: "other" }, filters)).toBe(false);
  });
  it("missing/false field coerces to jq's 'null' string", () => {
    const filters = parseFilterFlags(["foo=null"]);
    expect(matchesFilters({}, filters)).toBe(true);
    expect(matchesFilters({ foo: false }, filters)).toBe(true);
  });
});

describe("grepContent", () => {
  it("literal match with line numbers", () => {
    const out = grepContent("alpha\nbeta\ngamma", "beta", { ci: false, contextLines: 0, regex: false });
    expect(out).toEqual(["2:beta"]);
  });
  it("case-insensitive literal", () => {
    const out = grepContent("Alpha\nbeta", "ALPHA", { ci: true, contextLines: 0, regex: false });
    expect(out).toEqual(["1:Alpha"]);
  });
  it("regex mode (-E)", () => {
    const out = grepContent("foo123\nbar", "[0-9]+", { ci: false, contextLines: 0, regex: true });
    expect(out).toEqual(["1:foo123"]);
  });
  it("context lines with -- group separator on a gap", () => {
    const out = grepContent("a\nb\nMATCH\nc\nd\ne\nf\nMATCH2\ng", "MATCH", {
      ci: false,
      contextLines: 1,
      regex: false,
    });
    // first match context: lines 2-4 (b,MATCH,c); gap; second match context: lines 7-9
    expect(out[0]).toBe("2-b");
    expect(out[1]).toBe("3:MATCH");
    expect(out[2]).toBe("4-c");
    expect(out).toContain("--");
  });
  it("no match returns empty array", () => {
    expect(grepContent("a\nb", "zzz", { ci: false, contextLines: 0, regex: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// append / last — the PROVEN write path must stay unchanged
// ---------------------------------------------------------------------------

describe("append/last — unchanged write-path guard", () => {
  it("append via CLI produces the same on-disk record as trajCore.appendStep directly", () => {
    const trajDir = path.join(TMP, "d1");
    const id = "abcd1234-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const file = rootTrajFile(trajDir, id);

    const { io, out } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    const code = runTraj(["append", "--field", "type=observation", "--field", "content=hello"], io);
    expect(code).toBe(0);
    const stepId = out().trim();
    expect(stepId).toMatch(/^[0-9a-f-]{36}$/);

    const steps = readSteps(file);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ type: "observation", content: "hello", step_id: stepId });
    expect(typeof steps[1]!.ts).toBe("string");
  });

  it("append reads a JSON record from stdin when no --field given", () => {
    const trajDir = path.join(TMP, "d2");
    const id = "beef0000-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const file = rootTrajFile(trajDir, id);

    const { io } = makeIO({
      env: { TRAJ_DIR: trajDir, TRAJ_ID: id },
      stdin: JSON.stringify({ type: "thought", content: "hi" }),
    });
    const code = runTraj(["append"], io);
    expect(code).toBe(0);
    expect(readSteps(file)).toHaveLength(2);
  });

  it("append dies on empty stdin with no --field", () => {
    const trajDir = path.join(TMP, "d3");
    const id = "cafe0000-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const { io, err } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id }, stdin: "" });
    const code = runTraj(["append"], io);
    expect(code).toBe(1);
    expect(err()).toContain("append: empty stdin");
  });

  it("append dies when the record has no 'type' field", () => {
    const trajDir = path.join(TMP, "d4");
    const id = "d00d0000-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const { io, err } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    const code = runTraj(["append", "--field", "content=x"], io);
    expect(code).toBe(1);
    expect(err()).toContain("must have a 'type' field");
  });

  it("append auto-stamps run_id from SHELLM_RUN_STEP_ID, except for shellm-run/trajectory", () => {
    const trajDir = path.join(TMP, "d5");
    const id = "1111aaaa-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const file = rootTrajFile(trajDir, id);
    const { io } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id, SHELLM_RUN_STEP_ID: "run-1" } });
    runTraj(["append", "--field", "type=observation"], io);
    runTraj(["append", "--field", "type=shellm-run", "--field", "command=echo"], io);
    const steps = readSteps(file);
    expect(steps[1]).toMatchObject({ run_id: "run-1" });
    expect(steps[2]).not.toHaveProperty("run_id");
  });

  it("append spills stdout over STDOUT_INLINE_LIMIT to a blob (matches trajCore directly)", () => {
    const trajDir = path.join(TMP, "d6");
    const id = "2222bbbb-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const file = rootTrajFile(trajDir, id);
    const big = "x".repeat(5000);
    const { io } = makeIO({
      env: { TRAJ_DIR: trajDir, TRAJ_ID: id },
      stdin: JSON.stringify({ type: "shell-output", stdout: big }),
    });
    runTraj(["append"], io);
    const steps = readSteps(file);
    const step = steps[1]!;
    expect(step.stdout_truncated).toBe(true);
    expect(step.stdout_ref).toMatch(/^blobs\//);
    const blobPath = path.join(path.dirname(file), step.stdout_ref as string);
    expect(fs.readFileSync(blobPath, "utf8")).toBe(big);
  });

  it("last prints the raw last line verbatim (byte-identical to on-disk bytes)", () => {
    const trajDir = path.join(TMP, "d7");
    const id = "3333cccc-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "observation", content: "final line" });
    const raw = fs.readFileSync(file, "utf8").trim().split("\n").pop()!;

    const { io, out } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    const code = runTraj(["last"], io);
    expect(code).toBe(0);
    expect(out().trim()).toBe(raw);
  });

  it("last --field extracts one field; a MISSING field prints ZERO bytes (jq -r '// empty' produces no value, not a blank line)", () => {
    const trajDir = path.join(TMP, "d8");
    const id = "4444dddd-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "observation", content: "abc" });
    const { io, out } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    runTraj(["last", "--field", "content"], io);
    expect(out()).toBe("abc\n");

    const h2 = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    runTraj(["last", "--field", "nope"], h2.io);
    expect(h2.out()).toBe("");
  });

  // bug #48: upstream pipes the raw last line straight into `jq -r
  // ".${field} // empty"` (bin/traj:708) with no JSON validation first;
  // under `set -euo pipefail`, a malformed last line makes jq itself die
  // and aborts the WHOLE script with jq's own exit code (5) — verified
  // directly: `printf '%s' "not-json-at-all{{{" | jq -r '.step_id //
  // empty'` -> "jq: parse error: Invalid numeric literal at line 1, column
  // 16", status 5 (parity/fuzz/findings/traj-1.md). The port already
  // detected the invalid JSON and died cleanly, but with exit 1, not jq's
  // exit 5; jq's exact wording is jq-build-specific boilerplate and is not
  // reproduced (see PARITY.md's traj row, jq-internal-error allowance).
  it("bug #48: last --field on a malformed last line dies with jq's exit code (5), not 1", () => {
    const trajDir = path.join(TMP, "d10");
    const id = "5555eeee-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    fs.appendFileSync(file, "not-json-at-all{{{\n");
    const { io, out, err } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    const code = runTraj(["last", "--field", "step_id"], io);
    expect(code).toBe(5);
    expect(out()).toBe("");
    expect(err()).toContain("invalid JSON in last step");
  });

  it("last with --traj_dir explicit flag resolves a non-root child trajectory (the upstream-tests fix)", () => {
    const trajDir = path.join(TMP, "d9");
    const { io: newIo, out: newOut } = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "child run"], newIo);
    const [childId] = newOut().trim().split("\n");
    const bareIo = makeIO({}); // NOTE: no TRAJ_DIR/TRAJ_ID env at all
    const code = runTraj(["last", "--traj_dir", trajDir, childId!, "--field", "step_id"], bareIo.io);
    expect(code).toBe(0);
    expect(bareIo.out().trim()).toBe(childId);
  });
});

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

describe("new", () => {
  it("creates <hex8>-<slug>/trajectory.jsonl and prints uuid + relative path", () => {
    const trajDir = path.join(TMP, "new1");
    const { io, out } = makeIO({});
    const code = runTraj(["new", "--traj_dir", trajDir, "--slug", "Buy Milk!"], io);
    expect(code).toBe(0);
    const [uuid, relPath] = out().trim().split("\n");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(relPath).toBe(`${uuid!.slice(0, 8)}-buy-milk`);
    const file = path.join(trajDir, relPath!, "trajectory.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const record = readJsonl(file)[0]!;
    expect(record.type).toBe("trajectory");
    expect(record.step_id).toBe(uuid);
  });

  it("defaults slug to 'unnamed'", () => {
    const trajDir = path.join(TMP, "new2");
    const { io, out } = makeIO({});
    runTraj(["new", "--traj_dir", trajDir], io);
    const relPath = out().trim().split("\n")[1]!;
    expect(relPath.endsWith("-unnamed")).toBe(true);
  });

  it("--field values land on the first step, in order, overwritable by later duplicates", () => {
    const trajDir = path.join(TMP, "new3");
    const { io, out } = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--field", "foo=1", "--field", "bar=2", "--field", "foo=3"], io);
    const relPath = out().trim().split("\n")[1]!;
    const record = readJsonl(path.join(trajDir, relPath, "trajectory.jsonl"))[0]!;
    expect(record.foo).toBe("3");
    expect(record.bar).toBe("2");
  });

  it("nests under the parent's directory when --field parent_traj=<id> resolves", () => {
    const trajDir = path.join(TMP, "new4");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId, rootRel] = rootIo.out().trim().split("\n");

    const childIo = makeIO({});
    runTraj(
      ["new", "--traj_dir", trajDir, "--slug", "child", "--field", `parent_traj=${rootId}`],
      childIo.io,
    );
    const [, childRel] = childIo.out().trim().split("\n");
    expect(childRel!.startsWith(`${rootRel}/`)).toBe(true);
    const record = readJsonl(path.join(trajDir, childRel!, "trajectory.jsonl"))[0]!;
    expect(record.parent_traj_ref).toBe("..");
  });

  it("dies without --traj_dir or TRAJ_DIR", () => {
    const { io, err } = makeIO({});
    const code = runTraj(["new"], io);
    expect(code).toBe(1);
    expect(err()).toContain("new: --traj_dir or TRAJ_DIR required");
  });

  it("dies on an unexpected extra positional", () => {
    const { io, err } = makeIO({});
    const code = runTraj(["new", "--traj_dir", TMP, "bogus"], io);
    expect(code).toBe(1);
    expect(err()).toContain("new: unexpected argument: bogus");
  });
});

// ---------------------------------------------------------------------------
// fork / merge
// ---------------------------------------------------------------------------

describe("fork", () => {
  it("auto-creates a child trajectory and appends a fork step to the parent", () => {
    const trajDir = path.join(TMP, "fork1");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "parent"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");

    const { io, out } = makeIO({});
    const code = runTraj(["fork", "--traj_dir", trajDir, rootId!, "--slug", "sub task"], io);
    expect(code).toBe(0);
    const childId = out().trim();
    expect(childId).toMatch(/^[0-9a-f-]{36}$/);

    const parentFile = pathOf(trajDir, rootId!);
    const steps = readSteps(parentFile);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ type: "fork", child: childId });
    expect(typeof steps[1]!.child_ref).toBe("string");

    // The auto-created child's own first step must carry parent_traj_ref
    // (bin/traj:381-387 via cmd_new) — this needs resolveTrajFile's
    // findDirByPrefix to match the SEARCH ROOT itself (the parent's own
    // directory), not just its descendants, since cmd_fork resolves the
    // parent id starting FROM the parent's own directory (bin/traj:1291).
    const childFile = pathOf(trajDir, childId);
    const childFirst = readSteps(childFile)[0]!;
    expect(childFirst.parent_traj).toBe(rootId);
    expect(childFirst.parent_traj_ref).toBe("..");
  });

  it("uses a provided --child id instead of auto-creating", () => {
    const trajDir = path.join(TMP, "fork2");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "parent"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");

    const childIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "manual child"], childIo.io);
    const [childId] = childIo.out().trim().split("\n");

    const { io, out } = makeIO({});
    runTraj(["fork", "--traj_dir", trajDir, rootId!, "--child", childId!], io);
    expect(out().trim()).toBe(childId);
  });

  // bug #60: bash computes the child's own parent_traj via `head -1
  // "$parent_file" | jq -r '.step_id'`. When parent_file is EMPTY (no first
  // line at all), `head -1` writes zero bytes and jq reads zero JSON
  // documents from empty stdin, producing ZERO output (exit 0) — the
  // command substitution captures "", so bash writes `"parent_traj":""`.
  // Verified directly against upstream (parity/fuzz/findings/traj-c2-2.md).
  // The port used to map "no parseable first line" straight to jq's
  // "field absent from a real object -> tostring prints null" behavior,
  // writing the literal four-character string "null" instead of "".
  it("bug #60: forking a trajectory whose file is EMPTY writes parent_traj:\"\", not the string \"null\"", () => {
    const trajDir = path.join(TMP, "fork-empty");
    const rootId = "12345678-1111-2222-3333-444444444444";
    const rootFile = rootTrajFile(trajDir, rootId);
    fs.mkdirSync(path.dirname(rootFile), { recursive: true });
    fs.writeFileSync(rootFile, "");

    const { io, out } = makeIO({});
    const code = runTraj(["fork", "--traj_dir", trajDir, rootId], io);
    expect(code).toBe(0);
    const childId = out().trim();

    const childFile = pathOf(trajDir, childId);
    const childFirst = readSteps(childFile)[0]!;
    expect(childFirst.parent_traj).toBe("");
  });

  // bug #61: when the parent trajectory's first line is NON-EMPTY but not
  // valid JSON, `head -1 | jq -r '.step_id'` makes jq itself parse-error
  // and die (exit 5) — under `set -euo pipefail` that aborts the WHOLE
  // fork before any child dir is created or the parent file is touched.
  // Verified directly against upstream
  // (parity/fuzz/findings/traj-c2-3.md): a trajectory whose only content is
  // `not-json-at-all{{{` -> bash exits 5, no child created, parent file
  // unchanged. The port used to tolerate the unparseable line and complete
  // the fork anyway (exit 0, a new child dir created, a fork record
  // appended on top of the corrupt line) — matched here the same way bug
  // #48 matched `last`/`search`: the EXIT CODE is reproduced, jq's own
  // parse-error wording is not (PARITY.md's jq-internal-error allowance).
  it("bug #61: forking a trajectory whose only content is malformed JSON dies like bash's jq crash (exit 5), no child created", () => {
    const trajDir = path.join(TMP, "fork-malformed");
    const rootId = "12345678-1111-2222-3333-444444444444";
    const rootFile = rootTrajFile(trajDir, rootId);
    fs.mkdirSync(path.dirname(rootFile), { recursive: true });
    fs.writeFileSync(rootFile, "not-json-at-all{{{\n");

    const { io } = makeIO({});
    const code = runTraj(["fork", "--traj_dir", trajDir, rootId], io);
    expect(code).toBe(5);
    // no child directory created, parent file untouched
    const entries = fs.readdirSync(path.dirname(rootFile));
    expect(entries).toEqual(["trajectory.jsonl"]);
    expect(fs.readFileSync(rootFile, "utf8")).toBe("not-json-at-all{{{\n");
  });
});

describe("merge", () => {
  // bin/traj:1360 resolves the child from `${TRAJ_DIR:-$traj_dir}` — the
  // ENV var (not the --traj_dir flag), falling back to the PARENT's own
  // resolved directory. A merge caller normally has $TRAJ_DIR set for the
  // whole session (or the child is nested under the parent via `fork`); a
  // sibling `new` with only --traj_dir and no env TRAJ_DIR genuinely fails
  // to resolve in bash too — replicated faithfully, not a port bug.
  it("reads the child's last step and appends a merge step to the parent", () => {
    const trajDir = path.join(TMP, "merge1");
    const parentIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "parent"], parentIo.io);
    const [parentId] = parentIo.out().trim().split("\n");

    const childIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "child"], childIo.io);
    const [childId] = childIo.out().trim().split("\n");
    // append an extra step to the child so "last step" != first step
    const resolvedChildFile = pathOf(trajDir, childId!);
    appendStep(resolvedChildFile, { type: "observation", content: "child done" });

    const { io, out } = makeIO({ env: { TRAJ_DIR: trajDir } });
    const code = runTraj(["merge", childId!, "--traj_dir", trajDir, parentId!], io);
    expect(code).toBe(0);
    const mergeStepId = out().trim();
    expect(mergeStepId).toMatch(/^[0-9a-f-]{36}$/);

    const parentFile = pathOf(trajDir, parentId!);
    const steps = readSteps(parentFile);
    const mergeStep = steps[steps.length - 1]!;
    expect(mergeStep.type).toBe("merge");
    expect(mergeStep.from_traj).toBe(childId);
    const lastChildStep = readSteps(resolvedChildFile).pop()!;
    expect(mergeStep.from_step).toBe(lastChildStep.step_id);
  });

  it("dies when the child trajectory cannot be resolved", () => {
    const trajDir = path.join(TMP, "merge2");
    const parentIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "parent"], parentIo.io);
    const [parentId] = parentIo.out().trim().split("\n");
    const { io, err } = makeIO({});
    const code = runTraj(["merge", "00000000-0000-0000-0000-000000000000", "--traj_dir", trajDir, parentId!], io);
    expect(code).toBe(1);
    expect(err()).toContain("cannot resolve child traj");
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe("show", () => {
  function setup() {
    const trajDir = path.join(TMP, "show1");
    const id = "aaaa1111-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const stepId = appendStep(file, { type: "observation", content: "hello", source: "monolith" });
    return { trajDir, id, file, stepId };
  }

  it("shows trajectory metadata for the trajectory's own first step", () => {
    const { trajDir, id } = setup();
    const { io, out } = makeIO({});
    const code = runTraj(["show", id, "--traj_dir", trajDir], io);
    expect(code).toBe(0);
    expect(out()).toContain("Root:   yes");
    expect(out()).toContain("Steps:  2");
    expect(out()).toContain(`ID:     ${id}`);
  });

  it("shows a step's JSON for a non-first step_id", () => {
    const { trajDir, stepId } = setup();
    const { io, out } = makeIO({});
    runTraj(["show", stepId, "--traj_dir", trajDir], io);
    const parsed = JSON.parse(out());
    expect(parsed).toMatchObject({ type: "observation", content: "hello" });
  });

  it("--field extracts a single raw field", () => {
    const { trajDir, stepId } = setup();
    const { io, out } = makeIO({});
    runTraj(["show", stepId, "--traj_dir", trajDir, "--field", "content"], io);
    expect(out()).toBe("hello\n");
  });

  it("--field on an absent field prints ZERO bytes (jq -r '// empty', not a blank line)", () => {
    const { trajDir, stepId } = setup();
    const { io, out } = makeIO({});
    runTraj(["show", stepId, "--traj_dir", trajDir, "--field", "nope"], io);
    expect(out()).toBe("");
  });

  it("--full replaces truncated stdout with the blob contents", () => {
    const trajDir = path.join(TMP, "show2");
    const id = "bbbb2222-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const big = "y".repeat(5000);
    const stepId = appendStep(file, { type: "shell-output", stdout: big });
    const { io, out } = makeIO({});
    runTraj(["show", stepId, "--traj_dir", trajDir, "--full"], io);
    const parsed = JSON.parse(out());
    expect(parsed.stdout).toBe(big);
    expect(parsed.stdout_truncated).toBeUndefined();
  });

  it("dies with a clean message when the id is not found", () => {
    const { trajDir } = setup();
    const { io, err } = makeIO({});
    const code = runTraj(["show", "ffffffff-0000-0000-0000-000000000000", "--traj_dir", trajDir], io);
    expect(code).toBe(1);
    expect(err()).toContain("not found in");
  });
});

// ---------------------------------------------------------------------------
// tail / cat
// ---------------------------------------------------------------------------

describe("tail", () => {
  function setup() {
    const trajDir = path.join(TMP, "tail1");
    const id = "cccc3333-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    for (let i = 0; i < 5; i++) appendStep(file, { type: "thought", content: `t${i}` });
    return { trajDir, id, file };
  }

  it("--raw prints the last N lines as JSONL", () => {
    const { trajDir, id } = setup();
    const { io, outLines } = makeIO({});
    const code = runTraj(["tail", "--traj_dir", trajDir, id, "-n", "2", "--raw"], io);
    expect(code).toBe(0);
    expect(outLines()).toHaveLength(2);
    expect(JSON.parse(outLines()[1]!).content).toBe("t4");
  });

  it("defaults to raw when stdout is not a tty", () => {
    const { trajDir, id } = setup();
    const { io, outLines } = makeIO({ isTTY: false });
    runTraj(["tail", "--traj_dir", trajDir, id, "-n", "1"], io);
    expect(() => JSON.parse(outLines()[0]!)).not.toThrow();
  });

  it("formats when stdout IS a tty (no --raw)", () => {
    const { trajDir, id } = setup();
    const { io, out } = makeIO({ isTTY: true });
    runTraj(["tail", "--traj_dir", trajDir, id, "-n", "1"], io);
    expect(out()).toContain("[thought]");
    expect(out()).toContain("t4");
  });

  it("--filter type=thought AND's across flags, OR's comma values", () => {
    const trajDir = path.join(TMP, "tail2");
    const id = "dddd4444-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "thought", content: "a" });
    appendStep(file, { type: "action", content: "b" });
    const { io, outLines } = makeIO({});
    runTraj(["tail", "--traj_dir", trajDir, id, "-n", "10", "--raw", "--filter", "type=action"], io);
    expect(outLines()).toHaveLength(1);
    expect(JSON.parse(outLines()[0]!).type).toBe("action");
  });

  it("a bare numeric positional sets -n (bash quirk)", () => {
    const { trajDir, id } = setup();
    const { io, outLines } = makeIO({});
    runTraj(["tail", "--traj_dir", trajDir, id, "2", "--raw"], io);
    expect(outLines()).toHaveLength(2);
  });

  it("-r/--recursive interleaves sub-trajectory steps by timestamp", () => {
    const trajDir = path.join(TMP, "tail3");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");
    const rootFile = rootTrajFile(trajDir, rootId!);
    appendStep(rootFile, { type: "thought", content: "root-thought" });

    const forkIo = makeIO({});
    runTraj(["fork", "--traj_dir", trajDir, rootId!, "--slug", "child"], forkIo.io);
    const childId = forkIo.out().trim();
    const pathIo = makeIO({});
    runTraj(["path", "--traj_dir", trajDir, childId], pathIo.io);
    const childFile = pathIo.out().trim();
    appendStep(childFile, { type: "thought", content: "child-thought" });

    const { io, outLines } = makeIO({});
    runTraj(["tail", "--traj_dir", trajDir, rootId!, "-n", "10", "--raw", "-r"], io);
    const contents = outLines().map((l) => JSON.parse(l).content ?? JSON.parse(l).child);
    expect(contents).toContain("root-thought");
    expect(contents).toContain("child-thought");
  });

  it("unknown option dies", () => {
    const { trajDir, id } = setup();
    const { io, err } = makeIO({});
    const code = runTraj(["tail", "--traj_dir", trajDir, id, "--bogus"], io);
    expect(code).toBe(1);
    expect(err()).toContain("tail: unknown option: --bogus");
  });

  it("bug #51: -n 0 prints nothing, not the whole file (JS slice(-0) quirk)", () => {
    // Verified directly against upstream: a 5-line fixture,
    // `tail -n 0 <file>` (real coreutils, what bin/traj:1141 shells out to)
    // -> empty stdout, exit 0. Pre-fix, `coreutilsLines(f).slice(-n)` with
    // n=0 computed `.slice(-0)`, which JS treats as `.slice(0)` (the WHOLE
    // array) since `-0 === 0`, printing all 5 lines instead of none.
    const { trajDir, id } = setup();
    const { io, outLines } = makeIO({});
    const code = runTraj(["tail", "--traj_dir", trajDir, id, "-n", "0", "--raw"], io);
    expect(code).toBe(0);
    expect(outLines()).toHaveLength(0);
  });

  // bug #62: coreutils' `tail -n N` treats a LEADING `-` on the count as
  // idiomatic, not sign-inverting — `-n -2` means "the last 2 lines,"
  // clamped to however many exist, same as `-n 2`. Verified directly
  // against upstream (parity/fuzz/findings/traj-c2-5.md): a 1-line
  // trajectory, `tail -n -2` -> bash prints the one available line, exit 0.
  // Pre-fix, `tailLastN`'s `arr.slice(-n)` with n=-2 computed `.slice(2)`
  // ("skip the first 2, keep the rest") instead of "the last 2" —
  // under-printing, or as here (only 1 line exists), printing nothing.
  it("bug #62: -n <negative> means the last |n| lines, not slice(-n)'s sign-flip", () => {
    const trajDir = path.join(TMP, "tail-neg");
    const id = "eeee5555-0000-0000-0000-000000000000";
    const file = rootTrajFile(trajDir, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // exactly ONE line, matching the finding's "1-message trajectory" repro
    fs.writeFileSync(file, JSON.stringify({ type: "message", step_id: "m0", content: "only-one" }) + "\n");
    const { io, outLines } = makeIO({});
    const code = runTraj(["tail", "--traj_dir", trajDir, id, "-n", "-2", "--raw"], io);
    expect(code).toBe(0);
    expect(outLines()).toHaveLength(1);
    expect(JSON.parse(outLines()[0]!).content).toBe("only-one");
  });

  it("-h prints help and exits 0", () => {
    const { io, out } = makeIO({});
    const code = runTraj(["tail", "-h"], io);
    expect(code).toBe(0);
    expect(out()).toContain("traj tail");
  });
});

describe("cat", () => {
  it("--raw prints every step as JSONL", () => {
    const trajDir = path.join(TMP, "cat1");
    const id = "eeee5555-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "thought", content: "a" });
    appendStep(file, { type: "action", content: "b" });
    const { io, outLines } = makeIO({});
    runTraj(["cat", "--traj_dir", trajDir, id, "--raw"], io);
    expect(outLines()).toHaveLength(3);
  });

  it("dies when the trajectory cannot be resolved at all (require_traj_file fails before the -f check; bin/traj:1524's `[[ -f ]] || return 0` is unreachable through normal resolution)", () => {
    const trajDir = path.join(TMP, "cat2");
    const { io, err } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: "ffff6666-0000-0000-0000-000000000000" } });
    const code = runTraj(["cat"], io);
    expect(code).toBe(1);
    expect(err()).toContain("cannot resolve traj_id");
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("search", () => {
  it("finds matches in default fields (content/thought/cmd/stdout/stderr)", () => {
    const trajDir = path.join(TMP, "search1");
    const id = "11112222-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const stepId = appendStep(file, { type: "thought", content: "RLM appears here" });
    const { io, out } = makeIO({});
    const code = runTraj(["search", "RLM", "--traj_dir", trajDir, id], io);
    expect(code).toBe(0);
    expect(out()).toBe(`${stepId}:content:1:RLM appears here\n`);
  });

  it("--field restricts the search to one field", () => {
    const trajDir = path.join(TMP, "search2");
    const id = "33334444-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "reasoning", thought: "no match", cmd: "echo NEEDLE" });
    const { io, out } = makeIO({});
    runTraj(["search", "NEEDLE", "--traj_dir", trajDir, id, "--field", "cmd"], io);
    expect(out()).toContain(":cmd:1:echo NEEDLE");
  });

  it("searches blob contents when a field spilled", () => {
    const trajDir = path.join(TMP, "search3");
    const id = "55556666-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const big = "prefix ".repeat(1000) + "NEEDLE" + " suffix".repeat(1000);
    appendStep(file, { type: "shell-output", stdout: big });
    const { io, out } = makeIO({});
    runTraj(["search", "NEEDLE", "--traj_dir", trajDir, id, "--field", "stdout"], io);
    expect(out()).toContain("NEEDLE");
  });

  it("dies without a pattern", () => {
    const { io, err } = makeIO({ env: { TRAJ_DIR: TMP, TRAJ_ID: "x" } });
    const code = runTraj(["search"], io);
    expect(code).toBe(1);
    expect(err()).toContain("search requires <pattern>");
  });

  // bug #48: upstream's per-row loop unconditionally pipes the raw row into
  // `jq -r '.step_id // empty'` with no JSON validation first; under `set
  // -euo pipefail`, a malformed row makes jq itself die there, aborting the
  // WHOLE script with jq's exit code (5) — matches ARE printed for every
  // row processed before the malformed one, then nothing after. Verified
  // directly against upstream: a trajectory file whose rows are otherwise
  // well-formed but end with the fixed malformed line "not-json-at-all{{{"
  // makes `traj search <any pattern>` (the pattern's own content is
  // irrelevant — this is not about spaces in the pattern, despite
  // traj-2.md's title) crash with "jq: parse error: Invalid numeric
  // literal at line 1, column 16", exit 5 — even when an EARLIER row does
  // match and gets printed first (parity/fuzz/findings/traj-2.md, and
  // parity/fuzz/findings/traj-1.md's sibling finding, both re-triaged here
  // as the SAME root cause: any raw-row jq pipe with no upfront JSON
  // validation).
  // Sync 2e39a3f (defd719/3732d20): search now pre-filters rows with grep BEFORE jq, so a malformed
  // row that does NOT contain the pattern is skipped (exit 0); only a malformed row that survives
  // the pre-filter reaches jq and dies with jq's exit code (5). Verified by parity/traj
  // search-malformed/*.
  it("sync 2e39a3f: a malformed row after a matching one is skipped when it does not contain the pattern", () => {
    const trajDir = path.join(TMP, "search4");
    const id = "77778888-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const stepId = appendStep(file, { type: "thought", content: "a1 memo here" });
    fs.appendFileSync(file, "not-json-at-all{{{\n");
    const { io, out, err } = makeIO({});
    const code = runTraj(["search", "a1 memo", "--traj_dir", trajDir, id], io);
    expect(code).toBe(0);
    expect(out()).toBe(`${stepId}:content:1:a1 memo here\n`);
    expect(err()).toBe("");
  });

  it("bug #48 (narrowed): a malformed row that CONTAINS the pattern dies with jq's exit code (5), no stdout before it", () => {
    const trajDir = path.join(TMP, "search5");
    const id = "9999aaaa-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    fs.appendFileSync(file, "not-json needle {{{\n");
    appendStep(file, { type: "thought", content: "never reached needle" });
    const { io, out, err } = makeIO({});
    const code = runTraj(["search", "needle", "--traj_dir", trajDir, id], io);
    expect(code).toBe(5);
    expect(out()).toBe("");
    expect(err()).toContain("invalid JSON in row");
  });
});

// ---------------------------------------------------------------------------
// count / exists / path
// ---------------------------------------------------------------------------

describe("count", () => {
  it("prints wc -l of the trajectory file", () => {
    const trajDir = path.join(TMP, "count1");
    const id = "77778888-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "thought", content: "a" });
    const { io, out } = makeIO({});
    runTraj(["count", "--traj_dir", trajDir, id], io);
    expect(out()).toBe("2\n");
  });

  it("dies when the trajectory cannot be resolved at all (same unreachable-branch reasoning as cat)", () => {
    const { io, err } = makeIO({ env: { TRAJ_DIR: TMP, TRAJ_ID: "99990000-0000-0000-0000-000000000000" } });
    const code = runTraj(["count"], io);
    expect(code).toBe(1);
    expect(err()).toContain("cannot resolve traj_id");
  });
});

describe("exists", () => {
  it("returns 0 for a trajectory with at least one step", () => {
    const trajDir = path.join(TMP, "exists1");
    const id = "aaaa9999-0000-0000-0000-000000000000";
    seedRoot(trajDir, id);
    const { io } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    expect(runTraj(["exists"], io)).toBe(0);
  });

  it("returns 1 when TRAJ_DIR/TRAJ_ID are unset and no flags given", () => {
    const { io } = makeIO({});
    expect(runTraj(["exists"], io)).toBe(1);
  });

  it("returns 1 for a trajectory that cannot be resolved", () => {
    const { io } = makeIO({ env: { TRAJ_DIR: TMP, TRAJ_ID: "notfound0-0000-0000-0000-000000000000" } });
    expect(runTraj(["exists"], io)).toBe(1);
  });

  it("dies (exit 1, via die) on an unknown option, distinct from the 'not found' return 1", () => {
    const { io, err } = makeIO({});
    const code = runTraj(["exists", "--bogus"], io);
    expect(code).toBe(1);
    expect(err()).toContain("exists: unknown option");
  });
});

describe("path", () => {
  it("prints the resolved file path", () => {
    const trajDir = path.join(TMP, "path1");
    const id = "bbbb0000-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    const { io, out } = makeIO({ env: { TRAJ_DIR: trajDir, TRAJ_ID: id } });
    runTraj(["path"], io);
    expect(out().trim()).toBe(file);
  });

  it("dies with the require_traj_file message when nothing is specified", () => {
    const { io, err } = makeIO({});
    const code = runTraj(["path"], io);
    expect(code).toBe(1);
    expect(err()).toContain("path: no trajectory specified");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("plain format marks self with >>> and shows step counts", () => {
    const trajDir = path.join(TMP, "list1");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");
    const { io, out } = makeIO({});
    runTraj(["list", "--traj_dir", trajDir, rootId!], io);
    expect(out()).toContain(">>>");
    expect(out()).toContain("(1 steps)");
  });

  it("--json emits one JSON object per line with is_self", () => {
    const trajDir = path.join(TMP, "list2");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");
    const { io, outLines } = makeIO({});
    runTraj(["list", "--traj_dir", trajDir, rootId!, "--json"], io);
    const rows = outLines().map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_self: true, id: rootId });
  });

  it("lists forked children under the root", () => {
    const trajDir = path.join(TMP, "list3");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId] = rootIo.out().trim().split("\n");
    const forkIo = makeIO({});
    runTraj(["fork", "--traj_dir", trajDir, rootId!, "--slug", "kid"], forkIo.io);

    const { io, out } = makeIO({});
    runTraj(["list", "--traj_dir", trajDir, rootId!, "--json"], io);
    const rows = out()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => !r.is_self)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

describe("root", () => {
  it("returns its own directory name when already root", () => {
    const trajDir = path.join(TMP, "root1");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId, rootRel] = rootIo.out().trim().split("\n");
    const { io, out } = makeIO({});
    runTraj(["root", "--traj_dir", trajDir, rootId!], io);
    expect(out().trim()).toBe(rootRel);
  });

  it("walks up through a fork to the root directory name", () => {
    const trajDir = path.join(TMP, "root2");
    const rootIo = makeIO({});
    runTraj(["new", "--traj_dir", trajDir, "--slug", "root"], rootIo.io);
    const [rootId, rootRel] = rootIo.out().trim().split("\n");
    const forkIo = makeIO({});
    runTraj(["fork", "--traj_dir", trajDir, rootId!, "--slug", "kid"], forkIo.io);
    const childId = forkIo.out().trim();

    const { io, out } = makeIO({});
    runTraj(["root", "--traj_dir", trajDir, childId], io);
    expect(out().trim()).toBe(rootRel);
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe("check", () => {
  it("OK on a well-formed file", () => {
    const trajDir = path.join(TMP, "check1");
    const id = "cccc0000-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "thought", content: "a" });
    const { io, out } = makeIO({});
    const code = runTraj(["check", "--traj_dir", trajDir, id], io);
    expect(code).toBe(0);
    expect(out()).toContain("OK:");
  });

  it("reports malformed lines and exits 1 without --fix", () => {
    const trajDir = path.join(TMP, "check2");
    const id = "dddd0000-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    fs.appendFileSync(file, "not json at all\n");
    const { io, out } = makeIO({});
    const code = runTraj(["check", "--traj_dir", trajDir, id], io);
    expect(code).toBe(1);
    expect(out()).toContain("malformed line");
  });

  it("--fix removes malformed lines and exits 0", () => {
    const trajDir = path.join(TMP, "check3");
    const id = "eeee0000-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    fs.appendFileSync(file, "not json at all\n");
    const { io } = makeIO({});
    const code = runTraj(["check", "--traj_dir", trajDir, id, "--fix"], io);
    expect(code).toBe(0);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// top-level dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("no args prints usage to stdout and exits 1", () => {
    const { io, out } = makeIO({});
    const code = runTraj([], io);
    expect(code).toBe(1);
    expect(out()).toContain("Usage: traj <command>");
  });

  it("help/-h/--help print usage and exit 0", () => {
    for (const flag of ["help", "-h", "--help"]) {
      const { io, out } = makeIO({});
      expect(runTraj([flag], io)).toBe(0);
      expect(out()).toContain("Usage: traj <command>");
    }
  });

  it("unknown command dies", () => {
    const { io, err } = makeIO({});
    const code = runTraj(["bogus"], io);
    expect(code).toBe(1);
    expect(err()).toContain("unknown command: bogus");
  });
});

// ---------------------------------------------------------------------------
// getSummary / wcL — small direct checks
// ---------------------------------------------------------------------------

describe("getSummary / wcL", () => {
  it("falls back to the FIRST LINE's raw .command field (bash reads head -1 unconditionally, not a shellm-run-typed step)", () => {
    const trajDir = path.join(TMP, "sum0");
    const id = "eeee0001-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id, { command: "first line command wins" });
    expect(getSummary(file)).toBe("first line command wins");
  });

  it("prefers run-summary.tldr, then prompt.content, then '(no summary)' when the first line has no .command", () => {
    const trajDir = path.join(TMP, "sum1");
    const id = "ffff0000-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    expect(getSummary(file)).toBe("(no summary)");
    appendStep(file, { type: "prompt", content: "prompt wins" });
    expect(getSummary(file)).toBe("prompt wins");
    appendStep(file, { type: "run-summary", tldr: "tldr wins" });
    expect(getSummary(file)).toBe("tldr wins");
  });

  it("truncates a long summary to 77 code points + '...'", () => {
    const trajDir = path.join(TMP, "sum2");
    const id = "00001111-0000-0000-0000-000000000000";
    const file = seedRoot(trajDir, id);
    appendStep(file, { type: "run-summary", tldr: "x".repeat(200) });
    const s = getSummary(file);
    expect(s.endsWith("...")).toBe(true);
    expect(s.length).toBe(80);
  });

  it("wcL counts newline characters", () => {
    const f = path.join(TMP, "wcl.txt");
    fs.writeFileSync(f, "a\nb\nc\n");
    expect(wcL(f)).toBe(3);
    fs.writeFileSync(f, "a\nb\nc"); // no trailing newline: last partial line uncounted
    expect(wcL(f)).toBe(2);
  });
});
