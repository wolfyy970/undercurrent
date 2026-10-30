// sandbox-watchdog.test.ts — bug #33: the inactivity watchdog itself.
//
// bin/shellm:2618-2690 never kills a command that is still producing output;
// it kills on genuine SILENCE — stale_seconds (idle, SHELLM_INACTIVITY_TIMEOUT)
// resets on any new output byte OR an activity-beacon touch; quiet_seconds
// (the hard ceiling, SHELLM_INACTIVITY_MAX) resets ONLY on real output. These
// three scenarios (per sandbox) prove that shape end to end, with real
// subprocesses and real wall-clock timing — not mocked timers, since the
// whole point is to prove the watchdog's poll-and-compare loop against an
// actually-running child. Timeouts are scaled down from upstream's real
// defaults (30s/900s) to keep the suite fast; the algorithm is identical at
// any scale (execWithInactivityWatchdog's poll cadence scales with the
// ceilings it's given — see src/sandbox.ts).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalSandbox } from "../src/sandbox.ts";
import { DockerSandbox } from "../src/sandbox-docker.ts";

const IDLE_MS = 2000;
const MAX_MS = 5000;
const BIG_MAX_MS = 60_000; // effectively "never" for the survive/idle-only scenarios

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
}

function tmpActivityFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-beacon-"));
  return path.join(dir, ".activity");
}

