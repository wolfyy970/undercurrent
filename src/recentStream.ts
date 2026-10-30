// recentStream.ts — the shared "recent stream" projection both the monolith
// and the responder read (thinkers/_lib/common.sh `_recent_stream`).
//
// Upstream sync 1b (design/conversation_memory.md, part 3; dcf3c02): since
// 2026-09-02 the filter drops `reasoning` steps (the model's prose between
// bash blocks inside a shellm run — half of every window, and Experiment B's
// controlled replay found the mind copied them back as ritual, never used as
// information), keeps `final` (one per run, what the run concluded), and adds
// `error` steps (a run that died with no durable step — previously invisible
// to the mind). Consecutive `idle` steps collapse into one synthetic line
// ("idle x22 over 2h10m", `collapsed: 22`); consecutive `error` steps collapse
// the same way ("run failed x5 over 40m (rc=1)"). The window N counts lines
// AFTER collapsing (2e39a3f; 285ed72 — see PORT-NOTE below), so the output is
// at most N lines — this matches the upstream jq transform exactly
// (`_RECENT_STREAM_COLLAPSE_JQ` in thinkers/_lib/common.sh).
//
// PORT-NOTE (2e39a3f, outbound_delivery.md parts 4-5, 285ed72): three changes
// to `_recent_stream`, ported together. (1) A failed `delivery` step is
// admitted (fields `status`, `reason` join the allowlist); delivered ones stay
// out, they belong to the sent ledger. (2) An idle run's `final` repeats its
// idle step, so a final whose run wrote an idle and no observation is dropped,
// letting a string of idle wakes collapse to one "idle xN" line. (3) The window
// cut moved from before the collapse to after it, so 20 idle wakes can no
// longer fill the window and bury a send the mind needs to see.
//
// This text is prompt content only — never written to the trajectory file —
// so byte-for-byte JSON key ordering against `jq -c` is not part of the
// frozen oracle (PARITY.md: "NOT on surface: nondeterministic model prose,
// stdout text"); what matters is the transform's OBSERVABLE shape, pinned by
// test/recentStream.test.ts (ported from tests/test_recent_stream_filter.sh).
//
// PORT-NOTE (1c: 2c89d2e) — "telegram: drop reasoning from recent-stream
// (match main)" is a no-op for this port: `reasoning` was never added to
// KEPT_TYPES here (upstream's own bug was a rebase conflict on a branch that
// briefly re-added it; main, and this port, never carried it).
//
// PORT-NOTE (1c: c887a4d, d507855, f1b8693) — three upstream commits changed
// `_recent_stream` in sequence; ported together as one pipeline below:
//   c887a4d: a `final` step with a run_id gets a synthetic `.details` field
//     ("traj tail -n 400 --filter run_id=<full id>") — a run's final is all
//     the next wake sees of that run under `--context-scope run`, so the
//     details command is the escape hatch back to the raw steps.
//   d507855: the rendered record is pruned to the fields the mind actually
//     uses (responder metrics like `context_steps`/`compose_ms`/`model` were
//     10K of a 17K stream on Audel) and `step_id`/`run_id` are cut to 8
//     characters (`traj` accepts a prefix) — `trigger_step`/`resolves` stay
//     whole because the mind copies them verbatim, and `.details` keeps the
//     FULL run id (already baked into the string before truncation) because
//     the traj filter needs an exact match.
//   f1b8693: an observation immediately followed by its own run's `final` is
//     the same report written twice (the model doing both, ~7 of 20 stream
//     slots on Audel) — when a `final` with a run_id arrives, the NEAREST
//     EARLIER observation carrying the same run_id is dropped from the
//     stream entirely (not just collapsed); an in-run observation with no
//     matching final, or one from an errored/killed run, stays as its only
//     record. This pairing runs over the WHOLE filtered stream, before the
//     window (N) cut, so N still counts N distinct events afterward.

import type { Step } from "./types.ts";

const KEPT_TYPES = new Set([
  "thought",
  "action",
  "observation",
  "message",
  "idle",
  "merge",
  "final",
  "error",
]);
const COLLAPSIBLE_TYPES = new Set(["idle", "error"]);

