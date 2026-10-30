// sandbox-env.test.ts — bug #32: the persistent per-identity Docker container
// lifecycle (env reuse across wakes, image-mismatch refusal per upstream
// 0925168, the --temp-docker equivalent, and killall's real docker-removal
// path for the new container name). All REAL Docker daemon tests — they
// skip cleanly when no daemon is reachable (DAEMON below), matching the
// convention test/sandbox-docker.test.ts already uses.
//
// Container/identity names below are unique to this file (`clc-*`) so a
// concurrent run never matches, lists, or removes anyone else's container —
// every scan is scoped to that exact name, never a system-wide sweep.

import { describe, it, expect, afterEach } from "vitest";
import { httpModel } from "./support/modelHttpFixture.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { selectSandbox } from "../src/sandbox-runtime.ts";
import { DockerSandbox } from "../src/sandbox-docker.ts";
import type { ExecRequest } from "../src/sandbox.ts";
import {
  envMetadataMismatchMessage,
  envDirFor,
  readEnvMetadata,
  writeEnvMetadata,
  workdirNotMountedMessage,
  staleToolMountsMessage,
} from "../src/sandbox-env.ts";
import { killall } from "../src/killall.ts";
import type { LlmClient, LlmResponse, ChatMessage } from "../src/llm.ts";

const DAEMON = DockerSandbox.isDaemonAvailable();
const DEFAULT_IMAGE = "node:24-bookworm"; // matches sandbox-runtime.ts's own default

function req(over: Partial<ExecRequest> = {}): ExecRequest {
  return { workdir: "/work", wrappedCode: "true\n", env: {}, ...over };
}

/** bug #55: a model HTTP fixture to prove a dead/unusable env fails BEFORE runShellm could ever reach
 *  the model — `selectSandbox` throws synchronously, so a client instantiated
 *  alongside it and never handed a request is the proof: `.requests` stays [].
 *  Transport fixture with NO replies (not model output): any call would get HTTP 500. */
const QueueClient = () => httpModel([]);

/** A fresh identityDir under $HOME (colima only maps host UID/GID correctly
 *  for paths under $HOME — see test/shellm.test.ts's dockerRunOpts comment). */
function freshIdentity(suffix: string): { identityDir: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.homedir(), `.headlong-clc-${suffix}-`));
  return { identityDir: path.join(root, "identity"), root };
}

function containersNamed(prefix: string, all = false): string[] {
  const args = ["ps", all ? "-aq" : "-q", "--filter", `name=^${prefix}`];
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n").filter(Boolean);
}

function rmAllNamed(prefix: string): void {
  for (const id of containersNamed(prefix, true)) spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
}