// ---------------------------------------------------------------------------
describe("LocalSandbox — inactivity watchdog (real subprocess, real timing)", () => {
  it(
    "a command that prints every 400ms for 8s survives a 2s idle timeout",
    async () => {
      const sb = new LocalSandbox();
      const t0 = Date.now();
      const r = await sb.exec({
        workdir: tmpWorkdir(),
        // 20 * 400ms = 8s of real output, well past several 2s idle windows.
        wrappedCode: "for i in $(seq 1 20); do echo tick-$i; sleep 0.4; done\n",
        env: { PATH: process.env["PATH"] ?? "" },
        inactivityTimeoutMs: IDLE_MS,
        timeoutMs: BIG_MAX_MS,
      });
      const elapsedMs = Date.now() - t0;
      expect(r.timedOut).toBe(false);
      expect(r.exit).toBe(0);
      expect(r.killReason).toBeUndefined();
      expect(r.output.split("\n").filter((l) => l.startsWith("tick-")).length).toBe(20);
      // Ran to natural completion (~8s), not cut off at the 2s idle mark.
      expect(elapsedMs).toBeGreaterThan(7000);
    },
    20_000,
  );

  it(
    "a genuinely silent command is killed at ~2s (idle), not at natural completion",
    async () => {
      const sb = new LocalSandbox();
      const t0 = Date.now();
      const r = await sb.exec({
        workdir: tmpWorkdir(),
        wrappedCode: "sleep 8\necho SHOULD_NOT_APPEAR\n",
        env: { PATH: process.env["PATH"] ?? "" },
        inactivityTimeoutMs: IDLE_MS,
        timeoutMs: BIG_MAX_MS,
      });
      const elapsedMs = Date.now() - t0;
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("idle");
      expect(r.exit).toBe(124);
      expect(r.output).not.toContain("SHOULD_NOT_APPEAR");
      // Killed near the 2s idle mark, well short of the 8s sleep completing
      // or the 60s max ceiling — proves the SHORT timer fired, not the long one.
      expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
      expect(elapsedMs).toBeLessThan(5000);
    },
    12_000,
  );

  it(
    "a command silent on real output but touching the activity beacon survives idle, dies at the MAX ceiling",
    async () => {
      const sb = new LocalSandbox();
      const activityFile = tmpActivityFile();
      const t0 = Date.now();
      const r = await sb.exec({
        workdir: tmpWorkdir(),
        // No real stdout at all — only beacon touches, faster than the 2s
        // idle timeout, so `staleMs` never accumulates. `quietMs` (reset only
        // by real output, bin/shellm:2648-2651) climbs unopposed to MAX_MS.
        wrappedCode: `for i in $(seq 1 40); do date +%s%N > '${activityFile}'; sleep 0.4; done\n`,
        env: { PATH: process.env["PATH"] ?? "" },
        inactivityTimeoutMs: IDLE_MS,
        timeoutMs: MAX_MS,
        activityFile,
      });
      const elapsedMs = Date.now() - t0;
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("max");
      expect(r.exit).toBe(124);
      // Killed at the MAX ceiling (~5s), well past the 2s idle mark — proves
      // the beacon suppressed the idle kill and only the ceiling fired.
      expect(elapsedMs).toBeGreaterThanOrEqual(MAX_MS);
      expect(elapsedMs).toBeLessThan(MAX_MS + 3000);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Real-daemon: skips cleanly with a reason when Docker is absent.
const DAEMON = DockerSandbox.isDaemonAvailable();
describe.skipIf(!DAEMON)("DockerSandbox — inactivity watchdog (real daemon, real timing)", () => {
  const IMAGE = "ubuntu:latest";
  let container = "";

  function ensureImage(): boolean {
    if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) return true;
    return spawnSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: 300_000 }).status === 0;
  }

  function ensureContainer(): string | null {
    if (container) return container;
    if (!ensureImage()) return null;
    const run = spawnSync("docker", ["run", "-d", "--rm", IMAGE, "sleep", "infinity"], { encoding: "utf8" });
    if (run.status !== 0) return null;
    container = run.stdout.trim();
    return container;
  }

  it(
    "a command that prints every 400ms for 8s survives a 2s idle timeout",
    async () => {
      const c = ensureContainer();
      if (!c) return; // offline / unpullable — nothing to assert
      const sb = new DockerSandbox({ container: c });
      const t0 = Date.now();
      const r = await sb.exec({
        workdir: "/tmp",
        wrappedCode: "for i in $(seq 1 20); do echo tick-$i; sleep 0.4; done\n",
        env: { PATH: "/ignored" },
        inactivityTimeoutMs: IDLE_MS,
        timeoutMs: BIG_MAX_MS,
      });
      const elapsedMs = Date.now() - t0;
      expect(r.timedOut).toBe(false);
      expect(r.exit).toBe(0);
      expect(r.output.split("\n").filter((l) => l.startsWith("tick-")).length).toBe(20);
      expect(elapsedMs).toBeGreaterThan(7000);
    },
    30_000,
  );

  it(
    "a genuinely silent command is killed at ~2s (idle), not at natural completion",
    async () => {
      const c = ensureContainer();
      if (!c) return;
      const sb = new DockerSandbox({ container: c });
      const t0 = Date.now();
      const r = await sb.exec({
        workdir: "/tmp",
        wrappedCode: "sleep 8\necho SHOULD_NOT_APPEAR\n",
        env: { PATH: "/ignored" },
        inactivityTimeoutMs: IDLE_MS,
        timeoutMs: BIG_MAX_MS,
      });
      const elapsedMs = Date.now() - t0;
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("idle");
      expect(r.exit).toBe(124);
      expect(r.output).not.toContain("SHOULD_NOT_APPEAR");
      expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
      expect(elapsedMs).toBeLessThan(6000);
    },
    20_000,
  );

  it(
    "silent on real output but 'active' via a host-visible beacon survives idle, dies at the MAX ceiling",
    async () => {
      // The container has no path into the host's beacon file — upstream
      // itself never mounts rundir for the docker branch either (bin/shellm:
      // 2579 sets SHELLM_ACTIVITY_FILE unconditionally to a host tmp path
      // with no docker-mode branch, unlike final_path's own docker-mode
      // rewrite a few lines up) — so the exec'd code inside the container
      // cannot touch it, faithfully matching upstream's real limitation. The
      // watchdog's poll is host-side regardless of sandbox kind (see
      // sandbox.ts's file header), so this test drives the beacon from the
      // HOST in parallel with the exec — exactly what a reachable beacon
      // writer would produce — to prove the watchdog's idle/max logic is
      // identical across both sandboxes even though DockerSandbox can never
      // receive a beacon touch from its own exec'd code in production.
      const c = ensureContainer();
      if (!c) return;
      const sb = new DockerSandbox({ container: c });
      const activityFile = tmpActivityFile();
      const beacon = setInterval(() => {
        try {
          fs.writeFileSync(activityFile, String(Date.now()));
        } catch {
          /* directory gone after the test — ignore */
        }
      }, 400);
      const t0 = Date.now();
      try {
        const r = await sb.exec({
          workdir: "/tmp",
          wrappedCode: "sleep 6\necho SHOULD_NOT_APPEAR\n",
          env: { PATH: "/ignored" },
          inactivityTimeoutMs: IDLE_MS,
          timeoutMs: MAX_MS,
          activityFile,
        });
        const elapsedMs = Date.now() - t0;
        expect(r.timedOut).toBe(true);
        expect(r.killReason).toBe("max");
        expect(r.exit).toBe(124);
        expect(elapsedMs).toBeGreaterThanOrEqual(MAX_MS);
        expect(elapsedMs).toBeLessThan(MAX_MS + 4000);
      } finally {
        clearInterval(beacon);
      }
    },
    20_000,
  );

  it("cleanup: remove the shared container", () => {
    if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    container = "";
  });
});
