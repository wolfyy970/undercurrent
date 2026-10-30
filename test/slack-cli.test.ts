// slack-cli.test.ts — no upstream Python test file exists for
// headlong_slack.cli (cli.py has no test_cli.py upstream). These cases cover
// the argument-parsing and pre-network error paths directly; the network
// happy path (auth.test/apps.connections.open/Socket Mode/chat.postMessage)
// is covered by parity/slack/run-parity.mjs against a fake Slack Web API
// server, not here — this file never reaches the network.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli, type CliIO } from "../src/slack/cli.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sl-cli-"));
}

function makeIo(overrides: Partial<CliIO> = {}): CliIO & { out: string; err: string } {
  const io = {
    cwd: overrides.cwd ?? tmpDir(),
    // Always pin HEADLONG_HOME to an empty scratch dir unless the caller
    // overrides it: without this, cli.ts's `.env` layering would fall back
    // to the real machine's ~/.headlong/.env and make these tests read
    // ambient, possibly secret, local state.
    env: { HEADLONG_HOME: tmpDir(), ...(overrides.env ?? {}) },
    out: "",
    err: "",
    stdout(s: string) {
      io.out += s;
    },
    stderr(s: string) {
      io.err += s;
    },
  };
  return io;
}

describe("slack cli", () => {
  it("--help prints usage and exits 0", async () => {
    const io = makeIo();
    const rc = await runCli(["--help"], io);
    expect(rc).toBe(0);
    expect(io.out).toContain("headlong-slack-bridge");
    expect(io.err).toBe("");
  });

  it("-h is the same as --help", async () => {
    const io = makeIo();
    const rc = await runCli(["-h"], io);
    expect(rc).toBe(0);
    expect(io.out).toContain("usage:");
  });

  it("unrecognized extra argument exits 2", async () => {
    const io = makeIo();
    const rc = await runCli(["root1", "root2"], io);
    expect(rc).toBe(2);
    expect(io.err).toContain("unrecognized arguments");
  });

  it("a non-directory root exits 1", async () => {
    const io = makeIo({ env: { SLACK_BOT_TOKEN: "t", SLACK_APP_TOKEN: "t" } });
    const rc = await runCli([path.join(io.cwd, "nope")], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("Not a directory");
  });

  it("missing SLACK_BOT_TOKEN/SLACK_APP_TOKEN dies with config's message", async () => {
    const io = makeIo({ env: {} });
    const rc = await runCli([], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
  });

  it("no identity and no default dies with config's message", async () => {
    const io = makeIo({ env: { SLACK_BOT_TOKEN: "t", SLACK_APP_TOKEN: "t" } });
    const rc = await runCli([], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("HEADLONG_SLACK_IDENTITY");
  });

  it("loads .env from cwd without overriding an already-exported var", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".env"), "SLACK_BOT_TOKEN=from-dotenv\n");
    const io = makeIo({ cwd, env: { SLACK_APP_TOKEN: "t" } });
    const rc = await runCli([], io);
    // Reaches config.load's identity-resolution die, proving SLACK_BOT_TOKEN
    // was picked up from .env (a missing-token die would report that instead).
    expect(rc).toBe(1);
    expect(io.err).toContain("HEADLONG_SLACK_IDENTITY");
  });

  it("an already-exported var wins over .env", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".env"), "SLACK_BOT_TOKEN=from-dotenv\n");
    const io = makeIo({ cwd, env: { SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "t" } });
    const rc = await runCli([], io);
    // An empty (but present) exported value still counts as "already set" in
    // loadEnvFile's `env[key] !== undefined` check, so .env's value must NOT
    // win — config.load then dies on the empty token, not on identity.
    expect(rc).toBe(1);
    expect(io.err).toContain("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
  });
});
