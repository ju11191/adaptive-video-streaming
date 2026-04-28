#!/usr/bin/env bash
# Reruns every ABR benchmark of the BBA-1/BOLA follow-up with one command (RESULTS.md §7).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/bench/abr_compare.sh"
"$ROOT/bench/abr_sensitivity.sh"
"$ROOT/bench/abr_heldout.sh"
"$ROOT/bench/abr_heldout_seeds.sh"
