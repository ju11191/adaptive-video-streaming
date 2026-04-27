import type { AbrAlgorithm, AbrContext, ThroughputSample } from '../abr/types.ts';
import { clampQuality, sampleFrom } from '../abr/types.ts';
import type { EventDraft } from '../telemetry/events.ts';
import type { Trace } from './trace.ts';
import type { VideoModel } from './video.ts';

export interface SimConfig {
  /** Request round-trip time added to every download. */
  rttMs: number;
  /** Player stops requesting when buffer + one segment would exceed this. */
  maxBufferS: number;
  /** Buffer needed before playback starts. Defaults to one segment. */
  startupBufferS: number | null;
  /** Size of master and media playlists. */
  playlistBytes: number;
  /** Trace time at which the session starts. */
  startOffsetS: number;
  /** Extra delay added to startup (models an injected regression); 0 normally. */
  extraStartupMs: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  rttMs: 80,
  maxBufferS: 60,
  startupBufferS: null,
  playlistBytes: 1500,
  startOffsetS: 0,
  extraStartupMs: 0,
};

export interface SegmentLog {
  index: number;
  quality: number;
  kbps: number;
  bytes: number;
  /** Session time (s) the request was issued and completed. */
  requestAtS: number;
  doneAtS: number;
  bufferBeforeS: number;
  bufferAfterS: number;
  stallS: number;
  throughputKbps: number;
}

export interface SimResult {
  abr: string;
  trace: string;
  startupMs: number;
  rebufferCount: number;
  rebufferMs: number;
  playMs: number;
  /** stall / (stall + play), excludes startup delay. */
  rebufferRatio: number;
  /** Mean bitrate of played segments (all segments have equal duration). */
  avgKbps: number;
  switches: number;
  /** Sum of |kbps_i - kbps_{i-1}| / count, a smoothness measure. */
  meanSwitchMagnitudeKbps: number;
  qualities: number[];
  segments: SegmentLog[];
  events: EventDraft[];
  /** Session wall time from start to end of playback (ms). */
  wallMs: number;
}

/**
 * Trace-driven simulation of one streaming session with the given ABR algorithm.
 * Deterministic: the same inputs always give the same result.
 */
