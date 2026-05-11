#!/usr/bin/env bash
# Capture documentation screenshots of the Playbill renderer.
#
# Runs headless Chromium against ./preview.html with a different ?scene= for
# each shot, then copies the PNGs into ../ (docs/app/images/) and applies a
# few ImageMagick callout overlays where the doc benefits from a highlight.
#
# Requirements: chromium (snap or apt), imagemagick (`convert`).
#
# Usage:   ./capture.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(cd "$HERE/.." && pwd)"
PREVIEW="file://${HERE}/preview.html"

# Snap chromium cannot write to /tmp or /media. Stage screenshots inside
# the snap's writable common dir, then move them into the docs tree.
STAGE_DIR="${HOME}/snap/chromium/common/playbill-shots"
mkdir -p "$STAGE_DIR"

SCENES=(
  home
  sidebar-live
  sidebar-radio
  livetv-empty-no-tuner
  livetv-empty-no-channels
  livetv-scanning
  livetv-channel-grid
  livetv-channel-tuning
  radio-empty-no-dongle
  radio-full-layout
  radio-dial-detail
  radio-presets
)

echo "Capturing ${#SCENES[@]} scenes from $PREVIEW"
for scene in "${SCENES[@]}"; do
  echo "  → ${scene}"
  chromium \
    --headless \
    --disable-gpu \
    --no-sandbox \
    --hide-scrollbars \
    --window-size=1920,1080 \
    --virtual-time-budget=5000 \
    --screenshot="${STAGE_DIR}/${scene}.png" \
    "${PREVIEW}?scene=${scene}" 2>/dev/null
  cp "${STAGE_DIR}/${scene}.png" "${OUT_DIR}/${scene}.png"
done

echo
echo "Wrote ${#SCENES[@]} files into ${OUT_DIR}/"
echo "If a shot looks wrong, edit preview.html (mock fixtures or post-mount key dispatch) and re-run."
