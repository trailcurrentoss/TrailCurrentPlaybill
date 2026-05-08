# TrailCurrent Playbill

A branded TrailCurrent Linux desktop for the Radxa Dragon Q6A, with the Playbill in-rig entertainment app preinstalled.

## What this is — and what it isn't

**This is a full Linux desktop**, not a kiosk appliance. Ubuntu Noble (24.04) with GNOME on Wayland, branded TrailCurrent throughout (boot splash, GDM login, wallpaper, GTK theme, dock icons). Use it as a normal computer — files, web, terminal, whatever — during the day.

**TrailCurrent Playbill is one application** installed on that desktop. When work is done in the evening, click the Playbill icon in the GNOME dock and the app opens fullscreen, turning the desktop into a 10-foot, remote-driven entertainment center. Quit it, minimize it, alt-tab away — Playbill is a standard desktop application, not a lockdown.

In future stages Playbill connects to the Headwaters NAS (media library), the rig CAN bus (telemetry, cameras), an OTA antenna tuner, and external streaming apps. Stage 1 just stands up the desktop and proves the app launches with the empty TV shell.

## Hardware

| Component | Notes |
|---|---|
| Board       | Radxa Dragon Q6A (Qualcomm QCS6490) |
| Display     | HDMI; native panel resolution auto-detected |
| Storage     | NVMe (default) — 4 GB minimum, 32 GB+ recommended |
| Audio out   | Built-in 3.5 mm headphone jack (WCD938x codec). Not HDMI, not USB DAC, not Bluetooth. |
| Input       | USB keyboard + mouse for the desktop; arrow keys / IR or Bluetooth remote for the Playbill TV shell. **Not a touchscreen device.** |
| Network     | WiFi (ath11k) and Ethernet, both via NetworkManager / GNOME network indicator |

## Repository layout

```
TrailCurrentPlaybill/
├── app/                    Electron app (no TypeScript)
│   ├── main/               main + preload (Wayland fullscreen + theme bridge)
│   ├── renderer/           = R&D prototype, copied verbatim
│   ├── packaging/          .desktop entry + icon set + electron-builder config
│   ├── build/              Babel-compiled JSX → JS (gitignored)
│   └── dist/               electron-builder output (gitignored)
├── image/                  Radxa Q6A OS image build
│   ├── build.sh            Orchestrator
│   ├── preflight.sh        Cache + host validation
│   ├── flash.sh            edl-ng wrapper for SPI NOR + NVMe
│   ├── rsdk/               Vendored Radxa SDK (rsdk-build + customize-hooks)
│   ├── embloader/          Patched embloader (Q6A autoboot fix)
│   ├── overlays/           Q6A device-tree overlays (compiled at build time)
│   ├── firmware/           SPI NOR firmware blob
│   └── files/              Image-side support files (Plymouth, GNOME theme,
│                           audio config, apt pins, .desktop, systemd unit, etc.)
├── branding/               Brand-aligned wallpapers + logo + ComfyUI prompts
├── docs/                   This directory
│   ├── README.md           ← you are here
│   ├── SETUP.md            Operator guide: build → flash → first boot
│   └── KERNEL_UPDATE_POLICY.md   Why we hold kernel + Mesa + linux-firmware
└── STAGE1_PLAN.md          The Stage-1 plan in full
```

## Quick build

Once on a Linux x86_64 host with the rsdk build prereqs (run [preflight.sh](../image/preflight.sh) — it checks them all):

```bash
# 1. App side: build the unpacked Electron arm64 dir
cd app/
npm install
npm run dist
# → app/dist/linux-arm64-unpacked/  (305 MB)

# 2. Generate brand-aligned wallpapers (skip if branding/wallpaper-{light,dark}.png exist)
#    See branding/comfyui-prompts.md for the canonical prompts + checkpoint settings.
#    ComfyUI must be running locally on http://localhost:8188.

# 3. Image side: build the Q6A image (root needed for mmdebstrap chroot)
cd ../image/
sudo ./build.sh 2>&1 | tee output/build.log
# → image/output/trailcurrent-playbill-q6a-v<version>.img  (~6-10 GB)
```

First build takes 30-90 minutes (Ubuntu desktop stack downloads + qemu-arm64 configure). Re-runs are much faster (apt cache preserved at `image/rsdk/out/.../debs/`).

