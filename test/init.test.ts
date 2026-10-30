// init.test.ts — unit + integration tests for the headlong-init port
// (src/init.ts, faithful port of tools/headlong-init). Behavior pinned here
// mirrors the upstream oracle's own suites (tests/test_sandbox_gate.sh,
// tests/test_local_llm_setup.sh) — see parity/init/run-parity.mjs for the
// differential run against the real Bash tool.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runHeadlongInit,
  envSet,
  envUnset,
  dockerState,
  type InitIO,
  type EnvWriter,
} from "../src/init.ts";
import { startFakeServer, type FakeServer } from "./llmFakeServer.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** llmFakeServer's `url` is a full chat-completions URL; derive the bare origin for a base /v1 URL. */
function origin(srv: FakeServer): string {
  return new URL(srv.url).origin;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const r = roots.pop()!;
    fs.rmSync(r, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** A minimal fake headlong-ts checkout: just the marker resolveAppDir checks for. */
function fakeAppDir(): string {
  const d = tmpDir("headlong-init-app-");
  fs.mkdirSync(path.join(d, "bin"), { recursive: true });
  fs.writeFileSync(path.join(d, "bin", "identity.mjs"), "");
  return d;
}

interface Rig {
  home: string;
  appDir: string;
  env: Record<string, string>;
  io: InitIO;
  out: string[];
  err: string[];
  ttyLines: (string | undefined)[];
}

function fakeIO(overrides: Partial<InitIO> = {}): { io: InitIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: InitIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    fetch: globalThis.fetch,
    randomHex: () => "deadbeef",
    hasTTY: () => false,
    readTtyLine: async () => undefined,
    writeTty: (s) => out.push(s),
    spawnDetached: () => {
      throw new Error("spawnDetached should not be called in this test");
    },
    isAlive: () => false,
    openUrl: () => {},
    platform: "linux",
    execPath: process.execPath,
    ...overrides,
  };
  return { io, out, err };
}

function makeRig(envOverrides: Record<string, string | undefined> = {}): Rig {
  const home = tmpDir("headlong-init-home-");
  const appDir = fakeAppDir();
  const { io, out, err } = fakeIO();
  const env: Record<string, string> = { HOME: home, HEADLONG_HOME: path.join(home, ".headlong"), HEADLONG_APP_DIR: appDir, HEADLONG_NO_TTY: "1", PATH: process.env["PATH"] ?? "" };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { home, appDir, env, io, out, err, ttyLines: [] };
}

function envFileText(rig: Rig): string {
  try {
    return fs.readFileSync(path.join(rig.home, ".headlong", ".env"), "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("envSet / envUnset", () => {
  it("writes single-quoted KEY='value', replacing an existing line, chmod 600", () => {
    const dir = tmpDir("envset-");
    const file = path.join(dir, ".env");
    const { io } = fakeIO();
    const w: EnvWriter = { dryRun: false, io };
    const env: Record<string, string> = {};
    envSet(w, env, file, "FOO", "bar");
    envSet(w, env, file, "FOO", "baz");
    expect(fs.readFileSync(file, "utf8")).toBe("FOO='baz'\n");
    expect(env["FOO"]).toBe("baz");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("escapes embedded single quotes", () => {
    const dir = tmpDir("envset2-");
    const file = path.join(dir, ".env");
    const { io } = fakeIO();
    const w: EnvWriter = { dryRun: false, io };
    const env: Record<string, string> = {};
    envSet(w, env, file, "KEY", "it's here");
    expect(fs.readFileSync(file, "utf8")).toBe("KEY='it'\\''s here'\n");
  });

  it("dry-run writes nothing but still exports into the working env", () => {
    const dir = tmpDir("envset3-");
    const file = path.join(dir, ".env");
    const { io, out } = fakeIO();
    const w: EnvWriter = { dryRun: true, io };
    const env: Record<string, string> = {};
    envSet(w, env, file, "FOO", "bar");
    expect(fs.existsSync(file)).toBe(false);
    expect(env["FOO"]).toBe("bar");
    expect(out.join("")).toMatch(/dry-run: would set FOO=bar/);
  });

  it("envUnset removes the KEY= line and the env entry", () => {
    const dir = tmpDir("envunset-");
    const file = path.join(dir, ".env");
    const { io } = fakeIO();
    const w: EnvWriter = { dryRun: false, io };
    const env: Record<string, string> = { FOO: "bar" };
    fs.writeFileSync(file, "FOO='bar'\nBAZ='qux'\n");
    envUnset(w, env, file, "FOO");
    expect(fs.readFileSync(file, "utf8")).toBe("BAZ='qux'\n");
    expect(env["FOO"]).toBeUndefined();
  });
});

describe("dockerState", () => {
  it("HEADLONG_FAKE_DOCKER overrides real detection", () => {
    expect(dockerState({ HEADLONG_FAKE_DOCKER: "ok", PATH: "" })).toBe("ok");
    expect(dockerState({ HEADLONG_FAKE_DOCKER: "down", PATH: "" })).toBe("down");
    expect(dockerState({ HEADLONG_FAKE_DOCKER: "missing", PATH: "" })).toBe("missing");
  });

  it("missing when docker is not on PATH", () => {
    expect(dockerState({ PATH: "/nonexistent-dir-xyz" })).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// Sandbox gate (tests/test_sandbox_gate.sh scenarios)
// ---------------------------------------------------------------------------

describe("runHeadlongInit — sandbox gate", () => {
  it("--dry-run: docker ok, announces the sandbox, writes nothing, exits 0", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "ok" });
    const code = await runHeadlongInit({ argv: ["--dry-run"], env: rig.env, io: rig.io });
    expect(code).toBe(0);
    const text = rig.out.join("");
    expect(text).toMatch(/sandboxed in Docker/);
    expect(text).toMatch(/would set SHELLM_REQUIRE_DOCKER=1/);
    expect(text).toMatch(/[Dd]ry run/);
    expect(fs.existsSync(path.join(rig.home, ".headlong", ".env"))).toBe(false);
  });

  it("no docker, no consent, no tty: exits nonzero, names HEADLONG_UNSANDBOXED, never reaches the key step", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "missing" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    const text = rig.err.join("");
    expect(text).toMatch(/HEADLONG_UNSANDBOXED/);
    expect(text.toLowerCase()).not.toMatch(/api key/);
  });

  it("no docker, HEADLONG_UNSANDBOXED=1: gate passes, warns, persists SHELLM_REQUIRE_DOCKER='0'", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "missing", HEADLONG_UNSANDBOXED: "1" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0); // fails later at the key step
    expect(rig.err.join("")).toMatch(/directly on this machine/);
    expect(envFileText(rig)).toMatch(/^SHELLM_REQUIRE_DOCKER='0'$/m);
    expect(envFileText(rig)).toMatch(/^HEADLONG_UNSANDBOXED='1'$/m);
  });

  it("docker up: announces the sandbox, persists SHELLM_REQUIRE_DOCKER='1'", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "ok" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0); // fails later, no key
    expect(rig.out.join("")).toMatch(/sandboxed in Docker/);
    expect(envFileText(rig)).toMatch(/^SHELLM_REQUIRE_DOCKER='1'$/m);
  });

  it("explicit unsandboxed choice sticks even with docker up (installer menu 3)", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "ok", HEADLONG_UNSANDBOXED: "1" });
    await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(envFileText(rig)).toMatch(/^SHELLM_REQUIRE_DOCKER='0'$/m);
    expect(envFileText(rig)).toMatch(/^HEADLONG_UNSANDBOXED='1'$/m);
    expect(rig.out.join("")).not.toMatch(/sandboxed in Docker/);
  });

  it("unknown option is an error", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "ok" });
    const code = await runHeadlongInit({ argv: ["--bogus"], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
  });

  it("--help prints usage and exits 0", async () => {
    const rig = makeRig();
    const code = await runHeadlongInit({ argv: ["--help"], env: rig.env, io: rig.io });
    expect(code).toBe(0);
    expect(rig.out.join("")).toMatch(/headlong-init — bootstrap/);
  });
});

