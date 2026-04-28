#!/usr/bin/env bash
# ABR comparison over the full trace set: throughput baseline vs BBA-0, BBA+startup guard and
# (follow-up) BBA-1, BOLA-BASIC and BOLA-E, all with their a-priori defaults.
# Prerequisites: scripts/fetch_traces.sh and scripts/package.sh (for real VBR segment sizes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx tsx packages/abr/src/cli/compare.ts \
  --traces data/traces/norway,data/traces/belgium \
  --algos throughput,bba,bba-guard,bba1,bola,bola-e --baseline throughput \
  --offsets 5 --seed 1 --out bench/out/abr "$@"
