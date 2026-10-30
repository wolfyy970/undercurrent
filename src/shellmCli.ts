// src/shellmCli.ts — the `shellm` command the model's bash can run (stage 3b #1). Upstream's `bin/shellm` is both the
// engine and this CLI; the port's engine is the in-process `runShellm`, so this is the CLI half: argument parsing
// (bin/shellm:3515-3660), usage text (:276-355, :385-390), `--print-system-prompt`, the trajectory setup of a new,
// resumed (`--traj`/`--resume`) or NESTED run (:2540-2650), stdin/-f context (:2672-2700), then `runShellm`, the final
// answer on stdout, and the merge step on the parent trajectory (:3395-3480).
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SHELLM_SYSTEM_PROMPT_TEMPLATE } from "./prompts.ts";
import { buildShellmSystemPrompt } from "./shellmPrompt.ts";
import { constantsFromEnv, runShellm, type ShellmConstants } from "./shellm.ts";
import { openTrajectory, openTrajectoryAt, resolveTrajFile, type Trajectory } from "./trajectory.ts";
import { runTraj } from "./trajCli.ts";
import { selectSandbox, forwardedEnv } from "./sandbox-runtime.ts";
import { buildLlmClient } from "./steprun.ts";
import { generateRunSummary, summaryModelFor } from "./runSummary.ts";

export interface ShellmCliIO {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout(s: string): void;
  stderr(s: string): void;
  /** Piped stdin contents, or undefined on a tty (`[[ ! -t 0 ]]`). */
  readStdin(): string | undefined;
  binDir: string;
}

/** `usage_text` (bin/shellm:276-355): the "Usage:" … "FINAL_FILE=path" block the system prompt embeds verbatim. */
export function usageText(): string {
  const t = SHELLM_SYSTEM_PROMPT_TEMPLATE;
  const a = t.indexOf("Usage:\n  shellm [options]");
  const endMark = "  FINAL_FILE=path   Set final answer from a file\n";
  const b = t.indexOf(endMark, a);
  return t.slice(a, b + endMark.length);
}

class CliDie extends Error {}
const die = (m: string): never => {
  throw new CliDie(m);
};

