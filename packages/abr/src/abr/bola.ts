import { ThroughputRule } from './throughput.ts';
import type { AbrAlgorithm, AbrContext, Rung } from './types.ts';

/**
 * BOLA (Spiteri, Urgaonkar, Sitaraman, INFOCOM 2016). Buffer levels are in seconds.
 */
export interface BolaOptions {
  /** Buffer level below which the lowest rung is chosen (paper §VI-B; dash.js MINIMUM_BUFFER_S). */
  qLowS: number;
  /** No-download threshold V(v_M + gp). 0: derive as maxBufferS - one segment (paper §IV-B). */
  qMaxS: number;
  /** 0: derive gp from qLowS (§VI-B). > 0: fix gp and set V = qMax / (v_M + gp) (§IV-B form). */
  gammaP: number;
}

export const DEFAULT_BOLA_OPTIONS: BolaOptions = { qLowS: 10, qMaxS: 0, gammaP: 0 };

/** Used when the context carries no buffer cap. */
const FALLBACK_MAX_BUFFER_S = 60;

export interface BolaParams {
  /** v_m = ln(S_m / S_1); v_0 = 0. */
  utilities: number[];
  /** Nominal sizes (kbps; only ratios matter). */
  sizes: number[];
  V: number;
  gp: number;
}

export function bolaQMax(ctx: AbrContext, o: BolaOptions): number {
  if (o.qMaxS > 0) return o.qMaxS;
  return (ctx.maxBufferS ?? FALLBACK_MAX_BUFFER_S) - ctx.segmentDurationS;
}

/**
 * Solves V(v_M + gp) = qMax and V(gp - a) = qLow, where qLow is the buffer level at which
 * rungs 0 and 1 have equal score and a = (S_1 v_2 - S_2 v_1) / (S_2 - S_1).
 */
export function bolaParams(ladder: readonly Rung[], qLowS: number, qMaxS: number, gammaP = 0): BolaParams {
  const sizes = ladder.map((r) => r.kbps);
  const utilities = sizes.map((s) => Math.log(s / sizes[0]!));
  const vM = utilities[utilities.length - 1]!;
  if (ladder.length < 2) return { utilities, sizes, V: qMaxS, gp: 1 };
  if (gammaP > 0) return { utilities, sizes, V: qMaxS / (vM + gammaP), gp: gammaP };
  if (!(qLowS > 0 && qLowS < qMaxS)) throw new Error(`bola: need 0 < qLowS (${qLowS}) < qMaxS (${qMaxS})`);
  const [s1, s2] = sizes as [number, number];
  const a = (s1 * utilities[1]! - s2 * utilities[0]!) / (s2 - s1);
  const V = (qMaxS - qLowS) / (vM + a);
  return { utilities, sizes, V, gp: qMaxS / V - vM };
}

export function bolaScore(p: BolaParams, m: number, bufferS: number): number {
  return (p.V * (p.utilities[m]! + p.gp) - bufferS) / p.sizes[m]!;
}

/**
 * BOLA-BASIC decision: argmax_m score (ties to the higher rung, as dash.js). If no score is
 * positive BOLA would wait; the caller has no "wait" outcome, so return the top rung there.
 */
