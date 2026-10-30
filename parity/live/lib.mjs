// parity/live/lib.mjs — pure functions for parity/live/run-sxs.mjs: parsing
// trajectory.jsonl / dispatcher.log / messages.jsonl, computing counts and
// step-type sequences, normalizing the two dispatcher-log dialects (orig
// Bash has no milliseconds and prints `source=` empty for an internal step;
// port TS prints milliseconds and `source=-`), and the STRUCTURAL-DIFF gate
// logic. NOTHING in this file touches fs/process/network — every input is a
// plain string or plain data so test/live-sxs-compare.test.ts can exercise
// it against the two real (scrubbed) trajectories in parity/live/fixtures/
// with no subprocess, no Docker, no model call. run-sxs.mjs is the only
// place that spawns anything or reads a real file.

/**
 * Step types that must appear on both sides if present on either — the
 * agent's own control-flow/output shape, not a choice the model happens to
 * make on a given run. `action` (a responder-deferral step the model emits
 * only when it chooses to defer) and any other type outside this list are
 * model-choice, not port shape: their counts still show up in the report's
 * per-type table, but a one-sided occurrence never fails the STRUCTURAL-DIFF
 * gate. Keep this in sync with README.md's STRUCTURAL-DIFF rules section.
 */
export const STRUCTURAL_STEP_TYPES = new Set([
  "shellm-run",
  "prompt",
  "reasoning",
  "shell-output",
  "final",
  "idle",
  "error",
  "reply_claim",
  "observation",
  "message",
  "trajectory",
  "thought",
]);

/**
 * Minimum shellm-run count, on the side(s) named below, below which a
 * ratio-based structural rule is statistical noise rather than a real
 * divergence — two consecutive live runs on an unrelated change produced
 * opposite-signed RATIO_RULES/one-sided-idle-or-error verdicts at n<8. See
 * structuralDiff's MIN_RUNS comment for exactly which rules this gates.
 */
export const MIN_RUNS = 8;

/** Parse a trajectory.jsonl (or messages.jsonl) blob into an array of step objects, skipping blank lines. */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

/** `{type: count}` over every step. */
export function stepTypeCounts(steps) {
  const counts = {};
  for (const s of steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
  return counts;
}

/**
 * The headline counts table (SIDE-BY-SIDE.md §b): run/step-type totals plus
 * message-direction and wake-class splits derived from each step's own
 * fields (`wake` on shellm-run, `reply_to`/`from`/`to` on message).
 */
export function computeCounts(steps, opts) {
  const identityName = opts?.identityName ?? "";
  const c = {
    shellmRuns: 0,
    finalSteps: 0,
    reasoningSteps: 0,
    shellOutputSteps: 0,
    observations: 0,
    idleSteps: 0,
    errors: 0,
    outboundMessages: 0,
    inboundMessages: 0,
    unpromptedOutreach: 0,
    reactiveWakes: 0,
    spontaneousWakes: 0,
    otherWakes: 0,
  };
  for (const s of steps) {
    switch (s.type) {
      case "shellm-run":
        c.shellmRuns += 1;
        if (typeof s.wake === "string" && s.wake.startsWith("reactive/")) c.reactiveWakes += 1;
        else if (typeof s.wake === "string" && s.wake.startsWith("spontaneous/")) c.spontaneousWakes += 1;
        else c.otherWakes += 1;
        break;
      case "final":
        c.finalSteps += 1;
        break;
      case "reasoning":
        c.reasoningSteps += 1;
        break;
      case "shell-output":
        c.shellOutputSteps += 1;
        break;
      case "observation":
        c.observations += 1;
        break;
      case "idle":
        c.idleSteps += 1;
        break;
      case "error":
        c.errors += 1;
        break;
      case "message":
        if (s.from === identityName) {
          c.outboundMessages += 1;
          if (!s.reply_to) c.unpromptedOutreach += 1;
        } else if (s.to === identityName) {
          c.inboundMessages += 1;
        }
        break;
      default:
        break;
    }
  }
  return c;
}

/** Run-length-encoded step-type sequence, e.g. [{type:"thought",count:11},{type:"message",count:1},...]. */
export function collapseTypeSequence(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.count += 1;
    else out.push({ type: s.type, count: 1 });
  }
  return out;
}