describe.skipIf(!DAEMON)("selectSandbox — persistent container lifecycle (bug #32, real docker)", () => {
  const roots: string[] = [];
  const namePrefixes: string[] = [];
  afterEach(() => {
    for (const p of namePrefixes.splice(0)) rmAllNamed(p);
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("two consecutive wakes reuse the same container: a file written in step 1 is visible in step 2, and `docker ps` shows one container", async () => {
    const { identityDir, root } = freshIdentity("reuse");
    roots.push(root);
    namePrefixes.push("shellm-clc-reuse-test-");

    const workdir1 = path.join(identityDir, ".shellm", "workdirs", "1");
    const r1 = selectSandbox({
      identityName: "clc-reuse-test",
      identityDir,
      workdir: workdir1,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
    });
    const w1 = await r1.sandbox.exec(req({ workdir: workdir1, wrappedCode: "echo marker > /tmp/clc-marker.txt\n" }));
    expect(w1.exit).toBe(0);

    const workdir2 = path.join(identityDir, ".shellm", "workdirs", "2");
    const r2 = selectSandbox({
      identityName: "clc-reuse-test",
      identityDir,
      workdir: workdir2,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
    });
    const w2 = await r2.sandbox.exec(req({ workdir: workdir2, wrappedCode: "cat /tmp/clc-marker.txt\n" }));
    expect(w2.exit).toBe(0);
    expect(w2.output).toBe("marker\n");

    // Same identity/env → same container both times (the actual reuse proof,
    // not just the marker-file side effect).
    const ids = containersNamed("shellm-clc-reuse-test-");
    expect(ids.length).toBe(1);

    expect(r1.env.name).toBe("clc-reuse-test");
    expect(r2.env.name).toBe("clc-reuse-test");
    expect(r2.env.docker_image).toBe(DEFAULT_IMAGE);

    // Default (non-temp) cleanup() is a no-op — the container survives both
    // calls' `finally { cleanup() }`, matching upstream's persistence.
    r1.cleanup();
    r2.cleanup();
    expect(DockerSandbox.isContainerRunning(ids[0]!)).toBe(true);
  }, 60_000);

  it("image mismatch refuses reuse with upstream's exact message (0925168)", () => {
    const { identityDir, root } = freshIdentity("mismatch");
    roots.push(root);
    namePrefixes.push("shellm-clc-mismatch-test-");

    const workdir1 = path.join(identityDir, ".shellm", "workdirs", "1");
    selectSandbox({
      identityName: "clc-mismatch-test",
      identityDir,
      workdir: workdir1,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
      dockerImage: DEFAULT_IMAGE,
    }).cleanup(); // no-op; container persists

    const workdir2 = path.join(identityDir, ".shellm", "workdirs", "2");
    let thrown: unknown;
    try {
      selectSandbox({
        identityName: "clc-mismatch-test",
        identityDir,
        workdir: workdir2,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
        dockerImage: "alpine:3.20",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const envsDir = path.join(identityDir, ".shellm", "envs");
    const expected = envMetadataMismatchMessage("clc-mismatch-test", DEFAULT_IMAGE, "alpine:3.20", envsDir);
    expect((thrown as Error).message).toBe(expected);
    expect((thrown as Error).message).toBe(
      `Env clc-mismatch-test was created from image ${DEFAULT_IMAGE}, but this run requested alpine:3.20. ` +
        `Use --new-env, a different --env, or remove ${envsDir}/clc-mismatch-test so shellm can recreate it from the requested image.`
    );

    // The refused request never touched the running container or its metadata.
    const ids = containersNamed("shellm-clc-mismatch-test-");
    expect(ids.length).toBe(1);
    const meta = readEnvMetadata(envDirFor(identityDir, "clc-mismatch-test"));
    expect(meta?.image).toBe(DEFAULT_IMAGE);
  }, 60_000);

  it("--temp-docker equivalent removes the container after the step", async () => {
    const { identityDir, root } = freshIdentity("temp");
    roots.push(root);
    namePrefixes.push("shellm-clc-temp-test-");

    const workdir = path.join(identityDir, ".shellm", "workdirs", "1");
    const result = selectSandbox({
      identityName: "clc-temp-test",
      identityDir,
      workdir,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
      tempDocker: true,
    });
    const w = await result.sandbox.exec(req({ workdir, wrappedCode: "echo hi\n" }));
    expect(w.exit).toBe(0);
    expect(containersNamed("shellm-clc-temp-test-").length).toBe(1);

    result.cleanup();

    expect(containersNamed("shellm-clc-temp-test-", true).length).toBe(0);
    expect(fs.existsSync(envDirFor(identityDir, "clc-temp-test"))).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // bug #55: the env-reuse liveness checks upstream runs BEFORE the first
  // model call (bin/shellm:1304-1339, characterized in sandbox-env.ts's
  // header). A stopped-but-PRESENT container with valid mounts is the one
  // case upstream itself recreates silently (no `die`) — that behavior is
  // exercised in "two consecutive wakes reuse the same container" above via
  // `isContainerRunning`; the cases below are the three NEW `die` branches.
  // -------------------------------------------------------------------------

  it("(a) recorded container id no longer exists: dies with upstream's exact message before any model call", () => {
    const { identityDir, root } = freshIdentity("dead");
    roots.push(root);
    namePrefixes.push("shellm-clc-dead-test-");

    const workdir = path.join(identityDir, ".shellm", "workdirs", "1");
    const r1 = selectSandbox({
      identityName: "clc-dead-test",
      identityDir,
      workdir,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
    });
    const ids1 = containersNamed("shellm-clc-dead-test-");
    expect(ids1.length).toBe(1);
    r1.cleanup(); // no-op; container persists

    // The chaos-run trigger for bug #55: the sandbox container disappears
    // out-of-band (dispatcher SIGKILL + thinkers restart) while this
    // identity's env metadata still claims it exists.
    spawnSync("docker", ["rm", "-f", ids1[0]!], { stdio: "ignore" });

    const client = QueueClient();
    let thrown: unknown;
    try {
      selectSandbox({
        identityName: "clc-dead-test",
        identityDir,
        workdir,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const envsDir = path.join(identityDir, ".shellm", "envs");
    // A removed container fails `docker inspect` entirely (zero mount
    // destinations), which upstream's own `docker_container_can_reach_path`
    // reports identically to "mounts present but don't cover this workdir" —
    // the SAME message as test (b) below (bin/shellm:1327).
    expect((thrown as Error).message).toBe(workdirNotMountedMessage("clc-dead-test", workdir, envsDir));
    expect((thrown as Error).message).toBe(
      `Env clc-dead-test was created without a mount for this run's workdir (${workdir}). ` +
        `Use --new-env, a different --env, or remove ${envsDir}/clc-dead-test so shellm can recreate it.`
    );
    // The failure happens inside selectSandbox, strictly before runShellm
    // could ever hand a prompt to the model.
    expect(client.requests).toHaveLength(0);
  }, 60_000);

  it("(b) container exists but its mounts don't cover this run's workdir: dies with the same message", () => {
    const { identityDir: identityA, root: rootA } = freshIdentity("reach-a");
    const { identityDir: identityB, root: rootB } = freshIdentity("reach-b");
    roots.push(rootA, rootB);
    namePrefixes.push("shellm-clc-reach-test-");

    // A real, live container whose only bind mount is identityA.
    const workdirA = path.join(identityA, ".shellm", "workdirs", "1");
    selectSandbox({
      identityName: "clc-reach-test",
      identityDir: identityA,
      workdir: workdirA,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
    }).cleanup(); // no-op; container persists
    const ids = containersNamed("shellm-clc-reach-test-");
    expect(ids.length).toBe(1);
    const meta = readEnvMetadata(envDirFor(identityA, "clc-reach-test"));
    expect(meta).toBeTruthy();

    // Point a SECOND identity's env metadata at that same live container —
    // its workdir lives under identityB, which the container never mounted.
    const envDirB = envDirFor(identityB, "clc-reach-test");
    writeEnvMetadata(envDirB, {
      containerId: meta!.containerId,
      image: meta!.image,
      ...(meta!.imageDigest ? { imageDigest: meta!.imageDigest } : {}),
      varMounts: meta!.varMounts,
    });
    const workdirB = path.join(identityB, ".shellm", "workdirs", "1");

    let thrown: unknown;
    try {
      selectSandbox({
        identityName: "clc-reach-test",
        identityDir: identityB,
        workdir: workdirB,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const envsDirB = path.join(identityB, ".shellm", "envs");
    expect((thrown as Error).message).toBe(workdirNotMountedMessage("clc-reach-test", workdirB, envsDirB));

    // The live container (identityA's) is untouched by the refused request.
    expect(DockerSandbox.isContainerRunning(meta!.containerId)).toBe(true);
  }, 60_000);

  it("(c) stale/unusable tool mounts: a tool shim that stopped being executable dies before the workdir check", () => {
    const { identityDir, root } = freshIdentity("toolstale");
    roots.push(root);
    namePrefixes.push("shellm-clc-toolstale-test-");

    // A throwaway binDir with a REAL "llm" shim file the container's
    // read-only portHome bind mirrors 1:1 — chmod'ing it on the host after
    // the container exists simulates upstream's "mount destination present,
    // executable gone" staleness (bin/shellm:722-731), which a live ro-bind
    // reflects immediately, unlike upstream's own separate per-tool mounts.
    const portHome = fs.mkdtempSync(path.join(os.homedir(), ".headlong-clc-toolstale-home-"));
    roots.push(portHome);
    const binDir = path.join(portHome, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const llmShim = path.join(binDir, "llm");
    fs.writeFileSync(llmShim, "#!/usr/bin/env bash\necho fake-llm\n");
    fs.chmodSync(llmShim, 0o755);

    const workdir = path.join(identityDir, ".shellm", "workdirs", "1");
    selectSandbox({
      identityName: "clc-toolstale-test",
      identityDir,
      workdir,
      binDir,
      portHome,
      mode: "docker",
    }).cleanup(); // no-op; container persists
    expect(containersNamed("shellm-clc-toolstale-test-").length).toBe(1);

    // Simulate staleness: the shim is no longer executable on the host,
    // which the container's live read-only bind reflects immediately.
    fs.chmodSync(llmShim, 0o644);

    let thrown: unknown;
    try {
      selectSandbox({
        identityName: "clc-toolstale-test",
        identityDir,
        workdir,
        binDir,
        portHome,
        mode: "docker",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const envsDir = path.join(identityDir, ".shellm", "envs");
    expect((thrown as Error).message).toBe(staleToolMountsMessage("clc-toolstale-test", envsDir));
  }, 60_000);

  // -------------------------------------------------------------------------
  // bug #35: --var directory auto-mount (RUNTIME-SEAMS.md §D item 4).
  // -------------------------------------------------------------------------

  it("a skill-declared directory var (e.g. --var DATA_DIR=<dir>) is visible inside the container at the SAME path", async () => {
    const { identityDir, root } = freshIdentity("varmount");
    roots.push(root);
    namePrefixes.push("shellm-clc-varmount-test-");

    // A directory OUTSIDE identityDir/portHome — the scenario RUNTIME-SEAMS.md
    // §D item 4 describes (a credentials/token-cache dir a skill declares).
    const dataDir = fs.mkdtempSync(path.join(os.homedir(), ".headlong-clc-varmount-data-"));
    roots.push(dataDir);
    fs.writeFileSync(path.join(dataDir, "note.txt"), "hello from the host\n");

    const workdir = path.join(identityDir, ".shellm", "workdirs", "1");
    const result = selectSandbox({
      identityName: "clc-varmount-test",
      identityDir,
      workdir,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
      varMounts: [{ name: "DATA_DIR", value: dataDir }],
    });
    const w = await result.sandbox.exec(req({ workdir, wrappedCode: `cat "${dataDir}/note.txt"\n` }));
    expect(w.exit).toBe(0);
    expect(w.output).toBe("hello from the host\n");
    result.cleanup(); // no-op; container persists
  }, 60_000);

  it("a var_mounts change since the container was created refuses reattach with upstream's exact message", async () => {
    const { identityDir, root } = freshIdentity("varmount-mismatch");
    roots.push(root);
    namePrefixes.push("shellm-clc-vmm-test-");

    const dataDir = fs.mkdtempSync(path.join(os.homedir(), ".headlong-clc-varmount-mismatch-data-"));
    roots.push(dataDir);

    const workdir1 = path.join(identityDir, ".shellm", "workdirs", "1");
    selectSandbox({
      identityName: "clc-vmm-test",
      identityDir,
      workdir: workdir1,
      binDir: "/usr/bin",
      portHome: process.cwd(),
      mode: "docker",
    }).cleanup(); // no-op; created with NO var mounts

    const workdir2 = path.join(identityDir, ".shellm", "workdirs", "2");
    let thrown: unknown;
    try {
      selectSandbox({
        identityName: "clc-vmm-test",
        identityDir,
        workdir: workdir2,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
        varMounts: [{ name: "DATA_DIR", value: dataDir }], // now requires a NEW mount
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const envsDir = path.join(identityDir, ".shellm", "envs");
    expect((thrown as Error).message).toBe(
      `Env clc-vmm-test has different --var directory mounts than this run requires. ` +
        `Use a different --env or remove ${envsDir}/clc-vmm-test so shellm can recreate it with the correct mounts.`
    );

    // The refused request never touched the running container.
    expect(containersNamed("shellm-clc-vmm-test-").length).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// killall's real `docker rm -f` path (RUNTIME-SEAMS.md §D item 3), proven
// here against a real container with the new persistent-env name shape.
// `dockerListing` stays injected (scoped to exactly this test's own
// container) rather than the real system-wide `docker ps` scan — the same
// safety convention test/killall.test.ts uses for `psSnapshot`, so this test
// can never see or touch another concurrent run's `shellm-*` container. Only
// the LISTING is a fixture; the removal call underneath is the real
// `spawnSync("docker", ["rm","-f", ...])` killall.ts itself makes.
// ---------------------------------------------------------------------------
describe.skipIf(!DAEMON)("killall — real docker removal of a persistent shellm-* container (bug #32)", () => {
  it("removes the identity's persistent container and reports it, matching upstream's stdout lines", async () => {
    const { identityDir, root } = freshIdentity("killall");
    try {
      const workdir = path.join(identityDir, ".shellm", "workdirs", "1");
      const result = selectSandbox({
        identityName: "clc-killall-test",
        identityDir,
        workdir,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
      });
      const ids = containersNamed("shellm-clc-killall-test-");
      expect(ids.length).toBe(1);
      const containerId = ids[0]!;
      const containerName = spawnSync("docker", ["inspect", "-f", "{{.Name}}", containerId], { encoding: "utf8" })
        .stdout.trim()
        .replace(/^\//, "");

      const lines: string[] = [];
      const res = await killall({
        psSnapshot: () => [],
        dockerListing: () => ({
          shellmIds: [containerId],
          shellmLines: [`  ${containerName} (Up)`],
          brokerLines: [],
        }),
        stdout: (s) => lines.push(s),
        stderr: () => {},
      });
      expect(res.ok).toBe(true);

      const out = lines.join("");
      expect(out).toContain("Removing docker container(s):\n");
      expect(out).toContain(`  ${containerName} (Up)\n`);

      expect(DockerSandbox.isContainerRunning(containerId)).toBe(false);
      expect(containersNamed("shellm-clc-killall-test-", true).length).toBe(0);
      result.cleanup(); // no-op; container is already gone
    } finally {
      rmAllNamed("shellm-clc-killall-test-");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
