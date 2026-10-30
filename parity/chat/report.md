# chat — adversarial differential parity proof

Real Bash `headlong/bin/chat` vs TS port `headlong-ts/bin/chat.mjs`, identical inputs in isolated sandboxes; diffed stdout + stderr + exit code + on-disk trajectory BYTES.

- `node run-parity.mjs` (set `PARITY_BASH_CHAT`, `PARITY_TS_REPO`). Locale `LC_ALL=C`.
- Real `chat` shells to `traj` (headlong/bin on PATH), `jq`, `timeout` (STUBBED coreutils passthrough so reply inference + guard run as in the Linux sandbox).
- Normalized symmetrically: `<ID>` UUID, `<TS>` ISO ts, real script path -> `<CHAT>`. Pass = stdout+stderr+status+**stateRaw** all match.
- **stateRaw** = file bytes (strict, catches escaping). **stateSem** = JSON round-trip (semantic). Both reported so escaping-only divergences are visible.

## Result: 218/231 PARITY (94.4%)

| # | group | scenario | verdict | differing |
|---|---|---|---|---|
| 1 | global | help-short | PARITY | - |
| 2 | global | help-long | PARITY | - |
| 3 | global | help-word | PARITY | - |
| 4 | global | no-args-with-env | PARITY | - |
| 5 | global | no-args-without-env-dies | PARITY | - |
| 6 | global | unknown-command-with-env | PARITY | - |
| 7 | global | unknown-command-without-env | PARITY | - |
| 8 | global | traj-id-unset-dies | PARITY | - |
| 9 | send | send-basic | PARITY | - |
| 10 | send | send-multiword | PARITY | - |
| 11 | send | send-flags-interleaved | PARITY | - |
| 12 | send | send-from-explicit | PARITY | - |
| 13 | send | send-flag-value-looks-like-flag | PARITY | - |
| 14 | send | send-self-refuses | PARITY | - |
| 15 | send | send-stdin | PARITY | - |
| 16 | send | send-stdin-trailing-newlines | PARITY | - |
| 17 | send | send-stdin-whitespace-kept | PARITY | - |
| 18 | send | send-empty-stdin-dies | PARITY | - |
| 19 | send | send-no-default-from-dies | PARITY | - |
| 20 | send | send-no-to-dies | PARITY | - |
| 21 | send | send-from-missing-value | DIVERGE | stderr |
| 22 | send | send-to-empty-value | DIVERGE | stderr |
| 23 | send | send-multibyte | PARITY | - |
| 24 | send | send-del-char-stdin | DIVERGE | stateRaw |
| 25 | send | send-nul-char-stdin | DIVERGE | stderr, stateRaw |
| 26 | send | send-with-source-url | PARITY | - |
| 27 | send | send-source-url-empty-value-dies | DIVERGE | stderr |
| 28 | send-file | send-file-basic | PARITY | - |
| 29 | send-file | send-file-strip-trailing-nl | PARITY | - |
| 30 | send-file | send-file-subdir-basename | PARITY | - |
| 31 | send-file | send-file-missing | PARITY | - |
| 32 | send-file | send-file-missing-before-fromto | PARITY | - |
| 33 | send-file | send-file-no-arg | PARITY | - |
| 34 | send-file | send-file-self-no-guard | PARITY | - |
| 35 | send-file | send-file-text-keeps-content-and-b64 | PARITY | - |
| 36 | send-file | send-file-binary-nul-marker-and-b64 | PARITY | - |
| 37 | send-file | send-file-binary-invalid-utf8-marker-and-b64 | PARITY | - |
| 38 | send-file | send-file-empty-dies | PARITY | - |
| 39 | send-file | send-file-too-large-dies | PARITY | - |
| 40 | send-file | send-file-max-bytes-non-integer-dies | PARITY | - |
| 41 | react | react-basic | PARITY | - |
| 42 | react | react-colon-wrapped | PARITY | - |
| 43 | react | react-plus-one | PARITY | - |
| 44 | react | react-invalid-emoji-dies | PARITY | - |
| 45 | react | react-lone-colon-dies | PARITY | - |
| 46 | react | react-flags-after-to-name | PARITY | - |
| 47 | react | react-reply-to-and-explicit-source-url | PARITY | - |
| 48 | react | react-reply-to-autolooks-up-source-url | PARITY | - |
| 49 | react | react-missing-to-dies | PARITY | - |
| 50 | react | react-missing-emoji-dies | PARITY | - |
| 51 | react | react-extra-args-dies | PARITY | - |
| 52 | react | react-no-from-dies | PARITY | - |
| 53 | pending | pending-none-text | PARITY | - |
| 54 | pending | pending-none-json | PARITY | - |
| 55 | pending | pending-unresolved-text | PARITY | - |
| 56 | pending | pending-unresolved-json | PARITY | - |
| 57 | pending | pending-resolved-empty | PARITY | - |
| 58 | pending | pending-max-age-excludes | PARITY | - |
| 59 | pending | pending-max-age-invalid-dies | DIVERGE | stderr |
| 60 | pending | pending-unknown-arg-dies | PARITY | - |
| 61 | reply | reply-infers-reply-to | PARITY | - |
| 62 | reply | reply-multiword | PARITY | - |
| 63 | reply | reply-multi-unanswered-picks-last | PARITY | - |
| 64 | reply | reply-already-answered-unstamped | PARITY | - |
| 65 | reply | reply-explicit-dup-skips | PARITY | - |
| 66 | reply | reply-explicit-fresh | PARITY | - |
| 67 | reply | reply-self-refuses | PARITY | - |
| 68 | reply | reply-no-name | PARITY | - |
| 69 | reply | reply-no-identity-dies | PARITY | - |
| 70 | reply | reply-reply-to-missing-value | DIVERGE | stderr |
| 71 | reply | reply-stdin | PARITY | - |
| 72 | history | history-default | PARITY | - |
| 73 | history | history-limit-1 | PARITY | - |
| 74 | history | history-empty | PARITY | - |
| 75 | history | history-fallbacks | PARITY | - |
| 76 | history | history-empty-string-arg | PARITY | - |
| 77 | history | history-zero | PARITY | - |
| 78 | history | history-plus-n | PARITY | - |
| 79 | history | history-negative | PARITY | - |
| 80 | history | history-nonnumeric | PARITY | - |
| 81 | history | history-float | PARITY | - |
| 82 | history | history-huge-overflow | DIVERGE | stderr |
| 83 | history | history-huge-overflow-plus | PARITY | - |
| 84 | convo-memory | person-key-slack-thread | PARITY | - |
| 85 | convo-memory | person-key-slack-dm | PARITY | - |
| 86 | convo-memory | person-key-telegram | PARITY | - |
| 87 | convo-memory | person-key-pwa | PARITY | - |
| 88 | convo-memory | person-key-bare-name | PARITY | - |
| 89 | convo-memory | thread-key-slack-thread | PARITY | - |
| 90 | convo-memory | thread-key-slack-dm-empty | PARITY | - |
| 91 | convo-memory | with-groups-threads-and-dm-json | PARITY | - |
| 92 | convo-memory | with-text-output | PARITY | - |
| 93 | convo-memory | with-since-7d-drops-old | PARITY | - |
| 94 | convo-memory | with-n-caps-and-accepts-person-key | PARITY | - |
| 95 | convo-memory | with-unrelated-name-empty | PARITY | - |
| 96 | convo-memory | thread-returns-everyone-json | PARITY | - |
| 97 | convo-memory | thread-since-bounds-window | PARITY | - |
| 98 | convo-memory | with-plus-thread-union | PARITY | - |
| 99 | convo-memory | thread-on-dm-empty | PARITY | - |
| 100 | convo-memory | thread-key-as-thread-arg | PARITY | - |
| 101 | convo-memory | with-aliases-merge-via-mem-dir | PARITY | - |
| 102 | convo-memory | history-count-still-validated-with-flags-present | PARITY | - |
| 103 | convo-memory | reply-follow-up-bypasses-duplicate-guard | PARITY | - |
| 104 | convo-memory | reply-plain-duplicate-still-refused | PARITY | - |
| 105 | repl | repl-no-tui-127 | DIVERGE | stderr |
| 106 | sync-e-target | send-user-dm-ok | PARITY | - |
| 107 | sync-e-target | send-workspace-user-ok | PARITY | - |
| 108 | sync-e-target | send-channel-ok | PARITY | - |
| 109 | sync-e-target | send-private-channel-ok | PARITY | - |
| 110 | sync-e-target | send-im-channel-ok | PARITY | - |
| 111 | sync-e-target | send-user-channel-ok | PARITY | - |
| 112 | sync-e-target | send-user-channel-thread-ok | PARITY | - |
| 113 | sync-e-target | send-lowercase-id-refused | PARITY | - |
| 114 | sync-e-target | send-bare-refused | PARITY | - |
| 115 | sync-e-target | send-empty-after-prefix-refused | PARITY | - |
| 116 | sync-e-target | send-trailing-dash-refused | PARITY | - |
| 117 | sync-e-target | send-thread-not-numeric-refused | PARITY | - |
| 118 | sync-e-target | send-four-parts-refused | PARITY | - |
| 119 | sync-e-target | send-non-slack-name-passes-ok | PARITY | - |
| 120 | sync-e-target | send-telegram-passes-ok | PARITY | - |
| 121 | sync-e-target | reply-invalid-slack-refused | PARITY | - |
| 122 | sync-e-target | reply-valid-slack-ok | PARITY | - |
| 123 | sync-e-target | react-invalid-slack-refused | PARITY | - |
| 124 | sync-e-target | send-file-invalid-slack-refused | PARITY | - |
| 125 | sync-e-target | send-file-missing-file-beats-target | PARITY | - |
| 126 | sync-e-target | send-file-valid-slack-ok | PARITY | - |
| 127 | sync-e-json | send-action-object-refused | PARITY | - |
| 128 | sync-e-json | send-action-object-spaced-refused | PARITY | - |
| 129 | sync-e-json | send-pretty-printed-refused | PARITY | - |
| 130 | sync-e-json | send-fenced-refused | PARITY | - |
| 131 | sync-e-json | send-fenced-tilde-refused | PARITY | - |
| 132 | sync-e-json | send-leading-blank-lines-refused | PARITY | - |
| 133 | sync-e-json | send-single-quoted-key-refused | PARITY | - |
| 134 | sync-e-json | send-escaped-quotes-key-refused | PARITY | - |
| 135 | sync-e-json | send-object-without-action-ok | PARITY | - |
| 136 | sync-e-json | send-action-word-in-prose-ok | PARITY | - |
| 137 | sync-e-json | send-brace-not-first-line-ok | PARITY | - |
| 138 | sync-e-json | send-array-of-actions-ok | PARITY | - |
| 139 | sync-e-json | send-action-key-past-line-40-ok | PARITY | - |
| 140 | sync-e-json | send-action-key-at-line-40-refused | PARITY | - |
| 141 | sync-e-json | send-unquoted-action-ok | PARITY | - |
| 142 | sync-e-json | send-action-object-force-ok | PARITY | - |
| 143 | sync-e-json | send-action-object-stdin-refused | PARITY | - |
| 144 | sync-e-json | send-action-object-from-person-delivered-in | PARITY | - |
| 145 | sync-e-json | send-action-object-no-identity-name | PARITY | - |
| 146 | sync-e-json | reply-action-object-refused | PARITY | - |
| 147 | sync-e-json | reply-action-object-force-ok | PARITY | - |
| 148 | sync-e-json | reply-plain-text-ok | PARITY | - |
| 149 | sync-e-repeat | send-repeat-within-24h-refused | PARITY | - |
| 150 | sync-e-repeat | send-repeat-force-ok | PARITY | - |
| 151 | sync-e-repeat | send-different-text-ok | PARITY | - |
| 152 | sync-e-repeat | send-same-text-other-destination-ok | PARITY | - |
| 153 | sync-e-repeat | send-repeat-outside-window-ok | PARITY | - |
| 154 | sync-e-repeat | send-repeat-window-env-shrinks-ok | PARITY | - |
| 155 | sync-e-repeat | send-repeat-window-env-widens-refused | PARITY | - |
| 156 | sync-e-repeat | send-repeat-window-zero-disables | PARITY | - |
| 157 | sync-e-repeat | send-repeat-window-seconds | PARITY | - |
| 158 | sync-e-repeat | send-repeat-window-empty-defaults-24h | PARITY | - |
| 159 | sync-e-repeat | send-inbound-repeat-never-refused | PARITY | - |
| 160 | sync-e-repeat | send-long-exact-repeat-refused | PARITY | - |
| 161 | sync-e-repeat | send-long-prefix-only-ok | PARITY | - |
| 162 | sync-e-repeat | send-repeat-stdin-refused | PARITY | - |
| 163 | sync-e-repeat | reply-unstamped-repeat-refused | PARITY | - |
| 164 | sync-e-repeat | reply-unstamped-repeat-force-ok | PARITY | - |
| 165 | sync-e-repeat | reply-stamped-same-text-within-10m-refused | PARITY | - |
| 166 | sync-e-repeat | reply-stamped-24h-text-exempt | PARITY | - |
| 167 | sync-e-repeat | reply-stamped-window-env-zero-ok | PARITY | - |
| 168 | sync-e-repeat | reply-stamped-window-env-1h-refused | PARITY | - |
| 169 | sync-e-repeat | reply-inferred-stamp-exempt-from-24h | PARITY | - |
| 170 | sync-e-key | send-key-first-ok-stamps-key | PARITY | - |
| 171 | sync-e-key | send-key-already-sent-refused | PARITY | - |
| 172 | sync-e-key | send-key-already-sent-force-ok | PARITY | - |
| 173 | sync-e-key | send-key-previous-delivered-refused | PARITY | - |
| 174 | sync-e-key | send-key-previous-failed-ok | PARITY | - |
| 175 | sync-e-key | send-key-previous-skipped-ok | PARITY | - |
| 176 | sync-e-key | send-key-empty-value-dies | DIVERGE | stderr |
| 177 | sync-e-key | send-key-missing-value-dies | DIVERGE | stderr |
| 178 | sync-e-key | send-key-before-repeat-order | PARITY | - |
| 179 | sync-e-sent | sent-text | PARITY | - |
| 180 | sync-e-sent | sent-json | PARITY | - |
| 181 | sync-e-sent | sent-n-limit | PARITY | - |
| 182 | sync-e-sent | sent-n-zero | PARITY | - |
| 183 | sync-e-sent | sent-n-zero-json | PARITY | - |
| 184 | sync-e-sent | sent-since-10m | PARITY | - |
| 185 | sync-e-sent | sent-since-2h-json | PARITY | - |
| 186 | sync-e-sent | sent-since-seconds | PARITY | - |
| 187 | sync-e-sent | sent-since-none-match | PARITY | - |
| 188 | sync-e-sent | sent-no-messages-text | PARITY | - |
| 189 | sync-e-sent | sent-no-messages-json | PARITY | - |
| 190 | sync-e-sent | sent-only-inbound-json | PARITY | - |
| 191 | sync-e-sent | sent-other-identity | PARITY | - |
| 192 | sync-e-sent | sent-identity-unset-defaults-agent | PARITY | - |
| 193 | sync-e-sent | sent-unknown-arg-dies | PARITY | - |
| 194 | sync-e-sent | sent-bad-count-dies | PARITY | - |
| 195 | sync-e-sent | sent-since-missing-value-dies | DIVERGE | stderr |
| 196 | sync-e-sent | sent-unresolvable-traj-dies | PARITY | - |
| 197 | sync-e-sent | sent-builds-delivery-and-key-index | PARITY | - |
| 198 | sync-e-sent | sent-duplicate-delivery-newest-wins | PARITY | - |
| 199 | sync-e-sent | sent-replayed-message-step-deduped | PARITY | - |
| 200 | sync-e-sent | sent-non-string-content-and-filename-preferred | PARITY | - |
| 201 | sync-e-index | index-multiline-header-stable | PARITY | - |
| 202 | sync-e-index | index-multiline-header-sent | PARITY | - |
| 203 | sync-e-index | index-header-changed-rebuilds | PARITY | - |
| 204 | sync-e-index | index-replaced-inode-rebuilds | PARITY | - |
| 205 | sync-e-index | index-shrunk-below-offset-rebuilds | PARITY | - |
| 206 | sync-e-index | index-interrupted-update-trims-extra-rows | PARITY | - |
| 207 | sync-e-index | index-file-shorter-than-recorded-rebuilds | PARITY | - |
| 208 | sync-e-index | index-old-format-offset-upgraded | PARITY | - |
| 209 | sync-e-index | index-old-format-missing-deliveries-rebuilds | PARITY | - |
| 210 | sync-e-index | index-partial-last-line-left-for-next-call | PARITY | - |
| 211 | sync-e-index | index-only-partial-line | PARITY | - |
| 212 | sync-e-index | index-no-new-data-releases-lock | PARITY | - |
| 213 | sync-e-index | lock-dead-owner-taken-over | PARITY | - |
| 214 | sync-e-index | lock-ownerless-fresh-left-alone | PARITY | - |
| 215 | sync-e-index | lock-ownerless-old-taken-over | PARITY | - |
| 216 | sync-e-index | lock-live-holder-left-alone | PARITY | - |
| 217 | sync-e-index | lock-pid-reused-different-start-taken-over | PARITY | - |
| 218 | sync-e-index | lock-other-pid-namespace-never-judged | PARITY | - |
| 219 | sync-e-index | lock-steal-dir-fresh-blocks-takeover | PARITY | - |
| 220 | sync-e-index | lock-steal-dir-stale-cleared | PARITY | - |
| 221 | sync-e-index | lock-held-send-repeat-check-skips-update | PARITY | - |
| 222 | sync-e-index | reset-without-offline-dies | PARITY | - |
| 223 | sync-e-index | reset-extra-arg-dies | PARITY | - |
| 224 | sync-e-index | reset-clears-derived-files | PARITY | - |
| 225 | sync-e-index | reset-idempotent-when-nothing-there | PARITY | - |
| 226 | sync-e-index | reset-refuses-live-holder | PARITY | - |
| 227 | sync-e-index | reset-dead-owner-cleared | PARITY | - |
| 228 | sync-e-index | reset-refuses-lock-with-unknown-contents | PARITY | - |
| 229 | sync-e-index | reset-refuses-symlinked-lock | PARITY | - |
| 230 | sync-e-index | reset-unremovable-index-keeps-lock | DIVERGE | stderr |
| 231 | sync-e-index | reset-then-history-rebuilds-note | PARITY | - |

