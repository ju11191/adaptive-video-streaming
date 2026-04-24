import { type EventDraft, stampEvents, type TelemetryEvent } from '@avs/abr';

/** Batches telemetry and POSTs it to the collector; flushes with sendBeacon on page hide. */
export class TelemetryClient {
  private queue: TelemetryEvent[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval>;
  readonly sent: TelemetryEvent[] = [];
  failures = 0;

  constructor(
    private readonly collectorUrl: string | null,
    private readonly ident: { sid: string; exp: string; arm: string },
    private readonly t0WallMs: number,
    flushEveryMs = 1000,
  ) {
    this.timer = setInterval(() => void this.flush(), flushEveryMs);
    addEventListener('pagehide', () => this.flushBeacon());
  }

  record(d: EventDraft): void {
    const [e] = stampEvents([d], this.ident, this.t0WallMs, this.seq++);
    this.queue.push(e!);
  }

  async flush(): Promise<void> {
    if (!this.collectorUrl || this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      const r = await fetch(`${this.collectorUrl}/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive: true,
      });
      if (r.status !== 202) throw new Error(`collector ${r.status}`);
      this.sent.push(...batch);
    } catch {
      this.failures++;
      this.queue.unshift(...batch);
    }
  }

  private flushBeacon(): void {
    if (!this.collectorUrl || this.queue.length === 0) return;
    navigator.sendBeacon(`${this.collectorUrl}/v1/events`, JSON.stringify(this.queue.splice(0)));
  }

  close(): void {
    clearInterval(this.timer);
    void this.flush();
  }
}
