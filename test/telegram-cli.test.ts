// telegram-cli.test.ts — no upstream Python test file exists for
// headlong_telegram.cli (cli.py has no test_cli.py upstream). These cases
// cover the argument-parsing and pre-network error paths directly; the
// happy path (a real getMe/getUpdates/sendMessage round trip) is covered by
// parity/telegram/run-parity.mjs against a fake Telegram Bot API server,
// not here — this file never reaches the network.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli, type CliIO } from "../src/telegram/cli.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));
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

describe("telegram cli", () => {
  it("--help prints usage and exits 0", async () => {
    const io = makeIo();
    const rc = await runCli(["--help"], io);
    expect(rc).toBe(0);
    expect(io.out).toContain("headlong-telegram-bridge");
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
    const io = makeIo({ env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ADMIN_ID: "1" } });
    const rc = await runCli([path.join(io.cwd, "nope")], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("Not a directory");
  });

  it("missing TELEGRAM_BOT_TOKEN dies with config's message", async () => {
    const io = makeIo({ env: {} });
    const rc = await runCli([], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("TELEGRAM_BOT_TOKEN is required");
  });

  it("missing TELEGRAM_ADMIN_ID dies with config's message", async () => {
    const io = makeIo({ env: { TELEGRAM_BOT_TOKEN: "t" } });
    const rc = await runCli([], io);
    expect(rc).toBe(1);
    expect(io.err).toContain("TELEGRAM_ADMIN_ID is required");
  });

  it("loads .env from cwd without overriding an already-exported var", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".env"), "TELEGRAM_BOT_TOKEN=from-dotenv\n");
    const io = makeIo({ cwd, env: { TELEGRAM_ADMIN_ID: "not-digits" } });
    const rc = await runCli([], io);
    // Reaches config.load's admin-id check, proving TELEGRAM_BOT_TOKEN was
    // picked up from .env (an earlier die would report the token instead).
    expect(rc).toBe(1);
    expect(io.err).toContain("TELEGRAM_ADMIN_ID is required");
  });

  it("an already-exported var wins over .env", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".env"), "TELEGRAM_ADMIN_ID=999\n");
    const io = makeIo({ cwd, env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ADMIN_ID: "not-digits" } });
    const rc = await runCli([], io);
    // The exported (invalid) value must win over .env's valid one.
    expect(rc).toBe(1);
    expect(io.err).toContain("TELEGRAM_ADMIN_ID is required");
  });
});