## Divergences (detail)

### send / send-from-missing-value
- argv: `["send","--to","bob","--from"]`
- note: DOC-DEVIATION: bash ${2:?} text vs port clean msg
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 121: 2: --from requires a name\n"
      ts  : "chat: error: --from requires a name\n"
    stateRaw: MATCH
    idxState: MATCH
```

### send / send-to-empty-value
- argv: `["send","--to","","hi"]`
- note: adversarial DOC-DEVIATION: --to '' -> ${2:?} dies (empty triggers colon form)
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 122: 2: --to requires a name\n"
      ts  : "chat: error: --to requires a name\n"
    stateRaw: MATCH
    idxState: MATCH
```

### send / send-del-char-stdin
- argv: `["send","--to","bob"]`
- note: adversarial ESCAPING: DEL 0x7f -> jq \u007f vs JSON.stringify literal byte
- exit: bash=0 ts=0
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: MATCH
    stateRaw: DIFFER
      bash: "{\"type\":\"trajectory\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}\n{\"type\":\"message\",\"content\":\"A\\u007fB\",\"from\":\"alice\",\"to\":\"bob\",\"source\":\"chat\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}"
      ts  : "{\"type\":\"trajectory\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}\n{\"type\":\"message\",\"content\":\"AB\",\"from\":\"alice\",\"to\":\"bob\",\"source\":\"chat\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}"
    idxState: MATCH
