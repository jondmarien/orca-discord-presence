#!/usr/bin/env bash
# Renders assets/cover.webp (1600x1000) from scripts/cover/cover.html and assets/icon.png (256x256) from assets/orca.png.
# Why: headless Chromium is build-time only; the WEBPs are committed and this script is not shipped.
set -euo pipefail
cd "$(dirname "$0")/.."
google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 \
  --screenshot=/tmp/cover.png "file://$PWD/scripts/cover/cover.html"
magick /tmp/cover.png -quality 90 -define webp:method=6 assets/cover.webp
magick assets/orca.png -resize 256x256 -strip assets/icon.png
