# parity/fuzz — L1 differential fuzzer

PROOF-CAMPAIGN.md layer L1: generated argv/content fuzzing of every ported CLI
tool against the real upstream Bash tool, raw-byte comparison, seed-reproducible.
**Harness only** — this lane never fixes the port; every unclassified
divergence becomes a `findings/<tool>-<n>.md` for a fix lane to triage.

## Run it

```
export HEADLONG_ROOT=/abs/path/to/headlong          # upstream checkout (bin/*, tools/identity, tools/headlong-killall)
node parity/fuzz/run-fuzz.mjs --tool <name|all|a,b,c> [--minutes M | --count K] [--seed N] [--no-concurrency]
```

- `--tool all` (default) or a comma list, e.g. `--tool put,sub,mem`.
- `--minutes M` (default 3) or `--count K` — one or the other, not both.
- `--seed N` (default 1) — every tool derives its own sub-seed from
  `hash(seedBase, toolName)`, printed in `report.md`, so `--seed 1 --tool put`
  reproduces exactly the same stream `--tool all --seed 1` generated for `put`.
- Per-tool Bash oracle path: `PARITY_BASH_<TOOL>=/abs/path` (same env-var
  convention as every `parity/<tool>/run-parity.mjs`), or set `HEADLONG_ROOT`
  once and every tool derives its default (`$HEADLONG_ROOT/bin/<tool>`,
  `tools/identity`, `tools/headlong-killall`, `thinkers/retrieval/step`).
- `--no-concurrency` skips the "2-4 concurrent invocations on a shared
  identity" lane (put/sub/mem/traj) — useful for a fast smoke run.

A full sweep runs longer than a single shell command's timeout, so it is
normally run **tool-by-tool** across several invocations with the same
`--seed`; `run-fuzz.mjs` merges each run's per-tool row into the existing
`results.json`/`report.md` rather than overwriting it (see "Resumable sweeps"
below). `--tool all` in one process also works if your shell allows the wall
time.

Writes `parity/fuzz/results.json` + `report.md` (per-tool counts: generated /
identical / allowed / DIVERGE, plus the concurrency-lane table) and
`parity/fuzz/findings/<tool>-<n>.md` for every unclassified divergence. Exit
code is 1 iff any tool has a DIVERGE or a fuzzing-loop error, 0 otherwise.

## What it generates

Per tool, derived from that tool's own `--help`/usage text (see each
`tools/<name>.mjs` file header) plus the shapes already proven in
`parity/<tool>/run-parity.mjs`'s scenario list:

- valid flag/subcommand combinations
- boundary values: empty string, 1 byte, 64 KB, 1 MB (`lib/gen.mjs`'s
  `NAMED_BYTES`)
- hostile bytes: NUL, DEL, invalid UTF-8, CRLF, leading `-`, spaces, quotes,
  backtick/`$()`, `..`, absolute paths, emoji/NFC-NFD, tabs
- missing/unset env vars, non-integer numeric flags (`""`, `abc`, `1+1`,
  `10x`, huge, negative, `+2`)
- read-only or missing target directories (`lib/sandbox.mjs`'s
  `makeReadOnlyDir`/`missingDirPath`)