```

### send / send-nul-char-stdin
- argv: `["send","--to","bob"]`
- note: adversarial NUL: bash $(cat) drops 0x00, port keeps it
- exit: bash=0 ts=0
- stateSem (semantic on-disk): DIFFER
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 132: warning: command substitution: ignored null byte in input\nMessage sent.\n"
      ts  : "Message sent.\n"
    stateRaw: DIFFER
      bash: "{\"type\":\"trajectory\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}\n{\"type\":\"message\",\"content\":\"AB\",\"from\":\"alice\",\"to\":\"bob\",\"source\":\"chat\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}"
      ts  : "{\"type\":\"trajectory\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}\n{\"type\":\"message\",\"content\":\"A\\u0000B\",\"from\":\"alice\",\"to\":\"bob\",\"source\":\"chat\",\"step_id\":\"<ID>\",\"ts\":\"<TS>\"}"
    idxState: MATCH
```

### send / send-source-url-empty-value-dies
- argv: `["send","--to","bob","--source-url","","hello"]`
- note: adversarial DOC-DEVIATION: --source-url '' -> ${2:?} dies (same class as --to '')
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 123: 2: --source-url requires a URL\n"
      ts  : "chat: error: --source-url requires a URL\n"
    stateRaw: MATCH
    idxState: MATCH
