# TrailCurrent Playbill — App Documentation

Playbill is the in-rig entertainment app for the TrailCurrent Linux desktop. It's a fullscreen Electron application designed for 10-foot-UI use (couch / cabin distance), driven by keyboard, mouse, or an IR/Bluetooth remote.

> Playbill is **not a kiosk**. The Q6A boots into the normal GNOME desktop and is used as a Linux workstation during the day. Playbill is launched from the dock when the user wants to turn the rig into an entertainment center. It can be quit, minimized, or alt-tabbed away from at any time.

## Documents in this folder

| Document | Purpose |
|---|---|
| [README.md](./README.md) | This file — overview, screen index, keyboard reference, planned AppImage migration |
| [live-tv.md](./live-tv.md) | Live TV from the Hauppauge WinTV-dualHD (ATSC) |
| [radio.md](./radio.md) | AM / FM radio from the RTL-SDR USB dongle |
| [architecture.md](./architecture.md) | For developers — service modules, IPC surface, future remote control / restream hooks |
| [images/](./images/) | Screenshots referenced by these docs. See [images/README.md](./images/README.md) for capture instructions. |

## Screens

Sidebar nav order, top to bottom:

| Screen | Status | What it does |
|---|---|---|
| **Home** | Placeholder | Hero card + content rows (Continue Watching, Apps, Trails, Movies). All rows are intentionally empty until the Headwaters NAS / external service integrations land. |
| **Apps** | Placeholder | Grid of streaming-service launchers (Netflix, YouTube, Spotify, etc.). Tiles render but don't launch external apps yet. |
| **Live TV** | **Functional** | OTA antenna TV via the Hauppauge WinTV-dualHD. Channel scan, tile-grid channel picker, hardware-decoded fullscreen playback via mpv. See [live-tv.md](./live-tv.md). |
| **Radio** | **Functional** | AM / FM radio via the RTL-SDR dongle. Band selector, dial, 10 persistent presets. See [radio.md](./radio.md). |
| **Library** | Placeholder | Local media library (Headwaters NAS). Filter chips + poster grid scaffolded; no real media yet. |
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

Deleting `~/.config/trailcurrent-playbill/` resets the app to a fresh state (next launch will re-prompt for a channel scan and start with empty radio presets).

## Hardware Playbill talks to

| Device | Bus | Driver | Used by |
|---|---|---|---|
| Hauppauge WinTV-dualHD (model 1595) | USB | `dvb_usb_cxusb` (in-tree) | Live TV |
| RTL-SDR USB dongle (RTL2832U) | USB | librtlsdr (kernel `dvb_usb_rtl28xxu` is **blacklisted** in the image so userspace can claim the device) | Radio |
| Adreno 643 GPU + Venus video decoder | SoC | Mesa Turnip + V4L2-M2M | mpv hardware decode (`--hwdec=auto-safe --vo=gpu-next`) |
| PipeWire → built-in 3.5mm jack | SoC | WCD938x codec, Q6 audio fabric | All audio output |

Image-side package + module configuration that makes this work lives in [`image/rsdk/src/share/rsdk/build/rootfs.jsonnet`](../../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) and [`image/files/modprobe/disable-unused.conf`](../../image/files/modprobe/disable-unused.conf).

## Roadmap — Auto-update via GitHub releases (AppImage migration)

**Status: planned, on hold until the Q6A image stabilises.**

Today the app is shipped as an unpacked Electron `dir` build that the rootfs install hook copies into `/opt/trailcurrent-playbill/`. That makes the install completely self-contained inside the image, but it also means the app can only be updated by reflashing or by manually replacing files in `/opt` — there is no in-app update mechanism.

The plan is to switch to **AppImage** + **electron-updater** + **GitHub releases** so updates ship out of band from full image rebuilds.

### Why AppImage

- Self-contained, no system-wide install needed — the AppImage is a single executable file the user can run from anywhere.
- `electron-updater` (already part of the `electron-builder` ecosystem we use) supports AppImage updates natively. It downloads the new AppImage, atomically swaps the file in place, and restarts the app — no `sudo`, no `apt`, no privileged helper.
- Works cleanly on ARM64.
- Can coexist with the apt-pinned system packages on the image — Playbill's own update channel is independent of the OS update channel.

### Concrete change set when we make the switch

1. **`app/electron-builder.config.js`** — change the Linux target from `dir` to `AppImage`:
   ```js
   linux: {
     target: [{ target: 'AppImage', arch: ['arm64'] }],
     ...
   },
   publish: { provider: 'github', owner: 'TrailCurrent', repo: 'TrailCurrentPlaybill' },
   ```
2. **`app/package.json`** — add `electron-updater` to `dependencies`.
3. **`app/main/services/updater.js`** *(new)* — wraps `autoUpdater` from `electron-updater`. Polls GitHub releases on a 6-hour cadence, emits IPC events `playbill.updater.available` / `.downloaded` so the renderer can show a non-blocking toast with "Restart to install".
4. **`app/main/main.js`** — wire the updater service alongside the existing dvb / radio / player services.
5. **`app/renderer/components/chrome.jsx`** — small "update available" toast in the top bar, focusable from the side nav.
6. **`image/rsdk/src/share/rsdk/build/rootfs.jsonnet`** — change the install hook to drop `Playbill.AppImage` (a single file, ~120 MB) into `/opt/trailcurrent-playbill/` instead of the unpacked tree. Update the `.desktop` `Exec=` line to point at the AppImage. Mark the file `+x`.
7. **GitHub Actions workflow** *(new)* — on tag push, build the AppImage for `linux-arm64`, draft a release, attach `Playbill.AppImage` and `latest-linux.yml`. `electron-updater` reads `latest-linux.yml` from the latest release to determine the version.

### Tradeoffs

- AppImages bundle their own runtime libs — adds ~20 MB vs the unpacked dir, but trivially small relative to the image.
- The unpacked dir is easier to peek at during development. For dev, `npm run start` still runs against `app/main/` directly — only the production install format changes.
- An AppImage runs FUSE-mounted — the FUSE driver `libfuse2` (the legacy v2 ABI that AppImages need) must be in the image. Verify that `libfuse2t64` is installed when we make the switch.

### Why we're holding off

The image build is still iterating — kernel pinning, alsa-ucm vendor overlays, the boot-time Plymouth path, etc. While that is in flux, the unpacked-dir install gives us a faster build → flash → verify cycle (no AppImage packaging step). Once the image is stable enough that we're not reflashing every other day, we cut over to AppImage and the in-app updater takes over from there.
