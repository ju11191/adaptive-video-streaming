/**
 * Load generator: many headless simulated sessions emitting telemetry in (compressed) real time.
 *
 *   npx tsx services/loadgen/src/main.ts --collector http://localhost:8081 --rate 20 \
 *     --duration-s 600 --arms A:throughput,B:throughput --inject B:300 --inject-after-s 0
 *   ... --dry-run   (print JSON lines to stdout instead of POSTing; pipe into avs_consumer --stdin)
 */
import path from 'node:path';
import { mulberry32 } from '@avs/abr';
import { listTraceFiles, loadTrace, loadVideo, REPO_ROOT } from '@avs/abr/node';
import { parseArgs, num, str } from '../../../packages/abr/src/cli/args.ts';
import { type LoadConfig, parseArmAbrs, parseInject, planSession, type PlannedEvent, poissonGaps } from './session.ts';

const args = parseArgs(process.argv.slice(2));
const collector = str(args, 'collector', 'http://localhost:8081');
const rate = num(args, 'rate', 20);
const durationS = num(args, 'duration-s', 60);
const seed = num(args, 'seed', Date.now() % 1e9);
const dryRun = args['dry-run'] === true;
const runId = str(args, 'run-id', `lg${seed.toString(36)}`);
const traceDirs = str(args, 'traces', 'data/traces/norway,data/traces/belgium').split(',');
const cfg: LoadConfig = {
  exp: str(args, 'exp', 'exp1'),
  arms: parseArmAbrs(str(args, 'arms', 'A:throughput,B:throughput')),
  inject: parseInject(typeof args['inject'] === 'string' ? args['inject'] : undefined),
  injectAtMs: Date.now() + num(args, 'inject-after-s', 0) * 1000,
  speedup: num(args, 'speedup', 20),
};

const traces = traceDirs.flatMap((d) => listTraceFiles(path.resolve(REPO_ROOT, d))).map((t) => loadTrace(t.file, t.name));
if (traces.length === 0) throw new Error(`no traces under ${traceDirs.join(',')} (run scripts/fetch_traces.sh)`);
const { video } = loadVideo(path.resolve(REPO_ROOT, str(args, 'ladder', 'media/hls/ladder.json')));
const rand = mulberry32(seed);
const gap = poissonGaps(rate, seed + 1);

const queue: PlannedEvent[] = []; // kept sorted by dueMs
let sessions = 0;
let sent = 0;
let failed = 0;
let inflight = 0;

function enqueue(evs: PlannedEvent[]): void {
  for (const e of evs) {
    // binary insertion keeps the queue sorted
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (queue[mid]!.dueMs <= e.dueMs) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, e);
  }
}

async function flush(): Promise<void> {
  const now = Date.now();
  let n = 0;
  while (n < queue.length && queue[n]!.dueMs <= now) n++;
  if (n === 0) return;
  const batch = queue.splice(0, n).map((p) => p.event);
  if (dryRun) {
    for (const e of batch) process.stdout.write(`${JSON.stringify(e)}\n`);
    sent += batch.length;
    return;
  }
  inflight++;
  try {
    const r = await fetch(`${collector}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (r.status === 202) sent += batch.length;
    else failed += batch.length;
  } catch {
    failed += batch.length;
  } finally {
    inflight--;
  }
}

const start = Date.now();
const endAt = start + durationS * 1000;
let nextArrival = start + gap();
const log = (msg: string) => process.stderr.write(`[loadgen ${((Date.now() - start) / 1000).toFixed(0)}s] ${msg}\n`);
log(
  `rate ${rate}/s for ${durationS}s, arms ${cfg.arms.map((a) => `${a.name}:${a.abr}`).join(',')}, ` +
    `inject ${JSON.stringify(cfg.inject)} from +${((cfg.injectAtMs - start) / 1000).toFixed(0)}s, speedup ${cfg.speedup}, ` +
    `${traces.length} traces, ${dryRun ? 'dry-run' : collector}`,
);

const tick = setInterval(() => {
  const now = Date.now();
  while (nextArrival <= now && nextArrival < endAt) {
    const sid = `${runId}-${sessions++}`;
    enqueue(planSession(sid, nextArrival, cfg, traces, video, rand).events);
    nextArrival += gap();
  }
  void flush();
  if (now >= endAt && queue.length === 0 && inflight === 0) {
    clearInterval(tick);
    clearInterval(stats);
    log(`done: ${sessions} sessions, ${sent} events sent, ${failed} failed`);
  }
}, 50);
const stats = setInterval(() => log(`${sessions} sessions, ${sent} events sent, ${failed} failed, ${queue.length} queued`), 10000);
