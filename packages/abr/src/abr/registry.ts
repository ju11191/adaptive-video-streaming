import { BbaRule } from './bba.ts';
import { Bba1Rule } from './bba1.ts';
import { BolaERule, BolaRule } from './bola.ts';
import { ThroughputRule } from './throughput.ts';
import type { AbrAlgorithm } from './types.ts';

export const ABR_NAMES = ['throughput', 'bba', 'bba-guard', 'bba1', 'bola', 'bola-e'] as const;
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
    case 'bba1':
      return new Bba1Rule();
    case 'bola':
      return new BolaRule();
    case 'bola-e':
      return new BolaERule();
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
    bba1: ['lookaheadS', 'reservoirMinS', 'reservoirMaxS', 'cushionEndS', 'useEstimate', 'nominalSizes'],
    bola: ['qLowS', 'qMaxS', 'gammaP'],
    'bola-e': ['qLowS', 'qMaxS', 'gammaP'],
  };
  for (const k of Object.keys(opts)) {
    if (!allowed[name].includes(k)) throw new Error(`ABR "${name}" has no parameter "${k}"`);
  }
  const algo = build(name, opts);
  if (!params) return algo;
  return { name: spec, choose: (c) => algo.choose(c), reset: () => algo.reset() };
}

function build(name: AbrName, opts: Record<string, number>): AbrAlgorithm {
  switch (name) {
    case 'throughput':
      return new ThroughputRule(opts);
    case 'bba':
    case 'bba-guard':
      return new BbaRule({ ...opts, startupGuard: name === 'bba-guard' });
    case 'bba1':
      return new Bba1Rule(opts);
    case 'bola':
      return new BolaRule(opts);
    case 'bola-e':
      return new BolaERule(opts);
  }
}
