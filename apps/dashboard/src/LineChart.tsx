import { useState } from 'react';

export interface Series {
  name: string;
  /** CSS variable holding the series color, e.g. var(--series-1) */
  color: string;
  points: { x: number; y: number | null }[];
}

interface Props {
  series: Series[];
  title: string;
  /** Unit name, used for the accessible label (the caption names the unit visually). */
  yLabel: string;
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  /** Optional horizontal reference line (e.g. alpha). */
  reference?: { y: number; label: string };
  logY?: boolean;
  height?: number;
}

/**
 * Minimal SVG line chart: 2px lines, recessive grid, direct end labels, legend, and a
 * crosshair tooltip on hover. One y-axis only.
 */
export function LineChart({ series, title, yLabel, formatX, formatY, reference, logY, height = 200 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const left = 56;
  const right = 72;
  const top = 12;
  const bottom = 24;
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null && Number.isFinite(y)));
  if (reference) ys.push(reference.y);
  if (xs.length === 0 || ys.length === 0) {
    return (
      <figure className="chart">
        <figcaption>{title}</figcaption>
        <div className="empty">waiting for data…</div>
      </figure>
    );
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs, x0 + 1);
  const tf = (y: number) => (logY ? Math.log10(Math.max(y, 1e-12)) : y);
  let y0 = Math.min(...ys.map(tf));
  let y1 = Math.max(...ys.map(tf));
  if (!logY) y0 = Math.min(0, y0);
  if (y1 - y0 < 1e-9) y1 = y0 + 1;
  const px = (x: number) => left + ((W - left - right) * (x - x0)) / (x1 - x0);
  const py = (y: number) => top + (H - top - bottom) * (1 - (tf(y) - y0) / (y1 - y0));
  const ticks = Array.from({ length: 4 }, (_, i) => y0 + ((y1 - y0) * i) / 3);
  // Direct end labels, nudged apart vertically so close values do not overlap.
  const labels = series
    .map((s) => {
      const last = [...s.points].reverse().find((p) => p.y !== null && Number.isFinite(p.y));
      return last ? { name: s.name, x: px(last.x) + 6, y: py(last.y!) + 3, value: last.y! } : null;
    })
    .filter((l): l is { name: string; x: number; y: number; value: number } => l !== null)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i]!.y - labels[i - 1]!.y < 12) labels[i]!.y = labels[i - 1]!.y + 12;
  }
  const hoverX = hover === null ? null : x0 + ((hover - left) / (W - left - right)) * (x1 - x0);
  const nearest = (s: Series) => {
    if (hoverX === null) return null;
    let best: { x: number; y: number | null } | null = null;
    for (const p of s.points) if (!best || Math.abs(p.x - hoverX) < Math.abs(best.x - hoverX)) best = p;
    return best;
  };
  return (
    <figure className="chart">
      <figcaption>
        {title}
        <span className="legend">
          {series.length > 1 && series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title} (${yLabel})`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const sx = ((e.clientX - r.left) / r.width) * W;
          setHover(sx >= left && sx <= W - right ? sx : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={py(logY ? 10 ** t : t)} y2={py(logY ? 10 ** t : t)} className="grid" />
            <text x={left - 6} y={py(logY ? 10 ** t : t) + 3} className="axis" textAnchor="end">
              {formatY(logY ? 10 ** t : t)}
            </text>
          </g>
        ))}
        <text x={left} y={H - 6} className="axis">
          {formatX(x0)}
        </text>
        <text x={W - right} y={H - 6} className="axis" textAnchor="end">
          {formatX(x1)}
        </text>
        {reference && (
          <g>
            <line x1={left} x2={W - right} y1={py(reference.y)} y2={py(reference.y)} className="reference" />
            <text x={W - right + 4} y={py(reference.y) + 3} className="axis">
              {reference.label}
            </text>
          </g>
        )}
        {series.map((s) => {
          let d = '';
          let pen = false;
          for (const p of s.points) {
            if (p.y === null || !Number.isFinite(p.y)) {
              pen = false;
              continue;
            }
            d += `${pen ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`;
            pen = true;
          }
          return <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />;
        })}
        {labels.map((l) => (
          <text key={l.name} x={l.x} y={l.y} className="label">
            {l.name} {formatY(l.value)}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={hover} x2={hover} y1={top} y2={H - bottom} className="crosshair" />
            {series.map((s) => {
              const p = nearest(s);
              return p && p.y !== null ? (
                <circle key={s.name} cx={px(p.x)} cy={py(p.y)} r={4} fill={s.color} className="ring" />
              ) : null;
            })}
          </g>
        )}
      </svg>
      {hover !== null && hoverX !== null && (
        <div className="tooltip" style={{ left: `${(hover / W) * 100}%` }}>
          <div className="muted">{formatX(nearest(series[0]!)?.x ?? hoverX)}</div>
          {series.map((s) => {
            const p = nearest(s);
            return (
              <div key={s.name}>
                <i style={{ background: s.color }} /> {s.name}: {p && p.y !== null ? formatY(p.y) : '—'}
              </div>
            );
          })}
        </div>
      )}
    </figure>
  );
}
