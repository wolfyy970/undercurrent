// scripts/live-proof.ts — live multi-wake proof against a REAL model
// (PLAN-daemon §8 "Live multi-wake proof"). Costs money (OPENROUTER_API_KEY,
// ~$0.05 on deepseek/deepseek-v4-flash-0731 at the time this was written).
// The director runs this with a key; it is NOT part of `pnpm test` and does
// NOT run in CI. `pnpm live-proof`.
//
// Deterministic parts of this same scenario (no network, no cost) live in
// test/live-loop.test.ts — that is the lane's real acceptance oracle. This
// script is the one thing that cannot be faked: it proves a real model,
// talking through the real daemon, actually keeps thinking between messages.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { thinkersStart, thinkersStop } from "../src/thinkersctl.ts";
import { pidAlive } from "../src/runstate.ts";
import { rootTrajFile } from "../src/trajCore.mjs";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin");
const MODEL = process.env["LIVE_PROOF_MODEL"] ?? "deepseek/deepseek-v4-flash-0731";

let hardFailures = 0;
function hardAssert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  [ok]   ${label}`);
  } else {
    console.log(`  [FAIL] ${label}`);
    hardFailures += 1;
  }
}
function softReport(cond: boolean, label: string): void {
  console.log(`  [${cond ? "ok" : "note"}] (soft) ${label}`);
}

async function poll<T>(fn: () => T | undefined, timeoutMs: number, stepMs = 500): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readSteps(trajFile: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(trajFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function main(): Promise<void> {
  if (!process.env["OPENROUTER_API_KEY"]) {
    console.error("live-proof: OPENROUTER_API_KEY is not set. This script makes real, billed model calls.");
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-live-proof-"));
  console.log(`serve-root: ${root}`);

  try {
    // ---- 1. identity new pax; thinkers start monolith responder ----------
    const result = identityNew({ identitiesRoot: root, name: "pax" });
    const idDir = result.identityDir;
    const runDir = path.join(idDir, "run");
    const trajFile = rootTrajFile(path.join(idDir, "trajectories"), result.rootTrajectoryId);

    const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
    env["MONOLITH_BACKOFF_HOLD"] = "1";
    env["SHELLM_MAX_ITERATIONS"] = "4";
    env["SHELLM_MODEL"] = MODEL;

    console.log("\n=== 1. start ===");
    const started = await thinkersStart(env, ["monolith", "responder"]);
    hardAssert(pidAlive(started.dispatcherPid), "dispatcher pid alive after start");
    hardAssert(fs.existsSync(path.join(runDir, "dispatcher.token")), "dispatcher.token present");
    const emptyAfterKick = await poll(() => (fs.readdirSync(path.join(runDir, "pending")).length === 0 ? true : undefined), 15_000);
    hardAssert(emptyAfterKick === true, "pending/ empty once the boot kick fires");

    // ---- 2. out-of-process chat send; reply + reactive wake --------------
    console.log("\n=== 2. chat send ===");
    const send = spawnSync(
      process.execPath,
      [path.join(BIN, "chat.mjs"), "send", "--from", "operator", "--to", "pax", "Please remember that my favourite colour is teal, then carry on with whatever you were doing."],
      { env, encoding: "utf8" }
    );
    hardAssert(send.status === 0, `chat send exits 0 (stderr: ${send.stderr?.trim()})`);

    const reply = await poll(() => {
      const msg = readSteps(trajFile).find((s) => s["type"] === "message" && s["from"] === "pax") as
        | { reply_to?: string }
        | undefined;
      return msg?.reply_to ? msg : undefined;
    }, 60_000);
    hardAssert(reply !== undefined, "a reply from pax with reply_to appears within 60s");

    const reactiveWake = await poll(() => {
      return readSteps(trajFile).find(
        (s) => s["type"] === "shellm-run" && s["wake"] === "reactive/observation:responder"
      );
    }, 60_000);
    hardAssert(reactiveWake !== undefined, "a shellm-run with wake=reactive/observation:responder follows");

    // PORT-BUG guard: a real exec-path breakage (e.g. the docker-host-HOME
    // bug, DockerSandbox.buildChildEnv overlaying req.env's HOME onto the
    // host `docker` process so every `docker exec` fails to reach the
    // daemon) still lets the model reply and still appends the reactive
    // wake above — it only breaks command execution. Require at least one
    // successful shell-output row so that class of breakage can never pass
    // live-proof again.
    const successfulExec = readSteps(trajFile).find(
      (s) => s["type"] === "shell-output" && s["exit"] === 0
    );
    hardAssert(successfulExec !== undefined, "at least one shell-output row with exit:0 (the exec path actually ran a command)");

    // ---- 3. >=3 further spontaneous/timer wakes, growing backoff ---------
    console.log("\n=== 3. spontaneous timer wakes ===");
    const wakeTable: { atMs: number; level: number }[] = [];
    const seenTimerWakes = new Set<string>();
    const deadline = Date.now() + 10 * 60_000;
    while (seenTimerWakes.size < 3 && Date.now() < deadline) {
      for (const s of readSteps(trajFile)) {
        if (s["wake"] === "spontaneous/timer") {
          const id = String(s["step_id"] ?? "");
          if (!seenTimerWakes.has(id)) {
            seenTimerWakes.add(id);
            let level = -1;
            try {
              level = (JSON.parse(fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8")) as { level: number }).level;
            } catch {
              /* not written yet */
            }
            wakeTable.push({ atMs: Date.now(), level });
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    hardAssert(seenTimerWakes.size >= 3, `>=3 spontaneous/timer wakes observed (got ${seenTimerWakes.size})`);

    console.log("  wake table:");
    for (let i = 0; i < wakeTable.length; i++) {
      const gap = i > 0 ? ((wakeTable[i]!.atMs - wakeTable[i - 1]!.atMs) / 1000).toFixed(1) : "-";
      console.log(`    #${i + 1}  level=${wakeTable[i]!.level}  gap=${gap}s`);
    }
    const levels = wakeTable.map((w) => w.level);
    const nonDecreasing = levels.every((l, i) => i === 0 || l >= levels[i - 1]!);
    const strictIncreases = levels.filter((l, i) => i > 0 && l > levels[i - 1]!).length;
    hardAssert(nonDecreasing, "backoff level is non-decreasing across observed timer wakes");
    hardAssert(strictIncreases >= 2, `>=2 strict backoff level increases (got ${strictIncreases})`);
    hardAssert(
      !readSteps(trajFile).some((s) => s["type"] === "monolith-wake"),
      "no monolith-wake step was ever appended to the trajectory (synthetic dispatch payload only)"
    );

    // ---- 4. persistence across stop/start ----------------------------------
    console.log("\n=== 4. stop / restart persistence ===");
    const persistedLevel = JSON.parse(fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8")) as { level: number };
    await thinkersStop(env, [], {});
    hardAssert(!fs.existsSync(path.join(runDir, "dispatcher.pid")), "dispatcher.pid gone after stop");
    hardAssert(!fs.existsSync(path.join(runDir, "monolith.wake_at")), "monolith.wake_at gone after stop");
    hardAssert(!fs.existsSync(path.join(runDir, "active_thinkers")), "active_thinkers gone after stop");
    hardAssert(!fs.existsSync(path.join(runDir, "last_signal")), "no last_signal (a clean, sanctioned stop)");

    const linesBeforeRestart = readSteps(trajFile).length;
    const restarted = await thinkersStart(env, ["monolith", "responder"]);
    hardAssert(pidAlive(restarted.dispatcherPid), "dispatcher pid alive after restart");
    await poll(() => (readSteps(trajFile).length > linesBeforeRestart ? true : undefined), 60_000);
    const resumedLevel = JSON.parse(fs.readFileSync(path.join(runDir, "monolith_backoff_state.json"), "utf8")) as { level: number };
    hardAssert(resumedLevel.level >= persistedLevel.level, `the next wake resumes from the persisted backoff level (${persistedLevel.level} -> ${resumedLevel.level}, not reset to 0)`);

    hardAssert(fs.existsSync(path.join(idDir, "memories")), "memories/ exists");
    hardAssert(readSteps(trajFile).length > linesBeforeRestart, "trajectory line count grew after the restart's boot kick");
    const memoryFiles = fs.readdirSync(path.join(idDir, "memories")).filter((f) => f.endsWith(".md"));
    softReport(memoryFiles.length > 0, `a memory *.md landed (${memoryFiles.length} file(s)) — model decision, not asserted`);

    await thinkersStop(env, [], { force: true });

    console.log("\n=== NOTE: browser beat ===");
    console.log("  create -> start -> chat -> watch a spontaneous wake in the timeline is a manual/Playwright");
    console.log("  step against the web UI, out of this script's scope (CLI + daemon only).");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${hardFailures === 0 ? "PASS" : `FAIL (${hardFailures} hard assertion(s) failed)`}`);
  process.exit(hardFailures === 0 ? 0 : 1);
}

await main();
