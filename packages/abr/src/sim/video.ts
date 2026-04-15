import type { Rung } from '../abr/types.ts';

/** Byte sizes of a packaged video; the simulator's view of the content. */
export interface VideoModel {
  ladder: Rung[];
  segmentDurationS: number;
  segmentCount: number;
  segmentBytes(rung: number, index: number): number;
  initBytes(rung: number): number;
}

/** Shape of media/hls/ladder.json written by scripts/make_ladder.mjs. */
export interface LadderJson {
  version: 1;
  codec: string;
  segmentDurationS: number;
  segmentCount: number;
  rungs: {
    index: number;
    kbps: number;
    peakKbps: number;
    width: number;
    height: number;
    codec: string;
    playlist: string;
    init: string;
    initBytes: number;
    segments: { uri: string; durationS: number; bytes: number }[];
  }[];
}

/**
 * Real per-segment VBR sizes from ladder.json. With `segmentCount` larger than the packaged
 * count, sizes repeat cyclically (a longer video with the same content statistics).
 */
export function videoFromLadder(json: LadderJson, segmentCount = json.segmentCount): VideoModel {
  const ladder = json.rungs.map((r) => ({
    index: r.index,
    kbps: r.kbps,
    width: r.width,
    height: r.height,
  }));
  return {
    ladder,
    segmentDurationS: json.segmentDurationS,
    segmentCount,
    segmentBytes: (q, i) => {
      const segs = json.rungs[q]!.segments;
      return segs[i % segs.length]!.bytes;
    },
    initBytes: (q) => json.rungs[q]!.initBytes,
  };
}

/** Constant-bitrate model from nominal bitrates (for tests and when no media is packaged). */
export function syntheticVideo(
  kbps: readonly number[],
  segmentDurationS = 4,
  segmentCount = 48,
): VideoModel {
  const ladder = kbps.map((k, index) => ({ index, kbps: k, width: 0, height: 0 }));
  return {
    ladder,
    segmentDurationS,
    segmentCount,
    segmentBytes: (q) => (ladder[q]!.kbps * 1000 * segmentDurationS) / 8,
    initBytes: () => 800,
  };
}

/** Nominal ladder, used when media/hls/ladder.json is absent. */
export const NOMINAL_LADDER_KBPS = [300, 750, 1200, 1850, 2850, 4300] as const;