/** `with_entries(select(.key | IN(...)))` — the field allowlist (1c: d507855). */
const KEPT_FIELDS = new Set([
  "type",
  "content",
  "source",
  "ts",
  "from",
  "to",
  "run_id",
  "step_id",
  "request",
  "person",
  "resolves",
  "trigger_step",
  "reply_to",
  "follow_up",
  "decision",
  "deferred",
  "rc",
  "details",
  "status",
  "reason",
]);

interface RunMeta {
  n: number;
  firstTs: string;
  lastTs: string;
}

/**
 * _recent_stream <n> — the last <n> kept raw steps (thought, action,
 * observation, message, idle, merge, final, error), content truncated at
 * 1500 chars, with consecutive idle/error runs collapsed into one line each.
 * Returns one JSON object per line, newline-joined (possibly "").
 */
export function recentStream(steps: Step[], n: number): string {
  // 1. filter to kept types; drop content_b64; fall back to "[file: name]"
  //    when content is empty and a filename is present (1c: d507855, mirrors
  //    the same fallback the standalone `context` CLI/engine projection use
  //    for a file-transfer message step); truncate content at 1500 chars;
  //    stamp a `.details` traj-tail pointer onto a `final` with a run_id
  //    (1c: c887a4d); then keep only the fields the mind uses (1c: d507855).
  const filtered: Array<Record<string, unknown>> = [];
  for (const s of steps) {
    const r = s as Record<string, unknown>;
    const t = String(r["type"] ?? "");
    // 2e39a3f: a FAILED `delivery` step (a bridge could not post an outbound
    // message) is admitted so the mind learns it did not actually speak;
    // delivered ones are not (they would double every send inside the window
    // and belong to the sent ledger, design/outbound_delivery.md part 4).
    const failedDelivery = t === "delivery" && r["status"] === "failed";
    if (!KEPT_TYPES.has(t) && !failedDelivery) continue;
    const copy: Record<string, unknown> = { ...r };
    delete copy["content_b64"];
    const rawContent = copy["content"];
    const filename = copy["filename"];
    const emptyContent = rawContent === undefined || rawContent === null || rawContent === "";
    const hasFilename = filename !== undefined && filename !== null && filename !== "";
    const base = emptyContent && hasFilename ? `[file: ${String(filename)}]` : String(rawContent ?? "");
    copy["content"] = base.length > 1500 ? base.slice(0, 1500) + "…[truncated]" : base;
    const runId = copy["run_id"];
    if (t === "final" && runId !== undefined && runId !== null && runId !== "") {
      copy["details"] = `traj tail -n 400 --filter run_id=${String(runId)}`;
    }
    const pruned: Record<string, unknown> = {};
    for (const k of Object.keys(copy)) {
      if (KEPT_FIELDS.has(k)) pruned[k] = copy[k];
    }
    filtered.push(pruned);
  }

  // 2. pair-collapse over the WHOLE filtered stream, before collapsing (1c:
  //    f1b8693; 2e39a3f). A `final` with a run_id drops the NEAREST EARLIER
  //    observation carrying the same run_id; and when no observation pairs but
  //    the run wrote an idle step, the final is dropped itself — an idle run
  //    writes an idle and then a final that says the same thing ("Idle — nothing
  //    to do"), and the final would stop a string of idle wakes from collapsing
  //    into one "idle xN" line (16 idle runs took 48 of 20 slots on 2026-09-08).
  const paired: Array<Record<string, unknown>> = [];
  for (const s of filtered) {
    const t = String(s["type"] ?? "");
    const runId = s["run_id"];
    if (t === "final" && runId !== undefined && runId !== null && runId !== "") {
      const rid = String(runId);
      let matched = -1;
      for (let j = paired.length - 1; j >= 0; j--) {
        const cand = paired[j]!;
        if (String(cand["type"] ?? "") === "observation" && String(cand["run_id"] ?? "") === rid) {
          matched = j;
          break;
        }
      }
      if (matched >= 0) {
        paired.splice(matched, 1);
        paired.push(s);
      } else if (paired.some((c) => String(c["type"] ?? "") === "idle" && String(c["run_id"] ?? "") === rid)) {
        // the run's own idle already says it; drop the duplicate final
      } else {
        paired.push(s);
      }
      continue;
    }
    paired.push(s);
  }

  // 3. (window cut moved to after step 4 — 2e39a3f/285ed72)
  const windowed = paired;

  // 4. collapse consecutive idle/error runs (reduce, matching the jq transform).
  const acc: Array<Record<string, unknown>> = [];
  const meta: RunMeta[] = [];
  for (const s of windowed) {
    const t = String(s["type"] ?? "");
    const collapsible = COLLAPSIBLE_TYPES.has(t);
    const lastRec = acc[acc.length - 1];
    const lastMeta = meta[meta.length - 1];
    if (collapsible && lastRec !== undefined && lastMeta !== undefined && String(lastRec["type"]) === t) {
      lastMeta.n += 1;
      const ts = s["ts"];
      if (ts !== undefined && ts !== null && ts !== "") lastMeta.lastTs = String(ts);
      const sid = s["step_id"];
      if (sid !== undefined && sid !== null && sid !== "") lastRec["step_id"] = sid;
      const rc = s["rc"];
      if (rc !== undefined && rc !== null) lastRec["rc"] = rc;
    } else {
      const ts = s["ts"] !== undefined && s["ts"] !== null ? String(s["ts"]) : "";
      acc.push({ ...s });
      meta.push({ n: 1, firstTs: ts, lastTs: ts });
    }
  }

  // 5. format collapsed lines, then cut ts to minute precision and step_id/
  //    run_id to 8 characters (`traj` accepts a prefix) — 1c: d507855.
  //    trigger_step/resolves stay whole (the mind copies them verbatim);
  //    `.details` already carries the FULL run id, baked in before this cut.
  // 285ed72 (2e39a3f): the window is the last N lines AFTER collapsing. It used
  // to be cut first, so 20 idle wakes filled the window and collapsed into one
  // "idle x20" line — the whole stream on three of four wakes that re-sent a
  // post 7 to 50 minutes after the send they could no longer see.
  const first = Math.max(0, acc.length - n);
  const out: string[] = [];
  for (let i = first; i < acc.length; i++) {
    const rec = acc[i]!;
    const m = meta[i]!;
    const t = String(rec["type"] ?? "");
    if (COLLAPSIBLE_TYPES.has(t) && m.n > 1) {
      const d = durationLabel(m.firstTs, m.lastTs);
      const label = t === "idle" ? "idle" : "run failed";
      let content = `${label} x${m.n}`;
      if (d !== "") content += ` over ${d}`;
      const rc = rec["rc"];
      if (t === "error" && rc !== undefined && rc !== null) content += ` (rc=${rc})`;
      rec["content"] = content;
      rec["collapsed"] = m.n;
    }
    if (rec["ts"] !== undefined && rec["ts"] !== null) rec["ts"] = String(rec["ts"]).slice(0, 16);
    if (rec["step_id"] !== undefined && rec["step_id"] !== null) rec["step_id"] = String(rec["step_id"]).slice(0, 8);
    if (rec["run_id"]) rec["run_id"] = String(rec["run_id"]).slice(0, 8);
    out.push(JSON.stringify(rec));
  }
  return out.join("\n");
}

/** dur($a; $b) — "Ns" / "Nm" / "NhMm" / "NdMh", "" when either ts is unparseable. */
function durationLabel(a: string, b: string): string {
  const sa = parseSecs(a);
  const sb = parseSecs(b);
  if (sa === null || sb === null) return "";
  const d = sb - sa;
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h${Math.floor((d % 3600) / 60)}m`;
  return `${Math.floor(d / 86400)}d${Math.floor((d % 86400) / 3600)}h`;
}

/** secs — `((. // "")[0:19] + "Z") | fromdateiso8601`, null on failure. */
function parseSecs(ts: string): number | null {
  if (!ts) return null;
  const truncated = ts.slice(0, 19) + "Z";
  const ms = Date.parse(truncated);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}
