// tools/killall.mjs — fuzz adapter for `headlong-killall`. SAFETY: NEVER
// invoked without --dry-run (see parity/killall/run-parity.mjs header — both
// tools are system-wide panic buttons with no CLI-level scoping). The live
// process listing is excluded from comparison, matching that harness exactly.

import { runBash, runTs, normalize } from "./common.mjs";
import { redactKillallListing } from "../lib/allowances.mjs";

export const name = "killall";
export const bashEnv = "PARITY_BASH_KILLALL";
export const bashRel = "tools/headlong-killall";
export const tsRel = "headlong-killall";

const EXACT_ARGVS = [
  ["-h"], ["--help"], ["--bogus"], ["-x"], ["--bogus", "extra"], ["-hx"], [""],
];

export function generate(rng) {
  // Every argv is forced to carry --dry-run/-n unless it's a pure help/error
  // path (which never reaches the process-scan code at all).
  const kind = rng.pickWeighted([
    ["exact", 3],
    ["dryrun", 5],
  ]);
  if (kind === "exact") return { group: "exact", argv: rng.pick(EXACT_ARGVS) };
  const argv = [rng.pick(["--dry-run", "-n"])];
  if (rng.bool(0.3)) argv.push("--web");
  if (rng.bool(0.1)) argv.push(rng.pick(["--bogus-extra", "-z"])); // dry-run + unknown -> still exact (dies before scan)
  return { group: "dryrun", argv, hasUnknown: argv.some((a) => a.includes("bogus") || a === "-z") };
}

// HARD SAFETY GATE, independent of `generate()`: the delta-debug shrinker
// (run-fuzz.mjs) tries arbitrary SUBSETS of an original argv, which for this
// tool can mean dropping the "--dry-run"/"-n" token itself while keeping
// "--web" — turning a safe scenario into a real, system-wide, non-dry-run
// kill. `generate()` alone cannot prevent that (it only controls the
// ORIGINAL argv, not shrink candidates), so `execute()` re-validates on
// every single invocation, including ones the shrinker constructs, and
// refuses to run anything unsafe rather than trusting the caller.
function isSafeArgv(argv) {
  const isKnownExact = EXACT_ARGVS.some((a) => a.length === argv.length && a.every((v, i) => v === argv[i]));
  if (isKnownExact) return true;
  return argv.includes("--dry-run") || argv.includes("-n");
}

export function execute(scenario, ctx) {
  if (!isSafeArgv(scenario.argv)) {
    throw new Error(
      `refusing to run headlong-killall with unsafe argv ${JSON.stringify(scenario.argv)} — missing --dry-run/-n and not a recognized help/error-only argv (see tools/killall.mjs's isSafeArgv)`,
    );
  }
  const env = { ...process.env };
  const bash = runBash(ctx.bashPath, scenario.argv, { env, timeout: 15000 });
  const ts = runTs(ctx.REPO, tsRel, scenario.argv, { env, timeout: 15000 });
  return { bash, ts, roots: { bash: [], ts: [] } };
}

export function compare(scenario, result) {
  const { bash, ts } = result;
  const isDryRunClean = scenario.group === "dryrun" && !scenario.hasUnknown;
  if (isDryRunClean) {
    // Redact the live process-table listing (disjoint-by-construction, see
    // parity/killall/run-parity.mjs header) for DISPLAY only. The pass/fail
    // gate does NOT compare stdout at all: on a shared machine the bash and
    // TS invocations run sequentially (not atomically together), so even
    // whether anything matches at all — "No matching processes found." vs
    // "Would kill N process(es):" — can legitimately flip between the two
    // calls as other real processes start/stop in between; this is the same
    // nondeterminism parity/killall/run-parity.mjs's header documents, just
    // manifesting one layer up (zero-vs-nonzero, not just N's exact value).
    // What IS a real, stable contract on both sides: exit 0 and empty stderr.
    const bOut = redactKillallListing(normalize(bash.stdout, []));
    const tOut = redactKillallListing(normalize(ts.stdout, []));
    const bErr = normalize(bash.stderr, []);
    const tErr = normalize(ts.stderr, []);
    const cmp = {
      status: bash.status === 0 && ts.status === 0,
      stderrEmpty: bErr === "" && tErr === "",
    };
    const pass = cmp.status && cmp.stderrEmpty;
    return {
      cmp,
      pass,
      allowed: false,
      allowReason: null,
      display: { bash: { stdout: bOut, stderr: bErr, status: bash.status }, ts: { stdout: tOut, stderr: tErr, status: ts.status } },
    };
  }
  const bOut = normalize(bash.stdout, []);
  const tOut = normalize(ts.stdout, []);
  const bErr = normalize(bash.stderr, []);
  const tErr = normalize(ts.stderr, []);
  const cmp = { stdout: bOut === tOut, stderr: bErr === tErr, status: bash.status === ts.status };
  const pass = cmp.stdout && cmp.stderr && cmp.status;
  return {
    cmp,
    pass,
    allowed: false,
    allowReason: null,
    display: { bash: { stdout: bOut, stderr: bErr, status: bash.status }, ts: { stdout: tOut, stderr: tErr, status: ts.status } },
  };
}