- stdin piped / closed / binary
- 2-4 concurrent invocations against the SAME shared sandbox/identity
  (`lib/concurrency.mjs` — put/sub/mem/traj; real `node:child_process.spawn`
  concurrency, not `spawnSync`, so it's genuinely concurrent)

Every scenario runs in an ISOLATED scratch sandbox per side (byte-identical
seed state on both sides), captures stdout/stderr/exit code and — for tools
with on-disk effects — a content hash of every file under the sandbox
afterward, then compares raw bytes after only the SAME normalization each
`parity/<tool>/run-parity.mjs` already applies (timestamps, random hex
ids/UUIDs, the sandbox's own absolute path — see `tools/common.mjs`'s
`normalizeGeneric`).

## Allowances: reused, not invented

`lib/allowances.mjs` is the **only** place a divergence can be marked
"documented deviation" instead of an unclassified finding, and every
predicate in it is imported from an **existing** `parity/<tool>/run-parity.mjs`
harness or cites a PARITY.md row — see that file's header comments for the
exact citation per family:

1. `isBashLineWordingDeviation` — Bash's `${var:?msg}` / `[[ arithmetic ]]`
   failures print `<script-path>: line N: ...`, embedding the Bash script's
   own path and an internal line number; the port prints its own clean
   `<tool>: error: ...` text. (mem row M1 fix, retrieval row — reused across
   every tool that shells the same Bash argument-parsing idiom.)
2. `isGlobLimitNonIntegerFamily` / `isGlobBracketRangeFamily` — glob's
   `--limit` non-integer arithmetic-coercion family and the POSIX-bracket
   ERE-vs-JS-RegExp family (`parity/glob`'s `limit-junk`/`regex` groups).
3. `isPutOsFailFamily` — put's OS-failure-wording family #3b/#3c/#4
   (`parity/put`'s `osfail` group, PARITY.md put row).
4. `redactKillallListing` — the live process-table listing is excluded from
   comparison by construction (`parity/killall` header: the two tools' process
   universes are disjoint, and even the Bash side alone is nondeterministic on
   a shared machine).
5. `isRetrievalAwkVFamily` — a memory summary's `\t`/`\n` backslash escapes,
   interpreted by Bash's `awk -v` but written verbatim by the port
   (`parity/retrieval`'s `awk-v` sequence).
6. `isLlmTransportTextFamily` / `isLlmInvalidMessagesJsonFamily` — llm's
   `transport-text` and `invalid-messages-json` deviation catalogue entries
   (`parity/llm/run-parity.mjs`'s `DEVIATIONS` table).

No new allowance category was added for anything this fuzzer found that
wasn't already in one of the source harnesses — a hit that doesn't match one
of the above is always written to `findings/`, never silently passed.

## Findings

Every unclassified divergence is delta-debugged (`lib/shrink.mjs`'s
`ddminArray` over the argv array, holding `{FILE}`/`{WORK}` placeholder
tokens fixed so shrinking can't accidentally swap in a DIFFERENT bug) and
written to `findings/<tool>-<n>.md`: the minimal argv, both sides' raw
output, and a proposed classification (PORT-BUG / documented deviation /
Bash artifact / environment) with reasoning — for a human/fix-lane to confirm,
never a verdict this harness enforces itself.

## Safety notes specific to this harness

- **killall**: every invocation is hard-gated in `tools/killall.mjs`'s
  `isSafeArgv` — even a shrink-candidate argv that drops `--dry-run`/`-n` is
  refused before it reaches the real binary (both tools are system-wide panic
  buttons; see `parity/killall/run-parity.mjs`'s header for the same rule).
- **llm**: never given a real provider URL — `lib/gen.mjs`'s `CLOSED_URL`
  points at a closed local port, and `--no-keys` scenarios strip every
  provider API key so the "no key" usage path is hit before any network
  attempt.
- **skills**: only the local `--dir`-scoped surface is fuzzed — `install`,
  `remove`, and `remote add` with a URL/`owner/repo` can reach the network and
  are excluded by construction (see `tools/skills.mjs`'s header).
- **glob**: the tool's cwd is nested one level under a private scratch root
  (`root/work/`, matching put/sub's own isolation pattern) so a `..`-shaped
  hostile DIR argument can't escape onto the real machine's filesystem; the
  fuzzer's own `..` depth is capped at 2 to match that one level of nesting
  (see `lib/gen.mjs`'s `PATH_HOSTILE_SEGMENTS` comment for the incident this
  closed).

## Layout

```
parity/fuzz/
  run-fuzz.mjs        orchestrator: CLI args, the generate/execute/compare
                       loop, delta-debug shrinking, report + findings writer
  lib/
    rng.mjs            seeded PRNG (mulberry32) + pickers
    gen.mjs            boundary/hostile byte+string generators
    sandbox.mjs        scratch sandbox/identity builders, FAKEBIN stubs
                       (chmod --reference shim, llm/mem/timeout stubs),
                       on-disk state hashing
    allowances.mjs     the only per-field deviation allowances (see above)
    shrink.mjs         delta-debug (ddmin) argv shrinker
    concurrency.mjs    the 2-4-concurrent-invocations lane
  tools/
    common.mjs         shared bash/ts invocation + normalization
    registry.mjs       tool-name -> adapter module map
    <tool>.mjs          one adapter per tool: generate()/execute()/compare()
  findings/            <tool>-<n>.md per unclassified divergence
  report.md            per-tool counts table (generated by run-fuzz.mjs)
  results.json         machine-readable version of the same
```
