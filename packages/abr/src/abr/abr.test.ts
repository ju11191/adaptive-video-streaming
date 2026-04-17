import { describe, expect, it } from 'vitest';
import { BbaRule, bbaChoose, bbaRateMap, DEFAULT_BBA_OPTIONS } from './bba.ts';
import { createAbr } from './registry.ts';
import { harmonicMean, highestRungAtOrBelow, ThroughputRule } from './throughput.ts';
import { type AbrContext, sampleFrom, type Rung } from './types.ts';

const LADDER: Rung[] = [300, 750, 1200, 1850, 2850, 4300].map((kbps, index) => ({
  index,
  kbps,
  width: 0,
  height: 0,
}));

function ctx(over: Partial<AbrContext> = {}): AbrContext {
  return {
    ladder: LADDER,
    segmentDurationS: 4,
    bufferLevelS: 0,
    lastQuality: null,
    throughputHistory: [],
    segmentIndex: 0,
    playing: false,
    ...over,
  };
}
const samples = (...kbps: number[]) => kbps.map((k) => ({ bytes: k * 125, durationMs: 1000, kbps: k }));

describe('harmonic mean', () => {
  it('matches the definition and is dominated by small values', () => {
    expect(harmonicMean([1000, 1000])).toBe(1000);
    expect(harmonicMean([100, 10000])).toBeCloseTo(2 / (1 / 100 + 1 / 10000));
    expect(harmonicMean([100, 10000])).toBeLessThan(200);
    expect(harmonicMean([])).toBe(0);
    expect(harmonicMean([500, 0])).toBe(0);
  });
  it('sampleFrom converts bytes/ms to kbps', () => {
    expect(sampleFrom(125000, 1000).kbps).toBe(1000);
  });
});

describe('ThroughputRule', () => {
  it('starts at the lowest rung without samples', () => {
    expect(new ThroughputRule().choose(ctx())).toBe(0);
  });
  it('picks the highest rung under safety * harmonic mean of the last 5', () => {
    const r = new ThroughputRule({ safety: 0.9, window: 5 });
    // 0.9 * 2100 = 1890 -> 1850 (rung 3)
    expect(r.choose(ctx({ throughputHistory: samples(2100, 2100, 2100) }))).toBe(3);
    // old samples outside the window are ignored
    expect(r.choose(ctx({ throughputHistory: samples(100, 5000, 5000, 5000, 5000, 5000) }))).toBe(5);
    // one slow sample in the window drags the estimate down sharply:
    // HM(5000 x4, 400) = 1515 kbps, x0.9 = 1364 -> 1200 (rung 2)
    expect(r.choose(ctx({ throughputHistory: samples(5000, 5000, 5000, 5000, 400) }))).toBe(2);
    expect(r.estimateKbps(ctx({ throughputHistory: samples(5000, 5000, 5000, 5000, 400) }))).toBeCloseTo(
      0.9 * harmonicMean([5000, 5000, 5000, 5000, 400]),
    );
  });
  it('highestRungAtOrBelow is inclusive and floors at rung 0', () => {
    expect(highestRungAtOrBelow(LADDER, 1200)).toBe(2);
    expect(highestRungAtOrBelow(LADDER, 1199)).toBe(1);
    expect(highestRungAtOrBelow(LADDER, 10)).toBe(0);
    expect(highestRungAtOrBelow(LADDER, 1e9)).toBe(5);
  });
});

