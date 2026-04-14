#!/usr/bin/env bash
# Download public network-throughput trace datasets into data/raw/ and convert them to the
# canonical "<time_s> <mbps>" format in data/traces/<set>/. Nothing here is committed.
#
# Sources (see README "Data sources" for terms):
#  - norway:  HSDPA 3G bandwidth logs, Riiser et al., MMSys 2013. Simula Research Laboratory.
#             https://datasets.simula.no/hsdpa/  (free access; please cite the dataset paper)
#  - belgium: 4G/LTE bandwidth logs, van der Hooft et al., IEEE Comm. Letters 2016. IDLab/UGent.
#             https://users.ugent.be/~jvdrhoof/dataset-4g/  (free access; please cite)
#  - fcc:     NOT downloaded automatically: data.fcc.gov returns HTTP 403 to scripted clients.
#             See RESULTS.md TODO for manual steps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
mkdir -p "$RAW/norway" "$RAW/belgium"

NORWAY_BASE="https://datasets.simula.no/downloads/hsdpa-tcp-logs"
ROUTES=(bus.ljansbakken-oslo car.aarnes-elverum car.oslo-grimstad car.snaroya-smestad
        ferry.nesoddtangen-oslo metro.kalbakken-jernbanetorget train.oslo-vestby
        train.vestby-oslo tram.jernbanetorget-ljabru tram.jernbanetorget-universitetssykehuset
        tram.ljabru-jernbanetorget)
for r in "${ROUTES[@]}"; do
  mkdir -p "$RAW/norway/$r"
  files=$(curl -fsSL "$NORWAY_BASE/$r/" | grep -oE 'href="report\.[^"]+\.log"' | sed -E 's/href="(.*)"/\1/' | sort -u)
  for f in $files; do
    [[ -s "$RAW/norway/$r/$f" ]] || curl -fsSL --retry 3 -o "$RAW/norway/$r/$f" "$NORWAY_BASE/$r/$f"
  done
  echo "norway $r: $(ls "$RAW/norway/$r" | wc -l | tr -d ' ') logs"
done

if [[ ! -d "$RAW/belgium/logs" ]]; then
  curl -fsSL --retry 3 -o "$RAW/belgium/logs_all.zip" \
    "https://users.ugent.be/~jvdrhoof/dataset-4g/logs/logs_all.zip"
  (cd "$RAW/belgium" && mkdir -p logs && unzip -q -o logs_all.zip -d logs)
fi
echo "belgium: $(find "$RAW/belgium/logs" -type f -name '*.log' | wc -l | tr -d ' ') logs"

node "$ROOT/scripts/convert_traces.mjs" "$RAW" "$ROOT/data/traces"
mkdir -p "$ROOT/data/traces/synthetic"
cp "$ROOT"/traces/synthetic/*.txt "$ROOT/data/traces/synthetic/"
