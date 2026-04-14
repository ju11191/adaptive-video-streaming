#!/usr/bin/env bash
# Verifies GOP alignment of the packaged ladder: every segment of every rung starts with a
# keyframe, segment i starts at the same PTS on every rung, and consecutive segment starts
# are exactly one segment duration apart.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm -v "$ROOT/media:/media" avs-ffmpeg bash -c '
for v in /media/hls/v*; do
  init=$(ls $v/init_*.mp4)
  n=$(ls $v/seg_*.m4s | wc -l)
  for i in $(seq 0 $((n-1))); do
    cat $init $v/seg_$i.m4s > /tmp/s.mp4
    echo "$(basename $v) $i $(ffprobe -v error -select_streams v:0 -show_entries frame=key_frame,pts_time \
      -read_intervals %+#1 -of csv=p=0 /tmp/s.mp4 | head -1)"
  done
done' | node -e '
const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => {
  const [v, i, kp] = l.split(" "); const [key, pts] = kp.split(",");
  return { v, i: +i, key: +key, pts: +pts };
});
let bad = 0;
const byIdx = new Map();
for (const r of rows) {
  if (r.key !== 1) { console.log(`not a keyframe: ${r.v} seg ${r.i}`); bad++; }
  if (!byIdx.has(r.i)) byIdx.set(r.i, []);
  byIdx.get(r.i).push(r);
}
const starts = [];
for (const [i, rs] of [...byIdx].sort((a, b) => a[0] - b[0])) {
  const p = rs[0].pts;
  for (const r of rs) if (Math.abs(r.pts - p) > 1e-6) { console.log(`pts mismatch seg ${i}: ${r.v}=${r.pts} vs ${p}`); bad++; }
  starts.push(p);
}
for (let i = 1; i < starts.length; i++) {
  const d = starts[i] - starts[i - 1];
  if (Math.abs(d - 4) > 0.001) { console.log(`segment ${i} duration ${d.toFixed(4)} != 4`); bad++; }
}
const rungs = new Set(rows.map((r) => r.v)).size;
console.log(`checked ${rows.length} segments over ${rungs} rungs; first segment PTS ${starts[0]}; problems: ${bad}`);
process.exit(bad ? 1 : 0);
'
