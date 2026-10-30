#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the `skills` subsystem.
//
// Runs the REAL Bash tool (headlong/bin/skills) and the TS port
// (headlong-ts/bin/skills.mjs) on identical inputs in isolated scratch
// sandboxes, then diffs stdout + stderr + exit code + on-disk state.
// One scenario per subcommand / flag / error path, harvested from the Bash
// source, PLUS targeted quirk-probes where a transliteration bug is likely.
//
// No Headlong identity is needed: `skills` is driven entirely by cwd-relative
// dirs (.skills, kernel, remotesrc) + env vars (SKILLS_*) + ./.skillsrc. Each
// run happens in a fresh temp sandbox with HOME pinned INTO the sandbox, so the
// live pax identity and ~/.skills-remotes are never touched.
//
// DETERMINISM
//  - Bash runs under en_US.UTF-8 so its char-based `${#s}`/`${s:0:57}` match the
//    port's char-based truncation (the port pairs char-truncation with BYTE
//    padding — a documented Headlong quirk).
//  - Network paths are neutralized: `curl` (GitHub search fallback) and `git`
//    (remote clone) are STUBBED on PATH identically for both tools, so those
//    code paths are exercised deterministically and diffed byte-for-byte.
//  - All skill sources/remotes are seeded at RELATIVE paths inside each sandbox,
//    so no absolute temp path leaks into output. As a belt-and-suspenders guard,
//    each side's own sandbox path (and its realpath) is normalized to <SB>
//    symmetrically before comparison. No other normalization — bytes are exact.
//
// Some scenarios are EXPECTED to diverge (marked `expect:"deviation"`): they
// probe places the port deliberately or accidentally differs from the Bash.
// The report separates genuine parity from those, and flags suspected PORT BUGS.
//
// Repeatable: `. ~/.nvm/nvm.sh && nvm use 24.19.0 && node parity/skills/run-parity.mjs`
// Writes results.json + report.md beside this file. Exit 0 iff every scenario
// that is NOT an expected-deviation reaches PARITY.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");                       // headlong-ts
// Scrubbed to a placeholder for release; set PARITY_BASH_SKILLS=/abs/path/to/
// headlong/bin/skills (or PARITY_UPSTREAM_ROOT=/abs/path/to/headlong, from
// which both bin/skills and tools/headlong-skills are derived) to reproduce.
const UPSTREAM_ROOT = process.env.PARITY_UPSTREAM_ROOT;
const BASH_SKILLS =
  process.env.PARITY_BASH_SKILLS || (UPSTREAM_ROOT ? path.join(UPSTREAM_ROOT, "bin/skills") : "<HEADLONG_ROOT>/bin/skills");
const TS_SKILLS = path.join(REPO, "bin", "skills.mjs");
// PORT-NOTE (1c: 8c3f410): the manager, both sides. `skills <manager
// subcommand>` FORWARDS to these transparently (bin/skills's `_forward()` /
// skills.ts's `forwardToManager()`), so most existing scenarios below never
// need to name either of these directly — they drive the split through its
// public entrypoint (BASH_SKILLS/TS_SKILLS) exactly as the mind does, and the
// forwarding contract is proven implicitly by every install/search/check/
// init/remove/promote/kernel/remote scenario still reaching PARITY. The
// `bin: "headlong-skills"` scenarios below additionally drive the manager
// AS THE ENTRYPOINT (not via forwarding) — tests/test_skills_split.sh's
// "manager list works" / "manager help advertises install".
const BASH_HEADLONG_SKILLS =
  process.env.PARITY_BASH_HEADLONG_SKILLS ||
  (UPSTREAM_ROOT ? path.join(UPSTREAM_ROOT, "tools/headlong-skills") : "<HEADLONG_ROOT>/tools/headlong-skills");
const TS_HEADLONG_SKILLS = path.join(REPO, "bin", "headlong-skills.mjs");

// --- fake `curl` + `git` on PATH ---------------------------------------------
// curl: the GitHub-search fallback. Return a fixed items JSON so that path is
// deterministic (and its formatting can be diffed). git: any clone → fail fast,
// so the remote-clone-failure quirk is exercised without network.
const FAKEBIN = fs.mkdtempSync(path.join(os.tmpdir(), "skills-parity-bin-"));
fs.writeFileSync(
  path.join(FAKEBIN, "curl"),
  `#!/usr/bin/env bash
# Deterministic stub for the real \`curl\` (GitHub search fallback).
cat <<'JSON'
{"items":[{"full_name":"owner/repo-one","description":"a github skill","stargazers_count":42,"html_url":"https://github.com/owner/repo-one"},{"full_name":"owner/repo-two","description":null,"stargazers_count":7,"html_url":"https://github.com/owner/repo-two"}]}
JSON
`,
);
fs.chmodSync(path.join(FAKEBIN, "curl"), 0o755);
fs.writeFileSync(
  path.join(FAKEBIN, "git"),
  `#!/usr/bin/env bash
# Deterministic stub for the real \`git\`: any invocation fails immediately,
# simulating an unreachable clone target so set -e abort semantics are testable.
echo "git-stub: refusing (parity harness)" >&2
exit 1
`,
);
fs.chmodSync(path.join(FAKEBIN, "git"), 0o755);

