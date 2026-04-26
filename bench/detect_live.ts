/**
 * Live time-to-detect benchmark through the whole pipeline:
 *   loadgen (host) -> collector -> Kafka -> C++ consumer (mSPRT) -> /api/state
 * For each run: POST /api/reset (new experiment epoch), start the load generator with a startup
 * regression injected into arm B from the first session, poll the consumer once per second until
 * the startup test rejects (or the timeout), then stop the load. Reports the consumer-measured
 * decision time (decided_wall_ms - epoch start) and the bench-observed time.
 *
 *   npx tsx bench/detect_live.ts --rate 20 --inject-ms 300 --runs 5 --timeout-s 900
 *   (effect 0 = A/A: measures whether a false positive happens within the timeout)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { num, parseArgs, str } from '../packages/abr/src/cli/args.ts';

const args = parseArgs(process.argv.slice(2));
const rate = num(args, 'rate', 20);
const injectMs = num(args, 'inject-ms', 300);
const runs = num(args, 'runs', 5);
const timeoutS = num(args, 'timeout-s', 900);
const consumer = str(args, 'consumer', 'http://localhost:8082');
const collector = str(args, 'collector', 'http://localhost:8081');
const seed0 = num(args, 'seed', 100);
const out = str(args, 'out', `bench/out/detect_live_r${rate}_e${injectMs}.json`);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

interface RunResult {
  run: number;
  seed: number;
  detected: boolean;
  consumerDecisionS: number | null;
  benchObservedS: number | null;
  diffMs: number | null;
  ciLo: number | null;
  ciHi: number | null;
  sessionsAtDecision: number | null;
  eventsConsumed: number;
  /** True if the host was suspended during the run (poll gap > 5 s); such runs are invalid. */
  hostSuspended: boolean;
  maxPollGapS: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function state(): Promise<any> {
  const r = await fetch(`${consumer}/api/state`);
  return r.json();
}

const results: RunResult[] = [];
for (let run = 0; run < runs; run++) {
  const seed = seed0 + run;
  const reset = (await (await fetch(`${consumer}/api/reset`, { method: 'POST' })).json()) as { epoch_started_ms: number };
  const t0 = Date.now();
  const lg = spawn(
    'npx',
    ['tsx', 'services/loadgen/src/main.ts', '--collector', collector, '--rate', String(rate), '--duration-s', String(timeoutS + 60),
      '--inject', `B:${injectMs}`, '--inject-after-s', '0', '--speedup', '20', '--seed', String(seed), '--run-id', `live${seed}`],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let lgErr = '';
  lg.stderr.on('data', (d: Buffer) => (lgErr = (lgErr + d.toString()).slice(-2000)));
  let res: RunResult = { run, seed, detected: false, consumerDecisionS: null, benchObservedS: null, diffMs: null, ciLo: null, ciHi: null, sessionsAtDecision: null, eventsConsumed: 0, hostSuspended: false, maxPollGapS: 0 };
  let lastPoll = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(1000);
    const gap = (Date.now() - lastPoll) / 1000;
    lastPoll = Date.now();
    res.maxPollGapS = Math.max(res.maxPollGapS, gap);
    if (gap > 5) res.hostSuspended = true;
    const s = await state();
    const t = s.tests.startup_ms;
    res.eventsConsumed = s.counters.events;
    if (t.decision === 'reject') {
      res = {
        ...res,
        detected: true,
        consumerDecisionS: (t.decided_wall_ms - reset.epoch_started_ms) / 1000,
        benchObservedS: (Date.now() - t0) / 1000,
        diffMs: t.diff,
        ciLo: t.ci_lo,
        ciHi: t.ci_hi,
        sessionsAtDecision: t.decided_at_n,
      };
      break;
    }
  }
  lg.kill('SIGTERM');
  await new Promise((r) => lg.once('exit', r));
  if (res.hostSuspended) console.log(`  INVALID: host suspended during run (max poll gap ${res.maxPollGapS.toFixed(0)} s)`);
  results.push(res);
  console.log(
    `run ${run} seed ${seed}: ${res.detected ? `detected after ${res.consumerDecisionS!.toFixed(1)} s (bench saw ${res.benchObservedS!.toFixed(1)} s), ` +
      `${res.sessionsAtDecision} sessions in test, diff ${res.diffMs!.toFixed(0)} ms, CI [${res.ciLo!.toFixed(0)}, ${res.ciHi!.toFixed(0)}]` : `no decision within ${timeoutS} s`}, ${res.eventsConsumed} events consumed`,
  );
  if (!res.detected && lgErr) console.log(`  loadgen tail: ${lgErr.split('\n').slice(-3).join(' | ')}`);
  await sleep(3000);
}
const valid = results.filter((r) => !r.hostSuspended);
const times = valid.filter((r) => r.detected).map((r) => r.consumerDecisionS!).sort((a, b) => a - b);
const summary = {
  command: `npx tsx bench/detect_live.ts ${process.argv.slice(2).join(' ')}`,
  host: `${os.cpus()[0]?.model} x${os.cpus().length}, ${os.platform()} ${os.release()}`,
  date: new Date().toISOString(),
  rate,
  injectMs,
  timeoutS,
  detected: times.length,
  runs,
  validRuns: valid.length,
  medianS: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
  minS: times[0] ?? null,
  maxS: times[times.length - 1] ?? null,
  results,
};
fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
fs.writeFileSync(path.resolve(root, out), JSON.stringify(summary, null, 1));
console.log(`rate ${rate}/s, +${injectMs} ms: detected ${times.length}/${valid.length} valid runs (${runs} total); consumer decision times (s): ${times.map((t) => t.toFixed(1)).join(', ')}`);