```

### pending / pending-max-age-invalid-dies
- argv: `["pending","--max-age","bogus"]`
- note: 1c: 2fed66c — --max-age shares _duration_s's --argjson crash class with history --since (bug #47)
- exit: bash=2 ts=2
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "jq: invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n"
      ts  : "chat: error: pending: --max-age bogus: invalid duration\n"
    stateRaw: MATCH
    idxState: MATCH
```

### reply / reply-reply-to-missing-value
- argv: `["reply","--reply-to"]`
- note: adversarial DOC-DEVIATION: --reply-to missing value ${2:?}
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 179: 2: --reply-to requires a step id\n"
      ts  : "chat: error: --reply-to requires a step id\n"
    stateRaw: MATCH
    idxState: MATCH
```

### history / history-huge-overflow
- argv: `["history","999999999999999999999"]`
- note: adversarial REAL DIVERGENCE: bash tail errors (rc1, empty) vs port prints all (rc0)
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "tail: illegal offset -- 999999999999999999999: Result too large\n"
      ts  : "chat: invalid history count: 999999999999999999999\n"
    stateRaw: MATCH
    idxState: MATCH
```

### repl / repl-no-tui-127
- argv: `["repl"]`
- note: adversarial DEVIATION: neither TUI on PATH -> rc127 both, exec-not-found stderr wording differs
- exit: bash=127 ts=127
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 1069: exec: shellm-tui: not found\n"
      ts  : "chat: shellm-tui: command not found\n"
    stateRaw: MATCH
    idxState: MATCH
