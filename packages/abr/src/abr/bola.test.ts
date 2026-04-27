import { describe, expect, it } from 'vitest';
import {
  BolaERule,
  bolaParams,
  bolaQuality,
  BolaRule,
  bolaScore,
  maxBufferLevelForQuality,
  minBufferLevelForQuality,
} from './bola.ts';
import { createAbrFromSpec } from './registry.ts';
import type { AbrContext, Rung } from './types.ts';

const LADDER: Rung[] = [300, 750, 1200, 1850, 2850, 4300].map((kbps, index) => ({ index, kbps, width: 0, height: 0 }));
const TOP = LADDER.length - 1;

function ctx(over: Partial<AbrContext> = {}): AbrContext {
  return {
    ladder: LADDER,
    segmentDurationS: 4,
    bufferLevelS: 0,
    lastQuality: null,
    throughputHistory: [],
    segmentIndex: 0,
    playing: true,
    maxBufferS: 60,
    rebufferCount: 0,
    ...over,
  };
}
const samples = (...kbps: number[]) => kbps.map((k) => ({ bytes: k * 125, durationMs: 1000, kbps: k }));

describe('BOLA parameters (paper §IV-B / §VI-B)', () => {
  const p = bolaParams(LADDER, 10, 56);
  it('uses log utilities normalised to v_1 = 0', () => {
    expect(p.utilities[0]).toBe(0);
    expect(p.utilities[TOP]).toBeCloseTo(Math.log(4300 / 300));
  });
  it('rungs 0 and 1 tie exactly at Q_low', () => {
    expect(bolaScore(p, 0, 10)).toBeCloseTo(bolaScore(p, 1, 10), 12);
    expect(minBufferLevelForQuality(p, 1)).toBeCloseTo(10, 9);
  });
  it('every score is <= 0 at Q_max (no download) and the top rung reaches 0 exactly there', () => {
    expect(maxBufferLevelForQuality(p, TOP)).toBeCloseTo(56, 9);
    for (let m = 0; m <= TOP; m++) expect(bolaScore(p, m, 56)).toBeLessThanOrEqual(1e-12);
    expect(bolaQuality(p, 55.9)).toBe(TOP);
  });
  it('§IV-B form with a fixed gamma*p: V = Q_max / (v_M + gp)', () => {
    const q = bolaParams(LADDER, 10, 56, 5);
    expect(q.gp).toBe(5);
    expect(q.V).toBeCloseTo(56 / (Math.log(4300 / 300) + 5));
    expect(maxBufferLevelForQuality(q, TOP)).toBeCloseTo(56);
  });
  it('rejects Q_low outside (0, Q_max)', () => {
    expect(() => bolaParams(LADDER, 60, 56)).toThrow();
    expect(() => bolaParams(LADDER, 0, 56)).toThrow();
  });
  it('a single-rung ladder always chooses rung 0', () => {
    const one = bolaParams(LADDER.slice(0, 1), 10, 56);
    expect(bolaQuality(one, 0)).toBe(0);
    expect(bolaQuality(one, 50)).toBe(0);
  });
});

describe('BOLA-BASIC decisions', () => {
  const bola = new BolaRule();
  const at = (b: number, over: Partial<AbrContext> = {}) => bola.choose(ctx({ bufferLevelS: b, ...over }));
  it('startup: lowest rung with an empty buffer and anywhere below Q_low', () => {
    expect(at(0)).toBe(0);
    expect(at(9.99)).toBe(0);
    expect(at(10.01)).toBe(1);
  });
  it('is monotone non-decreasing in buffer level and reaches the top before Q_max', () => {
    let last = -1;
    for (let b = 0; b <= 56; b += 0.1) {
      const q = at(b);
      expect(q).toBeGreaterThanOrEqual(last);
      last = q;
    }
    expect(last).toBe(TOP);
  });
  it('switches exactly at minBufferLevelForQuality', () => {
    const p = bola.paramsFor(ctx());
    for (let q = 1; q <= TOP; q++) {
      const t = minBufferLevelForQuality(p, q);
      expect(at(t - 1e-6)).toBe(q - 1);
      expect(at(t + 1e-6)).toBe(q);
    }
  });
  it('stays inside the ladder for any buffer, including the no-download region', () => {
    for (const b of [-1, 0, 56, 60, 1e6]) {
      const q = at(b);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(TOP);
    }
    expect(at(60)).toBe(TOP);
  });
  it('derives Q_max from the context buffer cap (one segment of room)', () => {
    const p = new BolaRule().paramsFor(ctx({ maxBufferS: 30 }));
    expect(maxBufferLevelForQuality(p, TOP)).toBeCloseTo(26);
    expect(new BolaRule().choose(ctx({ maxBufferS: 30, bufferLevelS: 25.9 }))).toBe(TOP);
    expect(new BolaRule().choose(ctx({ maxBufferS: 60, bufferLevelS: 25.9 }))).toBeLessThan(TOP);
  });
  it('ignores throughput and history', () => {
    expect(at(5, { throughputHistory: samples(50000), lastQuality: 5 })).toBe(0);
  });
});

