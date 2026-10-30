// lib/shrink.mjs — minimal delta-debugging shrinker for a divergence.
// Given a scenario object and a `stillDiverges(scenario) -> boolean` oracle
// (re-runs both tools and re-applies the same comparison + allowances the
// main loop used), tries to produce a smaller argv / seed that still
// reproduces the SAME classification of divergence. Best-effort, bounded by
// a max number of oracle calls so shrinking never dominates the run budget.

// ddmin over an array of "removable units" (argv tokens, byte-fixture list
// entries, seed file entries — whatever the caller packs in). `rebuild(units)`
// turns a candidate subset back into a runnable scenario.
export function ddminArray(units, rebuild, stillDiverges, maxCalls = 40) {
  let calls = 0;
  function tryDiverges(candidateUnits) {
    if (calls >= maxCalls) return false; // budget exhausted -> stop shrinking, keep current
    calls++;
    try {
      return stillDiverges(rebuild(candidateUnits));
    } catch {
      return false; // an error while shrinking is not a reproduction of the ORIGINAL divergence
    }
  }

  let current = units.slice();
  let granularity = 2;
  while (current.length >= 1 && calls < maxCalls) {
    const chunkSize = Math.ceil(current.length / granularity);
    if (chunkSize < 1) break;
    let removedSomething = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = current.slice(0, start).concat(current.slice(start + chunkSize));
      if (candidate.length === current.length) continue;
      if (tryDiverges(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        removedSomething = true;
        break;
      }
    }
    if (!removedSomething) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length || 1);
    }
    if (calls >= maxCalls) break;
  }
  return { units: current, calls };
}

// Try simplifying each remaining string unit toward something shorter/plainer
// (e.g. a hostile byte-fixture name -> try a few "tamer" substitutes) while
// the divergence still reproduces. `alternatives(unit)` yields candidates in
// order from "most simplified" to "closest to original"; first one that
// still diverges wins.
export function shrinkUnits(units, rebuild, stillDiverges, alternatives, maxCalls = 20) {
  let calls = 0;
  let current = units.slice();
  for (let i = 0; i < current.length && calls < maxCalls; i++) {
    const alts = alternatives(current[i]) || [];
    for (const alt of alts) {
      if (calls >= maxCalls) break;
      calls++;
      const candidate = current.slice();
      candidate[i] = alt;
      try {
        if (stillDiverges(rebuild(candidate))) {
          current = candidate;
          break;
        }
      } catch {
        /* not a reproduction */
      }
    }
  }
  return { units: current, calls };
}
