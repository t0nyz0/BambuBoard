#!/bin/sh
set -eu

# Explicit numeric users may have no usable home in the image. Chromium
# needs writable configuration and cache directories for scene capture.
if [ ! -d "${HOME:-}" ] || [ ! -w "$HOME" ]; then
  HOME="$(mktemp -d)"
  export HOME
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
