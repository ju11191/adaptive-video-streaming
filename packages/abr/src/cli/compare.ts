/**
 * ABR comparison over a trace set. Every algorithm sees exactly the same (trace, start offset)
 * sessions, so per-trace results are paired. Writes JSON, per-trace CSV and a Markdown summary.
 *
 *   npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium \
 *     --algos throughput,bba,bba-guard --baseline throughput --offsets 5 --seed 1 --out bench/out/abr
 *
 * `--subset train|test` (with `--split-seed N`) restricts the run to one half of the stratified
 * by-trace split and writes the split to <out>/split.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAbrFromSpec } from '../abr/registry.ts';
import { fnv1a32 } from '../experiment/assign.ts';
import { listTraceFiles, loadTrace, loadVideo, REPO_ROOT } from '../node.ts';
import { simulateSession } from '../sim/simulator.ts';
import { splitTraces } from '../stats/split.ts';
import { bootstrapCI, type Interval, mean, mulberry32, quantile } from '../stats/stats.ts';
import { num, parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const traceDirs = str(args, 'traces', 'data/traces/norway,data/traces/belgium')
  .split(',')
  .map((d) => path.resolve(REPO_ROOT, d));
// List separator is ';' when given (specs may contain ','), else ','.
const algosArg = str(args, 'algos', 'throughput,bba,bba-guard');
const algos = [...new Set(algosArg.split(algosArg.includes(';') ? ';' : ','))];
const baseline = str(args, 'baseline', algos[0]!);
const offsets = num(args, 'offsets', 5);
const seed = num(args, 'seed', 1);
const outDir = path.resolve(REPO_ROOT, str(args, 'out', 'bench/out/abr'));
const ladderPath = path.resolve(REPO_ROOT, str(args, 'ladder', 'media/hls/ladder.json'));
const resamples = num(args, 'resamples', 10000);
const subsetArg = str(args, 'subset', 'all');
const splitSeed = num(args, 'split-seed', 1);
if (!algos.includes(baseline)) throw new Error('--baseline must be one of --algos');
if (!['all', 'train', 'test'].includes(subsetArg)) throw new Error('--subset must be all, train or test');
const split =
  subsetArg === 'all'
    ? null
    : splitTraces(Object.fromEntries(traceDirs.map((d) => [path.basename(d), listTraceFiles(d).map((t) => t.name)])), splitSeed);
const keep = split ? new Set(subsetArg === 'train' ? split.train : split.test) : null;

const { video, source: videoSource } = loadVideo(ladderPath);
const METRICS = ['rebufferRatio', 'rebufferCount', 'rebufferMs', 'avgKbps', 'switches', 'startupMs'] as const;
type Metric = (typeof METRICS)[number];
type PerTrace = { trace: string; set: string; meanMbps: number } & Record<string, Record<Metric, number>>;

const rows: PerTrace[] = [];
const t0 = Date.now();
for (const dir of traceDirs) {
  const set = path.basename(dir);
  for (const { name, file } of listTraceFiles(dir)) {
    if (keep && !keep.has(`${set}/${name}`)) continue;
    const trace = loadTrace(file, name);
    const rand = mulberry32(fnv1a32(`${seed}:${name}`));
    const starts = Array.from({ length: offsets }, () => rand() * trace.duration);
    const row = { trace: name, set, meanMbps: trace.meanMbps } as PerTrace;
    for (const spec of algos) {
      const abr = createAbrFromSpec(spec);
      const acc = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
      for (const startOffsetS of starts) {
        const r = simulateSession(abr, video, trace, { startOffsetS });
        for (const m of METRICS) acc[m] += r[m] / offsets;
      }
      (row as Record<string, unknown>)[spec] = acc;
    }
    rows.push(row);
  }
}
const elapsedMs = Date.now() - t0;

interface Comparison {
  algo: string;
  n: number;
  meanBaseline: Record<Metric, number>;
  meanAlgo: Record<Metric, number>;
  /** 1 - mean(algo)/mean(baseline): positive = algo lower. With paired bootstrap CI. */
  rebufferRatioCut: Interval;
  rebufferCountCut: Interval;
  /** mean(algo) - mean(baseline) with paired bootstrap CI. */
  avgKbpsDiff: Interval;
  switchesDiff: Interval;
  startupMsDiff: Interval;
  /** Per-trace win/tie/loss on rebuffer ratio (algo lower = win). */
  rebufferWinTieLoss: [number, number, number];
}

