// status-lib.test.ts — unit tests for src/status-lib.ts (status.sh port).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatus, type StatusIO } from "../src/status-lib.ts";
import { TOOLS } from "../src/install-lib.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function fakeIO(overrides: Partial<StatusIO> = {}): { io: StatusIO; out: string[] } {
  const out: string[] = [];
  const io: StatusIO = {
    stdout: (s) => out.push(s),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    hostname: () => "test-host",
    listProcesses: () => [],
    selfPid: () => 99999,
    ...overrides,
  };
  return { io, out };
}

describe("runStatus", () => {
  it("reports 'not installed' when nothing exists", () => {
    const home = tmpDir("status-home-");
    const env = { HOME: home, HEADLONG_HOME: path.join(home, ".headlong") };
    const { io, out } = fakeIO();
    const code = runStatus(env, io, tmpDir("status-cwd-"));
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/not installed/);
  });

  it("reports the checkout, state home keys/model, and tool count", () => {
    const home = tmpDir("status-home2-");
    const headlongHome = path.join(home, ".headlong");
    fs.mkdirSync(headlongHome, { recursive: true });
    fs.writeFileSync(path.join(headlongHome, ".env"), "ANTHROPIC_API_KEY='x'\nSHELLM_MODEL='claude-sonnet-4-5'\n");
    const appDir = tmpDir("status-app-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "bin", "identity.mjs"), "");
    fs.writeFileSync(path.join(headlongHome, "app_dir"), `${appDir}\n`);
    const prefix = path.join(home, ".local", "bin");
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, TOOLS[0]!), "");

    const env = { HOME: home, HEADLONG_HOME: headlongHome, PREFIX: prefix, PATH: "" };
    const { io, out } = fakeIO();
    const code = runStatus(env, io, tmpDir("status-cwd2-"));
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(new RegExp(`checkout:\\s+${appDir}`));
    expect(text).toMatch(/ANTHROPIC_API_KEY/);
    expect(text).toMatch(/model claude-sonnet-4-5/);
    expect(text).toMatch(new RegExp(`tools:\\s+1 of ${TOOLS.length}`));
    expect(text).toMatch(/NOT on PATH/);
  });

  it("lists identities with mind running/stopped, marks the default", () => {
    const home = tmpDir("status-home3-");
    const headlongHome = path.join(home, ".headlong");
    fs.mkdirSync(headlongHome, { recursive: true });
    const appDir = tmpDir("status-app2-");
    fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "bin", "identity.mjs"), "");
    const idRoot = path.join(appDir, ".identities");
    fs.mkdirSync(path.join(idRoot, "ada", "run"), { recursive: true });
    fs.mkdirSync(path.join(idRoot, "bob", "run"), { recursive: true });
    fs.writeFileSync(path.join(idRoot, "ada", "run", "dispatcher.pid"), "99999\n"); // matches fakeIO's "alive" self pid trick below
    fs.symlinkSync("ada", path.join(idRoot, "default"));

    const env = { HOME: home, HEADLONG_HOME: headlongHome, HEADLONG_APP_DIR: appDir, PATH: "" };
    // process.kill(99999, 0) on a pid that doesn't exist throws ESRCH — use our own pid instead so "alive" is true.
    fs.writeFileSync(path.join(idRoot, "ada", "run", "dispatcher.pid"), `${process.pid}\n`);
    const { io, out } = fakeIO();
    const code = runStatus(env, io, appDir);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/ada \(default\): mind running \(dispatcher pid/);
    expect(text).toMatch(/bob: mind stopped/);
  });

  it("matches this port's own process shapes (dispatcherd/thinker-step/dash), excludes the caller's own pid", () => {
    const home = tmpDir("status-home4-");
    const headlongHome = path.join(home, ".headlong");
    fs.mkdirSync(headlongHome, { recursive: true });
    const env = { HOME: home, HEADLONG_HOME: headlongHome, PATH: "" };
    const { io, out } = fakeIO({
      listProcesses: () => [
        "111 node /some/checkout/bin/dispatcherd.mjs",
        "222 node /some/checkout/.identities/ada/thinkers/monolith/step",
        "333 node /some/checkout/web/scripts/dev.mjs --root x",
        "444 unrelated-process --flag",
        "99999 node /some/checkout/bin/dispatcherd.mjs", // this IS the "self" pid — must be excluded
      ],
      selfPid: () => 99999,
    });
    runStatus(env, io, tmpDir("status-cwd4-"));
    const text = out.join("");
    expect(text).toMatch(/111 node/);
    expect(text).toMatch(/222 node/);
    expect(text).toMatch(/333 node/);
    expect(text).not.toMatch(/444 unrelated-process/);
    expect(text).toMatch(/3 process\(es\)/);
  });

  it("--help / unknown-option behavior is a CLI concern, not runStatus's — runStatus never exits nonzero on its own", () => {
    const home = tmpDir("status-home5-");
    const env = { HOME: home, HEADLONG_HOME: path.join(home, ".headlong") };
    const { io } = fakeIO();
    expect(runStatus(env, io, tmpDir("status-cwd5-"))).toBe(0);
  });
});
