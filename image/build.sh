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
install -m 644 "$BRANDING_DIR/wallpaper-light.png"        "$STAGING_DIR/branding/wallpaper-light.png"
install -m 644 "$BRANDING_DIR/wallpaper-dark.png"         "$STAGING_DIR/branding/wallpaper-dark.png"
install -m 644 "$BRANDING_DIR/playbill-logo.svg"          "$STAGING_DIR/branding/playbill-logo.svg"
# TrailCurrent corporate wordmark — used as the GDM login-screen logo and
# anywhere else we want a small horizontal wordmark instead of the square
# product icon. Sourced from /Marketing/ClaudWebSite/.../trailcurrent-logo-white.svg
# (the version used on the marketing site dark header).
install -m 644 "$BRANDING_DIR/trailcurrent-wordmark.svg"  "$STAGING_DIR/branding/trailcurrent-wordmark.svg"
install -m 644 "$BRANDING_DIR/trailcurrent-wordmark.png"  "$STAGING_DIR/branding/trailcurrent-wordmark.png"

# Icon set (already rasterized in app/packaging/icons/)
log "Staging icon set"
mkdir -p "$STAGING_DIR/files/icons"
cp -a "$ICONS_DIR/." "$STAGING_DIR/files/icons/"

# ── Build the trailcurrent-playbill + trailcurrent-playbill-dkms debs ──
#
# Migrated from raw file-copy to proper Debian packaging (2026-05-15) so
# the same artifacts can ship via image build, manual scp+dpkg, or a
# private apt repo / Headwaters-Farwatch OTA. trailcurrent-playbill
# Depends: trailcurrent-playbill-dkms — kernel modules tag along
# transparently. Same pattern as nvidia-driver / virtualbox / zfs-linux.
#
# Both build-deb.sh scripts handle their own dependency installation
# and produce reproducible `.deb` files under
# packaging/<pkg>/dist/. We rebuild every image build (cheap when the
# sources haven't changed thanks to npm/electron-builder caching).
log "Building trailcurrent-playbill-dkms deb"
( bash "$REPO_ROOT/packaging/trailcurrent-playbill-dkms/build-deb.sh" 2>&1 | tail -5 ) \
    || fatal "trailcurrent-playbill-dkms build failed"

log "Building trailcurrent-playbill deb (includes Electron app + controller)"
# PLAYBILL_IMAGE_BUILD=1 forces build-tools/embed-yt-credentials.js to
# emit an EMPTY default-client.local.js, even if the developer's .env is
# sitting in the repo root. Without this gate the dev's personal OAuth
# client gets baked into every shipped image and every end-user's API
# calls burn the dev's quota. Each end-user creates their own OAuth
# client per docs/youtube-setup.md and pastes it into the Headwaters PWA.
rm -f "$REPO_ROOT/controller/src/sources/youtube/default-client.local.js"
( PLAYBILL_IMAGE_BUILD=1 bash "$REPO_ROOT/packaging/trailcurrent-playbill/build-deb.sh" 2>&1 | tail -10 ) \
    || fatal "trailcurrent-playbill build failed"

# Stage both debs into $STAGING/files/debs/ for the chroot install hook.
mkdir -p "$STAGING_DIR/files/debs"
PLAYBILL_DEB=$(ls "$REPO_ROOT/packaging/trailcurrent-playbill/dist/"*.deb 2>/dev/null | head -1)
DKMS_DEB=$(ls "$REPO_ROOT/packaging/trailcurrent-playbill-dkms/dist/"*.deb 2>/dev/null | head -1)
[ -f "$PLAYBILL_DEB" ] || fatal "no trailcurrent-playbill deb produced"
[ -f "$DKMS_DEB" ]     || fatal "no trailcurrent-playbill-dkms deb produced"
install -m 644 "$DKMS_DEB"     "$STAGING_DIR/files/debs/$(basename "$DKMS_DEB")"
install -m 644 "$PLAYBILL_DEB" "$STAGING_DIR/files/debs/$(basename "$PLAYBILL_DEB")"
log "  staged $(basename "$DKMS_DEB") ($(du -h "$DKMS_DEB" | cut -f1))"
log "  staged $(basename "$PLAYBILL_DEB") ($(du -h "$PLAYBILL_DEB" | cut -f1))"

# playbill-audio-fix.service: still managed via image hook 6 (this unit
# is image-board-quirk-specific, not part of the userspace package —
# kicks wireplumber once at session start to work around the Q6A audio
# attach race). Hook 6 stages it the way it always has.
mkdir -p "$STAGING_DIR/files/systemd-user"
install -m 644 "$REPO_ROOT/image/files/systemd-user/playbill-audio-fix.service" \
    "$STAGING_DIR/files/systemd-user/playbill-audio-fix.service"

# ── Fetch the latest yt-dlp release ───────────────────────────────────────
# The apt-shipped yt-dlp lags YouTube's extractor changes by months, which
# breaks the bestvideo+bestaudio adaptive-format selector. Bake a fresh
# binary at image-build time so flashed devices aren't immediately stale.
# Hook 5a copies it to /usr/local/bin/yt-dlp (PATH-shadows /usr/bin/yt-dlp).
#
# Cache: keep the downloaded blob in image/cache/ so dev rebuilds don't
# hammer GitHub. Re-fetch if the cached copy is older than 7 days, OR if
# CI/the user explicitly asks via REFRESH_YTDLP=1.
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
YTDLP_CACHE="$CACHE_DIR/yt-dlp"
mkdir -p "$CACHE_DIR"
NEED_FETCH=0
if [ ! -f "$YTDLP_CACHE" ]; then
    NEED_FETCH=1
