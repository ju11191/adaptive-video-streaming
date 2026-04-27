import { describe, expect, it } from 'vitest';
import { Bba1Rule, bba1ChunkMap, bba1Choose, bba1Reservoir, DEFAULT_BBA1_OPTIONS, meanChunkBytes } from './bba1.ts';
import { createAbrFromSpec } from './registry.ts';
import { type AbrContext, type Rung } from './types.ts';

const KBPS = [300, 750, 1200, 1850, 2850, 4300];
const LADDER: Rung[] = KBPS.map((kbps, index) => ({ index, kbps, width: 0, height: 0 }));
const V = 4;
const nominal = (r: number) => (KBPS[r]! * 1000 * V) / 8;
const o = DEFAULT_BBA1_OPTIONS; // lookahead 120 s, reservoir [8, 35] s, cushion end 54 s

function ctx(over: Partial<AbrContext> = {}): AbrContext {
  return {
    ladder: LADDER,
    segmentDurationS: V,
    bufferLevelS: 0,
    lastQuality: null,
    throughputHistory: [],
    segmentIndex: 0,
    playing: true,
    segmentCount: 100,
    segmentBytes: (r) => nominal(r),
    ...over,
  };
}
/** Sizes scaled by `scale(k)` at every rung (a scene that is uniformly more or less complex). */
const scaled = (scale: (k: number) => number) => (r: number, k: number) => nominal(r) * scale(k);

describe('BBA-1 dynamic reservoir (§5.1)', () => {
  it('CBR content needs no reservoir beyond the floor', () => {
    expect(bba1Reservoir(ctx(), o)).toBe(8);
  });
  it('sums (Chunk[0][k] / R_min - V) over the look-ahead', () => {
    // Next 10 chunks are 1.5x average: each drains 6 s and adds 4 s -> +2 s each = 20 s.
    const c = ctx({ segmentBytes: scaled((k) => (k < 10 ? 1.5 : 1)) });
    expect(bba1Reservoir(c, o)).toBeCloseTo(20);
  });
  it('only counts chunks inside the look-ahead window', () => {
    // 1.5x chunks start at index 30: just outside 120 s / 4 s = 30 chunks from index 0.
    const c = ctx({ segmentBytes: scaled((k) => (k >= 30 ? 1.5 : 1)) });
    expect(bba1Reservoir(c, o)).toBe(8);
    expect(bba1Reservoir({ ...c, segmentIndex: 1 }, o)).toBeCloseTo(8); // 1 chunk -> 2 s, floor 8
    expect(bba1Reservoir({ ...c, segmentIndex: 10 }, o)).toBeCloseTo(20); // 10 chunks -> 20 s
  });
  it('stops at the end of the presentation', () => {
    const c = ctx({ segmentCount: 40, segmentBytes: scaled(() => 2), segmentIndex: 30 });
    // 10 remaining chunks x (8 - 4) s = 40 -> clamped to 35
    expect(bba1Reservoir(c, o)).toBe(35);
    expect(bba1Reservoir({ ...c, segmentIndex: 37 }, o)).toBeCloseTo(12); // 3 x 4 s
  });
  it('is clamped to [reservoirMinS, reservoirMaxS]', () => {
    expect(bba1Reservoir(ctx({ segmentBytes: scaled(() => 3) }), o)).toBe(35);
    expect(bba1Reservoir(ctx({ segmentBytes: scaled(() => 0.2) }), o)).toBe(8);
  });
  it('useEstimate=1 assumes min(R_min, estimate): a slow link grows the reservoir', () => {
    const slow = [{ bytes: 1, durationMs: 1, kbps: 150 }];
    const c = ctx({ throughputHistory: slow });
    // CBR at half of R_min: each chunk drains 8 s, adds 4 -> 30 x 4 = 120 -> 35
    expect(bba1Reservoir(c, { ...o, useEstimate: 1 })).toBe(35);
    expect(bba1Reservoir(c, o)).toBe(8); // paper default ignores throughput
    const fast = [{ bytes: 1, durationMs: 1, kbps: 9000 }];
    expect(bba1Reservoir(ctx({ throughputHistory: fast }), { ...o, useEstimate: 1 })).toBe(8);
  });
});

