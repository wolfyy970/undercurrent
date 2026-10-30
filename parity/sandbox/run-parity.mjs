#!/usr/bin/env node
// run-parity.mjs — DIFFERENTIAL parity proof for the exec layer: LocalSandbox
// (restricted subprocess, the daemon-free default) vs DockerSandbox (the
// faithful production path), both behind the one `Sandbox` interface.
//
// Three independent proofs:
//
//   A. BEHAVIORAL DIFFERENTIAL — run identical bash scenarios (normal output,
//      non-zero exit, stderr, env use, cwd use, timeout) through BOTH sandboxes
//      and diff {output, exit, timedOut}. Needs a real Docker daemon; when one
//      is absent the whole differential is marked SKIPPED-WITH-REASON (never a
//      faked pass — see the mem/skills harnesses for the same discipline).
//
//   B. INVOCATION SHAPE — assert DockerSandbox.buildDockerExecArgs() produces
//      the exact `docker exec …` argv that bin/shellm's execute_code docker
//      branch builds (bin/shellm:1309-1330). Pure/static: runs with or without
//      a daemon, so a skipped differential still leaves a real, recorded check.
//
//   C. LOOPBACK-REWRITE (bug #70) — a Docker sandbox's LLM_API_URL/
//      SHELLM_API_URL must be rewritten to host.docker.internal
//      (`_shellm_container_api_url`, bin/shellm:216-221) and the container
//      started with `--add-host host.docker.internal:host-gateway`
//      (bin/shellm:1026-1034), so a step's `llm`/`mem search` reaches a
//      model server bound to THIS host's loopback interface instead of
//      getting `connect ECONNREFUSED` against the container's own loopback.
//      Static reference-token check always runs; the real end-to-end proof
//      (a host listener reached from inside a real container via
//      `selectSandbox`) needs a daemon, SKIPPED-WITH-REASON otherwise.
//
// Node 24 strips types natively, so we import the TS sources directly — no
// build step, no new deps. Repeatable: `node parity/sandbox/run-parity.mjs`.
// Writes results.json + report.md beside this file. Exit 0 iff every RUN
// scenario reaches PARITY and both static checks pass (SKIPPED ≠ failure).

// NO-MODEL LAYER (checked 2026-10-29): nothing here calls a model. Proof C's host
// listener (startHostListener) is a labelled HTTP TRANSPORT probe: it answers
// "host-reached" so curl inside the container can show the rewritten
// LLM_API_URL reaches this host's loopback; only the HTTP status is read, and no
// model client parses the body. A, B and C compare the port's sandboxes and argv
// against bin/shellm's reference text, not model output.
//
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DockerSandbox, DOCKER_CONTAINER_PATH, REMOTE_SUPERVISE_SCRIPT } from "../../src/sandbox-docker.ts";
import { LocalSandbox } from "../../src/sandbox.ts";
import { selectSandbox, containerApiUrl, applyDockerApiUrlRewrite } from "../../src/sandbox-runtime.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.SHELLM_DOCKER_IMAGE ?? "ubuntu:latest"; // bin/shellm:81 default
// PORT-NOTE: was a hardcoded placeholder ("<HEADLONG_ROOT>/bin/shellm") that
// can never resolve on a real disk (no absolute local paths in tracked
// files — CLAUDE.md, scrub.test.ts) — so the "reference tokens present"
// shape check below silently always read as false/SKIPPED-content on any
// checkout, regardless of this file's own correctness. PARITY_UPSTREAM_ROOT
// is the same env var every other harness in this repo already uses to find
// a real upstream checkout (CLAUDE.md's Oracle section); wire it here too so
// the check is live when that root is set, and degrades to the same "not on
// this disk" no-op otherwise — never a literal unresolvable path.
const SHELLM = process.env.PARITY_UPSTREAM_ROOT
  ? path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/shellm")
  : "<HEADLONG_ROOT>/bin/shellm";