describe('BOLA-E (dash.js-style placeholder, BOLA-O)', () => {
  it('startup with no throughput sample picks the lowest rung', () => {
    const r = new BolaERule();
    expect(r.choose(ctx({ playing: false }))).toBe(0);
    expect(r.state.steady).toBe(false);
  });
  it('startup uses the throughput rung and sets a placeholder that sustains it', () => {
    const r = new BolaERule();
    r.choose(ctx({ playing: false }));
    // 10 Mbps x 0.9 -> top rung; buffer 4 s = one segment -> leaves startup afterwards.
    const q = r.choose(ctx({ bufferLevelS: 4, lastQuality: 0, throughputHistory: samples(10000) }));
    expect(q).toBe(TOP);
    const p = r.paramsFor(ctx());
    expect(r.state.placeholderS).toBeCloseTo(minBufferLevelForQuality(p, TOP) - 4);
    expect(r.state.steady).toBe(true);
    // Steady: BOLA on buffer + placeholder keeps the top rung where BOLA-BASIC would pick rung 0.
    const next = r.choose(ctx({ bufferLevelS: 7, lastQuality: TOP, throughputHistory: samples(10000, 10000) }));
    expect(next).toBe(TOP);
    expect(new BolaRule().choose(ctx({ bufferLevelS: 7 }))).toBe(0);
  });
  it('BOLA-O caps an up-switch at max(throughput rung, last) but never forces a drop', () => {
    const r = new BolaERule();
    r.choose(ctx({ playing: false }));
    r.choose(ctx({ bufferLevelS: 4, lastQuality: 0, throughputHistory: samples(400) })); // q 0, P 0
    // Buffer says top, throughput 1400 x 0.9 = 1260 -> rung 2: capped to 2.
    expect(r.choose(ctx({ bufferLevelS: 50, lastQuality: 0, throughputHistory: samples(1400) }))).toBe(2);
    // From rung 2 with throughput now only good for rung 0: BOLA still says top, so keep last (2).
    expect(r.choose(ctx({ bufferLevelS: 50, lastQuality: 2, throughputHistory: samples(300) }))).toBe(2);
  });
  it('a rebuffer in steady state clears the placeholder', () => {
    const r = new BolaERule();
    r.choose(ctx({ playing: false }));
    r.choose(ctx({ bufferLevelS: 4, lastQuality: 0, throughputHistory: samples(10000) }));
    expect(r.state.placeholderS).toBeGreaterThan(0);
    const q = r.choose(ctx({ bufferLevelS: 4, lastQuality: TOP, throughputHistory: samples(10000, 200), rebufferCount: 1 }));
    expect(r.state.placeholderS).toBe(0);
    expect(q).toBe(0); // BOLA on the real 4 s buffer
  });
  it('placeholder decays per segment and is absorbed by excess buffer', () => {
    const r = new BolaERule();
    r.choose(ctx({ playing: false }));
    r.choose(ctx({ bufferLevelS: 4, lastQuality: 0, throughputHistory: samples(10000) }));
    const p0 = r.state.placeholderS;
    r.choose(ctx({ bufferLevelS: 4, lastQuality: TOP, throughputHistory: samples(10000, 10000) }));
    expect(r.state.placeholderS).toBeCloseTo(p0 * 0.99);
    // A buffer near Q_max: B + P exceeds V(v_top + gp) = 56, so the placeholder shrinks to fit.
    r.choose(ctx({ bufferLevelS: 50, lastQuality: TOP, throughputHistory: samples(10000, 10000) }));
    expect(50 + r.state.placeholderS).toBeLessThanOrEqual(56 + 1e-9);
  });
  it('steady state with no placeholder and ample throughput equals BOLA-BASIC (monotone in buffer)', () => {
    let last = -1;
    for (let b = 0; b <= 56; b += 0.5) {
      const r = new BolaERule();
      r.choose(ctx({ playing: false }));
      r.choose(ctx({ bufferLevelS: 4, lastQuality: 0, throughputHistory: samples(200) })); // q 0, P 0
      const q = r.choose(ctx({ bufferLevelS: b, lastQuality: 0, throughputHistory: samples(1e6) }));
      expect(q).toBe(new BolaRule().choose(ctx({ bufferLevelS: b })));
      expect(q).toBeGreaterThanOrEqual(last);
      last = q;
    }
  });
  it('stays inside the ladder and reset() restores startup', () => {
    const r = new BolaERule();
    for (const b of [0, 4, 30, 60, 1e6]) {
      const q = r.choose(ctx({ bufferLevelS: b, throughputHistory: samples(1e7) }));
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(TOP);
    }
    expect(r.state.steady).toBe(true);
    r.reset();
    expect(r.state).toEqual({ steady: false, placeholderS: 0 });
  });
});

describe('BOLA registry', () => {
  it('builds from specs and validates parameters', () => {
    expect(createAbrFromSpec('bola').name).toBe('bola');
    expect(createAbrFromSpec('bola-e').name).toBe('bola-e');
    expect(createAbrFromSpec('bola:qLowS=20').choose(ctx({ bufferLevelS: 15 }))).toBe(0);
    expect(createAbrFromSpec('bola:qLowS=5').choose(ctx({ bufferLevelS: 15 }))).toBeGreaterThan(0);
    expect(() => createAbrFromSpec('bola:reservoirS=1')).toThrow();
  });
});
