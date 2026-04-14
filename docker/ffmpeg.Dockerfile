# FFmpeg toolbox used by scripts/package.sh (keeps ffmpeg off the host).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /media
