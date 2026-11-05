#!/usr/bin/env bash
# Renders the listing screenshots (1600x1000) from scripts/screenshots/shots.html
# and the raw panel captures in assets/screenshots/src/.
# Why: build-time only, like render-cover.sh; the PNGs are committed.
set -euo pipefail
cd "$(dirname "$0")/.."
for shot in full minimal; do
  google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 \
    --screenshot="assets/screenshots/$shot.png" "file://$PWD/scripts/screenshots/shots.html#$shot"
  magick "assets/screenshots/$shot.png" -strip -define png:compression-level=9 "assets/screenshots/$shot.png"
done
