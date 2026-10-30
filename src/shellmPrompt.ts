// shellmPrompt.ts — the shellm system prompt, assembled per run exactly as upstream's
// `build_system_prompt` (bin/shellm:2137-2359) does.
//
// BEHAVIORAL-PARITY ROUND (B4): the port used to send only the bundled head of the prompt (6,025 chars) where
// upstream sends the head + a scope-dependent "Output budget" line + the shellm CLI reference (`usage_text`) +
// the Guidelines + (Docker) "Execution environment" + "## Current run" + "## Machine environment" (~15.7k chars).
//
// The static text lives in src/assets/shellm-system-prompt.txt, generated from upstream's own
// `shellm --print-system-prompt` output at the 2e39a3f pin with exactly two placeholders:
//   {{OUTPUT_BUDGET}}      bin/shellm:2231-2246 (depends on the context scope, block limit, whole blocks, tail block)
//   {{CONTEXT_GUIDELINE}}  bin/shellm:2269-2271 (only when stdin / -f context was passed; the monolith passes none)
// Everything after the static text is dynamic and built here (bin/shellm:2274-2359).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SHELLM_SYSTEM_PROMPT_TEMPLATE } from "./prompts.ts";

export interface ShellmSystemPromptOptions {
  /** `--context-scope` (bin/shellm:2237 `$SHELLM_CONTEXT_SCOPE`). */
  contextScope: "traj" | "run";
  /** SHELLM_CONTEXT_BLOCK_LIMIT (default 8192). */
  contextBlockLimit: number;
  /** SHELLM_CONTEXT_WHOLE_BLOCKS (default 1). */
  contextWholeBlocks: number;
  /** SHELLM_CONTEXT_RUN_TAIL_BLOCK (default 50). */
  contextRunTailBlock: number;
  /** SHELLM_STDOUT_PROMPT_LIMIT (default 2048). */
  stdoutPromptLimit: number;
  /** The run's transient dir (`$rundir`, bin/shellm:2628); empty/undefined omits "## Current run". */
  rundir?: string;
  /** `context_info` lines for stdin/-f context (bin/shellm:2671-2699); the monolith has none. */
  contextInfo?: string;
  /** Docker-mode run: the "## Execution environment" section (bin/shellm:2303-2321). */
  docker?: { image: string };
  /** Env for the package-manager scan (PATH). Default process.env. */
  env?: Record<string, string | undefined>;
  /** Machine-facts probe — injectable for tests; default shells out like upstream's `$(uname -s)` etc. */
  machine?: MachineProbe;
}

export interface MachineProbe {
  uname(flag: "-s" | "-r" | "-m"): string;
  hostname(): string;
  whoami(): string;
  bashVersion(): string;
  now(): Date;
}

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  // `$(cmd)` strips trailing newlines only.
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

export const realMachineProbe: MachineProbe = {
  uname: (flag) => sh("uname", [flag]),
  hostname: () => sh("hostname", []),
  whoami: () => sh("whoami", []),
  // `$BASH_VERSION` of the shell running upstream's shellm. The port has no bash process of its own; the bash the
  // sandbox runs the model's code with (first on PATH) is its analogue.
  bashVersion: () => sh("bash", ["-c", 'printf %s "$BASH_VERSION"']),
  now: () => new Date(),
};

// bin/shellm:2279 (`for cmd in apt apt-get brew …`) — same list, same order.
const PKG_MANAGERS = [
  "apt", "apt-get", "brew", "dnf", "yum", "pacman", "apk", "zypper", "nix-env", "pkg", "port", "emerge", "snap",
  "flatpak", "pip", "pip3", "npm", "yarn", "conda", "cargo", "gem", "go",
];

function onPath(cmd: string, pathVar: string): boolean {
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === "") continue;
    const p = path.join(dir, cmd);
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      }
    } catch {
      /* not here */
    }
  }
  return false;
}