/**
 * Group steps into per-shellm-run summaries: each run's wake class, whether
 * it ever reached `final`/`idle`, and its reasoning/shell-output pair count.
 * Steps before the first shellm-run (the seed thoughts, message A) form a
 * synthetic "seed" pseudo-run so nothing is dropped.
 */
export function collapseByRun(steps) {
  const runs = [];
  let current = { runId: "seed", wake: null, counts: {}, hasFinal: false, hasIdle: false, startTs: null };
  const push = (s) => {
    current.counts[s.type] = (current.counts[s.type] ?? 0) + 1;
    if (s.type === "final") current.hasFinal = true;
    if (s.type === "idle") current.hasIdle = true;
  };
  for (const s of steps) {
    if (s.type === "shellm-run") {
      if (Object.keys(current.counts).length > 0 || current.runId !== "seed") runs.push(current);
      else if (current.runId === "seed" && Object.keys(current.counts).length > 0) runs.push(current);
      current = { runId: s.step_id ?? `run-${runs.length + 1}`, wake: s.wake ?? null, counts: {}, hasFinal: false, hasIdle: false, startTs: s.ts ?? null };
      push(s);
      continue;
    }
    push(s);
  }
  if (Object.keys(current.counts).length > 0) runs.push(current);
  return runs;
}

/** Outbound (identity -> operator) message steps, for the report's per-message reply-text section. */
export function outboundReplies(steps, opts) {
  const identityName = opts?.identityName ?? "";
  return steps
    .filter((s) => s.type === "message" && s.from === identityName)
    .map((s) => ({ ts: s.ts, to: s.to, replyTo: s.reply_to ?? null, content: s.content ?? "" }));
}

/**
 * Normalize one dispatcher.log line into a plain event. Handles both
 * dialects: orig Bash has no fractional seconds and prints `source=` empty
 * for an internal (non-message) step; port TS prints milliseconds and
 * `source=-` for the same case. Everything else about the log line grammar
 * is identical between the two (SIDE-BY-SIDE.md's own diff found the line
 * *shapes* match; only the timestamp precision and empty-source spelling
 * differ), so one parser covers both.
 */
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[dispatcher\]\s?(.*)$/;
const STEP_RE = /^step: type=(\S+) source=(\S*)$/;
const DISPATCH_RE = /^dispatch -> (\S+) \(active=(\d+)\)$/;
const FIRE_PENDING_RE = /^fire pending -> (\S+) \(type=(\S+), active=(\d+)\)$/;
const PENDING_RE = /^pending -> (\S+) \(type=(\S+), (?:queued=(\d+)|coalesced)\)$/;
const SCHEDULED_WAKE_RE = /^scheduled wake -> (\S+) \(due (\d+)s ago\)$/;
const SKIP_RE = /^skip (\S+) \(self-trigger\)$/;

export function parseDispatcherLog(text) {
  const events = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const m = TS_RE.exec(line);
    if (!m) {
      events.push({ ts: null, tsMs: null, kind: "unparsed", raw: line });
      continue;
    }
    const ts = m[1];
    const tsMs = Date.parse(ts);
    const rest = m[2].trim();

    let mm;
    if ((mm = STEP_RE.exec(rest))) {
      const source = mm[2] === "" || mm[2] === "-" ? null : mm[2];
      events.push({ ts, tsMs, kind: "step", type: mm[1], source });
    } else if ((mm = DISPATCH_RE.exec(rest))) {
      events.push({ ts, tsMs, kind: "dispatch", target: mm[1], active: Number(mm[2]) });
    } else if ((mm = FIRE_PENDING_RE.exec(rest))) {
      events.push({ ts, tsMs, kind: "fire-pending", target: mm[1], type: mm[2], active: Number(mm[3]) });
    } else if ((mm = PENDING_RE.exec(rest))) {
      events.push({
        ts,
        tsMs,
        kind: "pending",
        target: mm[1],
        type: mm[2],
        coalesced: mm[3] === undefined,
        queued: mm[3] === undefined ? null : Number(mm[3]),
      });
    } else if ((mm = SCHEDULED_WAKE_RE.exec(rest))) {
      events.push({ ts, tsMs, kind: "scheduled-wake", target: mm[1], dueAgoSec: Number(mm[2]) });
    } else if ((mm = SKIP_RE.exec(rest))) {
      events.push({ ts, tsMs, kind: "skip-self-trigger", target: mm[1] });
    } else if (rest.includes("caught SIGTERM")) {
      events.push({ ts, tsMs, kind: "sigterm", raw: rest });
    } else {
      events.push({ ts, tsMs, kind: "other", raw: rest });
    }
  }
  return events;
}

