# Cast from phone

Stream from an iPhone or iPad to Playbill via AirPlay screen mirroring.

> **Stopgap, not the final solution.** Cast was added so the rig has *something* the user can throw streaming content onto without writing a per-service plugin. It works for anything the phone can show on screen that isn't DRM-locked. The long-term plan is service-specific source plugins (YouTube, Plex, etc.) that decode in the rig directly.

## What works

| Source on the phone | Plays on Playbill? |
|---|---|
| Safari (HTML5 video, web pages, web games) | Yes |
| YouTube app | Yes |
| Photos / Camera / live preview | Yes |
| iOS games | Yes |
| Calls / FaceTime preview | Yes |
| Music app — audio | Yes |
| **Netflix, Disney+, HBO Max, Apple TV+** | **No** — DRM-protected, mirrors as a black frame. This is enforced by iOS at the OS level, not by UxPlay. |
| Spotify (audio only via AirPlay 1) | Audio only — no video |

Rotation works (mid-stream too, with a brief renegotiation flicker). Audio routes through the system's analog 3.5mm jack via PipeWire.

> Android phones are NOT supported by this path. AirPlay is Apple-only. Miracast support for Android is possible but not implemented (`MiracleCast` exists; the Q6A's WiFi P2P support hasn't been validated for it).

## How to use it

