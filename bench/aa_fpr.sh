#!/usr/bin/env bash
# A/A false-positive rate of the mSPRT under continuous monitoring (checked after every
# observation), versus naive repeated Welch tests, on four distributions.
# Needs: release build (cmake --preset release && cmake --build --preset release) and
# bench/out/startup_samples.txt (generated here if missing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN=build/release/avs_aa_fpr
SAMPLES=bench/out/startup_samples.txt
[[ -f $SAMPLES ]] || npx tsx packages/abr/src/cli/startup_samples.ts --n 20000 --out $SAMPLES
EXP=${EXPERIMENTS:-5000}
N=${MAX_N:-20000}
run() { echo "\$ $BIN $*"; $BIN "$@"; echo; }
run --experiments $EXP --max-n $N --dist normal:1000:300 --tau 100 --burn-in 200 --seed 1
run --experiments $EXP --max-n $N --dist lognormal:1500:0.8 --tau 250 --burn-in 200 --seed 2
run --experiments $EXP --max-n $N --dist empirical:$SAMPLES --tau 250 --burn-in 200 --seed 3
run --experiments $EXP --max-n $N --dist empirical:$SAMPLES --cap 10000 --tau 250 --burn-in 200 --seed 4
