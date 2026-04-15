/**
 * Piecewise-constant, wrapping throughput trace. Same semantics as cpp/shaper/trace.cpp:
 * sample i holds from t_i to t_{i+1}; the last sample holds for the previous gap.
 */
export class Trace {
  private readonly start: number[];
  private readonly bps: number[]; // bytes per second
  private readonly cum: number[]; // bytes before segment i; length n + 1
  readonly duration: number;

  private constructor(start: number[], bps: number[], duration: number, readonly name: string) {
    this.start = start;
    this.bps = bps;
    this.duration = duration;
    this.cum = [0];
    for (let i = 0; i < start.length; i++) {
      const end = i + 1 < start.length ? start[i + 1]! : duration;
      this.cum.push(this.cum[i]! + bps[i]! * (end - start[i]!));
    }
  }

  static parse(text: string, name = 'trace'): Trace {
    const t: number[] = [];
    const m: number[] = [];
    text.split(/\r?\n/).forEach((raw, idx) => {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      const [a, b] = line.split(/\s+/).map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b! < 0)
        throw new Error(`${name}: bad line ${idx + 1}`);
      if (t.length && a! <= t[t.length - 1]!) throw new Error(`${name}: non-increasing time`);
      t.push(a!);
      m.push(b!);
    });
    if (t.length < 2) throw new Error(`${name}: needs at least 2 samples`);
    const t0 = t[0]!;
    const duration = t[t.length - 1]! - t0 + (t[t.length - 1]! - t[t.length - 2]!);
    return new Trace(
      t.map((x) => x - t0),
      m.map((x) => (x * 1e6) / 8),
      duration,
      name,
    );
  }

  static constant(mbps: number, durationS = 1, name = `const_${mbps}`): Trace {
    return new Trace([0], [(mbps * 1e6) / 8], durationS, name);
  }

  get samples(): number {
    return this.start.length;
  }

  get meanMbps(): number {
    return ((this.cum[this.cum.length - 1]! / this.duration) * 8) / 1e6;
  }

  private segmentAt(phase: number): number {
    let lo = 0;
    let hi = this.start.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.start[mid]! <= phase) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private cumAt(phase: number): number {
    const i = this.segmentAt(phase);
    return this.cum[i]! + (phase - this.start[i]!) * this.bps[i]!;
  }

  mbpsAt(t: number): number {
    let phase = t % this.duration;
    if (phase < 0) phase += this.duration;
    return (this.bps[this.segmentAt(phase)]! * 8) / 1e6;
  }

  /** Absolute time at which `bytes` sent from `startS` are delivered (Infinity if never). */
  finishTime(startS: number, bytes: number): number {
    if (bytes <= 0) return startS;
    const period = this.cum[this.cum.length - 1]!;
    if (period <= 0) return Infinity;
    const periods = Math.floor(startS / this.duration);
    let base = periods * this.duration;
    let target = this.cumAt(startS - base) + bytes;
    if (target > period) {
      const extra = Math.ceil(target / period) - 1;
      target -= extra * period;
      base += extra * this.duration;
    }
    // first j >= 1 with cum[j] >= target
    let lo = 1;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid]! >= target) hi = mid;
      else lo = mid + 1;
    }
    const i = Math.min(lo - 1, this.start.length - 1);
    return Math.max(startS, base + this.start[i]! + (target - this.cum[i]!) / this.bps[i]!);
  }

  bytesBetween(t0: number, t1: number): number {
    if (t1 <= t0) return 0;
    const abs = (t: number) => {
      const p = Math.floor(t / this.duration);
      return p * this.cum[this.cum.length - 1]! + this.cumAt(t - p * this.duration);
    };
    return abs(t1) - abs(t0);
  }
}
