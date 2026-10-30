// prompts.ts — prompt assembly (SPEC §1.7 Appendix A, §4.2, §5).
//
// The shellm system prompt (A) is loaded VERBATIM from assets/ (copied byte-for-
// byte from bin/shellm:1552-1647). It is the in-context contract the model is
// trained against; SPEC §1.7 requires porting it verbatim. The monolith does not
// override it (no -s), so the model receives it as the system layer.
//
// The monolith wake prompt (the user/task layer) is assembled in monolith.ts
// from the system-prompt block + recent stream + routing hints + prompt.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");

/**
 * The static text of upstream's shellm system prompt at the 2e39a3f pin (bin/shellm build_system_prompt), with the
 * two placeholders src/shellmPrompt.ts fills per run. Do not send this raw: use `buildShellmSystemPrompt`.
 */
export const SHELLM_SYSTEM_PROMPT_TEMPLATE: string = fs.readFileSync(
  path.join(ASSETS, "shellm-system-prompt.txt"),
  "utf8"
);

/** The monolith function-menu prompt template (thinkers/monolith/prompt.md). */
export const MONOLITH_PROMPT_TEMPLATE: string = fs.readFileSync(
  path.join(ASSETS, "monolith-prompt.md"),
  "utf8"
);

/**
 * _build_system_prompt (common.sh:71-81): persona + skills, folded into the
 * wake context. identityText/skillsText come from the identity's files (stubbed
 * for the slice).
 */
export function buildSystemPrompt(identityName: string, identityText: string, skillsText: string): string {
  let out = `You are an unconscious thought process of an AI person named ${identityName}.\n`;
  out += `\nAbout ${identityName}:\n${identityText}`;
  if (skillsText) out += `\n\n${skillsText}`;
  return out;
}

/** load_prompt (common.sh): substitute {{identity_name}} and {{goals}}.
 *  When `thinkersDir` is given and `<thinkersDir>/monolith/prompt.md` exists,
 *  that identity-local override wins over the bundled template. */
export function loadThinkPrompt(identityName: string, goals: string, thinkersDir?: string): string {
  let template = MONOLITH_PROMPT_TEMPLATE;
  if (thinkersDir) {
    const override = path.join(thinkersDir, "monolith", "prompt.md");
    try {
      template = fs.readFileSync(override, "utf8");
    } catch {
      /* no override — use the bundled template */
    }
  }
  return template.replaceAll("{{identity_name}}", identityName).replaceAll("{{goals}}", goals);
}
