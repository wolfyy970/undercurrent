# llm fuzz triage — campaign #2, root cause 2

- classification: **PORT-BUG**
- confidence: high
- instances: 2 (`llm-9.md`, `llm-19.md`; seed base 2, tool sub-seed
  3753365250, `--count 400`, and seed base 1, tool sub-seed 2518219431,
  `--count 150`); group `closed-port` (mislabeled by the generator — the
  actual scenario never reaches the network: `LLM_PROVIDER=adapter` with
  `LLM_ADAPTER=/bin/false` and an invalid `-M`/`--messages` JSON value).

## Reproduce

```
LLM_ADAPTER=/bin/false <HEADLONG_ROOT>/bin/llm --provider adapter -M 'not json'
LLM_ADAPTER=/bin/false node bin/llm.mjs --provider adapter -M 'not json'
```

## Upstream vs port

- bash: `llm: error: LLM_ADAPTER is not executable: /bin/false` (exit 1)
- port: `llm: error: --messages is not valid JSON` (exit 1)

Same exit code, but the two sides die for entirely different reasons — a
real caller with a bad adapter path AND malformed `-M` would be told about
the wrong problem by the port.

## Root cause

Upstream (`bin/llm:1243-1244`) checks the adapter executable's validity
FIRST, at dispatch time, before the adapter is ever invoked:
```bash
[[ -n "${LLM_ADAPTER:-}" ]] || die "LLM_ADAPTER is not set ..."
[[ -x "$LLM_ADAPTER" ]] || die "LLM_ADAPTER is not executable: $LLM_ADAPTER"
```
`LLM_MESSAGES` is only ever piped through `jq` for the HTTP-provider payload
builders (`bin/llm:682`); for the adapter path it is written to the payload
file VERBATIM, with no `jq`/JSON validation at all (`bin/llm:1265`,
`printf '%s' "$LLM_MESSAGES" > "$payload_file"`). So for `--provider
adapter`, bash never validates `-M`'s JSON shape — it validates the adapter
executable first and, if that passes, hands the adapter whatever bytes it
was given.

The port (`src/llmCli.ts:1652`) validates `-M`/`--messages` as JSON
UNCONDITIONALLY, before dispatch to any provider — `if (!p.ok) die("--messages
is not valid JSON")` runs ahead of the adapter-executable check at line 1704
(`if (!executable) die(...)`) regardless of `--provider`. This is a
check-ordering bug: the port validates the wrong thing first for the
adapter path, and validates a thing bash never validates at all for that
path.

## Recommendation (not applied — src/ is out of scope for this fuzz lane)

In `src/llmCli.ts`, when `provider === "adapter"`, check `LLM_ADAPTER`
existence/executability BEFORE calling the `-M` JSON-parse gate at line
1652 — matching bash's dispatch order. Whether the port should also drop
its own `-M` JSON validation for the adapter path entirely (to match bash's
verbatim pass-through) or keep it as a stricter-than-bash safety net is a
product call for the fix lane; either way the CURRENT ordering (JSON check
before adapter check, for every provider) is the bug.
