import { fnv1a32 } from '../experiment/assign.ts';
import { mulberry32 } from './stats.ts';

export interface TraceSplit {
  /** Keys are "<dataset>/<trace name>". */
  train: string[];
  test: string[];
}

/**
 * Train/test split by trace, stratified by dataset. Within each dataset the
 * sorted names are Fisher-Yates shuffled with mulberry32(fnv1a32("split:" + seed)); the first
 * floor(n * trainFraction) are train, the rest test. Deterministic and independent of input order.
 */
export function splitTraces(byDataset: Record<string, readonly string[]>, seed: number, trainFraction = 0.5): TraceSplit {
  const out: TraceSplit = { train: [], test: [] };
  for (const set of Object.keys(byDataset).sort()) {
    const names = [...byDataset[set]!].sort();
    const rand = mulberry32(fnv1a32(`split:${seed}`));
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [names[i], names[j]] = [names[j]!, names[i]!];
    }
    const nTrain = Math.floor(names.length * trainFraction);
    names.forEach((n, i) => (i < nTrain ? out.train : out.test).push(`${set}/${n}`));
  }
  return out;
}
