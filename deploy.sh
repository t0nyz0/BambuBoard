#!/bin/bash
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not installed. See https://docs.docker.com/get-docker/"
  exit 1
fi

echo "Pulling BambuBoard..."
docker pull ghcr.io/t0nyz0/bambuboard:latest

echo "(Re)starting container..."
docker rm -f bambuboard >/dev/null 2>&1 || true

docker run -d \
  --name bambuboard \
  --restart unless-stopped \
  -p 8080:8080 \
  -e BAMBUBOARD_HTTP_PORT=8080 \
  -e BAMBUBOARD_PRINTER_TYPE=${BAMBUBOARD_PRINTER_TYPE:-X1} \
  -e BAMBUBOARD_PRINTER_URL=${BAMBUBOARD_PRINTER_URL:-10.0.0.1} \
  -e BAMBUBOARD_PRINTER_PORT=${BAMBUBOARD_PRINTER_PORT:-8883} \
  -e BAMBUBOARD_PRINTER_SN=${BAMBUBOARD_PRINTER_SN:-} \
  -e BAMBUBOARD_PRINTER_ACCESS_CODE=${BAMBUBOARD_PRINTER_ACCESS_CODE:-} \
  -e BAMBUBOARD_TEMP_SETTING=${BAMBUBOARD_TEMP_SETTING:-Both} \
  -e BAMBUBOARD_FAN_ICONS=${BAMBUBOARD_FAN_ICONS:-true} \
  -e BAMBUBOARD_LOGGING=${BAMBUBOARD_LOGGING:-false} \
  -v $(pwd)/data:/usr/src/app/data \
  ghcr.io/t0nyz0/bambuboard:latest

echo "BambuBoard running at http://localhost:8080"
echo "If you haven't configured a printer yet, the setup wizard opens automatically."
