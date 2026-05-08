#!/bin/bash
# TrailCurrent Playbill — one-shot first-boot setup.
#
# Runs once on the first boot of a freshly flashed image, then never again
# (sentinel file at /var/lib/trailcurrent-playbill/.firstboot-done).
#
# Scope is intentionally minimal — this is a desktop, not an appliance. We
# don't run security updates here, don't generate TLS certs, don't prompt
# the user for credentials. Just the housekeeping that has to happen exactly
# once after dd:
#
#   1. Resize root partition + filesystem to fill the NVMe.
#   2. Regenerate machine-id (golden image ships with this zeroed).
#   3. Regenerate SSH host keys if any are missing (defensive — they're
#      pre-generated in the chroot, but if a key file got corrupted in
#      flashing this catches it).
#   4. Set the hostname.
#
# Sentinel is only written if every step succeeds. Partial failure leaves
# the sentinel absent and the unit re-runs on the next boot.

set -euo pipefail

SENTINEL_DIR=/var/lib/trailcurrent-playbill
SENTINEL=${SENTINEL_DIR}/.firstboot-done
HOSTNAME=trailcurrent-playbill

log() { echo "[playbill-firstboot] $*"; }

mkdir -p "$SENTINEL_DIR"

# ── 1. Resize root partition + filesystem ───────────────────────────────────
log "Resizing root partition to fill device"
ROOT_DEV=$(findmnt -no SOURCE /)
ROOT_DISK=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null || true)
if [ -n "$ROOT_DISK" ]; then
    PART_NUM=$(echo "$ROOT_DEV" | grep -oE '[0-9]+$' || true)
    if [ -n "$PART_NUM" ] && command -v growpart >/dev/null 2>&1; then
        growpart "/dev/$ROOT_DISK" "$PART_NUM" 2>&1 || log "  growpart skipped (already at max?)"
    fi
    case "$ROOT_DEV" in
        /dev/nvme*|/dev/sd*|/dev/mmcblk*)
            resize2fs "$ROOT_DEV" 2>&1 || log "  resize2fs skipped (filesystem may not be ext4)"
            ;;
    esac
else
    log "  could not determine root disk; skipping resize"
fi

# ── 2. Regenerate machine-id ────────────────────────────────────────────────
log "Regenerating machine-id"
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup
if [ -f /etc/machine-id ] && [ ! -f /var/lib/dbus/machine-id ]; then
    ln -s /etc/machine-id /var/lib/dbus/machine-id || true
fi

# ── 3. Regenerate any missing SSH host keys ─────────────────────────────────
log "Verifying SSH host keys"
KEY_COUNT=$(ls /etc/ssh/ssh_host_*_key 2>/dev/null | wc -l)
if [ "$KEY_COUNT" -lt 3 ]; then
    log "  fewer than 3 host keys present — regenerating"
    rm -f /etc/ssh/ssh_host_*
    ssh-keygen -A
fi
systemctl restart ssh.service 2>/dev/null || true

# ── 4. Hostname ─────────────────────────────────────────────────────────────
log "Setting hostname to $HOSTNAME"
hostnamectl set-hostname "$HOSTNAME" 2>/dev/null || echo "$HOSTNAME" > /etc/hostname
grep -q "127.0.1.1.*$HOSTNAME" /etc/hosts || echo "127.0.1.1   $HOSTNAME" >> /etc/hosts

# ── 5. Rebuild initramfs with the TrailCurrent Plymouth theme ───────────────
# Belt-and-suspenders for hook 7 in the image build: that hook calls
# update-initramfs inside a qemu-arm64 chroot, which sometimes silently fails
# to actually rebuild the initramfs (we observed the Ubuntu Plymouth still
# being shown on a freshly flashed board). Rebuilding here from the real
# kernel guarantees the trailcurrent theme is in initramfs from boot 2 onward.
# Boot 1 may still show the Ubuntu Plymouth — that's an accepted Stage-1 cost.
if [ -d /usr/share/plymouth/themes/trailcurrent ]; then
    log "Rebuilding initramfs to include TrailCurrent Plymouth theme"
    update-initramfs -u -k all 2>&1 | sed 's/^/    /' || \
        log "  WARNING: update-initramfs failed (will retry on next boot)"
fi

# ── 6. Refresh GNOME desktop database + icon cache ──────────────────────────
# Same belt-and-suspenders rationale: hook 5b runs these in chroot but if the
# qemu chroot run misses, the launcher icon and .desktop entry never show up
# until something else triggers a rebuild. Force it from the real boot.
update-desktop-database -q /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -q -f -t /usr/share/icons/hicolor 2>/dev/null || true

# ── Done ────────────────────────────────────────────────────────────────────
touch "$SENTINEL"
log "First-boot setup complete; sentinel at $SENTINEL"
