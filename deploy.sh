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
  -e BAMBUBOARD_PRINTER_NAME \
  -e BAMBUBOARD_PRINTER_TYPE \
  -e BAMBUBOARD_PRINTER_URL \
  -e BAMBUBOARD_PRINTER_PORT \
  -e BAMBUBOARD_PRINTER_SN \
  -e BAMBUBOARD_PRINTER_ACCESS_CODE \
  -e BAMBUBOARD_TEMP_SETTING \
  -e BAMBUBOARD_FAN_PERCENTAGES \
  -e BAMBUBOARD_FAN_ICONS \
  -e BAMBUBOARD_LOGGING \
  -v "$DATA_DIR:/usr/src/app/data" \
  "$IMAGE"

echo "BambuBoard running at http://localhost:8080"
echo "If you haven't configured a printer yet, the setup wizard opens automatically."
