#!/bin/bash
# BambuBoard — one-command update for Synology NAS (or any Docker host).
#
# SSH into your NAS and run:
#   ./update-synology.sh
#
# What it does:
#   1. Pulls the latest image from GHCR
#   2. Stops and removes the old container
#   3. Starts a fresh container with host networking
#   4. Settings, scenes, and gcode cache persist in ~/bambuboard-data/
#
# First-time setup:
#   Place this script anywhere on your NAS, then:
#     chmod +x update-synology.sh
#     ./update-synology.sh

set -e

# Re-exec under sudo if not already root (Synology's docker socket is root-only)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

IMAGE="ghcr.io/t0nyz0/bambuboard:latest"
CONTAINER="bambuboard"
DATA_DIR="$HOME/bambuboard-data"

# Create the persistent data directory if it doesn't exist
mkdir -p "$DATA_DIR"

echo "==> Pulling latest BambuBoard image..."
docker pull "$IMAGE"

echo "==> Stopping old container (if running)..."
was_running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$was_running" = true ]; then docker stop "$CONTAINER"; fi

# Prepare an older volume before removing the old container. Already
# writable mounts (including upgraded installs) keep their ownership.
if [ "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = node ] &&
   ! docker run --rm --network none -v "$DATA_DIR:/usr/src/app/data" "$IMAGE" \
      node -e 'require("./src/lib/containerData").checkContainerData("/usr/src/app/data")'; then
  echo "==> Preparing legacy BambuBoard data at $DATA_DIR..."
  if ! docker run --rm --network none --user 0:0 -v "$DATA_DIR:/usr/src/app/data" "$IMAGE" \
      node scripts/docker-migrate-data.js; then
    if [ "$was_running" = true ]; then docker start "$CONTAINER"; fi
    exit 1
  fi
fi
docker rm "$CONTAINER" 2>/dev/null || true

echo "==> Starting BambuBoard..."
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  -v "$DATA_DIR":/usr/src/app/data \
  "$IMAGE"

echo ""
echo "==> BambuBoard is running!"
echo "    Open http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'your-nas-ip'):8080"
echo ""
echo "    Settings are stored in $DATA_DIR and persist across updates."

# Clean up old dangling images to free disk space on the NAS
echo "==> Cleaning up old images..."
docker image prune -f 2>/dev/null || true