/** bin/shellm:2231-2246 — the "Output budget" paragraph (integer shell arithmetic). */
export function outputBudgetLine(o: ShellmSystemPromptOptions): string {
  const bl = o.contextBlockLimit;
  const pl = o.stdoutPromptLimit;
  let band: string;
  if (o.contextScope === "run") {
    band = `the outputs of your newest ${Math.trunc((o.contextWholeBlocks * o.contextRunTailBlock) / 2)} or so steps show`;
  } else if (o.contextWholeBlocks <= 1) {
    band = "the output of your newest step shows";
  } else {
    band = `the outputs of your newest ${Math.trunc((o.contextWholeBlocks + 1) / 2)} steps show`;
  }
  const lines = Math.trunc((Math.trunc(bl / 55) + 5) / 10) * 10;
  return (
    `Output budget: ${band} whole up to ${bl} bytes (about ${lines} lines). Size a read to fit that, and prefer one read ` +
    `that fits over several that do not. Older outputs keep only their first and last ${Math.trunc(pl / 2)} bytes: the ` +
    `middle is what is cut, both ends are exact, and a stub sits where the hole is, naming the byte count and the ` +
    `command that prints the whole output. Fetch it; do not re-read the file to find what you lost.`
  );
}

const CONTEXT_GUIDELINE =
  "- Always start by inspecting `$CONTEXT` and `$FILE_CONTEXT1`, `$FILE_CONTEXT2`, if they were provided. These variables " +
  "contain the context text itself, not file paths; use `printf '%s\\n' \"$FILE_CONTEXT1\"` instead of " +
  "`cat \"$FILE_CONTEXT1\"`.\n";

/**
 * The default system prompt text as the model receives it. Like upstream's `system_prompt=$(build_system_prompt …)`
 * (bin/shellm:2772), trailing newlines are stripped.
 */
export function buildShellmSystemPrompt(o: ShellmSystemPromptOptions): string {
  const contextInfo = o.contextInfo ?? "";
  let out = SHELLM_SYSTEM_PROMPT_TEMPLATE.replace("{{OUTPUT_BUDGET}}", () => outputBudgetLine(o)).replace(
    "{{CONTEXT_GUIDELINE}}",
    () => (contextInfo !== "" ? CONTEXT_GUIDELINE : "")
  );

  if (o.docker) {
    // bin/shellm:2303-2308. The access-mode sub-sections (broker/socket/dind, :2309-2321) are not emitted: this
    // port's Docker sandbox has no docker-access modes (PARITY.md "Behavioral parity round").
    out +=
      "\n## Execution environment\n" +
      `Your code runs inside a Docker container (${o.docker.image}) with bash, python3, jq, and curl pre-installed. You have passwordless sudo — use 'sudo apt-get install -y <pkg>' to install additional packages.\n` +
      "Host paths (like $SHELLM_WORKDIR and run record directories) are bind-mounted at the same paths inside the container — they exist and are accessible.\n";
  }
  if (o.rundir) {
    out +=
      "\n## Current run\n" +
      `- Transient run directory: ${o.rundir} (for generated code output; available as $SHELLM_RUNDIR)\n` +
      "- Trajectory and sub-run monitoring use $TRAJ_DIR and $TRAJ_ID.\n";
  }
  if (contextInfo !== "") {
    out +=
      "\n## Context available as environment variables\n" +
      "The variables below contain text content. The source path is listed only for orientation and may not be mounted in this execution environment.\n" +
      `${contextInfo}\n`;
  }

  // bin/shellm:2345-2358
  const m = o.machine ?? realMachineProbe;
  const env = o.env ?? process.env;
  const pathVar = env["PATH"] ?? "";
  const pkgmgrs = PKG_MANAGERS.filter((c) => onPath(c, pathVar)).join(", ");
  out +=
    "\n## Machine environment\n" +
    `- OS: ${m.uname("-s")} ${m.uname("-r")}\n` +
    `- Arch: ${m.uname("-m")}\n` +
    `- Hostname: ${m.hostname()}\n` +
    `- User: ${m.whoami()}\n` +
    `- Shell: ${m.bashVersion()}\n` +
    `- Date: ${m.now().toISOString().replace(/\.\d{3}Z$/, "Z")}\n` +
    (pkgmgrs !== "" ? `- Package managers: ${pkgmgrs}\n` : "");
  return out.replace(/\n+$/, "");
}
