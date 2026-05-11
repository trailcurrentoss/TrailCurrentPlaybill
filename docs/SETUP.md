# SETUP — TrailCurrent Playbill on the Radxa Dragon Q6A

Operator guide: from a built `.img` to a working desktop with Playbill running.

## What you need

- Radxa Dragon Q6A board with NVMe installed
- 12 V power supply for the Q6A
- USB-C cable rated for data (NOT charge-only — see common pitfalls below)
- HDMI display + cable
- USB keyboard (and mouse if you want one — keyboard alone is enough)
- A WiFi network or Ethernet cable
- A Linux x86_64 host with `edl-ng` available, the freshly built `.img`, and root privileges

## Step 1 — Build the image

If you don't already have an `.img`, build one (~30-90 min on first run):

```bash
cd image/
./preflight.sh                                  # surfaces missing tools first
sudo ./build.sh 2>&1 | tee output/build.log
```

On success you'll see something like:

```
══════════════════════════════════════════════════════════════
  Build complete in 47m 12s
══════════════════════════════════════════════════════════════

  Image:   image/output/trailcurrent-playbill-q6a-v0.1.0.img
  Size:    7.2G
  SHA256:  <hash>
```

If `build.sh` fails, the fail-fast checkpoint at the end of [rootfs.jsonnet](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) (hook 26) prints exactly which artifact is missing. The full build log is at `image/output/build.log`.

## Step 2 — Flash SPI NOR firmware (one-time per board)

Skip this step if the board already boots cleanly to U-Boot/embloader from prior use. Otherwise, do it once for any new board.

1. Disconnect 12 V power from the board.
2. Hold the **EDL** button on the board while connecting the USB-C cable to your build host.
3. Verify the board is in EDL mode:
   ```bash
   lsusb | grep 9008
   ```
   You should see exactly one Qualcomm `9008` device. Multiple = unplug all but one.
4. Flash the SPI NOR firmware:
   ```bash
   sudo ./image/flash.sh --firmware
   ```
5. Disconnect USB-C, reconnect 12 V power, and reboot the board. The SPI NOR firmware persists across all future flashes.

## Step 3 — Flash the OS image

1. Put the board in EDL mode again (hold EDL, plug in USB-C).
2. Verify:
   ```bash
   lsusb | grep 9008
   ```
3. Flash:
   ```bash
   sudo ./image/flash.sh --os image/output/trailcurrent-playbill-q6a-v0.1.0.img
   ```
   This writes the full image to NVMe (~3-5 minutes for an 8 GB image at USB 3.0 speeds).

## Step 4 — Boot

1. Disconnect USB-C from your build host.
2. Connect HDMI display, USB keyboard.
3. Plug in 12 V power.

What you should see, in order:

| Time | What | Notes |
|---|---|---|
| 0 s   | Embloader autoboots (no menu) | If you see a menu, the patched embloader didn't get installed — re-flash the OS image |
| ~5 s  | Plymouth boot splash with the Playbill logo on a dark background | Centered logo, gentle pulse |
| ~30 s | GDM login screen with the dark brand wallpaper | Native panel resolution |
| —     | Log in as `trailcurrent` (default password `trailcurrent`) | We deliberately do NOT force a password change at first login (that breaks gnome-keyring; see notes below) |
| —     | GNOME desktop appears with the brand wallpaper, themed top bar | Top right has Wi-Fi, sound, power, calendar indicators |

## Step 5 — Configure WiFi

GNOME's network indicator is in the top-right of the panel.

1. Click the network indicator → **Wi-Fi Not Connected** → **Select Network**
2. Pick your SSID, enter the PSK, click **Connect**
3. NetworkManager remembers the network — subsequent boots reconnect automatically

The WiFi adapter is the on-board Quectel FCU760K module (AICSemi AIC8800D80, USB-attached). The driver ships as a DKMS package (`aic8800-usb-dkms`) that is built into the image at build time. If WiFi doesn't appear at all (no Wi-Fi adapter in Settings → Wi-Fi):

