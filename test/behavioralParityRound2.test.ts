// Behavioral parity round 2 (real-model re-run, B6): the in-process buildContext
// must render a step's fields in jq `keys` (alphabetical) order, as upstream's
// bin/context does (`$row2 | keys | map(select(is_meta(.) | not))`, bin/context:334).
// A shell-output row (written stdout,stderr,exit,run_id,exec_s) therefore reaches
// the model as [exec_s] .. [exit] .. [stdout], not in insertion order.
import { describe, it, expect } from "vitest";
import { buildContext, MONOLITH_CONTEXT_OPTS } from "../src/context.js";

describe("B6: buildContext field order matches upstream bin/context (jq keys, sorted)", () => {
  it("renders a shell-output row as exec_s, exit, stdout", () => {
    const steps = [
      { type: "prompt", step_id: "p1", content: "go" },
      { type: "shell-output", step_id: "s1", stdout: "hi", stderr: "", exit: 0, run_id: "r", exec_s: 3 },
    ];
    const msgs = buildContext(steps, MONOLITH_CONTEXT_OPTS);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("[exec_s]\n3\n\n[exit]\n0\n\n[stdout]\nhi");
  });
  it("keeps stdout and stderr alphabetical too (exit, stderr, stdout)", () => {
    const steps = [
      { type: "prompt", step_id: "p1", content: "go" },
      { type: "shell-output", step_id: "s1", stdout: "o", stderr: "e", exit: 1 },
    ];
    const msgs = buildContext(steps, MONOLITH_CONTEXT_OPTS);
    expect(msgs[msgs.length - 1]!.content).toContain("[exit]\n1\n\n[stderr]\ne\n\n[stdout]\no");
  });
});

// B7: upstream assembles the system prompt from `$(identity prompt)` and `$(skills prompt)`
// (thinkers/_lib/common.sh:_build_system_prompt, :281-282, :288-292). Bash command
// substitution strips trailing newlines, so the text pieces carry none. The port kept
// the file's trailing "\n", producing an extra blank line before "## Skills" and after the list.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { identityNew } from "../src/identity.ts";
import { resolveIdentityEnv } from "../src/identity-env.ts";
import { buildIdentityConfig } from "../src/steprun.ts";

describe("B7: identity/skills prompt pieces have no trailing newline (bash $(...) semantics)", () => {
  it("identityText and skillsText do not end with a newline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-b7-"));
    try {
      const result = identityNew({ identitiesRoot: root, name: "pax" });
      fs.writeFileSync(path.join(result.identityDir, "core_identity_prompt.md"), "I am {{identity_name}}.\nsecond line.\n");
      const env = resolveIdentityEnv(result.identityDir, { base: process.env as Record<string, string> });
      env["SHELLM_SANDBOX"] = "local";
      const id = buildIdentityConfig({ env });
      expect(id.identityText.endsWith("\n")).toBe(false);
      expect(id.skillsText.endsWith("\n")).toBe(false);
      expect(id.identityText).toBe("I am pax.\nsecond line.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
