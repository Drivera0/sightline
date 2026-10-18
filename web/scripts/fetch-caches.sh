#!/usr/bin/env bash

# Download both public survey caches before Vercel builds the production app.
set -euo pipefail

mkdir -p public/cache
curl -fsSL \
  https://github.com/Drivera0/sightline/releases/download/demo-cache/demo-cache.tar.gz \
  | tar -xz -C public/cache
curl -fsSL \
  https://github.com/Drivera0/sightline/releases/download/real-gps-cache/real-gps-cache.tar.gz \
  | tar -xz -C public/cache