/** Timeline of monolith-run starts (`step: type=shellm-run`) with the gap since the previous one, in seconds. */
export function wakeCadence(dispatcherEvents) {
  const starts = dispatcherEvents
    .filter((e) => e.kind === "step" && e.type === "shellm-run" && e.tsMs !== null)
    .map((e) => ({ ts: e.ts, tsMs: e.tsMs }))
    .sort((a, b) => a.tsMs - b.tsMs);
  return starts.map((s, i) => ({ ts: s.ts, gapSec: i === 0 ? null : Math.round((s.tsMs - starts[i - 1].tsMs) / 100) / 10 }));
}

/** Count of non-blank lines in a messages.jsonl blob (the derived chat-history index). */
export function countJsonlLines(text) {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Assemble one side's full summary from its raw artifact text plus
 * externally-supplied facts that don't live in these files (per-thinker log
 * byte sizes, orphaned processes/containers left after stop). Pure: no I/O.
 */
export function buildSideSummary(input) {
  const steps = parseJsonl(input.trajectoryText);
  const dispatcherEvents = parseDispatcherLog(input.dispatcherLogText ?? "");
  const counts = computeCounts(steps, { identityName: input.identityName });
  const trajectoryMessageCount = steps.filter((s) => s.type === "message").length;
  return {
    steps,
    counts,
    stepTypeCounts: stepTypeCounts(steps),
    collapsed: collapseTypeSequence(steps),
    runs: collapseByRun(steps),
    replies: outboundReplies(steps, { identityName: input.identityName }),
    dispatcherEvents,
    wakeTimeline: wakeCadence(dispatcherEvents),
    messageIndexCount: input.messagesIndexText !== undefined ? countJsonlLines(input.messagesIndexText) : null,
    trajectoryMessageCount,
    perThinkerLogBytes: input.perThinkerLogBytes ?? {},
    memoryFiles: input.memoryFiles ?? null,
    orphanProcesses: input.orphanProcesses ?? [],
    orphanContainers: input.orphanContainers ?? [],
    drainSeconds: input.drainSeconds ?? null,
  };
}

/**
 * The merge-gate: structural (contract) differences between the two sides.
 * Prose/model-nondeterminism differences never appear here — only shape.
 * Mirrors DELIVERABLE's STRUCTURAL-DIFF list exactly.
 *
 * Returns `{ diffs, inconclusive }`. `diffs` are hard FAILUREs — any entry
 * there fails the gate (exitCodeForDiffs). `inconclusive` entries look like
 * diffs (same `{code, message}` shape) but never fail the gate; they exist
 * because two rule families are genuinely noisy at a small shellm-run count
 * (two real consecutive 10-minute gate runs on a change that could not
 * affect run length produced opposite-signed verdicts below MIN_RUNS):
 *
 *  - `final-ratio` / `reasoning-per-run`: ratios computed over few runs swing
 *    wildly on ordinary model variance. Only a FAILURE when BOTH sides have
 *    >= MIN_RUNS shellm-run steps; below that (either side), the same
 *    would-be diff is emitted as inconclusive instead.
 *  - `type-only-one-side` for `idle` and `error` specifically: both are
 *    legitimately absent from a short run (no time to go idle, no error
 *    surfaced) without meaning anything structural. Inconclusive when
 *    EITHER side has < MIN_RUNS shellm-run steps. Every other structural
 *    type (`final` included) stays a hard diff at any n — a genuinely
 *    missing `final` or `message` step is never sample-size noise.
 *
 * Every other rule (zero-byte-log, message-index-mismatch, orphan-process,
 * orphan-container, and type-only-one-side for anything but idle/error)
 * never softens — these are hard signals regardless of run count.
 */
