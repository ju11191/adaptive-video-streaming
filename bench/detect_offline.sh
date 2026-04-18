#!/usr/bin/env bash
# Offline (no pipeline) time-to-detect for a startup-time regression vs traffic rate and effect
# size, using the simulator's empirical startup distribution capped at 10 s and the same mSPRT
# configuration as the consumer (alpha 0.05, tau 250 ms, burn-in 200/arm, cohort inclusion).
# Also shows the A/A false-positive rate for value-dependent ("completion") vs cohort inclusion.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN=build/release/avs_detect_sim
SAMPLES=bench/out/startup_samples.txt
[[ -f $SAMPLES ]] || npx tsx packages/abr/src/cli/startup_samples.ts --n 20000 --out $SAMPLES
COMMON=(--dist empirical:$SAMPLES --cap 10000 --tau 250 --burn-in 200 --alpha 0.05)
run() { echo "\$ $BIN $*"; $BIN "$@"; echo; }
run "${COMMON[@]}" --inclusion cohort --rates 2,5,10,20,50,100 --effects 100,200,300,500,1000 --runs 200 --horizon-s 3600 --seed 1
run "${COMMON[@]}" --inclusion cohort --rates 5,20,100 --effects 0 --runs 2000 --horizon-s 1800 --seed 2
run "${COMMON[@]}" --inclusion completion --rates 5,20,100 --effects 0 --runs 2000 --horizon-s 1800 --seed 2
