/**
 * Simulate one session and print a per-segment log.
 *   npx tsx packages/abr/src/cli/simulate.ts --trace data/traces/norway/x.txt --abr bba [--offset 30]
 */
import path from 'node:path';
import { createAbrFromSpec } from '../abr/registry.ts';
import { loadTrace, loadVideo, REPO_ROOT } from '../node.ts';
import { simulateSession } from '../sim/simulator.ts';
import { num, parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const tracePath = str(args, 'trace', path.join(REPO_ROOT, 'traces/synthetic/step.txt'));
const { video, source } = loadVideo(str(args, 'ladder', path.join(REPO_ROOT, 'media/hls/ladder.json')));
const abr = createAbrFromSpec(str(args, 'abr', 'throughput'));
const r = simulateSession(abr, video, loadTrace(tracePath), {
  startOffsetS: num(args, 'offset', 0),
  rttMs: num(args, 'rtt', 80),
  maxBufferS: num(args, 'max-buffer', 60),
});
console.log(`video: ${source}; trace: ${tracePath}; abr: ${abr.name}`);
console.log('seg  q   kbps  req_s   done_s  buf_before buf_after stall_s  tput_kbps');
for (const s of r.segments) {
  console.log(
    [s.index, s.quality, s.kbps, s.requestAtS.toFixed(2), s.doneAtS.toFixed(2), s.bufferBeforeS.toFixed(2),
      s.bufferAfterS.toFixed(2), s.stallS.toFixed(2), s.throughputKbps.toFixed(0)]
      .map((x) => String(x).padStart(7)).join(' '),
  );
}
console.log(
  `startup ${r.startupMs.toFixed(0)} ms, rebuffers ${r.rebufferCount} (${r.rebufferMs.toFixed(0)} ms, ratio ${(
    r.rebufferRatio * 100
  ).toFixed(2)}%), avg ${r.avgKbps.toFixed(0)} kbps, switches ${r.switches}`,
);
