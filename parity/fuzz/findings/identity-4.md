# identity fuzz finding #4

- classification: **UNCLASSIFIED — needs human triage (PORT-BUG / documented deviation / Bash artifact / environment)**
- group: `list`
- scenario (JSON, strings capped at 2000 chars): `{"group":"list","argv":["--help"],"seed":{"identities":[],"missingRoot":false,"danglingLinks":["brokenlink"]}}`
- argv/trigger: `["--help"]`
- reproduce: `PARITY_BASH_IDENTITY=<abs path to real identity> node parity/fuzz/run-fuzz.mjs --tool identity --seed <seed printed in report.md>` then re-run this exact scenario (see "minimal scenario JSON" above; the shrinker already reduced the argv to the minimal reproducing form below).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | | | **NO** |
| stderr | | | **NO** |
| status | | | **NO** |

## bash output

```
{
  "stdout": "identity â Identity management\n\nUsage:\n  identity new <name> [--default] [--memories DIR]  Create a new identity\n  identity list [-a]         List all identities (-a: show directories)\n  identity info [name] [-n|-p]  Show identity info (default: default; -n: name, -p: dir)\n  identity sync-kernel [name|--all]  Symlink bundled kernel skills into identities\n  identity sync-thinkers [name|--all]  Bootstrap new + retire deleted bundled thinkers\n  identity default [name]     Show or set the default identity\n  identity delete <name>     Delete an identity\n  identity export [names...] [--all] [--path DIR] [-o FILE|-] [--soul-only]\n                             Package identities into a portable .tgz\n  identity import <file|-> [--name NEW]\n                             Install identities from an export archive\n  identity shell [name]      Start a subshell with identity env vars set\n  identity prompt            Assemble and print the system prompt\n\nOptions:\n  --dir DIR          Override identities directory (default: .identities)\n  -v, --verbose      Verbose/debug mode\n  -h, --help         Show help\n  --version          Show version\n\nEnvironment:\n  IDENTITY_DIR   Override identities directory (default: .identities)\n\nActivation:\n  identity shell headlong               # start a subshell with env vars set\n  exit                                   # leave the subshell\n  source .identities/headlong/activate   # activate in current shell (no subshell)\n  deactivate_identity                    # undo (when using source activate)\n",
  "stderr": "",
  "status": 0
}
```

## ts output

```
{
  "stdout": "",
  "stderr": "Usage: identity new [--default] [--memories DIR] <name>\n",
  "status": 1
}
```

## Shrink

- oracle calls: 1
- minimal argv: `["--help"]`
- original argv: `["--help"]`

## Author's reasoning toward a classification

This scenario's field(s) [stdout, stderr, status] differ and do not match any allowance in `parity/fuzz/lib/allowances.mjs` (each of which is imported from an existing `parity/<tool>/run-parity.mjs` harness or a PARITY.md row — see that file's header for the full list). A human/fix-lane should: (1) reproduce with the minimal argv above against both the real Bash `identity` and the TS port, (2) read the relevant `src/` implementation + the Bash source for the exact divergent behavior, (3) decide PORT-BUG (fix the port) vs a new documented deviation (add to PARITY.md + the tool's own `parity/identity/run-parity.mjs`, NOT to this fuzzer) vs a Bash/environment artifact (e.g. locale, GNU-vs-BSD, timing).
