// sandbox-runtime-docker.test.ts — bug #70, REAL Docker daemon proof.
//
// The director-verified failure: a sandboxed `mem search` got `connect
// ECONNREFUSED 127.0.0.1:<port>` because LLM_API_URL named this host's own
// loopback interface, which means nothing inside the container. Upstream
// rewrites it to host.docker.internal for the container's env and adds
// `--add-host host.docker.internal:host-gateway` to the container it starts
// (bin/shellm:216-221, 1026-1034, 2659-2662/2679-2680/2712).
//
// This test is the end-to-end proof: a real HTTP listener bound to THIS
// host's 127.0.0.1, a real container started by `selectSandbox` (mode:
// "docker"), and a `curl "$LLM_API_URL"` run INSIDE that container via the
// same `applyDockerApiUrlRewrite` hunk steprun.ts's `runStep` applies.
//
//   - BEFORE the fix: LLM_API_URL stays 127.0.0.1:<port> inside the
//     container, which is the CONTAINER's own loopback (nothing listens
//     there) — curl fails to connect (asserted directly below, using the
//     unrewritten URL, so the failure mode this bug produced is pinned even
//     though the shipped code path no longer takes it).
//   - AFTER the fix (the shipped path): LLM_API_URL is rewritten to
//     host.docker.internal:<port>, the container was started with
//     --add-host so that name resolves to the Docker host gateway, and curl
//     reaches the real listener on this host.
//
// Skips cleanly (never a faked pass) when no real Docker daemon is
// reachable, matching every other docker-backed test in this repo
// (test/sandbox-docker.test.ts).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { DockerSandbox, DOCKER_CONTAINER_PATH } from "../src/sandbox-docker.ts";
import { selectSandbox, containerApiUrl, applyDockerApiUrlRewrite } from "../src/sandbox-runtime.ts";

const DAEMON = DockerSandbox.isDaemonAvailable();

async function startHostListener(): Promise<{ url: string; port: number; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const server = http.createServer((_req, res) => {
    hits.push(Date.now());
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("host-reached");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.skipIf(!DAEMON)("selectSandbox + applyDockerApiUrlRewrite — REAL docker round trip (bug #70)", () => {
  it(
    "an in-container curl reaches a host-loopback listener via the rewritten LLM_API_URL and the --add-host alias",
    async () => {
      const listener = await startHostListener();
      const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "b70-identity-"));
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "b70-workdir-"));
      roots.push(identityDir, workdir);

      // The host-side env a step would actually see: LLM_API_URL names this
      // host's own loopback, exactly like the director-verified failure.
      const hostEnv = { LLM_API_URL: listener.url, SHELLM_API_URL: listener.url };

      // 1. selectSandbox (mode: docker) — this is where the fix adds
      //    --add-host host.docker.internal:host-gateway to the fresh
      //    container, gated on the SAME loopback predicate as the rewrite.
      const result = selectSandbox({
        identityName: "bug70-proof",
        identityDir,
        workdir,
        binDir: "/usr/bin",
        portHome: process.cwd(),
        mode: "docker",
        tempDocker: true, // one-off test container
        env: hostEnv,
      });

      try {
        // 2. applyDockerApiUrlRewrite — the exact steprun.ts `runStep` hunk,
        //    applied to a step's exec env now that selectSandbox has said
        //    "docker".
        const execEnv: Record<string, string> = { ...hostEnv, PATH: "/ignored" };
        applyDockerApiUrlRewrite(execEnv, result.env.type);
        expect(execEnv["LLM_API_URL"]).toBe(`http://host.docker.internal:${listener.port}`);
        expect(execEnv["LLM_API_URL"]).not.toBe(listener.url); // actually rewritten, not a no-op

        // 3. Run curl INSIDE the container against the rewritten URL — the
        //    real production shape (env forwarded, container PATH).
        const afterFix = await result.sandbox.exec({
          workdir: "/",
          wrappedCode: 'curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "$LLM_API_URL"\n',
          env: { ...execEnv, PATH: DOCKER_CONTAINER_PATH },
        });
        expect(afterFix.output.trim()).toBe("200"); // reached the real host listener
        expect(afterFix.exit).toBe(0);
        expect(listener.hits.length).toBeGreaterThanOrEqual(1);

        // 4. Pin the BUG: the unrewritten, container-loopback URL that
        //    _shellm_container_api_url exists to avoid must NOT connect —
        //    "127.0.0.1" inside the container names the container itself,
        //    where nothing listens on this port.
        // `if curl …` (rather than `curl …; echo $?`) so `bash -e -c` (every
        // DockerSandbox.exec call wraps the code that way) doesn't abort
        // the script before the failure gets recorded.
        const beforeFix = await result.sandbox.exec({
          workdir: "/",
          wrappedCode:
            'if curl -sS --max-time 3 -o /dev/null -w "%{http_code}" "$LLM_API_URL" 2>&1; then echo CONNECTED; else echo "curl-failed rc=$?"; fi\n',
          env: { LLM_API_URL: listener.url, PATH: DOCKER_CONTAINER_PATH },
        });
        expect(beforeFix.output).not.toContain("CONNECTED");
        expect(beforeFix.output).toMatch(/curl-failed rc=\d+/); // curl's own connect-failure (exit 7)
      } finally {
        result.cleanup();
        await listener.close();
      }
    },
    120_000
  );

  it("containerApiUrl alone reproduces the rewrite the sandbox relies on (no daemon needed, sanity check)", () => {
    expect(containerApiUrl("http://127.0.0.1:55487")).toBe("http://host.docker.internal:55487");
  });
});
