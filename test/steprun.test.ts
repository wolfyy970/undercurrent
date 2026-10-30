// steprun.test.ts — one wake, in-process (via runStep). The model is recorded real DeepSeek output
// (test/fixtures/recordings/steprun/, test/support/README.md) served on LLM_API_URL by test/support/recordedModel.ts;
// the engine makes its real `llm` call. Each wake's identity text names the chore the recorded reply carries out.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { runStep, getGoals, loadIdentityText, buildLlmClient, buildIdentityConfig } from "../src/steprun.ts";
import { readSteps, rootTrajFile } from "../src/trajCore.mjs";
import { touchDeliberateStop } from "../src/runstate.ts";
import { runMonolithWake } from "../src/monolith.ts";
import { openTrajectory } from "../src/trajectory.ts";
import { LocalSandbox } from "../src/sandbox.ts";
import type { LlmClient, LlmResponse, ChatMessage } from "../src/llm.ts";
import { startFakeServer } from "./llmFakeServer.ts";
import { recordedEndpoint, recordedModel, recordedText, type RecordedModel } from "./support/recordedModel.ts";
void touchDeliberateStop;

const roots: string[] = [];
const models: RecordedModel[] = [];
afterEach(async () => {
  const ms = models.splice(0);
  for (const m of ms) m.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  for (const m of ms) m.verify();
});

/** The env that points this wake's `llm` calls at a recorded scenario. */
async function rec(scenario: string): Promise<Record<string, string>> {
  const { model, env } = await recordedEndpoint("steprun", scenario);
  models.push(model);
  return env;
}
const lastModel = (): RecordedModel => models[models.length - 1]!;
/** The identity text the wake prompt carries (core_identity_prompt.md). */
function setIdentityText(idDir: string, text: string): void {
  fs.writeFileSync(path.join(idDir, "core_identity_prompt.md"), text + "\n");
}
const QUIET =
  'I am {{identity_name}}. Test harness note for this wake: there is nothing to do. Do not run any command and do not append any step. Reply with exactly one bash block whose only line is FINAL="idle".';
const chore = (cmd: string) =>
  `I am {{identity_name}}. My one standing chore each wake: run \`${cmd}\` exactly as written, then end the run with FINAL="done". Nothing else.`;

function makeIdentity(): { root: string; idDir: string; rootTrajectoryId: string; env: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-steprun-"));
  roots.push(root);
  const result = identityNew({ identitiesRoot: root, name: "pax" });
  const env = resolveIdentityEnv(result.identityDir, { base: process.env as Record<string, string> });
  env["SHELLM_SANDBOX"] = "local"; // never touch real docker in this suite
  return { root, idDir: result.identityDir, rootTrajectoryId: result.rootTrajectoryId, env };
}

describe("steprun: getGoals / loadIdentityText", () => {
  it("getGoals returns '(no goals set)' when no memory is a goal/intention", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-goals-"));
    roots.push(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "a.md"), "---\ntype: memory\n---\nsome note\n");
    expect(getGoals(root)).toBe("(no goals set)");
  });

  it("getGoals collects goal/intention memories, first 3 non-leading-blank body lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-goals2-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "a.md"), "---\ntype: goal\n---\n\nlearn rust\nship the port\nrest later\nextra line\n");
    fs.writeFileSync(path.join(root, "b.md"), "---\ntype: intention\n---\nbe kinder\n");
    fs.writeFileSync(path.join(root, "c.md"), "---\ntype: memory\n---\nirrelevant\n");
    const goals = getGoals(root);
    expect(goals).toContain("- learn rust\nship the port\nrest later");
    expect(goals).not.toContain("extra line");
    expect(goals).toContain("- be kinder");
  });

  it("loadIdentityText substitutes {{identity_name}} in a custom core_identity_prompt.md", () => {
    const { idDir } = makeIdentity();
    fs.writeFileSync(path.join(idDir, "core_identity_prompt.md"), "I am {{identity_name}}, hear me roar.\n");
    expect(loadIdentityText(idDir, "pax")).toBe("I am pax, hear me roar.\n");
  });

  it("loadIdentityText falls back to the default paragraph when no override file exists", () => {
    const { idDir } = makeIdentity();
    expect(loadIdentityText(idDir, "pax")).toMatch(/^I am pax, I am an AI with an identity/);
  });
});