function compare(subset: PerTrace[], algo: string): Comparison {
  const get = (r: PerTrace, a: string, m: Metric) => (r[a] as Record<Metric, number>)[m];
  const sumOver = (idx: readonly number[], a: string, m: Metric) => idx.reduce((s, i) => s + get(subset[i]!, a, m), 0);
  const cut = (m: Metric) => (idx: readonly number[]) => 1 - sumOver(idx, algo, m) / sumOver(idx, baseline, m);
  const diff = (m: Metric) => (idx: readonly number[]) => (sumOver(idx, algo, m) - sumOver(idx, baseline, m)) / idx.length;
  const opts = { resamples, seed };
  const n = subset.length;
  let w = 0;
  let t = 0;
  let l = 0;
  for (const r of subset) {
    const a = get(r, algo, 'rebufferRatio');
    const b = get(r, baseline, 'rebufferRatio');
    if (Math.abs(a - b) < 1e-12) t++;
    else if (a < b) w++;
    else l++;
  }
  const means = (a: string) =>
    Object.fromEntries(METRICS.map((m) => [m, mean(subset.map((r) => get(r, a, m)))])) as Record<Metric, number>;
  return {
    algo,
    n,
    meanBaseline: means(baseline),
    meanAlgo: means(algo),
    rebufferRatioCut: bootstrapCI(n, cut('rebufferRatio'), opts),
    rebufferCountCut: bootstrapCI(n, cut('rebufferCount'), opts),
    avgKbpsDiff: bootstrapCI(n, diff('avgKbps'), opts),
    switchesDiff: bootstrapCI(n, diff('switches'), opts),
    startupMsDiff: bootstrapCI(n, diff('startupMs'), opts),
    rebufferWinTieLoss: [w, t, l],
  };
}

const groups: Record<string, PerTrace[]> = { all: rows };
for (const r of rows) (groups[r.set] ??= []).push(r);
const comparisons: Record<string, Comparison[]> = {};
for (const [g, subset] of Object.entries(groups)) {
  comparisons[g] = algos.filter((a) => a !== baseline).map((a) => compare(subset, a));
}

function distribution(subset: PerTrace[], algo: string, m: Metric) {
  const xs = subset.map((r) => (r[algo] as Record<Metric, number>)[m]);
  return {
    mean: mean(xs),
    p10: quantile(xs, 0.1),
    p25: quantile(xs, 0.25),
    p50: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    p90: quantile(xs, 0.9),
    max: Math.max(...xs),
    fractionNonZero: xs.filter((x) => x > 0).length / xs.length,
  };
}
const distributions: Record<string, Record<string, Record<string, ReturnType<typeof distribution>>>> = {};
for (const [g, subset] of Object.entries(groups)) {
  distributions[g] = {};
  for (const a of algos) {
    distributions[g]![a] = Object.fromEntries(METRICS.map((m) => [m, distribution(subset, a, m)]));
  }
}

