import { describe, expect, it } from 'vitest';
import { familyOf, selectPerFamily } from './selection.ts';

const c = (spec: string, rebufferCut: number, avgKbps: number, switches = 5) => ({ spec, rebufferCut, avgKbps, switches });

describe('selectPerFamily', () => {
  it('groups by algorithm family', () => {
    expect(familyOf('bola-e:qLowS=5')).toBe('bola-e');
    expect(familyOf('bba1')).toBe('bba1');
  });
  it('maximises the rebuffer cut among configs meeting the bitrate floor', () => {
    const s = selectPerFamily([c('bola:qLowS=5', 0.1, 2000), c('bola:qLowS=30', 0.5, 1000), c('bola:qLowS=20', 0.3, 1900)], 2000, 0.95);
    expect(s).toHaveLength(1);
    expect(s[0]!.chosen.spec).toBe('bola:qLowS=20'); // qLowS=30 cuts more but is below 1900 kbps
    expect(s[0]!.feasible).toBe(true);
  });
  it('breaks ties on fewer switches', () => {
    const s = selectPerFamily([c('bba1:a', 0.2, 2000, 7), c('bba1:b', 0.2, 2000, 4)], 2000, 0.95);
    expect(s[0]!.chosen.spec).toBe('bba1:b');
  });
  it('falls back to the highest bitrate when nothing is feasible', () => {
    const s = selectPerFamily([c('bola:x', 0.4, 1500), c('bola:y', -0.2, 1800)], 2000, 0.95);
    expect(s[0]!.feasible).toBe(false);
    expect(s[0]!.chosen.spec).toBe('bola:y');
  });
  it('selects independently for each family', () => {
    const s = selectPerFamily([c('bola:x', 0.1, 2000), c('bba1:y', 0.3, 2000), c('bba1:z', 0.2, 2000)], 2000, 0.95);
    expect(s.map((x) => [x.family, x.chosen.spec])).toEqual([
      ['bola', 'bola:x'],
      ['bba1', 'bba1:y'],
    ]);
  });
});