// ---------------------------------------------------------------------------
// B. INVOCATION SHAPE — no daemon needed.
// ---------------------------------------------------------------------------
// Expected argv, derived independently from bin/shellm:1309-1330 semantics:
//   for each env var except PATH: -e NAME   (bare; VALUE stays off the cmdline)
//   -e PATH=<container path>  -e HOME=<workdir>  -w <workdir>  <container>
//   bash -c <in-container _supervise_exec> _ <control dir>
// 2e39a3f (c0fc931, b9bc2a3, db1e8e1): the wrapped code is no longer an argv
// element — it rides `docker exec -i`'s stdin (the 128 KiB per-argv-string cap)
// and the in-container supervisor runs it (inline <=64 KiB, script file above).
function expectedShellmArgv({ env, workdir, container, controlDir }) {
  const a = ["exec", "-i"];
  for (const k of Object.keys(env)) if (k !== "PATH") a.push("-e", k);
  a.push("-e", `PATH=${DOCKER_CONTAINER_PATH}`);
  a.push("-e", `HOME=${workdir}`);
  a.push("-w", workdir);
  a.push(container);
  a.push("bash", "-c", REMOTE_SUPERVISE_SCRIPT, "_", controlDir);
  return a;
}

function shapeCheck() {
  const container = "shellm-identity-abcd1234";
  const reqShape = {
    workdir: "/workspace/run",
    wrappedCode: "set -x\necho hi\nset +x\n__shellm_rc=$?\nexit $__shellm_rc\n",
    // A secret-bearing var (ANTHROPIC_API_KEY) is present to prove its VALUE
    // never rides on the command line — the whole reason for bare -e NAME.
    env: { PATH: "/host/bin", TRAJ_ID: "t-99", IDENTITY_NAME: "nova", ANTHROPIC_API_KEY: "sk-SECRET" },
  };
  const sb = new DockerSandbox({ container });
  const controlDir = "/tmp/shellm-exec.deadbeef";
  const got = sb.buildDockerExecArgs(reqShape, controlDir);
  const want = expectedShellmArgv({ ...reqShape, container, controlDir });

  const checks = [];
  checks.push(["argv matches execute_code shape exactly", JSON.stringify(got) === JSON.stringify(want)]);
  checks.push(["secret VALUE never on the command line", !got.some((t) => t.includes("sk-SECRET"))]);
  checks.push(["caller PATH dropped (not forwarded as a value)", !got.some((t) => t.includes("/host/bin"))]);
  checks.push(["container PATH set explicitly", got.includes(`PATH=${DOCKER_CONTAINER_PATH}`)]);
  checks.push(["HOME=<workdir> set", got.includes(`HOME=${reqShape.workdir}`)]);
  checks.push(["-w <workdir> present", got[got.indexOf(container) - 2] === "-w" && got[got.indexOf(container) - 1] === reqShape.workdir]);
  checks.push(["command is bash -c <supervisor> _ <control dir>", JSON.stringify(got.slice(-5)) === JSON.stringify(["bash", "-c", REMOTE_SUPERVISE_SCRIPT, "_", controlDir])]);
  checks.push(["the wrapped code is NOT on argv (rides stdin, `docker exec -i`)", !got.some((t) => t.includes("set -x")) && got[1] === "-i" && sb.buildStdin(reqShape) === reqShape.wrappedCode + "\n"]);

  // Tie the expectation to the live reference text, so a drift in bin/shellm is
  // visible here rather than silently diverging.
  let refSeen = false;
  try {
    const src = fs.readFileSync(SHELLM, "utf8");
    refSeen =
      src.includes('docker exec -i "${docker_env_flags[@]}" -w "$workspace"') &&
      src.includes("_supervise_exec()") &&
      src.includes('docker_env_flags+=(-e "${ev%%=*}")');
  } catch { /* reference not on this disk — shape check still stands on its own */ }
  checks.push(["bin/shellm execute_code reference tokens present", refSeen]);

  return { checks, got, want };
}

// ---------------------------------------------------------------------------
// A. BEHAVIORAL DIFFERENTIAL — needs a real daemon + container.
// ---------------------------------------------------------------------------
function daemonReason() {
  if (!DockerSandbox.isDaemonAvailable()) return "docker daemon not reachable (`docker info` failed)";
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status !== 0) {
    if (spawnSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: 300_000 }).status !== 0) {
      return `image ${IMAGE} unavailable and could not be pulled (offline?)`;
    }
  }
  return null; // runnable
}

