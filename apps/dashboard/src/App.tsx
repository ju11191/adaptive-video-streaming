import { useEffect, useRef, useState } from 'react';
import { LineChart } from './LineChart.tsx';
import type { ArmState, ConsumerState, TestState } from './types.ts';

const params = new URLSearchParams(location.search);
const API = params.get('api') ?? `http://${location.hostname || 'localhost'}:8082`;
const ARM_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

const fmtMs = (x: number) => `${Math.round(x)} ms`;
const fmtPct = (x: number) => `${(x * 100).toFixed(2)}%`;
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const ci95 = (m: { mean: number; sem: number }) => `± ${(1.96 * m.sem).toFixed(0)}`;

interface PHist {
  t: number;
  p: number;
}

export function App() {
  const [state, setState] = useState<ConsumerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pHist = useRef<PHist[]>([]);
  const epochRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/state`, { cache: 'no-store' });
        const s = (await r.json()) as ConsumerState;
        if (!alive) return;
        if (epochRef.current !== s.epoch.id) {
          pHist.current = [];
          epochRef.current = s.epoch.id;
        }
        const t = s.tests.startup_ms;
        if (t.n_control + t.n_treatment > 0) {
          pHist.current = [...pHist.current, { t: s.now_ms, p: t.p_value }].slice(-900);
        }
        setState(s);
        setError(null);
      } catch (e) {
        if (alive) setError(`cannot reach consumer at ${API} (${(e as Error).message})`);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const reset = async () => {
    await fetch(`${API}/api/reset`, { method: 'POST' });
  };

  if (!state) {
    return (
      <div className="app">
        <h1>A/B streaming experiment</h1>
        <p className="muted">{error ?? 'connecting…'}</p>
      </div>
    );
  }
  const armNames = Object.keys(state.arms).sort();
  const color = (name: string) => ARM_COLORS[Math.max(0, armNames.indexOf(name)) % ARM_COLORS.length]!;
  const test = state.tests.startup_ms;
  const elapsed = (state.now_ms - state.epoch.started_ms) / 1000;

  const windowSeries = (pick: (w: ConsumerState['windows'][number]['arms'][string]) => number | null) =>
    armNames.map((name) => ({
      name,
      color: color(name),
      // Skip the still-open window (its counts are partial).
      points: state.windows
        .filter((w) => state.watermark_ms === null || w.start_ms + state.config.window_ms <= state.watermark_ms)
        .map((w) => ({ x: w.start_ms, y: w.arms[name] ? pick(w.arms[name]!) : null })),
    }));

  return (
    <div className="app viz-root">
      <header>
        <div>
          <h1>A/B streaming experiment</h1>
          <div className="muted">
            epoch {state.epoch.id} · started {fmtTime(state.epoch.started_ms)} · {elapsed.toFixed(0)} s elapsed · consumer {API}
          </div>
        </div>
        <button onClick={() => void reset()} title="Start a new experiment epoch (clears stats and tests)">
          Reset experiment
        </button>
      </header>
      {error && <div className="banner warn">⚠ {error}</div>}

      <Decision test={test} elapsedS={elapsed} />

      <section className="cards">
        {armNames.map((name) => (
          <ArmCard key={name} name={name} color={color(name)} arm={state.arms[name]!} capMs={state.config.startup_cap_ms} />
        ))}
      </section>

      <section className="tests">
        <h2>Sequential tests (mSPRT, always-valid)</h2>
        <TestTable tests={[test, state.tests.rebuffer_ratio]} />
        <p className="muted small">
          Primary metric: startup time winsorized at {state.config.startup_cap_ms / 1000} s; a session enters the test{' '}
          {state.config.startup_cap_ms / 1000} s after it starts, in start order, so inclusion never depends on the value.
          The p-value and CI stay valid however often this page refreshes. The rebuffer-ratio test enters sessions in end
          order and is exploratory (secondary).
        </p>
      </section>

      <section className="charts">
        <LineChart
          title="Always-valid p-value, startup time (log scale)"
          yLabel="p"
          series={[{ name: 'p', color: 'var(--series-1)', points: pHist.current.map((h) => ({ x: h.t, y: h.p })) }]}
          formatX={fmtTime}
          formatY={(y) => (y < 0.001 ? y.toExponential(0) : y.toFixed(3))}
          reference={{ y: test.alpha, label: `α = ${test.alpha}` }}
          logY
        />
        <LineChart
          title={`Mean startup per ${state.config.window_ms / 1000} s window (capped)`}
          yLabel="ms"
          series={windowSeries((w) => w.startup_mean_ms)}
          formatX={fmtTime}
          formatY={fmtMs}
        />
        <LineChart
          title={`Sessions started per ${state.config.window_ms / 1000} s window`}
          yLabel="sessions"
          series={windowSeries((w) => w.sessions)}
          formatX={fmtTime}
          formatY={(y) => y.toFixed(0)}
        />
        <LineChart
          title={`Rebuffer events per ${state.config.window_ms / 1000} s window`}
          yLabel="events"
          series={windowSeries((w) => w.rebuffers)}
          formatX={fmtTime}
          formatY={(y) => y.toFixed(0)}
        />
      </section>

      <footer className="muted small">
        events {state.counters['events']} · invalid {state.counters['invalid'] ?? 0} · duplicates {state.counters['duplicates']} ·
        orphan {state.counters['orphan']} · active sessions {state.counters['active_sessions']} · pending startup obs{' '}
        {state.counters['pending_startup_obs']} · watermark {state.watermark_ms ? fmtTime(state.watermark_ms) : '—'}
      </footer>
    </div>
  );
}

function Decision({ test, elapsedS }: { test: TestState; elapsedS: number }) {
  const n = test.n_control + test.n_treatment;
  if (test.decision === 'reject') {
    const worse = test.diff > 0;
    return (
      <div className={`banner ${worse ? 'bad' : 'good'}`} data-testid="decision">
        <strong>{worse ? '✕ Regression detected' : '✓ Improvement detected'}</strong> — {test.treatment} startup is{' '}
        {fmtMs(Math.abs(test.diff))} {worse ? 'slower' : 'faster'} than {test.control} (always-valid 95% CI{' '}
        {fmtMs(test.ci_lo ?? NaN)} … {fmtMs(test.ci_hi ?? NaN)}). Decided after {test.decided_after_s?.toFixed(1)} s and{' '}
        {test.decided_at_n} sessions.
      </div>
    );
  }
  const burn = Math.min(test.n_control, test.n_treatment) < test.min_n_per_arm;
  return (
    <div className="banner neutral" data-testid="decision">
      <strong>● Keep running</strong> —{' '}
      {burn
        ? `burn-in: ${Math.min(test.n_control, test.n_treatment)}/${test.min_n_per_arm} sessions per arm`
        : `no significant startup difference yet (p = ${test.p_value.toFixed(3)}, ${n} sessions, ${elapsedS.toFixed(0)} s)`}
    </div>
  );
}

function ArmCard({ name, color, arm, capMs }: { name: string; color: string; arm: ArmState; capMs: number }) {
  return (
    <div className="card">
      <div className="card-title">
        <i style={{ background: color }} /> Arm {name}
      </div>
      <dl>
        <dt>sessions</dt>
        <dd>
          {arm.sessions} <span className="muted">({arm.sessions_ended} ended)</span>
        </dd>
        <dt>startup (capped)</dt>
        <dd>
          {arm.startup_ms.n ? `${fmtMs(arm.startup_ms.mean)} ${ci95(arm.startup_ms)}` : '—'}{' '}
          <span className="muted">
            {arm.startup_ms.n ? `${((arm.startup_capped / arm.startup_ms.n) * 100).toFixed(1)}% ≥ ${capMs / 1000} s` : ''}
          </span>
        </dd>
        <dt>rebuffer ratio</dt>
        <dd>{arm.rebuffer_ratio.n ? fmtPct(arm.rebuffer_ratio.mean) : '—'}</dd>
        <dt>rebuffers / session</dt>
        <dd>{arm.rebuffers_per_session.n ? arm.rebuffers_per_session.mean.toFixed(2) : '—'}</dd>
        <dt>avg bitrate</dt>
        <dd>{arm.avg_kbps.n ? `${arm.avg_kbps.mean.toFixed(0)} kbps` : '—'}</dd>
        <dt>switches / session</dt>
        <dd>{arm.switches_per_session.n ? arm.switches_per_session.mean.toFixed(2) : '—'}</dd>
        <dt>errors</dt>
        <dd>{arm.errors}</dd>
      </dl>
    </div>
  );
}

function TestTable({ tests }: { tests: TestState[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>metric</th>
            <th>n (ctl / trt)</th>
            <th>mean ctl</th>
            <th>mean trt</th>
            <th>diff</th>
            <th>always-valid 95% CI</th>
            <th>p (always-valid)</th>
            <th>log Λ / threshold</th>
            <th>decision</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => {
            const isMs = t.metric.startsWith('startup');
            const f = (x: number | null) => (x === null ? '—' : isMs ? fmtMs(x) : fmtPct(x));
            return (
              <tr key={t.metric}>
                <td>{t.metric}</td>
                <td>
                  {t.n_control} / {t.n_treatment}
                </td>
                <td>{f(t.mean_control)}</td>
                <td>{f(t.mean_treatment)}</td>
                <td>{f(t.diff)}</td>
                <td>{t.ci_lo === null ? '—' : `${f(t.ci_lo)} … ${f(t.ci_hi)}`}</td>
                <td>{t.p_value < 0.001 ? t.p_value.toExponential(1) : t.p_value.toFixed(3)}</td>
                <td>
                  {t.log_lambda.toFixed(2)} / {Math.log(1 / t.alpha).toFixed(2)}
                </td>
                <td>{t.decision === 'reject' ? `reject H0 (${t.decided_after_s?.toFixed(0)} s)` : 'continue'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
