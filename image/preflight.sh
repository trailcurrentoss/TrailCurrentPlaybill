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

REQUIRED_TOOLS=(jsonnet mmdebstrap guestfish sgdisk parted git curl gpg dtc rsync unzip nasm iasl pkg-config)

# qemu-aarch64-static is only needed when the build host's architecture
# does not match the target (arm64). On a native arm64 host (e.g.
# building Playbill ON the Q6A board), all binaries run directly and
# no user-mode emulation is needed.
HOST_ARCH=$(uname -m)
if [ "$HOST_ARCH" != "aarch64" ] && [ "$HOST_ARCH" != "arm64" ]; then
    REQUIRED_TOOLS+=(qemu-aarch64-static)
fi

# aarch64-linux-gnu-gcc is the cross-compiler used to build the
# embloader on x86 hosts. On an arm64 host the system's plain `gcc`
# already produces aarch64 binaries, so the cross-prefixed name isn't
# present (and isn't needed).
if [ "$HOST_ARCH" != "aarch64" ] && [ "$HOST_ARCH" != "arm64" ]; then
    REQUIRED_TOOLS+=(aarch64-linux-gnu-gcc)
else
    # Native arm64: ensure plain `gcc` exists and can produce aarch64.
    REQUIRED_TOOLS+=(gcc)
fi

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

# ── 7. Static apt package-name check ────────────────────────────────────────
# Catches typos, virtual/Provides-only names (e.g. `libdvdread8` vs the
# real `libdvdread8t64`), and packages that vanished from Noble's archive
# BEFORE we burn a 2-hour qemu build cycle on it. Uses the host's apt cache
# (host is Noble 24.04, same as the target for archive-side packages).
#
# Two lists are extracted from rootfs.jsonnet's hook 3a:
#   * install list — the `apt-get install -y --install-recommends \` block
#   * verify list  — the `for pkg in ...; do dpkg -s "$pkg" ...` loop
#
# Install-list rule: pkg must be installable (real or virtual-with-providers)
# Verify-list  rule: pkg must be a REAL package (dpkg -s fails on virtuals)
#
# Packages from third-party repos (Radxa, Brave, Mozilla PPA) aren't in the
# host's apt cache; THIRDPARTY_SKIP avoids false positives on those.
step "7. Static apt package-name check (catches virtual/typo bugs in seconds)"

ROOTFS_JSONNET="${RSDK_DIR}/src/share/rsdk/build/rootfs.jsonnet"
THIRDPARTY_SKIP="fastrpc task-qcs6490 task-qualcomm libcdsprpc1 radxa-firmware-qcs6490 firefox-esr brave-browser"

if ! command -v apt-cache >/dev/null 2>&1; then
    warn "apt-cache not available on host — skipping package-name check"
elif [ ! -f "$ROOTFS_JSONNET" ]; then
    fail "$ROOTFS_JSONNET not found — cannot extract package lists"
