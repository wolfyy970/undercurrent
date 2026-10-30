// steprun.ts — one thinker wake, end to end (PLAN-daemon §3 item 4).
//
// Invoked by bin/thinker-step.mjs, itself exec'd by the identity's
// `thinkers/<name>/step` file (installed by identity.ts, a Node file — never
// Bash). Reads the trigger JSON on stdin, resolves the identity's env, builds
// the IdentityConfig, opens a PLAIN FileTrajectory (never ObservableTrajectory
// — this process has no in-memory bus to observe; the daemon's TrajFeeder
// picks up whatever this appends), selects a sandbox, and dispatches to the
// named thinker's engine entrypoint. This is the ONLY module that imports
// both the engine (monolith/responder/retrieval) AND resolveIdentityEnv +
// selectSandbox — the daemon itself never imports the engine (PLAN-daemon §1).

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveIdentityEnv } from "./identity-env.ts";
import { selectSandbox, forwardedEnv, applyDockerApiUrlRewrite, applyLocalInheritedEnv } from "./sandbox-runtime.ts";
import { collectSkillVars } from "./skill-env.ts";
import { openTrajectory, resolveTrajFile, rootTrajFile } from "./trajectory.ts";
import { runMonolithWake, type IdentityConfig } from "./monolith.ts";
import { runResponder } from "./responder.ts";
import { runRetrievalStep, RETRIEVAL_SUBSCRIPTION as _RETRIEVAL_SUBSCRIPTION } from "./retrieval.ts";
import { readMemoryFiles, frontmatterField, parseMemory } from "./mem.ts";
import { buildSkillsPrompt, type SkillsConfig, type Ctx } from "./skills.ts";
import type { LlmClient } from "./llm.ts";
import { LlmCliClient } from "./llmCliClient.ts";
import { constantsFromEnv } from "./shellm.ts";

void _RETRIEVAL_SUBSCRIPTION; // re-exported for readers of this module's surface

// PORT-NOTE (1c: 12ca841): upstream's own tools/identity hardcoded default
// text (this literal) was never updated by 12ca841 (which only edited
// deploy/slack-persona.md's parallel "I am driven by standalone commands
// (...)" list — see PARITY.md "Retired: focus/glob/put/sub/view") or by any
// later commit through 5458fee — it still reads "...focus, mem, skills,
// traj..." upstream today. This port already retired focus/glob/put/sub/view
// in lane 1c-f (sync1c/f-tool-cull), so keeping "focus" here would describe a
// command that no longer exists in this port. Dropping it mirrors the pattern
// 12ca841 established elsewhere (deploy/slack-persona.md's list drops the
// same five names down to "chat, mem, traj, skills, recap, context") rather
// than upstream's own stale tools/identity bytes.
const DEFAULT_IDENTITY_TEXT =
  "I am {{identity_name}}, I am an AI with an identity, life context (e.g., memory), and skills. " +
  "I am concise, smart, ambitious, and empathetic. I can take action in the world around me by using the shell.\n\n" +
  "I am driven by standalone commands (think, chat, mem, skills, traj) that read my identity " +
  "from environment variables. Most of my thinking happens via shellm.\n";

/** `identity prompt`'s core-identity block (tools/identity:1468-1480). */
export function loadIdentityText(identityDir: string, identityName: string): string {
  const custom = path.join(identityDir, "core_identity_prompt.md");
  let text: string;
  try {
    text = fs.readFileSync(custom, "utf8");
  } catch {
    text = DEFAULT_IDENTITY_TEXT;
  }
  return text.replaceAll("{{identity_name}}", identityName);
}

/** get_goals (thinkers/_lib/common.sh:88-111): goal|intention memories, first
 *  3 non-leading-blank body lines each, "(no goals set)" when none qualify. */
export function getGoals(memDir: string): string {
  let goals = "";
  for (const f of readMemoryFiles(memDir)) {
    const type = frontmatterField(f.content, "type");
    if (type !== "goal" && type !== "intention") continue;
    const body = parseMemory(f.content, f.filename).body;
    const lines = body.split("\n");
    let start = 0;
    while (start < lines.length && lines[start]!.trim() === "") start++;
    const snippet = lines.slice(start, start + 3).join("\n");
    if (snippet) goals += `- ${snippet}\n`;
  }
  return goals || "(no goals set)";
}