describe("steprun: buildLlmClient", () => {
  it("an openai-compatible LLM_API_URL endpoint answers the call (the only model path; there is no replay switch)", async () => {
    const env = await rec("plain-hello");
    const client = buildLlmClient(env);
    const r = await client.complete("Reply with the single word hello.", [{ role: "user", content: "go" }]);
    expect(r.text).toBe(recordedText(lastModel().recording.calls[0]!));
    expect(r.text.toLowerCase()).toContain("hello");
    expect(lastModel().requests).toHaveLength(1);
  });

  it("throws when no API key or endpoint is configured", () => {
    expect(() => buildLlmClient({})).toThrow(/no API key/);
  });

  it("HEADLONG_LLM_REPLAY is not a seam: a fixture path in it is ignored, the endpoint is called", async () => {
    const env = await rec("plain-hello");
    const client = buildLlmClient({ ...env, HEADLONG_LLM_REPLAY: "/nonexistent/fixture.json", HEADLONG_LLM_REPLAY_MONOLITH: "/nonexistent" }, "monolith");
    const r = await client.complete("Reply with the single word hello.", [{ role: "user", content: "go" }]);
    expect(r.text).toBe(recordedText(lastModel().recording.calls[0]!));
    expect(lastModel().requests).toHaveLength(1);
  });

  // Bug #39: upstream bin/llm (and this port's own src/llmCli.ts:1642-1650)
  // treat LLM_API_URL as the FULL endpoint URL for keyed providers like
  // openrouter — `url="${LLM_API_URL:-https://openrouter.ai/api/v1/chat/completions}"`.
  // buildLlmClient instead fed it in as a BASE url that OpenRouterClient.complete()
  // then appends "/chat/completions" to, so a custom endpoint 404s with a
  // doubled suffix (".../chat/completions/chat/completions").
  it("LLM_API_URL is used as the full endpoint, not a base with /chat/completions appended", async () => {
    const srv = await startFakeServer();
    try {
      // W1: the client runs `llm` like upstream's shellm does, and `llm` streams — so the endpoint answers in SSE. The
      // body is the recorded real stream of steprun/plain-hello; this server is used because it records the request path.
      const recorded = recordedModel("steprun", "plain-hello").recording.calls[0]!;
      srv.script([{ sse: true, body: recorded.response.body }]);
      const client = buildLlmClient({ OPENROUTER_API_KEY: "test-key", LLM_API_URL: srv.url });
      const r = await client.complete("sys", [{ role: "user", content: "go" }]);
      expect(r.text).toBe(recordedText(recorded));
      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0]!.url).toBe("/v1/chat/completions");
    } finally {
      await srv.close();
    }
  });
});

