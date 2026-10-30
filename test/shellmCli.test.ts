// shellmCli.test.ts — stage 3b #1: the port ships `shellm` (upstream bin/shellm) so the mind can run it from its wake
// shell, as the system prompt tells it to. Differential against upstream's real bin/shellm for --help and
// --print-system-prompt (skipped without PARITY_UPSTREAM_ROOT); behavior tests for plain and nested runs. The runs'
// model is a recorded real DeepSeek answer (test/fixtures/recordings/shellmCli/), served on LLM_API_URL.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordedEndpoint, recordedText, type RecordedModel } from "./support/recordedModel.ts";
import { resolveTrajFile } from "../src/trajectory.ts";
import { claimFixedRoot } from "./support/fixedRoot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../bin/shellm");
const UP = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
const bashOk = spawnSync("bash", ["-c", "[[ ${BASH_VERSINFO[0]} -ge 4 ]] && command -v jq curl >/dev/null"]).status === 0;

const run = (cmd: string, args: string[], env: Record<string, string>, input = "") =>
  spawnSync(cmd, args, { env: { PATH: process.env["PATH"] ?? "", HOME: os.tmpdir(), ...env }, input, encoding: "utf8" });
/** Like `run`, but leaves this process's event loop free, so the local recording endpoint can answer. */
const runAsync = (cmd: string, args: string[], env: Record<string, string>, input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { PATH: process.env["PATH"] ?? "", HOME: os.tmpdir(), ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });

describe.skipIf(!UP || !bashOk)("shellm CLI vs upstream bin/shellm (differential)", () => {
  const up = (args: string[]) => run(path.join(UP, "bin/shellm"), args, { PATH: `${UP}/bin:${UP}/tools:${process.env["PATH"]}`, LC_ALL: "en_US.UTF-8" });
  const mine = (args: string[]) => run(BIN, args, { PATH: `${path.dirname(BIN)}:${process.env["PATH"]}`, LC_ALL: "en_US.UTF-8" });
  it("--help prints upstream's usage text byte for byte", () => {
    expect(mine(["--help"]).stdout).toBe(up(["--help"]).stdout);
  });
  it("--print-system-prompt matches upstream's, machine facts masked", () => {
    const norm = (s: string) =>
      s
        .replace(/(- Date: )\S+/, "$1<D>")
        .replace(/(- Shell: ).*/, "$1<B>")
        .replace(/(- Package managers: ).*/, "$1<P>")
        .replace(/(- Transient run directory: )\S+/, "$1<R>");
    const a = up(["--print-system-prompt"]).stdout,
      b = mine(["--print-system-prompt"]).stdout;
    expect(norm(b)).toBe(norm(a));
  });
  it("an unknown option fails like upstream (exit 1, `Unknown option`)", () => {
    const a = up(["--bogus"]), b = mine(["--bogus"]);
    expect(b.status).toBe(a.status);
    expect(b.stderr).toContain("Unknown option: --bogus (try shellm --help)");
  });
});

describe("shellm CLI: runs and nested runs", () => {
  // The task is in the prompt, so the real model's block does the work under test (stdin as $CONTEXT, -f as
  // $FILE_CONTEXT1, FINAL as the printed answer). Fixed root: the recorded block may name prompt-visible paths.
  const PROMPT = ["Write", "$CONTEXT-and-$FILE_CONTEXT1", "(both variables expanded) into out.txt, then set FINAL to", "nested answer: <contents of out.txt>"];
  const models: RecordedModel[] = [];
  afterEach(() => {
    while (models.length) models.pop()!.close();
  });
  async function world(name: string) {
    const root = `/tmp/uc-rec-shellmcli/${name}`;
    claimFixedRoot(root);
    const trajDir = path.join(root, "trajectories");
    fs.mkdirSync(trajDir, { recursive: true });
    const { model, env: llmEnv } = await recordedEndpoint("shellmCli", "write-context");
    models.push(model);
    fs.writeFileSync(path.join(root, "ctx.txt"), "from-file\n");
    const env = { SHELLM_TRAJ_DIR: trajDir, SHELLM_WORKDIRS_DIR: path.join(root, "wd"), SHELLM_SANDBOX: "local", ...llmEnv, PATH: `${path.dirname(BIN)}:${process.env["PATH"]}` };
    return { root, trajDir, env, model };
  }
  const steps = (trajDir: string, id: string) =>
    fs.readFileSync(resolveTrajFile(trajDir, id)!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  it("a plain run executes the model's block, passes stdin and -f context, prints the final answer, exits 0", async () => {
    const { root, trajDir, env, model } = await world("plain");
    try {
      const r = await runAsync(BIN, ["-f", path.join(root, "ctx.txt"), ...PROMPT], env, "from-stdin");
      // The recorded answers are bash blocks the engine ran (not text we wrote): the real model first inspected both
      // variables, then wrote them to out.txt and set FINAL.
      expect(model.recording.calls.some((c) => /```bash[\s\S]*out\.txt[\s\S]*FINAL=/.test(recordedText(c)))).toBe(true);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^nested answer: from-stdin\S*from-file\n$/);
      const dirs = fs.readdirSync(trajDir);
      expect(dirs).toHaveLength(1);
      const id = String(JSON.parse(fs.readFileSync(path.join(trajDir, dirs[0]!, "trajectory.jsonl"), "utf8").split("\n")[0]!).step_id);
      // The run-summary (bin/shellm:2366-2440) is written asynchronously, so its position varies; exactly one per new run.
      const all = steps(trajDir, id).map((s) => s["type"]);
      expect(all.filter((t) => t === "run-summary")).toHaveLength(1);
      // One reasoning + shell-output pair per recorded turn, then the final.
      expect(all.filter((t) => t !== "run-summary").join(" ")).toMatch(/^trajectory shellm-run prompt( reasoning shell-output)+ final$/);
      expect(dirs[0]).toMatch(/^[0-9a-f]{8}-write-context-and-file_context1/); // `traj new --slug "${prompt:0:200}"` (bin/shellm:2614)
      expect(steps(trajDir, id).find((s) => s["type"] === "prompt")!["content"]).toBe(PROMPT.join(" "));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a nested run (the parent's _SHELLM_PARENT_TRAJ_ID) writes its own trajectory and leaves fork + merge steps on the parent", async () => {
    const { root, trajDir, env } = await world("nested"); // the same task, so the same recorded answer
    try {
      const parentId = String(JSON.parse(run(process.execPath, ["-e", `const {createTrajectory}=await import(${JSON.stringify(path.resolve(HERE, "../src/trajectory.ts"))});console.log(JSON.stringify({id:createTrajectory(${JSON.stringify(trajDir)}).trajId}))`, "--input-type=module"], env).stdout.trim() || "{}").id);
      const r = await runAsync(BIN, ["-f", path.join(root, "ctx.txt"), ...PROMPT], { ...env, _SHELLM_PARENT_TRAJ_ID: parentId }, "from-stdin");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^nested answer: from-stdin\S*from-file\n$/);
      const parent = steps(trajDir, parentId);
      const fork = parent.find((s) => s["type"] === "fork");
      const merge = parent.find((s) => s["type"] === "merge");
      expect(fork, JSON.stringify(parent.map((s) => s["type"]))).toBeDefined();
      expect(merge).toBeDefined();
      expect(String(merge!["content"])).toContain("nested answer:");
      const childId = String(merge!["from_traj"]);
      const first = steps(trajDir, childId)[0]!;
      expect(first["parent_traj"]).toBe(parentId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
