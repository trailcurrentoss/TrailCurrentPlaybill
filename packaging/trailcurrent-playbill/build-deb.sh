#!/bin/bash
# Build trailcurrent-playbill_<version>_arm64.deb.
#
# This is the user-facing Playbill package. It bundles:
#   * The Electron app at /opt/trailcurrent-playbill/
#   * The Node.js controller daemon at /opt/trailcurrent-playbill/controller/
#   * The .desktop launcher at /usr/share/applications/
#   * Icon set at /usr/share/icons/hicolor/<size>/apps/
#   * The systemd user unit at /usr/lib/systemd/user/
#
# Depends: trailcurrent-playbill-dkms (>= 1.0.0)
#
# The kernel-module sibling deb (trailcurrent-playbill-dkms) is pulled in
# automatically by apt, so users only ever have to install or upgrade
# `trailcurrent-playbill`. DKMS handles auto-rebuilds of the kernel modules
# on kernel upgrades transparently. This matches the standard nvidia-driver
# / virtualbox / zfs-linux packaging pattern.
#
# Why we don't use electron-builder's built-in deb target:
#   electron-builder's deb pipeline goes through fpm and is opinionated
#   about layout. We need the Electron app at /opt/trailcurrent-playbill/
#   AND the controller daemon colocated AND the .desktop / icons /
#   systemd-unit at their freedesktop-spec paths. Doing all that through
#   electron-builder's `linux.fpm` flags + `extraFiles` is awkward. We
#   just let electron-builder produce its unpacked dir, then assemble
#   the deb ourselves with dpkg-deb — same approach as the DKMS package.
#
# Usage:
#   ./build-deb.sh                  # uses version from app/package.json
#   ./build-deb.sh 1.0.1            # override version
#   VERSION=1.0.1 ./build-deb.sh    # same, via env var

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
CONTROLLER_DIR="$REPO_ROOT/controller"
DIST_DIR="$SCRIPT_DIR/dist"

PKG_NAME="trailcurrent-playbill"
# Version precedence: $1 arg > $VERSION env > app/package.json
if [[ -n "${1:-}" ]]; then
    PKG_VERSION="$1"
elif [[ -n "${VERSION:-}" ]]; then
    PKG_VERSION="$VERSION"
else
    PKG_VERSION="$(node -p "require('$APP_DIR/package.json').version")"
fi
[[ -n "$PKG_VERSION" ]] || { echo "couldn't determine version" >&2; exit 1; }

# DKMS deb pin: the main app and its dkms sibling are versioned independently
# (kernel-side fixes can bump dkms without touching the app, and vice versa).
# We require AT LEAST 1.0.0 of the dkms package — bump this floor when a
# new app version genuinely needs newer kernel-side bits.
DKMS_MIN_VERSION="${DKMS_MIN_VERSION:-1.0.0}"

# ── 1. Build the Electron app (produces app/dist/linux-arm64-unpacked/) ──
# Note: electron-builder's "installing production dependencies" step prunes
# dev deps (babel etc) from app/node_modules. That breaks the NEXT call to
# `npm run build:renderer` until dev deps get reinstalled. So always run
# `npm install` first to restore them. Cheap when already-installed.
echo "==> ensuring app/ dev deps are installed (electron-builder prunes them)"
(cd "$APP_DIR" && npm install 2>&1 | tail -3)
echo "==> building Electron app via npm run dist"
(cd "$APP_DIR" && npm run dist 2>&1 | tail -5)
ELECTRON_OUT="$APP_DIR/dist/linux-arm64-unpacked"
[[ -d "$ELECTRON_OUT" ]] || { echo "electron-builder did not produce $ELECTRON_OUT" >&2; exit 1; }
[[ -x "$ELECTRON_OUT/trailcurrent-playbill" ]] || { echo "$ELECTRON_OUT/trailcurrent-playbill is not executable" >&2; exit 1; }

