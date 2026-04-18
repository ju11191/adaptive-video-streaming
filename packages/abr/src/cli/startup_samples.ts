/**
 * Dumps simulated startup times (ms), one per line: random trace (uniform over the set) and
 * random start offset per session, as the load generator does. Used as the empirical
 * distribution for the statistical benchmarks.
 *   npx tsx packages/abr/src/cli/startup_samples.ts --n 20000 --abr throughput --out bench/out/startup_samples.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAbrFromSpec } from '../abr/registry.ts';
import { listTraceFiles, loadTrace, loadVideo, REPO_ROOT } from '../node.ts';
import { simulateSession } from '../sim/simulator.ts';
import { mean, mulberry32, quantile } from '../stats/stats.ts';
import { num, parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const n = num(args, 'n', 20000);
const seed = num(args, 'seed', 7);
const abr = createAbrFromSpec(str(args, 'abr', 'throughput'));
const out = path.resolve(REPO_ROOT, str(args, 'out', 'bench/out/startup_samples.txt'));
const dirs = str(args, 'traces', 'data/traces/norway,data/traces/belgium').split(',');
const traces = dirs.flatMap((d) => listTraceFiles(path.resolve(REPO_ROOT, d))).map((t) => loadTrace(t.file, t.name));
const { video } = loadVideo(path.resolve(REPO_ROOT, 'media/hls/ladder.json'));
const rand = mulberry32(seed);
const xs: number[] = [];
for (let i = 0; i < n; i++) {
  const tr = traces[Math.floor(rand() * traces.length)]!;
  // Startup only depends on the first few segments; simulate a short video for speed.
  const r = simulateSession(abr, { ...video, segmentCount: 3 }, tr, { startOffsetS: rand() * tr.duration });
  xs.push(r.startupMs);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, xs.map((x) => x.toFixed(1)).join('\n') + '\n');
const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
console.log(
  `wrote ${n} startup samples to ${path.relative(REPO_ROOT, out)}: mean ${mean(xs).toFixed(0)} ms, sd ${sd.toFixed(0)}, ` +
    `p50 ${quantile(xs, 0.5).toFixed(0)}, p90 ${quantile(xs, 0.9).toFixed(0)}, p99 ${quantile(xs, 0.99).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`,
);
