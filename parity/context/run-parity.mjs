#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `context` tool.
//
// Runs the REAL Bash tool (headlong/bin/context) and the TS port
// (headlong-ts/bin/context.mjs) on identical trajectory fixtures in isolated
// scratch sandboxes, then diffs stdout + stderr + exit code + on-disk state.
// `context` output is deterministic (it echoes existing trajectory rows — no
// clock, no random), so NOTHING is normalized in the CORE set: comparison is
// byte-exact. `context` is READ-ONLY, so on-disk state is snapshotted on both
// sides and must remain byte-identical (a write on either side is a defect).
//
// This harness is ADVERSARIAL: it was written to try to make the port diverge,
// harvesting every quirk from the Bash source (selection, elision arithmetic
// incl. the head+tail unread-middle overcount, pins incl. the grep `head -50`
// cap, blob substitution, jq-pretty output & escaping, `pp` of non-string
// fields, byte-aware multibyte truncation, the `--max-bytes` budget search &
// hard-truncation, role precedence, same-role merge, and every resolution /
// error path). Scenarios split into:
//
//   CORE  — realistic + edge inputs that MUST reach full byte-parity. These
//           gate the exit code.
//   DEVIATION — degenerate / malformed / platform-dependent inputs where a
//           divergence is EXPECTED and documented. Each asserts its documented
//           shape (a regression guard); they are reported but the exit code
//           only fails if a deviation's shape changes from what's documented.
//
// Repeatable: `node parity/context/run-parity.mjs`. Requires `jq` on PATH (the
// Bash tool uses it). Point at the real Bash tool with
//   PARITY_BASH_CONTEXT=/abs/path/to/headlong/bin/context
// Writes results.json + report.md beside this file.
// Exit 0 iff every CORE scenario is PARITY and every DEVIATION matches its
// documented expectation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Path to the real Bash tool. Scrubbed to a placeholder for release; set
// PARITY_BASH_CONTEXT=/abs/path/to/headlong/bin/context to reproduce the run.
const BASH = process.env.PARITY_BASH_CONTEXT || "<HEADLONG_ROOT>/bin/context";
const TS = path.join(REPO, "bin", "context.mjs");

// --- artifact scrubbing --------------------------------------------------------
// No absolute local paths in committed report.md/results.json: any occurrence of
// the real upstream root (derived from PARITY_BASH_CONTEXT at runtime) or of
// $HOME is replaced with a placeholder BEFORE writing, so re-running never
// reintroduces them. Applied only to display/report values, after every `cmp`/
// `ok` has already been computed — it cannot affect PASS/FAIL.
const HEADLONG_ROOT = path.resolve(path.dirname(BASH), "..");
const HOME = os.homedir();
function scrubPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

// --- fixture DSL -------------------------------------------------------------
// A step object is JSON-serialized. A string beginning "RAW:" is written to the
// JSONL verbatim (for malformed / non-object / hand-crafted lines).
const enc = (s) =>
  typeof s === "string" && s.startsWith("RAW:") ? s.slice(4) : JSON.stringify(s);
const jsonl = (steps, noFinalNL) =>
  steps.map(enc).join("\n") + (noFinalNL ? "" : "\n");
const UUID = (h) => `${h}-1111-2222-3333-444444444444`;
const T = (h) => ({ type: "trajectory", step_id: h });

/** Fixture: a single `<hex>-root` trajectory dir under ./trajdir, optional blobs. */
function rootFixture(hex8, steps, { blobs, noFinalNL } = {}) {
  return (sb) => {
    const rootDir = path.join(sb, "trajdir", `${hex8}-root`);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "trajectory.jsonl"), jsonl(steps, noFinalNL));
    if (blobs) {
      const bdir = path.join(rootDir, "blobs");
      fs.mkdirSync(bdir, { recursive: true });
      for (const [name, content] of Object.entries(blobs))
        fs.writeFileSync(path.join(bdir, name), content);
    }
  };
}
const rootEnv = (hex8) => ({ TRAJ_DIR: "./trajdir", TRAJ_ID: UUID(hex8) });

