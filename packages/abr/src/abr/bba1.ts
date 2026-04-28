import { harmonicMean } from './throughput.ts';
import { type AbrAlgorithm, type AbrContext, segmentSize } from './types.ts';

/** BBA-1 parameters. Defaults are the paper's (Huang et al. 2014, §5) scaled to a 60 s buffer. */
export interface Bba1Options {
  /** Look-ahead horizon X for the reservoir sum (paper: 2 x buffer). */
  lookaheadS: number;
  /** Reservoir clamp (paper: [8 s, 140 s] for a 240 s buffer). */
  reservoirMinS: number;
  reservoirMaxS: number;
  /** Buffer level where the chunk map reaches Chunk_max (paper's BBA-0: 90% of the buffer). */
  cushionEndS: number;
  /** 1: assume capacity min(R_min, harmonic-mean estimate) instead of R_min. Not in the paper. */
  useEstimate: number;
  /** 1: ignore real segment sizes and use nominal kbps x duration (ablation of VBR awareness). */
  nominalSizes: number;
}

export const DEFAULT_BBA1_OPTIONS: Bba1Options = {
  lookaheadS: 120,
  reservoirMinS: 8,
  reservoirMaxS: 35,
  cushionEndS: 54,
  useEstimate: 0,
  nominalSizes: 0,
};

/** Mean segment size (bytes) of every rung over the whole presentation. */
export function meanChunkBytes(ctx: AbrContext): number[] {
  const n = ctx.segmentBytes && ctx.segmentCount !== undefined ? ctx.segmentCount : 1;
  return ctx.ladder.map((_, r) => {
    let s = 0;
    for (let k = 0; k < n; k++) s += segmentSize(ctx, r, k);
    return s / n;
  });
}

/**
 * Dynamic reservoir (§5.1): buffer drained minus buffer resupplied while downloading the next
 * X seconds of R_min chunks at capacity c, i.e. sum_k (Chunk[0][k] / c - V), clamped.
 */
export function bba1Reservoir(ctx: AbrContext, o: Bba1Options): number {
  const V = ctx.segmentDurationS;
  let capKbps = ctx.ladder[0]!.kbps;
  if (o.useEstimate) {
    const est = harmonicMean(ctx.throughputHistory.slice(-5).map((s) => s.kbps));
    if (ctx.throughputHistory.length > 0) capKbps = Math.min(capKbps, Math.max(est, 1e-3));
  }
  const horizon = Math.ceil(o.lookaheadS / V);
  const end = Math.min(ctx.segmentIndex + horizon, ctx.segmentCount ?? Infinity);
  let r = 0;
  for (let k = ctx.segmentIndex; k < end; k++) {
    r += (segmentSize(ctx, 0, k) * 8) / 1000 / capKbps - V;
  }
  return Math.max(o.reservoirMinS, Math.min(o.reservoirMaxS, r));
}

/** Chunk map (§5.2): max allowed chunk size, linear from Chunk_min at r to Chunk_max at the cushion end. */
export function bba1ChunkMap(bufferS: number, reservoirS: number, means: readonly number[], o: Bba1Options): number {
  const cMin = means[0]!;
  const cMax = means[means.length - 1]!;
  if (bufferS <= reservoirS) return cMin;
  if (bufferS >= o.cushionEndS) return cMax;
  return cMin + ((cMax - cMin) * (bufferS - reservoirS)) / (o.cushionEndS - reservoirS);
}

/** Algorithm 1 generalised to chunk sizes: compares f(B) with the *upcoming* chunk at each rung. */
export function bba1Choose(ctx: AbrContext, o: Bba1Options, means: readonly number[]): number {
  const top = ctx.ladder.length - 1;
  const b = ctx.bufferLevelS;
  const prev = ctx.lastQuality ?? 0;
  const r = bba1Reservoir(ctx, o);
  if (b <= r) return 0;
  if (b >= o.cushionEndS) return top;
  const f = bba1ChunkMap(b, r, means, o);
  const k = ctx.segmentIndex;
  const size = (i: number) => segmentSize(ctx, i, k);
  const cPlus = prev === top ? Infinity : size(prev + 1);
  const cMinus = prev === 0 ? -Infinity : size(prev - 1);
  if (f >= cPlus) {
    let q = prev;
    for (let i = prev; i <= top; i++) if (size(i) < f) q = i;
    return q;
  }
  if (f <= cMinus) {
    for (let i = 0; i <= prev; i++) if (size(i) > f) return i;
    return prev;
  }
  return prev;
}

export class Bba1Rule implements AbrAlgorithm {
  readonly name = 'bba1';
  private readonly opts: Bba1Options;
  private meansFor: AbrContext['segmentBytes'] | null = null;
  private means: number[] = [];

  constructor(opts: Partial<Bba1Options> = {}) {
    this.opts = { ...DEFAULT_BBA1_OPTIONS, ...opts };
    if (!(this.opts.cushionEndS > this.opts.reservoirMaxS)) {
      throw new Error('bba1: cushionEndS must exceed reservoirMaxS');
    }
  }

  get options(): Readonly<Bba1Options> {
    return this.opts;
  }

  choose(input: AbrContext): number {
    const ctx = this.opts.nominalSizes ? { ...input, segmentBytes: undefined } : input;
    // Chunk_min / Chunk_max depend only on the content; compute once per video.
    if (this.means.length !== ctx.ladder.length || this.meansFor !== ctx.segmentBytes) {
      this.means = meanChunkBytes(ctx);
      this.meansFor = ctx.segmentBytes;
    }
    return bba1Choose(ctx, this.opts, this.means);
  }

  reset(): void {}
}
