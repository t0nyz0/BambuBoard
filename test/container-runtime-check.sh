#!/usr/bin/env bash
set -euo pipefail

image="$1"
prefix="bambuboard-runtime-$$"
volume="$prefix-fresh"
scratch="$(mktemp -d)"
data=/usr/src/app/data

cleanup() {
  docker rm -f "$prefix-fresh" "$prefix-legacy" "$prefix-uid" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  # In the bind mount, fixture ownership belongs to the container runtime UID.
  docker run --rm --user 0:0 --network none -v "$scratch:/fixture" "$image" rm -rf /fixture/legacy /fixture/custom >/dev/null
  rmdir "$scratch"
}
trap cleanup EXIT

wait_healthy() {
  local name="$1" health
  for _ in {1..40}; do
    health="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
    if [[ "$health" == healthy ]]; then return; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == false ]]; then break; fi
    sleep 2
  done
  docker inspect -f '{{json .State.Health}}' "$name"
  docker logs "$name"
  return 1
}

docker volume create "$volume" >/dev/null
docker run -d --name "$prefix-fresh" --network none -v "$volume:$data" "$image" >/dev/null
wait_healthy "$prefix-fresh"
docker exec "$prefix-fresh" sh -ec 'test "$(id -u)" = 1000; test -w /usr/src/app/data'
docker exec "$prefix-fresh" node -e '
  fetch("http://127.0.0.1:8080/api/note", {
    method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify({text: "fresh volume"})
  }).then(r => require("node:assert").equal(r.status, 200));
'

mkdir "$scratch/legacy" "$scratch/custom"
docker run --rm --user 0:0 --network none -v "$scratch/legacy:$data" "$image" sh -ec '
  cd /usr/src/app/data
  printf "%s\n" "{\"BambuBoard_httpPort\":18082,\"printer\":{\"name\":\"Legacy Printer\"},\"cloudAuth\":{\"enabled\":true}}" > config.json
  printf "%s\n" "{\"accessToken\":\"fixture-only\"}" > accessToken.json
  printf "%s\n" "{\"text\":\"legacy note\"}" > note.json
  printf "%s\n" "{\"print\":{\"mc_percent\":65}}" > data.json
  mkdir scenes gcode-cache
  printf "%s\n" "{\"name\":\"Legacy scene\"}" > scenes/fixture.json
  printf "%s\n" "G90" > gcode-cache/fixture.gcode
  printf "%s\n" "host-owned sentinel" > host-file
  ln -s host-file active-scene.json
  chmod 700 . scenes gcode-cache
  chmod 400 config.json accessToken.json scenes/fixture.json gcode-cache/fixture.gcode
'
if docker run --rm --user 0:0 --network none -v "$scratch/legacy:$data" "$image" node scripts/docker-migrate-data.js; then
  echo 'Migration accepted a linked app file' >&2
  exit 1
fi
docker run --rm --user 0:0 --network none -v "$scratch/legacy:$data" "$image" \
  sh -ec 'test "$(stat -c %u /usr/src/app/data)" = 0; rm /usr/src/app/data/active-scene.json'
docker run --rm --user 0:0 --network none -v "$scratch/legacy:$data" "$image" node scripts/docker-migrate-data.js
docker run --rm --user 0:0 --network none -v "$scratch/legacy:$data" "$image" node scripts/docker-migrate-data.js
docker run -d --name "$prefix-legacy" --network none -v "$scratch/legacy:$data" \
  -e BAMBUBOARD_HTTP_PORT= "$image" >/dev/null
wait_healthy "$prefix-legacy"
docker exec "$prefix-legacy" node -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const data = "/usr/src/app/data";
  (async () => {
    const base = "http://127.0.0.1:18082";
    const token = await fetch(base + "/auth/token").then(r => r.json());
    assert.equal(token.token, "fixture-only");
    const note = await fetch(base + "/api/note").then(r => r.json());
    assert.equal(note.text, "legacy note");
    const telemetry = await fetch(base + "/data.json").then(r => r.json());
    assert.equal(telemetry.print.mc_percent, 65);
    const settings = await fetch(base + "/api/settings").then(r => r.json());
    assert.equal(settings.printer.name, "Legacy Printer");
    assert.equal(fs.statSync(data + "/host-file").uid, 0);
    assert.equal(fs.readFileSync(data + "/scenes/fixture.json", "utf8").trim(), "{\"name\":\"Legacy scene\"}");
    assert.equal(fs.readFileSync(data + "/gcode-cache/fixture.gcode", "utf8").trim(), "G90");
    const written = await fetch(base + "/api/note", {
      method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify({text: "updated"})
    });
    assert.equal(written.status, 200);
    fs.accessSync(data + "/config.json", fs.constants.W_OK);
  })().catch(err => { console.error(err); process.exitCode = 1; });
'

docker run --rm --user 0:0 --network none -v "$scratch/custom:$data" "$image" chown 1234:2345 "$data"
docker run -d --name "$prefix-uid" --network none --user 1234:2345 -v "$scratch/custom:$data" \
  -e PORT=18083 -e BAMBUBOARD_HTTP_PORT=18084 "$image" >/dev/null
wait_healthy "$prefix-uid"
docker exec "$prefix-uid" sh -ec 'test "$(id -u)" = 1234; test "$(id -g)" = 2345'
if docker run --rm --network none -e PORT=18085 "$image" node scripts/docker-healthcheck.js; then
  echo 'Health probe succeeded without a listening server' >&2
  exit 1
fi
echo 'Non-root startup, health, migration, legacy data and explicit UID/GID passed.'