export function structuralDiff(orig, port) {
  const diffs = [];
  const inconclusive = [];
  const bothEnoughRuns = orig.counts.shellmRuns >= MIN_RUNS && port.counts.shellmRuns >= MIN_RUNS;
  const eitherShortOnRuns = orig.counts.shellmRuns < MIN_RUNS || port.counts.shellmRuns < MIN_RUNS;

  // 1. final-step ratio differing by >30 percentage points.
  const origFinalRatio = orig.counts.shellmRuns > 0 ? orig.counts.finalSteps / orig.counts.shellmRuns : 0;
  const portFinalRatio = port.counts.shellmRuns > 0 ? port.counts.finalSteps / port.counts.shellmRuns : 0;
  const finalRatioDelta = Math.abs(origFinalRatio - portFinalRatio);
  if (finalRatioDelta > 0.3) {
    const entry = {
      code: "final-ratio",
      message: `final-step ratio differs by >30%: orig ${orig.counts.finalSteps}/${orig.counts.shellmRuns} (${(origFinalRatio * 100).toFixed(0)}%) vs port ${port.counts.finalSteps}/${port.counts.shellmRuns} (${(portFinalRatio * 100).toFixed(0)}%)`,
    };
    (bothEnoughRuns ? diffs : inconclusive).push(
      bothEnoughRuns ? entry : { ...entry, message: `${entry.message} — inconclusive: fewer than ${MIN_RUNS} shellm-run steps on one or both sides` }
    );
  }

  // 2. reasoning-per-run differing by >2x.
  const origRPR = orig.counts.shellmRuns > 0 ? orig.counts.reasoningSteps / orig.counts.shellmRuns : 0;
  const portRPR = port.counts.shellmRuns > 0 ? port.counts.reasoningSteps / port.counts.shellmRuns : 0;
  if (orig.counts.shellmRuns > 0 && port.counts.shellmRuns > 0) {
    const hi = Math.max(origRPR, portRPR);
    const lo = Math.min(origRPR, portRPR);
    if (lo === 0 ? hi > 0 : hi / lo > 2) {
      const entry = {
        code: "reasoning-per-run",
        message: `reasoning-steps-per-run differs by >2x: orig ${orig.counts.reasoningSteps}/${orig.counts.shellmRuns} (${origRPR.toFixed(2)}) vs port ${port.counts.reasoningSteps}/${port.counts.shellmRuns} (${portRPR.toFixed(2)})`,
      };
      (bothEnoughRuns ? diffs : inconclusive).push(
        bothEnoughRuns ? entry : { ...entry, message: `${entry.message} — inconclusive: fewer than ${MIN_RUNS} shellm-run steps on one or both sides` }
      );
    }
  }

  // 3. zero-byte per-thinker logs on one side. Hard at any n.
  const logKeys = new Set([...Object.keys(orig.perThinkerLogBytes ?? {}), ...Object.keys(port.perThinkerLogBytes ?? {})]);
  for (const key of logKeys) {
    const o = orig.perThinkerLogBytes[key] ?? 0;
    const p = port.perThinkerLogBytes[key] ?? 0;
    if ((o === 0) !== (p === 0) && o + p > 0) {
      diffs.push({ code: "zero-byte-log", message: `${key} is zero bytes on one side: orig ${o}B vs port ${p}B` });
    }
  }

  // 4. message index length != trajectory message count. Hard at any n.
  for (const [label, side] of [["orig", orig], ["port", port]]) {
    if (side.messageIndexCount !== null && side.messageIndexCount !== side.trajectoryMessageCount) {
      diffs.push({
        code: "message-index-mismatch",
        message: `${label}: messages.jsonl has ${side.messageIndexCount} lines but trajectory has ${side.trajectoryMessageCount} message steps`,
      });
    }
  }

  // 5. orphaned processes/containers after stop. Hard at any n.
  if ((orig.orphanProcesses?.length ?? 0) > 0) diffs.push({ code: "orphan-process", message: `orig: ${orig.orphanProcesses.length} orphaned process(es) after stop: ${orig.orphanProcesses.join(", ")}` });
  if ((port.orphanProcesses?.length ?? 0) > 0) diffs.push({ code: "orphan-process", message: `port: ${port.orphanProcesses.length} orphaned process(es) after stop: ${port.orphanProcesses.join(", ")}` });
  if ((orig.orphanContainers?.length ?? 0) > 0) diffs.push({ code: "orphan-container", message: `orig: ${orig.orphanContainers.length} orphaned container(s) after stop: ${orig.orphanContainers.join(", ")}` });
  if ((port.orphanContainers?.length ?? 0) > 0) diffs.push({ code: "orphan-container", message: `port: ${port.orphanContainers.length} orphaned container(s) after stop: ${port.orphanContainers.join(", ")}` });

  // 6. a STRUCTURAL step type present on one side only. Non-structural types
  // (e.g. `action`) are model-choice and never gate — see STRUCTURAL_STEP_TYPES.
  // `idle`/`error` are inconclusive (not hard) below MIN_RUNS on either side —
  // both are legitimately absent from a short run. Every other structural
  // type, `final` included, stays hard at any n.
  const origTypes = new Set(Object.keys(orig.stepTypeCounts));
  const portTypes = new Set(Object.keys(port.stepTypeCounts));
  const SMALL_SAMPLE_TYPES = new Set(["idle", "error"]);
  function pushTypeOnlyOneSide(t, count, onlySide, otherSide) {
    const entry = { code: "type-only-one-side", message: `step type "${t}" appears ${count}x in ${onlySide}, never in ${otherSide}` };
    if (SMALL_SAMPLE_TYPES.has(t) && eitherShortOnRuns) {
      inconclusive.push({ ...entry, message: `${entry.message} — inconclusive: fewer than ${MIN_RUNS} shellm-run steps on one or both sides` });
    } else {
      diffs.push(entry);
    }
  }
  for (const t of origTypes) if (!portTypes.has(t) && STRUCTURAL_STEP_TYPES.has(t)) pushTypeOnlyOneSide(t, orig.stepTypeCounts[t], "orig", "port");
  for (const t of portTypes) if (!origTypes.has(t) && STRUCTURAL_STEP_TYPES.has(t)) pushTypeOnlyOneSide(t, port.stepTypeCounts[t], "port", "orig");

  return { diffs, inconclusive };
}

