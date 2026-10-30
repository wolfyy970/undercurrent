// sandbox-runtime.test.ts — bug #70: a Docker sandbox's in-container tools
// (llm, mem search, ...) must reach a loopback-bound model server via
// host.docker.internal instead of this host's own loopback interface
// (bin/shellm:216-221 `_shellm_container_api_url`, bin/shellm:1026-1034's
// `--add-host`, bin/shellm:2659-2662/2679-2680/2712's exec-env rewrite).
//
// Everything here runs WITHOUT a real Docker daemon: `selectSandbox`'s
// `docker run`/`docker info`/etc. calls go through a FAKE `docker` script
// (same technique as sandbox-docker.test.ts) that just logs its argv and
// returns success, so the `--add-host` predicate can be asserted without a
// live daemon. The real-daemon end-to-end proof (a host listener actually
// reachable from inside the container) lives in
// test/sandbox-runtime-docker.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectSandbox, containerApiUrl, applyDockerApiUrlRewrite } from "../src/sandbox-runtime.ts";

// ---------------------------------------------------------------------------
// containerApiUrl — the rewrite matrix (bin/shellm:177-221's four helpers,
// ported as src/net-url.ts and wrapped here for the Docker-exec call site).
// ---------------------------------------------------------------------------
describe("containerApiUrl (bug #70, bin/shellm:216-221 _shellm_container_api_url)", () => {
  it("rewrites 127.0.0.1 with a port, preserving scheme/port/path", () => {
    expect(containerApiUrl("http://127.0.0.1:8080/v1/chat/completions")).toBe(
      "http://host.docker.internal:8080/v1/chat/completions"
    );
  });

  it("rewrites other 127.x loopback addresses", () => {
    expect(containerApiUrl("http://127.5.5.5:9/v1")).toBe("http://host.docker.internal:9/v1");
  });

  it("rewrites localhost", () => {
    expect(containerApiUrl("https://localhost/v1")).toBe("https://host.docker.internal/v1");
  });

  it("rewrites 0.0.0.0", () => {
    expect(containerApiUrl("http://0.0.0.0:11434/v1")).toBe("http://host.docker.internal:11434/v1");
  });

  it("rewrites the IPv6 loopback ::1, brackets and port preserved as the swapped host's own bracket-free form", () => {
    expect(containerApiUrl("http://[::1]:8080/v1")).toBe("http://host.docker.internal:8080/v1");
  });

  it("leaves a non-loopback host untouched (a real remote endpoint)", () => {
    expect(containerApiUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
  });

  it("leaves a loopback-LOOKING but distinct hostname untouched (mylocalhost.dev)", () => {
    expect(containerApiUrl("http://mylocalhost.dev:8080/v1")).toBe("http://mylocalhost.dev:8080/v1");
  });

  it("preserves userinfo when rewriting a loopback URL", () => {
    expect(containerApiUrl("http://user:pass@127.0.0.1:8080/v1")).toBe("http://user:pass@host.docker.internal:8080/v1");
  });

  it("is a no-op when the URL is already host.docker.internal", () => {
    expect(containerApiUrl("http://host.docker.internal:8080/v1")).toBe("http://host.docker.internal:8080/v1");
  });

  it("preserves a bare host with no port and no path", () => {
    expect(containerApiUrl("http://localhost")).toBe("http://host.docker.internal");
  });
});

// ---------------------------------------------------------------------------
// applyDockerApiUrlRewrite — the steprun.ts call-site hunk, isolated.
// ---------------------------------------------------------------------------
describe("applyDockerApiUrlRewrite (steprun.ts's minimal hunk, isolated)", () => {
  it("rewrites SHELLM_API_URL and LLM_API_URL independently when envType is docker", () => {
    const execEnv = {
      SHELLM_API_URL: "http://127.0.0.1:55487",
      LLM_API_URL: "http://127.0.0.1:55487",
      ANTHROPIC_API_KEY: "sk-ant-should-not-move",
    };
    applyDockerApiUrlRewrite(execEnv, "docker");
    expect(execEnv.SHELLM_API_URL).toBe("http://host.docker.internal:55487");
    expect(execEnv.LLM_API_URL).toBe("http://host.docker.internal:55487");
    expect(execEnv.ANTHROPIC_API_KEY).toBe("sk-ant-should-not-move"); // untouched keys survive
  });

  it("does NOT rewrite for a local step — the host process keeps the host URL (bin/shellm:2657-2658)", () => {
    const execEnv = { SHELLM_API_URL: "http://127.0.0.1:55487", LLM_API_URL: "http://127.0.0.1:55487" };
    applyDockerApiUrlRewrite(execEnv, "local");
    expect(execEnv.SHELLM_API_URL).toBe("http://127.0.0.1:55487");
    expect(execEnv.LLM_API_URL).toBe("http://127.0.0.1:55487");
  });

  it("is a no-op on undefined execEnv (never throws)", () => {
    expect(applyDockerApiUrlRewrite(undefined, "docker")).toBeUndefined();
  });

  it("leaves a non-loopback endpoint alias untouched even in docker mode", () => {
    const execEnv = { LLM_API_URL: "https://openrouter.ai/api/v1" };
    applyDockerApiUrlRewrite(execEnv, "docker");
    expect(execEnv.LLM_API_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("only touches SHELLM_API_URL/LLM_API_URL — every other key is untouched", () => {
    const execEnv = { SHELLM_API_URL: "http://127.0.0.1:1", MEM_DIR: "/id/memories", CHATRC: "/id/chat/.chatrc" };
    applyDockerApiUrlRewrite(execEnv, "docker");
    expect(execEnv.MEM_DIR).toBe("/id/memories");
    expect(execEnv.CHATRC).toBe("/id/chat/.chatrc");
  });
});

// ---------------------------------------------------------------------------
// selectSandbox / startDockerSandbox — the `--add-host` predicate, driven
// against a FAKE docker binary (no daemon needed) so the argv can be
// inspected directly.
// ---------------------------------------------------------------------------
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "run" ]; then
  echo "fake-container-id"
fi
exit 0
`;

function makeFakeDocker(): { dockerPath: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-runtime-"));
  const dockerPath = path.join(dir, "docker");
  fs.writeFileSync(dockerPath, FAKE_DOCKER);
  fs.chmodSync(dockerPath, 0o755);
  const logPath = path.join(dir, "log");
  fs.writeFileSync(logPath, "");
  return { dockerPath, logPath };
}

function runLineOf(logPath: string): string {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const runLine = lines.find((l) => l.startsWith("run "));
  if (!runLine) throw new Error(`no "docker run" invocation logged; saw:\n${lines.join("\n")}`);
  return runLine;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function freshDirs(): { identityDir: string; workdir: string; binDir: string; portHome: string } {
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-identity-"));
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-workdir-"));
  roots.push(identityDir, workdir);
  return { identityDir, workdir, binDir: "/usr/bin", portHome: process.cwd() };
}

// The `docker` child process spawned by selectSandbox always inherits the
// REAL process env (none of its spawnSync calls pass an explicit `env:` —
// a real `docker` CLI needs the actual DOCKER_CONTEXT/HOME/PATH to find the
// daemon), so FAKE_DOCKER_LOG has to ride on process.env, not the `env`
// option `selectSandbox` reads its own SHELLM_API_URL/LLM_API_URL knobs
// from. Save/restore it and the two endpoint aliases around each test.
const savedProcessEnv: Record<string, string | undefined> = {};
function stashProcessEnv(keys: string[]): void {
  for (const k of keys) savedProcessEnv[k] = process.env[k];
}
afterEach(() => {
  for (const k of Object.keys(savedProcessEnv)) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
    delete savedProcessEnv[k];
  }
});

describe("selectSandbox --add-host host.docker.internal:host-gateway (bug #70, bin/shellm:1026-1034)", () => {
  it("adds --add-host when SHELLM_API_URL is loopback", () => {
    const { dockerPath, logPath } = makeFakeDocker();
    const { identityDir, workdir, binDir, portHome } = freshDirs();
    stashProcessEnv(["FAKE_DOCKER_LOG"]);
    process.env["FAKE_DOCKER_LOG"] = logPath;
    const result = selectSandbox({
      identityName: "nova-70a",
      identityDir,
      workdir,
      binDir,
      portHome,
      mode: "docker",
      dockerPath,
      env: { SHELLM_API_URL: "http://127.0.0.1:55487" },
    });
    result.cleanup();
    expect(runLineOf(logPath)).toContain("--add-host host.docker.internal:host-gateway");
  });

  it("adds --add-host when only LLM_API_URL (not SHELLM_API_URL) is loopback", () => {
    const { dockerPath, logPath } = makeFakeDocker();
    const { identityDir, workdir, binDir, portHome } = freshDirs();
    stashProcessEnv(["FAKE_DOCKER_LOG"]);
    process.env["FAKE_DOCKER_LOG"] = logPath;
    const result = selectSandbox({
      identityName: "nova-70b",
      identityDir,
      workdir,
      binDir,
      portHome,
      mode: "docker",
      dockerPath,
      env: { LLM_API_URL: "http://localhost:11434/v1" },
    });
    result.cleanup();
    expect(runLineOf(logPath)).toContain("--add-host host.docker.internal:host-gateway");
  });

  it("omits --add-host when neither endpoint alias is loopback", () => {
    const { dockerPath, logPath } = makeFakeDocker();
    const { identityDir, workdir, binDir, portHome } = freshDirs();
    stashProcessEnv(["FAKE_DOCKER_LOG"]);
    process.env["FAKE_DOCKER_LOG"] = logPath;
    const result = selectSandbox({
      identityName: "nova-70c",
      identityDir,
      workdir,
      binDir,
      portHome,
      mode: "docker",
      dockerPath,
      env: { SHELLM_API_URL: "https://openrouter.ai/api/v1" },
    });
    result.cleanup();
    expect(runLineOf(logPath)).not.toContain("--add-host");
  });

  it("omits --add-host when neither endpoint alias is set at all", () => {
    const { dockerPath, logPath } = makeFakeDocker();
    const { identityDir, workdir, binDir, portHome } = freshDirs();
    stashProcessEnv(["FAKE_DOCKER_LOG"]);
    process.env["FAKE_DOCKER_LOG"] = logPath;
    const result = selectSandbox({
      identityName: "nova-70d",
      identityDir,
      workdir,
      binDir,
      portHome,
      mode: "docker",
      dockerPath,
      env: {},
    });
    result.cleanup();
    expect(runLineOf(logPath)).not.toContain("--add-host");
  });
});

import { applyLocalInheritedEnv } from "../src/sandbox-runtime.ts";

describe("applyLocalInheritedEnv (bin/thinkers:387-389 export; bin/shellm:1629 local inherit, 1651-1664 docker --var only)", () => {
  const from = { IDENTITY_DIR: "/id", THINK_CONTEXT_TAIL: "30", PATH: "/usr/bin", OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv;
  it("local: adds the dispatcher-exported names that are set, never anything else, and keeps existing values", () => {
    const e: Record<string, string> = { IDENTITY_NAME: "pax", THINK_CONTEXT_TAIL: "7" };
    applyLocalInheritedEnv(e, from, "local");
    expect(e).toEqual({ IDENTITY_NAME: "pax", THINK_CONTEXT_TAIL: "7", IDENTITY_DIR: "/id" });
  });
  it("docker: unchanged (the container only gets the --var list)", () => {
    const e: Record<string, string> = {};
    applyLocalInheritedEnv(e, from, "docker");
    expect(e).toEqual({});
  });
});
