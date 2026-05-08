#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Playbill — Q6A build host preflight
#
# Verifies the build host has everything needed for build.sh, and that the
# Electron app and branding assets are staged. Idempotent — safe to re-run.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RSDK_DIR="${SCRIPT_DIR}/rsdk"
KEYRINGS_DIR="${RSDK_DIR}/externals/keyrings"

ELECTRON_APP_DIR="${REPO_ROOT}/app/dist/linux-arm64-unpacked"
BRANDING_DIR="${REPO_ROOT}/branding"

GREEN='\033[38;5;70m'
TEAL='\033[38;5;30m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}\xE2\x9C\x93${RESET} $*"; }
fail() { echo -e "  ${RED}\xE2\x9C\x97${RESET} $*"; ERRORS=$((ERRORS+1)); }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
step() { echo ""; echo -e "${BOLD}${TEAL}── ${1} ──${RESET}"; }

ERRORS=0

echo ""
echo -e "${BOLD}${GREEN}Trail${TEAL}Current${RESET} ${BOLD}Playbill — Q6A Build Host Preflight${RESET}"
echo ""

# ── 1. APT build dependencies ───────────────────────────────────────────────
step "1. Build host tooling"

REQUIRED_TOOLS=(jsonnet mmdebstrap guestfish qemu-aarch64-static sgdisk parted git curl gpg dtc rsync unzip nasm iasl pkg-config aarch64-linux-gnu-gcc)
for tool in "${REQUIRED_TOOLS[@]}"; do
    if command -v "$tool" >/dev/null 2>&1; then
        ok "$tool"
    else
        fail "$tool — missing"
    fi
done

# ── 2. rsdk keyrings ────────────────────────────────────────────────────────
step "2. rsdk keyrings"
if [ -d "$KEYRINGS_DIR" ] && [ "$(ls -A "$KEYRINGS_DIR" 2>/dev/null)" ]; then
    ok "keyrings present at $KEYRINGS_DIR"
else
    if [ -f "$RSDK_DIR/.gitmodules" ]; then
        warn "keyrings missing — initialising rsdk submodules (one-time)"
        if (cd "$RSDK_DIR" && git submodule update --init --recursive 2>&1); then
            ok "submodules initialised"
        else
            fail "git submodule init failed"
        fi
    else
        fail "no .gitmodules in rsdk dir"
    fi
fi

# ── 3. Electron app build artifact ──────────────────────────────────────────
step "3. Electron app (unpacked arm64 dir)"
if [ -d "$ELECTRON_APP_DIR" ] && [ -x "$ELECTRON_APP_DIR/trailcurrent-playbill" ]; then
    APP_SIZE=$(du -sh "$ELECTRON_APP_DIR" | cut -f1)
    ok "$ELECTRON_APP_DIR ($APP_SIZE)"
else
    fail "$ELECTRON_APP_DIR/trailcurrent-playbill missing or not executable"
    warn "Run from app/: npm run dist"
fi

# ── 4. Branding assets ──────────────────────────────────────────────────────
step "4. Branding assets"
for asset in wallpaper-light.png wallpaper-dark.png playbill-logo.svg; do
    if [ -f "$BRANDING_DIR/$asset" ]; then
        ok "$asset"
    else
        fail "$asset missing"
    fi
done

# ── 5. Icon set rasterized ──────────────────────────────────────────────────
step "5. Playbill icon set"
ICON_DIR="${REPO_ROOT}/app/packaging/icons"
for size in 16 24 32 48 64 128 256 512; do
    if [ -f "$ICON_DIR/${size}x${size}.png" ]; then
        ok "${size}x${size}.png"
    else
        fail "${size}x${size}.png missing"
    fi
done

# ── 6. Disk space ───────────────────────────────────────────────────────────
step "6. Free disk space (need ~30 GB free for the build)"
FREE_GB=$(df -BG --output=avail "$RSDK_DIR" | tail -1 | tr -dc '0-9')
if [ "${FREE_GB:-0}" -ge 30 ]; then
    ok "${FREE_GB} GB free at $RSDK_DIR"
else
    fail "only ${FREE_GB:-?} GB free at $RSDK_DIR — need >= 30 GB"
fi

echo ""
if [ "$ERRORS" -gt 0 ]; then
    echo -e "${BOLD}${RED}Preflight FAILED with $ERRORS errors${RESET}"
    exit 1
fi
echo -e "${BOLD}${GREEN}All preflight checks passed${RESET}"
echo ""
exit 0
