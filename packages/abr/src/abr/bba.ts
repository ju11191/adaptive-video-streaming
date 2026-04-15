import { highestRungAtOrBelow } from './throughput.ts';
import type { AbrAlgorithm, AbrContext, Rung } from './types.ts';

export interface BbaOptions {
  /** Below this buffer level always pick the lowest rung. */
  reservoirS: number;
  /** Buffer range over which the rate map rises linearly from R_min to R_max. */
  cushionS: number;
  /** Enable the BBA-2-style startup ramp that may out-run the buffer map. */
  startupGuard: boolean;
  /** Guard steps up only while the next rung <= guardSafety * last throughput. */
  guardSafety: number;
}

export const DEFAULT_BBA_OPTIONS: BbaOptions = {
  reservoirS: 10,
  cushionS: 40,
  startupGuard: false,
  guardSafety: 0.5,
};

/** BBA rate map f(B): R_min up to the reservoir, linear across the cushion, then R_max. */
export function bbaRateMap(bufferS: number, ladder: readonly Rung[], o: BbaOptions): number {
  const rMin = ladder[0]!.kbps;
  const rMax = ladder[ladder.length - 1]!.kbps;
  if (bufferS <= o.reservoirS) return rMin;
  if (bufferS >= o.reservoirS + o.cushionS) return rMax;
  return rMin + ((rMax - rMin) * (bufferS - o.reservoirS)) / o.cushionS;
}

/**
 * BBA-0 (Huang et al., SIGCOMM 2014) with the paper's hysteresis: move up only when f(B)
 * passes the next rung, move down only when it drops below the next-lower rung.
 */
export function bbaChoose(ctx: AbrContext, o: BbaOptions): number {
  const { ladder, bufferLevelS: b } = ctx;
  const top = ladder.length - 1;
  const prev = ctx.lastQuality ?? 0;
  if (b <= o.reservoirS) return 0;
  if (b >= o.reservoirS + o.cushionS) return top;
  const f = bbaRateMap(b, ladder, o);
  const rPlus = prev === top ? Infinity : ladder[prev + 1]!.kbps;
  const rMinus = prev === 0 ? -Infinity : ladder[prev - 1]!.kbps;
  if (f >= rPlus) {
    // max{ i : R_i < f(B) }
    let q = prev;
    for (let i = prev; i <= top; i++) if (ladder[i]!.kbps < f) q = i;
    return q;
  }
  if (f <= rMinus) {
    // min{ i : R_i > f(B) }
    for (let i = 0; i <= prev; i++) if (ladder[i]!.kbps > f) return i;
    return prev;
  }
  return prev;
}

export class BbaRule implements AbrAlgorithm {
  readonly name: string;
  private readonly opts: BbaOptions;
  private inStartup = true;
  private lastBuffer: number | null = null;

  constructor(opts: Partial<BbaOptions> = {}) {
    this.opts = { ...DEFAULT_BBA_OPTIONS, ...opts };
    this.name = this.opts.startupGuard ? 'bba-guard' : 'bba';
  }

  get startupPhase(): boolean {
    return this.opts.startupGuard && this.inStartup;
  }

  choose(ctx: AbrContext): number {
    const mapped = bbaChoose(ctx, this.opts);
    if (!this.opts.startupGuard || !this.inStartup) {
      this.lastBuffer = ctx.bufferLevelS;
      return mapped;
    }
    // Leave startup once the buffer shrank across a download (unsustainable rate).
    const shrank = this.lastBuffer !== null && ctx.playing && ctx.bufferLevelS < this.lastBuffer;
    this.lastBuffer = ctx.bufferLevelS;
    const last = ctx.throughputHistory[ctx.throughputHistory.length - 1];
    if (shrank || last === undefined) {
      if (shrank) this.inStartup = false;
      return mapped;
    }
    const prev = ctx.lastQuality ?? 0;
    const budget = this.opts.guardSafety * last.kbps;
    let guard: number;
    if (prev + 1 < ctx.ladder.length && ctx.ladder[prev + 1]!.kbps <= budget) guard = prev + 1;
    else if (ctx.ladder[prev]!.kbps <= budget) guard = prev;
    else guard = highestRungAtOrBelow(ctx.ladder, budget);
    // Leave startup once the buffer map has caught up with the ramp.
    if (mapped >= guard) {
      this.inStartup = false;
      return mapped;
    }
    return guard;
  }

  reset(): void {
    this.inStartup = true;
    this.lastBuffer = null;
  }
}