# ── 2. Ensure controller has its production deps ──
if [[ ! -d "$CONTROLLER_DIR/node_modules" ]]; then
    echo "==> installing controller production deps"
    (cd "$CONTROLLER_DIR" && npm install --omit=dev 2>&1 | tail -3)
fi

# ── 3. Stage the deb payload ──
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> staging payload at $STAGE"

# 3a. /opt/trailcurrent-playbill/ — the Electron app
APP_INSTALL="$STAGE/opt/$PKG_NAME"
mkdir -p "$APP_INSTALL"
cp -a "$ELECTRON_OUT/." "$APP_INSTALL/"

# 3b. /opt/trailcurrent-playbill/controller/ — the Node controller daemon
mkdir -p "$APP_INSTALL/controller"
rsync -a --exclude='.git' --exclude='*.log' --exclude='.env*' \
      "$CONTROLLER_DIR/" "$APP_INSTALL/controller/"

# 3c. /usr/share/applications/trailcurrent-playbill.desktop
mkdir -p "$STAGE/usr/share/applications"
install -m 644 "$REPO_ROOT/image/files/launcher/trailcurrent-playbill.desktop" \
    "$STAGE/usr/share/applications/trailcurrent-playbill.desktop"

# 3d. /usr/share/icons/hicolor/<size>/apps/trailcurrent-playbill.png
for size in 16 24 32 48 64 96 128 256 512; do
    src="$APP_DIR/packaging/icons/${size}x${size}.png"
    if [[ -f "$src" ]]; then
        dst_dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
        mkdir -p "$dst_dir"
        install -m 644 "$src" "$dst_dir/trailcurrent-playbill.png"
    fi
done
# Scalable SVG variant (preferred by GNOME's HiDPI icon lookup).
if [[ -f "$APP_DIR/packaging/icons/icon.svg" ]]; then
    mkdir -p "$STAGE/usr/share/icons/hicolor/scalable/apps"
    install -m 644 "$APP_DIR/packaging/icons/icon.svg" \
        "$STAGE/usr/share/icons/hicolor/scalable/apps/trailcurrent-playbill.svg"
fi

# 3e. /usr/lib/systemd/user/playbill-controller.service
mkdir -p "$STAGE/usr/lib/systemd/user"
install -m 644 "$CONTROLLER_DIR/systemd/playbill-controller.service" \
    "$STAGE/usr/lib/systemd/user/playbill-controller.service"

# ── 4. DEBIAN/ control files ──
mkdir -p "$STAGE/DEBIAN"

# Calculate installed-size (matches dpkg convention: KB rounded up).
INSTALLED_SIZE=$(du -sk "$STAGE/opt" "$STAGE/usr" 2>/dev/null | awk '{s+=$1} END {print s}')

cat > "$STAGE/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Section: video
Priority: optional
Architecture: arm64
Maintainer: TrailCurrent <trailcurrentopensource@gmail.com>
Installed-Size: ${INSTALLED_SIZE}
Depends: trailcurrent-playbill-dkms (>= ${DKMS_MIN_VERSION}), nodejs (>= 18), libcap2-bin, dvb-tools, dtv-scan-tables, mpv, rtl-sdr, libsox-fmt-all, sox, ffmpeg, lame, flac, libdvdread8, libdvdnav4, handbrake-cli, lsdvd, cd-discid, libcdio-utils
Recommends: handbrake
Description: TrailCurrent Playbill — in-rig entertainment center for the Q6A
 Playbill turns a TrailCurrent rig's Linux desktop into a 10-foot
 entertainment center. Live OTA TV, AM/FM/scanner radio via RTL-SDR, DVD
 and CD rip-to-library, YouTube + Cast (AirPlay) + Netflix, all driven
 by a kiosk-style Electron GUI plus a Node.js control daemon owning the
 hardware lifecycle (mpv, rtl_fm, dvbv5-zap, MQTT).
 .
 Includes the kernel-module sibling package (trailcurrent-playbill-dkms)
 as a dependency, so the USB-DVB driver stack required by Live TV gets
 pulled in and auto-rebuilt by DKMS on every kernel upgrade. Users only
 ever install or upgrade trailcurrent-playbill — the kernel piece is
 invisible.
