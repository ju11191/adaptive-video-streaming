/** Shape of GET /api/state from cpp/consumer (Aggregator::state_json). */
export interface Moments {
  n: number;
  mean: number;
  sd: number;
  sem: number;
}

export interface ArmState {
  sessions: number;
  sessions_ended: number;
  startups: number;
  startup_ms: Moments;
  startup_capped: number;
  rebuffer_ratio: Moments;
  rebuffers_per_session: Moments;
  avg_kbps: Moments;
  switches_per_session: Moments;
  errors: number;
}

export interface TestState {
  metric: string;
  control: string;
  treatment: string;
  alpha: number;
  tau: number;
  min_n_per_arm: number;
  n_control: number;
  n_treatment: number;
  mean_control: number;
  mean_treatment: number;
  diff: number;
  log_lambda: number;
  p_value: number;
  ci_lo: number | null;
  ci_hi: number | null;
  decision: 'continue' | 'reject';
  decided_at_n: number;
  decided_wall_ms: number;
  decided_after_s: number | null;
}

export interface WindowArm {
  sessions: number;
  startups: number;
  startup_mean_ms: number | null;
  rebuffers: number;
  rebuffer_ms: number;
  switches: number;
  errors: number;
  ended: number;
}

export interface ConsumerState {
  epoch: { id: number; started_ms: number };
  now_ms: number;
  watermark_ms: number | null;
  config: { window_ms: number; startup_cap_ms: number; lateness_ms: number };
  counters: Record<string, number>;
  arms: Record<string, ArmState>;
  windows: { start_ms: number; arms: Record<string, WindowArm> }[];
  tests: { startup_ms: TestState; rebuffer_ratio: TestState };
}
