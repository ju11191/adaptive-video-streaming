#!/usr/bin/env bash
# Live detection benchmark through the docker-compose pipeline (see bench/detect_live.ts).
# Brings the stack up, then runs: +300 ms at 20 sessions/s (5 runs), 10/s (3 runs), 50/s (3 runs),
# and A/A (0 ms) at 20/s (2 runs, 10 min each) to check for false positives.
# Run under `caffeinate -i` on macOS (or keep the host awake): a suspended host invalidates a run,
# which detect_live.ts detects (poll gap > 5 s) and excludes from the summary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
docker compose up -d --build --wait
npx tsx bench/detect_live.ts --rate 20 --inject-ms 300 --runs 5 --timeout-s 900 --seed 100
npx tsx bench/detect_live.ts --rate 10 --inject-ms 300 --runs 3 --timeout-s 1200 --seed 200
npx tsx bench/detect_live.ts --rate 50 --inject-ms 300 --runs 3 --timeout-s 600 --seed 300
npx tsx bench/detect_live.ts --rate 20 --inject-ms 0 --runs 2 --timeout-s 600 --seed 400
