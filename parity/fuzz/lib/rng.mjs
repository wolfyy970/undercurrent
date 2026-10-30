// lib/rng.mjs — deterministic seeded PRNG (mulberry32) shared by every tool's
// generator, so `--seed N` reproduces byte-identical argv/content across runs
// regardless of tool order or OS.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._rand = mulberry32(this.seed);
  }
  float() {
    return this._rand();
  }
  int(min, max) {
    // inclusive [min, max]
    return min + Math.floor(this._rand() * (max - min + 1));
  }
  bool(p = 0.5) {
    return this._rand() < p;
  }
  pick(arr) {
    return arr[Math.floor(this._rand() * arr.length)];
  }
  pickWeighted(pairs) {
    // pairs: [[value, weight], ...]
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this._rand() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r <= 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this._rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  subset(arr, maxN) {
    const n = this.int(0, Math.min(maxN, arr.length));
    return this.shuffle(arr).slice(0, n);
  }
  // derive an independent child Rng deterministically (for per-invocation sub-streams)
  child(tag) {
    let h = this.seed ^ 0x9e3779b9;
    for (let i = 0; i < tag.length; i++) {
      h = (Math.imul(h ^ tag.charCodeAt(i), 0x01000193)) >>> 0;
    }
    return new Rng(h >>> 0);
  }
}
