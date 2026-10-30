// telegram-config.test.ts — port of headlong/telegram/tests/test_config.py.
// Identity selection: the env var, then the `default` symlink, then an error.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "../src/telegram/config.ts";
import { BridgeExit } from "../src/telegram/errors.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-config-"));
}

function identity(root: string, name: string): string {
  const d = path.join(root, ".identities", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "info.txt"), "an identity\n");
  return d;
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: "123:test",
    TELEGRAM_ADMIN_ID: "1",
  };
}

describe("telegram config", () => {
  it("falls back to the default symlink", () => {
    const tmp = tmpDir();
    identity(tmp, "ada");
    fs.symlinkSync("ada", path.join(tmp, ".identities", "default"));

    expect(config.load(tmp, baseEnv()).identity).toBe("ada");
  });

  it("follows only the immediate link", () => {
    // The default's own target is the name `identity default` recorded, and
    // the one persona reports — following the whole chain would return a
    // name no one configured. The chained identity here is the fixture that
    // tells the two apart, not an endorsement: a symlinked identity dir is
    // invisible to the web scan, so its messages 404 however the name was
    // chosen (upstream #66).
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

    const env = { ...baseEnv(), HEADLONG_TELEGRAM_IDENTITY: "bo" };
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
      expect((e as BridgeExit).message).toContain("HEADLONG_TELEGRAM_IDENTITY");
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
});