export function simulateSession(
  abr: AbrAlgorithm,
  video: VideoModel,
  trace: Trace,
  config: Partial<SimConfig> = {},
): SimResult {
  const cfg = { ...DEFAULT_SIM_CONFIG, ...config };
  const rtt = cfg.rttMs / 1000;
  const segDur = video.segmentDurationS;
  const startupBuffer = cfg.startupBufferS ?? segDur;
  abr.reset();

  const t0 = cfg.startOffsetS;
  let t = t0; // trace time (s)
  let buffer = 0;
  let playing = false;
  let stalled = false;
  let stallStart = 0;
  let startupMs = 0;
  let playS = 0;
  let rebufferS = 0;
  let rebufferCount = 0;
  const history: ThroughputSample[] = [];
  const qualities: number[] = [];
  const segments: SegmentLog[] = [];
  const events: EventDraft[] = [{ type: 'session_start', tMs: 0, abr: abr.name, trace: trace.name }];
  const initLoaded = new Set<number>();
  const rel = (abs: number) => (abs - t0) * 1000;

  /** Time for a request issued at `at` for `bytes` (latency + transfer). */
  const fetchTime = (at: number, bytes: number) => trace.finishTime(at + rtt, bytes) - at;

  /** Advances wall time by dt while playback drains the buffer; returns stall seconds. */
  const advance = (dt: number): number => {
    if (!playing) {
      t += dt;
      return 0;
    }
    let stall = 0;
    if (buffer >= dt) {
      buffer -= dt;
      playS += dt;
    } else {
      playS += buffer;
      stall = dt - buffer;
      if (!stalled) {
        stalled = true;
        stallStart = t + buffer;
        rebufferCount++;
        events.push({ type: 'rebuffer_start', tMs: rel(stallStart) });
      }
      buffer = 0;
      rebufferS += stall;
    }
    t += dt;
    return stall;
  };

  // Startup requests: master playlist, then media playlist.
  advance(fetchTime(t, cfg.playlistBytes));
  advance(fetchTime(t, cfg.playlistBytes));
  if (cfg.extraStartupMs > 0) advance(cfg.extraStartupMs / 1000);

  let lastQuality: number | null = null;
  for (let i = 0; i < video.segmentCount; i++) {
    const ctx: AbrContext = {
      ladder: video.ladder,
      segmentDurationS: segDur,
      bufferLevelS: buffer,
      lastQuality,
      throughputHistory: history,
      segmentIndex: i,
      playing,
      segmentBytes: video.segmentBytes,
      segmentCount: video.segmentCount,
      maxBufferS: cfg.maxBufferS,
      rebufferCount,
    };
    const q = clampQuality(abr.choose(ctx), video.ladder);
    const requestAt = t;
    const bufferBefore = buffer;
    let stall = 0;
    if (!initLoaded.has(q)) {
      stall += advance(fetchTime(t, video.initBytes(q)));
      initLoaded.add(q);
    }
    const bytes = video.segmentBytes(q, i);
    const segStart = t;
    const dl = fetchTime(t, bytes);
    stall += advance(dl);
    history.push(sampleFrom(bytes, dl * 1000));
    if (lastQuality !== null && lastQuality !== q) {
      events.push({
        type: 'bitrate_switch',
        tMs: rel(segStart),
        fromKbps: video.ladder[lastQuality]!.kbps,
        toKbps: video.ladder[q]!.kbps,
        segment: i,
      });
    }
    buffer += segDur;
    if (stalled) {
      stalled = false;
      events.push({ type: 'rebuffer_end', tMs: rel(t), durationMs: (t - stallStart) * 1000 });
    }
    if (!playing && buffer >= startupBuffer) {
      playing = true;
      startupMs = rel(t);
      events.push({ type: 'startup', tMs: startupMs, startupMs });
    }
    segments.push({
      index: i,
      quality: q,
      kbps: video.ladder[q]!.kbps,
      bytes,
      requestAtS: requestAt - t0,
      doneAtS: t - t0,
      bufferBeforeS: bufferBefore,
      bufferAfterS: buffer,
      stallS: stall,
      throughputKbps: history[history.length - 1]!.kbps,
    });
    qualities.push(q);
    lastQuality = q;
    // Wait for room in the buffer before the next request.
    if (i + 1 < video.segmentCount && buffer > cfg.maxBufferS - segDur) {
      advance(buffer - (cfg.maxBufferS - segDur));
    }
  }
  if (!playing) {
    // Video shorter than the startup buffer: start once everything is loaded.
    playing = true;
    startupMs = rel(t);
    events.push({ type: 'startup', tMs: startupMs, startupMs });
  }
  // Play out the remaining buffer.
  playS += buffer;
  t += buffer;
  buffer = 0;

  let switches = 0;
  let switchMag = 0;
  for (let i = 1; i < qualities.length; i++) {
    if (qualities[i] !== qualities[i - 1]) {
      switches++;
      switchMag += Math.abs(video.ladder[qualities[i]!]!.kbps - video.ladder[qualities[i - 1]!]!.kbps);
    }
  }
  const avgKbps = qualities.reduce((a, q) => a + video.ladder[q]!.kbps, 0) / Math.max(1, qualities.length);
  const playMs = playS * 1000;
  const rebufferMs = rebufferS * 1000;
  events.push({
    type: 'session_end',
    tMs: rel(t),
    playMs,
    rebufferMs,
    rebufferCount,
    avgKbps,
    switches,
  });
  return {
    abr: abr.name,
    trace: trace.name,
    startupMs,
    rebufferCount,
    rebufferMs,
    playMs,
    rebufferRatio: rebufferMs + playMs > 0 ? rebufferMs / (rebufferMs + playMs) : 0,
    avgKbps,
    switches,
    meanSwitchMagnitudeKbps: qualities.length > 1 ? switchMag / (qualities.length - 1) : 0,
    qualities,
    segments,
    events,
    wallMs: rel(t),
  };
}