// --- on-disk state (context is read-only; snapshot to prove no writes) --------
function walk(dir, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else acc.push({ rel, content: fs.readFileSync(full, "utf8") });
  }
}
function serializeState(sb) {
  const acc = [];
  walk(sb, "", acc);
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

// --- run one implementation in a fresh sandbox --------------------------------
function makeSandbox(fixture) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-parity-"));
  fixture(sb);
  return sb;
}
function runTool(kind, sc, sb) {
  const env = { ...process.env, LC_ALL: "C" };
  delete env.CTX_HEAD;
  delete env.CTX_TAIL;
  delete env.SHELLM_STDOUT_PROMPT_LIMIT;
  delete env.CTX_ELISION_STYLE;
  delete env.TRAJ_DIR;
  delete env.TRAJ_ID;
  Object.assign(env, sc.env || {});
  const argv = kind === "bash" ? sc.argv : [TS, ...sc.argv];
  const cmd = kind === "bash" ? BASH : "node";
  const res = spawnSync(cmd, argv, {
    cwd: sb,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
    signal: res.signal,
    state: serializeState(sb),
  };
}

// ============================================================================
// CORE scenarios — MUST reach full byte-parity (stdout + stderr + exit + state)
// ============================================================================
const core = [];
const C = (name, o) => core.push({ name, argv: [], env: {}, ...o });

// ---- roles / basic rendering ----
C("basic-roles", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "prompt", step_id: "s-prompt", content: "do the thing" },
    { type: "reasoning", step_id: "s-reason", thought: "let me think", cmd: "ls -la" },
    { type: "shell-output", step_id: "s-out", stdout: "file1\nfile2\n" },
    { type: "final", step_id: "s-final", content: "done" },
  ]),
  argv: ["--assistant-types", "reasoning,final", "--user-types", "prompt,shell-output,feedback"],
  env: rootEnv("aaaaaaaa"),
});
C("single-cmd-bare", {
  // nc==1 renders BARE even for `cmd` (no ```bash fence)
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "reasoning", step_id: "r1", cmd: "ls -la" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});
C("cmd-thought-sorted", {
  // jq keys sort: cmd (fenced) before thought (bare)
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "reasoning", step_id: "r1", thought: "thinking", cmd: "ls -la" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});
C("cmd-thought-other-labeled", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "reasoning", step_id: "r1", thought: "thinking", cmd: "ls -la", extra: "more" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});
// ---- sync 2e39a3f (815eab2): reasoning rows render from a fixed field list ----
const RS = (row) => ({
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "reasoning", step_id: "r1", ...row }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});
C("reasoning-served-by-not-rendered", RS({ thought: "thinking", cmd: "ls -la", served_by: "DeepInfra", truncated: true, in_tok: 5 }));
C("reasoning-unknown-field-not-rendered", RS({ thought: "thinking", cmd: "ls -la", mystery_field: "zzz" }));
C("reasoning-thought-only-no-bare-shortcut", RS({ thought: "just thinking" }));
C("reasoning-cmd-only-fenced", RS({ cmd: "ls -la" }));
C("reasoning-content-then-cmd", RS({ content: "older name for the thought", cmd: "ls -la" }));
C("reasoning-thought-content-cmd-order", RS({ cmd: "ls", content: "C", thought: "T" }));
C("reasoning-content-only", RS({ content: "only content" }));
C("reasoning-no-renderable-fields", RS({ stuff: "x", served_by: "y" }));
C("reasoning-empty-thought-null-cmd", RS({ thought: "", cmd: null, content: "kept" }));
C("reasoning-thought-truncated-per-field", {
  ...RS({ thought: "x".repeat(300), cmd: "y".repeat(300) }),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning", "--prompt-limit", "64"],
});
C("non-reasoning-served-by-is-meta", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "s1", alpha: "AAA", served_by: "X", truncated: true }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("multifield-labeled", {
  fixture: rootFixture("13131313", [T("13131313"), { type: "custom", step_id: "s1", alpha: "AAA", beta: "BBB" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("13131313"),
});
C("null-field-forces-labeled", {
  // a null field still counts toward nc, so the surviving field renders LABELED
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", a: "only-a", b: null }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("multifield-empty-string", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", a: "", b: "real" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("field-sort-order", {
  // jq `keys` codepoint sort vs JS .sort() — mixed case / underscore / digit
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", Zebra: "Z", apple: "a", _under: "u", Num1: "n", banana: "b", ABC: "A" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("unknown-type-default-user", {
  fixture: rootFixture("9a9a9a9a", [T("9a9a9a9a"), { type: "observation", step_id: "o1", content: "obs text" }, { type: "idle", step_id: "o2", note: "idling" }]),
  argv: ["--head", "3", "--tail", "0"],
  env: rootEnv("9a9a9a9a"),
});
C("role-precedence-excl-wins", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "dup", step_id: "d1", content: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "dup", "--user-types", "dup", "--exclude-types", "dup"],
  env: rootEnv("aaaaaaaa"),
});
C("role-precedence-asst-over-user", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "dup", step_id: "d1", content: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "dup", "--user-types", "dup"],
  env: rootEnv("aaaaaaaa"),
});
C("exclude-user-plus-appended", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "excluded-now" }, { type: "final", step_id: "f1", content: "kept" }]),
  argv: ["--head", "4", "--tail", "0", "--exclude-types", "reasoning", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("same-role-merge", {
  fixture: rootFixture("78787878", [T("78787878"), { type: "reasoning", step_id: "r1", thought: "first" }, { type: "reasoning", step_id: "r2", thought: "second" }]),
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("78787878"),
});
C("empty-render-adjacency-merge", {
  // trajectory row (renders "") between two user rows → they still merge
  fixture: rootFixture("aaaaaaaa", [{ type: "prompt", step_id: "aaaaaaaa", content: "u1" }, { type: "trajectory", step_id: "t2" }, { type: "shell-output", step_id: "s3", stdout: "u2" }]),
  argv: ["--head", "3", "--tail", "0", "--user-types", "prompt,shell-output"],
  env: rootEnv("aaaaaaaa"),
});

// ---- meta keys ----
C("meta-suffix-keys", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", real: "R", foo_ref: "x", foo_bytes: 9, foo_truncated: true, fork_parent: "pp", ts: "z" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("field-named-like-meta", {
  fixture: rootFixture("aaaaaaaa", ["RAW:" + JSON.stringify({ type: "custom", step_id: "c1", content: "keep", ts: "meta", fork_parent: "meta" })], { blobs: undefined }),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});

// ---- non-string content field values (jqr_empty / pp) ----
C("object-field-pp", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", data: { z: 1, a: [1, 2], s: "hi\nthere", nested: { x: true, y: null } } }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("array-field-pp", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", items: ["a", "b\nc", 42, true, null, { k: "v" }] }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("scalar-fields", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", num: 42, flt: 3.14, tf: true, ff: false, nn: null, str: "s" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("empty-object-field", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", data: {}, other: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("empty-array-field", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", data: [], other: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});

// ---- escaping / whitespace (final JSON output; rtrim is NEWLINE-only) ----
C("escaping-torture", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: 'q"b\\c\tTAB /slash  日本 café mid\nline2' }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("control-chars-below-0x20", {
  // C0 controls (0x01..0x1f): jq AND JSON.stringify escape these identically
  // (short \b\t\n\f\r + \u00xx). Must PARITY.
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "final", step_id: "g1", content: "a" + [0x01, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f].map((c) => String.fromCodePoint(c)).join("|") + "z\nmid" },
  ]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("high-and-c1-chars", {
  // 0x80..0x9f (C1), 0xa0, U+2028/9, and non-ASCII are emitted LITERALLY (UTF-8)
  // by BOTH jq and JSON.stringify. (0x7f has its own scenario below.) Must PARITY.
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "final", step_id: "g1", content: [0x80, 0x9f, 0xa0, 0x2028, 0x2029, 0x00e9, 0x65e5].map((c) => String.fromCodePoint(c)).join("|") },
  ]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
// --- U+007F (DEL) — REAL PORT DIVERGENCE: jq escapes it as \u007f, Node
//     JSON.stringify emits it RAW. Reachable via shell-output bytes. These two
//     scenarios (top-level output path + ppValue object-field path) DIVERGE
//     until the port escapes 0x7f. See report.md / returned findings.
C("control-char-del-0x7f", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "final", step_id: "g1", content: "del" + String.fromCodePoint(0x7f) + "here" },
  ]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("del-0x7f-in-object-field", {
  // exercises the ppValue (JSON.stringify) path for object-valued content fields
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "custom", step_id: "c1", data: { s: "x" + String.fromCodePoint(0x7f) + "y" } },
  ]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});
C("trailing-spaces-preserved", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "keep spaces   \n\n\n" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trailing-tab-preserved", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "hello\ttab" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("whitespace-only-content-dropped", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "   \n\n" }, { type: "final", step_id: "g2", content: "real" }]),
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});

// ---- step_id edge cases that MATCH ----
C("stepid-number", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: 123, content: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("stepid-zero", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: 0, content: "x" }]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("stepid-empty-dropped", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "", content: "x" }, { type: "final", step_id: "g2", content: "y" }]),
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("stepid-missing-dropped", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", content: "x" }, { type: "final", step_id: "g2", content: "y" }]),
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});

