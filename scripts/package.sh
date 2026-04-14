#!/usr/bin/env bash
# Transcode the source clip into a 6-rung H.264 ladder, packaged as HLS with CMAF (fMP4)
# segments: aligned 4 s GOPs (IDR every 120 frames at 30 fps, no scene-cut keyframes),
# fixed 4 s segments, identical profile/level on every rung. FFmpeg runs in Docker.
#
#   scripts/package.sh [seconds]      (default 192 s = 48 segments)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECONDS_TO_ENCODE="${1:-192}"
SRC="source/bbb_sunflower_1080p_30fps_normal.mp4"
OUT="$ROOT/media/hls"
[[ -f "$ROOT/media/$SRC" ]] || "$ROOT/scripts/fetch_source.sh"

docker build -q -t avs-ffmpeg -f "$ROOT/docker/ffmpeg.Dockerfile" "$ROOT/docker" >/dev/null
rm -rf "$OUT" && mkdir -p "$OUT"

# rung: width height kbps
RUNGS=("426 240 300" "640 360 750" "854 480 1200" "960 540 1850" "1280 720 2850" "1920 1080 4300")
N=${#RUNGS[@]}
FILTER="[0:v]fps=30,split=$N"
for i in $(seq 0 $((N - 1))); do FILTER+="[s$i]"; done
FILTER+=";"
MAPS=()
VSM=""
for i in $(seq 0 $((N - 1))); do
  read -r W H K <<<"${RUNGS[$i]}"
  FILTER+="[s$i]scale=${W}:${H}:flags=bicubic,setsar=1[o$i];"
  MAPS+=(-map "[o$i]" "-b:v:$i" "${K}k" "-maxrate:v:$i" "$((K * 11 / 10))k" "-bufsize:v:$i" "$((K * 2))k")
  VSM+="v:$i,name:$i "
done
FILTER="${FILTER%;}"

docker run --rm -v "$ROOT/media:/media" avs-ffmpeg \
  ffmpeg -hide_banner -loglevel warning -stats -y -t "$SECONDS_TO_ENCODE" -i "/media/$SRC" \
  -filter_complex "$FILTER" "${MAPS[@]}" \
  -c:v libx264 -preset veryfast -profile:v high -level:v 4.0 -pix_fmt yuv420p \
  -g 120 -keyint_min 120 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*4)" \
  -x264-params "open-gop=0" -an -t "$SECONDS_TO_ENCODE" \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_flags independent_segments -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "/media/hls/v%v/seg_%d.m4s" \
  -master_pl_name master.m3u8 -var_stream_map "${VSM% }" \
  "/media/hls/v%v/playlist.m3u8"

node "$ROOT/scripts/make_ladder.mjs" "$OUT"
echo "packaged into $OUT"
