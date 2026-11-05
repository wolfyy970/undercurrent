// Real dispatcher + controllable steps; no model or Docker calls.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { appendStep, getIdentityActivity, resolveIdentityEnv, verifyExecutionRoot, type VerifiedExecutionRoot } from "../src/api.ts";
import { identityNew } from "../src/identity.ts";
import { feedersLive } from "./support/daemonReady.ts";
import { executionArchive } from "./support/executionArchive.ts";

const dispatcher = path.resolve(import.meta.dirname, "../bin/dispatcherd.mjs");
const rigs: { root: string; identityDir: string; child: ChildProcess }[] = [];
const archives: string[] = [];

async function poll(predicate: () => boolean): Promise<void> {
  await expect.poll(predicate, { timeout: 10000, interval: 25 }).toBe(true);
}

afterEach(async () => {
  for (const { root, identityDir, child } of rigs.splice(0)) {
    for (const name of ["monolith", "responder"]) {
      const marker = path.join(identityDir, `${name}.started`);
      if (!fs.existsSync(marker)) continue;
      try { process.kill(Number(fs.readFileSync(marker, "utf8")), "SIGKILL"); } catch { /* exited */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const dir of archives.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function rig(execution?: { root: string; certificate: VerifiedExecutionRoot }) {
  // Spaces also verify process-command matching does not tokenize identity paths.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hl activity "));
  const identity = identityNew({ identitiesRoot: root, name: "pax" });
  const identityDir = identity.identityDir;
  for (const name of ["monolith", "responder"]) {
    const dir = path.join(identityDir, "thinkers", name);
    fs.writeFileSync(path.join(dir, "subscriptions.jsonl"), JSON.stringify({ types: ["message"], traj_id: identity.rootTrajectoryId, trigger_self: false, watchdog_secs: 0 }) + "\n");
    fs.writeFileSync(path.join(dir, "step"), [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.readFileSync(0, 'utf8');",
      `fs.writeFileSync(${JSON.stringify(path.join(identityDir, `${name}.started`))}, String(process.pid));`,
      `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(identityDir, `${name}.release`))})) clearInterval(timer); }, 10);`,
      "",
    ].join("\n"), { mode: 0o755 });
  }
  const runDir = path.join(identityDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "active_thinkers"), "monolith\nresponder\n");
  const command = execution ? path.join(execution.root, "bin/dispatcherd.mjs") : dispatcher;
  const child = spawn(process.execPath, [command], { env: resolveIdentityEnv(identityDir, execution ? { executionRoot: execution.certificate } : {}), stdio: "ignore" });
  rigs.push({ root, identityDir, child });
  await feedersLive(runDir, child);
  const trajFile = path.join(identityDir, "trajectories", `${identity.rootTrajectoryId.slice(0, 8)}-root`, "trajectory.jsonl");
  return { identityDir, runDir, child, trajFile };
}

describe("public identity activity", () => {
  it("observes a certified retained dispatcher using the current API, and fails closed after archive tampering", async () => {
    const retained = executionArchive(path.resolve(import.meta.dirname, ".."));
    archives.push(retained);
    fs.rmSync(path.join(retained, "src/activity.ts"));
    fs.writeFileSync(path.join(retained, "src/api.ts"), "// retained embedding API is never imported\n");
    const certificate = verifyExecutionRoot(retained);
    expect(certificate).not.toBeNull();
    const r = await rig({ root: retained, certificate: certificate! });
    appendStep(r.trajFile, { type: "message", from: "operator", to: "pax", source: "chat", content: "wake both" });
    await poll(() => ["monolith", "responder"].every((name) => fs.existsSync(path.join(r.identityDir, `${name}.started`))));
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
    expect(getIdentityActivity(r.identityDir, { executionRoot: certificate! })).toEqual({ active: true, thinkers: ["monolith", "responder"] });
    fs.appendFileSync(path.join(retained, "src/daemon.ts"), "\n");
    expect(getIdentityActivity(r.identityDir, { executionRoot: certificate! })).toEqual({ active: false, thinkers: [] });
  }, 20000);

  it("tracks executing monolith and responder steps, then clears immediately when they finish", async () => {
    const r = await rig();
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
    appendStep(r.trajFile, { type: "message", from: "operator", to: "pax", source: "chat", content: "wake both" });
    await poll(() => ["monolith", "responder"].every((name) => fs.existsSync(path.join(r.identityDir, `${name}.started`))));
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: true, thinkers: ["monolith", "responder"] });
    fs.writeFileSync(path.join(r.identityDir, "monolith.release"), "");
    await poll(() => getIdentityActivity(r.identityDir).thinkers.join() === "responder");
    fs.writeFileSync(path.join(r.identityDir, "responder.release"), "");
    await poll(() => !getIdentityActivity(r.identityDir).active);
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
  }, 20000);

  it("rejects stale PIDs for unrelated live processes and malformed ledger entries", async () => {
    const r = await rig();
    fs.writeFileSync(path.join(r.runDir, "step_pids"), `${process.pid} monolith\n${r.child.pid} responder\n${process.pid}junk monolith\n0 responder\n-1 monolith\n`);
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
    fs.writeFileSync(path.join(r.runDir, "dispatcher.pid"), `${process.pid}junk`);
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
  }, 15000);

  it("reports idle after its dispatcher dies even while an orphaned step remains alive", async () => {
    const r = await rig();
    appendStep(r.trajFile, { type: "message", from: "operator", to: "pax", source: "chat", content: "wake both" });
    await poll(() => ["monolith", "responder"].every((name) => fs.existsSync(path.join(r.identityDir, `${name}.started`))));
    expect(getIdentityActivity(r.identityDir).active).toBe(true);
    r.child.kill("SIGKILL");
    await new Promise<void>((resolve) => r.child.once("exit", () => resolve()));
    const stepPid = Number(fs.readFileSync(path.join(r.identityDir, "monolith.started"), "utf8"));
    expect(() => process.kill(stepPid, 0)).not.toThrow();
    expect(getIdentityActivity(r.identityDir)).toEqual({ active: false, thinkers: [] });
  }, 20000);
});
