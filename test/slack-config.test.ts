// slack-config.test.ts — port of headlong/slack/tests/test_config.py.
// Identity selection: the env var, then the `default` symlink, then an error.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "../src/slack/config.ts";
import { BridgeExit } from "../src/slack/errors.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sl-config-"));
}

function identity(root: string, name: string): string {
  const d = path.join(root, ".identities", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "info.txt"), "an identity\n");
  return d;
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
  };
}

describe("slack config", () => {
  it("falls back to the default symlink", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    expect(config.load(tmp, baseEnv()).identity).toBe("ada");
  });

  it("follows only the immediate link", () => {
    // The default's own target is the name `identity default` recorded, and
    // the one persona reports — `resolve()` would walk past it to the end of
    // the chain and return a name no one configured.
    //
    // The chained identity here is the fixture that tells the two apart, not
    // an endorsement: a symlinked identity dir is invisible to the web scan,
    // so its messages 404 however the name was chosen (upstream #66).
    const tmp = tmpDir();
    const elsewhere = path.join(tmp, "elsewhere", "current");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "info.txt"), "an identity\n");
    const identities = path.join(tmp, ".identities");
    fs.mkdirSync(identities);
    fs.symlinkSync(elsewhere, path.join(identities, "ada"));
    fs.symlinkSync("ada", path.join(identities, "default"));

    expect(config.load(tmp, baseEnv()).identity).toBe("ada");
  });

  it("env var wins over the default symlink", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    identity(tmp, "bo");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    const env = { ...baseEnv(), HEADLONG_SLACK_IDENTITY: "bo" };
    expect(config.load(tmp, env).identity).toBe("bo");
  });

  it("no var and no default names the variable", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");

    expect(() => config.load(tmp, baseEnv())).toThrow(BridgeExit);
    try {
      config.load(tmp, baseEnv());
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeExit).message).toContain("HEADLONG_SLACK_IDENTITY");
    }
  });

  it("a dangling default link names the link", () => {
    // A broken default must not surface as "identity not found ... identity
    // new <name>" — that advice creates a second identity instead of fixing
    // the link.
    const tmp = tmpDir();
    fs.mkdirSync(path.join(tmp, ".identities"));
    fs.symlinkSync("ghost", path.join(tmp, ".identities", "default"));

    try {
      config.load(tmp, baseEnv());
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeExit).message).toContain("default identity link");
      expect((e as BridgeExit).message).toContain("ghost");
    }
  });

  // -- supplemental (no upstream case, but exercised by the harness) --------

  it("SLACK_THREAD_FOLLOWUPS: unset or '0' is false, anything else true", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    expect(config.load(tmp, baseEnv()).threadFollowups).toBe(false);
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_FOLLOWUPS: "0" }).threadFollowups).toBe(false);
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_FOLLOWUPS: "1" }).threadFollowups).toBe(true);
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_FOLLOWUPS: "yes" }).threadFollowups).toBe(true);
  });

  it("SLACK_CLI_XOXB/XAPP are honored as fallbacks for the bot/app tokens", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    const cfg = config.load(tmp, { SLACK_CLI_XOXB: "xoxb-cli", SLACK_CLI_XAPP: "xapp-cli" });
    expect(cfg.botToken).toBe("xoxb-cli");
    expect(cfg.appToken).toBe("xapp-cli");
  });

  it("missing tokens dies with a combined message", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    try {
      config.load(tmp, {});
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeExit).message).toContain("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
    }
  });

  // -- SLACK_THREAD_JOIN_BACKFILL (1c: 48a706c) ------------------------------

  it("SLACK_THREAD_JOIN_BACKFILL defaults to 20", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));
    expect(config.load(tmp, baseEnv()).threadJoinBackfill).toBe(20);
  });

  it("SLACK_THREAD_JOIN_BACKFILL=0 disables backfill", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_JOIN_BACKFILL: "0" }).threadJoinBackfill).toBe(0);
  });

  it("SLACK_THREAD_JOIN_BACKFILL clamps to 50", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_JOIN_BACKFILL: "999" }).threadJoinBackfill).toBe(50);
  });

  it("SLACK_THREAD_JOIN_BACKFILL falls back to 20 on garbage", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));
    expect(config.load(tmp, { ...baseEnv(), SLACK_THREAD_JOIN_BACKFILL: "nope" }).threadJoinBackfill).toBe(20);
  });

  it("identityApiId replaces / with ~", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    const cfg = config.load(tmp, baseEnv());
    expect(config.identityApiId(cfg)).toBe(".identities~ada");
  });

  // ---- port of slack/tests/test_peers.py (config section)
  it("SLACK_PEER_BOT_USERS: parsed, junk ignored", () => {
    const env = { SLACK_PEER_BOT_USERS: " U0C2G1517EC, B0C15LE90KH;harris ,U0BN5FSURBN,,u0lower" };
    expect([...config.peerBotUsers(env)].sort()).toEqual(["U0BN5FSURBN", "U0C2G1517EC"]);
  });

  it("SLACK_PEER_BOT_USERS defaults to empty", () => {
    expect(config.peerBotUsers({}).size).toBe(0);
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));
    const c = config.load(tmp, baseEnv());
    expect(c.peerBotUsers.size).toBe(0);
    expect([c.peerMaxTurns, c.peerHourlyCap]).toEqual([4, 30]);
  });

  it("int_env defaults and clamps", () => {
    expect(config.intEnv({}, "SLACK_PEER_MAX_TURNS", 4, 0, 50)).toBe(4);
    expect(config.intEnv({ SLACK_PEER_MAX_TURNS: "999" }, "SLACK_PEER_MAX_TURNS", 4, 0, 50)).toBe(50);
    expect(config.intEnv({ SLACK_PEER_MAX_TURNS: "nope" }, "SLACK_PEER_MAX_TURNS", 4, 0, 50)).toBe(4);
    expect(config.intEnv({ SLACK_PEER_MAX_TURNS: "-3" }, "SLACK_PEER_MAX_TURNS", 4, 0, 50)).toBe(0);
  });
});
