#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Playbill — Radxa Dragon Q6A image build orchestrator
#
# Builds a flashable Q6A image with the TrailCurrent Linux desktop and the
# Playbill app preinstalled. The desktop is the product; Playbill is one
# preinstalled application launched from the GNOME dock.
#
# Must be run as root (mmdebstrap requires it for chroot setup).
#
# Usage:
#   sudo ./image/build.sh                       # full build
#   sudo ./image/build.sh --sector-size 4096    # if NVMe uses 4k sectors
#   sudo ./image/build.sh --version 1.2.3
#   sudo ./image/build.sh --debug               # rsdk debug mode
#
# After a successful build:
#   sudo ./image/flash.sh --firmware            # one-time SPI NOR firmware
#   sudo ./image/flash.sh --os <image>          # NVMe OS image
# ============================================================================

set -uo pipefail

PLAYBILL_VERSION="0.1.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RSDK_DIR="${SCRIPT_DIR}/rsdk"
CACHE_DIR="${SCRIPT_DIR}/cache"
OUTPUT_DIR="${SCRIPT_DIR}/output"
STAGING_DIR="/tmp/playbill-staging"

ELECTRON_APP_DIR="${REPO_ROOT}/app/dist/linux-arm64-unpacked"
BRANDING_DIR="${REPO_ROOT}/branding"
ICONS_DIR="${REPO_ROOT}/app/packaging/icons"

SECTOR_SIZE=512
DEBUG_FLAG=""

GREEN='\033[38;5;70m'
TEAL='\033[38;5;30m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

log()    { echo -e "${GREEN}[+]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[!]${RESET} $*"; }
err()    { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
fatal()  { err "$*"; exit 1; }
section(){ echo ""; echo -e "${BOLD}${TEAL}════ $* ════${RESET}"; echo ""; }

while [ $# -gt 0 ]; do
    case "$1" in
        --sector-size) SECTOR_SIZE="$2"; shift 2 ;;
        --debug)       DEBUG_FLAG="--debug"; shift ;;
        --version)     PLAYBILL_VERSION="$2"; shift 2 ;;
        -h|--help)     sed -n '2,22p' "$0"; exit 0 ;;
        *) fatal "Unknown option: $1" ;;
    esac
done

section "Preflight"
[ "$(id -u)" -eq 0 ] || fatal "build.sh must be run as root (sudo)"
if ! "$SCRIPT_DIR/preflight.sh"; then
    err "Preflight failed — see output above"
    exit 1
fi
log "Preflight passed"

START_TIME=$SECONDS

# ── Pre-build cleanup ───────────────────────────────────────────────────────
section "Pre-build cleanup"
RSDK_OUT_DIR="$RSDK_DIR/out/radxa-dragon-q6a_noble_cli"
if [ -f "$RSDK_OUT_DIR/output.img" ]; then
    STALE_SIZE=$(du -h "$RSDK_OUT_DIR/output.img" | cut -f1)
    rm -f "$RSDK_OUT_DIR/output.img"
    log "Removed stale output.img ($STALE_SIZE)"
fi
if ls -d /tmp/mmdebstrap.* 1>/dev/null 2>&1; then
    # Killed / interrupted mmdebstrap leaves chroots with /proc and friends
    # still bind-mounted. `rm -rf` then fails with "Read-only file system" on
    # /proc files because /proc is a kernel-virtual fs you can't delete from.
    # Unmount in reverse depth order (deepest first) before removing.
    for orphan in /tmp/mmdebstrap.*; do
        [ -d "$orphan" ] || continue
        # Match the orphan dir as a mount-point prefix (^orphan/ or ^orphan$).
        # awk '$3 ~ "^"o"(/|$)"' picks every nested mount under the orphan.
        # `sort -r` ensures the deepest mounts unmount first.
        # `umount -l` (lazy) handles "device busy" cases so we never get stuck.
        mount | awk -v o="$orphan" '$3 ~ "^"o"(/|$)" {print $3}' | sort -r | \
            xargs -r umount -l 2>/dev/null || true
    done
    rm -rf /tmp/mmdebstrap.*
    log "Removed orphaned mmdebstrap temp dirs (auto-unmounted /proc + binds first)"
