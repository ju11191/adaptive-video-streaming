/**
 * Prints one Markdown table of held-out test results across split seeds (bench/abr_heldout_seeds.sh).
 *   npx tsx packages/abr/src/cli/seed_table.ts bench/out/abr_heldout bench/out/abr_heldout_seed2 ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../node.ts';

interface Iv {
  estimate: number;
  lo: number;
  hi: number;
}
interface Comparison {
  algo: string;
  rebufferRatioCut: Iv;
  avgKbpsDiff: Iv;
  switchesDiff: Iv;
}
type Results = { meta: { subset: { splitSeed: number } }; comparisons: Record<string, Comparison[]> };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const iv = (i: Iv, f: (x: number) => string) => `${f(i.estimate)} [${f(i.lo)}, ${f(i.hi)}]`;
let md = '| split seed | trace set | algo (tuned on train) | rebuffer cut vs throughput | Δ kbps | Δ switches |\n|---|---|---|---|---|---|\n';
for (const dir of process.argv.slice(2)) {
  const base = path.resolve(REPO_ROOT, dir);
  const shown = new Set<string>();
  for (const sub of ['test', 'test_ext']) {
    const f = path.join(base, sub, 'results.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8')) as Results;
    for (const set of ['all', 'norway']) {
      for (const c of r.comparisons[set] ?? []) {
        // Tuned specs only, and each once per seed (test_ext repeats the pre-registered picks).
        if (!c.algo.includes(':') || shown.has(`${set}|${c.algo}`)) continue;
        shown.add(`${set}|${c.algo}`);
        md += `| ${r.meta.subset.splitSeed}${sub === 'test_ext' ? ' (ext)' : ''} | ${set} | ${c.algo} | ${iv(c.rebufferRatioCut, pct)} | ${iv(c.avgKbpsDiff, (x) => x.toFixed(0))} | ${iv(c.switchesDiff, (x) => x.toFixed(1))} |\n`;
      }
    }
  }
}
console.log(md);
