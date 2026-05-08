#!/usr/bin/env bash
# ============================================================================
# Build a patched embloader.efi for the Playbill Q6A image.
#
# Why this exists
# ---------------
# Radxa's `sdboot-is-embloader` package replaces /EFI/systemd/systemd-bootaa64
# .efi (and /EFI/BOOT/BOOTAA64.EFI) with a fork of systemd-boot called
# `embloader`. Embloader's text-menu code in
# embloader/src/menu/menus/text_menu.c always pumps gST->ConIn during the
# autoboot timeout window, even when the timeout is 0. On the Q6A's 40-pin
# header, debug-UART RX (gpio23 / pin 10) floats, and EMI from any installed
# HAT couples enough noise into that pin for the SoC's UART block to decode
# phantom serial bytes. Those phantom bytes preempt autoboot — the user is
# trapped at the menu requiring keyboard intervention every boot.
#
# The patch in patches/0001-... short-circuits the menu when timeout==0,
# autobooting the default loader without touching ConIn. We rebuild
# embloader from upstream tag 0.4 (the same commit Radxa ships) with our
# patch applied, and stage the resulting embloader.efi for the rsdk hooks
# to install over Radxa's stock binary on the ESP.
#
# Caching
# -------
# EDK2 is huge. We cache the working tree under
# RADXAQ6A/image/cache/embloader-build/ so re-runs only re-link, not
# re-clone or re-build basetools. Cache invalidation is keyed on the
# SHA256 of the patch file + EMBLOADER_COMMIT — change either and we
# rebuild from scratch.
#
# Outputs
# -------
# $OUT_DIR/embloader.efi   — the patched binary (~1.5 MB)
# $OUT_DIR/embloader.efi.sha256
#
# Usage
# -----
# Called from build.sh before the rsdk-build phase. Can be run standalone
# for development:
#   sudo ./RADXAQ6A/image/embloader/build-embloader.sh
# (sudo is NOT actually required; left for symmetry with build.sh.)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RADXA_IMG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCH_DIR="$SCRIPT_DIR/patches"
CACHE_DIR="${EMBLOADER_CACHE_DIR:-$RADXA_IMG_DIR/cache/embloader-build}"
OUT_DIR="${EMBLOADER_OUT_DIR:-$SCRIPT_DIR/output}"

# Pinned to upstream tag 0.4 — the exact commit Radxa's sdboot-is-embloader
# package builds from. Bumping requires re-validating the patch hunk.
EMBLOADER_REPO="https://github.com/BigfootACA/embloader.git"
EMBLOADER_COMMIT="9f8e74bd0c44384ad0f02f49e209a9835034c670"  # tag 0.4

GREEN='\033[38;5;70m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
log()    { echo -e "${GREEN}[embloader]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[embloader]${RESET} $*"; }
err()    { echo -e "${RED}[embloader]${RESET} $*" >&2; }
fatal()  { err "$*"; exit 1; }

# ── Tool prerequisites ──────────────────────────────────────────────────────
# Required set matches embloader's upstream README.md (gcc g++ git make
# nasm python3 uuid-dev). pkg-config and iasl are needed by EDK2's
# BaseTools build under most distros but the embloader README omits them;
# preflight.sh checks for them too.
need() { command -v "$1" >/dev/null 2>&1 || fatal "missing tool: $1 (apt: $2)"; }
need git           git
need make          make
need gcc           gcc
need g++           g++
need nasm          nasm
need python3       python3
need pkg-config    pkg-config
# AArch64 cross-compiler — EDK2's GCC5 toolchain shells out to the
# aarch64-linux-gnu-* triple. Without it the build invokes the host gcc
# with `-mlittle-endian` and fails with "unrecognized command-line option".
need aarch64-linux-gnu-gcc gcc-aarch64-linux-gnu
[ -e /usr/include/uuid/uuid.h ] || fatal "missing header: uuid/uuid.h (apt: uuid-dev)"
# iasl: warn but don't fail. Some EDK2 builds need it for ACPI table
# compilation; embloader's .dsc doesn't currently pull in ACPI sources,
# but if a future upstream version does, the build will fail loudly with
# "iasl: command not found" — install acpica-tools and re-run.
command -v iasl >/dev/null 2>&1 || warn "iasl missing — install acpica-tools if EDK2 build complains about ACPI"