// Scenarios. `compare` says how output is diffed:
//   'exact'    — output strings must be byte-identical.
//   'multiset' — lines compared order-independent (docker demuxes stdout/stderr,
//                so cross-stream ORDER is non-deterministic — a faithful
//                production property real Headlong's execute_code shares).
//   'per-sandbox' — each side matches its OWN expected value (cwd differs by
//                design); parity is "both honor -w/cwd", plus exit must match.
function scenarios(hostWorkdir, containerWorkdir) {
  const REALPATH = process.env.PATH ?? "/usr/bin:/bin";
  return [
    {
      id: "normal-output",
      env: { PATH: REALPATH },
      wrappedCode: "echo 'hello world'\n",
      compare: "exact",
    },
    {
      id: "nonzero-exit",
      env: { PATH: REALPATH },
      wrappedCode: "echo pre-fail\nexit 42\n",
      compare: "exact",
    },
    {
      id: "stderr-mixed",
      env: { PATH: REALPATH },
      wrappedCode: "echo out1\necho ERRLINE >&2\necho out2\n",
      compare: "multiset",
    },
    {
      id: "env-use",
      env: { PATH: REALPATH, MARK: "parity-77" },
      wrappedCode: 'echo "mark=$MARK"\n',
      compare: "exact",
    },
    {
      id: "cwd-use",
      env: { PATH: REALPATH },
      wrappedCode: "pwd\n",
      compare: "per-sandbox",
      // bash getcwd() resolves symlinks (macOS /var -> /private/var), so match
      // the physical path of each sandbox's own workdir.
      localExpect: fs.realpathSync(hostWorkdir) + "\n",
      dockerExpect: containerWorkdir + "\n",
    },
    {
      id: "timeout-kill",
      env: { PATH: REALPATH },
      wrappedCode: "echo starting\nsleep 5\necho SHOULD_NOT_APPEAR\n",
      compare: "timeout",
      timeoutMs: 500,
    },
    // bug #33: the MAX ceiling above proves a flat wall-clock kill; this
    // proves the SEPARATE, shorter idle-only ceiling (SHELLM_INACTIVITY_
    // TIMEOUT) fires on genuine silence even when the MAX ceiling is left at
    // its (much larger) default — the two timers are independent knobs, not
    // one collapsed clock. The beacon-vs-max distinction (a block silent on
    // real output but "active" via SHELLM_ACTIVITY_FILE survives idle, dies
    // at MAX) is covered by test/sandbox-watchdog.test.ts instead of here —
    // driving a host-side beacon writer in parallel with a container exec
    // doesn't fit this harness's flat request-per-scenario shape.
    {
      id: "idle-kill",
      env: { PATH: REALPATH },
      wrappedCode: "echo starting\nsleep 5\necho SHOULD_NOT_APPEAR\n",
      compare: "idle-timeout",
      inactivityTimeoutMs: 500,
    },
  ];
}

function verdict(sc, local, docker) {
  if (sc.compare === "exact") {
    return {
      pass: local.output === docker.output && local.exit === docker.exit && local.timedOut === docker.timedOut,
      note: `output ${JSON.stringify(local.output)} exit ${local.exit}`,
    };
  }
  if (sc.compare === "multiset") {
    const norm = (s) => s.split("\n").filter(Boolean).sort();
    const eq = JSON.stringify(norm(local.output)) === JSON.stringify(norm(docker.output));
    return {
      pass: eq && local.exit === docker.exit,
      note: `same line-set ${JSON.stringify(norm(local.output))} (docker order local=${JSON.stringify(local.output)} docker=${JSON.stringify(docker.output)})`,
    };
  }
  if (sc.compare === "per-sandbox") {
    return {
      pass: local.output === sc.localExpect && docker.output === sc.dockerExpect && local.exit === docker.exit,
      note: `each honored its own -w (local=${JSON.stringify(local.output)} docker=${JSON.stringify(docker.output)})`,
    };
  }
  if (sc.compare === "timeout") {
    return {
      pass: local.timedOut === true && docker.timedOut === true && local.exit === 124 && docker.exit === 124,
      note: `both timedOut, exit 124 (local=${JSON.stringify(local.output)} docker=${JSON.stringify(docker.output)})`,
    };
  }
  if (sc.compare === "idle-timeout") {
    return {
      pass:
        local.timedOut === true &&
        docker.timedOut === true &&
        local.exit === 124 &&
        docker.exit === 124 &&
        local.killReason === "idle" &&
        docker.killReason === "idle",
      note: `both timedOut with killReason "idle" (local=${local.killReason} docker=${docker.killReason})`,
    };
  }
  return { pass: false, note: "unknown compare mode" };
}