// ---- malformed lines both handle identically ----
C("null-line-dropped", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), "RAW:null", { type: "final", step_id: "g1", content: "x" }]),
  argv: ["--head", "5", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("malformed-json-line-dropped", {
  fixture: rootFixture("cdcdcdcd", [T("cdcdcdcd"), { type: "prompt", step_id: "g1", content: "a" }, "RAW:{not valid json", "RAW:" + JSON.stringify({ type: "reasoning", thought: "b", step_id: "" }), { type: "final", step_id: "g2", content: "c" }]),
  argv: ["--head", "5", "--tail", "0", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("cdcdcdcd"),
});

// ---- fork / merge ----
C("fork-child-string", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "fork", step_id: "f1", child: "child-abc" }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("fork-child-object", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "fork", step_id: "f1", child: { id: "x", n: 1 } }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("merge-from-branch", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "merge", step_id: "m1", from_branch: "br-1", content: "merged text" }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("merge-from-traj", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "merge", step_id: "m2", from_traj: "tr-2" }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("merge-from-branch-null-fallback", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "merge", step_id: "m1", from_branch: null, from_traj: "tr-fallback", content: "c" }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("merge-from-branch-false-fallback", {
  // jq `//` treats false as empty → falls to from_traj; port matches this one
  fixture: rootFixture("12121212", ["RAW:" + JSON.stringify(T("12121212")), "RAW:" + JSON.stringify({ type: "merge", step_id: "m1", from_branch: false, from_traj: "tr-fallback" })]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});
C("merge-no-content", {
  fixture: rootFixture("12121212", [T("12121212"), { type: "merge", step_id: "m1", from_branch: "br-1" }]),
  argv: ["--head", "2", "--tail", "0"],
  env: rootEnv("12121212"),
});

// ---- selection / elision ----
C("elision-gap", {
  fixture: rootFixture("bbbbbbbb", [T("bbbbbbbb"), { type: "prompt", step_id: "s1", content: "one" }, { type: "reasoning", step_id: "s2", thought: "two" }, { type: "reasoning", step_id: "s3", thought: "three" }, { type: "reasoning", step_id: "s4", thought: "four" }, { type: "final", step_id: "s5", content: "five" }]),
  argv: ["--head", "1", "--tail", "2", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("bbbbbbbb"),
});
C("elision-style-none", {
  fixture: rootFixture("bbbbbbbb", [T("bbbbbbbb"), { type: "prompt", step_id: "s1", content: "one" }, { type: "reasoning", step_id: "s2", thought: "two" }, { type: "reasoning", step_id: "s3", thought: "three" }, { type: "final", step_id: "s5", content: "five" }]),
  argv: ["--head", "1", "--tail", "1", "--elision-style", "none", "--assistant-types", "reasoning,final"],
  env: rootEnv("bbbbbbbb"),
});
C("elision-style-bogus-shows-markers", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "reasoning", step_id: "r1", thought: "a" }, { type: "reasoning", step_id: "r2", thought: "b" }, { type: "reasoning", step_id: "r3", thought: "c" }, { type: "final", step_id: "f1", content: "d" }]),
  argv: ["--head", "1", "--tail", "1", "--elision-style", "wat", "--assistant-types", "reasoning,final"],
  env: rootEnv("aaaaaaaa"),
});
C("elision-leading-head0", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "reasoning", step_id: "r2", thought: "three" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "0", "--tail", "2", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("elision-between-assistants-no-merge", {
  fixture: rootFixture("aaaaaaaa", [{ type: "reasoning", step_id: "aaaaaaaa", thought: "first" }, { type: "prompt", step_id: "p1", content: "skipme" }, { type: "prompt", step_id: "p2", content: "skipme2" }, { type: "final", step_id: "f1", content: "last" }]),
  argv: ["--head", "1", "--tail", "1", "--assistant-types", "reasoning,final"],
  env: rootEnv("aaaaaaaa"),
});
C("exclude-skip-arith", {
  fixture: rootFixture("cccccccc", [T("cccccccc"), { type: "prompt", step_id: "s1", content: "a" }, { type: "shellm-run", step_id: "s2", note: "machinery" }, { type: "run-summary", step_id: "s3", note: "summary" }, { type: "reasoning", step_id: "s4", thought: "b" }, { type: "final", step_id: "s5", content: "c" }]),
  argv: ["--head", "6", "--tail", "0", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("cccccccc"),
});
C("elision-overcount-unread-middle", {
  // excluded rows in the UNREAD middle: BOTH overcount identically (the quirk)
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "shellm-run", step_id: "sr1", note: "m" }, { type: "run-summary", step_id: "rs1", note: "s" }, { type: "reasoning", step_id: "r1", thought: "mid" }, { type: "reasoning", step_id: "r2", thought: "mid2" }, { type: "final", step_id: "f1", content: "last" }]),
  argv: ["--head", "2", "--tail", "1", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("all-fed-excluded-trailing-elision", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "prompt", step_id: "p2", content: "two" }]),
  argv: ["--head", "3", "--tail", "0", "--exclude-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});

// ---- boundaries ----
C("boundary-total-eq-headtail", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "2", "--tail", "2", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("boundary-total-plus1", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "reasoning", step_id: "r2", thought: "three" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "2", "--tail", "2", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("head-larger-than-file", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "final", step_id: "f1", content: "two" }]),
  argv: ["--head", "999", "--tail", "0", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("no-final-newline", {
  fixture: rootFixture("efefefef", [T("efefefef"), { type: "prompt", step_id: "p1", content: "one" }, { type: "final", step_id: "s1", content: "no newline" }], { noFinalNL: true }),
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("efefefef"),
});
C("no-final-newline-large-branch", {
  fixture: rootFixture("efefefef", [T("efefefef"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "final", step_id: "s1", content: "no newline" }], { noFinalNL: true }),
  argv: ["--head", "1", "--tail", "1", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("efefefef"),
});
C("crlf-lines", {
  fixture: (sb) => {
    const d = path.join(sb, "trajdir", "aaaaaaaa-root");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "trajectory.jsonl"), JSON.stringify(T("aaaaaaaa")) + "\r\n" + JSON.stringify({ type: "prompt", step_id: "p1", content: "one" }) + "\r\n" + JSON.stringify({ type: "final", step_id: "f1", content: "two" }) + "\r\n");
  },
  argv: ["--head", "3", "--tail", "0", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("empty-file", {
  fixture: (sb) => {
    const d = path.join(sb, "trajdir", "56565656-root");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "trajectory.jsonl"), "");
  },
  env: rootEnv("56565656"),
});
C("only-trajectory-row", {
  // N=1 (renders "") → `[]` with NO trailing newline (contrast empty-file → `[]\n`)
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]),
  argv: ["--head", "1", "--tail", "0"],
  env: rootEnv("aaaaaaaa"),
});

