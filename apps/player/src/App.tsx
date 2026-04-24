import { ABR_NAMES, type AbrName, createAbr, type EventDraft } from '@avs/abr';
import { useEffect, useRef, useState } from 'react';
import { armFor, readConfig } from './config.ts';
import { MsePlayer, type PlayerStats } from './player/MsePlayer.ts';
import { TelemetryClient } from './player/telemetry.ts';
import { Timeline } from './Timeline.tsx';

const TRACES = ['', 'synthetic/step', 'synthetic/const_3mbps'];

declare global {
  interface Window {
    /** Exposed for the Playwright e2e test and for debugging in the console. */
    __avs?: { stats: PlayerStats; events: EventDraft[]; telemetry: TelemetryClient; arm: string; abr: string; sid: string };
  }
}

export function App() {
  const initial = readConfig();
  const [abr, setAbr] = useState<AbrName>(armFor(initial).abr);
  const [trace, setTrace] = useState<string>(initial.trace ?? '');
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<MsePlayer | null>(null);
  const telemetryRef = useRef<TelemetryClient | null>(null);

  const start = () => {
    if (!videoRef.current) return;
    playerRef.current?.stop();
    telemetryRef.current?.close();
    const cfg = { ...initial, trace: trace || null };
    const { arm } = armFor(cfg);
    const telemetry = new TelemetryClient(cfg.collector, { sid: cfg.sid, exp: cfg.exp, arm }, Date.now());
    const events: EventDraft[] = [];
    const player = new MsePlayer(videoRef.current, {
      masterUrl: `${cfg.origin}${cfg.masterPath}`,
      abr: createAbr(abr),
      maxBufferS: cfg.maxBufferS,
      shaping: cfg.trace ? { trace: cfg.trace, sid: cfg.sid, rttMs: cfg.rttMs } : null,
      onEvent: (d) => {
        events.push(d);
        telemetry.record(d);
      },
      onLog: (m) => setLog((l) => [m, ...l].slice(0, 200)),
    });
    playerRef.current = player;
    telemetryRef.current = telemetry;
    window.__avs = { stats: player.stats, events, telemetry, arm, abr, sid: cfg.sid };
    setRunning(true);
    void player.start();
  };

  useEffect(() => {
    if (initial.autoplay) start();
    const t = setInterval(() => {
      const p = playerRef.current;
      if (p) setStats({ ...p.stats, bufferS: p.bufferAheadS(), segments: [...p.stats.segments] });
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = stats?.currentQuality;
  const rung = q !== null && q !== undefined ? stats?.ladder[q] : undefined;
  return (
    <div className="app">
      <header>
        <h1>AVS adaptive player</h1>
        <span className="muted">MSE + pluggable ABR · session {initial.sid}</span>
      </header>
      <div className="controls">
        <label>
          ABR{' '}
          <select value={abr} onChange={(e) => setAbr(e.target.value as AbrName)} disabled={running}>
            {ABR_NAMES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Shaping trace{' '}
          <select value={trace} onChange={(e) => setTrace(e.target.value)} disabled={running}>
            {[...new Set([...TRACES, trace])].map((t) => (
              <option key={t} value={t}>
                {t || '(none: full speed)'}
              </option>
            ))}
          </select>
        </label>
        <button onClick={start}>{running ? 'Restart' : 'Play'}</button>
      </div>
      <video ref={videoRef} controls muted playsInline data-testid="video" />
      <div className="stats" data-testid="stats">
        <Stat label="state" value={stats?.state ?? 'idle'} />
        <Stat label="rung" value={rung ? `${rung.index} · ${rung.height}p · ${rung.kbps} kbps` : '—'} />
        <Stat label="buffer" value={`${(stats?.bufferS ?? 0).toFixed(1)} s`} />
        <Stat label="startup" value={stats?.startupMs != null ? `${stats.startupMs.toFixed(0)} ms` : '—'} />
        <Stat label="rebuffers" value={`${stats?.rebufferCount ?? 0} (${((stats?.rebufferMs ?? 0) / 1000).toFixed(1)} s)`} />
        <Stat label="switches" value={String(stats?.switches ?? 0)} />
      </div>
      {stats && stats.segments.length > 0 && <Timeline segments={stats.segments} ladder={stats.ladder} />}
      <pre className="log">{log.join('\n')}</pre>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="muted">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
