#!/usr/bin/env bash
# ABR comparison: throughput baseline vs BBA vs BBA+startup guard over the full trace set.
# Prerequisites: scripts/fetch_traces.sh and scripts/package.sh (for real VBR segment sizes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx tsx packages/abr/src/cli/compare.ts \
  --traces data/traces/norway,data/traces/belgium \
  --algos throughput,bba,bba-guard --baseline throughput \
  --offsets 5 --seed 1 --out bench/out/abr "$@"
