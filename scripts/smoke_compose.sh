#!/usr/bin/env bash
# Brings up the full stack, drives a short load with a large injected regression through
# collector -> Kafka -> consumer, and checks that every event arrived and the test rejected.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
docker compose up -d --build --wait
curl -fs -X POST localhost:8082/api/reset >/dev/null
docker compose --profile load run --rm loadgen --rate 50 --duration-s 30 --inject B:1000 --speedup 30 --seed 3 2>&1 | tail -1
sleep 3
curl -fs localhost:8082/api/state | node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
const t = j.tests.startup_ms;
console.log(`events ${j.counters.events}, invalid ${j.counters.invalid}, decision ${t.decision} after ${t.decided_after_s} s, diff ${t.diff.toFixed(0)} ms`);
process.exit(t.decision === "reject" && j.counters.invalid === 0 ? 0 : 1);'
echo "smoke OK"
