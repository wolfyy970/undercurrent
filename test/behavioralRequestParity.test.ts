// behavioralRequestParity.test.ts — runs parity/behavioral/run-parity.mjs: upstream's REAL thinkers/monolith/step
// (Bash + bin/shellm + bin/llm) vs the port, against one recording stub endpoint, for a fresh wake and a second wake in
// the same run. Skips cleanly unless PARITY_UPSTREAM_ROOT points at an upstream checkout (pin 2e39a3f) and bash/jq/curl exist.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const upstream = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
const have = upstream !== "" && fs.existsSync(path.join(upstream, "thinkers/monolith/step"));
const bashOk = spawnSync("bash", ["-c", "[[ ${BASH_VERSINFO[0]} -ge 4 ]] && command -v jq curl >/dev/null"]).status === 0;

describe.skipIf(!have || !bashOk)("assembled monolith request: upstream Bash vs port", () => {
  it("system prompt, message shape, request flags and task-message structure match for a fresh wake and a second wake", () => {
    const r = spawnSync(process.execPath, [path.resolve(HERE, "../parity/behavioral/run-parity.mjs")], {
      env: { ...process.env, PARITY_UPSTREAM_ROOT: upstream },
      encoding: "utf8",
      timeout: 170_000,
    });
    expect(r.stdout + r.stderr).toMatch(/Result: \d+\/\d+ PARITY, \d+ DEVIATION \(documented\), 0 DIVERGE/);
    expect(r.status).toBe(0);
  }, 180_000);
});
