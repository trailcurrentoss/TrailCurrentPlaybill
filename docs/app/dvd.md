# DVD — insert a disc, add it to the library

Insert a DVD into a USB optical drive connected to the Q6A and Playbill
pops a desktop notification asking whether to add it to the on-disk
library. Click the notification, confirm the title (with optional
online metadata lookup or manual entry), and a background HandBrakeCLI
rip writes the movie into the Playbill Library. Ripped titles show up
in **Library → Movies / TV Shows** as soon as the rip finishes.

This page documents the feature end-to-end. Related docs:

- [dvd-rip-internals.md](./dvd-rip-internals.md) — how the watcher,
  ripper, metadata lookup, and library scanner are wired together
  inside the controller daemon
- [dvd-data.md](./dvd-data.md) — state slice shape, command bus
  surface, on-disk layout, MQTT topics

## At a glance

1. **Insert the disc.** Playbill's controller polls `/dev/sr0` every
   3 seconds. As soon as the disc spins up, the controller fires a
   `dvd.detected` IPC event.
2. **Desktop notification appears** — "Disc detected — add to your
   library?" with the suggested title pulled from the disc's volume
   label. Works whether Playbill is currently focused, minimized, or
   on a different workspace.
3. **Click the notification.** Playbill's window is raised and a
   modal asks: *Yes — look up details* / *Enter details manually* /
   *Not now*.
4. **Look up details** (if you have an OMDb API key configured): the
   controller queries `omdbapi.com` and shows you a card with poster,
   year, runtime, plot, and IMDb rating. Confirm or edit.
5. **Or enter details manually**: title, year, type (movie / TV
   episode), and for TV: show name, season, episode.
6. **Rip to library.** HandBrakeCLI starts in the background.
   Progress is shown as a bar with percent + ETA. You can walk away —
   the rip continues even if you close the modal, change screens, or
   alt-tab.
7. **Done.** The modal flips to a green confirmation with an *Eject
   disc* button. The new title appears under **Library → Movies** (or
   **TV Shows**).

## Hardware

| Device | Notes |
|---|---|
| Optical drive | Any USB DVD/Blu-ray drive that exposes `/dev/sr0`. Tested with bus-powered USB-DVD writers. |
| Storage | Library is written to `~/Videos/Playbill Library/` on the local NVMe. A typical DVD rip is 2–5 GB. |
| CPU | Rip rate ≈ 0.6× realtime on the Q6A's A78s — a 2-hour DVD rips in ~3 hours. HandBrake's "Fast 1080p30" preset is x264-veryfast, so the bottleneck is single-threaded encode, not I/O. |

## Software (already in the image)

Image build pulls these packages into the rootfs ([rootfs.jsonnet:224-229](../../image/rsdk/src/share/rsdk/build/rootfs.jsonnet)):

| Package | Used for |
|---|---|
| `handbrake-cli` | the actual rip (`HandBrakeCLI` binary) |
| `lsdvd` | enumerate titles on a disc (used by the title-picker UI when present) |
| `libdvd-pkg` | builds `libdvdcss2` at image-build time so commercial CSS-protected DVDs are readable. Hook 3b preseeds the debconf license accept. |
| `libdvdread8`, `libdvdnav4` | DVD navigation libs (HandBrake links these transitively; declared for self-documenting intent) |
| `eject` | userspace `eject /dev/sr0` for the *Eject disc* button |
| `ffmpeg`, `lame`, `flac` | adjacent media tools (audio-CD rip, format conversion) |

A freshly flashed Q6A board can rip retail DVDs immediately, with no
first-boot build step. No `sudo dpkg-reconfigure` dance — that's done
at image-build time.

## Optional: online metadata (OMDb)

The controller can call out to [OMDb](https://www.omdbapi.com/) to fill
in title, year, poster, plot, and IMDb rating. The free tier is 1000
requests/day, which is plenty for a personal library.

Without an API key, the rip flow still works — the user just edits the
title/year manually. Without internet (rig parked off-grid), the rip
flow still works — the lookup silently fails and the manual-entry form
appears.

Setting the key (no Settings UI yet; coming in a follow-up):

```bash
# From any Playbill IPC client (Electron app, PWA, MQTT, ...)
playbill.controller.command({
  action: 'dvd.setOmdbKey',
  value:  { apiKey: 'YOUR_OMDB_KEY' }
})
```

The key persists in `~/.config/trailcurrent-playbill/headwaters.json`
(file mode 0600). The same file already carries the Headwaters API
key — both are external-service credentials, one file.

## On-disk layout

```
~/Videos/Playbill Library/
├── Movies/
│   └── Inception (2010)/
│       ├── Inception (2010).mkv      ← H.264 + AC3 passthrough
│       └── Inception (2010).json     ← metadata sidecar
└── Shows/
    └── Breaking Bad/
        ├── Breaking Bad - S01E03.mkv
        └── Breaking Bad - S01E03.json
```

Each title is a folder containing one `.mkv` plus one sidecar `.json`
with `{ title, year, kind, plot, posterUrl, rating, runtime, imdbId,
source, rippedAt, rippedFromDevice }`. The library scanner
(`controller/src/services/dvd-library.js`) reads sidecars to populate
the LocalView grid; an `.mkv` without a sidecar is treated as a
half-written rip and ignored.

## Failure modes and what they look like

| Failure | What you see | What to do |
|---|---|---|
| HandBrakeCLI not on PATH | Modal flips to red "Something went wrong" with `HandBrakeCLI spawn failed`. | Should never happen on the image build. On a dev host: `sudo apt install handbrake-cli`. |
| Disc encrypted, `libdvdcss2` missing | HandBrake exits with `Could not read VTS_01_0.IFO`. | Reflash the image — `libdvd-pkg` build step failed at image-build time. |
| Disc ejected mid-rip | Modal flips to error with HandBrake's last stderr line. Partial `.mkv` left on disk but no sidecar → not visible in library. | Re-insert disc, try again. |
| No internet, no OMDb key | Lookup silently fails; modal falls through to manual entry with a yellow "no metadata key configured" note. | Edit title / year by hand and rip. Or set a key (above). |
| Rip in progress, second disc inserted | The DvdWatcher does NOT re-prompt — the in-flight rip's prompt stays. | Wait for the rip to finish, eject, then insert the next disc. |
| Re-inserting the same disc after dismissing | `dvd.dismiss` flags the disc as dismissed. Re-prompt requires either ejecting and re-inserting, OR calling `dvd.refreshStatus`. | Eject + re-insert is the user-facing path. |

## See also

- [dvd-rip-internals.md](./dvd-rip-internals.md) — module-by-module
  internals of the rip pipeline
- [dvd-data.md](./dvd-data.md) — command bus surface, state shape,
  MQTT topics for remote / PWA control
- [architecture.md](./architecture.md) — how the controller daemon and
  Electron GUI talk to each other in general