```bash
lsusb | grep -i 'aic\|wifi'        # should show the AICSemi USB device
dmesg | grep -i aic8800            # should show the driver attaching
ls /lib/modules/$(uname -r)/updates/dkms/aic8800_fdrv*.ko*  # the .ko should exist (newer pkgs ship aic8800_fdrv_usb.ko)
sudo dkms autoinstall               # rebuild if the .ko is missing
```

## Step 6 — Change your password (and unlock the keyring properly)

Once you're connected, change the default password through **Settings → Users → Password** (or `passwd` from a terminal). Both paths run through the proper PAM stack and update the GNOME login keyring atomically with the new password — meaning Wi-Fi PSKs you save remain accessible on the next reboot.

> **Why we don't force a password change at first login.** The "force change at first login" pattern (`chage -d 0`) is incompatible with `pam_gnome_keyring`: PAM changes the UNIX password before the keyring is opened, the keyring then auto-creates sealed with the old password, and from that point on NetworkManager can't unlock it to retrieve saved Wi-Fi PSKs. Changing your password through Settings or `passwd` after first login avoids the trap.

If it's missing, see [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md) §Recovery — your `linux-firmware` may have been silently rolled (it shouldn't be, the apt pins prevent this).

## Step 6 — Verify audio (3.5 mm headphone jack)

Audio output is the Q6A's built-in 3.5 mm analog headphone jack — not HDMI, not USB DAC, not Bluetooth.

1. Plug headphones (or your rig amp / head-unit input) into the 3.5 mm jack.
2. Open **Settings → Sound** in GNOME.
3. The **Output Device** dropdown should list `Headphone Jack (3.5mm) — TrailCurrent Playbill — analog out` (the WirePlumber rule renames it).
4. Click **Test** on the left and right channels — confirm both play.

From a terminal:

```bash
wpctl status                  # confirm the analog sink is "default"
aplay -l                      # confirm the QCS6490 sound card is detected
speaker-test -c2 -twav -l1    # test stereo output
```

Common failure: WCD938x codec doesn't appear in `aplay -l`. This is a known Qualcomm/Linaro pain point on Dragon-class boards — usually means the `alsa-ucm-conf` package is missing a Q6A profile. Check `dmesg | grep -i wcd938x` for binding errors.

## Step 7 — Launch TrailCurrent Playbill

1. Hover the dock at the bottom of the screen — the Playbill icon (forest-green folded brochure with a play triangle) is pinned there.
2. Click it.
3. Electron opens fullscreen, dark TrailCurrent TV shell. Top bar shows brand chrome (`TrailCurrent Playbill` + system status icons). Sidebar (Home / Apps / Live TV / Radio / Library / Rig View / Search / Settings) on the left. Hero in the center with placeholder Stage-1 copy. Empty rows below (Continue Watching, Your Apps, Trails Nearby, Offline Library — Movies) — later stages will populate them.
4. Arrow keys navigate. `H` returns to Home. `Esc` or `Backspace` backs out. `Ctrl+Q` quits.

### Live TV — Hauppauge WinTV-dualHD (USB ATSC tuner)

1. Plug the WinTV-dualHD into a USB port. The kernel's `dvb_usb_cxusb` driver claims it on hot-plug — verify with `ls /dev/dvb/` (you should see `adapter0/` and `adapter1/`, one per tuner).
2. Connect an OTA antenna to the tuner's RF input.
3. Sidebar → **Live TV**. The empty state will say "No channels yet." Click **Rescan**.
4. Channel scan runs `dvbv5-scan` against the US ATSC frequency table (`dtv-scan-tables` package). On a strong signal it takes 1–3 minutes and writes `~/.config/trailcurrent-playbill/channels.conf`.
5. Click any channel tile to tune. The app spawns a fullscreen mpv overlay (`--hwdec=auto-safe --vo=gpu-next`) — MPEG-2 / H.264 frames decode on the Adreno Venus V4L2-M2M codec, not the CPU. Press **Esc** to exit playback.

### Radio — RTL-SDR USB dongle (FM/AM)

