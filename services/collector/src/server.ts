import http from 'node:http';
import { type ArmSpec, assignArm, type TelemetryEvent, validateEvent } from '@avs/abr';
import type { MemorySink, Sink } from './sinks.ts';

export interface CollectorOptions {
  sink: Sink;
  arms: ArmSpec[];
  maxBodyBytes?: number;
}

export interface CollectorCounters {
  requests: number;
  accepted: number;
  rejected: number;
  sinkErrors: number;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** HTTP collector: validates telemetry batches and forwards them to the sink. */
export function createCollector(opts: CollectorOptions): { server: http.Server; counters: CollectorCounters } {
  const counters: CollectorCounters = { requests: 0, accepted: 0, rejected: 0, sinkErrors: 0 };
  const limit = opts.maxBodyBytes ?? 1 << 20;

  const server = http.createServer(async (req, res) => {
    counters.requests++;
    const url = new URL(req.url ?? '/', 'http://collector');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, sink: opts.sink.name });
      if (url.pathname === '/metrics') return send(res, 200, counters);
      if (url.pathname === '/v1/assign' && req.method === 'GET') {
        const sid = url.searchParams.get('sid');
        const exp = url.searchParams.get('exp') ?? 'default';
        if (!sid) return send(res, 400, { error: 'sid required' });
        return send(res, 200, { exp, sid, arm: assignArm(exp, sid, opts.arms) });
      }
      if (url.pathname === '/v1/events' && req.method === 'POST') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req, limit));
        } catch (e) {
          return send(res, (e as Error).message === 'body too large' ? 413 : 400, { error: (e as Error).message });
        }
        const list = Array.isArray(parsed)
          ? parsed
          : (parsed as { events?: unknown })?.events instanceof Array
            ? (parsed as { events: unknown[] }).events
            : null;
        if (!list) return send(res, 400, { error: 'expected an array of events or {events: [...]}' });
        const ok: TelemetryEvent[] = [];
        const errors: string[] = [];
        for (const ev of list) {
          const why = validateEvent(ev);
          if (why === null) ok.push(ev as TelemetryEvent);
          else if (errors.length < 5) errors.push(why);
        }
        counters.rejected += list.length - ok.length;
        try {
          await opts.sink.write(ok);
        } catch (e) {
          counters.sinkErrors++;
          return send(res, 503, { error: `sink: ${(e as Error).message}` });
        }
        counters.accepted += ok.length;
        return send(res, 202, { accepted: ok.length, rejected: list.length - ok.length, errors });
      }
      if (url.pathname === '/v1/debug/events' && opts.sink.name === 'memory') {
        const mem = opts.sink as MemorySink;
        if (req.method === 'DELETE') {
          mem.events.length = 0;
          return send(res, 200, { cleared: true });
        }
        const sid = url.searchParams.get('sid');
        return send(res, 200, sid ? mem.events.filter((e) => e.sid === sid) : mem.events);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  });
  return { server, counters };
}

export function parseArms(spec: string): ArmSpec[] {
  // "A,B" or "A:3,B:1" (weights)
  return spec.split(',').map((p) => {
    const [name, w] = p.split(':');
    if (!name) throw new Error(`bad arms spec ${spec}`);
    return w ? { name, weight: Number(w) } : { name };
  });
}
