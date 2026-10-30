# chat fuzz finding #1 — `chat history --with X --since bogus` crashes bash, port ignores

- classification: **PORT-BUG candidate (validation gap) — needs a human call on intended behavior**
- group: `history`
- argv: `["history", "--with", "<name>", "--since", "bogus"]` against a seeded
  trajectory with 2+ messages
- reproduce: seed a trajectory with `chat send`-shaped messages, then run
  `chat history --with <name> --since bogus` on both sides (see
  `parity/fuzz/tools/chat.mjs`'s `seedStepsStatic`/`makeSandboxStatic` for the
  exact fixture shape, or use `parity/chat/run-parity.mjs`'s sandbox).

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | (empty) | real history JSON/text | **NO** |
| stderr | `jq: invalid JSON text passed to --argjson` + jq help text | (empty) | **NO** |
| status | 2 | 0 | **NO** |
| state (trajectory) | unchanged | unchanged | yes |

## Root cause

Bash's `chat history --with --since <D>` computes a cutoff time by feeding
the raw `--since` string into a `jq --argjson` call without validating it is
a duration Bash's own parser understands first; an unparseable value like
"bogus" reaches jq as literal (non-JSON) text and jq itself dies (`invalid
JSON text passed to --argjson`, exit 2) — a Bash-side crash, not a clean
usage error. The TS port evidently never routes `--since`'s value through an
equivalent strict check at all: an unparseable duration is silently ignored
(or treated as "no cutoff"), and `chat history` proceeds to print real
results, exit 0.

This is a genuine behavioral gap either way: Bash's behavior (crash with a
jq stack-trace-shaped message) is clearly not the INTENDED contract, so
"match bash exactly" is probably wrong; but the port silently accepting any
garbage `--since` value and returning full history (rather than a clean
usage error) is also not obviously right. A human should decide the intended
contract (die cleanly on an unparseable `--since`, vs. silently ignore it)
and align OR document both sides — the current MISmatch (crash vs. silent
success) is not a defensible parity target.

## Duplicates

4 of chat's 300-iteration findings are this scenario (`--since bogus`
against varying seeded history/`--with` names); a prior larger run (874
iterations) found 16 — one root cause, deterministic given the flag combo.