describe("steprun: runStep", () => {
  it("monolith: an idle reply produces the same step sequence as the topology harness", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    setIdentityText(idDir, QUIET);
    Object.assign(env, await rec("quiet-idle"));

    const code = await runStep("monolith", { type: "" }, env);
    expect(code).toBe(0);

    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    const types = steps.map((s) => s["type"]);
    expect(types).toContain("shellm-run");
    expect(types).toContain("prompt");
    expect(types).toContain("reasoning");
    expect(types).toContain("shell-output");
    expect(types).toContain("final");
    expect(types[types.length - 1]).toBe("idle");
    expect((steps[steps.length - 1] as Record<string, unknown>)["source"]).toBe("monolith");
  });

  it("monolith: wake_at is NOT armed without a run/dispatcher.token (arm_wake gate)", async () => {
    const { root, idDir, env } = makeIdentity();
    setIdentityText(idDir, QUIET);
    Object.assign(env, await rec("quiet-idle"));
    await runStep("monolith", { type: "" }, env);
    expect(fs.existsSync(path.join(idDir, "run", "monolith.wake_at"))).toBe(false);
  });

  it("monolith: wake_at IS armed once run/dispatcher.token exists", async () => {
    const { root, idDir, env } = makeIdentity();
    fs.mkdirSync(path.join(idDir, "run"), { recursive: true });
    fs.writeFileSync(path.join(idDir, "run", "dispatcher.token"), "1.1.1");
    setIdentityText(idDir, QUIET);
    Object.assign(env, await rec("quiet-idle"));
    await runStep("monolith", { type: "" }, env);
    expect(fs.existsSync(path.join(idDir, "run", "monolith.wake_at"))).toBe(true);
  });

  it("responder: NO_REPLY produces no outbound message", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const { appendStep } = await import("../src/trajCore.mjs");
    const msgId = appendStep(trajFile, { type: "message", content: "thanks", from: "operator", to: "pax", source: "chat" }, {});

    Object.assign(env, await rec("thanks-no-reply"));
    const code = await runStep("responder", { type: "message", content: "thanks", step_id: msgId, from: "operator", to: "pax", source: "chat" }, env);
    expect(code).toBe(0);

    const steps = readSteps(trajFile) as Record<string, unknown>[];
    expect(steps.some((s) => s["type"] === "message" && s["from"] === "pax")).toBe(false);
    expect(steps.some((s) => s["type"] === "observation" && s["decision"] === "no-reply")).toBe(true);
    expect(recordedText(lastModel().recording.calls[0]!).trim()).toBe("NO_REPLY");
  });

  it("responder: MEM_DIR missing from the passed env still writes person notes to the identity's own memories dir (steprun.ts memDir-default fix)", async () => {
    // identity-env.ts:87 GUARANTEES resolveIdentityEnv always sets MEM_DIR —
    // this simulates a caller that skips resolveIdentityEnv (e.g. a hand-
    // built env), the scenario steprun.ts's old `...(execEnv.MEM_DIR ? {...}
    // : {})` silently dropped `memDir` from RunResponderOptions entirely for.
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const { appendStep } = await import("../src/trajCore.mjs");
    const msgId = appendStep(trajFile, { type: "message", content: "hi, I am Andy", from: "andy", to: "pax", source: "chat" }, {});

    // Recorded: the responder's real reply, then the notes writer's real notes (in that order: SYNC runs notes after the reply).
    const llmEnv = await rec("andy-hi-notes-sync");
    const envNoMemDir = { ...env, ...llmEnv };
    delete envNoMemDir["MEM_DIR"];
    envNoMemDir["RESPONDER_PERSON_NOTES_SYNC"] = "1"; // deterministic: no detached child to poll for

    const code = await runStep(
      "responder",
      { type: "message", content: "hi, I am Andy", step_id: msgId, from: "andy", to: "pax", source: "chat" },
      envNoMemDir
    );
    expect(code).toBe(0);

    const memDir = path.join(idDir, "memories");
    const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md") && f.includes("person-andy"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("responder: SYNC unset survives process boundaries — a type: person memory eventually appears from the detached child (the process.exit bug this fix closes)", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const { appendStep } = await import("../src/trajCore.mjs");
    const msgId = appendStep(trajFile, { type: "message", content: "hi, I am Andy", from: "andy", to: "pax", source: "chat" }, {});

    Object.assign(env, await rec("andy-hi-notes-async"));
    // RESPONDER_PERSON_NOTES_SYNC intentionally unset — the async/detached path.
    const start = Date.now();
    const code = await runStep(
      "responder",
      { type: "message", content: "hi, I am Andy", step_id: msgId, from: "andy", to: "pax", source: "chat" },
      env
    );
    const runStepMs = Date.now() - start;
    expect(code).toBe(0);
    // runResponder must not have blocked on the notes LLM call.
    expect(runStepMs).toBeLessThan(2000);

    const memDir = path.join(idDir, "memories");
    const deadline = Date.now() + 5000;
    let files: string[] = [];
    while (Date.now() < deadline) {
      files = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => f.endsWith(".md") && f.includes("person-andy")) : [];
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(memDir, files[0]!), "utf8");
    expect(content).toContain("type: person");
    expect(content).toContain("person_key: andy");

    const logFile = path.join(idDir, "run", "logs", "responder-notes.log");
    expect(fs.existsSync(logFile)).toBe(true);
  });

  it("retrieval: runs without a sandbox/LLM at all (no-LLM thinker)", async () => {
    const { idDir, env } = makeIdentity();
    fs.rmSync(path.join(idDir, "thinkers", "retrieval", "disabled"));
    const code = await runStep("retrieval", { type: "thought", content: "hello world", source: "seed" }, env);
    expect(code).toBe(0); // no memories yet -> a clean no-op exit
  });

  it("dies (code 1) when IDENTITY_DIR/TRAJ_DIR/TRAJ_ID are unset", async () => {
    const code = await runStep("monolith", { type: "" }, {});
    expect(code).toBe(1);
  });

  it("monolith: CHATRC reaches the sandboxed exec env (upstream 30561e9 — thinkers/_lib/common.sh forwards it; a mid-wake `chat send` needs the identity's own sender config, not ./.chatrc)", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    setIdentityText(idDir, chore('echo "CHATRC=$CHATRC"'));
    Object.assign(env, await rec("echo-chatrc"));
    const code = await runStep("monolith", { type: "" }, env);
    expect(code).toBe(0);
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    const shellOut = steps.find((s) => s["type"] === "shell-output") as Record<string, unknown>;
    expect(shellOut["stdout"]).toContain(`CHATRC=${path.join(idDir, "chat", ".chatrc")}`);
  });

  it("monolith: IDENTITY_DIR and the rest of what the dispatcher exports reach the local wake shell (bin/thinkers:387-389 export, bin/shellm:1629 local `bash -e -c` inherits; a mind saw IDENTITY_DIR empty 82 times)", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    env["THINK_MODEL"] = "vendor/model";
    env["THINK_CONTEXT_TAIL"] = "30";
    env["SKILLS_KERNEL_DIR"] = path.join(idDir, "kernel");
    env["THINKERS_DIR"] = path.join(idDir, "thinkers");
    env["SHELLM_HOME"] = path.join(idDir, ".shellm");
    env["SHELLM_SANDBOX"] = "local";
    setIdentityText(
      idDir,
      chore('for v in IDENTITY_DIR IDENTITY_NAME SKILLS_KERNEL_DIR THINKERS_DIR SHELLM_HOME THINK_MODEL THINK_CONTEXT_TAIL; do printf "ENV %s=%s\\n" "$v" "${!v-<unset>}"; done')
    );
    Object.assign(env, await rec("echo-identity-env"));
    const code = await runStep("monolith", { type: "" }, env);
    expect(code).toBe(0);
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    const out = String((steps.find((s) => s["type"] === "shell-output") as Record<string, unknown>)["stdout"]);
    expect(out).toContain(`ENV IDENTITY_DIR=${idDir}\n`);
    expect(out).toContain("ENV IDENTITY_NAME=pax\n");
    expect(out).toContain(`ENV SKILLS_KERNEL_DIR=${path.join(idDir, "kernel")}\n`);
    expect(out).toContain(`ENV THINKERS_DIR=${path.join(idDir, "thinkers")}\n`);
    expect(out).toContain(`ENV SHELLM_HOME=${path.join(idDir, ".shellm")}\n`);
    expect(out).toContain("ENV THINK_MODEL=vendor/model\n");
    expect(out).toContain("ENV THINK_CONTEXT_TAIL=30\n");
  });

  it("monolith: a skill-declared env: var reaches the sandboxed exec env when set (bug #35, thinkers/_lib/common.sh collect_skill_vars + _build_shellm_flags)", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    fs.mkdirSync(path.join(idDir, "skills", "obsidian-test"), { recursive: true });
    fs.writeFileSync(
      path.join(idDir, "skills", "obsidian-test", "SKILL.md"),
      '---\nname: obsidian-test\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["OBSIDIAN_VAULT"]\n---\nbody\n'
    );
    env["OBSIDIAN_VAULT"] = "/tmp/some-vault-path-not-checked-here";
    setIdentityText(idDir, chore('echo "OBSIDIAN_VAULT=$OBSIDIAN_VAULT"'));
    Object.assign(env, await rec("echo-obsidian-vault"));
    const code = await runStep("monolith", { type: "" }, env);
    expect(code).toBe(0);
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    const shellOut = steps.find((s) => s["type"] === "shell-output") as Record<string, unknown>;
    expect(shellOut["stdout"]).toContain("OBSIDIAN_VAULT=/tmp/some-vault-path-not-checked-here");
  });

  it("monolith: a skill-declared env: var is NOT forwarded when unset in the environment (matches Bash's `[[ -n \"$vval\" ]]` guard)", async () => {
    const { root, idDir, env } = makeIdentity();
    fs.mkdirSync(path.join(idDir, "skills", "obsidian-test"), { recursive: true });
    fs.writeFileSync(
      path.join(idDir, "skills", "obsidian-test", "SKILL.md"),
      '---\nname: obsidian-test\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["OBSIDIAN_VAULT"]\n---\nbody\n'
    );
    delete env["OBSIDIAN_VAULT"];
    const identity = buildIdentityConfig({ env });
    expect(identity.execEnv?.["OBSIDIAN_VAULT"]).toBeUndefined();
  });

  // PORT-NOTE (1c: c78d283/a7b6b37) — a skill declaring LLM_API_URL or
  // SHELLM_API_URL as an `env:` var must not re-forward it via skillVarMounts
  // and clobber shellm's own Docker-rewritten endpoint value; those two names
  // are already unconditionally forwarded by forwardedEnv/FORWARDED_ENV_KEYS.
  it("monolith: a skill declaring LLM_API_URL/SHELLM_API_URL as env: is not double-forwarded via skillVarMounts", async () => {
    const { idDir, env } = makeIdentity();
    fs.mkdirSync(path.join(idDir, "skills", "endpoint-test"), { recursive: true });
    fs.writeFileSync(
      path.join(idDir, "skills", "endpoint-test", "SKILL.md"),
      '---\nname: endpoint-test\ndescription: d\nmetadata:\n  shelllm:\n    requires:\n      env: ["LLM_API_URL", "SHELLM_API_URL"]\n---\nbody\n'
    );
    env["LLM_API_URL"] = "https://skill-declared.example/v1";
    env["SHELLM_API_URL"] = "https://skill-declared.example/v2";
    const identity = buildIdentityConfig({ env });
    expect(identity.skillVarMounts?.some((v) => v.name === "LLM_API_URL")).toBe(false);
    expect(identity.skillVarMounts?.some((v) => v.name === "SHELLM_API_URL")).toBe(false);
  });

  // bug #70 (bin/shellm:216-221 `_shellm_container_api_url`, bin/shellm:2659-
  // 2662/2679-2680/2712): a Docker sandbox's in-container tools must reach a
  // loopback-bound model server via host.docker.internal, not this host's
  // own loopback — the director-verified failure was `mem search` inside the
  // sandbox getting `connect ECONNREFUSED 127.0.0.1:<port>`. This drives the
  // FULL runStep wiring (buildIdentityConfig -> selectSandbox ->
  // applyDockerApiUrlRewrite -> the sandboxed exec) against a FAKE `docker`
  // on PATH (same technique as test/sandbox-docker.test.ts's FAKE_DOCKER;
  // its "exec" branch just runs the wrapped bash code directly — no real
  // container needed to prove the ENV VALUE the model's code sees is
  // rewritten). The real-daemon proof that the rewritten host lands on the
  // Docker host gateway lives in test/sandbox-runtime-docker.test.ts.
  it("monolith: a Docker-mode wake sees LLM_API_URL rewritten to host.docker.internal in its sandboxed exec env", async () => {
    const fakeDockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-steprun-"));
    roots.push(fakeDockerDir);
    const dockerScript = [
      "#!/usr/bin/env bash",
      'case "$1" in',
      "  info|pull|rm|inspect) exit 0 ;;",
      "  image) exit 0 ;;",
      '  run) echo "fake-container-$$"; exit 0 ;;',
      "  exec)",
      "    shift",
      "    while [ $# -gt 0 ]; do",
      '      case "$1" in',
      "        -e) shift; shift ;;",
      "        -w) shift; shift ;;",
      "        --user) shift; shift ;;",
      "        -i) shift ;;",
      "        *) shift; break ;;",
      "      esac",
      "    done",
      '    exec "$@"',
      "    ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(fakeDockerDir, "docker"), dockerScript);
    fs.chmodSync(path.join(fakeDockerDir, "docker"), 0o755);

    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${fakeDockerDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      const { root, idDir, rootTrajectoryId, env } = makeIdentity();
      env["SHELLM_SANDBOX"] = "docker";
      // The wake's own model endpoint is on loopback; the sandbox must see it through host.docker.internal.
      setIdentityText(idDir, chore('echo "LLM_API_URL=$LLM_API_URL"'));
      const llmEnv = await rec("echo-llm-api-url");
      Object.assign(env, llmEnv);
      env["SHELLM_API_URL"] = llmEnv["LLM_API_URL"]!;
      const server = { port: new URL(llmEnv["LLM_API_URL"]!).port };
      const code = await runStep("monolith", { type: "" }, env);
      expect(code).toBe(0);
      const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
      const steps = readSteps(trajFile) as Record<string, unknown>[];
      const shellOut = steps.find((s) => s["type"] === "shell-output") as Record<string, unknown>;
      // Rewritten for the sandbox — not the original loopback URL.
      expect(shellOut["stdout"]).toContain(`LLM_API_URL=http://host.docker.internal:${server.port}/v1/chat/completions`);
      expect(shellOut["stdout"]).not.toContain(`LLM_API_URL=http://127.0.0.1:${server.port}`);
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  it("monolith: SHELLM_MAX_ITERATIONS in the env bounds a wake that never emits FINAL (bin/shellm:55-80 parity)", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    // Every turn runs successfully but never sets FINAL — without the env knob wired, runShellm would ask for a
    // 5th reply, which the 4-call recording does not have (a recording miss fails the test).
    setIdentityText(
      idDir,
      'I am {{identity_name}}. My standing chore is a long job that never finishes within one wake: every reply is exactly one bash block whose only line is `echo "iterating"`. Keep going turn after turn and never set FINAL.'
    );
    Object.assign(env, await rec("never-final"));
    env["SHELLM_MAX_ITERATIONS"] = "4";

    const code = await runStep("monolith", { type: "" }, env);
    expect(code).toBe(0);

    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    const reasoningSteps = steps.filter((s) => s["type"] === "reasoning");
    expect(reasoningSteps).toHaveLength(4);
    expect(steps.some((s) => s["type"] === "final")).toBe(false); // stopped by max-iter, not FINAL

    // The recorded shellm-run header reflects the env value (src/shellm.ts:88).
    const header = steps.find((s) => s["type"] === "shellm-run") as Record<string, unknown>;
    expect(header["max_iterations"]).toBe("4");
  });

  it("shellm-run header's max_tokens carries the raw SHELLM_MAX_TOKENS text (bin/shellm:2149), empty when unset", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    setIdentityText(idDir, QUIET);
    Object.assign(env, await rec("quiet-idle"));
    env["SHELLM_MAX_TOKENS"] = "8192";

    await runStep("monolith", { type: "" }, env);
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const header = (readSteps(trajFile) as Record<string, unknown>[]).find((s) => s["type"] === "shellm-run") as Record<
      string,
      unknown
    >;
    expect(header["max_tokens"]).toBe("8192");
  });

  it("shellm-run header's max_tokens is empty when SHELLM_MAX_TOKENS is unset", async () => {
    const { root, idDir, rootTrajectoryId, env } = makeIdentity();
    setIdentityText(idDir, QUIET);
    Object.assign(env, await rec("quiet-idle"));
    delete env["SHELLM_MAX_TOKENS"];

    await runStep("monolith", { type: "" }, env);
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), rootTrajectoryId);
    const header = (readSteps(trajFile) as Record<string, unknown>[]).find((s) => s["type"] === "shellm-run") as Record<
      string,
      unknown
    >;
    expect(header["max_tokens"]).toBe("");
  });
});

