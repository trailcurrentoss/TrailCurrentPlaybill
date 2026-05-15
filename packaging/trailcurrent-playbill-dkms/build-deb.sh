#!/bin/bash
# Build trailcurrent-playbill-dkms_<version>_all.deb from src/.
#
# Output: $REPO_ROOT/packaging/trailcurrent-playbill-dkms/dist/trailcurrent-playbill-dkms_<version>_all.deb
#
# The resulting deb installs kernel-module source under
# /usr/src/trailcurrent-playbill-dkms-<version>/ and runs `dkms install`
# in the postinst against every installed kernel that has matching
# headers. DKMS handles auto-rebuild on kernel upgrades via its own
# kernel-postinst hook (no glue needed from us).
#
# This script is invoked by image/build.sh during a fresh image build
# AND can be run standalone to ship updates outside the image (apt-get
# install ./newer.deb, or via a private apt repo / Headwaters OTA).
#
# Usage:
#   ./build-deb.sh                  # uses VERSION from src/dkms.conf
#   ./build-deb.sh 1.0.1            # override version
#   VERSION=1.0.1 ./build-deb.sh    # same, via env var

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
DIST_DIR="$SCRIPT_DIR/dist"

PKG_NAME="trailcurrent-playbill-dkms"
# Version precedence: $1 arg > $VERSION env > dkms.conf
if [[ -n "${1:-}" ]]; then
    PKG_VERSION="$1"
elif [[ -n "${VERSION:-}" ]]; then
    PKG_VERSION="$VERSION"
else
    PKG_VERSION="$(awk -F'"' '/^PACKAGE_VERSION=/ {print $2}' "$SRC_DIR/dkms.conf")"
fi
[[ -n "$PKG_VERSION" ]] || { echo "couldn't determine version" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

INSTALL_DIR="usr/src/${PKG_NAME}-${PKG_VERSION}"
mkdir -p "$STAGE/$INSTALL_DIR" "$STAGE/DEBIAN"

# Copy the kernel-module source tree as the deb payload. We use cp -a
# so timestamps and modes are preserved (DKMS doesn't care, but it
# keeps file equality stable across rebuilds for reproducibility).
cp -a "$SRC_DIR/." "$STAGE/$INSTALL_DIR/"

# If the script was run with a non-conf version, the on-disk dkms.conf
# still has the old version string. Patch it in the staging tree so
# DKMS reads the correct version on install.
sed -i "s/^PACKAGE_VERSION=.*/PACKAGE_VERSION=\"${PKG_VERSION}\"/" \
    "$STAGE/$INSTALL_DIR/dkms.conf"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Section: kernel
Priority: optional
Architecture: all
Maintainer: TrailCurrent <trailcurrentopensource@gmail.com>
Depends: dkms (>= 2.1.0.0), linux-headers-generic | linux-headers-radxa-dragon-q6a | linux-headers-amd64 | linux-headers
Conflicts: playbill-dvb-dkms
Replaces: playbill-dvb-dkms
Provides: playbill-dvb-dkms
Description: USB-DVB drivers for the Hauppauge WinTV-dualHD 01595 on the Q6A
 The Radxa Q6A kernel (linux-image-*-qcom) ships dvb-core but no USB-DVB
 bridge drivers. This DKMS package supplies the specific drivers needed
 for the Hauppauge WinTV-dualHD model 01595 (USB ID 2040:826d):
 .
   * em28xx        - Empia EM28174 USB-to-anything bridge
   * em28xx-dvb    - DVB extension exposing /dev/dvb/adapterN
   * lgdt3306a     - LG LGDT3306A ATSC/QAM-B demodulator
   * si2157        - Silicon Labs Si2157 RF tuner
   * tveeprom      - Hauppauge EEPROM parser
 .
 Source is upstream Linux 6.18.2 (kernel.org), built out-of-tree against
 the installed kernel headers. DKMS rebuilds against every new kernel
 automatically. Pulled in transparently by the main trailcurrent-playbill
 package.
EOF

# postinst: register source with DKMS, build + install against each
# installed kernel that has matching headers.
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e

PACKAGE_NAME="trailcurrent-playbill-dkms"
PACKAGE_VERSION="__PKG_VERSION__"

case "$1" in
    configure)
        if ! dkms status -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION" 2>/dev/null \
                | grep -q "$PACKAGE_NAME"; then
            dkms add -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION"
        fi
        for KVER in $(ls /lib/modules); do
            if [ -d "/lib/modules/$KVER/build" ]; then
                if dkms status -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION" -k "$KVER" 2>/dev/null \
                        | grep -q "installed"; then
                    continue
                fi
                echo "$PACKAGE_NAME: building for kernel $KVER"
                if ! dkms install -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION" -k "$KVER"; then
                    echo "$PACKAGE_NAME: build failed for $KVER (continuing)" >&2
                fi
            fi
        done
        depmod -a 2>/dev/null || true
        ;;
    abort-upgrade|abort-remove|abort-deconfigure) ;;
    *) echo "postinst called with unknown argument \`$1'" >&2; exit 1;;
esac
exit 0
EOF
sed -i "s/__PKG_VERSION__/${PKG_VERSION}/g" "$STAGE/DEBIAN/postinst"
chmod 0755 "$STAGE/DEBIAN/postinst"

# prerm: drop modules + source from the DKMS tree before apt deletes
# the source dir.
cat > "$STAGE/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e

PACKAGE_NAME="trailcurrent-playbill-dkms"
PACKAGE_VERSION="__PKG_VERSION__"

case "$1" in
    remove|upgrade|deconfigure)
        if dkms status -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION" 2>/dev/null \
                | grep -q "$PACKAGE_NAME"; then
            dkms remove -m "$PACKAGE_NAME" -v "$PACKAGE_VERSION" --all || true
        fi
        depmod -a 2>/dev/null || true
        ;;
    failed-upgrade) ;;
    *) echo "prerm called with unknown argument \`$1'" >&2; exit 1;;
esac
exit 0
EOF
sed -i "s/__PKG_VERSION__/${PKG_VERSION}/g" "$STAGE/DEBIAN/prerm"
chmod 0755 "$STAGE/DEBIAN/prerm"

mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_all.deb"
dpkg-deb --root-owner-group -b "$STAGE" "$OUT"
echo "built: $OUT"
echo "size:  $(du -h "$OUT" | cut -f1)"