else
    INSTALL_LIST=$(awk '
        /apt-get install -y --install-recommends \\$/ { in_list=1; next }
        in_list {
            line=$0
            sub(/[[:space:]]*\\[[:space:]]*$/, "", line)
            sub(/^[[:space:]]+/, "", line)
            if (line == "") { in_list=0; next }
            print line
            if ($0 !~ /\\$/) in_list=0
        }
    ' "$ROOTFS_JSONNET")

    VERIFY_LIST=$(awk '
        /for pkg in / && /\\$/ {
            line=$0
            sub(/.*for pkg in /, "", line)
            sub(/[[:space:]]*\\[[:space:]]*$/, "", line)
            n=split(line, a, /[[:space:]]+/)
            for (i=1; i<=n; i++) if (a[i] != "") print a[i]
            in_list=1; next
        }
        in_list {
            line=$0
            if (line ~ /; do$/) {
                sub(/[[:space:]]*; do$/, "", line)
                sub(/^[[:space:]]+/, "", line)
                n=split(line, a, /[[:space:]]+/)
                for (i=1; i<=n; i++) if (a[i] != "") print a[i]
                in_list=0; next
            }
            sub(/[[:space:]]*\\$/, "", line)
            sub(/^[[:space:]]+/, "", line)
            n=split(line, a, /[[:space:]]+/)
            for (i=1; i<=n; i++) if (a[i] != "") print a[i]
        }
    ' "$ROOTFS_JSONNET")

    is_thirdparty() {
        case " $THIRDPARTY_SKIP " in *" $1 "*) return 0 ;; esac
        return 1
    }
    # Real package — has its own .deb (madison shows version line).
    # Capture to a variable to avoid SIGPIPE under `set -o pipefail` (head/grep
    # exiting early makes apt-cache return non-zero, which pipefail then
    # propagates, producing false "not installable" reports).
    is_real_pkg() {
        local out
        out=$(apt-cache madison "$1" 2>/dev/null) || true
        [ -n "$out" ]
    }
    # Installable — either real or a virtual with at least one provider.
    is_installable() {
        is_real_pkg "$1" && return 0
        local out
        out=$(apt-cache showpkg "$1" 2>/dev/null) || true
        [ -z "$out" ] && return 1
        # On a provided virtual, providers are listed AFTER the
        # 'Reverse Provides:' header. On an unknown name, output is empty.
        echo "$out" | awk '/^Reverse Provides:/{f=1;next} f && /[a-zA-Z]/{found=1} END{exit !found}'
    }

    PKG_ERRORS=0
    SKIPPED=0
    CHECKED_INSTALL=0
    CHECKED_VERIFY=0

    for pkg in $INSTALL_LIST; do
        if is_thirdparty "$pkg"; then SKIPPED=$((SKIPPED+1)); continue; fi
        CHECKED_INSTALL=$((CHECKED_INSTALL+1))
        if ! is_installable "$pkg"; then
            fail "install list: '$pkg' is not installable on Noble (typo? renamed? wrong repo?)"
            PKG_ERRORS=$((PKG_ERRORS+1))
        fi
    done

    for pkg in $VERIFY_LIST; do
        if is_thirdparty "$pkg"; then SKIPPED=$((SKIPPED+1)); continue; fi
        CHECKED_VERIFY=$((CHECKED_VERIFY+1))
        if ! is_real_pkg "$pkg"; then
            if is_installable "$pkg"; then
                fail "verify list: '$pkg' is a virtual/Provides-only name — dpkg -s will fail. Use the real package name (e.g. libdvdread8 → libdvdread8t64 on Noble)"
            else
                fail "verify list: '$pkg' is not a real package on Noble (typo? renamed?)"
            fi
            PKG_ERRORS=$((PKG_ERRORS+1))
        fi
    done

    if [ "$PKG_ERRORS" -eq 0 ]; then
        ok "checked $CHECKED_INSTALL install + $CHECKED_VERIFY verify entries against Noble apt cache ($SKIPPED third-party skipped)"
    fi
fi

# ── 8. Deb Depends — resolve against host apt cache ───────────────────────
# Catches the 2-hour-late failure where the trailcurrent-playbill deb
# declares a Depends that apt can't satisfy (e.g. `nodejs (>= 20)` when
# Ubuntu Noble's apt only has nodejs 18). Before this check existed, a
# bad version constraint cost a full image build cycle to surface.
#
# We parse the literal `Depends:` line out of each build-deb.sh's
# heredoc (the same string that becomes the deb's control file) and
# check each "pkg (op ver)" entry against `apt-cache madison` / `policy`.
step "8. Deb Depends resolve against Ubuntu Noble apt cache"

# Convert dpkg version-op + version string to an apt-cache lookup. apt
# uses dpkg --compare-versions for the actual comparison; we ask
# apt-cache for the candidate version, then run dpkg --compare-versions
# to confirm it satisfies the constraint.
check_deb_dep() {
    local origin="$1"   # which deb declared the dep (for error msgs)
    local entry="$2"    # "pkg" or "pkg (>= 18)" — one alternative

    # Trim whitespace.
    entry=$(echo "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$entry" ] || return 0

    # Parse "pkg (op ver)" → pkg, op, ver. Plain "pkg" leaves op/ver empty.
    local pkg op="" ver=""
    pkg=$(echo "$entry" | sed -E 's/^([^ (]+).*/\1/')
    if echo "$entry" | grep -q '('; then
        op=$(echo "$entry"  | sed -E 's/.*\(([<>=!]+) .*/\1/')
        ver=$(echo "$entry" | sed -E 's/.*\([<>=!]+ ([^)]+)\).*/\1/')
    fi

    # Third-party / our-own packages (not in dev host apt). Skip silently.
    case " $THIRDPARTY_SKIP trailcurrent-playbill-dkms trailcurrent-playbill " in
        *" $pkg "*) return 0 ;;
    esac

    if ! is_installable "$pkg"; then
        fail "$origin Depends: '$pkg' not installable on Noble (typo? renamed?)"
        return 1
    fi

    # Version constraint? Check candidate against it via dpkg --compare-versions.
    if [ -n "$op" ] && [ -n "$ver" ]; then
        local cand
        # CRITICAL: filter apt-cache madison to UBUNTU ARCHIVE ONLY. The dev
        # host may have third-party repos enabled (NodeSource, Brave, etc.)
        # but the image's chroot only uses ports.ubuntu.com mirrors, so a
        # version satisfied by NodeSource isn't satisfied in the chroot.
        # Picks the highest Ubuntu-archive version via dpkg --compare-versions
        # bubble-sort. Empty result → no Ubuntu version available, fail.
        cand=$(apt-cache madison "$pkg" 2>/dev/null \
            | awk -F'|' 'tolower($3) ~ /(archive\.ubuntu\.com|ports\.ubuntu\.com|us\.archive\.ubuntu\.com)/ { gsub(/ /,"",$2); print $2 }' \
            | while read -r v; do
                  if [ -z "${best:-}" ] || dpkg --compare-versions "$v" gt "$best" 2>/dev/null; then
                      best="$v"
                  fi
                  echo "$best"
              done | tail -1)
        if [ -z "$cand" ]; then
            fail "$origin Depends: '$entry' — apt has no Ubuntu-archive candidate for $pkg (third-party repo on dev host doesn't count; the image chroot uses Ubuntu mirrors only)"
            return 1
        fi
        local dpkg_op
        case "$op" in
            '>=') dpkg_op='ge' ;;
            '<=') dpkg_op='le' ;;
            '>')  dpkg_op='gt' ;;
            '<')  dpkg_op='lt' ;;
            '=')  dpkg_op='eq' ;;
            *)    return 0 ;;
        esac
        if ! dpkg --compare-versions "$cand" "$dpkg_op" "$ver" 2>/dev/null; then
            fail "$origin Depends: '$entry' UNSATISFIABLE — apt's candidate $pkg=$cand doesn't satisfy $op $ver"
            return 1
        fi
    fi
    return 0
}