/** 0 = no structural diffs, 2 = structural diffs found. Inconclusive entries never count. (1, "a side failed to run", is decided by the orchestrator before comparison even runs.) */
export function exitCodeForDiffs(diffs) {
  return diffs.length === 0 ? 0 : 2;
}

// ---------------------------------------------------------------------------
// L4 chaos/recovery: per-event snapshot comparison (PROOF-CAMPAIGN.md L4).
//
// run-sxs.mjs takes a SNAPSHOT of each side's recovery-relevant state right
// before and right after applying a chaos event (dispatcher-sigterm,
// step-sigkill, docker-pause, ...). Everything below is pure: it turns the
// raw strings/booleans the orchestrator read off disk/ps/docker into a
// normalized snapshot, then compares orig's transition against port's for a
// fixed set of fields, and renders the result. It does NOT decide
// PORT-BUG / documented-deviation / nondeterminism / environment — that's a
// human judgment call made by reading the rendered table (PROOF-CAMPAIGN.md's
// own contract: "harness lanes never fix the port"), not something this
// module should pretend to automate.
// ---------------------------------------------------------------------------

/** Parse `run/step_pids` ("<pid> <name>\n" per line — bin/thinkers:520,562; identical format on the port, runstate.ts) into `{pid, name}` entries, skipping blank lines. */
export function parseStepPids(text) {
  const out = [];
  for (const rawLine of (text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), name: m[2] });
  }
  return out;
}