describe("steprun: SHELLM_SYSTEM_PROMPT override (bin/shellm:198,1548-1549 build_system_prompt)", () => {
  /** Serves the recorded quiet wake (steprun/quiet-idle); `systemOf(client)` is the exact system prompt the model received. */
  const CapturingClient = () => {
    const m = recordedModel("steprun", "quiet-idle");
    models.push(m);
    return m;
  };
  const systemOf = (m: RecordedModel): string[] =>
    m.requests.map((r) => ((r["messages"] as ChatMessage[]).find((x) => x.role === "system")?.content ?? "") as string);

  async function runOneWake(env: Record<string, string>, idDir: string, rootTrajectoryId: string, client: RecordedModel): Promise<void> {
    const identity = buildIdentityConfig({ env });
    identity.env = { name: identity.name, type: "local" };
    const traj = openTrajectory(env["TRAJ_DIR"]!, env["TRAJ_ID"]!);
    await runMonolithWake({
      trajectory: traj,
      identity,
      llm: client,
      sandbox: new LocalSandbox(),
      trigger: { triggerType: "" },
    });
    void idDir;
    void rootTrajectoryId;
  }

  it("SHELLM_SYSTEM_PROMPT set: overrides the bundled default, with exactly one trailing newline appended", async () => {
    const { idDir, rootTrajectoryId, env } = makeIdentity();
    env["SHELLM_SYSTEM_PROMPT"] = "You are a terse test double.";
    const client = CapturingClient();
    await runOneWake(env, idDir, rootTrajectoryId, client);
    expect(systemOf(client)).toEqual(["You are a terse test double.\n"]);
  });

  it("SHELLM_SYSTEM_PROMPT set with its own trailing newline: still gets exactly one MORE appended (printf '%s\\n', not conditional)", async () => {
    const { idDir, rootTrajectoryId, env } = makeIdentity();
    env["SHELLM_SYSTEM_PROMPT"] = "line one\nline two\n";
    const client = CapturingClient();
    await runOneWake(env, idDir, rootTrajectoryId, client);
    expect(systemOf(client)[0]).toBe("line one\nline two\n\n");
  });

  it("SHELLM_SYSTEM_PROMPT unset or empty: falls back to the bundled default text (the `-n` test)", async () => {
    const { idDir, rootTrajectoryId, env } = makeIdentity();
    delete env["SHELLM_SYSTEM_PROMPT"];
    const client1 = CapturingClient();
    await runOneWake(env, idDir, rootTrajectoryId, client1);
    expect(systemOf(client1)[0]).toContain("You are running in shellm");

    const { idDir: idDir2, rootTrajectoryId: rootId2, env: env2 } = makeIdentity();
    env2["SHELLM_SYSTEM_PROMPT"] = "";
    const client2 = CapturingClient();
    await runOneWake(env2, idDir2, rootId2, client2);
    expect(systemOf(client2)[0]).toContain("You are running in shellm");
  });
});

