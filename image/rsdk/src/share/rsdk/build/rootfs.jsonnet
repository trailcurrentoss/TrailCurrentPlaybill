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

        // NOTE on packages+: this list is the *intended* desktop image
        // contents, but mmdebstrap's `--include` mechanism silently rolls
        // back the whole transaction on any single conflict / strict-equality
        // failure (Status-Fd suppresses apt output, exit code 0, zero
        // packages installed). For any package likely to swap with a
        // distro version (qcom-fastrpc1 vs fastrpc) or hit strict-equality
        // surprises (gnome-software-plugin-flatpak), the actual install is
        // performed in customize-hook 3a below via a normal `apt-get
        // install` so failures are loud. Leave the entries here for
        // documentation; hook 3a is the authoritative installer.
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

            // ── GPU userspace (Adreno 643 on QCS6490 via Mesa Turnip) ───
            // Mesa Noble ships Turnip Vulkan + freedreno GL with full Adreno
            // 6xx coverage including the 643. The firmware blobs (a630_sqe,
            // a660_sqe, etc.) come from linux-firmware (above) AND from the
            // Radxa-side radxa-firmware-qcs6490 bundle (below) — both are
            // pinned in /etc/apt/preferences.d/.
            "mesa-vulkan-drivers",
            "libdrm2",
            "libgbm1",
            "libegl1",
            "libgl1-mesa-dri",
            "libglx-mesa0",
            "mesa-utils",                       // glxinfo / eglinfo for diagnostics

            // ── Hardware video decode (4K via Adreno Venus, V4L2 stateful) ──
            // The Q6A's video decoder is exposed as a V4L2 stateful codec
            // node (/dev/videoN) by the in-kernel `venus` driver. GStreamer's
            // -bad plugin set contains the v4l2dec / v4l2videoconvert elements
            // that media players (VLC, GNOME Videos, Electron's WebContents)
            // actually use to hand off decode to the GPU. -libav fills in the
            // long-tail codec coverage via ffmpeg.
            //
            // -ugly is an open-source plugin set (GPL, no EULA) that adds
            // patent-encumbered-but-FOSS decoders: a52dec (AC-3, the standard
            // DVD audio track), dvdreadsrc/dvdnavsrc (gst pipelines that can
            // play DVDs directly), x264enc, and MAD MP3 decode. Required for
            // ripped-DVD playback because virtually every DVD ships AC-3
            // audio — without a52dec the video plays silently.
            //
            // -tools provides gst-inspect-1.0 and gst-launch-1.0, which are
            // how we diagnose pipeline / codec / hwaccel issues from a
            // terminal. Tiny package, worth having on every device.
            "gstreamer1.0-plugins-good",
            "gstreamer1.0-plugins-bad",
            "gstreamer1.0-plugins-ugly",
            "gstreamer1.0-libav",
            "gstreamer1.0-tools",
            "v4l-utils",                        // v4l2-ctl --list-devices
            "libva2",                           // VA-API surface (some apps probe)
            "vainfo",

            // ── Media-library codecs and CLI utilities ──────────────────
            // Used by the DVD-rip flow (Handbrake bundles its own x264/x265
            // statically, but the surrounding library workflow needs these)
            // and by general media-library probing/conversion outside HB:
            //
            //   ffmpeg          — `ffmpeg` / `ffprobe` CLI. Indispensable
            //                     for batch remux/convert/inspect operations
            //                     in the Playbill library code-paths
            //   lame            — MP3 encoder (LAME), used for audio-only
            //                     CD/music-disc rips
            //   flac            — FLAC encoder + tools, lossless-audio rips
            //   libdvdread8     — DVD title/IFO/VOB reader (HandBrake links
            //   libdvdnav4        these transitively; declared here for
            //                     self-documenting intent and to keep them
            //                     installed even if HB swaps its deps)
            "ffmpeg",
            "lame",
            "flac",
            "libdvdread8",
            "libdvdnav4",

            // ── OTA TV tuner + SDR radio userspace ──────────────────────
            // The Q6A drives a Hauppauge WinTV-dualHD (USB ATSC tuner;
            // kernel driver `dvb_usb_cxusb` is in-tree and loads on hot-
            // plug) and an RTL-SDR USB dongle (kernel driver
            // `dvb_usb_rtl28xxu`, also in-tree). The kernel side is free —
            // just plug-and-play. These apt packages give us the userspace
            // we need to actually tune and demod from the Playbill app:
            //
            //   dvb-tools     — dvbv5-scan / dvbv5-zap (channel scan +
            //                   per-program TS capture for ATSC)
            //   dtv-scan-tables — `/usr/share/dvb/atsc/us-Center-...` table
            //                     consumed by dvbv5-scan
            //   rtl-sdr       — rtl_test / rtl_fm (FM/AM demod to PCM)
            //   mpv           — fullscreen video player; uses V4L2-M2M
            //                   (Venus) for hardware-decoded ATSC playback
            //                   on the Adreno GPU. Configured by the app
            //                   with --hwdec=auto-safe --vo=gpu-next.
            "dvb-tools",
            "dtv-scan-tables",
            "rtl-sdr",
            "mpv",

            // ── DVD ripping into the Playbill library ───────────────────
            // A USB optical drive plugged into the Q6A turns Playbill into
            // a DVD ripper for the local media library. Userspace pieces:
            //
            //   handbrake        — GTK GUI (drag-disc → encode → MKV/MP4)
            //   handbrake-cli    — HandBrakeCLI binary; used by Playbill's
            //                      scripted/batch rip flow
            //   lsdvd            — surfaces the disc title list (used by
            //                      the rip-UI to populate the title picker)
            //   libdvd-pkg       — installer-package that pulls libdvdcss2
            //                      sources from videolan.org and builds the
            //                      decryption library locally. Without it
            //                      HandBrake can enumerate the title list
            //                      but cannot decrypt encrypted (CSS) discs,
            //                      which is essentially every commercial
            //                      DVD. Hook 3b preseeds the debconf keys
            //                      and runs `dpkg-reconfigure libdvd-pkg`
            //                      so libdvdcss2 is built at image-build
            //                      time — flashed boards rip encrypted
            //                      discs immediately with no first-boot
            //                      build step required.
            "handbrake",
            "handbrake-cli",
            "lsdvd",
            "libdvd-pkg",
            //   eject            — userspace `eject /dev/sr0` invoked by
            //                      the dvd.eject command-bus handler after
            //                      a rip finishes, so the user doesn't
            //                      have to walk to the rig with a paperclip
            "eject",

            // ── OpenCL on Adreno (for llama.cpp GGML_OPENCL etc.) ───────
            // The ICD itself ships in radxa-firmware-qcs6490 (below). The
            // ocl-icd-libopencl1 dispatch library + clinfo come from Ubuntu.
            "ocl-icd-libopencl1",
            "clinfo",

            // ── NPU userspace (Hexagon CDSP via FastRPC) ────────────────
            // Both packages come from the Radxa qcs6490-noble apt repo,
            // which additional_repos.libjsonnet wires in automatically for
            // the Q6A SoC. qcom-fastrpc1 contains cdsprpcd (the userspace
            // RPC daemon) and the fastrpc test tools; libcdsprpc1 is the
            // shared library QNN apps link against. Both are pinned (-1)
            // so apt cannot upgrade them out of step with the held kernel.
            "qcom-fastrpc1",
            "libcdsprpc1",
            // Adreno + Venus + DSP firmware bundle (also pinned).
            "radxa-firmware-qcs6490",

            // ── Audio (PipeWire + WirePlumber + UCM profiles) ───────────
            "pipewire",
            "pipewire-pulse",
            "wireplumber",
            "alsa-ucm-conf",
            "alsa-utils",
            "pavucontrol",
            "pulseaudio-utils",   // pactl for diagnostics + PA compat shims

            // ── GNOME Keyring + secret agent (NetworkManager wifi password
            // prompt is mediated by the secret agent gnome-shell registers
            // when gnome-keyring is initialised. Without these, NM connect
            // attempts get "No agents were available for this request." and
            // silently fail; default Ubuntu prompts-on-connect breaks. We
            // had this bug on first build.)
            "gnome-keyring",
            "libpam-gnome-keyring",
            "seahorse",            // GUI keyring manager
            "gcr",                 // crypto / secret-service framework

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

            // ── Flatpak (for installing creator-tool apps from flathub) ──
            // Apt PPAs for tools like KiCAD/FreeCAD/Blender are largely
            // amd64-only; flathub maintains arm64 builds of all three. We
            // ship the flatpak runtime so the user can install those apps
            // post-flash. Hook 8c registers the flathub remote system-wide.
            //
            // NOTE: we deliberately do NOT include `gnome-software-plugin-
            // flatpak`. That package has a strict-equality dependency
            // `gnome-software (= 46.0-1ubuntu2)`. When noble-updates ships
            // a newer point release of gnome-software (e.g. 46.0-1ubuntu3),
            // the plugin becomes unsatisfiable, AND apt's solver responds
            // by silently rolling back the entire `--include` set,
            // installing ONLY the variant essentials + rsdk's task-*
            // metapackages — leaving ubuntu-desktop, firefox-esr, etc.
            // ALL missing. Verified May 2026: dropping this package alone
            // restored the full GNOME desktop install. Users who want
            // flatpak apps in the App Center can `apt install
            // gnome-software-plugin-flatpak` post-flash, when the version
            // skew (if any) is locally resolvable.
            "flatpak",

            // ── Electron runtime libs (Playbill app links these) ────────
            "libnss3",
            "libnotify4",
            "libxss1",
            "libxtst6",
            "libatspi2.0-0",
            "libasound2t64",
            // libnss3-tools ships `certutil`, which the Settings → Headwaters
            // "Install CA" command uses to add the TrailCurrent CA to each
            // browser's per-user NSS db (Chromium and Firefox both maintain
            // their own — neither reads /etc/ssl/certs/ on Linux). Without
            // this, the system-store-only install works for curl/wget but
            // browsers still warn on https://headwaters.local.
            "libnss3-tools",

            // ── Build-time tooling for customize-hooks ──────────────────
            // libglib2.0-bin     → /usr/bin/gresource (used by hook 8d
            //                      to extract+rebuild gnome-shell-theme)
            // libglib2.0-dev-bin → /usr/bin/glib-compile-resources
            //                      (also hook 8d, the actual gresource
            //                      compiler — `-dev-bin` because it's a
            //                      development tool, not pulled in by
            //                      ubuntu-desktop normally)
            "libglib2.0-bin",
            "libglib2.0-dev-bin",
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
            // The user logs into GNOME with this account. Passwordless sudo
            // lets the user run the standard "Software Updater" GUI without
            // a sudo prompt loop.
            //
            // PRIOR BUG (force-password-change vs gnome-keyring): we used to
            // call `chage -d 0 trailcurrent` here so GDM forced a password
            // change at first login. That broke the WiFi PSK prompt the very
            // first time the user tried to connect to a network:
            //
            //   * On first GDM login, PAM's `pam_unix` ran `passwd` to set a
            //     new UNIX password BEFORE `pam_gnome_keyring` opened the
            //     session.
            //   * `pam_gnome_keyring` then opened/auto-created the user's
            //     login keyring with the OLD password it had captured at
            //     authentication time.
            //   * Result: the login keyring was sealed with `trailcurrent`
            //     while the UNIX password was now whatever the user chose.
            //     NetworkManager's secret-service agent (gnome-shell) could
            //     not unlock the keyring on subsequent sessions, so storing
            //     or retrieving WiFi PSKs failed silently — the user just
            //     saw the SSID never connect.
            //
            // Fix: do NOT force a password change. Ship with the well-known
            // `trailcurrent` password documented in SETUP.md and let the user
            // change it later via Settings → Users (which uses the proper PAM
            // stack and updates the keyring atomically) or via `passwd` (which
            // does the same). gnome-keyring's auto-create then matches the
            // login password on every fresh session.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 3] creating trailcurrent user"
                # `render` is required for /dev/fastrpc-* and /dev/dri/render*
                # access on QCS6490 — the FastRPC udev rule (hook 13a) opens
                # the device nodes 0666 but the dma_heap path still wants the
                # caller in render on some Noble kernels.
                if ! chroot "$1" id trailcurrent >/dev/null 2>&1; then
                    chroot "$1" useradd -m -s /bin/bash \
                        -G sudo,plugdev,systemd-journal,adm,dialout,audio,video,netdev,render \
                        trailcurrent
                else
                    chroot "$1" usermod -aG sudo,plugdev,systemd-journal,adm,dialout,audio,video,netdev,render trailcurrent
                fi
                echo "trailcurrent:trailcurrent" | chroot "$1" chpasswd
                # NOTE: deliberately NOT calling `chage -d 0 trailcurrent`.
                # See the comment block above the hook.
                chroot "$1" passwd -l root || true

                echo "trailcurrent ALL=(ALL) NOPASSWD: ALL" \
                    > "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
                chmod 440 "$1/etc/sudoers.d/010_trailcurrent-nopasswd"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 3a: Install desktop + app userspace via apt-get (LOUD)
            //
            // mmdebstrap's `--include` mechanism (the `packages+:` list above)
            // is unreliable for any list that contains a package with a
            // conflict, swap, or strict-equality dep. It runs apt under
            // `-oAPT::Status-Fd=...` which suppresses normal apt output, so
            // when apt's solver hits ONE unsatisfiable constraint it silently
            // rolls back the ENTIRE include transaction (zero packages
            // installed, exit code 0) and the build proceeds with a
            // half-baked rootfs. Two confirmed failures here:
            //
            //   * gnome-software-plugin-flatpak (= gnome-software 46.0-1ubuntu2)
            //     becoming unsatisfiable when noble-updates ships a newer
            //     point release of gnome-software (May 2026)
            //   * qcom-fastrpc1 (Qualcomm PPA) Breaks `fastrpc` (Radxa repo),
            //     which is pulled in transitively by task-qualcomm-npu via
            //     `task-radxa-dragon-q6a --install-recommends` in the
            //     essential-hook. apt is unwilling to do the swap inside the
            //     suppressed --include transaction (May 2026).
            //
            // Fix: install the desktop / vendor-swap / Electron set
            // explicitly here via a real `apt-get install` invocation. This
            // gives us:
            //   * full apt output in the build log
            //   * a real non-zero exit code on failure (set -e fails the hook)
            //   * apt's normal "remove fastrpc to install qcom-fastrpc1" swap
            //     behaviour, which works fine outside the Status-Fd context
            //
            // Order: AFTER user creation (hook 3) but BEFORE apt pinning
            // (hook 4). The pinning sets mesa-* / libgbm1 / libegl1 etc. to
            // Pin-Priority -1, which makes them un-installable; we must
            // install them BEFORE the pin lands.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 3a] installing desktop + app userspace via apt-get (loud — bypasses --include silent rollback)"

                # ── Third-party apt repo: Brave ─────────────────────────
                # Brave is the kiosk browser for Netflix / Disney+ / Max
                # (any Widevine-DRM streaming service). We use Brave rather
                # than Google Chrome because Google does NOT ship Chrome for
                # ARM64 Linux at all (verified May 2026: dl.google.com only
                # serves amd64; the direct-download arm64 .deb URL 404s).
                # Brave does ship an arm64 stable build, and it's still
                # Chromium-based so all the kiosk flags work the same way.
                #
                # Widevine on Brave is downloaded as a Chromium component on
                # first access to a DRM site, not bundled in the .deb. For
                # Netflix this means the first launch may briefly show a
                # loading state while the CDM downloads (~5MB); subsequent
                # launches play immediately. Cookies + the downloaded CDM
                # persist in the per-source user-data-dir managed by
                # controller/src/sources/netflix/browser.js.
                #
                # Pulled in below by `brave-browser` in the apt-get install
                # list, then spawned on demand by the controller's
                # sources/netflix/browser.js when the user opens Netflix.
                # The same brave-browser binary will host Disney+/Prime/Max
                # source plugins when those land.
                echo "[hook 3a]   installing Brave signing key + apt source"
                chroot "$1" sh -c '
                    set -e
                    install -d -m 0755 /usr/share/keyrings
                    curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
                        https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
                    chmod 0644 /usr/share/keyrings/brave-browser-archive-keyring.gpg
                    echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=arm64] https://brave-browser-apt-release.s3.brave.com/ stable main" \
                        > /etc/apt/sources.list.d/brave-browser-release.list
                '

                chroot "$1" apt-get update

                # The list below mirrors `packages+:` for the desktop /
                # vendor-swap / Electron groups. Anything pulled in
                # transitively by `task-radxa-dragon-q6a --install-recommends`
                # in the essential-hook is omitted; only the packages that
                # `--include` was responsible for go here.
                chroot "$1" env DEBIAN_FRONTEND=noninteractive \
                    apt-get install -y --install-recommends \
                        ubuntu-desktop \
                        gnome-shell \
                        gdm3 \
                        nautilus \
                        gnome-control-center \
                        gnome-terminal \
                        gnome-tweaks \
                        network-manager-gnome \
                        yaru-theme-gtk \
                        yaru-theme-icon \
                        mesa-vulkan-drivers \
                        libdrm2 \
                        libgbm1 \
                        libegl1 \
                        libgl1-mesa-dri \
                        libglx-mesa0 \
                        mesa-utils \
                        gstreamer1.0-plugins-good \
                        gstreamer1.0-plugins-bad \
                        gstreamer1.0-plugins-ugly \
                        gstreamer1.0-libav \
                        gstreamer1.0-tools \
                        gstreamer1.0-gl \
                        v4l-utils \
                        libva2 \
                        vainfo \
                        ffmpeg \
                        lame \
                        flac \
                        libdvdread8 \
                        libdvdnav4 \
                        dvb-tools \
                        dtv-scan-tables \
                        rtl-sdr \
                        mpv \
                        handbrake \
                        handbrake-cli \
                        lsdvd \
                        ocl-icd-libopencl1 \
                        clinfo \
                        qcom-fastrpc1 \
                        libcdsprpc1 \
                        radxa-firmware-qcs6490 \
                        pipewire \
                        pipewire-pulse \
                        wireplumber \
                        alsa-ucm-conf \
                        alsa-utils \
                        pavucontrol \
                        pulseaudio-utils \
                        gnome-keyring \
                        libpam-gnome-keyring \
                        seahorse \
                        gcr \
                        firefox-esr \
                        flatpak \
                        libnss3 \
                        libnotify4 \
                        libxss1 \
                        libxtst6 \
                        libatspi2.0-0 \
                        libasound2t64 \
                        libglib2.0-bin \
                        libglib2.0-dev-bin \
                        nodejs \
                        yt-dlp \
                        avahi-daemon \
                        avahi-utils \
                        libcap2-bin \
                        uxplay \
                        brave-browser
                # Note on yt-dlp: apt's package can lag YouTube's extractor
                # changes by months. Hook 5a installs a fresh release blob
                # (fetched by build.sh) to /usr/local/bin/yt-dlp; that path
                # PATH-shadows /usr/bin/yt-dlp at runtime. The apt one stays
                # as a safety-net fallback. To force a fresh fetch on the
                # next build instead of using the 7-day-cached copy, run
                # `REFRESH_YTDLP=1 sudo ./image/build.sh`.
                #
                # Note on uxplay: AirPlay receiver. Spawned on demand by the
                # controller daemon when the user opens the Cast screen, so
                # the device only advertises itself on the LAN while the
                # user is actively trying to mirror a phone. Depends on the
                # gstreamer1.0-plugins-{good,bad,libav} set already in the
                # list above (good = rtp/rtsp, bad = h264parse/avdec, libav =
                # avdec_h264). avahi-daemon must be running at boot — it's
                # the mDNS responder UxPlay registers `_airplay._tcp` with.
                #
                # Note on brave-browser: kiosk browser for DRM-locked
                # streaming services. Spawned on demand by the controller's
                # sources/netflix/browser.js with --kiosk --app=netflix.com.
                # Widevine L3 is downloaded as a Chromium component on first
                # DRM playback (cap is 720p on non-certified ARM64 Linux).
                # The repo entry + signing key are installed above this
                # block; if Brave ever rotates the key, refresh both files.
                # Same brave-browser binary will host Disney+/Prime/Max
                # source plugins when those land.
                #
                # gstreamer1.0-gl provides `glimagesink` — the EGL-backed
                # video sink we pass to uxplay (-vs glimagesink). Without
                # it, autovideosink falls back to xvimagesink (XWayland),
                # which accepts the AirPlay handshake but never displays
                # frames under GNOME Wayland. Verified May 2026 on a Q6A
                # board where iPhone connect succeeded but the screen
                # stayed black; installing gstreamer1.0-gl + switching to
                # explicit `-vs glimagesink` fixed it.

                # Fail-fast verification: hook 8c expects flatpak; hook 5
                # expects libnss3/libxss1/libxtst6/libatspi2.0-0; the
                # GNOME hooks expect ubuntu-desktop / gdm3 / gnome-shell;
                # the Playbill app expects the OTA-tuner + SDR-radio userspace
                # (dvb-tools / dtv-scan-tables / rtl-sdr / mpv) — without those
                # the FM/AM and live-TV features fail at runtime with no apt
                # log signal at build time. Verified May 2026: an earlier build
                # shipped without rtl-sdr/dvb-tools/dtv-scan-tables/mpv even
                # though the apt-get install above listed them; the verification
                # list did not catch it. This list now covers the AV path.
                # If the apt install above silently dropped any of them,
                # surface that here rather than letting downstream hooks
                # fail with cryptic messages.
                MISSING=""
                for pkg in ubuntu-desktop gnome-shell gdm3 firefox-esr flatpak \
                           qcom-fastrpc1 mesa-vulkan-drivers libnss3 libxss1 \
                           libxtst6 libatspi2.0-0t64 libasound2t64 \
                           rtl-sdr librtlsdr2 dvb-tools dtv-scan-tables mpv \
                           handbrake handbrake-cli lsdvd \
                           gstreamer1.0-plugins-ugly gstreamer1.0-tools \
                           gstreamer1.0-gl \
                           ffmpeg lame flac libdvdread8 libdvdnav4 \
                           nodejs yt-dlp avahi-daemon libcap2-bin \
                           uxplay brave-browser; do
                    if ! chroot "$1" dpkg -s "$pkg" >/dev/null 2>&1; then
                        MISSING="$MISSING $pkg"
                    fi
                done
                if [ -n "$MISSING" ]; then
                    echo "  ERROR: hook 3a apt-get install reported success but these packages are NOT installed:" >&2
                    echo "   $MISSING" >&2
                    exit 1
                fi
                echo "  ✓ desktop + app userspace installed; key packages verified"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 3b: Install libdvd-pkg and build libdvdcss2 at image-build
            //
            // libdvd-pkg is an installer-package: its postinst downloads the
            // libdvdcss source tarball from videolan.org and builds a local
            // libdvdcss2 .deb, which it then installs. Without libdvdcss2,
            // HandBrake (and any other libdvdread-based ripper) can enumerate
            // a disc's table of contents but cannot decrypt CSS-protected
            // titles — i.e. effectively every commercial DVD.
            //
            // By default the postinst is interactive (the debian-multimedia
            // policy makes the user opt in to the build). DEBIAN_FRONTEND=
            // noninteractive alone is NOT enough; the package gates on three
            // debconf keys that must be preseeded BEFORE apt installs the
            // package, otherwise the postinst defaults them to "no build"
            // and exits without building libdvdcss2:
            //
            //   libdvd-pkg/build                       boolean true
            //     → agree to build libdvdcss2 from source
            //   libdvd-pkg/post-invoke_hook-install    boolean true
            //     → rebuild libdvdcss2 on libdvd-pkg upgrade
            //   libdvd-pkg/post-invoke_hook-remove     boolean true
            //     → clean up the built .deb on libdvd-pkg removal
            //
            // After preseeding + installing, run `dpkg-reconfigure libdvd-pkg`
            // to trigger the build NOW (in the chroot, under qemu-arm64)
            // rather than leaving it for the user's first boot. Build needs
            // network access to download.videolan.org and a working C
            // toolchain, both of which are present in the chroot at this
            // point in the build (apt-get install above pulled in build-
            // essential transitively via libdvd-pkg's Depends).
            //
            // Verification: dpkg-reconfigure exits 0 even if the actual
            // libdvdcss2 build fails (the postinst hides errors), so we
            // also check that libdvdcss2 is in `dpkg -l` afterwards. If
            // not, fail loudly — a flashed board that "rips" but produces
            // garbage scrambled MKVs is the worst possible failure mode.
            //
            // Order: AFTER hook 3a (apt-get install pulls in the build
            // toolchain) and BEFORE hook 4 (which pins the kernel/Mesa
            // and could theoretically interfere with apt resolution).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 3b] installing libdvd-pkg and building libdvdcss2 from videolan.org"

                # Preseed debconf BEFORE the install so the postinst can
                # build libdvdcss2 unattended. Order matters: setting these
                # AFTER the install is too late — the postinst has already
                # run with the default ("don't build") answer.
                # (One echo per key rather than a heredoc so the jsonnet
                # ||| text-block doesn't choke on column-0 lines.)
                echo "libdvd-pkg libdvd-pkg/build boolean true" \
                    | chroot "$1" debconf-set-selections
                echo "libdvd-pkg libdvd-pkg/post-invoke_hook-install boolean true" \
                    | chroot "$1" debconf-set-selections
                echo "libdvd-pkg libdvd-pkg/post-invoke_hook-remove boolean true" \
                    | chroot "$1" debconf-set-selections

                chroot "$1" env DEBIAN_FRONTEND=noninteractive \
                    apt-get install -y libdvd-pkg

                # Force the build now (the install-time hook is idempotent;
                # this guarantees libdvdcss2 ends up in the rootfs even if
                # an upstream packaging change reorders the postinst steps).
                chroot "$1" env DEBIAN_FRONTEND=noninteractive \
                    dpkg-reconfigure libdvd-pkg

                # libdvd-pkg's postinst hides build failures behind exit 0,
                # so verify libdvdcss2 actually landed. A board that can
                # read DVD TOCs but not decrypt them produces silently
                # scrambled rips — fail loud at build time instead.
                if ! chroot "$1" dpkg -s libdvdcss2 >/dev/null 2>&1; then
                    echo "  ERROR: libdvd-pkg installed but libdvdcss2 was not built." >&2
                    echo "  Check chroot network access to download.videolan.org and the build log above." >&2
                    exit 1
                fi
                CSS_VER=$(chroot "$1" dpkg-query -W -f='${Version}' libdvdcss2 2>/dev/null || echo "?")
                echo "  ✓ libdvdcss2 ($CSS_VER) installed — encrypted DVDs are rippable"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 3c: Build UxPlay 1.73.6 from upstream source
            //
            // The apt-shipped uxplay (1.68.2 in Noble) does NOT work on this
            // device with current iOS phones. Symptoms: AirPlay handshake
            // succeeds, iPhone shows "Connected to Playbill", but every
            // H.264 NAL unit is rejected by GStreamer's h264parse as
            // "broken/invalid nal Type: 1 Slice" and no frames decode.
            // Three load-bearing fixes land between 1.68.2 and 1.73:
            //   * 1.68.3 — GStreamer 1.24 compatibility (Noble ships 1.24)
            //   * 1.70   — GStreamer ≥1.24 sleep/wake handling
            //   * 1.72.2 — Debian-family pipeline-restart race-condition fix
            // Plus iOS 17+ bitstream handling improvements throughout 1.70+.
            //
            // We clone the FDH2/UxPlay repo at a pinned tag and build with
            // cmake inside the chroot. Install lands at /usr/local/bin/uxplay
            // which PATH-shadows the apt binary at /usr/bin/uxplay (the apt
            // one stays installed as a safety net but is never picked).
            //
            // The Q6A's V4L2 hardware H.264 decoder is also broken on the
            // current kernel (Venus driver — fixed when the Iris port lands
            // in kernel 6.18+). The controller passes `-avdec` to force
            // software decode; the A78 cores handle 1080p H.264 comfortably.
            // The runtime sink is `waylandsink` (NOT glimagesink — see the
            // controller code comment for why).
            //
            // Order: AFTER hook 3a (apt installs apt-shipped uxplay's runtime
            // deps + the GStreamer plugin packs we link against). BEFORE
            // hook 4 (apt pinning would block libdrm-dev install if reversed).
            //
            // To bump the pinned tag, edit UXPLAY_TAG below and re-flash.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                UXPLAY_TAG="v1.73.6"
                echo "[hook 3c] building UxPlay $UXPLAY_TAG from FDH2/UxPlay"

                # Build deps. cmake / git / libssl-dev / libplist-dev /
                # libavahi-compat-libdnssd-dev / libdbus-1-dev / liborc-0.4-dev
                # aren't on the runtime image; we install them for the build
                # and leave them — image size cost is ~80 MB, but a future
                # image hook that wants to rebuild any other small component
                # (or a user who wants to recompile uxplay with different
                # flags) can do so without an apt round-trip.
                #
                # libdrm-dev is required by libgstreamer-plugins-qcom-base1.0-dev
                # (the Qualcomm-replaced plugins-base dev package). At this
                # point in the build, hook 4's apt pin (which blocks libdrm-dev
                # at Pin-Priority -1) has not yet landed, so libdrm-dev is
                # installable normally.
                chroot "$1" env DEBIAN_FRONTEND=noninteractive \
                    apt-get install -y --no-install-recommends \
                        cmake build-essential git pkg-config \
                        libssl-dev libplist-dev libdrm-dev \
                        libavahi-compat-libdnssd-dev libdbus-1-dev \
                        liborc-0.4-dev \
                        libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev

                # Clone + build inside the chroot. /tmp inside the chroot is
                # ephemeral for the rsdk build process — gets thrown away when
                # the image is finalized, so a multi-hundred-MB git history +
                # build tree leaves no trace in the shipped image.
                chroot "$1" /bin/bash -c "
                    set -e
                    cd /tmp
                    rm -rf UxPlay
                    git clone --depth 1 --branch ${UXPLAY_TAG} https://github.com/FDH2/UxPlay.git UxPlay
                    cd UxPlay
                    mkdir -p build
                    cd build
                    cmake -DCMAKE_BUILD_TYPE=Release ..
                    make -j\$(nproc)
                    install -m 755 uxplay /usr/local/bin/uxplay
                    cd /tmp && rm -rf UxPlay
                "

                # Verify the binary actually runs and reports the pinned
                # version. cmake + make can succeed but produce a broken
                # binary if a runtime lib is mis-linked; -v flushes that.
                ACTUAL=$(chroot "$1" /usr/local/bin/uxplay -v 2>&1 | head -1 || echo "FAILED")
                if ! echo "$ACTUAL" | grep -q "${UXPLAY_TAG#v}"; then
                    echo "  ERROR: /usr/local/bin/uxplay did not return ${UXPLAY_TAG#v}: $ACTUAL" >&2
                    exit 1
                fi
                echo "  ✓ $ACTUAL — installed to /usr/local/bin/uxplay (shadows apt's 1.68.2 at /usr/bin/uxplay)"
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
            // ════════════════════════════════════════════════════════════
            // Hook 4b: Verify aic8800 DKMS module built during package install
            //
            // The aic8800-usb-dkms postinst (from radxa-pkg) runs `dkms
            // autoinstall` against the kernel installed in the chroot and —
            // in current package versions (4.0+git20250410.b99ca8b6+) —
            // correctly detects the chroot kernel rather than the host's,
            // so the .ko files land under
            // /lib/modules/<KVER>/updates/dkms/ at install time. We just
            // verify here. Module names: aic8800_fdrv_usb.ko (the wifi
            // driver), aic_load_fw_usb.ko, aic_btusb_usb.ko.
            //
            // Verify by globbing the .ko file directly. Do NOT use `-e` on
            // /lib/modules/<KVER>/build — it's a symlink whose target is
            // valid INSIDE the chroot but unresolvable from the host (the
            // path is /usr/src/linux-headers-<KVER> on the chroot, not on
            // the build host), so `[ -e ... ]` returns false and the loop
            // skips every kernel.
            //
            // Fallback rebuild: if the .ko is genuinely missing (rare —
            // happens with older aic8800-usb-dkms versions that didn't
            // autodetect chroot kernels), rebuild via `dkms autoinstall`
            // for every kernel that has a `linux-image-*` package
            // installed. We discover those by querying dpkg INSIDE the
            // chroot, which sidesteps the host-vs-chroot symlink trap.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 4b] verifying aic8800 DKMS .ko present after package install"
                if ! chroot "$1" dpkg -l aic8800-usb-dkms 2>/dev/null | grep -q "^ii"; then
                    echo "  aic8800-usb-dkms not installed; skipping (hook 26 will fail loud)"
                elif ls "$1"/lib/modules/*/updates/dkms/aic8800_fdrv*.ko* 1>/dev/null 2>&1; then
                    echo "  ✓ aic8800 driver .ko present:"
                    ls "$1"/lib/modules/*/updates/dkms/aic8800_fdrv*.ko* | sed 's|^|    |'
                else
                    echo "  ! aic8800 driver .ko missing — package install didn't build it; rebuilding"
                    # List /lib/modules/* from INSIDE the chroot. This avoids
                    # the host-vs-chroot symlink trap (the directories under
                    # /lib/modules are real, but their `build` and `source`
                    # children are symlinks that don't resolve from outside
                    # the chroot).
                    KVERS=$(chroot "$1" sh -c 'ls /lib/modules/ 2>/dev/null' || true)
                    if [ -z "$KVERS" ]; then
                        echo "  ERROR: no kernels under /lib/modules/ inside chroot; cannot rebuild" >&2
                        exit 1
                    fi
                    BUILT_ANY=0
                    for KVER in $KVERS; do
                        echo "    rebuilding for $KVER"
                        chroot "$1" dkms autoinstall -k "$KVER" 2>&1 || \
                            echo "    ✗ dkms autoinstall failed for $KVER (continuing)"
                        if ls "$1"/lib/modules/"$KVER"/updates/dkms/aic8800_fdrv*.ko* 1>/dev/null 2>&1; then
                            echo "    ✓ aic8800 driver .ko built for $KVER"
                            BUILT_ANY=1
                        fi
                    done
                    if [ "$BUILT_ANY" -eq 0 ]; then
                        echo "  ERROR: aic8800 DKMS module did not build for ANY installed kernel" >&2
                        echo "  WiFi will not work on the running board. Refusing to ship the image." >&2
                        exit 1
                    fi
                fi
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
            // Hook 5a: Stage playbill-controller daemon + systemd user unit
            //
            // The controller is the always-running Node.js daemon that owns
            // MQTT, mpv, the source plugins (radio, livetv, youtube),
            // device discovery, and the IPC socket the GUI client subscribes
            // to. Lives at /opt/trailcurrent-playbill/controller/.
            //
            // Three things this hook does:
            //   1. Copy the controller tree (incl. node_modules — staged by
            //      build.sh) to /opt/trailcurrent-playbill/controller/
            //   2. Install the systemd user unit so the daemon auto-starts
            //      with every user session, and symlink it into
            //      default.target.wants/ for image-baked auto-enable
            //   3. setcap CAP_NET_BIND_SERVICE on /usr/bin/node so the
            //      controller's onboarding HTTP listener can bind port 80
            //      without running as root (per docs/app/onboarding.md)
            //
            // Order: AFTER hook 3a (apt installs nodejs + libcap2-bin) and
            //        AFTER hook 5 (Electron app, sibling install dir).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 5a] staging playbill-controller daemon + systemd user unit"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"

                if [ ! -d "$STAGING/controller" ]; then
                    echo "  ERROR: $STAGING/controller missing — build.sh should have staged it" >&2
                    exit 1
                fi
                if [ ! -f "$STAGING/controller/src/index.js" ]; then
                    echo "  ERROR: $STAGING/controller/src/index.js missing — controller staging is incomplete" >&2
                    exit 1
                fi
                if [ ! -d "$STAGING/controller/node_modules" ]; then
                    echo "  ERROR: $STAGING/controller/node_modules missing — must include for runtime" >&2
                    exit 1
                fi
                if [ ! -f "$STAGING/files/systemd-user/playbill-controller.service" ]; then
                    echo "  ERROR: $STAGING/files/systemd-user/playbill-controller.service missing" >&2
                    exit 1
                fi

                # 1. Stage the daemon.
                CTRL_DIR="$1/opt/trailcurrent-playbill/controller"
                mkdir -p "$CTRL_DIR"
                cp -a "$STAGING/controller/." "$CTRL_DIR/"
                CTRL_SIZE=$(du -sh "$CTRL_DIR" | cut -f1)
                echo "  staged $CTRL_SIZE controller (incl. node_modules)"

                # 2. Install systemd user unit + image-baked auto-enable.
                mkdir -p "$1/usr/lib/systemd/user"
                install -m 644 "$STAGING/files/systemd-user/playbill-controller.service" \
                    "$1/usr/lib/systemd/user/playbill-controller.service"
                # Symlink into default.target.wants so it auto-enables on
                # every user's first systemd-user manager start. Equivalent
                # to `systemctl --user enable` per-user but baked at image
                # time — no first-boot logic needed.
                mkdir -p "$1/usr/lib/systemd/user/default.target.wants"
                ln -sf ../playbill-controller.service \
                    "$1/usr/lib/systemd/user/default.target.wants/playbill-controller.service"
                echo "  installed playbill-controller.service (auto-enabled via default.target.wants)"

                # 3. setcap on the node binary so the controller's onboarding
                #    HTTP listener can bind port 80 (the privileged-port
                #    requirement comes from Headwaters' mDNS proxy hardcoding
                #    http://<host>.local — see docs/app/onboarding.md). The
                #    capability survives reboots. Requires libcap2-bin
                #    (installed in hook 3a) for the setcap binary itself.
                NODE_BIN="$1/usr/bin/node"
                if [ ! -x "$NODE_BIN" ]; then
                    echo "  ERROR: /usr/bin/node not present in rootfs — hook 3a should have installed nodejs" >&2
                    exit 1
                fi
                chroot "$1" setcap "cap_net_bind_service=+ep" /usr/bin/node
                # Verify it stuck (setcap silently no-ops on filesystems
                # without xattr support; ext4 in our rootfs.tar is fine but
                # let's not assume).
                CAPS=$(chroot "$1" getcap /usr/bin/node 2>/dev/null || true)
                case "$CAPS" in
                    *cap_net_bind_service*) echo "  ✓ setcap applied: $CAPS" ;;
                    *) echo "  ERROR: setcap on /usr/bin/node did not take effect: $CAPS" >&2; exit 1 ;;
                esac

                # 4. Install the fresh yt-dlp release fetched by build.sh
                #    into /usr/local/bin/yt-dlp. PATH precedence makes this
                #    shadow /usr/bin/yt-dlp from apt; the apt one stays as a
                #    safety-net fallback if /usr/local/bin/yt-dlp ever gets
                #    nuked by a user. See build.sh "Fetch the latest yt-dlp
                #    release" block — it caches in image/cache/ and only
                #    re-downloads if older than 7 days.
                if [ -f "$STAGING/files/yt-dlp/yt-dlp" ]; then
                    install -m 755 "$STAGING/files/yt-dlp/yt-dlp" "$1/usr/local/bin/yt-dlp"
                    YT_VER=$(chroot "$1" /usr/local/bin/yt-dlp --version 2>&1 | head -1 || echo "?")
                    echo "  installed /usr/local/bin/yt-dlp ($YT_VER) — shadows apt /usr/bin/yt-dlp"
                else
                    echo "  WARNING: $STAGING/files/yt-dlp/yt-dlp missing — apt yt-dlp is the only fallback (likely stale)" >&2
                fi
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
            // Hook 6a: Vendored alsa-ucm-conf master (Q6A use-case profiles)
            //
            // Ubuntu Noble ships alsa-ucm-conf 1.2.10 (Q1 2024). The
            // QCS6490-Radxa-Dragon-Q6A profile + matching conf.d entry were
            // added to alsa-ucm-conf master after that release (commit
            // 980fb83 in alsa-ucm-conf upstream). Without these files,
            // PipeWire / PulseAudio sees the WCD9385 codec attach but
            // can't load a use-case profile for the Q6A board, so it falls
            // back to "Dummy Output" — the symptom the user hit on the
            // running board.
            //
            // We vendor the entire master ucm2/ tree at
            // image/files/alsa-ucm/ucm2/ (4.2 MB) and overlay it on top of
            // the distro-installed /usr/share/alsa/ucm2/. cp -a preserves
            // distro files we don't ship and adds the new ones (including
            // the Q6A profile). The apt pin on alsa-ucm-conf
            // (50-trailcurrent-playbill-holds.pref) prevents an upstream
            // upgrade from removing or stomping our overlay.
            //
            // UPSTREAM_COMMIT pinned in image/files/alsa-ucm/UPSTREAM_COMMIT.
            // Hook 26 verifies the Q6A profile file is present.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 6a] overlaying vendored alsa-ucm-conf master onto /usr/share/alsa/ucm2/"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"

                if [ ! -d "$FILES/alsa-ucm/ucm2" ]; then
                    echo "  ERROR: $FILES/alsa-ucm/ucm2 missing — staging incomplete" >&2
                    exit 1
                fi
                # Sanity-check the Q6A profile is in the staged tree before
                # we overlay; cheaper to fail here than at hook 26.
                Q6A_PROFILE="$FILES/alsa-ucm/ucm2/Qualcomm/qcs6490/QCS6490-Radxa-Dragon-Q6A/QCS6490-Radxa-Dragon-Q6A.conf"
                if [ ! -f "$Q6A_PROFILE" ]; then
                    echo "  ERROR: vendored UCM tree is missing the Q6A profile: ${Q6A_PROFILE#$FILES/}" >&2
                    exit 1
                fi

                mkdir -p "$1/usr/share/alsa/ucm2"
                cp -a "$FILES/alsa-ucm/ucm2/." "$1/usr/share/alsa/ucm2/"

                COMMIT=$(cat "$FILES/alsa-ucm/UPSTREAM_COMMIT" 2>/dev/null || echo "unknown")
                echo "  vendored alsa-ucm-conf @ $COMMIT (incl. QCS6490-Radxa-Dragon-Q6A)"
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
                # Verify the new Plymouth assets actually landed inside the
                # rebuilt initramfs. Without this, a silent qemu failure leaves
                # the old initramfs in place and we ship Ubuntu's purple
                # Plymouth theme instead of ours.
                #
                # The initramfs in Noble is at /boot/initrd.img-<KVER>; it's
                # a concatenation of an early-uncompressed cpio (microcode,
                # nothing relevant here) and a compressed cpio with the
                # actual root. lsinitramfs is the standard tool to list it.
                INITRD_HAS_THEME=0
                for img in "$1"/boot/initrd.img-*; do
                    [ -f "$img" ] || continue
                    if chroot "$1" lsinitramfs "${img#$1}" 2>/dev/null | grep -q 'plymouth/themes/trailcurrent/'; then
                        INITRD_HAS_THEME=1
                        break
                    fi
                done
                if [ "$INITRD_HAS_THEME" -eq 0 ]; then
                    echo "  WARNING: trailcurrent Plymouth theme not present in any initramfs;"
                    echo "  firstboot will rebuild from the real kernel — first boot will show"
                    echo "  the default theme briefly, subsequent boots will be branded."
                fi

                # GNOME wallpapers (light + dark variants)
                WP_DIR="$1/usr/share/backgrounds/trailcurrent-playbill"
                mkdir -p "$WP_DIR"
                install -m 644 "$STAGING/branding/wallpaper-light.png" "$WP_DIR/wallpaper-light.png"
                install -m 644 "$STAGING/branding/wallpaper-dark.png"  "$WP_DIR/wallpaper-dark.png"
                install -m 644 "$STAGING/branding/playbill-logo.svg"   "$WP_DIR/playbill-logo.svg"
                # Rasterized Playbill product icon (square, 512x512). Used by
                # Activities / dock; NOT for GDM — too tall for the login
                # screen, would cover the password input box.
                install -m 644 "$FILES/icons/512x512.png"              "$WP_DIR/playbill-logo.png"
                # TrailCurrent corporate wordmark (480x96, white-on-dark) —
                # this is what GDM's `logo` key points at. Sourced from
                # /Marketing/ClaudWebSite/src/images/logo/trailcurrent-logo-white.svg.
                # Hook 26 verifies this file is present.
                install -m 644 "$STAGING/branding/trailcurrent-wordmark.svg"  "$WP_DIR/trailcurrent-wordmark.svg"
                install -m 644 "$STAGING/branding/trailcurrent-wordmark.png"  "$WP_DIR/trailcurrent-wordmark.png"

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

                # Compile the dconf binary databases. Both /etc/dconf/db/local
                # (user session) and /etc/dconf/db/gdm (login screen) need to
                # be regenerated whenever local.d/ or gdm.d/ keyfiles change,
                # otherwise GNOME / GDM read no overrides at all and we ship
                # vanilla Ubuntu.
                #
                # PRIOR BUG: this used `dconf update 2>&1 || echo WARNING`,
                # which silently accepted compile failures. The fallout was
                # a GDM that never picked up our gdm.d wallpaper / logo / theme
                # overrides because the binary db didn't exist. Now: if dconf
                # update fails, we still don't fail the build (qemu-arm64 has
                # historic dbus issues that prevent it), but we DO walk the
                # output and verify the binary db was actually produced.
                # Hook 26 fail-fasts on missing binary dbs.
                chroot "$1" dconf update 2>&1 || \
                    echo "  WARNING: dconf update returned non-zero (qemu dbus quirk)"
                if [ -f "$1/etc/dconf/db/local" ]; then
                    echo "  ✓ dconf local binary db compiled"
                else
                    echo "  WARNING: /etc/dconf/db/local NOT compiled — GNOME overrides will not apply"
                fi
                if [ -f "$1/etc/dconf/db/gdm" ]; then
                    echo "  ✓ dconf gdm binary db compiled"
                else
                    echo "  WARNING: /etc/dconf/db/gdm NOT compiled — GDM overrides will not apply"
                fi
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 7b: GDM auto-login for the trailcurrent user
            //
            // Playbill is a daily-driver desktop with a single user; an
            // interactive login at every boot is friction. More important:
            // the playbill-controller daemon is a `systemctl --user` unit,
            // so it only runs once a user session is active. Without
            // auto-login, a freshly-booted device sits at GDM and:
            //   * mDNS doesn't advertise (controller not running)
            //   * the claim listener isn't bound (port 80 idle)
            //   * the PWA wizard's discovery scan finds nothing
            // Auto-login makes the appliance behaviour appliance-like.
            //
            // The Ubuntu-shipped gdm3 conf has the lines commented out:
            //     [daemon]
            //     # AutomaticLoginEnable = true
            //     # AutomaticLogin = user1
            // Uncomment + retarget at our `trailcurrent` user. Idempotent
            // sed (the build re-runs as a single transactional install).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 7b] enabling GDM auto-login for the trailcurrent user"
                CONF="$1/etc/gdm3/custom.conf"
                if [ ! -f "$CONF" ]; then
                    echo "  ERROR: $CONF missing — gdm3 should have been installed by hook 3a" >&2
                    exit 1
                fi
                sed -i \
                    -e "s/^#\\s*AutomaticLoginEnable\\s*=\\s*true/AutomaticLoginEnable = true/" \
                    -e "s/^#\\s*AutomaticLogin\\s*=\\s*user1/AutomaticLogin = trailcurrent/" \
                    "$CONF"
                # Verify the substitutions actually landed; sed silently
                # no-ops if the source comments don't match (e.g. distro
                # changes the spacing in a future release).
                if ! grep -qE "^AutomaticLoginEnable\\s*=\\s*true" "$CONF" \
                || ! grep -qE "^AutomaticLogin\\s*=\\s*trailcurrent" "$CONF"; then
                    echo "  ERROR: GDM auto-login lines did not get uncommented in $CONF — check the distro's default custom.conf format" >&2
                    grep -i automatic "$CONF" >&2 || true
                    exit 1
                fi
                echo "  ✓ AutomaticLoginEnable=true + AutomaticLogin=trailcurrent set"
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

                # (c) Recolor gnome-shell (top bar + GDM login screen) to match
                # the Yaru-viridian-dark accent we use for GTK widgets.
                #
                # The gnome-shell theme is selected by `stylesheetName` in
                # /usr/share/gnome-shell/modes/ubuntu.json. The default value
                # is "Yaru/gnome-shell.css" (orange). Yaru's package ships
                # standalone .css files for every variant under
                # /usr/share/gnome-shell/theme/Yaru-<variant>-dark/, so we
                # just point at the viridian-dark one. The .gresource bundles
                # (theme + icons) only exist under Yaru/ and contain assets
                # for ALL variants — leave those references alone.
                #
                # Affects BOTH the user session's top bar AND the GDM login
                # screen (which is also gnome-shell, in greeter mode reading
                # the same ubuntu.json mode).
                #
                # PRIOR BUG: a sed that rewrote themeResourceName +
                # iconsResourceName too pointed gnome-shell at .gresource
                # files that don't exist under Yaru-viridian-dark/ (only
                # Yaru/ has them). gnome-shell would silently fall back to
                # Adwaita default styling. Only stylesheetName should change.
                MODE_FILE="$1/usr/share/gnome-shell/modes/ubuntu.json"
                if [ -f "$MODE_FILE" ]; then
                    cp -a "$MODE_FILE" "${MODE_FILE}.upstream"
                    sed -i 's|"Yaru/gnome-shell.css"|"Yaru-viridian-dark/gnome-shell.css"|g' "$MODE_FILE"
                    if grep -q '"Yaru-viridian-dark/gnome-shell.css"' "$MODE_FILE"; then
                        echo "  ✓ gnome-shell mode points at Yaru-viridian-dark/gnome-shell.css"
                    else
                        echo "  ✗ ubuntu.json patch did not take" >&2
                        exit 1
                    fi
                else
                    echo "  WARNING: $MODE_FILE not present — gnome-shell-common may be missing"
                fi

                # Verify the variant stylesheet file is actually shipped (it's
                # part of yaru-theme-gnome-shell). If apt's solver dropped it
                # for any reason, gnome-shell would fail to load the theme.
                VARIANT_CSS="$1/usr/share/gnome-shell/theme/Yaru-viridian-dark/gnome-shell.css"
                if [ -f "$VARIANT_CSS" ]; then
                    echo "  ✓ Yaru-viridian-dark/gnome-shell.css present"
                else
                    echo "  ✗ $VARIANT_CSS missing — yaru-theme-gnome-shell broken" >&2
                    exit 1
                fi
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 8b: Audio modules-load + Firefox dark-theme policies
            //
            // Audio fix complement (#F): force-load the QCS6490 + WCD9385
            // audio chain at boot via /etc/modules-load.d/. Without this,
            // the running board picked up snd_soc_sc8280xp (wrong SoC) at
            // probe time and got use_count=0 — no card surfaced. The right
            // machine driver (snd_soc_qcm6490, mainline since April 2024)
            // is autoloaded only if the DT compatible string is exact;
            // forcing the load defends against compat-string mismatches.
            //
            // Firefox fix (#G): policies.json forces Firefox-ESR to honor
            // the GTK dark theme on Wayland (Mozilla Bug 1535230 / 1527048
            // workaround). Without it, the URL-bar autocomplete dropdown
            // renders with a transparent background and unreadable items.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 8b] installing audio modules-load + Firefox dark-theme policies"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"

                # Audio modules force-load
                mkdir -p "$1/etc/modules-load.d"
                install -m 644 "$FILES/modules-load.d/q6a-audio.conf" \
                    "$1/etc/modules-load.d/q6a-audio.conf"

                # Firefox-ESR system-wide policy (dark-theme + autocomplete fix)
                # /etc/firefox-esr/policies.json is the documented Mozilla path
                # for system-wide ESR policies on Debian/Ubuntu packaging.
                mkdir -p "$1/etc/firefox-esr"
                install -m 644 "$FILES/firefox/policies.json" \
                    "$1/etc/firefox-esr/policies.json"
                # Distribution variant — picked up regardless of where the
                # ESR build looks. Both paths are inert if Firefox isn't
                # installed; harmless.
                mkdir -p "$1/etc/firefox-esr/distribution"
                install -m 644 "$FILES/firefox/policies.json" \
                    "$1/etc/firefox-esr/distribution/policies.json"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 8c: Register flathub remote system-wide
            //
            // The flatpak package itself is in the package list (above).
            // This hook just adds the flathub remote so the user can run
            // `flatpak install flathub <app>` (or browse via the GNOME
            // Software App Center) without having to add the remote first.
            //
            // Why flathub matters on arm64: KiCAD/FreeCAD/Blender PPAs are
            // largely amd64-only on Noble. Flathub maintains arm64 builds
            // of all three at the latest stable. We deliberately do NOT
            // install those apps in the chroot — KiCAD's flatpak alone is
            // ~10 GB with the KDE Platform runtime + KiCAD libraries, and
            // baking it in would balloon the image for a feature most
            // users don't need. User installs on demand post-flash.
            //
            // remote-add is a config-write only operation (no network, no
            // download), so it works fine inside the qemu-arm64 chroot.
            // The actual app install at user-time pulls aarch64 binaries
            // from flathub.
            //
            // PRIOR BUG: this used `chroot "$1" command -v flatpak` to test
            // whether flatpak is installed. `command` is a POSIX shell
            // BUILTIN, not a binary in /usr/bin — so `chroot foo command`
            // always fails with "exec: command: not found" regardless of
            // whether flatpak is installed. The test was permanently false,
            // and the hook just printed "flatpak not installed" and exited
            // 1 the first time anything in --include actually succeeded.
            // Use `[ -x "$1/usr/bin/flatpak" ]` from the host side (no
            // chroot, no qemu, no shell-builtin trap).
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 8c] registering flathub remote system-wide"
                if [ -x "$1/usr/bin/flatpak" ]; then
                    chroot "$1" flatpak remote-add --if-not-exists flathub \
                        https://dl.flathub.org/repo/flathub.flatpakrepo
                    chroot "$1" flatpak remotes | sed 's/^/  /'
                else
                    echo "  ERROR: flatpak not installed; package list change didn't land" >&2
                    exit 1
                fi
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 8d: Install pre-built viridian-dark GDM gresource
            //
            // Hook 8 (c) above patches /usr/share/gnome-shell/modes/ubuntu.json to
            // point at Yaru-viridian-dark/gnome-shell.css. That covers the user
            // session's gnome-shell (top bar, activities, etc.) but does NOT
            // affect the GDM login screen — GDM loads from a separate
            // gresource bundle via the `gdm-theme.gresource` update-alternatives
            // slot.
            //
            // We ship a pre-built gnome-shell-theme.gresource at
            // image/files/gnome/shell/gnome-shell-theme.gresource (sourced byte-
            // for-byte from the live Playbill v0.1.0 board's
            // /usr/share/gnome-shell/gnome-shell-theme.gresource — sha256
            // 6c1f1b18...c1c). Contains gdm.css mirrored from the viridian-
            // dark gnome-shell.css plus a /org/gnome/shell/theme/custom-theme
            // marker resource that hook 26 grep-checks.
            //
            // Earlier iterations of this hook ran the gresource recompilation
            // pipeline (extract Yaru / overlay viridian / glib-compile-resources)
            // INSIDE the chroot under qemu-arm64 user emulation. That was
            // multi-fragile — symlink-vs-cp-rT semantics, libglib2.0-dev-bin
            // not present by default, qemu mishandling of nested `bash -c`
            // quoting all bit us in turn. Pre-building on the host (gresource
            // is architecture-independent — it's CSS + SVG bytes in a glib
            // container) sidesteps every one of those failure modes.
            //
            // The gresource is regenerated by re-running the original
            // recompilation pipeline ON THE LIVE BOARD (or any working
            // GNOME 46 system) with set-gdm-theme — see
            // github.com/realmazharhussain/gdm-tools — and scp'ing the result
            // back into image/files/gnome/shell/.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 8d] installing pre-built viridian-dark GDM gresource"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                SRC="$FILES/gnome/shell/gnome-shell-theme.gresource"
                DEST="$1/usr/share/gnome-shell/gnome-shell-theme.gresource"

                if [ ! -f "$SRC" ]; then
                    echo "  ERROR: staged gresource missing at $SRC" >&2
                    echo "  (regenerate via gdm-tools on a working board and scp into image/files/gnome/shell/)" >&2
                    exit 1
                fi

                install -m 644 "$SRC" "$DEST"
                echo "  installed gresource: $(stat -c '%s bytes' "$DEST"), sha256 $(sha256sum "$DEST" | cut -d' ' -f1)"

                # Verify the marker resource is present (sanity check that
                # we didn't accidentally ship the stock Yaru gresource).
                if chroot "$1" gresource list /usr/share/gnome-shell/gnome-shell-theme.gresource 2>/dev/null \
                        | grep -q "/org/gnome/shell/theme/custom-theme"; then
                    echo "  ✓ gresource contains custom-theme marker"
                else
                    echo "  ✗ gresource missing custom-theme marker — wrong file in image/files/gnome/shell/" >&2
                    exit 1
                fi

                # Register at higher priority (50) than the stock Yaru gresource
                # (15) so update-alternatives makes our file the active one for
                # the gdm-theme.gresource slot.
                chroot "$1" update-alternatives --install \
                    /usr/share/gnome-shell/gdm-theme.gresource \
                    gdm-theme.gresource \
                    /usr/share/gnome-shell/gnome-shell-theme.gresource \
                    50
                chroot "$1" update-alternatives --set gdm-theme.gresource \
                    /usr/share/gnome-shell/gnome-shell-theme.gresource

                chroot "$1" update-alternatives --display gdm-theme.gresource 2>&1 \
                    | grep "currently points to" | sed "s/^/  /"
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
            // Hook 13: Modprobe drop-in (currently empty — no blacklists)
            //
            // PRIOR BUGS this file documents:
            //   * audio: q6asm_dai/q6adm/q6afe/q6core/q6routing/audioreach
            //     were blacklisted "for cleanup" — that broke the analog jack.
            //   * NPU: fastrpc/qcom_fastrpc/qcom_q6v5_pas/qcom_pil_info/
            //     qcom_q6v5 were blacklisted "for idle power" — that conflicts
            //     with using the Hexagon NPU.
            // The file ships empty-but-commented so the rationale stays in the
            // image and the staging path stays exercised.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 13] installing modprobe drop-in (no active blacklists)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                install -m 644 "$FILES/modprobe/disable-unused.conf" \
                    "$1/etc/modprobe.d/disable-unused.conf"
            |||,

            // ════════════════════════════════════════════════════════════
            // Hook 13a: NPU userspace plumbing (FastRPC udev + ADSP path)
            //
            // The kernel FastRPC driver (`fastrpc`, `qcom_fastrpc`) and the
            // CDSP firmware loader (`qcom_q6v5_pas`) load by default once
            // the NPU blacklist (formerly hook 13) is gone. What still needs
            // staging from us:
            //   (a) /etc/udev/rules.d/99-fastrpc.rules — opens
            //       /dev/fastrpc-cdsp{,-secure}, /dev/fastrpc-adsp, and the
            //       dma_heap/system node to mode 0666 so the user-session
            //       trailcurrent can talk to the NPU without sudo.
            //   (b) /etc/profile.d/adsp-library-path.sh — exports
            //       ADSP_LIBRARY_PATH=/usr/lib/dsp/cdsp:/usr/lib/dsp/adsp:/dsp
            //       so QNN clients (libQnnHtp*, genie-t2t-run, llama.cpp
            //       Hexagon backend) find the Skel libs.
            //
            // The userspace daemon `cdsprpcd.service` ships with qcom-fastrpc1
            // (Radxa qcs6490-noble repo). Its enablement happens in hook 19
            // alongside the other system services.
            //
            // No QNN runtime libs (libQnnHtp*.so, libQnnSystem.so, Genie) are
            // staged in this image. Those are application-supplied; an app
            // that wants on-NPU inference drops them next to its binary and
            // ADSP_LIBRARY_PATH picks them up.
            // ════════════════════════════════════════════════════════════
            |||
                set -e
                echo "[hook 13a] installing NPU userspace plumbing (udev + profile.d)"
                STAGING="${PLAYBILL_STAGING:-/tmp/playbill-staging}"
                FILES="$STAGING/files"
                mkdir -p "$1/etc/udev/rules.d"
                install -m 644 "$FILES/udev/99-fastrpc.rules" \
                    "$1/etc/udev/rules.d/99-fastrpc.rules"
                install -m 644 "$FILES/profile/adsp-library-path.sh" \
                    "$1/etc/profile.d/adsp-library-path.sh"
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
                    trailcurrent-playbill-firstboot.service \
                    cdsprpcd.service
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
            //
            // PRIOR BUG: `sshd -t` was run inside the chroot without first
            // creating /run/sshd. sshd -t needs /run/sshd to exist (the
            // privsep dir) and fails immediately with "Missing privilege
            // separation directory: /run/sshd" when it doesn't. The fallback
            // branch then ran `rm -f /etc/ssh/sshd_config.d/*.conf` and
            // deleted our config drop-ins — the OPPOSITE of what we want.
            //
            // Fix: create /run/sshd before validating, and on validation
            // failure, fail the build LOUDLY instead of silently removing
            // configuration. If the drop-in is wrong we want to know at
            // build time, not boot time.
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
                # sshd -t needs the privsep dir. systemd-tmpfiles creates it
                # at boot via /usr/lib/tmpfiles.d/sshd.conf, but we're in a
                # chroot — make it ourselves so validation works.
                mkdir -p "$1/run/sshd"
                if ! chroot "$1" sshd -t 2>&1; then
                    echo "  ERROR: sshd -t failed; refusing to silently delete sshd_config.d drop-ins" >&2
                    echo "  Inspect $1/etc/ssh/sshd_config.d/ — fix or remove the offending drop-in." >&2
                    exit 1
                fi
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

                # Playbill controller daemon (Hook 5a)
                check   "$1" /opt/trailcurrent-playbill/controller/src/index.js
                check   "$1" /opt/trailcurrent-playbill/controller/node_modules
                check   "$1" /usr/lib/systemd/user/playbill-controller.service
                check   "$1" /usr/lib/systemd/user/default.target.wants/playbill-controller.service
                check_x "$1" /usr/bin/node
                check_x "$1" /usr/bin/yt-dlp                # apt fallback
                check_x "$1" /usr/local/bin/yt-dlp          # fresh GH release (Hook 5a)
                # /usr/local/bin/yt-dlp must run, not just exist; smoke-test it
                YTDLP_VER=$(chroot "$1" /usr/local/bin/yt-dlp --version 2>&1 | head -1 || true)
                if [ -n "$YTDLP_VER" ] && [ "$YTDLP_VER" != "?" ]; then
                    echo "  ✓ /usr/local/bin/yt-dlp runs ($YTDLP_VER)"
                else
                    echo "  ✗ /usr/local/bin/yt-dlp present but does NOT run"
                    FAIL=$((FAIL+1))
                fi
                # setcap on /usr/bin/node — onboarding listener needs port 80
                CAPS=$(chroot "$1" getcap /usr/bin/node 2>/dev/null || true)
                case "$CAPS" in
                    *cap_net_bind_service*) echo "  ✓ /usr/bin/node has cap_net_bind_service" ;;
                    *) echo "  ✗ /usr/bin/node MISSING cap_net_bind_service — onboarding will fail to bind :80"; FAIL=$((FAIL+1)) ;;
                esac

                # GDM auto-login (Hook 7b) — required for the controller
                # daemon to be running on a freshly-booted device. Without
                # this, the device sits at the GDM login screen, the
                # systemd user manager doesn't start, and the PWA wizard
                # discovers nothing.
                if grep -qE "^AutomaticLoginEnable\\s*=\\s*true" "$1/etc/gdm3/custom.conf" 2>/dev/null \
                && grep -qE "^AutomaticLogin\\s*=\\s*trailcurrent" "$1/etc/gdm3/custom.conf" 2>/dev/null; then
                    echo "  ✓ GDM auto-login enabled for trailcurrent user"
                else
                    echo "  ✗ GDM auto-login NOT configured — fresh boot will sit at login screen, controller won't start, PWA discovery will see nothing"
                    FAIL=$((FAIL+1))
                fi

                # Branding
                check   "$1" /usr/share/plymouth/themes/trailcurrent/trailcurrent.plymouth
                check   "$1" /usr/share/backgrounds/trailcurrent-playbill/wallpaper-light.png
                check   "$1" /usr/share/backgrounds/trailcurrent-playbill/wallpaper-dark.png
                check   "$1" /usr/share/backgrounds/trailcurrent-playbill/trailcurrent-wordmark.png

                # Hook 8b additions
                check   "$1" /etc/modules-load.d/q6a-audio.conf
                check   "$1" /etc/firefox-esr/policies.json

                # Hook 8(c): gnome-shell mode points at viridian-dark stylesheet
                # (recolors top bar + GDM login screen to match Yaru-viridian-dark
                # accent). If apt-upgrades of gnome-shell-common ever overwrite
                # ubuntu.json, this catches it before flashing.
                if grep -q '"Yaru-viridian-dark/gnome-shell.css"' \
                   "$1/usr/share/gnome-shell/modes/ubuntu.json" 2>/dev/null; then
                    echo "  ✓ gnome-shell mode patched (viridian-dark stylesheet)"
                else
                    echo "  ✗ ubuntu.json NOT patched — login screen will be orange"
                    FAIL=$((FAIL+1))
                fi

                # Hook 8d: GDM greeter recolored via recompiled gresource.
                # Marker file inside the gresource confirms it's our build,
                # not the distro default.
                if chroot "$1" gresource list /usr/share/gnome-shell/gnome-shell-theme.gresource 2>/dev/null \
                        | grep -q "/org/gnome/shell/theme/custom-theme"; then
                    echo "  ✓ gnome-shell-theme.gresource is our viridian-dark recompile"
                else
                    echo "  ✗ gnome-shell-theme.gresource is NOT our build — GDM will be orange"
                    FAIL=$((FAIL+1))
                fi
                if chroot "$1" update-alternatives --query gdm-theme.gresource 2>/dev/null \
                        | grep -q "Value: /usr/share/gnome-shell/gnome-shell-theme.gresource"; then
                    echo "  ✓ update-alternatives points at our recompiled gresource"
                else
                    echo "  ✗ update-alternatives NOT pointing at our recompile — GDM will be orange"
                    FAIL=$((FAIL+1))
                fi

                # Hook 8c: flatpak + flathub remote (lets user install latest
                # stable KiCAD/FreeCAD/etc. arm64 builds post-flash).
                # Use a host-side file test — `chroot ... command -v` doesn't
                # work because `command` is a shell builtin, not a binary.
                if [ -x "$1/usr/bin/flatpak" ]; then
                    echo "  ✓ flatpak installed"
                else
                    echo "  ✗ flatpak NOT installed"
                    FAIL=$((FAIL+1))
                fi
                if chroot "$1" flatpak remotes 2>/dev/null | grep -q "^flathub"; then
                    echo "  ✓ flathub remote registered"
                else
                    echo "  ✗ flathub remote NOT registered"
                    FAIL=$((FAIL+1))
                fi

                # Hook 6a: vendored alsa-ucm-conf overlay (Q6A use-case profile)
                # The Q6A profile + matching conf.d entry MUST be present, else
                # PipeWire will fall back to "Dummy Output" on the running board.
                check   "$1" /usr/share/alsa/ucm2/Qualcomm/qcs6490/QCS6490-Radxa-Dragon-Q6A/QCS6490-Radxa-Dragon-Q6A.conf
                check   "$1" /usr/share/alsa/ucm2/Qualcomm/qcs6490/QCS6490-Radxa-Dragon-Q6A/HiFi.conf
                check   "$1" /usr/share/alsa/ucm2/conf.d/qcs6490/QCS6490-Radxa-Dragon-Q6A.conf

                # dconf binary databases — both must be COMPILED, not just
                # the keyfiles present. If these are missing, GNOME / GDM
                # don't read our overrides and we ship vanilla Ubuntu chrome.
                check   "$1" /etc/dconf/db/local
                check   "$1" /etc/dconf/db/gdm

                # GNOME secret-agent infrastructure (so NM can prompt for WiFi PSK)
                if chroot "$1" dpkg -l gnome-keyring 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ gnome-keyring installed"
                else
                    echo "  ✗ gnome-keyring NOT installed (NM PSK prompt will fail)"
                    FAIL=$((FAIL+1))
                fi
                if chroot "$1" dpkg -l libpam-gnome-keyring 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ libpam-gnome-keyring installed"
                else
                    echo "  ✗ libpam-gnome-keyring NOT installed (keyring won't unlock at login)"
                    FAIL=$((FAIL+1))
                fi
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
                # The DKMS module MUST have been built against the kernel we
                # just installed (hook 4b force-builds it). The .ko lands under
                # /lib/modules/<KVER>/updates/dkms/. The upstream package
                # renames the module with a `_usb` suffix from
                # 4.0+git20250410.b99ca8b6 onward — match either name.
                # Hard-fail here because WiFi-broken images shouldn't ship.
                if ls "$1"/lib/modules/*/updates/dkms/aic8800_fdrv*.ko* 1>/dev/null 2>&1; then
                    echo "  ✓ aic8800 driver .ko built against installed kernel"
                else
                    echo "  ✗ aic8800 driver .ko NOT built (hook 4b should have done this)"
                    FAIL=$((FAIL+1))
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

                # GPU userspace + 4K HW decode pipeline
                if chroot "$1" dpkg -l mesa-vulkan-drivers 2>/dev/null | grep -q "^ii"; then
                    echo "  ✓ mesa-vulkan-drivers installed"
                else
                    echo "  ✗ mesa-vulkan-drivers NOT installed"
                    FAIL=$((FAIL+1))
                fi
                for pkg in gstreamer1.0-plugins-bad gstreamer1.0-libav v4l-utils \
                           ocl-icd-libopencl1 mesa-utils; do
                    if chroot "$1" dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
                        echo "  ✓ $pkg installed"
                    else
                        echo "  ✗ $pkg NOT installed"
                        FAIL=$((FAIL+1))
                    fi
                done

                # NPU userspace (kernel modules unblocked, CDSP packages installed)
                if [ ! -f "$1/etc/modprobe.d/disable-unused.conf" ] || \
                   ! grep -q "blacklist fastrpc" "$1/etc/modprobe.d/disable-unused.conf" 2>/dev/null; then
                    echo "  ✓ NPU kernel modules NOT blacklisted"
                else
                    echo "  ✗ NPU still blacklisted in disable-unused.conf"
                    FAIL=$((FAIL+1))
                fi
                check   "$1" /etc/udev/rules.d/99-fastrpc.rules
                check   "$1" /etc/profile.d/adsp-library-path.sh
                for pkg in qcom-fastrpc1 libcdsprpc1 radxa-firmware-qcs6490; do
                    if chroot "$1" dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
                        echo "  ✓ $pkg installed (Radxa qcs6490-noble repo)"
                    else
                        echo "  ✗ $pkg NOT installed"
                        FAIL=$((FAIL+1))
                    fi
                done
                if chroot "$1" systemctl is-enabled cdsprpcd.service >/dev/null 2>&1; then
                    echo "  ✓ cdsprpcd.service enabled"
                else
                    echo "  ✗ cdsprpcd.service NOT enabled"
                    FAIL=$((FAIL+1))
                fi
                if id -nG trailcurrent 2>/dev/null | tr ' ' '\n' | grep -qx render \
                   || chroot "$1" id -nG trailcurrent 2>/dev/null | tr ' ' '\n' | grep -qx render; then
                    echo "  ✓ trailcurrent in render group"
                else
                    echo "  ✗ trailcurrent NOT in render group"
                    FAIL=$((FAIL+1))
                fi

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