/** Does a trajectory tail carry the dispatcher-downtime wake-up-gap observation (bin/thinkers's _append_wake_gap_note / the port's identical-text appendWakeGapNote)? Both sides emit the same lead sentence. */
export function hasWakeGapNote(trajectoryTailText) {
  return /Wake-up note: your dispatcher just started/.test(trajectoryTailText ?? "");
}

/**
 * Normalize one side's raw chaos-moment snapshot into a comparable shape.
 * `raw` fields are exactly what run-sxs.mjs can cheaply read at a moment in
 * time: `dispatcherPidText` (run/dispatcher.pid contents, or ""),
 * `dispatcherAlive` (bool, from a `kill -0` style liveness check),
 * `lastSignalText` (run/last_signal contents, or ""), `stepPidsText`
 * (run/step_pids contents, or ""), `pendingNames` (array of run/pending/
 * entry names), `containers` (array of `{id, name, state}` from `docker ps
 * -a`), `trajectoryTailText` (last few trajectory.jsonl lines, joined).
 */
export function buildChaosSnapshot(raw) {
  const stepPids = parseStepPids(raw.stepPidsText ?? "");
  return {
    dispatcherPid: raw.dispatcherPidText && raw.dispatcherPidText.trim() ? Number(raw.dispatcherPidText.trim()) : null,
    dispatcherAlive: Boolean(raw.dispatcherAlive),
    lastSignal: raw.lastSignalText ? raw.lastSignalText.trim() : null,
    stepPidCount: stepPids.length,
    stepPidNames: stepPids.map((p) => p.name).sort(),
    pendingCount: (raw.pendingNames ?? []).length,
    containerCount: (raw.containers ?? []).length,
    containerStates: (raw.containers ?? []).map((c) => c.state ?? "unknown").sort(),
    wakeGapNotePresent: hasWakeGapNote(raw.trajectoryTailText),
  };
}

/** Fields compared by direct equality (both sides should reach the same qualitative AFTER-state for these — "did the dispatcher come back", "was the right signal recorded", "did the note get written"). */
const CHAOS_DIRECT_FIELDS = ["dispatcherAlive", "lastSignal", "wakeGapNotePresent"];

/** Count-like fields compared by the SIGN of their before->after delta, not their absolute value — the absolute count of live steps/pending items/containers legitimately differs between sides due to ordinary model-call timing, independent of the chaos event; whether it went up, down, or stayed flat is the recovery-relevant signal. */
const CHAOS_DELTA_FIELDS = ["stepPidCount", "pendingCount", "containerCount"];