```

### sync-e-key / send-key-empty-value-dies
- argv: `["send","--to","bob","--key","","x"]`
- note: DOC-DEVIATION: bash ${2:?} text vs port clean msg (same class as --to '')
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 125: 2: --key requires a key\n"
      ts  : "chat: error: --key requires a key\n"
    stateRaw: MATCH
    idxState: MATCH
```

### sync-e-key / send-key-missing-value-dies
- argv: `["send","--to","bob","x","--key"]`
- note: DOC-DEVIATION: bash ${2:?} text vs port clean msg
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 125: 2: --key requires a key\n"
      ts  : "chat: error: --key requires a key\n"
    stateRaw: MATCH
    idxState: MATCH
```

### sync-e-sent / sent-since-missing-value-dies
- argv: `["sent","--since"]`
- note: DOC-DEVIATION: bash ${2:?} text vs port clean msg
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "<CHAT>: line 942: 2: --since requires a duration like 24h\n"
      ts  : "chat: error: --since requires a duration like 24h\n"
    stateRaw: MATCH
    idxState: MATCH
```

### sync-e-index / reset-unremovable-index-keeps-lock
- argv: `["index-reset","--offline"]`
- note: DOC-DEVIATION: bash also leaks rm's own 'is a directory' stderr line (external tool wording); the chat error line is identical
- exit: bash=1 ts=1
- stateSem (semantic on-disk): MATCH
```
    stdout: MATCH
    stderr: DIFFER
      bash: "rm: <SB>/traj/12345678-root/messages.jsonl: is a directory\nchat: error: index-reset: could not remove derived indexes; lock retained\n"
      ts  : "chat: error: index-reset: could not remove derived indexes; lock retained\n"
    stateRaw: MATCH
    idxState: MATCH
```

