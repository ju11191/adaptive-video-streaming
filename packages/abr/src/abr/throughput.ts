import type { AbrAlgorithm, AbrContext, Rung } from './types.ts';

export interface ThroughputRuleOptions {
  /** Number of most recent samples in the estimate. */
  window: number;
  /** Multiplier applied to the estimate (< 1 leaves headroom). */
  safety: number;
}

export const DEFAULT_THROUGHPUT_OPTIONS: ThroughputRuleOptions = { window: 5, safety: 0.9 };

/** Harmonic mean: n / sum(1/x). Dominated by the smallest values, so robust to spikes. */
export function harmonicMean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let inv = 0;
  for (const x of xs) {
    if (!(x > 0)) return 0; // a zero-throughput sample means "no capacity"
    inv += 1 / x;
  }
  return xs.length / inv;
}

/** Highest rung whose bitrate is <= kbps; rung 0 if none fits. */
export function highestRungAtOrBelow(ladder: readonly Rung[], kbps: number): number {
  let q = 0;
  for (let i = 0; i < ladder.length; i++) {
    if (ladder[i]!.kbps <= kbps) q = i;
  }
  return q;
}

/** Rate-based baseline: harmonic mean of the last `window` throughputs times `safety`. */
export class ThroughputRule implements AbrAlgorithm {
  readonly name = 'throughput';
  private readonly opts: ThroughputRuleOptions;

  constructor(opts: Partial<ThroughputRuleOptions> = {}) {
    this.opts = { ...DEFAULT_THROUGHPUT_OPTIONS, ...opts };
  }

  estimateKbps(ctx: AbrContext): number | null {
    const recent = ctx.throughputHistory.slice(-this.opts.window);
    if (recent.length === 0) return null;
    return harmonicMean(recent.map((s) => s.kbps)) * this.opts.safety;
  }

  choose(ctx: AbrContext): number {
    const est = this.estimateKbps(ctx);
    if (est === null) return 0;
    return highestRungAtOrBelow(ctx.ladder, est);
  }

  reset(): void {}
}
