#!/usr/bin/env bash
# Robustness of the held-out result to the choice of split: reruns the whole pipeline of
# bench/abr_heldout.sh (train grid -> selection -> test) for split seeds 2..5 and prints each
# test-set headline row. Seed 1 is the pre-registered headline; these are a robustness check only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for s in 2 3 4 5; do
  SPLIT_SEED=$s bench/abr_heldout.sh > /dev/null 2> "bench/out/abr_heldout_seed$s.log" || { cat "bench/out/abr_heldout_seed$s.log"; exit 1; }
done
npx tsx packages/abr/src/cli/seed_table.ts bench/out/abr_heldout bench/out/abr_heldout_seed{2,3,4,5}
