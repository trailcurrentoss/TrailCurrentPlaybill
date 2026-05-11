# Architecture

For developers extending Playbill or wiring it to other TrailCurrent products.

## Process layout

Playbill is a vanilla Electron app — main process + a single renderer.

```
Electron main (Node.js)
├── main/main.js              window lifecycle, ipc handlers, app menu
├── main/preload.js           contextBridge surface (window.playbill.*)
└── main/services/            backend modules — pure functions, no Electron deps
    ├── paths.js              ~/.config + /tmp paths
    ├── dvb.js                Hauppauge tuner control (dvbv5-scan / dvbv5-zap)
    ├── radio.js              RTL-SDR control (rtl_fm + pw-cat)
    └── player.js             mpv lifecycle + JSON-IPC control

Renderer (Chromium, no Node)
├── renderer/index.html       loader + CSP
├── renderer/styles/          design tokens + screen CSS
├── renderer/components/      JSX (Babel-compiled, no bundler)
│   ├── chrome.jsx            top bar, sidebar nav, now-playing, remote hint
│   ├── app.jsx               focus engine, keyboard nav, screen switcher
│   ├── home.jsx | apps.jsx | local.jsx | rig.jsx     placeholder screens
│   ├── live.jsx              Live TV — talks to playbill.dvb / .player
│   └── radio.jsx             Radio — talks to playbill.radio
└── renderer/data.js          static UI scaffolding (now small; was Stage-1 mock data)
```

Build:

```
npm run build         # vendor copy + babel JSX → app/build/components/*.js
npm run start         # build, then electron .
npm run dist          # build, then electron-builder (current target: linux dir/arm64)
```

## Service modules — designed for two callers

The four `app/main/services/*.js` modules are deliberately **UI-agnostic**. Each exports plain async functions that take JSON-serializable arguments and return JSON-serializable results. There is **no `require('electron')`** inside any service module.

This is load-bearing for the future:

| Caller | How |
|---|---|
| **Local Electron renderer** *(today)* | `main.js` registers each service function as an `ipcMain.handle('playbill.X.Y', ...)`. `preload.js` exposes them as `window.playbill.X.Y(...)` via contextBridge. The renderer calls them like ordinary async functions. |
| **Headwaters PWA over HTTP** *(future, planned)* | A small Express server inside main process mounts the same module exports as `POST /api/playbill/dvb/tune` etc. The PWA gets restream + remote control without any duplicated logic. |

Adding the HTTP layer when the time comes is a single new file (`main/services/http.js`) plus an `app.use('/api/playbill', router)` registration in main.js. The service modules don't change.

### IPC channel naming

```
playbill.<namespace>.<method>     namespaced, dot-separated
```

| Channel | Service method | Notes |
|---|---|---|
| `playbill.dvb.listAdapters`        | `dvb.listAdapters()`           | Reads `/dev/dvb/adapter*` |
| `playbill.dvb.scan`                | `dvb.scan({adapter, country})` | Spawns `dvbv5-scan`, writes channels.conf, returns parsed channel list |
| `playbill.dvb.listChannels`        | `dvb.listChannels()`           | Parses cached channels.conf |
| `playbill.dvb.tune`                | `dvb.tune({adapter, channel})` | Starts `dvbv5-zap`, returns `{ tsPath }` |
| `playbill.dvb.stopTune`            | `dvb.stopTune({adapter})`      | Kills the `dvbv5-zap` for that adapter |
| `playbill.dvb.probeTools`          | `dvb.probeTools()`             | `which dvbv5-{scan,zap}` |
| `playbill.radio.listAdapters`      | `radio.listAdapters()`         | Parses `rtl_test -t` output |
| `playbill.radio.tune`              | `radio.tune({band, frequencyHz, gain})` | Spawns `rtl_fm \| pw-cat` |
| `playbill.radio.stop`              | `radio.stop()`                 | Kills both children |
| `playbill.radio.getState`          | `radio.getState()`             | `{running, band, frequencyHz, gain}` |
| `playbill.radio.listPresets`       | `radio.listPresets()`          | Reads `radio-presets.json` (or defaults) |
| `playbill.radio.setPresets`        | `radio.setPresets(arr)`        | Writes `radio-presets.json` |
| `playbill.radio.probeTools`        | `radio.probeTools()`           | `which rtl_fm rtl_test pw-cat` |
| `playbill.player.play`             | `player.play({source, hwdec})` | Spawns mpv fullscreen, returns `{ipcPath}` |
| `playbill.player.stop`             | `player.stop()`                | Kills mpv |
| `playbill.player.setVolume`        | `player.setVolume(v)`          | Via mpv JSON IPC |
| `playbill.player.setMute`          | `player.setMute(m)`            | Via mpv JSON IPC |
| `playbill.player.probeTools`       | `player.probeTools()`          | `which mpv` |

### Keep services pure

Rules for adding to `services/`:

1. **No `electron` imports.** If you reach for `BrowserWindow`, you broke the contract.
2. **Inputs and outputs are JSON-serializable.** No Buffers, no `EventEmitter` instances, no functions in return values. (Long-running events should fire as `webContents.send('playbill.X.event', payload)` from `main.js`, not from inside the service.)
3. **No global state outside the module.** Each service can keep an internal `session` map (the dvb / radio / player modules each do), but nothing leaks into Electron-specific globals.