fi
if [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
    log "Removed prior staging dir $STAGING_DIR"
fi

# ── Stage files for the build ───────────────────────────────────────────────
section "Staging files for rsdk hooks"

mkdir -p "$STAGING_DIR/files"
mkdir -p "$STAGING_DIR/branding"
mkdir -p "$STAGING_DIR/electron-app"

# Image-local files (systemd, scripts, plymouth, gnome theme, audio config,
# apt pins, ssh, motd, profile, modprobe, sysctl, launcher, icons)
log "Staging image-local files into $STAGING_DIR/files"
rsync -a "$SCRIPT_DIR/files/" "$STAGING_DIR/files/"

# Branding assets (wallpapers + logo SVG)
log "Staging branding assets"
install -m 644 "$BRANDING_DIR/wallpaper-light.png" "$STAGING_DIR/branding/wallpaper-light.png"
install -m 644 "$BRANDING_DIR/wallpaper-dark.png"  "$STAGING_DIR/branding/wallpaper-dark.png"
install -m 644 "$BRANDING_DIR/playbill-logo.svg"   "$STAGING_DIR/branding/playbill-logo.svg"

# Icon set (already rasterized in app/packaging/icons/)
log "Staging icon set"
mkdir -p "$STAGING_DIR/files/icons"
cp -a "$ICONS_DIR/." "$STAGING_DIR/files/icons/"

# Unpacked Electron app
log "Staging unpacked Electron app from $ELECTRON_APP_DIR"
APP_SRC_SIZE=$(du -sh "$ELECTRON_APP_DIR" | cut -f1)
cp -a "$ELECTRON_APP_DIR/." "$STAGING_DIR/electron-app/"
log "  staged $APP_SRC_SIZE Electron app"

# ── Compile device-tree overlays ────────────────────────────────────────────
log "Compiling device-tree overlays"
mkdir -p "$STAGING_DIR/files/dtbo"
for dts in "$SCRIPT_DIR/overlays/"*.dts; do
    [ -f "$dts" ] || continue
    base=$(basename "$dts" .dts)
    out="$STAGING_DIR/files/dtbo/${base}.dtbo"
    if ! dtc -@ -q -I dts -O dtb -o "$out" "$dts"; then
        fatal "dtc failed to compile $dts"
    fi
    log "  compiled ${base}.dtbo"
done

# ── Build patched embloader.efi ─────────────────────────────────────────────
log "Building patched embloader.efi (cached on patch+commit hash)"
if ! "$SCRIPT_DIR/embloader/build-embloader.sh"; then
    fatal "embloader build failed — see output above"
fi
mkdir -p "$STAGING_DIR/files/embloader"
install -m 644 "$SCRIPT_DIR/embloader/output/embloader.efi" \
    "$STAGING_DIR/files/embloader/embloader.efi"
install -m 644 "$SCRIPT_DIR/embloader/output/embloader.efi.sha256" \
    "$STAGING_DIR/files/embloader/embloader.efi.sha256"

STAGE_SIZE=$(du -sh "$STAGING_DIR" | cut -f1)
log "Staged $STAGE_SIZE total"

export PLAYBILL_STAGING="$STAGING_DIR"
export PLAYBILL_VERSION="$PLAYBILL_VERSION"

# ── Run rsdk-build ──────────────────────────────────────────────────────────
section "Building rootfs and image (rsdk)"

log "Product:    radxa-dragon-q6a"
log "Suite:      noble (Ubuntu 24.04)"
log "Edition:    cli (rsdk variant; we layer GNOME on top)"
log "Sector:     ${SECTOR_SIZE}"
log "Version:    ${PLAYBILL_VERSION}"
log ""
log "First builds take 30-60 minutes (most of the time is downloading and"
log "configuring the Ubuntu desktop stack under qemu-arm64 emulation)."
log "Hook 26 is the fail-fast checkpoint — watch for its output."
log ""

cd "$RSDK_DIR"
rm -f "$RSDK_OUT_DIR/build-image"
rm -f "$RSDK_OUT_DIR/rootfs.tar"

if ! "$RSDK_DIR/src/libexec/rsdk/rsdk-build" \
        $DEBUG_FLAG \
        --sector-size "$SECTOR_SIZE" \
        radxa-dragon-q6a \
        noble \
        cli; then
    err "rsdk-build failed — see output above for the failing hook"
    exit 1
fi

# ── Post-build: move output ─────────────────────────────────────────────────
section "Post-build"

RSDK_OUT="${RSDK_DIR}/out/radxa-dragon-q6a_noble_cli/output.img"
if [ ! -f "$RSDK_OUT" ]; then
    fatal "rsdk reported success but $RSDK_OUT does not exist"
fi

mkdir -p "$OUTPUT_DIR"
FINAL_IMG="${OUTPUT_DIR}/trailcurrent-playbill-q6a-v${PLAYBILL_VERSION}.img"
cp --reflink=auto "$RSDK_OUT" "$FINAL_IMG"

IMG_SIZE=$(du -h "$FINAL_IMG" | cut -f1)
SHA=$(sha256sum "$FINAL_IMG" | cut -d' ' -f1)
rm -rf "$STAGING_DIR"

ELAPSED=$((SECONDS - START_TIME))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Build complete in ${ELAPSED_MIN}m ${ELAPSED_SEC}s${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Image:   $FINAL_IMG"
echo "  Size:    $IMG_SIZE"
echo "  SHA256:  $SHA"
echo ""
echo "  Next steps:"
echo "    1. Put board in EDL mode (hold EDL button while powering on)"
echo "    2. Verify: lsusb | grep 9008"
echo "    3. Flash SPI NOR firmware (one-time per board):"
echo "         sudo ./image/flash.sh --firmware"
echo "    4. Flash OS image to NVMe:"
echo "         sudo ./image/flash.sh --os $FINAL_IMG"
echo "    5. Power on. Plymouth → GDM (~30s) → log in as trailcurrent"
echo "       (default password trailcurrent — forced change on first login)"
echo "    6. Configure WiFi via the GNOME network indicator"
echo "    7. Click TrailCurrent Playbill in the dock to launch"
echo ""
