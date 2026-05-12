# DVD rip — internals

How the DVD-insertion → notification → rip → library pipeline is wired
inside the controller daemon and the Electron GUI. Companion to
[dvd.md](./dvd.md) (the user-facing walkthrough) and
[dvd-data.md](./dvd-data.md) (the API surface).

## Module map

```
                       ┌───────────────────────────────────────┐
                       │       controller daemon (Node)        │
                       │                                       │
   /dev/sr0  ◀── poll ─│  services/dvd-watcher.js              │
   (3 s tick, lsblk)   │    │                                  │
                       │    │ 'inserted' / 'removed' events    │
                       │    ▼                                  │
                       │  handlers/dvd.js                      │
                       │    │                                  │
                       │    │ state.patch({dvd: {...}})        │
                       │    │ ipc.publishEvent('dvd.detected') │
                       │    ▼                                  │
                       │  state-store ── delta ──▶ IPC server  │
                       │                              │        │
                       │                              ▼        │
                       │                       Unix socket     │
                       └───────────────────────────────────────┘
                                                      │
            ┌─────────────────────────────────────────┘
            ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                Electron main process                          │
   │                                                               │
   │  ipc-client.js  ───┬─▶ state delta  ───▶ webContents.send     │
   │                    │                          (renderer)      │
   │                    └─▶ 'dvd.detected' event ──▶ Notification  │
   │                                                  + raise win  │
   └───────────────────────────────────────────────────────────────┘
                                                      │
            ┌─────────────────────────────────────────┘
            ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                Electron renderer (React)                      │
   │                                                               │
   │  DvdPrompt  ── subscribes state.dvd ── renders modal based on │
   │                                            status field      │
   │                                                               │
   │  buttons ── playbill.controller.command(...)  ─── (back via   │
   │             dvd.lookup / dvd.startRip / etc.)      IPC)       │
   └───────────────────────────────────────────────────────────────┘
```

## Detection — `services/dvd-watcher.js`

Polls `lsblk -no LABEL,FSTYPE /dev/sr0` every 3 seconds. The poll is
cheap (one `execFile`, microseconds of CPU) and works without
udev/UDisks2/dbus access — keeps the controller a single-process Node
daemon with no privileged surface.

State machine:

```
              ┌──────────┐  disc inserted (FSTYPE != '')   ┌────────────┐
              │  absent  │ ──────────────────────────────▶ │  present   │
              │          │ ◀────────────────────────────── │            │
              └──────────┘   disc removed (lsblk fails)    └────────────┘
```

The watcher keeps `_lastKey = 'label\0fstype'` and re-fires `inserted`
only when that key changes. So:

- Inserting **the same disc twice** (without ejecting in between) fires
  once.
- Inserting **a different disc** without ejecting (impossible on
  real hardware, but possible if the drive lies about state) re-fires.
- Daemon **restart with a disc already loaded** does NOT re-prompt — the
  watcher's `start()` reads the initial state silently. This avoids
  re-prompting every time the controller is restarted.

## Ripping — `services/dvd-ripper.js`

Singleton — only one optical drive exists, ripping is mutually exclusive,
so it's a class invariant rather than a runtime check. `dvd-ripper.js`
exports the singleton directly.

Shells out to `HandBrakeCLI`:

```
HandBrakeCLI
  -i /dev/sr0
  -o '~/Videos/Playbill Library/Movies/Inception (2010)/Inception (2010).mkv'
  --preset 'Fast 1080p30'
  --main-feature
  -m
  -E copy
  --audio-copy-mask ac3,eac3,aac,mp3
  --audio-fallback aac
  --subtitle scan,1
```

Why these specific flags:

| Flag | Why |
|---|---|
| `--preset 'Fast 1080p30'` | x264 veryfast equivalent. DVDs are 480p so 1080p is the upper bound, not a target — HandBrake keeps the source resolution when smaller. Encode time ≈ 0.6× realtime on the Q6A. |
| `--main-feature` | Picks the longest title automatically. Avoids needing the user to pick from `lsdvd` output for a single-feature retail disc. |
| `-m` | Embed chapter markers — mpv exposes chapter skip from these. |
| `-E copy` + audio-copy-mask | Pass through AC3/EAC3/AAC/MP3 audio without re-encoding. Saves time and preserves source quality. |
| `--audio-fallback aac` | If the source audio is DTS (some retail DVDs), re-encode to AAC since DTS passthrough into MKV-in-mpv has glitches. |
| `--subtitle scan,1` | Track 0 is auto-detected forced subs; track 1 is the first subtitle stream. Both get muxed into the MKV. |

Progress parsing: HandBrake emits lines like

```
Encoding: task 1 of 1, 47.23 % (84.95 fps, avg 86.10 fps, ETA 00h12m34s)
```

The ripper greps for percent + ETA, throttles to one emit per second,
and emits a `progress` event with `{ percent, etaSec, currentTitle }`.

Exit handling:

| Exit code | Signal | Event emitted |
|---|---|---|
| 0 | — | `finished` with `{ path, metadata, sidecar }` |
| ≠0 | SIGTERM / SIGINT | `cancelled` |
| ≠0 | anything else | `failed` with last 4 KB of stderr |

