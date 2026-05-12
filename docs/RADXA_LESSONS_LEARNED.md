# Radxa Dragon Q6A — Lessons Learned

A working knowledge base of everything we've discovered building TrailCurrent Playbill on the Radxa Dragon Q6A. Written for future agents and humans who land on this repo and need to know what we already chased down (and what's been ruled out) before they start their own investigation.

Last meaningful update: Stage 1 first-boot debugging, May 2026.

## TL;DR — what to know before you start

- **It's a Qualcomm secure-boot board.** The bootloader chain is `xbl.elf → tz → hyp → embloader (sdboot fork) → kernel`. Everything before embloader is signed by Qualcomm/Radxa and unmodifiable.
- **It's NOT an off-the-shelf Linux SBC.** Every layer has Q6A-specific quirks. Don't assume Raspberry Pi-style "drop in mainline Ubuntu" works.
- **Use `rsdk-build` (Radxa SDK), not Armbian or stock Ubuntu installers.** rsdk produces an image whose kernel + DT overlays + bootloader patches all match this hardware.
- **Pin the kernel + WiFi DKMS + Mesa + linux-firmware as one bundle.** Updating any one without the others breaks something. See [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md).

## Hardware overview (verified against [the schematic v1.21](radxa_dragon_q6a_schematic_v1.21.pdf))

| Subsystem | Chip / module | How it's wired | Linux driver |
|---|---|---|---|
| SoC | Qualcomm **QCS6490** (octa-core ARM, Adreno A660 GPU, Hexagon DSP NPU) | — | Radxa vendor kernel `linux-image-*-qcom` |
| RAM | LPDDR5 32-bit, 315-ball | EBI0 / EBI1 | — |
| Storage | eMMC + UFS module slot, plus M.2 M-Key 2230 (PCIe Gen 3 ×2) for NVMe, plus microSD (TF slot) on SDIO 3.1 | — | — |
| Display | DP 2-lane → RA620 → HDMI; 4-lane MIPI DSI for an LCD panel | Direct DP from QCS6490 | `msm_dpu` / `msm_dsi` |
| Audio codec | **WCD9385** (Qualcomm) | SoundWire `SWR_TX/RX` to QCS6490 | `snd_soc_wcd938x` + `q6asm_dai`/`q6adm`/`q6afe`/`q6core`/`q6routing`/`audioreach` (DO NOT BLACKLIST these) |
| Audio out | 3.5 mm headphone jack from WCD9385's HP pins | Analog | ALSA card name: `QCS6490RadxaDra [QCS6490-Radxa-Dragon-Q6A]`; jack is `aplay -Dhw:0,1` |
| Microphones | MIC array from WCD9385 | Analog | Same card, capture device 2 |
| **WiFi + BT** | **Quectel FCU760K** module (**AIC8800D80** chipset, AICSemi) | **USB 2.0** via FE1.1S hub | **`aic8800-usb-dkms` + `aic8800-firmware`** from Radxa's apt repo. NOT ath11k. NOT in-tree. |
| Ethernet | Realtek **RTL111K** (1000M) | PCIe Gen 3 ×1 | `r8169` (in-tree) |
| USB | Type-C with CC controller (CH224D), USB 3.0×1, USB 2.0×3 | — | xHCI |
| Cameras | 3× CSI (2-lane + 2-lane + 4-lane) | — | `camss` |
| GPIO header | 40-pin 2.54 mm, SPI/GPIO/I2C, PCM/I2S, UART debug, NFC, MICROUSB | — | `pinctrl-qcom` |
| Power | 12 V in via Type-C, regulated to 5 V/4.2 V via PM7250/PM7325/PM7350C PMICs | — | — |

## Boot chain quirks

### The "Radxa logo" you see at power-on is unreplaceable
Embedded inside Qualcomm-signed firmware (`xbl.elf` / `imagefv.elf`) in the SPI NOR. Modifying invalidates the secure-boot chain and the board refuses to boot. The CM5 (Broadcom + U-Boot) IS replaceable; the Q6A (Qualcomm secure boot) is NOT. **Don't waste cycles trying.** Once the kernel hands off to userspace, Plymouth takes over and the rest of boot can be branded.

### Pre-Plymouth boot menu trap (mandatory fix)
Stock embloader 0.4 polls `gST->ConIn` during the autoboot window even at `timeout 0`. The Q6A's debug-UART RX (`gpio23`, header pin 10) floats; EMI from any installed HAT (or just nearby SPI clocks) capacitively couples enough noise for the SoC's UART block to decode phantom serial bytes. Those phantom bytes are read as keystrokes and trap the user at the boot menu.

**The fix is mandatory and non-optional.** Patched embloader at [`image/embloader/patches/0001-playbill-autoboot-on-timeout-zero.patch`](../image/embloader/patches/0001-playbill-autoboot-on-timeout-zero.patch). The patch short-circuits the menu when `timeout == 0`, never touching ConIn. Built by [`build-embloader.sh`](../image/embloader/build-embloader.sh) and installed by hook 23 in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) over both `/EFI/BOOT/BOOTAA64.EFI` and `/EFI/systemd/systemd-bootaa64.efi`.

### `rsetup.service` will silently disable SSH on first boot
Radxa ships `rsetup-config-first-boot` which auto-mounts a `/config` partition (separate from rootfs), reads `/config/before.txt`, and calls `disable_service ssh`. It also creates an unwanted `radxa` user (UID 1001) and may rename your hostname.