// ---- pins ----
C("pin-middle", {
  fixture: rootFixture("dddddddd", [T("dddddddd"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "pinned-step-id", thought: "PINME" }, { type: "reasoning", step_id: "p3", thought: "three" }, { type: "reasoning", step_id: "p4", thought: "four" }, { type: "final", step_id: "p5", content: "five" }]),
  argv: ["--head", "1", "--tail", "1", "--pin", "pinned-step-id", "--assistant-types", "reasoning,final"],
  env: rootEnv("dddddddd"),
});
C("pin-large-unread-middle", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "reasoning", step_id: "pinme", thought: "PINNED" }, { type: "reasoning", step_id: "r3", thought: "three" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "1", "--tail", "1", "--pin", "pinme", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("pin-over-50-cap", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), ...Array.from({ length: 60 }, (_, k) => ({ type: "reasoning", step_id: "dup", thought: `line ${k}` })), { type: "final", step_id: "f1", content: "end" }]),
  argv: ["--head", "1", "--tail", "1", "--pin", "dup", "--assistant-types", "reasoning,final"],
  env: rootEnv("aaaaaaaa"),
});
C("multi-pin", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "reasoning", step_id: "pa", thought: "AAA" }, { type: "reasoning", step_id: "mid", thought: "mid" }, { type: "reasoning", step_id: "pb", thought: "BBB" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "1", "--tail", "1", "--pin", "pa", "--pin", "pb", "--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("pin-excluded-never-kept", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "one" }, { type: "shellm-run", step_id: "sr1", note: "x" }, { type: "reasoning", step_id: "r1", thought: "mid" }, { type: "final", step_id: "f1", content: "four" }]),
  argv: ["--head", "1", "--tail", "1", "--pin", "sr1", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});

// ---- truncation ----
C("trunc-boundary-eq", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "10", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-boundary-minus1", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "9", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-limit-1", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "1", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-limit-0", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-limit-2", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "2", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-multibyte-split", {
  fixture: rootFixture("eeeeeeee", [T("eeeeeeee"), { type: "reasoning", step_id: "t1", thought: "café " + "日本語".repeat(40) + " END" }]),
  argv: ["--prompt-limit", "40", "--assistant-types", "reasoning"],
  env: rootEnv("eeeeeeee"),
});
C("trunc-multibyte-half1", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "日本語日本語" }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "3", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("trunc-in-labeled-block", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "custom", step_id: "c1", alpha: "A".repeat(40), beta: "B".repeat(40) }]),
  argv: ["--head", "2", "--tail", "0", "--prompt-limit", "12", "--user-types", "custom"],
  env: rootEnv("aaaaaaaa"),
});

// ---- blobs ----
C("blob-stdout", {
  fixture: rootFixture("ffffffff", [T("ffffffff"), { type: "shell-output", step_id: "b1", stdout: "inline-preview", stdout_ref: "blobs/big.stdout", stdout_bytes: 5000, stdout_truncated: true }], { blobs: { "big.stdout": "FULL BLOB CONTENT\n" + "x".repeat(200) + "\n\n\n" } }),
  argv: ["--user-types", "shell-output"],
  env: rootEnv("ffffffff"),
});
C("blob-missing-file-inline-stays", {
  fixture: rootFixture("ffffffff", [T("ffffffff"), { type: "shell-output", step_id: "b1", stdout: "inline-stays", stdout_ref: "blobs/nope.stdout", stdout_truncated: true }]),
  argv: ["--user-types", "shell-output"],
  env: rootEnv("ffffffff"),
});
C("blob-stderr", {
  fixture: rootFixture("ffffffff", [T("ffffffff"), { type: "shell-output", step_id: "b1", stderr_ref: "blobs/e.stderr" }], { blobs: { "e.stderr": "ERRLOG\nline2\n" } }),
  argv: ["--user-types", "shell-output"],
  env: rootEnv("ffffffff"),
});
C("blob-both-stdout-stderr", {
  fixture: rootFixture("ffffffff", [T("ffffffff"), { type: "shell-output", step_id: "b1", stdout_ref: "blobs/o", stderr_ref: "blobs/e" }], { blobs: { o: "OUT\n", e: "ERR\n" } }),
  argv: ["--user-types", "shell-output"],
  env: rootEnv("ffffffff"),
});
C("blob-ref-nonstring-ignored", {
  fixture: rootFixture("ffffffff", [T("ffffffff"), { type: "shell-output", step_id: "b1", stdout: "keep", stdout_ref: 123 }]),
  argv: ["--user-types", "shell-output"],
  env: rootEnv("ffffffff"),
});
C("inline-stdout-trailing-nl-rtrim", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "shell-output", step_id: "s1", stdout: "line1\nline2\n\n\n" }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "shell-output"],
  env: rootEnv("aaaaaaaa"),
});

// ---- --max-bytes ----
C("maxbytes-fits", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "reasoning", step_id: "x1", thought: "A".repeat(50) }, { type: "final", step_id: "x2", content: "B".repeat(50) }]),
  argv: ["--max-bytes", "9999", "--head", "1", "--tail", "3", "--assistant-types", "reasoning,final"],
  env: rootEnv("34343434"),
});
C("maxbytes-binary-search", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "reasoning", step_id: "x1", thought: "A".repeat(300) }, { type: "reasoning", step_id: "x2", thought: "B".repeat(300) }, { type: "final", step_id: "x3", content: "C".repeat(300) }]),
  argv: ["--max-bytes", "220", "--prompt-limit", "500", "--head", "1", "--tail", "3", "--assistant-types", "reasoning,final"],
  env: rootEnv("34343434"),
});
C("maxbytes-hardtrunc", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "reasoning", step_id: "x1", thought: "A".repeat(300) }, { type: "final", step_id: "x2", content: "B".repeat(300) }]),
  argv: ["--max-bytes", "30", "--prompt-limit", "500", "--assistant-types", "reasoning,final"],
  env: rootEnv("34343434"),
});
C("maxbytes-hardtrunc-multibyte", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "final", step_id: "x1", content: "日本語".repeat(20) }]),
  argv: ["--max-bytes", "35", "--prompt-limit", "500", "--assistant-types", "final"],
  env: rootEnv("34343434"),
});
C("maxbytes-exact-1", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "final", step_id: "x1", content: "Z".repeat(50) }]),
  argv: ["--max-bytes", "1", "--prompt-limit", "500", "--assistant-types", "final"],
  env: rootEnv("34343434"),
});

