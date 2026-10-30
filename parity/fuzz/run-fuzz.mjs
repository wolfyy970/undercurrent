#!/usr/bin/env node
// run-fuzz.mjs — L1 differential FUZZER (PROOF-CAMPAIGN.md layer L1). Runs
// every ported CLI tool and the real upstream Bash tool on generated inputs
// and compares raw bytes. This harness ONLY finds and classifies divergences
// — it never edits src/, bin/, or any existing parity/<tool> harness. Every
// divergence not covered by an EXISTING documented allowance (lib/allowances.mjs,
// each citing a PARITY.md row or another harness's own comment) is shrunk to a
// minimal reproducer and written to findings/<tool>-<n>.md for a fix lane.
//
// Usage:
//   node parity/fuzz/run-fuzz.mjs --tool glob --minutes 3 --seed 1
//   node parity/fuzz/run-fuzz.mjs --tool all --minutes 3 --seed 1
//   node parity/fuzz/run-fuzz.mjs --tool put,sub,mem --minutes 10 --seed 1
//   node parity/fuzz/run-fuzz.mjs --tool glob --count 500 --seed 1   (count instead of time)
//
// Env: PARITY_BASH_<TOOL> per tool (same convention as every existing
// parity/<tool>/run-parity.mjs), or HEADLONG_ROOT to derive every tool's
// default path at once (<HEADLONG_ROOT>/bin/<tool>, tools/identity,
// tools/headlong-killall, thinkers/retrieval/step).
//
// Writes parity/fuzz/results.json + report.md, and parity/fuzz/findings/*.md
// for every unclassified divergence. Exit 0 iff zero unclassified divergences
// across the whole run (documented-deviation and allowed hits do not fail it).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Rng } from "./lib/rng.mjs";
import { ddminArray } from "./lib/shrink.mjs";
import { resolveBash } from "./tools/common.mjs";
import { TOOLS, TOOL_NAMES } from "./tools/registry.mjs";
import { runConcurrencyLane, CONCURRENCY_TOOLS } from "./lib/concurrency.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FINDINGS_DIR = path.join(HERE, "findings");

// --- CLI args ------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { tool: "all", seed: 1, minutes: null, count: null, concurrency: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool") opts.tool = argv[++i];
    else if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--count") opts.count = Number(argv[++i]);
    else if (a === "--no-concurrency") opts.concurrency = false;
    else if (a === "--help" || a === "-h") {
      console.log("node run-fuzz.mjs --tool <name|all|a,b,c> [--minutes M | --count K] [--seed N] [--no-concurrency]");
      process.exit(0);
    }
  }
  if (opts.minutes == null && opts.count == null) opts.minutes = 3;
  return opts;
}
const opts = parseArgs(process.argv.slice(2));
const toolNames = opts.tool === "all" ? TOOL_NAMES : opts.tool.split(",").map((s) => s.trim());
for (const t of toolNames) {
  if (!TOOLS[t]) {
    console.error(`unknown tool: ${t} (known: ${TOOL_NAMES.join(", ")})`);
    process.exit(2);
  }
}

const HEADLONG_ROOT_HINT = process.env.HEADLONG_ROOT || "<HEADLONG_ROOT>";

fs.mkdirSync(FINDINGS_DIR, { recursive: true });

// --- per-tool run --------------------------------------------------------------
function buildCtx(mod) {
  const bashPath = resolveBash(mod.bashEnv, HEADLONG_ROOT_HINT, mod.bashRel);
  return { REPO, HEADLONG_ROOT: HEADLONG_ROOT_HINT, bashPath };
}

function classify(mod, scenario, resultOrCompare) {
  const result = mod.execute(scenario, resultOrCompare.ctx);
  return { result, verdict: mod.compare(scenario, result) };
}

// Resume finding numbering across separate invocations (this campaign's full
// sweep runs tool-by-tool in separate process calls to stay under a single
// command's wall-clock budget) by scanning existing findings/<tool>-N.md.
let findingSeq = {};
for (const f of fs.readdirSync(FINDINGS_DIR)) {
  const m = f.match(/^([a-z]+)-(\d+)\.md$/);
  if (m) findingSeq[m[1]] = Math.max(findingSeq[m[1]] || 0, Number(m[2]));
}
function nextFindingId(tool) {
  findingSeq[tool] = (findingSeq[tool] || 0) + 1;
  return findingSeq[tool];
}

