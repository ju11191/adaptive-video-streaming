/**
 * Applies the selection rule to a training-set compare.ts run. Prints the chosen
 * spec of each algorithm family (';'-separated) on stdout and writes <dir>/selection.{json,md}.
 *
 *   npx tsx packages/abr/src/cli/select.ts --results bench/out/abr_heldout/train/results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../node.ts';
import { type Candidate, selectPerFamily } from '../stats/selection.ts';
import { num, parseArgs, str } from './args.ts';

interface Comparison {
  algo: string;
  meanBaseline: { avgKbps: number };
  meanAlgo: { avgKbps: number; switches: number };
  rebufferRatioCut: { estimate: number };
}

const args = parseArgs(process.argv.slice(2));
const file = path.resolve(REPO_ROOT, str(args, 'results', 'bench/out/abr_heldout/train/results.json'));
const minKbpsRatio = num(args, 'min-kbps-ratio', 0.95);
const res = JSON.parse(fs.readFileSync(file, 'utf8')) as { meta: { baseline: string }; comparisons: { all: Comparison[] } };
const all = res.comparisons.all;
const baselineKbps = all[0]!.meanBaseline.avgKbps;
const cands: Candidate[] = all.map((c) => ({
  spec: c.algo,
  rebufferCut: c.rebufferRatioCut.estimate,
  avgKbps: c.meanAlgo.avgKbps,
  switches: c.meanAlgo.switches,
}));
const sel = selectPerFamily(cands, baselineKbps, minKbpsRatio);

const dir = path.dirname(file);
fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify({ minKbpsRatio, baselineKbps, sel }, null, 1));
let md = `### Parameter selection on the training traces\n\n`;
md += `- rule: avg bitrate >= ${minKbpsRatio} x ${res.meta.baseline} (${baselineKbps.toFixed(0)} kbps -> floor ${(minKbpsRatio * baselineKbps).toFixed(0)} kbps); then max rebuffer cut, ties -> fewer switches\n\n`;
for (const s of sel) {
  md += `#### ${s.family}: chose \`${s.chosen.spec}\`${s.feasible ? '' : ' (no candidate met the bitrate floor; highest bitrate taken)'}\n\n`;
  md += `| spec | rebuffer cut (train) | avg kbps | switches | feasible |\n|---|---|---|---|---|\n`;
  for (const c of s.candidates) {
    md += `| ${c.spec} | ${(c.rebufferCut * 100).toFixed(1)}% | ${c.avgKbps.toFixed(0)} | ${c.switches.toFixed(1)} | ${c.feasible ? 'yes' : 'no'} |\n`;
  }
  md += '\n';
}
fs.writeFileSync(path.join(dir, 'selection.md'), md);
process.stderr.write(md);
process.stdout.write(sel.map((s) => s.chosen.spec).join(';'));
