# llm fuzz finding #3 — closed port 9 fails differently: curl ECONNREFUSED vs Node fetch "bad port"

- classification: **Bash/environment artifact of this harness's test fixture — NOT a port bug for real usage**, but flags a genuine (narrow) transport-wording gap worth a human's awareness
- group: `closed-port`
- argv: e.g. `["5 ", "--no-stream"]` (prompt text + `--no-stream`), env `LLM_API_URL=http://127.0.0.1:9/x`
- reproduce:
  ```
  OPENAI_API_KEY=k LLM_API_URL=http://127.0.0.1:9/x LLM_RETRIES=0 <HEADLONG_ROOT>/bin/llm --provider openai "hi"
  OPENAI_API_KEY=k LLM_API_URL=http://127.0.0.1:9/x LLM_RETRIES=0 node bin/llm.mjs --provider openai "hi"
  ```

## Diff

| field | bash | ts | match |
|---|---|---|---|
| stdout | (empty) | (empty) | yes |
| stderr | `curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server` | `request failed: bad port` | **NO** |
| status | 1 | 1 | yes |

## Root cause

This harness (following `parity/llm/run-parity.mjs`'s own convention) uses
`127.0.0.1:9` as its "definitely closed, no real network" sentinel port.
Port 9 (the discard protocol) is on the WHATWG Fetch spec's "bad port"
blocklist, which Node's `fetch()`/undici implementation enforces BEFORE
attempting any socket connection (a security measure against port-scanning
via fetch). curl has no such restriction and gets a real OS-level
`ECONNREFUSED`. The two sides are failing via genuinely DIFFERENT
mechanisms — not a difference in how the port HANDLES a connection refusal
(that class is already the documented "transport-text" deviation, and DOES
match when the closed port is one NOT on the Fetch blocklist), but a quirk
of the specific port number this harness (and the existing parity/llm
harness) chose as its fixture.

**Recommendation**: this is primarily a note for whoever maintains
`parity/llm/run-parity.mjs` and this fuzzer's `CLOSED_URL` — picking a
closed port NOT on the Fetch spec's blocklist (ports 1, 7, 9, 11, 13, 15,
17, 19, 20, 21, 22, 23, 25, 37, ... — see the WHATWG Fetch spec's "bad port"
list) would let the ALREADY-documented transport-text deviation cover this
case too, rather than surfacing a distinct "bad port" message. Still worth
recording here because a REAL caller who points `LLM_API_URL` at one of
these blocked ports (deliberately or by typo) WOULD see this exact
divergence in production, not just in the harness.

## Duplicates

7 of llm's 300-iteration findings are variants of this (different
argv/provider combinations, all hitting the same port-9-is-blocked
mechanism); 2 more (`llm-1`, `llm-2`) are the SEPARATE already-documented
`invalid-messages-json` family (now correctly allowed after this campaign's
`isLlmInvalidMessagesJsonFamily` allowance fix — see
`lib/allowances.mjs`).
