/** Small, dependency-free statistics helpers for benchmarks (deterministic given a seed). */

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN;
}

/** Linear-interpolated quantile (type 7, as numpy's default). */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export interface Interval {
  estimate: number;
  lo: number;
  hi: number;
}

/**
 * Percentile bootstrap CI for a statistic of paired per-unit data. `stat` receives the
 * resampled indices so it can compute paired quantities (e.g. ratio of means).
 */
export function bootstrapCI(
  n: number,
  stat: (idx: readonly number[]) => number,
  opts: { resamples?: number; level?: number; seed?: number } = {},
): Interval {
  const B = opts.resamples ?? 10000;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 12345);
  const all = Array.from({ length: n }, (_, i) => i);
  const estimate = stat(all);
  const stats: number[] = [];
  const idx = new Array<number>(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * n);
    const v = stat(idx);
    if (Number.isFinite(v)) stats.push(v);
  }
  return {
    estimate,
    lo: quantile(stats, (1 - level) / 2),
    hi: quantile(stats, 1 - (1 - level) / 2),
  };
}
