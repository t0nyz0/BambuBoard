#!/bin/bash

echo "Checking if Docker is installed..."
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
fi

echo "Pulling the BambuBoard Docker image..."
docker pull ghcr.io/t0nyz0/bambuboard:latest

echo "Running the BambuBoard container..."
docker run -d \
  --name bambuboard \
  -p 8080:8080 \
  -e BAMBUBOARD_HTTP_PORT=8080 \
  -e BAMBUBOARD_PRINTER_URL=10.0.0.1 \
  -e BAMBUBOARD_PRINTER_PORT=8883 \
  -e BAMBUBOARD_PRINTER_SN=bambu_serialnumber \
  -e BAMBUBOARD_PRINTER_ACCESS_CODE=bambu_accesscode \
  -e BAMBUBOARD_TEMP_SETTING=both \
  -e BAMBUBOARD_FAN_PERCENTAGES=true \
  -e BAMBUBOARD_FAN_ICONS=true \
  -e BAMBUBOARD_PRINTER_TYPE=X1 \
  -e BAMBUBOARD_LOGGING=false \
  ghcr.io/t0nyz0/bambuboard:latest

echo "BambuBoard is now running at http://localhost:8080"