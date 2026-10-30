// behavioralParityB2.test.ts — B2 of the behavioral parity round: THINK_CONTEXT_TAIL.
// Oracle: tools/identity:414,1424 (`export THINK_CONTEXT_TAIL="${THINK_CONTEXT_TAIL:-30}"`, so a real
// upstream mind runs with 30), thinkers/responder/step:22,232 and thinkers/monolith/step:37,189
// (both step scripts read the env, default 20).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveIdentityEnv } from "../src/identity-env.ts";

function idDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behav-b2-"));
  const dir = path.join(root, "pax");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "info.txt"), "name=pax\nroot_trajectory=t\n");
  return dir;
}

describe("B2: THINK_CONTEXT_TAIL in the identity env", () => {
  it("defaults to 30 like `identity shell` (tools/identity:414)", () => {
    const dir = idDir();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "behav-b2-home-"));
    const env = resolveIdentityEnv(dir, { base: { PATH: "/usr/bin" }, home, headlongHome: path.join(home, ".headlong") });
    expect(env["THINK_CONTEXT_TAIL"]).toBe("30");
  });
  it("keeps a value the caller already set (`${THINK_CONTEXT_TAIL:-30}`)", () => {
    const dir = idDir();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "behav-b2-home-"));
    const env = resolveIdentityEnv(dir, { base: { PATH: "/usr/bin", THINK_CONTEXT_TAIL: "12" }, home, headlongHome: path.join(home, ".headlong") });
    expect(env["THINK_CONTEXT_TAIL"]).toBe("12");
  });
});