1. Both devices on the same WiFi network.
2. Open Playbill → home grid → **Cast** tile (right of YouTube, green glyph).
3. The cast screen shows the receiver name (defaults to the device's display name from Settings → Device → Name, fallback `Playbill`) and a "Ready · waiting for a device" pill.
4. On the iPhone/iPad: Control Center → **Screen Mirroring** → pick the receiver name.
5. Phone screen appears fullscreen on the TV. The Cast screen UI underneath is hidden by the mirror window.
6. To stop: press **Back** on the remote (or `Escape` on a keyboard). The mirror window closes; the cast screen returns to "Ready · waiting." Pressing Back again exits the Cast screen.

If your phone selects the receiver but no frames appear on the TV, see [Troubleshooting](#troubleshooting).

## How it works under the hood

The Cast feature is a thin wrapper around **UxPlay**, an open-source AirPlay 2 mirroring receiver. The Playbill controller daemon starts UxPlay on demand when the user enters the Cast screen and kills it on exit, so the device doesn't advertise itself on the LAN 24/7.

```
┌─ iPhone ────────┐                ┌─ Q6A board ─────────────────────────────────┐
│ AirPlay client  │  ──── WiFi ──▶ │  avahi-daemon (mDNS)                        │
│                 │                │  uxplay (spawned by playbill-controller)    │
│                 │  H.264 + AAC   │     │                                       │
│                 │  ◀─────────────│     ▼                                       │
│                 │  pair / control│   GStreamer pipeline:                       │
│                 │                │     appsrc → h264parse → decodebin          │
│                 │                │         → videoconvert → waylandsink ──► HDMI│
│                 │                │     appsrc → avdec_aac → pulsesink ───► 3.5mm│
└─────────────────┘                └─────────────────────────────────────────────┘
```

- **Receiver:** [FDH2/UxPlay](https://github.com/FDH2/UxPlay) — version **1.73.6** pinned. Built from source in image-build hook 3c (NOT the apt-shipped 1.68.2, which doesn't work with current iOS).
- **mDNS:** avahi-daemon advertises `_airplay._tcp` and `_raop._tcp` with the receiver name. Started automatically by the user session.
- **Decoder:** `avdec_h264` (libav software). The Q6A's V4L2 hardware H.264 decoder is broken on the current kernel; UxPlay is launched with `-avdec` to force software. The A78 cores handle 1080p H.264 in software comfortably.
- **Video sink:** `waylandsink`. Not `glimagesink` (decodes fine but never sends `xdg_toplevel.set_fullscreen`, mirror appears as a small floating window). Not `autovideosink` (picks `xvimagesink` ahead of both and routes through XWayland, no frames display at all).
- **Audio sink:** `pulsesink` → PipeWire's pulse-shim → analog jack. System volume controls (Playbill's volume bar, `wpctl`, GNOME volume keys) work normally.

The full flag set passed to UxPlay:
```
uxplay -n <receiver-name> -nh -fs -vs waylandsink -as pulsesink -avdec
```

## Files involved

| Path | Role |
|---|---|
| [`controller/src/sources/cast/uxplay.js`](../../controller/src/sources/cast/uxplay.js) | Supervises the uxplay process: spawn, parse stdout for state transitions, stop. Owns the env injection that gives uxplay access to the user's Wayland session. |
| [`controller/src/sources/cast/index.js`](../../controller/src/sources/cast/index.js) | Cast source plugin (capability: `receive`). |
| [`controller/src/handlers/cast.js`](../../controller/src/handlers/cast.js) | `cast.start` / `cast.stop` / `cast.getStatus` command handlers; mirrors `state.cast` and sets `state.source = 'cast'` while active. |
| [`controller/src/schema/commands.schema.json`](../../controller/src/schema/commands.schema.json) | `CastStart` / `CastStop` / `CastGetStatus` action defs. |
| [`app/renderer/components/cast.jsx`](../../app/renderer/components/cast.jsx) | The Cast screen — informational card + status pill. Fires `cast.start` on mount, `cast.stop` on unmount. |
| [`app/renderer/data.js`](../../app/renderer/data.js) | Adds the green Cast tile to the apps row. |
| [`app/renderer/styles/tv.css`](../../app/renderer/styles/tv.css) | `.cast-card`, `.cast-status`, `.cast-howto` styles. |
| [`image/rsdk/src/share/rsdk/build/rootfs.jsonnet`](../../image/rsdk/src/share/rsdk/build/rootfs.jsonnet) hook 3c | Clones FDH2/UxPlay at `v1.73.6` and builds it into the chroot at `/usr/local/bin/uxplay`. |

## State surface

While Cast is active, `state.cast` carries the receiver state:

```json
{
  "running":    true,
  "state":      "waiting" | "connected" | "streaming",
  "clientName": "Dave's iPhone",
  "startedAt":  1778595844612,
  "lastError":  null
}
```

This is fanned to MQTT on `local/playbill/<device-id>/cast/status` so PWAs and other observers can show "phone connected" without their own UxPlay observer. `state.source` is set to `'cast'` while UxPlay is running.

## Commands

| Action | Payload | Effect |
|---|---|---|
| `cast.start` | — | Spawn uxplay if not running. Idempotent. |
| `cast.stop` | — | SIGTERM uxplay (600 ms grace, then SIGKILL). Idempotent. |
| `cast.getStatus` | — | Returns `{running,state,clientName,startedAt}`. |

The Cast screen calls `cast.start` on mount and `cast.stop` on unmount, so a normal user flow never needs to dispatch these directly.

## Troubleshooting

### iPhone doesn't see Playbill in the AirPlay list
- Both devices on the same WiFi SSID? AirPlay does NOT cross subnets.
- mDNS advertising:
  ```
  avahi-browse -rt _airplay._tcp | grep Playbill
  ```
  Should show your device. If not, check `systemctl status avahi-daemon` and that the Cast screen is actually open (UxPlay only advertises while running).
- iPhone caching a stale list: close Control Center and reopen, or toggle WiFi off/on.

### iPhone connects, blue mirror banner flashes, then drops
Pipeline negotiation failure — the V4L2 hardware decoder is hijacking the H.264 stream and failing caps negotiation. Check the journal:
```
journalctl --user -u playbill-controller.service -n 50 | grep '\[uxplay'
```
You should see `not-negotiated (-4)` and references to `v4l2h264dec`. The fix is already baked in (`-avdec`); if this resurfaces, confirm `uxplay -h` shows `1.73.6` (apt's `1.68.2` ignores `-avdec` differently and may fall through).

### iPhone connects, "Connected to Playbill" stays, but nothing shows on the TV
The receiver is decoding but the sink isn't displaying. Most likely cause: the controller process doesn't have a Wayland session in its environment, so GStreamer can't open an output surface.
```
cat /proc/$(pgrep -f 'controller/src/index')/environ | tr '\0' '\n' | grep WAYLAND
```
If `WAYLAND_DISPLAY` is missing, the controller's `resolveDisplayEnv()` should still discover the socket at `/run/user/1000/wayland-0` and inject it. Confirm UxPlay's env:
```
cat /proc/$(pgrep -x uxplay)/environ | tr '\0' '\n' | grep -E 'WAYLAND|GDK_BACKEND'
```
Should show `WAYLAND_DISPLAY=wayland-0` and `GDK_BACKEND=wayland`. If those are missing, GNOME's `systemctl --user import-environment` hasn't run; restarting the controller after GNOME finishes booting fixes it.

### Mirror displays but the window is small / not fullscreen
The video sink isn't `waylandsink`. Confirm with:
```
ps -fp $(pgrep -x uxplay) | tr ' ' '\n' | grep -A1 -- '-vs'
```
Should print `-vs` then `waylandsink`. If it prints `glimagesink` or `autovideosink`, [`uxplay.js`](../../controller/src/sources/cast/uxplay.js) has been edited downstream — restore `-vs waylandsink`.

### Streaming Netflix / Disney+ / HBO Max shows black
Working as designed. Apple's DRM enforcement on iOS produces a black frame on any non-Apple AirPlay receiver for protected content. Use the Roku or Apple TV in the rig for those services.

### Stream stutters, drops frames, audio out of sync
A78 software decode handles 1080p comfortably but isn't infinite-headroom. Check CPU:
```
htop  # then press F4, filter: uxplay
```
If uxplay is sustained over ~150 % CPU (1.5 of 8 cores) the stream is heavier than software can keep up. Mitigations: lower the iPhone's mirroring resolution (Settings → Display & Brightness → … or upgrade the source app to send a smaller stream), or wait for the Iris kernel driver (6.18+) which restores hardware H.264 decode.

### Get verbose UxPlay output for a deeper debug session
The controller spawn inherits `GST_DEBUG` from its parent env:
```
GST_DEBUG="2,h264parse:5,waylandsink:5" systemctl --user restart playbill-controller.service
```
Then open the Cast screen and reproduce. UxPlay's stderr error lines come through to the journal (filtered to `ERROR|FATAL|not-negotiated|terminated|Cannot|failed` — routine WARNs are dropped to keep the journal quiet).

## Related lessons

- [Q6A V4L2 H.264 hardware decode is broken on Noble](../RADXA_LESSONS_LEARNED.md#q6a-v4l2-h264-hardware-decode-is-broken-on-current-kernel) — why we force `-avdec`.
- [UxPlay 1.68 (apt) doesn't work with iOS 17+](../RADXA_LESSONS_LEARNED.md#uxplay-168-from-apt-is-too-old-build-1736-from-source) — why hook 3c builds from upstream.
- [autovideosink picks xvimagesink under Wayland](../RADXA_LESSONS_LEARNED.md#gstreamer-autovideosink-picks-xvimagesink-on-gnome-wayland) — why we explicitly say `-vs waylandsink`.

## Future work

- **Android support via Miracast.** Possible via `MiracleCast`. Blocked on validating that the Q6A's `ath11k`/`aic8800` WiFi driver advertises P2P_GO capability.
- **Native source plugins.** Once we have a Plex / Jellyfin / Netflix-via-Castlabs plugin that decodes in the rig, the AirPlay path becomes a fallback for the long tail of "thing I want to show off my phone" rather than the primary mirroring path.
- **Hardware decode.** When kernel 6.18+ Iris driver replaces Venus, drop `-avdec` and pass `-vd v4l2h264dec` (or just `-` to let decodebin pick) for offloaded H.264. See [the V4L2 lesson](../RADXA_LESSONS_LEARNED.md#q6a-v4l2-h264-hardware-decode-is-broken-on-current-kernel) for the trigger.
