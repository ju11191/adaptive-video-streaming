import { describe, expect, it } from 'vitest';
import { BbaRule } from '../abr/bba.ts';
import { createAbr, ABR_NAMES } from '../abr/registry.ts';
import { ThroughputRule } from '../abr/throughput.ts';
import type { AbrAlgorithm } from '../abr/types.ts';
import { simulateSession } from './simulator.ts';
import { Trace } from './trace.ts';
import { syntheticVideo } from './video.ts';

const video = syntheticVideo([300, 750, 1200, 1850, 2850, 4300], 4, 30);

function fixed(q: number): AbrAlgorithm {
  return { name: `fixed${q}`, choose: () => q, reset() {} };
}

describe('simulateSession', () => {
  it('conserves time: wall = startup + play + rebuffer', () => {
    const traces = [Trace.constant(100), Trace.constant(0.5), Trace.parse('0 5\n10 0.2\n30 3\n50 0.1\n')];
    for (const tr of traces) {
      for (const name of ABR_NAMES) {
        const r = simulateSession(createAbr(name), video, tr, { startOffsetS: 7 });
        expect(r.wallMs).toBeCloseTo(r.startupMs + r.playMs + r.rebufferMs, 6);
        expect(r.playMs).toBeCloseTo(30 * 4 * 1000, 6); // every second of video is played once
      }
    }
  });

  it('never rebuffers with abundant bandwidth and climbs to the top rung', () => {
    const r = simulateSession(new ThroughputRule(), video, Trace.constant(100));
    expect(r.rebufferCount).toBe(0);
    expect(r.rebufferMs).toBe(0);
    expect(r.qualities[0]).toBe(0);
    expect(r.qualities.slice(1).every((q) => q === 5)).toBe(true);
    expect(r.switches).toBe(1);
  });

  it('computes startup from playlist + init + first segment fetches', () => {
    // 8 Mbps = 1 MB/s, RTT 100 ms: 2 playlists (1500 B), init (800 B), seg0 rung0 (150 kB)
    const r = simulateSession(fixed(0), video, Trace.constant(8), { rttMs: 100 });
    const expected = 2 * (0.1 + 0.0015) + (0.1 + 0.0008) + (0.1 + 0.15);
    expect(r.startupMs).toBeCloseTo(expected * 1000, 6);
  });

  it('adds an injected startup regression exactly', () => {
    const a = simulateSession(fixed(0), video, Trace.constant(8));
    const b = simulateSession(fixed(0), video, Trace.constant(8), { extraStartupMs: 300 });
    expect(b.startupMs - a.startupMs).toBeCloseTo(300, 6);
    expect(b.rebufferMs).toBe(a.rebufferMs);
  });

  it('rebuffers when the chosen rate exceeds capacity, and reports it consistently', () => {
    // top rung (4300 kbps) on a 1 Mbps link: each 4 s segment takes ~17 s
    const r = simulateSession(fixed(5), video, Trace.constant(1));
    expect(r.rebufferCount).toBe(29); // every segment after the first stalls
    const starts = r.events.filter((e) => e.type === 'rebuffer_start').length;
    const ends = r.events.filter((e) => e.type === 'rebuffer_end');
    expect(starts).toBe(29);
    expect(ends).toHaveLength(29);
    const sumEnds = ends.reduce((a, e) => a + (e.type === 'rebuffer_end' ? e.durationMs : 0), 0);
    expect(sumEnds).toBeCloseTo(r.rebufferMs, 3);
    expect(r.rebufferRatio).toBeGreaterThan(0.7);
  });

  it('respects the max buffer', () => {
    const r = simulateSession(fixed(0), video, Trace.constant(100), { maxBufferS: 20 });
    for (const s of r.segments) expect(s.bufferAfterS).toBeLessThanOrEqual(20 + 1e-9);
  });

  it('is deterministic and resets ABR state between sessions', () => {
    const tr = Trace.parse('0 5\n10 0.2\n30 3\n50 0.1\n');
    const abr = new BbaRule({ startupGuard: true });
    const a = simulateSession(abr, video, tr);
    const b = simulateSession(abr, video, tr);
    expect(b.qualities).toEqual(a.qualities);
    expect(b.rebufferMs).toBe(a.rebufferMs);
  });

  it('emits a well-ordered event stream', () => {
    const r = simulateSession(new BbaRule(), video, Trace.parse('0 5\n10 0.2\n30 3\n50 0.1\n'));
    expect(r.events[0]!.type).toBe('session_start');
    expect(r.events[r.events.length - 1]!.type).toBe('session_end');
    expect(r.events.filter((e) => e.type === 'startup')).toHaveLength(1);
    for (let i = 1; i < r.events.length; i++) {
      expect(r.events[i]!.tMs).toBeGreaterThanOrEqual(r.events[i - 1]!.tMs - 1e-9);
    }
    const switches = r.events.filter((e) => e.type === 'bitrate_switch').length;
    expect(switches).toBe(r.switches);
  });

  it('BBA stays at the lowest rung until the buffer passes the reservoir', () => {
    const bba = simulateSession(new BbaRule(), video, Trace.constant(3));
    expect(bba.rebufferMs).toBe(0);
    for (const s of bba.segments) {
      if (s.bufferBeforeS <= 10) expect(s.quality).toBe(0);
    }
    // On a constant 3 Mbps link BBA oscillates around capacity off a full buffer, while the
    // throughput rule settles on the highest rung under 0.9 x throughput (1850 kbps).
    const tput = simulateSession(new ThroughputRule(), video, Trace.constant(3));
    expect(tput.rebufferMs).toBe(0);
    expect(new Set(tput.qualities.slice(2))).toEqual(new Set([3]));
    expect(bba.switches).toBeGreaterThan(tput.switches);
  });
});