// ---- resolution ----
C("resolve-exact-path", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "s1", content: "ok" }]),
  argv: ["--traj_dir", "./trajdir", "aaaaaaaa-root/trajectory.jsonl", "--assistant-types", "final"],
});
C("resolve-dir-based", {
  fixture: (sb) => {
    const d = path.join(sb, "trajdir", "myid");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "trajectory.jsonl"), jsonl([T("z"), { type: "final", step_id: "s1", content: "ok" }]));
  },
  argv: ["--traj_dir", "./trajdir", "myid", "--assistant-types", "final"],
});
C("resolve-uuid-hex-prefix-glob", {
  fixture: rootFixture("bcbcbcbc", [T("bcbcbcbc"), { type: "prompt", step_id: "s1", content: "hi" }, { type: "final", step_id: "s2", content: "bye" }]),
  argv: ["--traj_dir", "./trajdir", UUID("bcbcbcbc"), "--assistant-types", "final", "--user-types", "prompt"],
});
C("resolve-nonuuid-glob", {
  fixture: rootFixture("bcbcbcbc", [T("bcbcbcbc"), { type: "final", step_id: "s1", content: "ok" }]),
  argv: ["--traj_dir", "./trajdir", "bcbcbcbc", "--assistant-types", "final"],
});
C("resolve-nested-dir", {
  fixture: (sb) => {
    const d = path.join(sb, "trajdir", "sub", "deadbeef-root");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "trajectory.jsonl"), jsonl([T("x"), { type: "final", step_id: "s1", content: "nested" }]));
  },
  argv: ["--traj_dir", "./trajdir", "deadbeef", "--assistant-types", "final"],
});
C("resolve-trajdir-trailing-slash", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "s1", content: "ok" }]),
  argv: ["--traj_dir", "./trajdir/", UUID("aaaaaaaa"), "--assistant-types", "final"],
});
C("resolve-env-vars", {
  fixture: rootFixture("bcbcbcbc", [T("bcbcbcbc"), { type: "prompt", step_id: "s1", content: "hi" }, { type: "final", step_id: "s2", content: "bye" }]),
  argv: ["--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("bcbcbcbc"),
});
C("resolve-optdir-beats-env", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "s1", content: "optwin" }]),
  argv: ["--traj_dir", "./trajdir", UUID("aaaaaaaa"), "--assistant-types", "final"],
  env: { TRAJ_DIR: "./nope", TRAJ_ID: UUID("bbbbbbbb") },
});
C("resolve-positional-ignored-env-wins", {
  // a lone positional with no --traj_dir is ignored; env wins
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "s1", content: "envwin" }]),
  argv: ["zzzznomatch", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});

// ---- errors ----
C("err-unknown-option", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--bogus"], env: rootEnv("aaaaaaaa") });
C("err-extra-arg", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--traj_dir", "./trajdir", UUID("aaaaaaaa"), "EXTRA"] });
C("err-cannot-resolve-optdir", { fixture: rootFixture("bcbcbcbc", [T("bcbcbcbc")]), argv: ["--traj_dir", "./trajdir", UUID("deadbeef")] });
C("err-cannot-resolve-env", { fixture: rootFixture("bcbcbcbc", [T("bcbcbcbc")]), argv: [], env: { TRAJ_DIR: "./trajdir", TRAJ_ID: UUID("deadbeef") } });
C("err-no-traj-specified", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: [] });
C("err-trajdir-only-no-env", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--traj_dir", "./trajdir"] });
C("err-positional-only-no-env", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: [UUID("aaaaaaaa")] });
C("err-env-trajdir-empty", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: [], env: { TRAJ_DIR: "", TRAJ_ID: UUID("aaaaaaaa") } });

// ---- help ----
C("help-short", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["-h"] });
C("help-long", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--help"] });
C("help-after-positional", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: [UUID("aaaaaaaa"), "-h"], env: rootEnv("aaaaaaaa") });

// ---- env defaults ----
C("env-ctx-head-tail", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p", content: "one" }, { type: "reasoning", step_id: "r1", thought: "two" }, { type: "reasoning", step_id: "r2", thought: "three" }, { type: "final", step_id: "f", content: "four" }]),
  argv: ["--assistant-types", "reasoning,final", "--user-types", "prompt"],
  env: { ...rootEnv("aaaaaaaa"), CTX_HEAD: "2", CTX_TAIL: "1" },
});
C("env-prompt-limit", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "abcdefghij" }]),
  argv: ["--assistant-types", "final"],
  env: { ...rootEnv("aaaaaaaa"), SHELLM_STDOUT_PROMPT_LIMIT: "5" },
});

// ---- realistic monolith invocation on a large trajectory ----
C("monolith-realistic-large", {
  fixture: (() => {
    const big = [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "user asks something" }];
    for (let k = 0; k < 30; k++) {
      big.push({ type: "reasoning", step_id: `r${k}`, thought: `reasoning ${k}`, cmd: `echo ${k}` });
      big.push({ type: "shell-output", step_id: `o${k}`, stdout: `output ${k}\n` });
      if (k % 5 === 0) big.push({ type: "shellm-run", step_id: `sr${k}`, note: "machinery" });
    }
    big.push({ type: "final", step_id: "fin", content: "final answer" });
    return rootFixture("aaaaaaaa", big);
  })(),
  argv: ["--assistant-types", "reasoning,final", "--user-types", "prompt,shell-output,feedback", "--exclude-types", "shellm-run,run-summary"],
  env: rootEnv("aaaaaaaa"),
});

// ---- 1c: 3228c8c/1fdeb97 — bookkeeping fields hidden from the model --------
C("is-meta-bookkeeping-hidden", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "reasoning", step_id: "r1", thought: "t", run_id: "run-1", llm_s: 2, in_tok: 100, out_tok: 50, think_tok: 10, cache_tok: 80, estimated: true },
  ]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});

// ---- 1c: f68c1d8 — source_url added to the hidden bookkeeping set ----------
C("is-meta-bookkeeping-hidden-source-url", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    {
      type: "prompt",
      step_id: "p1",
      content: "Do the thing.",
      source_url: "https://example.slack.com/archives/C1/p1",
    },
  ]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});

