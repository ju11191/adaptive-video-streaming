import { ABR_NAMES, type AbrName, assignArm, isAbrName } from '@avs/abr';

/** Runtime configuration from the page URL, e.g. ?trace=synthetic/step&abr=bba&autoplay=1 */
export interface PlayerConfig {
  origin: string;
  masterPath: string;
  collector: string | null;
  exp: string;
  arms: { name: string; abr: AbrName }[];
  /** Explicit ABR override; otherwise the arm's ABR is used. */
  abr: AbrName | null;
  trace: string | null;
  rttMs: number;
  sid: string;
  autoplay: boolean;
  maxBufferS: number;
}

function randomId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return `p-${Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function readConfig(search: string = location.search): PlayerConfig {
  const q = new URLSearchParams(search);
  const host = location.hostname || 'localhost';
  const arms = (q.get('arms') ?? 'A:throughput,B:bba').split(',').map((p) => {
    const [name, abr] = p.split(':');
    if (!name || !abr || !isAbrName(abr)) throw new Error(`bad arms entry ${p}`);
    return { name, abr };
  });
  const abr = q.get('abr');
  const collector = q.get('collector');
  return {
    origin: q.get('origin') ?? `http://${host}:8080`,
    masterPath: q.get('master') ?? '/hls/master.m3u8',
    collector: collector === 'none' ? null : (collector ?? `http://${host}:8081`),
    exp: q.get('exp') ?? 'exp1',
    arms,
    abr: abr && isAbrName(abr) ? abr : null,
    trace: q.get('trace') || null,
    rttMs: Number(q.get('rtt_ms') ?? 0),
    sid: q.get('sid') ?? randomId(),
    autoplay: q.get('autoplay') === '1',
    maxBufferS: Number(q.get('max_buffer') ?? 60),
  };
}

export function armFor(cfg: PlayerConfig): { arm: string; abr: AbrName } {
  const arm = assignArm(cfg.exp, cfg.sid, cfg.arms);
  const abr = cfg.abr ?? cfg.arms.find((a) => a.name === arm)!.abr;
  return { arm, abr };
}

export { ABR_NAMES };