elif [ -n "${REFRESH_YTDLP:-}" ]; then
    NEED_FETCH=1
elif find "$YTDLP_CACHE" -mtime +7 2>/dev/null | grep -q .; then
    NEED_FETCH=1
fi
if [ "$NEED_FETCH" = 1 ]; then
    log "Fetching latest yt-dlp release from GitHub"
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "$YTDLP_CACHE.tmp" "$YTDLP_URL"; then
        fatal "failed to fetch yt-dlp from $YTDLP_URL"
    fi
    chmod +x "$YTDLP_CACHE.tmp"
    # Smoke-test the binary with --version so we fail fast if GitHub served
    # garbage (rate-limit HTML, etc.) instead of the actual binary.
    if ! "$YTDLP_CACHE.tmp" --version >/dev/null 2>&1; then
        rm -f "$YTDLP_CACHE.tmp"
        fatal "downloaded yt-dlp doesn't run; check $YTDLP_URL is serving the binary"
    fi
    mv "$YTDLP_CACHE.tmp" "$YTDLP_CACHE"
    log "  cached $(du -h "$YTDLP_CACHE" | cut -f1) yt-dlp $("$YTDLP_CACHE" --version)"
else
    log "Using cached yt-dlp $("$YTDLP_CACHE" --version) (set REFRESH_YTDLP=1 to force re-download)"
fi
mkdir -p "$STAGING_DIR/files/yt-dlp"
install -m 755 "$YTDLP_CACHE" "$STAGING_DIR/files/yt-dlp/yt-dlp"

# ── Fetch DVB tuner firmware (Si2168 / Si2158) — VESTIGIAL FOR THE 01595 ──
# CURRENT STATUS (2026-05-15): the supported tuner is the Hauppauge
# WinTV-dualHD model 01595 (USB 2040:826d). That model uses LGDT3306A demod
# + Si2157 RF tuner. NEITHER chip loads firmware from /lib/firmware (their
# config is register-table-based inside the kernel module). The blobs
# fetched and staged below are NOT loaded by any module this image installs.
#
# They remain on disk as forward-compatible ammunition: if Playbill ever
# extends `playbill-dvb-dkms` to build si2168.ko / si2158.ko for an
# international DVB-T2/C variant of the dualHD, the firmware path is
# already staged for the kernel firmware loader to find on hot-plug. Until
# then this section is a ~50 KB no-op.
#
# Earlier revisions of this comment said the dualHD needs these blobs —
# that was wrong. Ubuntu Noble's linux-firmware is still missing them
# (`dpkg -L linux-firmware | grep si21` returns nothing), so we keep the
# fetch wired up against the future need; we just don't have a module that
# requests them on this image.
#
# Source: OpenELEC/dvb-firmware on GitHub (the canonical mirror of the
# extracted firmware blobs used by every Linux DVB stack distribution). Hook
# 13b stages these into /lib/firmware/.
DVB_FW_FILES="dvb-demod-si2168-02.fw dvb-demod-si2168-a20-01.fw dvb-demod-si2168-a30-01.fw dvb-demod-si2168-b40-01.fw dvb-tuner-si2158-a20-01.fw"
DVB_FW_BASE="https://github.com/OpenELEC/dvb-firmware/raw/master/firmware"
DVB_FW_CACHE="$CACHE_DIR/dvb-firmware"
mkdir -p "$DVB_FW_CACHE"
for fw in $DVB_FW_FILES; do
    if [ ! -s "$DVB_FW_CACHE/$fw" ] || [ -n "${REFRESH_DVB_FW:-}" ]; then
        log "Fetching DVB firmware $fw"
        if ! curl -fsSL --retry 3 --retry-delay 2 -o "$DVB_FW_CACHE/$fw.tmp" "$DVB_FW_BASE/$fw"; then
            fatal "failed to fetch DVB firmware $fw from $DVB_FW_BASE/$fw"
        fi
        # Smoke-check: these are tiny (2-19 KB) binary blobs. If we got back
        # an HTML 404 page (~1 KB of HTML), refuse to stage it.
        if head -c 4 "$DVB_FW_CACHE/$fw.tmp" | grep -q "<htm\|<!DO"; then
            rm -f "$DVB_FW_CACHE/$fw.tmp"
            fatal "DVB firmware $fw download returned HTML — wrong URL?"
        fi
        mv "$DVB_FW_CACHE/$fw.tmp" "$DVB_FW_CACHE/$fw"
    fi
done
mkdir -p "$STAGING_DIR/files/dvb-firmware"
for fw in $DVB_FW_FILES; do
    install -m 644 "$DVB_FW_CACHE/$fw" "$STAGING_DIR/files/dvb-firmware/$fw"
done

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
echo "       (default password trailcurrent — change via Settings → Users after login)"
echo "    6. Configure WiFi via the GNOME network indicator"
echo "    7. Click TrailCurrent Playbill in the dock to launch"
echo ""