// ---- 1c: 7a35982 — --full-types, --run ------------------------------------
C("full-types-prompt-never-truncated", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "prompt", step_id: "p1", content: "P".repeat(3000) }]),
  argv: ["--head", "2", "--tail", "0", "--user-types", "prompt", "--prompt-limit", "50", "--full-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("run-scope-drops-other-runs-no-count", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "prompt", step_id: "p0", content: "other run", run_id: "run-A" },
    { type: "final", step_id: "f0", content: "mine", run_id: "run-B" },
  ]),
  argv: ["--head", "0", "--tail", "3", "--run", "run-B", "--assistant-types", "final", "--user-types", "prompt"],
  env: rootEnv("aaaaaaaa"),
});
C("run-scope-gap-inside-run-no-count", {
  fixture: rootFixture(
    "aaaaaaaa",
    [T("aaaaaaaa"), ...Array.from({ length: 10 }, (_, i) => ({ type: "reasoning", step_id: `s${i}`, thought: `t${i}`, run_id: "run-X" }))]
  ),
  argv: ["--head", "1", "--tail", "2", "--run", "run-X", "--assistant-types", "reasoning"],
  env: rootEnv("aaaaaaaa"),
});

// ---- 1c: d43ae81 — --tail-block ---------------------------------------------
C("tail-block-window-does-not-slide", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), ...Array.from({ length: 11 }, (_, i) => ({ type: "final", step_id: `s${i}`, content: `c${i}` }))]),
  argv: ["--head", "0", "--tail", "2", "--tail-block", "5", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("tail-block-env-default", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), ...Array.from({ length: 11 }, (_, i) => ({ type: "final", step_id: `s${i}`, content: `c${i}` }))]),
  argv: ["--head", "0", "--tail", "2", "--assistant-types", "final"],
  env: { ...rootEnv("aaaaaaaa"), CTX_TAIL_BLOCK: "5" },
});

// ---- 1c: 0f8b49e — --block-limit / --whole-blocks (newest-block band) -----
C("block-limit-newest-row-whole", {
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "prompt", step_id: "p1", content: "W".repeat(400) },
    { type: "final", step_id: "f1", content: "W".repeat(400) },
  ]),
  argv: [
    "--head", "0", "--tail", "2", "--prompt-limit", "50", "--block-limit", "5000", "--whole-blocks", "1",
    "--user-types", "prompt", "--assistant-types", "final",
  ],
  env: rootEnv("aaaaaaaa"),
});
C("block-limit-defaults-to-prompt-limit-when-unset", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "f1", content: "W".repeat(400) }]),
  argv: ["--head", "0", "--tail", "1", "--prompt-limit", "50", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
});
C("block-limit-max-bytes-search-collapses-band", {
  // The --max-bytes binary search passes ONE limit for both prompt-limit and
  // block-limit (bin/context render_at), so the band collapses under budget
  // pressure instead of defeating it.
  fixture: rootFixture("aaaaaaaa", [
    T("aaaaaaaa"),
    { type: "prompt", step_id: "p1", content: "Q".repeat(2000) },
    { type: "final", step_id: "f1", content: "Q".repeat(2000) },
  ]),
  argv: [
    "--head", "0", "--tail", "2", "--prompt-limit", "50", "--block-limit", "5000", "--whole-blocks", "1",
    "--user-types", "prompt", "--assistant-types", "final", "--max-bytes", "300",
  ],
  env: rootEnv("aaaaaaaa"),
});

// ============================================================================
// DEVIATION scenarios — divergence EXPECTED & documented. Each defines an
// `expect(b, t)` predicate asserting the documented shape (regression guard).
// ============================================================================
const deviations = [];
const D = (name, o) => deviations.push({ name, argv: [], env: {}, ...o });

// #1 — `${2:?msg}` on a missing/empty required flag value: Bash prints
// `<script>: line N: 2: <msg>` (abs path + Bash line number), the port prints
// `context: error: <msg>`. Exit(1) + empty stdout + unchanged state MATCH.
const stderrOnly = (b, t) => b.stdout === t.stdout && b.status === t.status && b.state === t.state && b.stderr !== t.stderr;
D("misuse-head-no-value", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--head"], env: rootEnv("aaaaaaaa"), kind: "stderr-wording (deviation #1)", expect: stderrOnly });
D("misuse-assistant-types-empty", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--assistant-types", ""], env: rootEnv("aaaaaaaa"), kind: "stderr-wording (deviation #1)", expect: stderrOnly });
D("misuse-traj_dir-no-value", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--traj_dir"], env: rootEnv("aaaaaaaa"), kind: "stderr-wording (deviation #1)", expect: stderrOnly });
D("misuse-prompt-limit-no-value", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa")]), argv: ["--prompt-limit"], env: rootEnv("aaaaaaaa"), kind: "stderr-wording (deviation #1)", expect: stderrOnly });

// #3 — a JSONL line that parses to a NON-NULL, NON-OBJECT value (number, array,
// string, boolean): Bash's `.row.step_id` errors → jq aborts (exit 5, empty
// stdout, jq error on stderr); the port treats it as a dropped null row and
// continues (exit 0, output present). Real trajectory lines are always objects.
const bashAborts = (b, t) => b.status !== 0 && b.stdout === "" && t.status === 0 && t.stdout !== "";
D("nonobject-number-line", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "before" }, "RAW:42", { type: "final", step_id: "g2", content: "after" }]), argv: ["--head", "5", "--tail", "0", "--assistant-types", "final"], env: rootEnv("aaaaaaaa"), kind: "bash-aborts on non-object line (deviation #3)", expect: bashAborts });
D("nonobject-array-line", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), { type: "final", step_id: "g1", content: "x" }, "RAW:[1,2,3]"], {}), argv: ["--head", "5", "--tail", "0", "--assistant-types", "final"], env: rootEnv("aaaaaaaa"), kind: "bash-aborts on non-object line (deviation #3)", expect: bashAborts });
D("nonobject-string-line", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), 'RAW:"hello"', { type: "final", step_id: "g1", content: "x" }]), argv: ["--head", "5", "--tail", "0", "--assistant-types", "final"], env: rootEnv("aaaaaaaa"), kind: "bash-aborts on non-object line (deviation #3)", expect: bashAborts });
D("nonobject-true-line", { fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), "RAW:true", { type: "final", step_id: "g1", content: "x" }]), argv: ["--head", "5", "--tail", "0", "--assistant-types", "final"], env: rootEnv("aaaaaaaa"), kind: "bash-aborts on non-object line (deviation #3)", expect: bashAborts });

// #2 — MULTIPLE dirs match `<hexPrefix>-*`: Bash `find … | head -1` uses readdir
// order; the port's pre-order DFS uses readdirSync order. Winner is
// filesystem-dependent on BOTH sides and may differ. Real trajectory dirs hold
// a single `<hex8>-root`. Assert: both exit 0 with a valid non-empty array.
const fsTiebreak = (b, t) => b.status === 0 && t.status === 0 && b.stdout.startsWith("[") && t.stdout.startsWith("[");
D("multi-dir-hexprefix-tiebreak", {
  fixture: (sb) => {
    const base = path.join(sb, "trajdir");
    for (const [nm, c] of [["abcd1234-alpha", "ALPHA"], ["abcd1234-beta", "BETA"]]) {
      const d = path.join(base, nm);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "trajectory.jsonl"), jsonl([T("x"), { type: "final", step_id: "s1", content: c }]));
    }
  },
  argv: ["--traj_dir", "./trajdir", "abcd1234", "--assistant-types", "final"],
  kind: "find|head-1 vs DFS tie-break (deviation #2, filesystem-order dependent)",
  expect: fsTiebreak,
});

