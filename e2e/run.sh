#!/usr/bin/env bash
# Builds what the e2e test needs, then runs it. Requires Google Chrome (H.264) and packaged media.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -f media/hls/master.m3u8 ]] || { echo "run scripts/package.sh first"; exit 1; }
cmake --preset release >/dev/null && cmake --build --preset release --target avs_origin
npm run build -w @avs/player
cd e2e && npx playwright test "$@"