**Mitigations** (all in our [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet)):
- Hook 2: `apt-get remove -y --purge rsetup-config-first-boot`
- Hook 14: `systemctl mask rsetup.service config.automount`

You need BOTH. Purging the package alone is insufficient because `rsetup.service` is a separate package that comes via core Radxa deps, and it auto-mounts `/config` regardless of what's installed.

### `ssh.socket` masking trap
Ubuntu Noble's `openssh-server` postinst creates `/etc/systemd/system/ssh.service.requires/ssh.socket`. `systemctl mask ssh.socket` creates the socket → /dev/null symlink but does NOT remove the .requires/ symlink. At boot, systemd sees `ssh.service` requires the masked socket, refuses to start `ssh.service` entirely, and SSH is unreachable.

**Fix is a 3-step dance, all required:**
```
systemctl disable ssh.socket
systemctl mask    ssh.socket
rm -f /etc/systemd/system/ssh.service.requires/ssh.socket
```
Implemented in hook 19 of [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet). Iterated to death on Peregrine. Do NOT collapse these three steps.

### `bootctl install` writes `timeout 3` by default
Even without phantom UART input, a 3-second wait at every boot is unacceptable for an entertainment center. Hook 22 in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) overwrites `loader.conf` with `timeout 0`, `editor no`, `auto-firmware no`. To enter the menu for recovery, hold space during the brief autoboot window.

### Sector size matters and is easy to get wrong
Build with `--sector-size 512` by default (consumer NVMe). Some enterprise NVMe drives use 4096. Mismatched sector size = board drops to **UEFI Shell>** prompt at boot with no explanation. If you change the sector size, delete the cached `build-image` script (not just `output.img`) — there's hidden state.

## Network / WiFi (this one bit us hardest)

### The chip is FCU760K, NOT ath11k WCN6855
The presence of `/lib/firmware/ath11k/WCN6855/` on a freshly flashed image is a **red herring** — `linux-firmware` ships every Qualcomm WiFi blob whether or not the device exists. Verify via the schematic (block diagram, page 3): the WiFi block is labeled `USB2.0 Wifi Module FCU760K`. That's a Quectel module wrapping AICSemi's AIC8800D80 chipset.

**Why this matters:**
- ath11k bug threads on the internet do not apply.
- The driver is `aic8800-usb-dkms`, maintained at [github.com/radxa-pkg/aic8800](https://github.com/radxa-pkg/aic8800) ("Official support for Radxa devices only"). NOT in mainline kernel.
- Radxa's kernel config explicitly disables in-tree alternatives: `CONFIG_AIC_WLAN_SUPPORT=n` with the comment `# Prefer aic8800 DKMS packages` (see `image/rsdk/src/share/rsdk/infra-package/debian/patches/linux/0001-feat-Radxa-common-kernel-config.patch`).
- The DKMS package builds the module against the installed kernel headers at install time. It must be (re)built for any kernel update or WiFi vanishes.

### Confirmed quick diagnostic for WiFi
```
ls /sys/class/net/wlan0/device/driver       # which driver is bound to wlan0
sudo dmesg | grep -iE "8800|aic|aicsemi"    # AIC firmware load + bind messages
nmcli device wifi list                       # can the radio scan
nmcli radio                                  # is WiFi soft/hard rfkilled
iw reg get                                   # regulatory domain (country)
```

### `apt upgrade` breaking WiFi (the Armbian community pain point)
Reproducible: a fresh image works; `sudo apt upgrade` rolls a new kernel; DKMS doesn't successfully rebuild aic8800 against the new headers (often because the headers don't get installed alongside the new kernel image); WiFi is gone.

**Our defense:** apt-pin the WiFi DKMS bundle (`aic8800-usb-dkms` + `aic8800-firmware`) alongside the kernel bundle (`linux-image-*` + `linux-headers-*` + `linux-modules-*`) at `Pin-Priority -1`. The four packages move atomically or not at all. See [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md) for the unhold-and-update procedure. Pin file: [`image/files/apt/50-trailcurrent-playbill-holds.pref`](../image/files/apt/50-trailcurrent-playbill-holds.pref).

### Boot-time waits on networking (90 s "network failed to start")
Default Ubuntu desktop pulls in `NetworkManager-wait-online.service` and friends. With no Wi-Fi profile saved (fresh-flashed state), these block `network-online.target` for 90 s, then time out with "network failed to start", THEN boot continues. On a desktop this is exactly backwards — login shouldn't wait on network.

**Mask aggressively** in hook 14 of [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet):
```
NetworkManager-wait-online.service
systemd-networkd-wait-online.service
systemd-networkd.service           # masked because it fights NM for ifaces
systemd-networkd.socket
cloud-init.service                 # cloud-init also pulls network-online
cloud-init-local.service
cloud-config.service
cloud-final.service
cloud-init.target
cloud-init-network.service
multipathd.service                 # useless on single-NVMe boards
multipathd.socket
snapd.seeded.service
systemd-time-wait-sync.service
```
Boot reaches GDM in <30 s with these masked. Not "Stage 2 polish" — mandatory for a desktop image.