// Findings are committed to git — never let one balloon to megabytes because
// a scenario happened to draw the "1mb" boundary fixture. Recursively cap
// every string value before it's ever JSON.stringify'd into a finding file.
const MAX_STR = 2000;
function capStrings(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…[+${value.length - MAX_STR} chars truncated]` : value;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => capStrings(v, seen));
    if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capStrings(v, seen);
    return out;
  }
  return value;
}

function writeFinding(tool, ctx, scenario, verdict, shrinkInfo) {
  const n = nextFindingId(tool);
  const file = path.join(FINDINGS_DIR, `${tool}-${n}.md`);
  const argvStr = JSON.stringify(capStrings(scenario.argv ?? scenario.trigger ?? scenario));
  let md = `# ${tool} fuzz finding #${n}\n\n`;
  md += `- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**\n`;
  md += `- group: \`${scenario.group}\`\n`;
  md += `- scenario (JSON, strings capped at ${MAX_STR} chars): \`${JSON.stringify(capStrings(scenario))}\`\n`;
  md += `- argv/trigger: \`${argvStr}\`\n`;
  md += `- reproduce: \`PARITY_BASH_${tool.toUpperCase()}=<abs path to real ${tool}> node parity/fuzz/run-fuzz.mjs --tool ${tool} --seed <seed printed in report.md>\` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).\n\n`;
  md += `## Diff\n\n| field | bash | ts | match |\n|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(verdict.cmp)) {
    md += `| ${k} | | | ${v ? "yes" : "**NO**"} |\n`;
  }
  md += `\n## bash output\n\n\`\`\`\n${JSON.stringify(capStrings(verdict.display.bash), null, 2)}\n\`\`\`\n\n`;
  md += `## ts output\n\n\`\`\`\n${JSON.stringify(capStrings(verdict.display.ts), null, 2)}\n\`\`\`\n\n`;
  if (shrinkInfo) {
    md += `## Shrink\n\n- oracle calls: ${shrinkInfo.calls}\n- minimal argv: \`${JSON.stringify(shrinkInfo.minimalArgv)}\`\n- original argv: \`${JSON.stringify(shrinkInfo.originalArgv)}\`\n`;
    if (shrinkInfo.flaky) {
      md += `- **NOTE: the shrunk/minimal argv did NOT reliably reproduce on re-run** (this tool mints fresh per-invocation randomness — a UUID, a temp-file suffix — so the shrinker's own probing calls diverged but a later verification run came back clean). Falling back to the ORIGINAL, already-confirmed-diverging scenario above; the "minimal argv" is a lead, not a guaranteed reproducer. Re-run several times if it doesn't reproduce immediately.\n`;
    }
    md += `\n`;
  }
  md += `## Author's reasoning toward a classification\n\n`;
  md += `This scenario's field(s) [${Object.entries(verdict.cmp).filter(([, v]) => !v).map(([k]) => k).join(", ")}] differ and do not match any allowance in \`parity/fuzz/lib/allowances.mjs\` (each of which is imported from an existing \`parity/<tool>/run-parity.mjs\` harness or a PARITY.md row — see that file's header for the full list). `;
  md += `A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash \`${tool}\` and the TS port, (2) read the relevant \`src/\` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own \`parity/${tool}/run-parity.mjs\`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).\n`;
  fs.writeFileSync(file, md);
  return file;
}

// Tokens containing a {FILE}/{WORK} placeholder are load-bearing positional
// substitutions (see put.mjs/sub.mjs/view.mjs) — dropping one during shrink
// silently changes WHICH bug is being reproduced (e.g. a missing-target-file
// error masking the original --offset/--limit divergence). They are never
// candidates for removal; only the surrounding flags/values shrink.
const PLACEHOLDER_RE = /\{FILE\}|\{WORK\}/;

