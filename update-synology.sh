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
#   4. Settings, scenes, and gcode cache persist in a Docker volume
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
VOLUME="bambuboard-data"

echo "==> Pulling latest BambuBoard image..."
docker pull "$IMAGE"

echo "==> Stopping old container (if running)..."
docker stop "$CONTAINER" 2>/dev/null || true
docker rm "$CONTAINER" 2>/dev/null || true

echo "==> Starting BambuBoard..."
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  -v "$VOLUME":/usr/src/app/data \
  "$IMAGE"

echo ""
echo "==> BambuBoard is running!"
echo "    Open http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'your-nas-ip'):8080"
echo ""
echo "    Settings are stored in Docker volume '$VOLUME' and persist across updates."

# Clean up old dangling images to free disk space on the NAS
echo "==> Cleaning up old images..."
docker image prune -f --filter "label=org.opencontainers.image.title=bambuboard" 2>/dev/null || true
