// lib/allowances.mjs — the ONLY per-field deviation allowances this harness
// applies. Every one of these is imported/reused from an existing
// parity/<tool>/run-parity.mjs harness or PARITY.md row (cited in each
// function's comment) — this file adds NO new allowances of its own. A
// scenario that doesn't match one of these predicates and still diverges is
// reported as a fresh, unclassified finding for a human to triage.

// --- 1. bash-internal line-wording deviation (mem, retrieval; PARITY.md
// "mem parity fixes" M1 + "retrieval parity notes") -----------------------------
// Bash's `${var:?msg}` / `[[ $x -ge 1 ]]` failures print
// `<script-path>: line N: ...`, embedding the Bash script's own absolute path
// and an internal line number — irreproducible from TS and brittle to pin.
// The port instead prints its own clean `<tool>: error: ...` message.
// ALLOWED iff: exit codes match, stdout matches, on-disk state (if compared)
// matches, and ONLY stderr differs, with bash's stderr carrying the
// `: line <N>:` marker (already normalized to `<N>` by callers) that the port's
// never does.
export function isBashLineWordingDeviation({ exitMatch, stdoutMatch, stateMatch, bashStderr, tsStderr }) {
  if (!exitMatch || !stdoutMatch) return false;
  if (stateMatch === false) return false; // only allow when state either matches or wasn't compared
  if (bashStderr === tsStderr) return false; // not actually a stderr divergence
  // Callers normalize stderr (tools/common.mjs's normalizeGeneric) BEFORE
  // calling this, which already rewrites "line \d+:" -> "line <N>:" — so the
  // marker to look for is the placeholder, not raw digits (a pre-normalization
  // caller still matches via the \d+ fallback).
  const LINE_MARKER = /: line (<N>|\d+):/;
  const bashHasLineMarker = LINE_MARKER.test(bashStderr);
  const tsHasLineMarker = LINE_MARKER.test(tsStderr);
  return bashHasLineMarker && !tsHasLineMarker;
}

// PORT-NOTE (1c: 12ca841): isGlobLimitNonIntegerFamily, isGlobBracketRangeFamily
// (glob) and isPutOsFailFamily (put) were removed here — focus/glob/put/sub/view
// are retired (upstream 12ca841, "the mind reads and edits in bash") and their
// fuzz adapters (parity/fuzz/tools/{glob,put}.mjs) and parity/{glob,put}/ harnesses
// no longer exist to import these allowances.

// --- 5. killall live-process-listing exclusion (parity/killall header; the two
// tools' process universes are disjoint by construction and even the bash
// side alone is nondeterministic on a shared machine) ---------------------------
// Not a per-field allowance so much as a standing SCOPE restriction this
// fuzzer inherits: killall is NEVER invoked without --dry-run, and the live
// listing body is redacted before compare, exactly as parity/killall does.
export const KILLALL_FIXED_LINES = new Set(["No matching processes found.", "(dry run — nothing was killed)"]);
export function redactKillallListing(text) {
  return text
    .split("\n")
    .map((line) => {
      if (KILLALL_FIXED_LINES.has(line)) return line;
      if (/^Would kill \d+ process\(es\):$/.test(line)) return line;
      if (line === "") return line;
      return "<redacted: live process listing line, non-deterministic — see parity/killall/run-parity.mjs header>";
    })
    .join("\n");
}

// --- 6. retrieval awk -v backslash-escape family (parity/retrieval's "awk-v"
// sequence; PARITY.md "retrieval parity notes") ---------------------------------
// A memory `summary:` line containing a backslash escape sequence is
// interpreted by `awk -v s="$summary"` when Bash writes the index row
// (`\t` splits fields, `\n` splits rows) while the port writes the bytes
// verbatim. Triggered only by content fed into a memory's summary field.
export function isRetrievalAwkVFamily(summaryText) {
  return typeof summaryText === "string" && /\\[tn]/.test(summaryText);
}

// --- 7. llm transport-failure wording on the STREAMING path (parity/llm's
// "transport-text" deviation catalogue entry) -----------------------------------
// Where Bash relays curl's own text (`curl error: curl: (7) Failed to
// connect …`), the port says `request failed: <node detail>` (fetch/undici's
// own wording — e.g. Node's fetch blocks certain low-numbered ports per the
// Fetch spec's "bad port" list, which curl does not, so the SAME closed-port
// test fixture even fails via a different mechanism on each side). stdout,
// exit code and retry count are identical; only the message text differs.
// The non-streaming path never carried curl's text and stays at parity — this
// allowance is scoped to argv WITHOUT --no-stream.
// --- 8. llm invalid `-M`/`--messages` JSON family (parity/llm's
// "invalid-messages-json" deviation catalogue entry) -----------------------------
// Invalid JSON (or a non-array) passed to `-M` makes Bash die inside jq
// (`jq: parse error …`, exit 5); the port dies with its own clean message
// (`llm: error: --messages is not valid JSON`, exit 1). No request is ever
// sent on either side.
export function isLlmInvalidMessagesJsonFamily({ argv, bashStderr, tsStderr }) {
  if (!Array.isArray(argv) || !argv.includes("-M")) return false;
  // PARITY.md's own catalogue entry documents BOTH jq failure shapes as the
  // SAME family: a parse error for non-JSON, or "cannot be added" for valid
  // JSON that isn't an array (e.g. `-M '{}'` with `-s` trying to prepend a
  // system message onto a non-array).
  const bashLooksLikeJqFailure = /jq: parse error|cannot be added/.test(bashStderr);
  const tsLooksLikeMessagesError = /--messages is not valid JSON|must be a JSON array/.test(tsStderr);
  return bashLooksLikeJqFailure && tsLooksLikeMessagesError;
}

export function isLlmTransportTextFamily({ argv, bashStderr, tsStderr }) {
  if (Array.isArray(argv) && argv.includes("--no-stream")) return false;
  const bashLooksLikeCurl = /curl error: curl: \(\d+\)/.test(bashStderr);
  const tsLooksLikeFetch = /request failed:/.test(tsStderr);
  return bashLooksLikeCurl && tsLooksLikeFetch;
}

export default {
  isBashLineWordingDeviation,
  isLlmTransportTextFamily,
  isLlmInvalidMessagesJsonFamily,
  KILLALL_FIXED_LINES,
  redactKillallListing,
  isRetrievalAwkVFamily,
};