// --- normalization (symmetric, sandbox-path only) -----------------------------
function normalizer(sb) {
  let real = sb;
  try { real = fs.realpathSync(sb); } catch { /* keep */ }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reSb = new RegExp(esc(sb), "g");
  const reReal = new RegExp(esc(real), "g");
  return (s) => (s == null ? s : s.replace(reReal, "<SB>").replace(reSb, "<SB>"));
}

// --- on-disk state serialization ---------------------------------------------
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
    if (e.isDirectory()) {
      // record empty dirs too (they matter: e.g. ~/.skills-remotes, scaffolded subdirs)
      const before = acc.length;
      walk(full, rel, acc);
      if (acc.length === before) acc.push({ rel: rel + "/", content: "<dir>" });
    } else {
      let content;
      try { content = fs.readFileSync(full, "utf8"); } catch { content = "<unreadable>"; }
      acc.push({ rel, content });
    }
  }
}
function serializeState(sb) {
  const acc = [];
  walk(sb, "", acc);
  if (acc.length === 0) return "<empty>";
  return acc.map((f) => `FILE ${f.rel}\n${f.content}`).join("\n----\n");
}

// --- sandbox seeding ----------------------------------------------------------
function makeSandbox(sc) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "skills-parity-sb-"));
  // Always create .skills so a bare `list` on an "empty store" is the same shape.
  fs.mkdirSync(path.join(sb, ".skills"), { recursive: true });
  if (sc.skillsrc != null) fs.writeFileSync(path.join(sb, ".skillsrc"), sc.skillsrc);
  for (const f of sc.files ?? []) {
    const abs = path.join(sb, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  for (const d of sc.dirs ?? []) fs.mkdirSync(path.join(sb, d), { recursive: true });
  return sb;
}

function runTool(kind, sc, sb) {
  const env = { ...process.env };
  // Clear any inherited SKILLS_* / requirement probe vars for a clean baseline.
  for (const k of Object.keys(env)) if (k.startsWith("SKILLS_")) delete env[k];
  delete env.SKILLSRC;
  delete env.NO_COLOR;
  delete env.MISSING_ENV_XYZ;
  delete env.PRESENT_ENV_XYZ;
  env.LANG = "en_US.UTF-8";
  env.LC_ALL = "en_US.UTF-8";                        // char-based bash string ops
  env.NO_COLOR = "1";                                // deterministic (also non-TTY)
  env.HOME = sb;                                     // ~/.skills-remotes stays in sandbox
  env.PATH = `${FAKEBIN}:${env.PATH}`;               // stubbed curl/git win
  Object.assign(env, sc.env || {});

  const useManager = sc.bin === "headlong-skills";
  const bashBin = useManager ? BASH_HEADLONG_SKILLS : BASH_SKILLS;
  const tsBin = useManager ? TS_HEADLONG_SKILLS : TS_SKILLS;
  const argv = kind === "bash" ? sc.argv : [tsBin, ...sc.argv];
  const cmd = kind === "bash" ? bashBin : "node";

  const res = spawnSync(cmd, argv, {
    cwd: sb,
    env,
    input: sc.stdin ?? "",
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

// --- SKILL.md fixture helpers -------------------------------------------------
const md = (name, desc, body = "") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n${body ? "\n" + body + "\n" : ""}`;
const mdReq = (name, desc, reqYaml) =>
  `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  shelllm:\n${reqYaml}\n---\n\n# ${name}\n`;

// requirement blocks (inline-JSON arrays, the only form the tool parses)
const reqEnv = (v) => `    requires:\n      env: [${JSON.stringify(v).slice(1, -1)}]`;
const reqBins = (v) => `    requires:\n      bins: [${v.map((x) => `"${x}"`).join(", ")}]`;

// --- scenarios ----------------------------------------------------------------
// expect: "deviation" marks scenarios where a divergence is anticipated (bash
// quirk the port cleans up, or a suspected port bug). `bug:true` flags a
// suspected genuine port defect (translator lane must fix or justify).
const scenarios = [
  // ================= GLOBAL / dispatch =================
  { group: "global", name: "version", argv: ["--version"] },
  { group: "global", name: "help-short", argv: ["-h"] },
  { group: "global", name: "help-long", argv: ["--help"] },
  { group: "global", name: "no-args-empty-store", argv: [] },
  { group: "global", name: "unknown-option", argv: ["--bogus"] },
  {
    group: "global", name: "dir-missing-value", argv: ["--dir"],
    expect: "deviation",
    note: "DELIBERATE DEVIATION (resolved). The flag-parse loop is now wrapped in a try that routes req()'s SkillsError through fail(): clean `skills: error: --dir requires a path`, rc 1, empty stdout, on-disk state unchanged. Matches Bash on exit code + stdout + state; DEVIATES only on stderr wording — Bash's `${2:?}` shell-builtin prints `bin/skills: line N: 2: --dir requires a path` with an absolute script path + Bash line number, which is brittle and irreproducible from TS and worse than the port's uniform error form. Prior port defect (uncaught Node stack trace from the flag loop, outside the dispatch try) is fixed. Documented in PARITY.md. Affects all req()-guarded flags: --dir/--remotes/--format/--name/--description.",
  },
  {
    group: "global", name: "format-missing-value", argv: ["--format"],
    expect: "deviation",
    note: "Same DELIBERATE DEVIATION (resolved) as dir-missing-value: `--format` with no value → clean `skills: error: --format requires a value` (rc 1, empty stdout, state unchanged); deviates only on stderr wording vs Bash's `${2:?}` builtin text. Documented in PARITY.md.",
  },

  // ---- M1: empty-string required flag values (bash ${2:?} dies on empty) ----
  {
    group: "empty-required", name: "dir-empty-value", argv: ["--dir", "", "list"],
    expect: "deviation",
    note: "M1: `--dir ''` — Bash `${2:?}` fires on EMPTY too. Port's req() now rejects '' (was silently accepted). Both rc 1, empty stdout, state unchanged; deviates only on stderr wording.",
  },
  {
    group: "empty-required", name: "format-empty-value", argv: ["--format", "", "list"],
    expect: "deviation",
    note: "M1: `--format ''` — both rc 1, empty stdout, state unchanged; stderr wording only.",
  },
  {
    group: "empty-required", name: "remotes-empty-value", argv: ["--remotes", "", "list"],
    expect: "deviation",
    note: "M1: `--remotes ''` — both rc 1, empty stdout, state unchanged; stderr wording only.",
  },
  {
    group: "empty-required", name: "init-name-desc-empty", argv: ["init", "--name", "n", "--description", ""],
    expect: "deviation",
    note: "M1: `init --name n --description ''` — Bash dies rc 1 (no scaffold); port now dies rc 1 (no scaffold). Same on-disk state; stderr wording only.",
  },
  {
    group: "empty-required", name: "init-desc-empty", argv: ["init", "myskill", "--description", ""],
    expect: "deviation",
    note: "M1: `init myskill --description ''` — Bash dies rc 1 (no scaffold); port now dies rc 1 (no scaffold). Same on-disk state; stderr wording only.",
  },

  // ================= LIST =================
  { group: "list", name: "basic-eligible", argv: ["list"], files: [{ path: ".skills/aa/SKILL.md", content: md("aa", "short desc") }] },
  {
    group: "list", name: "multiple-sorted", argv: ["list"],
    files: [
      { path: ".skills/bb/SKILL.md", content: md("bb", "bee") },
      { path: ".skills/aa/SKILL.md", content: md("aa", "ay") },
    ],
  },
  { group: "list", name: "desc-truncate-61", argv: ["list"], files: [{ path: ".skills/t/SKILL.md", content: md("t", "x".repeat(61)) }] },
  { group: "list", name: "desc-emdash-bytepad", argv: ["list"], files: [{ path: ".skills/e/SKILL.md", content: md("e", "a—b") }] },
  { group: "list", name: "desc-multibyte-boundary", argv: ["list"], files: [{ path: ".skills/m/SKILL.md", content: md("m", "café señor 日本語 memo about things and stuff and more zzz") }] },
  {
    group: "list", name: "name-fallback-basename", argv: ["list"],
    files: [{ path: ".skills/nn/SKILL.md", content: `---\ndescription: no name field\n---\n\n# body\n` }],
    expect: "deviation",
    note: "REAL BASH CRASHES: `name=$(frontmatter_field …)` runs a `grep '^name:'` that finds nothing → exits 1 under `set -o pipefail`; `var=$(failing)` trips `set -e` → the whole subcommand aborts (rc=1, truncated output). The bash's own `[[ -z \"$name\" ]] && name=$(basename …)` fallback is DEAD CODE. The port's `frontmatterField()||base` reaches the intended basename fallback and lists the skill. Broad: affects list/list-json/prompt/search/install on any name-less skill.",
  },
  {
    group: "list", name: "description-missing-crash", argv: ["list"],
    files: [{ path: ".skills/nd/SKILL.md", content: `---\nname: nd\n---\n\n# body\n` }],
    expect: "deviation",
    note: "Same set-e crash for a MISSING `description:` field (`desc=$(grep '^description:')` fails). Real bash aborts rc=1; port renders an empty description.",
  },
  { group: "list", name: "empty-desc", argv: ["list"], files: [{ path: ".skills/d/SKILL.md", content: `---\nname: d\ndescription:\n---\n\n# d\n` }] },
  {
    group: "list", name: "ineligible-skipped-footer", argv: ["list"],
    files: [
      { path: ".skills/ok/SKILL.md", content: md("ok", "fine") },
      { path: ".skills/bad/SKILL.md", content: mdReq("bad", "needs env", reqEnv(["MISSING_ENV_XYZ"])) },
    ],
  },
  {
    group: "list", name: "all-inline-ineligible", argv: ["list", "--all"],
    files: [
      { path: ".skills/ok/SKILL.md", content: md("ok", "fine") },
      { path: ".skills/bad/SKILL.md", content: mdReq("bad", "needs env", reqEnv(["MISSING_ENV_XYZ"])) },
    ],
  },
  {
    group: "list", name: "format-prompt-eq", argv: ["list", "--format=prompt"],
    files: [
      { path: ".skills/ok/SKILL.md", content: md("ok", "fine") },
      { path: ".skills/bad/SKILL.md", content: mdReq("bad", "needs env", reqEnv(["MISSING_ENV_XYZ"])) },
    ],
  },
  {
    group: "list", name: "format-prompt-space", argv: ["list", "--format", "prompt"],
    files: [{ path: ".skills/ok/SKILL.md", content: md("ok", "fine") }],
  },
  {
    group: "list", name: "conflict-dedup-warn", argv: ["list"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    files: [
      { path: ".skills/a/SKILL.md", content: md("shared", "from project") },
      { path: "kernel/b/SKILL.md", content: md("shared", "from kernel") },
    ],
  },
  {
    group: "list", name: "remotes-available-filtered", argv: ["list"],
    env: { SKILLS_REMOTES: "./remotesrc" },
    files: [
      { path: ".skills/dup/SKILL.md", content: md("dup", "installed already") },
      { path: "remotesrc/dup/SKILL.md", content: md("dup", "remote dup") },
      { path: "remotesrc/fresh/SKILL.md", content: md("fresh", "available remote") },
    ],
  },
  {
    group: "list", name: "dir-flag-local-label", argv: ["--dir", "./mylib", "list"],
    files: [{ path: "mylib/z/SKILL.md", content: md("z", "in mylib") }],
  },
  { group: "list", name: "requirement-bins-met", argv: ["list"], files: [{ path: ".skills/j/SKILL.md", content: mdReq("j", "needs jq", reqBins(["jq"])) }] },

  // ================= LIST-JSON =================
  {
    group: "list-json", name: "two-skills-comma-boundary", argv: ["list-json"],
    files: [
      { path: ".skills/one/SKILL.md", content: md("one", "first", "body one") },
      { path: ".skills/two/SKILL.md", content: md("two", "second", "body two") },
    ],
  },
  { group: "list-json", name: "empty", argv: ["list-json"] },
  {
    group: "list-json", name: "special-chars-escaping", argv: ["list-json"],
    files: [{ path: ".skills/s/SKILL.md", content: `---\nname: s\ndescription: has "quote" and — dash\n---\n\nline1\twith tab\nquote " and \\ backslash — em\n` }],
  },

  // ================= SEARCH =================
  {
    group: "search", name: "local-match-bare-query", argv: ["needle"],
    env: { SKILLS_REMOTES: "./remotesrc" },
    files: [
      { path: ".skills/needle/SKILL.md", content: md("needle", "findable thing") },
      { path: "remotesrc/other/SKILL.md", content: md("other", "unrelated remote") },
    ],
    note: "Bare query dispatches to search; local Installed match. Remote configured (non-matching) so the Available section is deterministic and does NOT hit the GitHub fallback (isolates local-match from the ★-stars bug).",
  },
  {
    group: "search", name: "no-local-match-with-remote", argv: ["zzznope"],
    env: { SKILLS_REMOTES: "./remotesrc" },
    files: [
      { path: ".skills/needle/SKILL.md", content: md("needle", "findable thing") },
      { path: "remotesrc/rem/SKILL.md", content: md("rem", "a remote one") },
    ],
  },
  {
    group: "search", name: "remote-match", argv: ["remote"],
    env: { SKILLS_REMOTES: "./remotesrc" },
    files: [{ path: "remotesrc/remoteskill/SKILL.md", content: md("remoteskill", "a remote thing") }],
    note: "'remote' is a subcommand, so this must go through bare-query search NOT dispatch — probes query==subcommand-name. (Actually dispatches to remote list.)",
  },
  {
    group: "search", name: "regex-metachar-grep-vs-includes", argv: ["b.r"],
    env: { SKILLS_REMOTES: "./remotesrc" },
    files: [{ path: ".skills/bar/SKILL.md", content: md("bar", "a bar skill") }],
    note: "FIXED (parity fix): bash `grep -qi \"$query\"` treats the query as a REGEX; the port now uses a case-insensitive RegExp (grepMatch) instead of String.includes. 'b.r' matches 'bar' — now byte-identical. Kept as a hard-parity scenario so a regression re-fails the oracle.",
  },
  {
    group: "search", name: "github-fallback-stubbed-curl", argv: ["anything"],
    note: "FIXED (parity fix): GitHub fallback now prints stars as '★ N' (searchGitHub restored the '★ ' prefix, matching bin/skills:695,698). Now byte-identical; kept as a hard-parity guard.",
  },
  { group: "search", name: "no-query", argv: ["search"] },

  // ================= SHOW =================
  { group: "show", name: "plain-body", argv: ["show", "sk"], files: [{ path: ".skills/sk/SKILL.md", content: md("sk", "a skill", "Do the thing.") }] },
  {
    group: "show", name: "eval-block", argv: ["show", "ev"],
    files: [{ path: ".skills/ev/SKILL.md", content: `---\nname: ev\ndescription: evals\n---\n\nBefore.\n\n\`\`\`bash\n#| eval: true\necho ran-at-render\n\`\`\`\n\nAfter.\n` }],
  },
  {
    group: "show", name: "eval-echo-source", argv: ["show", "ev"],
    files: [{ path: ".skills/ev/SKILL.md", content: `---\nname: ev\ndescription: evals\n---\n\n\`\`\`bash\n#| eval: true\n#| echo: true\necho shown\n\`\`\`\n` }],
  },
  {
    group: "show", name: "eval-stdout-false", argv: ["show", "ev"],
    files: [{ path: ".skills/ev/SKILL.md", content: `---\nname: ev\ndescription: evals\n---\n\n\`\`\`bash\n#| eval: true\n#| stdout: false\necho nope\n\`\`\`\n` }],
  },
  {
    group: "show", name: "eval-stderr-capture", argv: ["show", "ev"],
    files: [{ path: ".skills/ev/SKILL.md", content: `---\nname: ev\ndescription: evals\n---\n\n\`\`\`bash\n#| eval: true\necho out; echo err 1>&2\n\`\`\`\n` }],
  },
  {
    group: "show", name: "plain-bash-block-untouched", argv: ["show", "pb"],
    files: [{ path: ".skills/pb/SKILL.md", content: `---\nname: pb\ndescription: plain\n---\n\n\`\`\`bash\nls -la\n\`\`\`\n` }],
  },
  { group: "show", name: "requires-json", argv: ["show", "r", "--requires"], files: [{ path: ".skills/r/SKILL.md", content: mdReq("r", "needs", reqBins(["curl", "jq"])) }] },
  { group: "show", name: "requires-inline-json", argv: ["show", "r", "--requires"], files: [{ path: ".skills/r/SKILL.md", content: `---\nname: r\ndescription: d\nmetadata: {"shelllm": {"requires": {"anyBins": ["gh","hub"]}}}\n---\n\n#r\n` }] },
  { group: "show", name: "requires-none", argv: ["show", "n", "--requires"], files: [{ path: ".skills/n/SKILL.md", content: md("n", "no reqs") }] },
  { group: "show", name: "not-found", argv: ["show", "ghost"], files: [{ path: ".skills/sk/SKILL.md", content: md("sk", "x") }] },
  { group: "show", name: "no-arg", argv: ["show"] },
  { group: "show", name: "find-by-frontmatter-name", argv: ["show", "realname"], files: [{ path: ".skills/dirname/SKILL.md", content: md("realname", "found via frontmatter name") }] },

  // ================= CHECK =================
  { group: "check", name: "none", argv: ["check", "n"], files: [{ path: ".skills/n/SKILL.md", content: md("n", "no reqs") }] },
  { group: "check", name: "unmet-env", argv: ["check", "x"], files: [{ path: ".skills/x/SKILL.md", content: mdReq("x", "d", reqEnv(["MISSING_ENV_XYZ"])) }] },
  {
    group: "check", name: "mixed-all-met", argv: ["check", "x"],
    env: { PRESENT_ENV_XYZ: "1" },
    files: [{ path: ".skills/x/SKILL.md", content: `---\nname: x\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["PRESENT_ENV_XYZ"]\n      bins: ["jq"]\n      anyBins: ["jq", "nonexistent_bin_xyz"]\n      os: ["darwin", "linux"]\n---\n\n#x\n` }],
  },
  { group: "check", name: "not-found", argv: ["check", "ghost"] },

  // ================= INIT =================
  { group: "init", name: "flags-name-desc", argv: ["init", "newskill", "--description", "does things"] },
  { group: "init", name: "project-flag", argv: ["init", "proj", "--description", "p", "--project"] },
  { group: "init", name: "refuses-existing", argv: ["init", "dup"], files: [{ path: ".skills/dup/SKILL.md", content: md("dup", "x") }] },
  {
    group: "init", name: "stdin-name-no-flag", argv: ["init"], stdin: "fromstdin\nvia stdin desc\n",
    note: "FIXED (parity fix): bash only reads name/desc from stdin when `-t 0` (a TTY); piped stdin is IGNORED → bash dies 'Name is required'. actionInit no longer consumes ctx.stdin, so a name-less non-interactive init dies 'Name is required' — now byte-identical on stdout/stderr/exit/on-disk. Kept as a hard-parity guard.",
  },
  { group: "init", name: "no-name-empty-stdin", argv: ["init"], stdin: "" },

  // ================= INSTALL (local path only; no network) =================
  { group: "install", name: "local-basic", argv: ["install", "./srcpkg"], files: [{ path: "srcpkg/SKILL.md", content: md("installed", "an installed one", "body") }] },
  {
    group: "install", name: "already-installed", argv: ["install", "./srcpkg"],
    files: [
      { path: "srcpkg/SKILL.md", content: md("installed", "one") },
      { path: ".skills/installed/SKILL.md", content: md("installed", "one") },
    ],
  },
  { group: "install", name: "no-skillmd", argv: ["install", "./emptysrc"], dirs: ["emptysrc"] },
  { group: "install", name: "env-req-empty-var-quirk", argv: ["install", "./srcpkg"], files: [{ path: "srcpkg/SKILL.md", content: mdReq("withenv", "needs env", reqEnv(["TOKEN_A"])) }] },
  { group: "install", name: "bins-req", argv: ["install", "./srcpkg"], files: [{ path: "srcpkg/SKILL.md", content: mdReq("withbins", "needs bins", reqBins(["jq", "nonexistent_bin_xyz"])) }] },
  { group: "install", name: "invalid-source-no-remotes", argv: ["install", "not a real source"] },
  { group: "install", name: "project-flag", argv: ["install", "./srcpkg", "--project"], files: [{ path: "srcpkg/SKILL.md", content: md("pk", "proj install") }] },

  // ================= REMOVE =================
  { group: "remove", name: "force", argv: ["remove", "gone", "--force"], files: [{ path: ".skills/gone/SKILL.md", content: md("gone", "x") }] },
  { group: "remove", name: "stdin-yes", argv: ["remove", "gone"], stdin: "y\n", files: [{ path: ".skills/gone/SKILL.md", content: md("gone", "x") }] },
  { group: "remove", name: "stdin-no-cancel", argv: ["remove", "gone"], stdin: "n\n", files: [{ path: ".skills/gone/SKILL.md", content: md("gone", "x") }] },
  {
    group: "remove", name: "empty-stdin-cancel", argv: ["remove", "gone"], stdin: "",
    files: [{ path: ".skills/gone/SKILL.md", content: md("gone", "x") }],
    expect: "deviation",
    note: "REAL BASH CRASHES: with empty/EOF stdin, `read -r reply` returns non-zero → `set -e` aborts (rc=1) BEFORE the `|| { echo Cancelled; }` runs, so no 'Cancelled.' and the skill is NOT removed. The port treats EOF as an empty (non-Y) reply → prints 'Cancelled.' rc=0. Same on-disk result (kept), but stderr+exit diverge.",
  },
  { group: "remove", name: "not-found", argv: ["remove", "ghost"] },
  { group: "remove", name: "no-arg", argv: ["remove"] },

  // ================= PROMOTE =================
  { group: "promote", name: "no-kernel-configured", argv: ["promote", "x"], files: [{ path: ".skills/x/SKILL.md", content: md("x", "y") }] },
  {
    group: "promote", name: "basic", argv: ["promote", "x"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    dirs: ["kernel"],
    files: [{ path: ".skills/x/SKILL.md", content: md("x", "to promote") }],
  },
  {
    group: "promote", name: "already-in-kernel", argv: ["promote", "x"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    files: [{ path: "kernel/x/SKILL.md", content: md("x", "already") }],
  },
  {
    group: "promote", name: "not-in-skills", argv: ["promote", "ghost"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    dirs: ["kernel"],
  },

  // ================= KERNEL =================
  { group: "kernel", name: "no-dir-configured", argv: ["kernel"] },
  {
    group: "kernel", name: "with-skills", argv: ["kernel"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    files: [{ path: "kernel/k1/SKILL.md", content: md("k1", "kernel one", "some body text here") }],
  },
  { group: "kernel", name: "empty-dir", argv: ["kernel"], env: { SKILLS_KERNEL_DIR: "./kernel" }, dirs: ["kernel"] },
  {
    group: "kernel", name: "exceeds-budget", argv: ["kernel"],
    env: { SKILLS_KERNEL_DIR: "./kernel", SKILLS_KERNEL_TOKEN_BUDGET: "1" },
    files: [{ path: "kernel/k1/SKILL.md", content: md("k1", "kernel one", "padding ".repeat(20)) }],
  },

  // ================= REMOTE =================
  { group: "remote", name: "list-none", argv: ["remote"] },
  { group: "remote", name: "add-local-writes-skillsrc", argv: ["remote", "add", "/local/one"] },
  {
    group: "remote", name: "add-duplicate", argv: ["remote", "add", "/local/one"],
    skillsrc: 'SKILLS_REMOTES="/local/one"\n',
  },
  {
    group: "remote", name: "list-git-and-local-labels", argv: ["remote"],
    skillsrc: 'SKILLS_REMOTES="https://github.com/foo/bar, /local/two"\n',
  },
  {
    group: "remote", name: "remove-entry", argv: ["remote", "remove", "/a"],
    skillsrc: 'SKILLS_REMOTES="/a, /b"\n',
  },
  { group: "remote", name: "remove-not-found", argv: ["remote", "remove", "/nope"], skillsrc: 'SKILLS_REMOTES="/a"\n' },
  { group: "remote", name: "unknown-subcommand", argv: ["remote", "frobnicate"] },
  {
    group: "remote", name: "add-git-clone-fails", argv: ["remote", "add", "https://github.com/foo/bar.git"],
    note: "stubbed git fails → set -e aborts before 'Added remote'; .skillsrc still written first.",
  },

  // ================= PROMPT =================
  { group: "prompt", name: "basic", argv: ["prompt"], files: [{ path: ".skills/foo/SKILL.md", content: md("foo", "a foo skill") }] },
  { group: "prompt", name: "empty-no-skills", argv: ["prompt"] },
  {
    group: "prompt", name: "multi-range-summary-quirk", argv: ["prompt"],
    files: [{ path: ".skills/author/SKILL.md", content: `---\nname: author\ndescription: authoring\n---\n\n# author\n\nExample:\n\n---\nname: example-child\ndescription: a child\n---\n\ndone\n` }],
  },
  {
    group: "prompt", name: "with-kernel-body", argv: ["prompt"],
    env: { SKILLS_KERNEL_DIR: "./kernel" },
    files: [
      { path: "kernel/kk/SKILL.md", content: md("kk", "kernel skill", "Kernel instructions body.") },
      { path: ".skills/foo/SKILL.md", content: md("foo", "a foo skill") },
    ],
  },

  // ================= SPLIT (1c: 8c3f410) — manager driven directly =================
  // Everything above already proves the FORWARDING contract (every install/
  // search/check/init/remove/promote/kernel/remote scenario reaches the
  // manager transparently through BASH_SKILLS/TS_SKILLS). These drive
  // tools/headlong-skills / bin/headlong-skills.mjs AS THE ENTRYPOINT, per
  // tests/test_skills_split.sh's "manager list works"/"manager help
  // advertises install".
  {
    group: "split", name: "manager-list-standalone", bin: "headlong-skills", argv: ["list"],
    files: [{ path: ".skills/greet/SKILL.md", content: md("greet", "Say hello politely") }],
  },
  { group: "split", name: "manager-help-advertises-install", bin: "headlong-skills", argv: ["--help"] },
  {
    group: "split", name: "manager-show-standalone", bin: "headlong-skills", argv: ["show", "greet"],
    files: [{ path: ".skills/greet/SKILL.md", content: md("greet", "Say hello politely", "Say hello.") }],
  },
  {
    group: "split", name: "manager-prompt-standalone", bin: "headlong-skills", argv: ["prompt"],
    files: [{ path: ".skills/greet/SKILL.md", content: md("greet", "Say hello politely") }],
  },
];

// --- execute ------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  const sbBash = makeSandbox(sc);
  const sbTs = makeSandbox(sc);
  let bash, ts;
  try {
    bash = runTool("bash", sc, sbBash);
    ts = runTool("ts", sc, sbTs);
  } finally {
    // keep nothing; clean up
  }
  const nB = normalizer(sbBash);
  const nT = normalizer(sbTs);
  const b = { stdout: nB(bash.stdout), stderr: nB(bash.stderr), state: nB(bash.state), status: bash.status };
  const t = { stdout: nT(ts.stdout), stderr: nT(ts.stderr), state: nT(ts.state), status: ts.status };
  fs.rmSync(sbBash, { recursive: true, force: true });
  fs.rmSync(sbTs, { recursive: true, force: true });

  const cmp = {
    stdout: b.stdout === t.stdout,
    stderr: b.stderr === t.stderr,
    status: b.status === t.status,
    state: b.state === t.state,
  };
  const identical = cmp.stdout && cmp.stderr && cmp.status && cmp.state;
  results.push({
    group: sc.group, name: sc.name, argv: sc.argv, note: sc.note,
    expect: sc.expect ?? "parity", bug: !!sc.bug,
    identical, cmp,
    bash: { ...b, raw: bash }, ts: { ...t, raw: ts },
  });
}

fs.rmSync(FAKEBIN, { recursive: true, force: true });

// --- report -------------------------------------------------------------------
const total = results.length;
const parity = results.filter((r) => r.identical);
const deviations = results.filter((r) => !r.identical && r.expect === "deviation");
const unexpected = results.filter((r) => !r.identical && r.expect !== "deviation");
const bugs = results.filter((r) => !r.identical && r.bug);
const rate = ((parity.length / total) * 100).toFixed(1);
// "effective" parity = identical OR a documented, anticipated deviation.
const effective = results.filter((r) => r.identical || r.expect === "deviation");
const effRate = ((effective.length / total) * 100).toFixed(1);

function block(label, a, bb, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(bb)}`;
}

let out = `# skills — differential parity proof\n\n`;
out += `Generated by \`parity/skills/run-parity.mjs\`. Real Bash tool \`headlong/bin/skills\` vs TS port \`headlong-ts/bin/skills.mjs\`, identical inputs, diffed stdout+stderr+exit code+on-disk state.\n\n`;
out += `- One-command run: \`. ~/.nvm/nvm.sh && nvm use 24.19.0 && node parity/skills/run-parity.mjs\` (Node 24).\n`;
out += `- Bash run under \`en_US.UTF-8\` so its char-based \`\${#s}\`/\`\${s:0:57}\` match the port's char-truncation (paired with byte-padding — a documented Headlong quirk).\n`;
out += `- \`curl\` (GitHub search fallback) and \`git\` (remote clone) STUBBED on PATH — identical for both tools — so network paths are exercised deterministically.\n`;
out += `- HOME pinned into each sandbox; skill sources/remotes seeded at relative paths. No absolute path leaks; each side's sandbox path normalized to \`<SB>\` symmetrically. All else byte-exact.\n\n`;
out += `## Result\n\n`;
out += `- **Byte-identical parity: ${parity.length}/${total} (${rate}%)**\n`;
out += `- Effective parity (identical + documented deviations): ${effective.length}/${total} (${effRate}%)\n`;
out += `- Suspected PORT BUGS / behavioral divergences (translator lane must fix/justify): ${bugs.length}\n`;
// Split the documented deviations into their two distinct classes:
//  - stderr-wording only: exit code + stdout + on-disk state all MATCH; only the
//    stderr text differs (Bash's `${2:?}` shell-builtin one-liner vs the port's
//    uniform `skills: error: …`). A misuse path no caller inspects.
//  - set -e crash smoothing: the real Bash aborts under set -e/pipefail (exit
//    diverges); the port reaches the fallback the surrounding code intended.
const devClean = deviations.filter((r) => !r.bug);
const devWording = devClean.filter((r) => r.cmp.status && r.cmp.stdout && r.cmp.state);
const devSetE = devClean.filter((r) => !(r.cmp.status && r.cmp.stdout && r.cmp.state));
out += `- Deliberate stderr-wording deviations (misuse paths; exit+stdout+state all match, only stderr text differs): ${devWording.length}\n`;
out += `- Robustness deviations (real bash \`set -e\` crashes the port smooths over): ${devSetE.length}\n`;
out += `- Unexpected mismatches: ${unexpected.filter((r) => !r.bug).length}\n\n`;

if (bugs.length) {
  out += `## Suspected port bugs\n\n`;
  for (const r of bugs) {
    out += `- **${r.group}/${r.name}** — ${r.note}\n`;
  }
  out += `\n`;
}

out += `## All scenarios\n\n`;
const byGroup = {};
for (const r of results) (byGroup[r.group] ??= []).push(r);
out += `| # | group | scenario | verdict | differs | class |\n|---|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ") || "-";
  const verdict = r.identical ? "PARITY" : (r.expect === "deviation" ? "DEVIATION" : "MISMATCH");
  const cls = r.bug ? "port-bug" : (r.expect === "deviation" ? "bash-quirk" : "-");
  out += `| ${idx++} | ${r.group} | ${r.name} | ${verdict} | ${diffs} | ${cls} |\n`;
}

out += `\n## Divergences (detail)\n\n`;
const nonIdentical = results.filter((r) => !r.identical);
if (nonIdentical.length === 0) out += `None — byte-identical across every scenario.\n`;
for (const r of nonIdentical) {
  out += `### ${r.group} / ${r.name} ${r.bug ? "— SUSPECTED PORT BUG" : "— bash-quirk deviation"}\n`;
  out += `- argv: \`${JSON.stringify(r.argv)}\`\n`;
  if (r.note) out += `- note: ${r.note}\n`;
  out += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  out += "```\n";
  out += block("stdout", r.bash.stdout, r.ts.stdout, r.cmp.stdout) + "\n";
  out += block("stderr", r.bash.stderr, r.ts.stderr, r.cmp.stderr) + "\n";
  out += block("state", r.bash.state, r.ts.state, r.cmp.state) + "\n";
  out += "```\n\n";
}

fs.writeFileSync(path.join(HERE, "report.md"), out);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, parity: parity.length, rate, effRate, results }, null, 2));

console.log(`skills parity: ${parity.length}/${total} byte-identical (${rate}%); effective ${effective.length}/${total} (${effRate}%)`);
for (const r of nonIdentical) {
  const diffs = Object.entries(r.cmp).filter(([, v]) => !v).map(([k]) => k).join(",");
  const tag = r.bug ? "PORT-BUG" : "deviation";
  console.log(`  ${r.identical ? "?" : "DIFF"} [${tag}] ${r.group}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}`);
}
// Exit 0 iff there are no UNEXPECTED mismatches (documented deviations are allowed).
const cleanFail = unexpected.length;
process.exit(cleanFail === 0 ? 0 : 1);
