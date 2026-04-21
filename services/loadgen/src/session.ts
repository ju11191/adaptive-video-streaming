import {
  type AbrName,
  assignArm,
  createAbr,
  type EventDraft,
  mulberry32,
  simulateSession,
  stampEvents,
  type TelemetryEvent,
  type Trace,
  type VideoModel,
} from '@avs/abr';

export interface ArmConfig {
  name: string;
  abr: AbrName;
}

export interface LoadConfig {
  exp: string;
  arms: ArmConfig[];
  /** Extra startup delay per arm (ms), applied to sessions starting at/after injectAtMs. */
  inject: Record<string, number>;
  injectAtMs: number;
  /** Compression of post-startup session time (startup itself always plays in real time). */
  speedup: number;
}

/** "A:throughput,B:bba" */
export function parseArmAbrs(spec: string): ArmConfig[] {
  return spec.split(',').map((p) => {
    const [name, abr] = p.split(':');
    if (!name || !abr) throw new Error(`bad --arms entry "${p}" (want NAME:ABR)`);
    return { name, abr: abr as AbrName };
  });
}

/** "B:300" or "B:300,C:100" */
export function parseInject(spec: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!spec) return out;
  for (const p of spec.split(',')) {
    const [name, ms] = p.split(':');
    const v = Number(ms);
    if (!name || !Number.isFinite(v)) throw new Error(`bad --inject entry "${p}"`);
    out[name] = v;
  }
  return out;
}

/**
 * Maps simulated session time to wall-clock offset: real time up to the startup event,
 * compressed by `speedup` afterwards.
 */
export function wallOffsetMs(tMs: number, startupMs: number, speedup: number): number {
  return tMs <= startupMs ? tMs : startupMs + (tMs - startupMs) / speedup;
}

export interface PlannedEvent {
  dueMs: number;
  event: TelemetryEvent;
}

/** Simulates one session and returns its telemetry scheduled in wall-clock time. */
export function planSession(
  sid: string,
  startWallMs: number,
  cfg: LoadConfig,
  traces: readonly Trace[],
  video: VideoModel,
  rand: () => number,
): { arm: string; startupMs: number; events: PlannedEvent[] } {
  const arm = assignArm(cfg.exp, sid, cfg.arms);
  const armCfg = cfg.arms.find((a) => a.name === arm)!;
  const trace = traces[Math.floor(rand() * traces.length)]!;
  const extra = startWallMs >= cfg.injectAtMs ? (cfg.inject[arm] ?? 0) : 0;
  const r = simulateSession(createAbr(armCfg.abr), video, trace, {
    startOffsetS: rand() * trace.duration,
    extraStartupMs: extra,
  });
  const drafts: EventDraft[] = r.events.map((d) => ({ ...d, tMs: wallOffsetMs(d.tMs, r.startupMs, cfg.speedup) }));
  const events = stampEvents(drafts, { sid, exp: cfg.exp, arm }, startWallMs);
  return {
    arm,
    startupMs: r.startupMs,
    events: events.map((event) => ({ dueMs: event.ts, event })),
  };
}

/** Seeded exponential inter-arrival gaps for a Poisson process (seconds -> ms). */
export function poissonGaps(ratePerS: number, seed: number): () => number {
  const rand = mulberry32(seed);
  return () => (-Math.log(1 - rand()) / ratePerS) * 1000;
}
