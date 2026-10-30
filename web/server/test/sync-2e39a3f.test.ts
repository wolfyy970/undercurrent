// sync-2e39a3f.test.ts — lane (j): the web control plane changes between the
// old pin (5458fee) and 2e39a3f: a linked identities root is walked
// (2d0919e), the push watcher recovers after a trajectory shrink (089da9b),
// thinker-sync copies use unique temp files (f1a6e96). Mirrors the upstream
// web/tests additions (test_discovery_symlinks.py, test_push_api.py,
// test_thinker_sync.py).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { scanIdentities, resolveIdentity } from "../src/discovery.ts";
import { atomicCopy } from "../src/thinker-sync.ts";
import { addSubscription, vapidPublicKey, startPushWatcher } from "../src/push.ts";
import { decryptAes128gcm } from "../src/webpushCrypto.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-sync-")));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function identity(dir: string, name: string): string {
  fs.mkdirSync(path.join(dir, "trajectories", "abcd1234-root"), { recursive: true });
  fs.writeFileSync(path.join(dir, "info.txt"), `name=${name}\ncreated=2026-01-01T00:00:00\nroot_trajectory=abcd1234-0000-0000-0000-000000000000\n`);
  fs.writeFileSync(path.join(dir, "trajectories", "abcd1234-root", "trajectory.jsonl"), "");
  return dir;
}
const ids = (root: string) => scanIdentities(root).map((i) => i.id);

describe("discovery: a linked identities root (2d0919e)", () => {
  it("is walked; links inside it stay candidates, never recursed", () => {
    const t = tmp();
    const root = path.join(t, "root");
    fs.mkdirSync(root);
    const realRoot = path.join(t, "var-lib", "identities");
    identity(path.join(realRoot, "harris"), "harris");
    fs.symlinkSync("harris", path.join(realRoot, "default"));
    fs.symlinkSync(realRoot, path.join(root, ".identities"));
    const deep = path.join(t, "elsewhere", "deep");
    identity(path.join(deep, "nested", "hidden"), "hidden");
    fs.symlinkSync(deep, path.join(realRoot, "trap"));

    const found = ids(root);
    expect(found).toContain(".identities~harris");
    expect(found.filter((i) => i === ".identities~harris")).toHaveLength(1);
    expect(found).not.toContain(".identities~default");
    expect(found.some((i) => i.includes("hidden"))).toBe(false);
    expect(resolveIdentity(root, ".identities~harris").path).toBe(path.join(root, ".identities", "harris"));
    expect(resolveIdentity(root, ".identities~default").id).toBe(".identities~harris");
  });

  it("a linked root that is itself an identity stays a candidate", () => {
    const t = tmp();
    const root = path.join(t, "root");
    fs.mkdirSync(root);
    const lone = identity(path.join(t, "solo"), "solo");
    fs.symlinkSync(lone, path.join(root, ".identities"));
    expect(ids(root)).toContain(".identities");
  });

  it("a link with another name directly under the root is still never walked", () => {
    const t = tmp();
    const root = path.join(t, "root");
    fs.mkdirSync(root);
    const other = path.join(t, "other");
    identity(path.join(other, "nested", "x"), "x");
    fs.symlinkSync(other, path.join(root, "stuff"));
    expect(ids(root)).toEqual([]);
  });
});

describe("push watcher: recovers after a trajectory shrink (089da9b)", () => {
  const line = (content: string) => JSON.stringify({ type: "message", to: "pwa-nick", from: "pushy", content }) + "\n";
  it.each([["an empty log", ""], ["a log holding one old line", line("old")]])(
    "%s neither replays history nor strands the cursor",
    async (_n, replacement) => {
      const root = tmp();
      const traj = path.join(identity(path.join(root, "pushy"), "pushy"), "trajectories", "abcd1234-root", "trajectory.jsonl");
      fs.writeFileSync(traj, line("a long line of old history to shrink away from"));
      vapidPublicKey(root);
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const auth = crypto.randomBytes(16);
      addSubscription(root, "pwa-nick", {
        endpoint: "https://push.example.com/x",
        keys: {
          p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
          auth: auth.toString("base64url"),
        },
      });
      const bodies: string[] = [];
      const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
        const payload = JSON.parse(decryptAes128gcm(Buffer.from(init!.body as Uint8Array), privateKey, auth).toString("utf-8"));
        bodies.push(payload.body);
        return new Response(null, { status: 201 });
      }) as typeof fetch;
      const watcher = startPushWatcher(root, { fetchImpl, pollMs: 100000 });
      cleanups.push(() => watcher.stop());
      await watcher.tick(); // cursor at EOF of the long line
      fs.writeFileSync(traj, replacement);
      await watcher.tick(); // size < offset: reset to the new EOF, push nothing
      expect(bodies).toEqual([]);
      fs.appendFileSync(traj, line("new"));
      await watcher.tick();
      await watcher.tick();
      expect(bodies).toEqual(["new"]);
    },
  );
});

describe("thinker-sync atomicCopy (f1a6e96)", () => {
  it("copies with a mode, leaves no temp files, and cleans up when the rename fails", () => {
    const t = tmp();
    const src = path.join(t, "source.md");
    fs.writeFileSync(src, "new content");
    const dest = path.join(t, "installed", "prompt.md");
    atomicCopy(src, dest);
    expect(fs.readFileSync(dest, "utf8")).toBe("new content");
    expect(fs.statSync(dest).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes(".sync-tmp"))).toEqual([]);

    const exe = path.join(t, "step");
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    atomicCopy(exe, path.join(t, "installed", "step"));
    expect(fs.statSync(path.join(t, "installed", "step")).mode & 0o111).not.toBe(0);

    // rename onto a non-empty directory fails: the original is untouched, no temp left
    const blocked = path.join(t, "installed", "blocked");
    fs.mkdirSync(path.join(blocked, "x"), { recursive: true });
    expect(() => atomicCopy(src, blocked)).toThrow();
    expect(fs.readdirSync(path.dirname(blocked)).filter((n) => n.includes(".sync-tmp"))).toEqual([]);
  });
});
