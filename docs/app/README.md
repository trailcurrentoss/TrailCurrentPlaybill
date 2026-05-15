# TrailCurrent Playbill — App Documentation

Playbill is the in-rig entertainment app for the TrailCurrent Linux desktop. It's a fullscreen Electron application designed for 10-foot-UI use (couch / cabin distance), driven by keyboard, mouse, or an IR/Bluetooth remote.

> Playbill is **not a kiosk**. The Q6A boots into the normal GNOME desktop and is used as a Linux workstation during the day. Playbill is launched from the dock when the user wants to turn the rig into an entertainment center. It can be quit, minimized, or alt-tabbed away from at any time.

## Documents in this folder

| Document | Purpose |
|---|---|
| [README.md](./README.md) | This file — overview, screen index, keyboard reference, planned AppImage migration |
| [live-tv.md](./live-tv.md) | Live TV from the Hauppauge WinTV-dualHD (ATSC) |
| [radio.md](./radio.md) | AM / FM radio from the RTL-SDR USB dongle |
| [cast.md](./cast.md) | AirPlay screen mirroring from an iPhone or iPad (stopgap for streaming-service content) |
| [dvd.md](./dvd.md) | Insert a DVD → desktop notification → rip to library. User-facing walkthrough. |
| [dvd-rip-internals.md](./dvd-rip-internals.md) | Internals — watcher, ripper, metadata lookup, library scanner. |
| [dvd-data.md](./dvd-data.md) | Command bus actions, state shape, MQTT topics, on-disk layout for the DVD pipeline. |
| [architecture.md](./architecture.md) | For developers — service modules, IPC surface, future remote control / restream hooks |
| [onboarding.md](./onboarding.md) | First-boot pairing flow (mDNS + claim server) for the Headwaters PWA |
| [dbc-additions.md](./dbc-additions.md) | CAN message definitions Playbill adds to the rig's DBC |
| [images/](./images/) | Screenshots referenced by these docs. See [images/README.md](./images/README.md) for capture instructions. |

## Screens

Sidebar nav order, top to bottom:

| Screen | Status | What it does |
|---|---|---|
| **Home** | Placeholder | Hero card + content rows (Continue Watching, Apps, Trails, Movies). All rows are intentionally empty until the Headwaters NAS / external service integrations land. |
| **Apps** | Placeholder | Grid of streaming-service launchers (Netflix, YouTube, Spotify, etc.). Tiles render but don't launch external apps yet. |
| **Live TV** | **Functional** | OTA antenna TV via the Hauppauge WinTV-dualHD. Channel scan, tile-grid channel picker, hardware-decoded fullscreen playback via mpv. See [live-tv.md](./live-tv.md). |
| **Radio** | **Functional** | AM / FM radio via the RTL-SDR dongle. Band selector, dial, 10 persistent presets. See [radio.md](./radio.md). |
| **Cast** | **Functional** | AirPlay screen mirroring from an iPhone or iPad. Software H.264 decode → fullscreen Wayland surface. DRM-protected services (Netflix etc.) show black per iOS policy. See [cast.md](./cast.md). |
| **Library** | **Partial** | Local media library. Poster grid shows DVDs ripped via the [DVD-to-library flow](./dvd.md); Headwaters NAS sync lands in a later stage. |
| **Rig View** | Placeholder | Exterior + cabin camera feeds. Tile layout exists; no real feeds wired. |
| Search | Placeholder | Sidebar entry only. |
| Settings | Placeholder | Sidebar entry only. |

## Keyboard reference

The full UI is keyboard-navigable. Same bindings work for an IR / Bluetooth remote that sends arrow keys.

| Key | Action |
|---|---|
| ← ↑ → ↓ | Move focus |
| **Enter** / Space | Activate the focused tile / button |
| **Backspace** / **Esc** | Back to Home |
| **H** | Jump to Home from anywhere |
| ← (when on the leftmost column) | Open the sidebar nav |
| → (from sidebar) | Close sidebar back into content |
| **F11** | Toggle fullscreen (Playbill starts fullscreen) |
| **Ctrl+R** | Reload renderer (development) |
| **Ctrl+Q** / **Super+Q** / **Ctrl+Shift+Q** | Quit Playbill |

Per-screen extras (e.g. **B** to swap FM/AM bands inside the Radio dial) are documented in the screen's own page.

## Where state lives

| Path | What |
|---|---|
| `~/.config/trailcurrent-playbill/channels.conf` | ATSC channel scan results (DVBv5 INI format), produced by `dvbv5-scan`. |
| `~/.config/trailcurrent-playbill/radio-presets.json` | Saved AM/FM preset slots. |
| `/tmp/playbill-runtime/tunerN.ts` | Live MPEG-TS capture from the active tuner. mpv reads from here while watching. |
| `/tmp/playbill-runtime/mpv.sock` | mpv's JSON IPC socket while a video is playing — used by Playbill for stop / volume / mute. |
| `~/Videos/Playbill Library/{Movies,Shows}/<Title>/` | DVD rips. One folder per title containing the `.mkv` + a `.json` sidecar. See [dvd-data.md](./dvd-data.md) for the layout. |

