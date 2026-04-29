/**
 * Adaptive player built directly on Media Source Extensions. Fetches HLS (fMP4) playlists and
 * segments itself; every bitrate decision comes from the pluggable AbrAlgorithm in @avs/abr,
 * the same code the simulator runs.
 */
import {
  type AbrAlgorithm,
  type AbrContext,
  type EventDraft,
  type LadderJson,
  parseMaster,
  parseMedia,
  type MediaPlaylist,
  resolveUri,
  type Rung,
  sampleFrom,
  type ThroughputSample,
} from '@avs/abr';

export interface ShapingParams {
  trace: string;
  sid: string;
  rttMs?: number;
}

export interface PlayerOptions {
  masterUrl: string;
  abr: AbrAlgorithm;
  maxBufferS?: number;
  shaping?: ShapingParams | null;
  onEvent?: (draft: EventDraft) => void;
  onLog?: (msg: string) => void;
}

export interface SegmentRecord {
  index: number;
  quality: number;
  kbps: number;
  bytes: number;
  downloadMs: number;
  throughputKbps: number;
  bufferBeforeS: number;
  atMs: number;
}

export interface PlayerStats {
  state: 'idle' | 'loading' | 'playing' | 'rebuffering' | 'ended' | 'error';
  bufferS: number;
  currentQuality: number | null;
  ladder: Rung[];
  segments: SegmentRecord[];
  startupMs: number | null;
  rebufferCount: number;
  rebufferMs: number;
  switches: number;
}

interface RungInfo extends Rung {
  playlistUrl: string;
  codecs: string;
}

export class MsePlayer {
  private readonly video: HTMLVideoElement;
  private readonly opts: Required<Omit<PlayerOptions, 'shaping' | 'onEvent' | 'onLog'>> &
    Pick<PlayerOptions, 'shaping' | 'onEvent' | 'onLog'>;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private rungs: RungInfo[] = [];
  private playlists = new Map<number, MediaPlaylist>();
  private inits = new Map<number, ArrayBuffer>();
  private appendedInit: number | null = null;
  private history: ThroughputSample[] = [];
  private t0 = 0;
  private stopped = false;
  private rebufferStart: number | null = null;
  private playingSince: number | null = null;
  private playMs = 0;
  readonly stats: PlayerStats = {
    state: 'idle',
    bufferS: 0,
    currentQuality: null,
    ladder: [],
    segments: [],
    startupMs: null,
    rebufferCount: 0,
    rebufferMs: 0,
    switches: 0,
  };

  constructor(video: HTMLVideoElement, opts: PlayerOptions) {
    this.video = video;
    this.opts = { maxBufferS: 60, ...opts };
  }

  private now(): number {
    return performance.now() - this.t0;
  }

  private emit(d: EventDraft): void {
    this.opts.onEvent?.(d);
  }

  private log(msg: string): void {
    this.opts.onLog?.(`${(this.now() / 1000).toFixed(2)}s ${msg}`);
  }

  /** Appends shaping parameters so the origin paces this session's responses. */
  private url(u: string): string {
    const s = this.opts.shaping;
    if (!s) return u;
    const url = new URL(u);
    url.searchParams.set('trace', s.trace);
    url.searchParams.set('sid', s.sid);
    if (s.rttMs) url.searchParams.set('rtt_ms', String(s.rttMs));
    return url.toString();
  }

  private async fetchBytes(u: string): Promise<{ data: ArrayBuffer; ms: number }> {
    const start = performance.now();
    const r = await fetch(this.url(u));
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    const data = await r.arrayBuffer();
    return { data, ms: performance.now() - start };
  }

  private async fetchText(u: string): Promise<string> {
    const r = await fetch(this.url(u));
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.text();
  }

  /**
   * HLS playlists carry no byte sizes, so for size-aware ABRs (BBA-1) read the packager's
   * ladder.json sidecar next to the master playlist. Unshaped: it is metadata, like sizes in a
   * DASH MPD's SegmentBase index. Returns null (nominal sizes) if absent or not matching the ladder.
   */
  private async loadSegmentSizes(ladder: readonly Rung[]): Promise<((rung: number, index: number) => number) | null> {
    try {
      const r = await fetch(resolveUri(this.opts.masterUrl, 'ladder.json'));
      if (!r.ok) return null;
      const j = (await r.json()) as LadderJson;
      const rungs = [...j.rungs].sort((a, b) => a.kbps - b.kbps);
      if (rungs.length !== ladder.length) return null;
      return (q, i) => {
        const segs = rungs[q]!.segments;
        return segs[i % segs.length]!.bytes;
      };
    } catch {
      return null;
    }
  }