EOF

# Conffiles: none right now; user-editable config lives in
# ~/.config/trailcurrent-playbill/, not under /etc.

# postinst — wires up freedesktop integration and the systemd user service.
cat > "$STAGE/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e

case "$1" in
    configure)
        # Refresh the freedesktop database (so the .desktop file appears
        # in app menus right away without a logout/login cycle).
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database -q /usr/share/applications 2>/dev/null || true
        fi
        if command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -q -f -t /usr/share/icons/hicolor 2>/dev/null || true
        fi
        # Enable the controller user service for every user that already
        # has a systemd user instance (i.e. globally-enable the unit).
        # `--global` is per-user-but-applies-to-all without needing each
        # user to be logged in.
        #
        # In a build chroot (mmdebstrap during image build) systemctl can
        # still create the filesystem symlink but sometimes silently no-
        # ops if it can't reach a running systemd. Belt-and-suspenders:
        # always also create the symlink ourselves under
        # /etc/systemd/user/default.target.wants/ (the canonical
        # admin-space location for apt-installed user units). systemd
        # accepts either /etc or /usr/lib path; /etc wins on read order
        # if both exist.
        SYMLINK_DIR="/etc/systemd/user/default.target.wants"
        mkdir -p "$SYMLINK_DIR"
        ln -sf /usr/lib/systemd/user/playbill-controller.service \
            "$SYMLINK_DIR/playbill-controller.service"
        if command -v systemctl >/dev/null 2>&1; then
            systemctl --global enable playbill-controller.service 2>/dev/null || true
            # daemon-reload only if systemd is actually running (avoids
            # "Failed to connect to bus" noise in chroot).
            [ -d /run/systemd/system ] && \
                systemctl daemon-reload 2>/dev/null || true
        fi
        # The controller binary needs cap_net_bind_service so the onboarding
        # claim listener can bind port 80 without root. Match the image
        # build's hook-5a setcap on the node binary.
        if [ -f /usr/bin/node ] && command -v setcap >/dev/null 2>&1; then
            setcap cap_net_bind_service=+ep /usr/bin/node 2>/dev/null || true
        fi
        ;;
    abort-upgrade|abort-remove|abort-deconfigure) ;;
    *)
        echo "postinst called with unknown argument \`$1'" >&2
        exit 1
        ;;
esac
exit 0
POSTINST
chmod 0755 "$STAGE/DEBIAN/postinst"

# prerm — disable the user service so it doesn't keep trying to restart
# against a half-removed install. Doesn't stop running instances (those
# stop on logout); it just prevents new starts.
cat > "$STAGE/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e

case "$1" in
    remove|deconfigure)
        if command -v systemctl >/dev/null 2>&1; then
            systemctl --global disable playbill-controller.service 2>/dev/null || true
        fi
        ;;
    upgrade|failed-upgrade) ;;
    *)
        echo "prerm called with unknown argument \`$1'" >&2
        exit 1
        ;;
esac
exit 0
PRERM
chmod 0755 "$STAGE/DEBIAN/prerm"

# postrm — refresh freedesktop databases after removal so menus update.
cat > "$STAGE/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e

case "$1" in
    purge|remove|upgrade|abort-install|disappear|abort-upgrade|failed-upgrade)
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database -q /usr/share/applications 2>/dev/null || true
        fi
        if command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -q -f -t /usr/share/icons/hicolor 2>/dev/null || true
        fi
        ;;
    *) ;;
esac
exit 0
POSTRM
chmod 0755 "$STAGE/DEBIAN/postrm"

# ── 5. dpkg-deb ──
mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_arm64.deb"
echo "==> building deb"
dpkg-deb --root-owner-group -b "$STAGE" "$OUT"
echo
echo "built: $OUT"
echo "size:  $(du -h "$OUT" | cut -f1)"