// UNDOCUMENTED-A — `--max-bytes 0` forces `head -c 0`. BSD/macOS head rejects it
// (`illegal byte count -- 0`, exit 1); GNU/Linux head accepts it but under
// `pipefail` the outcome is SIGPIPE-timing-dependent. The port is deterministic:
// empty stdout + `[budget exceeded…]` on stderr + exit 0. Degenerate input (no
// caller passes 0); platform/shell artifact, NOT a port contract bug. Assert the
// port's deterministic shape only.
const maxbytesZero = (b, t) => t.status === 0 && t.stdout === "" && t.stderr === "[budget exceeded: trajectory too dense]";
D("maxbytes-zero-platform", {
  fixture: rootFixture("34343434", [T("34343434"), { type: "final", step_id: "x1", content: "Z".repeat(50) }]),
  argv: ["--max-bytes", "0", "--prompt-limit", "500", "--assistant-types", "final"],
  env: rootEnv("34343434"),
  kind: "head -c 0 platform/degenerate (undocumented; harmless on Linux target)",
  expect: maxbytesZero,
});

// UNDOCUMENTED-B — `step_id: false`. Bash's fed guard `.step_id // ""` treats
// false as empty → row dropped; the port's `String(row.step_id ?? "")` keeps it
// (?? only defaults null/undefined). step_id is never a boolean in practice.
const stepidFalse = (b, t) => b.stdout === "[]" && t.stdout !== "[]" && b.status === 0 && t.status === 0;
D("stepid-false-microdivergence", {
  fixture: rootFixture("aaaaaaaa", [T("aaaaaaaa"), "RAW:" + JSON.stringify({ type: "final", step_id: false, content: "x" })]),
  argv: ["--head", "2", "--tail", "0", "--assistant-types", "final"],
  env: rootEnv("aaaaaaaa"),
  kind: "// vs ?? on step_id:false (undocumented; absurd input)",
  expect: stepidFalse,
});

// ============================================================================
// Execute
// ============================================================================
function execScenario(sc) {
  const sbB = makeSandbox(sc.fixture);
  const sbT = makeSandbox(sc.fixture);
  let bash, ts;
  try {
    bash = runTool("bash", sc, sbB);
    ts = runTool("ts", sc, sbT);
  } finally {
    fs.rmSync(sbB, { recursive: true, force: true });
    fs.rmSync(sbT, { recursive: true, force: true });
  }
  const cmp = {
    stdout: bash.stdout === ts.stdout,
    stderr: bash.stderr === ts.stderr,
    status: bash.status === ts.status,
    state: bash.state === ts.state,
  };
  const parity = cmp.stdout && cmp.stderr && cmp.status && cmp.state;
  return { bash, ts, cmp, parity };
}

const coreResults = core.map((sc) => {
  const r = execScenario(sc);
  return { group: "core", name: sc.name, argv: sc.argv, ...r, ok: r.parity };
});
const devResults = deviations.map((sc) => {
  const r = execScenario(sc);
  const ok = sc.expect(r.bash, r.ts);
  return { group: "deviation", name: sc.name, argv: sc.argv, kind: sc.kind, ...r, ok };
});

const all = [...coreResults, ...devResults];

// Scrub display copies for reporting ONLY, after every parity/ok verdict above
// has already been computed from the raw values — this cannot change a score.
for (const r of all) {
  for (const side of [r.bash, r.ts]) {
    if (!side) continue;
    if ("stdout" in side) side.stdout = scrubPaths(side.stdout);
    if ("stderr" in side) side.stderr = scrubPaths(side.stderr);
    if ("state" in side) side.state = scrubPaths(side.state);
  }
}

const coreParity = coreResults.filter((r) => r.parity).length;
const coreFail = coreResults.filter((r) => !r.parity);
const devUnexpected = devResults.filter((r) => !r.ok);
const exitOk = coreFail.length === 0 && devUnexpected.length === 0;

// --- report -----------------------------------------------------------------
function trunc(s, n = 600) {
  if (s == null) return String(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n}B)` : s;
}
function diffBlock(r) {
  const rows = [];
  for (const f of ["stdout", "stderr", "status", "state"]) {
    if (!r.cmp[f]) {
      rows.push(`    ${f}:`);
      rows.push(`      bash: ${JSON.stringify(trunc(String(r.bash[f])))}`);
      rows.push(`      ts  : ${JSON.stringify(trunc(String(r.ts[f])))}`);
    }
  }
  return rows.join("\n");
}

let md = `# context — adversarial differential parity proof\n\n`;
md += `Generated by \`parity/context/run-parity.mjs\`. Real Bash tool \`headlong/bin/context\` vs TS port \`headlong-ts/bin/context.mjs\`, identical trajectory fixtures in isolated sandboxes, diffed **stdout + stderr + exit code + on-disk state** byte-for-byte. \`context\` is deterministic and read-only, so NOTHING is normalized in the core set and both sandboxes must stay byte-identical (a write on either side is a defect).\n\n`;
md += `- Bash tool: \`${scrubPaths(BASH)}\`\n`;
md += `- Locale pinned \`LC_ALL=C\`. Node: \`node parity/context/run-parity.mjs\`.\n\n`;
md += `## Result\n\n`;
md += `- **Core: ${coreParity}/${coreResults.length} PARITY** (byte-exact). ${coreFail.length === 0 ? "No core divergences." : `**${coreFail.length} FAIL.**`}\n`;
md += `- Deviation probes: ${devResults.length - devUnexpected.length}/${devResults.length} match their documented shape. ${devUnexpected.length === 0 ? "No unexpected changes." : `**${devUnexpected.length} UNEXPECTED.**`}\n`;
md += `- Overall: **${exitOk ? "PASS" : "FAIL"}** (exit ${exitOk ? 0 : 1}).\n\n`;

md += `## Core scenarios (${coreResults.length})\n\n| # | scenario | verdict |\n|---|---|---|\n`;
coreResults.forEach((r, i) => { md += `| ${i + 1} | ${r.name} | ${r.parity ? "PARITY" : "**MISMATCH**"} |\n`; });
md += `\n`;