### Q6A is part of the QUSB / Q6 SoundWire family for WiFi-adjacent buses
The WiFi connects via USB 2.0 through an FE1.1S hub. If the hub silently dies (firmware crash, EMI), WiFi disappears even though the AIC chip is fine. `lsusb` is the first diagnostic.

### Force the aic8800 DKMS build — qemu-arm64 chroot won't match the target kernel
At package install time, `aic8800-usb-dkms`'s postinst calls `dkms autoinstall` against `uname -r`. Inside the mmdebstrap qemu-arm64 chroot, `uname -r` reports the **build host's** kernel — not the Q6A kernel just installed into the chroot. dkms looks for matching headers, doesn't find them, and silently skips the build. The image flashes with no `aic8800_fdrv.ko` under `/lib/modules/<KVER>/updates/dkms/` and WiFi doesn't come up on the running board.

**Fix in two layers** (defense in depth):
- **Hook 4b in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet)** walks every kernel that has `/lib/modules/<KVER>/build/` (i.e. matching headers installed) and runs `dkms autoinstall -k <KVER>` for that specific kernel. Hard-fails the image build if the .ko doesn't land for at least one kernel.
- **`trailcurrent-playbill-firstboot.sh` step 8** rebuilds DKMS against the live kernel as belt-and-suspenders — protects against the (rare) case where the chroot built against a different kernel than what's actually booted (kernel package version drift mid-build, ABI mismatch, etc.).

### NetworkManager WiFi PSK prompt fails silently if the GNOME keyring is locked
**Symptom:** Click the network indicator → pick SSID → Settings opens a tiny "authentication required" dialog, you type the PSK, click Connect, nothing happens (or the connect attempt fails with no obvious cause). Saved networks don't reconnect on reboot.

**Root cause is the interaction of `chage -d 0` (force-password-change) with `pam_gnome_keyring`:**
1. We used to call `chage -d 0 trailcurrent` in hook 3 so GDM forced a password change at first login.
2. On first GDM login, PAM's `pam_unix` ran `passwd` to set a new UNIX password BEFORE `pam_gnome_keyring` opened the session.
3. `pam_gnome_keyring` then opened (or auto-created) the user's login keyring with the OLD password it had captured at authentication time.
4. From that moment, the login keyring was sealed with `trailcurrent` while the UNIX password was now whatever the user had typed. `pam_gnome_keyring` couldn't unlock it on subsequent sessions.
5. NetworkManager's secret agent (which is gnome-shell, registered against the secret-service that gnome-keyring exposes) couldn't store or retrieve WiFi PSKs. PSK prompts went nowhere.

**Fix:** do NOT force a password change at first login. Ship with the well-known default password (`trailcurrent`) documented in [SETUP.md](SETUP.md), and instruct the user to change it via Settings → Users (or `passwd`) on first login. Both paths run through the proper PAM stack and update the GNOME login keyring atomically with the new password — so subsequent sessions can unlock it and Wi-Fi PSKs survive reboots. See the prior-bug comment block above hook 3 in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet).

### NetworkManager needs gnome-keyring + a secret agent — `ubuntu-desktop` doesn't pull `gnome-keyring` reliably
Even with the chage trap fixed, the WiFi PSK prompt won't work unless `gnome-keyring` AND `libpam-gnome-keyring` AND `seahorse` (or another secret-service implementation) are explicitly installed and the PAM stack opens the keyring at session start. We add all three to the package list in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) and verify in hook 26 that `gnome-keyring` and `libpam-gnome-keyring` are present. Without this, you get the silent "no agents were available for this request" failure from NetworkManager.

**Quick diagnostic if WiFi PSK prompts still misbehave on a board:**
```bash
# Is the keyring daemon running?
ps -ef | grep gnome-keyring-daemon

# Does the secret-service bus exist?
busctl --user list | grep -i secret

# Can we see saved NM secrets?
sudo nmcli -s connection show <SSID-name>

# Is polkit (which mediates the prompt) running?
systemctl status polkit
```

## Audio — also harder than it looks

### Codec is WCD9385, on SoundWire, requiring the Q6 audio fabric
The schematic (page 3) confirms `WCD9385` with `SWR_TX/RX` to QCS6490. Linux driver: `snd_soc_wcd938x`. The codec doesn't talk directly to ALSA — it goes through Qualcomm's Q6 audio fabric (`q6asm_dai`, `q6adm`, `q6afe`, `q6core`, `q6routing`, `audioreach`). All of those modules MUST be loaded for the codec to expose a usable ALSA card.

### The blacklist trap (we did this once, don't do it again)
Headwaters' image blacklists the Q6 audio stack to save power (it's a headless appliance, no audio needed). **Do NOT copy that blacklist into a desktop / Playbill image.** Blacklisting `q6asm_dai`/`q6adm`/`q6afe`/`q6core`/`q6routing`/`audioreach` results in:
```
$ aplay -l
no soundcards found...
$ wpctl status
... Sinks: Dummy Output ...
```
GNOME Settings → Sound shows only "Dummy Output". The codec loads but has no path to userspace.

**Correct blacklist for Playbill** (in [`image/files/modprobe/disable-unused.conf`](../image/files/modprobe/disable-unused.conf)) — only NPU modules. No display drivers (msm_*), no audio modules:
```
blacklist fastrpc
blacklist qcom_fastrpc
blacklist qcom_q6v5_pas
blacklist qcom_pil_info
blacklist qcom_q6v5
```

