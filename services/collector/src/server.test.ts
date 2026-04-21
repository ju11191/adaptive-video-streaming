import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollector, parseArms } from './server.ts';
import { MemorySink, type Sink } from './sinks.ts';

const sink = new MemorySink();
const { server, counters } = createCollector({ sink, arms: parseArms('A,B') });
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ev = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'startup',
  sid: 's1',
  exp: 'e',
  arm: 'A',
  ts: 1700000000000,
  seq: 1,
  startupMs: 900,
  ...over,
});

describe('collector', () => {
  it('accepts valid events, rejects invalid ones, and forwards only valid ones', async () => {
    const r = await fetch(`${base}/v1/events`, {
      method: 'POST',
      body: JSON.stringify([ev(), ev({ seq: 2, startupMs: -1 }), ev({ type: 'bogus' })]),
    });
    expect(r.status).toBe(202);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await r.json()) as { accepted: number; rejected: number; errors: string[] };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(2);
    expect(body.errors).toHaveLength(2);
    expect(sink.events).toHaveLength(1);
    expect(counters.accepted).toBe(1);
  });

  it('also accepts {events: [...]} and serves debug reads/clears', async () => {
    await fetch(`${base}/v1/events`, { method: 'POST', body: JSON.stringify({ events: [ev({ sid: 's2' })] }) });
    const only = (await (await fetch(`${base}/v1/debug/events?sid=s2`)).json()) as unknown[];
    expect(only).toHaveLength(1);
    await fetch(`${base}/v1/debug/events`, { method: 'DELETE' });
    expect(sink.events).toHaveLength(0);
  });

  it('rejects malformed bodies', async () => {
    expect((await fetch(`${base}/v1/events`, { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await fetch(`${base}/v1/events`, { method: 'POST', body: '{"x":1}' })).status).toBe(400);
    expect((await fetch(`${base}/v1/events`, { method: 'POST', body: 'x'.repeat(2 << 20) }).catch(() => ({ status: 413 }))).status).toBe(413);
  });

  it('answers CORS preflight and assignment', async () => {
    const p = await fetch(`${base}/v1/events`, { method: 'OPTIONS' });
    expect(p.status).toBe(204);
    expect(p.headers.get('access-control-allow-methods')).toContain('POST');
    const a1 = (await (await fetch(`${base}/v1/assign?sid=abc&exp=e1`)).json()) as { arm: string };
    const a2 = (await (await fetch(`${base}/v1/assign?sid=abc&exp=e1`)).json()) as { arm: string };
    expect(['A', 'B']).toContain(a1.arm);
    expect(a2.arm).toBe(a1.arm);
    expect((await fetch(`${base}/v1/assign`)).status).toBe(400);
  });

  it('returns 503 when the sink fails', async () => {
    const failing: Sink = { name: 'kafka', write: async () => Promise.reject(new Error('down')), close: async () => {} };
    const c = createCollector({ sink: failing, arms: parseArms('A,B') });
    await new Promise<void>((r) => c.server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}/v1/events`;
    const r = await fetch(url, { method: 'POST', body: JSON.stringify([ev()]) });
    expect(r.status).toBe(503);
    await new Promise<void>((r2) => c.server.close(() => r2()));
  });

  it('parses weighted arm specs', () => {
    expect(parseArms('A:3,B:1')).toEqual([
      { name: 'A', weight: 3 },
      { name: 'B', weight: 1 },
    ]);
  });
});
