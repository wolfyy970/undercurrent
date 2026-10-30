// parity/live/scenario.mjs — pure scenario-script parsing/validation/
// scheduling for run-sxs.mjs's L3 (long live side-by-side) and L4
// (chaos/recovery) layers (PROOF-CAMPAIGN.md). A scenario file is a JSON
// array of EVENTS, each applied to BOTH sides at the same wall-clock offset
// using each side's own CLI — this module only decides WHAT happens WHEN; it
// never spawns a process, reads a file, or sleeps (that's run-sxs.mjs's job,
// same split as lib.mjs/run-sxs.mjs).
//
// Event shapes (`type` field; `atMinutes` required on every event except
// entries produced by `expandBursts`, which still carry it):
//
//   {type:"message", atMinutes, from?, to?, text}
//     A single scripted chat message. `type` may be omitted for backward
//     compatibility with the original A/B/C protocol's bare
//     {atMinutes, from, text} shape (see normalizeEvent).
//
//   {type:"burst", atMinutes, count, overSeconds, from?, textTemplate?, texts?}
//     N messages evenly spread across `overSeconds` starting at `atMinutes`.
//     Either `texts` (an array of exactly `count` strings) or `textTemplate`
//     (a string containing `{n}`, replaced with the 1-based message index)
//     must be given. expandBursts() turns this into `count` concrete
//     `message` events tagged with a shared `burstId`.
//
//   {type:"thinkers-stop", atMinutes, force?}
//   {type:"thinkers-start", atMinutes}
//   {type:"dispatcher-sigterm", atMinutes}
//   {type:"dispatcher-sigkill", atMinutes}
//   {type:"step-sigkill", atMinutes}
//     Kill the in-flight step process (thinkers/<name>/step child) on both
//     sides, if one is currently running; a no-op (recorded as such) when
//     neither side has one in flight at that instant.
//   {type:"docker-pause", atMinutes}
//   {type:"docker-unpause", atMinutes}
//     Pause/unpause the identity's own `shellm-<pid>` sandbox container(s)
//     on both sides, if any exist at that instant.
//   {type:"model-fault", atMinutes, faultType, count}
//     faultType one of "429" | "500" | "truncated" | "stall". Tells the
//     shared fault-injecting proxy (fault-proxy.mjs) to apply this fault to
//     the next `count` model requests it forwards, from either side,
//     interleaved in arrival order — see fault-proxy.mjs's header for why
//     this can't be split evenly per side.
//   {type:"quiet", atMinutes, minutes}
//     No events at all — including scripted messages — for `minutes`
//     starting at `atMinutes`: the unprompted-outreach window. Enforced by
//     validateScenario, which rejects a scenario scheduling anything else
//     inside a quiet window.
//   {type:"second-identity", atMinutes, name}
//     Create identity `name` and start its thinkers on both sides, mid-run,
//     alongside the primary identity.
//
// Nothing here is a comparison verdict — see lib.mjs's chaos-recovery
// exports for that.

export const EVENT_TYPES = new Set([
  "message",
  "burst",
  "thinkers-stop",
  "thinkers-start",
  "dispatcher-sigterm",
  "dispatcher-sigkill",
  "step-sigkill",
  "docker-pause",
  "docker-unpause",
  "model-fault",
  "quiet",
  "second-identity",
]);

export const MODEL_FAULT_TYPES = new Set(["429", "500", "truncated", "stall"]);

/** Bare {atMinutes, from, text} (no `type`) is a `message` — the original A/B/C protocol shape. */
export function normalizeEvent(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`scenario[${index}]: event must be an object, got ${JSON.stringify(raw)}`);
  }
  const type = raw.type ?? "message";
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`scenario[${index}]: unknown event type ${JSON.stringify(type)} (expected one of ${Array.from(EVENT_TYPES).join(", ")})`);
  }
  if (typeof raw.atMinutes !== "number" || !Number.isFinite(raw.atMinutes) || raw.atMinutes < 0) {
    throw new Error(`scenario[${index}]: atMinutes must be a non-negative number, got ${JSON.stringify(raw.atMinutes)}`);
  }
  return { ...raw, type };
}

function requireFields(ev, index, fields) {
  for (const f of fields) {
    if (ev[f] === undefined || ev[f] === null) {
      throw new Error(`scenario[${index}] (${ev.type}): missing required field "${f}"`);
    }
  }
}