### Don't unbind display drivers at runtime — ever
Headwaters' early `power-save-hw.service` had a runtime `unbind` for `msm_dsi`/`msm_dp`/`msm_mdss`/`camss`/`qcom_q6v5_pas` to save power. **Do not re-add this.** The Q6A's kernel console is bound to the msm display framebuffer; unbinding it mid-boot hard-hangs the board (console frozen, no keyboard, no SSH) right after `multi-user.target`. The warning comment in Headwaters' service file is load-bearing — if you see it elsewhere, leave it alone.

### Predicting the PipeWire node name
Per Radxa's audio docs, the ALSA card is `QCS6490RadxaDra [QCS6490-Radxa-Dragon-Q6A]` with three sub-devices. PipeWire's node name will likely contain `qcs6490` or `RadxaDra` or `MultiMedia`. Our WirePlumber rule at [`image/files/audio/wireplumber.conf.d/50-playbill-default-sink.conf`](../image/files/audio/wireplumber.conf.d/50-playbill-default-sink.conf) matches all of those substrings to push the analog jack ahead of HDMI in the priority race.

### Neither Peregrine nor Headwaters validated the analog path
Peregrine uses a Jabra Speak 510 over USB (USB Audio Class — bypasses the SoC audio path entirely). Headwaters is headless. **Playbill is the FIRST TrailCurrent project to use the Q6A's built-in 3.5 mm jack.** No prior in-tree precedent exists for this path. Test it on real hardware after every kernel/firmware roll.

### Ubuntu Noble's `alsa-ucm-conf` is too old for the Q6A
On the first board boot the codec attached but PipeWire showed only "Dummy Output". `wpctl status` saw the WCD9385 device, `aplay -l` showed the card, but no use-case profile could be loaded — so PipeWire couldn't open a real sink.

**Root cause:** the QCS6490-Radxa-Dragon-Q6A use-case profile was added to the upstream `alsa-ucm-conf` repository AFTER the version Ubuntu Noble shipped (1.2.10, Q1 2024). Without that profile + the matching `conf.d` entry, PipeWire / PulseAudio cannot map the codec's mixer controls to a sink, and falls back to the dummy. Symptom matches *exactly* what you'd see if the audio stack was blacklisted, but it isn't — the kernel side is fine.

**Fix:** vendor the entire upstream `alsa-ucm-conf` master `ucm2/` tree at [`image/files/alsa-ucm/ucm2/`](../image/files/alsa-ucm/ucm2/), overlay it on top of `/usr/share/alsa/ucm2/` in hook 6a of [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet), and pin `alsa-ucm-conf` in [`50-trailcurrent-playbill-holds.pref`](../image/files/apt/50-trailcurrent-playbill-holds.pref) so apt cannot upgrade-and-stomp the overlay. Track the upstream commit hash in [`image/files/alsa-ucm/UPSTREAM_COMMIT`](../image/files/alsa-ucm/UPSTREAM_COMMIT) so the next agent who looks at this knows what they're holding against. Hook 26 verifies the Q6A profile file is present.

### Force-load the audio modules — the DT compatible string isn't always reliable
`snd_soc_qcm6490` is the QCS6490-specific machine driver (mainline since April 2024). Auto-loading is wired through device-tree compatible-string matching, and on at least one running kernel revision the wrong machine driver (`snd_soc_sc8280xp`) was probed instead with `use_count=0` — never bound, never registered the codec. Belt-and-suspenders: list the right modules in [`image/files/modules-load.d/q6a-audio.conf`](../image/files/modules-load.d/q6a-audio.conf) (`snd_soc_qcm6490`, `snd_soc_sc7280`, `snd_soc_wcd938x`, `snd_soc_qcom_q6apm_dai`, `audioreach`). Modules that don't exist in the running kernel fail silently; no harm.

## Video / GStreamer / AirPlay

### Q6A V4L2 H.264 hardware decode is broken on current kernel
`v4l2h264dec` (the kernel-side stateless H.264 decoder exposed via V4L2 M2M) initializes but throws `gst_v4l2_object_reset_compose_region: Failed to get default compose rectangle with VIDIOC_G_SELECTION: Invalid argument` on the first caps probe. No frames are ever decoded. The Cast feature's earliest pipeline failure traced to this — when iOS pushed an AirPlay H.264 stream, GStreamer's `decodebin` picked `v4l2h264dec` by rank and the pipeline collapsed with `not-negotiated (-4)` 3 s after the iPhone showed "Connected."