function sign(n) {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/**
 * Compare one chaos event's before/after snapshots on both sides. Returns
 * `{event, atMinutes, fields}` where `fields` is one row per compared field:
 * `{name, kind: "direct"|"delta", orig, port, match}`. `match` is a plain
 * boolean signal for the report table — never a pass/fail verdict on the
 * port; see this section's header comment.
 */
export function compareChaosEvent(event, origBefore, origAfter, portBefore, portAfter) {
  const fields = [];
  for (const name of CHAOS_DIRECT_FIELDS) {
    const orig = origAfter[name];
    const port = portAfter[name];
    fields.push({ name, kind: "direct", orig, port, match: JSON.stringify(orig) === JSON.stringify(port) });
  }
  for (const name of CHAOS_DELTA_FIELDS) {
    const origDelta = sign(origAfter[name] - origBefore[name]);
    const portDelta = sign(portAfter[name] - portBefore[name]);
    fields.push({
      name: `${name} (delta)`,
      kind: "delta",
      orig: `${origBefore[name]}->${origAfter[name]} (${origDelta >= 0 ? "+" : ""}${origDelta})`,
      port: `${portBefore[name]}->${portAfter[name]} (${portDelta >= 0 ? "+" : ""}${portDelta})`,
      match: origDelta === portDelta,
    });
  }
  return { event: event.type, atMinutes: event.atMinutes, fields };
}

/** Render the CHAOS RECOVERY report section from an array of compareChaosEvent() rows. Pure markdown, no verdicts beyond the per-field match column. */
export function renderChaosSection(rows) {
  if (rows.length === 0) return "";
  const lines = ["## Chaos recovery (L4)", "", "Match is a signal for a human to classify (PORT-BUG / documented deviation / model nondeterminism / environment) — never an automatic verdict on the port. See parity/live/lib.mjs's chaos-recovery header.", ""];
  for (const row of rows) {
    lines.push(`### T+${row.atMinutes}min — ${row.event}`, "", "| field | orig | port | match |", "|---|---|---|---|");
    for (const f of row.fields) lines.push(`| ${f.name} | ${f.orig} | ${f.port} | ${f.match ? "yes" : "**no**"} |`);
    lines.push("");
  }
  const mismatchCount = rows.reduce((n, r) => n + r.fields.filter((f) => !f.match).length, 0);
  lines.push(mismatchCount === 0 ? "All chaos-event fields matched between sides." : `${mismatchCount} field(s) did not match between sides across ${rows.length} chaos event(s) — see tables above.`, "");
  return lines.join("\n");
}

function fmtCounts(c) {
  return (
    `| shellm-run | ${c.shellmRuns} |\n` +
    `| final | ${c.finalSteps} |\n` +
    `| reasoning | ${c.reasoningSteps} |\n` +
    `| shell-output | ${c.shellOutputSteps} |\n` +
    `| observation | ${c.observations} |\n` +
    `| idle | ${c.idleSteps} |\n` +
    `| error | ${c.errors} |\n` +
    `| outbound messages | ${c.outboundMessages} |\n` +
    `| unprompted outreach | ${c.unpromptedOutreach} |\n` +
    `| reactive wakes | ${c.reactiveWakes} |\n` +
    `| spontaneous wakes | ${c.spontaneousWakes} |\n`
  );
}

function fmtDrainSeconds(s) {
  return s == null ? "?" : `${s}s`;
}

function fmtCollapsed(collapsed) {
  return collapsed.map((c) => `${c.type}${c.count > 1 ? `×${c.count}` : ""}`).join(", ");
}

function fmtWakeTimeline(timeline) {
  if (timeline.length === 0) return "(no shellm-run steps)\n";
  return timeline.map((w, i) => `  #${i + 1}  ${w.ts}  gap=${w.gapSec === null ? "-" : `${w.gapSec}s`}`).join("\n") + "\n";
}

/**
 * Render report.md. Pure: takes the two summaries + diffs/inconclusive + a small meta object, returns markdown text.
 * @param {{orig: any, port: any, diffs: Array<{code: string, message: string}>, inconclusive?: Array<{code: string, message: string}>, meta: any, chaosRows?: any[]}} args
 */
export function renderReport({ orig, port, diffs, inconclusive = [], meta, chaosRows = [] }) {
  const lines = [];
  lines.push(`# Live side-by-side: ${meta.identityName ?? "identity"}`, "");
  lines.push(`Run: ${meta.startedAt ?? "?"} — ${meta.minutes ?? "?"} minute(s), model \`${meta.model ?? "?"}\`.`, "");
  lines.push(meta.dryRun ? "**Mode: --dry-run** (setup only, no thinkers started, no messages sent, no model cost).\n" : "**Mode: live** (real model, real Docker sandbox).\n");

  lines.push("## Counts", "");
  lines.push("| metric | orig | port |", "|---|---|---|");
  const keys = ["shellmRuns", "finalSteps", "reasoningSteps", "shellOutputSteps", "observations", "idleSteps", "errors", "outboundMessages", "unpromptedOutreach", "reactiveWakes", "spontaneousWakes"];
  const labels = { shellmRuns: "shellm-run", finalSteps: "final", reasoningSteps: "reasoning", shellOutputSteps: "shell-output", observations: "observation", idleSteps: "idle", errors: "error", outboundMessages: "outbound messages", unpromptedOutreach: "unprompted outreach", reactiveWakes: "reactive wakes", spontaneousWakes: "spontaneous wakes" };
  for (const k of keys) lines.push(`| ${labels[k]} | ${orig.counts[k]} | ${port.counts[k]} |`);
  lines.push(`| memory files | ${orig.memoryFiles?.length ?? "?"} | ${port.memoryFiles?.length ?? "?"} |`);
  lines.push(`| messages.jsonl lines | ${orig.messageIndexCount ?? "?"} | ${port.messageIndexCount ?? "?"} |`);
  lines.push(`| trajectory message steps | ${orig.trajectoryMessageCount} | ${port.trajectoryMessageCount} |`);
  lines.push(`| drain duration | ${fmtDrainSeconds(orig.drainSeconds)} | ${fmtDrainSeconds(port.drainSeconds)} |`, "");

  lines.push("## Step type counts (all types)", "", "Types not in STRUCTURAL_STEP_TYPES (lib.mjs) are model-choice and never gate — see STRUCTURAL-DIFF below.", "");
  lines.push("| type | orig | port | structural |", "|---|---|---|---|");
  const allTypes = Array.from(new Set([...Object.keys(orig.stepTypeCounts ?? {}), ...Object.keys(port.stepTypeCounts ?? {})])).sort();
  for (const t of allTypes) {
    lines.push(`| ${t} | ${orig.stepTypeCounts?.[t] ?? 0} | ${port.stepTypeCounts?.[t] ?? 0} | ${STRUCTURAL_STEP_TYPES.has(t) ? "yes" : "no"} |`);
  }
  lines.push("");

  lines.push("## Collapsed step-type sequence", "", "**orig:**", "", "```", fmtCollapsed(orig.collapsed), "```", "", "**port:**", "", "```", fmtCollapsed(port.collapsed), "```", "");

  lines.push("## Wake cadence (dispatcher.log, `shellm-run` starts)", "", "**orig:**", "```", fmtWakeTimeline(orig.wakeTimeline).trimEnd(), "```", "", "**port:**", "```", fmtWakeTimeline(port.wakeTimeline).trimEnd(), "```", "");

  lines.push("## Reply texts", "", "**orig:**", "");
  for (const r of orig.replies) lines.push(`- \`${r.ts}\` -> ${r.to}${r.replyTo ? ` (reply_to ${r.replyTo})` : " (unprompted)"}: ${JSON.stringify(r.content)}`);
  lines.push("", "**port:**", "");
  for (const r of port.replies) lines.push(`- \`${r.ts}\` -> ${r.to}${r.replyTo ? ` (reply_to ${r.replyTo})` : " (unprompted)"}: ${JSON.stringify(r.content)}`);
  lines.push("");

  lines.push("## Memory files", "", "**orig:**", "");
  for (const f of orig.memoryFiles ?? []) lines.push(`- ${f}`);
  lines.push("", "**port:**", "");
  for (const f of port.memoryFiles ?? []) lines.push(`- ${f}`);
  lines.push("");

  lines.push("## STRUCTURAL-DIFF", "");
  if (diffs.length === 0) {
    lines.push("None. Port matches original structurally — merge gate clear.", "");
  } else {
    for (const d of diffs) lines.push(`- **[${d.code}]** ${d.message}`);
    lines.push("");
  }

  if (inconclusive.length > 0) {
    lines.push("## INCONCLUSIVE (small sample)", "");
    lines.push(`Ratio-based rules and one-sided \`idle\`/\`error\` occurrences are noisy below MIN_RUNS (${MIN_RUNS}) shellm-run steps — these never fail the gate. Re-run with more minutes (\`--minutes 15\`+) if a verdict here matters.`, "");
    for (const d of inconclusive) lines.push(`- **[${d.code}]** ${d.message}`);
    lines.push("");
  }

  if (chaosRows.length > 0) {
    lines.push(renderChaosSection(chaosRows));
  }

  lines.push("## Bottom line", "");
  lines.push(diffs.length === 0 ? "PASS — no structural diffs." : `FAIL — ${diffs.length} structural diff(s), see above. Prose/timing differences are expected model nondeterminism and are not counted.`, "");

  return lines.join("\n");
}
