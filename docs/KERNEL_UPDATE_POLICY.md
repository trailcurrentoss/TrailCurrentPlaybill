# Kernel update policy

## The problem

The Radxa Dragon Q6A (Qualcomm QCS6490) has a recurring failure mode: a kernel update silently breaks GPU acceleration, or WiFi, or both. We've hit this on prior TrailCurrent builds (Peregrine, Headwaters), and Radxa's own forum has a long history of users reporting the same. Neither the Adreno GPU userspace nor the ath11k WiFi firmware is fully decoupled from the kernel ABI, and the vendor kernel + mainline Mesa combination is sensitive to packaging changes that look harmless at the apt level.

The cost of finding out the hard way is high: a Q6A in a parked rig that's silently rolled a kernel during the night and won't bring up its display the next morning means a service trip with a USB cable and an EDL flash.

The Playbill image policy is to **isolate the dangerous packages with apt preferences**, leave everything else on the standard Ubuntu desktop update flow, and require explicit operator action to roll a kernel.

## What's pinned

The pin file is [50-trailcurrent-playbill-holds.pref](../image/files/apt/50-trailcurrent-playbill-holds.pref), installed at `/etc/apt/preferences.d/`. Every package below gets `Pin-Priority -1`, which makes apt unable to install ANY version from ANY source.

