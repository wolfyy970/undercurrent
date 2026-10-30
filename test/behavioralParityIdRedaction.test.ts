// A random uuid is ~0.8% likely to look like a payment card to the wake-prompt redaction (three all-digit 4-char
// segments: `[0-9]{4}(?:[ -][0-9]{4}){2,3}`), in BOTH engines identically (port src/promptRedact.ts:36 ⇄ upstream
// thinkers/_lib/common.sh:822). The behavioral harness compares two runs with DIFFERENT random ids, so one engine
// occasionally showed `abcdef12-<redacted:card>-aabbccddeeff` where the other showed a plain id. This pins (a) that
// the two engines redact such an id identically and (b) that the harness's id mask absorbs the redaction marker.
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promptRedact } from "../src/promptRedact.ts";
// plain .mjs helper shared with parity/behavioral/run-parity.mjs (typed by inference: tsconfig allowJs)
import { maskIds } from "../parity/behavioral/normId.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UP = process.env["PARITY_UPSTREAM_ROOT"] ?? "";
const cardLike = "abcdef12-1111-2222-3333-aabbccddeeff";
const plain = "abcdef12-a111-2222-3333-aabbccddeeff";
const line = (u: string) => `{"type":"final","run_id":"${u}","step_id":"${u}","details":"traj tail -n 400 --filter run_id=${u}"}`;
const jqOk = spawnSync("bash", ["-c", "command -v jq"]).status === 0;

describe("ids that look like a card number", () => {
  it("the harness mask turns a card-redacted id and a plain id into the same <ID>", () => {
    const masked = maskIds(promptRedact(line(cardLike), {}));
    expect(masked).toBe(maskIds(promptRedact(line(plain), {})));
    expect(masked).toBe('{"type":"final","run_id":"<ID>","step_id":"<ID>","details":"traj tail -n 400 --filter run_id=<ID>"}');
  });
  it.skipIf(!UP || !jqOk)("the port redacts a card-like id exactly as upstream's prompt_redact does", () => {
    for (const u of [cardLike, plain]) {
      const r = spawnSync("bash", ["-c", `source "${UP}/thinkers/_lib/common.sh" 2>/dev/null; prompt_redact "$1"`, "_", line(u)], { encoding: "utf8", cwd: HERE });
      expect(promptRedact(line(u), {})).toBe(r.stdout);
    }
    expect(promptRedact(line(cardLike), {})).toContain("<redacted:card>");
  });
});