Deleting `~/.config/trailcurrent-playbill/` resets the app to a fresh state (next launch will re-prompt for a channel scan and start with empty radio presets).

## Hardware Playbill talks to

| Device | Bus | Driver | Used by |
|---|---|---|---|
| Hauppauge WinTV-dualHD (model 01595, USB `2040:826d`) | USB | `em28xx` + `em28xx-dvb` + `lgdt3306a` + `si2157` + `tveeprom` — out-of-tree via `playbill-dvb-dkms` (Radxa BSP kernel ships no USB-DVB drivers; see [live-tv.md](./live-tv.md#why-not-in-tree)) | Live TV |
| RTL-SDR USB dongle (RTL2832U) | USB | librtlsdr (kernel `dvb_usb_rtl28xxu` is **blacklisted** in the image so userspace can claim the device) | Radio |
| Adreno 643 GPU + Venus video decoder | SoC | Mesa Turnip + V4L2-M2M | mpv hardware decode (`--hwdec=auto-safe --vo=gpu-next`) |
| PipeWire → built-in 3.5mm jack | SoC | WCD938x codec, Q6 audio fabric | All audio output |

Image-side package + module configuration that makes this work lives in [`image/rsdk/src/share/rsdk/build/rootfs.jsonnet`](../../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) and [`image/files/modprobe/disable-unused.conf`](../../image/files/modprobe/disable-unused.conf).

## Packaging and updates

**Status: Debian-package based, in production (2026-05-15).**

Playbill ships as two cooperating Debian packages — the nvidia-driver / virtualbox / zfs-linux pattern:

| Package | Architecture | Contents |
|---|---|---|
| `trailcurrent-playbill` | `arm64` | Electron app at `/opt/trailcurrent-playbill/`, Node controller daemon at `/opt/trailcurrent-playbill/controller/`, `/usr/share/applications/trailcurrent-playbill.desktop`, icon set, `/usr/lib/systemd/user/playbill-controller.service` |
| `trailcurrent-playbill-dkms` | `all` | Kernel modules `em28xx` + `em28xx-dvb` + `lgdt3306a` + `si2157` + `tveeprom` built via DKMS against whatever kernel is installed |

`trailcurrent-playbill` `Depends: trailcurrent-playbill-dkms (>= 1.0.0)`, so users only ever install or upgrade the main package — the kernel modules tag along transparently and DKMS handles rebuilds on kernel updates.

### Build pipeline

Both debs are produced from sources in [`packaging/`](../../packaging/):

```
packaging/trailcurrent-playbill/build-deb.sh        # main app deb
packaging/trailcurrent-playbill-dkms/build-deb.sh   # DKMS sibling
```

[`image/build.sh`](../../image/build.sh) invokes both scripts on every image build, stages the resulting `.deb` files into `$STAGING/files/debs/`, and [rootfs.jsonnet hook 5](../../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) installs them inside the chroot via `apt-get install ./pkg.deb` so dependency resolution is normal.

### Update channels

Three ways the same two debs reach a rig:

| Path | When | Mechanism |
|---|---|---|
| **Image flash** | First install, kernel upgrades, hardware changes | Bundled into the rootfs by the image build. |
| **One-off SCP + dpkg** | Dev iteration, urgent patches | `scp pkg.deb rig:/tmp && ssh rig 'sudo dpkg -i /tmp/pkg.deb'`. DKMS rebuilds. |
| **Fleet OTA via Headwaters / Farwatch** | Production update cadence (planned) | Private apt repo hosting the latest `.deb` files. Headwaters or Farwatch runs `apt-get update && apt-get install --only-upgrade trailcurrent-playbill` per rig. Same dependency resolution as image-build install. |

The same `.deb` works for all three. There is **no AppImage**, **no electron-updater**, **no separate update channel for the kernel modules** — `apt` is the single mechanism.

### Versioning

App and DKMS package versions advance independently:

- `trailcurrent-playbill` follows `app/package.json` version.
- `trailcurrent-playbill-dkms` follows the version in [`packaging/trailcurrent-playbill-dkms/src/dkms.conf`](../../packaging/trailcurrent-playbill-dkms/src/dkms.conf).

Bump the DKMS version only when the kernel-side source actually changes (driver subtree refresh, new module added). The main package's `Depends: trailcurrent-playbill-dkms (>= X.Y.Z)` floor moves at the same time so apt knows a kernel-side bump is required for the new app version.