If you find yourself reaching for these — that's an indicator the logic should live in `main.js` between the `ipcMain.handle` and the service call, not in the service itself.

## Renderer focus engine

Keyboard navigation lives in [`app.jsx`](../../app/renderer/components/app.jsx). It is intentionally simple: each screen declares an array of focus rows in the `ROWS` schema, and a single global `keydown` listener moves a `{ row, col, rowY }` cursor.

```js
const ROWS = {
  live: [
    { id: 'live-ctrl', cols: 1 },
    { id: 'epg',       cols: 1, vertical: 64 },
  ],
  radio: [
    { id: 'radio-band',    cols: 2 },
    { id: 'radio-dial',    cols: 1 },
    { id: 'radio-presets', cols: 10 },
  ],
  // ...
};
```

| Field | Meaning |
|---|---|
| `id` | Row identifier matched by the screen's components when rendering focus state |
| `cols` | Horizontal cells the cursor can move through |
| `vertical` | If present, ↑/↓ moves within the row through `rowY` instead of jumping rows |

Screens read `focus.row === 'my-row-id' && focus.col === N` to decide which element gets the `.focused` class. CSS handles the actual visual treatment (green outline, scale 1.05, glow).

Per-screen extras (e.g. `radio.jsx` capturing ←/→ inside `radio-dial` to step frequency) attach their own `keydown` listeners with `{ capture: true }` and call `e.stopPropagation()` to prevent the global handler from also firing.

## Hardware ↔ kernel ↔ userspace ↔ app

```
                 ┌────────────────────────────────────────────┐
                 │  Playbill renderer (window.playbill.*)     │
                 └────────┬────────────────────┬──────────────┘
                          │ IPC               │ IPC
                 ┌────────▼─────────┐ ┌───────▼──────────┐
                 │  dvb / radio /   │ │  player          │
                 │  service modules │ │  (mpv lifecycle) │
                 └────────┬─────────┘ └───────┬──────────┘
                          │ child_process     │ spawn
              ┌───────────┴──────────┐  ┌─────┴──────┐
              │ dvbv5-scan / -zap   │  │  mpv       │
              │ rtl_fm | pw-cat     │  │  --hwdec=  │
              └───────────┬──────────┘  └─────┬──────┘
                          │ /dev/dvb/*       │ V4L2-M2M
                          │ /dev/bus/usb/*   │ /dev/video*
                 ┌────────▼─────────┐ ┌──────▼──────────┐
                 │ kernel drivers:  │ │ kernel:         │
                 │ dvb_usb_cxusb    │ │ Venus video     │
                 │ (libusb passthru │ │ decoder         │
                 │  for RTL-SDR)    │ │ Adreno DRM      │
                 └────────┬─────────┘ └──────┬──────────┘
                          │ USB              │ DMA-BUF
                 ┌────────▼─────────┐ ┌──────▼──────────┐
                 │ Hauppauge        │ │ Adreno 643 GPU  │
                 │ WinTV-dualHD     │ │ + Venus codec   │
                 │ RTL-SDR dongle   │ │                 │
                 └──────────────────┘ └─────────────────┘
```

The interesting handoff is **mpv → V4L2-M2M → Venus**: TS frames go straight from disk into the kernel's stateful M2M codec node, decoded by Qualcomm's Venus IP block, returned as DMA-BUF handles to mpv's `gpu-next` video output, composited by the Adreno GPU. The CPU touches the bytes once (read from the TS file). This is the whole reason we cared about getting GPU + Venus working on the Q6A — without it, ATSC playback at 1080p60 burns ~70% of one A78 core; with it, near-zero CPU.

## State files

| Path | Lifecycle | Owner |
|---|---|---|
| `~/.config/trailcurrent-playbill/channels.conf` | Persistent until user re-scans or deletes | `dvb.js` |
| `~/.config/trailcurrent-playbill/radio-presets.json` | Persistent | `radio.js` |
| `/tmp/playbill-runtime/tunerN.ts` | Created on tune, truncated on re-tune, wiped at boot | `dvb.js` |
| `/tmp/playbill-runtime/mpv.sock` | Created on play, removed on stop | `player.js` |

`paths.js` is the single source of truth for these locations — change it there if you ever move state.

## Where to add things

| You want to… | Edit |
|---|---|
| Add a new screen | New `xxx.jsx` in [`renderer/components/`](../../app/renderer/components/) · register in `app.jsx` ROWS schema · add side-nav entry in `chrome.jsx` · script tag in `index.html` |
| Add a new IPC method | Add the function to a service module (or a new one) · add a one-line `ipcMain.handle` in `main.js` · add a one-line wrapper in `preload.js` |
| Change colors / spacing / type | [`renderer/styles/colors_and_type.css`](../../app/renderer/styles/colors_and_type.css) (design tokens, mirrors the Farwatch PWA) |
| Add an external app launcher tile | [`renderer/components/apps.jsx`](../../app/renderer/components/apps.jsx) + add launcher row in `data.js` |
| Wire up Headwaters NAS media | [`renderer/components/local.jsx`](../../app/renderer/components/local.jsx) + new `services/headwaters.js` |
| Wire up rig cameras | [`renderer/components/rig.jsx`](../../app/renderer/components/rig.jsx) + new `services/cameras.js` |
| Add HTTP API for restream / remote control | New `services/http.js` (Express) — mounts existing service exports as routes, registered from `main.js` |
