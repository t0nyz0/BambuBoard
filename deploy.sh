#!/bin/bash
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not installed. See https://docs.docker.com/get-docker/"
  exit 1
fi

echo "Pulling BambuBoard..."
IMAGE=ghcr.io/t0nyz0/bambuboard:latest
DATA_DIR="$(pwd)/data"
mkdir -p "$DATA_DIR"
docker pull "$IMAGE"

echo "(Re)starting container..."
was_running="$(docker inspect -f '{{.State.Running}}' bambuboard 2>/dev/null || true)"
if [ "$was_running" = true ]; then docker stop bambuboard; fi
if [ "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = node ] &&
   ! docker run --rm --network none -v "$DATA_DIR:/usr/src/app/data" "$IMAGE" \
      node -e 'require("./src/lib/containerData").checkContainerData("/usr/src/app/data")'; then
  if ! docker run --rm --network none --user 0:0 -v "$DATA_DIR:/usr/src/app/data" "$IMAGE" \
      node scripts/docker-migrate-data.js; then
    if [ "$was_running" = true ]; then docker start bambuboard; fi
    exit 1
  fi
fi
docker rm bambuboard >/dev/null 2>&1 || true

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
  -v "$DATA_DIR:/usr/src/app/data" \
  "$IMAGE"

echo "BambuBoard running at http://localhost:8080"
echo "If you haven't configured a printer yet, the setup wizard opens automatically."