async function runDifferential() {
  const hostWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-parity-local-"));
  const containerWorkdir = "/parity-workdir";

  const run = spawnSync("docker", ["run", "-d", "--rm", IMAGE, "sleep", "infinity"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error("docker run failed: " + (run.stderr || run.stdout));
  const container = run.stdout.trim();
  try {
    spawnSync("docker", ["exec", container, "mkdir", "-p", containerWorkdir], { stdio: "ignore" });
    const local = new LocalSandbox();
    const docker = new DockerSandbox({ container });

    const results = [];
    for (const sc of scenarios(hostWorkdir, containerWorkdir)) {
      const extra = {
        ...(sc.timeoutMs ? { timeoutMs: sc.timeoutMs } : {}),
        ...(sc.inactivityTimeoutMs ? { inactivityTimeoutMs: sc.inactivityTimeoutMs } : {}),
      };
      const localReq = { workdir: hostWorkdir, wrappedCode: sc.wrappedCode, env: sc.env, ...extra };
      const dockerReq = { workdir: containerWorkdir, wrappedCode: sc.wrappedCode, env: sc.env, ...extra };
      const lr = await local.exec(localReq);
      const dr = await docker.exec(dockerReq);
      const v = verdict(sc, lr, dr);
      results.push({ id: sc.id, compare: sc.compare, pass: v.pass, note: v.note, local: lr, docker: dr });
    }
    return { container, results };
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    fs.rmSync(hostWorkdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// C. LOOPBACK-REWRITE (bug #70) — reference-token check, no daemon needed.
// ---------------------------------------------------------------------------
function loopbackReferenceCheck() {
  const checks = [];
  checks.push(["containerApiUrl matches _shellm_container_api_url on the rewrite matrix", (() => {
    const cases = [
      ["http://127.0.0.1:8080/v1", "http://host.docker.internal:8080/v1"],
      ["https://localhost/v1", "https://host.docker.internal/v1"],
      ["http://0.0.0.0:11434/v1", "http://host.docker.internal:11434/v1"],
      ["http://[::1]:8080/v1", "http://host.docker.internal:8080/v1"],
      ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"], // unchanged
    ];
    return cases.every(([input, want]) => containerApiUrl(input) === want);
  })()]);
  checks.push(["applyDockerApiUrlRewrite rewrites only in docker mode", (() => {
    const dockerEnv = { LLM_API_URL: "http://127.0.0.1:1" };
    applyDockerApiUrlRewrite(dockerEnv, "docker");
    const localEnv = { LLM_API_URL: "http://127.0.0.1:1" };
    applyDockerApiUrlRewrite(localEnv, "local");
    return dockerEnv.LLM_API_URL === "http://host.docker.internal:1" && localEnv.LLM_API_URL === "http://127.0.0.1:1";
  })()]);

  let refSeen = false;
  try {
    const src = fs.readFileSync(SHELLM, "utf8");
    refSeen =
      src.includes("_shellm_container_api_url") &&
      src.includes("_shellm_url_is_loopback") &&
      src.includes('--add-host "host.docker.internal:host-gateway"') &&
      src.includes("host.docker.internal");
  } catch { /* reference not on this disk — checks above still stand on their own */ }
  checks.push(["bin/shellm _shellm_container_api_url / --add-host reference tokens present", refSeen]);
  return checks;
}

// ---------------------------------------------------------------------------
// C. LOOPBACK-REWRITE (bug #70) — real end-to-end proof, needs a daemon.
// ---------------------------------------------------------------------------
// HTTP TRANSPORT PROBE, not a model server: reachability only (see the NO-MODEL LAYER note above).
async function startHostListener() {
  const hits = [];
  const server = http.createServer((_req, res) => {
    hits.push(Date.now());
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("host-reached");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, hits, close: () => new Promise((r) => server.close(() => r())) };
}

async function runLoopbackRewriteDifferential() {
  const listener = await startHostListener();
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-b70-identity-"));
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-b70-workdir-"));
  const hostEnv = { LLM_API_URL: listener.url, SHELLM_API_URL: listener.url };
  const result = selectSandbox({
    identityName: "parity-bug70",
    identityDir,
    workdir,
    binDir: "/usr/bin",
    portHome: process.cwd(),
    mode: "docker",
    tempDocker: true,
    env: hostEnv,
  });
  try {
    const execEnv = { ...hostEnv };
    applyDockerApiUrlRewrite(execEnv, result.env.type);

    const afterFix = await result.sandbox.exec({
      workdir: "/",
      wrappedCode: 'curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "$LLM_API_URL"\n',
      env: { ...execEnv, PATH: DOCKER_CONTAINER_PATH },
    });
    const beforeFix = await result.sandbox.exec({
      workdir: "/",
      wrappedCode:
        'if curl -sS --max-time 3 -o /dev/null -w "%{http_code}" "$LLM_API_URL" 2>&1; then echo CONNECTED; else echo "curl-failed rc=$?"; fi\n',
      env: { LLM_API_URL: listener.url, PATH: DOCKER_CONTAINER_PATH },
    });

    const checks = [
      ["rewritten LLM_API_URL differs from the original loopback URL", execEnv.LLM_API_URL !== listener.url],
      ["rewritten LLM_API_URL is host.docker.internal with the port preserved", execEnv.LLM_API_URL === `http://host.docker.internal:${listener.port}`],
      ["AFTER fix: curl reaches the real host listener (HTTP 200)", afterFix.output.trim() === "200" && afterFix.exit === 0],
      ["host listener actually got hit", listener.hits.length >= 1],
      ["BEFORE fix (unrewritten URL): curl does NOT connect from inside the container", !beforeFix.output.includes("CONNECTED")],
    ];
    return { checks, pass: checks.every(([, ok]) => ok) };
  } finally {
    result.cleanup();
    await listener.close();
    fs.rmSync(identityDir, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Drive both, write artifacts.
// ---------------------------------------------------------------------------
const shape = shapeCheck();
const shapePass = shape.checks.every(([, ok]) => ok);

const reason = daemonReason();
let differential = null;
let containerId = null;
if (reason === null) {
  const d = await runDifferential();
  differential = d.results;
  containerId = d.container;
}

const runPass = differential ? differential.filter((r) => r.pass).length : 0;
const runTotal = differential ? differential.length : 0;

const loopbackChecks = loopbackReferenceCheck();
const loopbackRefPass = loopbackChecks.every(([, ok]) => ok);
let loopbackRewrite = null;
if (reason === null) {
  loopbackRewrite = await runLoopbackRewriteDifferential();
}
const loopbackPass = loopbackRefPass && (loopbackRewrite === null || loopbackRewrite.pass);

const allPass = shapePass && (differential === null || runPass === runTotal) && loopbackPass;

const out = {
  generated_at: new Date().toISOString(),
  image: IMAGE,
  node: process.version,
  shape_check: { pass: shapePass, checks: shape.checks.map(([name, ok]) => ({ name, ok })), argv: shape.got.map((t) => (t === REMOTE_SUPERVISE_SCRIPT ? "<REMOTE_SUPERVISE_SCRIPT>" : t)) },
  differential: differential === null
    ? { status: "SKIPPED", reason }
    : { status: "RAN", container: containerId, pass: runPass, total: runTotal, scenarios: differential },
  loopback_rewrite: {
    reference_check: { pass: loopbackRefPass, checks: loopbackChecks.map(([name, ok]) => ({ name, ok })) },
    differential: loopbackRewrite === null
      ? { status: "SKIPPED", reason }
      : { status: "RAN", pass: loopbackRewrite.pass, checks: loopbackRewrite.checks.map(([name, ok]) => ({ name, ok })) },
  },
  overall_pass: allPass,
};

fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(HERE, "report.md"), renderReport(out));
console.log(`shape ${shapePass ? "PASS" : "FAIL"} (${shape.checks.filter(([, ok]) => ok).length}/${shape.checks.length}); ` +
  (differential === null ? `differential SKIPPED — ${reason}` : `differential ${runPass}/${runTotal} PARITY`) + "; " +
  `loopback-rewrite reference ${loopbackRefPass ? "PASS" : "FAIL"}` +
  (loopbackRewrite === null ? `, real-daemon proof SKIPPED — ${reason}` : `, real-daemon proof ${loopbackRewrite.pass ? "PASS" : "FAIL"}`));
process.exit(allPass ? 0 : 1);

// ---------------------------------------------------------------------------
function renderReport(o) {
  const L = [];
  L.push("# Sandbox exec-layer parity — LocalSandbox vs DockerSandbox\n");
  L.push(`_Generated ${o.generated_at} · Node ${o.node} · image \`${o.image}\`_\n`);
  L.push("Both sandboxes implement the one `Sandbox` interface (`src/sandbox.ts`): "
    + "`exec({workdir, wrappedCode, env, timeoutMs?}) -> {output, exit, timedOut}`. "
    + "`LocalSandbox` runs `bash -e -c` in a restricted host subprocess (daemon-free default); "
    + "`DockerSandbox` runs it inside a per-identity container via `docker exec`, matching "
    + "`bin/shellm` `execute_code` (bin/shellm:1309-1330).\n");

  L.push("## A. Invocation-shape check (static, no daemon)\n");
  L.push(`Result: **${o.shape_check.pass ? "PASS" : "FAIL"}**\n`);
  L.push("| check | ok |");
  L.push("| --- | --- |");
  for (const c of o.shape_check.checks) L.push(`| ${c.name} | ${c.ok ? "✅" : "❌"} |`);
  L.push("");
  L.push("Constructed argv (secret value proven absent):\n");
  L.push("```\ndocker " + o.shape_check.argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ") + "\n```\n");

  L.push("## B. Behavioral differential\n");
  if (o.differential.status === "SKIPPED") {
    L.push(`Result: **SKIPPED — ${o.differential.reason}.** No pass was faked.\n`);
    L.push("What was still verified without a daemon: the invocation-shape check (§A) — "
      + "argv, env-passing discipline (bare `-e NAME`, secret value off the command line), "
      + "PATH/HOME/-w placement, and `bash -e -c <wrapped_code>` with no double `set -x` — "
      + "all matched against the live `bin/shellm` reference tokens.\n");
  } else {
    L.push(`Result: **${o.differential.pass}/${o.differential.total} scenarios at PARITY** `
      + `(container \`${String(o.differential.container).slice(0, 12)}\`).\n`);
    L.push("| scenario | mode | parity | detail |");
    L.push("| --- | --- | --- | --- |");
    for (const s of o.differential.scenarios) {
      L.push(`| ${s.id} | ${s.compare} | ${s.pass ? "✅" : "❌"} | ${s.note.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
    L.push("### Documented non-identity: `stderr-mixed`\n");
    L.push("`docker exec` (no `-t`) returns container stdout and stderr as separate "
      + "multiplexed channels, so the client-side `2>&1` merge does **not** preserve "
      + "cross-stream ordering — reproducibly, `ERRLINE` may sort ahead of `out1`. "
      + "`LocalSandbox`'s in-process `exec 2>&1` keeps strict order. This divergence is "
      + "inherent to the production path: real Headlong `execute_code` merges the same way "
      + "(`( … exec docker exec … ) </dev/null 2>&1`), so `DockerSandbox` faithfully inherits "
      + "it rather than papering over it. Parity here is asserted on the line SET + exit code; "
      + "for pure-stdout, pure-exit, env, cwd and timeout scenarios the two sandboxes agree exactly.\n");
  }

  L.push("## C. Loopback-rewrite proof (bug #70)\n");
  L.push("A Docker sandbox's `LLM_API_URL`/`SHELLM_API_URL` must be rewritten to "
    + "`host.docker.internal` when it names this host's loopback interface "
    + "(`_shellm_container_api_url`, bin/shellm:216-221), and the container "
    + "started with `--add-host host.docker.internal:host-gateway` "
    + "(bin/shellm:1026-1034) — otherwise a step's `llm`/`mem search` gets "
    + "`connect ECONNREFUSED` against the CONTAINER's own loopback (bug #70, "
    + "director-verified live run).\n");
  L.push(`Reference check: **${o.loopback_rewrite.reference_check.pass ? "PASS" : "FAIL"}**\n`);
  L.push("| check | ok |");
  L.push("| --- | --- |");
  for (const c of o.loopback_rewrite.reference_check.checks) L.push(`| ${c.name} | ${c.ok ? "✅" : "❌"} |`);
  L.push("");
  if (o.loopback_rewrite.differential.status === "SKIPPED") {
    L.push(`Real-daemon proof: **SKIPPED — ${o.loopback_rewrite.differential.reason}.** No pass was faked.\n`);
  } else {
    L.push(`Real-daemon proof: **${o.loopback_rewrite.differential.pass ? "PASS" : "FAIL"}** `
      + "— a real HTTP listener on this host's 127.0.0.1, a real container started via "
      + "`selectSandbox` (mode: docker), and `curl \"$LLM_API_URL\"` run inside it.\n");
    L.push("| check | ok |");
    L.push("| --- | --- |");
    for (const c of o.loopback_rewrite.differential.checks) L.push(`| ${c.name} | ${c.ok ? "✅" : "❌"} |`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
