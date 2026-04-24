import type { Rung } from '@avs/abr';
import type { SegmentRecord } from './player/MsePlayer.ts';

/** Per-segment chosen bitrate (steps) and measured throughput (dots), in kbps over time. */
export function Timeline({ segments, ladder }: { segments: SegmentRecord[]; ladder: Rung[] }) {
  const W = 720;
  const H = 180;
  const pad = 36;
  const tMax = Math.max(1, ...segments.map((s) => s.atMs));
  const yMax = Math.max(ladder[ladder.length - 1]?.kbps ?? 1, ...segments.map((s) => Math.min(s.throughputKbps, 12000)));
  const x = (t: number) => pad + ((W - pad - 8) * t) / tMax;
  const y = (k: number) => H - 20 - ((H - 30) * Math.min(k, yMax)) / yMax;
  let path = '';
  segments.forEach((s, i) => {
    const prev = i === 0 ? 0 : segments[i - 1]!.atMs;
    path += `${i === 0 ? 'M' : 'L'}${x(prev).toFixed(1)},${y(s.kbps).toFixed(1)} L${x(s.atMs).toFixed(1)},${y(s.kbps).toFixed(1)} `;
  });
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="bitrate and throughput over time">
      {ladder.map((r) => (
        <g key={r.index}>
          <line x1={pad} x2={W - 8} y1={y(r.kbps)} y2={y(r.kbps)} className="grid" />
          <text x={pad - 4} y={y(r.kbps) + 3} className="axis" textAnchor="end">
            {r.kbps}
          </text>
        </g>
      ))}
      <path d={path} className="bitrate" />
      {segments.map((s) => (
        <circle key={s.index} cx={x(s.atMs)} cy={y(s.throughputKbps)} r={2.5} className="tput" />
      ))}
      <text x={W - 8} y={H - 4} className="axis" textAnchor="end">
        {(tMax / 1000).toFixed(0)} s · line = chosen kbps, dots = measured throughput
      </text>
    </svg>
  );
}