# ── Cache key ───────────────────────────────────────────────────────────────
PATCH_HASHES=""
for p in "$PATCH_DIR"/*.patch; do
    [ -f "$p" ] || continue
    PATCH_HASHES="$PATCH_HASHES $(sha256sum "$p" | cut -d' ' -f1)"
done
CACHE_KEY=$(printf '%s\n%s\n' "$EMBLOADER_COMMIT" "$PATCH_HASHES" | sha256sum | cut -d' ' -f1)
log "cache key: $CACHE_KEY"

mkdir -p "$CACHE_DIR" "$OUT_DIR"

CACHED_KEY_FILE="$OUT_DIR/.cache-key"
if [ -f "$CACHED_KEY_FILE" ] && [ -f "$OUT_DIR/embloader.efi" ] \
   && [ "$(cat "$CACHED_KEY_FILE")" = "$CACHE_KEY" ]; then
    log "cache hit — using existing $OUT_DIR/embloader.efi"
    log "  sha256: $(sha256sum "$OUT_DIR/embloader.efi" | cut -d' ' -f1)"
    exit 0
fi
log "cache miss — building from source"

# ── Clone / update the embloader source tree ────────────────────────────────
SRC_DIR="$CACHE_DIR/embloader"
if [ ! -d "$SRC_DIR/.git" ]; then
    log "cloning $EMBLOADER_REPO"
    git clone --quiet "$EMBLOADER_REPO" "$SRC_DIR"
fi
cd "$SRC_DIR"
git fetch --quiet origin
log "checking out $EMBLOADER_COMMIT"
git reset --quiet --hard "$EMBLOADER_COMMIT"
git clean -qfdx -e build/  # preserve build/ for incremental EDK2 builds

# ── Apply patches ───────────────────────────────────────────────────────────
for p in "$PATCH_DIR"/*.patch; do
    [ -f "$p" ] || continue
    log "applying $(basename "$p")"
    git apply --whitespace=nowarn "$p"
done

# Verify the patch's intended marker is now in the source — fails loudly if
# the patch silently no-op'd against a different upstream version.
if ! grep -q "PLAYBILL PATCH" embloader/src/menu/menus/text_menu.c; then
    fatal "patch did not insert PLAYBILL marker — upstream may have changed"
fi

# ── Pull EDK2 submodule (depth 1 — saves gigabytes) ─────────────────────────
log "initializing EDK2 submodule (this is large; ~5 min on first run)"
git submodule update --init --recursive --depth 1

# ── Build ───────────────────────────────────────────────────────────────────
log "building basetools"
export EDK2_PATH="$SRC_DIR/edk2"
export EDK_TOOLS_PATH="$EDK2_PATH/BaseTools"
# EDK2's GCC5 AArch64 toolchain template references ENV(GCC5_AARCH64_PREFIX).
# Without this export, build.py invokes plain `gcc` which fails on
# `-mlittle-endian`. Set both names because some EDK2 forks expect the
# version-stripped GCC_AARCH64_PREFIX.
export GCC5_AARCH64_PREFIX=aarch64-linux-gnu-
export GCC_AARCH64_PREFIX=aarch64-linux-gnu-
make -j "$(nproc)" basetools

log "building embloader.efi (aarch64 / RELEASE)"
export ARCH=aarch64
make -j "$(nproc)" build-edk2

# ── Locate output ───────────────────────────────────────────────────────────
BUILT="$SRC_DIR/build/Build/embloader/RELEASE_GCC5/AARCH64/embloader.efi"
[ -f "$BUILT" ] || fatal "build succeeded but $BUILT does not exist"
SIZE=$(stat -c%s "$BUILT")
log "built embloader.efi: $SIZE bytes"

# ── Stage to OUT_DIR ────────────────────────────────────────────────────────
install -m 644 "$BUILT" "$OUT_DIR/embloader.efi"
sha256sum "$OUT_DIR/embloader.efi" > "$OUT_DIR/embloader.efi.sha256"
echo "$CACHE_KEY" > "$CACHED_KEY_FILE"

log "done"
log "  output: $OUT_DIR/embloader.efi"
log "  sha256: $(cut -d' ' -f1 "$OUT_DIR/embloader.efi.sha256")"
log "  cache:  $CACHED_KEY_FILE"