describe('BBA-1 chunk map (§5.2)', () => {
  const means = KBPS.map((_, r) => nominal(r));
  it('runs from mean Chunk_min at the reservoir to mean Chunk_max at the cushion end', () => {
    expect(bba1ChunkMap(0, 8, means, o)).toBe(means[0]);
    expect(bba1ChunkMap(8, 8, means, o)).toBe(means[0]);
    expect(bba1ChunkMap(31, 8, means, o)).toBeCloseTo((means[0]! + means[5]!) / 2);
    expect(bba1ChunkMap(54, 8, means, o)).toBe(means[5]);
    expect(bba1ChunkMap(60, 8, means, o)).toBe(means[5]);
  });
  it('is monotone non-decreasing in buffer level', () => {
    let prev = -1;
    for (let b = 0; b <= 60; b += 0.25) {
      const f = bba1ChunkMap(b, 8, means, o);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
  it('meanChunkBytes averages the real sizes over the presentation', () => {
    const c = ctx({ segmentCount: 4, segmentBytes: scaled((k) => [0.5, 1.5, 1, 1][k]!) });
    expect(meanChunkBytes(c)).toEqual(means);
    // Without real sizes, falls back to nominal bitrate x duration.
    const { segmentBytes: _, ...noSizes } = ctx();
    expect(meanChunkBytes(noSizes)).toEqual(means);
  });
});

describe('BBA-1 rate choice', () => {
  const means = KBPS.map((_, r) => nominal(r));
  const choose = (over: Partial<AbrContext>) => bba1Choose(ctx(over), o, means);
  it('lowest rung at or below the reservoir, top at or above the cushion end, whatever the history', () => {
    expect(choose({ bufferLevelS: 0, lastQuality: 5 })).toBe(0);
    expect(choose({ bufferLevelS: 8, lastQuality: 5 })).toBe(0);
    expect(choose({ bufferLevelS: 54, lastQuality: 0 })).toBe(5);
    expect(choose({ bufferLevelS: 59, lastQuality: 0 })).toBe(5);
  });
  it('startup: first decision with an empty buffer is the lowest rung', () => {
    expect(new Bba1Rule().choose(ctx({ playing: false }))).toBe(0);
  });
  it('is monotone non-decreasing in buffer level for every previous rung', () => {
    for (let prev = 0; prev < LADDER.length; prev++) {
      let last = -1;
      for (let b = 0; b <= 60; b += 0.25) {
        const q = choose({ bufferLevelS: b, lastQuality: prev });
        expect(q).toBeGreaterThanOrEqual(last);
        last = q;
      }
    }
  });
  it('stays inside the ladder for any input', () => {
    for (const b of [-5, 0, 7.99, 8.01, 30, 53.99, 54, 1e6]) {
      for (const prev of [null, 0, 2, 5]) {
        const q = new Bba1Rule().choose(ctx({ bufferLevelS: b, lastQuality: prev }));
        expect(q).toBeGreaterThanOrEqual(0);
        expect(q).toBeLessThanOrEqual(5);
      }
    }
  });
  it('holds the current rung inside the [Chunk-, Chunk+] band (hysteresis)', () => {
    // B = 31: f = (C0 + C5) / 2 = 2300 kbps-equivalent, between rung 3 (1850) and 4 (2850).
    expect(choose({ bufferLevelS: 31, lastQuality: 3 })).toBe(3);
    expect(choose({ bufferLevelS: 31, lastQuality: 4 })).toBe(4);
    expect(choose({ bufferLevelS: 31, lastQuality: 1 })).toBe(3); // jump to max{Chunk_i < f}
    expect(choose({ bufferLevelS: 31, lastQuality: 5 })).toBe(4); // Chunk- = 2850 >= 2300 -> min{Chunk_i > f} = 4
  });
  it('uses the size of the upcoming chunk, not the nominal rate', () => {
    // f = 2300-equivalent. From rung 3, next-higher (rung 4) nominal 2850 blocks the up-switch...
    expect(choose({ bufferLevelS: 31, lastQuality: 3 })).toBe(3);
    // ...but if the upcoming rung-4 chunk is small (a static scene), BBA-1 steps up.
    const small = (r: number, k: number) => (r === 4 && k === 0 ? nominal(4) * 0.7 : nominal(r));
    expect(choose({ bufferLevelS: 31, lastQuality: 3, segmentBytes: small })).toBe(4);
    // A large upcoming rung-2 chunk (2520 > f) crosses the lower barrier: step down to it.
    const big = (r: number, k: number) => (r === 2 && k === 0 ? nominal(2) * 2.1 : nominal(r));
    expect(choose({ bufferLevelS: 31, lastQuality: 3, segmentBytes: big })).toBe(2);
  });
  it('a large upcoming scene right-shifts the map through the reservoir', () => {
    // CBR: r = 8, f(15) ~ 909 kbps-equivalent, inside rung 2's band -> hold rung 2.
    expect(choose({ bufferLevelS: 15, lastQuality: 2 })).toBe(2);
    // 1.5x chunks ahead: reservoir 20 s, so B = 15 is inside it -> lowest rung.
    expect(choose({ bufferLevelS: 15, lastQuality: 2, segmentBytes: scaled((k) => (k < 10 ? 1.5 : 1)) })).toBe(0);
  });
});

describe('BBA-1 registry', () => {
  it('builds from a spec and validates options', () => {
    expect(createAbrFromSpec('bba1').name).toBe('bba1');
    expect(createAbrFromSpec('bba1:reservoirMinS=16,cushionEndS=47').name).toBe('bba1:reservoirMinS=16,cushionEndS=47');
    expect(() => createAbrFromSpec('bba1:reservoirS=5')).toThrow();
    expect(() => createAbrFromSpec('bba1:cushionEndS=30')).toThrow(); // <= reservoirMaxS
  });
});