## Quick flash + boot

```bash
# One-time SPI NOR firmware flash (per board, EDL mode)
sudo ./image/flash.sh --firmware

# OS image to NVMe
sudo ./image/flash.sh --os image/output/trailcurrent-playbill-q6a-v0.1.0.img
```

Power on. Plymouth boot splash → GDM login (~30 s) → log in as `trailcurrent` / `trailcurrent` (forced password change on first login) → GNOME desktop with brand wallpaper → click `TrailCurrent Playbill` in the dock to launch the TV shell.

Step-by-step instructions, including WiFi setup and audio sanity check, are in [SETUP.md](SETUP.md).

## Hard rules baked into the build

- **No TypeScript.** App, tooling, electron-builder config, build scripts — all plain JavaScript.
- **Both light and dark color schemes are first-class** at the desktop level. Both wallpapers are brand-aligned via the same scene (Pacific Northwest redwood campsite) at two times of day. The Playbill app currently ships dark-only (matches Netflix/Plex/Apple-TV convention for media UIs); GNOME desktop chrome follows the system Style toggle.
- **Kernel + Mesa + linux-firmware are pinned** so apt cannot silently break GPU acceleration or WiFi. Documented in [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md).
- **Embloader is patched** to skip the boot menu when timeout=0 — mandatory Q6A fix for the floating-UART-pin phantom-input boot trap.
- **The desktop is not locked down.** No kiosk autostart, no forced first-login wizard beyond standard `chage -d 0`, no masked unattended-upgrades. Standard Ubuntu desktop UX.
- **Audio routes through the analog 3.5 mm jack** by default. WirePlumber rule pins the priority so HDMI doesn't win.

## Stage 1 status

| Component | Status |
|---|---|
| R&D prototype → Electron app port (renderer + main + preload + dual-theme bridge) | ✅ |
| Brand-aligned wallpapers (light + dark) | ✅ |
| Playbill icon set (16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512) | ✅ |
| Image-build pipeline (rootfs.jsonnet, build.sh, preflight.sh) | ✅ |
| GTK4 + GTK3 brand-recolored theme (Farwatch PWA chrome port, Stage 1 minimum) | ✅ |
| Plymouth, MOTD, profile, dconf, audio default-sink, apt pins, .desktop launcher, firstboot oneshot | ✅ |
| Patched embloader + DT overlay carried over from Headwaters with renames | ✅ |
| **`build.sh` produces a flashable IMG** | ⏳ Run interactively — `sudo` can't authenticate from a background process |
| Hands-off Q6A flash + boot validation | ⏳ Per-operator |
| Headwaters NAS / CAN telemetry / antenna tuner / external streaming app integrations | ⏳ Stage 2+ |

## Known hardware-locked limitations

These are known and accepted; do not file as bugs or attempt to fix.

- **Brief Radxa logo appears at boot, before Plymouth.** The Q6A's secure-boot chain (xbl → tz → hyp → bootloader) renders this from Qualcomm-signed firmware payloads inside the SPI NOR (`xbl.elf` / `imagefv.elf`). Replacing requires modifying signed binaries, which the secure-boot chain rejects. Headwaters investigated the same problem and reached the same conclusion. The CM5 (Broadcom + U-Boot) IS fixable because its boot logo is a `splash.bmp` in the boot partition; the Q6A's is not. Once Plymouth fires (~5 s into boot), it's branded TrailCurrent for the rest of boot.

## Where to look next

- **First boot a fresh image:** [SETUP.md](SETUP.md)
- **Why kernel updates are pinned:** [KERNEL_UPDATE_POLICY.md](KERNEL_UPDATE_POLICY.md)
- **Why this scaffolding is the way it is:** [STAGE1_PLAN.md](../STAGE1_PLAN.md)
- **The 26 image-build hooks:** [rootfs.jsonnet](../image/rsdk/src/share/rsdk/build/rootfs.jsonnet)
- **The patched embloader story:** [build-embloader.sh](../image/embloader/build-embloader.sh) + [the patch](../image/embloader/patches/0001-playbill-autoboot-on-timeout-zero.patch)
- **Brand color tokens (canonical):** [`/Marketing/ClaudWebSite/src/css/variables.css`](../../../Marketing/ClaudWebSite/src/css/variables.css)