export interface BuildIdentityConfigOptions {
  env: Record<string, string>;
  model?: string;
  effort?: string;
}

/** Assemble the IdentityConfig a wake needs, from a resolved identity env. */
export function buildIdentityConfig(opts: BuildIdentityConfigOptions): IdentityConfig {
  const env = opts.env;
  const identityDir = env["IDENTITY_DIR"]!;
  const name = env["IDENTITY_NAME"]!;
  const trajDir = env["TRAJ_DIR"]!;
  const trajId = env["TRAJ_ID"];
  const stateDir = path.join(identityDir, "run");
  const thinkersDir = env["THINKERS_DIR"] ?? path.join(identityDir, "thinkers");
  // PORT-NOTE (bug #64, bin/shellm:2176-2178,2208,2232): the workdir LEAF is
  // `$run_name`, not a per-PROCESS token. Every wake this port drives is the
  // "existing trajectory" (`--traj $TRAJ_ID`) path — bin/shellm never takes
  // the "new trajectory" branch here — where upstream derives
  // `run_name=$(basename "$(dirname "$_traj_file")")` from `traj show`'s
  // resolved file. This port's own trajectory convention (trajCore.mjs
  // `rootTrajFile`) always writes the root trajectory at
  // `<TRAJ_DIR>/<hex8>-root/trajectory.jsonl`, so `run_name` is that
  // directory's own basename — resolved the SAME way the engine itself
  // resolves TRAJ_ID to a file (`resolveTrajFile`, falling back to the
  // canonical `<hex8>-root` shape `rootTrajFile` computes when the
  // trajectory doesn't exist on disk yet). `${process.pid}` (the pre-fix
  // leaf) never appears anywhere in upstream's own workdir-naming scheme.
  const trajFilePath = trajId ? (resolveTrajFile(trajDir, trajId) ?? rootTrajFile(trajDir, trajId)) : undefined;
  const runName = trajFilePath ? path.basename(path.dirname(trajFilePath)) : `${process.pid}`;
  const workdir = path.join(env["SHELLM_WORKDIRS_DIR"] ?? path.join(identityDir, ".shellm", "workdirs"), runName);
  fs.mkdirSync(workdir, { recursive: true });

  const skillsCfg: SkillsConfig = {
    skillsDir: env["SKILLS_DIR"] ?? path.join(identityDir, "skills"),
    kernelDir: env["SKILLS_KERNEL_DIR"] ?? path.join(identityDir, "kernel"),
    kernelTokenBudget: Number(env["SKILLS_KERNEL_TOKEN_BUDGET"] ?? 8000),
    remotes: env["SKILLS_REMOTES"] ?? "",
    verbose: false,
    skillsrcPath: env["SKILLSRC"] ?? path.join(identityDir, "skills", ".skillsrc"),
  };
  const ctx: Ctx = { cwd: identityDir, env, stdout: () => {}, stderr: () => {}, isTTY: false };
  let skillsText = "";
  try {
    skillsText = buildSkillsPrompt(skillsCfg, ctx);
  } catch {
    skillsText = ""; // a skills read failure must not block the wake
  }

  // bug #35 (thinkers/_lib/common.sh:315-346 collect_skill_vars + :405-411's
  // trailing --var loop): forward every skill-declared env: var that is set
  // and non-empty in the current environment — matches Bash's
  // `[[ -n "$vval" ]] && printf '%s\n' "--var" "$vname=$vval"` guard exactly
  // (unset OR empty is skipped, same as every other forwarded var here).
  // PORT-NOTE (1c: c78d283/a7b6b37 — `_export_skill_vars` skips
  // LLM_API_URL/SHELLM_API_URL): shellm owns endpoint-alias resolution and
  // Docker rewriting for those two names (already unconditionally forwarded
  // by `forwardedEnv`/FORWARDED_ENV_KEYS below, pre-dating this sync); a
  // skill that also declares one of them as an `env:` var must not re-forward
  // its un-rewritten value here and clobber shellm's canonical one.
  const skillVarMounts: Array<{ name: string; value: string }> = [];
  for (const vname of collectSkillVars(identityDir, skillsCfg.kernelDir)) {
    if (vname === "LLM_API_URL" || vname === "SHELLM_API_URL") continue;
    const vval = env[vname];
    if (vval) skillVarMounts.push({ name: vname, value: vval });
  }

  return {
    name,
    // bash `$(identity prompt)` / `$(skills prompt)` strip trailing newlines (thinkers/_lib/common.sh:281-282).
    identityText: loadIdentityText(identityDir, name).replace(/\n+$/, ""),
    skillsText: skillsText.replace(/\n+$/, ""),
    goals: getGoals(env["MEM_DIR"] ?? path.join(identityDir, "memories")),
    trajDir,
    workdir,
    binDir: path.join(env["HEADLONG_TS_HOME"] ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), "bin"),
    stateDir,
    thinkersDir,
    model: opts.model ?? env["SHELLM_MODEL"] ?? "deepseek/deepseek-v4-flash-0731",
    ...(opts.effort ? { effort: opts.effort } : {}),
    // bin/shellm:198,1548-1549 SHELLM_SYSTEM_PROMPT override, `[[ -n ]]`-gated
    // (set-but-empty does NOT override, same as the Bash's `-n` test).
    ...(env["SHELLM_SYSTEM_PROMPT"] ? { systemPrompt: env["SHELLM_SYSTEM_PROMPT"] } : {}),
    // bin/shellm:2149 `--arg max_tok "${SHELLM_MAX_TOKENS:-}"` — the raw env
    // text, recorded on the shellm-run header whether or not it's set.
    maxTokens: env["SHELLM_MAX_TOKENS"] ?? "",
    env: { name, type: "local" }, // overwritten below once selectSandbox runs
    execEnv: {
      MEM_DIR: env["MEM_DIR"] ?? "",
      SKILLS_DIR: env["SKILLS_DIR"] ?? "",
      // upstream 30561e9 (thinkers/_lib/common.sh): `chat` reads the
      // identity's sender config through CHATRC (identity-env.ts sets it to
      // <identityDir>/chat/.chatrc); without forwarding it into the wake's
      // exec env, a mid-wake `chat send` fell back to ./.chatrc relative to
      // the step's workdir instead — a real capability gap, not Docker-only
      // here (this port's exec env is the same code path for local/Docker).
      ...(env["CHATRC"] ? { CHATRC: env["CHATRC"] } : {}),
      ...forwardedEnv(env),
      // bug #35: skill-declared env vars, forwarded last (matching Bash's
      // ordering — these are the LAST --var entries _build_shellm_flags emits).
      ...Object.fromEntries(skillVarMounts.map((v) => [v.name, v.value])),
    },
    skillVarMounts,
  };
}

