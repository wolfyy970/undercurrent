// llmSharedGroup.test.ts — `_LLM_SHARED_PROCESS_GROUP=1` (upstream sync 2e39a3f, 2a63d92):
// the adapter stays in the caller's process group and killGroup cancels THAT group.
// Real processes: a group-leader helper runs spawnAdapterProcess with sharedGroup, then
// force-closes the group; the adapter AND the helper must both be gone.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/llmAdapterProcess.ts");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runHelper(shared: boolean): Promise<{ helper: number; adapter: number; adapterPgid: number; helperPgid: number }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-shared-"));
  const adapter = path.join(tmp, "adapter.sh");
  fs.writeFileSync(adapter, `#!/bin/sh\necho $$ > "${tmp}/adapter.pid"\nexec sleep 30\n`, { mode: 0o755 });
  const script = `
    import { spawnAdapterProcess } from ${JSON.stringify(SRC)};
    import { execFileSync } from "node:child_process";
    import fs from "node:fs";
    const h = spawnAdapterProcess(${JSON.stringify(adapter)}, [], { cwd: ${JSON.stringify(tmp)}, env: process.env, sharedGroup: ${shared}, deadline: true });
    await new Promise((r) => setTimeout(r, 600));
    const pg = (p) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(p)], { encoding: "utf8" }).trim());
    const ap = Number(fs.readFileSync(${JSON.stringify(tmp)} + "/adapter.pid", "utf8"));
    fs.writeFileSync(${JSON.stringify(tmp)} + "/info.json", JSON.stringify({ helper: process.pid, adapter: ap, adapterPgid: pg(ap), helperPgid: pg(process.pid) }));
    h.killGroup("SIGKILL");
    await new Promise((r) => setTimeout(r, 5000));
  `;
  // The helper is its own group leader, like mem search's worker.
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: true, stdio: "ignore" });
  return (async () => {
    const info = path.join(tmp, "info.json");
    for (let i = 0; i < 100 && !fs.existsSync(info); i++) await sleep(50);
    const parsed = JSON.parse(fs.readFileSync(info, "utf8"));
    await sleep(300);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return parsed;
  })();
}

describe("spawnAdapterProcess sharedGroup", () => {
  it("shared: the adapter stays in the caller's group and killGroup takes the caller down too", async () => {
    const r = await runHelper(true);
    expect(r.adapterPgid).toBe(r.helperPgid);
    await sleep(200);
    expect(alive(r.adapter)).toBe(false);
    expect(alive(r.helper)).toBe(false);
  }, 20000);
  it("default: the adapter leads its own group", async () => {
    const r = await runHelper(false);
    expect(r.adapterPgid).not.toBe(r.helperPgid);
    expect(r.adapterPgid).toBe(r.adapter);
    await sleep(200);
    expect(alive(r.adapter)).toBe(false); // its own group was killed
    expect(alive(r.helper)).toBe(false); // helper was cleaned up by the test
  }, 20000);
});