function shrinkAndFind(mod, ctx, scenario, verdict, tool) {
  if (!Array.isArray(scenario.argv) || scenario.argv.length === 0) {
    return writeFinding(tool, ctx, scenario, verdict, null);
  }
  const originalArgv = scenario.argv.slice();
  const protectedIdx = new Set(originalArgv.map((t, i) => (PLACEHOLDER_RE.test(String(t)) ? i : -1)).filter((i) => i >= 0));
  const removableIdx = originalArgv.map((_, i) => i).filter((i) => !protectedIdx.has(i));
  const stillDiverges = (candidateScenario) => {
    const r = mod.execute(candidateScenario, ctx);
    const v = mod.compare(candidateScenario, r);
    return !v.pass && !v.allowed;
  };
  const rebuildIdx = (idxSubset) => {
    const keep = new Set(idxSubset);
    return originalArgv.filter((_, i) => protectedIdx.has(i) || keep.has(i));
  };
  const rebuild = (idxSubset) => ({ ...scenario, argv: rebuildIdx(idxSubset) });
  const { units: minimalIdx, calls } = ddminArray(removableIdx, rebuild, stillDiverges, 30);
  const minimalArgv = rebuildIdx(minimalIdx);
  const finalScenario = { ...scenario, argv: minimalArgv };
  const finalResult = mod.execute(finalScenario, ctx);
  const finalVerdict = mod.compare(finalScenario, finalResult);
  // Some tools mint fresh randomness (a UUID, a temp-file suffix) on EVERY
  // invocation, so a scenario that diverged once can genuinely re-run clean
  // (the shrinker's own probing calls diverged; this one didn't — flakiness,
  // not a fixed bug). Re-verifying once here catches that: if the "minimal"
  // reproducer doesn't actually reproduce, fall back to the ORIGINAL
  // scenario/verdict (already proven to diverge, that's why we're here)
  // rather than writing a finding whose own diff table shows no difference.
  if (finalVerdict.pass || finalVerdict.allowed) {
    return writeFinding(tool, ctx, scenario, verdict, {
      calls,
      minimalArgv,
      originalArgv,
      flaky: true,
    });
  }
  return writeFinding(tool, ctx, finalScenario, finalVerdict, { calls, minimalArgv, originalArgv });
}

function runTool(toolName, seedBase, deadlineMs, countLimit) {
  const mod = TOOLS[toolName];
  const ctx = buildCtx(mod);
  const rng = new Rng(seedBase);
  const tally = { generated: 0, identical: 0, allowed: 0, diverge: 0, errors: 0 };
  const findings = [];
  const start = Date.now();
  let i = 0;
  while (true) {
    if (countLimit != null && i >= countLimit) break;
    if (deadlineMs != null && Date.now() >= deadlineMs) break;
    i++;
    const scenario = mod.generate(rng.child(`iter-${i}`));
    tally.generated++;
    let result, verdict;
    try {
      result = mod.execute(scenario, ctx);
      verdict = mod.compare(scenario, result);
    } catch (e) {
      tally.errors++;
      findings.push({ error: String(e && e.stack ? e.stack : e), scenario });
      continue;
    }
    if (verdict.pass) {
      tally.identical++;
    } else if (verdict.allowed) {
      tally.allowed++;
    } else {
      tally.diverge++;
      const file = shrinkAndFind(mod, ctx, scenario, verdict, toolName);
      // Store repo-relative (results.json is committed — never an absolute
      // local checkout path).
      findings.push({ file: path.relative(REPO, file), group: scenario.group, cmp: verdict.cmp });
    }
  }
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
  // results.json is committed — scrub this machine's absolute HEADLONG_ROOT
  // out of the recorded oracle path (the finding files' own bash/ts output
  // are separately scrubbed by tools/common.mjs's normalize()).
  const bashPathScrubbed = HEADLONG_ROOT_HINT !== "<HEADLONG_ROOT>" ? ctx.bashPath.split(HEADLONG_ROOT_HINT).join("<HEADLONG_ROOT>") : ctx.bashPath;
  return { tool: toolName, seed: seedBase, elapsedS, tally, findings, bashPath: bashPathScrubbed };
}

