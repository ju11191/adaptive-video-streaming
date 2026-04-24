/**
 * End-to-end: a real H.264 stream played by the MSE player in headless Chrome, served by the C++
 * origin through the trace shaper, with telemetry flowing to the collector.
 */
import { expect, test } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:18080';
const PLAYER = 'http://127.0.0.1:18083';
const COLLECTOR = 'http://127.0.0.1:18081';

interface Seg {
  index: number;
  quality: number;
  kbps: number;
  throughputKbps: number;
}

test('plays through the shaper, switches rungs up and down, and records telemetry', async ({ page }) => {
  const sid = `e2e-${Date.now()}`;
  const shapedResponses: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('.m4s') && r.headers()['x-shaped']) shapedResponses.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[browser] ${m.text()}`);
  });

  const qs = new URLSearchParams({
    origin: ORIGIN,
    collector: COLLECTOR,
    trace: 'synthetic/e2e_step',
    abr: 'throughput',
    autoplay: '1',
    sid,
    max_buffer: '20',
  });
  await page.goto(`${PLAYER}/?${qs}`);

  // The page must support MSE with our codec in this browser.
  expect(await page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'))).toBe(true);

  // Playback starts.
  await expect
    .poll(async () => page.evaluate(() => window.__avs?.stats.startupMs ?? null), { timeout: 30_000 })
    .not.toBeNull();

  // Wait until the ABR has gone up (fast phase) and then down (0.4 Mbit/s phase).
  const sawUpThenDown = async () =>
    page.evaluate(() => {
      const segs = (window.__avs?.stats.segments ?? []) as Seg[];
      let peak = 0;
      let up = false;
      let downAfterUp = false;
      for (let i = 1; i < segs.length; i++) {
        if (segs[i]!.quality > segs[i - 1]!.quality) up = true;
        peak = Math.max(peak, segs[i]!.quality);
        if (up && segs[i]!.quality < peak) downAfterUp = true;
      }
      return { up, downAfterUp, n: segs.length, q: segs.map((s) => s.quality).join('') };
    });
  await expect.poll(async () => (await sawUpThenDown()).downAfterUp, { timeout: 120_000, intervals: [1000] }).toBe(true);
  const path = await sawUpThenDown();
  console.log(`rung sequence: ${path.q}`);
  expect(path.up).toBe(true);

  // The video element really decoded frames and advanced time.
  const played = await page.evaluate(() => {
    const v = document.querySelector('video')!;
    const q = v.getVideoPlaybackQuality();
    return { t: v.currentTime, frames: q.totalVideoFrames, w: v.videoWidth };
  });
  expect(played.t).toBeGreaterThan(2);
  expect(played.frames).toBeGreaterThan(30);
  expect(played.w).toBeGreaterThan(0);

  // Segments went through the shaper.
  expect(shapedResponses.length).toBeGreaterThan(3);

  // Telemetry reached the collector with the right session identity.
  await page.evaluate(() => window.__avs!.telemetry.flush());
  await expect
    .poll(
      async () => {
        const r = await fetch(`${COLLECTOR}/v1/debug/events?sid=${sid}`);
        const evs = (await r.json()) as { type: string }[];
        const types = new Set(evs.map((e) => e.type));
        return ['session_start', 'startup', 'bitrate_switch'].every((t) => types.has(t));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const evs = (await (await fetch(`${COLLECTOR}/v1/debug/events?sid=${sid}`)).json()) as {
    type: string;
    sid: string;
    arm: string;
    startupMs?: number;
    fromKbps?: number;
    toKbps?: number;
  }[];
  const types = evs.map((e) => e.type);
  expect(types).toContain('session_start');
  expect(types).toContain('startup');
  const switches = evs.filter((e) => e.type === 'bitrate_switch');
  expect(switches.some((e) => e.toKbps! > e.fromKbps!)).toBe(true);
  expect(switches.some((e) => e.toKbps! < e.fromKbps!)).toBe(true);
  expect(evs.every((e) => e.sid === sid)).toBe(true);
  expect(new Set(evs.map((e) => e.arm)).size).toBe(1);
  console.log(`telemetry: ${evs.length} events (${[...new Set(types)].join(', ')})`);
});