1. Plug the RTL-SDR. The image blacklists `dvb_usb_rtl28xxu` (see `/etc/modprobe.d/disable-unused.conf`) so librtlsdr can claim it directly.
2. Verify the dongle is visible: `rtl_test -t` should list it as device `0`.
3. Sidebar → **Radio**. Use the **FM/AM** toggle, the dial (← / → step, **Enter** tunes), and the 10 preset slots.
4. The app spawns `rtl_fm | pw-cat` — demodulated PCM goes straight into PipeWire's default sink. Click an empty preset slot to save the current frequency to it.

## Step 8 — Verify the GPU + 4K hardware video decode

The Q6A's Adreno 643 GPU runs through Mesa Turnip (Vulkan) and freedreno (GL). Hardware video decode goes through the in-kernel `venus` driver as a V4L2 stateful codec on `/dev/videoN`.

```bash
# GL renderer should mention "FD643" or "Turnip Adreno 643"
glxinfo -B | grep -E "OpenGL renderer|Vendor"

# Vulkan device
vulkaninfo --summary | grep -E "deviceName|driverName"

# OpenCL — Adreno platform comes from radxa-firmware-qcs6490
clinfo -l

# Venus video decode/encode nodes
v4l2-ctl --list-devices

# Smoke-test the v4l2 H.264 decoder element from gstreamer-bad
gst-inspect-1.0 v4l2slh264dec >/dev/null && echo "v4l2slh264dec: present"
```

If `v4l2-ctl --list-devices` shows no Venus codec, check `dmesg | grep -i venus` — the Venus firmware (`venus.mbn` / `venus-5.4.fw`) is in `linux-firmware` and the Radxa firmware bundle, both of which are pinned. Don't reach for `apt upgrade linux-firmware` to "fix" it without unpinning carefully (see [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md)).

## Step 9 — Verify the NPU (Hexagon CDSP via FastRPC)

The Q6A exposes Qualcomm's Hexagon NPU via the in-kernel `fastrpc` driver and the userspace daemon `cdsprpcd` (from `qcom-fastrpc1`, Radxa qcs6490-noble repo). Kernel modules and CDSP firmware load on every boot; the NPU is available to any user-session app that opens `/dev/fastrpc-cdsp`.

```bash
# Kernel modules loaded (NOT blacklisted)
lsmod | grep -E "fastrpc|q6v5"

# CDSP firmware loaded and remote-proc running
cat /sys/class/remoteproc/remoteproc*/name
cat /sys/class/remoteproc/remoteproc*/state    # should print "running" for cdsp

# Device nodes — should be 0666 thanks to the udev rule
ls -l /dev/fastrpc-* /dev/dma_heap/system

# Daemon running
systemctl status cdsprpcd.service --no-pager

# DSP library search path picked up by login shells
echo "$ADSP_LIBRARY_PATH"
```

The image installs the *plumbing* (kernel + libcdsprpc + udev + cdsprpcd) but no application-level QNN runtime. Apps that want to run on-NPU inference (a Hexagon-aware llama.cpp build, a QNN-using Electron module, etc.) ship their own `libQnnHtp*.so` / model files. Drop those into `/usr/lib/dsp/cdsp/` (system-wide) or alongside the binary; `ADSP_LIBRARY_PATH` is preset so they load without further setup.

