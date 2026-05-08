// ============================================================================
// TrailCurrent Playbill — Radxa Dragon Q6A rootfs.jsonnet
//
// Builds a branded Ubuntu Noble (24.04) GNOME desktop image for the Q6A. The
// desktop is the product. Playbill is one preinstalled application that the
// user launches from the GNOME dock to turn the desktop into the in-rig
// entertainment center.
//
// Hardware: Radxa Dragon Q6A (Qualcomm QCS6490)
// Display:  Wayland (GNOME on Mutter)
// Audio:    Built-in 3.5mm headphone jack (WCD938x codec)
// Network:  WiFi (ath11k) + Ethernet, both via NetworkManager
// Boot:     Patched embloader (autoboot at timeout=0; mandatory Q6A fix)
//
// All Playbill-specific files are staged into $PLAYBILL_STAGING by
// image/build.sh before rsdk-build runs. The customize-hooks below copy them
// from there into the chroot rootfs.
// ============================================================================

local distro = import "mod/distro.libjsonnet";
local additional_repos = import "mod/additional_repos.libjsonnet";
local packages = import "mod/packages.libjsonnet";
local cleanup = import "mod/cleanup.libjsonnet";

function(
    architecture = "arm64",
    mode = "root",
    rootfs = "rootfs.tar",
    variant = "apt",

    temp_dir,
    output_dir,
    rsdk_rev = "",

    distro_mirror = "",
    snapshot_timestamp = "",

    radxa_mirror = "",
    radxa_repo_suffix = "",

    product,
    suite,
    edition,
    build_date,

    vendor_packages = true,
    linux_override = "",
    firmware_override = "",
    install_vscodium = false,
    use_pkgs_json = true,
) distro(suite, distro_mirror, architecture, snapshot_timestamp)
+ additional_repos(suite, radxa_mirror, radxa_repo_suffix, product, temp_dir, install_vscodium, use_pkgs_json)
+ packages(suite, edition, product, temp_dir, vendor_packages, linux_override, firmware_override)
+ cleanup()
+ {
    mmdebstrap+: {
        architectures: [architecture],
        keyrings:      ["%(temp_dir)s/keyrings/" % {temp_dir: temp_dir}],
        mode:          mode,
        target:        rootfs,
        variant:       variant,
        hostname:      "trailcurrent-playbill",
        packages+: [
            // ── Core system tooling ──────────────────────────────────────
            "ca-certificates",
            "curl",
            "wget",
            "gnupg",
            "lsb-release",
            "apt-transport-https",
            "sudo",
            "openssh-server",
            "avahi-daemon",
            "avahi-utils",
            "libnss-mdns",
            "rfkill",
            "cloud-guest-utils",
            "parted",
            "nvme-cli",
            "htop",
            "nano",
            "less",
            "jq",
            "unzip",

            // ── Boot splash ─────────────────────────────────────────────
            "plymouth",
            "plymouth-themes",
            "initramfs-tools",

            // ── GNOME desktop ───────────────────────────────────────────
            // Full ubuntu-desktop (not -minimal). Brings in language packs,
            // gnome-initial-setup, the full app suite (Calculator, Calendar,
            // Maps, Geary, etc. — the apps that the default app-picker-layout
            // references), gnome-control-center-data, dbus-x11. Trades ~500 MB
            // of image size for far fewer "missing piece" surprises.
            "ubuntu-desktop",
            "gnome-shell",
            "gdm3",
            "nautilus",
            "gnome-control-center",
            "gnome-terminal",
            "gnome-tweaks",
            "network-manager-gnome",
            "yaru-theme-gtk",
            "yaru-theme-icon",

            // ── GPU userspace (Adreno on QCS6490 via Mesa) ──────────────
            "mesa-vulkan-drivers",
            "libdrm2",
            "libgbm1",
            "libegl1",
            "libgl1-mesa-dri",
            "libglx-mesa0",

            // ── Audio (PipeWire + WirePlumber + UCM profiles) ───────────
            "pipewire",
            "pipewire-pulse",
            "wireplumber",
            "alsa-ucm-conf",
            "alsa-utils",
            "pavucontrol",

            // ── WiFi (Quectel FCU760K module, AIC8800D80 chipset, USB) ──
            // Confirmed via the Q6A schematic v1.21 (page 3 block diagram):
            //   "USB2.0 Wifi Module FCU760K" → AICSemi AIC8800D80 family.
            // NOT WCN6855 / ath11k — Radxa explicitly disables ath in-tree
            // (kernel patch CONFIG_AIC_WLAN_SUPPORT=n + comment "Prefer
            // aic8800 DKMS packages"). The DKMS package builds the driver
            // against the installed kernel headers DURING this mmdebstrap
            // install, so the .ko is baked into the image and WiFi works on
            // every fresh boot. linux-firmware stays for other devices
            // (Bluetooth blobs, GPU, etc.) but is NOT what powers WiFi.
            "linux-firmware",
            "dkms",
            "aic8800-usb-dkms",
            "aic8800-firmware",

            // ── Browser ─────────────────────────────────────────────────
            // Ubuntu's `firefox` package is a transitional package that pulls
            // in Firefox via snap. snapd in our image is incomplete (we don't
            // use snaps for anything else), so the snap install fails silently
            // and we end up with /usr/bin/firefox as a wrapper that errors
            // out with "xdg-settings: not found / libpxbackend missing" at
            // launch. Drop the transitional shim and install Firefox ESR
            // from Ubuntu universe (a real .deb, no snap dependency).
            //
            // The snap-shim is removed by hook 3a below; firefox-esr is a
            // real install here.
            "firefox-esr",

            // ── Electron runtime libs (Playbill app links these) ────────
            "libnss3",
            "libnotify4",
            "libxss1",
            "libxtst6",
            "libatspi2.0-0",
            "libasound2t64",
        ],
        "customize-hooks"+: [

            // ════════════════════════════════════════════════════════════
            // Hook 0: rsdk standard prologue (hostname, fingerprint, initramfs)
            // ════════════════════════════════════════════════════════════
            'echo "127.0.1.1\ttrailcurrent-playbill" >> "$1/etc/hosts"',
            'cp "%(output_dir)s/config.yaml" "$1/etc/rsdk/"' % {output_dir: output_dir},
            'echo "FINGERPRINT_VERSION=\'2\'" > "$1/etc/radxa_image_fingerprint"',
            'echo "RSDK_BUILD_DATE=\'$(date -R)\'" >> "$1/etc/radxa_image_fingerprint"',
            'echo "RSDK_REVISION=\'%(rsdk_rev)s\'" >> "$1/etc/radxa_image_fingerprint"' % {rsdk_rev: rsdk_rev},
            'echo "RSDK_CONFIG=\'/etc/rsdk/config.yaml\'" >> "$1/etc/radxa_image_fingerprint"',
            'chroot "$1" sh -c "SYSTEMD_RELAX_ESP_CHECKS=1 update-initramfs -c -k all"',
            'chroot "$1" sh -c "u-boot-update"',
            |||
                cp -aR "$1/boot/efi" "$1/boot/efi2"
                chmod 0755 "$1/boot/efi2"
                umount "$1/boot/efi"
                rmdir "$1/boot/efi"
                mv "$1/boot/efi2" "$1/boot/efi"
            |||,
            |||
                mkdir -p "%(output_dir)s/seed"
                cp "$1/etc/radxa_image_fingerprint" "%(output_dir)s/seed"
                cp "$1/etc/rsdk/"* "%(output_dir)s/seed"
                tar Jvcf "%(output_dir)s/seed.tar.xz" -C "%(output_dir)s/seed" .
                rm -rf "%(output_dir)s/seed"
            ||| % {output_dir: output_dir},

            // ════════════════════════════════════════════════════════════
            // Hook 1: Hostname
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 1] hostname"
                echo "trailcurrent-playbill" > "$1/etc/hostname"
                grep -q "127.0.1.1.*trailcurrent-playbill" "$1/etc/hosts" || \
                    echo "127.0.1.1   trailcurrent-playbill" >> "$1/etc/hosts"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 2: Purge rsetup-config-first-boot
            //
            // Radxa's rsetup-config-first-boot package ships /config/before.txt
            // which calls `disable_service ssh` and creates an unwanted radxa
            // user. We purge the package AND mask rsetup.service + config.automount
            // (hook 14) so the /config partition is never read.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 2] purging rsetup-config-first-boot"
                chroot "$1" apt-get remove -y --purge rsetup-config-first-boot 2>/dev/null || true
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 3: Default user `trailcurrent` (password: trailcurrent)
            //
            // The user logs into GNOME with this account. Force password change
            // on first login is handled by GDM's chage settings + the chage call
            // below. Passwordless sudo lets the user run the standard "Software
            // Updater" GUI without a sudo prompt loop.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 3] creating trailcurrent user"
                if ! chroot "$1" id trailcurrent >/dev/null 2>&1; then
                    chroot "$1" useradd -m -s /bin/bash \
                        -G sudo,plugdev,systemd-journal,adm,dialout,audio,video,netdev \
                        trailcurrent
                else
                    chroot "$1" usermod -aG sudo,plugdev,systemd-journal,adm,dialout,audio,video,netdev trailcurrent
                fi
                echo "trailcurrent:trailcurrent" | chroot "$1" chpasswd
                # Force password change on first login.
                chroot "$1" chage -d 0 trailcurrent
                chroot "$1" passwd -l root || true

                echo "trailcurrent ALL=(ALL) NOPASSWD: ALL" \
                    > "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
                chmod 440 "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 4: GPU userspace pinning + linux-firmware pinning
            //
            // The single biggest fix for the recurring "kernel update broke
            // GPU/WiFi" pain point on the Q6A. Mesa, libdrm, libgbm, libegl,
            // libgl1-mesa-dri, libglx-mesa0, linux-firmware, AND the linux-image
            // / linux-headers / linux-modules packages are pinned to Pin-Priority
            // -1 via /etc/apt/preferences.d/. apt cannot silently upgrade them,
            // not via `apt upgrade` and not via `unattended-upgrades`. To roll
            // a new kernel after validating it on a staging board:
            //
            //     sudo apt-mark unhold linux-image-* linux-headers-* linux-modules-*
            //     sudo apt update && sudo apt full-upgrade
            //     sudo apt-mark hold   linux-image-* linux-headers-* linux-modules-*
            //
            // Userspace security updates (openssl, glibc, gnome, browser, etc.)
            // flow normally via standard unattended-upgrades.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 4] installing apt pinning policy (kernel + Mesa + linux-firmware)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                mkdir -p "$1/etc/apt/preferences.d"
                install -m 644 "$FILES/apt/50-trailcurrent-playbill-holds.pref" \
                    "$1/etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref"
                mkdir -p "$1/etc/apt/apt.conf.d"
                install -m 644 "$FILES/apt/60-trailcurrent-playbill-no-recommends.conf" \
                    "$1/etc/apt/apt.conf.d/60-trailcurrent-playbill-no-recommends.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 4a: Purge the Firefox snap-shim transitional package
            //
            // ubuntu-desktop's recommends pulled in /usr/bin/firefox from the
            // `firefox` apt package — which is a 4-line shell wrapper that
            // tries to launch the snap. snapd is incomplete in our image, so
            // the wrapper errors out at launch ("xdg-settings: not found",
            // "libpxbackend-1.0.so: cannot open shared object file"). Purge
            // it; firefox-esr (a real .deb) is in the package list above.
            //
            // We also pin `firefox` package to Pin-Priority -1 so apt can't
            // re-pull it on subsequent upgrades.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 4a] purging firefox snap-shim transitional package"
                cat > "$1/etc/apt/preferences.d/55-trailcurrent-playbill-no-firefox-shim.pref" <<'EOF'
                Package: firefox
                Pin: release *
                Pin-Priority: -1
                EOF
                chroot "$1" apt-get remove -y --purge firefox 2>&1 || \
                    echo "  (firefox shim not installed — fine)"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 5: Stage Electron app into /opt/trailcurrent-playbill/
            //
            // build.sh stages the unpacked Electron arm64 dir
            // (app/dist/linux-arm64-unpacked/) into $STAGING/electron-app/.
            // We copy the whole tree to /opt/trailcurrent-playbill/, drop
            // the .desktop launcher into /usr/share/applications/, and
            // install the Playbill icon set into /usr/share/icons/hicolor/.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 5] staging Electron app into /opt/trailcurrent-playbill/"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"

                if [ ! -d "$STAGING/electron-app" ]; then
                    echo "  ERROR: $STAGING/electron-app missing — build.sh should have staged it" >&2
                    exit 1
                fi
                if [ ! -x "$STAGING/electron-app/trailcurrent-playbill" ]; then
                    echo "  ERROR: $STAGING/electron-app/trailcurrent-playbill is not executable" >&2
                    exit 1
                fi

                APP_DIR="$1/opt/trailcurrent-playbill"
                mkdir -p "$APP_DIR"
                cp -a "$STAGING/electron-app/." "$APP_DIR/"
                # Electron's chrome-sandbox needs SUID to enable the GPU sandbox.
                chmod 4755 "$APP_DIR/chrome-sandbox" 2>/dev/null || true

                APP_SIZE=$(du -sh "$APP_DIR" | cut -f1)
                echo "  staged $APP_SIZE Electron app"

                # Launcher .desktop entry
                mkdir -p "$1/usr/share/applications"
                install -m 644 "$STAGING/files/launcher/trailcurrent-playbill.desktop" \
                    "$1/usr/share/applications/trailcurrent-playbill.desktop"

                # Icons (one per resolution)
                for size in 16 24 32 48 64 96 128 256 512; do
                    src="$STAGING/files/icons/${size}x${size}.png"
                    [ -f "$src" ] || continue
                    dst_dir="$1/usr/share/icons/hicolor/${size}x${size}/apps"
                    mkdir -p "$dst_dir"
                    install -m 644 "$src" "$dst_dir/trailcurrent-playbill.png"
                done
                # SVG (scalable)
                if [ -f "$STAGING/files/icons/icon.svg" ]; then
                    mkdir -p "$1/usr/share/icons/hicolor/scalable/apps"
                    install -m 644 "$STAGING/files/icons/icon.svg" \
                        "$1/usr/share/icons/hicolor/scalable/apps/trailcurrent-playbill.svg"
                fi

                # Refresh GNOME's caches so the launcher entry + icons are
                # discoverable on first boot. Without these, GNOME may not
                # see the new .desktop file until something else (a package
                # install, a logout/login) triggers a rebuild.
                chroot "$1" update-desktop-database -q /usr/share/applications 2>&1 \
                    || echo "  WARNING: update-desktop-database failed (non-fatal)"
                chroot "$1" gtk-update-icon-cache -q -f -t /usr/share/icons/hicolor 2>&1 \
                    || echo "  WARNING: gtk-update-icon-cache failed (non-fatal)"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 6: Audio — pin default sink to the analog jack
            //
            // The Q6A's WCD938x analog codec is the only output we use.
            // PipeWire/WirePlumber sometimes prefers HDMI when an HDMI
            // display is connected; this rule pushes the analog jack ahead.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 6] installing audio config (default sink = analog jack)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                mkdir -p "$1/etc/wireplumber/wireplumber.conf.d"
                install -m 644 "$FILES/audio/wireplumber.conf.d/50-playbill-default-sink.conf" \
                    "$1/etc/wireplumber/wireplumber.conf.d/50-playbill-default-sink.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 7: Branding — Plymouth, GDM background, GNOME wallpapers, dconf
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 7] installing branding (Plymouth + GDM + dconf + wallpapers)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"

                # Plymouth boot splash
                THEME_DIR="$1/usr/share/plymouth/themes/trailcurrent"
                mkdir -p "$THEME_DIR"
                cp "$FILES/plymouth/trailcurrent.plymouth" "$THEME_DIR/"
                cp "$FILES/plymouth/trailcurrent.script"   "$THEME_DIR/"
                cp "$FILES/plymouth/logo.png"              "$THEME_DIR/"
                cp "$FILES/plymouth/background.png"        "$THEME_DIR/"
                chroot "$1" update-alternatives --install \
                    /usr/share/plymouth/themes/default.plymouth \
                    default.plymouth \
                    /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth 200
                chroot "$1" update-alternatives --set default.plymouth \
                    /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth
                # Rebuild initramfs so the new Plymouth theme is actually
                # included. PRIOR BUG: this used `2>/dev/null || echo WARNING`,
                # which silently swallowed qemu-arm64 failures and left the old
                # Ubuntu Plymouth in initramfs. Fail loud now; trailcurrent-
                # playbill-firstboot.sh also re-runs this from the real boot
                # as belt-and-suspenders if the in-chroot run misses.
                if ! chroot "$1" update-initramfs -u -k all; then
                    echo "  WARNING: update-initramfs failed in chroot (qemu-arm64);"
                    echo "  firstboot will retry from the real kernel. Continuing build."
                fi

                # GNOME wallpapers (light + dark variants)
                WP_DIR="$1/usr/share/backgrounds/trailcurrent-playbill"
                mkdir -p "$WP_DIR"
                install -m 644 "$STAGING/branding/wallpaper-light.png" "$WP_DIR/wallpaper-light.png"
                install -m 644 "$STAGING/branding/wallpaper-dark.png"  "$WP_DIR/wallpaper-dark.png"
                install -m 644 "$STAGING/branding/playbill-logo.svg"   "$WP_DIR/playbill-logo.svg"
                # Rasterized logo for GDM
                install -m 644 "$FILES/icons/512x512.png"              "$WP_DIR/playbill-logo.png"

                # System-wide dconf defaults (wallpapers, theme, dock favorites)
                mkdir -p "$1/etc/dconf/db/local.d"
                install -m 644 "$FILES/gnome/dconf/00-trailcurrent-playbill" \
                    "$1/etc/dconf/db/local.d/00-trailcurrent-playbill"
                # Optional locks file (empty in Stage 1; user owns the desktop)
                mkdir -p "$1/etc/dconf/db/local.d/locks"
                install -m 644 "$FILES/gnome/dconf-locks/00-trailcurrent-playbill-locks" \
                    "$1/etc/dconf/db/local.d/locks/00-trailcurrent-playbill-locks"

                # Profile that picks up the local.d defaults
                mkdir -p "$1/etc/dconf/profile"
                cat > "$1/etc/dconf/profile/user" <<'EOF'
                user-db:user
                system-db:local
                EOF

                # GDM-side dconf overrides — the login screen runs as the
                # `gdm` user with its own dconf profile, so wallpaper / theme
                # / accent overrides for the user session do NOT apply to GDM
                # automatically. We install a dedicated gdm.d database.
                mkdir -p "$1/etc/dconf/db/gdm.d"
                install -m 644 "$FILES/gnome/gdm-dconf/00-trailcurrent-playbill-gdm" \
                    "$1/etc/dconf/db/gdm.d/00-trailcurrent-playbill-gdm"
                install -m 644 "$FILES/gnome/gdm-dconf/profile-gdm" \
                    "$1/etc/dconf/profile/gdm"

                chroot "$1" dconf update 2>&1 || \
                    echo "  WARNING: dconf update failed (non-fatal under qemu)"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 8: TrailCurrent-Playbill GTK theme (Farwatch PWA chrome port)
            //
            // Two installs in one hook:
            //   (a) The full theme tree at /usr/share/themes/TrailCurrent-Playbill/
            //       — index.theme + gtk-3.0/gtk.css + gtk-4.0/gtk.css. Selected
            //       via gsettings org.gnome.desktop.interface gtk-theme (set in
            //       our local.d dconf, locked in locks/).
            //   (b) /etc/gtk-{3,4}.0/gtk.css — system-wide stylesheet that
            //       applies on top of whatever theme is active. Defense-in-depth
            //       for apps that ignore the theme name (rare, but it happens).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 8] installing TrailCurrent-Playbill GTK theme"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"

                # (a) Full theme tree — copied wholesale from staging
                THEME_DIR="$1/usr/share/themes/TrailCurrent-Playbill"
                mkdir -p "$THEME_DIR"
                cp -a "$FILES/gnome/themes/TrailCurrent-Playbill/." "$THEME_DIR/"
                find "$THEME_DIR" -type f -exec chmod 644 {} \;
                find "$THEME_DIR" -type d -exec chmod 755 {} \;
                echo "  installed theme tree: $(find "$THEME_DIR" -type f | wc -l) files"

                # (b) System-wide gtk.css overrides (belt-and-suspenders)
                mkdir -p "$1/etc/gtk-4.0" "$1/etc/gtk-3.0"
                install -m 644 "$FILES/gnome/gtk-4.0/gtk.css" "$1/etc/gtk-4.0/gtk.css"
                install -m 644 "$FILES/gnome/gtk-3.0/gtk.css" "$1/etc/gtk-3.0/gtk.css"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 9: First-boot oneshot service + script
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 9] installing first-boot oneshot service"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/systemd/trailcurrent-playbill-firstboot.service" \
                    "$1/etc/systemd/system/trailcurrent-playbill-firstboot.service"
                install -m 755 "$FILES/scripts/trailcurrent-playbill-firstboot.sh" \
                    "$1/usr/local/sbin/trailcurrent-playbill-firstboot.sh"
                # systemd timeout overrides (kept from Headwaters defaults)
                mkdir -p "$1/etc/systemd/system.conf.d"
                install -m 644 "$FILES/systemd/system.conf.d/timeout.conf" \
                    "$1/etc/systemd/system.conf.d/timeout.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 10: MOTD + console issue (rebrand)
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 10] installing MOTD and console issue"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                rm -f "$1"/etc/update-motd.d/*
                install -m 755 "$FILES/motd/10-trailcurrent" \
                    "$1/etc/update-motd.d/10-trailcurrent"
                install -m 644 "$FILES/motd/issue-trailcurrent" "$1/etc/issue"
                install -m 644 "$FILES/motd/issue-trailcurrent" "$1/etc/issue.net"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 11: Branded shell prompt
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 11] installing branded shell prompt"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/profile/trailcurrent-prompt.sh" \
                    "$1/etc/profile.d/trailcurrent-prompt.sh"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 12: sysctl tuning
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 12] installing sysctl tuning"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/sysctl/90-trailcurrent-playbill.conf" \
                    "$1/etc/sysctl.d/90-trailcurrent-playbill.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 13: Minimal modprobe blacklist (NPU only)
            //
            // PRIOR BUG: this used to also blacklist q6asm_dai, q6adm, q6afe,
            // q6core, q6routing, audioreach. Those are the Q6 audio routing
            // fabric on QCS6490 — blacklisting them gave us the "dummy output"
            // sink and broke the analog jack entirely. Only NPU stays
            // blacklisted now.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 13] installing minimal modprobe blacklist (NPU only)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/modprobe/disable-unused.conf" \
                    "$1/etc/modprobe.d/disable-unused.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 14: Mask appliance-only / problematic services
            //
            // CRITICAL: rsetup.service + config.automount must be masked, OR
            // first boot reads /config/before.txt off the auto-mounted /config
            // partition and calls `disable_service ssh`, leaving the board
            // unreachable. See hook 2 for the package-side purge; this masks
            // the runtime executor.
            //
            // ALSO CRITICAL — boot-hang fix:
            // NetworkManager-wait-online.service blocks boot for 90+ seconds
            // when no Wi-Fi profile is saved (the fresh-from-flash state),
            // then prints "network failed to start". On a desktop where the
            // user logs in to GDM and configures Wi-Fi from the indicator,
            // this is exactly backwards — boot should not wait for network
            // before showing GDM. Mask it.
            //
            // systemd-networkd is masked because Ubuntu Noble's package set
            // ships it alongside NetworkManager and they fight over interface
            // ownership. NetworkManager is our network manager; networkd is
            // not used. Masking it here also masks systemd-networkd-wait-online
            // transitively, which is the OTHER 90s wait-on-network blocker.
            //
            // We do NOT mask unattended-upgrades — this is a desktop, security
            // updates flow normally (the kernel/mesa/firmware holds in hook 4
            // protect the dangerous packages).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 14] masking rsetup + boot-hang services"
                # Two clusters of masks:
                #   (a) Q6A safety — rsetup.service + config.automount, otherwise
                #       Radxa's first-boot reads /config/before.txt and calls
                #       disable_service ssh, leaving the board unreachable.
                #   (b) Boot-graph deletes — every service below pulls
                #       network-online.target into the boot graph and stalls
                #       boot waiting on networking. We are a desktop where the
                #       user configures WiFi at first login; boot must not
                #       block on a network connection that doesn't exist yet.
                MASK="rsetup.service \
                      config.automount \
                      NetworkManager-wait-online.service \
                      systemd-networkd-wait-online.service \
                      systemd-networkd.service \
                      systemd-networkd.socket \
                      cloud-init.service \
                      cloud-init-local.service \
                      cloud-config.service \
                      cloud-final.service \
                      cloud-init.target \
                      cloud-init-network.service \
                      multipathd.service \
                      multipathd.socket \
                      snapd.seeded.service \
                      systemd-time-wait-sync.service"
                for svc in $MASK; do
                    chroot "$1" systemctl mask "$svc" 2>/dev/null || true
                done
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 15: SSH config drop-in
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 15] installing SSH config"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                mkdir -p "$1/etc/ssh/sshd_config.d"
                install -m 644 "$FILES/ssh/sshd_config.d/10-trailcurrent.conf" \
                    "$1/etc/ssh/sshd_config.d/10-trailcurrent.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 16: Validate sudoers
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 16] validating /etc/sudoers"
                chroot "$1" visudo -c
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 17: Write /etc/playbill-release
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 17] writing /etc/playbill-release"
                {
                    echo "PLAYBILL_VERSION=\"${PLAYBILL_VERSION:-dev}\""
                    echo "PLAYBILL_BUILD_DATE=\"$(date -R)\""
                    echo "PLAYBILL_BUILD_HOST=\"$(hostname)\""
                    echo "PLAYBILL_TARGET=\"radxa-dragon-q6a\""
                } > "$1/etc/playbill-release"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 18: chown /home/trailcurrent
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 18] fixing ownership of /home/trailcurrent"
                chroot "$1" chown -R trailcurrent:trailcurrent /home/trailcurrent
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 19: Enable services (ssh, NetworkManager, GDM, firstboot)
            //
            // SSH socket-activation fix (Ubuntu 24.04): openssh-server's postinst
            // creates /etc/systemd/system/ssh.service.requires/ssh.socket. systemd
            // mask creates ssh.socket → /dev/null but does NOT remove the .requires
            // symlink, so ssh.service can't start because it Requires the masked
            // socket. The disable → mask → rm sequence below is load-bearing.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 19] enabling services"
                chroot "$1" systemctl disable ssh.socket 2>/dev/null || true
                chroot "$1" systemctl mask    ssh.socket 2>/dev/null || true
                rm -f "$1/etc/systemd/system/ssh.service.requires/ssh.socket"

                chroot "$1" systemctl enable \
                    ssh.service \
                    avahi-daemon.service \
                    NetworkManager.service \
                    gdm.service \
                    trailcurrent-playbill-firstboot.service
                chroot "$1" systemctl set-default graphical.target
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 20: Kernel cmdline — usbcore.autosuspend
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 20] patching kernel cmdline"
                CMDLINE="$1/etc/kernel/cmdline"
                if [ -f "$CMDLINE" ] && ! grep -q "usbcore.autosuspend" "$CMDLINE"; then
                    sed -i 's/$/ usbcore.autosuspend=-1/' "$CMDLINE"
                fi
                EXTLINUX="$1/boot/extlinux/extlinux.conf"
                if [ -f "$EXTLINUX" ] && ! grep -q "usbcore.autosuspend" "$EXTLINUX"; then
                    sed -i '/^[[:space:]]*append/ s/$/ usbcore.autosuspend=-1/' "$EXTLINUX"
                fi
                for entry in "$1"/boot/efi/loader/entries/*.conf; do
                    [ -f "$entry" ] || continue
                    if ! grep -q "usbcore.autosuspend" "$entry"; then
                        sed -i '/^options / s/$/ usbcore.autosuspend=-1/' "$entry"
                    fi
                done
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 21: Install device-tree overlay (unused-pins disable)
            //
            // Defense-in-depth against EMI / floating-pin issues. The unused-pins
            // overlay claims every 40-pin header GPIO we do not bind so they sit
            // in a defined state instead of being susceptible to capacitive
            // coupling from adjacent SPI clocks etc. Compiled by build.sh from
            // image/overlays/*.dts before this hook runs.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 21] installing device-tree overlay (unused-pins)"

                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                OVERLAYS="qcs6490-radxa-dragon-q6a-playbill-unused-pins-disable.dtbo"
                for OVR in $OVERLAYS; do
                    if [ ! -f "$STAGING/files/dtbo/$OVR" ]; then
                        echo "  ERROR: overlay $OVR missing from staging" >&2
                        exit 1
                    fi
                done

                KVER=""
                for d in "$1"/usr/lib/linux-image-*; do
                    [ -d "$d" ] || continue
                    KVER="${d##*/linux-image-}"
                    break
                done
                if [ -z "$KVER" ]; then
                    echo "  ERROR: no /usr/lib/linux-image-*/ in chroot" >&2
                    exit 1
                fi

                ENTRY_TOKEN=$(cat "$1/etc/kernel/entry-token" 2>/dev/null || echo "")
                if [ -z "$ENTRY_TOKEN" ]; then
                    echo "  ERROR: /etc/kernel/entry-token missing" >&2
                    exit 1
                fi

                EFI_ENTRY="$1/boot/efi/$ENTRY_TOKEN/$KVER"
                mkdir -p "$EFI_ENTRY/dtbo"
                for OVR in $OVERLAYS; do
                    install -m 644 "$STAGING/files/dtbo/$OVR" "$EFI_ENTRY/dtbo/$OVR"
                done

                BASE_DTB=$(find "$1/usr/lib/linux-image-$KVER/" -type f -name "*radxa-dragon-q6a.dtb" 2>/dev/null | head -1)
                if [ -z "$BASE_DTB" ]; then
                    echo "  ERROR: base DTB *radxa-dragon-q6a.dtb not found" >&2
                    exit 1
                fi
                install -m 644 "$BASE_DTB" "$EFI_ENTRY/"
                BASE_NAME=$(basename "$BASE_DTB")

                LOADER="$1/boot/efi/loader/entries/${ENTRY_TOKEN}-${KVER}.conf"
                if [ ! -f "$LOADER" ]; then
                    LOADER=$(ls "$1"/boot/efi/loader/entries/${ENTRY_TOKEN}-${KVER}*.conf 2>/dev/null | head -1)
                fi
                if [ ! -f "$LOADER" ]; then
                    echo "  ERROR: loader entry not found for $KVER" >&2
                    exit 1
                fi
                sed -i '/^devicetree /d; /^devicetree-overlay /d' "$LOADER"
                {
                    echo "devicetree /$ENTRY_TOKEN/$KVER/$BASE_NAME"
                    for OVR in $OVERLAYS; do
                        echo "devicetree-overlay /$ENTRY_TOKEN/$KVER/dtbo/$OVR"
                    done
                } >> "$LOADER"
                echo "  enabled overlays for $KVER"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 22: Harden systemd-boot loader.conf (timeout=0 unattended)
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 22] writing hardened loader.conf"
                LOADER_CONF="$1/boot/efi/loader/loader.conf"
                if [ ! -f "$LOADER_CONF" ]; then
                    echo "  ERROR: $LOADER_CONF missing — bootctl install did not run?" >&2
                    exit 1
                fi
                {
                    printf 'default RadxaOS-*\n'
                    printf 'timeout 0\n'
                    printf 'console-mode keep\n'
                    printf 'editor no\n'
                    printf 'auto-firmware no\n'
                } > "$LOADER_CONF"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 23: Install patched embloader.efi
            //
            // Mandatory Q6A fix. Stock embloader 0.4 polls ConIn during the
            // autoboot window even at timeout=0; phantom serial input on the
            // floating debug-UART RX pin (gpio23) traps the menu. Our patched
            // build skips the menu when timeout==0.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 23] installing patched embloader.efi"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                SRC="$STAGING/files/embloader/embloader.efi"
                if [ ! -f "$SRC" ]; then
                    echo "  ERROR: $SRC missing — build.sh should have built it" >&2
                    exit 1
                fi
                EXPECTED_SHA=$(cut -d' ' -f1 "$STAGING/files/embloader/embloader.efi.sha256")
                ACTUAL_SHA=$(sha256sum "$SRC" | cut -d' ' -f1)
                if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
                    echo "  ERROR: embloader sha256 mismatch" >&2
                    exit 1
                fi
                for dest in \
                    "$1/boot/efi/EFI/BOOT/BOOTAA64.EFI" \
                    "$1/boot/efi/EFI/systemd/systemd-bootaa64.efi"
                do
                    mkdir -p "$(dirname "$dest")"
                    install -m 644 "$SRC" "$dest"
                done
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 24: Cleanup
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 24] cleanup"
                : > "$1/etc/machine-id"
                rm -f "$1/var/lib/dbus/machine-id"
                # SSH host keys intentionally preserved — see Headwaters'
                # comment about the regeneration-on-first-boot fragility.
                chroot "$1" apt-get clean
                rm -rf "$1"/var/lib/apt/lists/*
                find "$1"/var/log -type f -name '*.log' -delete 2>/dev/null || true
                : > "$1"/root/.bash_history              2>/dev/null || true
                : > "$1"/home/trailcurrent/.bash_history 2>/dev/null || true
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 25: SSH readiness verification
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 25] verifying SSH readiness"
                KEY_COUNT=$(ls "$1"/etc/ssh/ssh_host_*_key 2>/dev/null | wc -l)
                if [ "$KEY_COUNT" -lt 3 ]; then
                    for type in rsa ecdsa ed25519; do
                        chroot "$1" ssh-keygen -t "$type" \
                            -f "/etc/ssh/ssh_host_${type}_key" -N "" -q
                    done
                fi
                chroot "$1" sshd -t 2>&1 || {
                    echo "  WARNING: sshd -t failed — removing drop-ins"
                    rm -f "$1"/etc/ssh/sshd_config.d/*.conf
                }
                chroot "$1" systemctl is-enabled ssh.service >/dev/null 2>&1 \
                    || chroot "$1" systemctl enable ssh.service
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 26: FINAL CHECKPOINT — fail-fast artifact verification
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 26] CHECKPOINT — final artifact verification"
                FAIL=0
                check()   { [ -e "$1$2" ] && echo "  ✓ $2"              || { echo "  ✗ MISSING: $2";                FAIL=$((FAIL+1)); }; }
                check_x() { [ -x "$1$2" ] && echo "  ✓ $2 (executable)" || { echo "  ✗ NOT EXECUTABLE: $2";          FAIL=$((FAIL+1)); }; }

                # Playbill app
                check_x "$1" /opt/trailcurrent-playbill/trailcurrent-playbill
                check   "$1" /usr/share/applications/trailcurrent-playbill.desktop
                check   "$1" /usr/share/icons/hicolor/512x512/apps/trailcurrent-playbill.png

                # Branding
                check   "$1" /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth
                check   "$1" /usr/share/backgrounds/trailcurrent-playbill/wallpaper-light.png
                check   "$1" /usr/share/backgrounds/trailcurrent-playbill/wallpaper-dark.png
                check   "$1" /etc/dconf/db/local.d/00-trailcurrent-playbill
                check   "$1" /etc/dconf/db/local.d/locks/00-trailcurrent-playbill-locks
                check   "$1" /etc/dconf/profile/user

                # GDM-side branding (login screen)
                check   "$1" /etc/dconf/db/gdm.d/00-trailcurrent-playbill-gdm
                check   "$1" /etc/dconf/profile/gdm

                # GTK theme — full tree + system-wide override
                check   "$1" /etc/gtk-4.0/gtk.css
                check   "$1" /etc/gtk-3.0/gtk.css
                check   "$1" /usr/share/themes/TrailCurrent-Playbill/index.theme
                check   "$1" /usr/share/themes/TrailCurrent-Playbill/gtk-4.0/gtk.css
                check   "$1" /usr/share/themes/TrailCurrent-Playbill/gtk-3.0/gtk.css

                # apt pins
                check   "$1" /etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref
                check   "$1" /etc/apt/preferences.d/55-trailcurrent-playbill-no-firefox-shim.pref

                # WiFi DKMS bundle (Quectel FCU760K / AIC8800D80)
                if chroot "$1" dpkg -l aic8800-usb-dkms 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ aic8800-usb-dkms installed"
                else
                    echo "  ✗ aic8800-usb-dkms NOT installed (WiFi will not work)"
                    FAIL=$((FAIL+1))
                fi
                if chroot "$1" dpkg -l aic8800-firmware 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ aic8800-firmware installed"
                else
                    echo "  ✗ aic8800-firmware NOT installed"
                    FAIL=$((FAIL+1))
                fi
                # The DKMS module should have been built against the kernel
                # we just installed; the .ko lands under /lib/modules/<KVER>/updates/dkms/.
                if ls "$1"/lib/modules/*/updates/dkms/aic8800_fdrv.ko* 1>/dev/null 2>&1; then
                    echo "  ✓ aic8800_fdrv.ko built against installed kernel"
                else
                    echo "  ✗ aic8800_fdrv.ko NOT built (DKMS rebuild required at first boot)"
                    # Not a hard fail — first-boot DKMS retry can recover.
                fi

                # Firefox: snap-shim purged, firefox-esr installed
                if chroot "$1" dpkg -l firefox 2>/dev/null | grep -q "^ii"; then
                    echo "  ✗ firefox snap-shim still installed (will fail at launch)"
                    FAIL=$((FAIL+1))
                else
                    echo "  ✓ firefox snap-shim absent"
                fi
                if chroot "$1" dpkg -l firefox-esr 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ firefox-esr installed"
                else
                    echo "  ✗ firefox-esr NOT installed"
                    FAIL=$((FAIL+1))
                fi

                # Audio
                check   "$1" /etc/wireplumber/wireplumber.conf.d/50-playbill-default-sink.conf

                # Firstboot
                check_x "$1" /usr/local/sbin/trailcurrent-playbill-firstboot.sh
                check   "$1" /etc/systemd/system/trailcurrent-playbill-firstboot.service

                # System chrome
                check   "$1" /etc/modprobe.d/disable-unused.conf
                check   "$1" /etc/sysctl.d/90-trailcurrent-playbill.conf
                check   "$1" /etc/playbill-release
                check   "$1" /etc/ssh/ssh_host_ed25519_key

                # SSH wiring
                if [ -L "$1/etc/systemd/system/ssh.socket" ] && \
                   [ "$(readlink "$1/etc/systemd/system/ssh.socket")" = "/dev/null" ]; then
                    echo "  ✓ ssh.socket masked → /dev/null"
                else
                    echo "  ✗ ssh.socket NOT masked"
                    FAIL=$((FAIL+1))
                fi
                if [ ! -e "$1/etc/systemd/system/ssh.service.requires/ssh.socket" ]; then
                    echo "  ✓ ssh.service.requires/ssh.socket absent"
                else
                    echo "  ✗ ssh.service.requires/ssh.socket EXISTS"
                    FAIL=$((FAIL+1))
                fi

                # rsetup.service masked (otherwise SSH gets disabled on first boot)
                if [ -L "$1/etc/systemd/system/rsetup.service" ] && \
                   [ "$(readlink "$1/etc/systemd/system/rsetup.service")" = "/dev/null" ]; then
                    echo "  ✓ rsetup.service masked"
                else
                    echo "  ✗ rsetup.service NOT masked (will disable SSH on first boot)"
                    FAIL=$((FAIL+1))
                fi

                # NOPASSWD sudoers drop-in
                if [ -f "$1/etc/sudoers.d/010_trailcurrent-nopasswd" ]; then
                    echo "  ✓ sudoers NOPASSWD drop-in present"
                else
                    echo "  ✗ sudoers NOPASSWD drop-in missing"
                    FAIL=$((FAIL+1))
                fi

                # DT overlay staged + referenced by loader entry
                OVR="qcs6490-radxa-dragon-q6a-playbill-unused-pins-disable.dtbo"
                if ls "$1"/boot/efi/*/[0-9]*/dtbo/"$OVR" 1>/dev/null 2>&1; then
                    echo "  ✓ DT overlay staged: $OVR"
                else
                    echo "  ✗ DT overlay NOT staged: $OVR"
                    FAIL=$((FAIL+1))
                fi
                if grep -r --include='*.conf' -l "devicetree-overlay .*$OVR" \
                   "$1/boot/efi/loader/entries/" >/dev/null 2>&1; then
                    echo "  ✓ loader entry references $OVR"
                else
                    echo "  ✗ no loader entry references $OVR"
                    FAIL=$((FAIL+1))
                fi

                # Patched embloader installed
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                EXPECTED_SHA=$(cut -d' ' -f1 "$STAGING/files/embloader/embloader.efi.sha256" 2>/dev/null || echo "")
                for dest in \
                    "$1/boot/efi/EFI/BOOT/BOOTAA64.EFI" \
                    "$1/boot/efi/EFI/systemd/systemd-bootaa64.efi"
                do
                    if [ ! -f "$dest" ]; then
                        echo "  ✗ embloader missing: ${dest#$1}"
                        FAIL=$((FAIL+1))
                        continue
                    fi
                    if [ -z "$EXPECTED_SHA" ]; then
                        echo "  ! cannot verify ${dest#$1}: build-side sha256 missing"
                        continue
                    fi
                    GOT_SHA=$(sha256sum "$dest" | cut -d' ' -f1)
                    if [ "$GOT_SHA" = "$EXPECTED_SHA" ]; then
                        echo "  ✓ patched embloader: ${dest#$1}"
                    else
                        echo "  ✗ embloader sha256 mismatch at ${dest#$1}"
                        FAIL=$((FAIL+1))
                    fi
                done

                # Services enabled
                for svc in ssh NetworkManager gdm avahi-daemon trailcurrent-playbill-firstboot; do
                    if chroot "$1" systemctl is-enabled "$svc" >/dev/null 2>&1; then
                        echo "  ✓ $svc enabled"
                    else
                        echo "  ✗ NOT ENABLED: $svc"
                        FAIL=$((FAIL+1))
                    fi
                done

                if [ "$FAIL" -gt 0 ]; then
                    echo ""
                    echo "  ✗✗✗ Final checkpoint FAILED with $FAIL missing artifacts"
                    exit 1
                fi
                echo "  ✓ All artifacts present — image is ready"
            |||,
        ]
    },
    metadata: {
        architecture: architecture,
        mode: mode,
        rootfs: rootfs,
        variant: variant,

        temp_dir:  temp_dir,
        output_dir: output_dir,
        rsdk_rev:  rsdk_rev,

        distro_mirror:    distro_mirror,
        radxa_mirror:     radxa_mirror,
        radxa_repo_suffix: radxa_repo_suffix,

        product:    product,
        suite:      suite,
        edition:    edition,
        build_date: build_date,

        vendor_packages: vendor_packages,
        linux_override:  linux_override,
        firmware_override: firmware_override,
        install_vscodium: install_vscodium,
        use_pkgs_json:    use_pkgs_json,
        sdboot:           std.extVar("sdboot"),
    },
}