Sidecar (`<title>.json`) is written **before** the rip starts. If the
rip is interrupted, the sidecar still exists but the `.mkv` is
incomplete — the library scanner skips `.mkv` files without a matching
sidecar AND skips zero-size `.mkv` files, but a partial `.mkv` with a
sidecar would appear as a broken entry until the user manually cleans
up. Acceptable for an MVP; future work could check `.mkv` integrity
before listing.

## Metadata lookup — `services/dvd-metadata.js`

Two functions:

### `heuristicTitle(label)`

Turns a DVD ISO-9660 volume label into a best-guess title + year hint
without any network call. The label format on commercial DVDs is a
decades-old convention:

- all uppercase
- underscores as word separators
- studio prefixes (`WB_`, `MGM_`, etc.)
- disc / volume / season markers (`_DISC2`, `_D2`, `_VOL3`, `_S01E03`)
- optional trailing year

The function:

1. Replaces `_` / `.` with spaces.
2. Strips disc / volume / season markers (regex).
3. Extracts a trailing year if present (kept as `yearHint`).
4. Strips leading studio prefixes from a known list.
5. Title-cases, with a small list of stop words (`a`, `an`, `the`, `of`,
   `and`, `or`, `in`, `on`, `at`, `to`, `for`, `with`) kept lowercase
   unless they're the first word.

Examples:

| Input | Title | Year hint |
|---|---|---|
| `INCEPTION` | `Inception` | — |
| `THE_MATRIX_2` | `The Matrix 2` | — |
| `WB_BLADE_RUNNER_2049` | `Blade Runner` | `2049` |
| `BREAKING_BAD_S01E03` | `Breaking Bad` | — |
| `INTERSTELLAR_2014` | `Interstellar` | `2014` |
| `criterion_seven_samurai` | `Seven Samurai` | — |

The user always has the chance to edit before the rip starts, so a
misparse is recoverable.

### `lookupOmdb(apiKey, { title, year })`

HTTPS GET against `https://www.omdbapi.com/?t=<title>&y=<year>&apikey=<key>&plot=short`.
Returns `null` on:

- missing `apiKey` (caller falls back to manual entry)
- network timeout (6 s)
- HTTP error
- `"Response": "False"` from OMDb (no match)
- JSON parse error

Returns a normalized payload `{ title, year, plot, posterUrl, rating,
kind, imdbId, runtime, source: 'omdb' }` on success.

`kind` is derived from OMDb's `Type` field — `series` → `show`,
everything else → `movie`. This drives whether the rip output goes
under `Movies/` or `Shows/`.

## Library scan — `services/dvd-library.js`

Folder-walk over `~/Videos/Playbill Library/{Movies,Shows}`. For each
subfolder, pairs every `.mkv` with its `.json` sidecar and returns a
flat list per category.

Cheap — low hundreds of entries even for a heavy ripper, sub-millisecond
to scan. No cache, no SQLite, no inotify watcher. The source of truth
is the filesystem; manual file moves / restored backups / `rm` all
"just work" without a re-index step.

## State → IPC fan-out

When `handlers/dvd.js` patches `state.dvd`, two things happen
automatically (via the existing controller plumbing):

1. **IPC delta** — every connected GUI client (the Electron renderer)
   receives a `kind:'delta'` message with the patch. The renderer's
   state subscriber updates its React tree, and any component that's
   reading `state.dvd` re-renders.
2. **MQTT publish** — `installStateToMqttFanout` in
   `controller/src/index.js` notices `patch.dvd !== undefined` and
   publishes the new shape to `local/playbill/<id>/status/dvd` with
   `retain:true`. PWAs / other devices on the same broker see the same
   state. See [dvd-data.md](./dvd-data.md) for the topic shape.

## Notification → window raise — `app/main/main.js`

Electron main subscribes to controller events via the IPC client. When
a `dvd.detected` event arrives:

```js
const n = new Notification({
  title: 'Disc detected — add to your library?',
  body:  `"${suggested}" is in the drive. Click to confirm, look up details, and rip.`,
  icon:  '/opt/trailcurrent-playbill/resources/app/packaging/icons/512x512.png',
});
n.on('click', () => raiseOwnWindow());
n.show();
```

Why Electron's `Notification` rather than `notify-send`:

- ships with Electron — no `libnotify-bin` dependency on the host
- the click handler raises the Electron window directly, no
  child-process spawn or stdout parsing
- icon is the bundled Playbill icon — branding stays consistent

The renderer's `DvdPrompt` component is mounted globally and is
already listening to `state.dvd` — by the time the user clicks the
notification, the modal is already up. The notification's job is just
"make the user aware + put the window in front."

## Why the renderer doesn't subscribe to the `dvd.detected` event directly

The state slice carries everything the renderer needs (`prompt`,
`status`, `ripping`). A one-shot event is needed only by the main
process (to fire the notification once per disc), not by the renderer.
Subscribing the renderer to the event too would mean the modal flickers
open / closed if the renderer mounts after the event was already
delivered. Reading from state is idempotent — same component re-mounting
sees the same state and shows the same modal.
