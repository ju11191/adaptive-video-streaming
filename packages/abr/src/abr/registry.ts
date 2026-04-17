import { BbaRule } from './bba.ts';
import { ThroughputRule } from './throughput.ts';
import type { AbrAlgorithm } from './types.ts';

export const ABR_NAMES = ['throughput', 'bba', 'bba-guard'] as const;
export type AbrName = (typeof ABR_NAMES)[number];

export function isAbrName(s: string): s is AbrName {
  return (ABR_NAMES as readonly string[]).includes(s);
}

/** Factory so every consumer (player, simulator, loadgen) builds identical algorithms. */
export function createAbr(name: AbrName): AbrAlgorithm {
  switch (name) {
    case 'throughput':
      return new ThroughputRule();
    case 'bba':
      return new BbaRule({ startupGuard: false });
    case 'bba-guard':
      return new BbaRule({ startupGuard: true });
  }
}

/**
 * Builds an algorithm from a spec "name[:key=value,...]", e.g. "bba:reservoirS=5,cushionS=30"
 * or "throughput:safety=0.8". Unknown keys are an error. The returned algorithm's name is the spec.
 */
export function createAbrFromSpec(spec: string): AbrAlgorithm {
  const [name, params = ''] = spec.split(':', 2) as [string, string?];
  if (!isAbrName(name)) throw new Error(`unknown ABR "${name}"`);
  const opts: Record<string, number> = {};
  for (const kv of params.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    const n = Number(v);
    if (!k || !Number.isFinite(n)) throw new Error(`bad ABR parameter "${kv}"`);
    opts[k] = n;
  }
  const allowed: Record<AbrName, string[]> = {
    throughput: ['window', 'safety'],
    bba: ['reservoirS', 'cushionS'],
    'bba-guard': ['reservoirS', 'cushionS', 'guardSafety'],
  };
  for (const k of Object.keys(opts)) {
    if (!allowed[name].includes(k)) throw new Error(`ABR "${name}" has no parameter "${k}"`);
  }
  const algo: AbrAlgorithm =
    name === 'throughput'
      ? new ThroughputRule(opts)
      : new BbaRule({ ...opts, startupGuard: name === 'bba-guard' });
  if (!params) return algo;
  return { name: spec, choose: (c) => algo.choose(c), reset: () => algo.reset() };
}
