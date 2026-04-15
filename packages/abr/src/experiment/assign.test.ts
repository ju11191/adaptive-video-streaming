import { describe, expect, it } from 'vitest';
import { assignArm, fnv1a32 } from './assign.ts';

describe('arm assignment', () => {
  const arms = [{ name: 'A' }, { name: 'B' }];
  it('is deterministic', () => {
    expect(assignArm('exp1', 'session-42', arms)).toBe(assignArm('exp1', 'session-42', arms));
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
  });
  it('is balanced on sequential ids (within 2% over 20k sessions)', () => {
    let a = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (assignArm('exp1', `s${i}`, arms) === 'A') a++;
    expect(Math.abs(a / n - 0.5)).toBeLessThan(0.02);
  });
  it('honours weights', () => {
    let b = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (assignArm('e', `s${i}`, [{ name: 'A', weight: 3 }, { name: 'B', weight: 1 }]) === 'B') b++;
    expect(Math.abs(b / n - 0.25)).toBeLessThan(0.02);
  });
  it('re-randomizes across experiments', () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) if (assignArm('x', `s${i}`, arms) === assignArm('y', `s${i}`, arms)) same++;
    expect(same / 2000).toBeGreaterThan(0.4);
    expect(same / 2000).toBeLessThan(0.6);
  });
});
