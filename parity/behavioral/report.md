# Behavioral parity: assembled monolith request, real upstream Bash vs port

Real `thinkers/monolith/step` + `bin/shellm` + `bin/llm` (upstream) vs `bin/thinker-step.mjs monolith` (port), same identity layout, seed trajectory and env, one replay server serving recorded real DeepSeek replies to both (`parity/behavioral/run-parity.mjs`, `recordings/`).

Result: 75/81 PARITY, 6 DEVIATION (documented), 0 DIVERGE

| check | status |
|---|---|
| both sides ran both wakes (exit 0) | PARITY |
| model calls per wake identical on both sides (same recorded replies) | PARITY |
| replay: every request had a recording (no misses) | PARITY |
| wake 1, call 1 (fresh wake): system prompt text identical (normalized) | PARITY |
| wake 1, call 1 (fresh wake): message roles/count identical | PARITY |
| wake 1, call 1 (fresh wake): request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 1, call 1 (fresh wake): task message EXACT text identical (timestamps/ids/runtime+workspace lines masked; blank lines included; identity text unmasked) | DEVIATION |
| wake 1, call 1 (fresh wake): task message structure (anchor lines) identical | PARITY |
| wake 1, call 2: system prompt text identical (normalized) | PARITY |
| wake 1, call 2: message roles/count identical | PARITY |
| wake 1, call 2: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 1, call 3: system prompt text identical (normalized) | PARITY |
| wake 1, call 3: message roles/count identical | PARITY |
| wake 1, call 3: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 2, call 1 (fresh wake): system prompt text identical (normalized) | PARITY |
| wake 2, call 1 (fresh wake): message roles/count identical | PARITY |
| wake 2, call 1 (fresh wake): request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 2, call 1 (fresh wake): task message EXACT text identical (timestamps/ids/runtime+workspace lines masked; blank lines included; identity text unmasked) | DEVIATION |
| wake 2, call 1 (fresh wake): task message structure (anchor lines) identical | PARITY |
| wake 2, call 2: system prompt text identical (normalized) | PARITY |
| wake 2, call 2: message roles/count identical | PARITY |
| wake 2, call 2: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 2, call 3: system prompt text identical (normalized) | PARITY |
| wake 2, call 3: message roles/count identical | PARITY |
| wake 2, call 3: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 2, call 4: system prompt text identical (normalized) | PARITY |
| wake 2, call 4: message roles/count identical | PARITY |
| wake 2, call 4: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 2, call 5: system prompt text identical (normalized) | PARITY |
| wake 2, call 5: message roles/count identical | PARITY |
| wake 2, call 5: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 1 (fresh wake): system prompt text identical (normalized) | PARITY |
| wake 3, call 1 (fresh wake): message roles/count identical | PARITY |
| wake 3, call 1 (fresh wake): request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 1 (fresh wake): task message EXACT text identical (timestamps/ids/runtime+workspace lines masked; blank lines included; identity text unmasked) | DEVIATION |
| wake 3, call 1 (fresh wake): task message structure (anchor lines) identical | PARITY |
| wake 3, call 2: system prompt text identical (normalized) | PARITY |
| wake 3, call 2: message roles/count identical | PARITY |
| wake 3, call 2: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 3: system prompt text identical (normalized) | PARITY |
| wake 3, call 3: message roles/count identical | PARITY |
| wake 3, call 3: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 4: system prompt text identical (normalized) | PARITY |
| wake 3, call 4: message roles/count identical | PARITY |
| wake 3, call 4: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 5: system prompt text identical (normalized) | PARITY |
| wake 3, call 5: message roles/count identical | PARITY |
| wake 3, call 5: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 6: system prompt text identical (normalized) | PARITY |
| wake 3, call 6: message roles/count identical | PARITY |
| wake 3, call 6: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| wake 3, call 7: system prompt text identical (normalized) | PARITY |
| wake 3, call 7: message roles/count identical | PARITY |
| wake 3, call 7: request flags identical (model, stream, stream_options, max_tokens, no reasoning) | PARITY |
| second wake's first request is exactly [system, user] on both (B5) | PARITY |
| shellm-run headers: model/effort/wake/launched_by/resumed/max_tokens and `--context-scope run` match | PARITY |
| trajectory step type sequence identical (seed + both wakes) | PARITY |
| responder/structured: both sides ran (exit 0) and made the same number of model calls | PARITY |
| responder/structured: request body #1 EXACT (model, max_tokens, stream, response_format/schema, every message incl. identity text; time/ids masked) | DEVIATION |
| responder/structured: request body #2 EXACT (model, max_tokens, stream, response_format/schema, every message incl. identity text; time/ids masked) | DEVIATION |
| responder/structured: appended step types and FIELD SETS identical | PARITY |
| responder/text: both sides ran (exit 0) and made the same number of model calls | PARITY |
| responder/text: request body #1 EXACT (model, max_tokens, stream, response_format/schema, every message incl. identity text; time/ids masked) | DEVIATION |
| responder/text: appended step types and FIELD SETS identical | PARITY |
| wake shell env probe ran on both sides | PARITY |
| wake shell env: IDENTITY_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: IDENTITY_NAME (path relative to the identity dir) identical | PARITY |
| wake shell env: MEM_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: SKILLS_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: SKILLS_KERNEL_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: TRAJ_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: TRAJ_ID (path relative to the identity dir) identical | PARITY |
| wake shell env: THINKERS_DIR (path relative to the identity dir) identical | PARITY |
| wake shell env: SHELLM_HOME (path relative to the identity dir) identical | PARITY |
| wake shell env: CHATRC (path relative to the identity dir) identical | PARITY |
| wake shell env: THINK_MODEL (path relative to the identity dir) identical | PARITY |
| wake shell env: THINK_CONTEXT_TAIL (path relative to the identity dir) identical | PARITY |
| reasoning/final step FIELD SETS identical (incl. think_tok, cache_tok, served_by) for every model call | PARITY |
| reasoning/final usage VALUES identical (in_tok, out_tok, think_tok, cache_tok, served_by) | PARITY |
| reasoning/final thought and cmd VALUES identical for every model call | PARITY |
| `focus` command: absent in upstream bin/ and in the port (so the identity text must not advertise it) | PARITY |

