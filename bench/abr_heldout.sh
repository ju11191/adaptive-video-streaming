#!/usr/bin/env bash
# Held-out evaluation of the follow-up algorithms:
#   1. split the traces 50/50 by trace, stratified by dataset (split seed 1);
#   2. run the pre-registered grid on the TRAIN half only;
#   3. pick one configuration per algorithm with the pre-registered rule (select.ts);
#   4. report throughput, BBA-0, the paper defaults and the tuned picks on the TEST half.
# Benchmark settings are identical to bench/abr_compare.sh (RTT 80 ms, 60 s buffer, 5 offsets, seed 1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT=bench/out/abr_heldout
COMMON=(--traces data/traces/norway,data/traces/belgium --baseline throughput --offsets 5 --seed 1 --split-seed 1)

grid="throughput"
for r in 8 12 16 20 24; do for c in 40 47 54; do grid+=";bba1:reservoirMinS=$r,cushionEndS=$c"; done; done
for q in 5 10 15 20 25 30; do grid+=";bola:qLowS=$q"; done
for q in 5 10 15 20 25 30; do grid+=";bola-e:qLowS=$q"; done

echo "== train: grid search ==" >&2
npx tsx packages/abr/src/cli/compare.ts "${COMMON[@]}" --subset train --algos "$grid" --out "$OUT/train" > /dev/null
tuned="$(npx tsx packages/abr/src/cli/select.ts --results "$OUT/train/results.json" --min-kbps-ratio 0.95)"
echo "== selected on train: $tuned ==" >&2

echo "== test: held-out comparison ==" >&2
npx tsx packages/abr/src/cli/compare.ts "${COMMON[@]}" --subset test \
  --algos "throughput;bba;bba1;bola;bola-e;$tuned" --out "$OUT/test" "$@"