// --- main ------------------------------------------------------------------
// Merge with a prior results.json (same seed): this campaign's full sweep
// runs tool-by-tool in separate process invocations to stay under any one
// command's wall-clock budget, so each run only touches its own tools' rows.
let priorTools = {};
try {
  const prior = JSON.parse(fs.readFileSync(path.join(HERE, "results.json"), "utf8"));
  if (prior.seedBase === opts.seed) priorTools = prior.tools || {};
} catch {
  /* no prior run, or different seed — start fresh */
}
const overall = { seedBase: opts.seed, startedAt: new Date().toISOString(), tools: { ...priorTools } };
for (const toolName of toolNames) {
  const seedBase = hashSeed(opts.seed, toolName);
  const deadlineMs = opts.minutes != null ? Date.now() + opts.minutes * 60000 : null;
  console.log(`\n=== ${toolName} === (seed ${seedBase}, ${opts.minutes != null ? opts.minutes + "min" : opts.count + " iters"})`);
  const res = runTool(toolName, seedBase, deadlineMs, opts.count);
  overall.tools[toolName] = res;
  console.log(
    `  generated=${res.tally.generated} identical=${res.tally.identical} allowed=${res.tally.allowed} DIVERGE=${res.tally.diverge} errors=${res.tally.errors} (${res.elapsedS}s)`,
  );
  for (const f of res.findings) {
    if (f.file) console.log(`    finding: ${f.file}  [${f.group}] fields=${Object.entries(f.cmp).filter(([, v]) => !v).map(([k]) => k).join(",")}`);
    else console.log(`    ERROR while fuzzing: ${f.error.split("\n")[0]}`);
  }

  if (opts.concurrency && CONCURRENCY_TOOLS.includes(toolName)) {
    const ctx = buildCtx(TOOLS[toolName]);
    const concSeed = hashSeed(opts.seed, toolName + "-conc");
    const concRng = new Rng(concSeed);
    console.log(`  -- concurrency lane (${toolName}) --`);
    const concResult = await runConcurrencyLane(toolName, ctx, concRng);
    overall.tools[toolName].concurrency = concResult;
    console.log(`    n=${concResult.n} bashInvariant=${concResult.bashOk} tsInvariant=${concResult.tsOk} match=${concResult.match}`);
    if (!concResult.match) {
      const file = path.join(FINDINGS_DIR, `${toolName}-concurrency.md`);
      fs.writeFileSync(
        file,
        `# ${toolName} concurrency finding\n\n- classification: UNCLASSIFIED\n- n concurrent invocations: ${concResult.n}\n- bash invariant held: ${concResult.bashOk}\n- ts invariant held: ${concResult.tsOk}\n- detail:\n\n\`\`\`json\n${JSON.stringify(concResult.detail, null, 2)}\n\`\`\`\n`,
      );
      console.log(`    finding: ${path.relative(REPO, file)}`);
    }
  }
}

function hashSeed(base, tag) {
  let h = (base >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < tag.length; i++) h = (Math.imul(h ^ tag.charCodeAt(i), 0x01000193)) >>> 0;
  return h >>> 0;
}

// --- report ------------------------------------------------------------------
overall.finishedAt = new Date().toISOString();
let totalDiverge = 0;
let md = `# parity/fuzz — L1 differential fuzz report\n\n`;
md += `Seed base: \`${opts.seed}\`. Run \`node parity/fuzz/run-fuzz.mjs --tool <name> --seed ${opts.seed} ...\` to reproduce any single tool's stream (each tool derives its own sub-seed from the base + its name, printed below).\n\n`;
md += `| tool | generated | identical | allowed (documented) | DIVERGE (findings) | errors | seed | time |\n|---|---|---|---|---|---|---|---|\n`;
for (const [toolName, res] of Object.entries(overall.tools)) {
  totalDiverge += res.tally.diverge + res.tally.errors;
  md += `| ${toolName} | ${res.tally.generated} | ${res.tally.identical} | ${res.tally.allowed} | ${res.tally.diverge} | ${res.tally.errors} | ${res.seed} | ${res.elapsedS}s |\n`;
}
md += `\n## Concurrency lane\n\n| tool | n | bash invariant | ts invariant | match |\n|---|---|---|---|---|\n`;
for (const [toolName, res] of Object.entries(overall.tools)) {
  if (res.concurrency) md += `| ${toolName} | ${res.concurrency.n} | ${res.concurrency.bashOk} | ${res.concurrency.tsOk} | ${res.concurrency.match} |\n`;
}
md += `\n## Findings\n\n`;
let anyFinding = false;
for (const [toolName, res] of Object.entries(overall.tools)) {
  for (const f of res.findings) {
    if (f.file) {
      anyFinding = true;
      md += `- [${toolName}] \`${f.file}\` — group \`${f.group}\`, fields: ${Object.entries(f.cmp).filter(([, v]) => !v).map(([k]) => k).join(",")}\n`;
    }
  }
  if (res.concurrency && !res.concurrency.match) {
    anyFinding = true;
    md += `- [${toolName}] concurrency lane mismatch — see \`parity/fuzz/findings/${toolName}-concurrency.md\`\n`;
  }
}
if (!anyFinding) md += `None this run.\n`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(overall, null, 2));

console.log(`\n=== summary ===`);
console.log(md.split("## Findings")[0]);
process.exit(totalDiverge > 0 ? 1 : 0);
