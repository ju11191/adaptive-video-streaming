#!/usr/bin/env bash
# Sensitivity of the ABR comparison to parameters. These runs are IN-SAMPLE (same traces as
# the headline benchmark), so they explain the result; they are not a tuned headline number.
# Includes the Pensieve-paper configuration (RB with no safety factor; BB reservoir 5 s, cushion 10 s).
# Follow-up variants: BBA-1 with nominal sizes (ablates VBR awareness) and with an estimated-capacity
# reservoir; BOLA in the paper's §IV-B form with gamma*p = 5.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx tsx packages/abr/src/cli/compare.ts \
  --traces data/traces/norway,data/traces/belgium \
  --algos "throughput;throughput:safety=1;throughput:safety=0.7;bba:reservoirS=5,cushionS=10;bba:reservoirS=5,cushionS=40;bba:reservoirS=20,cushionS=30;bba-guard:reservoirS=20,cushionS=30;bba1;bba1:nominalSizes=1;bba1:useEstimate=1;bola;bola:gammaP=5;bola-e;bola-e:gammaP=5" \
  --baseline throughput --offsets 5 --seed 1 --resamples 2000 --out bench/out/abr_sensitivity "$@"