// ---------------------------------------------------------------------------
// buildIdentityConfig: workdir LEAF is $run_name, not $process.pid (bug #64)
// ---------------------------------------------------------------------------
//
// bin/shellm:2176-2178 (existing/resumed trajectory — every wake this port
// drives): `run_name=$(basename "$(dirname "$_traj_file")")`; bin/shellm:2232
// falls back to `workdir="$SHELLM_WORKDIRS_DIR/$run_name"` absent an explicit
// `--workdir` override. `${process.pid}` (the pre-fix leaf) is a per-PROCESS
// token that never appears anywhere in upstream's own workdir-naming scheme.
describe("buildIdentityConfig: workdir leaf is the trajectory's own dir name, not process.pid (bug #64)", () => {
  it("the workdir leaf is `<hex8>-root` (this port's root-trajectory dir name) and that directory exists on disk", () => {
    const { rootTrajectoryId, env } = makeIdentity();
    const identity = buildIdentityConfig({ env });
    const expectedLeaf = `${rootTrajectoryId.slice(0, 8)}-root`;
    expect(path.basename(identity.workdir)).toBe(expectedLeaf);
    expect(path.basename(identity.workdir)).not.toBe(String(process.pid));
    expect(fs.existsSync(identity.workdir)).toBe(true);
    expect(fs.statSync(identity.workdir).isDirectory()).toBe(true);
  });

  it("honors SHELLM_WORKDIRS_DIR as the base, only the leaf changes", () => {
    const { root, env } = makeIdentity();
    const workdirsBase = path.join(root, "custom-workdirs");
    env["SHELLM_WORKDIRS_DIR"] = workdirsBase;
    const identity = buildIdentityConfig({ env });
    expect(path.dirname(identity.workdir)).toBe(workdirsBase);
  });
});

describe.skipIf(!process.env["PARITY_UPSTREAM_ROOT"])(
  "workdir leaf vs. the real upstream bin/traj show's run_name derivation (Bash oracle, PARITY_UPSTREAM_ROOT)",
  () => {
    const upstreamRoot = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
    const upstreamTraj = path.join(upstreamRoot, "bin", "traj");

    it("basename(dirname(bin/traj show's File:)) equals the port's workdir leaf (bin/shellm:2176-2178)", () => {
      const { idDir, rootTrajectoryId, env } = makeIdentity();
      const identity = buildIdentityConfig({ env });

      const r = spawnSync("bash", [upstreamTraj, "show", rootTrajectoryId, "--traj_dir", path.join(idDir, "trajectories")], {
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      const fileLine = r.stdout.split("\n").find((l) => l.startsWith("File:"));
      expect(fileLine).toBeDefined();
      const trajFile = fileLine!.replace(/^File:\s*/, "").trim();
      const runName = path.basename(path.dirname(trajFile));

      expect(path.basename(identity.workdir)).toBe(runName);
    });
  }
);
