// shellmPrompt.test.ts — upstream sync 2e39a3f: the default system prompt teaches
// bash fences without repeating the forbidden tool-call tags (Qwen/MiMo then
// copy them). Oracle: upstream's own tests/test_shellm_prompt_markup.sh, whose
// exact assertions are applied here to the port's prompt asset.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const asset = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/assets/shellm-system-prompt.txt");
const prompt = fs.readFileSync(asset, "utf8");

describe("default shellm system prompt", () => {
  for (const instruction of ["exactly ONE ```bash code block", "opening ```bash fence MUST start on its OWN new line"]) {
    it(`retains: ${instruction}`, () => {
      expect(prompt).toContain(instruction);
    });
  }
  for (const tag of ["<tool_call>", "<function=bash>", "<parameter=", "<bash>"]) {
    it(`omits forbidden markup: ${tag}`, () => {
      expect(prompt).not.toContain(tag);
    });
  }
});
