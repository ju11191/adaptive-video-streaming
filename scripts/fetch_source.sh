#!/usr/bin/env bash
# Download the freely licensed source clip (Big Buck Bunny, (c) Blender Foundation,
# CC-BY 3.0, https://peach.blender.org/) into media/source/. Never committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/media/source"
URL="https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip"
mkdir -p "$OUT"
if [[ -f "$OUT/bbb_sunflower_1080p_30fps_normal.mp4" ]]; then
  echo "source already present: $OUT/bbb_sunflower_1080p_30fps_normal.mp4"; exit 0
fi
curl -fL --retry 3 -o "$OUT/bbb.zip" "$URL"
(cd "$OUT" && unzip -o bbb.zip && rm bbb.zip)
ls -la "$OUT"