  bufferAheadS(): number {
    const b = this.video.buffered;
    const t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.1 && t < b.end(i)) return b.end(i) - t;
    }
    return 0;
  }

  async start(): Promise<void> {
    this.t0 = performance.now();
    this.stats.state = 'loading';
    this.emit({ type: 'session_start', tMs: 0, abr: this.opts.abr.name, ...(this.opts.shaping ? { trace: this.opts.shaping.trace } : {}) });
    try {
      await this.run();
    } catch (e) {
      if (this.stopped) return;
      this.stats.state = 'error';
      const message = e instanceof Error ? e.message : String(e);
      this.log(`error: ${message}`);
      this.emit({ type: 'error', tMs: this.now(), code: 'PLAYER', message: message.slice(0, 200) });
    }
  }

  stop(): void {
    this.stopped = true;
    this.video.pause();
  }

  private attachVideoListeners(): void {
    const v = this.video;
    v.addEventListener('playing', () => {
      const t = this.now();
      if (this.stats.startupMs === null) {
        this.stats.startupMs = t;
        this.stats.state = 'playing';
        this.log(`startup after ${t.toFixed(0)} ms`);
        this.emit({ type: 'startup', tMs: t, startupMs: t });
      } else if (this.rebufferStart !== null) {
        const dur = t - this.rebufferStart;
        this.stats.rebufferMs += dur;
        this.rebufferStart = null;
        this.stats.state = 'playing';
        this.log(`rebuffer ended (${dur.toFixed(0)} ms)`);
        this.emit({ type: 'rebuffer_end', tMs: t, durationMs: dur });
      }
      this.playingSince = t;
    });
    v.addEventListener('waiting', () => {
      if (this.stats.startupMs === null || this.rebufferStart !== null || v.ended || this.stopped) return;
      const t = this.now();
      if (this.playingSince !== null) this.playMs += t - this.playingSince;
      this.playingSince = null;
      this.rebufferStart = t;
      this.stats.rebufferCount++;
      this.stats.state = 'rebuffering';
      this.log('rebuffer started');
      this.emit({ type: 'rebuffer_start', tMs: t });
    });
    v.addEventListener('ended', () => {
      const t = this.now();
      if (this.playingSince !== null) this.playMs += t - this.playingSince;
      this.playingSince = null;
      this.stats.state = 'ended';
      const segs = this.stats.segments;
      const avgKbps = segs.reduce((a, s) => a + s.kbps, 0) / Math.max(1, segs.length);
      this.log('ended');
      this.emit({
        type: 'session_end',
        tMs: t,
        playMs: this.playMs,
        rebufferMs: this.stats.rebufferMs,
        rebufferCount: this.stats.rebufferCount,
        avgKbps,
        switches: this.stats.switches,
      });
    });
    v.addEventListener('error', () => {
      const err = v.error;
      this.emit({ type: 'error', tMs: this.now(), code: `MEDIA_${err?.code ?? 0}`, message: err?.message ?? 'media error' });
    });
  }

  private async playlist(q: number): Promise<MediaPlaylist> {
    let pl = this.playlists.get(q);
    if (!pl) {
      pl = parseMedia(await this.fetchText(this.rungs[q]!.playlistUrl));
      this.playlists.set(q, pl);
    }
    return pl;
  }

  private append(data: ArrayBuffer): Promise<void> {
    const sb = this.sb!;
    return new Promise((resolve, reject) => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        reject(new Error('SourceBuffer append failed'));
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', fail);
      sb.appendBuffer(data);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async run(): Promise<void> {
    const master = parseMaster(await this.fetchText(this.opts.masterUrl));
    this.rungs = master
      .map((v) => ({
        index: 0,
        kbps: Math.round((v.averageBandwidth ?? v.bandwidth) / 1000),
        width: v.width ?? 0,
        height: v.height ?? 0,
        playlistUrl: resolveUri(this.opts.masterUrl, v.uri),
        codecs: v.codecs ?? 'avc1.640028',
      }))
      .sort((a, b) => a.kbps - b.kbps)
      .map((r, index) => ({ ...r, index }));
    this.stats.ladder = this.rungs.map(({ index, kbps, width, height }) => ({ index, kbps, width, height }));
    const ladder = this.stats.ladder;

    const mime = `video/mp4; codecs="${this.rungs[0]!.codecs}"`;
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) {
      throw new Error(`MSE does not support ${mime}`);
    }
    this.ms = new MediaSource();
    this.video.src = URL.createObjectURL(this.ms);
    await new Promise<void>((r) => this.ms!.addEventListener('sourceopen', () => r(), { once: true }));
    this.sb = this.ms.addSourceBuffer(mime);
    this.attachVideoListeners();

    const segmentBytes = this.opts.abr.needsSegmentSizes ? await this.loadSegmentSizes(ladder) : null;
    if (this.opts.abr.needsSegmentSizes) this.log(segmentBytes ? 'using ladder.json segment sizes' : 'no ladder.json: nominal sizes');
    this.opts.abr.reset();
    let lastQuality: number | null = null;
    let segmentCount = Infinity;
    let durationSet = false;
    for (let i = 0; i < segmentCount && !this.stopped; i++) {
      const segDur = this.playlists.get(lastQuality ?? 0)?.targetDurationS ?? 4;
      // Wait for room in the buffer (same rule as the simulator).
      while (!this.stopped && this.bufferAheadS() > this.opts.maxBufferS - segDur) {
        this.stats.bufferS = this.bufferAheadS();
        await this.sleep(200);
      }
      const ctx: AbrContext = {
        ladder,
        segmentDurationS: segDur,
        bufferLevelS: this.bufferAheadS(),
        lastQuality,
        throughputHistory: this.history,
        segmentIndex: i,
        playing: this.stats.startupMs !== null,
        maxBufferS: this.opts.maxBufferS,
        rebufferCount: this.stats.rebufferCount,
        ...(Number.isFinite(segmentCount) ? { segmentCount } : {}),
        ...(segmentBytes ? { segmentBytes } : {}),
      };
      const q = Math.max(0, Math.min(ladder.length - 1, this.opts.abr.choose(ctx)));
      const pl = await this.playlist(q);
      segmentCount = pl.segments.length;
      if (!durationSet) {
        this.ms.duration = pl.segments.reduce((a, s) => a + s.durationS, 0);
        durationSet = true;
      }
      if (this.appendedInit !== q) {
        let init = this.inits.get(q);
        if (!init) {
          init = (await this.fetchBytes(resolveUri(this.rungs[q]!.playlistUrl, pl.initUri!))).data;
          this.inits.set(q, init);
        }
        await this.append(init);
        this.appendedInit = q;
      }
      const seg = pl.segments[i]!;
      const bufferBefore = ctx.bufferLevelS;
      const { data, ms } = await this.fetchBytes(resolveUri(this.rungs[q]!.playlistUrl, seg.uri));
      const sample = sampleFrom(data.byteLength, ms);
      this.history.push(sample);
      await this.append(data);
      if (lastQuality !== null && lastQuality !== q) {
        this.stats.switches++;
        this.log(`switch ${ladder[lastQuality]!.kbps} -> ${ladder[q]!.kbps} kbps at segment ${i}`);
        this.emit({ type: 'bitrate_switch', tMs: this.now(), fromKbps: ladder[lastQuality]!.kbps, toKbps: ladder[q]!.kbps, segment: i });
      }
      lastQuality = q;
      this.stats.currentQuality = q;
      this.stats.segments.push({
        index: i,
        quality: q,
        kbps: ladder[q]!.kbps,
        bytes: data.byteLength,
        downloadMs: ms,
        throughputKbps: sample.kbps,
        bufferBeforeS: bufferBefore,
        atMs: this.now(),
      });
      this.stats.bufferS = this.bufferAheadS();
      if (i === 0) {
        this.video.muted = true;
        void this.video.play().catch((e: unknown) => this.log(`play() rejected: ${String(e)}`));
      }
    }
    if (!this.stopped && this.ms.readyState === 'open') {
      while (this.sb.updating) await this.sleep(20);
      this.ms.endOfStream();
    }
  }
}