**Root cause:** the Qualcomm Venus driver in use on Noble's kernel does not fully implement the V4L2 stateless decoder interface for this SoC family. The replacement Iris driver (Dmitry Baryshkov's port for SC7280/QCS6490 / [LWN coverage](https://lwn.net/Articles/1042587/)) is upstream in Linux 6.18+, but Noble ships 6.x kernels that predate it. Tracked at [qualcomm-linux/kernel-topics#222](https://github.com/qualcomm-linux/kernel-topics/issues/222).

**Workaround until kernel 6.18 lands:** force GStreamer to skip the hardware decoder and use libav (`avdec_h264`). The A78 cores decode 1080p H.264 in software comfortably (~150 % of one core sustained). Applied in [`controller/src/sources/cast/uxplay.js`](../controller/src/sources/cast/uxplay.js) via UxPlay's `-avdec` flag.

When the Iris driver lands: drop `-avdec`, switch to `-vd v4l2h264dec`, retest cast end-to-end. mpv playback (Live TV via `--hwdec=auto-safe`) currently does whatever the kernel allows it to negotiate, which on this kernel is software fallback — same upgrade applies.

### GStreamer `autovideosink` picks xvimagesink on GNOME Wayland
GStreamer's `autovideosink` selects sinks by rank. On the Q6A:
- `xvimagesink` ranks **primary (256)** — X11 path via XWayland.
- `glimagesink` ranks **secondary (128)** — EGL on Wayland.
- `waylandsink` ranks **marginal (64)** — Wayland native protocol.

Under GNOME on Wayland, `autovideosink` picks `xvimagesink`. The pipeline negotiates successfully and `xvimagesink` accepts data, but XWayland never produces a visible window — the iPhone's AirPlay handshake completes (iPhone shows "Connected"), zero frames ever display.

**Rule:** never use `-vs autovideosink` for video destined for the GNOME desktop. Always pass an explicit sink.

### glimagesink decodes but doesn't fullscreen
After ruling out `autovideosink`, `glimagesink` was the obvious next pick — it talks EGL directly against a Wayland surface, video shows up immediately. But: when UxPlay passes `-fs`, `glimagesink` does NOT send `xdg_toplevel.set_fullscreen` to the compositor. Mutter draws the iPhone mirror as a small floating window sized by its defaults (~500 px wide). Manual fullscreen-toggle from the keyboard (Super+Up etc.) works but the user shouldn't have to.

**Rule:** for any GStreamer pipeline that needs a fullscreen Wayland window on this board, use `waylandsink`. It talks Wayland natively and properly requests fullscreen. Tradeoff: marginal rank means it's never the default — caller must specify `-vs waylandsink` (UxPlay) or set it in the pipeline (`appsrc ... ! waylandsink fullscreen=true`).

### UxPlay 1.68 from apt is too old; build 1.73.6 from source
Ubuntu Noble ships `uxplay` 1.68.2 (frozen at release). With current iOS, the AirPlay handshake succeeds and the iPhone reports "Connected," but every H.264 NAL unit is rejected by `h264parse` as `broken/invalid nal Type: 1 Slice` and no frames decode. Switching `-avdec` doesn't fix it on 1.68.2 — the underlying iOS bitstream handling is upstream.

Three load-bearing fixes between 1.68.2 and 1.73.6:
- **1.68.3** — GStreamer 1.24 compatibility (Noble ships GStreamer 1.24)
- **1.70** — GStreamer ≥1.24 sleep/wake handling, H.265/4K paths
- **1.72.2** — race-condition segfault fix on Debian-family during pipeline restart

**Fix:** image hook 3c clones [FDH2/UxPlay](https://github.com/FDH2/UxPlay) at pinned tag `v1.73.6` and builds with cmake inside the qemu-aarch64 chroot. Installs to `/usr/local/bin/uxplay`, PATH-shadowing the apt-shipped binary at `/usr/bin/uxplay` (kept as a fallback that's never picked). Pinned tag is editable at the top of hook 3c — bump deliberately when an iOS bitstream change forces it.

Build deps require `libdrm-dev`, which is normally blocked by hook 4's `Pin-Priority -1` for `libdrm*`. Hook 3c runs **before** hook 4 specifically so the pin file isn't placed yet — `libdrm-dev` installs cleanly. If a future refactor reorders these hooks, the chroot will fail to install `libdrm-dev` (transitive dep of `libgstreamer-plugins-qcom-base1.0-dev`) and the build aborts.

### Controller spawning UxPlay needs explicit Wayland env injection
The Playbill controller is a systemd USER service. GNOME's session imports `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` etc. into the user systemd manager via `systemctl --user import-environment` at gnome-session startup — **but** if the controller starts before that import lands (boot race), its `process.env.WAYLAND_DISPLAY` is undefined.

UxPlay launched from a controller without Wayland env in its process environment will open zero windows and silently park. Telltale: handshake completes, the iPhone shows "Connected to Playbill," the journal is empty, and the cast screen stays on its "Waiting…" pill forever.

**Fix:** the controller's [`uxplay.js`](../controller/src/sources/cast/uxplay.js) `resolveDisplayEnv()` discovers the Wayland socket by scanning `$XDG_RUNTIME_DIR` for a `wayland-N` entry and injects `WAYLAND_DISPLAY` + `GDK_BACKEND=wayland` into the spawn env before exec. Falls back to `/run/user/<uid>/` when XDG_RUNTIME_DIR is also missing. The same fix would apply to mpv if we ever hit this on the Live TV / YouTube paths (mpv tolerates missing Wayland by falling through to other VOs — UxPlay's pipeline does not).

### `avahi-daemon` must be running at boot for AirPlay discovery
UxPlay registers `_airplay._tcp` and `_raop._tcp` via the Bonjour-compatibility shim against the running avahi daemon. If avahi isn't up, mDNS publish silently no-ops and the iPhone never sees the receiver — UxPlay reports no error. `avahi-daemon` is installed in hook 3a and starts automatically on Ubuntu's default unit ordering, but if you're slimming a related image, **don't disable it**. Verify with:
```
avahi-browse -rt _airplay._tcp | grep Playbill
```

## Desktop / Ubuntu environment

### `ubuntu-desktop-minimal` is too minimal
We tried it first. The result:
- App grid empty (because the default `app-picker-layout` references ~21 apps not installed under -minimal)
- Settings → Region & Language is blank (no language packs)
- `dbus-launch` missing (no `dbus-x11`)
- `update-desktop-database` doesn't run automatically
- gnome-initial-setup not installed

**Use full `ubuntu-desktop`** unless you're prepared to enumerate every missing package. The +500 MB is worth it.

### Ubuntu's `firefox` package is a snap-shim
On Ubuntu Noble, `apt install firefox` installs a transitional package that wraps Firefox-as-snap. Without snapd properly running (which it isn't in our image), launching `firefox` gives `xdg-settings: not found` + `libpxbackend-1.0.so: cannot open shared object file`. Replace with `firefox-esr` (real .deb from universe) and pin the `firefox` snap-shim out via apt preferences:
```
Package: firefox
Pin: release *
Pin-Priority: -1
```
See hook 4a in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet).

### `app-picker-layout` is a silent killer of the app grid
Ubuntu's default layout references 21 apps from the standard desktop (Geary, Calculator, Maps, etc.). On any subset install, the layout points at apps that don't exist; GNOME Shell shows blank slots; the grid looks empty. **Set `app-picker-layout=@aa{sv} []`** in the system dconf override and GNOME auto-populates from `/usr/share/applications/`.

### `gnome-initial-setup` overrides our system-wide dconf at first login
We set wallpaper / theme / dock favorites in `/etc/dconf/db/local.d/00-trailcurrent-playbill`. After first GDM login, gnome-initial-setup overlays the user-mode dconf with Ubuntu's defaults — silently rewriting `firefox.desktop` to `firefox_firefox.desktop` and resetting other keys.

**Lock the brand-identity keys** in [`image/files/gnome/dconf-locks/00-trailcurrent-playbill-locks`](../image/files/gnome/dconf-locks/00-trailcurrent-playbill-locks):
```
/org/gnome/desktop/background/picture-uri
/org/gnome/desktop/background/picture-uri-dark
/org/gnome/desktop/interface/gtk-theme
/org/gnome/desktop/interface/icon-theme
/org/gnome/desktop/interface/accent-color
/org/gnome/shell/favorite-apps
/org/gnome/shell/app-picker-layout
/org/gnome/login-screen/logo
```
Don't lock user-preference keys (color-scheme, locale, timezone, keyboard) — the user owns those.

### GDM has its own dconf profile
The login screen runs as the `gdm` user with its own dconf database (`gdm.d`), separate from `local.d` for user sessions. To brand the login screen we need `/etc/dconf/db/gdm.d/00-trailcurrent-playbill-gdm` plus a `/etc/dconf/profile/gdm` file pointing at it. See hook 7 in [`rootfs.jsonnet`](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet).

### libadwaita explicitly does NOT honor user GTK themes
**This bit us hard.** From the upstream libadwaita docs verbatim: *"Apps using libadwaita don't use system themes and look identical between desktop environments."* On Ubuntu Noble, every modern GNOME app (Settings, Files/Nautilus, Software, Calculator, Calendar, Maps, etc.) is libadwaita and **completely ignores `gtk-theme`** in dconf. Setting `gtk-theme='TrailCurrent-Playbill'` (or any custom theme name) is a no-op for them — they fall back to default Adwaita, which is blue accent + blue/purple selection highlights.

Ubuntu's `org.gnome.desktop.interface accent-color` setting **only works because Yaru ships specific libadwaita CSS patches** that read the accent setting and apply tinting. Those patches are tied to Yaru being the active theme. The moment you set `gtk-theme` to anything other than `Yaru` / `Yaru-dark` / `Yaru-light`, you lose Yaru's libadwaita patches and the accent setting becomes a no-op for libadwaita apps.

**Symptoms when you get this wrong** (we shipped this in our first build):
- Toggle switches in Settings are blue (Adwaita default), not your accent
- File manager (Nautilus) row selection is blue/purple, not your accent
- Settings sidebar selected-row highlight is blue/purple
- Buttons with `.suggested-action` class have an Adwaita-blue background
- The login-screen password input box has a Yaru-orange focus ring (because GDM's gnome-shell theme is separate, see below)

**Correct delivery path on Noble:**

> **Critical Noble caveat (verified on Playbill v0.1.0, May 2026):** the runtime
> `accent-color` dconf key under `org.gnome.desktop.interface` only exists in
> libadwaita ≥ 1.6 (GNOME 47, Ubuntu 24.10+). Noble ships libadwaita 1.5.0,
> where `accent-color` is **not a schema key** — `gsettings list-keys
> org.gnome.desktop.interface | grep accent` returns nothing, and any value
> placed at `/org/gnome/desktop/interface/accent-color` in dconf is silently
> ignored. Do NOT set this key on Noble; it gives a false sense of "the theme
> is configured" while the desktop falls back to Yaru's default orange.

The Noble-correct mechanism is to point `gtk-theme` at one of the **pre-baked
Yaru color variants** that ship with `yaru-theme-gtk` on Noble. Each variant
is a full theme tree with its own accent baked into the gresource bundle.
Available green-family variants and their `theme_selected_bg_color`:

| `gtk-theme` value | Hex | Vibe |
|---|---|---|
| `Yaru-dark` | `#E95420` | default Ubuntu orange |
| `Yaru-sage-dark` | `#657B69` | muted sage gray-green |
| `Yaru-prussiangreen-dark` | `#308280` | deep blue-green |
| `Yaru-viridian-dark` | `#03875B` | saturated green-teal **(Playbill picked this)** |
| `Yaru-olive-dark` | `#4B8501` | olive (closest hue to brand `#52A441`) |
| `Yaru-bark-dark` | `#787859` | brown-green woodsy |

To extract the accent of any installed Yaru variant on a running board:

```bash
g=/usr/share/themes/Yaru-<variant>-dark/gtk-4.0/gtk.gresource
gresource extract "$g" "$(gresource list "$g" | grep -E '/gtk\.css$')" \
  | grep '@define-color theme_selected_bg_color'
```

Optional fallbacks that do NOT replace the variant choice:
1. Ship `/usr/share/themes/TrailCurrent-Playbill/{gtk-3.0,gtk-4.0}/gtk.css` for legacy GTK3 apps that DO honor user themes (gnome-tweaks, some indicators).
2. Ship `/etc/gtk-4.0/gtk.css` with `@define-color` overrides as defense-in-depth for non-libadwaita GTK4 apps (rare on Noble).

**To get exactly your brand color (not Yaru's "close enough" green):** fork the closest Yaru variant from `/usr/share/themes/Yaru-<variant>-dark/`, decompile its `gtk.gresource`, find/replace the accent hex with your brand hex (e.g. `#52A441`), recompile the gresource, ship as a Yaru-derivative theme tree under a custom name. This is real Stage 2 work — deferred for Stage 1.

**GDM is a separate beast.** The login screen runs as user `gdm` with its own dconf profile (`/etc/dconf/profile/gdm` → `system-db:gdm`), and the widgets are gnome-shell (NOT GTK) so even Yaru's `accent-color` propagation may not reach them. Set the same `gtk-theme='Yaru-dark'` + `accent-color='green'` in `/etc/dconf/db/gdm.d/` AS WELL AS the user-side `local.d/`. If GDM still ignores it, the next-level fix is `/usr/share/gnome-shell/gdm-css-name` overrides — gnarly Yaru-fork territory.

### Plymouth + qemu-arm64 chroot = silent failures
Hook 7 in `rootfs.jsonnet` runs `update-initramfs -u -k all` inside the qemu-arm64 chroot to bake the TrailCurrent Plymouth theme into initramfs. **This silently fails sometimes** (the `2>&1 || echo WARNING` swallowed it the first time and we shipped Ubuntu Plymouth instead). Mitigations:
- Make the chroot run fail loud (no `||` swallow)
- Belt-and-suspenders: re-run `update-initramfs -u -k all` from the `trailcurrent-playbill-firstboot.sh` oneshot service. First boot may still show Ubuntu Plymouth; boot 2+ shows TrailCurrent.

## Build pipeline (rsdk-build)

### `radxa/kernel` branch tracks Linux 6.18.2
For third-party OS (which we are), Radxa recommends [cherry-picking the latest patches from radxa/kernel at linux-6.18.2](https://github.com/radxa/kernel/tree/linux-6.18.2). The vendor kernel ships as `linux-image-*-qcom`. Don't try to use mainline — it lacks the Q6A DT and pinctrl patches.

### Radxa's apt repo is auto-wired by rsdk
`additional_repos.libjsonnet` in the rsdk source adds `https://radxa-repo.github.io/` as a deb source automatically. So `aic8800-usb-dkms`, `aic8800-firmware`, `radxa-overlays`, etc. resolve via apt without any extra setup. Just add them to the `packages` list in `rootfs.jsonnet`.

### Don't use `apt upgrade` on a deployed Q6A — Radxa says so
Per [Radxa's official system-update docs](https://docs.radxa.com/en/dragon/q6a/system-config/system-update): "Using the `sudo apt update && sudo apt upgrade` command to upgrade the system may result in incomplete updates or system abnormalities." They recommend `rsetup → System → System Update` instead. We work around this with the apt-pinning policy + the kernel/aic8800 atomic-bundle approach.

### DT overlay compilation happens on the build host, not via DKMS
Don't rely on `radxa-overlays-dkms` being installed on target. Vendor the `.dts` source in `image/overlays/`, compile to `.dtbo` on the build host with `dtc -@`, install pre-built `.dtbo` into the EFI entry dir. This is deterministic and avoids qemu-chroot DKMS flakiness for overlays.

### Two-stage sentinel firstboot is overkill for a desktop
Headwaters uses a two-stage firstboot pattern (`Before=sysinit.target` for early work + `After=network-online.target` for network work) because of complex Docker/MQTT setup. Playbill is just a desktop with one app preinstalled — a single oneshot `Before=sysinit.target` service is enough (rootfs expand + machine-id + SSH host keys + Plymouth initramfs rebuild). Don't over-engineer.

### The 89 GB Headwaters image directory
Don't `cp -r` Headwaters' entire `image/` into your project. Most of that 89 GB is `rsdk/out/` (build cache) + `output/` (built images) + `cache/` (apt downloads) — exclude all of those in your rsync. The actual source files are ~33 MB.

### `rootfs.jsonnet` hook 26 is your best diagnostic
Always finish with a fail-fast checkpoint hook that grep-checks every artifact you expect on disk + every service you expect enabled + every package you expect installed. When a build "succeeds" but flashes a broken image, you find out at hook 26 in 30 seconds rather than at first boot of a flashed board in 30 minutes.

### Recovering from a failed or interrupted build

If you Ctrl-C an in-progress `build.sh`, kill the host while mmdebstrap is mid-chroot, lose power, or otherwise abandon a build, the next `sudo ./build.sh` may fail in pre-build cleanup with a wall of:

```
rm: cannot remove '/tmp/mmdebstrap.XXXXX/proc/.../task/.../fdinfo/N': Read-only file system
rm: cannot remove '/tmp/mmdebstrap.XXXXX/proc/.../task/.../ns/net':   Read-only file system
...
```

This is a killed mmdebstrap leaving its chroot with `/proc`, `/sys`, `/dev`, and various bind mounts still attached. `rm -rf` can't delete entries inside `/proc` because `procfs` is a kernel-virtual filesystem — the entries don't exist on disk. They appear because `/proc` is bind-mounted on top of an empty directory in the chroot.

**`build.sh` now handles this automatically** in the pre-build cleanup section: it walks every `/tmp/mmdebstrap.*` directory, finds every nested mount via `mount | awk`, and `umount -l`s each one in reverse-depth order before the `rm -rf`. So a re-run of `sudo ./build.sh` should self-recover.

If you ever need to clean up by hand (e.g., the auto-recovery itself fails because the orphan dir was created with different permissions, or you want to inspect before deleting), the manual procedure is:

```bash
# 1. List what's still mounted under any orphan
mount | grep /tmp/mmdebstrap.

# 2. Lazy-unmount each, deepest first
mount | awk '/\/tmp\/mmdebstrap\./{print $3}' | sort -r | xargs -r sudo umount -l

# 3. Verify nothing remains mounted
mount | grep /tmp/mmdebstrap.   # should print nothing

# 4. Now rm works
sudo rm -rf /tmp/mmdebstrap.*

# 5. Re-run the build
sudo ./image/build.sh 2>&1 | tee image/output/build.log
```

`sort -r` matters — `/tmp/mmdebstrap.X/proc/sys` must unmount before `/tmp/mmdebstrap.X/proc`. `umount -l` (lazy) is essential — it detaches the mount even if processes still hold open files inside, which is the usual case for a killed mmdebstrap whose child processes haven't fully reaped.

If `rsdk-build` itself was killed mid-run (rather than mmdebstrap directly), you may also have stale state under `image/rsdk/out/radxa-dragon-q6a_noble_cli/`. The pre-build cleanup section already removes `output.img` and `rootfs.tar` there; if you see "rsdk reported success but output.img does not exist" on a re-run, manually delete that whole `out/` subdirectory and start over (you lose the apt cache, which adds 10+ minutes to the next build).

## What we believe but haven't confirmed yet

These are open questions — if you have ground-truth, please update this file:

- **Whether the user's specific failure mode is actually `aic8800-usb-dkms` or something else.** We diagnosed the chip via the schematic but never ran `ls /sys/class/net/wlan0/device/driver` to confirm the bound driver. Probably `aic8800_fdrv` but unverified.
- **Whether the WCD9385 + Q6 audio path works on the Radxa vendor kernel without a Radxa-specific machine driver.** We see `snd_soc_sc8280xp` loading (wrong SoC, harmless?) — there may need to be a `snd_soc_qcs6490` machine driver that's not yet in mainline.
- **Whether `aic8800-usb-dkms` from Radxa's apt repo successfully builds against `linux-headers-*-qcom` 6.18.2.** Issue [#49](https://github.com/radxa-pkg/aic8800/issues/49) shows kernel 6.14 had build failures on some hardware. We're on 6.18.2 — should be fine but unverified.
- **Whether the WirePlumber rule's regex actually matches the real PipeWire node name.** We made it broad (`qcs6490`, `RadxaDra`, `MultiMedia`, `Headphone`) but the exact name varies by kernel + UCM profile + PipeWire version.

## References

- [Radxa Dragon Q6A schematic v1.21](radxa_dragon_q6a_schematic_v1.21.pdf) (in this repo)
- [Radxa Dragon Q6A docs](https://docs.radxa.com/en/dragon/q6a/)
- [Radxa kernel branch `linux-6.18.2`](https://github.com/radxa/kernel/tree/linux-6.18.2)
- [`radxa-pkg/aic8800` — official AIC8800 driver](https://github.com/radxa-pkg/aic8800)
- [Issue #49 — aic8800 wifi after kernel 6.14](https://github.com/radxa-pkg/aic8800/issues/49)
- [Armbian forum — `apt upgrade` breaks Q6A WiFi](https://forum.armbian.com/topic/57122-unfixed-upgrade-issue/)
- [Jeff Geerling sbc-reviews #85 — Q6A](https://github.com/geerlingguy/sbc-reviews/issues/85)
- [CNX Software writeup — Radxa Dragon Q6A](https://www.cnx-software.com/2025/10/27/radxa-dragon-q6a-a-qualcomm-qcs6490-edge-ai-sbc-with-gbe-wifi-6-three-camera-connectors/)
