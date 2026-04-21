import { NOMINAL_LADDER_KBPS, syntheticVideo, Trace, validateEvent } from '@avs/abr';
import { describe, expect, it } from 'vitest';
import { type LoadConfig, parseArmAbrs, parseInject, planSession, poissonGaps, wallOffsetMs } from './session.ts';

const video = syntheticVideo(NOMINAL_LADDER_KBPS, 4, 10);
const traces = [Trace.constant(5)];
const cfg = (over: Partial<LoadConfig> = {}): LoadConfig => ({
  exp: 'e',
  arms: parseArmAbrs('A:throughput,B:bba'),
  inject: {},
  injectAtMs: 0,
  speedup: 10,
  ...over,
});
const fixedRand = () => 0.5;

describe('loadgen session planning', () => {
  it('parses specs', () => {
    expect(parseArmAbrs('A:throughput,B:bba-guard')).toEqual([
      { name: 'A', abr: 'throughput' },
      { name: 'B', abr: 'bba-guard' },
    ]);
    expect(parseInject('B:300')).toEqual({ B: 300 });
    expect(parseInject(undefined)).toEqual({});
    expect(() => parseInject('B')).toThrow();
  });

  it('keeps startup in real time and compresses the rest', () => {
    expect(wallOffsetMs(500, 800, 10)).toBe(500);
    expect(wallOffsetMs(800, 800, 10)).toBe(800);
    expect(wallOffsetMs(10800, 800, 10)).toBe(1800);
  });

  it('emits valid, time-ordered events stamped with the assigned arm', () => {
    const p = planSession('sess-1', 1_700_000_000_000, cfg(), traces, video, fixedRand);
    expect(p.events[0]!.event.type).toBe('session_start');
    expect(p.events.at(-1)!.event.type).toBe('session_end');
    for (const { event, dueMs } of p.events) {
      expect(validateEvent(event)).toBeNull();
      expect(event.arm).toBe(p.arm);
      expect(dueMs).toBe(event.ts);
    }
    const startup = p.events.find((e) => e.event.type === 'startup')!;
    expect(startup.dueMs - 1_700_000_000_000).toBeCloseTo(p.startupMs, -1);
  });

  it('injects extra startup only into the chosen arm and only after the injection time', () => {
    // find one session id per arm
    const ids = { A: '', B: '' } as Record<string, string>;
    for (let i = 0; !ids['A'] || !ids['B']; i++) {
      const arm = planSession(`s${i}`, 0, cfg(), traces, video, fixedRand).arm;
      ids[arm] ||= `s${i}`;
    }
    const inj = cfg({ inject: { B: 300 }, injectAtMs: 1000 });
    const base = (sid: string, t: number) => planSession(sid, t, cfg(), traces, video, fixedRand).startupMs;
    const withInj = (sid: string, t: number) => planSession(sid, t, inj, traces, video, fixedRand).startupMs;
    expect(withInj(ids['B']!, 2000) - base(ids['B']!, 2000)).toBeCloseTo(300, 6);
    expect(withInj(ids['A']!, 2000)).toBeCloseTo(base(ids['A']!, 2000), 6);
    expect(withInj(ids['B']!, 500)).toBeCloseTo(base(ids['B']!, 500), 6); // before injection
  });

  it('produces Poisson gaps with the requested mean', () => {
    const g = poissonGaps(20, 3);
    let s = 0;
    for (let i = 0; i < 20000; i++) s += g();
    expect(s / 20000).toBeGreaterThan(48);
    expect(s / 20000).toBeLessThan(52);
  });
});
