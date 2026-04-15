import { describe, expect, it } from 'vitest';
import { Trace } from './trace.ts';

const MB = 1e6;

describe('Trace (mirrors cpp/shaper tests)', () => {
  it('parses, rebases and wraps', () => {
    const t = Trace.parse('# c\n10 8\n11 16\n13 0\n');
    expect(t.samples).toBe(3);
    expect(t.duration).toBe(5);
    expect(t.mbpsAt(0.5)).toBe(8);
    expect(t.mbpsAt(1.5)).toBe(16);
    expect(t.mbpsAt(4)).toBe(0);
    expect(t.mbpsAt(5.5)).toBe(8);
  });
  it('rejects bad input', () => {
    expect(() => Trace.parse('0 1\n')).toThrow();
    expect(() => Trace.parse('0 1\n0 2\n')).toThrow();
    expect(() => Trace.parse('0 1\n1 -1\n')).toThrow();
  });
  it('finishTime handles outages and wrapping', () => {
    const t = Trace.parse('0 8\n1 0\n3 16\n');
    expect(t.finishTime(0, 0.5 * MB)).toBeCloseTo(0.5, 9);
    expect(t.finishTime(0, 1.5 * MB)).toBeCloseTo(3.25, 9);
    expect(t.finishTime(0, 5.5 * MB)).toBeCloseTo(5.5, 9);
    expect(t.finishTime(0, 51.5 * MB)).toBeCloseTo(53.25, 6);
    expect(t.finishTime(3.5, 4 * MB)).toBeCloseTo(6.0, 9);
  });
  it('bytesBetween inverts finishTime', () => {
    const t = Trace.parse('0 3\n0.7 0\n1.9 11\n2.2 0.5\n4 7\n');
    for (const s of [0, 0.31, 1, 2, 5.5, 13.7]) {
      for (const b of [1, 1000, 2e5, 3e6, 1.234e7]) {
        const e = t.finishTime(s, b);
        expect(e).toBeGreaterThanOrEqual(s);
        expect(t.bytesBetween(s, e)).toBeCloseTo(b, 3);
      }
    }
  });
  it('all-zero trace never finishes', () => {
    expect(t0().finishTime(0, 1)).toBe(Infinity);
    function t0() {
      return Trace.parse('0 0\n1 0\n');
    }
  });
});