# Walk one or more "alternative1 | alternative2" sets — pass if ANY
# alternative resolves. (Most of our Depends are single-package; alt
# syntax appears for kernel-headers in the DKMS deb.)
check_deb_dep_alts() {
    local origin="$1"; shift
    local alts="$1"
    local ok=0 last_err=""
    local IFS='|'
    for alt in $alts; do
        if check_deb_dep "$origin" "$alt" 2>&1; then ok=1; break; fi
    done
    [ "$ok" -eq 1 ]
}

extract_depends() {
    # $1 = path to a build-deb.sh; greps the Depends: line out of its
    # heredoc. Returns the raw RHS (e.g. "nodejs (>= 18), libcap2-bin, ...").
    grep -E '^Depends: ' "$1" | head -1 | sed -E 's/^Depends:[[:space:]]*//'
}

CHECKED_DEBS=0
DEB_ERRORS_BEFORE=$ERRORS
for build_script in \
    "$REPO_ROOT/packaging/trailcurrent-playbill/build-deb.sh" \
    "$REPO_ROOT/packaging/trailcurrent-playbill-dkms/build-deb.sh"; do
    [ -f "$build_script" ] || continue
    pkg_name=$(basename "$(dirname "$build_script")")
    CHECKED_DEBS=$((CHECKED_DEBS+1))
    deps=$(extract_depends "$build_script")
    if [ -z "$deps" ]; then
        fail "$pkg_name: could not extract Depends from $build_script"
        continue
    fi
    # ${DKMS_MIN_VERSION} appears unexpanded in the heredoc — substitute the
    # default so version comparison can run.
    deps=$(echo "$deps" | sed 's/\${DKMS_MIN_VERSION}/1.0.0/g')
    # Split on comma. Each segment may have " | " alternatives.
    IFS=',' read -r -a parts <<< "$deps"
    for part in "${parts[@]}"; do
        check_deb_dep_alts "$pkg_name" "$part"
    done
done

if [ "$ERRORS" -eq "$DEB_ERRORS_BEFORE" ]; then
    ok "checked $CHECKED_DEBS deb(s) — every Depends entry resolves on Noble"
fi

echo ""
if [ "$ERRORS" -gt 0 ]; then
    echo -e "${BOLD}${RED}Preflight FAILED with $ERRORS errors${RESET}"
    exit 1
fi
echo -e "${BOLD}${GREEN}All preflight checks passed${RESET}"
echo ""
exit 0
