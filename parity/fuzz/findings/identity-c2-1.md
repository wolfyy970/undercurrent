# identity fuzz triage — campaign #2, root cause 1

- classification: **PORT-BUG**
- confidence: high
- instances: 30 (`parity/fuzz/findings/identity-2.md` through `identity-31.md`, all from this campaign's `list` generator group; seed base 2, tool sub-seed 3773167109, `node parity/fuzz/run-fuzz.mjs --tool identity --seed 2 --count 400`)

## Reproduce

```
IDENTITY_DIR=<any dir with >=1 identity, e.g. from the harness's seeded state>
bin/identity.mjs --help
```

Minimal argv in every instance: `["--help"]`. No sandbox state matters — this
reproduces with any (even empty) `IDENTITY_DIR`.

## Upstream vs port

Upstream `tools/identity` `main()` (lines 1550-1558) parses **global flags in
a leading `while` loop before dispatch**: `-h|--help` (in any position before
the first non-flag/unrecognized-flag token) calls `usage()` — prints the full
top-level banner to stdout, exit 0:

```
identity — Identity management
Usage:
  identity new <name> [--default] [--memories DIR]  Create a new identity
  ...
```
status 0, stderr empty.

Port `bin/identity.mjs` only special-cases `cmd === undefined` (bare
`identity`, fixed by bug #41 — see the `PORT-NOTE (bug #41)` comment above
that branch). `cmd === "--help"` matches none of the `if (cmd === "export"|
"import"|"list"|undefined)` branches, so it falls through to
`if (cmd !== "new") { await die(...) }`, producing:

```
stdout: ""
stderr: "Usage: identity new [--default] [--memories DIR] <name>\n"
status: 1
```

Byte-for-byte: stdout, stderr, and status all diverge (see
`parity/fuzz/findings/identity-2.md` for a full captured pair).

## Root cause

Bug #41 fixed the bare-invocation (`argv=[]`) case but did not port upstream's
global-flag pre-loop, which also intercepts `-h`/`--help` (and `--version`,
also unhandled in the port) ahead of subcommand dispatch, regardless of
position among leading flags. `-h` was not exercised by this fuzz run (the
generator only emitted `--help`) but shares the same gap and should be fixed
together.

## Suggested fix (not applied — src/ is out of scope for this fuzz lane)

In `bin/identity.mjs`, before `const cmd = argv.shift();`, or immediately
after, add a check: if the raw first argv token is `-h`/`--help`, print the
top-level banner (same text as the `cmd === undefined` branch) and exit 0.
`--version` is a separate, smaller gap (upstream prints `identity
$IDENTITY_VERSION`) — worth doing in the same fix since it's the same
missing-global-flags problem, but wasn't hit by this campaign.
