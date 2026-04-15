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