const meta = {
  command: `npx tsx packages/abr/src/cli/compare.ts ${process.argv.slice(2).join(' ')}`.trim(),
  date: new Date().toISOString(),
  host: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, ${os.platform()} ${os.release()}, node ${process.version}`,
  video: path.isAbsolute(videoSource) ? path.relative(REPO_ROOT, videoSource) : videoSource,
  ladderKbps: video.ladder.map((r) => r.kbps),
  segmentCount: video.segmentCount,
  traceDirs: traceDirs.map((d) => path.relative(REPO_ROOT, d)),
  traces: rows.length,
  offsetsPerTrace: offsets,
  seed,
  bootstrapResamples: resamples,
  simConfig: 'rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)',
  algos,
  baseline,
  subset: split ? { subset: subsetArg, splitSeed } : 'all',
  elapsedMs,
};
fs.mkdirSync(outDir, { recursive: true });
if (split) fs.writeFileSync(path.join(outDir, 'split.json'), JSON.stringify({ splitSeed, ...split }, null, 1));
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, comparisons, distributions, perTrace: rows }, null, 1));
const header = ['trace', 'set', 'meanMbps', ...algos.flatMap((a) => METRICS.map((m) => `${a}.${m}`))];
fs.writeFileSync(
  path.join(outDir, 'per_trace.csv'),
  [header.join(','), ...rows.map((r) => [r.trace, r.set, r.meanMbps.toFixed(3), ...algos.flatMap((a) => METRICS.map((m) => (r[a] as Record<Metric, number>)[m].toFixed(5)))].join(','))].join('\n') + '\n',
);

// ---- Markdown summary ------------------------------------------------------------------
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (i: Interval, f: (x: number) => string) => `${f(i.estimate)} [${f(i.lo)}, ${f(i.hi)}]`;
const f1 = (x: number) => x.toFixed(1);
const f3 = (x: number) => x.toFixed(3);
let md = `### ABR comparison (baseline: ${baseline})\n\n`;
md += `- command: \`${meta.command}\`\n- host: ${meta.host}\n- video: ${meta.video} (${meta.segmentCount} x 4 s segments, ladder ${meta.ladderKbps.join('/')} kbps)\n`;
md += `- traces: ${rows.length} (${Object.entries(groups).filter(([g]) => g !== 'all').map(([g, s]) => `${g} ${s.length}`).join(', ')}), ${offsets} seeded start offsets each (seed ${seed}); ${meta.simConfig}\n`;
if (split) md += `- subset: **${subsetArg}** half of the stratified by-trace split (split seed ${splitSeed})\n`;
md += `- CIs: 95% paired percentile bootstrap over traces, ${resamples} resamples. "Cut" = 1 - mean(algo)/mean(${baseline}).\n- simulation wall time: ${elapsedMs} ms\n\n`;
for (const [g, comps] of Object.entries(comparisons)) {
  md += `#### Trace set: ${g} (n = ${groups[g]!.length})\n\n`;
  md += `| algo | rebuffer ratio (mean) | rebuffer cut vs ${baseline} | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const b = comps[0]?.meanBaseline;
  if (b) md += `| ${baseline} | ${pct(b.rebufferRatio)} | — | ${f3(b.rebufferCount)} | — | ${b.avgKbps.toFixed(0)} | — | ${f1(b.switches)} | — | ${b.startupMs.toFixed(0)} | — | — |\n`;
  for (const c of comps) {
    md += `| ${c.algo} | ${pct(c.meanAlgo.rebufferRatio)} | ${ci(c.rebufferRatioCut, pct)} | ${f3(c.meanAlgo.rebufferCount)} | ${ci(c.rebufferCountCut, pct)} | ${c.meanAlgo.avgKbps.toFixed(0)} | ${ci(c.avgKbpsDiff, (x) => x.toFixed(0))} | ${f1(c.meanAlgo.switches)} | ${ci(c.switchesDiff, f1)} | ${c.meanAlgo.startupMs.toFixed(0)} | ${ci(c.startupMsDiff, (x) => x.toFixed(0))} | ${c.rebufferWinTieLoss.join('/')} |\n`;
  }
  md += `\nPer-trace rebuffer-ratio distribution:\n\n| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const a of algos) {
    const d = distributions[g]![a]!['rebufferRatio']!;
    md += `| ${a} | ${pct(d.mean)} | ${pct(d.p10)} | ${pct(d.p25)} | ${pct(d.p50)} | ${pct(d.p75)} | ${pct(d.p90)} | ${pct(d.max)} | ${pct(d.fractionNonZero)} |\n`;
  }
  md += '\n';
}
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
console.log(md);
console.log(`wrote ${path.relative(REPO_ROOT, outDir)}/{results.json,per_trace.csv,summary.md}`);