/** Per-type field validation, run AFTER normalizeEvent assigns a `type`. */
export function validateEvent(ev, index) {
  switch (ev.type) {
    case "message":
      requireFields(ev, index, ["text"]);
      if (typeof ev.text !== "string" || ev.text.length === 0) throw new Error(`scenario[${index}] (message): "text" must be a non-empty string`);
      break;
    case "burst": {
      requireFields(ev, index, ["count", "overSeconds"]);
      if (!Number.isInteger(ev.count) || ev.count < 1) throw new Error(`scenario[${index}] (burst): "count" must be a positive integer`);
      if (typeof ev.overSeconds !== "number" || ev.overSeconds < 0) throw new Error(`scenario[${index}] (burst): "overSeconds" must be a non-negative number`);
      if (ev.texts !== undefined) {
        if (!Array.isArray(ev.texts) || ev.texts.length !== ev.count) {
          throw new Error(`scenario[${index}] (burst): "texts" must be an array of exactly "count" (${ev.count}) strings`);
        }
      } else if (typeof ev.textTemplate !== "string" || ev.textTemplate.length === 0) {
        throw new Error(`scenario[${index}] (burst): either "texts" (array of "count" strings) or "textTemplate" (containing "{n}") is required`);
      }
      break;
    }
    case "model-fault":
      requireFields(ev, index, ["faultType", "count"]);
      if (!MODEL_FAULT_TYPES.has(ev.faultType)) {
        throw new Error(`scenario[${index}] (model-fault): "faultType" must be one of ${Array.from(MODEL_FAULT_TYPES).join(", ")}, got ${JSON.stringify(ev.faultType)}`);
      }
      if (!Number.isInteger(ev.count) || ev.count < 1) throw new Error(`scenario[${index}] (model-fault): "count" must be a positive integer`);
      break;
    case "quiet":
      requireFields(ev, index, ["minutes"]);
      if (typeof ev.minutes !== "number" || ev.minutes <= 0) throw new Error(`scenario[${index}] (quiet): "minutes" must be a positive number`);
      break;
    case "second-identity":
      requireFields(ev, index, ["name"]);
      if (typeof ev.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(ev.name)) {
        throw new Error(`scenario[${index}] (second-identity): "name" must be a lowercase identity-safe slug, got ${JSON.stringify(ev.name)}`);
      }
      break;
    case "thinkers-stop":
    case "thinkers-start":
    case "dispatcher-sigterm":
    case "dispatcher-sigkill":
    case "step-sigkill":
    case "docker-pause":
    case "docker-unpause":
      break; // atMinutes is the only required field, already checked
    default:
      throw new Error(`scenario[${index}]: unreachable — unknown event type ${ev.type}`);
  }
  return ev;
}

/**
 * Replace each `burst` event with `count` concrete `message` events spread
 * evenly across `overSeconds`, starting at the burst's own `atMinutes`. The
 * first message fires at `atMinutes` exactly (offset 0); the rest are spaced
 * `overSeconds / (count - 1)` apart (or all at the start instant if
 * count === 1 or overSeconds === 0). Every expanded message carries
 * `burstId` (the burst's index in the input array) and `burstIndex` (its
 * 1-based position within the burst) so a report can group them back
 * together. Non-burst events pass through unchanged.
 */
export function expandBursts(events) {
  const out = [];
  events.forEach((ev, burstId) => {
    if (ev.type !== "burst") {
      out.push(ev);
      return;
    }
    const { count, overSeconds, from, to, textTemplate, texts } = ev;
    const step = count > 1 && overSeconds > 0 ? overSeconds / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      const text = texts ? texts[i] : textTemplate.replaceAll("{n}", String(i + 1));
      out.push({
        type: "message",
        atMinutes: ev.atMinutes + (i * step) / 60,
        from,
        to,
        text,
        burstId,
        burstIndex: i + 1,
        burstCount: count,
      });
    }
  });
  return out;
}

/**
 * Parse + normalize + validate a raw scenario (already-JSON.parse'd array),
 * sorted stably by atMinutes (ties keep input order — Array.prototype.sort
 * is stable per spec since ES2019). Bursts are NOT expanded here — that's a
 * separate step (expandBursts) so a report can still show the burst as one
 * logical event when useful. Throws with a scenario-index-prefixed message
 * on the first problem found.
 */
export function parseScenario(raw) {
  if (!Array.isArray(raw)) throw new Error(`scenario must be a JSON array of events, got ${typeof raw}`);
  const events = raw.map((r, i) => validateEvent(normalizeEvent(r, i), i));
  return events.slice().sort((a, b) => a.atMinutes - b.atMinutes);
}

/**
 * Validate cross-event scenario-level invariants that a single event can't
 * check on its own: nothing (not even a scripted message) may be scheduled
 * strictly inside a `quiet` window — that's the entire point of the event
 * (the unprompted-outreach window must actually be quiet). Boundary-touching
 * is allowed (an event AT the window's start or end instant does not
 * count as "inside"). Takes the already-expanded, flattened event list (run
 * it after expandBursts) so a burst can't smuggle messages into a quiet
 * window either. Pure; throws on the first violation found.
 */
export function validateNoOverlapWithQuiet(flatEvents) {
  const quiets = flatEvents.filter((e) => e.type === "quiet");
  for (const q of quiets) {
    const start = q.atMinutes;
    const end = q.atMinutes + q.minutes;
    for (const e of flatEvents) {
      if (e === q || e.type === "quiet") continue;
      if (e.atMinutes > start && e.atMinutes < end) {
        throw new Error(
          `scenario: event ${JSON.stringify({ type: e.type, atMinutes: e.atMinutes })} falls inside the quiet window ` +
            `[${start}, ${end}] minutes starting at atMinutes=${start} — quiet windows must stay empty (the unprompted-outreach window)`
        );
      }
    }
  }
}

/**
 * Full pipeline: parse -> validate types -> expand bursts -> validate quiet
 * windows -> final sort. This is the one function run-sxs.mjs calls; the
 * individual steps above are exported for focused unit testing.
 */
export function compileTimeline(raw) {
  const parsed = parseScenario(raw);
  const expanded = expandBursts(parsed).sort((a, b) => a.atMinutes - b.atMinutes);
  validateNoOverlapWithQuiet(expanded);
  return expanded;
}

/** Total scenario duration implied by its own events (last atMinutes, plus a quiet event's own `minutes`), for a sanity check against `--minutes`. */
export function impliedMinimumMinutes(flatEvents) {
  let max = 0;
  for (const e of flatEvents) {
    const end = e.type === "quiet" ? e.atMinutes + e.minutes : e.atMinutes;
    if (end > max) max = end;
  }
  return max;
}