const coreMis = coreResults.filter((r) => !r.parity);
if (coreMis.length) {
  md += `### Core mismatches (would be PORT BUGS)\n\n`;
  for (const r of coreMis) {
    md += `#### ${r.name}\n- argv: \`${JSON.stringify(r.argv)}\`\n- exit: bash=${r.bash.status} ts=${r.ts.status}\n\n\`\`\`\n${diffBlock(r)}\n\`\`\`\n\n`;
  }
}

md += `## Deviation probes (${devResults.length})\n\nDivergences that are expected & documented. \`ok\` = observed behavior matches the documented shape.\n\n| # | scenario | classification | ok |\n|---|---|---|---|\n`;
devResults.forEach((r, i) => { md += `| ${i + 1} | ${r.name} | ${r.kind} | ${r.ok ? "yes" : "**NO**"} |\n`; });
md += `\n### Deviation detail (exact diffs)\n\n`;
for (const r of devResults) {
  md += `#### ${r.name} — ${r.kind}\n- argv: \`${JSON.stringify(r.argv)}\`\n- exit: bash=${r.bash.status} ts=${r.ts.status}\n- documented-shape match: ${r.ok ? "yes" : "**NO — regression**"}\n\n\`\`\`\n`;
  md += `    bash.stdout: ${JSON.stringify(trunc(r.bash.stdout, 240))}\n`;
  md += `    ts.stdout  : ${JSON.stringify(trunc(r.ts.stdout, 240))}\n`;
  md += `    bash.stderr: ${JSON.stringify(trunc(r.bash.stderr, 240))}\n`;
  md += `    ts.stderr  : ${JSON.stringify(trunc(r.ts.stderr, 240))}\n`;
  md += `\`\`\`\n\n`;
}

md += `## Verdict\n\n`;
md += `### Real port bug (undocumented): U+007F (DEL) not escaped\n\n`;
md += `**jq escapes U+007F as \`\\u007f\`; Node \`JSON.stringify\` emits the raw 0x7f byte.** Confirmed by an exhaustive codepoint scan (0x01..0x2FFFF) as the *only* escaping divergence between the two serializers — every C0 control (0x00..0x1f) escapes identically and every char >= 0x80 is emitted literally by both. It surfaces at BOTH JSON-emitting call sites: the final \`JSON.stringify(mergeRoles(msgs), null, 2)\` (scenario \`control-char-del-0x7f\`) and \`ppValue\` for object/array content fields (\`del-0x7f-in-object-field\`).\n\n`;
md += `Reachable: step \`content\`/\`stdout\`/\`stderr\` come from real shell output, which can contain a 0x7f byte. When it does, the port's output differs byte-for-byte from Bash. Severity is LOW — both encodings are valid JSON for the *same* string, so any JSON parser (\`llm -M\`) yields identical messages; only the byte-exact "identical to jq" claim breaks. But it is a genuine port bug, not a documented deviation.\n\n`;
md += `**Minimal fix** (in \`src/context.ts\`; do not rely on \`JSON.stringify\` alone): route every final/pp serialization through a jq-faithful helper that also escapes 0x7f, e.g.\n\n`;
md += "```ts\n";
md += `const jqJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/\\x7f/g, "\\\\u007f");\n`;
md += `// use in ppValue() AND at the renderMsgs() \`JSON.stringify(mergeRoles(msgs), null, 2)\`\n`;
md += "```\n";
md += `Both sites are required: an object/array content field serializes through two levels (\`ppValue\` produces the field string, then the messages array re-serializes it), and jq escapes 0x7f at each level (inner \`x\\u007fy\` → outer \`x\\\\u007fy\`). Verified: with the helper at both sites, the port reproduces jq byte-for-byte on the plain-string path and the nested object-field path; it is a no-op on all 103 currently-passing scenarios. Applying it inside \`renderMsgs\` also fixes \`--max-bytes\` accounting (Bash counts the 6-byte \`\\u007f\`, so the port must too). 0x7f is the sole divergent codepoint, so this is the complete fix.\n\n`;
md += `### Divergences that are NOT port bugs (degenerate / malformed / platform inputs)\n\n`;
md += `1. **\`\${2:?}\` stderr wording** (missing/empty required flag value) — deliberate documented deviation; exit(1)+empty stdout+state match.\n`;
md += `2. **Non-object JSONL line** (number/array/string/bool) — Bash aborts (jq \`.step_id\` error, exit 5), port drops the line and continues; documented deviation #3; real lines are always objects.\n`;
md += `3. **Multi-dir hex-prefix tie-break** — \`find|head -1\` vs DFS; documented deviation #2; filesystem-order dependent on both sides; real dirs hold a single \`<hex8>-root\`.\n`;
md += `4. **\`--max-bytes 0\`** — BSD \`head -c 0\` errors (macOS, exit 1); GNU head is SIGPIPE-timing-dependent under \`pipefail\`; the port is deterministic (empty + budget marker + exit 0). Platform/shell artifact on a degenerate input (no caller passes 0), harmless on the Linux target.\n`;
md += `5. **\`step_id: false\`** — jq \`//\` drops it, port \`??\` keeps it; undocumented micro-gap on an absurd value step_id never takes. (Same \`//\`-vs-\`??\` root as any \`false\`-valued \`type\`/\`step_id\`; content \`from_branch\` correctly uses \`//\` semantics.)\n`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(
  path.join(HERE, "results.json"),
  JSON.stringify(
    {
      bash: scrubPaths(BASH),
      core: { total: coreResults.length, parity: coreParity },
      deviations: { total: devResults.length, matchingDocumentedShape: devResults.length - devUnexpected.length },
      exitOk,
      results: all.map((r) => ({
        group: r.group,
        name: r.name,
        kind: r.kind,
        argv: r.argv,
        parity: r.parity,
        ok: r.ok,
        cmp: r.cmp,
        bash: { stdout: r.bash.stdout, stderr: r.bash.stderr, status: r.bash.status },
        ts: { stdout: r.ts.stdout, stderr: r.ts.stderr, status: r.ts.status },
      })),
    },
    null,
    2
  )
);

// --- console -----------------------------------------------------------------
console.log(`context parity — core: ${coreParity}/${coreResults.length} byte-exact; deviation probes: ${devResults.length - devUnexpected.length}/${devResults.length} match documented shape`);
for (const r of coreFail) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
  console.log(`  CORE MISMATCH ${r.name} [${diffs}] bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
}
for (const r of devUnexpected) {
  console.log(`  DEVIATION REGRESSION ${r.name} (${r.kind}) — documented shape no longer holds`);
}
console.log(exitOk ? "OK: all core PARITY, all deviations as documented." : "FAIL: see above.");
process.exit(exitOk ? 0 : 1);
