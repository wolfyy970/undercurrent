// backoff.ts — the monolith wake-scheduling ladder (SPEC §3.4;
// thinkers/monolith/step:42-119,371-408).
//
// Quirks are REPLICATED, not fixed (rulebook): the thought-only THOUGHT_CAP
// clamp, the descend-one-level-immediately-on-error rule, the HOLD dwell.

export interface BackoffConfig {
  base: number; // MONOLITH_BACKOFF_BASE, default 5
  factor: number; // MONOLITH_BACKOFF_FACTOR, default 2
  cap: number; // MONOLITH_BACKOFF_CAP, default 300
  hold: number; // MONOLITH_BACKOFF_HOLD, default 3
  thoughtCap: number; // MONOLITH_THOUGHT_CAP, default 60
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  base: 5,
  factor: 2,
  cap: 300,
  hold: 3,
  thoughtCap: 60,
};

/** BackoffConfig from MONOLITH_BACKOFF_{BASE,FACTOR,CAP,HOLD} / MONOLITH_THOUGHT_CAP,
 *  falling back to DEFAULT_BACKOFF per-field for anything unset/non-numeric. */
export function backoffConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackoffConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    base: num(env["MONOLITH_BACKOFF_BASE"], DEFAULT_BACKOFF.base),
    factor: num(env["MONOLITH_BACKOFF_FACTOR"], DEFAULT_BACKOFF.factor),
    cap: num(env["MONOLITH_BACKOFF_CAP"], DEFAULT_BACKOFF.cap),
    hold: num(env["MONOLITH_BACKOFF_HOLD"], DEFAULT_BACKOFF.hold),
    thoughtCap: num(env["MONOLITH_THOUGHT_CAP"], DEFAULT_BACKOFF.thoughtCap),
  };
}

export interface BackoffState {
  level: number;
  ticksAtLevel: number;
  wakesSinceShareHint: number;
}

export interface WakeOutcome {
  wakeMode: "reactive" | "spontaneous";
  didVisible: boolean; // new action/observation/merge/message step
  didThought: boolean; // new thought step
  runErrored: boolean; // shellm returned non-zero
}

/** delay(0)=0; delay(n>=1)=min(BASE*FACTOR^(n-1), CAP)  (_delay_for_level). */
export function delayForLevel(level: number, cfg: BackoffConfig = DEFAULT_BACKOFF): number {
  if (level <= 0) return 0;
  let d = cfg.base;
  let i = 1;
  while (i < level) {
    d = d * cfg.factor;
    if (d >= cfg.cap) {
      d = cfg.cap;
      break;
    }
    i++;
  }
  if (d > cfg.cap) d = cfg.cap;
  return d;
}

export interface BackoffDecision {
  state: BackoffState;
  nextDelay: number;
}

/** Post-wake decision (thinkers/monolith/step:371-408). */
export function decideBackoff(
  prev: BackoffState,
  outcome: WakeOutcome,
  cfg: BackoffConfig = DEFAULT_BACKOFF
): BackoffDecision {
  let { level, ticksAtLevel } = prev;
  const wakesSinceShareHint = prev.wakesSinceShareHint;
  let nextDelay: number;

  if (outcome.wakeMode === "reactive" || outcome.didVisible) {
    // Engaged, or real work → reset to no pause; think again at once.
    level = 0;
    ticksAtLevel = 0;
    nextDelay = 0;
  } else if (outcome.runErrored) {
    // Failed run, no durable step → descend a level immediately (no HOLD).
    if (delayForLevel(level, cfg) < cfg.cap) level = level + 1;
    ticksAtLevel = 0;
    nextDelay = delayForLevel(level, cfg);
  } else {
    // Empty spontaneous wake → dwell, then descend one level.
    ticksAtLevel = ticksAtLevel + 1;
    if (ticksAtLevel >= cfg.hold) {
      if (delayForLevel(level, cfg) < cfg.cap) level = level + 1;
      ticksAtLevel = 0;
    }
    nextDelay = delayForLevel(level, cfg);
    if (outcome.didThought && nextDelay > cfg.thoughtCap) {
      // Thought-only: same ladder, gentler ceiling.
      nextDelay = cfg.thoughtCap;
    }
  }

  return { state: { level, ticksAtLevel, wakesSinceShareHint }, nextDelay };
}