/** The wake's model client: this port's `llm` (src/llmCli.ts), run in-process with the argv upstream's shellm/responder use.
 *  There is no replay switch here (upstream has none): tests point LLM_API_URL at a local endpoint, as upstream's
 *  tests/test_llm_retry.sh does with its curl stub. `thinkerName` picks the responder's plain call shape. */
export function buildLlmClient(env: Record<string, string>, thinkerName?: string): LlmClient {
  // BEHAVIORAL-PARITY ROUND (W1): upstream's shellm loop and responder make every model call by running `llm`
  // (bin/shellm:1737-1745 call_llm; thinkers/responder/step:57-66 _reply_llm), so the wire request is whatever `llm`
  // builds: streaming, max_tokens, no `reasoning` field. LlmCliClient runs this port's `llm` (src/llmCli.ts)
  // in-process with the same argv. Provider/key selection is `llm`'s own (any `<PROVIDER>_API_KEY`, LLM_API_KEY +
  // LLM_API_URL/SHELLM_API_URL for openai-compatible), so the old "OPENROUTER_API_KEY or LLM_API_KEY" gate is
  // loosened to "some API key or endpoint is configured"; `llm` itself dies with its own message otherwise.
  const hasCredential = Object.keys(env).some((k) => (/_API_KEY$/.test(k) || k === "LLM_API_URL" || k === "SHELLM_API_URL") && env[k]);
  if (!hasCredential) throw new Error("steprun: no API key (OPENROUTER_API_KEY/LLM_API_KEY/…) or LLM_API_URL set");
  // bin/shellm:80,1365-1366: SHELLM_EFFORT (default "high"), SHELLM_MAX_TOKENS (default unset), and
  // bin/shellm:1740 SHELLM_STOP_AFTER_CODE_BLOCK (default 1) become llm's `--effort`, `-t`, `--stop-after-code-block`.
  // LLM_RETRIES / LLM_RETRY_BACKOFF / LLM_MAX_TIME need no translation: `llm` reads them from this env itself.
  const maxTokensRaw = env["SHELLM_MAX_TOKENS"];
  const maxTokens = maxTokensRaw && /^[0-9]+$/.test(maxTokensRaw) ? Number(maxTokensRaw) : undefined;
  return new LlmCliClient({
    // The responder's calls are plain `llm -m M -M … -s …` (no --thinking/--effort); the monolith's are shellm's.
    mode: thinkerName === "responder" ? "plain" : "shellm",
    env,
    model: env["SHELLM_MODEL"] ?? "deepseek/deepseek-v4-flash-0731",
    effort: env["SHELLM_EFFORT"] || "high",
    ...(maxTokens !== undefined && thinkerName !== "responder" ? { maxTokens } : {}),
    stopAfterCodeBlock: (env["SHELLM_STOP_AFTER_CODE_BLOCK"] || "1") === "1",
  });
}