describe('BBA rate map and BBA-0', () => {
  const o = DEFAULT_BBA_OPTIONS; // reservoir 10, cushion 40
  it('maps reservoir, cushion and upper region', () => {
    expect(bbaRateMap(0, LADDER, o)).toBe(300);
    expect(bbaRateMap(10, LADDER, o)).toBe(300);
    expect(bbaRateMap(30, LADDER, o)).toBeCloseTo(300 + 4000 * 0.5);
    expect(bbaRateMap(50, LADDER, o)).toBe(4300);
    expect(bbaRateMap(59, LADDER, o)).toBe(4300);
  });
  it('is monotone non-decreasing in buffer level', () => {
    let prev = -1;
    for (let b = 0; b <= 60; b += 0.5) {
      const f = bbaRateMap(b, LADDER, o);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
  it('chooses lowest in reservoir and highest above cushion regardless of history', () => {
    expect(bbaChoose(ctx({ bufferLevelS: 5, lastQuality: 5 }), o)).toBe(0);
    expect(bbaChoose(ctx({ bufferLevelS: 55, lastQuality: 0 }), o)).toBe(5);
  });
  it('applies hysteresis: holds the current rung inside the [R-, R+] band', () => {
    // f(30) = 2300: between rung3 (1850) and rung4 (2850).
    // From rung 3: R+ = 2850 > 2300 and R- = 1200 < 2300 -> stay.
    expect(bbaChoose(ctx({ bufferLevelS: 30, lastQuality: 3 }), o)).toBe(3);
    // From rung 4: R- = 1850 < 2300 -> stay at 4 (would not drop yet).
    expect(bbaChoose(ctx({ bufferLevelS: 30, lastQuality: 4 }), o)).toBe(4);
    // From rung 1: R+ = 1200 <= 2300 -> jump to max{R_i < 2300} = rung 3.
    expect(bbaChoose(ctx({ bufferLevelS: 30, lastQuality: 1 }), o)).toBe(3);
    // From rung 5 at f = 1500 (B = 21): R- = 2850 >= 1500 -> min{R_i > 1500} = rung 3.
    expect(bbaChoose(ctx({ bufferLevelS: 21, lastQuality: 5 }), o)).toBe(3);
  });
  it('plain BBA ignores throughput entirely', () => {
    const r = new BbaRule();
    expect(r.name).toBe('bba');
    expect(r.choose(ctx({ bufferLevelS: 4, throughputHistory: samples(50000) }))).toBe(0);
  });
});

describe('BBA startup guard', () => {
  it('ramps up one rung per segment while throughput allows, then hands over', () => {
    const r = new BbaRule({ startupGuard: true });
    expect(r.name).toBe('bba-guard');
    expect(r.choose(ctx())).toBe(0);
    // 10 Mbps: budget 5000 -> step up one rung at a time
    let q = 0;
    let buffer = 4;
    for (let i = 1; i <= 5; i++) {
      q = r.choose(ctx({ bufferLevelS: buffer, lastQuality: q, throughputHistory: samples(10000), playing: true }));
      expect(q).toBe(i);
      buffer += 3;
    }
    expect(r.startupPhase).toBe(true);
    // Buffer high enough that the map reaches the top -> guard exits.
    q = r.choose(ctx({ bufferLevelS: 52, lastQuality: 5, throughputHistory: samples(10000), playing: true }));
    expect(q).toBe(5);
    expect(r.startupPhase).toBe(false);
  });
  it('exits startup when the buffer shrinks across a download', () => {
    const r = new BbaRule({ startupGuard: true });
    r.choose(ctx({ bufferLevelS: 8, lastQuality: 0, throughputHistory: samples(4000), playing: true }));
    expect(r.startupPhase).toBe(true);
    const q = r.choose(ctx({ bufferLevelS: 6, lastQuality: 1, throughputHistory: samples(4000), playing: true }));
    expect(r.startupPhase).toBe(false);
    expect(q).toBe(0); // falls back to the buffer map (reservoir)
  });
  it('steps down to what the budget allows when throughput collapses during startup', () => {
    const r = new BbaRule({ startupGuard: true });
    const q = r.choose(ctx({ bufferLevelS: 4, lastQuality: 3, throughputHistory: samples(2000) }));
    expect(q).toBe(1); // budget 1000 -> 750
  });
  it('reset() restores the startup phase', () => {
    const r = new BbaRule({ startupGuard: true });
    r.choose(ctx({ bufferLevelS: 8, lastQuality: 0, throughputHistory: samples(4000), playing: true }));
    r.choose(ctx({ bufferLevelS: 6, lastQuality: 1, throughputHistory: samples(4000), playing: true }));
    expect(r.startupPhase).toBe(false);
    r.reset();
    expect(r.startupPhase).toBe(true);
  });
});

describe('registry', () => {
  it('creates each algorithm by name', () => {
    expect(createAbr('throughput').name).toBe('throughput');
    expect(createAbr('bba').name).toBe('bba');
    expect(createAbr('bba-guard').name).toBe('bba-guard');
  });
});

describe('createAbrFromSpec', () => {
  it('parses parameters and rejects unknown ones', async () => {
    const { createAbrFromSpec } = await import('./registry.ts');
    expect(createAbrFromSpec('bba').name).toBe('bba');
    const a = createAbrFromSpec('bba:reservoirS=5,cushionS=20');
    expect(a.name).toBe('bba:reservoirS=5,cushionS=20');
    // reservoir 5: at 6 s of buffer, f > R_min so with last=0 and f(6)=500 -> stays 0; at 25 -> top
    expect(a.choose(ctx({ bufferLevelS: 25.1, lastQuality: 0 }))).toBe(5);
    expect(() => createAbrFromSpec('bba:safety=1')).toThrow();
    expect(() => createAbrFromSpec('nope')).toThrow();
    expect(() => createAbrFromSpec('throughput:safety=x')).toThrow();
  });
});
