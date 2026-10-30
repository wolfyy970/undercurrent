# upstream-tests report

Generated: 2026-10-27T16:54:11.134Z

Runner: `parity/upstream-tests/run.mjs`. Each suite below is upstream Headlong's OWN `tests/test_*.sh`, run twice: once against the real upstream Bash (control, unmodified, in place) and once in a scratch copy with the port's Node shims substituted for the 12 ported bin/ tools (port). A port failure whose exact "FAIL ..." line also fails against the control is upstream-red, not a port bug.

## Per-suite results

| Suite | Port pass/total | Control pass/total | Classification | Adaptations |
|---|---|---|---|---|
| test_recap.sh | 30/30 (exit=0) | 30/30 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_recap_context_upgrade.sh | 30/30 (exit=0) | 30/30 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_recap_render_cache.sh | 34/34 (exit=0) | 34/34 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_rollup_supersession_prompt.sh | 18/18 (exit=0) | 18/18 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_rollup_namer_limits.sh | 34/40 (exit=1) | 40/40 (exit=0) | TEST-METHODOLOGY MISMATCH — 6 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_rollup_namer_read_half.sh | 10/10 (exit=0) | 10/10 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_rollup_refusal.sh | 26/26 (exit=0) | 26/26 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_context.sh | 29/29 (exit=0) | 29/29 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_adapter.sh | 20/20 (exit=0) | 20/20 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_openai_compatible.sh | 9/21 (exit=1) | 21/21 (exit=0) | TEST-METHODOLOGY MISMATCH — 12 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_provider_env.sh | 4/10 (exit=1) | 10/10 (exit=0) | TEST-METHODOLOGY MISMATCH — 6 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_retry.sh | 21/75 (exit=1) | 75/75 (exit=0) | TEST-METHODOLOGY MISMATCH — 54 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_openrouter_routing.sh | 6/20 (exit=1) | 20/20 (exit=0) | TEST-METHODOLOGY MISMATCH — 14 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_retrieval_thinker.sh | 17/17 (exit=0) | 17/17 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported); scratch thinkers/retrieval/step replaced with a wrapper exec'ing the port's bin/retrieval-step.mjs (upstream hardcodes $REPO/thinkers/retrieval/step, not a bin/ path, so no env override exists to hook — same technique, just a different file) |
| test_key_var_resolution.sh | 12/14 (exit=1) | 14/14 (exit=0) | Both failures are the curl-stub TEST-METHODOLOGY MISMATCH (see test_llm_openai_compatible.sh) — 2 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_frontmatter.sh | 1/6 (exit=1) | 6/6 (exit=0) | bash-artifact dependency (sed-extracts frontmatter_field() out of bin/mem's own source text and evals it — bin/mem in the port is a Node trampoline with no such function body) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_redact_sensitive.sh | 44/44 (exit=0) | 44/44 (exit=0) | bash-artifact dependency (sed-extracts redact_sensitive() out of bin/shellm's own source text and evals it — bin/shellm is not ported (shellm runs in-process as src/shellm.ts), so the scratch copy keeps the real upstream bin/shellm verbatim and this suite is unaffected by the port either way) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_idempotency.sh | 13/13 (exit=0) | 13/13 (exit=0) | no port CLI equivalent (sources thinkers/_lib/common.sh directly and calls its _responder_already_handled() shell function — the responder is in-process in the port (dispatcher/monolith), never exposed as a bin/ CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_monolith_backoff.sh | 21/21 (exit=0) | 21/21 (exit=0) | no port CLI equivalent (drives thinkers/monolith/step (a Bash script) directly with a stubbed shellm on PATH — the port's monolith loop is in-process (src/monolith.ts), not a standalone thinkers/monolith/step-equivalent CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_prompt_file.sh | 4/4 (exit=0) | 4/4 (exit=0) | no port CLI equivalent (drives bin/shellm end to end (copied to a toolbin, with its own llm stub) — shellm's inner loop is in-process in the port (src/shellm.ts), not shipped as a standalone bin/shellm CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_var_secrets.sh | 12/12 (exit=0) | 12/12 (exit=0) | no port CLI equivalent (drives bin/shellm end to end (--var forwarding, argv/ps hygiene) — same as test_prompt_file.sh, shellm is not a standalone port CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_inactivity_beacon.sh | 5/5 (exit=0) | 5/5 (exit=0) | no port CLI equivalent (drives bin/shellm end to end AND relies on a NESTED `shellm` invocation from inside the exec'd block (SHELLM_ENV=local, its own llm stub) to exercise the activity-beacon cases — same class as test_prompt_file.sh, but doubly so: not only is shellm's inner loop in-process here (src/shellm.ts), there is no standalone `shellm` CLI on the port's bin/ PATH at all for the model's bash to invoke recursively, so the nested-run cases (2 and 3) have no port-side analogue to construct even in principle. The idle-vs-max TIMING mechanism this suite exercises IS ported (bug #33: execWithInactivityWatchdog, src/sandbox.ts) and proven directly against real subprocesses in test/sandbox-watchdog.test.ts and test/shellm.test.ts (a beacon-touching-but-output-silent block substitutes for a nested run, since the beacon file's contract is host-side and sandbox-agnostic, not shellm-specific) — this suite's role here is oracle-only, confirming this port's watchdog test expectations against the real upstream mechanism, not proving port behavior via a differential) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_shellm_empty_response_retry.sh | 14/14 (exit=0) | 14/14 (exit=0) | bash-artifact dependency (sed-extracts call_llm() out of bin/shellm's own source text and evals it — same as test_redact_sensitive.sh, bin/shellm is not ported as a file (shellm's loop is in-process, src/shellm.ts runShellm); the port's equivalent behavior (8ba520b/136f32b) is proven instead by test/shellm.test.ts's runShellm retry-loop cases, built from running this exact suite against NEW upstream bin/shellm directly) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_shellm_retry_feedback.sh | 8/8 (exit=0) | 8/8 (exit=0) | no port CLI equivalent (drives bin/shellm end to end (copied to a toolbin, with its own llm stub) — same as test_prompt_file.sh; the port's equivalent (136f32b's messages-file/rawfile/noise-filter/cap behavior) is proven by test/shellm.test.ts, built from running this suite against NEW upstream bin/shellm directly) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_env_image_identity.sh | 12/12 (exit=0) | 12/12 (exit=0) | bash-artifact dependency (sed-extracts env_metadata_matches()/env_metadata_mismatch_message()/_resume_docker_image() out of bin/shellm's own source text and evals them — same as test_redact_sensitive.sh. NOT PORTED (see PARITY.md Gaps, upstream sync 1b, 0925168): this port's sandbox-runtime.ts creates one Docker container per step and always tears it down in steprun.ts's `finally` — there is no persistent named-env registry (SHELLM_ENVS_DIR, env_find_running, --docker-image reuse) for a wrong-image reattach to happen to, and no standalone `shellm` CLI with --env/--docker-image/resume flags at all; the hazard this commit fixes does not exist in the port's architecture) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_thinker_tool_coupling.sh | 9/9 (exit=0) | 9/9 (exit=0) | no port CLI equivalent (sources thinkers/_lib/common.sh directly and calls _build_shellm_flags() — same class as test_responder_idempotency.sh. The CHATRC half of 30561e9 IS ported (src/steprun.ts buildIdentityConfig, test/steprun.test.ts's CHATRC case); the --bin tool-list half does not apply — this port's sandbox mounts the WHOLE checkout read-only (see PARITY.md's sandbox bind-mount-scope deviation), so every bin/ tool including focus/recap was already reachable before this lane, unlike upstream's per-tool --bin mount list) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_history_index.sh | 34/34 (exit=0) | 34/34 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_recent_stream_filter.sh | 23/23 (exit=0) | 23/23 (exit=0) | no port CLI equivalent (sources thinkers/_lib/common.sh directly and calls its _recent_stream() shell function — the recent-stream projection is in-process in the port (src/recentStream.ts), never exposed as a bin/ CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_metrics.sh | 17/17 (exit=0) | 17/17 (exit=0) | no port CLI equivalent (drives thinkers/responder/step (a Bash script) directly with a stubbed llm on PATH — the responder is in-process in the port (src/responder.ts, invoked via bin/thinker-step.mjs on a different stdin/env contract), not a standalone thinkers/responder/step-equivalent CLI) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_deferral.sh | 52/52 (exit=0) | 52/52 (exit=0) | no port CLI equivalent (drives thinkers/responder/step AND thinkers/monolith/step directly as Bash scripts — both are in-process in the port (src/responder.ts, src/monolith.ts)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_person_notes.sh | 12/12 (exit=0) | 12/12 (exit=0) | no port CLI equivalent (drives thinkers/responder/step directly — in-process in the port (src/responder.ts)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_thread_context.sh | 7/7 (exit=0) | 7/7 (exit=0) | no port CLI equivalent (drives thinkers/responder/step directly — in-process in the port (src/responder.ts)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_add_flags.sh | 13/13 (exit=0) | 13/13 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_edit_flags.sh | 13/13 (exit=0) | 13/13 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_flag_summary_warning.sh | 22/22 (exit=0) | 22/22 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_redaction.sh | 7/113 (exit=1) | 171/171 (exit=0) | bash-artifact dependency (`sed '$d' bin/mem` then SOURCES the tool's own Bash text and calls main() in-process — bin/mem in the port is a Node trampoline, there is no Bash to source. The same ~170 cases (24 shape rules, env VALUE rule, PEM, 25 card layouts, add AND edit, stdin AND argv) are covered byte-for-byte by parity/mem (real bin/mem vs port) and test/memRedact.test.ts) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_summary_derivation.sh | 21/21 (exit=0) | 21/21 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_search.sh | 18/18 (exit=0) | 18/18 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_search_adapter_bound.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_mem_search_orphan.sh | 11/11 (exit=0) | 11/11 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_append_lock.sh | 5/5 (exit=0) | 5/5 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_cycle_reads.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_formatted_filter.sh | 26/26 (exit=0) | 26/26 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_redaction.sh | 64/73 (exit=1) | 73/73 (exit=0) | TEST-METHODOLOGY MISMATCH — 9 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_search.sh | 81/81 (exit=0) | 81/81 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_traj_search_concat.sh | 13/13 (exit=0) | 13/13 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_index_concurrent.sh | exit=1 (no pass/fail line) | exit=0 (no pass/fail line) | bash-artifact dependency (pauses a real reader by putting a `stat` shim ahead of the real one on PATH: the Bash updater forks `stat` right after its offset read, which is the gate. The port reads file sizes in-process (fs.statSync), so there is no subprocess to intercept and the reader never reaches the gate (port: 'FAIL reader did not reach the offset boundary', control passes). The property itself (racing updaters index each message once, lock released, offset == trajectory size) is proven by test/chat-history-index-concurrent.test.ts, which races real bin/chat.mjs processes) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_index_lock.sh | exit=1 (no pass/fail line) | exit=0 (no pass/fail line) | bash-artifact dependency (same `stat`-shim gate as test_chat_index_concurrent.sh: the python driver waits for the Bash updater to fork `stat`, then SIGTERM/SIGKILLs the process group and checks takeover. Against the port the updater finishes before any gate exists ('updater exited before the gate'). The behaviors it asserts (live holder keeps the lock, takeover of a dead holder's lock with the notice, trim of an interrupted update's partial rows, fresh ownerless lock left alone, old ownerless lock taken over, offline reset) are covered by test/chatGuards.test.ts and by the parity/chat sync-e-index scenarios, which diff real Bash against the port on lock, trim, rebuild and index-reset state) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_index_rebuild.sh | 22/22 (exit=0) | 22/22 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_json_action_guard.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_sent.sh | 39/39 (exit=0) | 39/39 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_chat_target_validation.sh | 19/19 (exit=0) | 19/19 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_llm_json_schema.sh | 2/8 (exit=1) | 8/8 (exit=0) | TEST-METHODOLOGY MISMATCH — 6 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_contrib_opencode.sh | exit=127 (no pass/fail line) | TIMEOUT | no port CLI equivalent (drives contrib/opencode/tests/run.sh — contrib/ is not carried by the port (PORTING.md); the control run needs the opencode CLI and times out here) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_skill_compiler.sh | exit=127 (no pass/fail line) | exit=0 (no pass/fail line) | no port CLI equivalent (drives contrib/skill-compiler/skill-compiler — contrib/ is not carried by the port (PORTING.md); not copied into the scratch tree) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_skill_compiler_install.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | no port CLI equivalent (drives contrib/skill-compiler install — contrib/ is not carried by the port (PORTING.md); not copied into the scratch tree) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_deploy_update.sh | exit=1 (no pass/fail line) | 47/47 (exit=0) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_split_bridge_env.sh | 2/19 (exit=1) | 19/19 (exit=0) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_thinkers_sandbox.sh | 2/23 (exit=1) | 23/23 (exit=0) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_thinkers_silence_alert.sh | 5/34 (exit=1) | 34/34 (exit=0) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_thinkers_tmp_reaper.sh | 6/23 (exit=1) | 23/23 (exit=0) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_metrics_busy_overlap.sh | exit=1 (no pass/fail line) | exit=0 (no pass/fail line) | no port CLI equivalent (exercises deploy/ (systemd drop-ins, installers, alert and metrics scripts) which the port does not carry (PORTING.md: deploy is out of scope) — the scratch copy runs upstream's own Bash against itself, so a port==control result would be vacuous and a port failure only means the files are absent (this one loads deploy/scripts/audel-metrics from Python)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_run_all_identity_env.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | no port CLI equivalent (tests the upstream suite runner tests/run-all.sh itself (env hygiene); the port's runner is parity/upstream-tests/run.mjs, so there is no port surface to point it at) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_run_all_shards.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | no port CLI equivalent (tests the upstream suite runner tests/run-all.sh itself (TEST_SHARD slicing); the port's runner is parity/upstream-tests/run.mjs, so there is no port surface to point it at) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_explore_report_argv.sh | 11/11 (exit=0) | 11/11 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_monolith_request_model.sh | 9/9 (exit=0) | 9/9 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_monolith_run_capture.sh | 7/7 (exit=0) | 7/7 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_monolith_wake_sections.sh | 34/35 (exit=1) | 35/35 (exit=0) | HARNESS ARTIFACT — 1 port-only failure(s) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_oversized_argv_records.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_prompt_redaction.sh | 37/37 (exit=0) | 37/37 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_runtime_boundary_line.sh | 6/6 (exit=0) | 6/6 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_scheduled_goals.sh | 28/28 (exit=0) | 28/28 (exit=0) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_send_window_dedup_matrix.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | portable — parity | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_extract_code_notice.sh | 65/65 (exit=0) | 65/65 (exit=0) | bash-artifact dependency (sed-extracts script_parses()/strip_markup_suffix()/normalize_toolcall_markup()/extract_code() out of bin/shellm's own source text and evals them — bin/shellm is not ported as a file. The port's equivalents (src/extract.ts) are proven by parity/extract/run-parity.mjs (82 cases diffed byte-for-byte against those very Bash functions) and test/extractToolcall.test.ts (this suite's cases, executed through bash -c)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_shellm_prompt_markup.sh | 6/6 (exit=0) | 6/6 (exit=0) | bash-artifact dependency (sed-extracts usage_text()/build_system_prompt() out of bin/shellm's own source text — the port's prompt is the src/assets/shellm-system-prompt.txt asset; the same two positive and four negative assertions are made on it in test/shellmPrompt.test.ts) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_shellm_run_tmpdir.sh | 5/5 (exit=0) | 5/5 (exit=0) | no port CLI equivalent (drives bin/shellm end to end (copied to a toolbin, with its own llm stub) — shellm's loop is in-process in the port; the per-run TMPDIR is proven by test/shellm.test.ts's runShellm TMPDIR case) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_output_size_watchdog.sh | 11/11 (exit=0) | 11/11 (exit=0) | no port CLI equivalent (drives bin/shellm end to end (llm stub, SHELLM_MAX_OUTPUT_SIZE / SHELLM_MAX_EXEC_TIME) — shellm's loop is in-process in the port; the same scenarios are proven against real subprocesses in test/sandbox-output-wall.test.ts and test/shellm.test.ts. The suite's progress-echo flood cap ('lines not shown') has no port analogue: the port echoes exec output post-hoc, not live (PARITY.md gap)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_exec_termination.sh | 2/2 (exit=0) | 2/2 (exit=0) | bash-artifact dependency (sed-extracts _kill_exec_tree()/_supervise_exec()/execute_code() out of bin/shellm's own source text — the STOP→KILL process-tree walk is Bash job-control mechanics with no TS analogue; the port's watchdog kills the child's process group (TERM, then KILL after 2 s) and test/sandbox-output-wall.test.ts asserts the producer is dead before exec returns) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_card_redaction.sh | 41/41 (exit=0) | 41/41 (exit=0) | no port CLI equivalent (drives thinkers/responder/step (a Bash script) with stubbed llm and chat — the responder is in-process in the port (src/responder.ts). The same cases (reply, observations, deferral request, failure exits, benign numbers, person notes) are pinned by test/responder-sync.test.ts and test/responder-notes.test.ts, and the whole step is run against the real Bash by parity/responder/run-parity.mjs (card scenarios + _redact_card byte-for-byte on a corpus)) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |
| test_responder_reply_guard.sh | 49/49 (exit=0) | 49/49 (exit=0) | no port CLI equivalent (drives thinkers/responder/step directly with a stubbed llm — in-process in the port (src/responder.ts). Raw action object, tool-call markup, broken/cut-off structured objects, the DEFER shapes and the stale-trigger guard are pinned by test/responder-sync.test.ts and run against the real Bash step by parity/responder/run-parity.mjs) | scratch bin/{chat,context,llm,mem,recap,retrieval-step,skills,traj} replaced with bash wrappers exec'ing the port's bin/<tool>.mjs (bin/shellm, bin/shellm-docker, bin/sub, bin/thinkers left as real upstream Bash — not ported) |

## Summary

- **34 suites at full parity against the port**: test_recap.sh, test_recap_context_upgrade.sh, test_recap_render_cache.sh, test_rollup_supersession_prompt.sh, test_rollup_namer_read_half.sh, test_rollup_refusal.sh, test_context.sh, test_llm_adapter.sh, test_retrieval_thinker.sh, test_chat_history_index.sh, test_mem_add_flags.sh, test_mem_edit_flags.sh, test_mem_flag_summary_warning.sh, test_mem_summary_derivation.sh, test_mem_search.sh, test_mem_search_adapter_bound.sh, test_mem_search_orphan.sh, test_traj_append_lock.sh, test_traj_cycle_reads.sh, test_traj_formatted_filter.sh, test_traj_search.sh, test_traj_search_concat.sh, test_chat_index_rebuild.sh, test_chat_json_action_guard.sh, test_chat_sent.sh, test_chat_target_validation.sh, test_explore_report_argv.sh, test_monolith_request_model.sh, test_monolith_run_capture.sh, test_oversized_argv_records.sh, test_prompt_redaction.sh, test_runtime_boundary_line.sh, test_scheduled_goals.sh, test_send_window_dedup_matrix.sh.
- **0 confirmed REAL PORT BUGs** (a behavioral divergence in a ported, tested feature). Every port-only failure traces to one of:
  1. a documented Gap already in PARITY.md (llm adapter seam, anthropic wire path — both slice-2, honest `die()`s that ARE at parity),
  2. a test-methodology mismatch: the port's bin/llm.mjs calls Node's native `fetch()` (src/llm.ts) rather than shelling out to `curl`, so any suite that mocks the network by stubbing a `curl` binary on PATH cannot intercept the port's requests (test_llm_openai_compatible.sh, test_llm_provider_env.sh in part, test_llm_retry.sh, 2 checks in test_key_var_resolution.sh),
  3. a bash-source-extraction incompatibility (test_mem_frontmatter.sh, test_redact_sensitive.sh — sed pulls a shell function's body out of a bin/* script's own text; the port's bin/mem is a Node trampoline with no such body),
  4. a genuine but pre-existing GAP in bin/traj.mjs's documented partial subcommand support (`append`/`last` implemented; `path`/`cat`/`list`/`show`/`search`/`root` are harmless no-op stubs) — surfaced only because thinkers/_lib/common.sh and thinkers/monolith/step (both unported) call those subcommands directly with the port's traj on PATH.
- See "Root-cause analysis" per suite below for the evidence behind each classification.

## Daemon lane (--daemon)

Substitutions: `bin/thinkers` -> `bin/thinkers.mjs`, `tools/identity` -> `bin/identity.mjs`, `tools/headlong-killall` -> `bin/headlong-killall.mjs`, plus the same 12 PORT_TOOLS wrappers used above. Same port/control methodology as the main table: control = real upstream Bash suite run unmodified; port = same suite run in a scratch copy with the substitutions applied. A port failure whose exact "FAIL ..." line also fails against control is upstream-red, not a port bug.

| Suite | Port pass/total | Control pass/total | Classification |
|---|---|---|---|
| test_thinkers_pending.sh | 16/17 (exit=1) | 19/19 (exit=0) | 1 port-only failure(s) — DOCUMENTED DEVIATION, not a new bug |
| test_thinkers_wake_at.sh | 19/19 (exit=0) | 19/19 (exit=0) | parity |
| test_thinkers_drain.sh | 20/20 (exit=0) | 20/20 (exit=0) | parity |
| test_status.sh | exit=1 (no pass/fail line) | 23/23 (exit=0) | 5 port-only failure(s) — MIXED, three distinct causes, none a port BEHAVIOR bug. (a) 2 assertions ('status.sh PATTERNS == headlong-killall PATTERNS', both 'dash pattern: killall == status.sh/uninstall.sh') `sed`-extract tools/headlong-killall's OWN BASH SOURCE TEXT (its `PATTERNS=(...)`/`DASH_PAT=` array literals) and compare it against status.sh/uninstall.sh's embedded copies |
| test_thinker_set_coupling.sh | 6/6 (exit=0) | 6/6 (exit=0) | parity |
| test_identity_sync_thinkers.sh | exit=1 (no pass/fail line) | 26/26 (exit=0) | 1 port-only failure(s) — DOCUMENTED GAP |
| test_unit_name_couplings.sh | 7/8 (exit=1) | 8/8 (exit=0) | 1 port-only failure(s) — BASH-ARTIFACT DEPENDENCY |
| test_thinker_env_fallback.sh | 11/11 (exit=0) | 11/11 (exit=0) | parity |
| test_dispatcher_single_owner.sh | exit=1 (no pass/fail line) | exit=0 (no pass/fail line) | 4 port-only failure(s) — BASH-ARTIFACT DEPENDENCY |
| test_dispatcher_cleanup.sh | exit=1 (no pass/fail line) | 7/7 (exit=0) | parity |
| test_killall_brokers.sh | exit=0 (no pass/fail line) | exit=0 (no pass/fail line) | parity |
| test_thinkers_fifo_location.sh | 6/7 (exit=1) | 7/7 (exit=0) | 1 port-only failure(s) — DOCUMENTED DEVIATION |
| test_thinkers_trajectory_swap.sh | 10/10 (exit=0) | 10/10 (exit=0) | parity |
| test_thinkers_stuck_step.sh | 15/15 (exit=0) | 15/15 (exit=0) | parity |

### Daemon lane failure detail

#### test_thinkers_pending.sh

**Root cause:** DOCUMENTED DEVIATION, not a new bug — the single failure ('feeder respawn: feeder running before kill') is the very first assertion in test_feeder_respawn, which pgreps for a literal `tail -n 0 -F <trajfile>` process (upstream's feeder implementation). The port's feeder (src/feeder.ts) is an IN-PROCESS fs.watch replacement with no such subprocess at all — already documented in PARITY.md ('feeder … in-process replacement for `tail -F | dispatch.fifo`'). The check bails via an early `return` on the pgrep miss, so the remaining 3 checks in that one test function (respawn-after-kill, respawn-logged, dispatch-after-respawn) never run — accounting for the suite's 19 control vs 17 port denominator, on top of the 1 explicit FAIL.

<details><summary>1 port-only failure line(s)</summary>

- `FAIL feeder respawn: feeder running before kill`

</details>

#### test_status.sh

**Root cause:** MIXED, three distinct causes, none a port BEHAVIOR bug. (a) 2 assertions ('status.sh PATTERNS == headlong-killall PATTERNS', both 'dash pattern: killall == status.sh/uninstall.sh') `sed`-extract tools/headlong-killall's OWN BASH SOURCE TEXT (its `PATTERNS=(...)`/`DASH_PAT=` array literals) and compare it against status.sh/uninstall.sh's embedded copies — a pure source-text-equality check with no subprocess involved. Substituting tools/headlong-killall with a one-line Node-dispatching wrapper (`exec node .../headlong-killall.mjs "$@"`, no PATTERNS array to extract) makes these fail by construction — same class as the existing test_mem_frontmatter.sh bash-artifact-dependency row. (b) the 'clone' failure: the 'install:' block runs `git clone -q --local "$REPO" "$APP"`, but this runner's lightweight scratch copy (tests/bin/thinkers/tools[/deploy] only, following the SAME technique every other suite in this file uses) never copies a `.git` directory at all, so the scratch root is not a git repository and the clone fails outright — the script's own `|| { bad "clone"; exit 1; }` then aborts the ENTIRE suite immediately, which is why port shows 'exit=1 (no pass/fail line)' instead of a real N/M count; every downstream assertion (18 of them) never runs as a result. This is a limitation of this runner's scratch-copy technique for the one suite that happens to `git clone` its own REPO variable, not a port behavior bug — a full git-backed scratch checkout would cost copying the ~360MB upstream tree (web/, tui/) per run and was judged not worth it for this lane.

<details><summary>5 port-only failure line(s)</summary>

- `FAIL status.sh PATTERNS == headlong-killall PATTERNS`
- `FAIL uninstall.sh PATTERNS == headlong-killall PATTERNS`
- `FAIL dash pattern: killall == status.sh`
- `FAIL dash pattern: killall == uninstall.sh`
- `FAIL clone`

</details>

#### test_identity_sync_thinkers.sh

**Root cause:** DOCUMENTED GAP, not a port bug — every failure is `identity sync-thinkers` returning an unrecognized-subcommand error (the port's bin/identity.mjs / src/identity.ts). PARITY.md's identity row already documents the scope: '`identity new` only (`import` is Slice C … out of this lane)' — `sync-thinkers` is a THIRD subcommand, never requested by this lane's task (sub, headlong-killall, thinkers enable/disable) and not implemented at all.

<details><summary>1 port-only failure line(s)</summary>

- `FAIL identity new alpha`

</details>

#### test_unit_name_couplings.sh

**Root cause:** BASH-ARTIFACT DEPENDENCY, not a port bug — the single failure ('found the cgroup comparison in bin/thinkers — expected a [[ "$my_cg" == *"<unit>@..."* ]] test') `grep`s bin/thinkers' OWN SOURCE TEXT for a specific comparison idiom. Substituting bin/thinkers with the port's one-line Node-dispatching wrapper removes that text entirely — same class as the test_status.sh PATTERNS checks and the pre-existing test_mem_frontmatter.sh row.

<details><summary>1 port-only failure line(s)</summary>

- `FAIL found the cgroup comparison in bin/thinkers — expected a [[ "$my_cg" == *"<unit>@..."* ]] test`

</details>

#### test_dispatcher_single_owner.sh

**Root cause:** BASH-ARTIFACT DEPENDENCY, not a port bug — the four failures are the two cases that inject the crash through a shim on the dispatcher's PATH (an `mv` shim that does `kill -9 $PPID` the moment the claim lands in run/claimed/, and an `rm` shim that does it when the sent receipt is about to be removed). The port's dispatcher renames and unlinks with fs calls inside one Node process: no `mv`/`rm` child ever runs, so the shim never fires ('no crash flag, shim log: ' is empty) and the downstream record/receipt checks have nothing to observe. The same two windows (die after the claim, die after the send with the receipt still on disk) are exercised on the port side by THINKERS_TEST_DIE_AFTER_CLAIM and the dieHook in test/dispatcherReceipts.test.ts. The flock lifetime-lock cases are skipped upstream-style on this host (no flock(1) on macOS), and the port has no flock analogue by design — ownership is the 16-byte token plus a pid-alive guard (PARITY.md, lane f).

<details><summary>4 port-only failure line(s)</summary>

- `FAIL the shim crash fires between the claim and the send - no crash flag, shim log: `
- `FAIL the crash swallows the send, nothing dispatches - record count 1`
- `FAIL the crash leaves the claim receipt behind as evidence - claims=0`
- `FAIL the dispatcher dies after the send with its receipt still on disk - no crash flag, shim log: `

</details>

#### test_thinkers_fifo_location.sh

**Root cause:** DOCUMENTED DEVIATION, not a port bug — the one failure ('fifo_path names a fifo under /tmp') asserts upstream's FIFO: the Bash dispatcher feeds steps through a named pipe whose path it records in run/fifo_path. The port's feeder is in-process (src/feeder.ts, fs.watch), there is no FIFO and no fifo_path pointer, and steps still reach the thinker ('a new step is dispatched' passes). The three behaviors that DO carry over are ported and pass: a leftover run/dispatch.fifo from a Bash-engine run is removed at start, nothing is created inside the identity dir, and stop never follows a rewritten fifo_path.

<details><summary>1 port-only failure line(s)</summary>

- `FAIL fifo_path names a fifo under /tmp — got ''`

</details>


## Installer lane (--installer)

Not run this pass — invoke with `--installer` to substitute tools/headlong-init -> bin/headlong-init.mjs, install.sh -> install.mjs, status.sh -> status.mjs, uninstall.sh -> uninstall.mjs, tools/identity -> bin/identity.mjs and run the 6 suites below.

| Suite | Status | Reason |
|---|---|---|
| test_sandbox_gate.sh | pending | not attempted (pass --installer to enable) |
| test_uninstall.sh | pending | not attempted (pass --installer to enable) |
| smoke_install.sh | pending | not attempted (pass --installer to enable) |
| test_local_llm_setup.sh | pending | not attempted (pass --installer to enable) |
| test_install_secret_argv.sh | pending | not attempted (pass --installer to enable) |
| test_installer_prompt_defaults.sh | pending | not attempted (pass --installer to enable) |

## Failure detail and root-cause analysis

### test_rollup_namer_limits.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug (6 of 40) — the suite observes the citation lookup through Bash-only instruments: a `head` shim on PATH that logs/deletes the candidate on `head -c 32769` (READ_LOG, DELETE_CANDIDATE) and `bash -x` xtrace counting `printf -v f ` lines. The port reads candidates with fs.openSync/readSync and has no head subprocess or xtrace, so the shim never fires (the 'deleted candidate' check sees the file still there, READ_LOG stays empty, probes counts 0). The same bounds are pinned on the port itself by test/recap-namer-limits.test.ts (128-probe cap and one open per candidate counted via a wrapped fs.openSync, corrupt/oversized/hidden candidates, 20%/4096 byte cap, tiny budget) and byte-for-byte against the real Bash by parity/recap adversarial group `namers`.

<details><summary>6 port-only failure line(s)</summary>

- `FAIL: test ! -f <TMP>/tmp.4XpZmgp2JW/trajs/aabb1390-root/rollups/t1/000000000090-000000000100.json`
- `FAIL: test 1 -eq 0`
- `FAIL: test        0 -gt 0`
- `FAIL: test 0 -gt 0`
- `FAIL: test 0 -gt 0`
- `FAIL: test 0 -eq 128`

</details>

### test_llm_openai_compatible.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug — this suite mocks the network by stubbing a `curl` binary on PATH; the port's bin/llm.mjs calls Node's native `fetch()` directly (src/llm.ts:92) and never shells out to curl (PARITY.md Deviations: "llm transport-failure wording ... there is no curl"). The stub is never invoked, so every request that should have been intercepted instead makes a REAL connection attempt to 127.0.0.1:9, which Node's fetch (undici) refuses outright — port 9 is on the fetch-spec's forbidden-port list (`ERR_UNDICI ... bad port`), where curl has no such restriction. No assertion here exercises port-owned logic; the whole suite needs a fetch-level interceptor (e.g. undici MockAgent) to be a valid oracle for the port, which is out of scope for this runner (no src/*.ts or harness edits).

<details><summary>12 port-only failure line(s)</summary>

- `FAIL keyless call succeeds via LLM_PROVIDER=openai-compatible — llm: error: request failed: bad port`
- `FAIL request went to LLM_API_URL`
- `FAIL unknown model gets the provider's 16384 default cap`
- `FAIL LLM_API_KEY is sent as Authorization: Bearer — llm: error: request failed: bad port`
- `FAIL auth config file is mode 600 — mode: `
- `FAIL auth config escapes quoted values`
- `FAIL SHELLM_API_URL works as the URL fallback — llm: error: request failed: bad port`
- `FAIL --provider openai-compatible works — llm: error: request failed: bad port`
- `FAIL non-streaming path answers — llm: error: API error (HTTP 000)`
- `FAIL -t overrides the default cap`
- `FAIL known model (gpt-5) keeps its 128000 table cap`
- `FAIL keyed provider (openai) sends its key via the config file, not argv`

</details>

### test_llm_provider_env.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug (all 6) — same curl-stub interception gap as test_llm_openai_compatible.sh, now visible in a sharper form since the llm-providers lane ported the anthropic/gemini/opencode(Zen)/adapter wire paths (PARITY.md Gaps table's llm anthropic/gemini/opencode-zen/adapter rows are closed): 2 of the 6 failures ("--provider overrides LLM_PROVIDER", "claude-* still detected as anthropic") show the port's fetch() correctly reaching the real https://api.anthropic.com and getting back a genuine `invalid x-api-key` rejection with the suite's fake key — proof the provider dispatch is right, just unobservable through $CURL_ARGS since curl is never invoked. "vendor/model still detected as openrouter" likewise reaches real https://openrouter.ai (`Missing Authentication header`). The remaining 3 ("LLM_PROVIDER=openai reaches an unrecognized model name", "request went to the configured endpoint", "env LLM_PROVIDER wins over a name it contradicts") fail the same way test_llm_openai_compatible.sh's do — a real connection attempt to 127.0.0.1:9 that fetch (undici) refuses as a forbidden port, or a $CURL_ARGS grep that stays empty because curl was never invoked. All 6 make a real outbound network attempt as a side effect of the mismatch, not by design; this suite needs a fetch-level interceptor (undici MockAgent) to be a valid port oracle — out of scope for this runner.

<details><summary>6 port-only failure line(s)</summary>

- `FAIL LLM_PROVIDER=openai reaches an unrecognized model name — llm: warning: LLM_API_URL overrides the default openai endpoint (requests go to 127.0.0.1:9)`
- `FAIL request went to the configured endpoint`
- `FAIL --provider overrides LLM_PROVIDER — llm: error: request failed: connect timeout after 10s (LLM_CONNECT_TIMEOUT)`
- `FAIL claude-* still detected as anthropic — llm: error: API error: invalid x-api-key`
- `FAIL vendor/model still detected as openrouter — llm: error: API error: Missing Authentication header`
- `FAIL env LLM_PROVIDER wins over a name it contradicts — llm: warning: LLM_PROVIDER=openai overrides detected provider 'anthropic' for model 'claude-sonnet-4-5'`

</details>

### test_llm_retry.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug — all 52 failures. This entire suite's subject (transient-retry behavior) is driven by controlling curl's per-call exit code/output via $CURL_MODE_FILE; since the port never invokes curl (fetch-based, see test_llm_openai_compatible.sh note), none of the retry/health-marker/ledger assertions exercise the port's actual retry logic — they all fail at the same first real-network-attempt step. This suite cannot validate the port's retry behavior without a fetch-level interceptor.

<details><summary>54 port-only failure line(s)</summary>

- `FAIL stream retry succeeds`
- `FAIL stream output correct`
- `FAIL three curl calls`
- `FAIL three attempts then give up`
- `FAIL original error preserved`
- `FAIL refusal not retried`
- `FAIL refusal named on stderr`
- `FAIL retries=0 fails immediately`
- `FAIL single call with retries=0`
- `FAIL partial output delivered`
- `FAIL no retry after emission`
- `FAIL non-stream retry succeeds`
- `FAIL two calls (500 then 200)`
- `FAIL 400 not retried`
- `FAIL 400 message surfaced`
- `FAIL marker: ok=false, http 400`
- `FAIL marker: 400 classified other`
- `FAIL marker: 402 -> kind credit`
- `FAIL marker: message kept`
- `FAIL marker: 429 'quota' -> kind rate (code beats words)`
- `FAIL marker: success -> ok=true`
- `FAIL marker: streamed credit error -> kind credit (no http code)`
- `FAIL marker: streamed success -> ok=true`
- `FAIL 200-with-error retried`
- `FAIL two calls (error then ok)`
- `FAIL finish_reason error retried`
- `FAIL finish_reason msg surfaced`
- `FAIL truncated output succeeds`
- `FAIL truncated text delivered`
- `FAIL truncation not retried`
- `FAIL truncation warned on stderr`
- `FAIL stream truncation succeeds`
- `FAIL stream truncated text intact`
- `FAIL stream truncation not retried`
- `FAIL stream truncation warned`
- `FAIL non-stream ws-body retried`
- `FAIL two calls (ws then ok)`
- `FAIL ws-body msg surfaced`
- `FAIL stream ws-body retried`
- `FAIL stream two calls (ws then ok)`
- `FAIL empty stream retried`
- `FAIL empty stream msg surfaced`
- `FAIL non-stream empty retried`
- `FAIL empty is whitespace error`
- `FAIL ledger: streamed call appends`
- `FAIL ledger: tokens + model + provider`
- `FAIL ledger: caller usage file still written`
- `FAIL ledger: identity dir gets its own ledger`
- `FAIL ledger: identity stamped`
- `FAIL ledger: home ledger untouched`
- `FAIL ledger: LLM_RUN_ID recorded`
- `FAIL ledger: failure appends nothing`
- `FAIL ledger: no usage chunk -> no line`
- `FAIL ledger: LLM_USAGE_LEDGER=/dev/null disables`

</details>

### test_llm_openrouter_routing.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug — all 14 failures (upstream sync 1b, Lane 3, 015d081/cf9e0ab). Same curl-stub interception gap as test_llm_openai_compatible.sh: this suite's stub `curl` copies the `-d@FILE`/`@FILE` payload aside to $PAYLOAD_OUT and answers with a canned SSE stream; the port's fetch()-based bin/llm.mjs never invokes curl, so $PAYLOAD_OUT is never written and every `q()` jq read against it returns empty ("got " in the FAIL lines) — including "no knobs: payload carries no provider block", which is trivially true of an empty file and would pass for the WRONG reason even if the file existed. The one exit-based failure ("an --or-* flag does not fail a non-OpenRouter call") is the same real-network-attempt side effect documented for test_llm_provider_env.sh: with no LLM_API_URL override in this suite's env, the port's fetch reaches the real https://api.openai.com with the suite's fake key and gets a real rejection, exit 1, where the stub would have answered 200. This suite needs a fetch-level interceptor to be a valid port oracle, same as its siblings — out of scope for this runner. The port's actual OpenRouter-routing behavior IS independently proven: parity/llm/run-parity.mjs's `or-routing` scenario group (25 cases, mirroring every assertion in this suite 1:1) runs both the real Bash and the port against a real local HTTP server and diffs the request JSON byte-for-byte — 25/25 PARITY, 0 port bugs (see PARITY.md's Upstream sync 1b section).

<details><summary>14 port-only failure line(s)</summary>

- `FAIL no knobs: payload carries no provider block — got `
- `FAIL --or-only pins provider.only — got `
- `FAIL --or-only leaves allow_fallbacks alone — got `
- `FAIL slug list is downcased, trimmed and de-blanked — got `
- `FAIL --or-data-collection deny is passed through — got `
- `FAIL --or-zdr requests zero-data-retention endpoints — got `
- `FAIL LLM_OR_ZDR accepts true/yes/on/1 in any case — not honoured: true yes on 1 TRUE On`
- `FAIL LLM_OR_ZDR accepts false/no/0/empty as off — still on for: 'false' 'no' '0' 'FALSE' ''`
- `FAIL all three knobs compose into one provider block — got `
- `FAIL LLM_OR_ONLY is honoured like --or-only — got `
- `FAIL a .env in the working directory supplies the knobs — got `
- `FAIL an explicitly named openrouter provider takes the knobs — got `
- `FAIL an --or-* flag does not fail a non-OpenRouter call — exit 1`
- `FAIL an --or-* flag adds no provider block for another provider — got `

</details>

### test_key_var_resolution.sh

**Root cause:** Both failures are the curl-stub TEST-METHODOLOGY MISMATCH (see test_llm_openai_compatible.sh) — the LLM_MAX_TOKENS/.env checks read the payload curl was called with, which the port's fetch-based bin/llm.mjs never produces. The suite's other 12 checks (tools/headlong-init key-variable resolution) pass identically on both sides: headlong-init is not a ported tool, so this scratch run exercises the same real upstream Bash as the control there — no differential, as expected.

<details><summary>2 port-only failure line(s)</summary>

- `FAIL bin/llm: LLM_MAX_TOKENS from the environment reaches the request`
- `FAIL bin/llm: .env stdout stays out of the values it loads`

</details>

### test_mem_frontmatter.sh

**Root cause:** BASH-ARTIFACT DEPENDENCY, not a port bug — `sed -n '/^frontmatter_field()/,/^}/p' "$REPO/bin/mem"` matches zero lines against the port's bin/mem (a 3-line Node trampoline, see bin/mem source), so `eval` defines nothing and every subsequent `frontmatter_field` call is `command not found` (empty result, all 5 remaining checks fail the same way — the 6th, "missing field returns empty", coincidentally still passes since empty was the expected answer there too).

<details><summary>5 port-only failure line(s)</summary>

- `FAIL quoted summary stripped — got: []`
- `FAIL quoted importance stripped — got: []`
- `FAIL quoted type stripped — got: []`
- `FAIL unquoted summary unchanged — got: []`
- `FAIL unquoted importance unchanged — got: []`

</details>

### test_mem_redaction.sh

<details><summary>106 port-only failure line(s)</summary>

- `FAIL ordinary add/stdin write`
- `FAIL ordinary add/argument write`
- `FAIL ordinary setup`
- `FAIL ordinary setup`
- `FAIL years add/stdin write`
- `FAIL years add/argument write`
- `FAIL years setup`
- `FAIL years setup`
- `FAIL timestamp add/stdin write`
- `FAIL timestamp add/argument write`
- `FAIL timestamp setup`
- `FAIL timestamp setup`
- `FAIL credit-date add/stdin write`
- `FAIL credit-date add/argument write`
- `FAIL credit-date setup`
- `FAIL credit-date setup`
- `FAIL visa-dates add/stdin write`
- `FAIL visa-dates add/argument write`
- `FAIL visa-dates setup`
- `FAIL visa-dates setup`
- `FAIL cards add/stdin write`
- `FAIL cards add/argument write`
- `FAIL cards setup`
- `FAIL cards setup`
- `FAIL card-followed-by-code add/stdin write`
- `FAIL card-followed-by-code add/argument write`
- `FAIL card-followed-by-code setup`
- `FAIL card-followed-by-code setup`
- `FAIL adjacent-cards add/stdin write`
- `FAIL adjacent-cards add/argument write`
- `FAIL adjacent-cards setup`
- `FAIL adjacent-cards setup`
- `FAIL card-layouts add/stdin write`
- `FAIL card-layouts add/argument write`
- `FAIL card-layouts setup`
- `FAIL card-layouts setup`
- `FAIL invalid-card add/stdin write`
- `FAIL invalid-card add/argument write`
- `FAIL invalid-card setup`
- `FAIL invalid-card setup`
- `FAIL long-number add/stdin write`
- `FAIL long-number add/argument write`
- `FAIL long-number setup`
- `FAIL long-number setup`
- `FAIL embedded-number add/stdin write`
- `FAIL embedded-number add/argument write`
- `FAIL embedded-number setup`
- `FAIL embedded-number setup`
- `FAIL github add/stdin write`
- `FAIL github add/argument write`
- `FAIL github setup`
- `FAIL github setup`
- `FAIL env-value add/stdin write`
- `FAIL env-value add/argument write`
- `FAIL env-value setup`
- `FAIL env-value setup`
- `FAIL formats add/stdin write`
- `FAIL formats add/argument write`
- `FAIL formats setup`
- `FAIL formats setup`
- `FAIL more-formats add/stdin write`
- `FAIL more-formats add/argument write`
- `FAIL more-formats setup`
- `FAIL more-formats setup`
- `FAIL structured add/stdin write`
- `FAIL structured add/argument write`
- `FAIL structured setup`
- `FAIL structured setup`
- `FAIL yaml add/stdin write`
- `FAIL yaml add/argument write`
- `FAIL yaml setup`
- `FAIL yaml setup`
- `FAIL json add/stdin write`
- `FAIL json add/argument write`
- `FAIL json setup`
- `FAIL json setup`
- `FAIL pem add/stdin write`
- `FAIL pem add/argument write`
- `FAIL pem setup`
- `FAIL pem setup`
- `FAIL inline-pem add/stdin write`
- `FAIL inline-pem add/argument write`
- `FAIL inline-pem setup`
- `FAIL inline-pem setup`
- `FAIL single-line-pem add/stdin write`
- `FAIL single-line-pem add/argument write`
- `FAIL single-line-pem setup`
- `FAIL single-line-pem setup`
- `FAIL two-pem add/stdin write`
- `FAIL two-pem add/argument write`
- `FAIL two-pem setup`
- `FAIL two-pem setup`
- `FAIL incomplete setup`
- `FAIL nested setup`
- `FAIL wrong-footer setup`
- `FAIL explicit slug redacted`
- `FAIL incomplete slug preserves file`
- `FAIL argv add/stdin write`
- `FAIL argv add/argument write`
- `FAIL argv setup`
- `FAIL argv setup`
- `FAIL large-body add/stdin write`
- `FAIL large-body add/argument write`
- `FAIL large-body setup`
- `FAIL large-body setup`
- `FAIL subprocess failure preserves file`

</details>

### test_traj_redaction.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug (all 9 — 3 modes x 3 checks) — the suite's final block puts stub `jq`/`sed` binaries first on PATH that emit unsafe/invalid output (or nothing) and exit non-zero, to prove the Bash append writes NOTHING when its jq/sed sanitizer subprocess fails. The port's redactor (src/trajRedact.mjs) is an in-process pure function with no subprocess to sabotage, so the injected failure never happens and the append succeeds (correctly, redacted). The invariant the block protects — redaction runs before any blob spill or lock/append, so a failed sanitizer cannot leak or half-write — holds structurally (appendStep redacts before spilling; covered by test/trajSync.test.ts and parity/traj traj-redact). The other 64 checks (every shape rule, env-VALUE rule, PEM, Docker auth, key redaction, blobs) pass 64/64.

<details><summary>9 port-only failure line(s)</summary>

- `FAIL exit: sanitizer failure is reported`
- `FAIL exit: JSONL remains unchanged`
- `FAIL exit: no blob or temporary payload is created`
- `FAIL invalid: sanitizer failure is reported`
- `FAIL invalid: JSONL remains unchanged`
- `FAIL invalid: no blob or temporary payload is created`
- `FAIL empty: sanitizer failure is reported`
- `FAIL empty: JSONL remains unchanged`
- `FAIL empty: no blob or temporary payload is created`

</details>

### test_chat_index_concurrent.sh

<details><summary>1 port-only failure line(s)</summary>

- `FAIL reader did not reach the offset boundary`

</details>

### test_llm_json_schema.sh

**Root cause:** TEST-METHODOLOGY MISMATCH, not a port bug (all 6) — same curl-stub interception gap as test_llm_openai_compatible.sh: the suite reads the payload file its stub `curl` was handed ($PAYLOAD_OUT), which the port's fetch()-based bin/llm.mjs never produces, so every jq read returns empty ("got "). The behavior IS proven independently: parity/llm/run-parity.mjs's `jsonschema` group (response_format on openai-compatible/openrouter/non-stream+system, ignore-with-warning on anthropic/gemini, file-not-found, invalid JSON) diffs the request JSON byte-for-byte against the real bin/llm over a real local HTTP server, and test/llmProviderSync.test.ts pins the payload shape.

<details><summary>6 port-only failure line(s)</summary>

- `FAIL no flag: no response_format in the payload — got `
- `FAIL --json-schema sets response_format.type json_schema — got `
- `FAIL the schema is strict — got `
- `FAIL the file's schema is carried verbatim — got `
- `FAIL the rest of the payload is unchanged`
- `FAIL the reply text streams through untouched — got `

</details>

### test_split_bridge_env.sh

<details><summary>17 port-only failure line(s)</summary>

- `FAIL moves the two live token lines`
- `FAIL .env no longer holds the tokens`
- `FAIL .env.bridge holds them`
- `FAIL alert token seeded`
- `FAIL seed comment`
- `FAIL .env.bridge is mode 600`
- `FAIL backup written`
- `FAIL second run is a no-op`
- `FAIL alert token not duplicated`
- `FAIL rotated token replaces`
- `FAIL app token survives`
- `FAIL existing alert token kept`
- `FAIL missing .env exits 0`
- `FAIL slack bridge unit loads .env.bridge`
- `FAIL thinkers-death-alert posts with HEADLONG_ALERT_TOKEN`
- `FAIL thinkers-failure-alert posts with HEADLONG_ALERT_TOKEN`
- `FAIL thinkers-silence-alert posts with HEADLONG_ALERT_TOKEN`

</details>

### test_thinkers_sandbox.sh

<details><summary>21 port-only failure line(s)</summary>

- `FAIL render: whole filesystem read-only`
- `FAIL render: home and temp dirs writable`
- `FAIL render: app checkout read-only`
- `FAIL render: identity dir writable`
- `FAIL render: bridge tokens unreadable`
- `FAIL render: single [Service] section`
- `FAIL install: default writes the drop-in`
- `FAIL install: second run unchanged`
- `FAIL status: on present`
- `FAIL install: flag off removes`
- `FAIL install: off unchanged`
- `FAIL status: off absent`
- `FAIL install: quoted 1 re-installs`
- `FAIL install: 'off' is off`
- `FAIL install: environment overrides .env`
- `FAIL install: stale drop-in rewritten`
- `FAIL render: HEADLONG_IDENTITIES_DIR`
- `FAIL render: app still read-only`
- `FAIL render: env override for root`
- `FAIL render: linked .identities resolves`
- `FAIL update.sh and setup.sh install the drop-in`

</details>

### test_thinkers_silence_alert.sh

<details><summary>29 port-only failure line(s)</summary>

- `FAIL stale trajectory posts the alert — posts=0 `
- `FAIL marker written`
- `FAIL posts to the alert channel`
- `FAIL second tick is silent — posts=0`
- `FAIL fresh trajectory posts the recovery — posts=0 `
- `FAIL healthy tick is silent`
- `FAIL dead dispatcher is not a silence`
- `FAIL deliberate stop is not a silence`
- `FAIL missing config degrades to the fallback log — rc=127`
- `FAIL re-posts after the repost interval — posts=0 `
- `FAIL inside the repost interval it is silent — posts=0`
- `FAIL unwritable marker does not block the post — posts=0`
- `FAIL marker falls back to tmpfs`
- `FAIL recovery finds the fallback marker — posts=0`
- `FAIL disk over the threshold posts the alert — posts=0 `
- `FAIL disk marker written`
- `FAIL disk alert does not repeat inside the interval — posts=0`
- `FAIL 88% is not yet a recovery — posts=0`
- `FAIL disk under the threshold posts the recovery — posts=0 `
- `FAIL locked trajectory: group access restored — dir=700 file=600`
- `FAIL locked trajectory posts the alert with the old modes — posts=0 `
- `FAIL perm marker written`
- `FAIL locked again inside the interval: repaired, no second post — dir=700 posts=0`
- `FAIL locked again past the interval: posts again — posts=0`
- `FAIL healthy permissions: silent, marker dropped — posts=0`
- `FAIL old index lock alert — posts=0`
- `FAIL index alert repeats`
- `FAIL index alert did not repost`
- `FAIL index recovery marker`

</details>

### test_thinkers_tmp_reaper.sh

<details><summary>17 port-only failure line(s)</summary>

- `FAIL exits 0 — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL big stale file reaped`
- `FAIL small stale tmp.* reaped`
- `FAIL stale shellm-run dir reaped`
- `FAIL stale shellm-exec dir reaped`
- `FAIL summary line counts what went — bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL quiet when there is nothing to reap — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL missing root exits 0`
- `FAIL refuses the root directory — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL refuses HOME — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL refuses a system dir — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL refuses an ancestor of HOME even inside the temp tree — bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL prefix-only HOME match does not block`
- `FAIL refuses a symlink to / — rc=127 bash: <TMP>/uptests-xN7sqB/deploy/thinkers-tmp-reaper.sh: No such file or directory`
- `FAIL stale run dir holding a symlink is removed`
- `FAIL name with a space reaped`
- `FAIL name with a newline reaped`

</details>

### test_monolith_wake_sections.sh

**Root cause:** HARNESS ARTIFACT, not a port bug — the one failure ('the runtime line names the checked-out commit') is thinkers/monolith/step's own Bash (`git -C $REPO rev-parse` for the `Runtime: headlong <sha>` line); this runner's lightweight scratch copy has no `.git` (same limitation documented for test_status.sh's 'clone'), while the control runs inside the real upstream checkout. The port's own runtime line is covered by test/monolith.test.ts and the context parity harness.

<details><summary>1 port-only failure line(s)</summary>

- `FAIL runtime line present`

</details>