If `state` reads `crashed` instead of `running`, see the [Foadsf NPU troubleshooting gist](https://gist.github.com/Foadsf/2972e8059102ad9bc9c5848ae1fc7cc3) — the most common cause is a `cdsp.mbn` ↔ `fastrpc_shell_unsigned_3` version mismatch, which our `radxa-firmware-qcs6490` apt pin is meant to prevent.

## Step 10 — Verify the apt-pinning policy

From a terminal:

```bash
apt-mark showhold              # nothing should appear (we use apt preferences, not apt-mark)
cat /etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref   # should list kernel/mesa/linux-firmware

# Verify the policy is enforced — none of these should show as upgradable
apt list --upgradable 2>/dev/null | grep -E "linux-image|mesa-|libdrm|libgbm|linux-firmware"
```

The standard `unattended-upgrades` runs in the background as it would on any Ubuntu desktop, but the held packages are skipped. If you want a normal-looking image with the security pocket up to date right after first boot:

```bash
sudo apt update && sudo apt upgrade -y
```

The held packages will be reported as `held back` — that's the policy working as intended. See [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md) for how to deliberately roll a kernel.

## Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot stops at the embloader menu | Patched embloader didn't get installed | Re-flash the OS image; check hook 23 / 26 in `build.log` |
| `lsusb \| grep 9008` shows nothing | Charge-only USB-C cable | Use a data-rated USB-C cable |
| Multiple `9008` devices in `lsusb` | Multiple boards in EDL mode | Unplug all but one |
| Plymouth splash never appears, jumps straight to text console | Default Plymouth theme not switched | `update-alternatives --display default.plymouth` should point at `trailcurrent.plymouth` |
| GDM never appears, drops to TTY | `gdm.service` not enabled, or display compositor crashed | `journalctl -u gdm` for the failure mode |
| Wi-Fi indicator missing entirely | NetworkManager not running, or no Wi-Fi adapter detected | `systemctl status NetworkManager`, `nmcli device` |
| Audio plays via HDMI instead of 3.5 mm jack | WirePlumber rule didn't load | `wpctl status` + check `/etc/wireplumber/wireplumber.conf.d/50-playbill-default-sink.conf` is present |
| Playbill icon missing from dock | `.desktop` file not installed correctly | `gtk-launch trailcurrent-playbill` from a terminal — if that works, dock favorites need a refresh: `dconf write /org/gnome/shell/favorite-apps "['trailcurrent-playbill.desktop', ...]"` |
| Playbill launches but renders blank | Vendored React/Ionicons not staged in `/opt/trailcurrent-playbill/resources/app/renderer/vendor/` | Inspect with `ls /opt/trailcurrent-playbill/resources/app/renderer/vendor/` |

## Recovering from a failed or interrupted build

If a `sudo ./image/build.sh` was killed (Ctrl-C, host shutdown, OOM, etc.), the next run may fail in pre-build cleanup with:

```
rm: cannot remove '/tmp/mmdebstrap.XXXXX/proc/.../...': Read-only file system
```

This is leftover bind mounts from the killed mmdebstrap. **`build.sh` now auto-recovers** — it detects orphan dirs, lazy-unmounts every nested mount in reverse-depth order, then `rm -rf`s. Just re-run `sudo ./image/build.sh`.

If for any reason auto-recovery fails (e.g., the orphan dir was created with permissions the script can't traverse), the manual procedure is:

```bash
mount | awk '/\/tmp\/mmdebstrap\./{print $3}' | sort -r | xargs -r sudo umount -l
sudo rm -rf /tmp/mmdebstrap.*
sudo ./image/build.sh 2>&1 | tee image/output/build.log
```

Full background on this and other build-host quirks is in [RADXA_LESSONS_LEARNED.md](RADXA_LESSONS_LEARNED.md#recovering-from-a-failed-or-interrupted-build).

## Reflashing without losing changes

The standard "wipe and reflash" workflow assumes the board is disposable. If you've made changes on the board you want to preserve, before reflashing:

```bash
# Back up /home/trailcurrent
ssh trailcurrent@trailcurrent-playbill.local 'tar czf - /home/trailcurrent' > home-backup.tar.gz
```

After reflashing, restore:

```bash
ssh trailcurrent@trailcurrent-playbill.local 'tar xzf - -C /' < home-backup.tar.gz
```

There is no current OTA pipeline — kernel + mesa + linux-firmware updates require a full image rebuild and reflash. That changes in Stage 3+ when we borrow Headwaters' `deployment-watcher` pattern.

## Help & feedback

The full Stage-1 plan is at [STAGE1_PLAN.md](../STAGE1_PLAN.md). The build log is your best diagnostic — every hook prints `[hook N]` markers, and hook 26 is a fail-fast checkpoint that lists exactly which artifacts are missing.
