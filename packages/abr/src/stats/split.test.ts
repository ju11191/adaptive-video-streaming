import { describe, expect, it } from 'vitest';
import { splitTraces } from './split.ts';

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('splitTraces', () => {
  const sets = { norway: names('n', 85), belgium: names('b', 40) };
  it('is stratified by dataset with floor(n/2) train traces each', () => {
    const s = splitTraces(sets, 1);
    expect(s.train.filter((k) => k.startsWith('norway/'))).toHaveLength(42);
    expect(s.test.filter((k) => k.startsWith('norway/'))).toHaveLength(43);
    expect(s.train.filter((k) => k.startsWith('belgium/'))).toHaveLength(20);
    expect(s.test.filter((k) => k.startsWith('belgium/'))).toHaveLength(20);
  });
  it('is a disjoint cover of all traces', () => {
    const s = splitTraces(sets, 1);
    const all = new Set([...s.train, ...s.test]);
    expect(all.size).toBe(125);
    expect(s.train.some((k) => s.test.includes(k))).toBe(false);
  });
  it('is deterministic, independent of input order, and changes with the seed', () => {
    const a = splitTraces(sets, 1);
    const reversed = { belgium: [...sets.belgium].reverse(), norway: [...sets.norway].reverse() };
    expect(splitTraces(reversed, 1)).toEqual(a);
    expect(splitTraces(sets, 2).train).not.toEqual(a.train);
  });
});