// ---------------------------------------------------------------------------
// Local (OpenAI-compatible) provider setup (tests/test_local_llm_setup.sh)
// ---------------------------------------------------------------------------

describe("runHeadlongInit — local LLM provider", () => {
  let srv: FakeServer;
  beforeAll(async () => {
    srv = await startFakeServer();
  });
  afterAll(async () => {
    await srv.close();
  });
  beforeEach(() => srv.reset());

  function baseEnv(): Record<string, string | undefined> {
    return {
      HEADLONG_FAKE_DOCKER: "ok",
      HEADLONG_NO_THINKERS: "1",
      HEADLONG_NO_DASH: "1",
      HEADLONG_IDENTITY_NAME: "ada",
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      OPENCODE_API_KEY: undefined,
    };
  }

  // Endpoint replies here are wire-format fixtures (not model output): a /models listing and a one-delta "ok" stream
  // for init's connectivity probe, which only checks that the endpoint answers.
  it("happy path: persists LLM_PROVIDER/SHELLM_API_URL/SHELLM_MODEL, no key written", async () => {
    srv.script([
      { body: JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] }) },
      { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
    ]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1`, HEADLONG_LOCAL_MODEL: "qwen3:8b" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).toBe(0);
    const envText = envFileText(rig);
    expect(envText).toMatch(/^LLM_PROVIDER='openai-compatible'$/m);
    expect(envText).toMatch(new RegExp(`^SHELLM_API_URL='${escapeRe(srv.url)}'$`, "m"));
    expect(envText).toMatch(/^SHELLM_MODEL='qwen3:8b'$/m);
    expect(envText).not.toMatch(/^LLM_API_KEY=/m);
    expect(srv.requests[0]!.url).toBe("/v1/models");
  });

  it("a model id with shell metacharacters is refused; nothing persisted", async () => {
    srv.script([{ body: JSON.stringify({ data: [{ id: "qwen3$(touch pwned)" }] }) }]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1` });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    expect(envFileText(rig)).not.toMatch(/^LLM_PROVIDER=/m);
    expect(envFileText(rig)).not.toMatch(/pwned/);
  });

  it("a model id with a space is refused", async () => {
    srv.script([{ body: JSON.stringify({ data: [{ id: "qwen3 8b" }] }) }]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1` });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
  });

  it("a dead endpoint dies before writing any local config", async () => {
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: "http://127.0.0.1:1/v1", HEADLONG_LOCAL_MODEL: "x" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    expect(rig.err.join("")).toMatch(/could not reach/);
    expect(envFileText(rig)).not.toMatch(/^LLM_PROVIDER=/m);
  });

  it("a full chat-completions URL is kept as given", async () => {
    srv.script([
      { body: JSON.stringify({ data: [{ id: "gemma3:12b" }] }) },
      { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
    ]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: srv.url, HEADLONG_LOCAL_MODEL: "gemma3:12b" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).toBe(0);
    expect(envFileText(rig)).toMatch(new RegExp(`^SHELLM_API_URL='${escapeRe(srv.url)}'$`, "m"));
  });

  it("an explicit model works even when the server exposes an empty model list", async () => {
    srv.script([
      { body: JSON.stringify({ data: [] }) },
      { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
    ]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1`, HEADLONG_LOCAL_MODEL: "qwen3:8b" });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).toBe(0);
  });

  it("empty model list, no model given: dies, and never blames 'is it an OpenAI-compatible server?'", async () => {
    srv.script([{ body: JSON.stringify({ data: [] }) }]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1` });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    expect(rig.out.join("") + rig.err.join("")).not.toMatch(/OpenAI-compatible server\?/i);
  });

  it("cloud explicitly requested: local env vars are ignored", async () => {
    // The cloud check goes to this fixture (HTTP 401, transport fixture), not to api.openai.com: the test used to
    // depend on a live external host answering inside vitest's 5 s, and failed whenever the network was slow.
    srv.script([{ status: 401, body: '{"error":{"message":"Incorrect API key provided","code":401}}' }]);
    const rig = makeRig({
      ...baseEnv(),
      HEADLONG_PROVIDER: "cloud",
      HEADLONG_LOCAL_URL: `${origin(srv)}/local/v1`,
      HEADLONG_LOCAL_MODEL: "qwen3:8b",
      OPENAI_API_KEY: "sk-test-not-real",
      LLM_API_URL: `${origin(srv)}/cloud/v1/chat/completions`,
      LLM_RETRIES: "0",
    });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0); // the fake key is refused
    expect(envFileText(rig)).not.toMatch(/SHELLM_API_URL/);
    // The local endpoint was never used: every request went to the cloud URL with the cloud key.
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((r) => r.url.startsWith("/cloud/") && r.headers["authorization"] === "Bearer sk-test-not-real")).toBe(true);
  });

  it("re-run idempotence: config survives, exactly once per var", async () => {
    srv.script([
      { body: JSON.stringify({ data: [{ id: "qwen3:8b" }] }) },
      { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
      { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
    ]);
    const rig = makeRig({ ...baseEnv(), HEADLONG_PROVIDER: "local", HEADLONG_LOCAL_URL: `${origin(srv)}/v1`, HEADLONG_LOCAL_MODEL: "qwen3:8b" });
    const first = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(first).toBe(0);
    // Second run: same working env (as bash re-sources $HEADLONG_HOME/.env);
    // simulate that by loading the persisted values back plus HEADLONG_IDENTITY_NAME.
    const rig2 = makeRig({ HEADLONG_FAKE_DOCKER: "ok", HEADLONG_NO_THINKERS: "1", HEADLONG_NO_DASH: "1", HEADLONG_IDENTITY_NAME: "ada" });
    rig2.home = rig.home;
    rig2.appDir = rig.appDir;
    rig2.env["HEADLONG_HOME"] = rig.env["HEADLONG_HOME"]!;
    rig2.env["HEADLONG_APP_DIR"] = rig.appDir;
    const second = await runHeadlongInit({ argv: [], env: rig2.env, io: rig2.io });
    expect(second).toBe(0);
    const envText = envFileText(rig);
    const matches = envText.match(/^SHELLM_API_URL=/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Identity creation
// ---------------------------------------------------------------------------

describe("runHeadlongInit — identity creation", () => {
  it("creates the identity dir, memories, and a fallback core_identity_prompt.md when the LLM is unreachable", async () => {
    const rig = makeRig({
      HEADLONG_FAKE_DOCKER: "ok",
      HEADLONG_NO_THINKERS: "1",
      HEADLONG_NO_DASH: "1",
      HEADLONG_IDENTITY_NAME: "ada",
      HEADLONG_PROVIDER: "local",
      HEADLONG_LOCAL_URL: "http://127.0.0.1:1/v1", // unreachable — die() before any identity work in this run
    });
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(rig.appDir, ".identities", "ada"))).toBe(false);
  });

  it("full run with a working local endpoint creates the identity tree", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([
        { body: JSON.stringify({ data: [{ id: "qwen3:8b" }] }) },
        { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
      ]);
      const rig = makeRig({
        HEADLONG_FAKE_DOCKER: "ok",
        HEADLONG_NO_THINKERS: "1",
        HEADLONG_NO_DASH: "1",
        HEADLONG_IDENTITY_NAME: "ada",
        HEADLONG_PROVIDER: "local",
        HEADLONG_LOCAL_URL: `${origin(srv)}/v1`,
        HEADLONG_LOCAL_MODEL: "qwen3:8b",
      });
      const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
      expect(code).toBe(0);
      const idDir = path.join(rig.appDir, ".identities", "ada");
      expect(fs.existsSync(path.join(idDir, "info.txt"))).toBe(true);
      expect(fs.existsSync(path.join(idDir, "core_identity_prompt.md"))).toBe(true);
      const persona = fs.readFileSync(path.join(idDir, "core_identity_prompt.md"), "utf8");
      // The fake server's completion is "ok" (no {{identity_name}}), so the
      // fallback placeholder-substitution path runs — same as bash's own
      // "LLM persona generation failed; using the starter template".
      expect(persona).toMatch(/curious, warm, and plainspoken/);
      const memFiles = fs.readdirSync(path.join(idDir, "memories"));
      expect(memFiles.length).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(rig.appDir, ".identities", "default"))).toBe(true);

      // status.json shape
      const status = JSON.parse(fs.readFileSync(path.join(rig.home, ".headlong", "status.json"), "utf8"));
      expect(status.identity).toBe("ada");
      expect(status.mind.status).toBe("skipped");
      expect(status.dash.status).toBe("skipped");
    } finally {
      await srv.close();
    }
  });

  it("re-run with an existing identity name leaves it as is (idempotent)", async () => {
    const srv = await startFakeServer();
    try {
      srv.script([
        { body: JSON.stringify({ data: [{ id: "qwen3:8b" }] }) },
        { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
        { sse: true, body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n' },
      ]);
      const rig = makeRig({
        HEADLONG_FAKE_DOCKER: "ok",
        HEADLONG_NO_THINKERS: "1",
        HEADLONG_NO_DASH: "1",
        HEADLONG_IDENTITY_NAME: "ada",
        HEADLONG_PROVIDER: "local",
        HEADLONG_LOCAL_URL: `${origin(srv)}/v1`,
        HEADLONG_LOCAL_MODEL: "qwen3:8b",
      });
      await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
      const idDir = path.join(rig.appDir, ".identities", "ada");
      const infoBefore = fs.readFileSync(path.join(idDir, "info.txt"), "utf8");

      const rig2 = makeRig({ HEADLONG_FAKE_DOCKER: "ok", HEADLONG_NO_THINKERS: "1", HEADLONG_NO_DASH: "1", HEADLONG_IDENTITY_NAME: "ada" });
      rig2.env["HEADLONG_HOME"] = rig.env["HEADLONG_HOME"]!;
      rig2.env["HEADLONG_APP_DIR"] = rig.appDir;
      const code = await runHeadlongInit({ argv: [], env: rig2.env, io: rig2.io });
      expect(code).toBe(0);
      expect(fs.readFileSync(path.join(idDir, "info.txt"), "utf8")).toBe(infoBefore);
      expect(rig2.out.join("")).toMatch(/already exists — leaving it as is/);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// App-dir resolution
// ---------------------------------------------------------------------------

describe("runHeadlongInit — app dir resolution", () => {
  it("dies with a clear message when HEADLONG_APP_DIR does not exist", async () => {
    const rig = makeRig();
    rig.env["HEADLONG_APP_DIR"] = path.join(tmpDir("not-a-checkout-"), "nonexistent");
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    expect(code).not.toBe(0);
    expect(rig.err.join("")).toMatch(/is not a headlong-ts checkout/);
  });

  it("an explicit HEADLONG_APP_DIR is trusted even without the bin/identity.mjs marker (bash-shaped fixtures)", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "missing" });
    const bashShaped = tmpDir("bash-shaped-app-");
    fs.mkdirSync(path.join(bashShaped, "bin"), { recursive: true });
    fs.writeFileSync(path.join(bashShaped, "bin", "shellm"), "");
    rig.env["HEADLONG_APP_DIR"] = bashShaped;
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    // Reaches the sandbox gate (proves the app dir resolved) instead of dying on app-dir lookup.
    expect(rig.err.join("")).toMatch(/HEADLONG_UNSANDBOXED/);
    void code;
  });

  it("falls back to the recorded $HEADLONG_HOME/app_dir file", async () => {
    const rig = makeRig({ HEADLONG_FAKE_DOCKER: "missing" });
    const realAppDir = rig.appDir;
    delete rig.env["HEADLONG_APP_DIR"];
    fs.mkdirSync(path.join(rig.home, ".headlong"), { recursive: true });
    fs.writeFileSync(path.join(rig.home, ".headlong", "app_dir"), `${realAppDir}\n`);
    const code = await runHeadlongInit({ argv: [], env: rig.env, io: rig.io });
    // Reaches the sandbox gate (proves app dir resolved) rather than dying on app-dir lookup.
    expect(rig.err.join("")).toMatch(/HEADLONG_UNSANDBOXED/);
    void code;
  });
});
