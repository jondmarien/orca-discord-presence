#!/usr/bin/env bash
# Renders the listing screenshots (1600x1000) from scripts/screenshots/shots.html
# and the raw panel captures in assets/screenshots/src/.
# Why: build-time only, like render-cover.sh; the WEBPs are committed.
set -euo pipefail
cd "$(dirname "$0")/.."
for shot in full minimal; do
  google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 \
    --screenshot="/tmp/$shot.png" "file://$PWD/scripts/screenshots/shots.html#$shot"
  magick "/tmp/$shot.png" -quality 90 -define webp:method=6 "assets/screenshots/$shot.webp"
done