export async function runShellmCli(argv: string[], io: ShellmCliIO): Promise<number> {
  const env: Record<string, string | undefined> = { ...io.env };
  const files: string[] = [];
  const extraVars: string[] = [];
  let printPrompt = false;
  let promptFile = "";
  let useTraj = "";
  let workdirUser = "";
  let quiet = false;
  const need = (i: number, flag: string, what = "a value"): string => {
    const v = argv[i + 1];
    return v === undefined || v === "" ? die(`${flag} requires ${what}`) : v;
  };
  let i = 0;
  try {
    for (; i < argv.length; ) {
      const a = argv[i]!;
      if (a === "-h" || a === "--help") {
        io.stdout(usageText());
        return 0;
      } else if (a === "-v" || a === "--verbose") i += 1;
      else if (a === "-q" || a === "--quiet") (quiet = true), (i += 1);
      else if (a === "-f" || a === "--file") {
        const f = need(i, "-f", 'FILE "prompt"');
        if (!fs.existsSync(path.resolve(io.cwd, f)) || !fs.statSync(path.resolve(io.cwd, f)).isFile()) die(`Context file not found: ${f}`);
        files.push(f);
        i += 2;
      } else if (a === "--prompt-file") {
        promptFile = need(i, a);
        if (!fs.existsSync(path.resolve(io.cwd, promptFile))) die(`Prompt file not found: ${promptFile}`);
        i += 2;
      } else if (a === "-m" || a === "--model") (env["SHELLM_MODEL"] = need(i, a)), (i += 2);
      else if (a === "--max-iterations") (env["SHELLM_MAX_ITERATIONS"] = need(i, a)), (i += 2);
      else if (a === "--max-tokens") (env["SHELLM_MAX_TOKENS"] = need(i, a)), (i += 2);
      else if (a === "--context-scope") (env["SHELLM_CONTEXT_SCOPE"] = need(i, a)), (i += 2);
      else if (a === "--effort") (env["SHELLM_EFFORT"] = need(i, a)), (i += 2);
      else if (a === "--workdir") (workdirUser = need(i, a)), (i += 2);
      else if (a === "--here") (workdirUser = io.cwd), (i += 1);
      else if (a === "--env") (env["SHELLM_ENV"] = need(i, a)), (i += 2);
      else if (a === "--new-env" || a === "--temp-docker") (i += 1);
      else if (a === "-s" || a === "--system-prompt") (env["SHELLM_SYSTEM_PROMPT"] = need(i, a)), (i += 2);
      else if (a === "--system-prompt-file") {
        const f = need(i, a, "a file path");
        if (!fs.existsSync(path.resolve(io.cwd, f))) die(`System prompt file not found: ${f}`);
        env["SHELLM_SYSTEM_PROMPT"] = fs.readFileSync(path.resolve(io.cwd, f), "utf8").replace(/\n+$/, "");
        i += 2;
      } else if (a === "--print-system-prompt") (printPrompt = true), (i += 1);
      else if (a === "--docker-image") (env["SHELLM_DOCKER_IMAGE"] = need(i, a)), (i += 2);
      else if (a === "--docker-access") (env["SHELLM_DOCKER_ACCESS"] = need(i, a)), (i += 2);
      else if (a === "--traj") (useTraj = need(i, a, "TRAJ_ID")), (i += 2);
      else if (a === "--traj-dir") (env["SHELLM_TRAJ_DIR"] = need(i, a, "DIR")), (i += 2);
      else if (a === "--resume") (useTraj = "__latest__"), (i += 1);
      else if (a === "--var") {
        const arg = need(i, a, "NAME=VALUE or NAME");
        const name = arg.split("=")[0]!;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) die(`--var: invalid variable name: ${name}`);
        if (arg.includes("=")) extraVars.push(arg);
        else {
          if (env[name] === undefined) die(`--var ${name}: not set in the environment (export it, or pass --var ${name}=VALUE)`);
          extraVars.push(`${name}=${env[name]}`);
        }
        i += 2;
      } else if (a === "--bin") {
        const b = need(i, a, "a file path");
        if (!fs.existsSync(path.resolve(io.cwd, b))) die(`--bin file not found or not executable: ${b}`);
        i += 2;
      } else if (a.startsWith("-")) die(`Unknown option: ${a} (try shellm --help)`);
      else break;
    }
    let prompt = argv.slice(i).join(" ");
    if (promptFile) {
      if (prompt) die("--prompt-file and an inline prompt cannot be used together");
      prompt = fs.readFileSync(path.resolve(io.cwd, promptFile), "utf8").replace(/\n+$/, "");
    }
    const scope = env["SHELLM_CONTEXT_SCOPE"] || "traj";
    if (scope !== "traj" && scope !== "run") die(`--context-scope must be traj or run (got '${scope}')`);
    const constants: ShellmConstants = constantsFromEnv(env);
    const promptOpts = (rundir: string | undefined, docker?: { image: string }) => ({
      contextScope: constants.contextScope,
      contextBlockLimit: constants.contextBlockLimit,
      contextWholeBlocks: constants.contextWholeBlocks,
      contextRunTailBlock: constants.contextRunTailBlock,
      stdoutPromptLimit: 2048,
      ...(rundir ? { rundir } : {}),
      ...(docker ? { docker } : {}),
      env,
    });
    if (printPrompt) {
      io.stdout(buildShellmSystemPrompt(promptOpts(undefined)) + "\n"); // upstream `echo`s it
      return 0;
    }
    if (!prompt && !useTraj) {
      io.stdout(usageText());
      return 0;
    }

    // --- trajectory (bin/shellm:2540-2650) ---
    const home = env["HEADLONG_HOME"] || env["SHELLM_HOME"] || path.join(env["HOME"] ?? "", ".headlong");
    // K2 (fixed 2026-10-29): bin/shellm:47 `${SHELLM_TRAJ_DIR:-${TRAJ_DIR:-$_shellm_home/trajectories}}` — a run started
    // from a wake shell (TRAJ_DIR exported) writes into the identity's trajectories, not ~/.headlong.
    const trajDir = env["SHELLM_TRAJ_DIR"] || env["TRAJ_DIR"] || path.join(home, "trajectories");
    fs.mkdirSync(trajDir, { recursive: true });
    const parentId = env["_SHELLM_PARENT_TRAJ_ID"] || "";
    let traj: Trajectory;
    let forkStepId = "";
    let runName = "";
    const trajIo = (out: (s: string) => void) => ({
      env, stdout: out, stderr: () => {}, readStdin: () => "", isTTY: false, sleepMs: () => {}, shouldStop: () => false,
    });
    if (useTraj) {
      if (useTraj === "__latest__") {
        const dirs = fs.readdirSync(trajDir).filter((d) => fs.existsSync(path.join(trajDir, d, "trajectory.jsonl")));
        dirs.sort((x, y) => fs.statSync(path.join(trajDir, y, "trajectory.jsonl")).mtimeMs - fs.statSync(path.join(trajDir, x, "trajectory.jsonl")).mtimeMs);
        if (!dirs[0]) die(`No trajectories found in ${trajDir}`);
        const first = fs.readFileSync(path.join(trajDir, dirs[0]!, "trajectory.jsonl"), "utf8").split("\n")[0]!;
        useTraj = String((JSON.parse(first) as { step_id?: string }).step_id ?? "");
      }
      const file = resolveTrajFile(trajDir, useTraj);
      if (!file || !fs.existsSync(file)) return die(`Cannot find trajectory: ${useTraj}`);
      traj = openTrajectoryAt(trajDir, useTraj, file);
      runName = path.basename(path.dirname(file)); // bin/shellm:2586-2590
    } else {
      // K2 (fixed 2026-10-29): bin/shellm:2595-2620 creates the run's trajectory with `traj new --slug "${prompt:0:200}"`
      // (+ `--field parent_traj=… --field parent_step=…` for a nested run), so its directory is `<hex8>-<slug>`, NESTED
      // under the parent's directory with parent_traj_ref, and run_name is the path `traj new` prints on line 2.
      const fields = parentId ? ((forkStepId = randomUUID()), ["--field", `parent_traj=${parentId}`, "--field", `parent_step=${forkStepId}`]) : [];
      let out = "";
      const rc = runTraj(["new", "--traj_dir", trajDir, "--slug", prompt.slice(0, 200), ...fields], trajIo((x) => (out += x)));
      const [newId = "", rel = ""] = out.split("\n");
      const file = rc === 0 ? resolveTrajFile(trajDir, newId) : undefined;
      if (!file) return die(`traj new failed in ${trajDir}`);
      traj = openTrajectoryAt(trajDir, newId, file);
      runName = rel;
      if (parentId) runTraj(["fork", parentId, "--traj_dir", trajDir, "--child", traj.trajId, "--step-id", forkStepId], trajIo(() => {}));
    }
    const workdir = path.resolve(io.cwd, workdirUser || path.join(env["SHELLM_WORKDIRS_DIR"] || path.join(home, "workdirs"), runName));
    fs.mkdirSync(workdir, { recursive: true });
    const log = (m: string) => {
      if (!quiet) io.stderr(m);
    };
    log(`Trajectory: ${traj.trajId} (dir: ${trajDir})\nWorkdir: ${workdir}\n`);

    // --- context (bin/shellm:2672-2700): stdin -> $CONTEXT, each -f -> $FILE_CONTEXTn ---
    const execEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "PATH") execEnv[k] = v;
    Object.assign(execEnv, forwardedEnv(env as NodeJS.ProcessEnv));
    let contextInfo = "";
    const stdin = io.readStdin();
    if (stdin) {
      execEnv["CONTEXT"] = stdin;
      log(`Stdin context loaded: ${stdin.length} chars\n`);
      contextInfo = `- $CONTEXT: stdin data (${stdin.length} chars)`;
    }
    files.forEach((f, k) => {
      const abs = fs.realpathSync(path.resolve(io.cwd, f));
      const content = fs.readFileSync(abs, "utf8").replace(/\n+$/, "");
      execEnv[`FILE_CONTEXT${k + 1}`] = content;
      log(`File context ${k + 1} loaded: ${abs} (${content.length} chars)\n`);
      contextInfo += `${contextInfo ? "\n" : ""}- $FILE_CONTEXT${k + 1}: ${abs} (${content.length} chars)`;
    });
    for (const v of extraVars) execEnv[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
    execEnv["TRAJ_DIR"] = trajDir;
    execEnv["TRAJ_ID"] = traj.trajId;
    execEnv["ROOT_TRAJ_ID"] = env["ROOT_TRAJ_ID"] || traj.trajId;

    const model = env["SHELLM_MODEL"] || "claude-opus-4-7";
    execEnv["SHELLM_MODEL"] = model;
    const identityDir = env["IDENTITY_DIR"] || path.dirname(trajDir);
    const { sandbox, env: envSpec, cleanup } = selectSandbox({
      identityName: env["IDENTITY_NAME"] || "shellm",
      identityDir,
      workdir,
      binDir: io.binDir,
      portHome: path.resolve(io.binDir, ".."),
      env: env as NodeJS.ProcessEnv,
    });
    let summary: Promise<void> | undefined;
    try {
      const llm = buildLlmClient({ ...execEnv });
      const sysOverride = env["SHELLM_SYSTEM_PROMPT"];
      const result = await runShellm({
        trajectory: traj,
        llm,
        sandbox,
        systemPrompt: sysOverride
          ? sysOverride + "\n"
          : (ctx) =>
              buildShellmSystemPrompt({
                ...promptOpts(ctx.rundir, ctx.docker ? { image: ctx.dockerImage } : undefined),
                ...(contextInfo ? { contextInfo } : {}),
              }),
        prompt,
        workdir,
        binDir: io.binDir,
        execEnv,
        header: {
          command: ["shellm", ...argv].join(" "),
          model,
          effort: env["SHELLM_EFFORT"] || "high",
          maxTokens: env["SHELLM_MAX_TOKENS"] ?? "",
          env: envSpec,
          resumed: Boolean(useTraj),
        },
        constants,
        io: { stdout: io.stdout, stderr: quiet ? () => {} : io.stderr },
        // K3 (fixed 2026-10-29): bin/shellm:2826-2840 starts generate_run_summary for every run on a NEW trajectory.
        ...(useTraj
          ? {}
          : {
              onHeader: (runStepId: string) => {
                summary = generateRunSummary({
                  trajectory: traj,
                  runStepId,
                  prompt,
                  stdin,
                  files: files.map((f) => fs.realpathSync(path.resolve(io.cwd, f))),
                  model: summaryModelFor(env, model),
                  env: { ...execEnv },
                });
              },
            }),
      });
      // bin/shellm:3395-3480: a nested run (not --traj) leaves a `merge` step on its parent.
      if (parentId && !useTraj) {
        const last = traj.read().at(-1);
        const childRef = path.basename(runName); // bin/shellm:3404,3471 `_child_dir_name=$(basename "$run_name")`
        const merge: Record<string, unknown> =
          result.stopReason === "final" || result.stopReason === "no-block"
            ? { type: "merge", content: result.response, from_traj: traj.trajId, from_step: last?.["step_id"] ?? "", from_traj_ref: childRef }
            : result.stopReason === "stall"
              ? { type: "merge", content: `(stalled: ${result.stallReason ?? ""})`, from_traj: traj.trajId }
              : { type: "merge", content: "(max iterations reached)", from_traj: traj.trajId, from_step: last?.["step_id"] ?? "", from_traj_ref: childRef };
        try {
          // `traj append … "$_SHELLM_PARENT_TRAJ_ID"` resolves the parent wherever it lives (not only `<hex8>-root`).
          const parentFile = resolveTrajFile(trajDir, parentId);
          (parentFile ? openTrajectoryAt(trajDir, parentId, parentFile) : openTrajectory(trajDir, parentId)).append(merge);
        } catch {
          /* `|| true`, as upstream */
        }
      }
      if (result.stopReason === "final" || result.stopReason === "no-block") {
        io.stdout(result.response.endsWith("\n") ? result.response : result.response + "\n");
        return 0;
      }
      return 1;
    } finally {
      // bin/shellm:2859-2870: wait up to 30 s for the summary, then give up on it.
      if (summary) await Promise.race([summary, new Promise((res) => setTimeout(res, 30_000).unref())]);
      cleanup();
    }
  } catch (e) {
    if (e instanceof CliDie) {
      io.stderr(`shellm: error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
