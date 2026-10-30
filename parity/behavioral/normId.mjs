// Mask generated ids in a task message. The wake prompt is credential-redacted (port src/promptRedact.ts, upstream
// thinkers/_lib/common.sh prompt_redact), and a random uuid whose segments 2-4 are all digits (~0.8%) matches the
// payment-card shape, so it can read `abcdef12-<redacted:card>-aabbccddeeff` — identically in both engines, but the
// two sides hold DIFFERENT random ids, so only one side may show the marker. The mask therefore absorbs it.
const ID = "[0-9a-f-]*(?:<redacted:card>[0-9a-f-]*)?";
export function maskIds(s) {
  return s
    .replace(new RegExp(`("(?:step_id|run_id)":")${ID}`, "g"), "$1<ID>")
    .replace(new RegExp(`(run_id=)${ID}`, "g"), "$1<ID>");
}
