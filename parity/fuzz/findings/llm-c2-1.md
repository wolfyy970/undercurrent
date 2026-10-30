# llm fuzz triage — campaign #2, root cause 1

- classification: **harness-artifact**
- confidence: high
- instances: 17 (`llm-3.md` [campaign #1, 300-iter sweep] plus `llm-4.md`,
  `llm-5.md`, `llm-6.md`, `llm-7.md`, `llm-8.md`, `llm-10.md` through
  `llm-18.md`, `llm-20.md`, `llm-21.md`, `llm-22.md` [campaign #2, seed
  base 2, tool sub-seed 3753365250, `--count 400`, and seed base 1, tool
  sub-seed 2518219431, `--count 150`]); group `closed-port` in every case.

## Reproduce

```
OPENAI_API_KEY=k LLM_API_URL=http://127.0.0.1:9/x LLM_RETRIES=0 <HEADLONG_ROOT>/bin/llm --provider openai "hi"
OPENAI_API_KEY=k LLM_API_URL=http://127.0.0.1:9/x LLM_RETRIES=0 node bin/llm.mjs --provider openai "hi"
```
(any provider; the fixture's `CLOSED_URL` always points at `127.0.0.1:9`.)

## Upstream vs port

- bash: `curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server`
- port: `request failed: bad port`

Both exit 1, both stdout empty — only the stderr wording differs.

## Root cause

`llm-3.md` (this repo's original, fully-worked triage — see that file for the
full writeup) already identified this exactly: this fuzzer's `CLOSED_URL`
fixture (`lib/gen.mjs`, matching `parity/llm/run-parity.mjs`'s own
convention) uses `127.0.0.1:9` as its "definitely closed, no real network"
sentinel port. Port 9 (discard) is on the WHATWG Fetch spec's "bad port"
blocklist, which Node's `fetch()`/undici enforces BEFORE attempting any
socket connection. curl has no such restriction and gets a real OS-level
`ECONNREFUSED`. This is a property of the **fixture's chosen port number**,
not of how the two tools handle a genuine connection refusal — the
already-documented `isLlmTransportTextFamily` allowance DOES cover a refusal
on a non-blocklisted closed port; it just can't fire here because the
failure mechanism itself (Fetch-spec port block vs OS `ECONNREFUSED`) is
different upstream of the wording.

## Recommendation

Same as `llm-3.md`: whoever maintains `parity/llm/run-parity.mjs` and this
fuzzer's `CLOSED_URL` should pick a closed port NOT on the Fetch blocklist
(1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, ...) so the existing
transport-text allowance covers this family too. Flagging as a harness-fix
candidate, not applying it here (no test yet, and this lane's authority is
limited to a *demonstrable* harness bug with its own committed test — this
one is filed for that follow-up). Worth recording that a real caller
pointing `LLM_API_URL` at one of these ports (typo or deliberate) would see
this exact divergence in production, not just in the harness.
