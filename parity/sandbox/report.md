# Sandbox exec-layer parity — LocalSandbox vs DockerSandbox

_Generated 2026-10-27T15:47:47.516Z · Node v22.22.3 · image `ubuntu:latest`_

Both sandboxes implement the one `Sandbox` interface (`src/sandbox.ts`): `exec({workdir, wrappedCode, env, timeoutMs?}) -> {output, exit, timedOut}`. `LocalSandbox` runs `bash -e -c` in a restricted host subprocess (daemon-free default); `DockerSandbox` runs it inside a per-identity container via `docker exec`, matching `bin/shellm` `execute_code` (bin/shellm:1309-1330).

## A. Invocation-shape check (static, no daemon)

Result: **PASS**

| check | ok |
| --- | --- |
| argv matches execute_code shape exactly | ✅ |
| secret VALUE never on the command line | ✅ |
| caller PATH dropped (not forwarded as a value) | ✅ |
| container PATH set explicitly | ✅ |
| HOME=<workdir> set | ✅ |
| -w <workdir> present | ✅ |
| command is bash -c <supervisor> _ <control dir> | ✅ |
| the wrapped code is NOT on argv (rides stdin, `docker exec -i`) | ✅ |
| bin/shellm execute_code reference tokens present | ✅ |

Constructed argv (secret value proven absent):

```
docker exec -i -e TRAJ_ID -e IDENTITY_NAME -e ANTHROPIC_API_KEY -e PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin -e HOME=/workspace/run -w /workspace/run shellm-identity-abcd1234 bash -c <REMOTE_SUPERVISE_SCRIPT> _ /tmp/shellm-exec.deadbeef
```

## B. Behavioral differential

Result: **7/7 scenarios at PARITY** (container `6bcd976e418c`).

| scenario | mode | parity | detail |
| --- | --- | --- | --- |
| normal-output | exact | ✅ | output "hello world\n" exit 0 |
| nonzero-exit | exact | ✅ | output "pre-fail\n" exit 42 |
| stderr-mixed | multiset | ✅ | same line-set ["ERRLINE","out1","out2"] (docker order local="out1\nERRLINE\nout2\n" docker="out1\nout2\nERRLINE\n") |
| env-use | exact | ✅ | output "mark=parity-77\n" exit 0 |
| cwd-use | per-sandbox | ✅ | each honored its own -w (local="<TMP>/sandbox-parity-local-wROUFe\n" docker="/parity-workdir\n") |
| timeout-kill | timeout | ✅ | both timedOut, exit 124 (local="starting\n" docker="starting\n") |
| idle-kill | idle-timeout | ✅ | both timedOut with killReason "idle" (local=idle docker=idle) |

### Documented non-identity: `stderr-mixed`

`docker exec` (no `-t`) returns container stdout and stderr as separate multiplexed channels, so the client-side `2>&1` merge does **not** preserve cross-stream ordering — reproducibly, `ERRLINE` may sort ahead of `out1`. `LocalSandbox`'s in-process `exec 2>&1` keeps strict order. This divergence is inherent to the production path: real Headlong `execute_code` merges the same way (`( … exec docker exec … ) </dev/null 2>&1`), so `DockerSandbox` faithfully inherits it rather than papering over it. Parity here is asserted on the line SET + exit code; for pure-stdout, pure-exit, env, cwd and timeout scenarios the two sandboxes agree exactly.

## C. Loopback-rewrite proof (bug #70)

A Docker sandbox's `LLM_API_URL`/`SHELLM_API_URL` must be rewritten to `host.docker.internal` when it names this host's loopback interface (`_shellm_container_api_url`, bin/shellm:216-221), and the container started with `--add-host host.docker.internal:host-gateway` (bin/shellm:1026-1034) — otherwise a step's `llm`/`mem search` gets `connect ECONNREFUSED` against the CONTAINER's own loopback (bug #70, director-verified live run).

Reference check: **PASS**

| check | ok |
| --- | --- |
| containerApiUrl matches _shellm_container_api_url on the rewrite matrix | ✅ |
| applyDockerApiUrlRewrite rewrites only in docker mode | ✅ |
| bin/shellm _shellm_container_api_url / --add-host reference tokens present | ✅ |

Real-daemon proof: **PASS** — a real HTTP listener on this host's 127.0.0.1, a real container started via `selectSandbox` (mode: docker), and `curl "$LLM_API_URL"` run inside it.

| check | ok |
| --- | --- |
| rewritten LLM_API_URL differs from the original loopback URL | ✅ |
| rewritten LLM_API_URL is host.docker.internal with the port preserved | ✅ |
| AFTER fix: curl reaches the real host listener (HTTP 200) | ✅ |
| host listener actually got hit | ✅ |
| BEFORE fix (unrewritten URL): curl does NOT connect from inside the container | ✅ |

