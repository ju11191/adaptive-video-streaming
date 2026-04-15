/** Telemetry event schema shared by the player, loadgen and collector. */

export const EVENT_TYPES = [
  'session_start',
  'startup',
  'bitrate_switch',
  'rebuffer_start',
  'rebuffer_end',
  'error',
  'session_end',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventPayloads {
  session_start: { abr: string; trace?: string };
  startup: { startupMs: number };
  bitrate_switch: { fromKbps: number; toKbps: number; segment: number };
  rebuffer_start: {};
  rebuffer_end: { durationMs: number };
  error: { code: string; message: string };
  session_end: {
    playMs: number;
    rebufferMs: number;
    rebufferCount: number;
    avgKbps: number;
    switches: number;
  };
}

export type TelemetryEvent = {
  [K in EventType]: {
    v: 1;
    type: K;
    sid: string;
    exp: string;
    arm: string;
    /** Milliseconds since the Unix epoch. */
    ts: number;
    /** Per-session sequence number, starting at 0. */
    seq: number;
  } & EventPayloads[K];
}[EventType];

/** An event before it is stamped with session identity, time and sequence. */
export type EventDraft = {
  [K in EventType]: { type: K; tMs: number } & EventPayloads[K];
}[EventType];

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function num(o: Record<string, unknown>, k: string, min = 0): boolean {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) && v >= min;
}

/** Returns null if valid, else a human-readable reason. */
export function validateEvent(x: unknown): string | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'not an object';
  const o = x as Record<string, unknown>;
  if (o['v'] !== 1) return 'unsupported version';
  if (typeof o['type'] !== 'string' || !(EVENT_TYPES as readonly string[]).includes(o['type']))
    return 'unknown type';
  for (const k of ['sid', 'exp', 'arm']) {
    if (typeof o[k] !== 'string' || !ID_RE.test(o[k] as string)) return `bad ${k}`;
  }
  if (!num(o, 'ts', 1) || !num(o, 'seq')) return 'bad ts/seq';
  switch (o['type'] as EventType) {
    case 'session_start':
      return typeof o['abr'] === 'string' ? null : 'bad abr';
    case 'startup':
      return num(o, 'startupMs') ? null : 'bad startupMs';
    case 'bitrate_switch':
      return num(o, 'fromKbps') && num(o, 'toKbps') && num(o, 'segment') ? null : 'bad switch';
    case 'rebuffer_start':
      return null;
    case 'rebuffer_end':
      return num(o, 'durationMs') ? null : 'bad durationMs';
    case 'error':
      return typeof o['code'] === 'string' ? null : 'bad code';
    case 'session_end':
      return ['playMs', 'rebufferMs', 'rebufferCount', 'avgKbps', 'switches'].every((k) => num(o, k))
        ? null
        : 'bad session_end';
  }
}

/** Stamps drafts with identity; `t0Ms` is the wall-clock session start. */
export function stampEvents(
  drafts: readonly EventDraft[],
  ident: { sid: string; exp: string; arm: string },
  t0Ms: number,
  firstSeq = 0,
): TelemetryEvent[] {
  return drafts.map((d, i) => {
    const { tMs, ...rest } = d;
    return { v: 1, ...ident, ts: Math.round(t0Ms + tMs), seq: firstSeq + i, ...rest } as TelemetryEvent;
  });
}