| Package family | Why pinned |
|---|---|
| `linux-image-*`, `linux-headers-*`, `linux-modules-*`, `linux-modules-extra-*` | The kernel itself. New versions can change msm DRM ABI, codec binding, audio routing path, and break the aic8800 DKMS rebuild. |
| `mesa-*`, `libdrm*`, `libgbm1`, `libegl1`, `libgl1-mesa-dri`, `libglx-mesa0` | Adreno GPU userspace. Mesa upgrades have historically broken Adreno on Q6A — the kernel DRI ABI moves and Mesa stops talking to it. |
| `linux-firmware` | Bluetooth + GPU + assorted blobs (NOT WiFi — that's the aic8800-firmware below). |
| **`aic8800-usb-dkms`, `aic8800-firmware`** | **The WiFi DKMS bundle.** WiFi on the Q6A is the Quectel FCU760K (AIC8800D80) module per the schematic. Radxa explicitly disables in-tree ath (`CONFIG_AIC_WLAN_SUPPORT=n`) and ships a DKMS package. The Armbian Q6A community has documented `apt upgrade` breaking WiFi when this DKMS rebuild fails. Pinning the aic8800 packages alongside the kernel bundle ensures the four (`linux-image` + `linux-headers` + `aic8800-usb-dkms` + `aic8800-firmware`) move atomically or not at all. |

## What's not pinned

Everything else. `unattended-upgrades` runs in the background like on any Ubuntu desktop — security updates to `openssl`, `glibc`, GNOME, Firefox, the Electron runtime libs, etc. flow normally. None of these has historically broken the GPU or WiFi.

In particular: the Playbill app itself isn't held by this file. Playbill ships as an unpacked Electron tree at `/opt/trailcurrent-playbill/` and is not under apt's control.

## What happens during a normal `apt upgrade`

```
$ sudo apt upgrade
...
The following packages have been kept back:
  libdrm-amdgpu1 libdrm-common libdrm-radeon1 libdrm2 libegl1
  libgbm1 libgl1-mesa-dri libglx-mesa0 linux-firmware
  linux-image-6.8.0-...-qcom linux-modules-6.8.0-...-qcom
  mesa-vulkan-drivers
0 upgraded, 0 newly installed, 0 to remove, 12 not upgraded.
```

This is the policy working correctly. The held packages are visible (so you know they have updates available) but apt refuses to touch them.

## How to deliberately roll a kernel

When a new kernel is validated on a staging board (or you've decided you're willing to accept the risk), unhold-upgrade-rehold:

```bash
sudo apt-mark unhold linux-image-* linux-headers-* linux-modules-* linux-modules-extra-* \
                     aic8800-usb-dkms aic8800-firmware

# OR, if apt-mark refuses because of the preferences file, edit that file
# and comment out the linux-image / linux-headers / linux-modules / aic8800
# blocks, then `apt update`. Re-add the blocks after upgrade.

sudo apt update && sudo apt full-upgrade
# DKMS will rebuild aic8800_fdrv against the new kernel headers as part of
# the upgrade; verify the build succeeded:
sudo dkms status | grep aic8800

sudo reboot

# After reboot, validate: GPU works (GDM renders), WiFi works (NetworkManager
# scans), audio works, Playbill launches. If anything is broken, see Recovery
# below — you have a path back.

# If validation passes, re-pin:
sudo apt-mark hold linux-image-* linux-headers-* linux-modules-* linux-modules-extra-*
# OR re-enable the blocks in /etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref.
```

The same procedure applies to Mesa userspace and `linux-firmware` independently — they can be rolled separately from the kernel if you want to bisect a regression. The verification step in [SETUP.md §8](SETUP.md#step-8--verify-the-apt-pinning-policy) shows the smoke-test commands.

## Recovery — if a kernel roll broke something

The Q6A has dual systemd-boot entries by default (current kernel + previous kernel from kernel-install). On boot, **hold space** during the brief autoboot window to enter the embloader menu, then pick the older kernel entry. The system boots with the previous (working) kernel, and you can `apt-get install <previous-kernel-version>` to restore it as the default.

If both entries are broken (e.g., a bad linux-firmware update affects both kernels), the recovery is a flash:

1. Build a fresh image with the old, known-good versions.
2. Re-flash via `sudo ./image/flash.sh --os <image>` (no need to re-flash SPI NOR firmware).

This is why the build is reproducible from a single command — the image you flashed last week is exactly what you can rebuild today.

## Why we don't just `apt-mark hold` from a script

`apt-mark hold` is a runtime mark, stored in `/var/lib/dpkg/status`. A wide-net `apt full-upgrade` can override it (depending on the upgrade strategy), and it's invisible during normal `apt list --upgradable` output. The apt preferences file we use instead:

- Is declarative and lives in `/etc/`, where it's discoverable by anyone debugging the system later.
- Cannot be overridden by `apt full-upgrade`'s priority resolution.
- Lists *every* package family by glob, so a future kernel package with a slightly different name still matches.
- Is committed to this repo (under `image/files/apt/`), so re-building the image always re-installs it.

Both mechanisms are valid; we picked apt preferences for the predictability.

## Why we don't mask `unattended-upgrades`

Earlier TrailCurrent images (Peregrine, Headwaters) mask `unattended-upgrades` entirely. That's the right call for an appliance that runs unattended in a vehicle for months — you don't want any surprises.

Playbill is a desktop. The user is logged in, sees update notifications, and expects security patches to flow. Masking the auto-upgrader breaks that expectation and pushes maintenance burden onto the operator. Pinning only the dangerous packages is a better fit for the desktop use case.

## Stage 3+ — hands-off OTA

For Stage 1 a new kernel requires an operator at the keyboard. Stage 3+ adds a `deployment-watcher` service borrowed from Headwaters' OTA pattern: download a fresh image, verify its signature, stage it to a B-side partition, reboot. If the new image fails health-checks, automatic A/B rollback restores the old root.

That work is deferred until we have multiple boards in the field — for a single-digit fleet, manual operator-driven reflashes are simpler and safer.

## See also

- [STAGE1_PLAN.md §Phase F](../STAGE1_PLAN.md) — the original justification
- [SETUP.md §8](SETUP.md#step-8--verify-the-apt-pinning-policy) — verification commands
- [50-trailcurrent-playbill-holds.pref](../image/files/apt/50-trailcurrent-playbill-holds.pref) — the actual policy file
- Hook 4 of [rootfs.jsonnet](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) — where the policy gets installed during image build