export interface TriggerStepIn {
  type: string;
  source?: string;
  step_id?: string;
  from?: string;
  to?: string;
  content?: string;
  [k: string]: unknown;
}

function readStdinJson(): TriggerStepIn {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  if (!raw.trim()) return { type: "" };
  return JSON.parse(raw) as TriggerStepIn;
}

/** Run one wake for `thinkerName` against the CURRENT process env (already
 *  resolveIdentityEnv'd by the caller — the daemon spawns steps with that
 *  env, and the CLI entrypoint below calls resolveIdentityEnv itself). */
export async function runStep(thinkerName: string, trigger: TriggerStepIn, env: Record<string, string>): Promise<number> {
  const identityDir = env["IDENTITY_DIR"];
  const trajDir = env["TRAJ_DIR"];
  const trajId = env["TRAJ_ID"];
  if (!identityDir || !trajDir || !trajId) {
    process.stderr.write("thinker: error: IDENTITY_DIR/TRAJ_DIR/TRAJ_ID not set. Run: identity shell <name>\n");
    return 1;
  }

  if (thinkerName === "retrieval") {
    const io = {
      readMemoryFiles,
      appendStep: (record: Record<string, unknown>, opts: { runStepId: string }) => {
        const trajFile = resolveTrajFile(trajDir, trajId) ?? path.join(trajDir, trajId);
        const traj = openTrajectory(trajDir, trajId);
        void trajFile;
        return traj.append(record, opts);
      },
      stderr: (s: string) => process.stderr.write(s),
    };
    runRetrievalStep(trigger, env, io);
    return 0;
  }

  // PORT-NOTE (bin/shellm:80): SHELLM_EFFORT flows into IdentityConfig.effort,
  // which monolith.ts already records on the shellm-run header (defaulting to
  // "high" when unset/empty, matching bin/shellm:80's `${SHELLM_EFFORT:-high}`).
  const identity = buildIdentityConfig({ env, ...(env["SHELLM_EFFORT"] ? { effort: env["SHELLM_EFFORT"] } : {}) });
  const traj = openTrajectory(trajDir, trajId); // PLAIN FileTrajectory — never ObservableTrajectory
  const { sandbox, env: envSpec, cleanup } = selectSandbox({
    identityName: identity.name,
    identityDir,
    workdir: identity.workdir,
    binDir: identity.binDir,
    portHome: env["HEADLONG_TS_HOME"] ?? identity.binDir.replace(/\/bin$/, ""),
    env,
    ...(identity.skillVarMounts ? { varMounts: identity.skillVarMounts } : {}),
  });
  identity.env = envSpec;
  // bug #70 (bin/shellm:2659-2662,2679-2680,2712 `_shellm_container_api_url`):
  // rewrite the Docker-bound copy of the exec env's endpoint aliases so
  // in-container tools (llm, mem search, ...) reach a loopback-bound model
  // server via host.docker.internal instead of this host's own loopback.
  // buildLlmClient below still reads the original URL from `env` — only the
  // copy crossing into Docker changes.
  applyDockerApiUrlRewrite(identity.execEnv, envSpec.type);
  // bin/thinkers:387-389 + bin/shellm:1629: a local wake inherits what the dispatcher exports (IDENTITY_DIR, ...).
  applyLocalInheritedEnv(identity.execEnv, env, envSpec.type);
  const llm = buildLlmClient(env, thinkerName);

  try {
    if (thinkerName === "monolith") {
      // PORT-NOTE (bin/shellm:55-80): every daemon-driven wake used to run
      // with runShellm's compiled-in DEFAULT_CONSTANTS only, ignoring
      // SHELLM_MAX_ITERATIONS / SHELLM_MAX_CONSECUTIVE_FAILURES /
      // SHELLM_MAX_REPEAT_FAILURES / SHELLM_TRUNCATE / SHELLM_INACTIVITY_MAX
      // in the daemon's environment. constantsFromEnv (src/shellm.ts) is the
      // pure parse of those knobs; wiring it here is what makes e.g.
      // SHELLM_MAX_ITERATIONS=4 actually bound the loop.
      await runMonolithWake({
        trajectory: traj,
        identity,
        llm,
        sandbox,
        trigger: {
          triggerType: String(trigger.type ?? ""),
          ...(trigger.source !== undefined ? { triggerSource: String(trigger.source) } : {}),
          ...(trigger.step_id !== undefined ? { triggerStepId: String(trigger.step_id) } : {}),
        },
        constants: constantsFromEnv(env),
        // 2e39a3f MONOLITH_REQUEST_MODEL: the request tier answers on another model.
        llmForModel: (m) => buildLlmClient({ ...env, SHELLM_MODEL: m }, thinkerName),
      });
      return 0;
    }
    if (thinkerName === "responder") {
      // identity-env.ts:87 GUARANTEES MEM_DIR is always set (to the
      // identity's memories dir) on any env resolveIdentityEnv produced;
      // the `|| path.join(identityDir, "memories")` fallback only covers a
      // caller that hands runStep a hand-built env skipping that function
      // (e.g. a test), matching upstream's own `${MEM_DIR:-/tmp}` default in
      // spirit — except the port's default is the identity's own memories
      // dir, since that's what MEM_DIR always resolves to in production, not
      // a shared "/tmp" any identity would collide on.
      const memDir = identity.execEnv?.["MEM_DIR"] || path.join(identityDir, "memories");
      // PORT-NOTE (thinkers/responder/step REPLY_MODEL): the reply model is
      // MONOLITH_REPLY_MODEL, else THINK_MODEL, else the identity model
      // (SHELLM_MODEL). It is what the observation records AND what decides
      // RESPONDER_STRUCTURED=auto, so the call must really go to it.
      const replyModel = env["MONOLITH_REPLY_MODEL"] || env["THINK_MODEL"] || identity.model;
      const replyLlm = replyModel === identity.model ? llm : buildLlmClient({ ...env, SHELLM_MODEL: replyModel }, thinkerName);
      await runResponder({
        trajectory: traj,
        llm: replyLlm,
        identityName: identity.name,
        identityText: identity.identityText,
        skillsText: identity.skillsText,
        model: replyModel,
        memDir,
        env,
        ...(env["IDENTITY_DIR"] ? { identityDir: env["IDENTITY_DIR"] } : {}),
        logPrompt: env["RESPONDER_LOG_PROMPT"] === "1",
        personNotes: env["RESPONDER_PERSON_NOTES"] !== "0",
        personNotesSync: env["RESPONDER_PERSON_NOTES_SYNC"] === "1",
        trigger: {
          type: String(trigger.type ?? ""),
          ...(trigger.content !== undefined ? { content: String(trigger.content) } : {}),
          ...(trigger.step_id !== undefined ? { step_id: String(trigger.step_id) } : {}),
          ...(trigger.from !== undefined ? { from: String(trigger.from) } : {}),
          ...(trigger.to !== undefined ? { to: String(trigger.to) } : {}),
          ...(trigger.source !== undefined ? { source: String(trigger.source) } : {}),
          ...(trigger.ts !== undefined ? { ts: String(trigger.ts) } : {}),
        },
      });
      return 0;
    }
    process.stderr.write(`thinker-step: unknown thinker '${thinkerName}'\n`);
    return 1;
  } finally {
    cleanup();
  }
}

/** bin/thinker-step.mjs's whole body. */
export async function main(argv: string[]): Promise<number> {
  const thinkerName = argv[0];
  if (!thinkerName) {
    process.stderr.write("Usage: thinker-step.mjs <thinker-name>\n");
    return 1;
  }
  const identityDir = process.env["IDENTITY_DIR"];
  const env = identityDir ? resolveIdentityEnv(identityDir, { base: process.env }) : (process.env as Record<string, string>);
  const trigger = readStdinJson();
  return runStep(thinkerName, trigger, env);
}