export function bolaQuality(p: BolaParams, bufferS: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let m = 0; m < p.sizes.length; m++) {
    const s = bolaScore(p, m, bufferS);
    if (s >= bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return bestScore > 0 ? best : p.sizes.length - 1;
}

/** Buffer level above which BOLA would rather wait than download rung q: V(v_q + gp). */
export function maxBufferLevelForQuality(p: BolaParams, q: number): number {
  return p.V * (p.utilities[q]! + p.gp);
}

/** Lowest buffer level at which rung q's score beats every lower rung (dash.js). */
export function minBufferLevelForQuality(p: BolaParams, q: number): number {
  const sq = p.sizes[q]!;
  const vq = p.utilities[q]!;
  let min = 0;
  for (let i = q - 1; i >= 0; i--) {
    if (p.utilities[i]! < vq) {
      const si = p.sizes[i]!;
      const vi = p.utilities[i]!;
      min = Math.max(min, p.V * (p.gp + (sq * vi - si * vq) / (sq - si)));
    }
  }
  return min;
}

/** Caches parameters per (ladder, qMax) so a session derives them once. */
class ParamCache {
  private key = '';
  private p: BolaParams | null = null;
  constructor(private readonly o: BolaOptions) {}
  get(ctx: AbrContext): BolaParams {
    const qMax = bolaQMax(ctx, this.o);
    const key = `${qMax}|${ctx.ladder.map((r) => r.kbps).join(',')}`;
    if (key !== this.key || !this.p) {
      this.p = bolaParams(ctx.ladder, this.o.qLowS, qMax, this.o.gammaP);
      this.key = key;
    }
    return this.p;
  }
}

/** BOLA-BASIC: a pure function of the buffer level. */
export class BolaRule implements AbrAlgorithm {
  readonly name = 'bola';
  private readonly params: ParamCache;

  constructor(opts: Partial<BolaOptions> = {}) {
    this.params = new ParamCache({ ...DEFAULT_BOLA_OPTIONS, ...opts });
  }

  paramsFor(ctx: AbrContext): BolaParams {
    return this.params.get(ctx);
  }

  choose(ctx: AbrContext): number {
    return bolaQuality(this.params.get(ctx), ctx.bufferLevelS);
  }

  reset(): void {}
}

/** dash.js PLACEHOLDER_BUFFER_DECAY, applied once per downloaded segment. */
export const PLACEHOLDER_BUFFER_DECAY = 0.99;

/**
 * BOLA-E as in dash.js BolaRule: throughput-based startup with a placeholder ("virtual") buffer,
 * BOLA on buffer + placeholder in steady state, BOLA-O up-switch cap, and placeholder reset on
 * rebuffering.
 */
export class BolaERule implements AbrAlgorithm {
  readonly name = 'bola-e';
  private readonly params: ParamCache;
  private readonly tput = new ThroughputRule();
  private steady = false;
  private placeholder = 0;
  private lastQ: number | null = null;
  private bufferAtLastRequest = 0;
  private lastRebufferCount = 0;

  constructor(opts: Partial<BolaOptions> = {}) {
    this.params = new ParamCache({ ...DEFAULT_BOLA_OPTIONS, ...opts });
  }

  get state(): { steady: boolean; placeholderS: number } {
    return { steady: this.steady, placeholderS: this.placeholder };
  }

  paramsFor(ctx: AbrContext): BolaParams {
    return this.params.get(ctx);
  }

  choose(ctx: AbrContext): number {
    const p = this.params.get(ctx);
    const b = ctx.bufferLevelS;
    if (this.lastQ !== null) {
      // checkNewSegment: decay, then cap by what the last segment's rung could justify.
      this.placeholder *= PLACEHOLDER_BUFFER_DECAY;
      const cap = Math.max(0, maxBufferLevelForQuality(p, this.lastQ) - this.bufferAtLastRequest);
      this.placeholder = Math.min(this.placeholder, cap);
    }
    const rc = ctx.rebufferCount ?? 0;
    if (this.steady && rc > this.lastRebufferCount) this.placeholder = 0; // onBufferEmpty
    this.lastRebufferCount = rc;

    const est = this.tput.estimateKbps(ctx);
    const qTput = this.tput.choose(ctx);
    let q: number;
    if (!this.steady) {
      q = est === null ? 0 : qTput;
      if (est !== null) this.placeholder = Math.max(0, minBufferLevelForQuality(p, q) - b);
      if (b >= ctx.segmentDurationS) this.steady = true;
    } else {
      q = bolaQuality(p, b + this.placeholder);
      // BOLA-O: never up-switch to a rung the throughput cannot sustain (but do not drop below last).
      if (this.lastQ !== null && q > this.lastQ && q > qTput) q = Math.max(qTput, this.lastQ);
      // Excess buffer for the chosen rung is taken out of the placeholder first.
      const delay = Math.max(0, b + this.placeholder - maxBufferLevelForQuality(p, q));
      this.placeholder = delay <= this.placeholder ? this.placeholder - delay : 0;
    }
    this.lastQ = q;
    this.bufferAtLastRequest = b;
    return q;
  }

  reset(): void {
    this.steady = false;
    this.placeholder = 0;
    this.lastQ = null;
    this.bufferAtLastRequest = 0;
    this.lastRebufferCount = 0;
  }
}
