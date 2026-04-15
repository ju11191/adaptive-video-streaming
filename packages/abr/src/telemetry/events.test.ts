import { describe, expect, it } from 'vitest';
import { stampEvents, validateEvent } from './events.ts';

const base = { v: 1, sid: 's1', exp: 'e1', arm: 'A', ts: 1700000000000, seq: 0 };

describe('telemetry validation', () => {
  it('accepts well-formed events of every type', () => {
    expect(validateEvent({ ...base, type: 'session_start', abr: 'bba' })).toBeNull();
    expect(validateEvent({ ...base, type: 'startup', startupMs: 812 })).toBeNull();
    expect(validateEvent({ ...base, type: 'bitrate_switch', fromKbps: 300, toKbps: 750, segment: 3 })).toBeNull();
    expect(validateEvent({ ...base, type: 'rebuffer_start' })).toBeNull();
    expect(validateEvent({ ...base, type: 'rebuffer_end', durationMs: 1200 })).toBeNull();
    expect(validateEvent({ ...base, type: 'error', code: 'MSE', message: 'x' })).toBeNull();
    expect(
      validateEvent({ ...base, type: 'session_end', playMs: 1, rebufferMs: 0, rebufferCount: 0, avgKbps: 1, switches: 0 }),
    ).toBeNull();
  });
  it('rejects malformed events', () => {
    expect(validateEvent(null)).not.toBeNull();
    expect(validateEvent([])).not.toBeNull();
    expect(validateEvent({ ...base, v: 2, type: 'startup', startupMs: 1 })).not.toBeNull();
    expect(validateEvent({ ...base, type: 'nope' })).not.toBeNull();
    expect(validateEvent({ ...base, sid: 'bad id with spaces', type: 'rebuffer_start' })).not.toBeNull();
    expect(validateEvent({ ...base, type: 'startup', startupMs: -1 })).not.toBeNull();
    expect(validateEvent({ ...base, type: 'startup', startupMs: NaN })).not.toBeNull();
    expect(validateEvent({ ...base, ts: 0, type: 'rebuffer_start' })).not.toBeNull();
  });
  it('stamps drafts with identity, absolute time and sequence', () => {
    const ev = stampEvents(
      [
        { type: 'session_start', tMs: 0, abr: 'bba' },
        { type: 'startup', tMs: 812.4, startupMs: 812.4 },
      ],
      { sid: 's', exp: 'e', arm: 'B' },
      1000,
    );
    expect(ev[1]).toEqual({ v: 1, sid: 's', exp: 'e', arm: 'B', ts: 1812, seq: 1, type: 'startup', startupMs: 812.4 });
    for (const e of ev) expect(validateEvent(e)).toBeNull();
  });
});
