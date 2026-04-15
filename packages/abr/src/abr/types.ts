/** One rendition of the bitrate ladder. `kbps` is what ABR decisions compare against. */
export interface Rung {
  index: number;
  kbps: number;
  width: number;
  height: number;
}

/** Throughput observed for one segment download (bytes over wall time incl. latency). */
export interface ThroughputSample {
  bytes: number;
  durationMs: number;
  kbps: number;
}

/** Everything an ABR algorithm may look at. Built identically by the player and simulator. */
export interface AbrContext {
  /** Ascending by bitrate; index i is rung i. */
  ladder: readonly Rung[];
  segmentDurationS: number;
  /** Seconds of media buffered ahead of the playhead. */
  bufferLevelS: number;
  /** Rung of the previously downloaded segment, null before the first. */
  lastQuality: number | null;
  /** Oldest first. */
  throughputHistory: readonly ThroughputSample[];
  /** Index of the segment about to be requested. */
  segmentIndex: number;
  /** False until playback has started (startup phase). */
  playing: boolean;
}

export interface AbrAlgorithm {
  readonly name: string;
  /** Returns the rung index for the next segment. */
  choose(ctx: AbrContext): number;
  /** Clears internal state before a new session. */
  reset(): void;
}

export function sampleFrom(bytes: number, durationMs: number): ThroughputSample {
  const ms = Math.max(durationMs, 1e-3);
  return { bytes, durationMs: ms, kbps: (bytes * 8) / ms };
}

export function clampQuality(q: number, ladder: readonly Rung[]): number {
  if (!Number.isFinite(q)) return 0;
  return Math.max(0, Math.min(ladder.length - 1, Math.trunc(q)));
}
