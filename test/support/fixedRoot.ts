// fixedRoot.ts — claim a fixed /tmp/uc-rec-* test root for this test only.
//
// Recorded replies can name prompt-visible paths, so those tests run under fixed roots (/tmp/uc-rec-<name>). Fixed
// roots are shared by every checkout on the machine: two suites running at once (another clone of this repo, a
// second vitest) would wipe each other's root mid-test (seen as ENOENT on run/monolith.wake_at in topology trace-01).
// claimFixedRoot takes a cross-process lock on the root's top directory (an mkdir lock holding the owner's pid),
// waits while a live process holds it, takes over a lock whose owner is dead, then empties and recreates the root.
// The lock is released when the current test finishes (or when this process exits); the same process may re-claim
// it (tests in one file run one after another).
import * as fs from "node:fs";
import * as path from "node:path";
// vitest is loaded only when present in the runner: plain-node parity harnesses (parity/behavioral) import this file
// too, and there "vitest" cannot be imported; they hold a root for the whole process (holdFixedRoot).
let onTestFinished: ((fn: () => void) => void) | undefined;
try {
  ({ onTestFinished } = await import("vitest"));
} catch {
  onTestFinished = undefined;
}

const held = new Set<string>();
const pinned = new Set<string>(); // locks held for a whole file by holdFixedRoot: per-test release skips them
process.on("exit", () => {
  for (const l of held) fs.rmSync(l, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The lock directory for a root: `/tmp/uc-rec-<name>.lock` (for any path under /tmp/uc-rec-<name>). */
export function lockDirFor(root: string): string {
  const m = /^(\/tmp\/uc-rec-[^/]+)/.exec(root);
  return `${m ? m[1] : root.replace(/\/+$/, "")}.lock`;
}

export function claimFixedRoot(root: string, timeoutMs = 180_000): string {
  const lock = lockDirFor(root);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = NaN;
      try {
        owner = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
      } catch {
        /* being written or removed: retry below */
      }
      if (owner === process.pid) break; // re-entrant within this process
      if (Number.isFinite(owner) && owner > 0 && !alive(owner)) {
        fs.rmSync(lock, { recursive: true, force: true }); // owner died holding it
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`claimFixedRoot: ${lock} still held by pid ${owner}`);
      sleep(50);
    }
  }
  held.add(lock);
  try {
    if (!onTestFinished) throw new Error("not under vitest");
    onTestFinished(() => {
      if (pinned.has(lock)) return;
      held.delete(lock);
      fs.rmSync(lock, { recursive: true, force: true });
    });
  } catch {
    /* not inside a test: released at process exit */
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Hold a fixed root's lock for a whole file (call from `beforeAll`, release with the returned function in
 * `afterAll`). Unlike claimFixedRoot it waits on a filesystem event for the lock's removal, not a poll, so a file
 * whose recorded replies name the root literally can queue behind another suite without sleeping. claimFixedRoot
 * inside its tests then re-enters (same pid) and only empties the root.
 */
export async function holdFixedRoot(root: string): Promise<() => void> {
  const lock = lockDirFor(root);
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let owner = NaN;
    try {
      owner = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
    } catch {
      /* the owner is between its mkdir and its pid write */
    }
    if (owner === process.pid) break;
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    // Wake on the lock's removal (a filesystem event), or when its owner dies without removing it: a SIGKILLed owner
    // leaves the lock behind and no event follows, so its liveness is checked once a second (the loop then takes over).
    await new Promise<void>((resolve) => {
      const done = () => {
        w.close();
        clearInterval(t);
        resolve();
      };
      const w = fs.watch(path.dirname(lock), () => {
        if (!fs.existsSync(lock)) done();
      });
      const t = setInterval(() => {
        if (!fs.existsSync(lock) || (Number.isInteger(owner) && owner > 0 && !alive(owner))) done();
      }, 1000);
      if (!fs.existsSync(lock)) done();
    });
  }
  held.add(lock);
  pinned.add(lock);
  return () => {
    pinned.delete(lock);
    held.delete(lock);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  };
}
